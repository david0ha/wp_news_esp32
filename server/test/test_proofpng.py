"""The BMP the simulator writes, read back as the PNG the desk serves.

The fixture is generated here rather than committed. A binary blob in a public
repository is a thing nobody can review in a diff, and this one is four pixels
wide -- the code that writes it *is* the documentation of the format being
parsed, which a checked-in file would not be.
"""

import os, struct, unittest, zlib
from claudepost import proofpng

HERE = os.path.dirname(__file__)
FIXTURE = os.path.join(HERE, "fixtures", "tiny.bmp")
PIXELS = [(255, 0, 0), (0, 255, 0), (0, 0, 255), (255, 255, 255),
          (0, 0, 0), (255, 255, 0), (0, 255, 255), (255, 0, 255),
          (10, 20, 30), (40, 50, 60), (70, 80, 90), (100, 110, 120)]
W, H = 4, 3


def write_bmp(path, w, h, pixels, top_down=False):
    """Write an uncompressed 24-bit BMP of ``pixels``, given top row first.

    The generator the whole module builds its fixtures with, so that the odd
    widths and the top-down case are not a second transcription of the format
    that could drift from the first.
    """
    os.makedirs(os.path.dirname(path), exist_ok=True)
    row_pad = (-w * 3) % 4
    rows = []
    order = range(h) if top_down else range(h - 1, -1, -1)   # BMP rows run bottom-up
    for y in order:
        row = b"".join(bytes((b, g, r)) for (r, g, b) in pixels[y * w:(y + 1) * w])
        rows.append(row + b"\x00" * row_pad)
    pixel_data = b"".join(rows)
    header = struct.pack("<2sIHHI", b"BM", 14 + 40 + len(pixel_data), 0, 0, 14 + 40)
    info = struct.pack("<IiiHHIIiiII", 40, w, -h if top_down else h, 1, 24, 0,
                       len(pixel_data), 2835, 2835, 0, 0)
    with open(path, "wb") as f:
        f.write(header + info + pixel_data)


def write_fixture():
    write_bmp(FIXTURE, W, H, PIXELS)


def read(path):
    """The whole file, with the handle closed.

    ``open(path, "rb").read()`` reads the same bytes and leaves a
    ResourceWarning on every run, and a suite that prints a warning per test is
    a suite whose warnings nobody reads on the day one of them matters.
    """
    with open(path, "rb") as f:
        return f.read()


def read_pixels(png, w, h):
    """Every pixel of ``png``, top row first, as (r, g, b) triples."""
    raw = zlib.decompress(ProofPngTest._chunk(png, b"IDAT"))
    stride = 1 + w * 3
    out = []
    for y in range(h):
        row = raw[y * stride:(y + 1) * stride]
        assert row[0] == 0, "filter type 0 on every row"
        for x in range(w):
            out.append(tuple(row[1 + x * 3:4 + x * 3]))
    return out


class ProofPngTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        write_fixture()

    def test_it_produces_a_png_signature_and_an_iend(self):
        png = proofpng.bmp24_to_png(read(FIXTURE))
        self.assertEqual(png[:8], b"\x89PNG\r\n\x1a\n")
        self.assertTrue(png.rstrip().endswith(b"IEND\xaeB`\x82"))

    def test_the_pixels_survive_in_the_right_order(self):
        png = proofpng.bmp24_to_png(read(FIXTURE))
        idat = self._chunk(png, b"IDAT")
        raw = zlib.decompress(idat)
        stride = 1 + W * 3
        got = []
        for y in range(H):
            row = raw[y * stride:(y + 1) * stride]
            self.assertEqual(row[0], 0, "filter type 0 on every row")
            for x in range(W):
                got.append(tuple(row[1 + x * 3:4 + x * 3]))
        self.assertEqual(got, PIXELS)      # top-down, RGB

    def test_the_header_reports_the_right_size(self):
        png = proofpng.bmp24_to_png(read(FIXTURE))
        w, h, depth, colour = struct.unpack(">IIBB", self._chunk(png, b"IHDR")[:10])
        self.assertEqual((w, h, depth, colour), (W, H, 8, 2))

    def test_a_file_that_is_not_a_bmp_is_refused(self):
        from claudepost.errors import BadRequest
        with self.assertRaises(BadRequest):
            proofpng.bmp24_to_png(b"not a bitmap at all")

    def test_a_paletted_bmp_is_refused_rather_than_misread(self):
        from claudepost.errors import BadRequest
        data = bytearray(read(FIXTURE))
        data[28] = 8                                    # bit depth field
        with self.assertRaises(BadRequest):
            proofpng.bmp24_to_png(bytes(data))

    @staticmethod
    def _chunk(png, kind):
        i, out = 8, b""
        while i < len(png):
            n = struct.unpack(">I", png[i:i + 4])[0]
            k = png[i + 4:i + 8]
            if k == kind:
                out += png[i + 8:i + 8 + n]
            i += 12 + n
        return out


class RowPaddingTest(unittest.TestCase):
    """Widths whose rows are not a multiple of four bytes.

    The simulator's sheets are 1200 px wide, so 3600 bytes a row and no padding
    at all -- which means the padding path is the one nothing else in this
    project would ever exercise. Every width whose ``w * 3`` is not a multiple
    of four needs one to three bytes skipped between rows, and getting that
    wrong does not fail: it shears the image one pixel further left on every
    row down the sheet.
    """

    def test_a_single_pixel_image_round_trips(self):
        # 1 x 1 is three bytes a row and therefore one byte of padding, the
        # smallest file this parser will ever be handed.
        path = os.path.join(HERE, "fixtures", "one.bmp")
        write_bmp(path, 1, 1, [(9, 99, 199)])
        png = proofpng.bmp24_to_png(read(path))
        w, h = struct.unpack(">II", ProofPngTest._chunk(png, b"IHDR")[:8])
        self.assertEqual((w, h), (1, 1))
        self.assertEqual(read_pixels(png, 1, 1), [(9, 99, 199)])

    def test_a_three_pixel_row_skips_its_three_bytes_of_padding(self):
        # 3 x 2 is nine bytes a row, padded to twelve: the worst case, and the
        # one where a parser that ignores padding reads the pad bytes as the
        # first pixel of the row above.
        path = os.path.join(HERE, "fixtures", "three.bmp")
        pixels = [(1, 2, 3), (4, 5, 6), (7, 8, 9),
                  (250, 251, 252), (253, 254, 255), (128, 129, 130)]
        write_bmp(path, 3, 2, pixels)
        png = proofpng.bmp24_to_png(read(path))
        self.assertEqual(read_pixels(png, 3, 2), pixels)

    def test_a_top_down_bmp_is_not_flipped_a_second_time(self):
        # A negative height means the rows are already in PNG order. Flipping
        # them anyway prints the sheet upside down, which is exactly the kind
        # of failure that looks like a rendering bug rather than a parser one.
        path = os.path.join(HERE, "fixtures", "topdown.bmp")
        write_bmp(path, W, H, PIXELS, top_down=True)
        png = proofpng.bmp24_to_png(read(path))
        self.assertEqual(read_pixels(png, W, H), PIXELS)


class RefusalTest(unittest.TestCase):
    """What is refused rather than misread.

    A BMP the desk cannot parse is a proof sheet the operator will not see, and
    that is the correct outcome. A BMP it parses *wrongly* is a proof sheet the
    operator looks at and believes, which is how a page nobody checked reaches
    the glass.
    """

    @classmethod
    def setUpClass(cls):
        write_fixture()
        cls.good = read(FIXTURE)

    def test_a_file_too_short_for_its_header_is_refused(self):
        from claudepost.errors import BadRequest
        for n in (0, 2, 13, 14, 40, 53):
            with self.assertRaises(BadRequest, msg=f"{n} bytes"):
                proofpng.bmp24_to_png(self.good[:n])

    def test_a_compressed_bmp_is_refused(self):
        from claudepost.errors import BadRequest
        data = bytearray(self.good)
        data[30] = 1                                    # biCompression = BI_RLE8
        with self.assertRaises(BadRequest):
            proofpng.bmp24_to_png(bytes(data))

    def test_pixel_data_shorter_than_the_header_promises_is_refused(self):
        from claudepost.errors import BadRequest
        with self.assertRaises(BadRequest):
            proofpng.bmp24_to_png(self.good[:-4])

    def test_a_declared_image_size_that_disagrees_is_refused(self):
        from claudepost.errors import BadRequest
        data = bytearray(self.good)
        struct.pack_into("<I", data, 34, 9999)          # biSizeImage
        with self.assertRaises(BadRequest):
            proofpng.bmp24_to_png(bytes(data))

    def test_a_zero_dimension_is_refused(self):
        from claudepost.errors import BadRequest
        data = bytearray(self.good)
        struct.pack_into("<i", data, 18, 0)             # biWidth
        with self.assertRaises(BadRequest):
            proofpng.bmp24_to_png(bytes(data))


class ConvertDirTest(unittest.TestCase):
    """The directory pass, which is what the render gate actually calls."""

    def setUp(self):
        import tempfile
        self.dir = tempfile.mkdtemp(prefix="claudepost-proof-")

    def tearDown(self):
        import shutil
        shutil.rmtree(self.dir, ignore_errors=True)

    def test_it_converts_every_sheet_and_takes_the_bmp_away(self):
        for name in ("A1", "A2"):
            write_bmp(os.path.join(self.dir, name + ".bmp"), W, H, PIXELS)
        out = proofpng.convert_dir(self.dir)
        self.assertEqual([os.path.basename(p) for p in out], ["A1.png", "A2.png"])
        self.assertEqual(sorted(os.listdir(self.dir)), ["A1.png", "A2.png"])
        for p in out:
            self.assertEqual(read(p)[:8], b"\x89PNG\r\n\x1a\n")

    def test_it_can_be_told_to_keep_the_bmp(self):
        write_bmp(os.path.join(self.dir, "A1.bmp"), W, H, PIXELS)
        proofpng.convert_dir(self.dir, remove_bmp=False)
        self.assertEqual(sorted(os.listdir(self.dir)), ["A1.bmp", "A1.png"])

    def test_a_directory_of_pngs_already_is_no_work_and_no_error(self):
        # What macOS leaves behind: render-check.sh found sips and converted
        # the sheets itself. The desk must not treat that as a failure.
        with open(os.path.join(self.dir, "A1.png"), "wb"):
            pass
        self.assertEqual(proofpng.convert_dir(self.dir), [])

    def test_a_missing_directory_is_no_work_and_no_error(self):
        self.assertEqual(proofpng.convert_dir(os.path.join(self.dir, "nope")), [])
