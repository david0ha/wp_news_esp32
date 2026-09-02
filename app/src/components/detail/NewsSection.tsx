import { useCallback, useEffect, useRef, useState } from 'react'
import { ActivityIndicator, Linking, Pressable, StyleSheet, Text, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { Card } from '../Card'
import { NewsCard } from '../NewsCard'
import { colors, fonts, radius, space, type } from '../../theme'
import { marketHumanError, type NewsItem } from '../../lib/market/types'
import { yahoo } from '../../lib/market/yahoo'

interface DetailSectionProps {
  symbol: string
  active: boolean
}

type LoadState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; error: unknown }
  | { status: 'ready'; items: NewsItem[]; refreshing: boolean }

/**
 * The detail screen's News tab: NewsCard rows fed by yahoo.news(symbol), fetched
 * lazily on first activation. State survives tabbing away (the shell keeps sections
 * mounted; an inactive section renders nothing). Parent pull-to-refresh is not wired —
 * the ghost "Refresh" at the list foot re-fires the fetch past the TTL instead.
 */
export function NewsSection({ symbol, active }: DetailSectionProps) {
  const [state, setState] = useState<LoadState>({ status: 'idle' })
  const seqRef = useRef(0)
  const stateRef = useRef(state)
  stateRef.current = state

  const load = useCallback(
    async (fresh: boolean) => {
      const seq = ++seqRef.current
      const cur = stateRef.current
      if (fresh && cur.status === 'ready') {
        setState({ status: 'ready', items: cur.items, refreshing: true })
      } else {
        setState({ status: 'loading' })
      }
      try {
        const items = await yahoo.news(symbol, { fresh })
        if (seqRef.current !== seq) return
        setState({ status: 'ready', items, refreshing: false })
      } catch (e) {
        if (seqRef.current !== seq) return
        const prev = stateRef.current
        if (prev.status === 'ready') {
          // A failed explicit refresh keeps the headlines it already has (the cache's
          // stale-on-error philosophy); only a first load with nothing to show errors out.
          setState({ status: 'ready', items: prev.items, refreshing: false })
        } else {
          setState({ status: 'error', error: e })
        }
      }
    },
    [symbol],
  )

  useEffect(() => {
    if (active && state.status === 'idle') void load(false)
  }, [active, state.status, load])

  if (!active) return null

  if (state.status === 'idle' || state.status === 'loading') {
    return (
      <View style={styles.section}>
        <View style={styles.loadingBox}>
          <ActivityIndicator color={colors.accent} />
        </View>
      </View>
    )
  }

  if (state.status === 'error') {
    return (
      <View style={styles.section}>
        <Card style={styles.degraded}>
          <View style={styles.degradedIcon}>
            <Ionicons name="newspaper-outline" size={20} color={colors.accent} />
          </View>
          <View style={styles.degradedText}>
            <Text style={styles.degradedTitle}>News unavailable</Text>
            <Text style={type.caption}>{marketHumanError(state.error)}</Text>
            <Pressable onPress={() => void load(false)} hitSlop={8}>
              <Text style={styles.ghost}>Try again</Text>
            </Pressable>
          </View>
        </Card>
      </View>
    )
  }

  if (state.items.length === 0) {
    return (
      <View style={styles.section}>
        <Text style={styles.empty}>No recent headlines for {symbol}.</Text>
      </View>
    )
  }

  return (
    <View style={styles.section}>
      <Card style={styles.listCard}>
        {state.items.map((item, i) => (
          <NewsCard
            key={item.id !== '' ? item.id : `${item.url}:${i}`}
            item={item}
            last={i === state.items.length - 1}
            onPress={() => {
              Linking.openURL(item.url).catch(() => {})
            }}
          />
        ))}
      </Card>
      <View style={styles.foot}>
        {state.refreshing ? (
          <ActivityIndicator color={colors.accent} size="small" />
        ) : (
          <Pressable onPress={() => void load(true)} hitSlop={8}>
            <Text style={styles.ghost}>Refresh</Text>
          </Pressable>
        )}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  section: {
    paddingTop: space.lg,
    paddingBottom: space.xl,
  },
  loadingBox: {
    height: 120,
    alignItems: 'center',
    justifyContent: 'center',
  },
  listCard: {
    padding: 0,
  },
  foot: {
    alignItems: 'center',
    paddingVertical: 12,
  },
  ghost: {
    fontFamily: fonts.semibold,
    fontSize: 14,
    color: colors.accent,
  },
  empty: {
    ...type.caption,
    textAlign: 'center',
    paddingVertical: space.xl,
  },
  degraded: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.md,
  },
  degradedIcon: {
    width: 40,
    height: 40,
    borderRadius: radius.md,
    backgroundColor: colors.iconWell,
    alignItems: 'center',
    justifyContent: 'center',
  },
  degradedText: {
    flex: 1,
    gap: space.sm,
  },
  degradedTitle: {
    fontFamily: fonts.semibold,
    fontSize: 15,
    color: colors.text,
  },
})
