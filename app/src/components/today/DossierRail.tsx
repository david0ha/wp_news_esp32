import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { colors, radius, spacing, typography } from '../../theme/index'
import { Change } from '../Change'
import type { NewsFigure } from '../../lib/desk'

/**
 * The figures rail — a horizontal scroll of small paper tiles, one per figure: label, value, and
 * `<Change>` only when the figure actually carries one (`changeBp === null` means no change at
 * all, which `<Change>` cannot express — CLAUDE.md's "absent prints with no mark and no colour,
 * present-and-zero prints a flat mark").
 *
 * `hasNotes` + `onPressNotes` add "The dossier" link row underneath, for the edition's own
 * markdown dossier (Task 30's route). Both are optional: a caller with no current edition, or one
 * that doesn't carry notes, just gets the rail with no link.
 */
export function DossierRail({
  figures,
  hasNotes = false,
  onPressNotes,
}: {
  figures: NewsFigure[]
  hasNotes?: boolean
  onPressNotes?: () => void
}) {
  return (
    <View style={styles.wrap}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.rail}>
        {figures.map((figure, i) => (
          <View key={`${i}-${figure.label}`} style={styles.tile}>
            <Text style={[typography.label, styles.label]} numberOfLines={1}>
              {figure.label}
            </Text>
            <Text
              style={[typography.figure, styles.value, figure.emph ? styles.valueEmph : null]}
              numberOfLines={1}
            >
              {figure.value}
            </Text>
            {figure.changeBp !== null ? (
              <Change bp={figure.changeBp} tone="paper" style={styles.change} />
            ) : null}
          </View>
        ))}
      </ScrollView>
      {hasNotes && onPressNotes ? (
        <Pressable onPress={onPressNotes} accessibilityRole="button" hitSlop={8}>
          <Text style={[typography.label, styles.link]}>The dossier ›</Text>
        </Pressable>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: {
    gap: spacing[12],
  },
  rail: {
    gap: spacing[12],
    paddingRight: spacing[8],
  },
  tile: {
    minWidth: 108,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.ink,
    borderRadius: radius.paper,
    padding: spacing[12],
  },
  label: {
    color: colors.inkMuted,
  },
  value: {
    color: colors.ink,
    fontSize: 16,
    marginTop: spacing[4],
  },
  valueEmph: {
    fontSize: 19,
  },
  change: {
    marginTop: spacing[4],
  },
  link: {
    color: colors.ink,
    textDecorationLine: 'underline',
  },
})
