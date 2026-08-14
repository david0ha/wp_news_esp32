/*
 * ui_news.c — the furniture of the sheet, and which page is printed on it.
 *
 * A newspaper's chrome is not a header and a footer. It is the top of the sheet
 * — kicker strip, masthead, dateline row, index ribbon — and the folio at the
 * foot, and both are printed on every page of the section. So this file owns
 * bands 1 to 4 and band 8 of the table in
 * docs/specs/2026-08-14-front-page-design.md §3, draws them once, and swaps the
 * only two things a page turn changes: the type in the masthead band, and the
 * letter in the folio.
 *
 * Bands 5, 6 and 7 belong to whichever page is on top. The pages are transparent
 * full-sheet panes created before this furniture, so a page positions a child at
 * UI_LEAD_Y and that is where it lands, and the furniture is drawn last —
 * meaning ink a page put in a band that is not its own ends up under the
 * masthead rather than over it.
 *
 * Nothing here refreshes the panel. See ui_news.h.
 */
#include "ui_news.h"
#include "ui_internal.h"

#include <stdbool.h>
#include <string.h>
#include <time.h>

/* --- the three columns the furniture is set on ----------------------------
 * The grid fixes every band's y; these are the only horizontal divisions the
 * furniture needs. The kicker strip, the dateline row and the folio each print
 * three things — something on the left, a fixed word in the middle, something
 * on the right — and all three print them on the same three columns, so the eye
 * reads one edge down the sheet instead of three that nearly agree. */
#define SLOT_W          UI_COL(2)               /*  364 */
#define SLOT_L_X        UI_COLX(0)              /*   30 */
#define SLOT_C_X        UI_COLX(2)              /*  418 */
#define SLOT_R_X        UI_COLX(4)              /*  806 */

/* Franklin's caps were cut to be spaced, and every caps label on this page
 * takes the same +2. The masthead's tracking is a different kind of number: it
 * is measured. S_MASTHEAD sets 1012 px solid in masthead_112 and 1102 px at 5,
 * against a measure of 1140 — so at 5 it spans the sheet, which is the whole
 * difference between a newspaper and a poster with a title on it. */
#define TRACK_CAPS      2
#define TRACK_MASTHEAD  5

/* The running head's box: four columns, centred on the sheet, which is 752 of
 * the 1140 measure. It is not the full measure, and that is the point — see
 * build_masthead_band(). The section line under it shares the box so the two
 * are centred on one axis. */
#define RH_X            UI_COLX(1)              /* 224 */
#define RH_W            UI_COL(4)               /* 752 */
#define RH_GAP          4

/* --- band 1: the kicker strip --------------------------------------------
 * The state word, and it is a WORD. It used to be a filled black pill with the
 * word reversed out of it: the only inverted region on the sheet, 1,692 px of
 * solid ink laid down as a background rather than as type, dead centre of the
 * strip — a chip, which is the one UI idiom the brief rules out, and which
 * reads as a status badge on a device rather than as anything a paper prints.
 *
 * A newspaper flags an edition with a word — LATE EDITION, REPLATE, FINAL —
 * set in the same tracked caps as the edition line beside it. So DEMO, STALE
 * and OFFLINE are set that way too, and that is the whole of the treatment.
 *
 * OFFLINE used to get a 2 px rule under it as well. A short heavy bar under one
 * centred word, nine pixels above the full-width hairline that closes the
 * strip, does not read as a paper raising its voice: it reads as a status chip,
 * which is the one UI idiom the brief rules out, and it was the most obviously
 * "UI" object on the sheet.
 *
 * READ THIS BEFORE TOUCHING ui_chg_colour(). Deleting that bar is only safe
 * because the COLOUR POLICY carries the same message at page scale. The word
 * itself does not: OFFLINE is 14 px of tracked caps in a strip of five other
 * 14 px tracked caps, and from three metres nobody picks it out. What is
 * legible from three metres is that the ribbon's five changes, the rail's
 * holdings and the whole of the quotation table have gone from green and red to
 * ink — sixteen coloured figures leaving a sheet that has no other colour on it
 * but the photograph. That is the entire page changing state, which is a
 * stronger tell than any 364 px object appearing in one corner of it.
 *
 * So the two are one decision. If ui_chg_colour() ever stops desaturating a
 * stale or offline snapshot, THE BAR COMES BACK THE SAME DAY, because at that
 * point nothing on the sheet says the page is old. See ui_data_live(). */

/* --- band 4: the index ribbon --------------------------------------------
 * The three rows stack on the faces' MEASURED line heights — ui_lab_w() gives
 * every one of them exactly lv_font_get_line_height() and not a pixel more — and
 * the numbers below are those heights transcribed from the committed font files
 * (fonts/ui_font_*.c, `.line_height`) so that the stack can be checked against
 * the heavy rule beneath it at build time rather than on the glass. A face
 * regenerated taller breaks the transcription silently here, which is why the
 * simulator renders the real faces and asserts on where the ink actually lands. */
#define RIB_NAME_LH     18                      /* label_14   */
#define RIB_VALUE_LH    41                      /* display_36 */
#define RIB_CHG_LH      UI_RIBBON_CHG_LH        /* 22, body_20 */

#define RIB_CELL_W(n)   (UI_RIBBON_CELL_W(n) - 2 * UI_RIBBON_PAD)  /* 204 at 5 */

/* The change row was set in label_14 with a 10 px mark under a 41 px level:
 * 11 px of digit against a 36 px figure, so from across the room the band read
 * as five big numbers and five specks — and which way and how far is the one
 * thing a market ribbon exists to say. body_16 and a 14 px mark put it one size
 * below the level instead of three, and the band takes it: 286 + 22 = 308,
 * still clear of the heavy rule at 310, which the assertion below states. Every
 * cell has 60-130 px of unused width, so nothing has to move sideways. */
#define RIB_MARK        14                      /* the up/down mark, square */
#define RIB_MARK_GAP     6
#define RIB_FLAT_H       3                      /* the bar a flat session gets */

/* --- band 8: the folio ----------------------------------------------------
 * Three items on one line, all in the same tracked caps: the imprint, the folio
 * letter, and the minute the sheet was set.
 *
 * There used to be a fourth. A battery meter was drawn at the right edge, and a
 * key legend — "KEY0 A1/A2 · KEY1 Refresh · KEY2 hold Wi-Fi" — was set flush
 * left in untracked mixed case, which made it the heaviest small type on the
 * sheet and the single most explicit statement on the page that this is a
 * screen. A framed newspaper's folio carries an imprint, a folio letter and an
 * edition time and has never carried either. Both are gone: the keys are
 * printed on the setup sheet, which is the one page that is about the device,
 * and the charge belongs in the companion app and the boot log. */

/* --- the setup sheet ------------------------------------------------------
 * Provisioning used to be a modal: a 752 x 340 card outlined in a 3 px rule,
 * floating on an otherwise blank sheet, 87% paper. Hung in a frame that reads
 * as a projector's no-signal card, and it is the first thing a new owner sees.
 *
 * So the setup state is now a PAGE. It is an opaque pane created between the
 * two pages and the furniture, which means it covers the news underneath —
 * necessary, because on e-Paper a hidden page is still physically on the glass
 * until something paints over it — while the kicker strip, the masthead, the
 * heavy rule, the dateline row and the folio print over the top of it exactly
 * as they do on A1. What the reader sees is the paper, with the setup story
 * where the lead goes. */
/* And it is a WHOLE page. The version this replaces set the sheet as a headline,
 * two 16 px instruction lines and 826 px of bare paper — 52% of the sheet —
 * with the one string the owner has to copy into a phone buried mid-paragraph
 * at 13 px of ink. The hierarchy was exactly inverted: the largest type said
 * "Wi-Fi Setup", which tells the reader nothing they did not already know.
 *
 * So the network's name is set in the LEAD face, in a slot of its own, in the
 * void that was already there; and bands 5 and 6 carry the standing type in
 * ui_strings.h, in two measures, the way every other sheet carries a page. Band
 * 7 is left as paper and the page is ruled where it ends — which is also what
 * proves the pane is opaque, since A1 fills that band with a quotation table.
 *
 * The two band rules are drawn HERE. The pane covers the pages, so the rules
 * the front page drew at 1108 and 1298 are underneath it, and a setup sheet
 * with no rules in its own bands is not this paper. */
#define OV_KICKER_Y     UI_LEAD_KICKER_Y                /*  318 */
#define OV_HEAD_Y       UI_LEAD_HEAD_Y                  /*  340, one line */
#define OV_DECK_Y       (UI_LEAD_Y + 97)                /*  415, 2 x 27 */
#define OV_DECK_H       54
#define OV_DECK_W       UI_COL(4)                       /*  752 */
#define OV_NET_Y        (UI_LEAD_Y + 160)               /*  478 */
#define OV_SSID_Y       (UI_LEAD_Y + 180)               /*  498, ..563 */
#define OV_HAIR_Y       UI_LEAD_HAIR_Y                  /*  566 */
/* The setup sheet has no photograph to make room for, so its copy takes the
 * lead well's own depth below the split — the deeper of band 5's two shapes,
 * which is what UI_LEAD_BODY_H is. */
#define OV_BODY_Y       UI_LEAD_SPLIT_Y                 /*  576 */
#define OV_BODY_W       UI_MEASURE_LG_W                 /*  558 */
#define OV_BODY_H       UI_LEAD_BODY_H                  /*  524, ..1100 */

#define OV_ABOUT_X      UI_COLX(3)                      /*  612 */
#define OV_ABOUT_Y      (UI_LEAD_SPLIT_Y + 22)          /*  598 */
#define OV_ABOUT_H      (UI_LEAD_BODY_H - 22)

/* A second standing block in each measure. The lead well is 782 px deep and the
 * two openers are 66 px and 154 px of type, so with only those the sheet still
 * ended in 360 px of paper — the same fault one band further down from the one
 * this rebuild was for. Each block is a caps heading with a paragraph under it,
 * and each runs to the foot of the band. */
#define OV_BLK_DY        22
#define OV_BLK_L        UI_CONTENT_X
#define OV_L2_Y         (UI_LEAD_SPLIT_Y + 122)
#define OV_R2_Y         (UI_LEAD_SPLIT_Y + 212)
#define OV_BLK_H(y)     (UI_LEAD_Y + UI_LEAD_H - ((y) + OV_BLK_DY))

#define OV_AFTER_W      UI_COL(4)                       /*  752 */
#define OV_AFTER_Y      (UI_SECOND_Y + 22)              /*  942 */
#define OV_AFTER_H      (UI_SECOND_Y + UI_SECOND_H - OV_AFTER_Y)

#define OV_REFER_X      UI_COLX(4)                      /*  806 */
#define OV_REFER_W      UI_COL(2)                       /*  364 */
#define OV_REFER_PAD    16
#define OV_REFER_H      140

_Static_assert(SLOT_R_X + SLOT_W == UI_CONTENT_R,
               "the furniture's three slots must fill the measure exactly");
_Static_assert(UI_RIBBON_NAME_Y + RIB_NAME_LH <= UI_RIBBON_VALUE_Y,
               "the ribbon's name must clear the figure under it");
_Static_assert(UI_RIBBON_VALUE_Y + RIB_VALUE_LH <= UI_RIBBON_CHG_Y,
               "the ribbon's figure must clear the change under it");
_Static_assert(UI_RIBBON_CHG_Y + RIB_CHG_LH <= UI_RIBBON_RULE_Y,
               "the ribbon's three rows must end above the heavy rule");

static lv_obj_t *s_pages[UI_PAGE_COUNT];
static ui_page_t s_page;

static lv_obj_t *s_edition, *s_dateline;                /* band 1 */
static lv_obj_t *s_badge_txt;
static lv_obj_t *s_masthead, *s_running_head, *s_running_sect;   /* band 2 */
static lv_obj_t *s_session, *s_as_of;                   /* band 3 */

static struct {                                         /* band 4 */
    lv_obj_t *name, *value, *chg;
    int      mark_x;          /* the mark's x inside the marks pane */
    int32_t  bp;              /* the change itself: up, down AND flat */
    bool     shown;
} s_rib[UI_RIBBON_CELLS];
static lv_obj_t *s_rib_vrule[UI_RIBBON_CELLS - 1];
static lv_obj_t *s_rib_marks;
static lv_obj_t *s_rib_none, *s_rib_wait;

static lv_obj_t *s_folio_letter, *s_folio_updated;      /* band 8 */

static lv_obj_t *s_overlay, *s_ov_title, *s_ov_body, *s_ov_net, *s_ov_ssid;

/* What the furniture remembers, and deliberately no more. Every string the
 * payload carried is already on the sheet — inside the label that prints it —
 * so the snapshot is not copied here; what is kept is only what a LATER call
 * has to re-derive: the badge's ranking needs to know the sheet is a demo, the
 * clock tick needs to know whether the payload brought its own dateline, and
 * the folio needs the minute the sheet was set. That is four bools and two
 * ints against news_t's eighteen kilobytes, on a board that already holds two
 * copies of it. */
/* The one exception to "the furniture copies nothing": the snapshot the pages
 * were last built from, so that a link state arriving AFTER the data can rebuild
 * them. It has to, because the state reaches the FIGURES — see ui_data_live() —
 * and a page whose prices are still green two hours after the wire went quiet
 * is the sheet asserting, in the loudest register it has, that it is current.
 *
 * The pointer is the caller's and is never dereferenced outside a call the
 * caller made: ui_news.h states the contract, which is that the snapshot handed
 * to ui_news_set_data() must outlive the next call to it. Both callers already
 * satisfy it — user_app.cpp holds a file-static copy, and the simulator a frame
 * that lives to the end of main(). */
static const news_t *s_data;

static bool s_have_data;
static bool s_demo;
static bool s_has_dateline;
static bool s_updated_set;
static int  s_updated_h, s_updated_m;
static ui_status_t s_status;

static const char *const PAGE_TITLES[UI_PAGE_COUNT] = {
    S_PAGE_FRONT, S_PAGE_MARKETS,
};

const char *ui_news_page_title(ui_page_t page)
{
    if (page < 0 || page >= UI_PAGE_COUNT) return "";
    return PAGE_TITLES[page];
}

/* There is no RTC on this board, so the clock is whatever SNTP has managed to
 * set — and before it succeeds time() returns 1970 with a timezone applied,
 * which prints as a perfectly plausible hour. The year is the cheapest thing to
 * test that on, and saying nothing until it passes is the only honest thing a
 * dateline or a folio can do. */
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

/* --- band 1: the kicker strip --------------------------------------------- */

/* One badge slot and a ranking for it. Three indicators competing for the strip
 * would either overlap or need a layout pass, and ranking them means the page
 * always shows the most important thing that is wrong — which is all a glance
 * from across a room carries anyway. */
static void refresh_badge(void)
{
    /* The order is not the obvious one. DEMO is last because a board that has
     * been given a URL keeps showing the demo snapshot until its first
     * successful fetch, so a configured board whose server is unreachable would
     * badge itself DEMO — true, and useless, instead of OFFLINE, which is the
     * thing the reader can act on. */
    const char *text = NULL;
    if (!s_status.online)           text = S_BADGE_OFFLINE;
    else if (s_status.stale)        text = S_BADGE_STALE;
    else if (s_have_data && s_demo) text = S_BADGE_DEMO;

    ui_show(s_badge_txt, text != NULL);
    if (text) ui_set(s_badge_txt, text);
}

static void build_kicker(lv_obj_t *par)
{
    /* The edition line falls back to the device's own name rather than to
     * nothing: on a board that has never fetched, the masthead is a paper that
     * has printed no edition, and a strip with the badge alone in it is a strip
     * that reads as broken. */
    s_edition = ui_lab_w(par, SLOT_L_X, UI_KICKER_Y, SLOT_W, UI_F_LABEL,
                         LV_TEXT_ALIGN_LEFT, S_BRAND);
    ui_track(s_edition, TRACK_CAPS);

    s_dateline = ui_lab_w(par, SLOT_R_X, UI_KICKER_Y, SLOT_W, UI_F_LABEL,
                          LV_TEXT_ALIGN_RIGHT, "");
    ui_track(s_dateline, TRACK_CAPS);

    /* Centred on the sheet's centre slot, in the same face, the same tracking
     * and the same ink as the edition line to its left. The rule under it is
     * the full slot rather than the word: a rule the width of a word is an
     * underline, which is a different thing and belongs to no newspaper. */
    s_badge_txt  = ui_lab_w(par, SLOT_C_X, UI_KICKER_Y, SLOT_W, UI_F_LABEL,
                            LV_TEXT_ALIGN_CENTER, S_BADGE_DEMO);
    ui_track(s_badge_txt, TRACK_CAPS);
    ui_show(s_badge_txt, false);

    ui_rule(par, UI_CONTENT_X, UI_KICKER_RULE_Y, UI_CONTENT_W, UI_KICKER_RULE_W);
}

/* --- band 2: the masthead ------------------------------------------------- */

static void build_masthead(lv_obj_t *par)
{
    /* The face's line height is 113 and the band's is 112, and the pixel is the
     * descender the 'g' of Washington needs. ui_lab_w() sizes to the line
     * height, so the box ends at 177 with nine pixels of paper before the heavy
     * rule — and it is a fixed height, so a longer name ellipsizes across the
     * measure instead of setting a second line on top of the dateline row. */
    s_masthead = ui_lab_w(par, UI_CONTENT_X, UI_MAST_Y, UI_CONTENT_W,
                          UI_F_MASTHEAD, LV_TEXT_ALIGN_CENTER, S_MASTHEAD);
    ui_track(s_masthead, TRACK_MASTHEAD);

    /* Any page that is not A1 wears a running head instead. The band does not
     * shrink to fit it: the rules under this one are the skeleton both pages
     * are printed on, and a masthead that took 40 px off itself would move
     * every one of them on one page and not the other. What changes is the type
     * in the band, centred in what the blackletter leaves behind.
     *
     * The name AND the section, both — but on TWO lines and in two sizes, which
     * is the whole of what makes this a running head rather than a second
     * nameplate.
     *
     * Three sizes were rendered before this settled. At display_36 the flag is
     * 26 px of cap height in a 112 px band and leaves 80% of it bare: A2 read as
     * a weaker, unrelated publication. At display_56 across the full measure the
     * composed "THE WASHINGTON POST · MARKETS" sets 1071 px of the 1140 — edge
     * to edge in a heavy Didone, which does not read as page two of a paper, it
     * reads as a second paper. The name alone sets 731 px at the same size, and
     * 731 in a 752 box is two thirds of the measure at half the nameplate's cap
     * height, which are the two ratios a section flag actually has.
     *
     * So the section leaves the display line and rides UNDER it in the same
     * tracked label_14 as every other piece of furniture on the sheet. Both
     * questions a reader asks at the top of a sheet are still answered, in the
     * order they are asked, and the answer to the second one is visibly the
     * smaller. 65 + 4 + 18 = 87 in a band of 112, centred, ending at 163 — well
     * clear of the heavy rule at 186.
     *
     * Which section is filled in by ui_news_show_page(), because this band is
     * the one piece of furniture a page turn changes and the page files must not
     * be the ones to change it — a page that set its own head would be printing
     * a second one over this. */
    const int hl = lv_font_get_line_height(UI_F_LEAD);      /* 65 */
    const int sl = lv_font_get_line_height(UI_F_LABEL);     /* 18 */
    const int ht = UI_MAST_Y + (UI_MAST_H - (hl + RH_GAP + sl)) / 2;

    s_running_head = ui_lab_w(par, RH_X, ht, RH_W, UI_F_LEAD,
                              LV_TEXT_ALIGN_CENTER, S_RUNNING_HEAD);
    ui_track(s_running_head, TRACK_CAPS);
    ui_show(s_running_head, false);

    s_running_sect = ui_lab_w(par, RH_X, ht + hl + RH_GAP, RH_W, UI_F_LABEL,
                              LV_TEXT_ALIGN_CENTER, "");
    ui_track(s_running_sect, TRACK_CAPS);
    ui_show(s_running_sect, false);

    ui_rule(par, UI_CONTENT_X, UI_MAST_RULE_Y, UI_CONTENT_W, UI_MAST_RULE_W);
}

/* --- band 3: the dateline row --------------------------------------------- */

static void build_dateline_row(lv_obj_t *par)
{
    /* The band is 20 px and the face 18, so the row is centred in it by
     * measurement — the two pixels are split rather than left at the bottom,
     * where they would tilt this row against the two identical ones above and
     * below it. */
    const int y = UI_DATELINE_Y + (UI_DATELINE_H - lv_font_get_line_height(UI_F_LABEL)) / 2;

    s_session = ui_lab_w(par, SLOT_L_X, y, SLOT_W, UI_F_LABEL,
                         LV_TEXT_ALIGN_LEFT, "");
    ui_track(s_session, TRACK_CAPS);

    lv_obj_t *wrap = ui_lab_w(par, SLOT_C_X, y, SLOT_W, UI_F_LABEL,
                              LV_TEXT_ALIGN_CENTER, S_MARKET_WRAP);
    ui_track(wrap, TRACK_CAPS);

    s_as_of = ui_lab_w(par, SLOT_R_X, y, SLOT_W, UI_F_LABEL,
                       LV_TEXT_ALIGN_RIGHT, "");
    ui_track(s_as_of, TRACK_CAPS);

    ui_rule(par, UI_CONTENT_X, UI_DATELINE_RULE_Y, UI_CONTENT_W, UI_DATELINE_RULE_W);
}

/* --- band 4: the index ribbon --------------------------------------------- */

/* All five marks are drawn by one callback on one pane spanning the change row,
 * rather than by five panes of ten pixels each: they share a row, they are the
 * same two shapes, and the row is the only part of the ribbon that is drawn
 * rather than set. Drawn, because a triangle is geometry and not a glyph — no
 * text face here carries U+25B2, adding it would mean regenerating six fonts,
 * and a set glyph could not be given UI_UP or UI_DOWN anyway. */
static void ribbon_marks_cb(lv_event_t *e)
{
    lv_layer_t *L   = lv_event_get_layer(e);
    lv_obj_t   *obj = lv_event_get_target_obj(e);
    if (!L || !obj) return;

    lv_area_t a;
    lv_obj_get_coords(obj, &a);

    for (int i = 0; i < UI_RIBBON_CELLS; i++) {
        if (!s_rib[i].shown) continue;

        const int x = a.x1 + s_rib[i].mark_x;
        const int y = a.y1 + (RIB_CHG_LH - RIB_MARK) / 2;

        /* A session that did not move gets a bar, in ink. A solid green
         * triangle beside +0.00% asserts a rise that did not happen, and in a
         * row the eye scans for direction that is worse than spending the mark
         * on nothing — the reader counts a flat index as a gainer. */
        if (s_rib[i].bp == 0) {
            const int t = y + (RIB_MARK - RIB_FLAT_H) / 2;
            ui_draw_rect_c_abs(L, x, t, x + RIB_MARK - 1, t + RIB_FLAT_H - 1,
                               true, 0, UI_INK);
            continue;
        }
        ui_draw_tri_abs(L, x, y, RIB_MARK, RIB_MARK, s_rib[i].bp > 0,
                        ui_chg_colour(s_rib[i].bp));
    }
}

static void build_ribbon(lv_obj_t *par)
{
    /* Built on the five-cell grid and moved on every update, because the cell
     * width is the measure divided by the count that arrived and the count is
     * not known until a payload lands. The narrowest cell the band ever sets is
     * the one built here, so a label can only ever be widened afterwards. */
    for (int i = 0; i < UI_RIBBON_CELLS; i++) {
        const int x = UI_RIBBON_CELL_X(UI_RIBBON_CELLS, i) + UI_RIBBON_PAD;
        const int w = RIB_CELL_W(UI_RIBBON_CELLS);

        s_rib[i].name = ui_lab_w(par, x, UI_RIBBON_NAME_Y, w, UI_F_LABEL,
                                 LV_TEXT_ALIGN_LEFT, "");
        ui_track(s_rib[i].name, TRACK_CAPS);

        /* There is no numeral face on this board and the level is set in the
         * headline Didone, whose lining figures are the point of the family —
         * a table set in the same face as the headlines above it is what makes
         * a front page look typeset rather than assembled. */
        s_rib[i].value = ui_lab_w(par, x, UI_RIBBON_VALUE_Y, w, UI_F_HEADLINE,
                                  LV_TEXT_ALIGN_LEFT, "");

        s_rib[i].chg = ui_lab_w(par, x + RIB_MARK + RIB_MARK_GAP,
                                UI_RIBBON_CHG_Y, w - RIB_MARK - RIB_MARK_GAP,
                                UI_F_BODY_LG, LV_TEXT_ALIGN_LEFT, "");
    }

    /* The vrule sits ON the last pixel of a cell rather than in a gap of its
     * own, which is what keeps the cell origins where the arithmetic puts them
     * instead of a pixel inside a gutter that does not exist here. */
    for (int i = 0; i < UI_RIBBON_CELLS - 1; i++) {
        s_rib_vrule[i] = ui_vrule(par, UI_RIBBON_VRULE_X(UI_RIBBON_CELLS, i),
                                  UI_RIBBON_Y, UI_RIBBON_H, UI_RULE_HAIR);
    }

    s_rib_marks = ui_pane(par, UI_CONTENT_X, UI_RIBBON_CHG_Y,
                          UI_CONTENT_W, RIB_CHG_LH);
    lv_obj_add_event_cb(s_rib_marks, ribbon_marks_cb, LV_EVENT_DRAW_MAIN, NULL);

    /* A ribbon with no quotations in it still has to be a ribbon: the band is
     * asserted to contain ink, and five empty cells behind four rules read as a
     * fault in the panel rather than as a quiet morning. One line across the
     * measure is what a paper prints instead — and there are two of them,
     * because the two cases it covers are not the same size of news.
     *
     * A payload that arrived with no indices in it is a thin morning on a sheet
     * that is otherwise full, and a deck-sized line is the right weight for it.
     * NO PAYLOAD AT ALL is the whole sheet: a masthead and one italic phrase at
     * 21 px, which from three metres is a nameplate over a blank page. That is a
     * state the frame really sits in — boot, a dropped link, a name that stopped
     * resolving — so the one line it does print is set at the size this paper
     * sets a lead headline, and the sheet reads as a front page with one line on
     * it rather than as a fault. The band takes it: 65 px centred in 82 ends at
     * 300, ten clear of the heavy rule. */
    const int lh = lv_font_get_line_height(UI_F_DECK);
    s_rib_none = ui_lab_w(par, UI_CONTENT_X, UI_RIBBON_Y + (UI_RIBBON_H - lh) / 2,
                          UI_CONTENT_W, UI_F_DECK, LV_TEXT_ALIGN_CENTER, S_NO_DATA);
    ui_show(s_rib_none, false);

    const int wl = lv_font_get_line_height(UI_F_LEAD);
    s_rib_wait = ui_lab_w(par, UI_CONTENT_X, UI_RIBBON_Y + (UI_RIBBON_H - wl) / 2,
                          UI_CONTENT_W, UI_F_LEAD, LV_TEXT_ALIGN_CENTER, S_WAITING);
    ui_show(s_rib_wait, false);

    ui_rule(par, UI_CONTENT_X, UI_RIBBON_RULE_Y, UI_CONTENT_W, UI_RIBBON_RULE_W);
}

static void refresh_ribbon(const news_t *v)
{
    int n = v ? v->index_count : 0;
    if (n > UI_RIBBON_CELLS) n = UI_RIBBON_CELLS;

    /* The band is divided by the indices that ARRIVED, not by the five it can
     * hold. Two cells of 570 fill the measure; two of 228 centred on a grid of
     * five leave a quarter of it blank at each end and sit oddly left of a
     * masthead centred on the sheet — a ribbon that looks like it lost three
     * quotations rather than one that was given two. This version fills at every
     * count from one to five, which is the whole reason 1140 divides by all of
     * them exactly. */
    const int cw = UI_RIBBON_CELL_W(n > 0 ? n : UI_RIBBON_CELLS);
    const int lw = cw - 2 * UI_RIBBON_PAD;

    for (int i = 0; i < UI_RIBBON_CELLS; i++) {
        const bool on = i < n;

        s_rib[i].shown = on;
        ui_show(s_rib[i].name, on);
        ui_show(s_rib[i].value, on);
        ui_show(s_rib[i].chg, on);
        if (!on) continue;

        const news_quote_t *q = &v->indices[i];
        const int x = UI_RIBBON_CELL_X(n, i) + UI_RIBBON_PAD;
        char buf[32];

        /* The three rows keep their y and take the cell's x and width, which is
         * all a wider cell changes: the stack was measured against the heavy
         * rule below it and nothing about the count moves it. */
        lv_obj_set_pos(s_rib[i].name, x, UI_RIBBON_NAME_Y);
        lv_obj_set_width(s_rib[i].name, lw);
        lv_obj_set_pos(s_rib[i].value, x, UI_RIBBON_VALUE_Y);
        lv_obj_set_width(s_rib[i].value, lw);
        lv_obj_set_pos(s_rib[i].chg, x + RIB_MARK + RIB_MARK_GAP, UI_RIBBON_CHG_Y);
        lv_obj_set_width(s_rib[i].chg, lw - RIB_MARK - RIB_MARK_GAP);

        s_rib[i].mark_x = x - UI_CONTENT_X;
        s_rib[i].bp     = q->chg_bp;

        /* Upper-cased before it is set, because the slot is TRACKED: +2 px a
         * character is Franklin's caps spacing, and applied to "Nasdaq" it
         * prints N a s d a q beside a correctly spaced S&P 500 in the next
         * cell. The name is a network string, so the transform is here rather
         * than in ui_strings.h with the rest of the caps. */
        char up[32];
        ui_upper(up, sizeof up, q->name[0] ? q->name : q->symbol);
        ui_set(s_rib[i].name, up);

        ui_money(buf, sizeof buf, q->last_c);
        ui_set(s_rib[i].value, buf);

        /* The figure keeps its sign even though the mark beside it already
         * carries the direction: the same percentage is printed in the rail and
         * in the quotation table, and three spellings of one number is how a
         * page stops being read as a set of tables. The colour is set on the
         * label rather than given to ui_lab_c() at creation because a figure
         * changes sign between polls and the label does not; UI_UP and UI_DOWN
         * still name it, which is what the colour policy is audited on. */
        ui_pct(buf, sizeof buf, q->chg_bp);
        ui_set(s_rib[i].chg, buf);
        lv_obj_set_style_text_color(s_rib[i].chg, ui_chg_colour(q->chg_bp), 0);
    }

    /* One vrule on each INTERNAL boundary, so n cells carry n-1 of them and the
     * band is never closed by a rule standing on the margin. */
    for (int i = 0; i < UI_RIBBON_CELLS - 1; i++) {
        const bool on = i < n - 1;
        ui_show(s_rib_vrule[i], on);
        if (on) lv_obj_set_x(s_rib_vrule[i], UI_RIBBON_VRULE_X(n, i));
    }

    ui_show(s_rib_marks, n > 0);
    ui_show(s_rib_none, n == 0 && v != NULL);
    ui_show(s_rib_wait, n == 0 && v == NULL);
}

/* --- band 8: the folio ---------------------------------------------------- */

static void refresh_folio(void)
{
    if (s_updated_set) ui_setf(s_folio_updated, S_UPDATED " %02d:%02d",
                               s_updated_h, s_updated_m);
    else               ui_set(s_folio_updated, S_UPDATED " --:--");
}

static void build_folio(lv_obj_t *par)
{
    /* The hairline over the folio is drawn here rather than by the page above
     * it. It is the line that closes the sheet, both pages need it on the same
     * row, and the two rules inside the pages' own bands are theirs precisely
     * because one of them is conditional — a lead promoted over the secondary
     * row must not have a rule through the middle of it. */
    ui_rule(par, UI_CONTENT_X, UI_TICKER_RULE_Y, UI_CONTENT_W, UI_TICKER_RULE_W);

    /* The left-hand slot carries the imprint the spec asked for: who set the
     * sheet and where it came from, in the same tracked caps as its two
     * neighbours, so the line reads as one line rather than as three
     * typographic treatments sharing a row. */
    lv_obj_t *imprint = ui_lab_w(par, SLOT_L_X, UI_FOLIO_Y, SLOT_W, UI_F_LABEL,
                                 LV_TEXT_ALIGN_LEFT, S_IMPRINT);
    ui_track(imprint, TRACK_CAPS);

    s_folio_letter = ui_lab_w(par, SLOT_C_X, UI_FOLIO_Y, SLOT_W, UI_F_LABEL,
                              LV_TEXT_ALIGN_CENTER, S_FOLIO_A1);
    ui_track(s_folio_letter, TRACK_CAPS);

    /* UPDATED is the minute this sheet was set, and it is the only thing on the
     * page that admits how old the news on it is. Its drafted companion, NEXT,
     * is not printed: the poll cadence is a Kconfig value on the device and
     * absent from both the simulator and the host tests, so a NEXT composed
     * here would be a default that a menuconfig may since have changed — a
     * wrong time, printed on the one line whose whole claim is that its times
     * are right. When the cadence reaches the UI, this is the label for it. */
    s_folio_updated = ui_lab_w(par, SLOT_R_X, UI_FOLIO_Y, SLOT_W, UI_F_LABEL,
                               LV_TEXT_ALIGN_RIGHT, "");
    ui_track(s_folio_updated, TRACK_CAPS);

    refresh_folio();
}

/* --- the overlay ---------------------------------------------------------- */

/* A caps heading with a paragraph under it, in one measure, running to the foot
 * of the lead band. Both of the setup sheet's second-tier blocks are one of
 * these, and so are the two openers in all but their y. */
static void ov_block(int x, int y, const char *head, const char *body)
{
    lv_obj_t *h = ui_lab_w(s_overlay, x, y, OV_BODY_W, UI_F_LABEL,
                           LV_TEXT_ALIGN_LEFT, head);
    ui_track(h, TRACK_CAPS);

    lv_obj_t *b = ui_lab_box(s_overlay, x, y + OV_BLK_DY, OV_BODY_W,
                             OV_BLK_H(y), UI_F_BODY_LG, LV_TEXT_ALIGN_LEFT,
                             body);
    ui_lab_wrap(b, OV_BLK_H(y));
}

static void build_overlay(lv_obj_t *par)
{
    /* Opaque and full-bleed: it has to hide the NEWS underneath, because on
     * e-Paper "hidden" only means "not drawn this frame" and the previous frame
     * is still physically on the glass until something covers it. It is created
     * here — before the furniture — so the masthead, the rules and the folio
     * print on top of it and the setup state is a sheet of this paper rather
     * than a dialog floating on a blank one. */
    s_overlay = ui_frame(par, 0, 0, UI_W, UI_H, 0);

    lv_obj_t *kick = ui_lab_w(s_overlay, UI_CONTENT_X, OV_KICKER_Y, UI_CONTENT_W,
                              UI_F_LABEL, LV_TEXT_ALIGN_LEFT, S_SETUP_KICKER);
    ui_track(kick, TRACK_CAPS);

    /* One line, not two: the head is "Wi-Fi Setup" and the 65 px it needs is
     * what it gets, so the deck under it starts where a deck starts rather than
     * 164 px of paper later. */
    s_ov_title = ui_lab_w(s_overlay, UI_CONTENT_X, OV_HEAD_Y, UI_CONTENT_W,
                          UI_F_LEAD, LV_TEXT_ALIGN_LEFT, "");
    lv_obj_t *deck = ui_lab_box(s_overlay, UI_CONTENT_X, OV_DECK_Y, OV_DECK_W,
                                OV_DECK_H, UI_F_DECK, LV_TEXT_ALIGN_LEFT,
                                S_SETUP_DECK);
    ui_lab_wrap(deck, OV_DECK_H);

    /* The network's name, at the size of a lead headline, under a caps label
     * that says what it is. It is the one string on this sheet the owner has to
     * carry to another device, and it was 13 px of ink in the middle of a
     * paragraph. */
    s_ov_net = ui_lab_w(s_overlay, UI_CONTENT_X, OV_NET_Y, UI_CONTENT_W,
                        UI_F_LABEL, LV_TEXT_ALIGN_LEFT, S_SETUP_NETWORK);
    ui_track(s_ov_net, TRACK_CAPS);
    s_ov_ssid = ui_lab_w(s_overlay, UI_CONTENT_X, OV_SSID_Y, UI_CONTENT_W,
                         UI_F_LEAD, LV_TEXT_ALIGN_LEFT, "");

    ui_rule(s_overlay, UI_CONTENT_X, OV_HAIR_Y, UI_CONTENT_W, UI_RULE_HAIR);

    /* The body is the one label on the board allowed to wrap: it carries
     * instructions, and an ellipsis there would be useless. */
    s_ov_body = ui_lab_box(s_overlay, UI_CONTENT_X, OV_BODY_Y, OV_BODY_W,
                           OV_BODY_H, UI_F_BODY_LG, LV_TEXT_ALIGN_LEFT, "");
    ui_lab_wrap(s_ov_body, OV_BODY_H);

    /* The second measure of band 5, and the whole of band 6: standing type.
     * A page with two lines on it is not a page, and this is the sheet a new
     * owner looks at for as long as it takes to type a password in. */
    lv_obj_t *ah = ui_lab_w(s_overlay, OV_ABOUT_X, OV_BODY_Y, OV_BODY_W,
                            UI_F_LABEL, LV_TEXT_ALIGN_LEFT, S_SETUP_ABOUT_H);
    ui_track(ah, TRACK_CAPS);
    lv_obj_t *about = ui_lab_box(s_overlay, OV_ABOUT_X, OV_ABOUT_Y, OV_BODY_W,
                                 OV_ABOUT_H, UI_F_BODY_LG, LV_TEXT_ALIGN_LEFT,
                                 S_SETUP_ABOUT);
    ui_lab_wrap(about, OV_ABOUT_H);

    ov_block(OV_BLK_L, OV_L2_Y, S_SETUP_TROUBLE_H, S_SETUP_TROUBLE);
    ov_block(OV_ABOUT_X, OV_R2_Y, S_SETUP_SOURCE_H, S_SETUP_SOURCE);

    ui_rule(s_overlay, UI_CONTENT_X, UI_LEAD_RULE_Y, UI_CONTENT_W,
            UI_LEAD_RULE_W);

    lv_obj_t *fh = ui_lab_w(s_overlay, UI_CONTENT_X, UI_SECOND_Y, OV_AFTER_W,
                            UI_F_LABEL, LV_TEXT_ALIGN_LEFT, S_SETUP_AFTER_H);
    ui_track(fh, TRACK_CAPS);
    lv_obj_t *after = ui_lab_box(s_overlay, UI_CONTENT_X, OV_AFTER_Y,
                                 OV_AFTER_W, OV_AFTER_H, UI_F_BODY_LG,
                                 LV_TEXT_ALIGN_LEFT, S_SETUP_AFTER);
    ui_lab_wrap(after, OV_AFTER_H);

    /* A standing box in the last two columns — a "refer", which is real
     * front-page furniture — carrying the one thing that genuinely belongs to
     * the device: what its three buttons do. */
    ui_frame(s_overlay, OV_REFER_X, UI_SECOND_Y, OV_REFER_W, OV_REFER_H,
             UI_RULE_HAIR);
    lv_obj_t *rh = ui_lab_w(s_overlay, OV_REFER_X + OV_REFER_PAD,
                            UI_SECOND_Y + OV_REFER_PAD,
                            OV_REFER_W - 2 * OV_REFER_PAD, UI_F_LABEL,
                            LV_TEXT_ALIGN_LEFT, S_SETUP_KEYS);
    ui_track(rh, TRACK_CAPS);
    ui_rule(s_overlay, OV_REFER_X + OV_REFER_PAD,
            UI_SECOND_Y + OV_REFER_PAD + 24,
            OV_REFER_W - 2 * OV_REFER_PAD, UI_RULE_HAIR);
    lv_obj_t *keys = ui_lab_box(s_overlay, OV_REFER_X + OV_REFER_PAD,
                                UI_SECOND_Y + OV_REFER_PAD + 34,
                                OV_REFER_W - 2 * OV_REFER_PAD,
                                OV_REFER_H - OV_REFER_PAD - 34, UI_F_BODY,
                                LV_TEXT_ALIGN_LEFT,
                                S_KEY_PAGE "\n" S_KEY_REFRESH "\n" S_KEY_WIFI);
    ui_lab_wrap(keys, OV_REFER_H - OV_REFER_PAD - 34);

    /* The line the setup sheet ends on. Band 7 below it is bare paper, which is
     * the page stopping rather than the page failing — and it is what an
     * onlooker's eye reads as "there is nothing else here", as well as being
     * what proves this pane is opaque: A1 fills that band with a quotation
     * table, and the simulator asserts it is blank here. */
    ui_rule(s_overlay, UI_CONTENT_X, UI_SECOND_RULE_Y, UI_CONTENT_W,
            UI_SECOND_RULE_W);

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
    for (int i = 0; i < UI_PAGE_COUNT; i++) {
        lv_obj_set_pos(s_pages[i], 0, 0);
    }

    /* The setup sheet sits between the pages and the furniture: over the news,
     * under the masthead. See build_overlay(). */
    build_overlay(parent);

    build_kicker(parent);
    build_masthead(parent);
    build_dateline_row(parent);
    build_ribbon(parent);
    build_folio(parent);

    refresh_ribbon(NULL);
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
    ui_show(s_running_head, page != UI_PAGE_FRONT);
    ui_show(s_running_sect, page != UI_PAGE_FRONT);
    if (page != UI_PAGE_FRONT) {
        /* The name is standing type and never changes; only the line under it
         * does. It was one composed string until the pair was rendered at
         * display_56 and would not fit the measure. */
        ui_set(s_running_sect, ui_news_page_title(page));
    }
    ui_set(s_folio_letter, page == UI_PAGE_FRONT ? S_FOLIO_A1 : S_FOLIO_A2);
}

ui_page_t ui_news_page(void)
{
    return s_page;
}

void ui_news_set_data(const news_t *v)
{
    s_data         = v;
    s_have_data    = (v != NULL);
    s_demo         = v && v->demo;
    s_has_dateline = v && v->dateline[0];

    ui_set(s_edition, (v && v->edition[0]) ? v->edition : S_BRAND);
    ui_set(s_session, v ? v->session : "");
    ui_set(s_as_of,   v ? v->as_of   : "");
    if (s_has_dateline) ui_set(s_dateline, v->dateline);

    refresh_ribbon(v);
    refresh_badge();

    /* UPDATED is the minute the sheet was set, not the minute the agent wrote
     * it. The payload's own generated_at is the server's clock in the server's
     * zone, and the dateline row already prints the server's AS OF: a second
     * time from that same source, at the foot of the page and unlabelled as to
     * whose it is, tells the reader nothing the top of the page did not. What
     * only the board can say is when the glass last changed. */
    struct tm lt;
    s_updated_set = s_have_data && local_now(&lt);
    if (s_updated_set) {
        s_updated_h = lt.tm_hour;
        s_updated_m = lt.tm_min;
    }

    /* The dateline fallback and the folio are both derived from the clock, so
     * they are recomposed in the one place that owns that. */
    ui_news_tick();

    ui_page_front_update(v);
    ui_page_markets_update(v);
}

void ui_news_set_status(const ui_status_t *st)
{
    if (!st) return;

    const bool was_live = ui_data_live();
    s_status = *st;

    /* The badge says WHAT is wrong. Saying OFFLINE twice, once at the top of the
     * sheet and once at the foot, does not make it twice as true — and the folio
     * is where the board is quiet about itself. */
    refresh_badge();

    /* But the colour of every figure on the sheet is a claim about the same
     * thing, so a state that crossed the live/not-live line has to reach them.
     * Rebuilding both pages is the honest way to do it: the figures are set by
     * the page files, and a page that painted itself from a flag read at draw
     * time would be a page whose colour and whose text came from two different
     * snapshots. */
    if (was_live != ui_data_live()) {
        refresh_ribbon(s_data);
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
     * where printing 1970 would be worse than printing nothing. */
    if (!s_has_dateline) {
        /* Spelled the way the paper spells it, not the way the clock does. The
         * slot beside this one on every other sheet reads FRIDAY, AUGUST 14,
         * 2026, and printing "2026-08-15 (Sat)" in it made the one page a new
         * owner is most likely to be looking at — the board with no payload yet
         * — also the one page that admitted to being a computer. */
        static const char *const WD[7] = S_WEEKDAYS_CAPS;
        static const char *const MO[12] = S_MONTHS_CAPS;
        int wd = lt.tm_wday, mo = lt.tm_mon;
        if (wd < 0 || wd > 6)  wd = 0;
        if (mo < 0 || mo > 11) mo = 0;

        if (clock_set) ui_setf(s_dateline, "%s, %s %d, %d",
                               WD[wd], MO[mo], lt.tm_mday, lt.tm_year + 1900);
        else           ui_set(s_dateline, "");
    }

    refresh_folio();
}

/*
 * ui_news_header_area() used to be here, and it is deleted rather than left
 * unused. It handed the driver the one rectangle on the 5.83" board that was
 * worth a windowed partial refresh — the header strip, so a clock that ticked
 * did not flash the whole panel — and Spectra 6 has no partial waveform at all.
 * There is no rectangle for it to describe and no caller that could ever ask
 * for one: on this panel every pixel changes together or none of them do, which
 * is also why ui_news_tick() stopped being the cheap call.
 */
