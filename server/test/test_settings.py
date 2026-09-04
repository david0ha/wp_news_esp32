"""The desk's settings on disk: one field, and what a bad edit cannot do.

The document is small enough that the interesting part is not its shape but
its two asymmetries, both inherited from ``schedulefile.py``. ``load`` never
raises, because a desk that refused to start over a mistyped language tag
would be a newspaper taken off the wall by a typo -- so a file that will not
parse is ignored, left where it is, and the paper comes out in English.
``save`` does raise, because an operator told the edit landed, who then finds
tomorrow's paper still in English, has been lied to.

The third rule is the watchlist's rather than the schedule's: an unknown key
is refused whole. A settings document is where a future field will be added,
and a desk that silently dropped one would leave an operator -- or a phone
app one release ahead of the desk -- believing it had set something.
"""

from __future__ import annotations

import logging
import os
import shutil
import tempfile
import unittest

from claudepost import settings
from claudepost.errors import BadRequest

# The module warns when a file will not parse, which is exactly what one test
# here provokes. Without a handler that warning prints to stderr and a passing
# run reads like a failing one.
logging.getLogger("claudepost.settings").addHandler(logging.NullHandler())


class Parse(unittest.TestCase):
    """What the validator takes, and what it refuses whole."""

    def test_the_default_is_english(self):
        self.assertEqual(settings.DEFAULT, {"lang": "en"})

    def test_a_language_tag_is_two_or_three_lowercase_letters(self):
        self.assertEqual(settings.parse_settings({"lang": "ko"}), {"lang": "ko"})
        for bad in ("KO", "ko-KR", "", 7, None):
            with self.assertRaises(BadRequest):
                settings.parse_settings({"lang": bad})

    def test_a_document_that_says_nothing_takes_the_default(self):
        # Absent is not the same as `null`: nobody said, so the desk answers
        # for them. `{"lang": null}` above is a caller who meant to say
        # something and got the type wrong, which is worth a refusal.
        self.assertEqual(settings.parse_settings({}), settings.DEFAULT)

    def test_an_unknown_key_is_refused_whole(self):
        with self.assertRaises(BadRequest):
            settings.parse_settings({"lang": "ko", "voice": "terse"})

    def test_a_document_that_is_not_an_object_is_refused(self):
        with self.assertRaises(BadRequest):
            settings.parse_settings(["ko"])

    def test_a_refusal_names_the_field(self):
        # The message is what lands in the 400 body, where the only reader is
        # whoever sent the field that was wrong. "invalid settings" is not
        # something anybody can act on.
        with self.assertRaises(BadRequest) as caught:
            settings.parse_settings({"lang": "ko-KR"})
        self.assertIn("lang", caught.exception.message)
        self.assertEqual(caught.exception.code, "bad_settings")


class File(unittest.TestCase):
    """A temporary data root, and the path the desk would use inside it."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)

    def write(self, raw: str) -> str:
        path = os.path.join(self.tmp, "settings.json")
        with open(path, "w", encoding="utf-8") as f:
            f.write(raw)
        return path

    def test_missing_is_the_default_and_not_an_error(self):
        self.assertEqual(settings.load(os.path.join(self.tmp, "settings.json")),
                         ({"lang": "en"}, "default"))
        # Reading must not write. The default is what a desk runs on until
        # somebody chooses otherwise, and a file laid down at first boot would
        # pin every future desk to this release's default.
        self.assertEqual(os.listdir(self.tmp), [])

    def test_a_bad_file_is_ignored_with_the_default_and_left_in_place(self):
        p = self.write('{"lang": "Korean"}')
        self.assertEqual(settings.load(p), ({"lang": "en"}, "default"))
        self.assertTrue(os.path.exists(p))

    def test_a_file_that_is_not_json_leaves_the_default_in_force(self):
        p = self.write("{ not json at all")
        self.assertEqual(settings.load(p), ({"lang": "en"}, "default"))
        self.assertTrue(os.path.exists(p))

    def test_save_then_load_round_trips(self):
        p = os.path.join(self.tmp, "settings.json")
        settings.save(p, {"lang": "ko"})
        self.assertEqual(settings.load(p), ({"lang": "ko"}, "file"))

    def test_a_successful_save_leaves_no_temporary_behind(self):
        settings.save(os.path.join(self.tmp, "settings.json"), {"lang": "ko"})
        self.assertEqual(os.listdir(self.tmp), ["settings.json"])

    def test_saving_where_there_is_no_directory_raises(self):
        # An operator told the edit landed, who then finds tomorrow's paper
        # still in English, has been lied to. This is the raise that turns
        # that into a 500 at the moment of the PUT.
        with self.assertRaises(OSError):
            settings.save(os.path.join(self.tmp, "nope", "settings.json"),
                          {"lang": "ko"})

    def test_the_file_is_written_for_somebody_with_a_text_editor(self):
        p = os.path.join(self.tmp, "settings.json")
        settings.save(p, {"lang": "ko"})
        with open(p, encoding="utf-8") as f:
            raw = f.read()
        self.assertEqual(raw, '{\n  "lang": "ko"\n}\n')

    def test_the_default_handed_back_is_not_the_module_s_own(self):
        # `load` answers with a fresh document every time. A caller that held
        # the module constant and edited it would change what every later
        # desk in the process came up on.
        doc, _ = settings.load(os.path.join(self.tmp, "settings.json"))
        doc["lang"] = "ko"
        self.assertEqual(settings.DEFAULT, {"lang": "en"})


if __name__ == "__main__":
    unittest.main()
