#include "device_api_json.h"

#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

static const char HEX[] = "0123456789abcdef";

/* A bounded append cursor. `ok` latches false on the first overflow so callers
 * can write the whole document straight through and check once at the end,
 * instead of testing after every field. */
typedef struct {
    char  *buf;
    size_t cap;
    size_t len;
    bool   ok;
} sink_t;

static void put(sink_t *s, const char *str)
{
    if (!s->ok) {
        return;
    }
    size_t n = strlen(str);
    if (s->len + n + 1 > s->cap) {
        s->ok = false;
        return;
    }
    memcpy(s->buf + s->len, str, n);
    s->len += n;
    s->buf[s->len] = '\0';
}

static void put_int(sink_t *s, int v)
{
    char b[16];
    snprintf(b, sizeof(b), "%d", v);
    put(s, b);
}

/* Append `in` escaped as the body of a JSON string (no surrounding quotes).
 *
 * UTF-8 passes through byte for byte: a headline off a wire copy desk carries
 * em dashes and accented names, and JSON strings are defined over Unicode, so
 * escaping them to \u would be legal but pointless. Only the seven mandatory
 * escapes and the C0 controls are rewritten. */
static void put_escaped(sink_t *s, const char *in)
{
    if (!s->ok) {
        return;
    }
    if (in == NULL) {
        in = "";
    }
    for (size_t i = 0; in[i] != '\0'; i++) {
        unsigned char c = (unsigned char)in[i];
        char one[2] = { (char)c, '\0' };
        switch (c) {
        case '"':  put(s, "\\\""); break;
        case '\\': put(s, "\\\\"); break;
        case '\b': put(s, "\\b");  break;
        case '\f': put(s, "\\f");  break;
        case '\n': put(s, "\\n");  break;
        case '\r': put(s, "\\r");  break;
        case '\t': put(s, "\\t");  break;
        default:
            if (c < 0x20) {
                char u[7] = { '\\', 'u', '0', '0', HEX[(c >> 4) & 0xF], HEX[c & 0xF], '\0' };
                put(s, u);
            } else {
                put(s, one);
            }
            break;
        }
        if (!s->ok) {
            return;
        }
    }
}

static void put_str_field(sink_t *s, const char *key, const char *val, bool first)
{
    put(s, first ? "\"" : ",\"");
    put(s, key);
    put(s, "\":\"");
    put_escaped(s, val);
    put(s, "\"");
}

static void put_int_field(sink_t *s, const char *key, int val, bool first)
{
    put(s, first ? "\"" : ",\"");
    put(s, key);
    put(s, "\":");
    put_int(s, val);
}

static void put_bool_field(sink_t *s, const char *key, bool val, bool first)
{
    put(s, first ? "\"" : ",\"");
    put(s, key);
    put(s, "\":");
    put(s, val ? "true" : "false");
}

/* How many entries of an array to serialize.
 *
 * user_app copies these counts out of news_t under a lock. A count that outran
 * its array — or a negative one from an uninitialised read — would serialise
 * whatever follows the struct straight onto the network, so the clamp lives
 * here, at the only place that walks the arrays, rather than at each caller. */
static int clamped(int n, int cap)
{
    if (n < 0) {
        return 0;
    }
    return n > cap ? cap : n;
}

/* Microamp-hours drawn per second the board is awake.
 *
 * MEASURED, not estimated: derived from measured wattage at 3.7 V (battery mA ≈
 * W × 270), and stated in the deep-sleep design's §10 as 0.023 mAh per awake
 * second, which is 23 µAh. Everything the companion app says about battery life
 * comes out of this one number, so it lives here with its provenance rather than
 * as a 23 inside an expression, where nobody would ever dare change it and
 * nobody could tell whether it had already been changed.
 *
 * µAh rather than mAh because the arithmetic is integer-only — a wake is a few
 * seconds and rounds to zero mAh, so working in mAh would report a board that
 * draws nothing at all. */
#define POWER_UAH_PER_AWAKE_SECOND 23

/* The word, not the ordinal. Written exactly as pollSource is written, and
 * total: an out-of-range value — an uninitialised read, or an enumerator added
 * without a case here — reads "default" rather than falling off the end of a
 * switch.
 * This string goes on a phone screen, and the failure it would otherwise cause
 * is a pointer into .rodata serialised as JSON. */
static const char *sleep_src_name(dev_sleep_src_t s)
{
    switch (s) {
    case DEV_SLEEP_SRC_POLICY: return "policy";
    case DEV_SLEEP_SRC_API:    return "api";
    case DEV_SLEEP_SRC_NVS:    return "nvs";
    case DEV_SLEEP_SRC_DEFAULT:
    default:                   return "default";
    }
}

/* The mean length of a wake, in milliseconds, or 0 when there has not been one.
 *
 * Derived here rather than by the caller because the divisor is legitimately
 * zero — every board has no wakes at all until it has slept once — and an
 * integer divide by zero on Xtensa is an exception that panics the board, from
 * inside the HTTP handler answering the phone that asked. */
static int mean_awake_ms(const device_state_t *st)
{
    if (st->wakes <= 0 || st->awake_ms_total <= 0) {
        return 0;
    }
    return st->awake_ms_total / st->wakes;
}

/* What this board would draw in a day, in mAh, if it keeps waking at its
 * configured interval and its wakes keep costing what they have cost so far.
 *
 * This is the AWAKE-TIME TERM ONLY. The refreshes (2.3 mAh each) and the
 * standing deep-sleep current are not in it, the second because nobody has
 * measured it on this board yet — which is exactly what these counters exist to
 * fix. Reporting a total that silently contained a guess would defeat that.
 *
 * Integer-only, like everything else that has to agree between x86 and Xtensa,
 * and computed in 64 bits on the way through: at a one-second interval with a
 * long mean the product reaches 2e15, five orders of magnitude past an int32,
 * and a 32-bit intermediate does not fail loudly — it reports some small,
 * plausible, wrong number. */
static int est_mah_per_day(const device_state_t *st)
{
    int mean_ms = mean_awake_ms(st);
    if (st->sleep_seconds <= 0 || mean_ms <= 0) {
        return 0;   /* no interval set, or nothing measured yet: no estimate */
    }

    int64_t wakes_per_day = 86400 / st->sleep_seconds;
    int64_t uah = wakes_per_day * mean_ms * POWER_UAH_PER_AWAKE_SECOND / 1000;
    int64_t mah = uah / 1000;

    return mah > INT32_MAX ? INT32_MAX : (int)mah;
}

static int finish(sink_t *s)
{
    if (!s->ok) {
        if (s->cap > 0) {
            s->buf[0] = '\0';
        }
        return -1;
    }
    return (int)s->len;
}

int device_api_json_info(char *out, size_t out_size,
                         const char *device_id, const char *model,
                         const char *fw, const char *ip)
{
    sink_t s = { out, out_size, 0, out_size > 0 };
    if (out_size > 0) {
        out[0] = '\0';
    }
    put(&s, "{");
    put_str_field(&s, "deviceId", device_id, true);
    put_str_field(&s, "model", model, false);
    put_str_field(&s, "fw", fw, false);
    put_str_field(&s, "ip", ip, false);
    put(&s, "}");
    return finish(&s);
}

int device_api_json_state(const device_state_t *st, char *out, size_t out_size)
{
    sink_t s = { out, out_size, 0, out_size > 0 };
    if (out_size > 0) {
        out[0] = '\0';
    }
    if (st == NULL) {
        return -1;
    }

    put(&s, "{");
    put_str_field(&s, "deviceId", st->device_id, true);
    put_str_field(&s, "model", st->model, false);
    put_str_field(&s, "fw", st->fw, false);
    put_str_field(&s, "ip", st->ip, false);
    put_int_field(&s, "page", st->page, false);
    put_str_field(&s, "pageTitle", st->page_title, false);

    put(&s, ",\"news\":{");
    put_bool_field(&s, "valid", st->news_valid, true);
    put_bool_field(&s, "demo", st->demo, false);
    put_str_field(&s, "edition", st->edition, false);
    put_str_field(&s, "generatedAt", st->generated_at, false);

    /* The subject identifies the edition better than any count does: it is what
     * the board is actually about, and it is how the app tells "polled fine,
     * same company as an hour ago" from "polled fine, new front page".
     *
     * Cents and basis points, not formatted strings — the app owns the decimal
     * separator and the sign colour, and the two would drift if the firmware
     * decided them here as well. A zero 52-week bound means unknown; the page
     * draws it as absent rather than as a price of nothing. */
    put(&s, ",\"subject\":{");
    put_str_field(&s, "symbol", st->subject.symbol, true);
    put_str_field(&s, "name", st->subject.name, false);
    put_str_field(&s, "exchange", st->subject.exchange, false);
    put_str_field(&s, "sector", st->subject.sector, false);
    put_int_field(&s, "lastCents", st->subject.last_c, false);
    put_int_field(&s, "changeBp", st->subject.chg_bp, false);
    put_int_field(&s, "prevCloseCents", st->subject.prev_close_c, false);
    put_int_field(&s, "openCents", st->subject.open_c, false);
    put_int_field(&s, "highCents", st->subject.high_c, false);
    put_int_field(&s, "lowCents", st->subject.low_c, false);
    put_int_field(&s, "wk52HighCents", st->subject.wk52_hi_c, false);
    put_int_field(&s, "wk52LowCents", st->subject.wk52_lo_c, false);
    put(&s, "}");

    /* What arrived, in one place, AFTER parsing. A count is the whole of what
     * the app gets for the figures, the briefs, the peers, the tables and the
     * thumbnails: a reader has those in front of them, and what the app needs is
     * whether the board received them — "the producer filed a thin day" against
     * "the parser dropped something" is a distinction only these numbers can
     * make, and it is how a producer learns its forty figures became 28. */
    put(&s, ",\"counts\":{");
    put_int_field(&s, "stories", clamped(st->story_count, DEV_STORY_MAX), true);
    put_int_field(&s, "figures", st->figure_count, false);
    put_int_field(&s, "briefs", st->brief_count, false);
    put_int_field(&s, "peers", st->peer_count, false);
    put_int_field(&s, "tables", st->table_count, false);
    put_int_field(&s, "charts", st->chart_count, false);
    put_int_field(&s, "indices", clamped(st->index_count, DEV_INDEX_MAX), false);
    put_int_field(&s, "thumbs", st->thumb_count, false);
    put(&s, "}");

    /* The headlines the board set, in the order it set them. No symbol on a
     * headline: every story in the edition is about `subject`, and repeating it
     * five times would say nothing. */
    put(&s, ",\"headlines\":[");
    int n = clamped(st->story_count, DEV_STORY_MAX);
    for (int i = 0; i < n; i++) {
        put(&s, i ? ",{" : "{");
        put_int_field(&s, "rank", st->stories[i].rank, true);
        put_str_field(&s, "headline", st->stories[i].headline, false);
        put(&s, "}");
    }
    put(&s, "]");

    /* No figures array, deliberately — see device_api_model.h. The dossier is
     * twenty-eight preformatted strings and carrying it here cost 16 KB of .bss
     * for the life of the board, to duplicate the part of the sheet the reader
     * is already standing in front of. `counts.figures` says how many arrived. */

    put(&s, ",\"indices\":[");
    n = clamped(st->index_count, DEV_INDEX_MAX);
    for (int i = 0; i < n; i++) {
        put(&s, i ? ",{" : "{");
        put_str_field(&s, "symbol", st->indices[i].symbol, true);
        put_int_field(&s, "lastCents", st->indices[i].last_c, false);
        put_int_field(&s, "changeBp", st->indices[i].chg_bp, false);
        put(&s, "}");
    }
    put(&s, "]");
    put(&s, "}");

    put(&s, ",\"source\":{");
    put_str_field(&s, "url", st->news_url, true);
    put_str_field(&s, "lastResult", st->last_result, false);
    /* The cadence in force, and who set it. `pollSeconds` is the effective
     * figure — a payload's `policy` block can move it — and a number that can
     * come from two places says nothing on its own: an hourly poll set by the
     * desk ends at 06:00, and an hourly poll compiled into the image does not.
     * A word rather than a boolean because it is going on a screen, and the two
     * are the same length so nothing about the buffer depends on which. */
    put_int_field(&s, "pollSeconds", st->poll_seconds, false);
    put_str_field(&s, "pollSource", st->poll_from_policy ? "policy" : "config", false);
    put_int_field(&s, "ageSeconds", st->age_seconds, false);
    put_bool_field(&s, "stale", st->stale, false);
    put(&s, "}");

    put(&s, ",\"battery\":{");
    put_bool_field(&s, "present", st->battery_present, true);
    put_int_field(&s, "percent", st->battery_pct, false);
    put_int_field(&s, "millivolts", st->battery_mv, false);
    put(&s, "}");

    /* The panel block is not decoration: how often this board is worth polling
     * follows from how long a refresh actually takes, and this is that number
     * measured on the panel rather than assumed from its size. */
    put(&s, ",\"panel\":{");
    put_int_field(&s, "refreshMs", st->refresh_ms, true);
    put(&s, "}");

    /* The design measuring itself. Four counters straight off the board and two
     * numbers derived from them — and the derivation is here, not in the caller,
     * because both of its divisors are legitimately zero and this is the half of
     * the endpoint that has host tests. See device_api_model.h for why these are
     * counters rather than a verdict. */
    put(&s, ",\"power\":{");
    put_bool_field(&s, "deepSleep", st->deep_sleep, true);
    put_int_field(&s, "sleepSeconds", st->sleep_seconds, false);
    put_str_field(&s, "sleepSource", sleep_src_name(st->sleep_source), false);
    put_int_field(&s, "wakes", st->wakes, false);
    put_int_field(&s, "quietWakes", st->quiet_wakes, false);
    put_int_field(&s, "meanAwakeMs", mean_awake_ms(st), false);
    put_int_field(&s, "estMahPerDay", est_mah_per_day(st), false);
    put(&s, "}");

    put(&s, "}");
    return finish(&s);
}
