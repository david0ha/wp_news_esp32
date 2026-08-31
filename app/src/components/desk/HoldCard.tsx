import { StyleSheet, Text, View } from 'react-native'
import * as Haptics from 'expo-haptics'
import { Button } from '../Button'
import { useHold, usePublish } from '../../lib/queries'
import { DeskError, deskHumanError, type DeskState } from '../../lib/desk'
import { formatSinceTime } from '../../lib/format'
import { colors, spacing, typography } from '../../theme/index'

/**
 * How long "Hold the desk" holds for.
 *
 * `POST /api/hold` takes an INSTANT, not a duration, so some figure has to be chosen here — there
 * is no "hold indefinitely" on the wire, and inventing one by sending a date in 2099 would be a
 * hold nobody remembers setting. A day is the honest default for a paper that prints daily: it
 * covers the next edition and expires on its own if the phone is never opened again. It is also
 * the least costly thing to get wrong, which is why it is not behind a picker — the hold lifts
 * with one tap, and a hold that is too short simply gets set again.
 */
const HOLD_SECONDS = 86400

/**
 * The desk's two levers: put the staged edition up now, and stop anything going up at all.
 *
 * NEITHER ASKS FOR CONFIRMATION, deliberately. A confirm dialog is worth its interruption when the
 * action cannot be taken back, and both of these can: a hold lifts with the button beside it, and
 * a publish is followed by `promote` on any earlier edition (Task 30) — every edition is still a
 * directory on the desk. What they get instead is the thing a dialog is usually standing in for,
 * which is knowing the tap landed: the button holds its own spinner while the request is in
 * flight, and the desk's own sentence about what happened is printed underneath afterwards.
 *
 * NOT ON A CARD, unlike the strip above it. `Button`'s `secondary` fill IS `deskRaised`, which is
 * what a `<Card>` is drawn in — a "Lift the hold" inside one is a label floating on the card with
 * no button under it. These two sit on the desk surround for the same reason the ORDER buttons do:
 * a control needs a ground it is distinguishable from.
 */
export function HoldCard({ state }: { state: DeskState | undefined }) {
  const publish = usePublish()
  const hold = useHold()

  const staged = state?.staged ?? null
  const held = state?.hold ?? null
  const now = state?.now ?? 0
  const busy = publish.isPending || hold.isPending

  const onPublish = () => {
    publish.mutate(undefined, {
      onSuccess: () => {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)
      },
    })
  }

  const onHold = () => {
    // The desk's own clock, never the phone's: `state.now` is what every other instant in this
    // document is read against, and a phone a minute fast would set a hold a minute short.
    hold.mutate(held === null ? now + HOLD_SECONDS : null, {
      onSuccess: () => {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)
      },
    })
  }

  return (
    <View style={styles.wrap}>
      {staged === null ? (
        <Text style={styles.note}>
          Nothing is staged. There is nothing waiting to go up.
        </Text>
      ) : (
        <>
          <Button
            label="Publish the staged edition"
            onPress={onPublish}
            loading={publish.isPending}
            disabled={busy}
          />
          <Text style={styles.note}>
            It goes up now — past the quiet window and the minimum gap both.
          </Text>
        </>
      )}

      <Button
        label={held === null ? 'Hold the desk' : 'Lift the hold'}
        variant="secondary"
        onPress={onHold}
        loading={hold.isPending}
        disabled={busy || state === undefined}
      />
      <Text style={styles.note}>
        {held === null
          ? 'Nothing new reaches the glass for a day. Lift it any time.'
          : `Held until ${formatSinceTime(held)}. Nothing new reaches the glass until then.`}
      </Text>

      {/* The desk's own prose about what it did — `CommitResult.reason` is written for a person,
          and a publish inside a quiet window says so rather than silently doing nothing. */}
      {publish.isSuccess ? (
        <Text style={styles.result}>
          {publish.data.state === 'published'
            ? `Published ${publish.data.edition_id.slice(0, 8)} — ${publish.data.reason}`
            : `${publish.data.state} — ${publish.data.reason}`}
        </Text>
      ) : null}
      {publish.isError ? <ErrorLine error={publish.error} /> : null}
      {hold.isError ? <ErrorLine error={hold.error} /> : null}
    </View>
  )
}

function ErrorLine({ error }: { error: unknown }) {
  return (
    <Text style={styles.error}>
      {error instanceof DeskError ? deskHumanError(error) : 'The desk didn’t take that.'}
    </Text>
  )
}

const styles = StyleSheet.create({
  wrap: {
    gap: spacing[8],
  },
  note: {
    ...typography.ui,
    fontSize: 12,
    color: colors.deskFaint,
    lineHeight: 17,
  },
  result: {
    ...typography.ui,
    fontSize: 13,
    color: colors.deskDim,
    lineHeight: 18,
  },
  error: {
    ...typography.ui,
    fontSize: 13,
    color: colors.signal.chrome.down,
    lineHeight: 18,
  },
})
