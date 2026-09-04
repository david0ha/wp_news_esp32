// The three-letter month names, in one place.
//
// Three formatters need them — the device's `lib/format.ts`, the market tab's
// `lib/market/format.ts` and the edition's `lib/edition/freshness.ts` — and each had its own copy
// of the same twelve strings. The formatters themselves stay separate on purpose (different
// inputs, different tiers, deliberately different timezone rules); this is only the constant they
// all spell the same way, so a localisation or a spelling change is one edit rather than three.
//
// That edit has now been made, and it is why this is a FUNCTION and no longer a constant. The
// twelve names are copy: Korean numbers its months (`8월`) rather than abbreviating their names,
// so they live in the string catalogue like every other sentence. Reading them through
// `strings()` at call time is what lets a language chosen after this module was imported reach a
// formatter that imported it — a `const MONTHS = strings().months.short` here would pin English
// for the life of the process.

import { strings } from '../i18n'

export function months(): readonly string[] {
  return strings().months.short
}
