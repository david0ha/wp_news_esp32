/*
 * ui_page_front.c — A1: the news hole, and the engine that decides what goes
 * in it.
 *
 * ## Three bands, not eight
 *
 * The sheet has eight bands and this file owns three of them: the lead well,
 * the secondary row and the quotation table — bands 5, 6 and 7. The four above
 * them (kicker strip, masthead, dateline row, index ribbon) and the folio at
 * the foot are the FURNITURE, they are printed on every page of the section,
 * and ui_news.c draws them once for both pages. A page file that drew its own
 * copy would not replace them — the furniture is created after the pages and
 * sits over them — it would print a second edition line at a slightly different
 * width across the first one, which is a smear on the glass and reads as a
 * rendering fault rather than as a layout one. So: nothing below y=313, the
 * bottom of band 4's heavy rule, and nothing in band 8.
 *
 * The bands never move. Every y, x, w and h below is a macro from
 * ui_internal.h, because the simulator asserts on those same macros and a page
 * that transcribed one of them into a literal would be asserting against its
 * own transcription. Nothing here computes a position from a measurement taken
 * at runtime either: the sheet is the same 1200 x 1600 whatever the payload
 * says, and a layout that shifts when a headline gets longer is a layout nobody
 * can check.
 *
 * ## What varies is WHICH story fills a slot, never WHERE the slot is
 *
 * The server ranks; the device fits. So this file does two things and keeps
 * them apart: a tier engine that sorts the stories and hands one to each slot
 * BY POSITION (see tier_assign), and a set of setters that pour a story into a
 * slot whose geometry was decided when the page was built. Under-supply is
 * handled by promotion rather than by leaving paper: no photograph means the
 * lead's chart stands in the left leg of the well and the story sets beside it
 * for the well's full depth, no secondary story means the portfolio rail takes
 * the whole of band 6 instead of half of it, and no stories at all means the
 * lead well becomes the index ribbon at the size a headline is set in and the
 * sheet is a markets page — which on a quiet day is a legitimate front page and
 * not an error state.
 *
 * ## Colour
 *
 * Green and red reach the glass from exactly two functions in this file:
 * chg_colour(), which is passed to lv_obj_set_style_text_color(), and
 * mark_draw_cb(), which is passed to ui_draw_tri_abs(). Both are reached only
 * from a percentage change or its mark. Grepping this file for UI_UP and
 * UI_DOWN finds those two and nothing else, which is the whole of the audit
 * ui_internal.h describes.
 *
 * The colour is set rather than built with ui_lab_c() because it is DATA: a
 * label whose colour was fixed when the page was created would need destroying
 * and rebuilding the first time a holding went from up to down, and this page
 * builds nothing in update().
 *
 * ## Two calls, and no state between them
 *
 * create() builds every widget the page can ever show and returns the pane;
 * update() rewrites them from a snapshot. Nothing is created, destroyed or
 * re-parented in update(): on a board that repaints every five minutes for
 * years, object churn is where the leak lives, and a slot that exists whether
 * or not it has content is a slot the page can hide in one call.
 */
#include "ui_internal.h"

#include "ui_chart.h"
#include "ui_fit.h"
#include "ui_tile.h"

#include <stdbool.h>
#include <stddef.h>
#include <stdio.h>
#include <string.h>

/* --- geometry the header states as a sum ----------------------------------
 * ui_internal.h gives the quotation table its five field WIDTHS and the gap
 * between them; the x of each field is that arithmetic run out. It is done
 * here rather than in the header because the same five widths lay out three
 * different things — the table's heads, its rows, and the portfolio rail, whose
 * x's move with its width — and a header that carried an x for each would be
 * carrying the same sum three times over. */
#define FP_T_SYM_X      UI_TICKER_X
#define FP_T_NAME_X     (FP_T_SYM_X  + UI_TICKER_SYM_W  + UI_TICKER_FIELD_GAP)
#define FP_T_LAST_X     (FP_T_NAME_X + UI_TICKER_NAME_W + UI_TICKER_FIELD_GAP)
#define FP_T_CHG_X      (FP_T_LAST_X + UI_TICKER_LAST_W + UI_TICKER_FIELD_GAP)
#define FP_T_SPARK_X    (FP_T_CHG_X  + UI_TICKER_CHG_W  + UI_TICKER_FIELD_GAP)

/* Band 5 with no stories at all: the ribbon again, one index to a row, in the
 * well BELOW the split — because the top of the well is not empty on such a
 * day either. See set_summary(): a market summary takes the kicker, the
 * headline and the deck, and the panel takes what a lead's legs would have had.
 * Five rows of 104 end at 1096 against the well's 1100 — the four pixels the
 * division drops are left at the foot rather than distributed, which is what
 * keeps every row pitch identical.
 *
 * The panel used to fill the whole band at 156 px a row, and it moved down
 * rather than being made to share: a headline set OVER five 156 px rows would
 * have had to come out of them anyway, and 104 px still holds a 65 px level
 * with a hairline clear beneath it. */
#define FP_PANEL_ROW_H  (UI_LEAD_BODY_H / UI_RIBBON_CELLS)
#define FP_PANEL_ROW_Y(i) (UI_LEAD_SPLIT_Y + (i) * FP_PANEL_ROW_H)
#define FP_PANEL_CHG_X  UI_COLX(3)
#define FP_PANEL_CHG_W  UI_COL(1)

/* And the shape of the session in the two columns the figures do not need.
 * Without it the quiet-day well inks x[30..250] and x[612..780] and leaves 390
 * px of the measure blank down the whole 782 px band — a third of the sheet's
 * strongest area, on the one page whose brief was to use as much of the display
 * as possible. A2 already runs this exact chart into that exact space from the
 * same news_quote_t.spark; this is the same call. */
#define FP_PANEL_SPARK_X  UI_COLX(4)                    /*  806 */
#define FP_PANEL_SPARK_W  UI_COL(2)                     /*  364 */
#define FP_PANEL_SPARK_DY 10
#define FP_PANEL_SPARK_H  (FP_PANEL_ROW_H - 2 * FP_PANEL_SPARK_DY - UI_RULE_HAIR)

/* Every caps label on the page takes the same tracking: Franklin's caps were
 * cut to be spaced, and a kicker set solid reads as one long word from the
 * distance this panel is looked at. */
#define FP_TRACK        2

/* Which quotation the table starts from. It is a macro rather than a local in
 * set_ticker() because the briefs column has to know EXACTLY which symbols the
 * sheet has already printed, and a second expression of the same rule is how a
 * brief comes to repeat a row that moved. See set_briefs(). */
#define FP_TICK_BASE(v) ((v)->ticker_count > UI_TICKER_ROWS ? UI_RAIL_ROWS : 0)

/* A brief is a kicker and two lines of body_16 under it. Two rather than one
 * because 364 px of that face sets 42 characters and a headline runs to 72, and
 * rather than three because three briefs at three lines each do not fit the
 * band — which is also why the head is BALANCED rather than set greedily: at
 * two lines the greedy break leaves "...where the mall does / not". */
#define FP_BRIEF_LINES  2

/* The room an ellipsis needs at the end of a caption cut short. It is held back
 * from the measure BEFORE the copyfit rather than trimmed after it, because the
 * character is appended to a string ui_fit_text has already decided fits. */
#define FP_CAP_ELLIPSIS 16

/* Where the lead's legs stand, which is the only thing the photograph changes
 * about them. Two macros rather than the ternary written out at each of the
 * three places that needs it — the layout, the copyfit and the end mark — all
 * of which have to agree to the pixel or the story's closing square lands in
 * the middle of its own last paragraph. */
#define FP_LEG_Y(photo) ((photo) ? UI_LEAD_UNDER_Y : UI_LEAD_SPLIT_Y)
#define FP_LEG_H(photo) ((photo) ? UI_LEAD_UNDER_H : UI_LEAD_BODY_H)

/* Copy buffers, sized in BYTES against slots measured in CHARACTERS. The lead
 * takes 636 characters across its two legs under a photograph and 2,400 with a
 * chart in one of them instead, but a copy desk emits em dashes and accented
 * names and a UTF-8 character is up to four bytes — so every buffer is the
 * model's own field width, the one size a legal payload cannot overrun and
 * therefore the one size at which ui_fit_text is cutting on the box rather than
 * on the buffer.
 *
 * File statics, not locals: a news_t is already too big for a task stack, and
 * three kilobytes of copy on the same frame would be worse. */
#define FP_COPY_MAX     NEWS_BODY_MAX

/* --- widgets --------------------------------------------------------------
 * One struct per repeated shape, so a band's setter walks an array instead of
 * naming eight sets of five widgets. */

typedef struct {
    lv_obj_t *name, *value, *mark, *chg, *spark;
} cell_t;                       /* an index, in the lead well's panel */

typedef struct {
    lv_obj_t *kicker, *head, *deck;
} story_t;                      /* the secondary story, band 6 */

typedef struct {
    lv_obj_t *kicker, *head;
} brief_t;                      /* a story that did not make the page, band 7 */

typedef struct {
    lv_obj_t *sym, *name, *last, *mark, *chg, *spark;
} holding_t;                    /* a row of the portfolio rail, band 6 */

typedef struct {
    lv_obj_t *sym, *name, *last, *mark, *chg, *spark, *hair;
} quote_t;                      /* a row of the quotation table, band 7 */

static lv_obj_t *s_page;

static lv_obj_t *s_lead_rule, *s_second_rule;   /* the two band boundaries */

static lv_obj_t *s_lead_kicker, *s_lead_head, *s_lead_deck,     /* band 5 */
                *s_lead_byline, *s_lead_hair, *s_lead_cap, *s_lead_cred;
static lv_obj_t *s_lead_photo, *s_lead_chart, *s_lead_vrule;
static lv_obj_t *s_lead_edge[4];
static lv_obj_t *s_lead_body[UI_LEAD_COLS];
static lv_obj_t *s_lead_end;                    /* the lead's end-of-story mark */
static cell_t    s_panel[UI_RIBBON_CELLS];
static lv_obj_t *s_panel_hair[UI_RIBBON_CELLS];

static lv_obj_t *s_sec_vrule;                                   /* band 6 */
static story_t   s_sec;
static lv_obj_t *s_sec_end;                     /* and its end-of-story mark */
static lv_obj_t *s_rail_head, *s_rail_hair;
static holding_t s_rail[UI_RAIL_ROWS];

static lv_obj_t *s_tick_vrule;                                  /* band 7 */
static quote_t   s_tick[UI_TICKER_ROWS];
static lv_obj_t *s_tick_head[4], *s_tick_hair;
static lv_obj_t *s_brief_head, *s_brief_hair;
static brief_t   s_brief[UI_BRIEF_ROWS];

static char s_copy_lead[UI_LEAD_COLS][FP_COPY_MAX];
static char s_copy_cap[NEWS_CAPTION_MAX + 8];
static char s_head_lead[NEWS_HEADLINE_MAX + 4];
static char s_head_sec[NEWS_HEADLINE_MAX + 4];
static char s_head_brief[UI_BRIEF_ROWS][NEWS_HEADLINE_MAX + 4];
static char s_deck_sum[NEWS_DECK_MAX];

/* How many lines a headline slot has, from its height and its face, rather than
 * as a number written down twice. */
#define FP_LINES(h, f)  ((h) / lv_font_get_line_height(f))

/* Set a headline, broken the way a copy desk breaks one. */
static void set_head(lv_obj_t *l, int w, int h, const lv_font_t *f,
                     const char *src, char *buf, size_t n)
{
    ui_fit_balance(f, w, FP_LINES(h, f), src, buf, n);
    ui_set(l, buf);
}

/* --- the two coloured things ---------------------------------------------- */

/* One function for the whole sheet, and it is ui_internal.h's rather than this
 * file's, because the rule it applies is not local to A1.
 *
 * It answers UI_INK at zero — a flat session printed with a solid green
 * triangle asserts a rise that did not happen, and in a column the eye scans
 * for direction the reader counts it as a gainer — and UI_INK for every figure
 * on the sheet whenever the snapshot is stale or the board is offline. That
 * second half is the one worth spelling out: this page and the live one used to
 * differ by 52 px of the word STALE and nothing else, so twenty-one prices,
 * five index levels and sixteen percentages went on being printed in the colour
 * reserved for live movement while the top of the sheet said they were not.
 * Colour on this page is data; a figure the board cannot vouch for is not.
 *
 * The audit ui_internal.h describes is unchanged and is now shorter: UI_UP and
 * UI_DOWN appear in this file nowhere at all, and the two calls that can put
 * them on the glass — a text colour and a drawn mark — both read them from
 * here. */
static lv_color_t chg_colour(int32_t bp)
{
    return ui_chg_colour(bp);
}

/* The mark's direction, kept in the object rather than in a parallel array:
 * the draw callback runs long after the setter and has nothing else to read.
 * Zero means "no reading yet", which is how a row that has been hidden comes
 * back blank instead of pointing up at a figure it no longer has. */
/* FP_MARK_FLAT is the session that did not move. A change of +0.00% printed
 * with a solid green triangle beside it asserts a rise that did not happen, and
 * in a column the eye scans for direction that is worse than spending the mark
 * on nothing: the reader counts a flat name as a gainer. The FIGURE keeps §6's
 * colour rule — a flat session is not a loss — and the mark says flat, in ink,
 * because there is no third market colour on this panel and there should not
 * be one. */
#define FP_MARK_NONE    ((void *)0)
#define FP_MARK_UP      ((void *)1)
#define FP_MARK_DOWN    ((void *)2)
#define FP_MARK_FLAT    ((void *)3)
#define FP_FLAT_H         3

/* The mark is a square of half the box it sits in, centred. Deriving it from
 * the face's line height rather than pinning a size means the ribbon's mark and
 * the quotation table's mark are each in proportion to the figure beside them
 * without either being a number in this file. */
static void mark_draw_cb(lv_event_t *e)
{
    lv_obj_t   *o = lv_event_get_target_obj(e);
    lv_layer_t *L = lv_event_get_layer(e);
    void       *d = lv_obj_get_user_data(o);
    if (!L || d == FP_MARK_NONE) return;

    lv_area_t a;
    lv_obj_get_coords(o, &a);

    const int box  = lv_area_get_width(&a);
    const int side = box / 2;
    const int off  = (box - side) / 2;
    if (side <= 0) return;

    if (d == FP_MARK_FLAT) {
        const int y = a.y1 + (box - FP_FLAT_H) / 2;
        ui_draw_rect_c_abs(L, a.x1 + off, y, a.x1 + off + side - 1,
                           y + FP_FLAT_H - 1, true, 0, UI_INK);
        return;
    }

    ui_draw_tri_abs(L, a.x1 + off, a.y1 + off, side, side,
                    d == FP_MARK_UP,
                    chg_colour(d == FP_MARK_UP ? 1 : -1));
}

/* A square mark box, one line height on a side, so the figure that follows it
 * starts at a distance that scales with the face. */
static lv_obj_t *mark_create(int x, int y, const lv_font_t *f)
{
    const int box = lv_font_get_line_height(f);
    lv_obj_t *o = ui_pane(s_page, x, y, box, box);
    lv_obj_set_user_data(o, FP_MARK_NONE);
    lv_obj_add_event_cb(o, mark_draw_cb, LV_EVENT_DRAW_MAIN, NULL);
    return o;
}

static void mark_set(lv_obj_t *o, int32_t bp)
{
    if (!o) return;
    lv_obj_set_user_data(o, bp < 0 ? FP_MARK_DOWN
                          : bp > 0 ? FP_MARK_UP
                                   : FP_MARK_FLAT);
    ui_show(o, true);
    lv_obj_invalidate(o);
}

static void mark_clear(lv_obj_t *o)
{
    if (!o) return;
    lv_obj_set_user_data(o, FP_MARK_NONE);
    ui_show(o, false);
}

/* --- the picture ---------------------------------------------------------- */

/*
 * The device never resizes, tone-maps or dithers a photograph. The server sends
 * a tile already screened and packed at 4 bpp in the framebuffer's own nibble
 * order, w*h/2 bytes of it, and the only reason that is cheap is that it lands
 * on a slot of exactly its own size — so a descriptor whose dimensions are not
 * the slot's is refused here rather than scaled, because scaling an image that
 * has already been screened dithers it twice and comes out as confetti.
 *
 * Then the bytes have to actually be here. ui_tile.c fetches them and holds one
 * tile, and it is where the byte-count contract and the palette are checked.
 * What this function does with the answer is the whole of the layout decision:
 * a tile means a photograph across the measure with the story in two short legs
 * under it, and no tile means the well reverts to the shape it had before the
 * picture was widened — the chart in the left leg, or nothing there and both
 * legs run the well's full depth.
 *
 * A tile that fails to fetch is an ordinary front-page condition — a slow wire,
 * an id that went stale between the JSON and the GET — so the miss is not an
 * error path here, it is one of three normal shapes for band 5.
 *
 * WHY THE PICTURE IS AN RGB565 IMAGE AND NOT A memcpy
 * ---------------------------------------------------
 * The tile is already in the framebuffer's layout, so writing it into the
 * framebuffer would be a per-row copy. Nothing on this page writes the
 * framebuffer, though: LVGL renders RGB565 into a draw buffer and the flush
 * callback quantizes that into the panel's inks, one strip at a time, and a
 * page that reached around it would be racing the strip it is drawing into.
 *
 * So the picture goes through the renderer like everything else — and comes out
 * unchanged anyway, because ui_tile.c hands over each pixel as an EXACT palette
 * colour and the ordered dither leaves those alone at every position in its
 * matrix. The ink that reaches the glass is the ink the producer chose, byte for
 * byte; ui_tile.c proves it per tile rather than asserting it here. The picture
 * is not dithered twice, which is the property spec §8 is protecting.
 *
 * LVGL's image cache is off in both builds (LV_CACHE_DEF_SIZE 0), so re-pointing
 * one descriptor at a new buffer is enough. If it is ever turned on, this is the
 * line that needs an lv_image_cache_drop() beside it.
 */
static lv_image_dsc_t s_photo_dsc;

static bool ui_photo_blit(lv_obj_t *slot, const news_photo_t *p)
{
    if (!slot) return false;

    const bool addressable = p && p->id[0]
                          && p->w == UI_LEAD_VIS_W && p->h == UI_LEAD_VIS_H;
    const ui_tile_t *tile = addressable ? ui_tile_get(p->id, p->w, p->h) : NULL;

    /* Rewritten every update rather than only when the picture changes, and the
     * reason is worth the two lines it costs: the cache hands back the address
     * of its own one entry, so that pointer is the SAME for every tile it ever
     * holds — a "has it changed" test on it would compare equal across a
     * reload and leave this descriptor pointing into the buffer the cache has
     * just freed. What changes is what the entry contains, so that is what is
     * copied. Setting an unchanged source costs an invalidate; on a page that
     * only redraws when news_hash() moved, that is nothing. */
    if (tile) {
        s_photo_dsc.header.magic  = LV_IMAGE_HEADER_MAGIC;
        s_photo_dsc.header.cf     = LV_COLOR_FORMAT_RGB565;
        s_photo_dsc.header.w      = (uint32_t)tile->w;
        s_photo_dsc.header.h      = (uint32_t)tile->h;
        s_photo_dsc.header.stride = (uint32_t)tile->w * 2;
        s_photo_dsc.data          = (const uint8_t *)tile->px;
        s_photo_dsc.data_size     = (uint32_t)tile->w * (uint32_t)tile->h * 2;
        lv_image_set_src(slot, &s_photo_dsc);
    } else {
        /* NULL clears the source rather than just hiding the object: the bytes
         * the descriptor pointed at belong to a cache that has already freed
         * them, and a hidden object is not a promise that nothing will read it
         * again. */
        lv_image_set_src(slot, NULL);
    }

    ui_show(slot, tile != NULL);
    return tile != NULL;
}

/* --- small shared shapes -------------------------------------------------- */

/* Text in a row of fixed pitch sits on the row's centre line, not its top edge:
 * 25 px of pitch against an 18 px face leaves seven, and splitting them is what
 * keeps a figure off the hairline underneath it. */
static int row_inset(int row_h, const lv_font_t *f)
{
    return (row_h - lv_font_get_line_height(f)) / 2;
}

/* A caps label: fixed width, fixed height, tracked. Everything in bands 1, 3, 7
 * and 8 is one of these, and so is every kicker and every column head. */
static lv_obj_t *caps(int x, int y, int w, lv_text_align_t align, const char *txt)
{
    lv_obj_t *l = ui_lab_w(s_page, x, y, w, UI_F_LABEL, align, txt);
    ui_track(l, FP_TRACK);
    return l;
}

/* A body column. Copyfitted before it is set and therefore the one kind of
 * label on the page allowed to wrap: ui_fit_text has already refused any string
 * that would need a line this box does not have. */
static lv_obj_t *column(int x, int y, int w, int h, const lv_font_t *f)
{
    lv_obj_t *l = ui_lab_box(s_page, x, y, w, h, f, LV_TEXT_ALIGN_LEFT, "");
    ui_lab_wrap(l, h);
    return l;
}

/* How wide a photo credit actually sets, tracked, and never more than the
 * ceiling. Measured because the alternative is a reserved constant, and a
 * reserved constant is a promise about a string nobody has read: this one is
 * what the caption line is divided on, so being wrong about it costs the
 * caption the difference on every sheet. Zero for no credit at all, which is
 * how the caption comes to have the whole measure. */
static int cred_w(const char *txt)
{
    if (!txt || !txt[0]) return 0;

    lv_point_t sz;
    lv_text_get_size(&sz, txt, UI_F_LABEL, FP_TRACK, 0, LV_COORD_MAX,
                     LV_TEXT_FLAG_NONE);

    /* One tracking step back on: LVGL measures the letter-spaces BETWEEN
     * glyphs, and the box has to hold the one the last glyph is drawn with. */
    const int w = (int)sz.x + FP_TRACK;
    return w > UI_LEAD_CRED_MAX_W ? UI_LEAD_CRED_MAX_W : w;
}

/* --- an index cell --------------------------------------------------------
 * Band 4's ribbon is ui_news.c's; this is the same shape at the size a headline
 * is set in, for the lead well on a day that brought no stories. */

static void set_cell(cell_t *c, const news_quote_t *q)
{
    if (!q) {
        ui_set(c->name, "");
        ui_set(c->value, "");
        ui_set(c->chg, "");
        mark_clear(c->mark);
        ui_show(c->spark, false);
        return;
    }

    char buf[24];
    ui_set(c->name, q->name[0] ? q->name : q->symbol);
    ui_money(buf, sizeof buf, q->last_c);
    ui_set(c->value, buf);
    ui_pct(buf, sizeof buf, q->chg_bp);
    ui_set(c->chg, buf);
    lv_obj_set_style_text_color(c->chg, chg_colour(q->chg_bp), 0);
    mark_set(c->mark, q->chg_bp);

    const bool spark = q->spark_n > 0;
    if (spark) ui_chart_set_spark(c->spark, q->spark, q->spark_n);
    ui_show(c->spark, spark);
}

/* --- band 5: the lead well ------------------------------------------------
 * The first band this file owns, and the first thing it draws: everything above
 * y=313 is furniture and belongs to ui_news.c.
 *
 * The headline runs the full measure and so does the photograph; the story sets
 * in two legs of 558 under it. Both legs are built at the same measure and at
 * the depth the well has with no picture in it, because that is the deeper of
 * the two shapes and a leg is only ever moved UP and shortened from here —
 * which is what "the story reflows without the photo" means in objects rather
 * than in prose.
 *
 * The two rules this file draws — band 5's at y=1108 and band 6's at y=1298 —
 * are its own precisely because one of them is conditional: a lead promoted
 * over the secondary row must not have a rule through the middle of it. The
 * hairline the folio hangs from is ui_news.c's for the opposite reason. */
static void build_lead(void)
{
    s_lead_kicker = caps(UI_LEAD_X, UI_LEAD_KICKER_Y, UI_LEAD_W,
                         LV_TEXT_ALIGN_LEFT, "");

    s_lead_head = ui_lab_box(s_page, UI_LEAD_X, UI_LEAD_HEAD_Y,
                             UI_LEAD_W, UI_LEAD_HEAD_H,
                             UI_F_LEAD, LV_TEXT_ALIGN_LEFT, "");
    s_lead_deck = ui_lab_box(s_page, UI_LEAD_X, UI_LEAD_DECK_Y,
                             UI_LEAD_DECK_W, UI_LEAD_DECK_H,
                             UI_F_DECK, LV_TEXT_ALIGN_LEFT, "");
    s_lead_byline = caps(UI_LEAD_X, UI_LEAD_BYLINE_Y, UI_LEAD_DECK_W,
                         LV_TEXT_ALIGN_LEFT, "");

    s_lead_hair = ui_rule(s_page, UI_LEAD_X, UI_LEAD_HAIR_Y,
                          UI_LEAD_W, UI_RULE_HAIR);

    /* The picture slot. An image object rather than a pane with a draw
     * callback: a pane would have to blit inside LV_EVENT_DRAW_MAIN, which runs
     * while the draw tasks for this refresh are still being built and not while
     * they are being executed, so the photograph would be laid down first and
     * painted over by everything queued after it. lv_image goes through the same
     * queue as the type does.
     *
     * Its size is set explicitly even though an image sizes itself to its
     * source: a slot whose geometry depends on what arrived is a slot the
     * simulator cannot assert on, and a tile that is not exactly 1140 x 360 has
     * already been refused by then. */
    s_lead_photo = lv_image_create(s_page);
    lv_obj_remove_style_all(s_lead_photo);
    lv_obj_remove_flag(s_lead_photo, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_remove_flag(s_lead_photo, LV_OBJ_FLAG_CLICKABLE);
    lv_obj_set_pos(s_lead_photo, UI_LEAD_VIS_X, UI_LEAD_SPLIT_Y);
    lv_obj_set_size(s_lead_photo, UI_LEAD_VIS_W, UI_LEAD_VIS_H);

    /* The chart is not the photograph's slot at a different size, it is the
     * other shape of the well: the left leg, run to the foot. A chart 1140 wide
     * and 360 tall would be a banner, and the story would have nowhere to go
     * but under it in two six-line legs — which is a lot of page spent on the
     * one visual the device draws itself and can draw at any size. */
    s_lead_chart = ui_chart_create(s_page, UI_LEAD_COL_X(0), UI_LEAD_SPLIT_Y,
                                   UI_LEAD_COL_W, UI_LEAD_BODY_H);

    /* The visual's edge, and it is four rules rather than a ui_frame() for two
     * reasons: a frame is filled white and would paint over the halftone it is
     * supposed to outline, and the four rules are created AFTER the image so
     * they print on top of it rather than under it.
     *
     * They sit on the tile's own outermost rows and columns, INSIDE the slot,
     * not around it — a box at x=29 would cross the 30 px margin. A halftone
     * with no border has no edges at all: an open sky screens to bare paper and
     * the picture dissolves into the page, which reads as a printing fault
     * rather than as a photograph. A hairline box around a halftone is standard
     * broadsheet practice and it is what gives the top of this one a top.
     *
     * They are placed rather than pinned, because the two visuals are not the
     * same box: edge_box() moves them onto whichever one is showing. */
    for (int i = 0; i < 4; i++) {
        s_lead_edge[i] = i < 2
                       ? ui_rule(s_page, UI_LEAD_VIS_X, UI_LEAD_SPLIT_Y,
                                 UI_LEAD_VIS_W, UI_RULE_HAIR)
                       : ui_vrule(s_page, UI_LEAD_VIS_X, UI_LEAD_SPLIT_Y,
                                  UI_LEAD_VIS_H, UI_RULE_HAIR);
    }

    /* A caption is a sentence under a photograph, not a UI string, so it is
     * UNTRACKED: +2 px a character on running lower case wastes a fifth of the
     * measure and reads letter by letter. The credit is its own right-aligned
     * slot, tracked because it IS caps. */
    /* Both boxes are built at the widest they can ever be and cut down by
     * set_lead(), which is the one moment the credit's own string is in hand.
     * See UI_LEAD_CRED_MAX_W: the split between them is a measurement, not a
     * constant, because the constant it replaces was inherited from a
     * photograph half this width. */
    s_lead_cap  = ui_lab_w(s_page, UI_LEAD_VIS_X, UI_LEAD_CAP_Y, UI_LEAD_VIS_W,
                           UI_F_LABEL, LV_TEXT_ALIGN_LEFT, "");
    s_lead_cred = caps(UI_LEAD_VIS_X + UI_LEAD_VIS_W - UI_LEAD_CRED_MAX_W,
                       UI_LEAD_CAP_Y, UI_LEAD_CRED_MAX_W,
                       LV_TEXT_ALIGN_RIGHT, "");

    /* The last leg is the narrow one: it is the leg the story ends in, and
     * UI_LEAD_LEG_W is what the end mark's column costs it. */
    for (int i = 0; i < UI_LEAD_COLS; i++) {
        s_lead_body[i] = column(UI_LEAD_COL_X(i), UI_LEAD_SPLIT_Y,
                                i == UI_LEAD_COLS - 1 ? UI_LEAD_LEG_W
                                                      : UI_LEAD_COL_W,
                                UI_LEAD_BODY_H, UI_F_BODY_LG);
    }

    /* The square that closes the story. Placed by set_lead_body(), which is
     * where the copy that decides which line is the last one is settled. */
    s_lead_end = ui_fill(s_page, UI_LEAD_COL_X(UI_LEAD_COLS - 1), UI_LEAD_SPLIT_Y,
                         UI_END_SIDE, UI_END_SIDE);

    /* The rule down the well's gutter — see UI_LEAD_VRULE_X. */
    s_lead_vrule = ui_vrule(s_page, UI_LEAD_VRULE_X, UI_LEAD_SPLIT_Y,
                            UI_LEAD_BODY_H, UI_RULE_HAIR);

    /* Kept in a handle rather than drawn and forgotten. A rule is the boundary
     * between two bands, and on the sheet with no snapshot at all BOTH bands
     * are empty — so what the reader saw was a masthead, an italic "Loading..."
     * and then two full-width rules cutting 1,200 px of bare paper into three
     * empty boxes. That is the one composition on this board nobody could
     * mistake for a newspaper, and it is a state the frame really sits in:
     * boot, a dropped link, a DNS failure. A band with nothing in it takes its
     * rule with it. */
    s_lead_rule = ui_rule(s_page, UI_CONTENT_X, UI_LEAD_RULE_Y,
                          UI_CONTENT_W, UI_LEAD_RULE_W);
}

/* The hairline box, moved onto whichever visual is showing. Two rules across
 * and two down, on the box's own outermost rows and columns. */
static void edge_box(int x, int y, int w, int h)
{
    lv_obj_set_pos(s_lead_edge[0], x, y);
    lv_obj_set_width(s_lead_edge[0], w);
    lv_obj_set_pos(s_lead_edge[1], x, y + h - UI_RULE_HAIR);
    lv_obj_set_width(s_lead_edge[1], w);
    lv_obj_set_pos(s_lead_edge[2], x, y);
    lv_obj_set_height(s_lead_edge[2], h);
    lv_obj_set_pos(s_lead_edge[3], x + w - UI_RULE_HAIR, y);
    lv_obj_set_height(s_lead_edge[3], h);
}

/* The well's two shapes, in the only three objects that move between them: the
 * legs and the rule between them start under the photograph when there is one
 * and at the split when there is not. Positioned rather than built twice — a
 * second pair of body labels would be a second pair to blank, and the failure
 * that hides in that is the pair nobody blanked. */
static void lead_layout(bool photo)
{
    const int y = FP_LEG_Y(photo);
    const int h = FP_LEG_H(photo);

    for (int i = 0; i < UI_LEAD_COLS; i++) {
        lv_obj_set_pos(s_lead_body[i], UI_LEAD_COL_X(i), y);
        ui_lab_wrap(s_lead_body[i], h);
    }
    lv_obj_set_pos(s_lead_vrule, UI_LEAD_VRULE_X, y);
    lv_obj_set_height(s_lead_vrule, h);
}

/* The end-of-story square, on the last line a box actually set.
 *
 * One measurement and no second opinion about the copy: the text is the string
 * that has already been fitted, `w` is the measure it was fitted to — the one
 * with UI_END_MEASURE's column taken out — and the height it sets at, divided
 * by the face's, is which line the mark belongs on. LVGL rounds an ellipsis
 * down to a whole line, so clamping to the lines the box can show is exact
 * rather than approximate.
 *
 * `right` is the edge the mark hangs from, and it is the FULL measure's rather
 * than the text's: the square lines up with the rules, the photograph and the
 * headline above it, in the column no line of the copy can reach. */
static void end_mark(lv_obj_t *m, const char *txt, const lv_font_t *f,
                     int right, int y, int w, int h)
{
    const int lh = lv_font_get_line_height(f);
    if (!txt || !txt[0] || lh <= 0 || h < lh) { ui_show(m, false); return; }

    lv_point_t sz;
    lv_text_get_size(&sz, txt, f, 0, 0, (int32_t)w, LV_TEXT_FLAG_NONE);

    const int max = h / lh;
    int lines = (int)((sz.y + lh - 1) / lh);
    if (lines < 1)   lines = 1;
    if (lines > max) lines = max;

    lv_obj_set_pos(m, right - UI_END_SIDE,
                   y + (lines - 1) * lh + (lh - UI_END_SIDE) / 2);
    ui_show(m, true);
}

/* The lead well with no lead in it: the same five indices as band 4, one to a
 * row and set at the size the rest of the page gives a headline. A day with no
 * stories is a quiet day, not a broken feed, and a markets page is what a paper
 * prints on one. */
static void build_panel(void)
{
    const int mark_box = lv_font_get_line_height(UI_F_HEADLINE);
    const int value_y  = lv_font_get_line_height(UI_F_LABEL);
    const int chg_y    = value_y + (lv_font_get_line_height(UI_F_LEAD)
                                    - mark_box) / 2;

    for (int i = 0; i < UI_RIBBON_CELLS; i++) {
        cell_t *c = &s_panel[i];
        const int y = FP_PANEL_ROW_Y(i);

        c->name  = caps(UI_LEAD_X, y, UI_MEASURE_LG_W, LV_TEXT_ALIGN_LEFT, "");
        c->value = ui_lab_w(s_page, UI_LEAD_X, y + value_y, UI_MEASURE_LG_W,
                            UI_F_LEAD, LV_TEXT_ALIGN_LEFT, "");
        c->mark  = mark_create(FP_PANEL_CHG_X, y + chg_y, UI_F_HEADLINE);
        c->chg   = ui_lab_w(s_page, FP_PANEL_CHG_X + mark_box, y + chg_y,
                            FP_PANEL_CHG_W - mark_box, UI_F_HEADLINE,
                            LV_TEXT_ALIGN_LEFT, "");
        c->spark = ui_chart_create(s_page, FP_PANEL_SPARK_X,
                                   y + FP_PANEL_SPARK_DY,
                                   FP_PANEL_SPARK_W, FP_PANEL_SPARK_H);

        /* Between the rows, not under the last one: the heavy rule at the foot
         * of the well is already there and a hairline four pixels above it
         * reads as a printing fault. */
        s_panel_hair[i] = ui_rule(s_page, UI_LEAD_X, y + FP_PANEL_ROW_H - 1,
                                  UI_LEAD_W, UI_RULE_HAIR);
    }
}

/* --- the lead a quiet day gets --------------------------------------------
 *
 * A day that brings figures and no stories is a real day, and the sheet used to
 * print it as five large numbers under a blackletter nameplate: no kicker, no
 * headline, no deck, no byline and not one line of prose anywhere on the page.
 * That is a dashboard wearing a newspaper's hat, and it is the composition that
 * gives the whole conceit away — a paper with nothing to report still writes a
 * lead about the market, because on that day the market is what happened.
 *
 * So the board writes one, and it is the only sentence on this sheet the DEVICE
 * is the author of. Which is why it is fenced in as tightly as it is: the
 * copy is in ui_strings.h, there are four headlines and two decks and no fifth
 * of either, every one of them is a statement about the figures printed
 * directly underneath it, and none of them offers a reason, a forecast or an
 * opinion. The arithmetic is a count of which way the indices went and two
 * arg-maxes over the same array. There is no byline, because there is no
 * writer, and inventing one would be the first outright lie on the page.
 *
 * The headline goes through set_head() like every other headline here, so it is
 * broken by ui_fit_balance rather than greedily — the composed sentences are
 * the length that breaks worst under a greedy fill.
 */
static const char *quote_name(const news_quote_t *q)
{
    return q->name[0] ? q->name : q->symbol;
}

static int32_t bp_abs(int32_t bp)
{
    return bp < 0 ? -bp : bp;
}

/* Which index led, which trailed, and which moved furthest either way. Three
 * arg-maxes over at most five, in one pass, because every sentence below is
 * built out of some pair of them. */
typedef struct { int best, worst, wide, up, down; } session_t;

static session_t session_of(const news_t *v)
{
    session_t s = { 0, 0, 0, 0, 0 };

    for (int i = 0; i < v->index_count; i++) {
        const int32_t bp = v->indices[i].chg_bp;

        if (bp > 0)      s.up++;
        else if (bp < 0) s.down++;

        if (bp > v->indices[s.best].chg_bp)  s.best  = i;
        if (bp < v->indices[s.worst].chg_bp) s.worst = i;
        if (bp_abs(bp) > bp_abs(v->indices[s.wide].chg_bp)) s.wide = i;
    }
    return s;
}

/* Four shapes of session and one sentence each. "Broad" is the right word at
 * any count the ribbon can hold, which is what lets the same line serve a
 * morning with five indices and one with two; the mixed case names the WIDEST
 * move rather than the best or the worst, because on a split day the largest
 * number is the one the page is about. */
static void summary_head(const news_t *v, char *out, size_t n)
{
    const session_t s = session_of(v);

    if (s.up > 0 && s.down == 0)
        snprintf(out, n, S_SUMMARY_UP, quote_name(&v->indices[s.best]));
    else if (s.down > 0 && s.up == 0)
        snprintf(out, n, S_SUMMARY_DOWN, quote_name(&v->indices[s.worst]));
    else if (s.up == 0 && s.down == 0)
        snprintf(out, n, "%s", S_SUMMARY_FLAT);
    else
        snprintf(out, n, S_SUMMARY_MIXED, quote_name(&v->indices[s.wide]));
}

/* The deck says the one thing the panel below makes the reader scan five rows
 * for: the two ends of the day. Stated as a range rather than as a ranking, so
 * that it stays true when every index fell — "ran from" is about order, and
 * "led" would be about merit. */
static void summary_deck(const news_t *v, char *out, size_t n)
{
    const session_t s = session_of(v);
    char hi[16], lo[16];

    ui_pct(hi, sizeof hi, v->indices[s.best].chg_bp);
    ui_pct(lo, sizeof lo, v->indices[s.worst].chg_bp);

    if (v->index_count > 1) {
        snprintf(out, n, S_SUMMARY_DECK,
                 quote_name(&v->indices[s.best]),  hi,
                 quote_name(&v->indices[s.worst]), lo);
    } else {
        snprintf(out, n, S_SUMMARY_DECK_ONE, quote_name(&v->indices[s.best]), hi);
    }
}

static void set_summary(const news_t *v)
{
    char head[NEWS_HEADLINE_MAX];

    summary_head(v, head, sizeof head);
    summary_deck(v, s_deck_sum, sizeof s_deck_sum);

    ui_set(s_lead_kicker, S_SUMMARY_KICKER);
    set_head(s_lead_head, UI_LEAD_W, UI_LEAD_HEAD_H, UI_F_LEAD,
             head, s_head_lead, sizeof s_head_lead);
    ui_set(s_lead_deck, s_deck_sum);
}

/* The top of the well — kicker, headline, deck, and the hairline that closes
 * them — and it is its own call because BOTH of band 5's shapes print it. A
 * lead story fills it from the payload; a day that brought no stories fills it
 * from the figures, which is what set_summary() above is. Splitting it out is
 * what lets the panel below be a different thing from the type above it without
 * either owning the other's widgets. */
static void show_well_head(bool on)
{
    ui_show(s_lead_kicker, on);
    ui_show(s_lead_head, on);
    ui_show(s_lead_deck, on);
    ui_show(s_lead_hair, on);
}

/* And everything under that hairline that belongs to a STORY: the byline, the
 * visual, the legs, the rule between them and the square that closes them. A
 * market summary has none of these — it has no author, no picture and no
 * second paragraph — so this is the half that goes away on a quiet day. */
static void show_lead_story(bool on)
{
    ui_show(s_lead_byline, on);
    ui_show(s_lead_vrule, on);
    if (!on) {
        ui_show(s_lead_photo, false);
        ui_show(s_lead_chart, false);
        ui_show(s_lead_cap, false);
        ui_show(s_lead_cred, false);
        ui_show(s_lead_end, false);
        for (int i = 0; i < UI_LEAD_COLS; i++) ui_show(s_lead_body[i], false);
        for (int i = 0; i < 4; i++) ui_show(s_lead_edge[i], false);
    }
}

static void show_panel(bool on)
{
    for (int i = 0; i < UI_RIBBON_CELLS; i++) {
        ui_show(s_panel[i].name, on);
        ui_show(s_panel[i].value, on);
        ui_show(s_panel[i].chg, on);
        ui_show(s_panel_hair[i], on && i + 1 < UI_RIBBON_CELLS);
        if (!on) {
            mark_clear(s_panel[i].mark);
            ui_show(s_panel[i].spark, false);
        }
    }
}

/* Two legs of 53 characters, or one of 53 with the chart beside it. The second
 * leg starts at the byte the first stopped on, which is the whole reason
 * ui_fit_text returns a count rather than a boolean: a story set in two legs
 * must read down the first and continue at the top of the second, with nothing
 * repeated and nothing dropped but the space at the join. */
/* How tall the FIRST of two columns should be, so that the two end level.
 *
 * Filling column one to the band and letting column two take what is left is
 * right when the story overruns both and wrong when it does not: a 940-byte
 * body across two 14-line columns gives fourteen lines and two, and the second
 * column is 300 px of bare paper beside a full one — which on a front page
 * reads as a column that failed to print. A press balances them.
 *
 * One measurement: how many lines the whole body needs at this measure. Half of
 * them, rounded up, is the first column. Capped at the band, where the story
 * overruns and the greedy answer is the right one again. */
static int split_h(const char *body, int w, int h, const lv_font_t *f)
{
    const int lh = lv_font_get_line_height(f);
    if (lh <= 0) return h;

    lv_point_t sz;
    lv_text_get_size(&sz, body, f, 0, 0, (int32_t)w, LV_TEXT_FLAG_NONE);

    const int max   = h / lh;
    const int lines = (int)((sz.y + lh - 1) / lh);
    int first = (lines + 1) / 2;

    if (first > max) first = max;
    if (first < 1)   first = 1;
    return first * lh;
}

/* Each leg is copyfitted to its OWN measure, and the last one's is narrower by
 * the column the end mark stands in. Whatever does not fit is dropped, which is
 * the whole of the policy: this paper has two pages, the second is a quotation
 * table, so there is nowhere for a story to be continued to and a "Continued on
 * A2" would be a lie set in italic. The square is what says so.
 *
 * It is shown only when the leg it closes has type in it. A square alone at the
 * foot of an empty column is not an end mark, it is a speck. */
static void set_lead_body(const char *body, bool two_col, int y, int h)
{
    size_t used = 0;

    if (two_col) {
        const int h0 = split_h(body, UI_LEAD_COL_W, h, UI_F_BODY_LG);
        used = ui_fit_text(UI_F_BODY_LG, UI_LEAD_COL_W, h0, 0,
                           body, s_copy_lead[0], sizeof s_copy_lead[0]);
        ui_set(s_lead_body[0], s_copy_lead[0]);
    }
    ui_show(s_lead_body[0], two_col);

    ui_fit_text(UI_F_BODY_LG, UI_LEAD_LEG_W, h, 0,
                body + used, s_copy_lead[1], sizeof s_copy_lead[1]);
    ui_set(s_lead_body[1], s_copy_lead[1]);
    ui_show(s_lead_body[1], true);

    end_mark(s_lead_end, s_copy_lead[1], UI_F_BODY_LG, UI_CONTENT_R,
             y, UI_LEAD_LEG_W, h);
}

/* The whole of the layout decision, and it is one question asked once: did the
 * tile arrive?
 *
 * With it, the photograph runs the measure and the story sets in two short legs
 * under it. Without it the well reverts — the chart in the left leg at the
 * well's full depth, the story beside it, or, with no chart either, both legs
 * run deep and the story balances across them. The left leg is the one that
 * changes hands, which is why both were built at the same measure. */
static void set_lead(const news_story_t *st)
{
    ui_set(s_lead_kicker, st->kicker);
    set_head(s_lead_head, UI_LEAD_W, UI_LEAD_HEAD_H, UI_F_LEAD,
             st->headline, s_head_lead, sizeof s_head_lead);
    ui_set(s_lead_deck, st->deck);
    ui_set(s_lead_byline, st->byline);

    const bool photo = ui_photo_blit(s_lead_photo, &st->photo);
    const bool chart = !photo && st->chart.kind != CHART_NONE;

    if (chart) ui_chart_set(s_lead_chart, &st->chart);
    ui_show(s_lead_chart, chart);

    if (photo) edge_box(UI_LEAD_VIS_X, UI_LEAD_SPLIT_Y,
                        UI_LEAD_VIS_W, UI_LEAD_VIS_H);
    else if (chart) edge_box(UI_LEAD_COL_X(0), UI_LEAD_SPLIT_Y,
                             UI_LEAD_COL_W, UI_LEAD_BODY_H);
    for (int i = 0; i < 4; i++) ui_show(s_lead_edge[i], photo || chart);

    lead_layout(photo);

    /* A caption belongs to a picture. Under an empty slot, or under a chart
     * that has its own labels, it is a line of text about something that is not
     * there.
     *
     * The line's two slots are divided by MEASURING the credit, and the reason
     * is that the alternative had stopped being a measurement of anything: the
     * credit's 130 px was chosen when this line ran under a 558 px photograph,
     * "DEMO IMAGE" sets 110 of it in tracked label_14, and the caption was
     * paying the difference every sheet for paper that could never be printed
     * on. The picture is the full measure now, so the split is derived against
     * the full measure — the credit takes what its own string needs and the
     * caption takes the rest, which is what stops a long caption from being cut
     * to protect a short credit.
     *
     * The cut is made HERE rather than by ui_lab_w()'s ellipsis, because LVGL's
     * ellipsis lands wherever the pixel ran out — "where the quarter was sign…"
     * — and a caption that breaks inside a word reads as a fault. ui_fit_text
     * cuts on a word, and the ellipsis is added only when there was something
     * left to cut. FP_CAP_ELLIPSIS is the room the ellipsis itself needs. */
    const int cw   = photo ? cred_w(st->photo.credit) : 0;
    const int capw = UI_LEAD_VIS_W - (cw > 0 ? cw + UI_LEAD_CAP_GAP : 0);

    if (photo && st->photo.caption[0]) {
        const size_t used = ui_fit_text(UI_F_LABEL, capw - FP_CAP_ELLIPSIS,
                                        lv_font_get_line_height(UI_F_LABEL), 0,
                                        st->photo.caption,
                                        s_copy_cap, sizeof s_copy_cap - 4);
        if (st->photo.caption[used] != '\0') {
            const size_t at = strlen(s_copy_cap);
            memcpy(s_copy_cap + at, "\xE2\x80\xA6", 4);   /* U+2026 */
        }
        ui_set(s_lead_cap, s_copy_cap);
    } else {
        ui_set(s_lead_cap, "");
    }
    lv_obj_set_width(s_lead_cap, capw);

    if (cw > 0) {
        lv_obj_set_pos(s_lead_cred, UI_LEAD_VIS_X + UI_LEAD_VIS_W - cw,
                       UI_LEAD_CAP_Y);
        lv_obj_set_width(s_lead_cred, cw);
    }
    ui_set(s_lead_cred, cw > 0 ? st->photo.credit : "");
    ui_show(s_lead_cap, photo);
    ui_show(s_lead_cred, cw > 0);

    set_lead_body(st->body, !chart, FP_LEG_Y(photo), FP_LEG_H(photo));
}

/* --- band 6: one story, and the portfolio ---------------------------------
 * A kicker, a headline and a deck, and then the band is over. There is no body
 * and no hairline over one, because 176 px does not hold a headline and a
 * readable leg both — and a story that shows four lines and stops mid-clause is
 * worse than one that never promised them. Below the fold, a paper runs plenty
 * of stories that are a head and a deck. */

static void build_second(void)
{
    s_sec.kicker = caps(UI_SECOND_X, UI_SECOND_KICKER_Y, UI_SECOND_W,
                        LV_TEXT_ALIGN_LEFT, "");
    s_sec.head   = ui_lab_box(s_page, UI_SECOND_X, UI_SECOND_HEAD_Y,
                              UI_SECOND_W, UI_SECOND_HEAD_H,
                              UI_F_HEADLINE, LV_TEXT_ALIGN_LEFT, "");
    /* UI_SECOND_DECK_W, not UI_SECOND_W: the deck gives up the outer 17 px of
     * its measure so the end mark has a column to stand in on whichever line
     * turns out to be the last. */
    s_sec.deck   = ui_lab_box(s_page, UI_SECOND_X, UI_SECOND_DECK_Y,
                              UI_SECOND_DECK_W, UI_SECOND_DECK_H,
                              UI_F_DECK, LV_TEXT_ALIGN_LEFT, "");
    s_sec_end    = ui_fill(s_page, UI_SECOND_X + UI_SECOND_W - UI_END_SIDE,
                           UI_SECOND_DECK_Y, UI_END_SIDE, UI_END_SIDE);

    s_sec_vrule = ui_vrule(s_page, UI_SECOND_VRULE_X, UI_SECOND_Y,
                           UI_SECOND_H, UI_RULE_HAIR);

    s_second_rule = ui_rule(s_page, UI_CONTENT_X, UI_SECOND_RULE_Y,
                            UI_CONTENT_W, UI_SECOND_RULE_W);
}

static void show_story(bool on)
{
    ui_show(s_sec.kicker, on);
    ui_show(s_sec.head, on);
    ui_show(s_sec.deck, on);
    if (!on) ui_show(s_sec_end, false);
}

static void set_second(const news_story_t *st)
{
    ui_set(s_sec.kicker, st->kicker);
    set_head(s_sec.head, UI_SECOND_W, UI_SECOND_HEAD_H, UI_F_HEADLINE,
             st->headline, s_head_sec, sizeof s_head_sec);
    ui_set(s_sec.deck, st->deck);

    show_story(true);

    /* The deck is this story's last element — there is no body under it — so
     * the deck is what the mark closes. A story with no deck gets none: its
     * last element is then the headline, and a headline is not a thing an end
     * mark closes. That item is a brief, and briefs do not carry one. */
    end_mark(s_sec_end, st->deck, UI_F_DECK, UI_SECOND_X + UI_SECOND_W,
             UI_SECOND_DECK_Y, UI_SECOND_DECK_W, UI_SECOND_DECK_H);
}

static void build_rail(void)
{
    const int mark_box = lv_font_get_line_height(UI_F_LABEL);
    const int inset    = row_inset(UI_RAIL_ROW_H, UI_F_LABEL);

    s_rail_head = caps(UI_RAIL_X, UI_RAIL_HEAD_Y, UI_RAIL_W,
                       LV_TEXT_ALIGN_LEFT, S_PORTFOLIO);
    s_rail_hair = ui_rule(s_page, UI_RAIL_X, UI_RAIL_HAIR_Y,
                          UI_RAIL_W, UI_RULE_HAIR);

    for (int i = 0; i < UI_RAIL_ROWS; i++) {
        holding_t *h = &s_rail[i];
        const int y = UI_RAIL_ROW_Y + i * UI_RAIL_ROW_H;

        h->sym  = ui_lab_w(s_page, UI_RAIL_X, y + inset, UI_TICKER_SYM_W,
                           UI_F_LABEL, LV_TEXT_ALIGN_LEFT, "");
        h->name = ui_lab_w(s_page, UI_RAIL_X, y + inset, UI_TICKER_NAME_W,
                           UI_F_LABEL, LV_TEXT_ALIGN_LEFT, "");
        h->last = ui_lab_w(s_page, UI_RAIL_X, y + inset, UI_TICKER_LAST_W,
                           UI_F_LABEL, LV_TEXT_ALIGN_RIGHT, "");
        h->mark = mark_create(UI_RAIL_X, y + inset, UI_F_LABEL);
        h->chg  = ui_lab_w(s_page, UI_RAIL_X + mark_box, y + inset,
                           UI_TICKER_CHG_W - mark_box, UI_F_LABEL,
                           LV_TEXT_ALIGN_RIGHT, "");
        h->spark = ui_chart_create(s_page, UI_RAIL_X, y, UI_RAIL_SPARK_W,
                                   UI_RAIL_SPARK_H);
    }
}

/* The rail's fields are the quotation table's own, at the quotation table's own
 * widths and IN THE QUOTATION TABLE'S OWN ORDER, so a holding in the rail and
 * the same holding in the table below read as one kind of line rather than as
 * two that nearly agree: symbol, name, last, change, and the shape of the
 * session outermost.
 *
 * THE FIELDS PACK LEFT AND THE LEFTOVER GOES TO THE SHAPE. They used to pack
 * from both ends — the symbol at the left margin, the change pinned to the
 * right one, and the name given everything in between — which is correct at the
 * rail's own 558 and indefensible at the 1140 it takes when there is no second
 * story: the name field went to 776 px, "Nvidia" set 46 of them, and every row
 * on the sheet carried an 800 px river between a company and its own price, six
 * rows running. A1 was printing the identical fault A2's quotation rows had
 * just been fixed for, and it is the same fix: a text field is not improved by
 * being handed width it has no text to put in.
 *
 * So the name is capped at the table's own NAME width and the arithmetic
 * decides what happens to the rest, rather than a rule written down twice. At
 * 558 the four fixed fields and three gaps leave 194, the name takes all of it
 * (which is the layout this rail has always had, unchanged to the pixel), and
 * there is nothing left for a shape. At 1140 the name takes 230 and the 538 that
 * remain are a sparkline in the outermost column — the same series the table
 * below draws, at the same 16 px, on the row's own centre line.
 *
 * Returns that width, or 0 for a rail with no room for one, because whether the
 * column exists is the geometry's answer and set_rail() must not arrive at it a
 * second time. */
static int rail_layout(int x, int w)
{
    const int mark_box = lv_font_get_line_height(UI_F_LABEL);
    const int inset    = row_inset(UI_RAIL_ROW_H, UI_F_LABEL);

    const int room   = w - UI_TICKER_SYM_W - UI_TICKER_LAST_W - UI_TICKER_CHG_W
                     - 3 * UI_TICKER_FIELD_GAP;
    const int name_w = room < UI_TICKER_NAME_W ? room : UI_TICKER_NAME_W;

    const int name_x  = x + UI_TICKER_SYM_W + UI_TICKER_FIELD_GAP;
    const int last_x  = name_x + name_w + UI_TICKER_FIELD_GAP;
    const int chg_x   = last_x + UI_TICKER_LAST_W + UI_TICKER_FIELD_GAP;
    const int spark_x = chg_x + UI_TICKER_CHG_W + UI_TICKER_FIELD_GAP;
    const int spark_w = x + w - spark_x;
    const int spark   = spark_w >= UI_RAIL_SPARK_MIN ? spark_w : 0;

    lv_obj_set_pos(s_rail_head, x, UI_RAIL_HEAD_Y);
    lv_obj_set_width(s_rail_head, w);
    lv_obj_set_pos(s_rail_hair, x, UI_RAIL_HAIR_Y);
    lv_obj_set_width(s_rail_hair, w);

    for (int i = 0; i < UI_RAIL_ROWS; i++) {
        holding_t *h = &s_rail[i];
        const int row = UI_RAIL_ROW_Y + i * UI_RAIL_ROW_H;
        const int y   = row + inset;

        lv_obj_set_pos(h->sym, x, y);
        lv_obj_set_pos(h->name, name_x, y);
        lv_obj_set_width(h->name, name_w > 0 ? name_w : UI_TICKER_NAME_W);
        ui_show(h->name, name_w > 0);
        lv_obj_set_pos(h->last, last_x, y);
        lv_obj_set_pos(h->mark, chg_x, y);
        lv_obj_set_pos(h->chg, chg_x + mark_box, y);
        lv_obj_set_pos(h->spark, spark_x, row + UI_RAIL_SPARK_DY);
        lv_obj_set_width(h->spark, spark > 0 ? spark : UI_RAIL_SPARK_W);
        if (spark == 0) ui_show(h->spark, false);
    }
    return spark;
}

/* Six holdings and nothing under them. The rail carried a chart of its top
 * position until band 6 shrank to 176 px, and the six rows are what that height
 * holds at the quotation table's pitch: there is no room left, and the honest
 * thing to drop is the chart rather than two of the owner's positions. The
 * shape of the top holding is not lost either — it is a sparkline in the table
 * below, on the same symbol. */
static void set_rail(const news_t *v, int spark_w)
{
    char buf[24];

    ui_show(s_rail_head, v->ticker_count > 0);
    ui_show(s_rail_hair, v->ticker_count > 0);

    for (int i = 0; i < UI_RAIL_ROWS; i++) {
        holding_t *h = &s_rail[i];
        if (i >= v->ticker_count) {
            ui_set(h->sym, "");
            ui_set(h->name, "");
            ui_set(h->last, "");
            ui_set(h->chg, "");
            mark_clear(h->mark);
            ui_show(h->spark, false);
            continue;
        }

        const news_quote_t *q = &v->tickers[i];
        ui_set(h->sym, q->symbol);
        ui_set(h->name, q->name);
        ui_money(buf, sizeof buf, q->last_c);
        ui_set(h->last, buf);
        ui_pct(buf, sizeof buf, q->chg_bp);
        ui_set(h->chg, buf);
        lv_obj_set_style_text_color(h->chg, chg_colour(q->chg_bp), 0);
        mark_set(h->mark, q->chg_bp);

        /* Two conditions and they are different questions: is there a column
         * for a shape, which rail_layout() answered, and did this holding send
         * a series, which the payload did. */
        const bool spark = spark_w > 0 && q->spark_n > 0;
        if (spark) ui_chart_set_spark(h->spark, q->spark, q->spark_n);
        ui_show(h->spark, spark);
    }
}

/* --- band 7: the watchlist, and the briefs -------------------------------- */

static void build_ticker(void)
{
    const int mark_box = lv_font_get_line_height(UI_F_LABEL);
    const int inset    = row_inset(UI_TICKER_ROW_H, UI_F_LABEL);
    const int spark_y  = row_inset(UI_TICKER_ROW_H, UI_F_LABEL)
                       + (lv_font_get_line_height(UI_F_LABEL) - UI_SPARK_H) / 2;

    /* The column heads never change, so they are set and forgotten. The fifth
     * field has none: the sparkline's heading in the design sketch is a run of
     * block-element characters, and no face on this board carries one — a head
     * that renders as five tofu boxes is worse than a head that is not there,
     * and the column under it needs no naming. */
    s_tick_head[0] = caps(FP_T_SYM_X,  UI_TICKER_HEAD_Y, UI_TICKER_SYM_W,
                          LV_TEXT_ALIGN_LEFT,  S_COL_SYMBOL);
    s_tick_head[1] = caps(FP_T_NAME_X, UI_TICKER_HEAD_Y, UI_TICKER_NAME_W,
                          LV_TEXT_ALIGN_LEFT,  S_COL_NAME);
    s_tick_head[2] = caps(FP_T_LAST_X, UI_TICKER_HEAD_Y, UI_TICKER_LAST_W,
                          LV_TEXT_ALIGN_RIGHT, S_COL_LAST);
    s_tick_head[3] = caps(FP_T_CHG_X,  UI_TICKER_HEAD_Y, UI_TICKER_CHG_W,
                          LV_TEXT_ALIGN_RIGHT, S_COL_CHG);
    s_tick_hair = ui_rule(s_page, UI_TICKER_X, UI_TICKER_HAIR_Y, UI_TICKER_W,
                          UI_RULE_HAIR);

    for (int i = 0; i < UI_TICKER_ROWS; i++) {
        quote_t  *r = &s_tick[i];
        const int y = UI_TICKER_ROW_Y + i * UI_TICKER_ROW_H;

        r->sym   = ui_lab_w(s_page, FP_T_SYM_X, y + inset, UI_TICKER_SYM_W,
                            UI_F_LABEL, LV_TEXT_ALIGN_LEFT, "");
        r->name  = ui_lab_w(s_page, FP_T_NAME_X, y + inset, UI_TICKER_NAME_W,
                            UI_F_LABEL, LV_TEXT_ALIGN_LEFT, "");
        r->last  = ui_lab_w(s_page, FP_T_LAST_X, y + inset, UI_TICKER_LAST_W,
                            UI_F_LABEL, LV_TEXT_ALIGN_RIGHT, "");
        r->mark  = mark_create(FP_T_CHG_X, y + inset, UI_F_LABEL);
        r->chg   = ui_lab_w(s_page, FP_T_CHG_X + mark_box, y + inset,
                            UI_TICKER_CHG_W - mark_box, UI_F_LABEL,
                            LV_TEXT_ALIGN_RIGHT, "");
        r->spark = ui_chart_create(s_page, FP_T_SPARK_X, y + spark_y,
                                   UI_SPARK_W, UI_SPARK_H);
        /* Under every row that has a quotation in it, INCLUDING THE LAST — the
         * table's foot is a rule like any other and a block that stops without
         * one reads as a ninth row that failed to print — and under no row that
         * has not. The version this replaces drew all eight whatever arrived,
         * so a three-name watchlist printed three quotations and then five bare
         * 752 px hairlines at 25 px pitch: ruled, unfilled stationery in the
         * bottom-left corner of the sheet, which is the one thing on the page
         * that actively announces missing data. */
        r->hair  = ui_rule(s_page, UI_TICKER_X, y + UI_TICKER_ROW_H - 1,
                           UI_TICKER_W, UI_RULE_HAIR);
    }

    s_tick_vrule = ui_vrule(s_page, UI_TICKER_VRULE_X, UI_TICKER_Y,
                            UI_TICKER_H, UI_RULE_HAIR);

    s_brief_head = caps(UI_BRIEF_X, UI_TICKER_HEAD_Y, UI_BRIEF_W,
                        LV_TEXT_ALIGN_LEFT, S_IN_BRIEF);
    s_brief_hair = ui_rule(s_page, UI_BRIEF_X, UI_TICKER_HAIR_Y,
                           UI_BRIEF_W, UI_RULE_HAIR);

    for (int i = 0; i < UI_BRIEF_ROWS; i++) {
        const int y = UI_TICKER_ROW_Y + i * UI_BRIEF_H;
        const int lh = lv_font_get_line_height(UI_F_BODY);

        s_brief[i].kicker = caps(UI_BRIEF_X, y, UI_BRIEF_W,
                                 LV_TEXT_ALIGN_LEFT, "");
        s_brief[i].head   = ui_lab_box(s_page, UI_BRIEF_X, y + lh, UI_BRIEF_W,
                                       FP_BRIEF_LINES * lh, UI_F_BODY,
                                       LV_TEXT_ALIGN_LEFT, "");
    }

    /* The hairline at y=1544 that closes the sheet is NOT drawn here. It is the
     * line the folio hangs from, both pages need it on the same row, and
     * ui_news.c draws it with the folio for that reason. */
}

/* The table quotes from where the portfolio rail stopped, when the payload
 * carries more than the table can show — the model holds sixteen and the rail
 * has already printed the first six, so starting the table at the seventh is
 * what puts fourteen of them on the sheet instead of printing the same symbols
 * twice, once compactly and once in full, half a page apart. The last two are
 * exactly what page A2 is for.
 *
 * Under nine quotes the table falls back to the top of the list and the two
 * elements agree. That is not the duplication above: six symbols named as the
 * portfolio and then quoted with their names, prices and shapes reads as the
 * page saying the same thing twice deliberately, which is what a paper does
 * with a short list — whereas eight blank ruled rows reads as a fault. */
static void set_ticker(const news_t *v)
{
    char buf[24];
    const int base = FP_TICK_BASE(v);

    /* A column head over nothing is a table that lost its contents. */
    for (int i = 0; i < 4; i++) ui_show(s_tick_head[i], v->ticker_count > 0);
    ui_show(s_tick_hair, v->ticker_count > 0);

    for (int i = 0; i < UI_TICKER_ROWS; i++) {
        quote_t *r = &s_tick[i];
        if (base + i >= v->ticker_count) {
            ui_set(r->sym, "");
            ui_set(r->name, "");
            ui_set(r->last, "");
            ui_set(r->chg, "");
            mark_clear(r->mark);
            ui_show(r->spark, false);
            ui_show(r->hair, false);
            continue;
        }
        ui_show(r->hair, true);

        const news_quote_t *q = &v->tickers[base + i];
        ui_set(r->sym, q->symbol);
        ui_set(r->name, q->name);
        ui_money(buf, sizeof buf, q->last_c);
        ui_set(r->last, buf);
        ui_pct(buf, sizeof buf, q->chg_bp);
        ui_set(r->chg, buf);
        lv_obj_set_style_text_color(r->chg, chg_colour(q->chg_bp), 0);
        mark_set(r->mark, q->chg_bp);

        const bool spark = q->spark_n > 0;
        if (spark) ui_chart_set_spark(r->spark, q->spark, q->spark_n);
        ui_show(r->spark, spark);
    }
}

/* The briefs column, and what fills it when the payload has no stories left to
 * put there.
 *
 * UI_BRIEF_ROWS is three and the tier engine reaches them from the THIRD story
 * on, so a payload of four fills the column and anything thinner used to leave
 * the bottom-right corner as paper — the one dead zone on a framed sheet a
 * viewer cannot miss. The block was starved structurally rather than by
 * accident: the stories above it were promoted into bands 5 and 6, and nothing
 * back-filled what they left.
 *
 * So it is back-filled from data already on the device: the session's largest
 * movers, set as agate lines under their own symbols, which is a filler every
 * markets page in print has carried. They are type and not a figure column —
 * black, no mark, no colour — because §6 spends colour on the ribbon, the rail
 * and the CHG column and this is none of the three.
 *
 * Returns how many rows ended up with something in them, which is what decides
 * whether the column exists at all. */
static int set_briefs(const news_t *v, const news_story_t *st[], int briefs,
                      bool summary)
{
    /* Primed with every quotation THIS SHEET HAS ALREADY PRINTED, and not just
     * with the ones this column has used, which is the whole of the fix. The
     * demo page ran "MU / Micron at 128.05, +3.42% on the session" as a brief
     * two hundred pixels above a table row reading MU 128.05 +3.42%: the same
     * figure twice, once as a table cell and once as a sentence about the table
     * cell, which is the most obviously machine-generated thing a page can do.
     * A briefs column exists for what is NOT elsewhere on the sheet.
     *
     * The rail's rows and the table's are enumerated by the same two rules the
     * rail and the table are laid out by — FP_TICK_BASE is shared with
     * set_ticker() precisely so that "already on the sheet" cannot drift from
     * "on the sheet". What is left over is what page A2 carries, which is why
     * there is anything left over at all: the model holds sixteen quotations
     * and A1 prints fourteen of them. */
    bool taken[NEWS_TICKERS_MAX] = { false };
    const int base = FP_TICK_BASE(v);

    for (int k = 0; k < UI_RAIL_ROWS && k < v->ticker_count; k++) taken[k] = true;
    for (int k = 0; k < UI_TICKER_ROWS && base + k < v->ticker_count; k++) {
        taken[base + k] = true;
    }

    const int lh = lv_font_get_line_height(UI_F_BODY);
    int rows = 0;

    for (int i = 0; i < UI_BRIEF_ROWS; i++) {
        char line[128];
        const char *kick = NULL, *text = NULL;

        if (i < briefs) {
            kick = st[2 + i]->kicker;
            text = st[2 + i]->headline;
        } else {
            /* The largest absolute move not already named ON THE SHEET. A
             * linear scan of at most sixteen, twice: the alternative is a sort
             * of the watchlist, and a page that reordered the owner's holdings
             * to fill a corner would be lying about which one is first. */
            int best = -1;
            for (int k = 0; k < v->ticker_count && k < NEWS_TICKERS_MAX; k++) {
                if (taken[k]) continue;
                if (best < 0
                    || bp_abs(v->tickers[k].chg_bp)
                       > bp_abs(v->tickers[best].chg_bp)) best = k;
            }
            if (best >= 0) {
                const news_quote_t *q = &v->tickers[best];
                char pct[16], money[24];
                taken[best] = true;
                ui_pct(pct, sizeof pct, q->chg_bp);
                ui_money(money, sizeof money, q->last_c);
                snprintf(line, sizeof line, "%s at %s, %s on the session",
                         quote_name(q), money, pct);
                kick = q->symbol;
                text = line;
            } else if (rows == 0 && !summary && v->index_count > 0) {
                /* The last resort, and the reason there is one: a payload whose
                 * every quotation is already printed above leaves this column
                 * with nothing at all, and the bottom-right corner of a framed
                 * sheet is the one dead zone a viewer cannot miss. That is a
                 * thin morning rather than a fault, but the market still did
                 * something, and the session line is the one thing the sheet
                 * has to say that is not a figure already on it.
                 *
                 * Only when band 5 did NOT take it. On a day with no stories
                 * the summary is the lead, and printing it again down here
                 * would be exactly the duplication the rest of this function
                 * exists to stop — the same sentence twice on one page is worse
                 * than the same price twice. */
                summary_head(v, line, sizeof line);
                kick = S_SUMMARY_KICKER;
                text = line;
            }
        }

        const bool used = kick != NULL;
        ui_set(s_brief[i].kicker, used ? kick : "");
        /* Balanced, not filled. A brief's head is the shortest two-line setting
         * on the sheet and therefore the one greedy breaking mangles worst:
         * "Costco holds the line where the mall does / not" is what a machine
         * does to a headline, and ui_fit_balance's stop-word penalty and its
         * widest-line score are already the copy desk's two rules. */
        if (used) set_head(s_brief[i].head, UI_BRIEF_W, FP_BRIEF_LINES * lh,
                           UI_F_BODY, text, s_head_brief[i],
                           sizeof s_head_brief[i]);
        else      ui_set(s_brief[i].head, "");
        ui_show(s_brief[i].kicker, used);
        ui_show(s_brief[i].head, used);
        if (used) rows++;
    }
    return rows;
}

/* --- the tier engine ------------------------------------------------------
 * The server sends a rank and nothing about geometry. This sorts on that rank,
 * stably, and then assigns BY POSITION: the first story is the lead whatever
 * number it carries, so a payload that ranks its stories 10, 20, 30 lays out
 * exactly as one that ranks them 0, 1, 2. A payload where every rank is the
 * same is laid out in the order it arrived, which is the only ordering left and
 * the one the producer most likely meant.
 *
 * Insertion sort on POINTERS, not on stories: a news_story_t is 2.7 KB and
 * swapping six of them by value would put a task's whole stack on the frame to
 * save nothing at all — there are at most six.
 */
static int tier_assign(const news_t *v, const news_story_t *out[NEWS_STORIES_MAX])
{
    int n = v->story_count;
    if (n > NEWS_STORIES_MAX) n = NEWS_STORIES_MAX;

    for (int i = 0; i < n; i++) out[i] = &v->stories[i];

    for (int i = 1; i < n; i++) {
        const news_story_t *k = out[i];
        int j = i - 1;
        while (j >= 0 && out[j]->rank > k->rank) {
            out[j + 1] = out[j];
            j--;
        }
        out[j + 1] = k;
    }
    return n;
}

/* --- blank ----------------------------------------------------------------
 * A NULL snapshot is an empty sheet, not a placeholder: the rules and the
 * column heads are the paper and they stay, and everything that would have
 * carried a reading goes away. The masthead, the dateline and the folio stay
 * for the same reason and are not touched here at all — they are the
 * furniture, and ui_news.c blanks its own. There is no "no data" line, because
 * an unconfigured board shows the demo snapshot and never reaches this at all —
 * this is the state between power-on and the first payload, and a sheet that
 * announces itself as empty is worse than one that simply has not been printed
 * on yet.
 */
static void blank(void)
{
    show_well_head(false);
    show_lead_story(false);
    show_panel(false);

    /* And the two rules that divide the three empty bands from each other. See
     * build_lead(): a boundary with nothing on either side of it is not a rule,
     * it is a stripe across bare paper, and three of them is what a printer
     * running out of ink looks like. */
    ui_show(s_lead_rule, false);
    ui_show(s_second_rule, false);

    show_story(false);
    ui_show(s_sec_vrule, false);

    (void)rail_layout(UI_RAIL_X, UI_RAIL_W);
    for (int i = 0; i < UI_RAIL_ROWS; i++) {
        ui_set(s_rail[i].sym, "");
        ui_set(s_rail[i].name, "");
        ui_set(s_rail[i].last, "");
        ui_set(s_rail[i].chg, "");
        mark_clear(s_rail[i].mark);
        ui_show(s_rail[i].spark, false);
    }
    /* And the rail's own heading, which is the last thing on the sheet that
     * would otherwise be a column head printed over nothing. */
    ui_show(s_rail_head, false);
    ui_show(s_rail_hair, false);

    for (int i = 0; i < UI_TICKER_ROWS; i++) {
        ui_set(s_tick[i].sym, "");
        ui_set(s_tick[i].name, "");
        ui_set(s_tick[i].last, "");
        ui_set(s_tick[i].chg, "");
        mark_clear(s_tick[i].mark);
        ui_show(s_tick[i].spark, false);
        ui_show(s_tick[i].hair, false);
    }
    for (int i = 0; i < 4; i++) ui_show(s_tick_head[i], false);
    ui_show(s_tick_hair, false);

    for (int i = 0; i < UI_BRIEF_ROWS; i++) {
        ui_set(s_brief[i].kicker, "");
        ui_set(s_brief[i].head, "");
        ui_show(s_brief[i].kicker, false);
        ui_show(s_brief[i].head, false);
    }
    ui_show(s_brief_head, false);
    ui_show(s_brief_hair, false);
    ui_show(s_tick_vrule, false);
}

/* --- the page ------------------------------------------------------------- */

lv_obj_t *ui_page_front_create(lv_obj_t *par)
{
    /* Full-bleed, so a child positioned at UI_MAST_Y lands at UI_MAST_Y: the
     * bands are panel coordinates, and an inset pane would give the simulator a
     * second frame of reference to undo before it could assert on one. */
    s_page = ui_pane(par, 0, 0, UI_W, UI_H);

    build_lead();
    build_panel();
    build_second();
    build_rail();
    build_ticker();

    blank();
    return s_page;
}

void ui_page_front_update(const news_t *v)
{
    if (!s_page) return;
    if (!v) { blank(); return; }

    /* The edition, the dateline, the session, the index ribbon and the folio
     * are the furniture's, and ui_news.c has already set them from this same
     * snapshot. What follows is only the news hole. */

    /* The two band boundaries come back with the bands. blank() takes them away
     * — see build_lead() — because a rule between two empty bands is a stripe
     * across bare paper rather than a boundary, and this is the call that says
     * there is something on both sides of them again. */
    ui_show(s_lead_rule, true);
    ui_show(s_second_rule, true);

    const news_story_t *st[NEWS_STORIES_MAX];
    const int n = tier_assign(v, st);

    /* Band 5, and it has three shapes rather than the two it used to. A lead
     * story fills the whole well. A day that brought no stories fills the top
     * of it with a market summary the board writes from the figures, and the
     * rest with the ribbon at the size a headline is set in — which is a front
     * page with a lead on it, rather than five numbers under a nameplate. And a
     * payload with neither stories nor indices leaves the well empty, because
     * there is then nothing on the sheet to write a summary about. */
    const bool lead    = n > 0;
    const bool summary = !lead && v->index_count > 0;

    show_well_head(lead || summary);
    show_lead_story(lead);
    show_panel(!lead);

    if (lead) {
        set_lead(st[0]);
    } else {
        if (summary) set_summary(v);
        for (int i = 0; i < UI_RIBBON_CELLS; i++) {
            set_cell(&s_panel[i], i < v->index_count ? &v->indices[i] : NULL);
        }
    }

    /* Band 6. One story in the left half and the rail in the right, or — with
     * no second story to print — the rail across the whole measure, because
     * 558 px of bare paper beside it is the hole everyone sees and a rail with
     * room for its holdings' names is the best thing that width can buy. */
    const bool second = n > 1;

    if (second) set_second(st[1]);
    else        show_story(false);

    ui_show(s_sec_vrule, second);
    const int rail_spark = rail_layout(second ? UI_RAIL_X : UI_CONTENT_X,
                                       second ? UI_RAIL_W : UI_CONTENT_W);
    set_rail(v, rail_spark);

    /* Band 7. The watchlist always, and the stories the front page had no room
     * for as briefs beside it. */
    set_ticker(v);

    const int briefs = n > 2 ? n - 2 : 0;
    const int filled = set_briefs(v, st, briefs, summary);

    ui_show(s_brief_head, filled > 0);
    ui_show(s_brief_hair, filled > 0);
    ui_show(s_tick_vrule, filled > 0);
}
