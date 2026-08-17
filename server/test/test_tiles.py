"""The transport limits, and the id rule that keeps an id from becoming a path."""

import unittest

from wpdesk import tiles
from wpdesk.errors import BadRequest, TooLarge


class TileIdTest(unittest.TestCase):
    def test_accepts_the_ids_the_device_accepts(self):
        for good in ("sndk_fab", "a", "A-1_z", "0123456789abcde"):
            self.assertTrue(tiles.valid_tile_id(good), good)

    def test_rejects_what_would_become_a_path(self):
        for bad in ("", "../etc", "a/b", "a.bin", "a%2e", "x" * 16, "a b", "a\x00b"):
            self.assertFalse(tiles.valid_tile_id(bad), repr(bad))

    def test_rejects_what_is_not_a_string(self):
        for bad in (None, 3, b"ok"):
            self.assertFalse(tiles.valid_tile_id(bad), repr(bad))


class TileSizeTest(unittest.TestCase):
    def test_a_full_sheet_tile_is_the_largest_that_can_exist(self):
        tiles.check_tile("ok", b"\x00" * tiles.MAX_TILE_BYTES)

    def test_one_byte_over_a_full_sheet_is_refused(self):
        with self.assertRaises(TooLarge):
            tiles.check_tile("ok", b"\x00" * (tiles.MAX_TILE_BYTES + 1))

    def test_an_empty_tile_is_refused(self):
        with self.assertRaises(BadRequest):
            tiles.check_tile("ok", b"")

    def test_a_bad_id_is_refused_before_the_bytes_are_looked_at(self):
        with self.assertRaises(BadRequest):
            tiles.check_tile("../x", b"\x00" * 8)

    def test_a_full_sheet_is_the_panel_at_four_bits_a_pixel(self):
        self.assertEqual(tiles.MAX_TILE_BYTES, 1200 * 1600 // 2)


class PayloadSizeTest(unittest.TestCase):
    def test_the_cap_is_below_what_the_device_will_fetch(self):
        # http_port_esp.c:32 -- HTTP_MAX_RESP is 320 KB. A payload above it is
        # a page nobody can fetch, so the desk must not be able to serve one.
        self.assertLess(tiles.MAX_PAYLOAD_BYTES, 320 * 1024)

    def test_at_the_cap_is_allowed(self):
        tiles.check_payload_size(b"x" * tiles.MAX_PAYLOAD_BYTES)

    def test_over_the_cap_is_refused(self):
        with self.assertRaises(TooLarge):
            tiles.check_payload_size(b"x" * (tiles.MAX_PAYLOAD_BYTES + 1))


class ErrorEnvelopeTest(unittest.TestCase):
    def test_the_body_matches_the_boards_own_envelope(self):
        self.assertEqual(TooLarge().to_json(), {"ok": False, "error": "too_large"})

    def test_a_detail_is_carried_only_when_there_is_one(self):
        self.assertNotIn("detail", BadRequest().to_json())
        self.assertEqual(BadRequest(message="why").to_json()["detail"], "why")

    def test_each_class_carries_its_own_status(self):
        from wpdesk import errors
        self.assertEqual(
            [errors.BadRequest().status, errors.Unauthorized().status,
             errors.Forbidden().status, errors.NotFound().status,
             errors.Conflict().status, errors.TooLarge().status],
            [400, 401, 403, 404, 409, 413])


if __name__ == "__main__":
    unittest.main()
