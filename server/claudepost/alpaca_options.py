"""Read-only option chains from Alpaca's market-data API.

Fetch every page before publishing expiration choices; a capped or malformed
chain is an error, never a seemingly complete partial result. Restrict the root
symbol to exclude adjusted roots; verify sizes separately with contract metadata.
Snapshots do not provide volume or open interest: those fields remain null.
See https://docs.alpaca.markets/us/reference/optionchain .
"""
from __future__ import annotations

import datetime as dt
import json
import math
import re
from urllib.error import HTTPError
from urllib.parse import urlencode

from .clock import Clock
from .errors import BadRequest, NotFound, Upstream
from .quotes import Credentials, UPSTREAM_TIMEOUT, _urlopen_fetch

CHAIN_URL = 'https://data.alpaca.markets/v1beta1/options/snapshots/'
STOCK_URL = 'https://data.alpaca.markets/v2/stocks/'
MAX_PAGES = 50


def number(value):
    return value if type(value) in (int, float) and math.isfinite(value) else None


class OptionService:
    def __init__(self, credentials: Credentials, clock=None, *, fetch=None):
        self.credentials = credentials
        self.clock = clock or Clock()
        self.fetch = fetch or _urlopen_fetch
        self._cache = {}
        self._metadata_cache = {}

    def _get(self, url, headers):
        result = json.loads(self.fetch(url, headers))
        if not isinstance(result, dict):
            raise ValueError('invalid object')
        return result

    def _chain(self, symbol, feed, headers, deadline):
        snapshots, seen = {}, set()
        params = {'feed': feed, 'limit': 1000, 'root_symbol': symbol}
        for _ in range(MAX_PAGES):
            if self.clock.monotonic() + UPSTREAM_TIMEOUT >= deadline:
                raise ValueError('option chain deadline exceeded')
            doc = self._get(CHAIN_URL + symbol + '?' + urlencode(params), headers)
            page = doc.get('snapshots')
            if not isinstance(page, dict):
                raise ValueError('invalid snapshots')
            snapshots.update(page)
            token = doc.get('next_page_token')
            if token is None or token == '':
                return snapshots
            if not isinstance(token, str) or token in seen:
                raise ValueError('invalid pagination')
            seen.add(token)
            params['page_token'] = token
        raise ValueError('incomplete chain')

    def _contracts(self, host, symbol, date, headers, deadline):
        contracts, seen = {}, set()
        params = {'underlying_symbols': symbol, 'root_symbol': symbol,
                  'expiration_date': date, 'limit': 10000}
        for _ in range(MAX_PAGES):
            if self.clock.monotonic() + UPSTREAM_TIMEOUT >= deadline:
                raise TimeoutError
            doc = self._get(host + '/v2/options/contracts?' + urlencode(params), headers)
            page = doc.get('option_contracts')
            if not isinstance(page, list):
                raise ValueError('invalid contracts')
            for contract in page:
                if not isinstance(contract, dict) or not isinstance(contract.get('symbol'), str):
                    raise ValueError('invalid contract')
                contracts[contract['symbol']] = contract
            token = doc.get('next_page_token')
            if token is None or token == '':
                return contracts
            if not isinstance(token, str) or token in seen:
                raise ValueError('invalid pagination')
            seen.add(token)
            params['page_token'] = token
        raise ValueError('incomplete contracts')

    def _metadata(self, symbol, expiration, pair, headers, deadline, fresh):
        cache_key = (symbol, expiration, pair)
        cached = None if fresh else self._metadata_cache.get(cache_key)
        if cached is not None and cached[0] > self.clock.monotonic():
            return cached[1]
        date = dt.datetime.fromtimestamp(expiration, dt.timezone.utc).date().isoformat()
        try:
            try:
                contracts = self._contracts('https://paper-api.alpaca.markets', symbol, date, headers, deadline)
            except HTTPError as exc:
                if exc.code not in (401, 403):
                    raise
                contracts = self._contracts('https://api.alpaca.markets', symbol, date, headers, deadline)
        except Exception:
            # Metadata is optional, and failures must not fabricate a size or
            # expose transport details containing credentials.
            return {}
        if len(self._metadata_cache) >= 32:
            self._metadata_cache.clear()
        self._metadata_cache[cache_key] = (self.clock.monotonic() + 15, contracts)
        return contracts

    @staticmethod
    def _size(metadata, symbol, expiration, kind, strike):
        date = dt.datetime.fromtimestamp(expiration, dt.timezone.utc).date().isoformat()
        if (metadata.get('root_symbol') != symbol or metadata.get('underlying_symbol') != symbol
                or metadata.get('expiration_date') != date
                or metadata.get('type') != ('call' if kind == 'C' else 'put')):
            return None
        try:
            size = float(metadata['size'])
            metadata_strike = float(metadata['strike_price'])
        except (KeyError, TypeError, ValueError, OverflowError):
            return None
        if (type(metadata['size']) is bool or not math.isfinite(size)
                or size <= 0 or not size.is_integer() or metadata_strike != strike):
            return None
        return int(size)

    def options(self, symbol, expiration=None, *, fresh=False):
        if not isinstance(symbol, str) or not re.fullmatch(r'[A-Z][A-Z.]{0,9}', symbol):
            raise BadRequest(message='symbol must be an uppercase stock symbol')
        if expiration is not None and (type(expiration) is not int or not 0 < expiration < 253402300800 or expiration % 86400):
            raise BadRequest(message='date must be UTC midnight epoch seconds')
        pair = self.credentials.get()
        if pair is None:
            raise NotFound('no_options', 'Alpaca credentials are not configured')
        headers = {'APCA-API-KEY-ID': pair[0], 'APCA-API-SECRET-KEY': pair[1]}
        deadline = self.clock.monotonic() + 23
        cache_key = (symbol, pair)
        cached = None if fresh else self._cache.get(cache_key)
        feed = 'opra'
        try:
            if cached is not None and cached[0] > self.clock.monotonic():
                _, feed, snapshots = cached
            else:
                try:
                    snapshots = self._chain(symbol, feed, headers, deadline)
                except HTTPError as exc:
                    if exc.code != 403:
                        raise
                    feed = 'indicative'
                    snapshots = self._chain(symbol, feed, headers, deadline)
                if len(self._cache) >= 32:
                    self._cache.clear()
                self._cache[cache_key] = (self.clock.monotonic() + 15, feed, snapshots)
            parsed = []
            for contract, snapshot in snapshots.items():
                match = re.fullmatch(re.escape(symbol) + r'(\d{6})([CP])(\d{8})', contract)
                if not match:
                    continue
                if not isinstance(snapshot, dict):
                    raise ValueError('invalid snapshot')
                date = dt.datetime.strptime('20' + match[1], '%Y%m%d').replace(tzinfo=dt.timezone.utc)
                parsed.append((int(date.timestamp()), match[2], int(match[3]) / 1000, contract, snapshot))
        except Exception:
            # Never return exception text: transports may include credential
            # headers, upstream bodies or URLs in their exception messages.
            raise Upstream('options_upstream', 'Alpaca option data is unavailable or incomplete') from None
        dates = sorted({row[0] for row in parsed})
        if not dates:
            raise NotFound('no_options', 'No standard option contracts are available')
        expiration = dates[0] if expiration is None else expiration
        if expiration not in dates:
            raise NotFound('no_expiration', 'The selected expiration is unavailable')
        metadata = self._metadata(symbol, expiration, pair, headers, deadline, fresh)
        spot = None
        try:
            if self.clock.monotonic() + UPSTREAM_TIMEOUT >= deadline:
                raise TimeoutError
            stock = self._get(STOCK_URL + symbol + '/snapshot?feed=iex', headers)
            spot = number((stock.get('latestTrade') or {}).get('p'))
        except Exception:
            pass  # Stock data availability does not determine option availability.
        result = {'symbol': symbol, 'spot': spot, 'expirationDates': dates,
                  'expiration': expiration, 'calls': [], 'puts': [],
                  'source': 'alpaca', 'feed': feed}
        for date, kind, strike, contract, snapshot in sorted(parsed):
            if date != expiration:
                continue
            quote = snapshot.get('latestQuote') or {}
            trade = snapshot.get('latestTrade') or {}
            greeks = snapshot.get('greeks') or {}
            if not all(isinstance(value, dict) for value in (quote, trade, greeks)):
                raise Upstream('options_upstream', 'Alpaca returned an invalid snapshot')
            row = {'symbol': contract, 'strike': strike,
                   'lastPrice': number(trade.get('p')), 'bid': number(quote.get('bp')),
                   'ask': number(quote.get('ap')), 'volume': None, 'openInterest': None,
                   'impliedVolatility': number(snapshot.get('impliedVolatility')),
                   'inTheMoney': None if spot is None else (spot > strike if kind == 'C' else spot < strike),
                   'quoteTimestamp': quote.get('t') if isinstance(quote.get('t'), str) else None,
                   'tradeTimestamp': trade.get('t') if isinstance(trade.get('t'), str) else None,
                   'multiplier': self._size(metadata.get(contract, {}), symbol, expiration, kind, strike)}
            row.update({name: number(greeks.get(name)) for name in ('delta', 'gamma', 'theta', 'vega', 'rho')})
            result['calls' if kind == 'C' else 'puts'].append(row)
        return result
