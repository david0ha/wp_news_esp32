"""The desk object: everything wired together, and the one scheduler tick.

Two things live here and nothing else. :class:`Config` is where the environment
becomes values, so that no other module reads ``os.environ`` and a test can
build a desk in a temporary directory without touching the process. :class:`Desk`
owns the objects and the single periodic pass over them.

:meth:`Desk.tick` is deliberately a function of the clock rather than something
that sleeps. A scheduler that sleeps can only be tested by waiting, and the
interesting moments -- the instant a quiet window ends, the instant a wake fires
-- are exactly the ones a test must be able to step over. ``__main__`` calls it
every few seconds; the tests call it at whatever instant they want to examine.
"""

from __future__ import annotations

import datetime
import logging
import os
import re
import threading
from dataclasses import dataclass
from typing import Mapping

from . import (quotes as Q, schedule as sched, schedulefile,
               settings as st, watchlist as wl)
from .auth import Tokens
from .clock import Clock
from .editions import EditionStore
from .gates import Gates, SubprocessGates
from .notes import NoteStore
from .store import Store

#: The shape of a command id: `commands` table ids, the `NoteStore` this desk
#: hands their notes to, and every `/api/commands/<cid>/...` route in
#: `http.py` -- which imports this constant and builds its routes from it
#: rather than spelling `[0-9a-f]{8,64}` a second time, so the three cannot
#: drift apart. Editions' shape, because a command shares the queue's table
#: with nothing that has a shorter or longer id.
COMMAND_ID_RE = re.compile(r"^[0-9a-f]{8,64}\Z")

LOG = logging.getLogger("claudepost.app")

#: How late a missed wake may still fire. launchd runs a missed
#: StartCalendarInterval as soon as the machine wakes, and
#: agent/standalone/README.md names that as the thing that saves a board which
#: would otherwise show yesterday's paper because a lid was shut overnight. The
#: same argument applies to a desk that was down at 06:00 and came up at 06:04.
#: Half an hour is long enough to cover a restart and short enough that a desk
#: brought up at noon does not immediately file the morning paper.
WAKE_GRACE_SECONDS = 30 * 60

#: Sweeping drafts and pruning old editions are filesystem walks, and reaping
#: the queue is a write transaction. None of the three needs to happen at the
#: tick rate -- what they measure is hour-scale -- and doing them there would
#: put a directory scan and a transaction between the clock and a publish.
HOUSEKEEPING_SECONDS = 600


@dataclass
class Config:
    """Where everything is. The only place the environment is read."""

    data_dir: str
    tokens_path: str
    repo_dir: str
    host: str = "0.0.0.0"
    port: int = 8080
    keep_editions: int = 30
    #: Beside `tokens_path`, mounted the same read-only way. Defaulted to ""
    #: rather than left required: a desk with no key is a complete
    #: configuration (see `quotes.py`'s module docstring), and `Credentials("")`
    #: already resolves that to "no key" without a caller having to say so.
    alpaca_path: str = ""

    @staticmethod
    def from_env(env: Mapping[str, str]) -> "Config":
        """Build a config from the container's environment, with the image's defaults."""
        secrets = env.get("CLAUDEPOST_SECRETS", "/run/secrets")
        return Config(
            data_dir=env.get("CLAUDEPOST_DATA", "/data"),
            tokens_path=os.path.join(secrets, "tokens.json"),
            repo_dir=env.get("CLAUDEPOST_REPO", "/repo"),
            host=env.get("CLAUDEPOST_HOST", "0.0.0.0"),
            port=int(env.get("CLAUDEPOST_PORT", "8080")),
            keep_editions=int(env.get("CLAUDEPOST_KEEP_EDITIONS", "30")),
            alpaca_path=os.path.join(secrets, "alpaca.json"),
        )


class Desk:
    """The whole service, minus the HTTP surface.

    Construction is cheap and side-effect-light on purpose: it creates the data
    directory, opens the database and reads the schedule; everything else --
    reaping the queue, publishing anything overdue, sweeping drafts -- happens
    on the first :meth:`tick`. A constructor that walked the edition tree would
    make the process slow to start for work nobody is waiting on.
    """

    def __init__(self, cfg: Config, clock: Clock | None = None,
                 gates: Gates | None = None) -> None:
        self.cfg = cfg
        self.clock = clock or Clock()

        os.makedirs(cfg.data_dir, exist_ok=True)

        self.store = Store(os.path.join(cfg.data_dir, "desk.sqlite"), self.clock)
        self.gates = gates or SubprocessGates(cfg.repo_dir)
        self.editions = EditionStore(cfg.data_dir, self.gates, self.store, self.clock,
                                     keep=cfg.keep_editions)
        self.tokens = Tokens(cfg.tokens_path)

        #: The phone's prices, fetched with a key the phone never sees -- see
        #: `quotes.py`'s module docstring. `Credentials` reloads on change and
        #: never raises, so a desk with no `alpaca.json` is a complete
        #: configuration: `/api/quotes` answers `no_quotes` rather than the
        #: constructor failing.
        self.quotes = Q.QuoteService(Q.Credentials(cfg.alpaca_path), self.clock)

        # A command has no directory of its own the way a draft or an edition
        # does -- it is a row in `self.store` -- so its notes need somewhere to
        # live: one directory per command id under `notes/commands`, disjoint
        # from `editions/` and `drafts/` so nothing here can collide with the
        # notes those trees already keep beside their own payloads.
        # `COMMAND_ID_RE` rather than a pattern written fresh here, so the
        # route in `http.py` and the id this store will accept are the same
        # regex and cannot drift apart the way two copies of it could.
        self.notes = NoteStore(os.path.join(cfg.data_dir, "notes", "commands"),
                               COMMAND_ID_RE)

        #: Not a Config field, because no environment variable chooses it: the
        #: schedule belongs to the serving root the same way the database does,
        #: and a desk with two data roots is two desks.
        self.schedule_path = os.path.join(cfg.data_dir, "schedule.json")

        self.schedule = sched.DEFAULT_SCHEDULE
        self.schedule_source = "default"

        #: Same reasoning as `schedule_path`: the watchlist belongs to the
        #: serving root, not to an environment variable. Unlike the schedule
        #: there is no default to fall back on -- `self.watchlist` is `None`
        #: until an operator PUTs one, and stays `None` on a desk nobody has
        #: told, forever.
        self.watchlist_path = os.path.join(cfg.data_dir, "watchlist.json")
        self.watchlist: dict | None = None

        #: The third document read off the serving root, on `schedule_path`'s
        #: reasoning again -- and like the schedule rather than the watchlist,
        #: it has a default, because there is no state in which the paper has
        #: no language.
        self.settings_path = os.path.join(cfg.data_dir, "settings.json")

        self.settings = dict(st.DEFAULT)
        self.settings_source = "default"

        #: Notified whenever a command is enqueued, so a long poll wakes on the
        #: instruction rather than on its next timeout. The queue is in SQLite
        #: and could be polled, but a poll interval is latency nobody has to pay.
        self.queue_event = threading.Condition()

        self._last_housekeeping = 0.0

        self._load_schedule()
        self._load_watchlist()
        self._load_settings()

    # -- the periodic pass ------------------------------------------------
    def tick(self, now: float | None = None) -> list[str]:
        """One scheduler pass. Returns what it did, for the log and the tests.

        Every step is idempotent, because this runs every few seconds forever
        and because a desk that fired a wake once per tick would file twelve
        editions a minute.
        """
        t = self.clock.now() if now is None else now
        did: list[str] = []

        self.tokens.reload_if_changed()

        # No re-read of the schedule here. The desk is the only writer of
        # schedule.json, so polling it would be the desk watching its own
        # output -- and `set_schedule` has already applied anything a PUT
        # changed, in the same call that wrote the file.

        if self._fire_due_wake(t):
            did.append("wake")

        result = self.editions.publish_due(self.schedule, t)
        if result is not None:
            LOG.info("published %s (%s)", result.edition_id, result.reason)
            did.append("published:" + result.edition_id)

        if t - self._last_housekeeping >= HOUSEKEEPING_SECONDS:
            self._last_housekeeping = t
            # The reap goes here rather than on every tick because what it
            # measures is slow: a lease is half an hour and a deadline is
            # hour-scale, so a write transaction every five seconds to ask
            # whether either has passed is a transaction that finds nothing
            # all day -- on the same connection the publish path writes.
            expired = self.store.reap()
            if expired:
                did.append("reaped:%d" % expired)
            swept = self.editions.sweep_drafts()
            pruned = self.editions.prune()
            if swept or pruned:
                did.append("housekeeping:%d/%d" % (swept, pruned))

        return did

    # -- commands -----------------------------------------------------------
    def commands(self, status: str | None = None, limit: int = 100) -> list[dict]:
        """Commands, each carrying whether it has a note attached.

        The one place a queue row learns about its note, so that
        `http.py`'s `h_list_commands` and `state()`'s `queue.recent` cannot
        answer the question two different ways. `self.store.list_commands`
        stays ignorant of `self.notes` the way it stays ignorant of
        `self.gates` -- the store is the queue's ledger and the note is
        evidence a worker filed beside an entry in it, not a column on the
        row.
        """
        rows = self.store.list_commands(status=status, limit=limit)
        for row in rows:
            row["has_notes"] = self.notes.has(row["id"])
        return rows

    # -- state ------------------------------------------------------------
    def state(self) -> dict:
        """The ``GET /api/state`` document: what the desk is doing, not what the paper says.

        The edition itself is at the URL the board polls, which any client can
        fetch as easily as the board can -- the same division ``/api/state`` on
        the device already makes.
        """
        t = self.clock.now()
        current = self.editions.current_id()
        staged = self.editions.staged_id()
        hold = self.store.get_hold()
        nxt = sched.next_transition(self.schedule, t)

        return {
            "ok": True,
            "now": int(t),
            "current": current,
            "staged": staged,
            "lastPublishAt": as_int(self.store.last_publish_at()),
            "hold": as_int(hold if hold and hold > t else None),
            "scheduleSource": self.schedule_source,
            "schedule": sched.schedule_to_dict(self.schedule),
            "policy": {
                "pollSeconds": sched.effective_poll_seconds(self.schedule, t),
                "quiet": sched.is_quiet(self.schedule, t),
            },
            "nextTransition": ({"at": int(nxt[0]), "what": nxt[1]} if nxt else None),
            "watchlist": {
                # `or None`, because a watchlist written by something other
                # than this desk's own PUT carries no `updated_at` and
                # `wl.load` fails that field soft, to `0`. On this wire `0` is
                # not "no instant", it is the Unix epoch -- a client rendering
                # it shows 1 January 1970 as the day the list was last touched.
                # `int|null`, and `null` is what "there is no instant here"
                # actually says.
                "updatedAt": ((self.watchlist["updated_at"] or None)
                              if self.watchlist else None),
                "count": len(self.watchlist["items"]) if self.watchlist else 0,
            },
            "queue": {
                "pending": self.store.pending_count(),
                "recent": self.commands(limit=5),
            },
            "editions": self.store.list_editions(limit=5),
        }

    def set_schedule(self, s: sched.Schedule) -> None:
        """Write ``s`` down, then put it in force -- in that order.

        The file first: it is what the next desk reads, so a crash between the
        write and the assignment loses nothing, while the other order would
        lose the whole edit. A write that fails raises out of here and out of
        the PUT that called it -- the schedule in force is then still the old
        one, which is exactly what the operator will find on disk.

        This exists so that no caller sets ``schedule`` and ``schedule_source``
        by hand. Two attributes of another object, assigned from a request
        handler, is one refactor away from a desk running on a schedule nobody
        wrote down.
        """
        schedulefile.save(self.schedule_path, s)
        self.schedule = s
        self.schedule_source = "file"

    def set_watchlist(self, doc: dict) -> None:
        """Write ``doc`` down, then put it in force -- in that order.

        Same ordering argument as :meth:`set_schedule`: the file first, so a
        crash between the write and the assignment loses nothing, while the
        other order would lose the whole edit. A write that fails raises out
        of here and out of the PUT that called it, leaving ``self.watchlist``
        exactly what it was before.
        """
        wl.save(self.watchlist_path, doc)
        self.watchlist = doc

    def set_settings(self, doc: dict) -> None:
        """Write ``doc`` down, then put it in force -- in that order.

        The schedule's ordering argument, for the same reason: the file is
        what the next desk reads, so a crash between the write and the
        assignment loses nothing, while the other order would lose the whole
        edit. A write that fails raises out of here and out of the PUT that
        called it, leaving the language in force exactly what it was.

        ``doc`` is trusted to have been through
        :func:`~claudepost.settings.parse_settings` already, which is what
        makes assigning ``settings_source`` here honest: the file on disk and
        the dict in memory are the same document.
        """
        st.save(self.settings_path, doc)
        self.settings = doc
        self.settings_source = "file"

    def close(self) -> None:
        """Release the database. Serving state on disk is already durable."""
        self.store.close()

    # -- internals --------------------------------------------------------
    def _load_schedule(self) -> None:
        """Read the schedule off disk, and say in the log what came back.

        Called once, from the constructor: nothing else re-reads the file,
        because nothing else writes it.
        """
        self.schedule, self.schedule_source = schedulefile.load(self.schedule_path)
        LOG.info("schedule from %s: %s, publish=%s, quiet=%s",
                 self.schedule_source, self.schedule.timezone,
                 self.schedule.publish_policy,
                 [(w.start, w.end) for w in self.schedule.quiet])

    def _load_watchlist(self) -> None:
        """Read the watchlist off disk, and say in the log what came back.

        Called once, from the constructor, for :meth:`_load_schedule`'s reason:
        the desk is the only writer of the file, so nothing re-reads it.

        The line earns its place more than the schedule's does. ``wl.load``
        answers ``None`` both for a desk nobody has ever told and for a file it
        refused, with only a ``claudepost.watchlist`` warning to tell them
        apart -- so without this, a desk that came up having silently dropped
        somebody's watchlist reads in its own log exactly like a desk that
        never had one. Those are different things to go and fix.
        """
        self.watchlist = wl.load(self.watchlist_path)
        if self.watchlist is None:
            LOG.info("watchlist: none at %s", self.watchlist_path)
            return
        LOG.info("watchlist %s (%d items, updated %s)",
                 self.watchlist_path, len(self.watchlist["items"]),
                 _stamp(self.watchlist["updated_at"]))

    def _load_settings(self) -> None:
        """Read the settings off disk, and say in the log what came back.

        Called once, from the constructor, for :meth:`_load_schedule`'s
        reason: the desk is the only writer of the file, so nothing re-reads
        it.

        The line earns its place the way the watchlist's does. ``st.load``
        answers the default both for a desk nobody has ever told and for a
        file it refused, with only a ``claudepost.settings`` warning to tell
        them apart -- so without this, a desk printing English because it
        silently dropped a hand-edited ``settings.json`` reads in its own log
        exactly like a desk nobody has ever told. Those are different things
        to go and fix.
        """
        self.settings, self.settings_source = st.load(self.settings_path)
        LOG.info("settings from %s: lang=%s",
                 self.settings_source, self.settings["lang"])

    def _fire_due_wake(self, t: float) -> bool:
        """Enqueue one ``file_edition`` command per wake instant, at most once.

        The instant itself is the idempotency key, stored in the database rather
        than held in memory, so a restart between two wakes does not re-fire the
        one that already fired.
        """
        last = _last_wake_at(self.schedule, t)
        if last is None or t - last > WAKE_GRACE_SECONDS:
            return False

        key = "%d" % int(last)
        if self.store.get_meta("last_wake") == key:
            return False

        self.store.set_meta("last_wake", key)
        # Deadline it to the *next* wake instant, not None. Without this, a
        # wake nobody claims sits `pending` forever -- a desk left unstaffed
        # for ten days once queued seventeen of these, and a worker that
        # finally started up would have spent its first ~11 hours filing
        # editions for companies ten days stale. `Store.reap()` already
        # expires anything past its `deadline_at` (see its docstring: "lead
        # on last night's earnings is worse than useless on Thursday"); this
        # is what gives it something to expire. `next_wake` returning `None`
        # (a schedule with no further wake) is fine -- the store treats no
        # deadline as no deadline, same as today.
        self.enqueue(
            "file_edition",
            "Scheduled wake. File today's edition — pick the company, research it, "
            "and write both pages.",
            priority=5, source="schedule",
            deadline_at=sched.next_wake(self.schedule, last))
        LOG.info("wake at %d: enqueued a filing", int(last))
        return True

    def enqueue(self, kind: str, text: str, priority: int = 5,
                deadline_at: float | None = None, source: str = "api") -> dict:
        """Add a command and wake anything parked on a long poll."""
        command = self.store.add_command(kind, text, priority=priority,
                                         deadline_at=deadline_at, source=source)
        with self.queue_event:
            self.queue_event.notify_all()
        return command


def _last_wake_at(s: sched.Schedule, t: float) -> float | None:
    """The most recent wake instant at or before ``t``.

    ``schedule`` exposes only ``next_wake``, which is the right primitive for
    everything else, so this walks forward from a day earlier and keeps the last
    instant that has not passed ``t`` yet. A schedule holds at most twelve wakes
    a day, so this is a dozen-odd iterations and no new public surface on the
    module that owns the arithmetic.
    """
    cursor = t - 25 * 3600
    last: float | None = None
    for _ in range(64):
        nxt = sched.next_wake(s, cursor)
        if nxt is None or nxt > t:
            return last
        last = nxt
        cursor = nxt
    return last


def _stamp(when: int) -> str:
    """An epoch second as a UTC timestamp, for a log line a human reads.

    Spelled the way ``schedule.describe`` spells its ``utc`` field, so the two
    places this desk prints an instant for a person print it the same way.

    ``0`` is ``"never"`` rather than 1 January 1970. A watchlist written by
    something other than this desk's own PUT carries no instant, and a date is
    a worse answer than the absence of one -- the same distinction
    :meth:`Desk.state` makes by sending ``null``.
    """
    if not when:
        return "never"
    return datetime.datetime.fromtimestamp(
        when, datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def as_int(value: float | None) -> int | None:
    """Epoch seconds as an integer, or ``None``. Nothing on this wire is a float.

    Public because ``http.py`` answers a hold with the same shape ``state()``
    reports one in, and two roundings of one instant is a state document and a
    response that disagree by a second.
    """
    return None if value is None else int(value)
