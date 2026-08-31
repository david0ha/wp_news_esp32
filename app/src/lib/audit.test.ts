import { describe, it, expect } from '@jest/globals'
import { auditEventLine, auditWhen } from './audit'
import type { AuditEntry } from './desk'

function entry(event: string, detail: Record<string, unknown> = {}): AuditEntry {
  return { seq: 1, at: 1_700_000_000, event, detail }
}

const EID = 'a1b2c3d4e5f60718'

describe('auditEventLine', () => {
  it('names a publish and the edition it put up', () => {
    expect(auditEventLine(entry('publish', { edition: EID, reason: 'on wake' }))).toBe(
      'Published a1b2c3d4 — on wake',
    )
  })

  it('says so when the publish was forced from a phone', () => {
    expect(auditEventLine(entry('publish', { edition: EID, forced: true }))).toBe(
      'Published a1b2c3d4 — forced',
    )
  })

  it('reads a commit under either of the two names the wire gives that field', () => {
    // editions.py writes `edition`; scripts/mock-desk.js writes `edition_id`. A timeline that
    // read only one would print a bare "Filed" against half the rows on one of the two.
    expect(auditEventLine(entry('commit', { edition: EID, state: 'staged' }))).toBe(
      'Filed a1b2c3d4 — staged',
    )
    expect(auditEventLine(entry('commit', { edition_id: EID, state: 'unchanged' }))).toBe(
      'Filed a1b2c3d4 — unchanged',
    )
  })

  it('names a stage', () => {
    expect(auditEventLine(entry('stage', { edition: EID, reason: 'quiet window' }))).toBe(
      'Staged a1b2c3d4 — quiet window',
    )
  })

  it('tells a hold from the lifting of one — the same event, opposite facts', () => {
    expect(auditEventLine(entry('hold', { until: 1_700_003_600 }))).toBe('Held until 23:13')
    expect(auditEventLine(entry('hold', { until: null }))).toBe('Hold lifted')
  })

  it('names who wrote the schedule that was saved', () => {
    expect(auditEventLine(entry('schedule', { source: 'file' }))).toBe('Schedule saved — file')
  })

  it('counts the watchlist, singular and plural', () => {
    expect(auditEventLine(entry('watchlist', { items: 5, source: 'vault' }))).toBe(
      'Watchlist updated — 5 companies',
    )
    expect(auditEventLine(entry('watchlist', { items: 1, source: 'vault' }))).toBe(
      'Watchlist updated — 1 company',
    )
  })

  it('prints an event this app has never seen rather than dropping the row', () => {
    expect(auditEventLine(entry('prune', { removed: 3 }))).toBe('prune')
  })

  it('drops a detail it cannot read instead of printing “undefined”', () => {
    expect(auditEventLine(entry('publish', {}))).toBe('Published')
    expect(auditEventLine(entry('schedule', {}))).toBe('Schedule saved')
    expect(auditEventLine(entry('commit', { edition: EID }))).toBe('Filed a1b2c3d4')
  })
})

describe('auditWhen', () => {
  const now = 1_700_000_000

  it('reads as an age and a clock within the day', () => {
    expect(auditWhen(now - 180, now)).toBe('3m ago · 22:10')
  })

  it('swaps the clock for a date once the row is more than a day old', () => {
    // "06:04" against a row from last Tuesday is a clock reading that says nothing.
    expect(auditWhen(now - 86400 * 3, now)).toBe('3d ago · NOV 11')
  })

  it('does not read a desk clock slightly ahead of the row as “never”', () => {
    // formatAge()'s negative case means "no poll has ever succeeded" on the board. An audit row
    // one second in the future is a clock skew, not a row that never happened.
    expect(auditWhen(now + 1, now)).toBe('0s ago · 22:13')
  })

  it('gives the age alone for an instant that is not one', () => {
    expect(auditWhen(0, now)).toBe(`${Math.round(now / 86400)}d ago`)
  })
})
