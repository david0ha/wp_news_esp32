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
# needs are the market data MCP, the filesystem under EDITION_DIR, make_tile.py, and the render
# check — nothing else, which is why the allow-list is narrow rather than
# --dangerously-skip-permissions.
#
# render-check.sh is on that list because the desk cannot see the paper. It writes JSON; the panel
# spends twenty-five seconds turning that JSON into type, and a lead headline four characters too
# long comes out with an ellipsis in the middle of a sentence. Validating the schema does not catch
# that — only setting the type catches it — so the desk is given the typesetter and told to look at
# what it produced before filing. It is the one tool here that changes what gets written rather
# than what gets read.
EDITION_DIR="$EDITION_DIR" \
claude --print \
    --add-dir "$EDITION_DIR" \
    --allowedTools \
        "Read,Write,Edit,Glob,Grep,WebSearch,WebFetch,mcp__claude_ai_Alpaca__*,Bash(python3 $REPO/tools/make_tile.py:*),Bash(python3 $REPO/tools/mock_news_server.py:*),Bash($REPO/tools/edition/render-check.sh:*)" \
    "$(cat "$REPO/tools/edition/PROMPT.md")

The repository is at $REPO. The edition directory is $EDITION_DIR." \
    2>&1 | tee "$LOG"

if [ ! -s "$EDITION_DIR/news.json" ]; then
    echo "file-edition: no news.json was produced — see $LOG" >&2
    exit 1
fi

python3 "$REPO/tools/mock_news_server.py" --validate "$EDITION_DIR/news.json"

# And typeset it, as the last gate. The desk was told to do this before filing and the prompt is
# emphatic about it, but a standing instruction is a request and this is a check: a page that does
# not set is a page that reaches the wall broken, and the twenty-five seconds it costs to find that
# out on the glass are twenty-five seconds nobody gets back. Non-zero here means the edition just
# filed will not print correctly, and the log says which rule it broke.
if ! "$REPO/tools/edition/render-check.sh" "$EDITION_DIR/news.json" "$EDITION_DIR/log/proof"; then
    echo "file-edition: the filed edition does not typeset — see the log and $EDITION_DIR/log/proof" >&2
    exit 1
fi

# Keep a week. The board only ever reads the current one, but when a page comes out wrong the
# question is always "what changed since yesterday", and that needs yesterday — and the proof
# sheets alongside it, because "what changed" is usually visible and rarely in the JSON.
stamp="$(date +%Y-%m-%d_%H%M)"
cp "$EDITION_DIR/news.json" "$EDITION_DIR/log/$stamp.json"
for f in "$EDITION_DIR/log/proof"/*.png; do
    [ -e "$f" ] && cp "$f" "$EDITION_DIR/log/${stamp}_$(basename "$f")"
done
find "$EDITION_DIR/log" -type f -mtime +7 -delete

echo "filed: $(python3 -c "
import json
d = json.load(open('$EDITION_DIR/news.json'))
s = (d.get('stories') or [{}])[0]
sub = d.get('subject', {})
print(f\"{sub.get('symbol','?')} — {len(d.get('stories',[]))} stories, \"
      f\"{len(d.get('figures',[]))} figures, {len(d.get('briefs',[]))} briefs \"
      f\"— lead: {s.get('headline','(none)')}\")")"

[ "${1:-}" = "--serve" ] && serve
exit 0
