"""Bearer tokens, two scopes, and one file that decides both.

The control plane is reachable from the internet through a Cloudflare tunnel,
so the whole of this module is written for the case where the caller is not the
owner. Three rules follow from that and every line here is one of them:

* **Nobody by default.** A token file that is missing, unreadable, truncated
  mid-write or malformed in any way authorises *nobody*. There is no path
  through this module that treats "I could not read the rules" as "allow" --
  the table is cleared before the error is raised, so even a caller that
  ignores the exception is left with an empty set rather than a stale one.
* **Constant time.** Presented tokens are compared with
  :func:`hmac.compare_digest` against every entry, without breaking out of the
  loop on a match. A dictionary lookup would be the obvious way to write this
  and it is the wrong one: hashing a string is not constant time and a
  short-circuiting loop leaks which entry matched by how long it took.
* **A token is never repeated back.** Not in an exception, not in a message
  that becomes ``detail`` on the wire, not in anything a log might catch. Load
  errors name the *holder* instead, which is the half a human needs.

**Two scopes**, from the spec's §2. ``producer`` may push editions and claim
commands -- what an agent needs and nothing more. ``operator`` may do that and
also change the schedule, force a publish and set a hold. The ranking is a
number rather than a set of grants because there are two of them and there will
be two of them: an agent that can rewrite the schedule can arrange to print
whatever it likes at three in the morning, which is exactly the authority this
split exists to withhold.

**Why the file holds tokens rather than hashes.** The posture is a 0600 file in
``~/.claudepost/`` on a machine whose owner is its only user, mounted read-only
into the container. An attacker who can read that file can also read the
database the desk writes and everything else in that home directory, so hashing
the tokens would move no boundary -- it would only add a rotation story and a
work-factor decision to maintain. If the day comes when the token file lives
somewhere the desk's data does not, hash them then, and the reason will be a
real one.

The file, ``~/.claudepost/tokens.json``::

    {"tokens": [{"name": "agent", "scope": "producer", "token": "..."},
                {"name": "me",    "scope": "operator", "token": "..."}]}
"""

from __future__ import annotations

import hmac
import json
import os
from typing import NamedTuple

from .errors import DeskError, Forbidden, Unauthorized

#: The two scopes, least authority first.
SCOPES: tuple[str, ...] = ("producer", "operator")

#: What each scope satisfies. Higher satisfies lower; see :func:`require`.
RANK: dict[str, int] = {"producer": 1, "operator": 2}

#: A token shorter than this is refused when the file is read. The service is
#: internet-reachable, so a token short enough to type is short enough to
#: enumerate, and the moment to say so is when it is written -- not after
#: somebody has been running one for a month. Sixteen characters is the width
#: of ``secrets.token_hex(8)``; the README asks for ``token_hex(32)``.
MIN_TOKEN_CHARS = 16


class _Entry(NamedTuple):
    """One line of the token file, with the token already encoded.

    The token is held as bytes because :func:`hmac.compare_digest` refuses
    ``str`` operands containing anything outside ASCII, and a caller who
    presents a snowman should get a 401 rather than a ``TypeError`` that
    becomes a 500.
    """

    name: str
    scope: str
    token: bytes


class Tokens:
    """The token file, reloaded when it changes underneath the process.

    One instance is shared by every request thread. It is read-only after load,
    so no lock is needed for :meth:`entry_for`; :meth:`reload_if_changed`
    replaces the tuple in one assignment, which readers see whole or not at all.

    :meth:`reload_if_changed` raises on a malformed file rather than carrying
    on, so it belongs on the desk's scheduler tick -- somewhere an exception
    becomes a log line. It is deliberately *not* called from
    :func:`scope_from_header`: an unauthenticated caller must not be able to
    learn from a response that the desk's token file is broken, and the empty
    table left behind by the failed load already refuses them.
    """

    def __init__(self, path: str) -> None:
        self._path = path
        self._stamp: tuple[int, int, int] | None = None
        self._entries: tuple[_Entry, ...] = ()
        self._load()

    def count(self) -> int:
        """How many tokens are currently live. Zero means nobody may in."""
        return len(self._entries)

    def reload_if_changed(self) -> None:
        """Re-read the file if its identity, size or mtime moved.

        Raises :class:`~claudepost.errors.DeskError` when the file is present
        but unusable, having first cleared the table -- so a caller that
        swallows the exception is left authorising nobody rather than
        authorising whoever the last good file said.
        """
        if self._stat() != self._stamp:
            self._load()

    def entry_for(self, presented: str) -> _Entry | None:
        """The whole entry a token belongs to, or ``None``. One scan.

        Constant-time: every entry is compared, every time. The loop does not
        break on a match, because breaking would make the time taken
        proportional to the matching entry's position in the file, which is a
        side channel that says "you are close" to somebody guessing.

        Whoever wants both halves asks once. Two calls would be two scans of
        the token file per request, comparing every entry twice to answer one
        question -- and the answers could in principle come from either side of
        a reload.
        """
        if not isinstance(presented, str) or not presented:
            return None
        want = presented.encode("utf-8")
        found: _Entry | None = None
        for entry in self._entries:
            if hmac.compare_digest(entry.token, want):
                found = entry
        return found

    def scope_for(self, presented: str) -> str | None:
        """The scope this token carries, or ``None`` if it carries none."""
        entry = self.entry_for(presented)
        return entry.scope if entry is not None else None

    def name_for(self, presented: str) -> str | None:
        """Who holds this token, for the audit log. ``None`` if nobody."""
        entry = self.entry_for(presented)
        return entry.name if entry is not None else None

    # -- internals ---------------------------------------------------------

    def _stat(self) -> tuple[int, int, int] | None:
        """The file's identity, as far as "has it changed" needs to know."""
        try:
            st = os.stat(self._path)
        except OSError:
            return None
        return (st.st_ino, st.st_size, st.st_mtime_ns)

    def _load(self) -> None:
        """Read and validate the file. Clears the table before it can fail."""
        stamp = self._stat()
        self._entries = ()
        self._stamp = stamp
        if stamp is None:
            # No file is not an error. The desk must come up on a machine whose
            # secrets mount is empty, serve the device plane, and refuse the
            # control plane -- a state somebody can diagnose. A crash loop is
            # not, and it takes the newspaper down with it.
            return
        try:
            with open(self._path, "r", encoding="utf-8") as f:
                doc = json.load(f)
        except OSError as exc:
            raise DeskError("bad_tokens", f"{self._path}: {exc.strerror}") from exc
        except ValueError as exc:
            raise DeskError("bad_tokens", f"{self._path}: not JSON ({exc})") from exc
        self._entries = _parse(doc, self._path)


def _parse(doc: object, path: str) -> tuple[_Entry, ...]:
    """Validate the whole document before returning any of it.

    All-or-nothing on purpose: a file with one good entry and one broken one is
    a file somebody is halfway through editing, and honouring the good half of
    an edit that has not finished is how a revoked token stays live.
    """
    if not isinstance(doc, dict) or not isinstance(doc.get("tokens"), list):
        raise DeskError("bad_tokens", f"{path}: expected {{\"tokens\": [...]}}")
    entries: list[_Entry] = []
    seen: list[bytes] = []
    for i, raw in enumerate(doc["tokens"]):
        where = f"{path}: tokens[{i}]"
        if not isinstance(raw, dict):
            raise DeskError("bad_tokens", f"{where}: not an object")
        name, scope, token = raw.get("name"), raw.get("scope"), raw.get("token")
        if not isinstance(name, str) or not name.strip():
            raise DeskError("bad_tokens", f"{where}: needs a name")
        where = f"{path}: token {name!r}"
        if scope not in SCOPES:
            raise DeskError("bad_tokens",
                            f"{where}: scope {scope!r} is not one of {SCOPES}")
        if not isinstance(token, str):
            raise DeskError("bad_tokens", f"{where}: token must be a string")
        if len(token) < MIN_TOKEN_CHARS:
            # The token itself stays out of the message; its length does not
            # narrow anything an attacker could not measure anyway.
            raise DeskError("bad_tokens",
                            f"{where}: {len(token)} characters, "
                            f"minimum {MIN_TOKEN_CHARS}")
        encoded = token.encode("utf-8")
        if any(hmac.compare_digest(encoded, s) for s in seen):
            # Two names on one token means the audit trail reports whichever
            # line came first, which is an accountability hole decided by file
            # order.
            raise DeskError("bad_tokens", f"{where}: shares a token with an earlier entry")
        seen.append(encoded)
        entries.append(_Entry(name=name, scope=scope, token=encoded))
    return tuple(entries)


def scope_from_header(tokens: Tokens, header: str | None) -> tuple[str, str]:
    """Turn an ``Authorization`` header into ``(holder name, scope)``.

    Raises :class:`~claudepost.errors.Unauthorized` for every way of not being
    known: no header, a scheme that is not Bearer, an empty credential, a
    token that is not in the file. They are one status on purpose -- the
    difference between "malformed" and "wrong" is information about the file,
    and the caller who wants it is the caller who should not have it.
    """
    if not isinstance(header, str):
        raise Unauthorized(message="no Authorization header")
    scheme, _, credential = header.strip().partition(" ")
    credential = credential.strip()
    if scheme.lower() != "bearer" or not credential:
        raise Unauthorized(message="expected 'Authorization: Bearer <token>'")
    entry = tokens.entry_for(credential)
    if entry is None:
        raise Unauthorized(message="unknown token")
    return (entry.name, entry.scope)


def require(needed: str, have: str) -> None:
    """Raise :class:`~claudepost.errors.Forbidden` unless ``have`` covers
    ``needed``.

    Ranked rather than enumerated: ``operator`` satisfies ``producer`` because
    the owner's own tooling must be able to do everything an agent can without
    holding a second token.
    """
    if needed not in RANK:
        # A route asking for a scope that does not exist is a bug in the route
        # table, not a fault of the caller. Reporting it as a DeskError would
        # dress a typo up as a considered refusal and let it ship; a ValueError
        # is loud and lands in the log with a traceback pointing at the route.
        raise ValueError(f"unknown scope {needed!r}")
    if RANK.get(have, 0) < RANK[needed]:
        raise Forbidden(message=f"{needed} scope required")
