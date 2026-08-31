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
import { useState } from 'react'
import { useReducedMotion } from 'react-native-reanimated'
import { motion } from './motion'

export const pressTransition = {
  transform: [{ scale: 1 }],
  transitionProperty: 'transform' as const,
  transitionDuration: `${motion.press}ms`,
}

export const pressedScale = { transform: [{ scale: 0.97 }] }

/** The two handlers a `<Pressable>` needs, ready to spread onto it. */
export interface PressHandlers {
  onPressIn: () => void
  onPressOut: () => void
}

/** Spreadable onto a `<Pressable>`, and an `Animated.View` style — mutable, because RN's own style
 *  prop types reject a `readonly` array and `as const` would produce one. */
export type PressedScale = [
  PressHandlers,
  (typeof pressTransition | typeof pressedScale | false)[],
]

/**
 * The whole press treatment as one call: the boolean, the two handlers, and the style.
 *
 * Sharing the two objects above stopped them drifting; it did not stop the *wiring* around them
 * being hand-copied, and that turned out to be the part with a failure mode. Each of ~30 pressables
 * spelled out its own `useState(false)`, its own `useReducedMotion()`, its own pair of
 * `onPressIn`/`onPressOut` arrows and its own `pressed && !reducedMotion && pressedScale` — and it
 * is the middle term of that conjunction that matters. A site that forgets `!reducedMotion` still
 * looks right to everyone who does not have Reduce Motion turned on, which is nearly everyone
 * reviewing it. That is not a class of bug worth leaving thirty chances at.
 *
 * Returned as a tuple so a component with two pressables can name both halves of each without
 * inventing a nested object: `const [rowPress, rowPressStyle] = usePressedScale()`.
 *
 * `active` is for the one shape a plain boolean cannot express: a control that should not respond
 * at all until some other condition holds (the pairing wizard's CTA, which is inert until a
 * password is long enough). Left off, it is always on.
 */
export function usePressedScale(active = true): PressedScale {
  const [pressed, setPressed] = useState(false)
  const reducedMotion = useReducedMotion()
  return [
    { onPressIn: () => setPressed(true), onPressOut: () => setPressed(false) },
    [pressTransition, pressed && active && !reducedMotion && pressedScale],
  ]
}
