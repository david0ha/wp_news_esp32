import { StyleSheet, Text, View } from 'react-native'
import { Screen } from './Screen'
import { HeaderGear } from './HeaderGear'
import { colors } from '../theme/colors'
import { spacing } from '../theme/spacing'
import { typography } from '../theme/typography'

/**
 * Scaffolding, not design: a tab that exists as a route and a title before the screen behind it
 * is built. It carries the two things Task 23 is actually asserting — that the tab renders inside
 * the native tab bar, and that the gear is on every one of them.
 *
 * Each real screen (Today, Watch, Desk, Board) replaces its own use of this in its own task; when
 * the last one does, this file goes with it.
 */
export function TabPlaceholder({ title, note }: { title: string; note: string }) {
  return (
    <Screen edges={['top']}>
      <View style={styles.header}>
        <Text style={styles.title}>{title}</Text>
        <HeaderGear />
      </View>
      <View style={styles.body}>
        <Text style={styles.note}>{note}</Text>
      </View>
    </Screen>
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
    // `uiStrong`, not a paper face: this row is chrome, and the rule a diff can check is that the
    // newspaper faces never appear on it (plan Design > Direction). The tabs whose header really
    // is a nameplate — Today's masthead — set that in the paper face on paper, in their own task.
    ...typography.uiStrong,
    fontSize: 22,
    color: colors.deskText,
  },
  body: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing[32],
  },
  note: {
    ...typography.ui,
    color: colors.deskFaint,
    textAlign: 'center',
  },
})
