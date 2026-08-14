/*
 * ui_common.c — the shapes in ui_internal.h.
 *
 * Every object is stripped of the theme before anything else. LVGL's default
 * theme is built for a colour LCD: it rounds corners, adds a two-pixel padding,
 * makes borders a mid-grey and puts scrollbars on containers. On a panel with
 * six inks and nothing between them a mid-grey border dithers into a dashed
 * line, a rounded corner into a notch, and a scrollbar into a stray tick at the
 * edge of a table. So: remove_style_all first, then add back exactly what the
 * shape needs.
 *
 * Nothing below names a colour except as UI_INK, UI_PAPER, or an lv_color_t the
 * caller passed in. The four exact palette entries are the only values that
 * survive wp_quantize() untouched, and funnelling every one of them through the
 * defines in ui_internal.h is what makes the colour policy there something that
 * can be audited with grep instead of something that has to be believed: the
 * page's green and red enter the glass through ui_lab_c(), ui_draw_tri_abs()
 * and the two _c_abs() calls, and through nothing else.
 */
#include "ui_internal.h"

#include <stdio.h>

static void strip(lv_obj_t *o)
{
    lv_obj_remove_style_all(o);
    lv_obj_remove_flag(o, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_remove_flag(o, LV_OBJ_FLAG_CLICKABLE);
    lv_obj_set_style_radius(o, 0, 0);
    lv_obj_set_style_pad_all(o, 0, 0);
}

lv_obj_t *ui_pane(lv_obj_t *par, int x, int y, int w, int h)
{
    lv_obj_t *o = lv_obj_create(par);
    strip(o);
    lv_obj_set_pos(o, x, y);
    lv_obj_set_size(o, w, h);
    return o;
}

lv_obj_t *ui_fill(lv_obj_t *par, int x, int y, int w, int h)
{
    lv_obj_t *o = ui_pane(par, x, y, w, h);
    lv_obj_set_style_bg_color(o, UI_INK, 0);
    lv_obj_set_style_bg_opa(o, LV_OPA_COVER, 0);
    return o;
}

lv_obj_t *ui_frame(lv_obj_t *par, int x, int y, int w, int h, int bw)
{
    lv_obj_t *o = ui_pane(par, x, y, w, h);
    lv_obj_set_style_bg_color(o, UI_PAPER, 0);
    lv_obj_set_style_bg_opa(o, LV_OPA_COVER, 0);
    lv_obj_set_style_border_color(o, UI_INK, 0);
    lv_obj_set_style_border_width(o, bw, 0);
    lv_obj_set_style_border_opa(o, LV_OPA_COVER, 0);
    return o;
}

/* A rule is a filled rectangle whose short side is its weight, and the two
 * calls differ only in which side that is. They are worth their own names
 * anyway: a page that draws its rules through ui_fill() is a page where the
 * next person has to work out which of two size arguments carries the ink, and
 * where the simulator's "every rule lands on its row, full width, unbroken"
 * check has no single shape to look for. */
lv_obj_t *ui_rule(lv_obj_t *par, int x, int y, int w, int weight)
{
    return ui_fill(par, x, y, w, weight);
}

lv_obj_t *ui_vrule(lv_obj_t *par, int x, int y, int h, int weight)
{
    return ui_fill(par, x, y, weight, h);
}

/* Labels are transparent so they can sit on a filled band without punching a
 * white hole in it; the caller picks the text colour via ui_lab vs ui_lab_inv. */
static lv_obj_t *label_base(lv_obj_t *par, int x, int y, const lv_font_t *f)
{
    lv_obj_t *l = lv_label_create(par);
    strip(l);
    lv_obj_set_style_text_font(l, f, 0);
    lv_obj_set_style_text_color(l, UI_INK, 0);
    lv_obj_set_style_bg_opa(l, LV_OPA_TRANSP, 0);
    lv_obj_set_pos(l, x, y);
    return l;
}

lv_obj_t *ui_lab(lv_obj_t *par, int x, int y, const lv_font_t *f, const char *txt)
{
    lv_obj_t *l = label_base(par, x, y, f);
    lv_label_set_long_mode(l, LV_LABEL_LONG_MODE_CLIP);
    lv_label_set_text(l, txt ? txt : "");
    return l;
}

lv_obj_t *ui_lab_c(lv_obj_t *par, int x, int y, const lv_font_t *f,
                   lv_color_t colour, const char *txt)
{
    lv_obj_t *l = ui_lab(par, x, y, f, txt);
    lv_obj_set_style_text_color(l, colour, 0);
    return l;
}

lv_obj_t *ui_lab_box(lv_obj_t *par, int x, int y, int w, int h,
                     const lv_font_t *f, lv_text_align_t align, const char *txt)
{
    lv_obj_t *l = label_base(par, x, y, f);

    /* Both dimensions are pinned before the text arrives, and both are load-
     * bearing. The width is the measure the text wraps to; the height is where
     * LVGL stops and writes an ellipsis, rounded DOWN to the last whole line —
     * so n line heights buys exactly n lines and cannot spill an n+1th onto
     * whatever the band below has already claimed. strip() removed the theme's
     * line spacing, which is why that arithmetic is a multiplication and not a
     * multiplication plus a term nobody remembers to include. */
    lv_obj_set_size(l, w, h);
    lv_label_set_long_mode(l, LV_LABEL_LONG_MODE_DOTS);
    lv_obj_set_style_text_align(l, align, 0);
    lv_label_set_text(l, txt ? txt : "");
    return l;
}

lv_obj_t *ui_lab_w(lv_obj_t *par, int x, int y, int w,
                   const lv_font_t *f, lv_text_align_t align, const char *txt)
{
    /* One line, which is the case that made this call exist: with only a width
     * set LVGL auto-sizes the height, so a too-long kicker wraps instead of
     * ellipsizing and its second line lands on top of whatever is beneath it. */
    return ui_lab_box(par, x, y, w, lv_font_get_line_height(f), f, align, txt);
}

void ui_lab_wrap(lv_obj_t *label, int height)
{
    if (!label) return;
    lv_label_set_long_mode(label, LV_LABEL_LONG_MODE_WRAP);
    lv_obj_set_height(label, height);
}

void ui_lab_opaque(lv_obj_t *label)
{
    if (!label) return;
    lv_obj_set_style_bg_color(label, UI_PAPER, 0);
    lv_obj_set_style_bg_opa(label, LV_OPA_COVER, 0);
}

lv_obj_t *ui_lab_inv(lv_obj_t *par, int x, int y, int w,
                     const lv_font_t *f, lv_text_align_t align, const char *txt)
{
    lv_obj_t *l = ui_lab_w(par, x, y, w, f, align, txt);
    lv_obj_set_style_text_color(l, UI_PAPER, 0);
    return l;
}

/* Tracking is set after the text on purpose and it is safe: a style change
 * marks the label for a re-measure, so the wrap and the ellipsis are recomputed
 * against the widened advance rather than left over from the solid setting.
 * Doing it the other way round — track first, then set — would be the same
 * work, and every caller has the text in hand at the point it wants tracking. */
void ui_track(lv_obj_t *label, int px)
{
    if (!label) return;
    lv_obj_set_style_text_letter_space(label, px, 0);
}

void ui_set(lv_obj_t *label, const char *txt)
{
    if (label) lv_label_set_text(label, txt ? txt : "");
}

void ui_setf(lv_obj_t *label, const char *fmt, ...)
{
    if (!label) return;
    va_list ap;
    va_start(ap, fmt);
    lv_label_set_text_vfmt(label, fmt, ap);
    va_end(ap);
}

void ui_show(lv_obj_t *obj, bool visible)
{
    if (!obj) return;
    if (visible) lv_obj_remove_flag(obj, LV_OBJ_FLAG_HIDDEN);
    else         lv_obj_add_flag(obj, LV_OBJ_FLAG_HIDDEN);
}

/* --- immediate-mode drawing ---------------------------------------------- */

static lv_color_t ink(bool white)
{
    return white ? UI_PAPER : UI_INK;
}

/*
 * A line, laid down as an exact set of pixels rather than handed to
 * lv_draw_line(). This is ui_draw_tri_abs()'s argument again, arriving through
 * the charts instead of through the marks, and it was measured on the glass
 * before it was decided.
 *
 * LVGL antialiases a diagonal: every pixel down the slope leaves the draw
 * buffer as a blend of the ink and the paper, and this panel has nothing
 * between the two for a blend to land on. wp_quantize565() resolves each of
 * those greys to whichever of the six inks is nearest under the Bayer offset,
 * and for the mid-greys a black stroke on white paper produces, that ink is
 * GREEN. So a chart drawn with lv_draw_line() is not a black chart — it is a
 * black chart fringed with green speckle, in a band the colour policy does not
 * allow colour in, and the reader sees it as dirt on the paper.
 *
 * Hence integer Bresenham, emitted as run-length spans through the rectangle
 * above: every pixel is exactly the colour that was asked for and takes
 * wp_quantize565()'s identity path. No libm and no float, for the same reason
 * ui_graph.c carries its own sine table — a double rounded differently on x86
 * and on Xtensa moves a node a pixel and fails a screenshot test for a reason
 * that has nothing to do with the drawing.
 *
 * Width is spent across the MINOR axis — a shallow line is thickened
 * vertically, a steep one horizontally — which is a pen held upright rather
 * than one held perpendicular to the stroke. At 45 degrees that measures
 * narrower than the width asked for, which is what every plotter that draws a
 * line as spans does, and at the two or three pixels this page strokes at the
 * difference is not visible. What it buys is that the spans tile: consecutive
 * steps share an edge, so no diagonal can open a one-pixel hole the way a
 * square brush stamped per pixel does.
 */
void ui_draw_line_c_abs(lv_layer_t *L, int x1, int y1, int x2, int y2, int w,
                        lv_color_t colour)
{
    if (w < 1) w = 1;

    /* Centred on the geometric line, with an even width taking its extra pixel
     * below (or right of) it. That matches ui_chart_y()'s rounding, so a 2 px
     * polyline sits ON the row its value scaled to instead of straddling it. */
    const int t0 = -(w - 1) / 2, t1 = t0 + w - 1;

    const int dx = x2 - x1, dy = y2 - y1;
    const int adx = dx < 0 ? -dx : dx;
    const int ady = dy < 0 ? -dy : dy;
    int t;

    if (adx >= ady) {
        /* Shallow: one span per run of constant y, so a near-horizontal stroke
         * is a handful of rectangles rather than one per pixel. */
        if (x1 > x2) { t = x1; x1 = x2; x2 = t;  t = y1; y1 = y2; y2 = t; }

        const int sy = y2 >= y1 ? 1 : -1;
        int err = adx / 2;              /* the half-step that centres the stair */
        int y = y1, run = x1;

        for (int x = x1; x <= x2; x++) {
            err -= ady;
            if (err < 0 && x < x2) {
                ui_draw_rect_c_abs(L, run, y + t0, x, y + t1, true, 0, colour);
                err += adx;
                y   += sy;
                run  = x + 1;
            }
        }
        ui_draw_rect_c_abs(L, run, y + t0, x2, y + t1, true, 0, colour);
    } else {
        if (y1 > y2) { t = x1; x1 = x2; x2 = t;  t = y1; y1 = y2; y2 = t; }

        const int sx = x2 >= x1 ? 1 : -1;
        int err = ady / 2;
        int x = x1, run = y1;

        for (int y = y1; y <= y2; y++) {
            err -= adx;
            if (err < 0 && y < y2) {
                ui_draw_rect_c_abs(L, x + t0, run, x + t1, y, true, 0, colour);
                err += ady;
                x   += sx;
                run  = y + 1;
            }
        }
        ui_draw_rect_c_abs(L, x + t0, run, x + t1, y2, true, 0, colour);
    }
}

void ui_draw_line_abs(lv_layer_t *L, int x1, int y1, int x2, int y2, int w, bool white)
{
    ui_draw_line_c_abs(L, x1, y1, x2, y2, w, ink(white));
}

/* A disc, not a circle: LVGL draws an arc of width `w` at radius `r`, so a
 * width equal to the radius fills all the way to the centre. */
void ui_draw_disc_abs(lv_layer_t *L, int cx, int cy, int r, bool white)
{
    lv_draw_arc_dsc_t d;
    lv_draw_arc_dsc_init(&d);
    d.color = ink(white);
    d.width = r;
    d.radius = r;
    d.center.x = cx; d.center.y = cy;
    d.start_angle = 0; d.end_angle = 360;
    d.opa = LV_OPA_COVER;
    lv_draw_arc(L, &d);
}

void ui_draw_ring_abs(lv_layer_t *L, int cx, int cy, int r, int w, int a0, int a1)
{
    lv_draw_arc_dsc_t d;
    lv_draw_arc_dsc_init(&d);
    d.color = UI_INK;
    d.width = w;
    d.radius = r;
    d.center.x = cx; d.center.y = cy;
    d.start_angle = a0; d.end_angle = a1;
    d.opa = LV_OPA_COVER;
    lv_draw_arc(L, &d);
}

void ui_draw_rect_c_abs(lv_layer_t *L, int x1, int y1, int x2, int y2,
                        bool fill, int border, lv_color_t colour)
{
    lv_draw_rect_dsc_t d;
    lv_draw_rect_dsc_init(&d);
    d.radius  = 0;
    d.bg_color = colour;
    d.bg_opa   = fill ? LV_OPA_COVER : LV_OPA_TRANSP;
    if (border > 0) {
        d.border_color = colour;
        d.border_width = border;
        d.border_opa   = LV_OPA_COVER;
    }
    lv_area_t a = { x1, y1, x2, y2 };
    lv_draw_rect(L, &d, &a);
}

void ui_draw_rect_abs(lv_layer_t *L, int x1, int y1, int x2, int y2,
                      bool fill, int border, bool white)
{
    ui_draw_rect_c_abs(L, x1, y1, x2, y2, fill, border, ink(white));
}

/*
 * The up/down mark, filled one scanline at a time rather than handed to
 * lv_draw_triangle(). That is not a preference: LVGL builds a triangle out of
 * anti-aliased line masks, so every pixel down both slopes is a blend of the
 * mark's colour and the paper — and on this panel there is nothing between the
 * two for a blend to land on. wp_quantize()'s ordered dither breaks each slope
 * into a checkerboard, and at the ten or twelve pixels these marks are set at,
 * the slopes ARE the shape. A run of 1 px rectangles is every pixel exactly the
 * ink that was asked for.
 *
 * Each row is derived as a HALF-width and then doubled, which is what holds
 * every one of them on the same axis: twice a half-width always has w's own
 * parity, so (w - span) / 2 divides exactly and no row sits a pixel left of the
 * one above it. Stepping the full width instead would alternate odd and even
 * spans inside an odd-width mark and put a visible lean into a shape whose
 * entire job is to be read as symmetric at a glance — and would stop the two
 * marks being reflections of each other. An even mark comes to a two-pixel
 * point because it has no centre column to come to a one-pixel one on.
 */
void ui_draw_tri_abs(lv_layer_t *L, int x, int y, int w, int h,
                     bool up, lv_color_t colour)
{
    if (w <= 0 || h <= 0) return;

    const int hmin = 1 - (w & 1);       /* half-width at the point */
    const int rise = (w - 1) / 2;       /* half-widths gained from point to base */

    for (int i = 0; i < h; i++) {
        int step = up ? i : h - 1 - i;
        int half = hmin + (h == 1 ? rise : (step * rise) / (h - 1));
        int span = 2 * half + (w & 1);
        int x0   = x + (w - span) / 2;
        ui_draw_rect_c_abs(L, x0, y + i, x0 + span - 1, y + i, true, 0, colour);
    }
}

/* --- text ----------------------------------------------------------------- */

void ui_group_int(char *out, size_t n, int v)
{
    if (!out || n == 0) return;

    char digits[16];
    bool neg = v < 0;
    /* Negate in unsigned, where the wrap is defined: -INT_MIN is not, and
     * widening to long does not rescue it on a device where long is also 32
     * bits. A figure that arrives as INT_MIN is exactly what a broken producer
     * sends, and it must print rather than invoke the optimiser's imagination. */
    unsigned long a = neg ? 0UL - (unsigned long)v : (unsigned long)v;
    int  nd = snprintf(digits, sizeof(digits), "%lu", a);
    if (nd < 0) { out[0] = '\0'; return; }
    if (nd > (int)sizeof(digits) - 1) nd = (int)sizeof(digits) - 1;

    size_t o = 0;
    if (neg && o + 1 < n) out[o++] = '-';
    for (int i = 0; i < nd; i++) {
        if (i > 0 && (nd - i) % 3 == 0) {
            if (o + 1 >= n) break;
            out[o++] = ',';
        }
        if (o + 1 >= n) break;
        out[o++] = digits[i];
    }
    out[o] = '\0';
}

/* The dollars are grouped and the cents are not, which is what a quotation
 * table does: the separator is there to be counted off in threes from the
 * decimal point, and putting one inside the fraction would give the eye a third
 * kind of comma to sort out at a glance. */
void ui_money(char *out, size_t n, int32_t cents)
{
    if (!out || n == 0) return;

    unsigned long a = cents < 0 ? 0UL - (unsigned long)cents : (unsigned long)cents;
    char whole[24];
    ui_group_int(whole, sizeof(whole), (int)(a / 100));
    snprintf(out, n, "%s%s.%02lu", cents < 0 ? "-" : "", whole, a % 100);
}

/* A percentage carries its sign, the plus included, AND IT CARRIES IT AT ZERO:
 * a signed column that drops its sign on the one flat row goes ragged there and
 * the gap reads as a figure that failed to print. What an unchanged session
 * gets instead is the ink — ui_chg_colour() takes the market colour away at
 * zero, and the mark beside it is a bar rather than a triangle — so the row
 * says "flat" twice without the column losing its left edge. */
/* A percentage carries its sign, the plus included: a column where only the
 * losses are signed reads as a column of typos. Zero carries NEITHER — a
 * session that did not move has not earned a plus, and "+0.00%" printed beside
 * the flat mark is one row making two different claims about the same day. */
void ui_pct(char *out, size_t n, int32_t bp)
{
    if (!out || n == 0) return;

    unsigned long a = bp < 0 ? 0UL - (unsigned long)bp : (unsigned long)bp;
    snprintf(out, n, "%s%lu.%02lu%%", bp < 0 ? "-" : "+", a / 100, a % 100);
}

/* Upper case for the two tracked slots that take a string off the wire. ASCII
 * a-z, and Latin-1's own lower case in its UTF-8 spelling (0xC3 0xA0..0xBE, the
 * accented letters a dateline and a byline routinely carry) — everything else,
 * including 0xC3 0xB7 DIVISION SIGN and every three-byte sequence, is copied
 * through untouched. */
void ui_upper(char *out, size_t n, const char *src)
{
    if (!out || n == 0) return;
    out[0] = '\0';
    if (!src) return;

    size_t o = 0;
    for (size_t i = 0; src[i] && o + 1 < n; i++) {
        unsigned char c = (unsigned char)src[i];

        if (c >= 'a' && c <= 'z') {
            out[o++] = (char)(c - 32);
            continue;
        }
        if (c == 0xC3 && o + 2 < n) {
            unsigned char d = (unsigned char)src[i + 1];
            out[o++] = (char)c;
            if (d >= 0xA0 && d <= 0xBE && d != 0xB7) d = (unsigned char)(d - 32);
            out[o++] = (char)d;
            if (src[i + 1]) i++;
            continue;
        }
        out[o++] = (char)c;
    }
    out[o] = '\0';
}
