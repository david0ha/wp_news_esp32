import { useRef } from 'react'
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
 */
export function EditionTile({
  tile,
  width,
  height,
  newsUrl,
  onPress,
}: {
  tile: Tile
  width: number
  height: number
  /** For PhotoTile, which resolves its own bytes beside the payload. */
  newsUrl: string
  onPress: () => void
}) {
  // RN core Animated on the native driver — the spec forbids reanimated, and a transform-only
  // scale is exactly what the native driver does well.
  const scale = useRef(new Animated.Value(1)).current
  const to = (toValue: number) =>
    Animated.timing(scale, { toValue, duration: 150, useNativeDriver: true }).start()

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={tileLabel(tile)}
      onPressIn={() => to(0.97)}
      onPressOut={() => to(1)}
      onPress={onPress}
    >
      <Animated.View
        style={[
          styles.tile,
          // A photograph fills its tile edge to edge, so this kind gets no padding at all. The
          // alternative — the body cancelling the padding with a negative margin — only works
          // inside this component, and Task 9 mounts `PhotoTile` standalone for the band.
          tile.kind === 'photo' ? null : styles.padded,
          { width, height, transform: [{ scale }] },
        ]}
      >
        {body(tile, width, height, newsUrl)}
      </Animated.View>
    </Pressable>
  )
}

/**
 * Every body is handed the tile's OUTER box, not the padded content box, and subtracts
 * `TILE_PADDING` itself where it needs a pixel figure (`ChartTile`'s plot). One rule for all nine
 * beats a second set of dimensions that would be right for eight of them and wrong for the
 * photograph, which has no padding to subtract.
 */
function body(tile: Tile, width: number, height: number, newsUrl: string) {
  switch (tile.kind) {
    case 'story':
      return <StoryTile tile={tile} width={width} height={height} />
    case 'range':
      return <RangeTile tile={tile} width={width} height={height} />
    case 'chart':
      return <ChartTile tile={tile} width={width} height={height} />
    case 'photo':
      return <PhotoTile tile={tile} width={width} height={height} newsUrl={newsUrl} />
    case 'figures':
      return <FiguresTile tile={tile} width={width} height={height} />
    case 'briefs':
      return <BriefsTile tile={tile} width={width} height={height} />
    case 'peers':
      return <PeersTile tile={tile} width={width} height={height} />
    case 'table':
      return <TableTile tile={tile} width={width} height={height} />
    case 'tape':
      return <TapeTile tile={tile} width={width} height={height} />
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
