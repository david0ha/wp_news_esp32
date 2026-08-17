/*
 * power.c — see power.h.
 */
#include "power.h"

#include <string.h>

#include "board_io.h"
#include "driver/gpio.h"
#include "driver/usb_serial_jtag.h"
#include "epd6_panel.h"
#include "esp_app_desc.h"
#include "esp_log.h"
#include "esp_sleep.h"
#include "esp_wifi.h"
#include "sdkconfig.h"

static const char *TAG = "power";

/* "WPNS". Arbitrary, and it is the *other* half of the word that does the work
 * — see build_id(). */
#define WP_RTC_MAGIC 0x57504E53u

/* Kconfig may be absent from an sdkconfig generated before this component
 * existed — sdkconfig is gitignored and per-developer, so a colleague's tree
 * predates every option added here. idf.py regenerates it with these defaults,
 * but a missing symbol would otherwise be a compile error in main.cpp rather
 * than in the one file that knows what the default should be. */
#ifndef CONFIG_WP_NEWS_SLEEP_SECONDS
#define CONFIG_WP_NEWS_SLEEP_SECONDS 900
#endif
#ifndef CONFIG_WP_NEWS_AWAKE_WINDOW_SECONDS
#define CONFIG_WP_NEWS_AWAKE_WINDOW_SECONDS 120
#endif

/*
 * RTC slow memory. Retained across deep sleep, zeroed by a power-on reset —
 * which is exactly the behaviour wanted, because a cold boot has nothing on the
 * glass it can vouch for and must print.
 *
 * Note it is NOT in the .bss the startup code clears, so it must never be given
 * an initialiser that matters: after a timer wake it holds the previous boot's
 * bytes, and after a power-on it holds whatever the RTC domain came up with.
 * power_state_valid() is the only thing that may be believed about it.
 */
static RTC_DATA_ATTR wp_rtc_state_t s_state;

/*
 * Fold the ELF's SHA-256 into 32 bits (FNV-1a), and mix it into the magic.
 *
 * THE MECHANISM. `esp_app_get_description()->app_elf_sha256` is written into
 * the image at link time and is different for every binary. XORing it into the
 * magic means a board flashed with new firmware finds a magic it does not
 * recognise on its first wake, `power_state_valid()` returns false, and
 * `power_decide()`'s `!rtc_valid` branch forces one full path with a refresh.
 *
 * THE CONSEQUENCE OF GETTING IT WRONG, which is why this is not tidiness. Use a
 * constant here — or anything else that survives a reflash — and the sequence
 * is: flash new rendering code; the first wake fetches the same payload as
 * yesterday; news_hash() of that payload is a hash of the *parsed model*, which
 * has not changed; the board concludes nothing moved and goes back to sleep.
 * The new rendering never reaches the glass. Not for a while — *never*, for as
 * long as the producer's payload holds still, which on a quiet weekend is days
 * and on an abandoned feed is forever. There is no error, no log line and
 * nothing to see: the sheet on the wall is a perfectly good sheet, printed by
 * the firmware you just replaced.
 */
static uint32_t build_id(void)
{
    const esp_app_desc_t *d = esp_app_get_description();
    uint32_t h = 2166136261u;
    if (d) {
        for (size_t i = 0; i < sizeof(d->app_elf_sha256); i++) {
            h ^= (uint32_t)d->app_elf_sha256[i];
            h *= 16777619u;
        }
    }
    return h;
}

power_wake_t power_wake_cause(void)
{
    switch (esp_sleep_get_wakeup_cause()) {
    case ESP_SLEEP_WAKEUP_TIMER:
        return POWER_WAKE_TIMER;

    /* ext1 is what this board arms. ESP_SLEEP_WAKEUP_GPIO joins it because the
     * two are the same event as far as the policy is concerned — a person
     * pressed something — and mapping an unexpected one to COLD would spend a
     * refresh instead of opening the awake window, which is the reader standing
     * in front of the frame watching nothing happen for half a minute. */
    case ESP_SLEEP_WAKEUP_EXT1:
    case ESP_SLEEP_WAKEUP_GPIO:
        return POWER_WAKE_BUTTON;

    /* Everything else — power-on, brownout, watchdog, a reflash, ESP_RST_SW —
     * shares the one property that matters: nothing can be assumed about RTC
     * memory or about the glass. COLD prints. */
    default:
        return POWER_WAKE_COLD;
    }
}

wp_rtc_state_t *power_state(void)
{
    return &s_state;
}

bool power_state_valid(void)
{
    return s_state.magic == (WP_RTC_MAGIC ^ build_id());
}

void power_state_reset(void)
{
    memset(&s_state, 0, sizeof(s_state));
    s_state.magic = WP_RTC_MAGIC ^ build_id();
}

bool power_usb_console_attached(void)
{
    /* The IDF's monitor assumes connected until it has missed several USB SOF
     * packets, so this reads `true` for the first few milliseconds after the
     * scheduler starts, before any tick hook has run. That bias is the right
     * way round and is worth keeping: a false positive costs a board that stays
     * awake when it could have slept, which the next wake corrects, while a
     * false negative is a board that sleeps in the middle of somebody's
     * `idf.py monitor` session. app_main runs hundreds of ticks in, so in
     * practice the answer has long since settled. */
    return usb_serial_jtag_is_connected();
}

bool power_deep_sleep_enabled(void)
{
#ifdef CONFIG_WP_NEWS_DEEP_SLEEP
    return true;
#else
    return false;
#endif
}

uint32_t power_default_sleep_seconds(void)
{
    return (uint32_t)CONFIG_WP_NEWS_SLEEP_SECONDS;
}

uint32_t power_awake_window_seconds(void)
{
    return (uint32_t)CONFIG_WP_NEWS_AWAKE_WINDOW_SECONDS;
}

/* Build the ext1 mask, dropping — loudly — any pin that cannot wake the chip.
 *
 * The plan asked for a _Static_assert on the RTC-GPIO ceiling and it cannot be
 * one here: the pins arrive as data precisely so this component does not
 * include main/user_config.h, so they are not a constant expression. A runtime
 * check is a fair trade, because the failure it exists to catch is exactly the
 * silent kind — a pin above 21 is accepted by nothing, wakes nothing, and
 * reports nothing at all. Naming it in the log is most of the value. */
static uint64_t wake_mask(const int *gpios, int n)
{
    uint64_t mask = 0;
    for (int i = 0; i < n; i++) {
        int p = gpios[i];
        if (p < 0) continue;
        if (p > POWER_RTC_GPIO_MAX) {
            ESP_LOGE(TAG, "GPIO%d cannot wake the chip (RTC GPIOs are 0..%d) — "
                          "that button is dead while asleep", p, POWER_RTC_GPIO_MAX);
            continue;
        }
        mask |= 1ULL << p;
    }
    return mask;
}

void power_sleep(uint32_t seconds, const int *wake_gpios, int wake_count)
{
    /* A zero interval arms a timer that fires immediately: a boot loop at full
     * power that empties the cell in hours and looks, from the outside, exactly
     * like a board that will not start. Nothing should be able to get here with
     * one — the policy floors its answer at the configured interval and both
     * Kconfig and NVS clamp that to at least 60 — so this is a backstop for a
     * caller's bug, not a policy of its own. */
    if (seconds == 0) {
        ESP_LOGE(TAG, "asked to sleep for 0 s — clamping to %u; this is a bug",
                 (unsigned)power_default_sleep_seconds());
        seconds = power_default_sleep_seconds();
    }

    /* Both controllers into deep sleep, and the panel's rail down with them.
     *
     * epd6_refresh() already ends this way, so on a boot that printed something
     * this is belt and braces — but a boot that printed nothing never called
     * it. epd6_sleep() no-ops when epd6_init() has not run, which is precisely
     * the quiet path, and there the rail was never driven at all: GPIO43's load
     * switch has a pulldown, so a pin nobody touched is a panel that is off.
     *
     * port_bsp is "the only code that talks to the panel" and it owns GPIO43,
     * so this does not reach around it to poke the rail directly. Both cases
     * are covered without doing so. */
    epd6_sleep();

    /* The battery divider's load switch. This is the one real leak on the list:
     * board_io_init() drives it HIGH and, until now, nothing ever lowered it. */
    board_io_sleep();

    /* Down, not idle. */
    esp_err_t werr = esp_wifi_stop();
    if (werr != ESP_OK && werr != ESP_ERR_WIFI_NOT_INIT) {
        ESP_LOGW(TAG, "esp_wifi_stop: %s", esp_err_to_name(werr));
    }

    uint64_t mask = wake_mask(wake_gpios, wake_count);
    if (mask) {
        /* Every button is press-to-GND, so the wake is on any of them going
         * low. Without this the board is reachable only on the timer, and the
         * documented KEY2-held-five-seconds escape hatch — the thing that turns
         * a frame back into a device you can reconfigure — is gone. */
        ESP_ERROR_CHECK_WITHOUT_ABORT(
            esp_sleep_enable_ext1_wakeup_io(mask, ESP_EXT1_WAKEUP_ANY_LOW));
    } else {
        ESP_LOGW(TAG, "no usable wake pins — only the timer can wake this board");
    }

    ESP_ERROR_CHECK_WITHOUT_ABORT(
        esp_sleep_enable_timer_wakeup((uint64_t)seconds * 1000000ULL));

    ESP_LOGI(TAG, "sleeping %us (wakes %u, quiet %u, awake %ums total, mask 0x%llx)",
             (unsigned)seconds, (unsigned)s_state.wakes,
             (unsigned)s_state.quiet_wakes, (unsigned)s_state.awake_ms_total,
             (unsigned long long)mask);

    esp_deep_sleep_start();
}
