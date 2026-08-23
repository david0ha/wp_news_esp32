"""The bridge to the owner's vault -- and the reason serving does not need it.

The private half of this desk lives in somebody's Obsidian vault on an external
SSD: the standing instructions, the blocklist, the rotation, the schedule, and
the briefs saying what was filed and why. One subdirectory of it is mounted
here, never the whole thing, because this container answers the internet and a
vault is somebody's whole second brain.

**The SSD can be unplugged, and nothing in this module may notice loudly.**
Every read falls back, every write is best effort, and none of them raise. That
is the entire point: the board polls one URL, the URL is served from ``/data``,
and pulling a disk out of a laptop must not be able to blank a newspaper
hanging on a wall. What is lost while the disk is out is the *agent's* ability
to file, which is a filing that does not happen -- not a page that goes away.
The condition is logged once when it changes rather than once per poll, because
a warning printed every fifteen seconds is a warning nobody reads.

**Each file has exactly one writer.**

===================  ==================================================
``standing.md``      the owner, in Obsidian. The desk only reads it.
``blocklist.md``     the owner, in Obsidian. The desk only reads it.
``watchlist.json``   the owner, in Obsidian. The desk only reads it.
``schedule.json``    the owner *or* ``PUT /api/schedule`` -- the same file
                     either way, which is what keeps them from disagreeing.
``schedule.errors.md``  this module, and only when the schedule will not parse.
``briefs/<date>.md``    whoever filed the edition, appended a section at a time.
``archive/<id>/``       this module.
===================  ==================================================

``schedule.json`` in the vault is **authoritative**. ``save_schedule()`` writes
it *and* the cache under ``/data``; ``load_schedule()`` prefers the vault, falls
back to the cache -- which is by construction the last schedule that parsed --
and falls back again to :data:`~.schedule.DEFAULT_SCHEDULE`. The database is
never a second source of truth for any of this, because two places holding one
answer is how the answer starts depending on which one you asked.

A ``schedule.json`` that does not validate leaves the previous schedule in force
and writes ``schedule.errors.md`` beside it naming the offending field.
Silently ignoring a bad edit is how somebody spends a week wondering why 06:00
does nothing.

Every write goes through a temporary file in the same directory and
``os.replace``, because this is removable media: a half-written schedule read at
the next tick is a schedule nobody wrote. The one exception is a brief, which is
appended rather than replaced and says why in its own docstring.
"""

from __future__ import annotations

import errno
import json
import logging
import os
import re
import shutil
import tempfile

from .clock import Clock
from .errors import BadRequest
from .schedule import DEFAULT_SCHEDULE, Schedule, parse_schedule, schedule_to_dict

LOG = logging.getLogger("wpdesk.vault")

#: The files the owner authors and the desk reads. Names, not paths: everything
#: here is resolved against the one mounted subdirectory and nothing else.
SCHEDULE_FILE = "schedule.json"
STANDING_FILE = "standing.md"
BLOCKLIST_FILE = "blocklist.md"
WATCHLIST_FILE = "watchlist.json"
ERRORS_FILE = "schedule.errors.md"
README_FILE = "README.md"

BRIEFS_DIR = "briefs"
ARCHIVE_DIR = "archive"

#: What ``poll()`` watches. The errors file is excluded deliberately -- this
#: module writes it, and watching one's own output is a loop.
WATCHED_FILES: tuple[str, ...] = (SCHEDULE_FILE, STANDING_FILE,
                                  BLOCKLIST_FILE, WATCHLIST_FILE)

#: How much of a vault file is allowed to reach a prompt or a brief. Sixty-four
#: kilobytes is far more standing instruction than anybody writes; the cap is
#: here because a file on a disk somebody else edits has no length the desk
#: knows, and a runaway one would be read into memory and then into a model.
MAX_TEXT_BYTES = 64 * 1024

#: A brief is filed under a date, and the date becomes a path component.
_DAY_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

#: An edition id, likewise. Leading alphanumeric, so ``.`` and ``..`` are
#: refused by the shape rather than by a special case.
_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")

#: A vault file name a caller may ask for by name. No separators at all: the
#: desk reads flat files out of one directory, and every path this module builds
#: is built from a constant above or from a name that passed this.
_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")

_README_TEXT = """# The desk's half of your vault

The desk reads this directory and writes only what is marked below. It creates
anything missing on start and **never overwrites a file you wrote**, so editing
any of these in Obsidian is the supported way to change what the paper does.

| File | Who writes it |
|---|---|
| `standing.md` | you — your standing editorial instructions |
| `blocklist.md` | you — what must never print |
| `watchlist.json` | you — the rotation |
| `schedule.json` | you, or `PUT /api/schedule`. The same file either way |
| `schedule.errors.md` | the desk, and only when `schedule.json` will not parse |
| `briefs/<date>.md` | the worker — what it filed and why |
| `archive/<id>/` | the desk — filed editions and their proof sheets |

Serving does not depend on any of it. If this disk is unplugged the board keeps
receiving the last edition; what stops is the agent's ability to file a new one.
"""

_STANDING_TEXT = """# Standing instructions

Whatever you write here is put in front of the agent on every run, before the
day's command. It is the place for the things that are true every day rather
than the things that are true today.

Write it as prose. Some examples of the kind of thing that belongs here:

- which market's session the edition should be about
- how much of the front page you want spent on accounts rather than on the story
- a house style you keep having to correct

This file ships empty of anything but this note, because it is the one file in
the repository that would otherwise carry somebody's opinions.
"""

_BLOCKLIST_TEXT = """# Never print these

One per line, with a reason if you want one later. This is the same store as a
directive with `scope: always`, kept as its own file because "what must never
print" is the one list worth being able to read at a glance.

- (nothing yet)
"""

_WATCHLIST_TEXT = """{
  "_shape": {
    "symbols": [
      {"symbol": "TICKER", "exchange": "NASDAQ", "note": "why it is on the list"}
    ]
  },
  "symbols": []
}
"""


def _atomic_write(path: str, data: bytes) -> None:
    """Replace ``path`` with ``data``, or leave the previous file untouched.

    A temporary file in the same directory, ``fsync``, then ``os.replace`` --
    which is atomic within a filesystem. The directory is synced afterwards so
    the rename itself survives, because this is removable media and the failure
    being defended against is not a crash but a disk that stops existing
    mid-write.
    """
    directory = os.path.dirname(path) or "."
    fd, tmp = tempfile.mkstemp(dir=directory, prefix=".wpdesk-", suffix=".tmp")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    _fsync_dir(directory)


def _fsync_dir(path: str) -> None:
    """Flush a directory entry. Best effort: not every filesystem allows it."""
    try:
        fd = os.open(path, os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(fd)
    except OSError:
        pass                    # some filesystems refuse; the replace still held
    finally:
        os.close(fd)


def _safe_name(name: str, what: str, pattern: re.Pattern = _NAME_RE) -> str:
    """Return ``name`` if it can only ever be one entry in one directory.

    This raises where the rest of the module swallows, and the difference is
    deliberate: a missing vault is the world being the way it is, while a name
    carrying ``..`` is a caller doing something no correct caller does. The
    second must not be answered with an empty string that looks like an absent
    file.
    """
    if not isinstance(name, str) or not pattern.match(name):
        raise BadRequest("bad_name", f"{what} {name!r} is not a name this vault has")
    return name


class Vault:
    """The mounted subdirectory of the owner's vault, and what may be done to it.

    Args:
        root: the one mounted subdirectory -- never the vault itself.
        cache_path: ``schedule.cache.json`` under the serving root, which is the
            copy that keeps the desk running when ``root`` is not there.
        clock: the desk's clock, used for pruning and for stamping error files.
    """

    def __init__(self, root: str, cache_path: str, clock: Clock) -> None:
        self.root = root
        self.cache_path = cache_path
        self.clock = clock
        # Availability is remembered so the transition can be logged rather than
        # the condition, and the mtime snapshot so poll() has something to
        # compare against on its very first call.
        self._was_available = os.path.isdir(root)
        self._seen = self._snapshot()

    # ----------------------------------------------------------------- state

    def available(self) -> bool:
        """Whether the vault is mounted right now.

        Logs once on each transition -- loudly when it goes, quietly when it
        comes back -- because the disk being out is a condition that can last
        days and a line per poll would bury everything else in the log.
        """
        now = os.path.isdir(self.root)
        if now != self._was_available:
            if now:
                LOG.info("vault is back: %s", self.root)
            else:
                LOG.warning("vault is gone: %s -- serving continues from the cache, "
                            "but nothing can be filed until it returns", self.root)
            self._was_available = now
        return now

    def poll(self) -> bool:
        """Whether any watched file has changed since the last call.

        Compares ``(mtime_ns, size)`` rather than content, which is what makes
        this cheap enough to run every fifteen seconds against a disk that may
        be spun down. A file that appears or disappears is a change, and so is
        the vault itself appearing, because a returning disk is exactly when
        the desk needs to re-read everything.
        """
        snap = self._snapshot()
        changed = snap != self._seen
        self._seen = snap
        return changed

    def _snapshot(self) -> dict:
        """Stat every watched file, tolerating all of them being absent."""
        snap: dict = {"": os.path.isdir(self.root)}
        for name in WATCHED_FILES:
            try:
                st = os.stat(os.path.join(self.root, name))
            except OSError:
                snap[name] = None
            else:
                snap[name] = (st.st_mtime_ns, st.st_size)
        return snap

    # ---------------------------------------------------------------- layout

    def ensure_layout(self) -> None:
        """Create anything missing, and change nothing that exists.

        Run at every desk start, so the rule is absolute: a file that is already
        there is left exactly as it is. A start that quietly replaced somebody's
        ``standing.md`` with a template would be both unforgivable and
        undetectable -- the owner would find out weeks later, from a paper that
        stopped sounding like theirs.

        The root itself is created only when its *parent* already exists. If the
        SSD is not mounted, the path's parents are missing too, and manufacturing
        the tree would leave an empty vault on the internal disk that looks
        exactly like a real one -- and that the real one would then hide when it
        came back.
        """
        try:
            if not os.path.isdir(self.root):
                parent = os.path.dirname(os.path.abspath(self.root))
                if not os.path.isdir(parent):
                    LOG.warning("vault root %s has no parent directory; "
                                "leaving the layout alone", self.root)
                    return
                os.mkdir(self.root)

            for name in (BRIEFS_DIR, ARCHIVE_DIR):
                os.makedirs(os.path.join(self.root, name), exist_ok=True)

            defaults = (
                (README_FILE, _README_TEXT),
                (STANDING_FILE, _STANDING_TEXT),
                (BLOCKLIST_FILE, _BLOCKLIST_TEXT),
                (WATCHLIST_FILE, _WATCHLIST_TEXT),
                (SCHEDULE_FILE, _schedule_json(DEFAULT_SCHEDULE)),
            )
            for name, text in defaults:
                path = os.path.join(self.root, name)
                if os.path.exists(path):
                    continue
                _atomic_write(path, text.encode("utf-8"))
                LOG.info("created %s", path)
        except OSError as exc:
            # The disk went away between the check and the write, or the mount
            # is read-only. Neither is a reason to fail a start that can serve.
            LOG.warning("could not lay out the vault at %s: %s", self.root, exc)
        finally:
            self._seen = self._snapshot()

    # -------------------------------------------------------------- schedule

    def load_schedule(self) -> tuple[Schedule, str]:
        """The schedule in force, and where it came from.

        Returns:
            ``(schedule, source)`` with source ``"vault"``, ``"cache"`` or
            ``"default"``. The vault is authoritative; the cache is the last
            schedule that parsed, which is what makes falling back to it the
            same thing as "the previous schedule stays in force"; the default
            is what a desk with neither runs on, and it is a complete schedule
            rather than a placeholder.

        Never raises. A vault file that will not parse is reported into
        ``schedule.errors.md`` and then ignored.
        """
        raw = self._read_bytes(SCHEDULE_FILE)
        if raw is not None:
            try:
                s = parse_schedule(json.loads(raw.decode("utf-8")))
            except (ValueError, UnicodeDecodeError) as exc:
                self._complain(f"{SCHEDULE_FILE} is not valid JSON: {exc}")
            except BadRequest as exc:
                self._complain(exc.message or str(exc))
            else:
                self._clear_complaint()
                # The cache is by definition the last schedule that parsed, so
                # this is the only honest moment to refresh it.
                self._write_cache(s)
                return s, "vault"

        cached = self._read_cache()
        if cached is not None:
            return cached, "cache"
        return DEFAULT_SCHEDULE, "default"

    def save_schedule(self, s: Schedule) -> None:
        """Write ``s`` to the vault and to the cache, in that order.

        The vault first: it is the file ``load_schedule`` believes, so a crash
        between the two writes loses nothing, while the other order would lose
        the whole edit. A vault that is not mounted is not an error here -- the
        schedule still takes effect from the cache, it simply cannot be written
        where a human would read it.

        A failure to write the cache *is* raised, because that is the serving
        root rather than the removable one, and an operator setting a schedule
        deserves to know it did not land.
        """
        text = _schedule_json(s)
        if self.available():
            try:
                _atomic_write(os.path.join(self.root, SCHEDULE_FILE),
                              text.encode("utf-8"))
                self._clear_complaint()
            except OSError as exc:
                LOG.warning("could not write %s to the vault: %s", SCHEDULE_FILE, exc)
        self._write_cache(s, force=True)
        # The desk wrote this, so the desk already knows: reporting its own
        # write from poll() would send it round to re-read what it just wrote.
        self._seen = self._snapshot()

    def _read_cache(self) -> Schedule | None:
        """The cached schedule, or ``None`` when there is not a usable one."""
        try:
            with open(self.cache_path, "rb") as f:
                return parse_schedule(json.loads(f.read().decode("utf-8")))
        except OSError:
            return None
        except (ValueError, UnicodeDecodeError, BadRequest) as exc:
            # Written by this module from a Schedule, so this cannot happen
            # without something else having edited it. Say so and move on.
            LOG.warning("the schedule cache at %s is unusable: %s", self.cache_path, exc)
            return None

    def _write_cache(self, s: Schedule, force: bool = False) -> None:
        """Refresh the cache, skipping a write that would change nothing.

        The skip is not an optimisation of disk traffic; it keeps the cache's
        mtime meaning "when the schedule last changed" instead of "when the desk
        last polled".
        """
        text = _schedule_json(s)
        if not force:
            try:
                with open(self.cache_path, "rb") as f:
                    if f.read().decode("utf-8") == text:
                        return
            except (OSError, UnicodeDecodeError):
                pass
        directory = os.path.dirname(self.cache_path) or "."
        os.makedirs(directory, exist_ok=True)
        _atomic_write(self.cache_path, text.encode("utf-8"))

    def _complain(self, why: str) -> None:
        """Write ``schedule.errors.md`` beside the file that would not parse.

        The message carries the JSON path :func:`~.schedule.parse_schedule`
        named, because the only reader of this file is the person who mistyped
        it and "invalid schedule" is not something anybody can act on.

        Rewritten only when the complaint itself changes: a file rewritten on
        every poll is a vault git repository with a commit's worth of churn per
        minute, and the owner would learn to ignore it.
        """
        LOG.warning("%s in the vault will not parse (%s); "
                    "the previous schedule stays in force", SCHEDULE_FILE, why)
        if not self.available():
            return
        path = os.path.join(self.root, ERRORS_FILE)
        body = (
            f"# {SCHEDULE_FILE} was not applied\n\n"
            f"```\n{why}\n```\n\n"
            f"The previous schedule is still in force. Fix the field named above\n"
            f"and save; the desk re-reads within fifteen seconds and deletes this\n"
            f"file once the schedule parses.\n"
        )
        try:
            with open(path, "rb") as f:
                if f.read().decode("utf-8", "replace") == body:
                    return
        except OSError:
            pass
        try:
            _atomic_write(path, body.encode("utf-8"))
        except OSError as exc:
            LOG.warning("could not write %s: %s", path, exc)

    def _clear_complaint(self) -> None:
        """Remove the error file. A complaint about a file that now parses lies."""
        try:
            os.unlink(os.path.join(self.root, ERRORS_FILE))
        except OSError as exc:
            if exc.errno != errno.ENOENT:
                LOG.warning("could not remove %s: %s", ERRORS_FILE, exc)

    # ------------------------------------------------------------------ text

    def read_text(self, name: str) -> str:
        """One vault file as text, or ``""`` when there is not one to read.

        Absent, unreadable and unmounted are all the same answer on purpose:
        every caller of this is assembling a prompt, and a prompt is either
        given the owner's instructions or given none. Truncated at
        :data:`MAX_TEXT_BYTES` with a visible marker rather than silently.

        Raises:
            BadRequest: ``name`` is not a plain file name in this directory.
        """
        _safe_name(name, "file")
        data = self._read_bytes(name, limit=MAX_TEXT_BYTES + 1)
        if data is None:
            return ""
        if len(data) > MAX_TEXT_BYTES:
            data = data[:MAX_TEXT_BYTES]
            return (data.decode("utf-8", "replace")
                    + f"\n\n<!-- truncated at {MAX_TEXT_BYTES} bytes -->\n")
        return data.decode("utf-8", "replace")

    def context(self) -> dict:
        """The three files an agent run is assembled from.

        Returns:
            ``{"standing": str, "blocklist": str, "watchlist": str}`` -- empty
            strings when the vault is not there. An agent that files without the
            owner's standing instructions is filing a worse page than one that
            waits, but that decision belongs to the worker, so this reports the
            absence rather than deciding on it.
        """
        return {"standing": self.read_text(STANDING_FILE),
                "blocklist": self.read_text(BLOCKLIST_FILE),
                "watchlist": self.read_text(WATCHLIST_FILE)}

    def _read_bytes(self, name: str, limit: int = MAX_TEXT_BYTES + 1) -> bytes | None:
        """Read a vault file, answering ``None`` for every way that can fail."""
        try:
            with open(os.path.join(self.root, name), "rb") as f:
                return f.read(limit)
        except OSError:
            return None

    def write_brief(self, day: str, text: str) -> str:
        """Append a section to ``briefs/<day>.md``. Returns the path, or ``""``.

        Appended rather than replaced, and this is the one write in the module
        that does not go through ``os.replace``. The reason is that this file
        has a second writer -- the worker container appends its own section
        after every filing -- and a read-modify-write would silently drop
        whichever section arrived while it was in memory. Losing prose nobody
        parses is a worse failure here than tearing a line in it, and an
        ``O_APPEND`` write of one section is the only primitive that cannot.

        Raises:
            BadRequest: ``day`` is not ``YYYY-MM-DD``. It becomes a file name.
        """
        _safe_name(day, "brief date", _DAY_RE)
        if not self.available():
            # Not merely futile: makedirs would build the vault's tree on
            # whatever disk is mounted where the missing one belongs, and the
            # real one would then hide it. See ensure_layout().
            LOG.warning("no brief for %s: the vault is not mounted", day)
            return ""
        path = os.path.join(self.root, BRIEFS_DIR, day + ".md")
        body = text[:MAX_TEXT_BYTES]
        if not body.endswith("\n"):
            body += "\n"
        try:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "a", encoding="utf-8") as f:
                f.write(body)
        except OSError as exc:
            LOG.warning("could not write the brief for %s: %s", day, exc)
            return ""
        return path

    # --------------------------------------------------------------- archive

    def archive(self, eid: str, src_dir: str) -> None:
        """Copy a published edition into ``archive/<eid>/``.

        A copy, not a move: the served edition stays under ``/data`` where the
        board can reach it, and this is the readable half -- the payload and the
        proof sheets, next to the brief that explains them.

        An id already archived is left exactly as it is. Editions are immutable
        under their id, so a second call has nothing new to write, and the owner
        may well have annotated the first copy by hand.

        Raises:
            BadRequest: ``eid`` is not an edition id.
        """
        _safe_name(eid, "edition id", _ID_RE)
        if not self.available():
            LOG.info("not archiving %s: the vault is not mounted", eid)
            return
        dest = os.path.join(self.root, ARCHIVE_DIR, eid)
        if os.path.exists(dest):
            return
        tmp = dest + ".partial"
        try:
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            shutil.rmtree(tmp, ignore_errors=True)
            shutil.copytree(src_dir, tmp)
            # The rename is what publishes it, so a copy interrupted by the disk
            # going away leaves a .partial nobody reads rather than half an
            # edition that looks whole.
            os.replace(tmp, dest)
            _fsync_dir(os.path.dirname(dest))
        except OSError as exc:
            LOG.warning("could not archive %s: %s", eid, exc)
            shutil.rmtree(tmp, ignore_errors=True)

    def prune_archive(self, days: int = 30) -> int:
        """Delete archived editions older than ``days``. Returns how many went.

        Age is the directory's own mtime, which ``archive()`` sets by writing
        it. The vault is a git repository somebody syncs, so an archive that
        grows without limit is somebody's disk quota rather than the desk's.
        """
        if not self.available():
            return 0
        base = os.path.join(self.root, ARCHIVE_DIR)
        cutoff = self.clock.now() - days * 86400
        gone = 0
        try:
            names = sorted(os.listdir(base))
        except OSError:
            return 0
        for name in names:
            path = os.path.join(base, name)
            try:
                if not os.path.isdir(path) or os.stat(path).st_mtime >= cutoff:
                    continue
                shutil.rmtree(path)
            except OSError as exc:
                LOG.warning("could not prune %s: %s", path, exc)
                continue
            gone += 1
        return gone


def _schedule_json(s: Schedule) -> str:
    """A schedule as the vault holds it: indented, sorted, newline-terminated.

    Formatted for a human with a text editor rather than for the wire, because
    every byte of this file exists to be read and edited by hand, and a diff in
    somebody's vault git history should show the line they changed.
    """
    return json.dumps(schedule_to_dict(s), indent=2, ensure_ascii=False) + "\n"
