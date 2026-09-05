import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Text } from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { StepScaffold } from '../../components/StepScaffold'
import { StepHero, heroBold } from '../../components/StepHero'
import { IconBadge } from '../../components/IconBadge'
import { useOnboarding } from '../../onboarding/OnboardingContext'
import {
  parseOnboardingFlow,
  progressFor,
  wizardExitRoute,
  wizardOffersBack,
  wizardOffersSkip,
  wizardStepHref,
} from '../../onboarding/flow'
import { skipSetup } from '../../onboarding/skip'
import { esp32 } from '../../lib/esp32'
import { fill, useStrings } from '../../i18n'
import { colors } from '../../theme'

// The board's own access point, as it appears in a phone's Wi-Fi list. A brand plus a placeholder
// for the four characters the board appends: the same string in every language, so it is a literal
// here and not a catalogue entry.
const SETUP_AP_NAME = 'Claude Post-XXXX'

/**
 * Fill a sentence and cut it either side of one remaining placeholder, so the two halves can be
 * drawn around a styled span.
 *
 * Two of this step's three sentences set a network's name in bold inside running copy, and the
 * name does not sit in the same place in both languages — it leads the Korean sentence and trails
 * the English one. Building the copy from a prefix and a suffix would therefore work in exactly
 * one language and leave the other with an empty fragment; keeping the whole sentence in the
 * catalogue and cutting it here works in both. The quotation marks are deliberately not in the
 * catalogue: they are typography rather than copy, and they belong with the styling they decorate.
 */
function around(template: string, token: string, vars: Record<string, string>): [string, string] {
  const [before = '', after = ''] = fill(template, vars).split(`{${token}}`)
  return [before, after]
}

// Step 1: power the device on and join its setup AP, then probe http://192.168.4.1 over the
// SoftAP. The default `esp32` client is bound to 192.168.4.1, which is correct here because the
// phone is on the device's AP (not yet the home LAN).
//
// This is also the wizard's front door, so it is where the `flow` param is read (see
// src/onboarding/flow.ts). The probing itself is identical either way; all the flow decides is
// which of the two top-bar controls the user is handed, and whether the "we cannot see a board"
// copy mentions the way out.
type Reach = 'checking' | 'found' | 'not-found'

export default function TurnOn() {
  const router = useRouter()
  const s = useStrings()
  const { setDeviceInfo } = useOnboarding()
  const flow = parseOnboardingFlow(useLocalSearchParams<{ flow?: string }>().flow)
  const [reach, setReach] = useState<Reach>('checking')
  const [apSsid, setApSsid] = useState<string | null>(null)

  const check = useCallback(async () => {
    setReach('checking')
    try {
      const info = await esp32.getInfo()
      setDeviceInfo(info)
      setApSsid(info.apSsid || null)
      setReach('found')
    } catch (e) {
      console.warn('[onboarding] device probe failed (likely not on the setup Wi-Fi yet)', e)
      setReach('not-found')
    }
  }, [setDeviceInfo])

  useEffect(() => {
    check()
  }, [check])

  const onNext = () => {
    // The flow travels with the push. It is a route param, so it is local to the route that
    // carries it: a bare pathname would hand wifi-list an empty param bag, which parses as
    // 'first-run' and puts a SET UP LATER in the top bar of a re-entry from Settings — an exit
    // this user already declined, offered one step into the wizard they opened on purpose, and one
    // that `replace`s the screen they came from on the way out.
    if (reach === 'found') router.push(wizardStepHref('wifi-list', flow))
    else check()
  }

  const t = s.onboarding.turnOn
  let ctaLabel: string
  let title: string
  let body: ReactNode
  switch (reach) {
    case 'checking':
      ctaLabel = t.ctaChecking
      title = t.lookingTitle
      body = <>{t.lookingBody}</>
      break
    case 'found': {
      ctaLabel = s.onboarding.nav.next
      title = t.foundTitle
      const [before, after] = around(t.foundBody, 'ssid', { next: s.onboarding.nav.next })
      body = (
        <>
          {before}
          <Text style={heroBold}>‘{apSsid ?? t.theDevice}’</Text>
          {after}
        </>
      )
      break
    }
    case 'not-found': {
      ctaLabel = t.ctaCheckAgain
      title = t.turnOnTitle
      const [before, after] = around(t.turnOnBody, 'ap', { again: t.ctaCheckAgain })
      body = (
        <>
          {before}
          <Text style={heroBold}>‘{SETUP_AP_NAME}’</Text>
          {after}
          {/*
            The exit earns a sentence precisely in this branch, because this is the one that says
            "we cannot see a board" — and the largest reason for that is that there isn't one.
            Somebody who owns no hardware reads the instructions above as a task they cannot
            perform, and two words in the corner of the top bar as chrome; told plainly what is on
            the other side of them — a working app rather than a diminished one — they tap it
            instead of deleting the app. The sentence is the copy half of the wall this flow
            removes: the control alone reopens the door, saying so is what makes anyone walk
            through it.

            First run only, and not because a re-entrant would be confused: they have no SET UP
            LATER to be pointed at, so the sentence would name a control that is not on screen and
            send them to the Settings screen they just came from.
          */}
          {wizardOffersSkip(flow) ? (
            <>
              {'\n\n'}
              {fill(t.skipNote, { later: s.onboarding.nav.setUpLater })}
            </>
          ) : null}
        </>
      )
      break
    }
  }

  return (
    <StepScaffold
      aurora
      progress={progressFor('turn-on')}
      // Both top-bar controls belong to the flow rather than to the step, and by construction
      // exactly one of them is offered (wizardOffersSkip / wizardOffersBack are complements). On a
      // first run there is nothing behind this screen but the splash, so Back has nowhere to go,
      // and SET UP LATER is the point of the whole flow: without it a phone that owns no board is
      // walled here on this launch and every launch after it. On a deliberate re-entry — from
      // Settings, or the Board tab's no-board card — it is the other way round: "not now" is an
      // answer this user has already given and would only be an accidental way to lose their
      // place, while the screen they came from is one Back owes them.
      //
      // `router.canGoBack()` cannot make the first decision, which is why the flow travels as a
      // route param instead: a re-entry that outlived its process, and any deep link into the
      // wizard, has an empty stack too and would read as a first run. It is still worth asking
      // inside the setup flow, because an empty stack there is exactly what wizardExitRoute's
      // /settings fallback is for.
      onBack={
        wizardOffersBack(flow)
          ? () => (router.canGoBack() ? router.back() : router.replace(wizardExitRoute(flow) ?? '/board'))
          : undefined
      }
      onSkip={wizardOffersSkip(flow) ? () => void skipSetup(router) : undefined}
      skipLabel={s.onboarding.nav.setUpLater}
      ctaLabel={ctaLabel}
      canProceed={reach !== 'checking'}
      onNext={onNext}
    >
      <StepHero
        illustration={<IconBadge name={reach === 'found' ? 'checkmark-circle' : 'hardware-chip'} size={52} />}
        title={title}
        body={body}
      />
      {reach === 'not-found' ? (
        <Text style={{ color: colors.textFaint, textAlign: 'center', fontSize: 12, paddingBottom: 8 }}>
          {t.apHint}
        </Text>
      ) : null}
    </StepScaffold>
  )
}
