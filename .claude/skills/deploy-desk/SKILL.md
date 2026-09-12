---
name: deploy-desk
description: Use when deploying the Claude Post desk (server/) so the companion app keeps working — a test-first loop that proves the app-visible behaviour is broken BEFORE deploying and fixed after, with a rollback that fires by itself. Also the place to look when a deploy went out and a tab on the phone is empty.
---

# deploy-desk — red, deploy, green

Deployment on this project is a command somebody runs. There is no timer and no
runner, deliberately — `docs/deploying.md` has the argument. What this skill adds
is the discipline: **the check that proves the deploy worked must be seen to fail
first.**

```sh
python3 server/test/contract.py --expect-red <group>   # RED   — before
server/deploy.sh                                       # deploy
python3 server/test/contract.py --write                # GREEN — after
```

## Why a deploy needs test-first at all

`server/test/run.sh` proves the desk's logic with stubs — no socket, no Docker,
no image. It is the right gate before a build and it **cannot tell you that the
thing now serving is the thing you built.** Every deployment failure this project
has actually had was of that second kind, and none of them looked like an error:

- Eighteen days served from `.claude/worktrees/pr26`, a worktree deleted when its
  pull request merged. The desk was up and healthy and could not be rebuilt.
- The market plane merged and the phone's Info, Calendar and Options tabs stayed
  empty, because the desk in service predated it. A 404 on the phone renders as a
  friendly card, not as a page anybody reports.

A check written *after* a deploy and seen only green proves nothing: it may be
testing something that was already true. Watching it go red first is the only
evidence that it tests the change.

## The loop

### 1. Name what should break

Pick the group in `server/test/contract.py` that covers the change. The groups
are named for the phone's screens, not for URLs, because "the Options tab is
dead" is the sentence somebody needs and "`/api/market/options` answered 404" is
not.

| group | screens it guards |
|---|---|
| `device` | the Today tab and the board — `news.json`, health, and that the control plane is closed to anonymous callers |
| `settings` | Settings — the edition language, the registered phones, the positions |
| `board` | Board — the papers list, the event book |
| `markets` | Markets — the proxied watchlist prices |
| `market` | Info, Calendar and Options — the crumb-gated plane the desk fetches from Yahoo |
| `ask` | the Ask screen — the command queue |

**If nothing in the suite would break, the suite is missing a check.** Write it
before deploying, not after. A check belongs here when a phone screen would go
wrong without it — not for every route.

### 2. Watch it go red, against the desk in service

```sh
python3 server/test/contract.py --expect-red market
```

`--expect-red` inverts that group: the run passes **only if those checks fail**.
If they already pass it says so and exits non-zero:

```
NOT RED: 6 of 6 'market' checks already pass. They are not testing
the change you are about to deploy.
```

That message is the point of the flag. Treat it as a stop, not a nuisance —
either the desk already has the change, or the check is testing the wrong thing.

To produce a red deliberately (verifying the suite itself, or rehearsing), run
the previous image on a scratch port; it needs the tokens mount and nothing else:

```sh
docker run -d --rm --name contract-old -p 127.0.0.1:8795:8080 \
  -v "$HOME/.claudepost:/run/secrets:ro" claudepost-desk:previous
python3 server/test/contract.py --desk http://127.0.0.1:8795 --expect-red market
docker rm -f contract-old
```

### 3. Deploy

```sh
server/deploy.sh
```

It hard-resets `~/.claudepost/deploy` to `origin/main` — a checkout nobody edits,
so no deploy is ever tied to a branch's lifetime — gates on the desk's 929 tests,
tags the image in service as `claudepost-desk:previous`, builds, starts, and
rolls back by itself if the desk cannot serve. `--rollback` does it later by
hand; `--dry-run` prints without doing.

### 4. Watch it go green — all of it, not just the group

```sh
python3 server/test/contract.py --write
```

**Run the whole suite, not `--only`.** The failure worth catching at this point
is the one nobody was looking for: a change to the market plane that broke the
Board tab is exactly what a narrowed run misses. `--write` adds the round trips
that write and put back, and is safe on a live desk — it writes each value back
as it found it.

Green is the end of the deploy. Not the build succeeding, not the container
being healthy: those are earlier and weaker facts.

## When it comes back red after the deploy

`deploy.sh` has already rolled back if the desk could not serve at all. A
contract failure after a *successful* deploy is narrower than that and means the
desk is up and wrong.

1. Read the sentence. Every check says which screen breaks and why.
2. `server/deploy.sh --rollback` puts the previous image back. Do this first if
   the phone is somebody's; diagnose afterwards.
3. Fix it under `superpowers:test-driven-development` — the failing contract
   check is already the failing test, so start from the desk's own suite in
   `server/test/` and make a unit test fail the same way before touching code.

## What this does not cover

- **The phone itself.** The contract proves the desk answers what the app needs.
  It does not prove the app draws it. That is the iPhone simulator, and this
  project's rule is to render before opening a pull request — `AGENTS.md`.
- **The board.** `idf.py build` and `tools/flash.sh`, over USB.
- **The app release.** `tools/release-ios.py --submit`, and the `release-ios`
  skill beside this one.
- **Push delivery.** Production entitlements do not establish it; that needs a
  device and an Expo push receipt.

## Reference

- `docs/deploying.md` — the long form, including why there is no CD
- `server/deploy.sh` — the deploy, its gate, its verification and its rollback
- `server/test/contract.py` — the checks, one per app behaviour
- `.github/workflows/ci.yml` — the four suites that run before any of this
