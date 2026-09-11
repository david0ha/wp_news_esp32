import { useEffect, useMemo, useState } from 'react'
import { ScrollView, StyleSheet, Text, View } from 'react-native'
import { ScreenMessage } from '../ScreenMessage'
import { Masthead } from './Masthead'
import { ChipRow } from './ChipRow'
import { Masonry } from './Masonry'
import { PaperPageHeader } from './PaperPageHeader'
import { EditionSourceProvider } from './editionSource'
import { EditionTypeProvider } from './typeRamp'
import { PhotoTile } from './tiles/PhotoTile'
import { usePaperPage } from '../../lib/papers/cache'
import { setCurrentEdition } from '../../lib/edition/store'
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
  type Chip as ChipName,
  type Tile,
} from '../../lib/edition/tiles'
import { type Paper } from '../../lib/desk'
import { fill, useStrings } from '../../i18n'
import { colors, layout, radius, space, type } from '../../theme'

/**
 * One company's paper, as one page of Today's pager.
 *
 * It is the SAME reader the single-page Today draws — masthead, band, chips, masonry — over a
 * different source. That sameness is the whole point of `EditionSource`: a paper arrives on the
 * control plane behind a bearer token and renders through code that does not know it.
 *
 * TWO FLAGS, NOT ONE, AND THEY ARE DIFFERENT QUESTIONS.
 *
 * `nearby` is "this page is on screen or next to it", and it is what decides whether this page
 * FETCHES. The pager mounts every paper; only the one on screen and its two neighbours ask the
 * desk for anything, which is what makes a swipe land on a page that is already there.
 *
 * `active` is "this page IS the one on screen", and it decides which settled edition the tile
 * detail route reads. A single flag cannot do both: three pages are `nearby` at once, so three
 * effects would race to write the module slot and the LAST one — a neighbour the reader cannot
 * see — would win. That is the exact failure this report-upward exists to rule out.
 */
export function PaperPage({
  paper,
  active,
  nearby,
  width,
  onAsk,
  onPressSymbol,
  onOpenTile,
}: {
  paper: Paper
  /** This page is the one on screen. Exactly one page of the pager has it. */
  active: boolean
  /** This page is on screen or immediately beside it — the pages that are allowed to fetch. */
  nearby: boolean
  /** The page's width — the pager's, not the window's, so a page fills its slot exactly. */
  width: number
  onAsk?: () => void
  onPressSymbol: (symbol: string) => void
  onOpenTile: (tile: Tile) => void
}) {
  const t = useStrings()
  // Bumped by the failed page's own "Try again" — see `usePaperPage`'s comment on `retryToken`.
  const [retryToken, setRetryToken] = useState(0)
  const page = usePaperPage(paper, nearby, retryToken)
  const [chip, setChip] = useState<ChipName>('all')

  const edition = page.status === 'ready' ? page.cached.edition : null
  const settled = page.status === 'ready' ? page.cached : null

  // THE SETTLED ENTRY, REPORTED UPWARD BY THE PAGE THAT RENDERED IT.
  //
  // `/tile/[id]` reads the edition on screen out of the module slot in `lib/edition/store.ts`
  // rather than from a prop, so something has to keep that slot pointed at the page the reader is
  // actually on — otherwise a tap on a tile opens another company's story.
  //
  // It is done HERE, and not by the pager reading `readPaperCache` on `[papers, index]`, because
  // that read cannot fire for the page on screen at first load: nothing is filed in the cache at
  // the moment the pager would look, and the `Map` notifies nobody when the fetch later lands. The
  // page, on the other hand, re-renders the instant its own state settles — which is exactly when
  // there is something true to report.
  useEffect(() => {
    if (active && settled !== null) setCurrentEdition(settled)
  }, [active, settled])

  // A paper always has photographs to fetch — it came from the desk, over a credential that also
  // reaches its tiles. The `isDemo` question the single-page reader asks cannot arise here.
  const feed = useMemo(
    () => (edition === null ? null : editionToTiles(edition, { photos: true })),
    [edition],
  )

  const chips: ChipName[] = feed === null ? ['all'] : availableChips(feed.tiles)
  const shownChip = resolveChip(chips, chip)
  const tiles = feed === null ? [] : filterTiles(feed.tiles, shownChip)
  const colWidth = columnWidth(width, layout.gutter, COLUMN_GAP)
  const contentWidth = width - 2 * layout.gutter

  if (page.status === 'placeholder') {
    return (
      <View style={[styles.page, { width }]}>
        <PaperPageHeader paper={paper} now={Date.now()} />
        <View style={styles.centred}>
          <Text style={type.headingSm}>
            {fill(t.papers.placeholder.title, { symbol: paper.symbol })}
          </Text>
          <Text style={styles.body}>{t.papers.placeholder.body}</Text>
        </View>
      </View>
    )
  }

  if (page.status === 'loading') {
    return (
      <View style={[styles.page, { width }]}>
        <PaperPageHeader paper={paper} now={Date.now()} />
        <ScreenMessage loading />
      </View>
    )
  }

  if (page.status === 'error') {
    return (
      <View style={[styles.page, { width }]}>
        <PaperPageHeader paper={paper} now={Date.now()} />
        <ScreenMessage
          error={fill(t.papers.pageFailed, { detail: page.error })}
          onRetry={() => setRetryToken((n) => n + 1)}
        />
      </View>
    )
  }

  const cached = page.cached
  const band = feed?.band ?? null
  const key = editionKey(cached)

  return (
    <View style={[styles.page, { width }]}>
      {/* This page's own source and its own language — not the pager's and not the phone's. */}
      <EditionSourceProvider source={cached.source}>
        <EditionTypeProvider lang={cached.edition.lang}>
          <ScrollView contentContainerStyle={styles.scroll}>
            <PaperPageHeader paper={paper} now={Date.now()} />
            <Masthead
              edition={cached.edition}
              demo={false}
              // The desk CONFIRMED this payload when this phone fetched it, which is the question
              // the masthead's line answers. How old the paper itself is, is the header's line
              // above — two different facts, and collapsing them would say a paper written
              // yesterday was "updated just now" because the phone fetched it a moment ago.
              freshness={freshnessLabel(cached.fetchedAt, Date.now())}
              error={null}
              onRetry={() => undefined}
              onPressSymbol={() => {
                const symbol = cached.edition.subject.symbol
                if (symbol === '') return
                onPressSymbol(symbol)
              }}
              onAsk={onAsk}
            />

            {band !== null ? (
              <View style={styles.band}>
                <View style={styles.bandFrame}>
                  <PhotoTile
                    key={`${key}:band`}
                    tile={{ kind: 'photo', id: 'band', photo: band }}
                    width={contentWidth}
                    height={photoBoxHeight(band, contentWidth)}
                  />
                </View>
              </View>
            ) : null}

            <ChipRow chips={chips} selected={shownChip} onSelect={setChip} />

            <View style={styles.grid}>
              <Masonry tiles={tiles} colWidth={colWidth} editionKey={key} onPress={onOpenTile} />
            </View>
          </ScrollView>
        </EditionTypeProvider>
      </EditionSourceProvider>
    </View>
  )
}

const styles = StyleSheet.create({
  page: {
    flex: 1,
    // Each page is one `FlatList` item at a fixed `width`, side by side with its neighbours in the
    // same row — without this, a child that renders even a pixel past that width (the chip row's
    // horizontal `ScrollView`, at rest, on some layouts) paints into the page beside it rather than
    // being cut at the boundary the pager itself promises every page.
    overflow: 'hidden',
  },
  scroll: {
    paddingBottom: space.xxl,
  },
  centred: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: layout.gutter,
    gap: space.sm,
  },
  body: {
    ...type.body,
    color: colors.textDim,
    textAlign: 'center',
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
