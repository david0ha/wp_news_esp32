import { type ReactNode } from 'react'
import { ScrollView, StyleSheet, Text, View } from 'react-native'
import { Sparkline } from '../../Sparkline'
import { ChartFigure } from '../ChartFigure'
import { PhotoTile } from '../tiles/PhotoTile'
import { Change } from '../Change'
import { toneGraphicsColor } from '../tone'
import { changeTone, formatPrice } from '../../../lib/edition/format'
import { photoBoxHeight } from '../../../lib/edition/feedLayout'
import { type Tile } from '../../../lib/edition/tiles'
import { type Edition, type EditionChart, type EditionPhoto } from '../../../lib/edition/types'
import { colors, fonts, layout, radius, space, tabular, type } from '../../../theme'

/**
 * One tile, opened.
 *
 * Progressive disclosure, borrowed from YouTube's description and Pinterest's closeup: the tile
 * showed a clamped body, four figures of nine, the last two quarters of six. This shows all of
 * it. The SHAPE stays the same so the reader recognises what they tapped — same heading, same
 * order, same drawing, more of it. That is why the story headline keeps `type.pinHeadline`
 * rather than growing into a page title: the tile's headline is what was tapped, and a different
 * face at a different size reads as a different story.
 *
 * NO TEXT IS CLAMPED WITH `numberOfLines`. This page is not the masonry: there is no estimator to
 * agree with, so the copy sets its own length and every text block grows to fit it. What is
 * measured here is only what cannot flex — a photograph and a chart are given a pixel box off the
 * window width, because neither has intrinsic content to be sized by, and the statement's columns
 * are fixed widths so the periods line up under their headings, which is why that grid scrolls
 * sideways rather than shrinking.
 *
 * Colour follows the same two rules as everywhere else. A percentage change takes the text pair,
 * inside the shared `Change`; a drawn line takes the graphics pair through `toneGraphicsColor`;
 * and every other mark on the page — headings, rules, statement cells, the credit under a
 * photograph — is ink.
 */
export function TileDetail({
  tile,
  edition,
  editionKey,
  width,
}: {
  tile: Tile
  edition: Edition
  /**
   * Which edition this is, from `feedLayout.ts`'s `editionKey`. Only the photograph needs it, and
   * it needs it for the same reason the masonry's tiles do: a photo id repeats across editions,
   * so without it React hands a new edition's caption to the old edition's mounted picture.
   */
  editionKey: string
  /** The window's width. The media below is sized in pixels, not flexed, so it needs the number. */
  width: number
}) {
  const contentWidth = width - 2 * layout.gutter

  switch (tile.kind) {
    case 'story': {
      const { story } = tile
      // `parseEdition` has already mapped an out-of-range index to null, so this cannot miss.
      const chart = story.chart !== null ? edition.charts[story.chart] : undefined
      return (
        <View style={styles.root}>
          {story.kicker !== '' ? <Text style={type.caption}>{story.kicker}</Text> : null}
          <Text style={type.pinHeadline}>{story.headline}</Text>
          {story.deck !== '' ? <Text style={styles.deck}>{story.deck}</Text> : null}
          {story.byline !== '' ? <Text style={type.caption}>{story.byline}</Text> : null}
          {story.photo !== null ? (
            <DetailPhoto
              key={`${editionKey}:${story.photo.id}`}
              photo={story.photo}
              width={contentWidth}
            />
          ) : null}
          {chart !== undefined ? <ChartBlock chart={chart} width={contentWidth} /> : null}
          {story.body !== '' ? <Text style={type.body}>{story.body}</Text> : null}
        </View>
      )
    }

    case 'range': {
      const s = tile.subject
      // No `Last` row. The masthead two taps up carries the price at 38 px, and repeating it here
      // as one row among six would make the reader check whether the two numbers agree.
      const has52 = s.wk52High !== null || s.wk52Low !== null
      return (
        <View style={styles.root}>
          <Text style={type.heading}>Range</Text>
          <View>
            <Row label="Previous close" value={formatPrice(s.prevClose)} />
            <Row label="Open" value={formatPrice(s.open)} />
            <Row label="Day high" value={formatPrice(s.high)} />
            <Row label="Day low" value={formatPrice(s.low)} />
            {has52 ? <Row label="52-week high" value={formatPrice(s.wk52High)} /> : null}
            {has52 ? <Row label="52-week low" value={formatPrice(s.wk52Low)} /> : null}
          </View>
        </View>
      )
    }

    case 'chart':
      return (
        <View style={styles.root}>
          <Text style={type.heading}>{tile.chart.label !== '' ? tile.chart.label : 'Chart'}</Text>
          <ChartBlock chart={tile.chart} width={contentWidth} showLabel={false} />
        </View>
      )

    case 'photo':
      return (
        <View style={styles.root}>
          <DetailPhoto
            key={`${editionKey}:${tile.photo.id}`}
            photo={tile.photo}
            width={contentWidth}
          />
        </View>
      )

    case 'figures':
      return (
        <View style={styles.root}>
          <Text style={type.heading}>{tile.group !== '' ? tile.group : 'Figures'}</Text>
          {/* Every figure in the group, where the tile showed four and counted the rest. */}
          <View>
            {tile.figures.map((f, i) => (
              <Row
                key={`${f.label}:${i}`}
                label={f.label}
                value={f.value}
                changePct={f.changePct}
                emph={f.emph}
              />
            ))}
          </View>
        </View>
      )

    case 'briefs':
      return (
        <View style={styles.root}>
          <Text style={type.heading}>Briefs</Text>
          <View style={styles.briefList}>
            {tile.briefs.map((b, i) => (
              <View key={`${b.date}:${i}`} style={styles.brief}>
                {/* Date and kicker at opposite ends of the row, never joined by a middle dot —
                    the same arrangement the tile uses, so the two read as one thing enlarged. */}
                <View style={styles.briefMeta}>
                  {b.date !== '' ? <Text style={type.caption}>{b.date}</Text> : null}
                  {b.kicker !== '' ? <Text style={type.caption}>{b.kicker}</Text> : null}
                </View>
                <Text style={type.body}>{b.text}</Text>
              </View>
            ))}
          </View>
        </View>
      )

    case 'peers':
      return (
        <View style={styles.root}>
          <Text style={type.heading}>Peers</Text>
          <View>
            {tile.peers.map((p) => (
              <QuoteRow
                key={p.symbol}
                symbol={p.symbol}
                name={p.name}
                subject={p.isSubject}
                last={p.last}
                changePct={p.changePct}
                trailing={
                  /* Preformatted by the producer — "22.4x", "$241.6B" — rendered verbatim. */
                  <View style={styles.peerRatios}>
                    <Text style={[type.caption, tabular]}>{p.per}</Text>
                    <Text style={[type.caption, tabular]}>{p.cap}</Text>
                  </View>
                }
              />
            ))}
          </View>
        </View>
      )

    case 'table': {
      const { table } = tile
      return (
        <View style={styles.root}>
          <Text style={type.heading}>{table.title !== '' ? table.title : 'Statement'}</Text>
          {table.note !== '' ? <Text style={type.caption}>{table.note}</Text> : null}
          {/* The whole grid, scrolled sideways rather than cut down to the last two periods the
              tile showed. A statement is the one thing on this page that must never lose a
              column: the periods beside each other ARE the argument. */}
          <View style={styles.gridSurface}>
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              <View>
                <View style={styles.gridHead}>
                  <View style={styles.gridLabel} />
                  {table.columns.map((c, j) => (
                    <Text key={`${c}:${j}`} style={[styles.gridCellHead, tabular]}>
                      {c}
                    </Text>
                  ))}
                </View>
                {table.rows.map((r, i) => (
                  <View key={`${r.label}:${i}`} style={styles.gridRow}>
                    {/* The label WRAPS rather than ellipsizing. The contract caps it at 24
                        characters, which at 13 px sits right on the edge of the 132 px column,
                        so a clamp would cut the longest row names on the one page whose whole
                        job is showing the statement entire. Each row is its own flex row, so a
                        label that takes two lines takes its row with it and the periods stay
                        aligned with their headings. */}
                    <Text style={[type.caption, styles.gridLabel]}>{r.label}</Text>
                    {table.columns.map((c, j) => (
                      <Text key={`${c}:${j}`} style={[styles.gridCell, tabular]}>
                        {r.values[j] ?? ''}
                      </Text>
                    ))}
                  </View>
                ))}
              </View>
            </ScrollView>
          </View>
        </View>
      )
    }

    case 'tape':
      return (
        <View style={styles.root}>
          <Text style={type.heading}>The tape</Text>
          <View>
            {tile.indices.map((ix) => (
              <QuoteRow
                key={ix.symbol}
                symbol={ix.symbol}
                name={ix.name}
                last={ix.last}
                changePct={ix.changePct}
                middle={
                  /* `Sparkline` and not `ChartFigure`, because an index's `spark` is a bare array
                     of closes with no `kind` behind it. `ChartFigure` exists so a tapped BAR chart
                     opens as a bar chart; there is no such choice to get wrong here, and the tape
                     tile draws the same polyline in the same graphics pair. */
                  <Sparkline
                    data={ix.spark}
                    width={72}
                    height={28}
                    stroke={toneGraphicsColor(changeTone(ix.changePct))}
                  />
                }
              />
            ))}
          </View>
        </View>
      )
  }
}

/**
 * A photograph at full width, with its caption and credit underneath.
 *
 * The caption is blanked on the way into `PhotoTile` and drawn below instead. `PhotoTile` floats
 * it over the foot of the picture clamped to two lines, which is right in a 170 px column and
 * wrong here: this page has room for the whole sentence, and a caption both over the picture and
 * under it is the same string twice. The producer's text still renders verbatim, in one place.
 */
function DetailPhoto({ photo, width }: { photo: EditionPhoto; width: number }) {
  return (
    <View style={styles.photoBlock}>
      {/* The rounded frame lives on this wrapper. `PhotoTile` sets no radius of its own — inside
          the masonry it is `EditionTile` that clips it — so a standalone mount has to. */}
      <View style={styles.photoFrame}>
        <PhotoTile
          tile={{ kind: 'photo', id: `detail:${photo.id}`, photo: { ...photo, caption: '' } }}
          width={width}
          height={photoBoxHeight(photo, width)}
        />
      </View>
      {photo.caption !== '' ? <Text style={type.body}>{photo.caption}</Text> : null}
      {photo.credit !== '' ? <Text style={type.caption}>{photo.credit}</Text> : null}
    </View>
  )
}

/**
 * A chart at full width, with its label, span and note as quiet captions under it.
 *
 * `ChartFigure` and never a `Sparkline`: it owns the `kind` switch, so a bar chart tapped in the
 * feed opens here as bars. A second switch written on this page is exactly how it would open as
 * a line instead.
 *
 * `showLabel` is off for the `chart` tile, whose label is already the page's heading; the story's
 * chart keeps it, because there the heading is the headline and the chart is a second object.
 */
function ChartBlock({
  chart,
  width,
  showLabel = true,
}: {
  chart: EditionChart
  width: number
  showLabel?: boolean
}) {
  const plotWidth = Math.max(1, width - 2 * space.md)
  return (
    <View style={styles.chartBlock}>
      {showLabel && chart.label !== '' ? <Text style={styles.chartLabel}>{chart.label}</Text> : null}
      <ChartFigure chart={chart} width={plotWidth} height={Math.round(plotWidth * 0.5)} />
      {chart.span !== '' ? <Text style={type.caption}>{chart.span}</Text> : null}
      {chart.note !== '' ? <Text style={type.caption}>{chart.note}</Text> : null}
    </View>
  )
}

/**
 * ONE ROW FOR A QUOTED THING — a peer, or an index on the tape.
 *
 * They were written twice and were the same row: a symbol over a name, a price with its change
 * beside it, and one slot each. The tape puts a sparkline in the middle and the peers put the
 * producer's ratios on the end, which is the whole difference — so it is two slots rather than
 * two components, because a second copy is how the two came to disagree about a rule that
 * belongs to both.
 *
 * `subject` is the extrabold face on the company the edition is about. That emphasis is WEIGHT
 * and not colour: colour on this page means a direction, and being the subject is not a
 * direction.
 */
function QuoteRow({
  symbol,
  name,
  subject = false,
  last,
  changePct,
  middle = null,
  trailing = null,
}: {
  symbol: string
  name: string
  subject?: boolean
  last: number | null
  changePct: number | null
  /** Between the name and the numbers — the tape's sparkline. */
  middle?: ReactNode
  /** After the numbers — the peers' per and cap. */
  trailing?: ReactNode
}) {
  return (
    <View style={styles.quoteRow}>
      <View style={styles.quoteName}>
        <Text style={subject ? styles.quoteSymbolSubject : styles.quoteSymbol}>{symbol}</Text>
        {name !== '' ? <Text style={type.caption}>{name}</Text> : null}
      </View>
      {middle}
      <View style={styles.quoteNums}>
        <Text style={[styles.value, tabular]}>{formatPrice(last)}</Text>
        <Change pct={changePct} size={13} style={styles.change} />
      </View>
      {trailing}
    </View>
  )
}

/** A label / value line, with an optional change beside it. The rule under it is the separator. */
function Row({
  label,
  value,
  changePct,
  emph = false,
}: {
  label: string
  /** Already formatted — the producer's own string for a figure, `formatPrice` for a price. */
  value: string
  changePct?: number | null
  emph?: boolean
}) {
  return (
    <View style={styles.row}>
      <Text style={[type.caption, styles.rowLabel]}>{label}</Text>
      <Text style={[emph ? styles.valueEmph : styles.value, tabular]}>{value}</Text>
      {changePct !== undefined && changePct !== null ? (
        <Change pct={changePct} size={13} style={styles.change} />
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  root: {
    paddingHorizontal: layout.gutter,
    gap: space.md,
  },
  deck: {
    ...type.body,
    color: colors.textDim,
  },
  // A run of rows is one object, so it sits in a bare wrapper `View` rather than as siblings of
  // the heading: `root`'s 12 px gap belongs BETWEEN objects, and applied between rows it would
  // push every hairline 12 px away from the line it separates. The wrapper needs no style of its
  // own — each row below carries its own padding and its own rule.
  row: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: space.md,
    paddingVertical: space.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  rowLabel: {
    flex: 1,
  },
  value: {
    fontFamily: fonts.semibold,
    fontSize: 15,
    color: colors.text,
  },
  valueEmph: {
    fontFamily: fonts.extrabold,
    fontSize: 17,
    color: colors.text,
  },
  change: {
    minWidth: 68,
    textAlign: 'right',
  },
  photoBlock: {
    gap: space.sm,
  },
  photoFrame: {
    borderRadius: radius.lg,
    overflow: 'hidden',
  },
  // The one list wrapper that does carry a style: a brief is two stacked lines, so its rows need
  // air between them where a label/value row gets enough from its own padding.
  briefList: {
    gap: space.md,
  },
  brief: {
    gap: space.xs,
    paddingBottom: space.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  briefMeta: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  quoteRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: space.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  quoteName: {
    flex: 1,
  },
  quoteSymbol: {
    fontFamily: fonts.medium,
    fontSize: 14,
    color: colors.text,
  },
  quoteSymbolSubject: {
    fontFamily: fonts.extrabold,
    fontSize: 14,
    color: colors.text,
  },
  quoteNums: {
    alignItems: 'flex-end',
  },
  peerRatios: {
    alignItems: 'flex-end',
    width: 68,
  },
  chartBlock: {
    gap: space.xs,
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: space.md,
  },
  chartLabel: {
    ...type.headingSm,
  },
  gridSurface: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: space.md,
  },
  gridHead: {
    flexDirection: 'row',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    paddingBottom: space.xs,
  },
  gridRow: {
    flexDirection: 'row',
    // Top-aligned so a row label that wraps to two lines keeps its figures on the first one,
    // level with every other row's.
    alignItems: 'flex-start',
    paddingVertical: space.xs,
  },
  gridLabel: {
    width: 132,
  },
  gridCellHead: {
    width: 76,
    fontFamily: fonts.semibold,
    fontSize: 12,
    lineHeight: 18,
    color: colors.textDim,
    textAlign: 'right',
  },
  gridCell: {
    width: 76,
    fontFamily: fonts.regular,
    fontSize: 13,
    lineHeight: 18,
    color: colors.text,
    textAlign: 'right',
  },
})
