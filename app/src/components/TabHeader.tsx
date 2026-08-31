import { StyleSheet, Text, View } from 'react-native'
import { HeaderGear } from './HeaderGear'
import { colors, spacing, typography } from '../theme/index'

/**
 * The header the three chrome tabs share: a 22 pt title on the left, the gear on the right.
 *
 * Desk, Watch and Board each hand-rolled this — the same row, the same title style, the same
 * `<HeaderGear>` — and two of them wrote the style two different ways (`[typography.uiStrong,
 * styles.title]` on one, `{...typography.uiStrong, ...}` inside the StyleSheet on the others).
 * They render identically today, which is the problem with three copies: nothing tells you when
 * they stop.
 *
 * TODAY IS NOT ONE OF THEM, and that is deliberate rather than an omission. Today's header is the
 * masthead — it carries the dateline and the edition, it is set in the paper faces, and it lives
 * *inside* the ScrollView so it scrolls away like the top of a broadsheet. It is content, not
 * chrome. This is chrome, and it stays pinned.
 */
export function TabHeader({ title }: { title: string }) {
  return (
    <View style={styles.header}>
      <Text style={styles.title}>{title}</Text>
      <HeaderGear />
    </View>
  )
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing[16],
    paddingTop: spacing[8],
  },
  title: {
    ...typography.uiStrong,
    fontSize: 22,
    color: colors.deskText,
  },
})
