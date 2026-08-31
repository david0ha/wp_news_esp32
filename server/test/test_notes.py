"""What may be written as a note, and the things beside one that are not notes.

The two limits are the two a reader can see broken. A note is bounded, because
a phone fetches the whole of it through a tunnel; and it is UTF-8, because it
goes out under a Content-Type that says so and anything else renders as
mojibake rather than as an error somebody can act on.

The third property has no limit attached and is the one this module exists to
keep: a refusal leaves the note that was already there alone.
"""

from __future__ import annotations

import os
import re
import shutil
import tempfile
import unittest

from claudepost import notes
from claudepost.errors import BadRequest, NotFound, TooLarge

#: The id shape the command routes match. Any anchored pattern would exercise
#: :class:`~claudepost.notes.NoteStore`; this is the real one, so a store built
#: here is a store built the way the desk builds it.
COMMAND_ID = re.compile(r"^[0-9a-f]{8,64}\Z")


class NoteTest(unittest.TestCase):
    """A note in a directory that owns it: a draft's, an edition's."""

    def setUp(self):
        self.owner = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.owner, True)

    def test_a_note_round_trips_verbatim(self):
        # Bytes in, the same bytes out. The desk never parses a note, renders
        # it or rewrites it -- markdown is the reader's problem and the desk's
        # job is to hand back what the worker filed.
        text = "# SNDK\n\nThe fab is the story; the guidance was a consequence.\n".encode()
        notes.write(self.owner, text)
        self.assertEqual(notes.read(self.owner), text)
        self.assertTrue(notes.present(self.owner))

    def test_a_note_nobody_wrote_is_no_note(self):
        self.assertIsNone(notes.read(self.owner))
        self.assertFalse(notes.present(self.owner))

    def test_a_note_at_the_cap_is_allowed(self):
        notes.write(self.owner, b"m" * notes.MAX_NOTES_BYTES)
        self.assertEqual(len(notes.read(self.owner)), notes.MAX_NOTES_BYTES)

    def test_a_note_past_the_cap_is_refused(self):
        notes.write(self.owner, b"the note that was already there")
        with self.assertRaises(TooLarge):
            notes.write(self.owner, b"m" * (notes.MAX_NOTES_BYTES + 1))
        # The refusal left the previous note alone, which is the rule the whole
        # desk follows: a rejected payload never touches what is being served.
        self.assertEqual(notes.read(self.owner), b"the note that was already there")

    def test_a_note_that_is_not_utf8_is_refused(self):
        notes.write(self.owner, b"the note that was already there")
        with self.assertRaises(BadRequest):
            notes.write(self.owner, b"# SNDK\n\n\xff\xfe not text\n")
        self.assertEqual(notes.read(self.owner), b"the note that was already there")

    def test_a_tmp_file_beside_a_note_is_not_a_note(self):
        # atomic_write leaves a .claudepost-*.tmp behind when the process dies
        # between the write and the rename, and that file is half a note by
        # construction. What keeps it out of every answer is the NAME -- one
        # exact file is the note -- rather than a sweep that has to find it.
        with open(os.path.join(self.owner, ".claudepost-abcd1234.tmp"), "wb") as f:
            f.write(b"half a not")
        self.assertIsNone(notes.read(self.owner))
        self.assertFalse(notes.present(self.owner))

        notes.write(self.owner, b"the whole note")
        self.assertEqual(notes.read(self.owner), b"the whole note")


class NoteStoreTest(unittest.TestCase):
    """Notes for an owner with no directory of its own -- a command, a row."""

    def setUp(self):
        self.base = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.base, True)
        self.root = os.path.join(self.base, "notes", "commands")
        self.store = notes.NoteStore(self.root, COMMAND_ID)

    def test_a_note_round_trips_and_the_root_arrives_with_it(self):
        # Nothing on disk until there is something to keep: a desk nobody has
        # filed a note on has no empty directory for an operator to wonder at.
        self.assertFalse(os.path.exists(self.root))
        self.assertFalse(self.store.has("0123abcd"))
        self.assertIsNone(self.store.get("0123abcd"))

        self.store.put("0123abcd", b"# what I did\n")
        self.assertEqual(self.store.get("0123abcd"), b"# what I did\n")
        self.assertTrue(self.store.has("0123abcd"))

    def test_one_owners_note_is_not_anothers(self):
        self.store.put("0123abcd", b"mine")
        self.store.put("beefcafe", b"yours")
        self.assertEqual(self.store.get("0123abcd"), b"mine")
        self.assertEqual(self.store.get("beefcafe"), b"yours")

    def test_a_note_past_the_cap_is_refused_before_a_directory_is_made(self):
        with self.assertRaises(TooLarge):
            self.store.put("0123abcd", b"m" * (notes.MAX_NOTES_BYTES + 1))
        self.assertFalse(os.path.exists(self.root))

    def test_an_id_that_is_not_one_reaches_no_path(self):
        for bad in ("../../etc/passwd", "0123abcd/../../x", "", "abc",
                    "0123ABCD", "0123abcd\n", None):
            with self.assertRaises(NotFound, msg=repr(bad)):
                self.store.put(bad, b"x")

        # Not merely "nothing outside the root": the root itself never
        # appeared. The id is checked before a directory is made, so a
        # traversal leaves no footprint at all -- not even a directory named
        # after an owner that cannot exist.
        self.assertFalse(os.path.exists(self.root))
        self.assertEqual(os.listdir(self.base), [])

        # A read of the same id answers the way every read on this desk
        # answers: nothing, rather than a refusal.
        self.assertIsNone(self.store.get("../../etc/passwd"))
        self.assertFalse(self.store.has("../../etc/passwd"))


if __name__ == "__main__":
    unittest.main()
