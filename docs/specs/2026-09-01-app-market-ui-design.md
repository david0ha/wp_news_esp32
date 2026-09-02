# Claude Post companion app — Markets UI + light retheme design spec

**Date:** 2026-09-01
**Status:** Authoritative. This is the single contract for the six parallel implementation
agents. Where this document and an agent's instinct disagree, this document wins. Where this
document is silent, follow the existing patterns in `app/src` (plain `StyleSheet.create`
importing `theme.ts` tokens; typed clients with injectable fetch and defensive coercers on the
model of `app/src/lib/esp32.ts`).

**Style sources (decided, not reopenable):**
- **Visual/component language — Stocketa** (light "neon aurora on frosted glass"): lavender
  canvas, white cards, magenta accent, navy filled buttons, 100px-radius pills, 18/22px card
  radii, three-layer floating shadow, Inter (as the Averta fallback), tabular numerals,
  green/red reserved for financial direction.
- **Information architecture — Robinhood iOS**: huge price headline over a delta line, axis-free
  full-bleed line chart, timeframe pill row, hairline label/value rows, card lists, bottom tabs.
  Numbers are the heroes; chrome is minimal.

**Decided constraints (do not reopen):** Stocketa LIGHT theme applies to the whole app including
every existing screen. Market data is fetched directly from the app via Yahoo Finance's
unofficial API (no desk-server proxy). Watchlist lives in AsyncStorage under
`claudepost.watchlist`. Charts are custom `react-native-svg` components. Navigation becomes
expo-router `Tabs` — Board / Markets / Settings — with onboarding staying a stack outside the
tabs. No styling library is introduced; plain `StyleSheet.create` + tokens throughout.

**Non-goals:** watchlist reordering, price alerts/push, portfolio/holdings, candlestick charts,
options trading actions, a dark theme. None of these ship in this pass; do not scaffold for them.

---

## 0. Ground rules every agent follows

1. **Color is semantic.** Green (`colors.up`) and red (`colors.down`) mean *financial direction
   and status* only — a delta, a chart that ended above/below its baseline, an EPS beat/miss, a
   healthy/broken board — plus one named exception: a **destructive action** (the
   swipe-to-remove panel) may fill `colors.down`. Transport/HTTP failure banners on market
   screens take `colors.warn`/`warnBg`, never the direction red — "the network broke" must not
   look like "stocks fell". Magenta (`colors.accent`) means *brand and interactive* — active
   pills, links, selection, the tab tint, ghost-button labels. Navy (`colors.navy`) is the
   filled-CTA color. Never use green/red for anything decorative; never use magenta for a
   number that moved. Duty split: `up`/`down`/`accent` are the darkened **text-duty** values
   (any Text, icon or small mark); `upBright`/`downBright`/`accentBright` are the vivid
   **graphics-duty** values (chart strokes, sparklines, fills, brand moments). Never put a
   Bright value on small text.
2. **Zero carries no sign and no color.** A delta of exactly 0 renders unsigned, arrow-less, in
   `colors.textDim`. (Same rule the firmware and `lib/format.ts` already follow.)
3. **Every numeral that can change width is tabular.** Any `Text` showing a price, delta,
   volume, OI, IV, count or time gets `fontVariant: ['tabular-nums']` (use the `tabular` token).
4. **Network failures degrade, never crash.** Every screen has explicit loading / error / empty
   states, and crumb-gated features (Info stats+profile, Calendar, Options) have a *degraded*
   state that renders a friendly card with a retry — the chart, watchlist and news must keep
   working even when the crumb bootstrap fails entirely.
5. **When a `fontFamily` is one of the Inter faces, do not also set `fontWeight`.** The weight is
   baked into the face name (`Inter_600SemiBold`); setting `fontWeight` alongside it makes
   Android fall back to the system font at that weight. The `type` tokens already follow this.
6. **All new pure logic gets a jest test with an injectable `fetch`/clock**, exactly like
   `esp32.test.ts` / `store.test.ts`. UI components are not unit-tested; logic is.
7. **No new dependencies beyond §5.** In particular: no styling lib, no react-query, no d3, no
   expo-web-browser (use `Linking.openURL`), no haptics.

---

## 1. Design tokens — the full new `app/src/theme.ts`

This is the complete proposed file content. Agent 1 writes it verbatim (comments included).
Every token name the current code uses (`bg`, `surface`, `surfaceAlt`, `border`, `borderStrong`,
`white`, `ink`, `text`, `textDim`, `textFaint`, `accent`, `accentDim`, `up/upBg`, `down/downBg`,
`warn`, `green/greenBg`, `red/redBg`, `radius.*`, `space.*`, `layout.gutter`, `fonts.mono`,
`fonts.monoIos`) keeps its name so existing screens retheme by token value alone. Names this
pass adds: `accentBright`, `upBright`, `downBright` — graphics-duty variants of the text-duty
`accent`/`up`/`down` (the duty split of §0.1).

```ts
// Design tokens for the Claude Post companion app. Light "aurora on frosted glass" —
// lavender canvas, white cards, a single magenta accent, navy filled CTAs, and a
// green/red pair reserved for financial direction and status.
//
// Type: Inter (loaded via @expo-google-fonts/inter in app/_layout.tsx). The design's
// face is Averta; Inter is the stated fallback and the one we ship. When a style sets
// one of the Inter fontFamily tokens it must NOT also set fontWeight — the weight is
// baked into the face, and a fontWeight beside it makes Android drop to the system font.

import { type TextStyle, type ViewStyle } from 'react-native'

export const colors = {
  bg: '#E0DDE2', // app canvas — Lavender Mist. Never white; white is for cards.
  surface: '#FFFFFF', // cards / sheets — Paper White
  surfaceAlt: '#F3F1F5', // pressed / nested rows / segmented tracks
  border: 'rgba(165,175,203,0.45)', // hairline dividers — Silver Lining
  borderStrong: 'rgba(165,175,203,0.85)',

  white: '#FFFFFF',
  ink: '#FFFFFF', // label color on FILLED controls (navy/magenta fills). Was "dark text
  // on light buttons" in the dark theme; the semantic is "text on the filled accent".
  text: '#1D2630', // primary text — Midnight Ink
  textDim: '#545E71', // secondary text — darkened from Pebble #9AA1B2 (which measured 1.9–2.6:1
  // in its text roles) to 5.9:1 on white / ~4.5:1 on the canvas. #9AA1B2 itself is non-text duty only.
  textFaint: 'rgba(29,38,48,0.55)', // placeholders / disabled (0.35 composited to 2.1:1 — under the 3:1 floor)

  accent: '#7E4099', // brand accent for TEXT and icons — darkened Aurora Magenta (5.1:1 on the canvas)
  accentBright: '#995BB9', // the true Aurora Magenta — fills and large brand moments only, never small text
  accentDim: 'rgba(153,91,185,0.18)', // active-pill fill (raised from 0.10, which measured ~1.1:1 and vanished)

  navy: '#3A4766', // filled button — Tidewater Navy
  navyPressed: '#2E3852',
  iris: '#5B638C', // Deep Iris — the chart scrub hairline, and strokes that must be darker than cloud. Never text.
  cloud: '#ABBDCF', // Cloud Veil — decorative strokes only (the itm wash derives from it). Never text.
  iconWell: 'rgba(165,175,203,0.30)', // feature-row icon squares (30% Silver Lining)

  up: '#0A6B4B', // gains, TEXT duty — direction only (darkened to pass 4.5:1 on canvas and white)
  upBright: '#0E9F6E', // gains, GRAPHICS duty — chart strokes, sparklines, fills (3:1 suffices there)
  upBg: 'rgba(14,159,110,0.12)',
  down: '#B81C2A', // losses, TEXT duty — direction only
  downBright: '#E02D3C', // losses, GRAPHICS duty — chart strokes, sparklines, fills
  downBg: 'rgba(224,45,60,0.10)',

  warn: '#C77700', // attention on a light canvas
  warnBg: 'rgba(199,119,0,0.12)',

  green: '#0A6B4B', // status: connected / live (mirrors up)
  greenBg: 'rgba(14,159,110,0.12)',
  red: '#B81C2A', // status: error (mirrors down)
  redBg: 'rgba(224,45,60,0.10)',

  itm: 'rgba(171,189,207,0.35)', // in-the-money row shading in the options chain (0.22 measured 1.14:1 and vanished)
} as const

// The aurora atmosphere (page background only, behind content, always subtle) and the
// headline gradient (large headlines / brand moments only — never body text or buttons).
export const gradients = {
  aurora: ['#7BE0AD', '#5AD0C7', '#9C8CE8', '#E89CC5'] as const, // green→teal→violet→pink
  headline: ['#995BB9', '#3A4766'] as const, // magenta→navy
} as const

export const radius = {
  sm: 8,
  md: 12,
  lg: 18, // standard card
  float: 22, // floating card
  pill: 999, // buttons and chips are ALWAYS full pills
} as const

export const space = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16, // card padding and element gap
  xl: 24,
  xxl: 32,
} as const

export const layout = {
  gutter: 16,
} as const

// Shadows. The Stocketa three-layer stack (outer rgba(97,110,124,0.114) 0 4px 15px +
// inset white highlight + 1px navy line) is approximated as just the outer shadow
// (iOS shadow / Android elevation) plus the card's own hairline border sitting on the
// lavender canvas. RN 0.76+ does support the CSS `boxShadow` style (inset included) on
// this stack; approximating is a deliberate choice — one shadow system keeps iOS and
// Android in parity, and a white inset highlight is invisible on an opaque white card
// anyway, which is also why there is no separate highlight style here.
export const shadow = {
  float: {
    shadowColor: '#616E7C',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.114,
    shadowRadius: 15,
    elevation: 4,
  } as ViewStyle,
  soft: {
    // small lift for segmented thumbs / search field
    shadowColor: '#616E7C',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.12,
    shadowRadius: 4,
    elevation: 2,
  } as ViewStyle,
} as const

// Type faces. Inter static faces from @expo-google-fonts/inter; monospace kept for the
// rare raw-identifier readout (device id, URL) — prices are Inter + tabular-nums now.
export const fonts = {
  regular: 'Inter_400Regular',
  medium: 'Inter_500Medium',
  semibold: 'Inter_600SemiBold',
  bold: 'Inter_700Bold',
  extrabold: 'Inter_800ExtraBold',
  mono: 'monospace',
  monoIos: 'Menlo',
} as const

/** Put this on any Text whose digits can change: prices, deltas, volumes, times. */
export const tabular: TextStyle = { fontVariant: ['tabular-nums'] }

// The type ramp, derived from the Stocketa desktop ramp and scaled to phone sizes;
// tracking tightens as size grows.
export const type = {
  display: {
    fontFamily: fonts.extrabold,
    fontSize: 42,
    lineHeight: 48,
    letterSpacing: -1.2,
    color: colors.text,
  } as TextStyle, // the big price / big brand moment
  headingLg: {
    fontFamily: fonts.extrabold,
    fontSize: 32,
    lineHeight: 38,
    letterSpacing: -0.6,
    color: colors.text,
  } as TextStyle, // screen titles ("Markets")
  heading: {
    fontFamily: fonts.semibold,
    fontSize: 24,
    lineHeight: 30,
    letterSpacing: -0.3,
    color: colors.text,
  } as TextStyle,
  headingSm: {
    fontFamily: fonts.semibold,
    fontSize: 18,
    lineHeight: 24,
    letterSpacing: -0.2,
    color: colors.text,
  } as TextStyle, // card titles, ticker symbols
  body: {
    fontFamily: fonts.regular,
    fontSize: 15,
    lineHeight: 22,
    letterSpacing: 0,
    color: colors.text,
  } as TextStyle,
  caption: {
    fontFamily: fonts.regular,
    fontSize: 13,
    lineHeight: 18,
    letterSpacing: 0.1,
    color: colors.textDim,
  } as TextStyle,
  label: {
    fontFamily: fonts.semibold,
    fontSize: 12,
    lineHeight: 16,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    color: colors.textDim,
  } as TextStyle, // the small uppercase section labels
} as const
```

Notes for consumers:
- Existing styles that set `fontWeight` with no `fontFamily` keep working (system font) but
  every restyled component in §3 switches to the `type` ramp / `fonts.*` faces.
- `colors.ink` flipped meaning-preservingly: it is still "the label on a filled control", which
  is now white-on-navy instead of near-black-on-cyan. No call-site changes needed.
- `radius.lg` changed 20 → 18 (standard card). Callers unchanged.
- Direction and accent hues are split by duty: `up`/`down`/`accent` are the text-duty values
  (Text, icons, small marks); `upBright`/`downBright`/`accentBright` are the graphics-duty
  values (chart strokes, sparklines, fills, brand moments). Never a Bright value on small text.

### 1.1 Font loading (lives in `app/src/app/_layout.tsx`, owned by Agent 3)

```tsx
import { useEffect } from 'react'
import {
  useFonts,
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
  Inter_800ExtraBold,
} from '@expo-google-fonts/inter'
import * as SplashScreen from 'expo-splash-screen'

SplashScreen.preventAutoHideAsync().catch(() => {})

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    Inter_400Regular, Inter_500Medium, Inter_600SemiBold, Inter_700Bold, Inter_800ExtraBold,
  })
  useEffect(() => {
    if (fontsLoaded || fontError) SplashScreen.hideAsync().catch(() => {})
  }, [fontsLoaded, fontError])
  if (!fontsLoaded && !fontError) return null
  // ...existing providers + Stack (see §3)
}
```

Exactly these five weights. On `fontError` the app proceeds — RN falls back to the system font
per-Text, which is the stated fallback. Do not block the app on a font.

---

## 2. Component inventory

### 2.1 Restyle rules — existing components (all owned by Agent 1; props unchanged unless stated)

| Component | Changes |
|---|---|
| **Screen** | `StatusBar style="dark"`. Root background `colors.bg`. **New prop** `aurora?: boolean` (default false): when true, renders `<AuroraBackground />` absolutely behind children (`pointerEvents="none"`). Props otherwise unchanged. |
| **Button** | Radius becomes `radius.pill` (the 100px pill — buttons are ALWAYS pills now). Height stays 52, `paddingHorizontal: 24`. `primary`: fill `colors.navy`, pressed fill `colors.navyPressed` (replace the opacity-press with a fill swap for primary; other variants keep `opacity: 0.8` pressed), label `colors.ink` (white), `type.body` sizing at `fonts.semibold` 16px, `letterSpacing: 0.2`. `secondary`: transparent fill, `borderWidth: 1, borderColor: colors.textDim` (the 1px outline ghost), label `colors.text`. `ghost`: borderless, label `colors.accent`. `danger`: fill `colors.downBg`, label `colors.down`. Disabled: `opacity: 0.5` (unchanged). Spinner color: `colors.ink` on primary, `colors.text` otherwise. |
| **Card** | Fill `colors.surface`, radius `radius.lg` (18), padding `space.lg` (16), hairline border `colors.border` kept. **New prop** `floating?: boolean`: adds `shadow.float` and radius `radius.float` (22); the hairline `colors.border` border stays and is the view's *only* border — there is no highlight border (a white inset stand-in is invisible on a white card, which is why the theme ships none). Lists inside cards keep hairline *bottom* borders between rows (InfoRow already does this). |
| **Chip** | Pill radius kept. Inactive: fill `colors.surface`, hairline `colors.border`, label/icon `colors.textDim` (`tone` still recolors: up/down/warn/accent as today, using the new token values). **Active: fill `colors.accentDim`, border `colors.accentDim` — i.e. set it, invisible against the fill (this *is* a change from the inactive `colors.border`) — label + icon `colors.accent`** — the Stocketa time-chip treatment replaces the old solid-accent fill. Label: `fonts.semibold` 13. |
| **SegmentedControl** | Track: fill `colors.surfaceAlt`, radius `radius.pill`, padding 4 — buttons and chips are always pills, and the track and thumb follow the same language. Active segment: fill `colors.surface` + `shadow.soft`, radius `radius.pill`, label `colors.text` at `fonts.semibold`. Inactive label `colors.textDim`. (iOS-style thumb; used for A1/A2 on Board and Calls/Puts in Options.) |
| **StatTile** | Fill `colors.surface`, radius `radius.md`, hairline `colors.border`. Label: `type.label`. Value: `fonts.bold` 26, `colors.text`, add `tabular`. `valueWarn` → `colors.warn`. Footnote `type.caption`. |
| **InfoRow** | Colors update via tokens automatically; set label `type.caption` at 14 (`fontSize: 14`), value `fontFamily: fonts.medium`, 14, `colors.text`, add `tabular` to the value Text. Tones map to new up/down/warn/textFaint. |
| **ScreenMessage** | Spinner `colors.accent`. Error text `colors.down`, message `colors.textDim`, retry label `colors.accent` at `fonts.semibold`. No structural change. |
| **BackButton** | Circle: fill `colors.surface`, `borderColor: colors.border`, icon `colors.text`. Same 42px circle. |
| **IconBadge** | Fill `colors.iconWell` (the 30% Silver Lining square), radius `radius.lg`, icon `colors.accent`. Same 96px box. |
| **StepHero** | Title `type.heading` (28 → keep 28: override `fontSize: 28`, `fontFamily: fonts.bold`, `letterSpacing: -0.4`, `colors.text`). Body `type.body` at `colors.textDim`. `heroBold` export becomes `{ fontFamily: fonts.bold, color: colors.text }`. |
| **StepScaffold** | Progress track `colors.surfaceAlt`, fill `colors.accent`. SKIP label `colors.textDim` at `fonts.semibold`. Structure unchanged. |

Sweep rule for Agent 3 (screens): after the token flip, grep every screen file it owns for
hex/rgba literals and replace them with tokens; no screen may carry a hardcoded color.

### 2.2 New components (full prop specs)

All new components live in `app/src/components/` (or `components/detail/` where stated), are
**named exports — no default export — exactly like the existing components** (`export function
Foo(...)`), and style with `StyleSheet.create` + tokens only.

#### `AuroraBackground.tsx` (Agent 1)

The page-only atmosphere. Absolute-fill, `pointerEvents="none"`, rendered *under* content by
`Screen` when `aurora` is set. Implementation: one `<Svg>` (`react-native-svg`) sized to the
window, containing four `<Ellipse>` fills, each with its own `<RadialGradient>` in `<Defs>`
fading the color to fully transparent at the rim (`stopOpacity 1 → 0`; the listed opacity goes
on the center stop). **All geometry is computed in pixels from `useWindowDimensions()`** —
never SVG percentage strings: in SVG a percentage `ry` resolves against viewport *height*, not
width, so the %-of-width figures below must be multiplied out to numbers before they reach the
`<Ellipse>`.

| blob | color | center (x% of width, y% of height) | rx / ry (% of width) | center opacity |
|---|---|---|---|---|
| 1 | `gradients.aurora[0]` green | 15%, 8% | 45% / 32% | 0.16 |
| 2 | `gradients.aurora[1]` teal | 85%, 12% | 45% / 32% | 0.14 |
| 3 | `gradients.aurora[2]` violet | 30%, 26% | 50% / 30% | 0.12 |
| 4 | `gradients.aurora[3]` pink | 75%, 30% | 45% / 24% | 0.14 |

```ts
export function AuroraBackground({ intensity = 1 }: { intensity?: number }) // 0..1 multiplies each opacity
```
**No ellipse may extend below 45% of screen height** — rims included, not just centers; the
aurora is a header atmosphere, not a wallpaper. The table satisfies this on typical phones, and
the implementation additionally clamps each blob (`ry = min(ry, 0.45 * height − cy)`) so a
wide/short window cannot push a rim past the line. It must stay subtle: content contrast is
measured against `colors.bg`, not the blobs.

#### `DeltaText.tsx` (Agent 1)

The "▲ 1.23 (0.45%) Today" line. Pure presentational; formatting via `lib/market/format.ts`.

```ts
export function DeltaText({
  delta,            // absolute change, e.g. +14.75; may be undefined while loading
  pct,              // percent-scaled change, e.g. 0.16 for 0.16% (NOT a 0–1 fraction); may be undefined
  suffix,           // e.g. 'Today' | '1W' — rendered after, in textDim
  size = 'md',      // 'sm' 13px | 'md' 15px | 'lg' 17px, all fonts.semibold + tabular
  currency = '',    // prefix for the absolute part; '' hides it. Screens pass
                    // currencySymbol(quote.currency) (§4.7) — never a hardcoded '$'
}: { delta?: number; pct?: number; suffix?: string; size?: 'sm'|'md'|'lg'; currency?: string })
```
Rules: delta > 0 → `colors.up` + '▲ '; < 0 → `colors.down` + '▼ ' (magnitudes rendered
unsigned — the arrow carries the sign); exactly 0 or undefined → `colors.textDim`, no arrow.
Render `—` (em dash, textDim — the same dash every §4.7 formatter uses) when both values are
undefined. Suffix always `colors.textDim`.

#### `Sparkline.tsx` (Agent 4)

```ts
export function Sparkline({
  data,               // number[] — closes; length >= 2 to draw, else renders empty space
  width = 64,
  height = 28,
  stroke,             // required color (TickerRow passes upBright/downBright/textDim by delta)
  strokeWidth = 1.5,
}: { data: number[]; width?: number; height?: number; stroke: string; strokeWidth?: number })
```
Single `<Polyline>` in an `<Svg>`; x = index mapped linearly to [1, width−1], y = value mapped
to [height−2, 2] over `[min(data), max(data)]` (flat series → horizontal midline). No fill, no
axes, `strokeLinejoin/Linecap="round"`. NaN points are dropped before scaling.

#### `PriceChart.tsx` (Agent 5)

The axis-free hero chart with touch scrub.

```ts
import { type ChartPoint } from '../lib/market/types'

export function PriceChart({
  points,                 // ChartPoint[] ({ t: epoch seconds, close: number })
  baselineValue,          // number | null — prevClose for 1D, first close otherwise (screen computes)
  height = 220,
  onScrub,                // (p: ChartPoint | null) => void — null on release
  loading = false,        // see the Loading rule below — never blanks an already-drawn line
}: {...})
```
- **Line:** one `<Path>` (`M/L` segments), `strokeWidth 2`, round joins, no axes, no labels
  inside the chart. Full-bleed: the parent renders it edge-to-edge (no gutter).
- **Color** (graphics duty → the Bright pair): `colors.upBright` when `points.at(-1).close`
  is *above* the baseline (`baselineValue`, or `points[0].close` when baseline is null),
  `colors.downBright` when below, and `colors.textDim` when exactly equal — zero carries no
  color (§0.2), so a day that closed flat draws a neutral line, not a claimed gain.
- **Fill:** a vertical `<LinearGradient>` under the line from the line color at opacity 0.10
  to transparent at the bottom edge.
- **Y-domain:** `[min, max]` of closes, each padded by 4% of the span (span 0 → pad by 1% of
  the value). Include `baselineValue` in the domain **only if** it lies within
  `[min − 0.5·span, max + 0.5·span]`; otherwise draw no reference line (a huge gap must not
  squash the day's shape).
- **Reference line:** when baseline is in-domain, a dotted 1px `<Line>` across the full width
  at the baseline's y, `stroke colors.borderStrong`, `strokeDasharray "1,4"`.
- **Scrub:** a `Gesture.Pan` (react-native-gesture-handler, already a dep) with
  `activeOffsetX [-5, 5]` so vertical scrolls win. While active: nearest point by x; draw a 1px
  vertical hairline `colors.iris` through it, a 5px-radius dot in the line color at the
  point, and call `onScrub(point)` (throttle to one call per frame via the gesture callback —
  no timers). On end/cancel call `onScrub(null)`. The chart never renders its own price text;
  the *header* owns that (see §6.3).
- **Loading:** the spinner replaces the chart only when there is nothing to draw
  (`points.length < 2`). When `loading` is true and points exist (a timeframe refetch), keep
  the previous line rendered at opacity 0.3 with a small `ActivityIndicator` overlaid — never
  a flashing hole where a chart just was.
- Empty (`points.length < 2`, not loading): render the box at `height` with a centered
  `type.caption` "No chart data".

#### `TimeframePills.tsx` (Agent 1)

```ts
export type Timeframe = '1D' | '1W' | '1M' | '3M' | '1Y' | 'ALL'
export function TimeframePills({
  selected, onChange, options = ['1D','1W','1M','3M','1Y','ALL'],
}: { selected: Timeframe; onChange: (t: Timeframe) => void; options?: Timeframe[] })
```
A centered `flexDirection: 'row'` with `space.sm` gaps. Each pill: `paddingHorizontal 14`,
`paddingVertical 6`, `radius.pill`. Active: fill `colors.accentDim`, label `colors.accent`
`fonts.semibold` 13. Inactive: transparent fill, label `colors.textDim` `fonts.semibold` 13.
Also exported: nothing else — the timeframe→API mapping lives in `lib/market/timeframes.ts`.

#### `SectionTabs.tsx` (Agent 1)

The section-tab strip for the detail screen (Info / News / Calendar / Options). One selection
idiom app-wide: the accentDim-wash pill — the same language as `TimeframePills` and the active
`Chip` — not an underline, which would put a third competing "selected" look on one scroll.

```ts
export function SectionTabs({
  tabs, selected, onChange,
}: { tabs: string[]; selected: number; onChange: (i: number) => void })
```
Row of pill Pressables, evenly spaced (`flex: 1`, centered) for ≤ 4 tabs, each `paddingVertical
8`, `radius.pill`. Label `fonts.semibold` 15: active pill fill `colors.accentDim`, label
`colors.accent`; inactive transparent fill, label `colors.textDim`. The whole strip has a
hairline bottom border `colors.border`.

#### `SearchField.tsx` (Agent 1)

```ts
export function SearchField({
  value, onChangeText, placeholder = 'Search',
  autoFocus = false, onClear,
}: { value: string; onChangeText: (s: string) => void; placeholder?: string; autoFocus?: boolean; onClear?: () => void })
```
A `radius.pill` bar, fill `colors.surface`, `shadow.soft`, height 44, `paddingHorizontal 16`:
Ionicons `search` 18 `colors.textDim`, a `TextInput` (`type.body`, `colors.text`, placeholder
`colors.textFaint`, `autoCapitalize="characters"`, `autoCorrect={false}`,
`returnKeyType="search"`), and when `value` is non-empty a `close-circle` 18 `colors.textDim`
Pressable calling `onClear`.

#### `TickerRow.tsx` (Agent 4)

One watchlist row (also reused by search results without the sparkline).

```ts
export function TickerRow({
  symbol, name,          // strings; name may be ''
  price,                 // number | undefined — undefined renders '—' (a fetch settled without it)
  delta, pct,            // as DeltaText
  spark,                 // number[] | undefined — undefined leaves the fixed 64×28 slot EMPTY
                         // (reserved, never collapsed — no layout shift when data lands)
  loading = false,       // quote request in flight: price, delta and spark render surfaceAlt
                         // skeleton blocks (radius.sm) at the slots' fixed sizes instead of '—'
  onPress,               // required
  last = false,          // suppresses the hairline bottom border
}: {...})
```
Layout (row, `paddingVertical 12`, `paddingHorizontal 16`, hairline bottom unless `last`):
left block — symbol `type.headingSm` + name `type.caption` `numberOfLines={1}` under it; middle
— a fixed 64×28 slot holding the `Sparkline`, stroked `upBright/downBright/textDim` by delta
sign (graphics duty → the Bright pair); right block (right-aligned) — price `fonts.semibold` 17
`colors.text` `tabular`, and `DeltaText size="sm"` under it. Loading and missing are distinct:
skeleton blocks while `loading`, '—' only after a fetch settled without the value.
Press feedback: `opacity 0.7`.

#### `StatRow.tsx` (Agent 5)

```ts
export function StatRow({ label, value, tone = 'neutral', last = false }:
  { label: string; value: string; tone?: 'neutral'|'up'|'down'; last?: boolean })
export function StatGrid({ children }: { children: ReactNode })
```
`StatRow`: label `type.caption` left, value `fonts.medium` 14 `colors.text` + `tabular` right,
`paddingVertical 10`, hairline bottom unless `last`. Distinct from `InfoRow` deliberately:
no horizontal padding (it sits inside a padded Card) and a tighter vertical rhythm.
`StatGrid`: two-column wrapper — `flexDirection: 'row'`, two `flex: 1` columns with a
`space.xl` gap; the *screen* passes two explicit row arrays — the fixed left/right assignment
in §6.4 governs (there is no even/odd-index rule).

#### `NewsCard.tsx` (Agent 6)

```ts
export function NewsCard({ item, onPress, last = false }:
  { item: NewsItem; onPress: () => void; last?: boolean })
```
Row, `paddingVertical 12`, hairline bottom unless `last`. Left (flex 1): publisher + ' · ' +
`relativeTime(item.publishedAt)` as `type.caption`, then title `fonts.semibold` 15
`colors.text` `numberOfLines={3}`, `lineHeight 20`. Right: when `item.thumbnail` is set, an
`Image` 56×56, `borderRadius: radius.md`, `marginLeft: space.lg`, `resizeMode: 'cover'`;
absent thumbnail collapses the slot (no placeholder box). Press: `opacity 0.7`.

#### `EventRow.tsx` (Agent 6)

```ts
export function EventRow({ icon, title, subtitle, value, tone = 'neutral', last = false }:
  { icon: ComponentProps<typeof Ionicons>['name']; title: string; subtitle?: string;
    value: string; tone?: 'neutral'|'up'|'down'; last?: boolean })
```
Row, hairline bottom unless `last`, `paddingVertical 12`: a 36×36 `radius.md` square filled
`colors.iconWell` with the Ionicon 18 `colors.accent`; then title `fonts.semibold` 15 +
optional subtitle `type.caption`; right-aligned value `fonts.medium` 14 `tabular`, colored by
tone (`text`/`up`/`down`).

#### `OptionChainRow.tsx` (Agent 6)

```ts
export function OptionChainRow({ contract, last = false }:
  { contract: OptionContract; last?: boolean })
export function OptionChainHeader() // the column captions row — the first row of the chain card
                                    // (nothing is sticky; §6.3's one-ScrollView shell)
```
Four columns — there is deliberately **no Last column**: at 390pt it starves Bid/Ask below what
a real ITM quote needs, and Robinhood's chain shows none either. Flex ratios `[1, 1.7, 1.2,
0.8]`, gap `space.sm`, `paddingVertical 10`, `paddingHorizontal 16`, hairline bottom unless
`last`:
1. **Strike** — `fonts.semibold` 14 `colors.text`
2. **Bid / Ask** — `fonts.medium` 13, rendered `"1.20 / 1.25"`; a missing side renders `—`
3. **Vol · OI** — two stacked `type.caption` lines, `formatCompact`
4. **IV** — `fonts.medium` 13, `formatIv(contract.impliedVolatility)` (fractional in, e.g.
   0.34 → `34%`), `—` when absent
Every cell — header captions included — is `numberOfLines={1}`, so an overlong value ellipsizes
instead of wrapping and shearing the row. All numerals `tabular`, columns 2–4 right-aligned.
**ITM shading:** when `contract.inTheMoney`, the row background is `colors.itm` (a Cloud Veil
wash — ITM is a *state*, so it takes neither the direction pair nor the accent).
`OptionChainHeader` renders the four captions ("Strike", "Bid / Ask", "Vol · OI", "IV") in
`type.label` with the same flex ratios and a `borderStrong` bottom hairline.

#### `OptionsSummary.tsx` (Agent 6)

```ts
export function OptionsSummary({ analysis }: { analysis: OptionsAnalysis }) // from lib/market/analysis
```
A `Card floating` containing three `StatRow`-like lines (it may not import Agent 5's StatRow —
it renders its own rows with the same visual spec to keep file ownership disjoint):
"Put/Call ratio (OI)" → `formatRatio` (2dp, tone: `down` when > 1, `up` when < 0.7, neutral
between); "Max pain" → strike as price, neutral; "Implied volatility" → `"calls 32% · puts 35%"`
neutral. A `null` field renders `—`.

---

## 3. Route map — the Tabs restructure

New file tree under `app/src/app/` (URL in parentheses; expo-router groups add no segment):

```
_layout.tsx                  root Stack (font loading per §1.1; DeviceProvider kept app-wide)
index.tsx                    ('/')            entry splash → replace to /board or /onboarding/turn-on
(tabs)/_layout.tsx           Tabs navigator
(tabs)/board.tsx             ('/board')       ← moved from dashboard.tsx (git mv), retheme + drop its gear-to-settings nav (settings is a tab now)
(tabs)/markets.tsx           ('/markets')     NEW — §6.1
(tabs)/settings.tsx          ('/settings')    ← moved from settings.tsx (git mv), retheme
preview.tsx                  ('/preview')     stays a root-level push (full-screen over the tab bar)
market/[symbol].tsx          ('/market/AAPL') NEW — detail, root-level push over the tab bar — §6.3
add-ticker.tsx               ('/add-ticker')  NEW — search modal — §6.2. Deliberately NOT market/add:
                             "ADD" is a real listed ticker, and /market/ADD must reach the detail
                             screen rather than depend on expo-router's static-segment case rules.
onboarding/_layout.tsx       unchanged structure (stack outside the tabs)
onboarding/turn-on.tsx       retheme only
onboarding/wifi-list.tsx     retheme only
onboarding/password.tsx      retheme only
onboarding/news.tsx          retheme only
onboarding/complete.tsx      retheme + route target update
```

Root `_layout.tsx` Stack screens: `(tabs)` (headerShown false), `onboarding`, `preview`,
`market/[symbol]`, and `add-ticker` with `options={{ presentation: 'modal' }}`. All
`headerShown: false` (screens own their chrome, as today). `contentStyle` backgroundColor
becomes `colors.bg`.

`(tabs)/_layout.tsx`:

```tsx
<Tabs screenOptions={{
  headerShown: false,
  tabBarActiveTintColor: colors.accent,
  tabBarInactiveTintColor: colors.textDim,
  tabBarStyle: { backgroundColor: colors.surface, borderTopColor: colors.border },
  tabBarLabelStyle: { fontFamily: fonts.semibold, fontSize: 11 },
}}>
  <Tabs.Screen name="board"    options={{ title: 'Board',    tabBarIcon: newspaper-outline }} />
  <Tabs.Screen name="markets"  options={{ title: 'Markets',  tabBarIcon: trending-up }} />
  <Tabs.Screen name="settings" options={{ title: 'Settings', tabBarIcon: settings-outline }} />
</Tabs>
```
(Icons via `Ionicons`, size from the tabBarIcon callback, filled variants — `newspaper`,
`trending-up`, `settings` — when focused.)

**Route-string migration (Agent 3 greps and fixes every one):** every `'/dashboard'` becomes
`'/board'` (`index.tsx` target type, `onboarding/complete.tsx`, any `router.replace` in
`dashboard.tsx` itself, and `lib`/test fixtures if any reference it). `'/settings'` and
`'/preview'` strings keep working unchanged. The Board screen's link to settings (if retained
anywhere) uses `router.push('/settings')`, which now lands on the tab.

**Onboarding routing:** unchanged flow; on completion it now `router.replace('/board')`. The
entry splash keeps its logic (env override, `isOnboardingComplete()`), only the target renames.

**Deep links:** the scheme is already `claudepost` (app.json). `claudepost://market/AAPL` opens
the detail screen; `claudepost://markets` the tab. No extra config needed beyond the routes
existing. Symbol param is uppercased on read (`useLocalSearchParams` → `String(symbol).toUpperCase()`).

**app.json** (Agent 3): `"userInterfaceStyle": "light"`.

---

## 4. Data layer — `app/src/lib/market/`

Eight modules, all owned by Agent 2, all pure/injectable, all tested. Nothing in `lib/market`
imports React or anything from `components/`.

```
app/src/lib/market/
  types.ts        every exported TS type + defensive coercers
  crumb.ts        the cookie+crumb bootstrap
  cache.ts        tiny TTL cache with in-flight dedupe
  timeframes.ts   Timeframe → {range, interval} table
  yahoo.ts        createYahooClient() — the only file that knows a Yahoo field name
  watchlist.ts    AsyncStorage watchlist store
  format.ts       market display formatters
  analysis.ts     putCallRatio / maxPain / ivSummary — pure functions
```

### 4.1 `types.ts`

```ts
export interface Quote {
  symbol: string
  name: string            // meta shortName/longName, '' when absent
  currency: string        // ISO code, e.g. 'USD'; '' when absent
  exchange: string        // meta fullExchangeName ?? exchangeName ?? '' ("NASDAQ", not the "NMS" short code)
  price: number           // regularMarketPrice
  prevClose: number       // chartPreviousClose ?? previousClose; NaN when absent
  delta: number           // price - prevClose (0 when prevClose is NaN)
  pct: number             // percent-scaled change: 0.16 means +0.16% (NOT a 0–1 fraction); 0 when prevClose NaN/0
  marketTime: number      // epoch seconds of regularMarketTime, 0 when absent
  spark: number[]         // day's closes (nulls dropped) for the row sparkline
}
export interface ChartPoint { t: number; close: number } // epoch seconds, price
export interface ChartData {
  symbol: string
  points: ChartPoint[]    // null closes dropped; always time-ascending
  prevClose: number | null // meta chartPreviousClose (1D baseline); null when absent
  currency: string
}
export interface SearchResult { symbol: string; name: string; exchange: string; type: string } // type: 'EQUITY' | 'ETF' | ...
export interface NewsItem {
  id: string; title: string; publisher: string
  publishedAt: number     // epoch seconds
  url: string
  thumbnail: string | null // smallest resolution >= 140px wide, else largest available, else null
}
export interface KeyStats {
  open: number | null; dayHigh: number | null; dayLow: number | null
  volume: number | null; avgVolume: number | null
  wk52High: number | null; wk52Low: number | null
  marketCap: number | null; trailingPE: number | null; trailingEps: number | null
  dividendYield: number | null // fractional, e.g. 0.0044
  beta: number | null
}
export interface ProfileInfo {
  sector: string; industry: string
  employees: number | null; website: string; summary: string
} // no name field — the display name lives on Quote, and the screen header already shows it
export interface EarningsRow { quarter: string; epsActual: number | null; epsEstimate: number | null } // quarter is the human label ('Q2 2025', §4.5) — never Yahoo's machine token ('-1q')
export interface CalendarEvents {
  earningsDates: number[]        // epoch seconds, soonest first (Yahoo gives a 1–2 date window)
  exDividendDate: number | null  // epoch seconds
  dividendDate: number | null    // payment date
  history: EarningsRow[]         // most recent first, max 4
}
export interface OptionContract {
  strike: number; lastPrice: number | null; bid: number | null; ask: number | null
  volume: number | null; openInterest: number | null
  impliedVolatility: number | null // fractional, e.g. 0.34
  inTheMoney: boolean
}
export interface OptionChain {
  symbol: string; spot: number | null
  expirationDates: number[]      // epoch seconds, ascending
  expiration: number             // the expiry this chain is for
  calls: OptionContract[]        // strike-ascending
  puts: OptionContract[]
}

export type MarketErrorCode = 'transport' | 'http' | 'rate_limited' | 'crumb' | 'parse' | 'not_found'
export class MarketError extends Error { constructor(public code: MarketErrorCode, message: string) { super(message) } }
export function marketHumanError(e: unknown): string
```

`marketHumanError` sentences (exact): `transport` → "Couldn't reach Yahoo Finance. Check your
connection."; `http` → "Yahoo Finance answered with an error. Try again in a moment.";
`rate_limited` → "Yahoo is rate-limiting requests. Try again in a minute."; `crumb` → "Yahoo is
limiting detailed data right now. Prices and news still work."; `parse` → "Yahoo answered with
something this app doesn't understand."; `not_found` → "No data for that symbol."; anything
else → "Something went wrong talking to Yahoo Finance."

Coercers (exported for tests): `num(v): number | null` unwraps Yahoo's two number shapes — a
plain finite number passes, `{ raw: n }` unwraps to a finite `n`, everything else (including
`{}` and strings) → `null`. `str(v): string` → `typeof v === 'string' ? v : ''`. Every field
above is produced through these; a malformed payload yields nulls/''/[] — never a throw from
deep inside a mapper (a *missing top-level result* is a `MarketError('parse', …)`).

### 4.2 `crumb.ts` — the cookie+crumb bootstrap

Yahoo gates `/v10/finance/quoteSummary` and `/v7/finance/options` behind a session cookie + a
crumb token. RN's `fetch` uses the native HTTP stack whose cookie jar persists automatically
(NSHTTPCookieStorage / OkHttp CookieJar), so the flow is exactly:

1. `GET https://fc.yahoo.com/` — response body irrelevant (it 404s); its `Set-Cookie` seeds the jar.
2. `GET https://query1.finance.yahoo.com/v1/test/getcrumb` — body is the crumb, plain text.
3. Crumb-gated calls append `&crumb=<encodeURIComponent(crumb)>`; the cookie rides automatically.

**Both bootstrap requests send the same browser headers as every data request** — the
User-Agent/Accept pair lives as the exported constant `YAHOO_BROWSER_HEADERS` in this module,
and `yahoo.ts` imports it (§4.5). Yahoo blocks the default okhttp UA, so a bootstrap that
omits the headers fails on Android every time. One expected-outcome caveat: from EU IPs,
`fc.yahoo.com` serves a consent redirect and may set no cookies at all — a failed bootstrap
there is a *normal outcome* that lands in §0.4's degraded state, not an error to fix.

```ts
export interface CrumbStore { get(): Promise<string | null>; set(c: string, at: number): Promise<void>; clear(): Promise<void> }
export function createCrumbProvider(opts: {
  fetchFn?: typeof fetch; now?: () => number; store?: CrumbStore // default: AsyncStorage-backed
}): {
  getCrumb(): Promise<string>        // cached → stored (if < CRUMB_TTL_MS old) → bootstrap
  invalidate(): Promise<void>        // drops memory + storage
}
export const CRUMB_TTL_MS = 12 * 3600_000
export const YAHOO_BROWSER_HEADERS: Record<string, string> // the §4.5 UA/Accept pair — sent by both bootstrap requests, imported by yahoo.ts
```

Validity check on step 2's body: non-empty, length ≤ 64, contains no `<` and no `"` (an HTML
error page or a JSON-quoted blob is a failed bootstrap). Failure of any step throws
`MarketError('crumb', …)`. The default store persists `{ crumb, at }` as JSON under the
AsyncStorage key **`claudepost.yahooCrumb`**, best-effort try/catch like `store.ts`.
Retry contract (enforced in `yahoo.ts`): a crumb-gated request answering 401/403 invalidates
the crumb, re-bootstraps **once**, retries **once**; a second failure surfaces
`MarketError('crumb', …)`.

### 4.3 `cache.ts`

```ts
export function createTtlCache(now: () => number = Date.now): {
  through<T>(key: string, ttlMs: number, fn: () => Promise<T>, opts?: { bypass?: boolean }): Promise<T>
  // fresh hit → cached value; miss/stale → fn(); concurrent same-key callers share one in-flight
  // promise; on fn() rejection: if a stale value exists return it (stale-on-error), else rethrow.
  // bypass: skip the fresh-hit read (a user's explicit refresh must actually fetch) but still
  // dedupe in-flight callers, store the result, and keep stale-on-error.
  clear(): void
}
```

### 4.4 `timeframes.ts`

```ts
export type Timeframe = '1D' | '1W' | '1M' | '3M' | '1Y' | 'ALL'
export const TIMEFRAMES: readonly Timeframe[] = ['1D','1W','1M','3M','1Y','ALL']
export const TIMEFRAME_PARAMS: Record<Timeframe, { range: string; interval: string }> = {
  '1D':  { range: '1d',  interval: '5m'  },
  '1W':  { range: '5d',  interval: '30m' },
  '1M':  { range: '1mo', interval: '1d'  },
  '3M':  { range: '3mo', interval: '1d'  },
  '1Y':  { range: '1y',  interval: '1wk' },
  'ALL': { range: 'max', interval: '1mo' },
}
/** Chart line color baseline: prevClose on 1D (the Robinhood rule), first close otherwise. */
export function baselineFor(tf: Timeframe, chart: ChartData): number | null
```
`baselineFor`: `'1D'` → `chart.prevClose`; otherwise `chart.points[0]?.close ?? null`.

(`TimeframePills` in §2.2 imports the `Timeframe` type from here — Agent 1 may declare the
string-union locally to avoid a cross-agent import race, but the canonical type is this one and
they must be textually identical.)

### 4.5 `yahoo.ts` — the client

```ts
export interface YahooClientOptions {
  fetchFn?: typeof fetch
  now?: () => number
  crumb?: ReturnType<typeof createCrumbProvider>  // injectable for tests
  cache?: ReturnType<typeof createTtlCache>
}
export function createYahooClient(opts: YahooClientOptions = {}): {
  quote(symbol: string, opts?: { fresh?: boolean }): Promise<Quote>
  chart(symbol: string, tf: Timeframe, opts?: { fresh?: boolean }): Promise<ChartData>
  search(query: string): Promise<SearchResult[]>                        // not cached — no opts
  news(symbol: string, opts?: { fresh?: boolean }): Promise<NewsItem[]>
  keyStatsAndProfile(symbol: string, opts?: { fresh?: boolean }): Promise<{ stats: KeyStats; profile: ProfileInfo }>   // crumb-gated
  calendar(symbol: string, opts?: { fresh?: boolean }): Promise<CalendarEvents>                                        // crumb-gated
  options(symbol: string, expiration?: number, opts?: { fresh?: boolean }): Promise<OptionChain>                       // crumb-gated
}
export type YahooClient = ReturnType<typeof createYahooClient>
export const yahoo: YahooClient = createYahooClient()   // the app-wide singleton, like `esp32`
```

**Hosts & headers.** Base `https://query1.finance.yahoo.com`. Every request sends
`YAHOO_BROWSER_HEADERS` (the constant exported from `crumb.ts`, §4.2 — one definition covers
the bootstrap and every data call):
`{ 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36', Accept: 'application/json' }`
— Yahoo blocks the default okhttp UA. 10-second timeout via `AbortController` (pattern as in
`esp32.ts`). Status → error mapping: network throw/abort → `transport`; 429 → `rate_limited`;
401/403 on crumb-gated endpoints → the §4.2 retry contract then `crumb`; 404 or an empty
`result` array → `not_found`; other non-2xx → `http`; JSON parse failure or missing envelope →
`parse`.

**Endpoints (exact):**
- `quote(s)` / `chart(s, '1D')` share one request:
  `GET /v8/finance/chart/{SYMBOL}?range={range}&interval={interval}&includePrePost=false`.
  Unauthenticated. The shared cache entry (`chart:SYM:1D`) stores a **parsed envelope, not raw
  JSON**: `{ quote: Quote; chart: ChartData }`, built by one mapper — `quote()` returns
  `.quote` and `chart(s, '1D')` returns `.chart`, so whichever caller populates the key, the
  other reads a defined shape. The `Quote` comes from the 1D chart response's
  `chart.result[0].meta` (`regularMarketPrice`, `chartPreviousClose` falling back to
  `previousClose`, `currency`, `fullExchangeName ?? exchangeName ?? ''` as `exchange`,
  `shortName ?? longName ?? ''`, `regularMarketTime`) plus
  `indicators.quote[0].close` (nulls dropped) as `spark`. One fetch powers row price, delta
  *and* sparkline.
- `search(q)`: `GET /v1/finance/search?q={q}&quotesCount=8&newsCount=0` → `quotes[]` filtered
  to entries with a `symbol`, mapped `{ symbol, name: shortname ?? longname ?? '', exchange:
  exchDisp ?? exchange ?? '', type: quoteType ?? '' }`. Unauthenticated. Not cached.
- `news(s)`: `GET /v1/finance/search?q={s}&quotesCount=0&newsCount=12` → `news[]` mapped
  `{ id: uuid, title, publisher, publishedAt: providerPublishTime, url: link, thumbnail }`;
  thumbnail = from `thumbnail.resolutions`, the smallest whose `width >= 140`, else the largest
  present, else null. Items without a `link` are dropped.
- `keyStatsAndProfile(s)`: `GET /v10/finance/quoteSummary/{SYMBOL}?modules=assetProfile,summaryDetail,defaultKeyStatistics&crumb=…`
  → `quoteSummary.result[0]`; `KeyStats` from `summaryDetail` (`open, dayHigh, dayLow, volume,
  averageVolume, fiftyTwoWeekHigh, fiftyTwoWeekLow, marketCap, trailingPE, dividendYield`) +
  `defaultKeyStatistics` (`trailingEps, beta`); `ProfileInfo` from `assetProfile` (`sector,
  industry, fullTimeEmployees, website, longBusinessSummary` — there is no name field; the
  screen renders the quote's display name, §6.4).
  All numerics through `num()` (quoteSummary wraps numbers as `{raw, fmt}`).
- `calendar(s)`: `GET /v10/finance/quoteSummary/{SYMBOL}?modules=calendarEvents,earningsHistory&crumb=…`
  → `earningsDates` from `calendarEvents.earnings.earningsDate[]`, `exDividendDate`,
  `dividendDate`; `history` from `earningsHistory.history[]` mapped `{ quarter, epsActual,
  epsEstimate }`, most-recent-first, max 4. `quarter` is derived from the row's `quarter`
  field, whose `fmt` is the quarter-end date `YYYY-MM-DD`: render `Q{ceil(month/3)} {year}` →
  `'Q2 2025'`; `''` when absent. **Never** map Yahoo's `period` field — it is a machine token
  (`'-1q'`) and must not reach the UI.
- `options(s, exp?)`: without an expiration `GET /v7/finance/options/{SYMBOL}?crumb=…`; with
  one, `GET /v7/finance/options/{SYMBOL}?date={exp}&crumb=…` (both forms written out — `crumb`
  takes the `?` itself when it is the first query param) →
  `optionChain.result[0]`: `expirationDates`, `expiration` = `options[0].expirationDate`,
  `spot` = `quote.regularMarketPrice`, `calls`/`puts` mapped through `num()` with
  `inTheMoney: Boolean(c.inTheMoney)`, sorted strike-ascending.

**Cache TTLs (through `cache.through`, key = `endpoint:symbol:variant`):**

| data | TTL | notes |
|---|---|---|
| `quote` / `chart 1D` | 25 s | one shared envelope entry (`chart:SYM:1D`); TTL sits *below* the 30 s row poll so every poll actually fetches |
| `chart` other tfs | 5 min | per (symbol, tf) |
| `search` | not cached | UI debounces 300 ms and drops stale responses |
| `news` | 5 min | |
| `keyStatsAndProfile` | 10 min | |
| `calendar` | 10 min | |
| `options` | 2 min | per (symbol, expiration ?? 'front') |

Stale-on-error comes free from `cache.through`. Every cached method also accepts a trailing
`opts?: { fresh?: boolean }`, mapped to the cache's `bypass` — pull-to-refresh passes
`{ fresh: true }` so the gesture is never a visible no-op inside a TTL window.

### 4.6 `watchlist.ts`

Mirrors `store.ts`'s shape: module-level in-memory cache, best-effort try/catch, a test reset.

```ts
export interface WatchItem { symbol: string; name: string }
export const WATCHLIST_KEY = 'claudepost.watchlist'   // JSON: WatchItem[]
export async function getWatchlist(): Promise<WatchItem[]>          // corrupt/missing → []
export async function addToWatchlist(item: WatchItem): Promise<WatchItem[]>    // uppercase symbol, dedupe by symbol (no-op if present), append to end, persist, return new list
export async function removeFromWatchlist(symbol: string): Promise<WatchItem[]>
export async function isWatched(symbol: string): Promise<boolean>
export function __resetWatchlistCacheForTests(): void
```

Symbols are stored uppercased and trimmed. `getWatchlist` validates each entry (`symbol` a
non-empty string) and drops the rest — a corrupt entry must not take the list down.

### 4.7 `format.ts` (market formatters — distinct from the device's `lib/format.ts`)

```ts
export function formatPrice(n: number | null | undefined): string
// finite: |n| >= 1 → 2dp with thousands commas ('1,042.72'); |n| < 1 → 4dp; else '—'. No currency symbol prefix here; screens prefix via currencySymbol(quote.currency) — never a literal '$'.
export function formatDelta(n: number | null | undefined): string        // unsigned magnitude, 2dp ('14.75'); '—' when not finite
export function formatPct(f: number | null | undefined): string          // takes the number ALREADY SCALED to percent — formatPct(0.16) === '0.16%' (2dp, unsigned, NO ×100 inside; <0.0001 → '0.00%'); '—' when not finite
export function formatCompact(n: number | null | undefined): string      // 999 → '999', 1234 → '1.2K', 3.4e6 → '3.4M', 1.2e9 → '1.2B', 2.3e12 → '2.3T'; 1dp, trailing '.0' kept off ('12K' not '12.0K'); a 1dp rounding that crosses a unit boundary promotes (999.96e9 → '1T', never '1000B'); '—' when not finite
export function formatIv(f: number | null | undefined): string           // 0.345 → '35%' (0dp); '—' when not finite
export function formatRatio(n: number | null | undefined): string        // 2dp; '—'
export function relativeTime(epochSec: number, nowMs?: number): string   // <60s 'now'; <1h '{m}m ago'; <24h '{h}h ago'; <7d '{d}d ago'; else formatDateShort(epochSec, nowMs) — the same nowMs threads through, so no branch reads the real clock
export function formatDateShort(epochSec: number, nowMs?: number): string // 'Sep 4' (same year as nowMs, default Date.now()) / 'Sep 4, 2025' (other years); UTC-based like formatGeneratedAt to avoid TZ drift; nowMs is injectable so tests never depend on the real date
export function formatTime(epochSec: number): string                     // 'HH:MM' 24h in DEVICE-LOCAL time — a 1D scrub label must read as the user's clock; UTC is for date-granularity labels only
export function currencySymbol(code: string): string                     // 'USD'→'$', 'EUR'→'€', 'GBP'→'£', 'JPY'→'¥', ''→''; anything else → the ISO code plus a space ('SEK ', 'GBp '). Every return is consumed as a PREFIX, so 'GBp' takes the fallback — pence is suffix notation and a prefixed 'p245.30' reads as garbage
export function arrow(delta: number | null | undefined): '▲' | '▼' | ''  // 0/null/NaN → ''
```

### 4.8 `analysis.ts` — options analytics (pure, exact algorithms)

```ts
export interface OptionsAnalysis {
  putCallRatioOi: number | null
  putCallRatioVolume: number | null
  maxPain: number | null
  callIv: number | null; putIv: number | null; overallIv: number | null
}
export function putCallRatio(chain: OptionChain): { oi: number | null; volume: number | null }
export function maxPain(chain: OptionChain): number | null
export function ivSummary(chain: OptionChain): { callIv: number | null; putIv: number | null; overallIv: number | null }
export function analyzeChain(chain: OptionChain): OptionsAnalysis   // composes the three
```

- **putCallRatio:** `oi = Σ put.openInterest / Σ call.openInterest` over the chain's single
  expiry, treating null OI as 0; `null` when the call total is 0. `volume` identically over
  `volume`.
- **maxPain (define precisely):** Let `K` be the sorted set of distinct strikes appearing in
  `calls ∪ puts`. For each candidate settlement price `S ∈ K`, the writers' total payout is
  `pain(S) = Σ_calls OIc·max(0, S − Kc) + Σ_puts OIp·max(0, Kp − S)` (null OI = 0; lastPrice,
  bid, ask, volume and IV play no part). **Max pain is the `S` minimizing `pain(S)`; on a tie,
  the lowest such strike.** Return `null` when `K` is empty or every OI is 0 (a pain function
  that is identically zero names no strike).
- **ivSummary:** near-the-money only — contracts with finite `impliedVolatility > 0.001` (a bare
  `> 0` lets through Yahoo's ~1e-05 no-quote placeholder IV, which drags the unweighted means
  toward zero; no real IV sits below 0.1%) and, when
  `chain.spot` is a finite positive number, `|strike − spot| / spot ≤ 0.10`; when `spot` is
  null, all contracts with valid IV qualify. `callIv` / `putIv` = unweighted arithmetic means
  of the qualifying calls / puts (`null` when none qualify); `overallIv` = unweighted mean over
  the union (`null` when both empty). Unweighted deliberately — deterministic and testable.

### 4.9 Tests (Agent 2, `*.test.ts` beside each module)

Injectable-fetch pattern per `esp32.test.ts`: a `fakeFetch` returning canned `Response`-shaped
objects; no network, no timers left running. Minimum coverage:
- `yahoo.test.ts`: quote/chart/search/news mapping from realistic fixture JSON (including
  `{raw,fmt}` unwrapping and null closes dropped); status→code mapping (429, 404, network
  throw); the crumb 401→invalidate→retry-once→`crumb` sequence (assert fc.yahoo.com +
  getcrumb called in order, and only one retry).
- `crumb.test.ts`: bootstrap order, TTL expiry via injected `now`, HTML-body rejection,
  store round-trip, and both bootstrap requests carrying `YAHOO_BROWSER_HEADERS`.
- `cache.test.ts`: fresh hit, TTL expiry, in-flight dedupe (two callers, one `fn` call),
  stale-on-error, and `bypass` (skips the fresh hit, still dedupes and stores).
- `timeframes.test.ts`: the table is exactly §4.4's; `baselineFor` both branches.
- `watchlist.test.ts`: add/dedupe/remove/corrupt-JSON→[], uppercasing.
- `format.test.ts`: every branch listed in §4.7 including the '—' cases and zero-sign rules;
  `formatDateShort`'s same-year/other-year branches via injected `nowMs` (never the real
  clock); `formatTime` asserted against an expected string built with the same local-time
  `Date` APIs, so the test passes in any timezone; `currencySymbol`'s listed codes and the
  ISO-code fallback.
- `analysis.test.ts`: maxPain on a hand-computed 3-strike fixture (assert the arithmetic, the
  tie→lowest rule, and the all-zero-OI→null rule); putCallRatio zero-denominator; ivSummary
  moneyness filter with and without spot.

---

## 5. Package additions (Agent 1 runs these; one commit with the lockfile)

```bash
cd app
npx expo install react-native-svg expo-font @expo-google-fonts/inter
```

- `react-native-svg` is the one **new native dependency** → **a new EAS dev build is required**
  (`eas build --profile development`) before the dev client can load any of this work; the
  JS-only pieces still typecheck/test without it. Flag this in the PR description.
- `expo-font` is already in package.json; the install pins the SDK-56-compatible version.
- Jest's `transformIgnorePatterns` already whitelists `react-native-svg` and
  `@expo-google-fonts/.*` — no jest config change.
- `app.json` already lists the `expo-font` plugin. No plugin changes needed.

---

## 6. Screen-by-screen specs

Common rules: every screen renders inside `Screen`; scrollables use `ScrollView`/`FlatList`
with `contentContainerStyle` padding `layout.gutter`; pull-to-refresh via `RefreshControl`
(`tintColor colors.accent`) — a refresh pass calls the data layer with `{ fresh: true }`
(§4.5) so the gesture bypasses the TTL instead of visibly doing nothing. "Focused polling" means: start on `useFocusEffect`, clear on blur,
exactly like `board`'s existing 5s device poll.

### 6.1 Markets tab — `(tabs)/markets.tsx` (Agent 4)

`Screen aurora`. Top to bottom:
1. **Header row** (padding `layout.gutter`, top `space.sm`): "Markets" in `type.headingLg`;
   right-aligned a 36px circle Pressable (fill `colors.surface`, hairline `colors.border`,
   `shadow.soft`, Ionicons `add` 22 `colors.accent`) → `router.push('/add-ticker')`.
2. **Watchlist card**: one `Card` (default, non-floating, `padding: 0` via style override so
   rows bleed to the card edge) containing a `TickerRow` per watch item (order = stored order,
   `last` on the final row). Row press → `router.push(\`/market/${symbol}\`)`. Each row wrapped
   in the legacy RNGH `Swipeable` — exactly `import Swipeable from
   'react-native-gesture-handler/Swipeable'`: the newer `ReanimatedSwipeable` requires
   `react-native-reanimated`, which is not a dependency and §0.7 forbids adding one, so the
   deprecation warning the legacy import logs is accepted — whose right action is a
   `colors.down`-filled panel labeled "Remove" (`colors.white`, `fonts.semibold` 15; a
   destructive action is a named legal use of red, §0.1); triggering it calls
   `removeFromWatchlist` and collapses the row (no confirm — the add screen makes re-adding
   one tap).
3. **Data flow**: on focus, load `getWatchlist()`, then `yahoo.quote(symbol)` for each item
   **in parallel** (`Promise.allSettled`); re-poll every 30 s while focused (the 25 s quote
   TTL guarantees each poll actually fetches); pull-to-refresh runs the same pass with
   `{ fresh: true }` so the gesture always hits the network. A rejected quote leaves that row
   rendering the stored name with '—' price and an empty sparkline slot (per-row degradation;
   no global error while at least one row has data). If *every* quote rejects and none has
   cached data, show a slim inline error banner above the card (`colors.warnBg` fill,
   `radius.md`, `marketHumanError` text in `colors.warn`, 13px — a transport failure is not a
   market direction, §0.1) — the list itself stays.
4. **Empty state** (no watch items): centered block — `IconBadge name="trending-up"`, title
   "Track your first ticker" `type.heading`, body "Search any symbol and it'll show up here
   with a live price and chart." `type.body` in `colors.textDim` (max width 280, centered),
   then `Button variant="primary" label="Add a ticker"` → `/add-ticker`.
5. **Loading** (first load, watchlist non-empty, no quotes yet): render the rows immediately
   from stored `{symbol, name}` with `loading` skeleton blocks in the price/delta/spark slots
   (§2.2 TickerRow) — never a full-screen spinner over a list we can partially draw. '—'
   appears only after a row's fetch settles without data.

### 6.2 Add ticker — `add-ticker.tsx`, modal (Agent 4)

`Screen` (no aurora — a work surface). Top to bottom:
1. **Header row**: `SearchField` (autoFocus, placeholder "Symbol or company", value bound)
   flex-1, then a ghost "Cancel" Pressable (`colors.accent`, `fonts.semibold` 15) →
   `router.back()`.
2. **Results**: a `FlatList` of result rows inside a `Card` (padding 0), keyboard stays up
   (`keyboardShouldPersistTaps="handled"`). Each row: left — symbol `type.headingSm` + name
   `type.caption` (1 line); middle-right — the exchange as a plain `colors.textDim`
   13px `Text` (no `Chip` component, no chip chrome); far right — a 32px circle Pressable: not watched →
   hairline circle, Ionicons `add` 18 `colors.accent`; watched → fill `colors.accentDim`,
   Ionicons `checkmark` 18 `colors.accent`. Tapping toggles `addToWatchlist({symbol, name})` /
   `removeFromWatchlist(symbol)` optimistically. Tapping the row body itself pushes
   `/market/[symbol]` (peek before you add).
3. **Search behavior**: debounce 300 ms after the last keystroke; issue `yahoo.search(q)`;
   responses arriving for a query that is no longer the current input are dropped (track a
   request seq). Empty input → the idle state. Trim; queries shorter than 1 char never fire.
4. **States**: idle → centered `type.caption` "Search Yahoo Finance for any listed symbol.";
   searching → small `ActivityIndicator` under the field; no matches → `ScreenMessage
   message="No matches."`; error → `ScreenMessage error={marketHumanError(e)} onRetry` (retry
   re-fires the current query).

### 6.3 Symbol detail — `market/[symbol].tsx` shell (Agent 5)

**Composition decision (settles pages 3–7):** one root-level screen, one `ScrollView`. From
top: back chrome → header (price hero) → PriceChart → TimeframePills → `SectionTabs` with
**Info · News · Calendar · Options** → the active section's content, in the same scroll (the
chart scrolls away, as on Robinhood; nothing is sticky). Each section is a component from
`components/detail/` receiving the same props contract:

```ts
export interface DetailSectionProps { symbol: string; active: boolean }
```

Sections own their own data fetching via the `yahoo` singleton, fetch **lazily on first
activation** (`active` true), keep their state when the user tabs away, and render their own
loading/error/degraded states inline (a section never unmounts the shell). Exported names
(load-bearing for parallel work): `InfoSection`, `NewsSection`, `CalendarSection`,
`OptionsSection`, each the sole export of its file.

Shell layout, top to bottom (`Screen aurora`):
1. **Top bar** (height 56, padding `layout.gutter`): `BackButton onPress={router.back}`.
2. **Header** (padding `layout.gutter`): symbol `type.label` (e.g. "AAPL · NASDAQ" — the
   suffix is `quote.exchange` (§4.1) when non-empty, else just the symbol), name
   `type.headingSm` `colors.textDim` one line, then the **price** in `type.display` +
   `tabular`, prefixed `currencySymbol(quote.currency)` (§4.7 — never a hardcoded '$'), then
   `DeltaText size="lg"` with `currency={currencySymbol(quote.currency)}` and `suffix` =
   "Today" on 1D, else the timeframe label ("1W", …). While the quote is still in flight the
   price slot renders a `surfaceAlt` skeleton block (~140×40, `radius.sm`), not '—'; '—' is
   for a fetch that settled without data.
   **Scrub behavior:** while `PriceChart` reports a scrubbed point, the price shows that
   point's close and DeltaText shows (point − baseline, pct vs baseline) with suffix =
   `formatTime(point.t)` on 1D, `formatDateShort(point.t)` otherwise; on scrub end it
   snaps back to live. This is why the chart never draws its own price text.
3. **PriceChart** — full-bleed (no horizontal padding), height 220, `points` from
   `yahoo.chart(symbol, tf)`, `baselineValue` from `baselineFor(tf, chart)`.
4. **TimeframePills** — centered, `space.md` above and below. Changing timeframe refetches the
   chart (cache makes flipping back instant); while an uncached timeframe loads, the chart
   keeps the previous line at 0.3 opacity under a small spinner (§2.2 PriceChart's Loading
   rule — never a blank box where a chart just was) and the header keeps the last known quote.
5. **SectionTabs** `['Info','News','Calendar','Options']`.
6. Active section.

Data flow: on mount fetch `yahoo.quote(symbol)` (header) and `yahoo.chart(symbol, '1D')`; while
focused and tf === '1D', re-poll both every 60 s. Quote error with nothing cached → the header
renders symbol + '—' and a slim error banner (as §6.1.3) with retry; the tabs still work.
Title-cased known route param: uppercase the `[symbol]` param once at the top.

### 6.4 Detail — Info section — `components/detail/InfoSection.tsx` (Agent 5)

Fetch `yahoo.keyStatsAndProfile(symbol)` on first activation.
1. **"Stats" label** (`type.label`, `space.lg` above).
2. **Stats card**: `Card` with a `StatGrid`; left column rows: Open, High, Low, Volume, Avg
   vol; right column: 52wk high, 52wk low, Mkt cap, P/E, EPS, then Div yield and Beta appended
   to whichever column is shorter (fixed assignment: Div yield left, Beta right — deterministic,
   not measured). Values: `formatPrice` for prices, `formatCompact` for volumes/mkt cap,
   `formatRatio` for P/E/Beta/EPS, and for div yield `formatPct(dividendYield * 100)` —
   `dividendYield` is a true 0–1 fraction while `formatPct` takes the number already scaled
   to percent (§4.7), so the ×100 happens here, at the call site. Null → '—'. All neutral tone.
3. **"About" label**, then **Profile card**: no name line — `ProfileInfo` carries none (§4.1)
   and the screen header directly above already shows the quote's display name. A row of two
   static Chips (sector, industry — omit when ''); `type.caption` line "12,345 employees" when present;
   summary `type.body` `colors.textDim` clamped to 4 lines with a "Read more" ghost Pressable
   (`colors.accent`, `fonts.semibold` 14) toggling the clamp; website as a tappable
   `colors.accent` caption → `Linking.openURL`.
4. **States**: loading → `ActivityIndicator` centered in a 120px box; `MarketError('crumb')`
   (or any error) → **degraded card**: `Card` with Ionicons `lock-closed-outline` 20 in an
   `iconWell` square, title "Detailed stats unavailable" `fonts.semibold` 15, body
   `marketHumanError(e)` `type.caption`, and a ghost "Try again" (re-runs the fetch, which
   re-bootstraps the crumb per §4.2). Never an empty white void.

### 6.5 Detail — News section — `components/detail/NewsSection.tsx` (Agent 6)

Fetch `yahoo.news(symbol)` on first activation; re-fetch on pull-to-refresh of the parent
scroll is *not* wired (out of scope) — a ghost "Refresh" at the list foot re-fires it.
1. A `Card` (padding 0 override) of `NewsCard`s (`last` on the final).
2. Tap → `Linking.openURL(item.url)` (external browser; no in-app browser dep).
3. States: loading → spinner box; error → degraded card (same shape as §6.4.4, icon
   `newspaper-outline`, title "News unavailable"); empty array → centered `type.caption`
   "No recent headlines for {symbol}."

### 6.6 Detail — Calendar section — `components/detail/CalendarSection.tsx` (Agent 6)

Fetch `yahoo.calendar(symbol)` on first activation (crumb-gated → §6.4.4-style degraded card,
icon `calendar-outline`, title "Calendar unavailable").
1. **"Upcoming" label** + `Card` (padding 0) of `EventRow`s:
   - Earnings: icon `megaphone-outline`, title "Earnings", subtitle "Estimated date" when
     `earningsDates.length > 1` (a window) else undefined, value `formatDateShort(first)`
     (+" – " + second when a window). Omit row when no dates.
   - Ex-dividend: icon `cut-outline`, title "Ex-dividend date", value `formatDateShort`.
   - Dividend payment: icon `cash-outline`, title "Dividend payable", value `formatDateShort`.
   - All three absent → the card is replaced by centered `type.caption` "No scheduled events."
2. **"Past earnings" label** + `Card` (padding 0): one row per `EarningsRow` (max 4): left
   the `quarter` label (`'Q2 2025'` per §4.5 — never a raw Yahoo token) `fonts.semibold` 14;
   right a two-part value — "EPS `formatRatio(actual)` vs
   `formatRatio(estimate)` est" in `fonts.medium` 14 `tabular`, colored `colors.up` when
   `actual > estimate`, `colors.down` when `actual < estimate`, neutral otherwise or when
   either is null (a beat/miss is direction — the green/red rule applies). Empty history →
   omit the whole block including its label.

### 6.7 Detail — Options section — `components/detail/OptionsSection.tsx` (Agent 6)

Fetch `yahoo.options(symbol)` (front expiry) on first activation. Crumb-gated → degraded card
(icon `options-outline` — if unavailable in Ionicons use `layers-outline` — title "Options
unavailable").
1. **Expiry selector**: a horizontal `ScrollView` of `Chip`s, one per `expirationDates` entry,
   label `formatDateShort(exp)`, active = the loaded chain's `expiration`. Tap → fetch
   `yahoo.options(symbol, exp)` (chain area shows its spinner; selector stays).
2. **`OptionsSummary`** with `analyzeChain(chain)` — the floating analysis card (put/call
   ratio, max pain, IV overview per §2.2).
3. **Calls/Puts toggle**: `SegmentedControl segments={['Calls','Puts']}`.
4. **Chain**: `Card` (padding 0): `OptionChainHeader`, then an `OptionChainRow` per contract of
   the selected side, strike-ascending, ITM rows washed `colors.itm`. On first render,
   auto-scroll intent is *not* implemented (out of scope) — instead the list is windowed to
   the 20 strikes nearest `chain.spot` (10 below, 10 above; all of them when spot is null or
   the side has ≤ 20), with ghost "Show all strikes" / "Show fewer" toggles at the foot.
   Empty side → centered `type.caption` "No {calls|puts} for this expiry."
5. Loading (initial): spinner box. Chain error after a successful expiry list is impossible
   (one payload) — any error is the section-level degraded card.

### 6.8 Existing screens (Agent 3): Board `/board`, Settings, Preview, Onboarding, Splash

No structural redesign — a faithful retheme plus the route moves of §3:
- Token flip does most of it; then sweep each file for hardcoded colors (e.g. any rgba/hex in
  `dashboard.tsx` styles) and map: dark fills → `colors.surface`/`surfaceAlt`, light text →
  `colors.text`/`textDim`. The sweep also greps for **`colors.accent` used as a
  `backgroundColor`** — a token-level semantic break the hex grep cannot catch: after the
  flip, a hand-rolled accent-filled CTA (e.g. `password.tsx`'s JOIN button — fill
  `colors.accent`, label `colors.ink`) would render as a magenta filled button, violating
  §0.1 (navy is the filled-CTA color). Any such CTA becomes `Button variant="primary"` (or,
  where the Button component doesn't fit, a `colors.navy` fill with `colors.ink` label).
- Splash `index.tsx`: `Screen aurora`; "Claude Post" brand line in `type.headingLg` (system
  fallback acceptable pre-font-load since fonts gate rendering in root layout anyway).
- Board: remove any in-page navigation to settings (it is a tab); keep the 5 s device poll,
  A1/A2 SegmentedControl, chips, InfoRows — all restyled by their components. `Screen` without
  aurora (it is a dense status page).
- Settings: same treatment, no aurora.
- Preview: keep the dark framebuffer image area exactly as rendered by the board (the panel
  image is the panel's), but the surrounding chrome flips to light tokens.
- Onboarding: `turn-on`/`complete` get `Screen aurora` (hero moments); the utility steps
  (wifi-list, password, news) stay plain. `complete.tsx` routes to `/board`.

---

## 7. File-ownership table — six agents, zero shared files

No file appears twice. Agents 4/5/6 depend on 1/2's *interfaces*, which are fully specified
above — build against the spec, not against each other's WIP. Section components (Agent 6) and
the shell (Agent 5) meet only at the `DetailSectionProps` contract and the exported names in
§6.3.

| Agent | Scope | Owns (creates ⊕ / modifies Δ / moves ⇒) |
|---|---|---|
| **1 — Theme & core components** | tokens, fonts install, all §2.1 restyles, generic new components | Δ `app/package.json` + `app/package-lock.json` (the §5 installs), Δ `app/src/theme.ts`, Δ `app/src/components/Screen.tsx`, Δ `Button.tsx`, Δ `Card.tsx`, Δ `Chip.tsx`, Δ `SegmentedControl.tsx`, Δ `StatTile.tsx`, Δ `InfoRow.tsx`, Δ `ScreenMessage.tsx`, Δ `BackButton.tsx`, Δ `IconBadge.tsx`, Δ `StepHero.tsx`, Δ `StepScaffold.tsx`, ⊕ `app/src/components/AuroraBackground.tsx`, ⊕ `DeltaText.tsx`, ⊕ `SearchField.tsx`, ⊕ `SectionTabs.tsx`, ⊕ `TimeframePills.tsx` |
| **2 — Market data layer & tests** | everything under `lib/market/` | ⊕ `app/src/lib/market/types.ts`, ⊕ `crumb.ts`, ⊕ `cache.ts`, ⊕ `timeframes.ts`, ⊕ `yahoo.ts`, ⊕ `watchlist.ts`, ⊕ `format.ts`, ⊕ `analysis.ts`, ⊕ `yahoo.test.ts`, ⊕ `crumb.test.ts`, ⊕ `cache.test.ts`, ⊕ `timeframes.test.ts`, ⊕ `watchlist.test.ts`, ⊕ `format.test.ts`, ⊕ `analysis.test.ts` |
| **3 — Navigation & existing-screen retheme** | tabs restructure, font loading, route migration, §6.8 | Δ `app/app.json`, Δ `app/src/app/_layout.tsx`, Δ `app/src/app/index.tsx`, ⊕ `app/src/app/(tabs)/_layout.tsx`, ⇒Δ `app/src/app/(tabs)/board.tsx` (from `dashboard.tsx`), ⇒Δ `app/src/app/(tabs)/settings.tsx` (from `settings.tsx`), Δ `app/src/app/preview.tsx`, Δ `app/src/app/onboarding/_layout.tsx`, Δ `turn-on.tsx`, Δ `wifi-list.tsx`, Δ `password.tsx`, Δ `news.tsx`, Δ `complete.tsx` |
| **4 — Markets tab & add flow** | §6.1, §6.2 | ⊕ `app/src/app/(tabs)/markets.tsx`, ⊕ `app/src/app/add-ticker.tsx`, ⊕ `app/src/components/TickerRow.tsx`, ⊕ `app/src/components/Sparkline.tsx` |
| **5 — Detail shell, chart & info** | §6.3, §6.4, PriceChart | ⊕ `app/src/app/market/[symbol].tsx`, ⊕ `app/src/components/PriceChart.tsx`, ⊕ `app/src/components/StatRow.tsx`, ⊕ `app/src/components/detail/InfoSection.tsx` |
| **6 — News, calendar & options** | §6.5–§6.7 | ⊕ `app/src/components/detail/NewsSection.tsx`, ⊕ `app/src/components/detail/CalendarSection.tsx`, ⊕ `app/src/components/detail/OptionsSection.tsx`, ⊕ `app/src/components/NewsCard.tsx`, ⊕ `app/src/components/EventRow.tsx`, ⊕ `app/src/components/OptionChainRow.tsx`, ⊕ `app/src/components/OptionsSummary.tsx` |

Sequencing note for the integrator: Agents 1–2 have no dependencies; 3–6 import from 1–2 but
can be written in parallel against this spec. The one hard merge-order rule: Agent 3's
`_layout.tsx` registers the `market/[symbol]` and `add-ticker` routes that Agents 4–5 create —
expo-router tolerates the screens landing in either order, so no coordination is needed beyond
the names being exactly as written here.

**Definition of done (every agent):** `cd app && npm test && npm run typecheck` pass; no
`test.skip`/`.only`/TODO placeholders; no hardcoded colors in owned files; every numeric Text
in owned files carries `tabular`.

---

## Appendix A — critique disposition (2026-09-01 two-critic review)

Every item from both critics was applied; none were rejected. Where a critic offered
alternative fixes, the choice taken is now part of the spec body: `shadow.floatHighlight` was
cut rather than documented-as-invisible (feasibility 7/15); the search modal moved to
`/add-ticker` instead of betting on expo-router's static-segment case rules against the real
ticker "ADD" (feasibility 16); `ProfileInfo.name` was dropped and the header's quote name
governs (feasibility 22); the options chain dropped its Last column rather than stacking
Bid over Ask (fidelity 6); the direction and accent hues split into text-duty
(`up`/`down`/`accent`) and graphics-duty (`upBright`/`downBright`/`accentBright`) tokens
rather than darkening the vivid pair everywhere (fidelity 2–3); and the aurora blobs were both
re-tabled *and* clamped in code so "no ellipse below 45%" holds on every window shape
(feasibility 14 / fidelity 9).
