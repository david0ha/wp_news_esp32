"""The desk's settings as a file under the data root: what the paper is
written in, and nothing else yet.

``PUT /api/settings`` is the only thing that writes ``<data>/settings.json``,
and this is the only module that touches it. It is the fourth operator
document beside the schedule, the watchlist and the standing directives, and
it is a *document* rather than a directive for one reason: three consumers --
the agent that writes the edition, the phone that shows the control, and
whoever reads the desk's own state -- need the answer as data. A directive is
a sentence in a prompt, and a phone app cannot parse a sentence to work out
which language is set.

The shape is :mod:`~claudepost.schedulefile`'s, deliberately, and so is the
asymmetry between its two functions:

:func:`load` **never raises.** It runs in a constructor, and a desk that
refused to start because somebody mistyped a language tag would be a
newspaper taken off the wall by a typo. A file that will not parse gets a
warning naming the field and is then ignored, the desk runs on
:data:`DEFAULT`, and the bad file is left exactly where it is -- the person
who wrote it is the only one who can fix it.

:func:`save` **does raise.** An operator who was told the edit landed, and
then finds tomorrow's paper still in English, has been lied to.

What this module borrows from :mod:`~claudepost.watchlist` instead is the
refusal of unknown keys. The schedule refuses one to catch a typo; here the
argument is a version skew as much as a typo -- this is the document future
settings will be added to, so a phone app one release ahead of the desk must
be told no at the door rather than left believing it set something the desk
has never heard of.

The desk does **not** cross-check an edition's own ``lang`` against this
setting. The field on a payload describes the text that is actually in it,
and refusing a Korean edition because the operator flipped this an hour ago
would keep the wrong sheet on the glass for nothing.
"""

from __future__ import annotations

import json
import logging
import os
import re

from .errors import BadRequest
from .fsutil import atomic_write

LOG = logging.getLogger("claudepost.settings")

#: A BCP-47 primary language subtag and nothing after it: no region, no
#: script, no casing to normalise. The device matches this tag against a
#: table of two entries (``ui_lang()``), so a desk that accepted ``"ko-KR"``
#: would be storing a distinction nothing downstream can act on.
LANG_RE = re.compile(r"^[a-z]{2,3}\Z")

#: What a desk nobody has told prints in. A complete setting rather than a
#: placeholder, the same way :data:`~claudepost.schedule.DEFAULT_SCHEDULE` is
#: a complete schedule -- there is no state in which the paper has no
#: language. Handed out by copy (see :func:`load`), never by reference.
DEFAULT = {"lang": "en"}

#: Every key the document may carry. One, so far.
_KEYS = frozenset({"lang"})


def parse_settings(doc: object) -> dict:
    """Validate a settings document and return its normalised form.

    An invalid document is refused whole, the rule
    :func:`~claudepost.schedule.parse_schedule` and
    :func:`~claudepost.watchlist.parse_watchlist` both follow. With one field
    that is barely a distinction today; it is written this way because the
    second field is what makes it one, and because an operator should never
    have to work out which half of an edit landed.

    A key that is absent takes its default -- nobody said, so the desk
    answers for them. A key that is present and ``null`` is refused, because
    that is a caller who meant to say something and got the type wrong. The
    two are the same thing to a ``dict.get``, which is why this reads
    membership instead.

    Raises:
        BadRequest: code ``bad_settings``, message ``"<field>: <why>"``.
    """
    if not isinstance(doc, dict):
        raise BadRequest("bad_settings",
                         f"settings: expected an object, got {type(doc).__name__}")

    extra = sorted(set(doc) - _KEYS)
    if extra:
        raise BadRequest("bad_settings",
                         "settings: unknown key(s) "
                         + ", ".join(repr(k) for k in extra))

    return {"lang": _lang(doc["lang"]) if "lang" in doc else DEFAULT["lang"]}


def load(path: str) -> tuple[dict, str]:
    """The settings in force, and where they came from.

    Args:
        path: ``<data>/settings.json``, whether or not it exists.

    Returns:
        ``(settings, source)`` with source ``"file"`` or ``"default"``.
        ``"default"`` covers both a desk nobody has configured yet and a file
        that will not parse, because in both cases the paper comes out in
        :data:`DEFAULT`'s language and a caller that had to tell them apart
        would be reporting a distinction it cannot act on. The warning in the
        log is where the difference is.

        The default is returned as a fresh dict rather than as
        :data:`DEFAULT` itself: this value is assigned to an attribute of a
        long-lived :class:`~claudepost.app.Desk`, and one caller editing it in
        place would change what every later desk in the process came up on.

    Never raises.
    """
    try:
        with open(path, "rb") as f:
            raw = f.read()
    except OSError:
        # Missing is the ordinary case -- a desk that has never been told
        # otherwise -- so it is not worth a line in the log. Unreadable is not
        # ordinary, but it is the same answer, and `app.py` logs the source at
        # start-up either way.
        return dict(DEFAULT), "default"

    try:
        doc = parse_settings(json.loads(raw.decode("utf-8")))
    except (ValueError, UnicodeDecodeError) as exc:
        _complain(path, f"it is not valid JSON: {exc}")
    except BadRequest as exc:
        # parse_settings names the field it refused, which is the only part of
        # this a human can act on -- the same reason schedulefile.load
        # surfaces a BadRequest's own message rather than a generic one.
        _complain(path, exc.message or str(exc))
    else:
        return doc, "file"
    return dict(DEFAULT), "default"


def save(path: str, doc: dict) -> None:
    """Write ``doc`` to ``path``, atomically, or raise ``OSError``.

    ``doc`` is trusted to already be normalised -- the caller's job is
    :func:`parse_settings` first, in the same order
    :func:`~claudepost.watchlist.save` expects.

    Indented and newline-terminated rather than compact, for
    :func:`~claudepost.schedulefile.save`'s reason: every byte of this file
    exists to be read, by whoever is working out why the paper came out in
    the language it did. The atomic write is the shared one, so a reader
    arriving mid-write sees the previous setting rather than half of this one.
    """
    text = json.dumps(doc, indent=2, ensure_ascii=False) + "\n"
    atomic_write(path, text.encode("utf-8"))


def _lang(value: object) -> str:
    """A language tag, or a refusal naming the field."""
    if not isinstance(value, str) or not LANG_RE.match(value):
        raise BadRequest("bad_settings",
                         f"lang: expected a language tag of two or three "
                         f"lowercase letters, got {value!r}")
    return value


def _complain(path: str, why: str) -> None:
    """One warning, carrying the file and the field, and what happens next."""
    LOG.warning("%s will not parse (%s); running on the default settings",
                os.path.basename(path), why)
