import { StyleSheet, Text, View } from 'react-native'
import { colors, spacing, typography } from '../theme/index'
import { Button } from './Button'

/**
 * The desk's empty-state shape — title, body, one optional action (plan Design > Copy: "No desk
 * yet", "No board paired", "Nothing filed yet", …). Always chrome: an empty state is the app
 * admitting it has nothing to show yet, not a fact printed on paper.
 */
export function EmptyState({
  title,
  body,
  actionLabel,
  onAction,
}: {
  title: string
  body: string
  actionLabel?: string
  onAction?: () => void
}) {
  return (
    <View style={styles.wrap}>
      <Text style={[typography.uiStrong, styles.title]}>{title}</Text>
      <Text style={[typography.ui, styles.body]}>{body}</Text>
      {actionLabel && onAction ? (
        <Button label={actionLabel} onPress={onAction} variant="secondary" style={styles.action} />
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing[12],
    paddingHorizontal: spacing[32],
  },
  title: {
    color: colors.deskText,
    textAlign: 'center',
  },
  body: {
    color: colors.deskDim,
    textAlign: 'center',
    lineHeight: 21,
  },
  action: {
    marginTop: spacing[8],
  },
})
