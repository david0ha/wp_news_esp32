"""The two decisions the loop makes on its own: what it is configured with, and
whether it may write into somebody's notes.

Everything else in ``loop.py`` is a claim, a subprocess and a commit, and the
parts of it that could be wrong in isolation were moved into :mod:`prompt` and
:mod:`deskclient` -- including the third decision that used to be here, whether
what the desk answered a claim with is an instruction at all. That belongs to
:meth:`deskclient.DeskClient.claim`, which promises a command or a raise, and
``test_deskclient.ClaimTest`` is where it is held to it. What is left worth
pinning here is small and both halves of it fail quietly.

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
"""

from __future__ import annotations

import json
import os
import shutil
import tempfile
import unittest

import loop


class SettingsTest(unittest.TestCase):
    """``from_env``: the image's defaults, and what an empty string means."""

    def test_a_worker_with_no_environment_at_all_gets_the_images_defaults(self):
        # The paths the Dockerfile lays down. A container started with nothing
        # set reaches the desk over the claudepost network and files, which is what
        # makes agent/compose.yaml's environment block optional rather than
        # load-bearing.
        cfg = loop.Settings.from_env({})
        self.assertEqual(cfg.desk, "http://desk:8080")
        self.assertEqual(cfg.secrets, "/run/secrets")
        self.assertEqual(cfg.repo, "/repo")
        self.assertEqual(cfg.scratch, "/scratch")
        self.assertEqual(cfg.log_level, "INFO")
        self.assertEqual(cfg.tools, loop.DEFAULT_TOOLS)
        # Off by default, all three: no context directory, no writing, and a
        # loop that does not stop -- a resident worker is the arrangement both
        # compose files describe.
        self.assertIsNone(cfg.context_dir)
        self.assertFalse(cfg.write_briefs)
        self.assertFalse(cfg.once)
        self.assertTrue(loop.Settings.from_env({"CLAUDEPOST_ONCE": "1"}).once)

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


class FetchSheetsTest(unittest.TestCase):
    """The sheet names, which arrive from the desk and become paths.

    The desk applies ``os.path.basename`` to them before it reports them, so
    today every name is already a bare one. That is the desk remembering, and
    this is the worker not depending on it: the two containers are on opposite
    sides of a token, and a name is checked where it is joined.
    """

    class Desk:
        """Enough of :class:`deskclient.DeskClient` to answer ``fetch_sheet``."""

        def __init__(self):
            self.asked = []

        def fetch_sheet(self, draft, name):
            self.asked.append(name)
            return b"\x89PNG\r\n\x1a\n"

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)

    def test_a_sheet_name_that_is_a_path_is_not_written(self):
        into = os.path.join(self.tmp, "proof")
        desk = self.Desk()
        paths = loop.fetch_sheets(desk, "d", ["../escaped.png", "sub/A1.png",
                                              "/etc/A1.png", "A1.png"], into)

        self.assertEqual(paths, [os.path.join(into, "A1.png")])
        self.assertEqual(os.listdir(into), ["A1.png"])
        self.assertFalse(os.path.exists(os.path.join(self.tmp, "escaped.png")))
        # And nothing was even asked for: a name that cannot be written is a
        # name there is no point fetching.
        self.assertEqual(desk.asked, ["A1.png"])

    def test_the_names_the_desk_really_sends_are_written(self):
        into = os.path.join(self.tmp, "proof")
        paths = loop.fetch_sheets(self.Desk(), "d", ["A1.png", "A2.bmp"], into)
        self.assertEqual(sorted(os.path.basename(p) for p in paths),
                         ["A1.png", "A2.bmp"])


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


class UploadNotesTest(unittest.TestCase):
    """``upload()``'s third file: a note that travels with the draft it
    explains, and never holds back the two files that matter more.
    """

    class Desk:
        """Enough of :class:`deskclient.DeskClient` to answer ``upload()``."""

        def __init__(self, notes_error: Exception | None = None):
            self.notes_error = notes_error
            self.payloads = []
            self.tiles = []
            self.notes_calls = []

        def open_draft(self):
            return "d" * 32

        def put_payload(self, draft, data):
            self.payloads.append((draft, data))

        def put_tile(self, draft, tile_id, data):
            self.tiles.append((draft, tile_id, data))

        def put_notes(self, text, *, draft=None, command=None):
            self.notes_calls.append({"text": text, "draft": draft, "command": command})
            if self.notes_error is not None:
                raise self.notes_error

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        with open(os.path.join(self.tmp, "news.json"), "w", encoding="utf-8") as f:
            f.write("{}")

    def test_a_notes_file_beside_the_payload_reaches_the_draft(self):
        text = "# Sources\n\n- Alpaca, get_stock_snapshot\n- 10-Q, filed 2026-08-20\n"
        with open(os.path.join(self.tmp, "notes.md"), "w", encoding="utf-8") as f:
            f.write(text)

        desk = self.Desk()
        draft = loop.upload(desk, self.tmp)

        self.assertEqual(desk.notes_calls,
                         [{"text": text, "draft": draft, "command": None}])

    def test_no_notes_file_is_not_a_failure(self):
        desk = self.Desk()
        draft = loop.upload(desk, self.tmp)

        # The payload still went up -- a missing notes.md is not the
        # payload's problem -- and put_notes was never even asked, because
        # there was nothing to file.
        self.assertEqual(desk.payloads, [(draft, b"{}")])
        self.assertEqual(desk.notes_calls, [])

    def test_a_desk_that_refuses_the_note_still_files_the_edition(self):
        with open(os.path.join(self.tmp, "notes.md"), "w", encoding="utf-8") as f:
            f.write("more than the desk will take, or the desk is briefly down")

        desk = self.Desk(notes_error=RuntimeError("put notes: 413 too large"))
        # upload() must not raise: the payload and every tile are already in
        # the draft by the time the note is refused, and a note is evidence
        # about the page, not the page.
        draft = loop.upload(desk, self.tmp)

        self.assertEqual(desk.payloads, [(draft, b"{}")])
        self.assertEqual(len(desk.notes_calls), 1)


class HandleResearchTest(unittest.TestCase):
    """``handle()``'s other outcome: an instruction with no page to file, so
    the note the model wrote is the deliverable and it goes on the command
    that asked for it rather than on a draft that was never opened.
    """

    class Desk:
        """Enough of :class:`deskclient.DeskClient` for a research turn.

        Deliberately has no ``open_draft``, ``proof`` or ``commit`` -- a call
        to any of them is exactly the bug this test exists to catch, and an
        ``AttributeError`` from a stub that does not have the method says so
        more loudly than a mock that quietly counted one more call.
        """

        def __init__(self):
            self.notes_calls = []
            self.finished = []

        def directives(self):
            return []

        def put_notes(self, text, *, draft=None, command=None):
            self.notes_calls.append({"text": text, "draft": draft, "command": command})

        def finish(self, cid, ok, result):
            self.finished.append((cid, ok, result))

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.cfg = loop.Settings.from_env({"CLAUDEPOST_SCRATCH": self.tmp})

        # The contract is read from disk in the ordinary path; a research
        # turn in this test needs none of tools/edition/PROMPT.md's text, so
        # it is replaced rather than pointing CLAUDEPOST_REPO at a checkout.
        self._real_read_contract = loop.read_contract
        loop.read_contract = lambda repo: "the contract"
        self.addCleanup(setattr, loop, "read_contract", self._real_read_contract)

    def test_a_research_command_attaches_its_note_to_the_command(self):
        note_text = "Looked at NVDA's supplier mix. Nothing outranks the rotation today.\n"

        def fake_run_claude(cfg, text, workdir, extra_env):
            # Stands in for the headless turn: a research command's model
            # writes notes.md and no news.json, because there is no page.
            with open(os.path.join(workdir, "notes.md"), "w", encoding="utf-8") as f:
                f.write(note_text)
            return 0

        real_run_claude = loop.run_claude
        loop.run_claude = fake_run_claude
        self.addCleanup(setattr, loop, "run_claude", real_run_claude)

        desk = self.Desk()
        cid = "c" * 32
        command = {"id": cid, "kind": "research", "text": "look into NVDA's supply chain"}
        loop.handle(self.cfg, desk, command, {})

        self.assertEqual(desk.notes_calls,
                         [{"text": note_text, "draft": None, "command": cid}])
        self.assertEqual(desk.finished, [(cid, True, note_text)])


class ReadNotesTest(unittest.TestCase):
    """``read_notes()`` on its own, past the cap."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)

    def test_a_note_cut_at_the_cap_has_no_stray_replacement_character(self):
        # 262144 % 3 == 1 (confirmed against deskclient.MAX_NOTES_BYTES), so
        # a run of three-byte characters is cut mid-character at the cap.
        # "ignore" drops the dangling partial sequence; "replace" would leave
        # a visible U+FFFD where put_notes' own cut never would.
        text = "가" * (loop.MAX_NOTES_BYTES // 3 + 10)          # "가", 3 bytes each
        with open(os.path.join(self.tmp, "notes.md"), "w", encoding="utf-8") as f:
            f.write(text)

        note = loop.read_notes(self.tmp)

        self.assertNotIn("�", note)
        self.assertTrue(note)
        self.assertTrue(text.startswith(note))


class HandleCustomTest(unittest.TestCase):
    """``handle()``'s third case: a ``custom`` command, which may or may not
    turn into a page. What is on disk after the turn decides, not the kind.
    """

    class Desk:
        """Enough of :class:`deskclient.DeskClient` for a custom turn that
        does file a page -- the full draft/proof/commit surface.
        """

        def __init__(self):
            self.notes_calls = []
            self.finished = []
            self.payloads = []
            self.commits = []

        def directives(self):
            return []

        def open_draft(self):
            return "d" * 32

        def put_payload(self, draft, data):
            self.payloads.append((draft, data))

        def put_tile(self, draft, tile_id, data):
            pass

        def put_notes(self, text, *, draft=None, command=None):
            self.notes_calls.append({"text": text, "draft": draft, "command": command})

        def proof(self, draft):
            return {"ok": True, "sheets": []}

        def commit(self, draft):
            self.commits.append(draft)
            return {"state": "staged", "edition_id": "e" * 32}

        def finish(self, cid, ok, result):
            self.finished.append((cid, ok, result))

    class NoDraftDesk:
        """Enough of :class:`deskclient.DeskClient` for a custom turn that
        does not -- no ``open_draft``, ``proof`` or ``commit`` at all, so a
        call to any of them fails the test as loudly as possible.
        """

        def __init__(self):
            self.notes_calls = []
            self.finished = []

        def directives(self):
            return []

        def put_notes(self, text, *, draft=None, command=None):
            self.notes_calls.append({"text": text, "draft": draft, "command": command})

        def finish(self, cid, ok, result):
            self.finished.append((cid, ok, result))

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.cfg = loop.Settings.from_env({"CLAUDEPOST_SCRATCH": self.tmp})

        self._real_read_contract = loop.read_contract
        loop.read_contract = lambda repo: "the contract"
        self.addCleanup(setattr, loop, "read_contract", self._real_read_contract)

    def _patch_run_claude(self, fn):
        real = loop.run_claude
        loop.run_claude = fn
        self.addCleanup(setattr, loop, "run_claude", real)

    def test_a_custom_command_that_produced_a_page_still_files_it(self):
        note_text = "NVDA's guide beat the whisper number; sourced to the call transcript.\n"

        def fake_run_claude(cfg, text, workdir, extra_env):
            with open(os.path.join(workdir, "news.json"), "w", encoding="utf-8") as f:
                f.write("{}")
            with open(os.path.join(workdir, "notes.md"), "w", encoding="utf-8") as f:
                f.write(note_text)
            return 0

        self._patch_run_claude(fake_run_claude)

        desk = self.Desk()
        cid = "b" * 32
        command = {"id": cid, "kind": "custom", "text": "put NVDA on tomorrow's front page"}
        loop.handle(self.cfg, desk, command, {})

        # The page went through the ordinary pipeline -- committed, with its
        # note on the draft, not on the command.
        self.assertEqual(desk.commits, ["d" * 32])
        self.assertEqual(desk.notes_calls,
                         [{"text": note_text, "draft": "d" * 32, "command": None}])
        self.assertEqual(desk.finished, [(cid, True, "staged " + "e" * 32)])

    def test_a_custom_command_without_a_page_files_its_note_on_the_command(self):
        note_text = "Looked into NVDA's supplier mix. Nothing outranks the rotation today.\n"

        def fake_run_claude(cfg, text, workdir, extra_env):
            # No news.json -- the operator's text turned out to be a look,
            # not an order, and this loop takes disk as the source of truth.
            with open(os.path.join(workdir, "notes.md"), "w", encoding="utf-8") as f:
                f.write(note_text)
            return 0

        self._patch_run_claude(fake_run_claude)

        desk = self.NoDraftDesk()
        cid = "a" * 32
        command = {"id": cid, "kind": "custom", "text": "keep an eye on NVDA this week"}
        loop.handle(self.cfg, desk, command, {})

        self.assertEqual(desk.notes_calls,
                         [{"text": note_text, "draft": None, "command": cid}])
        self.assertEqual(desk.finished, [(cid, True, note_text)])
class AuthRouteTest(unittest.TestCase):
    """Which credentials `claude --print` can start from, and the expensive tie.

    This worker was written for a container, where the only way in is a key or a
    token in ``agent.env``: a headless process in an image has no desktop login
    session to inherit. Run the same loop on the machine the operator is signed
    in on -- which is the whole point of ``agent/run-host.sh`` -- and there is a
    third route, and it is the one that costs a subscription rather than a
    metered key.

    The tie is what this is really for. With an API key in the environment
    *beside* a subscription login, `claude` starts either way and the bill is
    the difference. That is invisible from the log, invisible from the paper,
    and shows up on a statement four weeks later.
    """

    def setUp(self):
        self.home = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.home, True)

    def login(self):
        """Lay down what a signed-in CLI leaves on disk."""
        os.makedirs(os.path.join(self.home, ".claude"), exist_ok=True)
        with open(os.path.join(self.home, ".claude", ".credentials.json"), "w") as f:
            f.write("{}")

    def test_a_container_with_nothing_in_agent_env_has_no_route(self):
        self.assertEqual(loop.claude_auth({}, {}, self.home), [])

    def test_a_signed_in_machine_is_a_route_with_no_key_anywhere(self):
        self.login()
        self.assertEqual(loop.claude_auth({}, {}, self.home), [loop.CLI_LOGIN])

    def test_either_variable_counts_from_either_place(self):
        # agent.env is what a human edits; the process environment is what
        # run-host.sh and launchd set. Both reach the child the same way.
        self.assertEqual(loop.claude_auth({"CLAUDE_CODE_OAUTH_TOKEN": "x"}, {}, self.home),
                         ["CLAUDE_CODE_OAUTH_TOKEN"])
        self.assertEqual(loop.claude_auth({}, {"ANTHROPIC_API_KEY": "x"}, self.home),
                         ["ANTHROPIC_API_KEY"])

    def test_a_key_beside_a_login_is_reported_as_two(self):
        # Not an error -- the operator may mean it. But main() can only warn
        # about an ambiguity it can see, and this is where it becomes visible.
        self.login()
        self.assertEqual(loop.claude_auth({"ANTHROPIC_API_KEY": "x"}, {}, self.home),
                         ["ANTHROPIC_API_KEY", loop.CLI_LOGIN])

    def test_an_empty_variable_is_not_a_route(self):
        # Same trap as AGENT_TOOLS: compose turns an unset variable into an
        # empty string, and an empty key is not a credential.
        self.assertEqual(loop.claude_auth({"ANTHROPIC_API_KEY": ""}, {}, self.home), [])


class ArgvTest(unittest.TestCase):
    """Where the prompt goes, which is not on the command line.

    ``--allowedTools`` is variadic: it consumes every following argument until
    the next flag. A prompt passed as the trailing positional is therefore read
    as more allow-list rules, one per whitespace-separated word, and the CLI
    then exits with "Input must be provided" -- having first printed a warning
    for every word of the prompt that happened to contain an asterisk.

    Nothing about that failure names the cause. It cost a filing run to find,
    and the fix is one line, so the shape of the command line is pinned here.
    """

    def test_the_prompt_is_not_an_argument(self):
        cfg = loop.Settings.from_env({"CLAUDEPOST_REPO": "/repo"})
        argv = loop.claude_argv(cfg, "/work")
        self.assertEqual(argv[0], "claude")
        self.assertIn("--print", argv)
        # The last flag is the allow-list and nothing follows its value: that is
        # what keeps a variadic option from reaching the prompt.
        self.assertEqual(argv[-2], "--allowedTools")
        self.assertEqual(argv[-1], loop.DEFAULT_TOOLS.format(repo="/repo"))

    def test_the_operators_own_mcp_servers_are_kept_out_by_default(self):
        # A worker running on somebody's laptop inherits that laptop's MCP
        # configuration, and the first live run proved what that costs: the
        # child loaded a browser-automation server, wrote .playwright-mcp/ into
        # the edition directory and spent twelve minutes browsing instead of
        # filing. It did not fail -- it wandered, which is worse, because a
        # failure is a log line and this is a morning with no paper.
        cfg = loop.Settings.from_env({})
        self.assertTrue(cfg.strict_mcp)
        self.assertIn("--strict-mcp-config", loop.claude_argv(cfg, "/work"))

    def test_the_operator_can_let_their_own_servers_back_in(self):
        # A market-data MCP is a real reason to want them, and whose data to
        # trust is the reader's decision -- so this is a switch and not a rule.
        cfg = loop.Settings.from_env({"AGENT_STRICT_MCP": "0"})
        self.assertFalse(cfg.strict_mcp)
        self.assertNotIn("--strict-mcp-config", loop.claude_argv(cfg, "/work"))

    def test_the_child_may_not_delegate(self):
        # The third live run failed here and produced nothing but a skeleton:
        # the child read the operator's own global CLAUDE.md -- which is about
        # orchestrating subagents, because that is what the operator uses this
        # machine for -- dispatched two research agents, and was killed at their
        # background ceiling with the page half-written. Its own last line said
        # so: "the two research agents, which are still running".
        #
        # An allow-list cannot express this. Only a deny-list can, because deny
        # beats allow and beats a permissive settings file too.
        argv = loop.claude_argv(loop.Settings.from_env({}), "/work")
        self.assertIn("--disallowedTools", argv)
        denied = argv[argv.index("--disallowedTools") + 1]
        self.assertIn("Task", denied)
        self.assertIn("Agent", denied)

    def test_the_child_is_told_what_it_is_in_the_system_prompt(self):
        # Belt and braces, and the braces are the interesting half: the deny
        # list stops the delegation, this stops the *plan* that wanted to
        # delegate. A run that spends its first turns deciding how to fan out
        # has already lost the time it was going to save.
        argv = loop.claude_argv(loop.Settings.from_env({}), "/work")
        self.assertIn("--append-system-prompt", argv)
        appended = argv[argv.index("--append-system-prompt") + 1]
        self.assertIn("subagent", appended.lower())

    def test_the_repository_is_substituted_into_the_allowlist(self):
        cfg = loop.Settings.from_env({
            "CLAUDEPOST_REPO": "/srv/claudepost",
            "AGENT_TOOLS": "Read,Bash(python3 {repo}/tools/make_tile.py:*)"})
        self.assertIn("Bash(python3 /srv/claudepost/tools/make_tile.py:*)",
                      loop.claude_argv(cfg, "/work")[-1])


class WatchlistTest(unittest.TestCase):
    """The universe and the rotation cursor, across a scratch directory that dies.

    ``tools/edition/PROMPT.md`` tells the worker to read ``watchlist.json`` from
    the edition directory, take the next symbol after ``last``, and update
    ``last`` when it files. The edition directory is made fresh per command and
    deleted with the next one, so without these two functions that contract runs
    against a file that never exists: the model invents a universe every morning
    and the rotation never advances. The symptom is not an error -- it is a
    paper that covers the same four companies forever.
    """

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.work = os.path.join(self.tmp, "work")
        os.makedirs(self.work)
        self.path = os.path.join(self.tmp, "watchlist.json")

    def settings(self, **env) -> loop.Settings:
        env.setdefault("CLAUDEPOST_WATCHLIST", self.path)
        return loop.Settings.from_env(env)

    def write(self, doc) -> None:
        with open(self.path, "w", encoding="utf-8") as f:
            json.dump(doc, f)

    def in_work(self):
        with open(os.path.join(self.work, "watchlist.json"), encoding="utf-8") as f:
            return json.load(f)

    def back(self):
        with open(self.path, encoding="utf-8") as f:
            return json.load(f)

    def test_the_default_lives_beside_the_token_not_in_the_scratch(self):
        # <secrets>/watchlist.json: the operator's own directory, which survives
        # a container being rebuilt and a scratch volume being pruned. The
        # rotation is the one piece of worker state that must outlive both.
        self.assertEqual(loop.Settings.from_env({}).watchlist,
                         "/run/secrets/watchlist.json")

    def test_no_watchlist_anywhere_is_not_an_error(self):
        # The contract already covers this: "if it is missing, write one and say
        # so in your summary". A first run on a fresh machine is that case.
        self.assertFalse(loop.seed_watchlist(self.settings(), self.work))
        self.assertEqual(os.listdir(self.work), [])

    def test_it_is_seeded_into_the_edition_directory(self):
        self.write({"symbols": ["NVDA", "AAPL"], "last": "NVDA"})
        self.assertTrue(loop.seed_watchlist(self.settings(), self.work))
        self.assertEqual(self.in_work(), {"symbols": ["NVDA", "AAPL"], "last": "NVDA"})

    def test_the_cursor_the_model_moved_comes_back(self):
        self.write({"symbols": ["NVDA", "AAPL"], "last": "NVDA"})
        loop.seed_watchlist(self.settings(), self.work)
        with open(os.path.join(self.work, "watchlist.json"), "w", encoding="utf-8") as f:
            json.dump({"symbols": ["NVDA", "AAPL"], "last": "AAPL"}, f)

        self.assertTrue(loop.persist_watchlist(self.settings(), self.work))
        self.assertEqual(self.back()["last"], "AAPL")

    def test_a_symbol_the_model_added_comes_back_too(self):
        # The rotation is not only the reader's to edit. A worker that found a
        # company worth following writes it into the file it was handed, and
        # tomorrow's run starts from the wider universe.
        self.write({"symbols": ["NVDA"], "last": "NVDA"})
        loop.seed_watchlist(self.settings(), self.work)
        with open(os.path.join(self.work, "watchlist.json"), "w", encoding="utf-8") as f:
            json.dump({"symbols": ["NVDA", "ETN"], "last": "ETN"}, f)

        loop.persist_watchlist(self.settings(), self.work)
        self.assertEqual(self.back()["symbols"], ["NVDA", "ETN"])

    def test_junk_does_not_replace_a_good_universe(self):
        # The file that comes back was last written by a language model in a
        # scratch directory, and it is the only state the rotation has. An empty
        # list, a string, a truncated write: each of them silently ends the
        # rotation, so none of them is allowed to land.
        good = {"symbols": ["NVDA", "AAPL"], "last": "NVDA"}
        for junk in ('not json at all', '[]', '{"symbols": []}',
                     '{"symbols": "NVDA"}', '{"last": "NVDA"}',
                     '{"symbols": [1, 2]}'):
            with self.subTest(junk=junk):
                self.write(good)
                with open(os.path.join(self.work, "watchlist.json"), "w",
                          encoding="utf-8") as f:
                    f.write(junk)
                self.assertFalse(loop.persist_watchlist(self.settings(), self.work))
                self.assertEqual(self.back(), good)

    def test_a_read_only_secrets_mount_is_a_warning_not_a_failure(self):
        # The container mounts ~/.claudepost read-only, which is right: it holds
        # the token. Losing a rotation cursor is not a reason to fail a filing
        # that has already reached the glass.
        self.write({"symbols": ["NVDA"], "last": "NVDA"})
        loop.seed_watchlist(self.settings(), self.work)
        with open(os.path.join(self.work, "watchlist.json"), "w", encoding="utf-8") as f:
            json.dump({"symbols": ["NVDA"], "last": "AAPL"}, f)
        # The file rather than the directory: opening an existing file for
        # writing never consults the directory's mode, so a test that chmodded
        # the directory would pass while proving nothing.
        os.chmod(self.path, 0o444)
        self.addCleanup(os.chmod, self.path, 0o600)
        self.assertFalse(loop.persist_watchlist(self.settings(), self.work))
        self.assertEqual(self.back()["last"], "NVDA")


if __name__ == "__main__":
    unittest.main()
