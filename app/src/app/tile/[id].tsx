import { useCallback, useEffect, useMemo, useState } from 'react'
import { ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { Screen } from '../../components/Screen'
import { BackButton } from '../../components/BackButton'
import { ScreenMessage } from '../../components/ScreenMessage'
import { Masonry } from '../../components/edition/Masonry'
import { TileDetail } from '../../components/edition/detail/TileDetail'
import { getCurrentEdition, readCachedEdition, type CachedEdition } from '../../lib/edition/store'
import { COLUMN_GAP, columnWidth } from '../../lib/edition/feedLayout'
import { editionToTiles, findTile, type Tile } from '../../lib/edition/tiles'
import { colors, fonts, layout, space, type } from '../../theme'

/**
 * One tile, opened — and the rest of the edition continuing underneath it.
 *
 * That continuation is Pinterest's closeup, and it is the whole reason this is a page rather than
 * a modal: a reader who taps a figure has not stopped browsing, and a dead end here would send
 * them back to the top of the feed to find their place again.
 *
 * THE ROUTE IS `tile/[id]`, NOT `edition/[tile]`. It is a root-stack route so it pushes over the
 * tab bar and is deep-linkable, which is exactly the split `(tabs)/markets.tsx` and
 * `market/[symbol].tsx` already use — and naming it after the tab it opens from would put a root
 * route and a tab under the same `/edition` prefix, a shape this app has no precedent for. The
 * segment is the tile's id, which is the producer's (`story:0`, `figures:1`) and arrives
 * URL-encoded.
 *
 * The edition comes from the in-memory copy `lib/edition/store.ts` publishes, which is filled by
 * all three of the ways one arrives — a fetch that wrote the cache, a `readCachedEdition()` that
 * read it (which `useEdition` runs on every mount, so an offline session reading its cache is
 * covered too), and `useEdition`'s own demo publish. The disk read below is therefore the cold
 * case and only the cold case: `claudepost://tile/story:0` into a process where the Today tab has
 * never mounted.
 */

/**
 * Whether this page has an edition to be inside.
 *
 * Three states and not two, because `getCurrentEdition()` returns `CachedEdition | null` and its
 * `null` means "nothing in memory", which is NOT "nothing anywhere" — the disk has not been asked
 * yet. Collapsing the two would send a cold deep link straight back to the tab before the cache
 * it needs had a chance to answer. `unknown` is the frame in between, and it renders a spinner.
 */
type Held =
  | { status: 'unknown' }
  | { status: 'have'; cached: CachedEdition }
  | { status: 'none' }

export default function TileDetailRoute() {
  const router = useRouter()
  const { width } = useWindowDimensions()
  const params = useLocalSearchParams<{ id: string }>()
  const id = String(params.id ?? '')

  const [held, setHeld] = useState<Held>(() => {
    const inMemory = getCurrentEdition()
    return inMemory === null ? { status: 'unknown' } : { status: 'have', cached: inMemory }
  })

  useEffect(() => {
    if (held.status !== 'unknown') return
    let alive = true
    void (async () => {
      const fromDisk = await readCachedEdition()
      if (!alive) return
      setHeld(fromDisk === null ? { status: 'none' } : { status: 'have', cached: fromDisk })
    })()
    return () => {
      alive = false
    }
  }, [held.status])

  // Nothing in memory and nothing on disk: there is no edition to be inside. Go to the tab,
  // which will load one. `replace` and not `push`, so Back does not come straight back here.
  useEffect(() => {
    if (held.status === 'none') router.replace('/edition')
  }, [held.status, router])

  const cached = held.status === 'have' ? held.cached : null
  const feed = useMemo(() => (cached === null ? null : editionToTiles(cached.edition)), [cached])
  const tile = feed === null ? null : findTile(feed, id)
  const rest: Tile[] = feed === null ? [] : feed.tiles.filter((t) => t.id !== id)
  const colWidth = columnWidth(width, layout.gutter, COLUMN_GAP)

  const openTile = useCallback(
    (t: Tile) => router.push(`/tile/${encodeURIComponent(t.id)}`),
    [router],
  )

  const header = (
    <View style={styles.titleRow}>
      {/* Back falls back to a destination rather than to silence: this is a root-stack route, so
          a cold deep link builds a stack of just [tile] and `canGoBack()` is false — the same
          trap `preview.tsx` and `market/[symbol].tsx` document. */}
      <BackButton
        onPress={() => (router.canGoBack() ? router.back() : router.replace('/edition'))}
      />
      <Text style={styles.title}>Today</Text>
      <View style={styles.backSpacer} />
    </View>
  )

  // Either the disk has not answered yet, or it has answered "nothing" and the redirect above is
  // already in flight. A spinner is the honest frame for both.
  if (cached === null) {
    return (
      <Screen>
        {header}
        <ScreenMessage loading />
      </Screen>
    )
  }

  // An id that names nothing: a link to yesterday's `photo:3` in an edition with two photographs,
  // or a hand-typed segment. The edition is fine, so this is a message and not an error.
  if (tile === null) {
    return (
      <Screen>
        {header}
        <ScreenMessage message="This item isn’t in today’s edition." />
      </Screen>
    )
  }

  return (
    <Screen>
      {header}
      <ScrollView contentContainerStyle={styles.scroll}>
        <TileDetail tile={tile} edition={cached.edition} newsUrl={cached.url} width={width} />
        {rest.length > 0 ? (
          <View style={styles.more}>
            <Text style={type.headingSm}>More from this edition</Text>
            <Masonry
              tiles={rest}
              colWidth={colWidth}
              newsUrl={cached.url}
              gutter={COLUMN_GAP}
              columns={2}
              onPress={openTile}
            />
          </View>
        ) : null}
      </ScrollView>
    </Screen>
  )
}

const styles = StyleSheet.create({
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: layout.gutter,
    height: 56,
  },
  title: {
    fontFamily: fonts.bold,
    fontSize: 18,
    color: colors.text,
  },
  // Balances the back button so the title sits centred rather than shunted left.
  backSpacer: {
    width: 42,
  },
  scroll: {
    paddingBottom: space.xxl,
  },
  more: {
    paddingHorizontal: layout.gutter,
    paddingTop: space.xl,
    gap: space.md,
  },
})
