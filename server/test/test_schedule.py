"""The schedule's arithmetic, held to the boundaries rather than the middle.

Every test names an instant instead of waiting for one, which is the whole
reason `schedule` takes an epoch float and never reads a clock.
"""

import unittest
from datetime import datetime
from zoneinfo import ZoneInfo

from wpdesk import schedule as S
from wpdesk.errors import DeskError

KST = ZoneInfo("Asia/Seoul")


def at(y, mo, d, h, mi, tz=KST):
    """The epoch instant of a local wall-clock time, as the schedule reads it."""
    return datetime(y, mo, d, h, mi, tzinfo=tz).timestamp()


class ParseTest(unittest.TestCase):
    def test_the_default_round_trips(self):
        self.assertEqual(
            S.parse_schedule(S.schedule_to_dict(S.DEFAULT_SCHEDULE)), S.DEFAULT_SCHEDULE)

    def test_an_unknown_timezone_is_rejected_by_name(self):
        doc = S.schedule_to_dict(S.DEFAULT_SCHEDULE) | {"timezone": "Mars/Olympus"}
        with self.assertRaises(DeskError) as e:
            S.parse_schedule(doc)
        self.assertIn("timezone", str(e.exception))

    def test_poll_seconds_outside_the_devices_range_are_rejected(self):
        for bad in (29, 86401):
            doc = S.schedule_to_dict(S.DEFAULT_SCHEDULE)
            doc["poll"]["active_seconds"] = bad
            with self.assertRaises(DeskError):
                S.parse_schedule(doc)

    def test_a_bad_clock_string_is_rejected(self):
        for bad in ("24:00", "6:00", "0600", "06:60", ""):
            doc = S.schedule_to_dict(S.DEFAULT_SCHEDULE)
            doc["wake"] = [bad]
            with self.assertRaises(DeskError):
                S.parse_schedule(doc)

    def test_an_unknown_publish_policy_is_rejected_rather_than_defaulted(self):
        doc = S.schedule_to_dict(S.DEFAULT_SCHEDULE)
        doc["publish"]["policy"] = "whenever"
        with self.assertRaises(DeskError):
            S.parse_schedule(doc)

    def test_a_wake_entry_may_name_days(self):
        doc = S.schedule_to_dict(S.DEFAULT_SCHEDULE)
        doc["wake"] = [{"at": "07:00", "days": "sat,sun"}]
        s = S.parse_schedule(doc)
        self.assertEqual(s.wake[0].days, frozenset({5, 6}))

    def test_a_day_filtered_wake_round_trips_too(self):
        """The named-day form is the one a round trip could quietly widen."""
        doc = S.schedule_to_dict(S.DEFAULT_SCHEDULE) | {
            "wake": [{"at": "07:00", "days": "sat,sun"}]}
        s = S.parse_schedule(doc)
        self.assertEqual(S.parse_schedule(S.schedule_to_dict(s)), s)

    def test_a_schedule_that_is_not_an_object_is_rejected(self):
        for bad in ([], "00:30", 7, None):
            with self.assertRaises(DeskError):
                S.parse_schedule(bad)

    def test_a_misspelled_key_is_refused_rather_than_ignored(self):
        """A typo that silently keeps the old value is unfindable from the wall."""
        doc = S.schedule_to_dict(S.DEFAULT_SCHEDULE)
        doc["weke"] = ["07:00"]
        with self.assertRaises(DeskError) as e:
            S.parse_schedule(doc)
        self.assertIn("weke", str(e.exception))

    def test_an_unknown_day_name_is_rejected(self):
        doc = S.schedule_to_dict(S.DEFAULT_SCHEDULE) | {
            "wake": [{"at": "07:00", "days": "caturday"}]}
        with self.assertRaises(DeskError):
            S.parse_schedule(doc)

    def test_more_windows_than_the_contract_allows_are_rejected(self):
        doc = S.schedule_to_dict(S.DEFAULT_SCHEDULE) | {
            "quiet": [{"from": "0%d:00" % h, "to": "0%d:30" % h} for h in range(1, 6)]}
        with self.assertRaises(DeskError):
            S.parse_schedule(doc)

    def test_a_min_gap_outside_a_day_is_rejected(self):
        for bad in (-1, 1441):
            doc = S.schedule_to_dict(S.DEFAULT_SCHEDULE)
            doc["publish"]["min_gap_minutes"] = bad
            with self.assertRaises(DeskError):
                S.parse_schedule(doc)

    def test_a_boolean_is_not_an_integer_here(self):
        """`True` is an int in Python and must not pass for a cadence."""
        doc = S.schedule_to_dict(S.DEFAULT_SCHEDULE)
        doc["poll"]["quiet_seconds"] = True
        with self.assertRaises(DeskError):
            S.parse_schedule(doc)

    def test_the_message_names_the_field_that_was_wrong(self):
        """The message lands in schedule.errors.md; one without a path is useless."""
        doc = S.schedule_to_dict(S.DEFAULT_SCHEDULE)
        doc["quiet"] = [{"from": "00:30", "to": "6 pm"}]
        with self.assertRaises(DeskError) as e:
            S.parse_schedule(doc)
        self.assertIn("quiet[0].to", str(e.exception))


class QuietTest(unittest.TestCase):
    def test_a_window_that_wraps_midnight_covers_both_sides(self):
        s = S.DEFAULT_SCHEDULE                     # 00:30 -> 06:00
        self.assertTrue(S.is_quiet(s, at(2026, 8, 19, 1, 0)))
        self.assertTrue(S.is_quiet(s, at(2026, 8, 19, 5, 59)))
        self.assertFalse(S.is_quiet(s, at(2026, 8, 19, 6, 0)))
        self.assertFalse(S.is_quiet(s, at(2026, 8, 19, 0, 29)))

    def test_the_end_of_a_window_is_the_instant_it_stops_being_quiet(self):
        s = S.DEFAULT_SCHEDULE
        self.assertEqual(S.quiet_ends_at(s, at(2026, 8, 19, 1, 0)),
                         at(2026, 8, 19, 6, 0))

    def test_outside_a_window_there_is_no_end(self):
        self.assertIsNone(S.quiet_ends_at(S.DEFAULT_SCHEDULE, at(2026, 8, 19, 9, 0)))

    def test_a_window_written_backwards_across_midnight_is_still_one_window(self):
        s = S.parse_schedule(S.schedule_to_dict(S.DEFAULT_SCHEDULE)
                             | {"quiet": [{"from": "23:00", "to": "01:00"}]})
        self.assertTrue(S.is_quiet(s, at(2026, 8, 19, 23, 30)))
        self.assertTrue(S.is_quiet(s, at(2026, 8, 19, 0, 30)))
        self.assertFalse(S.is_quiet(s, at(2026, 8, 19, 12, 0)))

    def test_a_wrapping_window_ends_the_following_morning(self):
        s = S.parse_schedule(S.schedule_to_dict(S.DEFAULT_SCHEDULE)
                             | {"quiet": [{"from": "23:00", "to": "01:00"}]})
        self.assertEqual(S.quiet_ends_at(s, at(2026, 8, 19, 23, 30)),
                         at(2026, 8, 20, 1, 0))
        self.assertEqual(S.quiet_ends_at(s, at(2026, 8, 19, 0, 30)),
                         at(2026, 8, 19, 1, 0))

    def test_a_window_of_zero_length_is_no_window_at_all(self):
        """Start == end is what somebody types for "none", not for "all day"."""
        s = S.parse_schedule(S.schedule_to_dict(S.DEFAULT_SCHEDULE)
                             | {"quiet": [{"from": "03:00", "to": "03:00"}]})
        self.assertFalse(S.is_quiet(s, at(2026, 8, 19, 3, 0)))
        self.assertFalse(S.is_quiet(s, at(2026, 8, 19, 3, 30)))
        self.assertIsNone(S.quiet_ends_at(s, at(2026, 8, 19, 3, 0)))

    def test_two_abutting_windows_end_once(self):
        """The caller asked when it stops being quiet, not when a window does."""
        s = S.parse_schedule(S.schedule_to_dict(S.DEFAULT_SCHEDULE)
                             | {"quiet": [{"from": "00:30", "to": "06:00"},
                                          {"from": "06:00", "to": "08:00"}]})
        self.assertEqual(S.quiet_ends_at(s, at(2026, 8, 19, 1, 0)),
                         at(2026, 8, 19, 8, 0))


class WakeTest(unittest.TestCase):
    def test_the_next_wake_is_the_next_one_today_or_the_first_tomorrow(self):
        s = S.DEFAULT_SCHEDULE                     # 06:00, 12:40, 22:00
        self.assertEqual(S.next_wake(s, at(2026, 8, 19, 7, 0)),
                         at(2026, 8, 19, 12, 40))
        self.assertEqual(S.next_wake(s, at(2026, 8, 19, 23, 0)),
                         at(2026, 8, 20, 6, 0))

    def test_a_wake_exactly_now_is_not_the_next_one(self):
        s = S.DEFAULT_SCHEDULE
        self.assertEqual(S.next_wake(s, at(2026, 8, 19, 6, 0)),
                         at(2026, 8, 19, 12, 40))

    def test_day_filtered_wakes_skip_the_days_they_exclude(self):
        s = S.parse_schedule(S.schedule_to_dict(S.DEFAULT_SCHEDULE)
                             | {"wake": [{"at": "07:00", "days": "sat"}]})
        # 2026-08-19 is a Wednesday; the next Saturday is the 22nd.
        self.assertEqual(S.next_wake(s, at(2026, 8, 19, 9, 0)),
                         at(2026, 8, 22, 7, 0))

    def test_a_weekly_wake_is_found_from_the_day_after_it_fired(self):
        """Seven days is not enough scan; the day already begun eats one."""
        s = S.parse_schedule(S.schedule_to_dict(S.DEFAULT_SCHEDULE)
                             | {"wake": [{"at": "07:00", "days": "sat"}]})
        self.assertEqual(S.next_wake(s, at(2026, 8, 22, 9, 0)),
                         at(2026, 8, 29, 7, 0))

    def test_no_wake_times_means_no_next_wake(self):
        s = S.parse_schedule(S.schedule_to_dict(S.DEFAULT_SCHEDULE) | {"wake": []})
        self.assertIsNone(S.next_wake(s, at(2026, 8, 19, 9, 0)))


class PollTest(unittest.TestCase):
    def test_the_quiet_cadence_applies_inside_the_window_and_not_outside(self):
        s = S.DEFAULT_SCHEDULE
        self.assertEqual(S.effective_poll_seconds(s, at(2026, 8, 19, 1, 0)), 3600)
        self.assertEqual(S.effective_poll_seconds(s, at(2026, 8, 19, 9, 0)), 900)


class DstTest(unittest.TestCase):
    """A schedule in a zone that observes DST still fires once a day.

    Asia/Seoul does not, which is exactly why this test names a zone that does:
    the arithmetic must be right for a reader who moves, and 'it works here'
    is not evidence.
    """

    def _ny(self, doc_wake):
        return S.parse_schedule(S.schedule_to_dict(S.DEFAULT_SCHEDULE)
                                | {"timezone": "America/New_York", "wake": doc_wake,
                                   "quiet": []})

    def test_a_wake_in_the_spring_forward_gap_still_resolves(self):
        s = self._ny(["02:30"])                    # 2026-03-08 02:30 does not exist in NY
        t = datetime(2026, 3, 8, 0, 0, tzinfo=ZoneInfo("America/New_York")).timestamp()
        nxt = S.next_wake(s, t)
        self.assertIsNotNone(nxt)
        self.assertGreater(nxt, t)
        self.assertLess(nxt - t, 26 * 3600)

    def test_a_wake_in_the_fall_back_repeat_fires_once(self):
        s = self._ny(["01:30"])                    # 2026-11-01 01:30 happens twice
        t = datetime(2026, 11, 1, 0, 0, tzinfo=ZoneInfo("America/New_York")).timestamp()
        first = S.next_wake(s, t)
        second = S.next_wake(s, first + 1)
        self.assertGreater(second - first, 20 * 3600)


class TransitionTest(unittest.TestCase):
    def test_a_schedule_with_nothing_in_it_has_no_transitions(self):
        s = S.parse_schedule(S.schedule_to_dict(S.DEFAULT_SCHEDULE)
                             | {"quiet": [], "wake": []})
        self.assertIsNone(S.next_transition(s, at(2026, 8, 19, 9, 0)))
        self.assertEqual(S.transitions(s, at(2026, 8, 19, 9, 0), 5), [])

    def test_transitions_are_strictly_after_the_instant_asked_about(self):
        t = at(2026, 8, 19, 12, 40)                # a wake instant exactly
        rows = S.transitions(S.DEFAULT_SCHEDULE, t, 3)
        self.assertTrue(all(when > t for when, _ in rows))

    def test_a_quiet_boundary_that_is_also_a_wake_reports_both(self):
        """06:00 is the end of the window and a wake; neither may be swallowed."""
        rows = S.transitions(S.DEFAULT_SCHEDULE, at(2026, 8, 19, 1, 0), 2)
        six = at(2026, 8, 19, 6, 0)
        self.assertEqual({lab for when, lab in rows if when == six},
                         {"quiet_end", "wake"})

    def test_the_next_transition_before_a_window_is_its_start(self):
        self.assertEqual(S.next_transition(S.DEFAULT_SCHEDULE, at(2026, 8, 19, 23, 0)),
                         (at(2026, 8, 20, 0, 30), "quiet_start"))


class DescribeTest(unittest.TestCase):
    def test_it_lists_transitions_in_order_and_names_each_one(self):
        rows = S.describe(S.DEFAULT_SCHEDULE, at(2026, 8, 19, 9, 0), 5)
        self.assertEqual(len(rows), 5)
        self.assertEqual([r["at"] for r in rows], sorted(r["at"] for r in rows))
        self.assertIn(rows[0]["what"], ("wake", "quiet_start", "quiet_end"))
        self.assertTrue(rows[0]["utc"].endswith("Z"))

    def test_it_returns_fewer_rows_than_asked_rather_than_padding(self):
        s = S.parse_schedule(S.schedule_to_dict(S.DEFAULT_SCHEDULE)
                             | {"quiet": [], "wake": []})
        self.assertEqual(S.describe(s, at(2026, 8, 19, 9, 0), 10), [])

    def test_the_local_column_is_in_the_schedules_own_zone(self):
        rows = S.describe(S.DEFAULT_SCHEDULE, at(2026, 8, 19, 9, 0), 1)
        self.assertTrue(rows[0]["local"].startswith("2026-08-19 12:40"))
        self.assertEqual(rows[0]["utc"], "2026-08-19T03:40:00Z")

    def test_an_ambiguous_local_time_is_flagged_rather_than_resolved_silently(self):
        ny = S.parse_schedule(S.schedule_to_dict(S.DEFAULT_SCHEDULE)
                              | {"timezone": "America/New_York", "wake": ["01:30"],
                                 "quiet": []})
        t = datetime(2026, 11, 1, 0, 0, tzinfo=ZoneInfo("America/New_York")).timestamp()
        self.assertTrue(S.describe(ny, t, 1)[0]["ambiguous"])
        self.assertFalse(S.describe(S.DEFAULT_SCHEDULE, at(2026, 8, 19, 9, 0), 1)[0]
                         ["ambiguous"])


if __name__ == "__main__":
    unittest.main()
