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

/* Anything the desk or NVS can say, held to the range the parser already holds
 * the wire to. A zero is not a short interval, it is "nobody said", and the
 * caller decides what that means; every other value comes back inside
 * [MIN, MAX]. */
static uint32_t clamp_poll(uint32_t s)
{
    if (s < POWER_POLL_MIN_SECONDS) return POWER_POLL_MIN_SECONDS;
    if (s > POWER_POLL_MAX_SECONDS) return POWER_POLL_MAX_SECONDS;
    return s;
}

void power_cadence(const power_cadence_in_t *in, power_cadence_t *out)
{
    /* 1. The base, and the desk outranks the board.
     *
     * That order is the design and not a preference. `policy.poll_seconds` is
     * the desk saying what the cadence is RIGHT NOW — it already knows about
     * its own quiet window and its own publishing schedule — while the local
     * interval is a number somebody typed once, months ago, into a form. The
     * awake poll loop has obeyed the desk since the desk shipped; a sleeping
     * board that did not would be the same board following two different rules
     * depending on which power mode it happened to be in.
     *
     * The local layer is the FALLBACK, for a payload with no policy block at
     * all: a file on a static web server, or the mock. And below that a
     * constant, because there is no input to this function that may produce
     * zero seconds — that arms a timer which fires immediately, and the board
     * boot-loops at full power looking, from the outside, exactly like a board
     * that will not start. */
    uint32_t base = 0;
    if (in->policy.poll_seconds) {
        base        = clamp_poll(in->policy.poll_seconds);
        out->source = POWER_CADENCE_POLICY;
    } else {
        base        = in->local_seconds ? clamp_poll(in->local_seconds)
                                        : POWER_POLL_FALLBACK_SECONDS;
        out->source = POWER_CADENCE_LOCAL;
    }

    /* 2. A targeted wake, when the desk named an instant that lands sooner than
     * the next ordinary poll. A board on an hourly overnight cadence still
     * catches the 06:00 edition at 06:00 rather than at 06:47, which is the
     * whole reason `next_change` is on the wire at all.
     *
     * STRICTLY IN THE FUTURE, and that is not what "min(poll, next_change -
     * now)" literally says. An instant that has already passed would floor at
     * MIN and keep flooring there — a static payload with a baked
     * `next_change`, or a cached copy of a live one, would pin the board at a
     * wake every thirty seconds for as long as it stayed up. Having arrived at
     * the instant, the ordinary cadence is the correct behaviour: whatever was
     * going to change has changed, and this poll is the one that collected it.
     *
     * And only when the clock is synced — see POWER_CLOCK_SYNCED_EPOCH. */
    if (in->policy.next_change > 0 &&
        in->now >= (int64_t)POWER_CLOCK_SYNCED_EPOCH) {
        const int64_t until = in->policy.next_change - in->now;
        if (until > 0 && until < (int64_t)base) {
            base = until > (int64_t)POWER_POLL_MIN_SECONDS
                       ? (uint32_t)until
                       : POWER_POLL_MIN_SECONDS;
            out->source = POWER_CADENCE_NEXT_CHANGE;
        }
    }

    /* 3. And the curve multiplies whatever the two above settled on. It is
     * applied HERE and nowhere else: power_decide() receives the answer as
     * `base_sleep_seconds` and takes it as final, so there is exactly one
     * place a backoff can be applied and no way for two of them to compound.
     *
     * Note what this does to a shortened base — row 14 of the table. A failing
     * board multiplies the 120-second targeted wake and overshoots the
     * transition rather than hammering it. That is deliberate: backing off
     * first and shortening second would have a board whose network is down
     * waking on the dot of every transition all night, which is precisely the
     * behaviour the curve exists to prevent. */
    out->seconds = power_backoff_seconds(base, in->consecutive_fails);
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
         * reason the board is on the wall at all.
         *
         * The count CARRIES rather than clearing, and that is the whole of D7:
         * a decision to print is not a print. main.cpp commits next_fails to
         * RTC memory here, before NewsTask has run — so a wake that clears the
         * count and then fails to fetch anything, times out
         * await_first_snapshot() and leaves the old edition on the glass has
         * printed nothing and told the next wake it was fine. It would sleep at
         * full cadence and do the same thing every fifteen minutes forever,
         * with no log line disagreeing.
         *
         * The reset belongs where a page reaches paper, which is
         * present_full(); the increment belongs where a wake gives up, which is
         * enter_sleep(). Neither is here, and `out->next_fails` is already
         * pre-set to `in->consecutive_fails` at the top of this function, so
         * carrying it is the absence of a line rather than a line. */
        out->action = POWER_REFRESH_THEN_SLEEP;
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

        /* And the sleep is `base_sleep_seconds` unchanged, because the backoff
         * has already been applied to it. power_cadence() owns the curve now —
         * it has to, since it is the only thing that knows the base the curve
         * should multiply (the desk's cadence, or a shortened targeted wake, or
         * the local interval). Multiplying again here would square it: at
         * fifteen minutes and five failures, 4,500 seconds becoming 22,500. The
         * cap hides that at an hour and stops hiding it the moment somebody
         * configures a two-hour interval, which is precisely the configuration
         * that cannot afford it. */

        /* And then it sleeps — however long it has been failing, and however
         * stale the sheet on the glass has become. That is the design's one
         * deliberate omission, and this is where somebody will come looking for
         * it, because the awake firmware badges the sheet OFFLINE as soon as a
         * poll stops working and a sleeping board never does.
         *
         * It cannot. A wake is a boot: RAM is gone, and sizeof(news_t) is 32,960
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
