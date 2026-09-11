"""SQLite: the command queue, the directive store, the edition log, the audit.

Four things live here because they share one property -- they must survive a
restart and they must be true across processes. The desk claims commands on
behalf of a long poll; the agent container claims for itself; both are looking
at the same file from different processes, and "we are careful in Python" is
not a synchronisation primitive across a process boundary. SQLite is.

**The queue and the directive store are not the same thing, and confusing them
is silent.** *"Research NVDA now"* is consumed once and forgotten -- a command.
*"Never print TSLA"* must hold forever -- a directive. Put the second in the
queue and it applies to exactly one edition, after which the desk forgets it
and the owner concludes the system ignored them. So they are separate tables
with separate lifecycles, and nothing here lets one become the other.

**Why one connection and a lock, rather than one connection per thread.** The
HTTP layer is a ``ThreadingHTTPServer``, which spawns a thread per request and
does not pool them. A thread-local connection would therefore open a database
handle per request and never close it while the thread object lived, and each
WAL reader holds a slot in the shared-memory index; the count would be bounded
by nothing but request volume. One connection behind an ``RLock`` is bounded by
one, and it makes the audit log's row order the order things happened rather
than the order the operating system scheduled. The cost is that writes
serialise inside a process -- which they would anyway, because SQLite allows
one writer at a time.

**Every write is ``BEGIN IMMEDIATE``.** The connection is opened in autocommit
mode and transactions are explicit, because a deferred transaction that reads
first and writes second can fail with ``SQLITE_BUSY_SNAPSHOT``, which the busy
handler does *not* retry. Taking the write lock up front is what makes
``busy_timeout`` mean what it says.

Times are epoch seconds as REAL, taken from the injected
:class:`~claudepost.clock.Clock` rather than from SQLite's own ``strftime``,
so a test can move a lease boundary without waiting half an hour to cross it.
"""

from __future__ import annotations

import json
import os
import re
import sqlite3
import threading
import uuid
from contextlib import contextmanager
from typing import Iterator

from .clock import Clock
from .errors import BadRequest, Conflict, NotFound, epoch_seconds
from .settings import LANGS

#: How long a claim is good for. A worker that dies mid-edition costs one
#: retry, not a lost day -- so this is a wall against a dead worker, and it has
#: to be longer than any live one takes.
#:
#: NINETY MINUTES, up from thirty. A paper run is 25-40 minutes when its proof
#: clears first time and longer when it needs a revision turn, and on
#: 2026-09-11 the desk put a claimed order back to `pending` at minute 39 while
#: the worker was still writing it. With one worker that was harmless --
#: `finish_command` accepts a report on a pending row -- but two readers do not
#: survive it: a second worker would claim the row and write the same edition
#: twice, and the rotation reads `pending` as "the worker is idle" and would
#: order a second paper on top of the one in flight.
#:
#: No heartbeat. A worker that reported in every minute would be a second
#: protocol to keep alive, with its own failure mode -- a run that is working
#: but not heartbeating -- and a lease longer than any run is the simpler wall.
#: The cost of getting it wrong in this direction is bounded and dull: a dead
#: worker's command waits ninety minutes instead of thirty before a retry.
LEASE_SECONDS: int = 5400

#: Three claims and the command is failed rather than returned. Something that
#: kills three workers in a row will kill the fourth, and a queue that retries
#: forever is a queue that hides the reason.
MAX_ATTEMPTS: int = 3

#: The shape of a command id: the ids this table hands out, the `NoteStore` the
#: desk gives their notes to, and every `/api/commands/<cid>/...` route in
#: `http.py`. It lives here rather than in `app.py` because `add_command` has to
#: check a `reply_to` against it and `store` cannot import `app` -- `app`
#: imports `store`. `app.py` re-exports it, so the one spelling is still the
#: only spelling.
COMMAND_ID_RE = re.compile(r"^[0-9a-f]{8,64}\Z")

#: A ticker as a command may carry one. Eight characters rather than the
#: watchlist's twelve, deliberately: this symbol is compared against an
#: edition's own ``subject.symbol``, which the validator caps at eight (see
#: ``tools/mock_news_server.py``'s length table), so a nine-character symbol
#: here would name a command no draft could ever satisfy and every paper run
#: for it would end in a 409 nobody could fix.
#:
#: The lookahead requires at least one letter or digit. A ticker is always
#: made of at least one of those -- ``"."``, ``".."`` and ``"........"`` are
#: not tickers, they are punctuation that happens to fit the character class
#: below them. Without the lookahead they would pass, and this symbol goes on
#: to become a URL path segment at ``POST /api/papers/<SYMBOL>/publish``, where
#: ``".."`` is not a value anything downstream should ever have to think about.
#: So the desk refuses the shape here, at the one place that decides what a
#: symbol is, rather than trusting every route that takes one to remember.
COMMAND_SYMBOL_RE = re.compile(r"^(?=.*[A-Z0-9])[A-Z0-9.\-]{1,8}\Z")

#: Advisory: it tells a worker whether the expected outcome is an edition. The
#: desk never acts on a command itself, so this is never dispatch.
#:
#: ``calendar`` is the second job -- the event book rather than the newspaper --
#: and it has to be here or the whole path is unreachable from outside: the
#: worker knows what to do with one, but nothing can queue it. That is exactly
#: how it was found, by the worker's own author noticing there was no way to
#: ask for the work that had just been built.
#:
#: ``ask`` is the phone's own kind -- a message typed by the owner, answered by
#: the worker, and sometimes an instruction to rewrite the edition. It is a
#: kind rather than a `custom` with a convention because two things downstream
#: read it: the worker's prompt, and the finish path that decides whether
#: anybody's phone rings.
#:
#: ``paper`` is the rotation's own kind -- a complete newspaper about a company
#: the desk names, filed for the index rather than for the glass. It is a kind
#: rather than a `file_edition` with a symbol because two things downstream
#: branch on it: the worker's prompt, which must suspend the contract's "which
#: company" rule, and the commit, which writes neither pointer.
COMMAND_KINDS: tuple[str, ...] = ("file_edition", "research", "custom",
                                  "calendar", "ask", "paper")

#: An instruction in the owner's own words, not a document.
MAX_COMMAND_TEXT: int = 2000

#: A directive is rendered into every agent run's prompt, so its length is a
#: recurring cost rather than a one-off.
MAX_DIRECTIVE_RULE: int = 500

#: The states a command can end in. Nothing leaves these.
_TERMINAL = ("done", "failed", "expired", "cancelled")

_SCHEMA = """
CREATE TABLE IF NOT EXISTS commands (
    id          TEXT PRIMARY KEY,
    kind        TEXT    NOT NULL,
    text        TEXT    NOT NULL,
    priority    INTEGER NOT NULL,
    status      TEXT    NOT NULL,
    source      TEXT    NOT NULL DEFAULT '',
    created_at  REAL    NOT NULL,
    deadline_at REAL,
    claimed_by  TEXT,
    claimed_at  REAL,
    finished_at REAL,
    attempts    INTEGER NOT NULL DEFAULT 0,
    result      TEXT    NOT NULL DEFAULT '',
    -- The thread. `reply_to` is the previous turn's command id and `lang` is
    -- the language the phone was in when the message was typed; NULL there
    -- means "the language of the message itself", which only the model can
    -- read. Both nullable, which is also what makes them addable by ALTER
    -- TABLE below without rewriting a row.
    reply_to    TEXT,
    lang        TEXT,
    -- Which company a `paper` is about. NULL on every other kind, which is
    -- what makes it addable by ALTER TABLE below without rewriting a row.
    -- The desk decides the company for a paper and the model does not, so
    -- this is the instruction rather than a hint about it.
    symbol      TEXT
);
-- The claim's subquery is exactly this order, and it runs on every long poll.
CREATE INDEX IF NOT EXISTS commands_queue
    ON commands (status, priority, created_at);

CREATE TABLE IF NOT EXISTS directives (
    id          TEXT PRIMARY KEY,
    rule        TEXT NOT NULL,
    scope       TEXT NOT NULL,
    expires_at  REAL,
    source      TEXT NOT NULL DEFAULT '',
    created_at  REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS editions (
    id           TEXT PRIMARY KEY,
    meta         TEXT NOT NULL,
    created_at   REAL NOT NULL,
    published_at REAL
);

-- Every publish, not just the last one. An edition can be promoted back, so
-- "when did this edition last reach the glass" and "when did anything last
-- reach the glass" are different questions and min_gap_minutes asks the second.
CREATE TABLE IF NOT EXISTS publishes (
    seq        INTEGER PRIMARY KEY AUTOINCREMENT,
    edition_id TEXT NOT NULL,
    at         REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- What has already been said to which phone. The primary key IS the promise:
-- one notification per device per event per lead, ever. It is a table rather
-- than something the scheduler holds in memory because the failure it prevents
-- is a restart -- a desk that came back up and told the owner a second time
-- about the same expiry, which reads on a lock screen as the desk being broken
-- and cannot be undone.
--
-- The token is here and nowhere else in this database. It is not served: no
-- route reads this table, `state()` does not count it, and `audit` must never
-- carry one. See `push.py`'s module docstring for why a push token is a
-- capability rather than an identifier.
CREATE TABLE IF NOT EXISTS deliveries (
    token    TEXT NOT NULL,
    event_id TEXT NOT NULL,
    lead     TEXT NOT NULL,
    at       REAL NOT NULL,
    PRIMARY KEY (token, event_id, lead)
);
-- Both reads are windows on `at`: the scheduler asks for the recent rows every
-- time something is due, and housekeeping deletes the old ones.
CREATE INDEX IF NOT EXISTS deliveries_at ON deliveries (at);

CREATE TABLE IF NOT EXISTS audit (
    seq    INTEGER PRIMARY KEY AUTOINCREMENT,
    at     REAL NOT NULL,
    event  TEXT NOT NULL,
    detail TEXT NOT NULL
);
"""

_COMMAND_COLUMNS = ("id", "kind", "text", "priority", "status", "source",
                    "created_at", "deadline_at", "claimed_by", "claimed_at",
                    "finished_at", "attempts", "result", "reply_to", "lang",
                    "symbol")

#: Columns added to a table after this desk first shipped, as
#: ``(table, column, declaration)``.
#:
#: ``CREATE TABLE IF NOT EXISTS`` does exactly nothing to a table that already
#: exists, so a column added to :data:`_SCHEMA` alone reaches a fresh database
#: and no other. The failure that causes is not a startup error, which somebody
#: would notice -- it is ``no such column: reply_to`` raised on the first
#: message sent from the phone, on a desk that has been serving since August.
#:
#: Every entry must be nullable and carry no default. That is what makes
#: ``ALTER TABLE ... ADD COLUMN`` a metadata-only write on SQLite rather than a
#: rewrite of every row in the table.
_ADDED_COLUMNS: tuple[tuple[str, str, str], ...] = (
    ("commands", "reply_to", "TEXT"),
    ("commands", "lang", "TEXT"),
    ("commands", "symbol", "TEXT"),
)

#: The claim, and the reason it is one statement.
#:
#: Two statements -- SELECT the oldest pending id, then UPDATE it -- is a race
#: with a window between them, and on this system the race surfaces as one
#: instruction filing two editions and a wall that flashes twice, twenty-five
#: seconds each, in front of somebody who asked for one page. RETURNING is what
#: makes the winner learn it won inside the same statement that made it true;
#: without it the winner would have to read back, which reopens the window it
#: just closed.
_CLAIM_SQL = """
UPDATE commands
   SET status = 'claimed', claimed_by = ?, claimed_at = ?, attempts = attempts + 1
 WHERE id = (SELECT id FROM commands
              WHERE status = 'pending'
                AND (deadline_at IS NULL OR deadline_at > ?)
              ORDER BY priority ASC, created_at ASC
              LIMIT 1)
RETURNING *
"""


class Store:
    """The desk's one database.

    One instance per process; share it across threads. ``path`` is created
    along with its parent directories, because ``/data`` is an empty Docker
    volume the first time the desk comes up and a desk that will not start on a
    fresh volume is a desk nobody can deploy.
    """

    def __init__(self, path: str, clock: Clock) -> None:
        self._clock = clock
        self._lock = threading.RLock()
        parent = os.path.dirname(os.path.abspath(path))
        os.makedirs(parent, exist_ok=True)
        # check_same_thread=False because every request thread uses this one
        # connection; the RLock above is what makes that safe, and the module
        # docstring says why it is one connection rather than one per thread.
        # isolation_level=None hands transaction control to _write().
        self._db = sqlite3.connect(path, check_same_thread=False,
                                   isolation_level=None, timeout=5.0)
        self._db.row_factory = sqlite3.Row
        # WAL so a long poll reading the queue never blocks the publish path
        # writing it. busy_timeout is the other half: SQLite allows one writer,
        # and five seconds is longer than any write here takes by three orders
        # of magnitude, so a busy error means something is genuinely wedged.
        self._db.execute("PRAGMA journal_mode=WAL")
        self._db.execute("PRAGMA busy_timeout=5000")
        # Outside _write(): executescript() commits whatever transaction is
        # open before it starts, so wrapping it would leave the COMMIT at the
        # end of _write() with nothing to commit. Every statement in the script
        # is IF NOT EXISTS, so twenty processes opening the file at once is a
        # race with no losing side.
        self._db.executescript(_SCHEMA)
        self._migrate()

    def close(self) -> None:
        """Close the connection. Idempotent."""
        with self._lock:
            self._db.close()

    def _migrate(self) -> None:
        """Add the columns :data:`_SCHEMA` has gained since a database was made.

        Outside :meth:`_write` for ``executescript``'s reason: this runs in the
        constructor, before anything can be contending for the file, and each
        statement is guarded by its own read. Idempotent, so twenty processes
        opening the file at once is a race with no losing side -- a second
        ``ADD COLUMN`` for a column that now exists is simply not issued.
        """
        for table, column, decl in _ADDED_COLUMNS:
            have = {row["name"] for row in
                    self._db.execute("PRAGMA table_info(%s)" % table)}
            if column not in have:
                self._db.execute("ALTER TABLE %s ADD COLUMN %s %s"
                                 % (table, column, decl))
        self._db.commit()

    def _checked_reply_to(self, reply_to: object) -> str | None:
        """The command this one answers, or ``None``.

        Checked for *existence* and not merely for shape, because the field's
        whole purpose is that a worker will fetch that row and put the earlier
        question and answer in front of the model. An id that names nothing is
        a thread the prompt would quietly lose a turn from, and the phone that
        sent it would never learn why.
        """
        if reply_to is None:
            return None
        if not isinstance(reply_to, str) or not COMMAND_ID_RE.match(reply_to):
            raise BadRequest(message="reply_to is a command id")
        with self._lock:
            row = self._db.execute("SELECT 1 FROM commands WHERE id = ?",
                                   (reply_to,)).fetchone()
        if row is None:
            raise BadRequest(message=f"no command {reply_to} to reply to")
        return reply_to

    # -- commands ----------------------------------------------------------

    def add_command(self, kind: str, text: str, priority: int = 5,
                    deadline_at: float | None = None, source: str = "",
                    reply_to: str | None = None,
                    lang: str | None = None,
                    symbol: str | None = None) -> dict:
        """File an intent for a worker to act on. Returns the command.

        The desk does not execute it. It holds it until something claims it,
        which is what keeps the desk ignorant of what research means and
        therefore able to survive the agent changing its mind about that.
        """
        if kind not in COMMAND_KINDS:
            raise BadRequest(message=f"kind {kind!r} is not one of {COMMAND_KINDS}")
        if not isinstance(text, str) or not text.strip():
            # A command is an instruction in the owner's own words. No words,
            # no instruction, and a worker that claims one has nothing to do
            # but burn an attempt.
            raise BadRequest(message="a command needs text")
        if len(text) > MAX_COMMAND_TEXT:
            raise BadRequest(message=f"{len(text)} characters, "
                                     f"limit {MAX_COMMAND_TEXT}")
        if not isinstance(priority, int) or isinstance(priority, bool) \
                or not 0 <= priority <= 9:
            raise BadRequest(message="priority is 0..9, 0 first")
        reply_to = self._checked_reply_to(reply_to)
        lang = _checked_lang(lang)
        symbol = _checked_symbol(kind, symbol)
        now = self._clock.now()
        row = {"id": _new_id(), "kind": kind, "text": text, "priority": priority,
               "status": "pending", "source": source or "", "created_at": now,
               "deadline_at": epoch_seconds(deadline_at, "deadline_at"),
               "claimed_by": None, "claimed_at": None, "finished_at": None,
               "attempts": 0, "result": "",
               "reply_to": reply_to, "lang": lang, "symbol": symbol}
        with self._write():
            self._db.execute(
                "INSERT INTO commands ({}) VALUES ({})".format(
                    ", ".join(_COMMAND_COLUMNS),
                    ", ".join("?" * len(_COMMAND_COLUMNS))),
                tuple(row[c] for c in _COMMAND_COLUMNS))
        return row

    def claim_command(self, worker: str) -> dict | None:
        """Take the next command for ``worker``, or ``None`` if there is none.

        Atomic against every other claimer in every other process -- see
        ``_CLAIM_SQL`` for why that is one statement and what the second
        statement would cost.

        It deliberately does not reap first. Reaping is the scheduler's
        housekeeping pass (:meth:`reap`), and folding it in here would make the
        claim two statements again to save a pass that runs anyway. That the
        pass is ten minutes apart rather than five seconds costs this nothing:
        the claim's own subquery already skips a command past its deadline, so
        what waits for the reap is a lapsed lease -- which is half an hour old
        by then and belongs to a worker that is not coming back.
        """
        now = self._clock.now()
        with self._write():
            cur = self._db.execute(_CLAIM_SQL, (worker, now, now))
            # Fetched before the COMMIT that _write() is about to issue:
            # committing with rows outstanding resets the statement, and a
            # RETURNING statement that is reset before it is drained has not
            # necessarily finished doing what it returned.
            rows = cur.fetchall()
        return dict(rows[0]) if rows else None

    def finish_command(self, cid: str, status: str, result: str = "") -> dict:
        """Report a claimed command ``done`` or ``failed``. Returns it."""
        if status not in ("done", "failed"):
            raise BadRequest(message="a command finishes 'done' or 'failed'")
        now = self._clock.now()
        with self._write():
            row = self._db.execute(
                "SELECT status FROM commands WHERE id = ?", (cid,)).fetchone()
            if row is None:
                raise NotFound(message=f"no command {cid}")
            if row["status"] in _TERMINAL:
                # Reporting on something already closed would overwrite the
                # record of how it closed, which is the only thing left that
                # explains the edition it did or did not produce.
                raise Conflict(message=f"command {cid} is already {row['status']}")
            self._db.execute(
                "UPDATE commands SET status = ?, result = ?, finished_at = ? "
                " WHERE id = ?", (status, result or "", now, cid))
        return self.get_command(cid)          # type: ignore[return-value]

    def cancel_command(self, cid: str) -> bool:
        """Cancel a *pending* command. ``False`` if it was not cancellable.

        A claimed command is refused: a worker is already running it, and
        marking it cancelled here would not stop that -- it would only lose the
        record of what the worker did when it reported back. ``False`` covers
        both "no such command" and "not pending"; :meth:`get_command` tells the
        caller which, and no caller so far needs to know.
        """
        with self._write():
            cur = self._db.execute(
                "UPDATE commands SET status = 'cancelled', finished_at = ? "
                " WHERE id = ? AND status = 'pending'", (self._clock.now(), cid))
            return cur.rowcount > 0

    def get_command(self, cid: str) -> dict | None:
        """One command by id, or ``None``."""
        with self._lock:
            row = self._db.execute(
                "SELECT * FROM commands WHERE id = ?", (cid,)).fetchone()
        return dict(row) if row is not None else None

    def list_commands(self, status: str | None = None, limit: int = 100) -> list[dict]:
        """Commands, in the order the queue itself would take them.

        Priority then FIFO rather than newest-first, because the question an
        operator asks of this list is "what happens next", and answering it in
        a different order from the one :meth:`claim_command` uses would make
        the list a second, wrong, description of the queue.
        """
        sql = "SELECT * FROM commands"
        args: list[object] = []
        if status is not None:
            sql += " WHERE status = ?"
            args.append(status)
        sql += " ORDER BY priority ASC, created_at ASC LIMIT ?"
        args.append(max(0, int(limit)))
        with self._lock:
            rows = self._db.execute(sql, tuple(args)).fetchall()
        return [dict(r) for r in rows]

    def reap(self) -> int:
        """Expire deadlines and lapsed leases. Returns how many rows moved.

        Two rules, in this order. A pending command past its ``deadline_at``
        expires rather than surfacing three days late -- "lead on last night's
        earnings" is worse than useless on Thursday. And a claim whose lease
        ran out goes back to ``pending`` unless it has already had
        :data:`MAX_ATTEMPTS`, in which case it fails: a worker that dies
        mid-edition costs one retry, and something that kills three workers in
        a row will kill the fourth.
        """
        now = self._clock.now()
        cutoff = now - LEASE_SECONDS
        with self._write():
            moved = self._db.execute(
                "UPDATE commands SET status = 'expired', finished_at = ? "
                " WHERE status = 'pending' AND deadline_at IS NOT NULL "
                "   AND deadline_at <= ?", (now, now)).rowcount
            moved += self._db.execute(
                "UPDATE commands SET status = 'failed', finished_at = ?, "
                "       result = 'lease expired after ' || attempts || ' attempts' "
                " WHERE status = 'claimed' AND claimed_at <= ? AND attempts >= ?",
                (now, cutoff, MAX_ATTEMPTS)).rowcount
            moved += self._db.execute(
                "UPDATE commands SET status = 'pending', claimed_by = NULL, "
                "       claimed_at = NULL "
                " WHERE status = 'claimed' AND claimed_at <= ?",
                (cutoff,)).rowcount
        return moved

    def pending_count(self) -> int:
        """How many commands are waiting to be claimed."""
        with self._lock:
            return int(self._db.execute(
                "SELECT COUNT(*) FROM commands WHERE status = 'pending'"
            ).fetchone()[0])

    def finished_since(self, t: float, source: str) -> list[dict]:
        """``done`` and ``failed`` commands from ``source`` that ended after ``t``.

        Oldest first, and bounded on purpose for
        :meth:`deliveries_since`' reason: the caller decides how far back an
        answer can still be owed, and an unbounded read would grow with the
        queue forever over rows nothing can act on. It runs on the scheduler's
        housekeeping pass, on the connection the publish path writes.

        ``expired`` and ``cancelled`` are excluded because neither is a worker's
        report: nobody wrote an answer, so there is nothing to announce.
        """
        since = epoch_seconds(t, "t")
        if since is None:
            raise BadRequest(message="a window starts at an instant")
        with self._lock:
            rows = self._db.execute(
                "SELECT * FROM commands "
                " WHERE source = ? AND finished_at IS NOT NULL "
                "   AND finished_at >= ? AND status IN ('done', 'failed') "
                " ORDER BY finished_at ASC", (source, since)).fetchall()
        return [dict(r) for r in rows]

    # -- directives --------------------------------------------------------

    def add_directive(self, rule: str, scope: str = "always",
                      expires_at: float | None = None, source: str = "") -> dict:
        """Add a standing instruction. Returns the directive.

        ``scope`` is ``always`` or ``until``, and the two disagree about
        ``expires_at`` on purpose: ``until`` without one is a rule that never
        ends written by somebody who meant it to, and ``always`` with one is
        the same mistake from the other side. Both are refused rather than
        interpreted, because either interpretation is somebody's surprise.
        """
        if scope not in ("always", "until"):
            raise BadRequest(message=f"scope {scope!r} is 'always' or 'until'")
        if not isinstance(rule, str) or not rule.strip():
            raise BadRequest(message="a directive needs a rule")
        if len(rule) > MAX_DIRECTIVE_RULE:
            raise BadRequest(message=f"{len(rule)} characters, "
                                     f"limit {MAX_DIRECTIVE_RULE}")
        expires_at = epoch_seconds(expires_at, "expires_at")
        if scope == "until" and expires_at is None:
            raise BadRequest(message="scope 'until' needs an expires_at")
        if scope == "always" and expires_at is not None:
            raise BadRequest(message="a rule that expires is scope 'until'")
        row = {"id": _new_id(), "rule": rule, "scope": scope,
               "expires_at": expires_at, "source": source or "",
               "created_at": self._clock.now()}
        with self._write():
            self._db.execute(
                "INSERT INTO directives (id, rule, scope, expires_at, source, "
                "created_at) VALUES (?, ?, ?, ?, ?, ?)",
                (row["id"], row["rule"], row["scope"], row["expires_at"],
                 row["source"], row["created_at"]))
        return row

    def list_directives(self) -> list[dict]:
        """The directives in force now, oldest first.

        Expired ones are excluded rather than deleted -- the row is the answer
        to "why did it stop covering that", which is a question asked weeks
        later. Order is the order they were written, because they are rendered
        into a prompt as prose and prose has an order.
        """
        now = self._clock.now()
        with self._lock:
            rows = self._db.execute(
                "SELECT * FROM directives "
                " WHERE expires_at IS NULL OR expires_at > ? "
                " ORDER BY created_at ASC, id ASC", (now,)).fetchall()
        return [dict(r) for r in rows]

    def delete_directive(self, did: str) -> bool:
        """Remove a directive. ``False`` if there was no such thing."""
        with self._write():
            return self._db.execute(
                "DELETE FROM directives WHERE id = ?", (did,)).rowcount > 0

    # -- editions ----------------------------------------------------------

    def record_edition(self, eid: str, meta: dict) -> None:
        """Remember an edition's ``meta.json``, keyed by its fingerprint.

        Recording the same id twice updates rather than duplicates: the id *is*
        the content, so the same id arriving again is the same edition arriving
        again -- promoted, say -- and two rows would show it twice in a list
        whose whole job is to be the history.
        """
        doc = dict(meta or {})
        doc["id"] = eid
        created = epoch_seconds(doc.get("created_at"), "created_at") or self._clock.now()
        doc["created_at"] = created
        published = epoch_seconds(doc.get("published_at"), "published_at")
        with self._write():
            self._db.execute(
                "INSERT INTO editions (id, meta, created_at, published_at) "
                "VALUES (?, ?, ?, ?) "
                "ON CONFLICT(id) DO UPDATE SET meta = excluded.meta, "
                "  created_at = excluded.created_at, "
                # A recorded-again edition must not lose the fact that it has
                # been on the glass; only a note_publish() sets that.
                "  published_at = COALESCE(excluded.published_at, editions.published_at)",
                (eid, json.dumps(doc, ensure_ascii=False), created, published))

    def get_edition(self, eid: str) -> dict | None:
        """One edition's meta, or ``None``."""
        with self._lock:
            row = self._db.execute(
                "SELECT * FROM editions WHERE id = ?", (eid,)).fetchone()
        return _edition_dict(row) if row is not None else None

    def list_editions(self, limit: int = 50) -> list[dict]:
        """Editions newest first -- the history, read the way a history is."""
        with self._lock:
            rows = self._db.execute(
                "SELECT * FROM editions ORDER BY created_at DESC, id DESC LIMIT ?",
                (max(0, int(limit)),)).fetchall()
        return [_edition_dict(r) for r in rows]

    def note_publish(self, eid: str, at: float) -> None:
        """Record that ``eid`` reached the glass at ``at``.

        The row goes in whether or not the edition is known here, because the
        publish is the fact and the metadata is the commentary.
        """
        when = epoch_seconds(at, "at")
        if when is None:
            raise BadRequest(message="a publish happens at an instant")
        with self._write():
            self._db.execute(
                "INSERT INTO publishes (edition_id, at) VALUES (?, ?)", (eid, when))
            self._db.execute(
                "UPDATE editions SET published_at = ? WHERE id = ?", (when, eid))

    def last_publish_at(self) -> float | None:
        """When anything last reached the glass, or ``None``.

        ``MAX(at)`` rather than the last row inserted: promoting an older
        edition writes a publish at the instant it happened, and
        ``min_gap_minutes`` is measured from the most recent refresh, not from
        whichever row was written last.
        """
        with self._lock:
            row = self._db.execute("SELECT MAX(at) FROM publishes").fetchone()
        return None if row is None or row[0] is None else float(row[0])

    # -- the delivery ledger -----------------------------------------------

    def record_delivery(self, token: str, event_id: str, lead: str,
                        at: float) -> None:
        """Remember that ``token`` was told about ``event_id`` at ``lead``.

        The row is written **after** the send comes back, for the ticket that
        succeeded and no other -- so a failed push is retried on the next tick
        from the rows that are not here yet, and a successful one is never
        sent twice however often the desk ticks or restarts.

        Recording the same key again keeps the first instant rather than
        moving it. The question this row answers weeks later is "when was I
        told", and the answer is the first time, not the last time something
        tried.
        """
        when = epoch_seconds(at, "at")
        if when is None:
            raise BadRequest(message="a delivery happens at an instant")
        with self._write():
            self._db.execute(
                "INSERT INTO deliveries (token, event_id, lead, at) "
                "VALUES (?, ?, ?, ?) "
                "ON CONFLICT(token, event_id, lead) DO NOTHING",
                (token, event_id, lead, when))

    def deliveries_since(self, t: float) -> list[dict]:
        """Every delivery at or after ``t``, oldest first.

        Bounded on purpose: the caller decides how far back can still change
        an answer (:data:`claudepost.alerts.LOOKBACK_SECONDS` derives it) and
        this runs on the scheduler's thread, so an unbounded read would grow
        with the ledger forever for rows that cannot suppress anything.
        """
        since = epoch_seconds(t, "t")
        if since is None:
            raise BadRequest(message="a window starts at an instant")
        with self._lock:
            rows = self._db.execute(
                "SELECT token, event_id, lead, at FROM deliveries "
                " WHERE at >= ? ORDER BY at ASC", (since,)).fetchall()
        return [dict(r) for r in rows]

    def reap_deliveries(self, before: float) -> int:
        """Delete delivery rows older than ``before``. Returns how many.

        Called from the tick's housekeeping pass, beside the queue's reap and
        the edition prune, rather than from a sweep of its own: what it
        measures is month-scale, and a DELETE every five seconds to find
        nothing is a write transaction on the connection the publish path
        uses.
        """
        cutoff = epoch_seconds(before, "before")
        if cutoff is None:
            raise BadRequest(message="a cutoff is an instant")
        with self._write():
            return self._db.execute(
                "DELETE FROM deliveries WHERE at < ?", (cutoff,)).rowcount

    # -- hold --------------------------------------------------------------

    def set_hold(self, until: float | None) -> None:
        """Refuse to publish until ``until``. ``None`` clears it."""
        if until is None:
            with self._write():
                self._db.execute("DELETE FROM meta WHERE key = 'hold_until'")
            return
        self.set_meta("hold_until", str(epoch_seconds(until, "until")))

    def get_hold(self) -> float | None:
        """The instant the hold ends, or ``None`` when nothing is held.

        A hold whose instant has passed reports ``None`` rather than the stale
        instant, so every caller is a plain truth test. The row is left alone:
        making a read take the write lock to tidy up would put a transaction on
        the serving path for no benefit anybody can see.
        """
        raw = self.get_meta("hold_until")
        if raw is None:
            return None
        until = float(raw)
        return until if until > self._clock.now() else None

    # -- notes to self -----------------------------------------------------

    def set_meta(self, key: str, value: str) -> None:
        """Remember a small string across restarts.

        This is the scheduler's scratch pad -- the last wake instant it
        enqueued, for one, which is what makes enqueueing idempotent when a
        tick runs every five seconds and a wake instant lasts a minute.
        """
        with self._write():
            self._db.execute(
                "INSERT INTO meta (key, value) VALUES (?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (key, str(value)))

    def get_meta(self, key: str) -> str | None:
        """Read back a :meth:`set_meta` value, or ``None``."""
        with self._lock:
            row = self._db.execute(
                "SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
        return None if row is None else str(row["value"])

    # -- audit -------------------------------------------------------------

    def audit(self, event: str, detail: dict) -> None:
        """Append to the audit log.

        Never put a credential in ``detail``, and never a copy of a document
        either. ``GET /api/audit`` is served to any ``producer`` token -- the
        weaker of the two -- so it is the least private place in the desk that
        still looks like a private one; and this table is the most durable,
        because nothing chmods the database it lives in and nothing reaps its
        rows. What a row says outlives the thing it is about. A count is the
        right size for that; a strike is not.
        """
        with self._write():
            self._db.execute(
                "INSERT INTO audit (at, event, detail) VALUES (?, ?, ?)",
                (self._clock.now(), event,
                 json.dumps(detail or {}, ensure_ascii=False, default=str)))

    def recent_audit(self, limit: int = 50) -> list[dict]:
        """The last ``limit`` events, newest first, with detail parsed back.

        ``seq`` is the table's own ``AUTOINCREMENT`` primary key, carried
        through rather than left as an internal detail -- it is what orders
        two events that land in the same clock tick, which ``at`` alone
        cannot do.
        """
        with self._lock:
            rows = self._db.execute(
                "SELECT seq, at, event, detail FROM audit ORDER BY seq DESC LIMIT ?",
                (max(0, int(limit)),)).fetchall()
        return [{"seq": r["seq"], "at": r["at"], "event": r["event"],
                 "detail": json.loads(r["detail"])}
                for r in rows]

    # -- internals ---------------------------------------------------------

    @contextmanager
    def _write(self) -> Iterator[None]:
        """Hold the lock and one ``BEGIN IMMEDIATE`` transaction.

        Immediate rather than deferred because a transaction that reads before
        it writes can fail with ``SQLITE_BUSY_SNAPSHOT``, and the busy handler
        does not retry that one -- so ``busy_timeout`` would be a setting that
        looks like it works until two processes claim at once.
        """
        with self._lock:
            self._db.execute("BEGIN IMMEDIATE")
            try:
                yield
            except BaseException:
                self._db.execute("ROLLBACK")
                raise
            self._db.execute("COMMIT")


def _new_id() -> str:
    """A random id. uuid4 because ids are handed to clients and must not count."""
    return uuid.uuid4().hex


def _checked_lang(lang: object) -> str | None:
    """A language the board can print, or ``None`` for "the message's own".

    ``None`` is a state rather than an omission: a typed message carries its
    own language, and this field only breaks a tie the model cannot -- a ticker
    on its own, say. So there is no default to fall back to here, which is the
    one way this differs from `settings`' own check.
    """
    if lang is None:
        return None
    if not isinstance(lang, str) or lang not in LANGS:
        raise BadRequest(message=f"lang: must be one of: {', '.join(LANGS)}")
    return lang


def _checked_symbol(kind: str, symbol: object) -> str | None:
    """The company a command is about, or ``None`` for the kinds that have none.

    Required on a ``paper`` and refused on everything else, which is two rules
    in one function because they are the same rule: the symbol *is* the paper's
    instruction, and on any other kind it is a field nothing reads. A
    ``file_edition`` carrying one would look to an operator like a board
    edition pinned to a company, which is precisely what it would not be.

    Upper-cased before it is matched, the way
    :func:`~claudepost.watchlist._symbol` does it, so this is the one place
    that decides what canonical means for a queue row.
    """
    if symbol is None:
        if kind == "paper":
            raise BadRequest(message="a paper command needs a symbol: "
                                     "the desk names the company, not the model")
        return None
    if kind != "paper":
        raise BadRequest(message=f"only a paper command carries a symbol, "
                                 f"not a {kind!r}")
    if not isinstance(symbol, str) or isinstance(symbol, bool):
        raise BadRequest(message="symbol is a ticker")
    sym = symbol.upper()
    if not COMMAND_SYMBOL_RE.match(sym):
        raise BadRequest(message=f"{symbol!r:.32} is not a symbol "
                                 f"(letters, digits, '.', '-', 1-8 characters, "
                                 f"at least one letter or digit)")
    return sym


def _edition_dict(row: sqlite3.Row) -> dict:
    """The stored meta, with the columns that are the store's own on top."""
    doc = json.loads(row["meta"])
    doc["id"] = row["id"]
    doc["created_at"] = row["created_at"]
    doc["published_at"] = row["published_at"]
    return doc
