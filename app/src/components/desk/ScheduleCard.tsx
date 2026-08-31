import { useEffect, useMemo, useState } from 'react'
import { StyleSheet, Text, TextInput, View } from 'react-native'
import { Button } from '../Button'
import { Card } from '../Card'
import { ScreenMessage } from '../ScreenMessage'
import { SegmentedControl } from '../SegmentedControl'
import { useSchedule, usePutSchedule } from '../../lib/queries'
import { deskHumanError, type PublishPolicy, type Schedule } from '../../lib/desk'
import {
  MIN_GAP_MINUTES_MAX,
  POLL_SECONDS_MAX,
  POLL_SECONDS_MIN,
  parseBoundedInt,
  parseQuietText,
  parseWakeText,
  quietToText,
  wakeToText,
} from '../../lib/scheduleform'
import { colors, radius, spacing, tapLight, typography } from '../../theme/index'

const POLICIES: readonly PublishPolicy[] = ['immediate', 'on_wake', 'manual']
const POLICY_LABELS = ['Immediate', 'On wake', 'Manual']

/**
 * The one document that says when the worker runs and what the device is told to do.
 *
 * `PUT /api/schedule` REPLACES THE WHOLE THING and refuses an invalid document whole, so this card
 * is built around the round trip rather than around a form: it seeds every field from what the
 * desk sent, edits in place, and sends the document back with the parts it does not edit carried
 * through untouched. The timezone is the one such part — it is shown, never typed, because an IANA
 * zone name mistyped on a phone keyboard is a 400 the desk answers to a field nobody meant to
 * touch, and there is no version of "Asia/Seou" that is a useful edit.
 *
 * Every bound below is mirrored from `server/claudepost/schedule.py` in `src/lib/scheduleform.ts`,
 * so a figure the desk would refuse is refused HERE, with a sentence under the field, rather than
 * being sent and coming back as a 400 the reader has to map onto a field themselves.
 */
export function ScheduleCard() {
  const schedule = useSchedule()
  const save = usePutSchedule()
  const loaded = schedule.data?.schedule

  const [policy, setPolicy] = useState<PublishPolicy>('manual')
  const [gap, setGap] = useState('')
  const [active, setActive] = useState('')
  const [quiet, setQuiet] = useState('')
  const [wake, setWake] = useState('')
  const [quietPoll, setQuietPoll] = useState('')
  // "Saved." stands until the next EDIT, not until the form next happens to match the document.
  // Gating it on `!changed` alone would bring the line back the moment a reader typed a figure and
  // then typed the old one again — a confirmation for a save that did not just happen.
  const [justSaved, setJustSaved] = useState(false)

  // Re-seed whenever the desk's own document changes — the first load, and again after a save
  // (`usePutSchedule` invalidates this key, so the refetch lands here carrying what was just sent).
  // Keyed on the document's own text rather than on the object, which react-query rebuilds on every
  // fetch and would reset a half-typed field under the reader's hands.
  const seed = loaded === undefined ? '' : JSON.stringify(loaded)
  useEffect(() => {
    if (loaded === undefined) return
    setPolicy(loaded.publish.policy)
    setGap(String(loaded.publish.min_gap_minutes))
    setActive(String(loaded.poll.active_seconds))
    setQuietPoll(String(loaded.poll.quiet_seconds))
    setQuiet(quietToText(loaded.quiet))
    setWake(wakeToText(loaded.wake))
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `seed` IS `loaded`, serialized.
  }, [seed])

  /** A field's setter, wrapped so that touching anything retires the "Saved." line. */
  function edit<T>(set: (v: T) => void): (v: T) => void {
    return (v: T) => {
      setJustSaved(false)
      set(v)
    }
  }

  const parsed = useMemo(() => {
    if (loaded === undefined) return null
    const gapN = parseBoundedInt(gap, 0, MIN_GAP_MINUTES_MAX)
    const activeN = parseBoundedInt(active, POLL_SECONDS_MIN, POLL_SECONDS_MAX)
    const quietPollN = parseBoundedInt(quietPoll, POLL_SECONDS_MIN, POLL_SECONDS_MAX)
    const quietW = parseQuietText(quiet)
    const wakeW = parseWakeText(wake)
    return { gapN, activeN, quietPollN, quietW, wakeW }
  }, [loaded, gap, active, quietPoll, quiet, wake])

  const document: Schedule | null =
    loaded === undefined ||
    parsed === null ||
    parsed.gapN === null ||
    parsed.activeN === null ||
    parsed.quietPollN === null ||
    parsed.quietW === null ||
    parsed.wakeW === null
      ? null
      : {
          timezone: loaded.timezone,
          quiet: parsed.quietW,
          wake: parsed.wakeW,
          publish: { policy, min_gap_minutes: parsed.gapN },
          poll: { active_seconds: parsed.activeN, quiet_seconds: parsed.quietPollN },
        }

  // A save that would change nothing is not a save. It would still cost a round trip, still write
  // a `schedule` row into the desk's audit, and still flip `source` from 'default' to 'file' —
  // three consequences for a tap that meant nothing.
  const changed = document !== null && loaded !== undefined && JSON.stringify(document) !== JSON.stringify(loaded)

  if (schedule.isLoading) {
    return (
      <Card style={styles.message}>
        <ScreenMessage loading />
      </Card>
    )
  }

  if (schedule.isError || loaded === undefined) {
    return (
      <Card style={styles.message}>
        <ScreenMessage
          error={deskHumanError(schedule.error, 'Couldn’t read the schedule.')}
          onRetry={() => schedule.refetch()}
        />
      </Card>
    )
  }

  return (
    <Card style={styles.card}>
      <Field label="Time zone">
        <Text style={[typography.ui, styles.readonly]}>{loaded.timezone}</Text>
        <Text style={styles.hint}>
          Every clock time on this card is read in this zone. It comes from{' '}
          {schedule.data?.source === 'file' ? 'a file on the desk' : 'the desk’s own default'}.
        </Text>
      </Field>

      <Field label="When a finished edition goes up">
        <SegmentedControl
          segments={[...POLICY_LABELS]}
          selectedIndex={POLICIES.indexOf(policy)}
          onChange={(i) => {
            const next = POLICIES[i]
            if (next !== undefined) edit(setPolicy)(next)
          }}
          disabled={save.isPending}
        />
      </Field>

      <Field label="Least time between two flashes">
        <Row>
          <NumberInput
            value={gap}
            onChangeText={edit(setGap)}
            editable={!save.isPending}
            accessibilityLabel="Minutes between publishes"
            bad={parsed?.gapN === null}
          />
          <Text style={styles.unit}>minutes</Text>
        </Row>
        {parsed?.gapN === null ? (
          <Text style={styles.bad}>A whole number of minutes, 0 to {MIN_GAP_MINUTES_MAX}.</Text>
        ) : (
          <Text style={styles.hint}>
            The floor under how often the wall may flash. Each refresh takes about 25 seconds.
          </Text>
        )}
      </Field>

      <Field label="How often the board asks">
        <Row>
          <NumberInput
            value={active}
            onChangeText={edit(setActive)}
            editable={!save.isPending}
            accessibilityLabel="Seconds between polls, awake"
            bad={parsed?.activeN === null}
          />
          <Text style={styles.unit}>seconds, normally</Text>
        </Row>
        <Row>
          <NumberInput
            value={quietPoll}
            onChangeText={edit(setQuietPoll)}
            editable={!save.isPending}
            accessibilityLabel="Seconds between polls, quiet"
            bad={parsed?.quietPollN === null}
          />
          <Text style={styles.unit}>seconds, when quiet</Text>
        </Row>
        {parsed?.activeN === null || parsed?.quietPollN === null ? (
          <Text style={styles.bad}>
            A whole number of seconds, {POLL_SECONDS_MIN} to {POLL_SECONDS_MAX}.
          </Text>
        ) : (
          <Text style={styles.hint}>
            A board on a battery sleeps this long between wakes; one on USB waits this long between
            polls.
          </Text>
        )}
      </Field>

      <Field label="Quiet windows">
        <TextInput
          value={quiet}
          onChangeText={edit(setQuiet)}
          editable={!save.isPending}
          multiline
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="00:30-06:00"
          placeholderTextColor={colors.deskFaint}
          accessibilityLabel="Quiet windows, one per line"
          style={[typography.ui, styles.input, styles.area, parsed?.quietW === null && styles.inputBad]}
        />
        {parsed?.quietW === null ? (
          <Text style={styles.bad}>One window per line, as 00:30-06:00. Four at most.</Text>
        ) : (
          <Text style={styles.hint}>
            Nothing new becomes current inside one. An edition finished here is staged and goes up
            at the boundary.
          </Text>
        )}
      </Field>

      <Field label="When the worker runs">
        <TextInput
          value={wake}
          onChangeText={edit(setWake)}
          editable={!save.isPending}
          multiline
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="06:00"
          placeholderTextColor={colors.deskFaint}
          accessibilityLabel="Wake times, one per line"
          style={[typography.ui, styles.input, styles.area, parsed?.wakeW === null && styles.inputBad]}
        />
        {parsed?.wakeW === null ? (
          <Text style={styles.bad}>
            One time per line, as 06:00 — add days after it, as 12:40 sat,sun. Twelve at most.
          </Text>
        ) : (
          <Text style={styles.hint}>A bare time means every day. Twelve at most.</Text>
        )}
      </Field>

      <View style={styles.footer}>
        <Button
          label="Save the schedule"
          onPress={() => {
            if (document === null) return
            save.mutate(document, {
              onSuccess: () => {
                setJustSaved(true)
                tapLight()
              },
            })
          }}
          loading={save.isPending}
          disabled={!changed}
        />
        {justSaved && !changed ? (
          <Text style={styles.saved}>Saved. The desk is keeping this one now.</Text>
        ) : null}
        {save.isError ? (
          <Text style={styles.error}>
            {deskHumanError(save.error, 'The desk didn’t take that schedule.')}
          </Text>
        ) : null}
      </View>
    </Card>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={[styles.field, styles.fieldBordered]}>
      {/* The label face on chrome — Task 24's ruling puts the identification roles on both
          materials; only the narrative faces are paper-only. */}
      <Text style={styles.fieldLabel}>{label}</Text>
      {children}
    </View>
  )
}

function Row({ children }: { children: React.ReactNode }) {
  return <View style={styles.inputRow}>{children}</View>
}

function NumberInput({
  value,
  onChangeText,
  editable,
  accessibilityLabel,
  bad,
}: {
  value: string
  onChangeText: (t: string) => void
  editable: boolean
  accessibilityLabel: string
  bad: boolean | undefined
}) {
  return (
    <TextInput
      value={value}
      onChangeText={onChangeText}
      editable={editable}
      keyboardType="number-pad"
      accessibilityLabel={accessibilityLabel}
      style={[typography.ui, styles.input, styles.number, bad && styles.inputBad]}
    />
  )
}

const styles = StyleSheet.create({
  // `padding: 0` only — `<Card>` already sets the radius and the continuous curve.
  card: {
    padding: 0,
    overflow: 'hidden',
  },
  message: {
    minHeight: 120,
    justifyContent: 'center',
  },
  field: {
    padding: spacing[16],
    gap: spacing[8],
  },
  fieldBordered: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.deskFaint,
  },
  fieldLabel: {
    ...typography.label,
    color: colors.deskDim,
  },
  readonly: {
    fontSize: 15,
    color: colors.deskText,
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[12],
  },
  input: {
    color: colors.deskText,
    backgroundColor: colors.desk,
    borderRadius: radius.sm,
    borderCurve: 'continuous',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.deskFaint,
    paddingHorizontal: spacing[12],
    paddingVertical: spacing[8],
  },
  inputBad: {
    borderColor: colors.signal.chrome.down,
  },
  number: {
    width: 96,
    textAlign: 'right',
  },
  area: {
    minHeight: 64,
    textAlignVertical: 'top',
    paddingVertical: spacing[12],
  },
  unit: {
    ...typography.ui,
    fontSize: 13,
    color: colors.deskDim,
    flexShrink: 1,
  },
  hint: {
    ...typography.note,
    color: colors.deskFaint,
  },
  bad: {
    ...typography.note,
    color: colors.signal.chrome.down,
  },
  footer: {
    padding: spacing[16],
    gap: spacing[8],
  },
  saved: {
    ...typography.ui,
    fontSize: 13,
    color: colors.deskDim,
  },
  error: {
    ...typography.ui,
    fontSize: 13,
    color: colors.signal.chrome.down,
    lineHeight: 18,
  },
})
