import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useRouter } from 'expo-router'
import { Screen } from '../components/Screen'
import { Card } from '../components/Card'
import { SearchField } from '../components/SearchField'
import { ScreenMessage } from '../components/ScreenMessage'
import { yahoo } from '../lib/market/yahoo'
import { marketHumanError, type SearchResult } from '../lib/market/types'
import { addToWatchlist, getWatchlist, removeFromWatchlist } from '../lib/market/watchlist'
import { colors, fonts, layout, radius, space, type } from '../theme'

// Debounce after the last keystroke before the search fires; responses for a query that is no
// longer the current input are dropped via a request sequence number.
const DEBOUNCE_MS = 300

export default function AddTicker() {
  const router = useRouter()

  const [query, setQuery] = useState('')
  // null = no completed search for the current input (idle or still typing/searching);
  // [] = a search completed and matched nothing.
  const [results, setResults] = useState<SearchResult[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [watched, setWatched] = useState<Set<string>>(new Set())

  // Bumped on every new search AND on every input change, so a late response for an old query
  // can never overwrite the state of the current one.
  const seqRef = useRef(0)

  // Seed the added/not-added state of the result rows from the stored watchlist.
  useEffect(() => {
    let alive = true
    void getWatchlist().then((list) => {
      if (alive) setWatched(new Set(list.map((w) => w.symbol)))
    })
    return () => {
      alive = false
    }
  }, [])

  const runSearch = useCallback(async (q: string) => {
    const seq = ++seqRef.current
    setSearching(true)
    setError(null)
    try {
      const res = await yahoo.search(q)
      if (seqRef.current !== seq) return // stale — the input moved on
      setResults(res)
    } catch (e) {
      if (seqRef.current !== seq) return
      setResults(null)
      setError(marketHumanError(e))
    } finally {
      if (seqRef.current === seq) setSearching(false)
    }
  }, [])

  // Debounced search on input change. Trimmed; queries shorter than 1 char never fire.
  useEffect(() => {
    seqRef.current++ // anything in flight is now stale
    const q = query.trim()
    if (q.length < 1) {
      setResults(null)
      setError(null)
      setSearching(false)
      return
    }
    setSearching(true)
    setError(null)
    const timer = setTimeout(() => {
      void runSearch(q)
    }, DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [query, runSearch])

  const retry = useCallback(() => {
    const q = query.trim()
    if (q.length >= 1) void runSearch(q)
  }, [query, runSearch])

  // Optimistic toggle: flip the circle immediately; the store itself is best-effort and
  // never throws (watchlist.ts), so there is nothing to roll back.
  const toggle = useCallback(
    (item: SearchResult) => {
      const sym = item.symbol.trim().toUpperCase()
      if (watched.has(sym)) {
        setWatched((prev) => {
          const next = new Set(prev)
          next.delete(sym)
          return next
        })
        void removeFromWatchlist(sym)
      } else {
        setWatched((prev) => new Set(prev).add(sym))
        void addToWatchlist({ symbol: sym, name: item.name })
      }
    },
    [watched],
  )

  const open = useCallback(
    (symbol: string) => router.push(`/market/${encodeURIComponent(symbol.trim().toUpperCase())}`),
    [router],
  )

  const trimmed = query.trim()

  // While a refinement keystroke's search is in flight the PREVIOUS results stay on screen,
  // dimmed under a small spinner — blanking them to a full-screen spinner on every keystroke
  // flashes the list in and out and yanks away the row the user was about to tap. The
  // full-screen spinner is only for a search with nothing yet to show (results === null).
  let body: ReactNode
  if (error !== null) {
    body = <ScreenMessage error={error} onRetry={retry} />
  } else if (trimmed.length < 1) {
    body = (
      <View style={styles.idle}>
        <Text style={type.caption}>Search Yahoo Finance for any listed symbol.</Text>
      </View>
    )
  } else if (results === null) {
    body = <ActivityIndicator color={colors.accent} style={styles.spinner} />
  } else if (results.length === 0) {
    body = <ScreenMessage message="No matches." />
  } else {
    body = (
      <View style={styles.resultsWrap}>
        <Card style={[styles.resultsCard, searching && styles.resultsStale]}>
          <FlatList
            data={results}
            keyExtractor={(r, i) => `${r.symbol}:${i}`}
            keyboardShouldPersistTaps="handled"
            renderItem={({ item, index }) => (
              <ResultRow
                item={item}
                added={watched.has(item.symbol.trim().toUpperCase())}
                last={index === results.length - 1}
                onOpen={() => open(item.symbol)}
                onToggle={() => toggle(item)}
              />
            )}
          />
        </Card>
        {searching ? (
          <View style={styles.searchingOverlay} pointerEvents="none">
            <ActivityIndicator size="small" color={colors.accent} />
          </View>
        ) : null}
      </View>
    )
  }

  return (
    <Screen>
      {/* iOS overlays the keyboard rather than resizing (Android's adjustResize shrinks the
          body on its own), so without this the results card's lower rows sit behind the
          keyboard — untappable, and with ≤ 8 results the list has nothing to scroll. Same
          pattern as onboarding/password.tsx and settings.tsx. */}
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.header}>
          <View style={styles.field}>
            <SearchField
              value={query}
              onChangeText={setQuery}
              placeholder="Symbol or company"
              autoFocus
              onClear={() => setQuery('')}
            />
          </View>
          <Pressable
            accessibilityRole="button"
            onPress={() => (router.canGoBack() ? router.back() : router.replace('/markets'))}
            hitSlop={8}
            style={({ pressed }) => pressed && styles.pressed}
          >
            <Text style={styles.cancel}>Cancel</Text>
          </Pressable>
        </View>
        <View style={styles.body}>{body}</View>
      </KeyboardAvoidingView>
    </Screen>
  )
}

function ResultRow({
  item,
  added,
  last,
  onOpen,
  onToggle,
}: {
  item: SearchResult
  added: boolean
  last: boolean
  onOpen: () => void
  onToggle: () => void
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={item.symbol}
      onPress={onOpen}
      style={({ pressed }) => [styles.row, !last && styles.rowDivider, pressed && styles.pressed]}
    >
      <View style={styles.rowLeft}>
        <Text style={type.headingSm} numberOfLines={1}>
          {item.symbol}
        </Text>
        {item.name !== '' ? (
          <Text style={styles.rowName} numberOfLines={1}>
            {item.name}
          </Text>
        ) : null}
      </View>
      {item.exchange !== '' ? (
        <Text style={styles.exchange} numberOfLines={1}>
          {item.exchange}
        </Text>
      ) : null}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={added ? `Remove ${item.symbol} from watchlist` : `Add ${item.symbol} to watchlist`}
        accessibilityState={{ selected: added }}
        onPress={onToggle}
        hitSlop={8}
        style={[styles.toggle, added ? styles.toggleAdded : styles.toggleIdle]}
      >
        <Ionicons name={added ? 'checkmark' : 'add'} size={18} color={colors.accent} />
      </Pressable>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: layout.gutter,
    paddingTop: space.md,
    paddingBottom: space.sm,
  },
  field: {
    flex: 1,
  },
  cancel: {
    fontFamily: fonts.semibold,
    fontSize: 15,
    color: colors.accent,
  },
  pressed: {
    opacity: 0.7,
  },
  body: {
    flex: 1,
    paddingHorizontal: layout.gutter,
    paddingTop: space.md,
  },
  spinner: {
    marginTop: space.lg,
  },
  idle: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.xl,
  },
  resultsWrap: {
    flexShrink: 1,
  },
  resultsCard: {
    padding: 0,
    overflow: 'hidden',
    // Cap at the space the keyboard leaves (KeyboardAvoidingView on iOS, adjustResize on
    // Android) and scroll inside, rather than growing past it.
    flexShrink: 1,
  },
  resultsStale: {
    opacity: 0.5,
  },
  searchingOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: 12,
    paddingHorizontal: 16,
  },
  rowDivider: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  rowLeft: {
    flex: 1,
  },
  rowName: {
    ...type.caption,
    marginTop: 1,
  },
  exchange: {
    fontFamily: fonts.regular,
    fontSize: 13,
    color: colors.textDim,
    maxWidth: 96,
  },
  toggle: {
    width: 32,
    height: 32,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  toggleIdle: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  toggleAdded: {
    backgroundColor: colors.accentDim,
  },
})
