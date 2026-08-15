#!/usr/bin/env python3
"""
contrast.py — what the six inks can actually do, side by side.

The colour policy in CLAUDE.md and in ui_internal.h rests on a handful of
contrast ratios, and the first version of that policy carried figures computed
from linear luma. Every one of them was wrong: linear luma understates the
contrast of dark inks against a light ground by roughly a factor of two, and it
got the ordering of the middle of the range wrong as well. The conclusions
happened to survive, which is luck and not a method.

So the numbers live in a script rather than in a comment. Run it; do not
transcribe it.

    python3 tools/contrast.py

The ink values are the measured table from tools/make_tile.py, which is
transcribed from paperlesspaper/epdoptimize and is the only one of the two
tables in this tree that claims to come from a real panel. wp_palette.c carries
a second, eyeballed table used only to tint the simulator's previews; its own
comment says the honest fix is one colorimeter reading, after which BOTH should
be replaced. If that ever happens, correct INKS here too — this file is a
consumer of that measurement, not an independent source of it.

WHAT THE OUTPUT SAYS, and it is not what six inks suggests: the panel gives you
TWO value bands and nothing in between. Black, red, blue and green all land
between 0.016 and 0.077 relative luminance; the 1-in-3 screen, yellow and the
paper between 0.374 and 0.554. Inside a band, brightness is worth almost
nothing — blue against green is 1.17:1, the screen against keylined yellow
1.22:1 — so a graphic that needs a third distinguishable series has to find it
in hue or in texture, because there is no third step of value to spend.
"""

INKS = {
    "black":  "#1F2226",
    "white":  "#B9C7C9",
    "red":    "#62201E",
    "yellow": "#C1BB1E",
    "blue":   "#233F8E",
    "green":  "#35563A",
}

# The 1-in-3 black line screen is not an ink, but it is one of the five series
# treatments and its pairings are where the design can fail, so it belongs in
# the table. One row inked in three, averaged in LINEAR light — averaging in
# sRGB would overstate it by about a fifth, which is the same class of mistake
# this file exists to stop.
SCREEN_DUTY = 1.0 / 3.0


def _linear(channel):
    c = channel / 255.0
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def luminance(hexcode):
    """WCAG relative luminance of an #RRGGBB string."""
    r = int(hexcode[1:3], 16)
    g = int(hexcode[3:5], 16)
    b = int(hexcode[5:7], 16)
    return 0.2126 * _linear(r) + 0.7152 * _linear(g) + 0.0722 * _linear(b)


def contrast(la, lb):
    """WCAG contrast ratio between two relative luminances."""
    hi, lo = max(la, lb), min(la, lb)
    return (hi + 0.05) / (lo + 0.05)


def treatments():
    """The five series treatments and the two grounds, dark to light."""
    lum = {name: luminance(h) for name, h in INKS.items()}
    lum["screen"] = SCREEN_DUTY * lum["black"] + (1.0 - SCREEN_DUTY) * lum["white"]
    order = ["black", "red", "blue", "green", "screen", "yellow", "white"]
    return [(n, lum[n]) for n in order]


def main():
    rows = treatments()
    paper = dict(rows)["white"]
    black = dict(rows)["black"]

    print("Relative luminance, and contrast against the two grounds:\n")
    print("  %-8s %-9s %9s %9s %9s" % ("", "hex", "rel.lum", "vs PAPER", "vs BLACK"))
    for name, lum in rows:
        hexcode = INKS.get(name, "1-in-3")
        print("  %-8s %-9s %9.4f %8.2f:1 %8.2f:1"
              % (name, hexcode, lum, contrast(lum, paper), contrast(lum, black)))

    print("\nEvery pair, which is the table that actually decides a chart:\n")
    names = [n for n, _ in rows]
    lums = dict(rows)
    print("  %-8s %s" % ("", " ".join("%8s" % n[:8] for n in names)))
    for a in names:
        cells = []
        for b in names:
            cells.append("       -" if a == b
                         else "%8.2f" % contrast(lums[a], lums[b]))
        print("  %-8s %s" % (a, " ".join(cells)))

    print("\nThe pairs a reader cannot separate by brightness (under 2.0:1):\n")
    seen = set()
    weak = []
    for a in names:
        for b in names:
            if a == b or (b, a) in seen:
                continue
            seen.add((a, b))
            r = contrast(lums[a], lums[b])
            if r < 2.0:
                weak.append((r, a, b))
    for r, a, b in sorted(weak):
        print("  %-8s %-8s %5.2f:1" % (a, b, r))


if __name__ == "__main__":
    main()
