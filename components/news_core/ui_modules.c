/*
 * ui_modules.c — every part both sheets are set out of, and the one place a
 * measurement and a placement are guaranteed to agree.
 *
 * ## Measure and place are the SAME walk
 *
 * The compositor asks a module how tall it wants to be and then tells it where
 * it landed, and those two answers have to be built from one arithmetic or the
 * page tears: a module that measured 300 and set 320 overruns the rule under it,
 * and one that measured 320 and set 300 leaves a white hole the compositor
 * already spent. So each renderer has ONE function that walks its stack from the
 * top, and it either records the heights (measure) or sets the widgets (place)
 * depending on whether it was handed an instance. There is no second table of
 * offsets anywhere in this file.
 *
 * The one thing measure cannot know is the headline WEIGHT: ui_head_weight()
 * demotes the second of two neighbours, and who the neighbours are is what the
 * compositor is still deciding. Measure therefore asks at the module's own
 * weight — the largest face it can be given — and place asks again with the real
 * one. A demoted headline is a SMALLER face, so the measurement is an upper
 * bound and the legs underneath absorb the difference, which is what elastic
 * means.
 *
 * ## Colour
 *
 * Green and red reach the glass from two places in this file and nowhere else:
 * lv_obj_set_style_text_color() on a change figure, and ui_draw_tri_abs() in
 * marks_cb(). Both read ui_chg_colour(), which answers ink at zero and ink for
 * everything when the snapshot is stale — see ui_internal.h. Grepping this file
 * for ui_chg_colour finds the whole of the audit.
 *
 * ## Nothing here is created in an update
 *
 * ui_mod_create() builds every widget a renderer can ever need and hides it; a
 * placement shows what the day used and hides the rest. On a board that repaints
 * every five minutes for years, object churn is where the heap goes.
 */
#include "ui_modules.h"

#include "ui_internal.h"

#include "ui_chart.h"
#include "ui_fit.h"
#include "ui_tile.h"

#include <stdbool.h>
#include <stddef.h>
#include <stdio.h>
#include <string.h>

#define NELEM(a) ((int)(sizeof(a) / sizeof((a)[0])))

/* Franklin's caps were cut to be spaced, and every caps label on the sheet
 * takes the same +2 — see ui_track(). */
#define MD_TRACK            2

/* The paper between two fields of a ruled table. Narrower than the page gutter:
 * the fields of one row belong to each other, and setting them at the page
 * gutter makes a table read as several tables. */
#define MD_FIELD_GAP       10

/* A flat session's mark: a bar rather than a triangle, in ink. A solid green
 * triangle beside +0.00% asserts a rise that did not happen, and in a column the
 * eye scans for direction the reader counts a flat name as a gainer. */
#define MD_FLAT_H           3

/* The room a rule needs between two items of a list: paper, the hairline,
 * paper. Stated as two numbers rather than one so an item's height and the rule
 * inside its gap cannot drift apart. */
#define MD_ITEM_GAP        10
#define MD_RULE_DY          5

/* Scratch for the copy a placement pours into a widget. LVGL copies the string
 * into the label, so one buffer per leg serves every module on both sheets — and
 * a news_t is already too big for a task stack, so three kilobytes of copy on the
 * same frame would be worse. */
static char s_copy[UI_LEGS_MAX][NEWS_BODY_MAX];
static char s_head[NEWS_HEADLINE_MAX + 8];
static char s_caps[NEWS_HEADLINE_MAX + 8];

/* --- the faces a headline weight resolves to ------------------------------
 *
 * ui_head_weight() answers 0 for the lead's face and larger numbers for smaller
 * ones; this is where the page maps them onto what it actually has. The line
 * heights are ui_internal.h's rather than the faces' own, and for weight 0 that
 * is TIGHTER than the face carries — 62 against display_56's 65 — because a
 * display line is set with negative leading and a lead headline over three lines
 * at the face's natural leading reads as three separate lines.
 *
 * Weight 2 is deck_24, which is italic. That is not a fallback: a down-page head
 * set in italic is standard broadsheet practice, it is the only face on this
 * board between 36 px and 20 px, and it is exactly what ui_internal.h's table
 * names. */
const lv_font_t *ui_head_font(int weight)
{
    switch (weight) {
    case 0:  return UI_F_LEAD;
    case 1:  return UI_F_HEADLINE;
    case 2:  return UI_F_DECK;
    default: return UI_F_BODY_LG;
    }
}

int ui_head_lh(int weight)
{
    switch (weight) {
    case 0:  return UI_MOD_HEAD_LH_0;
    case 1:  return UI_MOD_HEAD_LH_1;
    case 2:  return UI_MOD_HEAD_LH_2;
    default: return UI_MOD_HEAD_LH_3;
    }
}

/* --- type, measured without a widget --------------------------------------
 *
 * Everything below goes through lv_text_get_size(), which is the measurement
 * LVGL itself will use to lay the label out. That equality is the whole point:
 * a stack this file measured cannot then set one line taller than it reserved.
 */

/* How many lines `s` takes at `w`, at the face's own leading. Leading is added
 * BETWEEN lines and not after the last one, so the count is what the caller
 * wants and md_box() below is where the leading is put back. */
static int md_lines(const lv_font_t *f, int w, const char *s)
{
    const int fh = lv_font_get_line_height(f);
    if (!s || !s[0] || w <= 0 || fh <= 0) return 0;

    lv_point_t sz;
    lv_text_get_size(&sz, s, f, 0, 0, (int32_t)w, LV_TEXT_FLAG_NONE);

    const int n = (int)((sz.y + fh - 1) / fh);
    return n < 1 ? 1 : n;
}

/* The box `lines` lines need when they are set at `lh` rather than at the
 * face's own line height. It is NOT lines * lh: LVGL lays each line out at the
 * face's height and inserts the difference between lines only, so n lines
 * measure n*fh + (n-1)*(lh-fh). Sizing a box to n*lh instead would clip the last
 * line of every tightly-led headline on the sheet, and LVGL would not complain —
 * it would simply set two lines where three were asked for. */
static int md_box(const lv_font_t *f, int lh, int lines)
{
    if (lines < 1) return 0;
    const int fh = lv_font_get_line_height(f);
    return lines * fh + (lines - 1) * (lh - fh);
}

/* What `s` actually sets to, in px, at `track` letter-spacing.
 *
 * The one measurement behind every slot on this sheet that is sized to its
 * CONTENT rather than to its column — the small tier of the rail, the legend of
 * a drawn table — and it is lv_text_get_size(), so the answer is the width LVGL
 * will actually lay out. A slot measured any other way is a slot that ellipsizes
 * on the glass and nowhere else.
 *
 * One tracking step is added back on because LVGL measures the spaces BETWEEN
 * glyphs and a box has to hold the one the last glyph is drawn with. */
static int md_text_w(const lv_font_t *f, const char *s, int track)
{
    if (!s || !s[0]) return 0;

    lv_point_t sz;
    lv_text_get_size(&sz, s, f, track, 0, LV_COORD_MAX, LV_TEXT_FLAG_NONE);
    return (int)sz.x + track;
}

/* Whether `s` sets on ONE line inside `w`. For the slots that would rather say
 * nothing than say half of something — see the note under a chart. */
static bool caps_fits(const lv_font_t *f, int w, const char *s)
{
    if (!s || !s[0]) return false;
    return md_text_w(f, s, 0) <= w;
}

/* The leading a slot is set at, as LVGL's line_space. Negative for a display
 * face, positive for body text; both are what ui_internal.h's table asks for. */
static void md_lead(lv_obj_t *l, const lv_font_t *f, int lh)
{
    if (l) lv_obj_set_style_text_line_space(l, lh - lv_font_get_line_height(f), 0);
}

static int md_ls(const lv_font_t *f, int lh)
{
    return lh - lv_font_get_line_height(f);
}

/* --- the shapes this file builds ------------------------------------------ */

static lv_obj_t *md_caps(lv_obj_t *par, int x, int y, int w,
                         lv_text_align_t align, const char *txt)
{
    lv_obj_t *l = ui_lab_w(par, x, y, w, UI_F_LABEL, align, txt);
    ui_track(l, MD_TRACK);
    return l;
}

/* A slot that wraps to a fixed number of lines and ellipsizes past them. Every
 * headline, deck and caption on the sheet is one of these: the height is what
 * turns a long string into an ellipsis instead of a line that lands on the
 * module below. */
static lv_obj_t *md_block(lv_obj_t *par, const lv_font_t *f, int lh)
{
    lv_obj_t *l = ui_lab_box(par, 0, 0, 10, lh, f, LV_TEXT_ALIGN_LEFT, "");
    md_lead(l, f, lh);
    return l;
}

/* A body column. Copyfitted before it is set and therefore the one kind of
 * label allowed to wrap: ui_fit_text() has already refused any string that
 * would need a line this box does not have. */
static lv_obj_t *md_leg(lv_obj_t *par, const lv_font_t *f, int lh)
{
    lv_obj_t *l = ui_lab_box(par, 0, 0, 10, lh, f, LV_TEXT_ALIGN_LEFT, "");
    md_lead(l, f, lh);
    ui_lab_wrap(l, lh);
    return l;
}

static void md_at(lv_obj_t *o, int x, int y, int w, int h)
{
    if (!o) return;
    lv_obj_set_pos(o, x, y);
    lv_obj_set_size(o, w, h);
    ui_show(o, true);
}

static void md_text(lv_obj_t *o, int x, int y, int w, int h, const char *txt)
{
    ui_set(o, txt);
    md_at(o, x, y, w, h);
}

/* The same, upper-cased first, for a tracked slot that takes a string off the
 * wire. ui_track() is letterspacing cut for caps and applied to lower case it
 * takes a word apart — "S u p p l y" beside a correctly tracked "REGULATION". */
static void md_text_caps(lv_obj_t *o, int x, int y, int w, int h, const char *txt)
{
    ui_upper(s_caps, sizeof s_caps, txt);
    md_text(o, x, y, w, h, s_caps);
}

/* The rule a block is CLOSED with, and only when it has paper under it.
 *
 * A page is allowed to end. A thin day gives the compositor more well than the
 * file has material for, and after every module has spread what it has as far as
 * it honestly can there is paper left at the foot — which a newspaper prints all
 * the time, and which reads as the page stopping rather than as the page failing
 * PROVIDED there is a line saying so. Without it the last item just trails off
 * into white and the sheet looks like it failed to finish printing.
 *
 * Not drawn when the block reaches its own foot: the band rule below is already
 * there, and a hairline a few pixels above a heavier rule reads as a fault. */
#define MD_CLOSE_MIN 24

static void md_close(lv_obj_t *rule, int y, int w, int h)
{
    if (!rule) return;
    if (h - y < MD_CLOSE_MIN) { ui_show(rule, false); return; }
    md_at(rule, 0, y, w, UI_RULE_HAIR);
}

static void md_font(lv_obj_t *o, const lv_font_t *f, int lh)
{
    if (!o) return;
    lv_obj_set_style_text_font(o, f, 0);
    md_lead(o, f, lh);
}

/* --- the marks ------------------------------------------------------------
 *
 * A module's up and down marks are drawn by ONE callback on ONE pane covering
 * the module, from a list the placement built. A pane apiece would be a dozen
 * objects to position, show and invalidate for a shape that is six lines of
 * geometry and always the same two triangles — and a triangle cannot be a glyph
 * here anyway: no text face carries U+25B2, adding it means regenerating six
 * fonts from three variable families, and a set glyph could not be given UI_UP
 * or UI_DOWN. */

/* The height of a range bar's end ticks either side of its rule; the bar itself
 * is 2 * this + 1 tall, which puts it on the same optical weight as the triangle
 * it shares the list with. */
#define MD_RANGE_TICK   3

/* Every mark in a module's list, at an origin the caller supplies.
 *
 * Two panes draw them — the marks pane every module can have, and the plot pane
 * of a drawn statement, whose legend carries a change per component. Both cover
 * their whole module, so both pass the same origin and the list needs no second
 * coordinate space. */
static void marks_draw(lv_layer_t *L, const ui_module_t *w, int ox, int oy)
{
    for (int i = 0; i < w->mark_n; i++) {
        const ui_mark_t *k = &w->mark[i];
        const int x = ox + k->x, y = oy + k->y;

        if (k->kind == UI_MARK_RANGE) {
            /* A rule across the column with the value's position marked on it:
             * where a figure sits inside the band the producer chose, which is
             * what turns a number into a graphic. `side` is the bar's WIDTH here
             * and `bp` its position, 0..1000.
             *
             * INK, never green or red, and that is the colour policy applied
             * rather than forgotten — a position inside a range is not a change,
             * and a green range bar would assert a direction the producer never
             * sent. The two ends are ticked so the bar reads as a SPAN rather
             * than as a progress meter, which is a device idiom and the one this
             * sheet is furthest from. */
            const int x1  = x + k->side - 1;
            const int pos = x + (int)(((int64_t)k->side - 1) * k->bp / 1000);

            ui_draw_rect_c_abs(L, x, y + MD_RANGE_TICK, x1,
                               y + MD_RANGE_TICK, true, 0, UI_INK);
            ui_draw_rect_c_abs(L, x, y, x, y + 2 * MD_RANGE_TICK,
                               true, 0, UI_INK);
            ui_draw_rect_c_abs(L, x1, y, x1, y + 2 * MD_RANGE_TICK,
                               true, 0, UI_INK);
            ui_draw_rect_c_abs(L, pos - 1, y, pos + 1, y + 2 * MD_RANGE_TICK,
                               true, 0, UI_INK);
            continue;
        }

        if (k->bp == 0) {
            const int t = y + (k->side - MD_FLAT_H) / 2;
            ui_draw_rect_c_abs(L, x, t, x + k->side - 1, t + MD_FLAT_H - 1,
                               true, 0, UI_INK);
            continue;
        }
        ui_draw_tri_abs(L, x, y, k->side, k->side, k->bp > 0,
                        ui_chg_colour(k->bp));
    }
}

static void marks_cb(lv_event_t *e)
{
    lv_obj_t    *o = lv_event_get_target_obj(e);
    lv_layer_t  *L = lv_event_get_layer(e);
    ui_module_t *w = o ? (ui_module_t *)lv_obj_get_user_data(o) : NULL;
    if (!L || !w) return;

    lv_area_t a;
    lv_obj_get_coords(o, &a);
    marks_draw(L, w, a.x1, a.y1);
}

static lv_obj_t *marks_pane(ui_module_t *w, lv_obj_t *par)
{
    lv_obj_t *o = ui_pane(par, 0, 0, 1, 1);
    lv_obj_set_user_data(o, w);
    lv_obj_add_event_cb(o, marks_cb, LV_EVENT_DRAW_MAIN, NULL);
    return o;
}

static void mark_add(ui_module_t *w, int x, int y, int side, int32_t bp)
{
    if (w->mark_n >= UI_MARKS_MAX) return;
    w->mark[w->mark_n++] = (ui_mark_t){
        (int16_t)x, (int16_t)y, (int16_t)side, bp, UI_MARK_CHG,
    };
}

/* `side` is the bar's WIDTH and `bp` the value's position in it, 0..1000 — see
 * ui_mark_t. A different reading of the same four fields, which is the whole
 * reason the two shapes share one list and one pane. */
static void mark_add_range(ui_module_t *w, int x, int y, int width, int32_t pos)
{
    if (w->mark_n >= UI_MARKS_MAX || width < 2) return;
    if (pos < 0)    pos = 0;
    if (pos > 1000) pos = 1000;

    w->mark[w->mark_n++] = (ui_mark_t){
        (int16_t)x, (int16_t)y, (int16_t)width, pos, UI_MARK_RANGE,
    };
}

/* Every module's marks pane covers the module, so the coordinates a placement
 * records are the module's own and no callback has to know where it landed. */
static void marks_ready(ui_module_t *w, lv_obj_t *pane, int mw, int mh)
{
    if (!pane) return;
    md_at(pane, 0, 0, mw, mh);
    ui_show(pane, w->mark_n > 0);
    lv_obj_invalidate(pane);
}

/* --- a photograph ---------------------------------------------------------
 *
 * The tile arrives already screened and packed by tools/make_tile.py and the
 * device copies it verbatim; it is never resized, tone-mapped or dithered here.
 * A slot narrower or shorter than the picture takes the MIDDLE of it, which is
 * what a picture desk does, and the crop is a clipping pane rather than
 * arithmetic on the descriptor.
 *
 * Both the slot's x and the crop's offset are even. A tile packs two pixels to a
 * byte, so an odd origin would need a nibble-shifting blit on the device for a
 * rounding error nobody asked for — see ui_internal.h's static assertion.
 *
 * A tile that is not resident is an ordinary front-page condition: a slow wire,
 * an id that went stale between the JSON and the GET. The module reflows without
 * the picture rather than treating it as an error. */
static const ui_tile_t *art_tile(const news_photo_t *p)
{
    if (!p || !p->id[0] || p->w <= 0 || p->h <= 0) return NULL;
    return ui_tile_get(p->id, p->w, p->h);
}

static void art_hide(ui_w_art_t *a)
{
    if (!a->box) return;
    lv_image_set_src(a->art, NULL);
    ui_show(a->box, false);
}

static void art_create(ui_w_art_t *a, lv_obj_t *par)
{
    a->box = ui_pane(par, 0, 0, 1, 1);

    /* An lv_image rather than a pane with a draw callback: DRAW_MAIN runs while
     * this refresh's draw tasks are being BUILT and not while they are being
     * executed, so a blit made there would be laid down first and painted over
     * by everything queued after it. An image goes through the same queue the
     * type does. */
    a->art = lv_image_create(a->box);
    lv_obj_remove_style_all(a->art);
    lv_obj_remove_flag(a->art, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_remove_flag(a->art, LV_OBJ_FLAG_CLICKABLE);

    /* The edge, and it is four rules rather than a frame for two reasons: a
     * frame is filled white and would paint over the halftone it is supposed to
     * outline, and four rules created AFTER the image print on top of it. They
     * sit on the slot's own outermost rows and columns, inside it. A halftone
     * with no border has no edges at all — an open sky screens to bare paper and
     * the picture dissolves into the page, which reads as a printing fault
     * rather than as a photograph. */
    for (int i = 0; i < 4; i++) {
        a->edge[i] = i < 2 ? ui_rule(par, 0, 0, 1, UI_RULE_HAIR)
                           : ui_vrule(par, 0, 0, 1, UI_RULE_HAIR);
    }
    art_hide(a);
    for (int i = 0; i < 4; i++) ui_show(a->edge[i], false);
}

static void art_show(ui_w_art_t *a, const ui_tile_t *t, int x, int y, int w, int h)
{
    if (!a->box || !t) { art_hide(a); return; }

    const int cw = (t->w < w ? t->w : w) & ~1;
    const int ch = t->h < h ? t->h : h;
    const int ox = ((t->w - cw) / 2) & ~1;
    const int oy = (t->h - ch) / 2;
    const int sx = (x + ((w - cw) / 2)) & ~1;

    a->dsc.header.magic  = LV_IMAGE_HEADER_MAGIC;
    a->dsc.header.cf     = LV_COLOR_FORMAT_RGB565;
    a->dsc.header.w      = (uint32_t)t->w;
    a->dsc.header.h      = (uint32_t)t->h;
    a->dsc.header.stride = (uint32_t)t->w * 2;
    a->dsc.data          = (const uint8_t *)t->px;
    a->dsc.data_size     = (uint32_t)t->w * (uint32_t)t->h * 2;

    /* Re-pointed every placement rather than only when the picture changed: the
     * cache can evict and reload under the same id, so a "has the pointer moved"
     * test would compare equal across a reload and leave this descriptor aimed
     * at bytes that have been freed. Setting an unchanged source costs an
     * invalidate, and this page only redraws when news_hash() moved. */
    lv_image_set_src(a->art, &a->dsc);
    lv_obj_set_pos(a->art, -ox, -oy);
    lv_obj_set_size(a->art, t->w, t->h);

    md_at(a->box, sx, y, cw, ch);

    md_at(a->edge[0], sx, y, cw, UI_RULE_HAIR);
    md_at(a->edge[1], sx, y + ch - UI_RULE_HAIR, cw, UI_RULE_HAIR);
    md_at(a->edge[2], sx, y, UI_RULE_HAIR, ch);
    md_at(a->edge[3], sx + cw - UI_RULE_HAIR, y, UI_RULE_HAIR, ch);
}

static void art_off(ui_w_art_t *a)
{
    art_hide(a);
    for (int i = 0; i < 4; i++) ui_show(a->edge[i], false);
}

/* --- LEAD and STORY -------------------------------------------------------
 *
 * One renderer, because a lead IS a story with a photograph and a deck. What
 * changes with the module's width is how many legs the body sets in and which
 * face they are set in — see the measure table in ui_internal.h — and both fall
 * out of the column span rather than out of a flag.
 */

/* How many legs a measure of `w` divides into: a pure function of the measure,
 * with no flag and nothing about how the module came by its width.
 *
 * The bound is UI_LEG_MIN_W, and it is stated as the closed form rather than as
 * a division because the gutters come out of the same measure the legs do: n
 * legs of `(w - (n-1)*g) / n` are each at least `min` exactly when
 * `n <= (w + g) / (min + g)`. Dividing `w` by `min` and rounding is a whole leg
 * out at five columns — it answers four legs of 221 px, which is under the floor
 * it was supposed to be enforcing.
 *
 *      1140 -> 4 legs of 270      558 -> 2 of 269
 *       946 -> 3 legs of 302      364 -> 1 of 364
 *       752 -> 3 legs of 237      170 -> 1 (clamped; a rail sets no prose)
 *
 * I argued for the two-column, 45-character leg here and was wrong: that floor
 * is about MODULES on the six-column grid, and a leg inside a module is a
 * different question the design had already answered — UI_LEG_GUTTER is 20 px
 * against the page's 24 precisely because the legs of one story belong together
 * more closely than two stories do. See UI_LEG_MIN_W. */
int ui_legs_for(int w)
{
    int n = (w + UI_LEG_GUTTER) / (UI_LEG_MIN_W + UI_LEG_GUTTER);
    if (n < 1) n = 1;
    if (n > UI_LEGS_MAX) n = UI_LEGS_MAX;
    return n;
}

/* What each of `n` legs measures inside `w`, and the only expression of it. The
 * leg count above is a claim about this width, and the plan below lays out this
 * width; two spellings of the division is how a rule about legs comes to
 * disagree with the legs. Even, because everything on this sheet is. */
static int leg_w_of(int w, int n)
{
    if (n < 1) n = 1;
    return ((w - (n - 1) * UI_LEG_GUTTER) / n) & ~1;
}

/* Has this body the copy to fill `w` down to `lines_per_leg` lines in every leg?
 *
 * The front page's banner test, and it is a MEASUREMENT rather than a byte
 * count. The body is run through the same line breaker the legs will be set
 * with, at the width they will be set at, so the answer is the one the renderer
 * will give rather than a guess about it. A character threshold cannot know that
 * a story of long words sets shorter than a story of short ones, and the page it
 * produces on the day it guesses wrong is a full-measure package with three
 * inches of paper under the last leg — which is the exact fault the whole
 * compositor was rebuilt to remove.
 *
 * At the full 1,140 px measure it asks for four legs of 270 px at six lines
 * each, which is around 790 characters of ordinary English. Six is not a number
 * chosen here: it is story_run()'s own floor for a lead, the depth below which a
 * package stops reading as a story, so the banner asks exactly the question the
 * renderer will answer rather than a second opinion about it. */
bool ui_body_fills_legs(const char *body, int w, int lines_per_leg)
{
    const int n = ui_legs_for(w);
    if (lines_per_leg < 1) lines_per_leg = 1;

    /* The last leg is a shade narrower — it gives up the column the
     * end-of-story square stands in — and that is ignored deliberately: folding
     * it in would make the test depend on which leg the copy happened to end in,
     * for a difference of about one line in twenty-four. */
    return md_lines(UI_F_BODY, leg_w_of(w, n), body) >= n * lines_per_leg;
}

int ui_body_depth(const char *body, int w)
{
    const int n  = ui_legs_for(w);
    const int lw = leg_w_of(w, n);

    /* The lines the copy breaks into at the leg's own width, shared over the
     * legs, at the leading the legs are set with. The same walk story_run() does
     * — this is not an estimate of the depth, it IS the depth, which is what
     * lets a page reason about whether the day can fill the sheet. */
    int lines = md_lines(UI_F_BODY, lw, body);
    lines = (lines + n - 1) / n;

    return lines > 0 ? md_box(UI_F_BODY, UI_MOD_BODY_LH, lines) : 0;
}

typedef struct {
    int  legs;
    int  leg_x[UI_LEGS_MAX], leg_w[UI_LEGS_MAX];
    const lv_font_t *bf;
    int  blh, bls;
} legs_t;

static void legs_plan(legs_t *g, int w)
{
    g->legs = ui_legs_for(w);

    const int lw = leg_w_of(w, g->legs);

    for (int i = 0; i < g->legs; i++) {
        g->leg_x[i] = i * (lw + UI_LEG_GUTTER);
        g->leg_w[i] = lw;
    }
    /* The last leg takes whatever the division dropped, so the block of legs
     * ends exactly on the module's right edge and the end-of-story square lines
     * up with the rules above it. */
    g->leg_w[g->legs - 1] = w - g->leg_x[g->legs - 1];

    /* body_20 at a leg of three columns or wider, body_16 under it.
     *
     * UNREACHABLE AS THE CONSTANTS CURRENTLY STAND, and deliberately kept. The
     * six module widths this grid produces are 170, 364, 558, 752, 946 and 1140,
     * and ui_legs_for() turns them into legs of 170, 364, 268, 236, 302 and 270
     * — so the widest leg on the sheet is 364 px and nothing reaches 558. Every
     * leg of body on both pages is now body_16, which is a real consequence of
     * narrowing the leg floor and, on a newspaper, the right one: one page, one
     * text size, and the hierarchy carried by the headlines instead.
     *
     * It stays because it is a GUARD and not a branch. UI_LEG_MIN_W is the kind
     * of number that gets revisited, and the day it goes back up this is what
     * stops a 560 px leg being set at the size chosen for a 270 px one. */
    const bool big = lw >= UI_COL(3);
    g->bf  = big ? UI_F_BODY_LG : UI_F_BODY;
    g->blh = big ? UI_MOD_BODY_LH_LG : UI_MOD_BODY_LH;
    g->bls = md_ls(g->bf, g->blh);
}

/* The end-of-story square, on the last line the last leg actually set.
 *
 * One measurement and no second opinion about the copy: `txt` is the string that
 * has already been fitted, `w` the measure it was fitted to, and the height it
 * sets at divided by the face's is which line the mark belongs on. It hangs from
 * the module's own right edge rather than from the text's, so it lines up with
 * the rules and the headline above it in a column no line of the copy reaches. */
static void end_mark(lv_obj_t *m, const char *txt, const lv_font_t *f, int ls,
                     int right, int y, int w, int h)
{
    const int fh = lv_font_get_line_height(f);
    const int lh = fh + ls;                     /* one line, leading included */
    if (!txt || !txt[0] || fh <= 0 || lh <= 0 || h < fh) {
        ui_show(m, false);
        return;
    }

    /* n lines measure n*lh - ls, so both the count and the ceiling invert that
     * rather than dividing by the face's height and being a line out on every
     * column the page sets with leading. */
    lv_point_t sz;
    lv_text_get_size(&sz, txt, f, 0, ls, (int32_t)w, LV_TEXT_FLAG_NONE);

    const int max = (h + ls) / lh;
    int lines = (int)((sz.y + ls + lh - 1) / lh);
    if (lines < 1)   lines = 1;
    if (lines > max) lines = max;

    md_at(m, right - UI_END_SIDE,
          y + (lines - 1) * lh + (fh - UI_END_SIDE) / 2,
          UI_END_SIDE, UI_END_SIDE);
}

/* Everything above the legs, at `w`, in one walk. `inst` NULL measures; an
 * instance sets. `art` says whether the photograph is being given its room —
 * measure asks both ways, because the picture is the first thing a tight page
 * gives up and h_min must be the height without it. */
static int story_head(const ui_mod_t *m, const news_t *v, int w, int wt,
                      const ui_tile_t *tile, bool art, int max_art,
                      ui_module_t *inst)
{
    const news_story_t *st = &v->stories[m->src];
    const bool lead = m->kind == UI_MOD_LEAD;
    ui_w_story_t *g = inst ? &inst->w.story : NULL;
    int y = 0;

    if (st->kicker[0]) {
        if (g) md_text_caps(g->kicker, 0, y, w, UI_MOD_KICKER_H, st->kicker);
        y += UI_MOD_KICKER_H + UI_MOD_KICKER_GAP;
    } else if (g) {
        ui_show(g->kicker, false);
    }

    /* The headline, broken the way a copy desk breaks one rather than the way a
     * text engine fills one: ui_fit_balance() tries every legal split and keeps
     * the one whose longest line is shortest, so a two-line head arrives as two
     * even lines instead of a full line and a stub. */
    const lv_font_t *hf = ui_head_font(wt);
    const int hlh = ui_head_lh(wt);
    const int hmax = wt == 0 ? 4 : 5;

    ui_fit_balance(hf, w, hmax, st->headline, s_head, sizeof s_head);
    int hl = md_lines(hf, w, s_head);
    if (hl > hmax) hl = hmax;
    if (hl < 1)    hl = 1;

    if (g) {
        md_font(g->head, hf, hlh);
        md_text(g->head, 0, y, w, md_box(hf, hlh, hl), s_head);
    }
    y += md_box(hf, hlh, hl) + UI_MOD_HEAD_GAP;

    /* A deck under three columns is two words a line, so the lead carries one
     * and a narrow story does not. Below the fold a paper runs plenty of stories
     * that are a head and a byline. */
    const bool deck = lead && st->deck[0] && m->cols >= 3;
    if (deck) {
        int dl = md_lines(UI_F_DECK, w, st->deck);
        if (dl > 3) dl = 3;
        const int dh = md_box(UI_F_DECK, UI_MOD_DECK_LH, dl);
        if (g) md_text(g->deck, 0, y, w, dh, st->deck);
        y += dh + UI_MOD_DECK_GAP;
    } else if (g) {
        ui_show(g->deck, false);
    }

    if (st->byline[0]) {
        if (g) md_text_caps(g->byline, 0, y, w, UI_MOD_BYLINE_H, st->byline);
        y += UI_MOD_BYLINE_H + UI_MOD_BYLINE_GAP;
    } else if (g) {
        ui_show(g->byline, false);
    }

    if (art && tile) {
        const int ah = tile->h < max_art ? tile->h : max_art;
        if (g) art_show(&g->art, tile, 0, y, w, ah);
        y += ah;

        /* A caption belongs to a picture, and the credit is its own right-hand
         * slot: a caption is a sentence and sets untracked, a credit is caps and
         * does not. The split is measured rather than reserved — a reserved
         * width is a promise about a string nobody has read. */
        if (st->photo.caption[0] || st->photo.credit[0]) {
            const int cw = st->photo.credit[0] ? w / 3 : 0;
            if (g) {
                md_at(g->cap, 0, y + UI_MOD_CAP_GAP, w - cw, UI_MOD_CAP_H);
                ui_set(g->cap, st->photo.caption);
                if (cw) {
                    ui_upper(s_caps, sizeof s_caps, st->photo.credit);
                    md_text(g->cred, w - cw, y + UI_MOD_CAP_GAP, cw, UI_MOD_CAP_H,
                            s_caps);
                } else {
                    ui_show(g->cred, false);
                }
            }
            y += UI_MOD_CAP_GAP + UI_MOD_CAP_H;
        } else if (g) {
            ui_show(g->cap, false);
            ui_show(g->cred, false);
        }
        y += UI_MOD_ART_GAP;
    } else if (g) {
        art_off(&g->art);
        ui_show(g->cap, false);
        ui_show(g->cred, false);
    }

    /* The hairline the legs hang from. It is what separates the display type
     * above from the text below, and every story on the sheet has one. */
    if (g) md_at(g->hair, 0, y, w, UI_RULE_HAIR);
    y += UI_RULE_HAIR + UI_MOD_HAIR_GAP;

    return y;
}

static void story_run(const ui_mod_t *m, const news_t *v, int w, int wt,
                      ui_module_t *inst, int *h_min, int *h_pref)
{
    const news_story_t *st = &v->stories[m->src];
    const bool lead = m->kind == UI_MOD_LEAD;
    const ui_tile_t *tile = lead ? art_tile(&st->photo) : NULL;

    legs_t g;
    legs_plan(&g, w);

    const int one = md_box(g.bf, g.blh, 1);

    /* The shortest column this module is worth setting at all, in LINES.
     *
     * It is a real number rather than one, and it is the lever that decides how
     * a crowded page is squeezed. ui_compose() hands every band its h_min first
     * and shares out only what is left over, so a lead whose minimum was "the
     * furniture plus one line" would be the band that gives up everything — and
     * that is exactly what it did: a headline, a deck, a photograph and three
     * lines of story ending mid-clause. Six lines under a lead's display type
     * and five under a down-page head are what those packages actually need to
     * read as stories, and stating it here is what makes the compositor protect
     * them.
     *
     * FIVE AND NOT THREE FOR A SECONDARY, and the argument is the same one the
     * lead's six rests on, applied honestly. A down-page story's furniture — a
     * kicker, two lines of display_36, a byline and the hairline — is about 130
     * px before a word of the story is set. Three lines of body is 66 px, so the
     * furniture outweighs the story two to one and what the reader gets is a
     * headline with a fragment under it: on the demo front page, "and the move
     * was almost" and "against a loss in the". Five lines is 110 px, which is
     * where the body starts to carry its own package.
     *
     * The point is not that five lines is generous. It is that a module which
     * cannot reach five should be DROPPED and its room given to one that can —
     * and understating the floor is precisely what stops the compositor doing
     * that, because it only ever drops when the minimums themselves will not
     * fit. See ui_compose.h. */
    const int floor_lines = m->kind == UI_MOD_LEAD ? 6 : 5;
    const int floor_h     = md_box(g.bf, g.blh, floor_lines);

    if (!inst) {
        /* h_min is the module without its picture: the photograph is the first
         * thing a tight page gives up, and a lead that measured its minimum WITH
         * the art would be dropped whole on a day it could have run as type. */
        *h_min = story_head(m, v, w, wt, tile, false, 0, NULL) + floor_h;

        const int top = story_head(m, v, w, wt, tile, tile != NULL,
                                   UI_WELL_H, NULL);
        int lines = md_lines(g.bf, g.leg_w[0], st->body);
        lines = (lines + g.legs - 1) / g.legs;
        if (lines < 1) lines = 1;

        *h_pref = top + md_box(g.bf, g.blh, lines);

        /* A BANNER NEVER ASKS FOR MORE THAN THREE FIFTHS OF THE WELL, and this
         * is the one place in this file where a measurement is deliberately not
         * the honest answer to "how tall does the copy want to be".
         *
         * It is honest to a different question, which is the one a make-up
         * editor actually asks: how much of the page may one package have? A
         * banner lead with a photograph and two thousand bytes of body measures
         * about nine hundred pixels of a 1,338 px well, and the compositor —
         * correctly, given that number — hands it over and crushes the six
         * modules underneath into eighty pixels each. The rail truncates at
         * seven figures, the stories set three lines, the industry table prints
         * one row. Every one of those is the compositor doing what it was told.
         *
         * Three fifths is the cap because the rest of the page still has to
         * exist, and the copy that does not fit is cut at a word by ui_fit_text()
         * exactly as it is in every other package. A front page is a page before
         * it is a lead. */
        if (m->banner) {
            const int cap = (UI_WELL_H * 3) / 5;
            if (*h_pref > cap) *h_pref = cap;
        }

        if (*h_pref < *h_min) *h_pref = *h_min;
        return;
    }

    ui_w_story_t *ws = &inst->w.story;
    const int h = m->h;

    /* How much room the picture may take: whatever is left after the type above
     * it, its own caption line, and the module's own floor of body underneath.
     * Under 120 px there is no photograph — the module runs as type and the
     * picture is the thing given up, which is what a tight page does. */
    const int bare = story_head(m, v, w, wt, tile, false, 0, NULL);
    const int room = h - bare - floor_h
                   - UI_MOD_CAP_GAP - UI_MOD_CAP_H - UI_MOD_ART_GAP;
    const bool art = tile && room >= 120;

    const int top = story_head(m, v, w, wt, tile, art, room, inst);
    int leg_h = h - top;
    if (leg_h < one) leg_h = one;

    /* The legs are BALANCED rather than filled greedily. Running leg one to the
     * foot and letting leg two take what is left is right when the story
     * overruns both and wrong when it does not: a short body across two legs
     * gives a full column beside a third of one, which on a front page reads as
     * a column that failed to print. A press balances them. */
    const int cap = (leg_h + g.bls) / g.blh;
    int per = (md_lines(g.bf, g.leg_w[0], st->body) + g.legs - 1) / g.legs;
    if (per > cap) per = cap;
    if (per < 1)   per = 1;

    /* LEADING OUT a column the copy cannot fill.
     *
     * A thin day gives the compositor more well than the file has words for, and
     * the slack lands on the elastic modules — which is right, because a story is
     * the only thing on the sheet that CAN take it. What it cannot do is invent
     * sentences, so a story handed six hundred pixels for three hundred pixels of
     * copy sets its column and leaves the rest as paper, and that hole is the
     * thing this whole rebuild is about.
     *
     * What a press does instead is open the leading — a hair, and no more than a
     * hair. The ceiling was 1.6x and that was far too generous: A2's column set
     * at half again the leading of the same face everywhere else on the sheet,
     * and one loose column beside normal ones does not read as design, it reads
     * as a rendering fault. A newspaper sets ONE leading and varies it by a
     * fraction; a reader cannot see 12% but sees 60% instantly.
     *
     * So the copy is opened by an eighth at most and whatever is left over is
     * PAPER AT THE FOOT of the column — which is what a column that ended looks
     * like, which is true, and which every newspaper prints. The module still
     * fills its rectangle either way, so ui_compose_check() is indifferent
     * between the two; the difference is entirely what a reader sees. */
    int blh = g.blh;
    if (per > 0 && md_box(g.bf, g.blh, per) < leg_h) {
        const int want = leg_h / per;
        const int max  = (g.blh * 9) / 8;
        blh = want > max ? max : (want < g.blh ? g.blh : want);
    }
    const int bls   = md_ls(g.bf, blh);
    const int fit_h = md_box(g.bf, blh, per);

    size_t used = 0;
    for (int i = 0; i < UI_LEGS_MAX; i++) {
        if (i >= g.legs) { ui_show(ws->leg[i], false); continue; }

        /* The last leg's measure is narrower by the column the end-of-story
         * square stands in, so no line of copy can reach it. */
        const int lw = (i == g.legs - 1) ? UI_END_MEASURE(g.leg_w[i])
                                         : g.leg_w[i];

        used += ui_fit_text(g.bf, lw, fit_h, bls, st->body + used,
                            s_copy[i], sizeof s_copy[i]);

        md_font(ws->leg[i], g.bf, blh);
        md_text(ws->leg[i], g.leg_x[i], top, g.leg_w[i], leg_h, s_copy[i]);
        ui_lab_wrap(ws->leg[i], leg_h);
    }

    /* The rule down each leg gutter. Narrower than the page gutter because the
     * legs of one story are more closely related than two stories are. */
    for (int i = 0; i < UI_LEGS_MAX - 1; i++) {
        const bool on = i < g.legs - 1;
        if (on) {
            md_at(ws->leg_rule[i], g.leg_x[i] + g.leg_w[i] + UI_LEG_RULE_DX,
                  top, UI_RULE_HAIR, leg_h);
        } else {
            ui_show(ws->leg_rule[i], false);
        }
    }

    end_mark(ws->end, s_copy[g.legs - 1], g.bf, bls, w, top,
             UI_END_MEASURE(g.leg_w[g.legs - 1]), leg_h);
}

static void story_create(ui_module_t *w, lv_obj_t *par, bool lead)
{
    ui_w_story_t *g = &w->w.story;

    g->kicker = md_caps(par, 0, 0, 10, LV_TEXT_ALIGN_LEFT, "");
    g->head   = md_block(par, UI_F_LEAD, UI_MOD_HEAD_LH_0);
    g->deck   = md_block(par, UI_F_DECK, UI_MOD_DECK_LH);
    g->byline = md_caps(par, 0, 0, 10, LV_TEXT_ALIGN_LEFT, "");

    if (lead) {
        art_create(&g->art, par);
        /* Untracked: a caption is a sentence, and +2 px a character on running
         * lower case wastes a fifth of the measure and reads letter by letter.
         * The credit is caps and takes the tracking. */
        g->cap  = ui_lab_w(par, 0, 0, 10, UI_F_LABEL, LV_TEXT_ALIGN_LEFT, "");
        g->cred = md_caps(par, 0, 0, 10, LV_TEXT_ALIGN_RIGHT, "");
    }

    g->hair = ui_rule(par, 0, 0, 1, UI_RULE_HAIR);
    for (int i = 0; i < UI_LEGS_MAX; i++)     g->leg[i] = md_leg(par, UI_F_BODY, UI_MOD_BODY_LH);
    for (int i = 0; i < UI_LEGS_MAX - 1; i++) g->leg_rule[i] = ui_vrule(par, 0, 0, 1, UI_RULE_HAIR);
    g->end = ui_fill(par, 0, 0, UI_END_SIDE, UI_END_SIDE);
}

/* --- DOSSIER --------------------------------------------------------------
 *
 * The company's figures, set as a GRID OF GROUPED CARDS under a band of hero
 * numbers. It was a tall thin rail of label-over-value lines running the whole
 * depth of the well, and the owner rejected that shape twice — the second time
 * pointing at a card grid and asking for the indicators "cleanly", which is what
 * this is.
 *
 * WHAT A CARD IS, AND WHY IT IS NOT A BOX
 * ---------------------------------------
 * One card is one GROUP: the standing head the producer sorted the figures
 * under, a hairline, and the group's figures as label-left / value-right rows.
 * The reference the owner pointed at draws a filled, rounded box around each
 * one. This panel cannot: a rounded corner dithers, a tinted panel is the one
 * grey object on a sheet of white paper, and a grid of boxes is what the printed
 * statement's own comment already refuses — a broadsheet's tables are ruled
 * horizontally and never boxed. A caps head over a rule IS the card here, and it
 * is the same object a newspaper has always used to head a column of figures.
 *
 * A GROUP OF ONLY HERO FIGURES GETS NO CARD. The head would stand over nothing;
 * the hero carries its own label and says what it is.
 *
 * THE HERO BAND GOES ON TOP, AND THAT IS A DEPARTURE FROM THE REFERENCE
 * --------------------------------------------------------------------
 * The reference puts its two or three big single numbers UNDER the cards. Two
 * reasons this page puts them over:
 *
 *   A hero is 60 px taller than a small row, so a hero left inside its own card
 *   makes that card taller than the three beside it — and cards of unequal
 *   height in one row is exactly the ragged list the grid replaces. Lifting
 *   every hero out is what lets a row of cards be one height.
 *
 *   On a day with no stories this module IS the front page's lead, at three or
 *   four columns and in the display face. The largest type on the sheet cannot
 *   sit below a grid of small figures; the page would read upside down. On the
 *   rail the same order puts the price's 52-week band at the top of the spine,
 *   which is where a range belongs.
 *
 * THE GRID IS THE ONLY FORM, INCLUDING AT ONE COLUMN
 * -------------------------------------------------
 * There is no second renderer for the rail. At 170 px the arithmetic below
 * answers one card across, so the cards stack — which is the rail, with its
 * heroes gathered at the head of it instead of scattered down it. One code path
 * is why a measurement and a placement cannot disagree, and it is the only
 * reason the natural height below can be trusted.
 *
 * THE NATURAL HEIGHT IS PER ROW OF CARDS, NOT PER GRID
 * ---------------------------------------------------
 * Every card in ONE ROW is the height of the deepest card in that row, so the
 * heads and the first rows line up across the grid, which is the whole of what
 * makes it read as clean. It is deliberately not the deepest card in the whole
 * GRID: at one column every card is its own row, and charging all four the
 * deepest one's depth would spend two hundred pixels of a 1,338 px well on white
 * — worse than the fault being fixed, and for nothing, because a stacked card
 * has no neighbour to line up with.
 *
 * ui_dossier_natural_h() is that sum, and it is a pure function of the snapshot
 * and the measure. ui_page_front.c's build() says in a comment that the thin day
 * is unfixable without it: the dossier is unconditionally elastic and should be
 * elastic only when it has the figures to fill what the promotion would give it.
 * That is the number to ask.
 *
 * WHAT A CARD CAN HOLD, MEASURED RATHER THAN BUDGETED
 * --------------------------------------------------
 * The old budget — a label of 20 characters and a value of 16 — came from both
 * sitting in one 170 px column. A card is 234 to 364 px, so nothing is budgeted:
 * fig_small_rows() measures the label, the value and the change at the card's own
 * width and answers one row, two or three, and NONE of them ellipsizes. In a
 * reference grid the value is what the reader came for and the label is what says
 * which value it is; there is no third string on the page to reconstruct either
 * from, so a row costs 18 px and a cut label costs the figure.
 */
#define MD_FIG_MARK        10
#define MD_FIG_CHG_GAP      4

#define MD_GROUP_ADV  (UI_FIG_GROUP_H + UI_FIG_GROUP_RULE_DY + UI_RULE_HAIR \
                       + UI_FIG_GROUP_GAP)

/* The card a measure is divided into, and the widest one worth setting.
 *
 * 280 px is the target: the grid takes the nearest whole number of them, which
 * answers four cards at the 1,140 px measure, three at 946 and 752, two at 558
 * and one at 364 and at the rail's 170. Those are the spans the six-column grid
 * actually produces, but the compositor is free to cut a region to any even
 * width, so the ceiling is enforced separately — a card past 380 px sets its
 * value the better part of a foot away from its own label, which is a row the eye
 * cannot carry across.
 *
 * Both numbers are widths in px and neither is a character count: the advances
 * behind them are label_14's and body_16's, and `sim --measure` is the authority
 * on those. Nothing here transcribes one. */
#define MD_CARD_W         280
#define MD_CARD_MAX_W     380
#define MD_CARD_COLS_MAX    4

/* Paper between two rows of cards, between two figures inside a card, between
 * two rows of heroes, and under the hero band. */
#define MD_CARD_GAP        16
#define MD_CARD_ROW_GAP     6
#define MD_HERO_GAP        14
#define MD_HERO_BAND_GAP   20

/* How far a gap may open when the module was given more room than its figures
 * need. Three times, and then it stops.
 *
 * This module runs the full depth of whatever it was given, so it is the one
 * most likely to be handed a surplus, and giving all of it back as leading is
 * what ui_page_front.c's build() comment describes as WORSE than the hole it was
 * fixing: eighty pixels between two one-line entries, down the whole height of a
 * sheet, reads as broken rather than as generous. Past the cap the module stops
 * and says so through ui_module_t::ink_h, and the rules beside it stop with it —
 * a page is allowed to end. */
#define MD_GAP_STRETCH      3

/* display_36 sets at 41, plus the same five pixels of leading UI_FIG_VALUE_H
 * gives body_20, so both shapes stack the same way. */
#define MD_FIG_VALUE_H_LG  46
#define MD_FIG_BAR_GAP      6
#define MD_FIG_BAR_H        (2 * MD_RANGE_TICK + 1)

static bool new_group(const news_t *v, int i)
{
    return i == 0 || strcmp(v->figures[i].group, v->figures[i - 1].group) != 0;
}

static bool fig_hero(const news_figure_t *f)
{
    return f->emph != 0;
}

/* How wide the figure wants, and how wide its label wants beside it. Both are
 * measured rather than apportioned, because the two are different KINDS of
 * string — a label is tracked caps and a value is lining figures — and a fixed
 * split gets one of them wrong at every width. */
static int fig_value_w(const news_figure_t *f)
{
    return md_text_w(UI_F_BODY, f->value, 0);
}

static int fig_label_w(const news_figure_t *f)
{
    char up[NEWS_FIG_LABEL_MAX + 8];
    ui_upper(up, sizeof up, f->label);
    return md_text_w(UI_F_LABEL, up, MD_TRACK);
}

/* The room a change costs beside a figure: its mark, the paper after it, and the
 * percentage itself. Zero when the figure has none, which is most of them — a
 * share count and a listing date have no change and must print with no mark and
 * no colour at all. */
static int fig_chg_w(const news_figure_t *f)
{
    char pct[16];

    if (!f->has_chg) return 0;
    ui_pct(pct, sizeof pct, f->chg_bp);
    return MD_FIG_MARK + MD_FIG_CHG_GAP + md_text_w(UI_F_LABEL, pct, 0);
}

/* How many LINES a small figure needs at this card width, and it is the whole of
 * a card's layout decision:
 *
 *   1  the label, the value and any change share one line — the shape a card is
 *      for, and the one nearly every figure takes once a card is 234 px or wider
 *   2  the label over the value, with the change riding on the value's line
 *   3  label over value over change, the last resort for a narrow card carrying
 *      a long value AND a change
 *
 * EVERY BRANCH IS MEASURED AND NONE OF THEM ELLIPSIZES — see the section note.
 * Pure in (figure, width), which is what lets the natural height and the
 * placement agree without passing a flag between them. */
static int fig_small_rows(const news_figure_t *f, int colw)
{
    const int lw = fig_label_w(f);
    const int vw = fig_value_w(f);
    const int cw = fig_chg_w(f);
    const int rw = vw + (cw ? MD_FIELD_GAP + cw : 0);

    if (lw + MD_FIELD_GAP + rw <= colw) return 1;
    if (rw <= colw)                     return 2;
    return 3;
}

/* --- the shape a measure gives the grid ----------------------------------- */

typedef struct {
    int              ncols, pitch, colw;      /* the cards                  */
    int              hcols, hpitch, hcolw;    /* the hero band              */
    int              value_h;
    const lv_font_t *value_f;
} grid_shape_t;

/* Every span and every origin below is forced EVEN. A photo tile is not blitted
 * into this module, but the rule is the grid's and not the photograph's — see
 * ui_internal.h's static assertion — and a module that quietly starts a column on
 * an odd x is the one place a later photograph would inherit it from. */
static int md_even(int v)
{
    return v & ~1;
}

static void grid_shape(grid_shape_t *s, int w, int heroes)
{
    if (w < 2) w = 2;

    s->ncols = (w + MD_CARD_W / 2) / MD_CARD_W;
    if (s->ncols < 1)               s->ncols = 1;
    if (s->ncols > MD_CARD_COLS_MAX) s->ncols = MD_CARD_COLS_MAX;

    /* The ceiling, applied after the target rather than folded into it: the
     * compositor may cut a region to a width the six-column grid never produces,
     * and a 500 px card is a label and a value at opposite ends of a line. */
    while (s->ncols < MD_CARD_COLS_MAX
           && (w - (s->ncols - 1) * UI_GUTTER) / s->ncols > MD_CARD_MAX_W) {
        s->ncols++;
    }

    s->pitch = md_even((w + UI_GUTTER) / s->ncols);
    s->colw  = s->pitch - UI_GUTTER;
    if (s->colw < 2) {
        s->ncols = 1;
        s->pitch = md_even(w + UI_GUTTER);
        s->colw  = md_even(w);
    }

    /* The heroes take the same columns unless there are fewer of them than
     * columns, in which case they spread over the whole measure — two heroes on a
     * four-card grid are two big numbers, not two big numbers and a hole. */
    s->hcols = heroes > 0 && heroes < s->ncols ? heroes : s->ncols;
    if (s->hcols < 1) s->hcols = 1;

    s->hpitch = md_even((w + UI_GUTTER) / s->hcols);
    s->hcolw  = s->hpitch - UI_GUTTER;
    if (s->hcolw < 2) {
        s->hcols  = 1;
        s->hpitch = md_even(w + UI_GUTTER);
        s->hcolw  = md_even(w);
    }

    /* The face follows the ROLE and not a flag: one card across is the rail
     * beside a headline and sets reference type, more than one IS the page's
     * headline on a day that brought no stories. */
    s->value_f = s->ncols > 1 ? UI_F_HEADLINE : UI_F_BODY_LG;
    s->value_h = s->ncols > 1 ? MD_FIG_VALUE_H_LG : UI_FIG_VALUE_H;
}

/* A hero's ink: the caps label, the value in the module's display face, and
 * whichever of the range bar and the change the producer sent. Both may be
 * present; a price with a 52-week band and a session move is the ordinary case. */
static int hero_ink_h(const grid_shape_t *s, const news_figure_t *f)
{
    int h = UI_FIG_LABEL_H + s->value_h;
    if (f->bar >= 0) h += MD_FIG_BAR_GAP + MD_FIG_BAR_H;
    if (f->has_chg)  h += UI_FIG_LABEL_H;
    return h;
}

/* --- the plan -------------------------------------------------------------
 *
 * Where every figure lands, worked out once from the snapshot and the measure.
 * The placement reads it and the natural height sums it, so the two cannot
 * disagree about a pixel.
 *
 * Indexed by the figure's own index throughout, which is also how the widget
 * pool is indexed — d->label[i] belongs to v->figures[i] on every sheet and at
 * every width, so nothing has to be re-pointed and nothing can be shown for the
 * wrong figure. */
typedef struct {
    grid_shape_t s;

    int      n;                              /* figures the plan covers     */
    int      nh, ncards;                     /* heroes, cards               */
    int      hrows, crows;
    int      hero_h;                         /* one hero cell, fixed        */
    int      rowh[UI_DOSSIER_GROUPS];        /* a card row's content depth  */

    uint8_t  hero[NEWS_FIGURES_MAX];
    int16_t  slot[NEWS_FIGURES_MAX];         /* hero index, or card index   */
    int16_t  fy[NEWS_FIGURES_MAX];           /* y inside the card's body    */
    uint8_t  lines[NEWS_FIGURES_MAX];
    int16_t  card_of[UI_DOSSIER_GROUPS];     /* the figure that names it    */
} grid_plan_t;

static void grid_plan(grid_plan_t *p, const news_t *v, int w)
{
    int heroes = 0;
    for (int i = 0; i < v->figure_count && i < NEWS_FIGURES_MAX; i++) {
        if (fig_hero(&v->figures[i])) heroes++;
    }

    grid_shape(&p->s, w, heroes);

    p->n = p->nh = p->ncards = 0;
    p->hero_h = 0;
    memset(p->rowh, 0, sizeof p->rowh);

    int card = -1, cy = 0;

    for (int i = 0; i < v->figure_count && i < NEWS_FIGURES_MAX; i++) {
        const news_figure_t *f = &v->figures[i];

        /* The producer orders the list and the device does not sort, so a group
         * is a RUN of consecutive figures. A payload whose groups interleave
         * prints repeated heads, which is visible and therefore fixable. */
        if (new_group(v, i)) { card = -1; cy = 0; }

        if (fig_hero(f)) {
            const int hh = hero_ink_h(&p->s, f);
            if (hh > p->hero_h) p->hero_h = hh;

            p->hero[i]  = 1;
            p->slot[i]  = (int16_t)p->nh++;
            p->fy[i]    = 0;
            p->lines[i] = 0;
            p->n = i + 1;
            continue;
        }

        /* The card is opened by the group's first SMALL figure, not by the group
         * — a group of nothing but heroes would otherwise print a standing head
         * over an empty card. */
        if (card < 0) {
            if (p->ncards >= UI_DOSSIER_GROUPS) break;
            card = p->ncards++;
            p->card_of[card] = (int16_t)i;
            cy = 0;
        }

        const int lines = fig_small_rows(f, p->s.colw);

        p->hero[i]  = 0;
        p->slot[i]  = (int16_t)card;
        p->fy[i]    = (int16_t)cy;
        p->lines[i] = (uint8_t)lines;
        p->n = i + 1;

        cy += lines * UI_FIG_LABEL_H + MD_CARD_ROW_GAP;

        /* The row's depth is the deepest card's INK — the trailing gap belongs
         * between two figures and there is nothing under the last one. */
        const int r    = card / p->s.ncols;
        const int deep = cy - MD_CARD_ROW_GAP;
        if (r < UI_DOSSIER_GROUPS && deep > p->rowh[r]) p->rowh[r] = deep;
    }

    p->hrows = p->nh > 0 ? (p->nh + p->s.hcols - 1) / p->s.hcols : 0;
    p->crows = p->ncards > 0 ? (p->ncards + p->s.ncols - 1) / p->s.ncols : 0;
}

/* --- fitting the plan into the height it was given ------------------------ */

typedef struct { int hrows, crows, hgap, bgap, cgap; } grid_fit_t;

static int grid_depth(const grid_plan_t *p, const grid_fit_t *ft)
{
    int h = 0;

    if (ft->hrows > 0) h += ft->hrows * p->hero_h + (ft->hrows - 1) * ft->hgap;
    if (ft->crows > 0) {
        if (ft->hrows > 0) h += ft->bgap;
        for (int r = 0; r < ft->crows; r++) h += MD_GROUP_ADV + p->rowh[r];
        h += (ft->crows - 1) * ft->cgap;
    }
    return h;
}

/* The gaps at their natural size, which is what the natural height is measured
 * with. */
static void grid_fit_tight(grid_fit_t *ft, const grid_plan_t *p)
{
    ft->hrows = p->hrows;
    ft->crows = p->crows;
    ft->hgap  = MD_HERO_GAP;
    ft->bgap  = MD_HERO_BAND_GAP;
    ft->cgap  = MD_CARD_GAP;
}

static void grid_fit(grid_fit_t *ft, const grid_plan_t *p, int h)
{
    grid_fit_tight(ft, p);

    /* TOO TALL: card rows go from the bottom, and the hero band goes last. The
     * heroes are the producer's argument — the two or three figures the day is
     * about — and a module squeezed to a third of what it asked for should still
     * carry them. */
    while (ft->crows > 0 && grid_depth(p, ft) > h) ft->crows--;
    while (ft->hrows > 1 && grid_depth(p, ft) > h) ft->hrows--;

    /* TOO SHORT: the surplus goes back at every gap the grid has, in proportion
     * to what each already was, and no gap opens past MD_GAP_STRETCH. Whatever
     * is left over is paper at the foot and is reported as such — see ink_h. */
    const int base = (ft->hrows > 1 ? (ft->hrows - 1) * ft->hgap : 0)
                   + (ft->hrows > 0 && ft->crows > 0 ? ft->bgap : 0)
                   + (ft->crows > 1 ? (ft->crows - 1) * ft->cgap : 0);
    const int slack = h - grid_depth(p, ft);

    if (slack <= 0 || base <= 0) return;

    int grow = slack;
    if (grow > base * (MD_GAP_STRETCH - 1)) grow = base * (MD_GAP_STRETCH - 1);

    /* In 256ths, so one multiplier serves all three gaps and no gap can be
     * rounded to a different multiple of itself than its neighbour. */
    const int mul = 256 + (grow * 256) / base;
    ft->hgap = MD_HERO_GAP      * mul / 256;
    ft->bgap = MD_HERO_BAND_GAP * mul / 256;
    ft->cgap = MD_CARD_GAP      * mul / 256;
}

/* The y a card row starts at, inside the module. */
static int grid_row_y(const grid_plan_t *p, const grid_fit_t *ft, int row)
{
    int y = ft->hrows > 0
        ? ft->hrows * p->hero_h + (ft->hrows - 1) * ft->hgap + ft->bgap : 0;

    for (int r = 0; r < row; r++) y += MD_GROUP_ADV + p->rowh[r] + ft->cgap;
    return y;
}

int ui_dossier_natural_h(const news_t *v, int w)
{
    grid_plan_t p;
    grid_fit_t  ft;

    if (!v || v->figure_count <= 0) return 0;

    grid_plan(&p, v, w);
    grid_fit_tight(&ft, &p);
    return grid_depth(&p, &ft);
}

/* --- setting it ----------------------------------------------------------- */

/* One card's figure: the label left, the value right, and the change either
 * riding the value's line or dropping under it. Every slot is MEASURED — a fixed
 * split gets one of the two wrong at every width. */
static void card_figure(ui_module_t *inst, ui_w_dossier_t *d,
                        const news_figure_t *f, int i, int cx, int y, int colw)
{
    const int rows = fig_small_rows(f, colw);
    const int cw   = fig_chg_w(f);
    const int vy   = rows == 1 ? y : y + UI_FIG_LABEL_H;
    const int room = colw - (rows <= 2 && cw ? MD_FIELD_GAP + cw : 0);
    const int vw   = fig_value_w(f);

    md_font(d->value[i], UI_F_BODY, UI_FIG_LABEL_H);

    if (rows == 1) {
        md_text_caps(d->label[i], cx, y, room - vw - MD_FIELD_GAP,
                     UI_FIG_LABEL_H, f->label);
    } else {
        md_text_caps(d->label[i], cx, y, colw, UI_FIG_LABEL_H, f->label);
    }

    /* Flush right against whatever the change left, so a card's figures read
     * DOWN — which is the only reason to set them in a column at all. */
    lv_obj_set_style_text_align(d->value[i], LV_TEXT_ALIGN_RIGHT, 0);
    md_text(d->value[i], cx + room - vw, vy, vw, UI_FIG_LABEL_H, f->value);

    if (!cw) { ui_show(d->chg[i], false); return; }

    char pct[16];
    ui_pct(pct, sizeof pct, f->chg_bp);

    /* Three lines means the value needed the whole card, so the change drops
     * beneath it and takes the hero's own shape. */
    const int ry = rows == 3 ? vy + UI_FIG_LABEL_H : vy;
    const int bx = rows == 3 ? 0 : colw - cw;

    lv_obj_set_style_text_color(d->chg[i], ui_chg_colour(f->chg_bp), 0);
    lv_obj_set_style_text_align(d->chg[i], LV_TEXT_ALIGN_LEFT, 0);
    md_text(d->chg[i], cx + bx + MD_FIG_MARK + MD_FIG_CHG_GAP, ry,
            cw - MD_FIG_MARK - MD_FIG_CHG_GAP, UI_FIG_LABEL_H, pct);

    mark_add(inst, cx + bx, ry + (UI_FIG_LABEL_H - MD_FIG_MARK) / 2,
             MD_FIG_MARK, f->chg_bp);
}

/* A hero: the label, the value in the display face, the range bar and the
 * change. The bar is what makes a hero a GRAPHIC rather than a bigger number —
 * where the value sits inside the band the producer chose — and it is drawn in
 * INK, because a position inside a range is not a change and colour on this sheet
 * is reserved for changes. A green range bar would be the page asserting a
 * direction nobody sent. */
static void hero_figure(ui_module_t *inst, ui_w_dossier_t *d,
                        const grid_shape_t *s, const news_figure_t *f,
                        int i, int cx, int y, int colw)
{
    md_text_caps(d->label[i], cx, y, colw, UI_FIG_LABEL_H, f->label);

    const int vy = y + UI_FIG_LABEL_H;
    md_font(d->value[i], s->value_f, s->value_h);
    lv_obj_set_style_text_align(d->value[i], LV_TEXT_ALIGN_LEFT, 0);
    md_text(d->value[i], cx, vy, colw, lv_font_get_line_height(s->value_f),
            f->value);

    int ry = vy + s->value_h;

    if (f->bar >= 0) {
        mark_add_range(inst, cx, ry, colw, f->bar);
        ry += MD_FIG_BAR_H + MD_FIG_BAR_GAP;
    }

    if (!f->has_chg) { ui_show(d->chg[i], false); return; }

    char pct[16];
    ui_pct(pct, sizeof pct, f->chg_bp);

    lv_obj_set_style_text_color(d->chg[i], ui_chg_colour(f->chg_bp), 0);
    lv_obj_set_style_text_align(d->chg[i], LV_TEXT_ALIGN_LEFT, 0);
    md_text(d->chg[i], cx + MD_FIG_MARK + MD_FIG_CHG_GAP, ry,
            colw - MD_FIG_MARK - MD_FIG_CHG_GAP, UI_FIG_LABEL_H, pct);

    mark_add(inst, cx, ry + (UI_FIG_LABEL_H - MD_FIG_MARK) / 2,
             MD_FIG_MARK, f->chg_bp);
}

static void dossier_run(const ui_mod_t *m, const news_t *v, int w,
                        ui_module_t *inst, int *h_min, int *h_pref)
{
    grid_plan_t p;
    grid_fit_t  ft;

    grid_plan(&p, v, w);

    if (!inst) {
        grid_fit_tight(&ft, &p);
        *h_pref = grid_depth(&p, &ft);

        /* The floor is the hero band's first row, or the first row of cards on a
         * file with no heroes in it. Below that there is no grid left to set. */
        ft.hrows = p.hrows > 0 ? 1 : 0;
        ft.crows = p.hrows > 0 ? 0 : (p.crows > 0 ? 1 : 0);
        *h_min = grid_depth(&p, &ft);

        if (*h_pref < 1) *h_pref = 1;
        if (*h_min > *h_pref) *h_min = *h_pref;
        return;
    }

    ui_w_dossier_t *d = &inst->w.dossier;
    const int h = m->h;

    grid_fit(&ft, &p, h);
    inst->mark_n = 0;

    for (int i = 0; i < p.n; i++) {
        const news_figure_t *f = &v->figures[i];

        if (p.hero[i]) {
            const int k = p.slot[i];
            if (k >= ft.hrows * p.s.hcols) {
                ui_show(d->label[i], false);
                ui_show(d->value[i], false);
                ui_show(d->chg[i], false);
                continue;
            }
            const int hr = k / p.s.hcols, hc = k % p.s.hcols;
            hero_figure(inst, d, &p.s, f, i, hc * p.s.hpitch,
                        hr * (p.hero_h + ft.hgap), p.s.hcolw);
            continue;
        }

        const int card = p.slot[i];
        if (card >= ft.crows * p.s.ncols) {
            ui_show(d->label[i], false);
            ui_show(d->value[i], false);
            ui_show(d->chg[i], false);
            continue;
        }

        const int cr = card / p.s.ncols, cc = card % p.s.ncols;
        card_figure(inst, d, f, i, cc * p.s.pitch,
                    grid_row_y(&p, &ft, cr) + MD_GROUP_ADV + p.fy[i],
                    p.s.colw);
    }

    /* The standing heads, one per card that was actually set. Drawn from the
     * card list rather than from the figure walk so that a card whose first
     * figure was dropped still gets its head, and a card that was dropped whole
     * gets none. */
    for (int c = 0; c < UI_DOSSIER_GROUPS; c++) {
        if (c >= ft.crows * p.s.ncols || c >= p.ncards) {
            ui_show(d->group[c], false);
            ui_show(d->grule[c], false);
            continue;
        }
        const int cr = c / p.s.ncols, cc = c % p.s.ncols;
        const int cx = cc * p.s.pitch, cy = grid_row_y(&p, &ft, cr);

        md_text_caps(d->group[c], cx, cy, p.s.colw, UI_FIG_GROUP_H,
                     v->figures[p.card_of[c]].group);
        md_at(d->grule[c], cx, cy + UI_FIG_GROUP_H + UI_FIG_GROUP_RULE_DY,
              p.s.colw, UI_RULE_HAIR);
    }

    for (int i = p.n; i < NEWS_FIGURES_MAX; i++) {
        ui_show(d->label[i], false);
        ui_show(d->value[i], false);
        ui_show(d->chg[i], false);
    }

    /* What the grid actually set, which on a module handed more room than its
     * figures need is less than it was given. The rules beside it stop where the
     * ink does — see ui_module_t::ink_h. */
    inst->ink_h = grid_depth(&p, &ft);
    if (inst->ink_h > h) inst->ink_h = h;

    marks_ready(inst, d->marks, w, h);
}

static void dossier_create(ui_module_t *w, lv_obj_t *par)
{
    ui_w_dossier_t *d = &w->w.dossier;

    for (int i = 0; i < UI_DOSSIER_GROUPS; i++) {
        d->group[i] = md_caps(par, 0, 0, 10, LV_TEXT_ALIGN_LEFT, "");
        d->grule[i] = ui_rule(par, 0, 0, 1, UI_RULE_HAIR);
    }
    for (int i = 0; i < NEWS_FIGURES_MAX; i++) {
        d->label[i] = md_caps(par, 0, 0, 10, LV_TEXT_ALIGN_LEFT, "");
        /* Built at the card's face; a hero re-points it at the display one in
         * md_font(). body_20 is right for a card row, and the wide shape's
         * display_36 is right for a hero, because on a sheet with no headline
         * anywhere the hero IS the headline. */
        d->value[i] = ui_lab_w(par, 0, 0, 10, UI_F_BODY_LG,
                               LV_TEXT_ALIGN_LEFT, "");
        d->chg[i]   = ui_lab_w(par, 0, 0, 10, UI_F_LABEL,
                               LV_TEXT_ALIGN_RIGHT, "");
    }
    d->marks = marks_pane(w, par);
}

/* --- CHART ----------------------------------------------------------------
 *
 * Small, and inside a module rather than as a band of its own. A page of charts
 * is a terminal; a page of prose with one chart in it is a newspaper.
 *
 * A CHART'S HEIGHT IS A FUNCTION OF ITS WIDTH, and that is the whole of what
 * makes it a chart. It used to be elastic — the reasoning being that a chart is
 * indifferent to its own height, so it was the honest place to put the room
 * nobody else could use. It is not indifferent: a payload with no stories on it
 * produced a 170 px column run to the full 1,300 px depth of the well, which is
 * not a price series, it is a seismograph. The aspect ratio is the bound, the
 * module is inelastic, and a page that has room left over has to spend it
 * somewhere that is not inside a plot. */
#define MD_CHART_ASPECT_N  6        /* the plot is never taller than 6/5 of */
#define MD_CHART_ASPECT_D  5        /* its own width                        */

static void chart_run(const ui_mod_t *m, const news_t *v, int w,
                      ui_module_t *inst, int *h_min, int *h_pref)
{
    const news_chart_t *c = &v->charts[m->src];
    const int furniture = UI_CHART_HEAD_H + UI_CHART_HEAD_GAP
                        + UI_CHART_NOTE_GAP + UI_CHART_NOTE_H;
    const int tall = w * MD_CHART_ASPECT_N / MD_CHART_ASPECT_D;

    if (!inst) {
        /* A column too narrow to carry a plot at a legible aspect asks for a
         * height no band can grant, which is how a module removes itself: the
         * compositor drops from the foot until what is left fits, and a page
         * with no chart on it is better than a page with a sliver of one. On
         * this sheet the narrowest module is a 170 px column and the case cannot
         * arise; it is here because the grid is the caller's, not this file's. */
        if (tall < UI_CHART_MIN_PLOT) {
            *h_min = *h_pref = UI_WELL_H + 1;
            return;
        }

        /* Two thirds of the measure, which is a chart's proportion rather than a
         * number: a wide box wants a taller plot or the series flattens into a
         * horizon. UI_CHART_PLOT_PREF is the floor under it — at the rail's one
         * column two thirds is 113 px, and 150 is what the header says a plot
         * is worth — and the aspect bound above is the ceiling. */
        int plot = (w * 2) / 3;
        if (plot < UI_CHART_PLOT_PREF) plot = UI_CHART_PLOT_PREF;
        if (plot > tall)               plot = tall;

        *h_min  = furniture + UI_CHART_MIN_PLOT;
        *h_pref = furniture + plot;
        return;
    }

    ui_w_chart_t *g = &inst->w.chart;
    char head[NEWS_FIG_LABEL_MAX + 16];

    snprintf(head, sizeof head, "%s%s%s", c->label,
             c->label[0] && c->span[0] ? " · " : "", c->span);
    md_text_caps(g->head, 0, 0, w, UI_CHART_HEAD_H, head);

    const int py = UI_CHART_HEAD_H + UI_CHART_HEAD_GAP;
    int ph = m->h - py - UI_CHART_NOTE_GAP - UI_CHART_NOTE_H;
    if (ph > tall) ph = tall;
    if (ph < 1)    ph = 1;

    /* The widget is re-sized before it is filled: ui_chart_set() lays its two
     * value labels out against the box it was told about, and a chart that
     * changed width between two compositions would hang them off the old one. */
    ui_chart_resize(g->plot, w, ph);
    lv_obj_set_pos(g->plot, 0, py);
    ui_chart_set(g->plot, c);
    ui_show(g->plot, true);

    /* The note is DROPPED rather than ellipsized when the measure cannot hold
     * it. Body copy that stops is a column ending; a caption that stops is a
     * visible "…" under a picture, and it is the first thing a reader's eye
     * catches on. A one-column chart cannot set "Quarterly revenue, $ millions"
     * at any size this sheet uses, and no note at all is the better answer. */
    const int ny = py + ph + UI_CHART_NOTE_GAP;
    if (c->note[0] && caps_fits(UI_F_LABEL, w, c->note)) {
        md_text(g->note, 0, ny, w, UI_CHART_NOTE_H, c->note);
        inst->ink_h = ny + UI_CHART_NOTE_H;
    } else {
        ui_show(g->note, false);
        inst->ink_h = py + ph;
    }
}

static void chart_create(ui_module_t *w, lv_obj_t *par)
{
    ui_w_chart_t *g = &w->w.chart;

    g->head = md_caps(par, 0, 0, 10, LV_TEXT_ALIGN_LEFT, "");
    g->plot = ui_chart_create(par, 0, 0, 10, 10);
    /* Untracked, and in the LABEL face rather than the body one. The note is a
     * caption — "Weekly close, in dollars" — under a module that is often a
     * single 170 px column, and at body_16 that measure sets 21 characters:
     * every note the producer can write ellipsizes, which is worse than no note
     * at all. label_14 sets 26 of them and is the size a caption is set at
     * everywhere else on the sheet. (`sim --measure` is where both numbers come
     * from; they are means over English prose and they move when a face is
     * regenerated.) */
    g->note = ui_lab_w(par, 0, 0, 10, UI_F_LABEL, LV_TEXT_ALIGN_LEFT, "");
}

/* --- BRIEFS ---------------------------------------------------------------
 *
 * What else happened to this company this week, in the space a headline would
 * take. Not stories: no body, never given a leg. */
#define MD_BRIEF_HEAD  (UI_MOD_KICKER_H + MD_RULE_DY + UI_RULE_HAIR + MD_ITEM_GAP)

/* The fewest items that are still a LIST — see the floor in briefs_run(). */
#define MD_BRIEF_MIN_ITEMS  3

static int brief_h(const news_t *v, int i, int w, int max_lines)
{
    int n = md_lines(UI_F_BODY, w, v->briefs[i].text);
    if (n > max_lines) n = max_lines;
    if (n < 1) n = 1;
    return UI_MOD_KICKER_H + 2 + md_box(UI_F_BODY, UI_MOD_BODY_LH, n);
}

static void briefs_run(const ui_mod_t *m, const news_t *v, int w,
                       ui_module_t *inst, int *h_min, int *h_pref)
{
    (void)m;

    if (!inst) {
        int y = MD_BRIEF_HEAD;

        /* THREE items, each cut to one line, is the least this module can be and
         * still be what its standing head says it is. IN BRIEF over a single
         * dated paragraph is not a briefs column — it is one orphaned item with a
         * section heading on top of it, which reads as the page having lost the
         * rest. Two is a pair. Three is a list, and a list is what the head
         * promises.
         *
         * Stated at ONE LINE each rather than at their real depth so the floor
         * stays a floor: this is the tight version of doing the job, not the
         * comfortable one. See ui_compose.h — on a crowded page every module
         * lands exactly here, so this is a description of the squeezed page and
         * not an emergency. */
        int need = MD_BRIEF_HEAD;
        for (int i = 0; i < v->brief_count && i < MD_BRIEF_MIN_ITEMS; i++) {
            need += brief_h(v, i, w, 1)
                  + (i > 0 ? MD_ITEM_GAP + UI_RULE_HAIR + MD_ITEM_GAP : 0);
        }
        *h_min = need;

        for (int i = 0; i < v->brief_count; i++) {
            y += brief_h(v, i, w, 4) + (i + 1 < v->brief_count
                                        ? MD_ITEM_GAP + UI_RULE_HAIR + MD_ITEM_GAP
                                        : 0);
        }
        *h_pref = y;
        if (*h_pref < *h_min) *h_pref = *h_min;
        return;
    }

    ui_w_briefs_t *g = &inst->w.briefs;
    const int h = m->h;

    md_text(g->head, 0, 0, w, UI_MOD_KICKER_H, S_IN_BRIEF);
    md_at(g->hair, 0, UI_MOD_KICKER_H + MD_RULE_DY, w, UI_RULE_HAIR);

    /* How many items the column holds, then the leftover shared out between
     * them: a briefs column that stops halfway down its box is the hole this
     * whole rebuild is about. */
    int n = 0, y = MD_BRIEF_HEAD;
    for (int i = 0; i < v->brief_count; i++) {
        const int need = brief_h(v, i, w, 4)
                       + (i > 0 ? MD_ITEM_GAP + UI_RULE_HAIR + MD_ITEM_GAP : 0);
        if (y + need > h) break;
        y += need;
        n++;
    }
    if (n == 0 && v->brief_count > 0) n = 1;

    /* NOTHING is done with the leftover. The items sit at their own spacing and
     * paper under the last one stays paper, closed by md_close().
     *
     * This spread the slack between the items once, and it was the same mistake
     * the tables made: on a column of six the extra reads as leading, and on a
     * column of two it prints one brief at the top of the page and one at the
     * foot with the whole of a broadsheet column between them. Capping it only
     * moved the hole. A list of dated one-liners cannot absorb height, so it now
     * says so — see its `elastic` in ui_page_front.c — and the room goes between
     * the bands instead, where a quiet page is entitled to it. */
    y = MD_BRIEF_HEAD;
    for (int i = 0; i < NEWS_BRIEFS_MAX; i++) {
        if (i >= n) {
            ui_show(g->when[i], false);
            ui_show(g->text[i], false);
            ui_show(g->rule[i], false);
            continue;
        }
        /* rule[0] is never a separator — the first item has nothing above it —
         * so it is the one this module closes with, and the separators run from
         * rule[1]. One array, two jobs, no widget built for a case that cannot
         * happen. */
        if (i > 0) {
            md_at(g->rule[i], 0, y + MD_ITEM_GAP, w, UI_RULE_HAIR);
            y += MD_ITEM_GAP + UI_RULE_HAIR + MD_ITEM_GAP;
        }

        const news_brief_t *b = &v->briefs[i];
        char line[NEWS_KICKER_MAX + 20];
        snprintf(line, sizeof line, "%s%s%s", b->date,
                 b->date[0] && b->kicker[0] ? " · " : "", b->kicker);
        md_text_caps(g->when[i], 0, y, w, UI_MOD_KICKER_H, line);

        int bl = md_lines(UI_F_BODY, w, b->text);
        if (bl > 4) bl = 4;
        if (bl < 1) bl = 1;
        md_text(g->text[i], 0, y + UI_MOD_KICKER_H + 2, w,
                md_box(UI_F_BODY, UI_MOD_BODY_LH, bl), b->text);
        y += brief_h(v, i, w, 4);

        if (i == n - 1) {
            md_close(g->rule[0], y + MD_ITEM_GAP, w, h);
            inst->ink_h = y + MD_ITEM_GAP + UI_RULE_HAIR;
        }
    }
}

static void briefs_create(ui_module_t *w, lv_obj_t *par)
{
    ui_w_briefs_t *g = &w->w.briefs;

    g->head = md_caps(par, 0, 0, 10, LV_TEXT_ALIGN_LEFT, S_IN_BRIEF);
    g->hair = ui_rule(par, 0, 0, 1, UI_RULE_HAIR);
    for (int i = 0; i < NEWS_BRIEFS_MAX; i++) {
        g->when[i] = md_caps(par, 0, 0, 10, LV_TEXT_ALIGN_LEFT, "");
        g->text[i] = md_block(par, UI_F_BODY, UI_MOD_BODY_LH);
        g->rule[i] = ui_rule(par, 0, 0, 1, UI_RULE_HAIR);
    }
}

/* --- PEERS ----------------------------------------------------------------
 *
 * The industry, as a ruled table. Rows are ruled horizontally and not boxed: a
 * grid of boxes on this panel is a lot of black, and a broadsheet's tables have
 * never been drawn that way.
 *
 * A narrow module DROPS a field rather than squeezing all six. Six fields
 * squeezed into 364 px ellipsize into unreadable stubs, and a table of stubs is
 * worse than a table of four honest columns — so the fields go in a fixed order
 * of usefulness and the module keeps what fits. */
enum { PF_SYM = 0, PF_NAME, PF_PE, PF_CAP, PF_LAST, PF_CHG };

/* Each field's minimum is the widest of three things: its own HEAD in tracked
 * label_14, its figures in body_16, and its figures in body_20 — because the
 * SUBJECT's row is set in the heavier face and it is the row a reader came to
 * the table for. A head that ellipsizes to "SYM…" over a column of readable
 * symbols is the table saying it ran out of room when it did not, and a P/E of
 * "22…." in the one row that matters is worse than that. */
static const int PEER_MIN_W[UI_PEER_FIELDS] = { 74, 100, 68, 80, 84, 84 };
static const int PEER_DROP[UI_PEER_FIELDS]  = { PF_NAME, PF_PE, PF_CAP,
                                                PF_LAST, PF_CHG, PF_SYM };

/* Which fields a module of `w` keeps, and where each of them sits. Returns the
 * number kept; `x` and `cw` are indexed by field. */
static int peer_fields(int w, bool keep[UI_PEER_FIELDS],
                       int x[UI_PEER_FIELDS], int cw[UI_PEER_FIELDS])
{
    for (int i = 0; i < UI_PEER_FIELDS; i++) keep[i] = true;

    int n = UI_PEER_FIELDS;
    for (int d = 0; d < UI_PEER_FIELDS - 1; d++) {
        int need = (n - 1) * MD_FIELD_GAP;
        for (int i = 0; i < UI_PEER_FIELDS; i++) if (keep[i]) need += PEER_MIN_W[i];
        if (need <= w) break;
        keep[PEER_DROP[d]] = false;
        n--;
    }

    int used = (n - 1) * MD_FIELD_GAP;
    for (int i = 0; i < UI_PEER_FIELDS; i++) if (keep[i]) used += PEER_MIN_W[i];

    /* The surplus goes to the name, which is the one field that is prose and
     * the one that gains from every pixel. With no name column it is shared out
     * among the figures, where it becomes air between the columns rather than a
     * ragged right edge. */
    int spare = w - used;
    if (spare < 0) spare = 0;

    int at = 0;
    for (int i = 0; i < UI_PEER_FIELDS; i++) {
        if (!keep[i]) { x[i] = 0; cw[i] = 0; continue; }
        cw[i] = PEER_MIN_W[i];
        if (keep[PF_NAME]) { if (i == PF_NAME) cw[i] += spare; }
        else               { cw[i] += spare / n; }
        x[i] = at;
        at += cw[i] + MD_FIELD_GAP;
    }
    return n;
}

#define MD_PEER_HEAD (UI_MOD_KICKER_H + MD_RULE_DY + UI_RULE_HAIR + 6 \
                      + UI_TAB_HEAD_H + MD_RULE_DY + UI_RULE_HAIR + 4)

/* The fewest rows that are still a COMPARISON: the company the edition is about,
 * and two others to put it between. Below that the module has stopped doing its
 * job — one row is not a comparison, it is a quotation with a table's furniture
 * over it, and two is a pair with no sense of where the pair sits.
 *
 * This number is the whole of ui_compose.h's h_min argument in one place. A
 * module that understates its minimum is never dropped, because the compositor
 * drops only when even the minimums will not fit; it is simply squeezed, and it
 * then occupies space while saying something false. THE INDUSTRY printed one row
 * on the demo front page — and the row was Micron, not Sandisk — which is not a
 * short table, it is a misleading one. Stating the real floor is what lets the
 * page drop it and spend the room on something that can finish a sentence. */
#define MD_PEER_MIN_ROWS 3

static int peer_min_rows(const news_t *v)
{
    return v->peer_count < MD_PEER_MIN_ROWS ? v->peer_count : MD_PEER_MIN_ROWS;
}

static void peers_run(const ui_mod_t *m, const news_t *v, int w,
                      ui_module_t *inst, int *h_min, int *h_pref)
{
    (void)m;
    int rows = v->peer_count;

    if (!inst) {
        *h_min  = MD_PEER_HEAD + peer_min_rows(v) * UI_TAB_ROW_H;
        *h_pref = MD_PEER_HEAD + rows * UI_TAB_ROW_H;
        if (*h_pref < *h_min) *h_pref = *h_min;
        return;
    }

    ui_w_peers_t *g = &inst->w.peers;
    const int h = m->h;

    /* AS MANY ROWS AS THE RECTANGLE HOLDS, and not one more.
     *
     * The compositor is entitled to hand a module less than its h_min — when
     * everything on the page is over its minimum it clamps rather than dropping,
     * because a page with one crowded table beats a page with nothing. A renderer
     * that printed all six rows anyway would draw them straight through whatever
     * is underneath: the pane clips the INK, so the sheet looks merely truncated,
     * but the label boxes still land on the module below and the first thing that
     * notices is the overlap check. Printing what fits is the honest answer and
     * the one that keeps the widget tree agreeing with the glass. */
    const int fit = (h - MD_PEER_HEAD) / UI_TAB_ROW_H;
    if (rows > fit) rows = fit;
    if (rows < 1)   rows = 1;

    bool keep[UI_PEER_FIELDS];
    int  fx[UI_PEER_FIELDS], fw[UI_PEER_FIELDS];
    peer_fields(w, keep, fx, fw);

    /* TOP-ALIGNED AND TIGHT: the rows sit at their natural pitch whatever depth
     * the module was given, and paper left over stays paper.
     *
     * This stretched once, up to three times the pitch, and it was the wrong
     * instinct. A ruled table is not a thing that can be set generously — every
     * pixel of extra leading between two rows of figures is a pixel of doubt
     * about whether they belong to the same table, and at three times the pitch
     * a five-row comparison reads as five unrelated lines. The room a thin day
     * leaves over belongs between the BANDS, where it reads as a quiet page;
     * inside a table it reads as a defect. md_close() rules under the last row so
     * the block ends rather than trailing off. */
    const int pitch = UI_TAB_ROW_H;

    md_text(g->head, 0, 0, w, UI_MOD_KICKER_H, S_PEERS);
    md_at(g->hair, 0, UI_MOD_KICKER_H + MD_RULE_DY, w, UI_RULE_HAIR);

    static const char *const HEAD[UI_PEER_FIELDS] = {
        S_COL_SYMBOL, S_COL_NAME, S_COL_PE, S_COL_CAP, S_COL_LAST, S_COL_CHG,
    };
    const int hy = UI_MOD_KICKER_H + MD_RULE_DY + UI_RULE_HAIR + 6;
    for (int i = 0; i < UI_PEER_FIELDS; i++) {
        if (!keep[i]) { ui_show(g->col[i], false); continue; }
        lv_obj_set_style_text_align(g->col[i],
                                    i <= PF_NAME ? LV_TEXT_ALIGN_LEFT
                                                 : LV_TEXT_ALIGN_RIGHT, 0);
        md_text(g->col[i], fx[i], hy, fw[i], UI_TAB_HEAD_H, HEAD[i]);
    }

    const int top   = MD_PEER_HEAD;
    const int inset = (pitch - lv_font_get_line_height(UI_F_BODY)) / 2;

    inst->mark_n = 0;

    /* WHICH rows, not just how many.
     *
     * Truncating to the first `rows` of the payload drops whichever competitors
     * the producer happened to list last — and on the demo front page it dropped
     * SANDISK, the company the whole edition is about, leaving a table headed THE
     * INDUSTRY that listed Micron and nothing else. A comparison that omits its
     * own subject is not short, it is wrong: the reader has no way to see that
     * the row they came for was cut rather than absent from the industry.
     *
     * So the subject takes the last slot whenever it would have fallen outside
     * it. Payload order is otherwise untouched, and the result is still
     * ascending, so the table reads the way the producer filed it. */
    int pick[NEWS_PEERS_MAX];
    for (int r = 0; r < rows; r++) pick[r] = r;

    int subject = -1;
    for (int r = 0; r < v->peer_count; r++) {
        if (v->peers[r].is_subject) { subject = r; break; }
    }
    if (subject >= rows && rows > 0) pick[rows - 1] = subject;

    for (int r = 0; r < NEWS_PEERS_MAX; r++) {
        if (r >= rows) {
            for (int i = 0; i < UI_PEER_FIELDS; i++) ui_show(g->cell[r][i], false);
            ui_show(g->rule[r], false);
            continue;
        }

        const news_peer_t *p = &v->peers[pick[r]];
        const int y = top + r * pitch;
        char last[24], pct[16];

        ui_money(last, sizeof last, p->last_c);
        ui_pct(pct, sizeof pct, p->chg_bp);

        const char *txt[UI_PEER_FIELDS] = {
            p->symbol, p->name, p->per, p->cap, last, pct,
        };

        for (int i = 0; i < UI_PEER_FIELDS; i++) {
            if (!keep[i]) { ui_show(g->cell[r][i], false); continue; }

            /* The subject's own row in the heavier face. It is the reason the
             * table is on the page: a reader scanning six symbols for the one
             * the edition is about should not have to read them. */
            lv_obj_set_style_text_font(g->cell[r][i],
                                       p->is_subject ? UI_F_BODY_LG : UI_F_BODY, 0);
            lv_obj_set_style_text_align(g->cell[r][i],
                                        i <= PF_NAME ? LV_TEXT_ALIGN_LEFT
                                                     : LV_TEXT_ALIGN_RIGHT, 0);
            lv_obj_set_style_text_color(g->cell[r][i],
                                        i == PF_CHG ? ui_chg_colour(p->chg_bp)
                                                    : UI_INK, 0);

            const int cx = (i == PF_CHG) ? fx[i] + MD_FIG_MARK + MD_FIG_CHG_GAP
                                         : fx[i];
            const int cwid = (i == PF_CHG) ? fw[i] - MD_FIG_MARK - MD_FIG_CHG_GAP
                                           : fw[i];
            md_text(g->cell[r][i], cx, y + inset, cwid,
                    lv_font_get_line_height(UI_F_BODY_LG),
                    txt[i][0] ? txt[i] : S_EMPTY_CELL);
        }
        if (keep[PF_CHG]) {
            mark_add(inst, fx[PF_CHG],
                     y + inset + (lv_font_get_line_height(UI_F_BODY) - MD_FIG_MARK) / 2,
                     MD_FIG_MARK, p->chg_bp);
        }

        if (r + 1 < rows) md_at(g->rule[r], 0, y + pitch - UI_RULE_HAIR, w,
                                UI_RULE_HAIR);
        else              md_close(g->rule[r], y + pitch, w, h);
    }
    inst->ink_h = top + rows * pitch + UI_RULE_HAIR;
    marks_ready(inst, g->marks, w, h);
}

static void peers_create(ui_module_t *w, lv_obj_t *par)
{
    ui_w_peers_t *g = &w->w.peers;

    g->head = md_caps(par, 0, 0, 10, LV_TEXT_ALIGN_LEFT, S_PEERS);
    g->hair = ui_rule(par, 0, 0, 1, UI_RULE_HAIR);
    for (int i = 0; i < UI_PEER_FIELDS; i++) {
        g->col[i] = md_caps(par, 0, 0, 10, LV_TEXT_ALIGN_LEFT, "");
    }
    for (int r = 0; r < NEWS_PEERS_MAX; r++) {
        for (int i = 0; i < UI_PEER_FIELDS; i++) {
            g->cell[r][i] = ui_lab_w(par, 0, 0, 10, UI_F_BODY,
                                     LV_TEXT_ALIGN_LEFT, "");
        }
        g->rule[r] = ui_rule(par, 0, 0, 1, UI_RULE_HAIR);
    }
    g->marks = marks_pane(w, par);
}

/* --- TABLE ----------------------------------------------------------------
 *
 * A quarterly statement, PRINTED as a grid of figures or DRAWN as a graphic,
 * according to the table's own `render`. Every printed cell is text because the
 * producer owns the house decision about "10,584", "(1,203)" and "—", and
 * columns run OLDEST FIRST because that is how a financial statement is set.
 *
 * A module too narrow for every quarter drops the OLDEST of them, which is the
 * one direction the drop can go: the newest column is the one the page is
 * about, and a table that quietly lost its last quarter would be a table
 * disagreeing with the headline over it.
 *
 * ONE MODULE KIND AND NOT THREE
 * -----------------------------
 * The compositor never learns there was a choice. Which of the three a set of
 * numbers deserves is the producer's judgement and travels with the numbers, and
 * nothing about WHERE the module goes changes with the answer — a drawn table
 * wants the same columns, the same rank and the same neighbours a printed one
 * does. Three module kinds would have put that judgement in the page files,
 * where it would have to be made twice and could disagree with itself.
 *
 * WHY EIGHTEEN CELLS BECOME A PICTURE
 * -----------------------------------
 * Six quarters of revenue, profit and margin printed as eighteen numbers is a
 * thing the reader has to assemble in their head. The same eighteen as bars with
 * a line over them is a thing they see. That is the owner's request — colour and
 * charts in the middle of a paper of words and pictures — and it is also what
 * every annual report opens with, because it works.
 *
 * A DRAWN TABLE FALLS BACK TO A PRINTED ONE and never to an empty box. Without
 * `has_n` there is nothing to scale; with a row or column count that makes no
 * sense there is nothing to draw. Printing it is never wrong, which is the same
 * choice news_parse() makes everywhere else: degrade to the thing that still
 * works. */
#define MD_TAB_MIN_ROWS    3      /* see table_run(): fewer is not a statement */
#define MD_TAB_CELL_MIN   60
#define MD_TAB_LABEL_MAX 190
#define MD_TAB_HEAD  (UI_TAB_HEAD_H + 4 + UI_MOD_KICKER_H + 4 \
                      + UI_TAB_HEAD_H + MD_RULE_DY + UI_RULE_HAIR + 4)

static int table_cols(const news_table_t *t, int w, int *label_w, int *cell_w)
{
    /* The row labels are a statement's own line items — "Operating expenses",
     * "Diluted EPS" — and they are the one column of the table that is prose. A
     * label ellipsized to "Operating expen…" is a row a reader has to guess at,
     * so the column takes up to a third of the module rather than the flat 160
     * the header names, and the value cells give up the difference. */
    int lw = w / 3;
    if (lw > MD_TAB_LABEL_MAX) lw = MD_TAB_LABEL_MAX;
    if (lw < UI_TAB_LABEL_W)   lw = w / 3;
    if (lw < 1) lw = 1;

    int n = t->col_count;
    while (n > 1) {
        const int avail = w - lw - n * MD_FIELD_GAP;
        if (avail / n >= MD_TAB_CELL_MIN) break;
        n--;
    }
    if (n < 1) n = 1;

    *label_w = lw;
    *cell_w  = (w - lw - n * MD_FIELD_GAP) / n;
    if (*cell_w < 1) *cell_w = 1;
    return n;
}

/* --- a drawn statement ----------------------------------------------------
 *
 * SERIES IDENTITY, WHICH IS THE SECOND THING COLOUR IS ALLOWED TO MEAN
 * -------------------------------------------------------------------
 * A stacked bar's segments and a group's bars have to be told apart, and until
 * now this file told them apart with a private set of four screen tones. It no
 * longer has one: which treatment the i-th of n series takes is ui_series_at()'s,
 * and painting it is ui_series_draw_abs()'s. The ladder it answers with is three
 * blacks, a blue and a keylined yellow — see ui_chart.h for why those five and
 * ui_internal.h's colour note for what the panel can actually hold — so this is
 * the same argument the tones made, with the two inks the panel has to spare
 * folded into it rather than left on the table.
 *
 * It matters that the choice is not made here. A treatment picked per graphic is
 * a graphic that disagrees with the next graphic about what a blue bar means,
 * and the legend swatch and the bar it names are drawn by the SAME call at two
 * sizes rather than by two calls that agree — which is what makes a legend a
 * legend rather than a decoration that happens to match.
 *
 * WHAT IS STILL NOT ALLOWED: the percentage line over the bars. It is a rate,
 * so it is a CHANGE, and it keeps ui_chg_colour() — direction, not identity.
 * Giving it a series treatment would be the one place on the sheet where the two
 * meanings of colour collided, and a reader would have no way to know which of
 * them a green line was speaking.
 *
 * A STACK'S SEGMENTS ARE SEPARATED BY A PIXEL OF PAPER. Two flat areas meeting
 * at an edge are told apart by the step across it, and at four series and more
 * ui_series_at() is forced to put SOLID next to BLUE — 1.63:1, the pair
 * ui_internal.h's note says must never share an edge. It is forced rather than
 * chosen: no four of five treatments are mutually non-adjacent on the ladder. A
 * hairline of paper means they never share an edge at all, which is what a
 * printed stacked bar has always done, and it costs one pixel per segment. A bar
 * GROUP gets the same separation from its 1 px gutter. */
#define MD_GRF_COL_MIN   46      /* a period narrower than this is unreadable */
#define MD_GRF_GROUP_GAP 12      /* paper between two periods                 */
#define MD_GRF_BAR_MAX   64      /* a stack wider than this is a slab         */
#define MD_GRF_MIN_PLOT  90
#define MD_GRF_MARK      10
#define MD_GRF_SEG_GAP    1      /* the paper between two stacked segments    */

/* The furniture over the plot: the title, the unit, and the rule they sit on. */
#define MD_GRF_HEAD  (UI_TAB_HEAD_H + 4 + UI_MOD_KICKER_H + 4 \
                      + UI_RULE_HAIR + 6)

/* And under it: the period labels, then one legend row per entry. */
#define MD_GRF_FOOT(n)  (4 + UI_TAB_HEAD_H + 6 + (n) * UI_FIG_LABEL_H)

/* The treatment for the r-th of n drawn series, with the request CLAMPED rather
 * than the answer overridden.
 *
 * ui_series_at() has five treatments and this file's display list carries six
 * rows, because a stack's row count is the producer's and dropping the sixth
 * component of a stack would understate its total — which is the one thing a
 * stacked bar may not do. Asking ui_series_at() for six gets SOLID for every
 * one of them, and a stack drawn entirely in black is a slab with no divisions
 * at all. So a sixth series takes the fifth's treatment: two OPEN segments
 * separated by two keylines and a pixel of paper are still two segments, and a
 * repeat is the honest failure where a black slab is a wrong picture.
 *
 * Not a hand-picked ladder around ui_series_at(). Every value that reaches the
 * glass is one it chose, at a series count it was designed for. */
static ui_series_t grf_series(int r, int n)
{
    if (n > UI_SERIES_N) n = UI_SERIES_N;
    if (r >= n)          r = n - 1;
    if (r < 0)           r = 0;
    return ui_series_at(r, n);
}

/* The whole graphic, from the list the placement left. No arithmetic here: every
 * rectangle and every vertex was worked out once, at the width and height the
 * module actually got, by the same walk that set the labels around them. */
static void grf_cb(lv_event_t *e)
{
    lv_obj_t    *o = lv_event_get_target_obj(e);
    lv_layer_t  *L = lv_event_get_layer(e);
    ui_module_t *w = o ? (ui_module_t *)lv_obj_get_user_data(o) : NULL;
    if (!L || !w || !w->grf || w->grf->kind == UI_GRF_NONE) return;

    const ui_grf_t *g = w->grf;
    lv_area_t a;
    lv_obj_get_coords(o, &a);

    /* The bars, and then the legend swatch that names them — the SAME call at
     * two sizes, so a swatch cannot come out as a different object from the bars
     * it stands for. */
    for (int r = 0; r < g->rows; r++) {
        const ui_series_t s = grf_series(r, g->rows);

        for (int c = 0; c < g->cols; c++) {
            const ui_grf_box_t *b = &g->box[r][c];
            if (b->w <= 0 || b->y1 < b->y0) continue;
            ui_series_draw_abs(L, a.x1 + b->x, a.y1 + b->y0,
                               a.x1 + b->x + b->w - 1, a.y1 + b->y1, s);
        }
        const ui_grf_box_t *k = &g->key[r];
        if (k->w > 0) {
            ui_series_draw_abs(L, a.x1 + k->x, a.y1 + k->y0,
                               a.x1 + k->x + k->w - 1, a.y1 + k->y1, s);
        }
    }

    /* The baseline. A bar chart that does not show where zero is has not said
     * anything about the size of its bars. */
    ui_draw_rect_c_abs(L, a.x1 + g->x0, a.y1 + g->base,
                       a.x1 + g->x1, a.y1 + g->base, true, 0, UI_INK);

    /* The percentage line over the bars, and the one element of the graphic
     * whose colour means DIRECTION rather than identity. The bars above are
     * quantities and take a series treatment; the line is a rate, so it is a
     * change, and it goes through ui_chg_colour() — which answers ink at zero
     * and ink for the whole sheet when the snapshot is stale. Giving the line a
     * series treatment as well would be the one place on this page where the two
     * meanings of colour met, and a reader would have no way to know which of
     * them a green line was speaking. */
    if (g->ln >= 2) {
        const lv_color_t col = ui_chg_colour(g->lbp);

        /* THE LINE IS DRAWN TWICE: once in paper, two pixels wider, then in its
         * own colour. The halo is not styling — it is what makes the line legible
         * over the bars at all, and without it this graphic has a latent hole.
         *
         * The bars carry series treatments and the line carries direction, so
         * the two are chosen by different rules and nothing coordinates them.
         * Run the pairs: a RED line falls on SOLID bars at 1.33:1 and on BLUE at
         * 1.25:1, and a GREEN line falls on BLUE at 1.17:1 — all three of them
         * inside the dark band, where this panel has no value to spend. So a
         * falling margin over the bars it is the margin OF would have been a
         * line nobody could follow, and it would have appeared only on the days
         * the number went down.
         *
         * Paper is the one thing guaranteed to separate from every treatment,
         * because every treatment is either dark (9.18:1 against paper at worst
         * 4.75) or is itself keylined in black. Two pixels because the line is
         * UI_RULE_MID: one either side, which survives a bar edge landing mid-
         * halo. It is drawn as a first full pass rather than per segment so that
         * a vertex's own halo cannot punch through the segment before it. */
        for (int i = 1; i < g->ln; i++) {
            ui_draw_line_c_abs(L, a.x1 + g->lx[i - 1], a.y1 + g->ly[i - 1],
                               a.x1 + g->lx[i], a.y1 + g->ly[i],
                               UI_RULE_MID + 2, UI_PAPER);
        }
        for (int i = 1; i < g->ln; i++) {
            ui_draw_line_c_abs(L, a.x1 + g->lx[i - 1], a.y1 + g->ly[i - 1],
                               a.x1 + g->lx[i], a.y1 + g->ly[i],
                               UI_RULE_MID, col);
        }
        /* A node on every period, as a SQUARE and not a disc: ui_draw_disc_abs()
         * goes through lv_draw_arc(), which antialiases its rim, and
         * wp_quantize565() resolves the mid-greys a black edge on white paper
         * makes to GREEN. A three-pixel disc is mostly rim. Haloed like the
         * segments, and for the same reason. */
        for (int i = 0; i < g->ln; i++) {
            ui_draw_rect_c_abs(L, a.x1 + g->lx[i] - 3, a.y1 + g->ly[i] - 3,
                               a.x1 + g->lx[i] + 3, a.y1 + g->ly[i] + 3,
                               true, 0, UI_PAPER);
        }
        for (int i = 0; i < g->ln; i++) {
            ui_draw_rect_c_abs(L, a.x1 + g->lx[i] - 2, a.y1 + g->ly[i] - 2,
                               a.x1 + g->lx[i] + 2, a.y1 + g->ly[i] + 2,
                               true, 0, col);
        }
        if (g->lbp == 0) {
            const int t = a.y1 + g->mky + (MD_GRF_MARK - MD_FLAT_H) / 2;
            ui_draw_rect_c_abs(L, a.x1 + g->mkx, t,
                               a.x1 + g->mkx + MD_GRF_MARK - 1,
                               t + MD_FLAT_H - 1, true, 0, UI_INK);
        } else {
            ui_draw_tri_abs(L, a.x1 + g->mkx, a.y1 + g->mky,
                            MD_GRF_MARK, MD_GRF_MARK, g->lbp > 0, col);
        }
    }

    /* A stack's legend carries one change per component, and the plot pane is
     * this module's only draw surface — a drawn table has no marks pane of its
     * own, because the pane it already has covers the whole module. */
    marks_draw(L, w, a.x1, a.y1);
}

/* The four display lists, one per (page, statement).
 *
 * Keyed on the pair and not on `src` alone: ui_mod_run() runs for BOTH sheets on
 * every snapshot, A1 and A2 can each hold a drawn table, and with NEWS_TABLES_MAX
 * of two they can legitimately want the same index. Keyed on src alone the second
 * page's placement would overwrite the first's bars and leave A1's labels
 * describing a graphic that had been redrawn from another page's numbers — a
 * failure with no symptom until somebody read a wrong figure off the glass. */
static ui_grf_t s_grf[UI_PAGE_COUNT][NEWS_TABLES_MAX];

/* Whether this statement can be drawn at all. Anything that fails is printed
 * instead, which is never wrong. */
static bool table_drawable(const news_table_t *t)
{
    if (t->render == TABLE_PRINT || !t->has_n)     return false;
    if (t->col_count < 2 || t->row_count < 1)      return false;
    if (t->render == TABLE_BARS_LINE && t->row_count < 2) return false;
    return true;
}

/* How many legend entries the graphic sets under it: one per component for a
 * stack, because each carries its own share and its own shift; one row for a bar
 * group, whose two or three series fit across a single line. */
static int grf_legend_rows(const news_table_t *t)
{
    int series = t->row_count;
    if (t->render == TABLE_BARS_LINE) series--;     /* the last row is the line */
    if (series > UI_GRF_ROWS) series = UI_GRF_ROWS;
    if (series < 1) series = 1;

    return t->render == TABLE_STACK ? series : 1;
}

/* How many periods fit, dropping the OLDEST first for the same reason the
 * printed table does: the newest column is the one the page is about. */
static int grf_cols(const news_table_t *t, int w)
{
    int n = t->col_count;
    if (n > NEWS_TABLE_COLS) n = NEWS_TABLE_COLS;
    while (n > 2 && w / n < MD_GRF_COL_MIN) n--;
    return n < 1 ? 1 : n;
}

/* The value window a set of bars is drawn in. Zero is IN the window by
 * construction — a bar chart whose baseline is not zero overstates every
 * difference on it, which is the oldest way there is to lie with a graphic. */
static ui_chart_win_t grf_bar_window(const news_table_t *t, int rows,
                                     int first, int nc)
{
    int64_t lo = 0, hi = 0;

    for (int r = 0; r < rows; r++) {
        for (int c = 0; c < nc; c++) {
            const int64_t vv = t->n[r][first + c];
            if (vv < lo) lo = vv;
            if (vv > hi) hi = vv;
        }
    }
    /* A sixteenth of headroom at the top so the tallest bar does not touch the
     * rule over it and read as clipped. None at the foot: that end is zero and
     * it is where the baseline goes. */
    hi += (hi - lo) / 16;
    if (hi <= lo) hi = lo + 1;

    return (ui_chart_win_t){ lo, hi };
}

static ui_chart_win_t grf_line_window(const int32_t *v, int n)
{
    int64_t lo = v[0], hi = v[0];

    for (int i = 1; i < n; i++) {
        if (v[i] < lo) lo = v[i];
        if (v[i] > hi) hi = v[i];
    }
    const int64_t pad = (hi - lo) / 8;
    lo -= pad ? pad : 1;
    hi += pad ? pad : 1;

    return (ui_chart_win_t){ lo, hi };
}

static void table_draw(const ui_mod_t *m, const news_t *v, int w,
                       ui_page_t page, ui_module_t *inst,
                       int *h_min, int *h_pref)
{
    const news_table_t *t = &v->tables[m->src];
    const int legend = grf_legend_rows(t);
    const int furn   = MD_GRF_HEAD + MD_GRF_FOOT(legend);

    if (!inst) {
        /* Two fifths of the measure is a graphic's proportion rather than a
         * number: a wide box wants a taller plot or the bars flatten into a
         * kerb. The floor is what a bar chart stops being readable under and the
         * ceiling is what stops a full-measure graphic eating the page. */
        int plot = (w * 2) / 5;
        if (plot < MD_GRF_MIN_PLOT) plot = MD_GRF_MIN_PLOT;
        if (plot > 240)             plot = 240;

        *h_min  = furn + MD_GRF_MIN_PLOT;
        *h_pref = furn + plot;
        return;
    }

    ui_w_table_t *g   = &inst->w.table;
    ui_grf_t     *d   = &s_grf[page][m->src];
    const int     h   = m->h;
    const int     nc  = grf_cols(t, w);
    const int     first = (t->col_count > nc ? t->col_count : nc) - nc;

    memset(d, 0, sizeof *d);
    inst->grf = d;

    /* Every printed-table widget off first, then only what this graphic uses
     * back on. The alternative — hiding what the graphic did not use, at the end
     * — has to enumerate the printed layout from inside the drawn one, and gets
     * it wrong the first time either changes. */
    for (int r = 0; r < NEWS_TABLE_ROWS; r++) {
        ui_show(g->rlabel[r], false);
        ui_show(g->rule[r], false);
        for (int c = 0; c < NEWS_TABLE_COLS; c++) ui_show(g->cell[r][c], false);
    }

    int ph = h - furn;
    if (ph < MD_GRF_MIN_PLOT) ph = MD_GRF_MIN_PLOT;

    const int py    = MD_GRF_HEAD;
    const int pitch = w / nc;

    /* How many rows are BARS. A stack draws all of them; a bar group keeps the
     * last row back for the line over the top. */
    int series = t->render == TABLE_BARS_LINE ? t->row_count - 1 : t->row_count;
    if (series > UI_GRF_ROWS) series = UI_GRF_ROWS;
    if (series < 1) series = 1;

    d->kind = t->render == TABLE_STACK ? UI_GRF_STACK : UI_GRF_BARS;
    d->rows = (uint8_t)series;
    d->cols = (uint8_t)nc;
    d->x0   = 0;
    d->x1   = (int16_t)(w - 1);

    md_text_caps(g->title, 0, 0, w, UI_TAB_HEAD_H, t->title);
    md_text(g->note, 0, UI_TAB_HEAD_H + 4, w, UI_MOD_KICKER_H, t->note);
    md_at(g->hair, 0, UI_TAB_HEAD_H + 4 + UI_MOD_KICKER_H + 4, w, UI_RULE_HAIR);

    if (t->render == TABLE_STACK) {
        /* Each period is ONE bar and each row a component of it, so the height
         * is the total and the divisions are the mix. The mix is the point: a
         * reader looking at revenue by end market wants to see one segment
         * taking over, which a grid of eighteen numbers will not show them. */
        int64_t tallest = 1;
        for (int c = 0; c < nc; c++) {
            int64_t sum = 0;
            for (int r = 0; r < series; r++) {
                const int32_t vv = t->n[r][first + c];
                if (vv > 0) sum += vv;
            }
            if (sum > tallest) tallest = sum;
        }
        d->base = (int16_t)(py + ph - 1);

        for (int c = 0; c < nc; c++) {
            int bw = pitch - MD_GRF_GROUP_GAP;
            if (bw > MD_GRF_BAR_MAX) bw = MD_GRF_BAR_MAX;
            if (bw < 2) bw = 2;

            const int bx = c * pitch + (pitch - bw) / 2;
            int foot = py + ph - 1;

            for (int r = 0; r < series; r++) {
                const int32_t vv = t->n[r][first + c];
                const int seg = vv > 0
                    ? (int)(((int64_t)vv * (ph - 1)) / tallest) : 0;

                /* The segment loses its top pixel to paper so that no two
                 * treatments share an edge — see the section note on why
                 * ui_series_at() is forced to put SOLID beside BLUE at four
                 * series. The pixel comes off the DRAWN box and not off the
                 * advance, so the stack's total height is still the sum of its
                 * components and the graphic does not understate itself. */
                const int ink = seg > MD_GRF_SEG_GAP ? seg - MD_GRF_SEG_GAP : seg;

                d->box[r][c].x  = (int16_t)bx;
                d->box[r][c].w  = (int16_t)(seg > 0 ? bw : 0);
                d->box[r][c].y0 = (int16_t)(foot - ink + 1);
                d->box[r][c].y1 = (int16_t)foot;
                foot -= seg;
            }
        }
    } else {
        /* Bars grouped per period with the percentage line over them: the shape
         * every annual report opens with, because revenue, profit and margin are
         * three different questions and only the third is a ratio. */
        const ui_chart_win_t win = grf_bar_window(t, series, first, nc);
        d->base = (int16_t)(py + ui_chart_y(0, win, ph));

        const int gw = pitch - MD_GRF_GROUP_GAP;
        int bw = gw / series;
        if (bw < 2) bw = 2;

        for (int c = 0; c < nc; c++) {
            const int gx = c * pitch + (pitch - bw * series) / 2;

            for (int r = 0; r < series; r++) {
                const int32_t vv = t->n[r][first + c];
                const int row = py + ui_chart_y(vv, win, ph);

                d->box[r][c].x  = (int16_t)(gx + r * bw);
                d->box[r][c].w  = (int16_t)(bw - 1);
                d->box[r][c].y0 = (int16_t)(row < d->base ? row : d->base);
                d->box[r][c].y1 = (int16_t)(row < d->base ? d->base : row);
            }
        }

        /* The line, on its own scale. It is in basis points and the bars are in
         * whatever unit `note` names, so sharing a window would draw a margin
         * against a revenue and put the line on the floor of the box. */
        const int32_t *ln = t->n[t->row_count - 1];
        int32_t vals[NEWS_TABLE_COLS];
        for (int c = 0; c < nc; c++) vals[c] = ln[first + c];

        const ui_chart_win_t lw = grf_line_window(vals, nc);
        for (int c = 0; c < nc; c++) {
            d->lx[c] = (int16_t)(c * pitch + pitch / 2);
            d->ly[c] = (int16_t)(py + ui_chart_y(vals[c], lw, ph));
        }
        d->ln  = (uint8_t)nc;
        d->lbp = vals[nc - 1] - vals[0];

        /* Its two ends, printed. A line with no numbers on it is a shape; the
         * first and the last are what make it a statement about the period. */
        char first_s[16], last_s[16];
        ui_pct(first_s, sizeof first_s, vals[0]);
        ui_pct(last_s,  sizeof last_s,  vals[nc - 1]);

        /* Set in the caption face and MEASURED IN THE SAME ONE. Measuring a slot
         * in a face the widget is not set in is how a box comes out narrower
         * than its own string: these cells are built in body_16 for the printed
         * statement, so without this the end values ellipsized to "+8…" — the
         * one figure on the graphic a reader came to it for. */
        md_font(g->cell[0][0], UI_F_LABEL, UI_FIG_LABEL_H);
        md_font(g->cell[0][1], UI_F_LABEL, UI_FIG_LABEL_H);

        const int lab_w = md_text_w(UI_F_LABEL, last_s, 0) + 2;

        lv_obj_set_style_text_color(g->cell[0][0], UI_INK, 0);
        lv_obj_set_style_text_align(g->cell[0][0], LV_TEXT_ALIGN_LEFT, 0);
        md_text(g->cell[0][0], d->lx[0] + 6, d->ly[0] - UI_FIG_LABEL_H - 2,
                md_text_w(UI_F_LABEL, first_s, 0) + 2, UI_FIG_LABEL_H, first_s);
        ui_lab_opaque(g->cell[0][0]);

        /* The end value in the line's own colour with the matching mark: ONE
         * coloured element in the graphic, encoding one fact — where the margin
         * finished against where it started. */
        const int ex = w - lab_w;
        lv_obj_set_style_text_color(g->cell[0][1], ui_chg_colour(d->lbp), 0);
        lv_obj_set_style_text_align(g->cell[0][1], LV_TEXT_ALIGN_RIGHT, 0);
        md_text(g->cell[0][1], ex, d->ly[nc - 1] - UI_FIG_LABEL_H - 2,
                lab_w, UI_FIG_LABEL_H, last_s);
        ui_lab_opaque(g->cell[0][1]);

        d->mkx = (int16_t)(ex - MD_GRF_MARK - MD_FIG_CHG_GAP);
        d->mky = (int16_t)(d->ly[nc - 1] - UI_FIG_LABEL_H - 2
                           + (UI_FIG_LABEL_H - MD_GRF_MARK) / 2);
    }

    /* The periods, along the foot of the plot. */
    const int cy = py + ph + 4;
    for (int c = 0; c < NEWS_TABLE_COLS; c++) {
        if (c >= nc) { ui_show(g->col[c], false); continue; }
        lv_obj_set_style_text_align(g->col[c], LV_TEXT_ALIGN_CENTER, 0);
        md_text(g->col[c], c * pitch, cy, pitch, UI_TAB_HEAD_H,
                t->col[first + c]);
    }

    /* The legend. A stack gives every component its own line with the shift in
     * its share since the first period beside it — that is a CHANGE, so it is
     * the one thing here that carries direction colour. A bar group runs its two
     * or three series across a single line, where there is nothing to say but
     * which treatment is which.
     *
     * The swatch is UI_SERIES_SWATCH square rather than a size chosen here, so
     * that every legend on both sheets is the same object, and it is drawn by
     * the same call as the bars — see grf_cb(). It was 18 x 11, which is neither
     * that number nor a square, and a swatch that is not the shape of the mark it
     * stands for is a swatch the eye has to be told about. */
    const int ly = cy + UI_TAB_HEAD_H + 6;
    const int sw = UI_SERIES_SWATCH;
    const int kd = (UI_FIG_LABEL_H - UI_SERIES_SWATCH) / 2;   /* centred */

    if (d->kind == UI_GRF_STACK) {
        /* Each component on its own line, with the shift in its SHARE since the
         * first period beside it. A mix shift is the whole reason this graphic
         * is a stack rather than a set of lines, and it is the one number a
         * reader cannot get by looking at the bars. It is also a change, which
         * is what entitles it to colour. */
        int64_t sa = 0, sb = 0;
        for (int k = 0; k < series; k++) {
            if (t->n[k][first] > 0)          sa += t->n[k][first];
            if (t->n[k][first + nc - 1] > 0) sb += t->n[k][first + nc - 1];
        }

        for (int r = 0; r < series; r++) {
            const int ry = ly + r * UI_FIG_LABEL_H;

            d->key[r].x  = 0;
            d->key[r].w  = (int16_t)sw;
            d->key[r].y0 = (int16_t)(ry + kd);
            d->key[r].y1 = (int16_t)(ry + kd + UI_SERIES_SWATCH - 1);

            const int32_t pa = sa > 0
                ? (int32_t)(((int64_t)t->n[r][first] * 10000) / sa) : 0;
            const int32_t pb = sb > 0
                ? (int32_t)(((int64_t)t->n[r][first + nc - 1] * 10000) / sb) : 0;

            char pct[16];
            ui_pct(pct, sizeof pct, pb - pa);

            /* Measured in the face it is SET in — see the line's end values
             * above. These cells are built in body_16 for the printed statement
             * and re-pointed here. */
            md_font(g->cell[r][0], UI_F_LABEL, UI_FIG_LABEL_H);

            const int pw = md_text_w(UI_F_LABEL, pct, 0) + 2;
            const int mx = w - pw - MD_FIG_MARK - MD_FIG_CHG_GAP;
            const int lx = sw + MD_FIELD_GAP;

            md_text(g->rlabel[r], lx, ry, mx - lx - MD_FIELD_GAP,
                    UI_FIG_LABEL_H, t->row[r].label);

            lv_obj_set_style_text_color(g->cell[r][0], ui_chg_colour(pb - pa), 0);
            lv_obj_set_style_text_align(g->cell[r][0], LV_TEXT_ALIGN_RIGHT, 0);
            md_text(g->cell[r][0], w - pw, ry, pw, UI_FIG_LABEL_H, pct);

            mark_add(inst, mx, ry + (UI_FIG_LABEL_H - MD_FIG_MARK) / 2,
                     MD_FIG_MARK, pb - pa);
        }
    } else {
        /* One row, the two or three series laid across it left to right. There
         * is nothing to say about a bar series but which tone it is, so there is
         * nothing to give it a line of its own for. */
        int at = 0;
        for (int k = 0; k < series; k++) {
            const int lw2 = md_text_w(UI_F_BODY, t->row[k].label, 0);
            if (at + sw + 6 + lw2 > w) break;

            d->key[k].x  = (int16_t)at;
            d->key[k].w  = (int16_t)sw;
            d->key[k].y0 = (int16_t)(ly + kd);
            d->key[k].y1 = (int16_t)(ly + kd + UI_SERIES_SWATCH - 1);

            md_text(g->rlabel[k], at + sw + 6, ly, lw2 + 2, UI_FIG_LABEL_H,
                    t->row[k].label);
            at += sw + 6 + lw2 + 2 * MD_FIELD_GAP;
        }
    }

    md_at(g->plot, 0, 0, w, h);
    ui_show(g->plot, true);
    lv_obj_invalidate(g->plot);

    inst->ink_h = ly + (d->kind == UI_GRF_STACK ? series : 1) * UI_FIG_LABEL_H;
}

static void table_run(const ui_mod_t *m, const news_t *v, int w,
                      ui_page_t page, ui_module_t *inst,
                      int *h_min, int *h_pref)
{
    const news_table_t *t = &v->tables[m->src];

    if (table_drawable(t)) {
        table_draw(m, v, w, page, inst, h_min, h_pref);
        return;
    }

    if (inst) {
        inst->grf = NULL;
        ui_show(inst->w.table.plot, false);
    }

    if (!inst) {
        /* THREE line items is the least that is still a statement. One row under
         * a head reading QUARTERLY RESULTS is a figure with a table's furniture
         * around it, and the reader cannot tell whether the other lines were cut
         * or never filed. A statement is a relation between lines — revenue
         * against a cost against what is left — and three is where that starts. */
        int floor_rows = t->row_count < MD_TAB_MIN_ROWS ? t->row_count
                                                        : MD_TAB_MIN_ROWS;
        if (floor_rows < 1) floor_rows = 1;

        *h_min  = MD_TAB_HEAD + floor_rows * UI_TAB_ROW_H;
        *h_pref = MD_TAB_HEAD + t->row_count * UI_TAB_ROW_H;
        if (*h_pref < *h_min) *h_pref = *h_min;
        return;
    }

    ui_w_table_t *g = &inst->w.table;
    const int h = m->h;

    int lw = 0, cw = 0;
    const int nc = table_cols(t, w, &lw, &cw);
    const int first = t->col_count - nc;          /* the oldest quarters go */

    /* Top-aligned and tight, at the natural pitch — see peers_run() for why a
     * statement is the last thing on the sheet that should be set airy, and for
     * why the row count is what the rectangle holds rather than what the payload
     * carries. A statement cut short still reads as a statement; one drawn
     * through the module underneath does not. */
    const int pitch = UI_TAB_ROW_H;
    const int fit   = (h - MD_TAB_HEAD) / pitch;

    int rows = t->row_count;
    if (rows > fit) rows = fit;
    if (rows < 1)   rows = 1;

    md_text(g->title, 0, 0, w, UI_TAB_HEAD_H, t->title);
    md_text(g->note, 0, UI_TAB_HEAD_H + 4, w, UI_MOD_KICKER_H, t->note);

    const int hy = UI_TAB_HEAD_H + 4 + UI_MOD_KICKER_H + 4;
    for (int c = 0; c < NEWS_TABLE_COLS; c++) {
        if (c >= nc) { ui_show(g->col[c], false); continue; }
        lv_obj_set_style_text_align(g->col[c], LV_TEXT_ALIGN_RIGHT, 0);
        md_text(g->col[c], lw + MD_FIELD_GAP + c * (cw + MD_FIELD_GAP), hy,
                cw, UI_TAB_HEAD_H, t->col[first + c]);
    }
    md_at(g->hair, 0, hy + UI_TAB_HEAD_H + MD_RULE_DY, w, UI_RULE_HAIR);

    const int top   = MD_TAB_HEAD;
    const int inset = (pitch - lv_font_get_line_height(UI_F_BODY)) / 2;

    for (int r = 0; r < NEWS_TABLE_ROWS; r++) {
        if (r >= rows) {
            ui_show(g->rlabel[r], false);
            ui_show(g->rule[r], false);
            for (int c = 0; c < NEWS_TABLE_COLS; c++) ui_show(g->cell[r][c], false);
            continue;
        }

        const int y = top + r * pitch;
        md_text(g->rlabel[r], 0, y + inset, lw,
                lv_font_get_line_height(UI_F_BODY), t->row[r].label);

        for (int c = 0; c < NEWS_TABLE_COLS; c++) {
            if (c >= nc) { ui_show(g->cell[r][c], false); continue; }
            const char *s = t->row[r].v[first + c];

            /* Set explicitly rather than left at what create() built, because a
             * drawn statement re-points these cells at the caption face and one
             * pool instance renders whichever statement the day's make-up gave
             * it. A cell that kept last poll's face would print a column of
             * figures a size smaller than the column beside it. */
            md_font(g->cell[r][c], UI_F_BODY, UI_MOD_BODY_LH);
            lv_obj_set_style_text_color(g->cell[r][c], UI_INK, 0);
            lv_obj_set_style_text_align(g->cell[r][c], LV_TEXT_ALIGN_RIGHT, 0);

            md_text(g->cell[r][c], lw + MD_FIELD_GAP + c * (cw + MD_FIELD_GAP),
                    y + inset, cw, lv_font_get_line_height(UI_F_BODY),
                    s[0] ? s : S_EMPTY_CELL);
        }

        if (r + 1 < rows) md_at(g->rule[r], 0, y + pitch - UI_RULE_HAIR, w,
                                UI_RULE_HAIR);
        else              md_close(g->rule[r], y + pitch, w, h);
    }
    inst->ink_h = top + rows * pitch + UI_RULE_HAIR;
}

static void table_create(ui_module_t *w, lv_obj_t *par)
{
    ui_w_table_t *g = &w->w.table;

    g->title = md_caps(par, 0, 0, 10, LV_TEXT_ALIGN_LEFT, "");
    g->note  = ui_lab_w(par, 0, 0, 10, UI_F_BODY, LV_TEXT_ALIGN_LEFT, "");
    g->hair  = ui_rule(par, 0, 0, 1, UI_RULE_HAIR);

    for (int c = 0; c < NEWS_TABLE_COLS; c++) {
        g->col[c] = md_caps(par, 0, 0, 10, LV_TEXT_ALIGN_RIGHT, "");
    }
    for (int r = 0; r < NEWS_TABLE_ROWS; r++) {
        g->rlabel[r] = ui_lab_w(par, 0, 0, 10, UI_F_BODY, LV_TEXT_ALIGN_LEFT, "");
        for (int c = 0; c < NEWS_TABLE_COLS; c++) {
            /* Right-aligned, every value cell. A column of figures aligned any
             * other way cannot be read down, which is the only reason to print
             * it as a table rather than as a sentence. */
            g->cell[r][c] = ui_lab_w(par, 0, 0, 10, UI_F_BODY,
                                     LV_TEXT_ALIGN_RIGHT, "");
        }
        g->rule[r] = ui_rule(par, 0, 0, 1, UI_RULE_HAIR);
    }

    /* After the cells and the rules, so the bars and the line print OVER them. */
    g->plot = ui_pane(par, 0, 0, 1, 1);
    lv_obj_set_user_data(g->plot, w);
    lv_obj_add_event_cb(g->plot, grf_cb, LV_EVENT_DRAW_MAIN, NULL);
    ui_show(g->plot, false);

    /* ...and then the two end values back over the plot again, because they are
     * the one thing that must not be under it.
     *
     * The comment that used to sit here said the labels "carry ui_lab_opaque(),
     * which is why a figure sitting on its own polyline needs paper behind it",
     * and it had the z-order exactly backwards: siblings draw in creation order,
     * these were created above, and `g->plot` therefore printed straight over
     * them. Paper behind a label that is itself behind the plot buys nothing.
     *
     * It went unnoticed for as long as the bars were black — a black bar across
     * a black figure is unreadable but it is not WRONG-COLOURED, so no assertion
     * fired and a reader would have called it a smudge. The first blue bar made
     * the simulator report series ink inside a label, which is how a z-order bug
     * came to be caught by a colour rule. "+58.46%" was printing as ".46%".
     *
     * Moved once, here, rather than in the update: a z-order fix belongs with
     * the tree that has the wrong order, and this file does not touch the tree
     * on a poll. */
    lv_obj_move_foreground(g->cell[0][0]);
    lv_obj_move_foreground(g->cell[0][1]);
}

/* --- THUMBS ---------------------------------------------------------------
 *
 * The pictures at the foot, under a standing head. Real front-page furniture:
 * two small photographs with their captions is what a broadsheet puts at the
 * bottom of the sheet, and it is what stops the last band being a rule and a
 * paragraph. */
#define MD_THUMB_HEAD (UI_MOD_KICKER_H + MD_RULE_DY + UI_RULE_HAIR + MD_ITEM_GAP)

/* A thumb is cropped to this however tall the tile is. They are the LAST band
 * of the sheet, so every pixel they ask for comes out of the lead package above
 * them, and a 204 px picture and a 170 px one read the same at the foot of a
 * page — while 34 px is a line and a half of the story that has to give it up. */
#define MD_THUMB_MAX_H 170
#define MD_THUMB_MIN_H 120      /* see thumbs_run(): under this it is a strip */

static void thumbs_run(const ui_mod_t *m, const news_t *v, int w,
                       ui_module_t *inst, int *h_min, int *h_pref)
{
    (void)m;
    int n = v->thumb_count;
    if (n > NEWS_THUMBS_MAX) n = NEWS_THUMBS_MAX;

    /* Each picture gets its share of the measure and is cropped to it, so the
     * block's height is the tallest tile that actually loaded. */
    const int slot = n > 0 ? (w - (n - 1) * UI_GUTTER) / n : w;
    int tall = 0;
    const ui_tile_t *t[NEWS_THUMBS_MAX] = { NULL, NULL };

    for (int i = 0; i < n; i++) {
        t[i] = art_tile(&v->thumbs[i]);
        if (t[i] && t[i]->h > tall) tall = t[i]->h;
    }
    if (tall > MD_THUMB_MAX_H) tall = MD_THUMB_MAX_H;

    if (!inst) {
        /* A PHOTOGRAPH, not a letterbox strip. At A1's full measure each thumb
         * slot is about 558 px wide, so the 80 px this used to claim is a 7:1
         * band of a picture — a crop that shows a horizon and no subject, under a
         * caption confidently describing what is in it. 120 px is 4.6:1, which is
         * a wide crop a picture desk would actually run. Below it the module is
         * not a small photograph, and INSIDE with two strips under it is worse
         * than INSIDE not running at all. */
        *h_min  = MD_THUMB_HEAD + (tall > 0 ? MD_THUMB_MIN_H : 1);
        *h_pref = MD_THUMB_HEAD + tall + UI_MOD_CAP_GAP + UI_MOD_CAP_H;
        if (*h_pref < *h_min) *h_pref = *h_min;
        return;
    }

    ui_w_thumbs_t *g = &inst->w.thumbs;

    md_text(g->head, 0, 0, w, UI_MOD_KICKER_H, S_INSIDE);
    md_at(g->hair, 0, UI_MOD_KICKER_H + MD_RULE_DY, w, UI_RULE_HAIR);

    int ph = m->h - MD_THUMB_HEAD - UI_MOD_CAP_GAP - UI_MOD_CAP_H;
    if (ph > tall) ph = tall;
    if (ph < 1)    ph = 1;

    for (int i = 0; i < NEWS_THUMBS_MAX; i++) {
        if (i >= n || !t[i]) {
            art_off(&g->art[i]);
            ui_show(g->cap[i], false);
            continue;
        }
        const int x = i * (slot + UI_GUTTER);
        art_show(&g->art[i], t[i], x, MD_THUMB_HEAD, slot, ph);
        md_text(g->cap[i], x, MD_THUMB_HEAD + ph + UI_MOD_CAP_GAP, slot,
                UI_MOD_CAP_H, v->thumbs[i].caption);
    }
    inst->ink_h = MD_THUMB_HEAD + ph + UI_MOD_CAP_GAP + UI_MOD_CAP_H;
}

static void thumbs_create(ui_module_t *w, lv_obj_t *par)
{
    ui_w_thumbs_t *g = &w->w.thumbs;

    g->head = md_caps(par, 0, 0, 10, LV_TEXT_ALIGN_LEFT, S_INSIDE);
    g->hair = ui_rule(par, 0, 0, 1, UI_RULE_HAIR);
    for (int i = 0; i < NEWS_THUMBS_MAX; i++) {
        art_create(&g->art[i], par);
        g->cap[i] = ui_lab_w(par, 0, 0, 10, UI_F_LABEL, LV_TEXT_ALIGN_LEFT, "");
    }
}

/* --- QUOTE ----------------------------------------------------------------
 *
 * One sentence, set at the size of a headline, with its attribution under it.
 * It is the page's typographic relief and it is the whole reason A2 is not
 * grey: a sheet of tables and figures has nothing on it larger than a deck, and
 * a reader's eye has nowhere to land. Every broadsheet inside page carries one.
 *
 * The sentence is the DECK of the story this page runs. A deck is one sentence
 * that a copy desk wrote about the story, the STORY module does not set one, and
 * pulling it out and setting it large is exactly what a pull quote is — so the
 * page gains a display line without the device inventing a word. */
#define MD_QUOTE_RULE_GAP  12

static void quote_run(const ui_mod_t *m, const news_t *v, int w,
                      ui_module_t *inst, int *h_min, int *h_pref)
{
    const news_story_t *st = &v->stories[m->src];
    const int lh = UI_MOD_HEAD_LH_1;

    const int furniture = UI_RULE_MID + MD_QUOTE_RULE_GAP
                        + UI_MOD_BYLINE_GAP + UI_MOD_BYLINE_H;

    int n = md_lines(UI_F_HEADLINE, w, st->deck);
    if (n > 6) n = 6;
    if (n < 1) n = 1;

    /* And no more lines than the rectangle holds. A pulled quote is the largest
     * type on its page, so a sentence set one line past the module's foot lands
     * squarely on whatever is under it — see peers_run() for the general case. */
    if (inst) {
        const int fit = (m->h - furniture + md_ls(UI_F_HEADLINE, lh))
                      / (lh > 0 ? lh : 1);
        if (n > fit) n = fit;
        if (n < 1)   n = 1;
    }

    const int block = UI_RULE_MID + MD_QUOTE_RULE_GAP
                    + md_box(UI_F_HEADLINE, lh, n)
                    + UI_MOD_BYLINE_GAP + UI_MOD_BYLINE_H;

    if (!inst) {
        *h_min  = UI_RULE_MID + MD_QUOTE_RULE_GAP
                + md_box(UI_F_HEADLINE, lh, 1)
                + UI_MOD_BYLINE_GAP + UI_MOD_BYLINE_H;
        *h_pref = block;
        return;
    }

    ui_w_quote_t *g = &inst->w.quote;

    /* Top-aligned like every other module that cannot grow: a sentence is as
     * long as it is, and the room a thin page has over belongs between the bands
     * rather than above a quotation. */
    int y = 0;

    md_at(g->rule, 0, y, w, UI_RULE_MID);
    y += UI_RULE_MID + MD_QUOTE_RULE_GAP;

    md_text(g->text, 0, y, w, md_box(UI_F_HEADLINE, lh, n), st->deck);
    y += md_box(UI_F_HEADLINE, lh, n) + UI_MOD_BYLINE_GAP;

    md_text_caps(g->attrib, 0, y, w, UI_MOD_BYLINE_H,
                 st->byline[0] ? st->byline : v->subject.name);
    inst->ink_h = y + UI_MOD_BYLINE_H;
}

static void quote_create(ui_module_t *w, lv_obj_t *par)
{
    ui_w_quote_t *g = &w->w.quote;

    g->rule   = ui_rule(par, 0, 0, 1, UI_RULE_MID);
    g->text   = md_block(par, UI_F_HEADLINE, UI_MOD_HEAD_LH_1);
    g->attrib = md_caps(par, 0, 0, 10, LV_TEXT_ALIGN_LEFT, "");
}

/* --- the public calls ----------------------------------------------------- */

void ui_mod_create(ui_module_t *w, lv_obj_t *par, ui_mod_kind_t kind)
{
    memset(w, 0, sizeof *w);
    w->kind = kind;
    w->pane = ui_pane(par, 0, 0, 1, 1);

    switch (kind) {
    case UI_MOD_LEAD:    story_create(w, w->pane, true);  break;
    case UI_MOD_STORY:   story_create(w, w->pane, false); break;
    case UI_MOD_DOSSIER: dossier_create(w, w->pane);      break;
    case UI_MOD_CHART:   chart_create(w, w->pane);        break;
    case UI_MOD_BRIEFS:  briefs_create(w, w->pane);       break;
    case UI_MOD_PEERS:   peers_create(w, w->pane);        break;
    case UI_MOD_TABLE:   table_create(w, w->pane);        break;
    case UI_MOD_THUMBS:  thumbs_create(w, w->pane);       break;
    case UI_MOD_QUOTE:   quote_create(w, w->pane);        break;
    default: break;
    }
    ui_show(w->pane, false);
}

/* --- which sheet a statement goes on --------------------------------------
 *
 * One function per question, called by BOTH pages, because the promise they are
 * keeping is a promise about the pair: every statement reaches exactly one
 * sheet. Two files carrying the same arithmetic kept it while A1 ran a statement
 * only on a day with no stories — the comment in ui_page_markets.c admits how
 * fragile that was — and stops keeping it now that A1 runs a graphic on an
 * ordinary day. The failure would be silent: two pages, the same six quarters,
 * and nothing wrong with either file read on its own. */

int ui_a1_graphic(const news_t *v)
{
    /* Only on a day that HAS stories. A quiet day already gives A1 a statement
     * through ui_a1_table(), and the two must never both fire — see there. */
    if (v->story_count == 0) return -1;

    for (int i = 0; i < v->table_count && i < NEWS_TABLES_MAX; i++) {
        if (table_drawable(&v->tables[i])) return i;
    }
    return -1;
}

int ui_a1_table(const news_t *v)
{
    /* The LAST statement, on a day with nothing written. A quiet front page is a
     * different page rather than this one with the copy taken out: the company's
     * accounts exist every day, and a sheet that prints them is a page again. */
    return (v->story_count == 0 && v->table_count > 0) ? v->table_count - 1 : -1;
}

bool ui_a2_takes_table(const news_t *v, int i)
{
    if (i < 0 || i >= v->table_count) return false;
    return i != ui_a1_graphic(v) && i != ui_a1_table(v);
}

void ui_rules_create(ui_rules_t *r, lv_obj_t *par)
{
    for (int i = 0; i < UI_MOD_MAX; i++) {
        r->vrule[i] = ui_vrule(par, 0, 0, 1, UI_RULE_HAIR);
        r->hrule[i] = ui_rule(par, 0, 0, 1, UI_BAND_RULE_W);
        ui_show(r->vrule[i], false);
        ui_show(r->hrule[i], false);
    }
}

void ui_mod_measure(const ui_mod_t *m, int w, int *h_min, int *h_pref, void *ctx)
{
    const news_t *v = (const news_t *)ctx;

    *h_min = *h_pref = 1;
    if (!v) return;

    /* `w` IS the module's measure. ui_compose() puts every origin on the
     * six-column grid and gives every module the span of its columns without the
     * gutter after the last one, so the gutters between modules stay paper —
     * which is exactly where the hairline down a band's gutter is drawn. There is
     * nothing to derive and nothing to clamp. */
    const int wt = ui_head_weight(m->rank, m->cols, -1);

    switch (m->kind) {
    case UI_MOD_LEAD:
    case UI_MOD_STORY:   story_run(m, v, w, wt, NULL, h_min, h_pref); break;
    case UI_MOD_DOSSIER: dossier_run(m, v, w, NULL, h_min, h_pref);   break;
    case UI_MOD_CHART:   chart_run(m, v, w, NULL, h_min, h_pref);     break;
    case UI_MOD_BRIEFS:  briefs_run(m, v, w, NULL, h_min, h_pref);    break;
    case UI_MOD_PEERS:   peers_run(m, v, w, NULL, h_min, h_pref);     break;
    /* The page is a PLACEMENT concern only — it picks which display list a drawn
     * statement writes into — and a measurement writes nothing, so the value
     * passed here is never read. ui_measure_fn has no page to give and must not
     * grow one: it is called from ui_compose.c, which knows nothing about pages
     * and must keep knowing nothing. */
    case UI_MOD_TABLE:   table_run(m, v, w, UI_PAGE_FRONT, NULL, h_min, h_pref);
                         break;
    case UI_MOD_THUMBS:  thumbs_run(m, v, w, NULL, h_min, h_pref);    break;
    case UI_MOD_QUOTE:   quote_run(m, v, w, NULL, h_min, h_pref);     break;
    default: break;
    }
    if (*h_min < 1)      *h_min = 1;
    if (*h_pref < *h_min) *h_pref = *h_min;
}

static void mod_place(ui_module_t *w, const ui_mod_t *m, const news_t *v,
                      ui_page_t page, int wt)
{
    int dummy_a = 0, dummy_p = 0;

    md_at(w->pane, m->x, m->y, m->w, m->h);
    w->mark_n = 0;

    /* The whole rectangle until a renderer says otherwise. A story fills its
     * legs and a rail spreads its figures to the foot, so for those two the
     * default is the truth; the modules that top-align and stop overwrite it. */
    w->ink_h = m->h;

    switch (m->kind) {
    case UI_MOD_LEAD:
    case UI_MOD_STORY:   story_run(m, v, m->w, wt, w, &dummy_a, &dummy_p); break;
    case UI_MOD_DOSSIER: dossier_run(m, v, m->w, w, &dummy_a, &dummy_p);   break;
    case UI_MOD_CHART:   chart_run(m, v, m->w, w, &dummy_a, &dummy_p);     break;
    case UI_MOD_BRIEFS:  briefs_run(m, v, m->w, w, &dummy_a, &dummy_p);    break;
    case UI_MOD_PEERS:   peers_run(m, v, m->w, w, &dummy_a, &dummy_p);     break;
    case UI_MOD_TABLE:   table_run(m, v, m->w, page, w, &dummy_a, &dummy_p); break;
    case UI_MOD_THUMBS:  thumbs_run(m, v, m->w, w, &dummy_a, &dummy_p);    break;
    case UI_MOD_QUOTE:   quote_run(m, v, m->w, w, &dummy_a, &dummy_p);     break;
    default: break;
    }
}

static void mod_hide(ui_module_t *w)
{
    w->mark_n = 0;
    ui_show(w->pane, false);
}

/* --- the rules between modules -------------------------------------------- */

/* A hairline down the gutter between two modules that share a band, and a rule
 * across the foot of every band that has something under it.
 *
 * Both are derived from the RECTANGLES rather than from the band numbers,
 * because the standing rail is a band of its own that spans the whole upper
 * region: a rule drawn across "the foot of band 2" would cut straight through
 * it. What is drawn instead is a rule over the columns that actually END on that
 * row, so the rail is crossed only when the rail itself ends there — which is
 * exactly the horizontal cut the compositor made. */
static void rules_place(ui_rules_t *r, const ui_mod_t *mods,
                        ui_module_t *const *inst, int n)
{
    int nv = 0, nh = 0;

    for (int i = 0; i < n; i++) {
        if (!mods[i].placed) continue;

        for (int j = 0; j < n; j++) {
            if (i == j || !mods[j].placed) continue;
            if (mods[j].x != mods[i].x + mods[i].w + UI_GUTTER) continue;

            const int y0 = mods[i].y > mods[j].y ? mods[i].y : mods[j].y;

            /* The rule runs to the deeper of the two columns' TYPE, not to the
             * foot of the band. See ui_module_t::ink_h — a hairline drawn past
             * the ink is the page pointing at its own white. */
            const int di = inst[i] ? inst[i]->ink_h : mods[i].h;
            const int dj = inst[j] ? inst[j]->ink_h : mods[j].h;
            const int bi = mods[i].y + (di < mods[i].h ? di : mods[i].h);
            const int bj = mods[j].y + (dj < mods[j].h ? dj : mods[j].h);

            const int y1 = bi > bj ? bi : bj;
            if (y1 <= y0 || nv >= UI_MOD_MAX) continue;

            md_at(r->vrule[nv++], mods[i].x + mods[i].w + UI_GUTTER_RULE_DX,
                  y0, UI_RULE_HAIR, y1 - y0);
        }
    }

    for (int i = 0; i < n; i++) {
        if (!mods[i].placed) continue;

        const int bot = mods[i].y + mods[i].h;

        /* One rule per distinct foot: the first module that ends on this row
         * draws it for every module that ends there. */
        bool first = true;
        for (int j = 0; j < i && first; j++) {
            if (mods[j].placed && mods[j].y + mods[j].h == bot) first = false;
        }
        if (!first) continue;

        bool below = false;
        int  x0 = 0, x1 = 0;
        for (int j = 0; j < n; j++) {
            if (!mods[j].placed) continue;
            if (mods[j].y == bot + UI_BAND_GAP) below = true;
            if (mods[j].y + mods[j].h != bot) continue;
            if (x1 == 0 || mods[j].x < x0)                x0 = mods[j].x;
            if (mods[j].x + mods[j].w > x1)               x1 = mods[j].x + mods[j].w;
        }
        if (!below || x1 <= x0 || nh >= UI_MOD_MAX) continue;

        md_at(r->hrule[nh++], x0, bot + UI_BAND_RULE_DY, x1 - x0, UI_BAND_RULE_W);
    }

    for (int i = nv; i < UI_MOD_MAX; i++) ui_show(r->vrule[i], false);
    for (int i = nh; i < UI_MOD_MAX; i++) ui_show(r->hrule[i], false);
}

/* --- the composition, remembered ------------------------------------------
 *
 * A debugging seam and the firmware never calls it, but it is not behind an
 * #ifdef: a seam that is only compiled in the simulator is a seam that is only
 * correct in the simulator. */
static ui_mod_t         s_last[UI_PAGE_COUNT][UI_MOD_MAX];
static int              s_last_n[UI_PAGE_COUNT];
static ui_compose_env_t s_last_env[UI_PAGE_COUNT];

int ui_page_layout(ui_page_t page, const ui_mod_t **mods, ui_compose_env_t *env)
{
    if (page < 0 || page >= UI_PAGE_COUNT) return 0;
    if (mods) *mods = s_last[page];
    if (env)  *env  = s_last_env[page];
    return s_last_n[page];
}

static void well_env(ui_compose_env_t *e, const news_t *v)
{
    memset(e, 0, sizeof *e);
    e->x = UI_WELL_X;
    e->y = UI_WELL_Y;
    e->w = UI_WELL_W;
    e->h = UI_WELL_H;
    e->cols     = UI_COLS;
    e->col_w    = UI_COL_W;
    e->gutter   = UI_GUTTER;
    e->band_gap = UI_BAND_GAP;
    e->measure  = ui_mod_measure;
    e->ctx      = (void *)v;
}

void ui_mod_run(ui_page_t page, const news_t *v,
                ui_module_t *pool, int pool_n, ui_rules_t *rules,
                ui_mod_t *mods, int n)
{
    if (!v || n <= 0) { ui_mod_blank(page, pool, pool_n, rules); return; }

    ui_compose_env_t env;
    well_env(&env, v);
    ui_compose(&env, mods, n);

    bool         taken[UI_MOD_MAX] = { false };
    ui_module_t *inst[UI_MOD_MAX]  = { NULL };

    /* The headline weight each placed module was given, in the order they are
     * walked, so a module can ask what its left-hand neighbour used. A file
     * static rather than a local because ui_mod_run() is called from UiTask,
     * whose whole stack is eight kilobytes. */
    static int s_weight[UI_MOD_MAX];

    /* The placed modules in (band, slot) order, as an index list.
     *
     * NOT a nested scan over band and slot looking for a match. That version
     * stopped at the first slot number it could not find, which was correct only
     * while every band was a flat left-to-right row of contiguous slots — and a
     * band's pane can now be cut horizontally too, so two modules may share a
     * column range at different heights and the numbering is the compositor's
     * business rather than something this file may assume the shape of. A gap in
     * the sequence would have silently dropped every module after it, which is
     * the worst kind of layout bug: the page still composes, still tiles, still
     * passes every check, and is missing a story.
     *
     * Insertion sort, and stable, for the reason ui_compose.c sorts that way:
     * the same fingerprint has to produce the same pixels or the device skips a
     * refresh it needed. */
    int ord[UI_MOD_MAX], nord = 0;
    for (int i = 0; i < n && nord < UI_MOD_MAX; i++) {
        if (mods[i].placed) ord[nord++] = i;
    }
    for (int i = 1; i < nord; i++) {
        const int key = ord[i];
        int j = i - 1;
        while (j >= 0
               && (mods[ord[j]].band > mods[key].band
                   || (mods[ord[j]].band == mods[key].band
                       && mods[ord[j]].slot > mods[key].slot))) {
            ord[j + 1] = ord[j];
            j--;
        }
        ord[j + 1] = key;
    }

    for (int k = 0; k < nord; k++) {
        const int at = ord[k];

        /* The weight the module to the LEFT used, and only a module actually to
         * the left. Tombstoning is about two equal headlines ABUTTING ACROSS A
         * GUTTER — the eye runs over the white and reads them as one line — so
         * it needs a horizontal neighbour. Two headlines stacked one above the
         * other in the same pane are not tombstoning; they are a column, and
         * demoting the lower one would shrink a headline for a reason that does
         * not exist. So the previous module in the band carries its weight
         * forward only when the two share a row. */
        int left = -1;
        if (k > 0 && mods[ord[k - 1]].band == mods[at].band) {
            const ui_mod_t *p = &mods[ord[k - 1]], *q = &mods[at];
            if (p->y < q->y + q->h && q->y < p->y + p->h) left = s_weight[k - 1];
        }

        const int wt = ui_head_weight(mods[at].rank, mods[at].cols, left);
        s_weight[k] = wt;

        for (int p = 0; p < pool_n; p++) {
            if (taken[p] || pool[p].kind != mods[at].kind) continue;
            taken[p]  = true;
            inst[at]  = &pool[p];
            mod_place(&pool[p], &mods[at], v, page, wt);
            break;
        }
    }

    for (int p = 0; p < pool_n; p++) if (!taken[p]) mod_hide(&pool[p]);

    rules_place(rules, mods, inst, n);

    s_last_n[page]   = n < UI_MOD_MAX ? n : UI_MOD_MAX;
    s_last_env[page] = env;
    memcpy(s_last[page], mods, (size_t)s_last_n[page] * sizeof *mods);
}

void ui_mod_blank(ui_page_t page, ui_module_t *pool, int pool_n, ui_rules_t *rules)
{
    for (int p = 0; p < pool_n; p++) mod_hide(&pool[p]);
    for (int i = 0; i < UI_MOD_MAX; i++) {
        ui_show(rules->vrule[i], false);
        ui_show(rules->hrule[i], false);
    }
    if (page >= 0 && page < UI_PAGE_COUNT) s_last_n[page] = 0;
}
