import { StyleSheet, Text, View } from 'react-native'
import { colors, fonts, space, tabular, type } from '../../../theme'
import {
  TABLE_GAP,
  TABLE_HEAD_ROW_H,
  TABLE_NOTE_LINE,
  TABLE_NOTE_LINES,
  TABLE_ROW_H,
  TABLE_ROWS,
  TABLE_TILE_COLS,
  TABLE_TITLE_LINE,
  TABLE_TITLE_LINES,
  type Tile,
} from '../../../lib/edition/tiles'

/**
 * A statement, cut down to what fits a column: the row labels and the LAST period.
 *
 * The last and not the first, because the newest quarter is the one being read and a tile that
 * showed 1Q25 of a six-quarter run would be showing history with the news cut off. How many
 * periods that is — `TABLE_TILE_COLS` — is a question about the LABEL: at two of them the labels
 * were the flexible half of a 145 pt content box and came out "Net in…", "Consu…", and a
 * statement row nobody can name is not a statement. Every cell renders verbatim — the producer
 * wrote "(22.1%)" and "9,340", and re-formatting a preformatted cell is how a phone and a sheet
 * come to disagree about a number. The numeric plane beside the cells (`row.n`) is parsed but drawn
 * by NOTHING on this app today — neither this tile nor the detail page reads it. It is there
 * because the wire carries it and the board plots from it; the phone has no graphic that needs it
 * yet.
 *
 * Nothing here is coloured. A statement cell carries neither a direction nor a series, and the
 * hairline under the column heads is the only rule on the tile.
 *
 * THE VERTICAL SUM, as `RangeTile` keeps its own: this body is fixed furniture, so every block it
 * draws is one of `tiles.ts`'s constants, IMPORTED — the heights, the row counts and the two
 * `numberOfLines` alike — and the same terms `estimateTileHeight` floors this kind at. Both text
 * rows carry EXPLICIT line heights, because a sum built on a font's intrinsic metrics is a sum
 * nobody can check.
 *
 *   title       2 lines of 19                                       = 38
 *   head row    4 + a 14 px head line + 3 + the hairline             = 22
 *   rows        3 of 23                                             = 69
 *   note        2 lines of 18                                       = 36
 *   gaps        five 2 px gaps between six children                 = 10
 *                                                                    ----
 *                                                                     175 + 2*14 padding = 203
 */
export function TableTile({ tile }: { tile: Extract<Tile, { kind: 'table' }> }) {
  const { table } = tile
  const from = Math.max(0, table.columns.length - TABLE_TILE_COLS)
  const columns = table.columns.slice(from)
  return (
    <View style={styles.root}>
      <Text style={styles.head} numberOfLines={TABLE_TITLE_LINES}>
        {table.title !== '' ? table.title : 'Statement'}
      </Text>
      <View style={styles.headRow}>
        <View style={styles.labelCell} />
        {/* Keyed by position as well as label: a statement whose trailing columns carry the same
            heading is a producer mistake, not a crash. */}
        {columns.map((c, j) => (
          <Text key={`${c}:${j}`} style={[styles.colHead, tabular]} numberOfLines={1}>
            {c}
          </Text>
        ))}
      </View>
      {table.rows.slice(0, TABLE_ROWS).map((r, i) => (
        <View key={`${r.label}:${i}`} style={styles.row}>
          <Text style={[type.caption, styles.labelCell]} numberOfLines={1}>
            {r.label}
          </Text>
          {/* `from + j`, never `j`. `columns` was sliced down to the trailing periods, but a
              row's `values` stay positional against the FULL column list the parser built — so
              indexing by the sliced position would print the OLDEST figure under the newest
              heading, which is a wrong number that looks like a right one. */}
          {columns.map((c, j) => (
            <Text key={`${c}:${j}`} style={[styles.cell, tabular]} numberOfLines={1}>
              {r.values[from + j] ?? ''}
            </Text>
          ))}
        </View>
      ))}
      {table.note !== '' ? (
        <Text style={styles.note} numberOfLines={TABLE_NOTE_LINES}>
          {table.note}
        </Text>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    gap: TABLE_GAP,
  },
  head: {
    // A heading a size down from `type.headingSm`, and the one tile that does not draw a
    // `TILE_HEAD` line: a statement title runs two lines, and at 18/24 those two would take 48 px
    // of a 213 px tile before a single figure was drawn. It is not exempt from the arithmetic —
    // `estimateTileHeight` reserves `TABLE_TITLE_LINE * TABLE_TITLE_LINES` for exactly this box.
    ...type.headingSm,
    fontSize: 15,
    lineHeight: TABLE_TITLE_LINE,
  },
  headRow: {
    flexDirection: 'row',
    alignItems: 'center',
    // Given as a height rather than left to 4 + the head line + 3 + a hairline to add up on their
    // own, so the row the estimator reserved and the row this draws are the same number — the
    // rule every other block on this tile already follows.
    height: TABLE_HEAD_ROW_H,
    paddingTop: space.xs,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    paddingBottom: 3,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    // 4 + 15 + 4 = TABLE_ROW_H. Given as a height rather than left to the cell's own metrics, so
    // the estimator's row and the row this draws are the same number.
    height: TABLE_ROW_H,
    paddingVertical: space.xs,
  },
  labelCell: {
    flex: 1.2,
  },
  colHead: {
    flex: 1,
    fontFamily: fonts.semibold,
    fontSize: 11,
    lineHeight: 14,
    color: colors.textDim,
    textAlign: 'right',
  },
  cell: {
    flex: 1,
    fontFamily: fonts.regular,
    fontSize: 12,
    lineHeight: 15,
    color: colors.text,
    textAlign: 'right',
  },
  note: {
    ...type.caption,
    fontSize: 11,
    lineHeight: TABLE_NOTE_LINE,
    // Pushed to the foot of whatever the estimator left over, so the note sits on the bottom
    // edge rather than floating under a short table.
    marginTop: 'auto',
  },
})
