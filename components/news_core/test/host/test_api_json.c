/*
 * Host unit tests for the companion-app JSON serializers.
 *
 * These bytes go straight onto the wire to a phone, so the tests check two
 * different things: that the document parses (via the vendored cJSON the
 * firmware itself uses) and that the *field names* are what the app reads. A
 * serializer that emits valid JSON with a renamed key is still a broken API,
 * and nothing else in the build would notice.
 */
#include "th.h"

#include "cJSON.h"
#include "device_api_json.h"

/* Big enough that a serialization into it never overflows, so a test that is
 * about content is never quietly a test about length. The length tests use
 * DEVICE_API_STATE_BUF_SZ itself. */
#define ROOMY 16384

static void fill(device_state_t *st)
{
    memset(st, 0, sizeof(*st));
    snprintf(st->model, sizeof(st->model), "WP News");
    snprintf(st->fw, sizeof(st->fw), "0.1.0");
    snprintf(st->device_id, sizeof(st->device_id), "1A2B");
    snprintf(st->ip, sizeof(st->ip), "192.168.0.42");
    st->page = 1;
    snprintf(st->page_title, sizeof(st->page_title), "MARKETS");

    st->news_valid = true;
    st->demo = false;
    snprintf(st->edition, sizeof(st->edition), "SEMICONDUCTORS");
    snprintf(st->generated_at, sizeof(st->generated_at), "2026-08-14T05:12:00Z");

    snprintf(st->subject.symbol, sizeof(st->subject.symbol), "SNDK");
    snprintf(st->subject.name, sizeof(st->subject.name), "Sandisk Corp.");
    snprintf(st->subject.exchange, sizeof(st->subject.exchange), "NASDAQ");
    snprintf(st->subject.sector, sizeof(st->subject.sector), "Semiconductors");
    st->subject.last_c       = 24160;
    st->subject.chg_bp       = 421;
    st->subject.prev_close_c = 23184;
    st->subject.open_c       = 23300;
    st->subject.high_c       = 24505;
    st->subject.low_c        = 23110;
    st->subject.wk52_hi_c    = 26900;
    st->subject.wk52_lo_c    =  8800;

    st->story_count = 2;
    st->stories[0].rank = 0;
    snprintf(st->stories[0].headline, sizeof(st->stories[0].headline),
             "Sandisk's memory squeeze finally shows up in the price");
    st->stories[1].rank = 10;
    snprintf(st->stories[1].headline, sizeof(st->stories[1].headline),
             "The street raises its targets, quietly");

    st->index_count = 2;
    snprintf(st->indices[0].symbol, sizeof(st->indices[0].symbol), "SPX");
    st->indices[0].last_c = 641283;
    st->indices[0].chg_bp = 62;
    snprintf(st->indices[1].symbol, sizeof(st->indices[1].symbol), "VIX");
    st->indices[1].last_c = 1462;
    st->indices[1].chg_bp = -310;

    st->figure_count = 22;
    st->brief_count  = 6;
    st->peer_count   = 5;
    st->table_count  = 1;
    st->chart_count  = 2;
    st->thumb_count  = 2;

    snprintf(st->news_url, sizeof(st->news_url), "http://mac.local:8123/news.json");
    snprintf(st->last_result, sizeof(st->last_result), "ok");
    st->poll_seconds = 300;
    st->age_seconds = 42;
    st->stale = false;

    st->battery_present = true;
    st->battery_pct = 84;
    st->battery_mv = 4012;

    st->refresh_ms = 24800;
}

static cJSON *obj(cJSON *root, const char *key)
{
    cJSON *o = cJSON_GetObjectItem(root, key);
    if (!cJSON_IsObject(o)) {
        g_total++; g_fail++;
        printf("  FAIL missing object \"%s\"\n", key);
        return NULL;
    }
    g_total++;
    return o;
}

/* An array of exactly `want` entries, or NULL and a failure. Every array in
 * this document is fixed-capacity on both sides, so its length is part of the
 * contract and not an incidental. */
static cJSON *arr(cJSON *root, const char *key, int want)
{
    cJSON *a = root ? cJSON_GetObjectItem(root, key) : NULL;
    g_total++;
    if (!cJSON_IsArray(a)) {
        g_fail++;
        printf("  FAIL \"%s\" is not an array\n", key);
        return NULL;
    }
    if (want >= 0 && cJSON_GetArraySize(a) != want) {
        g_fail++;
        printf("  FAIL \"%s\" has %d entries, want %d\n",
               key, cJSON_GetArraySize(a), want);
        return NULL;
    }
    return a;
}

static void check_int(cJSON *o, const char *key, int want)
{
    cJSON *v = o ? cJSON_GetObjectItem(o, key) : NULL;
    g_total++;
    if (!cJSON_IsNumber(v)) {
        g_fail++;
        printf("  FAIL \"%s\" missing or not a number\n", key);
    } else if ((int)cJSON_GetNumberValue(v) != want) {
        g_fail++;
        printf("  FAIL \"%s\" == %d  got %d\n", key, want, (int)cJSON_GetNumberValue(v));
    }
}

static void check_str(cJSON *o, const char *key, const char *want)
{
    cJSON *v = o ? cJSON_GetObjectItem(o, key) : NULL;
    g_total++;
    if (!cJSON_IsString(v)) {
        g_fail++;
        printf("  FAIL \"%s\" missing or not a string\n", key);
    } else if (strcmp(cJSON_GetStringValue(v), want) != 0) {
        g_fail++;
        printf("  FAIL \"%s\" == \"%s\"  got \"%s\"\n", key, want, cJSON_GetStringValue(v));
    }
}

static void check_bool(cJSON *o, const char *key, bool want)
{
    cJSON *v = o ? cJSON_GetObjectItem(o, key) : NULL;
    g_total++;
    if (!cJSON_IsBool(v)) {
        g_fail++;
        printf("  FAIL \"%s\" missing or not a bool\n", key);
    } else if (cJSON_IsTrue(v) != want) {
        g_fail++;
        printf("  FAIL \"%s\" == %s\n", key, want ? "true" : "false");
    }
}

static void test_info(void)
{
    char buf[256];
    int n = device_api_json_info(buf, sizeof(buf), "1A2B", "WP News",
                                 "0.1.0", "192.168.0.42");
    CHECK(n > 0);
    CHECK_INT((int)strlen(buf), n);

    /* The discovery probe reads these four names off every candidate host on
     * the LAN. Renaming one is an app release, not a firmware change. */
    CHECK_STR(buf, "{\"deviceId\":\"1A2B\",\"model\":\"WP News\","
                   "\"fw\":\"0.1.0\",\"ip\":\"192.168.0.42\"}");
}

static void test_state_shape(void)
{
    device_state_t st;
    fill(&st);

    char buf[ROOMY];
    int n = device_api_json_state(&st, buf, sizeof(buf));
    CHECK(n > 0);
    CHECK_INT((int)strlen(buf), n);

    cJSON *r = cJSON_Parse(buf);
    CHECK(r != NULL);
    if (!r) return;

    check_str(r, "deviceId", "1A2B");
    check_str(r, "model", "WP News");
    check_str(r, "fw", "0.1.0");
    check_str(r, "ip", "192.168.0.42");
    check_int(r, "page", 1);
    check_str(r, "pageTitle", "MARKETS");

    cJSON *v = obj(r, "news");
    check_bool(v, "valid", true);
    check_bool(v, "demo", false);
    check_str(v, "edition", "SEMICONDUCTORS");
    check_str(v, "generatedAt", "2026-08-14T05:12:00Z");

    /* One company a day. The subject is what the edition is about, and it is
     * the cheapest "did the page change" check the app has. */
    cJSON *sub = obj(v, "subject");
    check_str(sub, "symbol", "SNDK");
    check_str(sub, "name", "Sandisk Corp.");
    check_str(sub, "exchange", "NASDAQ");
    check_str(sub, "sector", "Semiconductors");
    check_int(sub, "lastCents", 24160);
    check_int(sub, "changeBp", 421);
    check_int(sub, "prevCloseCents", 23184);
    check_int(sub, "openCents", 23300);
    check_int(sub, "highCents", 24505);
    check_int(sub, "lowCents", 23110);
    check_int(sub, "wk52HighCents", 26900);
    check_int(sub, "wk52LowCents", 8800);

    cJSON *c = obj(v, "counts");
    check_int(c, "stories", 2);
    check_int(c, "figures", 22);
    check_int(c, "briefs", 6);
    check_int(c, "peers", 5);
    check_int(c, "tables", 1);
    check_int(c, "charts", 2);
    check_int(c, "indices", 2);
    check_int(c, "thumbs", 2);

    /* The rank travels unchanged: the device orders by position, but the number
     * is what produced that order, and a phone list that re-sorted on anything
     * else would disagree with the sheet. */
    cJSON *hl = arr(v, "headlines", 2);
    if (hl) {
        check_int(cJSON_GetArrayItem(hl, 0), "rank", 0);
        check_str(cJSON_GetArrayItem(hl, 0), "headline",
                  "Sandisk's memory squeeze finally shows up in the price");
        check_int(cJSON_GetArrayItem(hl, 1), "rank", 10);
        check_str(cJSON_GetArrayItem(hl, 1), "headline",
                  "The street raises its targets, quietly");
    }

    /* The dossier is a COUNT and nothing else. It was an array once and it cost
     * 16 KB of .bss to duplicate the part of the sheet the reader is standing in
     * front of; asserting its absence is what stops it coming back by accident.
     * See device_api_model.h. */
    g_total++;
    if (cJSON_GetObjectItem(v, "figures") != NULL) {
        g_fail++;
        printf("  FAIL \"news.figures\" is back — the dossier does not travel; "
               "give it its own endpoint\n");
    }

    /* Cents and basis points, not formatted strings: the app owns the decimal
     * separator and the sign colour, and the two would drift if the firmware
     * decided them here as well. */
    cJSON *idx = arr(v, "indices", 2);
    if (idx) {
        check_str(cJSON_GetArrayItem(idx, 0), "symbol", "SPX");
        check_int(cJSON_GetArrayItem(idx, 0), "lastCents", 641283);
        check_int(cJSON_GetArrayItem(idx, 0), "changeBp", 62);
        check_str(cJSON_GetArrayItem(idx, 1), "symbol", "VIX");
        check_int(cJSON_GetArrayItem(idx, 1), "changeBp", -310);
    }

    cJSON *s = obj(r, "source");
    check_str(s, "url", "http://mac.local:8123/news.json");
    check_str(s, "lastResult", "ok");
    check_int(s, "pollSeconds", 300);
    /* The cadence and its provenance travel together. 300 seconds set by the
     * desk for the night and 300 seconds compiled into the image are the same
     * number and different facts, and only one of them ends on its own. */
    check_str(s, "pollSource", "config");
    check_int(s, "ageSeconds", 42);
    check_bool(s, "stale", false);

    cJSON *b = obj(r, "battery");
    check_bool(b, "present", true);
    check_int(b, "percent", 84);
    check_int(b, "millivolts", 4012);

    /* The refresh timing is the whole reason the polling policy can be decided
     * from measurement rather than guessed, so it is part of the contract. */
    cJSON *p = obj(r, "panel");
    check_int(p, "refreshMs", 24800);

    cJSON_Delete(r);
}

static void test_counts_are_clamped_to_their_arrays(void)
{
    /* user_app copies these out of news_t under a lock. A count that outran its
     * array — or a negative one from an uninitialised read — would serialise
     * whatever follows the struct straight onto the network. The clamp must
     * also reach `counts`, or the app would be told about entries the same
     * document does not carry. */
    device_state_t st;
    fill(&st);
    st.story_count = 99;
    st.index_count = 99;

    char buf[ROOMY];
    CHECK(device_api_json_state(&st, buf, sizeof(buf)) > 0);
    cJSON *r = cJSON_Parse(buf);
    CHECK(r != NULL);
    if (r) {
        cJSON *v = obj(r, "news");
        arr(v, "headlines", DEV_STORY_MAX);
        arr(v, "indices", DEV_INDEX_MAX);
        cJSON *c = obj(v, "counts");
        check_int(c, "stories", DEV_STORY_MAX);
        check_int(c, "indices", DEV_INDEX_MAX);
        cJSON_Delete(r);
    }

    fill(&st);
    st.story_count = -3;
    st.index_count = -3;
    CHECK(device_api_json_state(&st, buf, sizeof(buf)) > 0);
    r = cJSON_Parse(buf);
    CHECK(r != NULL);
    if (r) {
        cJSON *v = obj(r, "news");
        arr(v, "headlines", 0);
        arr(v, "indices", 0);
        cJSON *c = obj(v, "counts");
        check_int(c, "stories", 0);
        check_int(c, "indices", 0);
        cJSON_Delete(r);
    }
}

static void test_utf8_passes_through(void)
{
    /* Headlines come off a wire copy desk: em dashes, curly quotes and accented
     * names are the normal case, not the exotic one. JSON strings are defined
     * over Unicode, so escaping them to \u would be legal and pointless — but
     * the escaper must not mangle them either. */
    device_state_t st;
    fill(&st);
    snprintf(st.stories[0].headline, sizeof(st.stories[0].headline),
             "Société Générale — Zürich desk’s call");
    snprintf(st.edition, sizeof(st.edition), "MIDDAY EDITION №2");
    snprintf(st.subject.name, sizeof(st.subject.name), "Fährhaus Müller SE");
    snprintf(st.subject.sector, sizeof(st.subject.sector), "Bâtiment — Génie civil");

    char buf[ROOMY];
    CHECK(device_api_json_state(&st, buf, sizeof(buf)) > 0);
    CHECK(strstr(buf, "Société Générale") != NULL);

    cJSON *r = cJSON_Parse(buf);
    CHECK(r != NULL);
    if (r) {
        cJSON *v = obj(r, "news");
        check_str(v, "edition", "MIDDAY EDITION №2");
        check_str(obj(v, "subject"), "name", "Fährhaus Müller SE");
        check_str(obj(v, "subject"), "sector", "Bâtiment — Génie civil");
        check_str(cJSON_GetArrayItem(cJSON_GetObjectItem(v, "headlines"), 0),
                  "headline", "Société Générale — Zürich desk’s call");
        cJSON_Delete(r);
    }
}

static void test_control_characters_are_escaped(void)
{
    /* A headline with a newline in it is not exotic — a producer's own JSON
     * will carry one sooner or later, and an unescaped 0x0A is invalid JSON
     * that would break the app's parser rather than just looking odd. The
     * quote and the backslash are the two that turn a document into a
     * different document rather than an invalid one, which is worse. */
    device_state_t st;
    fill(&st);
    snprintf(st.edition, sizeof(st.edition), "a\"b\\c\nd\te");
    snprintf(st.subject.name, sizeof(st.subject.name), "\\\"}],\"x\":1");
    snprintf(st.stories[0].headline, sizeof(st.stories[0].headline),
             "bell\ax\bback\fform\rcr");

    char buf[ROOMY];
    CHECK(device_api_json_state(&st, buf, sizeof(buf)) > 0);
    cJSON *r = cJSON_Parse(buf);
    CHECK(r != NULL);
    if (r) {
        cJSON *v = obj(r, "news");
        check_str(v, "edition", "a\"b\\c\nd\te");
        check_str(obj(v, "subject"), "name", "\\\"}],\"x\":1");
        check_str(cJSON_GetArrayItem(cJSON_GetObjectItem(v, "headlines"), 0),
                  "headline", "bell\ax\bback\fform\rcr");
        cJSON_Delete(r);
    }
}

/* Every string at its declared maximum, in the widest bytes it can hold, every
 * array at capacity and every integer at nine digits with a sign. This is what
 * fixes the field capacities in device_api_model.h. */
static void fill_worst_case(device_state_t *st)
{
    memset(st, 0, sizeof(*st));

    #define FILL_ASCII(field) do { \
        size_t wc_n = sizeof(st->field) - 1; \
        memset(st->field, 'W', wc_n); \
        st->field[wc_n] = '\0'; \
    } while (0)

    FILL_ASCII(model);
    FILL_ASCII(fw);
    FILL_ASCII(device_id);
    FILL_ASCII(ip);
    FILL_ASCII(news_url);
    FILL_ASCII(last_result);

    /* A multi-byte codepoint passes through the escaper untouched, so a Latin-1
     * field is the same length on the wire as an ASCII one. A field full of
     * quotes is NOT: each becomes two bytes.
     *
     * The cursor is named `wc_` rather than `i` on purpose: the fields below are
     * subscripted by the caller's own loop variable, and a macro that declared
     * `i` would silently rewrite `st->figures[i]` into `st->figures[wc_]`. */
    #define FILL_WIDEST(field, ch) do { \
        for (size_t wc_ = 0; wc_ + 1 < sizeof(st->field); wc_++) st->field[wc_] = (ch); \
        st->field[sizeof(st->field) - 1] = '\0'; \
    } while (0)

    FILL_WIDEST(edition, '"');
    FILL_WIDEST(page_title, '\\');
    FILL_WIDEST(generated_at, '\n');
    FILL_WIDEST(subject.symbol, '"');
    FILL_WIDEST(subject.name, '"');
    FILL_WIDEST(subject.exchange, '"');
    FILL_WIDEST(subject.sector, '"');

    /* A C0 control is the true worst case — six bytes out of one — and a
     * producer that pastes a tab into a label is one keystroke away. */
    st->story_count = DEV_STORY_MAX;
    for (int i = 0; i < DEV_STORY_MAX; i++) {
        FILL_WIDEST(stories[i].headline, 0x01);
        st->stories[i].rank = -999999999;
    }

    st->index_count = DEV_INDEX_MAX;
    for (int i = 0; i < DEV_INDEX_MAX; i++) {
        FILL_WIDEST(indices[i].symbol, 0x01);
        st->indices[i].last_c = 999999999;
        st->indices[i].chg_bp = -999999999;
    }

    #undef FILL_ASCII
    #undef FILL_WIDEST

    st->page = 3;
    st->news_valid = true;
    st->subject.last_c = st->subject.chg_bp = -999999999;
    st->subject.prev_close_c = st->subject.open_c = 999999999;
    st->subject.high_c = st->subject.low_c = 999999999;
    st->subject.wk52_hi_c = st->subject.wk52_lo_c = 999999999;
    st->figure_count = st->brief_count = st->peer_count = 999999999;
    st->table_count = st->chart_count = st->thumb_count = 999999999;
    st->poll_seconds = st->age_seconds = 999999999;
    /* Both spellings of pollSource are six characters, so this picks one rather
     * than the longer one — there is no longer one. */
    st->poll_from_policy = true;
    st->battery_pct = st->battery_mv = 999999999;
    st->refresh_ms = 999999999;
}

static void test_worst_case_fits_the_servers_buffer(void)
{
    /* device_api.c serialises into a DEVICE_API_STATE_BUF_SZ buffer. If the
     * worst case does not fit, the serializer returns -1 and an EMPTY body —
     * so the symptom is "the app shows nothing", with no error anywhere to
     * suggest a length problem. */
    device_state_t st;
    fill_worst_case(&st);

    char buf[DEVICE_API_STATE_BUF_SZ];
    int n = device_api_json_state(&st, buf, sizeof(buf));
    if (n < 0) {
        g_total++; g_fail++;
        char scratch[ROOMY];
        int want = device_api_json_state(&st, scratch, sizeof(scratch));
        printf("  FAIL worst-case state needs %d bytes and DEVICE_API_STATE_BUF_SZ is %d — "
               "raise it or shorten a field in device_api_model.h\n",
               want, DEVICE_API_STATE_BUF_SZ);
    } else {
        g_total++;
        printf("  worst-case state document: %d of %d bytes\n", n, DEVICE_API_STATE_BUF_SZ);
        cJSON *r = cJSON_Parse(buf);
        CHECK(r != NULL);
        cJSON_Delete(r);
    }

    char ibuf[DEVICE_API_INFO_BUF_SZ];
    char wide[DEV_MODEL_MAXLEN];
    memset(wide, '"', sizeof(wide) - 1);
    wide[sizeof(wide) - 1] = '\0';
    CHECK(device_api_json_info(ibuf, sizeof(ibuf), wide, wide, wide, wide) > 0);
}

static void test_overflow_yields_an_empty_string_not_half_a_document(void)
{
    /* Half a JSON document is worse than none: the app would try to parse it,
     * fail somewhere in the middle, and report a confusing error. The contract
     * is -1 and out[0] == '\0'. */
    device_state_t st;
    fill(&st);

    char buf[64];
    CHECK_INT(device_api_json_state(&st, buf, sizeof(buf)), -1);
    CHECK_STR(buf, "");

    char tiny[4];
    CHECK_INT(device_api_json_info(tiny, sizeof(tiny), "1A2B", "WP News",
                                   "0.1.0", "1.2.3.4"), -1);
    CHECK_STR(tiny, "");

    /* Zero capacity must not write at all. */
    CHECK_INT(device_api_json_state(&st, buf, 0), -1);
    CHECK_INT(device_api_json_info(buf, 0, "a", "b", "c", "d"), -1);
}

/* The cursor is bounded, so prove it at every boundary rather than at one.
 *
 * A document is serialised into every capacity from 0 up to one past its own
 * length, each into a buffer with a guard byte after it. Every truncation must
 * return -1 with an empty string, the one exact fit must return the length, and
 * nothing may ever touch the guard — which is the only way an off-by-one in
 * `s->len + n + 1 > s->cap` shows up as a failure rather than as a corrupted
 * neighbour on the device three weeks later. */
static void test_every_truncation_stays_inside_its_buffer(void)
{
    device_state_t st;
    fill(&st);

    char full[ROOMY];
    int want = device_api_json_state(&st, full, sizeof(full));
    CHECK(want > 0);
    if (want <= 0) return;

    int bad_return = 0, bad_term = 0, clobbered = 0;
    for (size_t cap = 0; cap <= (size_t)want + 1; cap++) {
        char *heap = (char *)malloc(cap + 8);
        if (!heap) { CHECK(false); return; }
        memset(heap, 'G', cap + 8);

        int n = device_api_json_state(&st, heap, cap);

        for (size_t k = cap; k < cap + 8; k++) {
            if (heap[k] != 'G') { clobbered++; break; }
        }
        if (cap >= (size_t)want + 1) {
            if (n != want || strlen(heap) != (size_t)want) bad_return++;
        } else {
            if (n != -1) bad_return++;
            if (cap > 0 && heap[0] != '\0') bad_term++;
        }
        free(heap);
    }
    CHECK_INT(clobbered, 0);
    CHECK_INT(bad_return, 0);
    CHECK_INT(bad_term, 0);
}

static void test_null_state_is_rejected(void)
{
    char buf[256];
    CHECK_INT(device_api_json_state(NULL, buf, sizeof(buf)), -1);
    CHECK_STR(buf, "");
}

static void test_zeroed_state_still_parses(void)
{
    /* This is what /api/state returns before the first poll — every string
     * empty, every number zero. It must still be a valid document, with empty
     * arrays and a present-but-empty subject rather than missing keys: an app
     * that has to distinguish "no key" from "no news" has two states to handle
     * where the board only ever has one. */
    device_state_t st;
    memset(&st, 0, sizeof(st));

    char buf[ROOMY];
    CHECK(device_api_json_state(&st, buf, sizeof(buf)) > 0);
    cJSON *r = cJSON_Parse(buf);
    CHECK(r != NULL);
    if (r) {
        cJSON *v = obj(r, "news");
        check_bool(v, "valid", false);
        arr(v, "headlines", 0);
        arr(v, "indices", 0);
        cJSON *sub = obj(v, "subject");
        check_str(sub, "symbol", "");
        check_int(sub, "lastCents", 0);
        check_int(obj(v, "counts"), "stories", 0);
        check_int(obj(v, "counts"), "figures", 0);
        check_str(r, "deviceId", "");
        cJSON_Delete(r);
    }
}

int main(void)
{
    test_info();
    test_state_shape();
    test_counts_are_clamped_to_their_arrays();
    test_utf8_passes_through();
    test_control_characters_are_escaped();
    test_worst_case_fits_the_servers_buffer();
    test_overflow_yields_an_empty_string_not_half_a_document();
    test_every_truncation_stays_inside_its_buffer();
    test_null_state_is_rejected();
    test_zeroed_state_still_parses();
    TH_REPORT("api_json");
}
