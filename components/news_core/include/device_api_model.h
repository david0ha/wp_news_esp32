/*
 * device_api_model.h — platform-agnostic snapshot of the running device, as
 * exposed to the companion app over GET /api/state.
 *
 * Self-contained on purpose (no ESP-IDF, no LVGL, no provisioning dependency)
 * so the serializer compiles in the host tests and the desktop simulator.
 * user_app fills it under its state lock; device_api_json.c serializes it.
 *
 * THIS IS CONTROL STATE, NOT A COPY OF THE PAGE
 * ---------------------------------------------
 * The companion app's job is setup and control over the LAN: provisioning,
 * which sheet is showing, the battery, the link, and pointing the board at a
 * URL. So this struct answers "is the board alive, what is it printing, and did
 * the last poll work" — and stops there. The edition itself is available from
 * the same URL the board polls, which the phone can reach too.
 *
 * ONE COMPANY, NOT A WATCHLIST
 * ----------------------------
 * The edition is about a single listed company, so the summary is too. The
 * `lead` object of the previous shape — one symbol and one headline — is gone,
 * because every story on the sheet now names the same symbol and repeating it
 * per headline says nothing. What replaces it is `subject`, which is the whole
 * of what the page is about, plus the headlines the board actually set.
 *
 * WHERE THE DOSSIER IS NOT
 * ------------------------
 * There is no `dev_figure_t` here, and its absence is a decision rather than an
 * oversight. Carrying all twenty-eight figures — a group, a label and a
 * preformatted value each — put the worst-case state document at 15,092 bytes
 * and cost 16 KB of .bss for the life of the board, because device_api.c
 * serialises into a file static. The dossier is what the PAPER is for; a reader
 * who wants the figures is standing in front of them. What survives is
 * `figure_count`, so the app can say "28 figures" without carrying them.
 *
 * If a later version does want the dossier on the phone, it gets an endpoint of
 * its own that builds the response on demand. It does not come back into the
 * state document, which every dashboard poll pays for.
 *
 * The string capacities are not arbitrary: a worst-case document — every field
 * full of characters the escaper expands — has to fit DEVICE_API_STATE_BUF_SZ,
 * because the overflow path returns -1 and an EMPTY body, so the symptom of
 * being one byte over is "the app shows nothing" with no error anywhere.
 * test_api_json.c asserts it and prints the margin.
 *
 * Every numeric field is an integer. Prices are cents and changes are basis
 * points, exactly as in news_t — so the class of bug where "%.2f" of a huge
 * magnitude truncates on the decimal point and emits JSON that strict parsers
 * reject is designed out rather than guarded. That leaves nothing here that
 * needed the producer's house style, which is the other half of why the dossier
 * does not travel: its values are text precisely because they are for printing.
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
#define DEV_TIME_MAXLEN      24
#define DEV_LANG_MAXLEN       8   /* == NEWS_LANG_MAX */
#define DEV_URL_MAXLEN      129   /* == PROV_URL_MAX_LEN + 1 */
#define DEV_RESULT_MAXLEN    16

/* The subject's own fields, at news_subject_t's own widths. Truncating a
 * company name for the phone would put a different name on the phone than on
 * the paper, which is the one thing a summary must not do. */
#define DEV_SYMBOL_MAXLEN     8   /* == NEWS_SYMBOL_MAX          */
#define DEV_NAME_MAXLEN      40   /* == news_subject_t::name     */
#define DEV_EXCHANGE_MAXLEN  12   /* == news_subject_t::exchange */
#define DEV_SECTOR_MAXLEN    32   /* == news_subject_t::sector   */

/* A headline IS cut for the phone: 72 characters is a list row, and the model's
 * own budget stops a lead headline at 72 anyway (docs/news-contract.md §the
 * length budget), so a headline written to the budget arrives whole. */
#define DEV_HEADLINE_MAXLEN  72

#define DEV_STORY_MAX         5   /* == NEWS_STORIES_MAX, the headlines    */
#define DEV_INDEX_MAX         5   /* == NEWS_INDEX_MAX, the tape's cells   */

/* The company the edition is about, and its session.
 *
 * Cents and basis points rather than the strings the panel prints, because the
 * app owns its own decimal separator and its own sign colour and the two would
 * drift if the firmware decided them here as well. A zero 52-week bound means
 * unknown, exactly as it does in news_subject_t — the page draws it as absent
 * rather than as a price of nothing, and so should the app. */
typedef struct {
    char symbol[DEV_SYMBOL_MAXLEN];
    char name[DEV_NAME_MAXLEN];
    char exchange[DEV_EXCHANGE_MAXLEN];
    char sector[DEV_SECTOR_MAXLEN];
    int  last_c;
    int  chg_bp;
    int  prev_close_c;
    int  open_c, high_c, low_c;
    int  wk52_hi_c, wk52_lo_c;
} dev_subject_t;

/* One headline the board set. `rank` is the server's editorial number, carried
 * through unchanged so a phone list sorts the way the page did — the device's
 * own ordering is by position and the number is what produced it. No symbol:
 * every story on the sheet is about `subject`. */
typedef struct {
    int  rank;
    char headline[DEV_HEADLINE_MAXLEN];
} dev_story_t;

/* One tape cell. The name is not repeated here — the symbol identifies it and
 * the app already has a label for each. */
typedef struct {
    char symbol[DEV_SYMBOL_MAXLEN];
    int  last_c;                        /* cents        */
    int  chg_bp;                        /* basis points */
} dev_index_t;

/* Which of the four layers decided the interval above. The vocabulary mirrors
 * source.pollSource's — "policy" | "api" | "nvs" | "default" — because the app
 * already renders one of them and two spellings of one idea is one too many. */
typedef enum {
    DEV_SLEEP_SRC_DEFAULT = 0,   /* Kconfig, or nothing has said otherwise */
    DEV_SLEEP_SRC_NVS,           /* the setup form, or an earlier /api/sleep */
    DEV_SLEEP_SRC_API,           /* POST /api/sleep, this session           */
    DEV_SLEEP_SRC_POLICY,        /* the desk: poll_seconds or next_change   */
} dev_sleep_src_t;

typedef struct {
    char model[DEV_MODEL_MAXLEN];
    char fw[DEV_FW_MAXLEN];
    char device_id[DEV_DEVID_MAXLEN];
    char ip[DEV_IP_MAXLEN];

    int  page;                          /* ui_page_t */
    char page_title[DEV_PAGE_MAXLEN];   /* the same name the folio shows */

    /* --- the edition on the glass --- */
    bool news_valid;
    bool demo;                          /* rendered from the built-in sample */
    char edition[DEV_EDITION_MAXLEN];
    char generated_at[DEV_TIME_MAXLEN];

    /* The language the edition on the glass is written in, already normalised
     * by the parser. Available rather than used: the app picks its type ramp
     * from the `lang` on the edition JSON it fetches from the desk, and nothing
     * reads this field today. It is here because this document is what a client
     * asks the BOARD about the page actually on the glass, and a client that
     * had to infer the language of that page from a document it fetched
     * somewhere else would be guessing. */
    char lang[DEV_LANG_MAXLEN];

    dev_subject_t subject;

    dev_story_t stories[DEV_STORY_MAX];  int story_count;
    dev_index_t indices[DEV_INDEX_MAX];  int index_count;

    /* The rest of the edition travels as counts alone. A figure, a brief, a peer
     * row and a table cell are all things the reader has in front of them; what
     * the app needs is whether the board received them, which is the difference
     * between "the producer filed a thin day" and "the parser dropped
     * something". These are the counts AFTER parsing, so they are also how a
     * producer finds out that its forty figures became twenty-eight. */
    int figure_count;
    int brief_count;
    int peer_count;
    int table_count;
    int chart_count;
    int thumb_count;

    /* --- how it got there --- */
    char news_url[DEV_URL_MAXLEN];
    char last_result[DEV_RESULT_MAXLEN];  /* news_fetch_result_name()        */

    /* The cadence in force, and whether the board chose it or was told it.
     *
     * `poll_seconds` is the EFFECTIVE figure, not the compiled-in one: a payload
     * may carry a `policy` block setting it (see news_model.h), so the number
     * here is what the poll loop is actually waiting.
     *
     * Which is why the flag beside it is not redundant. A board reporting an
     * hourly poll has either been put there by its desk for the night or been
     * built that way in Kconfig, and those need opposite responses — the first
     * ends by itself, the second needs a firmware image. The number alone cannot
     * be acted on. It travels as the word "config" or "policy" rather than as a
     * boolean, because that is what an app puts on a screen; it is a bool here
     * because two spellings of the same fact is one spelling too many. */
    bool poll_from_policy;
    int  poll_seconds;
    int  age_seconds;                     /* since the last SUCCESSFUL fetch  */
    bool stale;

    /* --- battery --- */
    bool battery_present;
    int  battery_pct;
    int  battery_mv;

    /* --- power: the design measuring itself ---
     *
     * The deep-sleep design rests on two numbers nobody has measured on this
     * board — the standing deep-sleep current, and how long a Wi-Fi connect
     * actually takes, which is the dominant term in a wake that is otherwise
     * three seconds long. Estimating them gave a battery life stated as a range
     * of 190 to 260 days, and a range that wide is not a prediction.
     *
     * So the board counts instead. Every wake accumulates into RTC memory, and
     * these are those counters: after a day on a wall, with no instruments and
     * no serial cable, the estimate becomes a measurement. That is the whole
     * purpose of the object, and it is why it reports raw counters rather than
     * a verdict — a number a reader can re-derive survives a change to the
     * arithmetic that produced it.
     *
     * These fields are copied straight out of wp_rtc_state_t and share its
     * names on purpose, so the wiring is a copy with no arithmetic in it. The
     * two DERIVED numbers the phone receives — the mean awake time and the
     * daily estimate — are computed in device_api_json.c, which is host-tested,
     * rather than by whoever fills this struct. Both of them divide, and both
     * divisors are legitimately zero on a real board. */
    bool deep_sleep;      /* the feature is enabled for this board            */
    /* The EFFECTIVE interval — what this board will actually sleep for when its
     * window closes, which since the desk began setting the cadence is often
     * not the interval anybody configured. The device's own filler resolves the
     * build-time default before it gets here, so 0 should never reach a phone —
     * but the serialiser still guards it, because this struct is also filled by
     * the host tests and a 0 here is a divide by zero in est_mah_per_day(). */
    int  sleep_seconds;
    /* And who decided it, for the reason poll_from_policy sits beside
     * poll_seconds: an hourly interval the desk set for its quiet window ends
     * at 06:00 by itself, one compiled into the image needs a reflash, and one
     * typed into the setup form needs the form. Same number, three different
     * things to do about it.
     *
     * DEFAULT is zero so a memset struct is honest rather than claiming a desk
     * said something. "api" does not survive a sleep, and that is correct
     * rather than a gap: POST /api/sleep writes NVS as well as RTC memory, so
     * after a wake the very same value reads "nvs" — which is what it now is. */
    dev_sleep_src_t sleep_source;
    int  wakes;           /* since the last cold boot (RTC memory is lost on one) */
    int  quiet_wakes;     /* of those, the ones that cost no refresh          */
    int  awake_ms_total;  /* summed over `wakes`; the mean is derived from it */

    /* --- e-Paper ---
     * Spectra 6 has one kind of refresh and it is slow, so there is one number.
     * It is here because the polling policy is meant to be set from measurement
     * on real hardware, and reading it off a phone beats holding a serial cable
     * to a board on a shelf. */
    int  refresh_ms;
} device_state_t;
