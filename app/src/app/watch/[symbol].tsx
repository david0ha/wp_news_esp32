import { useState } from 'react'
import { ScrollView, StyleSheet, Text, View } from 'react-native'
import { Stack, useLocalSearchParams, useRouter } from 'expo-router'
import * as Haptics from 'expo-haptics'
import { Screen } from '../../components/Screen'
import { Sheet } from '../../components/Sheet'
import { Standing } from '../../components/Standing'
import { GradeDisc } from '../../components/GradeDisc'
import { Change } from '../../components/Change'
import { Stamp } from '../../components/Stamp'
import { Button } from '../../components/Button'
import { EmptyState } from '../../components/EmptyState'
import { ScreenMessage } from '../../components/ScreenMessage'
import { Markdown } from '../../components/Markdown'
import { Sparkline } from '../../components/watch/Sparkline'
import { useDeskClient, useOrderEdition, useQuotes, useResearch, useWatchlist } from '../../lib/queries'
import { DeskError, deskHumanError } from '../../lib/desk'
import { formatCents, formatPrintedDate } from '../../lib/format'
import { thesisBlocks } from '../../lib/watchlist'
import { colors, spacing, typography } from '../../theme/index'

/**
 * One company off the watchlist, in full — the grade and every reason behind it, the sparkline and
 * last quote when the desk has one, the whole thesis note, and the dates the vault has filed
 * against it (plan Design > Wireframes). Reached only from a `WatchRow` tap or a deep link; there
 * is no tab of its own, so the back control is the platform's native one rather than this app's
 * usual hand-built chrome header.
 *
 * The two action buttons ask the desk for something — they do not change the watchlist itself,
 * which stays read-only here exactly as it is on the tab (the vault owns it, `desk.ts`'s
 * `getWatchlist()` has no matching `put`).
 *
 * `WatchlistItem.events` is dates only, not the "AUG 20 · guidance cut" pairing the wireframe
 * sketch shows — the wire has nothing to pair a date with, so this renders exactly what it carries.
 */
export default function WatchDetail() {
  const router = useRouter()
  const params = useLocalSearchParams<{ symbol: string }>()
  const symbol = (params.symbol ?? '').toUpperCase()

  const client = useDeskClient()
  const watchlist = useWatchlist()
  const item = watchlist.data?.items.find((i) => i.symbol === symbol)

  // Only asked for once the item is known to exist — a symbol that isn't on the list has no quote
  // worth fetching, and useQuotes' own `enabled` already treats an empty array as "don't ask".
  const quotes = useQuotes(item ? [item.symbol] : [])
  const quote = item ? quotes.data?.quotes[item.symbol] : undefined

  const research = useResearch()
  const orderEdition = useOrderEdition()
  const [researchQueued, setResearchQueued] = useState(false)
  const [editionQueued, setEditionQueued] = useState(false)

  const onResearch = () => {
    if (!item) return
    research.mutate(
      { text: `Research ${item.symbol}.` },
      {
        onSuccess: () => {
          setResearchQueued(true)
          void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)
        },
      },
    )
  }
  const onOrderEdition = () => {
    if (!item) return
    orderEdition.mutate(
      { text: `File a fresh edition on ${item.symbol}.` },
      {
        onSuccess: () => {
          setEditionQueued(true)
          void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)
        },
      },
    )
  }

  const title = item?.name || symbol

  if (client === null) {
    return (
      <Screen edges={['top']}>
        <Stack.Screen options={{ title }} />
        <EmptyState
          title="No desk yet"
          body="Add its address and operator token in Settings, and this company can be looked up."
          actionLabel="Open settings"
          onAction={() => router.push('/settings')}
        />
      </Screen>
    )
  }

  return (
    <Screen edges={['top']}>
      <Stack.Screen options={{ title }} />

      {watchlist.isLoading ? (
        <ScreenMessage loading />
      ) : watchlist.isError ? (
        <ScreenMessage
          error={
            watchlist.error instanceof DeskError
              ? deskHumanError(watchlist.error)
              : 'Couldn’t load the watchlist.'
          }
          onRetry={() => watchlist.refetch()}
        />
      ) : !item ? (
        <View style={styles.scroll}>
          <Sheet style={styles.sheet}>
            <Text style={[typography.label, styles.symbol]}>{symbol}</Text>
            <Text style={[typography.body, styles.missing]}>{symbol} isn’t on the watchlist.</Text>
          </Sheet>
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.scroll}>
          <Sheet style={styles.sheet}>
            <Text style={[typography.label, styles.symbol]}>{item.symbol}</Text>
            <Text style={[typography.headlineSm, styles.name]}>{item.name}</Text>

            <View style={styles.gradeRow}>
              <GradeDisc grade={item.grade} size={18} />
              {item.reasons.length > 0 ? (
                <View style={styles.reasons}>
                  {item.reasons.map((reason, i) => (
                    <Text key={i} style={[typography.deck, styles.reason]}>
                      {reason}
                    </Text>
                  ))}
                </View>
              ) : null}
            </View>

            {quote ? (
              <View style={styles.quoteRow}>
                <Sparkline values={quote.bars.map((b) => b.c)} />
                <View style={styles.priceCol}>
                  <Text style={[typography.figure, styles.last]}>{formatCents(quote.lastCents)}</Text>
                  <Change bp={quote.changeBp} tone="paper" />
                </View>
              </View>
            ) : null}

            <View style={styles.section}>
              <Standing label="Thesis" tone="paper" />
              {item.note !== '' ? (
                <Markdown blocks={thesisBlocks(item.note)} tone="paper" />
              ) : (
                <Text style={[typography.body, styles.empty]}>No thesis filed yet.</Text>
              )}
            </View>

            <View style={styles.section}>
              <Standing label="Events" tone="paper" />
              {item.events.length > 0 ? (
                item.events.map((date, i) => (
                  <Text key={i} style={[typography.body, styles.event]}>
                    {formatPrintedDate(date)}
                  </Text>
                ))
              ) : (
                <Text style={[typography.body, styles.empty]}>Nothing dated yet.</Text>
              )}
            </View>
          </Sheet>

          <View style={styles.actions}>
            <View style={styles.actionRow}>
              <Button
                label="Research this one"
                variant="secondary"
                loading={research.isPending}
                onPress={onResearch}
                style={styles.actionBtn}
              />
              {researchQueued ? <Stamp tone="chrome">queued for research</Stamp> : null}
            </View>
            {research.isError ? (
              <Text style={styles.errorLine}>
                {research.error instanceof DeskError
                  ? deskHumanError(research.error)
                  : 'That didn’t reach the desk.'}
              </Text>
            ) : null}

            <View style={styles.actionRow}>
              <Button
                label="Order an edition"
                variant="primary"
                loading={orderEdition.isPending}
                onPress={onOrderEdition}
                style={styles.actionBtn}
              />
              {editionQueued ? <Stamp tone="chrome">edition ordered</Stamp> : null}
            </View>
            {orderEdition.isError ? (
              <Text style={styles.errorLine}>
                {orderEdition.error instanceof DeskError
                  ? deskHumanError(orderEdition.error)
                  : 'That didn’t reach the desk.'}
              </Text>
            ) : null}
          </View>
        </ScrollView>
      )}
    </Screen>
  )
}

const styles = StyleSheet.create({
  scroll: {
    padding: spacing[16],
    gap: spacing[16],
  },
  sheet: {
    gap: spacing[16],
  },
  symbol: {
    color: colors.inkMuted,
  },
  missing: {
    color: colors.ink,
  },
  name: {
    color: colors.ink,
  },
  gradeRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing[12],
  },
  reasons: {
    flex: 1,
    gap: spacing[4],
  },
  reason: {
    color: colors.ink,
  },
  quoteRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  priceCol: {
    alignItems: 'flex-end',
    gap: spacing[4],
  },
  last: {
    color: colors.ink,
    fontSize: 20,
  },
  section: {
    gap: spacing[8],
  },
  empty: {
    color: colors.inkMuted,
  },
  event: {
    color: colors.ink,
  },
  actions: {
    gap: spacing[8],
  },
  actionRow: {
    gap: spacing[8],
    alignItems: 'flex-start',
  },
  actionBtn: {
    alignSelf: 'stretch',
  },
  errorLine: {
    ...typography.ui,
    color: colors.signal.chrome.down,
    fontSize: 12,
  },
})
