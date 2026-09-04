// The three-letter month names, in one place.
//
// Three formatters need them — the device's `lib/format.ts`, the market tab's
// `lib/market/format.ts` and the edition's `lib/edition/freshness.ts` — and each had its own copy
// of the same twelve strings. The formatters themselves stay separate on purpose (different
// inputs, different tiers, deliberately different timezone rules); this is only the constant they
// all spell the same way, so a localisation or a spelling change is one edit rather than three.

export const MONTHS: readonly string[] = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
]
