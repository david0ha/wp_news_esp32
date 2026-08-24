import { useCallback, useRef, useState } from 'react'
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useFocusEffect, useRouter } from 'expo-router'
import { Screen } from '../components/Screen'
import { Card } from '../components/Card'
import { Chip } from '../components/Chip'
import { Button } from '../components/Button'
import { InfoRow } from '../components/InfoRow'
import { SegmentedControl } from '../components/SegmentedControl'
import { ScreenMessage } from '../components/ScreenMessage'
import { useDevice } from '../lib/device'
import {
  Esp32Error,
  humanError,
  SLEEP_SECONDS_DEFAULT,
  type DeviceState,
  type PowerInfo,
} from '../lib/esp32'
import { DEFAULT_HOST, discoverDevice } from '../lib/discovery'
import { getDeviceBaseUrl } from '../lib/store'
import {
  PAGE_LABELS,
  changeTone,
  fetchResultLabel,
  fetchResultMessage,
  fetchResultTone,
  formatAge,
  formatCents,
  formatChange,
  formatCount,
  formatGeneratedAt,
  formatInterval,
  formatMs,
  pollSourceLabel,
  sleepPresetInForce,
  sleepSourceLabel,
} from '../lib/format'
import { colors, layout, radius, space } from '../theme'

// The board polls its desk every few minutes and only redraws when the edition changed, so there
// is nothing to gain from polling it fast. This is "keep the phone screen roughly current", not a
// live feed. It is also what holds a sleeping board awake while the app is open: every request
// restarts the board's awake window (docs/app-control.md).
const POLL_MS = 5000

/**
 * The sleep intervals offered.
 *
 * The board clamps to [60, 86400] and takes 0 for "use the build-time default", so these are
 * points inside that range rather than a limit on it. They are clustered around the knee the
 * deep-sleep design names — 15 to 30 minutes, past which a longer interval buys progressively less
 * because the refreshes and the standing current start to dominate.
 */
const SLEEP_PRESETS: ReadonlyArray<{ label: string; seconds: number }> = [
  { label: '5m', seconds: 300 },
  { label: '15m', seconds: 900 },
  { label: '30m', seconds: 1800 },
  { label: '1h', seconds: 3600 },
  { label: '6h', seconds: 21600 },
  { label: 'Default', seconds: SLEEP_SECONDS_DEFAULT },
]

export default function Dashboard() {
  const router = useRouter()
  const { client, baseUrl, setBaseUrl } = useDevice()

  const [state, setState] = useState<DeviceState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  // Disable controls briefly while a write command is in flight so taps can't race.
  const [busy, setBusy] = useState(false)
  // A page the user asked for that the board has not confirmed yet. A page change is a full
  // refresh of a 13.3" Spectra 6 panel — twenty to thirty seconds — so without this the segmented
  // control snaps back to the old page and looks like the tap was lost.
  const [pendingPage, setPendingPage] = useState<number | null>(null)
  const focused = useRef(true)

  const load = useCallback(
    async (opts: { silent?: boolean } = {}) => {
      if (!client) return
      if (!opts.silent) setError(null)
      try {
        const s = await client.getState()
        setState(s)
        setPendingPage((p) => (p === null || p === s.page ? null : p))
        setError(null)
      } catch (e) {
        // Keep the last good snapshot on a transient poll failure; only surface an error when we
        // have nothing to show yet.
        if (!opts.silent) {
          setError(e instanceof Esp32Error ? humanError(e) : 'Couldn’t reach the board.')
        }
      }
    },
    [client],
  )

  // Poll while the screen is focused. useFocusEffect pauses polling when the user navigates away
  // and resumes on return, so we never poll a backgrounded screen.
  useFocusEffect(
    useCallback(() => {
      focused.current = true
      load()
      const id = setInterval(() => {
        if (focused.current) load({ silent: true })
      }, POLL_MS)
      return () => {
        focused.current = false
        clearInterval(id)
      }
    }, [load]),
  )

  const onPullRefresh = useCallback(async () => {
    setRefreshing(true)
    await load()
    setRefreshing(false)
  }, [load])

  // "Couldn't reach the board" retry: the saved address may be stale after the user rejoined their
  // home Wi-Fi or the board took a new DHCP lease. Re-probe the LAN (saved address + the mDNS
  // name), persist whichever answers, then reload.
  const retry = useCallback(async () => {
    setError(null)
    const saved = await getDeviceBaseUrl()
    const found = await discoverDevice([saved, baseUrl, `http://${DEFAULT_HOST}`])
    if (found && found !== baseUrl) {
      await setBaseUrl(found)
      // The client is recreated from the new baseUrl on the next render; the focus-effect poll and
      // this explicit load will then hit the rediscovered board.
    }
    await load()
  }, [baseUrl, setBaseUrl, load])

  // Wrap a control command: re-poll afterwards so the UI reflects the board quickly.
  const command = useCallback(
    async (fn: () => Promise<void>) => {
      if (!client || busy) return
      setBusy(true)
      try {
        await fn()
        await load({ silent: true })
      } catch (e) {
        setError(e instanceof Esp32Error ? humanError(e) : 'That command failed. Please try again.')
      } finally {
        setBusy(false)
      }
    },
    [client, busy, load],
  )

  if (!client) {
    return (
      <Screen>
        <ScreenMessage loading message="Connecting…" />
      </Screen>
    )
  }

  if (!state) {
    return (
      <Screen>
        <Header baseUrl={baseUrl} onSettings={() => router.push('/settings')} />
        <ScreenMessage loading={!error} error={error} message="Loading…" onRetry={retry} />
      </Screen>
    )
  }

  const { news, source, battery, panel, power } = state
  const { subject } = news
  const shownPage = pendingPage ?? state.page

  return (
    <Screen edges={['top']}>
      <Header baseUrl={baseUrl} onSettings={() => router.push('/settings')} />

      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onPullRefresh} tintColor={colors.accent} />
        }
      >
        {/* Status chips: how the last poll went, whether what's on the glass is the demo edition or
            stale, whether the board sleeps, and the battery when there is one. */}
        <View style={styles.chipRow}>
          <Chip
            label={fetchResultLabel(source.lastResult)}
            icon="cloud-download"
            tone={fetchResultTone(source.lastResult)}
          />
          {news.demo ? <Chip label="demo edition" icon="flask" tone="warn" /> : null}
          {source.stale ? <Chip label="stale" icon="time" tone="warn" /> : null}
          {power.deepSleep ? <Chip label="sleeps" icon="moon" tone="accent" /> : null}
          {battery.present ? (
            <Chip
              label={`${battery.percent}%`}
              icon="battery-half"
              tone={battery.percent < 20 ? 'down' : 'neutral'}
            />
          ) : null}
        </View>

        {/* The company the edition is about. Every story on both sheets is about this one, so this
            is the whole of what the board is printing today — and a new symbol or a new
            generatedAt is the cheapest "did the edition change" check there is. */}
        <Card style={styles.hero}>
          {news.valid ? (
            <>
              <Text style={styles.heroSymbol}>{subject.symbol || '—'}</Text>
              <Text style={styles.heroName} numberOfLines={2}>
                {subject.name}
              </Text>
              <View style={styles.heroPriceRow}>
                <Text style={styles.heroPrice}>{formatCents(subject.lastCents)}</Text>
                <Text style={[styles.heroChange, toneText(changeTone(subject.changeBp))]}>
                  {formatChange(subject.changeBp)}
                </Text>
              </View>
              <Text style={styles.heroMeta}>
                {[subject.exchange, subject.sector].filter(Boolean).join(' · ') || '—'}
              </Text>
              <Text style={styles.heroMeta}>
                {[news.edition, formatGeneratedAt(news.generatedAt)].filter(Boolean).join(' · ')}
              </Text>
            </>
          ) : (
            <>
              <Text style={styles.heroName}>No edition yet</Text>
              <Text style={styles.heroMeta}>
                The board has not parsed an edition since it started. Everything below describes
                the board, not a page.
              </Text>
            </>
          )}
        </Card>

        {/* The tape: up to five cells, symbol and direction only. The board has a label for each
            already, so the name is not repeated. */}
        {news.indices.length > 0 ? (
          <View style={styles.chipRow}>
            {news.indices.map((cell) => (
              <Chip
                key={cell.symbol}
                label={`${cell.symbol} ${formatChange(cell.changeBp)}`}
                tone={changeTone(cell.changeBp)}
              />
            ))}
          </View>
        ) : null}

        {news.headlines.length > 0 ? (
          <Section title="Headlines">
            <Card style={styles.rows}>
              {news.headlines.map((h, i) => (
                <View
                  key={`${h.rank}-${i}`}
                  style={[styles.headline, i < news.headlines.length - 1 && styles.headlineRule]}
                >
                  <Text style={styles.headlineRank}>{h.rank}</Text>
                  <Text style={styles.headlineText}>{h.headline}</Text>
                </View>
              ))}
            </Card>
            {/* What ARRIVED, after parsing. It is the difference between "the desk filed a thin
                day" and "the parser dropped something" — a distinction no other field can make. */}
            <Text style={styles.counts}>
              {[
                `${formatCount(news.counts.stories)} stories`,
                `${formatCount(news.counts.figures)} figures`,
                `${formatCount(news.counts.briefs)} briefs`,
                `${formatCount(news.counts.peers)} peers`,
                `${formatCount(news.counts.tables)} tables`,
                `${formatCount(news.counts.charts)} charts`,
                `${formatCount(news.counts.thumbs)} photos`,
              ].join(' · ')}
            </Text>
          </Section>
        ) : null}

        {/* Page control. The board's own title for the page it is showing sits underneath — that is
            the ground truth for what is on the glass. */}
        <Section title="On the panel">
          <SegmentedControl
            segments={[...PAGE_LABELS]}
            selectedIndex={shownPage}
            disabled={busy}
            onChange={(page) => {
              setPendingPage(page)
              command(() => client.setPage(page))
            }}
          />
          <Text style={styles.note}>
            {pendingPage !== null && pendingPage !== state.page
              ? 'Switching… a page change is a full refresh, which takes twenty to thirty seconds.'
              : `Showing “${state.pageTitle || PAGE_LABELS[state.page] || '—'}”. A refresh of this panel last took ${formatMs(panel.refreshMs)}.`}
          </Text>
          <Button
            label="See the page on the glass"
            variant="secondary"
            onPress={() => router.push('/preview')}
          />
        </Section>

        {/* Where the edition comes from, and how the last poll went. */}
        <Section title="Source">
          <Card style={styles.rows}>
            <InfoRow label="URL" value={source.url || 'not set (demo)'} tone={source.url ? 'neutral' : 'dim'} />
            <InfoRow
              label="Last poll"
              value={fetchResultLabel(source.lastResult)}
              tone={fetchResultTone(source.lastResult) === 'down' ? 'down' : 'neutral'}
            />
            <InfoRow label="Last success" value={formatAge(source.ageSeconds)} />
            <InfoRow
              label="Polls"
              value={`${formatInterval(source.pollSeconds)}, ${pollSourceLabel(source.pollSource)}`}
              last
            />
          </Card>
          {source.lastResult !== 'ok' ? (
            <Text style={styles.note}>{fetchResultMessage(source.lastResult)}</Text>
          ) : null}
          <Button
            label="Change the news URL"
            variant="secondary"
            onPress={() => router.push('/settings')}
          />
        </Section>

        <Section title="Power">
          <PowerCard
            power={power}
            batteryPresent={battery.present}
            batteryPercent={battery.percent}
            batteryMv={battery.millivolts}
          />
          <SleepEditor
            power={power}
            disabled={busy}
            onPick={(seconds) => command(() => client.setSleep(seconds))}
          />
        </Section>

        <View style={styles.actions}>
          <Button
            label="Poll now"
            variant="secondary"
            disabled={busy}
            onPress={() => command(() => client.refresh())}
            style={styles.actionBtn}
          />
          <Button
            label="Self-test"
            variant="secondary"
            disabled={busy}
            onPress={() => command(() => client.displayTest())}
            style={styles.actionBtn}
          />
        </View>
        <Text style={styles.note}>
          Polling only redraws the panel if the edition changed. The self-test sweeps the panel for
          about a minute and a half, and the board answers nothing else while it does.
        </Text>

        {error ? <Text style={styles.errorLine}>{error}</Text> : null}
      </ScrollView>
    </Screen>
  )
}

/**
 * The counters the deep-sleep design measures itself with, and the battery they are about.
 *
 * `sleepSeconds` is the interval the board will ACTUALLY sleep for, not the one it was configured
 * with — so it is shown next to who decided it, or the pair says nothing: a desk in its quiet
 * window puts an hour here beside a stored value of half of that, and that is the two fields
 * working rather than a setting that failed to save.
 */
function PowerCard({
  power,
  batteryPresent,
  batteryPercent,
  batteryMv,
}: {
  power: PowerInfo
  batteryPresent: boolean
  batteryPercent: number
  batteryMv: number
}) {
  // Both derived numbers are 0 until the board has slept at least once, because neither has an
  // input yet. That is not an error and it is not a real figure either, so it is said in words.
  const measured = power.wakes > 0 && power.meanAwakeMs > 0

  return (
    <>
      <Card style={styles.rows}>
        <InfoRow
          label="Deep sleep"
          value={power.deepSleep ? 'on' : 'off'}
          tone={power.deepSleep ? 'neutral' : 'dim'}
        />
        <InfoRow
          label="Wakes"
          value={`${formatInterval(power.sleepSeconds)}, ${sleepSourceLabel(power.sleepSource)}`}
        />
        <InfoRow
          label="Since last unplug"
          value={
            power.wakes > 0
              ? `${formatCount(power.wakes)} wakes, ${formatCount(power.quietWakes)} of them quiet`
              : 'has not slept yet'
          }
        />
        <InfoRow label="Awake each time" value={measured ? formatMs(power.meanAwakeMs) : '—'} />
        <InfoRow
          label="Battery"
          value={
            batteryPresent ? `${batteryPercent}% · ${(batteryMv / 1000).toFixed(2)} V` : 'not fitted'
          }
          tone={batteryPresent && batteryPercent < 20 ? 'down' : 'neutral'}
          last
        />
      </Card>
      <Text style={styles.note}>
        {measured
          ? `About ${formatCount(power.estMahPerDay)} mAh a day — awake time only. It does not include the 2.3 mAh a refresh costs, or the standing sleep current, because nobody has measured that on this board yet. Expect the real figure to be higher.`
          : 'No estimate yet: the board has to sleep at least once before there is anything to average. Read these after a day on a wall, not after a minute.'}
      </Text>
    </>
  )
}

/**
 * The sleep interval, as a row of the values the board can actually run on.
 *
 * A selection is only shown when a LOCAL layer is in force — and "the board's own built-in
 * interval" is one of those, so the "Default" chip lights like any other. When the desk is driving
 * — the payload carried a `policy` block — the stored value is not the one in effect, and
 * highlighting it would claim a setting that is only waiting. Saying so is the honest version, and
 * it is the one thing `sleepSource` exists for. `sleepPresetInForce()` owns that decision, because
 * getting it from the number alone is impossible: the compiled-in default is 900, which is also
 * exactly the "15m" chip.
 */
function SleepEditor({
  power,
  disabled,
  onPick,
}: {
  power: PowerInfo
  disabled: boolean
  onPick: (seconds: number) => void
}) {
  const inForce = sleepPresetInForce(power.sleepSource, power.sleepSeconds)

  return (
    <View style={styles.sleep}>
      <Text style={styles.sleepTitle}>How often it wakes</Text>
      <View style={styles.chipRow}>
        {SLEEP_PRESETS.map((p) => (
          <Chip
            key={p.label}
            label={p.label}
            active={p.seconds === inForce}
            disabled={disabled}
            onPress={() => onPick(p.seconds)}
          />
        ))}
      </View>
      <Text style={styles.note}>
        {power.sleepSource === 'policy'
          ? 'The desk is setting the cadence at the moment, so your value is stored and waiting rather than in force.'
          : 'This is the fallback the board uses when its desk says nothing about cadence. Below fifteen minutes the cell drains noticeably faster; “Default” hands it back to the firmware.'}
      </Text>
      {!power.deepSleep ? (
        <Text style={styles.note}>
          Deep sleep is off on this board — on USB with a console attached it never sleeps at all,
          so this setting is stored for the day it runs on a cell.
        </Text>
      ) : null}
    </View>
  )
}

function toneText(tone: 'up' | 'down' | 'warn' | 'neutral') {
  switch (tone) {
    case 'up':
      return { color: colors.up }
    case 'down':
      return { color: colors.down }
    case 'warn':
      return { color: colors.warn }
    default:
      return { color: colors.text }
  }
}

function Header({ baseUrl, onSettings }: { baseUrl: string | null; onSettings: () => void }) {
  return (
    <View style={styles.header}>
      <View style={styles.headerText}>
        <Text style={styles.headerTitle}>Claude Post</Text>
        <Text style={styles.headerSub} numberOfLines={1}>
          {baseUrl ?? ''}
        </Text>
      </View>
      <Pressable accessibilityLabel="Settings" onPress={onSettings} hitSlop={8} style={styles.settingsBtn}>
        <Ionicons name="settings-outline" size={22} color={colors.text} />
      </Pressable>
    </View>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  )
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: layout.gutter,
    paddingVertical: 12,
  },
  headerText: {
    flexShrink: 1,
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: colors.text,
  },
  headerSub: {
    fontSize: 12,
    color: colors.textFaint,
    marginTop: 2,
  },
  settingsBtn: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  scroll: {
    paddingHorizontal: layout.gutter,
    paddingBottom: 32,
    gap: space.lg,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  hero: {
    alignItems: 'center',
    gap: 4,
    paddingVertical: 20,
  },
  heroSymbol: {
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 2,
    color: colors.textDim,
  },
  heroName: {
    fontSize: 24,
    fontWeight: '700',
    color: colors.text,
    textAlign: 'center',
  },
  heroPriceRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 10,
    marginTop: 2,
  },
  heroPrice: {
    fontSize: 30,
    fontWeight: '700',
    color: colors.text,
  },
  heroChange: {
    fontSize: 16,
    fontWeight: '700',
  },
  heroMeta: {
    fontSize: 12,
    color: colors.textFaint,
    textAlign: 'center',
  },
  section: {
    gap: 10,
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.textDim,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  rows: {
    padding: 0,
  },
  headline: {
    flexDirection: 'row',
    gap: 12,
    paddingVertical: 12,
    paddingHorizontal: 16,
  },
  headlineRule: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  headlineRank: {
    fontSize: 12,
    lineHeight: 20,
    color: colors.textFaint,
    width: 14,
  },
  headlineText: {
    flex: 1,
    fontSize: 14,
    lineHeight: 20,
    color: colors.text,
  },
  counts: {
    fontSize: 12,
    color: colors.textFaint,
    lineHeight: 18,
  },
  note: {
    fontSize: 12,
    color: colors.textFaint,
    lineHeight: 17,
  },
  sleep: {
    gap: 10,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    padding: space.lg,
  },
  sleepTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.text,
  },
  actions: {
    flexDirection: 'row',
    gap: 12,
  },
  actionBtn: {
    flex: 1,
  },
  errorLine: {
    fontSize: 13,
    color: colors.down,
    textAlign: 'center',
  },
})
