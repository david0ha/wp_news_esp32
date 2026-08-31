import { useCallback, useState } from 'react'
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
import { SheetPreview } from '../../components/today/SheetPreview'
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
  useSheet,
} from '../../lib/queries'
import { DeskError, deskHumanError } from '../../lib/desk'
import { formatSinceTime } from '../../lib/format'
import { colors, spacing } from '../../theme/index'

// The desk's own proof-sheet names (desk.test.ts, server/test/test_http.py) — not the board's
// PAGE_LABELS in format.ts, which name the physical panel's two pages for a different plane.
const SHEET_NAMES = ['A1.png', 'A2.png'] as const

/**
 * Today — the masthead, the sheet on the glass, and the day's edition in one column (plan Design
 * > Wireframes). `<SheetPreview>` is a dumb stand-in for Task 26's real `<OnTheGlass>` (see its
 * own doc comment); everything else here is this task's.
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
  const sheet = useSheet(currentEid ?? '', SHEET_NAMES[pageIndex])

  const onRefresh = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: deskKeys.state() })
    queryClient.invalidateQueries({ queryKey: deskKeys.news() })
  }, [])

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
            refreshing={deskState.isRefetching || news.isRefetching}
            onRefresh={onRefresh}
            tintColor={colors.signal.chrome.tint}
          />
        }
      >
        <Animated.View
          key={`head-${revealKey}`}
          entering={reducedMotion ? undefined : FadeInDown.duration(260)}
          style={styles.header}
        >
          <Masthead
            dateline={payload?.dateline ?? ''}
            edition={payload?.edition ?? ''}
            style={styles.masthead}
          />
          <HeaderGear />
        </Animated.View>

        {news.isLoading ? (
          <ScreenMessage loading />
        ) : news.isError ? (
          <ScreenMessage
            error={
              news.error instanceof DeskError
                ? deskHumanError(news.error)
                : 'Couldn’t load today’s edition.'
            }
            onRetry={() => news.refetch()}
          />
        ) : payload ? (
          <>
            <Animated.View
              key={`glass-${revealKey}`}
              entering={reducedMotion ? undefined : FadeInDown.delay(70).duration(260)}
            >
              <SheetPreview
                sheetSource={sheet.data}
                since={since}
                pageIndex={pageIndex}
                onChangePage={setPageIndex}
              />
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
                {payload.figures.length > 0 ? (
                  <>
                    <Standing label="THE DOSSIER" tone="paper" />
                    <DossierRail
                      figures={payload.figures}
                      hasNotes={edition.data?.has_notes ?? false}
                      onPressNotes={
                        currentEid ? () => router.push(`/notes/edition/${currentEid}`) : undefined
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
  paper: {
    gap: spacing[16],
  },
})
