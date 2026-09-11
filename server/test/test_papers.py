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

    def test_a_paper_reads_byte_identical_to_what_the_board_polls(self):
        """The promise the phone's reader is built on, held to the byte.

        The Today reader parses ONE shape whichever route fed it -- the desk's
        per-edition read or the board's own ``/news.json`` -- so a phone never
        needs a second parser. That is a claim about bytes, and the only thing
        that can hold the desk to it is a test that compares them: both routes
        end in ``_send_edition_payload``, and this is what fails if a second
        spelling of that sequence ever grows beside it.

        The ETags too, because they are derived from the spliced bytes rather
        than from the stored payload. Equal bodies under different validators
        would still be two answers to a cache and to a conditional request.
        """
        eid = self.paper("SNDK")
        status, doc = self.api("POST", "/api/editions/%s/promote" % eid, {})
        self.assertEqual(status, 200, doc)

        # The policy block is computed per request against the clock, so bodies
        # fetched at different instants would legitimately differ. Nothing on
        # either path moves a FixedClock -- it advances only on `advance` and
        # on `sleep`, and neither GET sleeps -- but the assertion is cheaper
        # than the assumption, and it is what says *why* the comparison below
        # is fair if it ever stops being.
        before = self.clock.now()
        status, mine, headers = self.call(
            "GET", "/api/editions/%s/news.json" % eid, None,
            self.tokens["producer"])
        self.assertEqual(status, 200, mine)
        # No token: the board's own plane, exactly as it polls it.
        status, board, board_headers = self.call("GET", "/news.json")
        self.assertEqual(status, 200, board)
        self.assertEqual(self.clock.now(), before, "the clock moved mid-test")

        self.assertEqual(mine, board)
        self.assertEqual(headers["ETag"], board_headers["ETag"])
        self.assertEqual(headers["Content-Type"],
                         board_headers["Content-Type"])

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


class RotationTest(PaperTestCase):
    """What the desk orders when nobody is asking it for anything.

    The four rules in order: not while the queue has anything in it, the
    stalest company first, not before the cadence, and priority 9 so that
    anything a person files goes ahead of it.

    `DeskTestCase` puts the clock at nine on a Wednesday morning, three hours
    past the 06:00 wake and well outside `WAKE_GRACE_SECONDS`. A case that
    advances a whole cadence lands at 21:00, an hour before the 22:00 one. So
    no tick in this class can fire a scheduled `file_edition` -- which matters
    more here than anywhere else, because a wake's own command would stand the
    rotation down by rule 1 and every assertion below would read as a bug in
    the rotation.
    """

    def rotate(self):
        """One housekeeping pass, and what it did."""
        self.clock.advance(HOUSEKEEPING_SECONDS)
        return self.desk.tick()

    def ordered(self):
        """Every paper command on the queue, oldest first."""
        return [c for c in self.desk.commands() if c["kind"] == "paper"]

    def test_an_idle_desk_with_nothing_written_orders_the_first_company(self):
        # Every company is equally stale -- none has a paper -- so the tiebreak
        # is the watchlist's own order and the answer must be SNDK every time.
        self.assertIn("paper:SNDK", self.rotate())
        [one] = self.ordered()
        self.assertEqual(one["kind"], "paper")
        self.assertEqual(one["symbol"], "SNDK")
        self.assertEqual(one["priority"], 9)
        self.assertEqual(one["source"], "rotation")
        self.assertEqual(one["text"],
                         "Refresh the paper for SNDK. The company is given; "
                         "research it and write both pages.")

    def test_the_deadline_is_one_cadence_ahead(self):
        self.rotate()
        [one] = self.ordered()
        self.assertAlmostEqual(one["deadline_at"],
                               one["created_at"]
                               + st.DEFAULT["paper_refresh_hours"] * 3600,
                               places=3)

    def test_it_orders_one_and_then_waits_for_it(self):
        # The whole idempotency argument: there is no meta key and no memory,
        # only the fact that a queue with something in it stops the next order.
        self.assertIn("paper:SNDK", self.rotate())
        for _ in range(3):
            self.assertNotIn("paper:SNDK", self.rotate())
        self.assertEqual(len(self.ordered()), 1)

    def test_a_claimed_paper_still_stops_the_next_one(self):
        self.rotate()
        self.desk.store.claim_command("w")
        self.assertEqual(self.ordered()[0]["status"], "claimed")
        self.assertEqual([d for d in self.rotate() if d.startswith("paper:")],
                         [])

    def test_a_command_of_any_other_kind_stops_it_too(self):
        # An `ask` the owner typed is claimed on the worker's next poll, and a
        # paper queued behind it would make that answer wait for a run that
        # takes thirty to forty minutes.
        self.desk.enqueue("ask", "왜 그 회사예요?", source="app")
        self.assertEqual([d for d in self.rotate() if d.startswith("paper:")],
                         [])

    def test_a_finished_command_does_not_stop_it(self):
        cid = self.desk.enqueue("ask", "왜 그 회사예요?")["id"]
        self.desk.store.claim_command("w")
        self.desk.finish(cid, "done", "answered")
        self.assertIn("paper:SNDK", self.rotate())

    def test_the_company_with_the_oldest_paper_goes_first(self):
        self.paper("SNDK")
        self.clock.advance(60)
        self.paper("NVDA")
        self.clock.advance(60)
        self.paper("ACME")
        # All three now have papers; SNDK's is the oldest.
        self.clock.advance(st.DEFAULT["paper_refresh_hours"] * 3600)
        self.assertIn("paper:SNDK", self.rotate())

    def test_a_company_with_no_paper_is_older_than_any_paper(self):
        # NVDA has never been written about. However fresh the other two are,
        # it is the one the pager has nothing to show for.
        self.paper("SNDK")
        self.paper("ACME")
        self.assertIn("paper:NVDA", self.rotate())

    def test_nothing_is_ordered_while_every_paper_is_fresh(self):
        for symbol in ("SNDK", "ACME", "NVDA"):
            self.paper(symbol)
        self.assertEqual([d for d in self.rotate() if d.startswith("paper:")],
                         [])

    def test_the_cadence_is_the_setting_and_not_a_constant(self):
        for symbol in ("SNDK", "ACME", "NVDA"):
            self.paper(symbol)
        status, doc = self.api("PUT", "/api/settings",
                               {"lang": "en", "paper_refresh_hours": 1})
        self.assertEqual(status, 200, doc)

        self.clock.advance(3600)
        self.assertIn("paper:SNDK", self.rotate())

    def test_a_desk_with_no_watchlist_orders_nothing(self):
        # Real state: the vault pushes that document every morning and a desk
        # brought up before the first push has none. A rotation that guessed a
        # company here would be the board's own job, done wrong.
        self.desk.watchlist = None
        self.assertEqual([d for d in self.rotate() if d.startswith("paper:")],
                         [])

    def test_a_company_that_is_not_printable_is_never_ordered(self):
        status, doc = self.api("PUT", "/api/watchlist",
                               watchlist(("SNDK", "Sandisk Corp.", False),
                                         ("ACME", "Acme Industries", True)))
        self.assertEqual(status, 200, doc)
        self.assertIn("paper:ACME", self.rotate())

    def test_a_failed_run_is_ordered_again(self):
        self.rotate()
        cid = self.ordered()[0]["id"]
        self.desk.store.claim_command("w")
        self.desk.finish(cid, "failed", "the model drifted")
        self.assertIn("paper:SNDK", self.rotate())
        self.assertEqual(len(self.ordered()), 2)

    def test_retention_is_told_which_companies_to_protect(self):
        # The rotation and prune read the same list. A prune that did not know
        # about the watchlist would take the paper the pager is about to draw.
        eid = self.paper("SNDK")
        for n in range(40):
            self.clock.advance(60)
            self.paper("ACME", serial=n)
        self.clock.advance(HOUSEKEEPING_SECONDS)
        self.desk.tick()
        status, raw, _ = self.call("GET", "/api/editions/%s/news.json" % eid,
                                   None, self.tokens["producer"])
        self.assertEqual(status, 200)

    # -- the two validators that do not agree ------------------------------
    #
    # `watchlist._symbol` takes 1-12 characters; `store.COMMAND_SYMBOL_RE`
    # takes 1-8 and wants at least one letter or digit. So the watchlist can
    # legitimately carry a company no command could ever name, and an
    # unfiltered rotation would raise `BadRequest` out of `Desk.enqueue` --
    # from the last step of the housekeeping block, taking the reap, the
    # sweep, the prune, the delivery ageing and the owed answers with it,
    # every ten minutes forever, over one row in a document the vault pushes
    # every morning.

    #: Accepted by the watchlist (12 characters), refused by the queue.
    LONG = "LONGSYMBOL12"

    #: Accepted by the watchlist, refused by the queue for the other reason:
    #: punctuation only, no letter and no digit.
    PUNCT = "..."

    def test_a_symbol_too_long_for_a_command_is_skipped_not_raised(self):
        status, doc = self.api("PUT", "/api/watchlist",
                               watchlist((self.LONG, "Long Symbol Corp.", True),
                                         ("ACME", "Acme Industries", True)))
        self.assertEqual(status, 200, doc)
        # The second company is ordered, and the pass did not raise on the way.
        did = self.rotate()
        self.assertIn("paper:ACME", did)
        self.assertEqual([c["symbol"] for c in self.ordered()], ["ACME"])

    def test_a_watchlist_of_nothing_orderable_still_does_its_housekeeping(self):
        status, doc = self.api("PUT", "/api/watchlist",
                               watchlist((self.LONG, "Long Symbol Corp.", True),
                                         (self.PUNCT, "Dot Dot Dot", True)))
        self.assertEqual(status, 200, doc)
        # Something for the reap to find, so the pass has to reach the end of
        # the block to report it -- which is the evidence that the rotation
        # did not take the block down with it.
        self.desk.enqueue("ask", "a question nobody will answer",
                          deadline_at=self.clock.now() - 1)

        did = self.rotate()
        self.assertIn("reaped:1", did)
        self.assertEqual([d for d in did if d.startswith("paper:")], [])
        self.assertEqual(self.ordered(), [])

    def test_the_symbol_it_cannot_order_is_warned_about_once_not_every_pass(self):
        # Every ten minutes forever: a line per pass would bury the log.
        status, doc = self.api("PUT", "/api/watchlist",
                               watchlist((self.LONG, "Long Symbol Corp.", True)))
        self.assertEqual(status, 200, doc)
        with self.assertLogs("claudepost.app", level="WARNING") as caught:
            for _ in range(4):
                self.rotate()
        said = [r.getMessage() for r in caught.records if self.LONG in r.getMessage()]
        self.assertEqual(len(said), 1,
                         [r.getMessage() for r in caught.records])


if __name__ == "__main__":       # pragma: no cover
    unittest.main()
