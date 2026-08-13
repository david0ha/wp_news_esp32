/*
 * wp_palette.h — the six colours, and how anything else becomes one of them.
 *
 * The panel has six inks and no greys. Everything that reaches the glass goes
 * through wp_quantize(), which is deliberately the ONLY place that decision is
 * made: the firmware's flush callback, the desktop simulator and the Python
 * image converter all agree because they all end up here (the converter carries
 * a transcription, pinned by a golden-vector test).
 *
 * TWO PALETTES, ON PURPOSE
 * ------------------------
 * `wp_palette_rgb` is what the UI draws with and what the quantizer matches
 * against: saturated primaries, chosen so RGB888 -> RGB565 -> RGB888 is the
 * identity. That matters because LVGL renders in RGB565 — a palette colour that
 * did not survive the round trip would arrive at the quantizer slightly off and
 * dither against itself, fringing every black rule with white speckle.
 *
 * `wp_palette_ink` is roughly what Spectra 6 actually looks like: a warm
 * off-white, a soft brick red, a muddy green. It is used ONLY when the
 * simulator writes a preview image, so the screenshots resemble the panel
 * instead of a cartoon. Never quantize against it.
 *
 * DITHERING
 * ---------
 * Ordered (Bayer 8x8), not Floyd-Steinberg. Three reasons, in order of weight:
 *
 *   1. It is stateless, so it survives LVGL's partial rendering. Error
 *      diffusion across a strip boundary would need the previous strip's
 *      residue, which LVGL does not hand back.
 *   2. It is deterministic, so a screenshot test can assert on pixels.
 *   3. It leaves exact palette colours exactly alone. The offset is applied
 *      equally to R, G and B, so pure black stays pure black at every position
 *      in the matrix — body text and hairlines come out crisp, and only the
 *      in-between colours (photographs, anti-aliased glyph edges) break up.
 *
 * That third property is the whole reason the fonts can be 4bpp here when the
 * 5.83" monochrome board had to use 1bpp: grey glyph edges now dither instead
 * of being thresholded away.
 */
#pragma once

#include <stdint.h>

#include "epd6_transpose.h"     /* epd6_color_t, EPD6_COLOR_COUNT */

#ifdef __cplusplus
extern "C" {
#endif

#define WP_PALETTE_N EPD6_COLOR_COUNT

/* Draw with these. 24-bit, and all six survive RGB565 unchanged. */
#define WP_RGB_BLACK   0x000000
#define WP_RGB_WHITE   0xFFFFFF
#define WP_RGB_RED     0xFF0000
#define WP_RGB_YELLOW  0xFFFF00
#define WP_RGB_BLUE    0x0000FF
#define WP_RGB_GREEN   0x00FF00

/* Index order for all three tables below. Not the wire codes — those are in
 * wp_palette_code[]. */
typedef enum {
    WP_I_BLACK = 0,
    WP_I_WHITE,
    WP_I_RED,
    WP_I_YELLOW,
    WP_I_BLUE,
    WP_I_GREEN,
} wp_palette_index_t;

extern const uint8_t wp_palette_code[WP_PALETTE_N];       /* -> epd6_color_t   */
extern const uint8_t wp_palette_rgb[WP_PALETTE_N][3];     /* match against this */
extern const uint8_t wp_palette_ink[WP_PALETTE_N][3];     /* preview only       */
extern const uint8_t wp_bayer8[8][8];                     /* 0..63              */

/* Nearest palette colour to (r,g,b), with the Bayer offset for this position
 * applied first. Returns a hardware colour code, ready for the framebuffer.
 * x and y are screen coordinates; only their low three bits matter. */
uint8_t wp_quantize(int r, int g, int b, int x, int y);

/* The same, from the RGB565 LVGL renders into. */
uint8_t wp_quantize565(uint16_t rgb565, int x, int y);

/* Undithered nearest match — for callers that have already decided a pixel is
 * flat colour, and for the tests. */
uint8_t wp_nearest(int r, int g, int b);

/* Hardware colour code -> index into the tables above, or -1 if it is not one
 * of the six. */
int wp_index_of(uint8_t code);

#ifdef __cplusplus
}
#endif
