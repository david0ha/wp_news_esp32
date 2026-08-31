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
