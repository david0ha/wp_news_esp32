"""The desk's control plane from the worker's side, and the two secrets it reads.

Every route here is under ``/api/`` and every one of them is behind a bearer
token with the ``producer`` scope. The worker never touches the device plane --
``GET /news.json`` is what the board polls, and a producer that read its own
output back would be reading what it just wrote.

Two things about this module are deliberate.

**The opener is an argument.** ``urllib.request.urlopen`` is the default, and
``agent/test/test_deskclient.py`` passes a stub instead. Every answer the desk
can give is a branch -- a 204 meaning nothing to do, a 200 with an empty body, a
200 that is not JSON, a 4xx -- and none of them should need a desk running, a
port bound or a token minted to exercise.

**The token never reaches a string that leaves this process.** The messages
these methods raise are handed to ``POST /api/commands/<id>/fail``, where the
desk stores them and an operator reads them later. A desk that echoed the
``Authorization`` header into an error body would otherwise write the bearer
token into a log that outlives it, so every message goes through
:meth:`DeskClient._redact` on the way out.

Standard library only, and it must run on the python3 that ships in
node:22-slim (3.11), so nothing newer than that is used here.
"""

from __future__ import annotations

import json
import logging
import os
import re
import urllib.error
import urllib.request

LOG = logging.getLogger("worker.desk")

#: How long a claim call parks on the desk. The desk caps this at 90; parking is
#: free on both sides and it is the difference between reacting in a second and
#: reacting on a poll interval.
CLAIM_WAIT = 60

#: What the desk mints for a command, and for a draft -- ``uuid4().hex``, and
#: nothing else ever. Checked here because :func:`loop.handle` joins a command
#: id to the scratch directory and hands the result to ``shutil.rmtree``, and
#: :meth:`DeskClient.open_draft` hands a draft id straight back to the caller,
#: who joins it onto every other draft route in turn: this is the line where
#: the desk's answer stops being a document and becomes a path. ``\Z`` and not
#: ``$``, for the reason the desk gives at ``editions.py`` -- ``$`` also matches
#: before a trailing newline, and that is not a directory name.
DESK_ID_RE = re.compile(r"^[0-9a-f]{32}\Z")

#: The desk's own cap on a note, from ``notes.MAX_NOTES_BYTES`` -- a quarter of
#: a megabyte, because a phone fetches the whole of it through a tunnel in one
#: go. Duplicated rather than imported: the worker and the desk are two ends
#: of one wire, not one program, and the desk enforces this limit regardless
#: -- this constant only saves a 413 round trip for a dossier that ran long.
MAX_NOTES_BYTES = 262144


class DeskClient:
    """The control plane, over HTTP, with a bearer token.

    Args:
        base: the desk's root, with or without a trailing slash.
        token: a ``producer`` bearer token.
        opener: what performs the request. Defaults to
            ``urllib.request.urlopen``; the tests pass a stub with the same
            ``(request, timeout=...)`` signature.
    """

    def __init__(self, base: str, token: str,
                 opener=urllib.request.urlopen) -> None:
        self.base = base.rstrip("/")
        self.token = token
        self.opener = opener

    # -- the wire ---------------------------------------------------------
    def _redact(self, text: str) -> str:
        """Blank the bearer token out of anything that becomes a message.

        Defensive rather than necessary: nothing here formats the token into a
        string on purpose. What this catches is the desk -- or a proxy in front
        of it -- quoting the request back in an error body, which would put the
        token in the failure report and then in the audit log.
        """
        if not self.token:
            return text
        return text.replace(self.token, "<token>")

    def _request(self, method: str, path: str, body: bytes | None = None,
                 content_type: str = "application/json", timeout: int = 120):
        """One request. Returns ``(status, bytes)``; a 4xx is an answer, not a raise."""
        req = urllib.request.Request(self.base + path, data=body, method=method)
        req.add_header("Authorization", "Bearer " + self.token)
        if body is not None:
            req.add_header("Content-Type", content_type)
        try:
            with self.opener(req, timeout=timeout) as resp:
                return resp.status, resp.read()
        except urllib.error.HTTPError as e:
            return e.code, e.read()

    def _json(self, method: str, path: str, doc=None, timeout: int = 120):
        """One request whose answer should be JSON. Returns ``(status, doc|None)``."""
        body = json.dumps(doc).encode() if doc is not None else None
        status, raw = self._request(method, path, body, timeout=timeout)
        if status == 204 or not raw:
            return status, None
        try:
            return status, json.loads(raw)
        except ValueError:
            # A control endpoint that answers with something that is not JSON is
            # a bug on the desk, and reporting the bytes is the only way anybody
            # finds out which endpoint did it.
            return status, {"ok": False, "error": "not_json",
                            "detail": self._redact(raw[:400].decode("utf-8", "replace"))}

    def _fail(self, what: str, status: int, detail) -> RuntimeError:
        """The one place a failure becomes a message. Redacted, and short."""
        if isinstance(detail, bytes):
            detail = detail[:400].decode("utf-8", "replace")
        return RuntimeError(self._redact("%s: %s %s" % (what, status, detail)))

    # -- the queue --------------------------------------------------------
    def claim(self) -> dict | None:
        """Long-poll for one instruction. ``None`` when the wait expired.

        Only a 204 -- or a 200 with nothing in it, which is what a proxy makes
        of a 204 -- means nothing to do. Every other non-200 raises, and it has
        to: a gateway answering 502 with an empty body is the shape most like a
        204, and reading it as "nothing to do" would send the worker round to
        re-claim as fast as the socket allows, forever. Raising puts it on the
        loop's backoff instead.

        A 200 that is not an instruction raises for the same reason. This is
        the one caller for which :meth:`_json`'s ``not_json`` envelope -- and a
        200 carrying a JSON array, which arrives as a list -- is not an answer:
        neither has an id, and the caller's next move is ``command["id"]``,
        outside every try in :func:`loop.main`. A worker that exits there is a
        container ``restart: unless-stopped`` brings up and kills once a minute
        for as long as nobody is watching, rather than one backing off from a
        second to five minutes. Every other method keeps the envelope, because
        for those "the desk answered HTML" is a report and not a crash.

        The id is checked for its shape as well as its presence. It is not a
        name here for long: the loop makes a directory of it and empties that
        directory with ``shutil.rmtree``, so an id of ``../..`` from a desk
        this worker should not have trusted -- a compromised one, a
        misconfigured ``CLAUDEPOST_DESK``, a MITM on plain HTTP -- deletes its way
        out of the scratch. The precondition is real enough to check for: this
        container is the one holding the API key.

        Returns:
            The instruction, or ``None`` when there was nothing to claim.

        Raises:
            RuntimeError: every other answer, redacted and short.
        """
        status, doc = self._json(
            "GET", "/api/commands/next?wait=%d" % CLAIM_WAIT, timeout=CLAIM_WAIT + 30)
        if status == 204 or (status == 200 and doc is None):
            return None
        if status != 200:
            raise self._fail("claim failed", status, doc)
        if not isinstance(doc, dict) or "id" not in doc:
            raise self._fail("claim answered with no instruction", status, doc)
        if not isinstance(doc["id"], str) or not DESK_ID_RE.match(doc["id"]):
            raise self._fail("claim answered with a malformed id", status, doc)
        return doc

    def finish(self, cid: str, ok: bool, result: str) -> None:
        """Report an instruction as done or failed. The result reaches an operator."""
        verb = "done" if ok else "fail"
        self._json("POST", "/api/commands/%s/%s" % (cid, verb),
                   {"result": self._redact(result)[:4000]})

    # -- drafts -----------------------------------------------------------
    def open_draft(self) -> str:
        """Open a draft. Returns its id.

        The id is checked for its shape as well as its presence, the same
        precondition :meth:`claim` holds a command id to and for the same
        reason: every later draft call -- :meth:`put_payload`, :meth:`put_tile`,
        :meth:`proof`, :meth:`commit` -- joins this string straight onto a URL
        path, so a desk behind a proxy that answers with something other than
        what the desk said is exactly the case this guards against.

        Raises:
            RuntimeError: the status was not 200, or the answer carried no
                ``draft_id`` shaped like one the desk mints.
        """
        status, doc = self._json("POST", "/api/drafts", {})
        if status != 200:
            raise self._fail("open draft", status, doc)
        draft_id = doc.get("draft_id") if isinstance(doc, dict) else None
        if not isinstance(draft_id, str) or not DESK_ID_RE.match(draft_id):
            raise self._fail("open draft answered with a malformed id", status, doc)
        return draft_id

    def put_payload(self, draft: str, data: bytes) -> None:
        """Upload ``news.json`` into a draft."""
        status, raw = self._request("PUT", "/api/drafts/%s/news.json" % draft, data)
        if status != 200:
            raise self._fail("put payload", status, raw)

    def put_tile(self, draft: str, tile_id: str, data: bytes) -> None:
        """Upload one tile beside the payload, verbatim."""
        status, raw = self._request(
            "PUT", "/api/drafts/%s/tiles/%s.bin" % (draft, tile_id), data,
            content_type="application/octet-stream")
        if status != 200:
            raise self._fail("put tile %s" % tile_id, status, raw)

    def put_notes(self, text: str, *, draft: str | None = None,
                  command: str | None = None) -> None:
        """File a markdown dossier beside a draft or a command.

        Exactly one of ``draft`` or ``command`` names what the note is about
        -- naming both or neither is a bug in the caller, not something the
        desk gets to answer, so it is caught here rather than sent.

        Args:
            text: the note, markdown, meant for a person reading it on a
                phone next to the page it explains.
            draft: a draft id, checked against `DESK_ID_RE` before it
                becomes a path -- the same precondition every other draft
                call holds it to.
            command: a command id, held to the same check.

        The desk refuses a note over :data:`MAX_NOTES_BYTES` from the
        ``Content-Length`` alone, without reading a byte of it, so a note
        that ran long is cut here instead of refused outright -- at a
        codepoint boundary, because that many bytes of UTF-8 is not
        necessarily a whole number of characters, and a raw slice would
        leave a dangling partial sequence at the end that no reader could
        decode. ``decode(..., "ignore")`` drops that fragment; the
        re-encode after it is what turns the cut back into bytes.

        Raises:
            ValueError: both or neither of ``draft``/``command`` were given,
                or the one that was is not a shape the desk mints.
            RuntimeError: the desk answered anything but 200, redacted and
                short.
        """
        if (draft is None) == (command is None):
            raise ValueError("put_notes: name exactly one of draft or command")
        if draft is not None:
            if not DESK_ID_RE.match(draft):
                raise ValueError("put_notes: not a draft id: %r" % (draft,))
            path = "/api/drafts/%s/notes.md" % draft
        else:
            if not DESK_ID_RE.match(command):
                raise ValueError("put_notes: not a command id: %r" % (command,))
            path = "/api/commands/%s/notes.md" % command
        body = text.encode("utf-8")
        if len(body) > MAX_NOTES_BYTES:
            body = body[:MAX_NOTES_BYTES].decode("utf-8", "ignore").encode("utf-8")
        status, raw = self._request(
            "PUT", path, body, content_type="text/markdown; charset=utf-8")
        if status != 200:
            raise self._fail("put notes", status, raw)

    def proof(self, draft: str):
        """Run the desk's gates over a draft. Returns the report.

        Minutes rather than seconds: the desk validates the payload and then
        sets the type at 1200x1600 in six inks, which is a real render.
        """
        status, doc = self._json("POST", "/api/drafts/%s/proof" % draft, {}, timeout=900)
        if status != 200:
            raise self._fail("proof", status, doc)
        return doc

    def commit(self, draft: str):
        """Turn a proofed draft into an edition. Returns what the desk did with it."""
        status, doc = self._json("POST", "/api/drafts/%s/commit" % draft, {}, timeout=900)
        if status != 200:
            raise self._fail("commit", status, doc)
        return doc

    def fetch_sheet(self, draft: str, name: str) -> bytes:
        """One proof sheet, as bytes.

        This is what makes "the desk cannot see the paper" false: the worker
        does not own the typesetter, so it asks for the sheets and looks at
        them, which is the only way a headline that broke on the wrong word
        gets caught by anything but a reader.
        """
        status, raw = self._request("GET", "/api/drafts/%s/proof/%s" % (draft, name))
        if status != 200:
            raise self._fail("sheet %s" % name, status, raw)
        return raw

    # -- standing instructions -------------------------------------------
    def directives(self):
        """The desk's standing instructions, or ``[]`` when it will not say.

        An enrichment rather than a precondition: a desk that cannot list its
        directives is not a reason to refuse to file a page.
        """
        status, doc = self._json("GET", "/api/directives")
        return (doc or {}).get("directives", []) if status == 200 else []

    def settings(self) -> dict:
        """The desk's operator settings, or ``{"lang": "en"}`` when it will not say.

        Today that document holds one field, ``lang`` -- the language the
        edition is written in, which :func:`prompt.build_prompt` turns into a
        section of the prompt. It is returned whole rather than as that one
        field because it is the document a later release adds a setting to,
        and a client that unpacked it here would have to be changed to carry
        the next one.

        :meth:`directives`'s stance exactly: an enrichment, not a
        precondition. A desk that is down, one too old to know the route, and
        one that answers with an envelope carrying no ``settings`` all file an
        English page rather than no page -- which is the right failure, because
        the alternative is a worker that stops filing over a setting the
        operator has probably never changed.

        It is never a *silent* failure, though, and that is the difference
        between this and :meth:`directives`. A missing directive is visible in
        the page it did not shape; a language that fell back is invisible --
        an operator who set Korean gets a perfectly ordinary English paper, and
        without the line below the only evidence that this route answered 500
        is the front page itself. So each way out of here warns exactly once,
        naming the status or the exception class and nothing more: the request
        carries the bearer token in a header, and ``self.base`` is allowed to
        carry credentials.

        The down-desk case is the one that needs catching here rather than in
        :meth:`_request`, which turns a 4xx into an answer but lets everything
        below HTTP through. Connection refused, no route to host and a name
        that does not resolve all arrive as ``URLError`` -- an ``OSError`` --
        and this is the one method whose contract says they are not fatal.
        """
        try:
            status, doc = self._json("GET", "/api/settings")
        except OSError as e:
            LOG.warning("desk settings unreadable (%s) -- filing in English",
                        type(e).__name__)
            return {"lang": "en"}

        if status != 200:
            LOG.warning("desk settings unreadable (HTTP %s) -- filing in English",
                        status)
            return {"lang": "en"}

        settings = doc.get("settings") if isinstance(doc, dict) else None
        if not isinstance(settings, dict) or not settings:
            LOG.warning("desk answered 200 with no settings document "
                        "-- filing in English")
            return {"lang": "en"}
        return settings


def read_token(secrets: str) -> str:
    """The producer token, from the mounted secrets directory.

    Args:
        secrets: the directory ``~/.claudepost`` is mounted at, read-only.

    Two shapes are accepted because two things write them: ``agent.env`` is what
    a human edits, ``tokens.json`` is what the desk reads. ``agent.env`` wins
    when both hold one, because it is the one somebody edited last.

    Neither is ever logged, and a missing token is a hard exit rather than a
    loop that retries forever against a 401 -- a worker that cannot
    authenticate will not start being able to, and a container that exits is a
    container somebody notices.

    Raises:
        SystemExit: with code 2, when there is no producer token to be had.
    """
    env_path = os.path.join(secrets, "agent.env")
    token = _read_env_file(env_path).get("CLAUDEPOST_TOKEN")
    if token:
        return token

    tokens_path = os.path.join(secrets, "tokens.json")
    if os.path.exists(tokens_path):
        with open(tokens_path, encoding="utf-8") as f:
            doc = json.load(f)
        for entry in doc.get("tokens", []):
            if entry.get("scope") == "producer":
                return entry["token"]

    LOG.error("no producer token: put CLAUDEPOST_TOKEN in %s, or a producer entry in %s",
              env_path, tokens_path)
    raise SystemExit(2)


def load_agent_env(secrets: str) -> dict:
    """Everything in ``agent.env`` except the desk token, for the child process.

    Args:
        secrets: the directory ``~/.claudepost`` is mounted at, read-only.

    Returns:
        The file's ``KEY=value`` pairs, minus ``CLAUDEPOST_TOKEN``. Empty when there
        is no such file, which is a warning at startup rather than an error
        here.

    In a container, ``ANTHROPIC_API_KEY`` or ``CLAUDE_CODE_OAUTH_TOKEN`` has
    to be one of these:
    headless Claude Code in a container will not find a desktop login session,
    and discovering that at 06:00 is exactly the silent failure
    ``agent/standalone/file-edition.sh`` guards against by checking ``PATH``
    first.

    ``CLAUDEPOST_TOKEN`` is dropped on purpose. It authorises writing to the desk;
    the child is a model with a shell, and it has no use for the token and every
    reason not to see it.
    """
    env = _read_env_file(os.path.join(secrets, "agent.env"))
    env.pop("CLAUDEPOST_TOKEN", None)
    return env


def _read_env_file(path: str) -> dict:
    """The ``KEY=value`` pairs in a file, or ``{}`` when there is no such file.

    Blank lines, ``#`` comments and anything without an ``=`` are skipped, and
    one layer of quotes comes off each value -- ``agent.env`` is a file a human
    edits, not a shell this parses.

    The FIRST spelling of a key wins, which is how :func:`read_token` has always
    read this file: top down, taking the first answer it finds. A file somebody
    appended to twice therefore reads the same way to both callers, and neither
    is the one that decides.
    """
    env: dict = {}
    if not os.path.exists(path):
        return env
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            env.setdefault(key.strip(), value.strip().strip('"').strip("'"))
    return env
