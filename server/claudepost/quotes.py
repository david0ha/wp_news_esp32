"""Prices for the phone, fetched with a key the phone never sees.

The owner's phone wants a last price, a day's change and thirty daily closes
for the companies on the watchlist. Alpaca's market data API will give it all
three, and the naive way to arrange that is to put the API key in the app.
This module exists because that is the one arrangement that cannot be undone:
a key shipped inside an app binary is a key on every device that installed it,
recoverable from the bundle, and rotating it means a release. The desk already
holds the owner's secrets, is already the only thing the phone talks to, and
already sits behind a token -- so it fetches, and the key stays on one machine.

Three properties follow from that, and everything here is one of them.

**Nothing that escapes carries the credential.** Not the 502's ``detail``, not
a log line, not a chained traceback. This is not a stylistic preference: the
exception text from a failed HTTP call is assembled by a library that has no
idea which of the headers it is quoting back is a secret, and the desk's own
502 body is rendered on a phone screen and pasted into issues. So every string
built from an upstream failure goes through :func:`_redact` before it exists as
a message, the ``fetch`` call is wrapped so no raw exception text can reach
either a log or a message, and the wrapper raises ``from None`` so that an
unhandled path further up prints no "direct cause of" section carrying the raw
error. :func:`Credentials._load` goes further and never quotes the file's
contents at all -- the file *is* the secret, so the only safe half of a parse
error is which error it was.

**Integers, like everything else on this system's wires.** Prices arrive as
floating-point dollars and leave as ``int`` cents; a change arrives as nothing
and leaves as integer basis points. The board's own contract
(``docs/app-control.md``) is already integers-only for exactly the reason that
applies here -- 241.60 is not representable and a phone rendering
``241.60000000000002`` is a bug nobody can fix at the point it is seen -- and
the app has one set of formatters for money, so the desk speaks the same units
the board does: ``lastCents``, ``prevCloseCents``, ``changeBp``.

**A poll must not become an upstream request.** The free tier allows 200 calls
a minute for the whole desk, and a phone that pulls to refresh is a phone that
does it repeatedly. Snapshots are cached for a minute and daily bars for an
hour -- a daily close does not move within the day, and a price that is sixty
seconds stale is a price nobody trading off a newspaper will notice. The cache
is per *symbol* rather than per request, because "AAPL" and "AAPL,MSFT" are the
same question about AAPL, and only the symbols whose entries have expired are
asked about upstream. A request answered entirely from the cache makes no call
at all.

**Both snapshot envelopes.** Alpaca's multi-symbol snapshot response has
shipped as a bare ``{SYMBOL: {...}}`` map -- what the current reference for
``GET /v2/stocks/snapshots`` documents -- and wrapped under a ``"snapshots"``
key beside a ``next_page_token``. Both are accepted here, and neither is
"the" shape, because a parser that knows only the one that was live on the day
it was written breaks on an afternoon when nobody deployed anything.

The credentials file, ``$CLAUDEPOST_SECRETS/alpaca.json``, beside
``tokens.json`` and mounted the same read-only way::

    {"key_id": "...", "secret_key": "..."}

No file means no quotes: :meth:`QuoteService.quotes` raises
:class:`~claudepost.errors.NotFound` with the code ``no_quotes``, which is a
404 the app can hide a tab behind rather than an error it has to explain. A
desk whose owner has no Alpaca account is a desk that serves the newspaper and
says nothing about prices, which is a complete configuration.
"""

from __future__ import annotations

import datetime
import json
import logging
import math
import os
import re
import threading
import urllib.request
from collections.abc import Callable, Sequence

from .clock import Clock
from .errors import NotFound, Upstream

LOG = logging.getLogger("claudepost.quotes")

#: How long a last price is worth reusing. A minute is the resolution of the
#: question being asked -- the phone is showing a newspaper's companies, not a
#: trading screen -- and it is what keeps a pull-to-refresh from spending the
#: rate limit.
SNAPSHOT_TTL = 60

#: How long a set of daily closes is worth reusing. A daily bar does not move
#: within the day; the hour is a bound on how long after a close the sparkline
#: can be missing its newest point, not on how stale the data may be.
BARS_TTL = 3600

#: The route's cap on one request, read by ``http.py``'s handler rather than
#: enforced here: the refusal belongs at the door, where it can be a 400 that
#: names the problem. Thirty-two is more companies than one watchlist carries.
MAX_SYMBOLS = 32

#: Daily closes per symbol -- about six trading weeks, which is the span a
#: sparkline beside a price is read over.
BAR_LIMIT = 30

#: How far back the bars request reaches. Thirty *trading* days is about
#: forty-two calendar ones; sixty leaves room for holidays and long weekends
#: while keeping the window short enough that :data:`BAR_LIMIT` per symbol is
#: never the binding constraint. See :meth:`QuoteService._get_bars` for why the
#: window matters more than the limit does.
BARS_WINDOW_DAYS = 60

#: IEX rather than SIP: it is the feed the free plan serves, and a consolidated
#: tape is not worth a subscription for a page that prints once a day.
FEED = "iex"

#: Per upstream call. Two calls at worst, so twelve seconds against
#: ``http.py``'s 120-second socket timeout and cloudflared's 90-second one --
#: a request that hangs here still answers well inside both.
UPSTREAM_TIMEOUT = 6.0

SNAPSHOTS_URL = "https://data.alpaca.markets/v2/stocks/snapshots"
BARS_URL = "https://data.alpaca.markets/v2/stocks/bars"

#: What Alpaca can be asked about. No digits, deliberately, and this is the one
#: place in the desk where the shape of a symbol differs from
#: :data:`claudepost.watchlist.SYMBOL_RE`: a watchlist item can be Korean,
#: where a listing is numeric (``005930``), and this provider lists US equities
#: only.
#:
#: **It is not the route's validation.** The phone sends its whole watchlist in
#: one call, so a Korean holding must not turn the request into a 400 that
#: costs every other company its price. The route checks the wider watchlist
#: shape; this narrower one decides which of those symbols there is any point
#: asking Alpaca about, and a symbol that fails it is simply absent from the
#: map -- indistinguishable, and rightly so, from one the upstream skipped.
SYMBOL_RE = re.compile(r"^[A-Z.\-]{1,12}\Z")

#: What a credential becomes on its way into any string a human might read.
REDACTED = "<redacted>"


def _redact(text: str, key_id: str, secret: str) -> str:
    """Replace both halves of the credential wherever they appear.

    The secret goes first so that a message quoting both is cleaned of the
    dangerous half even if the loop is ever cut short. An empty half is
    skipped: ``"".replace`` matches between every character and would turn a
    message somebody has to diagnose into confetti.
    """
    out = text
    for part in (secret, key_id):
        if part:
            out = out.replace(part, REDACTED)
    return out


class Credentials:
    """``alpaca.json``, re-read when it changes underneath the process.

    Modelled on :class:`claudepost.auth.Tokens` -- the same stat stamp, the
    same rule that a missing file is not an error -- with one difference that
    matters. ``Tokens`` raises on a malformed file and is reloaded from the
    scheduler tick, where an exception becomes a log line. :meth:`get` is
    called on the request path instead, so it **never raises**: a half-written
    file must be "no quotes today", which is a 404 the app already handles,
    rather than a 500 on a route the phone polls.

    Every state is one assignment of a ``(stamp, pair)`` tuple, so a request
    thread reading while another reloads sees one or the other whole. Writing
    the two fields separately would let a reader take a new stamp with an old
    pair and then never reload.
    """

    def __init__(self, path: str) -> None:
        self._path = path
        self._state: tuple[tuple[int, int, int] | None, tuple[str, str] | None]
        self._state = (None, None)
        self._load()

    def get(self) -> tuple[str, str] | None:
        """``(key_id, secret_key)``, or ``None`` if the desk has no key.

        Reloads first if the file's identity, size or mtime moved -- so a key
        dropped into the secrets mount, or rotated in place, takes effect on
        the next request rather than on the next restart.
        """
        stamp, pair = self._state
        if self._stat() != stamp:
            self._load()
            _, pair = self._state
        return pair

    # -- internals ---------------------------------------------------------

    def _stat(self) -> tuple[int, int, int] | None:
        """The file's identity, as far as "has it changed" needs to know."""
        try:
            st = os.stat(self._path)
        except OSError:
            return None
        return (st.st_ino, st.st_size, st.st_mtime_ns)

    def _load(self) -> None:
        """Read the file, or decide there is no key. Cannot fail.

        The breadth of the ``except`` is deliberate. This runs on the request
        path, where the contract is that no credential is a 404 -- so an
        exception type nobody predicted has to mean "no key", not a 500.

        The log line names the error's *type* and never its text, because the
        thing being parsed is the secret itself: a ``JSONDecodeError`` quoting
        the line it choked on, or a ``KeyError`` naming a key, is exactly the
        leak the rest of this module is built to prevent. The path and the
        class of failure are the half a human needs to fix it.
        """
        stamp = self._stat()
        pair: tuple[str, str] | None = None
        if stamp is not None:
            try:
                with open(self._path, "r", encoding="utf-8") as f:
                    doc = json.load(f)
                # Stripped because the usual way this file is made is a paste,
                # and a trailing newline inside the string would otherwise
                # become an illegal header value and a puzzling 502.
                key_id = doc["key_id"].strip()
                secret = doc["secret_key"].strip()
            except Exception as exc:                               # noqa: BLE001
                LOG.warning("%s: unusable (%s)", self._path, type(exc).__name__)
            else:
                if key_id and secret:
                    pair = (key_id, secret)
                else:
                    LOG.warning("%s: key_id and secret_key must both be set",
                                self._path)
        self._state = (stamp, pair)


def _urlopen_fetch(url: str, headers: dict[str, str]) -> bytes:
    """GET ``url`` and return the body. The only place ``urllib`` appears.

    It is a module-level function and an injectable default rather than a
    method so that every test in this module runs without a network, a socket
    or a mock of the standard library -- and so that the code holding the
    credential can be read without reading anything about HTTP.
    """
    request = urllib.request.Request(url, headers=headers, method="GET")
    with urllib.request.urlopen(request, timeout=UPSTREAM_TIMEOUT) as response:
        return response.read()


def _headers(key_id: str, secret: str) -> dict[str, str]:
    """Alpaca's two authentication headers. The only place they are named."""
    return {
        "APCA-API-KEY-ID": key_id,
        "APCA-API-SECRET-KEY": secret,
        "Accept": "application/json",
    }


def _cents(value: object) -> int | None:
    """A price in dollars as an integer of cents, or ``None`` if it is not one.

    ``bool`` is refused because ``True`` is an ``int`` to ``isinstance`` and
    one cent to arithmetic. A non-finite float is refused because Python's JSON
    decoder accepts ``NaN`` and ``Infinity``, and ``int(round(nan))`` raises --
    which would turn one bad field in one symbol into a 502 for the request.
    """
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if not math.isfinite(value):
        return None
    return int(round(value * 100))


def _field(doc: dict, outer: str, inner: str) -> object:
    """``doc[outer][inner]`` when both exist and the outer is an object."""
    block = doc.get(outer)
    return block.get(inner) if isinstance(block, dict) else None


def _basis_points(last: int, prev: int) -> int:
    """The change from ``prev`` to ``last``, in hundredths of a percent.

    A previous close of zero -- a symbol that listed this morning, or a field
    the upstream omitted -- is no change rather than a division by zero. Zero
    is the honest answer: the page has nothing to compare against, and that is
    what "unchanged" renders as.
    """
    if prev <= 0:
        return 0
    return round((last - prev) * 10000 / prev)


def _parse_snapshots(doc: object, symbols: Sequence[str]) -> dict[str, dict]:
    """The snapshot envelope -- either envelope -- as one row per symbol.

    A symbol the upstream did not answer for is **absent** from the result
    rather than present with zeroes. Zeroes would print as "$0.00, unchanged",
    which is a false statement about a company; an absent key is a gap the
    phone can leave blank.

    Raises:
        ValueError: when the body is not either envelope, which the caller
            turns into a 502. That covers an HTML error page served with a
            200, which is the shape an upstream outage most often takes.
    """
    rows = doc.get("snapshots") if isinstance(doc, dict) else None
    if not isinstance(rows, dict):
        # The bare-map fallback needs evidence that it *is* the bare map, and
        # "it is a dict" is not evidence: an upstream refusal served with a 200
        # -- `{"message": "forbidden"}`, `{"code": 40110000, ...}` -- is a dict
        # too, and taking it as an empty answer would report every symbol as
        # skipped, cache that for a minute, and hand the phone a 200 with an
        # empty map and nothing to say why. An empty object is accepted (there
        # is nothing to disagree with), and otherwise at least one of the
        # symbols that were *asked about* has to be a key of it.
        if not (isinstance(doc, dict)
                and (not doc or any(s in doc for s in symbols))):
            raise ValueError(f"expected a snapshot object, got "
                             f"{type(doc).__name__} carrying no requested symbol")
        rows = doc

    out: dict[str, dict] = {}
    for symbol in symbols:
        snap = rows.get(symbol)
        if not isinstance(snap, dict):
            continue
        # The last trade is the better answer and is not always there: outside
        # market hours, and on the IEX feed for a symbol that did not trade on
        # IEX today, there is only the daily bar. Falling back to its close is
        # what makes a quote appear at all on a Sunday.
        last = _cents(_field(snap, "latestTrade", "p"))
        if last is None:
            last = _cents(_field(snap, "dailyBar", "c"))
        if last is None:
            continue
        prev = _cents(_field(snap, "prevDailyBar", "c"))
        prev = 0 if prev is None else prev
        out[symbol] = {
            "lastCents": last,
            "prevCloseCents": prev,
            "changeBp": _basis_points(last, prev),
        }
    return out


def _parse_bars(doc: object, symbols: Sequence[str]) -> dict[str, list[dict]]:
    """The bars envelope as one ascending series of ``{"t", "c"}`` per symbol.

    The timestamp is cut to its date. A daily bar's clock time is the
    exchange's session boundary, which is not a fact about the company and is
    not in the reader's zone; the phone would strip it to draw an axis anyway.

    The series is sorted here rather than trusted from the wire. The request
    asks for the newest bars first (see :meth:`QuoteService._get_bars` for
    why), the sparkline reads left to right, and sorting is both the reversal
    and the insurance against an upstream that one day honours ``sort``
    differently -- getting that wrong silently draws six weeks backwards.
    """
    rows = doc.get("bars") if isinstance(doc, dict) else None
    if not isinstance(rows, dict):
        raise ValueError(f"expected a bars object, got {type(doc).__name__}")

    out: dict[str, list[dict]] = {}
    for symbol in symbols:
        series = rows.get(symbol)
        if not isinstance(series, list):
            continue
        kept: list[dict] = []
        for raw in series:
            if not isinstance(raw, dict):
                continue
            when = raw.get("t")
            close = _cents(raw.get("c"))
            if not isinstance(when, str) or close is None:
                continue
            kept.append({"t": when[:10], "c": close})
        if kept:
            kept.sort(key=lambda bar: bar["t"])
            out[symbol] = kept[-BAR_LIMIT:]
    return out


class QuoteService:
    """Snapshots and daily bars for a list of symbols, cached and proxied.

    One instance is shared by every request thread. The two caches live under
    one lock rather than one each: they are read and written in the same
    method, and a second lock would buy nothing but an order to get wrong.
    The lock is never held across an upstream call -- six seconds of a socket
    is not something to hold a mutex through -- which means two threads asking
    about the same cold symbol at the same instant can both fetch it. That is
    a duplicated call at worst, and the alternative (a lock held across the
    network) makes every other symbol wait for it.
    """

    def __init__(self, creds: Credentials, clock: Clock,
                 fetch: Callable[[str, dict], bytes] = _urlopen_fetch) -> None:
        self._creds = creds
        self._clock = clock
        self._fetch = fetch
        self._lock = threading.Lock()
        self._snapshots: dict[str, tuple[float, dict | None]] = {}
        self._bars: dict[str, tuple[float, list | None]] = {}

    def quotes(self, symbols: Sequence[str]) -> dict[str, dict]:
        """One row per symbol the upstream knows, keyed by symbol.

        Each row is ``{"lastCents", "prevCloseCents", "changeBp", "bars"}``,
        every number an ``int``, ``bars`` oldest first and possibly empty.

        The row and its ``bars`` list are fresh objects, so a caller may
        reorder or truncate what it is given. The bar dicts inside that list
        are the cached ones and must not be mutated in place -- the one caller
        serialises the result and drops it.

        Raises:
            ~claudepost.errors.NotFound: code ``no_quotes``, when the desk
                holds no Alpaca key. Nothing is asked of anybody first.
            ~claudepost.errors.Upstream: 502, for anything the upstream does
                -- refusing, timing out, or answering with a body that is
                neither envelope. Its message carries no credential.
        """
        pair = self._creds.get()
        if pair is None:
            raise NotFound("no_quotes")
        key_id, secret = pair

        # Deduplicated because two of the same symbol is one question, and
        # filtered because a symbol this provider cannot answer for should not
        # be asked about and must never reach a query string. Silently, on
        # purpose: the phone sends its whole watchlist in one call, and a
        # Korean listing among the tickers has to leave the other companies
        # with their prices rather than turning the request into an error. The
        # symbol is absent from the map, which is the same thing the phone
        # already handles for a symbol the upstream skipped.
        wanted = [s for s in dict.fromkeys(symbols) if SYMBOL_RE.match(s)]
        if not wanted:
            return {}

        now = self._clock.now()

        snaps, stale = self._cached(self._snapshots, wanted, now)
        if stale:
            fresh = self._get_snapshots(stale, key_id, secret)
            self._remember(self._snapshots, stale, fresh,
                           now + SNAPSHOT_TTL, now + SNAPSHOT_TTL)
            snaps.update(fresh)

        series, stale = self._cached(self._bars, wanted, now)
        if stale:
            fresh_bars = self._get_bars(stale, key_id, secret)
            self._remember(self._bars, stale, fresh_bars,
                           now + BARS_TTL, now + SNAPSHOT_TTL)
            series.update(fresh_bars)

        out: dict[str, dict] = {}
        for symbol in wanted:
            row = snaps.get(symbol)
            if row is None:
                continue
            # Bars are the sparkline and the snapshot is the number: a symbol
            # with no daily history still has a price worth printing. The list
            # is copied because the one the cache holds is the one the next
            # request will be answered with, and a caller that reverses or
            # truncates its own copy should not be rewriting history.
            out[symbol] = dict(row, bars=list(series.get(symbol) or []))
        return out

    # -- the cache ---------------------------------------------------------

    def _cached(self, cache: dict, symbols: Sequence[str],
                now: float) -> tuple[dict, list[str]]:
        """What is still fresh, and what has to be asked about.

        A symbol whose cached value is ``None`` was asked about and skipped by
        the upstream. It is fresh and it is not stale: it contributes nothing
        to the answer and nothing to the next request either, because "Alpaca
        does not list this" is a stable fact and re-asking it on every poll is
        how one wrong symbol in a watchlist spends the whole rate limit.
        """
        have: dict = {}
        stale: list[str] = []
        with self._lock:
            for symbol in symbols:
                hit = cache.get(symbol)
                if hit is not None and hit[0] > now:
                    if hit[1] is not None:
                        have[symbol] = hit[1]
                else:
                    stale.append(symbol)
        return have, stale

    def _remember(self, cache: dict, asked: Sequence[str], fresh: dict,
                  hit_expires: float, miss_expires: float) -> None:
        """Cache every symbol that was asked about, including the misses.

        A miss can be given a shorter life than a hit, and for bars it is: a
        symbol with a price but no daily history is usually the transient case
        -- a fresh listing, a series that has not populated -- so it is worth
        re-asking in a minute, where holding an empty sparkline for an hour
        would be an hour of a company looking like it has no past.
        """
        with self._lock:
            for symbol in asked:
                value = fresh.get(symbol)
                cache[symbol] = (
                    hit_expires if value is not None else miss_expires, value)

    # -- the upstream ------------------------------------------------------

    def _get_snapshots(self, symbols: Sequence[str], key_id: str,
                       secret: str) -> dict[str, dict]:
        """Last price and previous close for each symbol."""
        url = f"{SNAPSHOTS_URL}?symbols={','.join(symbols)}&feed={FEED}"
        return self._get(url, key_id, secret, "snapshots",
                         lambda doc: _parse_snapshots(doc, symbols))

    def _get_bars(self, symbols: Sequence[str], key_id: str,
                  secret: str) -> dict[str, list[dict]]:
        """The daily closes behind each symbol's sparkline.

        **The window is what makes this correct, not the limit.** ``limit``
        bounds the *total* data points across every symbol rather than the
        points per symbol, and Alpaca does not document how it divides them --
        so a request relying on ``limit`` alone would be relying on an
        undocumented property, and if the upstream ever filled symbol by
        symbol the first company would take every bar and the rest would draw
        nothing. Asking for a bounded ``start`` instead makes the limit
        non-binding: sixty calendar days of daily bars is at most about
        forty-two per symbol, so every symbol's series arrives whole and
        ``limit`` is left in as a ceiling on a pathological response.

        ``sort=desc`` remains because with no ``start`` at all the range would
        begin at the earliest data Alpaca holds; it is now belt as well as
        braces, and :func:`_parse_bars` sorts the result regardless.
        """
        start = datetime.datetime.fromtimestamp(
            self._clock.now() - BARS_WINDOW_DAYS * 86400,
            tz=datetime.timezone.utc).date().isoformat()
        url = (f"{BARS_URL}?symbols={','.join(symbols)}"
               f"&timeframe=1Day&start={start}"
               f"&limit={BAR_LIMIT * len(symbols)}"
               f"&sort=desc&feed={FEED}")
        return self._get(url, key_id, secret, "bars",
                         lambda doc: _parse_bars(doc, symbols))

    def _get(self, url: str, key_id: str, secret: str, what: str,
             parse: Callable[[object], dict]) -> dict:
        """Fetch, decode and parse, with one guard around all three.

        The guard is the point of this method. Every way the upstream can fail
        -- a refusal, a timeout, a TLS error, a body that is not JSON, a body
        that is JSON but not an envelope -- arrives here as an exception whose
        text was written by a library that does not know which of the headers
        it may be quoting is a secret. So the text is redacted *before* it
        becomes a message or a log line, and the original is not carried out
        of here in any form.
        """
        try:
            raw = self._fetch(url, _headers(key_id, secret))
            return parse(json.loads(raw))
        except Exception as exc:                                   # noqa: BLE001
            safe = _redact(f"{type(exc).__name__}: {exc}", key_id, secret)
            LOG.warning("%s: upstream failed (%s)", what, safe)
            failure = Upstream(message=f"{what}: {safe}")
        # Raised out here rather than inside the handler, which is the whole
        # trick: Python attaches the exception being handled to the new one's
        # `__context__` at the moment of the raise, and `raise ... from None`
        # only hides that from a *printed* traceback -- the raw error, headers
        # and all, stays hanging off the object for anything that walks the
        # chain. By this line the handler has exited and there is nothing in
        # flight to attach. `from None` stays as well, so the suppression
        # holds if this raise is ever moved back inside.
        raise failure from None
