/*
 * Host unit tests for power_policy.c — the decision a wake makes about whether
 * to print, to go straight back to sleep, or to stay up.
 *
 * This test is the reason the policy is a pure function at all. The alternative
 * is a state machine that exists only on hardware, and whose failures appear
 * three days later on a wall, in a room, with no serial cable attached: a board
 * that stopped waking, a board that refreshes every fifteen minutes at nobody,
 * a board that has silently shown the same sheet since a firmware update. None
 * of those announce themselves, none of them can be caught by looking at the
 * glass, and reproducing one costs three days per attempt.
 *
 * So every rule that could produce one of those outcomes is asserted here, on a
 * laptop, in a millisecond: the safety gates that keep a board reachable, the
 * cold-boot and stale-RTC forces that get changed rendering onto the glass, the
 * backoff curve, and the rule that a failing fetch tells the reader once rather
 * than every hour forever.
 *
 * Integer-only and ESP-IDF-free by construction — power_policy.h mirrors the
 * one enum it needs by hand, so this compiles and runs identically on x86 and
 * on Xtensa.
 */
#include "th.h"

#include "power_policy.h"

/* --- the fixture ---------------------------------------------------------- */

static power_input_t g_in;
static power_plan_t  g_out;

/* A healthy scheduled poll on a board that is doing exactly what it was built
 * to do: on a cell, no developer attached, a URL to fetch, and a server that
 * said nothing moved. Every test starts here and changes one thing, so what a
 * case is actually about is the line after the call to this. */
static void baseline(void)
{
    memset(&g_in, 0, sizeof(g_in));
    memset(&g_out, 0, sizeof(g_out));
    g_in.wake               = POWER_WAKE_TIMER;
    g_in.fetch              = POWER_FETCH_UNCHANGED;
    g_in.rtc_valid          = true;
    g_in.sleep_enabled      = true;
    g_in.battery_present    = true;
    g_in.usb_console        = false;
    g_in.url_configured     = true;
    g_in.offline_badged     = false;
    g_in.consecutive_fails  = 0;
    g_in.base_sleep_seconds = 900;
    g_in.stale_seconds      = 3600;
    g_in.seconds_since_ok   = 60;
}

static void decide(void)
{
    power_decide(&g_in, &g_out);
}

/* --- tests ---------------------------------------------------------------- */

static void test_safety_gates_beat_everything(void)
{
    /* Each of these is a way a board becomes a brick on a wall: asleep while a
     * developer watches the monitor, asleep on USB with no cell to save, asleep
     * with no URL to poll. They are checked before anything else and nothing
     * downstream can overturn one — which is exactly what this asserts, by
     * handing each gate the input most likely to talk it into sleeping. */
    baseline();
    decide();
    CHECK_INT(g_out.action, POWER_SLEEP_AGAIN);   /* the control: without a gate
                                                   * tripped, this input sleeps,
                                                   * so the four below are not
                                                   * passing for free */

    baseline();
    g_in.sleep_enabled = false;
    decide();
    CHECK_INT(g_out.action, POWER_STAY_AWAKE);

    baseline();
    g_in.battery_present = false;
    decide();
    CHECK_INT(g_out.action, POWER_STAY_AWAKE);

    baseline();
    g_in.usb_console = true;
    decide();
    CHECK_INT(g_out.action, POWER_STAY_AWAKE);

    baseline();
    g_in.url_configured = false;
    decide();
    CHECK_INT(g_out.action, POWER_STAY_AWAKE);

    /* A gate must also beat the two branches that otherwise force a print, or a
     * board with no cell fitted would sleep the moment its RTC state went
     * stale — which is every firmware update, on the bench. */
    baseline();
    g_in.battery_present = false;
    g_in.rtc_valid = false;
    g_in.wake = POWER_WAKE_COLD;
    decide();
    CHECK_INT(g_out.action, POWER_STAY_AWAKE);
}

static void test_a_button_wake_stays_awake(void)
{
    /* A button woke us, so a person is standing in front of the frame. What
     * they fetched has nothing to do with it: the companion app cannot win a
     * race against a three-second window, so the window has to open on the
     * press and not on the outcome of the poll. */
    static const power_fetch_t all[] = {
        POWER_FETCH_NOT_ATTEMPTED, POWER_FETCH_UNCHANGED,
        POWER_FETCH_CHANGED,       POWER_FETCH_FAILED,
    };
    for (size_t i = 0; i < sizeof(all) / sizeof(all[0]); i++) {
        baseline();
        g_in.wake  = POWER_WAKE_BUTTON;
        g_in.fetch = all[i];
        decide();
        CHECK_INT(g_out.action, POWER_STAY_AWAKE);
    }

    /* Including when the RTC state is stale, which would otherwise force a
     * print-then-sleep and shut the window in the reader's face. */
    baseline();
    g_in.wake      = POWER_WAKE_BUTTON;
    g_in.rtc_valid = false;
    decide();
    CHECK_INT(g_out.action, POWER_STAY_AWAKE);
}

static void test_a_cold_boot_always_prints(void)
{
    /* A cold boot has nothing on the glass it can vouch for — RTC memory does
     * not survive a power-on reset, so whatever is hanging there was put there
     * by a firmware and an edition this build knows nothing about. */
    static const power_fetch_t all[] = {
        POWER_FETCH_NOT_ATTEMPTED, POWER_FETCH_UNCHANGED,
        POWER_FETCH_CHANGED,       POWER_FETCH_FAILED,
    };
    for (size_t i = 0; i < sizeof(all) / sizeof(all[0]); i++) {
        baseline();
        g_in.wake  = POWER_WAKE_COLD;
        g_in.fetch = all[i];
        decide();
        CHECK_INT(g_out.action, POWER_REFRESH_THEN_SLEEP);
        CHECK_INT(g_out.next_fails, 0);
    }

    /* And the counter starts again. A board that was failing before it was
     * unplugged must not wake from its first cold boot already an hour into a
     * backoff curve. */
    baseline();
    g_in.wake              = POWER_WAKE_COLD;
    g_in.fetch             = POWER_FETCH_FAILED;
    g_in.consecutive_fails = 7;
    decide();
    CHECK_INT(g_out.action, POWER_REFRESH_THEN_SLEEP);
    CHECK_INT(g_out.next_fails, 0);
}

static void test_stale_rtc_state_forces_a_print(void)
{
    /* THE FIRMWARE-UPDATE CASE, and the one that fails silently and
     * permanently. Flash new rendering code onto a board holding an old
     * content_hash and the first wake hashes the same payload, gets the same
     * number, concludes nothing moved, and sleeps — and the changed rendering
     * never reaches the glass, possibly for months. Mixing the build id into
     * the RTC magic turns that into a mismatch, and this is the line that makes
     * the mismatch mean something. */
    baseline();
    g_in.wake      = POWER_WAKE_TIMER;
    g_in.rtc_valid = false;
    g_in.fetch     = POWER_FETCH_UNCHANGED;
    decide();
    CHECK_INT(g_out.action, POWER_REFRESH_THEN_SLEEP);
    CHECK_INT(g_out.next_fails, 0);
}

static void test_unchanged_content_sleeps_without_a_refresh(void)
{
    /* The whole design in one case: the common outcome costs no refresh, no
     * LVGL, no framebuffer and no panel power. If this row ever becomes a
     * refresh the board is flat in three weeks. */
    baseline();
    decide();
    CHECK_INT(g_out.action, POWER_SLEEP_AGAIN);
    CHECK_INT(g_out.sleep_seconds, 900);
    CHECK_INT(g_out.next_fails, 0);
    CHECK(g_out.badge_offline == false);

    /* A success clears the counter, so one bad afternoon does not leave the
     * board on an hourly cadence for the rest of the week. */
    baseline();
    g_in.consecutive_fails = 9;
    decide();
    CHECK_INT(g_out.action, POWER_SLEEP_AGAIN);
    CHECK_INT(g_out.next_fails, 0);
    CHECK_INT(g_out.sleep_seconds, 900);
}

static void test_changed_content_earns_the_refresh(void)
{
    /* The only row in the whole table that is allowed to reach the panel
     * repeatedly, and the only reason the board is on the wall. */
    baseline();
    g_in.fetch = POWER_FETCH_CHANGED;
    decide();
    CHECK_INT(g_out.action, POWER_REFRESH_THEN_SLEEP);
    CHECK_INT(g_out.next_fails, 0);
    CHECK_INT(g_out.sleep_seconds, 900);
    CHECK(g_out.badge_offline == false);

    baseline();
    g_in.fetch             = POWER_FETCH_CHANGED;
    g_in.consecutive_fails = 6;
    decide();
    CHECK_INT(g_out.action, POWER_REFRESH_THEN_SLEEP);
    CHECK_INT(g_out.next_fails, 0);
}

static void test_a_failure_sleeps_and_counts(void)
{
    /* A failure with a snapshot that is still fresh changes nothing a reader
     * can see, so it must not spend a refresh saying so. It sleeps, and the
     * only thing it leaves behind is the count that drives the backoff. */
    baseline();
    g_in.fetch = POWER_FETCH_FAILED;
    decide();
    CHECK_INT(g_out.action, POWER_SLEEP_AGAIN);
    CHECK_INT(g_out.next_fails, 1);
    CHECK(g_out.badge_offline == false);
    CHECK_INT(g_out.sleep_seconds, 900);

    baseline();
    g_in.fetch             = POWER_FETCH_FAILED;
    g_in.consecutive_fails = 2;
    decide();
    CHECK_INT(g_out.action, POWER_SLEEP_AGAIN);
    CHECK_INT(g_out.next_fails, 3);
    CHECK_INT(g_out.sleep_seconds, 900);

    /* The fourth failure is where the curve bends, and the plan says the sleep
     * is the count AFTER this wake — so consecutive_fails = 3 is the wake that
     * first backs off. */
    baseline();
    g_in.fetch             = POWER_FETCH_FAILED;
    g_in.consecutive_fails = 3;
    decide();
    CHECK_INT(g_out.next_fails, 4);
    CHECK_INT(g_out.sleep_seconds, 3600);
}

static void test_offline_is_badged_once_and_only_once(void)
{
    /* A reader needs to be told once that the sheet in front of them is no
     * longer live. Telling them every hour costs 2.3 mAh a time to repeat
     * information the sheet already carries in ink. */
    baseline();
    g_in.fetch            = POWER_FETCH_FAILED;
    g_in.seconds_since_ok = 7200;      /* > stale_seconds */
    g_in.offline_badged   = false;
    decide();
    CHECK_INT(g_out.action, POWER_REFRESH_THEN_SLEEP);
    CHECK(g_out.badge_offline == true);
    CHECK_INT(g_out.next_fails, 1);    /* the badge is spent, the failure still
                                        * counts, or the backoff never starts */

    baseline();
    g_in.fetch            = POWER_FETCH_FAILED;
    g_in.seconds_since_ok = 7200;
    g_in.offline_badged   = true;
    decide();
    CHECK_INT(g_out.action, POWER_SLEEP_AGAIN);
    CHECK(g_out.badge_offline == false);
    CHECK_INT(g_out.next_fails, 1);

    /* Exactly at the threshold is still live. The comparison is strict so that
     * stale_seconds names the moment the sheet stops being trustworthy rather
     * than the last moment it is. */
    baseline();
    g_in.fetch            = POWER_FETCH_FAILED;
    g_in.seconds_since_ok = 3600;      /* == stale_seconds */
    decide();
    CHECK_INT(g_out.action, POWER_SLEEP_AGAIN);
    CHECK(g_out.badge_offline == false);

    /* seconds_since_ok == 0 means "never succeeded", not "succeeded a moment
     * ago", and it deliberately does NOT badge: a board that has never had a
     * good poll reached this wake through the cold-boot or stale-RTC force,
     * both of which already print. Badging here would put OFFLINE on a sheet
     * that has never carried an edition at all. */
    baseline();
    g_in.fetch            = POWER_FETCH_FAILED;
    g_in.seconds_since_ok = 0;
    decide();
    CHECK_INT(g_out.action, POWER_SLEEP_AGAIN);
    CHECK(g_out.badge_offline == false);
}

static void test_the_backoff_curve(void)
{
    /* The curve itself, pinned. A board pointed at a server that has been
     * switched off must degrade to one wake an hour rather than keeping full
     * cadence at nothing — that is the cell burned doing precisely no work. */
    CHECK_INT(power_backoff_seconds(900, 0), 900);
    CHECK_INT(power_backoff_seconds(900, 1), 900);
    CHECK_INT(power_backoff_seconds(900, 2), 900);
    CHECK_INT(power_backoff_seconds(900, 3), 900);

    /* 4..10 is the 5x step. At a 900 s interval that is 4500 s uncapped, and
     * the cap takes it to 3600 — the plan's table shows the curve's value and
     * the cap's value in one row, which reads as a contradiction; the specified
     * clamp order (curve, then cap, then max-with-base) resolves it to 3600. */
    CHECK_INT(power_backoff_seconds(900, 4), 3600);
    CHECK_INT(power_backoff_seconds(900, 7), 3600);
    CHECK_INT(power_backoff_seconds(900, 10), 3600);

    /* Which means at 900 s the 5x branch and the >10 branch are indistinguish-
     * able, and a 5x that had been deleted would still pass every line above.
     * A shorter interval separates them. */
    CHECK_INT(power_backoff_seconds(600, 4), 3000);
    CHECK_INT(power_backoff_seconds(600, 10), 3000);
    CHECK_INT(power_backoff_seconds(600, 11), 3600);
    CHECK_INT(power_backoff_seconds(60, 5), 300);

    /* Past ten, one hour, and it stays one hour however long the outage runs.
     * 65535 is where the counter saturates, so it is the last value the curve
     * will ever be asked about. */
    CHECK_INT(power_backoff_seconds(900, 11), 3600);
    CHECK_INT(power_backoff_seconds(900, 100), 3600);
    CHECK_INT(power_backoff_seconds(900, 65535), 3600);

    CHECK_INT(POWER_BACKOFF_MAX_SECONDS, 3600);
}

static void test_backoff_never_shortens_a_configured_sleep(void)
{
    /* A user who asked for two hours between polls keeps two hours even though
     * the backoff cap is one. Backoff exists to slow a failing board down; a
     * cap that also speeds one up would take a deliberately frugal setting and
     * quietly double its daily draw at the exact moment the board is failing. */
    CHECK_INT(power_backoff_seconds(7200, 50), 7200);
    CHECK_INT(power_backoff_seconds(7200, 0), 7200);
    CHECK_INT(power_backoff_seconds(7200, 5), 7200);
    CHECK_INT(power_backoff_seconds(86400, 65535), 86400);

    /* And the 5x multiply does not wrap on the way there. 5 * 86400 is only
     * 432000, but the field is a uint32_t the API does not clamp, and a wrap
     * would hand esp_sleep_enable_timer_wakeup() a few seconds instead of a
     * day — a board polling flat out while the log says it is being careful. */
    CHECK_INT(power_backoff_seconds(4294967295u, 5), 4294967295u);
    CHECK_INT(power_backoff_seconds(4294967295u, 0), 4294967295u);
    CHECK_INT(power_backoff_seconds(1000000000u, 5), 1000000000u);
}

static void test_the_fail_counter_saturates(void)
{
    /* A wrap to zero looks exactly like a recovery: the board would decide it
     * had just had a good poll, drop back to full cadence, and start the whole
     * count again — burning the cell fastest precisely when it has been failing
     * longest. Saturation is what makes "> 10 means an hour" permanent. */
    baseline();
    g_in.fetch             = POWER_FETCH_FAILED;
    g_in.consecutive_fails = 65535;
    decide();
    CHECK_INT(g_out.next_fails, 65535);
    CHECK_INT(g_out.action, POWER_SLEEP_AGAIN);
    CHECK_INT(g_out.sleep_seconds, 3600);

    baseline();
    g_in.fetch             = POWER_FETCH_FAILED;
    g_in.consecutive_fails = 65534;
    decide();
    CHECK_INT(g_out.next_fails, 65535);
}

static void test_not_attempted_is_treated_as_a_failure(void)
{
    /* Wi-Fi that never came up is not a quiet, successful poll. Counting it as
     * one would leave a board whose network has gone away waking at full
     * cadence forever, which is the one thing the backoff exists to prevent —
     * and it is the most likely long-run failure of the lot, because a router
     * outlives an edition. */
    baseline();
    g_in.fetch = POWER_FETCH_NOT_ATTEMPTED;
    decide();
    CHECK_INT(g_out.action, POWER_SLEEP_AGAIN);
    CHECK_INT(g_out.next_fails, 1);

    baseline();
    g_in.fetch             = POWER_FETCH_NOT_ATTEMPTED;
    g_in.consecutive_fails = 4;
    decide();
    CHECK_INT(g_out.next_fails, 5);
    CHECK_INT(g_out.sleep_seconds, 3600);

    /* And it badges like a failure once the snapshot has gone stale. */
    baseline();
    g_in.fetch            = POWER_FETCH_NOT_ATTEMPTED;
    g_in.seconds_since_ok = 7200;
    decide();
    CHECK_INT(g_out.action, POWER_REFRESH_THEN_SLEEP);
    CHECK(g_out.badge_offline == true);
}

static void test_action_names_are_stable(void)
{
    /* These go into the one log line a sleeping board emits per wake, which is
     * the only window anyone has into a decision made in three seconds and then
     * unwitnessed for fifteen minutes. */
    CHECK_STR(power_action_name(POWER_SLEEP_AGAIN), "sleep");
    CHECK_STR(power_action_name(POWER_REFRESH_THEN_SLEEP), "refresh");
    CHECK_STR(power_action_name(POWER_STAY_AWAKE), "awake");
    CHECK_STR(power_action_name((power_action_t)99), "unknown");
}

int main(void)
{
    test_safety_gates_beat_everything();
    test_a_button_wake_stays_awake();
    test_a_cold_boot_always_prints();
    test_stale_rtc_state_forces_a_print();
    test_unchanged_content_sleeps_without_a_refresh();
    test_changed_content_earns_the_refresh();
    test_a_failure_sleeps_and_counts();
    test_offline_is_badged_once_and_only_once();
    test_the_backoff_curve();
    test_backoff_never_shortens_a_configured_sleep();
    test_the_fail_counter_saturates();
    test_not_attempted_is_treated_as_a_failure();
    test_action_names_are_stable();
    TH_REPORT("power_policy");
}
