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
import threading
from dataclasses import dataclass
from typing import Mapping

from . import (alerts, calendar as cal, econ, positions as pos, push,
               quotes as Q, schedule as sched, schedulefile,
               settings as st, watchlist as wl)
from .auth import Tokens
from .clock import Clock
from .editions import EditionStore
from .gates import Gates, SubprocessGates
from .notes import NoteStore
# `COMMAND_ID_RE` is imported rather than defined here, and re-exported by being
# imported: `http.py` says `from .app import COMMAND_ID_RE` and `Desk.notes` is
# built from it, so the route's pattern, the note store's and the queue's are one
# regex. It moved to `store` because `add_command` now checks a `reply_to`
# against it, and `store` cannot import `app` -- `app` imports `store`.
from .store import COMMAND_ID_RE, Store

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

#: The ``source`` a command carries when the phone filed it, and the only source
#: whose finish rings anybody. ``source`` is free text on every other path --
#: ``api``, ``schedule``, whatever a curl said -- so this is a convention rather
#: than an enum, and it is stated once here because the app writes it and the
#: finish path reads it. A typo in either is a notification that never arrives
#: and nothing anywhere that says why.
PHONE_SOURCE = "app"

#: What the rotation writes on a paper order. The worker's prompt reads the
#: company off the command's ``symbol`` column and not out of this sentence --
#: this is what an operator sees in the queue, and what the model is told the
#: run is for.
PAPER_ORDER = ("Refresh the paper for {s}. The company is given; "
               "research it and write both pages.")

#: How far back the answer pass looks, and how far back its ledger read goes.
#: Derived rather than chosen: the longest a quiet window can hold an answer is
#: a minute short of a day (`push._quiet` refuses a window with no width), and
#: the slack is for a desk that was down across one. Past this the notification
#: expires -- never the answer, which the phone polls while its thread is open
#: and reads from the command on its next launch besides.
ANSWER_WINDOW_SECONDS = 36 * 3600


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

        #: investing.com, cached, on the desk's own clock. No credential and
        #: therefore no `Config` field: unlike `quotes`, there is nothing to
        #: read and nothing to be missing, so a desk always has one of these
        #: and `GET /api/econ` is answerable on every desk that can reach the
        #: internet.
        self.econ = econ.EconSource(self.clock)

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

        #: The fourth operator document, after the schedule, the watchlist and
        #: the standing directives -- and the third of the four kept as a file
        #: under the serving root, on `schedule_path`'s reasoning again (the
        #: directives are rows in the store). Like the schedule rather than the
        #: watchlist it has a default, because there is no state in which the
        #: paper has no language.
        self.settings_path = os.path.join(cfg.data_dir, "settings.json")

        self.settings = dict(st.DEFAULT)
        self.settings_source = "default"

        #: The three documents this feature adds, on `schedule_path`'s
        #: reasoning again -- they belong to the serving root rather than to an
        #: environment variable -- and on the watchlist's for the `None`: there
        #: is no default book of positions, no default event book and no
        #: default list of phones, and a desk nobody has told holds none of the
        #: three forever.
        #:
        #: Two of them are 0600 where the schedule and the watchlist are not,
        #: and that is the modules' own doing (`positions.save`, `push.save`,
        #: `calendar.save`) rather than something this constructor arranges: a
        #: watchlist is a list of companies, and these are what the owner
        #: holds, what is about to happen to it, and how to reach their phone.
        self.positions_path = os.path.join(cfg.data_dir, "positions.json")
        self.positions: dict | None = None

        self.calendar_path = os.path.join(cfg.data_dir, "calendar.json")
        self.calendar: dict | None = None

        #: What the last read of that file removed, by cause -- see
        #: `calendar.Dropped`. All zeroes for a book nobody has filed and for
        #: one nothing was removed from, which is the whole reason it exists as
        #: counts rather than a flag: `calendar` is `None` for "nobody filed
        #: one", for "every date in the one on disk has passed" and for "it was
        #: all about positions that are gone", and a desk that reported those
        #: three identically is the defect they count against. Set by
        #: `_load_calendar` and cleared by anything that replaces the book,
        #: because it is a fact about a read rather than about the desk.
        self.calendar_dropped = cal.Dropped()

        self.push_path = os.path.join(cfg.data_dir, "push.json")
        self.push_devices: dict | None = None

        #: Held across the *read* and the *write* of `push.json`, and it is the
        #: only document on this desk that needs one. Every other setter takes
        #: a whole document a PUT already carried, so two callers race to
        #: decide which of two complete books wins and the loser knows it lost.
        #: Registering a phone is the one read-modify-write here: the body is
        #: one device and the handler merges it into the list it just read, so
        #: two phones registering in the same instant on a threading server
        #: would each merge into the same *pre*-merge list and the second write
        #: would erase the first. What that failure looks like from outside is
        #: a phone that registered successfully, was told 200, and then never
        #: rings -- which is the class of bug this feature can least afford,
        #: because nothing about it looks broken.
        self.push_lock = threading.Lock()

        #: Consecutive failed sends, per push token, held in memory and
        #: written by `_fire_due_alerts`. In memory because it is a fact about
        #: this process's last few minutes rather than about the household: a
        #: restart is exactly when the streak should start again, and a streak
        #: persisted into `push.json` would be a field the phone GETs and PUTs
        #: back. The tokens are keys here and reach no wire -- see `state()`.
        self.push_failures: dict[str, int] = {}

        #: How a push actually leaves this machine. An attribute rather than
        #: `push.send`'s own default left implicit, for the reason
        #: `EconSource` takes a `fetch` and `Desk.quotes` can be replaced by a
        #: stub: every test of the firing has to run without a socket, and the
        #: alternative -- patching a module function from a test -- makes the
        #: seam invisible from here. It names `push`'s private default
        #: deliberately: this is the one caller that has to spell the module's
        #: own answer rather than take it, and an alias for it would be a
        #: second name for one function.
        self.push_fetch: push.Fetch = push.DEFAULT_FETCH

        #: Notified whenever a command is enqueued, so a long poll wakes on the
        #: instruction rather than on its next timeout. The queue is in SQLite
        #: and could be polled, but a poll interval is latency nobody has to pay.
        self.queue_event = threading.Condition()

        self._last_housekeeping = 0.0

        self._load_schedule()
        self._load_watchlist()
        self._load_settings()
        # In this order, and it is not alphabetical: `calendar.load` prunes
        # away reasoning about positions the desk does not hold, so it has to
        # be told what this desk holds first. A calendar loaded before the
        # positions would be pruned against an empty set -- every event
        # orphaned, no book, every boot, silently.
        self._load_positions()
        self._load_calendar()
        self._load_push_devices()

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

        fired = self._fire_due_alerts(t)
        if fired:
            did.append(fired)

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
            # The delivery ledger ages out here rather than in a sweep of its
            # own: sixty days is the slowest thing this desk measures, and a
            # second periodic pass to watch it would be a second thing to keep
            # in step with this one.
            aged = self.store.reap_deliveries(t - alerts.RETENTION_SECONDS)
            if swept or pruned or aged:
                did.append("housekeeping:%d/%d/%d" % (swept, pruned, aged))

            # On the housekeeping pass rather than every tick: what this waits
            # for is a quiet window ending, which is hour-scale, so ten minutes
            # of grain costs an answer nothing -- where a query every five
            # seconds to find nothing all day would be a read on the connection
            # the publish path writes.
            owed = self._fire_owed_answers(t)
            if owed:
                did.append("answers:%d" % owed)

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

    def command(self, cid: str) -> dict | None:
        """One command, carrying whether it has a note attached, or ``None``.

        :meth:`commands`' answer for one row, and it exists rather than being
        left to the caller for that method's reason: `has_notes` is decided in
        one place, so the queue's list, `state()`'s `queue.recent` and the
        phone's poll of a single thread cannot answer the question three ways.
        """
        row = self.store.get_command(cid)
        if row is None:
            return None
        row["has_notes"] = self.notes.has(cid)
        return row

    def finish(self, cid: str, status: str, result: str = "") -> dict:
        """Report a claimed command ``done`` or ``failed``, and tell the phone.

        The store settles the row; the push is this method's whole reason for
        existing, and it is **wrapped**. The caller is the worker's own
        ``POST /api/commands/<id>/done``, and the 200 it gets back is what stops
        the worker retrying: a phone that does not ring costs an answer somebody
        opens the app for, where a ``done`` that 500s costs the entire command
        run a second time -- which on an `ask` that revised the paper means the
        paper revised twice.
        """
        command = self.store.finish_command(cid, status, result)
        if command.get("source") == PHONE_SOURCE:
            try:
                self._send_answer(command, self.clock.now())
            except Exception as exc:                               # noqa: BLE001
                # `push.send` has already logged the redacted detail. Nothing
                # is recorded, so this stays owed and `_send_owed_answers`
                # picks it up on the next housekeeping pass.
                LOG.warning("answer: the push for %s did not go (%s)",
                            cid, type(exc).__name__)
        return command

    def _send_answer(self, command: Mapping, t: float) -> int:
        """Tell every phone that wants it that this command has an answer.

        Returns how many left. Idempotent through the same delivery ledger the
        alerts use, keyed ``(token, "cmd:"+cid, "0")`` -- so a desk that
        restarted between the finish and the sweep, or a sweep overlapping a
        finish, sends one notification rather than two.

        A device inside its quiet window is skipped and **nothing is recorded
        for it**, which is exactly what leaves it owed: `_send_owed_answers`
        picks it up once the window ends. Deferred, never dropped, the rule
        `alerts.quiet_release`'s callers already hold for an alert.
        """
        cid = command["id"]
        event_id = push.answer_event_id(cid)
        devices = (self.push_devices or {}).get("devices") or []
        if not devices:
            return 0

        already = {row["token"] for row
                   in self.store.deliveries_since(t - ANSWER_WINDOW_SECONDS)
                   if row["event_id"] == event_id}
        ready = [one for one in devices
                 if one["token"] not in already
                 and one["prefs"].get(push.ANSWER, True)
                 and alerts.quiet_release(one, t) is None]
        if not ready:
            return 0

        # `lang` is NULL when the phone did not say, which means "the language
        # of the message itself" -- something only the model that read it can
        # know. The desk's own setting is the nearest thing it has, and it is
        # already the language the paper is written in.
        lang = command.get("lang") or self.settings.get("lang")
        messages = [push.answer_message(one["token"], cid, command["status"],
                                        command.get("result") or "", lang)
                    for one in ready]
        tickets = push.send(messages, fetch=self.push_fetch)

        sent = 0
        for one, ticket in zip(ready, tickets):
            token = one["token"]
            if not (isinstance(ticket, dict) and ticket.get("status") == "ok"):
                self.push_failures[token] = self.push_failures.get(token, 0) + 1
                continue
            self.push_failures.pop(token, None)
            self.store.record_delivery(token, event_id, push.ANSWER_LEAD, t)
            sent += 1

        self._forget_unregistered(tickets)
        return sent

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
            # The four rows this feature is visible on, and every one of them
            # is a count or a cause rather than a content. Not because this
            # route is weaker than the ones that serve those documents -- it
            # is not: `/api/state`, `GET /api/positions` and `GET /api/calendar`
            # are all `producer`, and the phone that writes the positions holds
            # the stronger token anyway. It is because a health document is not
            # a copy of the documents it reports on. Every reader of this one
            # is asking whether the desk is working, and answering that with a
            # strike, a reason or a push token would spread it into logs,
            # screenshots and terminal scrollback that nobody asked to hold it
            # -- and, for the push token, would put a capability to write on
            # the owner's lock screen in a status page.
            #
            # `shortfall` is the one string here, and it is the exception that
            # shows what the rule is about: it is the agent's sentence about
            # its own run rather than a field of the owner's book.
            "positions": {
                "count": len(self.positions["positions"]) if self.positions else 0,
            },
            "calendar": {
                "count": len(self.calendar["events"]) if self.calendar else 0,
                # What the last read of the file removed and why, because
                # `count` alone cannot say. Ten filed, one passed, nine live
                # reads as `count: 9` -- the same nine as a book that was
                # filed with nine -- and a book whose every event has passed
                # reads as `count: 0`, which is also what a desk nobody ever
                # filed to reads. These two separate all of it, and separating
                # it is the difference between a quiet desk and a broken one.
                # `reasons` stays out: it does not move `count`, and this is a
                # health document rather than a diff. The log has all three.
                "aged": self.calendar_dropped.aged,
                "orphaned": self.calendar_dropped.orphaned,
                # `or None` for the watchlist's reason: a book written by
                # something other than this desk's own PUT carries no instant
                # and `calendar.load` fails that field soft, to `""`. An empty
                # string on this wire is a client rendering a blank date; null
                # is "there is no instant here".
                "generatedAt": ((self.calendar["generated_at"] or None)
                                if self.calendar else None),
                # The agent's own sentence about what it could not cover.
                # Prose rather than a count, and it belongs here rather than
                # only in the book: a shortfall nobody reads is a book that
                # looks complete.
                "shortfall": self.calendar["shortfall"] if self.calendar else None,
            },
            "push": {
                "devices": len(self.push_devices["devices"]) if self.push_devices else 0,
                # The longest streak, not the map: `push_failures` is keyed by
                # token and the keys may not leave this process. One number
                # answers the question this row is for -- is push working --
                # and a per-phone breakdown would answer it by naming the
                # phones.
                "failures": max(self.push_failures.values(), default=0),
            },
            "econ": self.econ.health(),
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

    def printable_symbols(self) -> list[str]:
        """The companies the desk keeps a paper for, in the watchlist's order.

        ``printable`` and not every item: the watchlist carries companies the
        owner is only watching, and a paper costs the worker thirty to forty
        minutes. The order is the document's own, because it is the order the
        pager draws and the tiebreak the rotation uses -- an order decided
        here rather than there would be two answers to "which is first".

        ``[]`` on a desk with no watchlist, which is a real state: the vault
        pushes that document every morning and a desk brought up before the
        first push has none.
        """
        if not self.watchlist:
            return []
        return [item["symbol"] for item in self.watchlist["items"]
                if item["printable"]]

    def paper_cadence_seconds(self) -> int:
        """How old a paper may get before it is rewritten, in seconds.

        One function, because three callers ask -- the rotation's staleness
        test, the deadline it files with, and the ``stale`` flag the pager
        draws. Three spellings of ``hours * 3600`` is how a phone comes to
        badge a paper stale that the desk has no intention of refreshing.
        """
        return int(self.settings.get("paper_refresh_hours",
                                     st.DEFAULT["paper_refresh_hours"])) * 3600

    def papers(self, t: float | None = None) -> list[dict]:
        """One row per printable company, whether or not it has a paper.

        The row is the phone's whole model of a paper: which company, which
        edition, when it was written, what it is called, whether it is the one
        on the glass and whether it is due. A company with no paper is a row of
        nulls rather than an absence, because "not written yet" is a page the
        pager draws.
        """
        now = self.clock.now() if t is None else t
        cadence = self.paper_cadence_seconds()
        current = self.editions.current_id()
        items = [item for item in (self.watchlist["items"] if self.watchlist
                                   else [])
                 if item["printable"]]
        found = self.editions.papers([item["symbol"] for item in items])

        rows = []
        for item in items:
            meta = found.get(item["symbol"])
            eid = meta["id"] if meta else None
            try:
                created = float(meta["created_at"]) if meta else None
            except (KeyError, TypeError, ValueError):
                created = None
            rows.append({
                "symbol": item["symbol"],
                "name": item["name"],
                "edition_id": eid,
                "created_at": created,
                "lang": meta.get("lang") if meta else None,
                "headline": self.editions.headline(eid) if eid else None,
                "on_board": eid is not None and eid == current,
                # A company with no paper is stale by definition -- there is
                # nothing to be current -- which is also what puts it first in
                # the rotation's ordering.
                "stale": created is None or now - created >= cadence,
            })
        return rows

    def utc_now(self) -> datetime.datetime:
        """The desk's clock as an aware instant, for the validators that take one.

        :func:`~claudepost.calendar.parse_calendar` bounds an event against
        "now" and :func:`~claudepost.positions.parse_positions` bounds an
        expiry against "today". Both take theirs injected, and this is what
        makes the desk -- and ``http.py``'s handlers, which is why this is
        public -- hand them the clock it was built with rather than the
        wall's. The same reason :meth:`tick` takes an instant.
        """
        return datetime.datetime.fromtimestamp(self.clock.now(),
                                               datetime.timezone.utc)

    def position_ids(self) -> frozenset[str]:
        """Every id in the positions currently in force.

        One method rather than the comprehension spelled at each call site,
        because both callers are answering the same question and a difference
        between them is a book of events that validates on the way in and is
        refused on the next boot. :meth:`_load_calendar` asks it, and so does
        ``h_put_calendar`` -- which is what makes
        :mod:`~claudepost.calendar`'s fourth refusal reachable at all.
        """
        if not self.positions:
            return frozenset()
        return frozenset(one["id"] for one in self.positions["positions"])

    def set_positions(self, doc: dict) -> None:
        """Write ``doc`` down, then put it in force -- in that order.

        :meth:`set_schedule`'s ordering argument, for its reason: the file is
        what the next desk reads, so a crash between the write and the
        assignment loses nothing, while the other order would lose the whole
        edit. A write that fails raises out of here and out of the PUT that
        called it, leaving the book in force exactly what it was.

        ``doc`` is trusted to have been through
        :func:`~claudepost.positions.parse_positions` and stamped already.

        The event book is pruned to match, and neither of the two obvious
        alternatives is what happens here. Leaving it exactly as filed serves a
        book whose ``affects`` name positions that no longer exist for every
        hour between this PUT and the next boot, and the phone has nothing
        sensible to draw for one. Discarding the whole book throws away nine
        true statements because a tenth stopped being about anything. So
        :func:`~claudepost.calendar.prune_to_positions` drops exactly the
        reasoning that became false, and an event only when it has none left.

        The same function runs again inside :func:`~claudepost.calendar.load`,
        and this is still the place it matters: pruning here is what keeps the
        book in *memory* honest between now and the next boot, where the loader
        only ever repairs what somebody edited around the desk.

        This costs nothing on an ordinary edit, which is the part worth
        knowing: :func:`~claudepost.positions._id_material` leaves size, price
        and note outside the hash on purpose, so correcting an average or
        buying ten more shares cannot change an id and cannot lose a sentence.
        An id disappears when a position is closed or its contract changes, and
        those are exactly the times its reasoning stopped being true.
        """
        pos.save(self.positions_path, doc)
        self.positions = doc

        if self.calendar is not None:
            pruned, events_lost, affects_lost = cal.prune_to_positions(
                self.calendar, self.position_ids())
            if not pruned["events"]:
                # Nothing survived, so there is no book -- and a book with no
                # events is not a smaller book, it is a document that says
                # "nothing is coming" without the `shortfall` sentence that
                # would make that a claim somebody stood behind. Clearing it
                # puts the phone back on "no book yet", which is true, and the
                # next agent run refills it against the positions that now
                # exist. The desk does not write the sentence itself: that is
                # prose in the owner's language, and the desk does not have
                # one.
                self._forget_calendar()
                LOG.info("cleared the book: none of its %d event(s) reason "
                         "about a position still held", events_lost)
            elif events_lost or affects_lost:
                cal.save(self.calendar_path, pruned)
                self.calendar = pruned
                LOG.info("pruned the book to the positions now held "
                         "(-%d event(s), -%d reason(s))",
                         events_lost, affects_lost)

    def _forget_calendar(self) -> None:
        """Drop the book, from memory and from disk.

        The file goes too, rather than being left for :func:`load` to refuse on
        the next boot. A file the desk will not read is a file whose mtime lies
        to whoever is working out when research last happened.
        """
        self.calendar = None
        self.calendar_dropped = cal.Dropped()   # a fact about a read; this is not one
        try:
            os.remove(self.calendar_path)
        except OSError:
            pass                       # already gone, or never written

    def set_calendar(self, doc: dict) -> None:
        """Write ``doc`` down, then put it in force -- in that order.

        :meth:`set_positions`'s shape and its ordering argument. ``doc`` is
        trusted to have been through
        :func:`~claudepost.calendar.parse_calendar` against this desk's own
        :meth:`position_ids` and stamped already.
        """
        cal.save(self.calendar_path, doc)
        self.calendar = doc
        self.calendar_dropped = cal.Dropped()   # this is what the agent just filed

    def set_push_devices(self, doc: dict) -> None:
        """Write ``doc`` down, then put it in force -- in that order.

        :meth:`set_positions`'s shape again. ``doc`` is a whole
        ``{"devices": [...]}`` document that
        :func:`~claudepost.push.parse_devices` has already accepted, with
        every ``last_seen`` the caller meant to stamp already stamped: there
        is no top-level ``updated_at`` on this one to stamp instead, and a
        file carrying a key that document has no room for is a file
        :func:`~claudepost.push.load` refuses on the next boot -- which would
        read, from anywhere but the log, as push having quietly stopped
        working.
        """
        push.save(self.push_path, doc)
        self.push_devices = doc

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

    def _load_positions(self) -> None:
        """Read the positions off disk, and say in the log how many came back.

        :meth:`_load_watchlist`'s reasoning exactly, and it carries further
        here: ``positions.load`` answers ``None`` both for a desk nobody has
        told and for a file it refused, and a desk that came up having
        silently dropped the owner's book would go on to refuse the event book
        beside it -- every event in it reasons about an id that is now
        unknown -- so one unreadable file reads downstream as two empty
        features.

        The count and nothing else. A log line naming a symbol or a strike is
        the personal material this whole feature is arranged to keep off
        anything that gets copied around.
        """
        self.positions = pos.load(self.positions_path)
        if self.positions is None:
            LOG.info("positions: none at %s", self.positions_path)
            return
        LOG.info("positions %s (%d held, updated %s)", self.positions_path,
                 len(self.positions["positions"]),
                 self.positions["updated_at"] or "never")

    def _load_calendar(self) -> None:
        """Read the event book off disk, and say in the log what came back.

        Handed this desk's own clock and this desk's own positions, which are
        the two things the book is validated against -- see
        :meth:`position_ids` for the second and
        :func:`~claudepost.calendar.load` for the first.

        Three outcomes, and the log distinguishes all three because two of them
        used to be one line. A book, saying what was removed from it on the
        way; no book because nobody has filed one; and no book because nothing
        in the one on disk survived -- its dates have passed, or the positions
        it argued about are gone. That last is a desk with a file it will not
        use, and a boot that reported it as "none at <path>" was the whole of
        what a reader got told.
        """
        self.calendar, self.calendar_dropped = cal.load(
            self.calendar_path, known_position_ids=self.position_ids(),
            now=self.utc_now())
        lost = self.calendar_dropped
        why = ", ".join(
            "%d %s" % (n, word) for n, word in
            ((lost.aged, "passed"), (lost.orphaned, "about closed positions"),
             (lost.reasons, "reason(s) dropped")) if n)
        if self.calendar is None:
            if why:
                LOG.info("calendar %s: nothing survived the read (%s); no book",
                         self.calendar_path, why)
            else:
                LOG.info("calendar: none at %s", self.calendar_path)
            return
        LOG.info("calendar %s (%d events%s, generated %s)", self.calendar_path,
                 len(self.calendar["events"]), " -- %s" % why if why else "",
                 self.calendar["generated_at"] or "never")

    def _load_push_devices(self) -> None:
        """Read the registered phones off disk, and say how many there are.

        The count, never a token: this line goes to a log that gets pasted
        into a terminal, and a push token is a capability to write on the
        owner's lock screen from anywhere with no further credential.
        """
        self.push_devices = push.load(self.push_path)
        if self.push_devices is None:
            LOG.info("push: no devices at %s", self.push_path)
            return
        LOG.info("push %s (%d device(s))", self.push_path,
                 len(self.push_devices["devices"]))

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

    def _fire_due_alerts(self, t: float) -> str | None:
        """Tell the phones what is about to happen. Returns a ``did`` entry.

        Beside :meth:`_fire_due_wake` and under the same rule -- **idempotent**,
        because this runs every few seconds forever and a scheduler that fired
        once per tick would put the same notification on the owner's lock
        screen twelve times a minute. The idempotency is the delivery ledger
        rather than anything held in memory, so a restart between two ticks
        cannot re-deliver what the last one sent.

        **Every exception is caught here**, which is the one thing about this
        method that is not ordinary. A scheduler that died on a push failure
        would stop publishing the newspaper -- the publish and the housekeeping
        both run after this line -- and the failure it would die on is a
        network, which is to say a Tuesday. (The wake runs *before* it, and so
        is the one thing a push failure could not have cost.)

        The log line carries the exception's *type* and not its text, the rule
        :mod:`claudepost.econ` states as redaction by omission. There is no key
        to substitute for here, but the thing this path holds in its hands is a
        list of push tokens, and a message assembled by a library from
        something it was handed is exactly where one appears.
        """
        try:
            return self._send_due_alerts(t)
        except Exception as exc:                                   # noqa: BLE001
            LOG.warning("alerts: the pass failed (%s)", type(exc).__name__)
            return None

    def _send_due_alerts(self, t: float) -> str | None:
        """The pass itself. See :meth:`_fire_due_alerts` for why it is wrapped."""
        book = self.calendar
        devices = (self.push_devices or {}).get("devices") or []
        if not book or not devices:
            return None

        # The cheap question first, and it is the one asked almost every tick
        # forever: `alerts.due` is pure and touches nothing, so a desk with
        # nothing to announce finds that out without opening a read on the
        # database the publish path is writing.
        if not alerts.due(book, devices, (), t):
            return None

        delivered = self.store.deliveries_since(t - alerts.LOOKBACK_SECONDS)
        held = {one["token"]: one for one in devices}
        # `due` has already held back an alert whose lead instant fell inside a
        # quiet window. This is the other half: an alert the desk's own
        # lateness carried into one -- down when the lead passed, back at two
        # in the morning. Deferred, never dropped; it stays owed because
        # nothing is written for it.
        ready = [one for one in alerts.due(book, devices, delivered, t)
                 if alerts.defer_for_quiet(one, held[one.token], t) is None]
        if not ready:
            return None

        # One POST. What does not fit is owed, and the next tick is five
        # seconds away -- where a tick that sent everything would spend a
        # `push.UPSTREAM_TIMEOUT` per batch with the wake and the publish
        # waiting behind it.
        batch = ready[:alerts.MAX_PER_TICK]
        try:
            tickets = push.send([alerts.message(one) for one in batch],
                                fetch=self.push_fetch)
        except Exception as exc:                                   # noqa: BLE001
            # `push.send` has already logged the redacted detail of what went
            # wrong. Nothing is recorded, so every one of these is owed again
            # on the next tick -- which is what makes a network blip cost a
            # delay rather than a notification.
            for one in batch:
                self.push_failures[one.token] = \
                    self.push_failures.get(one.token, 0) + 1
            LOG.warning("alerts: %d owed, the batch did not leave (%s)",
                        len(batch), type(exc).__name__)
            return None

        sent = 0
        for alert, ticket in zip(batch, tickets):
            if not (isinstance(ticket, dict) and ticket.get("status") == "ok"):
                # Not recorded, so it is owed again next tick. A ticket that
                # says the phone is gone is dealt with below rather than
                # retried forever; every other error is about this attempt.
                self.push_failures[alert.token] = \
                    self.push_failures.get(alert.token, 0) + 1
                continue
            self.push_failures.pop(alert.token, None)
            self.store.record_delivery(alert.token, alert.event_id,
                                       alert.lead, t)
            sent += 1

        self._forget_unregistered(tickets)
        LOG.info("alerts: sent %d of %d owed", sent, len(ready))
        return "alerts:%d" % sent if sent else None

    def _fire_owed_answers(self, t: float) -> int:
        """Send the answer pushes a quiet window or a restart held back.

        **Every exception is caught**, `_fire_due_alerts`' rule and for its
        reason: the rest of the housekeeping and the publish run after this
        line, and the failure it would die on is a network, which is to say a
        Tuesday. The log line carries the exception's *type* and not its text,
        because what this path holds in its hands is a list of push tokens.
        """
        try:
            return self._send_owed_answers(t)
        except Exception as exc:                                   # noqa: BLE001
            LOG.warning("answers: the pass failed (%s)", type(exc).__name__)
            return 0

    def _send_owed_answers(self, t: float) -> int:
        """The pass itself. See :meth:`_fire_owed_answers` for why it is wrapped.

        The cheap question first, as the alert pass asks it: a desk with no
        phone registered finds that out without opening a read on the database.
        """
        if not (self.push_devices or {}).get("devices"):
            return 0
        sent = 0
        for command in self.store.finished_since(t - ANSWER_WINDOW_SECONDS,
                                                 PHONE_SOURCE):
            sent += self._send_answer(command, t)
        return sent

    def _forget_unregistered(self, tickets: list[dict]) -> None:
        """Drop the phones Expo says no longer exist.

        The lock is taken for the read-modify-write and **not** across the send
        that produced these tickets: ten seconds of a socket is not something
        to hold the registration route behind, and a phone that registered
        successfully and was told 200 while this waited would simply never
        ring.

        Only ``DeviceNotRegistered`` removes anything --
        :func:`~claudepost.push.prune_unregistered` is where that argument
        lives, and it is pure, so a pass that removes nothing writes nothing.
        """
        with self.push_lock:
            doc = self.push_devices or {"devices": []}
            kept, removed = push.prune_unregistered(doc, tickets)
            if removed:
                self.set_push_devices(kept)
                LOG.info("alerts: forgot %d phone(s) Expo no longer knows",
                         len(removed))
            # A streak for a phone that is gone is not a signal, it is a number
            # `state()` would go on reporting after the thing it was about
            # stopped existing.
            known = {one["token"] for one in kept["devices"]}
            for token in [one for one in self.push_failures if one not in known]:
                self.push_failures.pop(token, None)

    def enqueue(self, kind: str, text: str, priority: int = 5,
                deadline_at: float | None = None, source: str = "api",
                reply_to: str | None = None,
                lang: str | None = None,
                symbol: str | None = None) -> dict:
        """Add a command and wake anything parked on a long poll."""
        command = self.store.add_command(kind, text, priority=priority,
                                         deadline_at=deadline_at, source=source,
                                         reply_to=reply_to, lang=lang,
                                         symbol=symbol)
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


def utc_stamp(when: float) -> str:
    """An instant as the ``2026-09-08T05:00:00Z`` string three documents carry.

    Public for ``as_int``'s reason: ``http.py`` stamps ``positions``,
    ``calendar`` and each push device's ``last_seen`` with the desk's own
    clock, and all three modules match this exact twenty-character shape
    against a regex on the way back in. Two spellings of it would be a
    document a ``PUT`` accepted and the next boot's ``load`` refused, which is
    the failure those modules' ``_WIDEST_STAMP`` constants are sized against.

    Truncated to the second rather than rounded, because that is what the
    format prints and a stamp that rounded up would name an instant that has
    not happened yet.
    """
    return datetime.datetime.fromtimestamp(
        int(when), datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


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
    return utc_stamp(when)


def as_int(value: float | None) -> int | None:
    """Epoch seconds as an integer, or ``None``. Nothing on this wire is a float.

    Public because ``http.py`` answers a hold with the same shape ``state()``
    reports one in, and two roundings of one instant is a state document and a
    response that disagree by a second.
    """
    return None if value is None else int(value)
