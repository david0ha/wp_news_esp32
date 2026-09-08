"""The economic calendar: exact-time macro releases, scraped and cached.

The event book (:mod:`~claudepost.calendar`) ranks what is about to happen
against what the owner holds, and its first tier is the dates a machine knows
exactly and cannot get wrong. Earnings and ex-dividend dates come from a feed.
An option expiry comes from the position itself. **A CPI print, an FOMC
decision or a payrolls release comes from here** -- and it has to arrive with a
time, not a day, because a release at 12:30 UTC and a release at 21:00 UTC are
different events to somebody holding a position through one of them.

This is ported from a sibling project, where it ran as a second service
because an ESP32 cannot scrape HTML. Here it goes **inside the desk**: the desk
is already the thing that goes outside on the phone's behalf, already caches
and already holds the tokens, so a second container would be a second thing to
keep alive for no gain. It follows :mod:`~claudepost.quotes` in every respect
that matters, and the three properties that module names are this one's too.

**Nothing that escapes carries what the session carried.** This module has no
API key -- and that makes its redaction rule *stricter* rather than looser,
not weaker. ``quotes.py`` knows the two strings to remove and can therefore
substitute them. Here the credential-shaped material is whatever a Cloudflare
handshake put in a cookie jar, a URL or a header that no exception's author
knew was sensitive, and there is no list of strings to search for. So
:func:`_redact` redacts by **omission**: an exception raised by anything
outside this module contributes its *type name* and nothing else, to a message,
to ``health()`` and to a log line alike. The two exceptions this module builds
itself carry their text, because their text was assembled here out of type
names and the module's own words.

**A poll must not become an upstream request.** An economic calendar does not
move within the hour -- a release scheduled for Thursday was scheduled for
Thursday an hour ago -- so a window is cached for :data:`EVENTS_TTL` and the
phone's pull-to-refresh spends nothing. The cache is keyed by the date window
rather than by symbol, because unlike a quote there is no per-symbol question
to ask: the whole window arrives in one POST.

**A failure keeps the last good window.** A calendar that goes blank is worse
than one three hours old: blank reads as "nothing is happening this week",
which is a false statement about the owner's money, where stale reads as a
schedule that has not been refreshed. So an upstream failure re-serves the
window last fetched and records the cause in :meth:`EconSource.health`, which
``/api/state`` surfaces -- the home rows report the failure instead of
presenting a week-old schedule as current. A failure with **nothing** to fall
back on is the one case that raises, because there is no stale window to
prefer and an empty list would be the lie this rule exists to prevent.

**The parser is a regex over scraped HTML and will therefore break.** Not
might: investing.com owes this desk nothing and will restyle its calendar. The
whole design is arranged so the break is *visible* -- ``server/test/fixtures/
investing_rows.html`` fails in CI the day the shape changes, and
:meth:`EconSource.health` reports ``parsed`` beside ``skipped`` so a break that
takes half the rows shows up as half the rows skipped rather than as a shorter
calendar nobody questioned.

**Impact is investing.com's word, not this desk's.** ``impact`` is the
``"High" | "Medium" | "Low" | "None"`` that the site's own bull-pip count
means, and it stays a string on the wire. The event book's ``rank`` is a
different quantity -- effect on *the owner's positions*, where an FOMC meeting
can outrank this company's own product launch -- and conflating the two would
delete the distinction the feature exists to draw.
"""

from __future__ import annotations

import html as _html
import json
import logging
import re
import threading
import time
import urllib.request
from collections.abc import Callable, Sequence

from .clock import Clock
from .errors import BadRequest, Upstream

LOG = logging.getLogger("claudepost.econ")

CALENDAR_URL = ("https://www.investing.com/economic-calendar/Service/"
                "getCalendarFilteredData")

#: The calendar's own page. Sent as the ``Referer`` because the endpoint is the
#: XHR that page makes, and answers as one.
REFERER = "https://www.investing.com/economic-calendar/"

#: A browser's. The endpoint refuses a default ``Python-urllib/3.12``, which is
#: not a thing to work around cleverly -- it is a public page whose XHR is
#: being asked the same question a reader's browser asks it.
USER_AGENT = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
              "AppleWebKit/537.36 (KHTML, like Gecko) "
              "Chrome/124.0.0.0 Safari/537.36")

#: investing.com's id for GMT. **This is the field that keeps a timezone off
#: this system's wires.** Every instant the desk carries is UTC; asking the
#: upstream for anything else would mean converting here, from a zone whose
#: identifier is a number in somebody else's table, on dates that cross a
#: daylight-saving boundary. Asking for GMT means the string that arrives is
#: already the string that leaves.
TIMEZONE_ID = "55"

#: How long a window is worth reusing. An economic calendar does not move
#: within the hour: a release scheduled for Thursday 12:30 was scheduled for
#: Thursday 12:30 an hour ago, and the figures that fill in during the release
#: itself are the one thing an hour is too long for -- which is why the phone
#: can pull to refresh, and why that pull costs nothing until the hour is up.
EVENTS_TTL = 3600

#: How long a *failed* window is held before the upstream is asked again. It
#: exists so an outage does not become one upstream request per pull-to-refresh
#: -- the same reason ``quotes.py`` caches its misses -- and it is minutes
#: rather than the hour above because a scraper break that has been fixed
#: upstream should come back on its own without waiting out a full TTL.
FAILURE_TTL = 300

#: Per transport attempt. Generous because a Cloudflare challenge is slow by
#: design, and only ever paid once an hour per window. What it is *not* is a
#: bound on the chain -- see :data:`ECON_TOTAL_BUDGET`, which is.
UPSTREAM_TIMEOUT = 25.0

#: The whole chain's budget, and the arithmetic behind the number.
#:
#: Three transports at :data:`UPSTREAM_TIMEOUT` each is **75 seconds** on a
#: cold window with two libraries installed and failing. That is inside
#: ``http.py``'s 120-second socket timeout and outside cloudflared's
#: 90-second ``--proxy-keepalive-timeout`` by only fifteen seconds -- and
#: ``GET /api/econ`` is a route a phone screen calls, not something only the
#: scheduler pays. Nothing bounded that 75: it was an emergent product of two
#: independent constants (how many transports, how long each may take), which
#: is exactly the kind of number that grows by one the day a fourth transport
#: looks like a good idea.
#:
#: So :func:`_post_fetch` checks the elapsed time before it *starts* each
#: attempt after the first. The window this figure has to sit in is fixed at
#: both ends:
#:
#: * **above 25** -- a budget at or below one attempt's timeout would mean a
#:   cloudscraper challenge that burns its full timeout stops ``requests`` and
#:   ``urllib`` from ever being tried, which deletes the fall-through this
#:   module is built around.
#: * **at or below 50** -- two full attempts must leave no room for a third,
#:   or the budget buys nothing.
#:
#: Forty sits in the middle of that 25..50 window. The practical worst case
#: becomes two attempts, 50 seconds, comfortably inside cloudflared's 90. The
#: *guarantee* is the weaker and more honest statement, and it is the one to
#: rely on: no attempt is ever started after 40 seconds have gone. It is
#: weaker because a transport can overrun its own timeout -- ``urllib``'s is
#: per socket operation rather than per request, so a body arriving one slow
#: byte at a time never trips it -- and a bound that assumed otherwise would
#: be arithmetic about a promise the socket layer does not make.
ECON_TOTAL_BUDGET = 40.0

#: The most of an upstream answer this module will read into memory. A timeout
#: bounds how long a fetch may take; this bounds how much it may cost. A week
#: of every country at every importance is a few hundred kilobytes, so nothing
#: legitimate is near eight megabytes, and a body that reaches it is truncated
#: JSON -- which is to say a failure like any other body that will not parse.
MAX_UPSTREAM_BYTES = 8 * 1024 * 1024

#: What a row's importance cell counts. The empty pips are spelled
#: ``grayEmptyBullishIcon`` and contain this string's suffix but not this
#: string, which is why the count is of the full spelling: a substring one
#: token shorter counts three for every row and reports the whole calendar as
#: high impact.
BULL_ICON = "grayFullBullishIcon"

#: Bull pips to the word investing.com means by them.
IMPACTS: tuple[str, ...] = ("None", "Low", "Medium", "High")

#: How many ``<td>`` cells an event row has. A row with fewer is the calendar's
#: own furniture -- the day separator, ``<td class="theDay" colspan="8">`` --
#: rather than an event this parser failed to read, and counting those as
#: skipped would put a number in :meth:`EconSource.health` that is nonzero on
#: every successful fetch and therefore says nothing about a break.
CELLS_NEEDED = 7

#: Which cell is what. Cell 0 is the local time, which is redundant beside the
#: row's own ``data-event-datetime`` and is not read.
CELL_COUNTRY = 1
CELL_IMPACT = 2
CELL_EVENT = 3
CELL_ACTUAL = 4
CELL_ESTIMATE = 5
CELL_PREVIOUS = 6

_ROW_RE = re.compile(r"<tr\b[^>]*>(?:(?!</tr>).)*</tr>", re.IGNORECASE | re.DOTALL)
_CELL_RE = re.compile(r"<td\b[^>]*>((?:(?!</td>).)*)</td>",
                      re.IGNORECASE | re.DOTALL)
_TAG_RE = re.compile(r"<[^>]*>")

#: The row's instant. investing.com writes it with slashes
#: (``2026/09/10 12:30:00``); the wire spells a date with hyphens everywhere
#: else on this desk, so both separators are accepted and one is emitted.
_DATETIME_RE = re.compile(
    r'data-event-datetime\s*=\s*"(\d{4})[/-](\d{2})[/-](\d{2})[ T]'
    r'(\d{2}:\d{2}:\d{2})"', re.IGNORECASE)

#: A date on this module's wire. Anchored with ``\Z`` rather than ``$`` because
#: ``$`` also matches before a trailing newline, and this string is
#: concatenated into a urlencoded body: a ``from`` of
#: ``2026-09-01&limit_from=999`` would otherwise smuggle a field into somebody
#: else's request.
_DATE_RE = re.compile(r"\d{4}-\d{2}-\d{2}\Z")

#: What a cell holding no figure looks like. ``&nbsp;`` has already become a
#: space and been stripped by the time this is consulted; ``--`` is the live
#: page's other spelling and must not reach the phone, which would render it
#: as a value.
_NO_FIGURE = ("", "--")


class _SafeCause(Exception):
    """A failure this module described itself, and may therefore quote.

    Every other exception :func:`_redact` sees was raised by a library that
    has no idea which of the cookies, URLs or headers it is quoting back came
    out of a Cloudflare handshake, so only its type survives. These two are
    assembled here, out of exception type names and this module's own words,
    and out of nothing else.
    """


class _TransportFailed(_SafeCause):
    """Every transport refused, or the chain ran out of time to ask.

    Carries the *type names* of what each attempt raised, in order, which is
    the diagnosis that matters: three ``ModuleNotFoundError``s mean neither
    optional library is installed and the stdlib path is what failed, where an
    ``HTTPError`` after two of them means the page answered and refused.

    A trailing :data:`BUDGET_SPENT` is the one entry that is not a type name.
    It means :data:`ECON_TOTAL_BUDGET` ran out before the next transport was
    started, and it is spelled as a phrase rather than as a class precisely so
    that nobody reading it in ``health()`` takes it for something the upstream
    did.
    """

    def __init__(self, kinds: Sequence[str]) -> None:
        self.kinds = tuple(kinds)
        super().__init__("no transport succeeded: " + ", ".join(self.kinds))


class _BadEnvelope(_SafeCause):
    """The body was not ``{"data": "<tr>..."}``.

    Which is the shape an outage most often takes: a challenge page, a block
    page or an HTML error served with a 200. Its message names the type of
    what arrived and never its content.
    """


def _redact(exc: BaseException) -> str:
    """The one safe description of an upstream failure.

    ``quotes.py`` redacts by substitution because it knows the two strings to
    remove. This module knows none -- whatever a challenge put in a cookie jar
    was never named to it -- so it redacts by **omission**, and the type name
    is what is left. A :class:`_SafeCause` is the exception to that, and the
    only one: its text was written here.
    """
    if isinstance(exc, _SafeCause):
        return str(exc)
    return type(exc).__name__


# -- the wire ---------------------------------------------------------------


def _headers() -> dict[str, str]:
    """What the calendar's own XHR sends. The only place these are named."""
    return {
        "User-Agent": USER_AGENT,
        "X-Requested-With": "XMLHttpRequest",
        "Referer": REFERER,
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "*/*",
    }


def _body(from_date: str, to_date: str) -> bytes:
    """The urlencoded POST body, built literally rather than urlencoded.

    ``urlencode`` would percent-escape ``importance[]`` into
    ``importance%5B%5D``, which is legal and which the endpoint would very
    probably decode identically -- but "very probably" is not what to spend on
    a request whose exact spelling is the only reason it answers at all. The
    dates are the only variable part and :func:`_date` has already established
    that they are ten characters of digits and hyphens, so there is nothing
    here left to escape.

    All three importances are asked for. Filtering to High would halve the
    payload and would also decide, here, that a Medium-impact release cannot
    matter to a position -- which is exactly the judgement the event book is
    for and exactly the judgement this module must not pre-empt.
    """
    return ("importance[]=1&importance[]=2&importance[]=3"
            f"&timeZone={TIMEZONE_ID}&timeFilter=timeRemain"
            "&currentTab=custom&limit_from=0"
            f"&dateFrom={from_date}&dateTo={to_date}").encode("ascii")


def _read_requests_response(response: object) -> bytes:
    """A bounded read of a ``requests``-shaped response.

    Shared by both optional transports because ``cloudscraper``'s scraper is a
    ``requests.Session``. ``response.content`` would read the whole body into
    memory before anything could cap it, which is the one thing
    :data:`MAX_UPSTREAM_BYTES` exists to prevent, so the body is streamed and
    the loop stops at the cap.
    """
    response.raise_for_status()                                    # type: ignore[attr-defined]
    chunks: list[bytes] = []
    size = 0
    for chunk in response.iter_content(65536):                     # type: ignore[attr-defined]
        chunks.append(chunk)
        size += len(chunk)
        if size >= MAX_UPSTREAM_BYTES:
            break
    return b"".join(chunks)[:MAX_UPSTREAM_BYTES]


def _via_cloudscraper(url: str, body: bytes, headers: dict[str, str]) -> bytes:
    """The first attempt, if the library happens to be installed.

    The import is inside the function and unguarded on purpose: an
    ``ImportError`` here is one more exception for :func:`_post_fetch` to fall
    through, which is the same thing it does with a Cloudflare challenge. A
    module-level ``try: import`` would make the absence of an optional library
    a different kind of event from its failure, and there is nothing this
    module would do differently about the two.
    """
    import cloudscraper                                            # noqa: PLC0415

    with cloudscraper.create_scraper().post(
            url, data=body, headers=headers,
            timeout=UPSTREAM_TIMEOUT, stream=True) as response:
        return _read_requests_response(response)


def _via_requests(url: str, body: bytes, headers: dict[str, str]) -> bytes:
    """The second attempt, if that library happens to be installed."""
    import requests                                                # noqa: PLC0415

    with requests.post(url, data=body, headers=headers,
                       timeout=UPSTREAM_TIMEOUT, stream=True) as response:
        return _read_requests_response(response)


def _via_urllib(url: str, body: bytes, headers: dict[str, str]) -> bytes:
    """The last attempt, and the one that is always available.

    This is what makes the desk's stdlib-only rule hold: with neither optional
    library installed the chain is one link long and this is it. No
    ``Accept-Encoding`` is sent, because ``urllib`` does not decompress and a
    gzipped body would arrive here as bytes that are not JSON.
    """
    request = urllib.request.Request(url, data=body, headers=headers,
                                     method="POST")
    with urllib.request.urlopen(request, timeout=UPSTREAM_TIMEOUT) as response:
        return response.read(MAX_UPSTREAM_BYTES)


#: The transports, best first. A module-level tuple rather than a chain written
#: into :func:`_post_fetch` so that a test can replace it and exercise the
#: fall-through without a network.
TRANSPORTS: tuple[Callable[[str, bytes, dict[str, str]], bytes], ...] = (
    _via_cloudscraper, _via_requests, _via_urllib)

#: What the chain measures :data:`ECON_TOTAL_BUDGET` against. Monotonic rather
#: than wall time, because this is a duration and an NTP correction mid-fetch
#: would otherwise make the budget already spent or never spendable. A module
#: attribute for :data:`TRANSPORTS`'s reason: a test replaces it and exercises
#: the budget without spending forty seconds proving it.
_elapsed: Callable[[], float] = time.monotonic

#: The entry :func:`_post_fetch` appends when it stops early. Not an exception
#: type, because nothing raised -- see :class:`_TransportFailed`.
BUDGET_SPENT = "budget spent"


def _post_fetch(url: str, body: bytes, headers: dict[str, str]) -> bytes:
    """POST ``body`` and return the answer. The injectable default.

    Every attempt is tried and **any** exception falls through to the next.
    That breadth is the point rather than a shortcut: the failure being
    designed around is an installed ``cloudscraper`` that hits a challenge it
    cannot solve, and a chain that fell through on ``ImportError`` alone would
    let one library's bad afternoon abort a request the plain stdlib path
    would have answered.

    The fall-through is bounded by :data:`ECON_TOTAL_BUDGET`, checked before
    each attempt after the first -- never before the first, which always runs,
    because a chain that could decline to make any request at all would report
    an upstream failure for a request nobody attempted. The check is at the
    start of an attempt rather than inside one for the reason a timeout cannot
    be: this function does not own the sockets, it owns the decision to open
    another.

    Nothing is logged with the exception's text -- only its type -- for the
    reason the module docstring gives.

    Raises:
        _TransportFailed: when every attempt did, or when the budget ran out
            first. Its message is the list of type names, plus
            :data:`BUDGET_SPENT` in the second case, and carries nothing from
            any of them.
    """
    kinds: list[str] = []
    started = _elapsed()
    for attempt in TRANSPORTS:
        if kinds and _elapsed() - started >= ECON_TOTAL_BUDGET:
            kinds.append(BUDGET_SPENT)
            break
        try:
            return attempt(url, body, headers)
        except Exception as exc:                                   # noqa: BLE001
            kinds.append(type(exc).__name__)
    raise _TransportFailed(kinds)


# -- the parser -------------------------------------------------------------


def _text(cell: str) -> str:
    """A cell's markup as the text a reader would see, or ``""``.

    Tags go first and entities second, in that order: unescaping first would
    turn an ``&lt;`` in an event's own name into a ``<`` that the tag stripper
    would then eat along with everything after it.

    A cell holding no figure comes back as ``""`` and never as ``None`` or
    ``"--"``. The phone renders these three fields as strings with their units
    attached, so ``None`` would print as "None" in one framework and vanish in
    another, and ``"--"`` is a value that looks like a value.
    """
    text = _TAG_RE.sub("", cell)
    text = _html.unescape(text)
    text = " ".join(text.split())          # \xa0 included; split() takes it
    return "" if text in _NO_FIGURE else text


def _impact(cell: str) -> str:
    """The word investing.com means by a cell's count of filled bull pips."""
    return IMPACTS[min(cell.count(BULL_ICON), len(IMPACTS) - 1)]


def _scan(rows_html: str) -> tuple[list[dict], int]:
    """Every event in the rows, ascending, and how many rows were unreadable.

    The two halves of the return are the whole reason this is separate from
    :func:`parse_rows`: a partial break -- the shape changing for some rows
    and not others -- is invisible in a shorter list and obvious in a count.

    A row with fewer than :data:`CELLS_NEEDED` cells is furniture rather than
    a failure and is neither parsed nor counted; see that constant. A row with
    the cells but no readable instant *is* a failure, and is counted.

    Sorting is by the emitted ``date`` string, which is ISO-ordered and
    therefore sorts as an instant. It is done here rather than trusted from
    the page because the wire contract says ascending and the page's order is
    the page's business -- it groups by day, and a window that crosses a
    "today" boundary has come back with the days in an order nobody promised.
    """
    events: list[dict] = []
    skipped = 0
    for row in _ROW_RE.findall(rows_html):
        cells = _CELL_RE.findall(row)
        if len(cells) < CELLS_NEEDED:
            continue
        when = _DATETIME_RE.search(row)
        if when is None:
            skipped += 1
            continue
        year, month, day, clock = when.groups()
        events.append({
            "date": f"{year}-{month}-{day} {clock}",
            "country": _text(cells[CELL_COUNTRY]),
            "event": _text(cells[CELL_EVENT]),
            "estimate": _text(cells[CELL_ESTIMATE]),
            "actual": _text(cells[CELL_ACTUAL]),
            "previous": _text(cells[CELL_PREVIOUS]),
            "impact": _impact(cells[CELL_IMPACT]),
        })
    events.sort(key=lambda event: event["date"])
    return events, skipped


def parse_rows(rows_html: str) -> list[dict]:
    """The pure half: investing.com's ``<tr>`` rows as events, ascending.

    Each event is ``{"date", "country", "event", "estimate", "actual",
    "previous", "impact"}``. ``date`` is ``"YYYY-MM-DD HH:MM:SS"`` in UTC,
    because :data:`TIMEZONE_ID` asked for GMT. The three figures are strings
    with their units attached -- ``"0.3%"``, ``"254K"``, ``"-1.8%"`` -- because
    that is what the page publishes and parsing them into numbers would mean
    inventing a unit field and getting it wrong for one release in fifty.

    Unreadable rows are dropped. Use :func:`_scan` when the count matters;
    :meth:`EconSource.events` does, and reports it through
    :meth:`EconSource.health`.
    """
    return _scan(rows_html)[0]


def _rows(raw: bytes) -> str:
    """The rows out of the ``{"data": "..."}`` envelope.

    Raises:
        _BadEnvelope: for anything else, which is what a challenge page, a
            block page or an HTML error served with a 200 arrives as. The
            message names the type of what came back and quotes none of it.
    """
    try:
        doc = json.loads(raw)
    except Exception as exc:                                       # noqa: BLE001
        raise _BadEnvelope(f"the body did not decode as JSON "
                           f"({type(exc).__name__})") from None
    data = doc.get("data") if isinstance(doc, dict) else None
    if not isinstance(data, str):
        raise _BadEnvelope(f"expected an object carrying a string 'data', "
                           f"got {type(doc).__name__}")
    return data


def _date(value: object, field: str) -> str:
    """``YYYY-MM-DD``, or a refusal naming the field.

    Refused rather than coerced, and refused before it can reach
    :func:`_body`. This is the only caller-supplied material that goes into the
    request, so the shape check is also what stops a query string from adding
    fields to somebody else's POST.

    Raises:
        ~claudepost.errors.BadRequest: because the caller sent it, and the
            message is read by whoever did.
    """
    if not isinstance(value, str) or not _DATE_RE.fullmatch(value):
        raise BadRequest(message=f"{field} is a date as YYYY-MM-DD")
    return value


class EconSource:
    """One economic calendar window, fetched at most once an hour.

    One instance is shared by every request thread. The cache and the health
    counters live under one lock, which is never held across an upstream call
    -- twenty-five seconds of a socket is not something to hold a mutex
    through -- so two threads asking for the same cold window at the same
    instant can both fetch it. That is a duplicated request at worst; a lock
    held across the network would make every other window wait for it.
    """

    def __init__(self, clock: Clock,
                 fetch: Callable[[str, bytes, dict], bytes] = _post_fetch) -> None:
        self._clock = clock
        self._fetch = fetch
        self._lock = threading.Lock()
        self._cache: dict[tuple[str, str], tuple[float, list[dict]]] = {}
        self._fetched_at: float | None = None
        self._parsed = 0
        self._skipped = 0
        self._error: str | None = None

    def events(self, from_date: str, to_date: str) -> list[dict]:
        """The releases between two dates, inclusive, ascending by ``date``.

        Both dates are ``YYYY-MM-DD`` and both are UTC, as everything on this
        desk's wires is. The list and its dicts are fresh objects, so a caller
        may sort, filter or annotate what it is given without editing the copy
        the next request will be answered from.

        A window already fetched within :data:`EVENTS_TTL` is answered without
        an upstream call. A window whose fetch fails is answered from the last
        good copy of *that same window* and the cause is recorded in
        :meth:`health`.

        Raises:
            ~claudepost.errors.BadRequest: for a date that is not
                ``YYYY-MM-DD``, or a ``to`` before the ``from``.
            ~claudepost.errors.Upstream: 502, when the fetch fails and there
                is no previous copy of this window to serve. An empty list
                would read as "nothing is happening this week", which is the
                false statement this module's failure policy exists to
                prevent; a 502 is the phone saying it could not ask. The
                message carries no upstream text -- see :func:`_redact`.
        """
        window = (_date(from_date, "from"), _date(to_date, "to"))
        if window[1] < window[0]:
            raise BadRequest(message="to must not be before from")

        now = self._clock.now()
        with self._lock:
            hit = self._cache.get(window)
            if hit is not None and hit[0] > now:
                return [dict(event) for event in hit[1]]

        try:
            events, skipped = _scan(_rows(
                self._fetch(CALENDAR_URL, _body(*window), _headers())))
        except Exception as exc:                                   # noqa: BLE001
            cause = _redact(exc)
            served = self._failed(window, cause, now)
        else:
            return self._fetched(window, events, skipped, now)
        # Out here rather than in the handler above, which is the whole trick
        # and the one `quotes.py` documents at length: Python attaches the
        # exception being handled to a new one's `__context__` at the moment of
        # the raise, and `from None` hides that from a printed traceback only
        # -- the raw error stays hanging off the object for anything that walks
        # the chain. By this line the handler has exited and there is nothing
        # in flight to attach. `from None` stays as well, so the suppression
        # holds if this raise is ever moved back inside.
        if served is None:
            raise Upstream(message=f"econ: {cause}") from None
        return served

    def health(self) -> dict:
        """What the last attempt did, for ``/api/state`` to show.

        ``ok`` is the last attempt, and ``error`` its cause when it failed --
        a type name, or this module's own words, and never an upstream
        library's text.

        ``parsed`` and ``skipped`` describe the last **successful** parse and
        are the reason this method exists. A regex over scraped HTML will
        break; the question is whether it breaks loudly. A break that takes
        every row shows up as ``parsed: 0``; a break that takes half of them
        shows up as ``skipped`` climbing, where the calendar itself would just
        look like a quiet week.

        ``fetched_at`` is when the newest copy of anything landed, so a home
        row can say how old the schedule it is showing may be rather than
        presenting it as current.
        """
        with self._lock:
            return {
                "ok": self._error is None,
                "error": self._error,
                "fetchedAt": self._fetched_at,
                "windows": len(self._cache),
                "parsed": self._parsed,
                "skipped": self._skipped,
            }

    # -- internals ---------------------------------------------------------

    def _fetched(self, window: tuple[str, str], events: list[dict],
                 skipped: int, now: float) -> list[dict]:
        """Cache a good answer, and say so if any of it was unreadable."""
        with self._lock:
            self._cache[window] = (now + EVENTS_TTL, events)
            self._fetched_at = now
            self._parsed = len(events)
            self._skipped = skipped
            self._error = None
        if skipped:
            LOG.warning("econ %s..%s: %d row(s) unreadable, %d parsed -- the "
                        "calendar's markup may have changed",
                        window[0], window[1], skipped, len(events))
        return [dict(event) for event in events]

    def _failed(self, window: tuple[str, str], cause: str,
                now: float) -> list[dict] | None:
        """Record the cause; re-serve the last good window, or admit there is none.

        The stale copy is re-stamped at :data:`FAILURE_TTL` rather than left
        expired, so a phone pulling to refresh through an outage makes one
        upstream request every five minutes instead of one per pull -- and the
        window returns of its own accord when the upstream does.
        """
        with self._lock:
            self._error = cause
            stale = self._cache.get(window)
            fetched_at = self._fetched_at
            if stale is None:
                events = None
            else:
                self._cache[window] = (now + FAILURE_TTL, stale[1])
                events = [dict(event) for event in stale[1]]
        if events is None:
            LOG.warning("econ %s..%s: unavailable (%s), and no earlier copy "
                        "of this window to serve", window[0], window[1], cause)
        else:
            LOG.warning("econ %s..%s: unavailable (%s), serving the copy "
                        "fetched at %s", window[0], window[1], cause, fetched_at)
        return events
