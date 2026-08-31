# Claude Post — companion app

A React Native (Expo) app with two audiences and two backends: **the desk** — the server that
files editions, holds a schedule and a queue, and watches a company list — and **the board** — the
ESP32-S3 hardware itself, reached directly over the LAN. Neither is optional and neither stands in
for the other: the desk knows the editorial history and the queue, the board knows what is actually
on the glass right now and how it is sleeping. `src/lib/desk.ts` and `src/lib/esp32.ts` are the
TypeScript mirrors of those two wires — the only files in the app that know a field name for
either.

The app opens on **Today** with no launch gate. There is no onboarding-first flow any more: pairing
a board and adding a desk address both live under **Settings**, reached from the gear icon each tab
carries, and a phone that has configured neither still opens to a usable (if mostly empty) app.

## The four tabs, plus Settings

`src/app/(tabs)/_layout.tsx` — `NativeTabs`, the platform's own `UITabBarController`, so tab
switches never animate (see "Design system" below). Settings is deliberately not a fifth tab: it is
somewhere you go to change something and come back, pushed from `<HeaderGear>` rather than tapped
into.

| Tab | Screen | Shows | Reads |
|---|---|---|---|
| **Today** | `src/app/(tabs)/index.tsx` | The masthead, the desk's own proof render of the current edition, and the day's stories, briefs and dossier in one column | desk `GET /api/state`, `GET /api/editions/<id>`, `GET /api/editions/<id>/proof/<name>`, `GET /news.json` |
| **Watch** | `src/app/(tabs)/watch.tsx` | Every company the vault is watching, led by its grade and the argument behind it — read-only, the vault owns this list | desk `GET /api/watchlist`, `GET /api/quotes?symbols=…` |
| **Desk** | `src/app/(tabs)/desk.tsx` | What the desk is holding, the queue, the standing directives, the schedule, the last twenty audit rows, and the order sheet (`compose`) that asks it for something | desk `GET /api/state`, `GET /news.json` (the strip's own line), `GET /api/audit`, `GET/POST /api/commands`, `GET /api/directives`, `GET /api/schedule[/next]`, plus `POST /api/hold` / `POST /api/publish` |
| **Board** | `src/app/(tabs)/board.tsx` | The hardware: the live glass, the page switcher, where the edition comes from, and the deep-sleep design measuring itself | board `GET /api/state`, `GET /api/screen`, `POST /api/refresh`, `POST /api/page`, `POST /api/sleep`, `POST /api/display/test`; desk `GET /api/state` (for the edition id a tap on the glass carries) |

Two screens are reached only by a tap or a deep link, never a tab of their own — a company's full
detail (`src/app/watch/[symbol].tsx`, off a `WatchRow`) and the editorial history
(`src/app/editions/`, `src/app/notes/[kind]/[id].tsx`, off Desk's EDITIONS row). Both use the
platform's native header rather than this app's hand-built chrome one.

`docs/app-control.md`'s "The desk from the phone" section is the fuller route table, with which
scope (`producer` / `operator`) each route needs; `docs/desk-server.md` is the desk itself.

## Developing against the mocks

Two Node scripts stand in for the two backends — neither is a stub, both really do the work rather
than returning canned JSON:

```bash
cd app
npm install
npm run mock          # scripts/mock-esp32.js — the board's HTTP API, :8080
npm run mock:desk     # scripts/mock-desk.js  — the desk's HTTP API,  :8090
```

`mock-esp32.js` implements **both** firmware APIs (provisioning + control), including a
synthetic 960,000-byte `/api/screen`, and — given a real edition URL — fetches it with an
`If-None-Match` so a 304 is a real `not_modified`. `mock-desk.js` serves `/news.json` from the same
fixture the firmware's host tests hold to
(`components/news_core/test/host/fixtures/news.json`), with a real strong ETag, and seeds two
editions (one CURRENT, one STAGED) plus a watchlist so Today, Watch, Desk and the editions list all
have something to show from the first request. It takes two env-var variants for exercising the
edges: `NO_TOKEN=1` makes every `/api/*` answer 401 whatever bearer token is sent, and `NO_QUOTES=1`
makes `GET /api/quotes` always answer `404 no_quotes` — the state Watch's quote column hides behind
rather than errors on.

Point the app at both with the three dev env vars:

```bash
EXPO_PUBLIC_ESP32_BASE_URL=http://localhost:8080 \
EXPO_PUBLIC_DESK_BASE_URL=http://localhost:8090 \
EXPO_PUBLIC_DESK_TOKEN=dev-operator \
npx expo start
```

(Android emulator: `http://10.0.2.2:8080` / `:8090` in place of `localhost`.) Any non-empty bearer
token is accepted by the mock desk and granted both scopes — it does not model the producer/operator
split, since nothing about telling them apart on this side teaches the app anything the desk's own
authorization tests (`server/test/`) don't already cover. Without the env vars the app falls back to
whatever is saved in Settings (or nothing, which is a legitimate — if quiet — state for Today, Watch
and Desk to be in).

## Why not Expo Go

This app **cannot** run in Expo Go. It needs a **native build** (Expo **Dev Client**):

- It talks to the board over **plain HTTP** on the local network. iOS requires
  `NSAllowsLocalNetworking` + `NSLocalNetworkUsageDescription` and Android requires
  `usesCleartextTraffic` — baked into a native build, unavailable in Expo Go.
- mDNS discovery of `claudepost.local` needs the iOS `NSBonjourServices` entitlement.

Run it with `npx expo run:ios` / `npx expo run:android` against a real device or a dev-build
simulator, not by scanning a QR code into Expo Go.

## Tests and typecheck

```bash
npm test          # Jest — pure logic + both clients, no network
npm run typecheck # tsc --noEmit
```

`npx expo export --platform web` is the cheapest way to actually *look* at the app without a native
build — it catches what `tsc` cannot, and serving the bundle and a mock behind one origin (a small
proxy forwarding `/api/*`) runs the whole app in a browser without adding CORS headers React Native
has no use for.

## Design system

Two materials that never blend, tokens under `src/theme/` (imported from `src/theme/index.ts`, not
an individual module — a screen gets the whole system or none of it):

- **Paper** — the sheet itself: white, black hairline rules, the newspaper faces
  (`src/theme/typography.ts`), unchanged in dark mode because a sheet of paper is a physical object
  photographed against a surround, not a themed surface. Today and Watch live here.
- **Desk / chrome** — near-black, the system font, rounded corners, for anything that issues a
  command. Desk and Board live here.

`src/theme/colors.ts` carries both palettes plus the two-tier signal colours (direction) and the
keylined-yellow grade treatment; `spacing.ts`, `radius.ts` and `motion.ts` are shared by both
materials. **Zero hex literals outside `src/theme/`** — every colour a component draws is a token
import, checked by reading the diff rather than by a lint rule, so a component reaching for a raw
`#` is a review comment waiting to happen.

**The animation gate**: nothing animates by default. `NativeTabs` never cross-fades between tabs —
the platform owns that, which is how the gate costs nothing rather than turning a JS animation off
— and the one press treatment a pressable is allowed (`src/theme/press.ts`: scale to `0.97` over
`motion.press` ms) is the single copy every button-shaped component imports rather than four local
copies that could drift. A refresh ring's duration is never a design constant — it is
`state.panel.refreshMs`, the board's own measured refresh time.

## The "nothing personal" rule for fixtures

Same rule as the firmware repo it lives beside (see the root `CLAUDE.md`): nothing that makes this
app's data look like somebody's own paper belongs in it. Mock data comes only from committed
files — `mock-desk.js`'s inline seed data and the shared `components/news_core/.../fixtures/news.json`
— never a real hostname, a real watchlist, or a real editorial instruction. If you're developing
against a real desk, its address and token live in Settings (base URL in `AsyncStorage`, token in
`SecureStore`/Keychain) or the `EXPO_PUBLIC_DESK_*` env vars above — never committed, never in a
fixture file.

## Releasing (EAS → TestFlight)

`eas.json` carries three profiles — `development` (dev client), `preview` (internal distribution)
and `production` (store). Production has `autoIncrement` on with the version source remote: the
build number lives with EAS, so nothing here needs bumping per build.

```bash
npm install -g eas-cli && eas login    # once
eas build -p ios --profile production
eas submit -p ios                      # or `npx testflight` — build + submit in one
```

The first run asks for an Apple Developer sign-in interactively — that is where Apple identifiers
live, in EAS's credential store and, if you want the prompts gone, in `EXPO_APPLE_ID` /
`EXPO_APPLE_TEAM_ID` in your shell — never in a committed file, which is why `eas.json` carries no
`appleId` or `ascAppId`. TestFlight needs the app to exist in App Store Connect with the matching
bundle id (`com.claudepost.app`); `eas submit` offers to create it.

**Forks:** `app.json`'s `extra.eas.projectId` names *this* app's Expo project. Run `eas init` in
your fork to claim your own before the first build.

## Project layout

```
app/
├─ app.json            Expo config (local-networking + cleartext + Bonjour, dark UI, icon)
├─ eas.json            EAS build/submit profiles — carries no Apple identifiers, on purpose
├─ assets/
│  └─ icon.png         generated — regenerate with python3 tools/make_icon.py (repo root)
├─ scripts/
│  ├─ mock-esp32.js    Node mock of the board's HTTP API (provisioning + control), :8080
│  └─ mock-desk.js     Node mock of the desk's HTTP API (device + control plane), :8090
└─ src/
   ├─ theme/           colors, typography, spacing, radius, motion, press — import from index.ts
   ├─ app/             expo-router file-based routes
   │  ├─ _layout.tsx           providers + the root Stack (tabs, watch detail, editions, settings)
   │  ├─ (tabs)/               Today, Watch, Desk, Board — the app itself
   │  ├─ watch/[symbol].tsx    one company off the watchlist, in full
   │  ├─ editions/             the editorial history and one edition's record
   │  ├─ notes/[kind]/[id].tsx the dossier beside an edition, or the note beside a command
   │  ├─ settings/
   │  │  ├─ index.tsx          desk address + token, board address, about — read/write config
   │  │  └─ pair/               the board-pairing wizard (turn-on → wifi-list → news → password → complete)
   │  ├─ compose.tsx           the order sheet — "order today's edition" / "research a ticker"
   │  └─ sheet/[source].tsx    a proof sheet, full size and zoomable, as a form sheet
   ├─ components/      Screen, Button, Card, Sheet, HeaderGear, EmptyState, … plus board/desk/today/watch subfolders
   ├─ lib/
   │  ├─ desk.ts            the desk client (device + control plane) + types  ← core
   │  ├─ esp32.ts           the board client (provisioning + control) + types ← core
   │  ├─ queries.ts         the one QueryClient and every screen's hooks onto both clients
   │  ├─ settings.ts        desk base URL (AsyncStorage) + token (SecureStore), ATS enforcement
   │  ├─ store.ts           the board's last-known base URL (AsyncStorage)
   │  ├─ discovery.ts       base-URL normalize/validate/resolve (pure), shared by both clients
   │  ├─ screen.ts          board framebuffer → indexed PNG, in the measured Spectra 6 inks
   │  ├─ device.tsx         app-wide board connection context
   │  ├─ watchlist.ts       grade filtering/sorting, thesis-block parsing
   │  ├─ audit.ts / editions.ts / directives.ts / queue.ts / scheduleform.ts / quotes.ts / spark.ts
   │  │                     — desk-domain parsing and formatting helpers, one file per concern
   │  ├─ md.ts              a small markdown renderer for dossiers and thesis notes
   │  ├─ newsurl.ts         edition-URL validation mirroring the firmware
   │  └─ format.ts          money / change / age / interval / fetch-result display helpers
   └─ onboarding/      flow.ts (pairing-wizard step logic) + OnboardingContext
```

## Local network and remote, both, on purpose

The board is LAN-only by design (see `docs/app-control.md`): no auth, no TLS, plain HTTP to an
address on your own network. The desk is reachable from the public internet by construction — it
sits behind a tunnel (`docs/hosting-cloudflare.md`) — so it is authenticated with a bearer token and
must answer on `https://`; `app.json`'s `NSAllowsLocalNetworking` ATS exception covers only the
board, and `src/lib/settings.ts` enforces the `https://`-for-the-desk rule on both platforms (iOS
partly at the OS level, Android — whose cleartext flag is project-wide — entirely by this check).

Wi-Fi credentials and the edition URL a board pairs with live on the board itself (NVS); the app
persists only the board's base URL (`AsyncStorage`) and the desk's base URL + token
(`AsyncStorage` + `SecureStore`). Those AsyncStorage keys are namespaced `claudepost.*` — a phone
that once ran the fortune board's app keeps its `tickerboard.*` entries untouched, since they point
at different hardware on the same LAN.
