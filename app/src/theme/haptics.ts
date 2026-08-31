// The feedback that travels with `press.ts`'s treatment — the same argument, one sense over.
//
// Nine call sites spelled `Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)` out in full, all
// of them for the same event: the desk took a write, and the phone says so in the hand at the same
// moment the screen says so in words (`<Composer>`'s own rule — "a tap the phone acknowledges in
// the hand must also be acknowledged on the screen"). Nine copies of one decision is nine places to
// edit if the style ever changes, or if this ever goes behind a setting; the point of the helper is
// that it becomes one.
import * as Haptics from 'expo-haptics'

/**
 * The desk answered — one light tap.
 *
 * Fire-and-forget on purpose. `impactAsync` resolves once the taptic engine has been asked, which
 * is not a fact any caller has a use for, and on a device with no engine (a simulator, an Android
 * without one) it simply does nothing. An unhandled rejection here would be an error screen over a
 * write that actually succeeded, so the promise is swallowed rather than propagated.
 */
export function tapLight(): void {
  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {})
}

/**
 * A selection moved — a segmented control, a filter.
 *
 * A different physical event from `tapLight()` and deliberately not folded into it: iOS's own
 * selection feedback is lighter and is what a picker is supposed to feel like, where the impact is
 * for something having happened.
 */
export function tapSelection(): void {
  void Haptics.selectionAsync().catch(() => {})
}
