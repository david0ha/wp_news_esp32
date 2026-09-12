# Deploying the desk

The desk runs on one Mac, in Docker, behind a Cloudflare tunnel that publishes
exactly one hostname at exactly one container port. Everything below follows
from that sentence, including the parts that look like they should be simpler.

```sh
server/deploy.sh                    # deploy origin/main, gated and verified
server/deploy.sh --rollback         # put the previous image back
server/deploy.sh --dry-run          # print what it would do
```

**Deployment is a command somebody runs.** There is no trigger, no timer and no
runner, and that is a decision rather than an omission — see
[Why there is no continuous deployment](#why-there-is-no-continuous-deployment).

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
6. **Run the contract suite** — `server/test/contract.py`, every app-visible
   behaviour, over the same routes and with the same token the phone uses. The
   smoke checks above prove the desk answers; this proves the Board tab, the
   Settings tab and the Ask screen still hold, which is the failure a
   market-plane deploy is most likely to cause and least likely to be looking
   for. A ref that predates the suite prints `contract: NOT RUN` and is not a
   failure: what is missing there is the evidence, not the desk.
7. **Roll back** to `claudepost-desk:previous` if any of that fails, then print
   the last forty log lines and exit non-zero.

### Deploying test-first

`server/test/contract.py --expect-red <group>` inverts a group of checks: the run
passes only if they **fail**. Run against the desk currently in service, before
deploying, it is the only way to know a check tests the change you are about to
make rather than something that was already true — a check seen only green
proves nothing. `.claude/skills/deploy-desk/SKILL.md` is the loop, and the groups
are named for the phone's screens rather than for URLs, because "the Options tab
is dead" is the sentence somebody needs.

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

## Why there is no continuous deployment

There is CI and there is no CD. A merge to `main` does not reach the wall until
somebody runs `server/deploy.sh`. Three arguments were had on the way to that,
and the order matters because the first one was wrong.

**A poll was tried and is not here.** A launchd agent that fetched `origin/main`
every fifteen minutes and deployed when the tip moved. It was defended on the
grounds that a webhook would mean opening a second ingress to this Mac. That is
true of a webhook and irrelevant to the alternative, which is the next
paragraph.

**A self-hosted GitHub Actions runner opens no ingress either.** It long-polls
*outbound* over HTTPS; GitHub never connects in. It would deploy on merge rather
than up to fifteen minutes later, and it would put the logs, the re-run button
and the failure notices in the same place as CI. On the merits of plumbing it
beats a poll outright, and the poll's justification did not survive contact with
that fact.

**What actually rules it out is that this repository is public.** Anyone may
fork it and open a pull request, and a `pull_request` workflow runs the code
*from the pull request*. A fork that adds `runs-on: self-hosted` runs on this
Mac — which holds the desk's operator and producer tokens, the Alpaca key, the
Cloudflare tunnel's credentials and an Apple distribution certificate. Runner
jobs are not sandboxed from each other or from the host. The proper containment,
a runner group restricted to named workflows, is an organization feature and is
not available on a personal repository; what is left is the fork-approval
setting, which is a defence that depends on nobody clicking *Approve and run*
without reading.

So the choice was: make the repository private and use a runner, keep it public
and accept a crude poll, or deploy by hand. **Deploying by hand was chosen**, and
it costs less than it sounds like — `server/deploy.sh` is one command, it gates
on 929 tests, it verifies what it started, and it rolls itself back. The thing a
timer would have added is not doing it, and the thing it would have removed is
somebody deciding that now is a good moment to change what a newspaper says.

If this repository ever goes private, a runner is the right answer and the
workflow is three lines around the same script.

## What is still done by hand

- **The app.** `tools/release-ios.py --submit` builds the IPA on this Mac and
  ships it. See [app-testflight-release.md](app-testflight-release.md); the
  version bump in `app/app.json` belongs in the feature's own pull request.
- **The board.** `idf.py build` and `tools/flash.sh`, over USB.
- **The worker.** It runs in its own compose project with its own credentials —
  `agent/README.md` — and is deliberately not in the desk's compose file.
