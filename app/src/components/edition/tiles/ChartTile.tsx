import { StyleSheet, Text, View } from 'react-native'
import { space, type } from '../../../theme'
import { TILE_HEAD, TILE_PADDING, type Tile } from '../../../lib/edition/tiles'
import { ChartFigure } from '../ChartFigure'
import { lineHeightOf } from '../metrics'

/** The span line under the plot, read off the token it draws with. */
const CAPTION = lineHeightOf(type.caption)
/** `styles.root`'s gap, counted once for each gap between the children. */
const GAP = space.xs

/**
 * One chart, small: a heading, the drawing, and the span.
 *
 * The drawing itself is `ChartFigure`, which the detail page mounts at full width. A tapped bar
 * chart has to open as a bar chart, and a second `kind` switch here is how it would open as a
 * line — so this file owns the box and the furniture, and nothing about what goes in it.
 *
 * The plot height is the tile's height minus its own furniture, NOT a measurement. Every term
 * subtracted below is a fixed height this file also draws — the heading is `TILE_HEAD`, the same
 * constant `estimateTileHeight` sized the tile with — so the three children add up to exactly
 * what the estimator gave the tile and the span line never falls off the bottom.
 */
export function ChartTile({
  tile,
  width,
  height,
}: {
  tile: Extract<Tile, { kind: 'chart' }>
  width: number
  height: number
}) {
  const { chart } = tile
  const hasSpan = chart.span !== ''
  const plotW = Math.max(1, width - 2 * TILE_PADDING)
  const furniture = 2 * TILE_PADDING + TILE_HEAD + GAP + (hasSpan ? CAPTION + GAP : 0)
  const plotH = Math.max(1, height - furniture)

  return (
    <View style={styles.root}>
      <Text style={styles.head} numberOfLines={1}>
        {chart.label !== '' ? chart.label : 'Chart'}
      </Text>
      <ChartFigure chart={chart} width={plotW} height={plotH} />
      {hasSpan ? (
        <Text style={type.caption} numberOfLines={1}>
          {chart.span}
        </Text>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    gap: GAP,
  },
  head: {
    ...type.headingSm,
    height: TILE_HEAD,
  },
})
