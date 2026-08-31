import { useState } from 'react'
import { RefreshControl, ScrollView, StyleSheet, View } from 'react-native'
import { useRouter } from 'expo-router'
import Animated, { FadeInDown, useReducedMotion } from 'react-native-reanimated'
import { Screen } from '../../components/Screen'
import { HeaderGear } from '../../components/HeaderGear'
import { Sheet } from '../../components/Sheet'
import { Standing } from '../../components/Standing'
import { EmptyState } from '../../components/EmptyState'
import { ScreenMessage } from '../../components/ScreenMessage'
import { Masthead } from '../../components/today/Masthead'
import { OnTheGlass } from '../../components/OnTheGlass'
import { SegmentedControl } from '../../components/SegmentedControl'
import { LeadStory } from '../../components/today/LeadStory'
import { MoreStories } from '../../components/today/MoreStories'
import { Briefs } from '../../components/today/Briefs'
import { DossierRail } from '../../components/today/DossierRail'
import {
  deskKeys,
  queryClient,
  useDeskClient,
  useDeskState,
  useEdition,
  useNews,
  usePullRefresh,
  useSheet,
} from '../../lib/queries'
import { deskHumanError } from '../../lib/desk'
import { formatSinceTime } from '../../lib/format'
import { sheetForPage } from '../../lib/sheets'
import { colors, spacing } from '../../theme/index'

/**
 * Today — the masthead, the sheet on the glass, and the day's edition in one column (plan Design
 * > Wireframes).
 *
 * The sheet here is `<OnTheGlass state="proof">`: the desk's own render of the current edition,
 * not the board's framebuffer. Today does not know whether a board exists, and asking one would
 * wake it — the Board tab is where the live glass belongs. What Today shows is what the desk
 * published, which is what the board is printing whenever it has managed a poll.
 */
export default function Today() {
  const router = useRouter()
  const reducedMotion = useReducedMotion()
  const [pageIndex, setPageIndex] = useState(0)

  const client = useDeskClient()
  const deskState = useDeskState()
  const news = useNews()

  const currentEid = deskState.data?.current ?? null
  // getState()'s `editions` rows never carry a real has_notes (only a per-edition GET reads it off
  // disk — desk.ts's own comment on EditionMeta), so has_notes and the "since" stamp both come from
  // this dedicated fetch rather than from deskState.data.editions.
  const edition = useEdition(currentEid ?? '')
  // The names are the gate's, not ours: `01_a1_full.png` today, a `.bmp` where a render died. The
  // list is read off disk per request and only a per-edition GET carries it, which is the other
  // reason this screen fetches the edition rather than reading the row out of `getState()`.
  const sheetName = sheetForPage(edition.data?.sheets ?? [], pageIndex)
  const sheet = useSheet(currentEid ?? '', sheetName ?? '')

  // The two keys this screen reads. The spinner is local to the gesture — see `usePullRefresh`.
  const { pulling, onRefresh } = usePullRefresh(() =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: deskKeys.state() }),
      queryClient.invalidateQueries({ queryKey: deskKeys.news() }),
    ]),
  )

  if (client === null) {
    return (
      <Screen edges={['top']}>
        <View style={[styles.header, styles.headerGutter]}>
          <Masthead dateline="" edition="" style={styles.masthead} />
          <HeaderGear />
        </View>
        <EmptyState
          title="No desk yet"
          body="Add its address and operator token in Settings, and the day's edition appears here."
          actionLabel="Open settings"
          onAction={() => router.push('/settings')}
        />
      </Screen>
    )
  }

  const payload = news.data
  // The reveal's identity: `generated_at` rather than the desk's `current` id, so the cascade still
  // fires for a producer-only token that can read /news.json but gets a 401 from /api/state (that
  // query failing must not silently disable the animation on top of everything else it costs).
  const revealKey = payload?.generated_at ?? 'initial'
  const since = edition.data?.published_at ? formatSinceTime(edition.data.published_at) : undefined
  const lead = payload && payload.stories.length > 0 ? payload.stories[0] : null

  return (
    <Screen edges={['top']}>
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
        {payload ? (
          // Keyed and animated only once there is real content: gating this on `payload` (rather
          // than rendering unconditionally with `revealKey` falling back to a sentinel) is what
          // keeps the cold-load sequence a single cascade — mount once, with the dateline already
          // populated — instead of an empty FadeIn immediately followed by a second one when the
          // fetch resolves.
          <Animated.View
            key={`head-${revealKey}`}
            entering={reducedMotion ? undefined : FadeInDown.duration(260)}
            style={styles.header}
          >
            <Masthead dateline={payload.dateline} edition={payload.edition} style={styles.masthead} />
            <HeaderGear />
          </Animated.View>
        ) : (
          <View style={styles.header}>
            <Masthead dateline="" edition="" style={styles.masthead} />
            <HeaderGear />
          </View>
        )}

        {news.isLoading ? (
          <ScreenMessage loading />
        ) : news.isError ? (
          <ScreenMessage
            error={deskHumanError(news.error, 'Couldn’t load today’s edition.')}
            onRetry={() => news.refetch()}
          />
        ) : payload ? (
          <>
            <Animated.View
              key={`glass-${revealKey}`}
              entering={reducedMotion ? undefined : FadeInDown.delay(70).duration(260)}
            >
              <View style={styles.glass}>
                <OnTheGlass
                  state="proof"
                  imageUri={sheet.data?.uri}
                  imageHeaders={sheet.data?.headers}
                  since={since}
                  // Only openable once there is something to open — a viewer raised over an
                  // edition whose sheets were pruned would be a full-screen empty box.
                  onPress={
                    currentEid && sheetName
                      ? () =>
                          router.push(
                            `/sheet/proof?eid=${encodeURIComponent(currentEid)}&page=${pageIndex}`,
                          )
                      : undefined
                  }
                />
                <SegmentedControl
                  segments={['A1', 'A2']}
                  selectedIndex={pageIndex}
                  onChange={setPageIndex}
                />
              </View>
            </Animated.View>

            <Animated.View
              key={`paper-${revealKey}`}
              entering={reducedMotion ? undefined : FadeInDown.delay(140).duration(260)}
            >
              <Sheet style={styles.paper}>
                {lead ? <LeadStory story={lead} /> : null}
                {payload.stories.length > 1 ? (
                  <>
                    <Standing label="MORE" tone="paper" />
                    <MoreStories stories={payload.stories.slice(1)} />
                  </>
                ) : null}
                {payload.briefs.length > 0 ? (
                  <>
                    <Standing label="BRIEFS" tone="paper" />
                    <Briefs briefs={payload.briefs} />
                  </>
                ) : null}
                {payload.figures.length > 0 || edition.data?.has_notes ? (
                  <>
                    <Standing label="THE DOSSIER" tone="paper" />
                    <DossierRail
                      figures={payload.figures}
                      hasNotes={edition.data?.has_notes ?? false}
                      onPressNotes={
                        currentEid
                          ? () => router.push(`/notes/editions/${encodeURIComponent(currentEid)}`)
                          : undefined
                      }
                    />
                  </>
                ) : null}
              </Sheet>
            </Animated.View>
          </>
        ) : null}
      </ScrollView>
    </Screen>
  )
}

const styles = StyleSheet.create({
  scroll: {
    padding: spacing[16],
    gap: spacing[16],
  },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  // Only the empty-state path needs this: the loaded path's header sits inside the ScrollView's
  // own `padding: spacing[16]` contentContainerStyle, which the early-return empty state bypasses.
  headerGutter: {
    paddingHorizontal: spacing[16],
    paddingTop: spacing[8],
  },
  masthead: {
    flex: 1,
  },
  // The sheet and the page switcher are one block: the control acts on the paper above it, and a
  // gap of the column's own size between them would read as two unrelated things.
  glass: {
    gap: spacing[12],
  },
  paper: {
    gap: spacing[16],
  },
})
