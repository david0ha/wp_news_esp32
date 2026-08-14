/*
 * device_api_model.h — platform-agnostic snapshot of the running device, as
 * exposed to the companion app over GET /api/state.
 *
 * Self-contained on purpose (no ESP-IDF, no LVGL, no provisioning dependency)
 * so the serializer compiles in the host tests and the desktop simulator.
 * user_app fills it under its state lock; device_api_json.c serializes it.
 *
 * This is a SUMMARY, not the front page. The phone does not need four bodies of
 * copy and twenty-two candles — it needs to know the board is alive, what is on
 * the glass, and whether the last poll worked. The full snapshot is available
 * from the same URL the board polls, which the phone can reach too.
 *
 * The string capacities are not arbitrary: a worst-case document — every field
 * full of characters the escaper doubles — has to fit DEVICE_API_STATE_BUF_SZ,
 * because the overflow path returns -1 and an EMPTY body, so the symptom of
 * being one byte over is "the app shows nothing" with no error anywhere.
 * test_api_json.c asserts it and prints the margin.
 *
 * Every numeric field is an integer. Prices are cents and changes are basis
 * points, exactly as in news_t — so the class of bug where "%.2f" of a huge
 * magnitude truncates on the decimal point and emits JSON that strict parsers
 * reject is designed out rather than guarded.
 */
#pragma once

#include <stdbool.h>
#include <stddef.h>

#define DEV_MODEL_MAXLEN     24
#define DEV_FW_MAXLEN        16
#define DEV_DEVID_MAXLEN     16
#define DEV_IP_MAXLEN        16
#define DEV_PAGE_MAXLEN      32
#define DEV_EDITION_MAXLEN   32
#define DEV_SYMBOL_MAXLEN     8
#define DEV_HEADLINE_MAXLEN  72   /* the lead, truncated for a phone list row */
#define DEV_TIME_MAXLEN      24
#define DEV_URL_MAXLEN      129   /* == PROV_URL_MAX_LEN + 1 */
#define DEV_RESULT_MAXLEN    16
#define DEV_INDEX_MAX         5   /* == NEWS_INDEX_MAX, the ribbon's cells */

/* One ribbon cell. The name is not repeated here — the symbol identifies it and
 * the app already has a label for each — which is what buys the room for the
 * lead's headline inside the same buffer. */
typedef struct {
    char symbol[DEV_SYMBOL_MAXLEN];
    int  last_c;                        /* cents        */
    int  chg_bp;                        /* basis points */
} dev_index_t;

typedef struct {
    char model[DEV_MODEL_MAXLEN];
    char fw[DEV_FW_MAXLEN];
    char device_id[DEV_DEVID_MAXLEN];
    char ip[DEV_IP_MAXLEN];

    int  page;                          /* ui_page_t */
    char page_title[DEV_PAGE_MAXLEN];   /* the same name the folio shows */

    /* --- the front page on the glass --- */
    bool news_valid;
    bool demo;                          /* rendered from the built-in sample */
    char edition[DEV_EDITION_MAXLEN];
    char generated_at[DEV_TIME_MAXLEN];
    int  story_count;
    int  ticker_count;
    char lead_symbol[DEV_SYMBOL_MAXLEN];
    char lead_headline[DEV_HEADLINE_MAXLEN];
    dev_index_t indices[DEV_INDEX_MAX];
    int  index_count;

    /* --- how it got there --- */
    char news_url[DEV_URL_MAXLEN];
    char last_result[DEV_RESULT_MAXLEN];  /* news_fetch_result_name()        */
    int  poll_seconds;
    int  age_seconds;                     /* since the last SUCCESSFUL fetch  */
    bool stale;

    /* --- power --- */
    bool battery_present;
    int  battery_pct;
    int  battery_mv;

    /* --- e-Paper ---
     * Spectra 6 has one kind of refresh and it is slow, so there is one number.
     * It is here because the polling policy is meant to be set from measurement
     * on real hardware, and reading it off a phone beats holding a serial cable
     * to a board on a shelf. */
    int  refresh_ms;
} device_state_t;
