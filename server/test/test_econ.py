"""The economic calendar: a regex over somebody else's HTML, and its blast radius.

Two tests here are the reason the module is shaped the way it is, and the rest
is what has to keep working while they hold.

``FixtureTest`` is the first. ``fixtures/investing_rows.html`` is a hand-written
capture of three of investing.com's rows, and the day the page's markup changes
this file is what fails -- rather than the phone, six weeks later, showing a
calendar that has quietly been empty. A scraper without a committed fixture is
a scraper whose break is indistinguishable from a quiet week.

``SecrecyTest`` is the second, and it is ``test_quotes.py``'s
``test_the_secret_never_reaches_the_message`` transplanted into a module that
has no key of its own. That is not a reason to relax the rule, it is the reason
the rule here is *stricter*: ``quotes.py`` can substitute two strings it knows,
and this module knows none, so a Cloudflare cookie or a signed URL inside an
exception can only be kept out by keeping the whole text out. Every assertion
about ``SECRET-TOKEN-VALUE`` below is an assertion about that.

Nothing in this file is a credential, and nothing in the fixture came out of a
real session. ``SECRET-TOKEN-VALUE`` is obviously fabricated for the same
reason ``test_auth.py``'s tokens are: so that nobody greps this repository and
finds something to try.
"""

from __future__ import annotations

import json
import logging
import os
import re
import unittest

from claudepost import econ as E
from claudepost.clock import FixedClock
from claudepost.errors import BadRequest, DeskError

# The module warns whenever a row will not read and whenever the upstream
# fails, both of which tests here provoke on purpose. Without a handler those
# warnings print to stderr and a passing run reads like a failing one -- the
# same reason test_quotes.py and test_watchlist.py add this.
logging.getLogger("claudepost.econ").addHandler(logging.NullHandler())

FIXTURE = os.path.join(os.path.dirname(__file__), "fixtures",
                       "investing_rows.html")

#: Not a credential. It stands for whatever a Cloudflare handshake leaves in a
#: cookie jar, a signed URL or a header that the library quoting it back has no
#: idea is sensitive.
SECRET = "SECRET-TOKEN-VALUE"

FROM = "2026-09-09"
TO = "2026-09-11"


def rows() -> str:
    with open(FIXTURE, "r", encoding="utf-8") as f:
        return f.read()


def envelope(rows_html: str) -> bytes:
    """What the endpoint answers with: the rows inside a JSON string."""
    return json.dumps({"data": rows_html, "rows_num": 3}).encode("utf-8")


def row(datetime_attr: str = 'data-event-datetime="2026/09/10 12:30:00"',
        country: str = "USD", pips: int = 3, name: str = "Invented Release",
        actual: str = "0.4%", estimate: str = "0.3%",
        previous: str = "0.2%") -> str:
    """One event row, built rather than captured, for the edge cases.

    The fixture is the contract; this is for the shapes a real capture cannot
    show at the same time as the shapes the fixture is showing -- a missing
    datetime, a hyphen-spelled one, a cell holding ``--``.
    """
    icons = ('<i class="grayFullBullishIcon"></i>' * pips
             + '<i class="grayEmptyBullishIcon"></i>' * (3 - pips))
    return (f"<tr id=\"eventRowId_1\" {datetime_attr}>"
            f'<td class="first left time js-time">12:30</td>'
            f'<td class="left flagCur noWrap">&nbsp;{country}</td>'
            f'<td class="left textNum sentiment noWrap">{icons}</td>'
            f'<td class="left event"><a href="/x">{name}</a></td>'
            f'<td class="bold act blackFont">{actual}</td>'
            f'<td class="fore">{estimate}</td>'
            f'<td class="prev">{previous}</td>'
            f"</tr>")


class Fetches:
    """A stand-in for ``_post_fetch``: records the calls, answers from a table.

    It never touches a socket, which is the whole reason ``EconSource`` takes
    the transport as an argument.
    """

    def __init__(self, body: bytes | None = None,
                 raises: BaseException | None = None) -> None:
        self.body = envelope(rows()) if body is None else body
        self.raises = raises
        self.calls: list[tuple[str, bytes, dict]] = []

    def __call__(self, url: str, body: bytes, headers: dict) -> bytes:
        self.calls.append((url, body, dict(headers)))
        if self.raises is not None:
            raise self.raises
        return self.body

    @property
    def count(self) -> int:
        return len(self.calls)


class Collector(logging.Handler):
    """Every ``LogRecord`` the process emits, kept whole for inspection.

    The records rather than their formatted text, because the interesting leak
    is the one that is *not* in ``getMessage()``: a secret passed as a lazy
    ``%s`` argument sits in ``record.args`` and reaches the log file only when
    a handler formats it.
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


class EconTestCase(unittest.TestCase):
    def setUp(self):
        # An arbitrary instant. Nothing here reads the wall clock for anything
        # but cache expiry, so the value only has to be stable.
        self.clock = FixedClock(1_757_400_000.0)

    def source(self, fetch: Fetches) -> E.EconSource:
        return E.EconSource(self.clock, fetch=fetch)


class FixtureTest(unittest.TestCase):
    """The committed capture, parsed. This is the file that fails on a break."""

    def setUp(self):
        self.events = E.parse_rows(rows())

    def test_three_rows_become_three_events(self):
        self.assertEqual(len(self.events), 3)

    def test_the_events_come_back_ascending_by_date(self):
        # The fixture's rows are deliberately out of order, so this asserts on
        # something the file could get wrong. The page groups by day and a
        # window crossing "today" arrives in an order nobody promised.
        dates = [event["date"] for event in self.events]
        self.assertEqual(dates, ["2026-09-09 09:00:00",
                                 "2026-09-10 12:30:00",
                                 "2026-09-11 01:50:00"])
        self.assertEqual(dates, sorted(dates))

    def test_a_row_becomes_the_wire_shape_whole(self):
        # Every field at once, because a parser that reads six of seven cells
        # correctly is a parser whose seventh is off by one and invisible.
        self.assertEqual(self.events[1], {
            "date": "2026-09-10 12:30:00",
            "country": "USD",
            "event": "Core Inflation Rate (MoM)",
            "estimate": "0.3%",
            "actual": "0.4%",
            "previous": "0.2%",
            "impact": "High",
        })

    def test_impact_is_the_count_of_filled_pips(self):
        # Three, two and one filled pips in the fixture. The empty ones are
        # spelled grayEmptyBullishIcon and contain "BullishIcon": a count of
        # the wrong substring reports every row as High and never looks wrong.
        self.assertEqual([event["impact"] for event in self.events],
                         ["Medium", "High", "Low"])

    def test_an_unpublished_figure_stays_an_empty_string(self):
        # The last row's actual is a non-breaking space -- how the live page
        # spells "not out yet". It must not become None, which prints as
        # "None" in one framework and vanishes in another, and must not become
        # "--", which is a value that looks like a value.
        jpy = self.events[2]
        self.assertEqual(jpy["actual"], "")
        self.assertIsInstance(jpy["actual"], str)
        # ...while the row's other figures are untouched, including a leading
        # minus, which is a figure and not an empty cell.
        self.assertEqual(jpy["estimate"], "-1.8%")
        self.assertEqual(jpy["previous"], "2.6%")

    def test_the_country_is_the_code_beside_the_flag(self):
        self.assertEqual([event["country"] for event in self.events],
                         ["EUR", "USD", "JPY"])

    def test_the_fixture_carries_nothing_from_a_real_session(self):
        # It is committed. A capture of a live page is a capture of whoever was
        # logged in when it was taken, and the point of a hand-written fixture
        # is that there is nothing in it to leak.
        # The comment is stripped first: it is prose about what is *absent*
        # and names the very things this looks for.
        raw = re.sub(r"<!--.*?-->", "", rows(), flags=re.DOTALL).lower()
        self.assertIn("<tr", raw)
        for marker in ("cookie", "cf_clearance", "session",
                       "authorization", "bearer ", "csrf", "_ga", "token"):
            self.assertNotIn(marker, raw, marker)

    def test_every_field_is_a_string(self):
        for event in self.events:
            for key, value in event.items():
                self.assertIsInstance(value, str, f"{key}={value!r}")


class ParserTest(unittest.TestCase):
    """The shapes a single committed capture cannot show all at once."""

    def test_a_row_that_lost_its_datetime_is_skipped_and_counted(self):
        # The break this module is designed to survive: the event row is still
        # there, still has its seven cells, and the attribute the instant comes
        # from has moved or been renamed. Crashing would take the whole
        # calendar down for one row; dropping it silently would leave a shorter
        # calendar that looks like a quieter week. It is dropped and counted.
        html = row() + row(datetime_attr='data-something-else="nope"')
        events, skipped = E._scan(html)
        self.assertEqual(len(events), 1)
        self.assertEqual(skipped, 1)

    def test_the_calendars_own_furniture_is_not_counted_as_a_break(self):
        # The live page emits a day separator between groups: one <td> with a
        # colspan and no datetime. If that counted as skipped, the number would
        # be nonzero on every successful fetch and would say nothing at all
        # about a break -- which is the only thing it is for.
        day = ('<tr><td class="theDay" id="theDay1757462400" colspan="8">'
               'Thursday, September 10, 2026</td></tr>')
        events, skipped = E._scan(day + row() + day)
        self.assertEqual(len(events), 1)
        self.assertEqual(skipped, 0)

    def test_both_spellings_of_the_datetime_attribute_parse(self):
        # investing.com writes it with slashes; the rest of this desk spells a
        # date with hyphens. Both are read and one is emitted, so a page that
        # switches does not become a calendar that goes blank.
        slashes = E.parse_rows(row(
            datetime_attr='data-event-datetime="2026/09/10 12:30:00"'))
        hyphens = E.parse_rows(row(
            datetime_attr='data-event-datetime="2026-09-10 12:30:00"'))
        self.assertEqual(slashes, hyphens)
        self.assertEqual(slashes[0]["date"], "2026-09-10 12:30:00")

    def test_a_double_hyphen_is_an_empty_figure(self):
        # The page's other spelling of "nothing here". It must not reach the
        # phone, which renders these three fields verbatim.
        event = E.parse_rows(row(actual="--", estimate="&nbsp;",
                                 previous="&mdash;"))[0]
        self.assertEqual(event["actual"], "")
        self.assertEqual(event["estimate"], "")
        # An em dash is not one of the two spellings and is left alone rather
        # than guessed at: a parser that strips every punctuation mark it does
        # not recognise eventually strips a real value.
        self.assertEqual(event["previous"], "—")

    def test_entities_are_unescaped_after_the_tags_are_stripped(self):
        # In that order. Unescaping first would turn an &lt; inside an event's
        # own name into a < that the tag stripper then eats, along with
        # everything after it.
        event = E.parse_rows(row(name="Trade Balance &lt;prelim&gt;"))[0]
        self.assertEqual(event["event"], "Trade Balance <prelim>")

    def test_no_pips_at_all_is_a_named_impact_rather_than_a_gap(self):
        event = E.parse_rows(row(pips=0))[0]
        self.assertEqual(event["impact"], "None")

    def test_markup_with_no_rows_at_all_is_empty_rather_than_an_error(self):
        # An empty window is a real answer -- a Sunday, a national holiday --
        # and there is nothing in it to disagree with.
        self.assertEqual(E.parse_rows(""), [])
        self.assertEqual(E._scan("<div>no results</div>"), ([], 0))

    def test_the_parser_reads_rows_and_not_the_document_around_them(self):
        # The fixture carries a provenance comment naming the very strings the
        # parser looks for. A parser that searched the document rather than
        # each row would find them there.
        self.assertIn(E.BULL_ICON, rows().split("<tr", 1)[0])
        self.assertEqual(len(E.parse_rows(rows())), 3)


class RequestTest(EconTestCase):
    """What goes out. Every part of it is load-bearing or it would not be sent."""

    def test_the_body_and_headers_are_what_the_calendars_own_xhr_sends(self):
        fetch = Fetches()
        self.source(fetch).events(FROM, TO)
        url, body, headers = fetch.calls[0]

        self.assertEqual(url, E.CALENDAR_URL)
        self.assertEqual(body.decode("ascii"),
                         "importance[]=1&importance[]=2&importance[]=3"
                         "&timeZone=55&timeFilter=timeRemain"
                         "&currentTab=custom&limit_from=0"
                         f"&dateFrom={FROM}&dateTo={TO}")
        self.assertEqual(headers["X-Requested-With"], "XMLHttpRequest")
        self.assertEqual(headers["Referer"], E.REFERER)
        self.assertEqual(headers["Content-Type"],
                         "application/x-www-form-urlencoded")
        self.assertIn("Chrome/", headers["User-Agent"])

    def test_the_timezone_asked_for_is_gmt_so_nothing_has_to_be_converted(self):
        # 55 is investing.com's id for GMT. Asking for anything else would mean
        # converting here, from a zone identified by a number in somebody
        # else's table, across daylight-saving boundaries -- for instants the
        # event book then has to carry as UTC anyway.
        self.assertEqual(E.TIMEZONE_ID, "55")
        fetch = Fetches()
        self.source(fetch).events(FROM, TO)
        self.assertIn(b"timeZone=55", fetch.calls[0][1])

    def test_all_three_importances_are_asked_for(self):
        # Filtering to High here would decide, in the transport, that a
        # Medium-impact release cannot matter to a position -- which is exactly
        # the judgement the event book's ranking is for.
        fetch = Fetches()
        self.source(fetch).events(FROM, TO)
        body = fetch.calls[0][1]
        for level in (b"1", b"2", b"3"):
            self.assertIn(b"importance[]=" + level, body)

    def test_a_date_that_is_not_a_date_is_refused_before_anything_is_asked(self):
        # The dates are the only caller-supplied material in the request, so
        # this check is also what keeps a query string from adding fields to
        # the POST: `2026-09-01&limit_from=999` must not reach the body.
        fetch = Fetches()
        source = self.source(fetch)
        for bad in ("2026-09-01&limit_from=999", "2026-9-1", "tomorrow",
                    "2026-09-01\n", "", None, 20260901):
            with self.assertRaises(BadRequest, msg=repr(bad)):
                source.events(bad, TO)
            with self.assertRaises(BadRequest, msg=repr(bad)):
                source.events(FROM, bad)
        self.assertEqual(fetch.count, 0)

    def test_a_window_that_runs_backwards_is_refused(self):
        fetch = Fetches()
        with self.assertRaises(BadRequest):
            self.source(fetch).events(TO, FROM)
        self.assertEqual(fetch.count, 0)


class CacheTest(EconTestCase):
    def test_a_window_is_fetched_once_an_hour(self):
        fetch = Fetches()
        source = self.source(fetch)

        source.events(FROM, TO)
        self.assertEqual(fetch.count, 1)

        # A phone that pulls to refresh twice in a second must not become two
        # scrapes: an economic calendar does not move within the hour.
        source.events(FROM, TO)
        self.assertEqual(fetch.count, 1)

        self.clock.advance(E.EVENTS_TTL - 1)
        source.events(FROM, TO)
        self.assertEqual(fetch.count, 1)

        self.clock.advance(2)
        source.events(FROM, TO)
        self.assertEqual(fetch.count, 2)

    def test_the_cache_is_keyed_by_the_window(self):
        # A different week is a different question, and answering it from
        # another week's cache would show the wrong dates rather than none.
        fetch = Fetches()
        source = self.source(fetch)
        source.events(FROM, TO)
        source.events("2026-09-16", "2026-09-18")
        self.assertEqual(fetch.count, 2)
        self.assertEqual(source.health()["windows"], 2)

    def test_the_caller_gets_copies_it_may_edit(self):
        # The event book annotates these rows against positions before it files
        # them, and the next request must not inherit the annotations.
        fetch = Fetches()
        source = self.source(fetch)
        first = source.events(FROM, TO)
        first[0]["event"] = "edited"
        first.append({"date": "9999-01-01 00:00:00"})

        second = source.events(FROM, TO)
        self.assertEqual(len(second), 3)
        self.assertEqual(second[0]["event"], "Industrial Production (YoY)")


class HealthTest(EconTestCase):
    def test_a_clean_fetch_reports_what_it_parsed(self):
        fetch = Fetches()
        source = self.source(fetch)
        self.assertEqual(source.health(),
                         {"ok": True, "error": None, "fetchedAt": None,
                          "windows": 0, "parsed": 0, "skipped": 0})

        source.events(FROM, TO)
        health = source.health()
        self.assertTrue(health["ok"])
        self.assertIsNone(health["error"])
        self.assertEqual(health["parsed"], 3)
        self.assertEqual(health["skipped"], 0)
        self.assertEqual(health["fetchedAt"], self.clock.now())

    def test_a_partial_break_is_visible_as_a_count_rather_than_a_short_list(self):
        # Half the rows losing their shape is the failure that hides: the
        # calendar comes back shorter and reads as a quieter week. `skipped`
        # is the only thing that distinguishes the two.
        broken = row() + row(datetime_attr="") + row(datetime_attr="")
        fetch = Fetches(body=envelope(broken))
        source = self.source(fetch)

        with self.assertLogs("claudepost.econ", level="WARNING"):
            events = source.events(FROM, TO)

        self.assertEqual(len(events), 1)
        health = source.health()
        self.assertEqual((health["parsed"], health["skipped"]), (1, 2))
        # Still `ok`: the fetch succeeded and one row is real. A partial break
        # is not an outage, and calling it one would hide the outages.
        self.assertTrue(health["ok"])

    def test_a_failure_names_a_cause_without_quoting_the_upstream(self):
        fetch = Fetches(raises=RuntimeError(f"403 for cf_clearance={SECRET}"))
        source = self.source(fetch)
        with self.assertRaises(DeskError):
            source.events(FROM, TO)
        health = source.health()
        self.assertFalse(health["ok"])
        # The type name, which is the diagnosis, and nothing else.
        self.assertEqual(health["error"], "RuntimeError")

    def test_a_body_that_is_not_the_envelope_says_which_shape_came_back(self):
        # A challenge page, a block page or an HTML error served with a 200 is
        # how an outage usually arrives. The cause names the *type* of what
        # came back, because this module wrote that sentence and nothing in it
        # came from the page.
        for body, expected in ((b"<html>just a moment</html>", "did not decode"),
                               (b'{"rows_num": 0}', "got dict"),
                               (b"[]", "got list"),
                               (b'{"data": 7}', "got dict")):
            source = self.source(Fetches(body=body))
            with self.assertRaises(DeskError) as caught:
                source.events(FROM, TO)
            self.assertEqual(caught.exception.status, 502, repr(body))
            self.assertIn(expected, source.health()["error"], repr(body))


class FailureTest(EconTestCase):
    def test_a_failure_serves_the_last_good_window(self):
        # A calendar that goes blank reads as "nothing is happening this week",
        # which is a false statement about the owner's money. Three hours old
        # reads as a schedule nobody has refreshed, which is true.
        fetch = Fetches()
        source = self.source(fetch)
        good = source.events(FROM, TO)

        self.clock.advance(E.EVENTS_TTL + 1)
        fetch.raises = OSError("connection reset")
        with self.assertLogs("claudepost.econ", level="WARNING"):
            stale = source.events(FROM, TO)

        self.assertEqual(stale, good)
        health = source.health()
        self.assertFalse(health["ok"])
        # And `fetchedAt` still points at the fetch that actually landed, so a
        # home row can say how old what it is showing may be rather than
        # presenting it as current.
        self.assertEqual(health["fetchedAt"], self.clock.now() - E.EVENTS_TTL - 1)

    def test_an_outage_does_not_become_one_request_per_pull(self):
        fetch = Fetches()
        source = self.source(fetch)
        source.events(FROM, TO)

        self.clock.advance(E.EVENTS_TTL + 1)
        fetch.raises = OSError("connection reset")
        with self.assertLogs("claudepost.econ", level="WARNING"):
            source.events(FROM, TO)
        self.assertEqual(fetch.count, 2)

        # Pull to refresh, repeatedly, through the outage.
        source.events(FROM, TO)
        source.events(FROM, TO)
        self.assertEqual(fetch.count, 2)

        # ...and the window comes back on its own when the upstream does,
        # after the short failure TTL rather than after a full hour.
        self.clock.advance(E.FAILURE_TTL + 1)
        fetch.raises = None
        source.events(FROM, TO)
        self.assertEqual(fetch.count, 3)
        self.assertTrue(source.health()["ok"])

    def test_a_failure_with_nothing_to_fall_back_on_is_a_502(self):
        # The one case that raises. There is no stale window to prefer, and an
        # empty list would be exactly the lie the rule above exists to prevent
        # -- so the phone is told the desk could not ask, which is a state it
        # can show, rather than handed a week with nothing in it.
        fetch = Fetches(raises=OSError("connection reset"))
        with self.assertLogs("claudepost.econ", level="WARNING"):
            with self.assertRaises(DeskError) as caught:
                self.source(fetch).events(FROM, TO)
        self.assertEqual(caught.exception.code, "upstream")
        self.assertEqual(caught.exception.status, 502)

    def test_a_failure_in_one_window_leaves_another_alone(self):
        fetch = Fetches()
        source = self.source(fetch)
        source.events(FROM, TO)

        fetch.raises = OSError("connection reset")
        with self.assertLogs("claudepost.econ", level="WARNING"):
            with self.assertRaises(DeskError):
                source.events("2026-09-16", "2026-09-18")

        # The good window is still served from its cache, without a call.
        self.assertEqual(len(source.events(FROM, TO)), 3)
        self.assertEqual(fetch.count, 2)


class TransportTest(unittest.TestCase):
    """The chain, exercised with the network replaced rather than reached."""

    def setUp(self):
        self.original = E.TRANSPORTS
        self.addCleanup(setattr, E, "TRANSPORTS", self.original)
        self.addCleanup(setattr, E, "_elapsed", E._elapsed)
        self.clock = [0.0]

    def burns(self, tried: list, name: str, seconds: float | None = None):
        """A transport that spends its whole timeout and then fails.

        The chain's clock is stepped rather than waited on -- `E._elapsed` is
        replaced in `setUp`'s cleanup and driven from here -- so a test about
        a seventy-five-second worst case costs no seconds at all.
        """
        cost = E.UPSTREAM_TIMEOUT if seconds is None else seconds

        def attempt(url, body, headers):
            tried.append(name)
            self.clock[0] += cost
            raise TimeoutError("no answer")
        return attempt

    def test_the_chain_is_cloudscraper_then_requests_then_urllib(self):
        # The order is the point: the library most likely to get past a
        # challenge goes first, and the one that is always installed goes last
        # so the desk's stdlib-only rule holds with neither of the others.
        self.assertEqual([f.__name__ for f in E.TRANSPORTS],
                         ["_via_cloudscraper", "_via_requests", "_via_urllib"])

    def test_any_exception_falls_through_to_the_next_transport(self):
        # Any, not just ImportError. The failure being designed around is an
        # *installed* cloudscraper that hits a challenge it cannot solve: a
        # chain that fell through on a missing module alone would let one
        # library's bad afternoon abort a request the stdlib path would have
        # answered.
        tried: list[str] = []

        def raiser(name: str, exc: BaseException):
            def attempt(url, body, headers):
                tried.append(name)
                raise exc
            return attempt

        def works(url, body, headers):
            tried.append("stdlib")
            return b"ok"

        E.TRANSPORTS = (raiser("cloudscraper", ImportError("no module")),
                        raiser("requests", RuntimeError("403 challenge")),
                        works)
        self.assertEqual(E._post_fetch("u", b"b", {}), b"ok")
        self.assertEqual(tried, ["cloudscraper", "requests", "stdlib"])

    def test_every_transport_failing_names_the_types_and_nothing_else(self):
        def raiser(exc):
            def attempt(url, body, headers):
                raise exc
            return attempt

        E.TRANSPORTS = (raiser(ImportError("no module named cloudscraper")),
                        raiser(ImportError("no module named requests")),
                        raiser(OSError(f"tls error with cf_clearance={SECRET}")))
        with self.assertRaises(E._TransportFailed) as caught:
            E._post_fetch("u", b"b", {})

        message = str(caught.exception)
        self.assertEqual(caught.exception.kinds,
                         ("ImportError", "ImportError", "OSError"))
        # Three ImportErrors would mean neither optional library is installed;
        # an OSError last means the stdlib path is the one that failed. That
        # distinction is the whole diagnosis, and it costs no upstream text.
        self.assertIn("ImportError", message)
        self.assertNotIn(SECRET, message)
        self.assertNotIn("cf_clearance", message)

    def test_two_transports_that_burn_the_clock_leave_no_room_for_a_third(self):
        """The budget, which is what keeps a cold window off cloudflared's 90.

        Two attempts at the full 25-second timeout is 50 seconds, which is
        past `ECON_TOTAL_BUDGET`, so the third is never started -- the answer
        names what the two did and says the budget went, rather than reporting
        a failure for a request nobody made.
        """
        tried: list[str] = []
        E._elapsed = lambda: self.clock[0]
        E.TRANSPORTS = (self.burns(tried, "cloudscraper"),
                        self.burns(tried, "requests"),
                        self.burns(tried, "stdlib"))

        with self.assertRaises(E._TransportFailed) as caught:
            E._post_fetch("u", b"b", {})

        self.assertEqual(tried, ["cloudscraper", "requests"])
        self.assertEqual(caught.exception.kinds,
                         ("TimeoutError", "TimeoutError", E.BUDGET_SPENT))

    def test_one_slow_attempt_still_leaves_the_stdlib_path_a_turn(self):
        """The other half of the window the budget has to sit in.

        A challenge that burns cloudscraper's whole timeout is the ordinary
        failure this chain exists for, and a budget at or below one attempt's
        timeout would let it stop `urllib` from ever being asked -- deleting
        the fall-through rather than bounding it.
        """
        tried: list[str] = []
        E._elapsed = lambda: self.clock[0]

        def works(url, body, headers):
            tried.append("stdlib")
            return b"ok"

        E.TRANSPORTS = (self.burns(tried, "cloudscraper"), works)
        self.assertEqual(E._post_fetch("u", b"b", {}), b"ok")
        self.assertEqual(tried, ["cloudscraper", "stdlib"])

    def test_the_first_transport_is_never_skipped(self):
        """A budget already spent before the call still asks once.

        `_elapsed` is monotonic and this chain's start is its own; the only
        way the first check could fail is a clock that jumped, and a chain
        that answered "upstream failed" for a request it declined to make
        would be reporting on nothing.
        """
        tried: list[str] = []
        self.clock[0] = 10_000.0
        E._elapsed = lambda: self.clock[0]

        def works(url, body, headers):
            tried.append("stdlib")
            return b"ok"

        E.TRANSPORTS = (works,)
        self.assertEqual(E._post_fetch("u", b"b", {}), b"ok")
        self.assertEqual(tried, ["stdlib"])


class SecrecyTest(EconTestCase):
    """The load-bearing test, and the reason this module quotes nothing.

    ``quotes.py`` redacts by substitution because it knows the two strings to
    remove. Here there is no API key and therefore no list -- the sensitive
    material is whatever a Cloudflare handshake left in a cookie, a redirect
    or a header, none of which was ever named to this module. So the rule is
    the stricter one: the upstream's text does not appear anywhere, at all.
    """

    def collector(self) -> Collector:
        collector = Collector()
        root = logging.getLogger()
        level = root.level
        root.addHandler(collector)
        root.setLevel(logging.DEBUG)
        self.addCleanup(root.setLevel, level)
        self.addCleanup(root.removeHandler, collector)
        return collector

    def test_a_credential_in_an_upstream_error_reaches_nothing(self):
        collector = self.collector()
        boom = RuntimeError(
            f"HTTPSConnectionPool(host='www.investing.com', port=443): "
            f"403 Forbidden -- Cookie: cf_clearance={SECRET}; "
            f"__cf_bm={SECRET}")
        fetch = Fetches(raises=boom)

        with self.assertRaises(DeskError) as caught:
            self.source(fetch).events(FROM, TO)
        exc = caught.exception

        haystacks = [str(exc), exc.message, json.dumps(exc.to_json()),
                     json.dumps(self.source(Fetches(raises=boom)).health()),
                     repr(exc.__cause__), repr(exc.__context__)]
        haystacks.extend(collector.texts())
        for hay in haystacks:
            self.assertNotIn(SECRET, hay, hay)
            self.assertNotIn("cf_clearance", hay, hay)

        # Something was said, and it is diagnosable: a 502 with an empty
        # message is a 502 nobody can act on.
        self.assertIn("RuntimeError", exc.message)
        self.assertTrue(collector.records,
                        "the failure should have been logged")

    def test_the_credential_does_not_reach_a_chained_traceback(self):
        # The 502 must carry no reference to the exception it came from. A
        # `__cause__` prints under a "direct cause of" line; a `__context__` is
        # hidden from a printed traceback by `from None` but is still on the
        # object, and an error reporter that walks the chain -- or a repr() in
        # a debug log -- hands back the raw upstream error, cookie and all.
        # Both must be None, not merely suppressed.
        fetch = Fetches(raises=RuntimeError(SECRET))
        with self.assertLogs("claudepost.econ", level="WARNING"):
            with self.assertRaises(DeskError) as caught:
                self.source(fetch).events(FROM, TO)
        self.assertIsNone(caught.exception.__cause__)
        self.assertIsNone(caught.exception.__context__)
        self.assertTrue(caught.exception.__suppress_context__)

    def test_the_stale_path_logs_no_upstream_text_either(self):
        # The redaction rule holds on every string built from an upstream
        # failure, not only on the ones that become a 502. This path succeeds
        # -- it serves the stale window -- and still must not log the cause.
        collector = self.collector()
        fetch = Fetches()
        source = self.source(fetch)
        source.events(FROM, TO)

        self.clock.advance(E.EVENTS_TTL + 1)
        fetch.raises = RuntimeError(f"Cookie: cf_clearance={SECRET}")
        self.assertEqual(len(source.events(FROM, TO)), 3)

        for hay in collector.texts() + [json.dumps(source.health())]:
            self.assertNotIn(SECRET, hay, hay)

    def test_redaction_keeps_only_the_type_of_a_foreign_exception(self):
        self.assertEqual(E._redact(RuntimeError(SECRET)), "RuntimeError")
        self.assertEqual(E._redact(OSError(SECRET)), "OSError")
        # ...and keeps the text of the two this module writes itself, because
        # it wrote them out of type names and its own words.
        self.assertEqual(E._redact(E._TransportFailed(["ImportError"])),
                         "no transport succeeded: ImportError")
        self.assertIn("got list", E._redact(E._BadEnvelope("got list")))


if __name__ == "__main__":
    unittest.main()
