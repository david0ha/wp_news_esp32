import { StyleSheet, Text, View } from 'react-native'
import { fill, useStrings } from '../../../i18n'
import { colors, fonts, tabular } from '../../../theme'
import {
  TILE_HEAD,
  TILE_MORE,
  FIGURES_LABEL_LINE,
  FIGURES_ROW,
  FIGURES_ROW_GAP,
  FIGURES_SHOWN,
  FIGURES_VALUE_EMPH_SIZE,
  FIGURES_VALUE_LINE,
  FIGURES_VALUE_SIZE,
  type Tile,
} from '../../../lib/edition/tiles'
import { Change } from '../Change'
import { useEditionFace, useEditionType } from '../typeRamp'

/**
 * One group of figures — VALUATION, PER SHARE, THE STREET — as stacked label/value rows.
 *
 * The row height, the two line heights and the count all come from `lib/edition/tiles.ts`, which
 * is also what `estimateTileHeight` sized this tile with. One number, one place.
 *
 * THE LABEL SITS ABOVE THE VALUE, and that is the fix a render forced. Beside it, the two shared
 * the 145 pt of content a 390 pt phone leaves inside a tile, the label was the flexible half, and
 * it ellipsized: "MARKET CAP" came out "MARKET…" and "NET INCOME TTM" came out "NET INCO…". A
 * figure whose label cannot be read is not a figure. Stacked, a 20-character label has the whole
 * measure and needs no ellipsis at any width a phone produces.
 *
 * The emphasised figure keeps its larger extrabold face and the change beside it — that is what
 * makes it the one the group is about. It stacks like the others because its label was the worst
 * clipped of all: beside the widest values in the fixture ("$402–$1,712", and "$1,993.25" with a
 * change after it) the label was left nothing at all.
 *
 * The value is rendered VERBATIM. The producer already formatted it ("$241.6B", "22.38x"), and
 * re-deriving it here would give the phone and the sheet two different-looking answers to the
 * same question. It still gets `tabular`, because a figure that changes tomorrow should not
 * shift the column it sits in.
 */
export function FiguresTile({ tile }: { tile: Extract<Tile, { kind: 'figures' }> }) {
  const t = useStrings()
  const ty = useEditionType()
  const face = useEditionFace()
  const rest = tile.figures.length - FIGURES_SHOWN
  return (
    <View style={styles.root}>
      {/* SHRINK TO FIT, which nothing else on a tile does. This head is the PRODUCER's string —
          "BALANCE SHEET", "PROFITABILITY" — up to twenty uppercase characters at 18 px against a
          145 pt measure, and at that length it ellipsized to "BALANCE SHE…". A group nobody can
          name is the same failure as a figure nobody can name. The app's own sentence-case heads
          ("Range", "Peers", "Briefs", "The tape") are ours and are short by construction, so they
          keep the ramp exactly. The floor is 0.8 — below that the head stops matching the tiles
          beside it — and one line keeps the box at `TILE_HEAD`, so the estimator is untouched.
          iOS honours this; Android ignores it and ellipsizes as before, which is today. */}
      <Text
        style={[ty.headingSm, styles.head]}
        numberOfLines={1}
        adjustsFontSizeToFit
        minimumFontScale={0.8}
      >
        {tile.group !== '' ? tile.group : t.today.heads.figures}
      </Text>
      {tile.figures.slice(0, FIGURES_SHOWN).map((f, i) => (
        <View key={`${f.label}:${i}`} style={styles.row}>
          <Text style={[ty.caption, styles.label]} numberOfLines={1}>
            {f.label}
          </Text>
          <View style={styles.valueRow}>
            {/* THE VALUE TAKES A FACE AND NOT A FAMILY, because it is the producer's own string
                and carries units: a Korean edition's market cap is "578조원", which Inter cannot
                set. Asked for by family it would fall to the system face at regular weight, and
                the emphasised figure — the one the whole group is about — would be the one that
                stopped looking emphasised. */}
            <Text
              style={[
                face(f.emph ? fonts.extrabold : fonts.semibold),
                f.emph ? styles.valueEmph : styles.value,
                tabular,
              ]}
              numberOfLines={1}
            >
              {f.value}
            </Text>
            {f.changePct !== null ? <Change pct={f.changePct} /> : null}
          </View>
        </View>
      ))}
      {rest > 0 ? (
        <Text style={[face(fonts.semibold), styles.more]}>
          {fill(t.today.andMore, { n: String(rest) })}
        </Text>
      ) : null}
    </View>
  )
}

// The faces come from the edition's ramp in front of these rules (`typeRamp.tsx`). The sizes and
// the line boxes stay here, because they are what `tiles.ts` sized the tile with.
const styles = StyleSheet.create({
  root: { flex: 1 },
  head: {
    height: TILE_HEAD,
  },
  row: {
    height: FIGURES_ROW,
    gap: FIGURES_ROW_GAP,
  },
  label: {
    // Given as a height so the row's two blocks add up to FIGURES_ROW exactly, rather than to
    // whatever the face happens to measure — the rule every other fixed-furniture tile follows.
    height: FIGURES_LABEL_LINE,
  },
  valueRow: {
    flexDirection: 'row',
    // Baseline and not centre: the change is a size down from the value beside it, and centring
    // would float it off the figure's own baseline.
    alignItems: 'baseline',
    gap: 6,
  },
  // Both sizes come from `tiles.ts`, beside the line box they draw inside. A size typed here
  // instead would be a face the row's arithmetic knows nothing about.
  value: {
    fontSize: FIGURES_VALUE_SIZE,
    lineHeight: FIGURES_VALUE_LINE,
    color: colors.text,
  },
  valueEmph: {
    fontSize: FIGURES_VALUE_EMPH_SIZE,
    lineHeight: FIGURES_VALUE_LINE,
    color: colors.text,
  },
  more: {
    fontSize: 12,
    // The estimator adds exactly this for the "+N more" line; it is not a look choice.
    lineHeight: TILE_MORE,
    color: colors.accent,
  },
})
