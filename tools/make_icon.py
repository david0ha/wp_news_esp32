#!/usr/bin/env python3
"""The app icon: a broadsheet front page in miniature, drawn in the measured inks.

Regenerate with:  python3 tools/make_icon.py app/assets/icon.png

Pure stdlib (zlib + struct) so nothing needs installing. RGB with no alpha, because App
Store Connect refuses an icon-less upload and refuses transparency in the one it gets.
The palette is wp_palette.c's wp_palette_ink[] — the measured "as paper" table the
simulator judges by — so the icon is the same paper the panel shows: cream ground,
near-black ink, the brick red of the tape, under a keyline as the sheet would carry it.
The composition sits slightly high of geometric centre (top margin 160 px, bottom 176)
because iOS masks the full square and optical centring raises artwork, never drops it.
"""
import struct
import sys
import zlib

W = H = 1024
PAPER = (226, 222, 211)   # wp_palette_ink white
INK = (38, 38, 40)        # wp_palette_ink black
RED = (158, 52, 44)       # wp_palette_ink red


def rect(buf, x0, y0, x1, y1, c):
    for y in range(y0, y1):
        row = buf[y]
        for x in range(x0, x1):
            row[3 * x:3 * x + 3] = bytes(c)


def main(out_path):
    buf = [bytearray(PAPER * W) for _ in range(H)]
    M = 128  # side margin: the 30-px-on-1200 sheet's generous frame, scaled by feel

    # Masthead: the heavy rule and the light rule that open A1.
    rect(buf, M, 160, W - M, 188, INK)
    rect(buf, M, 212, W - M, 222, INK)
    # Headline: two thick short bars.
    rect(buf, M, 282, 700, 326, INK)
    rect(buf, M, 350, 560, 394, INK)

    # Body: three columns of fine lines, with a runaround where the block sits.
    col_w = (W - 2 * M - 2 * 48) // 3
    bx0, by0 = W - M - 176, H - M - 168  # the red block's keyline box
    for ci in range(3):
        cx = M + ci * (col_w + 48)
        for li in range(9):
            y = 472 + li * 44
            x1 = cx + (col_w if li % 4 else int(col_w * 0.62))
            if y + 14 > by0 and x1 > bx0 - 24:
                x1 = bx0 - 24  # keep a gutter before the keyline
            if x1 > cx:
                rect(buf, cx, y, x1, y + 14, INK)

    # The one coloured mark: a red change block, keylined the way the sheet would.
    rect(buf, bx0, by0, W - M, H - M - 48, INK)
    rect(buf, bx0 + 8, by0 + 8, W - M - 8, H - M - 56, RED)

    raw = b"".join(b"\x00" + bytes(r) for r in buf)

    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    png = (b"\x89PNG\r\n\x1a\n"
           + chunk(b"IHDR", struct.pack(">IIBBBBB", W, H, 8, 2, 0, 0, 0))
           + chunk(b"IDAT", zlib.compress(raw, 9))
           + chunk(b"IEND", b""))
    with open(out_path, "wb") as f:
        f.write(png)
    print(f"{out_path}: {len(png)} bytes, {W}x{H}, no alpha")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "app/assets/icon.png")
