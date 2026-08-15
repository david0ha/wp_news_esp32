/*
 * ui_chart.c — the scale, then the ink.
 *
 * The first half is arithmetic on the model and compiles with no LVGL at all;
 * test_chart_scale.c builds exactly this file and asserts on it. The second
 * half turns rows and columns into rectangles and lines, and holds no
 * arithmetic that the first half could have done instead. That split is the
 * whole design: see ui_chart.h for why.
 *
 * Two things about the drawing are not obvious and are the reason it looks the
 * way it does.
 *
 * Every mark on a chart is an exact rectangle of ink. The furniture —
 * baselines, wicks, bodies, borders, the reference line — is axis-aligned and
 * always was; the diagonals go through ui_draw_line_abs(), which is a
 * hard-pixel Bresenham run and not lv_draw_line(). That distinction is the
 * whole reason the charts look like print: an antialiased diagonal leaves greys
 * in the draw buffer, the flush callback puts those through wp_quantize565()'s
 * ordered dither, and the greys a black stroke on white paper makes resolve to
 * GREEN — so every polyline on the sheet used to carry a green fringe, in bands
 * where the colour policy allows no colour at all. It is the same failure that
 * made every font on this board 1 bpp, arriving through the charts.
 *
 * A polyline is still 2 px even in a 16 px sparkline, but now for the ordinary
 * reason: one pixel of a stair-stepped diagonal reads as thinner than the
 * hairlines around it from across a room.
 *
 * A candle's wick is drawn before its body. A falling candle is white with a
 * black outline, and that white fill is what has to punch the shadow out of the
 * middle of the body; painting the body first would leave the wick running
 * through it and turn every down day into an up day with a line drawn on it.
 */
#include "ui_chart.h"

#include <stddef.h>
#include <stdint.h>

/* --- series identity ------------------------------------------------------
 *
 * THE DERIVATION, written out so the next person can CHECK the table below
 * rather than trust it. ui_chart.h says what is maximised; this says how it
 * comes out and why there is no room left for taste in it.
 *
 * THE MEASUREMENTS. Relative luminance of the MEASURED inks — tools/make_tile.py's
 * table, which is what the panel prints, not the saturated primaries the UI
 * draws with and wp_quantize() takes as an index:
 *
 *              L        L+0.05   hue        texture
 *     SOLID   0.0158    0.0658   neutral    flat
 *     BLUE    0.0587    0.1087   blue       flat
 *     SCREEN  0.3744    0.4244   neutral    striped     (L is (1*S + 2*O) / 3)
 *     KEYED   0.4697    0.5197   yellow     flat
 *     OPEN    0.5538    0.6038   neutral    flat
 *
 * THE ONE BOUNDARY THE PANEL DRAWS FOR ITSELF. Sort those luminances and there
 * is exactly one gap worth the name: BLUE to SCREEN is 3.90:1, and the next
 * largest step anywhere in the list is SOLID to BLUE at 1.65:1. So the panel is
 * two bands — DARK {SOLID, BLUE} and LIGHT {SCREEN, KEYED, OPEN} — and that
 * split is read off the ink table rather than chosen. Value can separate ACROSS
 * the boundary and cannot separate inside a band; every within-band pair is
 * under 1.7:1.
 *
 * WHICH PAIRS A READER CAN ACTUALLY TELL APART. A pair is separated when it
 * differs on at least one of the three axes with room to spare, and each axis
 * says when it has room:
 *
 *     VALUE    the two are in different bands
 *     TEXTURE  one is striped and the other is not — the only axis that is
 *              scale-free, and the reason a newspaper has always divided a
 *              stacked bar with screen tone
 *     HUE      the hues differ AND the pair is in the LIGHT band. Hue needs
 *              luminance: yellow against paper is a colour, navy against black
 *              is two darks.
 *
 * Run that over all ten pairs and exactly ONE fails:
 *
 *     SOLID-BLUE   same band, same texture, hue at the dark end   NOT SEPARATED
 *
 * which is the pair ui_internal.h's colour note spends a paragraph forbidding,
 * arrived at here from the ink table instead of from the prohibition. Every
 * other pair passes, including the two the value ordering alone would have
 * condemned: SCREEN-KEYED is 1.22:1 but striped against flat AND neutral against
 * yellow, and KEYED-OPEN is 1.16:1 but yellow against neutral inside identical
 * keylines, in the band where hue works.
 *
 * SO THE PICKS FALL OUT WITH NOTHING LEFT TO CHOOSE. Take the sets of size n in
 * which every pair is separated; among those, carry as many HUES as possible,
 * and let the value spread break what ties remain. The dark band holds ONE
 * usable treatment and the light band holds three, so the ceiling is four:
 *
 *     n   picks                             consecutive contrast
 *     1   SOLID                              -
 *     2   BLUE               KEYED          4.78
 *     3   BLUE  SCREEN       KEYED          3.90  1.22
 *     4   BLUE  SCREEN KEYED OPEN           3.90  1.22  1.16
 *     5   SOLID BLUE SCREEN  KEYED OPEN     1.65  3.90  1.22  1.16
 *
 * n = 2: {BLUE, KEYED} is the only pair carrying both hues, and at 4.78:1 it is
 *        comfortably separated as well.
 * n = 3: SCREEN joins them rather than OPEN. {BLUE,SCREEN,OPEN} has the better
 *        worst pair (1.42 against 1.22) and one hue fewer; the 1.22 pair is
 *        SCREEN against KEYED, which is striped-neutral against flat-yellow and
 *        so is separated twice over.
 * n = 4: OPEN joins them, and this is the row where the panel is spent.
 * n = 5: THERE IS NO SEPARATED SET OF FIVE. Asking for five puts SOLID next to
 *        BLUE because the panel has nowhere else to put it. The row exists
 *        because UI_SERIES_N is five and the function must answer, not because
 *        five works — a graphic that needs five quantities needs two graphics.
 * n = 1: no pair to separate, so nothing above applies. A hue that distinguishes
 *        nothing is ornament, which the colour policy forbids, and a lone series
 *        takes the page's ink.
 *
 * Each row is a subset of the one under it, which was not imposed and is worth
 * knowing: a graphic that gains a series never re-treats the ones it already had.
 *
 * WHY HUES FIRST, WHICH IS THE HALF OF THE OBJECTIVE THAT WAS MISSING. This
 * function was first written to maximise the value spread alone, and it produced
 * a table — SOLID/OPEN, SOLID/SCREEN/OPEN, SOLID/SCREEN/KEYED/OPEN — in which
 * BLUE appeared only at n = 5, which is unseparable anyway. Every graphic this
 * paper draws carries two or three series, so the two coloured inks the panel
 * has reached the glass exactly never and the sheets came back black. The
 * arithmetic was right and the objective was wrong: `series_ok()` has ALREADY
 * guaranteed that every pair is separated, so extra value contrast past that
 * point buys a reader nothing they did not already have, while a hue buys the
 * thing the design is for — a bar that says which quantity it is by its colour
 * instead of by its rank in a legend.
 *
 * It is not "use colour wherever possible". Admissibility is absolute and is
 * still tested first: SOLID beside BLUE is forbidden at every n, and KEYED's
 * yellow still never touches paper. All that changed is which of two equally
 * readable sets gets written down.
 *
 * WHY NOT MAXIMISE VALUE ALONE, beyond the above: rank by luminance contrast
 * with no admissibility test and n = 3 comes out {SOLID, BLUE, OPEN} — a black
 * bar against a navy one, scoring 1.65 where {SOLID,SCREEN,OPEN} scores 1.42 —
 * because a ratio counts the dark end's 1.65 as a bigger difference than the
 * light end's 1.42 and a reader does not. Rank by gamma-encoded luma DIFFERENCE
 * instead and n = 4 comes out {SOLID,BLUE,SCREEN,OPEN}, the same mistake one row
 * later. Both failures are the same failure: a scalar over value cannot express
 * that the panel's dark band has one usable treatment in it and its light band
 * has three.
 *
 * The arithmetic never changes, so this is a table and not a search.
 * test_chart_scale.c encodes the three axes above and runs the search, and
 * fails if any row here is beatable or contains an unseparated pair it did not
 * have to. */
ui_series_t ui_series_at(int i, int n)
{
    /* [n - 1][i]. Each row turns out to be a subset of the one under it: that
     * was not imposed, it fell out, and it is worth knowing because it means a
     * graphic that gains a series never introduces a treatment above one it was
     * already using — the ladder is walked, not permuted. */
    static const uint8_t pick[UI_SERIES_N][UI_SERIES_N] = {
        { UI_SERIES_SOLID },
        { UI_SERIES_BLUE, UI_SERIES_KEYED },
        { UI_SERIES_BLUE, UI_SERIES_SCREEN, UI_SERIES_KEYED },
        { UI_SERIES_BLUE, UI_SERIES_SCREEN, UI_SERIES_KEYED, UI_SERIES_OPEN },
        { UI_SERIES_SOLID, UI_SERIES_BLUE, UI_SERIES_SCREEN, UI_SERIES_KEYED,
          UI_SERIES_OPEN },
    };

    if (n < 1 || n > UI_SERIES_N) return UI_SERIES_SOLID;
    if (i < 0 || i >= n)          return UI_SERIES_SOLID;

    return (ui_series_t)pick[n - 1][i];
}

/* --- the scale ------------------------------------------------------------ */

ui_chart_win_t ui_chart_window(const int32_t *lo, const int32_t *hi, int n)
{
    /* One unit tall, centred on zero: nothing is drawn on an empty series, but
     * everything downstream still divides by a positive span. */
    ui_chart_win_t w = { -1, 1 };

    if (n <= 0 || (lo == NULL && hi == NULL)) return w;
    if (lo == NULL) lo = hi;
    if (hi == NULL) hi = lo;

    int64_t mn = lo[0], mx = lo[0];
    for (int i = 0; i < n; i++) {
        if (lo[i] < mn) mn = lo[i];
        if (lo[i] > mx) mx = lo[i];
        if (hi[i] < mn) mn = hi[i];
        if (hi[i] > mx) mx = hi[i];
    }

    /* At least one unit each side, so a series that never moves — a holiday
     * session, a stock halted all day — still gets a window it can sit in the
     * middle of instead of one with no height. */
    int64_t margin = (mx - mn) / UI_CHART_HEADROOM;
    if (margin < 1) margin = 1;

    w.lo = mn - margin;
    w.hi = mx + margin;
    return w;
}

int ui_chart_y(int32_t v, ui_chart_win_t w, int h)
{
    if (h <= 1) return 0;

    int64_t span = w.hi - w.lo;
    if (span <= 0) return (h - 1) / 2;

    int64_t d = (int64_t)v - w.lo;
    if (d < 0)    d = 0;
    if (d > span) d = span;

    /* int64 throughout: a series spanning the whole of int32_t already needs 33
     * bits before the multiply, and (h - 1) adds ten more. Rounded rather than
     * truncated so a value exactly halfway between two rows does not always
     * fall towards the bottom of the box. */
    int64_t row = (d * (int64_t)(h - 1) + span / 2) / span;
    return (h - 1) - (int)row;
}

void ui_chart_scale(const int32_t *v, int n, ui_chart_win_t w, int h,
                    int16_t *y_out)
{
    if (v == NULL || y_out == NULL || n <= 0) return;
    for (int i = 0; i < n; i++) y_out[i] = (int16_t)ui_chart_y(v[i], w, h);
}

int ui_chart_x(int i, int n, int w)
{
    if (w <= 0) return 0;
    if (w == 1 || n <= 1) return (w - 1) / 2;

    /* The ends are returned rather than computed, which is not an optimisation:
     * it is what guarantees a polyline touches both edges of its box whatever
     * the division does in between. */
    if (i <= 0)     return 0;
    if (i >= n - 1) return w - 1;

    return (int)(((int64_t)i * (w - 1) + (n - 1) / 2) / (n - 1));
}

int ui_chart_cols(int n, int w)
{
    if (n <= 0 || w <= 0) return 0;
    return n < w ? n : w;
}

int ui_chart_pick(int i, int m, int n)
{
    if (n <= 1) return 0;
    if (m <= 1) return n - 1;       /* one column shows the latest, never the oldest */

    if (i <= 0)     return 0;
    if (i >= m - 1) return n - 1;

    return (int)(((int64_t)i * (n - 1) + (m - 1) / 2) / (m - 1));
}

/* --- the ink -------------------------------------------------------------- */
#if UI_CHART_LVGL

#include "ui_internal.h"

#include <stdbool.h>
#include <stdio.h>
#include <string.h>

/* Two pixels, for the reason in the file comment. */
#define CH_STROKE       2

/* A candle body never grows past this, so a payload with three bars draws three
 * candles rather than three black slabs a third of the box wide each. Below it
 * the body is the slot less one pixel of paper on each side, which is what
 * keeps forty-eight of them from merging into a solid block. */
#define CH_BODY_MAX    24

/* The dash and the gap of the reference line, stepped by hand: the shape
 * helpers carry no dash pattern, and stepping from the left edge pins the
 * phase, so two charts stacked in the same column have their dashes in
 * register instead of a pixel apart. */
#define CH_DASH         3
#define CH_DASH_GAP     3

/* Room for "123,456.78" at label_14's 6.94 px average advance, and never more
 * than half the box. Under CH_VAL_MIN_W there is no point in the figure at all:
 * a price ellipsized to three characters is a lie that looks like a reading. */
#define CH_VAL_W       88
#define CH_VAL_MIN_W   40

/* Per-object state on the heap rather than a file static, because the page
 * draws ten of these at once: the lead's chart, the portfolio rail's, and a
 * sparkline in every row of the quotation table. Nine hundred bytes apiece on a
 * board with 8 MB of PSRAM is not worth a second, narrower struct for the
 * sparklines — a sparkline is a line chart with its furniture removed, and one
 * shape here means one drawing path rather than two that drift apart.
 *
 * Only the series the kind reads are maintained; the others hold whatever the
 * last payload left. */
typedef struct {
    chart_kind_t kind;
    bool         spark;
    int          n;
    int          bw, bh;            /* the box, as asked for at create time */
    int16_t      pad_l, pad_r;      /* the plot inset — see plot_rect() */
    int32_t      o[NEWS_BARS_MAX], h[NEWS_BARS_MAX],
                 l[NEWS_BARS_MAX], c[NEWS_BARS_MAX];
    lv_obj_t    *first, *last;      /* the two value labels, created on demand */
} chart_t;

/* --- the plot rect --------------------------------------------------------
 *
 * THE SERIES IS NOT DRAWN ON THE WHOLE WIDGET, and until now it was.
 *
 * ui_chart_x() returns the box's own edges for the first and last sample and
 * ui_chart_y() returns row 0 for the window's top, so a rising series ended on
 * the pixel column x = w-1 at row y = 0 — with a 2 px stroke laid downward and
 * rightward from there, which is one pixel of ink outside the box on each of two
 * edges. On the lead's chart that put the price line through its own 1 px
 * outline at both ends. Worse, the two value labels are positioned at x = 0 and
 * x = w - lw, INSIDE the same box, so on any series that ends near its own
 * extreme the polyline runs straight through the figure it is labelled with:
 * "404.70" with a black diagonal drawn across the digits.
 *
 * So the drawing area is the widget inset by four numbers.
 *
 *   left/right   the value labels' own widths, when there are labels. They are
 *                measured in label_ends() and stored, because the label is laid
 *                out at set time and the series is drawn at flush time, and the
 *                two must agree to the pixel or the gap reopens.
 *   top          the stroke, which is laid downward from the row it computes.
 *   bottom       the stroke, plus the axis rule when the chart draws one.
 *
 * A sparkline has no labels and no axis, so its inset is the stroke alone: it
 * keeps essentially the whole of its 54 x 36, which is the point of a sparkline.
 *
 * All of it is integer. The window scaling is untouched — this moves the box the
 * scale is computed against, and nothing about how the scale is computed. */
#define CH_LAB_GAP      6           /* paper between a value and the plot */

static void plot_rect(const chart_t *s, int w, int h,
                      int *px, int *py, int *pw, int *ph)
{
    const int axis = (!s->spark && s->kind == CHART_LINE) ? 1 : 0;

    int x0 = s->pad_l;
    int x1 = w - s->pad_r;                      /* exclusive */
    int y0 = 0;
    int y1 = h - (CH_STROKE - 1) - axis;        /* exclusive */

    /* A box too small for the inset keeps the box. A chart drawn one pixel wide
     * is wrong, but a chart not drawn at all is the failure this file's own
     * comment calls "what a chart that failed looks like". */
    if (x1 - x0 < 2) { x0 = 0; x1 = w; }
    if (y1 - y0 < 2) { y0 = 0; y1 = h; }

    *px = x0;
    *py = y0;
    *pw = x1 - x0;
    *ph = y1 - y0;
}

static chart_t *state_of(lv_obj_t *chart)
{
    return chart ? (chart_t *)lv_obj_get_user_data(chart) : NULL;
}

/* An exact rectangle of ink, for everything that is not a polyline. */
static void bar_abs(lv_layer_t *L, int x1, int y1, int x2, int y2, bool white)
{
    ui_draw_rect_abs(L, x1, y1, x2, y2, true, 0, white);
}

/* A one-pixel outline, as four filled rectangles rather than as a rect with a
 * border width. LVGL's border is drawn by the same code path that rounds a
 * corner, and a down candle's outline is the one hairline on the page that is
 * only ever one pixel wide — there is no second row of ink to hide a pixel
 * this file did not ask for. Four bars are four spans of exact ink. */
static void outline_abs(lv_layer_t *L, int x1, int y1, int x2, int y2)
{
    bar_abs(L, x1, y1, x2, y1, false);          /* top    */
    bar_abs(L, x1, y2, x2, y2, false);          /* bottom */
    bar_abs(L, x1, y1, x1, y2, false);          /* left   */
    bar_abs(L, x2, y1, x2, y2, false);          /* right  */
}

/* 641283 -> "6,412.83". The whole part goes through ui_group_int for the same
 * reason the ribbon's levels do — an ungrouped five-digit number is genuinely
 * slower to read — and the sign is ASCII '-', which is the board's convention
 * because no face here carries U+2212. The negation runs through int64 because
 * -INT32_MIN has nowhere to go in the 32-bit long this compiles to on Xtensa. */
static void fmt_cents(char *out, size_t n, int32_t cents)
{
    int64_t v = cents;
    bool neg = v < 0;
    if (neg) v = -v;

    char whole[16];
    ui_group_int(whole, sizeof whole, (int)(v / 100));
    snprintf(out, n, "%s%s.%02d", neg ? "-" : "", whole, (int)(v % 100));
}

/* The i-th of m slots: the pixels the candle owns, the column its wick runs
 * down, and the body's own narrower span. Slot edges are computed from i*w/m
 * rather than accumulated, so the last slot ends on the box's right edge
 * exactly and no rounding is left over to show up as a gap. */
static void slot_of(int i, int m, int w, int *cx, int *bx1, int *bx2)
{
    int a = (int)(((int64_t)i * w) / m);
    int b = (int)((((int64_t)i + 1) * w) / m) - 1;
    if (b < a) b = a;

    int mid  = (a + b) / 2;
    int body = (b - a + 1) - 2;
    if (body > CH_BODY_MAX) body = CH_BODY_MAX;
    if (body < 1)           body = b - a + 1;

    *cx  = mid;
    *bx1 = mid - (body - 1) / 2;
    *bx2 = *bx1 + body - 1;
}

static void draw_line(lv_layer_t *L, const chart_t *s, ui_chart_win_t win,
                      int ox, int oy, int w, int h, int m)
{
    /* One sample, or a box too narrow to hold two columns: the level runs
     * across the whole measure. A lone point plotted as a point reads as a
     * speck of dirt on the paper, and drawing nothing at all is what a chart
     * that failed looks like. */
    if (s->n == 1 || m == 1) {
        int y = ui_chart_y(s->c[s->n - 1], win, h);
        ui_draw_line_abs(L, ox, oy + y, ox + w - 1, oy + y, CH_STROKE, false);
        return;
    }

    /* The stroke's width is applied across the line's SHALLOW axis — in y for a
     * near-horizontal run, in x for a near-vertical one — which is what keeps a
     * 2 px polyline sitting on the row its value scaled to. Where two segments
     * of opposite steepness meet, that means the two rectangles are thickened
     * on different axes and the joint can fall between them: a hole in the
     * price line, three pixels wide, at exactly the turn a reader is looking
     * at. So every vertex is stamped with a square of the stroke's own width.
     * Cheaper than tracking the miter, and there is nothing else a joint on a
     * hard-pixel line can want. */
    int px = 0, py = 0;
    for (int i = 0; i < m; i++) {
        int x = ui_chart_x(i, m, w);
        int y = ui_chart_y(s->c[ui_chart_pick(i, m, s->n)], win, h);
        if (i > 0) {
            ui_draw_line_abs(L, ox + px, oy + py, ox + x, oy + y,
                             CH_STROKE, false);
            bar_abs(L, ox + px, oy + py, ox + px + CH_STROKE - 1,
                    oy + py + CH_STROKE - 1, false);
        }
        px = x;
        py = y;
    }
}

static void draw_candles(lv_layer_t *L, const chart_t *s, ui_chart_win_t win,
                         int ox, int oy, int w, int h, int m)
{
    for (int i = 0; i < m; i++) {
        int k = ui_chart_pick(i, m, s->n);
        int cx, x1, x2;
        slot_of(i, m, w, &cx, &x1, &x2);

        int yh = ui_chart_y(s->h[k], win, h);
        int yl = ui_chart_y(s->l[k], win, h);
        if (yh > yl) { int t = yh; yh = yl; yl = t; }
        bar_abs(L, ox + cx, oy + yh, ox + cx, oy + yl, false);

        int yo = ui_chart_y(s->o[k], win, h);
        int yc = ui_chart_y(s->c[k], win, h);
        int top = yo < yc ? yo : yc, bot = yo < yc ? yc : yo;

        if (s->c[k] >= s->o[k]) {
            bar_abs(L, ox + x1, oy + top, ox + x2, oy + bot, false);
        } else {
            /* Paper first to clear the wick, then the outline. Two calls
             * because the shape helper paints its fill and its border in one
             * colour, and this is the only place on the page that wants two. */
            bar_abs(L, ox + x1, oy + top, ox + x2, oy + bot, true);
            outline_abs(L, ox + x1, oy + top, ox + x2, oy + bot);
        }
    }
}

static void draw_bars(lv_layer_t *L, const chart_t *s, ui_chart_win_t win,
                      int ox, int oy, int w, int h, int m)
{
    /* Bars grow from zero when zero is on the scale, and from the foot of the
     * box when it is not — asking for the row of zero and letting ui_chart_y's
     * clamp answer is the whole of that rule. A series that is entirely
     * negative therefore hangs from the top, which is correct and is the only
     * way a reader can tell it apart from one that is entirely positive. */
    int base = ui_chart_y(0, win, h);
    bar_abs(L, ox, oy + base, ox + w - 1, oy + base, false);

    for (int i = 0; i < m; i++) {
        int k = ui_chart_pick(i, m, s->n);
        int cx, x1, x2;
        slot_of(i, m, w, &cx, &x1, &x2);

        int y = ui_chart_y(s->c[k], win, h);
        int top = y < base ? y : base, bot = y < base ? base : y;
        bar_abs(L, ox + x1, oy + top, ox + x2, oy + bot, false);
    }
}

static void chart_draw_cb(lv_event_t *e)
{
    lv_obj_t   *obj = lv_event_get_target_obj(e);
    lv_layer_t *L   = lv_event_get_layer(e);
    chart_t    *s   = state_of(obj);
    if (!L || !s || s->kind == CHART_NONE || s->n <= 0) return;

    lv_area_t a;
    lv_obj_get_coords(obj, &a);

    /* The widget, and then the rectangle the series is actually allowed in.
     * Everything below works in the plot rect: the origin moves to its corner
     * and w/h become its own, so the scaling, the column arithmetic and the
     * furniture all agree about where the chart is without any of them being
     * told twice. */
    int px, py, pw, ph;
    plot_rect(s, lv_area_get_width(&a), lv_area_get_height(&a),
              &px, &py, &pw, &ph);

    const int ox = a.x1 + px, oy = a.y1 + py;
    const int w  = pw, h = ph;

    const int m = ui_chart_cols(s->n, w);
    if (m <= 0 || h <= 0 || w <= 0) return;

    ui_chart_win_t win = (s->kind == CHART_CANDLE)
                       ? ui_chart_window(s->l, s->h, s->n)
                       : ui_chart_window(s->c, s->c, s->n);

    /* Furniture first, so the series is never drawn under its own axis.
     *
     * The axis is the one mark that belongs to the WIDGET rather than to the
     * plot: it is the chart's baseline and it runs the full width under
     * everything, value labels included. The plot rect already reserved its row
     * — that is the `axis` term in plot_rect() — so it cannot be drawn on. */
    if (!s->spark) {
        if (s->kind == CHART_LINE) {
            const int ay = a.y1 + lv_area_get_height(&a) - 1;
            bar_abs(L, a.x1, ay, a.x1 + lv_area_get_width(&a) - 1, ay, false);
        }

        /* The last close, carried across the plot. It is the one detail that
         * turns a squiggle into a price chart: without a level to read the shape
         * against, a polyline says only that something moved. It stops at the
         * plot's edges rather than the widget's, so it does not run under the
         * two value labels — a dashed rule through a price is the same defect as
         * a polyline through one. */
        int ref = ui_chart_y(s->c[s->n - 1], win, h);
        for (int x = 0; x + CH_DASH <= w; x += CH_DASH + CH_DASH_GAP)
            bar_abs(L, ox + x, oy + ref, ox + x + CH_DASH - 1, oy + ref, false);
    }

    switch (s->kind) {
    case CHART_CANDLE: draw_candles(L, s, win, ox, oy, w, h, m); break;
    case CHART_BAR:    draw_bars(L, s, win, ox, oy, w, h, m);    break;
    default:           draw_line(L, s, win, ox, oy, w, h, m);    break;
    }
}

static void chart_free_cb(lv_event_t *e)
{
    lv_free(state_of(lv_event_get_target_obj(e)));
}

lv_obj_t *ui_chart_create(lv_obj_t *par, int x, int y, int w, int h)
{
    lv_obj_t *o = ui_pane(par, x, y, w, h);
    chart_t  *s = lv_malloc_zeroed(sizeof(chart_t));

    /* The box is remembered rather than read back with lv_obj_get_width() when
     * it is needed: a size set on an object is not in that object's coordinates
     * until the next layout pass, and a page that builds its charts and fills
     * them in the same call would otherwise place every value label against a
     * box of zero. The draw callback runs after layout and does use the real
     * coordinates, which is why it is not given these. */
    if (s) { s->bw = w; s->bh = h; }

    lv_obj_set_user_data(o, s);
    lv_obj_add_event_cb(o, chart_draw_cb, LV_EVENT_DRAW_MAIN, NULL);
    lv_obj_add_event_cb(o, chart_free_cb, LV_EVENT_DELETE, NULL);
    return o;
}

void ui_chart_resize(lv_obj_t *chart, int w, int h)
{
    chart_t *s = state_of(chart);
    if (!s) return;

    s->bw = w;
    s->bh = h;
    lv_obj_set_size(chart, w, h);
}

/* The two value labels. They are children of the chart, so LVGL draws them
 * after DRAW_MAIN and they land on top of the polyline they annotate — which is
 * exactly why they are painted opaque: a stroke running through the middle of a
 * figure is unreadable, and white behind the box is cheaper than routing the
 * line around it. They exist only for a labelled line chart; a sparkline never
 * builds them at all, which is eight objects the quotation table does not carry
 * eight times over. */
static lv_obj_t *value_label(lv_obj_t *chart, lv_obj_t *lab, int lw,
                             lv_text_align_t align, const char *txt)
{
    if (!lab) {
        /* ui_lab_w, not ui_lab: the fixed height is what turns a figure wider
         * than its slot into an ellipsis instead of a second line drawn across
         * the chart. */
        lab = ui_lab_w(chart, 0, 0, lw, UI_F_LABEL, align, txt);
        ui_lab_opaque(lab);
    } else {
        ui_set(lab, txt);
        /* The box is sized to THIS figure, so it is re-set on every update —
         * a series that closed at 9.99 and reopens at 12,345.67 needs the wider
         * box, and one that goes the other way must give the dashes back. */
        lv_obj_set_width(lab, lw);
    }
    ui_show(lab, true);
    return lab;
}

/* The label's box, sized to the figure it holds rather than to the widest one
 * a price can be.
 *
 * The box matters because it is painted OPAQUE — white behind the figure, so
 * the polyline does not run through the middle of it — which means every pixel
 * of slack in the box is a pixel of the reference dashes erased for nothing. At
 * the fixed 88 the last label ate forty pixels of the dashed level to its left
 * and the rule arrived at its own number with a gap in front of it, unattached
 * to the figure it belongs to. Two pixels of air, and no more. */
static int val_w(const char *txt, int cap)
{
    lv_point_t sz;
    lv_text_get_size(&sz, txt, UI_F_LABEL, 0, 0, LV_COORD_MAX,
                     LV_TEXT_FLAG_NONE);

    int w = (int)sz.x + 2;
    if (w > cap) w = cap;
    return w;
}

/* Beside its own value, and inside the box whatever that value did. */
static void place_label(lv_obj_t *lab, int x, int y, int h)
{
    int lh = lv_font_get_line_height(UI_F_LABEL);
    int top = y - lh / 2;
    if (top < 0)      top = 0;
    if (top > h - lh) top = h - lh;
    lv_obj_set_pos(lab, x, top);
}

/* Label the first and last values, or take the labels away.
 *
 * A LINE and a BAR chart both get them; a candle does not, because its extremes
 * are already drawn as its wicks and its close sits on the reference line, so a
 * figure at each end would be the third way of saying the same thing.
 *
 * The bar chart was excluded and should not have been. Six black bars with no
 * figure anywhere near them is a shape rather than a reading: it says the last
 * quarter was the biggest and nothing whatever about how big, which on a page
 * whose whole argument is a company's accounts is the one thing a reader came
 * for. The price chart beside it prints 978.40 and 1,631.47 and works; the
 * difference between the two was entirely this line. */
static void label_ends(lv_obj_t *chart, chart_t *s, ui_chart_win_t win,
                       int w, int h)
{
    /* Half the box each at most, with eight pixels between them, so the two can
     * never meet in the middle however flat the series is. */
    int cap = (w - 8) / 2;
    if (cap > CH_VAL_W) cap = CH_VAL_W;

    bool wanted = (s->kind == CHART_LINE || s->kind == CHART_BAR)
                  && !s->spark && s->n > 0
                  && cap >= CH_VAL_MIN_W
                  && h >= lv_font_get_line_height(UI_F_LABEL);
    if (!wanted) {
        ui_show(s->first, false);
        ui_show(s->last, false);
        s->pad_l = s->pad_r = 0;
        return;
    }

    char txt[24];
    fmt_cents(txt, sizeof txt, s->c[0]);
    const int fw = val_w(txt, cap);
    s->first = value_label(chart, s->first, fw, LV_TEXT_ALIGN_LEFT, txt);

    char txt2[24];
    fmt_cents(txt2, sizeof txt2, s->c[s->n - 1]);
    const int lw = val_w(txt2, cap);
    s->last = value_label(chart, s->last, lw, LV_TEXT_ALIGN_RIGHT, txt2);

    /* THE INSET IS PUBLISHED BEFORE THE LABELS ARE PLACED, because both they and
     * the series are positioned against it. Each label reserves its own measured
     * width plus a gap, so the two ends of the plot are as wide as the figures
     * that sit there and not a pixel wider — a fixed reserve would cost the
     * shorter figure's end sixty pixels of chart for nothing. */
    s->pad_l = (int16_t)(fw + CH_LAB_GAP);
    s->pad_r = (int16_t)(lw + CH_LAB_GAP);

    /* And they are hung against the PLOT, not the widget: the row a value scales
     * to is a row of the plot rect, so a label centred on the widget's mapping
     * would point a few pixels off its own datum — the error growing with the
     * inset, which is exactly when it is most visible. */
    int px, py, pw, ph;
    plot_rect(s, w, h, &px, &py, &pw, &ph);

    place_label(s->first, 0, py + ui_chart_y(s->c[0], win, ph), h);
    place_label(s->last, w - lw,
                py + ui_chart_y(s->c[s->n - 1], win, ph), h);
}

void ui_chart_set(lv_obj_t *chart, const news_chart_t *c)
{
    chart_t *s = state_of(chart);
    if (!s) return;

    s->spark = false;
    s->kind  = (c && c->n > 0) ? c->kind : CHART_NONE;
    s->n     = 0;

    if (s->kind != CHART_NONE) {
        s->n = c->n < NEWS_BARS_MAX ? c->n : NEWS_BARS_MAX;
        memcpy(s->o, c->o, (size_t)s->n * sizeof s->o[0]);
        memcpy(s->h, c->h, (size_t)s->n * sizeof s->h[0]);
        memcpy(s->l, c->l, (size_t)s->n * sizeof s->l[0]);
        memcpy(s->c, c->c, (size_t)s->n * sizeof s->c[0]);
    }

    label_ends(chart, s, ui_chart_window(s->c, s->c, s->n), s->bw, s->bh);
    lv_obj_invalidate(chart);
}

/* Under three samples there is no shape to draw, and what gets drawn instead is
 * worse than nothing: two points normalised to fill their own box is a straight
 * diagonal at the box's full height, stretched to whatever width the row has —
 * a 675 px rising line beside a red -0.18%, which is the picture contradicting
 * the figure ten pixels to its left. A row with no series prints no series. */
#define CH_SPARK_MIN_N  3

void ui_chart_set_spark(lv_obj_t *chart, const int16_t *v, int n)
{
    chart_t *s = state_of(chart);
    if (!s) return;

    if (n < CH_SPARK_MIN_N) n = 0;

    s->spark = true;
    s->n     = (v && n > 0) ? (n < NEWS_BARS_MAX ? n : NEWS_BARS_MAX) : 0;
    s->kind  = s->n > 0 ? CHART_LINE : CHART_NONE;

    for (int i = 0; i < s->n; i++) s->c[i] = v[i];

    label_ends(chart, s, ui_chart_window(s->c, s->c, s->n), s->bw, s->bh);
    lv_obj_invalidate(chart);
}

#endif /* UI_CHART_LVGL */
