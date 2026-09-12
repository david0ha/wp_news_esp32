"""Yahoo's gated endpoints, fetched by the desk because the phone cannot.

Yahoo puts ``/v10/finance/quoteSummary`` and ``/v7/finance/options`` behind a
cookie and a crumb, and it decides who may have a crumb by looking at the
**TLS handshake** -- the JA3/JA4 fingerprint -- rather than at the User-Agent
or the address. Measured on one machine, one address, one minute:

===============================  ============  =============================
request                          plain client  browser-impersonating client
===============================  ============  =============================
``/v8/finance/chart``            429           200
``/v1/test/getcrumb``            429           200
``/v10/finance/quoteSummary``    429           200
``/v7/finance/options``          429           200
===============================  ============  =============================

That asymmetry is why the app's own bootstrap fails while its chart and news
keep working: ``/v1/test/getcrumb`` filters hardest, so the ungated endpoints
answer a React Native ``fetch`` and the crumb endpoint does not. **This cannot
be fixed in the app.** The TLS handshake belongs to NSURLSession on iOS and
OkHttp on Android; JavaScript cannot reach it, and Node has no equivalent of
``curl_cffi``. Adding headers does not help, because the refusal happens below
HTTP. So the desk asks, exactly as it already asks Alpaca on the phone's behalf
in :mod:`claudepost.quotes`, and for the same reason: the capability lives
where it can exist.

Four properties follow, and everything here is one of them.

**The crumb is bound to the cookie, so the connection is state.** ``fc.yahoo.com``
sets the cookie, ``getcrumb`` mints a crumb for that jar, and the gated call has
to present both. A client that opens a fresh connection per request throws the
cookie away in between and gets a 401 on every gated call while its bootstrap
reads as perfectly healthy -- a failure that looks like a bad crumb and is
really a missing cookie. So :class:`MarketService` holds a session, and
``open_session`` is what the tests replace.

**The body passes through unreshaped.** ``app/src/lib/market/yahoo.ts`` already
maps Yahoo's JSON into the app's model, defensively, with its own host tests.
Reshaping here would mean maintaining that mapping twice, in two languages,
against one upstream -- so this module returns Yahoo's own ``result[0]`` and
nothing else. The app keeps every mapper it has and loses only its crumb code.

**One crumb serves every device.** The app bootstrapped per install, which put
three cache-cold detail tabs on one phone into three bootstrap pairs against the
endpoint most likely to refuse them. Here there is one crumb for the whole desk,
re-fetched when Yahoo stops honouring it and not before.

**A refusal is one retry, never a loop.** Yahoo answers a stale crumb with a 401
or 403. That is worth exactly one new session and one retry; a second refusal is
an :class:`~claudepost.errors.Upstream`, because the phone polls and a loop here
is a loop against a rate limiter.

No credential is involved -- Yahoo has no account and no key -- which is the one
way this module is *simpler* than ``quotes.py`` rather than parallel to it.
There is nothing to redact, so there is no redaction.

``curl_cffi`` is the desk's first third-party Python dependency, and it earns
the exception: it ships as an ``abi3`` wheel, so no compiler enters the runtime
image, which is the property ``server/Dockerfile`` is built around. When it is
absent the module still imports and every fetch raises
:class:`~claudepost.errors.Upstream` naming the missing package, so a desk
without it serves the newspaper and says only that the market tabs are
unavailable.
"""

from __future__ import annotations

import json
import logging
import re
import threading
import urllib.parse
from collections.abc import Callable, Sequence
from typing import Protocol

from .clock import Clock
from .errors import BadRequest, NotFound, Upstream

LOG = logging.getLogger("claudepost.market")

BASE = "https://query1.finance.yahoo.com"
COOKIE_URL = "https://fc.yahoo.com/"
GETCRUMB_URL = f"{BASE}/v1/test/getcrumb"
QUOTE_SUMMARY_URL = f"{BASE}/v10/finance/quoteSummary/"
OPTIONS_URL = f"{BASE}/v7/finance/options/"

#: How long a crumb is worth reusing. Yahoo publishes no lifetime; twelve hours
#: is what the app used, and the retry contract is what actually handles expiry,
#: so this is a ceiling rather than a deadline.
CRUMB_TTL = 12 * 3600

#: Matched to what the app cached locally, so moving the call to the desk does
#: not change how stale a tab may be. A profile does not move within ten
#: minutes; an option chain does, which is why it is the short one.
SUMMARY_TTL = 10 * 60
OPTIONS_TTL = 2 * 60

#: Per upstream call.
UPSTREAM_TIMEOUT = 10.0

#: The most of an answer to read. An option chain for a heavily traded name is
#: the largest legitimate body here and is well under a megabyte; four bounds
#: the damage from a body that never ends without being near anything real.
MAX_UPSTREAM_BYTES = 4 * 1024 * 1024

#: What may be asked about. Wider than :data:`claudepost.quotes.SYMBOL_RE` --
#: which is narrow because Alpaca lists US equities only -- because Yahoo
#: answers for Korean listings too, and ``005930.KS`` is a symbol this desk
#: must be able to pass through. Deliberately no ``&``, ``?``, ``=`` or ``%``:
#: this value is interpolated into a URL, and this is what keeps it there.
SYMBOL_RE = re.compile(r"^[A-Za-z0-9.\-^]{1,20}\Z")

#: Which quoteSummary modules a caller may ask for. A whitelist rather than a
#: pass-through because the module list is the one part of the query a client
#: chooses, and an unbounded one turns this route into an open proxy for every
#: quoteSummary module Yahoo has -- the financial statements included.
ALLOWED_MODULES = frozenset({
    "assetProfile", "summaryDetail", "defaultKeyStatistics",
    "calendarEvents", "earningsHistory", "price",
})

#: The browser profile ``curl_cffi`` wears. The specific name matters less than
#: that it is a real, current browser: the point is the TLS fingerprint, and an
#: old profile is a fingerprint no real client has any more.
IMPERSONATE = "chrome"


class Session(Protocol):
    """What this module needs of an HTTP connection: a GET and a close.

    Narrow on purpose. It is the seam the tests replace, and every method it
    does not have is a piece of ``curl_cffi`` the rest of the desk cannot
    accidentally depend on.
    """

    def get(self, url: str, headers: dict) -> tuple[int, bytes]: ...
    def close(self) -> None: ...


class _ImpersonatingSession:
    """A ``curl_cffi`` session wearing a browser's TLS fingerprint.

    The cookie jar lives here, which is the whole point: the crumb Yahoo mints
    is only good on the jar that was present when it asked.

    The import is deferred to construction rather than done at module scope so
    that a desk built without ``curl_cffi`` still starts, still serves the
    newspaper, and fails only on the routes that need it.
    """

    def __init__(self) -> None:
        try:
            from curl_cffi import requests as impersonating
        except ImportError as exc:
            raise Upstream("market_unavailable",
                           "curl_cffi is not installed on this desk") from exc
        self._session = impersonating.Session(impersonate=IMPERSONATE)

    def get(self, url: str, headers: dict) -> tuple[int, bytes]:
        response = self._session.get(url, headers=headers,
                                     timeout=UPSTREAM_TIMEOUT,
                                     allow_redirects=True)
        return response.status_code, response.content[:MAX_UPSTREAM_BYTES]

    def close(self) -> None:
        self._session.close()


def _check_symbol(symbol: str) -> str:
    """The symbol, or a 400. Nothing unvalidated reaches a URL this desk builds."""
    if not isinstance(symbol, str) or not SYMBOL_RE.match(symbol):
        raise BadRequest("bad_symbol",
                         "symbol is not a listing this desk can ask about")
    return symbol


def _check_modules(modules: Sequence[str]) -> list[str]:
    """The modules, deduplicated and ordered, or a 400."""
    wanted = list(dict.fromkeys(modules))
    if not wanted:
        raise BadRequest("bad_modules", "at least one module is required")
    for name in wanted:
        if name not in ALLOWED_MODULES:
            raise BadRequest("bad_modules", f"unknown module {name!r}")
    return wanted


def _check_expiration(expiration: object) -> int | None:
    """An epoch second, or ``None``, or a 400."""
    if expiration is None:
        return None
    if isinstance(expiration, bool) or not isinstance(expiration, int) or expiration < 0:
        raise BadRequest("bad_expiration", "expiration must be epoch seconds")
    return expiration


def _decode(body: bytes) -> dict:
    """The body as an object, or a 502.

    An HTML error page served with a 200 is the usual shape of an upstream
    outage and arrives here as a ``JSONDecodeError``. A JSON document that is
    not an object is refused for the same reason: every envelope this module
    reads is keyed.
    """
    try:
        doc = json.loads(body.decode("utf-8", "replace"))
    except ValueError as exc:
        raise Upstream("upstream",
                       "Yahoo answered with a body that is not JSON") from exc
    if not isinstance(doc, dict):
        raise Upstream("upstream", f"expected an object, got {type(doc).__name__}")
    return doc


def _first_result(doc: dict, envelope: str, symbol: str) -> dict:
    """``doc[envelope]["result"][0]``, or the right refusal.

    An empty ``result`` is Yahoo's answer for a symbol it does not list, and it
    arrives with a 200 -- so it is a 404 here, not a 502. Nothing upstream
    failed; the company does not exist.
    """
    block = doc.get(envelope)
    if not isinstance(block, dict):
        raise Upstream("upstream", f"{envelope} envelope missing")
    result = block.get("result")
    if not isinstance(result, list):
        raise Upstream("upstream", f"{envelope} result missing")
    if not result or not isinstance(result[0], dict):
        raise NotFound("no_symbol", f"Yahoo lists nothing for {symbol}")
    return result[0]


def _crumb_looks_valid(crumb: str) -> bool:
    """A crumb is a short opaque token. An error page and a JSON blob are not.

    The length bound rejects an HTML body; the quote and angle-bracket checks
    reject the two shapes a refusal takes when it is short.
    """
    return (0 < len(crumb) <= 64
            and "<" not in crumb and '"' not in crumb and "\n" not in crumb)


class MarketService:
    """Yahoo's gated endpoints, session-managed and cached, for the whole desk.

    One instance is shared by every request thread. The session, the crumb and
    the response cache live under one lock, held only around the bookkeeping
    and never across an upstream call -- ten seconds of a socket is not
    something to hold a mutex through. Two threads asking about the same cold
    symbol at the same instant can therefore both fetch it, which is a
    duplicated call at worst.
    """

    def __init__(self, clock: Clock,
                 open_session: Callable[[], Session] = _ImpersonatingSession) -> None:
        self._clock = clock
        self._open_session = open_session
        self._lock = threading.Lock()
        self._session: Session | None = None
        self._crumb: tuple[float, str] | None = None
        self._cache: dict[str, tuple[float, dict]] = {}

    # -- the two public questions -------------------------------------------

    def quote_summary(self, symbol: str, modules: Sequence[str]) -> dict:
        """The requested quoteSummary modules for ``symbol``, as Yahoo sent them.

        Raises:
            ~claudepost.errors.BadRequest: the symbol or module list is not one
                this desk will put in a URL.
            ~claudepost.errors.NotFound: code ``no_symbol``, when Yahoo lists
                nothing under it.
            ~claudepost.errors.Upstream: Yahoo refused, timed out, rate-limited
                or answered with something unreadable.
        """
        sym = _check_symbol(symbol)
        wanted = _check_modules(modules)

        def ask(crumb: str) -> str:
            return (f"{QUOTE_SUMMARY_URL}{urllib.parse.quote(sym)}"
                    f"?modules={urllib.parse.quote(','.join(wanted))}"
                    f"&crumb={urllib.parse.quote(crumb, safe='')}")

        return self._cached(f"summary:{sym}:{','.join(wanted)}", SUMMARY_TTL,
                            ask, "quoteSummary", sym)

    def options(self, symbol: str, expiration: object) -> dict:
        """One expiration's option chain for ``symbol``, as Yahoo sent it.

        ``expiration`` of ``None`` asks for the front month, which is what the
        options tab opens on.
        """
        sym = _check_symbol(symbol)
        when = _check_expiration(expiration)

        def ask(crumb: str) -> str:
            tail = "" if when is None else f"&date={when}"
            return (f"{OPTIONS_URL}{urllib.parse.quote(sym)}"
                    f"?crumb={urllib.parse.quote(crumb, safe='')}{tail}")

        return self._cached(f"options:{sym}:{'front' if when is None else when}",
                            OPTIONS_TTL, ask, "optionChain", sym)

    # -- internals ----------------------------------------------------------

    def _cached(self, key: str, ttl: float, make_url: Callable[[str], str],
                envelope: str, symbol: str) -> dict:
        """Serve from the cache, or fetch and remember. Failures are not cached.

        A failure deliberately leaves no entry: the tab has a retry button, and
        a cached 502 would make that button do nothing for two minutes.
        """
        now = self._clock.now()
        with self._lock:
            entry = self._cache.get(key)
            if entry is not None and entry[0] > now:
                return entry[1]

        result = _first_result(_decode(self._gated(make_url, symbol)), envelope, symbol)

        with self._lock:
            self._cache[key] = (self._clock.now() + ttl, result)
        return result

    def _gated(self, make_url: Callable[[str], str], symbol: str) -> bytes:
        """A crumb-gated GET, with the one retry a stale crumb is worth.

        The retry drops the whole session rather than only the crumb. The two
        are one fact -- a crumb is minted for a cookie jar -- so keeping the
        jar and re-minting against it would present Yahoo the same pair it just
        refused.

        A 404 is turned into ``no_symbol`` here rather than in
        :meth:`_checked`, which the bootstrap also uses: a 404 from
        ``getcrumb`` would be Yahoo moving an endpoint, which is nothing like a
        company that does not exist. Unknown symbols arrive both ways -- a 200
        with an empty ``result`` from quoteSummary, a bare 404 from the option
        chain -- and the phone should not be able to tell which it was.
        """
        status, body = self._get(make_url(self._crumb_now()))
        if status in (401, 403):
            self._reset()
            status, body = self._get(make_url(self._crumb_now()))
            if status in (401, 403):
                raise Upstream("upstream",
                               f"Yahoo refused the crumb twice ({status})")
        if status == 404:
            raise NotFound("no_symbol", f"Yahoo lists nothing for {symbol}")
        return self._checked(status, body)

    def _checked(self, status: int, body: bytes) -> bytes:
        if status == 429:
            raise Upstream("rate_limited", "Yahoo is rate-limiting this desk")
        if status < 200 or status >= 300:
            raise Upstream("upstream", f"Yahoo responded {status}")
        return body

    def _get(self, url: str) -> tuple[int, bytes]:
        """One request on the desk's session. Any transport failure is a 502.

        No headers are added, and that is a fix rather than an omission:
        ``getcrumb`` serves ``text/plain``, so pinning ``Accept`` to
        ``application/json`` makes Yahoo answer the *bootstrap* with a 406 and
        takes the profile and options tabs down together while the chart above
        them keeps working. The general rule is the same as the special case --
        the point of this module is to look like a browser, and a header no
        browser would send is a hole in the disguise doing the work.
        ``curl_cffi``'s impersonation supplies the browser's own header set.

        The exception text is not quoted. There is no credential in it here,
        but a ``curl_cffi`` error names the URL it was fetching -- crumb and
        all -- and that string would reach a phone's error toast and whatever
        the owner pastes into an issue.
        """
        try:
            return self._session_now().get(url, {})
        except Upstream:
            raise
        except Exception as exc:                                   # noqa: BLE001
            LOG.warning("yahoo fetch failed (%s)", type(exc).__name__)
            raise Upstream("upstream", "could not reach Yahoo") from None

    def _session_now(self) -> Session:
        """The desk's session, opened on first use."""
        with self._lock:
            if self._session is not None:
                return self._session
        # Opened outside the lock: constructing it can raise, and on a desk
        # without curl_cffi that raise is the answer rather than an accident.
        opened = self._open_session()
        with self._lock:
            if self._session is None:
                self._session = opened
                return opened
        # Another thread won the race; keep theirs and drop ours.
        try:
            opened.close()
        except Exception:                                          # noqa: BLE001
            pass
        return self._session

    def _reset(self) -> None:
        """Drop the session and the crumb together. They are one fact."""
        with self._lock:
            old, self._session, self._crumb = self._session, None, None
        if old is not None:
            try:
                old.close()
            except Exception:                                      # noqa: BLE001
                pass

    def _crumb_now(self) -> str:
        """The cached crumb, or a fresh bootstrap on the current session."""
        with self._lock:
            held = self._crumb
            if held is not None and held[0] > self._clock.now():
                return held[1]

        crumb = self._bootstrap()
        with self._lock:
            self._crumb = (self._clock.now() + CRUMB_TTL, crumb)
        return crumb

    def _bootstrap(self) -> str:
        """Seed the cookie jar, then ask that jar for a crumb.

        The cookie request's own status is ignored: ``fc.yahoo.com`` answers
        404 by design and the ``Set-Cookie`` is the entire point. The ordering
        is not ignorable. A cookieless getcrumb answers 429 with the body "Too
        Many Requests", which is short enough and quote-free enough to pass for
        a crumb -- so getting this backwards surfaces as a 401 on every gated
        call rather than as an error here.
        """
        self._get(COOKIE_URL)
        status, body = self._get(GETCRUMB_URL)
        self._checked(status, body)

        crumb = body.decode("utf-8", "replace").strip()
        if not _crumb_looks_valid(crumb):
            raise Upstream("upstream",
                           "getcrumb answered with something that is not a crumb")
        return crumb
