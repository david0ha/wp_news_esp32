import { StyleSheet, View } from 'react-native'
import { EditionTile } from './EditionTile'
import { splitColumns, type Tile } from '../../lib/edition/tiles'

/**
 * Two columns inside one ScrollView, filled shortest-first.
 *
 * Hand-rolled, because `FlatList numColumns` aligns rows — it cannot stagger, which is the whole
 * point — and FlashList is a dependency this app does not take. There is nothing to virtualise:
 * an edition is five to fifteen tiles, and every height is known before the first frame, so the
 * whole page can be laid out in one pass with no measurement and no reflow.
 *
 * The placement itself is `splitColumns`, which is pure and tested. This component only turns
 * the two arrays it returns into two `View`s.
 *
 * EVERY TILE IS KEYED BY THE EDITION AS WELL AS BY ITS OWN ID. A tile id is the producer's and
 * repeats across days — `photo:0` is `photo:0` every edition — so an id alone tells React that
 * tomorrow's tile is the same component as today's, and it reuses the mount. For a text tile that
 * is merely efficient; for a `PhotoTile`, whose effect keys on the tile URL and the geometry,
 * both of which repeat too, it means the picture never re-fetches and today's caption lands over
 * yesterday's photograph. `editionKey` is what makes the swap a remount.
 */
export function Masonry({
  tiles,
  colWidth,
  newsUrl,
  editionKey,
  gutter = 12,
  columns = 2,
  onPress,
}: {
  tiles: Tile[]
  colWidth: number
  newsUrl: string
  /** Which edition these tiles came out of — `lib/edition/feedLayout.ts`'s `editionKey`. */
  editionKey: string
  gutter?: number
  columns?: number
  onPress: (t: Tile) => void
}) {
  const placed = splitColumns(tiles, colWidth, columns)
  return (
    <View style={[styles.row, { gap: gutter }]}>
      {placed.map((column, i) => (
        <View key={i} style={[styles.column, { width: colWidth, gap: gutter }]}>
          {column.map((p) => (
            <EditionTile
              key={`${editionKey}:${p.tile.id}`}
              tile={p.tile}
              width={colWidth}
              height={p.height}
              newsUrl={newsUrl}
              onPress={() => onPress(p.tile)}
            />
          ))}
        </View>
      ))}
    </View>
  )
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    // Top-aligned, never stretched: a column shorter than its neighbour must stay short rather
    // than have its last tile grow, which would break the height the estimator promised.
    alignItems: 'flex-start',
  },
  column: {
    flexDirection: 'column',
  },
})
