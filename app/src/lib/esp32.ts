// Client for Claude Post's two HTTP/JSON APIs (firmware:
// components/provisioning/prov_portal.c + components/device_api). See docs/app-control.md and
// components/provisioning/README.md for the contract — this file is the TypeScript mirror of it,
// and the only place in the app that knows a field name. The field names themselves come from
// components/news_core/device_api_json.c, which writes the bytes.
//
// [1] Provisioning (SoftAP, http://192.168.4.1): join the board's setup AP first.
//   GET  /api/info       -> { deviceId, model, apSsid }
//   GET  /api/scan       -> { networks: [{ ssid, rssi, secure }] }
//   POST /api/provision  (x-www-form-urlencoded: ssid, password, news_url?) -> 202 | 4xx
//   GET  /api/status     -> { state: idle|connecting|connected|failed, ssid?, reason? }
//
// [2] Control (STA, http://claudepost.local or the board's IP): same home Wi-Fi.
//   GET  /api/info          -> { deviceId, model, fw, ip }
//   GET  /api/state         -> DeviceState snapshot (polled by the dashboard)
//   GET  /api/screen        -> the framebuffer, 960,000 bytes (see ./screen.ts)
//   POST /api/refresh       -> poll the news source now
//   POST /api/page          { page: 0|1 }        // 0 = A1 front page, 1 = A2 accounts
//   POST /api/news          { url }              // '' switches the board to its demo edition
//   POST /api/sleep         { seconds }          // 0 = the build-time default
//   POST /api/display/test  -> run the e-Paper self-test sweep
//
// EVERY ONE OF THESE ANSWERS ONLY WHILE THE BOARD IS AWAKE. A board on a battery with deep sleep
// on spends about three seconds awake per interval and runs no HTTP server the rest of the time,
// so a timeout is the normal state of a healthy board rather than a fault — which is why a timeout
// gets its own error code here and its own sentence in humanError(), instead of being folded into
// a network failure and reported as "check your Wi-Fi".
//
// Every function takes an injectable fetch/clock so it can be unit-tested without a board.

import { FB_SIZE, SCREEN_BPP, SCREEN_FORMAT, SCREEN_H, SCREEN_STRIDE, SCREEN_W } from './screen'

// ---------------------------------------------------------------------------
// Response types (one interface per documented payload).
// ---------------------------------------------------------------------------

export interface DeviceInfo {
  deviceId: string
  model: string
  /** Only present over the SoftAP (provisioning). Empty string in STA mode. */
  apSsid: string
  /** Firmware version — present over STA (GET /api/info), '' over the AP. */
  fw: string
  /** Station IP — present over STA, '' over the AP. */
  ip: string
}

export interface ScanNetwork {
  ssid: string
  rssi: number
  secured: boolean
}

export type ProvisionState = 'idle' | 'connecting' | 'connected' | 'failed'

export interface ProvisionStatus {
  state: ProvisionState
  ssid?: string
  // Failure reason from GET /api/status when state==='failed' (e.g. 'auth_failed',
  // 'save_failed', 'internal_error'). Kept as a free string since the app only displays it.
  reason?: string
}

/**
 * How the board's last poll of the news URL went (`source.lastResult`). These are the firmware's
 * own strings — the three failures are separate codes because they send the user to three
 * different places: `transport` is DNS/connect/timeout (is the desk awake?), `http_status` means
 * the server answered but not with a 2xx (is the path right?), and `bad_payload` means it answered
 * 2xx with something that is not an edition (is that a captive portal?).
 *
 * `not_modified` is a **success**, not a failure: it is a 304 against the ETag the board sent, and
 * on a board polling all day it is the most common outcome there is. A client that colours it as
 * an error paints a healthy board red for most of its life.
 */
export type NewsFetchResult =
  | 'ok'
  | 'no_url'
  | 'transport'
  | 'http_status'
  | 'bad_payload'
  | 'not_modified'
  /** Anything the firmware might add later — rendered neutrally rather than crashing the row. */
  | 'unknown'

const FETCH_RESULTS: readonly string[] = [
  'ok',
  'no_url',
  'transport',
  'http_status',
  'bad_payload',
  'not_modified',
]

/** The company this edition is about (GET /api/state, `news.subject`). */
export interface NewsSubject {
  symbol: string
  name: string
  exchange: string
  sector: string
  /**
   * Money in cents and a change in basis points (`bp = pct × 100`). Integers on both sides of the
   * wire — the app owns the decimal separator, the sign and which of green and red goes with
   * which, because the firmware deciding those too is how the two drift apart.
   */
  lastCents: number
  changeBp: number
  prevCloseCents: number
  openCents: number
  highCents: number
  lowCents: number
  /** 0 means UNKNOWN, not a price of nothing. Draw an unknown bound as absent. */
  wk52HighCents: number
  wk52LowCents: number
}

/**
 * What arrived, AFTER parsing (GET /api/state, `news.counts`).
 *
 * This is the difference between "the producer filed a thin day" and "the parser dropped
 * something" — a distinction no other field can make. The figures themselves do not travel; a
 * reader who wants them is standing in front of them.
 */
export interface NewsCounts {
  stories: number
  figures: number
  briefs: number
  peers: number
  tables: number
  charts: number
  indices: number
  thumbs: number
}

/** One headline the board set, carrying the desk's rank so a list sorts the way the paper reads. */
export interface Headline {
  rank: number
  headline: string
}

/** One cell of the tape (GET /api/state, `news.indices`). */
export interface IndexCell {
  symbol: string
  lastCents: number
  changeBp: number
}

/** The edition on the glass, as the board understands it (GET /api/state, `news`). */
export interface NewsSummary {
  /** An edition has been parsed at least once. False on a board that has never had a good poll. */
  valid: boolean
  /** The board is showing its built-in demo edition (no news URL). A complete configuration. */
  demo: boolean
  /** The desk's name for the day's edition, e.g. "SEMICONDUCTORS". */
  edition: string
  /** When the producer generated it, as it reported it (ISO 8601). */
  generatedAt: string
  subject: NewsSubject
  counts: NewsCounts
  headlines: Headline[]
  indices: IndexCell[]
}

/** Who decided the poll cadence in force. */
export type PollSource = 'config' | 'policy'

const POLL_SOURCES: readonly string[] = ['config', 'policy']

/** Where the board is fetching from and how that is going (GET /api/state, `source`). */
export interface NewsSource {
  /** Configured edition URL. Empty string = unconfigured, running on the demo edition. */
  url: string
  lastResult: NewsFetchResult
  /** The cadence IN FORCE, which a payload's `policy` block can move. */
  pollSeconds: number
  /**
   * Which layer set it. A number that can come from two places says nothing on its own: an hourly
   * poll the desk asked for ends when its quiet window does, and an hourly poll built into the
   * image does not.
   */
  pollSource: PollSource
  /** Seconds since the last SUCCESSFUL poll; -1 when none has ever succeeded. */
  ageSeconds: number
  /** The board has decided what is on the glass is old and has badged it. */
  stale: boolean
}

export interface BatteryInfo {
  present: boolean
  percent: number
  millivolts: number
}

/**
 * Measured panel timing (GET /api/state, `panel`).
 *
 * Not decoration: the whole refresh policy — one refresh per changed edition, none for a clock
 * tick, no partial anything — rests on "twenty to thirty seconds", and this is that figure
 * measured on THIS panel rather than taken from the vendor. Spectra 6 has one kind of refresh, so
 * there is one number; the partial/full pair the 5.83" board reported is gone.
 */
export interface PanelInfo {
  refreshMs: number
}

/**
 * Which of the four layers set the sleep interval (`power.sleepSource`).
 *
 * Not decoration either: an interval a desk set for the night ends by itself, and one compiled
 * into the image does not. `policy` outranks all three local layers. `api` does not survive a
 * sleep — that call writes NVS too, so after the next wake the same number honestly reads `nvs`.
 */
export type SleepSource = 'policy' | 'api' | 'nvs' | 'default'

const SLEEP_SOURCES: readonly string[] = ['policy', 'api', 'nvs', 'default']

/** The design measuring itself (GET /api/state, `power`). */
export interface PowerInfo {
  deepSleep: boolean
  /** The interval the board will ACTUALLY sleep for — power_cadence()'s answer, not the setting. */
  sleepSeconds: number
  sleepSource: SleepSource
  /** Boots since the last COLD one. Unplugging the board resets these; that is correct. */
  wakes: number
  /** The wakes that cost no refresh. `wakes - quietWakes` reached the paper. */
  quietWakes: number
  /** Mean length of a COMPLETED wake. Read it after a day, not after a minute. */
  meanAwakeMs: number
  /** The AWAKE-TIME TERM ONLY — no refreshes, no standing sleep current. Expect the real one higher. */
  estMahPerDay: number
}

/** The live snapshot the dashboard polls (GET /api/state). */
export interface DeviceState {
  deviceId: string
  model: string
  fw: string
  ip: string
  /** Page currently on the panel: 0 = A1, the front page; 1 = A2, the company's accounts. */
  page: number
  /** The board's own title for that page — the ground truth for what is on the glass. */
  pageTitle: string
  news: NewsSummary
  source: NewsSource
  battery: BatteryInfo
  panel: PanelInfo
  power: PowerInfo
}

// ---------------------------------------------------------------------------
// Errors. Codes from both API surfaces in docs/app-control.md, plus client-side ones.
// ---------------------------------------------------------------------------

export type Esp32ErrorCode =
  // POST /api/provision (4xx body `error`)
  | 'ssid_empty'
  | 'ssid_too_long'
  | 'pass_too_long'
  // Shared by /api/provision and the control writes
  | 'news_url_invalid'
  | 'too_large'
  | 'read_error'
  // POST /api/* (4xx body `error`)
  | 'bad_json'
  | 'page_range'
  | 'sleep_seconds_invalid'
  | 'busy'
  // GET /api/screen (503 body `error`) — the request was fine, the board had not finished booting
  | 'no_framebuffer'
  // Client-side
  | 'screen_size'
  | 'screen_format'
  | 'timeout'
  | 'http_error'
  | 'network_error'

export class Esp32Error extends Error {
  code: Esp32ErrorCode
  /** HTTP status of the failed response, when there was one. */
  status?: number
  constructor(code: Esp32ErrorCode, message?: string, status?: number) {
    super(message ?? code)
    this.name = 'Esp32Error'
    this.code = code
    this.status = status
  }
}

/**
 * A sentence per failure, saying what to go and do.
 *
 * Lives here rather than in a screen because two screens now need the same words, and because the
 * one sentence that matters most — a timeout — is a statement about the DEVICE and not about the
 * screen that happened to ask. A board with deep sleep on is unreachable most of the time by
 * design; telling its owner to check their Wi-Fi would send them to look for a fault that is not
 * there.
 */
export function humanError(e: Esp32Error): string {
  switch (e.code) {
    case 'timeout':
      return 'No answer — the board is probably asleep. It wakes for a few seconds at a time and runs no server in between; press a button on it, then try again.'
    case 'network_error':
      return 'Couldn’t reach the board. Check it’s powered on and on the same Wi-Fi.'
    case 'page_range':
      return 'That page doesn’t exist. The board has two: A1, the front page, and A2, the accounts.'
    case 'news_url_invalid':
      return 'The board wouldn’t accept that address.'
    case 'sleep_seconds_invalid':
      return 'The board takes an interval of 60 seconds to 24 hours, or 0 for its built-in default.'
    case 'busy':
      return 'The board is busy redrawing. A refresh of this panel takes twenty to thirty seconds — try again after that.'
    case 'no_framebuffer':
      return 'The board is answering but hasn’t finished starting up. Give it a moment.'
    case 'screen_size':
      return 'The page came back the wrong size — the download was cut short. Try again.'
    case 'screen_format':
      return 'This board is sending a screen format this app doesn’t know. Update the app.'
    case 'bad_json':
      return 'The board couldn’t read that request. This is a bug in the app, not something you did.'
    case 'too_large':
      return 'That was too long for the board to accept.'
    case 'read_error':
      return 'The board lost the request halfway through. Try again.'
    case 'ssid_empty':
      return 'Pick a Wi-Fi network first.'
    case 'ssid_too_long':
      return 'That network name is longer than the board can store.'
    case 'pass_too_long':
      return 'That password is longer than the board can store.'
    case 'http_error':
      return 'The board answered with an error. Try again in a moment.'
    default:
      return 'That command failed. Please try again.'
  }
}

// ---------------------------------------------------------------------------
// Client.
// ---------------------------------------------------------------------------

export interface Esp32ClientOptions {
  /** Base URL of the board. Defaults to EXPO_PUBLIC_ESP32_BASE_URL or 192.168.4.1. */
  baseUrl?: string
  /** Injectable fetch (RN global by default). */
  fetchImpl?: typeof fetch
  /** Per-request timeout in ms (RN fetch has none by default). */
  timeoutMs?: number
  /** Timeout for the framebuffer download, which is a megabyte rather than a kilobyte. */
  screenTimeoutMs?: number
  /** Injectable clock for waitForConnected (defaults to Date.now / setTimeout). */
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

export interface WaitForConnectedOptions {
  /** Overall budget before giving up with outcome 'timeout'. */
  timeoutMs?: number
  /** Delay between status polls. */
  intervalMs?: number
}

export interface WaitForConnectedResult extends ProvisionStatus {
  outcome: 'connected' | 'failed' | 'timeout'
}

/** Mirrors the firmware's PROV_URL_MAX_LEN — the board rejects anything longer. */
export const NEWS_URL_MAX_LEN = 128

/**
 * Pages on the panel: 0 is A1, the front page, and 1 is A2, the company's accounts. The firmware
 * answers `page_range` to anything else.
 */
export const PAGE_COUNT = 2

/**
 * What POST /api/sleep clamps to. `0` is a real value meaning "use the build-time default";
 * anything else lands in [60, 86400].
 *
 * The bounds are what the board can run on rather than a matter of taste: under a minute the
 * wake's own cost is most of the duty cycle, and over a day a board is not polling, it is asleep.
 * The board CLAMPS rather than rejecting, so these exist to offer values the user will actually
 * get — not to reject their input before it is sent.
 */
export const SLEEP_SECONDS_MIN = 60
export const SLEEP_SECONDS_MAX = 86400
/** The value that means "forget my interval and use the compiled-in one". */
export const SLEEP_SECONDS_DEFAULT = 0

const DEFAULT_BASE_URL = process.env.EXPO_PUBLIC_ESP32_BASE_URL || 'http://192.168.4.1'
const DEFAULT_TIMEOUT_MS = 8000
// The framebuffer is 960,000 bytes off an ESP32 streaming PSRAM in 8 KB pieces. On a good LAN
// that is a second or two; on a congested one it is not, and cutting it off at the timeout that
// suits a 1.4 KB JSON document would fail a download that was working.
const DEFAULT_SCREEN_TIMEOUT_MS = 15000
// The connect test briefly hops the SoftAP to the home AP's channel, dropping the phone for a
// few seconds; poll generously so we ride through the gap and still catch the 'connected' read
// before the board reboots out of AP mode.
const DEFAULT_WAIT_TIMEOUT_MS = 45000
const DEFAULT_POLL_INTERVAL_MS = 1500

// Coercers — the board's JSON is trusted but we defensively normalize so a missing/garbage field
// never crashes a render.
function asNum(v: unknown, fallback = 0): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}
function asBool(v: unknown): boolean {
  return Boolean(v)
}
function asStr(v: unknown): string {
  return v == null ? '' : String(v)
}
/**
 * One of the `X-Screen-*` geometry headers as an integer, or null when it is absent or is not a
 * number. Absent is not a disagreement — a proxy that dropped a header did not change the body —
 * so null has to be distinguishable from a real 0, which `Number('')` is not.
 */
function headerInt(res: Response, name: string): number | null {
  const raw = res.headers?.get(name)
  if (raw === null || raw === undefined || raw.trim() === '') return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

function asObj(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}
/** One of a fixed set, or the fallback. The UI switches on these, so an unknown one must land in
 * a case the UI already handles rather than being passed through as itself. */
function asEnum<T extends string>(v: unknown, allowed: readonly string[], fallback: T): T {
  const s = asStr(v)
  return (allowed.includes(s) ? s : fallback) as T
}

function parseSubject(raw: unknown): NewsSubject {
  const s = asObj(raw)
  return {
    symbol: asStr(s.symbol),
    name: asStr(s.name),
    exchange: asStr(s.exchange),
    sector: asStr(s.sector),
    lastCents: asNum(s.lastCents),
    changeBp: asNum(s.changeBp),
    prevCloseCents: asNum(s.prevCloseCents),
    openCents: asNum(s.openCents),
    highCents: asNum(s.highCents),
    lowCents: asNum(s.lowCents),
    wk52HighCents: asNum(s.wk52HighCents),
    wk52LowCents: asNum(s.wk52LowCents),
  }
}

function parseCounts(raw: unknown): NewsCounts {
  const c = asObj(raw)
  return {
    stories: asNum(c.stories),
    figures: asNum(c.figures),
    briefs: asNum(c.briefs),
    peers: asNum(c.peers),
    tables: asNum(c.tables),
    charts: asNum(c.charts),
    indices: asNum(c.indices),
    thumbs: asNum(c.thumbs),
  }
}

// DEV_STORY_MAX and DEV_INDEX_MAX, both 5 (components/news_core/include/device_api_model.h).
// The firmware clamps to these before it serialises; clamping again here means a board that
// somehow sent more cannot make a phone list disagree with the sheet it is standing next to.
const HEADLINES_MAX = 5
const INDICES_MAX = 5

function parseHeadlines(raw: unknown): Headline[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((h): h is Record<string, unknown> => h !== null && typeof h === 'object')
    .slice(0, HEADLINES_MAX)
    .map((h) => ({ rank: asNum(h.rank), headline: asStr(h.headline) }))
}

function parseIndices(raw: unknown): IndexCell[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((c): c is Record<string, unknown> => c !== null && typeof c === 'object')
    .slice(0, INDICES_MAX)
    .map((c) => ({
      symbol: asStr(c.symbol),
      lastCents: asNum(c.lastCents),
      changeBp: asNum(c.changeBp),
    }))
}

function parseNews(raw: unknown): NewsSummary {
  const v = asObj(raw)
  return {
    valid: asBool(v.valid),
    demo: asBool(v.demo),
    edition: asStr(v.edition),
    generatedAt: asStr(v.generatedAt),
    subject: parseSubject(v.subject),
    counts: parseCounts(v.counts),
    headlines: parseHeadlines(v.headlines),
    indices: parseIndices(v.indices),
  }
}

function parseSource(raw: unknown): NewsSource {
  const s = asObj(raw)
  return {
    url: asStr(s.url),
    lastResult: asEnum<NewsFetchResult>(s.lastResult, FETCH_RESULTS, 'unknown'),
    pollSeconds: asNum(s.pollSeconds),
    pollSource: asEnum<PollSource>(s.pollSource, POLL_SOURCES, 'config'),
    // -1 is "never synced", which is NOT "synced zero seconds ago". Defaulting a missing field to
    // 0 would draw a board that had just polled successfully when it never has.
    ageSeconds: asNum(s.ageSeconds, -1),
    stale: asBool(s.stale),
  }
}

function parseBattery(raw: unknown): BatteryInfo {
  const b = asObj(raw)
  return {
    present: asBool(b.present),
    percent: asNum(b.percent),
    millivolts: asNum(b.millivolts),
  }
}

function parsePanel(raw: unknown): PanelInfo {
  return { refreshMs: asNum(asObj(raw).refreshMs) }
}

function parsePower(raw: unknown): PowerInfo {
  const p = asObj(raw)
  return {
    deepSleep: asBool(p.deepSleep),
    sleepSeconds: asNum(p.sleepSeconds),
    sleepSource: asEnum<SleepSource>(p.sleepSource, SLEEP_SOURCES, 'default'),
    wakes: asNum(p.wakes),
    quietWakes: asNum(p.quietWakes),
    meanAwakeMs: asNum(p.meanAwakeMs),
    estMahPerDay: asNum(p.estMahPerDay),
  }
}

export function createEsp32Client(opts: Esp32ClientOptions = {}) {
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
  const doFetch = opts.fetchImpl ?? fetch
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const screenTimeoutMs = opts.screenTimeoutMs ?? DEFAULT_SCREEN_TIMEOUT_MS
  const now = opts.now ?? (() => Date.now())
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))

  // Our own deadline firing is a different fact from the network refusing us, and the two need
  // different sentences — see humanError(). `signal.aborted` is the only thing that distinguishes
  // them reliably: RN, Hermes and Node all name the thrown error differently.
  function failure(controller: AbortController, e: unknown, label: string): Esp32Error {
    if (controller.signal.aborted) {
      return new Esp32Error('timeout', `${label} did not answer in time`)
    }
    return new Esp32Error('network_error', e instanceof Error ? e.message : 'network error')
  }

  async function request(path: string, init?: RequestInit): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      return await doFetch(`${baseUrl}${path}`, { ...init, signal: controller.signal })
    } catch (e) {
      throw failure(controller, e, path)
    } finally {
      clearTimeout(timer)
    }
  }

  async function getJson(path: string, label: string): Promise<Record<string, unknown>> {
    const res = await request(path)
    if (!res.ok) {
      throw new Esp32Error('http_error', `${label} responded ${res.status}`, res.status)
    }
    return ((await res.json()) ?? {}) as Record<string, unknown>
  }

  // Read the firmware's {ok:false,error:<code>} off a failed response, falling back to http_error
  // for a non-JSON or fieldless body. Shared by the JSON writes and the form POST.
  async function errorCodeOf(res: Response): Promise<Esp32ErrorCode> {
    try {
      const j = (await res.json()) as { error?: string }
      if (j && typeof j.error === 'string') return j.error as Esp32ErrorCode
    } catch {
      // non-JSON error body
    }
    return 'http_error'
  }

  // Shared POST helper for the JSON control endpoints. Resolves on a 2xx, otherwise throws a
  // typed Esp32Error carrying the firmware's error code.
  async function postJson(path: string, body: unknown, label: string): Promise<void> {
    const res = await request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (res.ok) return
    throw new Esp32Error(await errorCodeOf(res), `${label} responded ${res.status}`, res.status)
  }

  // The board's POST handlers take no body for /api/refresh and /api/display/test. Sending one
  // anyway is harmless, but sending none keeps the request identical to the documented curl.
  async function postEmpty(path: string, label: string): Promise<void> {
    const res = await request(path, { method: 'POST' })
    if (res.ok) return
    throw new Esp32Error(await errorCodeOf(res), `${label} responded ${res.status}`, res.status)
  }

  // ----- Provisioning (SoftAP) -----

  async function getInfo(): Promise<DeviceInfo> {
    const j = await getJson('/api/info', 'info')
    return {
      deviceId: asStr(j.deviceId),
      model: asStr(j.model),
      apSsid: asStr(j.apSsid),
      fw: asStr(j.fw),
      ip: asStr(j.ip),
    }
  }

  async function scanNetworks(): Promise<ScanNetwork[]> {
    const j = await getJson('/api/scan', 'scan')
    const raw = Array.isArray(j.networks) ? (j.networks as Array<Record<string, unknown>>) : []
    return raw
      .map((n) => ({ ssid: asStr(n.ssid), rssi: asNum(n.rssi), secured: asBool(n.secure) }))
      .filter((n) => n.ssid.length > 0)
  }

  // POST the home-Wi-Fi credentials and the news URL as a url-encoded form, matching the
  // firmware's HTML /save path. Returns once the board has accepted them (202); the caller then
  // polls waitForConnected.
  //
  // These are the three field names prov_portal.c reads, and the list is deliberately not longer:
  // its `sleep_seconds` field distinguishes ABSENT from EMPTY, where absent keeps whatever
  // interval is already stored and empty clears it. Sending an empty one from here would quietly
  // reset an interval the user set from the dashboard.
  //
  // `news_url` is always sent, empty string included. Provisioning REWRITES the whole stored
  // config (the firmware zeroes its struct and fills it from the form), so omitting the field
  // would still clear the URL — sending '' says that on purpose instead of relying on it.
  async function provision(ssid: string, password: string, newsUrl = ''): Promise<void> {
    const body =
      `ssid=${encodeURIComponent(ssid)}` +
      `&password=${encodeURIComponent(password)}` +
      `&news_url=${encodeURIComponent(newsUrl)}`
    const res = await request('/api/provision', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    })
    if (res.ok) return
    throw new Esp32Error(await errorCodeOf(res), `provision responded ${res.status}`, res.status)
  }

  async function getStatus(): Promise<ProvisionStatus> {
    const j = await getJson('/api/status', 'status')
    const state = (j.state as ProvisionState) ?? 'idle'
    return {
      state,
      ssid: typeof j.ssid === 'string' ? j.ssid : undefined,
      reason: typeof j.reason === 'string' ? j.reason : undefined,
    }
  }

  // Poll /api/status until the board reports connected/failed, or the overall budget elapses.
  // Transient fetch failures are tolerated (the SoftAP drops momentarily during the connect
  // test's channel hop, and disappears entirely once the board reboots into station mode after
  // a confirmed join) — so a 'connected' read is terminal success and we never require the AP to
  // stay reachable to the end.
  async function waitForConnected(
    options: WaitForConnectedOptions = {},
  ): Promise<WaitForConnectedResult> {
    const budget = options.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS
    const interval = options.intervalMs ?? DEFAULT_POLL_INTERVAL_MS
    const deadline = now() + budget
    let last: ProvisionStatus = { state: 'connecting' }
    while (now() < deadline) {
      try {
        const st = await getStatus()
        last = st
        if (st.state === 'connected') return { ...st, outcome: 'connected' }
        if (st.state === 'failed') return { ...st, outcome: 'failed' }
      } catch {
        // transient — keep polling across the AP drop
      }
      await sleep(interval)
    }
    return { ...last, outcome: 'timeout' }
  }

  // ----- Control (STA) -----

  // The live snapshot. Defensively coerced so a malformed/partial payload renders as an empty
  // edition rather than crashing the dashboard.
  async function getState(): Promise<DeviceState> {
    const j = await getJson('/api/state', 'state')
    return {
      deviceId: asStr(j.deviceId),
      model: asStr(j.model),
      fw: asStr(j.fw),
      ip: asStr(j.ip),
      page: asNum(j.page),
      pageTitle: asStr(j.pageTitle),
      news: parseNews(j.news),
      source: parseSource(j.source),
      battery: parseBattery(j.battery),
      panel: parsePanel(j.panel),
      power: parsePower(j.power),
    }
  }

  /**
   * The framebuffer itself — 960,000 bytes of what is on the glass. Decode it with ./screen.ts.
   *
   * Has its own controller rather than going through request(), because the body IS the response
   * here: a shared helper that clears its deadline once the headers land would leave a stalled
   * megabyte hanging forever. The timer covers the download, not the handshake.
   */
  async function fetchScreen(): Promise<Uint8Array> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), screenTimeoutMs)
    try {
      let res: Response
      try {
        res = await doFetch(`${baseUrl}/api/screen`, { signal: controller.signal })
      } catch (e) {
        throw failure(controller, e, 'screen')
      }
      if (!res.ok) {
        throw new Esp32Error(await errorCodeOf(res), `screen responded ${res.status}`, res.status)
      }

      // The token is the contract's version handle, and it is checked BEFORE the bytes are read:
      // decoding a later format against this palette would draw a plausible, wrong page, which is
      // the one failure a preview cannot report on its own. Absent is fine — a proxy that dropped
      // the header did not change the body.
      const format = res.headers?.get('X-Screen-Format') ?? null
      if (format !== null && format !== SCREEN_FORMAT) {
        throw new Esp32Error('screen_format', `screen format ${format}, expected ${SCREEN_FORMAT}`)
      }

      // Then the geometry, and a LENGTH CHECK CANNOT STAND IN FOR IT: 1200 x 1600 and 1600 x 1200
      // are the same 960,000 bytes, and the second is the landscape orientation this project
      // deliberately removed rather than inverted. A body that agrees on size and disagrees on
      // shape decodes into a shredded page, so the shape is checked on its own.
      const declared = {
        width: headerInt(res, 'X-Screen-Width'),
        height: headerInt(res, 'X-Screen-Height'),
        stride: headerInt(res, 'X-Screen-Stride'),
        bpp: headerInt(res, 'X-Screen-Bpp'),
      }
      const disagrees =
        (declared.width !== null && declared.width !== SCREEN_W) ||
        (declared.height !== null && declared.height !== SCREEN_H) ||
        (declared.stride !== null && declared.stride !== SCREEN_STRIDE) ||
        (declared.bpp !== null && declared.bpp !== SCREEN_BPP)
      if (disagrees) {
        throw new Esp32Error(
          'screen_format',
          `screen is ${declared.width}x${declared.height} stride ${declared.stride} @${declared.bpp}bpp, ` +
            `expected ${SCREEN_W}x${SCREEN_H} stride ${SCREEN_STRIDE} @${SCREEN_BPP}bpp`,
        )
      }

      let buf: ArrayBuffer
      try {
        buf = await res.arrayBuffer()
      } catch (e) {
        throw failure(controller, e, 'screen')
      }

      // Counting the assembled bytes is not belt and braces, it is the ONLY check on the length
      // there is. This response is streamed CHUNKED and carries no Content-Length — the one route
      // here that does not declare its own size — so a transfer cut short arrives as a shorter
      // body with a 200 on it rather than as an error status, and a decoder that does not count
      // reads a truncated page as a valid one. Any Content-Length that does reach us came from
      // something in between and is not consulted, in either direction.
      //
      // The expected figure is derived from the headers where they gave one, which is what
      // docs/app-control.md asks a client to compare against; the agreement check above is what
      // makes that the same number as this build's own FB_SIZE.
      const expected =
        declared.width !== null && declared.height !== null
          ? (declared.width * declared.height) / 2
          : FB_SIZE
      const bytes = new Uint8Array(buf)
      if (bytes.length !== expected) {
        throw new Esp32Error(
          'screen_size',
          `screen sent ${bytes.length} bytes, expected ${expected}`,
        )
      }
      return bytes
    } finally {
      clearTimeout(timer)
    }
  }

  // Switch the page on the panel (0 = A1, 1 = A2). Always a full refresh on the board — twenty to
  // thirty seconds — so it takes a while to actually appear.
  async function setPage(page: number): Promise<void> {
    return postJson('/api/page', { page }, 'page')
  }

  // Poll the news source now instead of waiting out the interval. The board only refreshes the
  // panel when what comes back differs from what is already on the glass, so this is safe to call
  // repeatedly — a no-change refresh costs nothing and flashes nothing.
  async function refresh(): Promise<void> {
    return postEmpty('/api/refresh', 'refresh')
  }

  // Point the board at a different edition URL (NVS-persisted, applied live, no reboot). An empty
  // string is valid and meaningful: it switches the board to its built-in demo edition.
  async function setNewsUrl(url: string): Promise<void> {
    return postJson('/api/news', { url }, 'news')
  }

  // Set the board's own sleep interval. Persisted to NVS and written into RTC memory, so it takes
  // effect from the very next wake without a reboot.
  //
  // Sent unclamped on purpose. The board clamps rather than rejecting — {"seconds":5} succeeds and
  // yields 60 — so validating here would only make the app disagree with the device about what is
  // legal. Read `power.sleepSeconds` back rather than assuming, and read `power.sleepSource`
  // beside it: this is the FALLBACK cadence, and a desk's `policy` block outranks it.
  async function setSleep(seconds: number): Promise<void> {
    return postJson('/api/sleep', { seconds }, 'sleep')
  }

  // Run the e-Paper self-test sweep. About a minute and a half of full refreshes on the board; the
  // request returns as soon as it is queued, not when the sweep finishes.
  async function displayTest(): Promise<void> {
    return postEmpty('/api/display/test', 'display test')
  }

  return {
    baseUrl,
    // provisioning
    getInfo,
    scanNetworks,
    provision,
    getStatus,
    waitForConnected,
    // control
    getState,
    fetchScreen,
    setPage,
    refresh,
    setNewsUrl,
    setSleep,
    displayTest,
  }
}

export type Esp32Client = ReturnType<typeof createEsp32Client>

/** Default client bound to EXPO_PUBLIC_ESP32_BASE_URL (or 192.168.4.1). */
export const esp32: Esp32Client = createEsp32Client()
