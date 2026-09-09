import { describe, it, expect } from '@jest/globals'
import {
  dayLabel,
  directionColour,
  directionLabel,
  eventDirection,
  groupByDay,
  parseCalendarDoc,
  positionLine,
  scheduleView,
  sourceBadge,
  bookFetchDue,
  BOOK_REFRESH_AFTER_MS,
  timeLabel,
  upcomingView,
  type CalendarDoc,
  type CalendarEvent,
  type UpcomingView,
} from './schedule'
import { createDeskClient, DeskError } from './desk'
import { parsePositionsDoc, type PositionsDoc } from './positions'
import { colors } from '../theme'
import { en } from '../i18n/en'
import { ko } from '../i18n/ko'

// ---------------------------------------------------------------------------
// Fixtures. Invented tickers throughout: nothing in this repository says what anybody holds.
// ---------------------------------------------------------------------------

const wireAffect = (over: Record<string, unknown> = {}) => ({
  position_id: 'p_1f05f8',
  direction: 'against',
  reason:
    '금리 기대가 흔들리면 전력기기 설비투자 사이클 기대도 같이 움직여요. 만기가 74일 남은 롱 콜은 델타보다 베가가 큰 구간이라, 지수가 빠지면 방향이 맞아도 프리미엄이 먼저 줄어요.',
  reason_short: '금리 기대가 흔들리면 설비투자 기대도 같이 움직여요',
  ...over,
})

const wireEvent = (over: Record<string, unknown> = {}) => ({
  id: 'e_91c2',
  at: '2026-09-08T12:30:00Z',
  precision: 'exact',
  title: '미국 8월 소비자물가지수',
  kind: 'econ',
  source: 'https://www.example-calendar.test/economic-calendar/',
  symbols: ['AAAA'],
  rank: 1,
  affects: [wireAffect()],
  ...over,
})

const wireDoc = (over: Record<string, unknown> = {}) => ({
  generated_at: '2026-09-08T05:00:00Z',
  lang: 'ko',
  target: 10,
  shortfall: null,
  events: [wireEvent()],
  ...over,
})

/** A parsed event, built from the wire so every test agrees with the parser about the shape. */
const event = (over: Record<string, unknown> = {}): CalendarEvent => {
  const doc = parseCalendarDoc(wireDoc({ events: [wireEvent(over)] }))
  if (doc === null || doc.events.length !== 1) throw new Error('fixture does not parse')
  return doc.events[0]
}

const doc = (over: Record<string, unknown> = {}): CalendarDoc => {
  const parsed = parseCalendarDoc(wireDoc(over))
  if (parsed === null) throw new Error('fixture does not parse')
  return parsed
}

/** An instant given in LOCAL calendar parts, so a test that omits `tz` is still deterministic. */
const local = (y: number, m: number, d: number, h = 12, min = 0) => new Date(y, m - 1, d, h, min)

// ---------------------------------------------------------------------------
// The wire
// ---------------------------------------------------------------------------

describe('parseCalendarDoc', () => {
  it('reads the document the desk serves', () => {
    const parsed = doc()
    expect(parsed.generatedAt).toBe('2026-09-08T05:00:00Z')
    expect(parsed.lang).toBe('ko')
    expect(parsed.target).toBe(10)
    expect(parsed.shortfall).toBeNull()
    expect(parsed.events).toHaveLength(1)
    expect(parsed.events[0]).toMatchObject({
      id: 'e_91c2',
      precision: 'exact',
      session: null,
      kind: 'econ',
      rank: 1,
    })
    expect(parsed.events[0].affects[0].positionId).toBe('p_1f05f8')
    expect(parsed.events[0].affects[0].direction).toBe('against')
  })

  it('is not a document at all when it is not an object', () => {
    expect(parseCalendarDoc(null)).toBeNull()
    expect(parseCalendarDoc('a book')).toBeNull()
    expect(parseCalendarDoc([])).toBeNull()
    // The one required field: a document with no `events` list is not this contract.
    expect(parseCalendarDoc({ generated_at: '', lang: 'ko', target: 10 })).toBeNull()
  })

  it('drops the event it cannot read and keeps the rest', () => {
    // The opposite posture to `parsePositionsDoc`, and deliberately: this book is READ ONLY, so a
    // dropped event costs one row. The positions book is read, edited and PUT back, where a
    // dropped row would be deleted.
    const parsed = parseCalendarDoc(
      wireDoc({
        events: [
          wireEvent({ id: 'e_0001' }),
          wireEvent({ id: 'e_0002', at: 'tomorrow morning' }),
          wireEvent({ id: 'e_0003' }),
        ],
      }),
    )
    expect(parsed?.events.map((e) => e.id)).toEqual(['e_0001', 'e_0003'])
  })

  it('drops an event with no source, because that is the rule the book exists for', () => {
    // The design's §2: a date with neither a computation nor a URL behind it does not go on the
    // wall. A desk enforces it; a phone that drew one anyway would be the one place it leaked.
    expect(parseCalendarDoc(wireDoc({ events: [wireEvent({ source: '' })] }))?.events).toHaveLength(
      0,
    )
  })

  it('drops an event whose reasoning reaches no position', () => {
    // An event with no `affects` is a generic calendar entry, and the phone already has one of
    // those.
    expect(parseCalendarDoc(wireDoc({ events: [wireEvent({ affects: [] })] }))?.events).toEqual([])
    expect(
      parseCalendarDoc(wireDoc({ events: [wireEvent({ affects: [wireAffect({ direction: 'up' })] })] }))
        ?.events,
    ).toEqual([])
  })

  it('carries a session only where the precision says there is one', () => {
    expect(event({ precision: 'session', session: 'amc' }).session).toBe('amc')
    // A session hung on an exact time contradicts the time beside it; the precision wins.
    expect(event({ precision: 'exact', session: 'amc' }).session).toBeNull()
    // …and a session precision with no session cannot be rendered at all.
    expect(parseCalendarDoc(wireDoc({ events: [wireEvent({ precision: 'session' })] }))?.events)
      .toEqual([])
  })

  it('reads a kind this build has no name for as `other`', () => {
    // `parsePositionsDoc`'s argument for `custom`: a desk one release ahead of the phone is not a
    // reason to hide a date the owner can act on.
    expect(event({ kind: 'tender_offer' }).kind).toBe('other')
  })

  it('keeps a shortfall sentence and a push, and defaults both to nothing', () => {
    expect(doc({ shortfall: '오늘은 근거를 갖춘 일정이 여섯 건뿐이에요.' }).shortfall).toBe(
      '오늘은 근거를 갖춘 일정이 여섯 건뿐이에요.',
    )
    expect(doc({ shortfall: 42 }).shortfall).toBeNull()
    expect(event({ push: { title: '오늘 밤 CPI가 나와요', body: '21:30 발표예요.' } }).push)
      .toEqual({ title: '오늘 밤 CPI가 나와요', body: '21:30 발표예요.' })
    expect(event().push).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// The rail, the heading and the grouping
// ---------------------------------------------------------------------------

describe('dayLabel', () => {
  it('labels the day relatively near, absolutely far', () => {
    const now = local(2026, 9, 8)
    expect(dayLabel('2026-09-08', now, ko)).toBe('오늘 · 9월 8일 (화)')
    expect(dayLabel('2026-09-09', now, ko)).toBe('내일 · 9월 9일 (수)')
    // 2026-09-15 is a Tuesday. The brief's own example said (월) and was simply wrong about the
    // calendar; a test that agreed with it would ship a weekday table off by one.
    expect(dayLabel('2026-09-15', now, ko)).toBe('9월 15일 (화)')
  })

  it('says the same three things in English', () => {
    const now = local(2026, 9, 8)
    expect(dayLabel('2026-09-08', now, en)).toBe('Today · Sep 8 (Tue)')
    expect(dayLabel('2026-09-09', now, en)).toBe('Tomorrow · Sep 9 (Wed)')
    expect(dayLabel('2026-09-15', now, en)).toBe('Sep 15 (Tue)')
  })

  it('reads today in the timezone it is given, not in the machine’s', () => {
    // 2026-09-08T23:00Z is already the 9th in Seoul, so "today" there is the 9th.
    const now = new Date('2026-09-08T23:00:00Z')
    expect(dayLabel('2026-09-09', now, ko, 'Asia/Seoul')).toBe('오늘 · 9월 9일 (수)')
    expect(dayLabel('2026-09-09', now, ko, 'America/New_York')).toBe('내일 · 9월 9일 (수)')
  })
})

describe('timeLabel', () => {
  it('renders exactly the precision the event has, in the device timezone', () => {
    // 12:30Z is 08:30 ET — when a US CPI print actually lands — and 21:30 in Seoul. The rail is
    // ALWAYS local time; the wire is always UTC.
    expect(timeLabel({ precision: 'exact', at: '2026-09-08T12:30:00Z' }, ko, 'Asia/Seoul')).toBe(
      '21:30',
    )
    expect(timeLabel({ precision: 'exact', at: '2026-09-08T12:30:00Z' }, ko, 'America/New_York'))
      .toBe('08:30')
    expect(timeLabel({ precision: 'session', session: 'amc' }, ko, 'Asia/Seoul')).toBe('장 마감 후')
    expect(timeLabel({ precision: 'session', session: 'bmo' }, ko, 'Asia/Seoul')).toBe('장 시작 전')
    expect(timeLabel({ precision: 'day' }, ko, 'Asia/Seoul')).toBe('종일')
  })

  it('never invents a time for a day-precision event', () => {
    // The regression this test exists for: a reader who checked the morning and found the thing
    // had happened in the evening.
    expect(timeLabel({ precision: 'day', at: '2026-09-15T00:00:00Z' }, ko)).not.toMatch(/\d\d:\d\d/)
    expect(timeLabel({ precision: 'session', session: 'amc', at: '2026-09-15T20:00:00Z' }, ko))
      .not.toMatch(/\d\d:\d\d/)
  })

  it('uses the device’s own clock when no timezone is given', () => {
    // The production path. `local()` builds the instant from local parts, so this holds whatever
    // zone the machine running it is in.
    expect(timeLabel({ precision: 'exact', at: local(2026, 9, 8, 21, 30).toISOString() }, en)).toBe(
      '21:30',
    )
    expect(timeLabel({ precision: 'exact', at: local(2026, 9, 8, 9, 5).toISOString() }, en)).toBe(
      '09:05',
    )
  })
})

describe('groupByDay', () => {
  const now = new Date('2026-09-08T04:00:00Z') // 13:00 in Seoul, 00:00 in New York

  it('groups by the local day, not the UTC one', () => {
    // The bug this prevents: an event at 23:00Z is tomorrow in Seoul, and filing it under today
    // puts it above a heading that says 오늘.
    const g = groupByDay([event({ at: '2026-09-08T23:00:00Z' })], now, 'Asia/Seoul')
    expect(g).toHaveLength(1)
    expect(g[0].date).toBe('2026-09-09')
    expect(groupByDay([event({ at: '2026-09-08T23:00:00Z' })], now, 'America/New_York')[0].date)
      .toBe('2026-09-08')
  })

  it('orders by time and not by rank, days and events alike', () => {
    const g = groupByDay(
      [
        event({ id: 'e_0003', at: '2026-09-10T09:00:00Z', rank: 1 }),
        event({ id: 'e_0002', at: '2026-09-08T22:00:00Z', rank: 9 }),
        event({ id: 'e_0001', at: '2026-09-08T13:00:00Z', rank: 5 }),
      ],
      now,
      'Asia/Seoul',
    )
    expect(g.map((d) => d.date)).toEqual(['2026-09-08', '2026-09-09', '2026-09-10'])
    expect(g[0].events.map((e) => e.id)).toEqual(['e_0001'])
    expect(g[1].events.map((e) => e.id)).toEqual(['e_0002'])
  })

  it('breaks a tie at the identical instant by rank, so the order is not the array’s', () => {
    const g = groupByDay(
      [
        event({ id: 'e_low', at: '2026-09-10T09:00:00Z', rank: 7 }),
        event({ id: 'e_top', at: '2026-09-10T09:00:00Z', rank: 1 }),
      ],
      now,
      'Asia/Seoul',
    )
    expect(g[0].events.map((e) => e.id)).toEqual(['e_top', 'e_low'])
  })

  it('drops a day that is already behind the reader, and keeps today’s earlier hours', () => {
    // The desk keeps a week of past events so the book is not rewritten the instant a print
    // lands — but a schedule that opens on last week is a schedule nobody refreshed. Today's own
    // morning stays: it is still what happened today.
    const g = groupByDay(
      [
        event({ id: 'e_last', at: '2026-09-02T12:30:00Z' }),
        event({ id: 'e_dawn', at: '2026-09-07T22:00:00Z' }), // 07:00 on the 8th in Seoul
        event({ id: 'e_soon', at: '2026-09-09T12:30:00Z' }),
      ],
      now,
      'Asia/Seoul',
    )
    expect(g.map((d) => d.date)).toEqual(['2026-09-08', '2026-09-09'])
    expect(g[0].events.map((e) => e.id)).toEqual(['e_dawn'])
  })

  it('files a day-precision event on the date the wire names, west of UTC', () => {
    // THE SEVERE ONE. `CALENDAR.md` pins a day event's `at` to exactly 00:00:00Z, so the wire is
    // encoding a DATE. Read as an instant in New York it is 19:00 the evening before, so an expiry
    // on 21 Nov drew under "Today" on the 20th and then vanished on the 21st — the day it actually
    // expires — because `key < today` dropped it. The desk's alert still fired.
    const expiry = event({
      id: 'e_expiry',
      at: '2026-11-21T00:00:00Z',
      precision: 'day',
      title: 'AAAA 420 콜 만기',
    })
    const ny = 'America/New_York'
    // The evening before, New York time: filed on the 21st, not under "today".
    expect(groupByDay([expiry], new Date('2026-11-20T22:00:00Z'), ny).map((g) => g.date)).toEqual([
      '2026-11-21',
    ])
    // The day itself, mid-afternoon in New York: still there, still the 21st.
    expect(groupByDay([expiry], new Date('2026-11-21T19:00:00Z'), ny).map((g) => g.date)).toEqual([
      '2026-11-21',
    ])
    // And only the day after is it behind the reader.
    expect(groupByDay([expiry], new Date('2026-11-22T19:00:00Z'), ny)).toEqual([])
  })

  it('files a session event on the market’s trading day, not the reader’s', () => {
    // A US after-close print at 20:30Z is 05:30 the next morning in Seoul. Grouped locally it
    // filed under the 10th, labelled 장 마감 후 — telling a Seoul reader "after the close on the
    // 10th" about something that happened after the close on the 9th, the two halves of one row
    // disagreeing. The spec's §8 mockup files it under the US date.
    const amc = event({
      id: 'e_amc',
      at: '2026-09-09T20:30:00Z',
      precision: 'session',
      session: 'amc',
    })
    expect(
      groupByDay([amc], new Date('2026-09-08T04:00:00Z'), 'Asia/Seoul').map((g) => g.date),
    ).toEqual(['2026-09-09'])
    expect(timeLabel(amc, ko, 'Asia/Seoul')).toBe('장 마감 후')
    // And in New York, where the reader's day and the market's already agree.
    expect(
      groupByDay([amc], new Date('2026-09-08T12:00:00Z'), 'America/New_York').map((g) => g.date),
    ).toEqual(['2026-09-09'])
  })

  it('still reads an exact event in the reader’s own zone', () => {
    // Per-precision, not a blanket "stop converting": an event that renders a clock is grouped by
    // the day that clock belongs to, or the heading and the rail disagree the other way.
    const cpi = event({ id: 'e_cpi', at: '2026-09-08T23:00:00Z', precision: 'exact' })
    expect(
      groupByDay([cpi], new Date('2026-09-08T04:00:00Z'), 'Asia/Seoul').map((g) => g.date),
    ).toEqual(['2026-09-09'])
    expect(
      groupByDay([cpi], new Date('2026-09-08T04:00:00Z'), 'America/New_York').map((g) => g.date),
    ).toEqual(['2026-09-08'])
  })
})

// ---------------------------------------------------------------------------
// The row's own decisions
// ---------------------------------------------------------------------------

describe('sourceBadge', () => {
  it('draws a badge for a researched event and none for a computed one', () => {
    // §2 made visible: a reader can always see which kind of date they are looking at. A computed
    // date is not in question, so it carries nothing.
    expect(sourceBadge(event({ source: 'computed' }))).toBeNull()
    expect(sourceBadge(event({ source: 'https://www.example-investor.test/events/q3' }))).toEqual({
      host: 'example-investor.test',
      url: 'https://www.example-investor.test/events/q3',
    })
  })

  it('keeps a subdomain that is not `www`, because it is part of the name a reader checks', () => {
    expect(sourceBadge(event({ source: 'https://investor.example-co.test/' }))?.host).toBe(
      'investor.example-co.test',
    )
  })

  it('carries no url for a source this app would not open, but still badges it', () => {
    // The guard moved from WHETHER there is a badge to WHAT the badge links to, and that is the
    // point rather than a relaxation: a badge that opened `javascript:` would be the phone acting
    // on a string the desk merely stored, but no badge at all would render a date a human read
    // for as one a machine computed — the one thing §8 says the row may never do. So: badged, and
    // inert. The desk files only `computed` or an `https://` URL, so each of these is a researched
    // date that reached the phone malformed.
    for (const source of ['javascript:alert(1)', 'investor.example-co.test', 'http://plain.test/']) {
      expect(sourceBadge(event({ source }))).toEqual({ host: '', url: '' })
    }
  })

  it('badges a host it cannot read, rather than letting it pass for a computed date', () => {
    // An IDN is entirely plausible in a Korean book, and under the old ASCII-only class it matched
    // nothing and silently lost its badge. Credentials still buy no domain — `evil.test` must not
    // be printed as the authority of `https://user:pass@evil.test/` — but the row still says a
    // human read for this date.
    expect(sourceBadge(event({ source: 'https://한국거래소.kr/notice/1' }))).toEqual({
      host: '한국거래소.kr',
      url: 'https://한국거래소.kr/notice/1',
    })
    expect(sourceBadge(event({ source: 'https://ir.example_co.test/q3' }))?.host).toBe(
      'ir.example_co.test',
    )
    expect(sourceBadge(event({ source: 'https://user:pass@evil.test/' }))).toEqual({
      host: '',
      url: 'https://user:pass@evil.test/',
    })
  })
})

describe('eventDirection', () => {
  it('is the direction of the one position it reaches', () => {
    expect(eventDirection(event())).toBe('against')
    expect(eventDirection(event({ affects: [wireAffect({ direction: 'for' })] }))).toBe('for')
  })

  it('is both ways when the positions it reaches disagree', () => {
    // Not the first one's. An event that helps one holding and hurts another is exactly what
    // 양방향 means, and picking either would be a sentence about half the book.
    const mixed = event({
      affects: [
        wireAffect({ position_id: 'p_1f05f8', direction: 'for' }),
        wireAffect({ position_id: 'p_aa11bb', direction: 'against' }),
      ],
    })
    expect(eventDirection(mixed)).toBe('both')
  })
})

describe('directionLabel and directionColour', () => {
  it('says what it means to this owner, in both languages', () => {
    expect(directionLabel('for', ko)).toBe('↑ 유리')
    expect(directionLabel('against', ko)).toBe('↓ 불리')
    expect(directionLabel('both', ko)).toBe('양방향')
    expect(directionLabel('for', en)).toBe('↑ Helps')
  })

  it('takes the up/down pair from the theme, green up, and never a literal', () => {
    // The owner chose green=up over the Korean red=up convention: a phone that disagreed with the
    // paper about the same company would be worse than one that disagrees with the country.
    expect(directionColour('for')).toBe(colors.up)
    expect(directionColour('against')).toBe(colors.down)
    expect(directionColour('both')).toBe(colors.textDim)
    expect(colors.up).not.toBe(colors.down)
  })
})

describe('positionLine', () => {
  const optionOn = (expiries: string[]) => ({
    id: `p_${expiries.length}f05f8`,
    symbol: 'AAAA',
    kind: 'option',
    opened_at: '2026-08-19',
    note: '',
    strategy: expiries.length > 1 ? 'calendar' : 'long_call',
    legs: expiries.map((expiry) => ({
      right: 'call',
      side: 'long',
      strike_cents: 42000,
      expiry,
      contracts: 2,
      entry_price_cents: 1180,
    })),
  })

  const bookOf = (...positions: unknown[]) =>
    parsePositionsDoc({ updated_at: '2026-09-08T05:00:00Z', positions }) as PositionsDoc

  const stock = {
    id: 'p_aa11bb',
    symbol: 'BBBB',
    kind: 'stock',
    opened_at: null,
    note: '',
    quantity: 300,
    entry_price_cents: 5400,
  }

  const book = bookOf(optionOn(['2026-11-21']), stock)
  // Built from LOCAL parts, so "the reader's own day" is 2026-09-08 whatever zone this runs in.
  const now = local(2026, 9, 8)

  it('names the company, the shape and how long the option has left', () => {
    // The countdown is the point of the line: an earnings print eight days before expiry is a
    // different event from the same print with eight months left.
    expect(positionLine(book, 'p_1f05f8', ko, now)).toBe('AAAA 11월 21일 만기 420 콜 · 만기 D-74')
    expect(positionLine(book, 'p_1f05f8', en, now)).toBe('AAAA Nov 21 420 Call · Exp D-74')
  })

  it('counts down to the nearest expiry when the legs have more than one', () => {
    // A calendar spread's front leg is what acts first, so it is the one a single number can
    // honestly name.
    const spread = bookOf(optionOn(['2026-12-18', '2026-10-16']))
    expect(positionLine(spread, 'p_2f05f8', en, now)).toContain('Exp D-38')
  })

  it('counts whole days, and today is D-0', () => {
    expect(positionLine(bookOf(optionOn(['2026-09-08'])), 'p_1f05f8', en, now)).toContain('D-0')
    expect(positionLine(bookOf(optionOn(['2026-09-09'])), 'p_1f05f8', en, now)).toContain('D-1')
  })

  it('never counts down to an expiry that has passed', () => {
    // `D-0` on a leg that expired last week is false and `D+7` is a countdown running backwards.
    // The date is already in the name beside it, so nothing is hidden by saying nothing.
    const gone = positionLine(bookOf(optionOn(['2026-09-07'])), 'p_1f05f8', en, now)
    expect(gone).toBe('AAAA Sep 7 420 Call')
    expect(gone).not.toMatch(/D-/)
  })

  it('gives a stock no countdown, because it has no expiry', () => {
    expect(positionLine(book, 'p_aa11bb', en, now)).toBe('BBBB 300 shares')
  })

  it('reads the reader’s own day through the same seam as the rest of the module', () => {
    // 2026-09-08T23:00Z is already the 9th in Seoul, so an expiry on the 9th is D-0 there and D-1
    // in New York. One date path, or the row and the heading above it could disagree about today.
    const instant = new Date('2026-09-08T23:00:00Z')
    const soon = bookOf(optionOn(['2026-09-09']))
    expect(positionLine(soon, 'p_1f05f8', en, instant, 'Asia/Seoul')).toContain('D-0')
    expect(positionLine(soon, 'p_1f05f8', en, instant, 'America/New_York')).toContain('D-1')
  })

  it('is empty for a position the book no longer holds, so the event still renders', () => {
    // The desk prunes the book when the positions change, but a phone can hold an answer from
    // before that. Dropping the event would hide a date; dropping the line loses nothing.
    expect(positionLine(book, 'p_ffffff', ko, now)).toBe('')
    expect(positionLine(null, 'p_1f05f8', ko, now)).toBe('')
  })
})

// ---------------------------------------------------------------------------
// What the screen draws
// ---------------------------------------------------------------------------

describe('scheduleView', () => {
  const now = new Date('2026-09-08T04:00:00Z')

  it('is the book, grouped, with the shortfall the desk sent', () => {
    const view = scheduleView({
      ready: true,
      doc: doc({
        shortfall: '오늘은 근거를 갖춘 일정이 여섯 건뿐이에요.',
        events: [wireEvent({ at: '2026-09-09T12:30:00Z' })],
      }),
      now,
      tz: 'Asia/Seoul',
    })
    expect(view.kind).toBe('book')
    if (view.kind !== 'book') throw new Error('unreachable')
    expect(view.groups).toHaveLength(1)
    expect(view.shortfall).toBe('오늘은 근거를 갖춘 일정이 여섯 건뿐이에요.')
  })

  it('carries no shortfall when the book cleared the floor', () => {
    const view = scheduleView({
      ready: true,
      doc: doc({ events: [wireEvent({ at: '2026-09-09T12:30:00Z' })] }),
      now,
      tz: 'Asia/Seoul',
    })
    expect(view.kind === 'book' && view.shortfall).toBeNull()
  })

  it('tells the three empties apart', () => {
    // Three different facts, and only one of them asks the owner to do anything.
    expect(scheduleView({ ready: false, doc: null, now, tz: 'Asia/Seoul' }).kind).toBe('needs_desk')
    expect(scheduleView({ ready: true, doc: null, now, tz: 'Asia/Seoul' }).kind).toBe('no_book')
    expect(
      scheduleView({
        ready: true,
        doc: doc({ events: [wireEvent({ at: '2026-09-01T12:30:00Z' })] }),
        now,
        tz: 'Asia/Seoul',
      }).kind,
    ).toBe('nothing_upcoming')
    // A book the desk filed with nothing in it is the same fact as a book that has all gone by.
    expect(scheduleView({ ready: true, doc: doc({ events: [] }), now, tz: 'Asia/Seoul' }).kind).toBe(
      'nothing_upcoming',
    )
  })

  it('carries a failed refresh into every one of the four views', () => {
    // The one this exists for is `no_book`: a desk with no book, pulled to refresh, now
    // unreachable. Without the error the screen is byte-identical to the one the owner was already
    // looking at, and "still no book" reads exactly like "I could not reach the desk just now".
    const failed = '데스크에 연결하지 못했어요.'
    const views = [
      scheduleView({ ready: false, doc: null, now, error: failed, tz: 'Asia/Seoul' }),
      scheduleView({ ready: true, doc: null, now, error: failed, tz: 'Asia/Seoul' }),
      scheduleView({
        ready: true,
        doc: doc({ events: [wireEvent({ at: '2026-09-01T12:30:00Z' })] }),
        now,
        error: failed,
        tz: 'Asia/Seoul',
      }),
      scheduleView({
        ready: true,
        doc: doc({ events: [wireEvent({ at: '2026-09-09T12:30:00Z' })] }),
        now,
        error: failed,
        tz: 'Asia/Seoul',
      }),
    ]
    expect(views.map((v) => v.kind)).toEqual([
      'needs_desk',
      'no_book',
      'nothing_upcoming',
      'book',
    ])
    for (const view of views) expect(view.error).toBe(failed)
  })

  it('carries no error when nothing failed', () => {
    expect(scheduleView({ ready: true, doc: null, now, tz: 'Asia/Seoul' }).error).toBeNull()
  })

  it('says to set the desk up before it says there is no book', () => {
    // A phone with no desk has not been told anything about a book, so "no schedule filed yet"
    // would be the app inventing a fact about a server it never asked.
    expect(scheduleView({ ready: false, doc: doc(), now, tz: 'Asia/Seoul' }).kind).toBe('needs_desk')
  })
})

// ---------------------------------------------------------------------------
// The two additive surfaces
// ---------------------------------------------------------------------------

describe('upcomingView', () => {
  // 13:00 on the 8th in Seoul, so "already happened today" and "still to come today" are both
  // reachable from one instant.
  const now = new Date('2026-09-08T04:00:00Z')
  const tz = 'Asia/Seoul'

  const book = (...events: Array<Record<string, unknown>>): CalendarDoc =>
    doc({ events: events.map((e) => wireEvent(e)) })

  const ids = (view: UpcomingView): string[] =>
    view.kind === 'events' ? view.groups.flatMap((g) => g.events.map((e) => e.id)) : []

  it('is the head of the same list the schedule screen draws', () => {
    // The block on Markets and the top of `/schedule` must be the same events in the same order,
    // or tapping through looks like a different book. Both go through `groupByDay`.
    const view = upcomingView({
      ready: true,
      doc: book(
        { id: 'e_1', at: '2026-09-08T05:00:00Z' },
        { id: 'e_2', at: '2026-09-09T01:00:00Z' },
        { id: 'e_3', at: '2026-09-10T01:00:00Z' },
      ),
      now,
      tz,
      limit: 2,
    })
    expect(view.kind).toBe('events')
    if (view.kind !== 'events') throw new Error('unreachable')
    expect(view.groups.map((g) => g.date)).toEqual(['2026-09-08', '2026-09-09'])
    expect(ids(view)).toEqual(['e_1', 'e_2'])
    expect(view.count).toBe(2)
    expect(view.more).toBe(1)
  })

  it('draws nothing at all until a desk has answered with a book', () => {
    const filed = book({ id: 'e_1', at: '2026-09-09T01:00:00Z' })
    // Storage has not answered yet. Half-known is unknown.
    expect(upcomingView({ ready: null, doc: undefined, now, tz }).kind).toBe('hidden')
    // No desk on this phone. A book in hand cannot make this surface appear: nothing was asked of
    // anything, and `useEventBook` never calls `calendar()` in this state at all.
    expect(upcomingView({ ready: false, doc: filed, now, tz }).kind).toBe('hidden')
    // A desk that answered and has no book.
    expect(upcomingView({ ready: true, doc: null, now, tz }).kind).toBe('hidden')
    // A desk that could not be reached, with nothing already on screen — which reaches here as
    // the SAME `undefined`, because `useEventBook` reports a failure by leaving `doc` alone. NOT
    // an error: the schedule screen is where a failure is reported, because that is where the
    // owner went looking for it.
    expect(upcomingView({ ready: true, doc: undefined, now, tz }).kind).toBe('hidden')
  })

  it('reads the three states of `doc` as three different facts, which is the whole failure rule', () => {
    // There is no `failed` argument and there must not be one: `useEventBook` reports a failure
    // by LEAVING `doc` ALONE, so the three states already carry it. A first fetch that threw is
    // still `undefined` and hides; a refresh that threw over a book leaves the book here, and it
    // draws — the failure has nowhere to be said on these surfaces, so the choice is between the
    // last thing the desk actually said and a block that empties itself for no visible reason.
    const filed = book({ id: 'e_1', at: '2026-09-09T01:00:00Z' })
    expect(upcomingView({ ready: true, doc: undefined, now, tz }).kind).toBe('hidden')
    expect(upcomingView({ ready: true, doc: null, now, tz }).kind).toBe('hidden')
    expect(ids(upcomingView({ ready: true, doc: filed, now, tz }))).toEqual(['e_1'])
  })

  it('keeps what already happened today and drops what happened yesterday', () => {
    // `calendar.py` holds a seven-day past window on purpose, so "next" has to say where it cuts.
    // It cuts at the reader's own midnight — `groupByDay`'s cut and nobody else's: a print that
    // landed at 09:30 is the thing the owner most wants at the top of Markets at 13:00, and
    // yesterday's is three days of stale prints waiting to happen.
    const view = upcomingView({
      ready: true,
      doc: book(
        { id: 'e_morning', at: '2026-09-08T00:30:00Z' },
        { id: 'e_yesterday', at: '2026-09-07T12:30:00Z' },
      ),
      now,
      tz,
      limit: 3,
    })
    expect(ids(view)).toEqual(['e_morning'])
  })

  it('takes the next by time and never by rank', () => {
    // Ruling 21: `rank` is the agent's filing goal. A block ordered by importance is a block that
    // disagrees with the screen it opens.
    const view = upcomingView({
      ready: true,
      doc: book(
        { id: 'e_late_and_ranked_first', at: '2026-09-12T01:00:00Z', rank: 1 },
        { id: 'e_soon_and_ranked_last', at: '2026-09-09T01:00:00Z', rank: 9 },
      ),
      now,
      tz,
      limit: 1,
    })
    expect(ids(view)).toEqual(['e_soon_and_ranked_last'])
  })

  it('is one symbol’s slice when a symbol is named, and an event naming two is in both', () => {
    const filed = book(
      { id: 'e_a', symbols: ['AAAA'], at: '2026-09-09T01:00:00Z' },
      { id: 'e_b', symbols: ['BBBB'], at: '2026-09-10T01:00:00Z' },
      { id: 'e_both', symbols: ['AAAA', 'BBBB'], at: '2026-09-11T01:00:00Z' },
    )
    expect(ids(upcomingView({ ready: true, doc: filed, now, tz, symbol: 'AAAA' }))).toEqual([
      'e_a',
      'e_both',
    ])
    expect(ids(upcomingView({ ready: true, doc: filed, now, tz, symbol: 'BBBB' }))).toEqual([
      'e_b',
      'e_both',
    ])
  })

  it('matches a symbol however the route spelled it', () => {
    // `claudepost://market/aaaa` is a legal deep link; the detail screen uppercases it, and the
    // book's spelling is the agent's. Neither side gets to decide the other's case.
    const filed = book({ id: 'e_a', symbols: ['AAAA'], at: '2026-09-09T01:00:00Z' })
    expect(ids(upcomingView({ ready: true, doc: filed, now, tz, symbol: 'aaaa' }))).toEqual(['e_a'])
  })

  it('matches a whole ticker and never a prefix of one', () => {
    // `AA` and `AAAA` are two companies. A substring match would look right in every fixture that
    // happens to have no prefix collision, and put another company's earnings under this one's
    // calendar the first time one appeared.
    const filed = book({ id: 'e_a', symbols: ['AAAA'], at: '2026-09-09T01:00:00Z' })
    expect(upcomingView({ ready: true, doc: filed, now, tz, symbol: 'AA' }).kind).toBe('hidden')
    expect(upcomingView({ ready: true, doc: filed, now, tz, symbol: 'AAAAA' }).kind).toBe('hidden')
  })

  it('hides the slice when nothing in the book names the symbol', () => {
    // The symbol detail screen has a Yahoo calendar of its own and this part is additive. An
    // empty state here would be a new sentence on a screen that was complete without one.
    const filed = book({ id: 'e_a', symbols: ['AAAA'], at: '2026-09-09T01:00:00Z' })
    expect(upcomingView({ ready: true, doc: filed, now, tz, symbol: 'CCCC' }).kind).toBe('hidden')
  })

  it('hides rather than saying the book is empty', () => {
    // Everything filed is behind the reader. `/schedule` says `nothingUpcoming` about exactly
    // this; Markets says nothing, because it was not asked.
    const filed = book({ id: 'e_old', at: '2026-09-01T01:00:00Z' })
    expect(upcomingView({ ready: true, doc: filed, now, tz }).kind).toBe('hidden')
  })

  it('hides a limit of zero rather than drawing a heading over no rows', () => {
    // `{kind:'events'}` with an empty `groups` would be a "See all 3 ›" over an empty card. No
    // caller passes 0 today, which is the reason to settle it now rather than after one does.
    const filed = book(
      { id: 'e_1', at: '2026-09-09T01:00:00Z' },
      { id: 'e_2', at: '2026-09-10T01:00:00Z' },
    )
    expect(upcomingView({ ready: true, doc: filed, now, tz, limit: 0 }).kind).toBe('hidden')
    expect(upcomingView({ ready: true, doc: filed, now, tz, limit: -1 }).kind).toBe('hidden')
  })

  it('caps nothing when no limit is given', () => {
    const view = upcomingView({
      ready: true,
      doc: book(
        { id: 'e_1', at: '2026-09-09T01:00:00Z' },
        { id: 'e_2', at: '2026-09-10T01:00:00Z' },
        { id: 'e_3', at: '2026-09-11T01:00:00Z' },
      ),
      now,
      tz,
    })
    expect(view.kind === 'events' && view.count).toBe(3)
    expect(view.kind === 'events' && view.more).toBe(0)
  })

  it('reads the reader’s own day, not the wire’s', () => {
    // 2026-09-08T23:00Z is the 9th in Seoul and still the 8th in New York, so the same event is
    // tomorrow's row in one zone and today's in the other — and in a zone where it is already
    // yesterday it would be gone. One seam, `partsOf`, decides that for every surface.
    const filed = book({ id: 'e_1', at: '2026-09-08T23:00:00Z' })
    const view = (zone: string) =>
      upcomingView({ ready: true, doc: filed, now: new Date('2026-09-08T04:00:00Z'), tz: zone })
    const seoul = view('Asia/Seoul')
    const newYork = view('America/New_York')
    expect(seoul.kind === 'events' && seoul.groups[0].date).toBe('2026-09-09')
    expect(newYork.kind === 'events' && newYork.groups[0].date).toBe('2026-09-08')
  })
})

// ---------------------------------------------------------------------------
// When to ask the desk again
// ---------------------------------------------------------------------------

describe('bookFetchDue', () => {
  const now = 1_757_000_000_000
  const settled = {
    now,
    fetchedAt: now - 1_000,
    address: 'https://desk.example.dev',
    cachedAddress: 'https://desk.example.dev',
    cachedReady: true,
  }

  it('fetches when there is nothing in memory at all', () => {
    expect(bookFetchDue({ ...settled, fetchedAt: 0, cachedAddress: null, cachedReady: null })).toBe(
      true,
    )
  })

  it('answers from memory inside the window', () => {
    // The defect this exists for: both surfaces fire on an EDGE, so Markets → symbol → Calendar
    // → Info → Calendar → Markets was four loads and eight bearer-authed requests for a document
    // filed twice a day.
    expect(bookFetchDue({ ...settled, fetchedAt: now - (BOOK_REFRESH_AFTER_MS - 1) })).toBe(false)
  })

  it('fetches again once the window has passed', () => {
    expect(bookFetchDue({ ...settled, fetchedAt: now - BOOK_REFRESH_AFTER_MS })).toBe(true)
  })

  it('fetches at once for a different desk, however fresh the last answer was', () => {
    // Not a refresh — a first question about something else.
    expect(
      bookFetchDue({ ...settled, fetchedAt: now, address: 'https://other.example.dev' }),
    ).toBe(true)
  })

  it('fetches at once when credentials have only just appeared', () => {
    // A phone with no token publishes `ready: false` and calls nothing. Throttling the first call
    // after a token is saved in Settings would leave Markets blank for five minutes with nothing
    // on screen to say why.
    expect(bookFetchDue({ ...settled, fetchedAt: now, cachedReady: false })).toBe(true)
    expect(bookFetchDue({ ...settled, fetchedAt: now, cachedReady: null })).toBe(true)
  })

  it('throttles a settled failure exactly like a settled success', () => {
    // `fetchBook` stamps both arms and moves `ready` to true on either, so an unreachable desk is
    // asked once per window rather than once per focus. These surfaces show nothing either way;
    // `/schedule` is where a failure is reported, and its pull-to-refresh does not come here.
    expect(bookFetchDue({ ...settled, fetchedAt: now - 1 })).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// The route
// ---------------------------------------------------------------------------

const BASE = 'https://desk.example.dev'
const TOKEN = 'operator-token-for-tests'

type Reply = { status?: number; text?: string } | Error

function client(replies: Reply[]) {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  let i = 0
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    const r = replies[Math.min(i, replies.length - 1)]
    i++
    if (r instanceof Error) throw r
    const status = r.status ?? 200
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => r.text ?? '',
    } as unknown as Response
  }) as unknown as typeof fetch
  return { calls, client: createDeskClient({ baseUrl: BASE, token: TOKEN, fetchFn: fetchImpl }) }
}

describe('deskClient.calendar', () => {
  it('GETs /api/calendar with the token as a bearer', async () => {
    const { client: c, calls } = client([
      { text: JSON.stringify({ ok: true, calendar: wireDoc() }) },
    ])
    const book = await c.calendar()
    expect(book?.events).toHaveLength(1)
    expect(calls[0].url).toBe('https://desk.example.dev/api/calendar')
    expect(calls[0].init?.method).toBe('GET')
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`)
  })

  it('reads a desk that has no book as no book, not as a failure', async () => {
    // `h_get_calendar` serves `self.desk.calendar` straight, and that is `None` until the agent
    // files one — and again after the positions change, because the desk forgets a book it can no
    // longer prune. A desk that answered perfectly must not read as one that broke.
    const { client: c } = client([{ text: JSON.stringify({ ok: true, calendar: null }) }])
    expect(await c.calendar()).toBeNull()
  })

  it('refuses a 200 that is not this contract', async () => {
    const { client: c } = client([{ text: JSON.stringify({ ok: true }) }])
    await expect(c.calendar()).rejects.toMatchObject({ code: 'bad_json' })
    const { client: c2 } = client([{ text: 'not json at all' }])
    await expect(c2.calendar()).rejects.toMatchObject({ code: 'bad_json' })
  })

  it('reads a 403 as unauthorized, naming the route in the message', async () => {
    const { client: c } = client([
      { status: 403, text: JSON.stringify({ ok: false, error: 'forbidden' }) },
    ])
    const e = await c.calendar().catch((x: unknown) => x)
    expect(e).toBeInstanceOf(DeskError)
    expect(e).toMatchObject({ code: 'unauthorized', status: 403 })
    expect((e as DeskError).message).toContain('calendar')
  })

  it('never puts the token in the message of anything it throws', async () => {
    const { client: c } = client([new Error(`connect to ${BASE} failed`)])
    const e = await c.calendar().catch((x: unknown) => x)
    expect(String((e as Error).message)).not.toContain(TOKEN)
  })
})
