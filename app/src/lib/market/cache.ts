// Tiny TTL cache with in-flight dedupe, stale-on-error and an explicit bypass (spec §4.3).
// Injectable clock so tests never wait on real time.

export function createTtlCache(now: () => number = Date.now): {
  through<T>(key: string, ttlMs: number, fn: () => Promise<T>, opts?: { bypass?: boolean }): Promise<T>
  clear(): void
} {
  const entries = new Map<string, { value: unknown; at: number }>()
  const inflight = new Map<string, Promise<unknown>>()

  function through<T>(
    key: string,
    ttlMs: number,
    fn: () => Promise<T>,
    opts?: { bypass?: boolean },
  ): Promise<T> {
    // Fresh hit → cached value. bypass skips exactly this read (a user's explicit refresh must
    // actually fetch) but keeps everything below: dedupe, store, stale-on-error.
    const hit = entries.get(key)
    if (!opts?.bypass && hit !== undefined && now() - hit.at < ttlMs) {
      return Promise.resolve(hit.value as T)
    }

    // Concurrent same-key callers share one in-flight promise — bypass callers included, so a
    // pull-to-refresh landing during a poll rides the poll instead of doubling it.
    const pending = inflight.get(key)
    if (pending !== undefined) return pending as Promise<T>

    const p = (async () => {
      try {
        const value = await fn()
        entries.set(key, { value, at: now() })
        return value
      } catch (e) {
        // Stale-on-error: yesterday's price beats an error card. The stale entry stays stale, so
        // the next caller tries the network again.
        const stale = entries.get(key)
        if (stale !== undefined) return stale.value as T
        throw e
      } finally {
        inflight.delete(key)
      }
    })()
    inflight.set(key, p)
    return p
  }

  function clear(): void {
    entries.clear()
    inflight.clear()
  }

  return { through, clear }
}

export type TtlCache = ReturnType<typeof createTtlCache>
