import { useCallback, useState } from 'react'
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { Screen } from '../components/Screen'
import { ScreenMessage } from '../components/ScreenMessage'
import { BackButton } from '../components/BackButton'
import { Button } from '../components/Button'
import { TurnRow } from '../components/ask/TurnRow'
import { fill, useStrings } from '../i18n'
import { MAX_COMMAND_TEXT } from '../lib/desk'
import { useAskThread } from '../lib/ask/useAskThread'
import { colors, fonts, layout, radius, space, type } from '../theme'

/**
 * Ask the desk — one conversation, and the composer under it.
 *
 * Reached two ways, and the parameter says which: from the Today header with nothing, which opens
 * a new question, or from a notification tap with `command=<id>`, which opens the thread that
 * command belongs to. The route param is the DESK's id because that is what the push carries; the
 * thread it belongs to is a lookup the hook does over what it read off disk.
 *
 * Everything decided about a turn is `threads.ts`'s; everything decided about the loop is
 * `useAskThread`'s. What is left here is layout.
 */
export default function AskScreen() {
  const router = useRouter()
  const t = useStrings()
  const { command } = useLocalSearchParams<{ command?: string }>()
  const { ready, thread, send, retry, publish } = useAskThread({ commandId: command ?? null })
  const [draft, setDraft] = useState('')

  const onSend = useCallback(() => {
    const text = draft.trim()
    if (text === '' || text.length > MAX_COMMAND_TEXT) return
    setDraft('')
    void send(text)
  }, [draft, send])

  // Back is the only exit — a root-stack route with no tab bar under it — and a notification tap
  // into a cold process leaves nothing to go back TO, so the arrow falls back to Today, the tab
  // this screen is about. `schedule.tsx` and `preview.tsx` make the same fallback.
  const header = (
    <View style={styles.titleRow}>
      <BackButton onPress={() => (router.canGoBack() ? router.back() : router.replace('/edition'))} />
      <Text style={styles.title}>{t.ask.title}</Text>
      <View style={styles.backSpacer} />
    </View>
  )

  // Storage has not answered. Half-known is unknown: drawing "add your desk" for one frame of
  // every open would send an owner who has one to go and set one up.
  if (ready === null) {
    return (
      <Screen>
        {header}
        <ScreenMessage loading />
      </Screen>
    )
  }

  // `message` and not `error`: a phone with no desk is a complete state, not a fault. Drawing it
  // in error red would put a failure in front of somebody who has simply never set a desk up —
  // `schedule.tsx` draws its own `empty.needsDesk` the same way.
  if (!ready) {
    return (
      <Screen>
        {header}
        <ScreenMessage message={t.ask.needsDesk} />
      </Screen>
    )
  }

  const tooLong = draft.trim().length > MAX_COMMAND_TEXT

  return (
    <Screen>
      {header}
      <KeyboardAvoidingView
        style={styles.fill}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView contentContainerStyle={styles.scroll}>
          {thread === null ? (
            <Text style={[type.body, styles.empty]}>{t.ask.empty}</Text>
          ) : (
            thread.turns.map((turn) => (
              <TurnRow key={turn.id} turn={turn} onRetry={retry} onPublish={publish} />
            ))
          )}
        </ScrollView>

        <View style={styles.composer}>
          {tooLong ? (
            <Text style={styles.tooLong}>
              {fill(t.ask.tooLong, { max: String(MAX_COMMAND_TEXT) })}
            </Text>
          ) : null}
          <TextInput
            style={styles.input}
            value={draft}
            onChangeText={setDraft}
            placeholder={t.ask.placeholder}
            placeholderTextColor={colors.textFaint}
            multiline
            // The desk's own ceiling, enforced here so a long paste is refused by the composer
            // rather than by a 400 four seconds later.
            maxLength={MAX_COMMAND_TEXT}
          />
          <Button
            label={t.ask.send}
            onPress={onSend}
            disabled={draft.trim() === '' || tooLong}
          />
        </View>
      </KeyboardAvoidingView>
    </Screen>
  )
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: layout.gutter,
    paddingBottom: space.sm,
  },
  title: { ...type.heading, flex: 1, textAlign: 'center' },
  backSpacer: { width: 40 },
  scroll: { paddingHorizontal: layout.gutter, paddingBottom: space.xl },
  empty: { color: colors.textDim, paddingTop: space.xl },
  composer: {
    gap: space.sm,
    paddingHorizontal: layout.gutter,
    paddingTop: space.md,
    paddingBottom: space.lg,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    backgroundColor: colors.surface,
  },
  input: {
    ...type.body,
    maxHeight: 140,
    minHeight: 44,
    backgroundColor: colors.surfaceAlt,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
  },
  tooLong: { ...type.caption, color: colors.down, fontFamily: fonts.medium },
})
