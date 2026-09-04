#!/usr/bin/env python3
"""The validator's half of the edition's language.

    python3 tools/test_validate_lang.py

`lang` decides two things --validate can check and the device cannot, and they
fail in opposite directions.

WHAT IS DRAWABLE. The bundled faces carry ASCII, Latin-1 and S_DATA_PUNCT, and
for `ko` the 2,350 KS X 1001 syllables tools/hangul.py derives. A syllable
outside that set is not a typo, it is a word the faces cannot set: the producer
wrote real Korean and picked one of the syllables KS X 1001 leaves out. So it
gets its own message naming the codepoint, rather than being swept into the
"undrawable character" list beside a stray emoji — the fix is to respell the
word, not to stop writing Korean.

HOW MUCH FITS. The budgets in PROMPT.md are widths in disguise, written for a
Latin glyph that averages half an em. A Hangul syllable is a full one, so it
weighs two against every character budget and every body floor. Getting this
wrong is silent in both directions and neither symptom points here: a headline
counted in codepoints sets four characters over its slot and the panel prints a
`…` mid-sentence, while a body counted in codepoints is half the copy the leg
needs and leaves white paper down the column.

Everything is stdlib and nothing touches the network: the English fixture is
loaded, mutated in memory and validated.
"""

import json
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import mock_news_server as M  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FIXTURES = os.path.join(ROOT, "components", "news_core", "test", "host", "fixtures")
FIXTURE = os.path.join(FIXTURES, "news.json")
FIXTURE_KO = os.path.join(FIXTURES, "news.ko.json")

# The demo edition's pictures live with the simulator, so the fixture is the one
# payload that needs --tiles. The Korean fixture reuses the same three tiles.
TILES = os.path.join(ROOT, "sim", "tiles")


class Lang(unittest.TestCase):
    def payload(self, **over):
        """The English fixture, with the named keys replaced."""
        with open(FIXTURE, encoding="utf-8") as f:
            d = json.load(f)
        d.update(over)
        return d

    def test_the_english_fixture_still_validates_with_no_lang(self):
        """Absent is "en", and an edition that never heard of the field is unaffected."""
        d = self.payload()
        d.pop("lang", None)
        self.assertEqual(M.validate_payload(d, TILES)[0], [])

    def test_a_malformed_tag_is_named(self):
        problems, _ = M.validate_payload(self.payload(lang="Korean"), TILES)
        self.assertTrue(any("lang" in p and "Korean" in p for p in problems), problems)

    def test_a_malformed_tag_does_not_hide_the_rest_of_the_payload(self):
        """The bad tag is NAMED and then ignored, exactly as the device normalises it.

        Stopping at the first problem would report one typo and hide every
        undrawable character behind it, which is the report a producer gets and
        the only one it gets.
        """
        d = self.payload(lang="KO")
        d["stories"][0]["headline"] = "삼성전자 급등"
        problems, _ = M.validate_payload(d, TILES)
        self.assertTrue(any("lang" in p for p in problems), problems)
        self.assertTrue(any("undrawable" in p for p in problems), problems)

    def test_hangul_in_an_english_edition_is_undrawable(self):
        d = self.payload()
        d["stories"][0]["headline"] = "삼성전자 급등"
        problems, _ = M.validate_payload(d, TILES)
        self.assertTrue(any("undrawable" in p for p in problems), problems)

    def test_hangul_in_a_korean_edition_is_drawable(self):
        d = self.payload(lang="ko")
        d["stories"][0]["headline"] = "삼성전자 급등"
        self.assertEqual(M.validate_payload(d, TILES)[0], [])

    def test_a_syllable_outside_ks_x_1001_is_named(self):
        """뷁 is U+BDC1 — a real syllable, and one of the ones the faces omit."""
        d = self.payload(lang="ko")
        d["stories"][0]["headline"] = "뷁"
        problems, _ = M.validate_payload(d, TILES)
        self.assertTrue(any("KS X 1001" in p and "U+BDC1" in p for p in problems), problems)
        # And not ALSO as a generic undrawable character: one character, one message.
        self.assertEqual([p for p in problems if "undrawable" in p], [])

    def test_the_jamo_and_the_cjk_punctuation_are_drawable_in_korean(self):
        """The other two thirds of DRAWABLE_KO, which no Korean sentence needs and
        a headline quoting a title or naming a consonant does."""
        d = self.payload(lang="ko")
        d["stories"][0]["headline"] = "「반도체」 ㄱ의 조건"
        self.assertEqual(M.validate_payload(d, TILES)[0], [])

    def test_a_syllable_weighs_two_against_the_budget(self):
        d = self.payload(lang="ko")
        d["stories"][0]["headline"] = "가" * 37          # 74 of measure, over 72
        problems, _ = M.validate_payload(d, TILES)
        self.assertTrue(any("headline" in p and "72" in p for p in problems), problems)
        d["stories"][0]["headline"] = "가" * 36          # exactly 72
        self.assertEqual([p for p in M.validate_payload(d, TILES)[0] if "headline" in p], [])

    def test_the_measure_says_it_counted_syllables_double(self):
        """A producer who counted 37 characters against a budget of 72 has to be
        told which arithmetic the validator used, or the message reads as a bug."""
        d = self.payload(lang="ko")
        d["stories"][0]["headline"] = "가" * 37
        problems, _ = M.validate_payload(d, TILES)
        said = [p for p in problems if "headline" in p]
        self.assertTrue(said and "37 Hangul syllables" in said[0], problems)

    def test_a_latin_field_still_reports_a_plain_character_count(self):
        """No parenthetical where there are no syllables to explain."""
        d = self.payload()
        d["stories"][0]["headline"] = "x" * 73
        problems, _ = M.validate_payload(d, TILES)
        said = [p for p in problems if "headline" in p]
        self.assertTrue(said, problems)
        self.assertNotIn("Hangul", said[0])

    def test_the_body_floor_is_weighted_too(self):
        d = self.payload(lang="ko")
        d["stories"][0]["body"] = "가나 " * 350          # 700 syllables weigh 1,400
        _, warnings = M.validate_payload(d, TILES)
        self.assertEqual([w for w in warnings if "body is" in w], [])

    def test_the_byte_capacity_is_unweighted(self):
        """The array is bytes and a syllable is three of them. 1,340 syllables sit
        inside the 1,300-syllable width budget of a lead body and outside its
        4,000-byte field, which is the failure the weighting must not mask."""
        d = self.payload(lang="ko")
        d["stories"][0]["body"] = "가" * 1340            # 4,020 bytes
        problems, _ = M.validate_payload(d, TILES)
        self.assertTrue(any("body" in p and "4000-byte field" in p for p in problems), problems)

    def test_the_korean_fixture_validates(self):
        with open(FIXTURE_KO, encoding="utf-8") as f:
            d = json.load(f)
        problems, warnings = M.validate_payload(d, TILES)
        self.assertEqual(problems, [])
        self.assertEqual(warnings, [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
