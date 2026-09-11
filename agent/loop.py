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

There is a **second job on the same queue**, and it is not a page. A
``calendar`` command files the event book: ten dated things about to happen,
each annotated against a position the owner actually holds, read on a phone
and printed nowhere. It reads its own contract, is seeded with its own files
and never opens a draft. The split matters more than the feature does --
``GET /news.json`` is served with no authorization, so the process that writes
the newspaper must never hold the positions at all, and that is a fact about
which branch of :func:`handle` calls :func:`seed_positions` rather than
anything asked of a model.

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

import datetime
import json
import logging
import os
import pwd
import re
import shutil
import stat
import subprocess
import sys
import time
from dataclasses import dataclass
from typing import Mapping

import prompt
from deskclient import (DeskClient, MAX_NOTES_BYTES, PAPER_TARGET,
                        load_agent_env, read_token)

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

#: The command kind that files the event book instead of a page. It is the one
#: kind that decides the whole shape of a run by itself -- see :func:`handle`.
CALENDAR_KIND = "calendar"

#: The command kind the phone posts: a message about the paper, answered in
#: `answer.md`, which becomes an edition only if the model decided the message
#: asked for one. Like `custom`, the disk decides -- see :func:`handle`.
ASK_KIND = "ask"

#: The command kind whose company the desk names instead of the rotation
#: choosing it: a paper for one company on the watch list, refreshed on a
#: cadence, filed as an edition that never touches the board's pointers. It is
#: `file_edition`'s path with three differences -- see :func:`handle`.
PAPER_KIND = "paper"

#: What a ``paper`` command's ``symbol`` may be: the desk's own rule
#: (uppercase, one to eight of letter, digit, dot or hyphen), restated here
#: for :data:`TILE_ID_RE`'s reason. This value is written into a prompt and
#: into a commit body, and the two ends of a bearer token are two programs: a
#: worker that trusted whatever arrived under that key would put it in front
#: of a model and then on the wire.
PAPER_SYMBOL_RE = re.compile(r"^[A-Z0-9.\-]{1,8}\Z")

#: Where the edition the message is about is put. A directory rather than a
#: bare file because the payload names its pictures by id, and a model asked
#: whether the photograph suits the story cannot answer that from an id.
CURRENT_DIR = "current"

#: The reply to a person. A second file beside ``notes.md`` rather than the same
#: one, because an `ask` that rewrites the paper writes both: the dossier goes
#: on the draft and the answer goes on the command, where the phone reads it.
ANSWER_NAME = "answer.md"

#: One turn of the conversation behind this message. One, not the thread: the
#: desk keeps every turn and the phone shows them, and the prompt gets the one
#: that matters.
PREVIOUS_NAME = "previous.md"

#: What a commit's state is called back to the phone. ``unchanged`` is
#: ``revised`` on purpose: the owner asked for a change, the desk decided the
#: result was byte-identical to what was already current, and the honest answer
#: to the person waiting is still "I changed the paper" -- the answer.md says
#: what was done. Anything else is passed through under its own name rather
#: than guessed at.
ASK_STATES = {"published": "revised", "unchanged": "revised", "staged": "staged"}

#: ``tiles.TILE_ID_RE`` on the desk's side of the token, which is ``ui_tile.c``'s
#: ``id_ok()`` restated. Checked here because an id off the wire becomes a URL
#: and then a filename -- :func:`fetch_sheets`' argument, on the other document.
TILE_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,15}\Z")

#: ``tiles.MAX_PAYLOAD_BYTES`` and ``tiles.MAX_TILE_BYTES``, duplicated for
#: :data:`MAX_POSITIONS_BYTES`'s reason: what these bound is not the socket but
#: what is written into a directory a language model is about to read.
MAX_PUBLIC_PAYLOAD_BYTES = 300 * 1024
MAX_PUBLIC_TILE_BYTES = 960_000

#: What ``tools/edition/CALENDAR.md`` calls the three files a calendar run is
#: given beside the watch list, in the directory where its input table says
#: they are. ``econ.json`` is named only here and there: the desk serves that
#: window from a route rather than a document, so this file's name is a
#: contract between this module and that brief and nowhere else.
POSITIONS_NAME = "positions.json"
CALENDAR_NAME = "calendar.json"
ECON_NAME = "econ.json"

#: The desk's own ceilings on the two documents it stores --
#: ``positions.MAX_DOC_BYTES`` and ``calendar.MAX_DOC_BYTES`` -- and a figure
#: of this worker's own for the economic window, which the desk does not store
#: and therefore does not bound.
#:
#: Duplicated rather than imported for :data:`deskclient.MAX_NOTES_BYTES`'s
#: reason: the worker and the desk are two ends of one wire, not one program.
#: What these bound is not the socket, which has already been read by the time
#: a document reaches here -- it is **what is written into a directory a
#: language model is about to read**, which is the number that matters. A desk
#: cannot answer past the first two; something in front of one can, and
#: :meth:`deskclient.DeskClient.claim` makes the same argument about ids for
#: the same reason.
MAX_POSITIONS_BYTES = 128 * 1024
MAX_CALENDAR_BYTES = 256 * 1024
MAX_ECON_BYTES = 1024 * 1024

#: How far ahead the economic window is fetched. Sixty days rather than the
#: four hundred a book may legally reach: an option two months out prices the
#: rate decisions and the inflation prints inside that window and very little
#: beyond it, and investing.com's calendar past two months is mostly
#: placeholders. It starts today rather than in the past, because this book is
#: about what is coming -- what is behind is the newspaper's job.
ECON_WINDOW_DAYS = 60

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
#: Two slots, and only two, because only two words of it were ever about the
#: newspaper. A calendar run was being told "you are filing one newspaper
#: edition" and then handed a contract that forbids filing one -- a nudge
#: toward writing the very `news.json` `handle` refuses, in the same breath as
#: the instruction not to.
_SOLO_NOTE = (
    "You are {job}, alone, in this session. Do not "
    "dispatch subagents and do not start background tasks: there is no "
    "orchestration layer here and nothing will collect their results. Research "
    "and write the {work} yourself, in order, and finish by writing the files "
    "the instruction asks for. "
    "Any instruction you have read about delegating work, coordinating agents "
    "or planning before implementing does not apply to this run."
)

#: Byte-for-byte what it has always been, and `StandaloneParityTest` pins it
#: against `agent/standalone/file-edition.sh`. Generalising the note must not
#: move this string: the standalone path files editions and nothing else, so it
#: has no second spelling to keep in step.
SYSTEM_NOTE = _SOLO_NOTE.format(job="filing one newspaper edition", work="pages")

#: The same note for the second job. "Entries" rather than "pages" because a
#: book has no pages, and a model told to write pages writes something that
#: wants to be a page.
CALENDAR_SYSTEM_NOTE = _SOLO_NOTE.format(job="compiling one event book",
                                         work="entries")

#: The same note for the third job. "Answer" rather than "pages", because a
#: turn told it is filing a newspaper and then handed rules under which most
#: messages file nothing has been nudged toward writing the very ``news.json``
#: rule 2 declined -- the same mistake the calendar note was split out to fix.
ASK_SYSTEM_NOTE = _SOLO_NOTE.format(job="answering one message about the newspaper",
                                    work="answer")


def system_note(kind: str) -> str:
    """Which solo note this run gets. One decision, in one place."""
    if kind == CALENDAR_KIND:
        return CALENDAR_SYSTEM_NOTE
    if kind == ASK_KIND:
        return ASK_SYSTEM_NOTE
    return SYSTEM_NOTE

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
    #: The user every `claude` turn is spawned as, or "" for "do not switch".
    #: Set to `model` by the image; empty under agent/run-host.sh, where the
    #: turn runs as the operator and there is nobody to switch to.
    run_as: str

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
            # /state rather than beside the token: the secrets are not a mount
            # any more, and the rotation needs a writable one. Nothing
            # confidential goes here -- the watch list is seeded into the
            # workdir in front of the model on purpose.
            watchlist=(env.get("CLAUDEPOST_WATCHLIST") or "/state/watchlist.json"),
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
            # Empty means "run the turn as this process's own user", which is
            # what a host run wants and what a container without the second
            # user can do. The image sets it; nothing else does.
            run_as=env.get("AGENT_RUN_AS", "").strip(),
        )


def read_contract(repo: str, kind: str = "file_edition") -> str:
    """The contract that ships with the repository, for this kind of command.

    ``tools/edition/PROMPT.md`` for the newspaper, ``CALENDAR.md`` for the
    event book. :func:`prompt.contract_name` decides which -- the choice is
    pure and lives there, the repository root and the I/O live here.
    """
    path = os.path.join(repo, "tools", "edition", prompt.contract_name(kind))
    with open(path, encoding="utf-8") as f:
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


def claude_argv(cfg: Settings, workdir: str, kind: str = "file_edition") -> list:
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
    argv += ["--append-system-prompt", system_note(kind),
             "--disallowedTools", DENY_TOOLS,
             "--allowedTools", cfg.tools.format(repo=cfg.repo)]
    # gosu rather than a setuid anything, and root rather than a preference:
    # this prefix only works because the loop is uid 0. A process that is not
    # root cannot change uid at all -- gosu is not setuid and compose sets
    # `no-new-privileges:true` -- which is why `main` refuses to start a
    # non-root loop with this set rather than discovering it here, one claim in.
    if cfg.run_as:
        argv = ["gosu", cfg.run_as] + argv
    return argv


def run_as_home(user: str) -> str:
    """The home directory of the user a turn is handed to.

    ``claude`` writes its own configuration under ``$HOME``, so a child that
    keeps the loop's ``HOME`` fails on its first write into a directory it does
    not own -- with a message about a config file rather than about a uid.

    A user this machine does not have answers ``/home/<user>`` rather than
    raising: this is a pure function so that the argv and env tests can assert
    it anywhere, and the place a missing user is actually caught is
    :func:`own_workdir`, which has to look it up for real.
    """
    try:
        return pwd.getpwnam(user).pw_dir
    except KeyError:
        return os.path.join("/home", user)


def own_workdir(cfg: Settings, workdir: str) -> None:
    """Hand the command's directory to the user the turn will run as.

    Called once, after every seeded file is written and before the first turn.
    After, because the loop writes those files and the contract asks the model
    to rewrite ``watchlist.json`` in place; before, because the turn is what
    needs to write there at all.

    Does nothing when no user is being switched to, which is every host run.

    Raises:
        RuntimeError: ``AGENT_RUN_AS`` names a user this image does not have.
            :func:`main` has already refused to start a loop that is not root,
            so the remaining way to get here is a typo, and a command that fails
            by name beats a turn that runs as the loop with the wall silently
            absent.
    """
    if not cfg.run_as:
        return
    try:
        ent = pwd.getpwnam(cfg.run_as)
    except KeyError:
        raise RuntimeError(
            "AGENT_RUN_AS=%s is not a user in this image; the turn has nobody "
            "to be handed to" % cfg.run_as)
    for root, dirs, files in os.walk(workdir):
        for name in dirs + files:
            os.chown(os.path.join(root, name), ent.pw_uid, ent.pw_gid)
    os.chown(workdir, ent.pw_uid, ent.pw_gid)


def child_env(cfg: Settings, workdir: str, extra_env: dict, home: str | None = None) -> dict:
    """The child's environment: the parent's, the caller's, and the policy.

    Two credentials are taken out here and they are taken out for two different
    reasons -- the desk token because the child must not have it at all, the
    metered API key because the subscription should pay when it can. What they
    share is *where*: this is the last door either of them passes through, and
    a policy that holds only in the wrapper is a policy a bare
    ``python3 loop.py`` does not have.

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
    # The desk token comes out, always. `load_agent_env` already strips it from
    # `agent.env`, which is the documented place to keep it -- but this dict
    # starts from `os.environ`, and `run-host.sh` exports every `KEY=value` in
    # `$REPO/agent/.env`, so an operator who kept the token in the *other* file
    # has it in the process environment and it would go straight back into the
    # child. Same argument as the key below and the same sentence: this is the
    # last door, so the policy holds here or it does not hold. What it now
    # guards is larger than it was -- a producer token reads
    # `GET /api/positions`, which is the owner's strikes, sizes and entry
    # prices, where before this branch it read editions.
    if env.pop("CLAUDEPOST_TOKEN", None) is not None:
        LOG.debug("the desk token is in this process's environment, which is "
                  "where compose's env_file puts it; keeping it out of the "
                  "child, which has no use for it.")
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
    # The child is about to become somebody else, so its home moves with it.
    # Left at the loop's, `claude` writes its configuration into a directory it
    # does not own and the turn fails on something that reads like a bad
    # install.
    if cfg.run_as:
        env["HOME"] = run_as_home(cfg.run_as)
        env["USER"] = env["LOGNAME"] = cfg.run_as
    return env


def run_claude(cfg: Settings, text: str, workdir: str, extra_env: dict,
               kind: str = "file_edition") -> int:
    """One headless turn. Returns the exit status; the transcript goes to the log.

    ``kind`` reaches only :func:`system_note`. The revision and look turns keep
    the default because they are always about an edition -- there is no proof
    sheet to look at on a calendar run.
    """
    # The credential probe inside child_env has to look at the home the child
    # will actually run with, not the loop's -- when a turn is handed to
    # another user, that is run_as_home(cfg.run_as), the same value child_env
    # itself writes into the child's HOME a few lines later. Left at None here,
    # the probe would keep checking the loop's own home (`/root` in the image)
    # forever, and a CLI login placed under the model user's home would never
    # be found: ANTHROPIC_API_KEY would stay in the child's environment and the
    # metered key would silently win over the subscription.
    env = child_env(cfg, workdir, extra_env,
                     home=run_as_home(cfg.run_as) if cfg.run_as else None)

    argv = claude_argv(cfg, workdir, kind)
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


def _open_regular(path: str):
    """Open ``path`` for reading, refusing anything ``os.lstat`` does not call
    a plain file.

    Every read this loop does *back out of* a workdir happens after
    :func:`own_workdir` has chowned that directory to the turn's own user, so
    every one of these files was, for the length of the turn, writable by the
    model rather than by this process. The turn's shell allowlist has no
    ``Bash`` today, so planting a symlink there is not reachable in practice --
    but a directory a subprocess owns should not depend on that staying true,
    and the read side is the cheap place to hold the line: a symlink at
    ``notes.md`` pointing at, say, ``/etc/shadow`` would otherwise have this
    root loop open exactly that file and hand its bytes to the desk or the log.

    ``lstat`` rather than ``stat``, on purpose -- ``stat`` follows the
    symlink and reports on whatever it points at, which is the one thing this
    check must not do. A regular file's own bytes are read normally; anything
    else -- a symlink, a fifo, a socket, a device node -- is refused before a
    single byte of it is touched.

    Raises:
        OSError: for a missing path, exactly as ``open`` would, and also for a
            path that exists but is not a regular file -- one exception type,
            so no caller needs a second branch to tell the two apart.
    """
    st = os.lstat(path)
    if not stat.S_ISREG(st.st_mode):
        LOG.warning("refusing to read %s: not a regular file -- a symlink or "
                    "other special file was found where the turn's own "
                    "output was expected", path)
        raise OSError("refusing to read a non-regular file: %s" % path)
    return open(path, "rb")


def _read_workdir_text(workdir: str, name: str) -> str | None:
    """One text file out of the workdir, capped and decoded forgivingly.

    Capped at :data:`deskclient.MAX_NOTES_BYTES`, the same quarter-megabyte
    the desk itself refuses past: reading further into memory only to have
    it truncated again on the way there buys nothing. The cut is decoded
    with ``"ignore"`` rather than ``"replace"``, the same choice
    :meth:`deskclient.DeskClient.put_notes` makes for the same reason: a
    read stopped at exactly :data:`MAX_NOTES_BYTES` is not guaranteed to
    land on a UTF-8 character boundary, and a visible ``�`` at the cut is a
    worse ending than the one dropped character silently missing.

    Never raises: a directory that vanished between the write and this read
    is not a reason to lose the payload beside it.
    """
    try:
        with _open_regular(os.path.join(workdir, name)) as f:
            data = f.read(MAX_NOTES_BYTES)
    except OSError:
        return None
    return data.decode("utf-8", "ignore")


def read_notes(workdir: str) -> str | None:
    """``workdir/notes.md`` -- the dossier behind whatever else the run wrote.

    Returns:
        The note's text, or ``None`` when there is no ``notes.md``. That is
        the ordinary case rather than a failure -- a turn with nothing worth
        writing down left nothing behind, the way an edition with no picture
        is still a normal edition.
    """
    return _read_workdir_text(workdir, "notes.md")


def read_answer(workdir: str) -> str | None:
    """``workdir/answer.md`` -- the reply an `ask` writes to a person.

    Separate from :func:`read_notes` because they are separate documents: a
    message that changes the paper produces a dossier about the page *and* a
    reply about the change, and they go to different places.
    """
    return _read_workdir_text(workdir, ANSWER_NAME)


def answer_as_notes(workdir: str, answer: str) -> bool:
    """Let the reply stand in as the dossier, unless the turn wrote one itself.

    **`ask` runs that revise the paper only**, and called *before the draft path
    begins* -- which is the whole of it, and the reason it is a function with a
    docstring rather than three lines beside the commit.

    :func:`upload` files whatever ``notes.md`` holds onto every draft it opens,
    the revision loop opens a fresh draft on each pass, and the desk copies a
    draft's note into the edition **inside** ``commit`` -- so a note put on the
    draft after ``desk.commit()`` returns lands on a draft nobody will read
    again and never reaches the edition at all. Writing it here instead puts it
    on the first draft and every one after it for free, which is also the order
    the design gives: open the draft, put the payload and the tiles, put the
    answer as the draft's notes too, then proof.

    Returns:
        True if the reply was written as the note, False when the turn left a
        ``notes.md`` of its own -- which wins, being about the page where the
        answer is about the person -- or when the write failed.

    Never raises: a note is evidence about a page, not the page, and
    :func:`put_notes_best_effort` makes the same argument one document further
    on.

    One nuance under :func:`own_workdir`, where the turn runs as another user:
    this file is written by the loop, so it belongs to the loop rather than to
    the model, and a *revision* turn that decided to write a dossier it did not
    write in the first turn may not be able to replace it. Accepted rather than
    worked around. The contract asks for ``notes.md`` in the turn that writes
    the page, so a run that reaches here has already declined once; the reply
    is on the draft either way; and the cost of the remote case is an edition
    whose note is the answer instead of a late dossier, which is the thing this
    function is for.
    """
    if read_notes(workdir):
        return False
    try:
        with open(os.path.join(workdir, "notes.md"), "w", encoding="utf-8") as f:
            f.write(answer)
    except OSError as e:
        LOG.warning("could not write the answer as the draft's notes: %s", e)
        return False
    return True


def put_notes_best_effort(desk: DeskClient, text: str | None, *,
                          draft: str | None = None,
                          command: str | None = None) -> None:
    """File one piece of text as a note, best effort.

    Best effort is the whole of it. A note is evidence about a page, not the
    page: a desk that refused one -- too large, some transient failure -- is
    not a reason to hold back an edition that has already passed every gate
    that matters, nor to report a turn that did the work as failed.

    ``ValueError`` is deliberately not caught: naming both or neither of
    ``draft``/``command`` is a bug in this file, not a desk that said no.
    """
    if not text:
        return
    try:
        desk.put_notes(text, draft=draft, command=command)
    except RuntimeError as e:
        owner = f"draft {draft}" if draft is not None else f"command {command}"
        LOG.warning("could not file notes on %s: %s", owner, e)


def file_notes(desk: DeskClient, workdir: str, *, draft: str | None = None,
               command: str | None = None) -> None:
    """File ``workdir/notes.md`` on a draft or a command, best effort.

    One function rather than the same shape at each of the two places a note is
    filed, because "best effort" is a *policy*, and a policy written down twice
    is one that can be half-changed -- the two would then disagree about
    whether a refused note costs the work it was filed beside.
    """
    put_notes_best_effort(desk, read_notes(workdir), draft=draft, command=command)


def upload(desk: DeskClient, workdir: str) -> str:
    """Open a draft and PUT the payload, every tile, and any notes beside it."""
    payload_path = os.path.join(workdir, "news.json")
    try:
        with _open_regular(payload_path) as f:
            payload = f.read()
    except OSError:
        raise RuntimeError("no news.json was produced") from None

    draft = desk.open_draft()
    desk.put_payload(draft, payload)

    tiles_dir = os.path.join(workdir, "tiles")
    count = 0
    if os.path.isdir(tiles_dir) and not os.path.islink(tiles_dir):
        for name in sorted(os.listdir(tiles_dir)):
            if not name.endswith(".bin"):
                continue
            # Not caught: a tile this loop cannot read is not a photograph
            # missing from the edition, it is a turn that planted something
            # where a tile belonged, and the command should fail loudly on it
            # the same way a missing news.json does, rather than file a page
            # quietly short one picture.
            with _open_regular(os.path.join(tiles_dir, name)) as f:
                tile = f.read()
            desk.put_tile(draft, name[:-4], tile)
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


def _read_watchlist(path: str, oversize_msg: str, *,
                    guard_symlink: bool = False) -> "bytes | None":
    """One capped read of a watch-list file; None when unreadable or oversized.

    Unreadable is silent -- a missing file is the documented first run on the
    seed side and no rotation at all on the persist side, and neither is worth
    a warning. Oversized is warned, in the caller's words.

    Args:
        guard_symlink: True from :func:`persist_watchlist` alone. That call
            reads ``path`` back out of a workdir :func:`own_workdir` has
            chowned to the turn's own user, so it is read through
            :func:`_open_regular` rather than a bare ``open``; the seed side
            reads the operator's own file, never touched by the turn, and has
            no need of the check.
    """
    try:
        if guard_symlink:
            with _open_regular(path) as f:
                data = f.read(MAX_WATCHLIST_BYTES + 1)
        else:
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

    A directory the loop cannot write into -- a misconfigured mount, a full
    filesystem -- is a warning and not a failure. Losing a cursor is not a
    reason to fail a filing that already reached the glass.
    """
    path = os.path.join(workdir, WATCHLIST_NAME)
    data = _read_watchlist(path, "the watch list came back too large to be "
                           "one; not kept", guard_symlink=True)
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
        # The loop is root inside the container and this file is the operator's,
        # on a mount they own. Carry the owner across rather than leaving them a
        # root-owned watch list after the first rotation advance. Best effort:
        # on a host where the loop is not root this is a no-op that raises, and
        # a cursor is not worth failing a filing over.
        try:
            before = os.stat(cfg.watchlist)
            os.chown(tmp, before.st_uid, before.st_gid)
        except OSError:
            pass
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


def _seed_json(doc, workdir: str, name: str, cap: int, what: str) -> bool:
    """Write one document the desk answered with into the edition directory.

    Returns:
        True if a file was written, False if it was too large to hand to a
        model. :func:`seed_watchlist`'s two answers exactly, for the same two
        reasons, in the caller's words.

    Spelled the way ``fsutil.json_bytes`` spells every document on the desk --
    two-space indent, ``ensure_ascii`` off, one trailing newline -- because
    that is what these files look like everywhere else they are read, and
    because ``\\uc0bc\\uc131`` is not a company name anybody, model included,
    can read.
    """
    data = (json.dumps(doc, indent=2, ensure_ascii=False) + "\n").encode("utf-8")
    if len(data) > cap:
        LOG.warning("%s is %d bytes, past the %d this worker will put in front "
                    "of a model; not seeded", what, len(data), cap)
        return False
    with open(os.path.join(workdir, name), "wb") as f:
        f.write(data)
    return True


def seed_positions(desk: DeskClient, workdir: str) -> bool:
    """Put what the owner holds in the edition directory. **Calendar runs only.**

    Returns:
        True if a file was written, False if the owner has filed no positions
        yet -- the documented first run, exactly as a missing watch list is,
        and not an error. ``CALENDAR.md`` then has a run with nothing to
        annotate against, which is a book of ten events that reach nothing and
        a ``shortfall`` sentence saying so.

    Raises:
        RuntimeError: the desk would not answer. Not the same case at all --
            see :meth:`deskclient.DeskClient.positions`.

    **That this function is called from one branch of :func:`handle` and one
    only is a security property, not a tidiness one.** ``GET /news.json`` is
    served with no authorization, because the board on the wall polls it. So
    the one catastrophic outcome of this feature is a strike, a contract count
    or an entry price reaching an edition, at a public URL, permanently. The
    edition validator refuses a payload carrying position fields and that is
    the other half; this half is the stronger one, because **the process that
    writes the newspaper never has the file at all.** A sentence in a prompt
    is not a defence and neither of these two is sufficient alone.
    """
    doc = desk.positions()
    if doc is None:
        LOG.warning("the desk holds no positions; the book has nothing to "
                    "annotate against")
        return False
    LOG.info("positions: %d held", len(doc.get("positions") or []))
    return _seed_json(doc, workdir, POSITIONS_NAME, MAX_POSITIONS_BYTES,
                      "the book of positions")


def seed_calendar(desk: DeskClient, workdir: str) -> bool:
    """Put yesterday's event book in the edition directory, to be revised.

    Returns:
        True if a file was written, False when there is no book yet -- the
        first morning, or the morning after a closed position took the whole
        of one down.

    Raises:
        RuntimeError: the desk would not answer.

    Revised rather than rewritten, and the reason is on the owner's lock
    screen rather than in the file: ``CALENDAR.md`` requires an event that was
    already in the book to keep its id, because the desk records a
    notification against that id. A run that re-mints ids pushes a second
    time about every date the owner has already been told about, and a book
    seeded from nothing is a run that can only re-mint.
    """
    doc = desk.calendar()
    if doc is None:
        LOG.info("no book yet; this run writes the first one")
        return False
    LOG.info("yesterday's book: %d event(s)", len(doc.get("events") or []))
    return _seed_json(doc, workdir, CALENDAR_NAME, MAX_CALENDAR_BYTES,
                      "yesterday's book")


def seed_econ(desk: DeskClient, workdir: str,
              today: datetime.date | None = None) -> bool:
    """Put the economic window the desk fetched in the edition directory.

    Args:
        desk: the control plane.
        workdir: the edition directory.
        today: the first day of the window; the current UTC date by default.
            An argument so that the window a run asked for is a thing a test
            can state rather than a thing it has to be run on the right day to
            see.

    Returns:
        True if a file was written, False when the desk could not be asked --
        which is a warning and not a failure, because the desk is going
        outside for this one and a scraper having a bad afternoon is not a
        reason to skip a morning's book. See
        :meth:`deskclient.DeskClient.econ` for the line between this document
        and the two above it.

    The window is written under the name ``CALENDAR.md``'s input table gives
    it, and it carries its own bounds: an empty ``events`` beside a stated
    ``from`` and ``to`` says "this fortnight is quiet", where a bare empty
    list says nothing and a missing file says less.
    """
    day = today or datetime.datetime.now(datetime.timezone.utc).date()
    to_day = day + datetime.timedelta(days=ECON_WINDOW_DAYS)
    events = desk.econ(day.isoformat(), to_day.isoformat())
    if events is None:
        return False
    LOG.info("the economic window %s..%s: %d release(s)",
             day.isoformat(), to_day.isoformat(), len(events))
    return _seed_json({"from": day.isoformat(), "to": to_day.isoformat(),
                       "events": events},
                      workdir, ECON_NAME, MAX_ECON_BYTES,
                      "the economic window")


def _current_tile_ids(doc) -> list[str]:
    """Every tile the served edition can ask for: the photographs and the thumbs.

    The same two places ``tools/mock_news_server.py``'s ``_tile_problems``
    looks, and an id that is not one is dropped here rather than fetched: it
    becomes a URL and then a filename.
    """
    ids = []
    if not isinstance(doc, dict):
        return ids
    for story in doc.get("stories") or []:
        if not isinstance(story, dict):
            continue
        photo = story.get("photo")
        tid = photo.get("id") if isinstance(photo, dict) else None
        if isinstance(tid, str) and TILE_ID_RE.match(tid):
            ids.append(tid)
    for thumb in doc.get("thumbs") or []:
        if not isinstance(thumb, dict):
            continue
        tid = thumb.get("id")
        if isinstance(tid, str) and TILE_ID_RE.match(tid):
            ids.append(tid)
    return sorted(set(ids))


def seed_current(desk: DeskClient, workdir: str) -> bool:
    """Put the edition the desk is serving now in the workdir. **`ask` runs only.**

    Returns:
        True if the paper was written, False when the desk is serving none --
        the documented first run, exactly as a missing watch list is. A message
        is still answerable then ("what is EPS"); what is not possible is a
        revision, because the prompt's rule 3 revises by copying a file that is
        not there.

    Raises:
        RuntimeError: the desk answered with something that is not an edition.
            A precondition rather than an enrichment, and the line is the same
            one :meth:`deskclient.DeskClient.positions` draws: a run that
            rewrote the paper while it could not read the paper would replace a
            good edition with one written from nothing.

    Fetched off the **public** plane, with no token on the request. That is not
    a shortcut around the control plane -- it is the same bytes the board reads,
    which is what the message is about.
    """
    raw = desk.fetch_public("/news.json")
    if raw is None:
        LOG.info("the desk is serving no edition yet; this message is about a "
                 "paper that does not exist")
        return False
    if len(raw) > MAX_PUBLIC_PAYLOAD_BYTES:
        raise RuntimeError("the served edition is %d bytes, past the %d a payload "
                           "may be" % (len(raw), MAX_PUBLIC_PAYLOAD_BYTES))
    try:
        doc = json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError) as e:
        raise RuntimeError("the desk served an edition that is not JSON: %s" % e)

    into = os.path.join(workdir, CURRENT_DIR)
    os.makedirs(os.path.join(into, "tiles"), exist_ok=True)
    with open(os.path.join(into, "news.json"), "wb") as f:
        f.write(raw)

    kept = 0
    for tid in _current_tile_ids(doc):
        path = "/tiles/%s.bin" % tid
        try:
            data = desk.fetch_public(path)
        except RuntimeError as e:
            LOG.warning("could not fetch %s: %s", path, e)
            continue
        if data is None:
            LOG.warning("the edition names %s and the desk does not hold it", path)
            continue
        if len(data) > MAX_PUBLIC_TILE_BYTES:
            LOG.warning("%s is %d bytes; not seeded", path, len(data))
            continue
        with open(os.path.join(into, "tiles", tid + ".bin"), "wb") as f:
            f.write(data)
        kept += 1

    LOG.info("the current edition: %d bytes and %d tile(s)", len(raw), kept)
    return True


def seed_previous(desk: DeskClient, workdir: str, reply_to: str) -> bool:
    """Put the turn this message answers in the workdir. **`ask` runs only.**

    Returns:
        True if a file was written, False when the earlier turn could not be
        read at all -- including a ``reply_to`` that is not a command id,
        which :meth:`deskclient.DeskClient.command` refuses with a
        ``ValueError`` before it ever becomes a URL.

    An **enrichment**, not a precondition -- :meth:`deskclient.DeskClient.directives`'
    posture rather than :meth:`positions`'. Losing the earlier turn costs the
    conversation, not the answer: the message itself is still in the prompt, so
    the worst case is a reply that does not remember rather than a command that
    fails. That is also why a malformed ``reply_to`` is folded into the same
    outcome rather than checked here first: this file carries no id pattern of
    its own -- ``deskclient.DESK_ID_RE`` is the one rule for what a command id
    looks like, and :meth:`command`/:meth:`command_notes` already enforce it,
    as a ``ValueError``, before either call reaches a URL.

    One turn back, not the thread. The desk keeps every turn and the phone shows
    them; what the prompt gets is the one that this message is a follow-up to.
    """
    try:
        row = desk.command(reply_to)
        answer = desk.command_notes(reply_to)
    except (RuntimeError, ValueError) as e:
        LOG.warning("could not read the turn before this one (%s); answering "
                    "without it", e)
        return False
    text = "".join([
        "# The turn before this one\n\n",
        "## What was asked\n\n%s\n" % (row.get("text") or "(nothing was recorded)"),
        "\n## What you answered\n\n%s\n" % (answer or "(no answer was filed)"),
    ])
    with open(os.path.join(workdir, PREVIOUS_NAME), "w", encoding="utf-8") as f:
        f.write(text)
    return True


def upload_calendar(desk: DeskClient, workdir: str) -> dict:
    """File the event book the run wrote -- and refuse a run that wrote a page.

    Returns:
        The book, parsed, so the caller can say how many events were in it
        without reading the file a second time.

    Raises:
        RuntimeError: the run wrote a ``news.json``; or it wrote no book; or
            what it wrote is not a book. :func:`main` turns any of them into a
            failed command with the message on it.

    **The first check is the load-bearing one and it comes first on purpose.**
    A calendar run is the one turn in this system holding the owner's
    positions, and ``news.json`` is the one file served with no authorization
    at all. So a book is never read, let alone uploaded, until the directory
    has been shown not to hold a page: the refusal is structural, in the
    loop, rather than a sentence in a prompt asking a model not to.

    The page is left where it lies rather than deleted. It reaches nobody --
    nothing on this path opens a draft, so there is no route from that file to
    the desk, let alone to the wall -- and it is the evidence somebody needs
    to work out why the command failed.

    Everything after that first check is the early half of "fail loudly rather
    than upload something the desk will refuse". The desk owns the only
    validator and its refusal names the field; what is checked here is only
    what would otherwise be reported as an unexplained 400 -- a book that is
    not JSON, or is not a book.
    """
    page = os.path.join(workdir, "news.json")
    if os.path.exists(page):
        raise RuntimeError(
            "a calendar run wrote news.json; refusing to file it. That file is "
            "served with no authorization and this run held the positions -- "
            "the page is at %s and was not uploaded" % page)

    path = os.path.join(workdir, CALENDAR_NAME)
    try:
        with _open_regular(path) as f:
            data = f.read(MAX_CALENDAR_BYTES + 1)
    except OSError:
        raise RuntimeError("no calendar.json was produced") from None
    if len(data) > MAX_CALENDAR_BYTES:
        raise RuntimeError("the book is larger than the %d bytes the desk "
                           "will take" % MAX_CALENDAR_BYTES)
    try:
        doc = json.loads(data.decode("utf-8"))
    except (ValueError, UnicodeDecodeError) as e:
        raise RuntimeError("the book is not readable JSON: %s" % e) from None
    if not isinstance(doc, dict) or not isinstance(doc.get("events"), list):
        raise RuntimeError("the book carries no events")

    # The bytes rather than the parse: what the desk judges must be what the
    # run wrote, and a re-serialisation is a second spelling of it.
    desk.put_calendar(data)
    LOG.info("the book: %d event(s), shortfall %s", len(doc["events"]),
             "noted" if doc.get("shortfall") else "none")
    return doc


def write_brief(cfg: Settings, day: str, command: dict, result: dict, note: str,
                book: dict | None = None) -> None:
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

    ``book`` is the event book a calendar run filed, and what it adds is one
    line: how many events cleared the floor, and the ``shortfall`` sentence
    when fewer than ten did. That is the whole record of what a calendar run
    produced -- there is no ``edition_id`` on this path and the model's own
    ``notes.md`` says what it looked at rather than what it filed -- and the
    count over a week is the only place a book quietly shrinking from ten to
    four is visible at all.

    The sentence goes in whole, and so does it everywhere else it goes: it is
    the producer's own prose about its own run, which is the same material as
    the note beside it, and the desk serves it whole at ``GET /api/calendar``
    and in ``/api/state``. It is not what :func:`~claudepost.positions.save`
    is 0600 for -- that is the owner's holdings, which live in one file and are
    copied nowhere. The one place this text is deliberately not repeated is the
    desk's audit log, and that is a statement about what an audit row is rather
    than about this sentence.
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
            if book is not None:
                shortfall = book.get("shortfall")
                f.write("**Book:** %d event(s), shortfall: %s\n\n"
                        % (len(book.get("events") or []),
                           str(shortfall)[:400] if shortfall else "none"))
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
    - ``"calendar"`` is the exception to the paragraph above: it **does**
      decide alone, and every one of the three sentences after this one is a
      consequence of that. It is the other job -- an event book about what
      the owner holds, read on a phone, printed nowhere -- so it reads
      ``CALENDAR.md`` instead of ``PROMPT.md``, it is seeded with what the
      owner holds, it uploads ``calendar.json`` and it never opens a draft.
      Trusting the disk here the way ``custom`` does would mean a run that
      wrote a ``news.json`` got its page filed; on this one path that file
      would be an edition written by the one turn holding the owner's option
      positions, published at a URL with no authorization on it. So the disk
      is consulted and the answer is a refusal -- see :func:`upload_calendar`.
    - ``"ask"`` is a message from the phone, and it decides the way ``custom``
      does -- from the disk. It is seeded with the edition the desk is serving
      and with one turn of the conversation behind it; its ``answer.md`` is
      required whatever else the turn produced, because somebody is waiting for
      a reply and a page is not a reply; and a ``news.json`` beside it means
      the model judged that the message asked for the paper to change. That
      judgement is the model's, per the design, and this loop does not
      second-guess it.
    - ``"paper"`` is ``"file_edition"`` with the company already chosen, and
      it is that path rather than a fourth branch: the same contract, the same
      draft, the same proof, the same two revisions, the same look at the
      sheets. Three things differ and nothing else does. The prompt names the
      symbol and says the contract's rotation does not apply; the rotation file
      is neither seeded nor persisted, because the cursor belongs to the
      board's morning edition and there are more paper runs in a day than
      editions; and the commit says which company it is filing under, which is
      the wall -- the desk refuses a draft whose subject is somebody else.
    """
    cid = command["id"]
    kind = command.get("kind", "file_edition")
    calendar = kind == CALENDAR_KIND
    ask = kind == ASK_KIND
    paper = kind == PAPER_KIND
    symbol = command.get("symbol") if paper else None
    # `isinstance` rather than `str()`: a JSON number under that key is a
    # malformed command, and `str(7)` is "7", which matches the pattern below
    # and would file a paper for a company called 7.
    symbol = symbol.strip().upper() if isinstance(symbol, str) else None
    if paper and not (symbol and PAPER_SYMBOL_RE.match(symbol)):
        # Before the workdir and before the turn, because the whole of a paper
        # run is "write about this company". A command that does not say which
        # would otherwise spend forty minutes researching a company the model
        # picked for itself, and then be refused at the commit for filing it
        # under a name that does not match -- a failure that costs the same as
        # the work.
        #
        # Upper-cased once, here, so the prompt and the commit body cannot
        # disagree: the desk sends uppercase and this is for a command posted
        # by hand.
        desk.finish(cid, False, "a paper command must name the company it is "
                                "for; symbol was %r" % (command.get("symbol"),))
        return
    workdir = os.path.join(cfg.scratch, cid)
    shutil.rmtree(workdir, ignore_errors=True)
    # No ``tiles/`` on the calendar path. Nothing would ever upload one, so an
    # empty directory named for pictures is a standing invitation to spend a
    # research budget making them.
    os.makedirs(workdir if calendar else os.path.join(workdir, "tiles"),
                exist_ok=True)
    if not paper:
        # Not on the paper path: the company is already chosen, so the file has
        # nothing to offer this turn and one thing to cost it. The cursor in it
        # is the *board's* rotation, read by tomorrow's morning order, and a
        # model handed a file the contract tells it to update will update it.
        # At the default cadence there are more paper runs in a day than
        # editions, so the board would skip a company every night.
        seed_watchlist(cfg, workdir)
    if calendar:
        # In this order and before the turn, so that a desk that cannot say
        # what the owner holds fails the command here rather than after
        # forty-five minutes of research against nothing.
        seed_positions(desk, workdir)
        seed_calendar(desk, workdir)
        seed_econ(desk, workdir)

    if ask:
        # Before the turn, and in this order: the paper the message is about,
        # then the turn it answers. The first is a precondition -- a desk that
        # cannot say what it is serving fails here rather than after a revision
        # written from nothing -- and the second is not.
        seed_current(desk, workdir)
        if command.get("reply_to"):
            seed_previous(desk, workdir, command["reply_to"])
    # Last, after every seeded file is on disk: the model owns this directory
    # for the length of the turn, and one of the files it is handed is a watch
    # list the contract asks it to rewrite in place.
    own_workdir(cfg, workdir)

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
        read_contract(cfg.repo, kind),
        prompt.read_context_dir(cfg.context_dir),
        desk.directives(),
        command.get("text", ""),
        kind=kind,
        lang=desk.settings().get("lang", "en"),
        ask_lang=command.get("lang"),
        symbol=symbol)
    status = run_claude(cfg, text, workdir, agent_env, kind)
    if status != 0:
        desk.finish(cid, False, "claude exited %d" % status)
        return

    if kind == "research":
        note_on_command()
        return

    if calendar:
        book = upload_calendar(desk, workdir)
        # The note goes on the command for :func:`note_on_command`'s reason --
        # there is no draft to attach it to -- but the command's *result* is
        # the book rather than the note, because on this path the note is the
        # dossier behind a book that has already been filed and can be read.
        file_notes(desk, workdir, command=cid)
        write_brief(cfg, time.strftime("%Y-%m-%d"), command, {"state": "filed"},
                    read_notes(workdir) or "", book=book)
        # The count and the shortfall *sentence*, which is the operator's
        # answer to "how did the book go" and is no use as a boolean -- "there
        # was a shortfall" is the half of the news that cannot be acted on.
        #
        # An earlier version withheld it, on the grounds that a shortfall may
        # name a holding. It buys nothing, and the two lines above are why: the
        # same turn has just filed the model's whole dossier as a note, and the
        # desk serves this sentence in full at `GET /api/calendar` and again in
        # `/api/state` -- the same response that carries this result. What is
        # kept out of the desk's *audit* line is kept out for a different
        # reason, one about what an audit row is (see `h_put_calendar`), and
        # borrowing that reason here made a rule out of a coincidence.
        shortfall = book.get("shortfall")
        desk.finish(cid, True, "the book: %d event(s)%s" % (
            len(book["events"]), ". %s" % shortfall if shortfall else ""))
        return

    answer = None
    if ask:
        answer = read_answer(workdir)
        if not answer:
            # Whatever else it produced. Somebody is waiting for a reply and a
            # page is not a reply -- and a page filed with no answer beside it
            # would change the paper on the wall with nobody told why.
            desk.finish(cid, False, "no answer written")
            return
        if not os.path.exists(os.path.join(workdir, "news.json")):
            put_notes_best_effort(desk, answer, command=cid)
            desk.finish(cid, True, "answered")
            return
        # Otherwise the message asked for the paper to change, and the rest of
        # this function is exactly the path a morning edition takes: the same
        # five gates, the same two revisions, the same look at the sheets. A
        # revised edition that does not typeset fails the command and leaves
        # the current one standing -- the firmware's own failure semantics.
        #
        # One thing goes ahead of it: an edition must not be filed with nothing
        # beside it saying why it changed, and the reply is that account when
        # the turn wrote no dossier of its own. Here rather than beside the
        # commit, because the desk reads a draft's note *inside* commit.
        answer_as_notes(workdir, answer)

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

    # Keyword arguments through a dict rather than a branch with two calls in
    # it: every other kind must keep sending the body it has always sent, and
    # two call sites is two places for that to stop being true.
    result = desk.commit(draft, **({"target": PAPER_TARGET, "symbol": symbol}
                                   if paper else {}))
    LOG.info("committed %s: %s", result.get("edition_id"), result.get("state"))
    if not ask and not paper:
        # After the commit and not before: a rotation that advanced past a
        # company whose page never reached the desk skips it for a whole
        # cycle. Not on this path for an `ask`: the file in the workdir is
        # seeded so the same prompt can be shared, not because a revision
        # from the phone is the rotation's business, and moving the cursor
        # here would advance tomorrow's edition past whatever company the
        # phone happened to be asking about.
        #
        # Nor on the paper path, for the other half of the same reason: that
        # run was never given the file, so what would come back is whatever a
        # model wrote into a name that happened to be free.
        persist_watchlist(cfg, workdir)
    write_brief(cfg, time.strftime("%Y-%m-%d"), command, result,
                report.get("validate", ""))

    if ask:
        # Re-read: the revision and look turns may have rewritten the reply
        # along with the page, and what goes to the person is what the run
        # finished believing rather than its first draft.
        answer = read_answer(workdir) or answer
        # The command: that is where the phone reads the answer, and before the
        # finish that pushes to it. The draft already has its note -- put there
        # by :func:`upload`, from the file :func:`answer_as_notes` wrote before
        # the first one was ever opened.
        put_notes_best_effort(desk, answer, command=cid)
        state = ASK_STATES.get(result.get("state"), result.get("state") or "revised")
        desk.finish(cid, True, "%s %s" % (state, result.get("edition_id")))
        return

    desk.finish(cid, True, "%s %s" % (result.get("state"), result.get("edition_id")))


def main() -> int:
    """Claim, handle, repeat -- forever, and through a desk that is not there yet."""
    cfg = Settings.from_env(os.environ)
    logging.basicConfig(
        level=cfg.log_level,
        format="%(asctime)s %(levelname)s %(name)s %(message)s")

    if cfg.run_as and os.geteuid() != 0:
        # Not a warning: a loop that cannot switch user would run the model as
        # itself, with the desk token in its own environment, and file paper
        # perfectly while the wall this setting names was never there.
        LOG.error("AGENT_RUN_AS=%s, but this loop is uid %d rather than root. "
                  "gosu is not setuid and no-new-privileges is set, so only "
                  "root can hand a turn to another user. Unset AGENT_RUN_AS to "
                  "run the model as this user instead.", cfg.run_as, os.geteuid())
        return 2
    if not cfg.run_as and os.geteuid() == 0:
        # The symmetric case: a loop running as root with nobody to hand the
        # turn to runs the model as root with the desk token in its own
        # environment -- it files paper perfectly and the wall this setting
        # names was never there. Set AGENT_RUN_AS, or run this loop as an
        # ordinary user.
        LOG.error("this loop is uid 0 but AGENT_RUN_AS is unset, so every "
                  "turn would run as root with this loop's own environment -- "
                  "the desk token included. Set AGENT_RUN_AS to a user the "
                  "image has, or run this loop as an ordinary user instead of "
                  "root.")
        return 2

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
