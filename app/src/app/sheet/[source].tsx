import { useMemo, useState } from 'react'
import { ActivityIndicator, StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native'
import { Image } from 'expo-image'
import Animated, { FadeIn, useReducedMotion } from 'react-native-reanimated'
import { ResumableZoom, fitContainer } from 'react-native-zoom-toolkit'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { Button } from '../../components/Button'
import { Stamp } from '../../components/Stamp'
import { Esp32Error, humanError } from '../../lib/esp32'
import { DeskError, deskHumanError } from '../../lib/desk'
import { useBoardScreen, useDeviceState, useEdition, useSheet } from '../../lib/queries'
import { sheetForPage } from '../../lib/sheets'
import { pageLabel } from '../../lib/format'
import { SCREEN_H, SCREEN_W } from '../../lib/screen'
import { colors, motion, radius, spacing, typography } from '../../theme/index'

const SHEET_ASPECT = SCREEN_W / SCREEN_H

/**
 * One sheet, full size and pinch-zoomable — raised by tapping the paper anywhere it appears
 * (plan Design > Signature). A `formSheet` on purpose (see `app/_layout.tsx`): what raised it stays
 * visible behind, because you are looking AT a sheet rather than navigating away to one.
 *
 * `source` names which sheet is WANTED, not which one is shown:
 *
 *   /sheet/board?eid=<id>&page=<0|1>   the board's own glass, decoded from `/api/screen`
 *   /sheet/proof?eid=<id>&page=<0|1>   the desk's proof of that edition
 *
 * The order is the same one `<OnTheGlass>` documents, and the fallback is the reason `eid` is
 * carried even on the board route: a board on a battery is unreachable most of the time BY DESIGN,
 * and the desk's proof of the same edition is a better answer than an apology. What it cannot be
 * is a SILENT answer — the proof is what the desk rendered, not what is physically printed, and the
 * two differ exactly when a poll failed. So the swap is always said out loud beneath the sheet.
 */
export default function SheetViewer() {
  const router = useRouter()
  const reducedMotion = useReducedMotion()
  const params = useLocalSearchParams<{ source: string; eid?: string; page?: string }>()

  const wantsBoard = params.source === 'board'
  const eid = params.eid ?? ''
  const page = params.page === '1' ? 1 : 0

  // Poll the board only on the board route. Every other screen that merely mentions the glass must
  // not wake a sleeping board by being open (queries.ts's own rule for `useDeviceState`).
  const deviceState = useDeviceState(wantsBoard)
  const board = useBoardScreen(deviceState.data, wantsBoard)

  const edition = useEdition(eid)
  const sheetName = sheetForPage(edition.data?.sheets ?? [], page)
  const proof = useSheet(eid, sheetName ?? '')

  const boardUri = board.data ? `data:image/png;base64,${board.data}` : null
  const showingBoard = wantsBoard && boardUri !== null
  const fellBackToProof = wantsBoard && !showingBoard && proof.data !== undefined

  const [box, setBox] = useState({ width: 0, height: 0 })
  const onLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout
    setBox({ width, height })
  }
  // The sheet keeps 1200 x 1600 at every size. `fitContainer` is the library's own letterboxing,
  // used here on the JS thread simply because it is the same arithmetic and already written.
  const fitted = useMemo(
    () => (box.width > 0 && box.height > 0 ? fitContainer(SHEET_ASPECT, box) : null),
    [box],
  )

  const boardError = board.isError
    ? board.error instanceof Esp32Error
      ? humanError(board.error)
      : 'Couldn’t read the page off the board.'
    : null
  const proofError = proof.isError
    ? proof.error instanceof DeskError
      ? deskHumanError(proof.error)
      : 'Couldn’t load the desk’s proof of this edition.'
    : null

  const busy = wantsBoard ? board.isFetching : proof.isLoading
  const uri = showingBoard ? boardUri : proof.data?.uri
  const headers = showingBoard ? undefined : proof.data?.headers

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Stamp tone="chrome">
          {showingBoard ? 'on the glass' : `proof — ${pageLabel(page)}`}
        </Stamp>
        <Button label="Done" variant="ghost" onPress={() => router.back()} />
      </View>

      {/* Two views, because `onLayout` reports a view's BORDER box: measuring the padded one
          would hand `fitContainer` sixteen points of padding on each side as though they were
          paper, and the sheet would be drawn wider than the space it has to sit in. */}
      <View style={styles.body}>
        <View style={styles.measure} onLayout={onLayout}>
          {uri && fitted ? (
            <Animated.View
              // The one animation this screen owns, so it is the one that takes the app's spring.
              // ResumableZoom's own settle after a pinch is the library's hardcoded `withTiming`
              // and is not configurable through any prop it exposes — see its `usePinchCommons`.
              entering={
                reducedMotion
                  ? undefined
                  : FadeIn.springify()
                      .damping(motion.spring.damping)
                      .stiffness(motion.spring.stiffness)
                      .mass(motion.spring.mass)
              }
            >
              <ResumableZoom
                maxScale={4}
                minScale={1}
                // The sheet is 1200 px wide against roughly a thousand device pixels of width, so 1x
                // is already close to 1:1 and 4x is real magnification of a 16 px serif — the same
                // ceiling the screen this replaced used on its UIScrollView.
                panMode="clamp"
                scaleMode="bounce"
              >
                <Image
                  source={{ uri, ...(headers ? { headers } : null) }}
                  // The paper's own edge, on the IMAGE rather than on a frame around it, so the
                  // hairline scales with the sheet under a pinch instead of standing still while the
                  // page grows through it.
                  style={[styles.paper, { width: fitted.width, height: fitted.height }]}
                  contentFit="contain"
                  accessibilityIgnoresInvertColors
                  accessibilityLabel={
                    showingBoard
                      ? 'The page currently printed on the board'
                      : 'The desk’s proof of this page'
                  }
                />
              </ResumableZoom>
            </Animated.View>
          ) : busy ? (
            <View style={styles.center}>
              <ActivityIndicator color={colors.signal.chrome.tint} />
              {wantsBoard ? (
                <Text style={styles.note}>
                  Reading 960,000 bytes off the board, then drawing them.
                </Text>
              ) : null}
            </View>
          ) : (
            <View style={styles.center}>
              <Text style={styles.error}>
                {boardError ?? proofError ?? 'Nothing to show for this page yet.'}
              </Text>
              {/* The awake window, said in full. A board with deep sleep on is unreachable most of
                  the time BY DESIGN — it wakes for about three seconds, asks its desk one question,
                  and goes back down without running a server. There is no fault here to find, and
                  sending someone to look for one is the failure this screen avoids. */}
              {wantsBoard ? (
                <Text style={styles.note}>
                  A board on a battery only answers while it is awake. Press a button on it — that
                  holds it awake for a couple of minutes, and every request restarts the clock.
                </Text>
              ) : null}
            </View>
          )}
        </View>
      </View>

      {/* Rendered only when it has something to say. An empty footer still costs its padding, and
          that reads as the sheet hanging off-centre for no reason a viewer could see. */}
      {fellBackToProof || showingBoard ? (
        <View style={styles.footer}>
          {fellBackToProof ? (
            <Text style={styles.note}>
              {boardError
                ? `${boardError} This is the desk’s proof of the same edition, not a fresh read of the glass.`
                : 'This is the desk’s proof of the same edition, not a fresh read of the glass.'}
            </Text>
          ) : null}
          {showingBoard ? (
            <>
              <Text style={styles.note}>
                This is the framebuffer itself, in the measured inks. A frame caught mid-render can
                show part of one edition and part of the next — that is the download, not the panel.
                Fetch it again.
              </Text>
              <Button
                label="Fetch it again"
                variant="secondary"
                loading={board.isFetching}
                onPress={() => board.refetch()}
              />
            </>
          ) : null}
        </View>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.desk,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingLeft: spacing[16],
    paddingRight: spacing[8],
    paddingTop: spacing[8],
  },
  body: {
    flex: 1,
    paddingHorizontal: spacing[16],
    paddingVertical: spacing[12],
  },
  measure: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // A sheet on a desk, not a card: square-cut, hairline `ink` edge, exactly as it appears on
  // Today. Only the size changes when it is raised.
  paper: {
    backgroundColor: colors.paper,
    borderRadius: radius.paper,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.ink,
  },
  center: {
    alignItems: 'center',
    gap: spacing[12],
    paddingHorizontal: spacing[24],
  },
  footer: {
    gap: spacing[12],
    paddingHorizontal: spacing[16],
    paddingBottom: spacing[24],
    paddingTop: spacing[12],
  },
  note: {
    ...typography.ui,
    fontSize: 12,
    color: colors.deskFaint,
    lineHeight: 17,
    textAlign: 'center',
  },
  error: {
    ...typography.ui,
    color: colors.signal.chrome.down,
    textAlign: 'center',
    lineHeight: 21,
  },
})
