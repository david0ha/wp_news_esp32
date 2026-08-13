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
 *     byte  = fb[y * 800 + x/2]
 *     pixel = (x & 1) ? (byte & 0x0F) : (byte >> 4)
 *
 * 1600 x 1200 x 4bpp = 960,000 bytes. Laid out this way because LVGL's flush
 * callback walks rows left-to-right, so drawing is a sequential write; the cost
 * is paid once per refresh in the repack below instead of on every pixel.
 *
 * THE PANEL
 * ---------
 * Two UC8179 controllers stacked VERTICALLY, each owning half the rows:
 *
 *     +-------------------------------------+
 *     |  MASTER  (CS)   buffer rows    0-599|  600 px
 *     +-------------------------------------+
 *     |  SLAVE   (CS1)  buffer rows 600-1199|  600 px
 *     +-------------------------------------+
 *                 1600 px wide
 *
 * and each expects its half TRANSPOSED — buffer columns arrive as output rows,
 * in reverse order:
 *
 *     out_row  r (0..1599)  <-  buffer column 1599 - r
 *     out_byte b (0..299)   <-  buffer rows base+2b (high nibble)
 *                                       and base+2b+1 (low nibble)
 *     base = 0 for the master, 600 for the slave
 *
 * 1600 output rows x 300 bytes = 480,000 bytes per controller. The reversal is
 * the panel's own scan direction, not a rotation we chose.
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

#define EPD6_W            1600
#define EPD6_H            1200

/* 1600 is even, so a framebuffer row is exactly 800 bytes with no padding. */
#define EPD6_FB_STRIDE    (EPD6_W / 2)                      /*    800 */
#define EPD6_FB_SIZE      ((size_t)EPD6_FB_STRIDE * EPD6_H) /* 960000 */

#define EPD6_PLANE_ROWS   (EPD6_H / 2)                      /*    600 */
#define EPD6_OUT_ROWS     EPD6_W                            /*   1600 */
#define EPD6_OUT_STRIDE   (EPD6_PLANE_ROWS / 2)             /*    300 */
#define EPD6_PLANE_BYTES  ((size_t)EPD6_OUT_ROWS * EPD6_OUT_STRIDE) /* 480000 */

enum {
    EPD6_PLANE_MASTER = 0,   /* buffer rows   0..599  */
    EPD6_PLANE_SLAVE  = 1,   /* buffer rows 600..1199 */
};

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
 * `dst` receives n_rows * EPD6_OUT_STRIDE bytes, ready to hand to the SPI DMA
 * engine as-is. Callers work in blocks so `dst` can live in internal SRAM: a
 * whole plane is 480 KB, a 64-row block is 19,200 B.
 *
 * out_row0 + n_rows must not exceed EPD6_OUT_ROWS. Any block size gives
 * identical output — the host test checks 1, 7, 64 and 1600. */
void epd6_pack_block(const uint8_t *fb, int plane, int out_row0, int n_rows,
                     uint8_t *dst);

#ifdef __cplusplus
}
#endif
