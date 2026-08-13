/*
 * test_epd6_transpose.c — pins down the one thing in the 13.3" port that fails
 * silently.
 *
 * A wrong transpose still compiles, still boots, still spends thirty seconds
 * refreshing, and produces a panel full of confetti with nothing in the log.
 * There is no way to eyeball it and no way to test it on the device. So the
 * reference loop from esphome-bigink (seeed_epaper_spectra6.cpp:562-577 for the
 * master, :594-609 for the slave) is transcribed here, verbatim and
 * deliberately naive, and the fast blocked implementation is required to agree
 * with it byte for byte.
 *
 * The reference is the specification. If the two ever disagree, the blocked
 * version is wrong — not this file.
 */
#include <stdlib.h>
#include <string.h>

#include "epd6_transpose.h"
#include "th.h"

/* --- the reference ------------------------------------------------------- */

/* bigink's get_pixel lambda (seeed_epaper_spectra6.cpp:545-549), unchanged. */
static uint8_t ref_get_pixel(const uint8_t *fb, uint16_t x, uint16_t y)
{
    size_t byte_idx = ((size_t)y * 1600 + x) / 2;
    uint8_t b = fb[byte_idx];
    return (x & 1) ? (b & 0x0F) : ((b >> 4) & 0x0F);
}

/* bigink's transfer loop, with SPI.transfer() replaced by a store. `plane`
 * selects the master's `2 * out_byte` or the slave's `600 + 2 * out_byte`. */
static void ref_pack_plane(const uint8_t *fb, int plane, uint8_t *dst)
{
    const uint16_t OUT_ROWS  = 1600;
    const uint16_t OUT_BYTES = 300;
    const uint16_t base      = plane ? 600 : 0;

    for (uint16_t out_row = 0; out_row < OUT_ROWS; out_row++) {
        uint16_t buf_col = 1599 - out_row;

        for (uint16_t out_byte = 0; out_byte < OUT_BYTES; out_byte++) {
            uint16_t buf_row_even = base + 2 * out_byte;
            uint16_t buf_row_odd  = base + 2 * out_byte + 1;

            uint8_t pix_even = ref_get_pixel(fb, buf_col, buf_row_even);
            uint8_t pix_odd  = ref_get_pixel(fb, buf_col, buf_row_odd);

            dst[(size_t)out_row * OUT_BYTES + out_byte] =
                (uint8_t)((pix_even << 4) | pix_odd);
        }
    }
}

/* --- a framebuffer worth transposing -------------------------------------
 * xorshift32 rather than rand(): the same bytes on every platform, so a failure
 * reproduces from the seed alone. Values are masked to 0..15 because a nibble
 * is all the panel has. */
static uint32_t rnd_state = 0x1234567u;

static uint32_t rnd(void)
{
    rnd_state ^= rnd_state << 13;
    rnd_state ^= rnd_state >> 17;
    rnd_state ^= rnd_state << 5;
    return rnd_state;
}

static void fill_random(uint8_t *fb)
{
    for (size_t i = 0; i < EPD6_FB_SIZE; i++) {
        fb[i] = (uint8_t)(rnd() & 0xFF);
    }
}

/* --- the tests ------------------------------------------------------------ */

/* Every block size must give the same bytes. 1 exercises the degenerate case,
 * 7 a size that divides neither 1600 nor 300, 64 the size the driver actually
 * uses, and 1600 the whole plane in one call. */
static void check_block_sizes(const uint8_t *fb, int plane, const uint8_t *ref)
{
    static const int sizes[] = { 1, 7, 64, 1600 };

    for (size_t s = 0; s < sizeof(sizes) / sizeof(sizes[0]); s++) {
        const int bs = sizes[s];
        uint8_t *got = (uint8_t *)malloc(EPD6_PLANE_BYTES);
        if (!got) { printf("  FATAL out of memory\n"); exit(2); }
        memset(got, 0xAA, EPD6_PLANE_BYTES);      /* poison: unwritten shows up */

        for (int r0 = 0; r0 < EPD6_OUT_ROWS; r0 += bs) {
            int n = bs;
            if (r0 + n > EPD6_OUT_ROWS) {
                n = EPD6_OUT_ROWS - r0;
            }
            epd6_pack_block(fb, plane, r0, n,
                            got + (size_t)r0 * EPD6_OUT_STRIDE);
        }

        int diff = memcmp(got, ref, EPD6_PLANE_BYTES);
        g_total++;
        if (diff != 0) {
            g_fail++;
            /* Report the first divergence in panel terms, not as a byte offset
             * — "output row 812, byte 44" is something you can go and look at;
             * "offset 243644" is not. */
            size_t i = 0;
            while (i < EPD6_PLANE_BYTES && got[i] == ref[i]) i++;
            printf("  FAIL plane %d block %-4d  first diff at out_row %zu byte %zu"
                   "  (ref 0x%02X, got 0x%02X)\n",
                   plane, bs, i / EPD6_OUT_STRIDE, i % EPD6_OUT_STRIDE,
                   ref[i], got[i]);
        }
        free(got);
    }
}

/* The four corners, checked by hand rather than against the reference: if both
 * implementations shared a sign error these would still catch it. */
static void check_corners(void)
{
    uint8_t *fb = (uint8_t *)calloc(1, EPD6_FB_SIZE);
    if (!fb) { printf("  FATAL out of memory\n"); exit(2); }

    /* Four distinct codes so a swapped corner cannot masquerade as a pass. */
    epd6_fb_put(fb, 0,           0,           0x3);   /* top-left     */
    epd6_fb_put(fb, EPD6_W - 1,  0,           0x5);   /* top-right    */
    epd6_fb_put(fb, 0,           EPD6_H - 1,  0x6);   /* bottom-left  */
    epd6_fb_put(fb, EPD6_W - 1,  EPD6_H - 1,  0x2);   /* bottom-right */

    uint8_t *m = (uint8_t *)malloc(EPD6_PLANE_BYTES);
    uint8_t *s = (uint8_t *)malloc(EPD6_PLANE_BYTES);
    if (!m || !s) { printf("  FATAL out of memory\n"); exit(2); }
    epd6_pack_block(fb, EPD6_PLANE_MASTER, 0, EPD6_OUT_ROWS, m);
    epd6_pack_block(fb, EPD6_PLANE_SLAVE,  0, EPD6_OUT_ROWS, s);

    /* (0,0): column 0 -> the LAST output row (1599). Row 0 is even, so the
     * high nibble of output byte 0, on the master. */
    CHECK_INT(m[(size_t)1599 * EPD6_OUT_STRIDE + 0] >> 4, 0x3);

    /* (1599,0): column 1599 -> output row 0, same byte, still master. */
    CHECK_INT(m[(size_t)0 * EPD6_OUT_STRIDE + 0] >> 4, 0x5);

    /* (0,1199): the slave's row 599 — odd, so the LOW nibble of its last
     * output byte (299), at output row 1599. */
    CHECK_INT(s[(size_t)1599 * EPD6_OUT_STRIDE + 299] & 0x0F, 0x6);

    /* (1599,1199): same byte, output row 0. */
    CHECK_INT(s[(size_t)0 * EPD6_OUT_STRIDE + 299] & 0x0F, 0x2);

    /* Nothing else moved: exactly four non-zero nibbles across both planes. */
    int nz = 0;
    for (size_t i = 0; i < EPD6_PLANE_BYTES; i++) {
        if (m[i] >> 4)   nz++;
        if (m[i] & 0x0F) nz++;
        if (s[i] >> 4)   nz++;
        if (s[i] & 0x0F) nz++;
    }
    CHECK_INT(nz, 4);

    free(fb); free(m); free(s);
}

/* A plane boundary is the easiest thing to get wrong by one: row 599 belongs to
 * the master, row 600 to the slave, and both land in output byte 299/0. */
static void check_plane_split(void)
{
    uint8_t *fb = (uint8_t *)calloc(1, EPD6_FB_SIZE);
    if (!fb) { printf("  FATAL out of memory\n"); exit(2); }

    epd6_fb_put(fb, 800, 599, 0x3);   /* last master row  */
    epd6_fb_put(fb, 800, 600, 0x5);   /* first slave row  */

    uint8_t *m = (uint8_t *)malloc(EPD6_PLANE_BYTES);
    uint8_t *s = (uint8_t *)malloc(EPD6_PLANE_BYTES);
    if (!m || !s) { printf("  FATAL out of memory\n"); exit(2); }
    epd6_pack_block(fb, EPD6_PLANE_MASTER, 0, EPD6_OUT_ROWS, m);
    epd6_pack_block(fb, EPD6_PLANE_SLAVE,  0, EPD6_OUT_ROWS, s);

    const size_t out_row = 1599 - 800;

    /* 599 is odd -> low nibble of the master's byte 299. */
    CHECK_INT(m[out_row * EPD6_OUT_STRIDE + 299] & 0x0F, 0x3);
    /* 600 is the slave's row 0, even -> high nibble of its byte 0. */
    CHECK_INT(s[out_row * EPD6_OUT_STRIDE + 0] >> 4, 0x5);
    /* And neither leaked into the other plane. */
    CHECK_INT(s[out_row * EPD6_OUT_STRIDE + 299] & 0x0F, 0x0);
    CHECK_INT(m[out_row * EPD6_OUT_STRIDE + 0] >> 4, 0x0);

    free(fb); free(m); free(s);
}

/* get/put must round-trip every code at every parity of x. */
static void check_fb_accessors(void)
{
    uint8_t *fb = (uint8_t *)calloc(1, EPD6_FB_SIZE);
    if (!fb) { printf("  FATAL out of memory\n"); exit(2); }

    for (int code = 0; code < 16; code++) {
        epd6_fb_put(fb, 10, 5, (uint8_t)code);          /* even x */
        epd6_fb_put(fb, 11, 5, (uint8_t)(15 - code));   /* odd x, shares a byte */
        CHECK_INT(epd6_fb_get(fb, 10, 5), code);
        CHECK_INT(epd6_fb_get(fb, 11, 5), 15 - code);
    }

    /* Geometry sanity — these constants are load-bearing everywhere else. */
    CHECK_INT(EPD6_FB_SIZE, 960000);
    CHECK_INT(EPD6_PLANE_BYTES, 480000);
    CHECK_INT(EPD6_FB_STRIDE, 800);
    CHECK_INT(EPD6_OUT_STRIDE, 300);

    free(fb);
}

int main(void)
{
    uint8_t *fb = (uint8_t *)malloc(EPD6_FB_SIZE);
    if (!fb) { printf("  FATAL out of memory\n"); exit(2); }
    fill_random(fb);

    for (int plane = 0; plane <= 1; plane++) {
        uint8_t *ref = (uint8_t *)malloc(EPD6_PLANE_BYTES);
        if (!ref) { printf("  FATAL out of memory\n"); exit(2); }
        ref_pack_plane(fb, plane, ref);
        check_block_sizes(fb, plane, ref);
        free(ref);
    }

    check_corners();
    check_plane_split();
    check_fb_accessors();

    free(fb);
    TH_REPORT("epd6_transpose");
}
