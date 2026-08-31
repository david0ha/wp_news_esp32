import { StyleSheet, Text, View } from 'react-native'
import { Card } from '../Card'
import { Chip } from '../Chip'
import { InfoRow } from '../InfoRow'
import { Standing } from '../Standing'
import {
  formatCount,
  formatInterval,
  formatMs,
  sleepPresetInForce,
  sleepSourceLabel,
} from '../../lib/format'
import { SLEEP_SECONDS_DEFAULT, type BatteryInfo, type PowerInfo } from '../../lib/esp32'
import { colors, radius, spacing, typography } from '../../theme/index'

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

/**
 * The deep-sleep design measuring itself, and the battery it's about — plus the sleep editor below
 * it. `sleepSeconds` is the interval the board will ACTUALLY sleep for, not the one it was
 * configured with, so it is shown next to who decided it (`sleepSource`) or the pair says nothing: a
 * desk in its quiet window puts an hour here beside a stored value of half of that, and that is the
 * two fields working rather than a setting that failed to save. A selection below is only shown
 * highlighted when a LOCAL layer is in force — `policy` outranks the stored value, and highlighting
 * it there would claim a setting that is only waiting; `sleepPresetInForce()` owns that call, since
 * getting it from the number alone is impossible (the compiled-in default is 900, the same as "15m").
 */
export function PowerSection({
  power,
  battery,
  busy,
  onPickSleep,
}: {
  power: PowerInfo
  battery: BatteryInfo
  busy: boolean
  onPickSleep: (seconds: number) => void
}) {
  // Both derived numbers are 0 until the board has slept at least once, because neither has an
  // input yet. That is not an error and it is not a real figure either, so it is said in words.
  const measured = power.wakes > 0 && power.meanAwakeMs > 0
  const inForce = sleepPresetInForce(power.sleepSource, power.sleepSeconds)
  const batteryValue = battery.present
    ? `${battery.percent}% · ${(battery.millivolts / 1000).toFixed(2)} V`
    : 'not fitted'
  const wakesValue =
    power.wakes > 0
      ? `${formatCount(power.wakes)} wakes, ${formatCount(power.quietWakes)} of them quiet`
      : 'has not slept yet'

  return (
    <View style={styles.section}>
      <Standing label="POWER" tone="chrome" />
      <Card style={styles.rows}>
        <InfoRow label="Deep sleep" value={power.deepSleep ? 'on' : 'off'} tone={power.deepSleep ? 'neutral' : 'dim'} />
        <InfoRow label="Wakes" value={`${formatInterval(power.sleepSeconds)}, ${sleepSourceLabel(power.sleepSource)}`} />
        <InfoRow label="Since last unplug" value={wakesValue} />
        <InfoRow label="Awake each time" value={measured ? formatMs(power.meanAwakeMs) : '—'} />
        <InfoRow label="Battery" value={batteryValue} tone={battery.present && battery.percent < 20 ? 'down' : 'neutral'} last />
      </Card>
      <Text style={styles.note}>
        {measured
          ? `About ${formatCount(power.estMahPerDay)} mAh a day — awake time only. It does not include the 2.3 mAh a refresh costs, or the standing sleep current, because nobody has measured that on this board yet. Expect the real figure to be higher.`
          : 'No estimate yet: the board has to sleep at least once before there is anything to average. Read these after a day on a wall, not after a minute.'}
      </Text>
      <View style={styles.sleep}>
        <Text style={styles.sleepTitle}>How often it wakes</Text>
        <View style={styles.chipRow}>
          {SLEEP_PRESETS.map((p) => (
            <Chip key={p.label} label={p.label} active={p.seconds === inForce} disabled={busy} onPress={() => onPickSleep(p.seconds)} />
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
    </View>
  )
}

const styles = StyleSheet.create({
  section: { gap: spacing[12] },
  rows: { padding: 0, overflow: 'hidden' },
  note: { ...typography.note, color: colors.deskFaint },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  sleep: {
    gap: 10,
    borderRadius: radius.lg,
    borderCurve: 'continuous',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.deskFaint,
    backgroundColor: colors.deskRaised,
    padding: spacing[16],
  },
  sleepTitle: { ...typography.uiStrong, fontSize: 14, color: colors.deskText },
})
