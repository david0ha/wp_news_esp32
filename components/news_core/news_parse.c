/*
 * news_parse.c — the wire payload -> news_t.
 *
 * The producer is an agent running on somebody's machine. It will send a string
 * where a number belongs, a null where a headline belongs, an empty array, a
 * 900-entry array, a chart with no bars, a photo id with no dimensions, and —
 * the day the machine sleeps — half a response. None of that may take the board
 * down, and none of it may leave a half-typeset page on the glass.
 *
 * So: parse into a scratch snapshot, validate and clamp every field, and only
 * copy into the caller's struct on success. A rejected payload leaves the
 * previous front page exactly as it was, which is why the folio can honestly
 * badge it STALE rather than going blank.
 *
 * The scratch is on the heap because news_t is ~18 KB and NewsTask's stack is
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
 * "unranked sinks to the bottom" default (NEWS_STORIES_MAX) meaningful. */
#define RANK_MAX 99

/* --- defensive accessors --------------------------------------------------
 * Every one of these takes "the key is missing" and "the key holds the wrong
 * type" to the same place: the default. That is the entire error policy for
 * individual fields, and it is why the field code below has no branches. */

/* Round-half-away-from-zero into a scaled integer: dollars to cents, percent to
 * basis points, and any bare number the model stores as an int. Every number
 * that crosses from JSON's double into the model goes through here, so 183.22
 * becomes 18322 on x86 and on Xtensa alike — truncating instead would let a
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

/* --- quotes: the index ribbon and the ticker table ------------------------ */

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

static void parse_quote(const cJSON *e, news_quote_t *q)
{
    memset(q, 0, sizeof(*q));
    news_str_copy(q->symbol, sizeof(q->symbol), jstr(e, "symbol"));
    news_str_copy_prose(q->name, sizeof(q->name), jstr(e, "name"));
    q->last_c = jscaled(e, "last", 100);
    q->chg_bp = jscaled(e, "change_pct", 100);
    parse_spark(jarr(e, "spark"), q);
}

/* Both quote lists have the same shape and the same failure: an entry with no
 * symbol is a blank cell with a number beside it, which reads as a rendering
 * bug rather than as missing data. */
static void parse_quotes(const cJSON *root, const char *key,
                         news_quote_t *dst, int cap, int *count)
{
    const cJSON *arr = jarr(root, key);
    if (!arr) return;
    const cJSON *e = NULL;
    cJSON_ArrayForEach(e, arr) {
        if (*count >= cap) break;
        if (!cJSON_IsObject(e)) continue;
        if (!jstr(e, "symbol")[0]) continue;
        parse_quote(e, &dst[(*count)++]);
    }
}

/* --- charts --------------------------------------------------------------- */

static void parse_chart(const cJSON *story, news_chart_t *ch)
{
    const cJSON *c = jobj(story, "chart");
    if (!c) return;

    ch->kind = news_chart_kind_from(jstr(c, "kind"));
    if (ch->kind == CHART_NONE) return;
    news_str_copy(ch->span, sizeof(ch->span), jstr(c, "span"));

    const cJSON *bars = jarr(c, "bars");
    if (bars) {
        int total = cJSON_GetArraySize(bars);
        int n     = total > NEWS_BARS_MAX ? NEWS_BARS_MAX : total;
        int skip  = total - n;          /* a month of candles, most recent kept */
        for (int i = 0; i < n; i++) {
            const cJSON *b = cJSON_GetArrayItem(bars, skip + i);
            int32_t v[4];
            if (cJSON_IsNumber(b)) {
                /* The flat form a line chart may use: one close per point, and
                 * open/high/low set to match so nothing reads a bar that spans
                 * the whole scale out of a series that never had one. */
                v[0] = v[1] = v[2] = v[3] = sround(cJSON_GetNumberValue(b), 100);
            } else if (cJSON_IsArray(b) && cJSON_GetArraySize(b) >= 4) {
                bool ok = true;
                for (int k = 0; k < 4; k++) {
                    const cJSON *x = cJSON_GetArrayItem(b, k);
                    if (!cJSON_IsNumber(x)) { ok = false; break; }
                    v[k] = sround(cJSON_GetNumberValue(x), 100);
                }
                if (!ok) continue;      /* a bar with a hole in it is not a bar */
            } else {
                continue;
            }
            ch->o[ch->n] = v[0];
            ch->h[ch->n] = v[1];
            ch->l[ch->n] = v[2];
            ch->c[ch->n] = v[3];
            ch->n++;
        }
    }

    /* A kind with no bars would reserve its slot and draw an empty box. The
     * story reflows without it instead, which is a normal front-page condition. */
    if (ch->n == 0) {
        memset(ch, 0, sizeof(*ch));
    }
}

/* --- photos --------------------------------------------------------------- */

static void parse_photo(const cJSON *story, news_photo_t *p)
{
    const cJSON *ph = jobj(story, "photo");
    if (!ph) return;

    news_str_copy(p->id, sizeof(p->id), jstr(ph, "id"));
    p->w = jrange(ph, "w", 0, PHOTO_W_MAX, 0);
    p->h = jrange(ph, "h", 0, PHOTO_H_MAX, 0);
    news_str_copy_prose(p->caption, sizeof(p->caption), jstr(ph, "caption"));
    news_str_copy_prose(p->credit, sizeof(p->credit), jstr(ph, "credit"));

    /* The id is a URL and the dimensions are the byte count; one without the
     * other cannot be fetched, and a caption under a slot that stayed empty is
     * worse than no caption. `id[0] == '\0'` is the model's single test for
     * "no photo", so make it true here rather than at four call sites. */
    if (!p->id[0] || p->w <= 0 || p->h <= 0) {
        memset(p, 0, sizeof(*p));
    }
}

/* --- stories -------------------------------------------------------------- */

static bool parse_story(const cJSON *e, news_story_t *s)
{
    /* Checked before anything is written: `s` may still hold a story we are
     * about to decide is better than this one. */
    const char *headline = jstr(e, "headline");
    if (!headline[0]) return false;

    memset(s, 0, sizeof(*s));
    s->rank = jrange(e, "rank", 0, RANK_MAX, NEWS_STORIES_MAX);
    news_str_copy_prose(s->kicker,   sizeof(s->kicker),   jstr(e, "kicker"));
    news_str_copy_prose(s->headline, sizeof(s->headline), headline);
    news_str_copy_prose(s->deck,     sizeof(s->deck),     jstr(e, "deck"));
    news_str_copy_prose(s->byline,   sizeof(s->byline),   jstr(e, "byline"));
    news_str_copy_prose(s->body,     sizeof(s->body),     jstr(e, "body"));
    news_str_copy(s->symbol,   sizeof(s->symbol),   jstr(e, "symbol"));
    s->last_c = jscaled(e, "last", 100);
    s->chg_bp = jscaled(e, "change_pct", 100);
    parse_chart(e, &s->chart);
    parse_photo(e, &s->photo);
    return true;
}

/* Swapped byte by byte: a news_story_t is 2.7 KB, and the usual `tmp = a[i]`
 * insertion sort would put a sixth of NewsTask's stack on the frame to save
 * fifteen comparisons. */
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
         * Keep the six lowest ranks instead; the rank is read before the story
         * is parsed so that a rejected candidate costs nothing. */
        int slot = v->story_count;
        if (slot >= NEWS_STORIES_MAX) {
            int rank  = jrange(e, "rank", 0, RANK_MAX, NEWS_STORIES_MAX);
            int worst = 0;
            for (int i = 1; i < v->story_count; i++) {
                if (v->stories[i].rank > v->stories[worst].rank) worst = i;
            }
            if (rank >= v->stories[worst].rank) continue;
            slot = worst;
        }

        if (!parse_story(e, &v->stories[slot])) continue;
        if (slot == v->story_count) v->story_count++;
    }

    /* Insertion sort by adjacent swaps: stable, so equal ranks keep the
     * producer's order, and the tier assignment downstream is then a straight
     * index — rank 0 is stories[0] and the secondary row is 1..3. */
    for (int i = 1; i < v->story_count; i++) {
        for (int j = i; j > 0 && v->stories[j].rank < v->stories[j - 1].rank; j--) {
            swap_stories(&v->stories[j], &v->stories[j - 1]);
        }
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

    news_str_copy_prose(v->edition,  sizeof(v->edition),      jstr(root, "edition"));
    news_str_copy_prose(v->dateline, sizeof(v->dateline),     jstr(root, "dateline"));
    news_str_copy_prose(v->session,  sizeof(v->session),      jstr(root, "session"));
    news_str_copy(v->as_of,        sizeof(v->as_of),        jstr(root, "as_of"));
    news_str_copy(v->generated_at, sizeof(v->generated_at), jstr(root, "generated_at"));

    parse_quotes(root, "indices", v->indices, NEWS_INDEX_MAX,   &v->index_count);
    parse_quotes(root, "tickers", v->tickers, NEWS_TICKERS_MAX, &v->ticker_count);
    parse_stories(root, v);

    cJSON_Delete(root);

    /* A well-formed object that carries no page at all is a rejection, not an
     * empty front page: it is what a login page, a health endpoint or an error
     * envelope looks like after cJSON gets through with it, and replacing a
     * good page with blankness is the one failure the user actually notices. */
    if (v->story_count == 0 && v->ticker_count == 0 && v->index_count == 0) {
        free(v);
        return false;
    }

    v->valid = true;
    v->demo  = false;
    *out = *v;
    free(v);
    return true;
}
