# Companion app: sync, control, and seeing the glass — plus TestFlight

Date: 2026-08-24. Status: approved for implementation (owner directed continuous execution).

## What this is

The repository already ships a companion app (`app/`, Expo SDK 56 + expo-router + TypeScript,
identity `com.claudepost.app`) whose *shape* is right and whose *contract* is stale: it still
speaks the pre-redesign notes-board `/api/state`, believes in four pages where the device has two,
knows nothing of the `power` block, and never calls `POST /api/sleep`. `docs/app-control.md`
says as much. This design brings the app up to the device that actually exists, adds the one
capability no part of the system has today — seeing the page on the glass from the phone — and
gives the app the release pipeline the reference project never had: EAS build → TestFlight.

## Goals

1. The app syncs with and controls the current device: full `/api/state` (edition, subject,
   counts, headlines, source, battery, panel, power), page switch (A1/A2), refresh, news URL,
   display test, and the sleep interval (`POST /api/sleep`) with `sleepSource` shown honestly.
2. The app shows what the panel is showing: a preview rendered from the device's own framebuffer
   in the measured Spectra-6 inks — the sim's "judge it as paper" palette, not the saturated one.
3. `eas build -p ios` → `eas submit` to TestFlight works from `app/`.

## Non-goals

Talking to the desk server from the app (auth, drafts, proofs — the desk is the producer's tool);
Android store release (the config stays valid, but the pipeline exercised is iOS/TestFlight);
waking a sleeping board from the app (physics: the radio is off; the app explains instead).

## D1 — `GET /api/screen`: the framebuffer, verbatim

The device gains one read-only route in `components/device_api/device_api.c`:

- `GET /api/screen` → `200`, `Content-Type: application/octet-stream`, body = the framebuffer,
  exactly `EPD6_FB_SIZE` (960,000) bytes: portrait 1200×1600, 4bpp, stride 600, two pixels per
  byte, nibble order and palette indices exactly as `epd6_transpose.h` / `wp_palette.h` define
  them. Headers `X-Screen-Width: 1200`, `X-Screen-Height: 1600`, `X-Screen-Stride: 600`,
  `X-Screen-Bpp: 4`, `X-Screen-Format: claudepost-6ink-v1` describe it; the format token is the
  contract's version handle.
- If the framebuffer does not exist (defensive — the API server only runs on the full boot path,
  which allocates it) → `503` `{"ok":false,"error":"no_framebuffer"}`.
- Sent with `httpd_resp_send_chunk` in fixed-size pieces straight from PSRAM; no copy, no
  allocation. A request that lands mid-render may see a torn frame; that is a preview artifact,
  not a defect, and the docs say so. The httpd task never calls LVGL.

Why raw-from-device rather than desk proof PNGs or an app-side typesetter: it is the literal
glass, it works on a board with no desk (demo page included), and it costs the firmware no image
codec. It answers only while the board is awake — the same constraint as every control, already
documented in `docs/app-control.md`.

## D2 — the app speaks the real contract

`app/src/lib/esp32.ts` is rewritten against `components/news_core/device_api_json.c` (the single
source of truth for field names) and `docs/app-control.md`: `DeviceState` gains
`news{valid,demo,edition,generatedAt,subject,counts,headlines,indices}`,
`source{url,lastResult,pollSeconds,pollSource,ageSeconds,stale}`, `battery`, `panel{refreshMs}`,
`power{deepSleep,sleepSeconds,sleepSource,wakes,quietWakes,meanAwakeMs,estMahPerDay}`; pages are
0 and 1; `setSleep(seconds)` posts `/api/sleep` (device clamps to [60, 86400], 0 = default).
`capture.ts` and its UI are deleted: it targets `tools/news_server.py --allow-capture`, a
producer removed in the desk redesign — the endpoint has no server left to answer it.
`app/scripts/mock-esp32.js` is updated to the same contract, including a deterministic synthetic
`/api/screen`, so the app can be developed against the mock alone.

## D3 — screens

Dashboard: edition card (symbol, name, price and change through the up/down colours, edition id,
generated-at), headlines, source card (URL, stale badge, poll cadence and its source), power card
(deep sleep on/off, effective interval + `sleepSource`, wakes/quiet wakes, estimated mAh/day),
battery, and the actions — refresh, page A1/A2, news URL, display test, sleep interval. New
`preview` route: fetches `/api/screen`, decodes 4bpp → indexed PNG in TypeScript (`pako` deflate,
palette = the measured ink table transcribed from `wp_palette.c`), shows it zoomable; a fetch
failure explains the awake-window rule instead of erroring. Onboarding survives untouched except
where field names drifted. The visual idiom stays the app's own (`theme.ts`, existing components).

## D4 — TestFlight

`app/eas.json` gains `development` (dev client), `preview` (internal), `production` (store)
profiles; `eas init` binds the app to the owner's logged-in Expo account; an app icon is added
(app.json today declares none, and App Store Connect refuses icon-less uploads). Pipeline:
`eas build -p ios --profile production` then `eas submit -p ios`. First-time Apple sign-in is
interactive by design; everything up to that point is automated and the remaining command is
handed to the owner. Nothing personal is committed: `eas.json` carries no Apple identifiers
(they live in EAS's credential store), and the Expo project id in `app.json` is not a secret.

## Verification

`cd app && npm test && npm run typecheck` green; firmware ladder unchanged and green
(`host tests`, `idf.py build`); `docs/app-control.md` documents `/api/screen` and the app section
stops calling itself stale; mock server serves the new contract end to end.

## Risks

Torn preview during a render (accepted, documented); PNG decode cost on phone (~2 MB indexed
image — bounded, done off the UI thread's critical path); Apple-side steps that cannot be
automated (account enrolment, first sign-in) are surfaced as owner actions, not silent failures.
