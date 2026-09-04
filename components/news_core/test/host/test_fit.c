/*
 * test_fit.c — the copyfit engine, against a text measurer this file supplies.
 *
 * ui_fit.c is pure and has exactly one dependency: lv_text_get_size(). There is
 * no LVGL on the host, so the dependency is provided here — which is not a
 * weakening of the test but the point of it. A real face's advance widths would
 * make every expectation below a number nobody could check by reading it,
 * whereas a monospaced stand-in at ten pixels a glyph and a hundred-pixel column
 * means a line holds ten characters and the answer can be counted on a hand.
 *
 * The stand-in is faithful about the one thing copyfitting depends on, which is
 * where LVGL breaks lines: greedily, at word boundaries, dropping the space it
 * broke at, and hard-breaking a word too long for the measure exactly as LVGL
 * does when it forces LV_TEXT_FLAG_BREAK_ALL onto the first word of a line. It
 * is deliberately not faithful about pixel widths, because ui_fit.c does not
 * read the width back.
 *
 * It also decodes UTF-8 as it counts, and flags a byte sequence that is not
 * valid. That is how a cut landing in the middle of a multi-byte character is
 * caught here rather than on the glass, where it is a tofu box in the middle of
 * a word and nothing at all in the log.
 */
#include "ui_fit.h"

#include <stdbool.h>

#include "th.h"

/* --- the stand-in face ---------------------------------------------------- */

#define ADV     10      /* every glyph is this wide  */
#define LH      20      /* every line is this tall   */
#define LS       4      /* the line space used throughout */

/* The height of a box that holds exactly `n` lines: LVGL adds a line space
 * between lines and not after the last one. */
#define BOX_H(n)  ((n) * (LH + LS) - LS)

struct _lv_font_t {
    int32_t advance;
    int32_t line_h;
};

static const lv_font_t FACE = { ADV, LH };

/* Incremented the moment the measurer is handed bytes that are not valid UTF-8.
 * ui_fit_text() measures its own output, so a cut inside a character shows up
 * here on the very call that made it. */
static int g_bad_utf8;

static bool ws(char c)
{
    return c == ' ' || c == '\t' || c == '\n' || c == '\r';
}

/* The length of the UTF-8 sequence at `s`, complaining about anything that is
 * not one. A truncated sequence reads its own NUL and is caught by the
 * continuation-byte test, so this never runs off the end of the string. */
static size_t glyph_len(const char *s)
{
    unsigned char c = (unsigned char)s[0];
    size_t n;

    if      (c < 0x80) return 1;
    else if (c < 0xC0) { g_bad_utf8++; return 1; }      /* a stray continuation */
    else if (c < 0xE0) n = 2;
    else if (c < 0xF0) n = 3;
    else               n = 4;

    for (size_t k = 1; k < n; k++) {
        if (((unsigned char)s[k] & 0xC0) != 0x80) { g_bad_utf8++; return 1; }
    }
    return n;
}

void lv_text_get_size(lv_point_t *size_res, const char *text, const lv_font_t *font,
                      int32_t letter_space, int32_t line_space, int32_t max_width,
                      lv_text_flag_t flag)
{
    (void)letter_space;
    (void)flag;

    size_t cols = (size_t)(max_width / font->advance);
    if (cols < 1) cols = 1;

    size_t lines = 1, col = 0, widest = 0, i = 0;
    bool any = text[0] != '\0';

    while (text[i]) {
        /* The whitespace between two words. A newline breaks the line outright;
         * anything else is one column wide, and only if a word follows it on the
         * same line. */
        bool sep = false;
        while (text[i] && ws(text[i])) {
            if (text[i] == '\n') { lines++; col = 0; sep = false; }
            else                   sep = true;
            i++;
        }
        if (!text[i]) break;

        size_t glyphs = 0;
        while (text[i] && !ws(text[i])) { i += glyph_len(text + i); glyphs++; }

        if (glyphs > cols) {
            if (col > 0) { lines++; col = 0; }
            for (;;) {
                size_t take = glyphs < cols ? glyphs : cols;
                glyphs -= take;
                col = take;
                if (glyphs == 0) break;
                lines++;
                col = 0;
            }
        } else {
            size_t need = glyphs + ((col > 0 && sep) ? 1u : 0u);
            if (col > 0 && col + need > cols) { lines++; col = 0; need = glyphs; }
            col += need;
        }
        if (col > widest) widest = col;
    }

    size_res->x = (int32_t)widest * font->advance;
    size_res->y = any ? (int32_t)lines * (font->line_h + line_space) - line_space
                      : font->line_h;
}

/* --- the invariants every call must satisfy ------------------------------- */

/* Stating these once is what keeps each case below to its one interesting
 * assertion. Together they are the contract in ui_fit.h: the copy is a prefix of
 * the source, so nothing is invented and there is no ellipsis; the consumed
 * count and the copy agree, so a caller's offsets tile the source; and what the
 * call consumed but did not copy is whitespace and only whitespace. */
static size_t fit(int w, int h, const char *src, char *dst, size_t n)
{
    g_bad_utf8 = 0;

    size_t used = ui_fit_text(&FACE, w, h, LS, UI_FIT_LATIN, src, dst, n);
    size_t len  = strlen(dst);

    CHECK(g_bad_utf8 == 0);
    CHECK(len < n);

    /* The copy is valid UTF-8 in its own right, not merely as measured. */
    for (size_t i = 0; i < len; ) i += glyph_len(dst + i);
    CHECK(g_bad_utf8 == 0);

    size_t lead = 0;
    while (ws(src[lead])) lead++;

    CHECK(used <= strlen(src));
    CHECK(used == lead + len);
    CHECK(len == 0 || memcmp(dst, src + lead, len) == 0);
    for (size_t i = 0; i < lead; i++) CHECK(ws(src[i]));

    if (len > 0) {
        lv_point_t sz;
        lv_text_get_size(&sz, dst, &FACE, 0, LS, w, LV_TEXT_FLAG_NONE);
        CHECK(sz.y <= h);
        CHECK(!ws(dst[len - 1]) || used == strlen(src));
    }
    return used;
}

/* --- the degenerate inputs ------------------------------------------------ */

static void t_degenerate(void)
{
    char buf[64];

    /* No source at all, in each of its shapes. dst is blanked either way, so a
     * caller that ignores the return does not print the previous column twice. */
    memset(buf, 'X', sizeof buf);
    CHECK_INT(ui_fit_text(&FACE, 100, BOX_H(2), LS, UI_FIT_LATIN, NULL, buf, sizeof buf), 0);
    CHECK_STR(buf, "");

    memset(buf, 'X', sizeof buf);
    CHECK_INT(ui_fit_text(&FACE, 100, BOX_H(2), LS, UI_FIT_LATIN, "", buf, sizeof buf), 0);
    CHECK_STR(buf, "");

    memset(buf, 'X', sizeof buf);
    CHECK_INT(ui_fit_text(NULL, 100, BOX_H(2), LS, UI_FIT_LATIN, "text", buf, sizeof buf), 0);
    CHECK_STR(buf, "");

    /* No destination. n == 0 must not write a NUL either: there is no byte to
     * write it to, and a caller passing 0 has no buffer to blank. */
    CHECK_INT(ui_fit_text(&FACE, 100, BOX_H(2), LS, UI_FIT_LATIN, "text", NULL, sizeof buf), 0);
    memset(buf, 'X', sizeof buf);
    CHECK_INT(ui_fit_text(&FACE, 100, BOX_H(2), LS, UI_FIT_LATIN, "text", buf, 0), 0);
    CHECK(buf[0] == 'X');

    /* No box. */
    memset(buf, 'X', sizeof buf);
    CHECK_INT(ui_fit_text(&FACE, 0, BOX_H(2), LS, UI_FIT_LATIN, "text", buf, sizeof buf), 0);
    CHECK_STR(buf, "");
    CHECK_INT(ui_fit_text(&FACE, 100, 0, LS, UI_FIT_LATIN, "text", buf, sizeof buf), 0);
    CHECK_STR(buf, "");
    CHECK_INT(ui_fit_text(&FACE, -100, -1, LS, UI_FIT_LATIN, "text", buf, sizeof buf), 0);
    CHECK_STR(buf, "");

    /* A box shorter than one line holds nothing, and says so with a 0 rather
     * than by consuming bytes it did not set. A caller walking columns stops. */
    CHECK_INT(ui_fit_text(&FACE, 100, LH - 1, LS, UI_FIT_LATIN, "text", buf, sizeof buf), 0);
    CHECK_STR(buf, "");

    /* Room for one character and no more: the buffer, not the box, is the
     * limit, and the answer is empty rather than a byte with nowhere to put the
     * NUL. */
    CHECK_INT(ui_fit_text(&FACE, 100, BOX_H(2), LS, UI_FIT_LATIN, "text", buf, 1), 0);
    CHECK_STR(buf, "");

    /* Whitespace is consumed even when nothing is set from it, or a caller
     * looping on the return value never reaches the end of a story that trails
     * off in spaces. */
    CHECK_INT(fit(100, BOX_H(2), "   ", buf, sizeof buf), 3);
    CHECK_STR(buf, "");
    CHECK_INT(fit(100, BOX_H(2), " \n\t ", buf, sizeof buf), 4);
    CHECK_STR(buf, "");
}

/* --- the source is shorter than the box ----------------------------------- */

static void t_shorter_than_box(void)
{
    char buf[128];

    CHECK_INT(fit(200, BOX_H(3), "Short copy.", buf, sizeof buf), 11);
    CHECK_STR(buf, "Short copy.");

    /* Leading whitespace is dropped from the copy and still counted, which is
     * what lets the second column of a story start on a word. */
    CHECK_INT(fit(200, BOX_H(3), "  Short copy.", buf, sizeof buf), 13);
    CHECK_STR(buf, "Short copy.");
}

/* --- exactly full, and one byte over -------------------------------------- */

static void t_exact_and_over(void)
{
    char buf[128];

    /* Ten glyphs into a hundred pixels: full to the pixel, and taken whole. */
    CHECK_INT(fit(100, BOX_H(1), "abcdefghij", buf, sizeof buf), 10);
    CHECK_STR(buf, "abcdefghij");

    /* Two lines of five, into a box of exactly two lines. */
    CHECK_INT(fit(100, BOX_H(2), "abcde fghij", buf, sizeof buf), 11);
    CHECK_STR(buf, "abcde fghij");

    /* One glyph more than the line holds, and no word boundary anywhere in it.
     * This is the case the mid-word rule exists for: backing up to a boundary
     * would emit nothing at all. */
    CHECK_INT(fit(100, BOX_H(1), "abcdefghijk", buf, sizeof buf), 10);
    CHECK_STR(buf, "abcdefghij");

    /* The same overflow with a boundary available: the last whole word goes,
     * and the space it was cut at is left for the next column to drop. */
    CHECK_INT(fit(100, BOX_H(1), "abcde fghij", buf, sizeof buf), 5);
    CHECK_STR(buf, "abcde");
}

/* --- word boundaries ------------------------------------------------------ */

static void t_word_boundary(void)
{
    char buf[128];

    /* The line holds "abcde fg h"; the cut backs up over the broken "h" and
     * lands after "fg", with no trailing space left in the copy. */
    CHECK_INT(fit(100, BOX_H(1), "abcde fg hij", buf, sizeof buf), 8);
    CHECK_STR(buf, "abcde fg");

    /* A run of spaces at the cut is trimmed from the copy and left in the
     * source, so the two columns still tile it. */
    CHECK_INT(fit(100, BOX_H(1), "abcde   fghij", buf, sizeof buf), 5);
    CHECK_STR(buf, "abcde");
}

/* --- sentence preference -------------------------------------------------- */

static void t_sentence(void)
{
    char buf[128];

    /* Three lines of twenty. The word boundary falls after "Kappa" at 53 bytes,
     * and the full stop after "iota." sits six bytes back — inside the last 15%,
     * so the column ends on the sentence instead. */
    CHECK_INT(fit(200, BOX_H(3),
                  "Alpha beta gamma delta epsilon zeta theta iota. Kappa lambda mu",
                  buf, sizeof buf), 47);
    CHECK_STR(buf, "Alpha beta gamma delta epsilon zeta theta iota.");

    /* The same shape with the full stop at the front instead: it is nowhere near
     * the last 15% of what fits, so the word boundary stands and the column ends
     * mid-sentence, which is the ordinary case. */
    CHECK_INT(fit(200, BOX_H(3),
                  "Alpha. Beta gamma delta epsilon zeta theta iota kappa lambda mu",
                  buf, sizeof buf), 53);
    CHECK_STR(buf, "Alpha. Beta gamma delta epsilon zeta theta iota kappa");

    /* An abbreviation in the window is not a sentence. The pair below differs by
     * four bytes that measure identically, so the only thing that can move the
     * cut is the initialism test. */
    CHECK_INT(fit(200, BOX_H(3),
                  "Alpha beta gamma delta epsilon zeta theta U.S. Kappa lambda mu",
                  buf, sizeof buf), 52);
    CHECK_STR(buf, "Alpha beta gamma delta epsilon zeta theta U.S. Kappa");

    CHECK_INT(fit(200, BOX_H(3),
                  "Alpha beta gamma delta epsilon zeta theta Ltd. Kappa lambda mu",
                  buf, sizeof buf), 46);
    CHECK_STR(buf, "Alpha beta gamma delta epsilon zeta theta Ltd.");

    /* A question mark ends a sentence, and so does a full stop inside the
     * quotation that closes it. */
    CHECK_INT(fit(200, BOX_H(3),
                  "Alpha beta gamma delta epsilon zeta theta iota? Kappa lambda mu",
                  buf, sizeof buf), 47);
    CHECK_STR(buf, "Alpha beta gamma delta epsilon zeta theta iota?");

    CHECK_INT(fit(200, BOX_H(3),
                  "Alpha beta gamma delta epsilon zet \"theta iota.\" Kappa lambda",
                  buf, sizeof buf), 48);
    CHECK_STR(buf, "Alpha beta gamma delta epsilon zet \"theta iota.\"");

    /* And a column that stops on a sentence never keeps the space after it. */
    CHECK(buf[strlen(buf) - 1] != ' ');
}

/* --- the column has to fill ----------------------------------------------- */

/* Ordinary copy, in the sense that matters here: sentences of unremarkable
 * length, so that a full stop lands wherever a full stop lands. The point of
 * the test below is not that some adversarial string sets badly — it is that
 * ordinary sentences must not be able to cost a column its last line. */
static const char PARA[] =
    "The desk had the number a full hour before the market did, and it "
    "spent that hour arguing about which part of it mattered. Guidance "
    "beat the whole published range and the supply story finally arrived "
    "with figures attached to it. Nobody on the floor pretended to be "
    "surprised by the direction of the thing. What surprised them was the "
    "size of it, and the way the company described a backlog it had spent "
    "two straight quarters refusing to name at all.";

/* A story longer than its box must FILL the box. This is the half of the
 * sentence rule that a reader sees from the other side of the room, and it is
 * the one the owner asked for in as many words: use the display.
 *
 * The regression it pins had the sentence preference asking for a full stop
 * "anywhere in the last 15% of what fits", counted in BYTES. Bytes are the
 * wrong unit. Fifteen per cent of the bytes of a fourteen-line column is two
 * whole lines, so on the demo front page the lead gave up a line — two on the
 * one-story page — and left the foot of the well bare above the rule while the
 * copy that would have filled it was thrown away.
 *
 * Every box is walked at three heights: exactly n lines, and n lines plus a
 * third and plus most of a line of slack. A real slot is sized by the grid and
 * not by the face, so it is nearly never a whole number of lines — and slack is
 * what turns a lost line into a visibly short column, which is why the fixture
 * has to have some. Below six lines it stops being a fair test rather than a
 * failing one: a box with room for five lines and nine tenths cannot hold six,
 * and no cut can fill it.
 *
 * 85% and not 100% for the same reason: the bar is a floor on how much bare
 * paper is allowed at the foot of a column, not a demand for a perfect fit. */
static void t_fills_the_column(void)
{
    static const int slack[] = { 0, 8, 20 };
    char buf[512];

    for (int lines = 6; lines <= 15; lines++) {
        for (size_t s = 0; s < sizeof slack / sizeof slack[0]; s++) {
            const int h = BOX_H(lines) + slack[s];
            size_t used = fit(200, h, PARA, buf, sizeof buf);
            lv_point_t sz;

            /* Every one of these boxes is smaller than the story, or the case
             * being tested is not the case being run. */
            CHECK(used < strlen(PARA));
            CHECK(buf[0] != '\0');

            lv_text_get_size(&sz, buf, &FACE, 0, LS, 200, LV_TEXT_FLAG_NONE);
            CHECK(sz.y <= h);
            CHECK(sz.y * 100 >= (int32_t)h * 85);
        }
    }
}

/* The rule stated as the two shapes it has to tell apart, so that a failure
 * says which half broke rather than only that a column came out short. */
static void t_sentence_never_costs_a_line(void)
{
    char buf[512];

    /* Free, so taken. Three lines of twenty — "Alpha beta gamma" / "delta
     * epsilon zeta" / "theta iota. Kappa" — and the full stop is on the third
     * of them. Ending there costs the column nothing but the tail of a line it
     * has already started. */
    CHECK_INT(fit(200, BOX_H(3),
                  "Alpha beta gamma delta epsilon zeta theta iota. Kappa lambda mu",
                  buf, sizeof buf), 47);
    CHECK_STR(buf, "Alpha beta gamma delta epsilon zeta theta iota.");

    /* Not free, so not taken. A box of eight lines and a third: the word cut
     * lands eighteen bytes past "...it mattered.", which is 15% of the 140
     * bytes that fit and was therefore inside the old window. Taking it set the
     * column in seven lines out of eight — 164 px of a 196 px slot, a whole
     * line of bare paper — and that is the trade this refuses. The column now
     * ends mid-clause and full, which is what a newspaper column does. */
    CHECK_INT(fit(200, BOX_H(8) + 8, PARA, buf, sizeof buf), 140);
    CHECK_STR(buf, "The desk had the number a full hour before the market "
                   "did, and it spent that hour arguing about which part of "
                   "it mattered. Guidance beat the");
}

/* --- UTF-8 ---------------------------------------------------------------- */

static void t_utf8(void)
{
    char buf[128];

    /* Eleven accented characters, twenty-two bytes, in a line that holds ten
     * glyphs. The cut has to land on byte 20 and not on byte 21, which is the
     * middle of the eleventh. */
    CHECK_INT(fit(100, BOX_H(1), "àààààààààààà", buf, sizeof buf), 20);
    CHECK_INT(strlen(buf), 20);
    CHECK_STR(buf, "àààààààààà");

    /* Ordinary accented copy: the counts are bytes and the boundaries are
     * words, and neither notices that a glyph is two bytes wide. "Zürich café
     * naïve" is seventeen glyphs and twenty bytes, so it fills two lines of ten
     * and "Bogotá" is left for the next column. */
    CHECK_INT(fit(100, BOX_H(2), "Zürich café naïve Bogotá", buf, sizeof buf), 20);
    CHECK_STR(buf, "Zürich café naïve");

    CHECK_INT(fit(100, BOX_H(1), "Zürich café naïve Bogotá", buf, sizeof buf), 7);
    CHECK_STR(buf, "Zürich");

    /* A dst too small to hold the last whole character truncates on the
     * boundary below it, never inside it: seven bytes of room take six glyphs,
     * because one of them is the two bytes of the umlaut. */
    CHECK_INT(fit(200, BOX_H(3), "Zürich café", buf, 8), 7);
    CHECK_STR(buf, "Zürich");
}

/* --- the buffer, rather than the box, is the limit ------------------------ */

static void t_dst_limit(void)
{
    char buf[16];
    const char *src = "Alpha beta gamma delta epsilon";

    /* Fifteen bytes of room in a box that would take the lot: the cut is capped
     * by the buffer and then backed up to a word boundary like any other. */
    CHECK_INT(fit(400, BOX_H(4), src, buf, sizeof buf), 10);
    CHECK_STR(buf, "Alpha beta");

    /* And the caller carries on from exactly there, over the space it stopped
     * at, into a second buffer's worth of the same story. */
    CHECK_INT(fit(400, BOX_H(4), src + 10, buf, sizeof buf), 12);
    CHECK_STR(buf, "gamma delta");
}

/* --- the continuation ----------------------------------------------------- */

/* The product requirement behind the return value: a story set into one column
 * after another must come out whole. Every byte of the source is consumed by
 * exactly one call, and the only bytes no column receives are the single spaces
 * the columns were cut at — so the copy, rejoined with one space per join, is
 * the source again. */
static void t_continuation(void)
{
    static const char body[] =
        "SANTA CLARA — the quarter beat the whole sell-side range and the "
        "supply story finally has numbers behind it. Guidance for the "
        "October period came in above the highest published estimate, and "
        "the company said it had cleared the backlog it warned about in "
        "the spring. Shares rose in late trading.";

    char piece[12][80];
    char joined[sizeof body + 16];
    size_t used[12];
    size_t off = 0, np = 0;
    const size_t total = strlen(body);

    while (off < total && np < 12) {
        used[np] = fit(200, BOX_H(3), body + off, piece[np], sizeof piece[np]);
        CHECK(used[np] > 0);            /* no call may stall on real copy */
        CHECK(piece[np][0] != '\0');
        off += used[np];
        np++;
    }
    CHECK(off == total);                /* the spans tile the source exactly */
    CHECK(np > 3);                      /* and this body really did need columns */

    size_t j = 0;
    for (size_t i = 0; i < np; i++) {
        if (i > 0) joined[j++] = ' ';
        size_t len = strlen(piece[i]);
        memcpy(joined + j, piece[i], len);
        j += len;
    }
    joined[j] = '\0';
    CHECK_STR(joined, body);

    /* Nothing is repeated, which the tiling above proves, and nothing is
     * ellipsized, which this states outright: no column ends in a full stop it
     * did not get from the source. */
    for (size_t i = 0; i + 1 < np; i++) {
        CHECK(strstr(piece[i], "...") == NULL);
        CHECK(strstr(piece[i], "\xe2\x80\xa6") == NULL);
    }
}

/* --- the search itself ---------------------------------------------------- */

/* The binary search has to give the same answer a linear scan would, at every
 * height, or it is a faster way of being wrong. This walks a real paragraph
 * through every box height from one line to eight and checks the cut against the
 * longest prefix that measures inside the box — which is the definition the
 * search is an implementation of. */
static void t_matches_linear_scan(void)
{
    static const char body[] =
        "Guidance beat the whole sell-side range, and the supply story "
        "finally has numbers. The company cleared its backlog.";
    const size_t total = strlen(body);
    char buf[256];

    for (int lines = 1; lines <= 8; lines++) {
        int h = BOX_H(lines);
        size_t used = fit(200, h, body, buf, sizeof buf);

        /* The longest prefix of the source that fits, found the slow way. */
        size_t best = 0;
        for (size_t k = 1; k <= total; k++) {
            if (((unsigned char)body[k] & 0xC0) == 0x80) continue;
            char probe[256];
            memcpy(probe, body, k);
            probe[k] = '\0';
            lv_point_t sz;
            lv_text_get_size(&sz, probe, &FACE, 0, LS, 200, LV_TEXT_FLAG_NONE);
            if (sz.y <= h) best = k;
        }

        /* The cut never exceeds what fits, and it gives up at most one word or
         * one sentence tail to land where a reader expects it to. */
        CHECK(used <= best);
        CHECK(used == total || used > 0);
        if (best == total) CHECK_INT(used, total);
    }
}

/* --- Korean: the line breaks between syllables ---------------------------- *
 *
 * LVGL 9.5 has no Hangul range in lv_text_is_a_word() and LV_TXT_BREAK_CHARS
 * cannot name a codepoint above 0x7F, so a Korean leg wraps only at spaces. A
 * 170 px leg holds ten syllables and an eojeol runs two to five, which puts a
 * fifth of every line into the rag. UI_FIT_HANGUL takes the layout away from
 * LVGL: ui_fit.c fills the lines itself and hands down explicit '\n's, so there
 * is nothing left for LVGL to wrap.
 *
 * The stand-in face above already counts a Hangul syllable as one glyph — its
 * glyph_len() reads three-byte sequences — so the arithmetic in these cases is
 * the same "count it on a hand" arithmetic as in the Latin ones: ADV per
 * syllable, ADV per space, and a line of `w / ADV` columns.
 */

/* Hangul output is not a prefix of the source, so the cases below cannot go
 * through fit(). What still has to hold about every one of them lands here:
 * valid UTF-8, inside the buffer, inside the box, and — the property the whole
 * path exists for — no line wider than the measure once LVGL is handed it. */
static size_t fit_ko(int w, int h, int line_space, const char *src, char *dst, size_t n)
{
    g_bad_utf8 = 0;

    size_t used = ui_fit_text(&FACE, w, h, line_space, UI_FIT_HANGUL, src, dst, n);
    size_t len  = strlen(dst);

    CHECK(len < n);
    for (size_t i = 0; i < len; ) i += glyph_len(dst + i);
    CHECK(g_bad_utf8 == 0);
    CHECK(used <= strlen(src));

    if (len > 0) {
        lv_point_t sz;

        lv_text_get_size(&sz, dst, &FACE, 0, line_space, w, LV_TEXT_FLAG_NONE);
        CHECK(sz.y <= h);
        CHECK(!ws(dst[len - 1]));

        /* Each line measured on its own, unwrapped. A line wider than `w` is
         * the one failure this path could hide: LVGL would wrap it again under
         * the break we put in and the column would run over the rule below.
         * The single unit a measure cannot hold is the documented exception,
         * and it is at most a syllable and a mark. */
        size_t a = 0;
        for (size_t i = 0; i <= len; i++) {
            if (dst[i] != '\n' && dst[i] != '\0') continue;
            char save = dst[i];
            dst[i] = '\0';
            lv_text_get_size(&sz, dst + a, &FACE, 0, 0, 1 << 20, LV_TEXT_FLAG_NONE);
            dst[i] = save;
            CHECK(sz.x <= w || i - a <= 4);
            a = i + 1;
        }
    }
    return used;
}

static void t_hangul_fills_the_measure(void)
{
    /* 6 columns. Latin rule wraps at spaces: 가나다 / 라마바사 / 아자차카 / 타파하 = 4 lines.
     * Hangul rule breaks between syllables: 가나다 라마 / 바사 아자차 / 카 타파하 = 3. */
    const char *src = "가나다 라마바사 아자차카 타파하";
    char dst[128];
    size_t used = fit_ko(60, LH * 3, 0, src, dst, sizeof dst);
    CHECK_INT(used, strlen(src));                       /* everything fit in 3 lines */
    CHECK_STR(dst, "가나다 라마\n바사 아자차\n카 타파하");

    used = ui_fit_text(&FACE, 60, LH * 3, 0, UI_FIT_LATIN, src, dst, sizeof dst);
    CHECK(used < strlen(src));                          /* Latin rule needs 4 lines, so it cut */
}

static void t_no_break_before_closing_or_after_opening_punctuation(void)
{
    char dst[128];
    fit_ko(40, LH * 4, 0, "가나다라.마바(사아)", dst, sizeof dst);
    CHECK(strstr(dst, "\n.") == NULL);
    CHECK(strstr(dst, "\n)") == NULL);
    CHECK(strstr(dst, "(\n") == NULL);

    /* The backup is the mechanism, and this is what it did: four columns of
     * room filled to 라, which would have stranded the full stop at the head of
     * the next line, so the break moved back a syllable. */
    CHECK_STR(dst, "가나다\n라.마바\n(사아)");

    /* The CJK marks are the same rule and the ones a Korean edition actually
     * sets: 금칙 처리 forbids a line beginning with 。 or 、 exactly as it forbids
     * one beginning with a full stop, and the six brackets of U+3008..U+300F —
     * the whole of tools/hangul.py's CJK_PUNCT beside those two — pair off as
     * openers and closers. Each case below is the same four columns, so the
     * expected string is the same shape: the break backs up one syllable. */
    fit_ko(40, LH * 4, 0, "가나다라。마바", dst, sizeof dst);
    CHECK(strstr(dst, "\n。") == NULL);
    CHECK_STR(dst, "가나다\n라。마바");

    fit_ko(40, LH * 4, 0, "가나다라、마바", dst, sizeof dst);
    CHECK(strstr(dst, "\n、") == NULL);
    CHECK_STR(dst, "가나다\n라、마바");

    fit_ko(40, LH * 4, 0, "가나다라〉마바〈사아", dst, sizeof dst);
    CHECK(strstr(dst, "\n〉") == NULL);
    CHECK(strstr(dst, "〈\n") == NULL);
    CHECK_STR(dst, "가나다\n라〉마바\n〈사아");

    fit_ko(40, LH * 4, 0, "가나다라》마바《사아", dst, sizeof dst);
    CHECK(strstr(dst, "\n》") == NULL);
    CHECK(strstr(dst, "《\n") == NULL);
    CHECK_STR(dst, "가나다\n라》마바\n《사아");

    fit_ko(40, LH * 4, 0, "가나다라」마바「사아", dst, sizeof dst);
    CHECK(strstr(dst, "\n」") == NULL);
    CHECK(strstr(dst, "「\n") == NULL);
    CHECK_STR(dst, "가나다\n라」마바\n「사아");

    fit_ko(40, LH * 4, 0, "가나다라』마바『사아", dst, sizeof dst);
    CHECK(strstr(dst, "\n』") == NULL);
    CHECK(strstr(dst, "『\n") == NULL);
    CHECK_STR(dst, "가나다\n라』마바\n『사아");
}

static void t_hangul_cut_lands_on_a_boundary_and_continues_from_it(void)
{
    /* 6 columns, 2 lines: twelve glyphs of room. Line one ends on the full
     * stop (a break before "." is illegal, so "가나다라마." is one line of six);
     * stopping there would leave line two empty, so the cut fills line two
     * instead. The bytes consumed are exactly the source bytes of what was
     * set, so the next leg starts on the syllable after the cut. */
    const char *src = "가나다라마. 바사아자차카타파하";
    char dst[64];
    size_t used = fit_ko(60, LH * 2, 0, src, dst, sizeof dst);
    CHECK_STR(dst, "가나다라마.\n바사아자차카");
    CHECK_INT(used, strlen("가나다라마. 바사아자차카"));
    CHECK(src[used] != ' ');                            /* the next leg begins on ink, not a space */

    /* The sentence preference is the same rule it is in Latin, and here it is
     * free: one line of room ends on the full stop, and the space after it is
     * left in the source for the next leg to drop as its own leading space. */
    CHECK_INT(fit_ko(60, LH, 0, src, dst, sizeof dst), strlen("가나다라마."));
    CHECK_STR(dst, "가나다라마.");
}

/* A leg set one column after another must still tile the source: every byte
 * consumed by exactly one call, nothing repeated, nothing dropped but the
 * spaces at the joins. The Hangul path emits breaks that are not source bytes,
 * which is precisely the arithmetic that can get this wrong. */
static void t_hangul_continuation(void)
{
    static const char body[] =
        "삼성전자가 이번 분기에 시장의 예상을 크게 웃도는 실적을 내놓았다. "
        "메모리 가격이 바닥을 지났다는 신호가 여러 지표에서 동시에 나타났고, "
        "회사는 공급 과잉을 걱정하던 투자자들에게 구체적인 숫자를 제시했다. "
        "주가는 장 마감 직후 거래에서 상승했다.";

    char piece[64][96];
    size_t off = 0, np = 0;
    const size_t total = strlen(body);

    while (off < total && np < 64) {
        size_t used = fit_ko(100, LH * 3, LS, body + off, piece[np], sizeof piece[np]);
        CHECK(used > 0);                    /* no call may stall on real copy */
        CHECK(piece[np][0] != '\0');
        off += used;
        np++;
    }
    CHECK(off == total);                    /* the spans tile the source exactly */
    CHECK(np > 3);                          /* and this body really did need columns */
}

/* --- a number is one unit ------------------------------------------------- *
 *
 * The first Korean sheets came back with "3.53%" set as "3." and "53%" across a
 * break, because "." and "," are in LV_TXT_BREAK_CHARS. The tokeniser is the
 * answer: a maximal run of non-space, non-Hangul bytes is ONE unit, so there is
 * no boundary inside a figure for a break to land on. Swept across every
 * measure wide enough to hold the longer of them, because the failure is a
 * function of where the line happens to end. */
static void t_numbers_never_split(void)
{
    const char *src = "가나다라마 3.53% 바사아자차 1,631.47 카타파";
    char dst[128];

    for (int w = 80; w <= 200; w += 10) {
        size_t used = fit_ko(w, LH * 12, 0, src, dst, sizeof dst);
        CHECK_INT(used, strlen(src));
        CHECK(strstr(dst, "3.53%") != NULL);
        CHECK(strstr(dst, "1,631.47") != NULL);
    }

    /* And in a head, where the candidate list is the thing that has to leave
     * them alone: eleven glyphs into ten columns is two lines, and the split
     * that balances them is the one before the figure, not one inside it. */
    CHECK_INT(ui_fit_balance(&FACE, 100, 2, UI_FIT_HANGUL, "삼성전자3.53%급등", dst, sizeof dst), 2);
    CHECK_STR(dst, "삼성전자\n3.53%급등");
}

/* --- balancing a Korean head ---------------------------------------------- */

static void t_hangul_heads_balance_on_syllables(void)
{
    char dst[64];
    int lines = ui_fit_balance(&FACE, 60, 2, UI_FIT_HANGUL, "삼성전자급등마감", dst, sizeof dst);   /* 8 syllables, no spaces */
    CHECK_INT(lines, 2);
    CHECK_STR(dst, "삼성전자\n급등마감");

    /* The Latin rule has no boundary to work with in a head without spaces, so
     * it declines and leaves dst holding the source — which is what a Korean
     * head got before this, and why they came out as one long line. */
    CHECK_INT(ui_fit_balance(&FACE, 60, 2, UI_FIT_LATIN, "삼성전자급등마감", dst, sizeof dst), 0);
    CHECK_STR(dst, "삼성전자급등마감");

    /* A head WITH spaces is the case that says the new candidates are worth
     * having. Fourteen glyphs and two spaces into eleven columns is two lines
     * either way, but the two spaces both split it 10/4, and the syllable
     * boundary in the middle of the second eojeol splits it 8/8. */
    CHECK_INT(ui_fit_balance(&FACE, 110, 2, UI_FIT_HANGUL,
                             "코스피가 사상최고치를 경신했다", dst, sizeof dst), 2);
    CHECK_STR(dst, "코스피가 사상최\n고치를 경신했다");

    CHECK_INT(ui_fit_balance(&FACE, 110, 2, UI_FIT_LATIN,
                             "코스피가 사상최고치를 경신했다", dst, sizeof dst), 2);
    CHECK_STR(dst, "코스피가\n사상최고치를 경신했다");
}

/* --- picking the rule ----------------------------------------------------- */

static void t_script_from_lang(void)
{
    CHECK_INT(ui_fit_script("ko"), UI_FIT_HANGUL);
    CHECK_INT(ui_fit_script("en"), UI_FIT_LATIN);
    CHECK_INT(ui_fit_script("kor"), UI_FIT_LATIN);      /* the tag is normalised to two */
    CHECK_INT(ui_fit_script(""), UI_FIT_LATIN);
    CHECK_INT(ui_fit_script(NULL), UI_FIT_LATIN);
}

int main(void)
{
    t_degenerate();
    t_shorter_than_box();
    t_exact_and_over();
    t_word_boundary();
    t_sentence();
    t_fills_the_column();
    t_sentence_never_costs_a_line();
    t_utf8();
    t_dst_limit();
    t_continuation();
    t_matches_linear_scan();
    t_script_from_lang();
    t_hangul_fills_the_measure();
    t_no_break_before_closing_or_after_opening_punctuation();
    t_hangul_cut_lands_on_a_boundary_and_continues_from_it();
    t_hangul_continuation();
    t_numbers_never_split();
    t_hangul_heads_balance_on_syllables();
    TH_REPORT("fit");
}
