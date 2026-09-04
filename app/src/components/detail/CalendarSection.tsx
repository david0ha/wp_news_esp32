import { useCallback, useEffect, useState } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { Card } from '../Card'
import { EventRow } from '../EventRow'
import { fill, strings, useStrings } from '../../i18n'
import { colors, fonts, radius, space, tabular, type } from '../../theme'
import { formatDateShort, formatRatio } from '../../lib/market/format'
import { marketHumanError, type CalendarEvents, type EarningsRow } from '../../lib/market/types'
import { yahoo } from '../../lib/market/yahoo'

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
 * The detail screen's Calendar tab: upcoming earnings/dividend dates as EventRows and
 * the past-earnings beat/miss table, fed by the crumb-gated yahoo.calendar(symbol).
 * Fetched lazily on first activation; a failed crumb bootstrap lands in the friendly
 * degraded card (a normal outcome from EU IPs), with its own retry.
 */
export function CalendarSection({ symbol, active }: DetailSectionProps) {
  const t = useStrings()
  const [state, setState] = useState<LoadState>({ status: 'idle' })

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

  if (!active) return null

  if (state.status === 'idle' || state.status === 'loading') {
    return (
      <View style={styles.section}>
        <View style={styles.loadingBox}>
          <ActivityIndicator color={colors.accent} />
        </View>
      </View>
    )
  }

  if (state.status === 'error') {
    return (
      <View style={styles.section}>
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
      </View>
    )
  }

  const { events } = state
  const upcoming = upcomingRows(events)

  return (
    <View style={styles.section}>
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
              <EarningsHistoryRow key={`${row.quarter}:${i}`} row={row} last={i === rows.length - 1} />
            ))}
          </Card>
        </>
      ) : null}
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
