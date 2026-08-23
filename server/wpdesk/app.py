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

from . import schedule as sched
from .auth import Tokens
from .clock import Clock
from .editions import EditionStore
from .gates import Gates, SubprocessGates
from .store import Store
from .vault import Vault

LOG = logging.getLogger("wpdesk.app")

#: How late a missed wake may still fire. launchd runs a missed
#: StartCalendarInterval as soon as the machine wakes, and
#: agent/standalone/README.md names that as the thing that saves a board which
#: would otherwise show yesterday's paper because a lid was shut overnight. The
#: same argument applies to a desk that was down at 06:00 and came up at 06:04.
#: Half an hour is long enough to cover a restart and short enough that a desk
#: brought up at noon does not immediately file the morning paper.
WAKE_GRACE_SECONDS = 30 * 60

#: Sweeping drafts and pruning old editions are filesystem walks. They do not
#: need to happen at the tick rate, and doing them there would put a directory
#: scan between the clock and a publish.
HOUSEKEEPING_SECONDS = 600


@dataclass
class Config:
    """Where everything is. The only place the environment is read."""

    data_dir: str
    vault_dir: str
    tokens_path: str
    repo_dir: str
    host: str = "0.0.0.0"
    port: int = 8080
    keep_editions: int = 30

    @staticmethod
    def from_env(env: Mapping[str, str]) -> "Config":
        """Build a config from the container's environment, with the image's defaults."""
        secrets = env.get("WPDESK_SECRETS", "/run/secrets")
        return Config(
            data_dir=env.get("WPDESK_DATA", "/data"),
            vault_dir=env.get("WPDESK_VAULT", "/vault"),
            tokens_path=os.path.join(secrets, "tokens.json"),
            repo_dir=env.get("WPDESK_REPO", "/repo"),
            host=env.get("WPDESK_HOST", "0.0.0.0"),
            port=int(env.get("WPDESK_PORT", "8080")),
            keep_editions=int(env.get("WPDESK_KEEP_EDITIONS", "30")),
        )


class Desk:
    """The whole service, minus the HTTP surface.

    Construction is cheap and side-effect-light on purpose: it creates the data
    directory and opens the database, and everything else -- reading the vault,
    reaping the queue, publishing anything overdue -- happens on the first
    :meth:`tick`. A constructor that reached for a removable disk would make the
    process fail to start because an SSD was asleep.
    """

    def __init__(self, cfg: Config, clock: Clock | None = None,
                 gates: Gates | None = None) -> None:
        self.cfg = cfg
        self.clock = clock or Clock()

        os.makedirs(cfg.data_dir, exist_ok=True)

        self.store = Store(os.path.join(cfg.data_dir, "desk.sqlite"), self.clock)
        self.vault = Vault(cfg.vault_dir,
                           os.path.join(cfg.data_dir, "schedule.cache.json"),
                           self.clock)
        self.gates = gates or SubprocessGates(cfg.repo_dir)
        self.editions = EditionStore(cfg.data_dir, self.gates, self.store, self.clock,
                                     keep=cfg.keep_editions)
        self.tokens = Tokens(cfg.tokens_path)

        self.schedule = sched.DEFAULT_SCHEDULE
        self.schedule_source = "default"

        #: Notified whenever a command is enqueued, so a long poll wakes on the
        #: instruction rather than on its next timeout. The queue is in SQLite
        #: and could be polled, but a poll interval is latency nobody has to pay.
        self.queue_event = threading.Condition()

        self._last_housekeeping = 0.0
        self._vault_was_available: bool | None = None

        self._load_schedule(first=True)

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

        if self.vault.poll():
            self._load_schedule()
            did.append("schedule:" + self.schedule_source)

        self._note_vault_transition()

        expired = self.store.reap()
        if expired:
            did.append("reaped:%d" % expired)

        if self._fire_due_wake(t):
            did.append("wake")

        result = self.editions.publish_due(self.schedule, t)
        if result is not None:
            LOG.info("published %s (%s)", result.edition_id, result.reason)
            did.append("published:" + result.edition_id)

        if t - self._last_housekeeping >= HOUSEKEEPING_SECONDS:
            self._last_housekeeping = t
            swept = self.editions.sweep_drafts()
            pruned = self.editions.prune()
            self.vault.prune_archive()
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
            "lastPublishAt": _as_int(self.store.last_publish_at()),
            "hold": _as_int(hold if hold and hold > t else None),
            "vault": "available" if self.vault.available() else "unavailable",
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

    def close(self) -> None:
        """Release the database. Serving state on disk is already durable."""
        self.store.close()

    # -- internals --------------------------------------------------------
    def _load_schedule(self, first: bool = False) -> None:
        """Re-read the schedule, remembering where it came from."""
        self.schedule, self.schedule_source = self.vault.load_schedule()
        if first:
            LOG.info("schedule from %s: %s, publish=%s, quiet=%s",
                     self.schedule_source, self.schedule.timezone,
                     self.schedule.publish_policy,
                     [(w.start, w.end) for w in self.schedule.quiet])

    def _note_vault_transition(self) -> None:
        """Log the vault appearing or disappearing once, not once per tick.

        A line per tick would bury the one that matters. A line per transition
        is the answer to "when did the SSD go away", which is the only question
        anybody asks about it.

        Reappearing is also when the layout is written, because a disk that was
        plugged in after the desk started is exactly the case where the vault
        exists and its files do not. ``ensure_layout`` never overwrites
        anything, so running it again on every reconnection is free and means
        there is no ordering between mounting a disk and starting a container.
        """
        available = self.vault.available()
        if available == self._vault_was_available:
            return
        if self._vault_was_available is not None:
            LOG.warning("vault is now %s (%s)",
                        "available" if available else "UNAVAILABLE", self.cfg.vault_dir)
        if available:
            try:
                self.vault.ensure_layout()
            except OSError as e:
                # A read-only or full disk. The desk keeps serving; only filing
                # is affected, and the next transition will try again.
                LOG.warning("could not write the vault layout: %s", e)
        self._vault_was_available = available

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


def _as_int(value: float | None) -> int | None:
    """Epoch seconds as an integer, or ``None``. Nothing on this wire is a float."""
    return None if value is None else int(value)
