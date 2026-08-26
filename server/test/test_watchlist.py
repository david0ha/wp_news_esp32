"""The watchlist: the document a private morning script files, and the phone
app reads back.

The interesting property of this schema is not what it accepts, it is what it
refuses. A watchlist item can carry a grade, a handful of reasons, a thesis
note -- the things a reader needs to understand a call -- but it can never
carry a stop level, an entry price, or a P&L figure, because none of those has
a key to hide behind. ``_no_extra_keys`` is not a typo guard here the way it
is in :mod:`claudepost.schedule`; it is the schema doing the one job privacy
review would otherwise have to do by hand on every PUT.

``parse_watchlist`` never reads a clock -- see :mod:`claudepost.clock`'s
docstring for why that indirection exists -- so ``updated_at`` in its output
is a placeholder the caller (the PUT handler, Task 7) overwrites with a real
instant before the document is saved. ``load`` runs the file back through
``parse_watchlist`` -- the boundary at the door is also the boundary at the
window, so a banned key cannot reach the phone app by some route other than
the PUT that refuses it -- and splices the file's own ``updated_at`` back in
afterwards, so a save-then-load round trip is still exact.
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import tempfile
import unittest

from claudepost import watchlist as W
from claudepost.errors import BadRequest

# The module warns when a file will not parse, which is exactly what one test
# here provokes. Without a handler that warning prints to stderr and a passing
# run reads like a failing one -- the same reason test_schedulefile.py adds
# this.
logging.getLogger("claudepost.watchlist").addHandler(logging.NullHandler())


def item(symbol: str = "ACME", **over) -> dict:
    """A minimal watchlist item document, naming only what a test overrides."""
    doc = {"symbol": symbol}
    doc.update(over)
    return doc


class ParseTest(unittest.TestCase):
    def test_a_minimal_document_parses_to_its_defaults(self):
        self.assertEqual(W.parse_watchlist({}), {
            "updated_at": 0,
            "source": "",
            "items": [],
            "universe": [],
        })

    def test_a_symbol_is_required_and_upper_cased(self):
        out = W.parse_watchlist({"items": [{"symbol": "acme"}]})
        self.assertEqual(out["items"], [{
            "symbol": "ACME",
            "name": "",
            "market": "",
            "grade": "none",
            "reasons": [],
            "thesis_status": "",
            "note": "",
            "printable": True,
            "last_printed": None,
            "events": [],
            "held": False,
        }])
        with self.assertRaises(BadRequest):
            W.parse_watchlist({"items": [{}]})     # no symbol at all

    def test_a_symbol_that_is_not_one_is_refused_naming_its_path(self):
        doc = {"items": [item("ACME"), item("bad symbol!")]}
        with self.assertRaises(BadRequest) as e:
            W.parse_watchlist(doc)
        self.assertIn("items[1].symbol", str(e.exception))

    def test_every_cap_is_a_refusal_and_not_a_truncation(self):
        # 65 items -- MAX_ITEMS is 64.
        with self.assertRaises(BadRequest):
            W.parse_watchlist(
                {"items": [item(f"S{i}") for i in range(65)]})
        # 129 symbols in the universe -- MAX_UNIVERSE is 128.
        with self.assertRaises(BadRequest):
            W.parse_watchlist(
                {"universe": [f"S{i}" for i in range(129)]})
        # 9 reasons on one item -- MAX_REASONS is 8.
        with self.assertRaises(BadRequest):
            W.parse_watchlist(
                {"items": [item(reasons=["margin call" for _ in range(9)])]})
        # 13 events on one item -- MAX_EVENTS is 12.
        with self.assertRaises(BadRequest):
            W.parse_watchlist({"items": [
                item(events=[f"2026-01-{d:02d}" for d in range(1, 14)])]})
        # A 17 KB note -- MAX_NOTE_BYTES is 16 KiB.
        with self.assertRaises(BadRequest):
            W.parse_watchlist(
                {"items": [item(note="m" * (17 * 1024))]})

    def test_a_grade_outside_the_vocabulary_is_refused(self):
        with self.assertRaises(BadRequest):
            W.parse_watchlist({"items": [item(grade="purple")]})

    def test_a_stop_level_cannot_be_pushed(self):
        """The schema is the privacy boundary: an unknown field is refused,
        never silently dropped -- a script that believes it filed a stop and a
        phone that never sees one is worse than a script that was told no."""
        with self.assertRaises(BadRequest):
            W.parse_watchlist({"items": [{"symbol": "ETN", "stop": 41.5}]})

    def test_the_serialised_document_is_also_capped(self):
        """Sixty-four items at the per-item note cap would be a megabyte, four
        times over MAX_DOC_BYTES, even though every per-field cap is satisfied
        on its own -- so the aggregate needs a cap of its own."""
        big = [item(f"S{i}", note="m" * W.MAX_NOTE_BYTES) for i in range(20)]
        with self.assertRaises(BadRequest):
            W.parse_watchlist({"items": big})


class LoadSaveTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.path = os.path.join(self.tmp, "watchlist.json")

    def test_load_of_a_file_that_will_not_parse_is_none_and_a_warning(self):
        with open(self.path, "wb") as f:
            f.write(b"{ not json at all")
        with self.assertLogs("claudepost.watchlist", level="WARNING"):
            self.assertIsNone(W.load(self.path))
        # Left on disk as evidence, the same rule schedulefile.py follows: the
        # person who wrote it is the only one who can fix it.
        with open(self.path, "rb") as f:
            self.assertEqual(f.read(), b"{ not json at all")

    def test_load_of_a_missing_file_is_none(self):
        self.assertIsNone(W.load(os.path.join(self.tmp, "nope.json")))

    def test_load_refuses_a_file_that_would_not_pass_the_wire(self):
        """A document good enough to be valid JSON but not good enough to
        pass parse_watchlist -- a pushed stop, a leaked field -- must not
        reach the phone app through GET just because it reached the file by
        some route other than the PUT that refuses it."""
        with open(self.path, "w") as f:
            json.dump({"items": [{"symbol": "ETN", "stop": 41.5}],
                       "extra_field": "leak"}, f)
        with self.assertLogs("claudepost.watchlist", level="WARNING"):
            self.assertIsNone(W.load(self.path))
        # Left on disk as evidence, same as any other file that will not
        # parse.
        with open(self.path) as f:
            self.assertIn("leak", f.read())

    def test_save_then_load_round_trips(self):
        doc = W.parse_watchlist({
            "source": "vault",
            "items": [item("ACME", name="Acme Corp", grade="green",
                           reasons=["margin expansion"], held=True)],
            "universe": ["ACME", "ETN"],
        })
        doc["updated_at"] = 1234567890     # what the PUT handler would stamp
        W.save(self.path, doc)
        self.assertEqual(W.load(self.path), doc)


if __name__ == "__main__":
    unittest.main()
