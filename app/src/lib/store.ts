// Thin AsyncStorage wrapper for the one bit of state the app persists between launches: the
// board's last-known control base URL, so the Board tab reconnects without rediscovery.
//
// It is best-effort: a storage failure never throws into the UI, it just behaves as if nothing
// was saved (worst case: the user re-enters the address, or pairs the board again). Reads are
// cached in-memory for the session so a screen doesn't re-hit disk on every render.
//
// Migration — a phone upgrading from the pre-redesign app: `claudepost.onboardingComplete` is
// ignored and never written again. It gated the launch screen, and there is no launch gate any
// more: the app opens on Today whether or not a board was ever paired, and pairing lives under
// Settings. The key is deliberately left in storage rather than deleted — removing it would cost
// a write on every cold start to clean up a value nothing reads. `claudepost.deviceBaseUrl` is
// honoured exactly as before, so an upgraded phone still finds the board it was already using.

import AsyncStorage from '@react-native-async-storage/async-storage'
import { normalizeBaseUrl } from './discovery'

// Namespaced under this board's own name. A phone that once ran the fortune board's app keeps its
// `tickerboard.*` entries untouched — those point at a different device on the same LAN, and
// inheriting one as "your board" would send every request to the wrong hardware.
const KEY_BASE_URL = 'claudepost.deviceBaseUrl'

let baseUrlCache: string | null | undefined // undefined = not yet read

export async function getDeviceBaseUrl(): Promise<string | null> {
  if (baseUrlCache !== undefined) return baseUrlCache ?? null
  try {
    baseUrlCache = await AsyncStorage.getItem(KEY_BASE_URL)
  } catch {
    baseUrlCache = null
  }
  return baseUrlCache ?? null
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

export async function clearDeviceBaseUrl(): Promise<void> {
  baseUrlCache = null
  try {
    await AsyncStorage.removeItem(KEY_BASE_URL)
  } catch {
    // best-effort
  }
}

/** Test hook: drop the in-memory cache so a fresh read hits the (mocked) store. */
export function __resetStoreCacheForTests(): void {
  baseUrlCache = undefined
}
