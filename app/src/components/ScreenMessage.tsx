import { useState } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'
import Animated, { useReducedMotion } from 'react-native-reanimated'
import { colors, motion, typography } from '../theme/index'

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
  const [pressed, setPressed] = useState(false)
  const reducedMotion = useReducedMotion()
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onRetry}
      onPressIn={() => setPressed(true)}
      onPressOut={() => setPressed(false)}
      hitSlop={8}
    >
      <Animated.View style={[styles.retry, transition, pressed && !reducedMotion && pressedScale]}>
        <Text style={[typography.uiStrong, styles.retryText]}>Try again</Text>
      </Animated.View>
    </Pressable>
  )
}

// Reanimated's CSS transition keys aren't part of RN's own `ViewStyle`, so they live outside
// `StyleSheet.create` — its generic constraint rejects them even though `Animated.View`'s style
// prop accepts them fine.
const transition = {
  transform: [{ scale: 1 }],
  transitionProperty: 'transform' as const,
  transitionDuration: `${motion.press}ms`,
}
const pressedScale = { transform: [{ scale: 0.97 }] }

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
