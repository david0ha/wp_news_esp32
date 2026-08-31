import { StyleSheet, Text, View } from 'react-native'
import { colors, spacing, typography } from '../../theme/index'
import type { NewsStory } from '../../lib/desk'

/**
 * Secondary stories — `stories[1..]`. Already sorted by rank (`desk.ts`'s `parseStories()` does
 * that once, at parse time), so this just renders them in the order it was handed: headline (sm)
 * and deck only, no kicker or body — the lead is the only story that carries those on this tab.
 */
export function MoreStories({ stories }: { stories: NewsStory[] }) {
  return (
    <View style={styles.wrap}>
      {stories.map((story, i) => (
        <View key={`${i}-${story.headline}`}>
          <Text style={[typography.headlineSm, styles.headline]}>{story.headline}</Text>
          {story.deck !== '' ? <Text style={[typography.deck, styles.deck]}>{story.deck}</Text> : null}
        </View>
      ))}
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: {
    gap: spacing[16],
  },
  headline: {
    color: colors.ink,
  },
  deck: {
    color: colors.ink,
    marginTop: spacing[4],
  },
})
