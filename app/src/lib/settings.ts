// The desk connection: base URL + bearer token. Owned separately from the board's own address
// (src/lib/store.ts keeps `claudepost.deviceBaseUrl` — the device is found on the LAN, the desk is
// configured once). The two settings have different security postures:
//
//   - the desk is reachable from the public internet by construction (it sits behind a Cloudflare
//     tunnel, docs/hosting-cloudflare.md), so app.json's ATS exception only covers the LAN device —
//     a desk address must be https://, and plain http:// is legal only when it names a device on
//     the phone's own network (the same LAN the ATS exception already trusts). iOS enforces this at
//     the OS level for *some* hosts; Android's cleartext flag is project-wide, so this module is
//     the enforcement for both, and the human sentence below is what the Settings screen shows.
//   - the token authenticates every producer/operator request. Unlike the base URL it never goes
//     into AsyncStorage — it lives in SecureStore (Keychain / Android Keystore), the same place
//     any other app credential would.
//
// Both are read via a dev-only EXPO_PUBLIC_DESK_BASE_URL / EXPO_PUBLIC_DESK_TOKEN override, the
// same idea as EXPO_PUBLIC_ESP32_BASE_URL in device.tsx/esp32.ts. Unlike those, this module has no
// once-per-mount lifecycle to cache the env var against, so it's read fresh on every call — cheap,
// and it lets a test flip process.env between calls instead of reimporting the module.

import AsyncStorage from '@react-native-async-storage/async-storage'
import * as SecureStore from 'expo-secure-store'
import { normalizeBaseUrl } from './discovery'
import type { DeskState } from './desk'

const KEY_DESK_URL = 'claudepost.deskUrl'
const KEY_DESK_TOKEN = 'claudepost.deskToken'

const ATS_SENTENCE =
  'The desk needs https://. Plain http:// only works for an address on your own network, like claudepost.local or 192.168.1.10.'

let deskUrlCache: string | null | undefined // undefined = not yet read
let deskTokenCache: string | null | undefined

export interface SetDeskUrlResult {
  ok: boolean
  /** A sentence fit to show in the Settings screen as-is. Absent when ok. */
  error?: string
}

export interface ValidateDeskUrlResult {
  ok: boolean
  /** The normalized address, present only when ok. */
  value?: string
  /** A sentence fit to show in the Settings screen as-is. Absent when ok. */
  error?: string
}

export interface DeskSettings {
  baseUrl: string | null
  token: string | null
}

function humanizeNormalizeError(error: string | undefined): string {
  switch (error) {
    case 'empty':
      return 'Enter a desk address.'
    case 'bad_scheme':
      return 'Only http:// and https:// addresses are supported.'
    case 'bad_port':
      return "That port isn't valid."
    case 'bad_host':
    default:
      return "That doesn't look like a valid address."
  }
}

// Checked on the raw input, before normalizeBaseUrl: a `user:pw@host` authority already fails
// normalizeBaseUrl's host/port shape checks (the '@' and whatever follows it don't parse as either),
// but only with a generic bad_host/bad_port code. Catching it here first names the actual problem.
function hasEmbeddedCredentials(raw: string): boolean {
  const afterScheme = raw.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '')
  const authority = afterScheme.split(/[/?#]/)[0]
  return authority.includes('@')
}

// RFC 1918 plus the names the ATS exception (and the firmware's own mDNS advertisement) already
// treat as "this phone's own network": *.local, localhost, 127.0.0.1, 10/8, 172.16/12, 192.168/16.
function isLanHost(host: string): boolean {
  if (host === 'localhost' || host === '127.0.0.1') return true
  if (host.endsWith('.local')) return true
  const m = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host)
  if (!m) return false
  const a = Number(m[1])
  const b = Number(m[2])
  if (a === 10) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  return false
}

// Pulls {scheme, host} back out of a value normalizeBaseUrl already validated and canonicalized —
// safe to do with a simple split since that value's host can no longer contain '@', ':' (besides
// the one port separator) or a path.
function parseNormalized(value: string): { scheme: string; host: string } {
  const [scheme, rest] = value.split('://')
  const host = rest.split(':')[0]
  return { scheme, host }
}

export async function getDeskUrl(): Promise<string | null> {
  const envUrl = process.env.EXPO_PUBLIC_DESK_BASE_URL
  if (envUrl) {
    const norm = normalizeBaseUrl(envUrl)
    return norm.ok && norm.value ? norm.value : envUrl.trim()
  }
  if (deskUrlCache !== undefined) return deskUrlCache ?? null
  try {
    deskUrlCache = await AsyncStorage.getItem(KEY_DESK_URL)
  } catch {
    deskUrlCache = null
  }
  return deskUrlCache ?? null
}

/**
 * Validate, normalize and apply the ATS rule, WITHOUT touching storage.
 *
 * `setDeskUrl` is this plus a write; Settings' "Test the connection" is this plus a request —
 * and must be able to check an address the owner has typed but not yet saved, without persisting
 * anything on their behalf just because they tapped Test.
 */
export function validateDeskUrl(input: string): ValidateDeskUrlResult {
  const raw = (input ?? '').trim()

  if (hasEmbeddedCredentials(raw)) {
    return { ok: false, error: 'Remove the username and password from the address.' }
  }

  const norm = normalizeBaseUrl(raw)
  if (!norm.ok || !norm.value) {
    return { ok: false, error: humanizeNormalizeError(norm.error) }
  }

  const { scheme, host } = parseNormalized(norm.value)
  if (scheme === 'http' && !isLanHost(host)) {
    return { ok: false, error: ATS_SENTENCE }
  }

  return { ok: true, value: norm.value }
}

/** Validate, apply the ATS rule, and persist. Invalid/refused input leaves storage untouched. */
export async function setDeskUrl(input: string): Promise<SetDeskUrlResult> {
  const result = validateDeskUrl(input)
  if (!result.ok) return { ok: false, error: result.error }

  deskUrlCache = result.value!
  try {
    await AsyncStorage.setItem(KEY_DESK_URL, result.value!)
  } catch {
    // best-effort, matches store.ts's setDeviceBaseUrl
  }
  return { ok: true }
}

export async function getDeskToken(): Promise<string | null> {
  const envToken = process.env.EXPO_PUBLIC_DESK_TOKEN
  if (envToken) return envToken
  if (deskTokenCache !== undefined) return deskTokenCache ?? null
  try {
    deskTokenCache = await SecureStore.getItemAsync(KEY_DESK_TOKEN)
  } catch {
    // A locked device (or SecureStore otherwise unavailable) must not throw into the UI — the
    // caller sees "no token configured" and the user is prompted to enter one, same as a fresh
    // install. The underlying error is discarded rather than surfaced, so it can't end up in a
    // log line or an error banner with the token's storage details attached.
    deskTokenCache = null
  }
  return deskTokenCache ?? null
}

/** Persist a token; an empty string clears it instead (mirrors leaving a Settings field blank). */
export async function setDeskToken(token: string): Promise<void> {
  const trimmed = (token ?? '').trim()
  if (trimmed === '') {
    await clearDeskToken()
    return
  }
  deskTokenCache = trimmed
  try {
    await SecureStore.setItemAsync(KEY_DESK_TOKEN, trimmed)
  } catch {
    // best-effort, matches store.ts's setDeviceBaseUrl
  }
}

export async function clearDeskToken(): Promise<void> {
  deskTokenCache = null
  try {
    await SecureStore.deleteItemAsync(KEY_DESK_TOKEN)
  } catch {
    // best-effort
  }
}

/**
 * Whether a token is stored, without exposing it. Settings shows this rather than the secret
 * itself, so the token field can say "saved" without ever holding the value in render state.
 */
export async function hasDeskToken(): Promise<boolean> {
  return (await getDeskToken()) !== null
}

/**
 * A quietly affirmative line for a successful "Test the connection" in Settings — the desk's
 * current edition, when it has one, because that is the one fact that proves the address and
 * token actually reach a working desk rather than just a server that answers 200.
 */
export function deskTestResultLine(state: Pick<DeskState, 'current'>): string {
  return state.current === null
    ? 'Connected — nothing published yet.'
    : `Connected — current edition ${state.current.slice(0, 8)}.`
}

/** What the desk client (src/lib/queries.ts) reads once to build its client. */
export async function getDeskSettings(): Promise<DeskSettings> {
  const [baseUrl, token] = await Promise.all([getDeskUrl(), getDeskToken()])
  return { baseUrl, token }
}

/** Test hook: drop the in-memory caches so a fresh read hits the (mocked) store. */
export function __resetSettingsCacheForTests(): void {
  deskUrlCache = undefined
  deskTokenCache = undefined
}
