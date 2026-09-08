"""The event book: what is about to happen, and why it reaches a position.

The paper answers what happened. This answers what is about to happen -- ten
ranked events, each one annotated against a position the owner actually holds.
It is written by the agent and read by the phone, and it never touches
``news.json``, which is served with no authorization at all.

**The rule this module exists to enforce.** An event book that mixes a computed
earnings date with a date a model inferred from a paragraph is a book with no
way to tell the reader which is which. Both render as a line with a date on it,
the reader trusts both, and is wrong about one. So:

    Every event carries its source. A computed event is ``source: "computed"``
    and may only be one of the four kinds a machine actually knows. A
    researched event carries an ``https://`` URL, which the phone shows. A date
    with neither does not go on the wall. And the reasoning may only point at
    an event that already exists -- it can never introduce a date of its own.

Three of those four clauses are exact and are checked exactly. The fourth --
"the reasoning may not introduce a date" -- cannot be, because a reason is
prose. :data:`_DATE_IN_PROSE` approximates it: a reason carrying an ISO date or
a Korean ``M월 D일`` is refused, while a reason that refers to a date in
*words* ("발표 다음 날") passes. That is a heuristic and is documented as one
rather than dressed up, but it is worth having: a wrong date in a sentence
about the owner's own money is the worst output this system can produce, and a
sentence is exactly where a model puts one.

**Precision is a field, not a formatting choice.** An event known only to the
day must render as ``9월 15일`` and never as ``09:30`` -- inventing a time is
how a reader misses the one that mattered, because they looked in the morning
and it happened in the evening. So :data:`PRECISIONS` governs two other fields
and the wire cannot carry a precision it contradicts.

``at`` is always UTC. The phone renders in its own timezone and groups by its
own day; see the design's §8 for why both halves of that are load-bearing.
"""

from __future__ import annotations

import datetime
import json
import logging
import os
import re
from typing import NoReturn

from .errors import BadRequest
from .fsutil import atomic_write, json_bytes

LOG = logging.getLogger("claudepost.calendar")

#: A quarter of a megabyte serialised. Larger than the positions cap because a
#: reason is a paragraph and forty of them carry more prose than sixty-four
#: positions carry numbers.
MAX_DOC_BYTES = 256 * 1024

#: Forty rather than ten. ``target`` is how many events the agent works until it
#: has -- the design's floor, not a display cap -- so the book may legitimately
#: hold more than any one screen shows, and a book truncated to today's setting
#: would have to be re-researched the moment the owner raised it. The schedule
#: screen shows the whole book, ordered by time; see the design's section 8.
MAX_EVENTS = 40

MAX_TITLE_CHARS = 80
MAX_REASON_SHORT_CHARS = 90
MAX_REASON_CHARS = 600
MAX_PUSH_TITLE_CHARS = 60
MAX_PUSH_BODY_CHARS = 180
MAX_SHORTFALL_CHARS = 160
MAX_SYMBOLS = 8
MAX_AFFECTS = 8
MAX_TARGET = MAX_EVENTS

#: How far either side of now an event may sit. The past window exists because
#: an event that just fired is still worth showing -- the book is not rewritten
#: the instant a print lands -- and it is short, because a book still carrying
#: last month's CPI is a book nobody refreshed.
PAST_WINDOW = datetime.timedelta(days=7)
FUTURE_WINDOW = datetime.timedelta(days=400)

KINDS: tuple[str, ...] = (
    "econ", "earnings", "dividend", "expiry",
    "corporate", "legal", "index", "other",
)

#: The four kinds a machine knows exactly, and the only ones that may say
#: ``computed``. An earnings date comes from Yahoo, an expiry from the position
#: the owner typed, an economic release from investing.com. An analyst day does
#: not: somebody had to read for it, so it has to say where.
COMPUTED_KINDS: frozenset[str] = frozenset({"econ", "earnings", "dividend", "expiry"})

COMPUTED = "computed"

PRECISIONS: tuple[str, ...] = ("exact", "session", "day")

#: Before market open / after market close. The two answers a company gives
#: when it says *when* it will report, and the only two the phone renders as
#: words rather than as a clock.
SESSIONS: tuple[str, ...] = ("bmo", "amc")

DIRECTIONS: tuple[str, ...] = ("for", "against", "both")

SYMBOL_RE = re.compile(r"^[A-Z0-9.\-]{1,12}\Z")
EVENT_ID_RE = re.compile(r"^e_[0-9a-z]{4,16}\Z")
POSITION_ID_RE = re.compile(r"^p_[0-9a-f]{6}\Z")
LANG_RE = re.compile(r"^[a-z]{2,3}\Z")
_STAMP_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\Z")

#: A date asserted inside prose. See the module docstring: this is the
#: approximate half of the source rule, and approximating it is deliberate.
#: ``2026-11-12`` and ``11월 12일`` are both a specific calendar day the book
#: cannot show a source for; "발표 다음 날" is a reference to a date that IS in
#: the book, and passes.
_DATE_IN_PROSE = re.compile(r"\d{4}-\d{2}-\d{2}|\d{1,2}\s*월\s*\d{1,2}\s*일")

_WIDEST_STAMP = "9999-12-31T23:59:59Z"

_TOP_KEYS = frozenset({"generated_at", "lang", "target", "events", "shortfall"})
_EVENT_KEYS = frozenset({
    "id", "at", "precision", "session", "title", "kind", "source",
    "symbols", "affects", "rank", "push",
})
_AFFECT_KEYS = frozenset({"position_id", "direction", "reason", "reason_short"})
_PUSH_KEYS = frozenset({"title", "body"})


# --------------------------------------------------------------------------
# Refusals
# --------------------------------------------------------------------------

def _bad(path: str, why: str) -> NoReturn:
    """Refuse the document, naming the field.

    The reader here is the agent, mid-run, and the message is what tells it
    which of forty events it has to fix. A refusal that does not name one turns
    a filing into a guess.
    """
    raise BadRequest("bad_calendar", f"{path}: {why}")


def _no_extra_keys(doc: dict, allowed: frozenset[str], path: str) -> None:
    extra = sorted(set(doc) - allowed)
    if extra:
        _bad(path, f"unknown key(s) {', '.join(repr(k) for k in extra)}")


def _obj(value: object, path: str) -> dict:
    if not isinstance(value, dict):
        _bad(path, f"expected an object, got {type(value).__name__}")
    return value


def _one_of(value: object, path: str, allowed: tuple[str, ...]) -> str:
    if value not in allowed:
        _bad(path, f"expected one of {', '.join(allowed)}, got {value!r}")
    return value  # type: ignore[return-value]


def _int_in(value: object, path: str, low: int, high: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        _bad(path, f"expected an integer, got {value!r}")
    if not low <= value <= high:
        _bad(path, f"{value} is outside {low}..{high}")
    return value


def _bounded_str(value: object, path: str, max_len: int) -> str:
    if not isinstance(value, str):
        _bad(path, f"expected a string, got {value!r}")
    if not value:
        _bad(path, "is empty")
    if len(value) > max_len:
        _bad(path, f"{len(value)} characters, at most {max_len}")
    return value


def _instant(value: object, path: str) -> datetime.datetime:
    text = _bounded_str(value, path, 20)
    if not _STAMP_RE.match(text):
        _bad(path, f"expected an RFC3339 instant ending Z, got {text!r}")
    try:
        return datetime.datetime.strptime(
            text, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=datetime.timezone.utc)
    except ValueError:
        _bad(path, f"{text!r} is not a real instant")


def _no_asserted_date(text: str, path: str) -> str:
    """Refuse prose that names a calendar day of its own.

    The approximate clause of the source rule -- see the module docstring for
    what it is approximating and why an approximation still earns its place.
    """
    found = _DATE_IN_PROSE.search(text)
    if found:
        _bad(path, f"names the date {found.group(0)!r} in prose. "
                   f"The reasoning may point at an event in this book, but it "
                   f"may not introduce a date -- a date needs a source, and a "
                   f"sentence carries none")
    return text


# --------------------------------------------------------------------------
# The pieces
# --------------------------------------------------------------------------

def _source(value: object, path: str, kind: str) -> str:
    """``"computed"``, or the URL a human could go and check.

    The exact half of the rule, and it runs in one direction only. A researched
    kind claiming ``computed`` is refused: an analyst day is not something this
    desk derives, so saying so claims an authority the date does not have.

    The reverse is *allowed* on purpose. A computed kind carrying a URL is a
    perfectly good event -- an earnings date found on the company's own IR page
    is more authoritative than one inferred from a feed, not less. What
    ``computed`` means is "no human read for this", not "this kind always comes
    from us", and a rule that refused a sourced earnings date would push the
    agent to launder it as ``computed`` to get it accepted.
    """
    text = _bounded_str(value, path, 400)
    if text == COMPUTED:
        if kind not in COMPUTED_KINDS:
            _bad(path, f"{kind!r} is not something the desk computes; give the "
                       f"URL this date was found at (computed kinds are "
                       f"{', '.join(sorted(COMPUTED_KINDS))})")
        return text
    if not text.startswith("https://"):
        _bad(path, f"expected {COMPUTED!r} or an https:// URL, got {text!r}")
    return text


def _affect(value: object, path: str, known: frozenset[str]) -> dict:
    doc = _obj(value, path)
    _no_extra_keys(doc, _AFFECT_KEYS, path)

    position_id = _bounded_str(doc.get("position_id"),
                               f"{path}.position_id", 16)
    if not POSITION_ID_RE.match(position_id):
        _bad(f"{path}.position_id", f"{position_id!r} is not a position id")
    if position_id not in known:
        _bad(f"{path}.position_id",
             f"{position_id} is not a position the owner holds. The book may "
             f"only reason about positions that exist")

    reason = _bounded_str(doc.get("reason"), f"{path}.reason",
                          MAX_REASON_CHARS)
    reason_short = _bounded_str(doc.get("reason_short"),
                                f"{path}.reason_short",
                                MAX_REASON_SHORT_CHARS)
    return {
        "position_id": position_id,
        "direction": _one_of(doc.get("direction"), f"{path}.direction",
                             DIRECTIONS),
        "reason": _no_asserted_date(reason, f"{path}.reason"),
        "reason_short": _no_asserted_date(reason_short,
                                          f"{path}.reason_short"),
    }


def _push(value: object, path: str) -> dict | None:
    if value is None:
        return None
    doc = _obj(value, path)
    _no_extra_keys(doc, _PUSH_KEYS, path)
    return {
        "title": _bounded_str(doc.get("title"), f"{path}.title",
                              MAX_PUSH_TITLE_CHARS),
        "body": _bounded_str(doc.get("body"), f"{path}.body",
                             MAX_PUSH_BODY_CHARS),
    }


def _event(value: object, path: str, known: frozenset[str],
           now: datetime.datetime) -> dict:
    doc = _obj(value, path)
    _no_extra_keys(doc, _EVENT_KEYS, path)

    event_id = _bounded_str(doc.get("id"), f"{path}.id", 18)
    if not EVENT_ID_RE.match(event_id):
        _bad(f"{path}.id", f"{event_id!r} is not an event id (e_ and 4..16 "
                           f"lower-case alphanumerics)")

    kind = _one_of(doc.get("kind"), f"{path}.kind", KINDS)
    at = _instant(doc.get("at"), f"{path}.at")
    if not now - PAST_WINDOW <= at <= now + FUTURE_WINDOW:
        _bad(f"{path}.at",
             f"{doc['at']} is outside the book's window "
             f"({PAST_WINDOW.days} days back, {FUTURE_WINDOW.days} days on)")

    precision = _one_of(doc.get("precision"), f"{path}.precision", PRECISIONS)
    session = doc.get("session")

    # Precision governs the other two, so the wire cannot carry a precision it
    # contradicts. A `day` event whose instant has a time-of-day is a time
    # somebody will eventually render.
    if precision == "day":
        if session is not None:
            _bad(f"{path}.session", "a day-precision event has no session")
        if (at.hour, at.minute, at.second) != (0, 0, 0):
            _bad(f"{path}.at",
                 f"{doc['at']} carries a time of day, but precision is 'day'. "
                 f"Use 00:00:00Z, or say what the time is")
    elif precision == "session":
        if session is None:
            _bad(f"{path}.session",
                 f"a session-precision event must say which session "
                 f"({', '.join(SESSIONS)})")
        session = _one_of(session, f"{path}.session", SESSIONS)
        # The instant itself is NOT pinned to a fixed clock time: the sessions
        # are New York's and the offset moves twice a year. It only has to be a
        # real instant, because the day grouping needs one; the phone renders
        # the word.
    else:
        if session is not None:
            _bad(f"{path}.session", "an exact-precision event has no session")

    raw_symbols = doc.get("symbols")
    if not isinstance(raw_symbols, list) or not raw_symbols:
        _bad(f"{path}.symbols", "expected a non-empty list")
    if len(raw_symbols) > MAX_SYMBOLS:
        _bad(f"{path}.symbols",
             f"{len(raw_symbols)} symbols, at most {MAX_SYMBOLS}")
    symbols = []
    for i, one in enumerate(raw_symbols):
        text = _bounded_str(one, f"{path}.symbols[{i}]", 12)
        if not SYMBOL_RE.match(text):
            _bad(f"{path}.symbols[{i}]", f"{text!r} does not look like a ticker")
        symbols.append(text)

    # Non-empty, and this is the floor rather than a shape check. An event with
    # no reasoning is a generic calendar entry, and the phone already has one of
    # those -- it shows two Yahoo dates. The design's floor is "a source AND a
    # stated mechanism reaching a position", which is exactly `source` (checked
    # above) plus this; leaving `affects` optional would have made half the
    # floor advisory, and the half that a model under pressure to reach ten
    # would drop first.
    raw_affects = doc.get("affects")
    if not isinstance(raw_affects, list) or not raw_affects:
        _bad(f"{path}.affects",
             "expected at least one entry. An event with no reasoning is a "
             "generic calendar entry -- say which position this reaches and "
             "how, or leave it out of the book")
    if len(raw_affects) > MAX_AFFECTS:
        _bad(f"{path}.affects",
             f"{len(raw_affects)} entries, at most {MAX_AFFECTS}")

    return {
        "id": event_id,
        "at": doc["at"],
        "precision": precision,
        "session": session,
        "title": _bounded_str(doc.get("title"), f"{path}.title",
                              MAX_TITLE_CHARS),
        "kind": kind,
        "source": _source(doc.get("source"), f"{path}.source", kind),
        "symbols": symbols,
        "affects": [_affect(one, f"{path}.affects[{i}]", known)
                    for i, one in enumerate(raw_affects)],
        "rank": _int_in(doc.get("rank"), f"{path}.rank", 1, MAX_EVENTS),
        "push": _push(doc.get("push"), f"{path}.push"),
    }


# --------------------------------------------------------------------------
# The document
# --------------------------------------------------------------------------

def parse_calendar(doc: object, *, known_position_ids: frozenset[str] | set[str],
                   now: datetime.datetime | None = None) -> dict:
    """Validate an event book and return its normalised form.

    Args:
        doc: the body as it arrived.
        known_position_ids: every id in the desk's current positions document.
            An ``affects`` entry naming anything else is refused -- which is
            what makes the fourth clause of the source rule reachable, and is
            also why :mod:`~claudepost.positions` keeps size out of its hash.
        now: injected, so the window is testable at a fixed instant.

    An invalid book is refused whole and leaves the one in force untouched: a
    half-applied book is a phone showing a reason beside an event whose date
    was refused.

    Raises:
        BadRequest: code ``bad_calendar``, message ``"<json path>: <why>"``.
    """
    now = (datetime.datetime.now(datetime.timezone.utc) if now is None
           else now)
    known = frozenset(known_position_ids)

    doc = _obj(doc, "calendar")
    _no_extra_keys(doc, _TOP_KEYS, "calendar")

    lang = doc.get("lang")
    if lang is None:
        lang = "en"
    lang = _bounded_str(lang, "calendar.lang", 8)
    if not LANG_RE.match(lang):
        _bad("calendar.lang", f"{lang!r} is not a language tag")

    raw_events = doc.get("events")
    if raw_events is None:
        raw_events = []
    if not isinstance(raw_events, list):
        _bad("calendar.events", f"expected a list, got {raw_events!r}")
    if len(raw_events) > MAX_EVENTS:
        _bad("calendar.events",
             f"{len(raw_events)} events, at most {MAX_EVENTS}")

    events = [_event(one, f"calendar.events[{i}]", known, now)
              for i, one in enumerate(raw_events)]

    # Rank is the agent's own ordering -- which events cleared the floor first,
    # and which `shortfall` is counted against -- so a repeated one is two
    # events with an equal claim on the tenth slot. The phone sorts by time.
    by_rank: dict[int, int] = {}
    by_id: dict[str, int] = {}
    for i, event in enumerate(events):
        if event["rank"] in by_rank:
            _bad(f"calendar.events[{i}].rank",
                 f"rank {event['rank']} is already events[{by_rank[event['rank']]}]'s")
        by_rank[event["rank"]] = i
        if event["id"] in by_id:
            _bad(f"calendar.events[{i}].id",
                 f"{event['id']} is already events[{by_id[event['id']]}]'s")
        by_id[event["id"]] = i

    shortfall = doc.get("shortfall")
    if shortfall is not None:
        shortfall = _bounded_str(shortfall, "calendar.shortfall",
                                 MAX_SHORTFALL_CHARS)

    out = {
        "generated_at": "",
        "lang": lang,
        "target": _int_in(doc.get("target", 10), "calendar.target",
                          1, MAX_TARGET),
        "events": events,
        "shortfall": shortfall,
    }

    size = len(_serialised({**out, "generated_at": _WIDEST_STAMP}))
    if size > MAX_DOC_BYTES:
        _bad("calendar", f"{size} bytes serialised, at most {MAX_DOC_BYTES}")

    return out


# --------------------------------------------------------------------------
# The written form
# --------------------------------------------------------------------------

def _serialised(doc: dict) -> bytes:
    return json_bytes(doc)


def prune_to_positions(doc: dict, known: frozenset[str] | set[str]
                       ) -> tuple[dict, int, int]:
    """The book with reasoning about vanished positions removed.

    Returns ``(book, events_dropped, affects_dropped)``. The book is a new
    document; ``doc`` is left alone.

    Called when the owner edits their positions. The alternative that looks
    simpler is to leave the book exactly as filed and let :func:`load` refuse
    it on the next boot -- but that serves a book whose ``affects`` point at
    positions that no longer exist for however many hours lie between here and
    that boot, and the phone has nothing sensible to render for one.

    The alternative that looks safer is to discard the whole book. That throws
    away nine true statements because a tenth stopped being about anything.

    So: drop exactly the entries that became false, and drop an event only when
    it has no reasoning left -- which is the same floor :func:`_event` applies
    on the way in, applied again to a book the world moved underneath. What
    survives is every statement that is still true, and what the desk holds in
    memory is again something :func:`load` would accept.

    Note what does **not** trigger this. :func:`~claudepost.positions._id_material`
    deliberately leaves size, price and note outside the hash, so correcting an
    average or buying ten more shares does not change an id and cannot cost a
    single sentence here. An id disappears when a position is closed or its
    contract changes, and those are exactly the times the reasoning about it
    stopped being true.
    """
    known = frozenset(known)
    events = []
    affects_dropped = 0
    for event in doc.get("events", []):
        kept = [one for one in event["affects"]
                if one["position_id"] in known]
        affects_dropped += len(event["affects"]) - len(kept)
        if kept:
            events.append({**event, "affects": kept})

    return ({**doc, "events": events},
            len(doc.get("events", [])) - len(events),
            affects_dropped)


def load(path: str, *, known_position_ids: frozenset[str] | set[str],
         now: datetime.datetime | None = None) -> dict | None:
    """The book at ``path``, or ``None``. Never raises.

    ``known_position_ids`` is asked for again here rather than skipped on the
    way out, and it is the one thing about this function worth knowing: a book
    whose positions the owner has since closed is refused on the next boot. It
    should be -- the reasoning in it is about holdings that no longer exist --
    and answering ``None`` puts the phone back on "no book yet" rather than on
    a book that argues about a position the owner sold.

    ``now`` is passed through for :func:`parse_calendar`'s reason and one of
    its own: the desk that reads this file has an injected clock, and a loader
    that consulted the wall clock instead would refuse, on the next boot, a
    book that same desk accepted a moment ago -- silently, because this
    function reports everything by answering ``None``.
    """
    try:
        with open(path, "rb") as f:
            raw = f.read()
    except OSError:
        return None                # missing is the ordinary case; not logged

    if len(raw) > MAX_DOC_BYTES:
        LOG.warning("%s will not parse (%d bytes, over the %d-byte cap)",
                    os.path.basename(path), len(raw), MAX_DOC_BYTES)
        return None

    try:
        raw_doc = json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError) as exc:
        LOG.warning("%s will not parse (%s)", os.path.basename(path), exc)
        return None

    try:
        doc = parse_calendar(raw_doc, known_position_ids=known_position_ids,
                             now=now)
    except BadRequest as exc:
        LOG.warning("%s will not parse (%s)",
                    os.path.basename(path), exc.message or str(exc))
        return None

    stamp = raw_doc.get("generated_at") if isinstance(raw_doc, dict) else None
    doc["generated_at"] = (stamp if isinstance(stamp, str)
                           and _STAMP_RE.match(stamp) else "")
    return doc


def save(path: str, doc: dict) -> None:
    """Write ``doc`` to ``path``, atomically, at 0600, or raise ``OSError``.

    0600 for the same reason :func:`~claudepost.positions.save` uses it: every
    ``reason`` in here is a sentence about what the owner holds.
    """
    atomic_write(path, _serialised(doc))
    try:
        os.chmod(path, 0o600)
    except OSError:
        LOG.warning("could not set 0600 on %s", os.path.basename(path))
