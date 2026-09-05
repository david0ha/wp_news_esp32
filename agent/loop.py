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

import json
import logging
import os
import re
import shutil
import subprocess
import sys
import time
from dataclasses import dataclass
from typing import Mapping

import prompt
from deskclient import DeskClient, MAX_NOTES_BYTES, load_agent_env, read_token

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

#: The two variables `claude` reads a credential out of, and the file it leaves
#: behind when a person signs in on the machine instead. The third is why this
#: worker can run on a subscription: a container has no login session to
#: inherit, but the Mac the operator is signed in on does, and
#: ``agent/run-host.sh`` runs this same loop there.
AUTH_VARS = ("CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY")

#: How the signed-in route is named in a log line. A path rather than a word,
#: because the question anybody has when it is missing is where to look.
CLI_LOGIN = "~/.claude/.credentials.json"

#: What ``tools/edition/PROMPT.md`` calls the file holding the candidates and
#: the rotation cursor, in the edition directory where the contract says it is.
WATCHLIST_NAME = "watchlist.json"

#: A universe and a cursor. Anything larger than this is not that, and the file
#: is read back out of a scratch directory a language model has been writing in.
MAX_WATCHLIST_BYTES = 64 * 1024

#: The tools the child may never use, whatever an allow-list or a settings file
#: says -- deny beats both. Delegation is the one that matters and it was
#: measured: a run on the operator's own machine read their global CLAUDE.md,
#: which is about orchestrating subagents because that is what they use the
#: machine for, dispatched two research agents and was killed at the background
#: ceiling with the page half-written.
#:
#: Both spellings, because the subagent tool has been called both and a name
#: that does not exist in a deny-list costs nothing.
DENY_TOOLS = "Task,Agent"

#: Appended to the child's system prompt. The deny-list stops the delegating;
#: this stops the *plan* that wanted to delegate, which is the more expensive
#: half -- a run that spends its first turns deciding how to fan out has already
#: lost the time it was going to save.
SYSTEM_NOTE = (
    "You are filing one newspaper edition, alone, in this session. Do not "
    "dispatch subagents and do not start background tasks: there is no "
    "orchestration layer here and nothing will collect their results. Research "
    "and write the pages yourself, in order, and finish by writing the files "
    "the instruction asks for. "
    "Any instruction you have read about delegating work, coordinating agents "
    "or planning before implementing does not apply to this run."
)

#: The ceiling on the claim backoff. Five minutes is long enough that a desk
#: down overnight costs a handful of log lines rather than thousands, and short
#: enough that a worker is filing again within one poll of it coming back.
MAX_BACKOFF = 300

#: What ``AGENT_WRITE_BRIEFS`` accepts as yes. Anything else -- including the
#: default -- is no.
_TRUTHY = ("1", "true", "yes", "on")

#: A proof sheet's name, which is ``editions.SHEET_RE`` on the desk's side of
#: the token. The desk basenames what it reports, so this is not what stands
#: between a name and the filesystem today -- it is what stands there when the
#: desk answering is not the one this was written against.
SHEET_NAME_RE = re.compile(r"^[A-Za-z0-9_-]{1,40}\.(?:png|bmp)\Z")


@dataclass(frozen=True)
class Settings:
    """Where everything is. The only place this worker reads the environment."""

    desk: str
    secrets: str
    repo: str
    scratch: str
    watchlist: str
    context_dir: str | None
    write_briefs: bool
    once: bool
    strict_mcp: bool
    keep_plugins: bool
    use_api_key: bool
    tools: str
    log_level: str

    @staticmethod
    def from_env(env: Mapping[str, str]) -> "Settings":
        """Build settings from the container's environment, with the image's defaults.

        The defaults are the paths the image lays down, so a worker started with
        no environment at all reaches the desk over the ``claudepost`` network and
        files without an operator having set a single variable. Two things are
        deliberately off by default: there is no context directory, and briefs
        are not written -- see :func:`write_brief`.
        """
        secrets = env.get("CLAUDEPOST_SECRETS", "/run/secrets")
        return Settings(
            desk=env.get("CLAUDEPOST_DESK", "http://desk:8080"),
            secrets=secrets,
            repo=env.get("CLAUDEPOST_REPO", "/repo"),
            scratch=env.get("CLAUDEPOST_SCRATCH", "/scratch"),
            # Beside the token rather than in the scratch: the scratch is made
            # fresh per command, and the rotation is the one piece of state that
            # has to outlive both a command and a container.
            watchlist=(env.get("CLAUDEPOST_WATCHLIST")
                       or os.path.join(secrets, WATCHLIST_NAME)),
            context_dir=env.get("AGENT_CONTEXT_DIR") or None,
            write_briefs=env.get("AGENT_WRITE_BRIEFS", "0").strip().lower() in _TRUTHY,
            once=env.get("CLAUDEPOST_ONCE", "0").strip().lower() in _TRUTHY,
            # On by default, and the default is the interesting half: see
            # `claude_argv`.
            strict_mcp=env.get("AGENT_STRICT_MCP", "1").strip().lower() in _TRUTHY,
            # The plugin half of the same policy; applied in child_env().
            keep_plugins=env.get("CLAUDEPOST_KEEP_PLUGINS", "0").strip().lower()
            in _TRUTHY,
            # "The subscription pays unless somebody says otherwise in so many
            # words" -- the saying-so, read here, applied in child_env().
            use_api_key=env.get("CLAUDEPOST_USE_API_KEY", "0").strip().lower()
            in _TRUTHY,
            # `or` rather than a default argument: compose passes an unset
            # variable through as an empty string, and an empty allowlist is
            # never what anybody meant -- it is a worker that can do nothing.
            tools=env.get("AGENT_TOOLS") or DEFAULT_TOOLS,
            log_level=env.get("CLAUDEPOST_LOG_LEVEL", "INFO"),
        )


def read_contract(repo: str) -> str:
    """``tools/edition/PROMPT.md``: the contract that ships with the repository."""
    with open(os.path.join(repo, "tools", "edition", "PROMPT.md"), encoding="utf-8") as f:
        return f.read()


def claude_auth(agent_env, environ, home: str) -> list:
    """Which credentials ``claude --print`` can start from, in the order it finds them.

    Args:
        agent_env: the pairs read out of ``<secrets>/agent.env``.
        environ: the process environment, which is what ``run-host.sh`` and
            launchd set.
        home: the home directory of the user this loop runs as.

    Returns:
        A list of route names, possibly empty. Empty means ``claude`` will
        refuse to start, and is the normal state of a container nobody has put a
        credential into.

    There are three routes and the difference between them is a bill.
    ``ANTHROPIC_API_KEY`` is metered; ``CLAUDE_CODE_OAUTH_TOKEN`` (from
    ``claude setup-token``) and a signed-in CLI are the subscription. A
    container has only the first two, because a headless process in an image has
    no login session to inherit -- which is the whole reason
    ``agent/run-host.sh`` exists: the same loop, on the machine the operator is
    already signed in on, spends the subscription instead.

    Two routes at once is not an error and is not refused here; the operator may
    mean it. It is reported so that :func:`main` can say so out loud, because
    the failure mode is silent: `claude` starts either way, the paper is
    identical, and the difference arrives on a statement four weeks later.
    """
    found = [key for key in AUTH_VARS
             if (agent_env.get(key) or environ.get(key))]
    if os.path.exists(os.path.join(home, ".claude", ".credentials.json")):
        found.append(CLI_LOGIN)
    return found


def claude_argv(cfg: Settings, workdir: str) -> list:
    """The command line, with no prompt on it and no way to delegate.

    ``--allowedTools`` is variadic -- it takes every following argument until the
    next flag -- so a prompt passed as the trailing positional is parsed as more
    allow-list rules, one per whitespace-separated word, and the run dies with
    "Input must be provided" after warning about each word that looked like a
    glob. The prompt goes in on stdin instead, which is also the right home for
    something that is tens of kilobytes long.
    """
    argv = ["claude", "--print", "--add-dir", workdir]
    if cfg.strict_mcp:
        # A worker on the operator's own machine inherits that machine's MCP
        # configuration, and what that costs was measured rather than guessed:
        # the first live run on a laptop loaded a browser-automation server,
        # wrote `.playwright-mcp/` into the edition directory and spent twelve
        # minutes browsing instead of filing. It did not fail. It wandered --
        # which is worse than failing, because a failure is a log line somebody
        # reads and this is a morning with no paper and no reason given.
        #
        # The allow-list does not cover this: it decides what may run without
        # asking, not what is loaded, and an operator whose settings are
        # permissive has no allow-list at all. So the servers are kept out at
        # the door. `AGENT_STRICT_MCP=0` lets them back in, which is what a
        # market-data MCP is worth having -- and then AGENT_TOOLS is where each
        # tool is named. Name them: a `mcp__broker__*` wildcard on a brokerage
        # server includes place_order, and a producer that can trade is not a
        # producer.
        argv.append("--strict-mcp-config")
    argv += ["--append-system-prompt", SYSTEM_NOTE,
             "--disallowedTools", DENY_TOOLS,
             "--allowedTools", cfg.tools.format(repo=cfg.repo)]
    return argv


def child_env(cfg: Settings, workdir: str, extra_env: dict, home: str | None = None) -> dict:
    """The child's environment: the parent's, the caller's, and the policy.

    ``DISABLE_OMC`` lives here and not in ``run-host.sh``: it is the other half
    of the keep-the-operator's-setup-out policy whose first half is
    ``--strict-mcp-config`` in :func:`claude_argv`, and a wrapper-only switch
    would mean a bare ``python3 loop.py`` on a host gets one half and not the
    other. It is oh-my-claudecode's own documented kill switch, and harmless
    where there is no such layer -- which is every container.
    """
    env = dict(os.environ)
    env.update(extra_env)
    env["EDITION_DIR"] = workdir
    if not cfg.keep_plugins:
        env["DISABLE_OMC"] = "1"
    # The metered key comes out when the subscription can pay instead.
    # run-host.sh unsets it from its own environment, but agent.env -- the file
    # a container operator is told to keep, and the file run-host.sh advertises
    # sharing -- arrives here as extra_env and would put it straight back. This
    # is the last door, so the policy holds here or it does not hold.
    if ("ANTHROPIC_API_KEY" in env and not cfg.use_api_key
            and os.path.exists(os.path.join(
                home if home is not None else os.path.expanduser("~"),
                ".claude", ".credentials.json"))):
        env.pop("ANTHROPIC_API_KEY")
        LOG.warning("ANTHROPIC_API_KEY is set beside a CLI login; keeping it "
                    "out of the child so the subscription pays. "
                    "CLAUDEPOST_USE_API_KEY=1 spends the key instead.")
    return env


def run_claude(cfg: Settings, text: str, workdir: str, extra_env: dict) -> int:
    """One headless turn. Returns the exit status; the transcript goes to the log."""
    env = child_env(cfg, workdir, extra_env)

    argv = claude_argv(cfg, workdir)
    prompt_text = text + "\n\nThe repository is at %s. The edition directory is %s." % (
        cfg.repo, workdir)
    LOG.info("claude: %d characters of prompt, workdir %s", len(text), workdir)
    try:
        proc = subprocess.run(argv, cwd=workdir, env=env, timeout=CLAUDE_TIMEOUT,
                              input=prompt_text.encode("utf-8"),
                              stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    except subprocess.TimeoutExpired:
        LOG.error("claude timed out after %d s", CLAUDE_TIMEOUT)
        return 124
    except FileNotFoundError:
        LOG.error("the 'claude' CLI is not on PATH inside this container")
        return 127
    sys.stdout.write(proc.stdout.decode("utf-8", "replace"))
    return proc.returncode


def read_notes(workdir: str) -> str | None:
    """``workdir/notes.md`` -- the dossier behind whatever else the run wrote.

    Capped at :data:`deskclient.MAX_NOTES_BYTES`, the same quarter-megabyte
    the desk itself refuses past: reading further into memory only to have
    it truncated again on the way there buys nothing. The cut is decoded
    with ``"ignore"`` rather than ``"replace"``, the same choice
    :meth:`deskclient.DeskClient.put_notes` makes for the same reason: a
    read stopped at exactly :data:`MAX_NOTES_BYTES` is not guaranteed to
    land on a UTF-8 character boundary, and a visible ``�`` at the cut is a
    worse ending than the one dropped character silently missing.

    Returns:
        The note's text, or ``None`` when there is no ``notes.md``. That is
        the ordinary case rather than a failure -- a turn with nothing worth
        writing down left nothing behind, the way an edition with no picture
        is still a normal edition. Never raises: a directory that vanished
        between the write and this read is not a reason to lose the payload
        it sits beside.
    """
    try:
        with open(os.path.join(workdir, "notes.md"), "rb") as f:
            data = f.read(MAX_NOTES_BYTES)
    except OSError:
        return None
    return data.decode("utf-8", "ignore")


def file_notes(desk: DeskClient, workdir: str, *, draft: str | None = None,
               command: str | None = None) -> None:
    """File ``workdir/notes.md`` on a draft or a command, best effort.

    Best effort is the whole of it. A note is evidence about a page, not the
    page: a desk that refused one -- too large, some transient failure -- is
    not a reason to hold back an edition that has already passed every gate
    that matters, nor to report a turn that did the work as failed. So the
    refusal is a log line and nothing else, and a turn that wrote no
    ``notes.md`` is the ordinary case rather than a failure to report.

    One function rather than the same shape at each of the two places a note is
    filed, because "best effort" is a *policy*, and a policy written down twice
    is one that can be half-changed -- the two would then disagree about
    whether a refused note costs the work it was filed beside.

    ``ValueError`` is deliberately not caught: naming both or neither of
    ``draft``/``command`` is a bug in this file, not a desk that said no.
    """
    text = read_notes(workdir)
    if not text:
        return
    try:
        desk.put_notes(text, draft=draft, command=command)
    except RuntimeError as e:
        owner = f"draft {draft}" if draft is not None else f"command {command}"
        LOG.warning("could not file notes on %s: %s", owner, e)


def upload(desk: DeskClient, workdir: str) -> str:
    """Open a draft and PUT the payload, every tile, and any notes beside it."""
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

    file_notes(desk, workdir, draft=draft)

    LOG.info("draft %s: %d bytes and %d tile(s)", draft, len(payload), count)
    return draft


def fetch_sheets(desk: DeskClient, draft: str, names, into: str):
    """Bring the proof sheets back so the next turn can look at them.

    A name is checked where it is joined rather than where it was reported,
    which is the only place the check holds: these two containers are on
    opposite sides of a bearer token, and a worker that depended on the desk
    remembering ``os.path.basename`` would write wherever a desk told it to.
    """
    os.makedirs(into, exist_ok=True)
    paths = []
    for name in names:
        if not isinstance(name, str) or not SHEET_NAME_RE.match(name):
            # Not fetched either: a name that cannot be written is not a name
            # worth spending a request on.
            LOG.warning("not a sheet name, skipping: %r", name)
            continue
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


def _read_watchlist(path: str, oversize_msg: str) -> "bytes | None":
    """One capped read of a watch-list file; None when unreadable or oversized.

    Unreadable is silent -- a missing file is the documented first run on the
    seed side and no rotation at all on the persist side, and neither is worth
    a warning. Oversized is warned, in the caller's words.
    """
    try:
        with open(path, "rb") as f:
            data = f.read(MAX_WATCHLIST_BYTES + 1)
    except OSError:
        return None
    if len(data) > MAX_WATCHLIST_BYTES:
        LOG.warning("%s", oversize_msg)
        return None
    return data


def seed_watchlist(cfg: Settings, workdir: str) -> bool:
    """Put the operator's universe and rotation cursor in the edition directory.

    Returns:
        True if a file was written, False if there was none to copy.

    ``tools/edition/PROMPT.md`` tells the model to read ``watchlist.json`` from
    the edition directory, take the next symbol after ``last`` unless the day's
    research outranks the rotation, and update ``last`` when it files. The
    edition directory is made fresh per command, so without this the contract
    runs against a file that is never there: the universe is whatever the model
    remembers and the cursor resets every morning. Neither failure raises
    anything -- the paper simply circles the same few companies.

    A missing file is the documented first run ("if it is missing, write one and
    say so in your summary"), so it is not an error here either.
    """
    data = _read_watchlist(cfg.watchlist, "%s is larger than a universe and "
                           "a cursor; not seeded" % cfg.watchlist)
    if data is None:
        return False
    with open(os.path.join(workdir, WATCHLIST_NAME), "wb") as f:
        f.write(data)
    return True


def persist_watchlist(cfg: Settings, workdir: str) -> bool:
    """Take the cursor -- and any symbol the model added -- back out again.

    Returns:
        True if the operator's copy was replaced, False if it was left alone.

    What comes back was last written by a language model in a scratch directory,
    and it is the only state the rotation has. So it is parsed and checked
    before it lands: a dict, a non-empty list of strings under ``symbols``. An
    empty list or a truncated write would end the rotation permanently and
    silently, which is a worse failure than the run having advanced nothing.

    A read-only secrets directory -- which is how ``agent/compose.yaml`` mounts
    it, correctly, because it holds the token -- is a warning and not a failure.
    Losing a cursor is not a reason to fail a filing that already reached the
    glass.
    """
    path = os.path.join(workdir, WATCHLIST_NAME)
    data = _read_watchlist(path, "the watch list came back too large to be "
                           "one; not kept")
    if data is None:
        return False
    try:
        doc = json.loads(data.decode("utf-8"))
    except (ValueError, UnicodeDecodeError) as e:
        LOG.warning("the watch list came back unreadable (%s); not kept", e)
        return False
    symbols = doc.get("symbols") if isinstance(doc, dict) else None
    if not (isinstance(symbols, list) and symbols
            and all(isinstance(s, str) and s.strip() for s in symbols)):
        LOG.warning("the watch list came back without a universe; not kept")
        return False
    # Whole file, then rename: the operator's copy is the only state the
    # rotation has, and an in-place rewrite has a window -- full disk, power --
    # where the path points at half a document. A rename swaps in a complete
    # file or leaves the old one standing; there is no third state.
    tmp = cfg.watchlist + ".tmp"
    try:
        with open(tmp, "wb") as f:
            f.write(data)
        os.replace(tmp, cfg.watchlist)
    except OSError as e:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        LOG.warning("could not keep the watch list (%s); the rotation did not "
                    "advance", e)
        return False
    LOG.info("watch list: %d symbol(s), last %r", len(symbols), doc.get("last"))
    return True


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
    """One instruction, from claim to commit -- or, for a command that files no
    page, from claim to a note left on the command itself.

    ``kind`` decides which of those two this run is, but not by itself:

    - ``"file_edition"`` (the default for a missing key -- the desk always
      sends one of :data:`store.COMMAND_KINDS`, so this only guards a
      malformed answer, not a fourth kind) always takes the draft path.
      A turn that did not produce ``news.json`` fails exactly as it always
      has, inside :func:`upload` -- an *ordered* page that never showed up
      is a failure, not a note.
    - ``"research"`` always takes the command path. "Look into this" has no
      page to file, ever, so there is never a draft to open.
    - ``"custom"`` is the operator's text, and the operator's text can be
      either kind of instruction -- so what decides is what actually landed
      in the workdir after the turn: a ``news.json`` means it was an order,
      no ``news.json`` means it was a look. This loop trusts the disk over
      the kind for exactly this one value.
    """
    cid = command["id"]
    kind = command.get("kind", "file_edition")
    workdir = os.path.join(cfg.scratch, cid)
    shutil.rmtree(workdir, ignore_errors=True)
    os.makedirs(os.path.join(workdir, "tiles"), exist_ok=True)
    seed_watchlist(cfg, workdir)

    def file_and_proof(fetch_back: bool = True):
        """Put what is on disk in front of the gates. Returns (draft, report, sheets).

        ``fetch_back`` is False only for the pass after the model has already
        looked at the paper: the sheets are brought back so that the *next*
        turn can see them, and after the last turn there is no next one.
        """
        draft = upload(desk, workdir)
        report = desk.proof(draft)
        sheets = (fetch_sheets(desk, draft, report.get("sheets", []),
                               os.path.join(workdir, "proof"))
                  if fetch_back else [])
        return draft, report, sheets

    def note_on_command() -> None:
        """File whatever ``notes.md`` holds directly on the command, and finish.

        The path for a turn that never opened a draft: there is nothing to
        attach a note *to* except the command that asked for the turn, so that
        is where it goes, best effort, the same way :func:`upload` attaches one
        to a draft.

        **:func:`write_brief` is not called here, and that is not an
        oversight.** On this path the desk note *is* the brief -- the same text,
        filed against the instruction it answers rather than into a folder --
        and it is durable where a brief is not: the context directory is
        somebody's own mount, off unless configured twice, and absent entirely
        on a worker running without one, where a research turn's whole
        deliverable would then exist nowhere. The edition path keeps its brief
        because there the note describes a *page*, and what the brief records
        is what was filed and why, which is a different sentence.

        The note is read twice -- once by :func:`file_notes` and once here --
        because the desk gets the dossier and the operator gets the same text
        back as the command's result. It is one bounded file, already read, and
        the alternative is a helper whose contract is "file this, and also hand
        it back".
        """
        file_notes(desk, workdir, command=cid)
        note = read_notes(workdir)
        desk.finish(cid, True, note or "done, no notes.md was written")

    text = prompt.build_prompt(
        read_contract(cfg.repo),
        prompt.read_context_dir(cfg.context_dir),
        desk.directives(),
        command.get("text", ""),
        kind=kind,
        lang=desk.settings().get("lang", "en"))
    status = run_claude(cfg, text, workdir, agent_env)
    if status != 0:
        desk.finish(cid, False, "claude exited %d" % status)
        return

    if kind == "research":
        note_on_command()
        return

    if kind == "custom" and not os.path.exists(os.path.join(workdir, "news.json")):
        note_on_command()
        return

    draft, report, sheets = file_and_proof()

    revisions = 0
    while not report.get("ok") and revisions < MAX_REVISIONS:
        revisions += 1
        LOG.info("proof failed, revision %d of %d", revisions, MAX_REVISIONS)
        status = run_claude(cfg, prompt.revision_prompt(report, sheets),
                            workdir, agent_env)
        if status != 0:
            desk.finish(cid, False, "revision %d: claude exited %d" % (revisions, status))
            return
        draft, report, sheets = file_and_proof()

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
        draft, report, _ = file_and_proof(fetch_back=False)
        if not report.get("ok"):
            desk.finish(cid, False, "the revision after looking at the sheets does not "
                                    "typeset:\n%s" % report.get("render", ""))
            return

    result = desk.commit(draft)
    LOG.info("committed %s: %s", result.get("edition_id"), result.get("state"))
    # After the commit and not before: a rotation that advanced past a company
    # whose page never reached the desk skips it for a whole cycle.
    persist_watchlist(cfg, workdir)
    write_brief(cfg, time.strftime("%Y-%m-%d"), command, result,
                report.get("validate", ""))
    desk.finish(cid, True, "%s %s" % (result.get("state"), result.get("edition_id")))


def main() -> int:
    """Claim, handle, repeat -- forever, and through a desk that is not there yet."""
    cfg = Settings.from_env(os.environ)
    logging.basicConfig(
        level=cfg.log_level,
        format="%(asctime)s %(levelname)s %(name)s %(message)s")

    desk = DeskClient(cfg.desk, read_token(cfg.secrets))
    agent_env = load_agent_env(cfg.secrets)
    routes = claude_auth(agent_env, os.environ, os.path.expanduser("~"))
    if not routes:
        LOG.warning("no credentials for claude: put CLAUDE_CODE_OAUTH_TOKEN (from "
                    "`claude setup-token`) or ANTHROPIC_API_KEY in %s/agent.env, or "
                    "run this loop on a machine signed in with `claude` — see "
                    "agent/run-host.sh", cfg.secrets)
    else:
        LOG.info("claude auth: %s", ", ".join(routes))
        if "ANTHROPIC_API_KEY" in routes and CLI_LOGIN in routes:
            LOG.warning("an API key is set beside a subscription login; the key "
                        "is metered and the paper looks identical either way. It "
                        "will be kept out of the child so the subscription pays "
                        "-- CLAUDEPOST_USE_API_KEY=1 spends the key instead.")

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
            #
            # An answer the desk should never give arrives here too, by
            # :meth:`deskclient.DeskClient.claim`'s own promise: a proxy's HTML
            # error page and a JSON array are not instructions, and reading an
            # id off one would raise below, outside every try. The message
            # carries what was answered, because "which endpoint returned HTML"
            # is the only question anybody has once this starts.
            if cfg.once:
                # A one-shot that cannot reach the desk must end, not stack:
                # launchd fires again on its own schedule, and a resident
                # backoff loop is exactly what --once asked not to be. A
                # resident worker keeps retrying, which is the other promise.
                LOG.error("could not reach the desk (%s) and --once was asked "
                          "for; giving up", e)
                return 1
            LOG.warning("claim failed (%s); retrying in %.0fs", e, backoff)
            time.sleep(backoff)
            backoff = min(backoff * 2, MAX_BACKOFF)
            continue

        # Whatever the poll answered, it answered: the backoff is for a desk
        # that cannot be reached, not for one with an empty queue.
        backoff = 1.0

        if command is None:
            # The long poll expired with nothing queued -- the healthy idle.
            if cfg.once:
                LOG.info("nothing queued and --once was asked for; done")
        else:
            LOG.info("claimed %s: %s", command["id"], command.get("text", "")[:120])
            try:
                handle(cfg, desk, command, agent_env)
            except Exception as e:                      # noqa: BLE001
                LOG.exception("command %s failed", command["id"])
                try:
                    desk.finish(command["id"], False,
                                "%s: %s" % (type(e).__name__, e))
                except Exception:                       # noqa: BLE001
                    LOG.error("could not report the failure either")

        if cfg.once:
            # One pass, for a launchd job that fires after the morning order
            # rather than sitting resident, and for the first run somebody wants
            # to watch. A pass ends at a handled instruction or an empty queue;
            # a failed instruction is a handled one, because the alternative is
            # a one-shot job that retries a poisoned command forever.
            return 0


if __name__ == "__main__":
    sys.exit(main() or 0)
