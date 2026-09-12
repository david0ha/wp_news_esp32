#!/bin/sh
# deploy.sh -- put the desk on the wall, from a checkout nobody edits.
#
#   server/deploy.sh                      # deploy origin/main
#   server/deploy.sh --ref v1.2.3         # or any ref the remote has
#   server/deploy.sh --rollback           # put the previous image back
#   server/deploy.sh --dry-run            # say what it would do, do nothing
#
# WHY THIS FILE EXISTS, which is worth a paragraph because the answer is a real
# outage waiting to happen. The desk that served claudepost.daehun.dev for
# eighteen days was built from `.claude/worktrees/pr26`, a git worktree created
# for a pull request. That worktree has since been deleted. The containers kept
# running -- Docker needs the source only at build time -- but every `docker
# compose` command against that project pointed at a directory that was no
# longer there, so the desk could not be restarted, rebuilt or rolled back by
# the ordinary means. It was one `docker compose down` away from needing
# archaeology. A deployment must come from a checkout whose lifetime is not
# tied to a branch's.
#
# So: this script owns one directory, $DEPLOY_DIR (default ~/.claudepost/deploy),
# clones into it once, and afterwards only ever fetches and hard-resets it to
# the ref being deployed. Nothing is edited there and nothing should be.
#
# WHAT IS SAFE AND WHY. The desk's serving state -- the database, the editions,
# the schedule -- lives in the named volume `claudepost-data`, and the tokens
# live in a read-only bind mount from $HOME/.claudepost. Neither is in the image,
# so rebuilding the image destroys nothing. `name: claudepost` is pinned inside
# compose.yaml, which is what lets this run from a different directory than the
# last deploy did and still manage the same containers, the same volume and the
# same tunnel.
#
# THE GATE. The desk's own suite runs against the checkout being deployed before
# anything is built. It needs no network, no Docker and no hardware, it takes
# about two minutes, and it is the difference between shipping a desk and
# discovering at 06:00 that the newspaper did not file. `--no-gate` exists for
# an emergency and says so in the log when it is used.
#
# THE ROLLBACK. The image in service is tagged `claudepost-desk:previous` before
# a new one is built, so a deploy that fails its health check puts the old one
# back by itself. `--rollback` does the same thing by hand later, which is what
# you want when the desk is up and healthy and nevertheless wrong.
set -eu

REF="origin/main"
DEPLOY_DIR="${DEPLOY_DIR:-$HOME/.claudepost/deploy}"
REMOTE="${CLAUDEPOST_REMOTE:-git@github.com:david0ha/wp_news_esp32.git}"
PROJECT="claudepost"
HEALTH_URL="http://127.0.0.1:8790/healthz"
MARKET_URL="http://127.0.0.1:8790/api/market/summary?symbol=AAPL&modules=price"
GATE=1
DRY=0
ROLLBACK=0

while [ $# -gt 0 ]; do
    case "$1" in
        --ref)      REF="$2"; shift 2 ;;
        --source)   DEPLOY_DIR="$2"; shift 2 ;;
        --no-gate)  GATE=0; shift ;;
        --dry-run)  DRY=1; shift ;;
        --rollback) ROLLBACK=1; shift ;;
        -h|--help)  sed -n '2,8p' "$0"; exit 0 ;;
        *) echo "deploy: unknown argument $1" >&2; exit 2 ;;
    esac
done

say() { printf '== %s\n' "$*"; }
run() {
    printf '   $ %s\n' "$*"
    [ "$DRY" -eq 1 ] || "$@"
}

compose() {
    # The project directory is the SERVER directory, not the repository root,
    # and the difference is a failed build rather than a stylistic one:
    # compose resolves every relative path in the file against the project
    # directory, and compose.yaml says `context: ..`. Point it at the root and
    # that `..` climbs one level too high, so the build looks for the
    # Dockerfile in the deploy directory's PARENT and dies with
    # `lstat ~/.claudepost/server: no such file or directory`. Pointing it at
    # the server directory is also what the first hand-run deployment did,
    # which is why this was not noticed until there was a script.
    docker compose -p "$PROJECT" \
        --project-directory "$DEPLOY_DIR/server" \
        -f "$DEPLOY_DIR/server/compose.yaml" "$@"
}

# -- rollback ---------------------------------------------------------------

if [ "$ROLLBACK" -eq 1 ]; then
    if ! docker image inspect claudepost-desk:previous >/dev/null 2>&1; then
        echo "deploy: no claudepost-desk:previous to roll back to" >&2
        exit 1
    fi
    say "rolling back to claudepost-desk:previous"
    run docker tag claudepost-desk:previous claudepost-desk:latest
    run compose up -d desk cloudflared
    exit 0
fi

# -- the checkout -----------------------------------------------------------

if [ ! -d "$DEPLOY_DIR/.git" ]; then
    say "first deploy: cloning into $DEPLOY_DIR"
    run mkdir -p "$(dirname "$DEPLOY_DIR")"
    run git clone "$REMOTE" "$DEPLOY_DIR"
fi

say "fetching $REF"
run git -C "$DEPLOY_DIR" fetch --prune origin
# Hard reset rather than pull: this directory is a deployment artifact, not a
# workspace, and a merge conflict here would be a deploy that stops halfway.
run git -C "$DEPLOY_DIR" reset --hard "$REF"
run git -C "$DEPLOY_DIR" clean -fdx server app components sim tools agent

DEPLOYING=$(git -C "$DEPLOY_DIR" log --oneline -1 2>/dev/null || echo "(dry run)")
say "deploying $DEPLOYING"

# -- the gate ---------------------------------------------------------------

if [ "$GATE" -eq 1 ]; then
    say "gate: the desk's own suite"
    run sh "$DEPLOY_DIR/server/test/run.sh"
else
    say "gate: SKIPPED by --no-gate"
fi

# -- build, keeping the running image to fall back to -----------------------

if docker image inspect claudepost-desk:latest >/dev/null 2>&1; then
    say "tagging the image in service as claudepost-desk:previous"
    run docker tag claudepost-desk:latest claudepost-desk:previous
fi

say "building"
run compose build desk

say "starting"
run compose up -d desk cloudflared

# -- verify, and put the old image back if this one cannot serve ------------

if [ "$DRY" -eq 1 ]; then
    say "dry run: stopping before verification"
    exit 0
fi

say "waiting for health"
ok=0
i=0
while [ "$i" -lt 60 ]; do
    if curl -fsS -m 3 -o /dev/null "$HEALTH_URL" 2>/dev/null; then ok=1; break; fi
    i=$((i + 1))
    sleep 2
done

if [ "$ok" -eq 1 ]; then
    # A 401 is the right answer here and the only one worth waiting for: it
    # proves the route is MOUNTED. A 404 would mean the image predates the
    # market plane, which is exactly the deploy-of-the-wrong-thing this check
    # exists to catch, and it would otherwise show up as an empty tab on a
    # phone rather than as a failed deploy.
    code=$(curl -s -o /dev/null -w '%{http_code}' -m 5 "$MARKET_URL" || echo 000)
    case "$code" in
        401|403) say "market plane answers $code without a token — mounted" ;;
        *)       say "market plane answered $code, expected 401"; ok=0 ;;
    esac
fi

if [ "$ok" -eq 0 ]; then
    echo "deploy: the new desk did not come up clean" >&2
    if docker image inspect claudepost-desk:previous >/dev/null 2>&1; then
        say "rolling back"
        docker tag claudepost-desk:previous claudepost-desk:latest
        compose up -d desk cloudflared
        echo "deploy: rolled back to the previous image" >&2
    fi
    compose logs --tail 40 desk >&2 || true
    exit 1
fi

say "deployed $DEPLOYING"
compose ps --format 'table {{.Name}}\t{{.Status}}'
