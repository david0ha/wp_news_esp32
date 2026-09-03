// The edition a phone shows when it has no URL — the same payload `news_mock.c` prints on an
// unconfigured board, so "what the app shows with nothing set up" and "what the board shows with
// nothing set up" are one edition rather than two impressions of one.
//
// `demo.test.ts` holds `demo.json` byte-identical to
// `components/news_core/test/host/fixtures/news.json`, the way `test_news_mock` holds the
// firmware to it. To change the demo: change the fixture, run
// `python3 tools/mock_news_server.py --write-fixture`, then copy it here.
//
// Its photo tiles live in `sim/tiles/`, not in the app, and are not served from anywhere the
// phone can reach — so the demo's photo tiles show their captions on a plain ground. That is
// the honest result and not a bug to fix: a demo that shipped two hundred kilobytes of
// base64 to look complete would be paying for a picture nobody asked for.

import raw from './demo.json'
import { parseEdition } from './parse'
import { type Edition } from './types'

let cached: Edition | null = null

/** The bundled demo, parsed once. The result is shared, so treat it as read-only. */
export function demoEdition(): Edition {
  if (cached === null) cached = parseEdition(raw)
  return cached
}
