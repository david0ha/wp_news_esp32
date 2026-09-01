#!/usr/bin/env bash
#
# run-host.sh — run the worker on this machine instead of in a container, so that
# it files on the operator's Claude subscription rather than on a metered key.
#
#   ./agent/run-host.sh              # claim, file, repeat, until interrupted
#   ./agent/run-host.sh --once       # exit after the first instruction is handled
#
# Why this exists at all. `claude --print` inside agent/Dockerfile has no login
# session to inherit: an image is not a signed-in machine, so the only ways in
# are ANTHROPIC_API_KEY (metered) or CLAUDE_CODE_OAUTH_TOKEN (a long-lived
# subscription token from `claude setup-token`). On the machine somebody is
# already signed in on there is a third way, and it needs no credential handling
# at all — the CLI reads ~/.claude/.credentials.json itself. Same loop.py, same
# desk, same gates; only the process boundary moves.
#
# The trade is real and worth naming: the container is isolated and restarts
# itself, this is a process on a laptop that sleeps. Use the container with a
# token if the paper must appear whether or not this machine is awake; use this
# if the subscription is the point.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# The operator's own values, if they left any. Same file the container reads, so
# a machine can move between the two arrangements without a second copy of the
# settings — only the paths differ, and those are defaulted below.
#
# Read as KEY=value rather than sourced, because that is what it is: compose
# parses it that way, and agent/deskclient.py parses ~/.claudepost/agent.env
# that way. Sourcing it makes the file a shell script, and the first value that
# is not also valid shell takes the whole run down before it starts — which is
# exactly what AGENT_TOOLS does, since `Bash(python3 ...)` is a syntax error and
# a perfectly good allow-list entry.
if [ -f "$REPO/agent/.env" ]; then
    while IFS= read -r line || [ -n "$line" ]; do
        case "$line" in ''|\#*) continue ;; *=*) ;; *) continue ;; esac
        key=${line%%=*}
        value=${line#*=}
        # A key that is not a shell name is not a setting, and it is about to
        # be handed to `export`. The file is the operator's own, so this is
        # about a typo producing a legible skip rather than an obscure error.
        case "$key" in
            [A-Za-z_]*) case "$key" in *[!A-Za-z0-9_]*) continue ;; esac ;;
            *) continue ;;
        esac
        # One layer of quotes off, the way a human writes them and the way the
        # two python readers take them off.
        case "$value" in
            \"*\") value=${value#\"}; value=${value%\"} ;;
            \'*\') value=${value#\'}; value=${value%\'} ;;
        esac
        # An already-set variable wins: the environment is what the operator
        # typed on this run, the file is what they wrote once.
        if [ -z "${!key:-}" ]; then
            export "$key=$value"
        fi
    done < "$REPO/agent/.env"
fi

# The image's defaults are container paths (/repo, /scratch, /run/secrets) and a
# desk on a docker network. None of the four is right out here, so all four are
# set rather than inherited.
export CLAUDEPOST_DESK="${CLAUDEPOST_DESK:-http://127.0.0.1:8790}"
export CLAUDEPOST_SECRETS="${CLAUDEPOST_SECRETS:-$HOME/.claudepost}"
export CLAUDEPOST_REPO="$REPO"
export CLAUDEPOST_SCRATCH="${CLAUDEPOST_SCRATCH:-$HOME/.claudepost/scratch}"
export CLAUDEPOST_LOG_LEVEL="${CLAUDEPOST_LOG_LEVEL:-INFO}"

# A context directory is opt-in in the container because a default there would
# be somebody's disk. Out here the default is this machine's own, and only when
# it exists — your own morning ordering job is what fills it (see "Bring
# your own continuity" in agent/README.md).
if [ -z "${AGENT_CONTEXT_DIR:-}" ] && [ -d "$CLAUDEPOST_SECRETS/context" ]; then
    export AGENT_CONTEXT_DIR="$CLAUDEPOST_SECRETS/context"
fi

# Keeping the operator's plugins and orchestration layer out of the child
# (DISABLE_OMC) happens in loop.py's child_env(), beside --strict-mcp-config:
# one policy, one place, and a bare `python3 loop.py` on a host gets it too.
# CLAUDEPOST_KEEP_PLUGINS=1 switches it off there.

die() { echo "run-host: $1" >&2; exit 1; }

command -v python3 >/dev/null 2>&1 || die "python3 is not on PATH."
if ! command -v claude >/dev/null 2>&1; then
    echo "run-host: the 'claude' CLI is not on PATH." >&2
    echo "  launchd starts with a minimal PATH; set it in the plist rather than" >&2
    echo "  in your shell profile, which launchd never reads." >&2
    exit 1
fi

# An API key beside a subscription login is the one failure nothing downstream
# can see: claude starts either way, the paper is identical, and the difference
# is a bill four weeks later. This script is the answer to "run it on the
# subscription", so the key comes out of the environment unless somebody says
# otherwise in so many words.
if [ -n "${ANTHROPIC_API_KEY:-}" ] && [ "${CLAUDEPOST_USE_API_KEY:-0}" != "1" ]; then
    echo "run-host: ANTHROPIC_API_KEY is set; unsetting it for this run so the" >&2
    echo "  subscription is what pays. Set CLAUDEPOST_USE_API_KEY=1 to keep it." >&2
    unset ANTHROPIC_API_KEY
fi

# The preflight mirrors loop.claude_auth's three routes *including* the
# agent.env file -- the file this message names. An earlier version never read
# it, so an operator who followed the printed instruction was still refused on
# the next run.
if [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] && [ -z "${ANTHROPIC_API_KEY:-}" ] \
   && [ ! -f "$HOME/.claude/.credentials.json" ] \
   && ! grep -qsE '^(CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY)=.' \
        "$CLAUDEPOST_SECRETS/agent.env"; then
    echo "run-host: this machine is not signed in to Claude Code." >&2
    echo "  Run 'claude' once and sign in, or put CLAUDE_CODE_OAUTH_TOKEN" >&2
    echo "  (from 'claude setup-token') in $CLAUDEPOST_SECRETS/agent.env." >&2
    exit 1
fi

# Fail here rather than in a claim loop that retries a 401 forever. loop.py
# exits 2 on a missing producer token, but it does so after the first request,
# and a desk that is not up looks identical from there.
[ -d "$CLAUDEPOST_SECRETS" ] || die "no $CLAUDEPOST_SECRETS — mint a producer token first:
  server/tools/mint-token.sh producer agent"

# Only now: under the defaults the scratch directory lives inside the secrets
# directory, and creating it above the guard would create the secrets directory
# too — so the guard could never fire and the friendly message never printed.
mkdir -p "$CLAUDEPOST_SCRATCH"

if ! curl -fsS --max-time 5 "$CLAUDEPOST_DESK/healthz" >/dev/null 2>&1; then
    echo "run-host: the desk at $CLAUDEPOST_DESK did not answer /healthz." >&2
    echo "  Starting anyway — the claim loop backs off and picks it up when it" >&2
    echo "  comes back, which is what a desk restart looks like from here." >&2
fi

# tools/make_tile.py needs Pillow, and a Homebrew or system python3 refuses to
# install into itself (PEP 668). Without it the photograph step fails at the
# moment the worker reaches for it, forty minutes into a filing run — so the
# environment is fixed here, once, and the venv's bin goes on PATH so that the
# allow-listed `python3 <repo>/tools/make_tile.py` resolves to a python that can
# open a JPEG. A paper without a picture still prints, so a failure here is a
# warning rather than an exit.
TILE_VENV="${CLAUDEPOST_VENV:-$CLAUDEPOST_SECRETS/venv}"
if [ ! -x "$TILE_VENV/bin/python3" ]; then
    echo "run-host: creating $TILE_VENV for Pillow (once)"
    python3 -m venv "$TILE_VENV" \
        && "$TILE_VENV/bin/pip" install --quiet --disable-pip-version-check pillow \
        || echo "run-host: could not build the tile venv; photographs will fail" >&2
fi
if "$TILE_VENV/bin/python3" -c 'import PIL' >/dev/null 2>&1; then
    export PATH="$TILE_VENV/bin:$PATH"
else
    echo "run-host: Pillow is not importable; tools/make_tile.py will refuse and" >&2
    echo "  the paper will come out without photographs." >&2
fi

echo "run-host: desk $CLAUDEPOST_DESK, repo $REPO, context ${AGENT_CONTEXT_DIR:-(none)}"
cd "$REPO/agent"
if [ "${1:-}" = "--once" ]; then
    export CLAUDEPOST_ONCE=1
fi
exec python3 loop.py
