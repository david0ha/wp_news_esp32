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

import logging
import os
import threading
from dataclasses import dataclass
from typing import Mapping

from . import schedule as sched, schedulefile
from .auth import Tokens
from .clock import Clock
from .editions import EditionStore
from .gates import Gates, SubprocessGates
from .store import Store

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

        #: Not a Config field, because no environment variable chooses it: the
        #: schedule belongs to the serving root the same way the database does,
        #: and a desk with two data roots is two desks.
        self.schedule_path = os.path.join(cfg.data_dir, "schedule.json")

        self.schedule = sched.DEFAULT_SCHEDULE
        self.schedule_source = "default"

        #: Notified whenever a command is enqueued, so a long poll wakes on the
        #: instruction rather than on its next timeout. The queue is in SQLite
        #: and could be polled, but a poll interval is latency nobody has to pay.
        self.queue_event = threading.Condition()

        self._last_housekeeping = 0.0

        self._load_schedule()

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
            "queue": {
                "pending": self.store.pending_count(),
                "recent": self.store.list_commands(limit=5),
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
        self.enqueue(
            "file_edition",
            "Scheduled wake. File today's edition — pick the company, research it, "
            "and write both pages.",
            priority=5, source="schedule")
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


def as_int(value: float | None) -> int | None:
    """Epoch seconds as an integer, or ``None``. Nothing on this wire is a float.

    Public because ``http.py`` answers a hold with the same shape ``state()``
    reports one in, and two roundings of one instant is a state document and a
    response that disagree by a second.
    """
    return None if value is None else int(value)
