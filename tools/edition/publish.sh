#!/bin/sh
# publish.sh — put the current edition on Cloudflare.
#
# The counterpart to `file-edition.sh --serve`, which answers the board's URL
# from this machine over the LAN. This answers it from Cloudflare instead. The
# board cannot tell the difference and needs no rebuild either way; see
# docs/hosting-cloudflare.md.
#
#   ./tools/edition/publish.sh              # validate, assemble, deploy
#   ./tools/edition/publish.sh --dry-run    # validate and assemble, do not deploy
#   EDITION_DIR=/tmp/try ./tools/edition/publish.sh
#
# Credentials: interactively, `npx wrangler login` once is enough. Under launchd
# there is no browser and no keychain prompt, so put a token in
# ~/.wpnews/cloudflare.env (chmod 600) and this picks it up:
#
#   CLOUDFLARE_API_TOKEN=...
#   CLOUDFLARE_ACCOUNT_ID=...
#
set -eu

HERE=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
REPO=$(CDPATH='' cd -- "$HERE/../.." && pwd)

EDITION_DIR="${EDITION_DIR:-$HOME/.wpnews/edition}"
PUBLIC_DIR="$HERE/public"

DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

if [ ! -f "$EDITION_DIR/news.json" ]; then
    echo "publish: no edition at $EDITION_DIR/news.json" >&2
    echo "publish: file one first — ./tools/edition/file-edition.sh" >&2
    exit 1
fi

# --- the gates ------------------------------------------------------------
#
# The same two file-edition.sh runs, run again here, because publishing is the
# irreversible half: a payload that fails these puts a broken page on a public
# URL and leaves it there until the next filing. They fail different things and
# the cheap one gives the better message, so both run and in this order.
#
# This is also the reason the assembly below happens AFTER them. A publish
# directory built from a payload that has not passed is a publish directory
# somebody eventually deploys by hand.
echo "publish: validating $EDITION_DIR/news.json"
python3 "$REPO/tools/mock_news_server.py" --validate "$EDITION_DIR/news.json"

echo "publish: setting the type"
"$REPO/tools/edition/render-check.sh" "$EDITION_DIR/news.json"

# --- assembling what goes public -----------------------------------------
#
# $EDITION_DIR is NOT publishable. Beside the edition it holds watchlist.json,
# which names the symbols the owner follows, and log/, which holds a week of the
# desk's own transcripts. On a LAN that was a considered posture; on a public
# URL it is a disclosure.
#
# So the publish directory is the allowlist, and it is rebuilt from empty every
# time rather than synced — a tile that left the payload has to leave the site
# in the same motion, or the board goes on fetching a picture nothing names.
echo "publish: assembling $PUBLIC_DIR"
rm -rf "$PUBLIC_DIR"
mkdir -p "$PUBLIC_DIR/tiles"
cp "$EDITION_DIR/news.json" "$PUBLIC_DIR/news.json"

tiles=0
if [ -d "$EDITION_DIR/tiles" ]; then
    for t in "$EDITION_DIR"/tiles/*.bin; do
        [ -e "$t" ] || break          # the glob itself when the directory is empty
        cp "$t" "$PUBLIC_DIR/tiles/"
        tiles=$((tiles + 1))
    done
fi
echo "publish: news.json + $tiles tile(s)"

# A page with no pictures is legal — the modules reflow — but it is almost never
# what was meant, and --validate has already held every tile the payload NAMES
# to its byte count. Zero here means the payload named none.
[ "$tiles" -gt 0 ] || echo "publish: warning — no tiles; the payload names no pictures" >&2

if [ "$DRY_RUN" = 1 ]; then
    echo "publish: --dry-run, not deploying"
    exit 0
fi

# --- deploying ------------------------------------------------------------
if [ -f "$HOME/.wpnews/cloudflare.env" ]; then
    # shellcheck disable=SC1091
    . "$HOME/.wpnews/cloudflare.env"
    export CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID
fi

# Pinned to the major so a wrangler release cannot change what a scheduled
# 06:00 publish does without anyone choosing it.
cd "$HERE"
exec npx --yes wrangler@4 deploy
