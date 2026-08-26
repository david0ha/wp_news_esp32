import { describe, it, expect } from '@jest/globals'
import { deskKeys, deviceKeys } from './queries'

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
