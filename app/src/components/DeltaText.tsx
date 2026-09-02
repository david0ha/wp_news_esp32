import { StyleSheet, Text } from 'react-native'
import { colors, fonts, tabular } from '../theme'
import { arrow, formatDelta, formatPct } from '../lib/market/format'

/**
 * The "▲ 1.23 (0.45%) Today" line. Direction color and the arrow come from the sign of
 * `delta` — magnitudes render unsigned, the arrow carries the sign, and a zero (or
 * missing) delta is grey with no arrow. Pure presentational; formatting comes from
 * `lib/market/format.ts`.
 */
export function DeltaText({
  delta,
  pct,
  suffix,
  size = 'md',
  currency = '',
}: {
  /** Absolute change, e.g. +14.75; may be undefined while loading. */
  delta?: number
  /** Percent-scaled change, e.g. 0.16 for 0.16% (NOT a 0–1 fraction); may be undefined. */
  pct?: number
  /** Rendered after the numbers, in textDim — e.g. 'Today' | '1W'. */
  suffix?: string
  size?: 'sm' | 'md' | 'lg'
  /** Prefix for the absolute part; '' hides it. Screens pass currencySymbol(quote.currency). */
  currency?: string
}) {
  const color =
    delta !== undefined && delta > 0
      ? colors.up
      : delta !== undefined && delta < 0
        ? colors.down
        : colors.textDim
  const mark = arrow(delta)
  const parts: string[] = []
  if (delta !== undefined) parts.push(`${currency}${formatDelta(delta)}`)
  if (pct !== undefined) parts.push(`(${formatPct(pct)})`)
  const main = parts.length === 0 ? '—' : `${mark ? `${mark} ` : ''}${parts.join(' ')}`

  return (
    <Text style={[styles.base, sizes[size], tabular, { color }]} numberOfLines={1}>
      {main}
      {suffix ? <Text style={styles.suffix}> {suffix}</Text> : null}
    </Text>
  )
}

const styles = StyleSheet.create({
  base: {
    fontFamily: fonts.semibold,
  },
  suffix: {
    color: colors.textDim,
  },
})

const sizes = StyleSheet.create({
  sm: { fontSize: 13 },
  md: { fontSize: 15 },
  lg: { fontSize: 17 },
})
