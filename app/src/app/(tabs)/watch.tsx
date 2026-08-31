import { useCallback, useMemo, useState } from 'react'
import { RefreshControl, ScrollView, StyleSheet } from 'react-native'
import { useRouter } from 'expo-router'
import { Screen } from '../../components/Screen'
import { TabHeader } from '../../components/TabHeader'
import { Sheet } from '../../components/Sheet'
import { EmptyState } from '../../components/EmptyState'
import { ScreenMessage } from '../../components/ScreenMessage'
import { SegmentedControl } from '../../components/SegmentedControl'
import { WatchRow } from '../../components/watch/WatchRow'
import {
  deskKeys,
  queryClient,
  useDeskClient,
  usePullRefresh,
  useQuotes,
  useWatchlist,
} from '../../lib/queries'
import { deskHumanError } from '../../lib/desk'
import { WATCH_GRADE_FILTERS, filterByGrade, sortWatchlist, watchGradeFilterLabel, type WatchGradeFilter } from '../../lib/watchlist'
import { colors, spacing, tapSelection } from '../../theme/index'

/**
 * Watch — the companies the desk is watching, each row led by its grade and the argument behind
 * it (plan Design > Wireframes). Read-only: the vault owns this list, and the phone has no write
 * path to it (`desk.ts`'s `getWatchlist()` has no matching `put`) — a company appears or drops off
 * because somebody edited the vault, not because of anything tapped here.
 */
export default function Watch() {
  const router = useRouter()
  const [filter, setFilter] = useState<WatchGradeFilter>('all')

  const client = useDeskClient()
  const watchlist = useWatchlist()
  // Every symbol on the list, not just the filtered ones — switching the grade filter must not
  // cost a re-fetch of quotes it already has.
  const symbols = useMemo(() => (watchlist.data?.items ?? []).map((i) => i.symbol), [watchlist.data])
  const quotes = useQuotes(symbols)

  // The list and the prices beside it, together — a pull that refreshed one would leave the other
  // describing a different minute. (Why the spinner is local state: `usePullRefresh`.)
  const { pulling, onRefresh } = usePullRefresh(() =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: deskKeys.watchlist() }),
      queryClient.invalidateQueries({ queryKey: deskKeys.quotes(symbols) }),
    ]),
  )

  const onChangeFilter = useCallback((index: number) => {
    const next = WATCH_GRADE_FILTERS[index]
    if (next === undefined) return
    setFilter(next)
    tapSelection()
  }, [])

  // ABOVE the `client === null` return, because a hook after a conditional return is a hook that
  // sometimes does not run. Memoized on the two things that can change the answer: a sort and a
  // filter over a human-curated list is cheap, but re-deriving it on every render of a screen that
  // also re-renders for a pull, a quote and a segment tap is work with no reader behind it.
  const items = useMemo(() => watchlist.data?.items ?? [], [watchlist.data])
  const visible = useMemo(() => sortWatchlist(filterByGrade(items, filter)), [items, filter])

  if (client === null) {
    return (
      <Screen edges={['top']}>
        <TabHeader title="Watch" />
        <EmptyState
          title="No desk yet"
          body="Add its address and operator token in Settings, and the companies it’s watching appear here."
          actionLabel="Open settings"
          onAction={() => router.push('/settings')}
        />
      </Screen>
    )
  }

  return (
    <Screen edges={['top']}>
      <TabHeader title="Watch" />

      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={
          <RefreshControl
            refreshing={pulling}
            onRefresh={onRefresh}
            tintColor={colors.signal.chrome.tint}
          />
        }
      >
        <SegmentedControl
          segments={WATCH_GRADE_FILTERS.map(watchGradeFilterLabel)}
          selectedIndex={WATCH_GRADE_FILTERS.indexOf(filter)}
          onChange={onChangeFilter}
        />

        {watchlist.isLoading ? (
          <ScreenMessage loading />
        ) : watchlist.isError ? (
          <ScreenMessage
            error={deskHumanError(watchlist.error, 'Couldn’t load the watchlist.')}
            onRetry={() => watchlist.refetch()}
          />
        ) : items.length === 0 ? (
          <EmptyState
            title="No watchlist yet"
            body="The desk keeps the list of companies being watched. Nothing has sent it one yet."
          />
        ) : visible.length === 0 ? (
          <ScreenMessage message={`No ${watchGradeFilterLabel(filter).toLowerCase()}-graded companies.`} />
        ) : (
          <Sheet style={styles.sheet}>
            {visible.map((item, i) => (
              <WatchRow
                key={item.symbol}
                item={item}
                quote={quotes.data?.quotes[item.symbol]}
                last={i === visible.length - 1}
                onPress={() => router.push(`/watch/${encodeURIComponent(item.symbol)}`)}
              />
            ))}
          </Sheet>
        )}
      </ScrollView>
    </Screen>
  )
}

const styles = StyleSheet.create({
  scroll: {
    padding: spacing[16],
    gap: spacing[16],
  },
  sheet: {
    paddingVertical: spacing[8],
    paddingHorizontal: spacing[24],
  },
})
