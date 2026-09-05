import { StyleSheet, Text, View } from 'react-native'
import { useStrings } from '../../../i18n'
import { space, type } from '../../../theme'
import { TILE_HEAD, TILE_PADDING, type Tile } from '../../../lib/edition/tiles'
import { ChartFigure } from '../ChartFigure'
import { lineHeightOf } from '../metrics'
import { useEditionType } from '../typeRamp'

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
  const t = useStrings()
  const ty = useEditionType()
  const { chart } = tile
  const hasSpan = chart.span !== ''
  const plotW = Math.max(1, width - 2 * TILE_PADDING)
  const furniture = 2 * TILE_PADDING + TILE_HEAD + GAP + (hasSpan ? CAPTION + GAP : 0)
  const plotH = Math.max(1, height - furniture)

  return (
    <View style={styles.root}>
      {/* SHRINK TO FIT, for the same reason `FiguresTile`'s group head does and nowhere else on
          a tile: this is the PRODUCER's label — "NAND CONTRACT PRICE" — and at 18 px in a 145 pt
          measure it ellipsized to "NAND CONTR…", which names neither the series nor the units the
          plot underneath is drawn in. One line at a floor of 0.8 keeps the head inside `TILE_HEAD`,
          so the plot height this file subtracts from is unchanged. */}
      <Text
        style={[ty.headingSm, styles.head]}
        numberOfLines={1}
        adjustsFontSizeToFit
        minimumFontScale={0.8}
      >
        {chart.label !== '' ? chart.label : t.today.heads.chart}
      </Text>
      <ChartFigure chart={chart} width={plotW} height={plotH} />
      {hasSpan ? (
        <Text style={ty.caption} numberOfLines={1}>
          {chart.span}
        </Text>
      ) : null}
    </View>
  )
}

// The heading's face comes from the edition's ramp in front of this rule — the label is the
// producer's, so on a Korean day it is Korean. See `typeRamp.tsx`.
const styles = StyleSheet.create({
  root: {
    flex: 1,
    gap: GAP,
  },
  head: {
    height: TILE_HEAD,
  },
})
