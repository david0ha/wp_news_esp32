/*
 * ui_chart.h — the price charts, and the integer arithmetic that decides where
 * their ink lands.
 *
 * Three shapes and a sparkline, all of them black on paper: a polyline for a
 * level over time, candles for a session's open/high/low/close, bars for a
 * quantity, and the same polyline again at 150 x 16 with its axis, its labels
 * and its reference line taken away. Colour never enters here — a candle's
 * direction is carried by whether its body is filled, which is the Japanese
 * convention and which at 150 dpi reads far better than red against green, two
 * inks this panel muddies into a pair of similar browns.
 *
 * ## The scaling is separated out because it is the part that can be wrong
 *
 * A chart is a coordinate transform with a drawing attached. The transform is
 * where every real bug lives — a flat series dividing by zero, a range of
 * billions overflowing a multiply, a decimation scheme that quietly drops the
 * most recent bar — and none of that is visible in a screenshot until somebody
 * reads a wrong number off the glass. So the six functions below own every
 * decision about WHERE ink goes, they are pure, and test_chart_scale.c holds
 * them to it; ui_chart.c's drawing half is then a transcription with no
 * arithmetic left in it worth arguing about.
 *
 * Everything is integer, in int64 where a product can exceed a cent count, for
 * the reason the graph layout had no libm: sin() agrees between x86 and Xtensa
 * only to within an ulp, which is enough to move a node one pixel and fail a
 * screenshot test for a reason that has nothing to do with the picture. Prices
 * arrive as int32_t cents and leave as int16_t rows, and no step between the
 * two holds a float.
 *
 * ## Why this header probes for LVGL
 *
 * The host test builds ui_chart.c on its own, with news_core/include, cJSON and
 * port_bsp on the path and nothing else — linking LVGL into a scaling test
 * would mean carrying an lv_conf.h for it and building a display driver to
 * assert on a division. So the pure half compiles without LVGL and the widget
 * half is guarded. The probe is __has_include rather than a -D from the build
 * files because a second consumer — another host test, a fuzzer over the wire
 * format — then gets the pure half for free, with no matching edit in a
 * CMakeLists that does not know it exists.
 */
#pragma once

#include <stdint.h>

#include "news_model.h"

#if defined(__has_include)
#  if __has_include("lvgl.h")
#    define UI_CHART_LVGL 1
#  endif
#endif
#ifndef UI_CHART_LVGL
#  define UI_CHART_LVGL 0
#endif

#if UI_CHART_LVGL
#include "lvgl.h"
#endif

#ifdef __cplusplus
extern "C" {
#endif

/* --- the scale ------------------------------------------------------------ */

/* The value window a chart is drawn in: the data's own extremes widened by a
 * headroom margin on both ends. int64_t rather than int32_t because the margin
 * on a series that spans the whole of int32_t does not itself fit in one, and a
 * window that silently wrapped would put the top of the chart below its bottom.
 *
 * Always hi > lo, including for an empty series and for a series whose values
 * are all identical — a window with no height has no defined mapping, and every
 * caller would otherwise need the same guard. */
typedef struct { int64_t lo, hi; } ui_chart_win_t;

/* One sixteenth of the data's range is left as paper above the highest value
 * and the same below the lowest, so the extremes never sit on the box edge
 * where they read as clipped rather than as extreme. Symmetric on purpose: an
 * asymmetric margin tilts a flat series off the centre line and looks like a
 * trend that is not there. */
#define UI_CHART_HEADROOM   16

/* The window over one or two parallel series of `n` values.
 *
 * Two arrays rather than one because a candle's four series share a single
 * window — scaling the closes against their own range and the wicks against
 * theirs would draw bodies that float off their own shadows — so the caller
 * passes l[] and h[], and a line or a bar chart passes c[] twice. Both arrays
 * are scanned for both extremes: the wire is free to send a high below its low,
 * and a window derived from that must still come out the right way up.
 *
 * Either pointer may be NULL, and n <= 0 is not an error; both yield the unit
 * window, which draws nothing but divides by nothing either. */
ui_chart_win_t ui_chart_window(const int32_t *lo, const int32_t *hi, int n);

/* The row a value falls on inside a box `h` px tall: 0 is the top row and
 * h - 1 the bottom, so the arithmetic runs the same way as the panel's y axis
 * and no caller flips it twice. A value outside the window clamps to the
 * nearest edge rather than escaping the box — which is also how a bar chart
 * gets its baseline, by asking for the row of zero and letting the clamp put it
 * at the foot of a window that is entirely above it. h <= 1 gives row 0, the
 * only row such a box has. */
int ui_chart_y(int32_t v, ui_chart_win_t w, int h);

/* The same for a whole series, writing exactly n rows. NULL or n <= 0 writes
 * nothing at all rather than clearing the buffer: the caller owns that
 * decision, and a chart that failed to scale should keep the last frame's rows
 * rather than collapse them onto the top edge. */
void ui_chart_scale(const int32_t *v, int n, ui_chart_win_t w, int h,
                    int16_t *y_out);

/* The column of the i-th of n samples across a box `w` px wide. The first
 * sample sits on the left edge and the last on the right edge exactly, by test
 * rather than by rounding luck — a polyline that stops three pixels short of
 * its box reads as missing data. A single sample is centred. */
int ui_chart_x(int i, int n, int w);

/* How many columns a series of n samples is drawn in: n, until there are more
 * samples than pixels, and then w. Zero when there is nothing to draw, which is
 * the one test a caller needs before iterating. */
int ui_chart_cols(int n, int w);

/* Which sample the i-th of m drawn columns takes its value from, when m < n has
 * forced a decimation.
 *
 * Evenly spaced with both ends pinned: i = 0 is always sample 0 and i = m - 1
 * is always sample n - 1. The last bar is the current price and dropping it to
 * a rounding rule would make the chart disagree with the figure printed beside
 * it — which is the one error on a price chart nobody forgives. Picking rather
 * than aggregating is deliberate: an aggregate needs four different reductions
 * for an OHLC bucket, and with a month of bars at forty-eight and no chart
 * narrower than 150 px, the decimation is a correctness guarantee that never
 * actually runs. */
int ui_chart_pick(int i, int m, int n);

/* --- the widget ----------------------------------------------------------- */
#if UI_CHART_LVGL

/* An empty box that draws itself. Charts are immediate-mode in a DRAW_MAIN
 * handler rather than built from widgets — forty-eight candles is a hundred and
 * fifty objects rebuilt on every poll, and LVGL's own chart widget brings a
 * theme, a grid and antialiased series that this panel's dither turns into
 * dotted lines. The two value labels ARE widgets, because text needs a font.
 *
 * The box is transparent: the page is white paper and a chart that painted its
 * own background would be the one tinted panel on the sheet. */
lv_obj_t *ui_chart_create(lv_obj_t *par, int x, int y, int w, int h);

/* Fill a chart from a story's series. The chart keeps its own copy, so the
 * caller's snapshot may go out of scope; NULL, CHART_NONE or an empty series
 * all mean "draw nothing", which is what a story without a chart looks like and
 * is not an error state. */
void ui_chart_set(lv_obj_t *chart, const news_chart_t *c);

/* Fill a chart from a quote's sparkline — the same polyline with its baseline,
 * its labels and its reference line suppressed, because at 16 px tall there is
 * no room for any of them and the shape is the whole message. Values are the
 * model's normalised 0..1000, not cents; nothing here reads their units. */
void ui_chart_set_spark(lv_obj_t *chart, const int16_t *v, int n);

#endif /* UI_CHART_LVGL */

#ifdef __cplusplus
}
#endif
