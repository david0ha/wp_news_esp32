#!/usr/bin/env python3
"""
Regenerate the newspaper faces in components/news_core/fonts/.

Usage
-----
    python3 -m venv /tmp/fontenv && /tmp/fontenv/bin/pip install fonttools
    /tmp/fontenv/bin/python tools/gen_fonts.py --download

    tools/gen_fonts.py --dry-run          # report the glyph sets and stop
    tools/gen_fonts.py --link-fallbacks   # re-point the Latin faces at the
                                          # Korean ones, without regenerating

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

The saving is incidental but large, and it is what makes the Korean faces
affordable: the seven Latin faces together cost less than a tenth of the six
Korean ones behind them.


Why there is a Korean face behind every Latin one
-------------------------------------------------
An edition carries a `lang`, and for "ko" the copy is Hangul while the tickers,
the figures and half the company names in it stay Latin. LVGL resolves
`lv_font_t.fallback` recursively and per character, so pointing each Latin text
face at a Korean face of the same pixel size gets Hangul drawn with NO change at
any call site, and leaves "$", "Nvidia" and every digit in Playfair and Source
Serif rather than in the CJK family's own Latin.

That pointer lives in a `const lv_font_t` in flash and cannot be patched at
runtime, so it is generated INTO the .c: `run_conv()` writes it as each Latin
face is produced, and `--link-fallbacks` re-applies it over the committed files
without regenerating ten megabytes to change six lines. The pass is idempotent.

The Korean faces carry no ASCII and no Latin-1. The primary face owns those, and
duplicating them would be both wasted flash and a way for a "1" to come out in
the wrong family. What they carry is in tools/hangul.py, shared with the
validator so the desk cannot file a syllable the board cannot draw.

The masthead face is deliberately not in this arrangement. It is a blackletter
nameplate, no Korean blackletter exists, and the paper's name is its brand
rather than copy.
"""

import argparse
import os
import re
import subprocess
import sys
import tempfile
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import hangul  # noqa: E402  — the Hangul set, shared with the desk's validator

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

# The Korean half, also SIL Open Font License 1.1. These are STATIC OTFs — the
# variable Noto CJK is a 20 MB multi-language file and the SubsetOTF/KR builds
# are the same outlines already cut down to Korean — so no instancing is needed
# and their `location` is None.
#
# Serif behind the serif faces and sans behind the label face, matched to what
# stands in front: Noto Serif KR Bold under Playfair at 800/700, Regular under
# Source Serif, and Noto Sans KR Medium under Libre Franklin at 600. A CJK
# family's "Medium" is about a Latin family's semibold, which is what the label
# face is set at.
NOTO_CJK = "https://github.com/notofonts/noto-cjk/raw/main/"
FAMILIES.update({
    "notoserifkr_r": (NOTO_CJK + "Serif/SubsetOTF/KR/NotoSerifKR-Regular.otf",
                      NOTO_CJK + "Serif/LICENSE"),
    "notoserifkr_b": (NOTO_CJK + "Serif/SubsetOTF/KR/NotoSerifKR-Bold.otf",
                      NOTO_CJK + "Serif/LICENSE"),
    "notosanskr_m":  (NOTO_CJK + "Sans/SubsetOTF/KR/NotoSansKR-Medium.otf",
                      NOTO_CJK + "Sans/LICENSE"),
})


def ofl_name(ofl_url):
    """What a licence URL is committed as, under fonts/.

    One file per *family directory* rather than per face: Source Serif's upright
    and italic are two files under one licence, and keying this on the family
    name would commit that text twice.

    Noto CJK is the exception the rule could not express. Its licence sits at
    Serif/LICENSE and Sans/LICENSE — two paths, one text, and a parent directory
    called "main" — so the directory rule would produce OFL-Serif.txt and
    OFL-Sans.txt and say nothing about whose fonts they cover. It is keyed by
    hand instead, and lands once as OFL-noto-cjk.txt.
    """
    if ofl_url.startswith(NOTO_CJK):
        return "OFL-noto-cjk.txt"
    return "OFL-%s.txt" % ofl_url.rsplit("/", 2)[-2]


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

# The Korean faces, one per text face, at the same pixel size so their ink sits
# on the primary face's baseline — LVGL takes line height and baseline from the
# PRIMARY font, so a fallback at a different size would draw off the line and no
# layout arithmetic anywhere would know.
#
# (name, family, size px, variable-font location, what it must cover,
#  the Latin face it stands behind)
KO_FACES = [
    ("ui_font_ko_display_56", "notoserifkr_b", 56, None, "hangul", "ui_font_display_56"),
    ("ui_font_ko_display_36", "notoserifkr_b", 36, None, "hangul", "ui_font_display_36"),
    ("ui_font_ko_deck_24",    "notoserifkr_r", 24, None, "hangul", "ui_font_deck_24"),
    ("ui_font_ko_body_20",    "notoserifkr_r", 20, None, "hangul", "ui_font_body_20"),
    ("ui_font_ko_body_16",    "notoserifkr_r", 16, None, "hangul", "ui_font_body_16"),
    ("ui_font_ko_label_14",   "notosanskr_m",  14, None, "hangul", "ui_font_label_14"),
]

# Latin face -> the Korean face its `.fallback` points at.
FALLBACK = {latin: ko for ko, _fam, _px, _loc, _kind, latin in KO_FACES}

# Everything --only can name, and everything --download fetches by default.
ALL_FACES = FACES + [f[:5] for f in KO_FACES]


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
    # U+3000 and up is the Korean faces' half of ui_strings.h and no Latin
    # family has an outline for any of it, so asking for it here would make the
    # same report cry wolf thirty-five times over and bury a real gap in it.
    text |= {c for c in literal_chars(src) if ord(c) < 0x3000}

    # Masthead: the letters of S_MASTHEAD, plus the whole Latin alphabet and the
    # punctuation a paper's name plausibly uses, so that editing S_MASTHEAD is a
    # one-line change and not a one-line change plus a font regeneration. The
    # failure this buys off is tofu across the largest text on the screen.
    masthead = set("ABCDEFGHIJKLMNOPQRSTUVWXYZ")
    masthead |= set("abcdefghijklmnopqrstuvwxyz")
    masthead |= set(" .,'-&")
    masthead |= literal_chars(src, only="S_MASTHEAD")

    # Korean: what tools/hangul.py says the desk may file — KS X 1001's 2,350
    # 완성형 syllables, the compatibility jamo and the CJK punctuation — plus
    # every non-Latin character ui_strings.h uses, so a Korean fixed string
    # added to that header is covered without anyone remembering to widen this.
    #
    # No ASCII and no Latin-1, deliberately. The primary face owns those and
    # LVGL never reaches the fallback for a character the primary can draw, so
    # copying them here would be a megabyte of flash that can never be read —
    # and a way for a digit inside a Korean headline to come out in the wrong
    # family the day someone swaps the chain around.
    hangul_set = set(hangul.DRAWABLE_KO)
    hangul_set |= {c for c in literal_chars(src) if ord(c) >= 0x3000}

    for s in (text, masthead, hangul_set):
        s.discard("\n")
        s.discard("\t")
    return {"text": text, "masthead": masthead, "hangul": hangul_set}


# --- conversion ------------------------------------------------------------

def lining_figures(font):
    """Point U+0030..0039 at the glyphs OpenType `lnum` would substitute in.

    Playfair Display's DEFAULT figures are old-style, and lv_font_conv has no
    feature support at all — it reads the cmap and nothing else — so the faces
    this generator produced set text figures wherever a number appeared. In the
    headline "Crude slips under $60" the 6 stood at ascender height and the 0
    sat at x-height, which at 56 px reads as "$6o"; in the index ribbon and on
    A2 a column of five levels had no common cap line, no common baseline, and a
    decimal point floating below the optical centre of half its digits. A
    newspaper's tables and its display figures are lining, always, and the
    quotation tables on the same sheet were already setting lining figures in
    the label face — so the page carried two contradictory figure styles for the
    same kind of data.

    A feature cannot be "enabled" in the generated output, so it is FROZEN here:
    the substitution the feature would have made is applied to the cmap, and
    lv_font_conv is handed a font whose digits are the lining ones. Nothing else
    in the font is touched, so the line height, the ascender and the descender —
    all of which ui_internal.h and ui_page_markets.c transcribe — are unchanged
    by construction.

    A family whose figures are already lining has no `lnum`, or maps each digit
    to itself, and this is then a no-op. Returns how many digits it moved, so
    the operator can see which faces it actually changed.
    """
    gsub = font.get("GSUB")
    if gsub is None:
        return 0

    table = gsub.table
    lookups = []
    for rec in table.FeatureList.FeatureRecord:
        if rec.FeatureTag == "lnum":
            lookups.extend(rec.Feature.LookupListIndex)

    sub = {}
    for i in sorted(set(lookups)):
        lookup = table.LookupList.Lookup[i]
        if lookup.LookupType != 1:      # single substitution is all a figure set is
            continue
        for st in lookup.SubTable:
            sub.update(st.mapping)
    if not sub:
        return 0

    moved = 0
    for cm in font["cmap"].tables:
        for cp in range(0x30, 0x3A):
            g = cm.cmap.get(cp)
            if g in sub and sub[g] != g:
                cm.cmap[cp] = sub[g]
                moved += 1
    return moved


def instance(src_ttf, location, out_ttf):
    """Pin a variable font to one point on its axes, with lining figures.

    A `location` of None is a static font — the Korean OTFs — and it passes
    through, re-saved so that every face downstream of here is one file in one
    place whatever it came from.
    """
    from fontTools import ttLib
    from fontTools.varLib import instancer

    font = ttLib.TTFont(src_ttf)
    if location:
        if "fvar" not in font:
            sys.exit(f"{os.path.basename(src_ttf)} is not a variable font, "
                     f"but the face table asks for {location}")
        instancer.instantiateVariableFont(font, location, inplace=True,
                                          updateFontNames=True)
    moved = lining_figures(font)
    if moved:
        print(f"    lnum frozen: {moved // max(1, len(font['cmap'].tables))} "
              f"digit(s) remapped to the lining set")
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


# The comment banner lv_font_conv puts above the public lv_font_t. The extern
# for the Korean face goes in front of it: the pointer below has to see a
# declaration, and this is the one place in the file that is neither bitmap data
# nor inside a version #if.
PUBLIC_FONT_BANNER = ("/*-----------------\n"
                      " *  PUBLIC FONT\n"
                      " *----------------*/")


def link_fallback(path, ko_name):
    """Point a Latin face's `.fallback` at its Korean twin. Idempotent.

    The struct is `const` and lives in flash, so this pointer cannot be set at
    runtime; it is written into the generated source instead. Both edits are
    checked rather than assumed, because lv_font_conv's output is the authority
    on its own shape and a silent no-op here is a page of tofu on the glass.
    """
    with open(path, encoding="utf-8") as f:
        src = f.read()

    where = os.path.relpath(path, ROOT)
    decl = f"extern const lv_font_t {ko_name};\n\n"
    if decl not in src:
        if PUBLIC_FONT_BANNER not in src:
            sys.exit(f"{where}: lv_font_conv's PUBLIC FONT banner is not in "
                     f"this file, so its shape has changed. Re-read the "
                     f"generated output and fix link_fallback().")
        src = src.replace(PUBLIC_FONT_BANNER, decl + PUBLIC_FONT_BANNER, 1)

    src, n = re.subn(r"\.fallback = (?:NULL|&\w+),", f".fallback = &{ko_name},", src)
    if n != 1:
        sys.exit(f"{where}: expected exactly one .fallback line, found {n}. "
                 f"Re-read the generated output and fix link_fallback().")

    with open(path, "w", encoding="utf-8") as f:
        f.write(src)


def assert_bitmap_fits(path):
    """LV_FONT_FMT_TXT_LARGE is 0: bitmap_index is a 20-bit field.

    Six faces of 2,350 Hangul syllables put this within reach for the first
    time — a 56 px syllable is around 380 bytes and 2,350 of them are most of a
    megabyte — and overflowing it does not fail the build. It wraps, and the
    glyphs past the wrap draw whatever bytes are at the aliased offset.
    """
    with open(path, encoding="utf-8") as f:
        top = max(int(m) for m in re.findall(r"\.bitmap_index = (\d+)", f.read()))
    if top >= (1 << 20):
        sys.exit(f"{os.path.relpath(path, ROOT)}: bitmap_index {top} needs "
                 f"LV_FONT_FMT_TXT_LARGE=1 in sim/lv_conf.h and "
                 f"CONFIG_LV_FONT_FMT_TXT_LARGE=y in sdkconfig.defaults")
    return top


def link_fallbacks_pass():
    """Re-apply every fallback pointer over the committed files.

    Regenerating a face costs minutes and rewrites a megabyte of C to change one
    line, so the pointer has its own pass. It is what to run after a Korean face
    is renamed or a Latin face is regenerated on its own.
    """
    for latin, ko in sorted(FALLBACK.items()):
        latin_c = os.path.join(FONTDIR, latin + ".c")
        ko_c = os.path.join(FONTDIR, ko + ".c")
        for p in (latin_c, ko_c):
            if not os.path.exists(p):
                sys.exit(f"missing {os.path.relpath(p, ROOT)} — generate the "
                         f"faces before linking them")
        link_fallback(latin_c, ko)
        print(f"  {latin}.fallback -> &{ko}"
              f"   (bitmap_index tops out at {assert_bitmap_fits(ko_c)})")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--download", action="store_true",
                    help="fetch the families this run needs into a temp dir")
    ap.add_argument("--font-dir",
                    help="use already-downloaded originals from this directory "
                         "instead (files named as upstream)")
    ap.add_argument("--dry-run", action="store_true",
                    help="report the glyph sets and the face table, then stop")
    ap.add_argument("--link-fallbacks", action="store_true",
                    help="re-point each committed Latin face at its Korean "
                         "twin and stop. Idempotent, and the only cheap way to "
                         "change that pointer — regenerating rewrites a "
                         "megabyte of C to move one line.")
    ap.add_argument("--only",
                    help="regenerate only these faces (comma-separated). The "
                         "upstream families move under us, so a change that "
                         "concerns two faces should not rewrite thirteen.")
    args = ap.parse_args()

    faces = ALL_FACES
    if args.only:
        want = {n.strip() for n in args.only.split(",")}
        faces = [f for f in ALL_FACES if f[0] in want]
        unknown = want - {f[0] for f in faces}
        if unknown:
            sys.exit("no such face: " + ", ".join(sorted(unknown)))

    sets = symbol_sets()

    if args.dry_run:
        for kind, chars in sorted(sets.items()):
            extra = sorted(c for c in chars if ord(c) > 0x7E)
            print(f"{kind}: {len(chars)} glyphs "
                  f"({len(chars) - len(extra)} ASCII + {len(extra)} beyond)")
            # The Hangul set is 2,400 characters and printing it is a wall of
            # text nobody reads; the range is what a reader is checking for.
            if len(extra) > 200:
                shown = f"U+{ord(extra[0]):04X}..U+{ord(extra[-1]):04X}"
            else:
                shown = "".join(extra) or "(none)"
            print("   ", shown)
        print()
        for name, fam, size, loc, kind in ALL_FACES:
            behind = FALLBACK.get(name)
            print(f"  {name:22s} {fam:14s} {size:4d}px  bpp1  "
                  f"{str(loc or 'static'):28s} {kind} ({len(sets[kind])} glyphs)"
                  + (f"  -> fallback &{behind}" if behind else ""))
        return

    if args.link_fallbacks:
        link_fallbacks_pass()
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
    needed = {f[1] for f in faces}
    for fam, (font_url, ofl_url) in FAMILIES.items():
        if fam not in needed:
            continue
        base = urllib.parse.unquote(os.path.basename(font_url))
        if args.font_dir:
            originals[fam] = os.path.join(args.font_dir, base)
            if not os.path.exists(originals[fam]):
                sys.exit(f"missing {originals[fam]}")
        else:
            originals[fam] = os.path.join(tmp, base)
            print(f"downloading {base}")
            urllib.request.urlretrieve(font_url, originals[fam])
            ofl = os.path.join(FONTDIR, ofl_name(ofl_url))
            if not os.path.exists(ofl):
                urllib.request.urlretrieve(ofl_url, ofl)

    total = 0
    for name, fam, size, loc, kind in faces:
        # Keep the source's own extension: the Korean originals are CFF OTFs and
        # calling one .ttf would be a lie in the one place that has to stay
        # readable when a face is being reproduced by hand.
        ext = os.path.splitext(originals[fam])[1] or ".ttf"
        static = instance(originals[fam], loc,
                          os.path.join(tmp, name + ext))
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
        top = assert_bitmap_fits(path)
        # A Latin face carries the pointer to its Korean twin, so regenerating
        # one must not quietly drop it back to NULL.
        if name in FALLBACK:
            link_fallback(path, FALLBACK[name])
        total += os.path.getsize(path)
        print(f"    -> {os.path.getsize(path) // 1024} KiB of C source, "
              f"bitmap_index tops out at {top}"
              + (f", fallback -> &{FALLBACK[name]}" if name in FALLBACK else ""))

    print(f"generated {len(faces)} faces, {total // 1024} KiB of C source")


if __name__ == "__main__":
    main()
