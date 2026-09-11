"""The phones we notify: one document, one POST, and one deletion.

Most of this file is a document validator like any other on this desk. Two
tests are the reason the module exists in the shape it does.

``test_an_http_failure_removes_nothing`` is the first. The only destructive
thing this code can do is forget a phone, and the only legitimate reason to do
it is Expo saying the phone is gone. A network blip that removed a device would
be silent in both directions: nothing logs, and a pruned phone looks exactly
like one that was never registered, so the owner simply stops being told about
their own expiries and has no way to notice.

``test_the_ticket_join_is_all_or_nothing`` is the second. Expo answers with one
ticket per message in order and its error details do not reliably name the
token, so the join is positional -- which means a length mismatch is not a
detail, it is a ``DeviceNotRegistered`` verdict landing on whichever phone sits
at that index.

Nothing here is a real push token. The three below are obviously invented, for
the same reason ``test_quotes.py``'s Alpaca key is: a token is a capability,
and this repository is public.
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import tempfile
import unittest
import urllib.error

from claudepost import push as P
from claudepost.calendar import COMPUTED_KINDS, KINDS as CALENDAR_KINDS
from claudepost.errors import BadRequest, Upstream
from claudepost.fsutil import json_bytes

# The module warns when a send fails and when a file will not parse, both of
# which tests here provoke on purpose. Without a handler those warnings print
# to stderr and a passing run reads like a failing one -- the same reason
# test_quotes.py and test_watchlist.py add this.
logging.getLogger("claudepost.push").addHandler(logging.NullHandler())

HERE = os.path.dirname(__file__)
RECEIPT = os.path.join(HERE, "fixtures", "expo_push_receipt.json")

#: Not push tokens. Shaped like Expo's so the pattern is exercised at a
#: realistic length, and obviously fabricated so nobody greps this repository
#: and finds a lock screen to write on. ``TOKEN_B`` is the one the committed
#: receipt fixture reports as unregistered.
TOKEN_A = "ExponentPushToken[0000000000AAAAAAAAAA]"
TOKEN_B = "ExponentPushToken[0000000000BBBBBBBBBB]"
TOKEN_C = "ExpoPushToken[0000000000CCCCCCCCCC]"

#: The document as the design states it, field for field. Every other case in
#: this file is this one with something wrong.
SPEC_DEVICE = {
    "token": TOKEN_A,
    "platform": "ios",
    "tz": "Asia/Seoul",
    "prefs": {"earnings": True, "expiry": True, "dividend": True,
              "econ": True, "researched": True, "answer": True},
    "lead": {"earnings": ["P1D"], "expiry": ["P7D", "P1D"],
             "dividend": ["P1D"], "econ": ["PT3H"],
             "researched": ["P1D"]},
    "quiet": {"from": "23:00", "to": "07:00"},
    "last_seen": "2026-09-08T05:00:00Z",
}


def device(token=TOKEN_A, **over):
    """One device, valid unless a keyword makes it otherwise."""
    out = dict(SPEC_DEVICE, token=token)
    out.update(over)
    return out


def doc(*devices):
    return {"devices": list(devices)}


def message(token, body="expiry in a week"):
    """What the scheduler hands :func:`push.send`. Only ``to`` is read here."""
    return {"to": token, "title": "Claude Post", "body": body}


class FakeExpo:
    """A recorded POST, answering with one ``ok`` ticket per message.

    ``answer`` replaces the generated body; ``fail`` makes the call raise, the
    way a refused connection or a 400 does.
    """

    def __init__(self, answer: bytes | None = None,
                 fail: Exception | None = None) -> None:
        self.calls: list[dict] = []
        self._answer = answer
        self._fail = fail

    def __call__(self, url, headers, body):
        self.calls.append({"url": url, "headers": headers, "body": body})
        if self._fail is not None:
            raise self._fail
        if self._answer is not None:
            return self._answer
        sent = json.loads(body)
        return json.dumps({"data": [{"status": "ok", "id": f"t{i}"}
                                    for i in range(len(sent))]}).encode()


# --------------------------------------------------------------------------
# The document
# --------------------------------------------------------------------------

class DocumentTest(unittest.TestCase):

    def test_the_design_document_round_trips(self):
        self.assertEqual(P.parse_devices(doc(SPEC_DEVICE)),
                         doc(SPEC_DEVICE))

    def test_no_devices_is_a_state_not_an_error(self):
        self.assertEqual(P.parse_devices({}), {"devices": []})
        self.assertEqual(P.parse_devices({"devices": []}), {"devices": []})

    def test_a_device_with_every_pref_off_is_a_state_not_an_error(self):
        """The owner turned everything off. That is a setting, not a mistake,
        and refusing it would be the desk arguing with a switch it drew."""
        off = {kind: False for kind in P.KINDS}
        out = P.parse_devices(doc(device(prefs=off)))
        self.assertEqual(out["devices"][0]["prefs"], off)

    def test_every_kind_the_book_can_carry_answers_to_some_switch(self):
        """The rule, stated the way round it has to be applied: a kind with no
        switch is a kind the owner cannot turn off -- AND a kind that can never
        fire. An earlier draft made the switch set the four computed kinds
        alone, which left the book's other four with neither.

        Six switches now, not five: `answer` is the first push that is not
        about a dated event, and it gets a switch for the same reason. It is
        deliberately *not* in `LEAD_KINDS`, because a lead is "how long before
        the date" and an answer has no date -- it happens when it happens.
        """
        self.assertEqual(set(P.KINDS),
                         set(COMPUTED_KINDS) | {P.RESEARCHED, P.ANSWER})
        self.assertEqual(set(P.LEAD_KINDS), set(COMPUTED_KINDS) | {P.RESEARCHED})
        self.assertEqual(set(P.DEFAULT_LEAD), set(P.LEAD_KINDS))
        out = P.parse_devices(doc(device()))
        self.assertEqual(set(out["devices"][0]["prefs"]), set(P.KINDS))
        self.assertEqual(set(out["devices"][0]["lead"]), set(P.LEAD_KINDS))

        # And every kind the book may carry lands on one of them.
        for kind in CALENDAR_KINDS:
            with self.subTest(kind=kind):
                self.assertIn(P.pref_for(kind), P.KINDS)

    def test_the_answer_keeps_its_own_switch(self):
        self.assertEqual(P.pref_for(P.ANSWER), P.ANSWER)

    def test_a_computed_kind_keeps_its_own_switch(self):
        for kind in COMPUTED_KINDS:
            self.assertEqual(P.pref_for(kind), kind)

    def test_everything_somebody_had_to_find_shares_one_switch(self):
        for kind in set(CALENDAR_KINDS) - set(COMPUTED_KINDS):
            with self.subTest(kind=kind):
                self.assertEqual(P.pref_for(kind), P.RESEARCHED)

    def test_an_absent_switch_is_on(self):
        out = P.parse_devices(doc(device(prefs={"econ": False})))
        self.assertEqual(out["devices"][0]["prefs"],
                         {"earnings": True, "expiry": True, "dividend": True,
                          "econ": False, P.RESEARCHED: True, P.ANSWER: True})

    def test_a_lead_for_the_answer_is_not_a_field(self):
        """A lead names how long before a date to say something, and an answer
        has no date. Accepting one would store a number nothing can read."""
        with self.assertRaises(BadRequest) as caught:
            P.parse_devices(doc(device(lead={P.ANSWER: ["P1D"]})))
        self.assertIn("lead", caught.exception.message)

    def test_a_string_is_not_a_switch(self):
        with self.assertRaises(BadRequest) as caught:
            P.parse_devices(doc(device(prefs={"econ": "false"})))
        self.assertIn("prefs.econ", caught.exception.message)

    def test_an_absent_lead_is_the_default_and_an_empty_one_is_none(self):
        """The one place in this document where absence and emptiness differ.
        An app that clears every lead has to be able to say so without the
        desk restoring what it just cleared."""
        absent = P.parse_devices(doc(device(lead={})))["devices"][0]["lead"]
        self.assertEqual(absent["expiry"], ["P7D", "P1D"])
        cleared = P.parse_devices(
            doc(device(lead={"expiry": []})))["devices"][0]["lead"]
        self.assertEqual(cleared["expiry"], [])
        self.assertEqual(cleared["earnings"], ["P1D"])

    def test_leads_are_stored_longest_first(self):
        out = P.parse_devices(doc(device(lead={"expiry": ["P1D", "P7D"]})))
        self.assertEqual(out["devices"][0]["lead"]["expiry"], ["P7D", "P1D"])

    def test_an_unknown_lead_is_refused_naming_the_field(self):
        for bad in ("P3D", "PT2H", "P1DT1H", "1d", "", 86400):
            with self.subTest(lead=bad):
                with self.assertRaises(BadRequest) as caught:
                    P.parse_devices(doc(device(lead={"earnings": [bad]})))
                self.assertIn("lead.earnings[0]", caught.exception.message)

    def test_the_closed_set_is_the_six_the_table_can_convert(self):
        """A general ISO-8601 parser is surface area for six values. The set
        and the arithmetic are one table, so neither can gain a value the
        other has not heard of."""
        self.assertEqual(set(P.LEAD_SECONDS),
                         {"PT1H", "PT3H", "PT12H", "P1D", "P2D", "P7D"})
        self.assertEqual(P.LEAD_SECONDS["P7D"], 7 * 86400)
        self.assertEqual(P.LEAD_SECONDS["PT3H"], 3 * 3600)

    def test_the_same_lead_twice_is_refused(self):
        with self.assertRaises(BadRequest) as caught:
            P.parse_devices(doc(device(lead={"expiry": ["P1D", "P1D"]})))
        self.assertIn("lead.expiry[1]", caught.exception.message)

    def test_a_malformed_token_is_refused_naming_the_field(self):
        for bad in ("ExponentPushToken[]", "ExponentPushToken[abc",
                    "not-a-token", "ExponentPushToken[a b]", "", 42, None):
            with self.subTest(token=bad):
                with self.assertRaises(BadRequest) as caught:
                    P.parse_devices(doc(device(token=bad)))
                self.assertIn("token", caught.exception.message)

    def test_both_spellings_of_the_token_are_accepted(self):
        """Expo has issued `ExpoPushToken[...]` alongside the older
        `ExponentPushToken[...]`; a desk that knows one refuses a real
        phone."""
        out = P.parse_devices(doc(device(token=TOKEN_C)))
        self.assertEqual(out["devices"][0]["token"], TOKEN_C)

    def test_a_quiet_window_must_be_a_clock(self):
        for bad in ("25:00", "7:00", "23h00", "23:60", "2300", "", None, 23):
            with self.subTest(clock=bad):
                with self.assertRaises(BadRequest) as caught:
                    P.parse_devices(
                        doc(device(quiet={"from": bad, "to": "07:00"})))
                self.assertIn("quiet.from", caught.exception.message)

    def test_a_quiet_window_may_wrap_midnight_but_not_have_zero_width(self):
        out = P.parse_devices(doc(device(quiet={"from": "23:00",
                                                "to": "07:00"})))
        self.assertEqual(out["devices"][0]["quiet"],
                         {"from": "23:00", "to": "07:00"})
        with self.assertRaises(BadRequest) as caught:
            P.parse_devices(doc(device(quiet={"from": "07:00",
                                              "to": "07:00"})))
        self.assertIn("quiet", caught.exception.message)

    def test_no_quiet_window_is_no_key_rather_than_an_empty_one(self):
        out = P.parse_devices(doc(device(quiet=None)))
        self.assertNotIn("quiet", out["devices"][0])

    def test_the_platform_is_one_of_two(self):
        with self.assertRaises(BadRequest) as caught:
            P.parse_devices(doc(device(platform="web")))
        self.assertIn("platform", caught.exception.message)

    def test_a_zone_the_desk_cannot_resolve_is_refused(self):
        """Resolved here rather than at first use: a zone that throws inside
        the scheduler tick is a text file that took the desk down."""
        for bad in ("Asia/Nowhere", "KST", "", None):
            with self.subTest(tz=bad):
                with self.assertRaises(BadRequest) as caught:
                    P.parse_devices(doc(device(tz=bad)))
                self.assertIn("tz", caught.exception.message)

    def test_last_seen_is_an_instant_or_nothing(self):
        out = P.parse_devices(doc(device(last_seen=None)))
        self.assertEqual(out["devices"][0]["last_seen"], "")
        with self.assertRaises(BadRequest) as caught:
            P.parse_devices(doc(device(last_seen="2026-09-08 05:00:00")))
        self.assertIn("last_seen", caught.exception.message)

    def test_an_unknown_key_is_refused_at_every_depth(self):
        cases = [
            ({"devices": [], "updated_at": "2026-09-08T05:00:00Z"}, "push"),
            (doc(dict(device(), sound="chime")), "devices[0]"),
            (doc(device(prefs={"corporate": True})), "prefs"),
            (doc(device(lead={"corporate": ["P1D"]})), "lead"),
            (doc(device(quiet={"from": "23:00", "to": "07:00", "tz": "UTC"})),
             "quiet"),
        ]
        for body, where in cases:
            with self.subTest(where=where):
                with self.assertRaises(BadRequest) as caught:
                    P.parse_devices(body)
                self.assertIn("unknown key", caught.exception.message)
                self.assertIn(where, caught.exception.message)

    def test_nine_devices_is_a_registration_route_being_hammered(self):
        eight = [device(f"ExponentPushToken[000000000{i}AAAAAAAAAA]")
                 for i in range(P.MAX_DEVICES)]
        self.assertEqual(len(P.parse_devices(doc(*eight))["devices"]),
                         P.MAX_DEVICES)
        ninth = device("ExponentPushToken[0000000009AAAAAAAAAA]")
        with self.assertRaises(BadRequest) as caught:
            P.parse_devices(doc(*eight, ninth))
        self.assertIn("devices", caught.exception.message)

    def test_the_same_phone_twice_is_refused(self):
        with self.assertRaises(BadRequest) as caught:
            P.parse_devices(doc(device(TOKEN_A), device(TOKEN_A)))
        self.assertIn("devices[1]", caught.exception.message)

    def test_a_refused_document_is_refused_whole(self):
        """There is no half-registered household: the route replaces the list,
        so a partial apply is a phone missing with nothing to notice it."""
        with self.assertRaises(BadRequest):
            P.parse_devices(doc(device(TOKEN_A), device(TOKEN_B,
                                                        platform="web")))

    def test_the_cap_weighs_the_stamp_the_caller_is_about_to_add(self):
        """The watchlist's trap, in this document's spelling.

        A device may arrive with no ``last_seen`` and be written with one. A
        cap weighing what arrived rather than what is written is a document a
        PUT accepts and the next boot's ``load`` refuses -- silently, because
        ``None`` is also what ``load`` answers for a desk nobody has told.
        """
        body = doc(device(last_seen=None))
        parsed = P.parse_devices(body)
        bare = len(json_bytes(parsed))
        stamped = len(json_bytes({"devices": [
            dict(one, last_seen="2026-09-08T05:00:00Z")
            for one in parsed["devices"]]}))
        self.assertGreater(stamped, bare)

        original = P.MAX_DOC_BYTES
        try:
            P.MAX_DOC_BYTES = stamped
            P.parse_devices(body)          # exactly the written size: accepted
            P.MAX_DOC_BYTES = stamped - 1
            with self.assertRaises(BadRequest) as caught:
                P.parse_devices(body)
            self.assertIn("bytes serialised", caught.exception.message)
        finally:
            P.MAX_DOC_BYTES = original


# --------------------------------------------------------------------------
# The file
# --------------------------------------------------------------------------

class FileTest(unittest.TestCase):

    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.path = os.path.join(self.dir, "push.json")

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def test_nobody_has_told_the_desk_yet(self):
        self.assertIsNone(P.load(self.path))

    def test_a_saved_document_loads_back_identically(self):
        parsed = P.parse_devices(doc(SPEC_DEVICE, device(TOKEN_B,
                                                         platform="android")))
        P.save(self.path, parsed)
        self.assertEqual(P.load(self.path), parsed)

    def test_the_desk_does_not_refuse_its_own_writing(self):
        """Parse, stamp, save, load -- the round trip the registration route
        makes on every check-in."""
        parsed = P.parse_devices(doc(device(last_seen=None)))
        parsed["devices"][0]["last_seen"] = "2026-09-08T05:00:00Z"
        P.save(self.path, parsed)
        self.assertEqual(P.load(self.path), parsed)

    def test_the_file_is_not_world_readable(self):
        """A token is a capability: whoever holds it can write on the owner's
        lock screen."""
        P.save(self.path, P.parse_devices(doc(SPEC_DEVICE)))
        self.assertEqual(os.stat(self.path).st_mode & 0o777, 0o600)

    def test_a_file_that_will_not_parse_is_left_where_it_is(self):
        with open(self.path, "w", encoding="utf-8") as f:
            f.write('{"devices": [{"token": "nope"}]}')
        self.assertIsNone(P.load(self.path))
        self.assertTrue(os.path.exists(self.path))

    def test_a_file_over_the_cap_is_not_handed_to_a_parser(self):
        with open(self.path, "wb") as f:
            f.write(b"[" + b" " * (P.MAX_DOC_BYTES + 1))
        self.assertIsNone(P.load(self.path))


# --------------------------------------------------------------------------
# Sending
# --------------------------------------------------------------------------

class SendTest(unittest.TestCase):

    def test_a_hundred_at_a_time(self):
        """Expo refuses a body over its limit, so a batch of 101 is 101
        notifications nobody gets."""
        expo = FakeExpo()
        tickets = P.send([message(TOKEN_A)] * 250, fetch=expo)
        self.assertEqual(len(expo.calls), 3)
        self.assertEqual([len(json.loads(c["body"])) for c in expo.calls],
                         [100, 100, 50])
        self.assertEqual(len(tickets), 250)

    def test_exactly_a_hundred_is_one_call(self):
        expo = FakeExpo()
        P.send([message(TOKEN_A)] * 100, fetch=expo)
        self.assertEqual(len(expo.calls), 1)

    def test_nothing_to_announce_is_not_a_request(self):
        expo = FakeExpo()
        self.assertEqual(P.send([], fetch=expo), [])
        self.assertEqual(expo.calls, [])

    def test_the_body_is_a_json_array_and_the_headers_say_so(self):
        expo = FakeExpo()
        P.send([message(TOKEN_A), message(TOKEN_B)], fetch=expo)
        call = expo.calls[0]
        self.assertEqual(call["url"], "https://exp.host/--/api/v2/push/send")
        sent = json.loads(call["body"])
        self.assertIsInstance(sent, list)
        self.assertEqual([one["to"] for one in sent], [TOKEN_A, TOKEN_B])
        self.assertEqual(call["headers"]["content-type"], "application/json")
        self.assertEqual(call["headers"]["accept-encoding"], "gzip, deflate")

    def test_a_ticket_carries_the_token_it_answers_for(self):
        """Expo answers in order and its error details do not reliably name
        the token, so the join is positional and is made where both lists are
        in hand."""
        expo = FakeExpo()
        tickets = P.send([message(TOKEN_A), message(TOKEN_B)], fetch=expo)
        self.assertEqual([one["to"] for one in tickets], [TOKEN_A, TOKEN_B])

    def test_the_ticket_join_is_all_or_nothing(self):
        """A length mismatch means the position means nothing. Joining anyway
        would land a DeviceNotRegistered verdict on whichever phone happened
        to sit at that index."""
        expo = FakeExpo(answer=json.dumps(
            {"data": [{"status": "ok", "id": "t0"}]}).encode())
        tickets = P.send([message(TOKEN_A), message(TOKEN_B)], fetch=expo)
        self.assertEqual(len(tickets), 1)
        self.assertNotIn("to", tickets[0])

    def test_a_body_carrying_no_tickets_is_an_upstream_failure(self):
        """Expo reports a request-level refusal as `{"errors": [...]}` and an
        outage in front of it as an HTML page with a 200. Taking either as
        "no tickets" would report a silent success."""
        for answer in (b'{"errors": [{"code": "PUSH_TOO_MANY_NOTIFICATIONS"}]}',
                       b"<html>502 Bad Gateway</html>",
                       b'[]'):
            with self.subTest(answer=answer[:20]):
                expo = FakeExpo(answer=answer)
                with self.assertRaises(Upstream):
                    P.send([message(TOKEN_A)], fetch=expo)

    def test_the_token_never_reaches_the_message(self):
        """There is no API key here, so it looks as though there is nothing to
        redact. The token itself is the credential: it is what goes into the
        body, and an upstream error quotes what it was handed."""
        blew_up = urllib.error.HTTPError(
            P.EXPO_PUSH_URL, 400,
            f'Bad Request: "{TOKEN_A}" is malformed', {}, None)
        expo = FakeExpo(fail=blew_up)
        with self.assertRaises(Upstream) as caught:
            P.send([message(TOKEN_A)], fetch=expo)
        self.assertNotIn(TOKEN_A, caught.exception.message)
        self.assertNotIn(TOKEN_A, str(caught.exception))
        self.assertIn(P.REDACTED, caught.exception.message)
        self.assertEqual(caught.exception.status, 502)

    def test_a_failed_batch_aborts_the_send(self):
        """A partial run reported as a complete one is a prune pass acting on
        a ticket list missing most of its phones."""
        expo = FakeExpo(fail=OSError("connection refused"))
        with self.assertRaises(Upstream):
            P.send([message(TOKEN_A)] * 150, fetch=expo)


# --------------------------------------------------------------------------
# Removing a phone that is gone
# --------------------------------------------------------------------------

class PruneTest(unittest.TestCase):

    def setUp(self):
        self.doc = P.parse_devices(doc(device(TOKEN_A), device(TOKEN_B),
                                       device(TOKEN_C)))

    def tickets_from_fixture(self):
        """The committed receipt, delivered as tickets for two messages.

        Run through ``send`` rather than read straight off the disk, so the
        positional join this module depends on is part of what the fixture
        tests.
        """
        with open(RECEIPT, "rb") as f:
            raw = f.read()
        expo = FakeExpo(answer=raw)
        return P.send([message(TOKEN_A), message(TOKEN_B)], fetch=expo)

    def test_the_fixture_reports_one_delivery_and_one_dead_phone(self):
        tickets = self.tickets_from_fixture()
        self.assertEqual([one["status"] for one in tickets], ["ok", "error"])
        self.assertEqual(tickets[1]["details"]["error"], "DeviceNotRegistered")

    def test_an_unregistered_ticket_removes_exactly_that_phone(self):
        pruned, removed = P.prune_unregistered(self.doc,
                                               self.tickets_from_fixture())
        self.assertEqual(removed, [TOKEN_B])
        self.assertEqual([one["token"] for one in pruned["devices"]],
                         [TOKEN_A, TOKEN_C])

    def test_the_document_handed_in_is_not_modified(self):
        before = json.dumps(self.doc, sort_keys=True)
        P.prune_unregistered(self.doc, self.tickets_from_fixture())
        self.assertEqual(json.dumps(self.doc, sort_keys=True), before)

    def test_an_http_failure_removes_nothing(self):
        """The one destructive thing this module does, and the one thing that
        must never be a network blip. A pruned phone is indistinguishable from
        one that was never registered, so the owner just stops being told."""
        expo = FakeExpo(fail=urllib.error.URLError("connection refused"))
        with self.assertRaises(Upstream):
            P.send([message(TOKEN_A), message(TOKEN_B)], fetch=expo)
        pruned, removed = P.prune_unregistered(self.doc, [])
        self.assertEqual(removed, [])
        self.assertEqual([one["token"] for one in pruned["devices"]],
                         [TOKEN_A, TOKEN_B, TOKEN_C])

    def test_only_device_not_registered_removes_anything(self):
        """Every other error Expo reports is about this notification -- a
        message too large, a rate limit -- and deleting a phone over one of
        those is deleting it over a bad afternoon."""
        for code in ("MessageTooBig", "MessageRateExceeded",
                     "InvalidCredentials", None):
            with self.subTest(error=code):
                ticket = {"status": "error", "to": TOKEN_B,
                          "details": {"error": code} if code else {}}
                _, removed = P.prune_unregistered(self.doc, [ticket])
                self.assertEqual(removed, [])

    def test_an_ok_ticket_removes_nothing(self):
        tickets = [{"status": "ok", "id": "t0", "to": TOKEN_A}]
        pruned, removed = P.prune_unregistered(self.doc, tickets)
        self.assertEqual(removed, [])
        self.assertEqual(len(pruned["devices"]), 3)

    def test_a_ticket_for_a_phone_already_gone_removes_nothing(self):
        gone = "ExponentPushToken[0000000000DDDDDDDDDD]"
        tickets = [{"status": "error", "to": gone,
                    "details": {"error": "DeviceNotRegistered"}}]
        pruned, removed = P.prune_unregistered(self.doc, tickets)
        self.assertEqual(removed, [])
        self.assertEqual(len(pruned["devices"]), 3)

    def test_the_token_falls_back_to_expos_own_when_there_is_no_join(self):
        """Unjoined tickets still name a phone when Expo bothered to. The
        fallback is second because Expo's presence of that field is not a
        contract; the positional join is what this module relies on."""
        tickets = [{"status": "error",
                    "details": {"error": "DeviceNotRegistered",
                                "expoPushToken": TOKEN_C}}]
        _, removed = P.prune_unregistered(self.doc, tickets)
        self.assertEqual(removed, [TOKEN_C])

    def test_a_ticket_naming_no_phone_removes_none(self):
        tickets = [{"status": "error",
                    "details": {"error": "DeviceNotRegistered"}},
                   "not even a ticket"]
        _, removed = P.prune_unregistered(self.doc, tickets)
        self.assertEqual(removed, [])

    def test_the_result_is_a_document_parse_devices_still_accepts(self):
        pruned, _ = P.prune_unregistered(self.doc, self.tickets_from_fixture())
        self.assertEqual(P.parse_devices(pruned), pruned)


if __name__ == "__main__":
    unittest.main()
