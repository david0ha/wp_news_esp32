/*
 * epd6_transpose.c — framebuffer → controller repacking. See epd6_transpose.h
 * for the layout this implements and where it comes from.
 *
 * The obvious implementation walks the output: for each of 1600 output rows,
 * for each of 300 bytes, fetch two pixels. Both fetches sit in the same
 * framebuffer column, so consecutive reads are 800 bytes apart — a cache miss
 * every time, 960,000 times, against PSRAM.
 *
 * This one walks the *input* instead. The outer loop takes one pair of
 * framebuffer rows; the inner loop sweeps the block's columns within those two
 * rows, which is two contiguous runs of n_rows/2 bytes. Each iteration produces
 * exactly one finished output byte, so there is no read-modify-write on `dst`
 * either.
 *
 * Output is identical for any block size — that is what the host test pins
 * down, against a transcription of the reference loop.
 */
#include "epd6_transpose.h"

void epd6_pack_block(const uint8_t *fb, int plane, int out_row0, int n_rows,
                     uint8_t *dst)
{
    if (n_rows <= 0) {
        return;
    }

    const int base = (plane == EPD6_PLANE_SLAVE) ? EPD6_PLANE_ROWS : 0;

    for (int b = 0; b < EPD6_OUT_STRIDE; b++) {
        /* The two framebuffer rows that share this output byte: the even one
         * lands in the high nibble, the odd one in the low nibble. */
        const uint8_t *row_hi = fb + (size_t)(base + 2 * b)     * EPD6_FB_STRIDE;
        const uint8_t *row_lo = fb + (size_t)(base + 2 * b + 1) * EPD6_FB_STRIDE;

        uint8_t *out = dst + b;

        for (int r = 0; r < n_rows; r++) {
            /* Output rows run the panel's scan direction, which is the reverse
             * of the framebuffer's columns. */
            const int x = EPD6_W - 1 - (out_row0 + r);

            const uint8_t hb = row_hi[x >> 1];
            const uint8_t lb = row_lo[x >> 1];
            const uint8_t hi = (uint8_t)((x & 1) ? (hb & 0x0F) : (hb >> 4));
            const uint8_t lo = (uint8_t)((x & 1) ? (lb & 0x0F) : (lb >> 4));

            *out = (uint8_t)((hi << 4) | lo);
            out += EPD6_OUT_STRIDE;
        }
    }
}
