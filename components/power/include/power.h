/*
 * power.h — the device half of deep sleep: what survives it, and how to enter it.
 *
 * `power_policy.h` decides; this file performs. The split is deliberate and it
 * is where every testable choice went: the policy is pure, integer-only, free
 * of ESP-IDF and covered by `test_power_policy`, while everything here talks to
 * silicon and cannot be tested anywhere but on a board. Keep new decisions out
 * of this file. If you find yourself writing a branch that *decides* something
 * rather than *performing* it, it belongs next door with a test.
 *
 * Waking from deep sleep is not resuming, it is booting. RAM is gone, PSRAM is
 * gone, the 960,000-byte framebuffer is gone. `sizeof(news_t)` is 32,952 bytes
 * against 8 KB of RTC slow memory, so the snapshot cannot survive and no
 * packing will make it. What survives is the glass — Spectra 6 is bistable, so
 * the last edition hangs there drawing nothing — plus the hundred-odd bytes of
 * `wp_rtc_state_t` below, which exist for exactly one purpose: to let the next
 * wake work out whether the glass is already right.
 */
#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "http_port.h"     /* HTTP_ETAG_MAX — the tag is stored, never parsed */
#include "power_policy.h"  /* power_wake_t, and the decision this file obeys */

#ifdef __cplusplus
extern "C" {
#endif

/*
 * The whole of what crosses a sleep. About a hundred bytes of the 8 KB in RTC
 * slow memory; the rest is deliberately unclaimed.
 *
 * It is lost on a power-on reset, and that is correct rather than unfortunate:
 * a board that has just been plugged in knows nothing about what is hanging on
 * the glass, so it must take the full path and print. `power_state_valid()` is
 * what turns "lost" into "print once".
 */
typedef struct {
    uint32_t magic;             /* WP_RTC_MAGIC ^ build id — power_state_valid() */
    uint32_t content_hash;      /* news_hash() of what is on the glass NOW */
    char     etag[HTTP_ETAG_MAX]; /* the server's tag for that same content */
    uint32_t sleep_seconds;     /* the interval in force, so a change made over
                                 * the API survives without an NVS read on the
                                 * quiet path */
    uint16_t consecutive_fails; /* drives power_backoff_seconds() */
    uint32_t wakes;             /* diagnostics — see below */
    uint32_t quiet_wakes;       /* those that cost no refresh */
    uint32_t awake_ms_total;    /* accumulated on the way into every sleep */
} wp_rtc_state_t;

/*
 * The three diagnostics are not decoration. Both numbers this design rests on
 * are unmeasured — deep-sleep current (the XIAO is specified at 14 uA, forum
 * reports range from 9 uA to several hundred, and the carrier's own load
 * switches contribute an unpublished amount) and Wi-Fi connect time, which
 * dominates a quiet wake. `wakes`, `quiet_wakes` and `awake_ms_total` are how a
 * day on a wall turns the estimates into measurements with no instruments at
 * all: /api/state divides them out and reports a daily draw.
 */

/* Why this boot happened. Maps esp_sleep_get_wakeup_cause() onto the policy's
 * hand-written mirror — this function is the ONLY place in the project that
 * knows both spellings, which is what keeps power_policy.h free of ESP-IDF. */
power_wake_t power_wake_cause(void);

/* The RTC-retained struct itself. Never NULL; its contents are meaningless
 * unless power_state_valid() agrees. */
wp_rtc_state_t *power_state(void);

/* Whether the retained state was written by THIS firmware, on a boot that
 * actually retained it. False means: print, then reset. */
bool power_state_valid(void);

/* Zero the state and stamp it with this build's magic. Call after a full path
 * has printed something, so the next quiet wake has a hash it can trust. */
void power_state_reset(void);

/* Is a developer watching? The console is on USB Serial/JTAG (GPIO43/44 are the
 * panel's power-enable and CS, so it cannot be UART0), which makes the USB
 * connection status a good proxy for "somebody is running idf.py monitor". A
 * board that sleeps mid-monitor is a board nobody can debug. */
bool power_usb_console_attached(void);

/* --- the Kconfig layer ---------------------------------------------------- */
/* Accessors rather than raw CONFIG_ symbols, so exactly one file carries the
 * #ifndef fallbacks and callers read the same way whether or not the option is
 * present in a given sdkconfig (which is gitignored and per-developer). */

bool     power_deep_sleep_enabled(void);      /* CONFIG_CLAUDEPOST_DEEP_SLEEP */
uint32_t power_default_sleep_seconds(void);   /* CONFIG_CLAUDEPOST_SLEEP_SECONDS */
uint32_t power_awake_window_seconds(void);    /* CONFIG_CLAUDEPOST_AWAKE_WINDOW_SECONDS */

/* The S3's RTC GPIOs are 0..21, and only an RTC GPIO can wake the chip through
 * ext1. A button on a pin above this cannot wake it and says nothing at all
 * about why — so power_sleep() checks, names the pin, and refuses to pretend. */
#define POWER_RTC_GPIO_MAX 21

/*
 * Enter deep sleep. Does not return.
 *
 * `wake_gpios` is the board's button pins — the same array `UserApp_TaskInit()`
 * already receives, in the same order — and they are passed as data rather than
 * included because the pinout lives in `main/user_config.h`. A component
 * reaching into the application's headers is how a portable component stops
 * being one, and here it is not merely style: `main` implicitly depends on
 * every component, so a component that depended on `main` would close a cycle.
 * Passing them keeps the pinout stated in exactly one place and makes it
 * impossible to arm the wake without saying what it wakes on.
 *
 * Runs the shutdown checklist first — the panel, the battery divider, the
 * radio — then arms ext1 on those pins (active low, all four buttons are
 * press-to-GND) and the RTC timer.
 */
void power_sleep(uint32_t seconds, const int *wake_gpios, int wake_count)
    __attribute__((noreturn));

#ifdef __cplusplus
}
#endif
