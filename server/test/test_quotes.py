"""The quotes proxy: integer money, a cache with two clocks, and one secret.

Most of this file is arithmetic and caching, and one test is the reason the
module exists at all. The desk proxies Alpaca so that the Alpaca key never
sits on a phone -- so the interesting failure is not a wrong number, it is a
*right* number delivered alongside the credential that fetched it. A 502 whose
``detail`` echoes an exception that echoed a request header would put the key
in the phone's error toast, in the desk's log, and in whatever the owner
pastes into an issue.
``test_the_secret_never_reaches_the_message`` is that test, and every other one
here is what has to keep working while it holds.

The two snapshot fixtures are not belt-and-braces. Alpaca has shipped the
multi-symbol snapshot response both as a bare ``{SYMBOL: {...}}`` map (which is
what the current reference for ``GET /v2/stocks/snapshots`` documents) and
wrapped under a ``"snapshots"`` key beside a ``next_page_token``. A parser that
knows only the shape that was live on the day it was written is a parser that
breaks on an afternoon when nobody deployed anything.

Nothing here is a credential. The key and secret below are obviously
fabricated, for the same reason ``test_auth.py``'s tokens are: so that nobody
greps this repository and finds something to try.
"""

from __future__ import annotations

import json
import logging
import os
import tempfile
import unittest

from claudepost import quotes as Q
from claudepost.clock import FixedClock
from claudepost.errors import DeskError, NotFound

# The module warns when the upstream fails and when the credentials file will
# not parse, both of which tests here provoke on purpose. Without a handler
# those warnings print to stderr and a passing run reads like a failing one --
# the same reason test_watchlist.py and test_schedulefile.py add this.
logging.getLogger("claudepost.quotes").addHandler(logging.NullHandler())

#: Not credentials. Shaped like Alpaca's (a ``PK``-prefixed id, a longer
#: secret) so the redaction test exercises realistic lengths, and obviously
#: fake so nobody tries them.
KEY_ID = "PK0000000000NOTAREAL"
SECRET = "0000000000000000000000000000000000000fake"

#: A made-up company at made-up prices. The three numbers are the ones in
#: docs/app-control.md's example, so the arithmetic here and the arithmetic the
#: board does can be read side by side: 241.60 against a 231.84 previous close
#: is +4.21%, which is 421 basis points.
LAST = 241.60
DAILY = 240.00
PREV = 231.84


def snapshot(last: float | None = LAST, daily: float | None = DAILY,
             prev: float | None = PREV) -> dict:
    """One symbol's snapshot, carrying only the fields the desk reads.

    A real snapshot also has ``latestQuote`` and ``minuteBar``; leaving them
    out is deliberate, because a parser that needs a field it does not use is
    a parser that breaks when Alpaca stops sending it.
    """
    doc: dict = {}
    if last is not None:
        doc["latestTrade"] = {"p": last, "t": "2026-08-25T19:59:59.9Z", "s": 100}
    if daily is not None:
        doc["dailyBar"] = {"o": 238.0, "h": 242.0, "l": 237.5, "c": daily, "v": 1}
    if prev is not None:
        doc["prevDailyBar"] = {"o": 230.0, "h": 232.0, "l": 229.0, "c": prev, "v": 1}
    return doc


def bare(**symbols: dict) -> dict:
    """The envelope the current reference documents: a bare symbol map."""
    return dict(symbols)


def wrapped(**symbols: dict) -> dict:
    """The envelope that has also shipped: symbols under a ``snapshots`` key."""
    return {"snapshots": dict(symbols), "next_page_token": None}


def bars(*closes: float, symbol: str = "ACME") -> dict:
    """A bars envelope, newest first -- which is how the desk asks for them.

    The dates count *backwards* from the 25th along with the closes, so a test
    that asserts on the order is asserting on something the fixture could get
    wrong rather than on a coincidence.
    """
    series = [{"t": f"2026-08-{25 - i:02d}T04:00:00Z", "o": 1.0, "h": 1.0,
               "l": 1.0, "c": c, "v": 1, "n": 1, "vw": c}
              for i, c in enumerate(closes)]
    return {"bars": {symbol: series}, "next_page_token": None}


class Fetches:
    """A stand-in for ``_urlopen_fetch``: records the calls, answers from a table.

    It answers by URL prefix rather than by call order, because the service is
    free to skip a fetch it has cached and a stub keyed on order would then
    hand the wrong document to the wrong parser and fail for the wrong reason.
    """

    def __init__(self, snapshots: dict | None = None, bars: dict | None = None,
                 raises: BaseException | None = None,
                 bars_raises: BaseException | None = None) -> None:
        self.snapshots = {} if snapshots is None else snapshots
        self.bars = {"bars": {}} if bars is None else bars
        self.raises = raises
        #: One endpoint failing while the other answers, which `raises` cannot
        #: express -- snapshots are fetched first, so a stub that raises for
        #: everything never reaches the bars call at all. The desk's two
        #: endpoints have different failure policies (a price is the answer, a
        #: sparkline is decoration), and a stub that cannot fail them
        #: separately cannot show the difference.
        self.bars_raises = bars_raises
        self.urls: list[str] = []
        self.headers: list[dict] = []

    def __call__(self, url: str, headers: dict) -> bytes:
        self.urls.append(url)
        self.headers.append(dict(headers))
        if self.raises is not None:
            raise self.raises
        if url.startswith(Q.SNAPSHOTS_URL):
            return json.dumps(self.snapshots).encode("utf-8")
        if self.bars_raises is not None:
            raise self.bars_raises
        return json.dumps(self.bars).encode("utf-8")

    def count(self, prefix: str) -> int:
        return sum(1 for u in self.urls if u.startswith(prefix))

    @property
    def snapshot_calls(self) -> int:
        return self.count(Q.SNAPSHOTS_URL)

    @property
    def bar_calls(self) -> int:
        return self.count(Q.BARS_URL)


class Collector(logging.Handler):
    """Every ``LogRecord`` the process emits, kept whole for inspection.

    The records are kept rather than their formatted text because the
    interesting leak is the one that is *not* in ``getMessage()``: a secret
    passed as a lazy ``%s`` argument shows up in ``record.args`` and reaches
    the log file only when a handler formats it.
    """

    def __init__(self) -> None:
        super().__init__(level=logging.DEBUG)
        self.records: list[logging.LogRecord] = []

    def emit(self, record: logging.LogRecord) -> None:
        self.records.append(record)

    def texts(self) -> list[str]:
        out: list[str] = []
        for r in self.records:
            out.append(str(r.msg))
            out.append(str(r.args))
            out.append(r.getMessage())
        return out


class QuoteTestCase(unittest.TestCase):
    """A temporary secrets directory and a clock the test moves by hand."""

    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.path = os.path.join(self.dir.name, "alpaca.json")
        # An arbitrary instant. Nothing in this module reads the wall clock
        # for anything but cache expiry, so the value only has to be stable.
        self.clock = FixedClock(1_756_000_000.0)

    def write_credentials(self, key_id: str = KEY_ID, secret: str = SECRET,
                          raw: str | None = None) -> None:
        with open(self.path, "w", encoding="utf-8") as f:
            f.write(raw if raw is not None
                    else json.dumps({"key_id": key_id, "secret_key": secret}))

    def service(self, fetch: Fetches) -> "Q.QuoteService":
        return Q.QuoteService(Q.Credentials(self.path), self.clock, fetch=fetch)


class SnapshotTest(QuoteTestCase):
    def setUp(self):
        super().setUp()
        self.write_credentials()

    def test_a_snapshot_becomes_integer_cents_and_basis_points(self):
        fetch = Fetches(snapshots=bare(ACME=snapshot()))
        row = self.service(fetch).quotes(["ACME"])["ACME"]

        self.assertEqual(row["lastCents"], 24160)
        self.assertEqual(row["prevCloseCents"], 23184)
        self.assertEqual(row["changeBp"], 421)
        # Integers all the way out, like the board's own wire contract: a
        # float here would reach the phone as 241.60000000000002 and be
        # rendered by whatever the phone's locale does with it.
        for field in ("lastCents", "prevCloseCents", "changeBp"):
            self.assertIsInstance(row[field], int, field)
            self.assertNotIsInstance(row[field], bool, field)

    def test_both_snapshot_envelopes_parse(self):
        # Two services, because one would answer the second call from its cache
        # and the test would pass without the second envelope being read at all.
        one = self.service(Fetches(snapshots=bare(ACME=snapshot()))).quotes(["ACME"])
        two = self.service(Fetches(snapshots=wrapped(ACME=snapshot()))).quotes(["ACME"])
        self.assertEqual(one, two)
        self.assertEqual(one["ACME"]["lastCents"], 24160)

    def test_a_symbol_the_upstream_skipped_is_absent_rather_than_zero(self):
        # Alpaca answers 200 with the symbol simply missing. A row of zeroes
        # would print as "$0.00, unchanged", which is a lie about a company;
        # an absent key is a gap the phone can leave blank.
        fetch = Fetches(snapshots=bare(ACME=snapshot()))
        out = self.service(fetch).quotes(["ACME", "ZZZZ"])
        self.assertIn("ACME", out)
        self.assertNotIn("ZZZZ", out)

    def test_a_symbol_this_provider_cannot_quote_is_absent_rather_than_an_error(self):
        # The phone sends its whole watchlist in one call, and a Korean listing
        # is numeric (005930) where Alpaca's symbols never are. Refusing the
        # request would cost every US company on that watchlist its price
        # because of a company Alpaca was never going to answer for -- so the
        # symbol is dropped, is absent from the map exactly as a skipped one
        # is, and never reaches the query string either.
        fetch = Fetches(snapshots=bare(ACME=snapshot()))
        out = self.service(fetch).quotes(["ACME", "005930", "BAD SYMBOL"])
        self.assertEqual(list(out), ["ACME"])
        self.assertNotIn("005930", fetch.urls[0])
        self.assertNotIn("BAD", fetch.urls[0])

    def test_a_request_of_nothing_askable_makes_no_upstream_call(self):
        fetch = Fetches(snapshots=bare(ACME=snapshot()))
        self.assertEqual(self.service(fetch).quotes(["005930"]), {})
        self.assertEqual(fetch.urls, [])

    def test_a_previous_close_of_zero_is_no_change_rather_than_a_crash(self):
        # A newly listed symbol has no previous close, and the division that
        # makes basis points would be a 500 on a route the phone polls.
        fetch = Fetches(snapshots=bare(ACME=snapshot(prev=0.0)))
        row = self.service(fetch).quotes(["ACME"])["ACME"]
        self.assertEqual(row["prevCloseCents"], 0)
        self.assertEqual(row["changeBp"], 0)
        self.assertEqual(row["lastCents"], 24160)


class BarsTest(QuoteTestCase):
    def setUp(self):
        super().setUp()
        self.write_credentials()

    def test_bars_come_back_as_a_date_and_a_close(self):
        fetch = Fetches(snapshots=bare(ACME=snapshot()),
                        bars=bars(231.84, 230.00, 228.50))
        row = self.service(fetch).quotes(["ACME"])["ACME"]
        # Oldest first, whatever order the upstream sent, because the sparkline
        # that draws these reads left to right. The timestamp is cut to its
        # date: a daily bar's clock time is the exchange's, not the reader's,
        # and the phone would have to strip it anyway.
        self.assertEqual(row["bars"], [
            {"t": "2026-08-23", "c": 22850},
            {"t": "2026-08-24", "c": 23000},
            {"t": "2026-08-25", "c": 23184},
        ])
        for bar in row["bars"]:
            self.assertIsInstance(bar["c"], int)

    def test_the_bars_request_bounds_its_window_and_every_symbol_comes_back(self):
        # Two symbols, because one cannot show the failure this guards. Alpaca
        # does not document how it divides `limit` across symbols, so a request
        # relying on the limit alone relies on an undocumented property: if the
        # upstream ever filled symbol by symbol, the first company would take
        # every bar and the second would draw nothing. A bounded `start` makes
        # the limit non-binding, and this asserts on the whole query because
        # each parameter is load-bearing and a silent drop is invisible.
        doc = bars(231.84, 230.00)
        doc["bars"].update(bars(10.10, 10.00, symbol="BETA")["bars"])
        fetch = Fetches(snapshots=bare(ACME=snapshot(), BETA=snapshot(last=10.10)),
                        bars=doc)
        out = self.service(fetch).quotes(["ACME", "BETA"])

        url = next(u for u in fetch.urls if u.startswith(Q.BARS_URL))
        self.assertIn("symbols=ACME,BETA", url)
        self.assertIn("timeframe=1Day", url)
        # Sixty days before the fixed clock's 2025-08-24, and a limit that is
        # thirty per symbol rather than thirty for the pair.
        self.assertIn("start=2025-06-25", url)
        self.assertIn(f"limit={Q.BAR_LIMIT * 2}", url)
        self.assertIn("sort=desc", url)
        self.assertIn(f"feed={Q.FEED}", url)

        self.assertEqual([b["c"] for b in out["ACME"]["bars"]], [23000, 23184])
        self.assertEqual([b["c"] for b in out["BETA"]["bars"]], [1000, 1010])

    def test_bars_a_symbol_lacks_are_asked_about_again_within_the_minute(self):
        # A miss is cached at the snapshot's minute rather than the bars' hour:
        # a symbol with a price but no history is usually the transient case,
        # and an hour of blank sparkline is an hour of a company looking like
        # it has no past.
        fetch = Fetches(snapshots=bare(ACME=snapshot()), bars={"bars": {}})
        svc = self.service(fetch)
        svc.quotes(["ACME"])
        self.assertEqual(fetch.bar_calls, 1)

        self.clock.advance(61)
        svc.quotes(["ACME"])
        self.assertEqual(fetch.bar_calls, 2)

    def test_a_symbol_with_no_bars_still_carries_its_quote(self):
        # Bars are the sparkline; the quote is the number. A symbol Alpaca has
        # a snapshot for but no daily history should print its price rather
        # than disappear because the chart underneath it is empty.
        fetch = Fetches(snapshots=bare(ACME=snapshot()), bars={"bars": {}})
        row = self.service(fetch).quotes(["ACME"])["ACME"]
        self.assertEqual(row["bars"], [])
        self.assertEqual(row["lastCents"], 24160)


class CacheTest(QuoteTestCase):
    def setUp(self):
        super().setUp()
        self.write_credentials()

    def test_a_snapshot_is_cached_for_a_minute_and_bars_for_an_hour(self):
        fetch = Fetches(snapshots=bare(ACME=snapshot()), bars=bars(231.84))
        svc = self.service(fetch)

        svc.quotes(["ACME"])
        self.assertEqual((fetch.snapshot_calls, fetch.bar_calls), (1, 1))

        # A phone that pulls to refresh twice in a second must not become two
        # requests upstream: the free tier is 200 a minute and the desk is the
        # only thing holding the key.
        svc.quotes(["ACME"])
        self.assertEqual((fetch.snapshot_calls, fetch.bar_calls), (1, 1))

        self.clock.advance(61)
        svc.quotes(["ACME"])
        self.assertEqual((fetch.snapshot_calls, fetch.bar_calls), (2, 1))

        self.clock.advance(3600)
        svc.quotes(["ACME"])
        self.assertEqual((fetch.snapshot_calls, fetch.bar_calls), (3, 2))

    def test_only_the_expired_symbols_go_upstream(self):
        fetch = Fetches(snapshots=bare(ACME=snapshot(), BETA=snapshot(last=10.0)))
        svc = self.service(fetch)
        svc.quotes(["ACME"])
        svc.quotes(["ACME", "BETA"])

        self.assertEqual(fetch.snapshot_calls, 2)
        # The second call asks for BETA alone: ACME is still fresh, and asking
        # for it again would spend the rate limit on an answer already held.
        self.assertIn("symbols=BETA", fetch.urls[-2])
        self.assertNotIn("ACME", fetch.urls[-2])


class CredentialsTest(QuoteTestCase):
    def test_no_credentials_is_no_quotes(self):
        # A desk whose secrets mount has no alpaca.json serves everything else
        # exactly as before. The route is a 404 the app can hide a tab behind,
        # not a 500 that reads like the desk is broken.
        fetch = Fetches(snapshots=bare(ACME=snapshot()))
        with self.assertRaises(NotFound) as caught:
            self.service(fetch).quotes(["ACME"])
        self.assertEqual(caught.exception.code, "no_quotes")
        self.assertEqual(caught.exception.status, 404)
        # And nothing was asked of an upstream that could not have been asked.
        self.assertEqual(fetch.urls, [])

    def test_credentials_are_reloaded_when_the_file_changes(self):
        fetch = Fetches(snapshots=bare(ACME=snapshot()))
        creds = Q.Credentials(self.path)
        svc = Q.QuoteService(creds, self.clock, fetch=fetch)

        # Constructed before the file existed: the desk comes up first and the
        # secrets mount arrives when it arrives.
        self.assertIsNone(creds.get())
        with self.assertRaises(NotFound):
            svc.quotes(["ACME"])

        self.write_credentials()
        svc.quotes(["ACME"])
        self.assertEqual(fetch.headers[-1]["APCA-API-KEY-ID"], KEY_ID)
        self.assertEqual(fetch.headers[-1]["APCA-API-SECRET-KEY"], SECRET)

        # A rotated key takes effect without a restart. Different lengths so
        # the stat stamp moves even if two writes land in the same nanosecond.
        rotated_id, rotated_secret = KEY_ID + "22", SECRET + "3333"
        self.write_credentials(key_id=rotated_id, secret=rotated_secret)
        self.clock.advance(61)
        svc.quotes(["ACME"])
        self.assertEqual(fetch.headers[-1]["APCA-API-KEY-ID"], rotated_id)
        self.assertEqual(fetch.headers[-1]["APCA-API-SECRET-KEY"], rotated_secret)

    def test_an_unusable_credentials_file_is_no_quotes_and_never_an_exception(self):
        # Half-written, wrong shape, wrong types: every one of them authorises
        # nothing rather than crashing a request thread. `get()` is called on
        # the request path, so a raise here would be a 500 on a route whose
        # honest answer is "not configured".
        for raw in ('{"key_id": "x",', "[]", '{"key_id": 7, "secret_key": 8}',
                    '{"key_id": "", "secret_key": ""}', '{"secret_key": "x"}'):
            self.write_credentials(raw=raw)
            self.assertIsNone(Q.Credentials(self.path).get(), raw)


class UpstreamTest(QuoteTestCase):
    def setUp(self):
        super().setUp()
        self.write_credentials()

    def test_an_upstream_that_raises_is_a_502(self):
        # The snapshots call is the one that decides this. It is the answer --
        # a price and a change -- and there is nothing to serve without it, so
        # its failure is the desk saying which side is broken. The bars call is
        # the sparkline underneath and fails differently; the test below is
        # that asymmetry, and this one is the half that must not drift into it.
        fetch = Fetches(raises=OSError("connection reset"))
        with self.assertRaises(DeskError) as caught:
            self.service(fetch).quotes(["ACME"])
        self.assertEqual(caught.exception.code, "upstream")
        self.assertEqual(caught.exception.status, 502)

    def test_a_bars_outage_serves_prices_without_sparklines(self):
        # The prices are already in hand when the bars call fails, and a 502
        # here would throw them away to report that a chart is missing. A
        # symbol with no daily history is a case this service already serves
        # -- an empty `bars` list beside a real price -- so an outage on that
        # endpoint is served as the thing it looks like rather than as an
        # error the phone has to explain.
        #
        # The error carries the credential, because the redaction rule holds on
        # every string built from an upstream failure and this is a new one.
        boom = RuntimeError(f"HTTP 500 with APCA-API-SECRET-KEY: {SECRET}")
        fetch = Fetches(snapshots=bare(ACME=snapshot()), bars_raises=boom)
        svc = self.service(fetch)

        with self.assertLogs("claudepost.quotes", level="WARNING") as caught:
            row = svc.quotes(["ACME"])["ACME"]
        self.assertEqual(row["lastCents"], 24160)
        self.assertEqual(row["bars"], [])
        for line in caught.output:
            self.assertNotIn(SECRET, line)
            self.assertNotIn(KEY_ID, line)

        # Cached like any other miss, so a phone pulling to refresh through an
        # outage does not turn one failure into one upstream call per pull.
        svc.quotes(["ACME"])
        self.assertEqual(fetch.bar_calls, 1)

        # ...at the miss TTL -- a minute, not the bar cache's hour -- so the
        # sparklines come back on their own when the upstream does, rather than
        # an hour after it.
        self.clock.advance(Q.SNAPSHOT_TTL + 1)
        with self.assertLogs("claudepost.quotes", level="WARNING"):
            svc.quotes(["ACME"])
        self.assertEqual(fetch.bar_calls, 2)

    def test_the_upstream_body_is_bounded_and_a_cut_one_is_a_502(self):
        # An upstream that never stops sending must not become the desk's
        # memory: the read is capped. Four megabytes is generous for the
        # largest legitimate answer -- thirty-two symbols of sixty daily bars.
        self.assertGreaterEqual(Q.MAX_UPSTREAM_BYTES, 4 * 1024 * 1024)

        # A body cut at the cap is not JSON any more, so it fails exactly where
        # every other unparseable body does: a 502 naming the upstream, never a
        # partial answer presented as a whole one.
        cut = json.dumps(bare(ACME=snapshot())).encode("utf-8")[:64]
        svc = Q.QuoteService(Q.Credentials(self.path), self.clock,
                             fetch=lambda url, headers: cut)
        with self.assertRaises(DeskError) as caught:
            svc.quotes(["ACME"])
        self.assertEqual(caught.exception.status, 502)

    def test_a_body_that_is_not_the_expected_shape_is_a_502(self):
        # Alpaca answering 200 with an error page, or with a shape nothing here
        # recognises, is the upstream failing -- not the desk. A 502 says which
        # of the two is broken, which is the whole reason the code is not 500.
        #
        # The last two are the ones worth having: a refusal served with a 200
        # is a JSON *object*, so "is it a dict" cannot be the test for the bare
        # envelope. Reading one as an empty answer would report every symbol as
        # skipped, cache that, and hand the phone a 200 with an empty map and
        # nothing at all to say why the prices had gone.
        for doc in ("<html>maintenance</html>", [], 7,
                    {"message": "forbidden"},
                    {"code": 40110000, "message": "access not authorized"}):
            fetch = Fetches(snapshots=doc)
            with self.assertRaises(DeskError) as caught:
                self.service(fetch).quotes(["ACME"])
            self.assertEqual(caught.exception.status, 502, repr(doc))

    def test_an_empty_snapshot_map_is_no_symbols_rather_than_an_error(self):
        # The other side of the same coin. An empty object is a real answer --
        # there is nothing in it to disagree with -- so it is every symbol
        # absent, not a 502.
        fetch = Fetches(snapshots={})
        self.assertEqual(self.service(fetch).quotes(["ACME"]), {})

    def test_the_secret_never_reaches_the_message(self):
        # The load-bearing test. urllib puts the request -- headers and all --
        # inside some of the errors it raises, so the exception text from a
        # failed fetch is the single most likely place for the key to escape.
        # It must not reach the 502 the phone sees, the desk's log, or the
        # chained traceback an unhandled path would print.
        collector = Collector()
        root = logging.getLogger()
        level = root.level
        root.addHandler(collector)
        root.setLevel(logging.DEBUG)
        self.addCleanup(root.setLevel, level)
        self.addCleanup(root.removeHandler, collector)

        boom = RuntimeError(
            f"HTTP 403 for https://data.alpaca.markets/v2/stocks/snapshots "
            f"with APCA-API-KEY-ID: {KEY_ID} APCA-API-SECRET-KEY: {SECRET}")
        fetch = Fetches(raises=boom)
        with self.assertRaises(DeskError) as caught:
            self.service(fetch).quotes(["ACME"])
        exc = caught.exception

        haystacks = [str(exc), exc.message, json.dumps(exc.to_json()),
                     repr(exc.__cause__), repr(exc.__context__)]
        haystacks.extend(collector.texts())
        for hay in haystacks:
            self.assertNotIn(SECRET, hay, hay)
            self.assertNotIn(KEY_ID, hay, hay)

        # Something was said, and it named the redaction rather than silently
        # producing an empty message -- a 502 with nothing in it is a 502
        # nobody can act on.
        self.assertIn("redacted", exc.message)
        self.assertTrue(collector.records, "the failure should have been logged")

    def test_the_secret_never_reaches_a_chained_traceback(self):
        # The 502 must carry no reference to the exception it came from. A
        # `__cause__` prints under a "direct cause of" line; a `__context__`
        # is hidden from a printed traceback by `from None` but is still there
        # on the object, and an error reporter that walks the chain -- or a
        # `repr()` in a debug log -- would hand back the raw upstream error,
        # header and all. Both must be None, not merely suppressed.
        fetch = Fetches(raises=RuntimeError(SECRET))
        with self.assertRaises(DeskError) as caught:
            self.service(fetch).quotes(["ACME"])
        self.assertIsNone(caught.exception.__cause__)
        self.assertIsNone(caught.exception.__context__)
        self.assertTrue(caught.exception.__suppress_context__)


class RedactTest(unittest.TestCase):
    def test_redaction_replaces_every_occurrence_of_both_halves(self):
        text = f"{KEY_ID} said {SECRET} twice: {SECRET}"
        out = Q._redact(text, KEY_ID, SECRET)
        self.assertNotIn(KEY_ID, out)
        self.assertNotIn(SECRET, out)
        self.assertEqual(out.count("<redacted>"), 3)

    def test_redaction_of_an_empty_credential_leaves_the_text_alone(self):
        # An empty key would otherwise match between every character and turn
        # a diagnosable message into confetti.
        self.assertEqual(Q._redact("nothing to hide", "", ""), "nothing to hide")


if __name__ == "__main__":
    unittest.main()
