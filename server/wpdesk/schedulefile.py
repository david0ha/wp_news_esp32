"""The schedule as a file under the data root: reading it, and writing it back.

``PUT /api/schedule`` is the only thing that writes ``<data>/schedule.json``,
and this is the only module that touches it. Two files could have owned this
and neither should: :mod:`~wpdesk.app`'s docstring says two things live there
and nothing else, and :mod:`~wpdesk.schedule` is pure arithmetic that reads no
clock and opens no file -- which is what makes every boundary in it testable by
naming an instant. So the I/O lives here, in about ninety lines, and both of
those stay true.

The asymmetry between the two functions is the whole design:

:func:`load` **never raises.** It runs in a constructor, and a desk that
refused to start because somebody mistyped a field would be a newspaper taken
off the wall by a typo. A file that will not parse gets a warning naming the
field and is then ignored, and the desk runs on the default -- which is a
complete schedule rather than a placeholder. The bad file is left exactly where
it is: the person who wrote it is the only one who can fix it, and a desk that
deleted it would take the mistake away without taking the surprise away.

:func:`save` **does raise.** An operator who was told the edit landed, and then
finds the old schedule still in force at six the next morning, has been lied
to. A full disk is rare; a 200 that meant nothing is worse than a 500.
"""

from __future__ import annotations

import json
import logging
import os

from .errors import BadRequest
from .fsutil import atomic_write
from .schedule import DEFAULT_SCHEDULE, Schedule, parse_schedule, schedule_to_dict

LOG = logging.getLogger("wpdesk.schedulefile")


def load(path: str) -> tuple[Schedule, str]:
    """The schedule in force, and where it came from.

    Args:
        path: ``<data>/schedule.json``, whether or not it exists.

    Returns:
        ``(schedule, source)`` with source ``"file"`` or ``"default"``.
        ``"default"`` covers both a desk nobody has configured yet and a file
        that will not parse, because in both cases the arithmetic downstream
        runs on :data:`~wpdesk.schedule.DEFAULT_SCHEDULE` and a caller that had
        to tell them apart would be reporting a distinction it cannot act on.
        The warning in the log is where the difference is.

    Never raises.
    """
    try:
        with open(path, "rb") as f:
            raw = f.read()
    except OSError:
        # Missing is the ordinary case -- a desk that has never been told
        # otherwise -- so it is not worth a line in the log. Unreadable is not
        # ordinary, but it is the same answer, and __main__ prints the source
        # at startup either way.
        return DEFAULT_SCHEDULE, "default"

    try:
        s = parse_schedule(json.loads(raw.decode("utf-8")))
    except (ValueError, UnicodeDecodeError) as exc:
        _complain(path, f"it is not valid JSON: {exc}")
    except BadRequest as exc:
        # parse_schedule names the field it refused, which is the only part of
        # this a human can act on. "invalid schedule" is not something anybody
        # can fix.
        _complain(path, exc.message or str(exc))
    else:
        return s, "file"
    return DEFAULT_SCHEDULE, "default"


def save(path: str, s: Schedule) -> None:
    """Write ``s`` to ``path``, atomically, or raise ``OSError``.

    Indented and newline-terminated rather than compact, because every byte of
    this file exists to be read -- by whoever is working out why the paper
    arrives at the hour it does -- and a diff should show the line that
    changed. The atomic write is the shared one, so a reader arriving mid-write
    sees the previous schedule rather than half of this one.
    """
    text = json.dumps(schedule_to_dict(s), indent=2, ensure_ascii=False) + "\n"
    atomic_write(path, text.encode("utf-8"))


def _complain(path: str, why: str) -> None:
    """One warning, carrying the file and the field, and what happens next."""
    LOG.warning("%s will not parse (%s); running on the default schedule",
                os.path.basename(path), why)
