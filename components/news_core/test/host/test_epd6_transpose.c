/*
 * test_epd6_transpose.c — pins down the one thing in the 13.3" port that fails
 * silently.
 *
 * A wrong pack still compiles, still boots, still spends thirty seconds
 * refreshing, and produces a panel full of confetti with nothing in the log.
 * There is no way to eyeball it and no way to test it on the device.
 *
 * Turning the panel portrait collapsed the production pack to a memcpy, which
 * is precisely the shape of change a test written against production would wave
 * through. So there are two references here and neither of them copies anything:
 *
 *   ref_substituted()  the portrait mapping as the spec states it, one pixel at
 *                      a time: out[plane][r][b] takes px = 600*plane + 2b and
 *                      600*plane + 2b+1 out of framebuffer row r.
 *
 *   ref_legacy()       bigink's original transposing loop (seeed_epaper_
 *                      spectra6.cpp:562-577 master, :594-609 slave), verbatim,
 *                      fed the LANDSCAPE framebuffer the portrait one is defined
 *                      from — fb_L(x, y) = fb_P(px = y, py = 1599 - x).
 *
 * The second is the load-bearing one. This panel's byte order was established
 * against a landscape buffer and a transpose, and the portrait pack is that
 * same order re-derived by substitution; running the old loop over the old
 * buffer is what checks the substitution instead of trusting it. If the two
 * references disagree, the derivation in epd6_transpose.h is wrong and the page
 * reaches the glass rotated or flipped — with, again, nothing in the log.
 *
 * The references are the specification. If production disagrees with them,
 * production is wrong, not this file.
 */
#include <stdlib.h>
#include <string.h>

#include "epd6_transpose.h"
#include "th.h"

/* --- the derivation, stated in code --------------------------------------
 * Sizes are spelled out rather than taken from the header: a reference that
 * reads its geometry from the thing it is checking cannot catch a mistake in
 * that geometry, which is exactly the mistake that turning the panel makes
 * available. */

static uint8_t px_portrait(const uint8_t *fb, int px, int py)
{
    uint8_t b = fb[((size_t)py * 1200 + (size_t)px) / 2];
    return (uint8_t)((px & 1) ? (b & 0x0F) : (b >> 4));
}

static void put_portrait(uint8_t *fb, int px, int py, uint8_t code)
{
    uint8_t *p = &fb[((size_t)py * 1200 + (size_t)px) / 2];
    *p = (uint8_t)((px & 1) ? ((*p & 0xF0) | (code & 0x0F))
                            : ((*p & 0x0F) | (uint8_t)((code & 0x0F) << 4)));
}

static void ref_substituted(const uint8_t *fb, int plane, uint8_t *dst)
{
    for (int r = 0; r < 1600; r++) {
        for (int b = 0; b < 300; b++) {
            uint8_t hi = px_portrait(fb, 600 * plane + 2 * b,     r);
            uint8_t lo = px_portrait(fb, 600 * plane + 2 * b + 1, r);
            dst[(size_t)r * 300 + b] = (uint8_t)((hi << 4) | lo);
        }
    }
}

/* --- the landscape original, and the buffer it reads ---------------------- */

/* bigink's get_pixel lambda (seeed_epaper_spectra6.cpp:545-549), unchanged.
 * The 1600 here is the landscape buffer's width, which is no longer this port's
 * width — that is the whole point of keeping this loop around. */
static uint8_t ref_get_pixel(const uint8_t *fb, uint16_t x, uint16_t y)
{
    size_t byte_idx = ((size_t)y * 1600 + x) / 2;
    uint8_t b = fb[byte_idx];
    return (x & 1) ? (b & 0x0F) : ((b >> 4) & 0x0F);
}

/* bigink's transfer loop, with SPI.transfer() replaced by a store. `plane`
 * selects the master's `2 * out_byte` or the slave's `600 + 2 * out_byte`. */
static void ref_legacy(const uint8_t *fb_l, int plane, uint8_t *dst)
{
    const uint16_t OUT_ROWS  = 1600;
    const uint16_t OUT_BYTES = 300;
    const uint16_t base      = plane ? 600 : 0;

    for (uint16_t out_row = 0; out_row < OUT_ROWS; out_row++) {
        uint16_t buf_col = 1599 - out_row;

        for (uint16_t out_byte = 0; out_byte < OUT_BYTES; out_byte++) {
            uint16_t buf_row_even = base + 2 * out_byte;
            uint16_t buf_row_odd  = base + 2 * out_byte + 1;

            uint8_t pix_even = ref_get_pixel(fb_l, buf_col, buf_row_even);
            uint8_t pix_odd  = ref_get_pixel(fb_l, buf_col, buf_row_odd);

            dst[(size_t)out_row * OUT_BYTES + out_byte] =
                (uint8_t)((pix_even << 4) | pix_odd);
        }
    }
}

/* fb_L(x, y) = fb_P(px = y, py = 1599 - x). Both directions of that identity are
 * in the header; this is the one the old loop needs, and building the landscape
 * buffer from the portrait one is the only place the identity is applied. */
static void landscape_from_portrait(const uint8_t *fb_p, uint8_t *fb_l)
{
    for (int x = 0; x < 1600; x++) {
        for (int y = 0; y < 1200; y++) {
            uint8_t code = px_portrait(fb_p, y, 1599 - x);
            uint8_t *p = &fb_l[((size_t)y * 1600 + (size_t)x) / 2];
            *p = (uint8_t)((x & 1) ? ((*p & 0xF0) | code)
                                   : ((*p & 0x0F) | (uint8_t)(code << 4)));
        }
    }
}

/* --- a framebuffer worth packing ------------------------------------------
 * xorshift32 rather than rand(): the same bytes on every platform, so a failure
 * reproduces from the seed alone. Every nibble is a value in 0..15 because a
 * nibble is all the panel has. */
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

/* Report a plane mismatch in panel terms, not as a byte offset — "output row
 * 812, byte 44" is something you can go and look at; "offset 243644" is not. */
static void check_same(const char *what, int plane,
                       const uint8_t *want, const uint8_t *got)
{
    g_total++;
    if (memcmp(want, got, EPD6_PLANE_BYTES) == 0) {
        return;
    }
    g_fail++;
    size_t i = 0;
    while (i < EPD6_PLANE_BYTES && want[i] == got[i]) i++;
    printf("  FAIL %s plane %d  first diff at out_row %zu byte %zu"
           "  (want 0x%02X, got 0x%02X)\n",
           what, plane, i / EPD6_OUT_STRIDE, i % EPD6_OUT_STRIDE,
           want[i], got[i]);
}

/* Every block size must give the same bytes. 1 exercises the degenerate case,
 * 7 a size that divides neither 1600 nor 300, 64 the size the driver actually
 * uses, and 1600 the whole plane in one call. */
static void check_block_sizes(const uint8_t *fb, int plane, const uint8_t *ref)
{
    static const int sizes[] = { 1, 7, 64, 1600 };
    char label[32];

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

        snprintf(label, sizeof label, "pack in %d-row blocks:", bs);
        check_same(label, plane, ref, got);
        free(got);
    }
}

/* The four corners, worked out by hand rather than taken from either reference:
 * if the derivation and its transcription shared a sign error, these are what
 * would still catch it. */
static void check_corners(void)
{
    uint8_t *fb = (uint8_t *)calloc(1, EPD6_FB_SIZE);
    if (!fb) { printf("  FATAL out of memory\n"); exit(2); }

    /* Four distinct codes so a swapped corner cannot masquerade as a pass. */
    put_portrait(fb, 0,    0,    0x3);   /* top-left     */
    put_portrait(fb, 1199, 0,    0x5);   /* top-right    */
    put_portrait(fb, 0,    1599, 0x6);   /* bottom-left  */
    put_portrait(fb, 1199, 1599, 0x2);   /* bottom-right */

    uint8_t *m = (uint8_t *)malloc(EPD6_PLANE_BYTES);
    uint8_t *s = (uint8_t *)malloc(EPD6_PLANE_BYTES);
    if (!m || !s) { printf("  FATAL out of memory\n"); exit(2); }
    epd6_pack_block(fb, EPD6_PLANE_MASTER, 0, EPD6_OUT_ROWS, m);
    epd6_pack_block(fb, EPD6_PLANE_SLAVE,  0, EPD6_OUT_ROWS, s);

    /* px 0 is the master's, even, so 2b = 0 -> the high nibble of byte 0.
     * py is the output row directly, no reversal: row 0 for the top corners,
     * 1599 for the bottom ones. */
    CHECK_INT(m[(size_t)0    * EPD6_OUT_STRIDE + 0] >> 4, 0x3);
    CHECK_INT(m[(size_t)1599 * EPD6_OUT_STRIDE + 0] >> 4, 0x6);

    /* px 1199 is the slave's 599th column — odd, so 2b + 1 = 599 puts it in the
     * LOW nibble of byte 299, the last of the row. */
    CHECK_INT(s[(size_t)0    * EPD6_OUT_STRIDE + 299] & 0x0F, 0x5);
    CHECK_INT(s[(size_t)1599 * EPD6_OUT_STRIDE + 299] & 0x0F, 0x2);

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

/* A plane boundary is the easiest thing to get wrong by one: column 599 belongs
 * to the master, column 600 to the slave, and both land in output byte 299/0 of
 * the same output row. */
static void check_plane_split(void)
{
    uint8_t *fb = (uint8_t *)calloc(1, EPD6_FB_SIZE);
    if (!fb) { printf("  FATAL out of memory\n"); exit(2); }

    put_portrait(fb, 599, 800, 0x3);   /* last master column  */
    put_portrait(fb, 600, 800, 0x5);   /* first slave column  */

    uint8_t *m = (uint8_t *)malloc(EPD6_PLANE_BYTES);
    uint8_t *s = (uint8_t *)malloc(EPD6_PLANE_BYTES);
    if (!m || !s) { printf("  FATAL out of memory\n"); exit(2); }
    epd6_pack_block(fb, EPD6_PLANE_MASTER, 0, EPD6_OUT_ROWS, m);
    epd6_pack_block(fb, EPD6_PLANE_SLAVE,  0, EPD6_OUT_ROWS, s);

    const size_t out_row = 800;

    /* 599 is odd -> low nibble of the master's byte 299. */
    CHECK_INT(m[out_row * EPD6_OUT_STRIDE + 299] & 0x0F, 0x3);
    /* 600 is the slave's column 0, even -> high nibble of its byte 0. */
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

    /* The header's accessors and this file's must agree about the format, or
     * every mapping check above is asserting something else. */
    epd6_fb_put(fb, 1198, 1599, 0x7);
    epd6_fb_put(fb, 1199, 1599, 0x9);
    CHECK_INT(px_portrait(fb, 1198, 1599), 0x7);
    CHECK_INT(px_portrait(fb, 1199, 1599), 0x9);

    /* Geometry sanity — these constants are load-bearing everywhere else, and
     * the framebuffer stays 960,000 bytes across the turn to portrait. */
    CHECK_INT(EPD6_W, 1200);
    CHECK_INT(EPD6_H, 1600);
    CHECK_INT(EPD6_FB_SIZE, 960000);
    CHECK_INT(EPD6_PLANE_BYTES, 480000);
    CHECK_INT(EPD6_FB_STRIDE, 600);
    CHECK_INT(EPD6_OUT_ROWS, 1600);
    CHECK_INT(EPD6_OUT_STRIDE, 300);

    free(fb);
}

int main(void)
{
    uint8_t *fb   = (uint8_t *)malloc(EPD6_FB_SIZE);
    uint8_t *fb_l = (uint8_t *)malloc(EPD6_FB_SIZE);
    if (!fb || !fb_l) { printf("  FATAL out of memory\n"); exit(2); }
    fill_random(fb);
    landscape_from_portrait(fb, fb_l);

    for (int plane = 0; plane <= 1; plane++) {
        uint8_t *ref    = (uint8_t *)malloc(EPD6_PLANE_BYTES);
        uint8_t *legacy = (uint8_t *)malloc(EPD6_PLANE_BYTES);
        if (!ref || !legacy) { printf("  FATAL out of memory\n"); exit(2); }

        ref_substituted(fb, plane, ref);
        ref_legacy(fb_l, plane, legacy);

        /* The substitution itself: the portrait mapping must put the same bytes
         * on the wire that the landscape transpose put there. */
        check_same("substitution vs the landscape loop:", plane, legacy, ref);

        check_block_sizes(fb, plane, ref);

        free(ref);
        free(legacy);
    }

    check_corners();
    check_plane_split();
    check_fb_accessors();

    free(fb); free(fb_l);
    TH_REPORT("epd6_transpose");
}
