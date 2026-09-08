import { useCallback, useEffect, useState } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { Card } from '../Card'
import { EventRow } from '../EventRow'
import { ScheduleDayGroup } from '../ScheduleDayGroup'
import { fill, strings, useStrings } from '../../i18n'
import { colors, fonts, radius, space, tabular, type } from '../../theme'
import { formatDateShort, formatRatio } from '../../lib/market/format'
import { marketHumanError, type CalendarEvents, type EarningsRow } from '../../lib/market/types'
import { yahoo } from '../../lib/market/yahoo'
import { upcomingView } from '../../lib/schedule'
import { useEventBook } from '../../lib/useEventBook'

interface DetailSectionProps {
  symbol: string
  active: boolean
}

type LoadState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; error: unknown }
  | { status: 'ready'; events: CalendarEvents }

/**
 * The detail screen's Calendar tab, in two parts and in this order.
 *
 * ABOVE: this symbol's slice of the desk's event book — dates the agent researched and reasoned
 * about against a position the owner actually holds, which is why it outranks a neutral calendar
 * on the same screen. Grouped by day with `ScheduleDayGroup`, so it is the same rows in the same
 * shape as `/schedule` and a reader is never asked to learn a second layout for one feature.
 *
 * BELOW, UNCHANGED: Yahoo's upcoming earnings/dividend dates as EventRows and the past-earnings
 * beat/miss table, fed by the crumb-gated yahoo.calendar(symbol). Fetched lazily on first
 * activation; a failed crumb bootstrap lands in the friendly degraded card (a normal outcome from
 * EU IPs), with its own retry. This half is good and the book does not replace it.
 *
 * THE TWO HALVES FAIL SEPARATELY, WHICH IS THE POINT. A phone with no desk token is a normal
 * phone: no desk, no book, or a desk that could not be reached all draw NOTHING here — no new
 * empty state, no new spinner, no new error — and this screen looks exactly as it did before the
 * feature existed. `upcomingView` makes that one decision, once, so it cannot be true of the
 * loading branch and quietly false of the error branch. It runs the other way too: an EU IP whose
 * Yahoo calendar degrades still gets the whole book slice above the degraded card, because the
 * desk answered even though Yahoo did not.
 */
export function CalendarSection({ symbol, active }: DetailSectionProps) {
  const t = useStrings()
  const [state, setState] = useState<LoadState>({ status: 'idle' })
  const desk = useEventBook()
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())

  const load = useCallback(async () => {
    setState({ status: 'loading' })
    try {
      const events = await yahoo.calendar(symbol)
      setState({ status: 'ready', events })
    } catch (e) {
      setState({ status: 'error', error: e })
    }
  }, [symbol])

  useEffect(() => {
    if (active && state.status === 'idle') void load()
  }, [active, state.status, load])

  // The desk is asked on the same activation and never before it: four sections mount at once on
  // this screen, and a tab nobody opened is not a reason to call somebody's server.
  const loadDesk = desk.load
  useEffect(() => {
    if (active) void loadDesk()
  }, [active, loadDesk])

  const toggle = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  if (!active) return null

  // Read once per render pass, in the render body, and passed down — so the day headings and the
  // expiry countdowns inside the rows under them agree about what today is (ruling 23). No timer.
  const now = new Date()
  const book = upcomingView({
    ready: desk.ready,
    doc: desk.doc,
    failed: desk.failed,
    now,
    symbol,
  })

  // Yahoo's half, exactly as it was: a spinner until it settles, the degraded card with its retry
  // when it fails, the two lists when it lands. A plain function rather than a component so its
  // state stays this one's and a tab switch cannot remount it back to idle.
  function yahooCalendar() {
    if (state.status === 'idle' || state.status === 'loading') {
      return (
        <View style={styles.loadingBox}>
          <ActivityIndicator color={colors.accent} />
        </View>
      )
    }

    if (state.status === 'error') {
      return (
        <Card style={styles.degraded}>
          <View style={styles.degradedIcon}>
            <Ionicons name="calendar-outline" size={20} color={colors.accent} />
          </View>
          <View style={styles.degradedText}>
            <Text style={styles.degradedTitle}>{t.marketDetail.calendar.unavailable}</Text>
            <Text style={type.caption}>{marketHumanError(state.error)}</Text>
            <Pressable onPress={() => void load()} hitSlop={8}>
              <Text style={styles.ghost}>{t.common.tryAgain}</Text>
            </Pressable>
          </View>
        </Card>
      )
    }

    const { events } = state
    const upcoming = upcomingRows(events)

    return (
      <>
        <Text style={styles.label}>{t.marketDetail.calendar.upcoming}</Text>
        {upcoming.length === 0 ? (
          <Text style={styles.empty}>{t.marketDetail.calendar.empty}</Text>
        ) : (
          <Card style={styles.listCard}>
            {upcoming.map((row, i) => (
              <EventRow
                // Keyed on the icon, which is one per kind of row and does not change with the
                // language — the title now does, and keying on it would remount the list on a
                // language switch.
                key={row.icon}
                icon={row.icon}
                title={row.title}
                subtitle={row.subtitle}
                value={row.value}
                last={i === upcoming.length - 1}
              />
            ))}
          </Card>
        )}
        {events.history.length > 0 ? (
          <>
            <Text style={styles.label}>{t.marketDetail.calendar.pastEarnings}</Text>
            <Card style={styles.listCard}>
              {events.history.slice(0, 4).map((row, i, rows) => (
                <EarningsHistoryRow
                  key={`${row.quarter}:${i}`}
                  row={row}
                  last={i === rows.length - 1}
                />
              ))}
            </Card>
          </>
        ) : null}
      </>
    )
  }

  return (
    <View style={styles.section}>
      {book.kind === 'events' ? (
        <>
          <Text style={styles.label}>{t.marketDetail.calendar.deskEvents}</Text>
          <View style={styles.deskGroups}>
            {book.groups.map((group) => (
              <ScheduleDayGroup
                key={group.date}
                group={group}
                now={now}
                book={desk.book}
                expanded={expanded}
                onToggle={toggle}
              />
            ))}
          </View>
        </>
      ) : null}
      {yahooCalendar()}
    </View>
  )
}

interface UpcomingRow {
  icon: 'megaphone-outline' | 'cut-outline' | 'cash-outline'
  title: string
  subtitle?: string
  value: string
}

// Not a component, so it reads the catalogue through `strings()` — at call time, which is once
// per render of the section above it.
function upcomingRows(events: CalendarEvents): UpcomingRow[] {
  const t = strings().marketDetail.calendar
  const rows: UpcomingRow[] = []
  const first = events.earningsDates[0]
  if (first !== undefined) {
    const second = events.earningsDates[1]
    rows.push({
      icon: 'megaphone-outline',
      title: t.earnings,
      subtitle: events.earningsDates.length > 1 ? t.estimatedDate : undefined,
      value:
        second !== undefined
          ? `${formatDateShort(first)} – ${formatDateShort(second)}`
          : formatDateShort(first),
    })
  }
  if (events.exDividendDate !== null) {
    rows.push({
      icon: 'cut-outline',
      title: t.exDividend,
      value: formatDateShort(events.exDividendDate),
    })
  }
  if (events.dividendDate !== null) {
    rows.push({
      icon: 'cash-outline',
      title: t.dividendPayable,
      value: formatDateShort(events.dividendDate),
    })
  }
  return rows
}

function EarningsHistoryRow({ row, last }: { row: EarningsRow; last: boolean }) {
  const t = useStrings()
  const { epsActual, epsEstimate } = row
  // A beat/miss is direction — the green/red rule applies; either side missing is neutral.
  const color =
    epsActual !== null && epsEstimate !== null
      ? epsActual > epsEstimate
        ? colors.up
        : epsActual < epsEstimate
          ? colors.down
          : colors.text
      : colors.text
  return (
    <View style={[styles.historyRow, !last && styles.historyBordered]}>
      <Text style={[styles.quarter, tabular]} numberOfLines={1}>
        {row.quarter !== '' ? row.quarter : '—'}
      </Text>
      <Text style={[styles.eps, tabular, { color }]} numberOfLines={1}>
        {fill(t.marketDetail.calendar.epsActualVsEstimate, {
          actual: formatRatio(epsActual),
          estimate: formatRatio(epsEstimate),
        })}
      </Text>
    </View>
  )
}

const styles = StyleSheet.create({
  section: {
    paddingBottom: space.xl,
  },
  loadingBox: {
    height: 120,
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: {
    ...type.label,
    marginTop: space.lg,
    marginBottom: space.sm,
  },
  // The day groups carry their own heading, so they need the same air between them that the
  // schedule screen's scroll container gives them.
  deskGroups: {
    gap: space.lg,
  },
  listCard: {
    padding: 0,
  },
  empty: {
    ...type.caption,
    textAlign: 'center',
    paddingVertical: space.xl,
  },
  ghost: {
    fontFamily: fonts.semibold,
    fontSize: 14,
    color: colors.accent,
  },
  historyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    paddingHorizontal: space.lg,
  },
  historyBordered: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  quarter: {
    fontFamily: fonts.semibold,
    fontSize: 14,
    color: colors.text,
  },
  eps: {
    fontFamily: fonts.medium,
    fontSize: 14,
    flexShrink: 1,
    textAlign: 'right',
    marginLeft: space.lg,
  },
  degraded: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.md,
    marginTop: space.lg,
  },
  degradedIcon: {
    width: 40,
    height: 40,
    borderRadius: radius.md,
    backgroundColor: colors.iconWell,
    alignItems: 'center',
    justifyContent: 'center',
  },
  degradedText: {
    flex: 1,
    gap: space.sm,
  },
  degradedTitle: {
    fontFamily: fonts.semibold,
    fontSize: 15,
    color: colors.text,
  },
})
