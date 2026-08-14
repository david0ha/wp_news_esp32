/*
 * epd6_transpose.c — framebuffer → controller repacking. See epd6_transpose.h
 * for the layout this implements, and for the substitution that collapsed it to
 * this.
 *
 * There is no transpose left. The landscape version walked the framebuffer in
 * row PAIRS rather than the obvious output-order loop, because output-order
 * reads sat 800 bytes apart and would have taken a PSRAM cache miss 960,000
 * times per refresh. Portrait makes each output row a contiguous 300-byte half
 * of one framebuffer row, which is the access pattern memcpy is already the
 * best available implementation of.
 *
 * The file keeps its name: the header it belongs to is where this port's
 * geometry is written down, and it is what the host test compiles against.
 */
#include <string.h>

#include "epd6_transpose.h"

void epd6_pack_block(const uint8_t *fb, int plane, int out_row0, int n_rows,
                     uint8_t *dst)
{
    /* Clamp rather than trust the caller. epd6_panel.c's push_plane already
     * bounds every call, so this never fires in the firmware — but the landscape
     * version failed an out-of-range block by computing a negative x and reading
     * somewhere harmless, and the collapse to memcpy turns the same mistake into
     * a straight linear overrun past the end of a 960,000-byte buffer. Two
     * comparisons against that is a trade worth making. */
    if (n_rows <= 0 || out_row0 < 0 || out_row0 >= EPD6_OUT_ROWS) {
        return;
    }
    if (out_row0 + n_rows > EPD6_OUT_ROWS) {
        n_rows = EPD6_OUT_ROWS - out_row0;
    }

    /* The slave's half starts halfway along every framebuffer row. */
    const size_t left = (plane == EPD6_PLANE_SLAVE) ? EPD6_OUT_STRIDE : 0;

    for (int r = 0; r < n_rows; r++) {
        memcpy(dst + (size_t)r * EPD6_OUT_STRIDE,
               fb + (size_t)(out_row0 + r) * EPD6_FB_STRIDE + left,
               EPD6_OUT_STRIDE);
    }
}
