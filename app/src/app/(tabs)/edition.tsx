import { useCallback, useMemo, useState } from 'react'
import { RefreshControl, ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native'
import { useRouter } from 'expo-router'
import { Screen } from '../../components/Screen'
import { ScreenMessage } from '../../components/ScreenMessage'
import { Masthead } from '../../components/edition/Masthead'
import { ChipRow } from '../../components/edition/ChipRow'
import { Masonry } from '../../components/edition/Masonry'
import { PhotoTile } from '../../components/edition/tiles/PhotoTile'
import { useEdition } from '../../lib/edition/useEdition'
import { freshnessLabel } from '../../lib/edition/freshness'
import {
  COLUMN_GAP,
  columnWidth,
  editionKey,
  photoBoxHeight,
  resolveChip,
} from '../../lib/edition/feedLayout'
import {
  availableChips,
  editionToTiles,
  filterTiles,
  type Chip,
  type Tile,
} from '../../lib/edition/tiles'
import { colors, layout, radius, space } from '../../theme'

/**
 * Today — the edition itself, read on the phone.
 *
 * The material is not on the board. It is at the edition URL, which this phone already stores as
 * its own setting, and which the desk serves unauthenticated on its device plane. So this screen
 * needs no board, no token and no LAN: a phone that has never been near the hardware still reads
 * the paper, and one with no URL at all reads the demo.
 *
 * Everything about WHAT to show is decided in `useEdition`'s reducer, which is pure and tested.
 * What is left here is layout: measure the column, cut the tiles, hand them to the masonry.
 */
export default function EditionScreen() {
  const router = useRouter()
  const { width } = useWindowDimensions()
  const { state, refresh } = useEdition()

  // The reader's choice, kept as they left it. `resolveChip` decides what is actually SHOWING,
  // so a chip the new edition has nothing behind falls back to `all` for this render without
  // the selection being thrown away — if tomorrow's edition has photographs again, Photos comes
  // back selected rather than needing a second tap.
  const [chip, setChip] = useState<Chip>('all')

  // Keyed on the EDITION and not on the cache entry that carries it. A 304 rebuilds the entry to
  // move `fetchedAt` but keeps the same edition object, so this way the page is cut once and a
  // confirmation that changed nothing re-lays out nothing.
  const edition = state.status === 'ready' ? state.cached.edition : null
  const feed = useMemo(() => (edition === null ? null : editionToTiles(edition)), [edition])

  const chips: Chip[] = feed === null ? ['all'] : availableChips(feed.tiles)
  const active = resolveChip(chips, chip)
  const tiles = feed === null ? [] : filterTiles(feed.tiles, active)

  // One function, shared with the detail page's masonry — the tile heights are derived from this
  // number, so two screens computing it separately would lay the same edition out two ways.
  const colWidth = columnWidth(width, layout.gutter, COLUMN_GAP)
  const contentWidth = width - 2 * layout.gutter

  const onRefresh = useCallback(() => {
    void refresh({ fresh: true })
  }, [refresh])

  const openTile = useCallback(
    // The id is the producer's own (`story:0`, `figures:1`) and travels in a path segment, so it
    // is encoded here and decoded by the router on the other side. Takes the whole tile, so this
    // is `Masonry`'s `onPress` verbatim — an inline arrow that unwrapped it would allocate a new
    // callback every render and spend the memo it was written for.
    (t: Tile) => router.push(`/tile/${encodeURIComponent(t.id)}`),
    [router],
  )

  if (state.status === 'loading') {
    return (
      <Screen edges={['top']}>
        <ScreenMessage loading />
      </Screen>
    )
  }

  if (state.status === 'error') {
    return (
      <Screen edges={['top']}>
        <ScreenMessage error={state.error} onRetry={onRefresh} />
      </Screen>
    )
  }

  const band = feed?.band ?? null
  // Which edition this page is drawing. Every mounted tile carries it, so a new edition is a
  // remount rather than a reuse — see `editionKey`.
  const key = editionKey(state.cached)

  return (
    <Screen edges={['top']}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={
          <RefreshControl
            refreshing={state.refreshing}
            onRefresh={onRefresh}
            tintColor={colors.accent}
          />
        }
      >
        <Masthead
          edition={state.cached.edition}
          demo={state.demo}
          freshness={freshnessLabel(state.cached.fetchedAt, Date.now())}
          error={state.error}
          onRetry={onRefresh}
          onPressSymbol={() => {
            // Guarded here as well as in the masthead, which only offers the press when there is
            // a symbol: `/market/` with nothing after it matches no route and this app has no
            // `+not-found`, so the push would be a dead screen rather than a no-op.
            const symbol = state.cached.edition.subject.symbol
            if (symbol === '') return
            router.push(`/market/${encodeURIComponent(symbol)}`)
          }}
        />

        {/* The band: the lead photograph, too wide for a column, run across the page instead. It
            is a `PhotoTile` at full width — same fetch, same decode, same silent failure — inside
            a frame that owns the radius, because `PhotoTile` sets none of its own. */}
        {band !== null ? (
          <View style={styles.band}>
            <View style={styles.bandFrame}>
              <PhotoTile
                // Keyed by the edition, like every tile in the masonry: the lead band is 1140x320
                // under the same id every edition, so without this the reused mount keeps
                // yesterday's photograph under today's headline.
                key={`${key}:band`}
                tile={{ kind: 'photo', id: 'band', photo: band }}
                width={contentWidth}
                height={photoBoxHeight(band, contentWidth)}
                newsUrl={state.cached.url}
              />
            </View>
          </View>
        ) : null}

        <ChipRow chips={chips} selected={active} onSelect={setChip} />

        <View style={styles.grid}>
          <Masonry
            tiles={tiles}
            colWidth={colWidth}
            newsUrl={state.cached.url}
            editionKey={key}
            gutter={COLUMN_GAP}
            columns={2}
            onPress={openTile}
          />
        </View>
      </ScrollView>
    </Screen>
  )
}

const styles = StyleSheet.create({
  scroll: {
    paddingBottom: space.xxl,
  },
  band: {
    paddingHorizontal: layout.gutter,
    paddingTop: space.md,
  },
  bandFrame: {
    borderRadius: radius.lg,
    overflow: 'hidden',
  },
  grid: {
    paddingHorizontal: layout.gutter,
  },
})
