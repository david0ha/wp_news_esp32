"""The policy block, and the one rule about it: the producer does not write it.

Everything here is about the wire the board reads, so the assertions are about
JSON types as much as values -- `next_change` being a string instead of a
number is a firmware date parser this design exists to avoid.
"""

import json
import unittest

from claudepost import policy, schedule as S
from claudepost.errors import DeskError
from test_schedule import at            # reuse the helper


class PolicyBlockTest(unittest.TestCase):
    def test_the_cadence_is_the_one_for_right_now(self):
        self.assertEqual(policy.policy_block(S.DEFAULT_SCHEDULE, at(2026, 8, 19, 1, 0))
                         ["poll_seconds"], 3600)
        self.assertEqual(policy.policy_block(S.DEFAULT_SCHEDULE, at(2026, 8, 19, 9, 0))
                         ["poll_seconds"], 900)

    def test_next_change_is_an_integer_epoch_not_a_string(self):
        b = policy.policy_block(S.DEFAULT_SCHEDULE, at(2026, 8, 19, 9, 0))
        self.assertIsInstance(b["next_change"], int)
        self.assertGreater(b["next_change"], at(2026, 8, 19, 9, 0))

    def test_a_schedule_with_no_transitions_has_no_next_change(self):
        s = S.parse_schedule(S.schedule_to_dict(S.DEFAULT_SCHEDULE)
                             | {"quiet": [], "wake": []})
        self.assertNotIn("next_change", policy.policy_block(s, at(2026, 8, 19, 9, 0)))

    def test_next_change_is_when_the_cadence_itself_changes(self):
        """Inside the window it is the boundary, which is the point of the field."""
        b = policy.policy_block(S.DEFAULT_SCHEDULE, at(2026, 8, 19, 1, 0))
        self.assertEqual(b["next_change"], int(at(2026, 8, 19, 6, 0)))

    def test_the_block_carries_nothing_the_device_does_not_read(self):
        b = policy.policy_block(S.DEFAULT_SCHEDULE, at(2026, 8, 19, 9, 0))
        self.assertEqual(set(b), {"poll_seconds", "next_change"})

    def test_it_is_recomputed_rather_than_remembered(self):
        """Two instants an hour apart must not produce the same next_change."""
        one = policy.policy_block(S.DEFAULT_SCHEDULE, at(2026, 8, 19, 9, 0))
        two = policy.policy_block(S.DEFAULT_SCHEDULE, at(2026, 8, 19, 13, 0))
        self.assertNotEqual(one["next_change"], two["next_change"])


class SpliceTest(unittest.TestCase):
    def test_the_block_is_added_and_the_rest_is_untouched(self):
        src = json.dumps({"edition": "X", "stories": [{"headline": "H"}]}).encode()
        out = json.loads(policy.splice_policy(src, S.DEFAULT_SCHEDULE, at(2026, 8, 19, 9, 0)))
        self.assertEqual(out["edition"], "X")
        self.assertEqual(out["stories"], [{"headline": "H"}])
        self.assertIn("policy", out)

    def test_a_producers_own_policy_is_discarded(self):
        src = json.dumps({"policy": {"poll_seconds": 31}, "stories": []}).encode()
        out = json.loads(policy.splice_policy(src, S.DEFAULT_SCHEDULE, at(2026, 8, 19, 9, 0)))
        self.assertEqual(out["policy"]["poll_seconds"], 900)
        self.assertTrue(policy.dropped_producer_policy(src))

    def test_a_payload_without_one_reports_nothing_dropped(self):
        self.assertFalse(policy.dropped_producer_policy(b'{"stories":[]}'))

    def test_the_spliced_payload_is_still_under_the_device_cap(self):
        from claudepost import tiles
        src = b'{"stories":[]}'
        out = policy.splice_policy(src, S.DEFAULT_SCHEDULE, at(2026, 8, 19, 9, 0))
        self.assertLess(len(out), tiles.MAX_PAYLOAD_BYTES)

    def test_the_result_is_bytes_the_device_can_parse(self):
        out = policy.splice_policy(b'{"stories":[]}', S.DEFAULT_SCHEDULE,
                                   at(2026, 8, 19, 9, 0))
        self.assertIsInstance(out, bytes)
        self.assertEqual(json.loads(out.decode("utf-8"))["policy"]["poll_seconds"], 900)

    def test_copy_that_is_not_ascii_survives_as_utf8(self):
        """Headlines arrive over the network and carry whatever the desk filed."""
        src = json.dumps({"headline": "삼성전자 — 4%"},
                         ensure_ascii=False).encode("utf-8")
        out = policy.splice_policy(src, S.DEFAULT_SCHEDULE, at(2026, 8, 19, 9, 0))
        self.assertEqual(json.loads(out.decode("utf-8"))["headline"],
                         "삼성전자 — 4%")

    def test_a_payload_that_is_not_json_is_refused(self):
        with self.assertRaises(DeskError):
            policy.splice_policy(b"not json at all", S.DEFAULT_SCHEDULE,
                                 at(2026, 8, 19, 9, 0))

    def test_a_payload_that_is_not_an_object_is_refused(self):
        """A JSON array parses and would silently lose the block."""
        with self.assertRaises(DeskError):
            policy.splice_policy(b'["stories"]', S.DEFAULT_SCHEDULE,
                                 at(2026, 8, 19, 9, 0))

    def test_nothing_was_dropped_from_a_payload_that_never_parsed(self):
        self.assertFalse(policy.dropped_producer_policy(b"not json at all"))
        self.assertFalse(policy.dropped_producer_policy(b'["stories"]'))

    def test_a_quiet_edition_is_told_the_quiet_cadence(self):
        out = json.loads(policy.splice_policy(b'{"stories":[]}', S.DEFAULT_SCHEDULE,
                                              at(2026, 8, 19, 1, 0)))
        self.assertEqual(out["policy"]["poll_seconds"], 3600)


if __name__ == "__main__":
    unittest.main()
