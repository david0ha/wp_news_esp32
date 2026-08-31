import { useCallback, useEffect, useState } from 'react'
import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useIsFocused, useRouter } from 'expo-router'
import { Screen } from '../../components/Screen'
import { HeaderGear } from '../../components/HeaderGear'
import { EmptyState } from '../../components/EmptyState'
import { ScreenMessage } from '../../components/ScreenMessage'
import { GlassSection } from '../../components/board/GlassSection'
import { SourceSection } from '../../components/board/SourceSection'
import { PowerSection } from '../../components/board/PowerSection'
import { ActionsSection } from '../../components/board/ActionsSection'
import { useDevice } from '../../lib/device'
import {
  useDeviceState,
  useDisplayTest,
  usePullRefresh,
  useRefreshBoard,
  useSetPage,
  useSetSleep,
} from '../../lib/queries'
import { Esp32Error, humanError } from '../../lib/esp32'
import { DEFAULT_HOST, discoverDevice } from '../../lib/discovery'
import { getDeviceBaseUrl } from '../../lib/store'
import { refreshWindowMs } from '../../lib/format'
import { ONBOARDING_ROUTES } from '../../onboarding/flow'
import { colors, spacing, typography } from '../../theme/index'

/**
 * Board — the hardware: what hangs on the glass, where it fetches from, how it sleeps (plan Design
 * > Wireframes).
 *
 * Four sections, split out of the pre-redesign dashboard: the glass itself (`GlassSection`), the
 * page control and the commands the board answers to (`ActionsSection`), where the edition comes
 * from (`SourceSection`), and the deep-sleep design measuring itself (`PowerSection`). All chrome,
 * like Desk — this tab issues commands to hardware, it does not print a sheet, and unlike Today it
 * is the one screen allowed to wake the board and read its own framebuffer.
 */
export default function Board() {
  const router = useRouter()
  const { baseUrl, hasDevice, setBaseUrl } = useDevice()

  // THE POLL IS GATED ON FOCUS, and this is the one line on this screen that costs somebody's
  // battery if it is wrong. `useDeviceState` carries a five-second `refetchInterval`, and every
  // request restarts the board's awake window (docs/app-control.md) — so a poll that keeps running
  // from another tab is this app holding a sleeping board awake for as long as the phone is open.
  //
  // `hasDevice` alone will not do it. It is a property of storage, not of what is on screen, and
  // `NativeTabs` keeps a tab mounted once it has been visited — so without this, opening Board
  // once and walking away to Today polls the board forever. `focusManager` does not cover it
  // either: it is wired to AppState (`app/_layout.tsx`), so it pauses a backgrounded app and knows
  // nothing about which tab is in front. The screen this replaced said the same thing with
  // `useFocusEffect` around its own interval — "pauses polling when the user navigates away".
  const isFocused = useIsFocused()
  const deviceState = useDeviceState(hasDevice && isFocused)
  const setPage = useSetPage()
  const refreshBoard = useRefreshBoard()
  const setSleep = useSetSleep()
  const displayTest = useDisplayTest()

  // A page the user asked for that the board has not confirmed yet. A page change is a full
  // refresh of a 13.3" Spectra 6 panel — twenty to thirty seconds — so without this the segmented
  // control snaps back to the old page and looks like the tap was lost.
  const [pendingPage, setPendingPage] = useState<number | null>(null)
  const [refreshingUntilMs, setRefreshingUntilMs] = useState<number | undefined>(undefined)
  // A command that came back an error, in its own state — NOT read off `deviceState`, which is the
  // poll and answers a different question. Without this a failed command is silent: a self-test or
  // a sleep write that the board refused shows nothing at all, and a failed page switch is worse
  // than silent, because `pendingPage` is already set and the reconcile effect below cannot clear
  // it (its dependency is `state?.page`, which does not change when the switch never happened) —
  // so the control keeps showing the page the user tapped and the note keeps saying "Switching…"
  // indefinitely. Clearing it on the error path is what ends that.
  const [commandError, setCommandError] = useState<string | null>(null)

  const state = deviceState.data

  // Reconcile the pending page against whatever the board just reported, the moment it reports it —
  // the same rule dashboard.tsx's `load()` applied inline, now driven by react-query's own data
  // rather than a manual poll.
  useEffect(() => {
    if (state === undefined) return
    setPendingPage((p) => (p === null || p === state.page ? null : p))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state?.page])

  // Every command the board answers to shares ONE busy flag: a page switch, a poll, a self-test and
  // a sleep write are all commands to the same board, and letting two race is how a segmented
  // control ends up disagreeing with the board it just told to change.
  const busy = setPage.isPending || refreshBoard.isPending || setSleep.isPending || displayTest.isPending

  // Arms the refresh ring over the panel's own measured refresh time — read fresh at the moment a
  // page switch or a poll-now succeeds, not cached, since a longer-ago measurement would sweep the
  // wrong duration for THIS refresh.
  const armRing = useCallback(() => {
    setRefreshingUntilMs(Date.now() + refreshWindowMs(state?.panel.refreshMs ?? 0))
  }, [state?.panel.refreshMs])

  // One error handler for all four commands, because they are four commands to one board and the
  // reader wants the board's sentence rather than the button's. `humanError` carries the one that
  // matters most — a timeout is a board asleep, not a fault to go looking for.
  const onCommandError = useCallback((e: unknown) => {
    setCommandError(
      e instanceof Esp32Error ? humanError(e) : 'That command failed. Please try again.',
    )
  }, [])
  // Fired the moment a button is pressed: the previous failure is about the previous attempt, and
  // leaving it up beside a command in flight reads as this one having failed already.
  const clearCommandError = useCallback(() => setCommandError(null), [])

  // "Couldn't reach the board" retry: the saved address may be stale after the user rejoined their
  // home Wi-Fi or the board took a new DHCP lease. Re-probe the LAN (saved address + the mDNS
  // name), persist whichever answers, then reload.
  const retry = useCallback(async () => {
    const saved = await getDeviceBaseUrl()
    const found = await discoverDevice([saved, baseUrl, `http://${DEFAULT_HOST}`])
    if (found && found !== baseUrl) {
      await setBaseUrl(found)
      // `useDevice()`'s client is recreated from the new baseUrl on the next render, so the
      // refetch right below can still land on the stale client if it races that render. Not a
      // bug to chase: `useDeviceState`'s own 5s `refetchInterval` self-corrects a beat later
      // either way, hitting the rediscovered board on its next tick.
    }
    await deviceState.refetch()
  }, [baseUrl, setBaseUrl, deviceState])

  const { pulling, onRefresh } = usePullRefresh(() => deviceState.refetch())

  // Still resolving the base URL from storage — a brief moment on cold start, before `hasDevice`
  // is known either way.
  if (baseUrl === null) {
    return (
      <Screen edges={['top']}>
        <Header />
        <ScreenMessage loading message="Connecting…" />
      </Screen>
    )
  }

  if (!hasDevice) {
    return (
      <Screen edges={['top']}>
        <Header />
        <EmptyState
          title="No board paired"
          body="Pair a board in Settings and this page shows what is on its glass."
          actionLabel="Pair a board"
          onAction={() => router.push(ONBOARDING_ROUTES['turn-on'])}
        />
      </Screen>
    )
  }

  if (state === undefined) {
    return (
      <Screen edges={['top']}>
        <Header />
        <ScreenMessage
          loading={!deviceState.isError}
          error={
            deviceState.isError
              ? deviceState.error instanceof Esp32Error
                ? humanError(deviceState.error)
                : 'Couldn’t reach the board.'
              : null
          }
          onRetry={retry}
        />
      </Screen>
    )
  }

  return (
    <Screen edges={['top']}>
      <Header />
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
        <GlassSection state={state} focused={isFocused} refreshingUntilMs={refreshingUntilMs} />

        <ActionsSection
          state={state}
          focused={isFocused}
          pendingPage={pendingPage}
          busy={busy}
          onSetPage={(page) => {
            clearCommandError()
            setPendingPage(page)
            setPage.mutate(page, {
              onSuccess: armRing,
              onError: (e) => {
                // The board never took the page, so the optimistic one is a lie with nothing left
                // to correct it. Snapping the control back is half the fix; the sentence is the
                // other half, or the tap simply appears to have been lost.
                setPendingPage(null)
                onCommandError(e)
              },
            })
          }}
          onPollNow={() => {
            clearCommandError()
            refreshBoard.mutate(undefined, { onSuccess: armRing, onError: onCommandError })
          }}
          onSelfTest={() => {
            clearCommandError()
            displayTest.mutate(undefined, { onError: onCommandError })
          }}
        />

        <SourceSection source={state.source} />

        <PowerSection
          power={state.power}
          battery={state.battery}
          busy={busy}
          onPickSleep={(seconds) => {
            clearCommandError()
            setSleep.mutate(seconds, { onError: onCommandError })
          }}
        />

        {/* TWO ERROR LINES, because they are two different failures and the copy this screen used
            to carry said "That command failed" on the branch that can only be a poll. A command is
            something the reader just asked for and is waiting on; a failed poll is the background
            read going quiet under content that is still on screen and still true. */}
        {commandError ? <Text style={styles.errorLine}>{commandError}</Text> : null}
        {deviceState.isError ? (
          <Text style={styles.errorLine}>
            {deviceState.error instanceof Esp32Error
              ? humanError(deviceState.error)
              : 'Couldn’t reach the board just now. Everything above is the last answer that came back.'}
          </Text>
        ) : null}
      </ScrollView>
    </Screen>
  )
}

function Header() {
  return (
    <View style={styles.header}>
      <Text style={[typography.uiStrong, styles.title]}>Board</Text>
      <HeaderGear />
    </View>
  )
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing[16],
    paddingTop: spacing[8],
  },
  title: {
    fontSize: 22,
    color: colors.deskText,
  },
  scroll: {
    padding: spacing[16],
    gap: spacing[24],
    paddingBottom: spacing[40],
  },
  errorLine: {
    ...typography.ui,
    fontSize: 13,
    color: colors.signal.chrome.down,
    textAlign: 'center',
  },
})
