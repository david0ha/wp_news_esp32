import { StyleSheet, Text, View, type ViewStyle } from 'react-native'
import { colors, spacing, typography } from '../../theme/index'
import type { NewsStory } from '../../lib/desk'

/**
 * The lead — `stories[0]`, the only story this tab treats as the front-page centrepiece: kicker,
 * headline, byline, an italic deck when the producer filed one, then the full body. Everything
 * here is a paper face on paper — the caller renders this inside a `<Sheet>`.
 */
export function LeadStory({ story, style }: { story: NewsStory; style?: ViewStyle }) {
  return (
    <View style={style}>
      {story.kicker !== '' ? <Text style={[typography.label, styles.kicker]}>{story.kicker}</Text> : null}
      <Text style={[typography.headline, styles.headline]}>{story.headline}</Text>
      {story.byline !== '' ? <Text style={[typography.label, styles.byline]}>{story.byline}</Text> : null}
      {story.deck !== '' ? <Text style={[typography.deck, styles.deck]}>{story.deck}</Text> : null}
      {story.body !== '' ? <Text style={[typography.body, styles.body]}>{story.body}</Text> : null}
    </View>
  )
}

const styles = StyleSheet.create({
  kicker: {
    color: colors.ink,
    marginBottom: spacing[4],
  },
  headline: {
    color: colors.ink,
  },
  byline: {
    color: colors.inkMuted,
    marginTop: spacing[8],
  },
  deck: {
    color: colors.ink,
    marginTop: spacing[8],
  },
  body: {
    color: colors.ink,
    marginTop: spacing[12],
  },
})
