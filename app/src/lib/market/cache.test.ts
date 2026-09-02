import { describe, it, expect } from '@jest/globals'
import { createTtlCache } from './cache'

// Controllable clock: tests move time by hand, nothing waits on real timers.
function fakeClock(start = 0) {
  let t = start
  return { now: () => t, advance: (ms: number) => (t += ms) }
}

// A hand-resolved promise so in-flight windows are held open exactly as long as a test needs.
function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('createTtlCache — fresh hit', () => {
  it('serves a cached value inside the TTL without calling fn', async () => {
    const clock = fakeClock()
    const cache = createTtlCache(clock.now)
    let calls = 0
    const fn = async () => {
      calls++
      return calls
    }
    expect(await cache.through('k', 1000, fn)).toBe(1)
    clock.advance(999)
    expect(await cache.through('k', 1000, fn)).toBe(1)
    expect(calls).toBe(1)
  })

  it('keys are independent', async () => {
    const clock = fakeClock()
    const cache = createTtlCache(clock.now)
    expect(await cache.through('a', 1000, async () => 'A')).toBe('A')
    expect(await cache.through('b', 1000, async () => 'B')).toBe('B')
  })
})

describe('createTtlCache — TTL expiry', () => {
  it('refetches once the entry is exactly ttlMs old', async () => {
    const clock = fakeClock()
    const cache = createTtlCache(clock.now)
    let calls = 0
    const fn = async () => {
      calls++
      return calls
    }
    expect(await cache.through('k', 1000, fn)).toBe(1)
    clock.advance(1000)
    expect(await cache.through('k', 1000, fn)).toBe(2)
    expect(calls).toBe(2)
  })
})

describe('createTtlCache — in-flight dedupe', () => {
  it('two concurrent callers share one fn call', async () => {
    const cache = createTtlCache(fakeClock().now)
    const d = deferred<string>()
    let calls = 0
    const fn = () => {
      calls++
      return d.promise
    }
    const p1 = cache.through('k', 1000, fn)
    const p2 = cache.through('k', 1000, fn)
    d.resolve('value')
    expect(await p1).toBe('value')
    expect(await p2).toBe('value')
    expect(calls).toBe(1)
  })

  it('a settled flight is not reused: the next stale call fetches again', async () => {
    const clock = fakeClock()
    const cache = createTtlCache(clock.now)
    let calls = 0
    const fn = async () => ++calls
    await cache.through('k', 1000, fn)
    clock.advance(2000)
    expect(await cache.through('k', 1000, fn)).toBe(2)
  })
})

describe('createTtlCache — stale-on-error', () => {
  it('returns the stale value when fn rejects and a previous value exists', async () => {
    const clock = fakeClock()
    const cache = createTtlCache(clock.now)
    expect(await cache.through('k', 1000, async () => 'good')).toBe('good')
    clock.advance(5000)
    expect(await cache.through('k', 1000, async () => Promise.reject(new Error('down')))).toBe('good')
  })

  it('rethrows when there is nothing stale to fall back on', async () => {
    const cache = createTtlCache(fakeClock().now)
    await expect(cache.through('k', 1000, async () => Promise.reject(new Error('down')))).rejects.toThrow(
      'down',
    )
  })

  it('the stale entry stays stale — the caller after a stale-on-error still hits the network', async () => {
    const clock = fakeClock()
    const cache = createTtlCache(clock.now)
    let calls = 0
    await cache.through('k', 1000, async () => {
      calls++
      return 'v1'
    })
    clock.advance(5000)
    await cache.through('k', 1000, async () => {
      calls++
      throw new Error('down')
    })
    const v = await cache.through('k', 1000, async () => {
      calls++
      return 'v2'
    })
    expect(v).toBe('v2')
    expect(calls).toBe(3)
  })
})

describe('createTtlCache — bypass', () => {
  it('skips the fresh hit (an explicit refresh actually fetches) and stores the result', async () => {
    const clock = fakeClock()
    const cache = createTtlCache(clock.now)
    let calls = 0
    const fn = async () => ++calls
    expect(await cache.through('k', 1000, fn)).toBe(1)
    expect(await cache.through('k', 1000, fn, { bypass: true })).toBe(2)
    // The bypass result was stored: a plain call inside the TTL serves it.
    expect(await cache.through('k', 1000, fn)).toBe(2)
    expect(calls).toBe(2)
  })

  it('still dedupes in-flight callers', async () => {
    const cache = createTtlCache(fakeClock().now)
    const d = deferred<number>()
    let calls = 0
    const fn = () => {
      calls++
      return d.promise
    }
    const p1 = cache.through('k', 1000, fn, { bypass: true })
    const p2 = cache.through('k', 1000, fn, { bypass: true })
    d.resolve(7)
    expect(await p1).toBe(7)
    expect(await p2).toBe(7)
    expect(calls).toBe(1)
  })

  it('keeps stale-on-error', async () => {
    const cache = createTtlCache(fakeClock().now)
    await cache.through('k', 1000, async () => 'good')
    const v = await cache.through('k', 1000, async () => Promise.reject(new Error('down')), {
      bypass: true,
    })
    expect(v).toBe('good')
  })
})

describe('createTtlCache — clear', () => {
  it('drops every entry', async () => {
    const cache = createTtlCache(fakeClock().now)
    let calls = 0
    const fn = async () => ++calls
    await cache.through('k', 1000, fn)
    cache.clear()
    expect(await cache.through('k', 1000, fn)).toBe(2)
  })
})
