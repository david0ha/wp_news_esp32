// What SET UP LATER does, in one module because two screens offer it — turn-on and wifi-list —
// and the only interesting thing about it is an ordering that is invisible at both call sites.
// Inlined twice, the second copy is written from memory, and the memory is of two statements in
// some order rather than of the argument for that order.

import type { ImperativeRouter } from 'expo-router'

import { markSetupSkipped } from '../lib/store'

/**
 * The subset of expo-router's imperative API this needs. Narrow on purpose, and narrowed against
 * two different mistakes: a handler that can only `dismissTo` cannot grow a `push` later and
 * quietly leave the wizard on the stack behind the markets tab, and it cannot reach `dismissAll`,
 * which pops *inside* the wizard rather than out of it. Both are spelled out below.
 */
type Router = Pick<ImperativeRouter, 'dismissTo'>

/**
 * Record "not now", then leave the wizard for the markets tab.
 *
 * **The mark is written before the navigation, and never the other way round.** The entry gate
 * (`entryRouteFor`) re-decides where a cold launch lands by reading this same store, so the write
 * is not bookkeeping that can trail the user out of the room — it *is* the tap. Navigate first and
 * there is a window, short but real, in which the person is looking at their watchlist while the
 * store still says nobody has ever answered the wizard: a crash in that window, or the user
 * swiping the app away because they got what they came for, brings them back to
 * `/onboarding/turn-on` on the next launch. That is the exact wall SET UP LATER exists to remove,
 * re-erected by the control that removes it, and it would read to the user as the app having
 * forgotten a tap it visibly acted on.
 *
 * The `await` is sequencing, not a gate. `markSetupSkipped` absorbs its own storage failure and
 * resolves either way, so a disk that refuses the write still lets the user through — refusing to
 * leave the wizard because AsyncStorage hiccuped would trade the cheap failure (being asked again
 * next launch) for the expensive one (stranded again, with no explanation). It also sets the
 * in-memory cache before it touches disk, so the destination screen reads "skipped" even if the
 * write is still in flight.
 *
 * Not `push`: the wizard is being declined, not suspended. Pushed, it stays under the markets tab,
 * and a back gesture — or Android's hardware back — walks the user straight back into the screen
 * they just dismissed.
 *
 * Not `replace` either, which gets that much right and one thing wrong. Both exits resolve to the
 * app's *root* stack — expo-router diverges the action state for `/markets` against the live tree
 * at `(tabs)` vs `onboarding`, so the action is aimed at the stack that holds the pair — and
 * REPLACE swaps whatever sits at that stack's index. On a first run the root stack is `[onboarding]`
 * alone and the swap is exactly right, which is the only way SET UP LATER is on screen today:
 * `wizardOffersSkip` is false for the `'setup'` flow, so the pushed wizard never shows this
 * control. Wire it into a pushed wizard and the root stack is `[(tabs), onboarding]`, where REPLACE
 * makes `[(tabs)#a, (tabs)#b]` — a second, stale copy of the whole app mounted one back-gesture
 * below the one the user is looking at. `dismissTo` cannot make that mistake: it pops down to an
 * existing `(tabs)` when there is one, and falls back to replacing the current screen when there is
 * not, which is the first-run behaviour byte for byte. The exit stays correct however the wizard
 * was entered, rather than correct because of a rule two other files happen to enforce.
 *
 * Not `dismissAll()`, and not the `canDismiss()` test that looks like it guards it. Both answer
 * about the *closest* stack, which here is the onboarding stack rather than the root one: on
 * wifi-list that stack is already two deep, so `dismissAll()` would pop the user back to `turn-on`
 * — into the wizard, from inside the control whose whole job is leaving it.
 *
 * Markets is the destination because it is the one tab that needs no board at all: it imports
 * neither `useDevice` nor `lib/esp32`, so a skipper lands somewhere that is fully working rather
 * than somewhere that is merely reachable.
 */
export async function skipSetup(router: Router): Promise<void> {
  await markSetupSkipped()
  router.dismissTo('/markets')
}
