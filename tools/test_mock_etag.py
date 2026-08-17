#!/usr/bin/env python3
"""The conditional-GET half of the news contract, held to its one hard rule.

    python3 tools/test_mock_etag.py

The board is going to sleep between polls, and the whole point of the ETag is
that a wake which changes nothing costs a Wi-Fi association and a 304 instead of
a payload transfer, a cJSON tree and a 32 KB struct fill. That is the saving.
It is NOT the decision: news_hash() remains the sole authority on whether the
panel moves, and nothing here is allowed to change that.

Which leaves exactly one way for this feature to do harm, and it is the reason
this file exists. A tag that moves when the payload has not moved tells the
board the edition changed. The board's answer to "the edition changed" is to
fetch, parse, and — if news_hash() agrees — spend twenty-five seconds flashing
the whole sheet. Compute the tag over the response BYTES rather than the payload
OBJECT and you have made json.dumps()'s ensure_ascii flag, and the insertion
order of a dict, into things that can wake a board on a wall. So the assertion
that matters most here is the dullest one: the tag is stable across repeated
requests for an unchanged payload.

Everything in here is stdlib, starts the real Handler on an ephemeral port, and
shuts it down again. Port 0 rather than 8123 because a developer with a server
already running is the normal state of this repo, and a test that fails because
of that teaches nothing.
"""

import contextlib
import http.client
import io
import json
import os
import sys
import threading
import unittest
from http.server import ThreadingHTTPServer
from unittest import mock as umock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import mock_news_server as srvmod  # noqa: E402


class EtagTest(unittest.TestCase):
    """Base: one real Handler on an ephemeral port, torn down afterwards."""

    def serve(self, live=False, etag_enabled=True):
        """Start the real Handler and return the port it landed on.

        The per-test subclass exists only to pin the class attributes without
        leaking them into the next test — it inherits every line of do_GET, so
        what is under test is the shipping handler and not a copy of it. Its own
        `state` dict matters for --live, whose tick counter would otherwise
        carry across tests.
        """
        handler = type("_PinnedHandler", (srvmod.Handler,), {
            "live": live,
            "etag_enabled": etag_enabled,
            "state": {"tick": 0},
            # The shipping handler logs every request to stderr, which is right
            # for a server somebody is watching and noise in a test run.
            "log_message": lambda *a, **k: None,
        })
        server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        server.daemon_threads = True
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()

        def stop():
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)

        self.addCleanup(stop)
        return server.server_address[1]

    def connect(self, port):
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
        self.addCleanup(conn.close)
        return conn

    def get(self, conn, path="/news.json", if_none_match=None):
        headers = {}
        if if_none_match is not None:
            headers["If-None-Match"] = if_none_match
        conn.request("GET", path, headers=headers)
        resp = conn.getresponse()
        body = resp.read()          # always drained, so the socket stays usable
        return resp, body


class TestTheTagItself(EtagTest):

    def test_a_plain_get_carries_an_etag(self):
        port = self.serve()
        conn = self.connect(port)
        resp, body = self.get(conn)

        self.assertEqual(resp.status, 200)
        etag = resp.getheader("ETag")
        self.assertIsNotNone(etag, "no ETag header")
        # Quoted, per RFC 7232. An unquoted tag is the classic version of this
        # bug: the client echoes back what it was given, some intermediary
        # quotes it, and the comparison never matches again — which fails as a
        # permanent 200, i.e. silently and expensively.
        self.assertTrue(etag.startswith('"') and etag.endswith('"'),
                        f"ETag is not a quoted-string: {etag!r}")
        self.assertEqual(len(etag), 18, f"expected 16 hex digits: {etag!r}")
        # And the payload is still the payload.
        self.assertEqual(json.loads(body), srvmod.snapshot())

    def test_the_tag_is_stable_across_requests(self):
        """The contract. A tag carrying a timestamp would pass every other test
        in this file and refresh the panel on every single poll."""
        port = self.serve()
        conn = self.connect(port)
        first, _ = self.get(conn)
        self.assertIsNotNone(first.getheader("ETag"), "no ETag header")
        tags = {first.getheader("ETag")}
        for _ in range(4):
            resp, _ = self.get(conn)
            tags.add(resp.getheader("ETag"))
        self.assertEqual(len(tags), 1, f"the tag moved on an unchanged payload: {tags}")

        # And it survives the connection, the process's memory of it, and a
        # fresh server: it is a function of the payload, nothing else.
        other_port = self.serve()
        other = self.connect(other_port)
        resp, _ = self.get(other)
        self.assertEqual(resp.getheader("ETag"), first.getheader("ETag"))

    def test_the_tag_is_computed_from_the_payload_not_the_bytes(self):
        """Formatting is not content.

        json.dumps()'s ensure_ascii and a dict's insertion order both change the
        bytes on the wire without changing a single thing the board draws. If
        either can move the tag, then a refactor of the serializer costs every
        deployed board a refresh.
        """
        port = self.serve()
        conn = self.connect(port)
        resp, _ = self.get(conn)

        payload = srvmod.snapshot()
        self.assertEqual(srvmod.Handler.etag_for(payload), resp.getheader("ETag"))

        # Same content, rebuilt with its keys in the opposite order.
        reordered = {k: payload[k] for k in reversed(list(payload))}
        self.assertNotEqual(list(reordered), list(payload))
        self.assertEqual(srvmod.Handler.etag_for(reordered),
                         srvmod.Handler.etag_for(payload))

        # A real change, however small, must move it — otherwise the tag is
        # stable for the wrong reason.
        changed = srvmod.snapshot()
        changed["dateline"] = changed["dateline"] + "."
        self.assertNotEqual(srvmod.Handler.etag_for(changed),
                            srvmod.Handler.etag_for(payload))


class TestConditionalGet(EtagTest):

    def test_a_matching_if_none_match_is_a_304_with_no_body(self):
        port = self.serve()
        conn = self.connect(port)
        first, _ = self.get(conn)
        etag = first.getheader("ETag")

        resp, body = self.get(conn, if_none_match=etag)
        self.assertEqual(resp.status, 304)
        self.assertEqual(resp.getheader("Content-Length"), "0")
        self.assertEqual(resp.getheader("Connection"), "keep-alive")
        self.assertEqual(body, b"")
        # RFC 7232 asks for the tag on the 304 too; a device that stores what
        # the last response carried must not be handed an empty one.
        self.assertIn(resp.getheader("ETag"), (None, etag))

    def test_a_304_writes_nothing_the_next_response_has_to_step_over(self):
        """Reusing the socket is the assertion. A stray body on a keep-alive
        connection does not fail here, it desynchronises the stream and turns
        the NEXT poll into a parse error — a failure that looks like a bad
        payload and is nothing of the sort."""
        port = self.serve()
        conn = self.connect(port)
        first, _ = self.get(conn)
        etag = first.getheader("ETag")

        skipped, _ = self.get(conn, if_none_match=etag)
        self.assertEqual(skipped.status, 304)
        resp, body = self.get(conn)
        self.assertEqual(resp.status, 200)
        self.assertEqual(json.loads(body), srvmod.snapshot())

    def test_a_stale_if_none_match_gets_the_whole_payload(self):
        port = self.serve()
        conn = self.connect(port)
        resp, body = self.get(conn, if_none_match='"something-else"')
        self.assertEqual(resp.status, 200)
        self.assertEqual(json.loads(body), srvmod.snapshot())
        self.assertIsNotNone(resp.getheader("ETag"))

    def test_live_moves_the_tag_exactly_when_the_payload_moves(self):
        """--live nudges the prices on every request, which is the only way to
        watch a tag change without editing the file."""
        port = self.serve(live=True)
        conn = self.connect(port)

        seen = []
        for _ in range(6):
            resp, body = self.get(conn)
            self.assertEqual(resp.status, 200)
            seen.append((body, resp.getheader("ETag")))

        # The biconditional, over every pair: same payload, same tag; different
        # payload, different tag. Asserted rather than assumed, because the
        # drift is random and either half failing is a different bug.
        for i, (body_i, tag_i) in enumerate(seen):
            for body_j, tag_j in seen[i + 1:]:
                self.assertEqual(body_i == body_j, tag_i == tag_j,
                                 "the tag and the payload disagree about whether "
                                 "anything changed")
        self.assertGreater(len({t for _, t in seen}), 1,
                           "--live served six identical payloads")


class TestTheServerWithoutEtags(EtagTest):

    def test_the_default_is_on(self):
        self.assertIs(srvmod.Handler.etag_enabled, True)

    def test_no_etag_sends_none_and_ignores_the_request_header(self):
        """A board pointed at a server with no conditional-GET support is a
        supported configuration, not a degraded one: it fetches and parses every
        poll, and news_hash() still keeps the panel still. This is that server,
        on purpose, so the path gets exercised before somebody's static file
        host exercises it for them."""
        port = self.serve(etag_enabled=False)
        conn = self.connect(port)

        resp, body = self.get(conn)
        self.assertEqual(resp.status, 200)
        self.assertIsNone(resp.getheader("ETag"))
        self.assertEqual(json.loads(body), srvmod.snapshot())

        # A tag left over from a server that did support them must not produce a
        # 304 from one that does not.
        resp, body = self.get(conn, if_none_match=srvmod.Handler.etag_for(srvmod.snapshot()))
        self.assertEqual(resp.status, 200)
        self.assertEqual(json.loads(body), srvmod.snapshot())

    def test_the_flag_reaches_the_handler(self):
        """--no-etag is wiring, and wiring is what silently does not exist.

        main() is run with a stand-in for ThreadingHTTPServer so nothing binds a
        port; the flag's whole job is the class attribute it sets on the way
        past.
        """
        was = srvmod.Handler.etag_enabled
        self.addCleanup(setattr, srvmod.Handler, "etag_enabled", was)

        class _FakeServer:
            def __init__(self, addr, handler):
                pass

            def serve_forever(self):
                raise KeyboardInterrupt      # main() treats this as "stopped"

        for argv, expected in ((["--no-etag"], False), ([], True)):
            srvmod.Handler.etag_enabled = None
            with umock.patch.object(srvmod, "ThreadingHTTPServer", _FakeServer), \
                 umock.patch.object(sys, "argv", ["mock_news_server.py"] + argv), \
                 contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(srvmod.main(), 0)
            self.assertIs(srvmod.Handler.etag_enabled, expected,
                          f"argv {argv} left etag_enabled={srvmod.Handler.etag_enabled}")


class TestTheTilesAreUnaffected(EtagTest):
    """The photographs go over the same handler and are not part of this. A tile
    is immutable under its id by contract, the board caches one at a time, and a
    conditional GET for it would save nothing it does not already save."""

    TILE = "sndk_wafer"

    def test_a_tile_is_served_unconditionally(self):
        port = self.serve()
        conn = self.connect(port)
        resp, body = self.get(conn, path=f"/tiles/{self.TILE}.bin")

        self.assertEqual(resp.status, 200)
        self.assertEqual(resp.getheader("Content-Type"), "application/octet-stream")
        self.assertIsNone(resp.getheader("ETag"))
        with open(os.path.join(srvmod.SIM_TILES, self.TILE + ".bin"), "rb") as f:
            self.assertEqual(body, f.read())

    def test_a_tile_ignores_if_none_match(self):
        port = self.serve()
        conn = self.connect(port)
        news, _ = self.get(conn)
        resp, body = self.get(conn, path=f"/tiles/{self.TILE}.bin",
                              if_none_match=news.getheader("ETag"))
        self.assertEqual(resp.status, 200)
        self.assertGreater(len(body), 0)

    def test_an_unknown_tile_is_still_a_404(self):
        port = self.serve()
        conn = self.connect(port)
        resp, _ = self.get(conn, path="/tiles/no_such_tile.bin")
        self.assertEqual(resp.status, 404)


if __name__ == "__main__":
    unittest.main(verbosity=2)
