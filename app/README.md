# Claude Post — companion app

A **local-only** React Native (Expo) app that sets up and controls the **ESP32-S3 Claude Post**
over your home Wi-Fi. No cloud, no accounts, no API keys — the app talks **directly** to the board
over plain HTTP on the LAN.

It does three things:

1. **Onboarding** over the board's setup Wi-Fi (SoftAP): pick your home Wi-Fi, enter the password
   and the edition URL, and the board reboots onto your network.
2. **Live control** over the LAN: a dashboard that polls the board, shows the company today's
   edition is about, how the last poll went, and what the board's power counters say — and
   switches the page, changes the URL, sets the sleep interval and runs the panel self-test.
3. **Seeing the glass**: a preview rendered from the board's own framebuffer, in the measured
   Spectra 6 inks.

The HTTP/JSON contract it implements is documented in [`../docs/app-control.md`](../docs/app-control.md).
`src/lib/esp32.ts` is the TypeScript mirror of that document and the only file in the app that
knows a field name.

## What the dashboard shows

Not the whole edition — the *board*. Both sheets are at the URL in `source.url`, which the phone
can fetch as easily as the board can; what a companion app is for is the half-metre of air between
the user and a device with no keyboard:

- **Status** — how the last poll went, whether the glass has the demo edition or a stale one,
  whether this board sleeps, and the battery when there is one.
- **The company** — every edition is about one listed company, so the symbol, the name, the price
  and the change *are* what the board is printing today. A new symbol or a new `generatedAt` is the
  cheapest "did the edition change" check there is.
- **The tape** — up to five index cells, symbol and direction.
- **Headlines** — what the board actually set, in its order, and under them the `counts`: what
  arrived **after parsing**. That line is the difference between "the desk filed a thin day" and
  "the parser dropped something", which is a distinction no other field can make.
- **On the panel** — which page is showing (with the board's own title for it: `FRONT PAGE` /
  `MARKETS`), a switcher, what the last refresh actually cost, and the way through to the preview.
  A page change is a full refresh of a 13.3" Spectra 6 panel, so the control stays on the page you
  asked for until the board confirms it rather than snapping back and looking like a lost tap.
- **Source** — the URL, the last result, when it last succeeded, and the cadence **with who set
  it**. `not_modified` is a success, not a failure: it is a 304 against the board's ETag, and on a
  board polling all day it is the most common outcome there is.
- **Power** — deep sleep on or off, the interval the board will *actually* sleep for and which of
  the four layers decided it, the wake counters, and the awake-time mAh estimate. The sleep-interval
  editor writes `POST /api/sleep`; when the desk's `policy` block is driving, no preset is shown as
  selected, because the stored value is waiting rather than in force.

## Reading the edition

The **Today** tab shows the edition itself, and it needs no board. The material is not on the
board — it is at the edition URL, which this phone already stores as its own setting
(`claudepost.newsUrl`) and which the desk serves unauthenticated on its device plane
(`GET /news.json`, `GET /tiles/<id>.bin` — see [`../docs/desk-server.md`](../docs/desk-server.md)).
The board fetches it; so does the phone, with the same conditional request, the same 15-second
deadline and the same 320 KB cap. A payload the app refuses is one the board would refuse too.

- **What it shows.** A masthead — the company, the price, the dateline — then a two-column
  masonry of tiles cut from the payload: the day's range, the stories, the charts, one tile per
  group of figures, the photographs, the briefs, the peers, each statement, and the tape. Tapping
  one opens it in full, with the rest of the edition continuing underneath.
- **Where the heights come from.** Every tile's height is computed by a pure estimator
  (`src/lib/edition/tiles.ts`) *before* anything renders, never measured with `onLayout`. That is
  what stops the page reflowing and what lets a return from a detail land on the same scroll
  position. The content adapts to its height with `numberOfLines`; the tile never grows to fit.
- **The demo.** A phone with no URL shows `src/lib/edition/demo.json`, which is byte-identical to
  `components/news_core/test/host/fixtures/news.json` — the payload an unconfigured *board*
  prints. A jest test holds the two files identical, the way `test_news_mock` holds the firmware
  to the same fixture. Its photo tiles live in `sim/tiles/` and are on no server the phone can
  reach, so they show their captions on a plain ground.
- **The cache.** One AsyncStorage key, `claudepost.edition`, holding the URL, the ETag, when the
  server last *confirmed* the content and the parsed edition. It is re-parsed on read, so a cache
  written by a newer build degrades to defaults instead of crashing a launch. A cache whose URL is
  no longer the stored one is ignored — another desk's paper is not today's.
- **Why photographs are memory-only.** A decoded tile is about a hundred kilobytes of base64 and
  an edition carries several. The text is the material; a picture that has to be re-fetched after
  a cold launch costs a second on the same connection that just delivered the JSON, and the
  alternative is hundreds of kilobytes of a phone's storage per day.
- **The cadence.** No interval. The edition changes about once a day and the desk answers a
  conditional GET with a 304 for the rest of it, so there is a refresh on return to the tab when
  what is on screen is over five minutes old, and pull-to-refresh. A failed refresh keeps the
  cached edition and raises a banner in `warn`, never in direction red.

## Seeing the page on the glass

`GET /api/screen` hands over the framebuffer verbatim — 960,000 bytes, portrait 1200 × 1600 at
4 bpp, two pixels per byte, the panel's own six wire codes as the nibble values. `src/lib/screen.ts`
turns that into an **indexed PNG** on the phone: `pako` for the IDAT, a hand-rolled CRC-32 and
base64, and a 16-entry palette so the pixel byte written *is* the nibble read.

Two decisions worth knowing:

- The palette is `wp_palette_ink[]` — the **measured** "as paper" table, the one the simulator draws
  its screenshots with — not the saturated `wp_palette_rgb[]` the UI draws with. A preview in
  primaries would flatter the design into a decision nobody could make from the real sheet.
- The ten nibble values the panel cannot make (`0x04`, `0x07`..`0x0F`) render as **magenta**, which
  is not one of the six inks and cannot be. A contract drift that rendered as plausible paper is a
  drift nobody would report.

A frame caught mid-render can show part of one edition and part of the next. That is the download,
not the panel — the UI task is not locked out of its framebuffer while a phone reads it, and
locking would cost the board the length of a download to spare one imperfect preview of a page that
flashes for twenty-five seconds whenever it changes for real.

**And it only answers while the board is awake.** A board on a battery with deep sleep on wakes for
about three seconds, asks its desk one conditional question and goes back down without running a
server at all. A timeout against it is the feature working, so the app says so — press a button on
the board, which holds it awake for a couple of minutes, and every request restarts that clock.
`humanError()` in `src/lib/esp32.ts` owns that sentence, and it is why a timeout is a separate error
code from a network failure rather than being folded into "check your Wi-Fi".

## Why not Expo Go?

This app **cannot** run in Expo Go. It needs a **native build** (Expo **Dev Client**) for two
reasons:

- It talks to the board over **plain HTTP** on the local network. iOS requires
  `NSAllowsLocalNetworking` + `NSLocalNetworkUsageDescription` and Android requires
  `usesCleartextTraffic` — these are baked into a native build, not available in Expo Go.
- mDNS discovery of `claudepost.local` needs the iOS `NSBonjourServices` entitlement.

So you run it with `npx expo run:ios` / `npx expo run:android` (a real device or simulator with a
dev build), not by scanning a QR code into Expo Go.

## Quick start

```bash
cd app
npm install
```

### 1. Develop against the mock (no hardware needed)

A Node mock implements **both** board APIs (provisioning + control), including `/api/screen`:

```bash
npm run mock                      # http://localhost:8080  (PORT=9000 to change)
# in another terminal:
EXPO_PUBLIC_ESP32_BASE_URL=http://localhost:8080 npx expo start
```

`EXPO_PUBLIC_ESP32_BASE_URL` points the app's client at the mock and **skips onboarding** (it
routes straight to the dashboard). Open it in the iOS Simulator (which can reach the host's
`localhost`) or an Android emulator (use `http://10.0.2.2:8080` instead of `localhost`).

The mock is not a stub. Give it a real edition URL and it fetches it **with an `If-None-Match`**,
so a 304 is a real `not_modified` and not a simulated one, and summarises the payload exactly as
`components/news_core/device_api_json.c` would — cents, basis points, counts and all:

```bash
python3 ../tools/mock_news_server.py --port 8123     # the news contract, as a server
curl -X POST http://localhost:8080/api/news -d '{"url":"http://localhost:8123/news.json"}'
curl -s http://localhost:8080/api/state | jq .news.subject
curl -X POST http://localhost:8080/api/refresh       # again -> lastResult becomes not_modified
```

`GET /api/screen` on the mock serves a **deterministic synthetic page** in the device's own
framebuffer format — the 30 px margin, a masthead bar, one keylined stripe per ink, the six-column
grid at 170 + 24, a screened block for a photograph and a drawn curve. Anything that decodes it
wrong decodes it obviously wrong:

```bash
curl -s http://localhost:8080/api/screen | wc -c     # 960000
```

Provisioning test knobs in the mock: enter password **`wrong`** to exercise the auth-failure path;
set `CONNECT_MS=8000` to slow the connect test.

### 2. Run on a real device against real hardware

```bash
npx expo run:ios      # or: npx expo run:android
```

Then follow the in-app onboarding:

1. **Turn on** the board (USB-C). In your phone's Wi-Fi settings, join the network named
   `Claude Post-XXXX`. The app probes `http://192.168.4.1` to confirm it's reachable.
2. **Pick your Wi-Fi** from the scanned list (or "Other…" for a hidden SSID).
3. **Enter the edition URL** — or skip it, and the board runs on its built-in demo edition, which is
   a complete configuration rather than a placeholder. A URL you do type is validated against the
   firmware's own rule before anything is sent, because the board's rejection would otherwise arrive
   on the far side of a ~45s join.
4. **Enter the Wi-Fi password.** The app `POST`s to `/api/provision` and polls `/api/status` until
   the board confirms it joined.
5. **Setup complete** — reconnect your phone to the same home Wi-Fi, then open the dashboard. The
   board is reached at `http://claudepost.local` (mDNS) or its IP; you can override the address
   in **Settings** if mDNS isn't available on your network.

Provisioning sends exactly the three fields `prov_portal.c` reads: `ssid`, `password`, `news_url`.
Its optional `sleep_seconds` is deliberately **not** sent — an absent field keeps whatever interval
is stored, where an empty one would clear it, and onboarding must not silently reset an interval set
from the dashboard.

## Onboarding → control flow

```
[AP setup]                                    [home LAN control]
turn-on  ─ join "Claude Post-XXXX"     dashboard ─ GET /api/state (poll)
wifi-list ─ GET /api/scan                       │           POST /api/{page,refresh,sleep,display/test}
news    ─ (validate locally)                    ├─ preview  ─ GET /api/screen → indexed PNG
password ─ POST /api/provision (ssid, pass,     └─ settings ─ GET /api/info + /api/state
           news_url) → poll GET /api/status                   POST /api/news, change host,
complete ─ save board base URL                                re-onboard
```

## Scripts

| command            | what it does                                        |
| ------------------ | --------------------------------------------------- |
| `npm run mock`     | start the dual-API mock board on port 8080          |
| `npm start`        | start the Metro/Expo dev server                     |
| `npm run ios`      | native dev build + run on iOS simulator/device      |
| `npm run android`  | native dev build + run on Android emulator/device   |
| `npm test`         | Jest unit tests (no network — pure logic + client)  |
| `npm run typecheck`| `tsc --noEmit`                                       |
| `npx expo export --platform web` | bundle everything — catches what `tsc` cannot |

The web export is also the cheapest way to actually *look* at the app without a native build: serve
the bundle and the mock board behind one origin (a small proxy forwarding `/api/*` to the board and
`/news.json` to the desk) and the whole dashboard runs in a browser. Doing it that way rather than
adding CORS headers to the mock keeps a browser-only problem out of the repo — React Native has no
CORS.

## Releasing (EAS → TestFlight)

`eas.json` carries three profiles — `development` (dev client), `preview` (internal
distribution) and `production` (store). The production profile has `autoIncrement` on with the
version source remote: the build number lives with EAS, so nothing here needs bumping per build.

```sh
npm install -g eas-cli && eas login    # once
eas build -p ios --profile production
eas submit -p ios                      # or `npx testflight` — build + submit in one
```

The first run asks for an Apple Developer sign-in interactively. That is where Apple identifiers
live — in EAS's credential store and, if you want the prompts gone, in `EXPO_APPLE_ID` /
`EXPO_APPLE_TEAM_ID` in your shell — never in a committed file, which is why `eas.json` carries
no `appleId` or `ascAppId`. TestFlight needs the app to exist in App Store Connect with the
matching bundle id (`com.claudepost.app`); `eas submit` offers to create it.

**Forks:** `app.json`'s `extra.eas.projectId` names *this* app's Expo project. Run `eas init`
in your fork to claim your own before the first build.

## Project layout

```
app/
├─ app.json            Expo config (local-networking + cleartext + Bonjour, dark UI, icon)
├─ eas.json            EAS build/submit profiles — carries no Apple identifiers, on purpose
├─ assets/
│  └─ icon.png         generated — regenerate with python3 tools/make_icon.py (repo root)
├─ babel.config.js
├─ jest.setup.js       mocks @react-native-async-storage for tests
├─ scripts/
│  └─ mock-esp32.js    Node mock for BOTH board APIs — really fetches the edition URL,
│                      and serves a synthetic 960,000-byte /api/screen
└─ src/
   ├─ theme.ts         dark design tokens
   ├─ app/             expo-router file-based routes
   │  ├─ _layout.tsx       providers (DeviceProvider)
   │  ├─ index.tsx         entry → onboarding or dashboard
   │  ├─ dashboard.tsx     live dashboard (polls getState)
   │  ├─ preview.tsx       the page on the glass, decoded from /api/screen
   │  ├─ settings.tsx      board info, edition URL, host override, re-onboard
   │  └─ onboarding/       turn-on → wifi-list → news → password → complete
   ├─ components/      Screen, Button, Card, Chip, SegmentedControl, StatTile, InfoRow, …
   ├─ lib/
   │  ├─ esp32.ts          the board client (both API surfaces) + types  ← core
   │  ├─ esp32.test.ts     thorough unit tests with a fake fetch
   │  ├─ screen.ts         framebuffer → indexed PNG, in the measured inks
   │  ├─ screen.test.ts    round-trips a synthetic page through an independent PNG reader
   │  ├─ edition/          the edition layer: types, parse, client, cache, tiles, hook
   │  │                    (types.ts is the ONLY file that knows an edition wire field name)
   │  ├─ discovery.ts      base-URL normalize/validate/resolve (pure)
   │  ├─ store.ts          AsyncStorage: board base URL + onboarding flag
   │  ├─ device.tsx        app-wide board connection context
   │  ├─ newsurl.ts        edition-URL validation mirroring the firmware
   │  └─ format.ts         money / change / age / interval / fetch-result display helpers
   └─ onboarding/      flow.ts (step logic) + OnboardingContext
```

## Local-only by design

There is **no** Supabase / AWS / MQTT / cloud auth anywhere in this app. The only network calls it
makes are direct HTTP requests to the board's IP / `claudepost.local`. Wi-Fi credentials and the
edition URL live on the board (NVS); the app persists only the board's base URL and an
onboarding-complete flag in `AsyncStorage`.

Those two AsyncStorage keys are namespaced `claudepost.*`. A phone that once ran the fortune
board's app keeps its `tickerboard.*` entries untouched — they point at different hardware on the
same LAN.
