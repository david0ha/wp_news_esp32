"""Drafts, the five gates, and the one rename that changes what the wall shows.

Two invariants hold this module up and everything else in it follows from one
of them.

**A draft that fails a gate leaves the current edition exactly as it was.**
Nothing outside ``drafts/<id>/`` is written until gate 1 and gate 2 have both
passed: no edition directory, no store row, no pointer. That is the rule
``news_parse()`` follows on the device, one layer up -- a rejected payload never
touches ``*out``, because a stale front page badged STALE beats an empty one.

**An edition directory never changes after it appears.** It is named by the
fingerprint of its own contents, assembled under ``editions/.build-*`` and
``os.replace``d into place whole, and deleted only by :meth:`EditionStore.prune`
and never while it is ``current`` or ``staged``. That is what lets a reader
resolve ``current`` and read the payload and every tile with **no lock at all**:
the pointer swap is a single ``os.replace``, so a reader sees either the old id
or the new one, and either names a directory that is entirely there.

The clock is injected and the times written into an edition come from it, never
from a file's mtime. A schedule reasons in wall time; ``st_mtime`` is whatever
the filesystem thought, and on a container with a mounted volume the two are
not the same conversation.

One desk process owns one data root. Two would race on the pointers, which are
files and not rows; the database is the part that is safe across processes and
that is ``store.py``'s business, not this module's.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import shutil
import tempfile
import threading
import time
import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Sequence
from zoneinfo import ZoneInfo

from . import notes, tiles
from .clock import Clock
from .errors import BadRequest, Conflict, Internal, NotFound
from .fsutil import atomic_write, fsync_dir, read_bytes
from .gates import Gates
from .policy import dropped_producer_policy
from .schedule import Schedule, is_quiet, next_wake, quiet_ends_at
from .store import Store

LOG = logging.getLogger("claudepost.editions")

#: The layout under the data root. Gate 1 appends ``news.json`` to a draft
#: directory itself and looks for ``tiles/`` beside it, so these names are the
#: validator's as much as they are ours.
DRAFTS_DIR = "drafts"
EDITIONS_DIR = "editions"
PAYLOAD_NAME = "news.json"
TILES_DIR = "tiles"
PROOF_DIR = "proof"
META_NAME = "meta.json"

#: The two pointers, each holding one edition id and a newline. They are the
#: whole of the desk's serving state: a restart reads them and serves what it
#: was serving, because a restart that blanked a wall would be a refresh nobody
#: asked for.
CURRENT = "current"
STAGED = "staged"

#: The draft's own birth certificate. ``opened_at`` is the desk's clock rather
#: than the directory's mtime, so a sweep measures the age the schedule would
#: agree with.
STAMP_NAME = "draft.json"

#: An edition being assembled. It cannot match :data:`_EID_RE`, which is what
#: makes it invisible to every reader here rather than something each of them
#: has to filter: a leftover from a crash is not an edition that half exists.
BUILD_PREFIX = ".build-"

#: How long an abandoned draft is kept. A producer that opened one and died
#: holds a slot against a limit of eight, and an hour is far longer than any
#: gate run.
DRAFT_TTL_SECONDS = 3600

#: Hex characters of sha256 kept as an edition id. Sixty-four bits is a
#: collision probability around 1e-16 across the few dozen editions ever kept,
#: and a short id is one a person can read back over a phone.
FINGERPRINT_HEX = 16

#: How much gate output is copied into ``meta.json``. The whole of it comes
#: back live from :meth:`EditionStore.proof` and from the refusal, so this copy
#: is the record rather than the report -- and ``list_editions(50)`` must not
#: carry six megabytes of render log.
MAX_META_OUTPUT = 2000

#: The field names that belong to the owner's book and may never appear in an
#: edition, at any depth. ``/news.json`` is served with **no authorization at
#: all** -- it has to be, because the board polls it over the open internet --
#: so a producer that reasons about a position and then quotes one of its
#: numbers into a story has published the owner's holdings to whoever asks.
#:
#: The three spellings that carry money or size are ``positions.py``'s
#: (``strike_cents``, ``entry_price_cents``, ``contracts``); ``positions`` and
#: ``legs`` are the containers they arrive in; ``position_id`` is
#: ``calendar.py``'s reference to one, which is not itself a number about the
#: owner but is the join that turns a public event into a private one.
#:
#: This is a blacklist and a blacklist is the weaker instrument -- see the note
#: on :func:`_refuse_position_fields`. It is a wall across the one door a
#: payload comes through, not a claim that every possible leak is named here.
FORBIDDEN_PAYLOAD_KEYS = frozenset((
    "strike_cents", "entry_price_cents", "contracts",
    "positions", "position_id", "legs",
))

#: Why an edition did not go up, or did. Each carries its own keyword and none
#: contains another's, because the HTTP layer hands these to a person and the
#: tests match on the word.
REASON_HOLD = "hold: nothing publishes until {t}"
REASON_QUIET = "quiet: nothing new becomes current until {t}"
REASON_GAP = "gap: {m} minutes between publishes, {s}s to go"
REASON_WAKE = "wake: the paper arrives at wake instants; the next is {t}"
REASON_MANUAL = "manual: this schedule publishes only by hand"
REASON_IMMEDIATE = "immediate"
REASON_DUE = "due"
REASON_PROMOTED = "promoted"
REASON_UNCHANGED = "unchanged: identical to the edition already current"
REASON_PAPER = "filed: a paper for {s}; neither pointer moved"
REASON_UNCHANGED_PAPER = "duplicate: identical to the newest paper for {s}"

#: What a commit is for. ``board`` is the newspaper that goes on the glass and
#: is every bit of today's behaviour; ``paper`` is the one the desk keeps for a
#: company whether or not it is the one being printed.
#:
#: A named pair rather than a boolean because the difference is not "publish or
#: not" -- a board commit that stages has not published either -- it is *which
#: state the edition is being filed into*, and a `publish=False` would read as
#: the first.
TARGET_BOARD = "board"
TARGET_PAPER = "paper"
COMMIT_TARGETS: tuple[str, ...] = (TARGET_BOARD, TARGET_PAPER)

# ``\Z`` and not ``$`` in all three of the regexes below, and this is the
# reason: ``$`` also matches before a trailing newline, and every one of these
# strings becomes a path component. ``"0123456789abcdef\n"`` is not an edition
# id.

#: ``uuid4().hex``, which is also the shape ``http.py``'s draft routes match.
_DRAFT_RE = re.compile(r"^[0-9a-f]{32}\Z")

#: A fingerprint, and therefore a directory name under ``editions/``.
_EID_RE = re.compile(r"^[0-9a-f]{16}\Z")

#: A proof sheet. ``.bmp`` as well as ``.png`` because a render that failed
#: before conversion still leaves sheets somebody should be able to look at.
#: Public because ``http.py`` serves these bytes and must accept exactly the
#: names this module will hand back -- two spellings of one rule is how a gate
#: came to advertise a ``.bmp`` the sheet route then refused.
SHEET_RE = re.compile(r"^[A-Za-z0-9_-]{1,40}\.(?:png|bmp)\Z")

#: What an edition's ``lang`` is when the payload does not say, or says
#: something that is not a language tag. The device's own rule, from
#: ``docs/news-contract.md``: "absent or malformed means ``en``". The meta has
#: to agree with what is actually printed rather than recording "unknown",
#: because the phone draws this field as the paper's language.
DEFAULT_LANG = "en"

#: A ``subject.symbol`` as the index will key on it. Eight characters because
#: that is the device's buffer and the validator's cap; anything else is an
#: edition the index simply cannot key, which is not an error -- gate 1 decides
#: what an edition is, and this decides what a *paper* is.
SUBJECT_SYMBOL_RE = re.compile(r"^[A-Z0-9.\-]{1,8}\Z")

#: A BCP-47 primary subtag, the wire's own shape from ``docs/news-contract.md``.
#: Not :data:`~claudepost.settings.LANGS`: this field describes the text that
#: is actually in the payload, and the desk deliberately does not cross-check
#: an edition's language against the setting.
LANG_RE = re.compile(r"^[a-z]{2,3}\Z")


@dataclass(frozen=True)
class CommitResult:
    """What became of a commit: the edition, its state, and why.

    ``state`` is one of ``"published"``, ``"staged"``, ``"unchanged"`` or
    ``"paper"``. ``"paper"`` is an edition that was filed for the index and
    not for the glass: it passed every gate but the schedule one, which does
    not apply to it, and neither pointer moved.
    ``reason`` is prose for a person -- the HTTP layer passes it through to
    whoever filed the draft, and an agent that was told "quiet" can decide to
    wait rather than to file again.
    """

    edition_id: str
    state: str
    reason: str = ""


class EditionStore:
    """The drafts, the editions, and the two pointers that pick one of them.

    ``root`` is the data directory: ``drafts/`` and ``editions/`` live under it
    beside the pointers and the database. ``gates`` decides whether a draft may
    become an edition, ``store`` is the record of the ones that did, and
    ``clock`` is every instant this module writes down. ``keep`` is how many
    editions :meth:`prune` leaves behind on top of whatever is current or
    staged.

    Construction is deliberately cheap: two ``makedirs`` and a look at the
    pointers. :class:`~claudepost.app.Desk` builds one before its first tick,
    and a constructor that swept directories would put a filesystem walk
    between the process starting and the board's next poll being answered.
    """

    def __init__(self, root: str, gates: Gates, store: Store, clock: Clock,
                 keep: int = 30) -> None:
        self.root = os.path.abspath(root)
        self._gates = gates
        self._store = store
        self._clock = clock
        self._keep = max(0, int(keep))

        self._drafts_root = os.path.join(self.root, DRAFTS_DIR)
        self._editions_root = os.path.join(self.root, EDITIONS_DIR)

        #: Guards draft mutation, ``_busy``, the build's rename, both pointers
        #: and ``prune``. Reads take it *never*: the request path is a
        #: ``ThreadingHTTPServer`` and an edition directory does not change.
        self._lock = threading.RLock()

        #: Drafts inside a commit. A gate can run for ten minutes and the
        #: sweeper must not delete a draft out from under a render.
        self._busy: set[str] = set()

        #: Directories the desk is in the middle of writing: a build being
        #: filled, and the edition a commit is placing. Retention skips them,
        #: because neither is rubbish and neither is history yet.
        self._building: set[str] = set()

        #: The staged edition already complained about. ``publish_due`` runs
        #: every few seconds, and a warning per tick would bury the one that
        #: matters under thousands of copies of itself.
        self._warned_staged: str | None = None

        os.makedirs(self._drafts_root, exist_ok=True)
        os.makedirs(self._editions_root, exist_ok=True)

        for name in (CURRENT, STAGED):
            eid = self._read_pointer(name)
            if eid is not None and not os.path.isdir(self._edition_dir(eid)):
                # Left as it is rather than cleared: the pointer is the record
                # of what this desk was serving, and a reader already answers
                # None for the payload, which is a 404 and not a wrong page.
                LOG.warning("%s names edition %s, which is not on disk", name, eid)

    # -- drafts ------------------------------------------------------------
    def open_draft(self) -> str:
        """Make an empty draft and return its id.

        The sweep runs only at the cap, so that a producer that crashed an hour
        ago costs the next one nothing -- and so that the ordinary case is not a
        directory walk per draft. The id is returned only once the directory
        exists, because an id whose directory does not is an id every later call
        answers ``NotFound`` for.
        """
        with self._lock:
            open_drafts = self._draft_ids()
            if len(open_drafts) >= tiles.MAX_DRAFTS:
                self.sweep_drafts()
                open_drafts = self._draft_ids()
            if len(open_drafts) >= tiles.MAX_DRAFTS:
                raise Conflict(message=f"{len(open_drafts)} drafts are already "
                                       f"open, limit {tiles.MAX_DRAFTS}")

            draft_id = uuid.uuid4().hex
            draft_dir = self._draft_dir(draft_id)
            os.makedirs(os.path.join(draft_dir, TILES_DIR))
            atomic_write(os.path.join(draft_dir, STAMP_NAME),
                         _canonical({"id": draft_id,
                                     "opened_at": self._clock.now()}).encode("utf-8"))
            return draft_id

    def put_payload(self, draft_id: str, data: bytes) -> None:
        """Put ``news.json`` into a draft, replacing whatever was there.

        The payload is parsed here and not merely stored, because a document
        that is not a JSON object fails gate 1 anyway and a render is minutes:
        refusing it now is the same answer, arrived at for nothing.

        Parsing it also makes this the one door every edition comes through,
        which is what :func:`_refuse_position_fields` needs. A draft's
        ``news.json`` is written here and nowhere else, and
        :meth:`_build_edition` copies the stored bytes verbatim, so a payload
        refused here cannot reach an edition directory by another route.
        """
        draft_dir = self._require_draft(draft_id)
        tiles.check_payload_size(data)

        try:
            doc = json.loads(data)
        except (ValueError, UnicodeDecodeError) as exc:
            raise BadRequest("bad_json", f"payload is not JSON: {exc}") from None
        except RecursionError:
            # CPython's decoder recurses per nesting level, and deep nesting
            # raises this rather than a ValueError -- so without this clause a
            # payload of ten thousand open brackets is a 500 on a route whose
            # every other refusal is a 400. Its own message is not quoted: a
            # RecursionError's text is about the interpreter's stack, which
            # tells the producer nothing about the document it sent.
            raise BadRequest("bad_json",
                             "payload is nested too deeply to parse") from None
        if not isinstance(doc, dict):
            raise BadRequest("bad_json",
                             f"payload is a JSON {type(doc).__name__}, not an object")
        _refuse_position_fields(doc)

        with self._lock:
            atomic_write(os.path.join(draft_dir, PAYLOAD_NAME), data)

    def put_tile(self, draft_id: str, tile_id: str, data: bytes) -> None:
        """Put one tile into a draft, replacing a tile of the same id.

        The draft is checked before the tile is, so an id that would become a
        path is answered by the draft it names rather than by the shape of the
        name. The count is only a limit on *new* ids: a correction filed at the
        cap is not one more tile, and refusing it would mean a producer at
        sixteen pictures could no longer fix any of them.
        """
        draft_dir = self._require_draft(draft_id)
        tiles.check_tile(tile_id, data)

        tiles_dir = os.path.join(draft_dir, TILES_DIR)
        with self._lock:
            held = _tile_ids(tiles_dir)
            if tile_id not in held and len(held) >= tiles.MAX_TILES:
                raise Conflict(message=f"{len(held)} tiles, limit {tiles.MAX_TILES}")
            atomic_write(os.path.join(tiles_dir, tile_id + ".bin"), data)

    def put_draft_notes(self, draft_id: str, data: bytes) -> None:
        """Put the worker's notes into a draft, replacing what was there.

        Beside the payload rather than inside it, because a note is evidence
        about an edition and not part of one: it is not fingerprinted, so
        filing one cannot move an edition id and cannot cost the wall a
        twenty-five second refresh. ``notes.py`` owns what may be written.
        """
        draft_dir = self._require_draft(draft_id)
        with self._lock:
            notes.write(draft_dir, data)

    def draft_info(self, draft_id: str) -> dict:
        """What a draft holds: its tiles, its bytes, its note, and when it opened."""
        draft_dir = self._require_draft(draft_id)
        try:
            size = os.path.getsize(os.path.join(draft_dir, PAYLOAD_NAME))
        except OSError:
            size = 0
        return {"id": draft_id,
                "tiles": _tile_ids(os.path.join(draft_dir, TILES_DIR)),
                "bytes": size,
                # The flag rather than the note: a client asking what a draft
                # holds should not be sent a quarter of a megabyte of markdown
                # to find out there was some. Through `has_notes` rather than
                # off `draft_dir`, which is already in hand, so that there is
                # one answer to "does this carry a note" and not one per caller.
                "has_notes": self.has_notes(draft_id),
                "opened_at": self._draft_stamp(draft_id)}

    def sweep_drafts(self, older_than: float = DRAFT_TTL_SECONDS) -> int:
        """Delete drafts nobody has finished, and say how many went.

        A draft inside a commit is skipped however old it looks: gate 2 may
        have been running for ten minutes and deleting the directory it is
        rendering would fail the commit for a reason nobody could reconstruct.
        """
        now = self._clock.now()
        gone = 0
        with self._lock:
            for draft_id in self._draft_ids():
                if draft_id in self._busy:
                    continue
                if now - self._draft_stamp(draft_id) >= older_than:
                    shutil.rmtree(self._draft_dir(draft_id), ignore_errors=True)
                    gone += 1
        return gone

    # -- the gates ---------------------------------------------------------
    def proof(self, draft_id: str) -> dict:
        """Run both gates over a draft and report, without committing anything.

        This is the loop the producing agent works in: file the copy, look at
        the sheets, fix the headline that came out four characters over budget.
        It never raises on a verdict -- a refusal *is* the answer, and the gate
        output is the entire product of a failed gate.

        The proof directory is cleared first, so what comes back is this run's
        sheets and not a previous run's left beside them.
        """
        draft_dir = self._require_draft(draft_id)
        if self._draft_payload(draft_dir) is None:
            raise BadRequest("no_payload", "a draft with no news.json cannot be proofed")

        proof_dir = _fresh_proof_dir(draft_dir)

        # Cheapest gate first, and the expensive one is not reached when the
        # cheap one has already answered: a render is minutes of a real
        # typesetter, and a payload gate 1 refused would fail it anyway.
        verdict = self._gates.validate(draft_dir)
        if not verdict.ok:
            return {"ok": False, "validate": verdict.output, "render": "",
                    "sheets": []}

        render = self._gates.render(draft_dir, proof_dir)
        return {"ok": render.ok, "validate": verdict.output,
                "render": render.output,
                # Basenames: the proof directory is a container path and a
                # container path in a JSON response is a disclosure for no
                # benefit.
                "sheets": [os.path.basename(s) for s in render.sheets]}

    def fingerprint(self, draft_id: str) -> str:
        """What this draft would be filed as: the id of the edition it becomes.

        Over the payload **as it would be stored** -- the producer's own policy
        block removed first -- plus every tile id and every tile byte. Stripping
        first is what makes this agree with the firmware's ``news_hash()``,
        which never sees that block: a payload differing only by a cadence the
        producer does not own is the same edition, and a redundant edition costs
        twenty-five seconds of the whole sheet flashing.
        """
        draft_dir = self._require_draft(draft_id)
        raw = self._draft_payload(draft_dir)
        if raw is None:
            raise BadRequest("no_payload", "a draft with no news.json has no fingerprint")
        eid, _stored, _dropped = _fingerprint_draft(draft_dir, raw)
        return eid

    # -- the commit --------------------------------------------------------
    def commit(self, draft_id: str, schedule: Schedule, now: float,
               target: str = TARGET_BOARD,
               symbol: str | None = None) -> CommitResult:
        """Take a draft through every gate and, if it passes them, file it.

        The five gates in order: the draft exists and holds a payload, gate 1
        says it is a legal edition, gate 2 says it prints, the fingerprint says
        it is not what is already up, and the schedule says now is a moment at
        which something new may become current.

        Nothing outside the draft directory is written until gate 1 and gate 2
        have both passed. A refusal therefore leaves the current edition, the
        store and both pointers exactly as they were, and leaves the draft
        itself alone to be corrected -- the producer is an agent that has to fix
        its own copy, and throwing the draft away would make it re-upload every
        tile to change a headline.

        ``target`` picks which of the two things is being filed.
        :data:`TARGET_BOARD` is the paragraph above, unchanged.
        :data:`TARGET_PAPER` files the day's newspaper *about a company* --
        four of the five gates, with the schedule one skipped because nothing
        is about to appear on any wall, and with the fingerprint compared
        against that company's own newest paper rather than against
        ``current``. Neither pointer is written.

        ``symbol`` is required by, and only meaningful to, a paper commit. It
        is checked against the draft's own ``subject.symbol`` and a
        disagreement is a ``Conflict``: the index is derived from the payload,
        so a model that drifted to another company would otherwise file its
        paper under the name the desk asked for and nothing downstream would
        ever see the two disagree.

        Raises:
            NotFound: no such draft.
            Conflict: that draft is already inside a commit, or
                ``commit_symbol_mismatch`` -- the draft is about a different
                company than the one this commit names.
            BadRequest: no payload, a gate refused it, an unknown ``target``,
                or ``commit_needs_symbol`` -- a paper commit that named no
                company. The gate's own output is in the message, because that
                output is the whole product of a failed gate.
        """
        if target not in COMMIT_TARGETS:
            raise BadRequest(message="target is one of: "
                                     + ", ".join(COMMIT_TARGETS))
        draft_dir = self._require_draft(draft_id)
        with self._lock:
            if draft_id in self._busy:
                raise Conflict(message=f"draft {draft_id} is already being committed")
            self._busy.add(draft_id)
        try:
            return self._commit(draft_id, draft_dir, schedule, now,
                                target, symbol)
        finally:
            with self._lock:
                self._busy.discard(draft_id)

    def publish_due(self, schedule: Schedule, now: float) -> CommitResult | None:
        """Put the staged edition up if the schedule now allows it.

        Called from the tick, so it runs every few seconds forever and answers
        ``None`` almost every time. That is the point: the decision about *when*
        lives here rather than in a timer somebody has to keep alive.
        """
        staged = self.staged_id()
        if staged is None:
            return None

        if staged == self.current_id():
            # A crash between the two pointer writes. The page is already up;
            # clearing the pointer is the whole repair, and publishing again
            # would be a twenty-five second refresh that changes nothing.
            with self._lock:
                self._clear_pointer(STAGED)
            return None

        # One syscall rather than a read: this runs every few seconds for as
        # long as something is staged, and reading a 300 KB payload to answer
        # "is it still there" is the whole edition, per tick, discarded. The
        # read was never the stronger check either -- publishing is a pointer
        # write, and the reader that resolves it comes afterwards.
        if not os.path.isfile(os.path.join(self._edition_dir(staged), PAYLOAD_NAME)):
            if self._warned_staged != staged:
                self._warned_staged = staged
                LOG.warning("staged edition %s has no payload on disk; "
                            "leaving it staged", staged)
            return None

        ok, _reason = self._schedule_gate(schedule, now, self._staged_at(staged))
        if not ok:
            return None
        with self._lock:
            return self._publish(staged, now, REASON_DUE)

    def publish_now(self, reason: str = "forced") -> CommitResult | None:
        """Put the staged edition up now, inside a hold or a quiet window or not.

        A rule you cannot override is a rule somebody ends up editing at
        midnight, so this ignores every gate in :meth:`_schedule_gate` and is
        deliberately absolute. ``None`` when nothing is staged, which the HTTP
        layer turns into a 404 rather than a pretend success.
        """
        with self._lock:
            staged = self.staged_id()
            if staged is None:
                return None
            return self._publish(staged, self._clock.now(), reason)

    def promote(self, edition_id: str) -> CommitResult:
        """Make an edition that was filed earlier current again.

        The edition directory is immutable and complete, so this is one pointer
        write: yesterday's paper comes back with yesterday's tiles, not with
        today's under yesterday's headline.
        """
        self._require_edition(edition_id)
        with self._lock:
            if edition_id == self.current_id():
                # No pointer write and no publish row: promoting what is
                # already up is not a refresh, and a publish row would restart
                # the minimum gap for nothing.
                return CommitResult(edition_id, "unchanged", REASON_UNCHANGED)
            return self._publish(edition_id, self._clock.now(), REASON_PROMOTED)

    # -- reading -----------------------------------------------------------
    def current_id(self) -> str | None:
        """The edition being served, or ``None``."""
        return self._read_pointer(CURRENT)

    def staged_id(self) -> str | None:
        """The edition waiting for the schedule, or ``None``."""
        return self._read_pointer(STAGED)

    def read_payload(self, edition_id: str) -> bytes | None:
        """An edition's ``news.json``, or ``None`` if there is no such thing.

        ``None`` rather than an exception, all the way down: this is the
        serving path, and every way of failing here -- an id that is a path, an
        edition pruned a second ago, a pointer naming a directory somebody
        deleted -- means the same thing to the board, which is a 404 it treats
        as a missed fetch.
        """
        if not _valid(_EID_RE, edition_id):
            return None
        return read_bytes(os.path.join(self._edition_dir(edition_id), PAYLOAD_NAME))

    def read_tile(self, edition_id: str, tile_id: str) -> bytes | None:
        """One tile of an edition, verbatim, or ``None``."""
        if not _valid(_EID_RE, edition_id) or not tiles.valid_tile_id(tile_id):
            return None
        return read_bytes(os.path.join(self._edition_dir(edition_id), TILES_DIR,
                                        tile_id + ".bin"))

    def _owner_dir(self, owner_id: str) -> str | None:
        """The directory an id names, whichever of the two kinds it is.

        A proof sheet and a note both belong to *either* a draft or the edition
        it became, and the id itself is what says which -- the two shapes are
        disjoint (sixteen hex against thirty-two), so the regexes tell them
        apart and no caller has to pass a flag saying which it meant. That is
        the safety argument as much as the convenience one: a flag can be
        wrong, and a caller that asked after a draft by an edition's id would
        be answered from the wrong tree. An id of neither shape names nothing.

        ``None`` rather than a raise, because both callers are on the serving
        path where an id that cannot exist and one that merely does not are
        the same 404 to whoever asked.
        """
        if _valid(_EID_RE, owner_id):
            return self._edition_dir(owner_id)
        if _valid(_DRAFT_RE, owner_id):
            return self._draft_dir(owner_id)
        return None

    def read_sheet(self, owner_id: str, name: str) -> bytes | None:
        """A proof sheet, from the edition that carries it or the draft that made it.

        The id decides which tree is read; see :meth:`_owner_dir`. Anything
        that is neither shape, and any name that is not a sheet's, reads
        nothing.
        """
        base = self._owner_dir(owner_id) if _valid(SHEET_RE, name) else None
        if base is None:
            return None
        return read_bytes(os.path.join(base, PROOF_DIR, name))

    def read_draft_notes(self, draft_id: str) -> bytes | None:
        """A draft's notes, or ``None``.

        Regex-guarded and non-raising, like :meth:`read_sheet` beside it: a
        draft that is gone, one that never had a note and an id that is not a
        draft id are one answer to whoever asked, which is a 404.
        """
        if not _valid(_DRAFT_RE, draft_id):
            return None
        return notes.read(self._draft_dir(draft_id))

    def read_edition_notes(self, edition_id: str) -> bytes | None:
        """An edition's notes, or ``None``.

        Guarded and non-raising like :meth:`read_draft_notes` above it, and it
        is this one a phone actually reads: a draft is deleted the moment it
        commits, so the copy that outlives the publication is the one the
        edition kept. Immutable with the rest of the directory -- correcting a
        note means filing another draft, the same as correcting a headline.
        """
        if not _valid(_EID_RE, edition_id):
            return None
        return notes.read(self._edition_dir(edition_id))

    def has_notes(self, owner_id: str) -> bool:
        """Whether a draft or an edition carries a note.

        The id decides which tree is asked, the way :meth:`read_sheet` does it
        and for :meth:`_owner_dir`'s reason. Anything that is neither shape
        carries nothing.
        """
        base = self._owner_dir(owner_id)
        return base is not None and notes.present(base)

    def sheet_names(self, edition_id: str) -> list[str]:
        """The proof sheets an edition carries, by name, sorted.

        The gates decide what they leave: two PNGs on a pass, a BMP where the
        render died before conversion. So the names are read off the edition
        rather than assumed, and anything downstream that wants to show the
        paper asks instead of guessing.

        An id that is not an edition, or one whose directory is gone, has no
        sheets -- the same answer as an edition that has none, because there is
        the same thing to show for both.
        """
        if not _valid(_EID_RE, edition_id):
            return []
        return _sheet_names(os.path.join(self._edition_dir(edition_id), PROOF_DIR))

    def edition_meta(self, edition_id: str) -> dict:
        """An edition's ``meta.json`` -- its birth certificate, rewritten once
        at most.

        Born with the edition and then left alone, with exactly one exception:
        an edition filed again as a company's *paper* has its ``created_at``
        moved to that filing, because the paper index has no pointer and picks
        by date. Nothing else in the document ever moves, ``published_at``
        included. See :meth:`_redate`, and the argument at its call site.

        Raises:
            NotFound: unknown id, missing directory, or metadata that will not
                parse. An empty dict would blur "no such edition" into "an
                edition with nothing recorded", and those want different
                answers from the operator reading them.
        """
        path = os.path.join(self._require_edition(edition_id), META_NAME)
        raw = read_bytes(path)
        if raw is None:
            raise NotFound(message=f"edition {edition_id} has no metadata")
        try:
            doc = json.loads(raw)
        except ValueError:
            raise NotFound(message=f"edition {edition_id} has unreadable metadata") from None
        if not isinstance(doc, dict):
            raise NotFound(message=f"edition {edition_id} has unreadable metadata")
        return self._filled(edition_id, doc)

    def _subject_of(self, edition_id: str) -> tuple[str | None, str, str | None]:
        """An edition's company, language and lead headline, off its stored payload."""
        payload = self.read_payload(edition_id)
        return (_subject_symbol(payload), _payload_lang(payload),
                _lead_headline(payload))

    def _filled(self, edition_id: str, doc: dict) -> dict:
        """``doc`` with ``symbol`` and ``lang`` on it however old the edition is.

        The migration that does not run. ``meta.json`` is an edition's birth
        certificate, and the one rewrite there is moves a re-filed paper's
        ``created_at`` and adds no field to anything -- so an edition filed
        before these two existed gets them derived from its own stored payload
        on the way out, which is what makes a pre-change edition a paper for
        its company rather than an edition about nobody. (That one rewrite does
        persist whatever this derived, because what :meth:`_redate` writes back
        is what this handed it. A side effect of re-dating a single edition,
        not a sweep: nothing backfills the ones never filed again.)

        Membership and not truthiness: an edition filed *after* this change
        about a payload with no usable subject records ``"symbol": null``, and
        that is an answer rather than an omission. Re-deriving it every time
        would read the payload to learn what the meta already says.
        """
        if "symbol" in doc and "lang" in doc:
            return doc
        symbol, lang, _headline = self._subject_of(edition_id)
        doc.setdefault("symbol", symbol)
        doc.setdefault("lang", lang)
        return doc

    def headline(self, edition_id: str) -> str | None:
        """The lead story's headline, for a reader choosing between papers.

        ``None`` for an edition with no stories, and for one that is not there
        at all -- the serving path's rule, because both mean the same thing to
        a pager drawing a row.
        """
        return self._subject_of(edition_id)[2]

    def papers(self, symbols: Sequence[str]) -> dict[str, dict | None]:
        """The newest edition about each requested company, or ``None``.

        A **read, not a cache**: the editions on disk are the truth, and a
        second record of "which is the newest paper for S" would be a thing to
        keep in step with retention, with a promotion, and with a commit that
        crashed between the build and the record.

        Every requested symbol gets a key, ``None`` and all. A key that was
        simply missing would make "this company has no paper yet" and "you
        misspelled the symbol" the same answer to a pager, and the first of
        those is a row it has to draw.
        """
        newest = self._newest_by_symbol()
        return {symbol: newest.get(symbol) for symbol in symbols}

    def _newest_by_symbol(self) -> dict[str, dict]:
        """``{symbol: meta}`` for every company with an edition on disk.

        Off the DISK rather than off the editions table, and that is the
        safety argument rather than a preference: a store row outlives the
        directory ``prune`` deleted, so an index built from the table would
        hand a reader an edition id whose payload 404s. Walking the disk also
        bounds the cost at retention depth -- a few dozen small ``meta.json``
        reads -- where the table grows forever.

        Ties on ``created_at`` are broken by the id, so two editions filed in
        the same second resolve the same way on every call. Without it the
        answer would depend on ``os.listdir`` order, and a pager would appear
        to flip between two papers at random.
        """
        newest: dict[str, tuple[float, str, dict]] = {}
        for eid in self._edition_ids():
            try:
                meta = self.edition_meta(eid)
            except NotFound:
                # A directory that lost its meta.json, or one deleted between
                # the listing and the read. Not an edition anybody can serve.
                continue
            symbol = meta.get("symbol")
            if not symbol:
                continue
            try:
                at = float(meta.get("created_at") or 0.0)
            except (TypeError, ValueError):
                at = 0.0
            key = (at, eid)
            if symbol not in newest or key > newest[symbol][:2]:
                newest[symbol] = (at, eid, meta)
        return {symbol: meta for symbol, (_at, _eid, meta) in newest.items()}

    def list_editions(self, limit: int = 50) -> list[dict]:
        """The history, each row carrying its company and its language.

        Here rather than in :meth:`~claudepost.store.Store.list_editions`
        because the fill reads a payload off the disk, which is this module's
        territory and not the database's -- and because a row from the store
        and a row from :meth:`edition_meta` answering "which company is this"
        differently is exactly the bug the shared :meth:`_filled` prevents.
        """
        return [self._filled(row["id"], row)
                for row in self._store.list_editions(limit)]

    # -- retention ---------------------------------------------------------
    def prune(self, keep: int | None = None,
              symbols: Sequence[str] = ()) -> int:
        """Delete old editions, keeping the newest ``keep`` of them, and count them.

        ``current`` and ``staged`` survive however old they are: retention must
        never be able to delete the page on the wall. Leftover ``.build-*``
        directories go too, but they are not editions and are not counted --
        this number is how much history was dropped, not how much rubbish.

        ``symbols`` is the companies whose papers must survive -- the desk's
        printable watchlist. The newest edition of each is protected however
        old it is, for the same reason ``current`` is: a paper pruned out from
        under the pager is a row that goes blank with nothing on the desk to
        explain it. An edition for a company no longer on that list loses the
        protection and ages out normally, which is what makes removing a
        symbol from the watchlist the way to stop keeping its paper.
        """
        depth = self._keep if keep is None else max(0, int(keep))
        with self._lock:
            self._sweep_partials()

            known = self._edition_ids()
            protected = {p for p in (self.current_id(), self.staged_id())
                         if p is not None}
            # An edition a commit is placing is not history yet: its pointer
            # has not moved, so neither of those would protect it, and deleting
            # it would leave `current` naming a directory that is gone.
            protected.update(e for e in known
                             if self._edition_dir(e) in self._building)
            # Newest first, by the edition's own record of when it was built --
            # an mtime would be whatever the last copy or restore made it.
            known.sort(key=self._created_at, reverse=True)
            protected.update(known[:depth])

            # After the depth, not before: a paper inside the newest `depth`
            # is already protected and this adds nothing, and a paper outside
            # it is exactly the case this exists for.
            if symbols:
                newest = self._newest_by_symbol()
                protected.update(meta["id"] for meta in
                                 (newest.get(s) for s in symbols)
                                 if meta is not None)

            gone = 0
            for eid in known[depth:]:
                if eid in protected:
                    continue
                shutil.rmtree(self._edition_dir(eid), ignore_errors=True)
                gone += 1
            if gone:
                fsync_dir(self._editions_root)
            return gone

    # -- internals ---------------------------------------------------------
    def _commit(self, draft_id: str, draft_dir: str, schedule: Schedule,
                now: float, target: str = TARGET_BOARD,
                symbol: str | None = None) -> CommitResult:
        """:meth:`commit`, with the draft already claimed in ``_busy``."""
        raw = self._draft_payload(draft_dir)
        if raw is None:
            # Before either gate: a draft with no payload is not a candidate,
            # and a render costs minutes to say so.
            raise BadRequest("no_payload", "a draft with no news.json is not an edition")

        # Both gates run outside the lock. SubprocessGates can take ten minutes
        # and nothing else on this desk may wait behind it.
        verdict = self._gates.validate(draft_dir)
        if not verdict.ok:
            raise BadRequest("gate_failed",
                             "gate 1 (validate) refused it:\n" + verdict.output)

        proof_dir = _fresh_proof_dir(draft_dir)
        render = self._gates.render(draft_dir, proof_dir)
        if not render.ok:
            raise BadRequest("gate_failed",
                             "gate 2 (render) refused it:\n" + render.output)

        eid, stored, dropped = _fingerprint_draft(draft_dir, raw)
        tile_ids = _tile_ids(os.path.join(draft_dir, TILES_DIR))
        subject = _subject_symbol(stored)
        is_paper = target == TARGET_PAPER

        if is_paper:
            if not symbol:
                raise BadRequest("commit_needs_symbol",
                                 "a paper commit names the company it is for")
            if subject != symbol:
                # THE WALL. The index is keyed by the payload's own subject, so
                # filing this would put a newspaper about one company under
                # another company's name -- and nothing downstream could ever
                # see the two disagree, because downstream only ever reads the
                # index. Refusing here is what makes a drifted run a failed
                # command with a reason in the queue instead.
                raise Conflict("commit_symbol_mismatch",
                               f"this draft is about {subject or 'no company'}, "
                               f"not about {symbol}")
            if eid == self._newest_paper_id(symbol):
                self._store.audit("commit", {"edition": eid,
                                             "state": "unchanged",
                                             "draft": draft_id,
                                             "symbol": symbol})
                self._drop_draft(draft_id)
                return CommitResult(eid, "unchanged",
                                    REASON_UNCHANGED_PAPER.format(s=symbol))
            # No schedule gate: a paper appears on nobody's wall, so a quiet
            # window, a hold and the minimum gap all have nothing to say about
            # it. `ok` is False so the meta below records no published_at, and
            # the tail files rather than stages.
            ok, reason = False, REASON_PAPER.format(s=symbol)
        else:
            if eid == self.current_id():
                # The bytes are already on the glass and already on disk as an
                # immutable edition, so the draft has nowhere left to go. No
                # pointer write and no publish row: an unchanged commit is not
                # a publish and must not restart the minimum gap.
                self._store.audit("commit", {"edition": eid,
                                             "state": "unchanged",
                                             "draft": draft_id})
                self._drop_draft(draft_id)
                return CommitResult(eid, "unchanged", REASON_UNCHANGED)

            ok, reason = self._schedule_gate(schedule, now, now)

            if eid == self.staged_id():
                # Already waiting, and waiting is idempotent. Rewriting the
                # pointer would only move an mtime; publishing is publish_due's
                # decision and it runs every few seconds.
                self._store.audit("commit", {"edition": eid, "state": "staged",
                                             "draft": draft_id})
                self._drop_draft(draft_id)
                return CommitResult(eid, "staged", reason)

        # The gate runs before the build so that meta.json is born with the
        # right published_at. It is written once and never rewritten, bar the
        # single case below -- a paper filed again moves its created_at, and
        # nothing moves published_at ever.
        #
        # `symbol` and `lang` are the payload's own, copied here rather than
        # left to be re-derived: they are what the paper index keys on, and an
        # index that re-parsed 300 KB of JSON per row per request would be a
        # phone refresh costing more than the edition it draws. Both are
        # nullable-by-shape rather than by absence -- see `_filled`, which is
        # the reader for every edition filed before they existed.
        meta = {"id": eid,
                "created_at": now,
                "published_at": now if ok else None,
                "source": draft_id,
                "symbol": _subject_symbol(stored),
                "lang": _payload_lang(stored),
                "validate": _clip(verdict.output),
                "render": _clip(render.output),
                "dropped_producer_policy": dropped,
                "tile_count": len(tile_ids),
                "bytes": len(stored)}

        # Held against retention for the whole tail. Until the pointer moves,
        # this edition is neither current nor staged, so prune() would be free
        # to take it as old history -- and the pointer would then name a
        # directory that is gone.
        dest = self._edition_dir(eid)
        with self._lock:
            self._building.add(dest)
        try:
            built = self._build_edition(dest, draft_dir, stored, meta)
            if not built:
                # It was filed before, so the store gets the copy on disk
                # rather than this commit's -- two records of one immutable
                # edition disagreeing about when it was born would put the
                # history (ordered from the store) and retention (ordered from
                # disk) in different orders. Re-recording rather than skipping
                # also repairs a crash between build and record.
                try:
                    meta = self.edition_meta(eid)
                except NotFound:
                    pass          # unreadable: this commit's copy beats none

            if is_paper and not built:
                # A paper filed again becomes that company's paper again, and
                # the asymmetry with the board is the whole argument for
                # rewriting a date that is otherwise never rewritten. The board
                # says which edition is the board's with two pointers, so
                # `created_at` decides nothing there and an edition filed again
                # keeps the day it was born. The paper index has no pointer:
                # `_newest_by_symbol` picks by `created_at`, so recency *is* the
                # index. Leave the date alone here and the desk answers "paper
                # A" to the worker that just filed A while `/api/papers` goes on
                # showing B -- the desk contradicting itself about what it did a
                # millisecond ago. A re-filing is the newest word the desk has
                # about that company.
                #
                # Disk and store move together and under one lock, because the
                # paragraph above is still binding: what `meta.json` says is
                # exactly what reaches `record_edition`, so history and
                # retention keep the same order however many re-filings race.
                with self._lock:
                    meta = self._redate(eid, meta, now)
                    self._store.record_edition(eid, meta)
            else:
                self._store.record_edition(eid, meta)

            with self._lock:
                if is_paper:
                    return self._file_paper(eid, symbol, reason, draft_id)
                if ok:
                    return self._publish(eid, now, reason, draft_id=draft_id)
                return self._stage(eid, now, reason, draft_id=draft_id)
        finally:
            with self._lock:
                self._building.discard(dest)

    def _publish(self, edition_id: str, at: float, reason: str,
                 draft_id: str | None = None) -> CommitResult:
        """Make ``edition_id`` current. Called with the lock held.

        The pointer write is the publish: one ``os.replace`` onto a name a
        reader may be reading, so the reader sees the old id or the new one and
        never a torn one.
        """
        self._write_pointer(CURRENT, edition_id)
        if self._read_pointer(STAGED) == edition_id:
            self._clear_pointer(STAGED)
        self._store.note_publish(edition_id, at)
        self._store.audit("publish", {"edition": edition_id, "reason": reason})
        if draft_id is not None:
            self._drop_draft(draft_id)
        return CommitResult(edition_id, "published", reason)

    def _stage(self, edition_id: str, at: float, reason: str,
               draft_id: str | None = None) -> CommitResult:
        """Park ``edition_id`` until the schedule allows it. Lock held.

        A second commit while something is staged replaces it. The older
        edition stays on disk as history and leaves by age, because the desk
        publishes the latest paper rather than a queue of them.
        """
        self._write_pointer(STAGED, edition_id)
        self._store.set_meta("staged", _canonical({"id": edition_id, "at": at}))
        self._store.audit("stage", {"edition": edition_id, "reason": reason})
        if draft_id is not None:
            self._drop_draft(draft_id)
        return CommitResult(edition_id, "staged", reason)

    def _file_paper(self, edition_id: str, symbol: str, reason: str,
                    draft_id: str) -> CommitResult:
        """Record a paper. Called with the lock held.

        The shortest of the three tails, and deliberately: there is no pointer
        to write, no publish row to add and no gap to restart. The edition is
        already on disk and already in the store by the time this runs, so all
        that is left is the audit line and the draft.
        """
        self._store.audit("paper", {"edition": edition_id, "symbol": symbol})
        self._drop_draft(draft_id)
        return CommitResult(edition_id, "paper", reason)

    def _newest_paper_id(self, symbol: str) -> str | None:
        """The edition this company's paper currently is, or ``None``."""
        meta = self._newest_by_symbol().get(symbol)
        return meta["id"] if meta else None

    def _schedule_gate(self, schedule: Schedule, now: float,
                       staged_at: float) -> tuple[bool, str]:
        """Whether something new may become current at ``now``, and why not.

        Read-only and in one order, which is the order of who outranks whom: an
        operator's hold, then the owner's quiet window, then the floor between
        refreshes, then the publish policy. ``staged_at`` is when the edition
        started waiting, which is what ``on_wake`` measures from -- a paper that
        has been waiting since 06:14 goes up at the next wake, not at the next
        wake after the tick that noticed it.
        """
        hold = self._store.get_hold()
        if hold is not None and hold > now:
            return False, REASON_HOLD.format(t=_at(hold, schedule))

        if is_quiet(schedule, now):
            ends = quiet_ends_at(schedule, now)
            return False, REASON_QUIET.format(
                t=_at(ends if ends is not None else now, schedule))

        floor = schedule.min_gap_minutes * 60
        last = self._store.last_publish_at()
        if floor and last is not None and now < last + floor:
            return False, REASON_GAP.format(m=schedule.min_gap_minutes,
                                            s=int(last + floor - now))

        if schedule.publish_policy == "manual":
            return False, REASON_MANUAL

        if schedule.publish_policy == "on_wake":
            wake = next_wake(schedule, staged_at)
            if wake is None or wake > now:
                return False, REASON_WAKE.format(t=_at(wake, schedule))
            return True, REASON_DUE

        return True, REASON_IMMEDIATE

    def _build_edition(self, dest: str, draft_dir: str, stored: bytes,
                       meta: dict) -> bool:
        """Assemble an edition beside ``dest`` and rename it into place.

        Returns whether it actually built one: ``False`` means this edition was
        already on disk, and since the id *is* the content, the copy that is
        there is the same bytes and is the one a reader may be inside right now.

        Everything is written under ``editions/.build-XXXX`` -- which cannot
        match an edition id and is therefore invisible to every reader here --
        fsynced, and then moved with one ``os.replace``. An edition directory
        consequently never exists half-built: it appears whole or not at all,
        which is the promise ``current`` relies on.

        The temporary directory is filled *before* the question "is it already
        there?" is asked, and asking it and renaming happen in one critical
        section. An answer taken earlier could be false by the time the rename
        runs -- retention deletes editions and the answer decides whether this
        commit has a directory at all -- and the cost of the arrangement is one
        wasted copy on the rare path where an old edition is filed again.
        """
        tmp = self._open_build_dir()
        placed = False
        try:
            _write_file(os.path.join(tmp, PAYLOAD_NAME), stored)

            tiles_dir = os.path.join(tmp, TILES_DIR)
            os.makedirs(tiles_dir)
            source_tiles = os.path.join(draft_dir, TILES_DIR)
            for tile_id in _tile_ids(source_tiles):
                # A raising read, unlike everywhere on the serving path: this
                # is a write, and a tile silently dropped here would be an
                # immutable edition whose id and tile_count promise a picture
                # that is not in it. The commit fails instead, and nothing
                # outside the draft has been touched.
                _write_file(os.path.join(tiles_dir, tile_id + ".bin"),
                            _read_or_raise(os.path.join(source_tiles,
                                                        tile_id + ".bin")))

            proof_dir = os.path.join(tmp, PROOF_DIR)
            os.makedirs(proof_dir)
            source_proof = os.path.join(draft_dir, PROOF_DIR)
            for name in _sheet_names(source_proof):
                # Lenient, and only here: a proof sheet is evidence that
                # somebody looked at the paper, not part of the edition. It is
                # not fingerprinted and not counted, so losing one costs a
                # picture in a diagnostic view and nothing on the wall.
                data = read_bytes(os.path.join(source_proof, name))
                if data is not None:
                    _write_file(os.path.join(proof_dir, name), data)

            # The note rides in beside them and just as leniently, being the
            # same kind of thing: evidence about an edition rather than part of
            # one.
            #
            # And, unlike everything above it here, not fingerprinted -- which
            # is the arrangement rather than an omission. The paper decides its
            # own identity and the note follows it; hash the note too and a
            # worker who corrected a typo in their research has filed a second
            # edition, which is twenty-five seconds of the whole sheet flashing
            # to report that nothing on it changed.
            note = notes.read(draft_dir)
            if note is not None:
                _write_file(os.path.join(tmp, notes.NOTES_NAME), note)

            _write_file(os.path.join(tmp, META_NAME),
                        _canonical(meta).encode("utf-8"))

            for path in (tiles_dir, proof_dir, tmp):
                fsync_dir(path)

            with self._lock:
                if os.path.isdir(dest):
                    return False
                os.replace(tmp, dest)
                placed = True
        finally:
            with self._lock:
                self._building.discard(tmp)
            if not placed:
                shutil.rmtree(tmp, ignore_errors=True)

        fsync_dir(self._editions_root)
        return True

    def _redate(self, edition_id: str, meta: dict, now: float) -> dict:
        """Move an already-filed edition's ``created_at`` to ``now``. Lock held.

        The only rewrite of a birth certificate this module performs, and only
        for a paper -- the argument for it is at the call site, in
        :meth:`_commit`. Everything else in the document is carried over
        untouched, ``published_at`` above all: an edition that has been on the
        glass has been on the glass, and that is a fact about the past rather
        than about this filing.

        Written the way every pointer here is written -- a temporary file in
        the same directory and one ``os.replace`` -- so a reader inside
        :meth:`edition_meta` at this instant gets the whole old document or the
        whole new one. A truncated ``meta.json`` would not be a wrong date, it
        would be a :class:`NotFound` that takes ``/api/papers`` and retention
        down with it.

        The document returned is the one on disk, byte for byte, and the caller
        records *that* -- the two must not be assembled separately.
        """
        doc = dict(meta)
        doc["created_at"] = now
        atomic_write(os.path.join(self._edition_dir(edition_id), META_NAME),
                     _canonical(doc).encode("utf-8"))
        return doc

    def _open_build_dir(self) -> str:
        """A registered ``.build-*`` directory to assemble an edition in.

        Registered before it is used, so that retention running on the tick
        thread cannot delete a directory a request thread is still filling --
        which would either fail the commit or, worse, let it rename a directory
        with tiles missing from it into place under a fingerprint that promised
        them.
        """
        with self._lock:
            tmp = tempfile.mkdtemp(dir=self._editions_root, prefix=BUILD_PREFIX)
            self._building.add(tmp)
            return tmp

    def _sweep_partials(self) -> None:
        """Remove ``editions/.build-*`` left by a crash. Lock held.

        Two things are not crash leftovers and are left alone: a directory a
        build has registered, and one written recently enough that it is more
        likely a commit in progress than a corpse. The age comes from the
        filesystem's clock rather than the desk's, because what is being read
        is an mtime -- the two are different clocks, and this is housekeeping
        rather than schedule arithmetic, where the injected one is the rule.
        """
        try:
            names = os.listdir(self._editions_root)
        except OSError:
            return
        cutoff = time.time() - DRAFT_TTL_SECONDS
        for name in names:
            if not name.startswith(BUILD_PREFIX):
                continue
            path = os.path.join(self._editions_root, name)
            if path in self._building:
                continue
            try:
                if os.path.getmtime(path) >= cutoff:
                    continue
            except OSError:
                continue
            shutil.rmtree(path, ignore_errors=True)

    def _edition_ids(self) -> list[str]:
        """Every edition on disk. A ``.build-*`` is not one."""
        try:
            names = os.listdir(self._editions_root)
        except OSError:
            return []
        return [n for n in names if _valid(_EID_RE, n)]

    def _created_at(self, edition_id: str) -> float:
        """When an edition was built, from its own metadata.

        Falls back to the directory's mtime, which is only ever wrong by the
        difference between the desk's clock and the filesystem's -- and this
        number decides retention order, not what a schedule does.
        """
        try:
            return float(self.edition_meta(edition_id)["created_at"])
        except (NotFound, KeyError, TypeError, ValueError):
            pass
        try:
            return os.path.getmtime(self._edition_dir(edition_id))
        except OSError:
            return 0.0

    def _staged_at(self, edition_id: str) -> float:
        """When the staged edition started waiting.

        The store's note is preferred over the edition's ``created_at`` because
        an edition can be staged long after it was built -- promoted back, say
        -- and ``on_wake`` measures from the wait, not from the build. A note
        naming a different edition is a leftover and is ignored rather than
        cleared: the pointer is the state, and this is a hint about it.
        """
        raw = self._store.get_meta("staged")
        if raw:
            try:
                doc = json.loads(raw)
                if isinstance(doc, dict) and doc.get("id") == edition_id:
                    return float(doc["at"])
            except (ValueError, KeyError, TypeError):
                pass
        return self._created_at(edition_id)

    def _draft_payload(self, draft_dir: str) -> bytes | None:
        """A draft's ``news.json``, or ``None`` when nothing has been pushed."""
        return read_bytes(os.path.join(draft_dir, PAYLOAD_NAME))

    def _drop_draft(self, draft_id: str) -> None:
        """Delete a draft that has become an edition.

        The edition directory is the durable copy and can be promoted again, so
        keeping the draft would hold the same bytes twice against a limit of
        eight.
        """
        shutil.rmtree(self._draft_dir(draft_id), ignore_errors=True)

    def _draft_ids(self) -> list[str]:
        """The open drafts, by id. Anything else in the directory is not one."""
        try:
            names = os.listdir(self._drafts_root)
        except OSError:
            return []
        return sorted(n for n in names if _valid(_DRAFT_RE, n))

    def _draft_stamp(self, draft_id: str) -> float:
        """When a draft was opened, from its stamp.

        An unreadable stamp answers ``0.0``, which makes the draft older than
        any TTL and therefore sweepable. That is the right direction to fail in:
        a draft whose own record of itself is gone is a draft nothing is going
        to finish.
        """
        raw = read_bytes(os.path.join(self._draft_dir(draft_id), STAMP_NAME))
        if raw is None:
            return 0.0
        try:
            return float(json.loads(raw)["opened_at"])
        except (ValueError, KeyError, TypeError):
            return 0.0

    def _draft_dir(self, draft_id: str) -> str:
        """The directory of a draft, refusing an id that is not one.

        Every path join in this module goes through here rather than each
        checking the regex itself, so a bad id cannot reach ``os.path.join``
        whoever the caller is -- including this module's own
        ``uuid.uuid4().hex``, which has no reason to fail the check today but
        no promise that it never will. ``_require_draft`` checks first and
        answers ``NotFound``, so this guard never fires for a caller's id; one
        that does fire is a bug in the desk, not a request to refuse.
        """
        if not _valid(_DRAFT_RE, draft_id):
            LOG.error("draft id that is not one reached _draft_dir: %r", draft_id)
            raise Internal(message=f"not a draft id: {draft_id!r:.64}")
        return os.path.join(self._drafts_root, draft_id)

    def _edition_dir(self, edition_id: str) -> str:
        """The directory of an edition, refusing an id that is not one.

        Same rule as :meth:`_draft_dir`, for the same reason: every edition id
        that reaches here today is either regex-checked by a caller or minted
        by :func:`_fingerprint_of` as sixteen hex characters, but the guard
        belongs to the join rather than to whichever of them happened to run.
        """
        if not _valid(_EID_RE, edition_id):
            LOG.error("edition id that is not one reached _edition_dir: %r", edition_id)
            raise Internal(message=f"not an edition id: {edition_id!r:.64}")
        return os.path.join(self._editions_root, edition_id)

    def _require_draft(self, draft_id: str) -> str:
        """The draft's directory, or ``NotFound``.

        A malformed id and an absent one get the same answer on purpose. An id
        that cannot exist does not exist, and ``BadRequest`` would tell whoever
        sent ``../editions`` that the traversal had been recognised.
        """
        if not _valid(_DRAFT_RE, draft_id):
            raise NotFound(message=f"no draft {draft_id!r:.64}")
        path = self._draft_dir(draft_id)
        if not os.path.isdir(path):
            raise NotFound(message=f"no draft {draft_id!r:.64}")
        return path

    def _require_edition(self, edition_id: str) -> str:
        """The edition's directory, or ``NotFound``. Same rule as a draft's."""
        if not _valid(_EID_RE, edition_id):
            raise NotFound(message=f"no edition {edition_id!r:.64}")
        path = self._edition_dir(edition_id)
        if not os.path.isdir(path):
            raise NotFound(message=f"no edition {edition_id!r:.64}")
        return path

    def _pointer_path(self, name: str) -> str:
        """Where a pointer file lives. ``name`` is ours, never a caller's."""
        return os.path.join(self.root, name)

    def _read_pointer(self, name: str) -> str | None:
        """The edition a pointer names, or ``None``.

        Never raises. A missing pointer, an unreadable one and one holding
        something that is not an edition id are the same answer -- there is
        nothing to serve -- and the third matters most: a half-written pointer
        must not become a path.
        """
        try:
            with open(self._pointer_path(name), "r", encoding="utf-8") as f:
                eid = f.read(64).strip()
        except OSError:
            return None
        return eid if _valid(_EID_RE, eid) else None

    def _write_pointer(self, name: str, edition_id: str) -> None:
        """Point ``name`` at ``edition_id``, atomically."""
        atomic_write(self._pointer_path(name), (edition_id + "\n").encode("utf-8"))

    def _clear_pointer(self, name: str) -> None:
        """Remove a pointer. A missing one is already cleared."""
        try:
            os.unlink(self._pointer_path(name))
        except OSError:
            return
        fsync_dir(self.root)


def _refuse_position_fields(doc: object) -> None:
    """Refuse a payload naming one of :data:`FORBIDDEN_PAYLOAD_KEYS`, at any depth.

    **Keys only, never values.** A story about a company that sells contracts
    is an ordinary story, and a check that read the prose would refuse it; a
    story object that *carries* a ``contracts`` field is the owner's book
    leaking into a document served without a token. The whole document is
    walked because the shallow version of this check -- the top-level keys, or
    the top level of each story -- misses exactly the case that will happen: a
    figure three deep inside a story, annotated by an agent that had the
    positions in front of it.

    Iterative rather than recursive on purpose. The payload cap is 300 KB,
    which is room for a nesting depth in the tens of thousands, and a
    ``RecursionError`` is not a ``DeskError``: it would leave the caller a 500
    where this function's entire job is to give a 400.

    A blacklist is the weaker instrument and this one is deliberate rather than
    ideal. The stronger fix is a whitelist of the keys an edition may carry --
    the wire contract is a closed set and ``tools/mock_news_server.py`` already
    knows every field in it -- which would refuse a field nobody has thought of
    yet, where this refuses only the six that are named. That belongs in the
    validator that owns the contract, not here; until it exists, this is the
    wall.
    """
    stack = [doc]
    while stack:
        node = stack.pop()
        if isinstance(node, dict):
            for key, value in node.items():
                if key in FORBIDDEN_PAYLOAD_KEYS:
                    raise BadRequest(
                        "position_field",
                        f"the payload carries {key!r}, which names the owner's "
                        f"positions. /news.json is served with no authorization, "
                        f"so nothing about what is held may reach an edition")
                stack.append(value)
        elif isinstance(node, list):
            stack.extend(node)


def _valid(pattern: re.Pattern, name: object) -> bool:
    """Whether ``name`` is a well-formed id of the shape ``pattern`` describes.

    Pure regex and no filesystem: this is the check that runs *before* a string
    is joined into a path, and it is the only reason ``os.path.join`` here is
    safe. The regex is passed rather than named, so a caller that asks for a
    shape this module does not have is a NameError at import rather than a
    KeyError on the serving path.
    """
    return isinstance(name, str) and pattern.match(name) is not None


def _canonical(doc: dict) -> str:
    """A dict as the one JSON text this desk considers to be its content.

    Sorted keys and no whitespace, which is what makes two producers that
    serialised the same edition differently fingerprint the same. Compact like
    the form ``policy.py`` writes at serve time, and sorted on top of that
    because this one is *hashed*: the two need not be byte-equal, and the
    function that does match ``policy.py`` is :func:`_stored_payload`.
    """
    return json.dumps(doc, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=False)


def _stored_payload(raw: bytes) -> tuple[bytes, bool]:
    """The bytes an edition will keep, and whether a policy block was dropped.

    A payload that carries no ``policy`` key is stored **verbatim** -- the
    producer's own bytes, the ones it can diff against what the desk serves.
    One that does is re-serialised without it, because the cadence belongs to
    the owner's schedule and two places deciding one number is the failure
    ``policy.py`` exists to prevent. The block the device actually receives is
    spliced in at serve time, per request.
    """
    if not dropped_producer_policy(raw):
        return raw, False
    doc = json.loads(raw)
    doc.pop("policy", None)
    return json.dumps(doc, separators=(",", ":"),
                      ensure_ascii=False).encode("utf-8"), True


def _payload_doc(payload: bytes | None) -> dict:
    """A stored payload as a dict, or an empty one however it failed.

    Every way of failing is the same answer here -- no payload, a payload that
    is not JSON, a payload that is JSON but not an object -- because every one
    of them means the same thing to the index: there is nothing to key on.
    ``read_payload``'s rule, one level up.
    """
    if not payload:
        return {}
    try:
        doc = json.loads(payload)
    except ValueError:
        return {}
    return doc if isinstance(doc, dict) else {}


def _subject_symbol(payload: bytes | None) -> str | None:
    """The company an edition is about, as the index keys on it, or ``None``.

    Upper-cased before it is matched, so ``"sndk"`` and ``"SNDK"`` are one
    paper -- the same rule :func:`~claudepost.watchlist._symbol` and
    :func:`~claudepost.store._checked_symbol` follow, and the reason a commit
    can compare the two directly.
    """
    subject = _payload_doc(payload).get("subject")
    symbol = subject.get("symbol") if isinstance(subject, dict) else None
    if not isinstance(symbol, str):
        return None
    symbol = symbol.strip().upper()
    return symbol if SUBJECT_SYMBOL_RE.match(symbol) else None


def _payload_lang(payload: bytes | None) -> str:
    """The language an edition is written in. Never ``None``; see :data:`DEFAULT_LANG`."""
    lang = _payload_doc(payload).get("lang")
    if isinstance(lang, str) and LANG_RE.match(lang):
        return lang
    return DEFAULT_LANG


def _lead_headline(payload: bytes | None) -> str | None:
    """The lead story's headline, for a reader choosing between papers.

    The lead is the LOWEST-ranked story and not ``stories[0]``, because the
    wire carries a rank and nothing about order -- ``docs/news-contract.md``'s
    "``stories[]`` keeps the N lowest ranks" is the device's own rule and this
    is the same one. A story with no usable rank sorts last rather than first,
    so a producer that omitted the field cannot displace one that filed it.
    Ties go to the earlier entry, which is the only tiebreak the payload
    offers.
    """
    stories = _payload_doc(payload).get("stories")
    if not isinstance(stories, list):
        return None
    best: tuple[tuple[float, int], str] | None = None
    for i, story in enumerate(stories):
        if not isinstance(story, dict):
            continue
        headline = story.get("headline")
        if not isinstance(headline, str) or not headline.strip():
            continue
        rank = story.get("rank")
        if isinstance(rank, bool) or not isinstance(rank, (int, float)):
            rank = float("inf")
        key = (float(rank), i)
        if best is None or key < best[0]:
            best = (key, headline)
    return best[1] if best else None


def _content_of(stored: bytes) -> bytes:
    """The canonical text of a stored payload: what the fingerprint is over.

    Canonical rather than verbatim so that a producer re-serialising the same
    edition with its keys in a different order does not spend twenty-five
    seconds of the whole sheet flashing to report that nothing changed.
    """
    doc = json.loads(stored)
    if isinstance(doc, dict):
        doc.pop("policy", None)     # belt and braces: a stored payload has none
    return _canonical(doc).encode("utf-8")


def _fingerprint_of(content: bytes, tiles_dir: str) -> str:
    """The id of an edition made of ``content`` and the tiles in ``tiles_dir``.

    Every field is length-framed before it is hashed, so no arrangement of
    payload and tiles can be re-cut into another one that hashes the same --
    without the lengths, a tile id ending in the first bytes of its own data
    would be a collision anybody could construct.

    Sixteen hex characters, which is a directory name, an id read aloud over a
    phone, and about 1e-16 of collision across the few dozen editions kept.
    """
    h = hashlib.sha256()
    h.update(b"news.json\0" + len(content).to_bytes(8, "big") + content)
    for tile_id in _tile_ids(tiles_dir):
        # Raising, not `or b""`: an unreadable tile must not fingerprint as an
        # empty one, which would file two different editions under one id.
        data = _read_or_raise(os.path.join(tiles_dir, tile_id + ".bin"))
        h.update(b"tile\0" + tile_id.encode("utf-8") + b"\0"
                 + len(data).to_bytes(8, "big") + data)
    return h.hexdigest()[:FINGERPRINT_HEX]


def _fingerprint_draft(draft_dir: str, raw: bytes) -> tuple[str, bytes, bool]:
    """What a draft would be filed as: its id, its stored bytes, and what was dropped.

    The one recipe -- strip the producer's policy block, canonicalise what is
    left, hash it with every tile -- spelled once, because :meth:`fingerprint`
    promises the caller the id :meth:`commit` will use. Two copies of four calls
    would agree until one of them gained a step, and the symptom of that is a
    producer told its edition is unchanged filing a different one.

    ``raw`` is passed rather than read here: the commit path already holds the
    payload it refused to gate without, and a second read of 300 KB to keep the
    signature tidy is a read for nothing.
    """
    stored, dropped = _stored_payload(raw)
    return (_fingerprint_of(_content_of(stored),
                            os.path.join(draft_dir, TILES_DIR)),
            stored, dropped)


def _at(t: float | None, schedule: Schedule) -> str:
    """An instant as the schedule's own clock reads it, written for a person.

    The reasons this formats are prose handed to whoever filed the draft -- the
    commit's answer, and the worker's failure report after it -- and an epoch
    integer in one of them is a number somebody has to go and convert before
    they know whether to wait or to change something. The zone is the
    schedule's rather than the container's, because the quiet window and the
    wake instants were written in it. ``None`` is a wake that never comes.
    """
    if t is None:
        return "never"
    return datetime.fromtimestamp(t, ZoneInfo(schedule.timezone)).strftime(
        "%Y-%m-%d %H:%M %Z")


def _clip(output: str) -> str:
    """Gate output as ``meta.json`` keeps it: the record, not the report.

    The whole of it comes back live from a proof and from a refusal. This copy
    is read by ``GET /api/editions``, which lists fifty of them at once.
    """
    if len(output) <= MAX_META_OUTPUT:
        return output
    return output[:MAX_META_OUTPUT] + "\n... [cut]"


def _read_or_raise(path: str) -> bytes:
    """A whole file, or the ``OSError`` that stopped it reaching the caller.

    The counterpart to :func:`claudepost.fsutil.read_bytes`, and the split is
    the module's rule: a read on the serving path answers ``None`` because
    every way of failing means one thing to the board, while a read feeding a
    *write* must raise -- an edition is immutable, so a byte lost on the way in
    is lost for as long as the edition is kept. It stays here rather than
    moving to ``fsutil`` beside its counterpart because this module is its only
    caller, and the argument for that module is a second one.
    """
    with open(path, "rb") as f:
        return f.read()


def _write_file(path: str, data: bytes) -> None:
    """Write a file inside a build directory and flush it to the disk.

    No temporary file and no rename: the whole directory is renamed into place
    afterwards, so a half-written file here is a half-written directory that no
    reader can name. The ``fsync`` is what makes the rename mean something --
    without it the directory entry can outlive the bytes it points at.
    """
    with open(path, "wb") as f:
        f.write(data)
        f.flush()
        os.fsync(f.fileno())


def _fresh_proof_dir(draft_dir: str) -> str:
    """Empty a draft's proof directory and return it.

    Cleared rather than added to, so what a caller gets back is this run's
    sheets and not a previous run's left beside them -- a page that failed to
    render at all would otherwise be reported with the sheets of the version
    before it, which is the one arrangement worse than no sheets.

    *When* it is called is each caller's decision and the two differ: a proof
    clears before gate 1, a commit only once gate 1 has passed. Merging that
    would make a refused payload throw away the sheets somebody is looking at.
    """
    proof_dir = os.path.join(draft_dir, PROOF_DIR)
    shutil.rmtree(proof_dir, ignore_errors=True)
    os.makedirs(proof_dir, exist_ok=True)
    return proof_dir


def _sheet_names(proof_dir: str) -> list[str]:
    """The proof sheets in a directory, by name, sorted."""
    try:
        names = os.listdir(proof_dir)
    except OSError:
        return []
    return sorted(n for n in names if _valid(SHEET_RE, n))


def _tile_ids(tiles_dir: str) -> list[str]:
    """The tiles in a directory, by id, sorted.

    Only ``*.bin`` whose stem is an id both the desk and the device accept, so
    a ``.tmp`` left by a crash mid-write is not a picture and does not reach a
    fingerprint or a count.
    """
    try:
        names = os.listdir(tiles_dir)
    except OSError:
        return []
    ids = [n[:-4] for n in names if n.endswith(".bin")]
    return sorted(t for t in ids if tiles.valid_tile_id(t))
