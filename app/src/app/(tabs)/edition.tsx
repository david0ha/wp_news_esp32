import { useCallback, useMemo, useState } from 'react'
import {
  FlatList,
  RefreshControl,
  ScrollView,
  StyleSheet,
  useWindowDimensions,
  View,
} from 'react-native'
import { useFocusEffect, useRouter } from 'expo-router'
import { Screen } from '../../components/Screen'
import { ScreenMessage } from '../../components/ScreenMessage'
import { Masthead } from '../../components/edition/Masthead'
import { ChipRow } from '../../components/edition/ChipRow'
import { Masonry } from '../../components/edition/Masonry'
import { EditionSourceProvider } from '../../components/edition/editionSource'
import { EditionTypeProvider } from '../../components/edition/typeRamp'
import { PhotoTile } from '../../components/edition/tiles/PhotoTile'
import { PaperPage } from '../../components/edition/PaperPage'
import { getDeskToken } from '../../lib/deskToken'
import { clampPaperIndex, paperKey, papersPagerView } from '../../lib/papers/order'
import { lastPaperIndex, rememberPaperIndex, usePapers } from '../../lib/papers/list'
import { type Paper } from '../../lib/desk'
import { isDemo } from '../../lib/edition/editionState'
import { useEdition } from '../../lib/edition/useEdition'
import { freshnessLabel } from '../../lib/edition/freshness'
import { getDeskBaseUrl } from '../../lib/store'
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
 * Today — one page, or one page per company the desk watches.
 *
 * THE SINGLE-PAGE READER IS THE FLOOR, NOT A FALLBACK. Every state that is not "the desk answered
 * with at least one paper" draws exactly what this tab drew before the papers feature: a phone with
 * no desk, a desk that refused, a desk one release behind with no `/api/papers` at all, an empty
 * watchlist, and the first frame of every cold launch. The pager is laid OVER it, which is also why
 * the `/news.json` fetch that happens first is not wasted — `editionUrl` falls back to the desk's
 * own device plane, which serves the board's current edition, which is page 0 of the pager. The
 * reader sees the same paper before and after the swap.
 */
export default function EditionScreen() {
  const router = useRouter()
  const { width } = useWindowDimensions()
  const { ready, doc, load } = usePapers()

  // Whether the desk can be talked to at all — the same read the Ask pill has always done, now
  // serving two purposes. `useFocusEffect` and not a mount effect, for the reason spelled out
  // where this used to live: this screen is registered first and mounts at app boot, before
  // Settings has necessarily been touched, and the tab navigator keeps it mounted across the trip
  // to Settings and back. A plain `useEffect` would run once at boot and never again, so a phone
  // set up in this session would not get a pager until it was killed and relaunched.
  const [canAsk, setCanAsk] = useState(false)
  useFocusEffect(
    useCallback(() => {
      let alive = true
      void (async () => {
        const [address, token] = await Promise.all([getDeskBaseUrl(), getDeskToken()])
        if (alive) setCanAsk(Boolean(address) && Boolean(token))
      })()
      // The list rides the same focus. `loadPapers` reads its own throttle and its own mark, so a
      // focus inside the window costs one storage read and no request — and on a phone with no
      // desk it returns before building a request at all.
      void load()
      return () => {
        alive = false
      }
    }, [load]),
  )

  const view = papersPagerView({ ready, doc })

  if (!view.pager) return <TodayEdition canAsk={canAsk} />

  return (
    <PaperPager
      papers={view.papers}
      width={width}
      canAsk={canAsk}
      onOpenAsk={() => router.push('/ask')}
      onOpenSymbol={(symbol) => router.push(`/market/${encodeURIComponent(symbol)}`)}
      onOpenTile={(tile) => router.push(`/tile/${encodeURIComponent(tile.id)}`)}
    />
  )
}

/**
 * The papers, side by side.
 *
 * A horizontal `FlatList` with `pagingEnabled` and not a pager library: `react-native-pager-view`
 * is not a dependency of this app, and a list that already knows how to virtualise, key and recycle
 * is what this needs — five pages, each a whole newspaper with decoded photographs in it.
 *
 * `getItemLayout` is what makes `initialScrollIndex` work: without it the list cannot know where
 * page three starts without measuring pages one and two, and a remembered index would scroll to the
 * wrong place or to nowhere.
 *
 * WHICH PAGE IS "NEARBY" DECIDES WHAT FETCHES; WHICH PAGE IS "ACTIVE" DECIDES WHAT THE TILE ROUTE
 * READS. The page on screen and its two neighbours fetch; the rest are mounted and idle. Exactly
 * one page is active, and it is the one that reports its settled edition upward — see `PaperPage`.
 */
function PaperPager({
  papers,
  width,
  canAsk,
  onOpenAsk,
  onOpenSymbol,
  onOpenTile,
}: {
  papers: Paper[]
  width: number
  canAsk: boolean
  onOpenAsk: () => void
  onOpenSymbol: (symbol: string) => void
  onOpenTile: (tile: Tile) => void
}) {
  // Seeded from the session's remembered page and clamped against THIS list, which may be shorter
  // than the one the index was remembered against — the watchlist is the desk's and moves.
  const [index, setIndex] = useState(() => clampPaperIndex(lastPaperIndex(), papers.length))

  // Clamped again at every use rather than only where it is set: the list can shrink under a held
  // index between renders, and an index past the end would leave no page marked active at all —
  // which would point the tile route at nothing.
  const at = clampPaperIndex(index, papers.length)

  const settle = useCallback(
    (next: number) => {
      const to = clampPaperIndex(next, papers.length)
      setIndex(to)
      rememberPaperIndex(to)
    },
    [papers.length],
  )

  return (
    <Screen edges={['top']}>
      <FlatList
        data={papers}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        initialScrollIndex={at}
        getItemLayout={(_, i) => ({ length: width, offset: width * i, index: i })}
        keyExtractor={paperKey}
        onMomentumScrollEnd={(e) =>
          settle(Math.round(e.nativeEvent.contentOffset.x / Math.max(width, 1)))
        }
        renderItem={({ item, index: i }) => (
          <PaperPage
            paper={item}
            active={i === at}
            // The page on screen and its immediate neighbours. See the doc above.
            nearby={Math.abs(i - at) <= 1}
            width={width}
            onAsk={canAsk ? onOpenAsk : undefined}
            onPressSymbol={onOpenSymbol}
            onOpenTile={onOpenTile}
          />
        )}
      />
    </Screen>
  )
}

/**
 * Today's single page — the edition itself, read on the phone.
 *
 * The material is not on the board. It is at the edition URL, which this phone already stores as
 * its own setting, and which the desk serves unauthenticated on its device plane. So this screen
 * needs no board, no token and no LAN: a phone that has never been near the hardware still reads
 * the paper, and one with no URL at all reads the demo.
 *
 * Everything about WHAT to show is decided in `useEdition`'s reducer, which is pure and tested.
 * What is left here is layout: measure the column, cut the tiles, hand them to the masonry.
 */
function TodayEdition({ canAsk }: { canAsk: boolean }) {
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
  // Whether this edition's photographs can be fetched at all. They live beside the payload at the
  // news URL, and the demo has none — so the demo is cut without them rather than drawn as three
  // empty grey boxes. Keyed with the edition so the feed is still cut once.
  const photos = state.status === 'ready' && !isDemo(state.cached)
  const feed = useMemo(
    () => (edition === null ? null : editionToTiles(edition, { photos })),
    [edition, photos],
  )

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

  // The id is the producer's own (`story:0`, `figures:1`) and travels in a path segment, so it is
  // encoded here and decoded by the router on the other side. STABLE ACROSS RENDERS, and that is
  // what it is for: it reaches every `EditionTile`, which is `React.memo`, so a fresh identity on
  // each render of this screen — every refresh spinner, every chip tap — would re-render every
  // tile on the page, SVG charts and decoded photographs included.
  const openTile = useCallback(
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
  // `demo` gates the Ask button as well as the demo chip below: the bundled edition has no desk
  // behind it, so a phone that HAS set up a desk address and token for Board control but has not
  // yet set a news URL must still see no Ask button over the demo edition it is reading instead.
  const demo = isDemo(state.cached)

  return (
    <Screen edges={['top']}>
      {/* Where this edition came from, named once for the photographs three levels down — and
          what language it is in, named once for the face everything below is set in. The second
          is the EDITION's language and not the reader's: a Korean edition on an English phone is
          still Korean, and Inter cannot set it. See `typeRamp.tsx`. */}
      <EditionSourceProvider source={state.cached.source}>
        <EditionTypeProvider lang={state.cached.edition.lang}>
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
              demo={demo}
              freshness={freshnessLabel(state.cached.fetchedAt, Date.now())}
              error={state.error}
              onRetry={onRefresh}
              onPressSymbol={() => {
                // Guarded here as well as in the masthead, which only offers the press when
                // there is a symbol: `/market/` with nothing after it matches no route and this
                // app has no `+not-found`, so the push would be a dead screen rather than a no-op.
                const symbol = state.cached.edition.subject.symbol
                if (symbol === '') return
                router.push(`/market/${encodeURIComponent(symbol)}`)
              }}
              onAsk={!demo && canAsk ? () => router.push('/ask') : undefined}
            />

            {/* The band: the lead photograph, too wide for a column, run across the page
                instead. It is a `PhotoTile` at full width — same fetch, same decode, same silent
                failure — inside a frame that owns the radius, because `PhotoTile` sets none. */}
            {band !== null ? (
              <View style={styles.band}>
                <View style={styles.bandFrame}>
                  <PhotoTile
                    // Keyed by the edition, like every tile in the masonry: the lead band is
                    // 1140x320 under the same id every edition, so without this the reused mount
                    // keeps yesterday's photograph under today's headline.
                    key={`${key}:band`}
                    tile={{ kind: 'photo', id: 'band', photo: band }}
                    width={contentWidth}
                    height={photoBoxHeight(band, contentWidth)}
                  />
                </View>
              </View>
            ) : null}

            <ChipRow chips={chips} selected={active} onSelect={setChip} />

            <View style={styles.grid}>
              <Masonry tiles={tiles} colWidth={colWidth} editionKey={key} onPress={openTile} />
            </View>
          </ScrollView>
        </EditionTypeProvider>
      </EditionSourceProvider>
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
