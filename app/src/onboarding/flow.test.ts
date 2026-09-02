import { describe, it, expect } from '@jest/globals'
import {
  ONBOARDING_ROUTES,
  ONBOARDING_STEPS,
  canProceed,
  entryRouteFor,
  parseOnboardingFlow,
  progressFor,
  stepIndex,
  wizardEntryHref,
  wizardExitRoute,
  wizardOffersBack,
  wizardOffersSkip,
  wizardStepHref,
  type EntryRoute,
  type WizardFlow,
} from './flow'

describe('onboarding flow ordering', () => {
  it('lists the steps in order', () => {
    // The news-URL step sits between Wi-Fi selection and the password/join step, so the address
    // is collected before provisioning hands it over with the credentials — the board's very
    // first poll after joining then already has somewhere to go.
    expect(ONBOARDING_STEPS).toEqual(['turn-on', 'wifi-list', 'news', 'password', 'complete'])
  })

  it('indexes steps', () => {
    expect(stepIndex('turn-on')).toBe(0)
    expect(stepIndex('complete')).toBe(4)
  })

  it('progresses from 1/5 to 5/5', () => {
    expect(progressFor('turn-on')).toBeCloseTo(0.2)
    expect(progressFor('complete')).toBeCloseTo(1)
  })
})

describe('canProceed', () => {
  const base = { selectedNetwork: null as string | null, password: '', newsUrl: '' }

  it('always allows the info + completion steps', () => {
    expect(canProceed('turn-on', base)).toBe(true)
    expect(canProceed('complete', base)).toBe(true)
  })

  it('requires a selected network on wifi-list', () => {
    expect(canProceed('wifi-list', base)).toBe(false)
    expect(canProceed('wifi-list', { ...base, selectedNetwork: 'Home' })).toBe(true)
  })

  it('allows a blank news URL — the board runs on its demo snapshot', () => {
    expect(canProceed('news', base)).toBe(true)
  })

  it('allows a well-formed news URL', () => {
    expect(canProceed('news', { ...base, newsUrl: 'http://mac.local:8123/news.json' })).toBe(true)
  })

  it('blocks a malformed news URL before the join, not after it', () => {
    // The board would reject this too, but only on the far side of a ~45s Wi-Fi join the user
    // cannot undo.
    expect(canProceed('news', { ...base, newsUrl: 'mac.local/news.json' })).toBe(false)
    expect(canProceed('news', { ...base, newsUrl: 'http://' })).toBe(false)
  })

  it('requires a password only for secured networks', () => {
    expect(canProceed('password', { ...base, selectedNetwork: 'Home', selectedSecured: true, password: '' })).toBe(
      false,
    )
    expect(
      canProceed('password', { ...base, selectedNetwork: 'Home', selectedSecured: true, password: 'pw' }),
    ).toBe(true)
    // open network needs no password
    expect(
      canProceed('password', { ...base, selectedNetwork: 'Cafe', selectedSecured: false, password: '' }),
    ).toBe(true)
  })
})

describe('entryRouteFor', () => {
  // The full hasBoard x onboarded x skipped table, spelled out rather than generated. This is the
  // one decision the whole skip feature turns on, and a loop over a predicate would only restate
  // the implementation; eight literal rows are a thing a reviewer can check against the design.
  const table: Array<{ hasBoard: boolean; onboarded: boolean; skipped: boolean; expected: EntryRoute }> = [
    // Nobody has answered anything yet: the only cell that gets the wizard.
    { hasBoard: false, onboarded: false, skipped: false, expected: '/onboarding/turn-on' },
    // Tapped SET UP LATER. Past the front door without hardware — the markets work on their own.
    { hasBoard: false, onboarded: false, skipped: true, expected: '/markets' },
    // Onboarded but no URL: either "Forget this board", or complete.tsx's setBaseUrl was rejected.
    // The single-bit gate sent this user to a board tab with nothing behind it.
    { hasBoard: false, onboarded: true, skipped: false, expected: '/markets' },
    { hasBoard: false, onboarded: true, skipped: true, expected: '/markets' },
    // A saved URL outranks both marks, in all four combinations. This is the property that lets
    // `claudepost.setupSkipped` be written once and never cleared: a skipper who sets a board up
    // later routes to /board on the URL alone, with a stale skip mark still on disk.
    { hasBoard: true, onboarded: false, skipped: false, expected: '/board' },
    { hasBoard: true, onboarded: false, skipped: true, expected: '/board' },
    { hasBoard: true, onboarded: true, skipped: false, expected: '/board' },
    { hasBoard: true, onboarded: true, skipped: true, expected: '/board' },
  ]

  it('covers every combination of the three bits exactly once', () => {
    const seen = new Set(table.map((r) => `${r.hasBoard}|${r.onboarded}|${r.skipped}`))
    expect(seen.size).toBe(8)
  })

  it.each(table)(
    'hasBoard=$hasBoard onboarded=$onboarded skipped=$skipped -> $expected',
    ({ hasBoard, onboarded, skipped, expected }) => {
      expect(entryRouteFor({ hasBoard, onboarded, skipped })).toBe(expected)
    },
  )

  it('treats an env base URL as owning a board, with every other bit false', () => {
    // EXPO_PUBLIC_ESP32_BASE_URL is a mock or a dev board on the desk. Nothing is persisted for it,
    // so without this arm a developer would be walked through the SoftAP wizard on every launch.
    expect(entryRouteFor({ hasBoard: false, onboarded: false, skipped: false, envBaseUrl: true })).toBe('/board')
  })

  it('reads envBaseUrl false and envBaseUrl omitted the same way', () => {
    // index.tsx passes `!!ENV_BASE_URL`, so the false case is the live one; the optional-property
    // case is what a future caller that does not know about the env override will hand us.
    for (const row of table) {
      const { expected, ...bits } = row
      expect(entryRouteFor({ ...bits, envBaseUrl: false })).toBe(expected)
      expect(entryRouteFor(bits)).toBe(expected)
    }
  })
})

describe('parseOnboardingFlow', () => {
  it('recognises the one string it writes', () => {
    expect(parseOnboardingFlow('setup')).toBe('setup')
  })

  it('reads everything else as a first run', () => {
    // The failure direction is deliberate: mis-reading a re-entry as a first run costs an extra
    // control in the top bar, mis-reading a first run as a re-entry costs the exit entirely.
    expect(parseOnboardingFlow(undefined)).toBe('first-run')
    expect(parseOnboardingFlow('')).toBe('first-run')
    expect(parseOnboardingFlow('garbage')).toBe('first-run')
    // expo-router hands back an array when a param is repeated in the URL; it is never unwrapped.
    expect(parseOnboardingFlow(['a', 'b'])).toBe('first-run')
    expect(parseOnboardingFlow(7)).toBe('first-run')
  })
})

describe('wizard chrome', () => {
  const flows: WizardFlow[] = ['first-run', 'setup']

  it('offers SKIP on the first run and Back on a re-entry', () => {
    expect(wizardOffersSkip('first-run')).toBe(true)
    expect(wizardOffersSkip('setup')).toBe(false)
    expect(wizardOffersBack('first-run')).toBe(false)
    expect(wizardOffersBack('setup')).toBe(true)
  })

  it('never shows both ways out, and never shows neither', () => {
    // Both is two controls in one top bar that both mean "leave"; neither is the wall the whole
    // feature exists to remove. This holds for every flow, which is what stops a third one from
    // being added without deciding which exit it gets.
    for (const flow of flows) {
      expect(wizardOffersSkip(flow) !== wizardOffersBack(flow)).toBe(true)
    }
  })

  it('sends a stackless Back to Settings only on a re-entry', () => {
    expect(wizardExitRoute('setup')).toBe('/settings')
    expect(wizardExitRoute('first-run')).toBeNull()
  })
})

describe('wizardEntryHref', () => {
  it('carries the flow into the wizard', () => {
    expect(wizardEntryHref('setup')).toEqual({ pathname: '/onboarding/turn-on', params: { flow: 'setup' } })
    expect(wizardEntryHref('first-run')).toEqual({ pathname: '/onboarding/turn-on', params: { flow: 'first-run' } })
  })

  it('takes its pathname from the step table rather than a second literal', () => {
    // Both assertions above hardcode the string on purpose — this one is what ties them to the
    // route table, so renaming the first step breaks the test instead of shipping a push to a
    // route that no longer exists.
    expect(wizardEntryHref('setup').pathname).toBe(ONBOARDING_ROUTES['turn-on'])
  })

  it('is the first step of wizardStepHref', () => {
    // The entry href is not a separate construction: the wizard's front door is step one by
    // definition, so the two must never be able to disagree about the route or the param shape.
    for (const flow of ['first-run', 'setup'] as const) {
      expect(wizardEntryHref(flow)).toEqual(wizardStepHref('turn-on', flow))
    }
  })
})

describe('wizardStepHref', () => {
  it('carries the flow across a step boundary', () => {
    // The regression this pins: turn-on's NEXT used to push the bare pathname, and because the
    // param is route-local wifi-list then read no flow at all, defaulted to 'first-run', and put
    // SET UP LATER in the top bar of a re-entry from Settings — an exit mid-wizard that would have
    // replaced the screen the user came from.
    expect(wizardStepHref('wifi-list', 'setup')).toEqual({
      pathname: ONBOARDING_ROUTES['wifi-list'],
      params: { flow: 'setup' },
    })
    expect(wizardStepHref('wifi-list', 'first-run')).toEqual({
      pathname: ONBOARDING_ROUTES['wifi-list'],
      params: { flow: 'first-run' },
    })
  })

  it('reads every pathname from the route table', () => {
    for (const step of ONBOARDING_STEPS) {
      expect(wizardStepHref(step, 'setup').pathname).toBe(ONBOARDING_ROUTES[step])
    }
  })

  it('round-trips through parseOnboardingFlow, at every step', () => {
    // The param is written here and read on the far side by the screen; this is the one assertion
    // that holds the two halves to the same vocabulary. It runs over every step rather than the two
    // that read the flow today, because the rule being pinned is "every forward move carries it",
    // not "every step that reads it gets it". Narrowing this loop to the current readers would let
    // the chain be cut at news or password and still pass — which is exactly the shape of the
    // defect it exists to catch, one step further along.
    for (const flow of ['first-run', 'setup'] as const) {
      for (const step of ONBOARDING_STEPS) {
        expect(parseOnboardingFlow(wizardStepHref(step, flow).params.flow)).toBe(flow)
      }
    }
  })

  it('carries the flow the whole length of the wizard', () => {
    // Walk the steps the way the screens do: each hop parses the param it was handed and builds the
    // next href out of that, never out of a literal. The flow the wizard opened with must still be
    // the flow at `complete`. One bare pathname anywhere in the chain drops it to 'first-run' and
    // this goes red — which is the whole failure, since 'first-run' is the value that puts SET UP
    // LATER in front of somebody who owns a board and writes the permanent skip mark when tapped.
    for (const opened of ['first-run', 'setup'] as const) {
      let carried = parseOnboardingFlow(wizardEntryHref(opened).params.flow)
      for (const step of ONBOARDING_STEPS.slice(1)) {
        carried = parseOnboardingFlow(wizardStepHref(step, carried).params.flow)
      }
      expect(carried).toBe(opened)
    }
  })
})
