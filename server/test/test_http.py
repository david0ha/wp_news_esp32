"""The two planes, the scheduler tick, and the property the device plane exists to have.

Every test here runs a real :class:`~wpdesk.http.DeskServer` on a loopback port
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
import tempfile
import threading
import unittest
import urllib.error
import urllib.request

from wpdesk import schedule as S
from wpdesk.app import Config, Desk
from wpdesk.clock import FixedClock
from wpdesk.gates import StubGates
from wpdesk.http import make_server

from test_schedule import at

PAYLOAD = json.dumps({
    "edition": "SEMICONDUCTORS",
    "subject": {"symbol": "SNDK", "name": "Sandisk Corp."},
    "stories": [{"rank": 0, "headline": "A headline long enough to be a headline",
                 "body": "MILPITAS — copy."}],
}).encode()

TILE = bytes(range(256)) * 4          # 1,024 bytes; the desk does not inspect content


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


class DeskTestCase(unittest.TestCase):
    """A desk on a loopback port, with stub gates and a clock the test drives."""

    START = at(2026, 8, 19, 9, 0)          # a Wednesday morning, outside quiet hours

    def setUp(self):
        self.root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.root, True)

        data = os.path.join(self.root, "data")
        vault = os.path.join(self.root, "vault")
        os.makedirs(data)
        os.makedirs(vault)
        tokens_path = os.path.join(self.root, "tokens.json")
        self.tokens = write_tokens(tokens_path)

        self.clock = FixedClock(self.START)
        self.gates = StubGates(sheets=())
        self.cfg = Config(data_dir=data, vault_dir=vault, tokens_path=tokens_path,
                          repo_dir=self.root, host="127.0.0.1", port=0)
        self.desk = Desk(self.cfg, clock=self.clock, gates=self.gates)
        self.addCleanup(self.desk.close)

        self.server = make_server(self.desk, "127.0.0.1", 0)
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
        # Through the API rather than onto `desk.schedule`, because the desk
        # re-reads its schedule whenever the file behind it changes, and the
        # first tick writes a default one -- so an attribute would be reverted
        # under exactly the tests that tick. The classes that are about the
        # calendar PUT their own schedule over this one.
        doc = S.schedule_to_dict(S.DEFAULT_SCHEDULE)
        doc["publish"] = {"policy": "immediate", "min_gap_minutes": 0}
        status, body = self.api("PUT", "/api/schedule", doc)
        self.assertEqual(status, 200, body)

    # -- a tiny client ----------------------------------------------------
    def call(self, method, path, body=None, token=None, ctype="application/json"):
        """Returns ``(status, bytes)``. Never raises for a 4xx -- those are answers."""
        req = urllib.request.Request(self.base + path, data=body, method=method)
        if token:
            req.add_header("Authorization", "Bearer " + token)
        if body is not None:
            req.add_header("Content-Type", ctype)
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                return resp.status, resp.read(), dict(resp.headers)
        except urllib.error.HTTPError as e:
            return e.code, e.read(), dict(e.headers)

    def api(self, method, path, doc=None, scope="operator"):
        body = json.dumps(doc).encode() if doc is not None else None
        status, raw, _ = self.call(method, path, body, self.tokens[scope])
        return status, (json.loads(raw) if raw else None)

    def file_edition(self, payload=PAYLOAD, tile_id="pic", scope="producer"):
        """Push one edition all the way through, returning the commit document."""
        status, doc = self.api("POST", "/api/drafts", {}, scope)
        self.assertEqual(status, 200, doc)
        draft = doc["draft_id"]

        status, _, _ = self.call("PUT", "/api/drafts/%s/news.json" % draft, payload,
                                 self.tokens[scope])
        self.assertEqual(status, 200)
        if tile_id:
            status, _, _ = self.call("PUT", "/api/drafts/%s/tiles/%s.bin" % (draft, tile_id),
                                     TILE, self.tokens[scope], "application/octet-stream")
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
        # This is docs/hosting-cloudflare.md's `find tools/edition/public -type f`
        # made executable. Every one of these is a real file or a real endpoint
        # somewhere in this system, and none of them is on this plane.
        for path in ("/", "/index.html", "/watchlist.json", "/standing.md",
                     "/schedule.json", "/desk.sqlite", "/data/desk.sqlite",
                     "/editions", "/log/2026-08-19.json", "/tiles/", "/tiles/pic",
                     "/tiles/pic.bin.bak", "/vault/standing.md",
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

    def test_no_cache_headers_reach_the_board(self):
        # A cache between the desk and the board is a stale front page that
        # nobody can explain from across a room.
        self.file_edition()
        _, _, headers = self.call("GET", "/news.json")
        for header in ("Cache-Control", "ETag", "Last-Modified", "Expires"):
            self.assertNotIn(header, headers)

    def test_head_returns_the_headers_and_no_body(self):
        self.file_edition()
        status, raw, headers = self.call("HEAD", "/news.json")
        self.assertEqual(status, 200)
        self.assertEqual(raw, b"")
        self.assertGreater(int(headers["Content-Length"]), 0)


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
        self.assertEqual(doc["vault"], "available")
        self.assertIsNotNone(doc["current"])
        self.assertIn(doc["scheduleSource"], ("vault", "cache", "default"))
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
    """The scheduler pass: idempotent, and it does not need the vault to run."""

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

    def test_the_desk_survives_the_vault_disappearing(self):
        # Pulling the SSD must not be able to blank a newspaper.
        self._publish_something()
        shutil.rmtree(self.cfg.vault_dir)

        self.clock.advance(60)
        self.desk.tick()

        self.assertEqual(self.call("GET", "/news.json")[0], 200)
        _, state = self.api("GET", "/api/state")
        self.assertEqual(state["vault"], "unavailable")

    def test_the_vault_layout_is_written_and_never_overwritten(self):
        self.desk.tick()
        standing = os.path.join(self.cfg.vault_dir, "standing.md")
        self.assertTrue(os.path.exists(standing))

        with open(standing, "w", encoding="utf-8") as f:
            f.write("mine\n")
        self.clock.advance(60)
        self.desk.tick()
        with open(standing, encoding="utf-8") as f:
            self.assertEqual(f.read(), "mine\n")

    def _publish_something(self):
        doc = S.schedule_to_dict(S.DEFAULT_SCHEDULE)
        doc["publish"] = {"policy": "immediate", "min_gap_minutes": 0}
        self.api("PUT", "/api/schedule", doc)
        self.assertEqual(self.file_edition()["state"], "published")


if __name__ == "__main__":
    unittest.main()
