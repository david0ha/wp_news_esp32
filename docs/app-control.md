# The device HTTP API

A JSON control server on port 80, up once Wi-Fi is connected, advertised over mDNS as
**`wpnews.local`**.

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
| GET | `/api/state` | — | the device summary |
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

**There are two pages, not four.** `page` is `0` for A1, the front page, and `1` for A2, the markets
page. Anything else is `page_range`. `POST /api/refresh` is safe to call repeatedly: the panel is
only refreshed if what comes back differs from what is already on the glass.

## `GET /api/info`

```json
{"deviceId":"1A2B","model":"WP News","fw":"0.1.0","ip":"192.168.0.42"}
```

Four fields, fixed shape: a discovery probe fetches this from every candidate host on the LAN and
reads `ip` to pick the best one. Renaming any of them is a client release, not a firmware change.

## `GET /api/state`

```json
{
  "deviceId": "1A2B", "model": "WP News", "fw": "0.1.0", "ip": "192.168.0.42",
  "page": 0, "pageTitle": "FRONT PAGE",

  "news": {
    "valid": true, "demo": false,
    "edition": "PERSONAL PORTFOLIO EDITION",
    "generatedAt": "2026-08-14T05:12:00Z",
    "stories": 6, "tickers": 16,
    "lead": { "symbol": "NVDA",
              "headline": "Nvidia's blowout quarter resets the AI trade" },
    "indices": [
      { "symbol": "SPX",  "lastCents":  641283, "changeBp":   62 },
      { "symbol": "NDX",  "lastCents": 2210455, "changeBp": -118 },
      { "symbol": "DJI",  "lastCents": 4489012, "changeBp":   15 },
      { "symbol": "KS11", "lastCents":  271844, "changeBp": -240 },
      { "symbol": "VIX",  "lastCents":    1432, "changeBp":  530 }
    ]
  },

  "source": {
    "url": "http://mac.local:8123/news.json",
    "lastResult": "ok",
    "pollSeconds": 300,
    "ageSeconds": 42,
    "stale": false
  },

  "battery": { "present": true, "percent": 84, "millivolts": 4012 },

  "panel": { "refreshMs": 24810 }
}
```

That document is 794 bytes. The buffer is 1600, and `test_api_json` builds the worst case — every
string at its maximum length, every character one the escaper doubles — and asserts it fits, printing
the margin (currently **1315 of 1600**). The margin is checked rather than assumed because the
overflow path returns `-1` and an **empty body**, so the symptom of being one byte over is "the app
shows nothing" with no error anywhere.

### This is a summary, not the front page

The phone does not need four bodies of copy and forty-eight candles. It needs to know the board is
alive, what is on the glass, and whether the last poll worked. The full snapshot is available from
the same URL the board polls, which the phone can reach too.

So `news` carries the counts, the edition line, and the **lead** — one symbol and a headline cut to
fit a 72-byte field, on a character boundary rather than mid-codepoint, because headlines arrive from
a copy desk that emits em dashes and curly quotes and half a codepoint is not a short headline, it is
a JSON string the app's parser rejects. The lead identifies the page better than any count does: it is how
a client tells "polled fine, same page as an hour ago" from "polled fine, new front page".

`indices` is the whole ribbon, up to five cells, and the array is the one place the summary carries
real market data. The name is not repeated — the symbol identifies the cell and the app already has a
label for each — which is what buys the room for the lead's headline inside the same buffer.

**Every number is an integer.** `lastCents` is money in cents; `changeBp` is a percentage change in
basis points (`bp = pct × 100`, so `62` is `+0.62%` and `-240` is `-2.40%`). Nothing on either side of
this wire holds a float. That is not tidiness: `"%.2f"` of a large magnitude can truncate on the
decimal point and emit JSON that strict parsers reject, and the class of bug is designed out rather
than guarded. The client owns the decimal separator, the sign, and which of green and red goes with
which — the firmware decides none of those here, because the two would drift.

The fields the old vault dashboard reported — `notes`, `links`, `orphans`, `tags`, `agents`,
`recent`, `inbox` — are **gone**, along with the four page indices they went with. So is
`panel.partialChain` / `fullRefreshMs` / `partialRefreshMs`: Spectra 6 has one kind of refresh, so
there is one number.

### The fields with a trap in them

`source.lastResult` is one of `ok`, `no_url`, `transport`, `http_status`, `bad_payload` — the same
strings the serial log uses. `transport` means DNS/connect/TLS/timeout; `http_status` means the server
answered but not with a 2xx; `bad_payload` means it answered 2xx with something that is not a front
page. Those three point at three different mistakes, which is why they are not one code.

`source.ageSeconds` is **`-1` when no fetch has ever succeeded**, which is different from "zero
seconds ago". A client that treats it as a number draws a board that just synced when it never has.

`news.demo` is not an error state. A board with no URL renders the built-in demo front page, which is
a complete and intentional configuration; `POST /api/news` with `{"url":""}` puts it back there
deliberately.

**`panel.refreshMs` is not decoration.** The whole refresh policy — one refresh per changed snapshot,
none for a clock tick, no partial anything — rests on "twenty to thirty seconds", and that figure is
the vendor's rather than this board's. `refreshMs` is `epd6_last_refresh_ms()`, what the last refresh
actually cost on this panel. Serving it means reading it off a phone instead of holding a serial cable
to a board on a shelf. `epd6_init()` lands one refresh before anything else starts, so by the time
this server is answering, the number is a real measurement and not a zero.

## Examples

```bash
curl -s http://wpnews.local/api/state | jq

curl -X POST http://wpnews.local/api/page -d '{"page":1}'     # A2, the markets page
curl -X POST http://wpnews.local/api/refresh
curl -X POST http://wpnews.local/api/news \
     -d '{"url":"http://mymac.local:8123/news.json"}'

# back to the built-in demo front page
curl -X POST http://wpnews.local/api/news -d '{"url":""}'

# what a refresh actually costs on this board
curl -s http://wpnews.local/api/state | jq .panel

# the lead story, which is the cheapest "did the edition change" check there is
curl -s http://wpnews.local/api/state | jq .news.lead
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

> **`app/src/lib/esp32.ts` has not yet been updated for the front page.** It still parses `notes`,
> `links`, `orphans`, `agents`, `recent` and `inbox` out of `state.news`, still declares
> `panel.partialChain`, and still documents `page` as `0=stats 1=graph 2=agents 3=notes`. Against the
> current firmware every one of those reads `0` and the page names are wrong. This document describes
> what the device serves; the app is the thing that has to catch up.

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
