/*
 * news_model.c — the pure helpers declared in news_model.h.
 *
 * No LVGL, no ESP-IDF, no allocation. Everything here is exercised directly by
 * test_news_parse.c and indirectly by every band of the page.
 */
#include "news_model.h"

#include <string.h>

/* --- how big this thing is, asserted rather than remembered ---------------
 *
 * sizeof(news_t) is quoted as a fact in CLAUDE.md, in user_app.cpp's comments
 * and in the design spec, and every one of those copies has at some point been
 * a number somebody typed. It is load-bearing: three whole snapshots are
 * file-scope statics in user_app.cpp precisely because this is three times
 * UiTask's 8 KB stack, and a snapshot on a frame is an instant overflow.
 *
 * So it is measured here, once, and the build breaks when it moves. That is the
 * point of the assert rather than a defect in it: a capacity that grew wants
 * the four places that quote the old number brought with it.
 *
 * One number serves the host tests, the simulator and the firmware because the
 * layout is the same on x86-64 and on Xtensa. That used to hold for a simple
 * reason — every member was four bytes or narrower, so nothing could be aligned
 * differently — and news_policy_t::next_change ends it: an int64_t wants eight,
 * on both, which is why it sits last in the struct with its four bytes of tail
 * padding rather than in the middle of a run of counts. The claim is now a
 * measurement on each target rather than an argument from the member types, and
 * this assert is what takes it: the firmware build fails here if Xtensa ever
 * disagrees with the host. */
_Static_assert(sizeof(news_t) == 32952,
               "sizeof(news_t) moved. Measure it, then update the figure in "
               "CLAUDE.md, in user_app.cpp and in the design spec — they all "
               "quote it, and they are all wrong now.");

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

/* --- table render --------------------------------------------------------- */

/* Unknown is TABLE_PRINT, and that is the same argument news_chart_kind_from()
 * makes one function up: a table drawn with the wrong geometry is worse than one
 * that was only printed, and printing it is never wrong. A producer that invents
 * a fourth word gets a grid of numbers — every cell it sent, correctly labelled —
 * rather than a picture of a shape nobody chose.
 *
 * "bars+line" is accepted beside "bars_line" because the underscore is a
 * transcription of a name that is naturally written with a plus, and a producer
 * that types the obvious thing should not silently lose its chart. */
table_render_t news_table_render_from(const char *word)
{
    if (!word) return TABLE_PRINT;
    if (ieq(word, "stack"))     return TABLE_STACK;
    if (ieq(word, "bars_line")) return TABLE_BARS_LINE;
    if (ieq(word, "bars+line")) return TABLE_BARS_LINE;
    return TABLE_PRINT;
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

/* A quote is the same three lines wherever it appears, so the ribbon and A2's
 * copy of it feed the hash through one function rather than two that can drift
 * apart. The sparkline is in it: it is 48x14 pixels of ink and it moves every
 * session. */
static void h_quote(uint32_t *h, const news_quote_t *q)
{
    h_str(h, q->symbol);
    h_str(h, q->name);
    h_int(h, q->last_c);
    h_int(h, q->chg_bp);
    h_int(h, q->spark_n);
    for (int i = 0; i < q->spark_n && i < NEWS_SPARK_MAX; i++) h_int(h, q->spark[i]);
}

/* The id addresses a tile the device caches, so two snapshots that differ only
 * in which photograph the lead carries must not agree. The dimensions are in
 * here for the same reason and for a second one: the compositor asks a picture
 * how tall it wants to be at a given width, so a tile that changed shape
 * changes the whole page under it. */
static void h_photo(uint32_t *h, const news_photo_t *p)
{
    h_str(h, p->id);
    h_int(h, p->w);
    h_int(h, p->h);
    h_str(h, p->caption);
    h_str(h, p->credit);
}

static void h_chart(uint32_t *h, const news_chart_t *c)
{
    h_int(h, (int32_t)c->kind);
    h_str(h, c->label);
    h_str(h, c->span);
    h_str(h, c->note);
    h_int(h, c->n);
    for (int i = 0; i < c->n && i < NEWS_BARS_MAX; i++) {
        h_int(h, c->o[i]);
        h_int(h, c->h[i]);
        h_int(h, c->l[i]);
        h_int(h, c->c[i]);
    }
}

static void h_table(uint32_t *h, const news_table_t *t)
{
    h_str(h, t->title);
    h_str(h, t->note);
    h_int(h, t->col_count);
    for (int c = 0; c < t->col_count && c < NEWS_TABLE_COLS; c++) h_str(h, t->col[c]);
    h_int(h, t->row_count);
    for (int r = 0; r < t->row_count && r < NEWS_TABLE_ROWS; r++) {
        h_str(h, t->row[r].label);
        /* Every declared column, not every filled one: a row whose tail went
         * empty prints em dashes there, and a row that gained a cell where an
         * em dash was is a different table. */
        for (int c = 0; c < t->col_count && c < NEWS_TABLE_COLS; c++) {
            h_str(h, t->row[r].v[c]);
        }
    }

    /* `render` and `has_n` decide whether this table reaches the glass as a grid
     * of numbers or as a picture, which is the largest single difference two
     * payloads can make to A2 without changing a character of their text. A
     * table that stopped being drawable — the producer dropped one cell of one
     * numeric row — falls back to printing, and a hash that missed that would
     * leave the drawn version on the panel forever. */
    h_int(h, (int32_t)t->render);
    h_int(h, t->has_n);

    /* The numeric plane over the same declared rectangle the text plane uses.
     * `n` is the geometry of every bar and every point of the line; the printed
     * cell beside it is the label. Two payloads whose bars move but whose
     * rounded strings do not — 9,340 against 9,344, both printed "9,340" when
     * the day's make-up gives the table a narrow column — are two different
     * pictures, so this is fed independently of `v` rather than assumed to
     * follow it. The parser zeroes the plane whenever `has_n` is false, so an
     * undrawn table hashes the same however much numeric junk arrived with it. */
    for (int r = 0; r < t->row_count && r < NEWS_TABLE_ROWS; r++) {
        for (int c = 0; c < t->col_count && c < NEWS_TABLE_COLS; c++) {
            h_int(h, t->n[r][c]);
        }
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

    /* The subject is the whole edition, and every field of it is either printed
     * in the nameplate or measured against another one — the last against the
     * session's range, the range against the 52-week bounds. */
    h_str(&h, v->subject.symbol);
    h_str(&h, v->subject.name);
    h_str(&h, v->subject.exchange);
    h_str(&h, v->subject.sector);
    h_int(&h, v->subject.last_c);
    h_int(&h, v->subject.chg_bp);
    h_int(&h, v->subject.prev_close_c);
    h_int(&h, v->subject.open_c);
    h_int(&h, v->subject.high_c);
    h_int(&h, v->subject.low_c);
    h_int(&h, v->subject.wk52_hi_c);
    h_int(&h, v->subject.wk52_lo_c);

    /* Each count is fed before its array, and that is not belt-and-braces. The
     * compositor reads how many briefs and how many peers arrived before it
     * decides whether those modules go on the sheet at all, so two payloads
     * that differ only in a count lay out differently even when every string
     * they share is identical. Feeding the count also separates "three items"
     * from "two items, the second of which is empty". */
    h_int(&h, v->story_count);
    for (int i = 0; i < v->story_count && i < NEWS_STORIES_MAX; i++) {
        const news_story_t *s = &v->stories[i];
        h_int(&h, s->rank);
        h_str(&h, s->kicker);
        h_str(&h, s->headline);
        h_str(&h, s->deck);
        h_str(&h, s->byline);
        h_str(&h, s->body);
        h_int(&h, s->chart);
        h_photo(&h, &s->photo);
    }

    h_int(&h, v->figure_count);
    for (int i = 0; i < v->figure_count && i < NEWS_FIGURES_MAX; i++) {
        const news_figure_t *f = &v->figures[i];
        h_str(&h, f->group);
        h_str(&h, f->label);
        h_str(&h, f->value);
        h_int(&h, f->has_chg);
        h_int(&h, f->chg_bp);
        /* Which tier a figure is set in, and how long its bar is. Neither
         * changes a character of the rail's text and both change most of its
         * ink: a figure promoted to a hero is set several times larger and takes
         * a whole line to itself, which moves everything under it. */
        h_int(&h, f->emph);
        h_int(&h, f->bar);
    }

    h_int(&h, v->brief_count);
    for (int i = 0; i < v->brief_count && i < NEWS_BRIEFS_MAX; i++) {
        h_str(&h, v->briefs[i].date);
        h_str(&h, v->briefs[i].kicker);
        h_str(&h, v->briefs[i].text);
    }

    h_int(&h, v->peer_count);
    for (int i = 0; i < v->peer_count && i < NEWS_PEERS_MAX; i++) {
        const news_peer_t *p = &v->peers[i];
        h_str(&h, p->symbol);
        h_str(&h, p->name);
        h_str(&h, p->per);
        h_str(&h, p->cap);
        h_int(&h, p->last_c);
        h_int(&h, p->chg_bp);
        h_int(&h, p->is_subject);
    }

    h_int(&h, v->table_count);
    for (int i = 0; i < v->table_count && i < NEWS_TABLES_MAX; i++) {
        h_table(&h, &v->tables[i]);
    }

    h_int(&h, v->chart_count);
    for (int i = 0; i < v->chart_count && i < NEWS_CHARTS_MAX; i++) {
        h_chart(&h, &v->charts[i]);
    }

    h_int(&h, v->index_count);
    for (int i = 0; i < v->index_count && i < NEWS_INDEX_MAX; i++) {
        h_quote(&h, &v->indices[i]);
    }

    h_int(&h, v->thumb_count);
    for (int i = 0; i < v->thumb_count && i < NEWS_THUMBS_MAX; i++) {
        h_photo(&h, &v->thumbs[i]);
    }

    /* `policy` IS DELIBERATELY NOT IN HERE, AND IT MUST STAY OUT.
     *
     * This is an omission, and an omission is invisible: everything else on this
     * wire is fed to the hash, so the next reader to audit this function against
     * news_model.h will find one member missing and be right to wonder. So it is
     * written down.
     *
     * The rule this function implements is "two snapshots with the same
     * fingerprint produce the same pixels". The policy produces NO pixels. It is
     * the server saying when to ask again, and `next_change` moves at every
     * transition of the server's schedule — several times a day, every day,
     * forever. Fingerprinted, it would notify UiTask each time, and UiTask would
     * spend twenty-five seconds flashing the whole sheet to report that a
     * timestamp advanced. That is the exact failure this function exists to
     * prevent, arriving through the one field that was added to prevent it.
     *
     * The comparison it must not break is in NewsTask: hash the fetch, compare,
     * and touch the panel only when they differ. Adding `policy` here would not
     * fail a test that reads like a policy test — it would show up as a board
     * that repaints on a timer, weeks later, with nothing in the log to say why.
     * test_policy_is_not_fingerprinted() in test_news_parse.c is the guard. */

    return h;
}
