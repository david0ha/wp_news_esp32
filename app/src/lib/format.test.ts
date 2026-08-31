import { describe, it, expect } from '@jest/globals'
import {
  PAGE_LABELS,
  changeTone,
  fetchResultLabel,
  fetchResultMessage,
  fetchResultTone,
  formatAge,
  formatCents,
  formatChange,
  formatCount,
  formatDateline,
  formatGeneratedAt,
  formatInterval,
  formatMs,
  formatPrintedDate,
  formatSinceTime,
  pageLabel,
  pollSourceLabel,
  sleepPresetInForce,
  sleepSourceLabel,
} from './format'
import { PAGE_COUNT } from './esp32'

describe('pageLabel', () => {
  it('names the board’s two pages, in its order', () => {
    // Two, not four: 0 is A1, the front page, and 1 is A2, the company's accounts
    // (docs/app-control.md). The four-page notes board this forked from is gone.
    expect([...PAGE_LABELS]).toEqual(['A1 Front', 'A2 Accounts'])
    expect(PAGE_LABELS).toHaveLength(PAGE_COUNT)
    expect(pageLabel(0)).toBe('A1 Front')
    expect(pageLabel(1)).toBe('A2 Accounts')
  })

  it('falls back for an out-of-range page rather than rendering undefined', () => {
    expect(pageLabel(7)).toBe('Page 7')
    expect(pageLabel(-1)).toBe('Page -1')
  })
})

describe('formatCount', () => {
  it('groups thousands', () => {
    expect(formatCount(1428)).toBe('1,428')
    expect(formatCount(0)).toBe('0')
    expect(formatCount(1000000)).toBe('1,000,000')
  })

  it('returns an em dash for a non-finite count', () => {
    expect(formatCount(NaN)).toBe('—')
    expect(formatCount(Infinity)).toBe('—')
  })
})

describe('formatCents', () => {
  it('renders money to two places with grouped thousands', () => {
    // The wire carries integers only — `lastCents` is cents (docs/app-control.md). The decimal
    // point is the app's to place, and this is the only place it places it.
    expect(formatCents(163147)).toBe('1,631.47')
    expect(formatCents(24160)).toBe('241.60')
    expect(formatCents(5)).toBe('0.05')
    expect(formatCents(0)).toBe('0.00')
  })

  it('carries a negative through rather than dropping the sign', () => {
    expect(formatCents(-2550)).toBe('-25.50')
  })

  it('names NO currency', () => {
    // Nothing on the wire says which one. An edition about a Korean listing would get a dollar
    // sign invented for it here, which is worse than a bare number.
    expect(formatCents(163147)).not.toMatch(/[$£€₩]/)
  })

  it('returns an em dash for a non-finite figure', () => {
    expect(formatCents(NaN)).toBe('—')
  })
})

describe('formatChange and changeTone', () => {
  it('turns basis points into a signed percentage', () => {
    // bp = pct × 100, so 62 is +0.62% and -240 is -2.40%.
    expect(formatChange(62)).toBe('+0.62%')
    expect(formatChange(-240)).toBe('-2.40%')
    expect(formatChange(421)).toBe('+4.21%')
  })

  it('shows an unchanged price as unchanged, with no sign', () => {
    expect(formatChange(0)).toBe('0.00%')
  })

  it('gives zero no colour at all', () => {
    // Green and red mean direction on this project's paper AND in this app. A flat price has no
    // direction, and colouring it green would be the app asserting one.
    expect(changeTone(0)).toBe('neutral')
    expect(changeTone(1)).toBe('up')
    expect(changeTone(-1)).toBe('down')
  })

  it('returns an em dash for a non-finite change', () => {
    expect(formatChange(NaN)).toBe('—')
    expect(changeTone(NaN)).toBe('neutral')
  })
})

describe('formatAge', () => {
  it('never reports a board that has never synced as fresh', () => {
    // The firmware sends -1 for "no poll has ever succeeded". Rendering that as "0s ago" is the
    // one mistake here that actively misinforms.
    expect(formatAge(-1)).toBe('never')
    expect(formatAge(NaN)).toBe('never')
  })

  it('scales the unit with the age', () => {
    expect(formatAge(0)).toBe('0s ago')
    expect(formatAge(42)).toBe('42s ago')
    expect(formatAge(180)).toBe('3m ago')
    expect(formatAge(7200)).toBe('2h ago')
    expect(formatAge(172800)).toBe('2d ago')
  })
})

describe('formatInterval', () => {
  it('renders the poll interval', () => {
    expect(formatInterval(300)).toBe('every 5m')
    expect(formatInterval(45)).toBe('every 45s')
    expect(formatInterval(90)).toBe('every 1.5m')
  })

  it('reads an interval of hours in hours', () => {
    // The sleep interval goes up to a day, and "every 1440m" is a number nobody can picture.
    expect(formatInterval(3600)).toBe('every 1h')
    expect(formatInterval(21600)).toBe('every 6h')
    expect(formatInterval(86400)).toBe('every 24h')
  })

  it('returns an em dash for a nonsensical interval', () => {
    expect(formatInterval(0)).toBe('—')
    expect(formatInterval(-5)).toBe('—')
  })
})

describe('formatMs', () => {
  it('treats zero as "not measured yet", not as an instant refresh', () => {
    // The firmware reports 0 until a refresh has run once since boot. "0 ms" would read as an
    // impossibly fast e-Paper panel.
    expect(formatMs(0)).toBe('—')
  })

  it('switches to seconds above a second', () => {
    expect(formatMs(780)).toBe('780 ms')
    expect(formatMs(24810)).toBe('24.8 s')
  })
})

describe('fetch result rendering', () => {
  it('labels every documented result', () => {
    expect(fetchResultLabel('ok')).toBe('synced')
    expect(fetchResultLabel('no_url')).toBe('demo')
    expect(fetchResultLabel('transport')).toBe('unreachable')
    expect(fetchResultLabel('http_status')).toBe('server error')
    expect(fetchResultLabel('bad_payload')).toBe('bad payload')
    expect(fetchResultLabel('not_modified')).toBe('up to date')
    expect(fetchResultLabel('unknown')).toBe('unknown')
  })

  it('treats not_modified as the success it is', () => {
    // A 304 is the MOST COMMON outcome on a board polling all day. Colouring it as a failure
    // paints a healthy board red for most of its life.
    expect(fetchResultTone('not_modified')).toBe('up')
    expect(fetchResultMessage('not_modified')).toMatch(/nothing had changed|nothing has changed/i)
  })

  it('gives the three failures three different explanations', () => {
    // They point at three different mistakes, which is the whole reason the firmware keeps them
    // apart; collapsing them here would throw that away at the last step.
    const messages = new Set([
      fetchResultMessage('transport'),
      fetchResultMessage('http_status'),
      fetchResultMessage('bad_payload'),
    ])
    expect(messages.size).toBe(3)
  })

  it('does not colour an unconfigured board as broken', () => {
    // A board with no URL is a complete product showing its demo edition, not a failure.
    expect(fetchResultTone('no_url')).toBe('neutral')
    expect(fetchResultTone('ok')).toBe('up')
    expect(fetchResultTone('transport')).toBe('down')
    expect(fetchResultTone('http_status')).toBe('down')
    expect(fetchResultTone('bad_payload')).toBe('down')
    expect(fetchResultTone('unknown')).toBe('warn')
  })
})

describe('who set the cadence', () => {
  it('says which layer decided the poll interval', () => {
    // An hourly poll the desk asked for ends when its quiet window does; an hourly poll built
    // into the image does not. The label has to carry that difference.
    expect(pollSourceLabel('policy')).not.toBe(pollSourceLabel('config'))
    expect(pollSourceLabel('policy')).toMatch(/desk/i)
  })

  it('says which of the four layers set the sleep interval', () => {
    const labels = [
      sleepSourceLabel('policy'),
      sleepSourceLabel('api'),
      sleepSourceLabel('nvs'),
      sleepSourceLabel('default'),
    ]
    expect(new Set(labels).size).toBe(4)
    expect(sleepSourceLabel('policy')).toMatch(/desk/i)
  })
})

describe('formatGeneratedAt', () => {
  it('reads the producer’s timestamp without moving it into the phone’s timezone', () => {
    // The reader is comparing this with the dateline PRINTED ON THE SHEET, which is the one the
    // desk chose. Converting to local time would silently disagree with the paper in the reader's
    // hands — so this slices the ISO string rather than going through Date, which also keeps the
    // test the same answer on every machine that runs it.
    expect(formatGeneratedAt('2026-08-14T05:12:00Z')).toBe('14 Aug 2026, 05:12 UTC')
    expect(formatGeneratedAt('2026-01-02T23:59:59Z')).toBe('2 Jan 2026, 23:59 UTC')
  })

  it('drops the UTC marker for a timestamp that did not claim one', () => {
    expect(formatGeneratedAt('2026-08-14T05:12:00')).toBe('14 Aug 2026, 05:12')
  })

  it('shows an unrecognised timestamp as it arrived rather than hiding it', () => {
    // A producer sending something else is a producer bug, and the app is where it gets noticed.
    expect(formatGeneratedAt('this morning')).toBe('this morning')
    expect(formatGeneratedAt('')).toBe('')
  })
})

describe('sleepPresetInForce', () => {
  it('is the stored number when a phone or the setup form set it', () => {
    expect(sleepPresetInForce('api', 1800)).toBe(1800)
    expect(sleepPresetInForce('nvs', 300)).toBe(300)
  })

  it('is nothing at all while the desk is driving', () => {
    // `sleepSeconds` is then the desk's cadence, not the stored value. Lighting the preset that
    // happens to match it would claim the user chose a figure the desk chose.
    expect(sleepPresetInForce('policy', 3600)).toBeNull()
  })

  it('is the DEFAULT sentinel when the compiled-in interval is in force, whatever its value', () => {
    // The trap: CONFIG_CLAUDEPOST_SLEEP_SECONDS is 900 on this build, which is also exactly the
    // "15m" preset. Answering with the number would light 15m and say the user had picked it —
    // so which LAYER won decides first, and only then the number. "default" is a layer, not a
    // figure, and it is one of the three local ones the desk outranks.
    expect(sleepPresetInForce('default', 900)).toBe(0)
    expect(sleepPresetInForce('default', 1800)).toBe(0)
    expect(sleepPresetInForce('default', 0)).toBe(0)
  })

  it('answers with a number no preset offers rather than pretending one matched', () => {
    // A board carrying 20 minutes from somewhere else lights nothing, which is honest: none of the
    // chips describes it. The caller compares, so this need not know what is on offer.
    expect(sleepPresetInForce('nvs', 1200)).toBe(1200)
  })
})

describe('formatDateline', () => {
  it('abbreviates the wire’s all-caps dateline for the masthead row', () => {
    // The committed fixture's own dateline (components/news_core/test/host/fixtures/news.json).
    expect(formatDateline('FRIDAY, AUGUST 14, 2026')).toBe('FRI, AUG 14')
    expect(formatDateline('SATURDAY, AUGUST 15, 2026')).toBe('SAT, AUG 15')
    expect(formatDateline('SUNDAY, JANUARY 2, 2026')).toBe('SUN, JAN 2')
  })

  it('shows the raw string on anything that does not parse', () => {
    // A producer bug should be visible on screen, not silently blanked — same posture as
    // formatGeneratedAt() above.
    expect(formatDateline('')).toBe('')
    expect(formatDateline('this morning')).toBe('this morning')
    expect(formatDateline('14 August 2026')).toBe('14 August 2026')
  })
})

describe('formatPrintedDate', () => {
  it('renders a wire date as the paper’s own month abbreviation, uppercased', () => {
    expect(formatPrintedDate('2026-08-12')).toBe('AUG 12')
    expect(formatPrintedDate('2026-01-02')).toBe('JAN 2')
    // scripts/mock-desk.js's watchlist fixture computes last_printed with a full ISO timestamp
    // sliced to 10 characters — this still matches on the leading YYYY-MM-DD.
    expect(formatPrintedDate('2026-08-22T00:00:00.000Z')).toBe('AUG 22')
  })

  it('shows the raw string on anything that does not parse — same posture as formatDateline()', () => {
    expect(formatPrintedDate('')).toBe('')
    expect(formatPrintedDate('12 Aug 2026')).toBe('12 Aug 2026')
  })
})

describe('formatSinceTime', () => {
  it('renders an edition’s published_at as a UTC HH:MM clock', () => {
    // UTC, not the phone's local zone — same reasoning as formatGeneratedAt(): deterministic
    // across machines, and it never draws a different hour than the desk's own record.
    expect(formatSinceTime(1786684320)).toBe('05:12') // 2026-08-14T05:12:00Z
    expect(formatSinceTime(1735689599)).toBe('23:59') // 2024-12-31T23:59:59Z, floored
  })

  it('is empty for an unknown or absent instant, so the caller can omit the stamp', () => {
    expect(formatSinceTime(0)).toBe('')
    expect(formatSinceTime(-5)).toBe('')
    expect(formatSinceTime(NaN)).toBe('')
  })
})
