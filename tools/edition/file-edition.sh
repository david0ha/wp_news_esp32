#!/usr/bin/env bash
#
# file-edition.sh — wake Claude Code, have it file a front page, leave it where the board can poll.
#
# This is the whole producer. There is no server-side application: the "backend" is an agent with a
# market data connection and a directory, and the contract between it and the firmware is one JSON
# file plus some tiles. That is deliberate — the board polls a URL, and anything that can serve that
# URL works, so the least machinery that can produce it wins.
#
#   ./tools/edition/file-edition.sh            # file now
#   ./tools/edition/file-edition.sh --serve    # file now, then serve until interrupted
#
# Scheduled twice a day by com.wpnews.edition.plist; see README in this directory.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
EDITION_DIR="${EDITION_DIR:-$HOME/.wpnews/edition}"
PORT="${WPNEWS_PORT:-8123}"
LOG="$EDITION_DIR/log/$(date +%Y-%m-%d_%H%M).log"

mkdir -p "$EDITION_DIR/tiles" "$EDITION_DIR/log"

if ! command -v claude >/dev/null 2>&1; then
    echo "file-edition: the 'claude' CLI is not on PATH." >&2
    echo "  launchd runs with a minimal PATH; set it in the plist, not in your shell profile." >&2
    exit 1
fi

serve() {
    echo "serving $EDITION_DIR on http://$(ipconfig getifaddr en0 2>/dev/null || hostname):$PORT"
    echo "point the board at  http://<this machine>:$PORT/news.json"
    cd "$EDITION_DIR" && exec python3 -m http.server "$PORT" --bind 0.0.0.0
}

if [ "${1:-}" = "--serve-only" ]; then serve; fi

echo "filing into $EDITION_DIR  (log: $LOG)"

# --print runs headless and exits; the prompt is the desk's standing instructions. The tools it
# needs are the market data MCP, the filesystem under EDITION_DIR, and make_tile.py — nothing else,
# which is why the allow-list is narrow rather than --dangerously-skip-permissions.
EDITION_DIR="$EDITION_DIR" \
claude --print \
    --add-dir "$EDITION_DIR" \
    --allowedTools \
        "Read,Write,Edit,Glob,Grep,WebSearch,WebFetch,mcp__claude_ai_Alpaca__*,Bash(python3 $REPO/tools/make_tile.py:*),Bash(python3 $REPO/tools/mock_news_server.py:*)" \
    "$(cat "$REPO/tools/edition/PROMPT.md")

The repository is at $REPO. The edition directory is $EDITION_DIR." \
    2>&1 | tee "$LOG"

if [ ! -s "$EDITION_DIR/news.json" ]; then
    echo "file-edition: no news.json was produced — see $LOG" >&2
    exit 1
fi

python3 "$REPO/tools/mock_news_server.py" --validate "$EDITION_DIR/news.json"

# Keep a week. The board only ever reads the current one, but when a page comes out wrong the
# question is always "what changed since yesterday", and that needs yesterday.
cp "$EDITION_DIR/news.json" "$EDITION_DIR/log/$(date +%Y-%m-%d_%H%M).json"
find "$EDITION_DIR/log" -type f -mtime +7 -delete

echo "filed: $(python3 -c "
import json,sys
d=json.load(open('$EDITION_DIR/news.json'))
s=d['stories'][0] if d.get('stories') else {}
print(f\"{len(d.get('stories',[]))} stories, {len(d.get('tickers',[]))} quotes — lead: {s.get('headline','(none)')}\")")"

[ "${1:-}" = "--serve" ] && serve
exit 0
