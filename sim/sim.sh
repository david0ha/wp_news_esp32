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

mkdir -p shots
rm -f shots/*.bmp shots/*.png

# The exit status is carried past the conversion rather than allowed to end the
# script here. A failing run is exactly the run whose previews someone wants to
# look at, and `set -e` would throw them away at the moment they became useful.
status=0
./build/sim shots || status=$?

# sips is macOS-only; skip the PNG convenience copies elsewhere. A 1200x1600
# 24-bit BMP is 5.8 MB and a PNG of the same six flat inks is a fraction of it,
# which is the whole reason the conversion is worth doing.
if command -v sips >/dev/null 2>&1; then
  for f in shots/*.bmp; do
    sips -s format png "$f" --out "${f%.bmp}.png" >/dev/null
  done
fi

echo "previews in sim/shots/, in reading order — both pages on a full payload,"
echo "on a one-story payload, and on a day that brought no stories at all; then"
echo "the STALE and OFFLINE badges, the provisioning overlay, and the sheet"
echo "before the first snapshot has landed"
exit $status
