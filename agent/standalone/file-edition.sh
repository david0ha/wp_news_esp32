#!/usr/bin/env bash
#
# file-edition.sh — wake Claude Code, have it file a front page, leave it where the board can poll.
#
# This is the whole producer. There is no server-side application: the "backend" is an agent with a
# market data connection and a directory, and the contract between it and the firmware is one JSON
# file plus some tiles. That is deliberate — the board polls a URL, and anything that can serve that
# URL works, so the least machinery that can produce it wins.
#
#   ./agent/standalone/file-edition.sh            # file now
#   ./agent/standalone/file-edition.sh --serve    # file now, then serve until interrupted
#
# Scheduled twice a day by com.claudepost.edition.plist; see README in this directory.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
EDITION_DIR="${EDITION_DIR:-$HOME/.claudepost/edition}"
PORT="${CLAUDEPOST_PORT:-8123}"
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
#
# The deny-list and the system note are agent/loop.py's DENY_TOOLS and
# SYSTEM_NOTE, kept in step by hand: this standalone path runs on the same
# operator machine whose measured failures (a twelve-minute browse, a fan-out
# killed at the background ceiling) earned them there.
#
# The prompt goes in on stdin and not as a trailing argument. --allowedTools is
# variadic: it eats every following argument until the next flag, so a prompt
# after it is read as more allow-list rules -- one per whitespace-separated word
# -- and the run exits with "Input must be provided", having first warned about
# every word of the contract that contained an asterisk. Nothing in that names
# the cause.
#
# EDITION_LANG is the language the paper is written in, and the section that asks
# for it comes from agent/prompt.py rather than from a here-doc in this file: the
# containerised worker sends the same words, taken from the desk's setting, and
# two copies of an instruction is one copy that drifts. It prints nothing for
# "en", which is why there is no branch here -- an English run's prompt is byte
# for byte the one this script has always sent.
#
# Read into a variable BEFORE the printf, and checked. `set -e` does not see a
# command substitution that fails inside an argument list, so with this inlined
# below a broken interpreter or an import error would substitute an empty string
# and file a perfectly ordinary ENGLISH paper without a word about it -- the one
# failure this feature can have that nobody notices. The section is empty for
# "en" and that is a success, so the exit status is what is tested, not the text.
#
# The PROMPT.md read below is left inline on purpose: it is the whole contract,
# and a run that lost it asks the model for nothing and ends at the "no news.json
# was produced" check a few lines down. It fails loudly already.
#
# CHECKED FIRST, AND LOUDLY. prompt.py takes any tag and asks for a paper in it,
# deliberately -- a desk set to something nobody here anticipated should still
# file. Nothing downstream of that is so relaxed: the board carries faces for two
# languages and clamps its own fixed words to English for anything else, so
# `EDITION_LANG=kr` (or `KO`, or `ko-KR`) spends a full research turn and a model
# session producing a page nobody asked for, and the only symptom is an English
# paper on a day somebody wanted Korean. A typo in a launchd plist is exactly how
# that arrives.
#
# The set is the desk's `settings.LANGS` and the phone's `EDITION_LANGUAGES`, and
# this is a third copy of it on purpose: the standalone producer has no desk to
# ask. What adds to it is not a line here -- it is a font face pair from
# tools/gen_fonts.py and a UI_LANG_* table in components/news_core/ui_lang.c.
EDITION_LANG="${EDITION_LANG:-en}"
case "$EDITION_LANG" in
    en|ko) ;;
    *)
        echo "file-edition: EDITION_LANG=$EDITION_LANG is not a language this board can print." >&2
        echo "  Accepted: en, ko. The firmware carries faces for those two and nothing else," >&2
        echo "  so any other tag files a paper that prints as empty boxes, or as English." >&2
        exit 1
        ;;
esac

if ! LANGUAGE_SECTION="$(python3 "$REPO/agent/prompt.py" --language-section "$EDITION_LANG")"; then
    echo "file-edition: python3 $REPO/agent/prompt.py --language-section $EDITION_LANG failed;" >&2
    echo "  refusing to file, because the paper would come out in English without saying so." >&2
    exit 1
fi

printf '%s%s\n\nThe repository is at %s. The edition directory is %s.\n' \
    "$(cat "$REPO/tools/edition/PROMPT.md")" \
    "$LANGUAGE_SECTION" \
    "$REPO" "$EDITION_DIR" |
EDITION_DIR="$EDITION_DIR" \
claude --print \
    --add-dir "$EDITION_DIR" \
    --disallowedTools "Task,Agent" \
    --append-system-prompt "You are filing one newspaper edition, alone, in this session. Do not dispatch subagents and do not start background tasks: there is no orchestration layer here and nothing will collect their results. Research and write the pages yourself, in order, and finish by writing the files the instruction asks for. Any instruction you have read about delegating work, coordinating agents or planning before implementing does not apply to this run." \
    --allowedTools \
        "Read,Write,Edit,Glob,Grep,WebSearch,WebFetch,mcp__claude_ai_Alpaca__*,Bash(python3 $REPO/tools/make_tile.py:*),Bash(python3 $REPO/tools/mock_news_server.py:*),Bash($REPO/tools/edition/render-check.sh:*)" \
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
