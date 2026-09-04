/*
 * ui_news.c — the furniture of the sheet, and which page is printed on it.
 *
 * A newspaper's chrome is not a header and a footer. It is the NAMEPLATE, the
 * ruled line under it, and the tape under that; all three print on every page of
 * the section, and none of them moves. Everything below the tape is the WELL,
 * and the well is composed — see ui_compose.h. So this file owns three strips
 * and the page files own everything else, which is a cleaner division than the
 * one it replaces because the strips are now the only fixed geometry left on the
 * sheet.
 *
 * THREE THINGS CAME OFF, AND EACH OF THEM WAS THE PAGE ADMITTING TO BE A SCREEN
 * ----------------------------------------------------------------------------
 * 1. The strip ABOVE the masthead is gone. No broadsheet has one — the New York
 *    Times and the Wall Street Journal both start at the nameplate — and it cost
 *    34 px of a page whose owner wanted the room spent on the company. The date
 *    moved into the ruled line beneath the nameplate, which is where a paper
 *    prints it.
 *
 * 2. The tape is ONE LINE. It used to be an 82 px band setting five index levels
 *    at 36 px, which is the single loudest thing a page can do and most of why
 *    the sheet read as a quote screen. The Wall Street Journal prints the same
 *    information as one line of small caps under its nameplate, set SMALLER than
 *    its body text, because on a front page the tape is furniture and not the
 *    story. This is that line.
 *
 * 3. The folio is gone, and with it the last clock. A folio answers "which page
 *    of what am I holding, and where do I turn next", and this paper is a single
 *    sheet in a frame — there is no next page, and the masthead, the sector and
 *    the symbol are all already on the dateline row. The tape's as-of says when
 *    the numbers are from, which is the honest statement; a second timestamp
 *    saying when the sheet last repainted is a machine's concern printed on a
 *    reader's page. A newspaper carries a date, not a clock.
 *
 * The pages are transparent full-sheet panes created BEFORE this furniture, so a
 * module positioned at UI_WELL_Y lands there, and ink a page put in a strip that
 * is not its own ends up under the masthead rather than over it.
 *
 * Nothing here refreshes the panel. See ui_news.h.
 */
#include "ui_news.h"
#include "ui_internal.h"

#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <time.h>

/* --- the three columns the furniture is set on ----------------------------
 * The dateline row prints three things — something on the left, something in
 * the middle, something on the right — on three columns of two, so the row reads
 * as one line rather than as three treatments sharing a strip. */
#define SLOT_W          UI_COL(2)               /*  364 */
#define SLOT_L_X        UI_COLX(0)              /*   30 */
#define SLOT_C_X        UI_COLX(2)              /*  418 */
#define SLOT_R_X        UI_COLX(4)              /*  806 */

/* Franklin's caps were cut to be spaced, and every caps label on this sheet
 * takes the same +2. The masthead's tracking is a different kind of number — it
 * is measured, and it is measured against the mark beside it — so it lives with
 * the rest of the flag's geometry in ui_internal.h. */
#define TRACK_CAPS      2

/* The running head's box: four columns, centred, which is 752 of the 1140
 * measure. Not the full measure, and that is the point — see build_masthead(). */
#define RH_X            UI_COLX(1)              /* 224 */
#define RH_W            UI_COL(4)               /* 752 */
#define RH_GAP          4

/* The state chip. A filled rectangle with the word reversed out of it, at the
 * right end of the dateline row.
 *
 * It is the one inverted region on the sheet and that is deliberate: the strip
 * it used to live in is gone, so the word now sits in a ruled line of five other
 * 14 px tracked caps and from three metres nobody would pick it out. A chip is
 * what a paper uses when it wants one word read before the rest of a line — REPLATE,
 * FINAL, EXTRA are all set that way — and it costs 1,200 px of ink once. */
#define CHIP_PAD_X      8
#define CHIP_DY         1

/* The gap between a tape cell's level and the percentage beside it. Narrower
 * than the separator between cells, so the eye groups a name with its own
 * figures rather than with the next index's. */
#define TAPE_PCT_GAP    6

/* --- the setup sheet ------------------------------------------------------
 * Provisioning is a PAGE of this paper, not a modal: an opaque pane created
 * between the two pages and the furniture, so it covers the news underneath —
 * necessary, because on e-Paper a hidden page is still physically on the glass
 * until something paints over it — while the nameplate, the ruled line and the
 * tape print over the top of it exactly as they do on A1. What a new owner sees
 * is the paper, with the setup story where the lead goes.
 *
 * The whole sheet is standing type, in two measures, because a page with two
 * lines on it is not a page and this is what a new owner looks at for as long as
 * it takes to type a password into a phone. */
#define OV_KICKER_Y     UI_WELL_Y                       /*  222 */
#define OV_HEAD_Y       (UI_WELL_Y + 26)                /*  248 */
#define OV_DECK_Y       (UI_WELL_Y + 100)               /*  322 */
#define OV_DECK_H        60
#define OV_DECK_W       UI_COL(4)                       /*  752 */
#define OV_NET_Y        (UI_WELL_Y + 172)               /*  394 */
#define OV_SSID_Y       (UI_WELL_Y + 194)               /*  416 */
#define OV_HAIR_Y       (UI_WELL_Y + 274)               /*  496 */

#define OV_COL_W        UI_COL(3)                       /*  558 */
#define OV_R_X          UI_COLX(3)                      /*  612 */
#define OV_BLK_DY        22

#define OV_TOP_Y        (UI_WELL_Y + 288)               /*  510 */
#define OV_TOP_B        (UI_WELL_Y + 828)               /* 1050 */
#define OV_L2_Y         (UI_WELL_Y + 508)               /*  730 */
#define OV_R2_Y         (UI_WELL_Y + 548)               /*  770 */

#define OV_MID_RULE_Y   (UI_WELL_Y + 842)               /* 1064 */
#define OV_BOT_Y        (UI_WELL_Y + 858)               /* 1080 */
#define OV_AFTER_W      UI_COL(4)                       /*  752 */
#define OV_REFER_X      UI_COLX(4)                      /*  806 */
#define OV_REFER_W      UI_COL(2)                       /*  364 */
#define OV_REFER_PAD    16
#define OV_REFER_H      240

/* The line this sheet ends on. Its copy is fixed, so where it runs out is known
 * — and a page whose last paragraph trails off into two hundred pixels of white
 * reads as a sheet that failed to finish printing, where the same white under a
 * rule reads as the foot of the page. Every other sheet on this board closes the
 * same way; see md_close() in ui_modules.c. */
#define OV_END_RULE_Y   (UI_WELL_Y + 1120)              /* 1342 */

_Static_assert(SLOT_R_X + SLOT_W == UI_CONTENT_R,
               "the furniture's three slots must fill the measure exactly");
_Static_assert(OV_TOP_B < OV_MID_RULE_Y && OV_BOT_Y + OV_REFER_H < UI_WELL_B,
               "the setup sheet's two bands must stack inside the well");

static lv_obj_t *s_pages[UI_PAGE_COUNT];
static ui_page_t s_page;

static lv_obj_t *s_masthead, *s_logo, *s_running_head, *s_running_sect;
static lv_obj_t *s_dateline, *s_edition, *s_subject;
static lv_obj_t *s_chip, *s_chip_txt;

static lv_obj_t *s_session, *s_as_of, *s_tape_none;
static struct { lv_obj_t *name, *chg; } s_tape[NEWS_INDEX_MAX];


static lv_obj_t *s_overlay, *s_ov_title, *s_ov_body, *s_ov_net, *s_ov_ssid;

/* What the furniture remembers, and deliberately no more. Every string the
 * payload carried is already on the sheet — inside the label that prints it —
 * so the snapshot is not copied here.
 *
 * The one exception is the pointer itself, so that a link state arriving AFTER
 * the data can rebuild both pages. It has to, because the state reaches the
 * FIGURES — see ui_data_live() — and a page whose prices are still green two
 * hours after the wire went quiet is the sheet asserting, in the loudest
 * register it has, that it is current. ui_news.h states the lifetime rule the
 * pointer depends on. */
static const news_t *s_data;

static bool s_have_data;
static bool s_demo;
static bool s_has_dateline;
static ui_status_t s_status;

/* The edition's language, resolved once per snapshot rather than at each of the
 * twelve draw sites that read it.
 *
 * It defaults to English and to "en" because a board with no snapshot has no
 * language: the setup sheet, the no-data page and everything drawn before the
 * first fetch are the board talking about itself, and the one thing the
 * localisation follows is the edition. A NULL snapshot puts it back, so a board
 * whose payload is cleared stops printing Korean furniture around nothing.
 *
 * The pointer into `s_data->lang` would have done as well and is deliberately
 * not what is kept: ui_news.h's lifetime rule lets the caller replace the
 * snapshot, and a tag that outlives the buffer it points into is the kind of
 * bug that shows up as one wrong word on a page nobody is watching. Eight bytes
 * copied is the whole of the fix. */
static const ui_lang_t *s_lang = &UI_LANG_EN;
static char s_lang_tag[NEWS_LANG_MAX] = "en";

static const char *const PAGE_TITLES[UI_PAGE_COUNT] = {
    S_PAGE_FRONT, S_PAGE_MARKETS,
};

const ui_lang_t *ui_lang_now(void)
{
    return s_lang;
}

const char *ui_lang_tag_now(void)
{
    return s_lang_tag;
}

const char *ui_news_page_title(ui_page_t page)
{
    if (page < 0 || page >= UI_PAGE_COUNT) return "";
    return PAGE_TITLES[page];
}

/* There is no RTC on this board, so the clock is whatever SNTP has managed to
 * set — and before it succeeds time() returns 1970 with a timezone applied,
 * which prints as a perfectly plausible hour. The year is the cheapest thing to
 * test that on, and saying nothing until it passes is the only honest thing a
 * dateline can do. */
static bool local_now(struct tm *out)
{
    time_t now = time(NULL);
    localtime_r(&now, out);
    return out->tm_year + 1900 >= 2020;
}

/* --- colour is data, and data has a shelf life ---------------------------- */

bool ui_data_live(void)
{
    return s_status.online && !s_status.stale;
}

lv_color_t ui_chg_colour(int32_t bp)
{
    if (bp == 0 || !ui_data_live()) return UI_INK;
    return bp < 0 ? UI_DOWN : UI_UP;
}

/* --- shared shapes -------------------------------------------------------- */

static lv_obj_t *caps(lv_obj_t *par, int x, int y, int w,
                      lv_text_align_t align, const char *txt)
{
    lv_obj_t *l = ui_lab_w(par, x, y, w, UI_F_LABEL, align, txt);
    ui_track(l, TRACK_CAPS);
    return l;
}

/* How wide a tracked caps string actually sets. Measured rather than reserved:
 * the tape lays its cells out left to right with whatever room each string
 * needs, because an index called "PHLX SEMIS" and one called "VIX" do not want
 * the same slot, and a ragged right edge on one line of furniture is what a real
 * tape looks like. One tracking step is added back on because LVGL measures the
 * letter-spaces BETWEEN glyphs and the box has to hold the one the last glyph is
 * drawn with. */
static int caps_w(const char *txt)
{
    if (!txt || !txt[0]) return 0;

    lv_point_t sz;
    lv_text_get_size(&sz, txt, UI_F_LABEL, TRACK_CAPS, 0, LV_COORD_MAX,
                     LV_TEXT_FLAG_NONE);
    return (int)sz.x + TRACK_CAPS;
}

/* The row a 14 px face sits on inside a 20 px strip: the six pixels are split
 * rather than left at the bottom, where they would tilt one strip against the
 * one above it. */
static int strip_y(int y, int h)
{
    return y + (h - lv_font_get_line_height(UI_F_LABEL)) / 2;
}

/* --- the mark -------------------------------------------------------------
 *
 * The sunburst beside the name: eleven wedges from a common centre, widest
 * where they meet and coming to a point at the rim.
 *
 * IT IS GEOMETRY AND NOT A PICTURE, and that is the whole reason it is fifty
 * lines of C rather than a tile on the flash. A tile is fixed at the size it
 * was screened at and is halftoned to get there — and this mark is a hairline
 * shape at 61 px, where a halftone's own dot is the same order as the thing
 * being drawn and the rays come out as dotted lines. Filled as exact spans it
 * is every pixel the ink that was asked for, it takes wp_quantize()'s identity
 * path like every other hard-pixel mark on this sheet, and it can be set at any
 * size the furniture wants without a second asset.
 *
 * THE RAYS ARE A BAKED TABLE, in a unit space whose radius is 1024, because the
 * alternative is eleven angles of trigonometry at page-build time. There is no
 * libm in this file for the reason ui_chart.h gives — a double rounded
 * differently on x86 and on Xtensa moves a pixel and fails a screenshot test for
 * a reason that has nothing to do with the drawing — and a mark whose shape is
 * decided at build time by a table cannot drift between the simulator and the
 * glass. The table was generated once, looked at at 5x, and pasted here.
 *
 * The eleven quads are wound the same way and each is CONVEX, which is what
 * lets logo_ray() fill one by taking the leftmost and rightmost edge crossing
 * on each scanline. That is a property of the table and not of the filler: a
 * ray edited into a bow-tie would fill its own bounding box and nobody would be
 * told. */
#define LOGO_RAYS 11
#define LOGO_UNIT 1024

static const int16_t LOGO_RAY[LOGO_RAYS][4][2] = {
    { {   118,     0 }, {    30, -1024 }, {   -30, -1024 }, {  -118,     0 } },
    { {    99,    64 }, {   579,  -845 }, {   528,  -878 }, {   -99,   -64 } },
    { {    49,   107 }, {   944,  -398 }, {   919,  -453 }, {   -49,  -107 } },
    { {   -17,   117 }, {  1009,   175 }, {  1018,   116 }, {    17,  -117 } },
    { {   -77,    89 }, {   754,   693 }, {   794,   648 }, {    77,   -89 } },
    { {  -113,    33 }, {   260,   991 }, {   317,   974 }, {   113,   -33 } },
    { {  -113,   -33 }, {  -317,   974 }, {  -260,   991 }, {   113,    33 } },
    { {   -77,   -89 }, {  -794,   648 }, {  -754,   693 }, {    77,    89 } },
    { {   -17,  -117 }, { -1018,   116 }, { -1009,   175 }, {    17,   117 } },
    { {    49,  -107 }, {  -919,  -453 }, {  -944,  -398 }, {   -49,   107 } },
    { {    99,   -64 }, {  -528,  -878 }, {  -579,  -845 }, {   -99,    64 } },
};

/* Unit space to pixels, to the nearest, with a half going AWAY FROM ZERO on
 * both sides of the centre. C's own truncation would pull the left half of the
 * mark toward the middle and leave the right half where it was, and eleven rays
 * rounded asymmetrically is a mark that leans. Every ray but the vertical one
 * has a mirror in the table; this is what keeps the pair identical. */
static int logo_sc(int v)
{
    const int n = v * UI_LOGO_R;
    return n >= 0 ? (n + LOGO_UNIT / 2) / LOGO_UNIT
                  : -((-n + LOGO_UNIT / 2) / LOGO_UNIT);
}

/* Floor division by a positive divisor. C truncates toward zero, which on a
 * negative numerator rounds an edge the wrong way and opens a one-pixel notch
 * in the side of a ray. */
static int logo_floor_div(int a, int b)
{
    return a >= 0 ? a / b : -(((-a) + b - 1) / b);
}

/* One ray, scanline by scanline, as exact spans — ui_draw_tri_abs()'s argument
 * again, arriving through a shape that is not a triangle. lv_draw_triangle()
 * would anti-alias both flanks of every wedge, and at the two or three pixels
 * these are wide the flanks ARE the ray. */
static void logo_ray(lv_layer_t *L, int cx, int cy, const int16_t (*v)[2])
{
    int px[4], py[4];
    int ymin, ymax;

    for (int i = 0; i < 4; i++) {
        px[i] = cx + logo_sc(v[i][0]);
        py[i] = cy + logo_sc(v[i][1]);
    }

    ymin = ymax = py[0];
    for (int i = 1; i < 4; i++) {
        if (py[i] < ymin) ymin = py[i];
        if (py[i] > ymax) ymax = py[i];
    }

    for (int y = ymin; y <= ymax; y++) {
        int lo = 0, hi = 0;
        bool any = false;

        for (int i = 0; i < 4; i++) {
            int x0 = px[i],           y0 = py[i];
            int x1 = px[(i + 1) & 3], y1 = py[(i + 1) & 3];

            if (y0 > y1) {
                int t;
                t = x0; x0 = x1; x1 = t;
                t = y0; y0 = y1; y1 = t;
            }
            if (y < y0 || y > y1) continue;

            /* A horizontal edge contributes both its ends; every other edge
             * contributes where it crosses this row, rounded to the nearest
             * pixel rather than toward zero. */
            int a = x0, b = x1;
            if (y0 != y1) {
                const int den = y1 - y0;
                a = b = x0 + logo_floor_div(2 * (x1 - x0) * (y - y0) + den,
                                            2 * den);
            }
            if (!any) { lo = hi = a; any = true; }
            if (a < lo) lo = a;
            if (b < lo) lo = b;
            if (a > hi) hi = a;
            if (b > hi) hi = b;
        }

        if (any) ui_draw_rect_c_abs(L, lo, y, hi, y, true, 0, UI_INK);
    }
}

static void logo_draw_cb(lv_event_t *e)
{
    lv_obj_t   *o = lv_event_get_target_obj(e);
    lv_layer_t *L = lv_event_get_layer(e);
    if (!o || !L) return;

    lv_area_t a;
    lv_obj_get_coords(o, &a);
    for (int k = 0; k < LOGO_RAYS; k++) {
        logo_ray(L, a.x1 + UI_LOGO_R, a.y1 + UI_LOGO_R, LOGO_RAY[k]);
    }
}

/* --- the masthead --------------------------------------------------------- */

static void build_masthead(lv_obj_t *par)
{
    /* THE FLAG IS MEASURED AND THEN PLACED, which is the one thing that changed
     * here when the mark arrived. The name used to be a full-measure label with
     * LV_TEXT_ALIGN_CENTER doing the centring, and LVGL cannot centre a label
     * about a mark that is not inside it. So the name is measured, the mark's
     * width and gap are added, and the whole flag is set from a left edge — the
     * INK is what ends up centred in the measure, which is what a reader sees
     * and what the simulator checks. */
    lv_point_t sz;
    lv_text_get_size(&sz, S_MASTHEAD, UI_F_MASTHEAD, UI_MAST_TRACK, 0,
                     LV_COORD_MAX, LV_TEXT_FLAG_NONE);

    const int name_w = (int)sz.x;
    const int flag_w = UI_LOGO_W + UI_LOGO_GAP + name_w;
    int       flag_x = UI_CONTENT_X + (UI_CONTENT_W - flag_w) / 2;
    if (flag_x < UI_CONTENT_X) flag_x = UI_CONTENT_X;

    const int name_x = flag_x + UI_LOGO_W + UI_LOGO_GAP;

    s_logo = ui_pane(par, flag_x, UI_MAST_Y + UI_LOGO_CY - UI_LOGO_R,
                     UI_LOGO_W, UI_LOGO_W);
    lv_obj_add_event_cb(s_logo, logo_draw_cb, LV_EVENT_DRAW_MAIN, NULL);

    /* The face's line height is 113 and the strip's is 112, and the pixel is
     * the descender. The box runs to the right margin rather than to the name's
     * own width: it is a fixed height, so anything that overruns ellipsizes
     * across the measure instead of setting a second line on top of the
     * dateline row — and a box cut to the measured width would ellipsize on a
     * one-pixel rounding difference between measuring and setting. */
    s_masthead = ui_lab_w(par, name_x, UI_MAST_Y, UI_CONTENT_R - name_x,
                          UI_F_MASTHEAD, LV_TEXT_ALIGN_LEFT, S_MASTHEAD);
    ui_track(s_masthead, UI_MAST_TRACK);

    /* Any page that is not A1 wears a running head instead. The strip does not
     * shrink to fit it: the rules under it are the skeleton both pages are
     * printed on, and a masthead that took 40 px off itself would move every one
     * of them on one page and not the other.
     *
     * The name AND the section, on TWO lines and in two sizes, which is what
     * makes this a running head rather than a second nameplate. Three sizes were
     * rendered before it settled: at display_36 the flag leaves 80% of the strip
     * bare and A2 reads as a weaker, unrelated publication; at display_56 across
     * the full measure the name and the section as one composed string set edge
     * to edge in a heavy Didone, which reads as a second paper. The name alone
     * sets 560 px in the 752 box, at half the nameplate's cap height, and those
     * are the two ratios a section flag actually has.
     *
     * IT IS NOT TRACKED OUT TO FILL THE BOX and it does not carry the mark,
     * which is the same decision twice. A1's flag fills the measure because it
     * IS the paper's nameplate; A2's job is to be recognisably the same paper,
     * one size down and one weight quieter. Letterspacing 15 caps of a 56 px
     * Didone across 752 px would take 14 px a letter — a quarter of the type
     * size — and what that produces is not a section flag, it is a second
     * masthead competing with the one on the page before it. */
    const int hl = lv_font_get_line_height(UI_F_LEAD);      /* 65 */
    const int sl = lv_font_get_line_height(UI_F_LABEL);     /* 18 */
    const int ht = UI_MAST_Y + (UI_MAST_H - (hl + RH_GAP + sl)) / 2;

    s_running_head = ui_lab_w(par, RH_X, ht, RH_W, UI_F_LEAD,
                              LV_TEXT_ALIGN_CENTER, S_RUNNING_HEAD);
    ui_track(s_running_head, TRACK_CAPS);
    ui_show(s_running_head, false);

    s_running_sect = caps(par, RH_X, ht + hl + RH_GAP, RH_W,
                          LV_TEXT_ALIGN_CENTER, "");
    ui_show(s_running_sect, false);

    ui_rule(par, UI_CONTENT_X, UI_MAST_RULE_Y, UI_CONTENT_W, UI_MAST_RULE_W);
}

/* --- the dateline row -----------------------------------------------------
 *
 * The date on the left, the desk in the middle, and on the right either the
 * company the edition is about or — when there is something wrong — the state
 * chip. They are alternatives rather than neighbours because the row has three
 * slots and there are four things that could want the third. The symbol gives
 * way because the whole sheet is about that company and says so in a dozen
 * places — the nameplate's sector line, the rail, the industry table, every
 * headline — where the chip has nowhere else on the page to be. */
static void build_dateline(lv_obj_t *par)
{
    const int y = strip_y(UI_DATELINE_Y, UI_DATELINE_H);

    s_dateline = caps(par, SLOT_L_X, y, SLOT_W, LV_TEXT_ALIGN_LEFT, "");
    s_edition  = caps(par, SLOT_C_X, y, SLOT_W, LV_TEXT_ALIGN_CENTER, S_BRAND);
    s_subject  = caps(par, SLOT_R_X, y, SLOT_W, LV_TEXT_ALIGN_RIGHT, "");

    /* The chip is a filled rectangle with the word reversed out of it, so the
     * fill is created first and the type over it. Both are sized to the word by
     * refresh_chip(), which is also where the word itself comes from.
     *
     * The seed below is the English macro rather than a table lookup, and that
     * is not an oversight: the furniture is built before any snapshot has
     * arrived, so there is no edition to take a language from yet. The string
     * never reaches the glass — the chip starts hidden and refresh_chip() sets
     * the text before it is ever shown. */
    s_chip     = ui_fill(par, SLOT_R_X, UI_DATELINE_Y, SLOT_W, UI_DATELINE_H);
    s_chip_txt = ui_lab_inv(par, SLOT_R_X, y, SLOT_W, UI_F_LABEL,
                            LV_TEXT_ALIGN_CENTER, S_BADGE_OFFLINE);
    ui_track(s_chip_txt, TRACK_CAPS);
    ui_show(s_chip, false);
    ui_show(s_chip_txt, false);

    ui_rule(par, UI_CONTENT_X, UI_DATELINE_RULE_Y, UI_CONTENT_W,
            UI_DATELINE_RULE_W);
}

/* One chip and a ranking for it. Three indicators competing for one slot would
 * either overlap or need a layout pass, and ranking them means the sheet always
 * shows the most important thing that is wrong — which is all a glance from
 * across a room carries anyway.
 *
 * The order is not the obvious one. DEMO is last because a board that has been
 * given a URL keeps showing the demo snapshot until its first successful fetch,
 * so a configured board whose server is unreachable would badge itself DEMO —
 * true, and useless, instead of OFFLINE, which is the thing the reader can act
 * on. */
static void refresh_chip(void)
{
    const char *text = NULL;
    if (!s_status.online)           text = ui_lang_now()->badge_offline;
    else if (s_status.stale)        text = ui_lang_now()->badge_stale;
    else if (s_have_data && s_demo) text = ui_lang_now()->badge_demo;

    ui_show(s_chip, text != NULL);
    ui_show(s_chip_txt, text != NULL);
    ui_show(s_subject, text == NULL);
    if (!text) return;

    ui_set(s_chip_txt, text);

    int w = caps_w(text) + 2 * CHIP_PAD_X;
    if (w > SLOT_W) w = SLOT_W;

    lv_obj_set_pos(s_chip, UI_CONTENT_R - w, UI_DATELINE_Y);
    lv_obj_set_width(s_chip, w);
    lv_obj_set_pos(s_chip_txt, UI_CONTENT_R - w,
                   strip_y(UI_DATELINE_Y, UI_DATELINE_H) + CHIP_DY);
    lv_obj_set_width(s_chip_txt, w);
}

/* --- the tape -------------------------------------------------------------
 *
 * One line: the session on the left, the indices laid out left to right with a
 * fixed separator between them, and the as-of on the right. Every cell is a
 * name-and-level in ink and a percentage in colour, at label_14, which is
 * SMALLER than the body text — that is the whole point of the strip and the
 * single edit that stopped the sheet reading as a quote screen. */
static void build_tape(lv_obj_t *par)
{
    const int y = strip_y(UI_TAPE_Y, UI_TAPE_H);

    s_session = caps(par, UI_CONTENT_X, y, SLOT_W, LV_TEXT_ALIGN_LEFT, "");
    s_as_of   = caps(par, SLOT_R_X, y, SLOT_W, LV_TEXT_ALIGN_RIGHT, "");

    for (int i = 0; i < NEWS_INDEX_MAX; i++) {
        s_tape[i].name = caps(par, UI_CONTENT_X, y, 10, LV_TEXT_ALIGN_LEFT, "");
        s_tape[i].chg  = caps(par, UI_CONTENT_X, y, 10, LV_TEXT_ALIGN_LEFT, "");
        ui_show(s_tape[i].name, false);
        ui_show(s_tape[i].chg, false);
    }

    /* A board with no payload at all is a state the frame really sits in — boot,
     * a dropped link, a name that stopped resolving — and the sheet it prints is
     * a nameplate over an empty well. One line where the tape goes is what says
     * so, and it is the only thing on that sheet the board is the author of. */
    /* Untracked, unlike everything else on this strip: it is the one string here
     * that is not caps, and Franklin's caps spacing applied to lower case sets
     * L o a d i n g. */
    s_tape_none = ui_lab_w(par, UI_CONTENT_X, y, UI_CONTENT_W, UI_F_LABEL,
                           LV_TEXT_ALIGN_CENTER, S_WAITING);
    ui_show(s_tape_none, false);

    ui_rule(par, UI_CONTENT_X, UI_TAPE_RULE_Y, UI_CONTENT_W, UI_TAPE_RULE_W);
}

static void refresh_tape(const news_t *v)
{
    const int y = strip_y(UI_TAPE_Y, UI_TAPE_H);
    const int n = v ? (v->index_count < NEWS_INDEX_MAX ? v->index_count
                                                       : NEWS_INDEX_MAX) : 0;
    char up[40];

    ui_set(s_session, v ? v->session : "");
    ui_set(s_as_of,   v ? v->as_of   : "");
    ui_show(s_tape_none, v == NULL);

    const int sw = v ? caps_w(v->session) : 0;
    const int aw = v ? caps_w(v->as_of)   : 0;

    lv_obj_set_width(s_session, sw > 0 ? sw : SLOT_W);
    lv_obj_set_pos(s_as_of, UI_CONTENT_R - (aw > 0 ? aw : SLOT_W), y);
    lv_obj_set_width(s_as_of, aw > 0 ? aw : SLOT_W);

    int x = UI_CONTENT_X + (sw > 0 ? sw + UI_TAPE_SEP_W : 0);
    const int right = UI_CONTENT_R - (aw > 0 ? aw + UI_TAPE_SEP_W : 0);

    for (int i = 0; i < NEWS_INDEX_MAX; i++) {
        if (i >= n) {
            ui_show(s_tape[i].name, false);
            ui_show(s_tape[i].chg, false);
            continue;
        }

        const news_quote_t *q = &v->indices[i];
        char level[24], pct[16], head[72];

        ui_money(level, sizeof level, q->last_c);
        ui_pct(pct, sizeof pct, q->chg_bp);

        /* Upper-cased because the slot is TRACKED: +2 px a character is
         * Franklin's caps spacing, and applied to "Nasdaq" it prints
         * N a s d a q beside a correctly spaced S&P 500 in the next cell. The
         * separator rides in front of the name rather than in a label of its
         * own — two more objects a cell, to print one character. */
        ui_upper(up, sizeof up, q->name[0] ? q->name : q->symbol);
        snprintf(head, sizeof head, "%s%s %s",
                 i > 0 ? "\xC2\xB7 " : "", up, level);

        const int nw = caps_w(head);
        const int cw = caps_w(pct);

        if (x + nw + TAPE_PCT_GAP + cw > right) {
            ui_show(s_tape[i].name, false);
            ui_show(s_tape[i].chg, false);
            continue;
        }

        ui_set(s_tape[i].name, head);
        lv_obj_set_pos(s_tape[i].name, x, y);
        lv_obj_set_width(s_tape[i].name, nw);
        ui_show(s_tape[i].name, true);

        ui_set(s_tape[i].chg, pct);
        lv_obj_set_style_text_color(s_tape[i].chg, ui_chg_colour(q->chg_bp), 0);
        lv_obj_set_pos(s_tape[i].chg, x + nw + TAPE_PCT_GAP, y);
        lv_obj_set_width(s_tape[i].chg, cw);
        ui_show(s_tape[i].chg, true);

        x += nw + TAPE_PCT_GAP + cw + UI_TAPE_SEP_W;
    }
}

/* --- the setup sheet ------------------------------------------------------ */

/* A caps heading with a paragraph under it, in one measure. Every block of the
 * setup sheet's standing type is one of these. */
static void ov_block(int x, int y, int h, const char *head, const char *body)
{
    caps(s_overlay, x, y, OV_COL_W, LV_TEXT_ALIGN_LEFT, head);

    /* body_20 rather than body_16. This is standing type on a page with no news
     * on it, so it has the room, and the sheet a new owner reads from across a
     * desk while typing a password into a phone should not be set at the size
     * the front page gives a caption. */
    lv_obj_t *b = ui_lab_box(s_overlay, x, y + OV_BLK_DY, OV_COL_W,
                             h - OV_BLK_DY, UI_F_BODY_LG, LV_TEXT_ALIGN_LEFT,
                             body);
    ui_lab_wrap(b, h - OV_BLK_DY);
}

static void build_overlay(lv_obj_t *par)
{
    /* Opaque and full-bleed: it has to hide the NEWS underneath, because on
     * e-Paper "hidden" only means "not drawn this frame" and the previous frame
     * is still physically on the glass until something covers it. Created before
     * the furniture, so the nameplate and the rules print on top of it and the
     * setup state is a sheet of this paper rather than a dialog floating on a
     * blank one. */
    s_overlay = ui_frame(par, 0, 0, UI_W, UI_H, 0);

    caps(s_overlay, UI_CONTENT_X, OV_KICKER_Y, UI_CONTENT_W,
         LV_TEXT_ALIGN_LEFT, S_SETUP_KICKER);

    /* One line, not two: the head is "Wi-Fi Setup" and the 65 px it needs is
     * what it gets, so the deck starts where a deck starts rather than 164 px of
     * paper later. */
    s_ov_title = ui_lab_w(s_overlay, UI_CONTENT_X, OV_HEAD_Y, UI_CONTENT_W,
                          UI_F_LEAD, LV_TEXT_ALIGN_LEFT, "");
    lv_obj_t *deck = ui_lab_box(s_overlay, UI_CONTENT_X, OV_DECK_Y, OV_DECK_W,
                                OV_DECK_H, UI_F_DECK, LV_TEXT_ALIGN_LEFT,
                                S_SETUP_DECK);
    ui_lab_wrap(deck, OV_DECK_H);

    /* The network's name, at the size of a lead headline, under a caps label
     * saying what it is. It is the one string on this sheet the owner has to
     * carry to another device, and it was 13 px of ink in the middle of a
     * paragraph. */
    s_ov_net  = caps(s_overlay, UI_CONTENT_X, OV_NET_Y, UI_CONTENT_W,
                     LV_TEXT_ALIGN_LEFT, S_SETUP_NETWORK);
    s_ov_ssid = ui_lab_w(s_overlay, UI_CONTENT_X, OV_SSID_Y, UI_CONTENT_W,
                         UI_F_LEAD, LV_TEXT_ALIGN_LEFT, "");

    ui_rule(s_overlay, UI_CONTENT_X, OV_HAIR_Y, UI_CONTENT_W, UI_RULE_HAIR);

    /* The body is the one label on the board allowed to wrap: it carries
     * instructions, and an ellipsis there would be useless. */
    s_ov_body = ui_lab_box(s_overlay, UI_CONTENT_X, OV_TOP_Y, OV_COL_W,
                           OV_L2_Y - OV_TOP_Y - 16, UI_F_BODY_LG,
                           LV_TEXT_ALIGN_LEFT, "");
    ui_lab_wrap(s_ov_body, OV_L2_Y - OV_TOP_Y - 16);

    ov_block(OV_R_X, OV_TOP_Y, OV_R2_Y - OV_TOP_Y - 16,
             S_SETUP_ABOUT_H, S_SETUP_ABOUT);
    ov_block(UI_CONTENT_X, OV_L2_Y, OV_TOP_B - OV_L2_Y,
             S_SETUP_TROUBLE_H, S_SETUP_TROUBLE);
    ov_block(OV_R_X, OV_R2_Y, OV_TOP_B - OV_R2_Y,
             S_SETUP_SOURCE_H, S_SETUP_SOURCE);

    ui_vrule(s_overlay, OV_R_X - UI_GUTTER + UI_GUTTER_RULE_DX, OV_TOP_Y,
             OV_TOP_B - OV_TOP_Y, UI_RULE_HAIR);
    ui_rule(s_overlay, UI_CONTENT_X, OV_MID_RULE_Y, UI_CONTENT_W, UI_BAND_RULE_W);

    caps(s_overlay, UI_CONTENT_X, OV_BOT_Y, OV_AFTER_W, LV_TEXT_ALIGN_LEFT,
         S_SETUP_AFTER_H);
    lv_obj_t *after = ui_lab_box(s_overlay, UI_CONTENT_X, OV_BOT_Y + OV_BLK_DY,
                                 OV_AFTER_W, UI_WELL_B - OV_BOT_Y - OV_BLK_DY,
                                 UI_F_BODY_LG, LV_TEXT_ALIGN_LEFT, S_SETUP_AFTER);
    ui_lab_wrap(after, UI_WELL_B - OV_BOT_Y - OV_BLK_DY);

    /* A standing box in the last two columns — a "refer", which is real
     * front-page furniture — carrying the one thing that genuinely belongs to
     * the device: what its three keys do. */
    ui_frame(s_overlay, OV_REFER_X, OV_BOT_Y, OV_REFER_W, OV_REFER_H,
             UI_RULE_HAIR);
    caps(s_overlay, OV_REFER_X + OV_REFER_PAD, OV_BOT_Y + OV_REFER_PAD,
         OV_REFER_W - 2 * OV_REFER_PAD, LV_TEXT_ALIGN_LEFT, S_SETUP_KEYS);
    ui_rule(s_overlay, OV_REFER_X + OV_REFER_PAD, OV_BOT_Y + OV_REFER_PAD + 24,
            OV_REFER_W - 2 * OV_REFER_PAD, UI_RULE_HAIR);

    lv_obj_t *keys = ui_lab_box(s_overlay, OV_REFER_X + OV_REFER_PAD,
                                OV_BOT_Y + OV_REFER_PAD + 34,
                                OV_REFER_W - 2 * OV_REFER_PAD,
                                OV_REFER_H - OV_REFER_PAD - 34, UI_F_BODY,
                                LV_TEXT_ALIGN_LEFT,
                                S_KEY_PAGE "\n" S_KEY_REFRESH "\n" S_KEY_WIFI);
    ui_lab_wrap(keys, OV_REFER_H - OV_REFER_PAD - 34);

    ui_rule(s_overlay, UI_CONTENT_X, OV_END_RULE_Y, UI_CONTENT_W, UI_RULE_HAIR);

    ui_show(s_overlay, false);
}

void ui_news_set_overlay(const char *title, const char *ssid, const char *body)
{
    if (!s_overlay) return;
    if (!title && !ssid && !body) {
        ui_show(s_overlay, false);
        return;
    }
    ui_set(s_ov_title, title ? title : "");
    ui_set(s_ov_body, body ? body : "");

    /* The network slot belongs to the ONE provisioning state that has a network
     * to name. "Connecting to..." and "Saved..." print their own copy in the
     * body and would otherwise leave a caps label over 65 px of nothing. */
    const bool have_ssid = ssid && ssid[0];
    ui_set(s_ov_ssid, have_ssid ? ssid : "");
    ui_show(s_ov_ssid, have_ssid);
    ui_show(s_ov_net, have_ssid);

    ui_show(s_overlay, true);
}

/* --- public --------------------------------------------------------------- */

void ui_news_create(lv_obj_t *parent)
{
    lv_obj_remove_style_all(parent);
    lv_obj_remove_flag(parent, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_set_size(parent, UI_W, UI_H);
    lv_obj_set_style_bg_color(parent, UI_PAPER, 0);
    lv_obj_set_style_bg_opa(parent, LV_OPA_COVER, 0);

    /* Assume online until told otherwise: this runs before the first poll, and
     * a board that has not tried yet is not offline. */
    memset(&s_status, 0, sizeof s_status);
    s_status.online = true;

    /* The pages first and the furniture over them — see the file header. Both
     * panes cover the whole sheet, so a page's coordinates are the panel's. */
    s_pages[UI_PAGE_FRONT]   = ui_page_front_create(parent);
    s_pages[UI_PAGE_MARKETS] = ui_page_markets_create(parent);
    for (int i = 0; i < UI_PAGE_COUNT; i++) lv_obj_set_pos(s_pages[i], 0, 0);

    build_overlay(parent);

    build_masthead(parent);
    build_dateline(parent);
    build_tape(parent);

    refresh_tape(NULL);
    ui_news_show_page(UI_PAGE_FRONT);
    ui_news_tick();
}

void ui_news_show_page(ui_page_t page)
{
    if (page < 0 || page >= UI_PAGE_COUNT) return;
    s_page = page;

    for (int i = 0; i < UI_PAGE_COUNT; i++) {
        ui_show(s_pages[i], i == (int)page);
    }
    ui_show(s_masthead, page == UI_PAGE_FRONT);
    /* The mark belongs to the nameplate, not to the strip: A2 wears a running
     * head, and a running head with a crest on it is a second nameplate. */
    ui_show(s_logo, page == UI_PAGE_FRONT);
    ui_show(s_running_head, page != UI_PAGE_FRONT);
    ui_show(s_running_sect, page != UI_PAGE_FRONT);
    if (page != UI_PAGE_FRONT) {
        /* The name is standing type and never changes; only the line under it
         * does. It was one composed string until the pair was rendered at
         * display_56 and would not fit the measure. */
        ui_set(s_running_sect, ui_news_page_title(page));
    }
}

ui_page_t ui_news_page(void)
{
    return s_page;
}

void ui_news_set_data(const news_t *v)
{
    char up[48];

    s_data         = v;
    s_have_data    = (v != NULL);
    s_demo         = v && v->demo;
    s_has_dateline = v && v->dateline[0];

    /* The language, before anything below is drawn. Every fixed string the two
     * pages set from here on reads the table this line chose, so it has to be
     * chosen before refresh_chip() and before the page updates at the foot of
     * this function — not after them, which would print one edition's badge in
     * the previous edition's language. */
    snprintf(s_lang_tag, sizeof s_lang_tag, "%s",
             (v && v->lang[0]) ? v->lang : "en");
    s_lang = ui_lang(s_lang_tag);

    /* The desk in the middle of the ruled line and the company on the right of
     * it. Both are upper-cased here rather than in ui_strings.h because both
     * arrive over the network. */
    ui_upper(up, sizeof up, (v && v->edition[0]) ? v->edition : S_BRAND);
    ui_set(s_edition, up);

    if (v && v->subject.symbol[0]) {
        char line[64];
        ui_upper(up, sizeof up, v->subject.exchange);
        snprintf(line, sizeof line, "%s%s%s", up, up[0] ? ": " : "",
                 v->subject.symbol);
        ui_set(s_subject, line);
    } else {
        ui_set(s_subject, "");
    }

    if (s_has_dateline) ui_set(s_dateline, v->dateline);

    refresh_tape(v);
    refresh_chip();

    /* The dateline fallback is derived from the clock, so it is recomposed in
     * the one place that owns that. */
    ui_news_tick();

    ui_page_front_update(v);
    ui_page_markets_update(v);
}

void ui_news_set_status(const ui_status_t *st)
{
    if (!st) return;

    const bool was_live = ui_data_live();
    s_status = *st;

    refresh_chip();

    /* The colour of every figure on the sheet is a claim about the same thing
     * the chip is, so a state that crossed the live/not-live line has to reach
     * them. Rebuilding both pages is the honest way to do it: the figures are
     * set by the page files, and a page that painted itself from a flag read at
     * draw time would be a page whose colour and whose text came from two
     * different snapshots. */
    if (was_live != ui_data_live()) {
        refresh_tape(s_data);
        ui_page_front_update(s_data);
        ui_page_markets_update(s_data);
    }
}

void ui_news_tick(void)
{
    struct tm lt;
    const bool clock_set = local_now(&lt);

    /* A dateline the payload spelled itself is left exactly as the paper set
     * it. This is for the board that has none — a first boot, a demo snapshot
     * older than the clock — where the only source left is the system time, and
     * where printing 1970 would be worse than printing nothing.
     *
     * Spelled the way the paper spells it, not the way the clock does. The slot
     * on every other sheet reads FRIDAY, AUGUST 14, 2026, and printing
     * "2026-08-15 (Sat)" in it made the one page a new owner is most likely to
     * be looking at also the one page that admitted to being a computer. */
    if (s_has_dateline) return;

    static const char *const WD[7]  = S_WEEKDAYS_CAPS;
    static const char *const MO[12] = S_MONTHS_CAPS;
    int wd = lt.tm_wday, mo = lt.tm_mon;
    if (wd < 0 || wd > 6)  wd = 0;
    if (mo < 0 || mo > 11) mo = 0;

    if (clock_set) ui_setf(s_dateline, "%s, %s %d, %d",
                           WD[wd], MO[mo], lt.tm_mday, lt.tm_year + 1900);
    else           ui_set(s_dateline, "");
}

/*
 * ui_news_header_area() used to be here, and it is deleted rather than left
 * unused. It handed the driver the one rectangle on the 5.83" board that was
 * worth a windowed partial refresh — the header strip, so a clock that ticked
 * did not flash the whole panel — and Spectra 6 has no partial waveform at all.
 * There is no rectangle for it to describe and no caller that could ever ask for
 * one: on this panel every pixel changes together or none of them do, which is
 * also why ui_news_tick() stopped being the cheap call.
 */
