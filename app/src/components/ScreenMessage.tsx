import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'
import Animated from 'react-native-reanimated'
import { colors, typography, usePressedScale } from '../theme/index'

/**
 * Centered loading / error / empty state shared across screens. Pass `loading` for a spinner,
 * `error` for an error message (with optional retry), or `message` for a neutral empty state.
 * Desk chrome, system font.
 */
export function ScreenMessage({
  loading,
  error,
  message,
  onRetry,
}: {
  loading?: boolean
  error?: string | null
  message?: string
  onRetry?: () => void
}) {
  return (
    <View style={styles.center}>
      {loading ? (
        <ActivityIndicator color={colors.signal.chrome.tint} />
      ) : error ? (
        <>
          <Text style={[typography.ui, styles.error]}>{error}</Text>
          {onRetry ? <RetryButton onRetry={onRetry} /> : null}
        </>
      ) : (
        <Text style={[typography.ui, styles.message]}>{message}</Text>
      )}
    </View>
  )
}

function RetryButton({ onRetry }: { onRetry: () => void }) {
  const [press, pressStyle] = usePressedScale()
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onRetry}
      {...press}
      hitSlop={8}
    >
      <Animated.View style={[styles.retry, pressStyle]}>
        <Text style={[typography.uiStrong, styles.retryText]}>Try again</Text>
      </Animated.View>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    paddingHorizontal: 24,
  },
  error: {
    color: colors.signal.chrome.down,
    textAlign: 'center',
    lineHeight: 20,
  },
  retry: {
    minHeight: 44,
    paddingHorizontal: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  retryText: {
    color: colors.signal.chrome.tint,
  },
  message: {
    color: colors.deskDim,
    textAlign: 'center',
  },
})
