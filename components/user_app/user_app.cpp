/*
 * user_app.cpp — app orchestration for the WP News board.
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
#include "prov_store.h"
#include "prov_config.h"

static const char *TAG = "app";
static lv_obj_t   *s_screen;

/* The provisioned config, copied so it outlives app_main's stack. */
static prov_config_t s_cfg;

/* --- cadences ------------------------------------------------------------ */

#ifndef CONFIG_WP_NEWS_POLL_SECONDS
#define CONFIG_WP_NEWS_POLL_SECONDS 300
#endif
#ifndef CONFIG_WP_NEWS_FEED_URL
#define CONFIG_WP_NEWS_FEED_URL ""
#endif

#define POLL_SECONDS       CONFIG_WP_NEWS_POLL_SECONDS

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

/* A snapshot older than this many poll intervals gets the "오래됨" badge. Two
 * rather than one: a single missed poll is a laptop closing its lid, not a
 * problem the user needs told about. */
#define STALE_AFTER_POLLS    2

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
}

/* --- presenting (UiTask only) --------------------------------------------- */

/* Render whatever the setters changed, then push one refresh for the lot.
 *
 * There is only one kind of refresh on this panel and it costs twenty to thirty
 * seconds of flashing, so every call here is a decision someone has to have
 * made deliberately. Nothing in this file calls it on a timer. */
static void present_full(void)
{
    Lvgl_RenderNow();
    epd6_refresh();
}

/* --- content updates (UiTask only) ---------------------------------------- */

/* The snapshot is copied out from under the mutex so LVGL is never touched while
 * holding it. The copy is static rather than automatic because news_t is 18 KB
 * — twice the whole of UiTask's 8 KB stack, so an automatic would not overflow
 * it, it would never fit on it — and this frame goes on to call into LVGL, whose
 * render (Lvgl_RenderNow -> lv_refr_now) runs on this same task. A static is safe
 * here precisely because of the rule the whole file is built on: UiTask is the
 * only caller. */
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
        st.stale = age_us > (int64_t)POLL_SECONDS * STALE_AFTER_POLLS * 1000000;
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
    /* Clearing the URL means "go back to the demo screen", and it has to happen
     * here rather than by waiting for a poll — with no URL there is no poll, so
     * the board would otherwise sit on the last real snapshot indefinitely and
     * then quietly badge it 오래됨, which is the opposite of what was asked. */
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

static void handle_cmd(const app_cmd_t *c)
{
    switch (c->kind) {
    case APP_CMD_SET_PAGE:     action_set_page(c->ival); break;
    case APP_CMD_SET_URL:      action_set_url(c->text); break;
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
 * UiTask — the only task that touches LVGL or the panel. Blocks on buttons OR
 * app commands, and wakes every TICK_SECONDS to keep the clock and battery
 * current.
 */
static void UiTask(void *arg)
{
    (void)arg;
    ESP_LOGI(TAG, "controls: KEY0 = page, KEY1 = refresh, KEY2 = page 1 (5s hold = Wi-Fi setup)");

    /* The demo snapshot goes up immediately rather than after the first poll:
     * a board that shows a finished screen one second after boot and then
     * quietly replaces it with real data reads as fast, where a board that
     * shows "불러오는 중" for eight seconds reads as broken. */
    state_lock();
    if (!s_data.valid) {
        news_mock(&s_data);
        s_data_hash = news_hash(&s_data);
    }
    state_unlock();

    read_battery();
    push_data_to_ui();
    if (Lvgl_lock(-1)) {
        ui_news_tick();
        ui_news_show_page(UI_PAGE_FRONT);
        Lvgl_unlock();
    }
    present_full();

    for (;;) {
        QueueSetMemberHandle_t member =
            xQueueSelectFromSet(s_queue_set, pdMS_TO_TICKS(TICK_SECONDS * 1000));

        if (member == s_btn_queue) {
            button_event_t ev;
            if (xQueueReceive(s_btn_queue, &ev, 0) == pdTRUE) {
                handle_press(ev.id);
            }
        } else if (member == s_cmd_queue) {
            app_cmd_t cmd;
            if (xQueueReceive(s_cmd_queue, &cmd, 0) == pdTRUE) {
                handle_cmd(&cmd);
            }
        } else {
            /* Idle tick: move the clock and the battery reading on in the
             * framebuffer. Deliberately no refresh — see TICK_SECONDS. The next
             * poll that actually changes the page carries these out with it. */
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

/* Static for the same reason as s_ui_copy: 18 KB against a 16 KB stack that an
 * https:// URL also has to fit a synchronous TLS handshake into. NewsTask is the
 * only caller. */
static news_t s_fetched;

static void NewsTask(void *arg)
{
    (void)arg;
    /* Let the WiFi/TLS stack settle before the first request. */
    vTaskDelay(pdMS_TO_TICKS(3000));

    for (;;) {
        char url[PROV_URL_MAX_LEN + 1];
        state_lock();
        strlcpy(url, s_cfg.news_url[0] ? s_cfg.news_url : CONFIG_WP_NEWS_FEED_URL,
                sizeof(url));
        state_unlock();

        if (url[0]) {
            /* The lead's photograph is fetched from beside the snapshot, and
             * this is the task that owns the wire. Saying so every poll is also
             * what gives a tile that could not be fetched last time its next
             * chance — the alternative is UiTask discovering the miss mid-render
             * and doing a blocking GET of its own between two panel refreshes. */
            ui_tile_set_base(url);

            news_fetch_result_t r = news_service_fetch(url, &s_fetched);

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
                s_last_ok_us = esp_timer_get_time();
                s_online     = true;
                state_unlock();

                if (changed) {
                    const news_story_t *lead = lead_story(&s_fetched);
                    /* Before UiTask is told, not after: the picture is part of
                     * the page and a tile that lands during the render is a
                     * page that refreshes twice for one snapshot. A miss is
                     * silent on purpose — the lead reflows to its chart. */
                    if (lead && lead->photo.id[0]) {
                        ui_tile_get(lead->photo.id, lead->photo.w, lead->photo.h);
                    }
                    ESP_LOGI(TAG, "news: %d stories, %d tickers, lead %s — refreshing",
                             s_fetched.story_count, s_fetched.ticker_count,
                             (lead && lead->symbol[0]) ? lead->symbol : "(none)");
                    notify_ui(APP_CMD_DATA);
                } else {
                    /* The single most common outcome, and the one that must not
                     * cost a panel refresh. */
                    ESP_LOGD(TAG, "news: unchanged, panel untouched");
                }
            } else {
                state_lock();
                s_online = (r != NEWS_FETCH_TRANSPORT);
                state_unlock();
                ESP_LOGW(TAG, "news fetch failed: %s", news_fetch_result_name(r));
            }
        }

        /* Woken early by KEY1, by POST /api/refresh, or by a URL change. */
        xSemaphoreTake(s_poll_wake, pdMS_TO_TICKS(POLL_SECONDS * 1000));
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

/* user_app_snapshot copies the index ribbon straight across, indexing
 * out->indices[] with news_t's own count. The two capacities are declared in
 * different headers on purpose — one is portable to a phone, the other to the
 * panel — and device_api_model.h states their equality only in a comment. This
 * is where that comment is made to hold, because the alternative to a build
 * failure is a stack write past the end of the caller's struct. */
static_assert(DEV_INDEX_MAX == NEWS_INDEX_MAX,
              "the companion API's index array must hold the whole ribbon");

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
    out->poll_seconds       = POLL_SECONDS;
    out->refresh_ms         = epd6_last_refresh_ms();
    if (!s_mtx) {
        return;                     /* TaskInit has not run yet */
    }

    state_lock();
    out->page = s_page;
    strlcpy(out->page_title, ui_news_page_title((ui_page_t)s_page), sizeof(out->page_title));

    out->news_valid   = s_data.valid;
    out->demo         = s_data.demo;
    out->story_count  = s_data.story_count;
    out->ticker_count = s_data.ticker_count;
    strlcpy(out->edition, s_data.edition, sizeof(out->edition));
    strlcpy(out->generated_at, s_data.generated_at, sizeof(out->generated_at));

    /* The phone gets a list row, not the front page: one symbol and a headline
     * cut to fit it. news_str_copy rather than strlcpy because that cut lands
     * mid-word by definition and headlines arrive from a copy desk that emits em
     * dashes and curly quotes — strlcpy would happily halve one, and half a
     * codepoint is not a short headline, it is a JSON string the app's parser
     * rejects. */
    const news_story_t *lead = lead_story(&s_data);
    if (lead) {
        news_str_copy(out->lead_symbol, sizeof(out->lead_symbol), lead->symbol);
        news_str_copy(out->lead_headline, sizeof(out->lead_headline), lead->headline);
    }

    out->index_count = s_data.index_count;
    for (int i = 0; i < out->index_count; i++) {
        news_str_copy(out->indices[i].symbol, sizeof(out->indices[i].symbol),
                      s_data.indices[i].symbol);
        out->indices[i].last_c = s_data.indices[i].last_c;
        out->indices[i].chg_bp = s_data.indices[i].chg_bp;
    }

    strlcpy(out->news_url, s_cfg.news_url, sizeof(out->news_url));
    strlcpy(out->last_result, news_fetch_result_name(s_last_result), sizeof(out->last_result));
    if (s_last_ok_us != 0) {
        out->age_seconds = (int)((esp_timer_get_time() - s_last_ok_us) / 1000000);
        out->stale = out->age_seconds > POLL_SECONDS * STALE_AFTER_POLLS;
    } else {
        out->age_seconds = -1;      /* never succeeded — not "zero seconds ago" */
        out->stale = s_cfg.news_url[0] != '\0';
    }

    out->battery_present = s_batt_present;
    out->battery_pct     = s_batt_pct;
    out->battery_mv      = s_batt_mv;
    state_unlock();
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
