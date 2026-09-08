import { describe, it, expect, beforeEach, jest } from '@jest/globals'
import AsyncStorage from '@react-native-async-storage/async-storage'
import {
  DEFAULT_LEAD,
  DEFAULT_PREFS,
  DEFAULT_QUIET,
  LEADS,
  PUSH_KINDS,
  applyNotifyPrefs,
  decideNotify,
  deviceBody,
  deviceZone,
  findRegistration,
  notifyView,
  parseNotifyPrefs,
  pushPlatform,
  turnOffNotifications,
  turnOnNotifications,
  validateQuiet,
  type NotifyPrefs,
  type PushClient,
  type PushDoc,
} from './notify'
import { DeskError } from './desk'
import { setActiveLanguage, strings } from '../i18n'

// The house placeholder. It is the only push token anywhere in this repository, and it is not a
// real one: a token is a capability to write on somebody's lock screen, so a plausible-looking
// fixture is a fixture nobody can tell from the real thing in a paste.
const TOKEN = 'ExponentPushToken[0000000000AAAAAAAAAA]'
const OTHER = 'ExponentPushToken[1111111111BBBBBBBBBB]'

const EMPTY: PushDoc = { devices: [] }

/** A desk that takes everything, and records what it was asked. */
function fakeDesk(): PushClient & { registered: unknown[]; forgotten: string[] } {
  const registered: unknown[] = []
  const forgotten: string[] = []
  return {
    registered,
    forgotten,
    async pushDevices() {
      return EMPTY
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

/** A desk that refuses everything with the code the screen has to tell apart. */
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
  it('is the desk’s five, not the book’s eight', () => {
    // `push.KINDS` — the four computed kinds, and `researched` shared by the four the agent had
    // to go and find. A sixth switch here would be one the desk has nowhere to put.
    expect([...PUSH_KINDS].sort()).toEqual(['dividend', 'earnings', 'econ', 'expiry', 'researched'])
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
    registered: false,
    busy: false,
  }

  it('says nothing at all until storage and the OS have answered', () => {
    const v = notifyView({ ...base, loaded: false })
    expect(v).toEqual({ on: false, disabled: true, note: null, detail: false })
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

  it('stands blocked when the phone itself refuses notifications', () => {
    // Nothing this app does can move a denied permission, so the switch is dead rather than
    // springing back, and the note names the one place that can change it.
    const v = notifyView({ ...base, permission: 'denied' })
    expect(v).toEqual({ on: false, disabled: true, note: 'blocked', detail: false })
  })

  it('draws the kinds only once this phone is actually registered', () => {
    expect(notifyView({ ...base, registered: false }).detail).toBe(false)
    expect(notifyView({ ...base, permission: 'granted', registered: true })).toEqual({
      on: true,
      disabled: false,
      note: null,
      detail: true,
    })
  })

  it('is dead while a call is out, without losing where it stands', () => {
    const v = notifyView({ ...base, permission: 'granted', registered: true, busy: true })
    expect(v.on).toBe(true)
    expect(v.disabled).toBe(true)
  })

  it('is blocked before it is registered — a denied phone is not on', () => {
    // Both facts arrive from different places and the wrong order would draw a lit switch under
    // a sentence saying notifications are off in the phone's settings.
    const v = notifyView({ ...base, permission: 'denied', registered: true })
    expect(v.on).toBe(false)
    expect(v.note).toBe('blocked')
  })
})

describe('decideNotify — the outcome of touching the switch', () => {
  const t = () => strings().settings.notify

  it('1. granted, token fetched, desk took it → on', () => {
    const d = decideNotify({ step: 'on', token: TOKEN, prefs: DEFAULT_PREFS })
    expect(d.on).toBe(true)
    expect(d.tone).toBe('ok')
    expect(d.message).toBe(t().registered)
  })

  it('2. denied → off, a sentence, and the way to fix it', () => {
    const d = decideNotify({ step: 'denied' })
    expect(d.on).toBe(false)
    expect(d.tone).toBe('error')
    expect(d.message).toBe(t().blocked)
    expect(d.openSettings).toBe(true)
  })

  it('3. granted but the desk refused → off, and it says which half failed', () => {
    const d = decideNotify({ step: 'desk_failed', error: new DeskError('unauthorized', 'x', 401) })
    expect(d.on).toBe(false)
    expect(d.tone).toBe('error')
    // The sentence names the desk as the half that failed, and carries the desk's own reason.
    expect(d.message).toContain(strings().errors.desk.unauthorized)
    expect(d.openSettings).toBe(false)
  })

  it('3b. granted but no push token could be issued → off, and it says so', () => {
    const d = decideNotify({ step: 'token_failed', error: new Error('offline') })
    expect(d.on).toBe(false)
    expect(d.message).toBe(t().tokenFailed)
  })

  it('4. no desk → off, and the switch is not the thing to fix', () => {
    const d = decideNotify({ step: 'no_desk' })
    expect(d.on).toBe(false)
    expect(d.message).toBe(t().needsDesk)
    expect(d.openSettings).toBe(false)
  })

  it('a desk that would not forget the phone leaves the switch ON', () => {
    // The worst outcome available here is a phone that stops showing alerts while the desk goes
    // on sending them. A switch that reported off over a failed DELETE would draw exactly that.
    const d = decideNotify({ step: 'forget_failed', error: new DeskError('transport', 'x') })
    expect(d.on).toBe(true)
    expect(d.tone).toBe('error')
    expect(d.message).toContain(strings().errors.desk.transport)
  })

  it('a forgotten phone is off and says nothing alarming', () => {
    const d = decideNotify({ step: 'off' })
    expect(d.on).toBe(false)
    expect(d.tone).toBe(null)
    expect(d.message).toBe(null)
  })

  it('a saved change stays on', () => {
    const d = decideNotify({ step: 'saved', prefs: DEFAULT_PREFS })
    expect(d.on).toBe(true)
    expect(d.tone).toBe('ok')
  })

  it('never puts the push token in anything drawn', () => {
    const steps = [
      { step: 'on' as const, token: TOKEN, prefs: DEFAULT_PREFS },
      { step: 'saved' as const, prefs: DEFAULT_PREFS },
      { step: 'off' as const },
      { step: 'denied' as const },
      { step: 'no_desk' as const },
      { step: 'unsupported' as const },
      { step: 'token_failed' as const, error: new Error(TOKEN) },
      { step: 'desk_failed' as const, error: new Error(TOKEN) },
      { step: 'change_failed' as const, error: new Error(TOKEN) },
      { step: 'forget_failed' as const, error: new Error(TOKEN) },
    ]
    for (const s of steps) expect(decideNotify(s).message ?? '').not.toContain('ExponentPushToken')
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
      deps({ client: refusingDesk(new DeskError('http', 'x', 400)) }),
    )
    expect(refused.step).toBe('desk_failed')
  })
})

describe('turnOffNotifications', () => {
  it('deletes the device from the desk rather than setting a local flag', async () => {
    const desk = fakeDesk()
    const step = await turnOffNotifications({ client: desk, token: TOKEN })
    expect(step).toEqual({ step: 'off' })
    expect(desk.forgotten).toEqual([TOKEN])
  })

  it('says so when the desk would not be told, and stays on', async () => {
    const step = await turnOffNotifications({
      client: refusingDesk(new DeskError('transport', 'x')),
      token: TOKEN,
    })
    expect(step.step).toBe('forget_failed')
    expect(decideNotify(step).on).toBe(true)
  })

  it('is off with nothing to delete when there is no desk or no token', async () => {
    expect(await turnOffNotifications({ client: null, token: TOKEN })).toEqual({ step: 'off' })
    expect(await turnOffNotifications({ client: fakeDesk(), token: null })).toEqual({ step: 'off' })
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

  it('a refused change is its own outcome, and leaves the switch ON', async () => {
    // NOT `desk_failed`. That arm is a registration that did not happen, and its switch is off.
    // Here the phone is registered and the desk is still sending what it held a moment ago, so a
    // switch drawn off would tell the owner notifications had stopped while they went on arriving.
    const step = await applyNotifyPrefs({
      client: refusingDesk(new DeskError('http', 'x', 400, 'bad_push', 'lead.econ[0]: no')),
      token: TOKEN,
      platform: 'ios',
      tz: 'Asia/Seoul',
      prefs: changed,
    })
    expect(step.step).toBe('change_failed')
    expect(decideNotify(step).on).toBe(true)
    expect(decideNotify(step).tone).toBe('error')
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
