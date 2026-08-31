import { useCallback } from 'react'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { Composer, composerKind } from '../components/desk/Composer'

/**
 * The composer — a form sheet for ordering an edition or filing a research request, raised from
 * Desk (plan Design > Wireframes, "ORDER"). `formSheet` on purpose (see `app/_layout.tsx`): what
 * raised it stays visible behind, so the queue the order is about to land in is still on screen.
 *
 * `?kind=` preselects the segmented control, so "Order today's edition" and "Research a ticker" are
 * two buttons onto one sheet rather than two sheets. Anything else — a deep link with a kind this
 * app does not file, or none at all — lands on `edition`, which is the ordinary case.
 *
 * `canGoBack()` before `back()`: this route is reachable directly (a deep link, a cold start into
 * it), and `back()` with nothing behind it is a dismissal that leaves the app on no screen at all.
 */
export default function Compose() {
  const router = useRouter()
  const { kind } = useLocalSearchParams<{ kind?: string }>()

  const onDone = useCallback(() => {
    if (router.canGoBack()) {
      router.back()
    } else {
      router.replace('/desk')
    }
  }, [router])

  return <Composer initialKind={composerKind(kind)} onDone={onDone} />
}
