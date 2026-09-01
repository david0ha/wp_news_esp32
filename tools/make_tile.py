#!/usr/bin/env python3
"""
make_tile.py — a news photograph -> a 4bpp Spectra 6 tile the board blits verbatim.

The device does not resize, tone-map or dither anything. It fetches `w*h/2` bytes and copies
them into the framebuffer. Every decision about how a photograph should look on this panel is
made here, once, on a machine with floating point and an image library.

SIX INKS BY DEFAULT, AND WHY THE FIRST ANSWER WAS WRONG
------------------------------------------------------
Spectra 6's primaries are muddy: the red is a brick (#62201E), the green a moss (#35563A), the
blue a navy (#233F8E). The first test of colour here was run against a SYNTHETIC image — flat
rectangles of saturated colour — and produced confetti, so this file originally defaulted to a
halftone on that evidence.

That evidence was bad. Flat colour is the worst case for error diffusion: there is no local
detail to hide the residual in, so the whole area breaks into visible speckle. Re-run against an
actual photograph the result is different — a real image has texture at every scale, the
diffusion has somewhere to put its error, and the six inks resolve into something that reads as a
colour photograph: warm evening light, a pale sky, green in the trees. Noisy in the shadows,
clearly colour everywhere else.

So the default is `--color`, with gamut compression applied first — pulling saturation toward
what the panel can actually reach, so the diffusion is not asked to make up a colour that does
not exist. `--halftone` opts back into black ink on white paper, which is what a broadsheet does
and what a document, a chart or a portrait with no colour worth keeping still wants.

THE TONE CURVE MATTERS MORE THAN THE PALETTE
--------------------------------------------
Both treatments live or die on the tone curve. The panel's black is #1F2226 and its white
#B9C7C9 — about 5:1, where a screen gives 1000:1. The defaults below (black point 60, gamma 0.72)
lift the shadows well clear of the floor; the first attempt used 24 and 0.92 and crushed every
building in the test frame into one flat ink. If a tile comes out looking like a silhouette, this
is the knob, not the palette.

THE OUTPUT
----------
Raw bytes, no header: `h` rows of `w/2` bytes, row-major, two pixels per byte, **even x in the
high nibble**. That is the framebuffer's own layout (epd6_transpose.h), so the blit is a memcpy
per row — which is why `w` and the destination x must both be even.

    python3 tools/make_tile.py photo.jpg --out tiles/lead.bin  -W 1140 -H 320 --halftone
    python3 tools/make_tile.py thumb.jpg --out tiles/inside.bin -W 364 -H 204 --halftone

The image may be an `https://` URL, which is downloaded to a temporary file and deleted
afterwards. That is here rather than left to the caller because of who the caller is: a producing
agent runs with a narrow tool allow-list, and the alternative to this is granting it a general
`curl`, which is a much larger permission than "may fetch one picture". https only, and capped —
see MAX_IMAGE_BYTES.
"""

import argparse
import contextlib
import os
import sys
import tempfile
import urllib.error
import urllib.request

try:
    from PIL import Image, ImageEnhance
except ImportError:
    sys.exit("make_tile.py needs Pillow:  python3 -m pip install pillow")


# The wire codes, from epd6_transpose.h. These are what land in the framebuffer.
CODE = {
    "black":  0x00,
    "white":  0x01,
    "yellow": 0x02,
    "red":    0x03,
    "blue":   0x05,
    "green":  0x06,
}

# Roughly what the panel prints, transcribed from paperlesspaper/epdoptimize, which reports
# measuring a Spectra 6 panel. Dithering matches against these rather than against saturated
# primaries, because the whole point of error diffusion is that the error term is honest: telling
# the algorithm the red is #FF0000 when the panel prints #62201E makes it diffuse an error that
# never existed, and the surrounding pixels pay for it.
#
# components/news_core/wp_palette.c carries a SECOND table for the same six inks, eyeballed from
# product photography, and the two disagree — most in the white, a cool grey here against a warm
# paper there. That one only tints the simulator's preview; this one feeds a real halftone's error
# term, which is why they have not been collapsed into each other on the strength of a guess. One
# colorimeter reading replaces both. See the note in wp_palette.c.
INK = {
    "black":  (0x1F, 0x22, 0x26),
    "white":  (0xB9, 0xC7, 0xC9),
    "yellow": (0xC1, 0xBB, 0x1E),
    "red":    (0x62, 0x20, 0x1E),
    "blue":   (0x23, 0x3F, 0x8E),
    "green":  (0x35, 0x56, 0x3A),
}

MONO_ORDER  = ["black", "white"]
COLOR_ORDER = ["black", "white", "yellow", "red", "blue", "green"]


def build_palette(names):
    """A Pillow palette image over `names`, and the parallel list of wire codes.

    Every one of the 256 entries is filled, CYCLING through `names`, rather than
    padding the tail with zeros. Padding with zeros means padding with black, and
    Pillow matches against all 256 entries: a near-black pixel then quantizes to
    some index in the padding instead of to index 0, and the packer indexes past
    the end of the code list. With the palette cycled, entry i is always
    names[i % len(names)], so an index anywhere in 0..255 still names a real ink.
    """
    flat = []
    for i in range(256):
        flat.extend(INK[names[i % len(names)]])
    pal = Image.new("P", (1, 1))
    pal.putpalette(flat)
    return pal, [CODE[n] for n in names]


def tone_curve(img, black_point, white_point, gamma):
    """Compress the image into the range the panel can print, then bend the midtones.

    The panel's black is #1F2226 and its white is #B9C7C9 — a contrast ratio near 5:1, where a
    screen gives you 1000:1. Mapping 0..255 onto that directly crushes the shadows into one flat
    ink and blows the highlights into paper. So the source is compressed into [black_point,
    white_point] FIRST, and only then is the gamma applied, which is the same order a press
    operator works in.
    """
    lut = []
    span = white_point - black_point
    for i in range(256):
        v = (i / 255.0) ** gamma
        lut.append(int(round(black_point + v * span)))
    return img.point(lut * len(img.getbands()))


def compress_gamut(img, amount):
    """Pull saturation toward what six muddy inks can reach.

    Without this, a saturated source asks for colours the panel does not have and error diffusion
    scatters the shortfall across the neighbourhood as speckle. `amount` is how much saturation
    survives: 1.0 is untouched, 0.0 is greyscale.
    """
    return ImageEnhance.Color(img).enhance(amount)


def pack4bpp(indexed, codes):
    """Palette indices -> the framebuffer's nibble layout. Even x in the high nibble."""
    w, h = indexed.size
    px = indexed.load()
    stride = w // 2
    out = bytearray(stride * h)
    for y in range(h):
        row = y * stride
        for bx in range(stride):
            hi = codes[px[2 * bx, y] % len(codes)]
            lo = codes[px[2 * bx + 1, y] % len(codes)]
            out[row + bx] = ((hi & 0x0F) << 4) | (lo & 0x0F)
    return bytes(out)


def fit(img, w, h):
    """Cover the slot and centre-crop. A photograph letterboxed onto white leaves a grey band
    that the dither turns into visible texture; cropping loses content but never looks broken."""
    src_w, src_h = img.size
    scale = max(w / src_w, h / src_h)
    new = (max(w, int(round(src_w * scale))), max(h, int(round(src_h * scale))))
    img = img.resize(new, Image.LANCZOS)
    left = (new[0] - w) // 2
    top = (new[1] - h) // 2
    return img.crop((left, top, left + w, top + h))


def make_tile(path, w, h, color=True, saturation=0.9,
              black_point=60, white_point=240, gamma=0.72):
    if w % 2:
        raise ValueError(f"width must be even (the framebuffer packs two pixels per byte); got {w}")

    img = Image.open(path)
    if img.mode in ("RGBA", "LA", "P"):
        flat = Image.new("RGB", img.size, (255, 255, 255))
        img = img.convert("RGBA")
        flat.paste(img, mask=img.split()[-1])
        img = flat
    else:
        img = img.convert("RGB")

    img = fit(img, w, h)
    img = tone_curve(img, black_point, white_point, gamma)

    if color:
        img = compress_gamut(img, saturation)
        names = COLOR_ORDER
    else:
        # Convert to luminance BEFORE quantizing. Going straight to a two-entry palette makes
        # Pillow match in RGB, which weights the channels wrong for a photograph.
        img = img.convert("L").convert("RGB")
        names = MONO_ORDER

    pal, codes = build_palette(names)
    indexed = img.quantize(palette=pal, dither=Image.FLOYDSTEINBERG)
    return pack4bpp(indexed, codes), names


def preview(tile, w, h, names, path):
    """Write what the tile will look like, in the measured inks. The tile itself is not viewable
    with anything, and a pipeline whose output cannot be looked at is a pipeline nobody checks."""
    by_code = {CODE[n]: INK[n] for n in names}
    img = Image.new("RGB", (w, h))
    px = img.load()
    stride = w // 2
    for y in range(h):
        for bx in range(stride):
            b = tile[y * stride + bx]
            px[2 * bx, y] = by_code.get(b >> 4, (255, 0, 255))
            px[2 * bx + 1, y] = by_code.get(b & 0x0F, (255, 0, 255))
    img.save(path)


#: The ceiling on a downloaded picture. A tile is at most 1140x320 of somebody
#: else's photograph and a press wire JPEG is a couple of megabytes; anything
#: past this is not a news picture, and the thing at the other end of the link
#: was chosen by a language model reading a web page.
MAX_IMAGE_BYTES = 24 * 1024 * 1024

#: Long enough for a slow wire service, short enough that a filing run does not
#: park on a dead host for the length of its own timeout.
FETCH_TIMEOUT = 30


@contextlib.contextmanager
def sourced(image):
    """Yield a local path for `image`, fetching it first when it is a URL.

    `http://` is refused rather than followed. The URL here was found by a model
    on a page it was reading, and the one thing that can be said for the https
    version is that the bytes arriving are the bytes the host sent.
    """
    if image.startswith("http://"):
        sys.exit("make_tile: refusing http:// — use https, or download it yourself")
    if not image.startswith("https://"):
        yield image
        return

    req = urllib.request.Request(image, headers={"User-Agent": "claudepost-make-tile/1"})
    fd, tmp = tempfile.mkstemp(suffix=".img")
    try:
        with os.fdopen(fd, "wb") as out:
            try:
                with urllib.request.urlopen(req, timeout=FETCH_TIMEOUT) as r:
                    # urllib follows redirects, https -> http included, so the
                    # refusal above only covered the first hop. What matters is
                    # the connection the bytes actually crossed: the final one.
                    if not r.url.startswith("https://"):
                        sys.exit("make_tile: %s redirected off https; refusing"
                                 % image)
                    data = r.read(MAX_IMAGE_BYTES + 1)
            except (urllib.error.URLError, OSError) as e:
                sys.exit(f"make_tile: could not fetch {image}: {e}")
            if len(data) > MAX_IMAGE_BYTES:
                sys.exit(f"make_tile: {image} is larger than {MAX_IMAGE_BYTES} bytes")
            if not data:
                sys.exit(f"make_tile: {image} answered with nothing")
            out.write(data)
        # Whether it is an image at all is Pillow's question, not a content-type
        # header's: a header is what the host claims and the decoder is what has
        # to survive it.
        yield tmp
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("image", help="a local path, or an https:// URL to fetch")
    ap.add_argument("--out", "-o", required=True, help="the .bin the board fetches")
    ap.add_argument("--width", "-W", type=int, required=True, help="must be even")
    ap.add_argument("--height", "-H", type=int, required=True)
    ap.add_argument("--halftone", action="store_true",
                    help="black ink on white paper instead of all six inks")
    ap.add_argument("--saturation", type=float, default=0.9,
                    help="gamut compression; 1.0 leaves the source alone (default 0.9)")
    ap.add_argument("--black-point", type=int, default=60,
                    help="the shadow floor. Raise it if the image comes out a silhouette.")
    ap.add_argument("--white-point", type=int, default=240)
    ap.add_argument("--gamma", type=float, default=0.72)
    ap.add_argument("--preview", help="also write a PNG of what the panel will show")
    args = ap.parse_args()

    with sourced(args.image) as path:
        tile, names = make_tile(path, args.width, args.height,
                                color=not args.halftone, saturation=args.saturation,
                                black_point=args.black_point, white_point=args.white_point,
                                gamma=args.gamma)

    expect = args.width * args.height // 2
    assert len(tile) == expect, f"packed {len(tile)} bytes, contract says {expect}"

    with open(args.out, "wb") as f:
        f.write(tile)
    if args.preview:
        preview(tile, args.width, args.height, names, args.preview)

    print(f"{args.out}: {args.width}x{args.height}, {len(tile)} bytes, "
          f"{'halftone' if args.halftone else 'six inks'}")


if __name__ == "__main__":
    main()
