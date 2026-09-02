// Pure logic for the board-onboarding wizard, plus the two decisions that surround it: which
// screen a cold launch lands on, and which chrome the wizard wears depending on why it opened.
// The networking lives in src/lib/esp32.ts (the board's SoftAP JSON API) and the persistence in
// src/lib/store.ts; this module models only step order, progress, per-step "can proceed" gating,
// the entry route and the wizard's flow vocabulary — so the screens stay declarative and every
// one of those decisions is unit-testable without a renderer.

import { validateNewsUrl } from '../lib/newsurl'

export const ONBOARDING_STEPS = ['turn-on', 'wifi-list', 'news', 'password', 'complete'] as const

export type OnboardingStep = (typeof ONBOARDING_STEPS)[number]

/** Route path for a step, as registered under `src/app/onboarding/`. */
export const ONBOARDING_ROUTES: Record<OnboardingStep, string> = {
  'turn-on': '/onboarding/turn-on',
  'wifi-list': '/onboarding/wifi-list',
  news: '/onboarding/news',
  password: '/onboarding/password',
  complete: '/onboarding/complete',
}

export function stepIndex(step: OnboardingStep): number {
  return ONBOARDING_STEPS.indexOf(step)
}

/** Progress-bar fill fraction (0..1) for the bar shown at the top. */
export function progressFor(step: OnboardingStep): number {
  return (stepIndex(step) + 1) / ONBOARDING_STEPS.length
}

/** State the wizard collects and sends to the board (see src/lib/esp32.ts). */
export interface OnboardingState {
  selectedNetwork: string | null
  password: string
  /** Whether the chosen network is password-protected. Undefined until one is picked. */
  selectedSecured?: boolean
  /** Where the board will fetch its snapshot. Empty = run on the built-in demo snapshot. */
  newsUrl: string
}

/** Whether the bottom CTA is enabled for the given step. */
export function canProceed(step: OnboardingStep, state: OnboardingState): boolean {
  switch (step) {
    case 'turn-on':
    case 'complete':
      return true
    case 'wifi-list':
      return state.selectedNetwork !== null
    case 'news':
      // The URL is optional — blank leaves the board on its demo snapshot, which is a complete
      // product. But a *typed* URL must be well-formed: the board's own rejection would otherwise
      // arrive on the far side of a Wi-Fi join the user cannot undo.
      return validateNewsUrl(state.newsUrl).ok
    case 'password':
      // An open (passwordless) network needs no password; secured ones require a non-empty one.
      return state.selectedSecured === false || state.password.trim().length > 0
  }
}

// ---------------------------------------------------------------------------------------------
// The entry gate
//
// Three independently persisted bits (src/lib/store.ts) answer three different questions, and this
// is the only place they are turned into a destination. It used to be a ternary inside an effect in
// src/app/index.tsx reading one bit — `onboardingComplete` — which was being asked to mean both "is
// this person past the front door?" and "is there a board?". Somebody who owns no hardware answers
// no to the second forever, so they were walled at /onboarding/turn-on with no way past it.
//
// The ordering is the whole argument:
//
//   1. A configured board outranks everything, and that is what licenses `claudepost.setupSkipped`
//      never being cleared: a skipper who later sets a board up routes to /board on the strength of
//      the saved URL alone. No code path has to remember to erase the mark, so no forgotten erase
//      can send a board owner to the markets tab on every launch.
//   2. `onboarded || skipped` is "past the front door" — the wizard has been offered and answered,
//      either way. That arm also catches two states the single-bit gate got wrong: a user who
//      forgot their board (onboarded, no URL), and an install where complete.tsx marked onboarding
//      done but `setBaseUrl` rejected the address it was handed.
//   3. Only a phone that has never answered gets the wizard.
//
// Pure and total on purpose. The gate runs once per cold launch on the far side of a splash screen,
// and a decision that can throw there is a decision that strands the user on a spinner.

/** Where a cold launch lands: /board and /markets are tabs, turn-on is the wizard's first step. */
export type EntryRoute = '/board' | '/markets' | '/onboarding/turn-on'

export function entryRouteFor(s: {
  /** A base URL is saved — `claudepost.deviceBaseUrl` is set. */
  hasBoard: boolean
  /** The wizard once finished against real hardware — `claudepost.onboardingComplete`. */
  onboarded: boolean
  /** This phone tapped SET UP LATER — `claudepost.setupSkipped`. */
  skipped: boolean
  /** EXPO_PUBLIC_ESP32_BASE_URL is set: a mock or a dev board, which counts as owning one. */
  envBaseUrl?: boolean
}): EntryRoute {
  if (s.envBaseUrl || s.hasBoard) return '/board'
  if (s.onboarded || s.skipped) return '/markets'
  return '/onboarding/turn-on'
}

// ---------------------------------------------------------------------------------------------
// Why the wizard opened
//
// One wizard, two flows. Once an exit exists, /onboarding/turn-on is reachable from three places —
// the entry gate, Settings, and the Board tab's no-board card — and the later two want the opposite
// chrome from the first. Somebody who opened setup deliberately needs Back and has no use for a
// control that says "not now"; a first launch needs exactly that control and has nothing behind it
// to go back to. Offering both is two controls in one top bar that both mean "leave"; offering
// neither is the wall this feature exists to remove.
//
// The flow travels as a route param rather than being inferred from `router.canGoBack()`, because a
// deep link into a fresh process has no stack either and would read as a first run.

export type WizardFlow = 'first-run' | 'setup'

/**
 * Read the `flow` route param. Anything that is not the exact string 'setup' — missing, empty, a
 * typo, the array expo-router hands back for a repeated `?flow=`, a number — reads as 'first-run'.
 *
 * Strict, and defaulting in that direction deliberately: a first-run user given the 'setup' chrome
 * loses the exit and gets the wall back, while a re-entrant given the first-run chrome merely gains
 * a control that still does something coherent. Only `wizardEntryHref` ever writes this param, so a
 * value we do not recognise came from a hand-written link and is not a case to guess at — an array
 * in particular is never unwrapped, because a repeated `?flow=` is not something this app produces.
 */
export function parseOnboardingFlow(raw: unknown): WizardFlow {
  return raw === 'setup' ? 'setup' : 'first-run'
}

/** SET UP LATER is offered on the first run only — src/onboarding/skip.ts is what it does. */
export function wizardOffersSkip(flow: WizardFlow): boolean {
  return flow === 'first-run'
}

/** Back is offered on a deliberate re-entry only, where there is a screen behind the wizard. */
export function wizardOffersBack(flow: WizardFlow): boolean {
  return flow === 'setup'
}

/**
 * Where Back lands when there is no stack to pop — a re-entry that outlived its process, or a deep
 * link straight into the wizard. Null on the first run, where Back is not offered at all and the
 * caller's own fallback applies instead.
 */
export function wizardExitRoute(flow: WizardFlow): '/settings' | null {
  return flow === 'setup' ? '/settings' : null
}

/**
 * An href for a step of the wizard with the flow still attached. **Every** forward navigation
 * between steps goes through this — push or replace, and whether or not the destination reads the
 * flow today — because the param is route-local: a bare `router.push(ONBOARDING_ROUTES['wifi-list'])`
 * hands the next screen an empty param bag, so its `parseOnboardingFlow` reads 'first-run' and a
 * re-entry from Settings grows a SET UP LATER one step in — an exit offered to somebody who opened
 * setup on purpose, and one that would `replace` the screen they came from on the way out, writing
 * the permanent skip mark on a phone that owns a board. That defect was one bare pathname wide.
 *
 * "Whether or not it reads the flow today" is the load-bearing half of the rule. Only turn-on and
 * wifi-list ask what the flow is; news, password and complete carry a param they never open. The
 * earlier, narrower rule — carry it to the steps that read it — is what left the wizard one edit
 * from the same defect, because its two halves live in different files: a later step grows a
 * `parseOnboardingFlow` in its own file, the push that feeds it sits in the file before it, and the
 * author of the reader has no reason to go looking. The failure is silent and in the wrong
 * direction — the missing param does not throw, it reads as 'first-run' and offers an exit. So the
 * rule is unconditional. Carrying the flow to a step that ignores it costs one route param nobody
 * looks at; not carrying it costs a control that lies about why the user is here.
 *
 * What makes that structural rather than remembered: with these call sites converted, no screen
 * under src/app/onboarding/ imports ONBOARDING_ROUTES at all — the table is something this module
 * reads and the screens do not. Writing a bare push now means re-importing the table, which is a
 * line a reviewer sees, instead of an omission that looks like nothing.
 *
 * Back needs no equivalent: popping restores the earlier route entry along with the params it was
 * pushed with, so the flow survives a Back on its own. Only forward navigation has to carry it —
 * and `replace` is forward, which is why password's two exits into complete go through here too.
 *
 * The pathname is read from ONBOARDING_ROUTES rather than spelled again, so a renamed route is a
 * type error here instead of a push that silently goes nowhere.
 */
export function wizardStepHref(
  step: OnboardingStep,
  flow: WizardFlow,
): { pathname: string; params: { flow: WizardFlow } } {
  return { pathname: ONBOARDING_ROUTES[step], params: { flow } }
}

/**
 * The only sanctioned way in. A bare `router.push('/onboarding/turn-on')` carries no param, so it
 * parses as 'first-run' and shows somebody who opened setup on purpose a SET UP LATER — an exit
 * they did not ask for — in place of the Back they did.
 *
 * The wizard's entry is the first step's route by definition, which is why this is `wizardStepHref`
 * with that step filled in rather than a second construction of the same object.
 */
export function wizardEntryHref(flow: WizardFlow): { pathname: string; params: { flow: WizardFlow } } {
  return wizardStepHref(ONBOARDING_STEPS[0], flow)
}
