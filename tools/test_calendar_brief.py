#!/usr/bin/env python3
"""Every worked example in CALENDAR.md is a document the desk accepts.

    python3 tools/test_calendar_brief.py

`tools/edition/CALENDAR.md` is the contract the producing agent works from, and
`server/claudepost/calendar.py` is what refuses its output. Those two drifting
apart is not a cosmetic problem: an example the validator would refuse teaches
the model to file one, and the failure lands as a run that produced nothing,
hours after the example was written.

It has already happened once. The `affects` floor was tightened after the brief
was filed -- an event with no reasoning became a refusal rather than a thin
entry -- and the brief's precision example had deliberately trimmed `affects`
"to keep it short". Both were defensible in isolation; together they were a
contract demonstrating a document the desk would reject.

So this is the same shape as `tools/test_validate_lang.py`: a layer-2 check
that runs without Docker, a network or a key, and fails the ladder rather than
the morning.
"""

from __future__ import annotations

import datetime
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "server"))

from claudepost import calendar as C  # noqa: E402
from claudepost import positions as P  # noqa: E402

BRIEF = os.path.join(HERE, "edition", "CALENDAR.md")
EXAMPLE_POSITIONS = os.path.join(ROOT, "server", "positions.example.json")

#: The brief's examples are written against the shipped example positions, so
#: the ids it cites have to be the ids that file actually mints. Deriving them
#: here rather than hard-coding them is the point: if `positions.py`'s id
#: material ever changes, this fails instead of the agent.
def known_position_ids() -> frozenset[str]:
    doc = P.load(EXAMPLE_POSITIONS)
    if doc is None:
        raise SystemExit("positions.example.json does not parse")
    return frozenset(one["id"] for one in doc["positions"])


#: A fixed instant, because the brief's examples carry real dates and the
#: window is relative to now. Chosen to sit inside the window of every example
#: in the file; if an example ever ages out, the brief needs new dates, and
#: that is a real finding rather than a flake.
NOW = datetime.datetime(2026, 9, 8, 5, 0, 0, tzinfo=datetime.timezone.utc)

_COMMENT = re.compile(r"^\s*//.*$", re.M)
_BLOCK = re.compile(r"```jsonc?\n(.*?)```", re.S)


def blocks(text: str) -> list[tuple[int, object]]:
    """Every fenced JSON block that is a whole object, with its index.

    A fragment -- the `"shortfall": "..."` line the brief shows on its own --
    is not a document and is skipped rather than failed. What must not be
    skipped is a complete object, so the count is asserted by the caller.
    """
    out = []
    for i, raw in enumerate(_BLOCK.findall(text)):
        try:
            doc = json.loads(_COMMENT.sub("", raw))
        except ValueError:
            continue
        if isinstance(doc, dict):
            out.append((i, doc))
    return out


def main() -> int:
    text = open(BRIEF, encoding="utf-8").read()
    known = known_position_ids()
    found = blocks(text)

    if len(found) < 2:
        print("FAIL: %s has %d complete JSON examples; expected at least two "
              "(a whole book and an event)" % (BRIEF, len(found)))
        return 1

    failures = 0
    for index, doc in found:
        whole = doc if "events" in doc else {"events": [doc]}
        try:
            C.parse_calendar(whole, known_position_ids=known, now=NOW)
        except Exception as exc:                      # noqa: BLE001
            failures += 1
            print("FAIL: block %d: %s" % (index, exc))

    if failures:
        print("%d of %d examples in CALENDAR.md would be refused by the desk."
              % (failures, len(found)))
        return 1

    print("ok -- %d examples in CALENDAR.md, all accepted by parse_calendar"
          % len(found))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
