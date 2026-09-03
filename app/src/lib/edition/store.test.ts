import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals'
import AsyncStorage from '@react-native-async-storage/async-storage'
import {
  __resetEditionStoreForTests,
  EDITION_CACHE_KEY,
  getCurrentEdition,
  readCachedEdition,
  setCurrentEdition,
  touchCachedEdition,
  writeCachedEdition,
  type CachedEdition,
} from './store'
import { parseEdition } from './parse'
import { demoEdition } from './demo'

beforeEach(async () => {
  await AsyncStorage.clear()
  __resetEditionStoreForTests()
})

afterEach(() => {
  jest.restoreAllMocks()
})

const URL = 'http://desk.local:8123/news.json'
const entry = (over: Partial<CachedEdition> = {}): CachedEdition => ({
  url: URL,
  etag: 'W/"abc"',
  fetchedAt: 1_700_000_000_000,
  edition: demoEdition(),
  ...over,
})

describe('the on-disk edition cache', () => {
  it('uses the one key every shipped install already namespaces', () => {
    // The literal is load-bearing the way store.ts's five are: renaming it is a silent cache
    // wipe on every phone that has one.
    expect(EDITION_CACHE_KEY).toBe('claudepost.edition')
  })

  it('round-trips', async () => {
    await writeCachedEdition(entry())
    __resetEditionStoreForTests()
    const got = await readCachedEdition()
    expect(got?.url).toBe(URL)
    expect(got?.etag).toBe('W/"abc"')
    expect(got?.fetchedAt).toBe(1_700_000_000_000)
    expect(got?.edition.subject.symbol).toBe('SNDK')
    expect(got?.edition.stories).toHaveLength(4)
  })

  it('answers null when nothing is stored', async () => {
    expect(await readCachedEdition()).toBeNull()
  })

  it('re-parses on read, so a shape written by another version degrades instead of crashing', async () => {
    await AsyncStorage.setItem(
      EDITION_CACHE_KEY,
      JSON.stringify({
        url: URL,
        etag: null,
        fetchedAt: 5,
        edition: { subject: { symbol: 'SNDK' }, stories: 'not an array', extra: 'ignored' },
      }),
    )
    const got = await readCachedEdition()
    expect(got?.edition.subject.symbol).toBe('SNDK')
    expect(got?.edition.stories).toEqual([])
    expect(got?.etag).toBeNull()
  })

  it('reads an entry a newer app wrote with fields this one does not know', async () => {
    // Forward compatibility in the direction that actually happens: a build that added a field,
    // then a downgrade or a rollback. `sanitize` rebuilds the entry from the four fields it
    // knows, so an unknown one is dropped rather than carried onto the screen — and, more to the
    // point, its presence does not make the whole entry unreadable and wipe the cache.
    await AsyncStorage.setItem(
      EDITION_CACHE_KEY,
      JSON.stringify({
        ...entry(),
        schema: 2,
        photos: { sndk_fab: 'base64...' },
        fetchedAtIso: '2026-09-03T00:00:00Z',
      }),
    )
    const got = await readCachedEdition()
    expect(got?.url).toBe(URL)
    expect(got?.etag).toBe('W/"abc"')
    expect(got?.fetchedAt).toBe(1_700_000_000_000)
    expect(got?.edition.subject.symbol).toBe('SNDK')
    expect(Object.keys(got ?? {}).sort()).toEqual(['edition', 'etag', 'fetchedAt', 'url'])
  })

  it('reads a corrupt value as nothing cached', async () => {
    for (const junk of ['not json at all', '[]', 'null', '{"url":42}', '{"url":"u"}']) {
      await AsyncStorage.setItem(EDITION_CACHE_KEY, junk)
      __resetEditionStoreForTests()
      expect(await readCachedEdition()).toBeNull()
    }
  })

  it('reads an entry whose edition is empty as nothing cached', async () => {
    // There is nothing to show, so "no cache" is the honest answer — the screen then loads rather
    // than rendering a blank sheet it would have to explain.
    await AsyncStorage.setItem(
      EDITION_CACHE_KEY,
      JSON.stringify({ url: URL, etag: null, fetchedAt: 5, edition: { dateline: 'FRIDAY' } }),
    )
    expect(await readCachedEdition()).toBeNull()
  })

  it('touch moves only fetchedAt, and only in memory', async () => {
    await writeCachedEdition(entry())
    touchCachedEdition(1_700_000_999_000)
    const got = getCurrentEdition()
    expect(got?.fetchedAt).toBe(1_700_000_999_000)
    expect(got?.etag).toBe('W/"abc"')
    expect(got?.url).toBe(URL)
    expect(got?.edition.subject.symbol).toBe('SNDK')
    // The disk still carries the last 200's stamp: a confirmation that changed no content is not
    // worth re-serialising the edition for. The screen reads the reducer's copy, not this one.
    const raw = await AsyncStorage.getItem(EDITION_CACHE_KEY)
    expect(JSON.parse(raw ?? '{}').fetchedAt).toBe(entry().fetchedAt)
  })

  it('the next real write persists what touch left in memory', async () => {
    await writeCachedEdition(entry())
    touchCachedEdition(1_700_000_999_000)
    const held = getCurrentEdition()
    if (held === null) throw new Error('unreachable')
    await writeCachedEdition(held)
    __resetEditionStoreForTests()
    expect((await readCachedEdition())?.fetchedAt).toBe(1_700_000_999_000)
  })

  it('touch on an empty store writes nothing', async () => {
    touchCachedEdition(123)
    expect(getCurrentEdition()).toBeNull()
    expect(await AsyncStorage.getItem(EDITION_CACHE_KEY)).toBeNull()
  })

  it('absorbs a storage failure on the write', async () => {
    // Swapped by hand rather than with jest.spyOn: AsyncStorage's mock is itself made of jest.fn
    // objects with real implementations, and restoreAllMocks() strips the implementation from a
    // spied one — which turns setItem into a silent no-op for every later test in the file.
    const boom = async () => {
      throw new Error('disk is full')
    }
    const setItem = AsyncStorage.setItem
    AsyncStorage.setItem = boom as typeof AsyncStorage.setItem
    try {
      await expect(writeCachedEdition(entry())).resolves.toBeUndefined()
    } finally {
      AsyncStorage.setItem = setItem
    }
  })

  it('absorbs a storage failure on read', async () => {
    const getItem = AsyncStorage.getItem
    AsyncStorage.getItem = (async () => {
      throw new Error('unreadable')
    }) as typeof AsyncStorage.getItem
    try {
      expect(await readCachedEdition()).toBeNull()
    } finally {
      AsyncStorage.getItem = getItem
    }
  })
})

describe('the in-memory current edition', () => {
  it('starts empty, holds what it is given, and clears', () => {
    expect(getCurrentEdition()).toBeNull()
    const e = entry()
    setCurrentEdition(e)
    expect(getCurrentEdition()).toBe(e)
    setCurrentEdition(null)
    expect(getCurrentEdition()).toBeNull()
  })

  it('is filled by a write, so the detail route can read it without touching disk', async () => {
    await writeCachedEdition(entry())
    expect(getCurrentEdition()?.url).toBe(URL)
  })

  it('is filled by a read', async () => {
    await writeCachedEdition(entry())
    __resetEditionStoreForTests()
    expect(getCurrentEdition()).toBeNull()
    await readCachedEdition()
    expect(getCurrentEdition()?.edition.subject.symbol).toBe('SNDK')
  })

  it('holds an edition parsed anywhere, not only one off disk', () => {
    setCurrentEdition({
      url: '',
      etag: null,
      fetchedAt: 0,
      edition: parseEdition({ subject: { symbol: 'X' } }),
    })
    expect(getCurrentEdition()?.edition.subject.symbol).toBe('X')
  })
})
