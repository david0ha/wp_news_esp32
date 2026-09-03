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
  /**
   * The tile headline. This design has no photograph on a story tile, so the headline at 22/26
   * is what carries the visual weight a picture would — which is why it is a token of its own
   * rather than `heading` reused a size down.
   */
  pinHeadline: {
    fontFamily: fonts.extrabold,
    fontSize: 22,
    lineHeight: 26,
    letterSpacing: -0.4,
    color: colors.text,
  } as TextStyle,
  /** The deck under a tile headline: the sentence that says why the headline matters. */
  pinDeck: {
    fontFamily: fonts.regular,
    fontSize: 14,
    lineHeight: 19,
    letterSpacing: 0,
    color: colors.textDim,
  } as TextStyle,
} as const
