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
| POST | `/api/refresh` | — | poll the news source now |
| POST | `/api/page` | `{"page":0\|1}` | switch page — **a full refresh, twenty to thirty seconds** |
| POST | `/api/news` | `{"url":"http://..."}` | change the snapshot URL (persisted, live) |
| POST | `/api/display/test` | — | run the panel self-test sweep |

Writes reply `{"ok":true}` or `{"ok":false,"error":"<code>"}` with a 400. Error codes: `bad_json`,
`too_large`, `read_error`, `page_range`, `news_url_invalid`, `busy`.

Every write posts a command onto the app's queue and returns immediately; the UI task applies it
through the same code path as a button press. Nothing here touches LVGL or the panel directly —
exactly one task is allowed to start a refresh, because a refresh of this panel takes twenty to
thirty seconds, flashes the whole sheet, and cannot be interleaved with another. `/api/display/test`
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

  "panel": { "refreshMs": 24810 }
}
```

That document is 1,220 bytes. The buffer is `DEVICE_API_STATE_BUF_SZ`, 5120, and `test_api_json`
builds the worst case — every string at its maximum length, every array at capacity, every character
one the escaper expands to six — and asserts it fits, printing the margin (currently **4111 of
5120**). The margin is checked rather than assumed because the overflow path returns `-1` and an
**empty body**, so the symptom of being one byte over is "the app shows nothing" with no error
anywhere.

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

`source.lastResult` is one of `ok`, `no_url`, `transport`, `http_status`, `bad_payload` — the same
strings the serial log uses. `transport` means DNS/connect/TLS/timeout; `http_status` means the server
answered but not with a 2xx; `bad_payload` means it answered 2xx with something that is not a front
page. Those three point at three different mistakes, which is why they are not one code.

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

## Examples

```bash
curl -s http://claudepost.local/api/state | jq

curl -X POST http://claudepost.local/api/page -d '{"page":1}'     # A2, the accounts
curl -X POST http://claudepost.local/api/refresh
curl -X POST http://claudepost.local/api/news \
     -d '{"url":"http://mymac.local:8123/news.json"}'

# back to the built-in demo front page
curl -X POST http://claudepost.local/api/news -d '{"url":""}'

# what a refresh actually costs on this board
curl -s http://claudepost.local/api/state | jq .panel

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

> **`app/src/lib/esp32.ts` has not been updated for any of this.** Its `NewsSummary` still parses
> `notes`, `links`, `orphans`, `agents`, `recent` and `inbox` out of `state.news`, its `PanelInfo`
> still declares `partialChain` / `fullRefreshMs` / `partialRefreshMs`, and it still documents `page`
> as `0=stats 1=graph 2=agents 3=notes`. Against the current firmware every one of those reads `0`
> and the page names are wrong. It has never seen `subject`, `counts` or `headlines`. This document
> describes what the device serves; the app is the thing that has to catch up.

Two things in the app are worth knowing about when changing this contract:

- **`source.ageSeconds` of `-1`** is parsed as "never synced" and rendered as `never`. A client that
  defaults a missing `ageSeconds` to `0` draws a board that just synced when it never has, so the app
  defaults it to `-1` and a test pins that.
- **An unrecognised `lastResult`** is mapped to `unknown` rather than passed through, because the UI
  switches on it. Adding a code here is therefore safe; it degrades to a neutral chip until the app
  learns it.

`app/scripts/mock-esp32.js` implements this whole contract in Node, including really fetching a
snapshot URL and summarising it — so the app can be developed against it, and the contract has a
second implementation to disagree with. It needs the same update.
