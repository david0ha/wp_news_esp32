import { useEffect, useMemo, useRef, type ReactNode } from 'react'
import { Animated, StyleSheet, Text, View } from 'react-native'
import { useStrings } from '../../i18n'
import { colors, fonts, space, type } from '../../theme'
import { bubblesOf, parseMarkdown } from '../../lib/ask/markdown'
import { readResult, type Turn } from '../../lib/ask/threads'
import { Answer } from './Answer'
import { Button } from '../Button'
import { Chip } from '../Chip'

/**
 * One turn, drawn as a conversation: the owner's message on the right, and everything the desk
 * said back on the left, one bubble per paragraph.
 *
 * This used to be a card with prose under it, on the argument that two speakers do not need
 * telling apart. They do not — but a three-hundred-word answer set as one full-width block is a
 * document, and it read as one. Short messages down one side are what make an answer something to
 * skim, so the split is `bubblesOf`'s and the side a message is on is the only thing that says
 * who wrote it.
 *
 * WHAT IS NOT A MESSAGE IS NOT IN A BUBBLE. A status, an error, the "paper changed" chip and the
 * publish button are the app talking about the turn, not the desk talking in it, and they sit
 * under the bubbles as captions so nobody reads "Nobody picked this up" as the desk's reply.
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
  const waiting = turn.status === 'pending' || turn.status === 'claimed'
  const bubbles = useMemo(
    () => (turn.answer === null ? [] : bubblesOf(parseMarkdown(turn.answer))),
    [turn.answer],
  )
  // Whatever the desk's side of this turn has to show. A turn that never reached the desk has no
  // desk side at all, and drawing its label over nothing would put a speaker on a failed send.
  const deskNote =
    turn.status === 'expired'
      ? t.ask.status.expired
      : turn.status === 'cancelled'
        ? t.ask.status.cancelled
        : // Done, with nothing written. A real outcome of the worker's, and silence here would
          // look exactly like a turn that is still out.
          turn.status === 'done' && bubbles.length === 0
          ? t.ask.noAnswer
          : // The desk's own words for a result this app has no vocabulary for — a worker one
            // release ahead of it. A `failed` turn's `result` is excluded: it is the SAME
            // sentence `turn.error` already carries, and drawing both put it on screen twice.
            outcome?.kind === 'other' && turn.status !== 'failed'
            ? outcome.text
            : null
  const sent = turn.status !== 'sending' && turn.status !== 'unsent'
  const deskSide =
    waiting ||
    bubbles.length > 0 ||
    deskNote !== null ||
    outcome?.kind === 'revised' ||
    outcome?.kind === 'staged' ||
    (sent && turn.error !== null)

  return (
    <View style={styles.root}>
      <View style={styles.mine}>
        <Bubble side="mine">
          <Text style={styles.mineText}>{turn.text}</Text>
        </Bubble>
        {/* No time on a message that never left: `sentAt` is when it was tried, and a clock
            under it reads as a delivery. */}
        {turn.status !== 'unsent' ? (
          <Text style={styles.meta}>
            {turn.status === 'sending' ? t.ask.status.sending : clock(turn.sentAt)}
          </Text>
        ) : null}
        {!sent && turn.error !== null ? <Text style={styles.error}>{turn.error}</Text> : null}
        {turn.status === 'unsent' ? (
          <Button label={t.ask.retry} variant="secondary" onPress={() => onRetry(turn.id)} />
        ) : null}
      </View>

      {deskSide ? (
        <View style={styles.desk}>
          <Text style={styles.speaker}>{t.ask.desk}</Text>

          {bubbles.map((blocks, i) => (
            <Bubble key={i} side="desk">
              <Answer blocks={blocks} />
            </Bubble>
          ))}

          {/* While it is out: the dots say somebody is on it, and the sentence says which of
              the two stages — they are minutes apart, and "still working" with no idea which
              is the state that feels broken. */}
          {waiting ? (
            <>
              <Bubble side="desk">
                <TypingDots />
              </Bubble>
              <Text style={styles.note}>{t.ask.status[turn.status as 'pending' | 'claimed']}</Text>
            </>
          ) : null}

          {deskNote !== null ? <Text style={styles.note}>{deskNote}</Text> : null}

          {/* The chip that says the paper changed. `revised` only — a `staged` turn says
              something different below, because for that one nothing has reached the wall. */}
          {outcome?.kind === 'revised' ? (
            <View style={styles.chipRow}>
              <Chip label={t.ask.changed} icon="newspaper-outline" tone="accent" />
            </View>
          ) : null}

          {/* A revision the phone could not publish. The sentence and the button together,
              because the owner asked for the change and this is the one thing left to do. */}
          {outcome?.kind === 'staged' ? (
            <View style={styles.staged}>
              <Text style={styles.note}>{t.ask.staged}</Text>
              <Button
                label={t.ask.publish}
                variant="secondary"
                onPress={() => turn.commandId !== null && onPublish(turn.commandId)}
              />
            </View>
          ) : null}

          {sent && turn.error !== null ? <Text style={styles.error}>{turn.error}</Text> : null}
        </View>
      ) : null}
    </View>
  )
}

function Bubble({ side, children }: { side: 'mine' | 'desk'; children: ReactNode }) {
  return (
    <View style={[styles.bubble, side === 'mine' ? styles.bubbleMine : styles.bubbleDesk]}>
      {children}
    </View>
  )
}

/** Hours and minutes in the phone's own convention — a message is read on the day it was sent. */
function clock(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

const DOTS = [0, 1, 2]

/** Three dots taking turns. Opacity only, on the native driver, so a slow JS thread cannot stall it. */
function TypingDots() {
  const phase = useRef(new Animated.Value(0)).current
  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(phase, { toValue: 3, duration: 1200, useNativeDriver: true }),
    )
    loop.start()
    return () => loop.stop()
  }, [phase])
  return (
    <View style={styles.dots}>
      {DOTS.map((i) => (
        <Animated.View
          key={i}
          style={[
            styles.dot,
            {
              opacity: phase.interpolate({
                inputRange: [0, i, i + 0.5, i + 1, 3],
                outputRange: [0.3, 0.3, 1, 0.3, 0.3],
                extrapolate: 'clamp',
              }),
            },
          ]}
        />
      ))}
    </View>
  )
}

const styles = StyleSheet.create({
  root: { gap: space.md, paddingVertical: space.md },
  mine: { alignItems: 'flex-end', gap: space.xs },
  desk: { alignItems: 'flex-start', gap: space.xs },
  // 84% and not the full measure: the ragged far edge is what says whose side a message is on.
  bubble: {
    maxWidth: '84%',
    paddingHorizontal: space.md + 2,
    paddingVertical: space.sm + 2,
    borderRadius: 20,
  },
  // The corner nearest the speaker is the tight one — the tail, without drawing a tail.
  bubbleMine: { backgroundColor: colors.navy, borderBottomRightRadius: 6 },
  bubbleDesk: { backgroundColor: colors.surface, borderBottomLeftRadius: 6 },
  mineText: { ...type.body, color: colors.ink },
  speaker: { ...type.caption, fontFamily: fonts.semibold, marginLeft: space.xs },
  meta: { ...type.caption, fontSize: 12, marginRight: space.xs },
  note: { ...type.caption, marginLeft: space.xs, maxWidth: '84%' },
  chipRow: { flexDirection: 'row', marginTop: space.xs },
  staged: { gap: space.sm, alignItems: 'flex-start', marginTop: space.xs },
  error: {
    ...type.caption,
    color: colors.down,
    fontFamily: fonts.medium,
    marginHorizontal: space.xs,
    maxWidth: '84%',
  },
  dots: { flexDirection: 'row', gap: 5, paddingVertical: 6, paddingHorizontal: 2 },
  dot: { width: 7, height: 7, borderRadius: 4, backgroundColor: colors.textDim },
})
