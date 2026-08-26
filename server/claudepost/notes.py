"""One markdown blob per owner: the research behind a page, kept beside it.

The desk already keeps two kinds of evidence about an edition and this is the
third. The gate output is prose the desk wrote about a payload; the proof
sheets are pictures the typesetter made of it; the notes are what the worker
found out before either of them existed -- why this company, what moved, what
was looked at and discarded. The owner reads them on a phone, next to the page
they explain.

**A note is evidence, not copy.** It is never typeset, never served to the
board, and never fingerprinted, so filing one cannot change what is on the
glass and cannot cost a wall twenty-five seconds of the whole sheet flashing.
That is the property that makes it safe for a worker to file one every day
without thinking about it, and it is the reason this is a module of its own
rather than another field in the payload.

Two rules govern the bytes, and both are visible to the reader when they are
broken rather than being caught by anything downstream:

* **UTF-8.** The note goes out under a ``Content-Type`` that says so, and a
  phone handed something else renders mojibake -- which reads as a corrupted
  dossier rather than as a refusal anybody can act on.
* **Bounded.** The phone fetches the whole of it through a tunnel in one go.
  A quarter of a megabyte is far more than any dossier a person reads and
  little enough that fetching it is not an event.

The owner is passed as a *directory* rather than as an id, so the same three
functions serve an owner that already has one -- a draft, an edition -- and
:class:`NoteStore` serves one that does not.
"""

from __future__ import annotations

import os
import re

from .errors import BadRequest, NotFound, TooLarge
from .fsutil import atomic_write, read_bytes

#: A quarter of a megabyte of markdown. Not derived from the device's limits
#: like ``tiles.MAX_PAYLOAD_BYTES`` is -- the board never sees a note -- but
#: from the reader's: this is the whole of one fetch to a phone, and a dossier
#: longer than it is one nobody was going to finish.
MAX_NOTES_BYTES = 256 * 1024

#: The name a note is kept under inside the directory that owns it. It is also
#: the last component of every route that serves one, so the file on disk and
#: the URL on the wire are spelled the same and there is nothing to map.
NOTES_NAME = "notes.md"


def validate(data: bytes) -> bytes:
    """The bytes a note may be written as, or the refusal that stops them.

    Size first, then the decode: refusing something for its length costs one
    comparison, where decoding it to find out costs the length itself. It is
    the same ordering the five gates are in -- cheapest question first, and the
    expensive one not asked when the cheap one has already answered.

    Both checks are on the way *in*, which is the point: :func:`read` never
    raises, so everything that reaches the disk has to be something a reader
    can hand to a phone without looking at it.

    Raises:
        TooLarge: past :data:`MAX_NOTES_BYTES`.
        BadRequest: not UTF-8.
    """
    if len(data) > MAX_NOTES_BYTES:
        raise TooLarge(message=f"{len(data)} bytes, limit {MAX_NOTES_BYTES}")
    try:
        data.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise BadRequest(message=f"a note is UTF-8 markdown: {exc}") from None
    return data


def write(owner_dir: str, data: bytes) -> None:
    """Replace ``owner_dir``'s note, or leave the one that is there alone.

    Validated before a byte is written, so a note that is too long or is not
    text cannot blank the note it was filed to correct. That is
    ``news_parse()``'s rule one layer up -- a rejected payload never touches
    ``*out`` -- and ``put_payload``'s rule on this side of the wire.
    """
    atomic_write(os.path.join(owner_dir, NOTES_NAME), validate(data))


def read(owner_dir: str) -> bytes | None:
    """The note in ``owner_dir``, or ``None``. Never raises.

    ``fsutil.read_bytes`` and therefore ``editions.py``'s split between a read
    that answers ``None`` and one that raises, for its reason: this read feeds
    a response, and every way of failing -- no note, no directory, an owner
    pruned a second ago -- is the same 404 to whoever asked.
    """
    return read_bytes(os.path.join(owner_dir, NOTES_NAME))


def present(owner_dir: str) -> bool:
    """Whether ``owner_dir`` holds a note, without reading a quarter megabyte.

    Exactly :data:`NOTES_NAME` and nothing else. The ``.claudepost-*.tmp`` that
    an interrupted :func:`~claudepost.fsutil.atomic_write` leaves behind is half
    a note by construction, and what keeps it out of every answer is the *name*
    -- one file is the note -- rather than a sweep that has to find it first.
    """
    return os.path.isfile(os.path.join(owner_dir, NOTES_NAME))


class NoteStore:
    """Notes for owners that have no directory of their own.

    A draft and an edition are directories already, so a note goes beside the
    payload it belongs to and leaves when that does. A *command* is a row in
    the database with nowhere for a file to live, so its notes need somewhere:
    one directory per owner under ``root``, each holding the same ``notes.md``
    the functions above write. One on-disk shape for a note rather than two,
    which is what lets a reader be told "the note of X" and not also which kind
    of X it was.

    ``pattern`` is the id shape this store accepts, handed in rather than fixed
    here for the reason :func:`~claudepost.editions._valid` takes its pattern as
    an argument: the caller that owns the route owns the shape, and giving the
    router and the store the same regex is what stops a route id and a path id
    drifting apart.

    ``root`` is made when the first note is written. A desk nobody has filed a
    note on has no empty directory for an operator to wonder about.
    """

    def __init__(self, root: str, pattern: re.Pattern) -> None:
        self.root = os.path.abspath(root)
        self._pattern = pattern

    def put(self, owner_id: str, data: bytes) -> None:
        """Write one owner's note, replacing whatever was there.

        Raises:
            NotFound: an id this store's pattern does not describe. Not
                ``BadRequest``: an id that cannot exist does not exist, and
                naming the traversal would tell whoever sent ``../../etc/passwd``
                that it had been recognised. ``editions._require_draft`` makes
                the same choice for the same reason.
            TooLarge, BadRequest: from :func:`validate`.
        """
        path = self._dir(owner_id)
        if path is None:
            raise NotFound(message=f"no owner {owner_id!r:.64}")
        # Validated before the directory is made, so a refused note leaves no
        # footprint at all -- not even an empty directory named after an owner
        # whose note was never accepted.
        data = validate(data)
        os.makedirs(path, exist_ok=True)
        write(path, data)

    def get(self, owner_id: str) -> bytes | None:
        """One owner's note, or ``None`` -- including for an id that is not one."""
        path = self._dir(owner_id)
        return None if path is None else read(path)

    def has(self, owner_id: str) -> bool:
        """Whether an owner has a note. An id that is not one has nothing."""
        path = self._dir(owner_id)
        return path is not None and present(path)

    def _dir(self, owner_id: str) -> str | None:
        """Where an owner's note would live, or ``None`` for an id that is not one.

        Pure regex and no filesystem, which is the only reason the join below it
        is safe. ``None`` rather than a raise so that the two reads can answer
        nothing and :meth:`put` alone has to decide what a refusal is.
        """
        if not isinstance(owner_id, str) or self._pattern.match(owner_id) is None:
            return None
        return os.path.join(self.root, owner_id)
