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

The third thing pinned here is not a decision at all, it is a **split**, and
it is the one property in this file whose failure is not quiet but permanent:
``seed_positions`` runs for the ``calendar`` kind and for no other, so the
process that writes the newspaper never holds the owner's positions. See
:class:`SeedingSplitTest`, which is written as a sweep over every other kind
rather than as an assertion about the one -- what is being asserted is an
absence, and an absence has to be looked for everywhere it could be.
"""

from __future__ import annotations

import datetime
import json
import os
import shutil
import subprocess
import tempfile
import time
import unittest
from unittest import mock

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
        # And no book line: an edition is not a book, and the brief for one
        # reads exactly as it always has.
        self.assertNotIn("**Book:**", text)

    def test_a_book_adds_one_line_and_an_edition_adds_none(self):
        # The count is the point. There is no edition_id on the calendar path
        # and the model's own notes say what it looked at rather than what it
        # filed, so a book quietly shrinking from ten to four over a fortnight
        # is visible in this line and nowhere else.
        cfg = self.settings(AGENT_WRITE_BRIEFS="1")
        loop.write_brief(cfg, "2026-08-23", {"kind": "calendar", "text": "the book"},
                         {"state": "filed"}, "",
                         book={"events": [{"id": "e_a1c4"}, {"id": "e_b207"}],
                               "shortfall": "여섯 개였어요"})
        with open(self.file(), encoding="utf-8") as f:
            text = f.read()
        self.assertIn("**Book:** 2 event(s), shortfall: 여섯 개였어요", text)

        # A full book says so rather than leaving the field out, so the line
        # is a count somebody can read down a column of days.
        loop.write_brief(cfg, "2026-08-23", {"kind": "calendar", "text": "the book"},
                         {"state": "filed"}, "",
                         book={"events": [{}] * 10, "shortfall": None})
        with open(self.file(), encoding="utf-8") as f:
            self.assertIn("**Book:** 10 event(s), shortfall: none", f.read())


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

        def settings(self):
            return {"lang": "en"}

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
        loop.read_contract = lambda repo, kind="file_edition": "the contract"
        self.addCleanup(setattr, loop, "read_contract", self._real_read_contract)

    def test_a_research_command_attaches_its_note_to_the_command(self):
        note_text = "Looked at NVDA's supplier mix. Nothing outranks the rotation today.\n"

        def fake_run_claude(cfg, text, workdir, extra_env, *_):
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

        def settings(self):
            return {"lang": "en"}

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

        def settings(self):
            return {"lang": "en"}

        def put_notes(self, text, *, draft=None, command=None):
            self.notes_calls.append({"text": text, "draft": draft, "command": command})

        def finish(self, cid, ok, result):
            self.finished.append((cid, ok, result))

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.cfg = loop.Settings.from_env({"CLAUDEPOST_SCRATCH": self.tmp})

        self._real_read_contract = loop.read_contract
        loop.read_contract = lambda repo, kind="file_edition": "the contract"
        self.addCleanup(setattr, loop, "read_contract", self._real_read_contract)

    def _patch_run_claude(self, fn):
        real = loop.run_claude
        loop.run_claude = fn
        self.addCleanup(setattr, loop, "run_claude", real)

    def test_a_custom_command_that_produced_a_page_still_files_it(self):
        note_text = "NVDA's guide beat the whisper number; sourced to the call transcript.\n"

        def fake_run_claude(cfg, text, workdir, extra_env, *_):
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

        def fake_run_claude(cfg, text, workdir, extra_env, *_):
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


class CalendarDesk:
    """Enough of :class:`deskclient.DeskClient` for every kind of command.

    One stub rather than four because :class:`SeedingSplitTest` runs the same
    handle() over every kind and has to be able to; the per-kind stubs above
    stay as they are, where the point of each is the method it deliberately
    does *not* have.
    """

    def __init__(self, positions=None, calendar=None, econ=None):
        self._positions = positions
        self._calendar = calendar
        self._econ = econ
        self.books = []
        self.notes_calls = []
        self.finished = []
        self.commits = []
        self.econ_windows = []

    # the prompt
    def directives(self):
        return []

    def settings(self):
        return {"lang": "en"}

    # the owner's documents
    def positions(self):
        return self._positions

    def calendar(self):
        return self._calendar

    def econ(self, from_date, to_date):
        self.econ_windows.append((from_date, to_date))
        return self._econ

    def put_calendar(self, data):
        self.books.append(data)

    # the draft path
    def open_draft(self):
        return "d" * 32

    def put_payload(self, draft, data):
        pass

    def put_tile(self, draft, tile_id, data):
        pass

    def proof(self, draft):
        return {"ok": True, "sheets": []}

    def commit(self, draft):
        self.commits.append(draft)
        return {"state": "staged", "edition_id": "e" * 32}

    # both paths
    def put_notes(self, text, *, draft=None, command=None):
        self.notes_calls.append({"text": text, "draft": draft, "command": command})

    def finish(self, cid, ok, result):
        self.finished.append((cid, ok, result))


class SeedingSplitTest(unittest.TestCase):
    """**The security property**, and it is the reason this feature is shaped
    the way it is rather than a tidiness argument about scratch directories.

    ``GET /news.json`` is served with **no authorization at all** -- it has to
    be, because the board on the wall polls it. So the one catastrophic
    outcome of the event book is a strike, a contract count or an entry price
    reaching an edition, at a public URL, permanently, in a fetch that cannot
    be taken back.

    Two defences, neither sufficient alone. The edition validator refuses a
    payload carrying position fields; that is the other half and it lives on
    the desk. This half is structural and stronger: **the process that writes
    the newspaper never has the file.** ``seed_positions`` runs for exactly
    one kind of command, and what this asserts is what is on disk at the
    instant the model starts reading -- which is the only moment the question
    is about.
    """

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.cfg = loop.Settings.from_env({"CLAUDEPOST_SCRATCH": self.tmp})
        real = loop.read_contract
        loop.read_contract = lambda repo, kind="file_edition": "the contract"
        self.addCleanup(setattr, loop, "read_contract", real)

    #: A book of positions in the shape the desk serves, from the shipped
    #: example. No real ticker, strike or holding enters a committed file.
    POSITIONS = {
        "updated_at": "2026-09-08T05:00:00Z",
        "positions": [{"id": "p_1f05f8", "symbol": "AAAA", "kind": "stock",
                       "opened_at": "2026-08-19", "note": "", "quantity": 40,
                       "entry_price_cents": 158300}],
    }

    def run_seeding(self, kind: str) -> str:
        """Run one command of ``kind`` and answer with what the model could see.

        The workdir is returned still holding what was seeded into it, because
        the fake turn below writes that kind's deliverable and nothing else --
        so an assertion about ``positions.json`` afterwards is an assertion
        about the directory the child was started in.
        """
        deliverable = {"research": "notes.md", "calendar": "calendar.json"}.get(
            kind, "news.json")
        contents = ('{"events": [], "shortfall": null}'
                    if kind == "calendar" else "{}")

        def fake_run_claude(cfg, text, workdir, extra_env, *_):
            with open(os.path.join(workdir, deliverable), "w",
                      encoding="utf-8") as f:
                f.write(contents)
            return 0

        real = loop.run_claude
        loop.run_claude = fake_run_claude
        self.addCleanup(setattr, loop, "run_claude", real)

        cid = ("%s" % kind).ljust(32, "0")[:32]
        desk = CalendarDesk(positions=self.POSITIONS, calendar=None, econ=[])
        loop.handle(self.cfg, desk, {"id": cid, "kind": kind, "text": "go"}, {})
        return os.path.join(self.tmp, cid)

    def test_seed_positions_runs_only_for_the_calendar_kind(self):
        # The newspaper's producer never has the file. This is the structural
        # half of the rule that positions do not reach news.json; the edition
        # validator is the other half, and neither is sufficient alone.
        for kind in ("file_edition", "research", "custom"):
            with self.subTest(kind=kind):
                workdir = self.run_seeding(kind)
                self.assertFalse(
                    os.path.exists(os.path.join(workdir, "positions.json")))
        workdir = self.run_seeding("calendar")
        self.assertTrue(os.path.exists(os.path.join(workdir, "positions.json")))

    def test_the_other_two_seeded_files_follow_the_same_split(self):
        # Yesterday's book and the economic window are not secrets the way the
        # positions are, but a newspaper run has no use for either, and a file
        # in front of a model is an invitation to read it.
        for kind in ("file_edition", "research", "custom"):
            for name in ("positions.json", "calendar.json", "econ.json"):
                with self.subTest(kind=kind, name=name):
                    workdir = self.run_seeding(kind)
                    self.assertFalse(os.path.exists(os.path.join(workdir, name)))

    def test_the_watch_list_is_seeded_for_every_kind_including_the_book(self):
        # The one file both jobs get: it is the universe the paper rotates
        # through and, for the book, where else to look for a date. It is
        # seeded from the operator's own directory rather than from the desk,
        # so it is not part of the split.
        path = os.path.join(self.tmp, "watchlist.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump({"symbols": ["AAAA"], "last": "AAAA"}, f)
        self.cfg = loop.Settings.from_env({"CLAUDEPOST_SCRATCH": self.tmp,
                                           "CLAUDEPOST_WATCHLIST": path})
        for kind in ("file_edition", "calendar"):
            with self.subTest(kind=kind):
                workdir = self.run_seeding(kind)
                self.assertTrue(
                    os.path.exists(os.path.join(workdir, "watchlist.json")))

    def test_a_calendar_run_is_given_the_four_files_its_brief_names(self):
        # tools/edition/CALENDAR.md's input table promises exactly these, and
        # the table is a promise this function is what keeps.
        path = os.path.join(self.tmp, "watchlist.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump({"symbols": ["AAAA"], "last": "AAAA"}, f)
        self.cfg = loop.Settings.from_env({"CLAUDEPOST_SCRATCH": self.tmp,
                                           "CLAUDEPOST_WATCHLIST": path})

        def fake_run_claude(cfg, text, workdir, extra_env, *_):
            self.seen = sorted(os.listdir(workdir))
            with open(os.path.join(workdir, "calendar.json"), "w") as f:
                f.write('{"events": []}')
            return 0

        real = loop.run_claude
        loop.run_claude = fake_run_claude
        self.addCleanup(setattr, loop, "run_claude", real)
        desk = CalendarDesk(positions=self.POSITIONS,
                            calendar={"events": [], "shortfall": None},
                            econ=[{"date": "2026-09-10"}])
        loop.handle(self.cfg, desk, {"id": "c" * 32, "kind": "calendar",
                                     "text": "the book"}, {})
        self.assertEqual(self.seen, ["calendar.json", "econ.json",
                                     "positions.json", "watchlist.json"])
        # ...and no tiles/. Nothing on this path would ever upload a picture,
        # so an empty directory named for them is an invitation to make some.
        self.assertNotIn("tiles", self.seen)


class CalendarSeedTest(unittest.TestCase):
    """The three documents a calendar run is handed, one at a time.

    ``seed_watchlist``'s posture throughout: a document the desk does not hold
    is the documented first morning rather than an error, and something too
    large to put in front of a model is a warning and a file not written.
    What is *not* shared with the watch list is the failure case -- see
    :meth:`test_a_desk_that_will_not_say_fails_the_command`.
    """

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)

    def read(self, name):
        with open(os.path.join(self.tmp, name), encoding="utf-8") as f:
            return json.load(f)

    def test_the_positions_land_under_the_name_the_brief_uses(self):
        book = {"updated_at": "2026-09-08T05:00:00Z", "positions": []}
        self.assertTrue(loop.seed_positions(CalendarDesk(positions=book), self.tmp))
        self.assertEqual(self.read("positions.json"), book)

    def test_yesterdays_book_is_seeded_so_it_can_be_revised(self):
        # Not a nicety: CALENDAR.md requires an event that was already in the
        # book to keep its id, because the desk records a notification against
        # that id. A run seeded from nothing can only re-mint, and every
        # re-minted id is a second push about a date the owner has already
        # been told about.
        book = {"events": [{"id": "e_a1c4"}], "shortfall": None}
        self.assertTrue(loop.seed_calendar(CalendarDesk(calendar=book), self.tmp))
        self.assertEqual(self.read("calendar.json"), book)

    def test_a_document_the_desk_does_not_hold_is_a_first_run(self):
        desk = CalendarDesk(positions=None, calendar=None)
        self.assertFalse(loop.seed_positions(desk, self.tmp))
        self.assertFalse(loop.seed_calendar(desk, self.tmp))
        self.assertEqual(os.listdir(self.tmp), [])

    def test_a_desk_that_will_not_say_fails_the_command(self):
        # Where this parts company with the watch list. A missing watch list
        # costs a rotation; a book filed while the positions could not be read
        # is a book that reaches nothing, written over a good one. So the
        # client raises and handle() lets it out to main(), which fails the
        # command with the message on it.
        class Down(CalendarDesk):
            def positions(self):
                raise RuntimeError("positions: 502 <html>")

        with self.assertRaises(RuntimeError):
            loop.seed_positions(Down(), self.tmp)

    def test_the_economic_window_is_asked_for_from_today_forward(self):
        desk = CalendarDesk(econ=[{"date": "2026-09-10"}])
        self.assertTrue(loop.seed_econ(desk, self.tmp,
                                       today=datetime.date(2026, 9, 8)))
        self.assertEqual(desk.econ_windows, [("2026-09-08", "2026-11-07")])
        # The window travels with its own bounds, so an empty list is "this
        # fortnight is quiet" rather than a file that says nothing.
        self.assertEqual(self.read("econ.json"),
                         {"from": "2026-09-08", "to": "2026-11-07",
                          "events": [{"date": "2026-09-10"}]})

    def test_a_window_the_desk_could_not_fetch_is_not_a_failure(self):
        # The desk is going outside for this one. A scraper behind a challenge
        # costs the book one tier-1 source; it does not cost a morning.
        self.assertFalse(loop.seed_econ(CalendarDesk(econ=None), self.tmp))
        self.assertEqual(os.listdir(self.tmp), [])

    def test_a_document_too_large_to_hand_a_model_is_not_seeded(self):
        # `seed_watchlist`'s oversize branch, and here for the same reason:
        # the check is at the point where bytes become a file in a directory a
        # language model is about to read. The desk cannot answer past its own
        # cap; something in front of one can.
        huge = {"positions": [{"note": "x" * loop.MAX_POSITIONS_BYTES}]}
        self.assertFalse(loop.seed_positions(CalendarDesk(positions=huge), self.tmp))
        self.assertEqual(os.listdir(self.tmp), [])

    def test_korean_is_written_as_korean_and_not_as_escapes(self):
        # `fsutil.json_bytes`'s spelling, for its reason: every one of these
        # files is read, and \\uc0bc\\uc131 is not a company name anybody can
        # read -- a model included.
        book = {"events": [{"title": "삼성전자 실적"}]}
        loop.seed_calendar(CalendarDesk(calendar=book), self.tmp)
        with open(os.path.join(self.tmp, "calendar.json"), encoding="utf-8") as f:
            self.assertIn("삼성전자", f.read())


class UploadCalendarTest(unittest.TestCase):
    """What is filed, and the one thing that is refused instead of filed."""

    BOOK = ('{"generated_at": "2026-09-08T05:00:00Z", "lang": "ko", '
            '"target": 10, "events": [], "shortfall": null}')

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)

    def write(self, name, text):
        with open(os.path.join(self.tmp, name), "w", encoding="utf-8") as f:
            f.write(text)

    def test_the_book_goes_up_as_the_bytes_the_run_wrote(self):
        self.write("calendar.json", self.BOOK)
        desk = CalendarDesk()
        doc = loop.upload_calendar(desk, self.tmp)
        self.assertEqual(desk.books, [self.BOOK.encode("utf-8")])
        self.assertEqual(doc["target"], 10)

    def test_a_calendar_run_that_wrote_a_page_files_nothing_at_all(self):
        # The refusal, and the reason it is a refusal rather than a warning:
        # this is the one turn in the system holding the owner's positions,
        # and news.json is the one file served with no authorization on it.
        self.write("calendar.json", self.BOOK)
        self.write("news.json", '{"headline": "…"}')
        desk = CalendarDesk()
        with self.assertRaises(RuntimeError) as caught:
            loop.upload_calendar(desk, self.tmp)
        self.assertIn("news.json", str(caught.exception))
        # Not even the book went up -- the check is first, before the book is
        # so much as read.
        self.assertEqual(desk.books, [])
        # And the page is left where it lies: nothing on this path opens a
        # draft, so it reaches nobody, and it is the evidence somebody needs.
        self.assertTrue(os.path.exists(os.path.join(self.tmp, "news.json")))

    def test_a_page_with_no_book_beside_it_is_still_refused_by_name(self):
        # The order matters: a run that wrote only news.json must fail saying
        # what it did, not "no calendar.json was produced".
        self.write("news.json", "{}")
        with self.assertRaises(RuntimeError) as caught:
            loop.upload_calendar(CalendarDesk(), self.tmp)
        self.assertIn("news.json", str(caught.exception))

    def test_a_run_that_produced_no_book_fails(self):
        with self.assertRaises(RuntimeError) as caught:
            loop.upload_calendar(CalendarDesk(), self.tmp)
        self.assertIn("no calendar.json", str(caught.exception))

    def test_something_that_is_not_a_book_fails_here_rather_than_at_the_desk(self):
        # The early half of "fail loudly rather than upload something the desk
        # will refuse". The desk owns the only validator and names the field;
        # what is caught here is what would otherwise be an unexplained 400.
        for junk in ("not json at all", "[]", '{"events": "ten"}', '{}'):
            with self.subTest(junk=junk):
                self.write("calendar.json", junk)
                desk = CalendarDesk()
                with self.assertRaises(RuntimeError):
                    loop.upload_calendar(desk, self.tmp)
                self.assertEqual(desk.books, [])


class HandleCalendarTest(unittest.TestCase):
    """``handle()``'s fourth case, and the only one where ``kind`` decides alone.

    A calendar command reads the other contract, is seeded with the owner's
    documents, files ``calendar.json`` and never opens a draft. ``custom``
    trusts the disk over the kind; this one consults the disk and answers a
    ``news.json`` with a refusal.
    """

    class NoDraftDesk(CalendarDesk):
        """No ``open_draft``, ``proof`` or ``commit``: a call to any of them
        is the bug this test exists to catch, and an ``AttributeError`` from a
        stub without the method says so more loudly than a counted call.

        Taken away rather than left off, because this one inherits them: the
        shared stub above answers every kind of command, and what is being
        pinned here is that the calendar path never asks."""

        def __getattribute__(self, name):
            if name in ("open_draft", "proof", "commit"):
                raise AttributeError(name)
            return object.__getattribute__(self, name)

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.cfg = loop.Settings.from_env({"CLAUDEPOST_SCRATCH": self.tmp})
        self.contracts = []

        def read_contract(repo, kind="file_edition"):
            self.contracts.append(kind)
            return "the brief"

        real = loop.read_contract
        loop.read_contract = read_contract
        self.addCleanup(setattr, loop, "read_contract", real)

    def patch_run_claude(self, fn):
        real = loop.run_claude
        loop.run_claude = fn
        self.addCleanup(setattr, loop, "run_claude", real)

    def test_a_calendar_command_files_a_book_and_never_opens_a_draft(self):
        note = "Looked at both symbols; six cleared the floor.\n"
        book = ('{"events": [{"id": "e_a1c4"}, {"id": "e_b207"}], '
                '"shortfall": "여섯 개였어요"}')

        def fake_run_claude(cfg, text, workdir, extra_env, *_):
            with open(os.path.join(workdir, "calendar.json"), "w",
                      encoding="utf-8") as f:
                f.write(book)
            with open(os.path.join(workdir, "notes.md"), "w",
                      encoding="utf-8") as f:
                f.write(note)
            return 0

        self.patch_run_claude(fake_run_claude)
        desk = self.NoDraftDesk()
        cid = "c" * 32
        loop.handle(self.cfg, desk, {"id": cid, "kind": "calendar",
                                     "text": "the book"}, {})

        self.assertEqual(desk.books, [book.encode("utf-8")])
        # The contract read was the book's, not the newspaper's.
        self.assertEqual(self.contracts, ["calendar"])
        # The note goes on the command, because there is no draft to hang it
        # on -- the same place a research turn's does.
        self.assertEqual(desk.notes_calls,
                         [{"text": note, "draft": None, "command": cid}])
        # The result is the answer to the instruction, so it carries the
        # count *and* the sentence. The shortfall is the agent's own prose
        # about its own run -- the desk serves it whole at `GET /api/calendar`
        # and again in `/api/state`, and this same turn has already written it
        # in full to the note two lines above. Withholding it here bought
        # nothing and cost the operator the one sentence saying what the book
        # is missing.
        (finished_cid, ok, result), = desk.finished
        self.assertEqual((finished_cid, ok), (cid, True))
        self.assertIn("2 event(s)", result)
        self.assertIn("여섯 개였어요", result)

    def test_a_calendar_run_files_no_edition(self):
        # A calendar command that produced a news.json is a bug, and the loop
        # refuses it rather than uploading it. The command fails with the
        # reason on it, which is what an operator reads.
        def fake_run_claude(cfg, text, workdir, extra_env, *_):
            with open(os.path.join(workdir, "calendar.json"), "w") as f:
                f.write('{"events": []}')
            with open(os.path.join(workdir, "news.json"), "w") as f:
                f.write('{"lead": {"headline": "…"}}')
            return 0

        self.patch_run_claude(fake_run_claude)
        desk = self.NoDraftDesk()
        cid = "d" * 32
        # handle() lets it out; main()'s own except turns it into a failed
        # command, which is the arrangement every other bug in a turn takes.
        with self.assertRaises(RuntimeError) as caught:
            loop.handle(self.cfg, desk, {"id": cid, "kind": "calendar",
                                         "text": "the book"}, {})
        self.assertIn("news.json", str(caught.exception))
        self.assertEqual(desk.books, [])
        self.assertEqual(desk.finished, [])

    def test_a_turn_that_exited_nonzero_never_reaches_the_desk(self):
        self.patch_run_claude(lambda cfg, text, workdir, extra_env, *_: 1)
        desk = self.NoDraftDesk()
        loop.handle(self.cfg, desk, {"id": "e" * 32, "kind": "calendar",
                                     "text": "the book"}, {})
        self.assertEqual(desk.books, [])
        self.assertEqual(desk.finished, [("e" * 32, False, "claude exited 1")])

    def test_the_brief_records_the_count_and_the_shortfall(self):
        # The only durable record of what a calendar run produced: there is no
        # edition_id on this path, and a book quietly shrinking from ten to
        # four over a fortnight is visible nowhere else.
        context = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, context, True)
        cfg = loop.Settings.from_env({"CLAUDEPOST_SCRATCH": self.tmp,
                                      "AGENT_CONTEXT_DIR": context,
                                      "AGENT_WRITE_BRIEFS": "1"})

        def fake_run_claude(c, text, workdir, extra_env, *_):
            with open(os.path.join(workdir, "calendar.json"), "w",
                      encoding="utf-8") as f:
                f.write('{"events": [{"id": "e_a1c4"}], '
                        '"shortfall": "여섯 개였어요"}')
            return 0

        self.patch_run_claude(fake_run_claude)
        desk = self.NoDraftDesk()
        loop.handle(cfg, desk, {"id": "f" * 32, "kind": "calendar",
                                "text": "the book"}, {})
        day = time.strftime("%Y-%m-%d")
        with open(os.path.join(context, "briefs", day + ".md"),
                  encoding="utf-8") as f:
            text = f.read()
        self.assertIn("calendar", text)
        self.assertIn("**Book:** 1 event(s)", text)
        self.assertIn("여섯 개였어요", text)
        # And the same sentence, unaltered, in the other thing this run
        # records. Both are asserted here on purpose: the two used to disagree
        # about whether the shortfall could be written down at all, and a rule
        # enforced in one place and assumed in the next is the one that gets
        # got wrong later.
        (_, _, result), = desk.finished
        self.assertIn("여섯 개였어요", result)


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

    def test_the_system_note_does_not_name_the_deliverable(self):
        # The note rides every run, and the runs do not share a deliverable: a
        # filing ends in news.json, but PROMPT.md's research contract is
        # "notes.md and nothing else -- no news.json". One sentence naming
        # news.json here would contradict, on every research command, the very
        # instruction it is appended to.
        self.assertNotIn("news.json", loop.SYSTEM_NOTE)

    def test_the_operators_plugin_layer_is_kept_out_of_the_child_too(self):
        # The other half of "keep the operator's setup out": --strict-mcp-config
        # keeps the servers out, DISABLE_OMC keeps the orchestration layer out.
        # It lives here, in the child's environment, rather than in run-host.sh
        # -- a wrapper-only switch would mean `python3 loop.py` on a host gets
        # one half of the policy and not the other.
        cfg = loop.Settings.from_env({})
        env = loop.child_env(cfg, "/work", {})
        self.assertEqual(env.get("DISABLE_OMC"), "1")
        self.assertEqual(env.get("EDITION_DIR"), "/work")

    def test_the_operator_can_keep_their_plugin_layer(self):
        cfg = loop.Settings.from_env({"CLAUDEPOST_KEEP_PLUGINS": "1"})
        self.assertNotIn("DISABLE_OMC", loop.child_env(cfg, "/work", {}))

    def test_a_metered_key_is_kept_out_when_a_login_is_present(self):
        # run-host.sh unsets ANTHROPIC_API_KEY from its own environment, but
        # agent.env flows through load_agent_env -> extra_env -> the child, and
        # that file is the very one the docs tell a container operator to keep.
        # The stated policy -- the subscription pays unless somebody says
        # otherwise in so many words -- has to hold at the last door, which is
        # the child's environment.
        home = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, home, True)
        os.makedirs(os.path.join(home, ".claude"))
        open(os.path.join(home, ".claude", ".credentials.json"), "w").close()
        cfg = loop.Settings.from_env({})
        env = loop.child_env(cfg, "/work", {"ANTHROPIC_API_KEY": "k"}, home=home)
        self.assertNotIn("ANTHROPIC_API_KEY", env)

    def test_the_key_stays_when_it_is_the_only_route(self):
        # A container has no login session; the key is how it works at all.
        home = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, home, True)
        cfg = loop.Settings.from_env({})
        env = loop.child_env(cfg, "/work", {"ANTHROPIC_API_KEY": "k"}, home=home)
        self.assertEqual(env.get("ANTHROPIC_API_KEY"), "k")

    def test_the_operator_can_insist_on_the_key(self):
        home = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, home, True)
        os.makedirs(os.path.join(home, ".claude"))
        open(os.path.join(home, ".claude", ".credentials.json"), "w").close()
        cfg = loop.Settings.from_env({"CLAUDEPOST_USE_API_KEY": "1"})
        env = loop.child_env(cfg, "/work", {"ANTHROPIC_API_KEY": "k"}, home=home)
        self.assertEqual(env.get("ANTHROPIC_API_KEY"), "k")

    def test_the_desk_token_never_reaches_the_child_from_the_environment(self):
        # `load_agent_env` pops CLAUDEPOST_TOKEN out of `agent.env`, which is
        # the documented place to keep it. It is not the only place it can be:
        # `child_env` starts from `os.environ`, and `run-host.sh` exports every
        # KEY=value in `$REPO/agent/.env`, so an operator who kept the token
        # there -- or who exported it in the shell they started the loop from
        # -- has it in the process environment and it would go straight back
        # into the child. The child is a model with a shell and the token is
        # `GET /api/positions`: the owner's strikes, sizes and entry prices.
        cfg = loop.Settings.from_env({})
        with mock.patch.dict(os.environ, {"CLAUDEPOST_TOKEN": "producer-tok"}):
            env = loop.child_env(cfg, "/work", {})
        self.assertNotIn("CLAUDEPOST_TOKEN", env)
        self.assertNotIn("producer-tok", "".join(env.values()))

    def test_the_desk_token_never_reaches_the_child_from_agent_env_either(self):
        """Belt and braces on purpose: `load_agent_env` already strips this
        one, and this door is the last one either way."""
        cfg = loop.Settings.from_env({})
        env = loop.child_env(cfg, "/work", {"CLAUDEPOST_TOKEN": "producer-tok"})
        self.assertNotIn("CLAUDEPOST_TOKEN", env)

    def test_the_repository_is_substituted_into_the_allowlist(self):
        cfg = loop.Settings.from_env({
            "CLAUDEPOST_REPO": "/srv/claudepost",
            "AGENT_TOOLS": "Read,Bash(python3 {repo}/tools/make_tile.py:*)"})
        self.assertIn("Bash(python3 /srv/claudepost/tools/make_tile.py:*)",
                      loop.claude_argv(cfg, "/work")[-1])


class RunAsTest(unittest.TestCase):
    """Handing one turn to a second user, which is the whole of the wall.

    The mechanism is not a preference and the tests say so: gosu is not setuid,
    compose sets no-new-privileges, and a process that is not root cannot change
    uid. So the loop is root in the container and every `claude` is `model` --
    and on a host, where AGENT_RUN_AS is unset, nothing switches at all and the
    command line is byte-identical to the one this worker has always run.
    """

    def test_a_host_run_switches_nobody(self):
        cfg = loop.Settings.from_env({})
        self.assertEqual(cfg.run_as, "")
        self.assertEqual(loop.claude_argv(cfg, "/work")[0], "claude")

    def test_the_model_user_is_prefixed_before_the_cli(self):
        cfg = loop.Settings.from_env({"AGENT_RUN_AS": "model"})
        argv = loop.claude_argv(cfg, "/work")
        self.assertEqual(argv[:3], ["gosu", "model", "claude"])
        # And the allow-list is still last with nothing after its value: gosu
        # must not push the prompt back onto the command line.
        self.assertEqual(argv[-2], "--allowedTools")

    def test_the_child_gets_that_users_home_and_not_the_loops(self):
        # `claude` writes its own configuration into $HOME. Left at the loop's,
        # every turn fails on its first write into a directory it does not own,
        # and the message is about a config file rather than about a uid.
        cfg = loop.Settings.from_env({"AGENT_RUN_AS": "model"})
        env = loop.child_env(cfg, "/work", {})
        self.assertEqual(env["HOME"], loop.run_as_home("model"))
        self.assertEqual(env["USER"], "model")
        self.assertEqual(env["LOGNAME"], "model")

    def test_an_unset_run_as_leaves_home_alone(self):
        cfg = loop.Settings.from_env({})
        with mock.patch.dict(os.environ, {"HOME": "/home/somebody"}):
            env = loop.child_env(cfg, "/work", {})
        self.assertEqual(env["HOME"], "/home/somebody")

    def test_a_user_this_image_does_not_have_still_yields_a_home(self):
        # Pure, so a test can assert it on a machine with no `model` user.
        self.assertEqual(loop.run_as_home("nobody-here-at-all"),
                         "/home/nobody-here-at-all")


class OwnWorkdirTest(unittest.TestCase):
    """The workdir is the only writable path the model has, so it has to own it.

    Handed over AFTER the seeding and before the turn: the seeded files are
    written by the loop, and `watchlist.json` is one the contract asks the model
    to rewrite in place.
    """

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        os.makedirs(os.path.join(self.tmp, "tiles"))
        with open(os.path.join(self.tmp, "watchlist.json"), "w") as f:
            f.write("{}")

    def test_nothing_is_chowned_when_nobody_is_being_switched_to(self):
        cfg = loop.Settings.from_env({})
        with mock.patch("os.chown") as chown:
            loop.own_workdir(cfg, self.tmp)
        chown.assert_not_called()

    def test_every_path_in_the_workdir_is_handed_over(self):
        cfg = loop.Settings.from_env({"AGENT_RUN_AS": "model"})
        with mock.patch("os.chown") as chown, \
             mock.patch("loop.pwd.getpwnam") as getpwnam:
            getpwnam.return_value = mock.Mock(pw_uid=10001, pw_gid=10001)
            loop.own_workdir(cfg, self.tmp)
        handed = sorted(call.args[0] for call in chown.call_args_list)
        self.assertEqual(handed, sorted([
            self.tmp,
            os.path.join(self.tmp, "tiles"),
            os.path.join(self.tmp, "watchlist.json")]))
        for call in chown.call_args_list:
            self.assertEqual(call.args[1:], (10001, 10001))

    def test_a_user_the_image_does_not_have_fails_the_command_by_name(self):
        cfg = loop.Settings.from_env({"AGENT_RUN_AS": "ghost"})
        with self.assertRaises(RuntimeError) as caught:
            loop.own_workdir(cfg, self.tmp)
        self.assertIn("ghost", str(caught.exception))


class MainRefusesTest(unittest.TestCase):
    """The two ways this setting and this uid can disagree, both fatal.

    Both guards sit right after `logging.basicConfig` and both `return 2`
    before `main` builds a `DeskClient` or reaches the network -- so calling
    `loop.main()` directly, with the environment and the euid patched, is
    still layer 0: nothing here opens a socket.
    """

    def test_a_non_root_loop_may_not_switch_user(self):
        with mock.patch.dict(os.environ, {"AGENT_RUN_AS": "model"}, clear=True), \
             mock.patch("os.geteuid", return_value=10001), \
             self.assertLogs("worker", level="ERROR") as caught:
            self.assertEqual(loop.main(), 2)
        self.assertIn("AGENT_RUN_AS", caught.output[0])

    def test_a_root_loop_may_not_skip_switching_user(self):
        with mock.patch.dict(os.environ, {}, clear=True), \
             mock.patch("os.geteuid", return_value=0), \
             self.assertLogs("worker", level="ERROR") as caught:
            self.assertEqual(loop.main(), 2)
        self.assertIn("AGENT_RUN_AS", caught.output[0])


class RunClaudeCredentialProbeTest(unittest.TestCase):
    """`run_claude` must hand `child_env` the CHILD's home, not the loop's.

    Dormant today -- nothing mounts a CLI login under the model user's home --
    but the day one exists, checking the wrong home leaves the metered key in
    the child's environment and the subscription silently stops paying.
    """

    def test_the_credential_probe_looks_at_the_child_s_home_when_switching_user(self):
        cfg = loop.Settings.from_env({"AGENT_RUN_AS": "model",
                                       "CLAUDEPOST_REPO": "/repo"})
        child_home = loop.run_as_home("model")
        credentials = os.path.join(child_home, ".claude", ".credentials.json")
        captured = {}

        def fake_run(argv, **kwargs):
            captured["env"] = kwargs["env"]
            return subprocess.CompletedProcess(argv, 0, stdout=b"")

        with mock.patch.dict(os.environ, {"ANTHROPIC_API_KEY": "sk-test"}), \
             mock.patch("os.path.exists", side_effect=lambda p: p == credentials), \
             mock.patch("subprocess.run", side_effect=fake_run):
            loop.run_claude(cfg, "prompt text", "/work", {})

        # A login under the child's home was found, so the metered key comes
        # out -- which only happens if the probe looked there rather than at
        # the loop's own home, where this fake filesystem has nothing at all.
        self.assertNotIn("ANTHROPIC_API_KEY", captured["env"])

    def test_a_host_run_still_probes_its_own_home(self):
        # run_as is "" on a host, so the fallback to os.path.expanduser("~")
        # in child_env must still be reached -- this pins that the fix does
        # not change behaviour when nobody is being switched to.
        cfg = loop.Settings.from_env({"CLAUDEPOST_REPO": "/repo"})
        captured = {}

        def fake_run(argv, **kwargs):
            captured["env"] = kwargs["env"]
            return subprocess.CompletedProcess(argv, 0, stdout=b"")

        with mock.patch.dict(os.environ, {"ANTHROPIC_API_KEY": "sk-test",
                                          "HOME": "/home/operator"}), \
             mock.patch("os.path.exists", return_value=False) as exists, \
             mock.patch("subprocess.run", side_effect=fake_run):
            loop.run_claude(cfg, "prompt text", "/work", {})

        exists.assert_called_once_with(
            os.path.join("/home/operator", ".claude", ".credentials.json"))
        self.assertIn("ANTHROPIC_API_KEY", captured["env"])


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

    def write_work(self, doc) -> None:
        with open(os.path.join(self.work, "watchlist.json"), "w",
                  encoding="utf-8") as f:
            json.dump(doc, f)

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
        self.write_work({"symbols": ["NVDA", "AAPL"], "last": "AAPL"})

        self.assertTrue(loop.persist_watchlist(self.settings(), self.work))
        self.assertEqual(self.back()["last"], "AAPL")

    def test_a_symbol_the_model_added_comes_back_too(self):
        # The rotation is not only the reader's to edit. A worker that found a
        # company worth following writes it into the file it was handed, and
        # tomorrow's run starts from the wider universe.
        self.write({"symbols": ["NVDA"], "last": "NVDA"})
        loop.seed_watchlist(self.settings(), self.work)
        self.write_work({"symbols": ["NVDA", "ETN"], "last": "ETN"})

        loop.persist_watchlist(self.settings(), self.work)
        self.assertEqual(self.back()["symbols"], ["NVDA", "ETN"])

    def test_the_kept_list_replaces_the_file_rather_than_rewriting_it(self):
        # The operator's copy is the only state the rotation has, and a write
        # that dies halfway -- full disk, power -- must not leave it half a
        # document. Whole-file-then-rename means the path points at a complete
        # list at every instant: the old inode until the swap, the new one
        # after. An in-place rewrite keeps the inode, and has a window where
        # the file is truncated junk.
        self.write({"symbols": ["NVDA", "AAPL"], "last": "NVDA"})
        before = os.stat(self.path).st_ino
        # No seed: persist reads only the work copy, written here as the model
        # would have left it.
        self.write_work({"symbols": ["NVDA", "AAPL"], "last": "AAPL"})

        self.assertTrue(loop.persist_watchlist(self.settings(), self.work))
        self.assertNotEqual(os.stat(self.path).st_ino, before)
        # ...and nothing half-finished left beside it.
        leftovers = [n for n in os.listdir(self.tmp)
                     if n.startswith("watchlist") and n != "watchlist.json"]
        self.assertEqual(leftovers, [])

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

    @unittest.skipIf(hasattr(os, "geteuid") and os.geteuid() == 0,
                     "root ignores directory modes; the refusal cannot be staged")
    def test_a_read_only_secrets_mount_is_a_warning_not_a_failure(self):
        # The container mounts ~/.claudepost read-only, which is right: it holds
        # the token. Losing a rotation cursor is not a reason to fail a filing
        # that has already reached the glass.
        self.write({"symbols": ["NVDA"], "last": "NVDA"})
        self.write_work({"symbols": ["NVDA"], "last": "AAPL"})
        # The directory rather than the file: the container mounts the whole
        # secrets directory read-only, and a rename-based write never opens the
        # target file at all -- the temp file beside it is what cannot be
        # created. (The earlier in-place writer was tested with a chmodded
        # file; that write path no longer exists.)
        os.chmod(self.tmp, 0o555)
        self.addCleanup(os.chmod, self.tmp, 0o755)
        self.assertFalse(loop.persist_watchlist(self.settings(), self.work))
        self.assertEqual(self.back()["last"], "NVDA")


class StandaloneParityTest(unittest.TestCase):
    """agent/standalone/file-edition.sh promises to keep loop.py's deny-list
    and system note "in step by hand". By test, actually: both run on the same
    operator machine whose measured failures earned the flags, and a divergence
    would be silent until a morning with no paper.
    """

    def test_the_standalone_script_carries_the_same_note_and_deny_list(self):
        path = os.path.join(os.path.dirname(__file__), "..", "standalone",
                            "file-edition.sh")
        with open(path, encoding="utf-8") as f:
            text = f.read()
        self.assertIn('--disallowedTools "%s"' % loop.DENY_TOOLS, text)
        self.assertIn(loop.SYSTEM_NOTE, text)


if __name__ == "__main__":
    unittest.main()
