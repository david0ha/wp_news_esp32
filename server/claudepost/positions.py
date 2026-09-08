"""The positions: what the owner actually holds.

This is deliberately **not** an extension of :mod:`~claudepost.watchlist`.
That module's schema is a privacy boundary in the opposite direction -- a
watchlist item may never carry an entry price, because the watchlist is the
pool the newspaper votes from and everything in it is printable material. A
position is the other kind of object: it exists to be reasoned about and must
never be printed. Putting the two in one document would make one file mean two
things and would quietly delete a reasoned boundary rather than replace it.

**A spread is one position with several legs, never two positions.** A 400/420
call vertical has a max loss, a break-even and a decay profile that neither leg
has on its own, and two rows in a table cannot be reasoned about that way
without the reader doing the joining by hand.

The two things worth reading the code for:

:func:`derive_strategy` names only what legs can prove, and ``custom`` is a
real answer rather than a failure. See its docstring for the two names that are
deliberately absent from :data:`STRATEGIES`.

An ``id`` is *derived*, not counted -- a truncated hash over what makes a
position that position: its symbol, its kind, its legs or its quantity, and the
day it was opened. Nothing else in the desk has to remember a counter, and the
same document PUT twice keeps its ids. What is left out of the hash is the
point of it: ``entry_price_cents`` and ``note`` are not in the material, so
correcting a mistyped entry price is an *edit* of that position rather than a
silent fork into two.

Validation follows :mod:`~claudepost.watchlist`'s posture exactly, down to the
spellings: unknown keys refused whole, every list and string capped, and the
aggregate weighed in the form :func:`save` actually writes so a document a
``PUT`` accepted can never be refused by the next boot's :func:`load`.

Two places this document departs from the watchlist's rules, both on purpose:

*A symbol is not upper-cased, it is required to be upper-case already.*
:func:`~claudepost.watchlist._symbol` canonicalises ``"acme"`` into ``"ACME"``
because it is deciding what a candidate is called. Here the symbol is *hash
material*: it decides which position this is. A canonicalisation rule is then
something the desk and the app both have to implement identically or disagree
about a position's identity, and the cheapest way to have no such rule is to
have none -- a symbol that does not already look like a ticker is refused,
naming the field.

*``id`` and ``strategy`` are both output only, and both are accepted and
ignored.* Each is re-derived on every write -- the id from the hash material,
the strategy from the legs -- so a supplied one decides nothing.

Accepting them is a deliberate reversal of an earlier draft that *refused* a
body carrying ``strategy``, on the argument that a supplied one is a claim
about legs that could contradict them. It could; it also could not matter, and
the refusal was a 400 that rejected the **whole book**. Every client round-trips
this document -- GET it, change one row, PUT it back -- and every option
position a GET returns carries a ``strategy``, because the file is written with
one so that whoever is working out what the phone showed can read it. So the
refusal punished the ordinary path and taught three separate clients the same
workaround: the phone had to strip the field, :func:`load` had to strip it
before re-parsing or the desk would refuse its own writing on the next boot,
and any future script would have had to discover both. Ignoring is the same
protection with none of that: the value is overwritten either way.

Unknown keys are still refused whole. What changed is only that these two
stopped being unknown.
"""

from __future__ import annotations

import datetime
import hashlib
import json
import logging
import os
import re
from typing import NoReturn

from .errors import BadRequest
from .fsutil import atomic_write, json_bytes

LOG = logging.getLogger("claudepost.positions")

#: An eighth of a megabyte, serialised -- the aggregate backstop behind the
#: per-field caps below, and half :data:`~claudepost.watchlist.MAX_DOC_BYTES`
#: because a position carries a 500-character note rather than a 16 KiB one.
#: Sixty-four positions at every per-field cap are comfortably over it, which
#: is the point: the per-field caps are independent and none of them alone
#: bounds the document.
MAX_DOC_BYTES = 128 * 1024

#: Sixty-four open positions is more than one owner runs at once; past it a
#: hand-edited or scripted document is more likely a mistake than a book.
MAX_POSITIONS = 64

#: Four legs covers every shape the app offers -- verticals, calendars,
#: straddles, butterflies, condors. A fifth is a structure the phone has no
#: room to render and the agent has no name for.
MAX_LEGS = 4

#: The owner's own words beside one row, not an edition's worth of thesis.
MAX_NOTE_CHARS = 500

MAX_CONTRACTS = 10_000

#: Signed: a negative quantity is a short. Zero is refused separately -- it is
#: not a small position, it is the absence of one.
MAX_QUANTITY = 1_000_000

#: Ten billion dollars, in cents. The brief bounds a strike only from below,
#: but every other field here has a ceiling and an unbounded integer is one
#: field that can spend the aggregate cap on its own.
MAX_CENTS = 1_000_000_000_000

#: How far out an expiry may sit. Bounded above and **not** below, which is the
#: whole care in this rule: an upper bound moves outward as today does, so a
#: document accepted today is still accepted next year. A lower bound would do
#: the opposite -- the day an option expired, :func:`load` would start refusing
#: the file the ``PUT`` had accepted, silently, which is the one failure this
#: module has no way to report.
MAX_EXPIRY_YEARS = 3

#: Digits are deliberate -- a KR symbol is numeric (e.g. ``005930``). The same
#: shape as :data:`~claudepost.watchlist.SYMBOL_RE`, matched against what
#: arrived rather than against an upper-cased copy of it; see the module
#: docstring.
SYMBOL_RE = re.compile(r"^[A-Z0-9.\-]{1,12}\Z")

DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}\Z")

#: What :func:`_position_id` mints. Six hex characters is three bytes of
#: :func:`hashlib.blake2s`: enough that sixty-four positions collide with
#: probability about one in five hundred thousand, and short enough to read
#: aloud off a phone screen.
ID_RE = re.compile(r"^p_[0-9a-f]{6}\Z")

_ID_BYTES = 3

KINDS: tuple[str, ...] = ("stock", "option")
RIGHTS: tuple[str, ...] = ("call", "put")
SIDES: tuple[str, ...] = ("long", "short")

#: Every name :func:`derive_strategy` can return, and nothing else. Two names
#: an earlier draft carried are absent on purpose; see that function.
STRATEGIES: tuple[str, ...] = (
    "long_call", "long_put", "short_call", "short_put",
    "vertical", "calendar", "straddle", "strangle", "custom",
)

#: ``updated_at`` is accepted rather than refused as unknown -- a caller that
#: GETs this document and PUTs it straight back legitimately carries one -- but
#: see :func:`parse_positions`: its value is never read.
_TOP_KEYS = frozenset({"updated_at", "positions"})

#: ``id`` and ``strategy`` are here for the round-trip reason and are both
#: re-derived rather than read -- the id from the hash material, the strategy
#: from the legs. See the module docstring for why refusing them was worse.
_POSITION_KEYS = frozenset({
    "id", "strategy", "symbol", "kind", "legs", "quantity",
    "entry_price_cents", "opened_at", "note",
})

_LEG_KEYS = frozenset({
    "right", "side", "strike_cents", "expiry", "contracts",
    "entry_price_cents",
})

#: The instant the caller stamps over :func:`parse_positions`'s ``updated_at``
#: placeholder, at its widest -- the same twenty characters
#: ``app.py`` writes with ``"%Y-%m-%dT%H:%M:%SZ"``. The backstop weighs a
#: document whose instant is still the empty placeholder while :func:`save`
#: writes one carrying a real stamp, so weighing the placeholder itself would
#: leave the cap twenty bytes short of what lands on disk.
_WIDEST_STAMP = "9999-12-31T23:59:59Z"

_STAMP_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\Z")


# --------------------------------------------------------------------------
# Naming a shape
# --------------------------------------------------------------------------

def derive_strategy(legs: list[dict]) -> str:
    """Name what these legs are, or refuse to guess.

    The owner picks a shape in the app and types legs; this turns the legs back
    into the name so the phone can say "콜 버티컬 400/420" without the owner
    having to classify their own trade. It is here rather than in the app
    because the agent needs the same name, and a second implementation in
    TypeScript is a second implementation that can disagree.

    ``custom`` is a real answer, not a failure. A shape this cannot name is one
    the reasoning should describe in words rather than one the desk should
    mislabel -- a mislabelled spread is worse than an unlabelled one, because
    the owner stops reading the legs.

    Two names an earlier draft of :data:`STRATEGIES` carried are absent for the
    same reason, and it is worth stating so nobody adds them back:

    ``covered_call`` needs the stock position beside the option one, and this
    function is handed legs. Naming that pairing is a decision made with the
    whole book in hand, at display time.

    ``cash_secured_put`` is a claim about collateral sitting in an account the
    desk cannot see. A lone short put is ``short_put``; whether it is secured
    is not something legs know.
    """
    if len(legs) == 1:
        one = legs[0]
        if one["side"] == "long":
            return "long_call" if one["right"] == "call" else "long_put"
        return "short_call" if one["right"] == "call" else "short_put"

    if len(legs) == 2:
        a, b = legs
        rights = {a["right"], b["right"]}
        sides = {a["side"], b["side"]}
        same_expiry = a["expiry"] == b["expiry"]
        same_strike = a["strike_cents"] == b["strike_cents"]

        if len(rights) == 1 and sides == {"long", "short"}:
            if same_expiry and not same_strike:
                return "vertical"
            if same_strike and not same_expiry:
                return "calendar"
        if rights == {"call", "put"} and len(sides) == 1 and same_expiry:
            return "straddle" if same_strike else "strangle"

    return "custom"


# --------------------------------------------------------------------------
# Refusals
# --------------------------------------------------------------------------

def _bad(path: str, why: str) -> NoReturn:
    """Refuse the document, naming the field.

    The message is what lands in the 400 body, and its readers are the phone's
    position sheet -- which renders it under the field the owner typed -- and
    whoever is reading the log after :func:`load` declined a file. Both need
    the field name more than they need the sentence.
    """
    raise BadRequest("bad_positions", f"{path}: {why}")


def _no_extra_keys(doc: dict, allowed: frozenset[str], path: str) -> None:
    """Refuse keys nobody reads.

    The same rule as the watchlist's, for a different reason. There it is a
    privacy boundary. Here it is a *contract* boundary: this document is
    written by a phone that may be a release ahead of the desk, and a field the
    desk does not understand has to become a refusal the app can show rather
    than a setting the owner believes they changed.
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


def _int_in(value: object, path: str, low: int, high: int) -> int:
    """A required integer in ``[low, high]``.

    ``bool`` is refused explicitly. It is an ``int`` in Python, so ``True``
    would otherwise sail through as a quantity of one, and a document that said
    ``"quantity": true`` would become a position rather than an error.
    """
    if isinstance(value, bool) or not isinstance(value, int):
        _bad(path, f"expected an integer, got {value!r}")
    if not low <= value <= high:
        _bad(path, f"{value} is outside {low}..{high}")
    return value


def _bounded_str(value: object, path: str, max_len: int) -> str:
    if not isinstance(value, str):
        _bad(path, f"expected a string, got {value!r}")
    if len(value) > max_len:
        _bad(path, f"{len(value)} characters, at most {max_len}")
    return value


def _opt_str(value: object, path: str, max_len: int, default: str) -> str:
    if value is None:
        return default
    return _bounded_str(value, path, max_len)


def _symbol(value: object, path: str) -> str:
    """A ticker, as it arrived -- not upper-cased on the way through.

    See the module docstring: this string is hash material, so a
    canonicalisation rule here is a rule the app has to implement identically
    or else disagree with the desk about which position it is looking at.
    Refusing is the version of that rule with nothing to keep in sync.
    """
    text = _bounded_str(value, path, 12)
    if not SYMBOL_RE.match(text):
        _bad(path, f"{text!r} does not look like a ticker "
                   f"(upper-case letters, digits, '.' and '-')")
    return text


def _date(value: object, path: str) -> str:
    """A ``YYYY-MM-DD`` that is also a real day.

    The pattern alone accepts ``2026-02-30``, which is the kind of value that
    survives every check until something tries to work out how many days are
    left until it.
    """
    text = _bounded_str(value, path, 10)
    if not DATE_RE.match(text):
        _bad(path, f"expected YYYY-MM-DD, got {text!r}")
    try:
        datetime.date.fromisoformat(text)
    except ValueError:
        _bad(path, f"{text!r} is not a real date")
    return text


# --------------------------------------------------------------------------
# Identity
# --------------------------------------------------------------------------

def _id_material(pos: dict) -> str:
    """What makes a position *that* position, as a canonical string.

    Three things are deliberately outside it, and it is the same reason each
    time: they are facts that change about a position the owner still thinks of
    as one position.

    ``entry_price_cents`` -- correcting a mistyped average is an edit.

    ``note`` -- the owner's own words are not identity.

    **Size** -- ``quantity`` for a stock, ``contracts`` on each leg. Adding to a
    holding must not fork it in two, and this one is load-bearing rather than
    merely tidy: the event book's ``affects[].position_id`` points here, and a
    book whose ids no longer exist is refused whole, so a size in the hash would
    throw away a morning's research because the owner bought ten more shares.
    What *is* identity for a stock is the **sign** of the quantity -- long and
    short are different positions -- and for an option the contract itself: its
    right, its side, its strike and its expiry.
    """
    parts = [pos["symbol"], pos["kind"], pos.get("opened_at") or ""]
    if pos["kind"] == "stock":
        parts.append("short" if pos["quantity"] < 0 else "long")
    else:
        legs = sorted(
            (one["right"], one["side"], str(one["strike_cents"]), one["expiry"])
            for one in pos["legs"]
        )
        parts.extend("|".join(one) for one in legs)
    return "\x1f".join(parts)


def _position_id(pos: dict) -> str:
    digest = hashlib.blake2s(_id_material(pos).encode("utf-8"),
                             digest_size=_ID_BYTES).hexdigest()
    return f"p_{digest}"


# --------------------------------------------------------------------------
# The document
# --------------------------------------------------------------------------

def _leg(value: object, path: str, today: datetime.date) -> dict:
    doc = _obj(value, path)
    _no_extra_keys(doc, _LEG_KEYS, path)

    expiry = _date(doc.get("expiry"), f"{path}.expiry")
    try:
        horizon = today.replace(year=today.year + MAX_EXPIRY_YEARS)
    except ValueError:
        # 29 February. The same day three years on does not exist, and
        # `replace` raises rather than rounding -- so on one day every four
        # years this line turned every PUT carrying an option leg into a 500,
        # on a route whose every other refusal is a 400. The 28th is the
        # conventional answer and the horizon is a bound, not a date anybody
        # reads.
        horizon = today.replace(year=today.year + MAX_EXPIRY_YEARS, day=28)
    if datetime.date.fromisoformat(expiry) > horizon:
        _bad(f"{path}.expiry",
             f"{expiry} is more than {MAX_EXPIRY_YEARS} years out")

    return {
        "right": _one_of(doc.get("right"), f"{path}.right", RIGHTS),
        "side": _one_of(doc.get("side"), f"{path}.side", SIDES),
        "strike_cents": _int_in(doc.get("strike_cents"),
                                f"{path}.strike_cents", 1, MAX_CENTS),
        "expiry": expiry,
        "contracts": _int_in(doc.get("contracts"), f"{path}.contracts",
                             1, MAX_CONTRACTS),
        "entry_price_cents": _int_in(doc.get("entry_price_cents"),
                                     f"{path}.entry_price_cents",
                                     0, MAX_CENTS),
    }


def _position(value: object, path: str, today: datetime.date) -> dict:
    doc = _obj(value, path)
    _no_extra_keys(doc, _POSITION_KEYS, path)

    kind = _one_of(doc.get("kind"), f"{path}.kind", KINDS)
    out: dict = {
        "id": "",                       # filled below, from the rest
        "symbol": _symbol(doc.get("symbol"), f"{path}.symbol"),
        "kind": kind,
        "opened_at": (None if doc.get("opened_at") is None
                      else _date(doc.get("opened_at"), f"{path}.opened_at")),
        "note": _opt_str(doc.get("note"), f"{path}.note", MAX_NOTE_CHARS, ""),
    }

    # The two halves are exclusive both ways. A stock carrying legs and an
    # option carrying a quantity are each a document written against the wrong
    # half of the schema, and reading one field while ignoring the other would
    # store a position whose own kind disagrees with its contents.
    if kind == "stock":
        if doc.get("legs") is not None:
            _bad(f"{path}.legs", "a stock position has no legs")
        quantity = _int_in(doc.get("quantity"), f"{path}.quantity",
                           -MAX_QUANTITY, MAX_QUANTITY)
        if quantity == 0:
            _bad(f"{path}.quantity",
                 "zero is the absence of a position, not a small one")
        out["quantity"] = quantity
        out["entry_price_cents"] = _int_in(doc.get("entry_price_cents"),
                                           f"{path}.entry_price_cents",
                                           0, MAX_CENTS)
    else:
        for banned in ("quantity", "entry_price_cents"):
            if doc.get(banned) is not None:
                _bad(f"{path}.{banned}",
                     "an option position carries this on each leg, not here")
        raw_legs = doc.get("legs")
        if not isinstance(raw_legs, list) or not raw_legs:
            _bad(f"{path}.legs", "expected a non-empty list")
        if len(raw_legs) > MAX_LEGS:
            _bad(f"{path}.legs", f"{len(raw_legs)} legs, at most {MAX_LEGS}")
        out["legs"] = [_leg(one, f"{path}.legs[{i}]", today)
                       for i, one in enumerate(raw_legs)]
        out["strategy"] = derive_strategy(out["legs"])

    out["id"] = _position_id(out)
    return out


def parse_positions(doc: object, *,
                    today: datetime.date | None = None) -> dict:
    """Validate a positions document and return its normalised form.

    An invalid document is refused whole, the rule every operator-editable
    document on this desk follows: there is no partial book of positions, and a
    half-applied one is an agent reasoning about a leg the owner corrected.

    ``today`` is injected rather than read from a clock, so that the expiry
    horizon is testable at a fixed instant -- the same reason
    :meth:`~claudepost.app.Desk.tick` takes one.

    Raises:
        BadRequest: code ``bad_positions``, message ``"<json path>: <why>"``.
    """
    today = datetime.date.today() if today is None else today

    doc = _obj(doc, "positions")
    _no_extra_keys(doc, _TOP_KEYS, "positions")

    raw = doc.get("positions")
    if raw is None:
        raw = []
    if not isinstance(raw, list):
        _bad("positions.positions", f"expected a list, got {raw!r}")
    if len(raw) > MAX_POSITIONS:
        _bad("positions.positions",
             f"{len(raw)} positions, at most {MAX_POSITIONS}")

    out_positions = [_position(one, f"positions.positions[{i}]", today)
                     for i, one in enumerate(raw)]

    # Two positions that hash the same ARE the same position stated twice, and
    # the book's `affects[].position_id` has to name exactly one of them.
    seen: dict[str, int] = {}
    for i, pos in enumerate(out_positions):
        if pos["id"] in seen:
            _bad(f"positions.positions[{i}]",
                 f"the same position as [{seen[pos['id']]}] "
                 f"({pos['symbol']}) -- combine them rather than listing it "
                 f"twice")
        seen[pos["id"]] = i

    out = {"updated_at": "", "positions": out_positions}

    # The aggregate backstop. Weighed in the form `save` writes and with the
    # stamp the caller is about to add, so that what this accepts is exactly
    # what `load` takes back on the next boot -- see the watchlist's
    # `_serialised` for what happened the time those two were spelled apart.
    size = len(_serialised({**out, "updated_at": _WIDEST_STAMP}))
    if size > MAX_DOC_BYTES:
        _bad("positions", f"{size} bytes serialised, at most {MAX_DOC_BYTES}")

    return out


# --------------------------------------------------------------------------
# The written form
# --------------------------------------------------------------------------

def _serialised(doc: dict) -> bytes:
    """The document exactly as it goes on disk.

    One function rather than a spelling at each end, so that the aggregate cap
    in :func:`parse_positions` and the bytes :func:`save` writes are weighing
    the same thing.
    """
    return json_bytes(doc)


def load(path: str) -> dict | None:
    """The positions at ``path``, or ``None``. Never raises.

    Nothing is stripped on the way in. An earlier draft removed ``strategy``
    from every position here, because a body carrying one was refused and the
    file is written with one -- so without the strip the desk declined its own
    writing on the next boot, silently, ``None`` being its answer both for a
    file it will not take and for a desk nobody has ever told. Making the field
    accepted-and-ignored deleted the need for the strip along with the trap; see
    the module docstring.
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
        doc = parse_positions(raw_doc)
    except BadRequest as exc:
        # parse_positions names the field it refused, which is the only part of
        # this a human can act on.
        LOG.warning("%s will not parse (%s)",
                    os.path.basename(path), exc.message or str(exc))
        return None

    stamp = raw_doc.get("updated_at") if isinstance(raw_doc, dict) else None
    doc["updated_at"] = (stamp if isinstance(stamp, str)
                         and _STAMP_RE.match(stamp) else "")
    return doc


def save(path: str, doc: dict) -> None:
    """Write ``doc`` to ``path``, atomically, at 0600, or raise ``OSError``.

    ``doc`` is trusted to be normalised already -- ``parse_positions(body)``
    then the caller's stamp, in that order. The mode is the one difference from
    every other document under the data root, and it is the whole reason this
    module exists separately: a watchlist is a list of companies, and this is a
    list of trades.
    """
    atomic_write(path, _serialised(doc))
    try:
        os.chmod(path, 0o600)
    except OSError:                # a filesystem without modes is not a reason
        LOG.warning("could not set 0600 on %s", os.path.basename(path))
