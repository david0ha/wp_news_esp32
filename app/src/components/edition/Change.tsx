import { StyleSheet, Text, type StyleProp, type TextStyle } from 'react-native'
import { arrow, changeTone, formatPct } from '../../lib/edition/format'
import { toneTextColor } from './tone'
import { fonts, tabular } from '../../theme'

/**
 * A percentage change: unsigned, with the arrow and the colour saying which way.
 *
 * ONE COMPONENT FOR EVERY CHANGE ON THE EDITION'S TWO SCREENS — the tape, the peers, a figure,
 * the masthead's own, and every row of the detail page. There were five hand-written copies of
 * these four lines, and they had already drifted: four clamped to one line and the detail page's
 * did not, three reserved a width and two did not, and each spelled the arrow-plus-space by hand.
 * Direction is the one thing this app is allowed to say in colour, so it says it in one place.
 *
 * The magnitude is unsigned on purpose. The arrow and the colour already carry the direction, and
 * `▼ -0.74%` says it twice with two different marks. Zero and absence get no arrow and the dim
 * ink, never the green: see `changeTone`.
 *
 * `style` carries the BOX only — a width, a text alignment — because that is the one thing that
 * genuinely differs between a 62 px tape column and a masthead. The face, the tabular figures and
 * the colour are the component's, and the colour is applied last so a caller cannot override the
 * direction by accident.
 */
export function Change({
  pct,
  size = 12,
  style,
}: {
  pct: number | null | undefined
  /** The font size. The tiles use the default; the masthead and the detail rows are larger. */
  size?: number
  style?: StyleProp<TextStyle>
}) {
  const tone = changeTone(pct)
  const mark = arrow(pct)
  return (
    <Text
      style={[styles.text, { fontSize: size }, tabular, style, { color: toneTextColor(tone) }]}
      numberOfLines={1}
    >
      {mark !== '' ? `${mark} ` : ''}
      {formatPct(pct)}
    </Text>
  )
}

const styles = StyleSheet.create({
  text: {
    fontFamily: fonts.semibold,
  },
})
