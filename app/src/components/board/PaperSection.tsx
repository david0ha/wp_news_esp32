import { useCallback, useState } from 'react'
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useFocusEffect } from 'expo-router'
import { Card } from '../Card'
import { createDeskClient, type Paper } from '../../lib/desk'
import { getDeskToken } from '../../lib/deskToken'
import { getDeskBaseUrl } from '../../lib/store'
import { markEditionStale } from '../../lib/edition/invalidate'
import { loadPapers, usePapers } from '../../lib/papers/list'
import { isPaperRowDisabled, orderPapers, paperAgeLabel } from '../../lib/papers/order'
import { runPaperPublish } from '../../lib/papers/publish'
import { fill, useStrings } from '../../i18n'
import { colors, fonts, layout, space, tabular } from '../../theme'

/**
 * Every company's current paper, and which one is on the glass.
 *
 * It is the Board tab's only section that does not talk to the board. The desk owns which edition
 * is `current`; the board polls and prints whatever that is. So a tap here is a desk call, and the
 * board is told afterwards only so the glass catches up now rather than at its next interval —
 * `runPaperPublish` holds that order and its argument.
 *
 * DRAWS NOTHING WITHOUT A DESK. Not an empty card: `usePapers` answers `ready: false` for a phone
 * with no address or no token, and a "no papers yet" card on the Board tab of a phone that has
 * never heard of a desk is an explanation of a feature nobody asked about.
 */
export function PaperSection({ pollBoard }: { pollBoard: (() => Promise<void>) | null }) {
  const t = useStrings()
  const { ready, doc } = usePapers()
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<{ tone: 'ok' | 'error'; message: string } | null>(null)

  // The list rides this tab's focus as well as Today's. `loadPapers` reads its own throttle, so
  // the second caller costs one storage read inside the window.
  useFocusEffect(
    useCallback(() => {
      void loadPapers()
    }, []),
  )

  const publish = useCallback(
    async (paper: Paper) => {
      if (busy !== null) return
      const [address, token] = await Promise.all([getDeskBaseUrl(), getDeskToken()])
      if (!address || !token) return
      setBusy(paper.symbol)
      setNote(null)
      const result = await runPaperPublish(paper.symbol, {
        client: createDeskClient({ baseUrl: address, token }),
        invalidate: markEditionStale,
        reloadPapers: loadPapers,
        pollBoard,
      })
      setBusy(null)
      if (result.kind === 'published') {
        setNote({ tone: 'ok', message: fill(t.papers.board.published, { symbol: paper.symbol }) })
      } else if (result.kind === 'no_paper') {
        setNote({ tone: 'error', message: fill(t.papers.board.gone, { symbol: paper.symbol }) })
      } else {
        setNote({ tone: 'error', message: fill(t.papers.board.failed, { detail: result.error }) })
      }
    },
    [busy, pollBoard, t],
  )

  const confirm = useCallback(
    (paper: Paper) => {
      // A CONFIRMATION, because this spends twenty-five seconds of a panel that has no partial
      // refresh — the one cost in this app that is measured in half-minutes of hardware rather
      // than in a request. `Alert` is the platform's own and the first in this app; there is no
      // in-app dialog to reuse, and inventing one for a single yes/no would be a component with
      // no second caller.
      Alert.alert(
        fill(t.papers.board.confirmTitle, { symbol: paper.symbol }),
        t.papers.board.confirmBody,
        [
          { text: t.papers.board.cancel, style: 'cancel' },
          { text: t.papers.board.confirm, onPress: () => void publish(paper) },
        ],
      )
    },
    [publish, t],
  )

  if (ready !== true || doc === null) return null
  const papers = orderPapers(doc)
  if (papers.length === 0) return null

  const now = Date.now()

  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{t.papers.board.title}</Text>
      <Card style={styles.rows}>
        {papers.map((paper, i) => {
          const age = paperAgeLabel(paper.createdAt, now)
          const none = paper.editionId === null
          const disabled = isPaperRowDisabled(paper, busy)
          return (
            <Pressable
              key={paper.symbol}
              accessibilityRole="button"
              accessibilityState={{ disabled, selected: paper.onBoard }}
              accessibilityLabel={fill(
                paper.onBoard ? t.papers.board.a11y.onBoard : t.papers.board.a11y.row,
                { name: paper.name || paper.symbol, age: age ?? '' },
              )}
              // A row with no paper is DRAWN AND DEAD. Dropping it would make a company that is on
              // the owner's watchlist absent from a list titled after their watchlist.
              disabled={disabled}
              onPress={() => confirm(paper)}
              style={[styles.row, i < papers.length - 1 && styles.bordered]}
            >
              <View style={styles.rowText}>
                <Text style={styles.symbol}>{paper.symbol}</Text>
                <Text style={styles.meta} numberOfLines={1}>
                  {none ? t.papers.board.noPaper : [paper.name, age].filter(Boolean).join(' · ')}
                </Text>
              </View>
              {paper.onBoard ? (
                <Ionicons name="checkmark-circle" size={20} color={colors.accent} />
              ) : null}
            </Pressable>
          )
        })}
      </Card>
      <Text style={styles.note}>{t.papers.board.help}</Text>
      {note !== null ? (
        <Text style={[styles.note, note.tone === 'error' && styles.error]}>{note.message}</Text>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  section: { paddingHorizontal: layout.gutter, paddingTop: space.xl, gap: space.sm },
  sectionTitle: { fontFamily: fonts.bold, fontSize: 13, letterSpacing: 0.8, color: colors.textDim },
  rows: { paddingVertical: 0 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    gap: space.sm,
  },
  bordered: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  rowText: { flexShrink: 1, gap: 2 },
  symbol: { fontFamily: fonts.semibold, fontSize: 15, color: colors.text, ...tabular },
  meta: { fontFamily: fonts.regular, fontSize: 13, color: colors.textFaint },
  note: { fontFamily: fonts.regular, fontSize: 13, color: colors.textFaint },
  error: { color: colors.down },
})
