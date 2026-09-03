// The phone's edition address and the board that subscribes to it: what a save comes to, and how
// an address the board slept through gets delivered later.
//
// The address is the phone's setting (`store.ts`: `claudepost.newsUrl`) and the board is asleep
// most of the time by design. So delivery is not something a screen does when the user taps Save
// — that is only the first attempt — it is something every screen does whenever it has just found
// the board awake. Both places the app reads the board on a schedule (the Board tab's poll and
// Settings' focus load) call `syncPendingNewsUrl` right after a successful read, which is the one
// moment the board is known to be answering. One function, so that "what does delivering mean" is
// decided once: read the mark, POST, clear the mark on success, leave it on failure.
//
// And one pure function, `decideNewsUrlSave`, for what the Save button's own attempt means —
// which outcomes persist the address, which leave it pending, and which are a verdict on the
// address that must not be saved at all. It is pure and exported so that those rules can be
// tested as rules, rather than living in a screen this app has no way to render under test.

import { Esp32Error, humanError, type Esp32Client } from './esp32'
import { clearNewsUrl, clearNewsUrlPending, isNewsUrlPending, peekNewsUrl } from './store'

/**
 * Which failures mean "the board answered, and said no to this address" — as opposed to the board
 * not answering, or answering that it could not take anything just now. Only the first kind is a
 * verdict on the address; the rest are about the moment, and an address is not thrown away over a
 * moment. `bad_json` is here because it is a verdict too, even if on the app rather than the URL:
 * the request reached the board and was read, and sending it again unchanged will not go better.
 */
export function boardRefused(e: Esp32Error): boolean {
  return e.code === 'news_url_invalid' || e.code === 'too_large' || e.code === 'bad_json'
}

// ---------------------------------------------------------------------------
// The Save button's attempt.
// ---------------------------------------------------------------------------

/** How the one POST a save makes went. `error` is whatever was thrown, board error or not. */
export type NewsUrlSaveOutcome = { ok: true } | { error: unknown } | { noClient: true }

export type NewsUrlSaveDecision = {
  /** Write the address to the phone. False only when the board refused it. */
  persist: boolean
  /** Leave the delivery mark set — the board does not have it yet. */
  pending: boolean
  /** Which voice the sentence is said in: green, the help voice, or red. */
  tone: 'ok' | 'info' | 'error'
  message: string
}

/**
 * What a save came to, from the address and the outcome of the attempt to hand it to the board.
 *
 * The board is asked first and the phone written after, and the order is what lets a refusal be
 * honoured: an address the board refuses is a red error and is not saved anywhere, which cannot be
 * arranged by saving it first and then trying to un-save it. Every other outcome ends with the
 * phone holding the address — marked delivered when the board took it, pending when it did not.
 *
 * A timeout is the board asleep, and is the normal case rather than a failure: a board with deep
 * sleep on is unreachable by design between wakes. Anything else that is not a refusal — off the
 * Wi-Fi, busy redrawing, a 5xx, an error that is not even the client's — is the board not taking
 * it just now, and the sentence should not claim to know more than that. No client at all is its
 * own sentence again, because "asleep" would be a claim about a board this phone is not attached
 * to.
 */
export function decideNewsUrlSave(url: string, outcome: NewsUrlSaveOutcome): NewsUrlSaveDecision {
  if ('ok' in outcome) {
    return {
      persist: true,
      pending: false,
      tone: 'ok',
      message: url ? 'Saved. The board is fetching it now.' : 'Cleared — the board is back on demo data.',
    }
  }
  if ('noClient' in outcome) {
    return {
      persist: true,
      pending: true,
      tone: 'info',
      message:
        'Saved on this phone. Not connected to a board right now — it will be sent when this app reaches one.',
    }
  }
  const e = outcome.error
  if (e instanceof Esp32Error && boardRefused(e)) {
    return { persist: false, pending: false, tone: 'error', message: humanError(e) }
  }
  const asleep = e instanceof Esp32Error && e.code === 'timeout'
  return {
    persist: true,
    pending: true,
    tone: 'info',
    message: asleep
      ? 'Saved. The board is asleep, so it will get the new address the next time this app reaches it.'
      : 'Saved on this phone. The board didn’t take it just now — it will get the new address the next time this app reaches it.',
  }
}

// ---------------------------------------------------------------------------
// Delivery, later.
// ---------------------------------------------------------------------------

export type NewsUrlSyncResult =
  /** The mark was set and the board took the address; the mark is clear unless a newer save re-armed it. */
  | { status: 'sent' }
  /** Nothing was pending, so nothing was sent. */
  | { status: 'nothing' }
  /** The board did not answer, or the disk did not. The mark stays; the next successful read tries again. */
  | { status: 'failed' }
  /**
   * The board answered and refused the address. The mark is cleared, because sending the same
   * address again will not go better and a poll that retried it would do so every five seconds
   * forever. The address itself stays on the phone; the caller decides whether to say so.
   */
  | { status: 'rejected'; error: Esp32Error }

/**
 * Only the one method this needs, so a test can hand it a fake and so nothing here can be tempted
 * into reading state it was not given.
 */
export type NewsUrlSyncClient = Pick<Esp32Client, 'setNewsUrl'>

// One delivery at a time. The Board tab polls every five seconds and a POST to a board that has
// just woken can take most of that, so without this two polls could each find the mark set and
// each send the same address. The second is harmless to the board and pointless on the wire; more
// to the point, whichever finished first would clear the mark under the other, which then reports
// a `sent` for a POST that may still be in flight.
let inFlight: Promise<NewsUrlSyncResult> | null = null

export function syncPendingNewsUrl(client: NewsUrlSyncClient): Promise<NewsUrlSyncResult> {
  if (inFlight) return inFlight
  inFlight = deliver(client).finally(() => {
    inFlight = null
  })
  return inFlight
}

/**
 * Resolves once no delivery is in flight, starting none. The Save button awaits this before its
 * own POST, so that a save made while an older address is still on the wire cannot be overtaken
 * by it: two POSTs in flight land in whichever order the board takes them, and "the user's newest
 * address wins" is only true if the newest POST is also the last.
 */
export function settleNewsUrlSync(): Promise<void> {
  return inFlight ? inFlight.then(() => undefined, () => undefined) : Promise.resolve()
}

async function deliver(client: NewsUrlSyncClient): Promise<NewsUrlSyncResult> {
  if (!(await isNewsUrlPending())) return { status: 'nothing' }
  const url = await peekNewsUrl()
  if (url === undefined) {
    // The disk did not answer. The address may well be there; the mark stays and the next
    // successful read asks again.
    return { status: 'failed' }
  }
  if (url === null) {
    // A mark over nothing deliverable: no value under the key, or one this app did not write and
    // cannot decode. Neither will ever become an address, so the pair goes together — otherwise
    // the mark would be found set, and skipped, on every read for the life of the install.
    await clearNewsUrl()
    await clearNewsUrlPending()
    return { status: 'nothing' }
  }
  try {
    await client.setNewsUrl(url)
  } catch (e) {
    if (e instanceof Esp32Error) {
      if (boardRefused(e)) {
        await clearMarkIfStill(url)
        return { status: 'rejected', error: e }
      }
      return { status: 'failed' }
    }
    // Anything else is a bug in the client, not a board that did not answer. It still must not
    // escape into a five-second poll that has nothing to do with this address.
    console.warn('[newsurl] delivery threw outside the client’s error type', e)
    return { status: 'failed' }
  }
  await clearMarkIfStill(url)
  return { status: 'sent' }
}

/**
 * Clear the mark only if the address it stands for is the one this delivery was about. A POST can
 * take eight seconds to time out, and a user can save a second address inside that: the save
 * re-arms the mark for the new address, and the old delivery — which has no idea — then lands and
 * would clear it, leaving the phone on one address, the board on another, and nothing pending to
 * ever reconcile them. The mark belongs to whichever address was saved last, so an older delivery
 * may clear it only on finding that address unchanged.
 */
async function clearMarkIfStill(delivered: string): Promise<void> {
  if ((await peekNewsUrl()) === delivered) await clearNewsUrlPending()
}
