/*
 * news_model.h — everything the board knows about the front page, in one struct.
 *
 * This is the seam of the whole project. `news_t` is produced by exactly two
 * things — news_parse.c (from the JSON an agent serves) and news_mock.c (the
 * built-in demo snapshot) — and consumed by exactly two — the page layout and
 * the companion-app JSON. Nothing else reads the network payload, so a change
 * to the wire format lands in one file.
 *
 * Every array is fixed-size and every count is clamped by the producer. The
 * struct is therefore 19,780 bytes — measured, not estimated — copyable, and
 * safe to snapshot under a mutex and hand to the UI task without any ownership
 * question. That is deliberate: on a device where one task owns the panel and
 * another owns the network, a plain copyable value is worth more than the bytes
 * it wastes. It is far too big for a task stack, though — 19.8 KB against
 * NewsTask's 16 KB and UiTask's 8 KB — so both producers work off statics or
 * write the caller's storage directly, and neither ever puts a whole snapshot
 * on a frame. That is a hard constraint rather than a preference: an automatic
 * news_t overflows either stack before it is even filled in.
 *
 * Money is int32_t cents and a percentage change is int32_t basis points
 * (chg_bp = pct * 100). Nothing in the model, the parser or the UI ever holds a
 * float: the chart scaling has to agree bit for bit between x86 and Xtensa or a
 * screenshot test fails for a reason that has nothing to do with the chart.
 *
 * Portable: no LVGL, no ESP-IDF. The host tests build this directly.
 */
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* --- capacities -----------------------------------------------------------
 * These are display capacities, not protocol limits: the front page has one
 * lead, three secondary slots and a watchlist of two blocks of eight. The
 * parser drops the overflow rather than failing, so a payload with forty
 * stories still prints a front page. */
#define NEWS_STORIES_MAX     6      /* 1 lead + 3 secondary + 2 spare        */
#define NEWS_TICKERS_MAX    16      /* two blocks of eight in band 7         */
#define NEWS_INDEX_MAX       5      /* the ribbon's five cells               */
#define NEWS_BARS_MAX       48      /* a month of daily candles              */
#define NEWS_SPARK_MAX      24

#define NEWS_HEADLINE_MAX  120
#define NEWS_DECK_MAX      180
#define NEWS_BODY_MAX     1600
#define NEWS_KICKER_MAX     24
#define NEWS_BYLINE_MAX     40
#define NEWS_CAPTION_MAX   120
#define NEWS_SYMBOL_MAX      8
#define NEWS_TIME_MAX       24

/* --- pieces --------------------------------------------------------------- */

typedef enum { CHART_NONE = 0, CHART_LINE, CHART_CANDLE, CHART_BAR } chart_kind_t;

/* A series of price bars in cents. CHART_LINE reads c[] alone; the other three
 * arrays are filled anyway when the wire sent a flat list of numbers, so a
 * consumer that reaches for h[] gets a zero-height bar rather than one that
 * spans the whole scale. `kind` is CHART_NONE whenever n is 0 — the parser
 * enforces it, so "is there a chart" is one test and not two. */
typedef struct {
    chart_kind_t kind;
    char    span[8];                       /* "1D" "5D" "1M" "6M" "1Y"      */
    int     n;
    int32_t o[NEWS_BARS_MAX], h[NEWS_BARS_MAX],
            l[NEWS_BARS_MAX], c[NEWS_BARS_MAX];   /* cents; LINE uses c[]   */
} news_chart_t;

/* The device never resizes, tones or dithers a photo: the server sends a tile
 * already packed at 4 bpp in the framebuffer's nibble order, fetched as
 * w*h/2 raw bytes keyed on `id`. An id without both dimensions is therefore not
 * a photo but a malformed GET, and the parser drops the whole struct. */
typedef struct {
    char id[16];                           /* empty = no photo              */
    int  w, h;
    char caption[NEWS_CAPTION_MAX];
    char credit[32];
} news_photo_t;

/* `rank` is the server's editorial judgement and the only thing it says about
 * geometry: 0 is the lead, 1..3 the secondary row, the rest spare. The device
 * decides what fits; the server decides what matters. */
typedef struct {
    int     rank;
    char    kicker[NEWS_KICKER_MAX];
    char    headline[NEWS_HEADLINE_MAX];
    char    deck[NEWS_DECK_MAX];
    char    byline[NEWS_BYLINE_MAX];
    char    body[NEWS_BODY_MAX];
    char    symbol[NEWS_SYMBOL_MAX];
    int32_t last_c;
    int32_t chg_bp;
    news_chart_t chart;
    news_photo_t photo;
} news_story_t;

/* One line of the index ribbon or the ticker table. `spark` is already
 * normalised to 0..1000 by the producer, because normalising it here would mean
 * the device rescaling a series it cannot see the units of. */
typedef struct {
    char    symbol[NEWS_SYMBOL_MAX];
    char    name[24];
    int32_t last_c;
    int32_t chg_bp;
    int     spark_n;
    int16_t spark[NEWS_SPARK_MAX];         /* normalised 0..1000            */
} news_quote_t;

/* --- the snapshot --------------------------------------------------------- */

typedef struct {
    bool valid, demo;
    char edition[32];        /* "PERSONAL PORTFOLIO EDITION"                */
    char dateline[40];       /* "FRIDAY, AUGUST 14, 2026"                   */
    char session[48];        /* "U.S. MARKETS CLOSED — AUG 13"              */
    char as_of[24];          /* "AS OF 05:12 KST"                           */
    char generated_at[NEWS_TIME_MAX];
    news_quote_t indices[NEWS_INDEX_MAX];    int index_count;
    news_story_t stories[NEWS_STORIES_MAX];  int story_count;
    news_quote_t tickers[NEWS_TICKERS_MAX];  int ticker_count;
} news_t;

/* --- helpers (pure, shared by the UI, the API and the tests) -------------- */

/* Copy a UTF-8 string into a fixed buffer, truncating on a character boundary.
 *
 * strlcpy would happily cut a 3-byte em dash in half, and a lone continuation
 * byte does not render as "the headline was long" — it renders as a tofu box,
 * or worse, sends LVGL's decoder past the NUL. Headlines and bylines arrive
 * from a wire copy desk that emits curly quotes and en dashes as a matter of
 * course, so this is the normal case and not the exotic one. Every string that
 * enters news_t goes through here. Always NUL-terminates. Returns the number of
 * bytes written (excluding the NUL). */
size_t news_str_copy(char *dst, size_t dst_size, const char *src);

/* The same, for a field that is PROSE rather than an identifier: the ASCII
 * apostrophe between two letters becomes U+2019, which is the character a
 * headline set at 56 px needs and the one every face on the board carries.
 * Symbols, tile ids and timestamps go through news_str_copy() instead. */
size_t news_str_copy_prose(char *dst, size_t dst_size, const char *src);

/* Parse a wire chart word ("line", "candle", "bar", "none"). Case-insensitive;
 * anything unknown is CHART_NONE, because a chart drawn with the wrong geometry
 * is worse than a story that reflows without one. */
chart_kind_t news_chart_kind_from(const char *word);

/* A fingerprint of everything that is drawn. Two snapshots with the same
 * fingerprint produce the same pixels, so the caller can skip a panel refresh
 * entirely — which on this panel is twenty-five seconds of flashing rather than
 * the 5.83"'s two, and is the difference between a silent board and one that
 * repaints at nobody all day.
 *
 * Everything that reaches the glass is in here, down to the photo ids, the
 * chart span and every individual bar. A fingerprint that is too narrow does
 * not fail loudly; it shows yesterday's page forever, and nobody notices until
 * they read a stale number off it. */
uint32_t news_hash(const news_t *v);

#ifdef __cplusplus
}
#endif
