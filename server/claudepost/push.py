"""The phones we notify, and how a push actually leaves this machine.

Two documents on this desk are 0600 and neither is a setting. One is what the
owner holds; this is what reaches them. A push token is a *capability*: whoever
holds it can put a line of text on the owner's lock screen, from anywhere, with
no further credential. So it is stored beside the positions rather than beside
the watchlist, and it never appears in a message, a log line or a fixture.

**There is no access token.** Expo push accepts an unauthenticated POST for a
project shaped like this one -- one owner, no "enhanced security" enabled on
the Expo account -- and the sending code is therefore the whole of the
credential story. If EAS ever requires one it goes in ``tokens.json`` beside
the desk's own, read the same way :class:`claudepost.quotes.Credentials` reads
Alpaca's, and **never in this repository**.

That absence is what makes the redaction rule here easy to get wrong. There is
no API key to leak, so it looks as though there is nothing to redact -- but the
thing this module puts in a request body is the token itself, and a failed POST
comes back as an exception whose text was written by a library quoting whatever
it was handed. So the rule :mod:`claudepost.quotes` holds for a key is held
here for the tokens: every string built from an upstream failure goes through
:func:`_redact` before it exists as a message or a log line, and the ``raise``
sits outside the handler so no raw error hangs off the new exception's
``__context__`` for something further up to print.

**A ticket is joined to a token by position, in :func:`send`, or not at all.**
Expo answers with one ticket per message, in the order sent, and an error
ticket's ``details`` does not reliably carry the token it is about. The only
robust join is therefore the positional one, and the only place it can be made
is where both lists are in hand. :func:`send` makes it and writes the token
into each ticket as ``to``; if the two lengths disagree it makes *no* join at
all and says so in the log, because the failure mode of a wrong join is
:func:`prune_unregistered` deleting a phone that is working fine.

**An HTTP failure removes nothing.** :func:`send` raises rather than returning
a partial answer, and :func:`prune_unregistered` is pure and is only ever
handed tickets from a call that came back. A network blip must never be the
reason the owner stops being told about their own expiries -- and it would be a
silent reason, because a pruned phone looks exactly like a phone that was never
registered.

**The lead durations are a table, not a parser.** Six values, spelled as
ISO-8601 durations because that is what the phone and the agent both already
write. A general duration parser is a few hundred lines of surface area, a
fresh set of edge cases (``P1DT1H``? ``PT0S``? a month, which is not a
duration at all) and a validator that accepts things nothing downstream can
schedule -- for a feature that needs six values.

Two absences are deliberately different and the app depends on it. A ``lead``
that omits a kind gets :data:`DEFAULT_LEAD`, because a device that has said
nothing wants to be told something. A ``lead`` that names a kind with an empty
list gets nothing, because an app that clears every lead has to be able to say
so without the desk restoring them on the way in.
"""

from __future__ import annotations

import gzip
import json
import logging
import os
import re
import urllib.request
import zlib
from collections.abc import Callable, Sequence
from typing import NoReturn
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from .calendar import COMPUTED_KINDS
from .errors import BadRequest, Upstream
from .fsutil import atomic_write, json_bytes

LOG = logging.getLogger("claudepost.push")

EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send"

#: Expo's own ceiling on one request. Not a tuning knob: past it the service
#: refuses the whole body, so a batch of 101 is 101 notifications nobody gets.
MAX_BATCH = 100

#: One owner, a phone, a tablet, an old phone that still works, and room to be
#: wrong about how many that is. Past it a document is not a household, it is a
#: registration route somebody is hammering.
MAX_DEVICES = 8

#: Eight devices at every per-field cap is around four kilobytes, so unlike the
#: watchlist's this ceiling cannot be reached by a legal document. It is here
#: for the other half of the job: :func:`load` weighs a *file*, which may have
#: been written by a hand rather than by :func:`save`, before it hands anything
#: to a JSON parser.
MAX_DOC_BYTES = 8 * 1024

#: An Expo token is about forty-five characters. The cap is generous rather
#: than exact because the bracketed half is opaque and its length is Expo's to
#: change; what is *not* generous is :data:`TOKEN_RE`, which is the check that
#: matters.
MAX_TOKEN_CHARS = 128

#: ``America/Argentina/ComodRivadavia`` is thirty-two.
MAX_TZ_CHARS = 64

#: Per batch. Longer than the quotes proxy's six seconds because nobody is
#: waiting on this -- it runs from the scheduler tick, not from a request --
#: and a push worth sending is worth waiting a moment longer for.
UPSTREAM_TIMEOUT = 10.0

#: The most of an answer that is read into memory. A ticket list for a hundred
#: messages is a few kilobytes; four megabytes is a body that has gone wrong,
#: and truncated JSON is the same upstream failure as any other unparseable
#: body.
MAX_UPSTREAM_BYTES = 4 * 1024 * 1024

#: What a token becomes on its way into any string a human might read.
REDACTED = "<redacted>"

#: Both spellings. Expo has issued ``ExponentPushToken[...]`` since the
#: beginning and ``ExpoPushToken[...]`` alongside it; a desk that knows only
#: one refuses a real phone at the door.
TOKEN_RE = re.compile(r"^Expo(nent)?PushToken\[[A-Za-z0-9_\-]+\]\Z")

#: The same 24-hour clock :data:`claudepost.schedule._HHMM_RE` accepts, spelled
#: the same way, because the operator writes the desk's quiet hours in one file
#: and the phone's in another and being told off differently by each is how you
#: conclude one of them is broken.
HHMM_RE = re.compile(r"^([01][0-9]|2[0-3]):[0-5][0-9]\Z")

STAMP_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\Z")

PLATFORMS: tuple[str, ...] = ("ios", "android")

#: The switch every alert answers to. Four of these are
#: :data:`claudepost.calendar.COMPUTED_KINDS`, imported rather than restated so
#: the two cannot drift, and the fifth is :data:`RESEARCHED`.
#:
#: The rule is the one an earlier draft of this constant stated correctly and
#: then applied backwards: *a kind with no switch is a kind the owner cannot
#: turn off* -- and the draft's switch set was the four computed kinds alone,
#: which left the book's other four (``corporate``, ``legal``, ``index``,
#: ``other``) with no switch and therefore no way to fire at all. That is
#: incoherent with what the book is for: it ranks by effect on the positions,
#: so the event it puts at rank 1 is quite often a court date or an analyst
#: day, and a design that can rank one first and never mention it is arguing
#: with itself. They share one switch rather than getting four, because the
#: owner's question is "tell me about things somebody had to go and find",
#: not "tell me about index rebalancing but not litigation".
#:
#: Sorted so the stored document is stable across writes.
RESEARCHED = "researched"

#: The one push that is not about the event book. It is in :data:`KINDS`
#: because of the rule this module already states -- a kind with no switch is a
#: kind the owner cannot turn off -- and it is deliberately **not** in
#: :data:`LEAD_KINDS`, because a lead is "how long before the date to say this"
#: and an answer has no date. It happens when the worker finishes.
ANSWER = "answer"

#: The kinds a *lead* is meaningful for: the alerts, every one of them about a
#: dated event. :data:`DEFAULT_LEAD` is keyed by these and so is a stored
#: device's ``lead`` map.
LEAD_KINDS: tuple[str, ...] = tuple(sorted(COMPUTED_KINDS)) + (RESEARCHED,)

#: Every switch the owner has: the alert kinds, plus :data:`ANSWER`.
KINDS: tuple[str, ...] = LEAD_KINDS + (ANSWER,)

#: The kinds that carry a switch of their own. The four computed ones and the
#: answer; everything else in the book shares :data:`RESEARCHED`.
_OWN_SWITCH = frozenset(COMPUTED_KINDS) | {ANSWER}


def pref_for(kind: str) -> str:
    """Which switch a notification of ``kind`` answers to.

    One function so `alerts.py`, `app.py` and any future caller cannot disagree
    about where a `corporate` event's preference lives.
    """
    return kind if kind in _OWN_SWITCH else RESEARCHED

#: The closed set, and its arithmetic. See the module docstring for why this is
#: a table rather than a parser.
LEAD_SECONDS: dict[str, int] = {
    "PT1H": 3600,
    "PT3H": 3 * 3600,
    "PT12H": 12 * 3600,
    "P1D": 86400,
    "P2D": 2 * 86400,
    "P7D": 7 * 86400,
}

#: Shortest first, for the refusal message: a list a human reads is easier to
#: scan in the order the values actually sit in.
_LEAD_ORDER: tuple[str, ...] = tuple(
    sorted(LEAD_SECONDS, key=lambda name: LEAD_SECONDS[name]))

#: Duplicates are refused, so the list for one kind cannot be longer than the
#: set. The cap is checked first anyway, so a thousand copies of ``"P1D"`` is
#: one refusal rather than a thousand comparisons.
MAX_LEADS = len(LEAD_SECONDS)

#: What a device that has not said gets told. An expiry is warned about twice
#: because it is the one event with nothing to react to afterwards; an economic
#: release three hours out because a day's notice of a number nobody can act on
#: is noise.
DEFAULT_LEAD: dict[str, tuple[str, ...]] = {
    "earnings": ("P1D",),
    "expiry": ("P7D", "P1D"),
    "dividend": ("P1D",),
    "econ": ("PT3H",),
    # A day, like earnings, and for the same reason: a court date or an
    # analyst day is a thing to know about the evening before, not three hours
    # ahead like a scheduled release whose minute is known.
    RESEARCHED: ("P1D",),
}

#: The instant the caller stamps over an absent ``last_seen``, at its widest --
#: the same twenty characters ``app.py`` writes with ``"%Y-%m-%dT%H:%M:%SZ"``.
#: The aggregate cap weighs a document carrying this rather than the empty
#: placeholder, so that what a ``PUT`` accepts is exactly what the next boot's
#: :func:`load` takes back. See :mod:`claudepost.watchlist`'s ``_serialised``
#: for the time those two were spelled apart.
_WIDEST_STAMP = "9999-12-31T23:59:59Z"

#: No ``updated_at``. Every device carries its own ``last_seen``, which is the
#: only instant anything here reasons about -- a desk-wide stamp would be a
#: second answer to "when did this change" and neither would be wrong.
_TOP_KEYS = frozenset({"devices"})

_DEVICE_KEYS = frozenset({
    "token", "platform", "tz", "prefs", "lead", "quiet", "last_seen",
})

_QUIET_KEYS = frozenset({"from", "to"})

_KIND_KEYS = frozenset(KINDS)

_LEAD_KEYS = frozenset(LEAD_KINDS)

#: Expo's documented request headers. ``accept-encoding`` is theirs and it is
#: the one line here with a trap under it: ``urllib`` does not decompress
#: anything, so advertising the encoding and reading the body raw is how a
#: perfectly good send becomes an unparseable answer. :func:`_urlopen_post`
#: decodes, and any injected ``fetch`` has to return decoded bytes.
HEADERS: dict[str, str] = {
    "accept": "application/json",
    "accept-encoding": "gzip, deflate",
    "content-type": "application/json",
}

#: ``fetch(url, headers, body) -> bytes``. A POST rather than the quotes
#: proxy's GET, and injected for the same two reasons: every test in this
#: module runs without a socket, and the code holding the tokens can be read
#: without reading anything about HTTP.
Fetch = Callable[[str, dict[str, str], bytes], bytes]


# --------------------------------------------------------------------------
# Refusals
# --------------------------------------------------------------------------

def _bad(path: str, why: str) -> NoReturn:
    """Refuse the document, naming the field.

    The message is what lands in the 400 body, and its readers are the phone's
    notification settings -- which renders it under the switch the owner just
    touched -- and whoever is reading the log after :func:`load` declined a
    file. Both need the field name more than they need the sentence.
    """
    raise BadRequest("bad_push", f"{path}: {why}")


def _no_extra_keys(doc: dict, allowed: frozenset[str], path: str) -> None:
    """Refuse keys nobody reads.

    A contract boundary, as in :mod:`~claudepost.positions`: this document is
    written by a phone that may be a release ahead of the desk, and a
    preference the desk does not understand has to become a refusal the app can
    show rather than a switch the owner believes they moved.
    """
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


def _bounded_str(value: object, path: str, max_len: int) -> str:
    if not isinstance(value, str):
        _bad(path, f"expected a string, got {value!r}")
    if len(value) > max_len:
        _bad(path, f"{len(value)} characters, at most {max_len}")
    return value


def _bool(value: object, path: str, default: bool) -> bool:
    """A switch, or the default. A string is not a switch.

    ``"false"`` is truthy in Python and is exactly what a hand-edited file or a
    form-encoded client sends; taking it would turn a preference the owner
    turned off into one that fires.
    """
    if value is None:
        return default
    if not isinstance(value, bool):
        _bad(path, f"expected true or false, got {value!r}")
    return value


def _token(value: object, path: str) -> str:
    """An Expo push token, as it arrived.

    Not canonicalised in any way. The token is opaque, it is what the join in
    :func:`send` and the removal in :func:`prune_unregistered` match on, and a
    desk that trimmed or cased it would be sending to a string no phone owns.
    """
    text = _bounded_str(value, path, MAX_TOKEN_CHARS)
    if not TOKEN_RE.match(text):
        _bad(path, f"{text!r} is not an Expo push token "
                   f"(ExponentPushToken[...])")
    return text


def _tz(value: object, path: str) -> str:
    """An IANA zone the desk can actually resolve.

    Required rather than defaulted, and resolved here rather than at first use,
    for the two halves of the same reason. A zone is what turns "23:00" into an
    instant, so guessing UTC for a phone in Seoul puts the quiet hours nine
    hours out and the push lands at eight in the morning -- silently, correctly
    by the code's own lights. And a zone that throws inside the scheduler tick
    is a text file that took the desk down, which is the argument
    :func:`claudepost.schedule.parse_schedule` makes at its own ``timezone``.
    """
    text = _bounded_str(value, path, MAX_TZ_CHARS)
    try:
        ZoneInfo(text)
    except (ZoneInfoNotFoundError, ValueError) as exc:
        _bad(path, f"unknown time zone {text!r} ({exc})")
    return text


def _hhmm(value: object, path: str) -> str:
    if not isinstance(value, str) or not HHMM_RE.match(value):
        _bad(path, f"expected a 24-hour HH:MM clock time, got {value!r}")
    return value


def _stamp(value: object, path: str) -> str:
    """A ``...Z`` instant, or the empty placeholder for a device never seen.

    Accepted rather than refused as unknown, because the phone GETs this
    document and PUTs it back; the caller that owns a clock overwrites it for
    the device it just heard from.
    """
    if value is None:
        return ""
    text = _bounded_str(value, path, len(_WIDEST_STAMP))
    if text and not STAMP_RE.match(text):
        _bad(path, f"expected an instant like 2026-09-08T05:00:00Z, "
                   f"got {text!r}")
    return text


# --------------------------------------------------------------------------
# The document
# --------------------------------------------------------------------------

def _prefs(value: object, path: str) -> dict:
    """Every switch, all of them present in the answer.

    There are five: one per computed kind, and ``researched`` shared by the
    four kinds somebody had to go and find. :data:`KINDS` is the list and
    :func:`pref_for` is the only place that mapping lives.

    An absent switch is **on**. A device that has never said otherwise wants
    the events it went to the trouble of registering for, and the phone should
    never have to reason about the difference between "off" and "not mentioned"
    -- so this returns every switch regardless of what arrived.
    """
    doc = {} if value is None else _obj(value, path)
    _no_extra_keys(doc, _KIND_KEYS, path)
    return {kind: _bool(doc.get(kind), f"{path}.{kind}", True)
            for kind in KINDS}


def _leads(value: object, path: str, kind: str) -> list[str]:
    """One kind's lead times, longest first.

    Sorted rather than kept in the order they arrived, so that the same set of
    leads is the same document however the app happened to list them, and so
    that the stored order is the order they fire.
    """
    where = f"{path}.{kind}"
    if not isinstance(value, list):
        _bad(where, f"expected a list of durations, got {value!r}")
    if len(value) > MAX_LEADS:
        _bad(where, f"{len(value)} leads, at most {MAX_LEADS}")

    seen: list[str] = []
    for i, one in enumerate(value):
        if not isinstance(one, str) or one not in LEAD_SECONDS:
            _bad(f"{where}[{i}]",
                 f"expected one of {', '.join(_LEAD_ORDER)}, got {one!r}")
        if one in seen:
            _bad(f"{where}[{i}]",
                 f"{one} twice is the same notification twice")
        seen.append(one)
    return sorted(seen, key=lambda name: -LEAD_SECONDS[name])


def _lead(value: object, path: str) -> dict:
    """How far ahead each *dated* kind is announced.

    An omitted kind takes :data:`DEFAULT_LEAD`; a kind named with an empty list
    takes nothing. The two are different on purpose -- see the module
    docstring -- and this is the one place in the document where absence and
    emptiness do not mean the same thing.

    :data:`LEAD_KINDS` rather than :data:`KINDS`, so ``answer`` is refused here
    as an unknown key: a lead for a notification with no date is a number
    nothing downstream could read.
    """
    doc = {} if value is None else _obj(value, path)
    _no_extra_keys(doc, _LEAD_KEYS, path)
    return {kind: (list(DEFAULT_LEAD[kind]) if doc.get(kind) is None
                   else _leads(doc[kind], path, kind))
            for kind in LEAD_KINDS}


def _quiet(value: object, path: str) -> dict | None:
    """The window in which nothing is delivered, or ``None`` for none.

    The window may wrap midnight -- ``23:00`` to ``07:00`` is the ordinary
    case -- so the two clocks are not required to be in order. They are
    required to *differ*: a window whose ends are the same minute is either no
    quiet hours at all or every hour of the day, and nothing downstream can
    tell which was meant.
    """
    if value is None:
        return None
    doc = _obj(value, path)
    _no_extra_keys(doc, _QUIET_KEYS, path)
    start = _hhmm(doc.get("from"), f"{path}.from")
    end = _hhmm(doc.get("to"), f"{path}.to")
    if start == end:
        _bad(path, f"'from' and 'to' are both {start} -- a window with no "
                   f"width is either no quiet hours or all of them, and this "
                   f"cannot say which")
    return {"from": start, "to": end}


def _device(value: object, path: str) -> dict:
    doc = _obj(value, path)
    _no_extra_keys(doc, _DEVICE_KEYS, path)

    out = {
        "token": _token(doc.get("token"), f"{path}.token"),
        "platform": _one_of(doc.get("platform"), f"{path}.platform",
                            PLATFORMS),
        "tz": _tz(doc.get("tz"), f"{path}.tz"),
        "prefs": _prefs(doc.get("prefs"), f"{path}.prefs"),
        "lead": _lead(doc.get("lead"), f"{path}.lead"),
    }
    quiet = _quiet(doc.get("quiet"), f"{path}.quiet")
    if quiet is not None:
        out["quiet"] = quiet
    out["last_seen"] = _stamp(doc.get("last_seen"), f"{path}.last_seen")
    return out


def parse_devices(doc: object) -> dict:
    """Validate a push-registration document and return its normalised form.

    An invalid document is refused whole, the rule every operator-editable
    document on this desk follows. Here it also means something narrower: the
    registration route replaces the list rather than appending to it, so a
    half-applied document is a household with some of its phones missing and
    no way to notice.

    Nothing in this function reads a clock. ``last_seen`` is passed through and
    stamped by the caller that owns one, which is why the aggregate cap below
    weighs a document carrying the widest stamp rather than the placeholder.

    Raises:
        BadRequest: code ``bad_push``, message ``"<json path>: <why>"``.
    """
    doc = _obj(doc, "push")
    _no_extra_keys(doc, _TOP_KEYS, "push")

    raw = doc.get("devices")
    if raw is None:
        raw = []
    if not isinstance(raw, list):
        _bad("push.devices", f"expected a list, got {raw!r}")
    if len(raw) > MAX_DEVICES:
        _bad("push.devices", f"{len(raw)} devices, at most {MAX_DEVICES}")

    devices = [_device(one, f"push.devices[{i}]") for i, one in enumerate(raw)]

    # The same token twice is one phone listed twice, and every push would go
    # out twice with it -- which reads, on the lock screen, exactly like the
    # desk having a bug.
    seen: dict[str, int] = {}
    for i, device in enumerate(devices):
        if device["token"] in seen:
            _bad(f"push.devices[{i}]",
                 f"the same device as [{seen[device['token']]}] -- every "
                 f"notification would arrive twice")
        seen[device["token"]] = i

    out = {"devices": devices}

    # Weighed in the form `save` writes and with the stamp the caller is about
    # to add, so that what this accepts is exactly what `load` takes back.
    widest = {"devices": [dict(one, last_seen=_WIDEST_STAMP)
                          for one in devices]}
    size = len(_serialised(widest))
    if size > MAX_DOC_BYTES:
        _bad("push", f"{size} bytes serialised, at most {MAX_DOC_BYTES}")

    return out


# --------------------------------------------------------------------------
# The written form
# --------------------------------------------------------------------------

def _serialised(doc: dict) -> bytes:
    """The document exactly as it goes on disk.

    One function rather than a spelling at each end, so that the aggregate cap
    in :func:`parse_devices` and the bytes :func:`save` writes are weighing the
    same thing.
    """
    return json_bytes(doc)


def load(path: str) -> dict | None:
    """The registered devices at ``path``, or ``None``. Never raises.

    ``None`` is both "no file" and "a file this will not take", the same
    conflation :mod:`~claudepost.positions` makes and for the same reason: the
    caller's action is identical either way, which is to notify nobody. The
    difference is in the log, which is why an unparseable file gets a line and
    a missing one does not.
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
        return parse_devices(raw_doc)
    except BadRequest as exc:
        LOG.warning("%s will not parse (%s)",
                    os.path.basename(path), exc.message or str(exc))
        return None


def save(path: str, doc: dict) -> None:
    """Write ``doc`` to ``path``, atomically, at 0600, or raise ``OSError``.

    ``doc`` is trusted to be normalised already -- ``parse_devices(body)``,
    then the caller's ``last_seen``, in that order. The mode is the same one
    :func:`claudepost.positions.save` uses and for a closely related reason: a
    watchlist is a list of companies, and this is a list of ways to reach the
    owner's phone.
    """
    atomic_write(path, _serialised(doc))
    try:
        os.chmod(path, 0o600)
    except OSError:                # a filesystem without modes is not a reason
        LOG.warning("could not set 0600 on %s", os.path.basename(path))


# --------------------------------------------------------------------------
# Sending
# --------------------------------------------------------------------------

def _redact(text: str, tokens: Sequence[str]) -> str:
    """Replace every push token wherever it appears.

    Empty strings are skipped: ``"".replace`` matches between every character
    and would turn a message somebody has to diagnose into confetti.
    """
    out = text
    for token in tokens:
        if token:
            out = out.replace(token, REDACTED)
    return out


def _decompressed(raw: bytes, encoding: str) -> bytes:
    """The body, whatever :data:`HEADERS` invited the server to do to it.

    ``urllib`` decodes nothing on its own, so this is not optional insurance --
    it is the other half of ``accept-encoding``. Deflate is tried both ways
    because the header names a format servers disagree about: zlib-wrapped is
    what the RFC says and raw is what several send.
    """
    kind = encoding.strip().lower()
    if kind == "gzip":
        return gzip.decompress(raw)
    if kind == "deflate":
        try:
            return zlib.decompress(raw)
        except zlib.error:
            return zlib.decompress(raw, -zlib.MAX_WBITS)
    return raw


def _urlopen_post(url: str, headers: dict[str, str], body: bytes) -> bytes:
    """POST ``body`` and return the answer. The only place ``urllib`` appears.

    The read is bounded by :data:`MAX_UPSTREAM_BYTES` and the cap is not
    checked afterwards: a body that hit it is truncated JSON, which the
    caller's parse turns into the same upstream failure as any other body it
    cannot read.
    """
    request = urllib.request.Request(url, data=body, headers=headers,
                                     method="POST")
    with urllib.request.urlopen(request, timeout=UPSTREAM_TIMEOUT) as response:
        raw = response.read(MAX_UPSTREAM_BYTES)
        return _decompressed(
            raw, response.headers.get("Content-Encoding", "") or "")


def _tokens_of(messages: Sequence[dict]) -> list[str]:
    """Every ``to`` in a batch, for :func:`_redact` to look for."""
    return [one["to"] for one in messages
            if isinstance(one, dict) and isinstance(one.get("to"), str)]


def _joined(tickets: list, messages: Sequence[dict]) -> list[dict]:
    """Write each message's token into the ticket that answers it.

    Positional, because Expo answers in order and an error ticket's ``details``
    does not reliably name the token. And **all or nothing**: if the lengths
    disagree the position means nothing, and a join made anyway would hand
    :func:`prune_unregistered` a ``DeviceNotRegistered`` verdict against
    whichever phone happened to sit at that index.
    """
    if len(tickets) != len(messages):
        LOG.warning("push: %d ticket(s) for %d message(s) -- leaving them "
                    "unjoined, because the wrong join deletes a working phone",
                    len(tickets), len(messages))
        return list(tickets)

    out: list[dict] = []
    for ticket, message in zip(tickets, messages):
        to = message.get("to") if isinstance(message, dict) else None
        if isinstance(ticket, dict) and isinstance(to, str):
            out.append(dict(ticket, to=to))
        else:
            out.append(ticket)
    return out


def _send_batch(messages: Sequence[dict], fetch: Fetch) -> list[dict]:
    """One POST of at most :data:`MAX_BATCH` messages, and its tickets."""
    tokens = _tokens_of(messages)
    body = json.dumps(list(messages), ensure_ascii=False).encode("utf-8")
    try:
        raw = fetch(EXPO_PUSH_URL, dict(HEADERS), body)
        doc = json.loads(raw)
        data = doc.get("data") if isinstance(doc, dict) else None
        if not isinstance(data, list):
            # Expo reports a request-level refusal as `{"errors": [...]}` with
            # no `data` at all, and an outage in front of it as an HTML page
            # served with a 200. Neither is a ticket list, and a caller that
            # took either as "no tickets" would report a silent success.
            raise ValueError(f"expected a ticket list, got "
                             f"{type(doc).__name__} carrying no 'data'")
        return _joined(data, messages)
    except Exception as exc:                                   # noqa: BLE001
        safe = _redact(f"{type(exc).__name__}: {exc}", tokens)
        LOG.warning("push: send failed (%s)", safe)
        failure = Upstream(message=f"push: {safe}")
    # Raised out here rather than inside the handler, the trick
    # `claudepost.quotes._get` documents: by this line the handler has exited,
    # so nothing in flight is attached to the new exception's `__context__` for
    # something further up to print. `from None` stays as well, so the
    # suppression holds if this raise is ever moved back inside.
    raise failure from None


#: The transport :func:`send` uses when nobody injects one, named publicly so a
#: caller that wants to hold it -- `Desk.push_fetch`, so a test can swap it --
#: does not have to reach for the underscore.
DEFAULT_FETCH: "Fetch" = _urlopen_post


def send(messages: Sequence[dict], *, fetch: Fetch = _urlopen_post) -> list[dict]:
    """Deliver ``messages`` and return one ticket each, in the same order.

    Each ticket carries the ``to`` of the message it answers -- see
    :func:`_joined` for why that join is made here and nowhere else -- and is
    what :func:`prune_unregistered` reads.

    Batched at :data:`MAX_BATCH` because that is Expo's limit on one request.
    An empty list makes no call at all: a tick with nothing to announce should
    not be a request.

    A failed batch aborts the whole send, discarding the tickets already in
    hand. That is deliberate and it costs something -- a retry re-delivers a
    batch that already landed, which the owner sees as a duplicate -- and the
    alternative costs more: a partial run reported as a complete one is a
    :func:`prune_unregistered` pass acting on a list of tickets that is missing
    most of its phones.

    Raises:
        ~claudepost.errors.Upstream: 502, for anything the POST does --
            refusing, timing out, or answering with a body carrying no ticket
            list. Its message carries no push token.
    """
    tickets: list[dict] = []
    for start in range(0, len(messages), MAX_BATCH):
        tickets.extend(_send_batch(messages[start:start + MAX_BATCH], fetch))
    return tickets


def prune_unregistered(doc: dict, tickets: Sequence[dict]) -> tuple[dict, list[str]]:
    """Drop the devices Expo says no longer exist. Returns ``(doc, removed)``.

    Pure: ``doc`` is not modified and the answer is a fresh document, so a
    caller that decides not to write it has changed nothing. ``removed`` is in
    document order and lists only tokens that were actually there -- a ticket
    for a phone already gone is not a removal.

    Only ``DeviceNotRegistered`` removes anything. Every other error Expo can
    report is about *this* notification -- a message too big, a rate limit, an
    invalid credential -- and deleting a phone over one of those is deleting it
    over a bad afternoon.

    The token is taken from the ``to`` :func:`send` joined on, falling back to
    ``details.expoPushToken`` when Expo sends one; if neither is there the
    ticket names no phone and removes none.
    """
    gone: set[str] = set()
    for ticket in tickets:
        if not isinstance(ticket, dict) or ticket.get("status") != "error":
            continue
        details = ticket.get("details")
        details = details if isinstance(details, dict) else {}
        if details.get("error") != "DeviceNotRegistered":
            continue
        token = ticket.get("to")
        if not isinstance(token, str) or not token:
            token = details.get("expoPushToken")
        if isinstance(token, str) and token:
            gone.add(token)

    devices = doc.get("devices")
    devices = devices if isinstance(devices, list) else []
    kept = [one for one in devices
            if not (isinstance(one, dict) and one.get("token") in gone)]
    removed = [one["token"] for one in devices
               if isinstance(one, dict) and one.get("token") in gone]
    return dict(doc, devices=kept), removed


# --------------------------------------------------------------------------
# The answer
# --------------------------------------------------------------------------

#: The delivery ledger's ``lead`` for an answer. Every alert value in that
#: column is an ISO-8601 duration, and this deliberately is not one: an answer
#: has no lead, so ``"0"`` cannot collide with a real value and reads in the
#: table as what it is.
ANSWER_LEAD = "0"

#: What an answer's notification is titled. The app's own name rather than the
#: message's subject, because a lock screen already shows the app and the body
#: is the only line with room to say something.
ANSWER_TITLE = "Claude Post"

#: The two sentences an answer can carry, by language and by outcome. A failed
#: command gets its own sentence rather than the same one: a notification that
#: promised an answer and opens onto an error is a worse failure than the one
#: it is reporting. What went wrong is the command's `result`, which the phone
#: reads from the row -- this is only the knock at the door.
ANSWER_BODY: dict[str, dict[str, str]] = {
    "en": {"done": "Your answer is ready",
           "failed": "The desk could not answer that"},
    "ko": {"done": "답변이 도착했습니다",
           "failed": "답변을 만들지 못했어요"},
}


def answer_event_id(cid: str) -> str:
    """The delivery ledger's ``event_id`` for a command's answer.

    Prefixed, because the ledger's rows are keyed ``(token, event_id, lead)``
    and the event ids in the same table come from the owner's book. A command id
    and an event id have different shapes today and a prefix means the promise
    does not rest on that staying true.
    """
    return "cmd:" + cid


def answer_message(token: str, cid: str, status: str, result: str,
                   lang: str | None) -> dict:
    """The Expo message telling one phone its message has an answer.

    ``data`` carries the command id and the **first word** of ``result`` --
    `answered`, `revised`, `staged`, or whatever a failure's message begins
    with. The desk does not parse `result` and this is not it starting to: the
    first word is what tells the phone which screen to open, and it re-reads the
    row for everything else.

    An unknown or absent ``lang`` takes English. The caller resolves the
    fallback it wants before calling -- `Desk` uses the desk's own settings --
    so this is the last line of defence rather than the policy.
    """
    copy = ANSWER_BODY.get(lang or "", ANSWER_BODY["en"])
    words = (result or "").split()
    return {
        "to": token,
        "title": ANSWER_TITLE,
        "body": copy["done" if status == "done" else "failed"],
        "sound": "default",
        "data": {"command_id": cid, "result": words[0] if words else ""},
    }
