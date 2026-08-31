import { useRouter } from 'expo-router'
import { OnTheGlass } from '../OnTheGlass'
import { useBoardScreen, useDeskState } from '../../lib/queries'
import { boardSinceStamp, refreshWindowMs } from '../../lib/format'
import type { DeviceState } from '../../lib/esp32'

/**
 * The board's own glass, live — `<OnTheGlass state="live">`, the same signature object Today draws
 * with the desk's proof instead. Board is the one screen allowed to wake and read the board's own
 * framebuffer for it, because it is the screen that is ABOUT the hardware: Today does not know
 * whether a board exists, and asking one would wake it.
 */
export function GlassSection({
  state,
  focused,
  refreshingUntilMs,
}: {
  state: DeviceState
  /** Whether the Board tab is the one on screen — passed down rather than assumed, because reading
   * the framebuffer is a megabyte off a board that may be asleep and `useBoardScreen` is explicit
   * that `enabled` is the caller's call. A `true` literal here would contradict that in the one
   * component it is documented for. */
  focused: boolean
  /** Epoch ms the ring counts down to — armed by a page switch or a poll-now succeeding
   * (`board.tsx` owns the mutations, since the ring has to survive whichever button fired it).
   * Past or undefined = idle. */
  refreshingUntilMs?: number
}) {
  const router = useRouter()
  const board = useBoardScreen(state, focused)
  // The desk's current edition id, so a tap can carry `eid` even on the board route — the fallback
  // to the desk's proof (`resolveGlassSource`, read by `sheet/[source].tsx`) only works once the
  // viewer knows which edition to fall back TO.
  const deskState = useDeskState()
  const eid = deskState.data?.current ?? ''

  const imageUri = board.data ? `data:image/png;base64,${board.data}` : undefined
  const refreshMs = refreshWindowMs(state.panel.refreshMs)
  const since = boardSinceStamp(state.source.ageSeconds, Date.now())

  return (
    <OnTheGlass
      state="live"
      imageUri={imageUri}
      since={since}
      refreshingUntilMs={refreshingUntilMs}
      refreshMs={refreshMs}
      onPress={() =>
        router.push(
          eid
            ? `/sheet/board?eid=${encodeURIComponent(eid)}&page=${state.page}`
            : `/sheet/board?page=${state.page}`,
        )
      }
    />
  )
}
