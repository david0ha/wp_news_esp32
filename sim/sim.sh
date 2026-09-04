#!/usr/bin/env bash
# The simulator: build -> typeset every page at 1200x1600 in six inks -> BMP +
# PNG, and assert on the framebuffer that would reach the panel. Exits non-zero
# if any rule, band, slot, glyph or colour check fails.
#
# It is a test, not a preview. The previews it leaves behind are drawn in the
# MEASURED Spectra 6 inks rather than in the saturated ones the UI draws with,
# so sim/shots/*.png can be judged as paper.
#
# Usage:  ./sim.sh                                          # the built-in demo snapshot
#         NEWS_URL=http://localhost:8123/news.json ./sim.sh # the device's own fetch path
set -e
cd "$(dirname "$0")"

[ -d build ] || cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build -j8

mkdir -p shots shots/ko
rm -f shots/*.bmp shots/*.png shots/ko/*.bmp shots/ko/*.png

# The exit status is carried past the conversion rather than allowed to end the
# script here. A failing run is exactly the run whose previews someone wants to
# look at, and `set -e` would throw them away at the moment they became useful.
status=0
./build/sim shots || status=$?

# THE SAME TYPESETTER, ON A KOREAN EDITION. Two runs and not one, because a
# language is the one thing a payload can change that the demo snapshot can
# never exercise: the demo is English by definition — an unconfigured board has
# no edition and therefore no language — so without this run the six Korean
# faces, the fallback chain behind the six Latin ones and the twelve localised
# fixed strings are all compiled in and never drawn.
#
# It is the committed fixture and not a fetch, so it asserts the same thing on
# every machine. --only-pages because A1 and A2 are what a language changes; the
# ink specimen, the overlay and the no-data sheet are the board talking about
# itself and stay English whatever the edition is.
./build/sim shots/ko --json ../components/news_core/test/host/fixtures/news.ko.json \
    --tiles tiles --only-pages || status=$?

# sips is macOS-only; skip the PNG convenience copies elsewhere. A 1200x1600
# 24-bit BMP is 5.8 MB and a PNG of the same six flat inks is a fraction of it,
# which is the whole reason the conversion is worth doing.
if command -v sips >/dev/null 2>&1; then
  for f in shots/*.bmp shots/ko/*.bmp; do
    [ -e "$f" ] || continue
    sips -s format png "$f" --out "${f%.bmp}.png" >/dev/null
  done
fi

echo "previews in sim/shots/, in reading order — the ink specimen first, then"
echo "both pages on a full payload, on a slow day, on a day whose copy all came"
echo "in short, and on a day that brought no stories at all; then the STALE and"
echo "OFFLINE badges, the provisioning overlay, and the sheet before the first"
echo "snapshot has landed. sim/shots/ko/ is the same A1 and A2 on a Korean"
echo "edition: Hangul copy, Korean badges and column heads, English nameplate"
exit $status
