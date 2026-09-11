"""Drafts, the five gates, and the one rename that changes what the wall shows.

Two tests here are the reason the whole draft protocol exists and neither may
be allowed to weaken.

The first is that **a draft failing any gate leaves the current edition exactly
as it was** -- the same rule ``news_parse()`` follows on the device, where a
rejected payload never touches ``*out`` because a stale front page badged STALE
beats an empty one. It is asserted byte for byte, over the served payload and
every tile, and not by looking at an id.

The second is the **atomic swap**: a reader resolving ``current`` while a writer
publishes must never see an edition whose payload and tiles disagree. The
counter written into both is what makes that observable -- a mismatch is a
half-published edition caught in the act, where "no exception was raised" would
have proved nothing.

Everything runs on :class:`~claudepost.gates.StubGates` and
:class:`~claudepost.clock.FixedClock`: no CMake, no network, no waiting for six in
the morning.
"""

from __future__ import annotations

import json
import os
import shutil
import tempfile
import threading
import time
import unittest
from unittest import mock

from test_schedule import at

from claudepost import editions as E
from claudepost import schedule as S
from claudepost import tiles
from claudepost.clock import FixedClock
from claudepost.editions import EditionStore
from claudepost.errors import BadRequest, Conflict, Internal, NotFound, TooLarge
from claudepost.gates import GateResult, StubGates
from claudepost.store import Store

#: 2026-08-19 is an ordinary Wednesday. Nine in the morning is outside the
#: default quiet window and not a wake instant, so a schedule that publishes at
#: all publishes here.
T0 = at(2026, 8, 19, 9, 0)


def sched(**over) -> S.Schedule:
    """The default schedule with some keys replaced, parsed and validated.

    Going through ``parse_schedule`` rather than building a ``Schedule`` by
    hand means every schedule a test publishes against is one the desk would
    have accepted over ``PUT /api/schedule``.
    """
    doc = S.schedule_to_dict(S.DEFAULT_SCHEDULE)
    doc.update(over)
    return S.parse_schedule(doc)


#: No windows, no wakes, no floor: publish the moment the gates pass. This is
#: the schedule most tests use, because most tests are about something other
#: than the calendar.
IMMEDIATE = sched(quiet=[], wake=[],
                  publish={"policy": "immediate", "min_gap_minutes": 0})


def payload(n: int = 1, **extra) -> bytes:
    """A small but real edition payload, distinguishable by ``n``."""
    doc = {"edition": "2026-08-19", "serial": n,
           "stories": [{"rank": 0, "headline": f"Story {n}"}]}
    doc.update(extra)
    return json.dumps(doc).encode("utf-8")


def _backdate(path: str) -> None:
    """Make a directory look as old as a crash leftover from yesterday.

    The build sweeper compares against the filesystem's clock rather than the
    desk's, because what it is reading is a file's mtime -- so a test ages one
    by touching it, not by moving :class:`FixedClock`.
    """
    old = time.time() - E.DRAFT_TTL_SECONDS - 60
    os.utime(path, (old, old))


class SheetGates(StubGates):
    """A stub that also leaves a proof sheet behind, like the real gate does.

    Only two tests need this -- the ones about proof sheets surviving into the
    edition and about the names a caller may ask for -- and the rest are better
    off with a gate that touches no disk at all.
    """

    def render(self, draft_dir: str, out_dir: str) -> GateResult:
        self.calls.append("render")
        os.makedirs(out_dir, exist_ok=True)
        with open(os.path.join(out_dir, "A1.png"), "wb") as f:
            f.write(b"\x89PNG\r\n\x1a\nA1")
        return GateResult(ok=self.render_ok, output=self.output,
                          sheets=("A1.png",))


class EditionTestCase(unittest.TestCase):
    """An edition store on a temporary root, with gates and a clock in hand."""

    GATES = StubGates

    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.root = os.path.join(self.dir.name, "data")
        self.clock = FixedClock(T0)
        self.store = Store(os.path.join(self.dir.name, "desk.sqlite"), self.clock)
        self.addCleanup(self.store.close)
        self.gates = self.GATES()
        self.es = EditionStore(self.root, self.gates, self.store, self.clock)

    def jump(self, t: float) -> float:
        """Put the clock at ``t`` and hand it back, for passing as ``now``."""
        self.clock.set(t)
        return t

    def draft(self, n: int = 1, tile: bytes = b"\x01\x02\x03\x04") -> str:
        """A complete draft: one payload, one tile."""
        d = self.es.open_draft()
        self.es.put_payload(d, payload(n))
        self.es.put_tile(d, "pic", tile)
        return d

    def file(self, n: int = 1, s: S.Schedule = IMMEDIATE, now: float | None = None,
             tile: bytes = b"\x01\x02\x03\x04"):
        """Open a draft, fill it and commit it."""
        return self.es.commit(self.draft(n, tile), s,
                              self.clock.now() if now is None else now)


# --------------------------------------------------------------------------
# Drafts and their limits
# --------------------------------------------------------------------------

class DraftTest(EditionTestCase):
    def test_a_draft_is_a_directory_with_a_tiles_subdirectory(self):
        # The layout is load-bearing: gate 1 appends news.json itself and looks
        # for tiles/ beside it, so a draft that is shaped differently is a
        # draft the validator cannot see.
        d = self.es.open_draft()
        self.assertTrue(os.path.isdir(os.path.join(self.root, "drafts", d)))
        self.assertTrue(os.path.isdir(os.path.join(self.root, "drafts", d, "tiles")))

    def test_two_drafts_do_not_share_an_id(self):
        self.assertNotEqual(self.es.open_draft(), self.es.open_draft())

    def test_more_than_the_limit_of_open_drafts_is_refused(self):
        for _ in range(tiles.MAX_DRAFTS):
            self.es.open_draft()
        with self.assertRaises(Conflict):
            self.es.open_draft()

    def test_a_draft_that_has_been_abandoned_stops_counting(self):
        for _ in range(tiles.MAX_DRAFTS):
            self.es.open_draft()
        self.clock.advance(3601)
        self.es.open_draft()          # the sweep inside open_draft made room

    def test_draft_info_reports_what_has_been_pushed(self):
        d = self.draft()
        info = self.es.draft_info(d)
        self.assertEqual(info["id"], d)
        self.assertEqual(info["tiles"], ["pic"])
        self.assertEqual(info["bytes"], len(payload(1)))
        self.assertEqual(info["opened_at"], T0)

    def test_a_draft_that_does_not_exist_is_not_found(self):
        with self.assertRaises(NotFound):
            self.es.draft_info("0" * 32)

    def test_an_id_that_is_a_path_is_not_found_rather_than_followed(self):
        # NotFound rather than BadRequest on purpose: an id that cannot exist
        # does not exist, and answering "bad request" tells a prober that the
        # traversal was recognised.
        for bad in ("../editions", "..", "a/b", "", "." * 32, "/etc"):
            with self.assertRaises(NotFound, msg=bad):
                self.es.draft_info(bad)
            with self.assertRaises(NotFound, msg=bad):
                self.es.put_payload(bad, payload())

    def test_a_draft_id_the_desk_itself_mints_is_checked_like_any_other(self):
        # uuid4().hex always matches _DRAFT_RE today, so this is a test of the
        # day that stops being true: an id the desk mints for itself is not
        # exempt from the anchored regex every path join in this module
        # depends on, and a caller inside the desk that hands one a
        # path-shaped id is a bug here, not a request to refuse.
        fake = mock.Mock()
        fake.hex = "../escaped"
        with mock.patch.object(E.uuid, "uuid4", return_value=fake):
            # A bug in the desk must reach somebody who can fix it, not just
            # whoever happened to be making the request.
            with self.assertLogs("claudepost.editions", level="ERROR"):
                with self.assertRaises(Internal):
                    self.es.open_draft()

        escaped = [base for base, dirs, files in os.walk(self.dir.name)
                   if "escaped" in dirs or "escaped" in files]
        self.assertEqual(escaped, [])

    def test_sweeping_removes_the_old_and_keeps_the_new(self):
        old = self.es.open_draft()
        self.clock.advance(3601)
        new = self.es.open_draft()
        self.assertEqual(self.es.sweep_drafts(), 1)
        self.assertFalse(os.path.exists(os.path.join(self.root, "drafts", old)))
        self.assertEqual(self.es.draft_info(new)["id"], new)


class PutTest(EditionTestCase):
    def test_a_payload_over_the_cap_is_refused(self):
        d = self.es.open_draft()
        big = b'{"pad":"' + b"x" * tiles.MAX_PAYLOAD_BYTES + b'"}'
        with self.assertRaises(TooLarge):
            self.es.put_payload(d, big)

    def test_a_payload_that_is_not_json_is_refused(self):
        d = self.es.open_draft()
        for bad in (b"not json at all", b"", b'{"unterminated": '):
            with self.assertRaises(BadRequest, msg=repr(bad)):
                self.es.put_payload(d, bad)

    def test_a_payload_that_is_json_but_not_an_object_is_refused(self):
        # An edition is an object. A bare list would parse, fail every gate and
        # waste a render to say so.
        d = self.es.open_draft()
        for bad in (b"[]", b'"a string"', b"42"):
            with self.assertRaises(BadRequest, msg=repr(bad)):
                self.es.put_payload(d, bad)

    def test_a_payload_can_be_replaced_before_it_is_committed(self):
        d = self.es.open_draft()
        self.es.put_payload(d, payload(1))
        self.es.put_payload(d, payload(2))
        self.assertEqual(self.es.draft_info(d)["bytes"], len(payload(2)))

    def test_a_tile_id_that_would_become_a_path_is_refused(self):
        d = self.es.open_draft()
        for bad in ("../x", "a/b", "a.bin", "", "x" * 16):
            with self.assertRaises(BadRequest, msg=bad):
                self.es.put_tile(d, bad, b"\x00\x01")

    def test_a_tile_over_the_full_sheet_is_refused(self):
        d = self.es.open_draft()
        with self.assertRaises(TooLarge):
            self.es.put_tile(d, "pic", b"\x00" * (tiles.MAX_TILE_BYTES + 1))

    def test_one_tile_past_the_limit_is_refused(self):
        d = self.es.open_draft()
        for i in range(tiles.MAX_TILES):
            self.es.put_tile(d, f"t{i}", b"\x00\x01")
        with self.assertRaises(Conflict):
            self.es.put_tile(d, "one-more", b"\x00\x01")

    def test_replacing_a_tile_at_the_limit_is_not_one_more_tile(self):
        d = self.es.open_draft()
        for i in range(tiles.MAX_TILES):
            self.es.put_tile(d, f"t{i}", b"\x00\x01")
        self.es.put_tile(d, "t0", b"\x02\x03")      # a correction, not an addition
        self.assertEqual(len(self.es.draft_info(d)["tiles"]), tiles.MAX_TILES)


# --------------------------------------------------------------------------
# Gate 1 and gate 2
# --------------------------------------------------------------------------

class ProofTest(EditionTestCase):
    def test_a_failing_validate_never_pays_for_a_render(self):
        # The ordering rule of the whole pipeline: cheapest gate first, and the
        # expensive one is not reached when the cheap one has already answered.
        self.gates.validate_ok = False
        self.gates.output = "FAIL headline over budget"
        out = self.es.proof(self.draft())
        self.assertFalse(out["ok"])
        self.assertIn("over budget", out["validate"])
        self.assertEqual(out["render"], "")
        self.assertEqual(self.gates.calls, ["validate"])

    def test_both_gates_run_when_the_first_one_passes(self):
        out = self.es.proof(self.draft())
        self.assertTrue(out["ok"])
        self.assertEqual(self.gates.calls, ["validate", "render"])

    def test_a_failing_render_reports_but_does_not_raise(self):
        self.gates.render_ok = False
        out = self.es.proof(self.draft())
        self.assertFalse(out["ok"])
        self.assertEqual(self.gates.calls, ["validate", "render"])

    def test_the_sheets_come_back_as_basenames(self):
        # A container path in a JSON response is a disclosure for no benefit.
        self.gates.sheets = ("A1.png", "A2.png")
        out = self.es.proof(self.draft())
        self.assertEqual(out["sheets"], ["A1.png", "A2.png"])
        for name in out["sheets"]:
            self.assertNotIn("/", name)


class SheetTest(EditionTestCase):
    GATES = SheetGates

    def test_a_sheet_can_be_read_back_from_the_draft_that_made_it(self):
        d = self.draft()
        self.es.proof(d)
        self.assertEqual(self.es.read_sheet(d, "A1.png")[:8], b"\x89PNG\r\n\x1a\n")

    def test_the_sheets_follow_the_draft_into_the_edition(self):
        # The proof is the evidence somebody looked at the paper. It belongs to
        # the edition, not to the hour-long draft that produced it.
        r = self.file()
        self.assertEqual(r.state, "published")
        self.assertEqual(self.es.read_sheet(r.edition_id, "A1.png")[:4], b"\x89PNG")

    def test_a_sheet_name_that_is_a_path_reads_nothing(self):
        r = self.file()
        for bad in ("../news.json", "..", "a/b.png", "/etc/passwd", "A1.png\x00"):
            self.assertIsNone(self.es.read_sheet(r.edition_id, bad), bad)

    def test_a_sheet_nobody_wrote_reads_nothing(self):
        r = self.file()
        self.assertIsNone(self.es.read_sheet(r.edition_id, "A9.png"))
        self.assertIsNone(self.es.read_sheet("0" * 16, "A1.png"))


class NotesTest(EditionTestCase):
    """The dossier riding the commit, and the identity it must not touch.

    A note travels like a proof sheet -- copied into the edition leniently,
    kept for as long as the edition is -- with one difference that is the whole
    of this class: the paper decides its own identity and the note follows it.
    Fingerprint the note and a worker who fixed a typo in their research has
    filed a new edition, which is twenty-five seconds of the whole sheet
    flashing to report that nothing on it changed.
    """

    ONE = b"# SNDK\n\nThe fab is the story.\n"
    TWO = b"# SNDK\n\nOn reflection, the guidance was.\n"

    def noted(self, note: bytes, n: int = 1) -> str:
        """A complete draft carrying a note."""
        d = self.draft(n)
        self.es.put_draft_notes(d, note)
        return d

    def second_desk(self) -> EditionStore:
        """Another desk entirely: its own data root, its own database.

        Committing the same payload twice into one desk answers ``unchanged``
        on the second, which is a different fact from the one being asserted.
        Two desks make both commits real builds, so the ids being equal is the
        fingerprint agreeing rather than a commit declining to run.
        """
        store = Store(os.path.join(self.dir.name, "desk2.sqlite"), self.clock)
        self.addCleanup(store.close)
        return EditionStore(os.path.join(self.dir.name, "data2"),
                            self.GATES(), store, self.clock)

    def test_a_note_does_not_change_the_edition_it_describes(self):
        # The same payload and the same tile, filed twice on two desks, with a
        # note on one of them. Identical bytes on the glass, therefore one
        # edition id -- a note is evidence about the paper and not part of it.
        other = self.second_desk()

        d = other.open_draft()
        other.put_payload(d, payload(1))
        other.put_tile(d, "pic", b"\x01\x02\x03\x04")
        plain = other.commit(d, IMMEDIATE, self.clock.now())

        annotated = self.es.commit(self.noted(self.ONE), IMMEDIATE, self.clock.now())

        self.assertEqual(annotated.edition_id, plain.edition_id)
        self.assertEqual(self.es.read_edition_notes(annotated.edition_id), self.ONE)
        self.assertIsNone(other.read_edition_notes(plain.edition_id))

    def test_the_note_survives_the_draft_that_carried_it(self):
        # The draft is deleted the moment it commits, so a note that stayed
        # behind would be readable for exactly as long as nobody wanted it.
        d = self.noted(self.ONE)
        r = self.es.commit(d, IMMEDIATE, self.clock.now())

        self.assertEqual(r.state, "published")
        self.assertEqual(self.es.read_edition_notes(r.edition_id), self.ONE)
        self.assertTrue(self.es.has_notes(r.edition_id))
        self.assertIsNone(self.es.read_draft_notes(d))

    def test_an_unchanged_commit_discards_its_note(self):
        # An unchanged commit has nowhere to put anything: the edition it
        # matched is immutable and already on the glass. So the second note
        # goes with the draft, and the edition keeps the note that was filed
        # with the bytes it actually is.
        first = self.es.commit(self.noted(self.ONE), IMMEDIATE, self.clock.now())
        self.assertEqual(first.state, "published")

        again = self.es.commit(self.noted(self.TWO), IMMEDIATE, self.clock.now())
        self.assertEqual(again.state, "unchanged")
        self.assertEqual(again.edition_id, first.edition_id)
        self.assertEqual(self.es.read_edition_notes(first.edition_id), self.ONE)

    def test_a_recommit_of_a_staged_edition_discards_its_note(self):
        # The same fact one gate earlier: an edition waiting for the schedule
        # is already built and already immutable, so the second commit's note
        # has nowhere to go either.
        self.store.set_hold(T0 + 3600)
        first = self.es.commit(self.noted(self.ONE), IMMEDIATE, self.jump(T0))
        self.assertEqual(first.state, "staged")

        again = self.es.commit(self.noted(self.TWO), IMMEDIATE, self.jump(T0))
        self.assertEqual(again.state, "staged")
        self.assertEqual(again.edition_id, first.edition_id)
        self.assertEqual(self.es.read_edition_notes(first.edition_id), self.ONE)

    def test_an_edition_without_a_note_reports_so(self):
        # Nobody has to have filed one. A commit with no note is an ordinary
        # commit and the edition simply carries nothing.
        r = self.file(1)
        self.assertFalse(self.es.has_notes(r.edition_id))
        self.assertIsNone(self.es.read_edition_notes(r.edition_id))


# --------------------------------------------------------------------------
# Gate 3 — the fingerprint
# --------------------------------------------------------------------------

class FingerprintTest(EditionTestCase):
    def test_two_identical_drafts_fingerprint_identically(self):
        self.assertEqual(self.es.fingerprint(self.draft(1)),
                         self.es.fingerprint(self.draft(1)))

    def test_one_different_tile_byte_changes_it(self):
        a = self.es.fingerprint(self.draft(1, tile=b"\x01\x02\x03\x04"))
        b = self.es.fingerprint(self.draft(1, tile=b"\x01\x02\x03\x05"))
        self.assertNotEqual(a, b)

    def test_a_different_payload_changes_it(self):
        self.assertNotEqual(self.es.fingerprint(self.draft(1)),
                            self.es.fingerprint(self.draft(2)))

    def test_key_order_and_whitespace_do_not_change_it(self):
        # The fingerprint is over canonicalised JSON, so a producer that
        # re-serialises the same edition with its keys in a different order
        # does not spend twenty-five seconds of flashing to say so.
        d1 = self.es.open_draft()
        self.es.put_payload(d1, b'{"a":1,"b":[2,3]}')
        d2 = self.es.open_draft()
        self.es.put_payload(d2, b'{\n  "b" : [2, 3],\n  "a" : 1\n}')
        self.assertEqual(self.es.fingerprint(d1), self.es.fingerprint(d2))

    def test_renaming_a_tile_changes_it(self):
        # Tile ids are part of what reaches the glass -- the payload names them
        # -- so an edition that moved a picture from one id to another is a
        # different edition even when the bytes are the same.
        d1 = self.es.open_draft()
        self.es.put_payload(d1, payload(1))
        self.es.put_tile(d1, "pic", b"\x01\x02")
        d2 = self.es.open_draft()
        self.es.put_payload(d2, payload(1))
        self.es.put_tile(d2, "hero", b"\x01\x02")
        self.assertNotEqual(self.es.fingerprint(d1), self.es.fingerprint(d2))

    def test_it_is_sixteen_hex_characters_and_therefore_a_path_component(self):
        f = self.es.fingerprint(self.draft())
        self.assertEqual(len(f), 16)
        self.assertTrue(all(c in "0123456789abcdef" for c in f), f)

    def test_a_draft_with_no_payload_has_no_fingerprint(self):
        with self.assertRaises(BadRequest):
            self.es.fingerprint(self.es.open_draft())

    def test_a_policy_block_the_producer_filed_does_not_change_it(self):
        # The desk strips the block and splices its own at serve time, and the
        # firmware's news_hash() never sees it. An edition differing only by a
        # cadence its producer does not own is the same edition, and calling it
        # a different one would spend twenty-five seconds of the whole sheet
        # flashing to say so.
        plain = self.es.open_draft()
        self.es.put_payload(plain, payload(1))
        blocked = self.es.open_draft()
        self.es.put_payload(blocked, payload(1, policy={"poll_seconds": 31}))
        self.assertEqual(self.es.fingerprint(plain), self.es.fingerprint(blocked))


class SubjectMetaTest(EditionTestCase):
    """What an edition records about the company it is about.

    The paper index is derived from this and from nothing else, so the two
    things it has to survive are a producer that filed a payload before this
    field existed, and a payload whose subject is not usable as an index key.
    """

    def a_company(self, symbol="SNDK", n=1, **top):
        """A draft whose payload names a company, committed."""
        d = self.es.open_draft()
        doc = {"edition": "2026-08-19", "serial": n,
               "subject": {"symbol": symbol, "name": "Sandisk Corp."},
               "stories": [{"rank": 0, "headline": f"Story {n}"}]}
        doc.update(top)
        self.es.put_payload(d, json.dumps(doc).encode())
        return self.es.commit(d, IMMEDIATE, self.clock.now())

    def test_a_commit_records_the_symbol_and_the_language(self):
        eid = self.a_company("SNDK", lang="ko").edition_id
        meta = self.es.edition_meta(eid)
        self.assertEqual(meta["symbol"], "SNDK")
        self.assertEqual(meta["lang"], "ko")

    def test_a_payload_with_no_language_is_recorded_as_english(self):
        # `docs/news-contract.md`: absent or malformed means `en`, and the
        # device applies the same rule -- so the meta must agree with what is
        # actually printed rather than saying "unknown".
        meta = self.es.edition_meta(self.a_company("ACME").edition_id)
        self.assertEqual(meta["lang"], "en")

    def test_a_lower_case_ticker_is_recorded_upper_case(self):
        meta = self.es.edition_meta(self.a_company("sndk").edition_id)
        self.assertEqual(meta["symbol"], "SNDK")

    def test_a_payload_with_no_usable_symbol_records_none(self):
        # Not an error and not a refusal: gate 1 is what decides whether a
        # payload is an edition, and an edition the index cannot key is simply
        # not a paper for anybody.
        for bad in (None, "", "WAY-TOO-LONG-SYMBOL", "A B", 17):
            with self.subTest(symbol=bad):
                d = self.es.open_draft()
                self.es.put_payload(d, json.dumps(
                    {"serial": repr(bad), "subject": {"symbol": bad}}).encode())
                r = self.es.commit(d, IMMEDIATE, self.clock.now())
                self.assertIsNone(self.es.edition_meta(r.edition_id)["symbol"])

    def test_an_edition_filed_before_these_fields_is_filled_from_its_payload(self):
        # The migration that does not run. An edition's meta.json is its birth
        # certificate, and the one rewrite there is moves a re-filed paper's
        # created_at and adds no field to anything, so the two fields are
        # derived on the way out instead -- which is also why a pre-change
        # edition is still a paper for its company.
        eid = self.a_company("NVDA", lang="ko").edition_id
        path = os.path.join(self.root, "editions", eid, "meta.json")
        with open(path, "r+", encoding="utf-8") as f:
            doc = json.load(f)
            doc.pop("symbol")
            doc.pop("lang")
            f.seek(0)
            json.dump(doc, f)
            f.truncate()

        meta = self.es.edition_meta(eid)
        self.assertEqual(meta["symbol"], "NVDA")
        self.assertEqual(meta["lang"], "ko")

    def test_the_history_carries_the_two_fields_on_both_paths(self):
        # `edition_meta` reads a file and `list_editions` reads a database.
        # Two readers answering "which company is this" differently is the
        # bug this test exists to prevent.
        eid = self.a_company("SNDK", lang="ko").edition_id
        [row] = [r for r in self.es.list_editions() if r["id"] == eid]
        self.assertEqual((row["symbol"], row["lang"]),
                         (self.es.edition_meta(eid)["symbol"],
                          self.es.edition_meta(eid)["lang"]))

    def test_the_lead_headline_is_the_lowest_ranked_story(self):
        d = self.es.open_draft()
        self.es.put_payload(d, json.dumps({
            "subject": {"symbol": "SNDK"},
            "stories": [{"rank": 30, "headline": "A brief"},
                        {"rank": 10, "headline": "The lead"},
                        {"rank": 20, "headline": "A second"}]}).encode())
        r = self.es.commit(d, IMMEDIATE, self.clock.now())
        self.assertEqual(self.es.headline(r.edition_id), "The lead")

    def test_an_edition_with_no_stories_has_no_headline(self):
        d = self.es.open_draft()
        self.es.put_payload(d, json.dumps({"subject": {"symbol": "SNDK"}}).encode())
        r = self.es.commit(d, IMMEDIATE, self.clock.now())
        self.assertIsNone(self.es.headline(r.edition_id))

    def test_an_edition_that_is_not_there_has_no_headline(self):
        self.assertIsNone(self.es.headline("0" * 16))


class PapersTest(SubjectMetaTest):
    """Which edition is the paper for a company, and what retention may not take.

    Inherits `SubjectMetaTest`'s `a_company` helper rather than repeating it --
    a second spelling of "a draft that names a company" would be a second thing
    to keep in step with the payload shape.
    """

    def test_the_newest_edition_for_a_symbol_is_its_paper(self):
        old = self.a_company("SNDK", n=1).edition_id
        self.clock.set(T0 + 3600)
        new = self.a_company("SNDK", n=2).edition_id

        self.assertEqual(self.es.papers(["SNDK"])["SNDK"]["id"], new)
        self.assertNotEqual(old, new)

    def test_each_symbol_gets_its_own_newest(self):
        sndk = self.a_company("SNDK", n=1).edition_id
        self.clock.set(T0 + 60)
        acme = self.a_company("ACME", n=2).edition_id
        self.clock.set(T0 + 120)
        sndk2 = self.a_company("SNDK", n=3).edition_id

        found = self.es.papers(["SNDK", "ACME"])
        self.assertEqual(found["SNDK"]["id"], sndk2)
        self.assertEqual(found["ACME"]["id"], acme)
        self.assertNotEqual(sndk, sndk2)

    def test_a_symbol_with_no_edition_answers_none_rather_than_being_dropped(self):
        # The pager draws a "not written yet" row from this, so a key that is
        # missing and a key that is None are different answers to it.
        self.a_company("SNDK")
        found = self.es.papers(["SNDK", "NVDA"])
        self.assertIn("NVDA", found)
        self.assertIsNone(found["NVDA"])

    def test_asking_for_nothing_answers_nothing(self):
        self.a_company("SNDK")
        self.assertEqual(self.es.papers([]), {})

    def test_an_edition_the_index_cannot_key_belongs_to_no_symbol(self):
        d = self.es.open_draft()
        self.es.put_payload(d, json.dumps({"serial": 9, "subject": {}}).encode())
        self.es.commit(d, IMMEDIATE, self.clock.now())
        self.assertIsNone(self.es.papers([""])[""])

    def test_retention_never_takes_a_watched_company_s_paper(self):
        # The pager's whole promise. Without this the newest edition about a
        # company on the watchlist ages out behind the board's own run of
        # editions, and the row goes blank with nothing to explain it.
        sndk = self.a_company("SNDK", n=0).edition_id
        for n in range(1, 6):
            self.clock.set(T0 + n * 60)
            self.a_company("ACME", n=n)

        self.assertEqual(self.es.prune(keep=1, symbols=["SNDK", "ACME"]), 4)
        self.assertIsNotNone(self.es.read_payload(sndk))
        self.assertEqual(self.es.papers(["SNDK"])["SNDK"]["id"], sndk)

    def test_a_company_that_left_the_watchlist_ages_out_normally(self):
        sndk = self.a_company("SNDK", n=0).edition_id
        for n in range(1, 6):
            self.clock.set(T0 + n * 60)
            self.a_company("ACME", n=n)

        # ACME only. SNDK's paper has lost its protection and is old history.
        self.assertEqual(self.es.prune(keep=1, symbols=["ACME"]), 5)
        self.assertIsNone(self.es.read_payload(sndk))

    def test_protecting_nothing_is_what_prune_did_before(self):
        for n in range(5):
            self.clock.set(T0 + n * 60)
            self.a_company("ACME", n=n)
        self.assertEqual(self.es.prune(keep=2), 3)


class PaperCommitTest(SubjectMetaTest):
    """Filing a newspaper that is not for the glass.

    Everything the board's own commit does, minus the schedule gate and both
    pointer writes. The one new refusal is the wall: the index is keyed by the
    payload's own subject, so a model that drifted to another company would
    file its paper under the name the desk asked for and nobody would ever see
    the two disagree.
    """

    def paper(self, symbol="SNDK", n=1, commit_as=None, **top):
        """A draft naming ``symbol``, committed as a paper for ``commit_as``."""
        d = self.es.open_draft()
        doc = {"edition": "2026-08-19", "serial": n,
               "subject": {"symbol": symbol, "name": "Sandisk Corp."},
               "stories": [{"rank": 0, "headline": f"Story {n}"}]}
        doc.update(top)
        self.es.put_payload(d, json.dumps(doc).encode())
        return self.es.commit(d, IMMEDIATE, self.clock.now(),
                              target="paper",
                              symbol=commit_as or symbol)

    def test_a_paper_commit_files_an_edition_and_says_so(self):
        r = self.paper()
        self.assertEqual(r.state, "paper")
        self.assertEqual(self.es.papers(["SNDK"])["SNDK"]["id"], r.edition_id)
        self.assertIsNotNone(self.es.read_payload(r.edition_id))

    def test_it_writes_neither_pointer(self):
        board = self.a_company("ACME", n=0).edition_id
        r = self.paper("SNDK", n=1)
        self.assertEqual(self.es.current_id(), board)
        self.assertIsNone(self.es.staged_id())
        self.assertNotEqual(r.edition_id, board)

    def test_it_is_not_a_publish_and_does_not_restart_the_minimum_gap(self):
        # A paper never reaches the glass, so counting it as a publish would
        # make the board's own next edition wait behind a page nobody saw.
        self.paper()
        self.assertIsNone(self.es._store.last_publish_at())

    def test_it_records_no_published_at(self):
        r = self.paper()
        self.assertIsNone(self.es.edition_meta(r.edition_id)["published_at"])

    def test_the_schedule_gate_does_not_apply(self):
        # The one gate a paper skips. A quiet window is about what may appear
        # on the wall, and a paper appears on nobody's wall.
        quiet = sched(quiet=[{"from": "00:00", "to": "23:59"}], wake=[],
                      publish={"policy": "manual", "min_gap_minutes": 600})
        d = self.es.open_draft()
        self.es.put_payload(d, json.dumps(
            {"serial": 7, "subject": {"symbol": "SNDK"}}).encode())
        r = self.es.commit(d, quiet, self.clock.now(),
                           target="paper", symbol="SNDK")
        self.assertEqual(r.state, "paper")

    def test_a_failing_gate_still_refuses_a_paper(self):
        self.gates.validate_ok = False
        d = self.es.open_draft()
        self.es.put_payload(d, json.dumps(
            {"subject": {"symbol": "SNDK"}}).encode())
        with self.assertRaises(BadRequest) as caught:
            self.es.commit(d, IMMEDIATE, self.clock.now(),
                           target="paper", symbol="SNDK")
        self.assertEqual(caught.exception.code, "gate_failed")

    def test_an_unchanged_paper_is_unchanged(self):
        first = self.paper("SNDK", n=1)
        again = self.paper("SNDK", n=1)
        self.assertEqual(again.state, "unchanged")
        self.assertEqual(again.edition_id, first.edition_id)

    def test_the_fingerprint_gate_looks_at_the_symbol_and_not_at_the_board(self):
        # The board is showing SNDK. A paper about SNDK with different copy is
        # a change; the comparison that matters is against SNDK's own newest
        # paper, not against whatever happens to be on the glass.
        board = self.a_company("ACME", n=0).edition_id
        first = self.paper("SNDK", n=1)
        second = self.paper("SNDK", n=2)
        self.assertEqual(second.state, "paper")
        self.assertNotEqual(second.edition_id, first.edition_id)
        self.assertEqual(self.es.current_id(), board)

    def test_a_paper_identical_to_what_is_on_the_board_is_unchanged(self):
        # Same bytes, same id, already on disk: there is nowhere for the draft
        # to go, whichever pointer happens to name it.
        d = self.es.open_draft()
        raw = json.dumps({"serial": 4, "subject": {"symbol": "SNDK"}}).encode()
        self.es.put_payload(d, raw)
        board = self.es.commit(d, IMMEDIATE, self.clock.now())
        self.assertEqual(board.state, "published")

        d2 = self.es.open_draft()
        self.es.put_payload(d2, raw)
        again = self.es.commit(d2, IMMEDIATE, self.clock.now(),
                               target="paper", symbol="SNDK")
        self.assertEqual(again.state, "unchanged")
        self.assertEqual(again.edition_id, board.edition_id)

    def test_a_draft_about_another_company_is_refused(self):
        with self.assertRaises(Conflict) as caught:
            self.paper(symbol="ACME", commit_as="SNDK")
        self.assertEqual(caught.exception.code, "commit_symbol_mismatch")
        self.assertIn("ACME", caught.exception.message)
        self.assertIn("SNDK", caught.exception.message)

    def test_a_refused_paper_files_nothing(self):
        board = self.a_company("SNDK", n=0).edition_id
        with self.assertRaises(Conflict):
            self.paper(symbol="ACME", commit_as="SNDK")
        self.assertIsNone(self.es.papers(["ACME"])["ACME"])
        self.assertEqual(self.es.current_id(), board)

    def test_a_draft_with_no_usable_subject_is_refused_as_a_mismatch(self):
        d = self.es.open_draft()
        self.es.put_payload(d, json.dumps({"serial": 3}).encode())
        with self.assertRaises(Conflict) as caught:
            self.es.commit(d, IMMEDIATE, self.clock.now(),
                           target="paper", symbol="SNDK")
        self.assertEqual(caught.exception.code, "commit_symbol_mismatch")

    def test_a_paper_commit_with_no_symbol_is_refused(self):
        d = self.es.open_draft()
        self.es.put_payload(d, json.dumps(
            {"subject": {"symbol": "SNDK"}}).encode())
        with self.assertRaises(BadRequest) as caught:
            self.es.commit(d, IMMEDIATE, self.clock.now(), target="paper")
        self.assertEqual(caught.exception.code, "commit_needs_symbol")

    def test_an_unknown_target_is_refused(self):
        d = self.es.open_draft()
        self.es.put_payload(d, payload(1))
        with self.assertRaises(BadRequest):
            self.es.commit(d, IMMEDIATE, self.clock.now(), target="glass")

    def test_the_board_target_is_exactly_what_a_commit_did_before(self):
        by_default = self.file(1)
        self.assertEqual(by_default.state, "published")
        d = self.es.open_draft()
        self.es.put_payload(d, payload(2))
        self.es.put_tile(d, "pic", b"\x01\x02\x03\x04")
        named = self.es.commit(d, IMMEDIATE, self.clock.now(), target="board")
        self.assertEqual(named.state, "published")
        self.assertEqual(self.es.current_id(), named.edition_id)

    def test_a_successful_paper_consumes_its_draft(self):
        d = self.es.open_draft()
        self.es.put_payload(d, json.dumps(
            {"serial": 5, "subject": {"symbol": "SNDK"}}).encode())
        self.es.commit(d, IMMEDIATE, self.clock.now(),
                       target="paper", symbol="SNDK")
        with self.assertRaises(NotFound):
            self.es.draft_info(d)

    def test_re_filing_an_older_paper_makes_it_the_paper_again(self):
        # The index has no pointer -- it picks by created_at -- so a re-filing
        # that kept its original date would leave the desk answering "paper A"
        # to the worker that just filed A while the index went on showing B.
        a = self.paper("SNDK", n=1)
        self.clock.set(T0 + 60)
        b = self.paper("SNDK", n=2)
        self.assertEqual(self.es.papers(["SNDK"])["SNDK"]["id"], b.edition_id)

        self.clock.set(T0 + 120)
        again = self.paper("SNDK", n=1)
        self.assertEqual(again.state, "paper")
        self.assertEqual(again.edition_id, a.edition_id)
        self.assertEqual(self.es.papers(["SNDK"])["SNDK"]["id"], a.edition_id)

        # Disk and store agree about the new date, which is what keeps the
        # history and retention in the same order.
        self.assertEqual(
            self.es.edition_meta(a.edition_id)["created_at"], T0 + 120)
        self.assertEqual(
            self.store.get_edition(a.edition_id)["created_at"], T0 + 120)

    def test_a_redate_does_not_freeze_a_derived_field_onto_disk(self):
        # `edition_meta` fills `symbol`/`lang` in from the stored payload for
        # an edition that predates those fields -- a read, not a write. A
        # `_redate` that wrote that filled copy back would turn a payload that
        # merely happened to be unreadable at this instant into a permanent
        # `"symbol": null`, which `_filled`'s own membership check would then
        # treat as recorded forever, dropping the edition out of the paper
        # index for good.
        first = self.paper("SNDK", n=1)
        path = os.path.join(self.root, "editions", first.edition_id, "meta.json")
        with open(path, "r+", encoding="utf-8") as f:
            doc = json.load(f)
            doc.pop("symbol")
            doc.pop("lang")
            f.seek(0)
            json.dump(doc, f)
            f.truncate()

        # A second paper for SNDK, so re-filing the first below is a change
        # against SNDK's current newest rather than the `unchanged` path --
        # exactly the shape `test_re_filing_an_older_paper_makes_it_the_paper_
        # again` uses, and the one that actually reaches `_redate`.
        self.clock.set(T0 + 60)
        self.paper("SNDK", n=2)

        self.clock.set(T0 + 120)
        again = self.paper("SNDK", n=1)
        self.assertEqual(again.state, "paper")
        self.assertEqual(again.edition_id, first.edition_id)

        # The re-date happened -- `created_at` moved -- but it wrote back
        # exactly the (stripped) document that was on disk, not the filled one.
        with open(path, encoding="utf-8") as f:
            on_disk = json.load(f)
        self.assertNotIn("symbol", on_disk)
        self.assertNotIn("lang", on_disk)
        self.assertEqual(on_disk["created_at"], T0 + 120)

        # The lazy fill still runs on the way out.
        meta = self.es.edition_meta(first.edition_id)
        self.assertEqual(meta["symbol"], "SNDK")

    def test_a_redate_repairs_a_meta_json_that_will_not_parse(self):
        # `meta.json` unreadable at the moment of a re-file is not merely
        # "no derived field to write" -- it is nothing on disk worth
        # preserving at all. `_redate`'s fallback then writes this commit's
        # own freshly built document (byte-identical in content to the
        # edition it is redating, because an edition id is its content
        # fingerprint) so disk and store move together instead of disk
        # keeping the old date while the store takes the new one.
        first = self.paper("SNDK", n=1)
        path = os.path.join(self.root, "editions", first.edition_id, "meta.json")
        with open(path, "w", encoding="utf-8") as f:
            f.write("not json at all {{{")

        self.clock.set(T0 + 60)
        self.paper("SNDK", n=2)

        self.clock.set(T0 + 120)
        again = self.paper("SNDK", n=1)
        self.assertEqual(again.state, "paper")
        self.assertEqual(again.edition_id, first.edition_id)

        # Disk and store agree -- that is the property under test, not either
        # value in particular.
        with open(path, encoding="utf-8") as f:
            on_disk = json.load(f)
        row = self.store.get_edition(first.edition_id)
        self.assertEqual(on_disk["created_at"], row["created_at"])
        self.assertEqual(on_disk["created_at"], T0 + 120)

        # The repair also recovers the edition's symbol from bytes this
        # commit already holds, rather than leaving it unreadable forever.
        self.assertEqual(self.es.edition_meta(first.edition_id)["symbol"],
                         "SNDK")

    def test_a_re_dated_paper_keeps_the_fact_that_it_reached_the_glass(self):
        # published_at is a fact about the past. Re-filing changes which paper
        # is newest, not whether this edition was ever on the wall.
        d = self.es.open_draft()
        raw = json.dumps({"serial": 8, "subject": {"symbol": "SNDK"}}).encode()
        self.es.put_payload(d, raw)
        board = self.es.commit(d, IMMEDIATE, self.clock.now())
        self.assertEqual(
            self.es.edition_meta(board.edition_id)["published_at"], T0)

        # Another paper for SNDK, so re-filing the first is a change rather
        # than the `duplicate` path.
        self.clock.set(T0 + 60)
        self.paper("SNDK", n=9)

        self.clock.set(T0 + 120)
        d2 = self.es.open_draft()
        self.es.put_payload(d2, raw)
        again = self.es.commit(d2, IMMEDIATE, self.clock.now(),
                               target="paper", symbol="SNDK")
        self.assertEqual(again.state, "paper")
        self.assertEqual(again.edition_id, board.edition_id)

        meta = self.es.edition_meta(board.edition_id)
        self.assertEqual(meta["created_at"], T0 + 120)
        self.assertEqual(meta["published_at"], T0)
        self.assertEqual(
            self.store.get_edition(board.edition_id)["published_at"], T0)

    def test_the_board_path_does_not_re_date_an_edition_filed_again(self):
        # The other half of the asymmetry. `current` and `staged` say which
        # edition is the board's, so a date decides nothing there and an
        # edition filed again keeps the day it was born.
        first = self.file(1)
        self.file(2, now=self.jump(T0 + 60))
        again = self.es.commit(self.draft(1), IMMEDIATE, self.jump(T0 + 120))
        self.assertEqual(again.edition_id, first.edition_id)
        self.assertEqual(again.state, "published")
        self.assertEqual(
            self.es.edition_meta(first.edition_id)["created_at"], T0)
        self.assertEqual(
            self.store.get_edition(first.edition_id)["created_at"], T0)


class ReasonKeywordTest(unittest.TestCase):
    """The invariant the REASON block states about itself, asserted.

    "Each carries its own keyword and none contains another's" is what makes
    `assertIn("quiet", r.reason)` further down a real assertion rather than a
    coincidence, and it is the kind of claim a comment loses quietly: the next
    reason somebody writes opens with a word already in one of these and every
    test still passes. Swept off the module rather than written as a list, so
    a reason added without reading this is checked anyway.
    """

    def reasons(self) -> dict:
        return {name: getattr(E, name) for name in dir(E)
                if name.startswith("REASON_")}

    def keyword(self, text: str) -> str:
        """A reason's keyword: what it says before the colon, or all of it."""
        return text.split(":")[0].strip()

    def test_the_sweep_finds_the_block(self):
        # A floor rather than a count, so adding a reason does not edit this
        # test -- but a sweep that silently matched nothing would make every
        # assertion below vacuously true.
        found = self.reasons()
        self.assertGreater(len(found), 8)
        self.assertIn("REASON_PAPER", found)
        self.assertIn("REASON_UNCHANGED_PAPER", found)

    def test_every_reason_has_a_keyword(self):
        for name, text in self.reasons().items():
            self.assertTrue(self.keyword(text), f"{name} has no keyword")

    def test_no_keyword_appears_inside_another_reason(self):
        found = self.reasons()
        for name, text in found.items():
            word = self.keyword(text)
            for other, other_text in found.items():
                if other == name:
                    continue
                self.assertNotIn(
                    word, other_text,
                    f"{name}'s keyword {word!r} is inside {other}")


# --------------------------------------------------------------------------
# Gate 5 — the swap, and what a failure must not touch
# --------------------------------------------------------------------------

class CommitTest(EditionTestCase):
    def test_a_committed_edition_is_served_whole(self):
        r = self.file(1)
        self.assertEqual(r.state, "published")
        self.assertEqual(self.es.current_id(), r.edition_id)
        self.assertEqual(self.es.read_payload(r.edition_id), payload(1))
        self.assertEqual(self.es.read_tile(r.edition_id, "pic"), b"\x01\x02\x03\x04")

    def test_a_failing_gate_leaves_the_current_edition_untouched(self):
        """The rule news_parse() follows, restated one layer up.

        A rejected payload never touches ``*out`` on the device and a rejected
        draft never touches ``current`` here. Asserted over the bytes, not over
        the id: an id that did not move while the directory under it did would
        be the worst version of this passing.
        """
        first = self.file(1)
        before_id = self.es.current_id()
        before_payload = self.es.read_payload(before_id)
        before_tile = self.es.read_tile(before_id, "pic")
        self.assertEqual(before_id, first.edition_id)

        for validate_ok, render_ok in ((False, True), (True, False)):
            self.gates.validate_ok, self.gates.render_ok = validate_ok, render_ok
            self.gates.calls.clear()
            d = self.draft(2, tile=b"\x09\x09\x09\x09")
            with self.assertRaises(BadRequest):
                self.es.commit(d, IMMEDIATE, self.clock.now())

            self.assertEqual(self.es.current_id(), before_id)
            self.assertEqual(self.es.read_payload(before_id), before_payload)
            self.assertEqual(self.es.read_tile(before_id, "pic"), before_tile)
            self.assertIsNone(self.es.staged_id())
            self.assertIsNone(self.store.get_edition(self.es.fingerprint(d)))

    def test_a_failed_commit_leaves_the_draft_alone_to_be_fixed(self):
        # The producer is an agent that has to correct its own copy. Throwing
        # the draft away would make it re-upload every tile to change a
        # headline.
        self.gates.validate_ok = False
        d = self.draft()
        with self.assertRaises(BadRequest):
            self.es.commit(d, IMMEDIATE, self.clock.now())
        self.assertEqual(self.es.draft_info(d)["id"], d)

    def test_a_successful_commit_consumes_the_draft(self):
        # The edition directory is the durable copy and can be promoted again,
        # so keeping the draft is holding the same bytes twice against a limit
        # of eight.
        d = self.draft()
        self.es.commit(d, IMMEDIATE, self.clock.now())
        with self.assertRaises(NotFound):
            self.es.draft_info(d)

    def test_more_editions_than_there_are_draft_slots_can_be_filed(self):
        for i in range(tiles.MAX_DRAFTS + 4):
            self.assertEqual(self.file(i).state, "published")

    def test_the_gate_output_comes_back_with_the_refusal(self):
        self.gates.validate_ok = False
        self.gates.output = "FAIL stories[0].headline: 81 characters, budget 72"
        with self.assertRaises(BadRequest) as e:
            self.es.commit(self.draft(), IMMEDIATE, self.clock.now())
        self.assertIn("budget 72", str(e.exception))

    def test_a_draft_with_no_payload_is_refused_before_a_gate_is_paid_for(self):
        with self.assertRaises(BadRequest):
            self.es.commit(self.es.open_draft(), IMMEDIATE, self.clock.now())
        self.assertEqual(self.gates.calls, [])

    def test_committing_the_same_edition_twice_changes_nothing(self):
        first = self.file(1)
        pointer = os.path.join(self.root, "current")
        stamp = os.stat(pointer).st_mtime_ns

        again = self.es.commit(self.draft(1), IMMEDIATE, self.jump(T0 + 600))
        self.assertEqual(again.state, "unchanged")
        self.assertEqual(again.edition_id, first.edition_id)
        self.assertEqual(self.es.current_id(), first.edition_id)
        self.assertEqual(os.stat(pointer).st_mtime_ns, stamp)
        # An unchanged commit is not a publish, so it must not restart the gap.
        self.assertEqual(self.store.last_publish_at(), T0)

    def test_a_producers_own_policy_block_is_recorded_as_dropped(self):
        d = self.es.open_draft()
        self.es.put_payload(d, payload(1, policy={"poll_seconds": 31}))
        r = self.es.commit(d, IMMEDIATE, self.clock.now())
        self.assertTrue(self.es.edition_meta(r.edition_id)["dropped_producer_policy"])

    def test_an_edition_without_one_is_recorded_as_not_dropped(self):
        r = self.file()
        meta = self.es.edition_meta(r.edition_id)
        self.assertFalse(meta["dropped_producer_policy"])
        self.assertEqual(meta["tile_count"], 1)
        self.assertEqual(meta["bytes"], len(payload(1)))
        self.assertEqual(meta["published_at"], T0)

    def test_the_edition_is_recorded_in_the_store(self):
        r = self.file(1, now=self.jump(T0))
        self.assertEqual(self.store.get_edition(r.edition_id)["id"], r.edition_id)
        self.assertEqual(self.store.last_publish_at(), T0)

    def test_what_is_stored_carries_no_policy_block(self):
        # The cadence is the owner's schedule and the desk splices it per
        # request, so a producer's own block is dropped rather than served.
        d = self.es.open_draft()
        self.es.put_payload(d, payload(1, policy={"poll_seconds": 31}))
        r = self.es.commit(d, IMMEDIATE, self.clock.now())

        served = json.loads(self.es.read_payload(r.edition_id))
        self.assertNotIn("policy", served)
        self.assertEqual(served["serial"], 1)

    def test_a_temp_file_left_among_the_tiles_is_not_a_tile(self):
        # A crash mid-write leaves one of these. It is not a picture, and a
        # fingerprint or a count that took it for one would make an edition
        # that differs from itself. Both shapes are here on purpose: the suffix
        # is one filter and the id is the other, and either alone lets one of
        # these through.
        d = self.draft()
        tiles_dir = os.path.join(self.root, "drafts", d, "tiles")
        for leftover in (".claudepost-half.tmp", ".claudepost-half.bin"):
            with open(os.path.join(tiles_dir, leftover), "wb") as f:
                f.write(b"\x00\x01\x02\x03")

        self.assertEqual(self.es.draft_info(d)["tiles"], ["pic"])
        r = self.es.commit(d, IMMEDIATE, self.clock.now())
        self.assertEqual(self.es.edition_meta(r.edition_id)["tile_count"], 1)
        self.assertIsNotNone(self.es.read_tile(r.edition_id, "pic"))

    def test_an_edition_filed_again_reuses_the_directory_it_already_has(self):
        # The id is the content, so there is nothing a rebuild could add -- and
        # the directory it would rewrite is one a reader may be inside.
        first = self.file(1)
        self.file(2, now=self.jump(T0 + 60))
        news = os.path.join(self.root, "editions", first.edition_id, "news.json")
        stamp = os.stat(news).st_mtime_ns

        again = self.es.commit(self.draft(1), IMMEDIATE, self.jump(T0 + 120))
        self.assertEqual(again.edition_id, first.edition_id)
        self.assertEqual(again.state, "published")
        self.assertEqual(os.stat(news).st_mtime_ns, stamp)
        self.assertEqual(self.es.read_payload(first.edition_id), payload(1))

        # And the store's copy is the same birth certificate as the disk's.
        # On this path meta.json is written once and never rewritten -- only a
        # paper filed again moves a created_at, and this is the board -- so a
        # store row that took the *second* filing's created_at would make the
        # history (ordered from the store) and retention (ordered from disk)
        # disagree about which edition is the oldest.
        on_disk = self.es.edition_meta(first.edition_id)
        self.assertEqual(on_disk["created_at"], T0)
        self.assertEqual(self.store.get_edition(first.edition_id)["created_at"], T0)
        self.assertEqual(self.store.get_edition(first.edition_id)["source"],
                         on_disk["source"])

    def test_a_tile_that_cannot_be_read_fails_the_commit_rather_than_the_edition(self):
        # Reads answer None on the serving path; a write must not. An edition
        # is immutable, so a tile quietly dropped here is an edition whose id
        # promises a picture that is not in it, for as long as it is kept --
        # and it would fingerprint identically to one with an empty tile.
        first = self.file(1)
        d = self.draft(2)
        tile = os.path.join(self.root, "drafts", d, "tiles", "pic.bin")
        os.chmod(tile, 0)
        self.addCleanup(os.chmod, tile, 0o600)
        if os.access(tile, os.R_OK):
            self.skipTest("this user's file modes do not stop a read")

        with self.assertRaises(OSError):
            self.es.commit(d, IMMEDIATE, self.jump(T0 + 60))

        self.assertEqual(self.es.current_id(), first.edition_id)
        self.assertEqual(self.es.read_payload(first.edition_id), payload(1))
        self.assertEqual(os.listdir(os.path.join(self.root, "editions")),
                         [first.edition_id])


# --------------------------------------------------------------------------
# Gate 4 — the schedule
# --------------------------------------------------------------------------

class QuietTest(EditionTestCase):
    def test_a_commit_inside_a_quiet_window_stages_and_goes_up_at_the_boundary(self):
        # The default schedule: quiet 00:30 to 06:00, and 06:00 is also a wake.
        r = self.es.commit(self.draft(1), S.DEFAULT_SCHEDULE,
                           self.jump(at(2026, 8, 19, 1, 0)))
        self.assertEqual(r.state, "staged")
        self.assertIn("quiet", r.reason)
        self.assertIsNone(self.es.current_id())
        self.assertEqual(self.es.staged_id(), r.edition_id)

        self.assertIsNone(self.es.publish_due(S.DEFAULT_SCHEDULE,
                                              self.jump(at(2026, 8, 19, 5, 59))))
        self.assertIsNone(self.es.current_id())

        out = self.es.publish_due(S.DEFAULT_SCHEDULE,
                                  self.jump(at(2026, 8, 19, 6, 0)))
        self.assertIsNotNone(out)
        self.assertEqual(out.state, "published")
        self.assertEqual(self.es.current_id(), r.edition_id)
        self.assertIsNone(self.es.staged_id())

    def test_a_staged_reason_names_an_hour_a_person_can_read(self):
        # `reason` is prose for a person -- it comes back as the commit's
        # answer and again in the worker's failure report -- and "nothing new
        # becomes current until 1787086800" is not something anybody can act
        # on. The desk already knows the zone the schedule reasons in, so the
        # instant is written in it: 06:00 KST, not 21:00 UTC and not whatever
        # TZ the container happens to carry.
        r = self.es.commit(self.draft(1), S.DEFAULT_SCHEDULE,
                           self.jump(at(2026, 8, 19, 1, 0)))
        self.assertEqual(r.state, "staged")
        self.assertIn("quiet", r.reason)
        self.assertIn("2026-08-19 06:00 KST", r.reason)
        self.assertNotIn(str(int(at(2026, 8, 19, 6, 0))), r.reason)

    def test_a_quiet_window_does_not_stop_a_page_that_is_already_up(self):
        # Quiet means nothing NEW becomes current, not that the URL goes quiet.
        self.file(1)
        eid = self.es.current_id()
        self.es.publish_due(S.DEFAULT_SCHEDULE, self.jump(at(2026, 8, 19, 1, 0)))
        self.assertEqual(self.es.read_payload(self.es.current_id()), payload(1))
        self.assertEqual(self.es.current_id(), eid)


class GapTest(EditionTestCase):
    SCHEDULE = sched(quiet=[], wake=[],
                     publish={"policy": "immediate", "min_gap_minutes": 60})

    def test_a_second_commit_inside_the_gap_is_deferred_and_released_after_it(self):
        # A refresh is twenty-five seconds of the whole sheet flashing, so the
        # floor is the difference between a newspaper and something that blinks
        # at nobody all afternoon.
        first = self.es.commit(self.draft(1), self.SCHEDULE, self.jump(T0))
        self.assertEqual(first.state, "published")

        second = self.es.commit(self.draft(2), self.SCHEDULE, self.jump(T0 + 600))
        self.assertEqual(second.state, "staged")
        self.assertIn("gap", second.reason)
        self.assertEqual(self.es.current_id(), first.edition_id)

        self.assertIsNone(self.es.publish_due(self.SCHEDULE, self.jump(T0 + 3599)))
        out = self.es.publish_due(self.SCHEDULE, self.jump(T0 + 3600))
        self.assertEqual(out.edition_id, second.edition_id)
        self.assertEqual(self.es.current_id(), second.edition_id)


class OnWakeTest(EditionTestCase):
    SCHEDULE = sched(quiet=[], publish={"policy": "on_wake", "min_gap_minutes": 0})

    def test_a_commit_after_a_wake_waits_for_the_next_one(self):
        # The paper arrives at times the reader can learn. An agent woken at
        # 06:00 and filing at 06:14 goes up at 12:40, and that is the policy
        # rather than a delay to be shaved.
        r = self.es.commit(self.draft(1), self.SCHEDULE,
                           self.jump(at(2026, 8, 19, 6, 14)))
        self.assertEqual(r.state, "staged")
        self.assertIn("wake", r.reason)

        self.assertIsNone(self.es.publish_due(self.SCHEDULE,
                                              self.jump(at(2026, 8, 19, 12, 39))))
        out = self.es.publish_due(self.SCHEDULE, self.jump(at(2026, 8, 19, 12, 40)))
        self.assertEqual(out.edition_id, r.edition_id)
        self.assertEqual(self.es.current_id(), r.edition_id)


class ManualTest(EditionTestCase):
    SCHEDULE = sched(quiet=[], wake=[],
                     publish={"policy": "manual", "min_gap_minutes": 0})

    def test_nothing_publishes_on_its_own_and_the_button_still_works(self):
        r = self.es.commit(self.draft(1), self.SCHEDULE, self.jump(T0))
        self.assertEqual(r.state, "staged")
        for hours in (1, 6, 24):
            self.assertIsNone(self.es.publish_due(self.SCHEDULE,
                                                  self.jump(T0 + hours * 3600)))
        self.assertIsNone(self.es.current_id())

        out = self.es.publish_now("operator asked for it")
        self.assertEqual(out.edition_id, r.edition_id)
        self.assertEqual(self.es.current_id(), r.edition_id)
        self.assertIsNone(self.es.staged_id())

    def test_publishing_by_hand_with_nothing_staged_does_nothing(self):
        self.assertIsNone(self.es.publish_now("nothing to do"))


class HoldTest(EditionTestCase):
    def test_a_hold_defers_even_an_immediate_publish(self):
        # A rule you cannot override is a rule you end up editing at midnight,
        # so the hold outranks the schedule rather than sitting beside it.
        self.store.set_hold(T0 + 3600)
        r = self.es.commit(self.draft(1), IMMEDIATE, self.jump(T0))
        self.assertEqual(r.state, "staged")
        self.assertIn("hold", r.reason)
        self.assertIsNone(self.es.current_id())

        self.assertIsNone(self.es.publish_due(IMMEDIATE, self.jump(T0 + 3599)))
        out = self.es.publish_due(IMMEDIATE, self.jump(T0 + 3601))
        self.assertEqual(out.edition_id, r.edition_id)

    def test_the_operator_override_beats_a_hold(self):
        self.store.set_hold(T0 + 3600)
        r = self.es.commit(self.draft(1), IMMEDIATE, self.jump(T0))
        self.assertEqual(self.es.publish_now("standing here").edition_id,
                         r.edition_id)
        self.assertEqual(self.es.current_id(), r.edition_id)


class PublishDueTest(EditionTestCase):
    def test_nothing_staged_is_nothing_to_publish(self):
        self.assertIsNone(self.es.publish_due(IMMEDIATE, self.clock.now()))
        self.file(1)
        self.assertIsNone(self.es.publish_due(IMMEDIATE, self.clock.now()))

    def test_what_is_already_current_is_not_published_a_second_time(self):
        # A crash between the two pointer writes leaves both naming the same
        # edition. The page is already up; publishing it again would be
        # twenty-five seconds of the whole sheet flashing to change nothing,
        # and it would restart the floor between publishes on top.
        r = self.file(1)
        with open(os.path.join(self.root, "staged"), "w") as f:
            f.write(r.edition_id + "\n")

        self.assertIsNone(self.es.publish_due(IMMEDIATE, self.jump(T0 + 3600)))
        self.assertIsNone(self.es.staged_id())
        self.assertEqual(self.es.current_id(), r.edition_id)
        self.assertEqual(self.store.last_publish_at(), T0)

    def test_a_staged_edition_that_is_no_longer_on_disk_is_left_staged(self):
        # Retention protects both pointers, so a staged edition with no
        # directory is a disk somebody went at by hand. The pointer is the
        # record of what the desk was told to put up: it stays, nothing is
        # published, and the tick says so ONCE -- publish_due runs every few
        # seconds forever, and a warning per tick buries the one that matters.
        self.store.set_hold(T0 + 3600)
        r = self.es.commit(self.draft(1), IMMEDIATE, self.jump(T0))
        self.assertEqual(r.state, "staged")
        shutil.rmtree(os.path.join(self.root, "editions", r.edition_id))

        with self.assertLogs("claudepost.editions", "WARNING") as caught:
            self.assertIsNone(self.es.publish_due(IMMEDIATE, self.jump(T0 + 3601)))
            self.assertIsNone(self.es.publish_due(IMMEDIATE, self.jump(T0 + 3602)))
        self.assertEqual(len(caught.output), 1, caught.output)
        self.assertEqual(self.es.staged_id(), r.edition_id)
        self.assertIsNone(self.es.current_id())


# --------------------------------------------------------------------------
# Promotion, retention
# --------------------------------------------------------------------------

class PromoteTest(EditionTestCase):
    def test_an_older_edition_becomes_current_again_with_its_own_tiles(self):
        first = self.file(1, tile=b"\xaa\xaa\xaa\xaa")
        second = self.file(2, now=self.jump(T0 + 60), tile=b"\xbb\xbb\xbb\xbb")
        self.assertEqual(self.es.current_id(), second.edition_id)

        out = self.es.promote(first.edition_id)
        self.assertEqual(out.state, "published")
        self.assertEqual(self.es.current_id(), first.edition_id)
        self.assertEqual(self.es.read_payload(self.es.current_id()), payload(1))
        self.assertEqual(self.es.read_tile(self.es.current_id(), "pic"),
                         b"\xaa\xaa\xaa\xaa")

    def test_promoting_what_is_already_current_changes_nothing(self):
        first = self.file(1)
        self.assertEqual(self.es.promote(first.edition_id).state, "unchanged")
        self.assertEqual(self.es.current_id(), first.edition_id)

    def test_promoting_an_edition_nobody_filed_is_not_found(self):
        for bad in ("0" * 16, "../drafts", "not-hex", "", "a" * 65):
            with self.assertRaises(NotFound, msg=bad):
                self.es.promote(bad)

    def test_promoting_the_staged_edition_is_what_clears_it(self):
        # Promoting something else must leave the staged edition waiting -- the
        # operator put yesterday's paper back up, they did not cancel tonight's.
        # Promoting the staged one is the same act as publishing it, so the
        # pointer that says it is still waiting has to go.
        manual = sched(quiet=[], wake=[],
                       publish={"policy": "manual", "min_gap_minutes": 0})
        older = self.es.commit(self.draft(1), IMMEDIATE, self.jump(T0))
        self.es.commit(self.draft(2), IMMEDIATE, self.jump(T0 + 60))
        staged = self.es.commit(self.draft(3), manual, self.jump(T0 + 120))
        self.assertEqual(staged.state, "staged")

        # A real promotion -- `older` is not what is current -- so this goes
        # through the same pointer write that a publish does.
        self.assertEqual(self.es.promote(older.edition_id).state, "published")
        self.assertEqual(self.es.staged_id(), staged.edition_id)

        out = self.es.promote(staged.edition_id)
        self.assertEqual(out.state, "published")
        self.assertEqual(self.es.current_id(), staged.edition_id)
        self.assertIsNone(self.es.staged_id())


class PruneTest(EditionTestCase):
    def test_it_keeps_the_current_and_the_staged_edition_however_old(self):
        manual = sched(quiet=[], wake=[],
                       publish={"policy": "manual", "min_gap_minutes": 0})
        staged = self.es.commit(self.draft(0), manual, self.jump(T0))
        self.assertEqual(staged.state, "staged")

        filed = [self.es.commit(self.draft(n), IMMEDIATE,
                                self.jump(T0 + n * 60)).edition_id
                 for n in (1, 2, 3)]

        self.assertEqual(self.es.prune(keep=2), 1)
        self.assertIsNotNone(self.es.read_payload(staged.edition_id))   # oldest
        self.assertIsNotNone(self.es.read_payload(filed[2]))            # current
        self.assertIsNotNone(self.es.read_payload(filed[1]))
        self.assertIsNone(self.es.read_payload(filed[0]))               # dropped

    def test_pruning_twice_removes_nothing_the_second_time(self):
        for n in range(5):
            self.es.commit(self.draft(n), IMMEDIATE, self.jump(T0 + n * 60))
        self.assertEqual(self.es.prune(keep=2), 3)
        self.assertEqual(self.es.prune(keep=2), 0)

    def test_a_half_built_edition_is_swept_and_never_counted(self):
        # A build interrupted by a crash. It cannot match an edition id, so it
        # is invisible to every reader rather than something each of them has
        # to filter -- and it is rubbish, not history, so it is not in the
        # number prune reports.
        r = self.file(1)
        partial = os.path.join(self.root, "editions", ".build-abcd1234")
        os.makedirs(os.path.join(partial, "tiles"))
        with open(os.path.join(partial, "news.json"), "wb") as f:
            f.write(payload(9))
        _backdate(partial)

        self.assertIsNone(self.es.read_payload(".build-abcd1234"))
        self.assertEqual(self.es.prune(keep=5), 0)
        self.assertFalse(os.path.exists(partial))
        self.assertEqual(self.es.current_id(), r.edition_id)
        self.assertEqual(self.es.read_payload(r.edition_id), payload(1))

    def test_a_build_directory_younger_than_the_ttl_is_left_alone(self):
        # Retention runs on the tick, and a build takes as long as it takes to
        # copy the tiles. A `.build-*` that was written a moment ago is far more
        # likely to be a commit in progress than a crash's leftover, and the
        # cost of being wrong is a published edition with tiles missing from it.
        self.file(1)
        fresh = os.path.join(self.root, "editions", ".build-inflight")
        os.makedirs(fresh)

        self.assertEqual(self.es.prune(keep=0), 0)
        self.assertTrue(os.path.isdir(fresh))

        _backdate(fresh)
        self.assertEqual(self.es.prune(keep=0), 0)
        self.assertFalse(os.path.exists(fresh))

    def test_the_constructor_sets_the_default_depth(self):
        es = EditionStore(self.root, self.gates, self.store, self.clock, keep=1)
        for n in range(3):
            es.commit(self.draft(n), IMMEDIATE, self.jump(T0 + n * 60))
        self.assertEqual(es.prune(), 2)
        self.assertIsNotNone(es.read_payload(es.current_id()))


# --------------------------------------------------------------------------
# Reading, and what a reader may not reach
# --------------------------------------------------------------------------

class ReadTest(EditionTestCase):
    def test_nothing_is_served_before_anything_is_filed(self):
        self.assertIsNone(self.es.current_id())
        self.assertIsNone(self.es.staged_id())
        self.assertIsNone(self.es.read_payload("0" * 16))

    def test_an_edition_id_that_is_a_path_reads_nothing(self):
        # This is the one that reads somebody else's file if it is wrong: an
        # edition id becomes a path component under the data root.
        self.file(1)
        for bad in ("../drafts", "..", "a/b", "/etc/passwd", "", "ZZZZ",
                    "0123456789abcdef/../../etc"):
            self.assertIsNone(self.es.read_payload(bad), bad)
            self.assertIsNone(self.es.read_tile(bad, "pic"), bad)

    def test_a_tile_id_that_is_a_path_reads_nothing(self):
        r = self.file(1)
        for bad in ("../news.json", "..", "a/b", "pic.bin", "x" * 16, ""):
            self.assertIsNone(self.es.read_tile(r.edition_id, bad), bad)

    def test_a_tile_nobody_filed_reads_nothing(self):
        r = self.file(1)
        self.assertIsNone(self.es.read_tile(r.edition_id, "absent"))

    def test_a_pointer_naming_something_impossible_is_ignored(self):
        # A corrupt pointer must not become a path. It is the one file here a
        # half-finished write could plausibly damage.
        self.file(1)
        with open(os.path.join(self.root, "current"), "w") as f:
            f.write("../../etc\n")
        self.assertIsNone(self.es.current_id())

    def test_a_pointer_naming_a_half_built_edition_reads_nothing(self):
        # The build prefix cannot be an edition id, which is the whole reason
        # it was chosen: a pointer that somehow named one is a pointer to
        # nothing rather than a way into a directory mid-assembly.
        self.file(1)
        with open(os.path.join(self.root, "current"), "w") as f:
            f.write(".build-abc\n")
        self.assertIsNone(self.es.current_id())

    def test_a_pointer_naming_an_edition_that_is_gone_serves_nothing(self):
        r = self.file(1)
        import shutil
        shutil.rmtree(os.path.join(self.root, "editions", r.edition_id))
        self.assertEqual(self.es.current_id(), r.edition_id)
        self.assertIsNone(self.es.read_payload(r.edition_id))


class ReopenTest(EditionTestCase):
    def test_a_new_store_on_the_same_root_serves_the_same_edition(self):
        # The pointer is the state. A restart that forgot which edition was
        # current would blank a wall for no reason at all.
        r = self.file(1)
        again = EditionStore(self.root, StubGates(), self.store, self.clock)
        self.assertEqual(again.current_id(), r.edition_id)
        self.assertEqual(again.read_payload(r.edition_id), payload(1))


# --------------------------------------------------------------------------
# Crashes, and a gate that takes ten minutes
# --------------------------------------------------------------------------

class BlockingGates(StubGates):
    """Gates that park inside gate 2 until the test lets them out.

    A real render shells out to CMake and can take ten minutes. This is that
    ten minutes, made instant and controllable, so a test can ask what the rest
    of the desk is able to do while one is running.
    """

    def __init__(self):
        super().__init__()
        self.entered = threading.Event()
        self.release = threading.Event()

    def render(self, draft_dir: str, out_dir: str) -> GateResult:
        self.entered.set()
        self.release.wait(10)
        return super().render(draft_dir, out_dir)


class CrashTest(EditionTestCase):
    def test_a_crash_between_the_build_and_the_pointer_leaves_the_old_page_up(self):
        # The window the whole build-and-rename dance is arranged around: the
        # edition is on disk and the pointer has not moved. What is on the wall
        # must be the page that was on the wall, and the next commit must be
        # able to finish the job rather than trip over a directory it half
        # remembers building.
        first = self.file(1)

        def refuse(_name, _edition_id):
            raise OSError("the disk went away")

        self.es._write_pointer = refuse          # the crash, made deterministic
        with self.assertRaises(OSError):
            self.es.commit(self.draft(2), IMMEDIATE, self.jump(T0 + 60))

        self.assertEqual(self.es.current_id(), first.edition_id)
        self.assertEqual(self.es.read_payload(first.edition_id), payload(1))
        self.assertIsNone(self.es.staged_id())

        del self.es._write_pointer               # the desk comes back up
        again = self.es.commit(self.draft(2), IMMEDIATE, self.jump(T0 + 120))
        self.assertEqual(again.state, "published")
        self.assertEqual(self.es.read_payload(self.es.current_id()), payload(2))
        self.assertEqual(self.es.read_tile(self.es.current_id(), "pic"),
                         b"\x01\x02\x03\x04")


class SweepDuringCommitTest(EditionTestCase):
    GATES = BlockingGates

    def test_a_draft_inside_a_commit_is_not_swept_however_old_it_looks(self):
        # Gate 2 can outlive the draft's own TTL, and the sweeper runs on the
        # tick. Deleting the directory a render is reading would fail the
        # commit for a reason nobody could reconstruct afterwards.
        #
        # That the sweep answers at all is the second half of this: the gates
        # run outside the lock, so a ten-minute render does not stop the desk.
        d = self.draft()
        done: list = []
        commit = threading.Thread(
            target=lambda: done.append(self.es.commit(d, IMMEDIATE, T0)),
            daemon=True)
        commit.start()

        self.assertTrue(self.gates.entered.wait(10), "gate 2 never started")
        self.clock.advance(3601)
        self.assertEqual(self.es.sweep_drafts(), 0)
        self.assertTrue(os.path.isdir(os.path.join(self.root, "drafts", d)))

        self.gates.release.set()
        commit.join(timeout=10)
        self.assertEqual(done[0].state, "published")
        self.assertEqual(self.es.read_payload(self.es.current_id()), payload(1))


class PruneDuringBuildTest(EditionTestCase):
    """Retention on the tick thread, arriving in the middle of a commit.

    ``prune()`` runs from ``Desk.tick()`` every ten minutes and commits arrive
    on the request threads of a ``ThreadingHTTPServer``, so these two meet
    without anybody arranging it. Both tests here are the same question asked
    at two moments: can housekeeping delete the thing a commit is standing on?
    """

    def test_a_build_in_flight_survives_retention_however_old_it_looks(self):
        entered = threading.Event()
        release = threading.Event()
        original = E._write_file

        def park(path: str, data: bytes) -> None:
            """Stop inside the build, with its directory half filled."""
            original(path, data)
            if os.path.basename(path) == "news.json":
                entered.set()
                release.wait(10)

        E._write_file = park
        self.addCleanup(setattr, E, "_write_file", original)

        done: list = []
        commit = threading.Thread(
            target=lambda: done.append(self.es.commit(self.draft(1), IMMEDIATE, T0)),
            daemon=True)
        commit.start()
        self.assertTrue(entered.wait(10), "the build never started")

        builds = [n for n in os.listdir(os.path.join(self.root, "editions"))
                  if n.startswith(".build-")]
        self.assertEqual(len(builds), 1, builds)
        partial = os.path.join(self.root, "editions", builds[0])
        _backdate(partial)          # as old as anything a crash left behind

        self.assertEqual(self.es.prune(keep=0), 0)
        self.assertTrue(os.path.isdir(partial), "retention took a live build")

        release.set()
        commit.join(timeout=10)
        self.assertEqual(done[0].state, "published")
        self.assertEqual(self.es.read_payload(self.es.current_id()), payload(1))
        self.assertEqual(self.es.read_tile(self.es.current_id(), "pic"),
                         b"\x01\x02\x03\x04")

    def test_retention_cannot_take_the_edition_a_commit_is_placing(self):
        # The reuse path. The edition is on disk and the commit is about to
        # point `current` at it, but until that pointer moves it is neither
        # current nor staged -- so retention would otherwise be free to take it
        # as old history, and `current` would name a directory that is gone.
        first = self.file(1)
        self.file(2, now=self.jump(T0 + 60))

        real = self.store.record_edition

        def record_then_prune(eid, meta):
            """The tick, arriving between the build and the pointer write."""
            real(eid, meta)
            self.es.prune(keep=0)

        self.store.record_edition = record_then_prune
        self.addCleanup(setattr, self.store, "record_edition", real)

        again = self.es.commit(self.draft(1), IMMEDIATE, self.jump(T0 + 120))
        self.assertEqual(again.edition_id, first.edition_id)
        self.assertEqual(self.es.current_id(), first.edition_id)
        self.assertEqual(self.es.read_payload(first.edition_id), payload(1))
        self.assertEqual(self.es.read_tile(first.edition_id, "pic"),
                         b"\x01\x02\x03\x04")


# --------------------------------------------------------------------------
# The atomic swap
# --------------------------------------------------------------------------

class AtomicSwapTest(EditionTestCase):
    """A reader must never see half of two editions.

    The counter is written into the payload *and* into the tile, so a reader
    that resolves ``current`` and then fetches both has an invariant it can
    check: they agree, or the swap was not atomic. Without it the test would
    only prove that nothing raised, which a half-published edition would also
    manage.

    The publishing runs on the main thread and the readers on their own,
    because the writer is the only side that touches SQLite and a connection
    that is used from one thread stays a connection used from one thread.
    """

    ROUNDS = 300
    READERS = 3

    def test_a_reader_never_observes_a_half_published_edition(self):
        stop = threading.Event()
        seen = [0]
        problems: list[str] = []

        def read() -> None:
            while not stop.is_set():
                eid = self.es.current_id()
                if eid is None:
                    continue
                body = self.es.read_payload(eid)
                tile = self.es.read_tile(eid, "pic")
                if body is None or tile is None:
                    problems.append(f"{eid}: payload={body is not None} "
                                    f"tile={tile is not None}")
                    return
                serial = json.loads(body)["serial"]
                if tile != bytes([serial & 0xFF]) * 4:
                    problems.append(f"{eid}: payload says {serial}, tile says "
                                    f"{tile!r}")
                    return
                seen[0] += 1

        readers = [threading.Thread(target=read, daemon=True)
                   for _ in range(self.READERS)]
        for t in readers:
            t.start()
        try:
            for n in range(1, self.ROUNDS + 1):
                self.file(n, now=self.jump(T0 + n), tile=bytes([n & 0xFF]) * 4)
        finally:
            stop.set()
            for t in readers:
                t.join(timeout=10)

        self.assertEqual(problems[:5], [])
        self.assertGreater(seen[0], 0, "the readers never observed an edition")


if __name__ == "__main__":
    unittest.main()
