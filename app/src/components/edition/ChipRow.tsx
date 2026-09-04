import { ScrollView, StyleSheet } from 'react-native'
import { Chip as Pill } from '../Chip'
import { CHIPS, type Chip } from '../../lib/edition/tiles'
import { useStrings } from '../../i18n'
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
 * order — All, Stories, Numbers, Accounts, Photos — whatever order the caller computed. That
 * constant is ids alone; the words come from the catalogue here, which is why the cut in
 * `tiles.ts` has no language in it at all.
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
  const labels = useStrings().today.chips
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row}>
      {CHIPS.filter((c) => chips.includes(c)).map((c) => (
        <Pill key={c} label={labels[c]} active={c === selected} onPress={() => onSelect(c)} />
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
