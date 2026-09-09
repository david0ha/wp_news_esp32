"""The one thing this desk must never do, asserted three ways.

``/news.json`` is served with **no authorization at all**. It has to be: the
board polls it over the open internet and has no token to offer. The desk now
also holds the owner's actual option and stock positions -- strikes, expiries,
entry prices -- so the catastrophic outcome of that feature is an agent that
reads a position and files it into an edition, publishing what the owner holds
at a public URL.

Three properties stand between those two facts, and every one of them is
written as *cannot* rather than as *does not today*:

1. A draft payload carrying a position field at any depth is refused. The
   recursion is the point -- a field three deep inside a story is exactly what
   a shallow check misses, and an agent annotating a figure with the positions
   in front of it is exactly how one gets there.
2. The device plane serves three paths, asserted against a literal set. A route
   added at the wrong end of ``http.py`` fails here rather than shipping
   unauthenticated.
3. No control-plane path answers without a token, by a curated sample path per
   route. ``SAMPLES`` is a literal dict and the first assertion is that it
   covers every route, so adding a route without adding a sample fails here
   rather than going unswept. Generating a path from the regex instead would be
   fiddly enough to be wrong quietly, and a security sweep that quietly probes
   the wrong path is worse than no sweep at all.

The desk fixture is ``test_http.DeskTestCase`` rather than a second one built
here: a second spelling of "a running desk" is a second thing to keep in step
with the server, and the first divergence would look like a security finding.
"""

from __future__ import annotations

import json
import unittest

from claudepost.editions import FORBIDDEN_PAYLOAD_KEYS
from claudepost.http import _CID, _DEVICE_ROUTES, _ROUTES, _TILE_ID

from test_http import PAYLOAD, DeskTestCase

#: The names that may never appear as a key in an edition, spelled out here
#: rather than imported *for the comparison* -- the module's own constant is
#: imported too, and the test that they are the same set is what makes editing
#: one of them a deliberate act. A name quietly dropped from the guard would
#: otherwise quietly drop from its own test.
FORBIDDEN = ("strike_cents", "entry_price_cents", "contracts", "positions",
             "position_id", "legs")

#: The three paths a board may reach without a token, as their patterns are
#: spelled in ``http.py``. The tile pattern is interpolated the way the routing
#: table interpolates it, so a change to what a tile id may contain moves both
#: at once; a *fourth route* still fails this test, which is what it is for.
EXPECTED_NEWS = r"^/news\.json\Z"
EXPECTED_HEALTHZ = r"^/healthz\Z"
EXPECTED_TILE = r"^/tiles/(?P<tile>%s)\.bin\Z" % _TILE_ID

DRAFT = "0" * 32                     # `uuid4().hex`, as the draft routes match it
EID = "0" * 16                       # a fingerprint, and so an edition id
CID = "0" * 16                       # a command id

#: One path per control-plane route, written out. The paths are literal on
#: purpose (see the module docstring); only the two id *shapes* the route table
#: itself interpolates are interpolated here, so this dict tracks the table's
#: keys without restating what a tile id or a command id is allowed to be.
#:
#: These need not name anything that exists. The 401 is decided at the top of
#: ``_control`` before a route is matched at all, which is the property under
#: test: an anonymous caller does not get to find out whether a draft is there.
SAMPLES = {
    r"^/api/drafts\Z": "/api/drafts",
    r"^/api/drafts/(?P<draft>[0-9a-f]{32})\Z": f"/api/drafts/{DRAFT}",
    r"^/api/drafts/(?P<draft>[0-9a-f]{32})/news\.json\Z":
        f"/api/drafts/{DRAFT}/news.json",
    r"^/api/drafts/(?P<draft>[0-9a-f]{32})/tiles/(?P<tile>%s)\.bin\Z" % _TILE_ID:
        f"/api/drafts/{DRAFT}/tiles/pic.bin",
    r"^/api/drafts/(?P<draft>[0-9a-f]{32})/notes\.md\Z":
        f"/api/drafts/{DRAFT}/notes.md",
    r"^/api/drafts/(?P<draft>[0-9a-f]{32})/proof\Z": f"/api/drafts/{DRAFT}/proof",
    r"^/api/drafts/(?P<draft>[0-9a-f]{32})/proof/(?P<name>[^/]{1,60})\Z":
        f"/api/drafts/{DRAFT}/proof/A1.png",
    r"^/api/drafts/(?P<draft>[0-9a-f]{32})/commit\Z": f"/api/drafts/{DRAFT}/commit",

    r"^/api/editions\Z": "/api/editions",
    r"^/api/editions/(?P<eid>[0-9a-f]{8,64})\Z": f"/api/editions/{EID}",
    r"^/api/editions/(?P<eid>[0-9a-f]{8,64})/notes\.md\Z":
        f"/api/editions/{EID}/notes.md",
    r"^/api/editions/(?P<eid>[0-9a-f]{8,64})/proof/(?P<name>[^/]{1,60})\Z":
        f"/api/editions/{EID}/proof/A1.png",
    r"^/api/editions/(?P<eid>[0-9a-f]{8,64})/promote\Z": f"/api/editions/{EID}/promote",

    r"^/api/commands\Z": "/api/commands",
    r"^/api/commands/next\Z": "/api/commands/next",
    r"^/api/commands/(?P<cid>%s)\Z" % _CID: f"/api/commands/{CID}",
    r"^/api/commands/(?P<cid>%s)/(?P<verb>done|fail)\Z" % _CID: f"/api/commands/{CID}/done",
    r"^/api/commands/(?P<cid>%s)/notes\.md\Z" % _CID: f"/api/commands/{CID}/notes.md",

    r"^/api/directives\Z": "/api/directives",
    r"^/api/directives/(?P<did>[0-9a-f]{8,64})\Z": f"/api/directives/{EID}",

    r"^/api/schedule\Z": "/api/schedule",
    r"^/api/schedule/next\Z": "/api/schedule/next",
    r"^/api/watchlist\Z": "/api/watchlist",
    r"^/api/settings\Z": "/api/settings",

    # The five routes the positions feature added. That they are on this plane
    # rather than the other one is the whole defence, and they are listed here
    # for the same reason /api/state is: so that a token is proved necessary
    # for each of them by name.
    r"^/api/positions\Z": "/api/positions",
    r"^/api/calendar\Z": "/api/calendar",
    r"^/api/econ\Z": "/api/econ",
    r"^/api/push/devices\Z": "/api/push/devices",
    r"^/api/push/devices/(?P<token>[^/]{1,120})\Z": "/api/push/devices/ExponentPushToken",

    r"^/api/quotes\Z": "/api/quotes",
    r"^/api/state\Z": "/api/state",
    r"^/api/publish\Z": "/api/publish",
    r"^/api/hold\Z": "/api/hold",
    r"^/api/audit\Z": "/api/audit",
}


def valid_edition() -> dict:
    """The edition ``test_http`` files, as a document to spoil.

    Off that module's payload rather than written again: a payload this file
    believed was valid and the desk did not would make every case below pass
    for the wrong reason -- a 400 for the shape of the document instead of a
    400 for the field that was added to it. ``test_a_clean_edition_is_still
    _accepted`` is what holds that honest.
    """
    return json.loads(PAYLOAD)


class PayloadRefusalTest(DeskTestCase):
    """Nothing about what the owner holds may enter a draft's ``news.json``."""

    def setUp(self):
        super().setUp()
        status, doc = self.api("POST", "/api/drafts", {}, "producer")
        self.assertEqual(status, 200, doc)
        self.draft = doc["draft_id"]

    def put(self, payload: dict):
        """PUT a payload at the draft opened for this case. Returns ``(status, doc)``."""
        status, raw, _ = self.call("PUT", "/api/drafts/%s/news.json" % self.draft,
                                   json.dumps(payload).encode(), self.tokens["producer"])
        return status, (json.loads(raw) if raw else None)

    def assert_refused(self, payload: dict, where: str):
        status, doc = self.put(payload)
        self.assertEqual(status, 400, "%s was accepted" % where)
        self.assertEqual(doc["error"], "position_field", where)

    def test_the_guard_names_exactly_the_fields_this_test_knows_about(self):
        # Both directions. A name added to the module without a case here is as
        # much a gap as a name deleted from the module -- the first leaves a
        # field nothing proves is refused, the second leaves a field nothing
        # refuses at all.
        self.assertEqual(set(FORBIDDEN), set(FORBIDDEN_PAYLOAD_KEYS))

    def test_a_payload_nested_past_the_decoder_is_a_400_and_not_a_500(self):
        """CPython's JSON decoder recurses per level and raises RecursionError,
        which is neither ValueError nor UnicodeDecodeError -- so it used to
        escape the parse and land as a 500 on a route where every other refusal
        is a 400. Robustness rather than disclosure, but a producer reading a
        500 goes looking for a broken desk instead of a broken payload."""
        deep = b"[" * 40_000 + b"]" * 40_000
        status, raw, _ = self.call("PUT", "/api/drafts/%s/news.json" % self.draft,
                                   deep, self.tokens["producer"])
        self.assertEqual(status, 400)
        self.assertEqual(json.loads(raw)["error"], "bad_json")

    def test_a_position_field_at_the_top_level_is_refused(self):
        for key in FORBIDDEN:
            payload = valid_edition()
            payload[key] = "anything"
            self.assert_refused(payload, "top level: %s" % key)

    def test_a_position_field_on_a_story_is_refused(self):
        for key in FORBIDDEN:
            payload = valid_edition()
            payload["stories"][0][key] = "anything"
            self.assert_refused(payload, "stories[0]: %s" % key)

    def test_a_position_field_three_deep_is_refused(self):
        # The case a shallow check misses, and the one that will actually
        # happen: an agent annotating a figure inside a story with the book
        # open in front of it.
        for key in FORBIDDEN:
            payload = valid_edition()
            payload["stories"][0]["figures"] = [{"label": "Strike",
                                                 "detail": {key: "anything"}}]
            self.assert_refused(payload, "three deep: %s" % key)

    def test_a_position_field_inside_a_bare_list_is_refused(self):
        # Lists of lists carry no keys of their own, so a walk that only
        # descends through dicts stops at the first one.
        for key in FORBIDDEN:
            payload = valid_edition()
            payload["charts"] = [[[{key: 1}]]]
            self.assert_refused(payload, "nested list: %s" % key)

    def test_a_clean_edition_is_still_accepted(self):
        # The other half of every case above. A guard that refused everything
        # would pass all of them and print no newspaper.
        status, doc = self.put(valid_edition())
        self.assertEqual(status, 200, doc)

    def test_the_words_are_refused_as_keys_and_not_as_prose(self):
        # A story about a company that sells contracts is an ordinary story.
        # Reading the values instead of the keys would refuse it, and a guard
        # that refuses real copy is a guard somebody turns off.
        payload = valid_edition()
        payload["stories"][0]["body"] = (
            "MILPITAS — the positions it holds in long-term supply contracts, "
            "and the legs of the deal, are what the entry_price_cents of the "
            "quarter turned on.")
        status, doc = self.put(payload)
        self.assertEqual(status, 200, doc)

    def test_a_refused_payload_leaves_the_one_already_filed_alone(self):
        # The desk's standing rule -- a rejected document leaves the one in
        # force untouched -- applied to this refusal. It holds here because the
        # walk runs before the write rather than after it.
        status, doc = self.put(valid_edition())
        self.assertEqual(status, 200, doc)
        status, before = self.api("GET", "/api/drafts/%s" % self.draft, None, "producer")
        self.assertEqual(status, 200, before)

        spoiled = valid_edition()
        spoiled["stories"][0]["legs"] = [{"strike_cents": 40000}]
        self.assert_refused(spoiled, "after a good payload")

        status, after = self.api("GET", "/api/drafts/%s" % self.draft, None, "producer")
        self.assertEqual(status, 200, after)
        self.assertEqual(after["bytes"], before["bytes"])

    def test_a_position_field_cannot_reach_a_published_edition(self):
        # End to end, through the plane it would be published on. The refusal
        # is at the PUT, so the draft never holds the field and the commit
        # never sees it -- but the assertion worth having is about the bytes a
        # board would be served, not about which call refused.
        spoiled = valid_edition()
        spoiled["stories"][0]["contracts"] = 3
        self.assert_refused(spoiled, "before publishing")

        self.file_edition()
        status, raw, _ = self.call("GET", "/news.json")
        self.assertEqual(status, 200)
        served = json.loads(raw)
        for key in FORBIDDEN:
            self.assertNotIn(key, json.dumps(served), key)


class DevicePlaneShapeTest(unittest.TestCase):
    """The device plane's table, against a literal set. No desk needed."""

    def test_the_device_plane_serves_only_the_three_documented_routes(self):
        """Not "does not today" -- cannot.

        A new route added to the control plane must not become reachable
        without a token by being spelled at the wrong end of ``http.py``.
        """
        served = {r.pattern for r, _ in _DEVICE_ROUTES}
        self.assertEqual(served, {EXPECTED_NEWS, EXPECTED_HEALTHZ, EXPECTED_TILE})


class ControlPlaneTokenSweepTest(DeskTestCase):
    """Every control-plane route, every verb, with no credential at all."""

    def test_every_route_has_a_sample_path(self):
        # Split from the sweep below so that the failure says which of the two
        # things went wrong. A route added without a sample is not a failing
        # sweep, it is an unswept route, and those read very differently at
        # four in the morning.
        self.assertEqual({p.pattern for p, _ in _ROUTES}, set(SAMPLES),
                         "a route has no sample path")

    def test_every_sample_path_matches_the_route_it_is_filed_under(self):
        # Without this the sweep below can pass while probing paths that reach
        # no route at all -- a 401 from the plane's own prefix check rather
        # than from the route, which is the same status for a different reason
        # and would hide a route that had lost its guard.
        for pattern, _verbs in _ROUTES:
            path = SAMPLES[pattern.pattern]
            self.assertIsNotNone(pattern.match(path),
                                 "%s does not match %s" % (path, pattern.pattern))

    def test_no_control_plane_path_answers_without_a_token(self):
        for pattern, verbs in _ROUTES:
            path = SAMPLES[pattern.pattern]
            for method in verbs:
                status, raw, _ = self.call(method, path, b"{}" if method != "GET" else None)
                self.assertEqual(status, 401, "%s %s" % (method, path))
                self.assertEqual(json.loads(raw)["error"], "unauthorized",
                                 "%s %s" % (method, path))

    def test_a_token_the_desk_does_not_know_is_no_better_than_none(self):
        # The same sweep with a credential that is the right shape and not in
        # the file. A route that checked for the presence of a header rather
        # than for a known token would pass the sweep above and fail this one.
        for pattern, verbs in _ROUTES:
            path = SAMPLES[pattern.pattern]
            for method in verbs:
                status, raw, _ = self.call(method, path,
                                           b"{}" if method != "GET" else None,
                                           token="not-a-real-token-aaaaaaaa")
                self.assertEqual(status, 401, "%s %s" % (method, path))
                self.assertEqual(json.loads(raw)["error"], "unauthorized",
                                 "%s %s" % (method, path))


if __name__ == "__main__":
    unittest.main()
