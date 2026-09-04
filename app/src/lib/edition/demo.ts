// The edition a phone shows when it has no URL — the same payload `news_mock.c` prints on an
// unconfigured board, so "what the app shows with nothing set up" and "what the board shows with
// nothing set up" are one edition rather than two impressions of one.
//
// `demo.test.ts` holds `demo.json` byte-identical to
// `components/news_core/test/host/fixtures/news.json`, the way `test_news_mock` holds the
// firmware to it. To change the demo: change the fixture, run
// `python3 tools/mock_news_server.py --write-fixture`, then copy it here.
//
// THE DEMO CARRIES NO PHOTOGRAPHS. Its pictures live in `sim/tiles/`, not in the app, and a
// photograph is fetched from beside the payload at the news URL — which a phone showing the demo
// does not have. So `editionToTiles(e, { photos: false })` cuts the edition without them, and the
// band and the Photos chip go with them. They used to be drawn anyway, as three empty grey boxes
// with captions under them, which was the first thing a new reader saw.
//
// Bundling them is the obvious alternative and is not free: three pictures at 4 bpp are about
// 550 KB of base64 in the JS bundle for an edition most readers see once. PNGs at a tile's real
// size would be a fraction of that and are a possible follow-up; nobody has measured them yet.

import { parseEdition } from './parse'
import { type Edition } from './types'

let cached: Edition | null = null

/**
 * The bundled demo, loaded and parsed once. The result is shared, so treat it as read-only.
 *
 * The `require` is inside the function on purpose. A phone with a URL set — every phone past
 * setup — never calls this, and a static import would still have Metro evaluate twenty kilobytes
 * of object literal on every launch that reaches the tabs. The parse was already lazy; this makes
 * the load lazy with it, so the demo costs nothing until it is the thing being shown.
 */
export function demoEdition(): Edition {
  if (cached === null) cached = parseEdition(demoWire())
  return cached
}

/**
 * The demo's WIRE JSON — the same bytes a desk would have served, before parsing.
 *
 * The cache stores wire bodies rather than parsed editions (see `store.ts`), so the demo needs to
 * offer one too: `demoCache()` dresses it as a cache entry, and an entry whose `wire` did not
 * re-parse into its `edition` would be a shape the reader has to special-case.
 *
 * Shared and to be treated as read-only, like `demoEdition()`'s result. `require` memoises, so
 * both calls hand back the one object Metro evaluated.
 */
export function demoWire(): unknown {
  return require('./demo.json')
}
