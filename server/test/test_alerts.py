"""Firing an alert before the date: what is owed at an instant, and when.

The pair that matters is ``test_a_lead_that_passed_while_the_desk_was_down_still_fires``
and ``test_a_lead_whose_event_has_already_happened_does_not_fire``. They pull in
opposite directions -- look backwards, but not that far -- and they are written
together because either one alone is satisfied by a rule that gets the other
wrong. A desk that was off for six hours owes the owner the lead it missed; a
desk that was off for a day owes them nothing about a print that has already
been and gone.

Everything here steps over an instant rather than waiting for one, which is
what ``due`` being pure and ``Desk.tick`` taking a clock are both for. The
quiet-hours tests are the clearest case: the interesting moment is 07:00 in
Seoul, and a test that waited for it would run once a day.

Nothing here is a real push token, a real ticker or a real position. The tokens
come from ``test_push`` and are obviously invented, for the reason that file
gives: a token is a capability to write on somebody's lock screen, and this
repository is public.
"""

from __future__ import annotations

import datetime
import json
import logging
import os
import shutil
import tempfile
import unittest
from unittest import mock

from claudepost import alerts as A, calendar as C, positions as POS, push as P
from claudepost.app import Config, Desk, utc_stamp
from claudepost.clock import FixedClock
from claudepost.gates import StubGates
from claudepost.store import Store

# The document builders, taken from the modules' own test files rather than
# written again here: a second spelling of a valid book or a valid device is a
# second thing to keep in step with the validator, and the first divergence
# would look like a firing bug.
from test_calendar import book, event
from test_positions import book as position_book, option
from test_push import FakeExpo, TOKEN_A, TOKEN_B, device as a_device

# Both modules warn on the paths these tests provoke on purpose -- a batch that
# would not leave, a book that will not parse. Without a handler those go to
# stderr and a passing run reads like a failing one.
logging.getLogger("claudepost.app").addHandler(logging.NullHandler())
logging.getLogger("claudepost.alerts").addHandler(logging.NullHandler())

#: The only position the book below reasons about. `test_calendar.aff` names
#: it, and `parse_calendar` refuses a book whose `affects` point anywhere else.
KNOWN = frozenset({"p_1f05f8"})


def ts(text: str) -> float:
    """A ``2026-11-04T21:00:00Z`` instant as epoch seconds."""
    return datetime.datetime.strptime(text, "%Y-%m-%dT%H:%M:%SZ").replace(
        tzinfo=datetime.timezone.utc).timestamp()


def stamp(when: float) -> str:
    """The inverse: epoch seconds as the book spells an instant."""
    return datetime.datetime.fromtimestamp(
        int(when), datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


#: The instant every book here is validated against. Before the events, so
#: they are all inside `calendar.FUTURE_WINDOW` and none is inside
#: `PAST_WINDOW` -- the window is the validator's business and not this file's.
FILED = ts("2026-11-01T00:00:00Z")


def an_event(at: str = "2026-11-04T21:00:00Z", kind: str = "earnings",
             **over) -> dict:
    """One event, valid unless a keyword makes it otherwise."""
    doc = {"id": "e_ea01", "at": at, "kind": kind, "rank": 1}
    doc.update(over)
    return event(**doc)


def a_book(*events, **over) -> dict:
    """The book as the desk holds it: through the validator, not hand-built."""
    return C.parse_calendar(book(*events, **over), known_position_ids=KNOWN,
                            now=datetime.datetime.fromtimestamp(
                                FILED, datetime.timezone.utc))


def one_event(at: str = "2026-11-04T21:00:00Z", **over) -> dict:
    return a_book(an_event(at=at, **over))


def dev(token: str = TOKEN_A, quiet: dict | None = None, **over) -> dict:
    """One device as the desk holds it, with **no** quiet window unless asked.

    ``test_push.SPEC_DEVICE`` carries one, which is right for that file and
    wrong here: a window in every fixture would make every test about
    deferral, including the ones that are about the lead.
    """
    one = a_device(token=token, **over)
    one.pop("quiet", None)
    if quiet is not None:
        one["quiet"] = quiet
    return P.parse_devices({"devices": [one]})["devices"][0]


def rec(alert: A.Alert, at: float = FILED) -> dict:
    """A delivery ledger row for ``alert``, as the store returns one."""
    return {"token": alert.token, "event_id": alert.event_id,
            "lead": alert.lead, "at": at}


def the_positions(now: float) -> dict:
    """The one position `test_calendar`'s reasoning is about, id and all.

    Through the validator rather than hand-written, because the id is a hash
    of the contract: ``p_1f05f8`` is what ``test_positions``' own option
    fixture produces, and a book that named anything else would be refused on
    the desk's next boot.
    """
    doc = POS.parse_positions(position_book(option()),
                              today=datetime.datetime.fromtimestamp(
                                  now, datetime.timezone.utc).date())
    doc["updated_at"] = utc_stamp(now)
    return doc


def an_alert(at: float, token: str = TOKEN_A, event_id: str = "e_ea01",
             lead: str = "P1D", title: str = "실적 발표가 하루 남았어요",
             body: str = "내일 밤에 나와요") -> A.Alert:
    return A.Alert(token, event_id, lead, stamp(at), title, body)


# --------------------------------------------------------------------------
# What is owed
# --------------------------------------------------------------------------

class DueTest(unittest.TestCase):
    """The pure question: what does this desk owe which phone, at this instant."""

    def test_a_lead_fires_once_and_only_once(self):
        b = one_event(at="2026-11-04T21:00:00Z")
        d = dev(prefs={"earnings": True}, lead={"earnings": ["P1D"]})

        first = A.due(b, [d], delivered=[], now=ts("2026-11-03T21:00:01Z"))
        self.assertEqual(len(first), 1, first)
        self.assertEqual(first[0].lead, "P1D")

        again = A.due(b, [d], delivered=[rec(first[0])],
                      now=ts("2026-11-03T21:05:00Z"))
        self.assertEqual(again, [])

    def test_a_lead_that_passed_while_the_desk_was_down_still_fires(self):
        """A restart is not a reason to miss the owner's expiry."""
        b = one_event(at="2026-11-04T21:00:00Z")
        d = dev(lead={"earnings": ["P1D"]})

        late = A.due(b, [d], delivered=[], now=ts("2026-11-04T09:00:00Z"))
        self.assertEqual(len(late), 1, late)

    def test_a_lead_whose_event_has_already_happened_does_not_fire(self):
        b = one_event(at="2026-11-04T21:00:00Z")
        d = dev(lead={"earnings": ["P1D"]})

        self.assertEqual(
            A.due(b, [d], delivered=[], now=ts("2026-11-05T09:00:00Z")), [])

    def test_nothing_is_owed_before_the_lead_passes(self):
        b = one_event(at="2026-11-04T21:00:00Z")
        d = dev(lead={"earnings": ["P1D"]})

        self.assertEqual(
            A.due(b, [d], delivered=[], now=ts("2026-11-03T20:59:59Z")), [])
        self.assertEqual(
            len(A.due(b, [d], delivered=[], now=ts("2026-11-03T21:00:00Z"))), 1)

    def test_a_pref_turned_off_silences_its_kind_and_nothing_else(self):
        b = a_book(an_event(id="e_ea01", kind="earnings", rank=1),
                   an_event(id="e_dv01", kind="dividend", rank=2))
        d = dev(prefs={"earnings": False},
                lead={"earnings": ["P1D"], "dividend": ["P1D"]})

        owed = A.due(b, [d], delivered=[], now=ts("2026-11-03T21:00:01Z"))
        self.assertEqual([one.event_id for one in owed], ["e_dv01"])

    def test_a_kind_with_no_leads_at_all_is_silent(self):
        """An app that cleared every lead has said so, and is not overruled."""
        b = one_event()
        d = dev(lead={"earnings": []})

        self.assertEqual(
            A.due(b, [d], delivered=[], now=ts("2026-11-04T09:00:00Z")), [])

    def test_a_researched_event_fires_on_the_shared_switch(self):
        """An analyst day has no switch of its own; it answers to `researched`.

        The draft this replaces asserted the opposite -- that such an event can
        never fire -- which made the book able to rank a court date first and
        never mention it. The book ranks by effect on the positions, so the
        events somebody had to go and find are often the ones that matter most.
        """
        b = a_book(an_event(kind="corporate",
                            source="https://example.invalid/investor-day"))
        fired = A.due(b, [dev()], delivered=[],
                      now=ts("2026-11-04T09:00:00Z"))
        self.assertEqual([one.lead for one in fired], ["P1D"])

    def test_turning_the_shared_switch_off_silences_all_four(self):
        """One switch, and it means all of them -- the owner's question is
        "tell me about things somebody had to go and find", not a taxonomy."""
        off = dev(prefs={P.RESEARCHED: False})
        for kind in ("corporate", "legal", "index", "other"):
            with self.subTest(kind=kind):
                b = a_book(an_event(kind=kind,
                                    source="https://example.invalid/x"))
                self.assertEqual(
                    A.due(b, [off], delivered=[],
                          now=ts("2026-11-04T09:00:00Z")), [])

    def test_turning_it_off_does_not_silence_a_computed_kind(self):
        off = dev(prefs={P.RESEARCHED: False})
        self.assertTrue(A.due(one_event(at="2026-11-04T21:00:00Z"), [off],
                              delivered=[], now=ts("2026-11-03T21:00:01Z")))

    def test_two_leads_on_one_event_are_two_notifications(self):
        b = one_event(at="2026-11-04T21:00:00Z")
        d = dev(lead={"earnings": ["P2D", "P1D"]})

        early = A.due(b, [d], delivered=[], now=ts("2026-11-02T21:00:01Z"))
        self.assertEqual([one.lead for one in early], ["P2D"])

        later = A.due(b, [d], delivered=[rec(early[0])],
                      now=ts("2026-11-03T21:00:01Z"))
        self.assertEqual([one.lead for one in later], ["P1D"])

    def test_every_registered_phone_is_told(self):
        b = one_event()
        phones = [dev(TOKEN_A, lead={"earnings": ["P1D"]}),
                  dev(TOKEN_B, lead={"earnings": ["P1D"]})]

        owed = A.due(b, phones, delivered=[], now=ts("2026-11-04T09:00:00Z"))
        self.assertEqual(sorted(one.token for one in owed),
                         sorted([TOKEN_A, TOKEN_B]))

    def test_one_phones_delivery_does_not_silence_the_other(self):
        b = one_event()
        phones = [dev(TOKEN_A, lead={"earnings": ["P1D"]}),
                  dev(TOKEN_B, lead={"earnings": ["P1D"]})]
        told = {"token": TOKEN_A, "event_id": "e_ea01", "lead": "P1D",
                "at": FILED}

        owed = A.due(b, phones, delivered=[told], now=ts("2026-11-04T09:00:00Z"))
        self.assertEqual([one.token for one in owed], [TOKEN_B])

    def test_the_soonest_event_is_sent_first(self):
        """The order is the order to send in, so a batch cut at the cap cuts
        the least urgent."""
        b = a_book(an_event(id="e_late", at="2026-11-06T21:00:00Z", rank=1),
                   an_event(id="e_soon", at="2026-11-05T21:00:00Z", rank=2))
        d = dev(lead={"earnings": ["P7D"]})

        owed = A.due(b, [d], delivered=[], now=ts("2026-11-04T09:00:00Z"))
        self.assertEqual([one.event_id for one in owed], ["e_soon", "e_late"])

    def test_the_ledger_reads_as_rows_or_as_tuples(self):
        b = one_event()
        d = dev(lead={"earnings": ["P1D"]})
        now = ts("2026-11-04T09:00:00Z")

        self.assertEqual(
            A.due(b, [d], [(TOKEN_A, "e_ea01", "P1D")], now), [])
        self.assertEqual(
            A.due(b, [d], [{"token": TOKEN_A, "event_id": "e_ea01",
                            "lead": "P1D", "at": FILED}], now), [])

    def test_no_book_and_no_phone_are_states_not_errors(self):
        d = dev()
        self.assertEqual(A.due(None, [d], [], FILED), [])
        self.assertEqual(A.due(one_event(), [], [], FILED), [])
        self.assertEqual(A.due(a_book(), [d], [], FILED), [])


class CopyTest(unittest.TestCase):
    """Whose words reach the lock screen, and the one sentence the desk owns."""

    def owed(self, b, when="2026-11-04T09:00:00Z", **over):
        d = dev(lead={"earnings": ["P1D"]}, **over)
        return A.due(b, [d], delivered=[], now=ts(when))

    def test_the_agents_push_block_is_the_copy(self):
        wrote = {"title": "실적 발표가 하루 남았어요",
                 "body": "내일 밤 장 마감 뒤에 나와요. 콜 옵션은 변동성이 먼저 빠져요."}
        owed = self.owed(a_book(an_event(push=wrote)))

        self.assertEqual(owed[0].title, wrote["title"])
        self.assertEqual(owed[0].body, wrote["body"])

    def test_without_a_push_block_the_event_speaks_for_itself(self):
        """Still the agent's prose, in the owner's language -- never a
        sentence assembled here."""
        one = an_event()
        owed = self.owed(a_book(one))

        self.assertEqual(owed[0].title, one["title"])
        self.assertEqual(owed[0].body, one["affects"][0]["reason_short"])

    def test_the_alert_carries_the_instant_as_the_book_spells_it(self):
        owed = self.owed(one_event(at="2026-11-04T21:00:00Z"))
        self.assertEqual(owed[0].at_utc, "2026-11-04T21:00:00Z")

    def test_the_message_is_what_expo_takes(self):
        message = A.message(an_alert(ts("2026-11-04T21:00:00Z")))
        self.assertEqual(message["to"], TOKEN_A)
        self.assertEqual(message["data"], {"event_id": "e_ea01", "lead": "P1D",
                                           "at": "2026-11-04T21:00:00Z"})
        self.assertNotIn("\n", message["title"])


# --------------------------------------------------------------------------
# Quiet hours
# --------------------------------------------------------------------------

SEOUL_NIGHT = {"from": "23:00", "to": "07:00"}


class QuietTest(unittest.TestCase):
    """The window defers and never drops, which is two properties in two places."""

    def test_quiet_hours_defer_rather_than_drop(self):
        d = dev(tz="Asia/Seoul", quiet=SEOUL_NIGHT)
        alert = an_alert(ts("2026-11-04T15:30:00Z"))          # 00:30 KST

        when = A.defer_for_quiet(alert, d, now=ts("2026-11-04T15:30:00Z"))
        self.assertEqual(when, ts("2026-11-04T22:00:00Z"))    # 07:00 KST

    def test_outside_the_window_nothing_is_deferred(self):
        d = dev(tz="Asia/Seoul", quiet=SEOUL_NIGHT)
        alert = an_alert(ts("2026-11-04T03:00:00Z"))          # 12:00 KST

        self.assertIsNone(
            A.defer_for_quiet(alert, d, now=ts("2026-11-04T03:00:00Z")))

    def test_the_window_is_open_at_its_start_and_closed_at_its_end(self):
        d = dev(tz="Asia/Seoul", quiet=SEOUL_NIGHT)
        alert = an_alert(ts("2026-11-04T14:00:00Z"))

        # 23:00 KST exactly: the owner has asked not to be woken from here.
        self.assertEqual(
            A.defer_for_quiet(alert, d, now=ts("2026-11-04T14:00:00Z")),
            ts("2026-11-04T22:00:00Z"))
        # 07:00 KST exactly: they are awake, and the window is over.
        self.assertIsNone(
            A.defer_for_quiet(alert, d, now=ts("2026-11-04T22:00:00Z")))

    def test_a_window_that_does_not_wrap_midnight_reads_the_same_way(self):
        d = dev(tz="Asia/Seoul", quiet={"from": "09:00", "to": "18:00"})
        alert = an_alert(ts("2026-11-04T03:00:00Z"))

        self.assertEqual(                                    # 12:00 KST
            A.defer_for_quiet(alert, d, now=ts("2026-11-04T03:00:00Z")),
            ts("2026-11-04T09:00:00Z"))                      # 18:00 KST
        self.assertIsNone(                                   # 20:00 KST
            A.defer_for_quiet(alert, d, now=ts("2026-11-04T11:00:00Z")))

    def test_a_device_with_no_window_is_never_deferred(self):
        self.assertIsNone(A.defer_for_quiet(an_alert(FILED), dev(), now=FILED))

    def test_a_zone_this_machine_cannot_resolve_is_no_window_not_utc(self):
        """A wrong window is worse than none: it silences the alert the owner
        wanted at the hour they wanted it."""
        d = dict(dev(tz="Asia/Seoul", quiet=SEOUL_NIGHT), tz="Mars/Olympus")

        self.assertIsNone(
            A.defer_for_quiet(an_alert(ts("2026-11-04T15:30:00Z")), d,
                              now=ts("2026-11-04T15:30:00Z")))

    def test_a_lead_inside_the_window_is_owed_when_the_window_ends(self):
        # 00:30 KST on the 5th, an hour before a 01:30 KST event.
        b = one_event(at="2026-11-04T16:30:00Z")
        d = dev(tz="Asia/Seoul", quiet=SEOUL_NIGHT, lead={"earnings": ["PT1H"]})

        self.assertEqual(
            A.due(b, [d], [], ts("2026-11-04T15:35:00Z")), [],
            "an alert owed at 00:30 KST reached the lock screen")
        self.assertEqual(
            len(A.due(b, [d], [], ts("2026-11-04T22:00:00Z"))), 1)

    def test_an_event_that_happened_inside_the_window_is_still_delivered(self):
        """The exception to "nobody needs telling about yesterday". The owner
        asked not to be woken, not to be left uninformed."""
        b = one_event(at="2026-11-04T16:30:00Z")             # 01:30 KST
        d = dev(tz="Asia/Seoul", quiet=SEOUL_NIGHT, lead={"earnings": ["PT1H"]})

        owed = A.due(b, [d], [], ts("2026-11-04T22:00:00Z"))  # 07:00 KST
        self.assertEqual(len(owed), 1, owed)
        self.assertTrue(owed[0].body.startswith(A.ALREADY["ko"]),
                        owed[0].body)

    def test_the_marker_follows_the_books_language(self):
        b = a_book(an_event(at="2026-11-04T16:30:00Z"), lang="en")
        d = dev(tz="Asia/Seoul", quiet=SEOUL_NIGHT, lead={"earnings": ["PT1H"]})

        owed = A.due(b, [d], [], ts("2026-11-04T22:00:00Z"))
        self.assertTrue(owed[0].body.startswith(A.ALREADY["en"]), owed[0].body)

    def test_an_event_outside_the_window_is_not_resurrected_by_one(self):
        # The event is at 12:00 KST, nowhere near the night window; the desk
        # was simply down. This is the rule the exception above must not eat.
        b = one_event(at="2026-11-04T03:00:00Z")
        d = dev(tz="Asia/Seoul", quiet=SEOUL_NIGHT, lead={"earnings": ["PT1H"]})

        self.assertEqual(A.due(b, [d], [], ts("2026-11-04T22:00:00Z")), [])


# --------------------------------------------------------------------------
# The ledger
# --------------------------------------------------------------------------

class LedgerTest(unittest.TestCase):
    """One row per phone per event per lead, and it outlives the process."""

    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.path = os.path.join(self.dir.name, "desk.sqlite")
        self.clock = FixedClock(FILED)
        self.store = Store(self.path, self.clock)
        self.addCleanup(self.store.close)

    def test_a_delivery_is_written_and_read_back(self):
        self.store.record_delivery(TOKEN_A, "e_ea01", "P1D", FILED)
        rows = self.store.deliveries_since(FILED - 60)

        self.assertEqual([(r["token"], r["event_id"], r["lead"], r["at"])
                          for r in rows],
                         [(TOKEN_A, "e_ea01", "P1D", FILED)])

    def test_the_key_is_the_phone_the_event_and_the_lead(self):
        self.store.record_delivery(TOKEN_A, "e_ea01", "P1D", FILED)
        self.store.record_delivery(TOKEN_B, "e_ea01", "P1D", FILED)
        self.store.record_delivery(TOKEN_A, "e_dv01", "P1D", FILED)
        self.store.record_delivery(TOKEN_A, "e_ea01", "P7D", FILED)

        self.assertEqual(len(self.store.deliveries_since(FILED - 60)), 4)

    def test_recording_the_same_delivery_twice_keeps_the_first_instant(self):
        self.store.record_delivery(TOKEN_A, "e_ea01", "P1D", FILED)
        self.store.record_delivery(TOKEN_A, "e_ea01", "P1D", FILED + 3600)

        rows = self.store.deliveries_since(FILED - 60)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["at"], FILED)

    def test_the_read_is_bounded(self):
        self.store.record_delivery(TOKEN_A, "e_old", "P1D", FILED - 40 * 86400)
        self.store.record_delivery(TOKEN_A, "e_new", "P1D", FILED)

        rows = self.store.deliveries_since(FILED - A.LOOKBACK_SECONDS)
        self.assertEqual([r["event_id"] for r in rows], ["e_new"])

    def test_old_rows_are_reaped_and_recent_ones_are_not(self):
        self.store.record_delivery(TOKEN_A, "e_old", "P1D", FILED - 90 * 86400)
        self.store.record_delivery(TOKEN_A, "e_new", "P1D", FILED)

        self.assertEqual(
            self.store.reap_deliveries(FILED - A.RETENTION_SECONDS), 1)
        rows = self.store.deliveries_since(0)
        self.assertEqual([r["event_id"] for r in rows], ["e_new"])

    def test_the_ledger_survives_the_process_that_wrote_it(self):
        self.store.record_delivery(TOKEN_A, "e_ea01", "P1D", FILED)
        self.store.close()

        again = Store(self.path, FixedClock(FILED))
        self.addCleanup(again.close)
        self.assertEqual(len(again.deliveries_since(0)), 1)


# --------------------------------------------------------------------------
# The tick
# --------------------------------------------------------------------------

class FiringTest(unittest.TestCase):
    """`Desk.tick`: idempotent, capped, and it never dies of a failed push."""

    #: 03:00 KST, which is deliberately not near one of the default
    #: schedule's wakes (06:00, 12:40, 22:00). A tick that also enqueued a
    #: filing would make every assertion here read around an entry that has
    #: nothing to do with alerts.
    EVENT = "2026-11-04T18:00:00Z"
    START = ts("2026-11-03T18:00:01Z")          # a P1D lead has just passed

    def setUp(self):
        self.root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.root, True)
        self.data = os.path.join(self.root, "data")
        os.makedirs(self.data)

        self.clock = FixedClock(self.START)
        self.desk = self.a_desk()
        self.expo = self.desk.push_fetch

    def a_desk(self) -> Desk:
        """A desk on this test's data directory, wired to a fake Expo."""
        cfg = Config(data_dir=self.data,
                     tokens_path=os.path.join(self.root, "tokens.json"),
                     repo_dir=self.root, host="127.0.0.1", port=0)
        desk = Desk(cfg, clock=self.clock, gates=StubGates(sheets=()))
        self.addCleanup(desk.close)
        desk.push_fetch = FakeExpo()
        return desk

    def given(self, *devices, book=None):
        """A book, the phones to tell, and the positions the book is about.

        The positions are not decoration: ``calendar.load`` refuses a book
        whose reasoning names a position the desk does not hold, so a desk
        rebuilt on this data directory would come up with no book at all and
        every assertion about a restart would pass for the wrong reason.
        """
        self.desk.set_positions(the_positions(self.clock.now()))
        self.desk.set_calendar(book if book is not None
                               else one_event(at=self.EVENT))
        self.desk.set_push_devices(P.parse_devices(
            {"devices": list(devices or (dev(),))}))

    def sent(self, expo=None) -> list[dict]:
        """Every message that reached the fake Expo, across every call."""
        out = []
        for call in (expo or self.expo).calls:
            out.extend(json.loads(call["body"]))
        return out

    # -- the ordinary case -------------------------------------------------

    def test_the_alert_leaves_once_however_often_it_ticks(self):
        self.given()
        self.assertIn("alerts:1", self.desk.tick())
        for _ in range(10):
            self.clock.advance(5)
            self.assertNotIn("alerts:1", self.desk.tick())

        self.assertEqual(len(self.sent()), 1, self.sent())
        self.assertEqual(self.sent()[0]["to"], TOKEN_A)

    def test_a_tick_with_nothing_owed_opens_no_socket(self):
        self.given(book=one_event(at="2026-11-30T21:00:00Z"))
        self.assertEqual(self.desk.tick(), [])
        self.assertEqual(self.expo.calls, [])

    def test_a_desk_with_no_book_or_no_phone_sends_nothing(self):
        self.desk.set_calendar(one_event())
        self.assertEqual(self.expo.calls, [])
        self.desk.tick()
        self.assertEqual(self.expo.calls, [])

    def test_the_delivery_is_recorded_against_the_ledger(self):
        self.given()
        self.desk.tick()

        rows = self.desk.store.deliveries_since(0)
        self.assertEqual([(r["token"], r["event_id"], r["lead"]) for r in rows],
                         [(TOKEN_A, "e_ea01", "P1D")])

    def test_a_restart_does_not_deliver_the_same_alert_again(self):
        """The idempotency is the ledger and not something held in memory --
        a restart is exactly when a desk would tell somebody twice."""
        self.given()
        self.desk.tick()
        self.desk.close()

        self.clock.advance(60)
        self.desk = self.a_desk()
        self.assertIsNotNone(self.desk.calendar, "the book did not come back")
        self.assertEqual(len(self.desk.push_devices["devices"]), 1)

        self.assertNotIn("alerts:1", self.desk.tick())
        self.assertEqual(self.sent(self.desk.push_fetch), [])

    # -- failure -----------------------------------------------------------

    def test_a_batch_that_did_not_leave_is_owed_again_on_the_next_tick(self):
        self.desk.push_fetch = FakeExpo(fail=OSError("connection refused"))
        self.expo = self.desk.push_fetch
        self.given()

        self.assertEqual(self.desk.tick(), [])
        self.assertEqual(self.desk.store.deliveries_since(0), [])
        self.assertEqual(self.desk.state()["push"]["failures"], 1)

        self.clock.advance(5)
        self.desk.tick()
        self.assertEqual(self.desk.state()["push"]["failures"], 2)

        # And it goes as soon as the network does.
        self.desk.push_fetch = FakeExpo()
        self.clock.advance(5)
        self.assertIn("alerts:1", self.desk.tick())
        self.assertEqual(self.desk.state()["push"]["failures"], 0)
        self.assertEqual(len(self.desk.store.deliveries_since(0)), 1)

    def test_an_error_ticket_is_not_recorded_as_a_delivery(self):
        self.desk.push_fetch = FakeExpo(answer=b'{"data": [{"status": "error", '
                                               b'"message": "no"}]}')
        self.expo = self.desk.push_fetch
        self.given()

        self.assertEqual(self.desk.tick(), [])
        self.assertEqual(self.desk.store.deliveries_since(0), [])
        self.assertEqual(self.desk.state()["push"]["failures"], 1)

    def test_a_phone_expo_says_is_gone_is_forgotten(self):
        self.desk.push_fetch = FakeExpo(
            answer=b'{"data": [{"status": "error", "message": "gone", '
                   b'"details": {"error": "DeviceNotRegistered"}}]}')
        self.expo = self.desk.push_fetch
        self.given()

        self.desk.tick()
        self.assertEqual(self.desk.push_devices["devices"], [])
        # The streak went with it: a number about a phone that no longer
        # exists is not a signal.
        self.assertEqual(self.desk.state()["push"]["failures"], 0)

    def test_a_pass_that_raises_does_not_take_the_tick_down(self):
        """A scheduler that died on a push failure would stop publishing the
        newspaper."""
        self.given()
        with mock.patch.object(A, "due", side_effect=ValueError("nope")):
            with self.assertLogs("claudepost.app", level="WARNING") as logged:
                did = self.desk.tick()

        self.assertEqual(did, [])
        self.assertEqual(len(logged.records), 1, logged.output)

    def test_no_log_line_carries_a_push_token(self):
        self.desk.push_fetch = FakeExpo(fail=OSError(TOKEN_A + " refused"))
        self.expo = self.desk.push_fetch
        self.given()

        with self.assertLogs("claudepost", level="INFO") as logged:
            self.desk.tick()
        for line in logged.output:
            self.assertNotIn(TOKEN_A, line)
            self.assertNotIn("ExponentPushToken", line)

    # -- the cap and the quiet window --------------------------------------

    def test_one_tick_sends_one_post_and_owes_the_rest(self):
        b = a_book(an_event(id="e_ea01", at="2026-11-04T17:00:00Z", rank=1),
                   an_event(id="e_ea02", at="2026-11-04T18:00:00Z", rank=2))
        self.given(book=b)

        with mock.patch.object(A, "MAX_PER_TICK", 1):
            self.assertIn("alerts:1", self.desk.tick())
            self.assertEqual([one["data"]["event_id"] for one in self.sent()],
                             ["e_ea01"])
            self.clock.advance(5)
            self.assertIn("alerts:1", self.desk.tick())

        self.assertEqual([one["data"]["event_id"] for one in self.sent()],
                         ["e_ea01", "e_ea02"])

    def test_the_cap_is_one_expo_request(self):
        self.assertEqual(A.MAX_PER_TICK, P.MAX_BATCH)

    def test_a_desk_that_woke_inside_the_quiet_window_waits_for_the_morning(self):
        """`due` held nothing back here -- the lead passed at 21:00 KST, in
        the open. What holds it is the instant the desk noticed."""
        self.given(dev(tz="Asia/Seoul", quiet=SEOUL_NIGHT,
                       lead={"earnings": ["P1D"]}),
                   book=one_event(at="2026-11-04T12:00:00Z"))   # 21:00 KST

        self.clock.set(ts("2026-11-03T17:00:00Z"))              # 02:00 KST
        self.assertEqual(self.desk.tick(), [])
        self.assertEqual(self.expo.calls, [])

        self.clock.set(ts("2026-11-03T22:00:00Z"))              # 07:00 KST
        self.assertIn("alerts:1", self.desk.tick())

    def test_delivery_rows_are_reaped_by_the_housekeeping_pass(self):
        from claudepost.app import HOUSEKEEPING_SECONDS

        self.desk.tick()                      # the first pass takes its housekeeping
        self.desk.store.record_delivery(TOKEN_A, "e_old", "P1D",
                                        self.START - 90 * 86400)

        self.clock.advance(HOUSEKEEPING_SECONDS)
        self.assertIn("housekeeping:0/0/1", self.desk.tick())
        self.assertEqual(self.desk.store.deliveries_since(0), [])


if __name__ == "__main__":
    unittest.main()
