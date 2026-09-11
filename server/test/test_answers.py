"""The push that is not about the event book: an answer to a typed message.

Everything here steps over an instant rather than waiting for one, the same way
``test_alerts.py`` does and for the same reason -- the interesting moment is
07:00 in Seoul, and a test that waited for it would run once a day.

Nothing here is a real push token. They come from ``test_push``, obviously
invented, because a token is a capability to write on somebody's lock screen
and this repository is public.
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import tempfile
import unittest

from claudepost import push as P
from claudepost.app import (ANSWER_WINDOW_SECONDS, HOUSEKEEPING_SECONDS,
                            PHONE_SOURCE, Config, Desk)
from claudepost.clock import FixedClock
from claudepost.gates import StubGates

from test_alerts import SEOUL_NIGHT, dev, ts
from test_push import FakeExpo, TOKEN_A, TOKEN_B

# The desk warns when a push does not leave, which two cases here provoke on
# purpose. Without a handler that goes to stderr and a passing run reads like a
# failing one.
logging.getLogger("claudepost.app").addHandler(logging.NullHandler())

#: A Wednesday afternoon in Seoul -- 15:00 KST, nowhere near a quiet window and
#: nowhere near one of the default schedule's wakes, so a tick that also
#: enqueued a filing cannot make an assertion here read around it.
START = ts("2026-11-04T06:00:00Z")


class AnswerTestCase(unittest.TestCase):
    """A desk on a temporary root, wired to a fake Expo."""

    def setUp(self):
        self.root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.root, True)
        self.data = os.path.join(self.root, "data")
        os.makedirs(self.data)

        self.clock = FixedClock(START)
        self.desk = self.a_desk()
        self.expo = self.desk.push_fetch

    def a_desk(self) -> Desk:
        cfg = Config(data_dir=self.data,
                     tokens_path=os.path.join(self.root, "tokens.json"),
                     repo_dir=self.root, host="127.0.0.1", port=0)
        desk = Desk(cfg, clock=self.clock, gates=StubGates(sheets=()))
        self.addCleanup(desk.close)
        desk.push_fetch = FakeExpo()
        return desk

    def given(self, *devices):
        self.desk.set_push_devices(P.parse_devices(
            {"devices": list(devices or (dev(),))}))

    def asked(self, text="왜 그 회사예요?", source=PHONE_SOURCE, **kw) -> str:
        """One message on the queue, claimed, ready to be finished."""
        cid = self.desk.enqueue("ask", text, source=source, **kw)["id"]
        self.desk.store.claim_command("w")
        return cid

    def sent(self, expo=None) -> list[dict]:
        out = []
        for call in (expo or self.expo).calls:
            out.extend(json.loads(call["body"]))
        return out


class AnswerPushTest(AnswerTestCase):

    def test_a_finished_message_from_the_phone_rings_the_phone(self):
        self.given()
        cid = self.asked(lang="ko")
        self.desk.finish(cid, "done", "answered")

        [message] = self.sent()
        self.assertEqual(message["to"], TOKEN_A)
        self.assertEqual(message["title"], "Claude Post")
        self.assertEqual(message["body"], "답변이 도착했습니다")
        self.assertEqual(message["data"],
                         {"command_id": cid, "result": "answered"})

    def test_the_language_is_the_one_the_phone_was_in(self):
        self.given()
        cid = self.asked(lang="en", text="why this company?")
        self.desk.finish(cid, "done", "answered")
        self.assertEqual(self.sent()[0]["body"], "Your answer is ready")

    def test_a_message_with_no_language_falls_back_to_the_desk_s_own(self):
        # NULL means "the language of the message itself", which the desk
        # cannot read. Its own setting is the best proxy it has, and it is
        # already the language the paper is written in.
        self.desk.set_settings({"lang": "ko"})
        self.given()
        cid = self.asked()
        self.desk.finish(cid, "done", "answered")
        self.assertEqual(self.sent()[0]["body"], "답변이 도착했습니다")

    def test_a_revision_carries_only_the_first_word(self):
        """The desk does not parse `result`; it forwards enough for the phone
        to know which screen to open and re-reads the row for the rest."""
        self.given()
        cid = self.asked(lang="en")
        self.desk.finish(cid, "done", "revised 3f2a91bb")
        self.assertEqual(self.sent()[0]["data"]["result"], "revised")

    def test_a_failure_says_so_rather_than_promising_an_answer(self):
        self.given()
        cid = self.asked(lang="en")
        self.desk.finish(cid, "failed", "no answer written")
        self.assertEqual(self.sent()[0]["body"],
                         "The desk could not answer that")

    def test_nothing_rings_for_a_command_the_phone_did_not_file(self):
        self.given()
        for source in ("api", "schedule", ""):
            with self.subTest(source=source):
                cid = self.asked(source=source)
                self.desk.finish(cid, "done", "answered")
        self.assertEqual(self.expo.calls, [])

    def test_a_phone_that_turned_the_switch_off_is_not_told(self):
        self.given(dev(prefs={P.ANSWER: False}))
        cid = self.asked()
        self.desk.finish(cid, "done", "answered")
        self.assertEqual(self.expo.calls, [])

    def test_every_registered_phone_is_told_once(self):
        self.given(dev(TOKEN_A), dev(TOKEN_B))
        cid = self.asked()
        self.desk.finish(cid, "done", "answered")
        self.assertEqual(sorted(m["to"] for m in self.sent()),
                         sorted([TOKEN_A, TOKEN_B]))

    def test_the_delivery_is_recorded_against_the_ledger(self):
        self.given()
        cid = self.asked()
        self.desk.finish(cid, "done", "answered")

        rows = self.desk.store.deliveries_since(0)
        self.assertEqual([(r["token"], r["event_id"], r["lead"]) for r in rows],
                         [(TOKEN_A, "cmd:" + cid, P.ANSWER_LEAD)])

    def test_the_ledger_key_cannot_collide_with_an_event(self):
        self.assertTrue(P.answer_event_id("abc123").startswith("cmd:"))

    def test_a_second_send_for_the_same_command_is_suppressed(self):
        self.given()
        cid = self.asked()
        self.desk.finish(cid, "done", "answered")
        self.desk._send_answer(self.desk.command(cid), self.clock.now())
        self.assertEqual(len(self.sent()), 1, self.sent())

    def test_a_push_that_will_not_leave_does_not_fail_the_worker_s_report(self):
        """`POST /done` is the worker's own call and its 200 is what stops the
        worker retrying. A phone that does not ring costs an answer somebody
        opens the app for; a `done` that 500s costs the whole command again."""
        self.desk.push_fetch = FakeExpo(fail=OSError("connection refused"))
        self.given()
        cid = self.asked()

        command = self.desk.finish(cid, "done", "answered")
        self.assertEqual(command["status"], "done")
        self.assertEqual(self.desk.store.deliveries_since(0), [])


class DeferredAnswerTest(AnswerTestCase):
    """An answer that landed at three in the morning is owed, not lost."""

    #: 02:00 KST on a Wednesday: inside `SEOUL_NIGHT`, and the release is 07:00
    #: the same morning.
    NIGHT = ts("2026-11-03T17:00:00Z")
    MORNING = ts("2026-11-03T22:00:00Z")

    def setUp(self):
        super().setUp()
        self.clock.set(self.NIGHT)
        self.given(dev(tz="Asia/Seoul", quiet=SEOUL_NIGHT))

    def test_nothing_leaves_while_the_phone_is_quiet(self):
        cid = self.asked(lang="en")
        self.desk.finish(cid, "done", "answered")

        self.assertEqual(self.expo.calls, [])
        # Nothing recorded, which is precisely what leaves it owed.
        self.assertEqual(self.desk.store.deliveries_since(0), [])

    def test_it_goes_on_the_first_housekeeping_pass_after_the_window(self):
        cid = self.asked(lang="en")
        self.desk.finish(cid, "done", "answered")

        self.desk.tick()                    # the first pass takes housekeeping
        self.clock.set(self.MORNING)
        self.assertIn("answers:1", self.desk.tick())

        [message] = self.sent()
        self.assertEqual(message["data"]["command_id"], cid)
        self.assertEqual(message["body"], "Your answer is ready")

    def test_it_goes_once_however_often_the_desk_ticks(self):
        cid = self.asked(lang="en")
        self.desk.finish(cid, "done", "answered")
        self.desk.tick()

        self.clock.set(self.MORNING)
        self.desk.tick()
        for _ in range(5):
            self.clock.advance(HOUSEKEEPING_SECONDS)
            self.assertNotIn("answers:1", self.desk.tick())
        self.assertEqual(len(self.sent()), 1, self.sent())

    def test_a_restart_inside_the_window_still_owes_the_answer(self):
        """The idempotency and the debt are both the ledger, not memory. A
        restart is exactly when a desk would either forget or repeat."""
        cid = self.asked(lang="en")
        self.desk.finish(cid, "done", "answered")
        self.desk.close()

        self.clock.set(self.MORNING)
        self.desk = self.a_desk()
        self.assertEqual(len(self.desk.push_devices["devices"]), 1)
        self.assertIn("answers:1", self.desk.tick())
        self.assertEqual(len(self.sent(self.desk.push_fetch)), 1)

    def test_an_answer_older_than_the_window_is_not_owed_forever(self):
        cid = self.asked(lang="en")
        self.desk.finish(cid, "done", "answered")
        self.desk.tick()

        self.clock.advance(ANSWER_WINDOW_SECONDS + HOUSEKEEPING_SECONDS)
        self.assertNotIn("answers:1", self.desk.tick())
        self.assertEqual(self.expo.calls, [])

    def test_the_pass_costs_nothing_on_a_desk_with_no_phone(self):
        self.desk.set_push_devices(P.parse_devices({"devices": []}))
        cid = self.asked(lang="en")
        self.desk.finish(cid, "done", "answered")
        self.clock.set(self.MORNING)
        self.assertNotIn("answers:1", self.desk.tick())
