import { Pressable, StyleSheet, Text, View } from 'react-native'
import { useStrings } from '../../i18n'
import { colors, fonts, layout, radius, space, tabular, type } from '../../theme'
import { formatPrice } from '../../lib/edition/format'
import { Chip } from '../Chip'
import { Change } from './Change'
import { type Edition } from '../../lib/edition/types'

/**
 * The top of the page: who this edition is about, what the price did, how fresh it is, and — only
 * when something actually failed — what failed.
 *
 * The company name is the headline of the whole tab, because every edition is about exactly one
 * listed company. Tapping the symbol pushes the Markets detail for it, which is the one place in
 * this app where the edition and the watchlist meet — and it is a press ONLY when there is a
 * symbol to push. `isEmptyEdition` lets an edition through on its stories alone and `parseSubject`
 * invents no fallback, so a producer that omits the symbol yields a pressable blank that navigates
 * to `/market/`, a path no route matches in an app with no `+not-found`.
 *
 * The failure banner takes `warn`, never direction red. Red on this screen means a price fell;
 * spending it on "the server did not answer" would put a market signal on a network problem. The
 * demo chip takes `accent` for the mirror-image reason: an unconfigured phone reading the bundled
 * edition is a complete state and not a fault, so it must not borrow the colour of one.
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
  const t = useStrings()
  const s = edition.subject

  return (
    <View style={styles.root}>
      <Text style={type.headingLg} numberOfLines={2}>
        {s.name !== '' ? s.name : s.symbol}
      </Text>

      {s.symbol !== '' ? (
        <Pressable
          accessibilityRole="button"
          onPress={onPressSymbol}
          hitSlop={6}
          style={styles.symbolRow}
        >
          <Text style={styles.symbol}>{s.symbol}</Text>
          {s.exchange !== '' ? <Text style={type.caption}>{s.exchange}</Text> : null}
        </Pressable>
      ) : s.exchange !== '' ? (
        // No symbol: the exchange still reads, as plain text. A row that looks like a button and
        // goes nowhere is worse than no row.
        <View style={styles.symbolRow}>
          <Text style={type.caption}>{s.exchange}</Text>
        </View>
      ) : null}

      <View style={styles.priceRow}>
        <Text style={[styles.price, tabular]} numberOfLines={1}>
          {formatPrice(s.last)}
        </Text>
        <Change pct={s.changePct} size={17} />
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
      {demo ? <Chip label={t.today.demoChip} tone="accent" style={styles.demoChip} /> : null}
      {freshness !== null ? <Text style={styles.freshness}>{freshness}</Text> : null}

      {error !== null ? (
        <View style={styles.banner}>
          <Text style={styles.bannerText}>{error}</Text>
          <Pressable accessibilityRole="button" onPress={onRetry} hitSlop={8}>
            <Text style={styles.retry}>{t.common.retry}</Text>
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
  freshness: {
    ...type.caption,
    paddingTop: space.xs,
  },
  // The pill itself is the app's `Chip` — the same one `ChipRow` and the Board screen use, whose
  // own comment says a second pill style would make one shape mean two things. Only the box is
  // this screen's: a chip in a column of full-width text has to be told not to stretch.
  demoChip: {
    alignSelf: 'flex-start',
    marginTop: space.xs,
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
