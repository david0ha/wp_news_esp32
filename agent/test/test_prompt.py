"""What reaches the model, and what a stranger's directory cannot do to it.

Two properties are worth holding here. The first is that the shipped contract
comes first and the day's instruction comes last, because everything between
them is the operator's and a contract that can be pushed below somebody's notes
is not a contract. The second is that reading the context directory is total:
it is a path a stranger owns, on a disk that may not be mounted, holding files
of a size nobody promised, and every one of those is an edition that still gets
filed rather than an exception in a worker that then has to be restarted.

``prompt`` is pure -- no environment, no sockets, no clock -- which is what
lets all of that be asserted from a temporary directory in milliseconds.
"""

from __future__ import annotations

import os
import shutil
import tempfile
import unittest

import prompt


class ContextDirTest(unittest.TestCase):
    """``read_context_dir``: a directory the repository does not own."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)

    def write(self, name: str, data) -> str:
        path = os.path.join(self.tmp, name)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        mode = "wb" if isinstance(data, bytes) else "w"
        with open(path, mode) as f:
            f.write(data)
        return path

    def test_no_directory_configured_is_an_empty_list(self):
        # The default state of a fresh checkout. It is not an error and it is
        # not a warning: the contract alone is a complete prompt.
        self.assertEqual(prompt.read_context_dir(None), [])
        self.assertEqual(prompt.read_context_dir(""), [])

    def test_a_directory_that_is_not_there_is_an_empty_list(self):
        # An unplugged disk, or a mount that has not happened yet. Same answer:
        # a worse page beats no page, and no page is what raising here gets.
        self.assertEqual(prompt.read_context_dir(os.path.join(self.tmp, "gone")), [])

    def test_a_file_is_not_a_directory_and_answers_empty(self):
        path = self.write("notes.md", "hello")
        self.assertEqual(prompt.read_context_dir(path), [])

    def test_flat_markdown_and_json_come_back_sorted_under_their_own_names(self):
        self.write("standing.md", "house style")
        self.write("blocklist.md", "nothing yet")
        self.write("watchlist.json", '{"symbols": []}')
        # Neither of these is context: one is a binary the operator left lying
        # around, the other is a lock file. The suffix list is the allowlist.
        self.write("photo.png", b"\x89PNG")
        self.write(".obsidian.lock", "")

        got = prompt.read_context_dir(self.tmp)
        self.assertEqual([name for name, _ in got],
                         ["blocklist.md", "standing.md", "watchlist.json"])
        self.assertEqual(dict(got)["standing.md"], "house style")

    def test_subdirectories_are_not_read(self):
        # briefs/ in particular: the worker writes it, and a run that read its
        # own back would grow the prompt by a section a day forever.
        self.write("briefs/2026-08-23.md", "what was filed")
        self.write("standing.md", "house style")
        self.assertEqual([name for name, _ in prompt.read_context_dir(self.tmp)],
                         ["standing.md"])

    def test_an_oversized_file_is_truncated_with_a_visible_marker(self):
        self.write("standing.md", "x" * (prompt.MAX_CONTEXT_BYTES + 5000))
        (_, text), = prompt.read_context_dir(self.tmp)
        self.assertIn("<!-- truncated at %d bytes -->" % prompt.MAX_CONTEXT_BYTES, text)
        # Visible rather than silent, and short rather than long: the model must
        # be able to see that it was given half a file.
        self.assertLess(len(text), prompt.MAX_CONTEXT_BYTES + 200)
        self.assertTrue(text.startswith("x" * 100))

    def test_bytes_that_are_not_utf8_are_replaced_rather_than_raised(self):
        self.write("standing.md", b"caf\xe9 latin-1, not utf-8")
        (_, text), = prompt.read_context_dir(self.tmp)
        self.assertIn("latin-1", text)
        self.assertIn("caf", text)


class BuildPromptTest(unittest.TestCase):
    """``build_prompt``: the order is the argument."""

    CONTRACT = "# The contract\n\nHow anybody writes a producer.\n"

    def test_the_contract_comes_first(self):
        text = prompt.build_prompt(self.CONTRACT, [], [], "NVDA today")
        self.assertTrue(text.startswith(self.CONTRACT))

    def test_the_instruction_arrives_verbatim(self):
        # Not summarised, not reflowed: the operator typed it and the desk
        # passed it through untouched, so this is the last place it could rot.
        command = "NVDA — earnings last night, lead on the guide"
        text = prompt.build_prompt(self.CONTRACT, [], [], command)
        self.assertIn(command, text)
        self.assertIn("# Today's instruction", text)

    def test_the_instruction_comes_after_everything_the_operator_supplied(self):
        text = prompt.build_prompt(
            self.CONTRACT, [("standing.md", "house style")],
            [{"rule": "Never print TSLA."}], "NVDA today")
        self.assertLess(text.index("house style"), text.index("NVDA today"))
        self.assertLess(text.index("Never print TSLA."), text.index("NVDA today"))

    def test_each_context_file_is_a_section_under_its_own_name(self):
        text = prompt.build_prompt(
            self.CONTRACT,
            [("standing.md", "house style"), ("watchlist.json", '{"symbols": []}')],
            [], "NVDA today")
        self.assertIn("## standing.md", text)
        self.assertIn("## watchlist.json", text)
        self.assertLess(text.index("## standing.md"), text.index("## watchlist.json"))

    def test_no_context_means_no_context_section(self):
        text = prompt.build_prompt(self.CONTRACT, [], [], "NVDA today")
        self.assertNotIn("##", text[len(self.CONTRACT):].split("# Today's")[0])

    def test_directives_are_one_bullet_each(self):
        text = prompt.build_prompt(
            self.CONTRACT, [],
            [{"rule": "Never print TSLA."}, {"rule": "Prefer the KOSPI session."}],
            "NVDA today")
        self.assertIn("## Standing directives", text)
        self.assertIn("- Never print TSLA.\n", text)
        self.assertIn("- Prefer the KOSPI session.\n", text)

    def test_a_directive_with_no_rule_does_not_break_the_prompt(self):
        text = prompt.build_prompt(self.CONTRACT, [], [{}], "NVDA today")
        self.assertIn("# Today's instruction", text)

    def test_the_tail_says_where_to_write_and_not_to_publish(self):
        text = prompt.build_prompt(self.CONTRACT, [], [], "NVDA today")
        self.assertIn("$EDITION_DIR", text)
        self.assertIn("news.json LAST", text)
        self.assertIn("Do not try to publish", text)

    def test_a_custom_kind_gets_the_same_tail_as_file_edition(self):
        # "custom" may or may not turn into a page -- the operator's text
        # decides, and only what actually landed in the workdir after the
        # turn tells loop.handle() which. The prompt itself stays the
        # ordinary filing one, the same as the default kind.
        text = prompt.build_prompt(self.CONTRACT, [], [], "look into NVDA", kind="custom")
        self.assertIn("news.json LAST", text)
        self.assertNotIn("research instruction", text)

    def test_a_research_kind_gets_the_research_tail_instead(self):
        # "research" never files a page, so the model is told that plainly
        # instead of being handed an instruction to write news.json that
        # this loop is never going to look for.
        text = prompt.build_prompt(self.CONTRACT, [], [], "look into NVDA", kind="research")
        self.assertIn("$EDITION_DIR/notes.md", text)
        self.assertIn("research instruction", text)
        self.assertNotIn("news.json LAST", text)

    def test_the_english_edition_prompt_is_spelled_out_here_in_full(self):
        # The regression guard for the whole feature, and it is a real one
        # rather than a formality: `build_prompt` grew a second contract, a
        # second tail and a second language section, and every one of those is
        # a place where a `kind` that fell through to the wrong branch would
        # change the newspaper's prompt without changing anything anybody
        # would notice until a page came out wrong.
        #
        # Written out byte for byte rather than compared against another call
        # to the same function -- comparing a function to itself is satisfied
        # by any change that is applied consistently, which is exactly the
        # change this is here to catch.
        text = prompt.build_prompt("CONTRACT", [("standing.md", "house style")],
                                   [{"rule": "Never print TSLA."}], "NVDA today")
        self.assertEqual(
            text,
            "CONTRACT"
            "\n\n---\n\n# This desk's standing instructions\n"
            "\n## standing.md\n\nhouse style\n"
            "\n## Standing directives, most recent first\n\n"
            "- Never print TSLA.\n"
            "\n---\n\n# Today's instruction\n\nNVDA today\n"
            "\nWrite the edition into $EDITION_DIR: news.json, and tiles/<id>.bin"
            " for every\npicture it names. Write news.json LAST. Do not try to"
            " publish it — the desk\nvalidates, typesets and publishes; your job"
            " ends when the files are on disk.\n")
        # And the default kind, the missing key's kind and an explicit English
        # all produce that same byte string.
        self.assertEqual(prompt.build_prompt(
            "CONTRACT", [("standing.md", "house style")],
            [{"rule": "Never print TSLA."}], "NVDA today",
            kind="file_edition", lang="en"), text)

    def test_a_calendar_kind_gets_the_calendar_tail_instead(self):
        # The other job entirely. A calendar run files no edition, so the last
        # thing the model reads must not be an instruction to write news.json
        # -- that file is served with no authorization and this is the one run
        # holding the owner's positions, so the loop refuses one rather than
        # uploading it. A prompt that asked for it would spend the whole
        # research budget on a turn that then fails.
        text = prompt.build_prompt(self.CONTRACT, [], [], "the book",
                                   kind="calendar")
        self.assertIn("$EDITION_DIR/calendar.json", text)
        self.assertIn("files no edition", text)
        self.assertNotIn("news.json LAST", text)
        self.assertNotIn("research instruction", text)

    def test_the_shipped_contract_assembles_on_its_own(self):
        # The one integration point with the rest of the repository: PROMPT.md
        # is the file the worker actually reads, and a prompt built from it and
        # nothing else is the shape an unconfigured worker sends.
        here = os.path.dirname(os.path.abspath(__file__))
        contract_path = os.path.join(here, "..", "..", "tools", "edition", "PROMPT.md")
        with open(contract_path, encoding="utf-8") as f:
            contract = f.read()
        text = prompt.build_prompt(contract, [], [], "NVDA today")
        self.assertTrue(text.startswith(contract))
        self.assertIn("NVDA today", text)


class ContractNameTest(unittest.TestCase):
    """Which of the two shipped contracts a kind of command is written against.

    Two jobs on one queue, and the whole of how a run tells them apart is this
    one lookup: ``PROMPT.md`` files a page about one company for anybody,
    ``CALENDAR.md`` files a book about one person's money. Pure and by name
    rather than by path, so the choice can be asserted without a checkout --
    ``loop.read_contract`` owns the repository root and the open().
    """

    def test_a_calendar_command_reads_the_other_contract(self):
        self.assertEqual(prompt.contract_name("calendar"), "CALENDAR.md")

    def test_every_other_kind_reads_the_newspapers(self):
        # Including a kind this module has never heard of. `build_prompt` has
        # always treated an unrecognised kind as a filing one rather than
        # raising over it, and a worker one release behind a desk that grew a
        # fourth kind should file a page, not crash.
        for kind in ("file_edition", "research", "custom", "something_new", ""):
            with self.subTest(kind=kind):
                self.assertEqual(prompt.contract_name(kind), "PROMPT.md")

    def test_both_contracts_are_actually_in_the_repository(self):
        # The one integration point: these two names are joined onto
        # tools/edition/ and opened. A name that drifted from the file would
        # fail every calendar command with a FileNotFoundError from inside
        # loop.read_contract, which is a long way from where the typo is.
        here = os.path.dirname(os.path.abspath(__file__))
        for kind in ("file_edition", "calendar"):
            path = os.path.join(here, "..", "..", "tools", "edition",
                                prompt.contract_name(kind))
            with self.subTest(kind=kind):
                self.assertTrue(os.path.exists(path), path)


class LanguageSectionTest(unittest.TestCase):
    """The one section the operator cannot push off the top.

    An edition written in Korean is still assembled from an English contract,
    so the instruction that says which language to write in has to sit where
    the length budgets are still above it and the operator's own notes are
    still below it. That is the whole property, and the third test is the
    reason it is a function rather than a table: a tag nobody has named yet
    is still asked for by name instead of quietly filing English.
    """

    def test_english_leaves_the_prompt_byte_identical(self):
        # The default has to cost nothing. Every existing assertion in this
        # file is about a prompt built without a language, and they all still
        # describe the prompt an English desk sends.
        before = prompt.build_prompt("CONTRACT", [], [], "go")
        self.assertEqual(prompt.build_prompt("CONTRACT", [], [], "go", lang="en"), before)
        self.assertEqual(prompt.language_section("en"), "")

    def test_korean_is_named_after_the_contract_and_before_the_operator(self):
        text = prompt.build_prompt("CONTRACT", [("standing.md", "house style")], [], "go",
                                   lang="ko")
        sec = prompt.language_section("ko")
        self.assertIn("Korean", sec)
        self.assertIn('"lang": "ko"', sec)
        self.assertIn("KS X 1001", sec)
        self.assertLess(text.index("CONTRACT"), text.index(sec))
        self.assertLess(text.index(sec), text.index("house style"))

    def test_an_unknown_tag_is_still_asked_for_by_name(self):
        # No table of languages can be complete, and a tag this module has
        # never heard of is a language the model has: ask for it by its tag
        # rather than silently falling back to English.
        self.assertIn('"lang": "fr"', prompt.language_section("fr"))

    def test_nothing_at_all_is_english(self):
        # loop.py reads the tag out of a dict the desk filled in, so None and
        # "" are both shapes that reach here on the way to the default.
        self.assertEqual(prompt.language_section(""), "")
        self.assertEqual(prompt.language_section(None), "")

    def test_only_korean_carries_the_korean_rules(self):
        # The mechanism is not Korean-specific; the syllable set and the won
        # sign are. A French edition draws with the faces the board has.
        self.assertNotIn("KS X 1001", prompt.language_section("fr"))
        self.assertIn("French", prompt.language_section("fr"))

    def test_the_section_it_sends_the_model_to_read_exists(self):
        # The section does not restate the budget table; it names the place
        # that carries it. That makes the heading a cross-file reference, and
        # a cross-file reference by quoted title is exactly the kind that goes
        # stale silently -- the worker would send a model to a section that is
        # not there, and file a Korean edition written to the English column.
        here = os.path.dirname(os.path.abspath(__file__))
        contract_path = os.path.join(here, "..", "..", "tools", "edition", "PROMPT.md")
        with open(contract_path, encoding="utf-8") as f:
            contract = f.read()
        self.assertIn('section "The language"', prompt.language_section("ko"))
        self.assertIn("\n## The language\n", contract)


class CalendarLanguageSectionTest(unittest.TestCase):
    """The same instruction for the other job, whose fields are not a page's.

    The edition's section is wrong here in both halves and expensively wrong
    in each. It names the newspaper's fields and asks for ``lang`` at the top
    of ``news.json`` -- the one file a calendar run may not write at all -- and
    its Korean addendum carries the paper's arithmetic, where a syllable
    counts two against a fixed measure. The phone reflows and the desk counts
    code points, so carrying that over writes a 90-character field as though
    it were 45.
    """

    def test_it_asks_for_the_book_and_never_for_a_page(self):
        sec = prompt.language_section("ko", kind="calendar")
        self.assertIn("calendar.json", sec)
        self.assertNotIn("news.json", sec)
        # The book's own reader-facing fields, not the paper's.
        for field in ("title", "reason_short", "reason", "push.title",
                      "push.body", "shortfall"):
            with self.subTest(field=field):
                self.assertIn(field, sec)
        self.assertNotIn("headlines", sec)
        self.assertNotIn("generated_at", sec)

    def test_the_papers_syllable_arithmetic_is_not_carried_over(self):
        sec = prompt.language_section("ko", kind="calendar")
        self.assertNotIn("two characters", sec)
        self.assertIn("한 글자 counts one", sec)
        # And nothing about the panel's faces: KS X 1001 and the won sign are
        # facts about what the board can print, and this book is printed
        # nowhere.
        self.assertNotIn("KS X 1001", sec)

    def test_english_costs_nothing_on_this_path_either(self):
        self.assertEqual(prompt.language_section("en", kind="calendar"), "")
        self.assertEqual(prompt.language_section(None, kind="calendar"), "")

    def test_an_unknown_tag_is_still_asked_for_by_name(self):
        self.assertIn('"lang": "fr"', prompt.language_section("fr", kind="calendar"))
        self.assertIn("French", prompt.language_section("fr", kind="calendar"))

    def test_the_default_kind_is_still_the_editions_section(self):
        # The standalone producer asks for a section by tag and names no kind
        # -- `python3 agent/prompt.py --language-section ko` -- and it files
        # editions. The default has to keep printing what it always printed.
        self.assertEqual(prompt.language_section("ko"),
                         prompt.language_section("ko", kind="file_edition"))
        self.assertIn("news.json", prompt.language_section("ko"))

    def test_the_section_it_sends_the_model_to_read_exists(self):
        # `LanguageSectionTest`'s last test, for the other contract: a
        # cross-file reference by quoted title goes stale silently, and this
        # one is pointing at the table that decides whether a book is refused.
        here = os.path.dirname(os.path.abspath(__file__))
        path = os.path.join(here, "..", "..", "tools", "edition", "CALENDAR.md")
        with open(path, encoding="utf-8") as f:
            brief = f.read()
        self.assertIn('"The budget the desk enforces"',
                      prompt.language_section("ko", kind="calendar"))
        self.assertIn("\n## The budget the desk enforces\n", brief)

    def test_the_book_is_composed_with_the_calendar_tail(self):
        text = prompt.build_prompt("CONTRACT", [], [], "the book",
                                   kind="calendar", lang="ko")
        sec = prompt.language_section("ko", kind="calendar")
        self.assertLess(text.index("CONTRACT"), text.index(sec))
        self.assertLess(text.index(sec), text.index("the book"))
        self.assertIn("$EDITION_DIR/calendar.json", text)


class AskSectionTest(unittest.TestCase):
    """The three rules, and where they sit.

    Where matters as much as what. The section is below the contract, so the
    length budgets are read first and a message cannot argue with them; below
    the operator's standing instructions, so a house style still applies; and
    above the message, because the message is the thing being answered and a
    model reading a long prompt answers the end of it.
    """

    CONTRACT = "# The contract\n\n## The language\n\nwrite in the edition's language\n"

    def _prompt(self, text="why did it move?", **kw):
        return prompt.build_prompt(self.CONTRACT, [], [], text, kind="ask", **kw)

    def test_the_three_rules_are_all_there(self):
        out = self._prompt()
        self.assertIn("Write the answer to\n   `answer.md`", out)
        self.assertIn("Decide whether the message asks for the paper to change", out)
        self.assertIn("copy `current/news.json` to `news.json`", out)
        self.assertIn("Do not write\n   `news.json` for an answer-only message.", out)

    def test_the_files_it_was_given_are_named(self):
        out = self._prompt()
        self.assertIn("current/news.json", out)
        self.assertIn("current/tiles/", out)
        self.assertIn("previous.md", out)

    def test_the_order_is_contract_then_rules_then_message(self):
        out = prompt.build_prompt(self.CONTRACT, [("house.md", "keep it dry")],
                                  [{"rule": "never lead on a rumour"}],
                                  "lead with the lawsuit", kind="ask")
        self.assertLess(out.index("# The contract"), out.index("keep it dry"))
        self.assertLess(out.index("keep it dry"), out.index("never lead on a rumour"))
        self.assertLess(out.index("never lead on a rumour"),
                        out.index("answering a message"))
        self.assertLess(out.index("answering a message"),
                        out.index("lead with the lawsuit"))

    def test_the_contract_still_comes_first_and_whole(self):
        # The test the spec asks for by name: the contract's own "## The
        # language" section has to be in there, because rule 3 rewrites under
        # the same budgets as a morning edition.
        self.assertIn("## The language", self._prompt())

    def test_the_phones_language_is_a_fallback_and_not_an_instruction(self):
        # Rule 1 is "the language it was written in". `lang` is what the phone
        # was in, which only decides a message that says nothing either way --
        # a ticker alone, a number.
        out = self._prompt(ask_lang="ko")
        self.assertIn("the language it was written in", out)
        self.assertIn("fall back to Korean (한국어)", out)

    def test_no_phone_language_leaves_the_sentence_alone(self):
        out = self._prompt()
        self.assertIn("Answer the message in the language it was written in.", out)
        self.assertNotIn("fall back to", out)

    def test_the_tail_asks_for_the_answer_always_and_the_page_conditionally(self):
        out = self._prompt()
        self.assertIn("answer.md -- always", out.replace("—", "--"))
        self.assertIn("ONLY if", out)
        self.assertIn("write news.json LAST", out)

    def test_no_other_kind_gets_any_of_this(self):
        for kind in ("file_edition", "research", "custom", "calendar"):
            out = prompt.build_prompt(self.CONTRACT, [], [], "t", kind=kind)
            self.assertNotIn("answer.md", out, kind)
            self.assertNotIn("current/news.json", out, kind)

    def test_an_edition_written_in_korean_still_gets_its_own_section(self):
        # `lang` (the paper's) and `ask_lang` (the phone's) are two settings and
        # a revision uses the first: the paper does not change language because
        # the message was typed in English.
        out = self._prompt(lang="ko", ask_lang="en")
        self.assertIn("# The edition's language", out)
        self.assertIn("Write every reader-facing string in Korean", out)

    def test_the_edition_and_the_phone_never_swap_languages(self):
        # The whole reason `ask_lang` sits beside `lang` rather than replacing
        # it (spec section 3): a message typed in English must not turn a
        # Korean edition into an English one. The two tests above each set one
        # of the pair away from its default and check the other side of the
        # prompt -- which proves the swap didn't happen only because their
        # defaults happen to differ, an inference that a changed default would
        # quietly unmake. This test sets *both* away from their defaults, to
        # *different* languages, in one call, and checks both halves of the
        # one prompt that call produced: the edition still asks for Korean,
        # and the ask section's fallback is the phone's English, in the exact
        # words `ask_section` would produce for it on its own -- not the word
        # "English" occurring anywhere in a prompt that also legitimately says
        # "Korean" a few lines up for an unrelated reason.
        out = self._prompt(lang="ko", ask_lang="en")
        self.assertIn("Write every reader-facing string in Korean", out)
        self.assertIn(prompt.ask_section("en"), out)
        self.assertNotIn("fall back to Korean", out)


class SheetPromptTest(unittest.TestCase):
    """The two prompts that follow a proof."""

    def test_a_revision_carries_both_gate_reports_and_the_sheets(self):
        text = prompt.revision_prompt(
            {"validate": "lead body is short", "render": "(clean)"},
            ["/scratch/x/proof/A1.png"])
        self.assertIn("lead body is short", text)
        self.assertIn("/scratch/x/proof/A1.png", text)

    def test_a_clean_gate_still_says_so(self):
        # An empty string in the report is "nothing to say", not "no report":
        # a blank code fence reads as a truncated message.
        text = prompt.revision_prompt({}, [])
        self.assertIn("(clean)", text)

    def test_the_verdict_prompt_asks_for_one_word(self):
        text = prompt.look_prompt(["/scratch/x/proof/A1.png"])
        self.assertIn("FILE or REVISE", text)
        self.assertIn("/scratch/x/proof/A1.png", text)


if __name__ == "__main__":
    unittest.main()
