import { describe, it, expect } from '@jest/globals'
import {
  MIN_GAP_MINUTES_MAX,
  POLL_SECONDS_MAX,
  POLL_SECONDS_MIN,
  QUIET_WINDOWS_MAX,
  WAKE_TIMES_MAX,
  parseBoundedInt,
  parseQuietText,
  parseWakeText,
  quietToText,
  transitionClock,
  wakeToText,
} from './scheduleform'

describe('quiet windows, text and back', () => {
  it('writes one window per line', () => {
    expect(
      quietToText([
        { from: '00:30', to: '06:00' },
        { from: '13:00', to: '14:00' },
      ]),
    ).toBe('00:30-06:00\n13:00-14:00')
  })

  it('round-trips what the desk sent', () => {
    const doc = [{ from: '00:30', to: '06:00' }]
    expect(parseQuietText(quietToText(doc))).toEqual(doc)
  })

  it('reads an empty field as no quiet window at all', () => {
    expect(parseQuietText('')).toEqual([])
    expect(parseQuietText('  \n \n')).toEqual([])
  })

  it('forgives the spaces a person types around the dash', () => {
    expect(parseQuietText('  00:30 - 06:00  ')).toEqual([{ from: '00:30', to: '06:00' }])
  })

  it('refuses a line that is not two 24-hour clock times', () => {
    // schedule.py's _HHMM_RE, mirrored: refusing here is the difference between a sentence under
    // the field and a 400 the desk answers with after the round trip.
    expect(parseQuietText('00:30')).toBeNull()
    expect(parseQuietText('24:00-06:00')).toBeNull()
    expect(parseQuietText('0:30-06:00')).toBeNull()
    expect(parseQuietText('00:60-06:00')).toBeNull()
    expect(parseQuietText('00:30-06:00-07:00')).toBeNull()
    expect(parseQuietText('breakfast')).toBeNull()
  })

  it('refuses more windows than the desk keeps', () => {
    const lines = Array.from({ length: QUIET_WINDOWS_MAX + 1 }, (_, i) => `0${i}:00-0${i}:30`)
    expect(parseQuietText(lines.join('\n'))).toBeNull()
    expect(QUIET_WINDOWS_MAX).toBe(4)
  })
})

describe('wake times, text and back', () => {
  it('writes a bare clock time for a wake on all seven days', () => {
    expect(wakeToText([{ at: '06:00', days: '' }])).toBe('06:00')
  })

  it('writes the day list after the time when there is one', () => {
    expect(
      wakeToText([
        { at: '06:00', days: '' },
        { at: '12:40', days: 'sat,sun' },
      ]),
    ).toBe('06:00\n12:40 sat,sun')
  })

  it('round-trips both forms', () => {
    const doc = [
      { at: '06:00', days: '' },
      { at: '12:40', days: 'sat,sun' },
      { at: '22:00', days: '' },
    ]
    expect(parseWakeText(wakeToText(doc))).toEqual(doc)
  })

  it('lower-cases and tightens a day list a person typed by hand', () => {
    expect(parseWakeText('12:40 SAT, Sun')).toEqual([{ at: '12:40', days: 'sat,sun' }])
  })

  it('reads an empty field as no wake at all', () => {
    expect(parseWakeText('')).toEqual([])
  })

  it('drops a repeated day, because the desk’s own _days() builds a set', () => {
    // Otherwise the editor sends 'sat,sat', the next GET answers 'sat', and a document that was
    // supposed to round-trip comes back spelled differently from the way it went out.
    expect(parseWakeText('12:40 sat,sat,sun')).toEqual([{ at: '12:40', days: 'sat,sun' }])
  })

  it('refuses a day name the desk does not know', () => {
    // schedule.py's DAY_NAMES: mon..sun, three letters. "monday" is not one of them.
    expect(parseWakeText('06:00 monday')).toBeNull()
    expect(parseWakeText('06:00 xyz')).toBeNull()
  })

  it('refuses a clock time that is not HH:MM', () => {
    expect(parseWakeText('6:00')).toBeNull()
    expect(parseWakeText('25:00')).toBeNull()
  })

  it('refuses more wakes than the desk keeps', () => {
    const lines = Array.from({ length: WAKE_TIMES_MAX + 1 }, (_, i) => `0${i % 10}:0${i % 6}`)
    expect(parseWakeText(lines.join('\n'))).toBeNull()
    expect(WAKE_TIMES_MAX).toBe(12)
  })
})

describe('parseBoundedInt', () => {
  it('takes an integer inside the bounds', () => {
    expect(parseBoundedInt('900', POLL_SECONDS_MIN, POLL_SECONDS_MAX)).toBe(900)
    expect(parseBoundedInt('  60  ', 0, MIN_GAP_MINUTES_MAX)).toBe(60)
    expect(parseBoundedInt('0', 0, MIN_GAP_MINUTES_MAX)).toBe(0)
  })

  it('refuses what the desk’s _int() refuses', () => {
    expect(parseBoundedInt('', POLL_SECONDS_MIN, POLL_SECONDS_MAX)).toBeNull()
    expect(parseBoundedInt('29', POLL_SECONDS_MIN, POLL_SECONDS_MAX)).toBeNull()
    expect(parseBoundedInt('86401', POLL_SECONDS_MIN, POLL_SECONDS_MAX)).toBeNull()
    expect(parseBoundedInt('90.5', POLL_SECONDS_MIN, POLL_SECONDS_MAX)).toBeNull()
    expect(parseBoundedInt('9e2', POLL_SECONDS_MIN, POLL_SECONDS_MAX)).toBeNull()
    expect(parseBoundedInt('-30', POLL_SECONDS_MIN, POLL_SECONDS_MAX)).toBeNull()
    expect(parseBoundedInt('nine hundred', POLL_SECONDS_MIN, POLL_SECONDS_MAX)).toBeNull()
  })

  it('carries the desk’s own bounds so the two cannot drift', () => {
    expect([POLL_SECONDS_MIN, POLL_SECONDS_MAX, MIN_GAP_MINUTES_MAX]).toEqual([30, 86400, 1440])
  })
})

describe('transitionClock', () => {
  // schedule.py writes `local` as "%Y-%m-%d %H:%M %Z"; the zone abbreviation the desk appends is
  // "KST" while scripts/mock-desk.js appends the full "Asia/Seoul". The date and the clock are the
  // half both spell identically, and the half that fits a row.
  it('takes the date and the clock off the desk’s own spelling', () => {
    expect(transitionClock('2026-08-31 22:00 KST')).toBe('2026-08-31 22:00')
  })

  it('takes them off the mock’s spelling too', () => {
    expect(transitionClock('2026-08-31 22:00 Asia/Seoul')).toBe('2026-08-31 22:00')
  })

  it('shows a string it cannot read exactly as it arrived', () => {
    // formatDateline()'s posture: a desk sending something else is a desk bug, and this is where
    // it would be seen rather than hidden behind a fallback that looks plausible.
    expect(transitionClock('sometime tomorrow')).toBe('sometime tomorrow')
    expect(transitionClock('')).toBe('')
  })
})
