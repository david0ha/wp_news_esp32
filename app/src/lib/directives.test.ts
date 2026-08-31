import { describe, it, expect } from '@jest/globals'
import { canRestoreDirective } from './directives'
import type { Directive } from './desk'

const NOW = 1_700_000_000

function directive(overrides: Partial<Directive>): Directive {
  return {
    id: 'd1',
    rule: 'Never lead with a story about executive compensation.',
    scope: 'always',
    expires_at: null,
    source: 'operator',
    created_at: NOW - 7000,
    ...overrides,
  }
}

describe('canRestoreDirective', () => {
  it('restores a standing rule', () => {
    expect(canRestoreDirective(directive({ scope: 'always' }), NOW)).toBe(true)
  })

  it('restores an expiring rule that has not expired', () => {
    expect(
      canRestoreDirective(directive({ scope: 'until', expires_at: NOW + 60 }), NOW),
    ).toBe(true)
  })

  it('refuses one whose expiry has already passed', () => {
    // `store.py`'s `list_directives` selects `expires_at IS NULL OR expires_at > now`, and
    // `add_directive` validates the SHAPE of `expires_at` without ever checking that the instant is
    // in the future. So re-adding this rule is a 200 that writes a row the list will never return:
    // an undo that appears to work and changes nothing on screen.
    expect(
      canRestoreDirective(directive({ scope: 'until', expires_at: NOW - 1 }), NOW),
    ).toBe(false)
  })

  it('refuses one expiring at this very second, matching the desk’s own strict comparison', () => {
    expect(canRestoreDirective(directive({ scope: 'until', expires_at: NOW }), NOW)).toBe(false)
  })

  it('refuses an “until” rule carrying no expiry at all', () => {
    // `add_directive` refuses `until` without one, so restoring it would be a 400 — and restoring
    // it AS `always` would quietly change a rule that was meant to end into one that never does.
    // Neither is an undo, so none is offered.
    expect(canRestoreDirective(directive({ scope: 'until', expires_at: null }), NOW)).toBe(false)
  })

  it('does not offer an undo before the desk’s clock is known', () => {
    // `useDeskNow()` answers 0 until `/api/state` lands. Comparing an expiry against the epoch
    // would call every past rule restorable — the exact case this guard exists for.
    expect(canRestoreDirective(directive({ scope: 'until', expires_at: NOW + 60 }), 0)).toBe(false)
  })
})
