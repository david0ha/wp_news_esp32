import { Text, type TextStyle } from 'react-native'
import { colors, typography } from '../theme/index'

/**
 * A small standing fact — "hangs there since 06:04", "printed AUG 12", "staged" (plan Design >
 * Copy's stamp list). Always `typography.label` — it renders in caps like every other label —
 * with `tone` choosing the muted colour for its material, never the full-strength ink/deskText a
 * heading would use: a stamp is a footnote, not a head.
 */
export function Stamp({
  children,
  tone = 'paper',
  style,
}: {
  children: string
  tone?: 'paper' | 'chrome'
  style?: TextStyle
}) {
  const color = tone === 'paper' ? colors.inkMuted : colors.deskDim
  return <Text style={[typography.label, { color }, style]}>{children}</Text>
}
