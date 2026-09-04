"""The control plane from the worker's side, with the socket taken out.

``DeskClient`` takes its opener as an argument for exactly this: every answer
the desk can give -- a 204 that means "nothing to do", a 200 with an empty body,
a 200 with something that is not JSON, a 4xx -- is a branch, and none of them
should need a desk running to exercise.

The property that matters most is the last one. Every string this client raises
ends up in ``POST /api/commands/<id>/fail``, which the desk stores and an
operator reads later, so a bearer token that reaches an exception message is a
bearer token written to a log file that outlives it.
"""

from __future__ import annotations

import io
import json
import os
import shutil
import tempfile
import unittest
import urllib.error

import deskclient

TOKEN = "test-token-never-in-a-message"

#: What the desk mints for a command: ``uuid4().hex``, and the only shape the
#: worker will accept back -- the id becomes a path under the scratch.
CID = "0123456789abcdef0123456789abcdef"


class _Response:
    """What ``urllib.request.urlopen`` hands back, minus the socket."""

    def __init__(self, status: int, body: bytes) -> None:
        self.status = status
        self._body = body

    def read(self) -> bytes:
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class StubOpener:
    """Replays a queued list of answers and records what was asked.

    An answer is ``(status, body)``; a status of 400 or more is raised as the
    ``HTTPError`` urllib would raise, because that path -- catching it and
    reading the body out of the exception -- is the one worth testing.
    """

    def __init__(self, *answers) -> None:
        self.answers = list(answers)
        self.requests = []

    def __call__(self, req, timeout=None):
        self.requests.append(req)
        status, body = self.answers.pop(0) if self.answers else (204, b"")
        if status >= 400:
            raise urllib.error.HTTPError(req.full_url, status, "err", {},
                                         io.BytesIO(body))
        return _Response(status, body)


def client(*answers) -> tuple[deskclient.DeskClient, StubOpener]:
    """A client wired to a stub opener, and the stub, for the assertions."""
    opener = StubOpener(*answers)
    return deskclient.DeskClient("http://desk:8080/", TOKEN, opener=opener), opener


class ClaimTest(unittest.TestCase):
    """The long poll: what is an instruction, and what only looks like one.

    Two answers mean nothing to do and everything else raises, because the
    caller is a loop whose only two moves are "run this" and "back off". An
    answer it cannot run and did not raise on would reach ``command["id"]``
    outside every try in :func:`loop.main`, and a worker that exits is a
    container ``restart: unless-stopped`` brings up and kills once a minute.
    """

    def test_a_204_is_nothing_to_do(self):
        desk, _ = client((204, b""))
        self.assertIsNone(desk.claim())

    def test_a_200_with_an_empty_body_is_nothing_to_do(self):
        # The desk should send 204, but a proxy that rewrote it to an empty 200
        # must not turn into a worker that raises once a minute forever.
        desk, _ = client((200, b""))
        self.assertIsNone(desk.claim())

    def test_a_command_comes_back_as_a_dict(self):
        desk, _ = client((200, json.dumps({"id": CID, "text": "NVDA"}).encode()))
        self.assertEqual(desk.claim()["id"], CID)

    def test_a_200_that_is_not_json_raises_so_the_loop_backs_off(self):
        # A proxy in front of the tunnel serving an HTML error page. It reaches
        # here as the `not_json` envelope, which has no id -- so it is not an
        # instruction, and the loop must treat it as an unreachable desk. The
        # first bytes go into the message, because "which endpoint answered
        # HTML" is the only question anybody has once this starts.
        desk, _ = client((200, b"<html>gateway</html>"))
        with self.assertRaises(RuntimeError) as caught:
            desk.claim()
        self.assertIn("gateway", str(caught.exception))

    def test_a_200_carrying_a_json_array_raises(self):
        # Worth its own case because it fails differently: `command["id"]` on a
        # list is a TypeError where the not_json dict is a KeyError, and a
        # check that only rejected the dict would still exit the worker.
        for body in (b"[]", b'[{"id":"abc"}]'):
            desk, _ = client((200, body))
            with self.assertRaises(RuntimeError, msg=repr(body)):
                desk.claim()

    def test_an_id_that_is_not_the_shape_the_desk_mints_raises(self):
        # The id becomes a directory under the scratch and then the argument to
        # `shutil.rmtree`, so this is where the desk's answer stops being
        # something to trust and starts being a path. The desk mints
        # `uuid4().hex` and nothing else; a worker that took `../..` on its word
        # would delete its way out of the scratch, and the compromised desk that
        # sent it is the precondition, not the exploit.
        for bad in ("../..", "abc", "", "0123456789abcdef",
                    "0123456789abcdef0123456789abcdeg",         # 32, but not hex
                    "0123456789abcdef0123456789abcdef\n",       # why \Z and not $
                    "0123456789ABCDEF0123456789ABCDEF"):        # uuid4().hex is lower
            desk, _ = client((200, json.dumps({"id": bad, "text": "NVDA"}).encode()))
            with self.assertRaises(RuntimeError, msg=repr(bad)):
                desk.claim()

    def test_a_200_dict_without_an_id_raises(self):
        # The id is what `finish` reports against. Without one there is nothing
        # to run and nothing to report having failed to run.
        desk, _ = client((200, b'{"text":"NVDA"}'))
        with self.assertRaises(RuntimeError):
            desk.claim()

    def test_the_not_json_envelope_still_reaches_the_other_callers(self):
        # Only the claim insists on an instruction. Everywhere else a 200 that
        # is not JSON is reported rather than raised, which is how a proxy
        # answering HTML gets named instead of swallowed -- `handle()` reads
        # `ok` off this and goes round for a revision.
        desk, _ = client((200, b"<html>gateway</html>"))
        report = desk.proof("d")
        self.assertEqual(report["ok"], False)
        self.assertEqual(report["error"], "not_json")
        self.assertIn("gateway", report["detail"])

    def test_a_5xx_on_the_claim_raises_so_the_loop_backs_off(self):
        desk, _ = client((503, b'{"ok":false,"error":"unavailable"}'))
        with self.assertRaises(RuntimeError) as caught:
            desk.claim()
        self.assertIn("503", str(caught.exception))

    def test_a_5xx_with_an_empty_body_raises_too(self):
        # The one that spins: a gateway returning 502 and nothing else is the
        # shape most like a 204, and reading it as "nothing to do" would make
        # the worker re-claim as fast as the socket allows, forever. Only a 204
        # means nothing to do.
        desk, _ = client((502, b""))
        with self.assertRaises(RuntimeError) as caught:
            desk.claim()
        self.assertIn("502", str(caught.exception))


class OpenDraftTest(unittest.TestCase):
    """The draft id ``open_draft()`` hands back is checked the same way
    ``claim()``'s command id is.

    It flows straight into every other draft call as a URL path segment --
    ``/api/drafts/%s/news.json`` and the rest -- so this is `claim()`'s own
    precondition again: a desk behind a proxy that answers with something
    other than what the desk said is exactly the case that check was written
    for. Draft ids are ``uuid4().hex`` too, the same shape as command ids.
    """

    def test_a_malformed_draft_id_raises(self):
        for bad in ("../x", "abc", "", "0123456789abcdef",
                    "0123456789abcdef0123456789abcdeg",         # 32, but not hex
                    "0123456789ABCDEF0123456789ABCDEF"):        # uuid4().hex is lower
            desk, _ = client((200, json.dumps({"draft_id": bad}).encode()))
            with self.assertRaises(RuntimeError, msg=repr(bad)):
                desk.open_draft()

    def test_a_non_string_draft_id_raises(self):
        desk, _ = client((200, json.dumps({"draft_id": 12345}).encode()))
        with self.assertRaises(RuntimeError):
            desk.open_draft()

    def test_a_missing_draft_id_raises(self):
        desk, _ = client((200, json.dumps({"ok": True}).encode()))
        with self.assertRaises(RuntimeError):
            desk.open_draft()

    def test_the_token_never_reaches_the_message_of_a_malformed_draft_id(self):
        # Same shape as claim()'s equivalent case: a proxy that echoed the
        # request back into the draft_id it invented would put the bearer
        # token in the message, and from there into an operator's log.
        desk, _ = client((200, json.dumps(
            {"draft_id": "../" + TOKEN}).encode()))
        with self.assertRaises(RuntimeError) as caught:
            desk.open_draft()
        self.assertNotIn(TOKEN, str(caught.exception))


class RequestTest(unittest.TestCase):
    """What goes out on the wire."""

    def test_every_request_carries_the_bearer_token(self):
        desk, opener = client((200, ('{"draft_id":"%s"}' % CID).encode()),
                              (200, b"ok"), (200, b'{"ok":true}'))
        desk.open_draft()
        desk.put_payload("d", b"{}")
        desk.directives()
        self.assertEqual(len(opener.requests), 3)
        for req in opener.requests:
            # urllib capitalises header names it is given, so ask it the way it
            # stores them rather than by the name this code passed.
            self.assertEqual(req.get_header("Authorization"), "Bearer " + TOKEN)

    def test_the_base_url_is_joined_without_a_double_slash(self):
        desk, opener = client((200, ('{"draft_id":"%s"}' % CID).encode()))
        desk.open_draft()
        self.assertEqual(opener.requests[0].full_url, "http://desk:8080/api/drafts")

    def test_a_tile_goes_up_as_octet_stream(self):
        desk, opener = client((200, b"ok"))
        desk.put_tile("d", "hero", b"\x01\x02")
        self.assertEqual(opener.requests[0].get_header("Content-type"),
                         "application/octet-stream")

    def test_directives_are_a_list_and_a_failure_is_an_empty_one(self):
        desk, _ = client((200, json.dumps({"directives": [{"rule": "no TSLA"}]}).encode()))
        self.assertEqual(desk.directives(), [{"rule": "no TSLA"}])
        # Standing instructions are an enrichment, not a precondition: a desk
        # that cannot list them is not a reason to refuse to file.
        desk, _ = client((500, b"boom"))
        self.assertEqual(desk.directives(), [])

    def test_settings_come_back_as_the_desk_set_them(self):
        desk, opener = client((200, json.dumps(
            {"ok": True, "source": "file", "settings": {"lang": "ko"}}).encode()))
        self.assertEqual(desk.settings(), {"lang": "ko"})
        self.assertEqual(opener.requests[0].full_url, "http://desk:8080/api/settings")

    def test_a_desk_that_will_not_say_means_english(self):
        # The same stance as directives(): the language is an enrichment, not a
        # precondition. A desk too old to know the route, one that answered with
        # an envelope carrying no settings, and one that is simply down all file
        # an English page rather than no page.
        for answer in ((404, b'{"ok":false,"error":"not_found"}'),
                       (500, b"boom"),
                       (200, b'{"ok":true}'),
                       (200, b"")):
            desk, _ = client(answer)
            self.assertEqual(desk.settings(), {"lang": "en"}, answer)


class ErrorTest(unittest.TestCase):
    """What a failure says, and what it must never say."""

    def test_open_draft_carries_the_status(self):
        desk, _ = client((409, b'{"ok":false,"error":"draft_limit"}'))
        with self.assertRaises(RuntimeError) as caught:
            desk.open_draft()
        self.assertIn("409", str(caught.exception))
        self.assertIn("draft_limit", str(caught.exception))

    def test_a_bad_tile_names_the_tile(self):
        desk, _ = client((400, b'{"ok":false,"error":"bad_tile"}'))
        with self.assertRaises(RuntimeError) as caught:
            desk.put_tile("d", "hero", b"\x01")
        self.assertIn("hero", str(caught.exception))

    def test_the_token_never_reaches_the_message_of_an_unrunnable_claim(self):
        # The claim's own raise path, not the 4xx one below: a proxy that
        # echoed the request back would put the bearer token in the message,
        # and from there into POST /api/commands/<id>/fail and its audit log.
        desk, _ = client((200, b"<html>Bearer " + TOKEN.encode() + b"</html>"))
        with self.assertRaises(RuntimeError) as caught:
            desk.claim()
        self.assertNotIn(TOKEN, str(caught.exception))

    def test_the_token_never_reaches_an_exception_message(self):
        # A desk that echoed the Authorization header into its error body would
        # otherwise put the token straight into POST /api/commands/<id>/fail,
        # and from there into a log that outlives the token.
        echo = json.dumps({"ok": False, "error": "unauthorized",
                           "detail": "Bearer " + TOKEN}).encode()
        for call in (lambda d: d.open_draft(),
                     lambda d: d.put_payload("d", b"{}"),
                     lambda d: d.put_tile("d", "hero", b"\x01"),
                     lambda d: d.proof("d"),
                     lambda d: d.commit("d"),
                     lambda d: d.fetch_sheet("d", "A1.png"),
                     lambda d: d.claim()):
            desk, _ = client((401, echo))
            with self.assertRaises(RuntimeError) as caught:
                call(desk)
            self.assertNotIn(TOKEN, str(caught.exception))


class PutNotesTest(unittest.TestCase):
    """The dossier: a markdown note filed beside a draft or a command.

    ``put_notes`` takes exactly one of the two owners it can file against --
    naming both or neither is a programming error in the caller, not a desk
    answer, so it never reaches the wire. See ``docs/desk-server.md``'s
    dossier section for the two routes this fans out to.
    """

    def test_a_draft_note_goes_to_the_drafts_route(self):
        desk, opener = client((200, b'{"ok":true}'))
        desk.put_notes("why this company", draft=CID)
        req = opener.requests[0]
        self.assertEqual(req.full_url, "http://desk:8080/api/drafts/%s/notes.md" % CID)
        self.assertEqual(req.get_header("Content-type"), "text/markdown; charset=utf-8")
        self.assertEqual(req.data, b"why this company")

    def test_a_command_note_goes_to_the_commands_route(self):
        desk, opener = client((200, b'{"ok":true}'))
        desk.put_notes("what came of the instruction", command=CID)
        req = opener.requests[0]
        self.assertEqual(req.full_url, "http://desk:8080/api/commands/%s/notes.md" % CID)
        self.assertEqual(req.data, b"what came of the instruction")

    def test_naming_both_or_neither_is_a_programming_error(self):
        desk, opener = client()
        with self.assertRaises(ValueError):
            desk.put_notes("x")
        with self.assertRaises(ValueError):
            desk.put_notes("x", draft=CID, command=CID)
        # Neither malformed call should have reached the wire.
        self.assertEqual(opener.requests, [])

    def test_a_draft_id_that_is_not_one_never_becomes_a_path(self):
        # Same precondition claim() and open_draft() hold their ids to: this is
        # the line where a caller's mistake stops being a string and starts
        # being a path, so it must be caught before any request goes out.
        desk, opener = client()
        for bad in ("../..", "abc", "", "0123456789abcdef",
                    "0123456789abcdef0123456789abcdeg",         # 32, but not hex
                    "0123456789ABCDEF0123456789ABCDEF"):        # uuid4().hex is lower
            with self.assertRaises(ValueError, msg=repr(bad)):
                desk.put_notes("x", draft=bad)
        self.assertEqual(opener.requests, [])

    def test_a_note_longer_than_the_cap_is_cut_at_a_codepoint(self):
        # "가" is 3 bytes in utf-8, and 262144 is not a multiple of 3 -- a raw
        # byte slice at the cap lands mid-character. 100,000 of them is 300 KB.
        text = "가" * 100_000
        desk, opener = client((200, b'{"ok":true}'))
        desk.put_notes(text, draft=CID)
        body = opener.requests[0].data
        self.assertLessEqual(len(body), 262144)
        body.decode("utf-8")  # must not raise: no dangling partial sequence

    def test_a_refusal_carries_no_token(self):
        echo = json.dumps({"ok": False, "error": "unauthorized",
                           "detail": "Bearer " + TOKEN}).encode()
        desk, _ = client((401, echo))
        with self.assertRaises(RuntimeError) as caught:
            desk.put_notes("x", draft=CID)
        self.assertNotIn(TOKEN, str(caught.exception))


class SecretsTest(unittest.TestCase):
    """The two shapes a producer token arrives in."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)

    def write(self, name: str, text: str) -> None:
        with open(os.path.join(self.tmp, name), "w", encoding="utf-8") as f:
            f.write(text)

    def test_agent_env_is_preferred(self):
        # Two files can hold a token and they can disagree. agent.env is the one
        # a human edited last, so it wins.
        self.write("agent.env", 'ANTHROPIC_API_KEY=sk-x\nCLAUDEPOST_TOKEN="from-env"\n')
        self.write("tokens.json", json.dumps(
            {"tokens": [{"scope": "producer", "token": "from-json"}]}))
        self.assertEqual(deskclient.read_token(self.tmp), "from-env")

    def test_tokens_json_is_the_fallback(self):
        self.write("tokens.json", json.dumps(
            {"tokens": [{"scope": "operator", "token": "op"},
                        {"scope": "producer", "token": "from-json"}]}))
        self.assertEqual(deskclient.read_token(self.tmp), "from-json")

    def test_neither_is_a_hard_exit(self):
        # Not a retry loop: a worker that cannot authenticate will not start
        # being able to, and a container that exits is a container somebody sees.
        with self.assertRaises(SystemExit) as caught:
            deskclient.read_token(self.tmp)
        self.assertEqual(caught.exception.code, 2)

    def test_the_child_environment_excludes_the_desk_token(self):
        # The token authorises writing to the desk. The child process is a model
        # with a shell; it has no use for it and every reason not to see it.
        self.write("agent.env",
                   "# a comment\n\n"
                   "ANTHROPIC_API_KEY='sk-quoted'\n"
                   "CLAUDEPOST_TOKEN=secret\n"
                   "not a pair\n")
        env = deskclient.load_agent_env(self.tmp)
        self.assertEqual(env, {"ANTHROPIC_API_KEY": "sk-quoted"})

    def test_no_agent_env_is_an_empty_environment(self):
        self.assertEqual(deskclient.load_agent_env(self.tmp), {})


if __name__ == "__main__":
    unittest.main()
