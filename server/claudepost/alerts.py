"""Which alerts are due at an instant, and when the owner asked not to hear one.

Two rules pull in opposite directions, and everything here is the shape of
holding both at once:

    A lead time that passed while the desk was **down** must still fire. A
    restart is not a reason to miss the owner's expiry.

    A lead whose **event has already happened** must not fire. Nobody needs
    telling about yesterday.

The first says "look backwards"; the second says "not that far". What separates
them is not how late the desk is -- it is whether the thing being announced is
still ahead of the owner. So :func:`due` takes ``now`` and answers from it, and
it is **pure**: no clock, no database, no socket. That is the same argument
:meth:`claudepost.app.Desk.tick` already makes about itself. The interesting
instants -- the moment a lead passes, the moment a quiet window ends -- are
exactly the ones a test must step over rather than wait for, and a function
that reads a clock cannot be stepped over.

**Quiet hours defer, they never drop**, and that promise is kept in two places
because it can be broken in two ways.

:func:`due` holds an alert whose *lead instant* fell inside the window: a
23:30 KST warning about a 00:30 KST expiry is not delivered at 23:30 and is
not forgotten either, it is owed until 07:00. :func:`defer_for_quiet` holds one
the *desk's own lateness* carried into the window: a lead that passed at 20:00
while the desk was down, noticed at 02:00, must not ring at 02:00.

The two together are why the past-event rule has exactly one exception. An
event that happened **inside the owner's quiet window** is one they asked not
to be woken for, so it is still delivered when the window ends -- and its copy
says it has happened. Without that exception the deferral would silently
swallow the alert, which is the failure the spec names: a 21:30 UTC print is
06:30 KST and inside nobody's window, but a 07:00 UTC one is 16:00 and a rule
that dropped it would be a rule that only ever ate the events in one half of
the day.

**The desk writes almost no prose.** ``title`` and ``body`` come from the
agent's ``push`` block, which is written with the event by the only thing that
understands it, and fall back to the event's own title and the first
``reason_short`` -- all of it already in the owner's language. The one sentence
this desk owns is :data:`ALREADY`, the already-happened marker, and it is a
two-entry table keyed by the book's ``lang`` in the shape ``ui_lang.c`` uses on
the board. A desk that composed notification copy would be a desk that had
picked a language, and it has not.

**Every kind in the book can fire, but they share five switches rather than
eight.** ``prefs`` and ``lead`` are keyed by :data:`claudepost.push.KINDS`: the
four computed kinds each have their own, and the book's other four --
``corporate``, ``legal``, ``index``, ``other`` -- share ``researched``.
:func:`claudepost.push.pref_for` is the one place that mapping lives, so this
module and any future caller cannot disagree about where a court date's
preference is kept.
"""

from __future__ import annotations

import datetime
import logging
from collections import namedtuple
from collections.abc import Iterable, Mapping, Sequence
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from .calendar import KINDS as CALENDAR_KINDS
from .push import LEAD_SECONDS, MAX_BATCH, pref_for as push_pref_for

LOG = logging.getLogger("claudepost.alerts")

#: How far back the delivery ledger has to be read to decide what is owed
#: **now**, and it is derived rather than chosen. The longest lead is seven
#: days, so a delivery happens at most seven days before its event; an event
#: leaves the book seven days after it happens
#: (:data:`claudepost.calendar.PAST_WINDOW`). A delivery about an event still
#: in the book is therefore at most fourteen days old, and the day of slack is
#: for a desk whose clock moved. Rows older than this are still *kept* -- see
#: :data:`RETENTION_SECONDS` -- they simply cannot change an answer.
LOOKBACK_SECONDS = 15 * 86400

#: How long a delivery row is kept. Sixty days is well past the point where it
#: can suppress anything; what it buys is the answer to "was I told about
#: that", asked weeks later by somebody who thinks they were not.
RETENTION_SECONDS = 60 * 86400

#: The most alerts one tick will send. It is not a number of its own: it is one
#: POST, which is :data:`claudepost.push.MAX_BATCH`, which is Expo's own ceiling
#: on a request -- so a tick's worst case is one
#: :data:`claudepost.push.UPSTREAM_TIMEOUT`, ten seconds, rather than a minute
#: of them in a row. What does not fit is not lost; it is owed, and the next
#: tick is five seconds away.
MAX_PER_TICK = MAX_BATCH

#: The one sentence this module writes, prefixed to the body of an alert a
#: quiet window held past its event. Two entries, and English for a book in any
#: other language: a marker in the wrong language is still true, where no
#: marker at all is a notification that says a thing is coming when it has
#: already gone.
ALREADY: dict[str, str] = {
    "en": "This has already happened. ",
    "ko": "이미 지났어요. ",
}

_STAMP_FORMAT = "%Y-%m-%dT%H:%M:%SZ"

Alert = namedtuple("Alert", "token event_id lead at_utc title body")
Alert.__doc__ = """One notification, decided but not yet sent.

``token``, ``event_id`` and ``lead`` are the delivery ledger's key -- the
promise being kept is one notification per phone per event per lead, ever.
``at_utc`` is the event's instant spelled exactly as the book spells it
(``2026-11-04T21:00:00Z``), because that is what goes to the phone and what
the phone renders in its own zone. ``title`` and ``body`` are the copy as it
will be sent, decided at the instant :func:`due` was asked: an alert built
after its event carries the marker, one built before it does not.
"""


# --------------------------------------------------------------------------
# Instants
# --------------------------------------------------------------------------

def _epoch(text: object) -> float | None:
    """A ``2026-11-04T21:00:00Z`` instant as epoch seconds, or ``None``.

    :func:`claudepost.calendar.parse_calendar` has already refused anything
    else, so ``None`` here means a book that reached memory some other way.
    It is answered rather than raised because this runs inside the scheduler
    tick, and one malformed instant must cost one event rather than the pass.
    """
    if not isinstance(text, str):
        return None
    try:
        return datetime.datetime.strptime(text, _STAMP_FORMAT).replace(
            tzinfo=datetime.timezone.utc).timestamp()
    except ValueError:
        return None


def _hhmm(text: str) -> int:
    """``"23:00"`` as minutes past local midnight."""
    hour, _, minute = text.partition(":")
    return int(hour) * 60 + int(minute)


def _zone(device: Mapping) -> ZoneInfo | None:
    """The device's zone, or ``None`` when this machine cannot resolve it.

    ``None`` means **no quiet window**, never UTC.
    :func:`claudepost.push._tz` refused an unresolvable zone at the door, so
    getting here means the zone database changed under a document the desk
    already accepted -- and on that day, guessing UTC for a phone in Seoul
    puts the quiet hours nine hours out and silences the alert the owner
    actually wanted at the hour they wanted it. A wrong window is worse than
    none.
    """
    name = device.get("tz")
    if not isinstance(name, str) or not name:
        return None
    try:
        return ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError):
        LOG.debug("alerts: no zone %r on this machine; no quiet window", name)
        return None


def _quiet_release(device: Mapping, when: float) -> float | None:
    """The end of the quiet window containing ``when``, or ``None``.

    ``None`` is "``when`` is not inside a quiet window", which is also the
    answer for a device that set none and for one whose zone this machine
    cannot resolve. So a caller can read the answer as "the instant this
    device will accept a notification, if it will not accept one now".

    The window is half-open, ``[from, to)``: at exactly ``to`` the owner is
    awake. It may wrap midnight -- ``23:00`` to ``07:00`` is the ordinary
    case, and :func:`claudepost.push._quiet` has already refused one with no
    width, which is the only shape this arithmetic could not read.
    """
    quiet = device.get("quiet")
    if not isinstance(quiet, Mapping) or not quiet:
        return None
    zone = _zone(device)
    if zone is None:
        return None

    local = datetime.datetime.fromtimestamp(when, zone)
    start, end = _hhmm(quiet["from"]), _hhmm(quiet["to"])
    minute = local.hour * 60 + local.minute
    inside = (start <= minute < end) if start < end else (minute >= start
                                                          or minute < end)
    if not inside:
        return None

    release = local.replace(hour=end // 60, minute=end % 60, second=0,
                            microsecond=0)
    if release <= local:
        release += datetime.timedelta(days=1)
    # Wall-clock arithmetic in the device's own zone, so a window that ends at
    # 07:00 ends at 07:00 on the morning the clocks moved too. The guard is for
    # exactly that morning: in a zone that skips 07:00 entirely, a release that
    # did not come out later than `when` would be a hold that never lifts.
    instant = release.timestamp()
    return instant if instant > when else None


def defer_for_quiet(alert: Alert, device: Mapping,
                    now: float) -> float | None:
    """When this alert may be delivered, or ``None`` for now.

    The last gate before a send. :func:`due` has already held back an alert
    whose *lead instant* fell inside the window; this holds one that arrived
    at the window some other way -- the desk was down when the lead passed and
    came back at two in the morning. Both are the same promise from different
    directions, and the alert is deferred rather than dropped either way: it
    stays owed, and the next tick after the window ends sends it.

    ``alert`` is not read. The answer is a fact about the device's clock and
    the instant, not about the notification -- but the question a caller is
    asking is "may *this* go now", and a signature that hid the subject would
    read at the call site as though the device were being asked about in
    general.
    """
    return _quiet_release(device, now)


# --------------------------------------------------------------------------
# The copy
# --------------------------------------------------------------------------

def _copy(event: Mapping, lang: str, passed: bool) -> tuple[str, str]:
    """The title and body to send, in the owner's language throughout.

    The agent's ``push`` block first, because it was written with the event by
    the only thing that understands both the event and the position it
    reaches. The fallbacks are the event's own title and the first
    ``reason_short``, which are prose from the same source -- never a sentence
    assembled here.

    ``passed`` prefixes :data:`ALREADY` to the *body* rather than the title.
    The title is capped at sixty characters by the validator and is what a
    lock screen shows first; spending a dozen of them on the marker would push
    the event's own name off the notification that exists to name it.
    """
    copy = event.get("push")
    copy = copy if isinstance(copy, Mapping) else {}

    title = copy.get("title") or event.get("title") or ""
    body = copy.get("body") or _first_reason(event)
    if passed:
        body = ALREADY.get(lang, ALREADY["en"]) + body
    return str(title), str(body)


def _first_reason(event: Mapping) -> str:
    """The event's first ``reason_short``, or nothing.

    ``affects`` is non-empty by the time a book is in memory -- an event with
    no reasoning is refused at the door -- so the empty answer is for a book
    that got here some other way, and an empty body is a notification that
    still names its event in the title.
    """
    for one in event.get("affects") or ():
        if isinstance(one, Mapping) and one.get("reason_short"):
            return str(one["reason_short"])
    return ""


def message(alert: Alert) -> dict:
    """The Expo message for ``alert``, as :func:`claudepost.push.send` takes it.

    ``data`` carries what the phone needs to open the right row and nothing
    else. It is not a privacy boundary -- this is going to the owner's own
    lock screen -- it is that an event id and an instant are what a deep link
    is made of, and a notification the app cannot act on is one the owner has
    to go and find the reason for.
    """
    return {
        "to": alert.token,
        "title": alert.title,
        "body": alert.body,
        "sound": "default",
        "data": {"event_id": alert.event_id, "lead": alert.lead,
                 "at": alert.at_utc},
    }


# --------------------------------------------------------------------------
# What is owed
# --------------------------------------------------------------------------

def _key(entry: object) -> tuple:
    """One delivery ledger row as ``(token, event_id, lead)``.

    Both spellings, because the rows come from
    :meth:`claudepost.store.Store.deliveries_since` as mappings and a test
    writes them as tuples, and neither should have to know about the other.
    """
    if isinstance(entry, Mapping):
        return (entry.get("token"), entry.get("event_id"), entry.get("lead"))
    token, event_id, lead = tuple(entry)[:3]
    return (token, event_id, lead)


def due(book: Mapping | None, devices: Sequence[Mapping] | None,
        delivered: Iterable, now: float) -> list[Alert]:
    """Every alert owed at ``now``, soonest event first. Pure.

    ``book`` is a normalised event book and ``devices`` the list out of a
    normalised push document -- ``prefs`` and ``lead`` carrying all four kinds,
    which is what :func:`claudepost.push.parse_devices` guarantees and what
    lets this read them without asking whether a switch was mentioned.

    ``delivered`` is the ledger, as rows or as ``(token, event_id, lead)``
    tuples. It is the whole of the idempotency: an alert already in it is not
    owed, and nothing else about the past is consulted.

    Three questions per (device, event, lead), in this order:

    1. **Has the lead passed, and will this device take it?** The lead instant
       is ``at - lead``; if it fell inside the device's quiet window the alert
       is not owed until that window ends. Late is fine -- a lead that passed
       while the desk was down is still owed, however long ago.
    2. **Is the event still ahead of the owner?** If it is not, the alert is
       dropped -- with one exception.
    3. **Was the event itself inside the quiet window?** Then it is delivered
       anyway, when the window lets it, carrying :data:`ALREADY`. The owner
       asked not to be woken, not to be left uninformed, and a rule without
       this exception would eat every event that happened at four in the
       morning.

    The order is the order to send in: soonest event first, so a batch cut at
    :data:`MAX_PER_TICK` cuts the least urgent. ``at_utc`` is fixed-width
    RFC3339, so sorting it as text is sorting it as time.
    """
    if not book or not devices:
        return []

    lang = book.get("lang") or "en"
    already = {_key(one) for one in (delivered or ())}
    out: list[Alert] = []

    for event in book.get("events") or ():
        kind = event.get("kind")
        event_id = event.get("id")
        at = _epoch(event.get("at"))
        if at is None or not event_id or kind not in CALENDAR_KINDS:
            continue
        # Which switch this event answers to: its own, or `researched` if it is
        # one of the four somebody had to go and find. One function, in push.py,
        # so nothing here decides it a second way.
        pref = push_pref_for(kind)

        for device in devices:
            token = device.get("token")
            if not token or not (device.get("prefs") or {}).get(pref):
                continue

            for lead in (device.get("lead") or {}).get(pref) or ():
                seconds = LEAD_SECONDS.get(lead)
                if seconds is None or (token, event_id, lead) in already:
                    continue

                held = _quiet_release(device, at - seconds)
                owed_from = (at - seconds) if held is None else held
                if owed_from > now:
                    continue                      # not yet, or the window holds it

                passed = at <= now
                if passed and _quiet_release(device, at) is None:
                    continue                      # nobody needs telling about yesterday

                title, body = _copy(event, lang, passed)
                out.append(Alert(token, event_id, lead, event["at"],
                                 title, body))

    out.sort(key=lambda one: (one.at_utc, one.event_id, one.token,
                              -LEAD_SECONDS[one.lead]))
    return out
