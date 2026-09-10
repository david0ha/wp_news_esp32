#!/usr/bin/env bash
#
# install-docker.sh — move the worker off this machine's launchd and into the
# container, on this machine.
#
#   ./agent/install-docker.sh
#   ./agent/install-docker.sh --keep-launchd     # build and start, stand nothing down
#
# The twin of agent/run-host.sh, and the choice between them is a bill and a
# wall. run-host.sh spends the operator's Claude subscription and runs every
# turn as the operator; this spends a token and runs every turn as `model`, a
# user that cannot read the desk credential. Both claim from the same queue.
#
# Two workers on one queue would race for every command, which is why this
# stands the launchd job down rather than leaving it to be noticed later.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SECRETS="${CLAUDEPOST_SECRETS:-$HOME/.claudepost}"
LABEL=com.claudepost.worker

die() { echo "install-docker: $1" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || die "docker is not on PATH."
docker info >/dev/null 2>&1 || die "docker is installed but not running. Start Docker Desktop."

# 1. The credentials, which compose reads ON THE HOST and hands to the loop as
#    its environment. They are deliberately not mounted -- a bind mount's mode
#    is not enforced on Docker Desktop for Mac, so a mounted agent.env is
#    readable by every user in the container including the one the model runs
#    as. See agent/test/image.sh.
[ -f "$SECRETS/agent.env" ] || die "no $SECRETS/agent.env — mint a producer token first:
  server/tools/mint-token.sh producer agent
  then put CLAUDEPOST_TOKEN=<it> in $SECRETS/agent.env, mode 0600."

grep -qsE '^CLAUDEPOST_TOKEN=.' "$SECRETS/agent.env" \
    || die "$SECRETS/agent.env has no CLAUDEPOST_TOKEN. The worker cannot file without one."

grep -qsE '^(CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY)=.' "$SECRETS/agent.env" \
    || die "$SECRETS/agent.env has neither CLAUDE_CODE_OAUTH_TOKEN nor ANTHROPIC_API_KEY.
  Headless Claude Code in a container finds no desktop login to inherit, so one of
  them has to be there. \`claude setup-token\` mints the first, which spends the
  subscription; the second is metered."

# 2. The rotation cursor, which now has a mount of its own -- writable, where
#    the old secrets mount was read-only and a container could seed the watch
#    list but never advance it.
mkdir -p "$SECRETS/state"
if [ -f "$SECRETS/watchlist.json" ] && [ ! -f "$SECRETS/state/watchlist.json" ]; then
    echo "install-docker: moving watchlist.json into $SECRETS/state/"
    mv "$SECRETS/watchlist.json" "$SECRETS/state/watchlist.json"
fi

# 3. The network, which neither compose file creates because neither owns the
#    other.
docker network inspect claudepost >/dev/null 2>&1 || {
    echo "install-docker: creating the claudepost network"
    docker network create claudepost >/dev/null
}

# 4. The image, from THIS checkout. The build context is the repository root:
#    the image carries tools/ as well as the loop.
echo "install-docker: building claudepost-agent:latest from $REPO"
docker build -f "$REPO/agent/Dockerfile" -t claudepost-agent:latest "$REPO"

# 5. The wall, checked rather than assumed. A worker whose model user can read
#    the loop's environment is a worker with no wall, and finding that out here
#    costs a minute where finding it out later costs the token.
sh "$REPO/agent/test/image.sh"

# 6. Two workers on one queue race for every command.
if [ "${1:-}" != "--keep-launchd" ]; then
    if launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
        echo "install-docker: standing the launchd worker down"
        launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    fi
    if [ -f "$HOME/Library/LaunchAgents/$LABEL.plist" ]; then
        echo "install-docker: NOTE — $HOME/Library/LaunchAgents/$LABEL.plist is still"
        echo "  installed and will start again at your next login. Remove it yourself"
        echo "  when you are sure the container is the arrangement you want:"
        echo "      rm ~/Library/LaunchAgents/$LABEL.plist"
    fi
fi

# 7. Up. --no-build because step 4 already did it, from a context this script
#    named rather than one compose inferred.
echo "install-docker: starting the worker"
docker compose -f "$REPO/agent/compose.yaml" up -d --no-build

echo
echo "install-docker: up. The worker claims from ${CLAUDEPOST_DESK:-http://desk:8080}."
echo "  docker compose -f agent/compose.yaml logs -f"
echo "  docker compose -f agent/compose.yaml down"
