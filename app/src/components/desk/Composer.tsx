import { useEffect, useRef, useState } from 'react'
import { KeyboardAvoidingView, Platform, StyleSheet, Text, TextInput, View } from 'react-native'
import * as Haptics from 'expo-haptics'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Button } from '../Button'
import { SegmentedControl } from '../SegmentedControl'
import { Stamp } from '../Stamp'
import { useCustomCommand, useOrderEdition, useResearch } from '../../lib/queries'
import { DeskError, deskHumanError } from '../../lib/desk'
import { colors, radius, spacing, typography } from '../../theme/index'

/** The three things a phone can ask the desk for, in the order the segmented control shows them. */
export const COMPOSER_KINDS = ['edition', 'research', 'custom'] as const
export type ComposerKind = (typeof COMPOSER_KINDS)[number]

const KIND_LABELS = ['Edition', 'Research', 'Custom']

/** One kind that is not what a route's `?kind=` said, resolved to the one this app files by default. */
export function composerKind(raw: string | undefined): ComposerKind {
  return COMPOSER_KINDS.find((k) => k === raw) ?? 'edition'
}

const PLACEHOLDER: Record<ComposerKind, string> = {
  edition: 'A ticker, or what today’s edition should be about',
  research: 'A ticker, or the question to look into',
  custom: 'What the desk should do',
}

const HINT: Record<ComposerKind, string> = {
  edition:
    'The worker files a whole edition — two pages, both gates. It reaches the glass only if it clears them.',
  research: 'No paper is filed. What comes back is a note beside this instruction.',
  custom: 'Free text. What the worker does with it is up to what you asked for.',
}

/** How long the confirmation stands before the sheet closes itself. */
const DISMISS_MS = 900

/**
 * The composer — one order for the desk, raised as a form sheet from the Desk tab's ORDER row.
 *
 * ONE FIELD AND NOTHING ELSE. The wire takes a `priority`, a `source` and a `deadline_at` beside
 * the text, and none of them appears here: the desk defaults all three, and a phone that asked for
 * a priority before it would take an instruction is a phone asking a question its owner has no way
 * to answer. `kind` is the one thing that genuinely changes what happens — `file_edition` produces
 * paper, `research` never does (agent's own pipeline, Task 11's ruling) — so it is the one control
 * beside the text, and it is preselected by whichever button raised the sheet.
 *
 * The confirmation is shown BEFORE the sheet dismisses rather than instead of dismissing. A form
 * sheet that closes the instant a request succeeds is indistinguishable from one that closes
 * because the drag gesture was misread, and the instruction is now somewhere the reader cannot see
 * it — the queue on the tab underneath, which they are not looking at yet.
 */
export function Composer({
  initialKind,
  fullScreen,
  onDone,
}: {
  initialKind: ComposerKind
  /**
   * True when this route is the FIRST screen of the stack and therefore renders full-screen rather
   * than as a form sheet — a deep link, or a cold start straight into `/compose`. `compose.tsx`
   * derives it from the same `router.canGoBack()` it already needs for `onDone`.
   */
  fullScreen: boolean
  onDone: () => void
}) {
  // THE INSET IS CONDITIONAL, and it was measured rather than assumed. Inside the form sheet this
  // route normally is, `insets.top` still reports the device's full status-bar allowance — 62 pt on
  // an iPhone 17 Pro, measured off two screenshots of the same sheet with and without it — even
  // though iOS has already presented the sheet below the bar. Applied unconditionally that is a
  // band of dead chrome above a sheet only half a screen tall. Dropped unconditionally, the header
  // lands on the clock in the one case `compose.tsx` explicitly documents. So it is applied exactly
  // where the view really does start at the top of the screen.
  const insets = useSafeAreaInsets()
  const [kind, setKind] = useState<ComposerKind>(initialKind)
  const [text, setText] = useState('')

  const edition = useOrderEdition()
  const research = useResearch()
  const custom = useCustomCommand()
  const mutation = kind === 'edition' ? edition : kind === 'research' ? research : custom

  const trimmed = text.trim()
  const sent = mutation.isSuccess

  // The dismiss is a timer, so it has to be cancellable: a reader who drags the sheet down inside
  // the window unmounts this component, and a `router.back()` firing afterwards would pop whatever
  // they landed on instead.
  const done = useRef(onDone)
  done.current = onDone
  useEffect(() => {
    if (!sent) return
    const timer = setTimeout(() => done.current(), DISMISS_MS)
    return () => clearTimeout(timer)
  }, [sent])

  const onSend = () => {
    if (trimmed === '') return
    mutation.mutate(
      { text: trimmed },
      {
        onSuccess: () => {
          // One haptic, paired with the line above it — the gate's rule is that a tap the phone
          // acknowledges in the hand must also be acknowledged on the screen.
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)
        },
      },
    )
  }

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={[styles.header, { paddingTop: (fullScreen ? insets.top : 0) + spacing[8] }]}>
        <Stamp tone="chrome">order</Stamp>
        <Button label={sent ? 'Done' : 'Cancel'} variant="ghost" onPress={onDone} />
      </View>

      <View style={styles.body}>
        <SegmentedControl
          segments={[...KIND_LABELS]}
          selectedIndex={COMPOSER_KINDS.indexOf(kind)}
          onChange={(i) => {
            const next = COMPOSER_KINDS[i]
            if (next !== undefined) setKind(next)
          }}
          disabled={mutation.isPending || sent}
        />

        <TextInput
          value={text}
          onChangeText={setText}
          editable={!mutation.isPending && !sent}
          multiline
          autoFocus
          placeholder={PLACEHOLDER[kind]}
          placeholderTextColor={colors.deskFaint}
          accessibilityLabel="What to ask the desk for"
          style={[typography.ui, styles.input]}
        />

        <Text style={styles.hint}>{HINT[kind]}</Text>

        {sent ? (
          <View style={styles.confirm}>
            <Stamp tone="chrome">sent to the queue</Stamp>
            <Text style={styles.confirmBody}>
              It is waiting for the worker. The queue on the Desk tab has it.
            </Text>
          </View>
        ) : (
          <Button
            label="Send to the queue"
            onPress={onSend}
            loading={mutation.isPending}
            disabled={trimmed === ''}
          />
        )}

        {mutation.isError ? (
          <Text style={styles.error}>
            {mutation.error instanceof DeskError
              ? deskHumanError(mutation.error)
              : 'The desk didn’t take that.'}
          </Text>
        ) : null}
      </View>
    </KeyboardAvoidingView>
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
  },
  body: {
    padding: spacing[16],
    gap: spacing[16],
  },
  input: {
    minHeight: 110,
    color: colors.deskText,
    backgroundColor: colors.deskRaised,
    borderRadius: radius.md,
    borderCurve: 'continuous',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.deskFaint,
    padding: spacing[12],
    textAlignVertical: 'top',
  },
  hint: {
    ...typography.ui,
    fontSize: 12,
    color: colors.deskFaint,
    lineHeight: 17,
    marginTop: -spacing[8],
  },
  confirm: {
    gap: spacing[4],
    minHeight: 52,
    justifyContent: 'center',
  },
  confirmBody: {
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
