/*
 * test_palette.c — the two properties the whole six-colour design rests on.
 *
 *   1. Exact palette colours must NOT dither. Body text is black on white; if
 *      the quantizer moved even one position of the Bayer matrix off black, the
 *      front page would come back speckled and the cause would be invisible in
 *      a 1600x1200 screenshot.
 *
 *   2. Everything between must dither evenly. A flat mid-grey has to come out
 *      half and half over a tile, or photographs bias light or dark.
 *
 * Everything else here guards an assumption those two rest on.
 */
#include <string.h>

#include "wp_palette.h"
#include "th.h"

/* --- 1. palette colours survive the dither -------------------------------- */

static void check_palette_is_fixed(void)
{
    for (int i = 0; i < WP_PALETTE_N; i++) {
        const int r = wp_palette_rgb[i][0];
        const int g = wp_palette_rgb[i][1];
        const int b = wp_palette_rgb[i][2];

        int wrong = 0;
        for (int y = 0; y < 8; y++) {
            for (int x = 0; x < 8; x++) {
                if (wp_quantize(r, g, b, x, y) != wp_palette_code[i]) {
                    wrong++;
                }
            }
        }
        g_total++;
        if (wrong) {
            g_fail++;
            printf("  FAIL palette entry %d (%3d,%3d,%3d) dithered at %d of 64 "
                   "matrix positions\n", i, r, g, b, wrong);
        }
    }

    /* Undithered too, which is the property the image converter relies on. */
    for (int i = 0; i < WP_PALETTE_N; i++) {
        CHECK_INT(wp_nearest(wp_palette_rgb[i][0], wp_palette_rgb[i][1],
                             wp_palette_rgb[i][2]),
                  wp_palette_code[i]);
    }
}

/* --- 2. mid-grey splits exactly in half ----------------------------------- */

static void check_grey_splits(void)
{
    int black = 0, white = 0, other = 0;

    for (int y = 0; y < 8; y++) {
        for (int x = 0; x < 8; x++) {
            uint8_t c = wp_quantize(128, 128, 128, x, y);
            if (c == EPD6_BLACK)      black++;
            else if (c == EPD6_WHITE) white++;
            else                      other++;
        }
    }
    CHECK_INT(black, 32);
    CHECK_INT(white, 32);
    CHECK_INT(other, 0);

    /* Monotonic either side of it: darker greys must never produce MORE white.
     * This is what stops a photograph's midtones inverting. */
    int prev_white = -1;
    for (int v = 0; v <= 255; v += 5) {
        int w = 0;
        for (int y = 0; y < 8; y++) {
            for (int x = 0; x < 8; x++) {
                if (wp_quantize(v, v, v, x, y) == EPD6_WHITE) w++;
            }
        }
        g_total++;
        if (w < prev_white) {
            g_fail++;
            printf("  FAIL grey %d gave %d white pixels, less than the %d at "
                   "grey %d — the ramp is not monotonic\n", v, w, prev_white, v - 5);
        }
        prev_white = w;
    }

    /* And the ends are unambiguous — no dither on paper or ink. */
    for (int y = 0; y < 8; y++) {
        for (int x = 0; x < 8; x++) {
            CHECK_INT(wp_quantize(0, 0, 0, x, y), EPD6_BLACK);
            CHECK_INT(wp_quantize(255, 255, 255, x, y), EPD6_WHITE);
        }
    }
}

/* --- the assumptions underneath ------------------------------------------- */

/* LVGL renders RGB565. A palette colour that did not survive the round trip
 * would arrive at the quantizer slightly off its own value and dither against
 * itself — white speckle along every black rule. */
static void check_rgb565_roundtrip(void)
{
    for (int i = 0; i < WP_PALETTE_N; i++) {
        int r = wp_palette_rgb[i][0];
        int g = wp_palette_rgb[i][1];
        int b = wp_palette_rgb[i][2];

        uint16_t c565 = (uint16_t)(((r & 0xF8) << 8) | ((g & 0xFC) << 3) | (b >> 3));

        for (int y = 0; y < 8; y++) {
            for (int x = 0; x < 8; x++) {
                CHECK_INT(wp_quantize565(c565, x, y), wp_palette_code[i]);
            }
        }
    }
}

/* A Bayer matrix that is not a permutation of 0..63 biases the whole page. */
static void check_bayer_is_a_permutation(void)
{
    int seen[64];
    memset(seen, 0, sizeof seen);

    for (int y = 0; y < 8; y++) {
        for (int x = 0; x < 8; x++) {
            int v = wp_bayer8[y][x];
            g_total++;
            if (v < 0 || v > 63) {
                g_fail++;
                printf("  FAIL bayer[%d][%d] = %d, out of 0..63\n", y, x, v);
            } else {
                seen[v]++;
            }
        }
    }
    for (int v = 0; v < 64; v++) {
        g_total++;
        if (seen[v] != 1) {
            g_fail++;
            printf("  FAIL bayer value %d appears %d times, not once\n", v, seen[v]);
        }
    }
}

/* Nothing may reach the framebuffer that the panel cannot print. 0x04 and
 * 0x07..0x0F are not colours; the quantizer must never emit one. */
static void check_only_real_inks_come_out(void)
{
    uint32_t s = 0xC0FFEEu;
    int bad = 0;

    for (int i = 0; i < 200000; i++) {
        s ^= s << 13; s ^= s >> 17; s ^= s << 5;
        int r = (int)((s >>  0) & 0xFF);
        int g = (int)((s >>  8) & 0xFF);
        int b = (int)((s >> 16) & 0xFF);
        int x = (int)((s >> 24) & 0x07);
        int y = (int)((s >> 27) & 0x07);

        if (wp_index_of(wp_quantize(r, g, b, x, y)) < 0) {
            bad++;
        }
    }
    g_total++;
    if (bad) {
        g_fail++;
        printf("  FAIL %d of 200000 random colours quantized to a code the "
               "panel cannot print\n", bad);
    }

    /* wp_index_of itself: round-trips the six, rejects everything else. */
    for (int i = 0; i < WP_PALETTE_N; i++) {
        CHECK_INT(wp_index_of(wp_palette_code[i]), i);
    }
    CHECK_INT(wp_index_of(0x04), -1);
    CHECK_INT(wp_index_of(0x0F), -1);
    CHECK_INT(wp_index_of(0x07), -1);
}

/* The two tables are indexed together everywhere; a reorder of one alone would
 * silently swap the simulator's colours against the panel's. */
static void check_tables_agree(void)
{
    CHECK_INT(wp_palette_code[WP_I_BLACK],  EPD6_BLACK);
    CHECK_INT(wp_palette_code[WP_I_WHITE],  EPD6_WHITE);
    CHECK_INT(wp_palette_code[WP_I_RED],    EPD6_RED);
    CHECK_INT(wp_palette_code[WP_I_YELLOW], EPD6_YELLOW);
    CHECK_INT(wp_palette_code[WP_I_BLUE],   EPD6_BLUE);
    CHECK_INT(wp_palette_code[WP_I_GREEN],  EPD6_GREEN);

    /*
     * The ink table is checked for the two things a preview actually needs, and
     * not for more.
     *
     * It is tempting to require each ink to quantize back to its own primary.
     * That is wrong: Spectra 6's blue and green really are dark and desaturated
     * enough to sit nearer black in plain RGB distance, and bending the values
     * to satisfy the assertion would make the preview LESS like the panel — the
     * one job the table has.
     *
     * What matters is that the six are told apart on screen, and that each is
     * recognisably its own hue.
     */
    for (int i = 0; i < WP_PALETTE_N; i++) {
        for (int j = i + 1; j < WP_PALETTE_N; j++) {
            long dr = (long)wp_palette_ink[i][0] - wp_palette_ink[j][0];
            long dg = (long)wp_palette_ink[i][1] - wp_palette_ink[j][1];
            long db = (long)wp_palette_ink[i][2] - wp_palette_ink[j][2];
            long d2 = dr * dr + dg * dg + db * db;
            g_total++;
            if (d2 < 40 * 40) {          /* ~40 units apart in RGB */
                g_fail++;
                printf("  FAIL ink %d and ink %d are only %ld apart — they will "
                       "read as the same colour in a preview\n",
                       i, j, (long)d2);
            }
        }
    }

    const uint8_t *blk = wp_palette_ink[WP_I_BLACK];
    const uint8_t *wht = wp_palette_ink[WP_I_WHITE];
    const uint8_t *red = wp_palette_ink[WP_I_RED];
    const uint8_t *yel = wp_palette_ink[WP_I_YELLOW];
    const uint8_t *blu = wp_palette_ink[WP_I_BLUE];
    const uint8_t *grn = wp_palette_ink[WP_I_GREEN];

    /* Red is reddest, green greenest, blue bluest. */
    CHECK(red[0] > red[1] && red[0] > red[2]);
    CHECK(grn[1] > grn[0] && grn[1] > grn[2]);
    CHECK(blu[2] > blu[0] && blu[2] > blu[1]);
    /* Yellow is red+green with the blue pulled down. */
    CHECK(yel[0] > yel[2] && yel[1] > yel[2]);
    /* Black is darkest and white lightest, by luminance. */
    int lum_blk = blk[0] + blk[1] + blk[2];
    int lum_wht = wht[0] + wht[1] + wht[2];
    for (int i = 0; i < WP_PALETTE_N; i++) {
        int lum = wp_palette_ink[i][0] + wp_palette_ink[i][1] + wp_palette_ink[i][2];
        CHECK(lum >= lum_blk);
        CHECK(lum <= lum_wht);
    }
}

int main(void)
{
    check_palette_is_fixed();
    check_grey_splits();
    check_rgb565_roundtrip();
    check_bayer_is_a_permutation();
    check_only_real_inks_come_out();
    check_tables_agree();
    TH_REPORT("palette");
}
