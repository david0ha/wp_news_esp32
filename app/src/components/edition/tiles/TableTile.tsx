import { StyleSheet, Text, View } from 'react-native'
import { colors, fonts, space, tabular, type } from '../../../theme'
import { type Tile } from '../../../lib/edition/tiles'

/** How many of the trailing columns the tile shows. The detail page shows every one. */
const COLS = 2
const ROWS = 3

/**
 * A statement, cut down to what fits a column: the row labels and the LAST two periods.
 *
 * The last two and not the first two, because the newest quarter is the one being read and a
 * tile that showed 1Q25 and 2Q25 of a six-quarter run would be showing history with the news cut
 * off. Every cell renders verbatim — the producer wrote "(22.1%)" and "9,340", and re-formatting
 * a preformatted cell is how a phone and a sheet come to disagree about a number. The numeric
 * plane beside the cells (`row.n`) is for the detail page's graphics, not for this tile.
 *
 * Nothing here is coloured. A statement cell carries neither a direction nor a series, and the
 * hairline under the column heads is the only rule on the tile.
 */
export function TableTile({
  tile,
}: {
  tile: Extract<Tile, { kind: 'table' }>
  width: number
  height: number
}) {
  const { table } = tile
  const from = Math.max(0, table.columns.length - COLS)
  const columns = table.columns.slice(from)
  return (
    <View style={styles.root}>
      <Text style={styles.head} numberOfLines={2}>
        {table.title !== '' ? table.title : 'Statement'}
      </Text>
      <View style={styles.headRow}>
        <View style={styles.labelCell} />
        {/* Keyed by position as well as label: a statement whose last two columns carry the same
            heading is a producer mistake, not a crash. */}
        {columns.map((c, j) => (
          <Text key={`${c}:${j}`} style={[styles.colHead, tabular]} numberOfLines={1}>
            {c}
          </Text>
        ))}
      </View>
      {table.rows.slice(0, ROWS).map((r, i) => (
        <View key={`${r.label}:${i}`} style={styles.row}>
          <Text style={[type.caption, styles.labelCell]} numberOfLines={1}>
            {r.label}
          </Text>
          {columns.map((c, j) => (
            <Text key={`${c}:${j}`} style={[styles.cell, tabular]} numberOfLines={1}>
              {r.values[from + j] ?? ''}
            </Text>
          ))}
        </View>
      ))}
      {table.note !== '' ? (
        <Text style={styles.note} numberOfLines={2}>
          {table.note}
        </Text>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    gap: 2,
  },
  head: {
    // The one heading a size down from `type.headingSm`, and the one tile exempt from
    // `TILE_HEAD`: a table's height is aspect-derived (`round(colWidth * 5/4)`), not built from
    // the heading constant, and a statement title runs two lines — at 18/24 those two lines
    // would take 48 px of a 213 px tile before a single figure was drawn.
    ...type.headingSm,
    fontSize: 15,
    lineHeight: 19,
  },
  headRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingTop: space.xs,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    paddingBottom: 3,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 4,
  },
  labelCell: {
    flex: 1.2,
  },
  colHead: {
    flex: 1,
    fontFamily: fonts.semibold,
    fontSize: 11,
    color: colors.textDim,
    textAlign: 'right',
  },
  cell: {
    flex: 1,
    fontFamily: fonts.regular,
    fontSize: 12,
    color: colors.text,
    textAlign: 'right',
  },
  note: {
    ...type.caption,
    fontSize: 11,
    // Pushed to the foot of whatever the estimator left over, so the note sits on the bottom
    // edge rather than floating under a short table.
    marginTop: 'auto',
  },
})
