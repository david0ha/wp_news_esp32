"""The queue, the directive store, the edition log and the hold.

The concurrency test is the one that matters. Everything else here would show
up the first time somebody used it; a claim that two workers both win shows up
as two editions filed for one instruction and a wall that flashes twice, on a
day nobody is watching.
"""

from __future__ import annotations

import os
import sqlite3
import tempfile
import threading
import unittest

from test_schedule import at

from claudepost.clock import Clock, FixedClock
from claudepost.errors import BadRequest
from claudepost.store import Store

#: 2026-08-19 09:00 KST, an ordinary Wednesday morning. Through the same helper
#: test_editions.py and test_http.py use, rather than as an epoch second with a
#: date beside it in a comment: the number that was there said 2026 and meant
#: 2025. Nothing in the store reads a calendar, so the year was harmless -- but
#: a comment that has to be checked against a converter is one nobody checks.
T0 = at(2026, 8, 19, 9, 0)


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


class AskTest(StoreTestCase):
    """The kind the phone files, and the two columns that make it a thread."""

    def ask(self, text="왜 그 회사예요?", **kw):
        return self.store.add_command("ask", text, **kw)

    def test_ask_is_a_kind_the_queue_takes(self):
        row = self.ask()
        self.assertEqual(row["kind"], "ask")
        self.assertEqual(row["status"], "pending")
        self.assertIsNone(row["reply_to"])
        self.assertIsNone(row["lang"])

    def test_both_columns_round_trip_through_the_database(self):
        first = self.ask(lang="ko", source="app")
        second = self.ask("그럼 실적은요?", reply_to=first["id"], lang="ko")

        back = self.store.get_command(second["id"])
        self.assertEqual(back["reply_to"], first["id"])
        self.assertEqual(back["lang"], "ko")
        self.assertEqual(self.store.get_command(first["id"])["reply_to"], None)

    def test_a_reply_to_that_names_nothing_is_refused(self):
        # The worker will fetch that row and put the earlier turn in front of
        # the model. An id naming nothing is a thread silently missing a turn.
        with self.assertRaises(BadRequest) as caught:
            self.ask(reply_to="0" * 32)
        self.assertIn("reply to", caught.exception.message)

    def test_a_reply_to_that_is_not_an_id_at_all_is_refused(self):
        for bad in ("../etc/passwd", "NOT-HEX", "abc", 17):
            with self.subTest(reply_to=bad):
                with self.assertRaises(BadRequest):
                    self.ask(reply_to=bad)

    def test_lang_is_a_language_the_board_can_print(self):
        self.assertEqual(self.ask(lang="en")["lang"], "en")
        with self.assertRaises(BadRequest) as caught:
            self.ask(lang="ja")
        self.assertIn("en, ko", caught.exception.message)

    def test_the_four_older_kinds_still_work_and_carry_the_columns(self):
        row = self.file_edition()
        self.assertIsNone(row["reply_to"])
        self.assertIsNone(row["lang"])
        self.assertEqual(self.store.get_command(row["id"])["kind"],
                         "file_edition")


class PaperTest(StoreTestCase):
    """The kind the rotation files, and the column that says which company."""

    def paper(self, text="Refresh the paper for SNDK.", **kw):
        kw.setdefault("symbol", "SNDK")
        return self.store.add_command("paper", text, **kw)

    def test_paper_is_a_kind_the_queue_takes(self):
        row = self.paper()
        self.assertEqual(row["kind"], "paper")
        self.assertEqual(row["status"], "pending")
        self.assertEqual(row["symbol"], "SNDK")

    def test_the_symbol_round_trips_through_the_database(self):
        cid = self.paper()["id"]
        self.assertEqual(self.store.get_command(cid)["symbol"], "SNDK")
        [listed] = [r for r in self.store.list_commands() if r["id"] == cid]
        self.assertEqual(listed["symbol"], "SNDK")

    def test_a_claimed_paper_still_knows_its_company(self):
        # The worker reads the symbol off the claim and off nothing else. A
        # column the claim does not return is a run about no company at all.
        self.paper()
        self.assertEqual(self.store.claim_command("w")["symbol"], "SNDK")

    def test_a_paper_without_a_symbol_is_refused(self):
        # The company is the whole instruction. A `paper` with no symbol is a
        # run that would fall back to picking one, which is the board's job.
        with self.assertRaises(BadRequest) as caught:
            self.store.add_command("paper", "Refresh the paper.")
        self.assertIn("symbol", caught.exception.message)

    def test_a_lower_case_ticker_is_stored_upper_case(self):
        self.assertEqual(self.paper(symbol="sndk")["symbol"], "SNDK")

    def test_a_symbol_that_is_not_a_ticker_is_refused(self):
        for bad in ("", "TOOLONGSYM", "../etc", "A B", "A/B", 17, True):
            with self.subTest(symbol=bad):
                with self.assertRaises(BadRequest):
                    self.store.add_command("paper", "Refresh it.", symbol=bad)

    def test_a_symbol_of_nothing_but_punctuation_is_not_a_ticker(self):
        # A ticker always carries at least one letter or digit. These are not
        # tickers, and `..` in particular becomes a URL path segment at
        # `/api/papers/<SYMBOL>/publish` -- so the desk refuses the shape here,
        # at the one place that decides what a symbol is, rather than leaving
        # every consumer to remember.
        for bad in (".", "..", "-", "--", "........", ".-.-"):
            with self.subTest(symbol=bad):
                with self.assertRaises(BadRequest):
                    self.store.add_command("paper", "Refresh it.", symbol=bad)

    def test_a_symbol_that_mixes_punctuation_with_a_ticker_still_works(self):
        # `BRK.B` and `RDS-A` are real shapes. The lookahead must not cost them.
        for good in ("BRK.B", "RDS-A", "A", "A.B.C.D"):
            with self.subTest(symbol=good):
                self.assertEqual(
                    self.store.add_command("paper", "Refresh it.",
                                           symbol=good)["symbol"], good)

    def test_only_a_paper_may_carry_one(self):
        # The index is derived from the edition's own subject, so a symbol on
        # any other kind would be a field nothing reads and a promise nothing
        # keeps.
        with self.assertRaises(BadRequest) as caught:
            self.store.add_command("ask", "왜 그 회사예요?", symbol="SNDK")
        self.assertIn("paper", caught.exception.message)

    def test_the_five_older_kinds_still_work_and_carry_the_column(self):
        for kind in ("file_edition", "research", "custom", "calendar"):
            with self.subTest(kind=kind):
                row = self.store.add_command(kind, "do the thing")
                self.assertIsNone(row["symbol"])
                self.assertIsNone(self.store.get_command(row["id"])["symbol"])


class MigrationTest(unittest.TestCase):
    """A desk that has been running since August opens the new schema.

    The old table is written out by hand rather than made by dropping columns
    from the new one: `ALTER TABLE ... DROP COLUMN` needs SQLite 3.35, and a
    test whose subject is "what happens on an old database" should not itself
    require a new library.
    """

    #: `commands` exactly as it stood before this feature -- the shape a desk
    #: deployed in August still has on disk.
    OLD = """
    CREATE TABLE commands (
        id          TEXT PRIMARY KEY,
        kind        TEXT    NOT NULL,
        text        TEXT    NOT NULL,
        priority    INTEGER NOT NULL,
        status      TEXT    NOT NULL,
        source      TEXT    NOT NULL DEFAULT '',
        created_at  REAL    NOT NULL,
        deadline_at REAL,
        claimed_by  TEXT,
        claimed_at  REAL,
        finished_at REAL,
        attempts    INTEGER NOT NULL DEFAULT 0,
        result      TEXT    NOT NULL DEFAULT ''
    );
    """

    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.path = os.path.join(self.dir.name, "desk.sqlite")

    def test_the_columns_are_added_to_a_database_that_predates_them(self):
        # The failure this prevents is not a startup error, which somebody
        # would notice. It is `no such column: reply_to` on the first message
        # sent from the phone, weeks after the deploy.
        old = sqlite3.connect(self.path)
        old.executescript(self.OLD)
        old.execute("INSERT INTO commands (id, kind, text, priority, status, "
                    "created_at) VALUES (?, 'custom', 'old', 5, "
                    "'pending', ?)", ("a" * 32, T0))
        old.commit()
        old.close()

        store = Store(self.path, FixedClock(T0))
        self.addCleanup(store.close)
        # The row that was already there survives, without the new fields set.
        self.assertIsNone(store.get_command("a" * 32)["reply_to"])
        row = store.add_command("ask", "다시 물어봐요", lang="ko")
        self.assertEqual(store.get_command(row["id"])["lang"], "ko")

    def test_opening_twice_adds_nothing_twice(self):
        first = Store(self.path, FixedClock(T0))
        self.addCleanup(first.close)
        second = Store(self.path, FixedClock(T0))
        self.addCleanup(second.close)
        names = [r["name"] for r
                 in second._db.execute("PRAGMA table_info(commands)")]
        self.assertEqual(names.count("reply_to"), 1)
        self.assertEqual(names.count("lang"), 1)

    def test_the_symbol_column_is_added_to_an_older_database_too(self):
        # A desk that has never restarted since August gets all three columns
        # in one pass, and the rotation's first order is the first write that
        # would have hit `no such column: symbol`.
        old = sqlite3.connect(self.path)
        old.executescript(self.OLD)
        old.commit()
        old.close()

        store = Store(self.path, FixedClock(T0))
        self.addCleanup(store.close)
        row = store.add_command("paper", "Refresh the paper for ACME.",
                                symbol="ACME")
        self.assertEqual(store.get_command(row["id"])["symbol"], "ACME")

    def test_opening_twice_adds_the_symbol_column_once(self):
        first = Store(self.path, FixedClock(T0))
        self.addCleanup(first.close)
        second = Store(self.path, FixedClock(T0))
        self.addCleanup(second.close)
        names = [r["name"] for r
                 in second._db.execute("PRAGMA table_info(commands)")]
        self.assertEqual(names.count("symbol"), 1)


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
        from claudepost import store as S
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

    def test_an_instant_that_is_not_one_is_refused(self):
        # The same rule the HTTP door applies, because it is the same rule:
        # a string is not parsed, True is not 1970, and an instant before the
        # epoch is a typo rather than a deadline. The store had been taking
        # the negative one, so a caller that reached it without going through
        # a request body got a command no claim could ever find.
        for bad in ("2026-08-19T09:00", True, -1, [T0]):
            with self.assertRaises(BadRequest, msg=repr(bad)):
                self.file_edition(deadline_at=bad)


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
        from claudepost import store as S
        cid = self.file_edition()["id"]
        self.store.claim_command("w1")
        self.clock.advance(S.LEASE_SECONDS + 1)
        self.assertEqual(self.store.reap(), 1)
        c = self.store.get_command(cid)
        self.assertEqual(c["status"], "pending")
        self.assertEqual(c["attempts"], 1)
        self.assertIsNone(c["claimed_by"])

    def test_a_lease_that_has_not_run_out_is_left_alone(self):
        from claudepost import store as S
        cid = self.file_edition()["id"]
        self.store.claim_command("w1")
        self.clock.advance(S.LEASE_SECONDS - 1)
        self.assertEqual(self.store.reap(), 0)
        self.assertEqual(self.store.get_command(cid)["status"], "claimed")

    def test_the_third_attempt_fails_it_rather_than_returning_it(self):
        from claudepost import store as S
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

    def test_the_lease_is_longer_than_any_run_the_worker_makes(self):
        # Ninety minutes, and the number is asserted rather than derived,
        # because the thing it has to be longer than is not in this file: a
        # paper run is 25-40 minutes clean and longer with a revision turn, and
        # on 2026-09-11 a thirty-minute lease put a claimed order back to
        # `pending` at minute 39 while the worker was still writing it.
        from claudepost import store as S
        self.assertEqual(S.LEASE_SECONDS, 5400)

    def test_an_hour_into_a_run_the_claim_still_holds(self):
        # The exact failure that was seen. With one worker it was harmless --
        # `finish_command` takes a report on a pending row -- but the rotation
        # reads `pending` as "the worker is idle" and would have ordered a
        # second paper on top of the one being written.
        cid = self.file_edition()["id"]
        self.store.claim_command("w1")
        self.clock.advance(3600)
        self.assertEqual(self.store.reap(), 0)
        c = self.store.get_command(cid)
        self.assertEqual(c["status"], "claimed")
        self.assertEqual(c["claimed_by"], "w1")

    def test_a_run_that_never_reports_is_still_reaped(self):
        # The other half: a longer lease must not become no lease. A worker
        # that died costs one retry, ninety minutes later.
        #
        # `S.LEASE_SECONDS + 1` and not a literal `5401`: the number belongs in
        # one place, and the test above is the one place that pins it. Two
        # spellings of it here would be one to remember on the next change.
        from claudepost import store as S
        cid = self.file_edition()["id"]
        self.store.claim_command("w1")
        self.clock.advance(S.LEASE_SECONDS + 1)
        self.assertEqual(self.store.reap(), 1)
        self.assertEqual(self.store.get_command(cid)["status"], "pending")


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
        from claudepost.errors import Conflict
        cid = self.file_edition()["id"]
        self.store.claim_command("w")
        self.store.finish_command(cid, "done")
        with self.assertRaises(Conflict):
            self.store.finish_command(cid, "failed", "no it wasn't")

    def test_finishing_a_command_nobody_filed_is_not_found(self):
        from claudepost.errors import NotFound
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
        from claudepost import store as S
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

    def test_every_event_carries_a_sequence_that_orders_it(self):
        # `seq` is the audit table's own AUTOINCREMENT primary key, exposed so
        # a caller can page ("give me everything after seq N") without racing
        # `at`, which two events in the same clock tick can share.
        self.store.audit("publish", {"edition": "9f3a"})
        self.store.audit("hold", {"until": T0 + 60})
        rows = self.store.recent_audit()
        self.assertEqual([r["event"] for r in rows], ["hold", "publish"])
        newest, oldest = rows
        self.assertIsInstance(newest["seq"], int)
        self.assertIsInstance(oldest["seq"], int)
        self.assertGreater(newest["seq"], oldest["seq"])


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
