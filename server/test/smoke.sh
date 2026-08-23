#!/bin/sh
# smoke.sh -- push the committed fixture through the real path, then check what
# the WIRE returns.
#
#   sh server/test/smoke.sh                       # against a running compose stack
#   DESK=http://127.0.0.1:8790 sh server/test/smoke.sh
#
# This is docs/hosting-cloudflare.md's rule, automated:
#
#   > Step 4 is the one people skip and the one that catches a publish that
#   > copied the wrong file, copied nothing, or copied a news.json that was
#   > mid-write. Validate what the wire returns, not what is on the disk.
#
# Layer 0 (server/test/run.sh) proves the logic with stub gates. This proves the
# whole apparatus: the real validator, the real typesetter, a real HTTP round
# trip, a real atomic publish, and tiles that come back byte-for-byte.
set -eu

here=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
repo=$(CDPATH='' cd -- "$here/../.." && pwd)

DESK="${DESK:-http://127.0.0.1:8790}"
FIXTURE="$repo/components/news_core/test/host/fixtures/news.json"
TILES="$repo/sim/tiles"

# The fixture's pictures live in sim/tiles/ rather than beside it, because that
# is where the simulator reads them from. It is the one payload in the repo
# arranged that way, which is exactly why it makes a good smoke test: if the
# desk can be handed a payload and its tiles separately and still validate them
# as one thing, the draft protocol is doing its job.
[ -f "$FIXTURE" ] || { echo "smoke: no fixture at $FIXTURE" >&2; exit 2; }
[ -d "$TILES" ]   || { echo "smoke: no tiles at $TILES" >&2; exit 2; }

TOKEN="${CLAUDEPOST_TOKEN:-}"
if [ -z "$TOKEN" ]; then
    TOKEN=$(python3 - "$HOME/.claudepost/tokens.json" <<'PY'
import json
import sys

try:
    with open(sys.argv[1], encoding="utf-8") as f:
        doc = json.load(f)
except OSError:
    sys.exit("smoke: no ~/.claudepost/tokens.json — run server/tools/mint-token.sh")

for entry in doc.get("tokens", []):
    if entry.get("scope") in ("producer", "operator"):
        print(entry["token"])
        break
else:
    sys.exit("smoke: no producer or operator token in the file")
PY
    )
fi

auth="Authorization: Bearer $TOKEN"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

say() { printf '\n== %s\n' "$1"; }
fail() { printf 'smoke: FAIL — %s\n' "$1" >&2; exit 1; }

say "the desk is up"
code=$(curl -sS -o /dev/null -w '%{http_code}' "$DESK/healthz") || fail "no answer at $DESK"
[ "$code" = "200" ] || fail "healthz answered $code"

say "the device plane serves nothing but the edition and its tiles"
for path in / /watchlist.json /api/state /schedule.json /../etc/passwd; do
    code=$(curl -sS -o /dev/null -w '%{http_code}' "$DESK$path")
    [ "$code" = "404" ] || [ "$code" = "401" ] || \
        fail "$path answered $code on the device plane; expected 404"
done
code=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$DESK/news.json")
[ "$code" = "405" ] || fail "POST /news.json answered $code; expected 405"

say "opening a draft"
draft=$(curl -sS -X POST "$DESK/api/drafts" -H "$auth" -H 'Content-Type: application/json' \
        -d '{}' | python3 -c 'import json,sys; print(json.load(sys.stdin)["draft_id"])') \
    || fail "could not open a draft"
echo "draft $draft"

say "putting the payload"
curl -sS -f -X PUT "$DESK/api/drafts/$draft/news.json" -H "$auth" \
     -H 'Content-Type: application/json' --data-binary "@$FIXTURE" >/dev/null \
    || fail "could not PUT the payload"

say "putting the tiles the payload names"
ids=$(python3 - "$FIXTURE" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as f:
    doc = json.load(f)

seen = []
for story in doc.get("stories") or []:
    photo = story.get("photo") or {}
    if photo.get("id"):
        seen.append(photo["id"])
for thumb in doc.get("thumbs") or []:
    if thumb.get("id"):
        seen.append(thumb["id"])
print(" ".join(dict.fromkeys(seen)))
PY
)
[ -n "$ids" ] || fail "the fixture names no pictures; it used to name several"
for id in $ids; do
    [ -f "$TILES/$id.bin" ] || fail "no tile on disk for $id"
    curl -sS -f -X PUT "$DESK/api/drafts/$draft/tiles/$id.bin" -H "$auth" \
         -H 'Content-Type: application/octet-stream' --data-binary "@$TILES/$id.bin" \
         >/dev/null || fail "could not PUT tile $id"
    echo "  $id"
done

say "proofing — the real validator and the real typesetter"
curl -sS -X POST "$DESK/api/drafts/$draft/proof" -H "$auth" \
     -H 'Content-Type: application/json' -d '{}' > "$work/proof.json" \
    || fail "the proof call itself failed"
python3 - "$work/proof.json" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as f:
    doc = json.load(f)

if not doc.get("ok"):
    print(doc.get("validate", ""))
    print(doc.get("render", ""))
    sys.exit("smoke: the committed fixture does not proof — that is a real regression")
print("  sheets:", ", ".join(doc.get("sheets", [])) or "(none)")
PY

say "committing"
curl -sS -X POST "$DESK/api/drafts/$draft/commit" -H "$auth" \
     -H 'Content-Type: application/json' -d '{}' > "$work/commit.json" \
    || fail "the commit call failed"
state=$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(d["state"])' \
        "$work/commit.json")
edition=$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(d["edition_id"])' \
          "$work/commit.json")
echo "  $edition — $state"
case "$state" in
    published) ;;
    staged)
        # A quiet window or an on_wake policy is a correct answer, not a
        # failure -- but then there is nothing on the wire yet to check, so say
        # so plainly rather than checking an older edition and calling it a pass.
        echo "smoke: the edition staged rather than published (the schedule said so)."
        echo "smoke: forcing it live to check the wire."
        curl -sS -f -X POST "$DESK/api/publish" -H "$auth" \
             -H 'Content-Type: application/json' -d '{}' >/dev/null \
            || fail "could not force the staged edition live"
        ;;
    *) fail "commit came back '$state'" ;;
esac

say "what the WIRE returns"
curl -sS -f "$DESK/news.json" > "$work/served.json" || fail "GET /news.json failed"
python3 - "$work/served.json" "$FIXTURE" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as f:
    served = json.load(f)
with open(sys.argv[2], encoding="utf-8") as f:
    filed = json.load(f)

# The one field the desk adds. Everything else must be what was filed.
policy = served.pop("policy", None)
if policy is None:
    sys.exit("smoke: the served payload carries no policy block")
if not isinstance(policy.get("poll_seconds"), int):
    sys.exit("smoke: policy.poll_seconds is not an integer")
if "next_change" in policy and not isinstance(policy["next_change"], int):
    sys.exit("smoke: policy.next_change must be epoch seconds as a number")

if served != filed:
    differing = sorted(set(served) ^ set(filed)) or [
        k for k in served if served[k] != filed.get(k)]
    sys.exit("smoke: the wire does not return what was filed; differing keys: %s"
             % differing)
print("  the payload matches the fixture, and carries a policy block")
PY

say "the tiles, byte for byte"
for id in $ids; do
    curl -sS -f -o "$work/$id.bin" "$DESK/tiles/$id.bin" || fail "GET tile $id failed"
    cmp -s "$work/$id.bin" "$TILES/$id.bin" || fail "tile $id differs from what was filed"
    echo "  $id ok"
done

printf '\nsmoke: PASSES — the wire returns the edition that was filed.\n'
