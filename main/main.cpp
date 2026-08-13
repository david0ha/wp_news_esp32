
#include <stdio.h>
#include <time.h>
#include <sys/time.h>
#include <freertos/FreeRTOS.h>
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
#include "sdkconfig.h"

static const char *TAG = "main";

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
static void Lvgl_FlushCallback(lv_display_t *drv, const lv_area_t *area, uint8_t *color_map)
{
	uint16_t *buffer = (uint16_t *)color_map;
	for (int y = area->y1; y <= area->y2; y++) {
		for (int x = area->x1; x <= area->x2; x++) {
			epd6_set_pixel((uint16_t)x, (uint16_t)y,
			               (epd6_color_t)wp_quantize565(*buffer, x, y));
			buffer++;
		}
	}
	lv_disp_flush_ready(drv);
}

// --- Provisioning status, shown on the news UI's overlay ------------------

static void SetStatus(const char *title, const char *body)
{
	if (Lvgl_lock(-1)) {
		ui_news_set_overlay(title, body);
		Lvgl_unlock();
	}
	Lvgl_RenderNow();
	epd6_refresh();
}

static void OnProvisioningEvent(prov_event_t event, const char *info, void *user)
{
	(void)user;
	char body[192];
	switch (event) {
	case PROV_EVENT_STA_CONNECTING:
		snprintf(body, sizeof(body), "Connecting to\n%s", info ? info : "");
		SetStatus(S_WIFI_TITLE, body);
		break;
	case PROV_EVENT_STA_CONNECTED:
		snprintf(body, sizeof(body), "Connected\n%s", info ? info : "");
		SetStatus(S_WIFI_TITLE, body);
		break;
	case PROV_EVENT_PORTAL_STARTED:
		snprintf(body, sizeof(body),
		         "1. Join Wi-Fi:\n%s\n\n2. Stay connected,\nthen open the page it offers",
		         info ? info : "");
		SetStatus(S_WIFI_TITLE, body);
		break;
	case PROV_EVENT_CONFIG_SAVED:
		snprintf(body, sizeof(body), "Saved \"%s\"\n%s", info ? info : "", S_RESTARTING);
		SetStatus(S_WIFI_TITLE, body);
		break;
	}
}

extern "C" void app_main(void)
{
	UserApp_AppInit();

	// Local timezone for the header clock. There is no RTC on the EE04 — the
	// two pins the previous carrier routed to an I2C header are a user button
	// and the battery divider's enable here — so the clock is SNTP alone, and
	// this is the only thing that turns it into local time.
	setenv("TZ", CONFIG_WP_NEWS_TIMEZONE, 1);
	tzset();

	board_io_init(BATT_ADC_PIN, BATT_ENABLE_PIN);

	// Two chip selects, because the panel is two UC8179s: GPIO44 drives the top
	// 600 rows and GPIO41 the bottom 600. A blank lower half is that pin.
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

	prov_options_t opts;
	provisioning_default_options(&opts);   // AP prefix "WP News", 15s timeout
	opts.event_cb = OnProvisioningEvent;

	prov_config_t cfg;
	bool connected = provisioning_run(&opts, &cfg);  // blocks (and reboots) until configured

	if (connected) {
		ESP_LOGI(TAG, "online — news URL '%s'",
		         cfg.news_url[0] ? cfg.news_url : "(none: demo snapshot)");
		net_time_sync(10000);   // the header clock has no other source
		if (Lvgl_lock(-1)) {
			ui_news_set_overlay(NULL, NULL);   // dismiss the setup overlay
			Lvgl_unlock();
		}
		// The pinout lives here and nowhere else; user_app takes the buttons
		// as data for the same reason epd_init takes the panel's pins.
		const int btn_gpios[] = {
			BTN_KEY0_PIN, BTN_KEY1_PIN, BTN_KEY2_PIN, BTN_BOOT_PIN,
		};
		UserApp_TaskInit(&cfg, btn_gpios, (int)(sizeof(btn_gpios) / sizeof(btn_gpios[0])));

		// Companion-app control server on the home LAN (HTTP + mDNS
		// "wpnews.local"), reading and driving the app through the
		// user_app_api bridge.
		device_api_start();
	}
}
