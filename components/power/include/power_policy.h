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
    /* The interval this wake will sleep for if it sleeps — power_cadence()'s
     * answer, ALREADY FINAL. The backoff curve has been applied to it there;
     * power_decide() takes it as given and does not multiply it again. */
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

/* --- the effective cadence ------------------------------------------------
 *
 * How long until the next wake, and who decided it. Three parties have an
 * opinion and until this function there were three places that resolved them:
 * the boot path's quiet sleep, `enter_sleep()` on the full path, and NewsTask's
 * awake wait. Three copies of a rule this subtle is three chances to disagree,
 * and the disagreement is invisible — a board that sleeps by one rule and polls
 * by another is a board that works.
 *
 *   the desk    `policy.poll_seconds` is the cadence to use NOW, and
 *               `next_change` the instant its answer will change. Both arrive
 *               on the wire; both are the desk's business, not the board's.
 *   the board   `local_seconds` — Kconfig, then NVS from the setup form, then
 *               POST /api/sleep — already resolved and clamped by the caller.
 *               It is the FALLBACK, for static hosting and for a mock with no
 *               policy block, not a competing answer.
 *   the curve   `consecutive_fails` slows a board whose polls are not working,
 *               and it multiplies whatever base the two above settled on.
 *
 * The same rule governs a sleeping board and an awake one, which is the whole
 * point: one cadence, two power modes.
 */

/* Mirrors news_policy_t (news_model.h) by hand, so this header stays free of
 * news_model.h as well as of ESP-IDF — the same rule, for the same reason, as
 * power_wake_t mirroring esp_sleep_source_t. The mirror is held honest by
 * test_the_poll_bounds_agree_with_the_wire, which includes both headers and
 * compares the two ranges. */
typedef struct {
    uint32_t poll_seconds;   /* 0 = the desk said nothing about cadence */
    int64_t  next_change;    /* epoch seconds; 0 = none announced       */
} power_policy_block_t;

/* Who decided, which is reported to the companion app beside the number: an
 * hourly interval set by a desk for the night ends by itself, and one compiled
 * into the image does not. */
typedef enum {
    POWER_CADENCE_LOCAL = 0,      /* Kconfig / NVS / API, or the fallback */
    POWER_CADENCE_POLICY,         /* the desk's poll_seconds              */
    POWER_CADENCE_NEXT_CHANGE,    /* a targeted wake for a transition     */
} power_cadence_src_t;

typedef struct {
    power_policy_block_t policy;
    uint32_t local_seconds;       /* the local layer, already resolved       */
    int64_t  now;                 /* time(NULL) — see POWER_CLOCK_SYNCED_EPOCH */
    uint16_t consecutive_fails;
} power_cadence_in_t;

typedef struct {
    uint32_t            seconds;
    power_cadence_src_t source;
} power_cadence_t;

/* Total, integer-only, no clock of its own: *out is always fully written and
 * `seconds` is never zero, whatever the inputs say. */
void power_cadence(const power_cadence_in_t *in, power_cadence_t *out);

/* The wire's range, mirrored by hand from news_model.h — see
 * power_policy_block_t, and the test that holds the two together. */
#define POWER_POLL_MIN_SECONDS      30      /* == NEWS_POLL_MIN */
#define POWER_POLL_MAX_SECONDS   86400      /* == NEWS_POLL_MAX */

/* Nobody said anything at all: no policy on the wire, no interval in NVS, no
 * build-time default reaching us. Fifteen minutes is the knee of the battery
 * curve and the same figure CLAUDEPOST_SLEEP_SECONDS defaults to. */
#define POWER_POLL_FALLBACK_SECONDS 900

/* Before this instant — 2024-01-01T00:00:00Z — `time(NULL)` is the epoch plus
 * however long the board has been up, which is not a date. There is no RTC on
 * this carrier: the clock is SNTP or nothing, and SNTP lands some seconds after
 * the network does. `next_change` is an ABSOLUTE instant, so subtracting an
 * unsynced clock from it yields a wait of roughly fifty-five years — the right
 * answer, arrived at by accident. Testing for it says so, and makes a board
 * whose SNTP never succeeds behave like one that was sent no policy at all.
 *
 * One definition, shared by the quiet path, the awake poll loop and this
 * function; it used to be a second copy in user_app.cpp. */
#define POWER_CLOCK_SYNCED_EPOCH 1704067200

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

/* The curve. Called by power_cadence() — which is the ONLY caller that applies
 * it — and public so the test can pin it without building a whole input.
 * Integer-only and monotonic in `fails`. */
uint32_t power_backoff_seconds(uint32_t base, uint16_t fails);

/* For the one log line a sleeping board emits per wake. Never NULL. */
const char *power_action_name(power_action_t a);

#ifdef __cplusplus
}
#endif
