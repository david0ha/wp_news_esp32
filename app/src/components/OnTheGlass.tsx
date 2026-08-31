import { useEffect, useState } from 'react'
import { Pressable, StyleSheet, Text, View, type ViewStyle } from 'react-native'
import { Image } from 'expo-image'
import Animated, {
  Easing,
  useAnimatedProps,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated'
import Svg, { Circle } from 'react-native-svg'
import { Sheet } from './Sheet'
import { Stamp } from './Stamp'
import { SCREEN_H, SCREEN_W } from '../lib/screen'
import { colors, motion, pressTransition, pressedScale, spacing, typography } from '../theme/index'

// Portrait 1200 x 1600 — the panel's own geometry, taken from lib/screen.ts rather than spelled
// out again, because it is the same number the decoder reads a framebuffer with and two spellings
// of one geometry is one spelling too many. It is the proportion this component will not let
// anything stretch: a sheet drawn at the wrong shape cannot be compared with the thing hanging on
// the wall, which is the only reason to draw it at all.
const SHEET_ASPECT = SCREEN_W / SCREEN_H

/** The refresh ring, in the top-right corner of the sheet. */
const RING_BOX = 34
const RING_STROKE = 3
// Inset by a whole stroke width, so the arc sits comfortably INSIDE the paper disc behind it
// rather than riding its keyline.
const RING_R = (RING_BOX - RING_STROKE * 3) / 2
const RING_C = 2 * Math.PI * RING_R

const AnimatedCircle = Animated.createAnimatedComponent(Circle)

/**
 * Which sheet this is. The component draws what it is handed either way — the ORDER is the
 * caller's, and it is always the same one: the board's own glass when it is paired and answering,
 * the desk's proof of the current edition when it is not, and `none` when there is neither.
 *
 * The distinction earns its place because the two are not interchangeable claims. `live` is what
 * is physically printed. `proof` is what the desk rendered with the same typesetter and believes
 * the board is showing — true almost always, and wrong exactly when it matters (a board that never
 * woke, a failed poll). Only the accessibility label can say so out loud, so it does.
 */
export type GlassState = 'live' | 'proof' | 'none'

/**
 * The paper, and what is on it. The app's signature object.
 *
 * A square-cut sheet at the panel's own 1200 x 1600, hairline `ink` border, no radius, on the desk
 * surround — a physical thing photographed against a work surface, not a card in a UI. Tapping it
 * raises the full-size viewer.
 *
 * THE RING IS NOT A SPINNER. It sweeps once, linearly, over `refreshMs` — which is
 * `state.panel.refreshMs`, the duration measured on THIS panel, not a design token (see
 * `src/theme/motion.ts`, which deliberately omits it). A Spectra 6 refresh has no partial
 * waveform: the sheet goes blank, flashes through its inks and comes back, once, over twenty to
 * thirty seconds. An eased curve would be a lie about a physical process that has no easing in it,
 * and a looping spinner would be a lie about a process that finishes.
 *
 * Everything moving here runs on the UI thread. The one JS callback is the timer that swaps the
 * stamp's sentence when the refresh window closes — once, at the end, because text cannot be
 * rewritten from a worklet.
 *
 * `imageHeaders` sits beside `imageUri` rather than folding into it because a desk proof is fetched
 * with an operator token and a data: URI carries none; expo-image wants the pair.
 */
export function OnTheGlass({
  imageUri,
  imageHeaders,
  since,
  refreshingUntilMs,
  refreshMs,
  onPress,
  state,
  style,
}: {
  /** A `data:` URI for the board's own framebuffer, or the desk's proof-sheet URL. */
  imageUri?: string
  /** Whatever that URL needs — `sheetHeaders()` for a desk proof; nothing for a data: URI. */
  imageHeaders?: Record<string, string>
  /** "06:04", from `formatSinceTime`. No stamp without it: an unknown hour is not a fact. */
  since?: string
  /** Epoch ms at which the refresh in flight is expected to be done. Past or absent = idle. */
  refreshingUntilMs?: number
  /** `state.panel.refreshMs` — how long this panel's one kind of refresh really takes. */
  refreshMs?: number
  onPress?: () => void
  state: GlassState
  style?: ViewStyle
}) {
  const reducedMotion = useReducedMotion()
  const [pressed, setPressed] = useState(false)

  // `refreshing` changes exactly twice per refresh — on arrival and when the window closes — and
  // drives only the stamp's wording. The ring itself never touches this.
  const [refreshing, setRefreshing] = useState(false)

  const progress = useSharedValue(0)
  const ringOpacity = useSharedValue(0)

  useEffect(() => {
    const remaining = (refreshingUntilMs ?? 0) - Date.now()
    if (remaining <= 0) {
      setRefreshing(false)
      progress.value = 0
      ringOpacity.value = 0
      return
    }

    setRefreshing(true)
    ringOpacity.value = 1

    if (reducedMotion) {
      // The end state, held. The ring's job is to say "this is happening and it takes a while";
      // with motion reduced, the stamp says that in words and the ring only has to be present.
      progress.value = 1
    } else {
      // A refresh that started before this component mounted is picked up part-way rather than
      // restarted, so re-opening the app mid-redraw does not reset the sweep to zero. `refreshMs`
      // is the total the fraction is measured against; without one, whatever is left is all we
      // know about, so the sweep is the whole ring over it.
      const total = refreshMs && refreshMs > 0 ? refreshMs : remaining
      progress.value = Math.min(1, Math.max(0, 1 - remaining / total))
      progress.value = withTiming(1, { duration: remaining, easing: Easing.linear })
    }

    const done = setTimeout(() => {
      setRefreshing(false)
      ringOpacity.value = reducedMotion ? 0 : withTiming(0, { duration: motion.reveal })
    }, remaining)
    return () => clearTimeout(done)
  }, [refreshingUntilMs, refreshMs, reducedMotion, progress, ringOpacity])

  const ringProps = useAnimatedProps(() => ({
    strokeDashoffset: RING_C * (1 - progress.value),
  }))
  const ringStyle = useAnimatedStyle(() => ({ opacity: ringOpacity.value }))

  const source = imageUri
    ? { uri: imageUri, ...(imageHeaders ? { headers: imageHeaders } : null) }
    : null

  const paper = (
    <Sheet style={styles.frame}>
      {source && state !== 'none' ? (
        <Image
          source={source}
          style={styles.image}
          contentFit="contain"
          accessibilityIgnoresInvertColors
        />
      ) : (
        // Nothing to show, said on the paper itself rather than over it. The label face is the
        // sheet's own standing-head voice (`ui_internal.h`'s furniture, `typography.label` here),
        // in `inkMuted` — quiet enough to read as an empty page and not as an error. The page-level
        // empty states ("No desk yet", "No board paired") are chrome and belong to the screen; this
        // is what the object itself says when it is blank.
        <View style={styles.blank}>
          <Text style={styles.blankLabel}>nothing on the glass yet</Text>
        </View>
      )}

      <Animated.View style={[styles.ring, ringStyle]} pointerEvents="none">
        <Svg width={RING_BOX} height={RING_BOX}>
          {/* A small piece of paper under the mark, keylined — the same move `colors.grade.yellow`
              forces for its discs, and for the same reason. `signal.paper.tint` is 9.26:1 on paper
              and nothing like that on a black masthead bar or a halftone, and the top-right corner
              of a broadsheet is exactly where the dark furniture lives. The ground makes the
              contrast a property of the ring rather than of whichever edition is underneath it. */}
          <Circle
            cx={RING_BOX / 2}
            cy={RING_BOX / 2}
            r={RING_BOX / 2 - StyleSheet.hairlineWidth}
            fill={colors.paper}
            stroke={colors.ink}
            strokeWidth={StyleSheet.hairlineWidth}
          />
          <AnimatedCircle
            cx={RING_BOX / 2}
            cy={RING_BOX / 2}
            r={RING_R}
            // Blue on paper: `signal.paper.tint`, 9.26:1 on the sheet. The ring is chrome laid over
            // paper, so it takes the paper tier — the lifted chrome blue is tuned for near-black.
            stroke={colors.signal.paper.tint}
            strokeWidth={RING_STROKE}
            strokeLinecap="round"
            fill="none"
            strokeDasharray={RING_C}
            // Start the sweep at twelve o'clock rather than at three, where SVG's angle zero is.
            originX={RING_BOX / 2}
            originY={RING_BOX / 2}
            rotation={-90}
            animatedProps={ringProps}
          />
        </Svg>
      </Animated.View>
    </Sheet>
  )

  return (
    <View style={[styles.wrap, style]}>
      {onPress && state !== 'none' ? (
        <Pressable
          accessibilityRole="imagebutton"
          accessibilityLabel={
            state === 'live'
              ? 'The page currently printed on the board. Opens it full size.'
              : 'The desk’s proof of the current edition. Opens it full size.'
          }
          accessibilityHint="Opens the sheet full size, where it can be pinched to zoom."
          onPress={onPress}
          onPressIn={() => setPressed(true)}
          onPressOut={() => setPressed(false)}
        >
          <Animated.View style={[pressTransition, pressed && !reducedMotion && pressedScale]}>
            {paper}
          </Animated.View>
        </Pressable>
      ) : (
        paper
      )}

      {refreshing ? (
        <Stamp tone="chrome" style={styles.stamp}>
          redrawing — about 25 seconds, and it flashes
        </Stamp>
      ) : since ? (
        <Stamp tone="chrome" style={styles.stamp}>{`hangs there since ${since}`}</Stamp>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: {
    gap: spacing[12],
  },
  frame: {
    aspectRatio: SHEET_ASPECT,
    // `Sheet` pads its children; a photograph of a sheet has no mount board around it.
    padding: 0,
    overflow: 'hidden',
  },
  image: {
    width: '100%',
    height: '100%',
  },
  blank: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing[24],
  },
  blankLabel: {
    ...typography.label,
    color: colors.inkMuted,
    textAlign: 'center',
  },
  ring: {
    position: 'absolute',
    top: spacing[12],
    right: spacing[12],
  },
  stamp: {
    alignSelf: 'center',
  },
})
