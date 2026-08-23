
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
	 * Let the rest of core 0 run before the next strip.
	 *
	 * LVGL renders and flushes the WHOLE sheet inside one lv_timer_handler()
	 * call, and on 1200x1600 that is 1.92 million trips through
	 * wp_quantize565() — six palette distances and a Bayer offset each. The
	 * LVGL task is priority 5 and pinned to core 0, so without this it holds
	 * that core for the entire four seconds and every lower-priority task on
	 * it stops dead. The strip boundary is the natural place to breathe: LVGL
	 * allows a blocking flush callback, and fourteen milliseconds a frame is
	 * nothing against a refresh of twenty to thirty seconds.
	 *
	 * It does NOT feed the task watchdog, whatever the shape of it suggests.
	 * The TWDT watches the IDLE tasks; IDLE is priority 0, so the millisecond
	 * given up here goes to whichever task is next in line — on core 0 that is
	 * main at priority 1 — and IDLE0 is scheduled only once nothing else on
	 * the core is runnable. Measured: main took six seconds of wall clock to
	 * get through the Wi-Fi bring-up it normally does in a few hundred
	 * milliseconds, finishing sixteen milliseconds after this loop released
	 * the core, and IDLE0 did not run once in that window. The watchdog
	 * window is widened in sdkconfig.defaults instead, where the reasoning
	 * and the measurements live.
	 *
	 * This is a latency fix, not a speed one. The log line below is what says
	 * whether the render itself needs to be faster.
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

#ifndef CONFIG_CLAUDEPOST_FEED_URL
#define CONFIG_CLAUDEPOST_FEED_URL ""
#endif

// The same choice user_app's current_url() makes. It is static there and this is
// the boot path, so the two are written twice; they must agree, because a quiet
// path polling a different URL from the one the app polls would compare hashes
// of two different documents and refresh forever.
static const char *EffectiveUrl(const prov_config_t *cfg)
{
	return cfg->news_url[0] ? cfg->news_url : CONFIG_CLAUDEPOST_FEED_URL;
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

	// Everything this function DECIDES lives next door in power_policy.c, under
	// test; what is left here is the part that cannot be tested anywhere but on
	// a board — a socket, a PSRAM allocation and a write into RTC memory. The
	// mapping is deliberately dull: two booleans and a hash.
	//
	// news_hash() is computed ONLY on the OK path. On a 304 nothing was parsed,
	// so `scratch` holds whatever the allocator left there, and hashing it would
	// feed uninitialised memory into the comparison that decides whether the
	// panel spends twenty-five seconds.
	const bool ok           = (r == NEWS_FETCH_OK);
	const bool not_modified = (r == NEWS_FETCH_NOT_MODIFIED);

	power_classify_t cl;
	power_classify_fetch(ok, not_modified, ok ? news_hash(scratch) : 0u,
	                     rs->content_hash, &cl);

	if (cl.store_etag) {
		http_etag_copy(rs->etag, sizeof(rs->etag), etag);
	}

	// The desk's cadence, carried across the sleep beside the tag.
	//
	// On EVERY 200, whether or not the hash moved. The policy block is not part
	// of the page — news_hash() deliberately cannot see it — so "the content
	// changed" says nothing at all about whether the cadence did, and a board
	// that only read the block on the polls that happened to bring a new
	// edition would miss every quiet window that began on a quiet day. Which is
	// exactly the case the block exists for. Same rule as NewsTask's adoption
	// block, deliberately: two places read this and they must read it the same.
	//
	// Not on a 304: there is no body, so there is no policy, and what is in RTC
	// memory is still the last thing the desk actually said.
	//
	// A zero `poll_seconds` is ABSENT and leaves the last cadence standing
	// rather than reverting to the local one — a caching layer that stripped
	// the block would otherwise multiply this board's request rate by sixty.
	// `next_change` is written unconditionally, because it is an instant and a
	// stale instant is worse than none.
	if (r == NEWS_FETCH_OK) {
		if (scratch->policy.poll_seconds > 0) {
			rs->poll_seconds = (uint32_t)scratch->policy.poll_seconds;
		}
		rs->next_change = scratch->policy.next_change;
	}
	return cl.fetch;
}

extern "C" void app_main(void)
{
	UserApp_AppInit();

	// Local timezone for the dateline and the folio's updated/next pair. There
	// is no RTC on the EE04 — the two pins the previous carrier routed to an
	// I2C header are a user button and the battery divider's enable here — so
	// the clock is SNTP alone, and this is the only thing that turns it into
	// local time.
	setenv("TZ", CONFIG_CLAUDEPOST_TIMEZONE, 1);
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
	in.consecutive_fails  = rs->consecutive_fails;
	// base_sleep_seconds is deliberately NOT filled here. It is the cadence,
	// and the cadence is partly the desk's — which this boot has not asked yet.
	// See below the quiet path.

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

		// news_t is 32,952 bytes — four times the main task's whole stack — so
		// it goes to PSRAM and is freed before the full path could want the
		// room.
		//
		// A failed allocation is a poll that did not happen, and it is recorded
		// as one. The obvious reading — "this boot cannot tell what is on the
		// glass, so clear rtc_valid and take the full path" — is wrong, and
		// wrong in the direction that costs a cell. rtc_valid answers whether
		// the RTC state was written by THIS firmware, and it was: content_hash
		// is still trustworthy and the glass still holds what it names. Nothing
		// about a full heap changes that.
		//
		// What clearing it would do is send this wake down the cold-boot force,
		// which reaches the full path with have_ip false and therefore reaches
		// provisioning_run() — and that never returns. A board whose PSRAM was
		// briefly full while its network happened to be down would park in a
		// captive portal, awake at 81 mA, until the cell died. Counting it as a
		// failed poll sleeps with backoff and tries again, which is what every
		// other way of not getting a snapshot does.
		news_t *scratch = (news_t *)heap_caps_malloc(sizeof(news_t), MALLOC_CAP_SPIRAM);
		if (!scratch) {
			ESP_LOGW(TAG, "no PSRAM for a scratch snapshot — counting a failure");
			in.fetch = POWER_FETCH_FAILED;
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

			// Close the connection this wake opened, before anything can
			// decide not to come back. On POWER_SLEEP_AGAIN below,
			// power_sleep() does not return: without this the socket is
			// abandoned with no FIN, and the desk holds that connection open
			// until its own 120-second timeout — on every quiet wake, which is
			// ninety-six dead connections a day from one board. On the CHANGED
			// path app_main returns and the thread-local handle simply leaks
			// until the next sleep reclaims it.
			//
			// Outside the have_ip branch on purpose, so the no-network arm is
			// covered too; it is a documented no-op when nothing is open. Safe
			// here even though the quiet path never calls http_port_init() —
			// this touches only the thread-local handle, not the TLS lock.
			http_port_release();
			free(scratch);
		}
	}

	// --- how long until the next wake --------------------------------------
	//
	// AFTER the fetch, and that ordering is what makes one cadence real. The
	// desk's `policy.poll_seconds` is the cadence to use now; the board learns
	// it from the poll it has just made, so computing this before the poll
	// would sleep on what the desk said an interval ago — or, on the first wake
	// after a URL change, on nothing at all. The local interval is the
	// fallback, for static hosting and for a mock with no policy block.
	//
	// The local layer is named once and used twice — here and at the write into
	// RTC memory below. The two expressions were identical and idempotent, so
	// they could not disagree today; naming it is cheap insurance against the
	// exact shape of R1, which is two copies of "the local interval" drifting
	// apart where only one of them was ever read.
	const uint32_t local_seconds = EffectiveSleepSeconds(&cfg, rs);

	power_cadence_in_t c = {};
	c.policy.poll_seconds = rs->poll_seconds;
	c.policy.next_change  = rs->next_change;
	c.local_seconds       = local_seconds;
	c.now                 = (int64_t)time(NULL);
	c.consecutive_fails   = rs->consecutive_fails;

	power_cadence_t cad;
	power_cadence(&c, &cad);
	in.base_sleep_seconds = cad.seconds;

	// --- the decision ------------------------------------------------------
	power_plan_t plan;
	power_decide(&in, &plan);

	// And the cadence again, with the count this wake ENDED on.
	//
	// The curve must see the failure that has just happened, because that is
	// what enter_sleep() does on the full path: it does its accounting first
	// and computes the cadence second. Left as one call, the same event — "this
	// wake got nothing onto the paper" — would produce a different sleep
	// depending on which path it happened on, and power_backoff_seconds() bends
	// at four, so the fourth consecutive failure would sleep for the base here
	// and for five times the base there. One extra wake at full cadence per
	// outage is a small cost; two paths quietly disagreeing about one rule is
	// the defect this task exists to remove, and it is invisible because both
	// of them work.
	//
	// The second call is a few hundred nanoseconds of integer arithmetic, and
	// it keeps power_decide() taking base_sleep_seconds as already-final rather
	// than growing a second way to express the same thing.
	c.consecutive_fails = plan.next_fails;
	power_cadence(&c, &cad);
	plan.sleep_seconds  = cad.seconds;

	ESP_LOGI(TAG, "wake=%s fetch=%s -> %s (cadence %us from %s, fails %u)",
	         wake == POWER_WAKE_TIMER  ? "timer"
	         : wake == POWER_WAKE_BUTTON ? "button"
	                                     : "cold",
	         in.fetch == POWER_FETCH_UNCHANGED ? "unchanged"
	         : in.fetch == POWER_FETCH_CHANGED ? "changed"
	         : in.fetch == POWER_FETCH_FAILED  ? "failed"
	                                           : "not_attempted",
	         power_action_name(plan.action), (unsigned)plan.sleep_seconds,
	         cad.source == POWER_CADENCE_POLICY      ? "policy"
	         : cad.source == POWER_CADENCE_NEXT_CHANGE ? "next_change"
	                                                   : "local",
	         (unsigned)plan.next_fails);

	// What this wake learned, recorded before anything can go wrong with acting
	// on it. The one thing deliberately NOT written here is content_hash: it is
	// published after a refresh, not before, or a board that recorded the hash
	// and then browned out mid-refresh would spend the next month convinced it
	// had printed a page it had not.
	rs->consecutive_fails = plan.next_fails;

	// THE LOCAL LAYER, not the cadence — and the difference is a flat cell.
	//
	// `sleep_seconds` is what POST /api/sleep and the setup form set, carried
	// across the sleep so the quiet path need not read NVS. EffectiveSleepSeconds()
	// reads it FIRST, ahead of NVS and Kconfig. So writing the cadence here
	// would take a 120-second targeted wake — a wake shortened once, for one
	// transition — and make it this board's local interval permanently: 720
	// wakes a day instead of 96, with every log line agreeing, until somebody
	// reflashed it. The cadence is a per-wake answer and lives only in
	// `plan.sleep_seconds`; this field is a setting.
	rs->sleep_seconds     = local_seconds;

	if (plan.action == POWER_SLEEP_AGAIN) {
		rs->quiet_wakes++;
		rs->awake_ms_total += (uint32_t)(esp_timer_get_time() / 1000);
		power_sleep(plan.sleep_seconds, btn_gpios, btn_count);   // does not return
	}

	// --- the full path -----------------------------------------------------
	//
	// The escape hatch first, before the panel, the UI and the network. It has
	// to be here rather than in UiTask: a board that wakes, finds nothing
	// changed and sleeps again never builds a UI at all, so the documented way
	// back into one stuck on an unreachable network would die the day deep
	// sleep ships. It costs one poll interval when the button is not held, and
	// it runs before provisioning_run() consumes the flag, so the portal comes
	// up on this boot rather than after a restart.
	user_app_check_force_ap_at_boot(btn_gpios, btn_count);

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
		provisioning_default_options(&opts);   // AP prefix "Claude Post", 15s timeout
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
		// "claudepost.local"), reading and driving the app through the
		// user_app_api bridge.
		device_api_start();
	}

	// The full path does NOT sleep here. It has only started the tasks; the page
	// has not been composed, let alone printed, and sleeping now would cut the
	// refresh off mid-flight. Closing the window belongs to whoever knows the
	// render finished, which is UiTask — it publishes news_hash() into
	// power_state() after the refresh and calls power_sleep() then, holding a
	// button wake open for CONFIG_CLAUDEPOST_AWAKE_WINDOW_SECONDS first so the
	// companion app can win the race against a three-second wake.
}
