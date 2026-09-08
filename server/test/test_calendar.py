"""The event book, and the rule the whole feature rests on.

Four clauses, and the tests are grouped by them: an event carries its source; a
researched kind may not claim to be computed; the reasoning may only name a
position that exists; and the reasoning may not introduce a date. The fourth is
a heuristic and its tests say so -- what is asserted is that it catches an
asserted calendar day and lets a reference in words through.

The other property worth reading for: precision governs the fields beside it,
so the wire cannot carry a `day` event with a time of day on it. That one is a
rendering bug caught at the door, and the reader it protects is somebody who
checked the morning for a thing that happened in the evening.
"""

from __future__ import annotations

import datetime
import json
import os
import shutil
import tempfile
import unittest

from claudepost import calendar as C
from claudepost.errors import BadRequest

NOW = datetime.datetime(2026, 9, 8, 5, 0, 0, tzinfo=datetime.timezone.utc)
KNOWN = frozenset({"p_1f05f8", "p_3e3267"})


def aff(**over):
    doc = {"position_id": "p_1f05f8", "direction": "against",
           "reason": "금리 기대가 흔들리면 전력기기 설비투자 기대도 같이 움직여요. "
                     "만기가 74일 남은 롱 콜은 델타보다 베가가 큰 구간이라, "
                     "지수가 빠지면 방향이 맞아도 프리미엄이 먼저 줄어요.",
           "reason_short": "금리 기대가 흔들리면 전력기기 설비투자 기대도 같이 움직여요"}
    doc.update(over)
    return doc


def event(**over):
    doc = {"id": "e_91c2", "at": "2026-09-08T12:30:00Z", "precision": "exact",
           "title": "미국 8월 소비자물가지수", "kind": "econ",
           "source": "https://www.investing.com/economic-calendar/",
           "symbols": ["AAAA"], "affects": [aff()], "rank": 1}
    doc.update(over)
    return doc


def book(*events, **over):
    doc = {"lang": "ko", "target": 10, "events": list(events),
           "shortfall": None}
    doc.update(over)
    return doc


class SourceRuleTest(unittest.TestCase):
    """The rule this module exists for. See the module docstring."""

    def parse(self, doc):
        return C.parse_calendar(doc, known_position_ids=KNOWN, now=NOW)

    def refuses(self, doc, naming):
        with self.assertRaises(BadRequest) as caught:
            self.parse(doc)
        message = caught.exception.message or str(caught.exception)
        self.assertIn(naming, message)
        return message

    def test_an_event_without_a_source_is_refused(self):
        no_source = event()
        del no_source["source"]
        self.refuses(book(no_source), "source")

    def test_a_researched_event_must_carry_a_url_not_a_word(self):
        self.refuses(book(event(kind="corporate", source="the company said so")),
                     "source")

    def test_computed_is_only_legal_for_the_kinds_a_machine_knows(self):
        """An analyst day is not something the desk derives; an option expiry
        is -- the owner typed it."""
        self.refuses(book(event(kind="corporate", source="computed")), "source")
        ok = self.parse(book(event(kind="expiry", source="computed",
                                   precision="day",
                                   at="2026-11-21T00:00:00Z")))
        self.assertEqual(ok["events"][0]["source"], "computed")

    def test_a_computed_kind_may_still_carry_a_url(self):
        """`computed` means "no human read for this", not "this kind always
        comes from us". An earnings date found on the company's own IR page is
        more authoritative than one inferred from a feed, and a rule that
        refused it would push the agent to launder it as computed."""
        out = self.parse(book(event(
            kind="earnings", precision="session", session="amc",
            source="https://investor.example.com/events")))
        self.assertTrue(out["events"][0]["source"].startswith("https://"))

    def test_affects_may_not_name_a_position_that_does_not_exist(self):
        self.refuses(book(event(affects=[aff(position_id="p_ffffff")])),
                     "position_id")

    def test_a_position_id_that_is_not_one_is_refused_by_shape(self):
        self.refuses(book(event(affects=[aff(position_id="ETN")])),
                     "position_id")

    def test_an_event_with_no_reasoning_is_refused(self):
        """The other half of the floor, and the half a model under pressure to
        reach ten would drop first. An event with no `affects` is a generic
        calendar entry, and the phone already has one of those -- it shows two
        Yahoo dates. Leaving this optional would have made "a source AND a
        stated mechanism" only half enforced."""
        self.refuses(book(event(affects=[])), "affects")
        no_key = event()
        del no_key["affects"]
        self.refuses(book(no_key), "affects")


class ReasoningDateTest(unittest.TestCase):
    """The approximate clause. See `_DATE_IN_PROSE` and the module docstring:
    what is claimed is that an asserted calendar day is caught and a reference
    in words is not."""

    def parse(self, doc):
        return C.parse_calendar(doc, known_position_ids=KNOWN, now=NOW)

    def test_an_iso_date_in_a_reason_is_refused(self):
        with self.assertRaises(BadRequest) as caught:
            self.parse(book(event(affects=[
                aff(reason="2026-11-12에 신제품이 나와요")])))
        self.assertIn("reason", caught.exception.message)

    def test_a_korean_date_in_a_reason_is_refused(self):
        with self.assertRaises(BadRequest):
            self.parse(book(event(affects=[
                aff(reason="11월 12일에 신제품이 나와요")])))

    def test_the_short_reason_is_held_to_the_same_rule(self):
        with self.assertRaises(BadRequest):
            self.parse(book(event(affects=[
                aff(reason_short="11월 12일 신제품 발표")])))

    def test_referring_to_a_date_in_words_is_fine(self):
        """The book's own event is the date; the sentence may point at it."""
        out = self.parse(book(event(affects=[
            aff(reason="발표 다음 날 프리미엄이 가장 빨리 줄어요",
                reason_short="발표 다음 날 프리미엄이 줄어요")])))
        self.assertEqual(len(out["events"][0]["affects"]), 1)

    def test_a_figure_that_is_not_a_date_passes(self):
        """The regex has to leave ordinary numbers alone or the reasoning
        cannot talk about strikes, percentages or days remaining."""
        out = self.parse(book(event(affects=[
            aff(reason="만기까지 74일 남았고 IV는 32%에서 21%로 내려올 수 있어요",
                reason_short="만기 74일, IV 32%에서 21%로")])))
        self.assertEqual(len(out["events"][0]["affects"]), 1)

    def test_an_english_date_in_a_reason_is_refused_too(self):
        """`lang` may be `en`, and the reason this clause exists -- a wrong
        date in a sentence about the owner's own money -- does not know which
        language it is in. Every form a model actually writes one in."""
        for prose in ("The print on November 21 takes the extrinsic out.",
                      "Nov. 21 is when the extrinsic goes.",
                      "The print on 21 November takes the extrinsic out.",
                      "Filed 11/21/2026, a week before expiry.",
                      "Filed 2026/11/21, a week before expiry."):
            with self.subTest(prose=prose):
                with self.assertRaises(BadRequest) as caught:
                    self.parse(book(event(affects=[aff(reason=prose)])))
                self.assertIn("reason", caught.exception.message)

    def test_english_prose_that_is_not_a_date_passes(self):
        """The other half, and the half that decides whether widening was
        worth doing: a month with no day is the contract's name, a bare
        figure is a figure, and a reference in words is what the clause is
        for. Refusing any of these would push the agent to write worse
        English to get its book accepted."""
        for prose in ("The November contract loses its extrinsic first.",
                      "It may 다음 날 fall 21% on a 74-day view.",
                      "The day after the print is when vega bites.",
                      "A 3/4 delta position with 21 days to run."):
            with self.subTest(prose=prose):
                out = self.parse(book(event(affects=[
                    aff(reason=prose, reason_short=prose[:60])])))
                self.assertEqual(len(out["events"][0]["affects"]), 1)


class PrecisionTest(unittest.TestCase):
    def parse(self, doc):
        return C.parse_calendar(doc, known_position_ids=KNOWN, now=NOW)

    def refuses(self, doc, naming):
        with self.assertRaises(BadRequest) as caught:
            self.parse(doc)
        self.assertIn(naming, caught.exception.message)

    def test_a_day_event_may_not_carry_a_time_of_day(self):
        """The rendering bug caught at the door: a reader who checked the
        morning for something that happened in the evening."""
        self.refuses(book(event(kind="corporate",
                                source="https://example.com/ir",
                                precision="day",
                                at="2026-09-15T09:30:00Z")), "at")

    def test_a_day_event_has_no_session(self):
        self.refuses(book(event(precision="day", at="2026-09-15T00:00:00Z",
                                session="amc")), "session")

    def test_a_session_event_must_say_which_session(self):
        self.refuses(book(event(kind="earnings", precision="session",
                                source="computed")), "session")
        self.refuses(book(event(kind="earnings", precision="session",
                                session="lunchtime", source="computed")),
                     "session")

    def test_an_exact_event_has_no_session(self):
        self.refuses(book(event(session="amc")), "session")

    def test_a_session_instant_is_not_pinned_to_a_clock_time(self):
        """New York's sessions move twice a year, so the instant only has to be
        a real one -- the phone renders the word."""
        out = self.parse(book(event(kind="earnings", precision="session",
                                    session="amc", source="computed",
                                    at="2026-09-09T20:05:00Z")))
        self.assertEqual(out["events"][0]["session"], "amc")


class DocumentTest(unittest.TestCase):
    def parse(self, doc):
        return C.parse_calendar(doc, known_position_ids=KNOWN, now=NOW)

    def refuses(self, doc, naming):
        with self.assertRaises(BadRequest) as caught:
            self.parse(doc)
        self.assertIn(naming, caught.exception.message)

    def test_the_spec_event_parses(self):
        out = self.parse(book(event()))
        self.assertEqual(out["events"][0]["id"], "e_91c2")
        self.assertEqual(out["events"][0]["affects"][0]["direction"], "against")
        self.assertEqual(out["lang"], "ko")
        self.assertEqual(out["target"], 10)

    def test_an_empty_book_is_a_state_not_an_error(self):
        """The agent looked and nothing cleared the floor. That is a real
        morning, and `shortfall` is how it says so."""
        out = self.parse(book(shortfall="지금 확실한 일정이 없어요."))
        self.assertEqual(out["events"], [])
        self.assertEqual(out["shortfall"], "지금 확실한 일정이 없어요.")

    def test_generated_at_is_the_desks_to_stamp(self):
        out = self.parse(book(event(), generated_at="1999-01-01T00:00:00Z"))
        self.assertEqual(out["generated_at"], "")

    def test_a_rank_may_not_be_claimed_twice(self):
        """Rank is what the phone sorts by and what `target` cuts at, so a
        repeated one is two events with an equal claim on the tenth slot."""
        self.refuses(book(event(), event(id="e_aa02", rank=1)), "rank")

    def test_an_event_id_may_not_be_claimed_twice(self):
        self.refuses(book(event(), event(rank=2)), "id")

    def test_an_event_outside_the_window_is_refused(self):
        self.refuses(book(event(at="2026-08-01T12:30:00Z")), "at")
        self.refuses(book(event(at="2028-01-01T12:30:00Z")), "at")

    def test_an_event_that_just_fired_is_still_allowed(self):
        """The book is not rewritten the instant a print lands."""
        out = self.parse(book(event(at="2026-09-05T12:30:00Z")))
        self.assertEqual(len(out["events"]), 1)

    def test_an_unknown_key_is_refused_at_every_depth(self):
        self.refuses(book(event(), confidence=0.8), "unknown key")
        self.refuses(book(event(sentiment="bullish")), "unknown key")
        self.refuses(book(event(affects=[aff(weight=3)])), "unknown key")

    def test_a_push_is_optional_but_bounded_when_present(self):
        out = self.parse(book(event(push={"title": "오늘 밤 미국 CPI가 나와요",
                                          "body": "21:30에 발표예요."})))
        self.assertEqual(out["events"][0]["push"]["title"],
                         "오늘 밤 미국 CPI가 나와요")
        self.assertIsNone(self.parse(book(event()))["events"][0]["push"])
        self.refuses(book(event(push={"title": "x" * 61, "body": "y"})),
                     "title")

    def test_forty_one_events_is_refused(self):
        many = [event(id="e_%04d" % i, rank=i + 1) for i in range(41)]
        self.refuses(book(*many), "at most")

    def test_an_instant_must_end_in_z(self):
        self.refuses(book(event(at="2026-09-08T12:30:00+09:00")), "at")


class PruneTest(unittest.TestCase):
    """What happens to the book when the owner edits their positions.

    Neither of the two obvious answers: not "leave it and let the next boot
    refuse it", which serves dangling references for hours, and not "throw the
    book away", which loses nine true statements because a tenth stopped being
    about anything.
    """

    def parse(self, doc):
        return C.parse_calendar(doc, known_position_ids=KNOWN, now=NOW)

    def test_nothing_changes_when_every_position_still_exists(self):
        doc = self.parse(book(event(), event(id="e_aa02", rank=2)))
        pruned, events, affects = C.prune_to_positions(doc, KNOWN)
        self.assertEqual((events, affects), (0, 0))
        self.assertEqual(pruned["events"], doc["events"])

    def test_reasoning_about_a_closed_position_is_dropped(self):
        both = event(affects=[aff(position_id="p_1f05f8"),
                              aff(position_id="p_3e3267")])
        doc = self.parse(book(both))
        pruned, events, affects = C.prune_to_positions(doc, {"p_1f05f8"})
        self.assertEqual((events, affects), (0, 1))
        self.assertEqual([one["position_id"]
                          for one in pruned["events"][0]["affects"]],
                         ["p_1f05f8"])

    def test_an_event_with_no_reasoning_left_goes_too(self):
        """The same floor `_event` applies on the way in, applied again to a
        book the world moved underneath."""
        doc = self.parse(book(event(), event(
            id="e_aa02", rank=2,
            affects=[aff(position_id="p_3e3267")])))
        pruned, events, affects = C.prune_to_positions(doc, {"p_1f05f8"})
        self.assertEqual((events, affects), (1, 1))
        self.assertEqual([e["id"] for e in pruned["events"]], ["e_91c2"])

    def test_what_survives_is_something_load_would_accept(self):
        """The property the whole function exists for: after a prune, what the
        desk holds in memory is a document it would take off disk."""
        doc = self.parse(book(event(), event(
            id="e_aa02", rank=2, affects=[aff(position_id="p_3e3267")])))
        pruned, _, _ = C.prune_to_positions(doc, {"p_1f05f8"})
        self.assertTrue(C.parse_calendar(pruned,
                                         known_position_ids={"p_1f05f8"},
                                         now=NOW)["events"])

    def test_the_original_is_left_alone(self):
        doc = self.parse(book(event()))
        C.prune_to_positions(doc, frozenset())
        self.assertEqual(len(doc["events"]), 1)
        self.assertEqual(len(doc["events"][0]["affects"]), 1)

    def test_it_only_drops_what_it_can_prove(self):
        """It runs in two places -- after a positions edit, on a document this
        module produced, and inside `load`, on JSON nobody has checked yet.
        `prune_to_window` states the discipline the second one needs and this
        one holds to it: an entry it cannot read is left for the refusal that
        names the field, and an `affects` that is empty or is not a list is a
        malformed event rather than an event with nothing left."""
        raw = book({"id": "e_bad", "affects": ["not an entry",
                                               {"position_id": 7}]},
                   {"id": "e_none", "affects": []},
                   {"id": "e_nolist", "affects": "p_1f05f8"})
        pruned, events, affects = C.prune_to_positions(raw, frozenset())
        self.assertEqual((events, affects), (0, 0))
        self.assertEqual(pruned["events"], raw["events"])


class WindowTest(unittest.TestCase):
    """What happens to the book when nobody edits anything and time passes.

    `PruneTest`'s argument, applied to the other thing that moves underneath a
    filed book: the clock. An edition of the book does not stop being true
    because the first of its ten events is now nine days old, and refusing it
    whole for that is how a week of agent silence plus one restart turns a book
    with nine live events into no book at all -- silently, every alert in it
    stopped, `GET /api/calendar` answering `null`.
    """

    LATER = NOW + datetime.timedelta(days=9)

    def parse(self, doc):
        return C.parse_calendar(doc, known_position_ids=KNOWN, now=NOW)

    def test_nothing_moves_while_every_event_is_still_in_the_window(self):
        doc = self.parse(book(event(), event(id="e_aa02", rank=2)))
        pruned, dropped = C.prune_to_window(doc, NOW)
        self.assertEqual(dropped, 0)
        self.assertEqual(pruned["events"], doc["events"])

    def test_an_event_the_clock_carried_out_of_the_window_is_dropped(self):
        doc = self.parse(book(event(), event(id="e_aa02", rank=2,
                                             at="2026-10-08T12:30:00Z")))
        pruned, dropped = C.prune_to_window(doc, self.LATER)
        self.assertEqual(dropped, 1)
        self.assertEqual([one["id"] for one in pruned["events"]], ["e_aa02"])

    def test_it_only_drops_what_it_can_prove(self):
        """It runs before the validator, on a document nobody has checked, so
        an event it cannot read is left exactly where it is for the refusal
        that names the field. This drops what the clock falsified, never what
        is malformed."""
        raw = book({"id": "e_junk"}, {"id": "e_bad", "at": "yesterday"},
                   "not an event at all")
        pruned, dropped = C.prune_to_window(raw, self.LATER)
        self.assertEqual(dropped, 0)
        self.assertEqual(pruned["events"], raw["events"])

    def test_the_original_is_left_alone(self):
        doc = self.parse(book(event()))
        C.prune_to_window(doc, self.LATER)
        self.assertEqual(len(doc["events"]), 1)

    def test_what_survives_is_something_parse_would_accept(self):
        doc = self.parse(book(event(), event(id="e_aa02", rank=2,
                                             at="2026-10-08T12:30:00Z")))
        pruned, _ = C.prune_to_window(doc, self.LATER)
        self.assertTrue(C.parse_calendar(pruned, known_position_ids=KNOWN,
                                         now=self.LATER)["events"])


class FileTest(unittest.TestCase):
    """`load`, which answers with the book *and* what it cost to hold it.

    Two things move underneath a filed book and this function answers for both:
    the clock, and the positions it argues about. Neither may turn a stale book
    into no book, and a `Dropped` that is all zeroes is what says the book on
    disk is the book in memory.

    Every call passes `now`: the window is measured from an injected instant
    everywhere else in this module, and a test that let the wall clock in would
    be asserting on today's date rather than on the fixture's.
    """

    LATER = NOW + datetime.timedelta(days=9)

    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.path = os.path.join(self.dir, "calendar.json")

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def saved(self, *events, **over):
        doc = C.parse_calendar(book(*events, **over),
                               known_position_ids=KNOWN, now=NOW)
        C.save(self.path, {**doc, "generated_at": "2026-09-08T05:00:00Z"})
        return doc

    def test_nobody_has_filed_a_book_yet(self):
        self.assertEqual(C.load(self.path, known_position_ids=KNOWN, now=NOW),
                         (None, C.Dropped()))

    def test_a_saved_book_loads_back_identically(self):
        doc = self.saved(event())
        back, dropped = C.load(self.path, known_position_ids=KNOWN, now=NOW)
        self.assertEqual((back["events"], dropped),
                         (doc["events"], C.Dropped()))
        self.assertEqual(back["generated_at"], "2026-09-08T05:00:00Z")

    def test_one_aged_event_does_not_cost_the_desk_the_other_one(self):
        """The defect: a boot must not be able to turn a stale book into no
        book. Nine live events and one that has passed is nine live events."""
        self.saved(event(), event(id="e_aa02", rank=2,
                                  at="2026-10-08T12:30:00Z"))
        back, dropped = C.load(self.path, known_position_ids=KNOWN,
                               now=self.LATER)
        self.assertEqual([one["id"] for one in back["events"]], ["e_aa02"])
        self.assertEqual(dropped, C.Dropped(aged=1))

    def test_a_book_that_has_aged_out_whole_is_no_book_and_says_how_many(self):
        """Nothing survived, so there is no book -- `set_positions` reaches
        the same answer from the other direction. What the count is for is the
        log line and `/api/state`: "the ten events in it have all happened" and
        "nobody has ever filed one" are both no book, and a desk that reported
        them identically would be the silence this whole defect was."""
        self.saved(event())
        self.assertEqual(C.load(self.path, known_position_ids=KNOWN,
                                now=self.LATER), (None, C.Dropped(aged=1)))

    def test_a_book_about_a_position_the_owner_closed_loses_that_event_only(self):
        """It used to lose the whole book, and that was the same defect the
        window had: one event stops being about anything and nine true
        statements go with it. `set_positions` prunes at the moment the
        position closes, so reaching here needs `positions.json` edited from
        outside the desk -- a smaller probability than the window's, not a
        smaller cost."""
        self.saved(event(), event(id="e_aa02", rank=2,
                                  affects=[aff(position_id="p_3e3267")]))
        back, dropped = C.load(self.path,
                               known_position_ids={"p_3e3267"}, now=NOW)
        self.assertEqual([one["id"] for one in back["events"]], ["e_aa02"])
        # `reasons` counts the entry inside the event that went, too -- it is
        # `prune_to_positions`' own second number. See `Dropped`.
        self.assertEqual(dropped, C.Dropped(orphaned=1, reasons=1))

    def test_an_event_keeps_the_reasoning_that_is_still_true(self):
        both = event(affects=[aff(position_id="p_1f05f8"),
                              aff(position_id="p_3e3267")])
        self.saved(both)
        back, dropped = C.load(self.path,
                               known_position_ids={"p_1f05f8"}, now=NOW)
        self.assertEqual([one["position_id"]
                          for one in back["events"][0]["affects"]],
                         ["p_1f05f8"])
        self.assertEqual(dropped, C.Dropped(reasons=1))

    def test_a_book_only_about_closed_positions_is_no_book_and_says_which(self):
        """No book either way, and the count says why -- the same courtesy the
        aged case gets, and for the same reason: "nobody ever filed one" wants
        a different reaction from "everything it argued about is gone"."""
        self.saved(event())
        self.assertEqual(C.load(self.path, known_position_ids=frozenset(),
                                now=NOW), (None, C.Dropped(orphaned=1,
                                                           reasons=1)))

    def test_the_file_is_not_world_readable(self):
        """Every reason in it is a sentence about what the owner holds."""
        doc = C.parse_calendar(book(event()), known_position_ids=KNOWN, now=NOW)
        C.save(self.path, doc)
        self.assertEqual(os.stat(self.path).st_mode & 0o077, 0)

    def test_a_file_that_will_not_parse_is_left_where_it_is(self):
        with open(self.path, "w") as f:
            f.write("{not json")
        self.assertEqual(C.load(self.path, known_position_ids=KNOWN, now=NOW),
                         (None, C.Dropped()))
        self.assertTrue(os.path.exists(self.path))

    def test_an_aged_book_is_left_on_disk_as_it_was_filed(self):
        """`load` is a read. Rewriting the file to match what was kept would
        move an mtime that says when research last ran, on every boot, to say
        something else -- and the next filing overwrites it whole anyway."""
        self.saved(event())
        before = open(self.path, "rb").read()
        C.load(self.path, known_position_ids=KNOWN, now=self.LATER)
        self.assertEqual(open(self.path, "rb").read(), before)


if __name__ == "__main__":
    unittest.main()
