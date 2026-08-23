/*
 * news_parse.c — the wire payload -> news_t.
 *
 * The producer is an agent running on somebody's machine. It will send a string
 * where a number belongs, a null where a headline belongs, an empty array, a
 * 900-entry array, a chart with no bars, a photo id with no dimensions, a table
 * row shorter than its own header, and — the day the machine sleeps — half a
 * response. None of that may take the board down, and none of it may leave a
 * half-typeset page on the glass.
 *
 * So: parse into a scratch snapshot, validate and clamp every field, and only
 * copy into the caller's struct on success. A rejected payload leaves the
 * previous front page exactly as it was, which is why the folio can honestly
 * badge it STALE rather than going blank.
 *
 * The scratch is on the heap because news_t is ~33 KB and NewsTask's stack is
 * 16 KB. An allocation failure is a rejection like any other, which keeps the
 * "*out is written only on success" rule true on that path too.
 *
 * Portable: cJSON only. test_news_parse.c builds this file directly.
 */
#include "news_parse.h"

#include <stdlib.h>
#include <string.h>

#include "cJSON.h"

/* The tile fetch asks for w*h/2 raw bytes, so a photo whose dimensions came off
 * the wire unchecked is a request for as many bytes as a double can hold. The
 * panel is 1200x1600 and no slot on the page is larger than the panel. */
#define PHOTO_W_MAX 1200
#define PHOTO_H_MAX 1600

/* A rank is an ordering, not a magnitude. Clamping the top end keeps the
 * "unranked sinks to the bottom" default meaningful.
 *
 * The default is deliberately larger than NEWS_STORIES_MAX rather than equal to
 * it: an unranked story must sort below every ranked one, and a producer that
 * numbers its file 0..4 would otherwise tie with it. */
#define RANK_MAX     99
#define RANK_DEFAULT  9

/* --- defensive accessors --------------------------------------------------
 * Every one of these takes "the key is missing" and "the key holds the wrong
 * type" to the same place: the default. That is the entire error policy for
 * individual fields, and it is why the field code below has no branches. */

/* Round-half-away-from-zero into a scaled integer: dollars to cents, percent to
 * basis points, and any bare number the model stores as an int. Every number
 * that crosses from JSON's double into the model goes through here, so 1631.47
 * becomes 163147 on x86 and on Xtensa alike — truncating instead would let a
 * price tick down by a cent when nothing moved and cost a refresh.
 *
 * The negated comparisons are not a style: they also reject a NaN, and casting
 * a NaN to int32_t is undefined rather than merely wrong. */
static int32_t sround(double d, int mul)
{
    double x = d * (double)mul;
    if (!(x > -2147483000.0)) return -2147483000;
    if (!(x <  2147483000.0)) return  2147483000;
    return (int32_t)(x >= 0.0 ? x + 0.5 : x - 0.5);
}

static int jint(const cJSON *o, const char *key, int def)
{
    const cJSON *v = cJSON_GetObjectItemCaseSensitive(o, key);
    if (!cJSON_IsNumber(v)) return def;
    return (int)sround(cJSON_GetNumberValue(v), 1);
}

/* An int held between two bounds: a negative width or count would reach a
 * drawing routine, and an enormous one would reach an allocation. */
static int jrange(const cJSON *o, const char *key, int lo, int hi, int def)
{
    int v = jint(o, key, def);
    if (v < lo) return lo;
    if (v > hi) return hi;
    return v;
}

/* A JSON number scaled into the model's fixed point. Absent or of the wrong
 * type means zero: a price of nothing prints as 0.00, which is visibly wrong,
 * where a leftover value from another quote would be invisibly wrong. */
static int32_t jscaled(const cJSON *o, const char *key, int mul)
{
    const cJSON *v = cJSON_GetObjectItemCaseSensitive(o, key);
    if (!cJSON_IsNumber(v)) return 0;
    return sround(cJSON_GetNumberValue(v), mul);
}

static bool jbool(const cJSON *o, const char *key)
{
    const cJSON *v = cJSON_GetObjectItemCaseSensitive(o, key);
    return cJSON_IsTrue(v);
}

static const char *jstr(const cJSON *o, const char *key)
{
    const cJSON *v = cJSON_GetObjectItemCaseSensitive(o, key);
    return cJSON_IsString(v) && v->valuestring ? v->valuestring : "";
}

static const cJSON *jarr(const cJSON *o, const char *key)
{
    const cJSON *v = cJSON_GetObjectItemCaseSensitive(o, key);
    return cJSON_IsArray(v) ? v : NULL;
}

static const cJSON *jobj(const cJSON *o, const char *key)
{
    const cJSON *v = cJSON_GetObjectItemCaseSensitive(o, key);
    return cJSON_IsObject(v) ? v : NULL;
}

/* --- the policy ----------------------------------------------------------
 *
 * The only object on this wire that is not about the paper: how often to come
 * back, and when the server's answer will next change. See news_model.h for the
 * argument; what happens HERE is that every way of getting it wrong lands on
 * "absent", and absent is exactly what a board built before this field existed
 * does with every payload it ever sees.
 *
 * That is the whole error policy, and it is stricter than it looks. This block
 * governs when the device asks again, so a garbage value that was *clamped into
 * range* rather than dropped would leave a board quietly polling at a cadence
 * nobody chose. A string, a null, a policy that is an array — all of them mean
 * the producer did not send one. */

/* The furthest instant a calendar can name: 9999-12-31T23:59:59Z. It is a bound
 * and not a judgement — the device only ever computes `next_change - now`, so a
 * value past the end of time behaves exactly like an absent one — but casting a
 * double that large to int64_t is undefined rather than merely wrong, and this
 * is where that is prevented. */
#define NEXT_CHANGE_MAX 253402300799LL

static void parse_policy(const cJSON *root, news_policy_t *p)
{
    const cJSON *o = jobj(root, "policy");
    if (!o) return;

    /* Present but out of range CLAMPS. A server that computed a cadence of two
     * seconds has a scheduling bug, and the right answer to it is a board
     * polling at the floor rather than a board that rejected the edition and is
     * still showing yesterday's front page. Rounded half away from zero like
     * every other number that crosses this wire. */
    const cJSON *poll = cJSON_GetObjectItemCaseSensitive(o, "poll_seconds");
    if (cJSON_IsNumber(poll)) {
        int32_t s = sround(cJSON_GetNumberValue(poll), 1);
        if (s < NEWS_POLL_MIN) s = NEWS_POLL_MIN;
        if (s > NEWS_POLL_MAX) s = NEWS_POLL_MAX;
        p->poll_seconds = s;
    }

    /* An instant, so it does not go through sround(): that saturates at about
     * 2.1e9, which is January 2038, and a field whose whole point is to survive
     * being a date must not be clamped to the year an int32 runs out.
     *
     * Negative goes to zero rather than to a bound, and that is not the same
     * decision the cadence gets. A cadence of -5 is a number a server meant to
     * be positive and the nearest legal one says what it meant; an instant
     * before the epoch is not an instant at all, and "absent" is the only honest
     * reading of it. */
    const cJSON *when = cJSON_GetObjectItemCaseSensitive(o, "next_change");
    if (cJSON_IsNumber(when)) {
        double d = cJSON_GetNumberValue(when);
        /* Negated so a NaN takes the first branch: casting one to int64_t is
         * undefined, exactly as it is in sround(). */
        if (!(d > 0.0)) {
            p->next_change = 0;
        } else if (!(d < (double)NEXT_CHANGE_MAX)) {
            p->next_change = NEXT_CHANGE_MAX;
        } else {
            p->next_change = (int64_t)(d + 0.5);
        }
    }
}

/* --- the subject ---------------------------------------------------------- */

/* The company the edition is about. Every field is an integer because every
 * field is compared, coloured or scaled by the device; the printed summary
 * figures live in `figures` where the producer can format them.
 *
 * Absent means zero throughout, and the 52-week bounds are the field where that
 * is load-bearing: the page draws them as absent rather than drawing a range
 * that runs from nothing. */
static void parse_subject(const cJSON *root, news_subject_t *s)
{
    const cJSON *o = jobj(root, "subject");
    if (!o) return;

    news_str_copy(s->symbol, sizeof(s->symbol), jstr(o, "symbol"));
    news_str_copy_prose(s->name, sizeof(s->name), jstr(o, "name"));
    news_str_copy(s->exchange, sizeof(s->exchange), jstr(o, "exchange"));
    news_str_copy_prose(s->sector, sizeof(s->sector), jstr(o, "sector"));

    s->last_c       = jscaled(o, "last", 100);
    s->chg_bp       = jscaled(o, "change_pct", 100);
    s->prev_close_c = jscaled(o, "prev_close", 100);
    s->open_c       = jscaled(o, "open", 100);
    s->high_c       = jscaled(o, "high", 100);
    s->low_c        = jscaled(o, "low", 100);
    s->wk52_hi_c    = jscaled(o, "wk52_high", 100);
    s->wk52_lo_c    = jscaled(o, "wk52_low", 100);
}

/* --- quotes: the index ribbon --------------------------------------------- */

/* A sparkline is a history, and the end being read is the right-hand one, so an
 * over-long series loses its oldest samples rather than its newest. Values are
 * already normalised 0..1000 by the producer; anything outside that would draw
 * outside its 48x14 box. */
static void parse_spark(const cJSON *arr, news_quote_t *q)
{
    if (!arr) return;
    int total = cJSON_GetArraySize(arr);
    int n     = total > NEWS_SPARK_MAX ? NEWS_SPARK_MAX : total;
    int skip  = total - n;
    for (int i = 0; i < n; i++) {
        const cJSON *e = cJSON_GetArrayItem(arr, skip + i);
        int32_t val = cJSON_IsNumber(e) ? sround(cJSON_GetNumberValue(e), 1) : 0;
        if (val < 0)    val = 0;
        if (val > 1000) val = 1000;
        q->spark[q->spark_n++] = (int16_t)val;
    }
}

/* An entry with no symbol is a blank cell with a number beside it, which reads
 * as a rendering bug rather than as missing data. */
static void parse_indices(const cJSON *root, news_t *v)
{
    const cJSON *arr = jarr(root, "indices");
    if (!arr) return;
    const cJSON *e = NULL;
    cJSON_ArrayForEach(e, arr) {
        if (v->index_count >= NEWS_INDEX_MAX) break;
        if (!cJSON_IsObject(e)) continue;
        if (!jstr(e, "symbol")[0]) continue;

        news_quote_t *q = &v->indices[v->index_count++];
        memset(q, 0, sizeof(*q));
        news_str_copy(q->symbol, sizeof(q->symbol), jstr(e, "symbol"));
        news_str_copy_prose(q->name, sizeof(q->name), jstr(e, "name"));
        q->last_c = jscaled(e, "last", 100);
        q->chg_bp = jscaled(e, "change_pct", 100);
        parse_spark(jarr(e, "spark"), q);
    }
}

/* --- charts --------------------------------------------------------------- */

/* One sample of one of the three optional series.
 *
 * `close` sets the length and is the only array a chart has to send: a line
 * chart sends closes alone, a candle chart sends four arrays of equal length.
 * A slot the wire left out — or filled with something that is not a number —
 * falls back to that point's close, so a consumer that reaches for h[] out of a
 * line series gets a zero-height bar rather than one that spans the whole scale.
 *
 * Read at the same ABSOLUTE index as the close it belongs to, never at the same
 * offset from the end: the four arrays are parallel, and an open[] that arrived
 * one element short would otherwise shift every open by a session, which draws
 * as a chart of plausible candles that are all subtly wrong. */
static int32_t series_at(const cJSON *arr, int idx, int32_t fallback)
{
    if (!arr) return fallback;
    const cJSON *e = cJSON_GetArrayItem(arr, idx);
    if (!cJSON_IsNumber(e)) return fallback;
    return sround(cJSON_GetNumberValue(e), 100);
}

static void parse_chart(const cJSON *e, news_chart_t *ch)
{
    ch->kind = news_chart_kind_from(jstr(e, "kind"));
    news_str_copy_prose(ch->label, sizeof(ch->label), jstr(e, "label"));
    news_str_copy(ch->span, sizeof(ch->span), jstr(e, "span"));
    news_str_copy_prose(ch->note, sizeof(ch->note), jstr(e, "note"));

    const cJSON *close = jarr(e, "close");
    if (ch->kind != CHART_NONE && close) {
        const cJSON *open = jarr(e, "open");
        const cJSON *high = jarr(e, "high");
        const cJSON *low  = jarr(e, "low");

        int total = cJSON_GetArraySize(close);
        int n     = total > NEWS_BARS_MAX ? NEWS_BARS_MAX : total;
        int skip  = total - n;          /* a month of candles, most recent kept */
        for (int i = 0; i < n; i++) {
            const cJSON *c = cJSON_GetArrayItem(close, skip + i);
            if (!cJSON_IsNumber(c)) continue;   /* a point with no close is not a point */
            int32_t cv = sround(cJSON_GetNumberValue(c), 100);
            ch->o[ch->n] = series_at(open, skip + i, cv);
            ch->h[ch->n] = series_at(high, skip + i, cv);
            ch->l[ch->n] = series_at(low,  skip + i, cv);
            ch->c[ch->n] = cv;
            ch->n++;
        }
    }

    /* A kind with no bars would reserve its slot and draw an empty box. The
     * module reflows without it instead, which is a normal front-page
     * condition, and `kind == CHART_NONE` stays the model's single test for
     * "is there a chart" rather than becoming two. */
    if (ch->n == 0) {
        memset(ch, 0, sizeof(*ch));
    }
}

/* The charts array is parsed BEFORE the stories, because a story names a chart
 * by index and the index can only be checked against what actually arrived.
 *
 * A chart that cannot be drawn keeps its slot rather than being dropped. That
 * is the whole reason this loop looks wasteful: the producer numbered its
 * stories against the array it sent, so removing element 0 would silently
 * renumber element 1, and a story that asked for the revenue bars would draw
 * the price series under a caps head that says REVENUE. Losing a chart is a
 * page one item shorter; drawing the wrong one is a lie about a number. */
static void parse_charts(const cJSON *root, news_t *v)
{
    const cJSON *arr = jarr(root, "charts");
    if (!arr) return;

    const cJSON *e = NULL;
    cJSON_ArrayForEach(e, arr) {
        if (v->chart_count >= NEWS_CHARTS_MAX) break;
        news_chart_t *ch = &v->charts[v->chart_count++];
        memset(ch, 0, sizeof(*ch));
        if (cJSON_IsObject(e)) parse_chart(e, ch);
    }

    /* Trailing empties are the exception: no surviving index points past them,
     * so dropping them cannot renumber anything, and it keeps chart_count
     * honest for a compositor that reads it before it reads the charts. */
    while (v->chart_count > 0 && v->charts[v->chart_count - 1].kind == CHART_NONE) {
        v->chart_count--;
    }
}

/* --- photos --------------------------------------------------------------- */

/* Shared by a story's `photo` and by every entry of `thumbs`, which is the same
 * object in the wire and the same struct in the model. */
static void parse_photo(const cJSON *ph, news_photo_t *p)
{
    if (!ph) return;

    news_str_copy(p->id, sizeof(p->id), jstr(ph, "id"));

    /* Read before it is clamped, because evenness is a fact about the TILE and
     * not about the slot. A tile packs two pixels to a byte, so a row of odd
     * width does not end on a byte boundary and cannot be blitted as a per-row
     * memcpy; the device would need a nibble-shifting slow path for what is
     * always a producer's rounding error. Clamping first and testing after
     * would let 99999 through as 1200 while rejecting 947, which tests the
     * clamp rather than the packing. */
    int declared_w = jint(ph, "w", 0);
    bool blittable = (declared_w % 2) == 0;

    p->w = declared_w < 0 ? 0 : (declared_w > PHOTO_W_MAX ? PHOTO_W_MAX : declared_w);
    p->h = jrange(ph, "h", 0, PHOTO_H_MAX, 0);
    news_str_copy_prose(p->caption, sizeof(p->caption), jstr(ph, "caption"));
    news_str_copy_prose(p->credit, sizeof(p->credit), jstr(ph, "credit"));

    /* The id is a URL and the dimensions are the byte count; one without the
     * other cannot be fetched, and a caption under a slot that stayed empty is
     * worse than no caption. `id[0] == '\0'` is the model's single test for
     * "no photo", so make it true here rather than at four call sites. */
    if (!p->id[0] || p->w <= 0 || p->h <= 0 || !blittable) {
        memset(p, 0, sizeof(*p));
    }
}

/* Unlike a chart, a thumb is not named by index from anywhere, so one that
 * cannot be fetched is dropped outright rather than left as a hole in the
 * array for the page to skip. */
static void parse_thumbs(const cJSON *root, news_t *v)
{
    const cJSON *arr = jarr(root, "thumbs");
    if (!arr) return;

    const cJSON *e = NULL;
    cJSON_ArrayForEach(e, arr) {
        if (v->thumb_count >= NEWS_THUMBS_MAX) break;
        if (!cJSON_IsObject(e)) continue;

        news_photo_t *p = &v->thumbs[v->thumb_count];
        memset(p, 0, sizeof(*p));
        parse_photo(e, p);
        if (p->id[0]) v->thumb_count++;
    }
}

/* --- stories -------------------------------------------------------------- */

static bool parse_story(const cJSON *e, news_story_t *s, int chart_count)
{
    /* Checked before anything is written: `s` may still hold a story we are
     * about to decide is better than this one. */
    const char *headline = jstr(e, "headline");
    if (!headline[0]) return false;

    memset(s, 0, sizeof(*s));
    s->rank = jrange(e, "rank", 0, RANK_MAX, RANK_DEFAULT);
    news_str_copy_prose(s->kicker,   sizeof(s->kicker),   jstr(e, "kicker"));
    news_str_copy_prose(s->headline, sizeof(s->headline), headline);
    news_str_copy_prose(s->deck,     sizeof(s->deck),     jstr(e, "deck"));
    news_str_copy_prose(s->byline,   sizeof(s->byline),   jstr(e, "byline"));
    news_str_copy_prose(s->body,     sizeof(s->body),     jstr(e, "body"));

    /* An index into news_t::charts, or -1. Anything outside what arrived
     * becomes -1: a story that reflows without its chart is an ordinary front
     * page, and one that draws whatever landed in the slot instead is a lie
     * about a price. */
    s->chart = jint(e, "chart", -1);
    if (s->chart < 0 || s->chart >= chart_count) s->chart = -1;

    parse_photo(jobj(e, "photo"), &s->photo);
    return true;
}

/* Swapped byte by byte: a news_story_t is ~2 KB, and the usual `tmp = a[i]`
 * insertion sort would put an eighth of NewsTask's stack on the frame to save
 * ten comparisons. */
static void swap_stories(news_story_t *a, news_story_t *b)
{
    unsigned char *p = (unsigned char *)a, *q = (unsigned char *)b;
    for (size_t i = 0; i < sizeof(news_story_t); i++) {
        unsigned char t = p[i]; p[i] = q[i]; q[i] = t;
    }
}

static void parse_stories(const cJSON *root, news_t *v)
{
    const cJSON *arr = jarr(root, "stories");
    if (!arr) return;

    const cJSON *e = NULL;
    cJSON_ArrayForEach(e, arr) {
        if (!cJSON_IsObject(e)) continue;

        /* The array's order is the producer's, not a ranking, so truncating at
         * NEWS_STORIES_MAX would drop the lead the day somebody appends it.
         * Keep the lowest ranks instead; the rank is read before the story is
         * parsed so that a rejected candidate costs nothing. */
        int slot = v->story_count;
        if (slot >= NEWS_STORIES_MAX) {
            int rank  = jrange(e, "rank", 0, RANK_MAX, RANK_DEFAULT);
            int worst = 0;
            for (int i = 1; i < v->story_count; i++) {
                if (v->stories[i].rank > v->stories[worst].rank) worst = i;
            }
            if (rank >= v->stories[worst].rank) continue;
            slot = worst;
        }

        if (!parse_story(e, &v->stories[slot], v->chart_count)) continue;
        if (slot == v->story_count) v->story_count++;
    }

    /* Insertion sort by adjacent swaps: stable, so equal ranks keep the
     * producer's order, and the compositor's packing order is then a straight
     * index — rank 0 is stories[0] and is the module it gives the sheet to
     * first. */
    for (int i = 1; i < v->story_count; i++) {
        for (int j = i; j > 0 && v->stories[j].rank < v->stories[j - 1].rank; j--) {
            swap_stories(&v->stories[j], &v->stories[j - 1]);
        }
    }
}

/* --- the dossier rail ----------------------------------------------------- */

static void parse_figures(const cJSON *root, news_t *v)
{
    const cJSON *arr = jarr(root, "figures");
    if (!arr) return;

    const cJSON *e = NULL;
    cJSON_ArrayForEach(e, arr) {
        if (v->figure_count >= NEWS_FIGURES_MAX) break;
        if (!cJSON_IsObject(e)) continue;

        /* A rail line is a label and a value. Either one missing leaves half a
         * row under a standing head, which reads as a rendering fault rather
         * than as a figure the producer did not have. */
        const char *label = jstr(e, "label");
        const char *value = jstr(e, "value");
        if (!label[0] || !value[0]) continue;

        news_figure_t *f = &v->figures[v->figure_count++];
        memset(f, 0, sizeof(*f));
        /* The group is copied verbatim rather than through the prose path:
         * consecutive figures sharing a group print one head between them, so
         * the grouping is a byte comparison, and a transform that could alter
         * one of the two strings and not the other belongs nowhere near it. */
        news_str_copy(f->group, sizeof(f->group), jstr(e, "group"));
        news_str_copy_prose(f->label, sizeof(f->label), label);
        news_str_copy_prose(f->value, sizeof(f->value), value);

        /* `has_chg` rather than "chg_bp != 0": zero is a real change and prints
         * as a flat mark, and most figures — a share count, a listing date —
         * have none at all and must print with no mark and no colour. */
        const cJSON *chg = cJSON_GetObjectItemCaseSensitive(e, "change_pct");
        if (cJSON_IsNumber(chg)) {
            f->has_chg = true;
            f->chg_bp  = sround(cJSON_GetNumberValue(chg), 100);
        }

        /* Two tiers, and the quiet one is the default. A JSON true or a non-zero
         * number promotes; absent, false, zero and anything that is not a
         * number at all leave the figure small.
         *
         * Deliberately not a general truthiness test. Emphasis is LOUD — a hero
         * is set several times larger than the rail around it and takes a line
         * to itself — and inventing that out of a producer's type error is the
         * worse of the two failures. A rail that is quieter than the producer
         * meant reads as a rail; a rail with a spurious hero on it reads as a
         * page that got the day wrong. Both forms are accepted because `emph` is
         * a tier in the model and a flag in the prose, and a producer will send
         * whichever of those it read. */
        const cJSON *em = cJSON_GetObjectItemCaseSensitive(e, "emph");
        if (cJSON_IsTrue(em) || (cJSON_IsNumber(em) && sround(cJSON_GetNumberValue(em), 1) != 0)) {
            f->emph = 1;
        }

        /* Where the value sits in a range the PRODUCER chose, 0..1000, and -1
         * when it has none. Normalised off-board for the same reason
         * news_quote_t::spark is: the device has the box but not the units, and
         * a rail that guessed them would draw a confident wrong bar.
         *
         * Absent and the-wrong-type both mean "no bar", which is the default
         * everywhere else in this file. Present but out of range is clamped
         * rather than dropped: a producer that computed 1004 has the right
         * figure and the wrong rounding, and a bar pinned to the end of its
         * track says that better than no bar at all. */
        f->bar = -1;
        const cJSON *bar = cJSON_GetObjectItemCaseSensitive(e, "bar");
        if (cJSON_IsNumber(bar)) {
            int32_t v = sround(cJSON_GetNumberValue(bar), 1);
            if (v < 0)    v = 0;
            if (v > 1000) v = 1000;
            f->bar = (int16_t)v;
        }
    }
}

/* --- the related-news column ---------------------------------------------- */

static void parse_briefs(const cJSON *root, news_t *v)
{
    const cJSON *arr = jarr(root, "briefs");
    if (!arr) return;

    const cJSON *e = NULL;
    cJSON_ArrayForEach(e, arr) {
        if (v->brief_count >= NEWS_BRIEFS_MAX) break;
        if (!cJSON_IsObject(e)) continue;

        /* The text is the item. A date and a kicker over nothing is furniture
         * with no news under it. */
        const char *text = jstr(e, "text");
        if (!text[0]) continue;

        news_brief_t *b = &v->briefs[v->brief_count++];
        memset(b, 0, sizeof(*b));
        news_str_copy(b->date, sizeof(b->date), jstr(e, "date"));
        news_str_copy_prose(b->kicker, sizeof(b->kicker), jstr(e, "kicker"));
        news_str_copy_prose(b->text, sizeof(b->text), text);
    }
}

/* --- the industry table --------------------------------------------------- */

static void parse_peers(const cJSON *root, news_t *v)
{
    const cJSON *arr = jarr(root, "peers");
    if (!arr) return;

    const cJSON *e = NULL;
    cJSON_ArrayForEach(e, arr) {
        if (v->peer_count >= NEWS_PEERS_MAX) break;
        if (!cJSON_IsObject(e)) continue;

        const char *symbol = jstr(e, "symbol");
        if (!symbol[0]) continue;

        news_peer_t *p = &v->peers[v->peer_count++];
        memset(p, 0, sizeof(*p));
        news_str_copy(p->symbol, sizeof(p->symbol), symbol);
        news_str_copy_prose(p->name, sizeof(p->name), jstr(e, "name"));
        news_str_copy_prose(p->per, sizeof(p->per), jstr(e, "per"));
        news_str_copy_prose(p->cap, sizeof(p->cap), jstr(e, "cap"));
        p->last_c     = jscaled(e, "last", 100);
        p->chg_bp     = jscaled(e, "change_pct", 100);
        p->is_subject = jbool(e, "is_subject");
    }
}

/* --- the quarterly statements --------------------------------------------- */

/* One row's numeric plane: the same figures as its printed cells, in the form a
 * chart can scale. Returns true only when the row supplied a full `col_count` of
 * NUMBERS — a plane with a hole in it cannot be drawn, and a bar of zero where a
 * cell was missing is a lie rather than an absence.
 *
 * Read at the same absolute index as the printed cell it belongs to, and never
 * beyond `col_count`: the two planes are parallel, and an `n` that arrived one
 * short would otherwise shift every bar by a quarter — a chart of plausible
 * columns that are all filed under the wrong dates. */
static bool parse_row_numbers(const cJSON *r, news_table_t *t, int row)
{
    const cJSON *nums = jarr(r, "n");
    if (!nums) return false;
    if (cJSON_GetArraySize(nums) < t->col_count) return false;

    for (int c = 0; c < t->col_count && c < NEWS_TABLE_COLS; c++) {
        const cJSON *x = cJSON_GetArrayItem(nums, c);
        if (!cJSON_IsNumber(x)) return false;
        /* A bare integer in whatever unit `note` names — dollars, millions,
         * units shipped — except the line row of a BARS_LINE table, which is
         * basis points because every percentage that crosses this wire is. The
         * device never divides, so the producer's unit is the chart's unit. */
        t->n[row][c] = sround(cJSON_GetNumberValue(x), 1);
    }
    return true;
}

static void parse_table(const cJSON *e, news_table_t *t)
{
    news_str_copy_prose(t->title, sizeof(t->title), jstr(e, "title"));
    news_str_copy_prose(t->note, sizeof(t->note), jstr(e, "note"));

    /* Kept exactly as the producer sent it even when nothing arrived to draw
     * with. That is not laxity: `render` is the producer's statement about what
     * this table IS — an argument or a record — and `has_n` is a fact about what
     * turned up. Overwriting the first with the second would erase the only
     * evidence that a drawn table went undrawn, which is precisely what a desk
     * looking at a grid it expected to be bars needs to see. The device reads
     * both and falls back; --validate reports the pair. */
    t->render = news_table_render_from(jstr(e, "render"));

    const cJSON *cols = jarr(e, "columns");
    if (cols) {
        const cJSON *c = NULL;
        cJSON_ArrayForEach(c, cols) {
            if (t->col_count >= NEWS_TABLE_COLS) break;
            /* A head that is not a string still SPENDS its column, exactly as
             * a cell that is not a string does below, and for the same reason:
             * a row's values are positional against this header, so dropping
             * the third head would slide the fourth quarter's numbers under the
             * third quarter's date. The column prints with a blank head, which
             * is a visible producer bug; a silently mislabelled column is not. */
            if (cJSON_IsString(c) && c->valuestring) {
                news_str_copy(t->col[t->col_count], sizeof(t->col[0]), c->valuestring);
            }
            t->col_count++;
        }
    }

    const cJSON *rows = jarr(e, "rows");
    if (!rows) return;

    /* A table with no columns has nothing to scale a bar against, so the plane
     * starts out incomplete and only the rows can keep it that way. */
    bool plane = t->col_count > 0;

    const cJSON *r = NULL;
    cJSON_ArrayForEach(r, rows) {
        if (t->row_count >= NEWS_TABLE_ROWS) break;
        if (!cJSON_IsObject(r)) continue;

        const char *label = jstr(r, "label");
        const cJSON *vals = jarr(r, "values");
        const cJSON *nums = jarr(r, "n");

        /* An object with neither a name nor a number in it is a blank line
         * ruled across the table, which is the one thing a printed statement
         * never has. Everything else is kept: a row of figures under no label
         * is a producer bug that is visible on the sheet, and a visible bug is
         * a fixable one. `n` counts as a number for this test — a row that
         * carries only the drawable plane is a series with no legend, which is
         * the same visible bug and not a blank line. */
        if (!label[0] && (!vals || cJSON_GetArraySize(vals) == 0)
                      && (!nums || cJSON_GetArraySize(nums) == 0)) continue;

        int row = t->row_count++;
        memset(&t->row[row], 0, sizeof(t->row[row]));
        news_str_copy_prose(t->row[row].label, sizeof(t->row[row].label), label);

        /* Every row that survives has to carry its own full plane, because a
         * stack is only a stack when every segment of every column arrived and
         * a line is only a line when it has a point over every bar. One row
         * short and the whole table prints instead. */
        if (!parse_row_numbers(r, t, row)) plane = false;

        /* The counter advances on a cell that is not a string as well as on one
         * that is. The values are positional — column three of the row is the
         * quarter in column three of the header — so skipping a bad cell rather
         * than spending its column would slide the rest of the row one quarter
         * to the left, which prints as a table of plausible numbers filed under
         * the wrong dates.
         *
         * A row shorter than the header leaves its tail empty and the page sets
         * an em dash there. A longer one is truncated: there is no seventh
         * column to print a seventh value in. */
        if (!vals) continue;
        int col = 0;
        const cJSON *x = NULL;
        cJSON_ArrayForEach(x, vals) {
            if (col >= NEWS_TABLE_COLS) break;
            if (cJSON_IsString(x) && x->valuestring) {
                news_str_copy_prose(t->row[row].v[col], sizeof(t->row[row].v[0]),
                                    x->valuestring);
            }
            col++;
        }
    }

    /* A table with rows but no complete plane is a printed table, and the plane
     * it half-received is erased rather than left lying in the struct. Two
     * reasons, and the second is the one that bites: news_hash() feeds every
     * cell of `n`, so two payloads differing only in numeric junk that nothing
     * draws would fingerprint differently and cost a twenty-five-second refresh
     * for a page that is identical. The first is simply that a half-filled plane
     * is the state a later reader is most likely to trust by accident. */
    t->has_n = plane && t->row_count > 0;
    if (!t->has_n) {
        memset(t->n, 0, sizeof(t->n));
    }
}

static void parse_tables(const cJSON *root, news_t *v)
{
    const cJSON *arr = jarr(root, "tables");
    if (!arr) return;

    const cJSON *e = NULL;
    cJSON_ArrayForEach(e, arr) {
        if (v->table_count >= NEWS_TABLES_MAX) break;
        if (!cJSON_IsObject(e)) continue;
        news_table_t *t = &v->tables[v->table_count++];
        memset(t, 0, sizeof(*t));
        parse_table(e, t);
    }
}

/* --- public --------------------------------------------------------------- */

bool news_parse(const char *json, size_t len, news_t *out)
{
    if (!json || !out || len == 0) return false;

    cJSON *root = cJSON_ParseWithLength(json, len);
    if (!root) return false;                 /* truncated or not JSON at all */
    if (!cJSON_IsObject(root)) {
        cJSON_Delete(root);
        return false;
    }

    news_t *v = (news_t *)calloc(1, sizeof(news_t));
    if (!v) {
        cJSON_Delete(root);
        return false;
    }

    news_str_copy_prose(v->edition,  sizeof(v->edition),  jstr(root, "edition"));
    news_str_copy_prose(v->dateline, sizeof(v->dateline), jstr(root, "dateline"));
    news_str_copy_prose(v->session,  sizeof(v->session),  jstr(root, "session"));
    news_str_copy(v->as_of,        sizeof(v->as_of),        jstr(root, "as_of"));
    news_str_copy(v->generated_at, sizeof(v->generated_at), jstr(root, "generated_at"));

    parse_subject(root, &v->subject);
    parse_charts(root, v);          /* before the stories: a story names one by index */
    parse_stories(root, v);
    parse_figures(root, v);
    parse_briefs(root, v);
    parse_peers(root, v);
    parse_tables(root, v);
    parse_indices(root, v);
    parse_thumbs(root, v);
    parse_policy(root, &v->policy);

    cJSON_Delete(root);

    /* A well-formed object that names no company and carries no story is a
     * rejection, not a quiet day: it is what a login page, a health endpoint or
     * an error envelope looks like after cJSON gets through with it, and
     * replacing a good page with blankness is the one failure the user actually
     * notices.
     *
     * A symbol on its own IS enough. An edition whose research came back thin
     * still has a nameplate, a session line and a price, and printing that at
     * full size is a legitimate quiet-day front page rather than an error
     * state. What is not enough is neither of the two. */
    if (!v->subject.symbol[0] && v->story_count == 0) {
        free(v);
        return false;
    }

    v->valid = true;
    v->demo  = false;
    *out = *v;
    free(v);
    return true;
}
