/*
 * power_policy.h — what a wake decides: print, sleep again, or stay reachable.
 *
 * Waking this board from deep sleep is not resuming, it is booting. Every byte
 * of RAM is gone, PSRAM is gone, the 960,000-byte framebuffer is gone, and the
 * only thing that survived is the glass — Spectra 6 is bistable, so the last
 * edition hangs there drawing nothing. That is the whole reason the design
 * works, and it is why the interesting decision is not "sleep between polls"
 * but the narrower one this file owns:
 *
 *     a wake that changes nothing must not power the panel, must not
 *     initialise LVGL, and must not allocate the framebuffer.
 *
 * The decision is a **pure function** and that is not tidiness. Everything else
 * on the sleep path is a state machine that exists only on hardware, and its
 * failures are all of the silent kind: a board that stopped waking, a board
 * that refreshes at nobody every fifteen minutes, a board that has shown the
 * same sheet since a firmware update. None of them can be seen by looking at
 * the glass, none of them appear in a log anyone is reading, and reproducing
 * one costs three days on a wall per attempt. Pulling the decision out into
 * ninety lines with no I/O in them means every one of those rules is settled on
 * a laptop by `test_power_policy`, in a millisecond, before the board is hung.
 *
 * So: **no ESP-IDF header is included here, ever.** `power_wake_t` mirrors the
 * three values of `esp_sleep_source_t` this policy acts on, by hand; `main.cpp`
 * owns the mapping from `esp_sleep_get_wakeup_cause()` onto it and is the only
 * place that knows the IDF spellings. The same rule that keeps `ui_chart.h`
 * integer-only applies for the same reason: this compiles and runs identically
 * on x86 and on Xtensa, so what the host test proves is what the board does.
 *
 * Nothing in here allocates, blocks, logs, or reads a clock. Everything the
 * decision needs arrives in `power_input_t`.
 */
#pragma once

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Why we woke. A hand-written mirror of the `esp_sleep_source_t` values this
 * policy distinguishes — see the file comment. Anything the IDF reports that is
 * not the timer or ext1 (a power-on reset, a brownout, a watchdog, a reflash)
 * maps to COLD, because all of them share the one property that matters: RTC
 * memory did not survive, so nothing is known about what is on the glass. */
typedef enum {
    POWER_WAKE_COLD = 0,    /* power-on, reset, or any cause we do not act on */
    POWER_WAKE_TIMER,       /* the RTC timer fired — a scheduled poll */
    POWER_WAKE_BUTTON,      /* ext1 on KEY0/1/2/BOOT — a person is present */
} power_wake_t;

/* What the poll came back with. Note that UNCHANGED covers both halves of the
 * two-gate design in §5 of the spec: a 304, where the server said so and saved
 * the transfer, and a 200 whose news_hash() matched, where the device said so.
 * Only the second is authoritative about the panel; by the time it reaches this
 * enum the distinction has done its work and been discarded. */
typedef enum {
    POWER_FETCH_NOT_ATTEMPTED = 0, /* no URL, or Wi-Fi never came up */
    POWER_FETCH_UNCHANGED,         /* 304, or 200 whose news_hash() matched */
    POWER_FETCH_CHANGED,           /* 200 carrying something new */
    POWER_FETCH_FAILED,            /* transport, bad status, or bad payload */
} power_fetch_t;

typedef enum {
    POWER_SLEEP_AGAIN = 0,         /* sleep now; the panel is not touched */
    POWER_REFRESH_THEN_SLEEP,      /* print, then sleep */
    POWER_STAY_AWAKE,              /* do not sleep at all — today's behaviour */
} power_action_t;

typedef struct {
    power_wake_t  wake;
    power_fetch_t fetch;
    bool     rtc_valid;            /* magic matched: we know what is on the glass */
    bool     sleep_enabled;        /* Kconfig && NVS */
    bool     battery_present;
    bool     usb_console;          /* a developer is attached */
    bool     url_configured;
    uint16_t consecutive_fails;    /* BEFORE this wake */
    uint32_t base_sleep_seconds;
} power_input_t;

typedef struct {
    power_action_t action;
    uint32_t       sleep_seconds;  /* after backoff */
    uint16_t       next_fails;
} power_plan_t;

/* What a single poll turned out to be, and whether its ETag may be written
 * down. Two answers rather than one because they are decided together and were
 * once decided apart — see power_classify_fetch(). */
typedef struct {
    power_fetch_t fetch;
    bool          store_etag;   /* record the tag this poll returned */
} power_classify_t;

/* One hour. The ceiling on the backoff curve, not on the configured interval —
 * a board asked to poll twice a day keeps polling twice a day. */
#define POWER_BACKOFF_MAX_SECONDS 3600u

/*
 * Turn one poll's outcome into the `fetch` power_decide() wants, and decide
 * whether the server's ETag may be recorded.
 *
 * `ok` is a 2xx that parsed; `not_modified` is a 304. They are separate
 * booleans rather than one enum so that this header needs nothing from
 * news_service.h — the caller owns the mapping, exactly as main.cpp owns the
 * mapping from esp_sleep_source_t onto power_wake_t.
 *
 * `new_hash` is news_hash() of what was just parsed and is read ONLY when `ok`;
 * on the other paths nothing was parsed and the caller has no meaningful value
 * to supply. `old_hash` is what is on the glass now.
 *
 * This lives here rather than beside the fetch for one reason: the ETag rule is
 * subtle, it decides whether an edition ever reaches paper, and it was got
 * wrong once already. A tag written down before the refresh that would justify
 * it earns a 304 on the next wake, and the new edition never prints — silently,
 * for as long as the payload holds still. Rules like that belong where a host
 * test can hold them.
 *
 * Total, integer-only, and *out is always fully written.
 */
void     power_classify_fetch(bool ok, bool not_modified,
                              uint32_t new_hash, uint32_t old_hash,
                              power_classify_t *out);

/* Total: every input produces a plan, and there is no failure return. *out is
 * always fully written, so a caller cannot forget to initialise it. */
void     power_decide(const power_input_t *in, power_plan_t *out);

/* The curve, separately callable so the test can pin it without building a
 * whole input. Integer-only and monotonic in `fails`. */
uint32_t power_backoff_seconds(uint32_t base, uint16_t fails);

/* For the one log line a sleeping board emits per wake. Never NULL. */
const char *power_action_name(power_action_t a);

#ifdef __cplusplus
}
#endif
