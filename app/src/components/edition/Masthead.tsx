import { Pressable, StyleSheet, Text, View } from 'react-native'
import { colors, fonts, layout, radius, space, tabular, type } from '../../theme'
import { changeArrow, changeTone, formatPct, formatPrice } from '../../lib/edition/format'
import { toneTextColor } from './tone'
import { type Edition } from '../../lib/edition/types'

/**
 * The top of the page: who this edition is about, what the price did, how fresh it is, and — only
 * when something actually failed — what failed.
 *
 * The company name is the headline of the whole tab, because every edition is about exactly one
 * listed company. Tapping the symbol pushes the Markets detail for it, which is the one place in
 * this app where the edition and the watchlist meet.
 *
 * The failure banner takes `warn`, never direction red. Red on this screen means a price fell;
 * spending it on "the server did not answer" would put a market signal on a network problem.
 */
export function Masthead({
  edition,
  demo,
  freshness,
  error,
  onRetry,
  onPressSymbol,
}: {
  edition: Edition
  demo: boolean
  freshness: string | null
  /** A failed refresh with content still on screen. Null when nothing failed. */
  error: string | null
  onRetry: () => void
  onPressSymbol: () => void
}) {
  const s = edition.subject
  const tone = changeTone(s.changePct)
  const arrow = changeArrow(s.changePct)

  return (
    <View style={styles.root}>
      <Text style={type.headingLg} numberOfLines={2}>
        {s.name !== '' ? s.name : s.symbol}
      </Text>

      <Pressable
        accessibilityRole="button"
        onPress={onPressSymbol}
        hitSlop={6}
        style={styles.symbolRow}
      >
        <Text style={styles.symbol}>{s.symbol}</Text>
        {s.exchange !== '' ? <Text style={type.caption}>{s.exchange}</Text> : null}
      </Pressable>

      <View style={styles.priceRow}>
        <Text style={[styles.price, tabular]} numberOfLines={1}>
          {formatPrice(s.last)}
        </Text>
        <Text style={[styles.change, tabular, { color: toneTextColor(tone) }]} numberOfLines={1}>
          {arrow !== '' ? `${arrow} ` : ''}
          {formatPct(s.changePct)}
        </Text>
      </View>

      {edition.dateline !== '' ? (
        <Text style={type.caption} numberOfLines={1}>
          {edition.dateline}
        </Text>
      ) : null}
      {edition.session !== '' ? (
        <Text style={type.caption} numberOfLines={1}>
          {edition.session}
        </Text>
      ) : null}

      {/* The demo chip and the freshness line are mutually exclusive by construction: the demo's
          fetchedAt is 0, so freshnessLabel answers null for it. */}
      {demo ? (
        <View style={styles.demoChip}>
          <Text style={styles.demoText}>Demo edition</Text>
        </View>
      ) : null}
      {freshness !== null ? <Text style={styles.freshness}>{freshness}</Text> : null}

      {error !== null ? (
        <View style={styles.banner}>
          <Text style={styles.bannerText}>{error}</Text>
          <Pressable accessibilityRole="button" onPress={onRetry} hitSlop={8}>
            <Text style={styles.retry}>Retry</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  root: {
    paddingHorizontal: layout.gutter,
    paddingTop: space.sm,
    gap: space.xs,
  },
  symbolRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: space.sm,
  },
  symbol: {
    fontFamily: fonts.semibold,
    fontSize: 15,
    color: colors.accent,
    letterSpacing: 0.4,
  },
  priceRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: space.md,
    paddingTop: space.xs,
  },
  price: {
    ...type.display,
    fontSize: 38,
    lineHeight: 44,
  },
  change: {
    fontFamily: fonts.semibold,
    fontSize: 17,
  },
  freshness: {
    ...type.caption,
    paddingTop: space.xs,
  },
  demoChip: {
    alignSelf: 'flex-start',
    marginTop: space.xs,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: radius.pill,
    backgroundColor: colors.accentDim,
  },
  demoText: {
    fontFamily: fonts.semibold,
    fontSize: 12,
    color: colors.accent,
  },
  banner: {
    marginTop: space.sm,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.md,
    backgroundColor: colors.warnBg,
    borderRadius: radius.md,
    padding: space.md,
  },
  bannerText: {
    flex: 1,
    fontFamily: fonts.medium,
    fontSize: 13,
    lineHeight: 18,
    color: colors.warn,
  },
  retry: {
    fontFamily: fonts.semibold,
    fontSize: 13,
    color: colors.warn,
  },
})
