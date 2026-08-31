// The one press treatment the animation gate allows on a pressable: `scale 0.97` over
// `motion.press` ms (Task 24's `<Button>`, plan Design > "Space, radius, motion"). Every component
// that needs it wants the exact same two objects, and before Task 33 each one spelled them out
// locally (`Button`, `Chip`, `SegmentedControl`, `ScreenMessage`'s retry) — four copies that could
// silently drift. One copy here, imported the way every other token is (`theme/index`'s own rule:
// "import from here, not from an individual module").
//
// Reanimated's CSS transition keys (`transitionProperty`/`transitionDuration`) aren't part of RN's
// own `ViewStyle`, so they live outside `StyleSheet.create` — its generic constraint rejects them
// as unknown properties even though `Animated.View`'s own style prop accepts them fine.
import { motion } from './motion'

export const pressTransition = {
  transform: [{ scale: 1 }],
  transitionProperty: 'transform' as const,
  transitionDuration: `${motion.press}ms`,
}

export const pressedScale = { transform: [{ scale: 0.97 }] }
