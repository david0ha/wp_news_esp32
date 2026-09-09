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
// which outcomes persist the address, which leave it pending, which are a verdict on the address
// that must not be saved at all, and which of them are about a board this phone does not have. It
// is pure and exported so that those rules can be tested as rules, rather than living in a screen
// this app has no way to render under test.

import { Esp32Error, humanError, type Esp32Client } from './esp32'
import { type DeskProbe } from './edition/probe'
import { clearNewsUrl, clearNewsUrlPending, isNewsUrlPending, peekNewsUrl } from './store'
import { fill, strings } from '../i18n'

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

/** One sentence and the voice it is said in: green, the help voice, or red. */
export type SaveLine = { tone: 'ok' | 'info' | 'error'; message: string }

export type NewsUrlSaveDecision = {
  /** Write the address to the phone. False only when the board refused it. */
  persist: boolean
  /** Leave the delivery mark set — the board does not have it yet. */
  pending: boolean
  /**
   * WHAT THE ADDRESS ITSELF ANSWERED, and it is deliberately first.
   *
   * This is the line the person typing an address is actually waiting for, and until this field
   * existed the save could not say it: every sentence below is about the board, so a typo, a desk
   * that was down and a perfectly good address all confirmed identically and the only way to tell
   * them apart was to switch to Today and read the date on the page.
   *
   * `null` for a cleared address, which is not an address to ask (`DeskProbe`'s `skipped`).
   */
  desk: SaveLine | null
  /** What the BOARD came to — the delivery, which on most phones has not happened yet. */
  board: SaveLine
}

/**
 * What a save came to: from the address, the outcome of the attempt to hand it to the board,
 * whether this phone has a board at all, and what the address itself answered.
 *
 * TWO LINES, AND THE DESK'S GOES FIRST. The reader that uses this address is the phone — the
 * Today tab fetches it directly — and the board is a second, optional consumer that is asleep
 * most of the time by design. A confirmation that spoke only about the board therefore reported
 * on the least important half and stayed silent about the half the reader was about to see.
 *
 * THE DESK LINE NEVER DECIDES WHETHER TO SAVE. An address that did not answer is still saved,
 * loudly and in red: the desk may be mid-publish, the phone may be off the network, and throwing
 * the typing away over a moment is the one outcome that cannot be undone by waiting. Only the
 * board refusing the address — a verdict, not a moment — leaves nothing saved.
 *
 * The board is asked first and the phone written after, and the order is what lets a refusal be
 * honoured: an address the board refuses is a red error and is not saved anywhere, which cannot be
 * arranged by saving it first and then trying to un-save it. Every other outcome ends with the
 * phone holding the address — marked delivered when the board took it, pending when it did not.
 *
 * A timeout is the board asleep, and is the normal case rather than a failure: a board with deep
 * sleep on is unreachable by design between wakes. Anything else that is not a refusal — off the
 * Wi-Fi, busy redrawing, a 5xx, an error that is not even the client's — is the board not taking
 * it just now, and the sentence should not claim to know more than that.
 *
 * `hasBoard` exists for the one case where every sentence above is about hardware the reader does
 * not have. The News source editor used to hide itself without a board; it does not any more,
 * because the Today tab reads this same address, so "it will be sent when this app reaches one"
 * is now said to people who have never owned one and will never see it clear — nothing without a
 * client calls `syncPendingNewsUrl`. The mark still goes on, because a board set up later must
 * still receive the address; only the sentence changes, to name the reader that IS using it.
 *
 * IT IS `=== false`, NEVER `!hasBoard`. `null` means storage has not answered yet, and a sentence
 * about a board this phone may well own must not be said on a guess — the same rule the Board
 * card's "No board set up on this phone." line follows.
 */
export function decideNewsUrlSave(
  url: string,
  outcome: NewsUrlSaveOutcome,
  hasBoard: boolean | null,
  desk: DeskProbe,
): NewsUrlSaveDecision {
  return { ...decideBoardLine(url, outcome, hasBoard), desk: deskLine(desk) }
}

/**
 * The desk's half: what the address answered, said in the words of the reader that asked.
 *
 * A failure is `error` and not the help voice, and it is the only red line a save can show that
 * still ends with the address saved. That reads as a contradiction and is not one: the sentence
 * says the address is on the phone AND that nothing could be read from it, which is exactly the
 * state the phone is in and the state Today is about to show.
 */
function deskLine(desk: DeskProbe): SaveLine | null {
  const m = strings().settings.news.saved
  if (desk.status === 'skipped') return null
  if (desk.status === 'failed') {
    return { tone: 'error', message: fill(m.deskFailed, { detail: desk.message }) }
  }
  // A subject and a dateline are what make the line evidence rather than a claim — "the desk
  // answered" is something a captive portal can also produce, "Samsung Electronics, 2026년 9월 9일"
  // is not. Either can be absent from a payload this app still accepts, so the plain sentence is
  // the fallback rather than a line with an empty slot in it.
  if (desk.subject === '' && desk.dateline === '') return { tone: 'ok', message: m.deskOkPlain }
  const named = [desk.subject, desk.dateline].filter((s) => s !== '').join(', ')
  return { tone: 'ok', message: fill(m.deskOk, { edition: named }) }
}

/** The board's half — the delivery. Unchanged in what it decides; only its wording lost the "Saved", which the desk line above now carries. */
function decideBoardLine(
  url: string,
  outcome: NewsUrlSaveOutcome,
  hasBoard: boolean | null,
): { persist: boolean; pending: boolean; board: SaveLine } {
  // The catalogue is read here, inside the call, for the reason every other sentence catalogue in
  // `lib/` reads it here: this module is imported at startup, before a language has been resolved.
  // Which sentence is chosen has no language in it at all — that is the decision this function
  // exists to make, and it is unchanged.
  const m = strings().settings.news.saved
  if ('ok' in outcome) {
    return {
      persist: true,
      pending: false,
      board: { tone: 'ok', message: url ? m.fetching : m.clearedDemo },
    }
  }
  if ('noClient' in outcome) {
    if (hasBoard === false) {
      return {
        persist: true,
        pending: true,
        board: { tone: 'info', message: url ? m.todayOnly : m.clearedTodayDemo },
      }
    }
    return { persist: true, pending: true, board: { tone: 'info', message: m.noClient } }
  }
  const e = outcome.error
  if (e instanceof Esp32Error && boardRefused(e)) {
    return { persist: false, pending: false, board: { tone: 'error', message: humanError(e) } }
  }
  const asleep = e instanceof Esp32Error && e.code === 'timeout'
  return {
    persist: true,
    pending: true,
    board: { tone: 'info', message: asleep ? m.boardAsleep : m.boardBusy },
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
