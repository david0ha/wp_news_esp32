#!/usr/bin/env python3
"""The worker: claim an instruction, file an edition, look at the paper, commit.

This is the example half of the system. It holds the operator's credentials and
runs headless Claude Code; the desk holds neither and is the only one of the two
exposed through a tunnel. They are separate containers for the reason
``agent/standalone/README.md`` gives for splitting the filing job from the
serving job: filing is an event that can fail, serving is a condition that must
hold. A failed filing must not take the served page down with it, because that
turns a stale paper -- which the firmware is designed to survive and badge --
into no paper at all.

The loop is deliberately dumb. Every decision that could put a wrong page on a
wall belongs to the desk: the desk validates, the desk typesets, the desk
decides when a page may be published. What the worker owns is research and
prose, which is the half a language model is actually for.

The one step worth naming is step 5. The desk owns the only typesetter, so the
worker cannot see its own paper by rendering it -- it asks the desk to proof the
draft and then *fetches the sheets back and looks at them*. That is what makes
"the desk cannot see the paper" false for the first time in this project: a
column that ran short, a headline that broke on the wrong word, a photograph
that halftoned to mush are all things no schema check can find and a reader
notices from across a room.

Three flat modules rather than a package, because this runs as
``python3 loop.py``: :mod:`prompt` is pure and holds what the model is told,
:mod:`deskclient` holds the HTTP, and what is left here is the environment, the
loop, and the files on disk between them.

Standard library only, and it must run on the python3 that ships in
node:22-slim (3.11), so nothing newer than that is used here.
"""

from __future__ import annotations

import logging
import os
import shutil
import subprocess
import sys
import time
from dataclasses import dataclass
from typing import Mapping

import prompt
from deskclient import DeskClient, load_agent_env, read_token

LOG = logging.getLogger("worker")

#: A model that has been told twice what is wrong and has not fixed it is not
#: going to fix it on the third try; it is going to spend another research
#: budget arriving somewhere adjacent. Two is enough to absorb a miscount and
#: not enough to burn an afternoon.
MAX_REVISIONS = 2

#: `claude --print` researching a company, fetching quotes and writing two pages
#: is minutes, not seconds. Past this something has gone wrong that waiting will
#: not fix.
CLAUDE_TIMEOUT = 45 * 60

#: The default allowlist, and narrow for the reason
#: ``agent/standalone/file-edition.sh`` is narrow: the run needs reads and
#: writes, search, and exactly two scripts. It does NOT get ``render-check.sh``
#: -- in this arrangement the desk owns the typesetter and hands the sheets
#: back, so a worker that could typeset locally would be a second copy of the
#: gate that decides.
#:
#: There is no market-data MCP here on purpose. Which one to trust is the
#: reader's decision and their credential; ``AGENT_TOOLS`` is where it goes.
DEFAULT_TOOLS = (
    "Read,Write,Edit,Glob,Grep,WebSearch,WebFetch,"
    "Bash(python3 {repo}/tools/make_tile.py:*),"
    "Bash(python3 {repo}/tools/mock_news_server.py:*)"
)

#: What ``AGENT_WRITE_BRIEFS`` accepts as yes. Anything else -- including the
#: default -- is no.
_TRUTHY = ("1", "true", "yes", "on")


@dataclass(frozen=True)
class Settings:
    """Where everything is. The only place this worker reads the environment."""

    desk: str
    secrets: str
    repo: str
    scratch: str
    context_dir: str | None
    write_briefs: bool
    tools: str
    log_level: str

    @staticmethod
    def from_env(env: Mapping[str, str]) -> "Settings":
        """Build settings from the container's environment, with the image's defaults.

        The defaults are the paths the image lays down, so a worker started with
        no environment at all reaches the desk over the ``wpnews`` network and
        files without an operator having set a single variable. Two things are
        deliberately off by default: there is no context directory, and briefs
        are not written -- see :func:`write_brief`.
        """
        return Settings(
            desk=env.get("WPNEWS_DESK", "http://desk:8080"),
            secrets=env.get("WPNEWS_SECRETS", "/run/secrets"),
            repo=env.get("WPNEWS_REPO", "/repo"),
            scratch=env.get("WPNEWS_SCRATCH", "/scratch"),
            context_dir=env.get("AGENT_CONTEXT_DIR") or None,
            write_briefs=env.get("AGENT_WRITE_BRIEFS", "0").strip().lower() in _TRUTHY,
            # `or` rather than a default argument: compose passes an unset
            # variable through as an empty string, and an empty allowlist is
            # never what anybody meant -- it is a worker that can do nothing.
            tools=env.get("AGENT_TOOLS") or DEFAULT_TOOLS,
            log_level=env.get("WPNEWS_LOG_LEVEL", "INFO"),
        )


def read_contract(repo: str) -> str:
    """``tools/edition/PROMPT.md``: the contract that ships with the repository."""
    with open(os.path.join(repo, "tools", "edition", "PROMPT.md"), encoding="utf-8") as f:
        return f.read()


def run_claude(cfg: Settings, text: str, workdir: str, extra_env: dict) -> int:
    """One headless turn. Returns the exit status; the transcript goes to the log."""
    env = dict(os.environ)
    env.update(extra_env)
    env["EDITION_DIR"] = workdir

    argv = [
        "claude", "--print",
        "--add-dir", workdir,
        "--allowedTools", cfg.tools.format(repo=cfg.repo),
        text + "\n\nThe repository is at %s. The edition directory is %s." % (
            cfg.repo, workdir),
    ]
    LOG.info("claude: %d characters of prompt, workdir %s", len(text), workdir)
    try:
        proc = subprocess.run(argv, cwd=workdir, env=env, timeout=CLAUDE_TIMEOUT,
                              stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    except subprocess.TimeoutExpired:
        LOG.error("claude timed out after %d s", CLAUDE_TIMEOUT)
        return 124
    except FileNotFoundError:
        LOG.error("the 'claude' CLI is not on PATH inside this container")
        return 127
    sys.stdout.write(proc.stdout.decode("utf-8", "replace"))
    return proc.returncode


def upload(desk: DeskClient, workdir: str) -> str:
    """Open a draft and PUT the payload and every tile beside it."""
    payload_path = os.path.join(workdir, "news.json")
    if not os.path.exists(payload_path):
        raise RuntimeError("no news.json was produced")

    with open(payload_path, "rb") as f:
        payload = f.read()

    draft = desk.open_draft()
    desk.put_payload(draft, payload)

    tiles_dir = os.path.join(workdir, "tiles")
    count = 0
    if os.path.isdir(tiles_dir):
        for name in sorted(os.listdir(tiles_dir)):
            if not name.endswith(".bin"):
                continue
            with open(os.path.join(tiles_dir, name), "rb") as f:
                desk.put_tile(draft, name[:-4], f.read())
            count += 1
    LOG.info("draft %s: %d bytes and %d tile(s)", draft, len(payload), count)
    return draft


def fetch_sheets(desk: DeskClient, draft: str, names, into: str):
    """Bring the proof sheets back so the next turn can look at them."""
    os.makedirs(into, exist_ok=True)
    paths = []
    for name in names:
        try:
            data = desk.fetch_sheet(draft, name)
        except RuntimeError as e:
            LOG.warning("could not fetch %s: %s", name, e)
            continue
        path = os.path.join(into, name)
        with open(path, "wb") as f:
            f.write(data)
        paths.append(path)
    return paths


def write_brief(cfg: Settings, day: str, command: dict, result: dict, note: str) -> None:
    """Leave a note in the context directory saying what was filed and why.

    A context directory becomes the desk's memory this way: a later run reads the
    last few briefs, so "you covered this company on Tuesday" is a thing the
    worker knows rather than a thing it re-derives.

    **Off unless asked for twice**: a context directory must be configured *and*
    ``AGENT_WRITE_BRIEFS`` must be set. Pointing this worker at a folder of
    somebody's notes is a decision to have it read them; deciding on their
    behalf that it may also write into them is not the repository's to make. The
    briefs land in a ``briefs/`` subdirectory, which :func:`prompt.read_context_dir`
    does not descend into -- so a run never reads its own output back.
    """
    if not (cfg.context_dir and cfg.write_briefs):
        return
    briefs = os.path.join(cfg.context_dir, "briefs")
    try:
        os.makedirs(briefs, exist_ok=True)
        path = os.path.join(briefs, day + ".md")
        with open(path, "a", encoding="utf-8") as f:
            f.write("\n## %s — %s\n\n" % (time.strftime("%H:%M"), command.get("kind", "?")))
            f.write("**Instruction:** %s\n\n" % command.get("text", "")[:1000])
            f.write("**Result:** %s (%s)\n\n" % (result.get("state", "?"),
                                                 result.get("edition_id", "-")))
            if note:
                f.write(note.strip()[:4000] + "\n")
    except OSError as e:
        # The disk is not there, or the mount is read-only. That is not a reason
        # to fail a filing that already reached the glass.
        LOG.warning("could not write the brief: %s", e)


def handle(cfg: Settings, desk: DeskClient, command: dict, agent_env: dict) -> None:
    """One instruction, from claim to commit."""
    cid = command["id"]
    workdir = os.path.join(cfg.scratch, cid)
    shutil.rmtree(workdir, ignore_errors=True)
    os.makedirs(os.path.join(workdir, "tiles"), exist_ok=True)

    text = prompt.build_prompt(
        read_contract(cfg.repo),
        prompt.read_context_dir(cfg.context_dir),
        desk.directives(),
        command.get("text", ""))
    status = run_claude(cfg, text, workdir, agent_env)
    if status != 0:
        desk.finish(cid, False, "claude exited %d" % status)
        return

    draft = upload(desk, workdir)
    report = desk.proof(draft)
    sheets = fetch_sheets(desk, draft, report.get("sheets", []),
                          os.path.join(workdir, "proof"))

    revisions = 0
    while not report.get("ok") and revisions < MAX_REVISIONS:
        revisions += 1
        LOG.info("proof failed, revision %d of %d", revisions, MAX_REVISIONS)
        status = run_claude(cfg, prompt.revision_prompt(report, sheets),
                            workdir, agent_env)
        if status != 0:
            desk.finish(cid, False, "revision %d: claude exited %d" % (revisions, status))
            return
        draft = upload(desk, workdir)
        report = desk.proof(draft)
        sheets = fetch_sheets(desk, draft, report.get("sheets", []),
                              os.path.join(workdir, "proof"))

    if not report.get("ok"):
        desk.finish(cid, False, "the edition does not typeset after %d revisions:\n%s\n%s"
                    % (revisions, report.get("validate", ""), report.get("render", "")))
        return

    # The gates passed. Nobody has read the page yet, and that is the failure
    # this whole arrangement exists to catch.
    if sheets and revisions < MAX_REVISIONS:
        run_claude(cfg, prompt.look_prompt(sheets), workdir, agent_env)
        # A revision may have rewritten the files; re-upload and re-proof so the
        # thing committed is the thing that was judged.
        draft = upload(desk, workdir)
        report = desk.proof(draft)
        if not report.get("ok"):
            desk.finish(cid, False, "the revision after looking at the sheets does not "
                                    "typeset:\n%s" % report.get("render", ""))
            return

    result = desk.commit(draft)
    LOG.info("committed %s: %s", result.get("edition_id"), result.get("state"))
    write_brief(cfg, time.strftime("%Y-%m-%d"), command, result,
                report.get("validate", ""))
    desk.finish(cid, True, "%s %s" % (result.get("state"), result.get("edition_id")))


def is_command(doc: object) -> bool:
    """Whether what the desk answered a claim with is an instruction to run.

    A 200 is not enough. :meth:`deskclient.DeskClient._json` deliberately does
    not raise on a 200 whose body is not JSON -- it answers ``{"ok": False,
    "error": "not_json", ...}`` so that a proxy in front of the tunnel serving
    an HTML error page gets *reported* rather than swallowed -- and a 200
    carrying a JSON array comes through as a list. Neither has an id, and
    reading one off them raises where :func:`main` has nothing to catch it.

    Which is the whole point of asking: a worker that raises out of its loop
    exits, and ``restart: unless-stopped`` restarts it, so a desk answering
    rubbish would replace the backoff below with a container that comes up and
    dies once a minute for as long as nobody is watching.
    """
    return isinstance(doc, dict) and "id" in doc


def main() -> int:
    """Claim, handle, repeat -- forever, and through a desk that is not there yet."""
    cfg = Settings.from_env(os.environ)
    logging.basicConfig(
        level=cfg.log_level,
        format="%(asctime)s %(levelname)s %(name)s %(message)s")

    desk = DeskClient(cfg.desk, read_token(cfg.secrets))
    agent_env = load_agent_env(cfg.secrets)
    if not (agent_env.get("ANTHROPIC_API_KEY") or agent_env.get("CLAUDE_CODE_OAUTH_TOKEN")):
        LOG.warning("neither ANTHROPIC_API_KEY nor CLAUDE_CODE_OAUTH_TOKEN is in "
                    "%s/agent.env — claude will refuse to start", cfg.secrets)

    # Read once at startup only to say how many files were found. The trap this
    # catches is setting AGENT_CONTEXT_DIR and forgetting to uncomment the
    # volume that mounts it, which is otherwise silent: the paper simply stops
    # sounding like the operator's and nothing anywhere says why.
    context = prompt.read_context_dir(cfg.context_dir)
    LOG.info("worker up, watching %s; %d context file(s), briefs %s",
             cfg.desk, len(context), "on" if cfg.write_briefs else "off")

    backoff = 1.0
    while True:
        try:
            command = desk.claim()
        except Exception as e:                          # noqa: BLE001 - see below
            # Any failure to reach the desk is the same failure from here: wait
            # and try again. Distinguishing them would produce three branches
            # that all sleep, and a worker that exits on a restart of the desk
            # is a worker that has to be restarted by hand. This is also why the
            # compose files carry no `depends_on`: the backoff already covers a
            # desk that is not up yet.
            LOG.warning("claim failed (%s); retrying in %.0fs", e, backoff)
            time.sleep(backoff)
            backoff = min(backoff * 2, 300)
            continue

        if command is None:
            # The long poll expired with nothing queued: the healthy idle
            # answer, and an answer, so the backoff resets with it.
            backoff = 1.0
            continue

        if not is_command(command):
            # An answer the desk should never give, and the same medicine as an
            # unreachable one for the same reason -- see :func:`is_command` for
            # what exiting here would cost. Logged with the answer itself
            # because "which endpoint returned HTML" is the only question
            # anybody has once this starts.
            LOG.warning("the desk answered a claim with %.120r; backing off", command)
            time.sleep(backoff)
            backoff = min(backoff * 2, 300)
            continue

        backoff = 1.0
        LOG.info("claimed %s: %s", command["id"], command.get("text", "")[:120])
        try:
            handle(cfg, desk, command, agent_env)
        except Exception as e:                          # noqa: BLE001
            LOG.exception("command %s failed", command["id"])
            try:
                desk.finish(command["id"], False, "%s: %s" % (type(e).__name__, e))
            except Exception:                           # noqa: BLE001
                LOG.error("could not report the failure either")


if __name__ == "__main__":
    sys.exit(main() or 0)
