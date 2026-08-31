import { StyleSheet, Text, View } from 'react-native'
import { useRouter } from 'expo-router'
import { Button } from '../Button'
import { Card } from '../Card'
import { InfoRow } from '../InfoRow'
import { Standing } from '../Standing'
import {
  fetchResultLabel,
  fetchResultMessage,
  fetchResultTone,
  formatAge,
  formatInterval,
  pollSourceLabel,
} from '../../lib/format'
import type { NewsSource } from '../../lib/esp32'
import { colors, spacing, typography } from '../../theme/index'

/** Where the edition comes from, and how the last poll went. */
export function SourceSection({ source }: { source: NewsSource }) {
  const router = useRouter()
  return (
    <View style={styles.section}>
      <Standing label="SOURCE" tone="chrome" />
      <Card style={styles.rows}>
        <InfoRow
          label="URL"
          value={source.url || 'not set (demo)'}
          tone={source.url ? 'neutral' : 'dim'}
        />
        <InfoRow
          label="Last poll"
          value={fetchResultLabel(source.lastResult)}
          tone={fetchResultTone(source.lastResult)}
        />
        <InfoRow label="Last success" value={formatAge(source.ageSeconds)} />
        <InfoRow
          label="Polls"
          value={`${formatInterval(source.pollSeconds)}, ${pollSourceLabel(source.pollSource)}`}
          last
        />
      </Card>
      {source.lastResult !== 'ok' ? (
        <Text style={styles.note}>{fetchResultMessage(source.lastResult)}</Text>
      ) : null}
      <Button
        label="Change the news URL"
        variant="secondary"
        onPress={() => router.push('/settings')}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  section: {
    gap: spacing[12],
  },
  rows: {
    padding: 0,
    overflow: 'hidden',
  },
  note: {
    ...typography.note,
    color: colors.deskFaint,
  },
})
