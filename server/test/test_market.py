"""The Yahoo proxy: a crumb the phone never holds, and a body it never reshapes.

Three properties are worth stating before the tests, because everything here is
one of them.

**The desk fetches because the phone cannot.** Yahoo gates
``/v10/finance/quoteSummary`` and ``/v7/finance/options`` behind a cookie and a
crumb, and it decides whether to hand over a crumb by looking at the *TLS
handshake* -- not the User-Agent, not the address. A React Native ``fetch``
uses NSURLSession on iOS and OkHttp on Android, neither of which can be made to
look like Chrome from JavaScript, so the app's own bootstrap is refused no
matter what headers it sends. The desk can impersonate a browser, so the desk
asks.

**The crumb is bound to the cookie, and therefore to the connection.**
``fc.yahoo.com`` sets the cookie; ``getcrumb`` mints a crumb for that jar; the
gated call has to present both. This is the property :class:`FakeYahoo` exists
to enforce, because getting it wrong produces a failure that looks like
something else entirely: the bootstrap reads as perfectly healthy in the log
and every gated call comes back 401. A stub built around a bare fetch function
could not express it, which is why this one is a session factory.

**The body passes through unreshaped.** ``app/src/lib/market/yahoo.ts`` already
maps Yahoo's JSON into the app's model, defensively, with its own tests. If the
desk reshaped the payload, that mapping would exist twice, in two languages,
against one upstream. So the desk returns Yahoo's own ``result[0]`` and nothing
else, and ``test_the_option_chain_keeps_open_interest`` stands guard over the
field a reshaping would most plausibly drop -- ``analysis.ts`` computes max
pain and the put/call ratio from it, and both go quietly wrong rather than
blank when it disappears.

Nothing here reaches the network.
"""

from __future__ import annotations

import json
import logging
import unittest
import urllib.parse

from claudepost import market as M
from claudepost.clock import FixedClock
from claudepost.errors import BadRequest, NotFound, Upstream

logging.getLogger("claudepost.market").addHandler(logging.NullHandler())

#: Shaped like a real one (short, no quotes, no angle brackets) and obviously
#: not one, for the same reason test_quotes.py's key is fabricated.
CRUMB = "NxHIdo1O7zU"


def quote_summary(**modules: object) -> dict:
    """Yahoo's quoteSummary envelope around one result object."""
    return {"quoteSummary": {"result": [dict(modules)], "error": None}}


def option_chain(*, calls: list | None = None, puts: list | None = None) -> dict:
    """Yahoo's optionChain envelope around one underlying."""
    return {
        "optionChain": {
            "result": [{
                "underlyingSymbol": "AAPL",
                "expirationDates": [1793059200],
                "quote": {"regularMarketPrice": 335.5},
                "options": [{
                    "expirationDate": 1793059200,
                    "calls": [] if calls is None else calls,
                    "puts": [] if puts is None else puts,
                }],
            }],
            "error": None,
        }
    }


def contract(strike: float = 335.0, open_interest: int = 2911) -> dict:
    """One option contract, carrying the fields the app's analysis reads."""
    return {
        "strike": strike,
        "lastPrice": 1.02,
        "bid": 0.98,
        "ask": 1.05,
        "volume": 61462,
        "openInterest": open_interest,
        "impliedVolatility": 0.17774259765625,
        "inTheMoney": False,
    }


def _encoded(crumb: str) -> str:
    return urllib.parse.quote(crumb, safe="")


class FakeYahoo:
    """A session factory that enforces Yahoo's real rule about the cookie.

    Each session carries its own jar. A gated call is answered only when the
    crumb in its query is the one *this* session was issued -- so a service
    that opens a fresh connection per request, and thereby drops the cookie
    between the bootstrap and the call that needs it, fails here exactly the
    way it fails against Yahoo.
    """

    def __init__(self, *, crumb: str = CRUMB, bodies: dict | None = None,
                 statuses: list | None = None,
                 raises: BaseException | None = None) -> None:
        self.crumb = crumb
        self.bodies = {} if bodies is None else bodies
        #: Consumed one per *gated* call, so a test can say "401 then 200".
        self.statuses = [] if statuses is None else list(statuses)
        self.raises = raises
        self.urls: list[str] = []
        self.headers: list[dict] = []
        self.opened = 0
        self.closed = 0

    def __call__(self) -> "FakeYahoo.Session":
        self.opened += 1
        return FakeYahoo.Session(self)

    @property
    def gated(self) -> list[str]:
        """Only the calls that carried a crumb -- the bootstrap pair removed."""
        return [u for u in self.urls
                if not u.startswith((M.COOKIE_URL, M.GETCRUMB_URL))]

    @property
    def bootstraps(self) -> int:
        return self.urls.count(M.COOKIE_URL)

    class Session:
        def __init__(self, yahoo: "FakeYahoo") -> None:
            self._y = yahoo
            self.has_cookie = False
            self.minted: str | None = None

        def get(self, url: str, headers: dict) -> tuple[int, bytes]:
            y = self._y
            y.urls.append(url)
            y.headers.append(dict(headers))

            if url.startswith(M.COOKIE_URL):
                self.has_cookie = True
                return 404, b"<!doctype html>"

            if url.startswith(M.GETCRUMB_URL):
                if not self.has_cookie:
                    # What Yahoo really answers a cookieless client: a short,
                    # quote-free body a careless validator mistakes for a crumb.
                    return 429, b"Too Many Requests"
                self.minted = y.crumb
                return 200, y.crumb.encode()

            if y.raises is not None:
                raise y.raises

            if self.minted is None or f"crumb={_encoded(self.minted)}" not in url:
                return 401, b'{"finance":{"error":{"code":"Unauthorized"}}}'

            status = y.statuses.pop(0) if y.statuses else 200
            for prefix, body in y.bodies.items():
                if url.startswith(prefix):
                    return status, json.dumps(body).encode()
            return status, json.dumps({}).encode()

        def close(self) -> None:
            self._y.closed += 1


def service(yahoo: FakeYahoo, clock: FixedClock | None = None) -> M.MarketService:
    return M.MarketService(clock or FixedClock(1_000.0), open_session=yahoo)


SUMMARY = {M.QUOTE_SUMMARY_URL: quote_summary(price={})}


class BootstrapTest(unittest.TestCase):

    def test_a_gated_call_succeeds_on_the_session_that_holds_the_cookie(self):
        """The crumb is minted for a jar; presenting it from another is a 401.

        This is the whole reason the service holds a session rather than making
        a request at a time. A per-request connection passes every other test
        in this file -- it fetches the cookie, it reads a crumb, it appends
        that crumb correctly -- and then gets 401 on every gated call, with a
        bootstrap that looks healthy in the log.
        """
        yahoo = FakeYahoo(bodies={M.QUOTE_SUMMARY_URL: quote_summary(price={"x": 1})})

        got = service(yahoo).quote_summary("AAPL", ["price"])

        self.assertEqual(got, {"price": {"x": 1}})
        self.assertEqual(yahoo.opened, 1, "one session, reused")

    def test_the_cookie_is_fetched_before_the_crumb(self):
        """Yahoo hands a crumb only to a client that already holds its cookie.

        Reversing these two answers 429 with the body "Too Many Requests" --
        short enough and quote-free enough to pass a careless crumb check -- so
        the mistake surfaces as a 401 on every gated call rather than here.
        """
        yahoo = FakeYahoo(bodies=SUMMARY)
        service(yahoo).quote_summary("AAPL", ["price"])

        self.assertEqual(yahoo.urls[0], M.COOKIE_URL)
        self.assertTrue(yahoo.urls[1].startswith(M.GETCRUMB_URL))

    def test_the_crumb_is_reused_within_its_ttl(self):
        """One bootstrap serves every device and every tab until it expires."""
        yahoo = FakeYahoo(bodies=SUMMARY)
        svc = service(yahoo)

        svc.quote_summary("AAPL", ["price"])
        svc.quote_summary("MSFT", ["price"])

        self.assertEqual(yahoo.bootstraps, 1)

    def test_the_browser_profiles_own_headers_are_not_overridden(self):
        """Pinning ``Accept`` to JSON makes Yahoo answer getcrumb with a 406.

        The crumb endpoint serves ``text/plain``, so a request that will accept
        only ``application/json`` is one Yahoo is right to refuse -- and the
        refusal lands in the *bootstrap*, taking the profile and options tabs
        down together while the chart above them keeps working. The general
        rule is the same as the special case: the point of this module is to
        look like a browser, and a header no browser would send is a hole in
        the disguise that is doing the work.
        """
        yahoo = FakeYahoo(bodies=SUMMARY)
        service(yahoo).quote_summary("AAPL", ["price"])

        for sent in yahoo.headers:
            self.assertNotIn("Accept", sent)

    def test_the_crumb_is_url_encoded_into_the_query(self):
        """A crumb routinely carries ``/`` and ``+``; both end a query value.

        Not hypothetical tidiness: Yahoo's crumbs are base64-ish, so a raw one
        lands a ``+`` in the query string, which a server reads as a space --
        and the symptom is an intermittent 401 that depends on which crumb you
        happened to be issued.
        """
        yahoo = FakeYahoo(crumb="a+b/c", bodies=SUMMARY)
        service(yahoo).quote_summary("AAPL", ["price"])

        self.assertIn("crumb=a%2Bb%2Fc", yahoo.gated[0])


class QuoteSummaryTest(unittest.TestCase):

    def test_the_result_object_passes_through_unchanged(self):
        """The desk is a pipe, not a mapper -- ``yahoo.ts`` is the mapper."""
        modules = {
            "assetProfile": {"sector": "Technology", "fullTimeEmployees": 150000},
            "summaryDetail": {"marketCap": {"raw": 4_850_000_000_000}},
        }
        yahoo = FakeYahoo(bodies={M.QUOTE_SUMMARY_URL: quote_summary(**modules)})

        got = service(yahoo).quote_summary("AAPL", ["assetProfile", "summaryDetail"])

        self.assertEqual(got, modules)

    def test_an_empty_result_is_not_found(self):
        """Yahoo answers an unknown symbol with a 200 and an empty list.

        A 502 would be wrong -- nothing upstream failed -- and so would a 200
        carrying ``{}``, which the app would render as a company with no sector
        and no employees rather than as a symbol that does not exist.
        """
        body = {"quoteSummary": {"result": [], "error": None}}
        yahoo = FakeYahoo(bodies={M.QUOTE_SUMMARY_URL: body})

        with self.assertRaises(NotFound) as caught:
            service(yahoo).quote_summary("NOSUCH", ["price"])
        self.assertEqual(caught.exception.code, "no_symbol")

    def test_yahoos_own_404_is_not_found_rather_than_upstream(self):
        """A symbol that does not exist is answered two different ways.

        ``quoteSummary`` returns a 200 with an empty ``result`` for some
        unknown symbols and a bare 404 for others -- the option chain endpoint
        prefers the 404. Both are the same fact, and only one of them was being
        reported as such: a 404 folded into ``upstream`` reaches the phone as a
        502 and draws "the desk responded 502" over a mistyped ticker, where
        "no data for that symbol" is the sentence that belongs there.
        """
        yahoo = FakeYahoo(statuses=[404], bodies=SUMMARY)

        with self.assertRaises(NotFound) as caught:
            service(yahoo).quote_summary("NOSUCHXYZ", ["price"])
        self.assertEqual(caught.exception.code, "no_symbol")

    def test_a_body_that_is_not_json_is_upstream(self):
        """An HTML error page served with a 200 is the usual shape of an outage."""
        yahoo = FakeYahoo()
        yahoo.bodies = {}

        class Html(FakeYahoo.Session):
            def get(self, url, headers):
                status, body = super().get(url, headers)
                if status == 200 and not url.startswith(M.GETCRUMB_URL):
                    return 200, b"<!doctype html><title>Yahoo</title>"
                return status, body

        yahoo.__call__ = lambda: Html(yahoo)  # type: ignore[method-assign]

        with self.assertRaises(Upstream):
            M.MarketService(FixedClock(1_000.0),
                            open_session=lambda: Html(yahoo)).quote_summary(
                "AAPL", ["price"])

    def test_a_symbol_yahoo_cannot_be_asked_about_is_refused(self):
        """Nothing unvalidated reaches a URL the desk builds."""
        yahoo = FakeYahoo(bodies=SUMMARY)
        with self.assertRaises(BadRequest):
            service(yahoo).quote_summary("AAPL&crumb=x", ["price"])
        self.assertEqual(yahoo.urls, [])

    def test_a_korean_listing_is_a_symbol_this_desk_will_ask_about(self):
        """``005930.KS`` is why this module's pattern is wider than quotes.py's.

        Alpaca lists US equities only, so ``quotes.SYMBOL_RE`` refuses digits.
        Yahoo answers for Samsung Electronics, and the app's search can put it
        on the watchlist, so refusing it here would break a tab for a company
        the upstream is perfectly willing to describe.
        """
        yahoo = FakeYahoo(bodies=SUMMARY)
        service(yahoo).quote_summary("005930.KS", ["price"])
        self.assertIn("005930.KS", yahoo.gated[0])

    def test_a_module_outside_the_whitelist_is_refused(self):
        """The module list is the one part of the query a client chooses.

        Passing it through unbounded turns this route into an open proxy for
        every quoteSummary module Yahoo has, financial statements included.
        """
        yahoo = FakeYahoo(bodies=SUMMARY)
        with self.assertRaises(BadRequest):
            service(yahoo).quote_summary("AAPL", ["incomeStatementHistory"])
        self.assertEqual(yahoo.urls, [])


class CrumbRetryTest(unittest.TestCase):

    def test_a_refused_crumb_is_rebootstrapped_and_the_call_retried(self):
        """A crumb outlives its cookie sometimes; one retry is the whole cure."""
        yahoo = FakeYahoo(statuses=[401, 200],
                          bodies={M.QUOTE_SUMMARY_URL: quote_summary(price={"x": 1})})

        got = service(yahoo).quote_summary("AAPL", ["price"])

        self.assertEqual(got, {"price": {"x": 1}})
        self.assertEqual(len(yahoo.gated), 2)
        self.assertEqual(yahoo.bootstraps, 2, "the refused crumb was not reused")

    def test_a_crumb_refused_twice_is_upstream_not_a_loop(self):
        """The phone polls; a retry loop here is a loop against a rate limiter."""
        yahoo = FakeYahoo(statuses=[401, 403], bodies=SUMMARY)

        with self.assertRaises(Upstream):
            service(yahoo).quote_summary("AAPL", ["price"])
        self.assertEqual(len(yahoo.gated), 2)


class OptionsTest(unittest.TestCase):

    def test_the_chain_passes_through_unchanged(self):
        chain = option_chain(calls=[contract()], puts=[contract(330.0)])
        yahoo = FakeYahoo(bodies={M.OPTIONS_URL: chain})

        got = service(yahoo).options("AAPL", None)

        self.assertEqual(got, chain["optionChain"]["result"][0])

    def test_the_option_chain_keeps_open_interest(self):
        """``analysis.ts`` computes max pain and the put/call ratio from this.

        Dropping it does not blank the options tab -- it reports a max pain of
        nothing and a ratio of zero, which is the kind of wrong that gets
        believed.
        """
        chain = option_chain(calls=[contract(open_interest=2911)])
        yahoo = FakeYahoo(bodies={M.OPTIONS_URL: chain})

        got = service(yahoo).options("AAPL", None)

        self.assertEqual(got["options"][0]["calls"][0]["openInterest"], 2911)

    def test_an_expiration_is_passed_upstream(self):
        yahoo = FakeYahoo(bodies={M.OPTIONS_URL: option_chain()})
        service(yahoo).options("AAPL", 1793059200)
        self.assertIn("date=1793059200", yahoo.gated[0])

    def test_an_expiration_that_is_not_a_number_is_refused(self):
        yahoo = FakeYahoo(bodies={M.OPTIONS_URL: option_chain()})
        with self.assertRaises(BadRequest):
            service(yahoo).options("AAPL", "; DROP")


class CacheTest(unittest.TestCase):

    def test_a_repeated_question_makes_no_upstream_call(self):
        """The phone polls and pulls to refresh; Yahoo rate-limits."""
        yahoo = FakeYahoo(bodies=SUMMARY)
        svc = service(yahoo)

        svc.quote_summary("AAPL", ["price"])
        before = len(yahoo.urls)
        svc.quote_summary("AAPL", ["price"])

        self.assertEqual(len(yahoo.urls), before)

    def test_an_expired_entry_is_fetched_again(self):
        yahoo = FakeYahoo(bodies=SUMMARY)
        clock = FixedClock(1_000.0)
        svc = service(yahoo, clock)

        svc.quote_summary("AAPL", ["price"])
        before = len(yahoo.urls)
        clock.advance(M.SUMMARY_TTL + 1)
        svc.quote_summary("AAPL", ["price"])

        self.assertGreater(len(yahoo.urls), before)

    def test_two_module_sets_are_two_cache_entries(self):
        """Info asks for three modules and Calendar for two. Answering one from
        the other's entry hands the calendar tab a profile with no dates."""
        yahoo = FakeYahoo(bodies=SUMMARY)
        svc = service(yahoo)

        svc.quote_summary("AAPL", ["assetProfile"])
        before = len(yahoo.urls)
        svc.quote_summary("AAPL", ["calendarEvents"])

        self.assertGreater(len(yahoo.urls), before)

    def test_a_failure_is_not_cached(self):
        """The tab has a retry button; a cached 502 makes it do nothing."""
        yahoo = FakeYahoo(statuses=[500, 200],
                          bodies={M.QUOTE_SUMMARY_URL: quote_summary(price={"x": 1})})
        svc = service(yahoo)

        with self.assertRaises(Upstream):
            svc.quote_summary("AAPL", ["price"])
        self.assertEqual(svc.quote_summary("AAPL", ["price"]), {"price": {"x": 1}})


class TransportTest(unittest.TestCase):

    def test_a_network_failure_is_upstream(self):
        yahoo = FakeYahoo(raises=OSError("connection reset"), bodies=SUMMARY)
        with self.assertRaises(Upstream):
            service(yahoo).quote_summary("AAPL", ["price"])

    def test_a_rate_limit_is_reported_as_itself(self):
        """429 is the one upstream status worth telling the phone apart.

        The app already has a better sentence for it than the generic one, and
        a desk that flattened it to 502 would take that sentence away.
        """
        yahoo = FakeYahoo(statuses=[429], bodies=SUMMARY)
        with self.assertRaises(Upstream) as caught:
            service(yahoo).quote_summary("AAPL", ["price"])
        self.assertEqual(caught.exception.code, "rate_limited")


if __name__ == "__main__":
    unittest.main()
