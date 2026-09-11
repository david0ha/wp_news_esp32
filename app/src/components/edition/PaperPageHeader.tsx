import { StyleSheet, Text, View } from 'react-native'
import { Chip } from '../Chip'
import { paperAgeLabel } from '../../lib/papers/order'
import { type Paper } from '../../lib/desk'
import { useStrings } from '../../i18n'
import { colors, fonts, layout, space, tabular } from '../../theme'

/**
 * Which company's paper this page is, above the masthead.
 *
 * It exists because a pager has a problem a single page does not: the masthead names the COMPANY,
 * beautifully, in the edition's own face — and gives the reader nothing to tell them they are on
 * page three of five, nor how old this particular paper is. The board's edition carries its
 * freshness on the masthead; a paper's freshness is a different fact (when the DESK WROTE IT, not
 * when this phone last confirmed it) and belongs beside the symbol.
 *
 * THE APP'S OWN TYPE RAMP, not the edition's. Everything below this row is set in the paper's
 * language through `EditionTypeProvider`; this row is the app talking about the paper, so it takes
 * the app's face the way `tile/[id].tsx`'s "More from this edition" heading does.
 */
export function PaperPageHeader({ paper, now }: { paper: Paper; now: number }) {
  const t = useStrings()
  const age = paperAgeLabel(paper.createdAt, now)

  return (
    <View style={styles.root}>
      <View style={styles.row}>
        <Text style={styles.symbol}>{paper.symbol}</Text>
        {paper.onBoard ? <Chip label={t.papers.page.onBoard} icon="tv" tone="accent" /> : null}
        {/* The DESK's judgement about whether this paper is due a rewrite, carried through rather
            than recomputed: the phone does not know the cadence the desk is pacing at, and a
            second opinion here could contradict the row on the Board tab. */}
        {paper.stale && !paper.onBoard ? (
          <Chip label={t.papers.page.stale} icon="time" tone="warn" />
        ) : null}
      </View>
      <Text style={styles.meta} numberOfLines={1}>
        {[paper.name, age ?? t.papers.page.noAge].filter(Boolean).join(' · ')}
      </Text>
    </View>
  )
}

const styles = StyleSheet.create({
  root: {
    paddingHorizontal: layout.gutter,
    paddingTop: space.md,
    gap: 4,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  symbol: {
    fontFamily: fonts.bold,
    fontSize: 15,
    letterSpacing: 0.5,
    color: colors.textDim,
    ...tabular,
  },
  meta: {
    fontFamily: fonts.regular,
    fontSize: 13,
    color: colors.textFaint,
  },
})
