import json
import unittest
from urllib.error import HTTPError
from unittest.mock import Mock
from claudepost.clock import FixedClock
from claudepost.errors import BadRequest, NotFound, Upstream
from test_http import DeskTestCase


class AlpacaOptionsHTTPTests(DeskTestCase):
    def test_route_is_authenticated_and_returns_normalized_chain(self):
        path = '/api/market/options/alpaca?symbol=AAPL&date=1794528000'
        self.assertEqual(self.call('GET', path, None, None)[0], 401)
        self.desk.alpaca_options = Mock()
        self.desk.alpaca_options.options.return_value = {'source': 'alpaca'}
        status, doc = self.api('GET', path, scope='producer')
        self.assertEqual(status, 200)
        self.assertEqual(doc['result'], {'source': 'alpaca'})
        self.desk.alpaca_options.options.assert_called_once_with('AAPL', 1794528000, fresh=False)

    def test_refresh_flag_reaches_service(self):
        self.desk.alpaca_options = Mock()
        self.desk.alpaca_options.options.return_value = {}
        status, _ = self.api('GET', '/api/market/options/alpaca?symbol=AAPL&fresh=1', scope='producer')
        self.assertEqual(status, 200)
        self.desk.alpaca_options.options.assert_called_once_with('AAPL', None, fresh=True)

    def test_invalid_date_and_missing_credentials(self):
        for query in ('symbol=AAPL&date=soon', 'symbol=AAPL&date=-1', 'symbol=../x', 'symbol=AAPL&fresh=yes', ''):
            status, _ = self.api('GET', '/api/market/options/alpaca?' + query, scope='producer')
            self.assertEqual(status, 400)
        status, doc = self.api('GET', '/api/market/options/alpaca?symbol=AAPL', scope='producer')
        self.assertEqual((status, doc['error']), (404, 'no_options'))


class AlpacaOptionsTests(unittest.TestCase):
    def service(self, responses, metadata=None):
        from claudepost.alpaca_options import OptionService
        self.urls = []
        def fetch(url, headers):
            self.urls.append(url)
            response = (metadata.pop(0) if metadata else {'option_contracts': []}) if '/v2/options/contracts?' in url else responses.pop(0)
            if isinstance(response, Exception):
                raise response
            return json.dumps(response).encode()
        return OptionService(Mock(get=lambda: ('key', 'secret')), fetch=fetch)

    def test_pages_expirations_greeks_and_missing_values(self):
        service = self.service([
            {'snapshots': {'AAPL261113C00200000': {'latestQuote': {'bp': 3, 'ap': 4, 't': 'quote'}, 'greeks': {'delta': .5, 'gamma': .02}}}, 'next_page_token': 'next'},
            {'snapshots': {'AAPL261120P00190000': {}, 'AAPL261113P00190000': {'latestTrade': {'p': 2, 't': 'trade'}}}},
            {'latestTrade': {'p': 201}},
        ])
        result = service.options('AAPL')
        self.assertEqual(len(result['expirationDates']), 2)
        self.assertEqual(result['expiration'], 1794528000)
        self.assertEqual(result['spot'], 201)
        self.assertEqual(result['feed'], 'opra')
        call = result['calls'][0]
        self.assertEqual((call['bid'], call['ask'], call['delta'], call['gamma']), (3, 4, .5, .02))
        self.assertIsNone(call['lastPrice'])
        self.assertIsNone(call['volume'])
        self.assertIsNone(call['multiplier'])
        self.assertTrue(call['inTheMoney'])
        self.assertIn('page_token=next', self.urls[1])

    def test_permission_fallback_and_missing_spot(self):
        service = self.service([HTTPError('url', 403, 'secret', {}, None), {'snapshots': {'AAPL261113C00200000': {}}}, OSError('secret')])
        result = service.options('AAPL')
        self.assertEqual(result['feed'], 'indicative')
        self.assertIsNone(result['spot'])
        self.assertIsNone(result['calls'][0]['inTheMoney'])
        self.assertIn('feed=indicative', self.urls[1])

    def test_errors_are_explicit_and_never_contain_secrets(self):
        for response in (HTTPError('url', 401, 'secret', {}, None), {'snapshots': []}, OSError('secret')):
            with self.assertRaises(Upstream) as caught:
                self.service([response]).options('AAPL')
            self.assertNotIn('secret', str(caught.exception))
        with self.assertRaises(NotFound):
            self.service([{'snapshots': {}}]).options('AAPL')

    def test_repeated_pagination_never_returns_partial_chain(self):
        page = {'snapshots': {}, 'next_page_token': 'repeat'}
        with self.assertRaises(Upstream):
            self.service([page, page]).options('AAPL')

    def test_expiration_switch_reuses_complete_chain(self):
        service = self.service([
            {'snapshots': {'AAPL261113C00200000': {}, 'AAPL261120C00200000': {}}},
            {}, {},
        ])
        first = service.options('AAPL')
        second = service.options('AAPL', first['expirationDates'][1])
        self.assertEqual(second['expiration'], first['expirationDates'][1])
        self.assertEqual(sum('/options/snapshots/' in url for url in self.urls), 1)

    def test_budget_exhaustion_returns_error_instead_of_partial_pages(self):
        from claudepost.alpaca_options import OptionService
        clock = FixedClock(0)
        calls = []
        def fetch(url, headers):
            calls.append(url)
            clock.advance(10)
            return json.dumps({'snapshots': {}, 'next_page_token': str(len(calls))}).encode()
        service = OptionService(Mock(get=lambda: ('key', 'secret')), clock, fetch=fetch)
        with self.assertRaises(Upstream):
            service.options('AAPL')
        self.assertEqual(len(calls), 2)

    def test_adjusted_roots_are_excluded_and_unknown_date_is_explicit(self):
        service = self.service([{'snapshots': {'AAPL1261113C00200000': {}, 'AAPL261113C00200000': {}}}, {}])
        self.assertEqual(len(service.options('AAPL')['calls']), 1)
        with self.assertRaises(NotFound) as caught:
            service.options('AAPL', 1795132800)
        self.assertEqual(caught.exception.code, 'no_expiration')

    def test_explicit_refresh_bypasses_cached_quotes(self):
        service = self.service([
            {'snapshots': {'AAPL261113C00200000': {'latestQuote': {'ap': 4}}}}, {},
            {'snapshots': {'AAPL261113C00200000': {'latestQuote': {'ap': 5}}}}, {},
        ])
        self.assertEqual(service.options('AAPL')['calls'][0]['ask'], 4)
        self.assertEqual(service.options('AAPL', fresh=True)['calls'][0]['ask'], 5)

    def test_contract_metadata_verifies_size_and_matches_identity(self):
        contract = {'symbol': 'AAPL261113C00200000', 'root_symbol': 'AAPL',
                    'underlying_symbol': 'AAPL', 'expiration_date': '2026-11-13',
                    'type': 'call', 'strike_price': '200', 'size': '100'}
        for change, expected in (({}, 100), ({'size': '50'}, 50), ({'size': None}, None),
                                 ({'size': 'nan'}, None), ({'root_symbol': 'AAPL1'}, None),
                                 ({'underlying_symbol': 'MSFT'}, None), ({'type': 'put'}, None),
                                 ({'strike_price': '201'}, None), ({'expiration_date': '2026-11-20'}, None)):
            with self.subTest(change=change):
                service = self.service([{'snapshots': {'AAPL261113C00200000': {'latestQuote': {'ap': 4}}}}, {}],
                                       [{'option_contracts': [{**contract, **change}]}])
                row = service.options('AAPL')['calls'][0]
                self.assertEqual(row['multiplier'], expected)
                self.assertEqual(row['ask'], 4)

    def test_metadata_auth_fallback_pagination_and_cache(self):
        contract = {'symbol': 'AAPL261113C00200000', 'root_symbol': 'AAPL',
                    'underlying_symbol': 'AAPL', 'expiration_date': '2026-11-13',
                    'type': 'call', 'strike_price': '200', 'size': '100'}
        service = self.service([{'snapshots': {contract['symbol']: {}}}, {}, {}], [
            HTTPError('url', 401, 'secret', {}, None),
            {'option_contracts': [], 'next_page_token': 'more'},
            {'option_contracts': [contract]},
        ])
        self.assertEqual(service.options('AAPL')['calls'][0]['multiplier'], 100)
        self.assertEqual(service.options('AAPL')['calls'][0]['multiplier'], 100)
        urls = [url for url in self.urls if '/v2/options/contracts?' in url]
        self.assertEqual(len(urls), 3)
        self.assertTrue(urls[0].startswith('https://paper-api.alpaca.markets/'))
        self.assertTrue(urls[1].startswith('https://api.alpaca.markets/'))
        self.assertIn('page_token=more', urls[2])

    def test_metadata_failure_never_hides_quotes_or_leaks_secrets(self):
        service = self.service([{'snapshots': {'AAPL261113C00200000': {'latestQuote': {'ap': 4}}}}, {}],
                               [OSError('secret')])
        result = service.options('AAPL')
        self.assertIsNone(result['calls'][0]['multiplier'])
        self.assertEqual(result['calls'][0]['ask'], 4)
        self.assertNotIn('secret', json.dumps(result))

    def test_validates_input_before_network(self):
        service = self.service([])
        for symbol, date in (('', None), ('AAPL/..', None), ('AAPL', -1), ('AAPL', True), ('AAPL', 10**30)):
            with self.assertRaises(BadRequest):
                service.options(symbol, date)
        self.assertEqual(self.urls, [])
