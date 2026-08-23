"""Twenty-four-bit BMP to PNG, with nothing but ``zlib``.

``tools/edition/render-check.sh`` converts the simulator's sheets with ``sips``,
which ships with macOS and exists nowhere else. In the desk's Linux container
that branch is simply skipped and the sheets stay 5.8 MB uncompressed BMPs --
one edition's proof is then eleven megabytes down a tunnel, for two pictures a
person is going to glance at. This is the conversion, in the standard library,
because adding Pillow to a service whose whole argument is "no lock file in a
public repository" would be a large dependency bought for sixty lines.

The parser is deliberately narrow. It reads exactly what ``write_preview()`` in
``sim/main_sim.c`` writes -- a 54-byte header, ``BI_RGB``, 24 bits, bottom-up --
and refuses everything else rather than guessing. That is the important
property here: a BMP the desk cannot parse is a proof sheet nobody sees, which
is the correct outcome, but a BMP it parses *wrongly* is a proof sheet an
operator looks at and believes. Misreading a bit depth by one field turns the
page into diagonal noise; misreading the row padding shears it. Both are
failures that look like the typesetter's fault, and the typesetter is the one
thing on this path that was already tested.
"""

from __future__ import annotations

import os
import struct
import zlib

from .errors import BadRequest
from .fsutil import atomic_write

#: The BMP file header, then as much of the info header as this parser reads.
_FILE_HEADER = 14
_INFO_HEADER = 40

#: PNG's fixed opening bytes.
_SIGNATURE = b"\x89PNG\r\n\x1a\n"

#: Deflate level. Six is zlib's default and the sheets are flat six-ink
#: pictures, so nine buys about a percent for several times the time -- and
#: this runs inside the render gate, on the clock the producer is waiting on.
_LEVEL = 6


def bmp24_to_png(data: bytes) -> bytes:
    """Convert an uncompressed 24-bit BMP to an 8-bit truecolour PNG.

    Raises :class:`BadRequest` for anything that is not one, naming the field
    that disagreed. The caller is a gate, and a gate that says "that is not a
    BMP" is worth more than one that says "conversion failed".
    """
    width, height, top_down, offset, stride = _parse_bmp_header(data)

    # Rows are assembled into one buffer with a filter byte of zero in front of
    # each. Filter 0 -- store the scanline as it is -- costs perhaps a fifth of
    # the compression a per-row heuristic would find, and buys back the entire
    # filter implementation. These are proof sheets, not the wire.
    raw = bytearray()
    for y in range(height):
        src = offset + (y if top_down else height - 1 - y) * stride
        row = data[src:src + width * 3]
        # BMP stores B, G, R; PNG wants R, G, B. The two strided assignments do
        # the swap inside the interpreter's C, which on a 1200 x 1600 sheet is
        # the difference between a fifth of a second and half a minute.
        rgb = bytearray(row)
        rgb[0::3] = row[2::3]
        rgb[2::3] = row[0::3]
        raw += b"\x00"
        raw += rgb

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return (_SIGNATURE
            + _chunk(b"IHDR", ihdr)
            + _chunk(b"IDAT", zlib.compress(bytes(raw), _LEVEL))
            + _chunk(b"IEND", b""))


def convert_dir(path: str, remove_bmp: bool = True) -> list[str]:
    """Convert every ``*.bmp`` in ``path`` to a PNG beside it.

    Returns the PNG paths, sorted, so the caller can name the sheets in the
    order they were produced. A directory that holds PNGs already -- what
    ``render-check.sh`` leaves on a Mac, where ``sips`` did this job -- is no
    work and no error, and neither is a directory that does not exist: the
    render gate calls this after a run that may have failed before it wrote
    anything, and losing the gate's output to a stray exception would lose the
    reason the draft was refused.
    """
    try:
        names = sorted(n for n in os.listdir(path) if n.endswith(".bmp"))
    except FileNotFoundError:
        return []

    out: list[str] = []
    for name in names:
        src = os.path.join(path, name)
        dst = os.path.join(path, name[:-4] + ".png")
        with open(src, "rb") as f:
            png = bmp24_to_png(f.read())
        # Through the one atomic write, so a reader that lists the directory
        # never opens a half-written sheet: the proof directory is served over
        # HTTP while the gate is still running.
        atomic_write(dst, png)
        if remove_bmp:
            os.remove(src)
        out.append(dst)
    return out


def _parse_bmp_header(data: bytes) -> tuple[int, int, bool, int, int]:
    """Validate the header and return (width, height, top_down, offset, stride)."""
    if len(data) < _FILE_HEADER + _INFO_HEADER:
        raise BadRequest(message=f"{len(data)} bytes is too short for a BMP header")
    if data[:2] != b"BM":
        raise BadRequest(message="not a BMP: the file does not start with 'BM'")

    off_bits, = struct.unpack_from("<I", data, 10)
    (info_size, width, height, planes, bits,
     compression, size_image) = struct.unpack_from("<IiiHHII", data, _FILE_HEADER)

    # A header longer than 40 bytes is a V4/V5 BMP, whose extra fields are
    # colour management this converter has no use for. Shorter is a
    # BITMAPCOREHEADER, which does not carry a compression field at all.
    if info_size < _INFO_HEADER:
        raise BadRequest(message=f"BMP info header is {info_size} bytes, expected >= 40")
    if bits != 24:
        raise BadRequest(message=f"BMP is {bits} bits per pixel, expected 24")
    if compression != 0:
        raise BadRequest(message=f"BMP compression is {compression}, expected 0 (BI_RGB)")
    if planes != 1:
        raise BadRequest(message=f"BMP declares {planes} colour planes, expected 1")
    if width <= 0 or height == 0:
        raise BadRequest(message=f"BMP dimensions are {width} x {height}")

    # A negative height means the rows are stored top-down -- already in PNG's
    # order. Flipping them anyway prints the sheet upside down, which reads as
    # a rendering bug rather than a parsing one and would be looked for in the
    # wrong file.
    top_down = height < 0
    height = abs(height)

    stride = (width * 3 + 3) & ~3
    needed = stride * height

    if off_bits < _FILE_HEADER + info_size or off_bits > len(data):
        raise BadRequest(message=f"BMP pixel offset {off_bits} is outside the file")
    # Both of these are the same fault seen from two sides: a header that
    # describes more picture than the file holds. Trusting either one and
    # reading past the end would give a short final row of zeroes, which prints
    # as a black band nobody would read as corruption.
    if size_image and size_image != needed:
        raise BadRequest(message=f"BMP declares {size_image} image bytes, "
                                 f"{width} x {height} at 24 bpp needs {needed}")
    if off_bits + needed > len(data):
        raise BadRequest(message=f"BMP is {len(data)} bytes, "
                                 f"{width} x {height} at 24 bpp needs "
                                 f"{off_bits + needed}")

    return width, height, top_down, off_bits, stride


def _chunk(kind: bytes, payload: bytes) -> bytes:
    """One PNG chunk: length, type, payload, CRC32 over the type and payload."""
    return (struct.pack(">I", len(payload)) + kind + payload
            + struct.pack(">I", zlib.crc32(kind + payload) & 0xFFFFFFFF))
