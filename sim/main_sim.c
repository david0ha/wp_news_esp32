/*
 * The desktop simulator — the sheet at 1200 x 1600, in the panel's six inks.
 *
 * This is not a preview. It builds the real ui_news.c on a real LVGL display of
 * the panel's own size, pushes every flushed pixel through the SAME
 * wp_quantize565() the firmware's flush callback calls, and lands the result in
 * a real 4 bpp epd6 framebuffer through epd6_fb_put(). Everything it then
 * asserts, it asserts on that framebuffer — so a colour decision that comes out
 * one way here comes out the same way on the glass, because it was not made
 * twice. A simulator that thresholded pixels itself would agree with itself and
 * with nothing else.
 *
 * WHAT THE ASSERTIONS BECAME, AND WHY
 * -----------------------------------
 * They used to be positions: "the lead rule lands on row 1108", "band 6 is
 * y 942 to 1118". Those cannot survive a page whose shape is chosen from what
 * arrived — and they were never the property anyone wanted anyway. What has
 * replaced them is a set of PROPERTIES, each of which holds for every payload
 * rather than for the three this file happens to build:
 *
 *   - the day's composition is a legal tiling of the well (ui_compose_check);
 *   - every module the compositor placed has ink in its rectangle;
 *   - no ink crosses the 30 px margin, and no two labels share paper;
 *   - every glyph of every string, fixed or from the payload, exists in every
 *     face that could be asked to draw it;
 *   - blue and yellow reach the glass nowhere but inside a photograph;
 *   - green and red reach it only inside the rectangles that legitimately carry
 *     a change figure — and those are read back OUT OF THE COMPOSITION rather
 *     than listed here, so they move when the page does;
 *   - the masthead sets inside the measure;
 *   - the page is not grey: it inks enough of the sheet, and it sets display
 *     type when it is carrying prose.
 *
 * That is a stronger claim than the old one and it is one nobody can satisfy by
 * moving a number in a header.
 *
 *   ./sim.sh                                            # the built-in demo snapshot
 *   NEWS_URL=http://localhost:8123/news.json ./sim.sh   # the device's own fetch path
 *   ./build/sim shots --json payload.json --tiles dir --only-pages
 */
#include "lvgl.h"

#include "ui_news.h"
#include "ui_internal.h"      /* the shared grid — see sim/CMakeLists.txt */
#include "ui_compose.h"
#include "ui_fonts.h"
#include "ui_strings.h"
#include "news_mock.h"
#include "news_model.h"
#include "news_parse.h"
#include "news_service.h"
#include "wp_palette.h"
#include "epd6_transpose.h"

#include <math.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>

/* The grid and the panel are two headers that must be describing one piece of
 * glass. They are not derived from each other — ui_internal.h is the page's
 * geometry and epd6_transpose.h is the controller's — so this is where the two
 * are made to agree, before a single assertion below is written against either. */
_Static_assert(UI_W == EPD6_W && UI_H == EPD6_H,
               "the page's sheet and the panel's framebuffer must be the same size");

/* --- the render path ------------------------------------------------------
 *
 * LVGL renders RGB565 into g_render, exactly as it does on the device; the
 * flush callback quantizes into g_fb, exactly as main.cpp's does. g_fb is the
 * bytes that would reach the controller, and it is the only thing the checks
 * below look at. */
static uint8_t g_render[(size_t)UI_W * UI_H * 2];
static uint8_t g_fb[EPD6_FB_SIZE];

/* What LVGL asked for, kept beside what the quantizer decided. It is only ever
 * read by a failure message, and it is the difference between the two reports a
 * stray colour can produce: "the page drew green here", which is a colour-policy
 * bug in a page file, and "the page drew something between two inks and the
 * dither landed on green", which is the anti-aliasing the policy exists to keep
 * off the sheet. Without it every such failure costs a bisect. */
static uint16_t g_want[(size_t)UI_W * UI_H];

static uint32_t g_tick;
static int      g_fail;
static bool     g_flushed;

#define FAILV(fmt, ...) do { g_fail++; printf("  FAIL " fmt "\n", __VA_ARGS__); } while (0)
#define FAIL(msg)       do { g_fail++; printf("  FAIL %s\n", (msg)); } while (0)

/* Enough of a failure to see the shape of it, not enough to bury the next
 * check. Every one of these prints coordinates: a count alone tells you the page
 * is wrong and not where. */
#define REPORT_MAX 6

static uint32_t tick_cb(void) { return g_tick; }

static void flush_cb(lv_display_t *d, const lv_area_t *a, uint8_t *px)
{
    const uint16_t *src = (const uint16_t *)px;

    /* The dither is positional, so x and y are SHEET coordinates and not
     * offsets inside the flushed area — the same trap main.cpp names, and the
     * same symptom if it is got wrong: the Bayer pattern seams at every strip
     * boundary and the two implementations stop agreeing pixel for pixel. */
    for (int y = a->y1; y <= a->y2; y++) {
        for (int x = a->x1; x <= a->x2; x++) {
            g_want[(size_t)y * UI_W + x] = *src;
            epd6_fb_put(g_fb, x, y, wp_quantize565(*src++, x, y));
        }
    }
    g_flushed = true;
    lv_display_flush_ready(d);
}

/* Repaint the whole sheet, from paper.
 *
 * The framebuffer is cleared to white first because that is what the panel is
 * after a refresh, and because a pass that rendered nothing would otherwise be
 * asserted against the PREVIOUS pass's pixels and quietly pass. */
static void render(void)
{
    memset(g_fb, (EPD6_WHITE << 4) | EPD6_WHITE, sizeof g_fb);
    memset(g_want, 0xFF, sizeof g_want);
    g_flushed = false;

    lv_obj_invalidate(lv_screen_active());
    for (int i = 0; i < 64 && !g_flushed; i++) {
        g_tick += 16;
        lv_timer_handler();
    }
    if (!g_flushed) FAIL("LVGL never flushed a frame — nothing was rendered");
}

/* --- reading the framebuffer ---------------------------------------------- */

static const char *const INK_NAME[WP_PALETTE_N] = {
    "black", "white", "red", "yellow", "blue", "green",
};

static int ink_at(int x, int y)
{
    if (x < 0 || y < 0 || x >= UI_W || y >= UI_H) return WP_I_WHITE;

    const int i = wp_index_of(epd6_fb_get(g_fb, x, y));
    if (i < 0) {
        FAILV("(%d,%d) holds 0x%02X, which is not one of the six inks",
              x, y, epd6_fb_get(g_fb, x, y));
        return WP_I_WHITE;
    }
    return i;
}

static bool is_ink(int x, int y)   { return ink_at(x, y) != WP_I_WHITE; }
static bool is_black(int x, int y) { return ink_at(x, y) == WP_I_BLACK; }

/* The colour LVGL asked for at a pixel, expanded back out of RGB565 the way
 * wp_quantize565() expands it, so a failure reports the value the quantizer
 * actually saw and not a rounding of it. */
static const char *wanted_at(int x, int y)
{
    static char buf[40];

    const uint16_t c = g_want[(size_t)y * UI_W + x];
    const int r5 = (c >> 11) & 0x1F, g6 = (c >> 5) & 0x3F, b5 = c & 0x1F;

    snprintf(buf, sizeof buf, "#%02X%02X%02X",
             (r5 << 3) | (r5 >> 2), (g6 << 2) | (g6 >> 4), (b5 << 3) | (b5 >> 2));
    return buf;
}

static bool any_ink(int x0, int y0, int x1, int y1)
{
    for (int y = y0; y < y1; y++) {
        for (int x = x0; x < x1; x++) {
            if (is_ink(x, y)) return true;
        }
    }
    return false;
}

static void want_ink(const char *what, int x0, int y0, int x1, int y1)
{
    if (!any_ink(x0, y0, x1, y1)) {
        FAILV("%s: nothing rendered in x[%d..%d) y[%d..%d)", what, x0, x1, y0, y1);
    }
}

static void want_blank(const char *what, int x0, int y0, int x1, int y1)
{
    for (int y = y0; y < y1; y++) {
        for (int x = x0; x < x1; x++) {
            if (is_ink(x, y)) {
                FAILV("%s: unexpected %s ink at (%d,%d)",
                      what, INK_NAME[ink_at(x, y)], x, y);
                return;
            }
        }
    }
}

static double ink_pct(void)
{
    long on = 0;
    for (int y = 0; y < UI_H; y++) {
        for (int x = 0; x < UI_W; x++) {
            if (epd6_fb_get(g_fb, x, y) != EPD6_WHITE) on++;
        }
    }
    return 100.0 * (double)on / ((double)UI_W * UI_H);
}

/* --- the preview image ----------------------------------------------------
 *
 * 24-bit BMP in wp_palette_ink, which is roughly what Spectra 6 actually looks
 * like: a warm off-white, a brick red, an olive green. The saturated palette the
 * UI draws with would make every screenshot a cartoon, and the whole reason
 * sim/shots/ is looked at after a UI change is to judge the page as paper. */
static void write_preview(const char *path)
{
    const int stride = (UI_W * 3 + 3) & ~3;
    const int data   = stride * UI_H;
    const int size   = 54 + data;

    uint8_t hdr[54] = { 0 };
    hdr[0] = 'B'; hdr[1] = 'M';
    hdr[2] = (uint8_t)size;        hdr[3] = (uint8_t)(size >> 8);
    hdr[4] = (uint8_t)(size >> 16); hdr[5] = (uint8_t)(size >> 24);
    hdr[10] = 54; hdr[14] = 40;
    hdr[18] = (uint8_t)UI_W;        hdr[19] = (uint8_t)(UI_W >> 8);
    hdr[22] = (uint8_t)UI_H;        hdr[23] = (uint8_t)(UI_H >> 8);
    hdr[26] = 1;  hdr[28] = 24;
    hdr[34] = (uint8_t)data;        hdr[35] = (uint8_t)(data >> 8);
    hdr[36] = (uint8_t)(data >> 16); hdr[37] = (uint8_t)(data >> 24);

    FILE *f = fopen(path, "wb");
    if (!f) { FAILV("cannot write %s", path); return; }
    fwrite(hdr, 1, sizeof hdr, f);

    uint8_t *row = calloc(1, (size_t)stride);
    if (!row) { fclose(f); FAIL("out of memory writing the preview"); return; }

    /* BMP rows run bottom-up and its channels are BGR. */
    for (int y = UI_H - 1; y >= 0; y--) {
        for (int x = 0; x < UI_W; x++) {
            const uint8_t *c = wp_palette_ink[ink_at(x, y)];
            row[x * 3 + 0] = c[2];
            row[x * 3 + 1] = c[1];
            row[x * 3 + 2] = c[0];
        }
        fwrite(row, 1, (size_t)stride, f);
    }
    free(row);
    fclose(f);
}

static void shot(const char *dir, const char *name)
{
    char path[512];
    snprintf(path, sizeof path, "%s/%s.bmp", dir, name);
    write_preview(path);
    printf("  %-18s %5.2f%% ink   %s\n", name, ink_pct(), path);
}

/* --- glyph coverage -------------------------------------------------------
 *
 * The tempting version of this looks in the bitmap for the hollow rectangle
 * LVGL draws in place of a missing glyph — unreliable, and unnecessary, because
 * the font will simply say. Half these strings arrive over the network, so the
 * check has to run over the DATA and not only over the source literals. */

static uint32_t utf8_next(const char *s, int *i)
{
    unsigned char c = (unsigned char)s[*i];
    int extra = c < 0x80 ? 0 : (c < 0xE0 ? 1 : (c < 0xF0 ? 2 : 3));
    uint32_t cp = c < 0x80 ? c : (c & (0x3F >> extra));
    int k = 0;
    while (k < extra && s[*i + 1 + k]) {
        cp = (cp << 6) | ((unsigned char)s[*i + 1 + k] & 0x3F);
        k++;
    }
    *i += k + 1;
    return cp;
}

static void cover(const lv_font_t *font, const char *label, const char *text)
{
    if (!text) return;
    int i = 0;
    while (text[i]) {
        const int at = i;
        const uint32_t cp = utf8_next(text, &i);
        if (cp == '\n' || cp == '\r') continue;
        lv_font_glyph_dsc_t dsc;
        if (!lv_font_get_glyph_dsc(font, &dsc, cp, 0)) {
            FAILV("%s: U+%04X (byte %d of \"%s\") missing from the font -> tofu",
                  label, cp, at, text);
            return;
        }
    }
}

/* Every text face, not only the one that draws the string today.
 *
 * The six text faces are deliberately identical in coverage (ASCII + Latin-1 +
 * S_DATA_PUNCT), and the compositor moves strings between them freely: a
 * headline demoted across a gutter changes face without changing a byte, and a
 * module one column narrower sets its body in body_16 where it set body_20
 * yesterday. Checking only today's face would let a regression through until the
 * day a payload arrived one story shorter.
 *
 * ui_font_masthead_112 is deliberately absent. It is subset to the Latin
 * alphabet, it draws exactly one string, and that string is checked against it
 * by name below. */
static const lv_font_t *const TEXT_FACES[] = {
    &ui_font_display_56, &ui_font_display_36, &ui_font_deck_24,
    &ui_font_body_20,    &ui_font_body_16,    &ui_font_label_14,
};

static void cover_all(const char *label, const char *text)
{
    for (size_t i = 0; i < sizeof TEXT_FACES / sizeof *TEXT_FACES; i++) {
        cover(TEXT_FACES[i], label, text);
    }
}

/* The mean advance of a face over a sample, measured with the same
 * lv_text_get_size() every copyfit uses — so it is the number the layout
 * actually experiences rather than a design value off the family's specimen.
 *
 * TWO samples are worth having and they are not the same number. Over printable
 * ASCII it is a property of the FACE, weighted by nothing, and every capital and
 * every bracket counts as much as an 'e'. Over a paragraph of English it is a
 * property of the face SETTING PROSE, which is what a characters-per-column
 * table is actually about, and it comes out about seven per cent narrower
 * because English is mostly lower case. A table that divides a column width by
 * the first and calls the answer "characters per line" overstates the measure. */
static double mean_advance(const lv_font_t *f, const char *sample)
{
    if (!sample || !sample[0]) return 0.0;

    int n = 0;
    for (const char *p = sample; *p; p++) {
        if ((*p & 0xC0) != 0x80) n++;       /* count characters, not bytes */
    }

    lv_point_t sz;
    lv_text_get_size(&sz, sample, f, 0, 0, LV_COORD_MAX, LV_TEXT_FLAG_NONE);
    return n > 0 ? (double)sz.x / n : 0.0;
}

static const char *ascii_sample(void)
{
    static char s[95 + 1];
    int n = 0;

    for (int c = 32; c < 127; c++) s[n++] = (char)c;
    s[n] = '\0';
    return s;
}

/* The prose every face is measured against, and it is FIXED HERE rather than
 * taken from the day's payload.
 *
 * A characters-per-column table is a documented number, so it has to be a
 * property of the seven committed font files and of nothing else. Measured over
 * the demo snapshot's own body it would move the moment somebody rewrote the
 * mock, and the table in docs/pages.md would go stale with no one able to see
 * why. This is four sentences of ordinary newspaper English at ordinary letter
 * frequencies — which is the whole point, since English is mostly lower case and
 * a mean weighted by nothing overstates the measure by about a tenth.
 *
 * Do not "improve" it. Changing the sample changes every figure derived from it,
 * and the only thing worse than one undocumented basis is two. */
#define SIM_PROSE_SAMPLE \
    "The company said on Thursday that contract prices for its densest parts " \
    "had risen for the first time since the spring, and that the increase was " \
    "larger than the distributors had been told to expect. Three of the four " \
    "suppliers took it. What changed is not demand, which has been flat all " \
    "year, but the willingness of buyers to hold stock against a market they " \
    "now expect to tighten before the winter."

/* Every face the page sets type in, in the order they appear on the sheet. The
 * masthead is included even though it draws one string: a nameplate that grew
 * wider than the measure is the failure check_masthead() exists for, and this is
 * the number that would have predicted it. */
static const struct { const char *name; const lv_font_t *f; } FACES[] = {
    { "masthead_112", &ui_font_masthead_112 },
    { "display_56",   &ui_font_display_56   },
    { "display_36",   &ui_font_display_36   },
    { "deck_24",      &ui_font_deck_24      },
    { "body_20",      &ui_font_body_20      },
    { "body_16",      &ui_font_body_16      },
    { "label_14",     &ui_font_label_14     },
};

/* `sim --measure`: the advance table, for the one in docs/pages.md and the one
 * in ui_internal.h. Both derive characters-per-column from these, and both have
 * at times carried a figure nobody could say the basis of — which is how three
 * different numbers for body_16 came to be in circulation at once. Printing
 * every face on both bases from one command is what makes the table something
 * somebody read rather than something two files assert at each other. */
static void print_measures(void)
{
    printf("face          ascii   prose   line_height   "
           "1col   2col   3col   4col  (characters, prose)\n");

    for (size_t i = 0; i < sizeof FACES / sizeof *FACES; i++) {
        const double a = mean_advance(FACES[i].f, ascii_sample());
        const double p = mean_advance(FACES[i].f, SIM_PROSE_SAMPLE);

        printf("%-12s %6.2f  %6.2f  %11d   ", FACES[i].name, a, p,
               lv_font_get_line_height(FACES[i].f));
        for (int c = 1; c <= 4; c++) {
            printf("%5d  ", p > 0.0 ? (int)(UI_COL(c) / p) : 0);
        }
        printf("\n");
    }

    printf("\nascii: mean over printable ASCII 32..126, the face weighted by "
           "nothing.\nprose: mean over a fixed paragraph of English "
           "(SIM_PROSE_SAMPLE in sim/main_sim.c).\nThe character counts are "
           "prose; a Title Case headline sets a little wider.\n");

    /* The two nameplates, because both are set to FILL the measure and neither
     * failure is one a check can state. Too wide fails check_masthead(); too
     * narrow is silent, and a flag with two hundred pixels of paper down each
     * side is a poster with a title on it. Renaming the paper means reading
     * these two lines and putting the answers in UI_MAST_TRACK and RH_W. */
    lv_point_t sz;

    lv_text_get_size(&sz, S_MASTHEAD, &ui_font_masthead_112, UI_MAST_TRACK, 0,
                     LV_COORD_MAX, LV_TEXT_FLAG_NONE);
    printf("\nA1 flag  mark %d + gap %d + \"%s\" %d at tracking %d = %d of %d"
           "  (%d px of paper each side)\n",
           UI_LOGO_W, UI_LOGO_GAP, S_MASTHEAD, (int)sz.x, UI_MAST_TRACK,
           UI_LOGO_W + UI_LOGO_GAP + (int)sz.x, UI_CONTENT_W,
           (UI_CONTENT_W - (UI_LOGO_W + UI_LOGO_GAP + (int)sz.x)) / 2);

    lv_text_get_size(&sz, S_RUNNING_HEAD, &ui_font_display_56, 2, 0,
                     LV_COORD_MAX, LV_TEXT_FLAG_NONE);
    printf("A2 head  \"%s\" %d of the %d box\n",
           S_RUNNING_HEAD, (int)sz.x, UI_COL(4));
}

/* Every WORD the board supplies, as opposed to every string the payload does.
 * Hoisted out of check_fixed_strings() because two checks read it: that one
 * asks whether the faces can draw them, and check_fixed_labels_fit() asks
 * whether the page has room for them.
 *
 * Only things a label is actually SET FROM belong here, which is why the
 * characters that exist to be covered live in REPERTOIRE[] below. The second
 * check identifies a label by matching its text against this table, so a
 * coverage-only string in it would become a candidate board word — and "the
 * digits" is not a word any slot has to hold. */
static const char *const FIXED[] = {
    S_RUNNING_HEAD, S_BRAND,
    S_BADGE_DEMO, S_BADGE_STALE, S_BADGE_OFFLINE, S_NO_DATA, S_WAITING,
    S_KEY_PAGE, S_KEY_REFRESH, S_KEY_WIFI,
    S_PAGE_FRONT, S_PAGE_MARKETS,
    S_PEERS, S_INSIDE, S_IN_BRIEF, S_EMPTY_CELL,
    S_COL_SYMBOL, S_COL_NAME, S_COL_PE, S_COL_CAP, S_COL_LAST, S_COL_CHG,
    /* The same twelve in Korean. They are checked on every run and not only
     * on the Korean one, because coverage is a property of the committed
     * faces rather than of the payload in front of the simulator: a face
     * regenerated without the Hangul fallback would otherwise pass the demo
     * run and fail on the day an edition arrives in Korean.
     *
     * Every one of them goes through cover_all(), which asks all six Latin
     * text faces — and each of those resolves Hangul through the Korean face
     * chained behind it. So this checks the CHAIN, which is the thing that
     * can break, and not merely that six Korean fonts were compiled in. */
    S_KO_BADGE_DEMO, S_KO_BADGE_STALE, S_KO_BADGE_OFFLINE,
    S_KO_PEERS, S_KO_INSIDE, S_KO_IN_BRIEF,
    S_KO_COL_SYMBOL, S_KO_COL_NAME, S_KO_COL_PE, S_KO_COL_CAP,
    S_KO_COL_LAST, S_KO_COL_CHG,
    S_WIFI_TITLE, S_RESTARTING,
    /* The setup sheet's standing type. It is the longest fixed copy on the
     * board and the first page a new owner sees, so a character outside the
     * faces' coverage would be a tofu box in the one place nobody can
     * afford one. */
    S_SETUP_KICKER, S_SETUP_KEYS, S_SETUP_DECK, S_SETUP_NETWORK,
    S_SETUP_ABOUT_H, S_SETUP_ABOUT, S_SETUP_AFTER_H, S_SETUP_AFTER,
    S_SETUP_TROUBLE_H, S_SETUP_TROUBLE,
    S_SETUP_SOURCE_H, S_SETUP_SOURCE,
};

/* Characters that exist only inside a runtime-composed string — the separators
 * the tape and the briefs put between two fields, the digits and the decimal
 * point of every figure ui_money() and ui_pct() produce. This is the check that
 * catches the whole class of bug where a label renders but the space in
 * "%s %s" comes out as a box.
 *
 * A repertoire and not a word: no label is ever set from one of these, so only
 * the coverage loop reads this table. */
static const char *const REPERTOIRE[] = {
    S_COMPOSED_CHARS,
    S_DATA_PUNCT,
    "0123456789",
    "\xC2\xB7",                     /* the tape's separator */
};

static void check_fixed_strings(void)
{
    for (size_t i = 0; i < sizeof FIXED / sizeof *FIXED; i++) {
        cover_all("fixed string", FIXED[i]);
    }
    for (size_t i = 0; i < sizeof REPERTOIRE / sizeof *REPERTOIRE; i++) {
        cover_all("fixed string", REPERTOIRE[i]);
    }

    /* The caps spellings the no-payload dateline is composed from, which is the
     * one slot on the sheet whose string is built rather than set. */
    static const char *const WD_CAPS[7] = S_WEEKDAYS_CAPS;
    static const char *const MONTHS[12] = S_MONTHS_CAPS;
    for (int i = 0; i < 7; i++)  cover_all("weekday", WD_CAPS[i]);
    for (int i = 0; i < 12; i++) cover_all("month", MONTHS[i]);

    /* The masthead face against the one string it exists to draw, and against
     * nothing else. Editing S_MASTHEAD without regenerating the fonts is exactly
     * the mistake this catches, on the largest text on the sheet. */
    cover(&ui_font_masthead_112, "masthead", S_MASTHEAD);
}

/* Every string in the snapshot that will be set, against every face that could
 * set it. With Latin-1-complete faces this should never fail on a name — which
 * is the point: if it ever does, the payload holds something outside ASCII,
 * Latin-1 and S_DATA_PUNCT (a Cyrillic byline, a CJK place name, an emoji) and
 * that is a real decision to make about the font rather than a mystery box that
 * appears after a twenty-five-second refresh. */
static void check_data_strings(const news_t *v)
{
    cover_all("edition",      v->edition);
    cover_all("dateline",     v->dateline);
    cover_all("session",      v->session);
    cover_all("as_of",        v->as_of);
    cover_all("generated_at", v->generated_at);

    cover_all("subject symbol",   v->subject.symbol);
    cover_all("subject name",     v->subject.name);
    cover_all("subject exchange", v->subject.exchange);
    cover_all("subject sector",   v->subject.sector);

    for (int i = 0; i < v->index_count; i++) {
        cover_all("index symbol", v->indices[i].symbol);
        cover_all("index name",   v->indices[i].name);
    }
    for (int i = 0; i < v->story_count; i++) {
        const news_story_t *s = &v->stories[i];
        cover_all("kicker",   s->kicker);
        cover_all("headline", s->headline);
        cover_all("deck",     s->deck);
        cover_all("byline",   s->byline);
        cover_all("body",     s->body);
        cover_all("caption",  s->photo.caption);
        cover_all("credit",   s->photo.credit);
    }
    for (int i = 0; i < v->figure_count; i++) {
        cover_all("figure group", v->figures[i].group);
        cover_all("figure label", v->figures[i].label);
        cover_all("figure value", v->figures[i].value);
    }
    for (int i = 0; i < v->brief_count; i++) {
        cover_all("brief date",   v->briefs[i].date);
        cover_all("brief kicker", v->briefs[i].kicker);
        cover_all("brief text",   v->briefs[i].text);
    }
    for (int i = 0; i < v->peer_count; i++) {
        cover_all("peer symbol", v->peers[i].symbol);
        cover_all("peer name",   v->peers[i].name);
        cover_all("peer P/E",    v->peers[i].per);
        cover_all("peer cap",    v->peers[i].cap);
    }
    for (int i = 0; i < v->table_count; i++) {
        const news_table_t *t = &v->tables[i];
        cover_all("table title", t->title);
        cover_all("table note",  t->note);
        for (int c = 0; c < t->col_count; c++) cover_all("table column", t->col[c]);
        for (int r = 0; r < t->row_count; r++) {
            cover_all("table row", t->row[r].label);
            for (int c = 0; c < t->col_count; c++) {
                cover_all("table cell", t->row[r].v[c]);
            }
        }
    }
    for (int i = 0; i < v->chart_count; i++) {
        cover_all("chart label", v->charts[i].label);
        cover_all("chart span",  v->charts[i].span);
        cover_all("chart note",  v->charts[i].note);
    }
    for (int i = 0; i < v->thumb_count; i++) {
        cover_all("thumb caption", v->thumbs[i].caption);
        cover_all("thumb credit",  v->thumbs[i].credit);
    }
}

/* --- the furniture --------------------------------------------------------
 *
 * Four strips and four rules, and they are all that is left of the fixed
 * geometry: the nameplate, the ruled line under it, the tape, and the folio.
 * They print on both pages whatever the news did, so they are checked on both.
 *
 * The rules inside the WELL are not here and cannot be: they are the boundaries
 * between the day's bands, they are as wide as the columns that end on them, and
 * where they land is the composition's business. ui_compose_check() is what
 * covers those. */
static const struct { const char *name; int y, w; } SHEET_RULES[] = {
    { "masthead", UI_MAST_RULE_Y,     UI_MAST_RULE_W     },
    { "dateline", UI_DATELINE_RULE_Y, UI_DATELINE_RULE_W },
    { "tape",     UI_TAPE_RULE_Y,     UI_TAPE_RULE_W     },
};
#define NRULES ((int)(sizeof SHEET_RULES / sizeof *SHEET_RULES))

/* A rule is black on every one of its rows across the whole measure, with no
 * tolerance at all. It is a filled rectangle in an exact palette colour, so it
 * cannot dither and cannot be part-covered by anything: one pixel of paper in
 * the middle of a 1140 px hairline means a widget was drawn over it in white,
 * and that is a layout fault however small it looks. */
static void check_rule(const char *pass, const char *name, int y0, int weight)
{
    for (int y = y0; y < y0 + weight; y++) {
        int broke = 0;
        for (int x = UI_CONTENT_X; x < UI_CONTENT_R; x++) {
            if (is_black(x, y)) continue;
            if (broke++ == 0) {
                FAILV("%s: the %s rule breaks at (%d,%d) — %s, not black",
                      pass, name, x, y, INK_NAME[ink_at(x, y)]);
            }
        }
        if (broke > 1) {
            printf("       ...and %d more pixels of that row\n", broke - 1);
        }
    }
}

static void check_rules(const char *pass)
{
    for (int r = 0; r < NRULES; r++) {
        check_rule(pass, SHEET_RULES[r].name, SHEET_RULES[r].y, SHEET_RULES[r].w);
    }
}

static void check_furniture(const char *pass, bool front)
{
    char what[96];

    check_rules(pass);

    snprintf(what, sizeof what, "%s: the nameplate", pass);
    want_ink(what, UI_CONTENT_X, UI_MAST_Y, UI_CONTENT_R, UI_MAST_Y + UI_MAST_H);
    snprintf(what, sizeof what, "%s: the dateline row", pass);
    want_ink(what, UI_CONTENT_X, UI_DATELINE_Y, UI_CONTENT_R,
             UI_DATELINE_Y + UI_DATELINE_H);
    snprintf(what, sizeof what, "%s: the tape", pass);
    want_ink(what, UI_CONTENT_X, UI_TAPE_Y, UI_CONTENT_R, UI_TAPE_Y + UI_TAPE_H);
    (void)front;
}

/* Nothing crosses the margin, on any of the four sides.
 *
 * ONE PIXEL OF SLACK, and only on the left and right, because a glyph's ink is
 * allowed to start left of its origin and several of ours do. In
 * ui_font_display_56, A J V W j v y all carry ofs_x = -1: a Didone's pointed
 * foot and its flat apex serif overhang, which is how the family is drawn and
 * why a headline set flush left OPTICALLY aligns with the body text beneath it.
 * A real overrun is always two pixels or more. */
#define MARGIN_BEARING 1

static void check_margins(const char *pass)
{
    static const struct { const char *side; int x0, y0, x1, y1; } EDGE[] = {
        { "top",    0,                              0,            UI_W,         UI_CONTENT_Y },
        { "bottom", 0,                              UI_CONTENT_B, UI_W,         UI_H         },
        { "left",   0,                              0,            UI_CONTENT_X - MARGIN_BEARING, UI_H },
        { "right",  UI_CONTENT_R + MARGIN_BEARING,  0,            UI_W,         UI_H         },
    };
    for (size_t i = 0; i < sizeof EDGE / sizeof *EDGE; i++) {
        char what[96];
        snprintf(what, sizeof what, "%s: the %s margin", pass, EDGE[i].side);
        want_blank(what, EDGE[i].x0, EDGE[i].y0, EDGE[i].x1, EDGE[i].y1);
    }
}

/* The masthead, measured off the glass rather than off the font tables.
 *
 * The flag sets 1048 px of the 1140 available, and this is the one measurement
 * in the whole design that can only fail at full size: a face regenerated a
 * fraction wider, or a longer paper name, and the largest text on the sheet
 * either ellipsizes or stops being centred. Both are visible from across a room
 * and neither is visible in any host test.
 *
 * IT SCANS THE BAND AND NOT THE LABEL, which is what makes it the right check
 * for a flag that is a drawn mark and a label set beside it. Neither object is
 * centred in the measure and neither could be — build_masthead() centres their
 * combined INK, which is the thing a reader sees and the thing this measures.
 * A check that read the label's own coordinates would pass a page whose mark had
 * drifted off the end of the paper. */
static void check_masthead(const char *pass)
{
    int l = -1, r = -1;

    for (int x = UI_CONTENT_X; x < UI_CONTENT_R; x++) {
        for (int y = UI_MAST_Y; y < UI_MAST_RULE_Y; y++) {
            if (!is_ink(x, y)) continue;
            if (l < 0) l = x;
            r = x;
            break;
        }
    }

    if (l < 0) {
        FAILV("%s: the masthead band rendered nothing", pass);
        return;
    }

    const int w = r - l + 1;
    if (w > UI_CONTENT_W) {
        FAILV("%s: the masthead measures %d px across x[%d..%d] — %d over the %d measure",
              pass, w, l, r, w - UI_CONTENT_W, UI_CONTENT_W);
    }

    const int gap_l = l - UI_CONTENT_X;
    const int gap_r = UI_CONTENT_R - 1 - r;
    if (gap_l - gap_r > 4 || gap_r - gap_l > 4) {
        FAILV("%s: the masthead is off centre — %d px of paper on the left, %d on the right",
              pass, gap_l, gap_r);
    }
}

/* --- the widget tree ------------------------------------------------------
 *
 * Two things are read out of it and neither can be got from the framebuffer: a
 * LABEL printed over another label, which is two black boxes that look like one
 * smear, and where the photographs landed, which is the one region on the sheet
 * where all six inks are legal. */
#define SIM_LABELS_MAX 2048
#define SIM_ART_MAX      16

static struct { lv_area_t a; const char *txt; const lv_font_t *font; int track; }
             g_lab[SIM_LABELS_MAX];
static int   g_labs;

static lv_area_t g_art[SIM_ART_MAX];
static int       g_arts;

static bool blank_text(const char *s)
{
    for (; *s; s++) if (*s != ' ' && *s != '\n' && *s != '\r' && *s != '\t') return false;
    return true;
}

static void walk(lv_obj_t *o, int depth)
{
    if (!o || lv_obj_has_flag(o, LV_OBJ_FLAG_HIDDEN)) return;

    if (depth > 0) {
        if (lv_obj_check_type(o, &lv_label_class)) {
            const char *txt = lv_label_get_text(o);
            if (txt && !blank_text(txt) && g_labs < SIM_LABELS_MAX) {
                lv_obj_get_coords(o, &g_lab[g_labs].a);
                g_lab[g_labs].txt  = txt;
                g_lab[g_labs].font = lv_obj_get_style_text_font(o, LV_PART_MAIN);
                /* The tracking too, because every caps label on this sheet
                 * carries some and a measurement that leaves it out understates
                 * a six-letter head by a dozen pixels. */
                g_lab[g_labs].track =
                    lv_obj_get_style_text_letter_space(o, LV_PART_MAIN);
                g_labs++;
            }
        } else if (lv_obj_check_type(o, &lv_image_class)) {
            /* The picture's own box is the whole TILE, hung at a negative offset
             * inside a pane that crops it — see ui_modules.c — so what is
             * exempted from the colour policy is the pane, which is the only ink
             * that actually reached the glass. Exempting the image's own
             * rectangle would open a hole the size of the uncropped photograph
             * across half the sheet. */
            if (lv_image_get_src(o) && g_arts < SIM_ART_MAX) {
                lv_obj_get_coords(lv_obj_get_parent(o), &g_art[g_arts++]);
            }
        }
    }

    const uint32_t n = lv_obj_get_child_count(o);
    for (uint32_t i = 0; i < n; i++) walk(lv_obj_get_child(o, i), depth + 1);
}

static void scan_tree(void)
{
    g_labs = 0;
    g_arts = 0;
    walk(lv_screen_active(), 0);
}

/* Type printed over type, which no pixel predicate can catch: both copies are
 * black, both are inside their module, and the result is a smear that reads as a
 * rendering fault rather than as a layout one. It is worth its own assertion
 * because the way it happens is structural — a measurement and a placement that
 * disagree by a line.
 *
 * LABELS only, and only labels with text in them. Panes overlap by design (a
 * module holds its children, a marks pane spans its module) and an empty label
 * is a slot the payload did not fill, which is the normal case. */
static void check_label_overlap(const char *pass)
{
    int seen = 0;

    for (int i = 0; i < g_labs; i++) {
        for (int j = i + 1; j < g_labs; j++) {
            const lv_area_t *a = &g_lab[i].a, *b = &g_lab[j].a;
            if (a->x1 > b->x2 || b->x1 > a->x2) continue;
            if (a->y1 > b->y2 || b->y1 > a->y2) continue;

            if (seen++ < REPORT_MAX) {
                FAILV("%s: \"%s\" at x[%d..%d] y[%d..%d] is printed over \"%s\" "
                      "at x[%d..%d] y[%d..%d]",
                      pass, g_lab[i].txt, a->x1, a->x2, a->y1, a->y2,
                      g_lab[j].txt, b->x1, b->x2, b->y1, b->y2);
            }
        }
    }
    if (seen > REPORT_MAX) {
        printf("       ...and %d more pairs of labels sharing paper\n", seen - REPORT_MAX);
    }
}

/* A word the BOARD wrote, wider than the box the page gave it.
 *
 * Its slot is fixed and its text is not the payload's, so the two must have been
 * measured against each other at design time — and when they were not, LVGL
 * silently writes an ellipsis, because every label on this sheet is
 * LV_LABEL_LONG_MODE_DOTS. "MKT C…" over a column of market capitalisations is
 * not a rendering fault and not an overlap; it is a head that has stopped being
 * a word, and nothing else in this file would have said so.
 *
 * FIXED STRINGS ONLY, and that restriction is the whole reason the check can be
 * strict. A headline, a deck and a caption are ellipsized ON PURPOSE — the
 * budgets in tools/edition/PROMPT.md exist because the board cuts an overlong
 * one rather than reflowing the page — so a check that failed on any ellipsis
 * would fail on the design. The board's own twelve words are the opposite case:
 * they are chosen, they are short, and there is no producer to blame.
 *
 * It earns its place with a second language on the sheet. A Hangul syllable at
 * label_14 is a full em where a Latin capital is about half of one, so 시가총액
 * is as wide as eight English letters in a field sized for seven, and the only
 * way to know before this check existed was to open the PNG and read Korean.
 *
 * The measurement matches what LVGL will do: the label's own face, the label's
 * own letter_space, no wrap. One pixel of slack is allowed, because tracking is
 * applied per character including the last and a head cut to fit exactly can
 * measure a pixel over the box LVGL then draws it in happily. */
/* The board string a label was set from, or NULL, with `dotted` saying whether
 * LVGL has already eaten the end of it.
 *
 * That second answer is the whole difficulty. LV_LABEL_LONG_MODE_DOTS does not
 * flag a label as truncated: it OVERWRITES the label's own text buffer with the
 * shortened spelling and keeps the eaten characters privately, so by the time
 * anything walks the tree the label no longer says what the page asked it to. A
 * check that compared the text it found against the twelve words would
 * therefore pass on exactly the labels it exists to catch. What survives the
 * overwrite is the shape: a prefix of the original, then three ASCII dots. */
static const char *board_string_of(const char *s, bool *dotted)
{
    for (size_t i = 0; i < sizeof FIXED / sizeof *FIXED; i++) {
        if (strcmp(s, FIXED[i]) == 0) { *dotted = false; return FIXED[i]; }
    }

    /* Not one of them as it stands — so is it one of them with its tail eaten?
     * S_WAITING ends in three dots of its own, which is why the exact match
     * above runs first and this only ever sees a string that is none of them. */
    const size_t n = strlen(s);
    if (n <= 3 || strcmp(s + n - 3, "...") != 0) return NULL;

    for (size_t i = 0; i < sizeof FIXED / sizeof *FIXED; i++) {
        if (strlen(FIXED[i]) <= n - 3) continue;
        if (strncmp(s, FIXED[i], n - 3) == 0) { *dotted = true; return FIXED[i]; }
    }
    return NULL;
}

static void check_fixed_labels_fit(const char *pass)
{
    for (int i = 0; i < g_labs; i++) {
        if (!g_lab[i].font) continue;

        bool dotted = false;
        const char *want = board_string_of(g_lab[i].txt, &dotted);
        if (!want) continue;

        /* The width the page would need for the WHOLE word, measured the way
         * LVGL will draw it: the label's own face and its own tracking. */
        lv_point_t sz;
        lv_text_get_size(&sz, want, g_lab[i].font, g_lab[i].track, 0,
                         LV_COORD_MAX, LV_TEXT_FLAG_NONE);

        const int box = g_lab[i].a.x2 - g_lab[i].a.x1 + 1;
        const int hbox = g_lab[i].a.y2 - g_lab[i].a.y1 + 1;

        /* The width test is for ONE-LINE slots only — every badge, head and
         * column head on both sheets is one. A fixed string in a box deep
         * enough to wrap is allowed to be wider than the measure, because it
         * will use the second line; measuring it against LV_COORD_MAX would
         * fail the setup sheet's standing paragraphs for doing their job. The
         * dotted test needs no such caveat: LVGL writes dots only when the text
         * has overflowed the box it was actually given, on any number of
         * lines. */
        const bool one_line = hbox < 2 * lv_font_get_line_height(g_lab[i].font);
        if (!dotted && (!one_line || (int)sz.x <= box + 1)) continue;

        FAILV("%s: \"%s\" wants %d px and has a %d px slot at x[%d..%d] "
              "y[%d..%d] — it prints as \"%s\". Shorten the WORD, not the column",
              pass, want, (int)sz.x, box, g_lab[i].a.x1, g_lab[i].a.x2,
              g_lab[i].a.y1, g_lab[i].a.y2, g_lab[i].txt);
    }
}

/* --- colour ---------------------------------------------------------------
 *
 * Colour on this sheet is data, and there are exactly TWO things a coloured
 * pixel is allowed to mean. Every check below is one of those two sentences
 * written against the framebuffer:
 *
 *   DIRECTION — green and red, on a percentage change and its mark, through
 *     ui_chg_colour(). It is a claim about movement the board can only make
 *     about a figure it can vouch for, so it goes to INK when the snapshot is
 *     stale or the link is down — which is why check_no_chg_colour() exists and
 *     why check_page() calls it off ui_data_live() rather than off a flag a
 *     caller could forget.
 *
 *   IDENTITY — blue and yellow, saying which SERIES a bar or a line belongs to
 *     inside a graphic that draws more than one. A legend, not a claim.
 *
 * The old rule here was simpler and is gone: blue and yellow used to fail the
 * build anywhere outside a photograph. That ban was lifted deliberately. Blue is
 * 2.77:1 against the paper and a perfectly good ink on this panel; what the ban
 * was really protecting against was YELLOW, which is 1.10:1 — the same value as
 * the paper, so a yellow bar reads as the outline of a bar rather than as a bar.
 * Against black yellow is 4.09:1, so yellow is legal enclosed by a black
 * keyline and illegal otherwise, and that is a property of the PIXELS rather
 * than of the drawing code. sim/shots/00_inks.png is the sheet the two contrast
 * figures can be judged on.
 *
 * So there are three questions now where there was one:
 *
 *   1. can any yellow pixel reach the paper without crossing black?
 *      — check_yellow_sealed(), a flood fill, plus the keyline's WEIGHT;
 *   2. is every coloured pixel inside a rectangle allowed to carry THAT ink?
 *      — check_colour_slots(), which now carries a per-slot ink mask;
 *   3. is any TYPE blue or yellow? — check_type_not_series().
 *
 * WHERE the slots are is read back out of the composition rather than listed
 * here. That is the whole reason ui_page_layout() exists: the modules that
 * carry a change and the modules that draw a graphic land somewhere different
 * every time the day's file does. */

/* Which inks a rectangle may carry. A mask and not a bool because the two
 * meanings do not travel together: the industry table prints changes and draws
 * no graphic, a chart draws a graphic and prints no change, and a drawn
 * statement does both. One flag would have to be the union of the three, which
 * is the permission the old check already had too much of. */
#define INK_BIT(i)   (1u << (i))
#define SLOT_CHG     (INK_BIT(WP_I_GREEN) | INK_BIT(WP_I_RED))
#define SLOT_SERIES  (INK_BIT(WP_I_BLUE)  | INK_BIT(WP_I_YELLOW))

typedef struct { int x0, y0, x1, y1; unsigned inks; const char *why; } slot_t;

static const char *inks_name(unsigned m)
{
    static char buf[64];
    int n = 0;

    buf[0] = '\0';
    for (int i = 0; i < WP_PALETTE_N; i++) {
        if (!(m & INK_BIT(i))) continue;
        n += snprintf(buf + n, sizeof buf - (size_t)n, "%s%s",
                      n ? "/" : "", INK_NAME[i]);
    }
    return buf[0] ? buf : "nothing";
}

static bool inside(const slot_t *s, int x, int y)
{
    return x >= s->x0 && x < s->x1 && y >= s->y0 && y < s->y1;
}

static bool in_art(int x, int y)
{
    for (int i = 0; i < g_arts; i++) {
        if (x >= g_art[i].x1 && x <= g_art[i].x2
            && y >= g_art[i].y1 && y <= g_art[i].y2) {
            return true;
        }
    }
    return false;
}

/* --- yellow may not touch paper -------------------------------------------
 *
 * The invariant is about the SHEET and not about the drawing code, which is the
 * whole reason it is checked here: ui_series_fill() is the only function that
 * may put yellow down and it draws its own keyline, but "the only function that
 * may" is a claim about the source, and this file's job is to look at pixels.
 * A keyed bar clipped by the pane it is drawn in, a keyline inset the wrong way
 * round, a fill drawn after the keyline instead of inside it — none of those is
 * visible in a grep and all of them put a 1.10:1 fill on 1.00 paper.
 *
 * TWO checks, because one of them can be satisfied by a keyline too thin to
 * survive the panel and the other can be satisfied by a keyline with a hole in
 * it, and they are different bugs:
 *
 *   REACHABILITY — flood the sheet from its edge through every pixel that is
 *     NOT black, and no yellow pixel may be reached. This is the invariant
 *     stated exactly: "yellow cannot be got at from the paper without crossing
 *     black". It catches a keyline open on one side, a keyline with a one-pixel
 *     gap in it, and a keyline that never got drawn.
 *
 *     EIGHT-CONNECTED, and that is the line between a check that bites and one
 *     that quietly passes. A four-connected flood cannot get through a diagonal
 *     pinhole — paper at (0,0), yellow at (1,1), black at (1,0) and (0,1) — so
 *     it would call a keyline with a corner missing sealed. Flooding eight-
 *     connected demands that the black barrier be FOUR-connected all the way
 *     round, which is what "a solid keyline" actually means. Getting this pair
 *     backwards is the classic way a fill-and-boundary test passes on a
 *     boundary that leaks.
 *
 *   WEIGHT — from every yellow pixel on the edge of its region, in each of the
 *     four cardinal directions, there must be at least UI_SERIES_KEY_W black
 *     pixels before anything else. Reachability alone cannot see this: a
 *     one-pixel keyline seals the framebuffer perfectly and passes the flood,
 *     and it is still the bug, because UI_SERIES_KEY_W is 2 for a physical
 *     reason — the first time the panel's registration is half a pixel out on
 *     one side a hairline keyline lets the fill touch paper on the glass, where
 *     no simulator will ever see it. Measuring from the EDGE pixels of the
 *     region and in all four directions independently is what stops a bar
 *     keylined correctly on three sides and thinly on the fourth from passing
 *     on the strength of the three.
 *
 * Both skip pixels inside a photograph: `make_tile.py --color` may legitimately
 * put yellow in a tile, and a photograph is the one region on the sheet where
 * all six inks are the picture rather than the policy. */

/* 0 unvisited, 1 reachable from the paper without crossing black, 2 black.
 * A byte per pixel rather than a bitmap: it is 1.9 MB on a desktop and it is
 * what lets the ink sheet below ASK the flood a question afterwards. */
static uint8_t g_reach[(size_t)UI_W * UI_H];

static void flood_from_paper(void)
{
    memset(g_reach, 0, sizeof g_reach);

    /* Each pixel is pushed at most once — it is marked as it goes on — so the
     * stack can never be deeper than the sheet. */
    int32_t *stack = malloc(sizeof(int32_t) * (size_t)UI_W * UI_H);
    if (!stack) { FAIL("out of memory flooding the sheet"); return; }
    size_t top = 0;

#define REACH_PUSH(X, Y) do {                                         \
        const size_t _i = (size_t)(Y) * UI_W + (X);                   \
        if (g_reach[_i]) break;                                       \
        if (ink_at((X), (Y)) == WP_I_BLACK) { g_reach[_i] = 2; break; } \
        g_reach[_i] = 1;                                              \
        stack[top++] = (int32_t)_i;                                   \
    } while (0)

    for (int x = 0; x < UI_W; x++) { REACH_PUSH(x, 0); REACH_PUSH(x, UI_H - 1); }
    for (int y = 0; y < UI_H; y++) { REACH_PUSH(0, y); REACH_PUSH(UI_W - 1, y); }

    while (top) {
        const int32_t i = stack[--top];
        const int x = (int)(i % UI_W), y = (int)(i / UI_W);

        for (int dy = -1; dy <= 1; dy++) {
            for (int dx = -1; dx <= 1; dx++) {
                const int nx = x + dx, ny = y + dy;
                if (nx < 0 || ny < 0 || nx >= UI_W || ny >= UI_H) continue;
                REACH_PUSH(nx, ny);
            }
        }
    }
#undef REACH_PUSH

    free(stack);
}

static bool reached_from_paper(int x, int y)
{
    return g_reach[(size_t)y * UI_W + x] == 1;
}

/* Yellow the paper can get at, counted. Reports when `report`, so the ink sheet
 * below can use the same function as a positive control without spending a
 * failure on the patch it drew on purpose. */
static int yellow_on_paper(const char *pass, bool report, int y0, int y1)
{
    int seen = 0;

    flood_from_paper();

    for (int y = y0; y < y1; y++) {
        for (int x = 0; x < UI_W; x++) {
            if (!reached_from_paper(x, y)) continue;
            if (ink_at(x, y) != WP_I_YELLOW) continue;
            if (in_art(x, y)) continue;

            if (report && seen < REPORT_MAX) {
                FAILV("%s: yellow at (%d,%d) can be reached from the paper "
                      "without crossing black — yellow is 1.10:1 on paper and "
                      "is legal only inside a black keyline", pass, x, y);
            }
            seen++;
        }
    }
    if (report && seen > REPORT_MAX) {
        printf("       ...and %d more yellow pixels open to the paper\n",
               seen - REPORT_MAX);
    }
    return seen;
}

static int check_yellow_keyline(const char *pass, bool report, int y0, int y1)
{
    static const struct { int dx, dy; const char *side; } D[4] = {
        { -1, 0, "left" }, { 1, 0, "right" }, { 0, -1, "top" }, { 0, 1, "bottom" },
    };
    int seen = 0;

    for (int y = y0; y < y1; y++) {
        for (int x = 0; x < UI_W; x++) {
            if (ink_at(x, y) != WP_I_YELLOW || in_art(x, y)) continue;

            for (int d = 0; d < 4; d++) {
                int nx = x + D[d].dx, ny = y + D[d].dy;

                /* Interior in this direction: the pixel beyond is more of the
                 * same fill, so the edge — and the keyline — is somebody
                 * else's row to answer for. */
                if (ink_at(nx, ny) == WP_I_YELLOW) continue;

                int black = 0;
                while (black < UI_SERIES_KEY_W && ink_at(nx, ny) == WP_I_BLACK) {
                    black++;
                    nx += D[d].dx;
                    ny += D[d].dy;
                }
                if (black >= UI_SERIES_KEY_W) continue;

                if (report && seen < REPORT_MAX) {
                    FAILV("%s: the yellow at (%d,%d) has %d px of keyline on its "
                          "%s, against the %d UI_SERIES_KEY_W asks for",
                          pass, x, y, black, D[d].side, UI_SERIES_KEY_W);
                }
                seen++;
            }
        }
    }
    if (report && seen > REPORT_MAX) {
        printf("       ...and %d more thin or missing keyline edges\n",
               seen - REPORT_MAX);
    }
    return seen;
}

static void check_yellow_sealed(const char *pass)
{
    yellow_on_paper(pass, true, 0, UI_H);
    check_yellow_keyline(pass, true, 0, UI_H);
}

/* Every coloured pixel is inside a rectangle that may carry THAT ink.
 *
 * With no slots at all this is "the sheet is black and white", which is what
 * the setup sheet and the no-data sheet are and is why they pass `NULL, 0`.
 * A page passes what its own composition earned. */
static void check_colour_slots(const char *pass, const slot_t *ok, int n)
{
    int seen = 0;

    for (int y = 0; y < UI_H; y++) {
        for (int x = 0; x < UI_W; x++) {
            const int i = ink_at(x, y);
            if (i == WP_I_BLACK || i == WP_I_WHITE) continue;
            if (in_art(x, y)) continue;

            bool allowed = false;
            for (int s = 0; s < n && !allowed; s++) {
                allowed = inside(&ok[s], x, y) && (ok[s].inks & INK_BIT(i));
            }
            if (allowed) continue;

            /* The slots are named once, at the first failure, WITH what each
             * may carry. "Outside every slot" is only actionable if the reader
             * can see which slots those were and which ink each allows — a blue
             * pixel inside the industry table is a different bug from a blue
             * pixel in the gutter, and the coordinate alone tells them apart
             * only after a trip to this file. */
            if (seen == 0) {
                printf("  colour is allowed only in:");
                for (int s = 0; s < n; s++) {
                    printf("%s %s x[%d..%d) y[%d..%d) may carry %s", s ? ";" : "",
                           ok[s].why, ok[s].x0, ok[s].x1, ok[s].y0, ok[s].y1,
                           inks_name(ok[s].inks));
                }
                printf("\n");
            }
            if (seen++ < REPORT_MAX) {
                FAILV("%s: %s at (%d,%d), drawn as %s — no slot here may carry it",
                      pass, INK_NAME[i], x, y, wanted_at(x, y));
            }
        }
    }
    if (seen > REPORT_MAX) {
        printf("       ...and %d more coloured pixels outside their slots\n",
               seen - REPORT_MAX);
    }
}

/* TYPE IS BLACK, and where it is not black it is a change figure.
 *
 * The slot check cannot say this on its own: a chart module's rectangle holds
 * its caps head and its note as well as its plot, so a rectangle that may carry
 * blue may carry a blue HEADING, and blue type is the one thing the colour
 * decision never included. Series colour is an identity that belongs to a bar;
 * a word is not a series.
 *
 * Green and red are deliberately not checked here — a change figure IS type,
 * and colouring it is the whole of the DIRECTION rule.
 *
 * Read off the label boxes rather than the framebuffer, which is the same trick
 * check_label_overlap() uses and for the same reason: nothing in the pixels
 * distinguishes a glyph from a graphic. */
static void check_type_not_series(const char *pass)
{
    int seen = 0;

    for (int i = 0; i < g_labs; i++) {
        const lv_area_t *a = &g_lab[i].a;

        for (int y = a->y1; y <= a->y2; y++) {
            for (int x = a->x1; x <= a->x2; x++) {
                if (x < 0 || y < 0 || x >= UI_W || y >= UI_H) continue;
                const int ink = ink_at(x, y);
                if (ink != WP_I_BLUE && ink != WP_I_YELLOW) continue;
                if (in_art(x, y)) continue;

                if (seen++ < REPORT_MAX) {
                    FAILV("%s: %s at (%d,%d), inside the label \"%s\" — blue and "
                          "yellow are series identities and type is never one",
                          pass, INK_NAME[ink], x, y, g_lab[i].txt);
                }
                y = a->y2;            /* one report per label, not per pixel */
                break;
            }
        }
    }
    if (seen > REPORT_MAX) {
        printf("       ...and %d more labels holding series colour\n",
               seen - REPORT_MAX);
    }
}

/* No DIRECTION colour at all, for the sheets that may not claim one.
 *
 * ui_chg_colour() returns ink when the board cannot vouch for the figure, and
 * until now nothing asserted that it had: check_colour_slots() ALLOWS green and
 * red in the rail and the industry table, so a stale sheet that kept its greens
 * passed every check on the page. The comment beside the STALE pass claimed the
 * property and no line of code held it.
 *
 * SERIES colour is deliberately left alone here, and that is a decision rather
 * than an omission. Green on a price is a claim that the price moved that way,
 * and a board that has lost its feed cannot make it. Blue on a bar is not a
 * claim about anything — it says "this bar is revenue and that one is profit",
 * which is exactly as true on a three-day-old sheet as on a live one. Taking it
 * away would not make the sheet more honest, it would make the graphic
 * unreadable and leave the reader to attribute that to a rendering fault; the
 * STALE badge is the state signal, and a chart nobody can read is damage. It
 * would also cost the property the device banks on: ui_series_at() is pure in
 * (i, n), test_chart_scale holds it to that, and a link state inside it would
 * have to enter news_hash() before the same fingerprint could still promise the
 * same pixels. */
static void check_no_chg_colour(const char *pass)
{
    int seen = 0;

    for (int y = 0; y < UI_H; y++) {
        for (int x = 0; x < UI_W; x++) {
            const int i = ink_at(x, y);
            if (i != WP_I_GREEN && i != WP_I_RED) continue;
            if (in_art(x, y)) continue;

            if (seen++ < REPORT_MAX) {
                FAILV("%s: %s at (%d,%d) — the board cannot vouch for this "
                      "snapshot, so every change figure and every mark on it "
                      "prints in ink", pass, INK_NAME[i], x, y);
            }
        }
    }
    if (seen > REPORT_MAX) {
        printf("       ...and %d more pixels of direction colour on a sheet "
               "that may not claim one\n", seen - REPORT_MAX);
    }
}

/* --- the composition ------------------------------------------------------ */

static const char *KIND_NAME[UI_MOD_KIND_COUNT] = {
    "none", "lead", "story", "dossier", "chart", "briefs", "peers",
    "table", "thumbs", "quote",
};

/* Everything that is true of a legal make-up, whatever the day brought.
 *
 * Returns the number of colour slots it wrote into `ok` — the modules that
 * legitimately carry a change figure. Deriving them here rather than listing
 * them is the point: a rail that moved to the right-hand column moves its
 * exemption with it, and a module that started drawing green somewhere it should
 * not fails immediately. */
static int check_layout(const char *pass, ui_page_t page, const news_t *v,
                        slot_t *ok, int ok_max)
{
    const ui_mod_t  *mods = NULL;
    ui_compose_env_t env;
    char             why[200];
    int              n = ui_page_layout(page, &mods, &env);
    int              slots = 0;

    if (n <= 0 || !mods) return 0;

    if (!ui_compose_check(&env, mods, n, why, sizeof why)) {
        FAILV("%s: the day's make-up is not a legal tiling of the well — %s",
              pass, why);
    }

    for (int i = 0; i < n; i++) {
        const ui_mod_t *m = &mods[i];
        if (!m->placed) continue;

        const char *kind = (m->kind >= 0 && m->kind < UI_MOD_KIND_COUNT)
                         ? KIND_NAME[m->kind] : "?";

        if (getenv("SIM_DUMP_LAYOUT")) {
            printf("      %-8s band %d slot %d  col %d+%d  "
                   "x %4d y %4d w %4d h %4d\n",
                   kind, m->band, m->slot, m->col, m->cols,
                   m->x, m->y, m->w, m->h);
        }

        /* A tile packs two pixels to a byte, so an odd origin or an odd width
         * would need a nibble-shifting blit on the device for nothing. */
        if ((m->x & 1) || (m->w & 1)) {
            FAILV("%s: the %s module is at x=%d w=%d — both must be even",
                  pass, kind, m->x, m->w);
        }

        char what[128];
        snprintf(what, sizeof what,
                 "%s: the %s module (%d columns at column %d)",
                 pass, kind, m->cols, m->col);
        want_ink(what, m->x, m->y, m->x + m->w, m->y + m->h);

        /* The two modules that PRINT a change figure. The metric grid also
         * draws — its range bars and its sparkline are graphics — so it takes
         * series colour as well; the industry table is a printed table with a
         * CHG column and nothing drawn in it, so it does not.
         *
         * The grant is per MODULE RECTANGLE, which is the resolution this
         * machinery has and is worth saying out loud: it says "colour may
         * appear in this module", not "colour may appear on this bar".
         * check_type_not_series() is what stops the slack being spent on a
         * coloured heading inside the same rectangle. */
        if (m->kind == UI_MOD_DOSSIER && slots < ok_max) {
            ok[slots++] = (slot_t){
                m->x, m->y, m->x + m->w, m->y + m->h,
                SLOT_CHG | SLOT_SERIES, "the metric grid",
            };
        }
        if (m->kind == UI_MOD_PEERS && slots < ok_max) {
            ok[slots++] = (slot_t){
                m->x, m->y, m->x + m->w, m->y + m->h,
                SLOT_CHG, "the industry table",
            };
        }

        /* A chart is a graphic and nothing else: it draws series and prints no
         * change figure, so it earns the identity inks and not the direction
         * ones. If a chart ever wants green it is drawing a change, and that is
         * a decision to make out loud rather than to inherit. */
        if (m->kind == UI_MOD_CHART && slots < ok_max) {
            ok[slots++] = (slot_t){
                m->x, m->y, m->x + m->w, m->y + m->h,
                SLOT_SERIES, "a chart",
            };
        }

        /* A DRAWN statement is a colour slot and a printed one is not.
         *
         * ui_grf_t carries `lbp` — the percentage line's last less its first —
         * precisely so the line can be given ui_chg_colour(), which makes a
         * TABLE_BARS_LINE the only module on the sheet that draws colour without
         * printing a change figure. That is the colour policy holding rather than
         * bending: the line IS a change, over six quarters instead of one
         * session. The bars under it and every printed cell stay ink.
         *
         * It is also the module that carries the most series at once — bars,
         * their tones and their legend swatches — so it takes both masks, and
         * it is the only place on either sheet where they meet.
         *
         * Derived from the PAYLOAD's own `render`, not from the module kind, so a
         * table the producer sent as a record gets no exemption and a green cell
         * in a printed statement still fails. */
        if (m->kind == UI_MOD_TABLE && v && slots < ok_max
            && m->src >= 0 && m->src < v->table_count
            && v->tables[m->src].render != TABLE_PRINT
            && v->tables[m->src].has_n) {
            ok[slots++] = (slot_t){
                m->x, m->y, m->x + m->w, m->y + m->h,
                SLOT_CHG | SLOT_SERIES, "a drawn statement",
            };
        }
    }
    return slots;
}

/* What must be true of a BANNER, when the compositor granted one.
 *
 * Read off `bannered` — the output — and never off `banner`, the request, nor
 * off the rectangle. A refused banner can legitimately end up alone on a
 * full-measure band at the top of the well through ordinary packing, so the
 * geometry cannot tell "I asked and won" from "I asked, was refused, and the
 * packing happened to agree". Those are different pages and the difference shows
 * up on about one payload in fifty.
 *
 * Properties rather than positions: it spans the whole measure, it starts at the
 * top of the well, and nothing is above it. */
static void check_banner(const char *pass, ui_page_t page)
{
    const ui_mod_t *mods = NULL;
    ui_compose_env_t env;
    const int n = ui_page_layout(page, &mods, &env);
    int seen = 0;

    for (int i = 0; i < n && mods; i++) {
        const ui_mod_t *m = &mods[i];
        if (!m->placed || !m->bannered) continue;

        seen++;
        if (m->w != env.w) {
            FAILV("%s: the banner is %d px wide against the well's %d — a banner "
                  "is the whole measure or it is not a banner", pass, m->w, env.w);
        }
        if (m->y != env.y) {
            FAILV("%s: the banner starts at y=%d against the well's %d — it is "
                  "the first cut, so nothing may be above it", pass, m->y, env.y);
        }
        for (int j = 0; j < n; j++) {
            if (j == i || !mods[j].placed) continue;
            if (mods[j].y < m->y + m->h && mods[j].y + mods[j].h > m->y) {
                FAILV("%s: the %s module shares rows with the banner — the banner "
                      "is alone on its band", pass,
                      (mods[j].kind >= 0 && mods[j].kind < UI_MOD_KIND_COUNT)
                      ? KIND_NAME[mods[j].kind] : "?");
                break;
            }
        }
    }

    if (seen > 1) {
        FAILV("%s: %d modules came back bannered — at most one may have the band",
              pass, seen);
    }
}

/* Display type, and the one thing an ink-coverage figure cannot say: that the
 * page has something on it a reader's eye can land on from across a room.
 *
 * What is required depends on what the day brought, and is read out of the
 * composition for the same reason the colour slots are. A page carrying a lead
 * must set a lead-sized headline somewhere in the well; a page carrying only a
 * story or a pulled quote must set at least a headline; a page of figures alone
 * — a quiet day with no prose at all — is a legitimate sheet and is asked for
 * nothing, because there is nothing on it that could honestly be set large. */
static void check_display_type(const char *pass, ui_page_t page)
{
    const ui_mod_t *mods = NULL;
    ui_compose_env_t env;
    const int n = ui_page_layout(page, &mods, &env);

    int want = 0;
    for (int i = 0; i < n && mods; i++) {
        if (!mods[i].placed) continue;
        if (mods[i].kind == UI_MOD_LEAD) {
            want = lv_font_get_line_height(ui_head_font(0));
            break;
        }
        if (mods[i].kind == UI_MOD_STORY || mods[i].kind == UI_MOD_QUOTE) {
            const int h = lv_font_get_line_height(ui_head_font(1));
            if (h > want) want = h;
        }
    }
    if (want == 0) return;

    int best = 0;
    for (int i = 0; i < g_labs; i++) {
        if (g_lab[i].a.y1 < UI_WELL_Y || g_lab[i].a.y2 >= UI_WELL_B) continue;
        const int h = g_lab[i].font ? lv_font_get_line_height(g_lab[i].font) : 0;
        if (h > best) best = h;
    }
    if (best < want) {
        FAILV("%s: the largest type in the well is %d px against the %d the day's "
              "modules called for — the page is grey", pass, best, want);
    }
}

/* A sheet of white paper passes every check above. This is the one that says the
 * page was actually SET.
 *
 * The number is the thin day rather than the full one: A1 on the demo snapshot
 * inks 14% of the sheet and A2 8%, and a markets page on a payload with two
 * stories and no statements comes in just under 4 — legitimately, because a
 * paper with nothing to print prints a short page and rules under it. Three per
 * cent is where a page stops being short and starts being empty: the sheet with
 * no snapshot at all, which is a nameplate, four rules and a folio, inks 1.9. */
#define SIM_INK_MIN  3.0

static void check_inked(const char *pass)
{
    const double pct = ink_pct();
    if (pct < SIM_INK_MIN) {
        FAILV("%s: only %.2f%% of the sheet carries ink, against the %.1f%% a set "
              "page never falls under", pass, pct, SIM_INK_MIN);
    }
}

/* --- a pass --------------------------------------------------------------- */

/* NO STATEMENT REACHES BOTH SHEETS.
 *
 * This is the one invariant on the board that spans two agents' files, and it is
 * the one whose failure is silent. A1 chooses its statements through
 * ui_a1_graphic() / ui_a1_table() in ui_modules.c; A2 takes what is left through
 * ui_a2_takes_table(); and if those three ever disagree the reader gets the same
 * six quarters printed twice, on two pages, with nothing in either page file
 * wrong on its own. The rule used to be the same arithmetic written out in both
 * page files with a comment in each admitting they had to agree — which is
 * exactly the shape of bug that survives review.
 *
 * Asserted on the COMPOSITIONS rather than on the source, so it holds for
 * whatever those functions become: read both pages' placed modules back and
 * intersect their table sources. It runs once per payload, after both sheets
 * have been composed, and it is the reason ui_page_layout() records both. */
static void check_table_split(const char *pass)
{
    const ui_mod_t *mods = NULL;
    ui_compose_env_t env;
    bool on_a1[NEWS_TABLES_MAX] = { false };

    int n = ui_page_layout(UI_PAGE_FRONT, &mods, &env);
    for (int i = 0; i < n && mods; i++) {
        if (!mods[i].placed || mods[i].kind != UI_MOD_TABLE) continue;
        if (mods[i].src >= 0 && mods[i].src < NEWS_TABLES_MAX) {
            on_a1[mods[i].src] = true;
        }
    }

    n = ui_page_layout(UI_PAGE_MARKETS, &mods, &env);
    for (int i = 0; i < n && mods; i++) {
        if (!mods[i].placed || mods[i].kind != UI_MOD_TABLE) continue;
        if (mods[i].src >= 0 && mods[i].src < NEWS_TABLES_MAX
            && on_a1[mods[i].src]) {
            FAILV("%s: table %d is printed on A1 AND on A2 — "
                  "ui_a1_graphic()/ui_a1_table() and ui_a2_takes_table() "
                  "disagree about who takes it", pass, mods[i].src);
        }
    }
}

static void check_page(const char *pass, ui_page_t page, const news_t *v)
{
    slot_t ok[UI_MOD_MAX + 2];
    int    n = 0;

    scan_tree();

    check_furniture(pass, page == UI_PAGE_FRONT);
    check_margins(pass);
    check_masthead(pass);
    check_inked(pass);

    n = check_layout(pass, page, v, ok, UI_MOD_MAX);
    check_banner(pass, page);
    check_display_type(pass, page);

    /* The tape's percentages are the furniture's own change figures, and the
     * strip is the same rows on every sheet. It draws nothing, so it never
     * carries a series ink. */
    if (n < (int)(sizeof ok / sizeof *ok)) {
        ok[n++] = (slot_t){ UI_CONTENT_X, UI_TAPE_Y, UI_CONTENT_R,
                            UI_TAPE_Y + UI_TAPE_H, SLOT_CHG, "the tape" };
    }

    check_colour_slots(pass, ok, n);
    check_yellow_sealed(pass);
    check_type_not_series(pass);

    /* Off the link state rather than off an argument, so the one sheet that
     * must not claim a direction cannot be the one sheet somebody forgot to
     * pass the flag for. */
    if (!ui_data_live()) check_no_chg_colour(pass);

    check_label_overlap(pass);
    check_fixed_labels_fit(pass);
}

/* --- the LVGL memory budget ------------------------------------------------
 *
 * The check that was missing, and the one that cost the most to find without.
 *
 * ui_news_create() builds BOTH pages, both badges and the provisioning overlay
 * up front and keeps every handle — that is the design, and it is what makes a
 * page change a widget update rather than a rebuild. It also means the whole
 * sheet's worth of widgets is resident from the first boot, and on a device
 * that is a fixed cost the firmware has to have somewhere to put.
 *
 * It did not. The firmware configured LVGL's default 64 KB pool in internal
 * .bss, the page needs several times that, and the board crashed inside
 * lv_obj_class_create_obj() on the first boot — the function reallocates the
 * parent's child array and stores into the result WITHOUT CHECKING IT, so an
 * exhausted heap arrives as a StoreProhibited on a small address in whichever
 * widget happened to be next, and nothing in the log names memory at all. The
 * simulator passed every check on the same code, because it was linked against
 * the host's malloc() and the host's malloc() does not run out.
 *
 * THE NUMBER BELOW IS A HOST FIGURE, NOT A DEVICE ONE. This binary is 64-bit,
 * so every pointer inside an lv_obj_t is twice the width it is on the ESP32-S3
 * and the measurement here is an over-estimate of what the device allocates.
 * That is the useful direction to be wrong in for a ceiling — a page that fits
 * here fits there — but it does mean this budget cannot be read as "the device
 * will use N bytes". The device's own figure is what docs/bring-up.md asks to
 * be recorded, and lv_mem_monitor()'s max_used on the board is where it comes
 * from.
 *
 * So the budget is not a prediction. It is a ratchet: it says the page costs
 * about what it costs today, and a change that quietly doubles it has to say so
 * here first.
 */
/* 448 KB. It was 256 KB against a measured peak of ~203 KB, and the compositor
 * passes took it to 424,440 B — a little over double.
 *
 * THE RATCHET WORKED, WHICH IS WHY THIS COMMENT EXISTS. The merge that brought
 * the two together was textually clean: one additive conflict in this file, both
 * sides kept. Nothing about the page was broken. What failed was this assertion,
 * on the first run after the merge, saying the page now costs twice what it did
 * — which is exactly the thing it was added to make impossible to ship quietly.
 *
 * WHERE IT WENT, measured rather than assumed. 391,184 B of the 424,440 is
 * allocated by ui_news_create() before a single page is rendered; the render
 * adds about 33 KB and gives it back. So this is the static widget pool and not
 * a leak, and the rule that nothing is created in an update still holds. The
 * pool grew because the page did: a compositor that lays out BOTH sheets from
 * module renderers, two drawn statements, and a metric grid sized for the
 * model's maximum — UI_DOSSIER_GROUPS heads and NEWS_FIGURES_MAX figures at
 * three widgets each is about a hundred objects, and each page builds one.
 *
 * THIS IS STILL A HOST FIGURE AND STILL AN OVER-ESTIMATE, for the reason the
 * note above gives: 64-bit pointers throughout an lv_obj_t. The device number is
 * smaller and is the one that decides whether the board is fine, and the board
 * now prints it — user_app.cpp logs lv_mem_monitor() the moment the widgets are
 * built, which it did not do when this budget was written. Record that figure in
 * docs/bring-up.md and set this from it.
 *
 * Until then 448 KB is the honest ceiling: the measurement plus about 5% of head
 * room, which is tight enough that the next doubling still has to argue for
 * itself. On the device this lands in PSRAM — 8 MB of it, against a 960 KB
 * framebuffer — so the cost is real but it is not what constrains this board. */
#define UI_LVGL_BUDGET_BYTES  458752u     /* 448 KB; measured peak 424,440 B */

static void check_lvgl_budget(void)
{
    lv_mem_monitor_t m;
    lv_mem_monitor(&m);

    printf("LVGL heap: %u B peak of a %u B budget (host figure — see "
           "check_lvgl_budget)\n",
           (unsigned)m.max_used, (unsigned)UI_LVGL_BUDGET_BYTES);

    if (m.max_used > UI_LVGL_BUDGET_BYTES) {
        FAILV("the UI's LVGL heap peaked at %u B, over the %u B budget by %u B "
              "— raise UI_LVGL_BUDGET_BYTES only with a device measurement to "
              "back it, or the board runs out of PSRAM instead of paper",
              (unsigned)m.max_used, (unsigned)UI_LVGL_BUDGET_BYTES,
              (unsigned)(m.max_used - UI_LVGL_BUDGET_BYTES));
    }
}

/* --- main ----------------------------------------------------------------- */

/* One payload, both pages, named so `ls` prints them in reading order. */
static void pass(const char *dir, const char *tag, int seq, const news_t *v)
{
    char name[64], label[80];

    ui_news_set_data(v);

    ui_news_show_page(UI_PAGE_FRONT);
    render();
    snprintf(name,  sizeof name,  "%02d_a1_%s", seq, tag);
    snprintf(label, sizeof label, "A1 %s", tag);
    shot(dir, name);
    check_page(label, UI_PAGE_FRONT, v);

    ui_news_show_page(UI_PAGE_MARKETS);
    render();
    snprintf(name,  sizeof name,  "%02d_a2_%s", seq + 1, tag);
    snprintf(label, sizeof label, "A2 %s", tag);
    shot(dir, name);
    check_page(label, UI_PAGE_MARKETS, v);

    /* Both sheets have now been composed from this payload, which is the only
     * moment the split between them can be looked at. */
    check_table_split(tag);

    ui_news_show_page(UI_PAGE_FRONT);
}

/* --- the payloads ---------------------------------------------------------
 *
 * Three beside the demo snapshot, and each is a shape the compositor resolves
 * differently. They matter more than they used to: with a fixed grid a thin
 * payload left holes, and with a compositor a thin payload is the case that
 * proves the elastic modules actually stretch into the well rather than leaving
 * the foot of the sheet as paper.
 *
 * FEW MODULES AND LITTLE COPY ARE TWO DIFFERENT FAILURES, and this file used to
 * conflate them: `sparse` was two short stories, so a page that came out grey
 * could not say which of the two had done it. They are separated now.
 *
 *   sparse — a genuine SLOW DAY: few modules, full-length copy. The lead runs
 *     to its whole budget and carries a photograph, because a front page is
 *     text and a photograph whatever the day brought; a company exists and
 *     there is a picture of it on a quiet morning as much as on a loud one.
 *     What this proves is that a page with little ON it still fills.
 *
 *   thin — the opposite and the harder one: every module the demo has, with the
 *     copy starved. A page whose graphics are all present and whose bodies are
 *     all short is the page the owner rejected, and it is the adversarial case
 *     for A1's prose share — the compositor hands room to whoever wants it, and
 *     short bodies are how a text paper turns into a graphics one without any
 *     single decision being wrong.
 *
 *   quiet — no stories at all, which keeps the artless path covered. */
static void sparse_payload(news_t *v)
{
    memset(v, 0, sizeof *v);
    v->valid = true;

    news_str_copy(v->edition,      sizeof v->edition,      "SEMICONDUCTORS");
    news_str_copy(v->dateline,     sizeof v->dateline,     "TUESDAY, AUGUST 11, 2026");
    news_str_copy(v->session,      sizeof v->session,      "U.S. MARKETS OPEN — 11:04 ET");
    news_str_copy(v->as_of,        sizeof v->as_of,        "AS OF 00:04 KST");
    news_str_copy(v->generated_at, sizeof v->generated_at, "2026-08-11T00:04:00Z");

    news_str_copy(v->subject.symbol,   sizeof v->subject.symbol,   "SNDK");
    news_str_copy(v->subject.name,     sizeof v->subject.name,     "Sandisk Corp.");
    news_str_copy(v->subject.exchange, sizeof v->subject.exchange, "NASDAQ");
    news_str_copy(v->subject.sector,   sizeof v->subject.sector,   "Semiconductors");
    v->subject.last_c = 21455;
    v->subject.chg_bp = 412;

    v->index_count = 2;
    news_str_copy(v->indices[0].symbol, sizeof v->indices[0].symbol, "SPX");
    news_str_copy(v->indices[0].name,   sizeof v->indices[0].name,   "S&P 500");
    v->indices[0].last_c = 641283;
    v->indices[0].chg_bp = 62;
    news_str_copy(v->indices[1].symbol, sizeof v->indices[1].symbol, "SOX");
    news_str_copy(v->indices[1].name,   sizeof v->indices[1].name,   "PHLX Semis");
    v->indices[1].last_c = 587411;
    v->indices[1].chg_bp = -138;

    /* The dossier is FULL even on a thin day, and that is not a convenience:
     * the rail is the company's fundamentals, they exist whether or not anything
     * happened, and a producer that sent five of them on a quiet morning would be
     * describing a different product. What makes this payload sparse is the
     * COUNT of things the day brought — two stories, two briefs, one chart, no
     * statements — and not the LENGTH of any of them. Both stories run to their
     * full budget and the lead carries a photograph, so the one thing a reader
     * would notice on this sheet is that there is less on it, never that what is
     * on it was cut short. Those are the two complaints this file used to answer
     * with one payload and now answers with two; see thin_payload(). */
    static const struct { const char *g, *l, *val; bool chg; int32_t bp; } F[] = {
        { "VALUATION",     "MARKET CAP",  "$31.2B",  false, 0    },
        { "VALUATION",     "P/E (FWD)",   "11.4x",   false, 0    },
        { "VALUATION",     "PRICE/BOOK",  "2.08x",   false, 0    },
        { "VALUATION",     "LAST",        "$214.55", true,  412  },
        { "PROFITABILITY", "GROSS MARGIN","38.4%",   false, 0    },
        { "PROFITABILITY", "NET MARGIN",  "11.9%",   false, 0    },
        { "PROFITABILITY", "RETURN ON EQ","14.2%",   false, 0    },
        { "BALANCE SHEET", "DEBT/EQUITY", "0.31x",   false, 0    },
        { "BALANCE SHEET", "CURRENT RATIO","188.0%", false, 0    },
        { "BALANCE SHEET", "CASH",        "$2.14B",  false, 0    },
        { "THE STREET",    "CONSENSUS",   "BUY",     false, 0    },
        { "THE STREET",    "TARGET",      "$248.00", true,  1550 },
    };
    for (size_t i = 0; i < sizeof F / sizeof *F; i++) {
        news_figure_t *f = &v->figures[v->figure_count++];
        news_str_copy(f->group, sizeof f->group, F[i].g);
        news_str_copy(f->label, sizeof f->label, F[i].l);
        news_str_copy(f->value, sizeof f->value, F[i].val);
        f->has_chg = F[i].chg;
        f->chg_bp  = F[i].bp;
    }

    v->peer_count = 3;
    static const struct { const char *s, *n, *pe, *cap; int32_t last, bp; bool me; } P[] = {
        { "SNDK", "Sandisk",       "11.4x", "$31.2B",  21455, 412,  true  },
        { "MU",   "Micron",        "14.9x", "$142.8B", 12840, 188,  false },
        { "WDC",  "Western Dig.",  "9.8x",  "$24.1B",   7212, -55,  false },
    };
    for (int i = 0; i < 3; i++) {
        news_peer_t *p = &v->peers[i];
        news_str_copy(p->symbol, sizeof p->symbol, P[i].s);
        news_str_copy(p->name,   sizeof p->name,   P[i].n);
        news_str_copy(p->per,    sizeof p->per,    P[i].pe);
        news_str_copy(p->cap,    sizeof p->cap,    P[i].cap);
        p->last_c     = P[i].last;
        p->chg_bp     = P[i].bp;
        p->is_subject = P[i].me;
    }

    v->brief_count = 2;
    news_str_copy(v->briefs[0].date,   sizeof v->briefs[0].date,   "AUG 10");
    news_str_copy(v->briefs[0].kicker, sizeof v->briefs[0].kicker, "SUPPLY");
    news_str_copy(v->briefs[0].text,   sizeof v->briefs[0].text,
                  "A second fab in Yokkaichi returned to full output a week "
                  "ahead of the schedule the company gave in June.");
    news_str_copy(v->briefs[1].date,   sizeof v->briefs[1].date,   "AUG 8");
    news_str_copy(v->briefs[1].kicker, sizeof v->briefs[1].kicker, "RATINGS");
    news_str_copy(v->briefs[1].text,   sizeof v->briefs[1].text,
                  "Two houses raised their price targets without changing a "
                  "recommendation, which is the week in one line.");

    v->chart_count = 1;
    news_chart_t *c = &v->charts[0];
    c->kind = CHART_LINE;
    news_str_copy(c->label, sizeof c->label, "PRICE");
    news_str_copy(c->span,  sizeof c->span,  "1M");
    news_str_copy(c->note,  sizeof c->note,  "Daily closes, one month");
    c->n = 14;
    for (int i = 0; i < 14; i++) c->c[i] = 19800 + 140 * i + (i % 3) * 210;

    /* Two stories, so the front page keeps one and the markets page gets the
     * other — the minimum at which both sheets carry prose.
     *
     * BOTH RUN TO BUDGET: the lead is 720 characters against the 600-740 in
     * tools/edition/PROMPT.md and the second is 284 against 260-330. That is
     * the whole difference between this payload and the one it replaces. A
     * slow day is a day with FEWER things on it, not a day whose stories were
     * cut in half, and the compositor stretches an elastic module to fill the
     * room it was given — so a short body on a thin page shows up as white
     * paper inside a ruled box and makes every other fault on the sheet
     * unreadable. Keep them at budget when editing, and keep the counts in
     * this comment true. */
    v->story_count = 2;

    news_story_t *s = &v->stories[0];
    s->rank  = 0;
    s->chart = 0;
    news_str_copy(s->kicker,   sizeof s->kicker,   "MEMORY");
    news_str_copy(s->headline, sizeof s->headline,
                  "Contract NAND prices turn for the first time since spring");
    news_str_copy(s->deck, sizeof s->deck,
                  "Buyers who spent two quarters running inventory down are "
                  "signing again, and the spot market moved first.");
    news_str_copy(s->byline, sizeof s->byline, "By CLAUDE · SEMICONDUCTOR DESK");
    news_str_copy(s->body, sizeof s->body,
        "SEOUL — Contract prices for the densest NAND parts rose in the August "
        "round for the first time since March, and the move was larger than the "
        "distributors had guided. Three of the four suppliers took the increase; "
        "the fourth has not published. What changed is not demand, which has been "
        "flat all year, but the willingness of buyers to hold inventory: two "
        "quarters of drawing stock down has left the channel thinner than it has "
        "been since 2023, and a thin channel prices differently. The company's own "
        "commentary in June put the turn a quarter later than this. That is the "
        "kind of miss a market forgives, and the shares did. What the round does "
        "not say is how long it lasts, and the last two turns lasted one quarter "
        "each.");

    /* A PHOTOGRAPH, on the thinnest payload this file builds.
     *
     * It used to have none, and the comment above called that "the shape a real
     * slow day has". It is not: this paper prints one company a day and the
     * company is there on a quiet morning too. A front page is text AND a
     * photograph, always — a sheet of type with a chart on it is a report, and
     * the day the compositor is allowed to produce one on a slow day is the day
     * it will produce one on every slow day.
     *
     * sndk_fab is the 1140 x 320 plate, so it is wider than anything but the
     * whole measure and CROPS into whatever the lead is given. That is the
     * intended path — the device never resizes a tile — and it is the case
     * worth exercising here, because a slow day is exactly when the lead might
     * be handed the whole measure and a banner. */
    news_str_copy(s->photo.id,      sizeof s->photo.id,      "sndk_fab");
    s->photo.w = 1140;
    s->photo.h = 320;
    news_str_copy(s->photo.caption, sizeof s->photo.caption,
                  "The Yokkaichi fab, which returned to full output a week ahead "
                  "of the schedule given in June.");
    news_str_copy(s->photo.credit,  sizeof s->photo.credit, "COMPANY HANDOUT");

    s = &v->stories[1];
    s->rank = 1;
    news_str_copy(s->kicker,   sizeof s->kicker,   "THE ACCOUNTS");
    news_str_copy(s->headline, sizeof s->headline,
                  "What the June quarter actually said");
    news_str_copy(s->deck, sizeof s->deck,
                  "Gross margin did the work; the revenue line barely moved.");
    news_str_copy(s->byline, sizeof s->byline, "By CLAUDE · MARKETS DESK");
    news_str_copy(s->body, sizeof s->body,
        "The quarter looks better than it reads. Revenue was up four per cent on "
        "the year and flat on the quarter, which is not the shape of a recovery — "
        "but gross margin came in six points wider, and almost all of that is mix "
        "rather than price. The company sold more of the parts it earns on.");
}

/* Everything the demo brought, with the copy starved.
 *
 * The opposite failure to sparse_payload() and the one that is harder to see,
 * because nothing on this page is missing: every statement, every chart, every
 * thumbnail and every table is there, and the only thing wrong with it is that
 * the writing is a third of what it should be. That is how a text-and-
 * photograph newspaper turns into a page of graphics with no single decision
 * being wrong — the compositor hands room to whoever asks for it, and a story
 * that brought 150 characters does not ask.
 *
 * So this is the adversarial payload for A1's prose share. A rule that holds on
 * the demo snapshot and on a slow day but not here is a rule that holds when
 * the producer behaves, and the producer is the thing the rule exists to defend
 * against.
 *
 * The bodies are SHORT AND WHOLE rather than truncated: a body cut mid-sentence
 * would make every shot of this payload unreadable for the one thing the shots
 * are looked at for, which is judging the page as paper. */
static void thin_payload(news_t *v)
{
    static const char *const BODY[] = {
        "The company confirmed the round and said very little else. Two analysts "
        "asked about the second half on the call and were told to wait for the "
        "October guidance.",

        "Margin did the work again this quarter. Nobody on the call would say "
        "whether the mix that produced it holds through the winter.",

        "The line restarted on Tuesday. The company has not said what the "
        "quarter's output will be, and the distributors have stopped guessing.",
    };

    news_mock(v);
    v->demo = false;
    news_str_copy(v->session, sizeof v->session, "U.S. MARKETS OPEN — 10:12 ET");

    for (int i = 0; i < v->story_count; i++) {
        news_str_copy(v->stories[i].body, sizeof v->stories[i].body,
                      BODY[i % (int)(sizeof BODY / sizeof *BODY)]);
    }
}

/* Figures, briefs and an industry table, and no stories at all. A quiet day is
 * not a broken feed: the modules that have material stretch into the well and
 * the sheet is a page of reference — which is what a paper prints on a day it
 * has nothing to report, and is a legitimate front page rather than an error
 * state. */
static void quiet_payload(news_t *v)
{
    news_mock(v);
    v->demo = false;
    v->story_count = 0;
    memset(v->stories, 0, sizeof v->stories);
    v->thumb_count = 0;
    memset(v->thumbs, 0, sizeof v->thumbs);
    news_str_copy(v->session, sizeof v->session, "U.S. MARKETS CLOSED — HOLIDAY");
}

/* --- the ink sheet --------------------------------------------------------
 *
 * A specimen, not a page: the six inks and the five series treatments printed
 * as bars, hairlines and stems on the paper they will actually sit on, each
 * labelled with its measured contrast. It is the artefact the colour decision
 * was argued from and the one thing that can settle the argument, because
 * "blue is 2.77:1" is arithmetic and "does a blue bar beside a black one
 * separate at arm's length" is a question only a sheet answers.
 *
 * DRAWN IN THE MEASURED INKS, like every other shot: the UI paints saturated
 * palette entries, wp_quantize565() resolves them to the six, and
 * write_preview() prints them in wp_palette_ink, which is roughly what Spectra 6
 * looks like. A specimen drawn in #0000FF would be a specimen of a panel nobody
 * owns.
 *
 * THREE FORMS PER INK, because contrast is not the whole answer. A ratio
 * describes an area of ink against an area of paper, and most of what this page
 * actually draws is neither: a 3 px rule and a 12 px stem are thin enough that
 * the eye integrates them with the paper around them and every colour reads
 * lighter than its number. That is why the value ladder in ui_internal.h talks
 * about bars and lines separately, and it is why a blue HAIRLINE is a worse
 * idea than a blue bar however good 2.77:1 looks written down.
 *
 * AND EACH ONE ABUTTING BLACK, which is the question the ladder is really
 * about. Blue is 2.77:1 on paper and 1.63:1 on black, so a blue bar with a
 * black bar beside it and no gutter is two bars that read as one shape. The
 * pair column is that case, drawn rather than described.
 *
 * The sheet is also this file's own POSITIVE CONTROL. It is the one place in
 * the tree where bare yellow is drawn on paper deliberately, so it is the one
 * place check_yellow_sealed()'s reachability test can be shown to bite without
 * mutating a file another agent is editing. ink_sheet_selftest() below asserts
 * that the bare row IS caught, that the keylined row is NOT, and — the part
 * that matters — that the keylined row drew yellow at all, because a treatment
 * that quietly drew nothing would pass "no yellow escaped" perfectly. */

#define SW_HEAD_H       152
#define SW_ROW_H        138
#define SW_BAR_H         56
#define SW_LINE_W         3
#define SW_STEM_W        12

#define SW_X_LABEL      UI_CONTENT_X                    /*   30 */
#define SW_X_BAR        (UI_CONTENT_X + 270)            /*  300 */
#define SW_X_PAIR       (UI_CONTENT_X + 470)            /*  500 */
#define SW_X_LINE       (UI_CONTENT_X + 670)            /*  700 */
#define SW_X_STEM       (UI_CONTENT_X + 870)            /*  900 */
#define SW_X_CROSS      (UI_CONTENT_X + 1000)           /* 1030 */
#define SW_SPAN         180
#define SW_CROSS_W      120

/* sRGB relative luminance and the WCAG contrast ratio, over wp_palette_ink —
 * the MEASURED table, so these are numbers about the panel rather than about
 * the saturated colours the UI draws with.
 *
 * libm here and nowhere near the device: ui_chart.h's integer rule is about
 * code that runs on both x86 and Xtensa and must agree to the pixel. This runs
 * on a desktop, prints a caption, and decides nothing. */
static double sw_lin(double c)
{
    return c <= 0.04045 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4);
}

static double sw_luma(const uint8_t rgb[3])
{
    return 0.2126 * sw_lin(rgb[0] / 255.0)
         + 0.7152 * sw_lin(rgb[1] / 255.0)
         + 0.0722 * sw_lin(rgb[2] / 255.0);
}

static double sw_contrast(int a, int b)
{
    const double la = sw_luma(wp_palette_ink[a]), lb = sw_luma(wp_palette_ink[b]);
    const double hi = la > lb ? la : lb;
    const double lo = la > lb ? lb : la;
    return (hi + 0.05) / (lo + 0.05);
}

/* Set a label and check every glyph of it in the same breath. The sheet's
 * strings are the SIMULATOR's own rather than the paper's, so they are not in
 * ui_strings.h and the generator has never seen them — which is exactly why
 * they have to be covered here instead of trusted. */
static void sw_lab(lv_obj_t *par, int x, int y, const lv_font_t *f, const char *txt)
{
    cover_all("the ink sheet", txt);
    ui_lab(par, x, y, f, txt);
}

static void sw_row_head(lv_obj_t *par, int y, const char *name, const char *note)
{
    sw_lab(par, SW_X_LABEL, y, UI_F_BODY_LG, name);
    cover_all("the ink sheet", note);
    ui_lab_box(par, SW_X_LABEL, y + 30, 250, 60, UI_F_LABEL,
               LV_TEXT_ALIGN_LEFT, note);
}

/* A flat palette entry, in the four forms. The middle stem is black in every
 * row so that the narrowest form is always shown against the ink it will
 * usually stand beside. */
static void sw_flat_row(lv_obj_t *par, int y, uint32_t rgb)
{
    const lv_color_t c = lv_color_hex(rgb);
    lv_obj_t *o;

    o = ui_fill(par, SW_X_BAR, y, SW_SPAN, SW_BAR_H);
    lv_obj_set_style_bg_color(o, c, 0);

    o = ui_fill(par, SW_X_PAIR, y, SW_SPAN / 2, SW_BAR_H);
    lv_obj_set_style_bg_color(o, c, 0);
    ui_fill(par, SW_X_PAIR + SW_SPAN / 2, y, SW_SPAN / 2, SW_BAR_H);

    o = ui_fill(par, SW_X_LINE, y + SW_BAR_H / 2, SW_SPAN, SW_LINE_W);
    lv_obj_set_style_bg_color(o, c, 0);

    for (int i = 0; i < 3; i++) {
        o = ui_fill(par, SW_X_STEM + i * 2 * SW_STEM_W, y, SW_STEM_W, SW_BAR_H);
        if (i != 1) lv_obj_set_style_bg_color(o, c, 0);
    }
}

/* A FIFTH FORM, AND THE ONE THIS SHEET IS A TEST FOR RATHER THAN A SPECIMEN OF.
 *
 * A keyline is only true of the pixels at the moment they are laid down, and a
 * bars-and-line graphic draws a rate line ACROSS its bars afterwards — in
 * colour, under a paper halo two pixels wider, because paper is the one thing
 * that separates that line from a black bar. Over a KEYED bar the halo takes
 * the keyline away and puts paper straight onto the 1.10:1 yellow. That is what
 * Broadcom's 3Q26 sheet did: 211 yellow pixels open to the paper along the
 * top-left corner of the net-income bar the falling margin line ran through,
 * and not one of them visible in the source, where ui_series_draw_abs() had
 * drawn a perfectly good keyline a few microseconds earlier.
 *
 * So this row draws exactly that construction — fill, then sleeve, then halo,
 * then line, then the node's halo and the node — with a vertex parked ON the
 * fill's top-left corner and a segment crossing its left keyline, which are the
 * two places it failed. Nothing new asserts on it: it sits below the bare-
 * yellow control, so ink_sheet_selftest()'s existing "no yellow below the
 * control reaches the paper" and "no keyline edge below it is thinner than
 * UI_SERIES_KEY_W" cover it. Delete the sleeve and this row fails them both.
 *
 * The geometry is written down here rather than taken from a payload on
 * purpose. A payload-driven version of this case needs the rate line's scaling
 * and the bars' scaling to keep landing on top of each other, and the day one
 * of them moves by three pixels the test still passes and has stopped testing
 * anything. */
static void sw_cross_cb(lv_event_t *e)
{
    lv_obj_t   *o = lv_event_get_target_obj(e);
    lv_layer_t *L = lv_event_get_layer(e);
    if (!o || !L) return;

    const ui_series_t s = (ui_series_t)(intptr_t)lv_obj_get_user_data(o);

    lv_area_t a;
    lv_obj_get_coords(o, &a);

    /* The fill, inset so the line has paper to arrive from and to leave for. */
    const lv_area_t fill = { a.x1 + 24, a.y1 + 12, a.x2 - 8, a.y2 };

    /* Two segments, the vertex between them sitting on the fill's top-left
     * corner: P0 out on the paper, P1 over the corner, P2 off the right edge. */
    const int px[3] = { a.x1,      a.x1 + 34,  a.x2      };
    const int py[3] = { a.y1 + 44, a.y1 + 10,  a.y1 + 34 };

    ui_series_draw_abs(L, fill.x1, fill.y1, fill.x2, fill.y2, s);

    if (s == UI_SERIES_KEYED) {
        for (int i = 1; i < 3; i++) {
            ui_series_sleeve_line_abs(L, &fill, px[i - 1], py[i - 1],
                                      px[i], py[i], UI_RULE_MID + 2);
        }
        for (int i = 0; i < 3; i++) {
            ui_series_sleeve_rect_abs(L, &fill, px[i] - 3, py[i] - 3,
                                      px[i] + 3, py[i] + 3);
        }
    }

    for (int i = 1; i < 3; i++) {
        ui_draw_line_c_abs(L, px[i - 1], py[i - 1], px[i], py[i],
                           UI_RULE_MID + 2, UI_PAPER);
    }
    for (int i = 1; i < 3; i++) {
        ui_draw_line_c_abs(L, px[i - 1], py[i - 1], px[i], py[i],
                           UI_RULE_MID, UI_UP);
    }
    for (int i = 0; i < 3; i++) {
        ui_draw_rect_c_abs(L, px[i] - 3, py[i] - 3, px[i] + 3, py[i] + 3,
                           true, 0, UI_PAPER);
    }
    for (int i = 0; i < 3; i++) {
        ui_draw_rect_c_abs(L, px[i] - 2, py[i] - 2, px[i] + 2, py[i] + 2,
                           true, 0, UI_UP);
    }
}

/* The same four forms through ui_series_fill(), which is the only call on the
 * board allowed to put blue or yellow down. The 3 px line is deliberately below
 * UI_SERIES_MIN_PX: what it shows is the documented fallback to SOLID, which is
 * a thing worth being able to see rather than to read about. The fifth is
 * sw_cross_cb()'s, and is drawn immediate-mode because the graphic it stands in
 * for is. */
static void sw_series_row(lv_obj_t *par, int y, ui_series_t s)
{
    ui_series_fill(par, SW_X_BAR, y, SW_SPAN, SW_BAR_H, s);

    ui_series_fill(par, SW_X_PAIR, y, SW_SPAN / 2, SW_BAR_H, s);
    ui_fill(par, SW_X_PAIR + SW_SPAN / 2, y, SW_SPAN / 2, SW_BAR_H);

    ui_series_fill(par, SW_X_LINE, y + SW_BAR_H / 2, SW_SPAN, SW_LINE_W, s);

    for (int i = 0; i < 3; i++) {
        const int x = SW_X_STEM + i * 2 * SW_STEM_W;
        if (i == 1) ui_fill(par, x, y, SW_STEM_W, SW_BAR_H);
        else        ui_series_fill(par, x, y, SW_STEM_W, SW_BAR_H, s);
    }

    ui_series_swatch(par, SW_X_STEM + 6 * SW_STEM_W + 20,
                     y + (SW_BAR_H - UI_SERIES_SWATCH) / 2, s);

    lv_obj_t *cross = ui_pane(par, SW_X_CROSS, y, SW_CROSS_W, SW_BAR_H);
    lv_obj_set_user_data(cross, (void *)(intptr_t)s);
    lv_obj_add_event_cb(cross, sw_cross_cb, LV_EVENT_DRAW_MAIN, NULL);
}

/* The bare-yellow row's band, so the self-test can tell the control apart from
 * a leak. Written by ink_sheet() and read by ink_sheet_selftest(). */
static int g_sw_bare_y0, g_sw_bare_y1;

static void ink_sheet_selftest(void)
{
    const int inside  = yellow_on_paper(NULL, false, g_sw_bare_y0, g_sw_bare_y1);
    const int above   = yellow_on_paper(NULL, false, 0, g_sw_bare_y0);
    const int below   = yellow_on_paper(NULL, false, g_sw_bare_y1, UI_H);
    const int keylined = check_yellow_keyline(NULL, false, g_sw_bare_y1, UI_H);

    /* Does the reachability test bite at all? The bare row is 180 px of yellow
     * sitting on paper with nothing between; if this comes back zero the check
     * on every real page is not checking anything. */
    if (inside == 0) {
        FAIL("the ink sheet: the bare-yellow row reaches the paper nowhere, so "
             "check_yellow_sealed() would pass a sheet of unkeylined yellow");
    }

    /* And does it stay quiet where the keyline is real? Everything below the
     * bare row is drawn through ui_series_fill(). */
    if (above + below > 0) {
        FAILV("the ink sheet: %d yellow pixels outside the bare row reach the "
              "paper — ui_series_fill()'s keyline has a hole in it",
              above + below);
    }
    if (keylined > 0) {
        FAILV("the ink sheet: %d keyline edges below the bare row are thinner "
              "than UI_SERIES_KEY_W", keylined);
    }

    /* THE ONE THAT STOPS THE TWO ABOVE BEING VACUOUS. A ui_series_fill() that
     * drew no yellow at all — a KEYED treatment that quietly fell back to
     * SOLID everywhere, a fill inset until it vanished — passes "no yellow
     * escaped" perfectly and tells nobody. So count the yellow the keylined
     * rows actually laid down and require there to be some. */
    long keyed = 0;
    for (int y = g_sw_bare_y1; y < UI_H; y++) {
        for (int x = 0; x < UI_W; x++) {
            if (ink_at(x, y) == WP_I_YELLOW) keyed++;
        }
    }
    if (keyed == 0) {
        FAIL("the ink sheet: the KEYED row put no yellow on the sheet at all — "
             "\"no yellow escaped\" below it is true and means nothing");
    } else {
        printf("  yellow: %d px bare and open to the paper (the control), "
               "%ld px keylined and sealed\n", inside, keyed);
    }
}

static void ink_sheet(const char *dir, lv_obj_t *news_scr)
{
    static const struct { const char *name; uint32_t rgb; int ink; } FLAT[] = {
        { "BLACK",  WP_RGB_BLACK,  WP_I_BLACK  },
        { "RED",    WP_RGB_RED,    WP_I_RED    },
        { "BLUE",   WP_RGB_BLUE,   WP_I_BLUE   },
        { "GREEN",  WP_RGB_GREEN,  WP_I_GREEN  },
        { "YELLOW", WP_RGB_YELLOW, WP_I_YELLOW },
    };
    static const struct { const char *name, *note; ui_series_t s; } SERIES[] = {
        { "SOLID",  "UI_SERIES_SOLID. Black. The first series of every graphic.",
          UI_SERIES_SOLID },
        { "BLUE",   "UI_SERIES_BLUE. A line over black bars, or a bar with a "
                    "gutter beside it.", UI_SERIES_BLUE },
        { "SCREEN", "UI_SERIES_SCREEN. A 1-in-3 black line screen, which is how "
                    "a paper has always printed a share.", UI_SERIES_SCREEN },
        { "KEYED",  "UI_SERIES_KEYED. Yellow inside a 2 px black keyline, and "
                    "the only legal yellow on the sheet.", UI_SERIES_KEYED },
        { "OPEN",   "UI_SERIES_OPEN. Paper inside a black keyline.",
          UI_SERIES_OPEN },
    };
    static char note[sizeof FLAT / sizeof *FLAT][96];

    lv_obj_t *scr = lv_obj_create(NULL);
    lv_obj_set_style_bg_color(scr, UI_PAPER, 0);
    lv_obj_remove_flag(scr, LV_OBJ_FLAG_SCROLLABLE);
    lv_screen_load(scr);

    sw_lab(scr, UI_CONTENT_X, UI_CONTENT_Y, UI_F_HEADLINE, "The six inks");
    ui_rule(scr, UI_CONTENT_X, UI_CONTENT_Y + 56, UI_CONTENT_W, 2);
    cover_all("the ink sheet",
              "Contrast against the paper, measured off wp_palette_ink. Each ink "
              "as a bar, as a bar abutting black, as a 3 px rule, as a 12 px "
              "stem beside one, and with a haloed rate line drawn across it.");
    ui_lab_box(scr, UI_CONTENT_X, UI_CONTENT_Y + 68, UI_CONTENT_W, 60,
               UI_F_BODY, LV_TEXT_ALIGN_LEFT,
               "Contrast against the paper, measured off wp_palette_ink. Each ink "
               "as a bar, as a bar abutting black, as a 3 px rule, as a 12 px "
               "stem beside one, and with a haloed rate line drawn across it.");

    sw_lab(scr, SW_X_BAR,  UI_CONTENT_Y + 128, UI_F_LABEL, "BAR");
    sw_lab(scr, SW_X_PAIR, UI_CONTENT_Y + 128, UI_F_LABEL, "AGAINST BLACK");
    sw_lab(scr, SW_X_LINE, UI_CONTENT_Y + 128, UI_F_LABEL, "3 PX RULE");
    sw_lab(scr, SW_X_STEM, UI_CONTENT_Y + 128, UI_F_LABEL, "12 PX STEMS");
    sw_lab(scr, SW_X_CROSS, UI_CONTENT_Y + 128, UI_F_LABEL, "RATE LINE");

    int y = UI_CONTENT_Y + SW_HEAD_H;

    printf("the six inks, against the paper (wp_palette_ink):\n");
    for (size_t i = 0; i < sizeof FLAT / sizeof *FLAT; i++) {
        const double paper = sw_contrast(FLAT[i].ink, WP_I_WHITE);
        const double black = sw_contrast(FLAT[i].ink, WP_I_BLACK);

        snprintf(note[i], sizeof note[i], "%.2f:1 ON PAPER / %.2f:1 ON BLACK",
                 paper, black);
        printf("  %-7s #%02X%02X%02X  %5.2f:1 on paper  %5.2f:1 on black\n",
               FLAT[i].name,
               wp_palette_ink[FLAT[i].ink][0], wp_palette_ink[FLAT[i].ink][1],
               wp_palette_ink[FLAT[i].ink][2], paper, black);

        sw_row_head(scr, y, FLAT[i].name, note[i]);
        sw_flat_row(scr, y, FLAT[i].rgb);

        /* The bare-yellow row is the control, and it is the LAST flat row so
         * that everything under it is keylined and the self-test can split the
         * sheet on one number. */
        if (FLAT[i].ink == WP_I_YELLOW) {
            g_sw_bare_y0 = y;
            g_sw_bare_y1 = y + SW_ROW_H;
        }
        y += SW_ROW_H;
    }

    for (size_t i = 0; i < sizeof SERIES / sizeof *SERIES; i++) {
        sw_row_head(scr, y, SERIES[i].name, SERIES[i].note);
        sw_series_row(scr, y, SERIES[i].s);
        y += SW_ROW_H;
    }

    if (y > UI_CONTENT_B) {
        FAILV("the ink sheet runs to y=%d, past the %d bottom margin",
              y, UI_CONTENT_B);
    }

    render();
    shot(dir, "00_inks");

    scan_tree();
    check_margins("the ink sheet");
    ink_sheet_selftest();

    lv_screen_load(news_scr);
    lv_obj_delete(scr);
}

/* --- main ----------------------------------------------------------------- */

static char *slurp(const char *path, size_t *len)
{
    FILE *f = fopen(path, "rb");
    if (!f) return NULL;

    fseek(f, 0, SEEK_END);
    long n = ftell(f);
    fseek(f, 0, SEEK_SET);
    if (n < 0) { fclose(f); return NULL; }

    char *buf = malloc((size_t)n + 1);
    if (!buf) { fclose(f); return NULL; }

    *len = fread(buf, 1, (size_t)n, f);
    buf[*len] = '\0';
    fclose(f);
    return buf;
}

static void usage(void)
{
    fprintf(stderr,
        "usage: sim <shotdir> [--json <file>] [--tiles <dir>] [--only-pages]\n"
        "\n"
        "  --json        typeset this payload instead of the built-in demo snapshot\n"
        "  --tiles       where to look for the photographs it names\n"
        "  --only-pages  A1 and A2 alone; skip the badge, overlay and no-data sheets\n"
        "  --measure     print the seven faces' advance table and exit\n"
        "\n"
        "  NEWS_URL=<url> fetches and parses over the wire, the way the device does.\n");
}

int main(int argc, char **argv)
{
    const char *outdir = "shots";
    const char *json   = NULL;
    bool only_pages    = false;
    bool measure_only  = false;

    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--json") == 0 && i + 1 < argc) {
            json = argv[++i];
        } else if (strcmp(argv[i], "--tiles") == 0 && i + 1 < argc) {
            setenv("WP_TILE_DIR", argv[++i], 1);
        } else if (strcmp(argv[i], "--only-pages") == 0) {
            only_pages = true;
        } else if (strcmp(argv[i], "--measure") == 0) {
            measure_only = true;
        } else if (argv[i][0] == '-') {
            usage();
            return 2;
        } else {
            outdir = argv[i];
        }
    }

    lv_init();
    lv_tick_set_cb(tick_cb);

    lv_display_t *disp = lv_display_create(UI_W, UI_H);
    lv_display_set_flush_cb(disp, flush_cb);
    lv_display_set_buffers(disp, g_render, NULL, sizeof g_render,
                           LV_DISPLAY_RENDER_MODE_FULL);

    lv_obj_t *scr = lv_obj_create(NULL);
    lv_screen_load(scr);

    /* Before anything is built: the table is a property of the committed font
     * files and of nothing on the page. */
    if (measure_only) {
        print_measures();
        return 0;
    }
    ui_news_create(scr);

    /* A named payload, the device's own fetch-and-parse path, or the built-in
     * demo snapshot. Same code, same bytes, same pixels in all three. */
    news_t v;
    const char *url = getenv("NEWS_URL");

    if (json) {
        size_t len = 0;
        char  *txt = slurp(json, &len);
        if (!txt) {
            fprintf(stderr, "sim: cannot read %s\n", json);
            return 2;
        }
        if (!news_parse(txt, len, &v)) {
            fprintf(stderr, "sim: %s is not a payload this device would accept\n",
                    json);
            free(txt);
            return 1;
        }
        free(txt);
        printf("typesetting %s\n", json);
    } else if (url && *url) {
        const news_fetch_result_t r = news_service_fetch(url, &v);
        if (r == NEWS_FETCH_OK) {
            printf("fetched %s -> %d stories, %d figures, %d peers\n",
                   url, v.story_count, v.figure_count, v.peer_count);
        } else {
            printf("fetch of %s failed (%s) — falling back to the demo snapshot\n",
                   url, news_fetch_result_name(r));
            news_mock(&v);
        }
    } else {
        news_mock(&v);
        printf("using the built-in demo snapshot (set NEWS_URL=... for a live fetch)\n");
    }

    /* The measure table in ui_internal.h rests on two numbers — the average
     * advance of the two body faces — and every characters-per-column figure in
     * it and in docs/pages.md is derived from them. They are printed here rather
     * than asserted anywhere, because they are a property of the committed font
     * tables: a face regenerated at a different optical size moves them, and the
     * table that divides column widths by them is then quietly wrong. One line
     * of output on every run is the cheapest way for the number in the header to
     * be something somebody read rather than something two files assert at each
     * other.
     *
     * IT MEASURES SIM_PROSE_SAMPLE, THE SAME FIXED PARAGRAPH `--measure` USES,
     * and that is the whole point of the line rather than an implementation
     * detail. It used to measure `v.stories[0].body` instead — the payload's own
     * copy — which defeated it twice over: the number moved whenever the demo's
     * prose was rewritten, and it disagreed with `--measure` while being printed
     * under the same word. Two correctly-computed means over different samples,
     * one label. That is how three figures for body_16 came to be in circulation
     * at once, and this line was one of them.
     *
     * The payload's own advance is a legitimate thing to want — it is what the
     * copyfitter actually sees — but it answers a different question and would
     * need its own label and its own sample named. One number per question. */
    printf("measure: body_16 %.2f ascii / %.2f prose,"
           "  body_20 %.2f ascii / %.2f prose"
           "  (px per character, prose = SIM_PROSE_SAMPLE)\n",
           mean_advance(UI_F_BODY, ascii_sample()),
           mean_advance(UI_F_BODY, SIM_PROSE_SAMPLE),
           mean_advance(UI_F_BODY_LG, ascii_sample()),
           mean_advance(UI_F_BODY_LG, SIM_PROSE_SAMPLE));

    printf("checking glyph coverage\n");
    check_fixed_strings();
    check_data_strings(&v);

    printf("rendering %s/ at %dx%d in six inks\n", outdir, UI_W, UI_H);

    /* The specimen first, and numbered 00 so it sorts first: it is what the
     * pages below are judged against, and it is the only sheet on which bare
     * yellow is drawn on purpose. --only-pages skips it with everything else
     * that is not A1 or A2. */
    if (!only_pages) ink_sheet(outdir, scr);

    const ui_status_t online = {
        .online = true, .stale = false, .battery_present = true, .battery_pct = 84,
    };
    ui_news_set_status(&online);
    ui_news_tick();

    pass(outdir, "full", 1, &v);

    if (only_pages) {
        printf("%s — %d layout/glyph/colour problem(s)\n",
               g_fail ? "FAILED" : "ok", g_fail);
        return g_fail ? 1 : 0;
    }

    news_t sparse;
    sparse_payload(&sparse);
    check_data_strings(&sparse);
    pass(outdir, "sparse", 3, &sparse);

    news_t thin;
    thin_payload(&thin);
    check_data_strings(&thin);
    pass(outdir, "thin", 5, &thin);

    news_t quiet;
    quiet_payload(&quiet);
    check_data_strings(&quiet);
    pass(outdir, "quiet", 7, &quiet);

    /* The two state chips, which no ordinary render reaches. Both are checked on
     * the full payload, so a chip that failed to draw shows up against a page
     * that otherwise did — and both are also the passes where every change
     * figure on the sheet must have gone back to INK, which is the half of the
     * state signal a reader actually sees from across a room. */
    ui_news_set_data(&v);

    ui_status_t st = online;
    st.stale = true;
    ui_news_set_status(&st);
    render();
    shot(outdir, "09_a1_stale");
    check_page("A1 stale", UI_PAGE_FRONT, &v);

    st.online = false;
    st.battery_present = false;
    ui_news_set_status(&st);
    render();
    shot(outdir, "10_a1_offline");
    check_page("A1 offline", UI_PAGE_FRONT, &v);

    ui_news_set_status(&online);

    /* The setup sheet. It is a PAGE of this paper rather than a modal: the pane
     * covers the news, because on e-Paper a hidden page is still physically on
     * the glass until something paints over it, but it is created under the
     * furniture so the nameplate, the rules, the tape and the folio print over it
     * exactly as they do on A1.
     *
     * Label overlap is deliberately not checked here. The page underneath is
     * still in the tree — hidden it would not be covering anything — so every
     * label on it is legitimately under one of the setup sheet's, which is what
     * "opaque" means. What is checked instead is that the pane really is opaque:
     * the strip between the setup sheet's two bands is bare on this page and
     * dense with news on A1. */
    ui_news_set_overlay(S_WIFI_TITLE, "Claude Post-1A2B",
                        "1. Join that Wi-Fi network\n\n"
                        "2. Stay connected, then open the page it offers");
    render();
    shot(outdir, "11_setup");
    scan_tree();

    want_ink("the setup sheet's headline", UI_CONTENT_X, UI_WELL_Y + 26,
             UI_CONTENT_R, UI_WELL_Y + 91);
    want_ink("the setup sheet's network name", UI_CONTENT_X, UI_WELL_Y + 194,
             UI_CONTENT_R, UI_WELL_Y + 259);
    want_ink("the setup sheet's standing type", UI_CONTENT_X, UI_WELL_Y + 288,
             UI_CONTENT_R, UI_WELL_Y + 500);
    want_blank("the setup sheet covers the news",
               UI_CONTENT_X, UI_WELL_Y + 832, UI_CONTENT_R, UI_WELL_Y + 840);

    check_furniture("the setup sheet", true);
    check_margins("the setup sheet");
    check_masthead("the setup sheet");

    /* The tape, and nothing else. "A setup sheet has no data on it" is what
     * this used to claim, and it is false by the design stated forty lines up:
     * the pane is created UNDER the furniture so that the nameplate, the rules
     * and the tape print over it exactly as they do on A1. The tape is data —
     * two index levels and their changes — so the sheet has data on it, and the
     * assertion caught the furniture doing precisely what it was built to do.
     *
     * ALLOWING THE SLOT IS NOT WEAKENING THE LIVE-DATA RULE, and that is worth
     * being explicit about, because the instinct is that a board serving its own
     * access point has no business printing a green percentage. It has not: a
     * slot PERMITS colour, it does not require it, and every change figure on
     * every sheet goes through ui_chg_colour(), which returns ink whenever
     * ui_data_live() is false. So if the device is genuinely not online while it
     * is provisioning, the tape prints black and this assertion passes exactly
     * as it does now. The two rules are independent and both still hold. */
    slot_t setup_ok[1] = {
        { UI_CONTENT_X, UI_TAPE_Y, UI_CONTENT_R, UI_TAPE_Y + UI_TAPE_H,
          SLOT_CHG, "the tape" },
    };
    check_colour_slots("the setup sheet", setup_ok, 1);
    check_yellow_sealed("the setup sheet");
    ui_news_set_overlay(NULL, NULL, NULL);

    /* No snapshot at all — the state between power-on and the first payload. An
     * unconfigured board shows the demo snapshot and never reaches this, so what
     * has to be true is only that the paper is still the paper: the four rules,
     * the nameplate, one line where the tape goes, and the folio. The well is
     * EMPTY, and that is the right answer rather than a placeholder — a
     * nameplate over an empty page is a paper waiting for news, and "Loading..."
     * set across a broadsheet is a device. */
    ui_news_set_data(NULL);
    render();
    shot(outdir, "12_a1_nodata");
    scan_tree();

    check_rules("A1 no data");
    want_blank("the no-data sheet's well", UI_CONTENT_X, UI_WELL_Y,
               UI_CONTENT_R, UI_WELL_B);
    want_ink("the tape says the board is waiting", UI_CONTENT_X, UI_TAPE_Y,
             UI_CONTENT_R, UI_TAPE_Y + UI_TAPE_H);

    check_margins("A1 no data");
    check_masthead("A1 no data");
    check_colour_slots("A1 no data", NULL, 0);
    check_yellow_sealed("A1 no data");
    check_label_overlap("A1 no data");

    /* Last, so the high-water mark covers every page, badge and overlay this
     * run built — including the ones only these late passes reach. */
    check_lvgl_budget();

    printf("%s — %d layout/glyph/colour/memory problem(s)\n",
           g_fail ? "FAILED" : "ok", g_fail);
    return g_fail ? 1 : 0;
}
