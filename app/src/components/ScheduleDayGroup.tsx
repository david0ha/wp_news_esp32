import { StyleSheet, Text, View } from 'react-native'
import { Card } from './Card'
import { ScheduleRow } from './ScheduleRow'
import { dayLabel, type DayGroup } from '../lib/schedule'
import { type PositionsDoc } from '../lib/positions'
import { useStrings } from '../i18n'
import { space, type } from '../theme'

/**
 * One day of the book: the heading, and the day's rows inside this app's own card.
 *
 * Rows are dense and the card holds them together rather than each row being one — Toss's
 * watchlist rejects per-row cards for the same reason, that a scannable screen stops being
 * scannable the moment every line has its own shadow. The heading names the two near days and
 * only dates the rest (`dayLabel`), because "in 7 days" is arithmetic the reader then has to do
 * again against their own calendar.
 */
export function ScheduleDayGroup({
  group,
  now,
  book,
  expanded,
  onToggle,
}: {
  group: DayGroup
  /** Passed in rather than read here, so every heading on one screen — and every countdown in
   *  every row under them — agrees about what "today" is. A group that read the clock itself
   *  could straddle midnight mid-list and print two 오늘. */
  now: Date
  book: PositionsDoc | null
  /** The ids of the rows that are open. Held by the screen: a row that owned its own state would
   *  forget it whenever the list re-ordered around a refresh. */
  expanded: ReadonlySet<string>
  onToggle: (id: string) => void
}) {
  const t = useStrings()
  return (
    <View style={styles.group}>
      <Text style={styles.heading}>{dayLabel(group.date, now, t)}</Text>
      <Card style={styles.card}>
        {group.events.map((event, i) => (
          <ScheduleRow
            key={event.id}
            event={event}
            book={book}
            now={now}
            expanded={expanded.has(event.id)}
            onToggle={() => onToggle(event.id)}
            last={i === group.events.length - 1}
          />
        ))}
      </Card>
    </View>
  )
}

const styles = StyleSheet.create({
  group: {
    gap: space.sm,
  },
  heading: {
    ...type.label,
    // Not uppercased: the day heading carries a Korean date and a weekday, and `textTransform`
    // does nothing to those while stretching the Latin months beside them.
    textTransform: 'none',
    letterSpacing: 0.2,
    fontSize: 13,
  },
  card: {
    padding: 0,
  },
})
