# AGENTS.md

Entry point for Codex and any other agent that reads `AGENTS.md`. Codex picks this up from
anywhere in the tree, so it stays short and points at the documents that hold the detail.

**Read [CLAUDE.md](CLAUDE.md) first.** It is the project's own briefing — what this repository
builds, how to get an ESP-IDF environment, the five verification layers, and the working rules that
constrain nearly every change (colour is data; every span is even; the edition's language is one
wire field; nothing personal is committed). Nothing here repeats it.

## The one procedure worth naming here

**Shipping the companion app to TestFlight** is the task most likely to be attempted by an agent
that has not done it before, and the one where guessing costs hours. It is a single command:

```sh
tools/release-ios.py                          # archive, export, verify — stop there
ASC_APP_ID=<numeric app id> tools/release-ios.py --submit
```

- [.claude/skills/release-ios/SKILL.md](.claude/skills/release-ios/SKILL.md) — what the script
  handles that a person gets wrong, and the environment every `eas` command needs on this machine.
- [docs/app-testflight-release.md](docs/app-testflight-release.md) — the long-form runbook, written
  from a release that failed twice before it succeeded.

Three things from that page are worth carrying in your head even if you read nothing else:

- **EAS's free plan meters iOS *builds*, not submissions.** A local archive plus
  `eas submit --path` ships a release when the monthly allowance is spent.
- **The export re-signs.** `aps-environment` in `app.json` says nothing about what a shipped build
  is signed for; read the exported executable's own signature. Concluding otherwise from source has
  already produced one wrong report on this project.
- **Never pipe `xcodebuild` through `tee | tail`.** A pipeline's exit status is its last command's,
  so the archive's failure vanishes and the export reports "archive not found" instead — a signing
  error described as a missing file.

## Verifying a change

`CLAUDE.md`'s "Verify before claiming anything works" is the list, in the order that catches the
most for the least time. The short version, none of which needs hardware:

```sh
sh server/test/run.sh && sh agent/test/run.sh      # the desk and the worker
(cd app && npm test && npm run typecheck)          # the phone
cmake -S components/news_core/test/host -B /tmp/vt && cmake --build /tmp/vt   # the core
(cd sim && ./sim.sh)                               # the real UI at the real size, asserted on
```

The simulator is a test, not a preview: it fails the build on a missing glyph, on ink outside the
margin, on a composition that does not tile the well. Look at the sheets it writes.

**The companion app has one more rule, from its owner: render it on the iPhone simulator and look
at it before opening a PR.** The tile heights are estimated rather than measured, so only a render
shows a truncated headline or a column set 8 pt too narrow — the first render after a review
pipeline that had passed every property test found six layout defects. There is no `app/ios/`
committed, so it runs under Expo Go rather than a dev build:

```sh
cd app && npx expo start --ios --go     # --go is required: expo-dev-client is a dependency
```

Drive it with `xcrun simctl` (`openurl` for deep links, `io booted screenshot` for what it looks
like). Taps need `idb`, whose HID handle goes stale when the simulator restarts — reconnect before
concluding the UI is broken.
