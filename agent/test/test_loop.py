"""The three decisions the loop makes on its own: what it is configured with,
whether it may write into somebody's notes, and whether what the desk answered a
claim with is an instruction at all.

Everything else in ``loop.py`` is a claim, a subprocess and a commit, and the
parts of it that could be wrong in isolation were moved into :mod:`prompt` and
:mod:`deskclient`. What is left worth pinning is small and both halves of it
fail quietly.

``Settings.from_env`` fails quietly because compose passes an unset variable
through as an **empty string**, not as an absent key. So a default argument --
``env.get("AGENT_TOOLS", DEFAULT_TOOLS)`` -- looks correct, is correct against
a bare shell, and hands the container an empty allowlist the moment
``${AGENT_TOOLS:-}`` is interpolated. The worker would come up, claim, and be
unable to read a file, and nothing in the log would say why.

``write_brief`` fails quietly in the other direction: it is the one thing in
this repository that writes into a directory the operator owns, and the failure
is not an exception -- it is a file appearing in somebody's vault that they
did not ask for.

``is_command`` fails loudest of the three, which is why it is here: the answer
it rejects arrives as a **200**, and reading an id off it raises outside every
try in :func:`loop.main`. A worker that exits is a worker that ``restart:
unless-stopped`` restarts, which replaces this loop's one-second-to-five-minute
backoff with a container that comes up and dies once a minute forever.
"""

from __future__ import annotations

import os
import shutil
import tempfile
import unittest

import loop


class SettingsTest(unittest.TestCase):
    """``from_env``: the image's defaults, and what an empty string means."""

    def test_a_worker_with_no_environment_at_all_gets_the_images_defaults(self):
        # The paths the Dockerfile lays down. A container started with nothing
        # set reaches the desk over the wpnews network and files, which is what
        # makes agent/compose.yaml's environment block optional rather than
        # load-bearing.
        cfg = loop.Settings.from_env({})
        self.assertEqual(cfg.desk, "http://desk:8080")
        self.assertEqual(cfg.secrets, "/run/secrets")
        self.assertEqual(cfg.repo, "/repo")
        self.assertEqual(cfg.scratch, "/scratch")
        self.assertEqual(cfg.log_level, "INFO")
        self.assertEqual(cfg.tools, loop.DEFAULT_TOOLS)
        # Off by default, both of them: no context directory, and no writing.
        self.assertIsNone(cfg.context_dir)
        self.assertFalse(cfg.write_briefs)

        # An empty string is the same as absent, because that is the shape
        # compose produces from `${AGENT_CONTEXT_DIR}` with nothing in .env, and
        # "" would otherwise be a path the worker went looking for.
        self.assertIsNone(loop.Settings.from_env({"AGENT_CONTEXT_DIR": ""}).context_dir)
        self.assertEqual(loop.Settings.from_env({"AGENT_CONTEXT_DIR": "/context"}).context_dir,
                         "/context")

    def test_an_empty_allowlist_falls_back_rather_than_disarming_the_worker(self):
        # The mutation this exists to catch is one character of API:
        # `env.get("AGENT_TOOLS") or DEFAULT_TOOLS` becoming
        # `env.get("AGENT_TOOLS", DEFAULT_TOOLS)`. Both read correctly, both
        # pass against a bare shell, and the second hands the container an empty
        # allowlist as soon as compose interpolates `${AGENT_TOOLS:-}`. A worker
        # that may use no tools comes up, claims an instruction, and cannot read
        # a file -- with nothing in the log to say why.
        self.assertEqual(loop.Settings.from_env({"AGENT_TOOLS": ""}).tools,
                         loop.DEFAULT_TOOLS)
        self.assertEqual(loop.Settings.from_env({}).tools, loop.DEFAULT_TOOLS)

        # A list the operator did set is taken verbatim -- it replaces the
        # default rather than extending it, which is what lets a market-data MCP
        # be added and render-check.sh stay off.
        mine = "Read,Write,mcp__your_broker__*"
        self.assertEqual(loop.Settings.from_env({"AGENT_TOOLS": mine}).tools, mine)


class WriteBriefTest(unittest.TestCase):
    """The one write into a directory this repository does not own."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)

    def settings(self, **env) -> loop.Settings:
        env.setdefault("AGENT_CONTEXT_DIR", self.tmp)
        return loop.Settings.from_env(env)

    def file(self, day: str = "2026-08-23") -> str:
        return os.path.join(self.tmp, "briefs", day + ".md")

    def test_a_context_directory_alone_does_not_authorise_writing_into_it(self):
        # Asked for twice or not at all. Pointing this worker at a folder of
        # somebody's notes is a decision to have it *read* them; deciding on
        # their behalf that it may also write into them is not this
        # repository's to make, so the default leaves the directory untouched.
        cfg = self.settings()
        self.assertFalse(cfg.write_briefs)
        loop.write_brief(cfg, "2026-08-23", {"kind": "file_edition", "text": "NVDA"},
                         {"state": "published", "edition_id": "abc"}, "")
        # Not merely no file -- no `briefs/` directory either. A worker that
        # laid down the tree and then wrote nothing into it would look, in
        # somebody's vault git history, exactly like one that had been given
        # permission.
        self.assertEqual(os.listdir(self.tmp), [])

    def test_both_keys_set_appends_one_section_per_filing(self):
        cfg = self.settings(AGENT_WRITE_BRIEFS="1")
        self.assertTrue(cfg.write_briefs)
        loop.write_brief(cfg, "2026-08-23", {"kind": "file_edition", "text": "NVDA"},
                         {"state": "published", "edition_id": "aaa"}, "clean")
        loop.write_brief(cfg, "2026-08-23", {"kind": "file_edition", "text": "AAPL"},
                         {"state": "staged", "edition_id": "bbb"}, "")

        with open(self.file(), encoding="utf-8") as f:
            text = f.read()
        # Appended, not replaced. Two editions can be filed on one day, and the
        # second must not erase the first -- which is also why this is the one
        # write in the worker that does not go through a temporary file and a
        # rename.
        self.assertEqual(text.count("**Instruction:**"), 2)
        self.assertIn("NVDA", text)
        self.assertIn("AAPL", text)
        self.assertIn("aaa", text)
        self.assertIn("bbb", text)


class ClaimAnswerTest(unittest.TestCase):
    """A 200 from the desk is not yet an instruction.

    :meth:`deskclient.DeskClient._json` deliberately does not raise on a 200
    whose body is not JSON -- it answers ``{"ok": False, "error": "not_json",
    ...}`` so that a proxy in front of the tunnel serving an HTML error page
    gets *reported* rather than swallowed. That answer reaches the loop, and so
    does a 200 carrying a JSON array. Neither has an id.
    """

    def test_a_not_json_answer_is_not_a_command(self):
        self.assertFalse(loop.is_command(
            {"ok": False, "error": "not_json",
             "detail": "<html>502 bad gateway</html>"}))

    def test_a_json_array_is_not_a_command(self):
        # Worth its own case because it fails differently: ``command["id"]`` on
        # a list is a TypeError where the not_json dict is a KeyError, and an
        # `isinstance` check that only rejected the dict would still exit.
        self.assertFalse(loop.is_command([{"id": "abc"}]))
        self.assertFalse(loop.is_command([]))

    def test_an_expired_long_poll_is_not_a_command_either(self):
        # ``None`` is the healthy idle answer and the loop handles it before it
        # gets here, but nothing about it is runnable.
        self.assertFalse(loop.is_command(None))

    def test_a_dict_with_an_id_is_a_command(self):
        self.assertTrue(loop.is_command({"id": "abc", "text": "NVDA"}))
        # The id alone is enough. It is what ``finish`` reports against, which
        # is what makes an instruction that fails still leave the queue -- so a
        # command with nothing else in it is one the loop must still take.
        self.assertTrue(loop.is_command({"id": "abc"}))


if __name__ == "__main__":
    unittest.main()
