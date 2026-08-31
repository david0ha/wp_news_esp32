import { useCallback, useMemo, useState } from 'react'
import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useRouter } from 'expo-router'
import * as Haptics from 'expo-haptics'
import { Screen } from '../../components/Screen'
import { HeaderGear } from '../../components/HeaderGear'
import { Sheet } from '../../components/Sheet'
import { EmptyState } from '../../components/EmptyState'
import { ScreenMessage } from '../../components/ScreenMessage'
import { SegmentedControl } from '../../components/SegmentedControl'
import { WatchRow } from '../../components/watch/WatchRow'
import { deskKeys, queryClient, useDeskClient, useQuotes, useWatchlist } from '../../lib/queries'
import { DeskError, deskHumanError } from '../../lib/desk'
import { WATCH_GRADE_FILTERS, filterByGrade, sortWatchlist, watchGradeFilterLabel, type WatchGradeFilter } from '../../lib/watchlist'
import { colors, spacing, typography } from '../../theme/index'

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

  const onRefresh = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: deskKeys.watchlist() })
    queryClient.invalidateQueries({ queryKey: deskKeys.quotes(symbols) })
  }, [symbols])

  const onChangeFilter = useCallback((index: number) => {
    const next = WATCH_GRADE_FILTERS[index]
    if (next === undefined) return
    setFilter(next)
    Haptics.selectionAsync()
  }, [])

  if (client === null) {
    return (
      <Screen edges={['top']}>
        <View style={styles.header}>
          <Text style={styles.title}>Watch</Text>
          <HeaderGear />
        </View>
        <EmptyState
          title="No desk yet"
          body="Add its address and operator token in Settings, and the companies it’s watching appear here."
          actionLabel="Open settings"
          onAction={() => router.push('/settings')}
        />
      </Screen>
    )
  }

  const items = watchlist.data?.items ?? []
  const visible = sortWatchlist(filterByGrade(items, filter))

  return (
    <Screen edges={['top']}>
      <View style={styles.header}>
        <Text style={styles.title}>Watch</Text>
        <HeaderGear />
      </View>

      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={
          <RefreshControl
            refreshing={watchlist.isRefetching || quotes.isRefetching}
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
            error={
              watchlist.error instanceof DeskError
                ? deskHumanError(watchlist.error)
                : 'Couldn’t load the watchlist.'
            }
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
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing[16],
    paddingTop: spacing[8],
  },
  title: {
    ...typography.uiStrong,
    fontSize: 22,
    color: colors.deskText,
  },
  scroll: {
    padding: spacing[16],
    gap: spacing[16],
  },
  sheet: {
    paddingVertical: spacing[8],
    paddingHorizontal: spacing[24],
  },
})
