import { StyleSheet, Text, View } from 'react-native'
import { Button } from '../Button'
import { SegmentedControl } from '../SegmentedControl'
import { Standing } from '../Standing'
import { useBoardScreen } from '../../lib/queries'
import { PAGE_LABELS, formatMs } from '../../lib/format'
import type { DeviceState } from '../../lib/esp32'
import { colors, spacing, typography } from '../../theme/index'

/**
 * The commands the board answers to: switch the page it is showing, poll its news source now,
 * sweep the panel for a self-test, or re-read the framebuffer that is already up — the same read
 * `GlassSection` shows, this just asks the board again rather than trusting the last one, for the
 * frame-caught-mid-render case `/api/screen` itself warns about.
 */
export function ActionsSection({
  state,
  focused,
  pendingPage,
  busy,
  onSetPage,
  onPollNow,
  onSelfTest,
}: {
  state: DeviceState
  /** Whether the Board tab is the one on screen — the same flag `<GlassSection>` takes, and for the
   * same reason. `refetchFromBoard` below still works while it is false: react-query's `refetch`
   * runs a disabled query on purpose, which is what a button press is. */
  focused: boolean
  /** A page the user asked for that the board has not confirmed yet — without it the segmented
   * control snaps back to the old page while a switch (twenty to thirty seconds) is in flight, and
   * looks like the tap was lost. */
  pendingPage: number | null
  busy: boolean
  onSetPage: (page: number) => void
  onPollNow: () => void
  onSelfTest: () => void
}) {
  const board = useBoardScreen(state, focused)
  const shownPage = pendingPage ?? state.page

  return (
    <View style={styles.section}>
      <Standing label="ON THE PANEL" tone="chrome" />
      <SegmentedControl
        segments={[...PAGE_LABELS]}
        selectedIndex={shownPage}
        disabled={busy}
        onChange={onSetPage}
      />
      <Text style={styles.note}>
        {pendingPage !== null && pendingPage !== state.page
          ? 'Switching… a page change is a full refresh, which takes twenty to thirty seconds.'
          : `Showing “${state.pageTitle || PAGE_LABELS[state.page] || '—'}”. A refresh of this panel last took ${formatMs(state.panel.refreshMs)}.`}
      </Text>

      <View style={styles.actions}>
        <Button label="Poll the board now" variant="secondary" disabled={busy} onPress={onPollNow} style={styles.actionBtn} />
        <Button label="Run the panel self-test" variant="secondary" disabled={busy} onPress={onSelfTest} style={styles.actionBtn} />
      </View>
      <Button
        label="Fetch the sheet again"
        variant="secondary"
        disabled={busy}
        loading={board.isFetching}
        onPress={() => void board.refetchFromBoard()}
      />
      <Text style={styles.note}>
        Polling only redraws the panel if the edition changed. The self-test sweeps the panel for
        about a minute and a half, and the board answers nothing else while it does. Fetching again
        re-reads the framebuffer over the network — it does not ask the panel to redraw.
      </Text>
    </View>
  )
}

const styles = StyleSheet.create({
  section: {
    gap: spacing[12],
  },
  actions: {
    flexDirection: 'row',
    gap: 12,
  },
  actionBtn: {
    flex: 1,
  },
  note: {
    ...typography.note,
    color: colors.deskFaint,
  },
})
