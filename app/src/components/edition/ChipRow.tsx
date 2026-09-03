import { ScrollView, StyleSheet } from 'react-native'
import { Chip as Pill } from '../Chip'
import { CHIPS, type Chip } from '../../lib/edition/tiles'
import { layout, space } from '../../theme'

/**
 * The filter row, borrowed from YouTube's: it narrows a heterogeneous feed IN PLACE rather than
 * sending the reader to another screen. Only chips with tiles behind them are passed in, so a
 * control here always does something.
 *
 * It reuses the app's existing `Chip`, which already owns the selection idiom (the accentDim
 * wash) that `SectionTabs` and `TimeframePills` use. A second pill style would make selection
 * mean two things in one app.
 *
 * `CHIPS` is iterated rather than the caller's array so the row is always in the canonical
 * order — All, Stories, Numbers, Accounts, Photos — whatever order the caller computed.
 */
export function ChipRow({
  chips,
  selected,
  onSelect,
}: {
  chips: Chip[]
  selected: Chip
  onSelect: (c: Chip) => void
}) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row}>
      {CHIPS.filter((c) => chips.includes(c.id)).map((c) => (
        <Pill key={c.id} label={c.label} active={c.id === selected} onPress={() => onSelect(c.id)} />
      ))}
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    gap: space.sm,
    paddingHorizontal: layout.gutter,
    paddingVertical: space.sm,
  },
})
