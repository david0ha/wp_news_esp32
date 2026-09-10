import { describe, it, expect, beforeEach, jest } from '@jest/globals'
import AsyncStorage from '@react-native-async-storage/async-storage'
import {
  DEFAULT_LEAD,
  DEFAULT_PREFS,
  DEFAULT_QUIET,
  LEAD_KINDS,
  LEADS,
  PUSH_KINDS,
  applyNotifyPrefs,
  askRouteForPush,
  commandIdOfPush,
  decideNotify,
  deviceBody,
  deviceZone,
  findRegistration,
  decideRelease,
  notifyView,
  parseNotifyPrefs,
  pushPlatform,
  releaseThisPhone,
  shouldAttemptRelease,
  turnOffNotifications,
  turnOnNotifications,
  validateQuiet,
  type DeskAnswer,
  type NotifyPrefs,
  type NotifyStep,
  type PushClient,
  type PushDoc,
  type ReleaseStep,
} from './notify'
import { DeskError } from './desk'
import { setActiveLanguage, strings } from '../i18n'

// The house placeholder. It is the only push token anywhere in this repository, and it is not a
// real one: a token is a capability to write on somebody's lock screen, so a plausible-looking
// fixture is a fixture nobody can tell from the real thing in a paste.
const TOKEN = 'ExponentPushToken[0000000000AAAAAAAAAA]'
const OTHER = 'ExponentPushToken[1111111111BBBBBBBBBB]'

const EMPTY: PushDoc = { devices: [] }

/** A desk that takes everything, holds whatever it was given, and records what it was asked. */
function fakeDesk(
  devices: PushDoc['devices'] = [],
): PushClient & { registered: unknown[]; forgotten: string[] } {
  const registered: unknown[] = []
  const forgotten: string[] = []
  return {
    registered,
    forgotten,
    async pushDevices() {
      return { devices }
    },
    async registerPushDevice(body) {
      registered.push(body)
      return EMPTY
    },
    async forgetPushDevice(token) {
      forgotten.push(token)
    },
  }
}

/** A desk that refuses everything — including the read that would say what became of a write. */
function refusingDesk(error: unknown): PushClient {
  return {
    async pushDevices() {
      throw error
    },
    async registerPushDevice() {
      throw error
    },
    async forgetPushDevice() {
      throw error
    },
  }
}

/**
 * A desk whose WRITES fail and whose READS work, which is the shape of every interesting failure
 * here: a POST or a DELETE the desk may or may not have committed, over a connection that then
 * came back. `holding` is what a read finds afterwards.
 */
function writeRefusingDesk(error: unknown, holding: NotifyPrefs | null): PushClient {
  return {
    async pushDevices() {
      return holding
        ? {
            devices: [
              {
                token: TOKEN,
                platform: 'ios',
                tz: 'Asia/Seoul',
                prefs: holding.prefs,
                lead: holding.lead,
                quiet: holding.quiet,
              },
            ],
          }
        : EMPTY
    },
    async registerPushDevice() {
      throw error
    },
    async forgetPushDevice() {
      throw error
    },
  }
}

function deps(over: Partial<Parameters<typeof turnOnNotifications>[0]> = {}) {
  return {
    client: fakeDesk(),
    platform: 'ios' as const,
    tz: 'Asia/Seoul',
    permission: async () => 'granted' as const,
    request: async () => 'granted' as const,
    token: async () => TOKEN,
    prefs: DEFAULT_PREFS,
    ...over,
  }
}

beforeEach(() => {
  setActiveLanguage('en')
})

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------

describe('the switches', () => {
  it('is the desk’s six, not the book’s eight', () => {
    // `push.KINDS` — the four computed kinds, `researched` shared by the four the agent had to go
    // and find, and `answer`, the one that is not a calendar alert at all. A seventh switch here
    // would be one the desk has nowhere to put.
    expect([...PUSH_KINDS].sort()).toEqual([
      'answer',
      'dividend',
      'earnings',
      'econ',
      'expiry',
      'researched',
    ])
  })

  it('offers exactly the six lead times the desk can schedule', () => {
    expect([...LEADS]).toEqual(['P7D', 'P2D', 'P1D', 'PT12H', 'PT3H', 'PT1H'])
  })

  it('starts every switch on, with the desk’s own default leads and no quiet hours', () => {
    for (const kind of PUSH_KINDS) expect(DEFAULT_PREFS.prefs[kind]).toBe(true)
    expect(DEFAULT_PREFS.lead).toEqual(DEFAULT_LEAD)
    expect(DEFAULT_PREFS.quiet).toBeNull()
  })
})

describe('parseNotifyPrefs', () => {
  it('reads an absent switch as on', () => {
    const p = parseNotifyPrefs({ prefs: { econ: false } })
    expect(p.prefs.econ).toBe(false)
    expect(p.prefs.earnings).toBe(true)
    expect(p.prefs.researched).toBe(true)
  })

  it('tells an absent lead list from an empty one', () => {
    // The desk's own rule: absence takes the default, emptiness takes nothing. They are the two
    // different answers to "how far ahead", and collapsing them would make it impossible to
    // switch a kind's lead times all the way off.
    const p = parseNotifyPrefs({ lead: { earnings: [] } })
    expect(p.lead.earnings).toEqual([])
    expect(p.lead.expiry).toEqual([...DEFAULT_LEAD.expiry])
  })

  it('drops a lead this app cannot draw and orders the rest longest first', () => {
    const p = parseNotifyPrefs({ lead: { econ: ['PT1H', 'PT30M', 'P7D'] } })
    expect(p.lead.econ).toEqual(['P7D', 'PT1H'])
  })

  it('keeps a quiet window and refuses one it cannot read', () => {
    expect(parseNotifyPrefs({ quiet: { from: '23:00', to: '07:00' } }).quiet).toEqual({
      from: '23:00',
      to: '07:00',
    })
    expect(parseNotifyPrefs({ quiet: { from: '25:00', to: '07:00' } }).quiet).toBeNull()
    expect(parseNotifyPrefs({}).quiet).toBeNull()
  })
})

describe('deviceBody', () => {
  const body = (prefs: NotifyPrefs) => deviceBody(TOKEN, 'ios', 'Asia/Seoul', prefs)

  it('carries the token, the platform, the zone, every switch and every lead', () => {
    const b = body(DEFAULT_PREFS) as unknown as Record<string, unknown>
    expect(b.token).toBe(TOKEN)
    expect(b.platform).toBe('ios')
    expect(b.tz).toBe('Asia/Seoul')
    expect(Object.keys(b.prefs as object).sort()).toEqual([...PUSH_KINDS].sort())
    expect(Object.keys(b.lead as object).sort()).toEqual([...PUSH_KINDS].sort())
  })

  it('sends no key the desk does not know', () => {
    // `push._no_extra_keys` refuses the whole document over one unknown key, so a helpful
    // `last_seen` echoed back from a GET is a 400 rather than a courtesy.
    const b = body({ ...DEFAULT_PREFS, quiet: DEFAULT_QUIET }) as unknown as Record<string, unknown>
    expect(Object.keys(b).sort()).toEqual(['lead', 'platform', 'prefs', 'quiet', 'token', 'tz'])
  })

  it('omits quiet hours entirely when there are none', () => {
    expect('quiet' in (body(DEFAULT_PREFS) as object)).toBe(false)
  })
})

describe('findRegistration', () => {
  const doc: PushDoc = {
    devices: [
      { token: OTHER, platform: 'android', tz: 'UTC', prefs: {}, lead: {}, quiet: null },
      {
        token: TOKEN,
        platform: 'ios',
        tz: 'Asia/Seoul',
        prefs: { econ: false },
        lead: {},
        quiet: null,
      },
    ],
  }

  it('finds this phone among the household and reads its switches', () => {
    expect(findRegistration(doc, TOKEN)?.prefs.econ).toBe(false)
  })

  it('answers null for a phone the desk has never heard of', () => {
    expect(findRegistration(doc, 'ExponentPushToken[2222222222CCCCCCCCCC]')).toBeNull()
    expect(findRegistration({ devices: [] }, TOKEN)).toBeNull()
  })
})

describe('validateQuiet', () => {
  it('takes a 24-hour clock and nothing else', () => {
    expect(validateQuiet('22:00', '07:00')).toEqual({ ok: true, quiet: { from: '22:00', to: '07:00' } })
    expect(validateQuiet('7:00', '22:00')).toEqual({ ok: false, reason: 'shape' })
    expect(validateQuiet('24:00', '07:00')).toEqual({ ok: false, reason: 'shape' })
    expect(validateQuiet('22:60', '07:00')).toEqual({ ok: false, reason: 'shape' })
    expect(validateQuiet('', '')).toEqual({ ok: false, reason: 'shape' })
  })

  it('refuses a window with no width, before the desk has to', () => {
    // `push._quiet` refuses it too, and says why. Catching it here means the sentence appears
    // under the field the owner just typed in rather than after a round trip.
    expect(validateQuiet('22:00', '22:00')).toEqual({ ok: false, reason: 'same' })
  })

  it('takes a window that wraps midnight, which is the ordinary one', () => {
    expect(validateQuiet('23:30', '06:15').ok).toBe(true)
  })
})

describe('the platform and the zone', () => {
  it('names the two platforms the desk accepts and nothing else', () => {
    expect(pushPlatform('ios')).toBe('ios')
    expect(pushPlatform('android')).toBe('android')
    expect(pushPlatform('web')).toBeNull()
    expect(pushPlatform('macos')).toBeNull()
  })

  it('falls back to UTC rather than sending a zone the desk will refuse', () => {
    expect(deviceZone('Asia/Seoul')).toBe('Asia/Seoul')
    expect(deviceZone(undefined)).toBe('UTC')
    expect(deviceZone('')).toBe('UTC')
  })
})

// ---------------------------------------------------------------------------
// The four outcomes
// ---------------------------------------------------------------------------

describe('notifyView — what the section draws before anything is touched', () => {
  const base = {
    loaded: true,
    ready: true,
    supported: true,
    permission: 'undetermined' as const,
    desk: 'not_holding' as DeskAnswer,
    busy: false,
  }

  it('says nothing at all until storage and the OS have answered', () => {
    const v = notifyView({ ...base, loaded: false })
    expect(v).toEqual({ on: false, disabled: true, note: null, detail: false, retry: false })
  })

  it('cannot be turned on without a desk, and says why', () => {
    const v = notifyView({ ...base, ready: false })
    expect(v.disabled).toBe(true)
    expect(v.note).toBe('needs_desk')
  })

  it('cannot be turned on where a push token is impossible', () => {
    const v = notifyView({ ...base, supported: false })
    expect(v.disabled).toBe(true)
    expect(v.note).toBe('unsupported')
  })

  it('claims nothing — not even "off" — while the desk has not answered', () => {
    // The switch is inert rather than drawn off. Off is a CLAIM, and on every ordinary open of
    // this screen it is a claim that is wrong for the length of a round trip and then silently
    // corrects itself, which teaches the owner not to trust it.
    const v = notifyView({ ...base, desk: 'unknown' })
    expect(v).toEqual({ on: false, disabled: true, note: null, detail: false, retry: false })
  })

  it('a desk that could not be asked is its own state, and never "not registered"', () => {
    // The whole reason `desk` is not a boolean. Folding this into `not_holding` draws a switch
    // that says off, with no sentence, over a desk that is still holding the token and sending.
    const v = notifyView({ ...base, desk: 'unreachable' })
    expect(v.on).toBe(false)
    expect(v.disabled).toBe(true)
    expect(v.note).toBe('unreachable')
    expect(v.retry).toBe(true)
  })

  it('draws the kinds only once the desk says it is holding this phone', () => {
    expect(notifyView({ ...base, desk: 'not_holding' }).detail).toBe(false)
    expect(notifyView({ ...base, permission: 'granted', desk: 'holding' })).toEqual({
      on: true,
      disabled: false,
      note: null,
      detail: true,
      retry: false,
    })
  })

  it('is dead while a call is out, without losing where it stands', () => {
    const v = notifyView({ ...base, permission: 'granted', desk: 'holding', busy: true })
    expect(v.on).toBe(true)
    expect(v.disabled).toBe(true)
  })

  it('a denied phone the desk is NOT holding gets a dead switch', () => {
    const v = notifyView({ ...base, permission: 'denied', desk: 'not_holding' })
    expect(v).toEqual({
      on: false,
      disabled: true,
      note: 'blocked',
      detail: false,
      retry: false,
    })
  })

  it('a denied phone the desk IS holding can still be turned off', () => {
    // The state this feature is worst at: iOS throws the pushes away without telling Expo, so
    // `prune_unregistered` never fires and the desk sends into a hole forever. A dead switch here
    // blocks the only call that ends it, so the switch is LIVE — one way, off — and the note says
    // both ways out.
    const v = notifyView({ ...base, permission: 'denied', desk: 'holding' })
    expect(v.on).toBe(true)
    expect(v.disabled).toBe(false)
    expect(v.note).toBe('blocked_registered')
    // Still no kind switches: the thing to do here is turn it off or fix the phone, not tune it.
    expect(v.detail).toBe(false)
  })

  it('a denied phone the desk is holding is still dead while a call is out', () => {
    const v = notifyView({ ...base, permission: 'denied', desk: 'holding', busy: true })
    expect(v.on).toBe(true)
    expect(v.disabled).toBe(true)
  })
})

describe('decideNotify — the outcome of touching the switch', () => {
  const t = () => strings().settings.notify

  it('1. granted, token fetched, desk took it → holding', () => {
    const d = decideNotify({ step: 'on', token: TOKEN, prefs: DEFAULT_PREFS })
    expect(d.desk).toBe('holding')
    expect(d.tone).toBe('ok')
    expect(d.message).toBe(t().registered)
  })

  it('2. denied → says nothing about the desk, and offers the way to fix it', () => {
    // `desk: null` and not `not_holding`: a permission the owner declined is a fact about the
    // phone. Writing `not_holding` here would erase what the desk actually last said.
    const d = decideNotify({ step: 'denied' })
    expect(d.desk).toBe(null)
    expect(d.tone).toBe('error')
    expect(d.message).toBe(t().blocked)
    expect(d.openSettings).toBe(true)
  })

  it('3. granted, and the desk answered that it is not holding this phone', () => {
    const d = decideNotify({ step: 'desk_failed', error: new DeskError('unauthorized', 'x', 401) })
    expect(d.desk).toBe('not_holding')
    expect(d.tone).toBe('error')
    // The sentence names the desk as the half that failed, and carries the desk's own reason.
    expect(d.message).toContain(strings().errors.desk.unauthorized)
    expect(d.openSettings).toBe(false)
  })

  it('3b. granted but no push token could be issued → nothing said about the desk', () => {
    const d = decideNotify({ step: 'token_failed', error: new Error('offline') })
    expect(d.desk).toBe(null)
    expect(d.message).toBe(t().tokenFailed)
  })

  it('4. no desk → says nothing about the desk it can no longer see', () => {
    const d = decideNotify({ step: 'no_desk' })
    expect(d.desk).toBe(null)
    expect(d.message).toBe(t().needsDesk)
    expect(d.openSettings).toBe(false)
  })

  it('a desk that would not forget the phone is still HOLDING it', () => {
    // The worst outcome available here is a phone that stops showing alerts while the desk goes
    // on sending them. A decision that reported `not_holding` over a failed DELETE draws exactly
    // that.
    const d = decideNotify({ step: 'forget_failed', error: new DeskError('transport', 'x') })
    expect(d.desk).toBe('holding')
    expect(d.tone).toBe('error')
    expect(d.message).toContain(strings().errors.desk.transport)
  })

  it('a refused change leaves the desk holding', () => {
    const d = decideNotify({
      step: 'change_failed',
      error: new DeskError('transport', 'x'),
      held: DEFAULT_PREFS,
    })
    expect(d.desk).toBe('holding')
    expect(d.tone).toBe('error')
  })

  it('a write whose fate could not be established is `unreachable`, not either answer', () => {
    const d = decideNotify({ step: 'unsure', error: new DeskError('transport', 'x') })
    expect(d.desk).toBe('unreachable')
    expect(d.tone).toBe('error')
    expect(d.message).toContain(strings().errors.desk.transport)
  })

  it('a forgotten phone is not holding, and says nothing alarming', () => {
    const d = decideNotify({ step: 'off' })
    expect(d.desk).toBe('not_holding')
    expect(d.tone).toBe(null)
    expect(d.message).toBe(null)
  })

  it('a saved change stays holding', () => {
    const d = decideNotify({ step: 'saved', prefs: DEFAULT_PREFS })
    expect(d.desk).toBe('holding')
    expect(d.tone).toBe('ok')
  })

  it('never puts the push token in anything drawn — including the desk’s own refusal', () => {
    // THE REAL LEAK, and the reason the first version of this test proved nothing: it passed a
    // bare `Error`, which `humanDeskError` answers with its `unknown` sentence, so the branch that
    // quotes the desk was never reached. `push._token` refuses a token BY QUOTING IT, and that
    // text arrives as `detail` — this is what a phone with a stale or malformed token actually
    // gets back, and it used to be drawn on screen verbatim.
    const quoted = new DeskError(
      'http',
      'push responded 400',
      400,
      'bad_push',
      `push.devices[0].token: '${TOKEN}' is not an Expo push token (ExponentPushToken[...])`,
    )
    const steps: NotifyStep[] = [
      { step: 'on', token: TOKEN, prefs: DEFAULT_PREFS },
      { step: 'saved', prefs: DEFAULT_PREFS },
      { step: 'off' },
      { step: 'denied' },
      { step: 'no_desk' },
      { step: 'unsupported' },
      { step: 'token_failed', error: quoted },
      { step: 'desk_failed', error: quoted },
      { step: 'change_failed', error: quoted, held: DEFAULT_PREFS },
      { step: 'forget_failed', error: quoted },
      { step: 'unsure', error: quoted },
    ]
    // A REAL token, meaning one with an actual payload between the brackets. The literal
    // `ExponentPushToken[...]` the desk's own refusal ends with is a statement of the SHAPE a
    // token has — it carries nothing and is worth keeping, so the assertion is about capabilities
    // rather than about the substring.
    const real = /Expo(?:nent)?PushToken\[[A-Za-z0-9_-]+\]/
    for (const s of steps) {
      const message = decideNotify(s).message ?? ''
      expect(message).not.toContain(TOKEN)
      expect(message).not.toMatch(real)
    }
    // And the desk's reason still reaches the reader, redacted rather than swallowed — the point
    // of quoting `detail` at all is that it is the only thing that says what was wrong.
    expect(decideNotify({ step: 'desk_failed', error: quoted }).message).toContain('<redacted>')
  })
})

// ---------------------------------------------------------------------------
// Turning it on, off, and changing it
// ---------------------------------------------------------------------------

describe('turnOnNotifications', () => {
  it('asks the phone for permission only at the moment the switch is touched', async () => {
    let asked = 0
    const step = await turnOnNotifications(
      deps({
        permission: async () => 'undetermined',
        request: async () => {
          asked++
          return 'granted'
        },
      }),
    )
    expect(asked).toBe(1)
    expect(step.step).toBe('on')
  })

  it('does not prompt a phone that has already granted it', async () => {
    let asked = 0
    await turnOnNotifications(
      deps({
        permission: async () => 'granted',
        request: async () => {
          asked++
          return 'granted'
        },
      }),
    )
    expect(asked).toBe(0)
  })

  it('registers the token with the desk exactly once', async () => {
    const desk = fakeDesk()
    const step = await turnOnNotifications(deps({ client: desk }))
    expect(desk.registered).toHaveLength(1)
    expect((desk.registered[0] as { token: string }).token).toBe(TOKEN)
    expect(step).toEqual({ step: 'on', token: TOKEN, prefs: DEFAULT_PREFS })
  })

  it('without a desk it prompts for nothing and calls nothing', async () => {
    // Outcome 4. A permission dialog raised for a feature that cannot work is worse than a
    // disabled switch: it spends the one prompt iOS gives, and denying it is permanent.
    let asked = 0
    let tokenFetched = 0
    const step = await turnOnNotifications(
      deps({
        client: null,
        permission: async () => {
          asked++
          return 'granted'
        },
        token: async () => {
          tokenFetched++
          return TOKEN
        },
      }),
    )
    expect(step).toEqual({ step: 'no_desk' })
    expect(asked).toBe(0)
    expect(tokenFetched).toBe(0)
  })

  it('on a platform that cannot hold a push token it asks for nothing', async () => {
    let asked = 0
    const step = await turnOnNotifications(
      deps({
        platform: null,
        permission: async () => {
          asked++
          return 'granted'
        },
      }),
    )
    expect(step).toEqual({ step: 'unsupported' })
    expect(asked).toBe(0)
  })

  it('a denied phone is a state, not a crash, and nothing is registered', async () => {
    const desk = fakeDesk()
    const step = await turnOnNotifications(
      deps({ client: desk, permission: async () => 'denied' }),
    )
    expect(step).toEqual({ step: 'denied' })
    expect(desk.registered).toHaveLength(0)
  })

  it('a prompt that comes back denied is the same state', async () => {
    const desk = fakeDesk()
    const step = await turnOnNotifications(
      deps({ client: desk, permission: async () => 'undetermined', request: async () => 'denied' }),
    )
    expect(step).toEqual({ step: 'denied' })
    expect(desk.registered).toHaveLength(0)
  })

  it('a permission call that throws is denied rather than an unhandled rejection', async () => {
    const step = await turnOnNotifications(
      deps({
        permission: async () => {
          throw new Error('no native module')
        },
      }),
    )
    expect(step).toEqual({ step: 'denied' })
  })

  it('reports the two halves apart: the token, and the desk', async () => {
    const desk = fakeDesk()
    const noToken = await turnOnNotifications(
      deps({
        client: desk,
        token: async () => {
          throw new Error('offline')
        },
      }),
    )
    expect(noToken.step).toBe('token_failed')
    expect(desk.registered).toHaveLength(0)

    const refused = await turnOnNotifications(
      deps({ client: writeRefusingDesk(new DeskError('http', 'x', 400), null) }),
    )
    expect(refused.step).toBe('desk_failed')
  })

  it('a POST that landed and lost its answer is ON, not a failure', async () => {
    // The failure this arm exists for: register over a flaky tunnel, be told it failed, and get
    // notified anyway — with the switch saying off and no way to tell why. The write throwing says
    // nothing about whether the desk committed it, so the desk is asked.
    const step = await turnOnNotifications(
      deps({ client: writeRefusingDesk(new DeskError('transport', 'x'), DEFAULT_PREFS) }),
    )
    expect(step).toEqual({ step: 'on', token: TOKEN, prefs: DEFAULT_PREFS })
    expect(decideNotify(step).desk).toBe('holding')
  })

  it('a POST whose fate cannot be established is `unsure`, and claims neither', async () => {
    const step = await turnOnNotifications(
      deps({ client: refusingDesk(new DeskError('transport', 'x')) }),
    )
    expect(step.step).toBe('unsure')
    expect(decideNotify(step).desk).toBe('unreachable')
  })
})

describe('turnOffNotifications', () => {
  it('deletes the device from the desk rather than setting a local flag', async () => {
    const desk = fakeDesk()
    const step = await turnOffNotifications({ client: desk, token: TOKEN })
    expect(step).toEqual({ step: 'off' })
    expect(desk.forgotten).toEqual([TOKEN])
  })

  it('says so when the desk would not be told, and stays holding', async () => {
    const step = await turnOffNotifications({
      client: writeRefusingDesk(new DeskError('transport', 'x'), DEFAULT_PREFS),
      token: TOKEN,
    })
    expect(step.step).toBe('forget_failed')
    expect(decideNotify(step).desk).toBe('holding')
  })

  it('a DELETE that landed and lost its answer is off, not a stuck switch', async () => {
    const step = await turnOffNotifications({
      client: writeRefusingDesk(new DeskError('transport', 'x'), null),
      token: TOKEN,
    })
    expect(step).toEqual({ step: 'off' })
  })

  it('a DELETE whose fate cannot be established is `unsure`', async () => {
    const step = await turnOffNotifications({
      client: refusingDesk(new DeskError('transport', 'x')),
      token: TOKEN,
    })
    expect(step.step).toBe('unsure')
    expect(decideNotify(step).desk).toBe('unreachable')
  })

  it('is off with nothing to delete when there is no desk or no token', async () => {
    expect(await turnOffNotifications({ client: null, token: TOKEN })).toEqual({ step: 'off' })
    expect(await turnOffNotifications({ client: fakeDesk(), token: null })).toEqual({ step: 'off' })
  })
})

describe('releaseThisPhone — before the app loses its way back to the desk', () => {
  it('takes this phone off the desk’s list', async () => {
    const desk = fakeDesk([
      {
        token: TOKEN,
        platform: 'ios',
        tz: 'Asia/Seoul',
        prefs: {},
        lead: {},
        quiet: null,
      },
    ])
    expect(await releaseThisPhone({ client: desk, token: async () => TOKEN })).toEqual({
      step: 'released',
    })
    expect(desk.forgotten).toEqual([TOKEN])
  })

  it('spends no round trip on Expo for a desk holding nobody', async () => {
    // The common case for anybody who never turned notifications on, and the household read
    // already settles it: a desk with no phones is not holding this one.
    let asked = 0
    const desk = fakeDesk()
    const step = await releaseThisPhone({
      client: desk,
      token: async () => {
        asked++
        return TOKEN
      },
    })
    expect(step).toEqual({ step: 'nothing' })
    expect(asked).toBe(0)
    expect(desk.forgotten).toHaveLength(0)
  })

  it('leaves another phone in the household alone', async () => {
    const desk = fakeDesk([
      { token: OTHER, platform: 'android', tz: 'UTC', prefs: {}, lead: {}, quiet: null },
    ])
    expect(await releaseThisPhone({ client: desk, token: async () => TOKEN })).toEqual({
      step: 'nothing',
    })
    expect(desk.forgotten).toHaveLength(0)
  })

  it('is `nothing` when there is no desk to ask', async () => {
    expect(await releaseThisPhone({ client: null, token: async () => TOKEN })).toEqual({
      step: 'nothing',
    })
  })

  it('is `unsure` when it cannot establish that the desk let go', async () => {
    // The caller must NOT proceed on this. Past it, the desk keeps the token and the app can no
    // longer authenticate to the desk that has it — there is no way back from inside the product.
    const step = await releaseThisPhone({
      client: refusingDesk(new DeskError('transport', 'x')),
      token: async () => TOKEN,
    })
    expect(step.step).toBe('unsure')
  })

  it('is `unsure` when the DELETE itself fails, rather than claiming release', async () => {
    const step = await releaseThisPhone({
      client: writeRefusingDesk(new DeskError('transport', 'x'), DEFAULT_PREFS),
      token: async () => TOKEN,
    })
    expect(step.step).toBe('unsure')
  })
})

describe('the warning belongs to the control, not to the section', () => {
  const unsure: ReleaseStep = { step: 'unsure', error: new DeskError('transport', 'x') }

  it('does not re-ask the control it has already warned about', () => {
    // The deliberate second tap. The owner has read the sentence and decided; re-asking the same
    // unreachable desk before honouring that would make the button feel broken.
    expect(shouldAttemptRelease('token', 'token')).toBe(false)
    expect(shouldAttemptRelease('address', 'address')).toBe(false)
  })

  it('THE WALK: a warning about Forget token does not silently spend Save address', () => {
    // Step by step, because this is the orphan the warning itself created and it was invisible.
    //
    // 1. Registered with desk A, tunnel down. The owner taps Forget token; the release cannot be
    //    established, so they are warned and the token is correctly NOT cleared.
    const first = decideRelease('token', null, unsure)
    expect(first.proceed).toBe(false)
    expect(first.warned).toBe('token')

    // 2. They stop. The network comes back.
    // 3. Later they tap Save address to point at desk B. THIS MUST STILL ASK. Under the shared
    //    boolean it did not: no read, no DELETE, no round trip at all — against a desk that was
    //    now reachable and would have answered.
    expect(shouldAttemptRelease('address', first.warned)).toBe(true)

    // 4. And whatever the answer, it is said. The silent arm was `nothing`, which matched neither
    //    branch of either caller, so the address was saved under a green "Saved." with not a word
    //    about the registration it had just orphaned beyond recovery.
    const released = decideRelease('address', first.warned, { step: 'released' })
    expect(released).toMatchObject({ proceed: true, tone: 'info' })
    expect(released.message).toBe(strings().settings.notify.released)
    // And the token button's own acknowledgement is untouched by the address button's answer —
    // see the test below, which is the same rule from the other side.
    expect(released.warned).toBe('token')
  })

  it('a warning about one control still stops that control, having warned once', () => {
    const decision = decideRelease('address', 'address', null)
    // It goes ahead — the owner may be leaving a desk that no longer exists, and refusing outright
    // would trap them with a credential they cannot remove.
    expect(decision.proceed).toBe(true)
    // But it says so AT THE MOMENT it does it, rather than resting on a sentence read earlier.
    expect(decision.tone).toBe('error')
    expect(decision.message).toBe(strings().settings.notify.releasedNot)
  })

  it('says nothing when there was nothing registered to take off', () => {
    const decision = decideRelease('token', null, { step: 'nothing' })
    expect(decision).toEqual({ proceed: true, tone: null, message: null, warned: null })
  })

  it('clears its OWN acknowledgement on any answer the desk actually gave', () => {
    // The control asked again and got a real answer, so its acknowledgement is spent.
    expect(decideRelease('token', 'token', { step: 'released' }).warned).toBe(null)
    expect(decideRelease('token', 'token', { step: 'nothing' }).warned).toBe(null)
  })

  it('does not spend the OTHER control’s acknowledgement', () => {
    // The third instance of one shape: an outcome that belongs to one control written as though it
    // belonged to the section. Warn the token button, then let the address button succeed — the
    // token's next tap must still be the acknowledged second tap rather than a fresh question.
    const warnedA = decideRelease('token', null, {
      step: 'unsure',
      error: new DeskError('transport', 'x'),
    })
    expect(warnedA.warned).toBe('token')

    for (const answered of [{ step: 'released' } as const, { step: 'nothing' } as const]) {
      const b = decideRelease('address', warnedA.warned, answered)
      expect(b.warned).toBe('token')
      expect(shouldAttemptRelease('token', b.warned)).toBe(false)
      // And B still says its own piece correctly — scoping the flag must not mute the message.
      expect(b.proceed).toBe(true)
    }
  })

  it('never puts the push token in what it says', () => {
    const quoted = new DeskError(
      'http',
      'push responded 400',
      400,
      'bad_push',
      `push.devices[0].token: '${TOKEN}' is not an Expo push token`,
    )
    const said = decideRelease('token', null, { step: 'unsure', error: quoted }).message ?? ''
    expect(said).not.toContain(TOKEN)
    expect(said).toContain('<redacted>')
  })
})

describe('applyNotifyPrefs', () => {
  const changed: NotifyPrefs = {
    ...DEFAULT_PREFS,
    prefs: { ...DEFAULT_PREFS.prefs, econ: false },
  }

  it('registers exactly once per change, and answers with what was sent', async () => {
    const desk = fakeDesk()
    const step = await applyNotifyPrefs({
      client: desk,
      token: TOKEN,
      platform: 'ios',
      tz: 'Asia/Seoul',
      prefs: changed,
    })
    expect(step).toEqual({ step: 'saved', prefs: changed })
    expect(desk.registered).toHaveLength(1)
    expect((desk.registered[0] as { prefs: Record<string, boolean> }).prefs.econ).toBe(false)
  })

  it('two changes are two registrations and not one merged guess', async () => {
    const desk = fakeDesk()
    const args = { client: desk, token: TOKEN, platform: 'ios' as const, tz: 'Asia/Seoul' }
    await applyNotifyPrefs({ ...args, prefs: changed })
    await applyNotifyPrefs({ ...args, prefs: DEFAULT_PREFS })
    expect(desk.registered).toHaveLength(2)
  })

  it('a refused change is its own outcome, and leaves the desk HOLDING', async () => {
    // NOT `desk_failed`. That arm is a registration that did not happen, and it draws the switch
    // off. Here the phone is registered and the desk is still sending what it held a moment ago,
    // so a switch drawn off would tell the owner notifications had stopped while they arrived.
    const step = await applyNotifyPrefs({
      client: writeRefusingDesk(
        new DeskError('http', 'x', 400, 'bad_push', 'lead.econ[0]: no'),
        DEFAULT_PREFS,
      ),
      token: TOKEN,
      platform: 'ios',
      tz: 'Asia/Seoul',
      prefs: changed,
    })
    expect(step.step).toBe('change_failed')
    expect(decideNotify(step).desk).toBe('holding')
    expect(decideNotify(step).tone).toBe('error')
  })

  it('a refused change carries what the desk turned out to actually hold', async () => {
    // A POST whose answer was lost may well have landed, and then the desk is on the NEW document
    // while the screen has reverted to the old one — the two disagreeing silently until something
    // else writes. The read settles it, and `held` is what the switches are redrawn from.
    const step = await applyNotifyPrefs({
      client: writeRefusingDesk(new DeskError('transport', 'x'), changed),
      token: TOKEN,
      platform: 'ios',
      tz: 'Asia/Seoul',
      prefs: changed,
    })
    expect(step).toMatchObject({ step: 'change_failed', held: changed })
  })

  it('a change against a desk that turns out not to hold this phone is the bigger fact', async () => {
    const step = await applyNotifyPrefs({
      client: writeRefusingDesk(new DeskError('transport', 'x'), null),
      token: TOKEN,
      platform: 'ios',
      tz: 'Asia/Seoul',
      prefs: changed,
    })
    expect(step.step).toBe('desk_failed')
    expect(decideNotify(step).desk).toBe('not_holding')
  })

  it('a change whose fate cannot be established is `unsure`', async () => {
    const step = await applyNotifyPrefs({
      client: refusingDesk(new DeskError('transport', 'x')),
      token: TOKEN,
      platform: 'ios',
      tz: 'Asia/Seoul',
      prefs: changed,
    })
    expect(step.step).toBe('unsure')
  })
})

// ---------------------------------------------------------------------------
// The rule that governs the token
// ---------------------------------------------------------------------------

describe('the push token goes to the desk and nowhere else', () => {
  it('never reaches AsyncStorage, and never reaches a log', async () => {
    const written: string[] = []
    const logged: string[] = []
    const setItem = jest.spyOn(AsyncStorage, 'setItem').mockImplementation(async (k, v) => {
      written.push(`${k}=${v}`)
    })
    const spies = (['log', 'warn', 'error', 'info', 'debug'] as const).map((name) =>
      jest.spyOn(console, name).mockImplementation((...args: unknown[]) => {
        logged.push(args.map(String).join(' '))
      }),
    )
    try {
      await turnOnNotifications(deps())
      await turnOnNotifications(deps({ client: refusingDesk(new DeskError('http', TOKEN, 400)) }))
      await turnOffNotifications({ client: fakeDesk(), token: TOKEN })
      await turnOffNotifications({
        client: refusingDesk(new DeskError('transport', TOKEN)),
        token: TOKEN,
      })
      await applyNotifyPrefs({
        client: fakeDesk(),
        token: TOKEN,
        platform: 'ios',
        tz: 'UTC',
        prefs: DEFAULT_PREFS,
      })
    } finally {
      setItem.mockRestore()
      for (const s of spies) s.mockRestore()
    }
    expect(written.join('\n')).not.toContain('ExponentPushToken')
    expect(logged.join('\n')).not.toContain('ExponentPushToken')
    expect(written).toHaveLength(0)
    expect(logged).toHaveLength(0)
  })
})

describe('the answer kind', () => {
  it('is a sixth switch beside the five calendar ones', () => {
    expect([...PUSH_KINDS]).toEqual([
      'earnings',
      'expiry',
      'dividend',
      'econ',
      'researched',
      'answer',
    ])
  })

  it('takes no lead time, because it is about something that already happened', () => {
    // A lead is "how far ahead of a date". An answer has no date ahead of it, and a lead selector
    // under this switch would be asking a question with no answer.
    expect([...LEAD_KINDS]).toEqual(['earnings', 'expiry', 'dividend', 'econ', 'researched'])
    expect(DEFAULT_LEAD.answer).toEqual([])
  })

  it('registers with an empty lead list, which the desk takes', () => {
    const body = deviceBody(TOKEN, 'ios', 'Asia/Seoul', DEFAULT_PREFS)
    expect(body.prefs.answer).toBe(true)
    expect(body.lead.answer).toEqual([])
  })
})

describe('routing a notification tap', () => {
  it('finds the command id in the push’s data', () => {
    expect(commandIdOfPush({ command_id: 'c0ffee00', result: 'answered' })).toBe('c0ffee00')
  })

  it('ignores a push carrying no command id — every calendar alert is one', () => {
    expect(commandIdOfPush({ event_id: 'evt1' })).toBeNull()
    expect(commandIdOfPush(null)).toBeNull()
    expect(commandIdOfPush({ command_id: 42 })).toBeNull()
    expect(commandIdOfPush({ command_id: '' })).toBeNull()
  })

  it('routes to the ask screen with the command as the parameter', () => {
    // The push carries a COMMAND id and the screen opens a THREAD; the lookup is the ask hook's,
    // over what it reads off disk. Routing by command id is what makes the link work on a phone
    // whose thread list was written by a different launch.
    expect(askRouteForPush({ command_id: 'c0ffee00' })).toBe('/ask?command=c0ffee00')
  })

  it('percent-encodes an id that would otherwise break the query', () => {
    expect(askRouteForPush({ command_id: 'a&b' })).toBe('/ask?command=a%26b')
  })

  it('routes nothing for a push that is not about a command', () => {
    expect(askRouteForPush({ event_id: 'evt1' })).toBeNull()
  })
})
