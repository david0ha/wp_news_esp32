import { Pressable, StyleSheet, Text, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useRouter } from 'expo-router'
import { Card } from '../Card'
import { ScreenMessage } from '../ScreenMessage'
import { useCancelCommand, useCommands } from '../../lib/queries'
import { DeskError, deskHumanError, type Command } from '../../lib/desk'
import { canCancelCommand, commandKindLabel, commandStatus } from '../../lib/queue'
import { colors, radius, spacing, typography } from '../../theme/index'

/**
 * How many rows the queue prints before it stops.
 *
 * `Desk.commands()` answers with up to a HUNDRED, and a hundred rows under a state strip is a tab
 * nobody can reach the bottom of. Twelve covers what is waiting plus what has just happened, which
 * is the question this section answers; the count of what is left is printed underneath rather
 * than dropped silently, because a truncated list that does not say it is truncated is the app
 * telling the reader the queue is shorter than it is.
 */
const ROWS_SHOWN = 12

/**
 * The queue — what the desk has been asked for, and what came of it (plan Design > Wireframes).
 *
 * The ✕ appears only on a PENDING row (`queue.ts`'s `canCancelCommand`). A claimed command belongs
 * to the worker that claimed it, and a cancel control there would be a button whose only possible
 * outcome is the desk's 404.
 */
export function QueueList() {
  const commands = useCommands()
  const cancel = useCancelCommand()

  if (commands.isLoading) {
    return (
      <Card style={styles.messageCard}>
        <ScreenMessage loading />
      </Card>
    )
  }

  if (commands.isError) {
    return (
      <Card style={styles.messageCard}>
        <ScreenMessage
          error={
            commands.error instanceof DeskError
              ? deskHumanError(commands.error)
              : 'Couldn’t read the queue.'
          }
          onRetry={() => commands.refetch()}
        />
      </Card>
    )
  }

  const rows = commands.data ?? []
  if (rows.length === 0) {
    return (
      <Card style={styles.card}>
        <View style={styles.empty}>
          <Text style={[typography.uiStrong, styles.emptyTitle]}>The queue is empty</Text>
          <Text style={[typography.ui, styles.emptyBody]}>Nothing is waiting for the worker.</Text>
        </View>
      </Card>
    )
  }

  const shown = rows.slice(0, ROWS_SHOWN)
  const hidden = rows.length - shown.length

  return (
    <Card style={styles.card}>
      {shown.map((command, i) => (
        <QueueRow
          key={command.id}
          command={command}
          last={i === shown.length - 1 && hidden === 0}
          // Only the row being cancelled goes quiet. One mutation serves every row, so without
          // the id comparison a single tap would put every ✕ on the screen into a pending state.
          cancelling={cancel.isPending && cancel.variables === command.id}
          onCancel={() => cancel.mutate(command.id)}
        />
      ))}
      {hidden > 0 ? (
        <Text style={styles.more}>
          {hidden === 1 ? '1 more command on the desk.' : `${hidden} more commands on the desk.`}
        </Text>
      ) : null}
      {cancel.isError ? (
        <Text style={styles.error}>
          {cancel.error instanceof DeskError
            ? deskHumanError(cancel.error)
            : 'The desk didn’t take that cancel.'}
        </Text>
      ) : null}
    </Card>
  )
}

function QueueRow({
  command,
  last,
  cancelling,
  onCancel,
}: {
  command: Command
  last: boolean
  cancelling: boolean
  onCancel: () => void
}) {
  const router = useRouter()
  const mark = commandStatus(command.status)
  const cancellable = canCancelCommand(command.status)

  return (
    <View style={[styles.row, !last && styles.bordered]}>
      <View style={styles.head}>
        <Text style={[typography.ui, styles.glyph, toneStyle(mark.tone)]}>{mark.glyph}</Text>
        <Text style={[typography.uiStrong, styles.kind]} numberOfLines={1}>
          {commandKindLabel(command.kind)}
        </Text>
        {/* The label face on chrome — the identification role, which Task 24's ruling puts on both
            materials. The narrative faces (masthead/headline/deck/body) are the paper-only ones. */}
        <Text style={[styles.status, toneStyle(mark.tone)]}>{mark.word}</Text>
        {cancellable ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Cancel this command"
            accessibilityState={{ disabled: cancelling, busy: cancelling }}
            disabled={cancelling}
            hitSlop={8}
            onPress={onCancel}
            style={({ pressed }) => [styles.cancel, (pressed || cancelling) && styles.cancelDown]}
          >
            <Text style={[typography.ui, styles.cancelGlyph]}>✕</Text>
          </Pressable>
        ) : null}
      </View>

      <Text style={[typography.ui, styles.text]} numberOfLines={3}>
        {command.text}
      </Text>

      {/* What the worker said about it. Present on a done or failed row and empty otherwise, which
          is why it is not a fixed line — a blank row here reads as a result nobody filed. */}
      {command.result === '' ? null : (
        <Text style={[typography.ui, styles.result]} numberOfLines={3}>
          {command.result}
        </Text>
      )}

      {/* `has_notes` is the desk's own flag, so this link is drawn only where there is something
          behind it. The path segment is the NotesKind the client takes ('commands'), not a prettier
          singular — `notes/[kind]/[id]` hands its `kind` straight to `useNotes()`. */}
      {command.has_notes ? (
        <Pressable
          accessibilityRole="link"
          accessibilityLabel="What came of this command"
          hitSlop={8}
          onPress={() => router.push(`/notes/commands/${encodeURIComponent(command.id)}`)}
          style={({ pressed }) => [styles.dossier, pressed && styles.dossierDown]}
        >
          <Text style={[typography.ui, styles.dossierText]}>What came of it</Text>
          <Ionicons name="arrow-forward" size={13} color={colors.signal.chrome.tint} />
        </Pressable>
      ) : null}
    </View>
  )
}

function toneStyle(tone: 'up' | 'down' | 'warn' | 'neutral' | 'dim') {
  switch (tone) {
    case 'up':
      return { color: colors.signal.chrome.up }
    case 'down':
      return { color: colors.signal.chrome.down }
    case 'dim':
      return { color: colors.deskFaint }
    default:
      return { color: colors.deskDim }
  }
}

const styles = StyleSheet.create({
  card: {
    padding: 0,
    overflow: 'hidden',
    borderRadius: radius.lg,
    borderCurve: 'continuous',
  },
  messageCard: {
    minHeight: 120,
    justifyContent: 'center',
  },
  row: {
    paddingVertical: spacing[12],
    paddingHorizontal: spacing[16],
    gap: spacing[4],
  },
  bordered: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.deskFaint,
  },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[8],
    minHeight: 24,
  },
  glyph: {
    fontSize: 14,
    width: 16,
    textAlign: 'center',
  },
  kind: {
    fontSize: 15,
    color: colors.deskText,
    flexShrink: 1,
  },
  status: {
    ...typography.label,
    flex: 1,
  },
  cancel: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: -6,
  },
  cancelDown: {
    opacity: 0.45,
  },
  cancelGlyph: {
    fontSize: 17,
    color: colors.deskDim,
  },
  text: {
    fontSize: 14,
    color: colors.deskDim,
    lineHeight: 19,
  },
  result: {
    fontSize: 13,
    color: colors.deskFaint,
    lineHeight: 18,
  },
  dossier: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[4],
    minHeight: 32,
  },
  dossierDown: {
    opacity: 0.55,
  },
  dossierText: {
    fontSize: 13,
    color: colors.signal.chrome.tint,
  },
  empty: {
    padding: spacing[16],
    gap: spacing[4],
  },
  emptyTitle: {
    color: colors.deskText,
  },
  emptyBody: {
    color: colors.deskDim,
    lineHeight: 21,
  },
  more: {
    ...typography.ui,
    fontSize: 12,
    color: colors.deskFaint,
    paddingHorizontal: spacing[16],
    paddingBottom: spacing[12],
    paddingTop: spacing[8],
  },
  error: {
    ...typography.ui,
    fontSize: 13,
    color: colors.signal.chrome.down,
    paddingHorizontal: spacing[16],
    paddingBottom: spacing[12],
    lineHeight: 18,
  },
})
