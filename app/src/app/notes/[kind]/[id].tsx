import { ScrollView, StyleSheet, Text } from 'react-native'
import { Stack, useLocalSearchParams, useRouter } from 'expo-router'
import { EmptyState } from '../../../components/EmptyState'
import { Markdown } from '../../../components/Markdown'
import { Screen } from '../../../components/Screen'
import { ScreenMessage } from '../../../components/ScreenMessage'
import { Sheet } from '../../../components/Sheet'
import { Standing } from '../../../components/Standing'
import { useDeskClient, useNotes } from '../../../lib/queries'
import { deskHumanError, type NotesKind } from '../../../lib/desk'
import { parse } from '../../../lib/md'
import { colors, spacing, typography } from '../../../theme/index'

/** `[kind]` accepts the wire's own two spellings verbatim — `desk.ts`'s `NotesKind`. */
function notesKind(raw: string | undefined): NotesKind | null {
  return raw === 'editions' || raw === 'commands' ? raw : null
}

const KIND_TITLE: Record<NotesKind, string> = {
  editions: 'The dossier',
  commands: 'What came of it',
}

/**
 * The dossier filed beside an edition, or the note filed beside a command — the desk's own
 * markdown, on paper (Task 30). `kind` is the wire's `NotesKind`: `'editions'` from a
 * `DossierRail`/edition-detail "The dossier" link, `'commands'` from `QueueList`'s "What came of
 * it" link (Task 29). Both are PLURAL — the literal `NotesKind` values, not a prettier singular —
 * because `useNotes()` hands `kind` straight to the desk's own path segment.
 *
 * A 404 (`getNotes()`'s own reading — desk.ts) is an ordinary condition here, not an error: the
 * worker did not file one this time.
 */
export default function Notes() {
  const router = useRouter()
  const params = useLocalSearchParams<{ kind: string; id: string }>()
  const kind = notesKind(params.kind)
  const id = params.id ?? ''

  const client = useDeskClient()
  // Disabled by `useNotes()`'s own `id !== ''` rule when `kind` is unknown and this screen never
  // asks — the guard below returns before any of this render's other branches are reached.
  const notes = useNotes(kind ?? 'editions', kind ? id : '')

  if (kind === null || id === '') {
    return (
      <Screen edges={['top']}>
        <Stack.Screen options={{ title: 'Notes' }} />
        <ScrollView contentContainerStyle={styles.scroll}>
          <Sheet style={styles.sheet}>
            <Text style={[typography.body, styles.missing]}>
              Nothing filed under that kind of notes.
            </Text>
          </Sheet>
        </ScrollView>
      </Screen>
    )
  }

  const title = KIND_TITLE[kind]

  if (client === null) {
    return (
      <Screen edges={['top']}>
        <Stack.Screen options={{ title }} />
        <EmptyState
          title="No desk yet"
          body="Add its address and operator token in Settings, and its notes appear here."
          actionLabel="Open settings"
          onAction={() => router.push('/settings')}
        />
      </Screen>
    )
  }

  return (
    <Screen edges={['top']}>
      <Stack.Screen options={{ title }} />
      {notes.isLoading ? (
        <ScreenMessage loading />
      ) : notes.isError ? (
        <ScreenMessage
          error={
            deskHumanError(notes.error, 'Couldn’t load these notes.')
          }
          onRetry={() => notes.refetch()}
        />
      ) : notes.data === null || notes.data === undefined ? (
        <EmptyState
          title="No notes filed"
          body="The worker files its research beside the edition. This one came without any."
        />
      ) : (
        <ScrollView contentContainerStyle={styles.scroll}>
          <Sheet style={styles.sheet}>
            <Standing label={title.toUpperCase()} tone="paper" />
            <Markdown blocks={parse(notes.data)} tone="paper" />
          </Sheet>
        </ScrollView>
      )}
    </Screen>
  )
}

const styles = StyleSheet.create({
  scroll: {
    padding: spacing[16],
  },
  sheet: {
    gap: spacing[16],
  },
  missing: {
    color: colors.ink,
  },
})
