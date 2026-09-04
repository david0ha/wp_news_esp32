// Thin AsyncStorage wrapper for the three independent bits of state the app persists between
// launches. They are three keys and not one enum on purpose: each answers a different question,
// and the bug this file was reshaped to fix came from a single flag being asked two of them.
//
//   - `claudepost.deviceBaseUrl`      A board is configured. The dashboard reconnects to this
//                                     address without rediscovering it.
//   - `claudepost.onboardingComplete` The wizard finished against real hardware.
//   - `claudepost.setupSkipped`       This phone chose "not now" — the person is past the front
//                                     door with no board behind them.
//
// The last two are not the same fact and must never be collapsed into one. "Finished" and "chose
// not to" would become the same byte forever, with no way to reconstruct the difference.
//
// A fourth thing, in two keys, joined this file later and for a different reason:
//
//   - `claudepost.newsUrl`            The edition address the *phone* wants the board to poll.
//   - `claudepost.newsUrlPending`     The board has not been told yet.
//
// The address used to live only on the board, so "change it" meant "POST it to the board right
// now", and a board with deep sleep on is unreachable by design for all but a few seconds an hour.
// Every save landed on a timeout and the setting could not be changed at all except by catching
// the board awake. So the phone now owns the setting and the board subscribes to it: a save writes
// here first, unconditionally, and `newsurlsync.ts` delivers it the next time any screen finds the
// board answering. The pending mark is what makes delivery idempotent — set on save, cleared on the
// first successful POST, and a strict `'1'` like the skip mark, for the same reason: a mark that
// reads wrongly as "delivered" loses the address silently, while one that reads wrongly as
// "pending" costs one redundant POST of the same URL, which the board treats as a no-op.
//
// And a fifth, which is about the phone alone and reaches no hardware at all:
//
//   - `claudepost.language`          Which language this app's own screens are drawn in.
//
// It is the *app's* language and not the edition's. An edition arrives carrying the language it
// was written in and is drawn in that language on any phone; this key decides the chrome around it.
// Storing one where the other was meant would make a Korean reader's English edition unreadable,
// or redraw the app every time the desk changed what it files.
//
// **The key strings are load-bearing.** Every install already on TestFlight carries the first two
// under exactly these names; renaming one is not a refactor, it is a silent re-onboarding of every
// shipped phone — the app wakes up believing nobody ever set a board up. `store.test.ts` pins all
// three literals for that reason.
//
// **Strict mark.** Both flags are true only on an exact literal — `'true'` and `'1'`. Missing,
// empty, `'yes'`, a future format we do not recognise, or a read that threw all read as *not set*.
// The failure direction is deliberate: falling to "not set" asks the question again, and a tap
// costs nothing. Falling the other way strands somebody who owns no board behind a wizard that
// cannot be completed, with nothing on screen explaining why.
//
// Reads are cached in-memory for the session so the entry screen doesn't re-hit disk on every
// render — but **a failed read is never cached**. Writing a definite answer into the cache off a
// storage hiccup turns one bad millisecond into a whole session of "no board, never onboarded";
// leaving the cache unset costs one more disk read and gets the truth on the next call.
//
// That rule only pays out if somebody *does* call again, and a caller who cannot tell a failed read
// from an empty store has no reason to. So the base URL — the one bit a provider latches for the
// whole session — is also readable three-valued through `peekDeviceBaseUrl`, which returns
// `undefined` for "the disk did not answer". The flags need no such thing: their failure direction
// is "ask again", and being asked again is the whole cost.

import AsyncStorage from '@react-native-async-storage/async-storage'
import { normalizeBaseUrl } from './discovery'
// From `../i18n/language` and not from `../i18n`, which is the barrel every screen uses: the
// provider in `../i18n/index.tsx` imports the two functions at the bottom of this file, so reaching
// for the barrel here would close a runtime import cycle. `language.ts` is a leaf that imports
// nothing, which is what it was split out to be.
import { isAppLanguage, type AppLanguage } from '../i18n/language'

// Namespaced under this board's own name. A phone that once ran the fortune board's app keeps its
// `tickerboard.*` entries untouched — those point at a different device on the same LAN, and
// inheriting one as "your board" would send every request to the wrong hardware.
const KEY_BASE_URL = 'claudepost.deviceBaseUrl'
const KEY_ONBOARDED = 'claudepost.onboardingComplete'
const KEY_SETUP_SKIPPED = 'claudepost.setupSkipped'
const KEY_NEWS_URL = 'claudepost.newsUrl'
const KEY_NEWS_URL_PENDING = 'claudepost.newsUrlPending'
const KEY_LANGUAGE = 'claudepost.language'

const SKIP_MARK = '1'
const PENDING_MARK = '1'

let onboardedCache: boolean | null = null
let skippedCache: boolean | null = null
let baseUrlCache: string | null | undefined // undefined = not yet read
let newsUrlCache: string | null | undefined // undefined = not yet read
let newsUrlPendingCache: boolean | null = null
let languageCache: AppLanguage | null = null

/**
 * How long to keep asking the disk, in milliseconds between attempts — four tries in under a
 * second and a quarter. It lives here rather than in either caller because there are two of them
 * now (the entry splash and `DeviceProvider`), both deciding the same thing from the same key, and
 * a second copy of the ladder is a second place for them to disagree about how patient the app is.
 *
 * It is bounded rather than endless because a read that keeps throwing is not a hiccup — it is a
 * corrupt or unreadable store, and retrying it forever would burn a timer for the life of the app
 * to keep re-learning the same thing. What each caller does when the list runs out is its own
 * decision and is argued at its own site; they only share the patience, not the surrender.
 */
export const READ_RETRY_DELAYS_MS = [120, 320, 800]

/**
 * The base-URL read with its three answers kept apart: a saved URL, `null` for "storage answered
 * and there is nothing saved", `undefined` for "storage did not answer at all".
 *
 * `getDeviceBaseUrl` below folds the last two together, which is safe for a caller that only wants
 * a candidate address to probe and fatal for one that turns the answer into a fact about the user.
 * The no-cache-on-failure rule this file is built around is only half a rule if the caller cannot
 * see that the read failed: the store dutifully retries on the next call, and nobody calls again,
 * because the first `null` already looked like a definite no. That is precisely how one rejected
 * read at launch used to pin `DeviceProvider.hasDevice` at `false` for a whole session — the Board
 * tab offering to set up a board the user already owns, Settings announcing "No board set up on
 * this phone." from a guess. The provider now asks this function instead, so it can tell "no" from
 * "no answer" and keep `hasDevice` at `null` — not known yet — until the disk actually speaks.
 *
 * A cached `null` is a real answer and comes straight back; only an unread or failed read is
 * `undefined`, so this is also the honest shape for "should I ask again?".
 */
export async function peekDeviceBaseUrl(): Promise<string | null | undefined> {
  if (baseUrlCache !== undefined) return baseUrlCache
  try {
    baseUrlCache = await AsyncStorage.getItem(KEY_BASE_URL)
  } catch {
    // Leave `baseUrlCache` undefined on purpose, and say so in the return value: the next caller
    // retries the disk instead of inheriting a wrong answer for the rest of the session.
    return undefined
  }
  return baseUrlCache
}

/**
 * The two-valued read, for callers that want an address or nothing and cannot be misled by the
 * difference. Both remaining ones — `board.retry()` and `settings.reconnect()` — spend the result
 * as one candidate in a `discoverDevice` list that also carries the live base URL and the mDNS
 * name, and both run from a button the user can press again; a failed read costs one candidate on
 * one probe and nothing else. Anything that would *remember* the answer, or draw a screen from it,
 * belongs on `peekDeviceBaseUrl` instead.
 */
export async function getDeviceBaseUrl(): Promise<string | null> {
  return (await peekDeviceBaseUrl()) ?? null
}

/** Persist a base URL, normalizing it first. Invalid input is ignored (returns false). */
export async function setDeviceBaseUrl(url: string): Promise<boolean> {
  const norm = normalizeBaseUrl(url)
  if (!norm.ok || !norm.value) return false
  baseUrlCache = norm.value
  try {
    await AsyncStorage.setItem(KEY_BASE_URL, norm.value)
  } catch {
    // best-effort
  }
  return true
}

/**
 * Forget the board on file. Returns whether the key actually left the disk.
 *
 * This is the one write in this module that may not be quietly best-effort, and the asymmetry is
 * worth stating. A failed *write* costs the user a repeat of something they can simply do again —
 * be asked to onboard once more, re-enter a URL. A failed **removal** is different in kind: the
 * cache is cleared either way, so the whole session agrees the board is gone — Settings says "No
 * board set up on this phone.", the Board tab draws the empty card, the host field empties — and
 * then the next cold launch reads the key straight back off the disk and the board returns, with
 * nothing anywhere having admitted that the removal failed. The user did not undo it and cannot
 * tell what did.
 *
 * So: retry on the shared ladder, and when it still will not go, say so in the return value rather
 * than swallowing it. `forgetBoard` hands that up to Settings, which is the only screen that can
 * tell the person the thing they asked for did not fully happen.
 */
export async function clearDeviceBaseUrl(): Promise<boolean> {
  baseUrlCache = null
  for (let attempt = 0; ; attempt++) {
    try {
      await AsyncStorage.removeItem(KEY_BASE_URL)
      return true
    } catch {
      if (attempt >= READ_RETRY_DELAYS_MS.length) return false
      await new Promise<void>((resolve) => setTimeout(resolve, READ_RETRY_DELAYS_MS[attempt]))
    }
  }
}

export async function isOnboardingComplete(): Promise<boolean> {
  if (onboardedCache !== null) return onboardedCache
  try {
    onboardedCache = (await AsyncStorage.getItem(KEY_ONBOARDED)) === 'true'
  } catch {
    // Cache stays null — see the header. One AsyncStorage hiccup must not mean "never onboarded"
    // until the app is killed.
    return false
  }
  return onboardedCache
}

export async function markOnboardingComplete(): Promise<void> {
  onboardedCache = true
  try {
    await AsyncStorage.setItem(KEY_ONBOARDED, 'true')
  } catch {
    // best-effort: cost of failure is showing the wizard again
  }
}

/** True only on the exact `'1'` mark — the strict-mark rule in the header, and why. */
export async function isSetupSkipped(): Promise<boolean> {
  if (skippedCache !== null) return skippedCache
  try {
    skippedCache = (await AsyncStorage.getItem(KEY_SETUP_SKIPPED)) === SKIP_MARK
  } catch {
    // Same as above: a thrown read is not an answer, so nothing is remembered from it.
    return false
  }
  return skippedCache
}

/**
 * Record "not now". The cache is set **before** the disk write is awaited, because the caller's
 * very next act is to navigate: a screen that reads this flag while the write is still in flight
 * must not be handed the pre-skip answer and bounce the user back into the wizard they just left.
 */
export async function markSetupSkipped(): Promise<void> {
  skippedCache = true
  try {
    await AsyncStorage.setItem(KEY_SETUP_SKIPPED, SKIP_MARK)
  } catch {
    // best-effort: cost of failure is being asked again on the next launch
  }
}

/**
 * Forget that this phone chose "not now". Exported with **no production caller today**, and that
 * is not an oversight waiting to be wired up: the entry gate ranks a configured board above the
 * skip mark, so setting a board up later never needs the mark cleared. It exists for a deliberate
 * "start over" and for the tests, and it is named as the exact inverse of `markSetupSkipped` so
 * that nobody reaches for `AsyncStorage.removeItem` with the key string spelled out a second time.
 */
export async function clearSetupSkipped(): Promise<void> {
  skippedCache = false
  try {
    await AsyncStorage.removeItem(KEY_SETUP_SKIPPED)
  } catch {
    // best-effort
  }
}

/**
 * The edition address this phone wants the board on, three-valued like `peekDeviceBaseUrl` and
 * for the same reason: a saved address, `null` for "storage answered and holds none", `undefined`
 * for "storage did not answer". `null` is not "demo" — the empty string is a real, saved value and
 * means exactly that (the board's own built-in edition), because clearing the field and saving is
 * a supported act and has to survive a relaunch like any other.
 *
 * The distinction matters to exactly one caller, the delivery in `newsurlsync.ts`, which has to
 * decide what a pending mark with no address under it means. From `null` it means the mark is
 * orphaned and should go; from `undefined` it means nothing yet, and clearing the mark on a disk
 * hiccup would lose an address the user did save. Screens take `getNewsUrl` below, where the two
 * fold together harmlessly: the editor's prefill falls back to the board's own copy.
 */
export async function peekNewsUrl(): Promise<string | null | undefined> {
  if (newsUrlCache !== undefined) return newsUrlCache
  let raw: string | null
  try {
    raw = await AsyncStorage.getItem(KEY_NEWS_URL)
  } catch {
    return undefined
  }
  newsUrlCache = decodeNewsUrl(raw)
  return newsUrlCache
}

/** The two-valued read, for screens. A failed read answers `null` and caches nothing. */
export async function getNewsUrl(): Promise<string | null> {
  return (await peekNewsUrl()) ?? null
}

/**
 * Drop the phone's copy of the address. Its one caller is the delivery, on finding a value under
 * the key that this file did not write; there is no "forget the address" control, because an
 * address is replaced by saving another and the demo edition is itself an address (`''`).
 */
export async function clearNewsUrl(): Promise<void> {
  newsUrlCache = null
  try {
    await AsyncStorage.removeItem(KEY_NEWS_URL)
  } catch {
    // best-effort
  }
}

// The address is stored JSON-encoded — `"https://…"` with the quotes — and the reason is the one
// value that is not a URL. The empty string means "demo data" and is a real, deliverable setting,
// but it is also the value most storage layers cannot tell from "nothing here": AsyncStorage's own
// Jest mock answers `'' || null`, and a backend that did the same on a phone would turn a saved
// "put the board on demo" into "never saved", which the sync then declines to deliver. Encoding
// makes the empty address `""`, two characters that survive anything a string does.
function encodeNewsUrl(url: string): string {
  return JSON.stringify(url)
}

function decodeNewsUrl(raw: string | null): string | null {
  if (raw === null) return null
  try {
    const value: unknown = JSON.parse(raw)
    return typeof value === 'string' ? value : null
  } catch {
    // Not something this file wrote. Reading it as "nothing saved" asks for the address again,
    // which is the cheap direction; reading it as an address would send garbage to the board.
    return null
  }
}

/**
 * Record the address the user asked for and mark it undelivered, in that order and both before the
 * caller can see the result. The cache is set before the write is awaited for the same reason
 * `markSetupSkipped` does it: the caller's next act is to try the board, and a screen that reads
 * the pending mark while the disk is still writing must see the save, not the state before it.
 *
 * The pending mark is set even when the caller is about to POST successfully a moment later and
 * clear it again. Two writes is the price of never having a saved address with no mark beside it:
 * that is the one state from which an undelivered address looks delivered forever.
 */
export async function saveNewsUrl(url: string): Promise<void> {
  newsUrlCache = url
  newsUrlPendingCache = true
  try {
    await AsyncStorage.setItem(KEY_NEWS_URL, encodeNewsUrl(url))
    await AsyncStorage.setItem(KEY_NEWS_URL_PENDING, PENDING_MARK)
  } catch {
    // best-effort: the cost is a re-entry of one address
  }
}

/** True only on the exact `'1'` mark. Missing, other, or a thrown read all read as delivered. */
export async function isNewsUrlPending(): Promise<boolean> {
  if (newsUrlPendingCache !== null) return newsUrlPendingCache
  try {
    newsUrlPendingCache = (await AsyncStorage.getItem(KEY_NEWS_URL_PENDING)) === PENDING_MARK
  } catch {
    // Not cached: a thrown read is not an answer.
    return false
  }
  return newsUrlPendingCache
}

/** The board has the address. Called by the one place that knows — after a successful POST. */
export async function clearNewsUrlPending(): Promise<void> {
  newsUrlPendingCache = false
  try {
    await AsyncStorage.removeItem(KEY_NEWS_URL_PENDING)
  } catch {
    // best-effort: the cost is one redundant POST of an address the board already holds
  }
}

/**
 * Which language the app's own chrome is drawn in — `system`, `en` or `ko`. See `src/i18n/`.
 *
 * `system` is the default and also every failure's answer: an unset key, a value this build does
 * not recognise (an older or newer install's spelling), and a read that threw all resolve to "ask
 * the phone", which is the same guess a fresh install makes and is right for most people. The
 * strict-value rule is the one the two marks above follow, for the same reason — a value read
 * loosely is a setting that changes itself.
 *
 * A failed read is not cached, so the next caller retries the disk rather than inheriting a guess
 * for the session. There is no three-valued `peek` beside it: nothing here draws a screen from the
 * *absence* of a language, and one frame of English on a phone whose disk stumbled costs a redraw.
 */
export async function getLanguage(): Promise<AppLanguage> {
  if (languageCache !== null) return languageCache
  let raw: string | null
  try {
    raw = await AsyncStorage.getItem(KEY_LANGUAGE)
  } catch {
    // Cache stays null — a thrown read is not an answer.
    return 'system'
  }
  languageCache = isAppLanguage(raw) ? raw : 'system'
  return languageCache
}

/**
 * Record the language choice. The cache is set before the write is awaited, as `markSetupSkipped`
 * does and for the same reason: the caller's next act is to re-render the app in the new language,
 * and a screen that reads this while the disk is still writing must see the choice, not the one
 * before it.
 */
export async function saveLanguage(choice: AppLanguage): Promise<void> {
  languageCache = choice
  try {
    await AsyncStorage.setItem(KEY_LANGUAGE, choice)
  } catch {
    // best-effort: the cost is one re-tap of a setting on the next launch
  }
}

/** Test hook: drop the in-memory caches so a fresh read hits the (mocked) store. */
export function __resetStoreCacheForTests(): void {
  onboardedCache = null
  skippedCache = null
  baseUrlCache = undefined
  newsUrlCache = undefined
  newsUrlPendingCache = null
  languageCache = null
}
