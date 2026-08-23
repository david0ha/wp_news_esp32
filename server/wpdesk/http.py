"""The two planes, and the fact that there is no route from one to the other.

The device plane serves three paths and answers 404 to everything else. That is
``docs/hosting-cloudflare.md``'s *"the publish directory is the allowlist"*
moved into a routing table, and the reason for moving it is that a directory
allowlist only holds while somebody keeps assembling the directory --
``agent/standalone/publish.sh`` rebuilds ``public/`` from empty on every run
precisely because a list of exclusions drifts. A routing table holds because
there is no code that can serve a fourth path. ``test_http.py`` asserts exactly
that, which is the ``find agent/standalone/public -type f`` check made
executable.

The control plane is everything under ``/api/`` and every route on it is behind
a bearer token. The split is by prefix and it is checked once, at the top of
:meth:`_dispatch`, so a route added to the wrong table is a route that fails
loudly rather than one that quietly serves the control plane to anyone.

Paths are matched against anchored regular expressions and the captured groups
are validated before they are used, never joined to a directory as they
arrived. This service is reachable from the internet through a tunnel, which
is the whole reason the rule is a rule rather than a habit.

And a request's body ends with that request. Bodies are read inside handlers,
so every path that answers before reaching one -- a 401 decided from the
header, a 405, a 404, a 413 -- and every handler that wants no body would
otherwise leave those bytes in a keep-alive socket, where the next read takes
them for a request LINE. The tunnel pools its connections to this origin, so
that next request is somebody else's and the smuggled one runs with their
bearer token. :meth:`_settle_body` closes that at the transport, on every path
including the exceptional ones, because a route that forgets to read its body
must not be a way in.

And a connection that stops talking stops costing. ``StreamRequestHandler``
begins with no socket timeout at all, so a client that opens a socket and goes
quiet -- mid-header, mid-body, or idle on a keep-alive connection it will never
use again -- parks one of these threads for as long as it likes, and none of it
looks like an error from in here. Behind a tunnel that client is anybody, so
:data:`SOCKET_TIMEOUT_SECONDS` puts a bound on it.
"""

from __future__ import annotations

import json
import logging
import os
import re
import threading
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from . import policy, schedule as sched, tiles
from .app import Desk, as_int
from .auth import require, scope_from_header
from .editions import CommitResult, SHEET_RE
from .errors import BadRequest, DeskError, Internal, NotFound, TooLarge, epoch_seconds

LOG = logging.getLogger("wpdesk.http")

#: A control-plane request body. Editions come in through the draft endpoints,
#: which have their own limits; everything else here is a small JSON document
#: and a megabyte of it is somebody probing.
MAX_CONTROL_BODY = 64 * 1024

#: The most of a body nobody read that the desk will read and throw away
#: rather than closing the connection. It is the largest any route accepts, so
#: a request inside the limits never costs its connection, and a longer one is
#: already past anything the desk would have taken -- so the socket goes
#: instead of the bytes.
MAX_DRAIN_BYTES = max(MAX_CONTROL_BODY, tiles.MAX_PAYLOAD_BYTES, tiles.MAX_TILE_BYTES)

#: The longest a claim may park. Long enough that an idle worker makes one
#: request a minute and a half; short enough that a stalled connection is
#: noticed rather than held forever.
MAX_CLAIM_WAIT = 90

#: How long a socket may make no progress before the desk takes its thread
#: back. Two bounds decide the figure, and it has to clear the first before it
#: can be judged against the second.
#:
#: The FLOOR is cloudflared's own idle keep-alive to an origin --
#: ``--proxy-keepalive-timeout``, ninety seconds by default -- which this must
#: stay above so that the tunnel is always the side that lets go first. Under
#: it, the desk would be closing connections the tunnel still means to reuse.
#: The CEILING is patience: a stranger who connects and then goes quiet should
#: free its thread in minutes rather than never, and behind a tunnel that
#: stranger is anybody on the internet.
#:
#: "No progress" is exact for a read and generous for a write: CPython's
#: ``sendall`` measures the whole call against one deadline rather than
#: restarting it per chunk, so this is also the longest a response may take to
#: leave -- 960,000 bytes, the largest tile, needs about 8 KB/s end to end.
#:
#: The board pays nothing for any of it: ``http_port_esp.c`` retries once on a
#: fresh connection when it finds a keep-alive socket closed, which is what it
#: already does against ``tools/mock_news_server.py`` and its thirty.
SOCKET_TIMEOUT_SECONDS = 120.0

#: A proof sheet's type, by the suffix ``editions.SHEET_RE`` has already
#: allowed -- these two are that regex's two. The *name* rule comes from the
#: module that writes the files rather than from a copy here: the copy was
#: ``.png``-only, so the gates advertised the ``.bmp`` a render leaves when it
#: fails before conversion and this route refused exactly those.
_SHEET_TYPES = {".png": "image/png", ".bmp": "image/bmp"}

#: The tile id, likewise from the module that owns it: ``tiles.TILE_ID_RE`` is
#: ``ui_tile.c``'s ``id_ok()`` restated once, and a second spelling of the
#: character class here is a second thing to keep in step with the firmware.
_TILE_ID = tiles.TILE_ID_RE.pattern.removeprefix("^").removesuffix(r"\Z")

_TILE_PATH_RE = re.compile(r"^/tiles/(?P<tile>%s)\.bin\Z" % _TILE_ID)


class DeskHTTPRequestHandler(BaseHTTPRequestHandler):
    """One request. The desk hangs off ``self.server.desk``."""

    server_version = "wpdesk"
    sys_version = ""
    protocol_version = "HTTP/1.1"

    #: What this request said its body was, and how much of it a handler took.
    #: Reset per request in :meth:`_dispatch`: one handler instance serves a
    #: whole keep-alive connection, so a leftover count here is the next
    #: request reading the previous one's bytes.
    _declared = 0
    _read = 0

    # -- plumbing ---------------------------------------------------------
    @property
    def desk(self) -> Desk:
        return self.server.desk                                    # type: ignore[attr-defined]

    def setup(self) -> None:
        """Take the socket timeout from the server before the socket is wrapped.

        ``StreamRequestHandler.setup()`` reads ``self.timeout`` and applies it
        to the connection, so this has to happen first. The number lives on
        the server rather than on this class because it is configuration and a
        handler is one request: a test hands its server a short one, and there
        is nowhere here for a second opinion about it to live.
        """
        self.timeout = self.server.socket_timeout                  # type: ignore[attr-defined]
        super().setup()

    def log_message(self, fmt: str, *args) -> None:
        """Requests go to the logger at DEBUG, not to stderr at INFO.

        A board polling every fifteen minutes forever produces a line every
        fifteen minutes saying nothing happened, and those lines bury the one
        that says an edition was published.
        """
        LOG.debug("%s %s", self.address_string(), fmt % args)

    def do_GET(self) -> None:
        self._dispatch("GET")

    def do_HEAD(self) -> None:
        self._dispatch("HEAD")

    def do_POST(self) -> None:
        self._dispatch("POST")

    def do_PUT(self) -> None:
        self._dispatch("PUT")

    def do_DELETE(self) -> None:
        self._dispatch("DELETE")

    def _dispatch(self, method: str) -> None:
        split = urllib.parse.urlsplit(self.path)
        path = urllib.parse.unquote(split.path)
        query = urllib.parse.parse_qs(split.query)

        self._declared = self._declared_length()
        self._read = 0
        try:
            if path.startswith("/api/") or path == "/api":
                self._control(method, path, query)
            else:
                self._device(method, path)
        except DeskError as e:
            self._try_send_json(e.status, e.to_json())
        except (TimeoutError, ConnectionError) as e:
            # The socket went, which is not the desk breaking. A board that
            # gave up mid-response, a curl that was Ctrl-C'd, a stranger who
            # stopped sending the body they declared, a reader who stopped
            # reading until the write timed out: one case, because there is
            # one thing to do about all of them. Answering is not it -- the
            # 500 would go to the same dead socket and raise from inside the
            # handler for it -- and neither is a traceback, which would make
            # this log noisiest exactly when the desk is fine.
            self._lost(e)
        except Exception:                                          # noqa: BLE001
            LOG.exception("unhandled error on %s %s", method, path)
            # The board's envelope for this one too: a client that can parse
            # every refusal this desk gives can parse the desk breaking.
            fault = Internal()
            self._try_send_json(fault.status, fault.to_json())
        finally:
            self._settle_body()

    def _lost(self, e: BaseException) -> None:
        """A socket that went. One line, at DEBUG, and the connection ends.

        Both classes reach here on purpose: ``BrokenPipeError`` and
        ``ConnectionResetError`` are both ``ConnectionError``, and since 3.10
        a socket timeout IS ``TimeoutError``.
        """
        self.close_connection = True
        LOG.debug("%s %s: connection lost (%s)", self.command, self.path, type(e).__name__)

    def _try_send_json(self, status: int, doc: dict) -> None:
        """Answer, unless there is nobody left to answer.

        Every caller of this is already inside an ``except``, and that is the
        whole reason it exists: an exception raised in there replaces the one
        being handled and escapes :meth:`_dispatch` entirely -- past
        ``handle_one_request``, which absorbs only ``TimeoutError``, and into
        ``socketserver``'s ``handle_error``, which prints a traceback to
        stderr for a socket that simply went.

        And a refusal is the commonest thing this desk ever writes to a client
        that has stopped listening: a 401 to a scanner that hung up as soon as
        it learned a token was wanted, a 413 to a client that gave up on its
        own upload. The ordinary path does not need this -- a handler's own
        response is inside the ``try`` and lands on the branch above.
        """
        try:
            self._send_json(status, doc)
        except (TimeoutError, ConnectionError) as e:
            self._lost(e)

    def _declared_length(self) -> int:
        """How long this request says its body is, or ``-1`` for uncountable.

        Uncountable is a chunked transfer, which ``BaseHTTPRequestHandler``
        does not decode at all, or a ``Content-Length`` that is not a number,
        or one longer than anything the desk accepts. All three end the
        connection, and they end it HERE rather than in :meth:`_settle_body`
        so that the response still to come carries ``Connection: close``
        instead of the socket vanishing under a client that thinks it has one.
        """
        encoding = (self.headers.get("Transfer-Encoding") or "").strip().lower()
        raw = self.headers.get("Content-Length")
        if encoding not in ("", "identity"):
            self.close_connection = True
            return -1
        if raw is None:
            return 0
        try:
            length = int(raw)
        except ValueError:
            self.close_connection = True
            return -1
        if length < 0 or length > MAX_DRAIN_BYTES:
            self.close_connection = True
            return -1
        return length

    def _settle_body(self) -> None:
        """Whatever a handler left of the body: read and discard it, or close.

        This is the transport's promise rather than each handler's, which is
        the point -- the table of paths that answer without reading a body is
        long and gains a row every time a route is added. Draining keeps the
        connection usable for the ordinary case (a ``{}`` posted to a route
        that wants no body); anything that cannot be drained to the end takes
        the socket with it, because the alternative is leaving bytes in flight
        on a connection the next caller will be given.
        """
        if self.close_connection:
            return                          # the socket is going; the bytes go with it
        remaining = self._declared - self._read
        if remaining <= 0:
            return
        try:
            while remaining > 0:
                chunk = self.rfile.read(min(remaining, 64 * 1024))
                if not chunk:               # the client hung up mid-body
                    break
                remaining -= len(chunk)
        except OSError:
            remaining = -1
        if remaining:
            self.close_connection = True

    # -- the device plane -------------------------------------------------
    def _device(self, method: str, path: str) -> None:
        """Three paths, ``GET`` and ``HEAD`` only, no token, no cache headers.

        The 405 for other methods comes before the 404 for other paths on
        purpose: a ``POST /news.json`` is a client that has misunderstood this
        interface, and telling it so is more useful than pretending the URL does
        not exist. Matching the table first and asking about the method second
        is what makes that fall out rather than be arranged.
        """
        for pattern, handler in _DEVICE_ROUTES:
            match = pattern.match(path)
            if match is not None:
                break
        else:
            raise NotFound()

        if method not in ("GET", "HEAD"):
            self._send_empty(405, Allow="GET, HEAD")
            return
        handler(self, match, head=(method == "HEAD"))

    def _serve_healthz(self, _match, head: bool) -> None:
        """That the process is up and answering. No token, and no state read."""
        self._send_json(200, {"ok": True, "service": "wpdesk"}, head=head)

    def _serve_edition(self, _match, head: bool) -> None:
        """The current edition, with the policy block spliced in at serve time.

        Computed per request rather than stored because ``next_change`` is an
        instant: baked into a file, it is wrong the moment the schedule changes.
        It costs one parse and one serialise of a document the device caps at
        320 KB, against a board that asks every fifteen minutes.
        """
        desk = self.desk
        eid = desk.editions.current_id()
        payload = desk.editions.read_payload(eid) if eid else None
        if payload is None:
            # Nothing has been filed yet. This is a real state -- a desk brought
            # up before its first edition -- and the board handles it exactly as
            # it handles an unreachable server: it keeps whatever is on the
            # glass and badges it.
            raise NotFound(message="no edition has been filed yet")

        body = policy.splice_policy(payload, desk.schedule, desk.clock.now())
        self._send_bytes(200, body, "application/json", head=head)

    def _serve_tile(self, match, head: bool) -> None:
        desk = self.desk
        eid = desk.editions.current_id()
        data = desk.editions.read_tile(eid, match.group("tile")) if eid else None
        if data is None:
            # A missing tile is an ordinary front-page condition, not an error:
            # the module reflows without the picture and the page still prints.
            raise NotFound()
        self._send_bytes(200, data, "application/octet-stream", head=head)

    # -- the control plane ------------------------------------------------
    def _control(self, method: str, path: str, query: dict) -> None:
        _name, scope = scope_from_header(self.desk.tokens,
                                         self.headers.get("Authorization"))

        for pattern, verbs in _ROUTES:
            match = pattern.match(path)
            if not match:
                continue
            entry = verbs.get(method)
            if entry is None:
                self._send_empty(405, Allow=", ".join(sorted(verbs)))
                return
            needed, handler = entry
            require(needed, scope)
            handler(self, match, query)
            return

        raise NotFound()

    # -- handlers: drafts -------------------------------------------------
    def h_open_draft(self, _match, _query) -> None:
        self._send_json(200, {"ok": True, "draft_id": self.desk.editions.open_draft()})

    def h_put_payload(self, match, _query) -> None:
        self.desk.editions.put_payload(match.group("draft"),
                                       self._body(tiles.MAX_PAYLOAD_BYTES))
        self._send_json(200, {"ok": True})

    def h_put_tile(self, match, _query) -> None:
        self.desk.editions.put_tile(match.group("draft"), match.group("tile"),
                                    self._body(tiles.MAX_TILE_BYTES))
        self._send_json(200, {"ok": True})

    def h_draft_info(self, match, _query) -> None:
        self._send_json(200, {"ok": True, **self.desk.editions.draft_info(match.group("draft"))})

    def h_proof(self, match, _query) -> None:
        # The report is the response. It always carries "ok" -- a refusal is an
        # answer here, not a status -- so there is nothing to put in front of it.
        self._send_json(200, self.desk.editions.proof(match.group("draft")))

    def h_sheet(self, match, _query) -> None:
        """A proof sheet, so the worker that filed the draft can look at it.

        The type comes from the suffix the name has already been checked
        against, because both are pictures the gate may leave: a converted PNG,
        or the BMP of a render that failed before conversion.
        """
        name = match.group("name")
        if not SHEET_RE.match(name):
            raise BadRequest(message="not a sheet name")
        data = self.desk.editions.read_sheet(match.group("draft"), name)
        if data is None:
            raise NotFound()
        self._send_bytes(200, data, _SHEET_TYPES[os.path.splitext(name)[1]])

    def h_commit(self, match, _query) -> None:
        desk = self.desk
        self._send_commit(desk.editions.commit(match.group("draft"), desk.schedule,
                                               desk.clock.now()))

    # -- handlers: editions -----------------------------------------------
    def h_list_editions(self, _match, _query) -> None:
        self._send_json(200, {"ok": True, "editions": self.desk.store.list_editions(),
                              "current": self.desk.editions.current_id(),
                              "staged": self.desk.editions.staged_id()})

    def h_get_edition(self, match, _query) -> None:
        doc = self.desk.store.get_edition(match.group("eid"))
        if doc is None:
            raise NotFound()
        self._send_json(200, {"ok": True, "edition": doc})

    def h_promote(self, match, _query) -> None:
        self._send_commit(self.desk.editions.promote(match.group("eid")))

    # -- handlers: the queue ----------------------------------------------
    def h_enqueue(self, _match, _query) -> None:
        doc = self._json_body()
        text = doc.get("text")
        if not isinstance(text, str) or not text.strip():
            raise BadRequest(message="a command needs text")
        command = self.desk.enqueue(
            doc.get("kind", "custom"), text,
            priority=_int_field(doc, "priority", 5, 0, 9),
            deadline_at=_epoch_field(doc, "deadline_at"),
            source=str(doc.get("source", "api"))[:64])
        self._send_json(200, {"ok": True, "command": command})

    def h_claim(self, _match, query) -> None:
        """Long-poll for one instruction.

        Parked on a condition the enqueue path notifies rather than on a poll
        interval, because latency here is the difference between "put this on
        the wall" and a wall that reacts in a minute. 204 rather than an empty
        200 so a client can tell "nothing to do" from "here is nothing".
        """
        desk = self.desk
        worker = (query.get("worker") or ["worker"])[0][:64]
        wait = min(max(_query_int(query, "wait", 0), 0), MAX_CLAIM_WAIT)
        deadline = desk.clock.monotonic() + wait

        while True:
            command = desk.store.claim_command(worker)
            if command is not None:
                self._send_json(200, command)
                return
            remaining = deadline - desk.clock.monotonic()
            if remaining <= 0:
                self._send_empty(204)
                return
            with desk.queue_event:
                desk.queue_event.wait(timeout=min(remaining, 5.0))

    def h_finish(self, match, _query) -> None:
        doc = self._json_body(required=False)
        status = "done" if match.group("verb") == "done" else "failed"
        command = self.desk.store.finish_command(
            match.group("cid"), status, str(doc.get("result", ""))[:4000])
        self._send_json(200, {"ok": True, "command": command})

    def h_list_commands(self, _match, query) -> None:
        status = (query.get("status") or [None])[0]
        self._send_json(200, {"ok": True,
                              "commands": self.desk.store.list_commands(status=status)})

    def h_cancel(self, match, _query) -> None:
        if not self.desk.store.cancel_command(match.group("cid")):
            raise NotFound(message="no such pending command")
        self._send_json(200, {"ok": True})

    # -- handlers: directives ---------------------------------------------
    def h_list_directives(self, _match, _query) -> None:
        self._send_json(200, {"ok": True, "directives": self.desk.store.list_directives()})

    def h_add_directive(self, _match, _query) -> None:
        doc = self._json_body()
        rule = doc.get("rule")
        if not isinstance(rule, str) or not rule.strip():
            raise BadRequest(message="a directive needs a rule")
        directive = self.desk.store.add_directive(
            rule, scope=str(doc.get("scope", "always")),
            expires_at=_epoch_field(doc, "expires_at"),
            source=str(doc.get("source", "api"))[:64])
        self._send_json(200, {"ok": True, "directive": directive})

    def h_delete_directive(self, match, _query) -> None:
        if not self.desk.store.delete_directive(match.group("did")):
            raise NotFound()
        self._send_json(200, {"ok": True})

    # -- handlers: the schedule -------------------------------------------
    def h_get_schedule(self, _match, _query) -> None:
        self._send_json(200, {"ok": True, "source": self.desk.schedule_source,
                              "schedule": sched.schedule_to_dict(self.desk.schedule)})

    def h_put_schedule(self, _match, _query) -> None:
        """Validate the whole document, then put it in force and write it down.

        There is no partial schedule: a document that fails validation is
        refused whole and leaves the one in force untouched, so an operator
        never has to work out which half of an edit landed. The file under
        ``/data`` is the record and this endpoint is its only writer, which is
        what makes the schedule survive a restart without the desk having to
        watch a file it wrote itself.
        """
        parsed = sched.parse_schedule(self._json_body())
        self.desk.set_schedule(parsed)
        self.desk.store.audit("schedule", {"source": self.desk.schedule_source})
        self._send_json(200, {"ok": True, "source": self.desk.schedule_source,
                              "schedule": sched.schedule_to_dict(self.desk.schedule)})

    def h_schedule_next(self, _match, query) -> None:
        count = min(max(_query_int(query, "count", 10), 1), 50)
        self._send_json(200, {"ok": True,
                              "transitions": sched.describe(self.desk.schedule,
                                                            self.desk.clock.now(), count)})

    # -- handlers: operations ---------------------------------------------
    def h_state(self, _match, _query) -> None:
        self._send_json(200, self.desk.state())

    def h_publish(self, _match, _query) -> None:
        """Put the staged edition up now, quiet window and minimum gap included.

        A rule you cannot override is a rule somebody ends up editing at
        midnight, so this exists and it is deliberately absolute.
        """
        result = self.desk.editions.publish_now("forced")
        if result is None:
            raise NotFound(message="nothing is staged")
        self.desk.store.audit("publish", {"edition": result.edition_id, "forced": True})
        self._send_commit(result)

    def h_hold(self, _match, _query) -> None:
        doc = self._json_body(required=False)
        until = _epoch_field(doc, "until")
        self.desk.store.set_hold(until)
        self.desk.store.audit("hold", {"until": until})
        self._send_json(200, {"ok": True, "hold": as_int(until)})

    # -- bodies and responses ---------------------------------------------
    def _body(self, limit: int) -> bytes:
        """Read the request body, refusing anything past ``limit``.

        The length is checked from the header BEFORE the socket is drained, so
        an oversized upload costs one header rather than the bytes themselves.
        """
        raw = self.headers.get("Content-Length")
        if raw is None:
            raise BadRequest(message="Content-Length is required")
        try:
            length = int(raw)
        except ValueError:
            raise BadRequest(message="Content-Length is not a number") from None
        if length < 0:
            raise BadRequest(message="Content-Length is negative")
        if length > limit:
            # The socket still holds those bytes and this refusal is the reason
            # nobody is going to read them. Reading them anyway would spend
            # exactly what the header check exists to save, so the connection
            # is what ends instead.
            self.close_connection = True
            raise TooLarge(message="%d bytes, limit %d" % (length, limit))
        data = self.rfile.read(length) if length else b""
        self._read += len(data)
        return data

    def _json_body(self, required: bool = True) -> dict:
        data = self._body(MAX_CONTROL_BODY)
        if not data:
            if required:
                raise BadRequest("bad_json", "an empty body")
            return {}
        try:
            doc = json.loads(data)
        except ValueError as e:
            raise BadRequest("bad_json", str(e)) from None
        if not isinstance(doc, dict):
            raise BadRequest("bad_json", "the body must be a JSON object")
        return doc

    def _send_commit(self, result: CommitResult) -> None:
        """What became of an edition, in the one shape its three doors answer in.

        A commit, a promotion and a forced publish are the same event to the
        client reading them -- an edition, what happened to it, and why -- and
        a client that had to tell three spellings apart would be reading the
        door rather than the answer.
        """
        self._send_json(200, {"ok": True, "edition_id": result.edition_id,
                              "state": result.state, "reason": result.reason})

    def _send_status(self, status: int) -> None:
        """The status line, and ``Connection: close`` when this is the last answer.

        Saying so is not politeness: a client promised keep-alive that finds
        the socket gone retries, and behind a tunnel it retries onto a pooled
        connection somebody else is using. ``send_header`` sets
        ``close_connection`` itself for this value, so the header and the
        decision cannot drift apart.
        """
        self.send_response(status)
        if self.close_connection:
            self.send_header("Connection", "close")

    def _send_empty(self, status: int, **headers: str) -> None:
        """A response with no body: the 204 of an idle claim, the 405 of a verb.

        ``Content-Length: 0`` explicitly. This server speaks HTTP/1.1 with
        keep-alive, and a client not told the length waits for one.
        """
        self._send_status(status)
        for name, value in headers.items():
            self.send_header(name, value)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _send_json(self, status: int, doc: dict, head: bool = False) -> None:
        body = json.dumps(doc, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        self._send_bytes(status, body, "application/json", head=head)

    def _send_bytes(self, status: int, body: bytes, content_type: str,
                    head: bool = False) -> None:
        """One response.

        No ``Cache-Control`` and no ``ETag``, deliberately. The board reads
        neither, and a cache between the desk and the board is a stale front
        page nobody can explain from across a room.
        """
        self._send_status(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if not head:
            self.wfile.write(body)


# -- the device plane's routing table -------------------------------------
#
# Matched once, top to bottom, and "known" is "a pattern matched". There is no
# fourth entry and no code that can serve a fourth path, which is what
# ``docs/hosting-cloudflare.md``'s "the publish directory is the allowlist"
# becomes when it is moved into a routing table.
_DEVICE_ROUTES = (
    (re.compile(r"^/news\.json\Z"), DeskHTTPRequestHandler._serve_edition),
    (re.compile(r"^/healthz\Z"), DeskHTTPRequestHandler._serve_healthz),
    (_TILE_PATH_RE, DeskHTTPRequestHandler._serve_tile),
)


# -- the control plane's routing table ------------------------------------
#
# Anchored patterns -- with ``\Z``, never ``$``, which also matches before a
# trailing newline -- and every captured group is validated by the module that
# consumes it before it becomes a path. The scope beside each verb is the
# minimum that may call it:
#
#   producer  an automated participant: push editions, claim work, ASK for work,
#             read the schedule and the state.
#   operator  additionally the things that change what the wall does without
#             going through a gate -- the schedule, a forced publish, a hold, a
#             promotion, and the standing directives.
#
# Enqueueing is producer rather than operator because pushing an instruction
# from somewhere else is the whole point of the queue, and an instruction still
# has to survive all five gates before it reaches paper. Editing the standing
# directives is operator because those outlive every gate.
_ROUTES = [
    (re.compile(r"^/api/drafts\Z"), {
        "POST": ("producer", DeskHTTPRequestHandler.h_open_draft)}),
    (re.compile(r"^/api/drafts/(?P<draft>[0-9a-f]{32})\Z"), {
        "GET": ("producer", DeskHTTPRequestHandler.h_draft_info)}),
    (re.compile(r"^/api/drafts/(?P<draft>[0-9a-f]{32})/news\.json\Z"), {
        "PUT": ("producer", DeskHTTPRequestHandler.h_put_payload)}),
    (re.compile(r"^/api/drafts/(?P<draft>[0-9a-f]{32})/tiles/(?P<tile>%s)\.bin\Z" % _TILE_ID), {
        "PUT": ("producer", DeskHTTPRequestHandler.h_put_tile)}),
    (re.compile(r"^/api/drafts/(?P<draft>[0-9a-f]{32})/proof\Z"), {
        "POST": ("producer", DeskHTTPRequestHandler.h_proof)}),
    (re.compile(r"^/api/drafts/(?P<draft>[0-9a-f]{32})/proof/(?P<name>[^/]{1,60})\Z"), {
        "GET": ("producer", DeskHTTPRequestHandler.h_sheet)}),
    (re.compile(r"^/api/drafts/(?P<draft>[0-9a-f]{32})/commit\Z"), {
        "POST": ("producer", DeskHTTPRequestHandler.h_commit)}),

    (re.compile(r"^/api/editions\Z"), {
        "GET": ("producer", DeskHTTPRequestHandler.h_list_editions)}),
    (re.compile(r"^/api/editions/(?P<eid>[0-9a-f]{8,64})\Z"), {
        "GET": ("producer", DeskHTTPRequestHandler.h_get_edition)}),
    (re.compile(r"^/api/editions/(?P<eid>[0-9a-f]{8,64})/promote\Z"), {
        "POST": ("operator", DeskHTTPRequestHandler.h_promote)}),

    (re.compile(r"^/api/commands\Z"), {
        "GET": ("producer", DeskHTTPRequestHandler.h_list_commands),
        "POST": ("producer", DeskHTTPRequestHandler.h_enqueue)}),
    (re.compile(r"^/api/commands/next\Z"), {
        "GET": ("producer", DeskHTTPRequestHandler.h_claim)}),
    (re.compile(r"^/api/commands/(?P<cid>[0-9a-f]{8,64})\Z"), {
        "DELETE": ("operator", DeskHTTPRequestHandler.h_cancel)}),
    (re.compile(r"^/api/commands/(?P<cid>[0-9a-f]{8,64})/(?P<verb>done|fail)\Z"), {
        "POST": ("producer", DeskHTTPRequestHandler.h_finish)}),

    (re.compile(r"^/api/directives\Z"), {
        "GET": ("producer", DeskHTTPRequestHandler.h_list_directives),
        "POST": ("operator", DeskHTTPRequestHandler.h_add_directive)}),
    (re.compile(r"^/api/directives/(?P<did>[0-9a-f]{8,64})\Z"), {
        "DELETE": ("operator", DeskHTTPRequestHandler.h_delete_directive)}),

    (re.compile(r"^/api/schedule\Z"), {
        "GET": ("producer", DeskHTTPRequestHandler.h_get_schedule),
        "PUT": ("operator", DeskHTTPRequestHandler.h_put_schedule)}),
    (re.compile(r"^/api/schedule/next\Z"), {
        "GET": ("producer", DeskHTTPRequestHandler.h_schedule_next)}),

    (re.compile(r"^/api/state\Z"), {
        "GET": ("producer", DeskHTTPRequestHandler.h_state)}),
    (re.compile(r"^/api/publish\Z"), {
        "POST": ("operator", DeskHTTPRequestHandler.h_publish)}),
    (re.compile(r"^/api/hold\Z"), {
        "POST": ("operator", DeskHTTPRequestHandler.h_hold)}),
]


class DeskServer(ThreadingHTTPServer):
    """A threading server that carries the desk and reuses its address.

    Threads are daemons because a long poll may be parked for ninety seconds and
    a shutdown should not wait for it: the claim it is holding returns to the
    queue on its lease, which is exactly the case leases are for.
    """

    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address, handler, desk: Desk,
                 timeout: float = SOCKET_TIMEOUT_SECONDS) -> None:
        self.desk = desk
        # Not `timeout`: `BaseServer` already owns that name, for how long
        # `handle_request` waits for a caller. This one is the socket's.
        self.socket_timeout = timeout
        super().__init__(address, handler)


def make_server(desk: Desk, host: str, port: int,
                timeout: float = SOCKET_TIMEOUT_SECONDS) -> DeskServer:
    """Build the server without starting it. Port 0 picks one, which tests use."""
    return DeskServer((host, port), DeskHTTPRequestHandler, desk, timeout=timeout)


def serve_forever(desk: Desk, tick_seconds: float = 5.0) -> None:
    """Start the scheduler thread and then serve until interrupted."""
    stop = threading.Event()

    def ticker() -> None:
        while not stop.is_set():
            try:
                did = desk.tick()
                if did:
                    LOG.info("tick: %s", ", ".join(did))
            except Exception:                                      # noqa: BLE001
                # A tick that raises must not take the scheduler thread with it.
                # The board is still being served by the other threads, and a
                # desk that stopped ticking silently would look identical to one
                # whose schedule simply had nothing to do.
                LOG.exception("scheduler tick failed")
            stop.wait(tick_seconds)

    thread = threading.Thread(target=ticker, name="wpdesk-tick", daemon=True)
    thread.start()

    server = make_server(desk, desk.cfg.host, desk.cfg.port)
    LOG.info("desk listening on %s:%d", desk.cfg.host, desk.cfg.port)
    try:
        server.serve_forever()
    finally:
        stop.set()
        server.server_close()


# -- small field helpers --------------------------------------------------
def _int_field(doc: dict, key: str, default: int, low: int, high: int) -> int:
    value = doc.get(key, default)
    if isinstance(value, bool) or not isinstance(value, int):
        raise BadRequest(message="%s must be an integer" % key)
    if not low <= value <= high:
        raise BadRequest(message="%s must be %d..%d" % (key, low, high))
    return value


def _epoch_field(doc: dict, key: str) -> float | None:
    """One instant out of a JSON body, by the rule ``errors.py`` owns.

    The rule itself is shared with the store, which is handed the same instants
    through a keyword instead of a body -- see :func:`~wpdesk.errors.epoch_seconds`.
    """
    return epoch_seconds(doc.get(key), key)


def _query_int(query: dict, key: str, default: int) -> int:
    raw = (query.get(key) or [None])[0]
    if raw is None:
        return default
    try:
        return int(raw)
    except ValueError:
        raise BadRequest(message="%s must be an integer" % key) from None


__all__ = ["DeskHTTPRequestHandler", "DeskServer", "make_server", "serve_forever"]
