import { StyleSheet, Text, View } from 'react-native'
import { colors, type } from '../../../theme'
import { type Tile } from '../../../lib/edition/tiles'
import { HEADLINE_LINE, HEADLINE_SIZE, STORY_GAP, storyLines } from './story'

/**
 * A story, with no picture — TYPE IS THE IMAGE here. Every headline draws in the same extrabold
 * 17/21, lead and secondary alike; what makes the lead the lead is that its tile is half again as
 * tall as it is wide, so five lines of headline, a deck and several legs of body all fit inside
 * it. It carried a 22/26 face until a render showed the one thing that arrangement could not do:
 * hold a 57-character headline at a 145 pt measure without ellipsizing it mid-sentence, on the
 * one story where losing the end of the sentence costs most.
 *
 * The kicker renders exactly as the producer wrote it, in `type.caption` and in sentence case —
 * it is CONTENT. It is not `type.label`: an all-caps eyebrow on every tile is one of the five
 * anti-patterns this design names, and it makes a feed look like a settings screen.
 *
 * EVERY CLAMP HERE IS DERIVED, NONE IS FIXED. `storyLines` divides the height the estimator handed
 * this tile among the kicker, the headline, the deck and the body, in that priority order. A
 * constant asks for more lines than the box holds, and because Yoga gives a `flex: 1` child the
 * leftover with no minimum, the surplus is sliced horizontally by the tile's `overflow: 'hidden'` —
 * with the ellipsis that should have signalled it stranded on a line nobody sees. Deriving it also
 * means the estimator's height formula can be retuned without this file being touched.
 */
export function StoryTile({
  tile,
  height,
}: {
  tile: Extract<Tile, { kind: 'story' }>
  height: number
}) {
  const { story, lead } = tile
  const lines = storyLines(height, {
    lead,
    hasKicker: story.kicker !== '',
    hasDeck: story.deck !== '',
  })

  return (
    <View style={styles.root}>
      {lines.kicker > 0 ? (
        <Text style={type.caption} numberOfLines={lines.kicker}>
          {story.kicker}
        </Text>
      ) : null}
      <Text style={styles.headline} numberOfLines={lines.headline}>
        {story.headline}
      </Text>
      {lines.deck > 0 ? (
        <Text style={type.pinDeck} numberOfLines={lines.deck}>
          {story.deck}
        </Text>
      ) : null}
      {/* `flex: 1` lets the copy take exactly what the parts above it left, so the column fills
          instead of ending in white paper. A secondary story reaches this too, whenever its own
          arithmetic leaves room — the room, not the rank, is what decides. */}
      {story.body !== '' && lines.body > 0 ? (
        <Text style={styles.body} numberOfLines={lines.body}>
          {story.body}
        </Text>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    gap: STORY_GAP,
  },
  headline: {
    // `type.pinHeadline`'s extrabold cut and colour, a size down — the token itself is 22/26 and
    // is now the detail page's headline alone. The tracking loosens with the size.
    ...type.pinHeadline,
    fontSize: HEADLINE_SIZE,
    lineHeight: HEADLINE_LINE,
    letterSpacing: -0.2,
  },
  body: {
    ...type.caption,
    flex: 1,
    color: colors.textDim,
  },
})
