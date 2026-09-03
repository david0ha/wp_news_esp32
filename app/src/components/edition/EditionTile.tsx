import { memo, useRef } from 'react'
import { Animated, Pressable, StyleSheet } from 'react-native'
import { colors, radius } from '../../theme'
import { TILE_PADDING, type Tile } from '../../lib/edition/tiles'
import { StoryTile } from './tiles/StoryTile'
import { RangeTile } from './tiles/RangeTile'
import { ChartTile } from './tiles/ChartTile'
import { PhotoTile } from './tiles/PhotoTile'
import { FiguresTile } from './tiles/FiguresTile'
import { BriefsTile } from './tiles/BriefsTile'
import { PeersTile } from './tiles/PeersTile'
import { TableTile } from './tiles/TableTile'
import { TapeTile } from './tiles/TapeTile'

/**
 * One tile: the surface, the radius, the press feedback, and a switch to the body for its kind.
 *
 * NO BORDER, NO SHADOW, NO GRADIENT. The separation is the lavender canvas behind the white
 * surface, which is already a clear edge; a stroke or a lift on top of it is the "card" reflex
 * this design is specifically not, and at two columns of five to fifteen tiles it turns a page
 * into a pile of receipts. (This is why the tile does not reuse `Card`, which owns the hairline
 * border and the optional shadow.)
 *
 * The height comes in as a prop and is never measured. `estimateTileHeight` decided it before
 * anything rendered, which is what stops the page reflowing and what lets a return from the
 * detail land on the same scroll position.
 *
 * MEMOISED, AND `onPress` TAKES THE TILE. The screen above the masonry owns the refresh spinner,
 * the chip row and the freshness line, so it re-renders on things no tile can see — and without
 * the memo each of those re-rendered every SVG chart and every decoded photograph on the page.
 * The memo only holds if the props are stable, which is why the press handler arrives as the
 * feed's one tile-taking callback rather than as a closure built per tile per render.
 */
export const EditionTile = memo(function EditionTile({
  tile,
  width,
  height,
  onPress,
}: {
  tile: Tile
  width: number
  height: number
  onPress: (t: Tile) => void
}) {
  // A SCALE, AND NOT A HIGHLIGHT. A tile carries no border and no shadow, so the usual press
  // feedback — darkening the surface — is a white card going faintly grey on a lavender canvas:
  // nearly invisible, and read as a rendering glitch on the occasions it is seen. 0.97 over
  // 150 ms is small enough not to be an animation and large enough to say the tap landed.
  //
  // RN core `Animated` on the native driver: the spec forbids reanimated, and a transform-only
  // scale is exactly what the native driver does without waking the JS thread.
  const scale = useRef(new Animated.Value(1)).current
  const to = (toValue: number) =>
    Animated.timing(scale, { toValue, duration: 150, useNativeDriver: true }).start()

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={tileLabel(tile)}
      onPressIn={() => to(0.97)}
      onPressOut={() => to(1)}
      onPress={() => onPress(tile)}
    >
      <Animated.View
        style={[
          styles.tile,
          // A photograph fills its tile edge to edge, so this kind gets no padding at all. The
          // alternative — the body cancelling the padding with a negative margin — only works
          // inside this component, and `PhotoTile` is also mounted outside it: the Today tab's
          // full-width band and the detail page's picture both build one without this switch.
          tile.kind === 'photo' ? null : styles.padded,
          { width, height, transform: [{ scale }] },
        ]}
      >
        {body(tile, width, height)}
      </Animated.View>
    </Pressable>
  )
})

/**
 * Three kinds do their own arithmetic and are handed the dimensions they use — `StoryTile` the
 * height alone, because it divides it between the kicker, headline, deck and body and never asks
 * how wide the column is; `ChartTile` and `PhotoTile` both, because each sizes a box in two
 * directions.
 *
 * WHAT THEY GET IS THE TILE'S OUTER BOX, not the padded content box, and each subtracts
 * `TILE_PADDING` itself where it needs a pixel figure (`storyLines`, `ChartTile`'s plot). One
 * rule for the three beats a pre-padded second set of numbers that would be right for two of them
 * and wrong for the photograph, which has no padding to subtract.
 *
 * The other six take the tile alone. Their bodies are rows and headings whose heights are
 * `tiles.ts`'s constants — the same ones `estimateTileHeight` sized the box with — so the box's
 * own pixels are a number they must NOT read: a body that measured would be a second opinion
 * about a height the estimator has already decided.
 */
function body(tile: Tile, width: number, height: number) {
  switch (tile.kind) {
    case 'story':
      return <StoryTile tile={tile} height={height} />
    case 'range':
      return <RangeTile tile={tile} />
    case 'chart':
      return <ChartTile tile={tile} width={width} height={height} />
    case 'photo':
      return <PhotoTile tile={tile} width={width} height={height} />
    case 'figures':
      return <FiguresTile tile={tile} />
    case 'briefs':
      return <BriefsTile tile={tile} />
    case 'peers':
      return <PeersTile tile={tile} />
    case 'table':
      return <TableTile tile={tile} />
    case 'tape':
      return <TapeTile tile={tile} />
  }
}

/**
 * What a screen reader says for a tile. It names the content, not the shape: "Chart, PRICE, 6M"
 * rather than "chart tile", because the reader is choosing between tiles and the kind alone does
 * not distinguish two of them.
 */
export function tileLabel(t: Tile): string {
  switch (t.kind) {
    case 'story':
      return t.story.headline
    case 'range':
      return `Range for ${t.subject.symbol}`
    case 'chart':
      return `Chart, ${t.chart.label}, ${t.chart.span}`
    case 'photo':
      return t.photo.caption !== '' ? `Photograph. ${t.photo.caption}` : 'Photograph'
    case 'figures':
      return `${t.group === '' ? 'Figures' : t.group}, ${t.figures.length} figures`
    case 'briefs':
      return `${t.briefs.length} briefs`
    case 'peers':
      return `${t.peers.length} peers`
    case 'table':
      return t.table.title
    case 'tape':
      return 'The tape'
  }
}

const styles = StyleSheet.create({
  tile: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    // Clips a photo and a long body to the radius; also stops a mis-estimated height from
    // spilling one tile's last line over the tile below it.
    overflow: 'hidden',
  },
  padded: {
    padding: TILE_PADDING,
  },
})
