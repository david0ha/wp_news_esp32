"""The watchlist: the document a private morning script files, and the phone
app reads back -- which companies are being watched, a red/yellow/green grade
on each, why, a thesis note in markdown, and the dates something happened.

**The schema is a privacy boundary, not a typo guard.** Every other
``_no_extra_keys`` in this desk exists so a misspelled field is an error
instead of a silent no-op; this one exists so a field that was never invited
-- a stop level, an entry price, a P&L figure -- has no key to hide behind. A
script that believes it filed a stop, next to a phone app that will never show
one, is a worse failure than a script that was told no at the door. So an
unknown key is refused here exactly as it is in :mod:`~claudepost.schedule`,
for a different reason, and it is worth keeping the reason straight: that
module refuses a typo, this one refuses a field on purpose.

This is one module rather than a ``schedule``/``schedulefile`` split because
there is no arithmetic to keep pure and testable apart from the I/O -- unlike
a schedule, nothing here reasons about an instant relative to another one.
What *is* kept apart is the clock: :func:`parse_watchlist` never reads one, in
the same spirit as :mod:`~claudepost.schedule`'s "nothing in this module reads
a clock" -- the ``updated_at`` it returns is a placeholder the caller (the PUT
handler that owns :class:`~claudepost.clock.Clock`) overwrites with a real
instant before the document is saved. That is also why :func:`load` and
:func:`save` do not run a document back through :func:`parse_watchlist`: the
file on disk is desk-owned, written only by :func:`save` after a document has
already been validated once on its way in, and re-stamping it on every read
would make a save-then-load round trip lie about the instant it was written.

Two ceilings, not one, bound the document. Every field has its own cap --
sixty-four items, eight reasons, a 16 KiB note -- and none of those alone
allows anything unreasonable. But they are independent, and sixty-four items
each carrying a note at its own cap is a megabyte, four times over
:data:`MAX_DOC_BYTES`. So the aggregate is checked too, on the way out of
:func:`parse_watchlist`, as a backstop the per-field caps cannot provide on
their own.
"""

from __future__ import annotations

import json
import logging
import os
import re
from typing import NoReturn

from .errors import BadRequest
from .fsutil import atomic_write

LOG = logging.getLogger("claudepost.watchlist")

#: A quarter of a megabyte, serialised -- the aggregate backstop behind the
#: per-field caps below. See the module docstring for why it is a second
#: ceiling rather than a restatement of the first.
MAX_DOC_BYTES = 256 * 1024

#: Sixty-four names is more companies than one owner watches at once; past it
#: a hand-edited or scripted document is more likely a mistake than a longer
#: list.
MAX_ITEMS = 64

#: The pool a vote is drawn from, which is naturally wider than the list of
#: names actually being watched.
MAX_UNIVERSE = 128

MAX_REASONS = 8
MAX_EVENTS = 12

#: A markdown thesis note, the same order of magnitude as
#: :data:`~claudepost.notes.MAX_NOTES_BYTES` but a sixteenth of it: this note
#: lives beside one line in a list, not beside a whole edition.
MAX_NOTE_BYTES = 16 * 1024

#: Digits are deliberate, not an oversight -- a KR symbol is numeric (e.g.
#: ``005930``), so the shape has to admit one. A quote symbol excludes digits
#: for a different reason; see the note beside its own regex.
SYMBOL_RE = re.compile(r"^[A-Z0-9.\-]{1,12}\Z")

DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}\Z")

#: What an item's grade may say. ``"none"`` is a fourth grade rather than the
#: absence of one, so a document that never mentions a call is distinguishable
#: from one that says explicitly there isn't one yet.
GRADES: tuple[str, ...] = ("red", "yellow", "green", "none")

#: Every top-level key the document may carry. ``updated_at`` is accepted here
#: rather than refused as unknown -- a document a caller round-trips (GET, PUT
#: back) legitimately carries one -- but see :func:`parse_watchlist`: its
#: value is never read.
_TOP_KEYS = frozenset({"updated_at", "source", "items", "universe"})

_ITEM_KEYS = frozenset({
    "symbol", "name", "market", "grade", "reasons", "thesis_status", "note",
    "printable", "last_printed", "events", "held",
})


# --------------------------------------------------------------------------
# Parsing and validation
# --------------------------------------------------------------------------

def _bad(path: str, why: str) -> NoReturn:
    """Refuse the document, naming the field.

    The message is what lands in the 400 body, where the only reader is the
    person -- or the private script -- that sent the field that was wrong.
    """
    raise BadRequest("bad_watchlist", f"{path}: {why}")


def _no_extra_keys(doc: dict, allowed: frozenset[str], path: str) -> None:
    """Refuse keys nobody reads. This is the privacy boundary: a stop level,
    an entry price, a P&L figure has no key here to hide behind."""
    extra = sorted(set(doc) - allowed)
    if extra:
        _bad(path, f"unknown key(s) {', '.join(repr(k) for k in extra)}")


def _bounded_str(value: object, path: str, max_len: int) -> str:
    """A required string of at most ``max_len`` characters, or a refusal."""
    if not isinstance(value, str):
        _bad(path, f"expected a string, got {value!r}")
    if len(value) > max_len:
        _bad(path, f"{len(value)} characters, at most {max_len}")
    return value


def _opt_str(value: object, path: str, max_len: int, default: str) -> str:
    """An optional bounded string. Absent (``None``) takes ``default``."""
    return default if value is None else _bounded_str(value, path, max_len)


def _note(value: object, path: str) -> str:
    """The thesis note: UTF-8 bytes bounded, not characters -- markdown that
    is mostly non-ASCII should not buy more room than the wire actually
    spends on it."""
    if value is None:
        return ""
    if not isinstance(value, str):
        _bad(path, f"expected a string, got {value!r}")
    n = len(value.encode("utf-8"))
    if n > MAX_NOTE_BYTES:
        _bad(path, f"{n} bytes, at most {MAX_NOTE_BYTES}")
    return value


def _bool(value: object, path: str, default: bool) -> bool:
    """``True`` is an ``int`` in Python; nothing on this document's fields is
    a count, so nothing here has to make that distinction the way
    :mod:`~claudepost.schedule`'s ``_int`` does."""
    if value is None:
        return default
    if not isinstance(value, bool):
        _bad(path, f"expected true or false, got {value!r}")
    return value


def _symbol(value: object, path: str) -> str:
    """A ticker, upper-cased before it is matched -- so a caller may write
    ``"acme"`` and this is the one place that decides what canonical means."""
    if not isinstance(value, str):
        _bad(path, f"expected a symbol, got {value!r}")
    sym = value.upper()
    if not SYMBOL_RE.match(sym):
        _bad(path, f"{value!r} is not a symbol "
                   f"(letters, digits, '.', '-', 1-12 characters)")
    return sym


def _date(value: object, path: str) -> str:
    if not isinstance(value, str) or not DATE_RE.match(value):
        _bad(path, f"expected a YYYY-MM-DD date, got {value!r}")
    return value


def _date_or_none(value: object, path: str) -> str | None:
    return None if value is None else _date(value, path)


def _grade(value: object, path: str) -> str:
    if value is None:
        return "none"
    if value not in GRADES:
        _bad(path, f"{value!r} is not one of {', '.join(GRADES)}")
    return value


def _reasons(value: object, path: str) -> list[str]:
    if value is None:
        return []
    if not isinstance(value, list):
        _bad(path, f"expected a list of strings, got {value!r}")
    if len(value) > MAX_REASONS:
        _bad(path, f"{len(value)} reasons, at most {MAX_REASONS}")
    return [_bounded_str(r, f"{path}[{i}]", 80) for i, r in enumerate(value)]


def _events(value: object, path: str) -> list[str]:
    if value is None:
        return []
    if not isinstance(value, list):
        _bad(path, f"expected a list of dates, got {value!r}")
    if len(value) > MAX_EVENTS:
        _bad(path, f"{len(value)} events, at most {MAX_EVENTS}")
    return [_date(v, f"{path}[{i}]") for i, v in enumerate(value)]


def _item(value: object, path: str) -> dict:
    if not isinstance(value, dict):
        _bad(path, f"expected an object, got {type(value).__name__}")
    _no_extra_keys(value, _ITEM_KEYS, path)
    return {
        "symbol": _symbol(value.get("symbol"), f"{path}.symbol"),
        "name": _opt_str(value.get("name"), f"{path}.name", 40, ""),
        "market": _opt_str(value.get("market"), f"{path}.market", 12, ""),
        "grade": _grade(value.get("grade"), f"{path}.grade"),
        "reasons": _reasons(value.get("reasons"), f"{path}.reasons"),
        "thesis_status": _opt_str(value.get("thesis_status"),
                                  f"{path}.thesis_status", 16, ""),
        "note": _note(value.get("note"), f"{path}.note"),
        "printable": _bool(value.get("printable"), f"{path}.printable", True),
        "last_printed": _date_or_none(value.get("last_printed"),
                                      f"{path}.last_printed"),
        "events": _events(value.get("events"), f"{path}.events"),
        "held": _bool(value.get("held"), f"{path}.held", False),
    }


def _items(value: object, path: str) -> list[dict]:
    if value is None:
        return []
    if not isinstance(value, list):
        _bad(path, f"expected a list of items, got {value!r}")
    if len(value) > MAX_ITEMS:
        _bad(path, f"{len(value)} items, at most {MAX_ITEMS}")
    return [_item(v, f"{path}[{i}]") for i, v in enumerate(value)]


def _universe(value: object, path: str) -> list[str]:
    if value is None:
        return []
    if not isinstance(value, list):
        _bad(path, f"expected a list of symbols, got {value!r}")
    if len(value) > MAX_UNIVERSE:
        _bad(path, f"{len(value)} symbols, at most {MAX_UNIVERSE}")
    return [_symbol(v, f"{path}[{i}]") for i, v in enumerate(value)]


def parse_watchlist(doc: object) -> dict:
    """Validate a watchlist document and return its normalised form.

    An invalid document is refused whole, the same rule
    :func:`~claudepost.schedule.parse_schedule` follows: there is no partial
    watchlist, and a half-applied one is a phone app showing a grade next to a
    thesis note that was actually refused.

    ``doc["updated_at"]`` is accepted as a key -- so a caller that GETs this
    document and PUTs it straight back is not refused for echoing its own
    field -- but its value is never read. The `0` this function returns in its
    place is a placeholder; see the module docstring for why the real instant
    is the caller's to stamp, not this function's to read a clock for.

    Raises:
        BadRequest: code ``bad_watchlist``, message ``"<json path>: <why>"``.
    """
    if not isinstance(doc, dict):
        _bad("watchlist", f"expected an object, got {type(doc).__name__}")
    _no_extra_keys(doc, _TOP_KEYS, "watchlist")

    out = {
        "updated_at": 0,
        "source": _opt_str(doc.get("source"), "source", 64, ""),
        "items": _items(doc.get("items"), "items"),
        "universe": _universe(doc.get("universe"), "universe"),
    }

    # The aggregate backstop -- see the module docstring for why the per-field
    # caps above cannot provide this on their own.
    size = len(json.dumps(out, ensure_ascii=False).encode("utf-8"))
    if size > MAX_DOC_BYTES:
        _bad("watchlist", f"{size} bytes serialised, at most {MAX_DOC_BYTES}")

    return out


# --------------------------------------------------------------------------
# On disk
# --------------------------------------------------------------------------

def load(path: str) -> dict | None:
    """The watchlist at ``path``, or ``None``.

    Args:
        path: ``<data>/watchlist.json``, whether or not it exists.

    Unlike :func:`~claudepost.schedulefile.load`, a failure here has no
    default to fall back on -- there is no such thing as a default watchlist
    -- so the caller's answer to "nobody has told the desk one yet" and "the
    file will not parse" is the same ``None``, and the warning in the log is
    where the difference is. The file that will not parse is left exactly
    where it is: it is desk-written, so a bad one means something wrote
    outside this module, and deleting the evidence would not help whoever
    has to find out what.

    Never raises.
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
        doc = json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError) as exc:
        LOG.warning("%s will not parse (%s)", os.path.basename(path), exc)
        return None
    if not isinstance(doc, dict):
        LOG.warning("%s will not parse (expected an object, got %s)",
                    os.path.basename(path), type(doc).__name__)
        return None
    return doc


def save(path: str, doc: dict) -> None:
    """Write ``doc`` to ``path``, atomically, or raise ``OSError``.

    ``doc`` is trusted to already be normalised -- the caller's job is
    ``parse_watchlist(body)`` followed by stamping ``updated_at``, in that
    order, before this is called. Indented and newline-terminated for the
    same reason ``schedulefile.save`` is: every byte of this file exists to
    be read by someone debugging why the app shows what it shows.
    """
    text = json.dumps(doc, indent=2, ensure_ascii=False) + "\n"
    atomic_write(path, text.encode("utf-8"))
