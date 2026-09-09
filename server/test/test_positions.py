"""The positions: what the owner actually holds, and what the desk will say
about it.

Two properties carry this module and neither is about accepting a document.

``derive_strategy`` names only what legs can prove. There is no
``covered_call`` and no ``cash_secured_put`` in the enum, because "covered"
needs a stock position this function is never handed and "cash-secured" is a
claim about collateral in an account the desk cannot see. A stored name the
data cannot support is worse than no name at all: the reader stops reading the
legs.

And an ``id`` is derived rather than counted -- a hash over what makes a
position *that* position -- so the same document PUT twice keeps the same ids
without the desk having to remember a counter. Price and note are outside the
hash on purpose, so correcting a typed entry price edits a position instead of
silently forking it into two.
"""

from __future__ import annotations

import datetime
import json
import os
import shutil
import tempfile
import unittest

from claudepost import positions as P
from claudepost.errors import BadRequest


def leg(right, side, strike, expiry="2026-11-21", contracts=1, price=100):
    return {"right": right, "side": side, "strike_cents": strike,
            "expiry": expiry, "contracts": contracts, "entry_price_cents": price}


class StrategyTest(unittest.TestCase):
    def test_single_leg_strategies(self):
        self.assertEqual(P.derive_strategy([leg("call", "long", 42000)]),
                         "long_call")
        self.assertEqual(P.derive_strategy([leg("put", "long", 38000)]),
                         "long_put")
        self.assertEqual(P.derive_strategy([leg("call", "short", 45000)]),
                         "short_call")
        self.assertEqual(P.derive_strategy([leg("put", "short", 35000)]),
                         "short_put")

    def test_a_lone_short_leg_is_named_by_its_legs_and_nothing_else(self):
        """The two names a first draft carried, and why they are gone.

        ``covered_call`` needs the stock position beside the option one, which
        ``derive_strategy(legs)`` is never handed; ``cash_secured_put`` is a
        claim about collateral sitting in an account the desk cannot see.
        Both are display decisions to be made with the whole book in hand, not
        facts a list of legs establishes.
        """
        self.assertEqual(P.derive_strategy([leg("call", "short", 45000)]),
                         "short_call")
        self.assertEqual(P.derive_strategy([leg("put", "short", 35000)]),
                         "short_put")
        self.assertNotIn("covered_call", P.STRATEGIES)
        self.assertNotIn("cash_secured_put", P.STRATEGIES)

    def test_vertical_is_same_right_same_expiry_different_strike(self):
        legs = [leg("call", "long", 40000), leg("call", "short", 42000)]
        self.assertEqual(P.derive_strategy(legs), "vertical")

    def test_calendar_is_same_right_same_strike_different_expiry(self):
        legs = [leg("call", "long", 42000, expiry="2026-11-21"),
                leg("call", "short", 42000, expiry="2026-12-19")]
        self.assertEqual(P.derive_strategy(legs), "calendar")

    def test_straddle_and_strangle(self):
        same = [leg("call", "long", 42000), leg("put", "long", 42000)]
        self.assertEqual(P.derive_strategy(same), "straddle")
        apart = [leg("call", "long", 44000), leg("put", "long", 40000)]
        self.assertEqual(P.derive_strategy(apart), "strangle")

    def test_anything_else_is_custom_not_a_guess(self):
        legs = [leg("call", "long", 40000), leg("put", "short", 38000),
                leg("call", "short", 44000)]
        self.assertEqual(P.derive_strategy(legs), "custom")

    def test_every_name_it_can_return_is_in_the_enum(self):
        """The enum is what the app and the agent branch on, so a name this
        function can emit and the enum does not list is a name nothing
        downstream has a label for."""
        shapes = [
            [leg("call", "long", 42000)],
            [leg("put", "long", 42000)],
            [leg("call", "short", 42000)],
            [leg("put", "short", 42000)],
            [leg("call", "long", 40000), leg("call", "short", 42000)],
            [leg("put", "long", 42000), leg("put", "short", 40000)],
            [leg("call", "long", 42000, expiry="2026-11-21"),
             leg("call", "short", 42000, expiry="2026-12-19")],
            [leg("call", "long", 42000), leg("put", "long", 42000)],
            [leg("call", "long", 44000), leg("put", "long", 40000)],
            [leg("call", "long", 40000), leg("put", "short", 38000),
             leg("call", "short", 44000)],
        ]
        for legs in shapes:
            with self.subTest(legs=legs):
                self.assertIn(P.derive_strategy(legs), P.STRATEGIES)


TODAY = datetime.date(2026, 9, 8)


def option(**over):
    doc = {"symbol": "AAAA", "kind": "option", "opened_at": "2026-08-19",
           "legs": [leg("call", "long", 42000, contracts=2, price=1180)]}
    doc.update(over)
    return doc


def stock(**over):
    doc = {"symbol": "BBBB", "kind": "stock", "quantity": 40,
           "entry_price_cents": 158300, "opened_at": "2026-07-02"}
    doc.update(over)
    return doc


def book(*positions):
    return {"positions": list(positions)}


class ParseTest(unittest.TestCase):
    def parse(self, doc):
        return P.parse_positions(doc, today=TODAY)

    def refuses(self, doc, naming):
        """Assert the document is refused AND that the message names the field.

        The second half is not decoration: this message is rendered in the
        phone's position sheet under the field the owner typed, so a refusal
        that does not name one is a refusal the owner cannot act on.
        """
        with self.assertRaises(BadRequest) as caught:
            self.parse(doc)
        self.assertIn(naming, caught.exception.message or str(caught.exception))

    # -- what a good document does ------------------------------------------

    def test_the_spec_document_round_trips(self):
        out = self.parse(book(option(), stock()))
        self.assertEqual(out["positions"][0]["strategy"], "long_call")
        self.assertEqual(out["positions"][0]["legs"][0]["strike_cents"], 42000)
        self.assertEqual(out["positions"][1]["quantity"], 40)

    def test_an_empty_book_is_a_state_not_an_error(self):
        """The owner closed their last position. That is a thing that happens,
        and refusing it would leave the previous book in force forever."""
        self.assertEqual(self.parse({"positions": []})["positions"], [])
        self.assertEqual(self.parse({})["positions"], [])

    def test_updated_at_is_accepted_as_a_key_and_ignored_as_a_value(self):
        """A caller that GETs this document and PUTs it back must not be
        refused for echoing its own field -- but the instant is the desk's to
        stamp, so what came in is not what goes out."""
        out = self.parse({"updated_at": "1999-01-01T00:00:00Z",
                          "positions": [stock()]})
        self.assertEqual(out["updated_at"], "")

    # -- identity ------------------------------------------------------------

    def test_an_id_survives_a_round_trip(self):
        first = self.parse(book(option(), stock()))
        echoed = {"updated_at": "2026-09-08T05:00:00Z",
                  "positions": [{k: v for k, v in p.items() if k != "strategy"}
                                for p in first["positions"]]}
        second = self.parse(echoed)
        self.assertEqual([p["id"] for p in second["positions"]],
                         [p["id"] for p in first["positions"]])

    def test_correcting_a_price_edits_the_position_rather_than_forking_it(self):
        before = self.parse(book(stock()))["positions"][0]
        after = self.parse(book(stock(entry_price_cents=161200)))["positions"][0]
        self.assertEqual(after["id"], before["id"])

    def test_adding_to_a_holding_does_not_fork_it_either(self):
        """Size is outside the hash, and this one is load-bearing: the event
        book's `affects[].position_id` points at these ids, so a size in the
        material would throw away a morning's research the moment the owner
        bought ten more shares."""
        before = self.parse(book(stock()))["positions"][0]
        after = self.parse(book(stock(quantity=60)))["positions"][0]
        self.assertEqual(after["id"], before["id"])

    def test_going_short_is_a_different_position_from_being_long(self):
        long_ = self.parse(book(stock(quantity=40)))["positions"][0]
        short = self.parse(book(stock(quantity=-40)))["positions"][0]
        self.assertNotEqual(short["id"], long_["id"])

    def test_a_different_strike_is_a_different_position(self):
        a = self.parse(book(option()))["positions"][0]
        b = self.parse(book(option(
            legs=[leg("call", "long", 44000, contracts=2, price=1180)])))
        self.assertNotEqual(b["positions"][0]["id"], a["id"])

    def test_the_same_position_twice_is_refused_rather_than_stored_twice(self):
        self.refuses(book(stock(), stock()), "positions[1]")

    def test_legs_in_the_other_order_are_the_same_position(self):
        """The hash sorts them, because a spread the owner typed bottom-up is
        the same spread."""
        up = self.parse(book(option(legs=[leg("call", "long", 40000),
                                          leg("call", "short", 42000)])))
        down = self.parse(book(option(legs=[leg("call", "short", 42000),
                                            leg("call", "long", 40000)])))
        self.assertEqual(down["positions"][0]["id"], up["positions"][0]["id"])

    # -- refusals ------------------------------------------------------------

    def test_strategy_is_accepted_and_ignored_like_the_id(self):
        """Both are output only and both are re-derived, so neither is refused.

        The earlier draft refused a body carrying `strategy`, and the refusal
        was a 400 that rejected the whole book -- on the ordinary path, because
        every client round-trips this document and every option position a GET
        returns carries one. A supplied value that is overwritten anyway does
        not need a refusal; it needs ignoring.
        """
        out = self.parse(book(option(strategy="straddle"),
                              stock(id="p_000000")))
        self.assertEqual(out["positions"][0]["strategy"], "long_call")
        self.assertNotEqual(out["positions"][1]["id"], "p_000000")

    def test_what_a_get_returns_can_be_put_straight_back(self):
        """The property the two fields above exist to give. A client that
        changes nothing must be able to send back exactly what it was handed."""
        first = self.parse(book(option(), stock()))
        echoed = {"updated_at": "2026-09-08T05:00:00Z",
                  "positions": [dict(p) for p in first["positions"]]}
        second = self.parse(echoed)
        self.assertEqual(second["positions"], first["positions"])

    def test_a_genuinely_unknown_key_is_still_refused(self):
        """Only those two stopped being unknown."""
        self.refuses(book(option(delta=0.6)), "unknown key")

    def test_a_stock_may_not_carry_legs_and_an_option_may_not_carry_a_quantity(self):
        self.refuses(book(stock(legs=[leg("call", "long", 42000)])), "legs")
        self.refuses(book(option(quantity=40)), "quantity")
        self.refuses(book(option(entry_price_cents=1180)), "entry_price_cents")

    def test_zero_is_the_absence_of_a_position(self):
        self.refuses(book(stock(quantity=0)), "quantity")

    def test_a_leg_must_be_a_real_contract(self):
        self.refuses(book(option(legs=[leg("call", "long", 0)])),
                     "strike_cents")
        self.refuses(book(option(legs=[leg("call", "long", 42000,
                                           contracts=0)])), "contracts")
        self.refuses(book(option(legs=[leg("call", "long", 42000,
                                           expiry="2026-02-30")])), "expiry")
        self.refuses(book(option(legs=[leg("call", "long", 42000,
                                           expiry="2031-01-17")])), "expiry")
        self.refuses(book(option(legs=[])), "legs")
        self.refuses(book(option(legs=[leg("call", "long", 42000)] * 5)),
                     "legs")

    def test_the_expiry_horizon_survives_the_twenty_ninth_of_february(self):
        """`date.replace(year=...)` raises rather than rounding, and leap+3 is
        never a leap year -- so on one day every four years this turned every
        PUT carrying an option leg into a 500, on a route whose every other
        refusal is a 400. Found by the phone's own form, not by this suite."""
        leap = datetime.date(2028, 2, 29)
        out = P.parse_positions(book(option()), today=leap)
        self.assertEqual(len(out["positions"]), 1)
        with self.assertRaises(BadRequest):
            P.parse_positions(
                book(option(legs=[leg("call", "long", 42000,
                                      expiry="2031-06-20")])), today=leap)

    def test_a_boolean_is_not_a_quantity(self):
        """`True` is an `int` in Python, so without an explicit refusal a
        document saying `"quantity": true` becomes a position of one."""
        self.refuses(book(stock(quantity=True)), "quantity")

    def test_a_symbol_is_refused_rather_than_canonicalised(self):
        """It is hash material, so an upper-casing rule here is a rule the app
        has to implement identically or disagree about which position it is
        looking at."""
        self.refuses(book(stock(symbol="bbbb")), "symbol")
        self.refuses(book(stock(symbol="")), "symbol")
        self.refuses(book(stock(symbol="TOOLONGASYMBOL")), "symbol")

    def test_an_unknown_key_is_refused_at_every_depth(self):
        self.refuses({"positions": [], "stop_loss": 100}, "unknown key")
        self.refuses(book(stock(pnl=42)), "unknown key")
        bad_leg = leg("call", "long", 42000)
        bad_leg["delta"] = 0.6
        self.refuses(book(option(legs=[bad_leg])), "unknown key")

    def test_a_note_is_the_owners_words_not_an_edition(self):
        self.refuses(book(stock(note="x" * 501)), "note")

    def test_sixty_five_positions_is_a_mistake_not_a_book(self):
        many = [stock(symbol="A%03d" % i) for i in range(65)]
        self.refuses({"positions": many}, "at most")


class FileTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.path = os.path.join(self.dir, "positions.json")

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def write(self, doc):
        stamped = {**doc, "updated_at": "2026-09-08T05:00:00Z"}
        P.save(self.path, stamped)

    def test_nobody_has_told_the_desk_yet(self):
        self.assertIsNone(P.load(self.path))

    def test_a_saved_document_loads_back_identically(self):
        doc = P.parse_positions(book(option(), stock()), today=TODAY)
        self.write(doc)
        back = P.load(self.path)
        self.assertEqual(back["positions"], doc["positions"])
        self.assertEqual(back["updated_at"], "2026-09-08T05:00:00Z")

    def test_the_desk_does_not_refuse_its_own_writing(self):
        """`save` writes `strategy`; a body carrying one is refused. Without
        the strip in `load`, the desk would decline the file it wrote itself --
        silently, because `load` answers None either way."""
        doc = P.parse_positions(book(option()), today=TODAY)
        self.write(doc)
        raw = json.loads(open(self.path).read())
        self.assertIn("strategy", raw["positions"][0])   # it IS written
        self.assertIsNotNone(P.load(self.path))          # and still readable

    def test_the_file_is_not_world_readable(self):
        """A watchlist is a list of companies. This is a list of trades."""
        self.write(P.parse_positions(book(stock()), today=TODAY))
        self.assertEqual(os.stat(self.path).st_mode & 0o077, 0)

    def test_a_file_that_will_not_parse_is_left_where_it_is(self):
        with open(self.path, "w") as f:
            f.write("{not json")
        self.assertIsNone(P.load(self.path))
        self.assertTrue(os.path.exists(self.path))

    def test_the_shipped_example_is_a_document_this_module_accepts(self):
        """And carries no real ticker -- this repository holds nothing
        personal, and an example is the easiest place to leak one."""
        here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        example = os.path.join(here, "positions.example.json")
        loaded = P.load(example)
        self.assertIsNotNone(loaded)
        for pos in loaded["positions"]:
            self.assertRegex(pos["symbol"], r"^[A-D]{4}$")


if __name__ == "__main__":
    unittest.main()
