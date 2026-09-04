# The device HTTP API

A JSON control server on port 80, up once Wi-Fi is connected, advertised over mDNS as
**`claudepost.local`**.

Local-network only: no auth, no TLS, no cloud. That is a scope decision, not an oversight — the
device holds no credentials worth stealing, and the only actions are "show the other page" and
"fetch from a different URL on this LAN".

> The hostname is **not** `tickerboard`. That name belongs to the fortune board this project forked
> from, whose shipped app resolves it. Two devices answering one discovery probe on the same LAN is
> a fault nobody can diagnose from the phone side.

## Endpoints

| Method | Path | Body | Effect |
|---|---|---|---|
| GET | `/api/info` | — | discovery probe |
| GET | `/api/state` | — | what the board is doing (not what the paper says) |
| GET | `/api/screen` | — | the framebuffer itself — 960,000 bytes of what is on the glass |
| POST | `/api/refresh` | — | poll the news source now |
| POST | `/api/page` | `{"page":0\|1}` | switch page — **a full refresh, twenty to thirty seconds** |
| POST | `/api/news` | `{"url":"http://..."}` | change the snapshot URL (persisted, live) |
| POST | `/api/sleep` | `{"seconds":1800}` | change the deep-sleep interval (persisted, live) |
| POST | `/api/display/test` | — | run the panel self-test sweep |

Writes reply `{"ok":true}` or `{"ok":false,"error":"<code>"}` with a 400. Error codes: `bad_json`,
`too_large`, `read_error`, `page_range`, `news_url_invalid`, `sleep_seconds_invalid`, `busy`. One
code belongs to a read instead and carries a **503**: `no_framebuffer`, from `/api/screen`. Same
shape, different question — the request was fine, the board had not finished coming up.

Every write posts a command onto the app's queue and returns immediately; the UI task applies it
through the same code path as a button press. Nothing here touches LVGL, and the only route that
touches the panel layer at all is `GET /api/screen`, which reads its framebuffer and sends it no
traffic — exactly one task is allowed to start a refresh, because a refresh of this panel takes
twenty to thirty seconds, flashes the whole sheet, and cannot be interleaved with another. `/api/display/test`
in particular replies as soon as it is queued and then blocks the UI task for about a minute and a
half.

**There are two pages, not four.** `page` is `0` for A1, the front page, and `1` for A2, the
company's accounts. Anything else is `page_range`. `POST /api/refresh` is safe to call repeatedly:
the panel is only refreshed if what comes back differs from what is already on the glass.

## `GET /api/info`

```json
{"deviceId":"1A2B","model":"Claude Post","fw":"0.1.0","ip":"192.168.0.42"}
```

Four fields, fixed shape: a discovery probe fetches this from every candidate host on the LAN and
reads `ip` to pick the best one. Renaming any of them is a client release, not a firmware change.

## `GET /api/state`

**This describes the board, not the edition.** It answers "is it alive, what is it printing, and did
the last poll work" — the three questions a control app exists to ask. The edition itself is at the
URL in `source.url`, which the phone can fetch as easily as the board can.

```json
{
  "deviceId": "1A2B", "model": "Claude Post", "fw": "0.1.0", "ip": "192.168.0.42",
  "page": 0, "pageTitle": "FRONT PAGE",

  "news": {
    "valid": true, "demo": false,
    "edition": "SEMICONDUCTORS",
    "generatedAt": "2026-08-14T05:12:00Z",
    "lang": "en",

    "subject": {
      "symbol": "SNDK", "name": "Sandisk Corp.",
      "exchange": "NASDAQ", "sector": "Semiconductors",
      "lastCents": 24160, "changeBp": 421, "prevCloseCents": 23184,
      "openCents": 23300, "highCents": 24505, "lowCents": 23110,
      "wk52HighCents": 26900, "wk52LowCents": 8800
    },

    "counts": { "stories": 4, "figures": 22, "briefs": 6, "peers": 5,
                "tables": 1, "charts": 2, "indices": 3, "thumbs": 2 },

    "headlines": [
      { "rank": 0, "headline": "Sandisk's memory squeeze finally shows up in the price" },
      { "rank": 1, "headline": "The whole tape moved, but not this far" },
      { "rank": 2, "headline": "Yokkaichi runs flat out into a fourth quarter of shortage" },
      { "rank": 3, "headline": "The street raises its targets, quietly" }
    ],

    "indices": [
      { "symbol": "SPX", "lastCents": 641283, "changeBp":   62 },
      { "symbol": "SOX", "lastCents": 582014, "changeBp":  187 },
      { "symbol": "VIX", "lastCents":   1432, "changeBp": -530 }
    ]
  },

  "source": {
    "url": "http://mac.local:8123/news.json",
    "lastResult": "ok",
    "pollSeconds": 300,
    "pollSource": "config",
    "ageSeconds": 42,
    "stale": false
  },

  "battery": { "present": true, "percent": 84, "millivolts": 4012 },

  "panel": { "refreshMs": 24810 },

  "power": {
    "deepSleep": true, "sleepSeconds": 900, "sleepSource": "policy",
    "wakes": 96, "quietWakes": 94,
    "meanAwakeMs": 3140, "estMahPerDay": 6
  }
}
```

That document is 1,390 bytes without the indentation shown here. The buffer is
`DEVICE_API_STATE_BUF_SZ`, 5120, and `test_api_json` builds the worst case — every string at its
maximum length, every array at capacity, every character one the escaper expands to six — and asserts
it fits, printing the margin (currently **4,304 of 5,120**). The margin is checked rather than
assumed because the overflow path returns `-1` and an **empty body**, so the symptom of being one
byte over is "the app shows nothing" with no error anywhere.

### One company, and how a client tells one edition from another

Every edition is about a single listed company, so `news.subject` is the whole of what the board is
about. It is also the cheapest "did the page change" check there is: poll it, and a new `symbol` or a
new `generatedAt` means a new edition where an unchanged pair means the board is quietly doing its
job. The old `news.lead` object, one symbol and one headline, is gone — every story on the sheet now
names the same symbol, so repeating it per headline said nothing.

`headlines` is what the board actually set, in the order it set it, carrying the server's `rank`
unchanged so a phone list sorts the way the paper reads. Each is cut to a 72-byte field on a
**character** boundary rather than mid-codepoint: headlines arrive from a copy desk that emits em
dashes and curly quotes, and half a codepoint is not a short headline, it is a JSON string the app's
parser rejects. No `symbol` on a headline — see `subject`.

`indices` is the tape, up to five cells. The name is not repeated; the symbol identifies the cell and
the app already has a label for each.

**Every number is an integer.** `lastCents` is money in cents; `changeBp` is a percentage change in
basis points (`bp = pct × 100`, so `62` is `+0.62%` and `-240` is `-2.40%`). Nothing on either side of
this wire holds a float. That is not tidiness: `"%.2f"` of a large magnitude can truncate on the
decimal point and emit JSON that strict parsers reject, and the class of bug is designed out rather
than guarded. The client owns the decimal separator, the sign, and which of green and red goes with
which — the firmware decides none of those here, because the two would drift.

`subject.wk52HighCents` and `wk52LowCents` are **`0` when unknown**, which is not a price of nothing.
The sheet draws an unknown bound as absent rather than pinning the current price to one end of a
range that starts at zero, and a client should do the same.

### `counts`, and why the dossier is not here

`counts` is what arrived, **after parsing**. It is the difference between "the producer filed a thin
day" and "the parser dropped something", which is a distinction no other field can make: a producer
that sent forty figures learns here that twenty-eight of them landed.

The figures themselves do not travel, and their absence is a decision rather than an oversight.
Carrying the dossier — twenty-eight preformatted values, at the widths the escaper can expand
sixfold — put the worst-case document at 15,092 bytes and cost 16 KB of `.bss` for the life of the
board, because `device_api.c` serialises into a file static that exists whether anyone polls or not.
The dossier is what the *paper* is for; a reader who wants the figures is standing in front of them.
If a later version does want them on a phone, they get an endpoint of their own that builds the
response on demand rather than a line item on every dashboard poll.

Same argument, shorter, for `briefs`, `peers`, `tables`, `charts` and `thumbs`: a count each.

The fields the old vault dashboard reported — `notes`, `links`, `orphans`, `tags`, `agents`,
`recent`, `inbox` — are **gone**, along with the four page indices they went with, and so are
`news.stories` / `news.tickers` (now `counts.stories`; there is no watchlist to count). So is
`panel.partialChain` / `fullRefreshMs` / `partialRefreshMs`: Spectra 6 has one kind of refresh, so
there is one number.

### The fields with a trap in them

`source.lastResult` is one of `ok`, `no_url`, `transport`, `http_status`, `bad_payload`,
`not_modified` — the same strings the serial log uses. `transport` means DNS/connect/TLS/timeout;
`http_status` means the server answered but not with a 2xx; `bad_payload` means it answered 2xx with
something that is not a front page. Those three point at three different mistakes, which is why they
are not one code.

**`not_modified` is a success.** It is a `304`: the board sent the ETag of the document it last
parsed and the server confirmed nothing had changed. On a board polling all day it is the *most
common* outcome, so a client that colours it as an error paints a healthy board red for most of its
life. `ageSeconds` restarts on it, exactly as it does on `ok`.

`source.ageSeconds` is **`-1` when no fetch has ever succeeded**, which is different from "zero
seconds ago". A client that treats it as a number draws a board that just synced when it never has.

`source.pollSeconds` is the cadence **in force**, not the one compiled in, and `source.pollSource`
says where it came from — `"config"` for `CONFIG_CLAUDEPOST_POLL_SECONDS`, `"policy"` for a `policy`
block in the payload (see [news-contract.md](news-contract.md)). The pair exists because a number
that can come from two places says nothing on its own: an hourly poll the server asked for ends when
its quiet window does, and an hourly poll built into the image does not. A client that wants to show
"next check in an hour" needs to know which of those it is looking at.

Policy is **not persisted**, so a board that has just rebooted reports `"config"` until its first
successful fetch — which is the design, not a gap: a bad policy must not be able to leave a board
polling once a day forever.

`news.demo` is not an error state. A board with no URL renders the built-in demo edition, which is a
complete and intentional configuration; `POST /api/news` with `{"url":""}` puts it back there
deliberately.

`news.valid` is `false` before the first successful parse, and everything under `news` is then empty
rather than missing — an empty `subject`, empty arrays, zero counts. A client that has to tell "no
key" from "no news" has two states to handle where the board only ever has one.

**`panel.refreshMs` is not decoration.** The whole refresh policy — one refresh per changed snapshot,
none for a clock tick, no partial anything — rests on "twenty to thirty seconds", and that figure is
the vendor's rather than this board's. `refreshMs` is `epd6_last_refresh_ms()`, what the last refresh
actually cost on this panel. Serving it means reading it off a phone instead of holding a serial cable
to a board on a shelf. `epd6_init()` lands one refresh before anything else starts, so by the time
this server is answering, the number is a real measurement and not a zero.

### `power`, and the thing a client must be told before it files a bug

```json
"power": { "deepSleep": true, "sleepSeconds": 900, "sleepSource": "policy",
           "wakes": 96, "quietWakes": 94,
           "meanAwakeMs": 3140, "estMahPerDay": 6 }
```

**This board can only answer you while it is awake, and once `deepSleep` is `true` it usually is
not.** A board on a wall wakes about every `sleepSeconds`, brings up Wi-Fi, asks the news server one
conditional question, and — if the answer is "nothing changed" — goes back to sleep without ever
powering the panel. That whole wake is about three seconds, and no HTTP server runs during it. There
is no bug here to find: a request that times out against a sleeping board is the feature working.

To reach it, **press a button on the board**. A button wake keeps this server and mDNS up for
`CONFIG_CLAUDEPOST_AWAKE_WINDOW_SECONDS` (120 by default), and every request restarts that window, so an
app that is being used holds the board awake for as long as it is being used. A board on USB with no
cell fitted, or with a serial console attached, or with `deepSleep` false, never sleeps at all and
behaves exactly as it always did — which is why this is invisible during development and arrives the
first time somebody hangs one on a wall.

The counters exist because the two numbers the sleep design rests on — the standing deep-sleep
current, and how long a Wi-Fi connect actually takes — have never been measured on this board.
Estimating them gave a battery life stated as *190 to 260 days*, and a range that wide is not a
prediction. So the board counts instead, and after a day on a wall the estimate becomes a
measurement, with no instruments and no serial cable.

- `wakes` counts every boot since the last **cold** one. RTC memory does not survive a power-on
  reset, so unplugging the board resets these to zero; that is correct rather than lossy, because the
  averages they feed describe one continuous run.
- `quietWakes` are the ones that cost no refresh. `wakes - quietWakes` is how many editions actually
  reached the paper.
- `meanAwakeMs` is the mean length of a **completed** wake. The wake serving this request has not
  finished, so it is not in the total but its boot *is* in `wakes` — the mean is therefore low by a
  factor of `(wakes-1)/wakes`, which is under 1% once a board has been up a day and is 50% on the
  second wake of its life. Read it after a day, not after a minute.
- `estMahPerDay` is `meanAwakeMs` × the wakes a day at this interval × 0.023 mAh per awake second,
  and it is **the awake-time term only**. It does not include the 2.3 mAh a refresh costs, and it
  does not include the standing deep-sleep current, because nobody has measured that on this board —
  which is the very thing these counters exist to fix. A total that silently contained a guess would
  defeat the purpose of reporting counters at all. Expect the real figure to be higher; how much
  higher is what a day on a wall is for.
- Both are `0` until the board has slept at least once, because neither has an input yet: the
  board's `awake_ms_total` counter — charged on the way into a sleep, and not itself reported here —
  is what `meanAwakeMs` averages, and `estMahPerDay` has no interval to divide into a day. Not an
  error, and not a real figure either.
- `sleepSeconds` is the interval this board will **actually sleep for** when the window closes, not
  the one it was built or configured with. It is `power_cadence()`'s answer, computed from the same
  inputs the board is about to sleep on: the news server's `policy` block if it sent one, otherwise
  the local layers, shortened when the server named a `next_change` sooner than the ordinary cadence
  and lengthened by the failure backoff when polls have been failing. Reporting the *setting* instead
  would show 900 beside a board about to sleep for 3,600 because its desk is in a quiet window, which
  is a number a reader can neither act on nor tell is wrong.
- `sleepSource` says **which of the four layers won**, and it is not decoration: an interval a desk
  set for the night ends by itself, and one compiled into the image does not.

  | value | who decided |
  |---|---|
  | `"policy"` | the news server's `policy` block — its `poll_seconds`, or a `next_change` it named |
  | `"api"` | `POST /api/sleep`, during this awake session |
  | `"nvs"` | the interval typed into the setup form |
  | `"default"` | `CONFIG_CLAUDEPOST_SLEEP_SECONDS`, the compiled-in fallback |

  Top down: the server outranks all three local layers, and both of its answers report as `"policy"`
  — from a reader's point of view a cadence and a targeted wake are the same fact, that the desk is
  driving this board, and both end by themselves. **`"api"` does not survive a sleep.** That call
  writes NVS as well as RTC memory, so after the next wake the very same number honestly reads
  `"nvs"`, which is where it now lives; a flag that survived would go on claiming a phone had just
  set it, months later.

## `GET /api/screen`: seeing the page

The framebuffer, verbatim: `200`, `Content-Type: application/octet-stream`, body exactly **960,000
bytes**. Nothing inside the body says what shape it is, so five headers do.

| header | value |
|---|---|
| `X-Screen-Width` | `1200` |
| `X-Screen-Height` | `1600` |
| `X-Screen-Stride` | `600` |
| `X-Screen-Bpp` | `4` |
| `X-Screen-Format` | `claudepost-6ink-v1` |

`X-Screen-Format` is the version handle. The geometry is the panel's and does not move, but if it
ever does, the token moves with it rather than leaving a client to decode last month's shape in
silence.

**The transfer is chunked, so there is no `Content-Length`.** Unlike every other route here, this
response does not declare its own size: the body is streamed with `Transfer-Encoding: chunked`. A
client's only two sources for the expected length are `X-Screen-Width × X-Screen-Height ÷ 2` and the
count of bytes it actually assembled — **check that those agree before decoding.** A transfer cut
short mid-body arrives as a shorter body, not as an error status, so a decoder that does not count
will read a truncated page as a valid one.

**The layout itself is defined in
[`components/port_bsp/epd6_transpose.h`](../components/port_bsp/epd6_transpose.h)** — row-major, two
pixels per byte, even `x` in the high nibble, and the six palette codes that are also the panel's
wire codes. Read it there. A second copy of it in this document is a second thing to keep true, and
the headers above are already enough to check that what arrived is the shape they describe.

Why the raw bytes rather than a PNG from the device or a proof from the desk: this is the literal
glass. It answers on a board with no desk at all, demo edition included, and it costs the firmware
no image codec — the handler is a loop that streams PSRAM to a socket in 8 KB pieces, allocating
nothing.

**A frame may be torn.** The UI task owns the framebuffer and is not locked out of it while a phone
downloads it, so a request that lands during a render sees part of the edition going up and part of
the one coming down. That is a preview artifact rather than a defect: locking would cost the UI task
the length of a download to spare a reader one imperfect frame of a page that flashes for twenty-five
seconds whenever it changes for real. Fetch it again.

**It answers only while the board is awake** — the same rule as every route here, and for the same
reason; see [`power`](#power-and-the-thing-a-client-must-be-told-before-it-files-a-bug). The one
failure it has of its own is `503 {"ok":false,"error":"no_framebuffer"}`, which is a board that is
answering but has not finished coming up. It should be unreachable — this server starts from the
boot path that has already allocated the framebuffer — and it is named rather than assumed away
because the alternative leaves a client staring at a body it cannot parse.

## `POST /api/sleep`

```json
{"seconds": 1800}
```

Sets the board's **own** sleep interval. Persisted to NVS **and** written into RTC memory, so it takes
effect from the very next wake without a reboot — a wake that changes nothing never reads NVS at all,
which is most of the point of it.

**It is the fallback, not the cadence.** A board reading a desk is told how often to come back by the
`policy` block in the payload (`poll_seconds`, and a `next_change` for a targeted wake), and that
outranks every local layer — this endpoint, the setup form, and the compiled-in default alike. The
number here is what governs when the server has said nothing about cadence at all: a payload on a
static file host, a mock without the block, or a board whose desk has gone away. Which of the two is
in force shows in one field, `power.sleepSource`: `"api"` means this call is deciding, `"policy"`
means the desk is driving and your value is stored but waiting.

`seconds` is clamped rather than rejected: `0` means "use the build-time default", and anything else
lands in **[60, 86400]**. Those bounds are what the board can actually run on rather than a matter of
taste — under a minute the wake's own cost is most of the duty cycle, and over a day a board is not
polling, it is asleep. So `{"seconds":5}` succeeds and yields 60, and a client should read back rather
than assume it got what it asked for — but read `power.sleepSource` beside `power.sleepSeconds`.
`sleepSeconds` is the *effective* interval, so a desk in its quiet window will have it reading 3,600
next to a stored value of 1,800, and that is the two fields working rather than the write failing.

The only rejections are a missing or non-numeric `seconds` (`bad_json`) and a negative one
(`sleep_seconds_invalid`). A negative is named rather than folded into `0`, because `0` already means
something specific and granting it to somebody who asked for `-1` is the board doing what nobody
requested.

**The knee is 15 to 30 minutes.** Past it, the standing deep-sleep current and the refreshes dominate
and a longer interval buys progressively less; below about five minutes the cell drains steeply. This
is a newspaper, and a fifteen-minute worst case on one is not a problem worth a flat battery.

**There is one cadence and two power modes, and this endpoint is one input to it.** The same function
answers "how long until the next poll" for an awake board and "how long to sleep" for a board on a
cell (`power_cadence()`, in `components/power/power_policy.c`), which is why a desk's quiet window
slows both. What this endpoint cannot do is shorten an awake board's poll loop: with no `policy` in
play that loop falls back to its own compiled-in `CONFIG_CLAUDEPOST_POLL_SECONDS` rather than to the
sleep interval, and a board that is awake is on USB, where a poll costs nothing worth tuning. The
number set here is the one that matters on a wall.

## Examples

```bash
curl -s http://claudepost.local/api/state | jq

curl -X POST http://claudepost.local/api/page -d '{"page":1}'     # A2, the accounts
curl -X POST http://claudepost.local/api/refresh
curl -X POST http://claudepost.local/api/news \
     -d '{"url":"http://mymac.local:8123/news.json"}'

# back to the built-in demo front page
curl -X POST http://claudepost.local/api/news -d '{"url":""}'

# half an hour between polls; then read back what was actually applied
curl -X POST http://claudepost.local/api/sleep -d '{"seconds":1800}'
curl -s http://claudepost.local/api/state | jq .power

# back to the build-time default interval
curl -X POST http://claudepost.local/api/sleep -d '{"seconds":0}'

# what a refresh actually costs on this board
curl -s http://claudepost.local/api/state | jq .panel

# the page on the glass, as bytes — 960,000 of them, 4bpp portrait 1200x1600
curl -s http://claudepost.local/api/screen -o screen.bin -D -

# which company is on the glass — the cheapest "did the edition change" check there is
curl -s http://claudepost.local/api/state | jq '.news.subject.symbol, .news.generatedAt'

# what the board received against what the producer thinks it filed
curl -s http://claudepost.local/api/state | jq .news.counts
```

## Where the contract is defined

| | |
|---|---|
| the struct | `components/news_core/include/device_api_model.h` |
| the serializer | `components/news_core/device_api_json.c` — writes bytes directly, no cJSON |
| the buffer sizes | `device_api_json.h`, so the host test can assert the worst case fits |
| the routes | `components/device_api/device_api.c` |
| the screen format | `components/port_bsp/epd6_transpose.h` — the bytes `/api/screen` sends |
| the bridge into the app | `components/user_app/user_app_api.h` — reads copy under the state lock, writes post a command |
| the test | `components/news_core/test/host/test_api_json.c` |

The serializer is deliberately separated from `device_api.c`, which owns httpd, mDNS and esp_netif,
so the exact bytes the phone receives are covered by a host test that needs no ESP-IDF.

## Provisioning API

Separate, and only up in AP mode — see
[`components/provisioning/README.md`](../components/provisioning/README.md). The captive portal
collects the Wi-Fi credentials and the news URL, saves them to NVS, and reboots.

## The companion app

`app/` implements this contract — see [`../app/README.md`](../app/README.md). `app/src/lib/esp32.ts`
is the TypeScript mirror of this document and the only file in the app that knows a field name, so a
change here is a change there.

> The app caught up on 2026-08-24: `esp32.ts` now types `subject`, `counts`, `headlines`,
> `source`, `battery`, `panel` and `power` exactly as this document describes, pages are `0` and
> `1`, and `POST /api/sleep` and `GET /api/screen` have callers. If this document and that file
> disagree, one of them changed without the other — treat it as a bug in whichever moved.

Two things in the app are worth knowing about when changing this contract:

- **`source.ageSeconds` of `-1`** is parsed as "never synced" and rendered as `never`. A client that
  defaults a missing `ageSeconds` to `0` draws a board that just synced when it never has, so the app
  defaults it to `-1` and a test pins that.
- **An unrecognised `lastResult`** is mapped to `unknown` rather than passed through, because the UI
  switches on it. Adding a code here is therefore safe; it degrades to a neutral chip until the app
  learns it.

`app/scripts/mock-esp32.js` implements this whole contract in Node, including really fetching a
snapshot URL and summarising it — so the app can be developed against it, and the contract has a
second implementation to disagree with. It was updated with the app: it serves the committed
fixture's edition and streams `/api/screen` chunked exactly as the board does, so a change here is
a change there too.

## The desk from the phone

Everything above is the LAN-only channel to the board itself. When a
[desk server](desk-server.md) is in the picture, the phone has a second
channel — straight to it, the same `Authorization: Bearer` control plane a
worker speaks. This section is what the app calls and against which token.

**The app's first authenticated call is `GET/PUT /api/settings`**, from
Settings' Desk section — the desk's address, an operator token, and the
language the *newspaper* is written in. `app/src/lib/desk.ts` is the whole
client: two calls, one header, and four error codes (`unauthorized`,
`transport`, `http`, `bad_json`), with 401 and 403 folded into the first
because to whoever is holding the phone both mean "this token cannot do that".

Two things about the token, and they are the reason this is a separate client
from `esp32.ts` rather than a base URL passed to it:

- **It is the operator's own, pasted in.** There is no login and nothing is
  issued to the app. A `producer` token gets a 403 on the write, and the
  sentence says so rather than reporting a generic failure — the likeliest
  cause of one is a producer token pasted where an operator's was meant.
- **It is kept in the phone's keychain**, via `expo-secure-store`
  (`app/src/lib/deskToken.ts`), and nowhere else: not in AsyncStorage beside
  the addresses, not in a log, and not in the message of anything the client
  throws, because an error sentence is drawn on screen and pasted into bug
  reports. The desk *address* is ordinary state and does live in AsyncStorage,
  under `claudepost.deskBaseUrl`.

Everything else the app does with a desk is still unauthenticated: the Today
tab reads `/news.json` and `/tiles/<id>.bin` off the open device plane, so a
phone that only reads the paper never holds a credential at all.

**These are the routes a phone client uses, not the desk's whole surface.**
The drafts family — opening one, uploading a payload and its tiles, proofing,
committing — and the queue's claim and `done`/`fail` belong to the worker that
files editions, not to a reader on a phone, and they are listed in
[`server/README.md`](../server/README.md)'s route table. The scopes below were
transcribed from
[`server/claudepost/http.py`](../server/claudepost/http.py)'s `_ROUTES` table,
the only place the split is actually decided, as it stood on this branch;
`_ROUTES` is what to read when this and the desk disagree.

**Two tokens, and the split is real.** `producer` reads everything below and
may queue an instruction or file a note; `operator` additionally changes what
the desk does with nothing in front of it — the schedule, the standing
directives, a forced publish, a hold, a promotion. A phone carrying only a
`producer` token can see everything and ask for work; it cannot change the
rules.

`producer` scope — the reads and the one write a phone makes:

| | |
|---|---|
| `GET /api/state` | what the desk is doing |
| `GET /api/editions` · `GET /api/editions/<id>` | the editorial history, and one edition's record |
| `GET /api/editions/<id>/proof/<name>` | that edition's own proof sheets |
| `GET /api/editions/<id>/notes.md` | the dossier filed with it, if there is one |
| `GET /api/commands` · `POST /api/commands` | the queue, and asking it for something |
| `GET/PUT /api/commands/<id>/notes.md` | the note on one instruction |
| `GET /api/directives` | the standing rules in force — adding one is `operator` |
| `GET /api/schedule` · `GET /api/schedule/next` | the schedule, and what it does next — editing it is `operator` |
| `GET /api/watchlist` | the vault's grades, reasons and thesis notes — editing it is `operator` |
| `GET /api/settings` | the desk's own preferences — today, the language the edition is written in. Changing it is `operator` |
| `GET /api/quotes?symbols=…` | last price, day's change and a sparkline, proxied so the phone never holds the Alpaca key |
| `GET /api/audit` | the desk's own record of what it has done |

Unauthenticated, and not under `/api/*` at all — the device plane, open to
anything that can reach the desk: `GET /news.json`, the same edition the
board polls, fetchable by the app exactly as the board fetches it.
The companion app is now a client of it: the Today tab fetches `/news.json`
and `/tiles/<id>.bin` straight from the address the phone stores, with the
board's own conditional request and body cap, so an edition is readable on a
phone whose board is asleep or was never set up.

`operator` scope — the writes a `producer` token cannot make, and the ones a
phone would offer:

| | |
|---|---|
| `POST /api/editions/<id>/promote` | replay an old edition as current |
| `DELETE /api/commands/<id>` | cancel a pending instruction |
| `POST /api/directives` · `DELETE /api/directives/<id>` | add or remove a standing rule |
| `PUT /api/schedule` | change when the desk may publish |
| `PUT /api/watchlist` | rewrite the vault's document |
| `PUT /api/settings` | set the language the edition is written in — `{"lang": "ko"}`, and an unknown key is refused whole with `bad_settings` |
| `POST /api/publish` · `POST /api/hold` | force the staged edition up, or hold the wall |

A `producer` token that can enqueue but never promote or publish is
deliberate, the same split [desk-server.md](desk-server.md#the-five-gates)'s
"five gates" describes: pushing an instruction is the whole point of the
queue, and an instruction still has to clear every gate before it reaches
paper, where a promotion or a forced publish reaches the glass with nothing
in front of it.

**The ATS rule.** `app.json` sets `NSAppTransportSecurity.NSAllowsLocalNetworking`,
which lets the app speak plain `http://` to the board on the LAN and to
nothing else — a desk is reachable from anywhere by construction, so on iOS
it must answer on `https://`, exactly as `<desk-host>` does behind the tunnel
in [desk-server.md](desk-server.md#cloudflare); a plain-`http://` address to
a desk on the public internet is refused by the OS before the app's own code
runs. Android is not the same guarantee: `app.json`'s
`expo-build-properties` plugin sets `usesCleartextTraffic: true` project-wide,
so there the LAN-vs-internet split is enforced by convention — always give
the app an `https://` desk address — rather than by the platform.
