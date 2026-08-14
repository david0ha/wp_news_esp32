/*
 * ui_fit.c — the copyfit engine declared in ui_fit.h.
 *
 * The whole file is a binary search around one measurement, and the search is
 * not an optimisation for its own sake. The lead's body is 1400 bytes, the page
 * sets it into more than one column, and measuring a growing prefix a character
 * at a time is fourteen hundred trips through LVGL's line breaker per column on
 * a 240 MHz Xtensa. Eleven trips buy the same answer, because the height of a
 * prefix is monotone: greedy line breaking never un-breaks a line once the text
 * before it has forced one, so appending bytes can hold the line count or raise
 * it and can never lower it.
 *
 * That same monotonicity is what keeps the sentence-boundary rule at the foot
 * of the file down to two more measurements rather than one per candidate.
 *
 * No LVGL widgets, no allocation, no state. The only thing this borrows from
 * LVGL is the measurement, and ui_fit.h says what that costs.
 */
#include "ui_fit.h"

#include <stdbool.h>
#include <string.h>

/* --- the alphabet of a cut ------------------------------------------------ */

/* What separates two words in copy that came off a wire. LVGL will also BREAK a
 * line at ",.;:-_)]}" (LV_TXT_BREAK_CHARS), but a break is not a cut: ending a
 * column after a comma leaves a line that trails off into the gutter and reads
 * as a dropped clause. Only whitespace ends a column here. */
static bool is_space(char c)
{
    return c == ' ' || c == '\t' || c == '\n' || c == '\r';
}

static bool is_cont(char c)
{
    return ((unsigned char)c & 0xC0) == 0x80;
}

/* The largest UTF-8 character boundary at or below `i`. Every candidate cut goes
 * through here. Half of an en dash is not a shorter story: it is a tofu box on
 * the glass, or LVGL's decoder reading past the NUL looking for the rest of a
 * sequence that the cut threw away. */
static size_t char_floor(const char *s, size_t i)
{
    while (i > 0 && is_cont(s[i])) i--;
    return i;
}

/* --- the measurement ------------------------------------------------------ */

/* How tall do the first `len` bytes of `buf` set, wrapped to `w`?
 *
 * The NUL goes into the caller's own buffer and comes straight back out. `buf`
 * already holds the copy that is going to be returned, so a measurement needs no
 * scratch at all — which on a task stack facing a 1400-byte story is the
 * difference between this being free and it being an allocation per column.
 *
 * Height alone is ever asked for. LVGL forces LV_TEXT_FLAG_BREAK_ALL on the
 * first word of every line, so a word too long for the measure is hard-broken
 * rather than allowed to overhang, and nothing it lays out is ever wider than
 * the box. The width it REPORTS is another matter: it includes the spaces
 * skipped at each wrap, so it runs a few pixels over for ordinary copy, and
 * testing it would reject text that sets perfectly. */
static int32_t text_h(const lv_font_t *font, int w, int line_space,
                      char *buf, size_t len)
{
    lv_point_t sz;
    char save = buf[len];

    buf[len] = '\0';
    lv_text_get_size(&sz, buf, font, 0, (int32_t)line_space, (int32_t)w,
                     LV_TEXT_FLAG_NONE);
    buf[len] = save;

    return sz.y;
}

/* Do the first `len` bytes of `buf` set inside w x h? */
static bool fits(const lv_font_t *font, int w, int h, int line_space,
                 char *buf, size_t len)
{
    return text_h(font, w, line_space, buf, len) <= (int32_t)h;
}

/* --- sentence ends -------------------------------------------------------- */

/* The bytes of a closing quotation mark or bracket ending at `j`, or 0. The full
 * stop of a quoted sentence lives inside the quotation that closes it — `...he
 * said."` — so the terminator is not always the last byte before the cut. U+2019
 * and U+201D are the curly pair; the wire copy desk emits them as a matter of
 * course and every text face carries them. */
static size_t closer_before(const char *s, size_t j)
{
    if (j == 0) return 0;

    char c = s[j - 1];
    if (c == '"' || c == '\'' || c == ')' || c == ']') return 1;

    if (j >= 3 && (unsigned char)s[j - 3] == 0xE2 && (unsigned char)s[j - 2] == 0x80 &&
        ((unsigned char)s[j - 1] == 0x99 || (unsigned char)s[j - 1] == 0x9D)) return 3;

    return 0;
}

static bool is_alpha(char c)
{
    return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z');
}

/* Does a sentence end immediately before `k`? A terminator, then any closing
 * marks, then whitespace or the end of the string.
 *
 * The one false positive worth spending code on is the dotted initialism —
 * U.S., a.m., e.g. — which market copy is full of and which would otherwise stop
 * a column a clause early, several times a page. "Mr." and "Inc." still get
 * through, and that is deliberate rather than unfinished: the damage is a column
 * that ends on a full stop one word before the one it would have ended on, which
 * is what the whole rule was buying in the first place. */
static bool sentence_end(const char *s, size_t k)
{
    if (k == 0) return false;
    if (s[k] != '\0' && !is_space(s[k])) return false;

    size_t j = k, step;
    while ((step = closer_before(s, j)) != 0) j -= step;
    if (j == 0) return false;

    char t = s[j - 1];
    if (t != '.' && t != '!' && t != '?') return false;

    /* A single letter between two full stops is an initialism, not a sentence. */
    if (t == '.' && j >= 3 && s[j - 3] == '.' && is_alpha(s[j - 2])) return false;

    return true;
}

/* --- the cut -------------------------------------------------------------- */

size_t ui_fit_text(const lv_font_t *font, int w, int h, int line_space,
                   const char *src, char *dst, size_t n)
{
    if (!dst || n == 0) return 0;
    dst[0] = '\0';
    if (!font || !src || w <= 0 || h <= 0) return 0;

    /* Leading whitespace is consumed but never copied. It is the space the
     * previous column cut at, and a column that keeps it starts one glyph
     * indented for no reason anybody chose. Counting it in the return is what
     * makes the consumed spans tile the source with no gap. */
    size_t lead = 0;
    while (is_space(src[lead])) lead++;

    const char *p = src + lead;
    size_t total = strlen(p);
    if (total == 0) return lead;

    /* dst is both the answer and the buffer the measurement runs on, so the
     * search can never consider more text than dst can hold: a cut capped by `n`
     * is still a cut at a word boundary, and the caller still continues from
     * exactly where it stopped. */
    size_t limit = total < n - 1 ? total : n - 1;
    limit = char_floor(p, limit);
    memcpy(dst, p, limit);
    dst[limit] = '\0';

    size_t cut;
    if (fits(font, w, h, line_space, dst, limit)) {
        cut = limit;
    } else {
        /* fits(lo) holds and fits(hi) does not, lo is always a character
         * boundary, and every pass strictly closes the gap — so this ends, and
         * it ends in log2(limit) measurements. The empty prefix is assumed to
         * fit rather than measured: LVGL reports one line's height for it, so a
         * box shorter than a line would fail the assumption and the answer would
         * still be right, which is cut = 0. */
        size_t lo = 0, hi = limit;
        while (hi - lo > 1) {
            size_t mid = char_floor(p, lo + (hi - lo) / 2);
            if (mid <= lo) {
                mid = lo + 1;
                while (mid < hi && is_cont(p[mid])) mid++;
                if (mid >= hi) break;       /* no boundary lies between them */
            }
            if (fits(font, w, h, line_space, dst, mid)) lo = mid;
            else                                        hi = mid;
        }
        cut = lo;
    }

    /* Everything that was left fits: take it whole, trailing spaces and all.
     * There is no next column to hand them to. */
    if (cut == total) return lead + total;

    /* Back up to the last word boundary. `k` walks to the first byte of the word
     * the cut landed inside; k == 0 means it landed inside the FIRST word, which
     * has no boundary behind it — and there the mid-word cut stands, because a
     * column that renders nothing is worse than one that renders a word broken
     * across a page, which is a thing newspapers do on purpose. */
    if (!is_space(p[cut])) {
        size_t k = cut;
        while (k > 0 && !is_space(p[k - 1])) k--;
        if (k > 1) cut = k - 1;
    }
    while (cut > 0 && is_space(p[cut - 1])) cut--;

    /* The nearest sentence end wins over the word boundary — but only where it
     * is FREE, meaning the column still sets in the same number of lines. That
     * proviso is the whole rule, and it is worth the two measurements it costs.
     *
     * The version this replaces asked instead for a full stop "in the last 15%
     * of what fits", counted in BYTES, and 15% of the bytes of a fourteen-line
     * column is two whole lines: on the demo front page it gave up a line of
     * the lead every time and two on a one-story page, and left the bottom of
     * the well bare above the rule. Height is the thing that runs out, so
     * height is the thing to spend — and the answer is that there is none to
     * spend. A reader sees an unfilled column across a room; nobody sees that
     * the last line of a filled one ended mid-clause.
     *
     * The scan stops at the first sentence end it meets, and stopping there
     * costs nothing: the height of a prefix is monotone, so if the nearest end
     * is already a line short then every earlier one is shorter still. Which is
     * also why this is two measurements and not one per candidate — the word
     * cut's height, and the one end worth asking about. */
    for (size_t k = cut; k > 0; k--) {
        if (!sentence_end(p, k)) continue;

        int32_t h_word = text_h(font, w, line_space, dst, cut);
        if (text_h(font, w, line_space, dst, k) == h_word) cut = k;
        break;
    }

    dst[cut] = '\0';
    return lead + cut;
}

/* --- balancing a headline -------------------------------------------------
 *
 * Greedy line breaking is right for body copy and wrong for a headline. LVGL
 * fills each line to the measure and drops what is left onto the next, so a
 * 49-character head across 1140 px comes out as 1056 px of line one and 208 of
 * line two: an eight-character stub with 900 px of bare paper beside it, which
 * does not read as a two-line headline, it reads as a line that ran over. Every
 * newspaper breaks its heads by hand for exactly this reason.
 *
 * So: try every legal split of the string into the number of lines it is going
 * to take anyway, score each by the width of its WIDEST line, and keep the
 * lowest score. Minimising the widest line is what "balanced" means here and it
 * needs no second rule about stubs — a split that leaves one word alone has a
 * very wide first line and loses on its own merits.
 *
 * Two things are scored, not one: the width of the widest line, and whether the
 * break lands after a word that belongs to what follows it — see FIT_STOP.
 *
 * The chosen breaks become explicit '\n', which LVGL honours; and because every
 * line is measured against `w` before it is accepted, none of them can wrap
 * again underneath the break we put in.
 *
 * Cost: the split is brute-forced, which is O(k) for two lines and O(k^2) for
 * three over the k word boundaries of a string the model caps at 120 bytes.
 * That is a few hundred measurements of a few words each, once per snapshot
 * that changed — against a panel refresh that takes twenty-five seconds.
 */

/* Wide enough that lv_text_get_size() never wraps, small enough that no
 * arithmetic inside it can overflow. */
#define FIT_WIDE        (1 << 20)
#define FIT_BREAKS_MAX  32

/* --- where a head may not be broken ---------------------------------------
 *
 * Balance alone scores a split on the width of its widest line, and on a page
 * that produced four breaks landing on an article or a preposition — "Two-year
 * yield / sinks after a / soft claims print" leaves the reader hanging on an
 * indefinite article at 25 px caps. It is the single loudest signal that the
 * heads were broken by a machine: every copy desk breaks its heads by hand
 * precisely to avoid it, and a page that otherwise looks hand-set makes the four
 * that are not stand out.
 *
 * So a candidate split whose last word is one of these takes a penalty, and the
 * penalty is a SIXTH OF THE MEASURE rather than a veto. Balance still wins by
 * default; a stop-word break is taken only when nothing else fits inside the
 * measure, which on a two-word head is the only split there is.
 *
 * The list is closed on purpose. It is the words that cannot end a line because
 * they belong to what follows — articles, the common prepositions, the
 * conjunctions — and not a general parts-of-speech test, which is not a thing a
 * 240 MHz Xtensa is going to do to a headline. Matched case-insensitively,
 * because a head is set in mixed case and "The" is as bad a line ending as
 * "the". */
static const char *const FIT_STOP[] = {
    "a", "an", "the", "of", "in", "on", "at", "to", "as", "by", "for", "and",
    "or", "but", "into", "from", "over", "with", "under", "after", "than",
    "that", "its", "his", "her", "their",
};

static char lower(char c)
{
    return (c >= 'A' && c <= 'Z') ? (char)(c + 32) : c;
}

/* Is the word ending at `b` — the byte the break would replace — one of them? */
static bool stop_word_before(const char *s, size_t b)
{
    size_t e = b;
    while (e > 0 && is_space(s[e - 1])) e--;

    size_t k = e;
    while (k > 0 && !is_space(s[k - 1])) k--;

    const size_t len = e - k;
    if (len == 0 || len > 5) return false;       /* longest entry is "under" */

    for (size_t i = 0; i < sizeof FIT_STOP / sizeof *FIT_STOP; i++) {
        const char *w = FIT_STOP[i];
        if (strlen(w) != len) continue;

        size_t j = 0;
        while (j < len && lower(s[k + j]) == w[j]) j++;
        if (j == len) return true;
    }
    return false;
}

/* The natural width of dst[a..b), unwrapped. */
static int32_t seg_w(const lv_font_t *font, char *buf, size_t a, size_t b)
{
    lv_point_t sz;
    char save = buf[b];

    buf[b] = '\0';
    lv_text_get_size(&sz, buf + a, font, 0, 0, FIT_WIDE, LV_TEXT_FLAG_NONE);
    buf[b] = save;

    return sz.x;
}

int ui_fit_balance(const lv_font_t *font, int w, int max_lines,
                   const char *src, char *dst, size_t n)
{
    if (!dst || n == 0) return 0;
    dst[0] = '\0';
    if (!font || !src || w <= 0 || max_lines < 1) return 0;

    size_t len = strlen(src);
    if (len + 1 > n) len = char_floor(src, n - 1);
    memcpy(dst, src, len);
    dst[len] = '\0';
    if (len == 0) return 0;

    /* How many lines this is going to take, and how tall one of them is. One
     * measurement at the measure and one unwrapped: LVGL sets line_space 0 here
     * (strip() took the theme's away), so the first is an exact multiple of the
     * second and the division is the line count rather than an estimate. */
    lv_point_t at_w, one;
    lv_text_get_size(&at_w, dst, font, 0, 0, (int32_t)w, LV_TEXT_FLAG_NONE);
    lv_text_get_size(&one,  dst, font, 0, 0, FIT_WIDE,   LV_TEXT_FLAG_NONE);
    if (one.y <= 0) return 0;

    const int lines = (int)((at_w.y + one.y - 1) / one.y);
    if (lines <= 1) return 1;

    /* More lines than the slot has: this is the ellipsis case, and balancing a
     * head that is going to be cut anyway would only move where the cut lands.
     * ui_lab_box()'s rule owns it from here. */
    if (lines > max_lines || lines > 3) return 0;

    size_t brk[FIT_BREAKS_MAX];
    int nb = 0;
    for (size_t i = 1; i + 1 < len && nb < FIT_BREAKS_MAX; i++) {
        if (dst[i] == ' ' && dst[i - 1] != ' ' && dst[i + 1] != ' ') brk[nb++] = i;
    }
    if (nb < lines - 1) return 0;

    size_t best[2] = { 0, 0 };
    int32_t best_score = 0;
    bool found = false;

    /* The stop-word penalty, in the same units the score is in. A sixth of the
     * measure is enough to lose to any split that is merely a little more
     * ragged, and not enough to lose to one that overflows — those are rejected
     * outright above. */
    const int32_t pen = (int32_t)w / 6;

    for (int i = 0; i < nb; i++) {
        if (lines == 2) {
            const int32_t a = seg_w(font, dst, 0, brk[i]);
            const int32_t b = seg_w(font, dst, brk[i] + 1, len);
            if (a > w || b > w) continue;
            int32_t s = a > b ? a : b;
            if (stop_word_before(dst, brk[i])) s += pen;
            if (!found || s < best_score) { found = true; best_score = s; best[0] = brk[i]; }
            continue;
        }

        const int32_t a = seg_w(font, dst, 0, brk[i]);
        if (a > w) continue;
        const bool ai = stop_word_before(dst, brk[i]);
        for (int j = i + 1; j < nb; j++) {
            const int32_t b = seg_w(font, dst, brk[i] + 1, brk[j]);
            const int32_t c = seg_w(font, dst, brk[j] + 1, len);
            if (b > w || c > w) continue;
            int32_t s = a > b ? a : b;
            if (c > s) s = c;
            if (ai)                             s += pen;
            if (stop_word_before(dst, brk[j]))  s += pen;
            if (!found || s < best_score) {
                found = true; best_score = s; best[0] = brk[i]; best[1] = brk[j];
            }
        }
    }

    if (!found) return 0;

    dst[best[0]] = '\n';
    if (lines == 3) dst[best[1]] = '\n';
    return lines;
}
