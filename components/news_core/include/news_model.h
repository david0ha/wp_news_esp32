/*
 * news_model.h — everything the board knows about one company, in one struct.
 *
 * This is the seam of the whole project. `news_t` is produced by exactly two
 * things — news_parse.c (from the JSON an agent serves) and news_mock.c (the
 * built-in demo snapshot) — and consumed by exactly two — the page layout and
 * the companion-app JSON. Nothing else reads the network payload, so a change
 * to the wire format lands in one file.
 *
 * ONE COMPANY A DAY
 * -----------------
 * The edition is about a single listed company. Everything on both sheets is
 * about `subject`: why the price moved, whether the whole tape moved with it,
 * what the company is worth by the usual measures, what it earned, who else
 * trades in its industry and what the street thinks it is going to do. A
 * watchlist of sixteen unrelated tickers was the previous shape and it is gone;
 * a reader who wants a table of quotes is holding the wrong object. This one
 * hangs on a wall and gets read from across a room.
 *
 * Every array is fixed-size and every count is clamped by the parser. The
 * struct is therefore copyable and safe to snapshot and hand to the UI task
 * without any ownership question. That is deliberate: on a device where one
 * task owns the panel and another owns the network, a plain copyable value is
 * worth more than the bytes it wastes. It is far too big for a task stack,
 * though — against NewsTask's 16 KB and UiTask's 8 KB — so both producers work
 * off statics or write the caller's storage directly, and neither ever puts a
 * whole snapshot on a frame. That is a hard constraint rather than a
 * preference: an automatic news_t overflows either stack before it is even
 * filled in.
 *
 * NUMBERS ARRIVE FORMATTED, OR THEY ARRIVE AS INTEGERS
 * ----------------------------------------------------
 * Two kinds of number cross this wire and they are handled differently.
 *
 * A number the DEVICE has to reason about — sort it, colour it, scale a chart
 * against it — arrives as an integer and stays one: money is int32_t cents, a
 * percentage change is int32_t basis points (chg_bp = pct * 100). Nothing in
 * the model, the parser or the UI ever holds a float, because the chart scaling
 * has to agree bit for bit between x86 and Xtensa or a screenshot test fails
 * for a reason that has nothing to do with the chart.
 *
 * A number the device only has to PRINT — a market capitalisation, a P/E
 * multiple, a line of a cash-flow statement — arrives as a preformatted string.
 * "$226.3B" is a rendering decision (how many significant figures, which suffix,
 * which currency) and the producer is the only party that knows the answer.
 * Asking a microcontroller to divide an int64 by a billion and round it to one
 * decimal place, in a house style, for twenty-eight different figures, buys
 * nothing and costs a whole class of bug. So `news_figure_t::value` is text.
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
 * These are display capacities, not protocol limits. The parser drops the
 * overflow rather than failing, so a payload carrying forty figures still
 * prints a front page.
 *
 * They are also, deliberately, more than a page can hold. The compositor
 * (ui_compose.h) decides what actually fits on the day, and it can only choose
 * from what arrived — so the producer is asked for a generous file and the
 * device does the editing. A payload sized to exactly fill one layout would
 * make the compositor pointless. */
#define NEWS_STORIES_MAX     5      /* the lead and up to four more            */
#define NEWS_FIGURES_MAX    28      /* the dossier, in groups of three to five */
#define NEWS_BRIEFS_MAX      8      /* dated one-line items                    */
#define NEWS_PEERS_MAX       6      /* the industry comparison                 */
#define NEWS_TABLES_MAX      2      /* quarterly statements, on A2             */
#define NEWS_CHARTS_MAX      2      /* one price series, one anything else     */
#define NEWS_INDEX_MAX       5      /* the ribbon, now a single line           */
#define NEWS_THUMBS_MAX      2      /* the small pictures at the foot          */

#define NEWS_BARS_MAX       48      /* a month of daily candles                */
#define NEWS_SPARK_MAX      24

#define NEWS_TABLE_COLS      6      /* eight quarters is a scroll, six is a page */
#define NEWS_TABLE_ROWS     10

#define NEWS_HEADLINE_MAX  120
#define NEWS_DECK_MAX      180

/* SIX CHARACTERS A PIXEL, AND THAT IS WHAT SIZES THIS ARRAY
 * ---------------------------------------------------------
 * A lead runs down a package that can be most of the sheet, and how much copy
 * that takes is arithmetic rather than taste. Every number below is measured —
 * `sim --measure` for the face, ui_internal.h and ui_modules.h for the grid —
 * and none of it is transcribed from a comment elsewhere, because three
 * different values for body_16 were once in circulation at once for exactly
 * that reason.
 *
 *   ui_legs_for(1140)             4 legs                (UI_LEG_MIN_W 230)
 *   leg_w_of(1140, 4)             270 px each           (UI_LEG_GUTTER 20)
 *   body_16, prose                8.02 px a character   (sim --measure)
 *     -> 270 / 8.02               33 characters a line
 *   UI_MOD_BODY_LH                22 px a line
 *     -> 4 x 33 / 22              6 characters for every pixel of depth
 *
 * The well is 1,338 px deep (UI_WELL_H). A lead's own furniture at the full
 * measure — a 320 px picture and its caption, a two-line 56 px headline, a
 * two-line deck, a byline and the rules between them — takes about 600 of it,
 * so the legs have about 740 px and want 740 x 6 = 4,440 characters to fill.
 *
 * 4,000 is that, less the tail no page ever sets: it buys 667 px of leg, which
 * is a package of about 1,267 px in a 1,338 px well. 2,400 bought 400 px and
 * left a third of the sheet as paper on the day nothing else arrived to cover
 * it — which is the fault the owner reported, in those words, looking at
 * sim/shots/03_a1_sparse.png.
 *
 * The floor matters more than the ceiling here and it is NOT in this file: a
 * body that overruns is cut at a word by ui_fit_text() and costs nothing but
 * copy nobody reads, while one that runs short is white paper. The floor is
 * enforced by `tools/mock_news_server.py --validate`, which is the only thing
 * that sees the string before the device truncates it, and it is stated to the
 * desk in tools/edition/PROMPT.md. This array only has to be able to HOLD the
 * floor — a validator that passed 3,400 characters into a 2,400-byte field
 * would be checking a string the board never receives. */
#define NEWS_BODY_MAX     4000

/* THESE ARE BYTES. THE BUDGET IS IN CHARACTERS. THEY ARE NOT THE SAME NUMBER.
 * ---------------------------------------------------------------------------
 * Every array below is a byte count and every budget in PROMPT.md is a
 * character count, because a byte is what runs out and a character is what a
 * copy desk can count. An en dash (U+2013) is three bytes of one character, and
 * a value field is where the two meet: "$1,402–$11,712" is fourteen characters,
 * exactly the documented budget, and sixteen bytes — which did not fit the
 * sixteen-byte array this used to be, because the NUL needs one of them.
 *
 * So each array is sized `budget + 2 * T + 1`, where T is how many three-byte
 * characters the field can plausibly carry. Not `budget * 3`: a headline of
 * forty em dashes is not a case worth paying for. T is stated per field.
 *
 * It matters most in the fields that are CUT rather than ellipsized. A headline
 * that overruns prints a "…" and the reader can see something went wrong; a
 * market capitalisation that reads "$226.3" because the "B" did not fit says
 * nothing at all, and news_str_copy() will trim it on a clean character
 * boundary and leave no mark. Every field on this list is one of those. */
#define NEWS_KICKER_MAX     28      /* budget 20, T = 3                        */
#define NEWS_BYLINE_MAX     40
#define NEWS_CAPTION_MAX   120
#define NEWS_SYMBOL_MAX      8
#define NEWS_TIME_MAX       24
#define NEWS_BRIEF_MAX     140      /* one item of the related-news list       */
#define NEWS_FIG_LABEL_MAX  24      /* budget 16, T = 3                        */
#define NEWS_FIG_VALUE_MAX  24      /* budget 14, T = 4 — the range dash lives
                                     * here, and so does the minus sign        */
#define NEWS_GROUP_MAX      24      /* budget 16, T = 3                        */

/* --- pieces --------------------------------------------------------------- */

typedef enum { CHART_NONE = 0, CHART_LINE, CHART_CANDLE, CHART_BAR } chart_kind_t;

/* A series of price bars in cents. CHART_LINE reads c[] alone; the other three
 * arrays are filled anyway when the wire sent a flat list of numbers, so a
 * consumer that reaches for h[] gets a zero-height bar rather than one that
 * spans the whole scale. `kind` is CHART_NONE whenever n is 0 — the parser
 * enforces it, so "is there a chart" is one test and not two.
 *
 * A CHART CARRIES MONEY. ANYTHING ELSE IS A TABLE.
 * The wire sends a JSON number and news_parse() multiplies it by a hundred, so
 * every value in o/h/l/c is CENTS and the device prints the two end figures as
 * a price. There is nowhere to say otherwise: the struct has a `label`, a
 * `span` and a `note`, and none of them changes how a number is set. A series
 * of shipments, of headcount, of $ millions of revenue therefore arrives here
 * as a price and is printed as one — the shape is right and the two figures a
 * reader can actually read off it are wrong by a factor of a hundred.
 * A chart also cannot label its columns, so a series whose PERIODS have to be
 * read has no home here either. Both of those are a news_table_t with `render`
 * set to "stack" or "bars_line": it draws the same bars AND prints the column
 * heads and the cells under them.
 *

 * Charts live at the top level and a module names one by index, rather than
 * each story carrying its own. A news_chart_t is 784 bytes and a page has at
 * most two charts on it; five stories each carrying one would spend 4 KB of a
 * struct that has to fit in PSRAM alongside a 960 KB framebuffer, to hold
 * arrays that are empty on every story but the lead. */
typedef struct {
    chart_kind_t kind;
    char    label[NEWS_FIG_LABEL_MAX];     /* "PRICE" "REVENUE" — the caps head */
    char    span[8];                       /* "1D" "5D" "1M" "6M" "1Y"      */
    char    note[48];                      /* the one line under it, optional */
    int     n;
    int32_t o[NEWS_BARS_MAX], h[NEWS_BARS_MAX],
            l[NEWS_BARS_MAX], c[NEWS_BARS_MAX];   /* cents; LINE uses c[]   */
} news_chart_t;

/* The device never resizes, tones or dithers a photo: the server sends a tile
 * already packed at 4 bpp in the framebuffer's nibble order, fetched as
 * w*h/2 raw bytes keyed on `id`. An id without both dimensions is therefore not
 * a photo but a malformed GET, and the parser drops the whole struct.
 *
 * `w` must be even. A tile packs two pixels to a byte, so an odd width cannot
 * be blitted as a per-row memcpy; the parser rejects one rather than making the
 * device carry a nibble-shifting slow path for a producer's rounding error. */
typedef struct {
    char id[16];                           /* empty = no photo              */
    int  w, h;
    char caption[NEWS_CAPTION_MAX];
    char credit[32];
} news_photo_t;

/* One entry of the dossier: a label, a value already set in the producer's
 * house style, and optionally a change to colour it by.
 *
 * `group` is the caps standing head the figure sorts under — "VALUATION", "PER
 * SHARE", "PROFITABILITY", "BALANCE SHEET", "THE STREET". Consecutive figures
 * sharing a group are ONE unit on the sheet, so the producer orders the list
 * and the device does not sort: a dossier whose groups interleave is a producer
 * bug that shows up as a repeated head, which is visible and therefore fixable.
 *
 * A GROUP HAS TO BE WELL-FORMED, WHICH IS A NEW OBLIGATION
 * -------------------------------------------------------
 * The dossier is no longer a tall thin rail down one side, where a group of
 * seven and a group of one were merely a long section and a short one. It is a
 * set of grouped units laid out beside each other, and there a group of seven
 * beside a group of one is a hole. So group SIZE is now part of the file, in
 * the same way group ORDER already was.
 *
 * Three to five figures a group, and the largest no more than twice the
 * smallest. `--validate` warns on both. It is the producer's job and not the
 * device's for the same reason `rank` and `emph` are: the device edits DOWN —
 * it drops the lowest-ranked thing that will not fit — and it has no way to
 * edit ACROSS. Re-grouping means knowing that a price/book ratio belongs with a
 * P/E and not with a current ratio, which is a fact about accounting and not
 * about typesetting; and splitting an oversized group would print two units
 * under one head, which reads as a rendering fault rather than as a file.
 *
 * `has_chg` rather than "chg_bp != 0" because zero is a real change and prints
 * as a flat mark, and most figures — a share count, a listing date — have no
 * change at all and must print with no mark and no colour. Colour is data on
 * this sheet; a P/E ratio tinted green would be decoration.
 *
 * `emph` and `bar` are what stop the dossier being a list. Twenty-eight equal
 * lines is a spreadsheet: nothing on it is louder than anything else, so the
 * eye has nowhere to land and reads none of it. The producer marks the two to
 * four figures that carry the day's argument — `emph` 1, each at the head of a
 * different group — and the device gives those the prominence and keeps the
 * rest quiet. It is the same editorial judgement `rank` already makes about
 * stories, applied to numbers.
 *
 * HOW that prominence is set is the renderer's, and deliberately not stated
 * here. This comment has twice been rewritten because it described a treatment
 * the renderer had rejected — first "large with their change beside them, and
 * the rest small and two to a line", then the rail that replaced it — and both
 * times it read as the contract while being a guess. ui_modules.c measures the
 * strings against the width it was actually given and decides. A model header
 * describing a treatment it does not control misleads worse than one that says
 * nothing.
 *
 * `bar` turns an emphasised figure into a graphic instead of a bigger number:
 * where the value sits inside a range the producer chose, normalised 0..1000,
 * -1 when it has none. A price against its 52-week range and a margin against
 * its five-year band are the two this was built for. Normalised by the producer
 * for the same reason `news_quote_t::spark` is — the device cannot see the
 * units, and a dossier that guessed them would draw a confident wrong bar. */
typedef struct {
    char    group[NEWS_GROUP_MAX];
    char    label[NEWS_FIG_LABEL_MAX];
    char    value[NEWS_FIG_VALUE_MAX];
    bool    has_chg;
    int32_t chg_bp;
    uint8_t emph;                          /* 0 = the small tier, 1 = a hero */
    int16_t bar;                           /* 0..1000 within range, -1 none  */
} news_figure_t;

/* `rank` is the server's editorial judgement and the only thing it says about
 * geometry: 0 is the lead. The device decides what fits and where it goes; the
 * server decides what matters. A payload numbered 10, 20, 30 sorts exactly like
 * one numbered 0, 1, 2.
 *
 * `chart` is an index into news_t::charts, or -1. The lead usually names the
 * price series; a story about an earnings line names the revenue bars. */
typedef struct {
    int     rank;
    char    kicker[NEWS_KICKER_MAX];
    char    headline[NEWS_HEADLINE_MAX];
    char    deck[NEWS_DECK_MAX];
    char    byline[NEWS_BYLINE_MAX];
    char    body[NEWS_BODY_MAX];
    int     chart;                         /* -1 = none                     */
    news_photo_t photo;
} news_story_t;

/* One dated item of the related-news column. Not a story: it has no body, it is
 * never given a leg, and it exists so that a front page can say what else
 * happened to this company this week in the space a headline would take. */
typedef struct {
    char date[12];                         /* "AUG 13"                      */
    char kicker[NEWS_KICKER_MAX];          /* "SUPPLY" "REGULATION"         */
    char text[NEWS_BRIEF_MAX];
} news_brief_t;

/* One row of the industry table. The two multiples are preformatted for the
 * same reason every other printed figure is; `last_c` and `chg_bp` are integers
 * because the device colours and marks them. */
typedef struct {
    char    symbol[NEWS_SYMBOL_MAX];
    char    name[24];
    char    per[NEWS_FIG_VALUE_MAX];       /* "50.2x", "—" when it has none */
    char    cap[NEWS_FIG_VALUE_MAX];       /* "$226.3B"                     */
    int32_t last_c;
    int32_t chg_bp;
    bool    is_subject;                    /* rendered in bold — this is us  */
} news_peer_t;

/* A quarterly statement, as a printed table. Every cell is text for the reason
 * news_figure_t::value is: "10,584" and "(1,203)" and "—" are three different
 * house decisions about the same int64 and the producer owns all three.
 *
 * Columns run OLDEST FIRST, which is how a financial statement is set and the
 * opposite of how a news feed arrives. The parser does not reorder — a table
 * whose quarters run backwards prints backwards, and that is visible.
 *
 * `render` asks for the same numbers as a picture. A quarterly statement is a
 * grid of figures and reads as one; six quarters of revenue, profit and margin
 * printed as eighteen cells is a thing the reader must assemble in their head,
 * where the same eighteen numbers as bars with a line over them is a thing they
 * see. So the producer says which of its tables is an argument and which is a
 * record, and the device draws or prints accordingly.
 *
 * TABLE_PRINT is the record and the default. TABLE_STACK reads each row as a
 * component of a whole and draws the columns as stacked bars — revenue by end
 * market, where what matters is the mix and not the total. TABLE_BARS_LINE
 * reads every row but the last as bars and the LAST row as a percentage line
 * over them, which is the revenue-profit-margin figure every annual report
 * opens with.
 *
 * A drawn table needs numbers, and `v` is text on purpose — "(1,203)" and
 * "10,584" and "—" are house decisions the device must not try to undo. So the
 * producer sends both: `v` is what is printed and `n` is what is drawn, and
 * they are the same figures in the two forms each job needs. Without `has_n`
 * there is nothing to scale, and the table falls back to TABLE_PRINT rather
 * than drawing an empty box — the same choice news_parse() makes everywhere
 * else, degrade to the thing that still works.
 *
 * `n` is in whatever unit `note` names, EXCEPT the line row of a TABLE_BARS_LINE
 * which is basis points, because it is a percentage and every percentage that
 * crosses this wire is basis points. */
typedef enum { TABLE_PRINT = 0, TABLE_STACK, TABLE_BARS_LINE } table_render_t;

typedef struct {
    char title[32];                                    /* "QUARTERLY RESULTS" */
    char note[48];                                     /* "$ millions"        */
    char col[NEWS_TABLE_COLS][12];                     /* "1Q26" "2Q26"       */
    int  col_count;
    struct {
        char label[24];                                /* "Revenue"           */
        char v[NEWS_TABLE_COLS][14];
    } row[NEWS_TABLE_ROWS];
    int  row_count;

    table_render_t render;
    bool           has_n;                              /* false = print it     */
    int32_t        n[NEWS_TABLE_ROWS][NEWS_TABLE_COLS];
} news_table_t;

/* One line of the index ribbon. `spark` is already normalised to 0..1000 by the
 * producer, because normalising it here would mean the device rescaling a
 * series it cannot see the units of.
 *
 * The ribbon is now a single line of small caps under the dateline — the
 * furniture a broadsheet actually gives the tape — so `spark` reaches the glass
 * only on A2. It stays in the model because A2 wants it and because a producer
 * that has the series has no cheaper place to put it. */
typedef struct {
    char    symbol[NEWS_SYMBOL_MAX];
    char    name[24];
    int32_t last_c;
    int32_t chg_bp;
    int     spark_n;
    int16_t spark[NEWS_SPARK_MAX];         /* normalised 0..1000            */
} news_quote_t;

/* The company the edition is about.
 *
 * Everything here is an integer because everything here is either compared,
 * coloured or scaled by the device: the price against the 52-week range, the
 * change against zero, the day's range against the previous close. The printed
 * summary figures — market capitalisation, enterprise value — are figures, not
 * fields, and live in the dossier where the producer can format them. */
typedef struct {
    char    symbol[NEWS_SYMBOL_MAX];       /* "SNDK"                        */
    char    name[40];                      /* "Sandisk Corp."               */
    char    exchange[12];                  /* "NASDAQ"                      */
    char    sector[32];                    /* "Semiconductors"              */
    int32_t last_c;
    int32_t chg_bp;
    int32_t prev_close_c;
    int32_t open_c, high_c, low_c;         /* the session's range           */
    int32_t wk52_hi_c, wk52_lo_c;          /* 0 = unknown, drawn as absent  */
} news_subject_t;

/* --- the snapshot --------------------------------------------------------- */

typedef struct {
    bool valid, demo;

    char edition[32];        /* "SEMICONDUCTORS" — the desk, not a slogan   */
    char dateline[40];       /* "FRIDAY, AUGUST 14, 2026"                   */
    char session[48];        /* "U.S. MARKETS CLOSED — AUG 13"              */
    char as_of[24];          /* "AS OF 05:12 KST"                           */
    char generated_at[NEWS_TIME_MAX];

    news_subject_t subject;

    news_story_t stories[NEWS_STORIES_MAX];  int story_count;
    news_figure_t figures[NEWS_FIGURES_MAX]; int figure_count;
    news_brief_t  briefs[NEWS_BRIEFS_MAX];   int brief_count;
    news_peer_t   peers[NEWS_PEERS_MAX];     int peer_count;
    news_table_t  tables[NEWS_TABLES_MAX];   int table_count;
    news_chart_t  charts[NEWS_CHARTS_MAX];   int chart_count;
    news_quote_t  indices[NEWS_INDEX_MAX];   int index_count;
    news_photo_t  thumbs[NEWS_THUMBS_MAX];   int thumb_count;
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

/* The same for a table's `render`, and unknown is TABLE_PRINT for the same
 * reason unknown is CHART_NONE: a table drawn with the wrong geometry is worse
 * than one that was only printed, and printing it is never wrong. */
table_render_t news_table_render_from(const char *word);

/* A fingerprint of everything that is drawn. Two snapshots with the same
 * fingerprint produce the same pixels, so the caller can skip a panel refresh
 * entirely — which on this panel is twenty-five seconds of flashing rather than
 * the 5.83"'s two, and is the difference between a silent board and one that
 * repaints at nobody all day.
 *
 * Everything that reaches the glass is in here, down to the photo ids, the
 * chart span and every individual bar, every dossier value and every table
 * cell. A fingerprint that is too narrow does not fail loudly; it shows
 * yesterday's page forever, and nobody notices until they read a stale number
 * off it.
 *
 * It must also cover everything the COMPOSITOR reads, which is a strictly wider
 * set than what any one page draws: the counts, the ranks, the presence of a
 * photo. Two payloads that differ only in a field the day's layout happened not
 * to use still lay out differently tomorrow, and a hash that missed it would
 * pin the wrong page. */
uint32_t news_hash(const news_t *v);

#ifdef __cplusplus
}
#endif
