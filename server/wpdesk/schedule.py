"""The schedule: when the agent wakes, when a page may reach the glass, and how
often the board is told to ask.

Three questions on one document, because from the owner's side they are one
decision -- "what happens at six" -- and splitting them across two files makes
it possible for them to disagree. `wake` is when the *agent* runs; `poll` is
what the *device* is told; `quiet` is when the desk simply declines to change
its answer, which is a refresh policy that needs no firmware at all.

Nothing in this module reads a clock. Every function takes the instant it is
reasoning about and returns epoch floats, which is what makes a window that
ends at 06:00 testable by naming 05:59:59 rather than by waiting for it. The
desk's one clock is injected at the edges (see ``clock.py``); down here time is
an argument.

The arithmetic is ``zoneinfo``'s, deliberately and not by convenience. A
schedule is written in local time, local time is not a fixed offset from UTC,
and a reader who moves to a zone that observes DST must not get a paper that
arrives an hour late for half the year. The two local times that are not one
instant get a fixed rule:

* the **spring-forward gap** -- a local time that does not exist. ``.timestamp()``
  resolves it with the offset in force before the transition, which lands it
  just after the jump. That is accepted rather than corrected: the requirement
  is "the agent wakes once that day", not "at exactly 02:30".
* the **fall-back repeat** -- a local time that happens twice. ``fold=0`` picks
  the earlier, so the wake fires once instead of twice, which is the difference
  between one edition and two.

``describe()`` reports both rather than resolving them silently, because
time-zone arithmetic is the thing everybody gets wrong and an inspectable
listing beats a promise.

One rule is worth stating on its own: **a window whose start equals its end is
empty, not a whole day.** Zero length is what somebody types when they mean
"none", and reading it as twenty-four hours of silence would be the most
expensive misreading available in this file -- a newspaper that never changes
again, with nothing in any log to say why.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from typing import NoReturn
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from .errors import BadRequest

#: What ``publish.policy`` may say. Three genuinely different behaviours, not
#: three names for one -- see the table in the design spec, §7.
PUBLISH_POLICIES: tuple[str, ...] = ("immediate", "on_wake", "manual")

#: The device's own accepted range for a poll interval. Restated here so an
#: impossible cadence is refused by the desk at ``PUT`` time, where a human is
#: watching, rather than clamped in silence on the board an hour later.
POLL_MIN_SECONDS = 30
POLL_MAX_SECONDS = 86400

#: Ceilings that exist to keep a hand-edited file from becoming a denial of
#: service against its own author: twelve wakes is one every two hours, and
#: four quiet windows is more shape than a day has.
MAX_QUIET_WINDOWS = 4
MAX_WAKE_TIMES = 12
MAX_MIN_GAP_MINUTES = 1440

#: Monday-first, matching ``datetime.weekday()`` so the index *is* the weekday.
DAY_NAMES: tuple[str, ...] = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")
ALL_DAYS: frozenset[int] = frozenset(range(7))

#: Every top-level key the document may carry. Anything else is a typo, and a
#: typo that silently keeps yesterday's value is unfindable from the wall.
_KEYS = frozenset({"timezone", "quiet", "wake", "publish", "poll"})

_HHMM_RE = re.compile(r"^([01][0-9]|2[0-3]):[0-5][0-9]$")

#: How far ``next_wake`` looks ahead. Eight days rather than seven because a
#: weekly ``days``-filtered wake asked about on its own firing day has already
#: spent that day, and one more covers a DST shift on top.
_SCAN_DAYS = 8

_UTC = timezone.utc


@dataclass(frozen=True)
class QuietWindow:
    """A span of local wall-clock time in which nothing new becomes current.

    ``end <= start`` wraps midnight; ``end == start`` is empty. Both are stored
    as ``"HH:MM"`` strings rather than as minutes because this is exactly what
    the document says, and a schedule that round-trips through the vault
    unchanged is one a human can keep editing.
    """

    start: str
    end: str


@dataclass(frozen=True)
class WakeTime:
    """When the agent runs, and on which weekdays.

    ``days`` holds ``datetime.weekday()`` numbers -- 0 is Monday -- so the
    membership test is the weekday itself and no lookup sits between the
    document and the arithmetic.
    """

    at: str
    days: frozenset[int] = ALL_DAYS


@dataclass(frozen=True)
class Schedule:
    """One owner's answer to "what happens at six", parsed and validated.

    Frozen because it is read from several threads -- the tick, the HTTP
    handlers, the vault poller -- and a schedule that can be mutated in place
    is one that can be half-applied while a publish decision is being made
    against it. Replacing the whole object is the only way it changes.
    """

    timezone: str
    quiet: tuple[QuietWindow, ...]
    wake: tuple[WakeTime, ...]
    publish_policy: str
    min_gap_minutes: int
    poll_active_seconds: int
    poll_quiet_seconds: int


#: The shipped default. Quiet from half past midnight to six, the agent at six,
#: after the Korean close, and last thing at night; an hour between publishes
#: because a refresh is twenty-five seconds of the whole sheet flashing and a
#: newspaper that blinks at nobody all afternoon is the failure this floor
#: exists to prevent.
DEFAULT_SCHEDULE = Schedule(
    timezone="Asia/Seoul",
    quiet=(QuietWindow("00:30", "06:00"),),
    wake=(WakeTime("06:00", ALL_DAYS),
          WakeTime("12:40", ALL_DAYS),
          WakeTime("22:00", ALL_DAYS)),
    publish_policy="on_wake",
    min_gap_minutes=60,
    poll_active_seconds=900,
    poll_quiet_seconds=3600,
)


# --------------------------------------------------------------------------
# Parsing and validation
# --------------------------------------------------------------------------

def _bad(path: str, why: str) -> NoReturn:
    """Refuse the document, naming the field.

    The message is what lands in ``schedule.errors.md`` in the vault, where the
    only reader is the person who mistyped it. A message without a field name
    is a message nobody can act on.
    """
    raise BadRequest("bad_schedule", f"{path}: {why}")


def _clock(value: object, path: str) -> str:
    """Return ``value`` if it is a 24-hour ``HH:MM``, otherwise refuse it."""
    if not isinstance(value, str) or not _HHMM_RE.match(value):
        _bad(path, f"expected a 24-hour HH:MM clock time, got {value!r}")
    return value


def _int(value: object, path: str, low: int, high: int) -> int:
    """Return ``value`` if it is an integer within ``low..high`` inclusive.

    ``bool`` is excluded explicitly: ``True`` is an ``int`` in Python and would
    otherwise pass for a one-second cadence, which is a class of bug that is
    invisible in a diff.
    """
    if isinstance(value, bool) or not isinstance(value, int):
        _bad(path, f"expected an integer, got {value!r}")
    if not low <= value <= high:
        _bad(path, f"{value} is outside {low}..{high}")
    return value


def _days(value: object, path: str) -> frozenset[int]:
    """Parse ``"sat,sun"`` -- or ``["sat", "sun"]`` -- into weekday numbers.

    Absent means every day, because that is what a bare ``"07:00"`` means and
    the two forms must not disagree.
    """
    if value is None:
        return ALL_DAYS
    if isinstance(value, str):
        names = [n.strip().lower() for n in value.split(",")]
    elif isinstance(value, list) and all(isinstance(n, str) for n in value):
        names = [n.strip().lower() for n in value]
    else:
        _bad(path, f"expected 'sat,sun' or ['sat', 'sun'], got {value!r}")
    names = [n for n in names if n]
    if not names:
        _bad(path, "names no days; omit the key to mean every day")
    out = set()
    for name in names:
        if name not in DAY_NAMES:
            _bad(path, f"unknown day {name!r}; expected one of {', '.join(DAY_NAMES)}")
        out.add(DAY_NAMES.index(name))
    return frozenset(out)


def _no_extra_keys(doc: dict, allowed: frozenset[str], path: str) -> None:
    """Refuse keys nobody reads, so a misspelling is an error and not a no-op."""
    extra = sorted(set(doc) - allowed)
    if extra:
        _bad(path, f"unknown key(s) {', '.join(repr(k) for k in extra)}")


def parse_schedule(doc: dict) -> Schedule:
    """Validate a schedule document and return the :class:`Schedule` it names.

    An invalid document is refused whole -- there is no partial schedule, and a
    half-applied one is a desk publishing against rules its owner never wrote.
    A key that is absent takes the default's value; a key that is present and
    wrong is a :class:`~.errors.BadRequest` naming its JSON path.

    Raises:
        BadRequest: code ``bad_schedule``, message ``"<json path>: <why>"``.
    """
    if not isinstance(doc, dict):
        _bad("schedule", f"expected an object, got {type(doc).__name__}")
    _no_extra_keys(doc, _KEYS, "schedule")

    tz_name = doc.get("timezone", DEFAULT_SCHEDULE.timezone)
    if not isinstance(tz_name, str) or not tz_name:
        _bad("timezone", f"expected an IANA zone name such as 'Asia/Seoul', "
                         f"got {tz_name!r}")
    try:
        ZoneInfo(tz_name)
    except (ZoneInfoNotFoundError, ValueError) as exc:
        # The zone is resolved here rather than at first use because a schedule
        # that parses and then throws inside the scheduler tick is a schedule
        # that took the desk down from a text file.
        _bad("timezone", f"unknown time zone {tz_name!r} ({exc})")

    raw = doc.get("quiet")
    if raw is None:
        quiet = DEFAULT_SCHEDULE.quiet
    else:
        if not isinstance(raw, list):
            _bad("quiet", "expected a list of {'from': 'HH:MM', 'to': 'HH:MM'}")
        if len(raw) > MAX_QUIET_WINDOWS:
            _bad("quiet", f"{len(raw)} windows, at most {MAX_QUIET_WINDOWS}")
        windows = []
        for i, item in enumerate(raw):
            path = f"quiet[{i}]"
            if not isinstance(item, dict):
                _bad(path, "expected an object with 'from' and 'to'")
            _no_extra_keys(item, frozenset({"from", "to"}), path)
            windows.append(QuietWindow(_clock(item.get("from"), f"{path}.from"),
                                       _clock(item.get("to"), f"{path}.to")))
        quiet = tuple(windows)

    raw = doc.get("wake")
    if raw is None:
        wake = DEFAULT_SCHEDULE.wake
    else:
        if not isinstance(raw, list):
            _bad("wake", "expected a list of 'HH:MM' or {'at': ..., 'days': ...}")
        if len(raw) > MAX_WAKE_TIMES:
            _bad("wake", f"{len(raw)} entries, at most {MAX_WAKE_TIMES}")
        times = []
        for i, item in enumerate(raw):
            path = f"wake[{i}]"
            if isinstance(item, str):
                times.append(WakeTime(_clock(item, path), ALL_DAYS))
            elif isinstance(item, dict):
                _no_extra_keys(item, frozenset({"at", "days"}), path)
                times.append(WakeTime(_clock(item.get("at"), f"{path}.at"),
                                      _days(item.get("days"), f"{path}.days")))
            else:
                _bad(path, "expected 'HH:MM' or {'at': 'HH:MM', 'days': 'sat,sun'}")
        wake = tuple(times)

    raw = doc.get("publish")
    if raw is None:
        policy = DEFAULT_SCHEDULE.publish_policy
        gap = DEFAULT_SCHEDULE.min_gap_minutes
    else:
        if not isinstance(raw, dict):
            _bad("publish", "expected an object with 'policy' and 'min_gap_minutes'")
        _no_extra_keys(raw, frozenset({"policy", "min_gap_minutes"}), "publish")
        policy = raw.get("policy", DEFAULT_SCHEDULE.publish_policy)
        if policy not in PUBLISH_POLICIES:
            _bad("publish.policy",
                 f"{policy!r} is not one of {', '.join(PUBLISH_POLICIES)}")
        gap = _int(raw.get("min_gap_minutes", DEFAULT_SCHEDULE.min_gap_minutes),
                   "publish.min_gap_minutes", 0, MAX_MIN_GAP_MINUTES)

    raw = doc.get("poll")
    if raw is None:
        active = DEFAULT_SCHEDULE.poll_active_seconds
        quiet_s = DEFAULT_SCHEDULE.poll_quiet_seconds
    else:
        if not isinstance(raw, dict):
            _bad("poll", "expected an object with 'active_seconds' and 'quiet_seconds'")
        _no_extra_keys(raw, frozenset({"active_seconds", "quiet_seconds"}), "poll")
        active = _int(raw.get("active_seconds", DEFAULT_SCHEDULE.poll_active_seconds),
                      "poll.active_seconds", POLL_MIN_SECONDS, POLL_MAX_SECONDS)
        quiet_s = _int(raw.get("quiet_seconds", DEFAULT_SCHEDULE.poll_quiet_seconds),
                       "poll.quiet_seconds", POLL_MIN_SECONDS, POLL_MAX_SECONDS)

    return Schedule(timezone=tz_name, quiet=quiet, wake=wake,
                    publish_policy=policy, min_gap_minutes=gap,
                    poll_active_seconds=active, poll_quiet_seconds=quiet_s)


def schedule_to_dict(s: Schedule) -> dict:
    """The document form of ``s``, which ``parse_schedule`` reads back equal.

    A wake on all seven days is written as the bare ``"HH:MM"`` string rather
    than as an object with a seven-name ``days`` list, because that is the form
    a human wrote it in and this is the function that writes ``schedule.json``
    back into the vault.
    """
    wake: list = []
    for w in s.wake:
        if w.days == ALL_DAYS:
            wake.append(w.at)
        else:
            wake.append({"at": w.at,
                         "days": ",".join(DAY_NAMES[d] for d in sorted(w.days))})
    return {
        "timezone": s.timezone,
        "quiet": [{"from": w.start, "to": w.end} for w in s.quiet],
        "wake": wake,
        "publish": {"policy": s.publish_policy,
                    "min_gap_minutes": s.min_gap_minutes},
        "poll": {"active_seconds": s.poll_active_seconds,
                 "quiet_seconds": s.poll_quiet_seconds},
    }


# --------------------------------------------------------------------------
# Local-time arithmetic
# --------------------------------------------------------------------------

def _zone(s: Schedule) -> ZoneInfo:
    """The schedule's zone. ``ZoneInfo`` caches, so this is not a file read."""
    return ZoneInfo(s.timezone)


def _minutes(hhmm: str) -> int:
    """``"06:00"`` -> 360. The string is known well formed by ``parse_schedule``."""
    return int(hhmm[:2]) * 60 + int(hhmm[3:])


def _local(s: Schedule, t: float) -> datetime:
    """``t`` as a local wall-clock datetime in the schedule's zone."""
    return datetime.fromtimestamp(t, _zone(s))


def _minute_of(s: Schedule, t: float) -> int:
    """Local minutes since midnight, which is the unit a window is compared in."""
    lt = _local(s, t)
    return lt.hour * 60 + lt.minute


def _instant(tz: ZoneInfo, day: date, hhmm: str) -> float:
    """The epoch instant of a local wall-clock time on a local date.

    ``fold=0`` is the fixed rule for the fall-back repeat: the earlier of the
    two instants, so a wake at 01:30 on the night the clocks go back fires once
    rather than twice. A time inside the spring-forward gap resolves to a real
    instant just after the jump, which is accepted -- see the module docstring.
    """
    at_time = time(int(hhmm[:2]), int(hhmm[3:]))
    return datetime.combine(day, at_time, tzinfo=tz).replace(fold=0).timestamp()


def _covers(w: QuietWindow, minute: int) -> bool:
    """Whether a window covers a local minute-of-day.

    Half open at the end: the window's end instant is the first minute that is
    no longer quiet, which is what makes ``quiet_ends_at`` an instant a caller
    can publish at rather than one second before.
    """
    start, end = _minutes(w.start), _minutes(w.end)
    if start == end:
        return False           # empty, not all day -- see the module docstring
    if start < end:
        return start <= minute < end
    return minute >= start or minute < end


def _window_end(s: Schedule, w: QuietWindow, t: float) -> float:
    """The instant a window known to cover ``t`` stops covering."""
    tz = _zone(s)
    lt = _local(s, t)
    day = lt.date()
    start, end = _minutes(w.start), _minutes(w.end)
    if start > end and lt.hour * 60 + lt.minute >= start:
        day = day + timedelta(days=1)     # it wraps, and we are on the near side
    return _instant(tz, day, w.end)


def _next_start(s: Schedule, w: QuietWindow, t: float) -> float | None:
    """The first instant strictly after ``t`` at which ``w`` begins.

    Three days of scan rather than two: a DST shift can move a local time by an
    hour in either direction and the cost of the extra candidate is nothing.
    """
    if _minutes(w.start) == _minutes(w.end):
        return None
    tz = _zone(s)
    day0 = _local(s, t).date()
    for k in range(3):
        when = _instant(tz, day0 + timedelta(days=k), w.start)
        if when > t:
            return when
    return None


def is_quiet(s: Schedule, t: float) -> bool:
    """Whether ``t`` falls inside any quiet window."""
    minute = _minute_of(s, t)
    return any(_covers(w, minute) for w in s.quiet)


def quiet_ends_at(s: Schedule, t: float) -> float | None:
    """When quiet ends, or ``None`` when ``t`` is not quiet.

    The caller asked when it stops being quiet, not when a window does, so two
    windows that abut or overlap answer once with the end of their union. The
    walk is bounded by the number of windows because each hop leaves at least
    one behind, and the ceiling on windows is four.
    """
    cursor = float(t)
    for _ in range(len(s.quiet) + 1):
        minute = _minute_of(s, cursor)
        ends = [_window_end(s, w, cursor) for w in s.quiet if _covers(w, minute)]
        if not ends:
            return None if cursor == t else cursor
        nxt = max(ends)
        if nxt <= cursor:
            return cursor      # defensive: a hop that does not advance is done
        cursor = nxt
    return cursor


def next_wake(s: Schedule, t: float) -> float | None:
    """The first wake instant strictly after ``t``, or ``None`` if there is none.

    Strictly after, so asking at 06:00 on a day with a 06:00 wake gives the
    next one rather than the one that is firing: this function answers "what is
    coming", and a tick that re-enqueued the wake it just handled would file an
    edition every five seconds.
    """
    if not s.wake:
        return None
    tz = _zone(s)
    day0 = _local(s, t).date()
    best: float | None = None
    for k in range(_SCAN_DAYS):
        day = day0 + timedelta(days=k)
        weekday = day.weekday()
        for w in s.wake:
            if weekday not in w.days:
                continue
            when = _instant(tz, day, w.at)
            if when > t and (best is None or when < best):
                best = when
    return best


def _events_after(s: Schedule, t: float) -> list[tuple[float, str]]:
    """Every transition sharing the first instant strictly after ``t``, sorted.

    They come as a group rather than one at a time because 06:00 on the default
    schedule is both the end of the quiet window and a wake, and a caller
    stepping instant by instant would otherwise see one of them and never the
    other.
    """
    found: list[tuple[float, str]] = []

    when = next_wake(s, t)
    if when is not None:
        found.append((when, "wake"))

    for w in s.quiet:
        when = _next_start(s, w, t)
        # A window opening while it is already quiet changes nothing, and a
        # listing of transitions that reports non-transitions is a listing that
        # has to be read twice.
        if when is not None and not is_quiet(s, when - 1):
            found.append((when, "quiet_start"))

    if is_quiet(s, t):
        when = quiet_ends_at(s, t)
        if when is not None and when > t:
            found.append((when, "quiet_end"))

    if not found:
        return []
    first = min(when for when, _ in found)
    return sorted({event for event in found if event[0] == first})


def next_transition(s: Schedule, t: float) -> tuple[float, str] | None:
    """The next ``(instant, label)`` after ``t``, or ``None`` if nothing changes.

    ``label`` is one of ``"quiet_start"``, ``"quiet_end"``, ``"wake"``. Nothing
    changes when a schedule has no windows and no wakes, which is a legal way
    to say "leave the page alone and let me publish by hand".
    """
    events = _events_after(s, t)
    return events[0] if events else None


def transitions(s: Schedule, t: float, count: int) -> list[tuple[float, str]]:
    """Up to ``count`` transitions after ``t``, earliest first.

    Fewer than ``count`` when the schedule runs out of them, which it only does
    when it has none at all -- everything here repeats.
    """
    out: list[tuple[float, str]] = []
    cursor = float(t)
    while len(out) < count:
        events = _events_after(s, cursor)
        if not events:
            break
        out.extend(events)
        cursor = events[0][0]      # strictly greater, so this always advances
    return out[:count]


def effective_poll_seconds(s: Schedule, t: float) -> int:
    """The cadence the device should be told to use at ``t``.

    The server has already decided whether "now" is inside a quiet window; the
    device is told a number and never has to know that a calendar exists.
    """
    return s.poll_quiet_seconds if is_quiet(s, t) else s.poll_active_seconds


def describe(s: Schedule, t: float, count: int = 10) -> list[dict]:
    """The next ``count`` transitions, in local time, UTC and epoch seconds.

    This is what ``GET /api/schedule/next`` serves. Time-zone arithmetic is
    what everybody gets wrong, so it is printed rather than trusted --
    including ``ambiguous``, which is true for a local time that happens twice
    on the day the clocks go back and marks the one this module resolved with
    ``fold=0``.
    """
    tz = _zone(s)
    rows = []
    for when, what in transitions(s, t, count):
        local = datetime.fromtimestamp(when, tz)
        rows.append({
            "at": int(when),
            "local": local.strftime("%Y-%m-%d %H:%M %Z"),
            "utc": datetime.fromtimestamp(when, _UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "what": what,
            # Compare the two folds against each other rather than against
            # `when`: fromtimestamp already picks the fold that matches the
            # instant, so testing one of them against `when` reports the second
            # occurrence of an ambiguous time as unambiguous.
            "ambiguous": (local.replace(fold=0).timestamp()
                          != local.replace(fold=1).timestamp()),
        })
    return rows
