import { useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import Animated, { useReducedMotion } from 'react-native-reanimated'
import { GradeDisc } from '../GradeDisc'
import { Change } from '../Change'
import { colors, pressTransition, pressedScale, spacing, typography } from '../../theme/index'
import { formatCents, formatPrintedDate } from '../../lib/format'
import { thesisLine } from '../../lib/watchlist'
import type { Quote, WatchlistItem } from '../../lib/desk'

/**
 * One row of the Watch tab — the grade, the symbol and name, the thesis's first line, and a
 * `printed AUG 12` stamp on the left; the last price and its change on the right (plan Design >
 * Wireframes). Paper, square-cut, a hairline rule under everything but the last row — the desk
 * lists companies, but a company is still printed matter, not a desk control.
 *
 * `quote` is `undefined` — not zero, not a dash — for a desk with no Alpaca key (`useQuotes()`
 * returns `null`) and for a symbol the quotes map does not carry (a numeric KR listing, say): the
 * right-hand column is simply not rendered, and the left column already carries the row's whole
 * argument, so the row loses nothing by losing it.
 */
export function WatchRow({
  item,
  quote,
  onPress,
  last,
}: {
  item: WatchlistItem
  quote: Quote | undefined
  onPress: () => void
  /** Whether this is the last row in the list — the one hairline rule that does not print. */
  last?: boolean
}) {
  const thesis = thesisLine(item.note)
  const printed = item.last_printed ? formatPrintedDate(item.last_printed) : ''
  const [pressed, setPressed] = useState(false)
  const reducedMotion = useReducedMotion()
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${item.symbol}, ${item.name}`}
      onPress={onPress}
      onPressIn={() => setPressed(true)}
      onPressOut={() => setPressed(false)}
    >
      <Animated.View
        style={[
          styles.row,
          pressTransition,
          !last && styles.divider,
          pressed && !reducedMotion && pressedScale,
        ]}
      >
        <View style={styles.left}>
          <View style={styles.headRow}>
            <GradeDisc grade={item.grade} size={14} />
            <Text style={[typography.label, styles.symbol]}>{item.symbol}</Text>
            <Text style={[typography.headlineSm, styles.name]} numberOfLines={1}>
              {item.name}
            </Text>
          </View>
          {thesis !== '' ? (
            <Text style={[typography.deck, styles.thesis]} numberOfLines={1}>
              {thesis}
            </Text>
          ) : null}
          {printed !== '' ? (
            <Text style={[typography.figure, styles.printed]}>printed {printed}</Text>
          ) : null}
        </View>
        {quote ? (
          <View style={styles.quotes}>
            <Text style={[typography.figure, styles.last]}>{formatCents(quote.lastCents)}</Text>
            <Change bp={quote.changeBp} tone="paper" />
          </View>
        ) : null}
      </Animated.View>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingVertical: spacing[16],
    gap: spacing[12],
  },
  divider: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.ink,
  },
  left: {
    flex: 1,
    gap: spacing[4],
  },
  headRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[8],
  },
  symbol: {
    color: colors.ink,
  },
  name: {
    flex: 1,
    color: colors.ink,
  },
  thesis: {
    color: colors.ink,
  },
  printed: {
    fontSize: 12,
    color: colors.inkMuted,
  },
  quotes: {
    alignItems: 'flex-end',
    gap: spacing[4],
  },
  last: {
    color: colors.ink,
  },
})
