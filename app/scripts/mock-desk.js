#!/usr/bin/env node
// Mock desk — stands in for the container behind src/lib/desk.ts (server/claudepost/, and
// docs/desk-server.md for the wire this reproduces), so the whole app — Today, Watch, Desk,
// Editions, the dossier — runs against something real without a Docker container, a Cloudflare
// tunnel or an operator token.
//
// It is not a stub. It serves the device plane's `/news.json` from the SAME fixture the firmware's
// own host tests hold to (components/news_core/test/host/fixtures/news.json — `news_mock.c` and
// `tools/mock_news_server.py`'s committed copy), with a real strong ETag and a real 304 on a
// matching `If-None-Match`, exactly the conditional GET docs/desk-server.md § "The conditional GET"
// describes. Every control-plane route `desk.ts` calls is here, in the desk's own envelope
// (`{"ok":false,"error":"<code>"}` on a 4xx — errors.py's `DeskError.to_json()`), with two editions
// seeded — one CURRENT, one STAGED — so Publish, Promote and the proof-sheet viewer all have
// something to act on from the first request.
//
// What it deliberately does NOT implement: the five gates, drafts, tiles, or `PUT /api/watchlist`.
// None of those are called by `src/lib/desk.ts` — the phone reads the watchlist, it does not write
// it (the vault owns it, docs/desk-server.md § The watchlist) — and a route this script does not
// answer is a route the app was never going to reach through this client.
//
// Usage:
//   node scripts/mock-desk.js                     # listens on http://localhost:8090
//   PORT=9090 node scripts/mock-desk.js            # custom port
//   NO_TOKEN=1 node scripts/mock-desk.js           # every /api/* answers 401, whatever token is sent
//   NO_QUOTES=1 node scripts/mock-desk.js          # GET /api/quotes always answers 404 no_quotes
// Then point the app at it:
//   EXPO_PUBLIC_DESK_BASE_URL=http://localhost:8090 EXPO_PUBLIC_DESK_TOKEN=dev-operator npx expo start
//   (Android emulator: http://10.0.2.2:8090)
//
// Any non-empty bearer token is accepted and granted both scopes — this script does not model the
// producer/operator split, because nothing about telling them apart teaches the app anything an
// authorization test at the server layer already covers (server/test/).

const http = require('http')
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

const PORT = Number(process.env.PORT || 8090)
const NO_TOKEN = process.env.NO_TOKEN === '1'
const NO_QUOTES = process.env.NO_QUOTES === '1'

const START_MS = Date.now()
const nowSec = () => Math.floor((START_MS + (Date.now() - START_MS)) / 1000)

// ---------------------------------------------------------------------------
// The fixture. The SAME file components/news_core/test/host/test_news_mock.c holds `news_mock.c`
// to, so a proof sheet rendered from it by `tools/edition/render-check.sh` and the page this
// script's `/news.json` describes are the same edition, described two different ways.
// ---------------------------------------------------------------------------

const FIXTURE_PATH = path.join(
  __dirname,
  '..',
  '..',
  'components',
  'news_core',
  'test',
  'host',
  'fixtures',
  'news.json',
)
const FIXTURE = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'))

function fingerprint(obj) {
  return crypto.createHash('sha256').update(JSON.stringify(obj)).digest('hex')
}

function tileCount(doc) {
  const ids = new Set()
  for (const s of doc.stories || []) if (s.photo && s.photo.id) ids.add(s.photo.id)
  for (const t of doc.thumbs || []) if (t.id) ids.add(t.id)
  return ids.size
}

// ---------------------------------------------------------------------------
// The indexed PNG proof sheet — the same idea as src/lib/screen.ts's PNG writer (a hand-rolled
// IHDR/PLTE/IDAT/IEND with a CRC-32 table), because the desk's real proof sheets are exactly what
// a phone views through the same code path a board's own /api/screen goes through: a picture, not
// a stream of framebuffer bytes. `zlib` is Node core, so this stays a zero-dependency script.
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(bytes) {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'ascii')
  data.copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

// The measured Spectra 6 ink table (src/lib/screen.ts's INK_RGB / wp_palette.c's "as paper"
// values), so a proof sheet looks like it belongs to the same broadsheet the board prints —
// warm paper, not saturated primaries.
const PROOF_W = 1200
const PROOF_H = 1600
const BLACK = 0
const PAPER = 1
const YELLOW = 2
const RED = 3
const BLUE = 4
const GREEN = 5
const PROOF_PALETTE = [
  [38, 38, 40], // black
  [226, 222, 211], // paper
  [208, 176, 58], // yellow
  [158, 52, 44], // red
  [50, 68, 126], // blue
  [62, 110, 74], // green
]

function buildProofPng(seed) {
  const w = PROOF_W
  const h = PROOF_H
  const buf = Buffer.alloc(w * h, PAPER)
  const put = (x, y, idx) => {
    if (x >= 0 && y >= 0 && x < w && y < h) buf[y * w + x] = idx
  }
  const rect = (x0, y0, rw, rh, idx) => {
    for (let y = y0; y < y0 + rh; y++) for (let x = x0; x < x0 + rw; x++) put(x, y, idx)
  }

  const M = 30 // the margin — the well
  const MEASURE = 1140 // 6 columns of 170 + 5 gutters of 24

  rect(M, 40, MEASURE, 96, BLACK) // masthead
  rect(M, 152, MEASURE, 4, BLACK) // the rule under it

  const inks = [BLACK, PAPER, YELLOW, RED, BLUE, GREEN]
  inks.forEach((idx, i) => {
    const x = M + i * (170 + 24)
    rect(x, 190, 170, 70, idx)
    rect(x, 190, 170, 2, BLACK) // yellow's keyline: it is the same value as paper unenclosed
    rect(x, 258, 170, 2, BLACK)
    rect(x, 190, 2, 70, BLACK)
    rect(x + 168, 190, 2, 70, BLACK)
  })

  for (let c = 0; c <= 6; c++) {
    const x = c === 6 ? M + MEASURE - 2 : M + c * (170 + 24)
    rect(x, 300, 2, 900, BLACK) // the column grid
  }

  // A halftone block, offset by `seed` so two sheets from two editions do not render byte-identical.
  for (let y = 340; y < 700; y++) {
    for (let x = M + 24; x < M + 24 + 512; x++) {
      if (((x + y + seed * 37) & 1) === 0) put(x, y, BLACK)
    }
  }

  // A chart, drawn with hard pixels the way ui_chart.c insists on.
  for (let i = 0; i < 500; i++) {
    const x = M + 580 + i
    const y = 1100 - Math.round(300 * Math.sin((i / 500) * Math.PI + seed))
    rect(x, y, 2, 4, BLACK)
  }

  rect(M, 1240, MEASURE, 4, BLACK) // the rule above the folio
  rect(M, 1540, MEASURE, 2, BLACK) // the foot of the sheet

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8 // bit depth: one byte per pixel, indexing the palette directly
  ihdr[9] = 3 // colour type 3 — indexed
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  const plte = Buffer.alloc(PROOF_PALETTE.length * 3)
  PROOF_PALETTE.forEach(([r, g, b], i) => {
    plte[i * 3] = r
    plte[i * 3 + 1] = g
    plte[i * 3 + 2] = b
  })

  const rowBytes = 1 + w
  const raw = Buffer.alloc(h * rowBytes)
  for (let y = 0; y < h; y++) {
    const rowStart = y * rowBytes
    raw[rowStart] = 0 // filter type 0 (None) — this page is mostly one flat colour
    buf.copy(raw, rowStart + 1, y * w, y * w + w)
  }
  const idat = zlib.deflateSync(raw)

  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('PLTE', plte),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const SHEET_NAMES = ['01_a1_full.png', '02_a2_full.png'] // tools/edition/render-check.sh's own names
const SHEET_RE = /^[A-Za-z0-9_-]{1,40}\.(?:png|bmp)$/
const proofCache = new Map()
function proofPng(editionSeed, name) {
  const key = `${editionSeed}:${name}`
  let png = proofCache.get(key)
  if (!png) {
    png = buildProofPng(editionSeed * 2 + (name === SHEET_NAMES[1] ? 1 : 0))
    proofCache.set(key, png)
  }
  return png
}

// ---------------------------------------------------------------------------
// The desk's own state — one process, in memory, gone on restart. Two editions seeded so the
// Desk screen's state strip (current AND staged) and the promote/publish flow have something to
// act on immediately, rather than only after a worker files one.
// ---------------------------------------------------------------------------

function newId() {
  return crypto.randomBytes(16).toString('hex')
}

const currentDoc = FIXTURE
const currentId = fingerprint(currentDoc)

// A staged edition: a deliberately small tweak (a later dateline and a revised deck), so it earns
// its own fingerprint and its own proof sheets without a second fixture to keep in sync.
const stagedDoc = {
  ...FIXTURE,
  dateline: 'SATURDAY, AUGUST 15, 2026',
  generated_at: new Date().toISOString(),
  stories: FIXTURE.stories.map((s, i) =>
    i === 0
      ? { ...s, deck: s.deck + ' A revised draft, staged and not yet on the wall.' }
      : s,
  ),
}
const stagedId = fingerprint(stagedDoc)

const desk = {
  editions: {
    [currentId]: {
      id: currentId,
      doc: currentDoc,
      created_at: nowSec() - 3600 * 20,
      published_at: nowSec() - 3600 * 19,
      tile_count: tileCount(currentDoc),
      bytes: Buffer.byteLength(JSON.stringify(currentDoc), 'utf8'),
      dropped_producer_policy: false,
      sheets: SHEET_NAMES,
      seed: 0,
      hasNotes: true,
      notes:
        '# Why SNDK, why today\n\n' +
        'Contract NAND pricing settled up for a fourth straight quarter and the sell-side moved ' +
        'targets in behind it inside the same session — that pairing is the whole reason this ' +
        'ran today rather than waiting for the next print.\n\n' +
        '## What was checked\n\n' +
        '- The June-quarter release and the accompanying call transcript\n' +
        '- Contract-price commentary from three sell-side notes published Thursday\n' +
        '- The PHLX Semiconductor Index close, for the "memory leads the tape" secondary\n\n' +
        '## What was left out\n\n' +
        'A fourth story on Kioxia\'s own capex plans — real, but a paragraph inside the lead ' +
        'covers the joint-venture angle already, and a fifth story would have pushed a brief off ' +
        'the rail.\n\n' +
        '> Lorem ipsum dolor sit amet, consectetur adipiscing elit — placeholder dossier text, ' +
        'not a real editorial judgement.',
    },
    [stagedId]: {
      id: stagedId,
      doc: stagedDoc,
      created_at: nowSec() - 900,
      published_at: null,
      tile_count: tileCount(stagedDoc),
      bytes: Buffer.byteLength(JSON.stringify(stagedDoc), 'utf8'),
      dropped_producer_policy: false,
      sheets: SHEET_NAMES,
      seed: 1,
      hasNotes: false,
      notes: null,
    },
  },
  current: currentId,
  staged: stagedId,
  lastPublishAt: nowSec() - 3600 * 19,
  hold: null,
  scheduleSource: 'default',
  schedule: {
    timezone: 'Asia/Seoul',
    quiet: [{ from: '00:30', to: '06:00' }],
    wake: ['06:00', '12:40', '22:00'],
    publish: { policy: 'on_wake', min_gap_minutes: 60 },
    poll: { active_seconds: 900, quiet_seconds: 3600 },
  },
  commands: [],
  directives: [],
  watchlist: null,
  audit: [],
  auditSeq: 0,
}

function pushAudit(event, detail) {
  desk.auditSeq += 1
  desk.audit.unshift({ seq: desk.auditSeq, at: nowSec(), event, detail })
}

// Backdated audit history, so the Desk screen's timeline is not empty on the very first run.
desk.audit.push(
  { seq: 1, at: nowSec() - 3600 * 20, event: 'commit', detail: { edition_id: currentId, state: 'staged' } },
  { seq: 2, at: nowSec() - 3600 * 19, event: 'publish', detail: { edition: currentId, forced: false } },
  { seq: 3, at: nowSec() - 3600 * 5, event: 'schedule', detail: { source: 'default' } },
  { seq: 4, at: nowSec() - 900, event: 'commit', detail: { edition_id: stagedId, state: 'staged' } },
)
desk.auditSeq = 4
desk.audit.reverse() // newest first, matching pushAudit()'s own order

// ---- five commands, five different states (docs/desk-server.md § Commands and directives) ----
const cmdDone = newId()
desk.commands.push(
  {
    id: newId(),
    kind: 'file_edition',
    text: 'File a fresh edition on SNDK once the September-quarter guide is out.',
    priority: 5,
    status: 'pending',
    source: 'app',
    created_at: nowSec() - 600,
    deadline_at: null,
    claimed_by: '',
    claimed_at: null,
    finished_at: null,
    attempts: 0,
    result: '',
    has_notes: false,
    notes: null,
  },
  {
    id: newId(),
    kind: 'research',
    text: 'Look into whether Micron\'s capex guide changes the "no new capacity" thread.',
    priority: 3,
    status: 'claimed',
    source: 'app',
    created_at: nowSec() - 1800,
    deadline_at: nowSec() + 3600 * 6,
    claimed_by: 'worker-1',
    claimed_at: nowSec() - 120,
    finished_at: null,
    attempts: 1,
    result: '',
    has_notes: false,
    notes: null,
  },
  {
    id: cmdDone,
    kind: 'custom',
    text: 'Never lead with executive compensation. Turn this into a standing rule.',
    priority: 5,
    status: 'done',
    source: 'operator',
    created_at: nowSec() - 7200,
    deadline_at: null,
    claimed_by: 'worker-1',
    claimed_at: nowSec() - 7100,
    finished_at: nowSec() - 7000,
    attempts: 1,
    result: 'Filed as a standing directive instead of a one-off — see /api/directives.',
    has_notes: true,
    notes:
      '# What came of this\n\n' +
      'Added a directive rather than acting once: *"Never lead with a story about executive ' +
      'compensation."* — `always` scope, so it holds for every edition from here, not just today\'s.\n\n' +
      'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt.',
  },
  {
    id: newId(),
    kind: 'file_edition',
    text: 'File an edition on ticker ZZZZ.',
    priority: 5,
    status: 'failed',
    source: 'app',
    created_at: nowSec() - 5400,
    deadline_at: null,
    claimed_by: 'worker-1',
    claimed_at: nowSec() - 5300,
    finished_at: nowSec() - 5200,
    attempts: 3,
    result: 'No such symbol on any covered exchange after three attempts.',
    has_notes: false,
    notes: null,
  },
  {
    id: newId(),
    kind: 'custom',
    text: 'Hold the desk over the weekend — no publish before Monday.',
    priority: 7,
    status: 'cancelled',
    source: 'app',
    created_at: nowSec() - 10800,
    deadline_at: null,
    claimed_by: '',
    claimed_at: null,
    finished_at: null,
    attempts: 0,
    result: '',
    has_notes: false,
    notes: null,
  },
)

// ---- directives ----
desk.directives.push(
  {
    id: newId(),
    rule: 'Never lead with a story about executive compensation.',
    scope: 'always',
    expires_at: null,
    source: 'operator',
    created_at: nowSec() - 7000,
  },
  {
    id: newId(),
    rule: 'Hold TSLA off the front page until the October delivery numbers are out.',
    scope: 'until',
    expires_at: nowSec() + 3600 * 24 * 30,
    source: 'operator',
    created_at: nowSec() - 3600 * 2,
  },
)

// ---- the watchlist — five items, covering all three grades plus 'none' (docs/desk-server.md §
// The watchlist). `note` is placeholder markdown, not real editorial opinion — it exercises
// <Markdown tone="paper"> (Task 20 / Task 28), which is the whole reason it has headers, a list
// and emphasis rather than one flat sentence.
desk.watchlist = {
  updated_at: nowSec() - 3600 * 9,
  source: 'vault',
  items: [
    {
      symbol: 'SNDK',
      name: 'Sandisk Corp.',
      market: 'NASDAQ',
      grade: 'green',
      reasons: ['contract pricing up 4 quarters running', 'no new industry capacity announced'],
      thesis_status: 'core',
      note:
        '## Thesis\n\n' +
        'Lorem ipsum dolor sit amet, consectetur adipiscing elit. **Contract volume** is now the ' +
        'majority of the mix, which turns a cyclical business into a scheduled one for as long as ' +
        'the agreements run.\n\n' +
        '- Watching the September-quarter guide for confirmation\n' +
        '- Watching Kioxia capex as the read on the joint venture\n\n' +
        'Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip.',
      printable: true,
      last_printed: new Date(START_MS - 86400000 * 2).toISOString().slice(0, 10),
      events: [new Date(START_MS + 86400000 * 21).toISOString().slice(0, 10)],
      held: false,
    },
    {
      symbol: 'WDC',
      name: 'Western Digital Corp.',
      market: 'NASDAQ',
      grade: 'green',
      reasons: ['spin-off overhang cleared', 'HDD pricing firm'],
      thesis_status: 'watching',
      note:
        'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor ' +
        'incididunt ut labore et dolore magna aliqua.\n\n' +
        '> The parent of the SNDK spin-off — watched for the same cycle from the other side.',
      printable: true,
      last_printed: null,
      events: [],
      held: false,
    },
    {
      symbol: 'MU',
      name: 'Micron Technology',
      market: 'NASDAQ',
      grade: 'yellow',
      reasons: ['capex guide due', 'DRAM pricing mixed'],
      thesis_status: 'reviewing',
      note:
        'Lorem ipsum dolor sit amet, consectetur adipiscing elit.\n\n' +
        '1. Capex guide is the swing factor\n' +
        '2. DRAM softer than NAND this quarter\n' +
        '3. Still the cleanest cross-check on the "no new capacity" thread\n\n' +
        'Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore.',
      printable: true,
      last_printed: new Date(START_MS - 86400000 * 9).toISOString().slice(0, 10),
      events: [],
      held: false,
    },
    {
      symbol: 'INTC',
      name: 'Intel Corp.',
      market: 'NASDAQ',
      grade: 'red',
      reasons: ['foundry losses widening', 'logic roadmap slipped again'],
      thesis_status: 'closed',
      note:
        '# Passed\n\n' +
        'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor ' +
        'incididunt ut labore et dolore magna aliqua. `Foundry` losses keep widening against a ' +
        'roadmap that keeps slipping — the memory names in this same watchlist got the story ' +
        'this quarter, not this one.\n\n' +
        'Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt.',
      printable: false,
      last_printed: null,
      events: [],
      held: true,
    },
    {
      symbol: 'ADI',
      name: 'Analog Devices',
      market: 'NASDAQ',
      grade: 'none',
      reasons: [],
      thesis_status: '',
      note: '',
      printable: true,
      last_printed: null,
      events: [],
      held: false,
    },
  ],
  universe: ['SNDK', 'WDC', 'MU', 'INTC', 'ADI', 'HXSCL', 'TXN', 'QCOM'],
}

// ---------------------------------------------------------------------------
// The schedule's own time arithmetic — a small, honestly-scoped stand-in for schedule.py's.
// Asia/Seoul (the shipped default, and this mock's) carries no DST, so a fixed UTC offset read
// once from Intl is exact for it; a schedule PUT to a zone that DOES observe DST would drift here
// in a way the real desk's zoneinfo-backed arithmetic would not. Good enough for a local mock;
// docs/desk-server.md's own algorithm is the one to trust for anything this disagrees with.
// ---------------------------------------------------------------------------

function tzOffsetSeconds(tz) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortOffset' })
      .formatToParts(new Date())
    const part = parts.find((p) => p.type === 'timeZoneName')
    const m = part && /GMT([+-]\d{1,2})(?::(\d{2}))?/.exec(part.value)
    if (!m) return 0
    const sign = m[1].startsWith('-') ? -1 : 1
    const h = Math.abs(Number(m[1]))
    const mnt = m[2] ? Number(m[2]) : 0
    return sign * (h * 3600 + mnt * 60)
  } catch {
    return 0
  }
}

function zonedYMD(epochSec, tz) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(epochSec * 1000))
}

// The wall-clock HH:MM in `tz` — NOT `toISOString().slice(11, 16)`, which is UTC's clock face
// wearing the zone's name. `en-GB` is the shortest built-in locale that prints 24-hour time.
function zonedHHMM(epochSec, tz) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(epochSec * 1000))
}

function midnightEpoch(ymd, tz) {
  return Math.floor(Date.parse(`${ymd}T00:00:00Z`) / 1000) - tzOffsetSeconds(tz)
}

function isQuiet(schedule, t) {
  const ymd = zonedYMD(t, schedule.timezone)
  const secIntoDay = t - midnightEpoch(ymd, schedule.timezone)
  for (const w of schedule.quiet) {
    const from = hhmmToSeconds(w.from)
    const to = hhmmToSeconds(w.to)
    if (from <= to ? secIntoDay >= from && secIntoDay < to : secIntoDay >= from || secIntoDay < to) {
      return true
    }
  }
  return false
}

function hhmmToSeconds(hhmm) {
  const [h, m] = hhmm.split(':').map(Number)
  return h * 3600 + m * 60
}

function effectivePollSeconds(schedule, t) {
  return isQuiet(schedule, t) ? schedule.poll.quiet_seconds : schedule.poll.active_seconds
}

// The next `count` quiet/wake transitions after `t`, local + UTC + epoch — GET /api/schedule/next.
function scheduleTransitions(schedule, t, count) {
  const tz = schedule.timezone
  const daily = []
  for (const w of schedule.quiet) {
    daily.push({ hhmm: w.from, what: 'quiet_start' })
    daily.push({ hhmm: w.to, what: 'quiet_end' })
  }
  for (const w of schedule.wake) {
    daily.push({ hhmm: typeof w === 'string' ? w : w.at, what: 'wake' })
  }
  const out = []
  for (let dayOffset = -1; dayOffset < 400 && out.length < count + daily.length; dayOffset++) {
    const ymd = zonedYMD(t + dayOffset * 86400, tz)
    const base = midnightEpoch(ymd, tz)
    for (const e of daily) {
      const at = base + hhmmToSeconds(e.hhmm)
      if (at > t) out.push({ at, what: e.what })
    }
  }
  out.sort((a, b) => a.at - b.at)
  return out.slice(0, count).map((tr) => ({
    at: tr.at,
    local: `${zonedYMD(tr.at, tz)} ${zonedHHMM(tr.at, tz)} ${tz}`,
    utc: new Date(tr.at * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    what: tr.what,
    ambiguous: false, // Asia/Seoul has no DST fold; see the note above
  }))
}

function nextTransition(schedule, t) {
  const [next] = scheduleTransitions(schedule, t, 1)
  return next ? { at: next.at, what: next.what } : null
}

// ---------------------------------------------------------------------------
// HTTP plumbing.
// ---------------------------------------------------------------------------

function sendJson(res, status, body) {
  const buf = Buffer.from(JSON.stringify(body))
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': String(buf.length),
    Connection: 'close',
  })
  res.end(buf)
}

function sendError(res, status, error, detail) {
  const body = { ok: false, error }
  if (detail) body.detail = detail
  sendJson(res, status, body)
}

function sendText(res, status, contentType, text) {
  const buf = Buffer.from(text, 'utf8')
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': String(buf.length),
    Connection: 'close',
  })
  res.end(buf)
}

function sendBytes(res, status, contentType, buf, extraHeaders) {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': String(buf.length),
    Connection: 'close',
    ...(extraHeaders || {}),
  })
  res.end(buf)
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      if (body === '') return resolve({})
      try {
        resolve(JSON.parse(body))
      } catch {
        reject(new Error('bad_json'))
      }
    })
  })
}

/** `null` when unauthenticated; any non-empty bearer token otherwise grants both scopes. */
function authTokenOf(req) {
  if (NO_TOKEN) return null
  const header = req.headers['authorization'] || ''
  const m = /^Bearer\s+(.+)$/i.exec(header)
  return m && m[1].trim() !== '' ? m[1].trim() : null
}

function epochField(body, key) {
  const v = body[key]
  if (v === undefined || v === null) return null
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
    throw new HttpError(400, 'bad_request', `${key} is epoch seconds as a non-negative number`)
  }
  return v
}

class HttpError extends Error {
  constructor(status, code, detail) {
    super(code)
    this.status = status
    this.code = code
    this.detail = detail
  }
}

function editionSummary(ed) {
  return {
    id: ed.id,
    created_at: ed.created_at,
    published_at: ed.published_at,
    tile_count: ed.tile_count,
    bytes: ed.bytes,
    dropped_producer_policy: ed.dropped_producer_policy,
  }
}

function listEditionsNewestFirst() {
  return Object.values(desk.editions).sort((a, b) => b.created_at - a.created_at)
}

// ---------------------------------------------------------------------------
// The device plane: GET /news.json, anonymous, with a real conditional GET.
// ---------------------------------------------------------------------------

function requestedTagMatches(header, tag) {
  if (!header) return false
  for (let candidate of header.split(',')) {
    candidate = candidate.trim()
    if (candidate === '*') return true
    if (candidate.startsWith('W/')) candidate = candidate.slice(2).trim()
    if (candidate === tag) return true
  }
  return false
}

function handleNewsJson(req, res) {
  const ed = desk.editions[desk.current] || desk.editions[currentId]
  const t = nowSec()
  const doc = {
    ...ed.doc,
    policy: {
      poll_seconds: effectivePollSeconds(desk.schedule, t),
      next_change: (nextTransition(desk.schedule, t) || {}).at || 0,
    },
  }
  const body = JSON.stringify(doc)
  const tag = `"${crypto.createHash('sha256').update(body).digest('hex').slice(0, 16)}"`

  if (requestedTagMatches(req.headers['if-none-match'], tag)) {
    res.writeHead(304, { ETag: tag, 'Cache-Control': 'no-cache', 'Content-Length': '0', Connection: 'close' })
    return res.end()
  }
  sendBytes(res, 200, 'application/json', Buffer.from(body), {
    ETag: tag,
    'Cache-Control': 'no-cache',
  })
}

// ---------------------------------------------------------------------------
// The control plane. One handler per route in desk.ts's own list — every GET/POST/PUT/DELETE it
// calls, docs/desk-server.md's envelope throughout.
// ---------------------------------------------------------------------------

async function handleControl(req, res, method, pathname, query) {
  const token = authTokenOf(req)
  if (token === null) {
    return sendError(res, 401, 'unauthorized', 'no bearer token, or NO_TOKEN=1 is set on this mock')
  }

  try {
    // -- /api/state ---------------------------------------------------------
    if (method === 'GET' && pathname === '/api/state') {
      const t = nowSec()
      return sendJson(res, 200, {
        ok: true,
        now: t,
        current: desk.current,
        staged: desk.staged,
        lastPublishAt: desk.lastPublishAt,
        hold: desk.hold && desk.hold > t ? desk.hold : null,
        scheduleSource: desk.scheduleSource,
        schedule: desk.schedule,
        policy: { pollSeconds: effectivePollSeconds(desk.schedule, t), quiet: isQuiet(desk.schedule, t) },
        nextTransition: nextTransition(desk.schedule, t),
        watchlist: {
          updatedAt: desk.watchlist ? desk.watchlist.updated_at || null : null,
          count: desk.watchlist ? desk.watchlist.items.length : 0,
        },
        queue: {
          pending: desk.commands.filter((c) => c.status === 'pending').length,
          recent: desk.commands.slice(0, 5).map(publicCommand),
        },
        editions: listEditionsNewestFirst().slice(0, 5).map(editionSummary),
      })
    }

    // -- editions -------------------------------------------------------------
    if (method === 'GET' && pathname === '/api/editions') {
      return sendJson(res, 200, {
        ok: true,
        editions: listEditionsNewestFirst().map(editionSummary),
        current: desk.current,
        staged: desk.staged,
      })
    }
    let m = pathname.match(/^\/api\/editions\/([0-9a-f]{8,64})$/)
    if (m) {
      const ed = desk.editions[m[1]]
      if (method !== 'GET') return sendError(res, 404, 'not_found')
      if (!ed) return sendError(res, 404, 'not_found')
      return sendJson(res, 200, {
        ok: true,
        edition: editionSummary(ed),
        sheets: ed.sheets,
        has_notes: ed.hasNotes,
      })
    }
    m = pathname.match(/^\/api\/editions\/([0-9a-f]{8,64})\/notes\.md$/)
    if (m && method === 'GET') {
      const ed = desk.editions[m[1]]
      if (!ed || !ed.hasNotes || !ed.notes) return sendError(res, 404, 'not_found')
      return sendText(res, 200, 'text/markdown; charset=utf-8', ed.notes)
    }
    m = pathname.match(/^\/api\/editions\/([0-9a-f]{8,64})\/proof\/([^/]{1,60})$/)
    if (m && method === 'GET') {
      const [, eid, name] = m
      const ed = desk.editions[eid]
      if (!SHEET_RE.test(name)) return sendError(res, 400, 'bad_request', 'not a sheet name')
      if (!ed || !ed.sheets.includes(name)) return sendError(res, 404, 'not_found')
      const png = proofPng(ed.seed, name)
      return sendBytes(res, 200, 'image/png', png)
    }
    m = pathname.match(/^\/api\/editions\/([0-9a-f]{8,64})\/promote$/)
    if (m && method === 'POST') {
      const ed = desk.editions[m[1]]
      if (!ed) return sendError(res, 404, 'not_found')
      if (ed.id === desk.current) {
        // editions.py's promote(): promoting what is already current is not a refresh — no
        // pointer write, no publish row, no audit row, or a promote-on-promote would restart
        // the minimum gap for nothing.
        return sendJson(res, 200, {
          ok: true,
          edition_id: ed.id,
          state: 'unchanged',
          reason: 'unchanged: identical to the edition already current',
        })
      }
      desk.current = ed.id
      // editions.py's _publish(): the STAGED pointer clears when the edition it named just
      // became current, so a promote of the staged edition cannot leave the same id sitting as
      // both current and staged — a state the real desk never produces.
      if (desk.staged === ed.id) desk.staged = null
      ed.published_at = nowSec()
      desk.lastPublishAt = nowSec()
      pushAudit('publish', { edition: ed.id, reason: 'promoted' })
      return sendJson(res, 200, { ok: true, edition_id: ed.id, state: 'published', reason: 'promoted' })
    }

    // -- commands -------------------------------------------------------------
    if (pathname === '/api/commands') {
      if (method === 'GET') {
        const status = query.get('status')
        const commands = status ? desk.commands.filter((c) => c.status === status) : desk.commands
        return sendJson(res, 200, { ok: true, commands: commands.map(publicCommand) })
      }
      if (method === 'POST') {
        const body = await readJsonBody(req)
        if (typeof body.text !== 'string' || body.text.trim() === '') {
          return sendError(res, 400, 'bad_request', 'a command needs text')
        }
        const priority = body.priority === undefined ? 5 : body.priority
        if (typeof priority !== 'number' || priority < 0 || priority > 9) {
          return sendError(res, 400, 'bad_request', 'priority must be 0..9')
        }
        const command = {
          id: newId(),
          kind: typeof body.kind === 'string' ? body.kind : 'custom',
          text: body.text,
          priority,
          status: 'pending',
          source: typeof body.source === 'string' ? body.source.slice(0, 64) : 'api',
          created_at: nowSec(),
          deadline_at: epochField(body, 'deadline_at'),
          claimed_by: '',
          claimed_at: null,
          finished_at: null,
          attempts: 0,
          result: '',
          has_notes: false,
          notes: null,
        }
        desk.commands.unshift(command)
        return sendJson(res, 200, { ok: true, command: publicCommand(command) })
      }
    }
    m = pathname.match(/^\/api\/commands\/([0-9a-f]{8,64})$/)
    if (m && method === 'DELETE') {
      const command = desk.commands.find((c) => c.id === m[1] && c.status === 'pending')
      if (!command) return sendError(res, 404, 'not_found', 'no such pending command')
      command.status = 'cancelled'
      return sendJson(res, 200, { ok: true })
    }
    m = pathname.match(/^\/api\/commands\/([0-9a-f]{8,64})\/notes\.md$/)
    if (m && method === 'GET') {
      const command = desk.commands.find((c) => c.id === m[1])
      if (!command || !command.has_notes || !command.notes) return sendError(res, 404, 'not_found')
      return sendText(res, 200, 'text/markdown; charset=utf-8', command.notes)
    }

    // -- directives -------------------------------------------------------------
    if (pathname === '/api/directives') {
      if (method === 'GET') {
        return sendJson(res, 200, { ok: true, directives: desk.directives })
      }
      if (method === 'POST') {
        const body = await readJsonBody(req)
        if (typeof body.rule !== 'string' || body.rule.trim() === '') {
          return sendError(res, 400, 'bad_request', 'a directive needs a rule')
        }
        const scope = typeof body.scope === 'string' ? body.scope : 'always'
        if (scope !== 'always' && scope !== 'until') {
          return sendError(res, 400, 'bad_request', `scope ${JSON.stringify(scope)} is 'always' or 'until'`)
        }
        const expiresAt = epochField(body, 'expires_at')
        if (scope === 'until' && expiresAt === null) {
          return sendError(res, 400, 'bad_request', "scope 'until' needs an expires_at")
        }
        if (scope === 'always' && expiresAt !== null) {
          return sendError(res, 400, 'bad_request', "a rule that expires is scope 'until'")
        }
        const directive = {
          id: newId(),
          rule: body.rule,
          scope,
          expires_at: expiresAt,
          source: typeof body.source === 'string' ? body.source.slice(0, 64) : 'api',
          created_at: nowSec(),
        }
        desk.directives.push(directive)
        return sendJson(res, 200, { ok: true, directive })
      }
    }
    m = pathname.match(/^\/api\/directives\/([0-9a-f]{8,64})$/)
    if (m && method === 'DELETE') {
      const before = desk.directives.length
      desk.directives = desk.directives.filter((d) => d.id !== m[1])
      if (desk.directives.length === before) return sendError(res, 404, 'not_found')
      return sendJson(res, 200, { ok: true })
    }

    // -- schedule -------------------------------------------------------------
    if (pathname === '/api/schedule') {
      if (method === 'GET') {
        return sendJson(res, 200, { ok: true, source: desk.scheduleSource, schedule: desk.schedule })
      }
      if (method === 'PUT') {
        const body = await readJsonBody(req)
        const bad = (why) => sendError(res, 400, 'bad_schedule', why)
        if (typeof body.timezone !== 'string' || body.timezone === '') return bad('timezone is required')
        if (!Array.isArray(body.quiet)) return bad('quiet must be an array')
        if (!Array.isArray(body.wake)) return bad('wake must be an array')
        if (!body.publish || typeof body.publish.policy !== 'string') return bad('publish.policy is required')
        if (!body.poll || typeof body.poll.active_seconds !== 'number' || typeof body.poll.quiet_seconds !== 'number') {
          return bad('poll.active_seconds and poll.quiet_seconds are required')
        }
        desk.schedule = {
          timezone: body.timezone,
          quiet: body.quiet.map((w) => ({ from: w.from, to: w.to })),
          wake: body.wake.map((w) => (typeof w === 'string' ? w : { at: w.at, days: w.days || '' })),
          publish: {
            policy: body.publish.policy,
            min_gap_minutes: body.publish.min_gap_minutes ?? 60,
          },
          poll: { active_seconds: body.poll.active_seconds, quiet_seconds: body.poll.quiet_seconds },
        }
        desk.scheduleSource = 'file'
        pushAudit('schedule', { source: desk.scheduleSource })
        return sendJson(res, 200, { ok: true, source: desk.scheduleSource, schedule: desk.schedule })
      }
    }
    if (method === 'GET' && pathname === '/api/schedule/next') {
      const count = Math.min(Math.max(Number(query.get('count') || '10') || 10, 1), 50)
      return sendJson(res, 200, { ok: true, transitions: scheduleTransitions(desk.schedule, nowSec(), count) })
    }

    // -- watchlist (GET only — PUT is the vault's, not this client's) --------
    if (method === 'GET' && pathname === '/api/watchlist') {
      return sendJson(res, 200, { ok: true, watchlist: desk.watchlist })
    }

    // -- quotes -----------------------------------------------------------------
    if (method === 'GET' && pathname === '/api/quotes') {
      if (NO_QUOTES) return sendError(res, 404, 'no_quotes')
      const raw = query.get('symbols') || ''
      const symbols = [...new Set(raw.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean))]
      if (symbols.length === 0) return sendError(res, 400, 'bad_request', 'symbols is required')
      if (symbols.length > 32) return sendError(res, 400, 'bad_request', '32 symbols at most')
      const SYMBOL_RE = /^[A-Z0-9.-]{1,12}$/
      for (const s of symbols) {
        if (!SYMBOL_RE.test(s)) return sendError(res, 400, 'bad_request', `${JSON.stringify(s)} is not a symbol`)
      }
      const quotes = {}
      for (const s of symbols) quotes[s] = fakeQuote(s)
      return sendJson(res, 200, { ok: true, asOf: nowSec(), feed: 'iex', quotes })
    }

    // -- operations -------------------------------------------------------------
    if (method === 'POST' && pathname === '/api/publish') {
      if (!desk.staged) return sendError(res, 404, 'not_found', 'nothing is staged')
      const edition = desk.editions[desk.staged]
      desk.current = edition.id
      edition.published_at = nowSec()
      desk.lastPublishAt = nowSec()
      const finished = desk.staged
      desk.staged = null
      pushAudit('publish', { edition: finished, forced: true })
      return sendJson(res, 200, { ok: true, edition_id: finished, state: 'published', reason: 'forced publish' })
    }
    if (method === 'POST' && pathname === '/api/hold') {
      const body = await readJsonBody(req)
      const until = epochField(body, 'until')
      desk.hold = until
      pushAudit('hold', { until })
      return sendJson(res, 200, { ok: true, hold: until })
    }
    if (method === 'GET' && pathname === '/api/audit') {
      const limit = Math.min(Math.max(Number(query.get('limit') || '50') || 50, 1), 200)
      return sendJson(res, 200, { ok: true, events: desk.audit.slice(0, limit) })
    }

    return sendError(res, 404, 'not_found')
  } catch (e) {
    if (e instanceof HttpError) return sendError(res, e.status, e.code, e.detail)
    if (e.message === 'bad_json') return sendError(res, 400, 'bad_request', 'body is not valid JSON')
    console.error(e)
    return sendError(res, 500, 'internal')
  }
}

function publicCommand(c) {
  // `notes` is this script's own storage field, never on the wire — `has_notes` is what the
  // client reads, the same split `desk.ts`'s Command type and the real desk's row both keep.
  const { notes, ...rest } = c
  return rest
}

// Deterministic, seeded from the symbol string, so the same symbol answers the same numbers on
// every call within one run — useful for a screenshot or a manual pass, unlike Math.random().
function fakeQuote(symbol) {
  let h = 0
  for (let i = 0; i < symbol.length; i++) h = (h * 31 + symbol.charCodeAt(i)) >>> 0
  const baseCents = 2000 + (h % 400000) // $20.00 .. $4020.00-ish
  const changeBp = ((h >> 8) % 1200) - 600 // -6.00% .. +6.00%
  const prevCloseCents = Math.round(baseCents / (1 + changeBp / 10000))
  const bars = []
  let c = prevCloseCents
  for (let i = 29; i >= 0; i--) {
    const drift = ((h >> (i % 24)) % 41) - 20
    c = Math.max(100, c + drift)
    const d = new Date(Date.now() - i * 86400000)
    bars.push({ t: d.toISOString().slice(0, 10), c })
  }
  bars[bars.length - 1] = { t: bars[bars.length - 1].t, c: baseCents }
  return { lastCents: baseCents, prevCloseCents, changeBp, bars }
}

// ---------------------------------------------------------------------------
// The server. Two planes, no route between them (docs/desk-server.md § The two planes) — the
// same rule the real desk enforces with a routing table rather than a check, mirrored here the
// same way: `/api/*` and `/news.json` are dispatched by two different functions, and nothing
// joins them.
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`)
  const pathname = decodeURIComponent(url.pathname)
  console.log(`${new Date().toISOString().slice(11, 19)}  ${req.method} ${req.url}`)

  if (pathname === '/news.json') {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return sendError(res, 405, 'bad_request', 'GET or HEAD only')
    }
    return handleNewsJson(req, res)
  }

  if (pathname.startsWith('/api/')) {
    return handleControl(req, res, req.method, pathname, url.searchParams)
  }

  res.writeHead(404, { 'Content-Type': 'text/plain', Connection: 'close' })
  res.end('not found\n')
})

// Loopback only. Without a host argument Node binds 0.0.0.0, which puts a dev fixture server on
// the LAN for anyone on the same Wi-Fi — and `http://localhost:PORT` is what every line this logs,
// and the README, already tells you to point the app at.
server.listen(PORT, '127.0.0.1', () => {
  console.log(`mock desk listening on http://localhost:${PORT}`)
  console.log(`  EXPO_PUBLIC_DESK_BASE_URL=http://localhost:${PORT} EXPO_PUBLIC_DESK_TOKEN=dev-operator npx expo start`)
  console.log(`  current edition ${currentId.slice(0, 12)}…, staged edition ${stagedId.slice(0, 12)}…`)
  if (NO_TOKEN) console.log('  NO_TOKEN=1 — every /api/* answers 401')
  if (NO_QUOTES) console.log('  NO_QUOTES=1 — /api/quotes always answers 404 no_quotes')
})
