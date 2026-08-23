"""The schedule on disk: what a restart reads, and what a bad edit cannot do.

The desk is the only writer of this file, so the interesting cases are not
concurrent ones. They are the ones where the bytes on disk are not what the
desk wrote: a hand edit that will not parse, a field the validator refuses, a
directory that is not there. ``load`` never raises, because a desk that refused
to start over a mistyped field is a newspaper taken off the wall by a typo;
``save`` does raise, because an operator who has just PUT a schedule deserves
to learn that it did not land.
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import tempfile
import unittest

from wpdesk import schedule as S
from wpdesk import schedulefile

# The module warns when a file will not parse, which is exactly what two tests
# here provoke. Without a handler that warning prints to stderr and a passing
# run reads like a failing one.
logging.getLogger("wpdesk.schedulefile").addHandler(logging.NullHandler())


class ScheduleFileCase(unittest.TestCase):
    """A temporary data root, and the path the desk would use inside it."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.path = os.path.join(self.tmp, "schedule.json")

    def edited(self) -> S.Schedule:
        """A schedule that differs from the default in a field a test can see."""
        doc = S.schedule_to_dict(S.DEFAULT_SCHEDULE)
        doc["publish"] = {"policy": "immediate", "min_gap_minutes": 0}
        return S.parse_schedule(doc)

    def write(self, raw: bytes) -> None:
        with open(self.path, "wb") as f:
            f.write(raw)

    def read(self) -> bytes:
        with open(self.path, "rb") as f:
            return f.read()


class LoadTest(ScheduleFileCase):
    """What comes back, and where the caller is told it came from."""

    def test_a_desk_with_no_file_runs_on_the_default_and_writes_nothing(self):
        self.assertEqual(schedulefile.load(self.path),
                         (S.DEFAULT_SCHEDULE, "default"))
        # Reading must not write. The default is what a desk runs on until
        # somebody chooses otherwise, and a file laid down at first boot would
        # pin every future desk to this release's default.
        self.assertEqual(os.listdir(self.tmp), [])

    def test_what_was_saved_is_what_comes_back(self):
        s = self.edited()
        schedulefile.save(self.path, s)
        self.assertEqual(schedulefile.load(self.path), (s, "file"))

    def test_a_file_that_is_not_json_leaves_the_default_in_force(self):
        self.write(b"{ not json at all")
        self.assertEqual(schedulefile.load(self.path),
                         (S.DEFAULT_SCHEDULE, "default"))
        # Left on disk as evidence. The person who mistyped it is the only one
        # who can fix it, and a desk that quietly deleted the file would take
        # the mistake away without taking the surprise away.
        self.assertEqual(self.read(), b"{ not json at all")

    def test_a_document_the_validator_refuses_leaves_the_default_in_force(self):
        doc = S.schedule_to_dict(S.DEFAULT_SCHEDULE)
        doc["poll"]["active_seconds"] = 5          # below the device's own floor
        raw = json.dumps(doc).encode("utf-8")
        self.write(raw)
        self.assertEqual(schedulefile.load(self.path),
                         (S.DEFAULT_SCHEDULE, "default"))
        self.assertEqual(self.read(), raw)


class SaveTest(ScheduleFileCase):
    """Writing it: atomically, or loudly."""

    def test_a_successful_save_leaves_no_temporary_behind(self):
        schedulefile.save(self.path, self.edited())
        self.assertEqual(os.listdir(self.tmp), ["schedule.json"])

    def test_saving_where_there_is_no_directory_raises(self):
        # An operator told the edit landed, who then finds the old schedule in
        # force at six the next morning, has been lied to. This is the raise
        # that turns that into a 500 at the moment of the PUT.
        missing = os.path.join(self.tmp, "nope", "schedule.json")
        with self.assertRaises(OSError):
            schedulefile.save(missing, S.DEFAULT_SCHEDULE)

    def test_the_file_is_written_for_somebody_with_a_text_editor(self):
        # Indented and newline-terminated, because this file exists to be read
        # and edited by hand as much as by the desk.
        schedulefile.save(self.path, S.DEFAULT_SCHEDULE)
        raw = self.read().decode("utf-8")
        self.assertTrue(raw.endswith("}\n"), raw[-20:])
        self.assertIn('\n  "timezone"', raw)


if __name__ == "__main__":
    unittest.main()
