import { StyleSheet } from 'react-native'
import { useWindowDimensions } from 'react-native'
import Svg, { Defs, Ellipse, RadialGradient, Stop } from 'react-native-svg'
import { gradients } from '../theme'

// The four aurora blobs: center and radii as fractions of the window (cx/rx/ry of width,
// cy of height), with the per-blob center opacity. Rendered as radial gradients fading
// the color to fully transparent at the rim — a header atmosphere, never a wallpaper.
const BLOBS = [
  { color: gradients.aurora[0], cx: 0.15, cy: 0.08, rx: 0.45, ry: 0.32, opacity: 0.16 }, // green
  { color: gradients.aurora[1], cx: 0.85, cy: 0.12, rx: 0.45, ry: 0.32, opacity: 0.14 }, // teal
  { color: gradients.aurora[2], cx: 0.3, cy: 0.26, rx: 0.5, ry: 0.3, opacity: 0.12 }, // violet
  { color: gradients.aurora[3], cx: 0.75, cy: 0.3, rx: 0.45, ry: 0.24, opacity: 0.14 }, // pink
] as const

/**
 * The page-only aurora atmosphere, rendered under content by `Screen` when `aurora` is
 * set. All geometry is computed in pixels from the window — never SVG percentage strings
 * (a percentage `ry` resolves against viewport height, not width) — and every blob is
 * clamped so no ellipse rim reaches below 45% of the screen height on any window shape.
 */
export function AuroraBackground({ intensity = 1 }: { intensity?: number }) {
  const { width, height } = useWindowDimensions()
  const level = Math.max(0, Math.min(1, intensity))
  return (
    <Svg width={width} height={height} style={styles.fill} pointerEvents="none">
      <Defs>
        {BLOBS.map((b, i) => (
          <RadialGradient key={b.color} id={`aurora-${i}`} cx="50%" cy="50%" r="50%">
            <Stop offset="0%" stopColor={b.color} stopOpacity={b.opacity * level} />
            <Stop offset="100%" stopColor={b.color} stopOpacity={0} />
          </RadialGradient>
        ))}
      </Defs>
      {BLOBS.map((b, i) => {
        const cy = b.cy * height
        // The rim may not cross 45% of the window height (a wide/short window would
        // otherwise push it past the line the table satisfies on typical phones).
        const ry = Math.min(b.ry * width, 0.45 * height - cy)
        if (ry <= 0) return null
        return (
          <Ellipse
            key={b.color}
            cx={b.cx * width}
            cy={cy}
            rx={b.rx * width}
            ry={ry}
            fill={`url(#aurora-${i})`}
          />
        )
      })}
    </Svg>
  )
}

const styles = StyleSheet.create({
  fill: {
    position: 'absolute',
    top: 0,
    left: 0,
  },
})
