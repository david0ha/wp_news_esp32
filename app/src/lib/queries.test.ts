import { describe, it, expect } from '@jest/globals'
import { partialMatchKey, type QueryKey } from '@tanstack/query-core'
import { deskInvalidates, deskKeys, deviceKeys } from './queries'

// The key factory is the one thing in this file worth a test on its own: two calls that MEAN the
// same query must produce the SAME array (react-query compares keys structurally), and two calls
// that mean different queries must not collide — 'editions' as a bare list vs. one `eid` reusing
// its own list's prefix, say.

describe('deskKeys', () => {
  it('is stable for the same arguments', () => {
    expect(deskKeys.state()).toEqual(deskKeys.state())
    expect(deskKeys.edition('abc')).toEqual(deskKeys.edition('abc'))
    expect(deskKeys.commands('pending')).toEqual(deskKeys.commands('pending'))
    expect(deskKeys.quotes(['SNDK', 'MU'])).toEqual(deskKeys.quotes(['SNDK', 'MU']))
  })

  it('distinguishes different arguments', () => {
    expect(deskKeys.edition('a')).not.toEqual(deskKeys.edition('b'))
    expect(deskKeys.commands('pending')).not.toEqual(deskKeys.commands('done'))
    expect(deskKeys.commands()).not.toEqual(deskKeys.commands('pending'))
    expect(deskKeys.notes('editions', 'x')).not.toEqual(deskKeys.notes('commands', 'x'))
    expect(deskKeys.audit(10)).not.toEqual(deskKeys.audit(50))
  })

  it('nests every key under the same prefix, so a bulk invalidation can target it', () => {
    for (const key of [
      deskKeys.state(),
      deskKeys.news(),
      deskKeys.editions(),
      deskKeys.edition('x'),
      deskKeys.watchlist(),
      deskKeys.commands(),
      deskKeys.directives(),
      deskKeys.schedule(),
      deskKeys.audit(),
    ]) {
      expect(key[0]).toBe('desk')
    }
  })

  it('keeps settings off the "desk" prefix — invalidating it must not touch the client itself', () => {
    expect(deskKeys.settings()[0]).toBe('deskSettings')
  })
})

describe('deviceKeys', () => {
  it('is stable and nests under one prefix', () => {
    expect(deviceKeys.state()).toEqual(deviceKeys.state())
    expect(deviceKeys.screen()).toEqual(deviceKeys.screen())
    expect(deviceKeys.state()[0]).toBe('device')
    expect(deviceKeys.screen()[0]).toBe('device')
  })

  it('does not collide with the desk keys', () => {
    expect(deviceKeys.state()).not.toEqual(deskKeys.state())
  })
})

// ---------------------------------------------------------------------------
// What a write invalidates has to REACH what a screen reads, and the two are written in different
// files — the defect this section exists to catch is silent by construction.
//
// react-query matches an invalidation against a live query by PREFIX over the key array
// (`partialMatchKey`, imported here rather than reimplemented so the test cannot drift from the
// library's own rule). So `['desk','audit',50]` does not reach `['desk','audit',20]`: an
// invalidation carrying a DEFAULTED argument matches only a screen that happened to ask for the
// same default. Nothing throws, nothing logs, and the section simply keeps showing what it had.
//
// The family keys (`auditAll`, `scheduleNextAll`) are the fix, and `deskInvalidates` is what makes
// this testable at all: a mutation's key list is data here rather than a closure inside its hook,
// so the pairing can be asserted without rendering anything.
// ---------------------------------------------------------------------------

/** Every desk query this app actually opens, spelled as the screen that opens it spells it. */
const LIVE = {
  state: deskKeys.state(),
  news: deskKeys.news(),
  editions: deskKeys.editions(),
  commands: deskKeys.commands(),
  directives: deskKeys.directives(),
  schedule: deskKeys.schedule(),
  // Desk's own two, and the reason the family keys had to exist: neither takes the default.
  scheduleNext: deskKeys.scheduleNext(1), // <StateStrip>
  audit: deskKeys.audit(20), // the tab's foot
}

function reaches(invalidations: readonly QueryKey[], live: QueryKey): boolean {
  return invalidations.some((key) => partialMatchKey(live, key))
}

describe('the family keys', () => {
  it('reach an audit query whatever limit it asked for', () => {
    expect(partialMatchKey(deskKeys.audit(20), deskKeys.auditAll())).toBe(true)
    expect(partialMatchKey(deskKeys.audit(50), deskKeys.auditAll())).toBe(true)
    expect(partialMatchKey(deskKeys.audit(), deskKeys.auditAll())).toBe(true)
  })

  it('reach a scheduleNext query whatever count it asked for', () => {
    expect(partialMatchKey(deskKeys.scheduleNext(1), deskKeys.scheduleNextAll())).toBe(true)
    expect(partialMatchKey(deskKeys.scheduleNext(10), deskKeys.scheduleNextAll())).toBe(true)
  })

  it('are what the exact keys are NOT — the defect, stated', () => {
    expect(partialMatchKey(deskKeys.audit(20), deskKeys.audit(50))).toBe(false)
    expect(partialMatchKey(deskKeys.scheduleNext(1), deskKeys.scheduleNext(10))).toBe(false)
  })

  it('stay under the desk prefix, so a pull still catches them', () => {
    expect(partialMatchKey(deskKeys.auditAll(), deskKeys.all)).toBe(true)
    expect(partialMatchKey(deskKeys.scheduleNextAll(), deskKeys.all)).toBe(true)
  })
})

describe('deskInvalidates', () => {
  it('a publish reaches the record, the strip, the history and the edition itself', () => {
    const keys = deskInvalidates.publish()
    // http.py:774 writes an audit row on every forced publish.
    expect(reaches(keys, LIVE.audit)).toBe(true)
    expect(reaches(keys, LIVE.state)).toBe(true)
    expect(reaches(keys, LIVE.editions)).toBe(true)
    // Publishing changes what /news.json serves — a Today screen left open must not keep the old one.
    expect(reaches(keys, LIVE.news)).toBe(true)
  })

  it('a promote reaches the same four', () => {
    const keys = deskInvalidates.promote()
    for (const live of [LIVE.audit, LIVE.state, LIVE.editions, LIVE.news]) {
      expect(reaches(keys, live)).toBe(true)
    }
  })

  it('a hold reaches the record and the strip', () => {
    const keys = deskInvalidates.hold()
    expect(reaches(keys, LIVE.audit)).toBe(true) // http.py:781
    expect(reaches(keys, LIVE.state)).toBe(true)
  })

  it('a schedule save reaches the NEXT row — the one row a schedule edit is for', () => {
    const keys = deskInvalidates.schedule()
    expect(reaches(keys, LIVE.scheduleNext)).toBe(true)
    expect(reaches(keys, LIVE.schedule)).toBe(true)
    expect(reaches(keys, LIVE.state)).toBe(true)
    expect(reaches(keys, LIVE.audit)).toBe(true) // http.py:717
  })

  it('a command reaches the queue, and deliberately not the record', () => {
    const keys = deskInvalidates.command()
    expect(reaches(keys, LIVE.commands)).toBe(true)
    expect(reaches(keys, LIVE.state)).toBe(true)
    // `h_cancel` and `h_post_command` write no audit row; invalidating it would spend a request to
    // fetch back what it already had.
    expect(reaches(keys, LIVE.audit)).toBe(false)
  })

  it('a directive reaches the directives and nothing else — the desk does not audit them', () => {
    const keys = deskInvalidates.directive()
    expect(reaches(keys, LIVE.directives)).toBe(true)
    expect(reaches(keys, LIVE.audit)).toBe(false)
    expect(reaches(keys, LIVE.state)).toBe(false)
  })
})
