/*
 * news_model.c — the pure helpers declared in news_model.h.
 *
 * No LVGL, no ESP-IDF, no allocation. Everything here is exercised directly by
 * test_news_parse.c and indirectly by every band of the page.
 */
#include "news_model.h"

#include <string.h>

/* --- UTF-8-safe copy ------------------------------------------------------ */

/* Length in bytes of the UTF-8 sequence that starts with `c`, or 1 for a byte
 * that cannot start one (a stray continuation byte, or 0xF8..0xFF). Treating
 * junk as width 1 makes truncation degrade to a byte copy for invalid input
 * rather than looping or over-reading. */
static size_t seq_len(unsigned char c)
{
    if (c < 0x80) return 1;
    if ((c & 0xE0) == 0xC0) return 2;
    if ((c & 0xF0) == 0xE0) return 3;
    if ((c & 0xF8) == 0xF0) return 4;
    return 1;
}

size_t news_str_copy(char *dst, size_t dst_size, const char *src)
{
    if (!dst || dst_size == 0) return 0;
    if (!src) { dst[0] = '\0'; return 0; }

    size_t out = 0;
    size_t i = 0;
    for (;;) {
        unsigned char c = (unsigned char)src[i];
        if (c == '\0') break;

        size_t n = seq_len(c);
        /* A sequence the source truncates is dropped whole: copying its first
         * two bytes would hand LVGL's decoder a codepoint that is not there. */
        for (size_t k = 1; k < n; k++) {
            if (src[i + k] == '\0') { n = 0; break; }
        }
        if (n == 0) break;

        if (out + n >= dst_size) break;      /* no room for this glyph + NUL */
        memcpy(dst + out, src + i, n);
        out += n;
        i   += n;
    }
    dst[out] = '\0';
    return out;
}

/* --- prose ----------------------------------------------------------------
 *
 * The same copy, with the typewriter apostrophe promoted to the typographic
 * one. At 56 px in a lead headline a straight U+0027 is a vertical tick between
 * the a and the s, and it is the single detail that makes an otherwise typeset
 * page read as a mock-up rather than as a proof. Every face on the board
 * already carries U+2019 — it is in S_DATA_PUNCT, which is what the generator
 * subsets against — so nothing is missing but the character.
 *
 * It is done HERE, at the parser's copy, and not in the copy desk: headlines
 * arrive over the network from an agent that will send ASCII, and asking every
 * producer to remember is asking for a page that is right on the demo snapshot
 * and wrong on the day it matters.
 *
 * Only BETWEEN two letters. That is the contraction and the possessive, which
 * is all a news page has; a quotation mark opening a phrase is ambiguous
 * without more context than a byte-wise copy has, so it is left exactly as it
 * came. Applied only to prose fields — a symbol, a tile id and a timestamp are
 * identifiers and are copied verbatim.
 *
 * The character is three bytes where the source spent one, so a field can now
 * clamp a glyph or two earlier than it would have. That is the same clamp
 * news_str_copy() already applies to the em dashes and the accented names the
 * wire is full of, on the same boundary, and it is why this shares that loop
 * rather than post-processing its output in place. */
static bool is_letter(unsigned char c)
{
    return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z');
}

size_t news_str_copy_prose(char *dst, size_t dst_size, const char *src)
{
    if (!dst || dst_size == 0) return 0;
    if (!src) { dst[0] = '\0'; return 0; }

    static const char RSQUO[3] = { (char)0xE2, (char)0x80, (char)0x99 };

    size_t out = 0, i = 0;
    for (;;) {
        unsigned char c = (unsigned char)src[i];
        if (c == '\0') break;

        const char *seq = src + i;
        size_t n = seq_len(c);

        if (c == '\'' && i > 0 && is_letter((unsigned char)src[i - 1])
            && is_letter((unsigned char)src[i + 1])) {
            seq = RSQUO;
            n   = 3;
            if (out + n >= dst_size) break;
            memcpy(dst + out, seq, n);
            out += n;
            i   += 1;
            continue;
        }

        for (size_t k = 1; k < n; k++) {
            if (src[i + k] == '\0') { n = 0; break; }
        }
        if (n == 0) break;

        if (out + n >= dst_size) break;
        memcpy(dst + out, seq, n);
        out += n;
        i   += n;
    }
    dst[out] = '\0';
    return out;
}

/* --- chart kind ----------------------------------------------------------- */

/* Case-insensitive ASCII compare; the wire uses lowercase but a hand-written
 * producer will send "Candle" sooner or later. */
static bool ieq(const char *a, const char *b)
{
    while (*a && *b) {
        char ca = *a++, cb = *b++;
        if (ca >= 'A' && ca <= 'Z') ca = (char)(ca - 'A' + 'a');
        if (cb >= 'A' && cb <= 'Z') cb = (char)(cb - 'A' + 'a');
        if (ca != cb) return false;
    }
    return *a == '\0' && *b == '\0';
}

chart_kind_t news_chart_kind_from(const char *word)
{
    if (!word) return CHART_NONE;
    if (ieq(word, "line"))   return CHART_LINE;
    if (ieq(word, "candle")) return CHART_CANDLE;
    if (ieq(word, "bar"))    return CHART_BAR;
    return CHART_NONE;
}

/* --- fingerprint ---------------------------------------------------------- */

/* FNV-1a. Fed field by field rather than over the struct: struct padding is
 * never initialised, so hashing the raw bytes would make the fingerprint depend
 * on whatever was on the stack — and the whole point is that identical content
 * must hash identically, every boot, on device and in the simulator. Only the
 * populated prefix of each array is fed, for the same reason. */
#define FNV_OFFSET 2166136261u
#define FNV_PRIME  16777619u

static void h_bytes(uint32_t *h, const void *p, size_t n)
{
    const unsigned char *b = (const unsigned char *)p;
    for (size_t i = 0; i < n; i++) {
        *h ^= b[i];
        *h *= FNV_PRIME;
    }
}

static void h_str(uint32_t *h, const char *s)
{
    h_bytes(h, s, strlen(s));
    h_bytes(h, "\0", 1);        /* separator: "ab"+"c" must differ from "a"+"bc" */
}

static void h_int(uint32_t *h, int32_t v)
{
    h_bytes(h, &v, sizeof(v));
}

/* A quote is the same three lines wherever it appears, so the ribbon and the
 * ticker table feed the hash through one function rather than two that can
 * drift apart. The sparkline is in it: it is 48x14 pixels of ink and it moves
 * every session. */
static void h_quote(uint32_t *h, const news_quote_t *q)
{
    h_str(h, q->symbol);
    h_str(h, q->name);
    h_int(h, q->last_c);
    h_int(h, q->chg_bp);
    h_int(h, q->spark_n);
    for (int i = 0; i < q->spark_n && i < NEWS_SPARK_MAX; i++) h_int(h, q->spark[i]);
}

static void h_chart(uint32_t *h, const news_chart_t *c)
{
    h_int(h, (int32_t)c->kind);
    h_str(h, c->span);
    h_int(h, c->n);
    for (int i = 0; i < c->n && i < NEWS_BARS_MAX; i++) {
        h_int(h, c->o[i]);
        h_int(h, c->h[i]);
        h_int(h, c->l[i]);
        h_int(h, c->c[i]);
    }
}

uint32_t news_hash(const news_t *v)
{
    uint32_t h = FNV_OFFSET;
    if (!v) return h;

    h_int(&h, v->valid);
    h_int(&h, v->demo);
    h_str(&h, v->edition);
    h_str(&h, v->dateline);
    h_str(&h, v->session);
    h_str(&h, v->as_of);
    h_str(&h, v->generated_at);

    h_int(&h, v->index_count);
    for (int i = 0; i < v->index_count && i < NEWS_INDEX_MAX; i++) {
        h_quote(&h, &v->indices[i]);
    }

    h_int(&h, v->story_count);
    for (int i = 0; i < v->story_count && i < NEWS_STORIES_MAX; i++) {
        const news_story_t *s = &v->stories[i];
        h_int(&h, s->rank);
        h_str(&h, s->kicker);
        h_str(&h, s->headline);
        h_str(&h, s->deck);
        h_str(&h, s->byline);
        h_str(&h, s->body);
        h_str(&h, s->symbol);
        h_int(&h, s->last_c);
        h_int(&h, s->chg_bp);
        h_chart(&h, &s->chart);
        /* The photo id addresses a tile the device caches; two snapshots that
         * differ only in which photograph the lead carries must not agree. */
        h_str(&h, s->photo.id);
        h_int(&h, s->photo.w);
        h_int(&h, s->photo.h);
        h_str(&h, s->photo.caption);
        h_str(&h, s->photo.credit);
    }

    h_int(&h, v->ticker_count);
    for (int i = 0; i < v->ticker_count && i < NEWS_TICKERS_MAX; i++) {
        h_quote(&h, &v->tickers[i]);
    }

    return h;
}
