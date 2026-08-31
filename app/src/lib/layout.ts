// One measured fact about how this app's raised routes sit on the screen, in one place.

import { useRouter } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

/**
 * The top padding a raiseable route's own header needs — `0` when it was raised over something,
 * the status-bar allowance when it is the first screen of the stack.
 *
 * THE INSET IS CONDITIONAL, and it was measured rather than assumed. The root `SafeAreaProvider`
 * (`app/_layout.tsx`) hands every consumer the WINDOW's insets, so inside a `formSheet` — which iOS
 * has already presented below the status bar — `insets.top` still reports the device's full
 * allowance: 62 pt on an iPhone 17 Pro, measured off two screenshots of the same sheet with and
 * without it. Applied unconditionally that is a band of dead chrome above a sheet only half a
 * screen tall. Dropped unconditionally, the header lands on the clock in the case both routes are
 * reachable in: a deep link or a cold start straight into `/compose` or `/sheet/proof`, where the
 * FIRST screen of a stack does not get its `presentation: 'formSheet'`.
 *
 * `canGoBack()` is what distinguishes the two — nothing behind means nothing raised this.
 *
 * It lives here because the two screens that need it (`<Composer>` and the sheet viewer) landed on
 * opposite sides of that condition by accident of how they are presented, and each had written the
 * same paragraph and the same arithmetic out for itself. A third viewer, or a change to how
 * `_layout.tsx` presents either route, would have had to keep two copies in step with nothing to
 * catch a drift between them.
 */
export function useRaisedHeaderInset(): number {
  const insets = useSafeAreaInsets()
  const router = useRouter()
  return router.canGoBack() ? 0 : insets.top
}
