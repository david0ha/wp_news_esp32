// Being told before it happens: what this phone asks the OS for, what it registers with the desk,
// and what the Settings switch does in each of the ways that can go.
//
// THE DESK ALREADY DECIDES EVERYTHING ABOUT A NOTIFICATION. `alerts.py` works out which alerts are
// owed, `push.py` owns the device document and sends them, and `Desk.tick()` fires them. Nothing
// here schedules, times, formats or suppresses anything — this file registers a phone and edits
// the preferences the desk reads. The one rule that follows from that, and the one this module
// exists to hold: every value it sends is one the desk already validates. `push.KINDS` is five
// switches, `push.LEAD_SECONDS` is six durations, and a seventh spelling invented here would be a
// 400 the owner reads as their switch not working.
//
// **The push token is a capability.** Whoever holds it can put a line of text on the owner's lock
// screen from anywhere, with no further credential. So it travels the same road the operator token
// travels and no other: it is fetched from Expo, handed to the desk in one body or one path, and
// held in the calling component's own state for as long as that screen is up. It is never written
// to AsyncStorage, never logged, and never put in a sentence — `notify.test.ts` holds all three.
//
// **Permission is asked for at the moment the owner turns an alert on, and never at launch.** iOS
// gives an app exactly one prompt; spending it on a launch, before the owner has asked for
// anything, is spending it on a question they have no reason to say yes to — and a denial is
// permanent from the app's side. So `turnOnNotifications` is the only thing in this app that
// prompts, and it refuses to prompt at all when there is no desk to register with: a dialog for a
// feature that cannot work is worse than a switch that says why it is disabled.
//
// **Four outcomes on one switch, decided here rather than in JSX.** Granted and registered;
// denied; granted but the desk refused; no desk at all. Two of them are failures that look like
// success if the switch simply springs back, and a fifth — a desk that would not FORGET the phone —
// is the worst state available, because a phone whose switch reads off while the desk goes on
// sending is a phone whose owner has no way to make it stop. `decideNotify` is total over all of
// them and is what the component draws.

import { Platform } from 'react-native'
import Constants from 'expo-constants'
import * as Notifications from 'expo-notifications'
import { humanDeskError, type PushDeviceBody, type PushDoc } from './desk'
import { fill, strings } from '../i18n'

// The push document's own types live in `desk.ts`, beside the routes that answer them, and are
// re-exported here because this is the module anything about notifications reads. The direction is
// deliberate and one-way: `desk.ts` knows the wire and nothing about switches, this file knows the
// switches and nothing about HTTP.
export type { PushDevice, PushDoc, PushDeviceBody } from './desk'

// ---------------------------------------------------------------------------
// The vocabulary, which is the desk's
// ---------------------------------------------------------------------------

/**
 * The five switches, in the order they are drawn.
 *
 * FIVE, NOT FOUR. Four are `calendar.COMPUTED_KINDS` — a date a machine worked out — and the
 * fifth, `researched`, is shared by the book's other four kinds (`corporate`, `legal`, `index`,
 * `other`), the ones somebody had to go and find. `push.pref_for` is where that mapping lives and
 * this app does not re-derive it: nothing here ever sees an event's kind, only the switch it
 * answers to, so there is no second place for the two to disagree.
 *
 * The order is editorial rather than the desk's alphabetical one: the two dates an owner marks in
 * a diary first, then the two a calendar generates, then everything a morning's research turned up.
 */
export const PUSH_KINDS = ['earnings', 'expiry', 'dividend', 'econ', 'researched'] as const
export type PushKind = (typeof PUSH_KINDS)[number]

/**
 * The six lead times, longest first — the order the desk stores them in and the order they fire.
 *
 * A closed table on both sides. `push.LEAD_SECONDS` is six values because a general duration
 * parser is a few hundred lines of surface for a feature that needs six, and this list is the same
 * six spelled the same way so that a chip in the UI cannot offer one the desk will refuse.
 */
export const LEADS = ['P7D', 'P2D', 'P1D', 'PT12H', 'PT3H', 'PT1H'] as const
export type Lead = (typeof LEADS)[number]

/** For ordering only. The desk does the arithmetic; this decides which chip comes first. */
const LEAD_SECONDS: Record<Lead, number> = {
  P7D: 7 * 86400,
  P2D: 2 * 86400,
  P1D: 86400,
  PT12H: 12 * 3600,
  PT3H: 3 * 3600,
  PT1H: 3600,
}

/**
 * `push.DEFAULT_LEAD`, spelled again here because it is what a phone registering for the first
 * time SENDS, not what it receives. The desk would supply these for an omitted kind either way;
 * sending them means the switches the owner sees on the first draw are the ones actually in force,
 * rather than blank chips under a document whose defaults the phone had to guess at.
 */
export const DEFAULT_LEAD: Record<PushKind, Lead[]> = {
  earnings: ['P1D'],
  // Twice, because an expiry is the one date with nothing to react to afterwards.
  expiry: ['P7D', 'P1D'],
  dividend: ['P1D'],
  // Three hours: a day's notice of a number nobody can act on is noise.
  econ: ['PT3H'],
  researched: ['P1D'],
}

/** A window in which nothing is delivered. May wrap midnight — 23:00 to 07:00 is the ordinary one. */
export interface QuietHours {
  from: string
  to: string
}

/** Everything about this phone that the desk reads when it decides whether to send. */
export interface NotifyPrefs {
  prefs: Record<PushKind, boolean>
  lead: Record<PushKind, Lead[]>
  /** `null` for none, which is the default — see `DEFAULT_QUIET` for why it is not a window. */
  quiet: QuietHours | null
}

/**
 * What a phone registering for the first time asks for: everything on, the desk's own leads, and
 * NO quiet hours.
 *
 * Quiet hours default to off deliberately. The desk's handling of a window is not suppression —
 * an alert whose lead falls inside one is *deferred* to the moment it lifts, and an event that
 * happened inside one is delivered afterwards marked as already past. All of that is right, and
 * all of it is a degradation: the alert arrives later than the lead time the owner chose, and
 * sometimes after the thing it was warning about. Turning that on for everybody without asking
 * would mean the first thing this feature does out of the box is quietly make itself late. So it
 * is a switch the owner turns on, and `DEFAULT_QUIET` is only where the two fields start once
 * they do.
 */
export const DEFAULT_PREFS: NotifyPrefs = {
  prefs: { earnings: true, expiry: true, dividend: true, econ: true, researched: true },
  lead: DEFAULT_LEAD,
  quiet: null,
}

/** Where the two fields start when quiet hours are switched on. Not a default — see above. */
export const DEFAULT_QUIET: QuietHours = { from: '22:00', to: '07:00' }

/** The two platforms `push.PLATFORMS` accepts. */
export type PushPlatform = 'ios' | 'android'

/** What the OS says about notifications, flattened to the three answers this screen acts on. */
export type PermissionState = 'granted' | 'denied' | 'undetermined'

/**
 * Only the three methods this file needs, so a test can hand it a fake and so nothing here can
 * reach a route it was not given — the shape `NewsUrlSyncClient` already uses for the board.
 */
export type PushClient = {
  pushDevices(): Promise<PushDoc>
  registerPushDevice(body: PushDeviceBody): Promise<PushDoc>
  forgetPushDevice(token: string): Promise<void>
}

// ---------------------------------------------------------------------------
// Reading the desk's document
// ---------------------------------------------------------------------------

const HHMM = /^([01][0-9]|2[0-3]):[0-5][0-9]$/

function isLead(v: unknown): v is Lead {
  return typeof v === 'string' && (LEADS as readonly string[]).includes(v)
}

/**
 * This phone's entry in the desk's household, narrowed to the switches this app draws.
 *
 * AN ABSENT SWITCH IS ON, which is the desk's rule and not a convenience: `push._prefs` answers
 * with every switch present regardless of what arrived, so the phone never has to tell "off" from
 * "not mentioned". This function holds the same rule for the one case the desk cannot — a document
 * written by a release that did not have a kind this one draws.
 *
 * AN ABSENT LEAD LIST AND AN EMPTY ONE ARE DIFFERENT, and this is the only place in the document
 * where they are. Absence takes the default, because a device that has said nothing wants to be
 * told something; emptiness takes nothing, because an owner who cleared every chip for a kind has
 * to be able to say so without the desk putting them back.
 */
export function parseNotifyPrefs(device: {
  prefs?: Record<string, boolean>
  lead?: Record<string, string[]>
  quiet?: { from: string; to: string } | null
}): NotifyPrefs {
  const prefs = {} as Record<PushKind, boolean>
  const lead = {} as Record<PushKind, Lead[]>
  for (const kind of PUSH_KINDS) {
    prefs[kind] = device.prefs?.[kind] !== false
    const raw = device.lead?.[kind]
    lead[kind] = Array.isArray(raw)
      ? raw.filter(isLead).sort((a, b) => LEAD_SECONDS[b] - LEAD_SECONDS[a])
      : [...DEFAULT_LEAD[kind]]
  }
  const q = device.quiet
  const quiet =
    q && typeof q === 'object' && HHMM.test(q.from ?? '') && HHMM.test(q.to ?? '') && q.from !== q.to
      ? { from: q.from, to: q.to }
      : null
  return { prefs, lead, quiet }
}

/**
 * This phone among the household, by its own token, or `null` for a phone the desk has not heard
 * of. The token is compared, never parsed — it is opaque, and it is what the desk's own join and
 * pruning match on.
 */
export function findRegistration(doc: PushDoc, token: string): NotifyPrefs | null {
  const mine = doc.devices.find((d) => d.token === token)
  return mine ? parseNotifyPrefs(mine) : null
}

/**
 * One device, as `POST /api/push/devices` takes it.
 *
 * Built field by field and never forwarded from a read. `push._no_extra_keys` refuses the whole
 * document over one key it does not know, and a GET's entry carries `last_seen` — which the desk
 * stamps itself — so echoing one back is a 400 the owner would read as their switch not working.
 * `quiet` is OMITTED rather than sent as null when there is none, matching what the desk writes.
 */
export function deviceBody(
  token: string,
  platform: PushPlatform,
  tz: string,
  prefs: NotifyPrefs,
): PushDeviceBody {
  const body: PushDeviceBody = {
    token,
    platform,
    tz,
    prefs: { ...prefs.prefs },
    lead: Object.fromEntries(PUSH_KINDS.map((k) => [k, [...prefs.lead[k]]])),
  }
  if (prefs.quiet) body.quiet = { ...prefs.quiet }
  return body
}

/**
 * A quiet window the desk will take, or why it will not.
 *
 * Both refusals are the desk's own, checked here so the sentence lands under the field the owner
 * just typed in rather than after a round trip. `same` is the interesting one: a window whose ends
 * are the same minute is either no quiet hours at all or every hour of the day, and nothing
 * downstream can tell which was meant.
 */
export type QuietOutcome = { ok: true; quiet: QuietHours } | { ok: false; reason: 'shape' | 'same' }

export function validateQuiet(from: string, to: string): QuietOutcome {
  const a = from.trim()
  const b = to.trim()
  if (!HHMM.test(a) || !HHMM.test(b)) return { ok: false, reason: 'shape' }
  if (a === b) return { ok: false, reason: 'same' }
  return { ok: true, quiet: { from: a, to: b } }
}

/** The platform, or `null` for a build that cannot hold a push token at all — the web bundle. */
export function pushPlatform(os: string): PushPlatform | null {
  return os === 'ios' || os === 'android' ? os : null
}

/**
 * The phone's IANA zone, or UTC.
 *
 * `push._tz` REQUIRES a zone it can resolve and refuses the document without one, because a zone
 * is what turns "23:00" into an instant — guessing wrong puts a Seoul phone's quiet hours nine
 * hours out. UTC is the fallback rather than a refusal because a phone whose runtime has no `Intl`
 * still deserves its alerts; what it loses is quiet hours landing on its own clock, and the owner
 * can see the window it set is not the window it gets.
 */
export function deviceZone(resolved: string | undefined): string {
  return resolved && resolved.length > 0 ? resolved : 'UTC'
}

// ---------------------------------------------------------------------------
// What the section draws
// ---------------------------------------------------------------------------

export type NotifyNote = 'needs_desk' | 'unsupported' | 'blocked' | null

export interface NotifyView {
  /** Where the master switch stands. */
  on: boolean
  /** It cannot be moved. */
  disabled: boolean
  /** The standing line under it, when there is one. */
  note: NotifyNote
  /** The kinds, their lead times and quiet hours are drawn. */
  detail: boolean
}

/**
 * The master switch and what stands under it, from the four facts that decide it.
 *
 * The order of the arms is the whole function. `loaded` first, because every sentence below is a
 * claim about a phone that has not answered yet — the same rule the Board card's "No board set up
 * on this phone." follows. Then the two facts nothing on this screen can change: a build that
 * cannot hold a push token, and a phone whose own settings refuse notifications. Then the desk,
 * which the section above CAN fix. `registered` is last because it is the only one that is a
 * statement about the desk's document rather than about this phone.
 *
 * A DENIED PHONE GETS A DEAD SWITCH, not one that springs back. Nothing this app does can move a
 * denied permission — iOS gives one prompt and it is spent — so a live switch there is an offer to
 * do something that cannot happen, and the second tap teaches the owner the app is broken. The
 * note names the one place that can change it, and the section draws the button that opens it.
 */
export function notifyView(input: {
  /** Storage and the OS have both answered. */
  loaded: boolean
  /** A desk address and an operator token are both saved on this phone. */
  ready: boolean
  /** This build can be issued a push token. */
  supported: boolean
  permission: PermissionState | null
  /** The desk holds this phone's token. */
  registered: boolean
  /** A call is out. */
  busy: boolean
}): NotifyView {
  if (!input.loaded) return { on: false, disabled: true, note: null, detail: false }
  if (!input.supported) return { on: false, disabled: true, note: 'unsupported', detail: false }
  if (input.permission === 'denied') {
    return { on: false, disabled: true, note: 'blocked', detail: false }
  }
  if (!input.ready) return { on: false, disabled: true, note: 'needs_desk', detail: false }
  return {
    on: input.registered,
    disabled: input.busy,
    note: null,
    detail: input.registered,
  }
}

// ---------------------------------------------------------------------------
// The outcomes
// ---------------------------------------------------------------------------

/**
 * Every way touching this switch can end. One union across turning on, turning off and changing a
 * preference, because they all land on the same switch and the same line of copy under it, and
 * three unions would be three chances to draw one of them as another.
 */
export type NotifyStep =
  /** No desk address, no operator token, or both. Nothing was asked of the OS. */
  | { step: 'no_desk' }
  /** A build that cannot be issued a push token. Nothing was asked of the OS. */
  | { step: 'unsupported' }
  /** The phone will not allow notifications — either already, or after the one prompt. */
  | { step: 'denied' }
  /** Allowed, but Expo would not issue a token. Half one of two, and the half that can be retried. */
  | { step: 'token_failed'; error: unknown }
  /** Allowed, token in hand, and the desk refused the REGISTRATION. Half two. */
  | { step: 'desk_failed'; error: unknown }
  /**
   * The desk refused a preference CHANGE, which is a different fact about the same call: the phone
   * is still registered and the desk is still holding — and sending on — whatever it held before.
   * Sharing `desk_failed`'s arm would draw a registered phone's switch as off, and the owner would
   * be told notifications are off while they went on arriving.
   */
  | { step: 'change_failed'; error: unknown }
  /** Registered. The token is here for the caller to hold in state — never for a sentence. */
  | { step: 'on'; token: string; prefs: NotifyPrefs }
  /** The desk no longer holds this phone. */
  | { step: 'off' }
  /** The desk was not told to stop, and therefore has not stopped. */
  | { step: 'forget_failed'; error: unknown }
  /** A preference change the desk took. */
  | { step: 'saved'; prefs: NotifyPrefs }

export interface NotifyDecision {
  /** Where the master switch stands afterwards. */
  on: boolean
  /** The voice the sentence is said in, or none at all. */
  tone: 'ok' | 'info' | 'error' | null
  message: string | null
  /** Offer the button that opens the phone's own notification settings. */
  openSettings: boolean
}

/**
 * What a touch of the switch came to.
 *
 * TWO ARMS ARE THE POINT OF THIS FUNCTION, and both of them are failures that a switch springing
 * back would draw as the same shrug:
 *
 *   - `desk_failed` — the phone said yes and the desk said no. The owner is told which half
 *     failed, with the desk's own reason, because "notifications didn't turn on" sends somebody to
 *     the phone's settings to fix a token that is perfectly fine.
 *   - `forget_failed` — the switch STAYS ON. The desk still holds this phone and will still send
 *     to it, and a switch reporting off over that is the one state in this feature with no way out:
 *     alerts keep arriving from a feature the owner has been shown is off.
 */
export function decideNotify(step: NotifyStep): NotifyDecision {
  // The catalogue is read inside the call, like every other sentence table in `lib/`: this module
  // is imported at startup, before a language has been resolved.
  const m = strings().settings.notify
  switch (step.step) {
    case 'on':
      return { on: true, tone: 'ok', message: m.registered, openSettings: false }
    case 'saved':
      return { on: true, tone: 'ok', message: m.saved, openSettings: false }
    case 'off':
      // Nothing to say. The switch moving is the whole of the news, and a green "turned off" under
      // it would be the app congratulating somebody for leaving.
      return { on: false, tone: null, message: null, openSettings: false }
    case 'no_desk':
      return { on: false, tone: 'info', message: m.needsDesk, openSettings: false }
    case 'unsupported':
      return { on: false, tone: 'info', message: m.unsupported, openSettings: false }
    case 'denied':
      return { on: false, tone: 'error', message: m.blocked, openSettings: true }
    case 'token_failed':
      // Deliberately NOT `humanDeskError`: nothing here reached the desk. Expo's own message is
      // the one thing that could go in the sentence and it is a library's prose about a token,
      // which is exactly the string this feature must not draw.
      return { on: false, tone: 'error', message: m.tokenFailed, openSettings: false }
    case 'desk_failed':
      return {
        on: false,
        tone: 'error',
        message: fill(m.deskFailed, { detail: humanDeskError(step.error) }),
        openSettings: false,
      }
    case 'change_failed':
      // ON, because the phone is still registered. Only the change was refused, and the desk is
      // still sending exactly what it was sending a moment ago.
      return {
        on: true,
        tone: 'error',
        message: fill(m.changeFailed, { detail: humanDeskError(step.error) }),
        openSettings: false,
      }
    case 'forget_failed':
      return {
        on: true,
        tone: 'error',
        message: fill(m.forgetFailed, { detail: humanDeskError(step.error) }),
        openSettings: false,
      }
  }
}

// ---------------------------------------------------------------------------
// Doing it
// ---------------------------------------------------------------------------

export interface EnableDeps {
  /** The desk, or `null` when this phone holds no address and no operator token. */
  client: PushClient | null
  /** `null` for a build that cannot be issued a push token. */
  platform: PushPlatform | null
  tz: string
  /** What the OS says now. Must not prompt. */
  permission: () => Promise<PermissionState>
  /** Prompt. Called only when the answer above was `undetermined`. */
  request: () => Promise<PermissionState>
  /** This install's Expo push token. */
  token: () => Promise<string>
  /** What to register with — the desk's document as this phone wants it. */
  prefs: NotifyPrefs
}

/**
 * Turn it on, in the order that makes each refusal cost the least.
 *
 * The desk and the platform are checked FIRST, before the OS is asked anything at all. Both are
 * facts this app already knows, and a permission dialog raised in front of somebody who has no
 * desk spends the single prompt iOS grants on a feature that cannot work — after which the switch
 * is dead for good, and turning it on later means a trip through the phone's own settings. The
 * two cheap checks buy that back.
 *
 * Nothing here throws. Every arm of `NotifyStep` is a state the screen draws, including the two
 * that arrive as exceptions from somebody else's library.
 */
export async function turnOnNotifications(deps: EnableDeps): Promise<NotifyStep> {
  if (!deps.client) return { step: 'no_desk' }
  if (!deps.platform) return { step: 'unsupported' }

  let state: PermissionState
  try {
    state = await deps.permission()
    // The one prompt, and only from here. A phone that has already answered is not asked again:
    // `requestPermissionsAsync` on a denied phone returns denied without showing anything, which
    // would look to the owner like a switch that does nothing at all.
    if (state === 'undetermined') state = await deps.request()
  } catch {
    // A permissions module that throws is a phone that will not deliver a notification, which is
    // the same fact as a denial to everybody upstream of here. It is not logged: the message is
    // written by a library quoting whatever it was handed.
    return { step: 'denied' }
  }
  if (state !== 'granted') return { step: 'denied' }

  let token: string
  try {
    token = await deps.token()
  } catch (error) {
    return { step: 'token_failed', error }
  }

  try {
    await deps.client.registerPushDevice(deviceBody(token, deps.platform, deps.tz, deps.prefs))
  } catch (error) {
    return { step: 'desk_failed', error }
  }
  return { step: 'on', token, prefs: deps.prefs }
}

/**
 * Turn it off, which means DELETING THE DEVICE FROM THE DESK and not setting a flag on the phone.
 *
 * The desk is the only thing that sends. A phone that stopped showing the switch as on while the
 * desk went on sending to it would be a phone whose owner has been told the feature is off and is
 * still being woken by it — the worst outcome this feature has, and the only one that cannot be
 * escaped from inside the app.
 *
 * Nothing to delete is `off` rather than a failure: no desk to ask, or no token to ask about, both
 * mean the desk is not holding this phone under any name this app knows.
 */
export async function turnOffNotifications(deps: {
  client: PushClient | null
  token: string | null
}): Promise<NotifyStep> {
  if (!deps.client || !deps.token) return { step: 'off' }
  try {
    await deps.client.forgetPushDevice(deps.token)
  } catch (error) {
    return { step: 'forget_failed', error }
  }
  return { step: 'off' }
}

/**
 * Put a changed preference document in force. One POST per change and no batching.
 *
 * The desk replaces the entry carrying this token rather than appending, so this is the same call
 * that registered the phone — which is what makes a change idempotent and what makes a failed one
 * leave the desk holding exactly what it held before. The switch does not move on a failure: the
 * document in force is still the old one, and drawing the new one would be the app agreeing with
 * a change the desk refused.
 */
export async function applyNotifyPrefs(deps: {
  client: PushClient | null
  token: string | null
  platform: PushPlatform | null
  tz: string
  prefs: NotifyPrefs
}): Promise<NotifyStep> {
  if (!deps.client || !deps.token || !deps.platform) return { step: 'no_desk' }
  try {
    await deps.client.registerPushDevice(
      deviceBody(deps.token, deps.platform, deps.tz, deps.prefs),
    )
  } catch (error) {
    return { step: 'change_failed', error }
  }
  return { step: 'saved', prefs: deps.prefs }
}

// ---------------------------------------------------------------------------
// The phone itself
// ---------------------------------------------------------------------------
//
// The three wrappers below are the ONLY place this app touches `expo-notifications`, and they are
// deliberately thin: each one turns a library's answer into a value the pure half above already
// knows how to reason about, and none of them decides anything. Keeping them here rather than in
// the screen is what lets `turnOnNotifications` be driven by fakes in a test — the app has no way
// to render a screen under test, so a decision that lived in one would be argued only in prose.

/**
 * What the OS says about notifications right now, WITHOUT prompting.
 *
 * Provisional counts as granted, which is the library's own documented reading: a provisionally
 * authorised app can be issued a token and its notifications are delivered, quietly. Reading it as
 * "not yet asked" would prompt somebody who has already been asked in the only way iOS asked them.
 *
 * `canAskAgain` is what separates the other two. A phone that can still be asked is undetermined;
 * one that cannot has answered, and the answer was no.
 */
export async function readPermission(): Promise<PermissionState> {
  const status = await Notifications.getPermissionsAsync()
  return flatten(status)
}

/** The one prompt. Called only from `turnOnNotifications`, and only when nothing has been asked. */
export async function askPermission(): Promise<PermissionState> {
  const status = await Notifications.requestPermissionsAsync({
    ios: { allowAlert: true, allowBadge: true, allowSound: true },
  })
  return flatten(status)
}

function flatten(status: Notifications.NotificationPermissionsStatus): PermissionState {
  const granted =
    status.granted || status.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL
  if (granted) return 'granted'
  return status.canAskAgain ? 'undetermined' : 'denied'
}

/**
 * This install's Expo push token.
 *
 * The `projectId` is passed explicitly rather than left to be discovered: a build that cannot find
 * it fails here with a message about configuration, where the alternative is a token issued
 * against the wrong project — which registers perfectly, and rings for nobody.
 *
 * The Android channel is created first because a notification without one is dropped by the OS on
 * Android 8 and later, and the desk sends no `channelId` — so what arrives is bound for the
 * default channel, and this is what makes sure there is one.
 */
export async function fetchPushToken(): Promise<string> {
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('default', {
      name: 'default',
      importance: Notifications.AndroidImportance.DEFAULT,
    })
  }
  const projectId = Constants.expoConfig?.extra?.eas?.projectId as string | undefined
  const token = await Notifications.getExpoPushTokenAsync(
    projectId ? { projectId } : undefined,
  )
  return token.data
}

/**
 * The phone's own IANA zone.
 *
 * `Intl` is present on every runtime this app ships to, and is wrapped anyway: a `try` around a
 * lookup is cheaper than a section of Settings that throws on a phone whose runtime was built
 * without it, and `deviceZone` already has the honest fallback.
 */
export function phoneZone(): string {
  try {
    return deviceZone(Intl.DateTimeFormat().resolvedOptions().timeZone)
  } catch {
    return deviceZone(undefined)
  }
}
