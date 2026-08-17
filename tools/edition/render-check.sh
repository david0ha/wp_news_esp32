#!/usr/bin/env bash
# render-check.sh — typeset a candidate edition and say whether it prints.
#
# The desk that writes news.json cannot see the paper. It writes JSON; twenty
# minutes later a panel on a wall spends twenty-five seconds painting whatever
# that JSON turned into, and if the lead headline was four characters too long
# the reader gets an ellipsis in the middle of a sentence and nobody finds out.
# Validating the SCHEMA does not catch that. Only setting the type catches it.
#
# So this runs the actual typesetter — the same news_core, the same seven faces,
# the same compositor, the same six-ink quantizer the firmware runs — over a
# candidate payload, at the panel's real 1200x1600, and leaves the sheets as
# PNGs. It is the last step before filing, and it is not optional:
#
#     tools/edition/render-check.sh "$EDITION_DIR/news.json.tmp"
#     # -> look at the PNGs it names, THEN rename to news.json
#
# It fails the same things the build fails: a missing glyph, a rule off its row,
# ink outside the margin, a module that rendered nothing, a label wider than its
# slot, a masthead over 1140 px, blue or yellow reaching the glass, or a
# composition that does not tile the well. Anything it lets through will print.
#
# Exit status is the simulator's: 0 means it prints.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"

usage() {
    cat >&2 <<'EOF'
usage: render-check.sh <news.json> [outdir]

  news.json   the candidate payload. Tiles are looked for in <its dir>/tiles/,
              which is where the edition writes them.
  outdir      where the sheets go (default: <news.json's dir>/proof)
EOF
    exit 2
}

[ $# -ge 1 ] || usage
payload="$1"
[ -f "$payload" ] || { echo "render-check: no such payload: $payload" >&2; exit 2; }

payload="$(cd "$(dirname "$payload")" && pwd)/$(basename "$payload")"
paydir="$(dirname "$payload")"
out="${2:-$paydir/proof}"

# Build only when something changed. A desk that runs twice a day should not pay
# for a cold CMake configure, and a desk iterating on copy should not pay for
# anything at all after the first run.
#
# A container has the opposite arrangement: the image built the simulator at
# `docker build` time and then threw the toolchain away, so that a broken build
# fails when the image is built rather than at the first edition of the day, and
# so that the runtime image does not carry a C compiler on a host reachable from
# the internet. There, cmake is absent and the binary is already correct.
if command -v cmake >/dev/null 2>&1; then
    if [ ! -d "$root/sim/build" ]; then
        cmake -S "$root/sim" -B "$root/sim/build" -DCMAKE_BUILD_TYPE=Release >/dev/null
    fi
    cmake --build "$root/sim/build" -j8 >/dev/null
elif [ ! -x "$root/sim/build/sim" ]; then
    echo "render-check: no cmake, and no simulator at $root/sim/build/sim." >&2
    echo "  On a developer machine, install cmake. In a container, the image build" >&2
    echo "  was supposed to leave the binary there — see server/Dockerfile." >&2
    exit 2
fi

mkdir -p "$out"
rm -f "$out"/*.bmp "$out"/*.png

# The exit status is carried past the conversion rather than allowed to end the
# script here. A failing run is exactly the run whose sheets someone wants to
# look at, and `set -e` would throw them away at the moment they became useful.
status=0
"$root/sim/build/sim" "$out" --json "$payload" --tiles "$paydir/tiles" --only-pages \
    || status=$?

if command -v sips >/dev/null 2>&1; then
    for f in "$out"/*.bmp; do
        [ -e "$f" ] || continue
        sips -s format png "$f" --out "${f%.bmp}.png" >/dev/null
        rm -f "$f"
    done
fi

echo
if [ "$status" -eq 0 ]; then
    echo "render-check: PASSES — this payload prints."
else
    echo "render-check: FAILS ($status) — do not file this payload."
fi
echo "sheets:"
for f in "$out"/*.png "$out"/*.bmp; do
    [ -e "$f" ] && echo "  $f"
done

cat <<'EOF'

Now LOOK at them. The checks above are mechanical; they cannot tell you that a
column ran short, that a headline broke on the wrong word, that the page is all
grey because nothing on it is set larger than a deck, or that the photograph is
mush. That judgement is the job.
EOF

exit "$status"
