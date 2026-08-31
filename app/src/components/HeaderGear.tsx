import { useState } from 'react'
import { Pressable, StyleSheet } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import Animated, { useReducedMotion } from 'react-native-reanimated'
import { useRouter } from 'expo-router'
import { colors, pressTransition, pressedScale } from '../theme/index'

/**
 * The gear that opens Settings, in the top-right of every tab — plan Design > Wireframes, where
 * all four tabs carry the same `⚙` and Settings is a push rather than a fifth tab.
 *
 * It is one control repeated four times rather than four controls, because "where do I change the
 * desk address" must have exactly one answer no matter which tab the reader is on. Settings is a
 * root-stack screen, so the push covers the tab bar: the reader leaves the paper, changes a
 * setting, and comes back to the tab they were on.
 *
 * The 44 pt box is Apple's minimum hit target (HIG, Controls); the glyph inside is smaller, so the
 * padding is the tap area rather than something the icon has to fill.
 */
export function HeaderGear() {
  const router = useRouter()
  const [pressed, setPressed] = useState(false)
  const reducedMotion = useReducedMotion()
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Settings"
      hitSlop={4}
      onPress={() => router.push('/settings')}
      onPressIn={() => setPressed(true)}
      onPressOut={() => setPressed(false)}
    >
      <Animated.View
        style={[styles.tap, pressTransition, pressed && !reducedMotion && pressedScale]}
      >
        <Ionicons name="settings-outline" size={22} color={colors.deskDim} />
      </Animated.View>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  tap: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    // The glyph is 22 pt inside a 44 pt box; nudged to the right edge of the row so the box's
    // padding falls outside the screen gutter rather than inside it.
    marginRight: -10,
  },
})
