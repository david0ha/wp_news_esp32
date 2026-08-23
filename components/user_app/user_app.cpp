/*
 * user_app.cpp — app orchestration for the Claude Post board.
 *
 *   AppInit:  route cJSON allocations to PSRAM.
 *   UiInit:   build the LVGL news UI on a fresh screen.
 *   TaskInit: spawn the UI task and the news poller.
 *
 * Wi-Fi bring-up, NVS and the post-connect clock sync are owned by the
 * `provisioning` component; the battery by `board_io`; the panel by `port_bsp`.
 * The portable core (the model, the parser, the whole UI) lives in
 * `news_core` and is the same code the host tests and the desktop simulator
 * exercise.
 *
 * The structure is dictated by the display. A full refresh of this 1200x1600
 * panel takes twenty to thirty seconds, flashes the whole sheet, and cannot be
 * interleaved with another, so:
 *
 *   - Exactly one task (UiTask) ever touches LVGL or starts a refresh.
 *   - Everything else — buttons, the HTTP API, the news poller — posts a
 *     command and returns.
 *   - Drawing and presenting are separate: widgets are updated, then the frame
 *     is rendered synchronously, then ONE refresh is issued for the whole
 *     change. Never one refresh per widget.
 *
 * And one rule this board adds on top: a poll that returns the same content
 * does not touch the panel at all. Every five minutes, forever, on a device
 * that mostly sits still, that is the difference between a front page hanging
 * quietly in its frame and one that flashes at nobody all day.
 */
#include <limits.h>
#include <stdio.h>
#include <string.h>
#include <time.h>

#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <freertos/queue.h>
#include <freertos/semphr.h>
#include <esp_log.h>
#include <esp_heap_caps.h>
#include <esp_system.h>   /* esp_restart for the force-AP escape hatch */
#include <esp_timer.h>

#include "sdkconfig.h"
#include "cJSON.h"

#include "user_app.h"
#include "user_app_api.h"
#include "lvgl_bsp.h"          /* Lvgl_lock / Lvgl_unlock / Lvgl_RenderNow */
#include "epd6_panel.h"        /* epd6_refresh / epd6_selftest            */
#include "ui_news.h"
#include "ui_strings.h"
#include "ui_tile.h"           /* the lead's photograph, fetched on this task */
#include "news_model.h"
#include "news_mock.h"
#include "news_service.h"
#include "http_port.h"
#include "buttons.h"
#include "board_io.h"
#include "power.h"             /* the RTC state this task publishes into      */
#include "prov_store.h"
#include "prov_config.h"

#include <driver/gpio.h>
#include <driver/rtc_io.h>

static const char *TAG = "app";
static lv_obj_t   *s_screen;

/* The provisioned config, copied so it outlives app_main's stack. */
static prov_config_t s_cfg;

/* The board's button pins, copied for the same reason. UiTask needs them to arm
 * the ext1 wake on its way into a sleep, and it is the only reader. */
static int s_btn_gpios[BUTTON_COUNT];
static int s_btn_count;

/* --- cadences ------------------------------------------------------------ */

#ifndef CONFIG_CLAUDEPOST_POLL_SECONDS
#define CONFIG_CLAUDEPOST_POLL_SECONDS 60
#endif
#ifndef CONFIG_CLAUDEPOST_FEED_URL
#define CONFIG_CLAUDEPOST_FEED_URL ""
#endif

/* The cadence a board boots at, and the one it falls back to. It is a default
 * and no longer the answer: the payload may carry a `policy` block that says how
 * often to come back, so the live figure is `s_poll_seconds` below. */
#define POLL_SECONDS_DEFAULT  CONFIG_CLAUDEPOST_POLL_SECONDS

/* How often UiTask wakes to move the clock on IN THE FRAMEBUFFER. It does not
 * reach the glass on its own.
 *
 * The 5.83" board pushed the header out every five minutes with a windowed
 * partial refresh, which was silent and cost a fraction of a second. Spectra 6
 * has no partial waveform at all: the only update it can do is a full one that
 * flashes the whole page for half a minute. Spending that on a clock would mean
 * a hundred and twenty flashes a day at nobody.
 *
 * So the clock rides along with the next refresh that has a reason of its own.
 * A front page carries a date, not a ticking clock — see docs/pages.md. */
#define TICK_SECONDS       60

/* A snapshot older than this gets the STALE badge.
 *
 * Two poll intervals rather than one: a single missed poll is a laptop closing
 * its lid, not a problem the user needs told about. But the badge answers a
 * question about the NEWS ("is what I am reading still current?"), not about the
 * poll loop, and at a one-minute cadence two intervals is two minutes — which
 * would badge a front page that is fine because somebody's Wi-Fi hiccuped
 * during lunch. So the poll interval sets the shape and a floor sets the
 * meaning: a quarter of an hour is the point at which a reader would want to
 * know, whatever the device's cadence happens to be.
 *
 * It stopped being a macro when the cadence stopped being a constant. A server
 * that puts the board on an hourly poll overnight has ALSO said that a page an
 * hour old is not stale — the badge answers "is what I am reading still
 * current?", and the answer depends on how often the desk intended to speak. A
 * frozen fifteen-minute threshold would badge every quiet-window sheet `STALE`
 * by 00:45 and leave the mark on the wall until morning, which is the badge
 * saying "the poll loop is behaving exactly as instructed". */
#define STALE_FLOOR_SECONDS  900

/* How long the first sheet of a boot waits for real news before giving up and
 * printing the demo snapshot instead.
 *
 * This exists because there is exactly one refresh worth spending on a boot and
 * the question is which page gets it. Printing the demo the instant the UI is
 * built — which is what this used to do — buys a finished-looking screen at the
 * price of the real one arriving twenty-five seconds later, on top of the
 * twenty-five the demo itself takes. On a panel with a partial waveform that
 * trade is free and obviously right; on this one it is the single biggest term
 * in the time-to-first-page.
 *
 * Fifteen seconds is a fetch that includes every photograph in the edition over
 * a home network, with room for a server that is slow rather than absent. Past
 * that the demo goes up: a complete front page badged DEMO is a better answer
 * than a blank panel, and the real one lands on the next poll anyway. */
#define FIRST_PAINT_WAIT_MS 15000

/* Poll interval used for the first few attempts of a boot, so a first fetch
 * that lands a moment before the server does is not punished with a whole
 * interval of blank panel.
 *
 * Bounded, and the bound is the point. "Retry fast until one succeeds" is the
 * obvious rule and it is a trap: a board pointed at a server that is simply
 * switched off never succeeds, so it would retry every three seconds forever —
 * twenty-eight thousand requests a day, and on battery about a thousand
 * milliamp-hours of them. Four attempts covers the twelve seconds inside
 * FIRST_PAINT_WAIT_MS where a retry can still change which page gets printed,
 * which is the entire benefit; after that the normal interval is the correct
 * behaviour for a server that is not there. */
#define FIRST_RETRY_SECONDS 3
#define FIRST_RETRY_MAX     4

/* KEY2 held this long forces Wi-Fi setup mode — the escape hatch when the board
 * is stuck on a network the user can no longer reach. */
#define HOLD_POLL_MS       25
#define FORCE_AP_HOLD_MS 5000

/* --- commands ------------------------------------------------------------ */

typedef enum {
    APP_CMD_SET_PAGE,        /* ival = ui_page_t                     */
    APP_CMD_REFRESH_NOW,     /* poll immediately                     */
    APP_CMD_SET_URL,         /* text = the new snapshot URL          */
    APP_CMD_DISPLAY_TEST,    /* run epd6_selftest()                  */
    APP_CMD_DATA,            /* NewsTask published a new snapshot   */
    APP_CMD_SET_SLEEP,       /* ival = seconds between polls asleep  */
} app_cmd_kind_t;

typedef struct {
    app_cmd_kind_t kind;
    int  ival;
    char text[PROV_URL_MAX_LEN + 1];
} app_cmd_t;

static QueueHandle_t     s_btn_queue;
static QueueHandle_t     s_cmd_queue;
static QueueSetHandle_t  s_queue_set;
static SemaphoreHandle_t s_mtx;
static SemaphoreHandle_t s_poll_wake;

static inline void state_lock(void)   { xSemaphoreTake(s_mtx, portMAX_DELAY); }
static inline void state_unlock(void) { xSemaphoreGive(s_mtx); }

/* --- state (guarded by s_mtx unless noted) -------------------------------- */

static news_t  s_data;                 /* what is on (or going to) the glass */
static uint32_t s_data_hash;
/* The server's ETag for the document s_data was parsed from, or "" if the
 * server sent none. Its invariant is the whole of its usefulness: it always
 * names a document that parses to exactly s_data, so publishing it beside
 * s_data_hash is publishing one fact about one page rather than two facts that
 * can disagree. Empty at boot on purpose — see NewsTask. */
static char     s_data_etag[HTTP_ETAG_MAX];
static int      s_page;

static news_fetch_result_t s_last_result = NEWS_FETCH_NO_URL;
static int64_t  s_last_ok_us;           /* 0 = never fetched successfully     */
/* True until a fetch fails at the transport. Starts true because UserApp_TaskInit
 * only runs once Wi-Fi is up, and an unconfigured board that never fetches
 * anything is not offline — it is showing its demo screen on purpose. */
static bool     s_online = true;

static bool     s_batt_present;
static int      s_batt_pct;
static int      s_batt_mv;

/* --- the polling policy (guarded by s_mtx) --------------------------------
 *
 * How often this board comes back, and when it expects the answer to change.
 * Both start at the compiled-in default and are replaced by whatever the last
 * payload's `policy` block said.
 *
 * THESE ARE RAM AND NOTHING WRITES THEM TO NVS, WHICH IS THE POINT. A policy is
 * a statement about right now — a quiet window, an edition due at 06:00 — and it
 * is made by a server the board can reach. Persisting one would mean a desk that
 * put the board on a daily poll at 00:30, and then went away, leaves it polling
 * once a day forever with no way back short of the setup portal. A power cycle
 * is the reset, and it costs nothing: the first poll after it re-adopts whatever
 * the server is saying now.
 *
 * The URL, by contrast, IS persisted — because it is a statement about which
 * desk this board reads, which is a decision its owner made. */
static int      s_poll_seconds = POLL_SECONDS_DEFAULT;
static int64_t  s_next_change;          /* epoch seconds; 0 = none announced */
static bool     s_poll_from_policy;     /* what the companion app reports     */

/* A snapshot older than this is badged STALE. Derived rather than stored so it
 * follows the cadence the desk actually asked for — see STALE_FLOOR_SECONDS.
 * Caller holds s_mtx. */
static int stale_seconds_locked(void)
{
    int twice = s_poll_seconds * 2;
    return twice > STALE_FLOOR_SECONDS ? twice : STALE_FLOOR_SECONDS;
}

/* Only ever touched by UiTask. */

/* Which story leads the page. `rank` is the server's editorial judgement and
 * not an index: a payload numbered 10, 20, 30 says exactly what one numbered
 * 0, 1, 2 says, so the lead is the lowest rank rather than stories[0]. The page
 * needs the whole ordering and sorts; the log line and the companion app need
 * only its head, so this scans — over at most six elements, and a stable scan
 * and a stable sort agree on which one comes first. NULL on an empty snapshot,
 * which is what a board shows before its first poll. */
static const news_story_t *lead_story(const news_t *v)
{
    const news_story_t *lead = NULL;
    for (int i = 0; i < v->story_count; i++) {
        if (!lead || v->stories[i].rank < lead->rank) {
            lead = &v->stories[i];
        }
    }
    return lead;
}

/* cJSON's parse tree for a news snapshot is a few KB, but keeping it out of
 * internal RAM leaves that for WiFi/TLS and the panel's DMA framebuffer. */
static void *psram_malloc(size_t sz)
{
    void *p = heap_caps_malloc(sz, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    return p ? p : malloc(sz);      /* boards without PSRAM still work */
}

void UserApp_AppInit(void)
{
    cJSON_Hooks hooks = { .malloc_fn = psram_malloc, .free_fn = free };
    cJSON_InitHooks(&hooks);
}

void UserApp_UiInit(void)
{
    /* Swap the provisioning status screen for the news UI, freeing the old one
     * (and its widgets) instead of leaking it for the process lifetime. */
    lv_obj_t *prev = lv_screen_active();
    s_screen = lv_obj_create(NULL);
    lv_screen_load(s_screen);
    if (prev && prev != s_screen) {
        lv_obj_delete(prev);
    }
    ui_news_create(s_screen);

    /* What the page actually cost, on the board, once.
     *
     * The simulator holds an LVGL budget (check_lvgl_budget) and its own comment
     * says the number it measures is a HOST figure and an over-estimate — this
     * binary is 64-bit and every pointer inside an lv_obj_t is twice the width
     * it is here. It then points at "lv_mem_monitor()'s max_used on the board"
     * as where the real figure comes from, and nothing on the board printed it.
     * The only LVGL memory line the firmware had was the one in lvgl_mem_psram's
     * oom(), which by construction only ever appears when it is already too
     * late.
     *
     * So it is printed here, at the one moment it means something: every widget
     * both pages will ever own has just been created, and nothing is created in
     * an update after this. docs/bring-up.md asks for this number to be
     * recorded; this is the line to read it off. */
    {
        lv_mem_monitor_t m;
        lv_mem_monitor(&m);
        ESP_LOGI(TAG, "LVGL widgets built: %u B held, %u B peak, %u B free in "
                      "the pool",
                 (unsigned)(m.total_size - m.free_size),
                 (unsigned)m.max_used, (unsigned)m.free_size);
    }
}

/* --- presenting (UiTask only) --------------------------------------------- */

/* Whether anything reached the paper on this boot. UiTask only — it is written
 * by present_full() and read by enter_sleep(), both of which run on that one
 * task, so it needs no lock and must not acquire one.
 *
 * It exists because "this wake decided to print" and "this wake printed" are
 * different facts and the failure that separates them is silent. See
 * enter_sleep(). */
static bool s_printed;

/* Render whatever the setters changed, then push one refresh for the lot.
 *
 * There is only one kind of refresh on this panel and it costs twenty to thirty
 * seconds of flashing, so every call here is a decision someone has to have
 * made deliberately. Nothing in this file calls it on a timer. */
static void present_full(void)
{
    Lvgl_RenderNow();
    epd6_refresh();

    /*
     * Record what is now on the glass, so the next wake can tell whether it
     * still is. This is the other half of the deep-sleep design and without it
     * the quiet path cannot work at all: `content_hash` starts at zero, every
     * wake hashes the payload, finds it different from zero, concludes the
     * content changed, and spends twenty-five seconds reprinting the page that
     * was already there. Every fifteen minutes. Forever.
     *
     * AFTER the refresh, never before, and that placement is the point rather
     * than an accident of where the line sits. A board that recorded the hash
     * and then browned out three seconds into a twenty-five second refresh
     * would wake up believing it had printed a page it had not, and would go on
     * believing it for as long as the payload held still — weeks, with nothing
     * in any log to say so.
     *
     * The tag travels with the hash for exactly the same reason, and it is the
     * one that would defeat the protection if it went early: the ETag
     * short-circuits the comparison before the hash is ever computed, so a tag
     * published before a refresh that then failed would earn a 304 on the next
     * wake and the new edition would never print. Two facts about one page,
     * published in one act, once the page is actually on the paper.
     */
    wp_rtc_state_t *rs = power_state();
    state_lock();
    rs->content_hash = s_data_hash;
    http_etag_copy(rs->etag, sizeof(rs->etag), s_data_etag);

    /* And the failure count, cleared HERE and nowhere earlier. This is the one
     * place in the firmware that knows a page is on the paper, which is the
     * only evidence that the whole chain — connect, fetch, parse, compose,
     * refresh — actually worked. power_decide() used to clear it on the mere
     * decision to print, so a wake that decided to print and then failed to
     * fetch anything told the next wake it was healthy. See the CHANGED arm of
     * power_decide() and enter_sleep(). */
    rs->consecutive_fails = 0;
    state_unlock();

    s_printed = true;   /* UiTask only — see the declaration above */
}

/* --- content updates (UiTask only) ---------------------------------------- */

/* The snapshot is copied out from under the mutex so LVGL is never touched while
 * holding it. The copy is static rather than automatic because news_t is 33 KB
 * — four times the whole of UiTask's 8 KB stack, so an automatic would not
 * overflow it, it would never fit on it — and this frame goes on to call into
 * LVGL, whose render (Lvgl_RenderNow -> lv_refr_now) runs on this same task. A
 * static is safe here precisely because of the rule the whole file is built on:
 * UiTask is the only caller. */
static news_t s_ui_copy;

static void push_data_to_ui(void)
{
    state_lock();
    s_ui_copy = s_data;
    ui_status_t st = {
        .online          = s_online,
        .stale           = false,
        .battery_present = s_batt_present,
        .battery_pct     = s_batt_pct,
    };
    /* Staleness is derived here rather than stored, so it becomes true on its
     * own as time passes instead of only when a fetch fails. A configured board
     * that has never once succeeded is stale from the start — otherwise the
     * only state that says so is a transport error, and a server answering 404
     * forever would look healthy. */
    if (s_last_ok_us != 0) {
        int64_t age_us = esp_timer_get_time() - s_last_ok_us;
        st.stale = age_us > (int64_t)stale_seconds_locked() * 1000000;
    } else {
        st.stale = s_cfg.news_url[0] != '\0';
    }
    state_unlock();

    if (Lvgl_lock(-1)) {
        ui_news_set_data(&s_ui_copy);
        ui_news_set_status(&st);
        Lvgl_unlock();
    }
}

static void read_battery(void)
{
    float v = board_io_battery_voltage();
    state_lock();
    s_batt_present = board_io_battery_present();
    s_batt_mv      = (int)(v * 1000.0f + 0.5f);
    s_batt_pct     = board_io_battery_percent();
    state_unlock();
}

/* Bring every widget on the page up to date with the current state — the
 * snapshot, the battery, the clock — and stop there. No render, no refresh:
 * this is the half of "showing something" that costs nothing, and separating it
 * from the half that costs twenty-five seconds is what lets the boot hold its
 * one refresh open while still having a finished page ready to spend it on.
 * UiTask only, like everything else that touches LVGL. */
static void restate_page(void)
{
    read_battery();
    push_data_to_ui();
    if (Lvgl_lock(-1)) {
        ui_news_tick();
        Lvgl_unlock();
    }
}

/* The URL this board actually polls: what setup stored, or the build-time
 * fallback when it stored nothing. Empty means the demo snapshot is the whole
 * configuration and no fetch will ever happen. Caller holds s_mtx. */
static void current_url(char *out, size_t n)
{
    strlcpy(out, s_cfg.news_url[0] ? s_cfg.news_url : CONFIG_CLAUDEPOST_FEED_URL, n);
}

/* --- actions -------------------------------------------------------------- */

static void action_set_page(int page)
{
    if (page < 0 || page >= UI_PAGE_COUNT) {
        return;
    }
    state_lock();
    s_page = page;
    state_unlock();

    if (Lvgl_lock(-1)) {
        ui_news_show_page((ui_page_t)page);
        Lvgl_unlock();
    }
    present_full();   /* a page swap replaces every pixel in the content area */
}

static void action_set_url(const char *url)
{
    state_lock();
    strlcpy(s_cfg.news_url, url, sizeof(s_cfg.news_url));

    /* A cadence belongs to the desk that asked for it, so pointing the board at
     * a different one drops it. Carrying it over would let a desk that is no
     * longer being read set the poll interval for the one that is — and a board
     * moved from a server with a quiet window to a server without one would keep
     * the window, which is the sort of fault nobody thinks to look for. */
    s_poll_seconds     = POLL_SECONDS_DEFAULT;
    s_next_change      = 0;
    s_poll_from_policy = false;

    /* Including the copy that crosses a sleep. Without this the board would be
     * pointed at a new desk and then go to sleep on the old desk's cadence —
     * and on the old desk's `next_change`, which is an instant in a schedule
     * this board no longer reads. */
    power_state()->poll_seconds = 0;
    power_state()->next_change  = 0;

    /* Clearing the URL means "go back to the demo screen", and it has to happen
     * here rather than by waiting for a poll — with no URL there is no poll, so
     * the board would otherwise sit on the last real snapshot indefinitely and
     * then quietly badge it STALE, which is the opposite of what was asked. */
    bool to_demo = (url[0] == '\0');
    if (to_demo) {
        news_mock(&s_data);
        s_data_hash  = news_hash(&s_data);
        s_last_ok_us = 0;
        s_last_result = NEWS_FETCH_NO_URL;
        s_online     = true;
    }
    state_unlock();

    if (!prov_store_save(&s_cfg)) {
        ESP_LOGW(TAG, "news URL change: NVS save failed (will not survive reboot)");
    }
    ESP_LOGI(TAG, "news URL set to '%s'%s", url, to_demo ? " (demo snapshot)" : "");

    if (to_demo) {
        push_data_to_ui();
        present_full();
    }
    if (s_poll_wake) {
        xSemaphoreGive(s_poll_wake);
    }
}

/*
 * Change the deep-sleep interval, from a phone.
 *
 * This is the third of the three layers that set it — Kconfig, then the setup
 * form's NVS value, then this — and it exists because taking a frame off a wall
 * and finding a USB-C cable in order to change a polling interval is the thing
 * that gets resented within a month.
 *
 * It runs on UiTask rather than on the HTTP task, like every other write in
 * this file, and here that buys something specific beyond consistency: arriving
 * as a command restarts the awake window. Without it a user who set the
 * interval from the app could watch the board sleep in their face a second
 * later, having just been told the request succeeded.
 */
static void action_set_sleep_seconds(uint32_t seconds)
{
    /* One gate for every writer — the setup form, NVS and this — so there is
     * one answer to "what does 5 seconds mean" rather than three. Zero survives
     * it unchanged, because zero is not a short interval, it is "nobody said". */
    const uint32_t v = prov_clamp_sleep_seconds(seconds);

    state_lock();
    s_cfg.sleep_seconds = v;
    state_unlock();

    if (!prov_store_save(&s_cfg)) {
        ESP_LOGW(TAG, "sleep interval: NVS save failed (will not survive a cold boot)");
    }

    /* And into RTC memory, which is what the quiet path reads. A wake that
     * changes nothing never touches NVS at all — that is most of the point of
     * it — so without this line the new interval would not take effect until
     * something else forced a cold boot.
     *
     * The resolved figure rather than the raw one: this field means "the
     * interval in force", and UNSET is an instruction, not an interval. */
    power_state()->sleep_seconds = v ? v : power_default_sleep_seconds();

    ESP_LOGI(TAG, "sleep interval set to %us%s", (unsigned)power_state()->sleep_seconds,
             v ? "" : " (the build-time default)");
}

static void action_display_test(void)
{
    ESP_LOGI(TAG, "e-Paper self-test starting");
    epd6_selftest();
    /* The self-test drew straight into the framebuffer behind LVGL's back, so
     * force a full redraw rather than leaving the panel white. */
    Lvgl_InvalidateAll();
    present_full();
    ESP_LOGI(TAG, "e-Paper self-test done (refresh %d ms)", epd6_last_refresh_ms());
}

/* KEY2 held FORCE_AP_HOLD_MS: set the one-shot force-portal flag, show a
 * confirmation, and reboot into Wi-Fi setup. The saved config is kept so the
 * portal pre-fills. Does not return. */
static void force_ap_mode(void)
{
    ESP_LOGW(TAG, "KEY2 long-press -> forcing Wi-Fi setup (AP) mode");
    prov_store_set_force_portal();
    if (Lvgl_lock(-1)) {
        ui_news_set_overlay(S_WIFI_TITLE, NULL, S_RESTARTING);
        Lvgl_unlock();
    }
    present_full();
    vTaskDelay(pdMS_TO_TICKS(500));
    esp_restart();
}

/*
 * The escape hatch, at boot. See user_app.h for why it had to move here.
 *
 * It cannot use buttons_is_pressed(): that reads a pin table buttons_init()
 * fills, and buttons_init() runs in UserApp_TaskInit, which is the far side of
 * a Wi-Fi connect and a UI build from here. So it configures the one pin it
 * needs and samples it directly — the pins arrive as data, as everywhere else
 * in this component, so the pinout is still stated only in user_config.h.
 *
 * Nor can it use force_ap_mode(): there is no LVGL screen yet to draw the
 * confirmation on, and no need to restart either. This runs before
 * provisioning_run() consumes the flag, so setting it here brings the portal up
 * on this boot instead of the next one — the user gets the setup sheet about
 * twenty seconds sooner and the board saves a boot.
 */
bool user_app_check_force_ap_at_boot(const int *btn_gpios, int btn_count)
{
    /* Hand every wake pin back to the digital GPIO matrix first.
     *
     * ext1 wakeup drives these pads through RTC_IO, and the RTC domain is
     * powered across a deep sleep, so the routing outlives the wake that the
     * rest of the chip treats as a fresh boot. A pad still owned by RTC_IO does
     * not answer gpio_get_level(), which would mean this check silently never
     * fires and — worse — that buttons_init() brings up four buttons that never
     * report a press again after the board's first sleep. rtc_gpio_deinit() is
     * a no-op on a pad that was never in RTC mode, so this costs nothing on a
     * board that has not slept and is done here because this is the first thing
     * the boot path calls that knows the pin numbers.
     *
     * Untested on hardware: it is insurance against a documented ESP32-S3
     * behaviour, not a fix for an observed failure. */
    for (int i = 0; i < btn_count; i++) {
        if (btn_gpios[i] >= 0 && rtc_gpio_is_valid_gpio((gpio_num_t)btn_gpios[i])) {
            rtc_gpio_deinit((gpio_num_t)btn_gpios[i]);
        }
    }

    /* Only where a person could plausibly be holding the button: a press woke
     * us, or somebody just powered the board up or pressed reset. A timer wake
     * has nobody in front of it, and polling a pin for five seconds on one
     * would be five seconds of full-power awake time bought for nothing. */
    const power_wake_t wake = power_wake_cause();
    if (wake == POWER_WAKE_TIMER) {
        return false;
    }
    if (!btn_gpios || btn_count <= BUTTON_KEY2 || btn_gpios[BUTTON_KEY2] < 0) {
        return false;
    }

    const gpio_num_t pin = (gpio_num_t)btn_gpios[BUTTON_KEY2];
    gpio_config_t in = {
        .pin_bit_mask = 1ULL << pin,
        .mode         = GPIO_MODE_INPUT,
        .pull_up_en   = GPIO_PULLUP_ENABLE,     /* press-to-GND, so idle is high */
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type    = GPIO_INTR_DISABLE,
    };
    if (gpio_config(&in) != ESP_OK) {
        return false;
    }

    /* A button that is not held costs one poll interval, not five seconds. */
    int waited = 0;
    while (waited < FORCE_AP_HOLD_MS) {
        if (gpio_get_level(pin) != 0) {
            return false;
        }
        vTaskDelay(pdMS_TO_TICKS(HOLD_POLL_MS));
        waited += HOLD_POLL_MS;
    }
    if (gpio_get_level(pin) != 0) {
        return false;
    }

    ESP_LOGW(TAG, "KEY2 held at boot -> forcing Wi-Fi setup (AP) mode");
    prov_store_set_force_portal();
    return true;
}

static void handle_cmd(const app_cmd_t *c)
{
    switch (c->kind) {
    case APP_CMD_SET_PAGE:     action_set_page(c->ival); break;
    case APP_CMD_SET_URL:      action_set_url(c->text); break;
    case APP_CMD_SET_SLEEP:    action_set_sleep_seconds((uint32_t)c->ival); break;
    case APP_CMD_DISPLAY_TEST: action_display_test(); break;
    case APP_CMD_REFRESH_NOW:
        if (s_poll_wake) xSemaphoreGive(s_poll_wake);
        break;
    case APP_CMD_DATA:
        push_data_to_ui();
        present_full();
        break;
    }
}

static void next_page(int delta)
{
    state_lock();
    int page = ((s_page + delta) % UI_PAGE_COUNT + UI_PAGE_COUNT) % UI_PAGE_COUNT;
    state_unlock();
    action_set_page(page);
}

/* Returns true if the button was still held after `ms`. Releases early. */
static bool held_for(button_id_t id, int ms)
{
    int waited = 0;
    while (waited < ms) {
        if (!buttons_is_pressed(id)) return false;
        vTaskDelay(pdMS_TO_TICKS(HOLD_POLL_MS));
        waited += HOLD_POLL_MS;
    }
    return buttons_is_pressed(id);
}

static void handle_press(button_id_t id)
{
    switch (id) {
    case BUTTON_KEY0:
        ESP_LOGI(TAG, "KEY0 -> next page");
        next_page(+1);
        break;
    case BUTTON_KEY1:
        ESP_LOGI(TAG, "KEY1 -> refresh now");
        if (s_poll_wake) xSemaphoreGive(s_poll_wake);
        break;
    case BUTTON_KEY2:
        /* A long press is detected by watching the pin, not by timing two
         * edges: the driver only interrupts on the press, so a release
         * generates no event to time against. */
        if (held_for(BUTTON_KEY2, FORCE_AP_HOLD_MS)) {
            force_ap_mode();               /* reboots — does not return */
        }
        ESP_LOGI(TAG, "KEY2 -> page 1");
        action_set_page(UI_PAGE_FRONT);
        break;
    case BUTTON_BOOT:
        ESP_LOGI(TAG, "BOOT -> previous page");
        next_page(-1);
        break;
    default:
        break;
    }
}

/*
 * Hold the boot's one refresh until there is something worth spending it on.
 *
 * Returns true if UiTask still owes the panel its first page — on a snapshot
 * arriving, or on the wait running out with the demo left to print. False means
 * something else already reached the glass while we waited and there is no
 * first page left to protect.
 */
static bool await_first_snapshot(void)
{
    char url[PROV_URL_MAX_LEN + 1];
    state_lock();
    current_url(url, sizeof(url));
    state_unlock();

    if (!url[0]) {
        return true;        /* demo board: nothing better is ever coming */
    }

    /* esp_timer rather than the tick count: this is a deadline held across
     * several blocking waits, and TickType_t wraps. */
    const int64_t deadline_us =
        esp_timer_get_time() + (int64_t)FIRST_PAINT_WAIT_MS * 1000;

    for (;;) {
        app_cmd_t cmd;
        int64_t left_ms = (deadline_us - esp_timer_get_time()) / 1000;
        if (left_ms <= 0 ||
            xQueueReceive(s_cmd_queue, &cmd, pdMS_TO_TICKS(left_ms)) != pdTRUE) {
            /* Nothing arrived. Whether that is worth a refresh depends entirely
             * on what is already hanging on the glass, and after deep sleep
             * shipped there are two different answers.
             *
             * On a board that has just been switched on, the panel holds
             * whatever the last firmware left there — or nothing — and a
             * complete front page badged DEMO beats a blank sheet.
             *
             * On a board that woke from sleep with RTC state this build wrote,
             * the glass holds a real edition and we know its hash. The snapshot
             * itself did not survive — news_t is 32,952 bytes against 8 KB of
             * RTC memory — so the only page this task could print is the demo,
             * and spending twenty-five seconds to replace a real, correct,
             * merely stale front page with a story about a company the board
             * invented is strictly worse than doing nothing. Leave it alone. */
            if (power_state_valid() && power_state()->content_hash != 0) {
                ESP_LOGW(TAG, "no snapshot within %d ms — leaving the printed "
                              "edition on the glass",
                         FIRST_PAINT_WAIT_MS);
                return false;
            }
            ESP_LOGW(TAG, "no snapshot within %d ms — printing the demo page",
                     FIRST_PAINT_WAIT_MS);
            return true;
        }
        if (cmd.kind == APP_CMD_DATA) {
            return true;
        }
        /* Anything the app asked for in the meantime is still honoured — the
         * control server comes up moments after this task does, so a command
         * landing inside the window is a real user, not a race. But anything
         * that reaches the glass ends the wait: once a page has been printed
         * there is no first refresh left to save. The two kinds that touch no
         * pixels are the ones we can keep waiting after — REFRESH_NOW only
         * pokes NewsTask, and SET_SLEEP only writes NVS — and waiting is
         * exactly what the caller of either wanted. */
        handle_cmd(&cmd);
        if (cmd.kind != APP_CMD_REFRESH_NOW && cmd.kind != APP_CMD_SET_SLEEP) {
            return false;
        }
    }
}

/* --- the awake window ----------------------------------------------------- */

/*
 * How long this board will sleep for, and who decided it.
 *
 * One call, two callers — enter_sleep(), which acts on it, and
 * user_app_snapshot(), which reports it to the companion app. They must agree:
 * a phone told "900 s, from config" by a board that is about to sleep for 120
 * because its desk named a transition is a phone showing a number nobody can
 * act on. So the inputs are assembled here rather than twice.
 *
 * Takes no lock. Everything it reads is RTC memory, which s_mtx does not guard
 * — see the note in user_app_snapshot() — and power_cadence() is pure.
 */
static void effective_cadence(power_cadence_t *out)
{
    const wp_rtc_state_t *rs = power_state();

    power_cadence_in_t in = {};
    in.policy.poll_seconds = rs->poll_seconds;
    in.policy.next_change  = rs->next_change;
    /* The local layer, resolved the way EffectiveSleepSeconds() in main.cpp
     * resolves it: the value carried across the sleep, else the build-time
     * default. NVS is already folded into the first of those by
     * action_set_sleep_seconds() and by the boot path. */
    in.local_seconds       = rs->sleep_seconds ? rs->sleep_seconds
                                               : power_default_sleep_seconds();
    in.now                 = (int64_t)time(NULL);
    in.consecutive_fails   = rs->consecutive_fails;

    power_cadence(&in, out);
}

/*
 * Whether this board is allowed to sleep at all: the same four safety gates
 * power_decide() applies, asked again here because the plan cannot answer this
 * question.
 *
 * power_decide() returns POWER_STAY_AWAKE for two entirely different reasons —
 * "a person pressed a button, so stay reachable for a couple of minutes" and
 * "this board must never sleep" — and the awake window closes only on the
 * first. Anything else would put a board to sleep in the middle of somebody's
 * idf.py monitor session, which is the one failure that makes the feature
 * impossible to debug.
 */
static bool sleeping_permitted(void)
{
    char url[PROV_URL_MAX_LEN + 1];
    state_lock();
    current_url(url, sizeof(url));
    state_unlock();

    return power_deep_sleep_enabled() && board_io_battery_present() &&
           !power_usb_console_attached() && url[0] != '\0';
}

/* Close the window. Does not return. */
static void enter_sleep(void)
{
    wp_rtc_state_t *rs = power_state();

    /* Charged on the way out, so the figure includes everything this wake
     * actually did — the connect, the fetch, the refresh and the window itself.
     * It is one of the two numbers the whole battery estimate rests on and
     * nobody has measured either, so a day on a wall is what turns the design's
     * stated range into an answer. /api/state divides it by `wakes`. */
    rs->awake_ms_total += (uint32_t)(esp_timer_get_time() / 1000);

    /*
     * What this boot actually achieved, which is not what it set out to do.
     *
     * A timer wake reaches the full path only because the quiet path found new
     * content, and power_decide() has already returned REFRESH_THEN_SLEEP for
     * it — but that is a decision, not a page. Everything after it can still
     * fail: NewsTask's own fetch can land on a socket the desk closed in the
     * second between the two requests, await_first_snapshot() times out, and
     * UiTask deliberately leaves the old edition on the glass rather than
     * replacing a real front page with the demo one. Nothing printed. Before
     * this block the counter said zero, the board slept at full cadence, and
     * it did the same thing again every fifteen minutes for as long as the desk
     * stayed down — every log line agreeing that it was fine.
     *
     * So: printed clears it, and a timer wake that printed nothing counts as
     * the failed poll it was. Gated on TIMER because a BUTTON wake is a person
     * standing in front of the frame — they pressed something, nothing was due
     * to print, and counting that as a failure would back the board off for
     * being looked at. Saturating for the reason power_decide() saturates: a
     * wrap to zero looks exactly like a recovery.
     */
    if (s_printed) {
        rs->consecutive_fails = 0;
    } else if (power_wake_cause() == POWER_WAKE_TIMER &&
               rs->consecutive_fails < UINT16_MAX) {
        rs->consecutive_fails++;
    }

    /* And the cadence, computed AFTER the accounting above, because the fail
     * count is one of its inputs — a wake that printed nothing has just earned
     * the longer sleep the curve gives it. */
    power_cadence_t cad;
    effective_cadence(&cad);

    ESP_LOGI(TAG, "awake window closed — sleeping %us from %s (printed %s, fails %u)",
             (unsigned)cad.seconds,
             cad.source == POWER_CADENCE_POLICY        ? "policy"
             : cad.source == POWER_CADENCE_NEXT_CHANGE ? "next_change"
                                                       : "local",
             s_printed ? "yes" : "no", (unsigned)rs->consecutive_fails);
    power_sleep(cad.seconds, s_btn_gpios, s_btn_count);
}

/*
 * UiTask — the only task that touches LVGL or the panel. Blocks on buttons OR
 * app commands, and wakes every TICK_SECONDS to keep the clock and battery
 * current.
 */
static void UiTask(void *arg)
{
    (void)arg;
    ESP_LOGI(TAG, "controls: KEY0 = page, KEY1 = refresh, KEY2 = page 1 (5s hold = Wi-Fi setup)");

    /* The demo snapshot is loaded now but not necessarily printed. It is what
     * the companion app reads before the first poll lands, what action_set_url
     * falls back to, and the whole configuration of a board with no URL — but
     * on a configured board it is a page we already know is about to be
     * superseded, and this panel charges twenty-five seconds to say so. */
    state_lock();
    if (!s_data.valid) {
        news_mock(&s_data);
        s_data_hash = news_hash(&s_data);
    }
    state_unlock();

    /* Draw the page before the wait, not after it. What await_first_snapshot()
     * defers is the REFRESH; it still honours commands while it waits, and
     * those go straight to present_full() with whatever the widgets are
     * holding. Populating them here is what makes that "the demo page" rather
     * than a sheet of furniture with no news in it. */
    restate_page();
    if (Lvgl_lock(-1)) {
        ui_news_show_page(UI_PAGE_FRONT);
        Lvgl_unlock();
    }

    if (await_first_snapshot()) {
        restate_page();     /* the snapshot that ended the wait, or the demo */
        present_full();
    }

    /*
     * How long this boot stays up before it sleeps, and it is three answers
     * rather than two.
     *
     * A board a safety gate protects never sleeps: no cell fitted, a USB
     * console attached, sleep switched off, or no URL to poll. deadline_us
     * stays zero and the loop below is exactly the loop this file has always
     * run. That is what keeps `idf.py monitor` usable and it is why the gates
     * are asked here and not inferred from the plan — power_decide() answers
     * POWER_STAY_AWAKE for "a person pressed a button" and for "this board must
     * never sleep", and only one of those has a window that closes.
     *
     * A BUTTON or COLD wake has a person in front of the frame — they pressed
     * something, or they just plugged it in — so it stays reachable for the
     * configured window. The companion app cannot discover the board, connect
     * and issue a request inside the three seconds a timer wake lives for.
     * About 2.8 mAh, and only when somebody is actually there.
     *
     * A TIMER wake that got this far is the CHANGED case: it woke, found a new
     * edition, and is here only to print it. Nobody is watching, so the window
     * is zero and it sleeps as soon as the page is on the paper. Giving it the
     * full two minutes would cost 2.8 mAh on every content change, which is
     * about a third of the daily budget spent waiting for a visitor who is not
     * coming.
     */
    const power_wake_t wake = power_wake_cause();
    const int64_t window_us =
        (wake == POWER_WAKE_TIMER) ? 0
                                   : (int64_t)power_awake_window_seconds() * 1000000;
    int64_t deadline_us = sleeping_permitted() ? esp_timer_get_time() + window_us : 0;
    if (deadline_us) {
        ESP_LOGI(TAG, "staying reachable for %us before sleeping",
                 (unsigned)(window_us / 1000000));
    }

    for (;;) {
        /* Wait no longer than whichever comes first, the idle tick or the end
         * of the window. esp_timer rather than the tick count because this
         * deadline is held across many waits and TickType_t wraps. */
        int64_t wait_ms = TICK_SECONDS * 1000;
        if (deadline_us) {
            const int64_t left_ms = (deadline_us - esp_timer_get_time()) / 1000;
            if (left_ms <= 0) {
                enter_sleep();          /* does not return */
            }
            if (left_ms < wait_ms) {
                wait_ms = left_ms;
            }
        }

        QueueSetMemberHandle_t member =
            xQueueSelectFromSet(s_queue_set, pdMS_TO_TICKS(wait_ms));

        if (member == s_btn_queue) {
            button_event_t ev;
            if (xQueueReceive(s_btn_queue, &ev, 0) == pdTRUE) {
                /* Restart the window on anything a person did. Cutting someone
                 * off two minutes into reading their own board because the
                 * clock ran out mid-interaction is the behaviour that would get
                 * the whole feature turned off. */
                if (deadline_us) deadline_us = esp_timer_get_time() + window_us;
                handle_press(ev.id);
            }
        } else if (member == s_cmd_queue) {
            app_cmd_t cmd;
            if (xQueueReceive(s_cmd_queue, &cmd, 0) == pdTRUE) {
                /*
                 * A POLL ARRIVING IS NOT SOMEBODY STANDING THERE.
                 *
                 * The two are indistinguishable at the queue — one app_cmd_t
                 * among others — and that is exactly why this needs saying. The
                 * window exists for one reason: a person is in front of the
                 * frame and the companion app cannot win a race against a
                 * three-second wake. Only a person may extend it. Every other
                 * command here came from a phone, which is a person; APP_CMD_DATA
                 * came from NewsTask, which is the board talking to itself.
                 *
                 * Letting it extend the window is not a theoretical leak, it is
                 * the failure tools/edition/PROMPT.md now warns producers about,
                 * arriving from the other side. A producer that stamps
                 * generated_at with the moment it filed moves the content
                 * fingerprint on every poll, so APP_CMD_DATA lands every
                 * POLL_SECONDS — sixty by default — and resets a hundred-and-
                 * twenty-second window before it can ever expire. The board
                 * never sleeps again. It sits at 81 mA refreshing every minute,
                 * and every log line on both sides reads healthy: the producer
                 * is filing, the board is printing what it was sent.
                 *
                 * There is deliberately no absolute cap on top of this. Someone
                 * genuinely setting a board up may take ten minutes, and cutting
                 * them off would be a worse bug than the one this prevents.
                 */
                if (deadline_us && cmd.kind != APP_CMD_DATA) {
                    deadline_us = esp_timer_get_time() + window_us;
                }
                handle_cmd(&cmd);
            }
        } else {
            /* Idle tick: move the clock and the battery reading on in the
             * framebuffer. Deliberately no refresh — see TICK_SECONDS. The next
             * poll that actually changes the page carries these out with it.
             *
             * This does NOT restart the window: it is the board talking to
             * itself, and a timer that only ever resets itself never expires. */
            read_battery();
            if (Lvgl_lock(-1)) {
                ui_news_tick();
                Lvgl_unlock();
            }
        }
    }
}

/*
 * NewsTask — polls the configured URL, and pokes UiTask only when the content
 * it got back differs from what is already on the glass. Never touches LVGL or
 * the panel itself, so a stalled HTTP request cannot hold up a refresh.
 */
static void notify_ui(app_cmd_kind_t kind)
{
    if (!s_cmd_queue) {
        return;
    }
    app_cmd_t c;
    memset(&c, 0, sizeof(c));
    c.kind = kind;
    xQueueSend(s_cmd_queue, &c, 0);
}

/* Static for the same reason as s_ui_copy: 33 KB against a 16 KB stack that an
 * https:// URL also has to fit a synchronous TLS handshake into. NewsTask is the
 * only caller. */
static news_t s_fetched;

static void NewsTask(void *arg)
{
    (void)arg;
    /* No settle delay. This task is only ever created once the board has an IP
     * — from provisioning_run() on a cold boot, or from
     * provisioning_connect_only() when the quiet path found changed content and
     * fell through — and an acquired IP is what both of those return true on.
     * The stack is not "settling", it is up. The three seconds this used to wait
     * were three seconds UiTask spent holding a blank panel. If the first fetch
     * does lose a race with something, the retry below costs less than the wait
     * did. */
    int fast_retries = 0;      /* spent inside the first-paint window only */

    for (;;) {
        char url[PROV_URL_MAX_LEN + 1];
        state_lock();
        current_url(url, sizeof(url));
        state_unlock();

        if (url[0]) {
            /* The lead's photograph is fetched from beside the snapshot, and
             * this is the task that owns the wire. Saying so every poll is also
             * what gives a tile that could not be fetched last time its next
             * chance — the alternative is UiTask discovering the miss mid-render
             * and doing a blocking GET of its own between two panel refreshes. */
            ui_tile_set_base(url);

            /* Conditional on the tag of what THIS TASK last parsed, and not on
             * the one in RTC memory naming what is on the glass. The two are
             * equal for most of a session, and the moment they are not is the
             * one that matters: s_data_etag is empty at boot, so the first poll
             * of every boot is unconditional and real content always arrives.
             *
             * Sending the RTC tag instead would earn a 304 on that first poll —
             * correct about the glass, and a disaster here, because this task
             * would have nothing to hand UiTask, await_first_snapshot() would
             * time out, and the demo page would be printed over a perfectly
             * good front page. */
            char etag[HTTP_ETAG_MAX] = "";
            state_lock();
            char if_none_match[HTTP_ETAG_MAX];
            strlcpy(if_none_match, s_data_etag, sizeof(if_none_match));
            state_unlock();

            news_fetch_result_t r = news_service_fetch_cond(
                url, if_none_match, &s_fetched, etag, sizeof(etag));

            state_lock();
            s_last_result = r;
            state_unlock();

            if (r == NEWS_FETCH_OK) {
                uint32_t h = news_hash(&s_fetched);

                state_lock();
                bool changed = (h != s_data_hash);
                if (changed) {
                    s_data      = s_fetched;
                    s_data_hash = h;
                }
                /* The tag is stored whether or not the content moved, because
                 * its invariant is about s_data and not about the change: a 200
                 * that hashes the same is the same page under a new tag (a
                 * producer touching a field the sheet does not render moves the
                 * tag and not the hash), and that new tag still names a document
                 * parsing to exactly s_data. It reaches RTC memory only through
                 * present_full(), so a tag learned here can never get ahead of a
                 * refresh that has not happened. */
                strlcpy(s_data_etag, etag, sizeof(s_data_etag));
                s_last_ok_us = esp_timer_get_time();
                s_online     = true;

                /* The policy is adopted from every successful fetch, INCLUDING
                 * one whose content was unchanged. It is not part of the page —
                 * news_hash() deliberately cannot see it — so `changed` says
                 * nothing about whether the cadence moved, and a board that only
                 * read the block on the polls that happened to bring a new
                 * edition would miss every quiet window that began on a quiet
                 * day. That is precisely the case the block exists for.
                 *
                 * A zero is absent, and absent leaves the last cadence standing
                 * rather than reverting to the compiled-in one. The two are not
                 * the same statement: a payload with no policy is a server
                 * saying nothing about cadence, and the failure of guessing
                 * wrong is asymmetric — reverting would multiply the request
                 * rate by sixty the first time a caching layer served a copy
                 * with the block stripped. `next_change` is different and is
                 * taken as it comes: it is an instant, and a stale one is worse
                 * than none. */
                if (s_fetched.policy.poll_seconds != 0) {
                    s_poll_seconds     = s_fetched.policy.poll_seconds;
                    s_poll_from_policy = true;
                }
                s_next_change = s_fetched.policy.next_change;

                /* And into RTC memory, by the same rule, so a board that sleeps
                 * after this boot sleeps on what the desk said rather than on
                 * the local interval. The quiet path publishes it too — this is
                 * the other adoption site, for a full boot, whose fetch the
                 * quiet path never made. */
                power_state()->next_change = s_fetched.policy.next_change;
                if (s_fetched.policy.poll_seconds != 0) {
                    power_state()->poll_seconds =
                        (uint32_t)s_fetched.policy.poll_seconds;
                }
                state_unlock();

                if (changed) {
                    const news_story_t *lead = lead_story(&s_fetched);
                    /* Every picture, before UiTask is told rather than after.
                     * The pictures are part of the page and a tile that lands
                     * during the render is a page that refreshes twice for one
                     * snapshot — fifty seconds of flashing for one edition. A
                     * miss is silent on purpose: the module reflows without it.
                     *
                     * All of them, not just the lead's. The composed front page
                     * carries a photograph across the top and two more in the
                     * box at its foot, and fetching the two thumbs lazily at
                     * render time is the same double refresh with extra steps.
                     * The cache holds them all at once (ui_tile.h, UI_TILE_SLOTS). */
                    for (int i = 0; i < s_fetched.story_count; i++) {
                        const news_photo_t *p = &s_fetched.stories[i].photo;
                        if (p->id[0]) ui_tile_get(p->id, p->w, p->h);
                    }
                    for (int i = 0; i < s_fetched.thumb_count; i++) {
                        const news_photo_t *p = &s_fetched.thumbs[i];
                        if (p->id[0]) ui_tile_get(p->id, p->w, p->h);
                    }
                    ESP_LOGI(TAG,
                             "news: %s — %d stories, %d figures, %d briefs, lead \"%s\" — refreshing",
                             s_fetched.subject.symbol[0] ? s_fetched.subject.symbol : "(no symbol)",
                             s_fetched.story_count, s_fetched.figure_count,
                             s_fetched.brief_count,
                             (lead && lead->headline[0]) ? lead->headline : "(none)");
                    notify_ui(APP_CMD_DATA);
                } else {
                    /* The single most common outcome, and the one that must not
                     * cost a panel refresh. */
                    ESP_LOGD(TAG, "news: unchanged, panel untouched");
                }
            } else if (r == NEWS_FETCH_NOT_MODIFIED) {
                /* The server confirmed the document has not changed. That is a
                 * successful poll, not an outage: the tag matched, so the page
                 * already on the glass is the current one. It belongs here
                 * rather than in the failure arm below because everything there
                 * is wrong about it — s_last_ok_us would age until the sheet
                 * badged itself STALE while the board was working perfectly,
                 * and the log would carry a warning a reader would go looking
                 * for a cause of. The panel is untouched, as on any unchanged
                 * poll: news_hash() remains the sole authority on a refresh and
                 * there is nothing new to hash. */
                state_lock();
                s_last_ok_us = esp_timer_get_time();
                s_online     = true;
                state_unlock();
                ESP_LOGD(TAG, "news: 304 not modified, panel untouched");
            } else {
                state_lock();
                s_online = (r != NEWS_FETCH_TRANSPORT);
                state_unlock();
                ESP_LOGW(TAG, "news fetch failed: %s", news_fetch_result_name(r));
            }
        }

        /* Every GET this cycle had to make is made. Let the connection go rather
         * than carrying it across the wait below: a minute is longer than any
         * server keeps an idle socket — the mock server closes at thirty seconds —
         * so holding it saves no handshake and merely guarantees the next poll
         * writes its request into a socket the peer already closed. The
         * first-paint retry below waits three seconds rather than a minute, and
         * releasing is still right there: that path is reached only after a fetch
         * that failed, whose connection is the one thing that cannot be trusted. */
        http_port_release();

        /* A board that has not yet fetched anything tries again in seconds
         * rather than after a full interval, for the first few attempts only.
         * The cases that reach here are a first fetch that lost a race with the
         * network coming up and a server that is not listening yet, and both
         * are usually over within seconds — while UiTask is holding the boot's
         * one refresh open for FIRST_PAINT_WAIT_MS, so a full interval here
         * would guarantee it times out and prints the demo page for a server
         * that was about to answer. Past that window a retry can no longer
         * change which page got printed, so there is nothing left to buy. */
        /* How long until the next poll — the same function a sleeping board
         * asks, and that is the point of it being a function. An awake board
         * and a sleeping one obeying two different readings of one policy block
         * is a fault nobody would ever look for, because both of them work.
         *
         * `poll_seconds` is passed only when the desk actually said it:
         * s_poll_seconds falls back to the compiled-in default, which is the
         * LOCAL layer here and must not masquerade as the desk's answer, or
         * `sleepSource` on the companion app would read "policy" for a board no
         * desk has ever spoken to.
         *
         * And no backoff: `fails` is zero because the awake path badges the
         * sheet STALE and OFFLINE rather than slowing down. Someone is looking
         * at this board; slowing its recovery is the opposite of what they
         * want, and the badge is what tells them. */
        power_cadence_in_t pc = {};
        state_lock();
        pc.policy.poll_seconds = s_poll_from_policy ? (uint32_t)s_poll_seconds : 0u;
        pc.policy.next_change  = s_next_change;
        bool never_fetched     = (s_last_ok_us == 0);
        state_unlock();
        pc.local_seconds       = POLL_SECONDS_DEFAULT;
        pc.now                 = (int64_t)time(NULL);
        pc.consecutive_fails   = 0;

        power_cadence_t pcad;
        power_cadence(&pc, &pcad);
        int wait_s = (int)pcad.seconds;

        if (never_fetched && fast_retries < FIRST_RETRY_MAX) {
            fast_retries++;
            wait_s = FIRST_RETRY_SECONDS;
        }

        /* Woken early by KEY1, by POST /api/refresh, or by a URL change. */
        xSemaphoreTake(s_poll_wake, pdMS_TO_TICKS(wait_s * 1000));
    }
}

void UserApp_TaskInit(const prov_config_t *cfg, const int *btn_gpios, int btn_count)
{
    s_cfg = *cfg;

    s_mtx       = xSemaphoreCreateMutex();
    s_poll_wake = xSemaphoreCreateBinary();
    s_btn_queue = xQueueCreate(16, sizeof(button_event_t));
    s_cmd_queue = xQueueCreate(8, sizeof(app_cmd_t));
    /* A queue set lets UiTask block on buttons OR app commands in one wait.
     * Both queues must be empty when added, so build the set before
     * buttons_init starts posting. */
    s_queue_set = xQueueCreateSet(16 + 8);
    xQueueAddToSet(s_btn_queue, s_queue_set);
    xQueueAddToSet(s_cmd_queue, s_queue_set);

    /* Anything the caller did not supply is disabled rather than left as
     * whatever was on the stack — a stray GPIO number here would attach an
     * interrupt to a pin the panel is using. */
    int gpios[BUTTON_COUNT];
    for (int i = 0; i < BUTTON_COUNT; i++) {
        gpios[i] = (btn_gpios && i < btn_count) ? btn_gpios[i] : -1;
    }
    buttons_init(s_btn_queue, gpios);

    /* Kept for the sleep path: these are also the ext1 wake sources, and a
     * board that sleeps without arming them is one only the timer can reach. */
    memcpy(s_btn_gpios, gpios, sizeof(s_btn_gpios));
    s_btn_count = BUTTON_COUNT;

    /* Create the global TLS-connect gate before any task can call http_get(). */
    http_port_init();

    /* UiTask does no networking, so it needs only a modest stack — the LVGL
     * render itself runs on the LVGL task. Higher priority so a button press is
     * handled the instant it arrives. */
    xTaskCreatePinnedToCore(UiTask, "ui", 8 * 1024, NULL, 4, NULL, 1);

    /* NewsTask: the JSON is small, but a TLS handshake and cert-bundle
     * validation would run on THIS task's stack (esp_http_client is
     * synchronous) if the user points it at an https:// URL. 16KB is the size
     * that proved stable for the TLS tasks in the firmware this forked from. */
    xTaskCreatePinnedToCore(NewsTask, "news", 16 * 1024, NULL, 2, NULL, 1);
}

/* ===========================================================================
 * Companion-app control bridge (declared in user_app_api.h). These run on the
 * HTTP server task: the read copies state under s_mtx; the writes post a
 * command for UiTask to apply via the same paths as a button press. All are
 * safe no-ops until UserApp_TaskInit has created the queues.
 * =========================================================================== */

/* user_app_snapshot copies the tape and the headlines straight across, indexing
 * out->indices[] and out->stories[] with news_t's own counts. The capacities are
 * declared in different headers on purpose — one is portable to a phone, the
 * other to the panel — and device_api_model.h states their equality only in a
 * comment. This is where those comments are made to hold, because the
 * alternative to a build failure is a write past the end of the caller's struct
 * with a count the network chose the size of.
 *
 * There is deliberately no DEV_FIGURE_MAX to assert against: the dossier does
 * not travel to the app, only `figure_count` does. If you are here because you
 * added the figures back, add the assert with them. */
static_assert(DEV_INDEX_MAX == NEWS_INDEX_MAX,
              "the companion API's index array must hold the whole tape");
static_assert(DEV_STORY_MAX == NEWS_STORIES_MAX,
              "the companion API's story array must hold every headline the sheet set");

static bool post_cmd(app_cmd_kind_t kind, int ival, const char *text)
{
    if (!s_cmd_queue) {
        return false;
    }
    app_cmd_t c;
    memset(&c, 0, sizeof(c));
    c.kind = kind;
    c.ival = ival;
    if (text) {
        strlcpy(c.text, text, sizeof(c.text));
    }
    return xQueueSend(s_cmd_queue, &c, 0) == pdTRUE;
}

void user_app_snapshot(device_state_t *out)
{
    memset(out, 0, sizeof(*out));
    strlcpy(out->model, DEVICE_MODEL, sizeof(out->model));
    strlcpy(out->fw, DEVICE_FW, sizeof(out->fw));
    /* The compiled-in cadence, which is also the honest answer before TaskInit
     * has run: nothing has polled, so nothing has been told otherwise. Both are
     * overwritten with the live figures under the lock below. */
    out->poll_seconds       = POLL_SECONDS_DEFAULT;
    out->poll_from_policy   = false;
    out->refresh_ms         = epd6_last_refresh_ms();
    if (!s_mtx) {
        return;                     /* TaskInit has not run yet */
    }

    state_lock();
    out->page = s_page;
    strlcpy(out->page_title, ui_news_page_title((ui_page_t)s_page), sizeof(out->page_title));

    out->news_valid = s_data.valid;
    out->demo       = s_data.demo;
    strlcpy(out->edition, s_data.edition, sizeof(out->edition));
    strlcpy(out->generated_at, s_data.generated_at, sizeof(out->generated_at));

    /* The company the edition is about. Cents and basis points cross as they
     * are: the app owns its own decimal separator and its own sign colour, and
     * deciding either of them here as well is how the phone and the panel come
     * to disagree about a price they were both given the same integer for. */
    news_str_copy(out->subject.symbol,   sizeof(out->subject.symbol),   s_data.subject.symbol);
    news_str_copy(out->subject.name,     sizeof(out->subject.name),     s_data.subject.name);
    news_str_copy(out->subject.exchange, sizeof(out->subject.exchange), s_data.subject.exchange);
    news_str_copy(out->subject.sector,   sizeof(out->subject.sector),   s_data.subject.sector);
    out->subject.last_c       = s_data.subject.last_c;
    out->subject.chg_bp       = s_data.subject.chg_bp;
    out->subject.prev_close_c = s_data.subject.prev_close_c;
    out->subject.open_c       = s_data.subject.open_c;
    out->subject.high_c       = s_data.subject.high_c;
    out->subject.low_c        = s_data.subject.low_c;
    out->subject.wk52_hi_c    = s_data.subject.wk52_hi_c;
    out->subject.wk52_lo_c    = s_data.subject.wk52_lo_c;

    /* The headlines, in the device's own order — the parser sorted them, so
     * stories[0] is what leads the sheet, and a phone list that re-sorts by
     * `rank` lands on the same order the reader is looking at.
     *
     * news_str_copy rather than strlcpy because the cut to DEV_HEADLINE_MAXLEN
     * lands mid-word by definition and headlines arrive from a copy desk that
     * emits em dashes and curly quotes — strlcpy would happily halve one, and
     * half a codepoint is not a short headline, it is a JSON string the app's
     * parser rejects. */
    out->story_count = s_data.story_count;
    for (int i = 0; i < out->story_count; i++) {
        out->stories[i].rank = s_data.stories[i].rank;
        news_str_copy(out->stories[i].headline, sizeof(out->stories[i].headline),
                      s_data.stories[i].headline);
    }

    /* The rest of the edition as counts alone. What the app needs is whether the
     * board RECEIVED them — the difference between a producer that filed a thin
     * day and a parser that dropped something — and these are the counts after
     * parsing, so they are also how a producer finds out its forty figures
     * became twenty-eight. The figures themselves do not travel; the dossier is
     * what the paper is for, and a reader who wants it is standing in front of
     * it. If one is ever needed on a phone it gets its own endpoint rather than
     * sixteen kilobytes of .bss for the life of the board. */
    out->figure_count = s_data.figure_count;
    out->brief_count  = s_data.brief_count;
    out->peer_count   = s_data.peer_count;
    out->table_count  = s_data.table_count;
    out->chart_count  = s_data.chart_count;
    out->thumb_count  = s_data.thumb_count;

    out->index_count = s_data.index_count;
    for (int i = 0; i < out->index_count; i++) {
        news_str_copy(out->indices[i].symbol, sizeof(out->indices[i].symbol),
                      s_data.indices[i].symbol);
        out->indices[i].last_c = s_data.indices[i].last_c;
        out->indices[i].chg_bp = s_data.indices[i].chg_bp;
    }

    strlcpy(out->news_url, s_cfg.news_url, sizeof(out->news_url));
    strlcpy(out->last_result, news_fetch_result_name(s_last_result), sizeof(out->last_result));

    /* The EFFECTIVE cadence, and where it came from. Both, because the number
     * alone cannot be acted on: a board reporting 3,600 has either been put on
     * an hourly poll by its desk or been built with an hour in Kconfig, and the
     * first is a quiet window that ends while the second is a firmware image
     * that needs reflashing. */
    out->poll_seconds     = s_poll_seconds;
    out->poll_from_policy = s_poll_from_policy;

    if (s_last_ok_us != 0) {
        out->age_seconds = (int)((esp_timer_get_time() - s_last_ok_us) / 1000000);
        out->stale = out->age_seconds > stale_seconds_locked();
    } else {
        out->age_seconds = -1;      /* never succeeded — not "zero seconds ago" */
        out->stale = s_cfg.news_url[0] != '\0';
    }

    out->battery_present = s_batt_present;
    out->battery_pct     = s_batt_pct;
    out->battery_mv      = s_batt_mv;
    state_unlock();

    /* The counters, copied with no arithmetic in the copy — device_api_json.c
     * derives the mean and the daily estimate, because it is the half of this
     * that has a host test and both of its divisors are legitimately zero on a
     * board that has not slept yet.
     *
     * READ WITHOUT s_mtx, deliberately. Three reasons, and the third is the one
     * that decides it:
     *
     * 1. They are not s_mtx's state. That lock guards things with invariants
     *    BETWEEN fields — s_data against s_data_hash, s_last_ok_us against
     *    s_last_result — and taking a lock over data it does not own would
     *    imply a relationship these fields do not have.
     * 2. Each is one naturally-aligned 32-bit word, so an LX7 load cannot tear
     *    one. The worst a race can produce is a value one wake out of date, and
     *    "out of date" is the normal condition of every counter here anyway:
     *    the document is a sample of a board that keeps running.
     * 3. Nothing downstream needs them to agree with each other. `wakes` and
     *    `awake_ms_total` are divided into a mean by the serialiser, and a mean
     *    computed across a wake boundary is off by one wake in a figure whose
     *    whole purpose is to replace a range of 190-to-260 days with a
     *    measurement. If that mattered the fix would be a snapshot in RTC
     *    memory, not this lock. */
    const wp_rtc_state_t *rs = power_state();
    out->deep_sleep     = power_deep_sleep_enabled();

    /* The EFFECTIVE interval — what this board will actually do when the window
     * closes — and not the local setting it was built or configured with. The
     * two differ whenever the desk has said anything, which on a board reading
     * a desk is most of the time. Reporting the setting instead would have a
     * phone show 900 s beside a board sleeping for 3,600 because its desk is in
     * its quiet window, which is a number the reader cannot act on and cannot
     * tell is wrong. */
    power_cadence_t cad;
    effective_cadence(&cad);
    out->sleep_seconds  = (int)cad.seconds;
    out->wakes          = (int)rs->wakes;
    out->quiet_wakes    = (int)rs->quiet_wakes;
    out->awake_ms_total = (int)rs->awake_ms_total;
}

bool user_app_set_page(int page)
{
    if (page < 0 || page >= UI_PAGE_COUNT) {
        return false;
    }
    return post_cmd(APP_CMD_SET_PAGE, page, NULL);
}

bool user_app_refresh_now(void)
{
    return post_cmd(APP_CMD_REFRESH_NOW, 0, NULL);
}

bool user_app_set_news_url(const char *url)
{
    if (!url || !prov_validate_news_url(url)) {
        return false;
    }
    return post_cmd(APP_CMD_SET_URL, 0, url);
}

bool user_app_display_test(void)
{
    return post_cmd(APP_CMD_DISPLAY_TEST, 0, NULL);
}

bool user_app_set_sleep_seconds(uint32_t seconds)
{
    /* Narrowed here rather than in the queue: app_cmd_t carries an int, and
     * every value that survives prov_clamp_sleep_seconds() is at most 86,400.
     * Clamping to INT_MAX first means a hostile or confused caller cannot turn
     * a huge unsigned into a negative one on the way through. */
    if (seconds > (uint32_t)INT_MAX) {
        seconds = (uint32_t)INT_MAX;
    }
    return post_cmd(APP_CMD_SET_SLEEP, (int)seconds, NULL);
}
