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
import subprocess
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import hangul  # noqa: E402
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

    def test_a_malformed_tag_says_what_the_board_would_do_with_it(self):
        """The refusal has to carry the consequence, not only the rule.

        `en-US` is a language tag everywhere else in software, so "not a
        language tag" reads as pedantry and invites a producer to file it
        again unchanged. What is actually about to happen is that
        `news_parse()` clamps the field to `en` and the board sets its twelve
        fixed words in English beside Korean copy — which is the one failure
        on this field that produces no error anywhere and a wrong sheet on the
        wall. So the message says the clamp, and then says what a tag looks
        like, so the fix is in the same sentence as the problem.
        """
        problems, _ = M.validate_payload(self.payload(lang="en-US"), TILES)
        said = [p for p in problems if p.startswith("lang:")]
        self.assertEqual(len(said), 1, problems)
        self.assertIn("'en-US'", said[0])
        self.assertIn("clamp this to en", said[0])
        self.assertIn('"en", "ko"', said[0])

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

    def test_the_out_of_set_message_carries_all_three_things(self):
        """The syllable, its codepoint, and the name of the set that omits it.

        Each does a different job. The syllable is the thing to find in the
        copy; the codepoint is what survives a terminal, a log file or an
        editor that cannot draw it; and "KS X 1001" is what turns "not
        drawable" into a fix — the producer wrote real Korean and reached one
        of the syllables the faces leave out, so the answer is to respell one
        word rather than to stop writing Korean.
        """
        d = self.payload(lang="ko")
        d["stories"][0]["headline"] = "뷁"
        said = [p for p in M.validate_payload(d, TILES)[0] if "headline" in p]
        self.assertEqual(len(said), 1, said)
        self.assertIn("'뷁'", said[0])
        self.assertIn("U+BDC1", said[0])
        self.assertIn("KS X 1001", said[0])
        self.assertIn("respell", said[0])

    def test_a_repeated_out_of_set_syllable_is_named_once(self):
        """A word the producer used four times down a story is one thing to respell."""
        d = self.payload(lang="ko")
        d["stories"][0]["headline"] = "뷁뷁뷁뷁"
        problems, _ = M.validate_payload(d, TILES)
        self.assertEqual(len([p for p in problems if "KS X 1001" in p]), 1, problems)

    def test_distinct_out_of_set_syllables_are_each_named_in_order(self):
        d = self.payload(lang="ko")
        d["stories"][0]["headline"] = "뷁뷀뷁"
        named = [p for p in M.validate_payload(d, TILES)[0] if "KS X 1001" in p]
        self.assertEqual(len(named), 2, named)
        self.assertIn("U+BDC1", named[0])
        self.assertIn("U+BDC0", named[1])

    def test_the_jamo_and_the_cjk_punctuation_are_drawable_in_korean(self):
        """The other two thirds of DRAWABLE_KO, which no Korean sentence needs and
        a headline quoting a title or naming a consonant does."""
        d = self.payload(lang="ko")
        d["stories"][0]["headline"] = "「반도체」 ㄱ의 조건"
        self.assertEqual(M.validate_payload(d, TILES)[0], [])

    def test_everything_the_faces_draw_in_korean_weighs_two(self):
        """Not only the syllables. Noto sets a CJK bracket and a compatibility jamo
        on the same square body as 가, so a headline quoting a title is two
        characters of measure wider than its codepoint count — and a budget that
        counted the brackets as Latin would pass a line the panel then ellipsizes."""
        self.assertEqual(hangul.weight("「가」"), 6)
        self.assertEqual(hangul.weight("ㄱ"), 2)
        self.assertEqual(hangul.weight("x"), 1)
        # Every character the faces carry for Korean, and nothing narrower.
        for c in hangul.DRAWABLE_KO:
            self.assertEqual(hangul.weight(c), 2, repr(c))

    def test_a_syllable_weighs_two_against_the_budget(self):
        d = self.payload(lang="ko")
        d["stories"][0]["headline"] = "가" * 37          # 74 of measure, over 72
        problems, _ = M.validate_payload(d, TILES)
        self.assertTrue(any("headline" in p and "72" in p for p in problems), problems)
        d["stories"][0]["headline"] = "가" * 36          # exactly 72
        self.assertEqual([p for p in M.validate_payload(d, TILES)[0] if "headline" in p], [])

    def test_the_measure_says_it_counted_korean_double(self):
        """A producer who counted 37 characters against a budget of 72 has to be
        told which arithmetic the validator used, or the message reads as a bug."""
        d = self.payload(lang="ko")
        d["stories"][0]["headline"] = "가" * 37
        problems, _ = M.validate_payload(d, TILES)
        said = [p for p in problems if "headline" in p]
        self.assertTrue(said and "37 Korean characters" in said[0], problems)

    def test_the_measure_explains_every_character_it_doubled(self):
        """The two numbers in the message have to reconcile.

        A producer reads "78 characters of measure (13 …count double)", multiplies,
        gets 26 against a 39-character headline and concludes the validator cannot
        count. So the parenthetical counts everything the measure doubled — the
        brackets as well as the syllables — and not only the syllables.
        """
        d = self.payload(lang="ko")
        d["stories"][0]["headline"] = "「가」" * 13          # 39 characters, all full-em
        said = [p for p in M.validate_payload(d, TILES)[0] if "headline" in p]
        self.assertTrue(said, "no headline problem at all")
        self.assertIn("78 characters of measure", said[0])
        self.assertIn("39 Korean characters count double", said[0])

    def test_the_overshoot_is_stated_in_the_same_unit_as_the_count(self):
        """One syllable too many is two of measure over. A bare "2 over" invites the
        producer to delete two characters and file it again still over budget."""
        d = self.payload(lang="ko")
        d["stories"][0]["headline"] = "가" * 37
        said = [p for p in M.validate_payload(d, TILES)[0] if "headline" in p]
        self.assertTrue(said, "no headline problem at all")
        self.assertIn("2 of measure over", said[0])

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


class Invocation(unittest.TestCase):
    """The `sys.path` line at the top of mock_news_server.py, held to what it claims.

    Every other way of starting the validator finds `hangul` on its own: a script run by
    path gets its own directory at `sys.path[0]`, and an importer had to put `tools/` on
    the path to import the module at all. `python -m` is the one that does not, and a
    comment saying so is worth exactly as much as the check under it.
    """

    def test_python_dash_m_finds_hangul(self):
        run = subprocess.run(
            [sys.executable, "-m", "tools.mock_news_server",
             "--validate", FIXTURE_KO, "--tiles", TILES],
            cwd=ROOT, capture_output=True, text=True)
        self.assertEqual(run.returncode, 0, run.stderr)


if __name__ == "__main__":
    unittest.main(verbosity=2)
