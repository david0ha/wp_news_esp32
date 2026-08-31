import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { Stack, useRouter } from 'expo-router'
import Animated from 'react-native-reanimated'
import { Screen } from '../../components/Screen'
import { EmptyState } from '../../components/EmptyState'
import { ScreenMessage } from '../../components/ScreenMessage'
import { Stamp } from '../../components/Stamp'
import {
  deskKeys,
  queryClient,
  useDeskClient,
  useDeskNow,
  useEditions,
  usePullRefresh,
} from '../../lib/queries'
import { deskHumanError, type EditionMeta } from '../../lib/desk'
import { editionPointer, editionWhen } from '../../lib/editions'
import { colors, spacing, typography, usePressedScale } from '../../theme/index'

/**
 * The editorial history — every edition the desk still keeps a directory for, newest first as the
 * desk hands them back (`listEditionsNewestFirst()` on the desk's own side; this screen does not
 * re-sort). Reached from the Desk tab's EDITIONS row and from `StateStrip`'s Current/Staged rows.
 *
 * `current`/`staged` come off the SAME `listEditions()` call as the rows — not `useDeskState()`'s
 * own copy, which is a five-row slice and can be missing the very row a pointer names.
 */
export default function Editions() {
  const router = useRouter()
  const client = useDeskClient()
  const editions = useEditions()
  const now = useDeskNow()

  // `usePullRefresh` rather than `editions.isRefetching`, which is what this screen used to bind
  // and is reachable two ways it has no gesture behind: `refetchOnWindowFocus` is react-query's
  // default and `focusManager` is wired to AppState, so backgrounding the app and coming back
  // spins it; and `deskInvalidates.promote` reaches `editions()`, so promoting from the detail
  // screen and tapping back spins it on arrival.
  const { pulling, onRefresh } = usePullRefresh(() =>
    queryClient.invalidateQueries({ queryKey: deskKeys.editions() }),
  )

  if (client === null) {
    return (
      <Screen edges={['top']}>
        <Stack.Screen options={{ title: 'Editions' }} />
        <EmptyState
          title="No desk yet"
          body="Add its address and operator token in Settings, and the editorial history appears here."
          actionLabel="Open settings"
          onAction={() => router.push('/settings')}
        />
      </Screen>
    )
  }

  const rows = editions.data?.editions ?? []
  const current = editions.data?.current ?? null
  const staged = editions.data?.staged ?? null

  return (
    <Screen edges={['top']}>
      <Stack.Screen options={{ title: 'Editions' }} />
      {editions.isLoading ? (
        <ScreenMessage loading />
      ) : editions.isError ? (
        <ScreenMessage
          error={deskHumanError(editions.error, 'Couldn’t load the editorial history.')}
          onRetry={() => editions.refetch()}
        />
      ) : rows.length === 0 ? (
        <EmptyState
          title="Nothing filed yet"
          body="When the desk publishes an edition it lands here."
          actionLabel="Order today’s edition"
          onAction={() => router.push('/compose?kind=edition')}
        />
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(e) => e.id}
          contentContainerStyle={styles.list}
          refreshControl={
            <RefreshControl
              refreshing={pulling}
              onRefresh={onRefresh}
              tintColor={colors.signal.chrome.tint}
            />
          }
          renderItem={({ item, index }) => (
            <EditionRow
              edition={item}
              now={now}
              pointer={editionPointer(item.id, current, staged)}
              last={index === rows.length - 1}
              onPress={() => router.push(`/editions/${encodeURIComponent(item.id)}`)}
            />
          )}
        />
      )}
    </Screen>
  )
}

function EditionRow({
  edition,
  now,
  pointer,
  last,
  onPress,
}: {
  edition: EditionMeta
  now: number
  pointer: 'current' | 'staged' | null
  last: boolean
  onPress: () => void
}) {
  const [press, pressStyle] = usePressedScale()
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Edition ${edition.id.slice(0, 8)}${pointer ? `, ${pointer}` : ''}`}
      onPress={onPress}
      {...press}
    >
      <Animated.View
        style={[
          styles.row,
          !last && styles.bordered,
          pressStyle,
        ]}
      >
        <View style={styles.rowText}>
          <Text style={[typography.uiStrong, styles.id]} numberOfLines={1}>
            {edition.id.slice(0, 8)}
          </Text>
          <Text style={styles.when} numberOfLines={1}>
            {editionWhen(edition, now)}
          </Text>
        </View>
        {pointer ? <Stamp tone="chrome">{pointer}</Stamp> : null}
        <Ionicons name="chevron-forward" size={16} color={colors.deskFaint} style={styles.chevron} />
      </Animated.View>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  list: {
    paddingBottom: spacing[24],
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 56,
    paddingVertical: spacing[12],
    paddingLeft: spacing[16],
    paddingRight: spacing[12],
    gap: spacing[12],
  },
  bordered: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.deskFaint,
  },
  rowText: {
    flex: 1,
    gap: spacing[4],
  },
  id: {
    fontSize: 15,
    color: colors.deskText,
  },
  when: {
    ...typography.ui,
    fontSize: 12,
    color: colors.deskFaint,
  },
  chevron: {
    width: 16,
  },
})
