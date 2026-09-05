import { useMemo, useRef, useState } from 'react'
import { ActivityIndicator, StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native'
import Svg, { Circle, Defs, Line, LinearGradient, Path, Stop } from 'react-native-svg'
import { Gesture, GestureDetector } from 'react-native-gesture-handler'
import { useStrings } from '../i18n'
import { colors, type } from '../theme'
import { type ChartPoint } from '../lib/market/types'

// Gradient ids are looked up by url(#id), so two mounted charts (a pushed detail over a
// pushed detail) must not share one. A module counter is enough.
let chartSeq = 0

/**
 * The axis-free hero chart (spec §2.2): one full-bleed SVG line colored by where the last
 * close sits against the baseline, a dotted prev-close reference hairline when the baseline
 * is near the day's range, a gradient wash under the line, and a horizontal-pan scrub that
 * reports the nearest point upward — the *header* renders the scrubbed price, never the
 * chart itself.
 */
export function PriceChart({
  points,
  baselineValue,
  height = 220,
  onScrub,
  loading = false,
}: {
  /** { t: epoch seconds, close } — time-ascending, as ChartData delivers them. */
  points: ChartPoint[]
  /** prevClose on 1D, first close otherwise (the screen computes via baselineFor). */
  baselineValue: number | null
  height?: number
  /** Called with the nearest point while scrubbing, null on release. */
  onScrub?: (p: ChartPoint | null) => void
  /** A refetch in flight. With points on screen this dims them instead of blanking. */
  loading?: boolean
}) {
  const t = useStrings()
  const [width, setWidth] = useState(0)
  const [scrubIdx, setScrubIdx] = useState<number | null>(null)
  const [fillId] = useState(() => `pricechart-fill-${++chartSeq}`)

  // Drop anything non-finite before scaling — a NaN close would poison the whole path string.
  const drawable = useMemo(() => points.filter((p) => Number.isFinite(p.close) && Number.isFinite(p.t)), [points])

  const geometry = useMemo(() => {
    if (drawable.length < 2 || width <= 0) return null
    let lo = Infinity
    let hi = -Infinity
    for (const p of drawable) {
      if (p.close < lo) lo = p.close
      if (p.close > hi) hi = p.close
    }
    const span = hi - lo

    // Include the baseline in the domain only when it is within half a span of the closes;
    // a huge overnight gap must not squash the day's shape, so a far baseline draws no line.
    const baselineInDomain =
      baselineValue !== null &&
      Number.isFinite(baselineValue) &&
      baselineValue >= lo - 0.5 * span &&
      baselineValue <= hi + 0.5 * span
    if (baselineInDomain) {
      lo = Math.min(lo, baselineValue)
      hi = Math.max(hi, baselineValue)
    }
    const domainSpan = hi - lo
    const pad = domainSpan > 0 ? domainSpan * 0.04 : Math.abs(lo) * 0.01 || 1
    const yLo = lo - pad
    const yRange = hi + pad - yLo

    const xAt = (i: number) => (i / (drawable.length - 1)) * width
    const yAt = (v: number) => height - ((v - yLo) / yRange) * height

    let path = ''
    for (let i = 0; i < drawable.length; i++) {
      const cmd = i === 0 ? 'M' : 'L'
      path += `${cmd}${xAt(i).toFixed(2)} ${yAt(drawable[i].close).toFixed(2)} `
    }
    const areaPath = `${path}L${width} ${height} L0 ${height} Z`

    // Zero carries no color: a period that closed exactly on its baseline draws neutral.
    const effectiveBaseline = baselineValue ?? drawable[0].close
    const last = drawable[drawable.length - 1].close
    const lineColor =
      last > effectiveBaseline ? colors.upBright : last < effectiveBaseline ? colors.downBright : colors.textDim

    return {
      path: path.trimEnd(),
      areaPath,
      baselineY: baselineInDomain ? yAt(baselineValue) : null,
      lineColor,
      xAt,
      yAt,
    }
  }, [drawable, baselineValue, width, height])

  // Scrub bookkeeping lives in refs so the gesture callbacks never read stale state; state
  // updates (and the onScrub report) fire only when the nearest index actually changes —
  // that is the "one call per frame, no timers" throttle.
  const lastIdxRef = useRef<number | null>(null)
  const drawableRef = useRef(drawable)
  drawableRef.current = drawable
  const widthRef = useRef(width)
  widthRef.current = width
  const onScrubRef = useRef(onScrub)
  onScrubRef.current = onScrub

  const pan = useMemo(() => {
    const report = (gx: number) => {
      const pts = drawableRef.current
      const w = widthRef.current
      if (pts.length < 2 || w <= 0) return
      const raw = Math.round((gx / w) * (pts.length - 1))
      const i = Math.max(0, Math.min(pts.length - 1, raw))
      if (i !== lastIdxRef.current) {
        lastIdxRef.current = i
        setScrubIdx(i)
        onScrubRef.current?.(pts[i])
      }
    }
    const release = () => {
      if (lastIdxRef.current !== null) {
        lastIdxRef.current = null
        setScrubIdx(null)
        onScrubRef.current?.(null)
      }
    }
    return Gesture.Pan()
      .activeOffsetX([-5, 5]) // a deliberate horizontal drag activates the scrub…
      // …and early vertical travel FAILS it, handing the touch to the surrounding ScrollView.
      // activeOffsetX alone never fails on vertical movement, so a diagonal drag over this
      // full-bleed chart would capture the page scroll and start narrating scrub prices.
      .failOffsetY([-10, 10])
      .onStart((e) => report(e.x))
      .onUpdate((e) => report(e.x))
      .onEnd(release)
      .onFinalize(release)
  }, [])

  const onLayout = (e: LayoutChangeEvent) => setWidth(Math.round(e.nativeEvent.layout.width))

  // Nothing to draw: the spinner may replace the chart, but only here — once a line exists a
  // refetch dims it under a small spinner instead of flashing a hole where a chart just was.
  if (drawable.length < 2) {
    return (
      <View style={[styles.box, { height }]} onLayout={onLayout}>
        {loading ? (
          <ActivityIndicator color={colors.accent} />
        ) : (
          <Text style={styles.empty}>{t.marketDetail.noChartData}</Text>
        )}
      </View>
    )
  }

  const scrubPoint = scrubIdx !== null && scrubIdx < drawable.length ? scrubIdx : null

  return (
    <GestureDetector gesture={pan}>
      <View style={{ height }} onLayout={onLayout}>
        {geometry ? (
          <View style={loading ? styles.dimmed : undefined}>
            <Svg width={width} height={height}>
              <Defs>
                <LinearGradient id={fillId} x1="0%" y1="0%" x2="0%" y2="100%">
                  <Stop offset="0%" stopColor={geometry.lineColor} stopOpacity={0.1} />
                  <Stop offset="100%" stopColor={geometry.lineColor} stopOpacity={0} />
                </LinearGradient>
              </Defs>
              <Path d={geometry.areaPath} fill={`url(#${fillId})`} />
              {geometry.baselineY !== null ? (
                <Line
                  x1={0}
                  y1={geometry.baselineY}
                  x2={width}
                  y2={geometry.baselineY}
                  stroke={colors.borderStrong}
                  strokeWidth={1}
                  strokeDasharray={[1, 4]}
                />
              ) : null}
              <Path
                d={geometry.path}
                stroke={geometry.lineColor}
                strokeWidth={2}
                fill="none"
                strokeLinejoin="round"
                strokeLinecap="round"
              />
              {scrubPoint !== null ? (
                <>
                  <Line
                    x1={geometry.xAt(scrubPoint)}
                    y1={0}
                    x2={geometry.xAt(scrubPoint)}
                    y2={height}
                    stroke={colors.iris}
                    strokeWidth={1}
                  />
                  <Circle
                    cx={geometry.xAt(scrubPoint)}
                    cy={geometry.yAt(drawable[scrubPoint].close)}
                    r={5}
                    fill={geometry.lineColor}
                  />
                </>
              ) : null}
            </Svg>
          </View>
        ) : null}
        {loading ? (
          <View style={styles.spinnerOverlay} pointerEvents="none">
            <ActivityIndicator size="small" color={colors.accent} />
          </View>
        ) : null}
      </View>
    </GestureDetector>
  )
}

const styles = StyleSheet.create({
  box: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  empty: {
    ...type.caption,
  },
  dimmed: {
    opacity: 0.3,
  },
  spinnerOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
})
