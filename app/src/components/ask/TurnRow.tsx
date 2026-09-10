import { StyleSheet, Text, View } from 'react-native'
import { useStrings } from '../../i18n'
import { colors, fonts, radius, space, type } from '../../theme'
import { readResult, type Turn } from '../../lib/ask/threads'
import { Answer } from './Answer'
import { Button } from '../Button'
import { Chip } from '../Chip'

/**
 * One turn: what was asked, what came back, and — when there is one — what to do about it.
 *
 * The question is drawn as a card and the answer as plain prose under it, rather than as two
 * chat bubbles. There are exactly two speakers and minutes between them; a bubble layout spends
 * half the measure on a distinction the reader already has.
 */
export function TurnRow({
  turn,
  onRetry,
  onPublish,
}: {
  turn: Turn
  onRetry: (turnId: string) => void
  onPublish: (commandId: string) => void
}) {
  const t = useStrings()
  const outcome = readResult(turn.result)
  const waiting =
    turn.status === 'sending' || turn.status === 'pending' || turn.status === 'claimed'

  return (
    <View style={styles.root}>
      <View style={styles.question}>
        <Text style={type.body}>{turn.text}</Text>
      </View>

      {waiting ? (
        <Text style={type.caption}>
          {t.ask.status[turn.status as 'sending' | 'pending' | 'claimed']}
        </Text>
      ) : null}
      {turn.status === 'expired' ? <Text style={type.caption}>{t.ask.status.expired}</Text> : null}
      {turn.status === 'cancelled' ? (
        <Text style={type.caption}>{t.ask.status.cancelled}</Text>
      ) : null}

      {/* The chip that says the paper changed. `revised` only — a `staged` turn says something
          different below, because for that one nothing has reached the wall yet. */}
      {outcome?.kind === 'revised' ? (
        <View style={styles.chipRow}>
          <Chip label={t.ask.changed} icon="newspaper-outline" tone="accent" />
        </View>
      ) : null}

      {turn.answer !== null && turn.answer !== '' ? <Answer markdown={turn.answer} /> : null}

      {/* Done, with nothing written. A real outcome of the worker's, and silence here would look
          exactly like a turn that is still out. */}
      {turn.status === 'done' && (turn.answer === null || turn.answer === '') ? (
        <Text style={type.caption}>{t.ask.noAnswer}</Text>
      ) : null}

      {/* A revision the phone could not publish. The sentence and the button together, because
          the owner asked for the change and this is the one thing left to do about it. */}
      {outcome?.kind === 'staged' ? (
        <View style={styles.staged}>
          <Text style={type.caption}>{t.ask.staged}</Text>
          <Button
            label={t.ask.publish}
            variant="secondary"
            onPress={() => turn.commandId !== null && onPublish(turn.commandId)}
          />
        </View>
      ) : null}

      {/* The desk's own words for a result this app has no vocabulary for — a worker one release
          ahead, or a failure message. Drawn rather than swallowed. */}
      {outcome?.kind === 'other' ? <Text style={type.caption}>{outcome.text}</Text> : null}

      {turn.error !== null ? <Text style={styles.error}>{turn.error}</Text> : null}

      {turn.status === 'unsent' ? (
        <Button label={t.ask.retry} variant="secondary" onPress={() => onRetry(turn.id)} />
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  root: { gap: space.md, paddingVertical: space.lg },
  question: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    padding: space.lg,
  },
  chipRow: { flexDirection: 'row' },
  staged: { gap: space.sm },
  error: { ...type.caption, color: colors.down, fontFamily: fonts.medium },
})
