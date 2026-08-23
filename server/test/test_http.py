"""The two planes, the scheduler tick, and the property the device plane exists to have.

Every test here runs a real :class:`~claudepost.http.DeskServer` on a loopback port
and talks to it with ``urllib``. That is slower than calling the handlers
directly and it is the point: the thing being asserted is what a board or an
agent gets from a socket, and a test that called ``_device()`` in-process could
not catch a routing table that never reaches it.

The gates are stubbed, so nothing here shells out to cmake or the network.
``server/test/smoke.sh`` is where the real validator and the real typesetter are
exercised.
"""

from __future__ import annotations

import json
import os
import shutil
import socket
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from unittest import mock

from claudepost import schedule as S
from claudepost.app import Config, Desk
from claudepost.clock import FixedClock
from claudepost.gates import GateResult, StubGates
from claudepost.http import MAX_CONTROL_BODY, DeskHTTPRequestHandler, make_server

from test_schedule import at

PAYLOAD = json.dumps({
    "edition": "SEMICONDUCTORS",
    "subject": {"symbol": "SNDK", "name": "Sandisk Corp."},
    "stories": [{"rank": 0, "headline": "A headline long enough to be a headline",
                 "body": "MILPITAS — copy."}],
}).encode()

TILE = bytes(range(256)) * 4          # 1,024 bytes; the desk does not inspect content

#: A full sheet, which is the largest response this desk can be asked for. Its
#: size is the point: it is more than the kernel will hold for a client that
#: has stopped reading, so a write to one really does block.
BIG_TILE = bytes(range(256)) * 3750   # 960,000 bytes == tiles.MAX_TILE_BYTES


def write_tokens(path: str) -> dict:
    """Two tokens, one of each scope, in the file the desk reads.

    Both are padded past ``auth.MIN_TOKEN_CHARS``. A shorter one is refused as
    the file is read, which is a refusal in the desk's constructor and
    therefore an error in every test in this module at once -- so the padding
    is load-bearing rather than decorative.
    """
    doc = {"tokens": [{"name": "agent", "scope": "producer",
                       "token": "prod-token-aaaaaaaa"},
                      {"name": "me", "scope": "operator",
                       "token": "oper-token-bbbbbbbb"}]}
    with open(path, "w", encoding="utf-8") as f:
        json.dump(doc, f)
    # Read back off the document rather than repeated, so the map a test
    # authenticates with cannot drift from the file the desk parsed.
    return {t["scope"]: t["token"] for t in doc["tokens"]}


class SheetGates(StubGates):
    """A stub that leaves proof sheets on disk, like the render gate does.

    One of each suffix, because that is what the real gate advertises: `sips`
    on a Mac and the desk's own converter leave PNGs, and a render that failed
    before conversion leaves the BMPs -- which is exactly the run whose sheets
    somebody wants to look at.
    """

    def render(self, draft_dir, out_dir):
        self.calls.append("render")
        os.makedirs(out_dir, exist_ok=True)
        for name, magic in (("A1.png", b"\x89PNG\r\n\x1a\n"), ("A2.bmp", b"BM")):
            with open(os.path.join(out_dir, name), "wb") as f:
                f.write(magic)
        return GateResult(ok=self.render_ok, output=self.output,
                          sheets=("A1.png", "A2.bmp"))


class DeskTestCase(unittest.TestCase):
    """A desk on a loopback port, with stub gates and a clock the test drives."""

    START = at(2026, 8, 19, 9, 0)          # a Wednesday morning, outside quiet hours

    #: The gates this case runs on. Overridden by the one class that needs
    #: sheets on disk rather than a gate that touches none.
    GATES = StubGates

    #: The socket timeout the server under test runs on, or ``None`` for the
    #: one the desk ships with -- which is what every case here wants, because
    #: a test pinned to a constant stops testing the number in production the
    #: day somebody changes it. ``SocketTimeoutTest`` sets a short one, so that
    #: asserting a stalled connection is released costs half a second rather
    #: than two minutes.
    TIMEOUT = None

    def setUp(self):
        self.root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.root, True)

        data = os.path.join(self.root, "data")
        os.makedirs(data)
        tokens_path = os.path.join(self.root, "tokens.json")
        self.tokens = write_tokens(tokens_path)

        self.clock = FixedClock(self.START)
        self.gates = self.GATES(sheets=())
        self.cfg = Config(data_dir=data, tokens_path=tokens_path,
                          repo_dir=self.root, host="127.0.0.1", port=0)
        self.desk = Desk(self.cfg, clock=self.clock, gates=self.gates)
        self.addCleanup(self.desk.close)

        override = {} if self.TIMEOUT is None else {"timeout": self.TIMEOUT}
        self.server = make_server(self.desk, "127.0.0.1", 0, **override)
        self.addCleanup(self.server.server_close)
        self.base = "http://127.0.0.1:%d" % self.server.server_address[1]
        thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(self.server.shutdown)

        # The publish policy this module runs on, and the reason it is set at
        # all: DEFAULT_SCHEDULE is `on_wake`, under which a commit at nine in
        # the morning stages and waits for the 12:40 wake. Every test here that
        # files an edition and then reads /news.json was asking for a publish
        # the calendar forbids -- which is a fault in the fixture, not in the
        # desk, and `test_editions.OnWakeTest` holds the desk to the other
        # behaviour.
        #
        # Through the API rather than onto `desk.schedule`, because that is
        # the path an operator has and the only one that writes the file a
        # restart reads. The classes that are about the calendar PUT their own
        # schedule over this one.
        doc = S.schedule_to_dict(S.DEFAULT_SCHEDULE)
        doc["publish"] = {"policy": "immediate", "min_gap_minutes": 0}
        status, body = self.api("PUT", "/api/schedule", doc)
        self.assertEqual(status, 200, body)

    # -- a tiny client ----------------------------------------------------
    def call(self, method, path, body=None, token=None, ctype="application/json",
             headers=None):
        """Returns ``(status, bytes, headers)``. Never raises for a 4xx -- those are answers.

        ``headers`` is the request headers a case sends deliberately, and
        ``If-None-Match`` is the whole reason it exists. They go on after the
        ones this helper sets, so a case that wants a different
        ``Content-Type`` than the argument gives it can simply say so.
        """
        req = urllib.request.Request(self.base + path, data=body, method=method)
        if token:
            req.add_header("Authorization", "Bearer " + token)
        if body is not None:
            req.add_header("Content-Type", ctype)
        for name, value in (headers or {}).items():
            req.add_header(name, value)
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                return resp.status, resp.read(), dict(resp.headers)
        except urllib.error.HTTPError as e:
            return e.code, e.read(), dict(e.headers)

    def api(self, method, path, doc=None, scope="operator"):
        body = json.dumps(doc).encode() if doc is not None else None
        status, raw, _ = self.call(method, path, body, self.tokens[scope])
        return status, (json.loads(raw) if raw else None)

    def file_edition(self, payload=PAYLOAD, tile_id="pic", scope="producer", tile=TILE):
        """Push one edition all the way through, returning the commit document."""
        status, doc = self.api("POST", "/api/drafts", {}, scope)
        self.assertEqual(status, 200, doc)
        draft = doc["draft_id"]

        status, _, _ = self.call("PUT", "/api/drafts/%s/news.json" % draft, payload,
                                 self.tokens[scope])
        self.assertEqual(status, 200)
        if tile_id:
            status, _, _ = self.call("PUT", "/api/drafts/%s/tiles/%s.bin" % (draft, tile_id),
                                     tile, self.tokens[scope], "application/octet-stream")
            self.assertEqual(status, 200)

        status, report = self.api("POST", "/api/drafts/%s/proof" % draft, {}, scope)
        self.assertEqual(status, 200, report)
        self.assertTrue(report["ok"], report)

        status, result = self.api("POST", "/api/drafts/%s/commit" % draft, {}, scope)
        self.assertEqual(status, 200, result)
        return result


class DevicePlaneTest(DeskTestCase):
    """What a board can reach, and the much longer list of what it cannot."""

    def test_nothing_but_the_edition_and_its_tiles_is_reachable(self):
        # This is docs/hosting-cloudflare.md's
        # `find agent/standalone/public -type f` made executable. Every one of
        # these is a real file or a real endpoint somewhere in this system, and
        # none of them is on this plane.
        for path in ("/", "/index.html", "/schedule.json", "/desk.sqlite",
                     "/data/desk.sqlite", "/editions", "/editions/",
                     "/log/2026-08-19.json", "/tiles/", "/tiles/pic",
                     "/tiles/pic.bin.bak",
                     "/../etc/passwd", "/tiles/../news.json"):
            status, _, _ = self.call("GET", path)
            self.assertIn(status, (400, 404), "%s answered %d" % (path, status))

        # /api is a control-plane path by the router's own say-so, and the
        # control plane authenticates before it matches a route -- so an
        # anonymous caller is refused without learning which routes exist. That
        # is 401 rather than 404, and asserting the 401 is what makes this test
        # say the thing the code means.
        self.assertEqual(self.call("GET", "/api")[0], 401)

    def test_the_control_plane_is_not_reachable_without_a_token(self):
        for path in ("/api/state", "/api/schedule", "/api/commands", "/api/editions"):
            status, raw, _ = self.call("GET", path)
            self.assertEqual(status, 401, path)
            self.assertEqual(json.loads(raw)["error"], "unauthorized")

    def test_only_get_and_head_are_allowed(self):
        for method in ("POST", "PUT", "DELETE"):
            status, _, headers = self.call(method, "/news.json", b"{}")
            self.assertEqual(status, 405, method)
            self.assertIn("GET", headers.get("Allow", ""))

    def test_healthz_needs_no_token(self):
        status, raw, _ = self.call("GET", "/healthz")
        self.assertEqual(status, 200)
        self.assertTrue(json.loads(raw)["ok"])

    def test_before_anything_is_filed_there_is_no_edition(self):
        status, raw, _ = self.call("GET", "/news.json")
        self.assertEqual(status, 404)
        self.assertEqual(json.loads(raw)["error"], "not_found")

    def test_after_a_publish_the_edition_is_served_with_a_policy_block(self):
        self.file_edition()
        status, raw, headers = self.call("GET", "/news.json")
        self.assertEqual(status, 200)
        served = json.loads(raw)

        block = served.pop("policy")
        self.assertEqual(served, json.loads(PAYLOAD))
        self.assertIsInstance(block["poll_seconds"], int)
        self.assertIsInstance(block["next_change"], int)
        self.assertEqual(headers["Content-Type"], "application/json")

    def test_the_served_policy_follows_the_clock_into_a_quiet_window(self):
        self.file_edition()
        active = json.loads(self.call("GET", "/news.json")[1])["policy"]["poll_seconds"]

        self.clock.set(at(2026, 8, 20, 1, 0))          # inside 00:30-06:00
        quiet = json.loads(self.call("GET", "/news.json")[1])["policy"]["poll_seconds"]

        self.assertEqual(active, S.DEFAULT_SCHEDULE.poll_active_seconds)
        self.assertEqual(quiet, S.DEFAULT_SCHEDULE.poll_quiet_seconds)

    def test_a_tile_comes_back_byte_for_byte(self):
        self.file_edition(tile_id="pic")
        status, raw, headers = self.call("GET", "/tiles/pic.bin")
        self.assertEqual(status, 200)
        self.assertEqual(raw, TILE)
        self.assertEqual(headers["Content-Type"], "application/octet-stream")

    def test_a_tile_nobody_filed_is_an_ordinary_condition(self):
        self.file_edition(tile_id="pic")
        self.assertEqual(self.call("GET", "/tiles/other.bin")[0], 404)

    def test_head_returns_the_headers_and_no_body(self):
        self.file_edition()
        status, raw, headers = self.call("HEAD", "/news.json")
        self.assertEqual(status, 200)
        self.assertEqual(raw, b"")
        self.assertGreater(int(headers["Content-Length"]), 0)


class ConditionalGetTest(DeskTestCase):
    """The board asks whether the edition moved, and most of the time it has not.

    A board on the default schedule asks ninety-six times a day and the answer
    changes three or four times, so the ordinary poll is a full edition
    downloaded to learn nothing. The tag is computed over the EXACT bytes about
    to be written -- the policy block spliced in and all -- which is what makes
    it safe to answer 304 on a match and what makes it move at a schedule
    transition, where the cadence in those bytes is the one thing the board
    must not miss.
    """

    def tag_of(self, path="/news.json", **kwargs):
        """The current validator for a path, and a 200 asserted on the way past."""
        status, _raw, headers = self.call("GET", path, **kwargs)
        self.assertEqual(status, 200)
        return headers["ETag"]

    def test_the_edition_carries_a_strong_etag(self):
        self.file_edition()
        status, _raw, headers = self.call("GET", "/news.json")
        self.assertEqual(status, 200)
        # Strong and quoted: sixteen hex digits inside quotation marks, which
        # is the recipe tools/mock_news_server.py serves too. A `W/` here would
        # say the bytes may differ, and they may not -- the tag is over them.
        self.assertRegex(headers["ETag"], r'^"[0-9a-f]{16}"$')
        self.assertFalse(headers["ETag"].startswith("W/"), headers["ETag"])

    def test_the_tag_is_stable_across_requests(self):
        self.file_edition()
        tags, bodies = set(), set()
        for _ in range(5):
            status, raw, headers = self.call("GET", "/news.json")
            self.assertEqual(status, 200)
            tags.add(headers["ETag"])
            bodies.add(raw)
        # One tag for one edition. A tag that hashed anything clock-shaped
        # would come back five different answers here and every poll would be
        # a full transfer, with nothing in any log to say why.
        self.assertEqual(len(tags), 1, tags)
        self.assertEqual(len(bodies), 1)

    def test_a_matching_if_none_match_is_a_304_with_no_body(self):
        self.file_edition()
        tag = self.tag_of()
        status, raw, headers = self.call("GET", "/news.json",
                                         headers={"If-None-Match": tag})
        self.assertEqual(status, 304)
        self.assertEqual(raw, b"")
        self.assertEqual(headers["Content-Length"], "0")
        self.assertEqual(headers["ETag"], tag)

    def test_a_stale_tag_gets_the_whole_edition(self):
        self.file_edition()
        _status, body, headers = self.call("GET", "/news.json")
        status, raw, again = self.call(
            "GET", "/news.json", headers={"If-None-Match": '"0000000000000000"'})
        self.assertEqual(status, 200)
        self.assertEqual(raw, body)
        self.assertEqual(again["ETag"], headers["ETag"])

    def test_the_tag_moves_when_the_edition_moves(self):
        self.file_edition()
        first = self.tag_of()

        self.file_edition(payload=json.dumps({
            "edition": "SEMICONDUCTORS",
            "subject": {"symbol": "SNDK", "name": "Sandisk Corp."},
            "stories": [{"rank": 0, "headline": "A second day, and a second lead",
                         "body": "MILPITAS - more copy."}],
        }).encode())
        second = self.tag_of()
        self.assertNotEqual(first, second)

        # And the board holding yesterday's tag is told so, rather than being
        # left with yesterday's front page because a validator went stale
        # quietly.
        status, raw, _headers = self.call("GET", "/news.json",
                                          headers={"If-None-Match": first})
        self.assertEqual(status, 200)
        self.assertIn(b"A second day", raw)

    def test_the_tag_moves_across_a_schedule_transition(self):
        self.file_edition()
        active = self.tag_of()

        self.clock.set(at(2026, 8, 20, 1, 0))          # inside 00:30-06:00
        status, raw, headers = self.call("GET", "/news.json",
                                         headers={"If-None-Match": active})
        # The cadence is IN the bytes, so the transition is a 200 and the board
        # learns the quiet interval. This is the mechanism a sleeping board's
        # whole schedule rests on: a 304 here would leave it polling at the
        # active rate all night.
        self.assertEqual(status, 200)
        self.assertNotEqual(headers["ETag"], active)
        self.assertEqual(json.loads(raw)["policy"]["poll_seconds"],
                         S.DEFAULT_SCHEDULE.poll_quiet_seconds)

    def test_the_tag_does_not_flap_inside_a_window(self):
        self.file_edition()

        def tag_at(*when):
            self.clock.set(at(*when))
            return self.tag_of()

        # Both of these are inside the quiet window, and both look forward to
        # the same 06:00 transition, so the bytes are identical -- this is the
        # test that catches somebody hashing time.time() instead of the body.
        self.assertEqual(tag_at(2026, 8, 20, 1, 0), tag_at(2026, 8, 20, 5, 59))
        self.assertNotEqual(tag_at(2026, 8, 20, 5, 59), tag_at(2026, 8, 20, 6, 1))

    def test_head_answers_the_same_tag_and_a_304(self):
        self.file_edition()
        status, raw, headers = self.call("HEAD", "/news.json")
        self.assertEqual(status, 200)
        self.assertEqual(raw, b"")
        tag = headers["ETag"]
        self.assertEqual(tag, self.tag_of())

        status, raw, headers = self.call("HEAD", "/news.json",
                                         headers={"If-None-Match": tag})
        self.assertEqual(status, 304)
        self.assertEqual(raw, b"")
        self.assertEqual(headers["Content-Length"], "0")
        self.assertEqual(headers["ETag"], tag)

    def test_a_comma_separated_list_matches(self):
        self.file_edition()
        tag = self.tag_of()
        # A list, with one entry that is this tag weakened by something in
        # between and one that is not this tag at all. A parser that compared
        # the whole header string answers 200 to every one of these.
        for header in ('"aaa", %s, W/"bbb"' % tag,
                       '%s,"aaa"' % tag,
                       'W/%s' % tag,
                       "*"):
            status, raw, _headers = self.call("GET", "/news.json",
                                              headers={"If-None-Match": header})
            self.assertEqual(status, 304, header)
            self.assertEqual(raw, b"", header)

    def test_cache_control_is_no_cache(self):
        # This is what "no cache headers reach the board" became. The point has
        # not changed -- a cache between the desk and the board is a stale front
        # page nobody can explain from across a room -- but it is now carried by
        # a validator instead of by silence: `no-cache` is not "do not store",
        # it is "do not serve this without asking me first", which is the
        # board's own behaviour said out loud to whatever is in between. A
        # freshness lifetime is still the thing that must never appear.
        self.file_edition()
        _status, _raw, headers = self.call("GET", "/news.json")
        self.assertEqual(headers["Cache-Control"], "no-cache")

        status, _raw, on_304 = self.call("GET", "/news.json",
                                         headers={"If-None-Match": headers["ETag"]})
        self.assertEqual(status, 304)
        self.assertEqual(on_304["Cache-Control"], "no-cache")

        for header in ("Last-Modified", "Expires"):
            self.assertNotIn(header, headers)
            self.assertNotIn(header, on_304)

        # And nothing else on this plane grew one along with it: the validator
        # is the edition's, passed by its handler, not something `_send_bytes`
        # hangs on everything it writes.
        _status, _raw, healthz = self.call("GET", "/healthz")
        for header in ("ETag", "Cache-Control"):
            self.assertNotIn(header, healthz)

    def test_tiles_are_unconditional(self):
        # A tile is immutable by id -- a new picture is a new id in a new
        # edition -- so there is nothing for a validator to validate, and the
        # board fetches one only when the edition it arrived with is new.
        self.file_edition(tile_id="pic")
        status, raw, headers = self.call("GET", "/tiles/pic.bin")
        self.assertEqual(status, 200)
        self.assertNotIn("ETag", headers)
        self.assertNotIn("Cache-Control", headers)

        status, raw, _headers = self.call(
            "GET", "/tiles/pic.bin", headers={"If-None-Match": '"0000000000000000"'})
        self.assertEqual(status, 200)
        self.assertEqual(raw, TILE)


class SheetTest(DeskTestCase):
    """The sheets the worker fetches back so that somebody looks at the paper."""

    GATES = SheetGates

    def proofed_draft(self) -> str:
        """A draft that has been through the gates, with its sheets on disk."""
        status, doc = self.api("POST", "/api/drafts", {}, "producer")
        self.assertEqual(status, 200, doc)
        draft = doc["draft_id"]
        status, _, _ = self.call("PUT", "/api/drafts/%s/news.json" % draft, PAYLOAD,
                                 self.tokens["producer"])
        self.assertEqual(status, 200)
        status, report = self.api("POST", "/api/drafts/%s/proof" % draft, {}, "producer")
        self.assertEqual(status, 200, report)
        self.assertEqual(report["sheets"], ["A1.png", "A2.bmp"])
        return draft

    def sheet(self, draft: str, name: str):
        return self.call("GET", "/api/drafts/%s/proof/%s" % (draft, name),
                         token=self.tokens["producer"])

    def test_a_sheet_is_served_as_the_picture_its_suffix_says_it_is(self):
        # The gate advertises .bmp as well as .png, and a route that knew only
        # PNG refused exactly the sheets that matter: the ones a render left
        # behind when it failed before conversion.
        draft = self.proofed_draft()

        status, raw, headers = self.sheet(draft, "A1.png")
        self.assertEqual(status, 200, raw)
        self.assertEqual(headers["Content-Type"], "image/png")
        self.assertEqual(raw[:4], b"\x89PNG")

        status, raw, headers = self.sheet(draft, "A2.bmp")
        self.assertEqual(status, 200, raw)
        self.assertEqual(headers["Content-Type"], "image/bmp")
        self.assertEqual(raw[:2], b"BM")

    def test_a_name_that_is_not_a_sheet_is_still_refused(self):
        # The suffix is part of the rule, not decoration: the name becomes a
        # path component under the draft's proof directory.
        draft = self.proofed_draft()
        for bad in ("A1.txt", "..", "A1.png.bak", "A1"):
            self.assertEqual(self.sheet(draft, bad)[0], 400, bad)


class ScopeTest(DeskTestCase):
    def test_an_unknown_token_is_refused(self):
        status, raw, _ = self.call("GET", "/api/state", token="not-a-token")
        self.assertEqual(status, 401)
        self.assertEqual(json.loads(raw)["error"], "unauthorized")

    def test_a_producer_may_not_change_the_schedule(self):
        doc = S.schedule_to_dict(S.DEFAULT_SCHEDULE)
        status, body = self.api("PUT", "/api/schedule", doc, scope="producer")
        self.assertEqual(status, 403)
        self.assertEqual(body["error"], "forbidden")

    def test_an_operator_may(self):
        doc = S.schedule_to_dict(S.DEFAULT_SCHEDULE)
        doc["wake"] = ["07:30"]
        status, body = self.api("PUT", "/api/schedule", doc, scope="operator")
        self.assertEqual(status, 200, body)
        self.assertEqual(body["schedule"]["wake"], ["07:30"])

    def test_a_producer_may_push_an_edition_and_ask_for_work(self):
        self.file_edition(scope="producer")
        status, _ = self.api("POST", "/api/commands",
                             {"kind": "research", "text": "look into NVDA"}, "producer")
        self.assertEqual(status, 200)

    def test_a_producer_may_not_force_a_publish_or_edit_the_directives(self):
        self.assertEqual(self.api("POST", "/api/publish", {}, "producer")[0], 403)
        self.assertEqual(
            self.api("POST", "/api/directives", {"rule": "never TSLA"}, "producer")[0], 403)


class ControlPlaneTest(DeskTestCase):
    def test_an_oversized_body_is_refused_from_the_header_alone(self):
        status, doc = self.api("POST", "/api/drafts", {})
        draft = doc["draft_id"]
        huge = b"x" * (300 * 1024 + 1)
        status, raw, _ = self.call("PUT", "/api/drafts/%s/news.json" % draft, huge,
                                   self.tokens["producer"])
        self.assertEqual(status, 413)
        self.assertEqual(json.loads(raw)["error"], "too_large")

    def test_malformed_json_is_bad_json_and_not_a_crash(self):
        status, raw, _ = self.call("POST", "/api/commands", b"{not json",
                                   self.tokens["operator"])
        self.assertEqual(status, 400)
        self.assertEqual(json.loads(raw)["error"], "bad_json")

    def test_a_command_without_text_is_refused(self):
        self.assertEqual(self.api("POST", "/api/commands", {"kind": "custom"})[0], 400)

    def test_a_command_is_claimed_once_and_then_the_queue_is_empty(self):
        self.api("POST", "/api/commands", {"kind": "research", "text": "look into NVDA"})

        status, first = self.api("GET", "/api/commands/next?wait=0", scope="producer")
        self.assertEqual(status, 200)
        self.assertEqual(first["text"], "look into NVDA")

        status, _ = self.api("GET", "/api/commands/next?wait=0", scope="producer")
        self.assertEqual(status, 204)

    def test_a_claim_waits_and_then_returns_the_command_that_arrived(self):
        # The long poll is parked on a condition the enqueue path notifies, so
        # this must come back promptly rather than after the full wait.
        result = {}

        def claim():
            result["value"] = self.api("GET", "/api/commands/next?wait=20", scope="producer")

        thread = threading.Thread(target=claim)
        thread.start()
        # Give the claim a moment to park before the command lands.
        threading.Event().wait(0.3)
        self.api("POST", "/api/commands", {"kind": "custom", "text": "now"})
        thread.join(timeout=25)

        self.assertFalse(thread.is_alive(), "the claim never returned")
        status, doc = result["value"]
        self.assertEqual(status, 200)
        self.assertEqual(doc["text"], "now")

    def test_finishing_a_command_records_the_result(self):
        self.api("POST", "/api/commands", {"kind": "custom", "text": "x"})
        _, claimed = self.api("GET", "/api/commands/next?wait=0", scope="producer")
        status, doc = self.api("POST", "/api/commands/%s/done" % claimed["id"],
                               {"result": "filed"}, "producer")
        self.assertEqual(status, 200, doc)
        self.assertEqual(doc["command"]["status"], "done")

    def test_directives_are_listed_and_removed(self):
        status, doc = self.api("POST", "/api/directives", {"rule": "Never print TSLA."})
        self.assertEqual(status, 200, doc)
        did = doc["directive"]["id"]

        _, listed = self.api("GET", "/api/directives")
        self.assertEqual([d["rule"] for d in listed["directives"]], ["Never print TSLA."])

        self.assertEqual(self.api("DELETE", "/api/directives/%s" % did)[0], 200)
        _, listed = self.api("GET", "/api/directives")
        self.assertEqual(listed["directives"], [])

    def test_an_invalid_schedule_is_rejected_whole(self):
        doc = S.schedule_to_dict(S.DEFAULT_SCHEDULE)
        doc["poll"]["active_seconds"] = 5              # below the device's own floor
        status, body = self.api("PUT", "/api/schedule", doc)
        self.assertEqual(status, 400)

        _, current = self.api("GET", "/api/schedule")
        self.assertEqual(current["schedule"]["poll"]["active_seconds"],
                         S.DEFAULT_SCHEDULE.poll_active_seconds)

    def test_an_edited_schedule_survives_a_restart(self):
        # The point of the file: the desk that comes up tomorrow is the one
        # that was told what to do today. A schedule held only in memory would
        # revert to the default on every `docker compose up`, silently, and the
        # symptom would be a paper arriving at the wrong hour.
        doc = S.schedule_to_dict(S.DEFAULT_SCHEDULE)
        doc["publish"] = {"policy": "immediate", "min_gap_minutes": 45}
        status, body = self.api("PUT", "/api/schedule", doc)
        self.assertEqual(status, 200, body)
        self.assertEqual(body["source"], "file")

        path = os.path.join(self.cfg.data_dir, "schedule.json")
        self.assertTrue(os.path.exists(path), path)

        second = Desk(self.cfg, clock=self.clock, gates=self.gates)
        self.addCleanup(second.close)
        self.assertEqual(second.schedule_source, "file")
        self.assertEqual(second.schedule.min_gap_minutes, 45)

    def test_schedule_next_lists_transitions_in_both_clocks(self):
        status, doc = self.api("GET", "/api/schedule/next?count=4")
        self.assertEqual(status, 200)
        rows = doc["transitions"]
        self.assertEqual(len(rows), 4)
        self.assertEqual([r["at"] for r in rows], sorted(r["at"] for r in rows))
        self.assertTrue(rows[0]["utc"].endswith("Z"))

    def test_state_reports_what_the_desk_is_doing(self):
        self.file_edition()
        status, doc = self.api("GET", "/api/state")
        self.assertEqual(status, 200)
        self.assertNotIn("vault", doc)
        self.assertIsNotNone(doc["current"])
        self.assertIn(doc["scheduleSource"], ("file", "default"))
        self.assertIsInstance(doc["policy"]["pollSeconds"], int)

    def test_an_unknown_api_route_is_not_found_rather_than_a_crash(self):
        self.assertEqual(self.api("GET", "/api/nonsense")[0], 404)

    def test_a_wrong_method_on_a_real_route_says_which_are_allowed(self):
        status, _, headers = self.call("DELETE", "/api/schedule", None,
                                       self.tokens["operator"])
        self.assertEqual(status, 405)
        self.assertIn("PUT", headers.get("Allow", ""))


class PublishGatingTest(DeskTestCase):
    """When a page may reach the glass, which is most of what the desk decides."""

    def _set(self, **changes):
        doc = S.schedule_to_dict(S.DEFAULT_SCHEDULE)
        doc.update(changes)
        status, body = self.api("PUT", "/api/schedule", doc)
        self.assertEqual(status, 200, body)
        return body

    def test_a_commit_in_a_quiet_window_stages_and_goes_up_at_the_boundary(self):
        self._set(publish={"policy": "immediate", "min_gap_minutes": 0})
        self.clock.set(at(2026, 8, 20, 1, 0))          # inside 00:30-06:00

        result = self.file_edition()
        self.assertEqual(result["state"], "staged")
        self.assertEqual(self.call("GET", "/news.json")[0], 404)

        self.clock.set(at(2026, 8, 20, 6, 0))
        self.desk.tick()
        self.assertEqual(self.call("GET", "/news.json")[0], 200)

    def test_a_forced_publish_overrides_the_quiet_window(self):
        self._set(publish={"policy": "immediate", "min_gap_minutes": 0})
        self.clock.set(at(2026, 8, 20, 1, 0))
        self.assertEqual(self.file_edition()["state"], "staged")

        status, doc = self.api("POST", "/api/publish", {})
        self.assertEqual(status, 200, doc)
        self.assertEqual(self.call("GET", "/news.json")[0], 200)

    def test_nothing_staged_is_a_404_rather_than_a_pretend_success(self):
        self.assertEqual(self.api("POST", "/api/publish", {})[0], 404)

    def test_an_identical_edition_filed_twice_is_a_no_op(self):
        self._set(publish={"policy": "immediate", "min_gap_minutes": 0})
        first = self.file_edition()
        self.assertEqual(first["state"], "published")
        second = self.file_edition()
        self.assertEqual(second["state"], "unchanged")
        self.assertEqual(second["edition_id"], first["edition_id"])


class TickTest(DeskTestCase):
    """The scheduler pass: idempotent, and it touches nothing it need not."""

    def test_a_wake_enqueues_exactly_one_filing_however_often_it_ticks(self):
        self.clock.set(at(2026, 8, 19, 12, 40) + 5)     # just past a default wake
        self.desk.tick()
        for _ in range(10):
            self.clock.advance(5)
            self.desk.tick()

        _, doc = self.api("GET", "/api/commands")
        filings = [c for c in doc["commands"] if c["kind"] == "file_edition"]
        self.assertEqual(len(filings), 1, doc["commands"])

    def test_a_wake_missed_by_more_than_the_grace_does_not_fire_late(self):
        # A desk brought up at noon must not immediately file the morning paper.
        self.clock.set(at(2026, 8, 19, 12, 40) + 3 * 3600)
        self.desk.tick()
        _, doc = self.api("GET", "/api/commands")
        self.assertEqual([c for c in doc["commands"] if c["kind"] == "file_edition"], [])

    def test_two_wakes_each_fire_once(self):
        self.clock.set(at(2026, 8, 19, 12, 40) + 5)
        self.desk.tick()
        self.clock.set(at(2026, 8, 19, 22, 0) + 5)
        self.desk.tick()

        _, doc = self.api("GET", "/api/commands")
        filings = [c for c in doc["commands"] if c["kind"] == "file_edition"]
        self.assertEqual(len(filings), 2)

    def test_the_queue_is_reaped_on_the_housekeeping_pass_not_every_tick(self):
        # A lease runs half an hour and a deadline is hours away; a write
        # transaction every five seconds to ask whether either has passed is a
        # transaction that finds nothing all day. It goes with the sweep and
        # the prune, ten minutes apart, where the rest of the tidying lives.
        from claudepost.app import HOUSEKEEPING_SECONDS

        self.desk.tick()                      # the first pass takes its housekeeping
        status, doc = self.api("POST", "/api/commands",
                               {"text": "look at the tape",
                                "deadline_at": self.clock.now() + 60}, "producer")
        self.assertEqual(status, 200, doc)
        cid = doc["command"]["id"]

        self.clock.advance(61)
        self.assertNotIn("reaped:1", self.desk.tick())
        self.assertEqual(self.command(cid)["status"], "pending")

        self.clock.advance(HOUSEKEEPING_SECONDS)
        self.assertIn("reaped:1", self.desk.tick())
        self.assertEqual(self.command(cid)["status"], "expired")

    def command(self, cid: str) -> dict:
        _, doc = self.api("GET", "/api/commands")
        return next(c for c in doc["commands"] if c["id"] == cid)

    def _publish_something(self):
        doc = S.schedule_to_dict(S.DEFAULT_SCHEDULE)
        doc["publish"] = {"policy": "immediate", "min_gap_minutes": 0}
        self.api("PUT", "/api/schedule", doc)
        self.assertEqual(self.file_edition()["state"], "published")


# -- one socket, several requests -----------------------------------------
#
# Everything above opens a connection per request, which is exactly why the
# desync these helpers exist to catch was invisible to all of it.

def read_response(fp):
    """One response off a shared reader: ``(status, headers, body)``.

    Hand-rolled rather than :mod:`http.client`, because ``HTTPResponse.read()``
    closes the file it was handed and the whole point here is to read several
    responses off ONE socket. Header names come back lowercased.
    """
    line = fp.readline()
    if not line:
        return None                                  # the server hung up first
    # The status line is where a desync surfaces, and it surfaces as junk in
    # front of it rather than as a missing response: a body written past a
    # Content-Length has no newline of its own, so `int(line.split()[1])` would
    # read `b'oopsHTTP/1.1 200 OK'` as a perfectly good 200 and swallow the
    # bug. `http.client` refuses that line; so does this.
    if not line.startswith(b"HTTP/"):
        raise AssertionError(
            "the previous response wrote past its Content-Length: %r" % line[:80])
    status = int(line.split(b" ")[1])
    headers = {}
    while True:
        raw = fp.readline()
        if raw in (b"\r\n", b"\n", b""):
            break
        name, _, value = raw.decode("latin-1").partition(":")
        headers[name.strip().lower()] = value.strip()
    length = int(headers.get("content-length", 0))
    return status, headers, (fp.read(length) if length else b"")


class RawConnection:
    """A socket the test holds open across requests, with no client in the way."""

    def __init__(self, base: str) -> None:
        host, _, port = base.removeprefix("http://").partition(":")
        self.sock = socket.create_connection((host, int(port)), timeout=10)
        self.fp = self.sock.makefile("rb")

    def send(self, raw: bytes) -> None:
        self.sock.sendall(raw)

    def response(self):
        return read_response(self.fp)

    def spare(self) -> bytes:
        """Anything the server sent that nobody asked for; ``b""`` when it behaved.

        A drained connection is idle rather than closed, so this has to wait to
        be able to say "nothing more came"; a closed one answers at once.
        """
        self.sock.settimeout(0.5)
        try:
            return self.fp.readline()
        except (TimeoutError, OSError):
            return b""

    def is_closed(self, within: float = 2) -> bool:
        """True when the server hung up, False when it is holding the socket open.

        The window is a parameter because the two things that close a
        connection here run on different clocks: a refusal decided from a
        header closes at once, and a socket timeout closes when it runs out.
        """
        self.sock.settimeout(within)
        try:
            return self.fp.read(1) == b""
        except (TimeoutError, OSError):
            return False

    def close(self) -> None:
        self.fp.close()
        self.sock.close()


class RawTestCase(DeskTestCase):
    """A desk, plus sockets the test drives by hand and the suite closes for it."""

    def connect(self) -> RawConnection:
        conn = RawConnection(self.base)
        self.addCleanup(conn.close)
        return conn


class KeepAliveTest(RawTestCase):
    """One response per request, on a connection that gets reused.

    ``protocol_version = "HTTP/1.1"`` makes every connection keep-alive, and a
    body no handler read stays in the socket -- where
    ``BaseHTTPRequestHandler`` reads it as the next request LINE. Behind a
    tunnel that pools origin connections, the next request is somebody else's,
    so the smuggled one runs with whatever credential that request carried.
    The rule this class holds the desk to is the transport's, not any
    handler's: a request's body ends with that request.
    """

    HOLD = b'{"until":99999999999}'

    def smuggled(self, scope: str = "operator") -> bytes:
        """A whole request, to be carried inside another request's body.

        It carries a token because that is what the desync steals: in the wild
        the header block of the NEXT caller's request is absorbed into this
        one. Spelling the token out here is the same thing with the timing
        taken out.
        """
        return (b"POST /api/hold HTTP/1.1\r\n"
                b"Host: desk\r\n"
                b"Authorization: Bearer " + self.tokens[scope].encode() + b"\r\n"
                b"Content-Type: application/json\r\n"
                b"Content-Length: %d\r\n\r\n" % len(self.HOLD)) + self.HOLD

    def assert_is_healthz(self, answer) -> None:
        self.assertIsNotNone(answer, "the connection was closed with a request unanswered")
        status, _headers, body = answer
        self.assertEqual(status, 200, body)
        # By the body, not the status: the smuggled POST /api/hold answers 200
        # too, and a test that read only the code would pass against the
        # desync it exists to catch.
        self.assertEqual(json.loads(body).get("service"), "claudepost", body)

    def test_a_304_leaves_the_connection_reusable(self):
        # A 304 is the only response this desk sends that has a status, headers
        # and nothing after them, and it is the one the board will spend most
        # of its life reading. If its framing is ambiguous the socket is left
        # holding a body that never comes, and the failure lands on whatever
        # request follows rather than on this one.
        self.file_edition()
        conn = self.connect()
        conn.send(b"GET /news.json HTTP/1.1\r\nHost: desk\r\n\r\n")
        status, headers, body = conn.response()
        self.assertEqual(status, 200)
        self.assertTrue(body)

        conn.send(b"GET /news.json HTTP/1.1\r\nHost: desk\r\n"
                  b"If-None-Match: " + headers["etag"].encode() + b"\r\n\r\n")
        status, headers, body = conn.response()
        self.assertEqual(status, 304)
        self.assertEqual(body, b"")
        self.assertEqual(headers.get("content-length"), "0")

        # The reuse first and the sweep after, which is this class's order
        # everywhere: `spare()` waits out a timeout on the socket, and a
        # `makefile` reader that has once timed out refuses every read after
        # it. So the healthz proves the connection was left usable, and the
        # empty sweep proves three responses came back for three requests --
        # a 304 that wrote a body would show up as a fourth.
        conn.send(b"GET /healthz HTTP/1.1\r\nHost: desk\r\n\r\n")
        self.assert_is_healthz(conn.response())
        self.assertEqual(conn.spare(), b"", "the 304 wrote something after its headers")

    def test_two_if_none_match_field_lines_are_one_list(self):
        # A proxy is entitled to split a repeated field across lines. A desk
        # that read only the first would answer 200 to a board that asked
        # correctly -- silently, and once every poll. Raw, because
        # `urllib.request.Request.add_header` de-duplicates by name and
        # `DeskTestCase.call(headers=)` cannot express two field lines at all.
        self.file_edition()
        conn = self.connect()
        conn.send(b"GET /news.json HTTP/1.1\r\nHost: desk\r\n\r\n")
        _status, headers, _body = conn.response()
        conn.send(b"GET /news.json HTTP/1.1\r\nHost: desk\r\n"
                  b'If-None-Match: "0000000000000000"\r\n'
                  b"If-None-Match: " + headers["etag"].encode() + b"\r\n\r\n")
        status, _headers, body = conn.response()
        self.assertEqual(status, 304)
        self.assertEqual(body, b"")

    def test_a_refused_requests_body_never_becomes_the_next_request(self):
        # Variant A of the finding: the attacker holds no token at all. The
        # 401 is decided from the header, before anything reads the body -- so
        # the body is still in the socket when the next request arrives.
        smuggled = self.smuggled()
        conn = self.connect()
        conn.send(b"POST /api/state HTTP/1.1\r\nHost: desk\r\n"
                  b"Content-Type: application/json\r\n"
                  b"Content-Length: %d\r\n\r\n" % len(smuggled) + smuggled)
        self.assertEqual(conn.response()[0], 401)

        conn.send(b"GET /healthz HTTP/1.1\r\nHost: desk\r\n\r\n")
        self.assert_is_healthz(conn.response())
        self.assertEqual(conn.spare(), b"", "a third response for two requests")
        self.assertIsNone(self.desk.store.get_hold(),
                          "an unauthenticated body set an operator-only hold")

    def test_a_200_that_never_read_its_body_does_not_leave_it_in_the_socket(self):
        # Variant B: no error path is needed. `h_open_draft` answers 200 and
        # never calls `_body()`, so a valid producer token is enough to put an
        # operator-only request into the connection.
        smuggled = self.smuggled()
        conn = self.connect()
        conn.send(b"POST /api/drafts HTTP/1.1\r\nHost: desk\r\n"
                  b"Authorization: Bearer " + self.tokens["producer"].encode() + b"\r\n"
                  b"Content-Type: application/json\r\n"
                  b"Content-Length: %d\r\n\r\n" % len(smuggled) + smuggled)
        status, _headers, body = conn.response()
        self.assertEqual(status, 200, body)
        self.assertIn("draft_id", json.loads(body))

        conn.send(b"GET /healthz HTTP/1.1\r\nHost: desk\r\n\r\n")
        self.assert_is_healthz(conn.response())
        self.assertEqual(conn.spare(), b"", "a third response for two requests")
        self.assertIsNone(self.desk.store.get_hold(),
                          "a producer token reached an operator-only route")

    def test_an_over_limit_body_ends_the_connection(self):
        # The 413 is decided from the header so the bytes never cost anything
        # (`_body`'s own promise), which leaves them in the socket. There is
        # nothing to drain them by and no reason to read them, so the socket
        # goes instead -- and it says so, rather than closing under a client
        # that thinks it has a connection.
        conn = self.connect()
        conn.send(b"POST /api/hold HTTP/1.1\r\nHost: desk\r\n"
                  b"Authorization: Bearer " + self.tokens["operator"].encode() + b"\r\n"
                  b"Content-Type: application/json\r\n"
                  b"Content-Length: %d\r\n\r\n" % (MAX_CONTROL_BODY + 1))
        status, headers, body = conn.response()
        self.assertEqual(status, 413, body)
        self.assertEqual(headers.get("connection"), "close", headers)
        self.assertTrue(conn.is_closed(), "the socket was kept with a body in flight")

    def test_a_chunked_body_ends_the_connection_because_nothing_can_read_it(self):
        # `BaseHTTPRequestHandler` does not decode chunked transfer at all, so
        # the chunks stay in the socket and there is no declared length to
        # drain by. The connection is the only thing that can be thrown away.
        smuggled = self.smuggled()
        conn = self.connect()
        conn.send(b"POST /api/hold HTTP/1.1\r\nHost: desk\r\n"
                  b"Authorization: Bearer " + self.tokens["operator"].encode() + b"\r\n"
                  b"Content-Type: application/json\r\n"
                  b"Transfer-Encoding: chunked\r\n\r\n"
                  b"%x\r\n" % len(smuggled) + smuggled + b"\r\n0\r\n\r\n")
        status, headers, body = conn.response()
        self.assertEqual(status, 400, body)
        self.assertEqual(headers.get("connection"), "close", headers)
        self.assertTrue(conn.is_closed(), "the socket was kept with chunks in flight")
        self.assertIsNone(self.desk.store.get_hold())

    def test_a_body_the_handler_did_read_leaves_the_connection_usable(self):
        # The other half of the rule, and the one a drain can break: a request
        # whose body was read in full must not have anything read after it.
        conn = self.connect()
        conn.send(b"POST /api/hold HTTP/1.1\r\nHost: desk\r\n"
                  b"Authorization: Bearer " + self.tokens["operator"].encode() + b"\r\n"
                  b"Content-Type: application/json\r\n"
                  b"Content-Length: %d\r\n\r\n" % len(self.HOLD) + self.HOLD)
        status, _headers, body = conn.response()
        self.assertEqual(status, 200, body)
        self.assertEqual(json.loads(body)["hold"], 99999999999)

        conn.send(b"GET /healthz HTTP/1.1\r\nHost: desk\r\n\r\n")
        self.assert_is_healthz(conn.response())
        self.assertEqual(conn.spare(), b"")


class SocketTimeoutTest(RawTestCase):
    """A stranger who stops talking does not get to keep a thread.

    ``StreamRequestHandler`` starts with no socket timeout at all, so a client
    that opens a connection and then goes quiet -- mid-header, mid-body, or
    idle on a keep-alive socket it will never use again -- parks one of the
    desk's threads for as long as it likes, and none of it looks like an
    error from inside. Behind a tunnel that client is anybody, and the thread
    it is holding is one the board is not being served by.

    The server here runs on half a second, so that these assertions cost that
    rather than the two minutes the desk ships with. Every wait on the client
    side is many times longer, so a regression fails this class rather than
    parking the suite behind a thread that is never coming back.
    """

    TIMEOUT = 0.5

    #: Long enough that the server has certainly given up, short enough that
    #: five of these are not the slowest thing in the suite.
    PATIENCE = 5

    def test_a_request_that_never_finishes_its_headers_is_let_go(self):
        # The request LINE arrives and the blank line after the headers never
        # does, so the handler is parked inside `parse_request` with nothing
        # to answer and no way to know whether more is coming. This is the
        # cheapest way there is to hold a thread: one line and then silence.
        conn = self.connect()
        conn.send(b"GET /healthz HTTP/1.1\r\nHost: desk\r\n")
        self.assertTrue(conn.is_closed(within=self.PATIENCE),
                        "the desk held a thread for a request that never arrived")

    def test_a_body_that_stops_short_takes_the_connection_and_nothing_else(self):
        # The header promised ten bytes and three came, so `_body` is parked
        # in `rfile.read`. A socket that stopped is not the desk breaking:
        # it costs the connection, it is not worth a traceback, and there is
        # nobody left to send a 500 to.
        conn = self.connect()
        with self.assertNoLogs("claudepost.http", level="ERROR"):
            conn.send(b"POST /api/hold HTTP/1.1\r\nHost: desk\r\n"
                      b"Authorization: Bearer " + self.tokens["operator"].encode() + b"\r\n"
                      b"Content-Type: application/json\r\n"
                      b"Content-Length: 10\r\n\r\nabc")
            self.assertTrue(conn.is_closed(within=self.PATIENCE),
                            "the desk waited forever for seven bytes")
        self.assertIsNone(self.desk.store.get_hold(),
                          "a body that never finished arriving took effect anyway")

    def test_an_idle_keep_alive_connection_is_released(self):
        # The ordinary case, and the reason this is a number rather than a
        # refusal: a client that finished its business and kept the socket is
        # behaving correctly right up until it is holding the last thread. The
        # board's own port retries once on a fresh connection when it finds
        # one closed, so this costs it nothing.
        conn = self.connect()
        conn.send(b"GET /healthz HTTP/1.1\r\nHost: desk\r\n\r\n")
        status, _headers, body = conn.response()
        self.assertEqual(status, 200, body)
        self.assertTrue(conn.is_closed(within=self.PATIENCE),
                        "an idle connection kept its thread")

    def test_a_long_poll_outlives_the_socket_timeout(self):
        # The claim parks on the queue's condition, not on the socket, so the
        # timeout must not touch it. Otherwise the number chosen to release
        # strangers would quietly become a cap on how long a worker may ask
        # for work -- a different decision, made by accident, and visible only
        # as a worker that polls in a tight loop.
        #
        # The deadline is measured on the desk's clock, which this suite moves
        # by hand and nothing else moves while the poll is parked.
        answered = threading.Event()
        self.addCleanup(answered.set)

        def run_down_the_deadline():
            while not answered.wait(0.2):
                self.clock.advance(1)

        ticker = threading.Thread(target=run_down_the_deadline, daemon=True)
        ticker.start()

        started = time.monotonic()
        status, doc = self.api("GET", "/api/commands/next?wait=2", scope="producer")
        elapsed = time.monotonic() - started
        answered.set()
        ticker.join(self.PATIENCE)

        self.assertEqual(status, 204, doc)
        self.assertGreater(elapsed, self.TIMEOUT * 2,
                           "the poll came back inside the timeout it must outlive")

    def test_a_reader_that_stops_reading_is_not_an_error(self):
        # The same failure from the other end: the request was fine and the
        # client stopped taking the answer, so it is the WRITE that times out.
        # That lands wherever the response is being sent from, which is inside
        # the handler -- and a broad `except` there would report a socket the
        # desk cannot do anything about as the desk breaking, with a traceback
        # per abandoned curl and a second exception from the 500 nobody can
        # receive either.
        self.file_edition(tile_id="big", tile=BIG_TILE)

        # The receive buffer is set before the connect, which is the only time
        # it can be: the window this advertises is what makes the desk's write
        # block rather than disappearing into the kernel.
        sock = socket.socket()
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 2048)
        self.addCleanup(sock.close)
        sock.settimeout(self.PATIENCE)
        sock.connect(("127.0.0.1", self.server.server_address[1]))

        with self.assertNoLogs("claudepost.http", level="ERROR"):
            sock.sendall(b"GET /tiles/big.bin HTTP/1.1\r\nHost: desk\r\n\r\n")
            threading.Event().wait(self.TIMEOUT * 4)     # let the write give up

            # Only now open the window, so what comes back is what the desk
            # had managed to send before it did.
            received = 0
            while True:
                chunk = sock.recv(65536)
                if not chunk:
                    break
                received += len(chunk)

        if received >= len(BIG_TILE):
            # Not a failure and not a pass either: with SO_RCVBUF already at
            # the floor and the tile already at the largest this desk serves,
            # there is nothing left to widen the margin with, so a machine
            # whose buffers swallow the whole sheet simply cannot run this.
            self.skipTest("the whole sheet fit in this machine's socket buffers; "
                          "nothing stalled, so there was nothing to observe")


class LostConnectionTest(RawTestCase):
    """Writing an answer to somebody who has already gone.

    The commonest dead socket this desk writes to is not a stalled reader, it
    is a REFUSAL: a 401 to a scanner that hung up the moment it learned a
    token was wanted, a 413 to a client that gave up on its own upload. Those
    are written from inside :meth:`_dispatch`'s ``except`` clauses, and an
    exception raised in there replaces the one being handled and escapes the
    whole method -- past ``handle_one_request``, which absorbs only
    ``TimeoutError``, and into ``socketserver``'s ``handle_error``, which puts
    a traceback on stderr for a socket that simply went.
    """

    def refuse_to_write(self) -> None:
        """Make every refusal this desk writes find a broken pipe.

        Patched at the one place all of them funnel through, so that the test
        does not have to arrange a real client that hangs up inside the
        microsecond between the header being decided and the answer being
        written.
        """
        real = DeskHTTPRequestHandler._send_bytes

        def _send_bytes(handler, status, body, content_type, head=False):
            if status >= 400:
                raise BrokenPipeError("the client is not there any more")
            return real(handler, status, body, content_type, head=head)

        patch = mock.patch.object(DeskHTTPRequestHandler, "_send_bytes", _send_bytes)
        patch.start()
        self.addCleanup(patch.stop)

    def watch_for_tracebacks(self) -> list:
        """Every ``handle_error`` the server makes -- which is the traceback.

        It runs in ``process_request_thread`` when ``finish_request`` raises,
        and BEFORE ``shutdown_request`` closes the socket, so a client that has
        read to EOF has already seen everything this list will ever hold.
        """
        seen = []
        self.server.handle_error = lambda request, address: seen.append(address)
        return seen

    def test_a_refusal_nobody_can_receive_does_not_become_a_traceback(self):
        # The 401 is decided from the header and written straight away, which
        # is exactly the window in which a scanner has already gone.
        self.refuse_to_write()
        tracebacks = self.watch_for_tracebacks()

        conn = self.connect()
        with self.assertNoLogs("claudepost.http", level="ERROR"):
            conn.send(b"GET /api/state HTTP/1.1\r\nHost: desk\r\n\r\n")
            self.assertTrue(conn.is_closed(), "the handler never let the connection go")

        self.assertEqual(tracebacks, [],
                         "a broken pipe on a 401 reached socketserver.handle_error")

    def test_a_500_nobody_can_receive_does_not_become_a_second_failure(self):
        # The genuine fault is worth a traceback and keeps it. The broken pipe
        # on the 500 that follows is not a second fault, and must not escape
        # from inside the `except` that is already reporting the first.
        self.refuse_to_write()
        tracebacks = self.watch_for_tracebacks()

        def explode():
            raise ValueError("something the desk did not expect")

        patch = mock.patch.object(self.desk.editions, "current_id", explode)
        patch.start()
        self.addCleanup(patch.stop)

        conn = self.connect()
        with self.assertLogs("claudepost.http", level="ERROR") as logged:
            conn.send(b"GET /news.json HTTP/1.1\r\nHost: desk\r\n\r\n")
            self.assertTrue(conn.is_closed(), "the handler never let the connection go")

        self.assertEqual(len(logged.records), 1, logged.output)
        self.assertIn("unhandled error on GET /news.json", logged.output[0])
        self.assertEqual(tracebacks, [],
                         "a broken pipe on the 500 reached socketserver.handle_error")


if __name__ == "__main__":
    unittest.main()
