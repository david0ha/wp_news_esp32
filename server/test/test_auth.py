"""What the token file authorises, and -- mostly -- what it does not.

Every test here is a behaviour at the boundary, because that is where this
module can fail in the way that matters. A bug in the schedule prints a page at
the wrong hour; a bug in here lets the internet file one.
"""

from __future__ import annotations

import json
import os
import tempfile
import unittest

from claudepost import auth
from claudepost.errors import DeskError, Forbidden, Unauthorized

# Not credentials. Thirty-two hex characters each so they clear the length
# floor, and obviously fabricated so nobody greps this file and finds a real
# one to try.
PRODUCER = "0000000000000000000000000000beef"
OPERATOR = "1111111111111111111111111111cafe"

GOOD = {"tokens": [{"name": "agent", "scope": "producer", "token": PRODUCER},
                   {"name": "me", "scope": "operator", "token": OPERATOR}]}


class TokenFileTestCase(unittest.TestCase):
    """A temporary directory with a tokens.json in it, or without one."""

    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.path = os.path.join(self.dir.name, "tokens.json")

    def write(self, doc, raw=None):
        with open(self.path, "w", encoding="utf-8") as f:
            f.write(raw if raw is not None else json.dumps(doc))
        return self.path


class MissingFileTest(TokenFileTestCase):
    def test_a_missing_file_is_zero_tokens_and_not_an_exception(self):
        # The desk must start on a machine where the secrets mount is empty.
        # It starts serving the device plane and refusing the control plane,
        # which is a state somebody can diagnose; a crash loop is not.
        t = auth.Tokens(self.path)
        self.assertEqual(t.count(), 0)

    def test_with_no_file_every_credential_is_refused(self):
        t = auth.Tokens(self.path)
        self.assertIsNone(t.scope_for(PRODUCER))
        with self.assertRaises(Unauthorized):
            auth.scope_from_header(t, "Bearer " + PRODUCER)


class HeaderTest(TokenFileTestCase):
    def setUp(self):
        super().setUp()
        self.write(GOOD)
        self.tokens = auth.Tokens(self.path)

    def test_a_known_token_names_its_holder_and_its_scope(self):
        self.assertEqual(auth.scope_from_header(self.tokens, "Bearer " + PRODUCER),
                         ("agent", "producer"))
        self.assertEqual(auth.scope_from_header(self.tokens, "Bearer " + OPERATOR),
                         ("me", "operator"))

    def test_the_scheme_is_matched_without_regard_to_case(self):
        # RFC 7235 says the scheme is case-insensitive, and a client that sends
        # "bearer" is not an attacker, it is curl.
        self.assertEqual(auth.scope_from_header(self.tokens, "bearer " + PRODUCER),
                         ("agent", "producer"))

    def test_no_header_at_all_is_refused(self):
        with self.assertRaises(Unauthorized):
            auth.scope_from_header(self.tokens, None)

    def test_a_header_that_is_not_a_bearer_header_is_refused(self):
        for bad in ("", "   ", PRODUCER, "Token " + PRODUCER, "Bearer",
                    "Bearer ", "Basic " + PRODUCER):
            with self.assertRaises(Unauthorized, msg=bad):
                auth.scope_from_header(self.tokens, bad)

    def test_an_unknown_token_is_refused(self):
        with self.assertRaises(Unauthorized):
            auth.scope_from_header(self.tokens, "Bearer " + "9" * 32)

    def test_a_prefix_of_a_real_token_is_refused(self):
        # The point of hmac.compare_digest: a comparison that stopped at the
        # first differing byte would still be wrong here, but a comparison that
        # stopped at the end of the shorter string would authorise "0".
        self.assertIsNone(self.tokens.scope_for(PRODUCER[:-1]))
        with self.assertRaises(Unauthorized):
            auth.scope_from_header(self.tokens, "Bearer " + PRODUCER[:8])

    def test_a_superstring_of_a_real_token_is_refused(self):
        self.assertIsNone(self.tokens.scope_for(PRODUCER + "0"))

    def test_a_non_ascii_token_is_refused_rather_than_raising(self):
        # compare_digest refuses non-ASCII str outright, so the comparison is
        # done on bytes. A caller that sends a snowman gets a 401, not a 500.
        with self.assertRaises(Unauthorized):
            auth.scope_from_header(self.tokens, "Bearer ☃" + PRODUCER[1:])

    def test_the_holder_can_be_named_without_being_authorised(self):
        self.assertEqual(self.tokens.name_for(OPERATOR), "me")
        self.assertIsNone(self.tokens.name_for("9" * 32))


class ScopeTest(unittest.TestCase):
    def test_the_scopes_are_the_two_the_spec_names(self):
        self.assertEqual(auth.SCOPES, ("producer", "operator"))
        self.assertEqual(set(auth.RANK), set(auth.SCOPES))

    def test_a_scope_satisfies_itself(self):
        for scope in auth.SCOPES:
            auth.require(scope, scope)

    def test_an_operator_satisfies_producer(self):
        auth.require("producer", "operator")

    def test_a_producer_is_refused_where_operator_is_required(self):
        with self.assertRaises(Forbidden):
            auth.require("operator", "producer")

    def test_a_scope_nobody_holds_is_refused(self):
        with self.assertRaises(Forbidden):
            auth.require("operator", "")


class LoadTest(TokenFileTestCase):
    def test_a_malformed_file_is_refused_at_load(self):
        self.write(None, raw="{ this is not json")
        with self.assertRaises(DeskError):
            auth.Tokens(self.path)

    def test_a_malformed_reload_authorises_nobody_rather_than_the_last_good_set(self):
        # The dangerous failure is the one that keeps serving: an editor that
        # truncates the file mid-write must not leave yesterday's tokens live
        # in a process nobody restarts for a month.
        self.write(GOOD)
        t = auth.Tokens(self.path)
        self.assertEqual(t.scope_for(PRODUCER), "producer")
        self.write(None, raw='{"tokens": [{"name": "agent",')
        with self.assertRaises(DeskError):
            t.reload_if_changed()
        self.assertEqual(t.count(), 0)
        self.assertIsNone(t.scope_for(PRODUCER))

    def test_an_unknown_scope_is_refused_at_load(self):
        self.write({"tokens": [{"name": "x", "scope": "admin", "token": PRODUCER}]})
        with self.assertRaises(DeskError):
            auth.Tokens(self.path)

    def test_a_missing_field_is_refused_at_load(self):
        for entry in ({"scope": "producer", "token": PRODUCER},
                      {"name": "x", "token": PRODUCER},
                      {"name": "x", "scope": "producer"},
                      {"name": "", "scope": "producer", "token": PRODUCER},
                      {"name": 7, "scope": "producer", "token": PRODUCER},
                      {"name": "x", "scope": "producer", "token": 7}):
            self.write({"tokens": [entry]})
            with self.assertRaises(DeskError, msg=repr(entry)):
                auth.Tokens(self.path)

    def test_a_document_that_is_not_the_expected_shape_is_refused(self):
        for doc in ([], {}, {"tokens": {}}, {"tokens": ["x"]}, "tokens"):
            self.write(doc)
            with self.assertRaises(DeskError, msg=repr(doc)):
                auth.Tokens(self.path)

    def test_a_guessable_token_is_refused_at_load(self):
        # This service is reachable from the internet through a tunnel. A token
        # short enough to type is short enough to enumerate, and the moment to
        # say so is when it is written, not after.
        self.write({"tokens": [{"name": "x", "scope": "producer", "token": "hunter2"}]})
        with self.assertRaises(DeskError):
            auth.Tokens(self.path)

    def test_two_holders_may_not_share_a_token(self):
        # Otherwise the audit trail says "agent" for something the operator did,
        # and which name it reports depends on file order.
        self.write({"tokens": [{"name": "a", "scope": "producer", "token": PRODUCER},
                               {"name": "b", "scope": "operator", "token": PRODUCER}]})
        with self.assertRaises(DeskError):
            auth.Tokens(self.path)

    def test_no_error_message_ever_repeats_a_token(self):
        # A load error goes to a log that is not as private as the token file.
        self.write({"tokens": [{"name": "x", "scope": "admin", "token": PRODUCER}]})
        with self.assertRaises(DeskError) as caught:
            auth.Tokens(self.path)
        self.assertNotIn(PRODUCER, str(caught.exception))
        self.assertIn("x", str(caught.exception))

    def test_a_changed_file_is_picked_up_without_a_restart(self):
        self.write(GOOD)
        t = auth.Tokens(self.path)
        self.assertEqual(t.count(), 2)
        third = "2222222222222222222222222222f00d"
        self.write({"tokens": GOOD["tokens"] + [
            {"name": "phone", "scope": "operator", "token": third}]})
        t.reload_if_changed()
        self.assertEqual(t.count(), 3)
        self.assertEqual(t.scope_for(third), "operator")

    def test_an_unchanged_file_is_not_reread(self):
        self.write(GOOD)
        t = auth.Tokens(self.path)
        t.reload_if_changed()
        self.assertEqual(t.count(), 2)

    def test_a_file_that_disappears_takes_its_tokens_with_it(self):
        self.write(GOOD)
        t = auth.Tokens(self.path)
        os.unlink(self.path)
        t.reload_if_changed()
        self.assertEqual(t.count(), 0)


if __name__ == "__main__":
    unittest.main()
