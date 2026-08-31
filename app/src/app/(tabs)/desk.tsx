import { useState } from 'react'
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useRouter } from 'expo-router'
import Animated, { useReducedMotion } from 'react-native-reanimated'
import { Button } from '../../components/Button'
import { Card } from '../../components/Card'
import { EmptyState } from '../../components/EmptyState'
import { HeaderGear } from '../../components/HeaderGear'
import { Screen } from '../../components/Screen'
import { ScreenMessage } from '../../components/ScreenMessage'
import { Standing } from '../../components/Standing'
import { DirectiveList } from '../../components/desk/DirectiveList'
import { HoldCard } from '../../components/desk/HoldCard'
import { QueueList } from '../../components/desk/QueueList'
import { ScheduleCard } from '../../components/desk/ScheduleCard'
import { StateStrip } from '../../components/desk/StateStrip'
import {
  deskKeys,
  queryClient,
  useAudit,
  useDeskClient,
  useDeskNow,
  useDeskState,
  usePullRefresh,
} from '../../lib/queries'
import { DeskError, deskHumanError } from '../../lib/desk'
import { auditEventLine, auditWhen } from '../../lib/audit'
import { colors, pressTransition, pressedScale, spacing, typography } from '../../theme/index'

/** The last twenty rows of the desk's own record — the foot of this tab. */
const AUDIT_ROWS = 20

/**
 * Desk — what the desk is holding, what it is about to print, and the queue behind it (plan Design
 * > Wireframes).
 *
 * The one tab that is nearly all chrome. Today and Watch are about paper and carry the newspaper
 * faces; this one issues commands, so it is the system font and rounded corners the whole way down
 * — the two rules a diff can check, applied to the screen that is furthest from being a sheet.
 *
 * NOTHING HERE ASKS "ARE YOU SURE". Cancel, publish and hold are all reversible on the desk's own
 * terms — a hold lifts with the button beside it, a cancelled command can be filed again, and every
 * edition is still a directory that `promote` can put back up. What the controls do instead is go
 * quiet while their request is in flight, so a second tap cannot land on a request that is already
 * running. See `<HoldCard>` for the same argument at the point it costs the most.
 *
 * ORDER is two buttons onto ONE sheet. `compose` takes a `?kind=`, so "Order today's edition" and
 * "Research a ticker" are the same form with a different segment preselected — the reader can
 * change their mind inside the sheet without backing out of it.
 */
export default function Desk() {
  const router = useRouter()
  const client = useDeskClient()
  const state = useDeskState()
  const audit = useAudit(AUDIT_ROWS)
  const now = useDeskNow()
  const [editionsPressed, setEditionsPressed] = useState(false)
  const reducedMotion = useReducedMotion()

  // The whole desk namespace: every section on this tab reads a different key off the same server,
  // and a pull that refreshed only the state strip would leave the queue underneath it describing a
  // moment that has passed. (Why the spinner is local state and not a query flag: `usePullRefresh`.)
  const { pulling, onRefresh } = usePullRefresh(() =>
    queryClient.invalidateQueries({ queryKey: deskKeys.all }),
  )

  if (client === null) {
    return (
      <Screen edges={['top']}>
        <Header />
        <EmptyState
          title="No desk yet"
          body="Add its address and operator token in Settings, and what it’s holding appears here."
          actionLabel="Open settings"
          onAction={() => router.push('/settings')}
        />
      </Screen>
    )
  }

  return (
    <Screen edges={['top']}>
      <Header />

      <ScrollView
        contentContainerStyle={styles.scroll}
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl
            refreshing={pulling}
            onRefresh={onRefresh}
            tintColor={colors.signal.chrome.tint}
          />
        }
      >
        {/* THE ERROR CARD REPLACES THE STRIP ONLY WHEN THERE IS NOTHING TO REPLACE IT WITH.
            `isError` is true after a failed REFETCH while react-query still holds the last good
            snapshot, and this query polls every fifteen seconds over a tunnel — so branching on
            the flag alone would blank a populated four-row strip on one dropped poll and restore
            it fifteen seconds later, flapping, while `<HoldCard>` underneath went on rendering
            from the snapshot that was still there. The house posture is the panel's own: a stale
            page that says it is stale beats an empty one. */}
        {state.isError && state.data === undefined ? (
          <Card style={styles.stateError}>
            <ScreenMessage
              error={
                state.error instanceof DeskError
                  ? deskHumanError(state.error)
                  : 'Couldn’t read what the desk is doing.'
              }
              onRetry={() => state.refetch()}
            />
          </Card>
        ) : (
          <>
            {state.isError ? (
              <Text style={styles.stale}>
                {state.error instanceof DeskError
                  ? deskHumanError(state.error)
                  : 'Couldn’t reach the desk just now.'}{' '}
                What follows is the last answer that came back.
              </Text>
            ) : null}
            <StateStrip state={state.data} />
          </>
        )}

        <HoldCard state={state.data} />

        <View style={styles.section}>
          <Standing label="ORDER" tone="chrome" />
          <Button
            label="Order today’s edition"
            onPress={() => router.push('/compose?kind=edition')}
          />
          <Button
            label="Research a ticker"
            variant="secondary"
            onPress={() => router.push('/compose?kind=research')}
          />
        </View>

        <View style={styles.section}>
          <Standing label="QUEUE" tone="chrome" />
          <QueueList />
        </View>

        <View style={styles.section}>
          <Standing label="DIRECTIVES" tone="chrome" />
          <DirectiveList />
        </View>

        <View style={styles.section}>
          <Standing label="SCHEDULE" tone="chrome" />
          <ScheduleCard />
        </View>

        <View style={styles.section}>
          <Standing label="EDITIONS" tone="chrome" />
          <Card style={styles.linkCard}>
            <Pressable
              accessibilityRole="link"
              accessibilityLabel="Recent editions"
              onPress={() => router.push('/editions')}
              onPressIn={() => setEditionsPressed(true)}
              onPressOut={() => setEditionsPressed(false)}
            >
              <Animated.View
                style={[
                  styles.linkRow,
                  pressTransition,
                  editionsPressed && !reducedMotion && pressedScale,
                ]}
              >
                <Text style={[typography.ui, styles.linkText]}>
                  {editionsLine(state.data?.editions.length)}
                </Text>
                <Ionicons name="chevron-forward" size={16} color={colors.deskFaint} />
              </Animated.View>
            </Pressable>
          </Card>
        </View>

        {/* The desk's own record of what IT has done — a publish, a hold, a schedule edit. Not the
            editorial history, which is EDITIONS above. It sits at the foot because it is the
            section nobody comes here for and everybody needs once. */}
        <View style={styles.section}>
          <Standing label="THE RECORD" tone="chrome" />
          <Card style={styles.recordCard}>
            {audit.isLoading ? (
              <View style={styles.recordMessage}>
                <ScreenMessage loading />
              </View>
            ) : audit.isError ? (
              <View style={styles.recordMessage}>
                <ScreenMessage
                  error={
                    audit.error instanceof DeskError
                      ? deskHumanError(audit.error)
                      : 'Couldn’t read the desk’s record.'
                  }
                  onRetry={() => audit.refetch()}
                />
              </View>
            ) : (audit.data ?? []).length === 0 ? (
              <Text style={styles.recordEmpty}>The desk has done nothing worth recording yet.</Text>
            ) : (
              (audit.data ?? []).map((entry) => (
                <View key={entry.seq} style={styles.recordRow}>
                  <Text style={[typography.ui, styles.recordEvent]} numberOfLines={2}>
                    {auditEventLine(entry)}
                  </Text>
                  {/* The desk's clock, not the phone's — every instant in `/api/state` is to be
                      read against `now`, and an age measured against a phone a minute fast would
                      report the newest row as being in the future. */}
                  <Text style={styles.recordWhen}>
                    {auditWhen(entry.at, now === 0 ? entry.at : now)}
                  </Text>
                </View>
              ))
            )}
          </Card>
        </View>
      </ScrollView>
    </Screen>
  )
}

function Header() {
  return (
    <View style={styles.header}>
      <Text style={styles.title}>Desk</Text>
      <HeaderGear />
    </View>
  )
}

/**
 * "5 recent ⇢", or what to say before `/api/state` has answered.
 *
 * `editions` on the state document is the desk's own recent slice, so the count is a fact this
 * screen already holds rather than a second request. Undefined is "not known yet" and must not
 * render as zero — a desk that has published all week would announce itself as empty for the second
 * before its state lands.
 */
function editionsLine(count: number | undefined): string {
  if (count === undefined) return 'Recent editions'
  if (count === 0) return 'Nothing filed yet'
  return count === 1 ? '1 recent' : `${count} recent`
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
    ...typography.uiStrong,
    fontSize: 22,
    color: colors.deskText,
  },
  scroll: {
    padding: spacing[16],
    gap: spacing[24],
    paddingBottom: spacing[40],
  },
  section: {
    gap: spacing[12],
  },
  stateError: {
    minHeight: 120,
    justifyContent: 'center',
  },
  stale: {
    ...typography.ui,
    fontSize: 13,
    color: colors.signal.chrome.down,
    lineHeight: 18,
  },
  linkCard: {
    padding: 0,
    overflow: 'hidden',
  },
  linkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 48,
    paddingHorizontal: spacing[16],
  },
  linkText: {
    fontSize: 15,
    color: colors.deskText,
  },
  recordCard: {
    padding: 0,
    overflow: 'hidden',
  },
  recordMessage: {
    minHeight: 100,
    justifyContent: 'center',
  },
  recordRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: spacing[12],
    paddingVertical: spacing[8],
    paddingHorizontal: spacing[16],
  },
  recordEvent: {
    fontSize: 13,
    color: colors.deskDim,
    flexShrink: 1,
    lineHeight: 18,
  },
  recordWhen: {
    ...typography.label,
    color: colors.deskFaint,
  },
  recordEmpty: {
    ...typography.ui,
    fontSize: 13,
    color: colors.deskFaint,
    padding: spacing[16],
  },
})
