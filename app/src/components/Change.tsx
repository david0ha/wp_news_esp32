import { Text, type TextStyle } from 'react-native'
import { colors, typography } from '../theme/index'
import { changeTone, formatChange } from '../lib/format'

/**
 * A signed change with its ▲/▼ mark, from the basis points the wire carries — the app-side twin
 * of the device's `ui_chg_colour()` and `format.ts`'s own `changeTone()`. `tone` is the material:
 * `signal.paper.*` beside a figure printed on a sheet, `signal.chrome.*` in a desk control. Direction
 * is ink (or deskText) at exactly zero, never a green/red claiming a move that did not happen —
 * `formatChange()` already omits the sign there, and this component matches it in colour.
 */
export function Change({
  bp,
  tone,
  style,
}: {
  bp: number
  tone: 'paper' | 'chrome'
  style?: TextStyle
}) {
  const direction = changeTone(bp)
  const zeroColor = tone === 'paper' ? colors.ink : colors.deskText
  const color =
    direction === 'up'
      ? colors.signal[tone].up
      : direction === 'down'
        ? colors.signal[tone].down
        : zeroColor
  const arrow = direction === 'up' ? '▲ ' : direction === 'down' ? '▼ ' : ''
  return (
    <Text style={[typography.figure, { color }, style]}>
      {arrow}
      {formatChange(bp)}
    </Text>
  )
}
