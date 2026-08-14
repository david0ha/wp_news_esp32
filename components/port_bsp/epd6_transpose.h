/*
 * epd6_transpose.h — panel geometry and the framebuffer→controller repacking.
 *
 * Deliberately free of ESP-IDF: this is the one piece of the 13.3" port that
 * cannot be checked by looking at it, and it compiles on the host so a test can
 * prove it byte-for-byte against a reference. Nothing here touches hardware.
 *
 * THE FRAMEBUFFER
 * ---------------
 * Linear, row-major, 4 bits per pixel, two pixels per byte, even x in the high
 * nibble:
 *
 *     byte  = fb[y * 600 + x/2]
 *     pixel = (x & 1) ? (byte & 0x0F) : (byte >> 4)
 *
 * 1200 x 1600 x 4bpp = 960,000 bytes. PORTRAIT — the panel's own orientation,
 * and the front page's. An earlier revision presented the panel as landscape
 * 1600 x 1200 and rotated during the pack; the newspaper layout wants portrait,
 * so the rotation is gone rather than inverted.
 *
 * THE PANEL
 * ---------
 * Two UC8179 controllers, each owning half the framebuffer's COLUMNS:
 *
 *     +------------------+------------------+
 *     | MASTER  (CS)     | SLAVE   (CS1)    |
 *     | x =     0..599   | x =   600..1199  |   1600 px tall
 *     +------------------+------------------+
 *                  1200 px wide
 *
 * A controller's own raster is 1200 x 800 (TRES, epd6_panel.c), so its 1200-px
 * wire row is two of those 600-px half-rows from two adjacent framebuffer rows,
 * and 800 wire rows consume all 1600. The pack below works in units of ONE
 * half-row — "output rows", 1600 of them, 300 bytes each — because that is the
 * unit the copy is contiguous in. Two output rows make a wire row; the stream
 * is the same either way, and 1600 x 300 is still 480,000 bytes per controller.
 *
 * WHY THIS IS A COPY, AND WHY THAT DOES NOT FLIP THE IMAGE
 * -------------------------------------------------------
 * The arrangement was established against a landscape framebuffer, where the
 * panel wanted each half TRANSPOSED — buffer columns arriving as output rows in
 * reverse order. That is the only form in which the reversal is visible, so the
 * move to portrait is done by substituting into it rather than by re-deriving
 * anything. Keep the working; it is the whole proof that the page on the glass
 * did not turn over, and it is what a future reader has to be able to re-check:
 *
 *   landscape:  out[plane][r][b]  =  fb_L(x = 1599 - r,  y = 600*plane + 2b)   << 4
 *                                 |  fb_L(x = 1599 - r,  y = 600*plane + 2b+1)
 *
 *   portrait:   fb_P(px, py)      := fb_L(1599 - py, px)
 *               equivalently         fb_L(x, y) = fb_P(px = y, py = 1599 - x)
 *
 *   substitute: out[plane][r][b]  =  fb_P(px = 600*plane + 2b,   py = r) << 4
 *                                 |  fb_P(px = 600*plane + 2b+1, py = r)
 *
 * and since fb_P puts even px in the high nibble of byte px/2, those two pixels
 * are the two nibbles of one byte already in the order the wire wants them:
 *
 *               out[plane][r][*]  =  memcpy(fb_P + r*600 + plane*300, 300)
 *
 * Every byte that reaches the glass is the byte that reached it before, so the
 * physical image cannot have flipped. The reversal did not go away — it was
 * absorbed into which pixel we agree to call (px, py). What is left is the
 * arrangement Seeed's own push uses, a portrait buffer split left/right with no
 * transpose at all, which is a second source arriving at the same bytes.
 *
 * Source: acegallagher/esphome-bigink — seeed_epaper_spectra6.cpp:511-616 and
 * docs/HARDWARE.md:45-77. That repository carries no LICENSE file; what is used
 * here is the hardware arrangement it documents, not its code. The register
 * tables live in epd6_panel.c and come from Seeed's own driver instead.
 */
#pragma once

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define EPD6_W            1200
#define EPD6_H            1600

/* 1200 is even, so a framebuffer row is exactly 600 bytes with no padding. */
#define EPD6_FB_STRIDE    (EPD6_W / 2)                      /*    600 */
#define EPD6_FB_SIZE      ((size_t)EPD6_FB_STRIDE * EPD6_H) /* 960000 */

#define EPD6_PLANE_COLS   (EPD6_W / 2)                      /*    600 */
#define EPD6_OUT_ROWS     EPD6_H                            /*   1600 */
#define EPD6_OUT_STRIDE   (EPD6_PLANE_COLS / 2)             /*    300 */
#define EPD6_PLANE_BYTES  ((size_t)EPD6_OUT_ROWS * EPD6_OUT_STRIDE) /* 480000 */

/* EPD6_FB_STRIDE == 2 * EPD6_OUT_STRIDE is the whole of the pack: a plane is
 * one contiguous half of every framebuffer row. The two 600s above are not the
 * same 600 — one counts bytes, the other pixels — and they coincide only
 * because this panel is 4bpp and split down the middle. */

enum {
    EPD6_PLANE_MASTER = 0,   /* framebuffer columns   0..599, the left half  */
    EPD6_PLANE_SLAVE  = 1,   /* framebuffer columns 600..1199, the right one */
};

/*
 * The six colours, as the controller wants them on the wire. They live in this
 * header rather than epd6_panel.h because they are part of the framebuffer
 * FORMAT — the quantizer, the simulator and the host tests all need them, and
 * none of those can include an ESP-IDF header.
 *
 * Do not take these from esphome-bigink's `Spectra6Color` enum or its
 * HARDWARE.md table: within that one repository the enum, the table, the
 * explanatory comment and the executing code all disagree with each other.
 * These come from Seeed's own sources instead — TFT_eSPI.h:317-323 defines the
 * palette their driver is fed,
 *
 *     TFT_BLACK 0x0F  TFT_WHITE 0x00  TFT_BLUE 0x0D
 *     TFT_YELLOW 0x0B TFT_GREEN 0x02  TFT_RED  0x06
 *
 * and T133A01_Defines.h:231-239's COLOR_GET() maps each of those to what
 * follows. (This agrees with bigink's color_to_spectra6_(), the one part of
 * that file that was right, and with its `memset(buffer, 0x11)` meaning white.)
 *
 * Getting them backwards costs nothing at build time and produces a panel in
 * photographic negative after a thirty-second refresh.
 */
typedef enum {
    EPD6_BLACK  = 0x00,
    EPD6_WHITE  = 0x01,
    EPD6_YELLOW = 0x02,
    EPD6_RED    = 0x03,
    EPD6_BLUE   = 0x05,
    EPD6_GREEN  = 0x06,
} epd6_color_t;

/* 0x04 and 0x07..0x0F are not colours this panel makes. Nothing may reach the
 * framebuffer that is not one of the six above. */
#define EPD6_COLOR_COUNT 6

/* --- framebuffer accessors ------------------------------------------------
 * `code` is a Spectra 6 hardware colour code (see epd6_color_t). Callers are
 * responsible for bounds; the panel layer clips before it gets here. */

static inline uint8_t epd6_fb_get(const uint8_t *fb, int x, int y)
{
    uint8_t b = fb[(size_t)y * EPD6_FB_STRIDE + (size_t)(x >> 1)];
    return (uint8_t)((x & 1) ? (b & 0x0F) : (b >> 4));
}

static inline void epd6_fb_put(uint8_t *fb, int x, int y, uint8_t code)
{
    uint8_t *p = &fb[(size_t)y * EPD6_FB_STRIDE + (size_t)(x >> 1)];
    *p = (uint8_t)((x & 1) ? ((*p & 0xF0) | (code & 0x0F))
                           : ((*p & 0x0F) | (uint8_t)((code & 0x0F) << 4)));
}

/* --- repacking ------------------------------------------------------------ */

/* Pack `n_rows` output rows, starting at `out_row0`, of one controller's plane.
 *
 * Output row r is this plane's half of framebuffer row r, so the body is a
 * memcpy — see the derivation above for why that is the same wire order the
 * transposing version produced.
 *
 * `dst` receives n_rows * EPD6_OUT_STRIDE bytes, ready to hand to the SPI DMA
 * engine as-is. It stays a blocked API even though the copy no longer needs to
 * be, because `dst` has to be internal DMA-capable SRAM and the framebuffer is
 * in PSRAM: a whole plane is 480 KB, a 64-row block is 19,200 B.
 *
 * out_row0 + n_rows must not exceed EPD6_OUT_ROWS. Any block size gives
 * identical output — the host test checks 1, 7, 64 and 1600. */
void epd6_pack_block(const uint8_t *fb, int plane, int out_row0, int n_rows,
                     uint8_t *dst);

#ifdef __cplusplus
}
#endif
