#!/usr/bin/env python3
"""
Regenerate the newspaper faces in components/news_core/fonts/.

Usage
-----
    python3 -m venv /tmp/fontenv && /tmp/fontenv/bin/pip install fonttools
    /tmp/fontenv/bin/python tools/gen_fonts.py --download

    tools/gen_fonts.py --dry-run          # report the glyph sets and stop

Needs node/npx (it shells out to lv_font_conv) and fontTools (Google ships
these families as variable fonts; see below). The generated .c files are
committed, so a normal build never runs this.


Why fontTools is needed
-----------------------
Three of the four families exist on Google Fonts only as variable fonts, and
lv_font_conv's parser (opentype.js) reads a variable font's *default* instance
and nothing else. Asking it for Playfair Display Bold would silently produce
Playfair Display Regular. So each face is instanced to a fixed point on its
axes here first, with fontTools, and lv_font_conv only ever sees a static TTF.

That is not just a workaround. Source Serif 4 carries an optical-size axis, and
this panel has a known physical pixel size, so the right `opsz` for each face is
a calculation rather than a taste call — see PANEL_DPI below. The 16 px body
face is instanced at opsz 8, which is a genuinely different drawing: sturdier
stems, more open counters, exactly what survives a 1-bit render.


Why 1 bpp, everywhere
---------------------
The panel has no grey. LVGL renders anti-aliased text as intermediate RGB565
values and main.cpp's flush callback puts those through wp_quantize565(), which
ordered-dithers them to the six inks. For a photograph that is correct and
necessary. For text it is destructive: a 16 px serif stem is about 1.5 px wide,
so half of it is anti-aliasing, and dithering that half turns a solid stem into
a dotted one. Rendered side by side at 3x, 4 bpp body text has visible holes
punched through 'm', 'w' and every descender, and the 112 px masthead grows a
ragged stipple along contours that 1 bpp keeps smooth.

1 bpp also means every text pixel is exactly WP_RGB_BLACK or WP_RGB_WHITE, and
wp_quantize() maps both to themselves under any dither offset — so text takes
the quantizer's identity path and cannot pick up a colour fringe.

The saving is incidental but large: all seven faces together cost less than one
of the two 완성형 Korean faces this board replaced.
"""

import argparse
import os
import re
import subprocess
import sys
import tempfile
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CORE = os.path.join(ROOT, "components", "news_core")
FONTDIR = os.path.join(CORE, "fonts")
STRINGS_H = os.path.join(CORE, "include", "ui_strings.h")

# 1600 x 1200 across a 13.3" diagonal: sqrt(1600^2 + 1200^2) / 13.3.
PANEL_DPI = 150.4


# --- sources ---------------------------------------------------------------
#
# All four families are SIL Open Font License 1.1, so the generated bitmaps are
# redistributable with this repo. The four were chosen against the paper being
# imitated rather than by taste:
#
#   masthead   blackletter               <- UnifrakturMaguntia
#   headlines  a Didone (WP uses Postoni) <- Playfair Display
#   body/deck  a text serif               <- Source Serif 4
#   labels     Franklin Gothic            <- Libre Franklin, which is a revival
#                                            of exactly that face
GF = "https://github.com/google/fonts/raw/main/ofl/"
FAMILIES = {
    "unifraktur": (GF + "unifrakturmaguntia/UnifrakturMaguntia-Book.ttf",
                   GF + "unifrakturmaguntia/OFL.txt"),
    "playfair":   (GF + "playfairdisplay/PlayfairDisplay%5Bwght%5D.ttf",
                   GF + "playfairdisplay/OFL.txt"),
    "ss4":        (GF + "sourceserif4/SourceSerif4%5Bopsz,wght%5D.ttf",
                   GF + "sourceserif4/OFL.txt"),
    "ss4i":       (GF + "sourceserif4/SourceSerif4-Italic%5Bopsz,wght%5D.ttf",
                   GF + "sourceserif4/OFL.txt"),
    "franklin":   (GF + "librefranklin/LibreFranklin%5Bwght%5D.ttf",
                   GF + "librefranklin/OFL.txt"),
}


def opsz_for(px):
    """Source Serif 4's optical-size axis, in points, for a pixel size here.

    The axis is calibrated in points at reading distance and this panel's pixel
    pitch is known, so this is arithmetic, not preference. Clamped to the axis's
    own 8..60 range: 14 px is 6.7 pt, below anything the family draws.
    """
    return min(60, max(8, round(px * 72.0 / PANEL_DPI)))


# name -> (family, size px, variable-font location, what it must cover)
FACES = [
    ("ui_font_masthead_112", "unifraktur", 112, None,                              "masthead"),
    ("ui_font_display_56",   "playfair",    56, {"wght": 800},                     "text"),
    ("ui_font_display_36",   "playfair",    36, {"wght": 700},                     "text"),
    ("ui_font_deck_24",      "ss4i",        24, {"wght": 400, "opsz": opsz_for(24)}, "text"),
    ("ui_font_body_20",      "ss4",         20, {"wght": 400, "opsz": opsz_for(20)}, "text"),
    ("ui_font_body_16",      "ss4",         16, {"wght": 400, "opsz": opsz_for(16)}, "text"),
    ("ui_font_label_14",     "franklin",    14, {"wght": 600},                     "text"),
]


# --- glyph sets ------------------------------------------------------------

def strings_h():
    """ui_strings.h with its comments stripped.

    The comments explain the file in prose containing the very typography the
    literals are being scanned for, so they must go before the scan — otherwise
    every character used to *describe* the font ends up *in* the font.
    """
    with open(STRINGS_H, encoding="utf-8") as f:
        src = f.read()
    src = re.sub(r"/\*.*?\*/", "", src, flags=re.S)
    return re.sub(r"//[^\n]*", "", src)


def literal_chars(src, only=None):
    """Every character inside a string literal in `src`.

    `only` restricts the scan to one #define, which is how the masthead face
    learns what S_MASTHEAD contains without pulling in the rest of the UI.
    """
    if only is not None:
        m = re.search(r"#define\s+" + only + r"\b(.*?)(?=\n#define|\Z)", src, re.S)
        src = m.group(1) if m else ""
    chars = set()
    for lit in re.findall(r'"((?:[^"\\]|\\.)*)"', src):
        lit = (lit.replace("\\n", "\n").replace("\\t", "\t")
                  .replace('\\"', '"').replace("\\\\", "\\"))
        chars |= {c for c in lit if c.isprintable()}
    return chars


def symbol_sets():
    src = strings_h()

    # Text faces: ASCII, all of Latin-1 (accented names in bylines and
    # datelines are routine, and there is no way to subset a headline that has
    # not arrived yet), every fixed label, and the curated typography.
    text = {chr(c) for c in range(0x20, 0x7F)}
    text |= {chr(c) for c in range(0xA0, 0x100)}
    text.discard("­")     # soft hyphen: a line-break hint, not a glyph.
                               # Most faces have no outline for it, and asking
                               # for it makes the "not in the font" report —
                               # which is there to catch real gaps — cry wolf.
    text |= literal_chars(src)

    # Masthead: the letters of S_MASTHEAD, plus the whole Latin alphabet and the
    # punctuation a paper's name plausibly uses, so that editing S_MASTHEAD is a
    # one-line change and not a one-line change plus a font regeneration. The
    # failure this buys off is tofu across the largest text on the screen.
    masthead = set("ABCDEFGHIJKLMNOPQRSTUVWXYZ")
    masthead |= set("abcdefghijklmnopqrstuvwxyz")
    masthead |= set(" .,'-&")
    masthead |= literal_chars(src, only="S_MASTHEAD")

    for s in (text, masthead):
        s.discard("\n")
        s.discard("\t")
    return {"text": text, "masthead": masthead}


# --- conversion ------------------------------------------------------------

def instance(src_ttf, location, out_ttf):
    """Pin a variable font to one point on its axes."""
    from fontTools import ttLib
    from fontTools.varLib import instancer

    font = ttLib.TTFont(src_ttf)
    if location:
        if "fvar" not in font:
            sys.exit(f"{os.path.basename(src_ttf)} is not a variable font, "
                     f"but the face table asks for {location}")
        instancer.instantiateVariableFont(font, location, inplace=True,
                                          updateFontNames=True)
    font.save(out_ttf)
    return out_ttf


def supported(ttf, chars):
    """Split `chars` into what the font actually has and what it does not.

    lv_font_conv fails the whole face on the first character a font cannot
    draw, which for a blackletter asked to cover Latin-1 is most of them. The
    dropped set is printed rather than swallowed: a character missing from a
    text face is a tofu box waiting to happen and the operator should see it.
    """
    from fontTools import ttLib

    cmap = set()
    for table in ttLib.TTFont(ttf)["cmap"].tables:
        cmap |= set(table.cmap.keys())
    have = {c for c in chars if ord(c) in cmap}
    return have, chars - have


def run_conv(ttf, name, size, chars, provenance):
    out = os.path.join(FONTDIR, name + ".c")
    cmd = [
        "npx", "-y", "lv_font_conv@latest",
        "--font", ttf,
        "--size", str(size),
        "--bpp", "1",                       # see the module docstring
        "--format", "lvgl",
        "--symbols", "".join(sorted(chars)),
        "--no-compress",
        "--lv-font-name", name,
        "-o", out,
    ]
    subprocess.run(cmd, check=True, cwd=ROOT)
    normalize_header(out, ttf, provenance)
    return out


def normalize_header(path, ttf, provenance):
    """Take the machine's temp paths back out of the generated file.

    lv_font_conv records its own argv in a comment at the top, and two of those
    arguments are absolute paths: the instanced TTF in a mkdtemp directory, and
    the output file. Left alone they make every regeneration produce a diff in
    all seven faces with nothing in it but a changed random directory name, and
    they publish the generating machine's home directory into a committed file.

    Substituted rather than deleted, because the rest of that line — the exact
    symbol list, the bpp, the size — is the only record of how the file was
    produced, and it should keep being readable.
    """
    with open(path, encoding="utf-8") as f:
        src = f.read()
    src = src.replace("--font " + ttf, "--font " + provenance)
    src = src.replace("-o " + path, "-o " + os.path.relpath(path, ROOT))
    with open(path, "w", encoding="utf-8") as f:
        f.write(src)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--download", action="store_true",
                    help="fetch the four families into a temp dir")
    ap.add_argument("--font-dir",
                    help="use already-downloaded originals from this directory "
                         "instead (files named as on Google Fonts)")
    ap.add_argument("--dry-run", action="store_true",
                    help="report the glyph sets and the face table, then stop")
    args = ap.parse_args()

    sets = symbol_sets()

    if args.dry_run:
        for kind, chars in sorted(sets.items()):
            extra = sorted(c for c in chars if ord(c) > 0x7E)
            print(f"{kind}: {len(chars)} glyphs "
                  f"({len(chars) - len(extra)} ASCII + {len(extra)} beyond)")
            print("   ", "".join(extra) or "(none)")
        print()
        for name, fam, size, loc, kind in FACES:
            print(f"  {name:22s} {fam:11s} {size:4d}px  bpp1  "
                  f"{str(loc or 'static'):28s} {kind} ({len(sets[kind])} glyphs)")
        return

    if not args.download and not args.font_dir:
        sys.exit("give --download or --font-dir")

    try:
        import fontTools  # noqa: F401
    except ImportError:
        sys.exit("fontTools is required (Google ships these as variable fonts):\n"
                 "    python3 -m venv /tmp/fontenv\n"
                 "    /tmp/fontenv/bin/pip install fonttools\n"
                 "    /tmp/fontenv/bin/python tools/gen_fonts.py --download")

    tmp = tempfile.mkdtemp(prefix="gen_fonts_")
    os.makedirs(FONTDIR, exist_ok=True)

    originals = {}
    for fam, (font_url, ofl_url) in FAMILIES.items():
        base = urllib.parse.unquote(os.path.basename(font_url))
        if args.font_dir:
            originals[fam] = os.path.join(args.font_dir, base)
            if not os.path.exists(originals[fam]):
                sys.exit(f"missing {originals[fam]}")
        else:
            originals[fam] = os.path.join(tmp, base)
            print(f"downloading {base}")
            urllib.request.urlretrieve(font_url, originals[fam])
            # One OFL per *family directory*, not per face: Source Serif's
            # upright and italic are two files under one licence, and keying
            # this on the family name would commit that text twice.
            ofl = os.path.join(FONTDIR,
                               "OFL-%s.txt" % ofl_url.rsplit("/", 2)[-2])
            if not os.path.exists(ofl):
                urllib.request.urlretrieve(ofl_url, ofl)

    total = 0
    for name, fam, size, loc, kind in FACES:
        static = instance(originals[fam], loc,
                          os.path.join(tmp, f"{name}.ttf"))
        # What goes into the generated file's provenance comment in place of
        # the mkdtemp path: the family as published plus the axis point it was
        # pinned to, which together are what actually reproduce this face.
        provenance = urllib.parse.unquote(os.path.basename(FAMILIES[fam][0]))
        if loc:
            provenance += "@" + ",".join(f"{k}={v}" for k, v in sorted(loc.items()))
        have, missing = supported(static, sets[kind])
        if missing:
            print(f"  {name}: {len(missing)} character(s) not in the font, "
                  f"dropped: {''.join(sorted(missing))}")
        print(f"  {name}: {len(have)} glyphs @ {size}px "
              f"{loc or ''} ...", flush=True)
        path = run_conv(static, name, size, have, provenance)
        total += os.path.getsize(path)
        print(f"    -> {os.path.getsize(path) // 1024} KiB of C source")

    print(f"generated {len(FACES)} faces, {total // 1024} KiB of C source")


if __name__ == "__main__":
    main()
