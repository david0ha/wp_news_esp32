import { useCallback, useRef, useState } from 'react'
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useFocusEffect, useRouter } from 'expo-router'
// The legacy Swipeable deliberately: the newer ReanimatedSwipeable requires
// react-native-reanimated, which is not a direct dependency (it reaches node_modules only
// transitively, via expo-router) and the spec forbids adding one. The deprecation warning
// this import logs is accepted (spec §6.1).
import Swipeable from 'react-native-gesture-handler/Swipeable'
import { Screen } from '../../components/Screen'
import { Card } from '../../components/Card'
import { Button } from '../../components/Button'
import { IconBadge } from '../../components/IconBadge'
import { TickerRow } from '../../components/TickerRow'
import { yahoo } from '../../lib/market/yahoo'
import { marketHumanError, type Quote } from '../../lib/market/types'
import { getWatchlist, removeFromWatchlist, type WatchItem } from '../../lib/market/watchlist'
import { colors, fonts, layout, radius, shadow, space, type } from '../../theme'

// Re-poll while focused. The quote cache's 25 s TTL sits below this, so every poll actually
// fetches; pull-to-refresh bypasses the TTL entirely with { fresh: true }.
const POLL_MS = 30_000

export default function Markets() {
  const router = useRouter()

  // null until the stored watchlist has been read once — distinct from "empty".
  const [items, setItems] = useState<WatchItem[] | null>(null)
  const [quotes, setQuotes] = useState<Record<string, Quote>>({})
  // A symbol is "loading" until its first quote fetch settles; after that a missing quote
  // renders '—', not a skeleton.
  const [settled, setSettled] = useState<Record<string, boolean>>({})
  const [banner, setBanner] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  const focused = useRef(true)
  // Mirror of `quotes` readable synchronously inside an async pass (two overlapping passes —
  // a poll and a pull-to-refresh — both merge here without losing each other's rows).
  const quotesRef = useRef<Record<string, Quote>>({})

  const load = useCallback(async (opts: { fresh?: boolean } = {}) => {
    const list = await getWatchlist()
    setItems(list)
    if (list.length === 0) {
      setBanner(null)
      return
    }

    // All quotes in parallel; a rejected one degrades its own row only.
    const results = await Promise.allSettled(
      list.map((w) => yahoo.quote(w.symbol, opts.fresh ? { fresh: true } : undefined)),
    )

    const fetched: Record<string, Quote> = {}
    let successes = 0
    let firstError: unknown = null
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') {
        fetched[list[i].symbol] = r.value
        successes++
      } else if (firstError === null) {
        firstError = r.reason
      }
    })

    quotesRef.current = { ...quotesRef.current, ...fetched }
    setQuotes(quotesRef.current)
    setSettled((prev) => {
      const next = { ...prev }
      for (const w of list) next[w.symbol] = true
      return next
    })

    // Global banner only when every quote rejected AND no row has data (cached from an
    // earlier pass included) — while at least one row has something, rows degrade per-row.
    const anyData = list.some((w) => quotesRef.current[w.symbol] !== undefined)
    setBanner(successes === 0 && !anyData ? marketHumanError(firstError) : null)
  }, [])

  // Poll while the screen is focused; pause on blur, resume (and pick up watchlist edits made
  // in the add screen) on return — the same pattern as the board's device poll.
  useFocusEffect(
    useCallback(() => {
      focused.current = true
      void load()
      const id = setInterval(() => {
        if (focused.current) void load()
      }, POLL_MS)
      return () => {
        focused.current = false
        clearInterval(id)
      }
    }, [load]),
  )

  const onRefresh = useCallback(async () => {
    setRefreshing(true)
    try {
      await load({ fresh: true })
    } finally {
      setRefreshing(false)
    }
  }, [load])

  const remove = useCallback(async (symbol: string) => {
    const next = await removeFromWatchlist(symbol)
    setItems(next)
  }, [])

  const openAdd = useCallback(() => router.push('/add-ticker'), [router])

  const isEmpty = items !== null && items.length === 0

  return (
    <Screen aurora edges={['top']}>
      <View style={styles.header}>
        <Text style={type.headingLg}>Markets</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Add ticker"
          onPress={openAdd}
          style={({ pressed }) => [styles.addButton, pressed && styles.pressed]}
        >
          <Ionicons name="add" size={22} color={colors.accent} />
        </Pressable>
      </View>

      <ScrollView
        contentContainerStyle={[styles.scroll, isEmpty && styles.scrollEmpty]}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent} />
        }
      >
        {banner !== null ? (
          <View style={styles.banner}>
            <Text style={styles.bannerText}>{banner}</Text>
          </View>
        ) : null}

        {items !== null && items.length > 0 ? (
          <Card style={styles.listCard}>
            {items.map((w, i) => {
              const q = quotes[w.symbol]
              return (
                <Swipeable
                  key={w.symbol}
                  overshootRight={false}
                  renderRightActions={() => (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`Remove ${w.symbol}`}
                      onPress={() => void remove(w.symbol)}
                      style={styles.removeAction}
                    >
                      <Text style={styles.removeLabel}>Remove</Text>
                    </Pressable>
                  )}
                >
                  <TickerRow
                    symbol={w.symbol}
                    name={w.name !== '' ? w.name : (q?.name ?? '')}
                    price={q?.price}
                    delta={q?.delta}
                    pct={q?.pct}
                    spark={q?.spark}
                    loading={settled[w.symbol] !== true}
                    onPress={() => router.push(`/market/${encodeURIComponent(w.symbol)}`)}
                    last={i === items.length - 1}
                  />
                </Swipeable>
              )
            })}
          </Card>
        ) : null}

        {isEmpty ? (
          <View style={styles.empty}>
            <IconBadge name="trending-up" />
            <Text style={styles.emptyTitle}>Track your first ticker</Text>
            <Text style={styles.emptyBody}>
              Search any symbol and it’ll show up here with a live price and chart.
            </Text>
            <Button label="Add a ticker" onPress={openAdd} />
          </View>
        ) : null}
      </ScrollView>
    </Screen>
  )
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: layout.gutter,
    paddingTop: space.sm,
    paddingBottom: space.md,
  },
  addButton: {
    width: 36,
    height: 36,
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    ...shadow.soft,
  },
  pressed: {
    opacity: 0.7,
  },
  scroll: {
    padding: layout.gutter,
    paddingTop: space.xs,
    paddingBottom: space.xxl,
  },
  scrollEmpty: {
    flexGrow: 1,
  },
  banner: {
    backgroundColor: colors.warnBg,
    borderRadius: radius.md,
    padding: space.md,
    marginBottom: space.md,
  },
  bannerText: {
    fontFamily: fonts.medium,
    fontSize: 13,
    lineHeight: 18,
    color: colors.warn,
  },
  listCard: {
    padding: 0,
    // Clips both the swipe action panel and the last row's corners to the card radius.
    overflow: 'hidden',
  },
  removeAction: {
    width: 96,
    backgroundColor: colors.down,
    alignItems: 'center',
    justifyContent: 'center',
  },
  removeLabel: {
    fontFamily: fonts.semibold,
    fontSize: 15,
    color: colors.white,
  },
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.lg,
    paddingBottom: space.xxl,
  },
  emptyTitle: {
    ...type.heading,
    textAlign: 'center',
  },
  emptyBody: {
    ...type.body,
    color: colors.textDim,
    textAlign: 'center',
    maxWidth: 280,
  },
})
