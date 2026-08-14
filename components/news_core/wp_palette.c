/*
 * wp_palette.c — six inks, and the ordered dither that gets everything else
 * there. See wp_palette.h for why the dither is ordered and why there are two
 * palettes.
 */
#include "wp_palette.h"

/* Wire codes, in table order. */
const uint8_t wp_palette_code[WP_PALETTE_N] = {
    EPD6_BLACK, EPD6_WHITE, EPD6_RED, EPD6_YELLOW, EPD6_BLUE, EPD6_GREEN,
};

/*
 * What the UI draws and what the quantizer matches against. Every channel is 0
 * or 255, which is what makes the round trip through RGB565 exact: 5-bit 31
 * expands back to 255, 6-bit 63 expands back to 255, and 0 stays 0.
 *
 * It is also what keeps exact palette colours out of the dither. Because the
 * Bayer offset is added equally to all three channels, a colour whose channels
 * are already at the rails can only move inward, and the nearest match does not
 * change. Anything strictly between the rails is what dithers.
 */
const uint8_t wp_palette_rgb[WP_PALETTE_N][3] = {
    {   0,   0,   0 },   /* black  */
    { 255, 255, 255 },   /* white  */
    { 255,   0,   0 },   /* red    */
    { 255, 255,   0 },   /* yellow */
    {   0,   0, 255 },   /* blue   */
    {   0, 255,   0 },   /* green  */
};

/*
 * Roughly what the six inks look like on the panel: the white is paper, not
 * paper-white, and the saturated colours are all pulled well in. Used only when
 * the simulator writes a preview image — a screenshot in primaries would flatter
 * the design into a decision nobody could make from the real thing.
 *
 * These are eyeballed from Spectra 6 product photography, not measured. If
 * someone colorimeters a panel, this is the table to correct; nothing else
 * depends on the values.
 *
 * KNOWN DISAGREEMENT, unresolved. tools/make_tile.py carries a second table for
 * the same six inks, transcribed from paperlesspaper/epdoptimize, which reports
 * measuring a panel:
 *
 *     black #1F2226   white #B9C7C9   red #62201E
 *     yellow #C1BB1E  blue  #233F8E   green #35563A
 *
 * It disagrees with this one most in the white — a cool grey against the warm
 * paper below — and that is exactly the direction an eyeballed table errs, since
 * product photography is lit and colour-graded to sell a panel. The two tables
 * are kept apart rather than unified because they are used for different things
 * and neither is trustworthy enough to overwrite the other: this one only tints
 * a preview, while make_tile.py's feeds the error term of a real halftone. The
 * honest fix is one colorimeter reading, after which BOTH should be replaced by
 * it and this comment deleted.
 */
const uint8_t wp_palette_ink[WP_PALETTE_N][3] = {
    {  38,  38,  40 },   /* black  — never fully black */
    { 226, 222, 211 },   /* white  — warm paper        */
    { 158,  52,  44 },   /* red    — brick             */
    { 208, 176,  58 },   /* yellow — ochre             */
    {  50,  68, 126 },   /* blue   — dull navy         */
    {  62, 110,  74 },   /* green  — olive             */
};

/*
 * Bayer 8x8, values 0..63. The classic recursive matrix; the numbers are not
 * arbitrary and should not be "tidied".
 */
const uint8_t wp_bayer8[8][8] = {
    {  0, 32,  8, 40,  2, 34, 10, 42 },
    { 48, 16, 56, 24, 50, 18, 58, 26 },
    { 12, 44,  4, 36, 14, 46,  6, 38 },
    { 60, 28, 52, 20, 62, 30, 54, 22 },
    {  3, 35, 11, 43,  1, 33,  9, 41 },
    { 51, 19, 59, 27, 49, 17, 57, 25 },
    { 15, 47,  7, 39, 13, 45,  5, 37 },
    { 63, 31, 55, 23, 61, 29, 53, 21 },
};

static inline int clamp8(int v)
{
    return v < 0 ? 0 : (v > 255 ? 255 : v);
}

uint8_t wp_nearest(int r, int g, int b)
{
    int best = 0;
    long best_d = -1;

    for (int i = 0; i < WP_PALETTE_N; i++) {
        long dr = r - wp_palette_rgb[i][0];
        long dg = g - wp_palette_rgb[i][1];
        long db = b - wp_palette_rgb[i][2];
        long d  = dr * dr + dg * dg + db * db;
        if (best_d < 0 || d < best_d) {
            best_d = d;
            best   = i;
        }
    }
    return wp_palette_code[best];
}

/*
 * The offset spans one whole quantization step, so a flat mid-grey comes out
 * exactly half black and half white over an 8x8 tile rather than biased one way.
 *
 *     offset(b) = (2b - 63) * 255 / 128,  b = 0..63   ->  -125 .. +125
 *
 * b <= 31 gives a negative offset and b >= 32 a positive one, with no zero in
 * between — which is what makes the 32:32 split exact instead of 33:31.
 */
static inline int bayer_offset(int x, int y)
{
    int b = wp_bayer8[y & 7][x & 7];
    return ((2 * b - 63) * 255) / 128;
}

uint8_t wp_quantize(int r, int g, int b, int x, int y)
{
    const int off = bayer_offset(x, y);
    return wp_nearest(clamp8(r + off), clamp8(g + off), clamp8(b + off));
}

/*
 * RGB565 -> RGB888 by bit replication, which is the expansion that makes the
 * palette's round trip exact: 5-bit 31 -> (31<<3)|(31>>2) = 255, and 0 -> 0.
 * Rounding by (v * 255 + 15) / 31 gives the same answer at the rails but costs
 * a multiply per channel per pixel, and there are 1.92 million of them.
 */
uint8_t wp_quantize565(uint16_t c, int x, int y)
{
    int r5 = (c >> 11) & 0x1F;
    int g6 = (c >>  5) & 0x3F;
    int b5 =  c        & 0x1F;

    int r = (r5 << 3) | (r5 >> 2);
    int g = (g6 << 2) | (g6 >> 4);
    int b = (b5 << 3) | (b5 >> 2);

    return wp_quantize(r, g, b, x, y);
}

int wp_index_of(uint8_t code)
{
    for (int i = 0; i < WP_PALETTE_N; i++) {
        if (wp_palette_code[i] == code) {
            return i;
        }
    }
    return -1;
}
