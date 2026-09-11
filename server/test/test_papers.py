"""The papers: one newspaper per company, read and published from a phone.

Everything here runs a real :class:`~claudepost.http.DeskServer` on a loopback
port, the way ``test_http.py`` does and for its reason -- what is being
asserted is what an app gets from a socket, including the scope on each route,
and a test that called the handlers in process could not catch a routing table
entry that never reaches them.

The rotation lives in this file too, because it is the same feature from the
other end: what the desk orders when nobody is asking it for anything.
"""

from __future__ import annotations

import json
import unittest

from claudepost import settings as st
from claudepost.app import HOUSEKEEPING_SECONDS

from test_http import DeskTestCase


def edition(symbol="SNDK", name="Sandisk Corp.", serial=1, lang=None,
            headline="A headline long enough to be a headline") -> bytes:
    """A payload about one company, distinguishable by ``serial``."""
    doc = {"edition": "SEMICONDUCTORS", "serial": serial,
           "subject": {"symbol": symbol, "name": name},
           "stories": [{"rank": 20, "headline": "A brief"},
                       {"rank": 0, "headline": headline,
                        "body": "MILPITAS — copy."}]}
    if lang is not None:
        doc["lang"] = lang
    return json.dumps(doc).encode()


def watchlist(*items) -> dict:
    """A watchlist document naming companies, printable unless said otherwise."""
    return {"items": [{"symbol": s, "name": n, "printable": p}
                      for s, n, p in items]}


class PaperTestCase(DeskTestCase):
    """A desk with a watchlist, and a way to file a paper for a company."""

    WATCHLIST = (("SNDK", "Sandisk Corp.", True),
                 ("ACME", "Acme Industries", True),
                 ("NVDA", "Nvidia Corp.", True))

    def setUp(self):
        super().setUp()
        status, doc = self.api("PUT", "/api/watchlist",
                               watchlist(*self.WATCHLIST))
        self.assertEqual(status, 200, doc)

    def paper(self, symbol="SNDK", serial=1, tile=None, **kw):
        """File one paper for ``symbol`` and return its edition id."""
        status, doc = self.api("POST", "/api/drafts", {}, "producer")
        self.assertEqual(status, 200, doc)
        draft = doc["draft_id"]
        status, _, _ = self.call("PUT", "/api/drafts/%s/news.json" % draft,
                                 edition(symbol, serial=serial, **kw),
                                 self.tokens["producer"])
        self.assertEqual(status, 200)
        if tile is not None:
            status, _, _ = self.call(
                "PUT", "/api/drafts/%s/tiles/pic.bin" % draft, tile,
                self.tokens["producer"], "application/octet-stream")
            self.assertEqual(status, 200)
        status, result = self.api("POST", "/api/drafts/%s/commit" % draft,
                                  {"target": "paper", "symbol": symbol},
                                  "producer")
        self.assertEqual(status, 200, result)
        self.assertIn(result["state"], ("paper", "unchanged"), result)
        return result["edition_id"]

    def papers(self, scope="producer"):
        return self.api("GET", "/api/papers", None, scope)


class PapersRouteTest(PaperTestCase):
    """`GET /api/papers`: one row per printable company, in watchlist order."""

    def test_a_row_for_every_printable_company_in_watchlist_order(self):
        status, doc = self.papers()
        self.assertEqual(status, 200, doc)
        self.assertTrue(doc["ok"])
        self.assertEqual([r["symbol"] for r in doc["papers"]],
                         ["SNDK", "ACME", "NVDA"])
        self.assertEqual([r["name"] for r in doc["papers"]],
                         ["Sandisk Corp.", "Acme Industries", "Nvidia Corp."])

    def test_a_company_with_no_paper_is_a_row_of_nulls_and_not_a_gap(self):
        # The pager draws "not written yet" from this. A skipped row would be
        # a company the owner watches and the app never mentions.
        status, doc = self.papers()
        [row] = [r for r in doc["papers"] if r["symbol"] == "NVDA"]
        self.assertIsNone(row["edition_id"])
        self.assertIsNone(row["created_at"])
        self.assertIsNone(row["lang"])
        self.assertIsNone(row["headline"])
        self.assertFalse(row["on_board"])
        self.assertTrue(row["stale"])

    def test_a_filed_paper_fills_its_row(self):
        eid = self.paper("SNDK", lang="ko", headline="메모리 가격이 오른다")
        status, doc = self.papers()
        [row] = [r for r in doc["papers"] if r["symbol"] == "SNDK"]
        self.assertEqual(row["edition_id"], eid)
        self.assertEqual(row["lang"], "ko")
        self.assertEqual(row["headline"], "메모리 가격이 오른다")
        self.assertEqual(row["created_at"], self.clock.now())
        self.assertFalse(row["on_board"])
        self.assertFalse(row["stale"])

    def test_a_row_goes_stale_at_the_cadence(self):
        self.paper("SNDK")
        self.clock.advance(st.DEFAULT["paper_refresh_hours"] * 3600 - 1)
        [row] = [r for r in self.papers()[1]["papers"] if r["symbol"] == "SNDK"]
        self.assertFalse(row["stale"])

        self.clock.advance(2)
        [row] = [r for r in self.papers()[1]["papers"] if r["symbol"] == "SNDK"]
        self.assertTrue(row["stale"])

    def test_the_board_s_own_edition_is_marked(self):
        board = self.file_edition()
        status, doc = self.papers()
        self.assertEqual(doc["board"], board["edition_id"])
        # PAYLOAD in test_http is about SNDK, so the board's edition is also
        # SNDK's newest paper -- which is the ordinary case, not a special one.
        [row] = [r for r in doc["papers"] if r["symbol"] == "SNDK"]
        self.assertEqual(row["edition_id"], board["edition_id"])
        self.assertTrue(row["on_board"])

    def test_a_company_that_is_not_printable_has_no_row(self):
        status, doc = self.api("PUT", "/api/watchlist",
                               watchlist(("SNDK", "Sandisk Corp.", True),
                                         ("ACME", "Acme Industries", False)))
        self.assertEqual(status, 200, doc)
        self.assertEqual([r["symbol"] for r in self.papers()[1]["papers"]],
                         ["SNDK"])

    def test_it_needs_a_producer_token(self):
        status, _, _ = self.call("GET", "/api/papers")
        self.assertEqual(status, 401)


class EditionReadTest(PaperTestCase):
    """Reading one edition's payload and tiles by its id."""

    TILE = bytes(range(256)) * 4

    def test_the_payload_comes_back_with_the_policy_block_spliced_in(self):
        eid = self.paper("SNDK")
        status, raw, headers = self.call(
            "GET", "/api/editions/%s/news.json" % eid, None,
            self.tokens["producer"])
        self.assertEqual(status, 200, raw)
        doc = json.loads(raw)
        self.assertEqual(doc["subject"]["symbol"], "SNDK")
        self.assertIn("poll_seconds", doc["policy"])
        self.assertIn("ETag", headers)

    def test_the_same_tag_comes_back_as_a_304(self):
        eid = self.paper("SNDK")
        _s, _b, headers = self.call("GET", "/api/editions/%s/news.json" % eid,
                                    None, self.tokens["producer"])
        status, body, _h = self.call(
            "GET", "/api/editions/%s/news.json" % eid, None,
            self.tokens["producer"],
            headers={"If-None-Match": headers["ETag"]})
        self.assertEqual(status, 304)
        self.assertEqual(body, b"")

    def test_a_tile_comes_back_verbatim(self):
        eid = self.paper("SNDK", tile=self.TILE)
        status, raw, headers = self.call(
            "GET", "/api/editions/%s/tiles/pic.bin" % eid, None,
            self.tokens["producer"])
        self.assertEqual(status, 200)
        self.assertEqual(raw, self.TILE)
        self.assertEqual(headers["Content-Type"], "application/octet-stream")

    def test_an_edition_that_is_not_there_is_a_404(self):
        status, _, _ = self.call("GET", "/api/editions/%s/news.json" % ("0" * 16),
                                 None, self.tokens["producer"])
        self.assertEqual(status, 404)

    def test_a_tile_that_is_not_there_is_a_404(self):
        eid = self.paper("SNDK")
        status, _, _ = self.call("GET", "/api/editions/%s/tiles/nope.bin" % eid,
                                 None, self.tokens["producer"])
        self.assertEqual(status, 404)

    def test_both_need_a_token(self):
        eid = self.paper("SNDK", tile=self.TILE)
        for path in ("/api/editions/%s/news.json" % eid,
                     "/api/editions/%s/tiles/pic.bin" % eid):
            with self.subTest(path=path):
                status, _, _ = self.call("GET", path)
                self.assertEqual(status, 401)

    def test_neither_is_reachable_without_one_from_the_device_plane(self):
        # The device plane is three paths and this is not one of them. A
        # per-edition read that leaked onto it would put every paper the desk
        # holds -- including companies the board never prints -- on an open URL.
        eid = self.paper("SNDK")
        status, _, _ = self.call("GET", "/api/editions/%s/news.json" % eid)
        self.assertEqual(status, 401)


class PublishPaperTest(PaperTestCase):
    """Putting a company's paper on the glass by hand."""

    def test_it_promotes_that_company_s_newest_edition(self):
        self.file_edition()                       # the board is on something
        eid = self.paper("ACME")
        status, doc = self.api("POST", "/api/papers/ACME/publish", {})
        self.assertEqual(status, 200, doc)
        self.assertEqual(doc["edition_id"], eid)
        self.assertEqual(doc["state"], "published")

        status, listed = self.api("GET", "/api/editions", None, "producer")
        self.assertEqual(listed["current"], eid)

    def test_the_newest_wins_when_a_company_has_two(self):
        self.paper("ACME", serial=1)
        self.clock.advance(3600)
        newest = self.paper("ACME", serial=2)
        status, doc = self.api("POST", "/api/papers/ACME/publish", {})
        self.assertEqual(doc["edition_id"], newest, doc)

    def test_a_lower_case_symbol_in_the_path_works(self):
        eid = self.paper("ACME")
        status, doc = self.api("POST", "/api/papers/acme/publish", {})
        self.assertEqual(status, 200, doc)
        self.assertEqual(doc["edition_id"], eid)

    def test_a_company_with_no_paper_is_a_404_that_says_so(self):
        status, doc = self.api("POST", "/api/papers/NVDA/publish", {})
        self.assertEqual(status, 404, doc)
        self.assertEqual(doc["error"], "no_paper")

    def test_publishing_what_is_already_up_changes_nothing(self):
        eid = self.paper("ACME")
        self.api("POST", "/api/papers/ACME/publish", {})
        status, doc = self.api("POST", "/api/papers/ACME/publish", {})
        self.assertEqual(status, 200, doc)
        self.assertEqual(doc["state"], "unchanged")
        self.assertEqual(doc["edition_id"], eid)

    def test_a_producer_token_may_not_publish(self):
        self.paper("ACME")
        status, doc = self.api("POST", "/api/papers/ACME/publish", {},
                               "producer")
        self.assertEqual(status, 403, doc)

    def test_a_path_segment_that_is_not_a_ticker_is_not_a_company(self):
        # These arrive as a URL *path segment*, and `..` is a value the desk
        # refuses to treat as a company name at every layer rather than
        # relying on the paper index happening to hold nothing under that key.
        # The route's own pattern is a character class and admits all of them,
        # so the refusal has to be the handler's: it re-checks the symbol
        # against `store.COMMAND_SYMBOL_RE`, which wants at least one letter
        # or digit. A thing that is not a ticker has no paper, so it answers
        # the same 404 a company with no edition gets.
        for symbol in ("..", ".", "...", ".-.", "-", "--------"):
            with self.subTest(symbol=symbol):
                status, doc = self.api(
                    "POST", "/api/papers/%s/publish" % symbol, {})
                self.assertEqual(status, 404, doc)
                self.assertEqual(doc["error"], "no_paper", doc)


if __name__ == "__main__":       # pragma: no cover
    unittest.main()
