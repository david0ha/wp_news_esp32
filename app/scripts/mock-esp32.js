#!/usr/bin/env node
// Mock Claude Post — exercises BOTH firmware HTTP APIs without hardware, so the full app flow
// (onboarding + the live dashboard + the screen preview) runs in a simulator/emulator.
//
// Implements the contract in docs/app-control.md:
//
//   Provisioning (firmware: components/provisioning/prov_portal.c)
//     GET  /api/info        -> { deviceId, model, apSsid }            (AP-mode identity)
//     GET  /api/scan        -> { networks: [{ ssid, rssi, secure }] }
//     POST /api/provision   (x-www-form-urlencoded: ssid, password, news_url?) -> 202 | 4xx
//     GET  /api/status      -> { state, ssid?, reason? }
//
//   Control (firmware: components/device_api)
//     GET  /api/info          -> { deviceId, model, fw, ip }          (STA-mode identity)
//     GET  /api/state         -> the live snapshot
//     GET  /api/screen        -> the framebuffer, 960,000 bytes
//     POST /api/refresh       -> poll the news source now
//     POST /api/page          { page: 0|1 }
//     POST /api/news          { url }
//     POST /api/sleep         { seconds }
//     POST /api/display/test  -> "run" the panel sweep
//
// It is not a stub. Given a news URL it really fetches it — with an If-None-Match, so a 304 is a
// real `not_modified` and not a simulated one — and summarises it exactly as the firmware's
// device_api_json.c would, including the failure taxonomy. Pointing it at
// `python3 tools/mock_news_server.py` exercises the whole chain the real board walks — producer,
// transport, ETag, parse, summary — with only the panel missing.
//
// Usage:
//   node scripts/mock-esp32.js               # listens on http://localhost:8080
//   PORT=9000 node scripts/mock-esp32.js     # custom port
// Then point the app at it (the iOS simulator / Android emulator can reach the host):
//   EXPO_PUBLIC_ESP32_BASE_URL=http://localhost:8080 npx expo start
//   (Android emulator: use http://10.0.2.2:8080)
//
// Provisioning test knobs:
//   - password "wrong"   -> connect test ends in state=failed (reason auth_failed)
//   - anything else      -> state=connected after ~3s
//   - CONNECT_MS=8000    -> override the connecting->connected/failed delay

const http = require('http')

const PORT = Number(process.env.PORT || 8080)
const CONNECT_MS = Number(process.env.CONNECT_MS || 3000)

// Firmware limits (components/provisioning/prov_config.h, device_api.c).
const SSID_MAX_LEN = 32
const PASS_MAX_LEN = 64
const URL_MAX_LEN = 128
const PAGE_COUNT = 2
const POLL_SECONDS = 300
// POST /api/sleep clamps rather than rejecting; 0 means "use the build-time default".
const SLEEP_MIN = 60
const SLEEP_MAX = 86400
const SLEEP_DEFAULT = 900
// A payload's policy block can move the cadence, within the parser's own bounds (news_parse.c).
const POLICY_POLL_MIN = 30
const POLICY_POLL_MAX = 86400
// What the board serialises at most: DEV_STORY_MAX / DEV_INDEX_MAX, both 5.
const STORY_MAX = 5
const INDEX_MAX = 5

// The firmware's page titles (components/news_core/include/ui_strings.h). The app shows this
// string as the ground truth for what is on the glass, so the mock has to serve the real ones.
const PAGE_TITLES = ['FRONT PAGE', 'MARKETS']

// ---- Provisioning state ----
const prov = { state: 'idle', ssid: undefined, reason: undefined }
const INFO_AP = { deviceId: '9F3A', model: 'Claude Post', apSsid: 'Claude Post-9F3A' }
const NETWORKS = [
  { ssid: 'Home 5G', rssi: -48, secure: true },
  { ssid: 'Home 2.4G', rssi: -60, secure: true },
  { ssid: 'CoffeeShop Guest', rssi: -72, secure: false },
  { ssid: 'Home WiFi', rssi: -55, secure: true },
]

// ---- The built-in demo edition ----
// Mirrors components/news_core/news_mock.c, which the board renders when no URL is configured, at
// the values its committed fixture carries (components/news_core/test/host/fixtures/news.json).
// Only the fields /api/state summarises are here — this mock has no panel to draw the rest on.
const DEMO = {
  valid: true,
  demo: true,
  edition: 'SEMICONDUCTORS',
  generatedAt: '2026-08-14T05:12:00Z',
  subject: {
    symbol: 'SNDK',
    name: 'Sandisk Corp.',
    exchange: 'NASDAQ',
    sector: 'Semiconductors',
    lastCents: 163147,
    changeBp: 241,
    prevCloseCents: 159309,
    openCents: 159820,
    highCents: 164200,
    lowCents: 159055,
    wk52HighCents: 171240,
    wk52LowCents: 40218,
  },
  counts: { stories: 4, figures: 22, briefs: 6, peers: 5, tables: 2, charts: 2, indices: 5, thumbs: 2 },
  headlines: [
    { rank: 0, headline: 'Sandisk clears $1,600 as NAND contract prices reset again' },
    { rank: 1, headline: 'Memory leads the semis higher for a fourth week' },
    { rank: 2, headline: 'Revenue nearly doubles again in the June quarter' },
    { rank: 3, headline: 'Targets move up; three houses still say hold' },
  ],
  // All five cells, and five is also what `counts.indices` says. The two are not independent on
  // the device — they are the same expression, `clamped(st->index_count, DEV_INDEX_MAX)`, at
  // device_api_json.c:281 for the count and :304 for the array — so a mock that let them disagree
  // would be serving a state no board can produce, and the dashboard would be eyeballed against it.
  indices: [
    { symbol: 'SPX', lastCents: 641283, changeBp: 62 },
    { symbol: 'NDX', lastCents: 2384155, changeBp: 94 },
    { symbol: 'SOX', lastCents: 821460, changeBp: 187 },
    { symbol: 'UST10Y', lastCents: 413, changeBp: -72 },
    { symbol: 'VIX', lastCents: 1384, changeBp: -420 },
  ],
}

// ---- Board state ----
const board = {
  page: 0,
  newsUrl: '',
  news: clone(DEMO),
  lastResult: 'no_url',
  // Epoch ms of the last SUCCESSFUL poll — a 304 counts, exactly as it does on the board. null
  // means none has ever succeeded, which /api/state reports as ageSeconds -1, a different fact
  // from "0 seconds ago".
  lastOkAt: null,
  // The ETag of the document last parsed, sent back as If-None-Match so a desk that implements
  // conditional GETs really answers 304 and `not_modified` is a real outcome here.
  etag: null,
  // The cadence in force and who set it. A payload's `policy` block outranks the local layers.
  pollSeconds: POLL_SECONDS,
  pollFromPolicy: false,
  // What the last refresh cost. Zero means "no refresh since boot", not an instant panel.
  refreshMs: 0,
  // Power. deepSleep is on by default because that is the interesting case for the app: it is the
  // one where the board is unreachable most of the time and the UI has to say so honestly.
  deepSleep: true,
  sleepStored: SLEEP_DEFAULT,
  sleepSource: 'default',
  wakes: 96,
  quietWakes: 94,
  awakeMsTotal: 96 * 3140,
}

function clone(v) {
  return JSON.parse(JSON.stringify(v))
}

function num(v) {
  const n = Number(v)
  return Number.isFinite(n) ? Math.trunc(n) : 0
}

// The wire carries decimals; everything inside the board is an integer. news_parse.c rounds half
// away from zero, so this does too — a mock that rounded the other way would disagree with the
// device by a cent on exactly the values a test would pick.
function sround(v, scale) {
  const n = Number(v)
  if (!Number.isFinite(n)) return 0
  const x = n * scale
  return Math.trunc(x >= 0 ? x + 0.5 : x - 0.5)
}
const cents = (v) => sround(v, 100)
const basisPoints = (v) => sround(v, 100)

// Mirrors prov_validate_news_url() (components/provisioning/prov_config.c).
function validNewsUrl(url) {
  if (url === undefined || url === null || url === '') return true
  if (Buffer.byteLength(url, 'utf8') > URL_MAX_LEN) return false
  let rest
  if (url.startsWith('http://')) rest = url.slice(7)
  else if (url.startsWith('https://')) rest = url.slice(8)
  else return false
  return rest.length > 0 && !rest.startsWith('/')
}

// Summarise a parsed edition the way device_api_json.c does, from the wire format in
// docs/news-contract.md. Returns null if the payload is not an edition — the same judgement
// news_parse.c makes: a payload that names no company and carries no story is not a thin day, it
// is the wrong object.
function summarise(json) {
  if (json === null || typeof json !== 'object' || Array.isArray(json)) return null
  const subj = json.subject && typeof json.subject === 'object' ? json.subject : {}
  const arr = (v) => (Array.isArray(v) ? v : [])
  const stories = arr(json.stories)
  const symbol = String(subj.symbol ?? '')
  if (!symbol && stories.length === 0) return null

  return {
    valid: true,
    demo: false,
    edition: String(json.edition ?? ''),
    generatedAt: String(json.generated_at ?? ''),
    subject: {
      symbol,
      name: String(subj.name ?? ''),
      exchange: String(subj.exchange ?? ''),
      sector: String(subj.sector ?? ''),
      lastCents: cents(subj.last),
      changeBp: basisPoints(subj.change_pct),
      prevCloseCents: cents(subj.prev_close),
      openCents: cents(subj.open),
      highCents: cents(subj.high),
      lowCents: cents(subj.low),
      // 0 means UNKNOWN rather than a price of nothing, and an absent field has to stay 0.
      wk52HighCents: cents(subj.wk52_high),
      wk52LowCents: cents(subj.wk52_low),
    },
    counts: {
      stories: stories.length,
      figures: arr(json.figures).length,
      briefs: arr(json.briefs).length,
      peers: arr(json.peers).length,
      tables: arr(json.tables).length,
      charts: arr(json.charts).length,
      indices: arr(json.indices).length,
      thumbs: arr(json.thumbs).length,
    },
    headlines: stories.slice(0, STORY_MAX).map((s, i) => ({
      rank: num(s?.rank ?? i),
      headline: String(s?.headline ?? ''),
    })),
    indices: arr(json.indices)
      .slice(0, INDEX_MAX)
      .map((c) => ({
        symbol: String(c?.symbol ?? ''),
        lastCents: cents(c?.last),
        changeBp: basisPoints(c?.change_pct),
      })),
  }
}

// The `policy` block, if the desk sent one (news_parse.c: present-but-out-of-range CLAMPS, because
// a server with a scheduling bug should leave a board polling at the floor rather than leave it
// showing yesterday's front page).
function applyPolicy(json) {
  const p = json && typeof json.policy === 'object' && !Array.isArray(json.policy) ? json.policy : null
  const poll = p && typeof p.poll_seconds === 'number' ? p.poll_seconds : null
  if (poll === null) {
    board.pollSeconds = POLL_SECONDS
    board.pollFromPolicy = false
    return
  }
  board.pollSeconds = Math.min(POLICY_POLL_MAX, Math.max(POLICY_POLL_MIN, Math.round(poll)))
  board.pollFromPolicy = true
}

// One poll of the configured source, with the firmware's failure taxonomy: `transport` for
// DNS/connect/timeout, `http_status` for a non-2xx, `bad_payload` for a 2xx that is not an
// edition, `not_modified` for a 304 — which is a SUCCESS. A failure leaves the previous edition in
// place; blanking the board is the one failure a reader actually notices.
async function pollNews() {
  if (!board.newsUrl) {
    board.news = clone(DEMO)
    board.lastResult = 'no_url'
    board.pollSeconds = POLL_SECONDS
    board.pollFromPolicy = false
    return
  }
  let res
  try {
    res = await fetch(board.newsUrl, {
      signal: AbortSignal.timeout(15000),
      headers: board.etag ? { 'If-None-Match': board.etag } : {},
    })
  } catch (e) {
    board.lastResult = 'transport'
    console.log(`   !! transport: ${e.message}`)
    return
  }
  if (res.status === 304) {
    board.lastResult = 'not_modified'
    board.lastOkAt = Date.now()
    console.log('   -> 304: nothing changed. That is a successful poll.')
    return
  }
  if (res.status < 200 || res.status > 299) {
    board.lastResult = 'http_status'
    console.log(`   !! http_status: ${res.status}`)
    return
  }
  let json
  try {
    json = await res.json()
  } catch {
    board.lastResult = 'bad_payload'
    console.log('   !! bad_payload: not JSON')
    return
  }
  const summary = summarise(json)
  if (!summary) {
    board.lastResult = 'bad_payload'
    console.log('   !! bad_payload: JSON, but not an edition')
    return
  }
  board.news = summary
  board.etag = res.headers.get('etag')
  applyPolicy(json)
  board.lastResult = 'ok'
  board.lastOkAt = Date.now()
  console.log(
    `   -> polled ${board.newsUrl}: ${summary.subject.symbol || '(no symbol)'}, ` +
      `${summary.counts.stories} stories, ${summary.counts.figures} figures`,
  )
}

// Pretend to refresh the panel. Spectra 6 has ONE kind of refresh and it costs twenty to thirty
// seconds, so there is one number and it lands in that range; the partial/full pair the 5.83"
// board reported does not exist here.
function fakeRefresh() {
  board.refreshMs = 24000 + Math.round(Math.random() * 4000)
}

// power_cadence()'s answer, as far as this mock models it: the desk's cadence when it sent one,
// otherwise the board's own stored interval. This is why /api/state reports the EFFECTIVE interval
// beside who set it — reporting the setting would show 900 next to a board about to sleep for
// 3,600 because its desk is in a quiet window.
function effectiveSleep() {
  if (board.pollFromPolicy) return { seconds: board.pollSeconds, source: 'policy' }
  const stored = board.sleepStored > 0 ? board.sleepStored : SLEEP_DEFAULT
  return { seconds: stored, source: board.sleepSource }
}

function state() {
  const sleep = effectiveSleep()
  const meanAwakeMs = board.wakes > 0 ? Math.trunc(board.awakeMsTotal / board.wakes) : 0
  // The awake-time term only — 0.023 mAh per awake second (device_api_json.c). No refreshes, no
  // standing sleep current, because nobody has measured that on this board yet.
  const estMahPerDay =
    sleep.seconds > 0 && meanAwakeMs > 0
      ? Math.trunc((Math.trunc(86400 / sleep.seconds) * meanAwakeMs * 23) / 1000 / 1000)
      : 0

  return {
    deviceId: '9F3A',
    model: 'Claude Post',
    fw: '0.1.0',
    ip: `127.0.0.1:${PORT}`,
    page: board.page,
    pageTitle: PAGE_TITLES[board.page] ?? '',
    news: clone(board.news),
    source: {
      url: board.newsUrl,
      lastResult: board.lastResult,
      pollSeconds: board.pollSeconds,
      pollSource: board.pollFromPolicy ? 'policy' : 'config',
      ageSeconds: board.lastOkAt === null ? -1 : Math.round((Date.now() - board.lastOkAt) / 1000),
      // The firmware badges what is on the glass as old after twice the interval in force, or a
      // quarter of an hour, whichever is longer (stale_seconds_locked(), user_app.cpp).
      stale:
        board.lastOkAt !== null &&
        Date.now() - board.lastOkAt > Math.max(900, board.pollSeconds * 2) * 1000,
    },
    battery: { present: true, percent: 84, millivolts: 4012 },
    panel: { refreshMs: board.refreshMs },
    power: {
      deepSleep: board.deepSleep,
      sleepSeconds: sleep.seconds,
      sleepSource: sleep.source,
      wakes: board.wakes,
      quietWakes: board.quietWakes,
      meanAwakeMs,
      estMahPerDay,
    },
  }
}

// ---- the synthetic page -----------------------------------------------------
//
// A deterministic 960,000-byte framebuffer in the device's own format
// (components/port_bsp/epd6_transpose.h): row-major, 4bpp, stride 600, EVEN x in the HIGH nibble,
// and the panel's own wire codes as the nibble values. Built once and served verbatim, so the
// app's decoder is checked against bytes that do not change between requests.
//
// It is furniture rather than a page: the 30 px margin the design holds to, a masthead bar, one
// stripe per ink, the six-column grid at 170 + 24, and a screened block for a photograph. Anything
// that renders it wrong renders it obviously wrong.
const EPD6 = { BLACK: 0x00, WHITE: 0x01, YELLOW: 0x02, RED: 0x03, BLUE: 0x05, GREEN: 0x06 }
const SCREEN_W = 1200
const SCREEN_H = 1600
const SCREEN_STRIDE = SCREEN_W / 2
const FB_SIZE = SCREEN_STRIDE * SCREEN_H
const SCREEN_FORMAT = 'claudepost-6ink-v1'

let SCREEN = null

function buildScreen() {
  const fb = Buffer.alloc(FB_SIZE, (EPD6.WHITE << 4) | EPD6.WHITE)

  const put = (x, y, code) => {
    if (x < 0 || y < 0 || x >= SCREEN_W || y >= SCREEN_H) return
    const i = y * SCREEN_STRIDE + (x >> 1)
    fb[i] = x & 1 ? (fb[i] & 0xf0) | (code & 0x0f) : (fb[i] & 0x0f) | ((code & 0x0f) << 4)
  }
  const rect = (x0, y0, w, h, code) => {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) put(x, y, code)
  }

  const M = 30 // the margin. Nothing may print outside it.
  const MEASURE = 1140 // 6 columns of 170 + 5 gutters of 24

  rect(M, 40, MEASURE, 96, EPD6.BLACK) // masthead
  rect(M, 152, MEASURE, 4, EPD6.BLACK) // the rule under it

  // One stripe per ink, in the enum's order, so a decoder that shuffles the palette shows it.
  const inks = [EPD6.BLACK, EPD6.WHITE, EPD6.YELLOW, EPD6.RED, EPD6.BLUE, EPD6.GREEN]
  inks.forEach((code, i) => {
    const x = M + i * (170 + 24)
    rect(x, 190, 170, 70, code)
    rect(x, 190, 170, 2, EPD6.BLACK) // a keyline, because yellow on paper is the same value as paper
    rect(x, 258, 170, 2, EPD6.BLACK)
    rect(x, 190, 2, 70, EPD6.BLACK)
    rect(x + 168, 190, 2, 70, EPD6.BLACK)
  })

  // The column grid, drawn as hairlines down the well.
  for (let c = 0; c <= 6; c++) {
    const x = c === 6 ? M + MEASURE - 2 : M + c * (170 + 24)
    rect(x, 300, 2, 900, EPD6.BLACK)
  }

  // A photograph: a 1-in-2 screen, which is what a halftone looks like from far enough away.
  for (let y = 340; y < 700; y++) {
    for (let x = M + 24; x < M + 24 + 512; x++) {
      if (((x + y) & 1) === 0) put(x, y, EPD6.BLACK)
    }
  }

  // A chart: a black staircase against the grid, drawn with hard pixels the way the device draws.
  for (let i = 0; i < 500; i++) {
    const x = M + 580 + i
    const y = 1100 - Math.round(300 * Math.sin((i / 500) * Math.PI))
    rect(x, y, 2, 4, EPD6.BLACK)
  }

  rect(M, 1240, MEASURE, 4, EPD6.BLACK) // the rule above the folio
  rect(M, 1540, MEASURE, 2, EPD6.BLACK) // and the foot of the sheet
  return fb
}

// ---- helpers ----
function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', Connection: 'close' })
  res.end(JSON.stringify(body))
}

function parseForm(body) {
  const out = {}
  for (const pair of body.split('&')) {
    if (!pair) continue
    const [k, v = ''] = pair.split('=')
    out[decodeURIComponent(k)] = decodeURIComponent(v.replace(/\+/g, ' '))
  }
  return out
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => resolve(body))
  })
}

const server = http.createServer(async (req, res) => {
  const { method, url } = req
  console.log(`${new Date().toISOString().slice(11, 19)}  ${method} ${url}`)

  // ---- shared / provisioning GETs ----
  if (method === 'GET' && url === '/api/info') {
    // Serve the STA-mode identity (the control API also exposes /api/info). apSsid is included so
    // the onboarding probe is happy when this mock stands in for AP mode too.
    return sendJson(res, 200, { ...INFO_AP, fw: '0.1.0', ip: `127.0.0.1:${PORT}` })
  }
  if (method === 'GET' && url === '/api/scan') {
    return sendJson(res, 200, { networks: NETWORKS })
  }
  if (method === 'GET' && url === '/api/status') {
    return sendJson(res, 200, {
      state: prov.state,
      ...(prov.ssid ? { ssid: prov.ssid } : {}),
      ...(prov.reason ? { reason: prov.reason } : {}),
    })
  }

  if (method === 'POST' && url === '/api/provision') {
    const form = parseForm(await readBody(req))
    const { ssid = '', password = '', news_url: newsUrl = '' } = form
    if (ssid.length === 0) return sendJson(res, 400, { ok: false, error: 'ssid_empty' })
    if (ssid.length > SSID_MAX_LEN) return sendJson(res, 400, { ok: false, error: 'ssid_too_long' })
    if (password.length > PASS_MAX_LEN) return sendJson(res, 400, { ok: false, error: 'pass_too_long' })
    if (!validNewsUrl(newsUrl)) return sendJson(res, 400, { ok: false, error: 'news_url_invalid' })

    prov.state = 'connecting'
    prov.ssid = ssid
    prov.reason = undefined
    console.log(
      `   -> connecting to "${ssid}" (password ${password ? 'set' : 'empty'}, news_url "${newsUrl}")`,
    )

    // Provisioning REWRITES the whole config on the real board, so an absent field clears the URL.
    board.newsUrl = newsUrl
    board.etag = null
    // `sleep_seconds` absent keeps the stored interval (prov_portal.c), which is what the app
    // sends — so nothing here touches board.sleepStored.

    setTimeout(async () => {
      if (password === 'wrong') {
        prov.state = 'failed'
        prov.reason = 'auth_failed'
        console.log('   -> connect test FAILED (auth_failed)')
        return
      }
      prov.state = 'connected'
      console.log('   -> connect test OK')
      await pollNews()
      fakeRefresh()
    }, CONNECT_MS)

    return sendJson(res, 202, { ok: true, state: 'connecting' })
  }

  // ---- control ----
  if (method === 'GET' && url === '/api/state') {
    return sendJson(res, 200, state())
  }

  if (method === 'GET' && url === '/api/screen') {
    if (SCREEN === null) SCREEN = buildScreen()
    // No Content-Length, deliberately: the device streams this one chunked
    // (httpd_resp_send_chunk), so the app's only check on the length is the count of bytes it
    // assembled. A mock that declared a size would be more forgiving than the board and would hide
    // the exact failure the client has to catch — a transfer cut short arrives as a shorter body,
    // not as an error status.
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'X-Screen-Width': String(SCREEN_W),
      'X-Screen-Height': String(SCREEN_H),
      'X-Screen-Stride': String(SCREEN_STRIDE),
      'X-Screen-Bpp': '4',
      'X-Screen-Format': SCREEN_FORMAT,
      Connection: 'close',
    })
    return res.end(SCREEN)
  }

  if (method === 'POST' && url === '/api/refresh') {
    const before = JSON.stringify(board.news)
    await pollNews()
    // The board only touches the panel when the edition actually changed — that is the whole point
    // of news_hash(), so the mock honours it rather than counting a refresh every time.
    if (JSON.stringify(board.news) !== before) fakeRefresh()
    return sendJson(res, 200, { ok: true })
  }

  if (method === 'POST' && url === '/api/page') {
    let body
    try {
      body = JSON.parse(await readBody(req))
    } catch {
      return sendJson(res, 400, { ok: false, error: 'bad_json' })
    }
    if (typeof body?.page !== 'number') return sendJson(res, 400, { ok: false, error: 'bad_json' })
    if (body.page < 0 || body.page >= PAGE_COUNT) {
      return sendJson(res, 400, { ok: false, error: 'page_range' })
    }
    board.page = body.page
    fakeRefresh() // a page change is always a full refresh
    return sendJson(res, 200, { ok: true })
  }

  if (method === 'POST' && url === '/api/news') {
    let body
    try {
      body = JSON.parse(await readBody(req))
    } catch {
      return sendJson(res, 400, { ok: false, error: 'bad_json' })
    }
    if (typeof body?.url !== 'string') return sendJson(res, 400, { ok: false, error: 'bad_json' })
    if (!validNewsUrl(body.url)) return sendJson(res, 400, { ok: false, error: 'news_url_invalid' })
    board.newsUrl = body.url
    board.etag = null // a new URL is a new document; the old ETag means nothing to it
    if (!body.url) board.lastOkAt = null // back to the demo edition; nothing has been fetched
    await pollNews()
    fakeRefresh()
    return sendJson(res, 200, { ok: true })
  }

  if (method === 'POST' && url === '/api/sleep') {
    let body
    try {
      body = JSON.parse(await readBody(req))
    } catch {
      return sendJson(res, 400, { ok: false, error: 'bad_json' })
    }
    if (typeof body?.seconds !== 'number') return sendJson(res, 400, { ok: false, error: 'bad_json' })
    // A negative is NAMED rather than folded into 0: 0 already means something specific, and
    // granting it to somebody who asked for -1 is the board doing what nobody requested.
    if (body.seconds < 0) return sendJson(res, 400, { ok: false, error: 'sleep_seconds_invalid' })
    // Everything else CLAMPS. {"seconds":5} succeeds and yields 60.
    board.sleepStored =
      body.seconds === 0 ? SLEEP_DEFAULT : Math.min(SLEEP_MAX, Math.max(SLEEP_MIN, Math.round(body.seconds)))
    board.sleepSource = body.seconds === 0 ? 'default' : 'api'
    console.log(`   -> sleep interval now ${board.sleepStored}s (asked for ${body.seconds})`)
    return sendJson(res, 200, { ok: true })
  }

  if (method === 'POST' && url === '/api/display/test') {
    console.log('   -> panel self-test sweep (the real board is busy for ~90 seconds here)')
    fakeRefresh()
    return sendJson(res, 200, { ok: true })
  }

  sendJson(res, 404, { ok: false, error: 'not_found' })
})

// Poll on the board's own schedule too, so a dashboard left open sees the age tick and reset.
// Re-armed each time because the desk's `policy` block can move the cadence under us.
function schedulePoll() {
  setTimeout(async () => {
    if (board.newsUrl) await pollNews()
    schedulePoll()
  }, board.pollSeconds * 1000)
}
schedulePoll()

server.listen(PORT, () => {
  console.log(`mock Claude Post listening on http://localhost:${PORT}`)
  console.log(`  EXPO_PUBLIC_ESP32_BASE_URL=http://localhost:${PORT} npx expo start`)
  console.log('  no news URL set yet — serving the built-in demo edition')
  console.log('  set one with:  curl -X POST http://localhost:%d/api/news -d \'{"url":"..."}\'', PORT)
})
