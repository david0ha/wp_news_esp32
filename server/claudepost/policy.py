"""The ``policy`` block: the only thing the desk adds to a producer's payload.

Two integers, on the same URL as the edition rather than at a second one, for
the same reason the tile base is derived rather than configured -- a second
thing to configure is a second thing to get wrong, and the board is meant to
hold exactly one URL::

    "policy": {"poll_seconds": 3600, "next_change": 1755561000}

``poll_seconds`` is the cadence to use *now*: the desk has already decided
whether now is inside a quiet window, so the device is handed a number and
never has to know that a calendar exists. ``next_change`` is the instant at
which that answer changes, so a board polling hourly through the quiet hours
still wakes up on the boundary rather than an hour past it. Absent means "no
scheduled change known", which is what a schedule with no windows and no wakes
honestly reports.

Both are JSON **numbers**. ``next_change`` in particular is epoch seconds and
not ISO-8601, because it is a number the device *reasons about* and this wire's
rule is that those are integers -- which also removes a date parser from the
firmware, a class of bug bought for nothing.

**The block is computed per request and never stored.** ``next_change`` is an
instant; an instant written into a file on disk is wrong the moment the
schedule changes, and stale by exactly as long as the file has been sitting
there. Splicing at serve time costs one parse and one serialise of a payload
that is capped at 300 KB, which is nothing next to being wrong.

**The producer does not get to write this block.** An agent that guessed a
cadence would be overriding the owner's schedule from inside a story file, and
two places deciding one number is the failure this module exists to prevent.
Whatever arrives under ``policy`` is dropped, and the drop is reported so it
lands in the edition's ``meta.json`` rather than passing in silence.

The firmware half is `news_hash()`, which must **not** fingerprint this block:
``next_change`` moves every day, and a fingerprint that saw it would spend
twenty-five seconds of the whole sheet flashing to report that a timestamp
advanced. See ``components/news_core/news_model.c``.
"""

from __future__ import annotations

import json

from .errors import BadRequest
from .schedule import Schedule, effective_poll_seconds, next_transition


def policy_block(s: Schedule, t: float) -> dict:
    """The block as it will appear on the wire at instant ``t``.

    ``next_change`` is omitted rather than zeroed when the schedule has no
    transitions at all. Absent and ``0`` mean the same thing to the device, and
    absent is the smaller lie: there is no next change, rather than one at the
    epoch.
    """
    block: dict = {"poll_seconds": effective_poll_seconds(s, t)}
    nxt = next_transition(s, t)
    if nxt is not None:
        # int(), not round(): every instant this module can produce sits on a
        # whole local minute, so truncation loses nothing, and truncating can
        # only ever move the deadline earlier -- which costs one extra poll,
        # where rounding up would cost a missed boundary.
        block["next_change"] = int(nxt[0])
    return block


def splice_policy(payload: bytes, s: Schedule, t: float) -> bytes:
    """Return ``payload`` with the desk's policy block in place of any other.

    Raises:
        BadRequest: ``bad_json`` when the payload is not a JSON object. It is
            refused rather than passed through untouched, because a payload the
            desk cannot read is one it cannot promise anything about, and
            serving it unspliced would quietly drop the cadence the owner set.
    """
    try:
        doc = json.loads(payload)
    except (ValueError, UnicodeDecodeError) as exc:
        raise BadRequest("bad_json", f"payload is not JSON: {exc}") from None
    if not isinstance(doc, dict):
        raise BadRequest("bad_json",
                         f"payload is a JSON {type(doc).__name__}, not an object")

    # Pop before assigning rather than overwriting in place: the pop is the
    # drop this module promises, and it also puts our block last in key order
    # whatever the producer did, so two identical editions serialise
    # identically and the device's fingerprint stays stable.
    doc.pop("policy", None)
    doc["policy"] = policy_block(s, t)

    # `ensure_ascii=False` keeps Korean company names and typographic dashes as
    # UTF-8 bytes instead of tripling their length as \uXXXX escapes, which
    # matters against a 300 KB cap. The separators drop the whitespace
    # json.dumps adds by default, for the same reason.
    return json.dumps(doc, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def dropped_producer_policy(payload: bytes) -> bool:
    """Whether ``payload`` carried a ``policy`` key that a splice would discard.

    Reported into the edition's ``meta.json`` so a producer filing a block it
    does not own finds out from the record rather than from a cadence that
    never changed. A payload that does not parse answers ``False``: nothing was
    dropped from it because nothing was ever spliced into it, and the parse
    error belongs to :func:`splice_policy`, which raises it properly.
    """
    try:
        doc = json.loads(payload)
    except (ValueError, UnicodeDecodeError):
        return False
    return isinstance(doc, dict) and "policy" in doc
