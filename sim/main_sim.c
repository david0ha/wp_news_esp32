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
 * The two failure modes it exists for are the ones that cost the most to find on
 * hardware, and on this panel a refresh is twenty-five seconds of flashing: a
 * missing glyph (a tofu box), and a widget that silently rendered nothing
 * because it was positioned into a band that had already been claimed. It also
 * carries the assertion the design spec is otherwise unenforceable by — that
 * colour on this sheet is data and appears in exactly the places §6 lists.
 *
 * The preview images are written in wp_palette_ink, the MEASURED inks, rather
 * than in the saturated primaries the UI draws with: a screenshot in primaries
 * flatters the page into a decision nobody could make from the real panel.
 *
 *   ./sim.sh                                            # the built-in demo snapshot
 *   NEWS_URL=http://localhost:8123/news.json ./sim.sh   # the device's own fetch path
 */
#include "lvgl.h"

#include "ui_news.h"
#include "ui_internal.h"      /* the shared grid — see sim/CMakeLists.txt */
#include "ui_fonts.h"
#include "ui_strings.h"
#include "news_mock.h"
#include "news_model.h"
#include "news_service.h"
#include "wp_palette.h"
#include "epd6_transpose.h"

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
 * dither landed on green", which is the anti-aliasing §6 exists to keep off the
 * sheet. Without it every such failure costs a bisect. */
static uint16_t g_want[(size_t)UI_W * UI_H];

static uint32_t g_tick;
static int      g_fail;
static bool     g_flushed;

#define FAILV(fmt, ...) do { g_fail++; printf("  FAIL " fmt "\n", __VA_ARGS__); } while (0)
#define FAIL(msg)       do { g_fail++; printf("  FAIL %s\n", (msg)); } while (0)

/* Enough of a failure to see the shape of it, not enough to bury the next
 * check. Every one of these prints coordinates: a count alone tells you the
 * page is wrong and not where. */
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
 * asserted against the PREVIOUS pass's pixels and quietly pass. Then the screen
 * is invalidated wholesale: LVGL redraws only what is dirty, and "dirty" after
 * ui_news_set_data() is whatever the setters happened to touch. */
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

/* The palette index of a pixel, or WP_I_WHITE for anything off the sheet, so a
 * predicate can be handed a box that runs past an edge without a bounds test of
 * its own. A code that is not one of the six is a quantizer that has stopped
 * being the only place the decision is made, and it is worth a failure of its
 * own rather than a silent -1 propagating into an array index. */
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
 * wp_quantize565() expands it, so a failure message reports the value the
 * quantizer actually saw and not a rounding of it. Returns a pointer to a
 * static buffer; one call per printf. */
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
 * like: a warm off-white, a brick red, an olive green. The saturated palette
 * the UI draws with would make every screenshot a cartoon, and the whole reason
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
 * the font will simply say. Ask it whether it has each codepoint of each string
 * it is going to be asked to draw.
 *
 * Half these strings arrive over the network, so the check has to run over the
 * DATA and not only over the source literals. */

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
 * S_DATA_PUNCT), and the tier engine moves strings between them freely — a
 * headline demoted from the lead well to a 364 px column changes face without
 * changing a byte, and the same story appears again on A2 in deck_24. Checking
 * only today's face would let a regression through until the day a payload got
 * one story shorter.
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

static void check_fixed_strings(void)
{
    static const char *const FIXED[] = {
        S_RUNNING_HEAD, S_BRAND,
        S_BADGE_DEMO, S_BADGE_STALE, S_BADGE_OFFLINE, S_NO_DATA, S_WAITING,
        S_KEY_PAGE, S_KEY_REFRESH, S_KEY_WIFI,
        S_PAGE_FRONT, S_PAGE_MARKETS,
        S_MARKET_WRAP, S_PORTFOLIO, S_DAYS_RANGE,
        /* The market summary's copy, which is the only prose on the sheet the
         * BOARD wrote. It is composed at runtime out of these and an index
         * name, so the format strings are checked here and the names arrive
         * through check_data_strings() — between them that is every glyph the
         * finished sentence can contain. */
        S_SUMMARY_KICKER, S_SUMMARY_UP, S_SUMMARY_DOWN, S_SUMMARY_MIXED,
        S_SUMMARY_FLAT, S_SUMMARY_DECK, S_SUMMARY_DECK_ONE,
        S_COL_SYMBOL, S_COL_NAME, S_COL_LAST, S_COL_CHG,
        S_IN_BRIEF, S_FOLIO_A1, S_FOLIO_A2, S_UPDATED, S_NEXT,
        S_WIFI_TITLE, S_RESTARTING,
        /* The setup sheet's standing type. It is the longest fixed copy on the
         * board and the first page a new owner sees, so a character outside the
         * faces' coverage would be a tofu box in the one place nobody can
         * afford one. */
        S_SETUP_KICKER, S_SETUP_KEYS, S_SETUP_DECK, S_SETUP_NETWORK,
        S_SETUP_ABOUT_H, S_SETUP_ABOUT, S_SETUP_AFTER_H, S_SETUP_AFTER,
        S_SETUP_TROUBLE_H, S_SETUP_TROUBLE,
        S_SETUP_SOURCE_H, S_SETUP_SOURCE,
        /* Characters that exist only inside a runtime-composed string — the
         * separators in the folio's key legend, the digits and the decimal
         * point of every figure ui_money() and ui_pct() produce. This is the
         * check that catches the whole class of bug where a label renders but
         * the space in "%s %s" comes out as a box. */
        S_COMPOSED_CHARS,
        S_DATA_PUNCT,
        "0123456789",
    };
    for (size_t i = 0; i < sizeof FIXED / sizeof *FIXED; i++) {
        cover_all("fixed string", FIXED[i]);
    }

    static const char *const WEEKDAYS[7] = S_WEEKDAYS_ABBR;
    for (int i = 0; i < 7; i++) cover_all("weekday", WEEKDAYS[i]);

    /* And the caps spellings the no-payload dateline is composed from, which is
     * the one slot on the sheet whose string is built rather than set. */
    static const char *const WD_CAPS[7] = S_WEEKDAYS_CAPS;
    static const char *const MONTHS[12] = S_MONTHS_CAPS;
    for (int i = 0; i < 7; i++)  cover_all("weekday", WD_CAPS[i]);
    for (int i = 0; i < 12; i++) cover_all("month", MONTHS[i]);

    /* The masthead face against the one string it exists to draw, and against
     * nothing else. Editing S_MASTHEAD without regenerating the fonts is
     * exactly the mistake this catches, on the largest text on the sheet. */
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

    for (int i = 0; i < v->index_count; i++) {
        cover_all("index symbol", v->indices[i].symbol);
        cover_all("index name",   v->indices[i].name);
    }
    for (int i = 0; i < v->ticker_count; i++) {
        cover_all("ticker symbol", v->tickers[i].symbol);
        cover_all("ticker name",   v->tickers[i].name);
    }
    for (int i = 0; i < v->story_count; i++) {
        const news_story_t *s = &v->stories[i];
        cover_all("kicker",   s->kicker);
        cover_all("headline", s->headline);
        cover_all("deck",     s->deck);
        cover_all("byline",   s->byline);
        cover_all("body",     s->body);
        cover_all("symbol",   s->symbol);
        cover_all("chart span", s->chart.span);
        cover_all("caption",  s->photo.caption);
        cover_all("credit",   s->photo.credit);
    }
}

/* --- the sheet ------------------------------------------------------------
 *
 * Every check below reads the bands and the rules out of ui_internal.h's own
 * X-macro tables rather than out of a transcription of them. That is the whole
 * reason those tables exist: a band moved in the header moves the page and the
 * assertion together, and a band moved in a page file and not in the header
 * fails here with the row it landed on. */

#define SIM_RULE(name, y, w) { name, (y), (w) },
static const struct { const char *name; int y, w; } SHEET_RULES[] = {
    UI_RULE_TABLE(SIM_RULE)
};

#define SIM_BAND(name, y, h) { name, (y), (h) },
static const struct { const char *name; int y, h; } SHEET_BANDS[] = {
    UI_BAND_TABLE(SIM_BAND)
};

#define NRULES ((int)(sizeof SHEET_RULES / sizeof *SHEET_RULES))
#define NBANDS ((int)(sizeof SHEET_BANDS / sizeof *SHEET_BANDS))

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

/* Nothing crosses the margin, on any of the four sides. The margin is what
 * makes the sheet read as a page in a frame rather than as a screen with
 * content pushed to its edges, and it is the one measurement a reader notices
 * being wrong without being able to say why.
 *
 * ONE PIXEL OF SLACK, and only on the left and right, because a glyph's ink is
 * allowed to start left of its origin and several of ours do. In
 * ui_font_display_56, A J V W j v y all carry ofs_x = -1: a Didone's pointed
 * foot and its flat apex serif overhang, which is how the family is drawn and
 * why a headline set flush left OPTICALLY aligns with the body text beneath it.
 * Pulling the label in by a pixel to satisfy a bounding box would make the
 * largest text on the sheet visibly inset against everything below it.
 *
 * So the check permits a single column of ink and still catches a real overrun,
 * which is always two pixels or more — a mispositioned widget, a rule drawn
 * from the wrong origin, a label wider than its slot. Top and bottom get no
 * slack: there is no vertical equivalent of a side bearing at a margin. */
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

/* Every band has something in it. A band that rendered nothing is a failure and
 * not an empty state: the tier engine's whole job is to promote content up a
 * tier rather than leave paper, so 372 px of blank in the middle of the sheet
 * means the promotion did not happen. */
static void check_bands_filled(const char *pass)
{
    for (int b = 0; b < NBANDS; b++) {
        char what[96];
        snprintf(what, sizeof what, "%s: band %s", pass, SHEET_BANDS[b].name);
        want_ink(what, UI_CONTENT_X, SHEET_BANDS[b].y,
                 UI_CONTENT_R, SHEET_BANDS[b].y + SHEET_BANDS[b].h);
    }
}

/* A2's bands are its own and are private to ui_page_markets.c, so the band
 * table above cannot be pointed at them and copying them here is precisely the
 * second grid ui_internal.h's header warns against. What is checkable without
 * knowing them is where the page's ink starts, where it stops, and whether
 * anything between the two is bare.
 *
 * THIS CHECK CHANGED SHAPE, and the reason is worth writing down. It used to
 * demand ink in every 100 px strip of the content area — "the page fills the
 * sheet" — which is not a property a page can always have: two indices, three
 * quotations and one brief is a real payload, and the only way to satisfy the
 * assertion on that day was to inflate the rows until they reached the foot. The
 * markets page duly did, and the result passed: three watchlist rows at 290 px,
 * each holding one 24 px line of type and a sparkline stretched to 680 x 130 of
 * bare diagonal. The assertion was green and the page was broken, which is the
 * worst outcome available — an assertion that can be satisfied the wrong way
 * trains the code to satisfy it the wrong way, and the next person to see a
 * "nothing rendered" failure will reach for a taller row.
 *
 * So it asks the two questions that have one answer each:
 *
 *  - No HOLE. Between the page's topmost and bottommost inked rows, every strip
 *    carries ink. A gap in the MIDDLE of a page is a widget that rendered
 *    nothing, which is the bug worth catching and the only one the old form ever
 *    really found.
 *  - Bounded trailing paper. A page is allowed to END — a rule under the last
 *    row and the rest of the sheet left as paper — but not by so much that the
 *    payload should plainly have been given a different layout instead of simply
 *    stopping. A quarter of the sheet is where that line is drawn.
 *
 * The window stops at the hairline the folio hangs from, because the folio and
 * that hairline are FURNITURE: they print at the foot of every page whatever the
 * news did, so including them would make every page end exactly at the bottom
 * margin and measure no trailing paper at all. */
#define SIM_SLICE     100

/* THE TRAILING BOUND MOVED, from UI_CONTENT_H / 4 (385 px) to UI_CONTENT_H / 3
 * (513), and it is written down here because a constant like this is exactly
 * the kind a reader wants to know was reasoned rather than reached for.
 *
 * A quarter was a first estimate, invented in the same breath as the check
 * itself, and it landed 26 px from a page that is genuinely correct: two
 * indices, three quotations and one brief compose to a sheet that ends at
 * y=1185 with 359 px of paper under its closing rule. The obvious way to pass
 * it was to give the rows a second, higher ceiling and let them grow until they
 * reached the foot — which is the failure the ceilings in ui_page_markets.c
 * exist to prevent, and which this check was rewritten once already to stop
 * rewarding. An assertion that can be satisfied the wrong way trains the code
 * to satisfy it the wrong way; that is the whole reason it asks about holes
 * rather than about fullness.
 *
 * At a third of the sheet it still catches both things it is for. A page that
 * renders a masthead, three rows and a folio is 90% paper and still fails,
 * which is the case worth failing. A thin payload that ends its page early and
 * rules under it is not. */
#define SIM_TRAIL_MAX (UI_CONTENT_H / 3)

static void check_sheet_filled(const char *pass)
{
    int top = -1, bot = -1;

    for (int y = UI_CONTENT_Y; y < UI_TICKER_RULE_Y; y++) {
        if (!any_ink(UI_CONTENT_X, y, UI_CONTENT_R, y + 1)) continue;
        if (top < 0) top = y;
        bot = y;
    }

    if (top < 0) {
        FAILV("%s: nothing at all is printed between the top margin and the folio",
              pass);
        return;
    }

    for (int y = top; y <= bot; y += SIM_SLICE) {
        int y1 = y + SIM_SLICE;
        if (y1 > bot + 1) y1 = bot + 1;
        char what[128];
        snprintf(what, sizeof what,
                 "%s: the strip at y=%d, inside a page that runs y[%d..%d]",
                 pass, y, top, bot);
        want_ink(what, UI_CONTENT_X, y, UI_CONTENT_R, y1);
    }

    const int trail = UI_TICKER_RULE_Y - (bot + 1);
    if (trail > SIM_TRAIL_MAX) {
        FAILV("%s: the page's last ink is at y=%d and the folio's rule at y=%d — "
              "%d px of paper, past the %d a page may end short by",
              pass, bot, UI_TICKER_RULE_Y, trail, SIM_TRAIL_MAX);
    }
}

/* The masthead, measured off the glass rather than off the font tables.
 *
 * S_MASTHEAD sets 1012 px solid at 112 and is tracked out to about 1102 of the
 * 1140 available, and this is the one measurement in the whole design that can
 * only fail at full size: a face regenerated a fraction wider, or a longer
 * paper name, and the largest text on the sheet either ellipsizes or stops
 * being centred. Both are visible from across a room, and neither is visible in
 * any host test. */
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

    /* Centred is stated as "the two margins agree", which is the same thing and
     * says which way it drifted. Four half-pixels of slack is two pixels of
     * centre, and a blackletter's own side bearings are not symmetric. */
    const int gap_l = l - UI_CONTENT_X;
    const int gap_r = UI_CONTENT_R - 1 - r;
    if (gap_l - gap_r > 4 || gap_r - gap_l > 4) {
        FAILV("%s: the masthead is off centre — %d px of paper on the left, %d on the right",
              pass, gap_l, gap_r);
    }
}

/* --- slots ---------------------------------------------------------------
 *
 * The pixel checks above catch ink in the wrong place; this catches a WIDGET in
 * the wrong place, which is the same bug one step earlier and with a name
 * attached. LVGL's tree is walked and every visible object's box is held
 * against the sheet: inside the margins, and strictly between two consecutive
 * rules from §3.
 *
 * "Between two rules" is the whole containment test, and it is exact rather
 * than approximate: the seven rules divide the sheet into eight gaps, each gap
 * holds exactly one band plus its slack, and a widget that ends up in the wrong
 * band has to cross a rule to get there. Stating it that way also lets the
 * masthead be what it is — 113 px of face in a 112 px band, borrowing the
 * pixel from the ten of clearance above the heavy rule — without needing an
 * exception, because 176 is still short of 186.
 *
 * Only A1's widgets are held against it — walk()'s `slots` flag. A2's bands are
 * its own and cross A1's rule rows by design, so pointing this at them would be
 * asserting one page's grid on another; check_sheet_filled() is what that page
 * gets instead. */
static void check_obj(const char *pass, lv_obj_t *o)
{
    lv_area_t a;
    lv_obj_get_coords(o, &a);

    const int w = lv_area_get_width(&a), h = lv_area_get_height(&a);

    /* The sheet itself: the screen, the two full-bleed page panes, the overlay.
     * They are full-bleed on purpose — a page positions a child at UI_LEAD_Y
     * and that is where it lands — so they are the one thing that legitimately
     * covers the margin. */
    if (w >= UI_W && h >= UI_H) return;
    if (w <= 0 || h <= 0) return;

    for (int r = 0; r < NRULES; r++) {
        const int ry = SHEET_RULES[r].y, rw = SHEET_RULES[r].w;

        /* The rule objects themselves occupy exactly those rows. */
        if (a.y1 == ry && a.y2 == ry + rw - 1) return;

        if (a.y1 <= ry + rw - 1 && a.y2 >= ry) {
            FAILV("%s: a widget at x[%d..%d] y[%d..%d] crosses the %s rule at y=%d",
                  pass, a.x1, a.x2, a.y1, a.y2, SHEET_RULES[r].name, ry);
            return;
        }
    }

    if (a.x1 < UI_CONTENT_X || a.x2 >= UI_CONTENT_R
        || a.y1 < UI_CONTENT_Y || a.y2 >= UI_CONTENT_B) {
        FAILV("%s: a widget at x[%d..%d] y[%d..%d] runs past the %d px margin",
              pass, a.x1, a.x2, a.y1, a.y2, UI_MARGIN);
    }
}

/* --- two labels on one piece of paper -------------------------------------
 *
 * The check that catches type printed over type, which no pixel predicate can:
 * both copies are black, both are inside their band, and the result is a smear
 * that reads as a rendering fault rather than as a layout one. It is worth its
 * own assertion because the way it happens is structural — two files each
 * believing they own a band, which on a sheet where the furniture is drawn by
 * one file and the news by another is the standing risk.
 *
 * LABELS only, and only labels with text in them. Panes overlap by design
 * (a container holds its children, the ribbon's marks pane spans the change
 * row, a badge chip sits under its own inverted word), and an empty label is a
 * box with nothing in it — a slot the payload did not fill, which is the normal
 * case and not a collision. */
#define SIM_LABELS_MAX 1024

static struct { lv_area_t a; const char *txt; } g_lab[SIM_LABELS_MAX];
static int g_labs;

static bool blank_text(const char *s)
{
    for (; *s; s++) if (*s != ' ' && *s != '\n' && *s != '\r' && *s != '\t') return false;
    return true;
}

static void walk(const char *pass, lv_obj_t *o, int depth, bool slots)
{
    if (!o || lv_obj_has_flag(o, LV_OBJ_FLAG_HIDDEN)) return;

    if (depth > 0) {
        if (slots) check_obj(pass, o);

        if (lv_obj_check_type(o, &lv_label_class)) {
            const char *txt = lv_label_get_text(o);
            if (txt && !blank_text(txt) && g_labs < SIM_LABELS_MAX) {
                lv_obj_get_coords(o, &g_lab[g_labs].a);
                g_lab[g_labs].txt = txt;
                g_labs++;
            }
        }
    }

    const uint32_t n = lv_obj_get_child_count(o);
    for (uint32_t i = 0; i < n; i++) {
        walk(pass, lv_obj_get_child(o, i), depth + 1, slots);
    }
}

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

/* --- colour ---------------------------------------------------------------
 *
 * The assertion this file exists for, and the one that keeps §6 true as the
 * page evolves. Colour on this sheet is data: green and red on percentage
 * changes and their marks, in the index ribbon, the portfolio rail and the
 * quotation table's CHG column, and a photo tile which arrives already dithered
 * across all six inks. Everything else is black on white.
 *
 * The rule is not a preference. Every exact palette colour takes
 * wp_quantize()'s identity path, so black type and black hairlines come out
 * flat; a colour anywhere between two inks dithers, and a dithered hairline is
 * a dashed one. A page that starts spending colour on ornament is a page where
 * the two colours that carry meaning stop being seen.
 *
 * Blue and yellow are checked separately and everywhere, on both pages: they
 * never reach the glass from the UI at all, so that half of the policy needs no
 * geometry and holds even where A2's is private to its own file. */
typedef struct { int x0, y0, x1, y1; const char *why; } slot_t;

static bool inside(const slot_t *s, int x, int y)
{
    return x >= s->x0 && x < s->x1 && y >= s->y0 && y < s->y1;
}

/* The photograph is the one place all six inks are allowed, and it is an
 * exemption rather than a hole in the policy: a tile arrives already dithered
 * across the full palette by tools/make_tile.py, so blue in a sky and yellow in
 * a lit window are the tile doing exactly its job. Everything the UI DRAWS still
 * has to be black, white, green or red.
 *
 * The exemption is a rectangle rather than a flag because that is what makes it
 * safe: a stray blue pixel one row above the slot still fails, which is the
 * case worth catching — a blit landing off by a row, or a widget drawn in a
 * colour it should not own, immediately next to the one region where colour is
 * unremarkable. */
static const slot_t PHOTO_SLOT = {
    UI_LEAD_VIS_X, UI_LEAD_SPLIT_Y,
    UI_LEAD_VIS_X + UI_LEAD_VIS_W, UI_LEAD_SPLIT_Y + UI_LEAD_VIS_H,
    "the lead's photo slot",
};

static bool in_photo(const slot_t *photo, int x, int y)
{
    return photo && inside(photo, x, y);
}

static void check_no_blue_yellow(const char *pass, const slot_t *photo)
{
    int seen = 0;
    for (int y = 0; y < UI_H; y++) {
        for (int x = 0; x < UI_W; x++) {
            const int i = ink_at(x, y);
            if (i != WP_I_BLUE && i != WP_I_YELLOW) continue;
            if (in_photo(photo, x, y)) continue;
            if (seen++ < REPORT_MAX) {
                FAILV("%s: %s at (%d,%d), drawn as %s — neither ink may reach the glass",
                      pass, INK_NAME[i], x, y, wanted_at(x, y));
            }
        }
    }
    if (seen > REPORT_MAX) {
        printf("       ...and %d more such pixels\n", seen - REPORT_MAX);
    }
}

static void check_colour_slots(const char *pass, const slot_t *ok, int n)
{
    int seen = 0;

    for (int y = 0; y < UI_H; y++) {
        for (int x = 0; x < UI_W; x++) {
            const int i = ink_at(x, y);
            if (i == WP_I_BLACK || i == WP_I_WHITE) continue;

            bool allowed = false;
            for (int s = 0; s < n && !allowed; s++) allowed = inside(&ok[s], x, y);
            if (allowed) continue;

            /* The slots are named once, at the first failure. "Outside every
             * slot" is only actionable if the reader can see which slots those
             * were — the alternative is a coordinate and a trip to this file. */
            if (seen == 0) {
                printf("  colour is allowed only in:");
                for (int s = 0; s < n; s++) {
                    printf("%s %s x[%d..%d) y[%d..%d)", s ? ";" : "",
                           ok[s].why, ok[s].x0, ok[s].x1, ok[s].y0, ok[s].y1);
                }
                printf("\n");
            }
            if (seen++ < REPORT_MAX) {
                FAILV("%s: %s at (%d,%d), drawn as %s — outside every slot allowed to carry colour",
                      pass, INK_NAME[i], x, y, wanted_at(x, y));
            }
        }
    }
    if (seen > REPORT_MAX) {
        printf("       ...and %d more coloured pixels outside their slots\n",
               seen - REPORT_MAX);
    }
}

/* The quotation table's CHG column, run out of the field widths ui_internal.h
 * states as a sum. It is arithmetic on the header's own constants rather than a
 * copy of ui_page_front.c's FP_T_CHG_X, so a field widened there without its
 * neighbour narrowed moves this box with it. */
#define SIM_CHG_X  (UI_TICKER_X + UI_TICKER_SYM_W + UI_TICKER_NAME_W \
                    + UI_TICKER_LAST_W + 3 * UI_TICKER_FIELD_GAP)

/* Where a figure may be green or red on A1. The rail's x is not pinned because
 * the rail widens into the columns a thin paper's missing stories left, so what
 * is fixed about it is the eight rows, not the measure they are set across. */
static int a1_colour_slots(const news_t *v, slot_t *out)
{
    int n = 0;

    out[n++] = (slot_t){ UI_CONTENT_X, UI_RIBBON_Y, UI_CONTENT_R,
                         UI_RIBBON_Y + UI_RIBBON_H, "the index ribbon" };
    out[n++] = (slot_t){ UI_CONTENT_X, UI_RAIL_ROW_Y, UI_CONTENT_R,
                         UI_RAIL_ROW_Y + UI_RAIL_ROWS * UI_RAIL_ROW_H,
                         "the portfolio rail" };
    out[n++] = (slot_t){ SIM_CHG_X, UI_TICKER_ROW_Y, SIM_CHG_X + UI_TICKER_CHG_W,
                         UI_TICKER_ROW_Y + UI_TICKER_ROWS * UI_TICKER_ROW_H,
                         "the quotation table's CHG column" };
    out[n++] = PHOTO_SLOT;

    /* On a day that brought no stories the lead well IS the index ribbon, set
     * at the size a headline is set in, so the whole band carries the same
     * figures band 4 does. That promotion is the one thing that legitimately
     * puts colour in band 5, and it is conditional here for the same reason it
     * is conditional in the page: on any other day this band is type. */
    if (v && v->story_count == 0 && v->index_count > 0) {
        out[n++] = (slot_t){ UI_CONTENT_X, UI_LEAD_Y, UI_CONTENT_R,
                             UI_LEAD_Y + UI_LEAD_H, "the lead well's index panel" };
    }
    return n;
}

/* --- the passes -----------------------------------------------------------
 *
 * One helper per page, so a payload can be pointed at both and the assertions
 * do not have to be repeated at each call site. A1 gets the whole battery; A2
 * gets everything that does not need its private geometry. */

static void check_a1(const char *pass, const news_t *v)
{
    slot_t ok[5];
    const int n = a1_colour_slots(v, ok);

    check_rules(pass);
    check_margins(pass);
    check_masthead(pass);
    check_bands_filled(pass);
    check_no_blue_yellow(pass, &PHOTO_SLOT);
    check_colour_slots(pass, ok, n);

    g_labs = 0;
    walk(pass, lv_screen_active(), 0, true);
    check_label_overlap(pass);
}

static void check_a2(const char *pass)
{
    check_margins(pass);
    check_sheet_filled(pass);
    check_no_blue_yellow(pass, NULL);

    /* A2's bands are private to its own file, so the slot check has nothing to
     * hold its widgets against — but two labels on one piece of paper is a
     * property of the tree and not of the grid, and it is the failure a sheet
     * whose furniture is drawn by one file and whose news is drawn by another
     * is most likely to have. */
    g_labs = 0;
    walk(pass, lv_screen_active(), 0, false);
    check_label_overlap(pass);

    /* Bands 1 and 8 frame the SHEET rather than either page, so their two rules
     * are printed on the same rows of both — the kicker strip's hairline at the
     * top and the one the folio hangs from at the foot. The five between them
     * are A1's alone. */
    check_rule(pass, "kicker",  UI_KICKER_RULE_Y, UI_KICKER_RULE_W);
    check_rule(pass, "folio",   UI_TICKER_RULE_Y, UI_TICKER_RULE_W);

    char what[96];
    snprintf(what, sizeof what, "%s: the kicker strip", pass);
    want_ink(what, UI_CONTENT_X, UI_KICKER_Y, UI_CONTENT_R, UI_KICKER_Y + UI_KICKER_H);
    snprintf(what, sizeof what, "%s: the running head", pass);
    want_ink(what, UI_CONTENT_X, UI_MAST_Y, UI_CONTENT_R, UI_MAST_Y + UI_MAST_H);
    snprintf(what, sizeof what, "%s: the folio", pass);
    want_ink(what, UI_CONTENT_X, UI_FOLIO_Y, UI_CONTENT_R, UI_FOLIO_Y + UI_FOLIO_H);
}

/* The state word: DEMO, STALE or OFFLINE, set as black tracked caps on the
 * kicker strip's centre slot.
 *
 * This assertion used to look for a CHIP — a filled black rectangle with the
 * word reversed out of it — and it was written that way because that is what
 * the page drew. It is stated the other way round now, and deliberately: the
 * word replaced the chip because a filled pill with reversed type is the one
 * inverted region on a sheet whose whole brief is white paper and black type,
 * and it reads as a status badge on a device. So what is checked is that the
 * strip's centre carries INK — the word is there — and that at least one row of
 * that centre is PAPER, which a word always leaves and a solid chip never does.
 * The second half is the half that would catch the chip coming back. */
static void want_badge(const char *what)
{
    const int x0 = UI_W / 2 - 16, x1 = UI_W / 2 + 16;
    bool word = false, gap = false;

    for (int y = UI_KICKER_Y; y < UI_KICKER_Y + UI_KICKER_H; y++) {
        if (any_ink(x0, y, x1, y + 1)) word = true;
        else                           gap  = true;
    }
    if (!word) FAILV("%s: the strip's centre is bare paper — the word is missing", what);
    if (!gap)  FAILV("%s: the strip's centre inks every row — that is a chip, not a word", what);
}

/* --- the payloads ---------------------------------------------------------
 *
 * Three, and each is a shape the tier engine resolves differently. The demo
 * snapshot is the widest the page gets — four stories, five indices, sixteen
 * quotations — and is also the board's out-of-box experience, so it is the one
 * that has to look like a newspaper. The other two are what the promotion rules
 * in §4 exist for, and neither may leave a hole. */

static void sparse_payload(news_t *v)
{
    memset(v, 0, sizeof *v);
    v->valid = true;

    news_str_copy(v->edition,      sizeof v->edition,      "PERSONAL PORTFOLIO EDITION");
    news_str_copy(v->dateline,     sizeof v->dateline,     "TUESDAY, AUGUST 11, 2026");
    news_str_copy(v->session,      sizeof v->session,      "U.S. MARKETS OPEN — 11:04 ET");
    news_str_copy(v->as_of,        sizeof v->as_of,        "AS OF 00:04 KST");
    news_str_copy(v->generated_at, sizeof v->generated_at, "2026-08-11T00:04:00Z");

    v->index_count = 2;
    news_str_copy(v->indices[0].symbol, sizeof v->indices[0].symbol, "SPX");
    news_str_copy(v->indices[0].name,   sizeof v->indices[0].name,   "S&P 500");
    v->indices[0].last_c = 641283;
    v->indices[0].chg_bp = 62;
    news_str_copy(v->indices[1].symbol, sizeof v->indices[1].symbol, "IXIC");
    news_str_copy(v->indices[1].name,   sizeof v->indices[1].name,   "Nasdaq");
    v->indices[1].last_c = 2140055;
    v->indices[1].chg_bp = -138;

    v->ticker_count = 3;
    static const struct { const char *sym, *name; int32_t last, bp; } Q[3] = {
        { "AAPL", "Apple",     23140, 31   },
        { "MSFT", "Microsoft", 51022, -18  },
        { "KO",   "Coca-Cola",  7115, 0    },
    };
    for (int i = 0; i < 3; i++) {
        news_quote_t *q = &v->tickers[i];
        news_str_copy(q->symbol, sizeof q->symbol, Q[i].sym);
        news_str_copy(q->name,   sizeof q->name,   Q[i].name);
        q->last_c  = Q[i].last;
        q->chg_bp  = Q[i].bp;
        /* The series has to AGREE WITH THE FIGURE BESIDE IT. This was
         * `120 * k + 40 * i` — a monotonic ramp for every symbol whatever its
         * change — so the sparse sheet published a rising line beside MSFT's
         * red -0.18% and another beside KO's flat 0.00%, on a page whose whole
         * claim is that colour and shape are data. The shots are the
         * deliverable; a fixture that contradicts itself is a fixture that
         * publishes a contradiction.
         *
         * So it is built from the quote's own change: the last sample sits
         * above the first when the session rose and below it when it fell, the
         * span is proportional to how far it moved, and a little sawtooth keeps
         * it from being the straight line a two-point series would draw. A flat
         * session gets a flat line. */
        q->spark_n = 8;
        const int span = Q[i].bp * 8;
        const int amp  = (span < 0 ? -span : span) / 6;
        for (int k = 0; k < 8; k++) {
            const int ramp = span * k / 7;
            const int wig  = (k % 3 == 1) ? amp : (k % 3 == 2) ? -amp : 0;
            q->spark[k] = (int16_t)(500 + ramp + wig);
        }
    }

    /* One story, which is the promotion the spec spends a paragraph on: the
     * lead swallows nothing, its chart moves to the columns the missing
     * secondary stories left, and the portfolio rail widens into the rest. A
     * front page with a hole in it is the failure everyone sees. */
    v->story_count = 1;
    news_story_t *s = &v->stories[0];
    s->rank = 0;
    news_str_copy(s->kicker,   sizeof s->kicker,   "RATES");
    news_str_copy(s->headline, sizeof s->headline,
                  "Two-year yield sinks after a soft claims print");
    news_str_copy(s->deck, sizeof s->deck,
                  "The front end prices two cuts before Christmas. The long end "
                  "is not persuaded, and the curve says so.");
    news_str_copy(s->byline, sizeof s->byline, "By CLAUDE · RATES DESK");
    news_str_copy(s->body, sizeof s->body,
        "WASHINGTON — Initial claims came in at 231,000 against a consensus of "
        "220,000, and the two-year note did the rest of the talking. The yield "
        "fell eleven basis points inside an hour, its sharpest move since the "
        "spring, and the futures market moved to price a second cut before the "
        "end of the year. The long end barely moved at all. That divergence is "
        "the whole story: the front end is trading policy and the back end is "
        "trading supply, and neither has much to say about the other. Traders "
        "who spent the summer paying for steepeners finally have something to "
        "show for it, and the Treasury's refunding schedule has not changed a "
        "line. What happens next depends on a payroll print nobody has seen, "
        "which is the same sentence the desk has written every month this year "
        "and will write again in September without much hope of it improving.");
    news_str_copy(s->symbol, sizeof s->symbol, "");
    s->chart.kind = CHART_LINE;
    news_str_copy(s->chart.span, sizeof s->chart.span, "5D");
    s->chart.n = 12;
    for (int i = 0; i < 12; i++) s->chart.c[i] = 41200 - 90 * i + (i % 3) * 130;
}

/* Indices and quotations, and no stories at all. A quiet day is not a broken
 * feed: the lead well becomes the index ribbon at full size and the sheet is a
 * markets page, which §4 calls a legitimate front page rather than an error
 * state — so every band still has to fill. */
static void quiet_payload(news_t *v)
{
    news_mock(v);
    v->demo = false;
    v->story_count = 0;
    memset(v->stories, 0, sizeof v->stories);
    news_str_copy(v->session, sizeof v->session, "U.S. MARKETS CLOSED — HOLIDAY");
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
#define UI_LVGL_BUDGET_BYTES  262144u     /* 256 KB; measured peak ~203 KB */

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
    check_a1(label, v);

    ui_news_show_page(UI_PAGE_MARKETS);
    render();
    snprintf(name,  sizeof name,  "%02d_a2_%s", seq + 1, tag);
    snprintf(label, sizeof label, "A2 %s", tag);
    shot(dir, name);
    check_a2(label);

    ui_news_show_page(UI_PAGE_FRONT);
}

int main(int argc, char **argv)
{
    const char *outdir = (argc > 1) ? argv[1] : "shots";

    lv_init();
    lv_tick_set_cb(tick_cb);

    lv_display_t *disp = lv_display_create(UI_W, UI_H);
    lv_display_set_flush_cb(disp, flush_cb);
    lv_display_set_buffers(disp, g_render, NULL, sizeof g_render,
                           LV_DISPLAY_RENDER_MODE_FULL);

    lv_obj_t *scr = lv_obj_create(NULL);
    lv_screen_load(scr);
    ui_news_create(scr);

    /* The built-in demo snapshot, or — with NEWS_URL set — the real fetch and
     * parse path the device runs, against the real server. Same code, same
     * bytes, same pixels. */
    news_t v;
    const char *url = getenv("NEWS_URL");
    if (url && *url) {
        const news_fetch_result_t r = news_service_fetch(url, &v);
        if (r == NEWS_FETCH_OK) {
            printf("fetched %s -> %d stories, %d indices, %d quotations\n",
                   url, v.story_count, v.index_count, v.ticker_count);
        } else {
            printf("fetch of %s failed (%s) — falling back to the demo snapshot\n",
                   url, news_fetch_result_name(r));
            news_mock(&v);
        }
    } else {
        news_mock(&v);
        printf("using the built-in demo snapshot (set NEWS_URL=... for a live fetch)\n");
    }

    printf("checking glyph coverage\n");
    check_fixed_strings();
    check_data_strings(&v);

    printf("rendering %s/ at %dx%d in six inks\n", outdir, UI_W, UI_H);

    const ui_status_t online = {
        .online = true, .stale = false, .battery_present = true, .battery_pct = 84,
    };
    ui_news_set_status(&online);
    ui_news_tick();

    pass(outdir, "full", 1, &v);

    news_t sparse;
    sparse_payload(&sparse);
    check_data_strings(&sparse);
    pass(outdir, "sparse", 3, &sparse);

    news_t quiet;
    quiet_payload(&quiet);
    check_data_strings(&quiet);
    pass(outdir, "quiet", 5, &quiet);

    /* The two badges, which no ordinary render reaches: they are the kicker
     * strip's one inverted element and the only thing on the sheet that reports
     * the board rather than the news. Both are checked on the full payload, so
     * a badge that failed to draw shows up against a page that otherwise did. */
    ui_news_set_data(&v);

    ui_status_t st = online;
    st.stale = true;
    ui_news_set_status(&st);
    render();
    shot(outdir, "07_a1_stale");
    check_a1("A1 stale", &v);
    want_badge("the STALE badge");

    st.online = false;
    st.battery_present = false;
    ui_news_set_status(&st);
    render();
    shot(outdir, "08_a1_offline");
    check_a1("A1 offline", &v);
    want_badge("the OFFLINE badge");

    ui_news_set_status(&online);

    /* The setup sheet. It used to be a modal — a bordered card floating in the
     * middle of an otherwise blank page — and the two assertions here used to
     * say "the sheet underneath is GONE", masthead and folio included, because
     * a full-bleed opaque pane covered both.
     *
     * It is a PAGE now: the pane still covers the news, because on e-Paper a
     * hidden page is still physically on the glass until something paints over
     * it, but it is created under the furniture so the kicker strip, the
     * masthead, the rules and the folio print over it exactly as they do on A1.
     * A new owner's first sight of the board is the paper with the setup story
     * where the lead goes, not a projector's no-signal card.
     *
     * So the checks are restated to that layout rather than removed. What the
     * old pair were really protecting is opacity, and band 6 says it better
     * anyway: it is dense with news on A1 and must be bare paper here. The two
     * rules the SHEET owns are checked as they are on A2, and the masthead and
     * folio are now asserted PRESENT — the opposite of before, because the
     * design is the opposite of before. */
    ui_news_set_overlay(S_WIFI_TITLE, "WP News-1A2B",
                        "1. Join that Wi-Fi network\n\n"
                        "2. Stay connected, then open the page it offers");
    render();
    shot(outdir, "09_setup");
    want_ink("the setup sheet's copy", UI_CONTENT_X, UI_LEAD_SPLIT_Y,
             UI_CONTENT_X + UI_MEASURE_LG_W, UI_LEAD_SPLIT_Y + 120);
    want_ink("the setup sheet's headline", UI_CONTENT_X, UI_LEAD_HEAD_Y,
             UI_CONTENT_R, UI_LEAD_HEAD_Y + UI_LEAD_HEAD_H);
    want_ink("the setup sheet keeps the masthead",
             UI_CONTENT_X, UI_MAST_Y, UI_CONTENT_R, UI_MAST_Y + UI_MAST_H);
    want_ink("the setup sheet keeps the folio",
             UI_CONTENT_X, UI_FOLIO_Y, UI_CONTENT_R, UI_FOLIO_Y + UI_FOLIO_H);

    /* The network's name, at the size the owner can read across a room. It is
     * the one string on this sheet that has to reach another device, and it was
     * 13 px of ink buried in a body run — so it is asserted where it now is
     * rather than left to the "the copy rendered" check above, which a
     * paragraph satisfies whatever size its most important line is set at. */
    want_ink("the setup sheet's network name",
             UI_CONTENT_X, UI_LEAD_Y + 180, UI_CONTENT_R, UI_LEAD_Y + 245);

    /* THE OPACITY WITNESS MOVED, and deliberately. What this pair of checks is
     * protecting is that the pane is opaque — on e-Paper a hidden page is still
     * physically on the glass until something paints over it — and band 6 was
     * the witness because A1 fills it with news and the setup sheet printed
     * nothing there.
     *
     * The setup sheet now prints a page: the standing type in ui_strings.h runs
     * through band 6, which is what closed the 826 px of bare paper this sheet
     * used to end in. So the witness is band 7, where A1 prints eight ruled
     * quotation rows and a briefs column and the setup sheet prints nothing at
     * all. The assertion is the same assertion about the same property, held
     * against the band the two layouts still disagree about. */
    want_blank("the setup sheet covers the news",
               UI_CONTENT_X, UI_TICKER_Y, UI_CONTENT_R, UI_TICKER_Y + UI_TICKER_H);
    check_rule("the setup sheet", "kicker", UI_KICKER_RULE_Y, UI_KICKER_RULE_W);
    check_rule("the setup sheet", "masthead", UI_MAST_RULE_Y, UI_MAST_RULE_W);
    check_margins("the setup sheet");
    check_masthead("the setup sheet");
    check_no_blue_yellow("the setup sheet", NULL);
    ui_news_set_overlay(NULL, NULL, NULL);

    /* No snapshot at all — the state between power-on and the first payload. A
     * blank sheet is the right answer here and the band table is deliberately
     * not applied: an unconfigured board shows the demo snapshot and never
     * reaches this, so what has to be true is only that the paper is still the
     * paper — the rules, the masthead, the folio — and that nothing has escaped
     * the margin while the setters were writing empty strings. */
    ui_news_set_data(NULL);
    render();
    shot(outdir, "10_a1_nodata");

    /* THE RULE CHECK IS THE FURNITURE'S FIVE HERE, NOT ALL SEVEN, and the
     * change is deliberate rather than a failure being got out of the way.
     *
     * Five of the seven rules belong to the SHEET: the kicker strip's hairline,
     * the masthead's heavy rule, the dateline's, the ribbon's, and the one the
     * folio hangs from. ui_news.c prints all five on both pages whatever the
     * news did, and on a board with no snapshot they are exactly what still has
     * to be true — the paper is still the paper.
     *
     * The other two are BOUNDARIES BETWEEN BANDS, drawn by the page, and a
     * boundary needs something on both sides of it. With no payload at all
     * there is nothing in band 5, nothing in band 6 and nothing in band 7, and
     * printing the two of them anyway gave the sheet its worst composition: a
     * masthead, one italic line, and then two full-width rules cutting 1,200 px
     * of bare paper into three empty boxes. That is not a newspaper waiting for
     * news, it is a printer that ran out of ink — and it is a state the frame
     * genuinely sits in, at boot and whenever the wire goes quiet.
     *
     * So ui_page_front.c's blank() now takes those two away with the bands they
     * divide, and this check asks for what the page should be printing rather
     * than for what it used to. The assertion that all seven land on their rows
     * is unchanged for every pass that HAS a payload, which is where it was
     * catching something. */
    check_rule("A1 no data", "kicker",   UI_KICKER_RULE_Y,   UI_KICKER_RULE_W);
    check_rule("A1 no data", "masthead", UI_MAST_RULE_Y,     UI_MAST_RULE_W);
    check_rule("A1 no data", "dateline", UI_DATELINE_RULE_Y, UI_DATELINE_RULE_W);
    check_rule("A1 no data", "ribbon",   UI_RIBBON_RULE_Y,   UI_RIBBON_RULE_W);
    check_rule("A1 no data", "folio",    UI_TICKER_RULE_Y,   UI_TICKER_RULE_W);
    want_blank("the no-data sheet's empty bands", UI_CONTENT_X, UI_LEAD_Y,
               UI_CONTENT_R, UI_TICKER_RULE_Y);

    check_margins("A1 no data");
    check_masthead("A1 no data");
    check_no_blue_yellow("A1 no data", NULL);
    g_labs = 0;
    walk("A1 no data", lv_screen_active(), 0, true);
    check_label_overlap("A1 no data");
    want_ink("the folio with no data", UI_CONTENT_X, UI_FOLIO_Y,
             UI_CONTENT_R, UI_FOLIO_Y + UI_FOLIO_H);

    /* Last, so the high-water mark covers every page, badge and overlay this
     * run built — including the ones only these late passes reach. */
    check_lvgl_budget();

    printf("%s — %d layout/glyph/colour/memory problem(s)\n",
           g_fail ? "FAILED" : "ok", g_fail);
    return g_fail ? 1 : 0;
}
