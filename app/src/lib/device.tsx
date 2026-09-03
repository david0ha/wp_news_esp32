// App-wide device connection state. Holds the resolved control-API base URL and a client bound
// to it, plus helpers to (re)point at a device or to forget the one on file. The base URL is
// loaded once from storage on mount; changing it (after onboarding, or via settings) re-creates
// the client and persists it.
//
// This provider now answers a question it used to assume away: *is there a board at all?* The
// wizard can be left by SET UP LATER, so a phone with no hardware is an ordinary state the whole
// UI has to be able to draw rather than an impossible one. Two consequences, both load-bearing
// and both argued on the fields below: `hasDevice` is tri-state, and `baseUrl` stays null when
// nothing is saved instead of being filled in with the mDNS default.
//
// EXPO_PUBLIC_ESP32_BASE_URL, when set (e.g. pointing at scripts/mock-esp32.js), overrides the
// stored value so simulator development hits the mock without any onboarding.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { createEsp32Client, type Esp32Client } from './esp32'
import { resolveBaseUrl } from './discovery'
import {
  READ_RETRY_DELAYS_MS,
  clearDeviceBaseUrl,
  getDeviceBaseUrl,
  peekDeviceBaseUrl,
  setDeviceBaseUrl as persistBaseUrl,
} from './store'

const ENV_BASE_URL = process.env.EXPO_PUBLIC_ESP32_BASE_URL

// The mount read backs off on the ladder store.ts owns — four tries in under a second and a
// quarter, all of them behind the entry splash, so a phone whose storage stumbled once still lands
// on the right screen with nothing visible having happened. What is decided *here* is what happens
// when the ladder runs out: the provider stops and leaves `hasDevice` at `null`. Still "not known
// yet", which is the truth, and which every reader already draws as a loading state. An indefinite
// "Connecting…" on a phone whose disk will not answer is a worse screen than the dashboard and a
// much better one than a confident "No board yet" shown to somebody holding the board.

interface DeviceContextValue {
  /**
   * Resolved control-API base URL. Null while storage is still answering — and null afterwards
   * too when nothing is saved, because a phone with no board configured has no board to name.
   */
  baseUrl: string | null
  /** A client bound to the current base URL (null until baseUrl resolves, and null with no board). */
  client: Esp32Client | null
  /**
   * Whether a board is configured on this phone — `null` until storage has answered.
   *
   * Half-known is unknown. The tempting two-state version starts at `false` and corrects itself a
   * tick later, which is harmless for a boolean and wrong for a screen: the first frame renders
   * before AsyncStorage has said anything, so every user who *does* own a board would watch
   * "No board yet" flash past on every cold launch. The readers of this field — the Board tab,
   * Settings and Preview — therefore branch on `null` first and hold a loading state, on `false`
   * for the no-board copy, and only then on a board. Never collapse `null` into `false` at a call
   * site: the whole point of the third value is that it is not yet an answer.
   */
  hasDevice: boolean | null
  /** Point at a new device: validate+persist, then re-create the client. Returns false if invalid. */
  setBaseUrl: (url: string) => Promise<boolean>
  /**
   * Forget the board on file: clear storage *and* this context, so no screen keeps talking to it.
   *
   * Returns false when the key would not leave the disk. The context is cleared either way — this
   * session is done with that board whatever storage thinks — so the boolean is not a rollback, it
   * is the one chance the UI gets to say that the board may be back after the next launch.
   */
  forgetBoard: () => Promise<boolean>
}

const DeviceContext = createContext<DeviceContextValue | null>(null)

export function DeviceProvider({ children }: { children: ReactNode }) {
  const [baseUrl, setBaseUrlState] = useState<string | null>(null)
  const [hasDevice, setHasDevice] = useState<boolean | null>(null)

  useEffect(() => {
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    ;(async () => {
      if (ENV_BASE_URL) {
        if (active) {
          setBaseUrlState(resolveBaseUrl({ manual: ENV_BASE_URL }))
          setHasDevice(true)
        }
        return
      }
      // This runs exactly once per launch, and whatever it decides is what the whole session
      // believes — nothing else re-reads storage into `hasDevice`. That is why it reads through
      // `peekDeviceBaseUrl` rather than `getDeviceBaseUrl`: the latter answers `null` both for "no
      // board is saved" and for "the read threw", and the store deliberately caches neither of
      // those as a definite no so that the *next* call gets the truth. With a single caller there
      // was no next call. One rejected read during the splash therefore used to pin
      // `hasDevice = false` for the rest of the session on a phone that owns a board: Board drew
      // NoBoardYet, Settings said "No board set up on this phone." and hid the news source, Preview
      // showed the empty card — all of it from a guess, and all of it the one sentence the design
      // says may only ever be spoken from storage. The store's care was being undone one layer up.
      //
      // So: retry on `undefined`, and commit only on an answer. Failing to answer is not an answer.
      for (let attempt = 0; ; attempt++) {
        const saved = await peekDeviceBaseUrl()
        if (!active) return
        if (saved !== undefined) {
          // `resolveBaseUrl` is total on purpose and stays that way: it falls back to the mDNS
          // default so that `board.retry()` and `settings.reconnect()` always have something to
          // hand `discoverDevice`, which is exactly right for a user whose board moved. What
          // changed here is that the provider stops asking it a question it has no answer to. With
          // nothing saved there is no board, and naming `http://claudepost.local` anyway invents
          // one: `client` was then never null, so the `if (!client)` guards on Board, Settings and
          // Preview were unreachable code, and a boardless phone spent its life timing out against
          // a hostname nobody answers to.
          setBaseUrlState(saved ? resolveBaseUrl({ saved }) : null)
          setHasDevice(!!saved)
          return
        }
        // Out of attempts. Leave `baseUrl` and `hasDevice` exactly as they started — null, meaning
        // not known — rather than settling for the wrong one of the two answers we could not tell
        // apart. `setBaseUrl` and `forgetBoard` still resolve it definitively from a user action,
        // so a phone in this state is stuck on a spinner, not stuck forever.
        if (attempt >= READ_RETRY_DELAYS_MS.length) return
        await new Promise<void>((resolve) => {
          timer = setTimeout(resolve, READ_RETRY_DELAYS_MS[attempt])
        })
        if (!active) return
      }
    })()
    return () => {
      active = false
      if (timer) clearTimeout(timer)
    }
  }, [])

  const setBaseUrl = useCallback(async (url: string) => {
    const ok = await persistBaseUrl(url)
    if (!ok) return false
    const saved = await getDeviceBaseUrl()
    setBaseUrlState(resolveBaseUrl({ saved }))
    setHasDevice(true)
    return true
  }, [])

  // Forget the board on file. This is the fix for the real defect in settings' old `reonboard()`:
  // it cleared AsyncStorage and navigated away, leaving this provider still holding the previous
  // baseUrl, client and hasDevice — so every screen went on polling a board the user had just
  // disowned, right up to the next cold launch. Storage and context have to move together, which is
  // why forgetting lives here rather than at the call site.
  //
  // It deliberately does not touch the onboarding-complete flag. That bit records that the wizard
  // once ran to the end against real hardware, and that stays true however many boards come and go;
  // the entry gate reads it alongside the now-absent URL and sends this user to the markets rather
  // than back through a wizard they already finished.
  //
  // The context is cleared whether or not the disk cooperates, and the removal's success is
  // reported rather than swallowed: a phone that agrees the board is gone all session and then
  // reads it back on the next launch has told the user something untrue, and only the screen they
  // pressed the button on can correct it.
  const forgetBoard = useCallback(async () => {
    const removed = await clearDeviceBaseUrl()
    setBaseUrlState(null)
    setHasDevice(false)
    return removed
  }, [])

  // Recreate the client whenever the base URL changes (so all screens share one client per URL).
  const client = useMemo(() => (baseUrl ? createEsp32Client({ baseUrl }) : null), [baseUrl])

  const value = useMemo<DeviceContextValue>(
    () => ({ baseUrl, client, hasDevice, setBaseUrl, forgetBoard }),
    [baseUrl, client, hasDevice, setBaseUrl, forgetBoard],
  )

  return <DeviceContext.Provider value={value}>{children}</DeviceContext.Provider>
}

export function useDevice(): DeviceContextValue {
  const ctx = useContext(DeviceContext)
  if (!ctx) throw new Error('useDevice must be used inside DeviceProvider')
  return ctx
}
