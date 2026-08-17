/*
 * power_policy.c — see power_policy.h.
 */
#include "power_policy.h"

uint32_t power_backoff_seconds(uint32_t base, uint16_t fails)
{
    /* The multiply is done in 64 bits and only then narrowed. 5 * 86400 is
     * 432,000 and fits comfortably, but `base` is a uint32_t arriving from NVS
     * and from POST /api/sleep, and this function does not clamp its input. A
     * wrap here would hand esp_sleep_enable_timer_wakeup() a few seconds
     * instead of a day: a board polling flat out while every log line says it
     * is being careful, which is the failure that is hardest to see from the
     * outside and worst for the cell. */
    uint64_t s = base;

    if (fails > 10) {
        s = POWER_BACKOFF_MAX_SECONDS;
    } else if (fails >= 4) {
        s = (uint64_t)base * 5u;
    }

    /* Cap, then floor — and the order is the whole of it. Capping first means
     * the curve can never lengthen a sleep past an hour, which is what keeps a
     * board that has been failing for a week still checking once an hour rather
     * than drifting into once a month. Flooring second means the cap can never
     * *shorten* a sleep the user deliberately asked for: someone who set two
     * hours between polls keeps two hours, and the backoff — whose entire
     * purpose is to slow a failing board down — does not quietly double their
     * daily draw at the exact moment the board has stopped working. */
    if (s > POWER_BACKOFF_MAX_SECONDS) {
        s = POWER_BACKOFF_MAX_SECONDS;
    }
    if (s < base) {
        s = base;
    }
    return (uint32_t)s;
}

void power_classify_fetch(bool ok, bool not_modified,
                          uint32_t new_hash, uint32_t old_hash,
                          power_classify_t *out)
{
    /* 304 first, and the order is load-bearing rather than stylistic.
     *
     * A 304 has no body: nothing was parsed, so `new_hash` holds whatever the
     * caller's scratch buffer happened to contain. Reaching the hash comparison
     * on this path would be reading uninitialised memory on the real board, and
     * the value it read would decide whether the panel spent twenty-five
     * seconds. Testing `not_modified` first is what makes `new_hash` a
     * don't-care everywhere except the one branch that computed it.
     *
     * It also resolves the contradictory `ok && not_modified` — a caller bug,
     * unreachable from the one caller, which derives both from a single enum —
     * and it resolves it the safe way. This is the only branch here that cannot
     * store a tag, and a tag stored for a document that was never parsed is the
     * one mistake that is permanent: the board would earn 304s forever on
     * something it has never successfully read. Landing on UNCHANGED instead
     * costs at most one missed edition, and even that self-corrects on the next
     * poll, because the tag did not move.
     *
     * Nothing is stored: the tag we SENT is still the tag for what is on the
     * glass, which is precisely what the server just confirmed. */
    if (not_modified) {
        out->fetch      = POWER_FETCH_UNCHANGED;
        out->store_etag = false;
        return;
    }

    if (!ok) {
        /* Transport, a non-2xx, a rejected payload, no URL. The rejected
         * payload is the one worth naming: it arrived carrying a perfectly good
         * ETag on a document that is not a front page, and writing that tag
         * down would make the next poll a 304. The device would never look at
         * that document again — stuck on yesterday's page indefinitely, with a
         * log full of successful fetches and nothing anywhere to say why. */
        out->fetch      = POWER_FETCH_FAILED;
        out->store_etag = false;
        return;
    }

    if (new_hash != old_hash) {
        /* Something new, and the tag is deliberately NOT recorded yet. This
         * wake is about to spend twenty-five seconds printing; write the tag
         * now and a brownout twenty seconds into that refresh leaves a board
         * whose next wake sends the new tag, receives a 304, and concludes
         * nothing changed. The edition never prints, for as long as the payload
         * holds still. The tag is published beside the hash after the refresh,
         * once the page is actually on the paper. */
        out->fetch      = POWER_FETCH_CHANGED;
        out->store_etag = false;
        return;
    }

    /* Parsed, and identical to what is already on the glass. The tag names a
     * document the panel is ALREADY displaying, so there is no refresh in
     * flight for it to get ahead of — and this is the only place it can be
     * recorded at all, because a wake that sleeps never reaches the code that
     * publishes after a refresh. Without this the ETag buys nothing on the
     * common path: a board would re-transfer and re-parse the whole payload on
     * every wake, forever. */
    out->fetch      = POWER_FETCH_UNCHANGED;
    out->store_etag = true;
}

void power_decide(const power_input_t *in, power_plan_t *out)
{
    out->action        = POWER_STAY_AWAKE;
    out->sleep_seconds = in->base_sleep_seconds;
    out->next_fails    = in->consecutive_fails;

    /* The safety gates come first and they are absolute. Each one is a way a
     * board becomes unreachable: sleeping while a developer is watching the
     * monitor, sleeping on USB with no cell to save, or sleeping with no URL to
     * poll — a demo board that wakes every fifteen minutes to fetch nothing.
     * They are checked before the cold-boot and stale-RTC forces below,
     * deliberately: on a bench, every reflash produces a stale RTC state, and a
     * gate that lost to it would put a board with no battery fitted to sleep
     * the first time anyone flashed it. */
    if (!in->sleep_enabled || !in->battery_present || in->usb_console ||
        !in->url_configured) {
        return;
    }

    /* A button woke us, so a person is standing in front of the frame. Staying
     * up costs 0.023 mAh a second and is incurred only when someone presses;
     * the standing cost is zero, and without it the companion app can never win
     * the race against a three-second window. What the poll returned does not
     * enter into it — the window opens on the press. */
    if (in->wake == POWER_WAKE_BUTTON) {
        return;
    }

    /* A cold boot has nothing on the glass it can vouch for: RTC memory does
     * not survive a power-on reset, so whatever is hanging there was printed by
     * a firmware and an edition this build knows nothing about. So does a wake
     * whose RTC magic did not match, which is how a firmware update announces
     * itself — and that case is the one worth spelling out, because it fails
     * silently and permanently. Flash new rendering code onto a board holding
     * an old content_hash and the first wake hashes the same payload, gets the
     * same number, concludes nothing moved, and sleeps. The changed rendering
     * never reaches the glass, for as long as the payload holds still: possibly
     * months, with nothing in any log to say so. Mixing the build id into the
     * magic turns a new binary into a mismatch, and this branch is what makes
     * the mismatch mean "print once".
     *
     * The counter resets with it. A board that was failing when it was unplugged
     * must not wake from its first cold boot already an hour into a backoff. */
    if (in->wake == POWER_WAKE_COLD || !in->rtc_valid) {
        out->action     = POWER_REFRESH_THEN_SLEEP;
        out->next_fails = 0;
        return;
    }

    switch (in->fetch) {
    case POWER_FETCH_CHANGED:
        /* The only outcome allowed to reach the panel repeatedly, and the only
         * reason the board is on the wall at all. */
        out->action     = POWER_REFRESH_THEN_SLEEP;
        out->next_fails = 0;
        break;

    case POWER_FETCH_UNCHANGED:
        /* The common case, and the whole design in one line: no refresh, no
         * LVGL, no framebuffer, no panel power. If this ever becomes a refresh
         * the cell is flat in three weeks. The counter clears, so one bad
         * afternoon does not leave the board on an hourly cadence all week. */
        out->action     = POWER_SLEEP_AGAIN;
        out->next_fails = 0;
        break;

    case POWER_FETCH_FAILED:
    case POWER_FETCH_NOT_ATTEMPTED:
    default:
        /* NOT_ATTEMPTED shares this arm on purpose. Wi-Fi that never came up is
         * not a quiet, successful poll; counting it as one would leave a board
         * whose network has gone away waking at full cadence forever, which is
         * precisely what the backoff exists to prevent — and it is the most
         * likely long-run failure of the lot, because a router outlives an
         * edition. `default` joins them so a value added to the enum later
         * lands on the conservative side rather than on "nothing changed".
         *
         * The counter saturates rather than wrapping. A wrap to zero looks
         * exactly like a recovery: the board would drop back to full cadence
         * and start counting again, burning the cell fastest at the moment it
         * has been failing longest. */
        if (out->next_fails < UINT16_MAX) {
            out->next_fails++;
        }
        out->sleep_seconds = power_backoff_seconds(in->base_sleep_seconds,
                                                   out->next_fails);

        /* And then it sleeps — however long it has been failing, and however
         * stale the sheet on the glass has become. That is the design's one
         * deliberate omission, and this is where somebody will come looking for
         * it, because the awake firmware badges the sheet OFFLINE as soon as a
         * poll stops working and a sleeping board never does.
         *
         * It cannot. A wake is a boot: RAM is gone, and sizeof(news_t) is 32,932
         * bytes against 8 KB of RTC memory, so the snapshot did not survive.
         * What did survive is the image on the glass, and it cannot be read
         * back. To badge a sheet you must redraw it, to redraw it you need a
         * snapshot, and the only one this arm could offer came from the fetch
         * that just failed — so what would actually print is the demo page.
         * Spending 2.3 mAh to replace a real, correct, merely stale front page
         * with a page about a company the board invented is worse than leaving
         * the glass alone. See "When the quiet path fails" in
         * docs/specs/2026-08-17-deep-sleep-design.md. */
        out->action = POWER_SLEEP_AGAIN;
        break;
    }
}

const char *power_action_name(power_action_t a)
{
    switch (a) {
    case POWER_SLEEP_AGAIN:        return "sleep";
    case POWER_REFRESH_THEN_SLEEP: return "refresh";
    case POWER_STAY_AWAKE:         return "awake";
    default:                       return "unknown";
    }
}
