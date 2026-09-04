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

/* Wide enough that lv_text_get_size() never wraps, small enough that no
 * arithmetic inside it can overflow. */
#define FIT_WIDE  (1 << 20)

/* The natural width of buf[a..b), unwrapped. Both halves of this file ask the
 * same question of it: the balancer scores a candidate line with it, and the
 * Korean fill below tests whether one more syllable still fits the measure. */
static int32_t seg_w(const lv_font_t *font, char *buf, size_t a, size_t b)
{
    lv_point_t sz;
    char save = buf[b];

    buf[b] = '\0';
    lv_text_get_size(&sz, buf + a, font, 0, 0, FIT_WIDE, LV_TEXT_FLAG_NONE);
    buf[b] = save;

    return sz.x;
}

/* The height of one line, which is the height lv_text_get_size() reports for an
 * empty string — LVGL's own special case, and the stand-in's. */
static int32_t line_h_of(const lv_font_t *font, int line_space)
{
    lv_point_t sz;

    lv_text_get_size(&sz, "", font, 0, (int32_t)line_space, FIT_WIDE,
                     LV_TEXT_FLAG_NONE);
    return sz.y;
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

/* --- Korean --------------------------------------------------------------
 *
 * LVGL will not break a Korean line except at a space, so under UI_FIT_HANGUL
 * this file stops asking it to: it fills the lines itself, joins them with
 * '\n', and hands LVGL a string with nothing left to wrap. ui_fit.h says why.
 *
 * Everything the rule needs is below, and it is five questions: what a unit is,
 * whether two of them may be parted, how tall a line is, how wide the one being
 * built has grown, and where to cut a token wider than the measure.
 *
 * That last one is what keeps the guarantee at the top of this file — a string
 * this file accepted cannot wrap onto a line that does not exist — true here.
 * The Latin path gets it for nothing: it measures at max_width = w, so LVGL's
 * hard break on a too-long word happens INSIDE the measurement and the prefix
 * it returns always sets inside `h`. This path measures each line unwrapped, so
 * a line it emits wider than `w` would be re-wrapped by LVGL underneath our own
 * '\n' and the line count would be short by however many lines LVGL added — the
 * copy would run past the box, over the rule below, because ui_lab_wrap() sets a
 * fixed height and does not clip. So EVERY line this file emits is measured
 * inside `w`, an over-wide token included; glyph_break() does that cut. The one
 * thing left that can overrun is a single glyph wider than the whole measure,
 * which no cut can help and which on a 170 px leg is a 170 px character.
 */

/* The codepoint at `s`, and its length in bytes. Anything that is not a valid
 * sequence is reported as its own first byte, one byte long, which is also what
 * keeps this from reading past the end of a truncated string: a NUL is not a
 * continuation byte, so the loop below always stops at it. */
static uint32_t cp_at(const char *s, size_t *len)
{
    const unsigned char c0 = (unsigned char)s[0];
    size_t n;
    uint32_t cp;

    if      (c0 < 0xC0) { *len = 1; return c0; }
    else if (c0 < 0xE0) { n = 2; cp = c0 & 0x1Fu; }
    else if (c0 < 0xF0) { n = 3; cp = c0 & 0x0Fu; }
    else                { n = 4; cp = c0 & 0x07u; }

    for (size_t k = 1; k < n; k++) {
        if (((unsigned char)s[k] & 0xC0) != 0x80) { *len = 1; return c0; }
        cp = (cp << 6) | ((unsigned char)s[k] & 0x3Fu);
    }
    *len = n;
    return cp;
}

/* A character a line may be broken either side of. The syllable block is what
 * Korean copy is written in; the compatibility jamo are the letters named on
 * their own, and both are in the drawable set the Korean faces are generated
 * from. Nothing else on this sheet breaks between characters. */
static bool is_hangul(uint32_t cp)
{
    return (cp >= 0xAC00 && cp <= 0xD7A3) ||    /* Hangul Syllables            */
           (cp >= 0x3131 && cp <= 0x318E);      /* Hangul Compatibility Jamo   */
}

/* A line may not BEGIN with one of these — the ASCII marks a wire desk emits,
 * and the CJK ones a Korean edition actually sets. Korean line-break prohibition
 * (금칙 처리) puts the ideographic full stop and comma under exactly the rule the
 * ASCII pair are under: they belong to the line they close, not the one after.
 * The brackets are the closing halves of U+3008..U+300F, which with 、 and 。 is
 * the whole of tools/hangul.py CJK_PUNCT and therefore everything of this kind
 * the Korean faces can set. */
static bool is_closing(uint32_t cp)
{
    return cp == '.' || cp == ',' || cp == '!' || cp == '?' || cp == '%' ||
           cp == ')' || cp == ']' ||
           cp == 0x3002 ||                      /* 。 the ideographic full stop */
           cp == 0x3001 ||                      /* 、 and its comma             */
           cp == 0x3009 ||                      /* 〉 the angle brackets        */
           cp == 0x300B ||                      /* 》                           */
           cp == 0x300D ||                      /* 」 and the corner pair       */
           cp == 0x300F;                        /* 』                           */
}

/* A line may not END with one of these: the opening half of each pair above. */
static bool is_opening(uint32_t cp)
{
    return cp == '(' || cp == '[' ||
           cp == 0x3008 || cp == 0x300A ||      /* 〈 《 */
           cp == 0x300C || cp == 0x300E;        /* 「 『 */
}

/* The bytes of the unit beginning at `s`, or 0 at whitespace or at the end of
 * the string. A unit is the smallest thing a Korean line may be built out of:
 * one Hangul syllable, or a maximal run of non-space, non-Hangul characters.
 *
 * That second half is the rule that keeps a figure whole. "3.53%" is a run, so
 * it is ONE unit and there is no boundary inside it for a break to land on —
 * which matters because "." and "," are in LV_TXT_BREAK_CHARS and the first
 * Korean sheets came back with "3." ending a line and "53%" starting the next.
 * A Latin word, a ticker and a date are the same case and get the same answer. */
static size_t unit_len(const char *s)
{
    size_t l;

    if (s[0] == '\0' || is_space(s[0])) return 0;
    if (is_hangul(cp_at(s, &l))) return l;

    size_t i = 0;
    while (s[i] != '\0' && !is_space(s[i]) && !is_hangul(cp_at(s + i, &l))) i += l;
    return i;
}

/* May a line break between the unit ending at `a` and the one beginning at `b`?
 * Two rules and no more, both about a mark left alone on the wrong side of a
 * break, which is the thing a reader notices instantly. */
static bool break_ok(const char *s, size_t a, size_t b)
{
    size_t l;

    if (s[b] != '\0' && is_closing(cp_at(s + b, &l))) return false;
    if (a > 0 && is_opening(cp_at(s + char_floor(s, a - 1), &l))) return false;
    return true;
}

/* The bytes of buf[a..a+len) that still measure inside `w`, cut at a glyph
 * boundary. This is LV_TEXT_FLAG_BREAK_ALL — what LVGL does to a word too long
 * for the measure — done here instead, so that the line count fit_hangul()
 * keeps is the line count LVGL will actually set.
 *
 * The scan stops at the first glyph that overruns, so it costs one measurement
 * per glyph the LINE holds rather than per glyph the token has: a 4,000-byte
 * token costs what a twenty-character one costs.
 *
 * Never returns 0. A single glyph wider than the whole measure is set anyway,
 * because the alternative is a line with nothing on it and a caller that never
 * advances — and that glyph is the one thing this file emits wider than the box
 * it was given. */
static size_t glyph_break(const lv_font_t *font, char *buf, size_t a, size_t len,
                          int w)
{
    size_t fit = 0, i = 0;

    while (i < len) {
        size_t l;
        cp_at(buf + a + i, &l);
        if (l > len - i) l = len - i;
        i += l;
        if (seg_w(font, buf, a, a + i) > w) break;
        fit = i;
    }

    if (fit == 0) {
        size_t l;
        cp_at(buf + a, &l);
        return l > len ? len : l;
    }

    /* A machine break inside a token obeys the prohibition a break between two
     * units obeys: it may not leave a closing mark at the head of the next line
     * or an opening one at the foot of this. Never below one glyph — an empty
     * line would stall the caller, and that is the worse failure. */
    while (fit > 0 && !break_ok(buf, a + fit, a + fit)) {
        const size_t prev = char_floor(buf, a + fit - 1);
        if (prev <= a) break;
        fit = prev - a;
    }
    return fit;
}

/* Set `p` into `w` x `h`, a line at a time, joining the lines with '\n'.
 * Returns the SOURCE bytes consumed; `dst` is left NUL-terminated.
 *
 * The fill is greedy, which is right for body copy for the same reason it is
 * wrong for a headline: a leg is read down, not looked at, and the thing that
 * shows from across the room is a leg that did not reach the foot of its box.
 *
 * One invariant carries the whole function and is worth stating outright:
 * WITHIN a line, `dst` is a byte-for-byte copy of `p`. Breaks are the only
 * place the two diverge — a separator run becomes exactly one '\n', and a
 * syllable joint gains one that the source never had. That is what lets the
 * sentence rule at the end map a source offset back into `dst` by subtraction
 * instead of by remembering every boundary it passed. */
static size_t fit_hangul(const lv_font_t *font, int w, int h, int line_space,
                         const char *p, char *dst, size_t n)
{
    /* LVGL stacks lines at (letter_height + line_space) and takes the last line
     * space back off the end, so this is the exact line count and not an
     * estimate. The guard is on the step rather than on the height because a
     * caller is free to pass a negative line_space and a divisor of zero is not
     * a layout question. */
    const int32_t lh   = line_h_of(font, line_space);
    const int     step = (int)lh + line_space;
    if (lh <= 0 || step <= 0) return 0;

    const int max_lines = (h + line_space) / step;
    if (max_lines < 1) return 0;

    const size_t total = strlen(p);
    size_t si = 0, di = 0;                  /* source consumed, dst written    */
    size_t line_src = 0, line_dst = 0;      /* where the last line set began   */
    int lines = 0;

    while (lines < max_lines) {
        size_t start = si;
        while (is_space(p[start])) start++;
        if (p[start] == '\0') break;

        /* The break that joins this line to the one above. It is written only
         * once a unit has actually gone onto the line, so a line that turns out
         * to be empty leaves no newline hanging off the end of the copy. */
        const size_t nl = lines > 0 ? 1u : 0u;
        if (di + nl + 1 > n) break;

        line_src = start;
        line_dst = di + nl;

        size_t cur_src = start, cur_dst = line_dst;
        size_t ok_src = 0, ok_dst = 0;

        /* `fixed` means this line's end is not negotiable — the source broke it
         * with a newline, or a token was cut mid-way to keep it inside the
         * measure. Either way the punctuation backup below is skipped: there is
         * no better boundary to back up to, and backing up to the previous unit
         * would throw away a line's worth of copy. */
        bool have_ok = false, any = false, fixed = false;

        for (;;) {
            /* The whitespace before the next unit. A newline in it is the
             * source ending the line itself; honouring it is what keeps the
             * line count above equal to the number of lines LVGL will set.
             *
             * A run is ONE separator however many newlines are in it, so a
             * blank line in the copy collapses to a single break where the
             * Latin path would keep it. Deliberate: a leg is fourteen lines of
             * a 170 px measure and a blank one spends a fourteenth of it
             * saying nothing, and the model's bodies are continuous prose with
             * no paragraphs to preserve. */
            size_t sep = cur_src;
            bool hard = false;
            while (is_space(p[sep])) {
                if (p[sep] == '\n' || p[sep] == '\r') hard = true;
                sep++;
            }

            const size_t ul = unit_len(p + sep);
            if (ul == 0) break;                         /* the source ran out */
            if (hard && any) { fixed = true; break; }

            size_t add = (sep - cur_src) + ul;

            /* dst, not the box. A first unit longer than the whole buffer is
             * cut to what the buffer holds rather than refused, or the call
             * would return 0 and a caller walking columns would stall on copy
             * it could have set. */
            if (cur_dst + add + 1 > n) {
                if (any) break;
                add = char_floor(p + cur_src, n - 1 - cur_dst);
                if (add == 0) break;
                fixed = true;
            }

            memcpy(dst + cur_dst, p + cur_src, add);
            dst[cur_dst + add] = '\0';

            if (seg_w(font, dst, line_dst, cur_dst + add) > w) {
                if (any) break;                 /* it belongs to the next line */

                /* Nothing on the line yet and the unit alone overruns the
                 * measure: cut it where LVGL would have. Leaving it whole is
                 * the bug this branch exists for — LVGL re-wraps it under our
                 * own '\n' and the copy runs past `h`. */
                add = glyph_break(font, dst, line_dst, add, w);
                dst[line_dst + add] = '\0';
                fixed = true;
            }

            any      = true;
            cur_src += add;
            cur_dst += add;
            if (fixed) break;                   /* a cut line ends where it cut */

            size_t nxt = cur_src;
            while (is_space(p[nxt])) nxt++;
            if (p[nxt] == '\0' || break_ok(p, cur_src, nxt)) {
                have_ok = true;
                ok_src  = cur_src;
                ok_dst  = cur_dst;
            }
        }

        if (!any) break;                    /* not one unit would go: stop     */

        /* Back up to the last boundary the punctuation rule allows, unless the
         * line's end is fixed. Where NO boundary on the line is legal the
         * measure wins, because a line wider than its box is a line LVGL wraps
         * over the rule below. */
        const bool back = have_ok && !fixed;
        if (nl) dst[di] = '\n';
        si = back ? ok_src : cur_src;
        di = back ? ok_dst : cur_dst;
        dst[di] = '\0';
        lines++;
    }

    dst[di] = '\0';

    /* Everything that was left fits. There is no next column to hand the
     * trailing whitespace to, so it is consumed rather than left to stall a
     * caller looping on the return value. */
    size_t rest = si;
    while (is_space(p[rest])) rest++;
    if (rest >= total) return total;

    /* The sentence preference, on exactly the terms the Latin path states it:
     * the nearest sentence end wins over the boundary the fill landed on, but
     * only where it is FREE. Here that is a question about position rather than
     * a measurement — the lines were laid out above, so any end inside the last
     * line leaves the column exactly as tall as it already is, and any end
     * before it costs a line and is refused. */
    for (size_t k = si; k > line_src; k--) {
        if (!sentence_end(p, k)) continue;
        di -= si - k;                       /* dst mirrors p within a line     */
        si  = k;
        dst[di] = '\0';
        break;
    }

    return si;
}

/* --- the cut -------------------------------------------------------------- */

ui_fit_script_t ui_fit_script(const char *lang)
{
    /* Two bytes and a NUL. "ko" is the one tag with a breaking rule of its own,
     * so it is the whole of the test: every other tag takes the Latin rule,
     * three-letter ones included. The model accepts a two- OR three-letter
     * primary subtag, so "kor" does reach here — and takes Latin, which is the
     * honest answer for a tag this file has no rule for. */
    return (lang && lang[0] == 'k' && lang[1] == 'o' && lang[2] == '\0')
           ? UI_FIT_HANGUL : UI_FIT_LATIN;
}

size_t ui_fit_text(const lv_font_t *font, int w, int h, int line_space,
                   ui_fit_script_t script, const char *src, char *dst, size_t n)
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

    /* Korean lays its own lines out; everything below this is the Latin rule,
     * unchanged, because LVGL breaks Latin copy correctly and the only job left
     * is deciding where to stop. */
    if (script == UI_FIT_HANGUL)
        return lead + fit_hangul(font, w, h, line_space, p, dst, n);

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

/* How many break candidates a head may offer. Thirty-two is one per space of a
 * 120-byte head and generous at it, and it stays the Latin cap so that the
 * Latin search is the search it was. Korean offers a candidate between every
 * two syllables and a 120-byte head is forty of them, so that scan needs a cap
 * that clears forty or the balancer stops looking before the end of the line. */
#define FIT_BREAKS_MAX    64
#define FIT_BREAKS_LATIN  32

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

int ui_fit_balance(const lv_font_t *font, int w, int max_lines,
                   ui_fit_script_t script, const char *src, char *dst, size_t n)
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

    /* Where a break may go, and where the line after it starts. In Latin those
     * differ by the one byte of the space a break replaces; in Korean a break
     * between two syllables is INSERTED, so the two are the same offset and the
     * copy grows by a byte. Keeping the pair explicit is what lets the scoring
     * below stay one loop over one ascending list.
     *
     * uint16_t and not size_t: two 64-entry arrays of size_t are 512 bytes of
     * UiTask's 8 KB stack, and these are offsets into a head — NEWS_HEADLINE_MAX
     * is 120 bytes and NEWS_DECK_MAX 180, against a ceiling of 65,535. The guard
     * states the assumption instead of resting on it; a caller with a buffer
     * three hundred times the model's largest field declines, as every other
     * refusal here declines, with the source intact in `dst`. */
    if (len > UINT16_MAX) return 0;

    uint16_t brk[FIT_BREAKS_MAX], aft[FIT_BREAKS_MAX];
    int nb = 0;

    if (script == UI_FIT_HANGUL) {
        /* Every unit boundary the punctuation rule allows, syllable joints
         * included — which is the whole point, since a Korean head often has no
         * space in it at all and had nothing to be balanced on before. */
        size_t i = 0;
        while (i < len && nb < FIT_BREAKS_MAX) {
            size_t sep = i;
            while (sep < len && is_space(dst[sep])) sep++;

            const size_t ul = unit_len(dst + sep);
            if (ul == 0) break;

            const size_t end = sep + ul;
            if (end >= len) break;              /* the last unit ends the head */

            size_t nxt = end;
            while (nxt < len && is_space(dst[nxt])) nxt++;

            /* A run of more than one space is left alone for the same reason
             * the Latin scan below leaves it alone: only one of them can become
             * the break, and the others would be set at the head of a line. */
            if (nxt < len && nxt - end <= 1 && break_ok(dst, end, nxt)) {
                brk[nb] = (uint16_t)end;
                aft[nb] = (uint16_t)nxt;
                nb++;
            }
            i = end;
        }
    } else {
        for (size_t i = 1; i + 1 < len && nb < FIT_BREAKS_LATIN; i++) {
            if (dst[i] == ' ' && dst[i - 1] != ' ' && dst[i + 1] != ' ') {
                brk[nb] = (uint16_t)i;
                aft[nb] = (uint16_t)(i + 1);
                nb++;
            }
        }
    }
    if (nb < lines - 1) return 0;

    size_t best[2] = { 0, 0 }, best_aft[2] = { 0, 0 };
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
            const int32_t b = seg_w(font, dst, aft[i], len);
            if (a > w || b > w) continue;
            int32_t s = a > b ? a : b;
            if (stop_word_before(dst, brk[i])) s += pen;
            if (!found || s < best_score) {
                found = true; best_score = s;
                best[0] = brk[i]; best_aft[0] = aft[i];
            }
            continue;
        }

        const int32_t a = seg_w(font, dst, 0, brk[i]);
        if (a > w) continue;
        const bool ai = stop_word_before(dst, brk[i]);
        for (int j = i + 1; j < nb; j++) {
            const int32_t b = seg_w(font, dst, aft[i], brk[j]);
            const int32_t c = seg_w(font, dst, aft[j], len);
            if (b > w || c > w) continue;
            int32_t s = a > b ? a : b;
            if (c > s) s = c;
            if (ai)                             s += pen;
            if (stop_word_before(dst, brk[j]))  s += pen;
            if (!found || s < best_score) {
                found = true; best_score = s;
                best[0] = brk[i]; best_aft[0] = aft[i];
                best[1] = brk[j]; best_aft[1] = aft[j];
            }
        }
    }

    if (!found) return 0;

    /* A break that replaces a space overwrites it; one between two syllables
     * has to make room, so the tail moves up and the copy grows. Inserting from
     * the back keeps the earlier offset valid, and a `dst` with no room for the
     * insertions declines like every other refusal here, leaving the source
     * intact for ui_lab_box() to set unbalanced. */
    size_t grow = 0;
    for (int i = 0; i < lines - 1; i++) if (best_aft[i] == best[i]) grow++;
    if (len + grow + 1 > n) return 0;

    for (int i = lines - 2; i >= 0; i--) {
        if (best_aft[i] == best[i]) {
            memmove(dst + best[i] + 1, dst + best[i], len - best[i] + 1);
            len++;
        }
        dst[best[i]] = '\n';
    }
    return lines;
}
