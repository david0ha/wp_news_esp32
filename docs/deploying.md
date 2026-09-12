# Deploying the desk

The desk runs on one Mac, in Docker, behind a Cloudflare tunnel that publishes
exactly one hostname at exactly one container port. Everything below follows
from that sentence, including the parts that look like they should be simpler.

```sh
server/deploy.sh                    # deploy origin/main, gated and verified
server/deploy.sh --rollback         # put the previous image back
server/deploy.sh --dry-run          # print what it would do
sh server/tools/install-autodeploy.sh   # optional: deploy a merge by itself
```

## The outage this is built around

The desk that served `claudepost.daehun.dev` for eighteen days was built from
`.claude/worktrees/pr26` — a git worktree created for a pull request, and
deleted when that pull request merged. The containers kept running, because
Docker needs the source only at build time. But the compose project still
pointed at a directory that no longer existed, so the desk could not be
rebuilt, restarted or rolled back by the ordinary means. It was one
`docker compose down` away from needing archaeology to get back.

Nothing was lost, and the reason is worth stating because it is also what makes
redeployment safe: **the serving state is not in the image.** The database, the
editions and the schedule live in the named volume `claudepost-data`; the
tokens live in a read-only bind mount from `$HOME/.claudepost`. Rebuilding
destroys neither.

So `server/deploy.sh` owns one directory — `~/.claudepost/deploy` — clones into
it once, and afterwards only ever fetches and hard-resets it to the ref being
deployed. It is a deployment artifact, not a workspace. Nothing is edited there.

## What a deploy does, in order

1. **Fetch and hard-reset** the deployment checkout to the ref. A hard reset
   rather than a pull, because a merge conflict in a deployment directory is a
   deploy that stops halfway.
2. **Gate.** The desk's own 929 tests run against the checkout being deployed,
   before anything is built. Two minutes, no network, no Docker, no hardware.
   `--no-gate` exists for an emergency and says so in the log when used.
3. **Tag the image in service** as `claudepost-desk:previous`.
4. **Build and start.**
5. **Verify**, and this is the step that earns its place. `/healthz` proves the
   desk is answering. Then `/api/market/summary` without a token must answer
   **401** — because a 401 proves the route is *mounted*, where a 404 would mean
   the image predates the market plane. That is precisely the
   deployed-the-wrong-thing failure that otherwise shows up as an empty tab on
   somebody's phone rather than as a failed deploy.
6. **Roll back** to `claudepost-desk:previous` if any of that fails, then print
   the last forty log lines and exit non-zero.

`name: claudepost` is pinned inside `compose.yaml`. That is what lets a deploy
run from a different directory than the last one did and still manage the same
containers, the same volume and the same tunnel.

### One trap, since it cost a build

`docker compose` resolves every relative path in the file against the
**project directory**, and `compose.yaml` says `context: ..`. The project
directory must therefore be `server/`, not the repository root — point it at the
root and that `..` climbs one level too high, and the build dies with
`lstat ~/.claudepost/server: no such file or directory`, which reads like a
missing checkout and is a misplaced base path.

## Continuous integration

[`.github/workflows/ci.yml`](../.github/workflows/ci.yml) runs four of
`CLAUDE.md`'s five verification layers on every push and pull request, on a
machine with no ESP-IDF, no Xcode and no leftover state — so "works here" and
"works" stop being the same claim.

| job | what it holds |
|---|---|
| `desk and worker` | the desk's suite, the worker's, provisioning, the reference producer, the language gate, the event book |
| `the phone` | `npm test` and `tsc --noEmit` |
| `news_core host tests` | the twelve host tests, named individually so a test that stops being built fails the step |
| `the simulator, which is a test` | typesets the demo edition and the Korean fixture, and uploads the sheets as an artifact |

Layer 4 — `idf.py build` — is not there. It wants a 1.5 GB toolchain for a
target no runner can flash, and it stays on the developer's machine.

## Continuous deployment, and why it is a poll

`server/tools/install-autodeploy.sh` installs a launchd agent that every fifteen
minutes fetches `origin/main` and, if the tip has moved, runs `deploy.sh` —
which brings its own gate and its own rollback. If nothing moved it exits
without touching Docker, so the ordinary case costs one HTTPS request.

A webhook would be faster and is the wrong shape here. It would mean opening a
second ingress so GitHub can reach this Mac, against a machine whose entire
security story is *one hostname, one port, token-gated*. A poll needs no ingress
at all: the Mac asks GitHub, GitHub answers, and nothing new is reachable from
the internet. Fifteen minutes is well inside how long it takes anybody to notice
a newspaper is stale.

Installing it does **not** deploy — the first check is one interval away, which
gives whoever ran the installer time to think.

```sh
sh server/tools/install-autodeploy.sh --status      # loaded? and the last 20 log lines
sh server/tools/install-autodeploy.sh --uninstall
```

The log is `~/.claudepost/autodeploy.log`. Read it before believing the desk is
current: launchd swallows a failure that the log does not.

## What is still done by hand

- **The app.** `tools/release-ios.py --submit` builds the IPA on this Mac and
  ships it. See [app-testflight-release.md](app-testflight-release.md); the
  version bump in `app/app.json` belongs in the feature's own pull request.
- **The board.** `idf.py build` and `tools/flash.sh`, over USB.
- **The worker.** It runs in its own compose project with its own credentials —
  `agent/README.md` — and is deliberately not in the desk's compose file.
