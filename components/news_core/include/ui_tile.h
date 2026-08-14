/*
 * ui_tile.h — the one-entry photo cache.
 *
 * The device never resizes, tone-maps or dithers a photograph. The server sends
 * a TILE: `w * h / 2` bytes of 4 bpp pixel data in the framebuffer's own nibble
 * order (even x in the high nibble, epd6_transpose.h), already screened by
 * tools/make_tile.py against the panel's measured inks. This holds one of them,
 * keyed on the id the payload named, so the page can ask for a picture without
 * knowing where pictures come from.
 *
 * ONE TILE, AND THE BYTE COUNT IS THE CONTRACT
 * --------------------------------------------
 * A tile whose byte count disagrees with `w * h / 2` is REJECTED and never
 * drawn (spec §8). It cannot be scaled: the bytes have already been through a
 * dither, and resampling a screened image dithers it a second time — which is
 * the confetti the palette header warns about, not a slightly soft photograph.
 * So the dimensions in the JSON and the length of the body have to agree, and
 * when they do not the page reflows without the picture. A missing tile is an
 * ordinary front-page condition — a slow wire, an id that went stale between
 * the JSON and the GET — and not an error state.
 *
 * TWO FORMS OF THE SAME PIXELS
 * ----------------------------
 * `codes` is the tile exactly as it arrived: hardware colour codes, two to a
 * byte, the layout the framebuffer itself uses, so a future path that writes
 * past LVGL straight into the framebuffer is a per-row memcpy at an even x.
 *
 * `px` is the same pixels as RGB565, one per entry, each an EXACT entry of
 * wp_palette_rgb — which is the form the LVGL renderer can blit. That is not a
 * re-quantization: the ordered dither leaves exact palette colours alone at
 * every position in its matrix, so wp_quantize565(px[i]) is codes[i] again,
 * byte for byte. The loader proves it for every ink the tile actually uses,
 * over all 64 dither positions, and refuses a tile that fails — which is also
 * how a nibble that is not one of the panel's six colours gets caught.
 *
 * Portable: no LVGL, no ESP-IDF. The bytes are the seam.
 */
#pragma once

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* news_photo_t::id's own width — the two must match, since one names the other. */
#define UI_TILE_ID_MAX 16

typedef struct {
    char id[UI_TILE_ID_MAX];
    int  w, h;
    const uint8_t  *codes;   /* w*h/2 bytes, even x in the high nibble */
    const uint16_t *px;      /* w*h entries, RGB565, exact palette colours */
} ui_tile_t;

/*
 * Tell the cache which paper it is fetching pictures for. `news_url` is the
 * snapshot's own URL; the tiles sit beside it, at `<its directory>/tiles/`
 * (spec §8). Call it once per poll from the task that owns the network: it also
 * clears the record of the tile that could not be fetched last time, so a poll
 * is what gives a missing picture its next chance rather than every repaint.
 *
 * NULL or empty leaves the cache with no base, which on the device means no
 * tile can be fetched at all, and in the simulator means the local tile
 * directory — a file that is already there being the honest stand-in for a
 * fetch that has already happened.
 */
void ui_tile_set_base(const char *news_url);

/*
 * The tile for `id` at exactly `w` x `h`, or NULL.
 *
 * A hit is a pointer comparison. A miss loads: over HTTP from the base above,
 * or out of the simulator's tile directory when there is no base. One id is
 * tried once — a failure is remembered until the next ui_tile_set_base() — so a
 * page that repaints every five minutes does not re-GET a picture that is not
 * there.
 *
 * The returned pointer stays valid until the next call that loads a different
 * tile, which on a page that draws one picture is until the picture changes.
 */
const ui_tile_t *ui_tile_get(const char *id, int w, int h);

/* Forget the resident tile and free it. */
void ui_tile_drop(void);

#ifdef __cplusplus
}
#endif
