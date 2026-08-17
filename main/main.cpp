
#include <stdio.h>
#include <stdint.h>
#include <stdlib.h>
#include <time.h>
#include <sys/time.h>
#include <freertos/FreeRTOS.h>
#include <esp_heap_caps.h>
#include <esp_timer.h>
#include <esp_log.h>

#include "epd6_panel.h"
#include "wp_palette.h"
#include "lvgl_bsp.h"
#include "ui_news.h"      /* the setup overlay doubles as the status screen */
#include "ui_strings.h"
#include "user_app.h"
#include "user_config.h"
#include "provisioning.h"
#include "net_time.h"
#include "board_io.h"
#include "device_api.h"
#include "http_port.h"
#include "news_model.h"
#include "news_service.h"
#include "power.h"
#include "power_policy.h"
#include "sdkconfig.h"

static const char *TAG = "main";

/*
 * The panel's size is written down twice: user_config.h states it for the LVGL
 * bring-up call below, epd6_transpose.h for the framebuffer and the pack. Two
 * numbers for one panel is one too many, and if they drift apart the symptom is
 * not a crash but a page with a strip of it never written — LVGL simply stops
 * rendering where it was told the glass ended, and the pixels beyond keep
 * whatever the last refresh left there.
 */
static_assert(EPD_WIDTH == EPD6_W && EPD_HEIGHT == EPD6_H,
              "user_config.h's panel geometry must match epd6_transpose.h's");

/*
 * LVGL renders RGB565 into a strip buffer; this callback quantizes it into the
 * panel's six inks. Keeping LVGL on RGB565 rather than an indexed format buys
 * every widget, font and anti-aliased shape working exactly as it does in the
 * desktop simulator, which runs this same wp_quantize565().
 *
 * The dither is positional, so x and y are screen coordinates and not offsets
 * within the strip — pass the wrong ones and the Bayer pattern seams at every
 * strip boundary.
 *
 * It does NOT refresh the panel. On this panel that is a THIRTY-SECOND flashing
 * operation and belongs to whoever knows what changed — see user_app.cpp.
 */
static int64_t s_flush_us;      /* quantizing time since the last bottom strip */
static int64_t s_flush_px;      /* and how many pixels it covered */

static void Lvgl_FlushCallback(lv_display_t *drv, const lv_area_t *area, uint8_t *color_map)
{
	const int64_t t0 = esp_timer_get_time();

	uint16_t *buffer = (uint16_t *)color_map;
	for (int y = area->y1; y <= area->y2; y++) {
		for (int x = area->x1; x <= area->x2; x++) {
			epd6_set_pixel((uint16_t)x, (uint16_t)y,
			               (epd6_color_t)wp_quantize565(*buffer, x, y));
			buffer++;
		}
	}

	s_flush_us += esp_timer_get_time() - t0;
	s_flush_px += (int64_t)(area->x2 - area->x1 + 1) * (area->y2 - area->y1 + 1);

	/*
	 * Let the idle task run before the next strip.
	 *
	 * LVGL renders and flushes the WHOLE sheet inside one lv_timer_handler()
	 * call, and on 1200x1600 that is 1.92 million trips through
	 * wp_quantize565() — six palette distances and a Bayer offset each. It
	 * does not yield, it is pinned to core 0, and it outruns the ten-second
	 * task watchdog, which then reports IDLE0 rather than the code that
	 * starved it. The strip boundary is the natural place to breathe: LVGL
	 * allows a blocking flush callback, and fourteen ticks a frame is nothing
	 * against a refresh of twenty to thirty seconds.
	 *
	 * NOTE: this feeds the watchdog, it does not make the render fast. The
	 * log line below is what says whether it needs to be.
	 */
	vTaskDelay(1);

	/* The bottom strip ends a full-sheet pass, so report what it cost. */
	if (area->y2 >= EPD6_H - 1 && s_flush_px > 0) {
		ESP_LOGI(TAG, "flush %lld ms for %lld px (%lld ns/px)",
		         (long long)(s_flush_us / 1000), (long long)s_flush_px,
		         (long long)(s_flush_us * 1000 / s_flush_px));
		s_flush_us = 0;
		s_flush_px = 0;
	}

	lv_disp_flush_ready(drv);
}

// --- Provisioning status, shown on the news UI's overlay ------------------

static void SetStatus(const char *title, const char *ssid, const char *body)
{
	if (Lvgl_lock(-1)) {
		ui_news_set_overlay(title, ssid, body);
		Lvgl_unlock();
	}
	Lvgl_RenderNow();
	epd6_refresh();
}

/*
 * Only the states a person has to act on reach the glass.
 *
 * A refresh here is twenty-five seconds, so the two station events cost fifty
 * of them on a board that is working perfectly — and the first one was spent
 * BEFORE prov_wifi_connect() was even called, so the board announced it was
 * connecting and then waited half a minute to start. They are log lines now.
 *
 * The portal states keep theirs: those are the two moments the sheet is the
 * only instruction the user has. Losing the connecting/connected pair also
 * improves the failure path rather than degrading it — a board whose saved
 * network has gone away now holds yesterday's front page for the fifteen-second
 * connect timeout and changes once, when the portal comes up, instead of
 * flashing a status nobody is reading yet.
 */
static void OnProvisioningEvent(prov_event_t event, const char *info, void *user)
{
	(void)user;
	char body[192];
	switch (event) {
	case PROV_EVENT_STA_CONNECTING:
		ESP_LOGI(TAG, "connecting to '%s'", info ? info : "");
		break;
	case PROV_EVENT_STA_CONNECTED:
		ESP_LOGI(TAG, "connected: %s", info ? info : "");
		break;
	case PROV_EVENT_PORTAL_STARTED:
		// The network's name is passed on its own: the setup sheet sets it at
		// the size of a lead headline, which is the whole point of the state.
		snprintf(body, sizeof(body),
		         "1. Join the network above, from a phone or a laptop.\n\n"
		         "2. Stay connected, and open the page it offers.");
		SetStatus(S_WIFI_TITLE, info ? info : "", body);
		break;
	case PROV_EVENT_CONFIG_SAVED:
		snprintf(body, sizeof(body), "Saved \"%s\"\n%s", info ? info : "", S_RESTARTING);
		SetStatus(S_WIFI_TITLE, NULL, body);
		break;
	}
}

// --- the quiet path ------------------------------------------------------
//
// A wake that changes nothing must not power the panel, must not initialise
// LVGL, and must not allocate the 960,000-byte framebuffer. That is the whole
// feature: the sleep on its own would still run epd6_init(), build 390 LVGL
// objects and spend a refresh on every wake — about 2.5 mAh, ninety-six times a
// day, and the cell flat in under three weeks having shown the reader nothing
// new.
//
// So everything below the decision is arranged around resolving a wake WITHOUT
// touching GPIO43, SPI3, either UC8179, LVGL, device_api, mDNS or SNTP.

#ifndef CONFIG_WP_NEWS_FEED_URL
#define CONFIG_WP_NEWS_FEED_URL ""
#endif

// The same choice user_app's current_url() makes. It is static there and this is
// the boot path, so the two are written twice; they must agree, because a quiet
// path polling a different URL from the one the app polls would compare hashes
// of two different documents and refresh forever.
static const char *EffectiveUrl(const prov_config_t *cfg)
{
	return cfg->news_url[0] ? cfg->news_url : CONFIG_WP_NEWS_FEED_URL;
}

// The interval in force, of the three layers that can set it: the value carried
// across the sleep (which is what POST /api/sleep changed), else NVS from the
// setup form, else the build-time default.
static uint32_t EffectiveSleepSeconds(const prov_config_t *cfg, const wp_rtc_state_t *rs)
{
	if (rs->sleep_seconds) {
		return rs->sleep_seconds;
	}
	if (cfg->sleep_seconds != PROV_SLEEP_SECONDS_UNSET) {
		return prov_clamp_sleep_seconds(cfg->sleep_seconds);
	}
	return power_default_sleep_seconds();
}

// When the sheet stops being trustworthy. Same shape as user_app's STALE_SECONDS
// and for the same reason: the badge answers a question about the NEWS, not
// about the poll loop, so the cadence sets the shape and a floor sets the
// meaning. A quarter of an hour is the point at which a reader would want to be
// told, whatever interval the board happens to be running.
#define STALE_FLOOR_SECONDS 900u

static uint32_t StaleSeconds(uint32_t base_sleep_seconds)
{
	uint32_t twice = base_sleep_seconds > (UINT32_MAX / 2)
	                     ? UINT32_MAX
	                     : base_sleep_seconds * 2;
	return twice > STALE_FLOOR_SECONDS ? twice : STALE_FLOOR_SECONDS;
}

// How long since a poll last worked. Zero means never, which the policy
// deliberately does not treat as stale — see power_policy.c.
//
// This is wall-clock rather than uptime because uptime does not survive a deep
// sleep and the whole question spans several of them. It works without SNTP on
// the wake: the RTC counter runs through deep sleep and the IDF carries system
// time across it, so once any boot has synced, later wakes keep counting.
static uint32_t SecondsSinceOk(const wp_rtc_state_t *rs)
{
	if (rs->last_ok_unix <= 0) {
		return 0;
	}
	const int64_t now = (int64_t)time(NULL);
	if (now <= rs->last_ok_unix) {
		return 0;
	}
	const int64_t d = now - rs->last_ok_unix;
	return d > (int64_t)UINT32_MAX ? UINT32_MAX : (uint32_t)d;
}

// One conditional GET, and the comparison that decides whether the panel moves.
//
// Two gates, and they are not redundant. The ETag saves the transfer, the cJSON
// tree and the 32 KB struct fill; news_hash() saves the twenty-five second
// refresh and remains the SOLE authority on it. They disagree exactly when the
// producer changes a field the sheet does not render — a generated_at that moves
// every poll would shift the tag and not the hash — and on that poll the server
// sends 200, this parses, the hash says nothing moved, and the glass stays still.
static power_fetch_t QuietFetch(const char *url, news_t *scratch, wp_rtc_state_t *rs)
{
	char etag[HTTP_ETAG_MAX] = "";
	const news_fetch_result_t r =
	    news_service_fetch_cond(url, rs->etag, scratch, etag, sizeof(etag));

	ESP_LOGI(TAG, "quiet fetch: %s", news_fetch_result_name(r));

	switch (r) {
	case NEWS_FETCH_NOT_MODIFIED:
		// The server compared the tag for us. Nothing to parse and nothing to
		// store: the tag we sent is still the tag for what is on the glass.
		return POWER_FETCH_UNCHANGED;

	case NEWS_FETCH_OK: {
		const uint32_t h = news_hash(scratch);
		// The tag named a document that parsed, so it is worth keeping — but
		// only here, on OK. Storing the tag of a payload that was rejected
		// would make the next poll a 304 and the device would never look at
		// that document again: stuck on yesterday's page with a log full of
		// successful fetches.
		http_etag_copy(rs->etag, sizeof(rs->etag), etag);
		return h == rs->content_hash ? POWER_FETCH_UNCHANGED : POWER_FETCH_CHANGED;
	}

	default:
		// NO_URL, TRANSPORT, HTTP_STATUS, BAD_PAYLOAD. All four are failures
		// that sleep. In particular a rejected payload is NOT a reason to
		// print: the previous snapshot is still on the glass and still
		// correct, per the standing rule that a bad poll leaves it alone.
		return POWER_FETCH_FAILED;
	}
}

extern "C" void app_main(void)
{
	UserApp_AppInit();

	// Local timezone for the dateline and the folio's updated/next pair. There
	// is no RTC on the EE04 — the two pins the previous carrier routed to an
	// I2C header are a user button and the battery divider's enable here — so
	// the clock is SNTP alone, and this is the only thing that turns it into
	// local time.
	setenv("TZ", CONFIG_WP_NEWS_TIMEZONE, 1);
	tzset();

	board_io_init(BATT_ADC_PIN, BATT_ENABLE_PIN);

	// The pinout lives here and nowhere else; power_sleep and user_app both take
	// the buttons as data for the same reason epd6_init takes the panel's pins.
	// These are also the ext1 wake sources — all four are RTC GPIOs on the S3.
	static const int btn_gpios[] = {
		BTN_KEY0_PIN, BTN_KEY1_PIN, BTN_KEY2_PIN, BTN_BOOT_PIN,
	};
	const int btn_count = (int)(sizeof(btn_gpios) / sizeof(btn_gpios[0]));

	// --- what this boot is ------------------------------------------------
	const power_wake_t wake      = power_wake_cause();
	wp_rtc_state_t    *rs        = power_state();
	const bool         rtc_valid = power_state_valid();
	if (!rtc_valid) {
		// Either a cold boot (RTC memory does not survive a power-on reset) or
		// new firmware (the magic carries the build id). Both mean nothing is
		// known about what is hanging on the glass. Stamp the state now so this
		// boot's results are recorded against this build.
		power_state_reset();
	}
	rs->wakes++;

	prov_config_t cfg;
	provisioning_load_config(&cfg);   // NVS only — no radio, no timeout

	const char *url = EffectiveUrl(&cfg);

	power_input_t in = {};
	in.wake               = wake;
	in.fetch              = POWER_FETCH_NOT_ATTEMPTED;
	in.rtc_valid          = rtc_valid;
	in.sleep_enabled      = power_deep_sleep_enabled();
	in.battery_present    = board_io_battery_present();
	in.usb_console        = power_usb_console_attached();
	in.url_configured     = url[0] != '\0';
	in.offline_badged     = rs->offline_badged;
	in.consecutive_fails  = rs->consecutive_fails;
	in.base_sleep_seconds = EffectiveSleepSeconds(&cfg, rs);
	in.stale_seconds      = StaleSeconds(in.base_sleep_seconds);
	in.seconds_since_ok   = SecondsSinceOk(rs);

	// --- the quiet path ---------------------------------------------------
	//
	// Guarded so that ANY doubt takes the full path. It is attempted only on a
	// timer wake whose RTC state this firmware wrote, on a board that is allowed
	// to sleep and has something to poll — every one of those is also a gate
	// inside power_decide(), which remains the single authority; these are here
	// so a board that was never going to sleep does not pay for a connect it
	// cannot use.
	bool have_ip = false;
	if (wake == POWER_WAKE_TIMER && rtc_valid && in.sleep_enabled &&
	    in.battery_present && !in.usb_console && in.url_configured) {

		// news_t is 32,932 bytes — four times the main task's whole stack — so
		// it goes to PSRAM and is freed before the full path could want the
		// room. A failed allocation is not a fetch failure; it is a boot that
		// cannot tell what is on the glass, which is exactly what rtc_valid
		// answers, so it takes the full path rather than sleeping on a guess.
		news_t *scratch = (news_t *)heap_caps_malloc(sizeof(news_t), MALLOC_CAP_SPIRAM);
		if (!scratch) {
			ESP_LOGW(TAG, "no PSRAM for a scratch snapshot — taking the full path");
			in.rtc_valid = false;
		} else {
			prov_config_t connected_cfg;
			have_ip = provisioning_connect_only(&connected_cfg, 15000);
			if (have_ip) {
				cfg = connected_cfg;
				in.fetch = QuietFetch(EffectiveUrl(&cfg), scratch, rs);
			} else {
				// Wi-Fi did not come up. This counts a failure and sleeps — it
				// must NOT fall through to the portal. A board whose network
				// has gone away would otherwise spend a refresh saying so on
				// every wake: 2.3 mAh every fifteen minutes, about 220 mAh a
				// day, flat in under three weeks while displaying a setup
				// screen nobody is looking at.
				ESP_LOGW(TAG, "quiet path: no network — counting a failure");
				in.fetch = POWER_FETCH_NOT_ATTEMPTED;
			}
			free(scratch);
		}
	}

	// --- the decision ------------------------------------------------------
	power_plan_t plan;
	power_decide(&in, &plan);
	ESP_LOGI(TAG, "wake=%s fetch=%s -> %s (sleep %us, fails %u%s)",
	         wake == POWER_WAKE_TIMER  ? "timer"
	         : wake == POWER_WAKE_BUTTON ? "button"
	                                     : "cold",
	         in.fetch == POWER_FETCH_UNCHANGED ? "unchanged"
	         : in.fetch == POWER_FETCH_CHANGED ? "changed"
	         : in.fetch == POWER_FETCH_FAILED  ? "failed"
	                                           : "not_attempted",
	         power_action_name(plan.action), (unsigned)plan.sleep_seconds,
	         (unsigned)plan.next_fails, plan.badge_offline ? ", badging offline" : "");

	// What this wake learned, recorded before anything can go wrong with acting
	// on it. The one thing deliberately NOT written here is content_hash: it is
	// published after a refresh, not before, or a board that recorded the hash
	// and then browned out mid-refresh would spend the next month convinced it
	// had printed a page it had not.
	rs->consecutive_fails = plan.next_fails;
	rs->sleep_seconds     = in.base_sleep_seconds;
	if (in.fetch == POWER_FETCH_UNCHANGED || in.fetch == POWER_FETCH_CHANGED) {
		rs->last_ok_unix   = (int64_t)time(NULL);
		rs->offline_badged = false;   // back online: the next outage may speak again
	}
	bool sleep_now = (plan.action == POWER_SLEEP_AGAIN);

	if (plan.badge_offline) {
		// The reader is told once and never again, so record it either way.
		rs->offline_badged = true;

		// AND THEN DO NOT SPEND THE REFRESH. The spec has this row falling
		// through once to badge the sheet OFFLINE, and on a board that never
		// slept that is exactly right — the previous snapshot is still in RAM,
		// so the badge is the same page with two words changed.
		//
		// It cannot work here, and the reason is the fact the whole design
		// rests on. A wake is a boot: RAM is gone, and sizeof(news_t) is 32,932
		// bytes against 8 KB of RTC memory, so the snapshot did not survive.
		// The only thing that survived is the image on the glass, which cannot
		// be read back. To badge a sheet you must redraw it, and to redraw it
		// you need a snapshot — which on this path can only come from the fetch
		// that just failed. What user_app would actually print is the DEMO page
		// (user_app.cpp:516), because that is its documented answer when no
		// snapshot arrives within FIRST_PAINT_WAIT_MS.
		//
		// So the row as written spends 2.3 mAh to replace a real, correct, merely
		// stale front page with a demo sheet. Leaving the glass alone is strictly
		// better: the reader sees yesterday's paper instead of a page about a
		// company the board invented. Worse still, this row is reached precisely
		// when the network is down, and falling through with no IP would run
		// provisioning_run(), which never returns — one Wi-Fi outage would park
		// the board in a captive portal forever, awake, until the cell died.
		ESP_LOGW(TAG, "snapshot is stale and the poll is failing, but a wake "
		              "cannot redraw what it cannot fetch — leaving the glass alone");
		sleep_now = true;
	}

	if (sleep_now) {
		rs->quiet_wakes++;
		rs->awake_ms_total += (uint32_t)(esp_timer_get_time() / 1000);
		power_sleep(plan.sleep_seconds, btn_gpios, btn_count);   // does not return
	}

	// --- the full path -----------------------------------------------------
	//
	// Everything from here costs the refresh. Two chip selects, because the
	// panel is two UC8179s: GPIO44 drives the left 600 columns of the portrait
	// page and GPIO41 the right 600. A blank right-hand half of the sheet is
	// that pin.
	const epd6_pins_t pins = {
		.sck       = EPD_SCK_PIN,
		.mosi      = EPD_MOSI_PIN,
		.cs_master = EPD_CS_PIN,
		.cs_slave  = EPD_CS_SLAVE_PIN,
		.dc        = EPD_DC_PIN,
		.rst       = EPD_RST_PIN,
		.busy      = EPD_BUSY_PIN,
		.power     = EPD_POWER_PIN,
		.host      = SPI3_HOST,
	};
	ESP_ERROR_CHECK(epd6_init(&pins));
	Lvgl_PortInit(EPD_WIDTH, EPD_HEIGHT, Lvgl_FlushCallback);

	// Build the real UI up front and drive provisioning through its overlay,
	// so there is no separate status screen to allocate and throw away.
	if (Lvgl_lock(-1)) {
		UserApp_UiInit();
		Lvgl_unlock();
	}

	bool connected = have_ip;
	if (!connected) {
		prov_options_t opts;
		provisioning_default_options(&opts);   // AP prefix "WP News", 15s timeout
		opts.event_cb = OnProvisioningEvent;
		connected = provisioning_run(&opts, &cfg);  // blocks (and reboots) until configured
	} else {
		// The quiet path already has an IP and the saved config, so the connect
		// is not repeated. Nor is the force-portal flag consumed, and it cannot
		// be missed by skipping this: setting it restarts the board, a restart
		// is a cold wake, and a cold wake never reaches the quiet path — so
		// provisioning_run() always runs on the boot that has to honour it.
		ESP_LOGI(TAG, "content changed — printing without a second connect");
	}

	if (connected) {
		ESP_LOGI(TAG, "online — news URL '%s'",
		         cfg.news_url[0] ? cfg.news_url : "(none: demo snapshot)");
		// The dateline has no other source, and this runs before the tasks
		// start so the first sheet is never printed with a blank clock. That
		// ordering is worth keeping and the ten-second budget was not: SNTP on
		// a working LAN is one UDP round trip, and the boards that need longer
		// than four seconds are the ones that will time out at ten as well.
		net_time_sync(4000);
		if (Lvgl_lock(-1)) {
			ui_news_set_overlay(NULL, NULL, NULL);   // dismiss the setup overlay
			Lvgl_unlock();
		}
		UserApp_TaskInit(&cfg, btn_gpios, btn_count);

		// Companion-app control server on the home LAN (HTTP + mDNS
		// "wpnews.local"), reading and driving the app through the
		// user_app_api bridge.
		device_api_start();
	}

	// The full path does NOT sleep here. It has only started the tasks; the page
	// has not been composed, let alone printed, and sleeping now would cut the
	// refresh off mid-flight. Closing the window belongs to whoever knows the
	// render finished, which is UiTask — it publishes news_hash() into
	// power_state() after the refresh and calls power_sleep() then, holding a
	// button wake open for CONFIG_WP_NEWS_AWAKE_WINDOW_SECONDS first so the
	// companion app can win the race against a three-second wake.
}
