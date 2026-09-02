import { describe, it, expect, beforeEach } from '@jest/globals'
import AsyncStorage from '@react-native-async-storage/async-storage'
import {
  __resetWatchlistCacheForTests,
  addToWatchlist,
  getWatchlist,
  isWatched,
  removeFromWatchlist,
  WATCHLIST_KEY,
} from './watchlist'

beforeEach(async () => {
  await AsyncStorage.clear()
  __resetWatchlistCacheForTests()
})

describe('getWatchlist', () => {
  it('returns [] when nothing is stored', async () => {
    expect(await getWatchlist()).toEqual([])
  })

  it('returns [] on corrupt JSON instead of throwing', async () => {
    await AsyncStorage.setItem(WATCHLIST_KEY, 'not json{')
    expect(await getWatchlist()).toEqual([])
  })

  it('returns [] when the stored value is not an array', async () => {
    await AsyncStorage.setItem(WATCHLIST_KEY, JSON.stringify({ symbol: 'AAPL' }))
    expect(await getWatchlist()).toEqual([])
  })

  it('drops corrupt entries without taking the list down', async () => {
    await AsyncStorage.setItem(
      WATCHLIST_KEY,
      JSON.stringify([
        { symbol: 'AAPL', name: 'Apple Inc.' },
        { name: 'no symbol' },
        { symbol: 42, name: 'numeric symbol' },
        null,
        'string entry',
        { symbol: '   ', name: 'blank symbol' },
        { symbol: 'MSFT' }, // missing name → ''
      ]),
    )
    expect(await getWatchlist()).toEqual([
      { symbol: 'AAPL', name: 'Apple Inc.' },
      { symbol: 'MSFT', name: '' },
    ])
  })
})

describe('addToWatchlist', () => {
  it('uppercases and trims the symbol, appends to the end, persists', async () => {
    await addToWatchlist({ symbol: ' aapl ', name: 'Apple Inc.' })
    const list = await addToWatchlist({ symbol: 'msft', name: 'Microsoft' })
    expect(list).toEqual([
      { symbol: 'AAPL', name: 'Apple Inc.' },
      { symbol: 'MSFT', name: 'Microsoft' },
    ])
    // Persisted: a fresh cache read comes off (mocked) disk with the same content.
    __resetWatchlistCacheForTests()
    expect(await getWatchlist()).toEqual(list)
  })

  it('dedupes by symbol — adding an existing one is a no-op', async () => {
    await addToWatchlist({ symbol: 'AAPL', name: 'Apple Inc.' })
    const list = await addToWatchlist({ symbol: 'aapl', name: 'Different Name' })
    expect(list).toEqual([{ symbol: 'AAPL', name: 'Apple Inc.' }])
  })

  it('an empty symbol is a no-op', async () => {
    expect(await addToWatchlist({ symbol: '   ', name: 'nothing' })).toEqual([])
  })
})

describe('removeFromWatchlist', () => {
  it('removes by symbol, case-insensitively, and returns the new list', async () => {
    await addToWatchlist({ symbol: 'AAPL', name: 'Apple Inc.' })
    await addToWatchlist({ symbol: 'MSFT', name: 'Microsoft' })
    const list = await removeFromWatchlist('aapl')
    expect(list).toEqual([{ symbol: 'MSFT', name: 'Microsoft' }])
    __resetWatchlistCacheForTests()
    expect(await getWatchlist()).toEqual(list)
  })

  it('removing an absent symbol leaves the list unchanged', async () => {
    await addToWatchlist({ symbol: 'AAPL', name: 'Apple Inc.' })
    expect(await removeFromWatchlist('TSLA')).toEqual([{ symbol: 'AAPL', name: 'Apple Inc.' }])
  })
})

describe('isWatched', () => {
  it('answers case-insensitively', async () => {
    await addToWatchlist({ symbol: 'AAPL', name: 'Apple Inc.' })
    expect(await isWatched('aapl')).toBe(true)
    expect(await isWatched(' AAPL ')).toBe(true)
    expect(await isWatched('MSFT')).toBe(false)
  })
})

describe('mutation safety', () => {
  it('mutating a returned list does not corrupt the store', async () => {
    await addToWatchlist({ symbol: 'AAPL', name: 'Apple Inc.' })
    const list = await getWatchlist()
    list.push({ symbol: 'HACK', name: '' })
    expect(await getWatchlist()).toEqual([{ symbol: 'AAPL', name: 'Apple Inc.' }])
  })
})
