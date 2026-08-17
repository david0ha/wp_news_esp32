"""The queue, the directive store, the edition log and the hold.

The concurrency test is the one that matters. Everything else here would show
up the first time somebody used it; a claim that two workers both win shows up
as two editions filed for one instruction and a wall that flashes twice, on a
day nobody is watching.
"""

from __future__ import annotations

import os
import tempfile
import threading
import unittest

from wpdesk.clock import Clock, FixedClock
from wpdesk.errors import BadRequest
from wpdesk.store import Store

# 2026-08-19 09:00 KST, an ordinary Wednesday morning, as an epoch second.
T0 = 1755561600.0


class StoreTestCase(unittest.TestCase):
    """A store on a temporary file, with a clock the test moves by hand."""

    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.path = os.path.join(self.dir.name, "desk.sqlite")
        self.clock = FixedClock(T0)
        self.store = Store(self.path, self.clock)
        self.addCleanup(self.store.close)

    def file_edition(self, text="NVDA -- lead on the guide", **kw):
        return self.store.add_command("file_edition", text, **kw)


class SchemaTest(StoreTestCase):
    def test_the_schema_is_created_on_first_open(self):
        self.assertTrue(os.path.exists(self.path))
        self.assertEqual(self.store.list_commands(), [])
        self.assertEqual(self.store.list_directives(), [])
        self.assertEqual(self.store.list_editions(), [])

    def test_reopening_an_existing_file_does_not_lose_rows(self):
        cid = self.file_edition()["id"]
        self.store.add_directive("Never print TSLA")
        self.store.note_publish("abc123", T0)
        self.store.close()

        again = Store(self.path, FixedClock(T0))
        self.addCleanup(again.close)
        self.assertEqual(again.get_command(cid)["id"], cid)
        self.assertEqual(len(again.list_directives()), 1)
        self.assertEqual(again.last_publish_at(), T0)

    def test_a_missing_parent_directory_is_created(self):
        # /data is a fresh Docker volume the first time the desk comes up.
        nested = os.path.join(self.dir.name, "a", "b", "desk.sqlite")
        s = Store(nested, FixedClock(T0))
        self.addCleanup(s.close)
        self.assertTrue(os.path.exists(nested))


class AddCommandTest(StoreTestCase):
    def test_a_new_command_is_pending_with_no_attempts(self):
        c = self.file_edition(priority=3, source="me")
        self.assertEqual(c["kind"], "file_edition")
        self.assertEqual(c["status"], "pending")
        self.assertEqual(c["priority"], 3)
        self.assertEqual(c["attempts"], 0)
        self.assertEqual(c["source"], "me")
        self.assertEqual(c["created_at"], T0)
        self.assertIsNone(c["claimed_by"])
        self.assertIsNone(c["deadline_at"])
        self.assertEqual(self.store.pending_count(), 1)

    def test_an_unknown_kind_is_refused(self):
        with self.assertRaises(BadRequest):
            self.store.add_command("rm -rf", "anything")

    def test_text_over_the_cap_is_refused(self):
        from wpdesk import store as S
        self.file_edition(text="x" * S.MAX_COMMAND_TEXT)
        with self.assertRaises(BadRequest):
            self.file_edition(text="x" * (S.MAX_COMMAND_TEXT + 1))

    def test_an_empty_instruction_is_refused(self):
        # A command is an intent in the owner's own words. No words, no intent.
        for bad in ("", "   ", "\n"):
            with self.assertRaises(BadRequest, msg=repr(bad)):
                self.file_edition(text=bad)

    def test_a_priority_outside_the_dial_is_refused(self):
        for bad in (-1, 10):
            with self.assertRaises(BadRequest, msg=str(bad)):
                self.file_edition(priority=bad)


class ClaimOrderTest(StoreTestCase):
    def test_a_command_comes_back_in_priority_then_fifo_order(self):
        self.file_edition(text="third", priority=5)
        self.clock.advance(1)
        self.file_edition(text="fourth", priority=5)
        self.clock.advance(1)
        self.file_edition(text="first", priority=0)
        self.clock.advance(1)
        self.file_edition(text="second", priority=1)

        got = []
        while True:
            c = self.store.claim_command("w")
            if c is None:
                break
            got.append(c["text"])
        self.assertEqual(got, ["first", "second", "third", "fourth"])

    def test_an_empty_queue_claims_nothing(self):
        self.assertIsNone(self.store.claim_command("w"))

    def test_a_claim_records_the_worker_and_the_instant(self):
        cid = self.file_edition()["id"]
        c = self.store.claim_command("agent-1")
        self.assertEqual(c["id"], cid)
        self.assertEqual(c["status"], "claimed")
        self.assertEqual(c["claimed_by"], "agent-1")
        self.assertEqual(c["claimed_at"], T0)
        self.assertEqual(c["attempts"], 1)
        self.assertEqual(self.store.pending_count(), 0)


class ExactlyOnceTest(unittest.TestCase):
    """Twenty workers, one command, one winner.

    Each thread opens its own :class:`Store` on the same file, which is what
    the deployed shape looks like: the desk claims on behalf of a long poll and
    the agent container claims for itself, in different processes entirely. If
    the claim were a SELECT followed by an UPDATE this test would pass most of
    the time, which is the worst way for it to fail.
    """

    WORKERS = 20

    def test_exactly_one_of_twenty_concurrent_claimers_wins(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "desk.sqlite")
            primary = Store(path, Clock())
            primary.add_command("file_edition", "the one command")

            start = threading.Barrier(self.WORKERS)
            results: list[dict | None] = [None] * self.WORKERS
            errors: list[BaseException] = []

            def worker(i: int) -> None:
                s = Store(path, Clock())
                try:
                    start.wait(timeout=10)
                    results[i] = s.claim_command(f"w{i}")
                except BaseException as exc:      # noqa: BLE001 -- reported below
                    errors.append(exc)
                finally:
                    s.close()

            threads = [threading.Thread(target=worker, args=(i,))
                       for i in range(self.WORKERS)]
            for t in threads:
                t.start()
            for t in threads:
                t.join(timeout=30)

            self.assertEqual(errors, [])
            won = [r for r in results if r is not None]
            self.assertEqual(len(won), 1, f"{len(won)} workers claimed one command")
            self.assertEqual(won[0]["attempts"], 1)
            self.assertEqual(primary.get_command(won[0]["id"])["status"], "claimed")
            primary.close()


class LeaseTest(StoreTestCase):
    def test_a_claim_past_its_lease_returns_to_pending(self):
        from wpdesk import store as S
        cid = self.file_edition()["id"]
        self.store.claim_command("w1")
        self.clock.advance(S.LEASE_SECONDS + 1)
        self.assertEqual(self.store.reap(), 1)
        c = self.store.get_command(cid)
        self.assertEqual(c["status"], "pending")
        self.assertEqual(c["attempts"], 1)
        self.assertIsNone(c["claimed_by"])

    def test_a_lease_that_has_not_run_out_is_left_alone(self):
        from wpdesk import store as S
        cid = self.file_edition()["id"]
        self.store.claim_command("w1")
        self.clock.advance(S.LEASE_SECONDS - 1)
        self.assertEqual(self.store.reap(), 0)
        self.assertEqual(self.store.get_command(cid)["status"], "claimed")

    def test_the_third_attempt_fails_it_rather_than_returning_it(self):
        from wpdesk import store as S
        cid = self.file_edition()["id"]
        for attempt in range(1, S.MAX_ATTEMPTS + 1):
            self.assertIsNotNone(self.store.claim_command(f"w{attempt}"),
                                 f"attempt {attempt} found nothing to claim")
            self.clock.advance(S.LEASE_SECONDS + 1)
            self.store.reap()
            c = self.store.get_command(cid)
            self.assertEqual(c["attempts"], attempt)
            expected = "failed" if attempt == S.MAX_ATTEMPTS else "pending"
            self.assertEqual(c["status"], expected, f"after attempt {attempt}")
        self.assertIsNone(self.store.claim_command("w9"))


class DeadlineTest(StoreTestCase):
    def test_a_command_past_its_deadline_is_never_claimed(self):
        self.file_edition(deadline_at=T0 + 60)
        self.clock.advance(61)
        self.assertIsNone(self.store.claim_command("w"))

    def test_reap_expires_it(self):
        cid = self.file_edition(deadline_at=T0 + 60)["id"]
        self.clock.advance(61)
        self.assertEqual(self.store.reap(), 1)
        self.assertEqual(self.store.get_command(cid)["status"], "expired")
        self.assertEqual(self.store.pending_count(), 0)

    def test_a_deadline_still_ahead_claims_normally(self):
        self.file_edition(deadline_at=T0 + 60)
        self.clock.advance(59)
        self.assertIsNotNone(self.store.claim_command("w"))
        self.assertEqual(self.store.reap(), 0)


class FinishTest(StoreTestCase):
    def test_a_claimed_command_can_be_finished_done(self):
        cid = self.file_edition()["id"]
        self.store.claim_command("w")
        self.clock.advance(30)
        c = self.store.finish_command(cid, "done", "edition 9f3a filed")
        self.assertEqual(c["status"], "done")
        self.assertEqual(c["result"], "edition 9f3a filed")
        self.assertEqual(c["finished_at"], T0 + 30)

    def test_a_status_that_is_not_a_terminal_one_is_refused(self):
        cid = self.file_edition()["id"]
        self.store.claim_command("w")
        for bad in ("pending", "claimed", "finished", ""):
            with self.assertRaises(BadRequest, msg=bad):
                self.store.finish_command(cid, bad)

    def test_finishing_something_already_finished_is_refused(self):
        from wpdesk.errors import Conflict
        cid = self.file_edition()["id"]
        self.store.claim_command("w")
        self.store.finish_command(cid, "done")
        with self.assertRaises(Conflict):
            self.store.finish_command(cid, "failed", "no it wasn't")

    def test_finishing_a_command_nobody_filed_is_not_found(self):
        from wpdesk.errors import NotFound
        with self.assertRaises(NotFound):
            self.store.finish_command("no-such-id", "done")


class CancelTest(StoreTestCase):
    def test_a_pending_command_can_be_cancelled(self):
        cid = self.file_edition()["id"]
        self.assertTrue(self.store.cancel_command(cid))
        self.assertEqual(self.store.get_command(cid)["status"], "cancelled")
        self.assertIsNone(self.store.claim_command("w"))

    def test_a_claimed_command_is_refused(self):
        # A worker is already running it. Marking it cancelled here would not
        # stop that, it would only lose the record of what the worker did.
        cid = self.file_edition()["id"]
        self.store.claim_command("w")
        self.assertFalse(self.store.cancel_command(cid))
        self.assertEqual(self.store.get_command(cid)["status"], "claimed")

    def test_a_command_that_does_not_exist_is_refused(self):
        self.assertFalse(self.store.cancel_command("no-such-id"))


class ListTest(StoreTestCase):
    def test_listing_filters_by_status(self):
        self.file_edition(text="a")
        self.clock.advance(1)
        b = self.file_edition(text="b")
        self.store.claim_command("w")          # claims "a", the older one
        self.assertEqual([c["text"] for c in self.store.list_commands("pending")], ["b"])
        self.assertEqual([c["text"] for c in self.store.list_commands("claimed")], ["a"])
        self.assertEqual(len(self.store.list_commands()), 2)
        self.assertEqual(self.store.get_command(b["id"])["text"], "b")

    def test_an_unknown_id_is_none_rather_than_an_error(self):
        self.assertIsNone(self.store.get_command("no-such-id"))

    def test_the_limit_is_honoured(self):
        for i in range(5):
            self.file_edition(text=f"c{i}")
            self.clock.advance(1)
        self.assertEqual(len(self.store.list_commands(limit=2)), 2)


class DirectiveTest(StoreTestCase):
    def test_a_directive_is_listed_in_the_order_it_was_written(self):
        self.store.add_directive("Never print TSLA", source="me")
        self.clock.advance(1)
        self.store.add_directive("Prefer the accounts page for banks")
        rules = [d["rule"] for d in self.store.list_directives()]
        self.assertEqual(rules, ["Never print TSLA",
                                 "Prefer the accounts page for banks"])
        self.assertEqual(self.store.list_directives()[0]["scope"], "always")
        self.assertEqual(self.store.list_directives()[0]["source"], "me")

    def test_an_expired_until_directive_is_not_listed(self):
        self.store.add_directive("Cover the merger", scope="until",
                                 expires_at=T0 + 3600)
        self.assertEqual(len(self.store.list_directives()), 1)
        self.clock.advance(3601)
        self.assertEqual(self.store.list_directives(), [])

    def test_an_until_directive_needs_an_expiry(self):
        with self.assertRaises(BadRequest):
            self.store.add_directive("Cover the merger", scope="until")

    def test_an_always_directive_may_not_carry_one(self):
        with self.assertRaises(BadRequest):
            self.store.add_directive("Never print TSLA", expires_at=T0 + 60)

    def test_an_unknown_scope_is_refused(self):
        with self.assertRaises(BadRequest):
            self.store.add_directive("x", scope="sometimes")

    def test_a_rule_over_the_cap_or_under_a_word_is_refused(self):
        from wpdesk import store as S
        self.store.add_directive("r" * S.MAX_DIRECTIVE_RULE)
        with self.assertRaises(BadRequest):
            self.store.add_directive("r" * (S.MAX_DIRECTIVE_RULE + 1))
        with self.assertRaises(BadRequest):
            self.store.add_directive("   ")

    def test_a_directive_can_be_deleted_and_deleting_it_twice_says_so(self):
        did = self.store.add_directive("Never print TSLA")["id"]
        self.assertTrue(self.store.delete_directive(did))
        self.assertEqual(self.store.list_directives(), [])
        self.assertFalse(self.store.delete_directive(did))


class EditionTest(StoreTestCase):
    def test_an_edition_round_trips_through_its_meta(self):
        self.store.record_edition("9f3a", {"source": "agent", "tile_count": 2,
                                           "bytes": 4096})
        got = self.store.get_edition("9f3a")
        self.assertEqual(got["id"], "9f3a")
        self.assertEqual(got["tile_count"], 2)
        self.assertEqual(got["created_at"], T0)
        self.assertIsNone(got["published_at"])

    def test_an_unknown_edition_is_none(self):
        self.assertIsNone(self.store.get_edition("nope"))

    def test_recording_the_same_id_twice_updates_rather_than_duplicates(self):
        # The id is a content fingerprint, so the same id really is the same
        # edition arriving again -- promoted, say. Two rows would make
        # list_editions() show it twice.
        self.store.record_edition("9f3a", {"source": "agent"})
        self.store.record_edition("9f3a", {"source": "operator"})
        self.assertEqual(len(self.store.list_editions()), 1)
        self.assertEqual(self.store.get_edition("9f3a")["source"], "operator")

    def test_editions_are_listed_newest_first(self):
        for i, eid in enumerate(("aaa", "bbb", "ccc")):
            self.store.record_edition(eid, {"source": "agent"})
            self.clock.advance(60)
        self.assertEqual([e["id"] for e in self.store.list_editions()],
                         ["ccc", "bbb", "aaa"])
        self.assertEqual(len(self.store.list_editions(limit=2)), 2)

    def test_last_publish_at_is_none_on_an_empty_store(self):
        self.assertIsNone(self.store.last_publish_at())

    def test_last_publish_at_is_the_latest_of_two(self):
        self.store.record_edition("aaa", {})
        self.store.record_edition("bbb", {})
        self.store.note_publish("aaa", T0)
        self.store.note_publish("bbb", T0 + 3600)
        self.assertEqual(self.store.last_publish_at(), T0 + 3600)
        self.assertEqual(self.store.get_edition("bbb")["published_at"], T0 + 3600)

    def test_an_out_of_order_publish_does_not_move_the_clock_backwards(self):
        # min_gap_minutes is measured from the last publish. A promote of an
        # older edition records a publish at the instant it happened, and the
        # gap must be measured from that, not from whichever row sorts last.
        self.store.note_publish("bbb", T0 + 3600)
        self.store.note_publish("aaa", T0)
        self.assertEqual(self.store.last_publish_at(), T0 + 3600)


class HoldTest(StoreTestCase):
    def test_there_is_no_hold_to_begin_with(self):
        self.assertIsNone(self.store.get_hold())

    def test_a_hold_holds_until_its_instant(self):
        self.store.set_hold(T0 + 3600)
        self.assertEqual(self.store.get_hold(), T0 + 3600)
        self.clock.advance(3601)
        self.assertIsNone(self.store.get_hold())

    def test_a_hold_can_be_cleared(self):
        self.store.set_hold(T0 + 3600)
        self.store.set_hold(None)
        self.assertIsNone(self.store.get_hold())

    def test_a_hold_survives_a_reopen(self):
        self.store.set_hold(T0 + 3600)
        self.store.close()
        again = Store(self.path, FixedClock(T0))
        self.addCleanup(again.close)
        self.assertEqual(again.get_hold(), T0 + 3600)


class AuditTest(StoreTestCase):
    def test_an_event_comes_back_newest_first_with_its_detail(self):
        self.store.audit("publish", {"edition": "9f3a"})
        self.clock.advance(1)
        self.store.audit("hold", {"until": T0 + 60})
        rows = self.store.recent_audit()
        self.assertEqual([r["event"] for r in rows], ["hold", "publish"])
        self.assertEqual(rows[1]["detail"], {"edition": "9f3a"})
        self.assertEqual(rows[0]["at"], T0 + 1)

    def test_the_limit_is_honoured(self):
        for i in range(5):
            self.store.audit("tick", {"i": i})
        self.assertEqual(len(self.store.recent_audit(limit=2)), 2)


class MetaTest(StoreTestCase):
    def test_a_note_to_self_round_trips_and_survives_a_reopen(self):
        self.assertIsNone(self.store.get_meta("last_wake"))
        self.store.set_meta("last_wake", "1755561600")
        self.store.close()
        again = Store(self.path, FixedClock(T0))
        self.addCleanup(again.close)
        self.assertEqual(again.get_meta("last_wake"), "1755561600")


if __name__ == "__main__":
    unittest.main()
