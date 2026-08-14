/*
 * ui_tile.c — see ui_tile.h.
 *
 * Three things happen here and nothing else: a URL is derived, some bytes are
 * obtained, and those bytes are checked. The checking is the point — everything
 * in a tile arrives from the network, including the id that becomes a path and
 * the dimensions that become a length.
 */
#include "ui_tile.h"

#include "http_port.h"
#include "wp_palette.h"     /* the six inks, the dither, and EPD6_W/EPD6_H */

#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifdef ESP_PLATFORM
#include "esp_heap_caps.h"
#endif

/* --- storage --------------------------------------------------------------
 * One allocation per tile: the 4 bpp codes, then the RGB565 copy. Two buffers
 * would be two failure paths and two frees for one picture that is either
 * resident or not. */
static struct {
    ui_tile_t pub;
    uint8_t  *mem;
} s_cache;

static char s_base[192];              /* "<the snapshot's directory>/tiles/" */
static char s_missed[UI_TILE_ID_MAX]; /* the id that could not be fetched     */

/*
 * A photograph is 335 KB of RGB565 at the lead's size and the device has 8 MB
 * of PSRAM against ~300 KB of free internal RAM, so this allocation has exactly
 * one place it can live. malloc() is the fallback rather than the default so
 * that a board built without PSRAM fails at the tile rather than at boot; the
 * host has one heap and takes that path always. IDF's free() handles both.
 */
static void *tile_alloc(size_t n)
{
#ifdef ESP_PLATFORM
    void *p = heap_caps_malloc(n, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (p) return p;
#endif
    return malloc(n);
}

/* --- what an id is allowed to be ------------------------------------------
 * The id comes off the wire and becomes a path component in a URL and, in the
 * simulator, in a filename. The parser clamps its LENGTH; nothing has yet said
 * anything about its content, and "../../etc/passwd" is a perfectly good JSON
 * string. So: letters, digits, underscore and hyphen, and nothing else — no
 * dot, no slash, no percent. Every id tools/make_tile.py produces is already of
 * that shape, so this rejects nothing a real payload sends. */
static bool id_ok(const char *id)
{
    if (!id || !id[0]) return false;

    for (size_t i = 0; id[i]; i++) {
        if (i + 1 >= UI_TILE_ID_MAX) return false;
        const char c = id[i];
        const bool ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
                     || (c >= '0' && c <= '9') || c == '_' || c == '-';
        if (!ok) return false;
    }
    return true;
}

/* --- where the tiles are --------------------------------------------------
 * `<the news URL's directory>/tiles/<id>.bin` (spec §8). The directory is
 * everything up to and including the last '/', with any query or fragment cut
 * off first — and the walk back stops at the authority so that a URL with no
 * path at all ("http://host:8123") gains a slash instead of losing its host. */
static void derive_base(const char *news_url)
{
    s_base[0] = '\0';
    if (!news_url || !news_url[0]) return;

    const char *scheme = strstr(news_url, "://");
    const size_t start = scheme ? (size_t)(scheme - news_url) + 3 : 0;
    const size_t end   = strcspn(news_url, "?#");

    size_t cut = end;
    while (cut > start && news_url[cut - 1] != '/') cut--;

    if (cut <= start) {
        snprintf(s_base, sizeof s_base, "%.*s/tiles/", (int)end, news_url);
    } else {
        snprintf(s_base, sizeof s_base, "%.*stiles/", (int)cut, news_url);
    }
}

void ui_tile_set_base(const char *news_url)
{
    s_missed[0] = '\0';     /* a new poll is a new chance for a missing tile */
    derive_base(news_url);
}

/* --- getting the bytes ---------------------------------------------------- */

#ifdef UI_TILE_LOCAL_DIR
/*
 * The simulator's path, and only the simulator's: it renders the built-in demo
 * snapshot, which names a photograph that no server is going to be asked for.
 * A file that is already on the disk is the honest stand-in for a fetch that
 * has already happened — it exercises the same validation, the same expansion
 * and the same blit, and it keeps the demo page self-contained.
 *
 * Exactly `want` bytes and not one more. A short file is a truncated tile and a
 * long one is a tile for a different slot; both are the byte-count contract
 * failing, and both are refused rather than drawn.
 */
static bool load_file(const char *id, uint8_t *dst, size_t want)
{
    char path[320];
    if (snprintf(path, sizeof path, "%s/%s.bin", UI_TILE_LOCAL_DIR, id)
        >= (int)sizeof path) {
        return false;
    }

    FILE *f = fopen(path, "rb");
    if (!f) return false;

    const size_t got = fread(dst, 1, want, f);
    const bool   ok  = (got == want) && (fgetc(f) == EOF);
    fclose(f);
    return ok;
}
#endif

/*
 * The device's path, over the same seam the snapshot itself comes through —
 * http_get_bin() rather than http_get() because a tile is pixel data and 0x00
 * is two black pixels, so the body contains NUL bytes by construction and a
 * NUL-terminated string would stop at the first pair of them.
 */
static bool load_http(const char *id, uint8_t *dst, size_t want)
{
    if (!s_base[0]) return false;

    char url[320];
    if (snprintf(url, sizeof url, "%s%s.bin", s_base, id) >= (int)sizeof url) {
        return false;
    }

    int    status = 0;
    size_t len    = 0;
    void  *body   = http_get_bin(url, &len, &status);
    if (!body) return false;

    const bool ok = status >= 200 && status < 300 && len == want;
    if (ok) memcpy(dst, body, want);
    free(body);
    return ok;
}

/* --- the six inks, as LVGL wants them ------------------------------------- */

/*
 * Build the 16-entry code -> RGB565 table this tile needs, and prove the round
 * trip while doing it.
 *
 * The proof is the whole reason a photograph can go through the LVGL renderer
 * at all. LVGL draws RGB565 and the flush callback quantizes what it drew, so a
 * tile that arrives as ink codes has to leave as ink codes or it has been
 * dithered twice. It does not: every entry of wp_palette_rgb has all three
 * channels at a rail, the ordered dither's offset is applied equally to all
 * three, and a colour at the rails can only move inward — so the nearest match
 * cannot change. That is an argument; this is a check of it, run over all 64
 * positions of the Bayer matrix for every ink the tile actually contains.
 *
 * It also catches the other thing that would be silent: a nibble that is not
 * one of the panel's six colours. wp_index_of() rejects it here, before it can
 * reach a framebuffer that has no such ink to print it with.
 */
static bool palette565(uint16_t out[16], const uint8_t *codes, size_t bytes)
{
    bool used[16] = { false };

    for (size_t i = 0; i < bytes; i++) {
        used[codes[i] >> 4]  = true;
        used[codes[i] & 0x0F] = true;
    }

    for (int c = 0; c < 16; c++) {
        out[c] = 0;
        if (!used[c]) continue;

        const int idx = wp_index_of((uint8_t)c);
        if (idx < 0) return false;

        const uint8_t *rgb = wp_palette_rgb[idx];
        out[c] = (uint16_t)(((rgb[0] >> 3) << 11)
                          | ((rgb[1] >> 2) <<  5)
                          |  (rgb[2] >> 3));

        for (int y = 0; y < 8; y++) {
            for (int x = 0; x < 8; x++) {
                if (wp_quantize565(out[c], x, y) != (uint8_t)c) return false;
            }
        }
    }
    return true;
}

/* --- the cache ------------------------------------------------------------ */

void ui_tile_drop(void)
{
    free(s_cache.mem);
    memset(&s_cache, 0, sizeof s_cache);
}

const ui_tile_t *ui_tile_get(const char *id, int w, int h)
{
    /* An odd width cannot be packed two pixels to a byte, and a tile larger
     * than the sheet is a payload describing a different panel. */
    if (!id_ok(id) || w <= 0 || h <= 0 || (w & 1)
        || w > EPD6_W || h > EPD6_H) {
        return NULL;
    }

    if (s_cache.mem && s_cache.pub.w == w && s_cache.pub.h == h
        && strcmp(s_cache.pub.id, id) == 0) {
        return &s_cache.pub;
    }
    if (strcmp(s_missed, id) == 0) return NULL;

#ifdef UI_TILE_LOCAL_DIR
    /* The simulator has no NVS to read a news URL out of; when it was given one
     * it is in the environment, exactly where main_sim.c reads the snapshot's
     * own URL from. Without one there is no server to ask and the local
     * directory is the source. */
    if (!s_base[0]) derive_base(getenv("NEWS_URL"));
#endif

    /* The new tile is loaded and checked before the old one is let go. Nothing
     * that goes wrong below — no heap, no server, a length that disagrees —
     * should cost the page a picture it already had and could still draw. */
    const size_t codes_n = (size_t)w * (size_t)h / 2;
    const size_t px_off  = (codes_n + 3u) & ~(size_t)3u;   /* uint16_t alignment */
    const size_t px_n    = (size_t)w * (size_t)h;

    uint8_t *mem = tile_alloc(px_off + px_n * sizeof(uint16_t));
    if (!mem) {
        /* Not remembered as a miss: this tile is fine and the heap is not, and
         * the next repaint may well have the room. */
        return NULL;
    }

    uint16_t *px = (uint16_t *)(void *)(mem + px_off);
    uint16_t  pal[16];

    bool ok = s_base[0] ? load_http(id, mem, codes_n) : false;
#ifdef UI_TILE_LOCAL_DIR
    if (!s_base[0]) ok = load_file(id, mem, codes_n);
#endif
    if (ok) ok = palette565(pal, mem, codes_n);

    if (!ok) {
        free(mem);
        snprintf(s_missed, sizeof s_missed, "%s", id);
        return NULL;
    }

    for (size_t i = 0; i < codes_n; i++) {
        px[2 * i]     = pal[mem[i] >> 4];
        px[2 * i + 1] = pal[mem[i] & 0x0F];
    }

    ui_tile_drop();
    s_cache.mem       = mem;
    s_cache.pub.w     = w;
    s_cache.pub.h     = h;
    s_cache.pub.codes = mem;
    s_cache.pub.px    = px;
    snprintf(s_cache.pub.id, sizeof s_cache.pub.id, "%s", id);
    return &s_cache.pub;
}
