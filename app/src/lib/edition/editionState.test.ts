import { describe, it, expect } from '@jest/globals'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  demoCache,
  isDemo,
  INITIAL_EDITION_MACHINE,
  nextEditionState,
  type EditionEvent,
  type EditionMachine,
} from './editionState'
import { parseEdition } from './parse'
import { type CachedEdition } from './store'
import {
  createEditionClient,
  EditionError,
  humanEditionError,
  type EditionFetch,
} from './client'

const URL = 'http://desk.local:8123/news.json'
const OTHER = 'http://other.desk/news.json'

const wire = (symbol: string) => ({ subject: { symbol }, stories: [{ headline: 'h' }] })
const edition = (symbol: string) => parseEdition(wire(symbol))

const cache = (over: Partial<CachedEdition> = {}): CachedEdition => ({
  url: URL,
  etag: 'W/"one"',
  fetchedAt: 1000,
  wire: wire('SNDK'),
  edition: edition('SNDK'),
  ...over,
})

const ok = (symbol: string, etag: string | null): EditionFetch => ({
  status: 'ok',
  edition: edition(symbol),
  wire: wire(symbol),
  etag,
})

/** Feed a machine a list of events, in order. */
const run = (start: EditionMachine, ...events: EditionEvent[]): EditionMachine =>
  events.reduce(nextEditionState, start)

// The hook that wraps this reducer has no test runner in this app, so the shape of its effects is
// pinned the way `newsurlsync.test.ts` pins the screens: by reading the source. Both facts below
// are structural — a second driver or a late sequence bump has no symptom a unit test could see,
// and both were real defects before this.
describe('useEdition’s effect shape', () => {
  // Comment lines stripped, the same way `newsurlsync.test.ts` reads a screen: the header below
  // NAMES `bootedRef` to say what was removed and why, and a test that could not tell prose from
  // code would be a test against writing the explanation down.
  const source = readFileSync(join(__dirname, 'useEdition.ts'), 'utf8')
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('//') && !l.trimStart().startsWith('*'))
    .join('\n')

  it('has exactly one driver, and it is the focus callback', () => {
    // `useFocusEffect` fires on mount as well as on every return to the tab, so a mount
    // `useEffect` beside it is a second driver for the same event — and serialising the two by
    // hand is what dropped every focus during the first fetch, `bootedRef` and all.
    expect(source.match(/useFocusEffect\(/g)).toHaveLength(1)
    expect(source).not.toMatch(/\buseEffect\(/)
    expect(source).not.toMatch(/bootedRef/)
  })

  it('bumps the sequence at the moment it dispatches a new URL, before any await', () => {
    // An in-flight fetch for the OLD address settles inside `adopt`'s disk read — fifteen seconds
    // is a long window — and until the bump it still passed the guard in `runFetch`.
    expect(source).toMatch(/seqRef\.current\+\+\s*\n\s*dispatch\(\{ type: 'url', url \}\)/)
  })
})

describe('nextEditionState — the starting point', () => {
  it('begins loading, with no URL read yet', () => {
    expect(INITIAL_EDITION_MACHINE).toEqual({ url: null, state: { status: 'loading' } })
  })
})

describe('nextEditionState — the URL', () => {
  it('shows the demo at once for an empty URL, with no network behind it', () => {
    const m = nextEditionState(INITIAL_EDITION_MACHINE, { type: 'url', url: '' })
    expect(m.url).toBe('')
    expect(m.state.status).toBe('ready')
    if (m.state.status !== 'ready') throw new Error('unreachable')
    // The INVARIANT and not a flag: the demo is the entry whose URL is empty, which is also what
    // makes `fetchedAt` 0 and so leaves the freshness line off.
    expect(isDemo(m.state.cached)).toBe(true)
    expect(m.state.cached.url).toBe('')
    expect(m.state.refreshing).toBe(false)
    expect(m.state.error).toBeNull()
    expect(m.state.cached.edition.subject.symbol).toBe('SNDK') // the bundled demo
    expect(m.state.cached.fetchedAt).toBe(0) // no server ever confirmed it: no freshness line
  })

  it('stays loading for a real URL until something arrives', () => {
    const m = nextEditionState(INITIAL_EDITION_MACHINE, { type: 'url', url: URL })
    expect(m).toEqual({ url: URL, state: { status: 'loading' } })
  })

  it('is a no-op when the URL has not actually changed', () => {
    const ready = run(INITIAL_EDITION_MACHINE, { type: 'url', url: URL }, { type: 'cache', cached: cache() })
    expect(nextEditionState(ready, { type: 'url', url: URL })).toBe(ready)
  })

  it('drops everything on screen when the URL changes', () => {
    // The old desk's edition is not "today" for the new one, and showing it while the new one
    // loads would label another desk's paper with this one's name.
    const ready = run(INITIAL_EDITION_MACHINE, { type: 'url', url: URL }, { type: 'cache', cached: cache() })
    expect(nextEditionState(ready, { type: 'url', url: OTHER })).toEqual({
      url: OTHER,
      state: { status: 'loading' },
    })
  })

  it('switches from a real URL to the demo when the URL is cleared', () => {
    const ready = run(INITIAL_EDITION_MACHINE, { type: 'url', url: URL }, { type: 'cache', cached: cache() })
    const m = nextEditionState(ready, { type: 'url', url: '' })
    expect(m.state.status === 'ready' && isDemo(m.state.cached)).toBe(true)
  })
})

describe('nextEditionState — the cache', () => {
  it('shows a matching cache immediately, and says it is refreshing behind it', () => {
    const m = run(INITIAL_EDITION_MACHINE, { type: 'url', url: URL }, { type: 'cache', cached: cache() })
    expect(m.state.status).toBe('ready')
    if (m.state.status !== 'ready') throw new Error('unreachable')
    expect(isDemo(m.state.cached)).toBe(false)
    expect(m.state.refreshing).toBe(true)
    expect(m.state.error).toBeNull()
    expect(m.state.cached.fetchedAt).toBe(1000)
  })

  it('stays loading when there is no cache', () => {
    const m = run(INITIAL_EDITION_MACHINE, { type: 'url', url: URL }, { type: 'cache', cached: null })
    expect(m.state).toEqual({ status: 'loading' })
  })

  it('ignores a cache belonging to another desk', () => {
    const m = run(
      INITIAL_EDITION_MACHINE,
      { type: 'url', url: URL },
      { type: 'cache', cached: cache({ url: OTHER }) },
    )
    expect(m.state).toEqual({ status: 'loading' })
  })

  it('ignores a cache that lands after something is already on screen', () => {
    const ready = run(
      INITIAL_EDITION_MACHINE,
      { type: 'url', url: URL },
      { type: 'fetched', result: ok('SNDK', 'W/"two"'), url: URL, fetchedAt: 2000 },
    )
    expect(nextEditionState(ready, { type: 'cache', cached: cache({ fetchedAt: 1 }) })).toBe(ready)
  })
})

describe('nextEditionState — a fetch that succeeded', () => {
  it('replaces the edition, records the ETag, and stops refreshing', () => {
    const m = run(
      INITIAL_EDITION_MACHINE,
      { type: 'url', url: URL },
      { type: 'cache', cached: cache() },
      { type: 'fetched', result: ok('MU', 'W/"two"'), url: URL, fetchedAt: 5000 },
    )
    if (m.state.status !== 'ready') throw new Error('unreachable')
    expect(m.state.cached).toEqual({
      url: URL,
      etag: 'W/"two"',
      fetchedAt: 5000,
      // The response's own body, carried through untouched so the disk cache can store it — see
      // `store.ts`'s header for why a parsed edition cannot be stored in its place.
      wire: wire('MU'),
      edition: edition('MU'),
    })
    // And the two halves agree: the entry's edition is what its wire parses to, which is the
    // invariant every reader of the cache relies on.
    expect(m.state.cached.edition).toEqual(parseEdition(m.state.cached.wire))
    expect(m.state.refreshing).toBe(false)
    expect(m.state.error).toBeNull()
    expect(isDemo(m.state.cached)).toBe(false)
  })

  it('clears a banner left by an earlier failure', () => {
    const m = run(
      INITIAL_EDITION_MACHINE,
      { type: 'url', url: URL },
      { type: 'cache', cached: cache() },
      { type: 'failed', url: URL, error: 'the network went away' },
      { type: 'refreshing' },
      { type: 'fetched', result: ok('SNDK', null), url: URL, fetchedAt: 6000 },
    )
    expect(m.state.status === 'ready' && m.state.error).toBeNull()
  })

  it('lands a first edition with no cache behind it', () => {
    const m = run(
      INITIAL_EDITION_MACHINE,
      { type: 'url', url: URL },
      { type: 'cache', cached: null },
      { type: 'fetched', result: ok('SNDK', 'W/"one"'), url: URL, fetchedAt: 900 },
    )
    expect(m.state.status).toBe('ready')
  })

  it('leaves the demo behind when a URL is set and the fetch lands', () => {
    const m = run(
      INITIAL_EDITION_MACHINE,
      { type: 'url', url: '' },
      { type: 'url', url: URL },
      { type: 'fetched', result: ok('SNDK', null), url: URL, fetchedAt: 10 },
    )
    expect(m.state.status === 'ready' && isDemo(m.state.cached)).toBe(false)
  })

  it('discards a response for a URL that is no longer the one on screen', () => {
    // A save in Settings while a fetch is in flight. The sequence counter in the hook stops most
    // of these; the reducer refusing them is what makes it impossible rather than unlikely.
    const loading = run(INITIAL_EDITION_MACHINE, { type: 'url', url: URL }, { type: 'url', url: OTHER })
    expect(nextEditionState(loading, {
      type: 'fetched', result: ok('SNDK', null), url: URL, fetchedAt: 1,
    })).toBe(loading)
  })
})

describe('nextEditionState — a 304', () => {
  it('moves only the timestamp', () => {
    const m = run(
      INITIAL_EDITION_MACHINE,
      { type: 'url', url: URL },
      { type: 'cache', cached: cache() },
      { type: 'refreshing' },
      { type: 'fetched', result: { status: 'not_modified' }, url: URL, fetchedAt: 7000 },
    )
    if (m.state.status !== 'ready') throw new Error('unreachable')
    expect(m.state.cached.fetchedAt).toBe(7000)
    expect(m.state.cached.etag).toBe('W/"one"')
    expect(m.state.cached.edition).toEqual(edition('SNDK'))
    expect(m.state.refreshing).toBe(false)
    expect(m.state.error).toBeNull()
  })

  it('does nothing when there is nothing on screen for it to confirm', () => {
    const loading = run(INITIAL_EDITION_MACHINE, { type: 'url', url: URL }, { type: 'cache', cached: null })
    expect(nextEditionState(loading, {
      type: 'fetched', result: { status: 'not_modified' }, url: URL, fetchedAt: 3,
    })).toBe(loading)
  })
})

describe('nextEditionState — a fetch that failed', () => {
  it('drops a failure that names a URL the machine has moved past', () => {
    // The old desk's 15-second timeout landing after Settings changed the address. With no URL
    // guard on this event it flipped the NEW url's `loading` into an error card — and the `cache`
    // event coming along behind it was then a no-op, because the status was no longer `loading`,
    // so the reader sat on an error about a desk they had just stopped using until they tapped
    // Retry. `fetched` has carried its URL from the start; `failed` had not.
    const moved = run(
      INITIAL_EDITION_MACHINE,
      { type: 'url', url: URL },
      { type: 'url', url: OTHER },
    )
    expect(
      nextEditionState(moved, { type: 'failed', url: URL, error: 'the old desk timed out' }),
    ).toBe(moved)

    // And the new desk's own cache still lands on the screen behind it.
    const m = run(
      moved,
      { type: 'failed', url: URL, error: 'the old desk timed out' },
      { type: 'cache', cached: cache({ url: OTHER }) },
    )
    expect(m.state.status).toBe('ready')
  })

  it('keeps the cached edition and raises a banner', () => {
    const m = run(
      INITIAL_EDITION_MACHINE,
      { type: 'url', url: URL },
      { type: 'cache', cached: cache() },
      { type: 'failed', url: URL, error: "Couldn't reach the edition server." },
    )
    if (m.state.status !== 'ready') throw new Error('unreachable')
    expect(m.state.cached.edition).toEqual(edition('SNDK'))
    expect(m.state.error).toBe("Couldn't reach the edition server.")
    expect(m.state.refreshing).toBe(false)
  })

  it('is a whole-screen error only when there is nothing to show', () => {
    const m = run(
      INITIAL_EDITION_MACHINE,
      { type: 'url', url: URL },
      { type: 'cache', cached: null },
      { type: 'failed', url: URL, error: 'nope' },
    )
    expect(m.state).toEqual({ status: 'error', error: 'nope' })
  })

  it('replaces the sentence on a second failure from the error screen', () => {
    const m = run(
      INITIAL_EDITION_MACHINE,
      { type: 'url', url: URL },
      { type: 'failed', url: URL, error: 'first' },
      { type: 'failed', url: URL, error: 'second' },
    )
    expect(m.state).toEqual({ status: 'error', error: 'second' })
  })

  it('recovers from the error screen when a retry lands', () => {
    const m = run(
      INITIAL_EDITION_MACHINE,
      { type: 'url', url: URL },
      { type: 'failed', url: URL, error: 'first' },
      { type: 'fetched', result: ok('SNDK', null), url: URL, fetchedAt: 8000 },
    )
    expect(m.state.status).toBe('ready')
  })
})

describe('nextEditionState — refreshing', () => {
  it('marks a ready screen as refreshing without disturbing anything else', () => {
    const ready = run(INITIAL_EDITION_MACHINE, { type: 'url', url: URL }, { type: 'cache', cached: cache() })
    const spinning = nextEditionState(
      nextEditionState(ready, { type: 'fetched', result: { status: 'not_modified' }, url: URL, fetchedAt: 2 }),
      { type: 'refreshing' },
    )
    if (spinning.state.status !== 'ready') throw new Error('unreachable')
    expect(spinning.state.refreshing).toBe(true)
    expect(spinning.state.cached.edition).toEqual(edition('SNDK'))
  })

  it('leaves a standing banner up while the retry runs', () => {
    // Clearing it here would blink the banner out and back in on a retry that fails again.
    const m = run(
      INITIAL_EDITION_MACHINE,
      { type: 'url', url: URL },
      { type: 'cache', cached: cache() },
      { type: 'failed', url: URL, error: 'gone' },
      { type: 'refreshing' },
    )
    expect(m.state.status === 'ready' && m.state.error).toBe('gone')
  })

  it('does nothing to a loading or an error screen', () => {
    const loading = nextEditionState(INITIAL_EDITION_MACHINE, { type: 'url', url: URL })
    expect(nextEditionState(loading, { type: 'refreshing' })).toBe(loading)
    const failed = nextEditionState(loading, { type: 'failed', url: URL, error: 'x' })
    expect(nextEditionState(failed, { type: 'refreshing' })).toBe(failed)
  })
})

describe('the spec’s error-handling table, the row that crosses two modules', () => {
  it('keeps the cached edition up when the desk serves a payload that parses empty', async () => {
    // "edition parses but is empty -> treated as bad_json -> the previous cache stays up". Every
    // other row of the table is a reducer transition and is asserted above; this one is only true
    // if the CLIENT calls it a failure and the REDUCER calls a failure a banner, so it is worth
    // driving both with the real code and an injected fetch rather than asserting either half.
    const served = JSON.stringify({ dateline: 'FRIDAY, AUGUST 14, 2026', stories: [] })
    const fetchFn = (async () =>
      ({
        ok: true,
        status: 200,
        headers: { get: () => null },
        arrayBuffer: async () => new TextEncoder().encode(served).buffer,
      }) as unknown as Response) as unknown as typeof fetch

    const ready = run(
      INITIAL_EDITION_MACHINE,
      { type: 'url', url: URL },
      { type: 'cache', cached: cache() },
    )

    // Half one: the client refuses it rather than calling it a successful fetch.
    const thrown = await createEditionClient({ fetchFn })
      .fetch(URL, 'W/"one"')
      .then(() => null, (e: unknown) => e)
    expect(thrown).toBeInstanceOf(EditionError)
    expect(thrown).toMatchObject({ code: 'bad_json' })

    // Half two: a failure with content on screen is a banner, not a blank sheet.
    const m = nextEditionState(ready, { type: 'failed', url: URL, error: humanEditionError(thrown) })
    if (m.state.status !== 'ready') throw new Error('the cached edition was taken off screen')
    expect(m.state.cached.edition).toEqual(edition('SNDK'))
    expect(m.state.cached.fetchedAt).toBe(1000) // NOT confirmed: the freshness line keeps ageing
    expect(m.state.error).toBe(
      'The edition didn’t parse. The desk may be mid-publish; pull to refresh in a minute.',
    )
  })
})

describe('demoCache and isDemo', () => {
  it('is the bundled edition, stamped as never confirmed', () => {
    const c = demoCache()
    expect(c.url).toBe('')
    expect(c.etag).toBeNull()
    expect(c.fetchedAt).toBe(0)
    expect(c.edition.stories).toHaveLength(4)
  })

  it('reads the demo off the entry itself, so the two can never disagree', () => {
    expect(isDemo(demoCache())).toBe(true)
    expect(
      isDemo({ url: URL, etag: null, fetchedAt: 1, wire: demoCache().wire, edition: demoCache().edition }),
    ).toBe(false)
  })
})
