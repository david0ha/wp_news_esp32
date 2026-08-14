/*
 * test_chart_scale.c — the arithmetic behind every chart on the front page.
 *
 * A chart is a coordinate transform with a drawing attached, and the transform
 * is where the bugs are: a flat series dividing by zero, a range of billions
 * overflowing a multiply into a negative row, a decimation that quietly drops
 * the most recent bar so the picture disagrees with the figure printed beside
 * it. None of that shows up as a broken screenshot — it shows up as a plausible
 * chart of the wrong thing, which is worse, and is why the scaling is a pure
 * function and this file exists.
 *
 * Everything here is integer by construction. There is no float in ui_chart.c
 * to test for, and that is deliberate: an ulp of disagreement between x86 and
 * Xtensa moves a pixel and fails a screenshot test for a reason that has
 * nothing to do with the chart.
 */
#include "ui_chart.h"
#include "th.h"

/* --- 1. the window -------------------------------------------------------- */

static void check_window_normal(void)
{
    /* 700 cents of range, one sixteenth of it as paper at each end. */
    const int32_t c[] = { 10000, 10500, 9800, 10200 };
    ui_chart_win_t w = ui_chart_window(c, c, 4);
    CHECK_INT(w.lo, 9800 - 43);
    CHECK_INT(w.hi, 10500 + 43);

    /* A candle's four series share one window, so it is built from the lows and
     * the highs together. */
    const int32_t lo[] = { 100, 90 }, hi[] = { 120, 130 };
    ui_chart_win_t v = ui_chart_window(lo, hi, 2);
    CHECK_INT(v.lo, 90 - 2);
    CHECK_INT(v.hi, 130 + 2);

    /* The wire is free to send a high below its low. Both arrays are scanned
     * for both extremes, so the window still comes out the right way up. */
    ui_chart_win_t bad = ui_chart_window(hi, lo, 2);
    CHECK(bad.hi > bad.lo);
    CHECK_INT(bad.lo, v.lo);
    CHECK_INT(bad.hi, v.hi);
}

static void check_window_degenerate(void)
{
    /* Every value identical: the margin floor is what keeps this from being a
     * window with no height, and a flat session is an ordinary payload. */
    const int32_t flat[] = { 500, 500, 500 };
    ui_chart_win_t f = ui_chart_window(flat, flat, 3);
    CHECK_INT(f.lo, 499);
    CHECK_INT(f.hi, 501);

    const int32_t one[] = { 7 };
    ui_chart_win_t o = ui_chart_window(one, one, 1);
    CHECK_INT(o.lo, 6);
    CHECK_INT(o.hi, 8);

    /* Nothing at all still yields something to divide by. */
    ui_chart_win_t e = ui_chart_window(one, one, 0);
    CHECK(e.hi > e.lo);
    ui_chart_win_t n = ui_chart_window(NULL, NULL, 4);
    CHECK(n.hi > n.lo);

    /* One series is the same as that series twice — how a line chart asks. */
    const int32_t c[] = { 3, 9, 5 };
    ui_chart_win_t a = ui_chart_window(NULL, c, 3);
    ui_chart_win_t b = ui_chart_window(c, NULL, 3);
    ui_chart_win_t d = ui_chart_window(c, c, 3);
    CHECK_INT(a.lo, d.lo); CHECK_INT(a.hi, d.hi);
    CHECK_INT(b.lo, d.lo); CHECK_INT(b.hi, d.hi);

    /* A negative range is not a special case anywhere, and must not become one
     * by accident: 400 cents of range, 25 of margin. */
    const int32_t neg[] = { -500, -100, -300 };
    ui_chart_win_t g = ui_chart_window(neg, neg, 3);
    CHECK_INT(g.lo, -525);
    CHECK_INT(g.hi, -75);
}

static void check_window_extremes(void)
{
    /* The whole of int32_t. The range alone is 33 bits, and the margin does not
     * fit in an int32_t either — which is why the window is int64_t and why a
     * window that wrapped would put the top of the chart below its bottom. */
    const int32_t c[] = { INT32_MIN, INT32_MAX };
    ui_chart_win_t w = ui_chart_window(c, c, 2);
    CHECK(w.lo == (int64_t)INT32_MIN - 268435455);
    CHECK(w.hi == (int64_t)INT32_MAX + 268435455);
    CHECK(w.hi > w.lo);
}

/* --- 2. the mapping ------------------------------------------------------- */

static void check_y_orientation(void)
{
    const int32_t c[] = { 0, 100 };
    ui_chart_win_t w = ui_chart_window(c, c, 2);      /* -6 .. 106 */
    const int h = 100;

    /* Row 0 is the top, so a bigger value is a smaller row. */
    CHECK(ui_chart_y(100, w, h) < ui_chart_y(0, w, h));
    CHECK_INT(ui_chart_y(100, w, h), 5);
    CHECK_INT(ui_chart_y(0, w, h), 94);

    /* The headroom is symmetric: the same paper above the high as below the
     * low. An asymmetric margin tilts a flat series and reads as a trend. */
    CHECK_INT(ui_chart_y(100, w, h), (h - 1) - ui_chart_y(0, w, h));

    /* And it is real: neither extreme sits on the edge of the box. */
    CHECK(ui_chart_y(100, w, h) > 0);
    CHECK(ui_chart_y(0, w, h) < h - 1);
}

static void check_y_clamps(void)
{
    const int32_t c[] = { 0, 100 };
    ui_chart_win_t w = ui_chart_window(c, c, 2);

    /* A value off the scale lands on the edge rather than outside the box —
     * which is also how a bar chart finds its baseline, by asking for the row
     * of zero on a window that is entirely above it. */
    CHECK_INT(ui_chart_y(-100000, w, 100), 99);
    CHECK_INT(ui_chart_y(100000, w, 100), 0);

    const int32_t up[] = { 5000, 6000 };
    ui_chart_win_t uw = ui_chart_window(up, up, 2);
    CHECK_INT(ui_chart_y(0, uw, 110), 109);           /* baseline at the foot */

    const int32_t dn[] = { -6000, -5000 };
    ui_chart_win_t dw = ui_chart_window(dn, dn, 2);
    CHECK_INT(ui_chart_y(0, dw, 110), 0);             /* and at the head */
}

static void check_y_degenerate_box(void)
{
    const int32_t c[] = { 10, 20 };
    ui_chart_win_t w = ui_chart_window(c, c, 2);

    /* A box with no rows has one answer and it is not a crash. */
    CHECK_INT(ui_chart_y(15, w, 0), 0);
    CHECK_INT(ui_chart_y(15, w, 1), 0);
    CHECK_INT(ui_chart_y(15, w, -4), 0);

    /* Two rows still divides. */
    CHECK_INT(ui_chart_y(20, w, 2), 0);
    CHECK_INT(ui_chart_y(10, w, 2), 1);

    /* A window with no height cannot happen through ui_chart_window(), but a
     * caller can still build one, and the centre row is the only honest answer
     * to "where does this value sit on a scale of nothing". */
    ui_chart_win_t none = { 42, 42 };
    CHECK_INT(ui_chart_y(42, none, 101), 50);
    CHECK_INT(ui_chart_y(0, none, 101), 50);
}

static void check_y_flat_series(void)
{
    /* The case the whole margin floor exists for: no division by zero, and a
     * line down the middle of the box rather than along one of its edges. */
    const int32_t flat[] = { 500, 500, 500, 500 };
    ui_chart_win_t w = ui_chart_window(flat, flat, 4);

    CHECK_INT(ui_chart_y(500, w, 101), 50);           /* exactly centred */
    CHECK_INT(ui_chart_y(500, w, 100), 49);           /* half a row, rounded */

    int off = 0;
    for (int h = 2; h <= 300; h++) {
        if (ui_chart_y(500, w, h) != (h - 1) / 2) off++;
    }
    CHECK_INT(off, 0);
}

static void check_y_one_cent(void)
{
    /* A cent of range still has to separate into two distinct rows: this is a
     * penny stock, or an index quoted to two decimals on a quiet afternoon. */
    const int32_t c[] = { 100, 101 };
    ui_chart_win_t w = ui_chart_window(c, c, 2);
    CHECK_INT(w.lo, 99);
    CHECK_INT(w.hi, 102);

    int hi = ui_chart_y(101, w, 100), lo = ui_chart_y(100, w, 100);
    CHECK(hi < lo);
    CHECK_INT(hi, 33);
    CHECK_INT(lo, 66);
}

static void check_y_billions(void)
{
    /* The multiply is 33 bits of range against 11 of box before it is divided
     * back down. In int32 this overflows into a negative row and draws a chart
     * that looks fine and is upside down in places. */
    const int32_t c[] = { INT32_MIN, INT32_MAX };
    ui_chart_win_t w = ui_chart_window(c, c, 2);
    const int h = 100;

    int top = ui_chart_y(INT32_MAX, w, h);
    int bot = ui_chart_y(INT32_MIN, w, h);
    CHECK(top >= 0 && top < h);
    CHECK(bot >= 0 && bot < h);
    CHECK(top > 0 && bot < h - 1);                    /* the headroom survived */
    CHECK_INT(top, (h - 1) - bot);                    /* and is still symmetric */

    /* Monotone all the way across, which an overflow would break somewhere in
     * the middle rather than at the ends. */
    int prev = h;
    for (int64_t v = INT32_MIN; v < INT32_MAX - 100000000; v += 100000000) {
        int y = ui_chart_y((int32_t)v, w, h);
        CHECK(y <= prev);
        prev = y;
    }
    CHECK(ui_chart_y(0, w, h) < bot);
    CHECK(ui_chart_y(0, w, h) > top);
}

/* --- 3. the batch --------------------------------------------------------- */

static void check_scale_writes_exactly_n(void)
{
    const int32_t c[] = { 10, 40, 20, 30 };
    ui_chart_win_t w = ui_chart_window(c, c, 4);

    int16_t y[8];
    for (int i = 0; i < 8; i++) y[i] = -7;

    ui_chart_scale(c, 4, w, 120, y);
    for (int i = 0; i < 4; i++) CHECK_INT(y[i], ui_chart_y(c[i], w, 120));
    for (int i = 4; i < 8; i++) CHECK_INT(y[i], -7);   /* nothing past n */

    /* Nothing to scale writes nothing: the caller keeps the last frame's rows
     * rather than having them collapsed onto the top edge. */
    ui_chart_scale(c, 0, w, 120, y);
    ui_chart_scale(c, -3, w, 120, y);
    ui_chart_scale(NULL, 4, w, 120, y);
    ui_chart_scale(c, 4, w, 120, NULL);
    for (int i = 0; i < 4; i++) CHECK_INT(y[i], ui_chart_y(c[i], w, 120));
    for (int i = 4; i < 8; i++) CHECK_INT(y[i], -7);

    /* Every row of a real series is inside its box. */
    ui_chart_scale(c, 4, w, 16, y);
    for (int i = 0; i < 4; i++) CHECK(y[i] >= 0 && y[i] < 16);
}

/* --- 4. the columns ------------------------------------------------------- */

static void check_x_pins_both_ends(void)
{
    /* A polyline that stops three pixels short of its box reads as missing
     * data, so the first and last samples are on the edges by rule. */
    CHECK_INT(ui_chart_x(0, 48, 558), 0);
    CHECK_INT(ui_chart_x(47, 48, 558), 557);

    int prev = -1;
    for (int i = 0; i < 48; i++) {
        int x = ui_chart_x(i, 48, 558);
        CHECK(x >= 0 && x < 558);
        CHECK(x >= prev);
        prev = x;
    }

    CHECK_INT(ui_chart_x(1, 3, 101), 50);             /* the middle is central */
    CHECK_INT(ui_chart_x(0, 2, 100), 0);
    CHECK_INT(ui_chart_x(1, 2, 100), 99);

    /* One sample is centred, and a box with no width has one column. */
    CHECK_INT(ui_chart_x(0, 1, 151), 75);
    CHECK_INT(ui_chart_x(0, 1, 1), 0);
    CHECK_INT(ui_chart_x(0, 4, 0), 0);
    CHECK_INT(ui_chart_x(3, 4, 1), 0);
}

/* --- 5. the decimation ---------------------------------------------------- */

static void check_cols(void)
{
    CHECK_INT(ui_chart_cols(48, 558), 48);            /* a month in the lead */
    CHECK_INT(ui_chart_cols(24, 150), 24);            /* a sparkline */
    CHECK_INT(ui_chart_cols(48, 10), 10);             /* more bars than pixels */
    CHECK_INT(ui_chart_cols(0, 558), 0);
    CHECK_INT(ui_chart_cols(-2, 558), 0);
    CHECK_INT(ui_chart_cols(48, 0), 0);
    CHECK_INT(ui_chart_cols(1, 1), 1);
}

static void check_pick_keeps_the_ends(void)
{
    /* Undecimated, every column is its own sample. */
    for (int i = 0; i < 48; i++) CHECK_INT(ui_chart_pick(i, 48, 48), i);

    /* Decimated, the ends are still pinned and the order is still the order.
     * The last bar is the current price: a scheme that rounded it away would
     * draw a chart that disagrees with the figure printed beside it. Every
     * (samples, columns) pair the model can produce is walked, and one counter
     * reports them, because a hundred thousand passing assertions in the log
     * hide the one line that matters. */
    int dropped = 0, unsorted = 0, escaped = 0;
    for (int n = 2; n <= NEWS_BARS_MAX; n++) {
        for (int m = 2; m <= n; m++) {
            if (ui_chart_pick(0, m, n) != 0)         dropped++;
            if (ui_chart_pick(m - 1, m, n) != n - 1) dropped++;
            int prev = -1;
            for (int i = 0; i < m; i++) {
                int k = ui_chart_pick(i, m, n);
                if (k < 0 || k >= n) escaped++;
                if (k < prev)        unsorted++;
                prev = k;
            }
        }
    }
    CHECK_INT(dropped, 0);
    CHECK_INT(unsorted, 0);
    CHECK_INT(escaped, 0);

    /* One column shows the latest sample, never the oldest. */
    CHECK_INT(ui_chart_pick(0, 1, 48), 47);
    CHECK_INT(ui_chart_pick(0, 0, 48), 47);

    /* One sample, or none, is index zero however it is asked for. */
    CHECK_INT(ui_chart_pick(0, 1, 1), 0);
    CHECK_INT(ui_chart_pick(5, 8, 1), 0);
    CHECK_INT(ui_chart_pick(0, 4, 0), 0);
}

static void check_more_bars_than_pixels(void)
{
    /* Forty-eight daily candles in a box ten pixels wide. Every column has a
     * sample, every row is inside the box, and the last column is the last bar.
     * This never happens on the real page — it is a guarantee, not a case. */
    int32_t c[48];
    for (int i = 0; i < 48; i++) c[i] = (int32_t)(10000 + i * 37);

    const int w = 10, h = 16;
    int m = ui_chart_cols(48, w);
    CHECK_INT(m, w);

    ui_chart_win_t win = ui_chart_window(c, c, 48);
    int px = -1;
    for (int i = 0; i < m; i++) {
        int k = ui_chart_pick(i, m, 48);
        int x = ui_chart_x(i, m, w);
        int y = ui_chart_y(c[k], win, h);
        CHECK(x > px);
        CHECK(y >= 0 && y < h);
        px = x;
    }
    CHECK_INT(ui_chart_pick(m - 1, m, 48), 47);
}

int main(void)
{
    check_window_normal();
    check_window_degenerate();
    check_window_extremes();

    check_y_orientation();
    check_y_clamps();
    check_y_degenerate_box();
    check_y_flat_series();
    check_y_one_cent();
    check_y_billions();

    check_scale_writes_exactly_n();

    check_x_pins_both_ends();

    check_cols();
    check_pick_keeps_the_ends();
    check_more_bars_than_pixels();

    TH_REPORT("chart_scale");
}
