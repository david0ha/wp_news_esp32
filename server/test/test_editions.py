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

Everything runs on :class:`~wpdesk.gates.StubGates` and
:class:`~wpdesk.clock.FixedClock`: no CMake, no network, no waiting for six in
the morning.
"""

from __future__ import annotations

import json
import os
import tempfile
import threading
import unittest

from test_schedule import at

from wpdesk import schedule as S
from wpdesk import tiles
from wpdesk.clock import FixedClock
from wpdesk.editions import EditionStore
from wpdesk.errors import BadRequest, Conflict, NotFound, TooLarge
from wpdesk.gates import GateResult, StubGates
from wpdesk.store import Store

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
        # This is the one that reads the vault if it is wrong: the desk runs in
        # a container with the owner's notes mounted beside the data root.
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
