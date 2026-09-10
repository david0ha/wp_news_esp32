import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native'
import { useFocusEffect, useRouter } from 'expo-router'
import { Screen } from '../../components/Screen'
import { Button } from '../../components/Button'
import { Card } from '../../components/Card'
import { Chip } from '../../components/Chip'
import { InfoRow } from '../../components/InfoRow'
import { SegmentedControl } from '../../components/SegmentedControl'
import { useDevice } from '../../lib/device'
import { humanError, type DeviceInfo, type DeviceState } from '../../lib/esp32'
import { DEFAULT_HOST, discoverDevice, normalizeBaseUrl } from '../../lib/discovery'
import {
  clearNewsUrlPending,
  deskScheme,
  getDeskBaseUrl,
  getDeviceBaseUrl,
  getNewsUrl,
  isNewsUrlPending,
  saveDeskBaseUrl,
  saveNewsUrl,
} from '../../lib/store'
import {
  createDeskClient,
  deskLanguageView,
  EDITION_LANGUAGES,
  humanDeskError,
} from '../../lib/desk'
import { clearDeskToken, getDeskToken, saveDeskToken } from '../../lib/deskToken'
import {
  applyNotifyPrefs,
  askPermission,
  decideNotify,
  decideRelease,
  DEFAULT_PREFS,
  DEFAULT_QUIET,
  fetchPushToken,
  findRegistration,
  LEAD_KINDS,
  LEADS,
  notifyView,
  phoneZone,
  PUSH_KINDS,
  pushPlatform,
  readPermission,
  releaseThisPhone,
  shouldAttemptRelease,
  turnOffNotifications,
  turnOnNotifications,
  validateQuiet,
  type DeskAnswer,
  type Lead,
  type NotifyPrefs,
  type NotifyStep,
  type PermissionState,
  type ReleaseControl,
} from '../../lib/notify'
import {
  decideNewsUrlSave,
  settleNewsUrlSync,
  syncPendingNewsUrl,
  type NewsUrlSaveDecision,
  type NewsUrlSaveOutcome,
} from '../../lib/newsurlsync'
import { wizardEntryHref } from '../../onboarding/flow'
import { validateNewsUrl, newsUrlErrorMessage } from '../../lib/newsurl'
import { probeEdition } from '../../lib/edition/probe'
import { editionUrl, isDerived } from '../../lib/edition/source'
import { fetchResultLabel, fetchResultMessage, formatAge, formatInterval } from '../../lib/format'
import { APP_LANGUAGES, fill, useLanguage, useStrings, type AppLanguage } from '../../i18n'
import { colors, fonts, layout, radius, space, type } from '../../theme'

export default function Settings() {
  const router = useRouter()
  const { client, baseUrl, hasDevice, setBaseUrl, forgetBoard } = useDevice()
  const s = useStrings()

  const [info, setInfo] = useState<DeviceInfo | null>(null)
  const [infoError, setInfoError] = useState(false)
  const [host, setHost] = useState('')
  const [hostError, setHostError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  // The board's own view of its source — the URL it is actually using and how the last poll went.
  // Unlike a write-only secret, the URL is plain text the board echoes back, so the editor below
  // can be prefilled with it and the user can see what they are changing.
  const [source, setSource] = useState<DeviceState['source'] | null>(null)

  // The phone's own copy of the address, and whether the board has been told. The board is asleep
  // most of the time by design, so the phone's copy is the setting and the board's is a mirror
  // that catches up; while it has not, the editor shows this copy rather than the board's, and
  // says so underneath.
  const [localUrl, setLocalUrl] = useState<string | null>(null)
  const [pendingSync, setPendingSync] = useState(false)
  // Set when a delivery made from this screen's own focus load was refused by the board — the
  // address the phone holds is one the board will not take, and nothing else on screen would say
  // so. Cleared by the next save, which is the only act that can change the address.
  const [syncRejected, setSyncRejected] = useState<string | null>(null)

  const loadLocal = useCallback(async () => {
    const [url, pending] = await Promise.all([getNewsUrl(), isNewsUrlPending()])
    setLocalUrl(url)
    setPendingSync(pending)
  }, [])

  // The desk's address and the operator token, read once and held HERE rather than inside the
  // section that edits them. TWO sections depend on them now: the desk's own, and Notifications,
  // which cannot register a phone without both. Left inside `DeskSection` they would be invisible
  // to the second — and the commonest first run of this feature is exactly the order that breaks:
  // paste the address, paste the token, scroll down, turn notifications on. The Notifications
  // section would still be holding the nulls it read on mount and would say "add the desk's
  // address" to somebody who had just added it two rows above.
  const [deskAddress, setDeskAddress] = useState<string | null>(null)
  const [deskToken, setDeskToken] = useState<string | null>(null)
  const [deskLoaded, setDeskLoaded] = useState(false)

  useEffect(() => {
    let active = true
    void (async () => {
      const [saved, held] = await Promise.all([getDeskBaseUrl(), getDeskToken()])
      if (!active) return
      setDeskAddress(saved)
      setDeskToken(held)
      setDeskLoaded(true)
    })()
    return () => {
      active = false
    }
  }, [])

  // Reconnect ("find board") UI state.
  const [reconnecting, setReconnecting] = useState(false)
  const [reconnectMsg, setReconnectMsg] = useState<string | null>(null)

  // Set only when the removal itself failed, so the one thing the user cannot see — that the key
  // survived on disk and the board will be back next launch — gets said out loud.
  const [forgetFailed, setForgetFailed] = useState(false)

  const forget = useCallback(async () => {
    setForgetFailed(!(await forgetBoard()))
  }, [forgetBoard])

  // Pre-fill the host field with the current base URL (sans scheme, for friendlier editing).
  //
  // The effect has to be *total* over `baseUrl`, including the null arm, because it is the only
  // thing that reflects a **cleared** board back into this field. "Forget this board" empties
  // storage and the provider, and every other part of this screen notices at once — the Board card
  // drops to "No board set up on this phone.", the poll rows under News source go (they read
  // `source`, which only a board sets), the Forget button itself goes. The old `if (baseUrl)` guard
  // left exactly one survivor: the Connection input, still
  // showing 192.168.0.42 a few rows above a Save button that would hand it straight back to
  // `setBaseUrl`. A stale prefill next to a Save button is not a cosmetic leftover, it is an offer
  // to undo a deliberate act, and the undo is one Return key away with no confirmation between.
  //
  // `hostError` goes in both arms, because it only ever describes the text that was in the field
  // and the effect has just replaced that text: an "isn't a valid IP address" line under a freshly
  // filled-in address (from Find board, say) is an accusation aimed at characters nobody can see
  // any more. `saved` is cleared only on the null arm, and the asymmetry is deliberate rather than
  // an oversight — `applyHost` sets it *after* awaiting `setBaseUrl`, so this effect runs on the
  // resulting `baseUrl` change immediately afterwards, and clearing it unconditionally would delete
  // the "Saved." confirmation of the save that had just succeeded, but only when the address
  // actually changed. Losing a board is the transition that has to reset the section; saving is the
  // one that has to be allowed to say so.
  //
  // The null arm has to clear *everything else this screen learned from that board*, for the same
  // reason and by the same argument. This is a persistent tab: it mounts once and is never
  // unmounted, so its local state outlives the board it describes. The old `reonboard()` navigated
  // away, which is why none of this was reachable before. `reconnectMsg` is the visible one — "Found
  // your board at 192.168.0.42." sitting two rows under "No board set up on this phone.", naming
  // the hardware the user has just disowned — but `info` and `source` are the same fact and feed
  // rows above it. Anything derived from a board must go when the board does.
  useEffect(() => {
    setHostError(null)
    if (baseUrl) {
      setHost(baseUrl.replace(/^https?:\/\//, ''))
      return
    }
    setHost('')
    setSaved(false)
    setReconnectMsg(null)
    setInfo(null)
    setInfoError(false)
    setSource(null)
  }, [baseUrl])

  const loadInfo = useCallback(async () => {
    loadLocal()
    if (!client) return
    setInfoError(false)
    try {
      setInfo(await client.getInfo())
    } catch {
      setInfoError(true)
    }
    // Best-effort: also pull the configured source so the editor below reflects the board.
    try {
      setSource((await client.getState()).source)
    } catch {
      // leave the last-known value; the section just shows "unknown" until a state read succeeds
      return
    }
    // The board answered, so it is awake: deliver an address it was not awake for when it was
    // saved. On `sent` the rows above still describe the old address, so read once more and drop
    // the pending note — both best-effort, since the delivery itself is already done. On
    // `rejected` the mark is already cleared (the sync does that, so no poll retries a doomed
    // address); what is left to do is say so, in red, because from here on the editor will show
    // the board's address and the one the user saved would otherwise just vanish.
    const delivered = await syncPendingNewsUrl(client)
    if (delivered.status === 'sent') {
      loadLocal()
      try {
        setSource((await client.getState()).source)
      } catch {
        // the next focus shows it
      }
    } else if (delivered.status === 'rejected') {
      setSyncRejected(humanError(delivered.error))
      loadLocal()
    }
  }, [client, loadLocal])

  // As a persistent tab this screen mounts once, so a mount-only effect would show the first
  // visit's snapshot forever. Re-fetch on every focus (as the Board tab does) so the board card,
  // the source rows and the URL editor's prefill reflect the board as it is now.
  useFocusEffect(
    useCallback(() => {
      loadInfo()
    }, [loadInfo]),
  )

  // Re-probe the LAN for the board (its reported IP, the saved address, the mDNS name) and persist
  // whichever answers. Used after the user rejoins their home Wi-Fi or the board's lease changes.
  const reconnect = useCallback(async () => {
    setReconnecting(true)
    setReconnectMsg(null)
    try {
      const savedUrl = await getDeviceBaseUrl()
      const found = await discoverDevice([info?.ip, savedUrl, `http://${DEFAULT_HOST}`])
      if (found) {
        await setBaseUrl(found)
        setReconnectMsg(fill(s.settings.connection.found, { host: found.replace(/^https?:\/\//, '') }))
        loadInfo()
      } else {
        setReconnectMsg(s.settings.connection.notFound)
      }
    } finally {
      setReconnecting(false)
    }
  }, [info?.ip, setBaseUrl, loadInfo, s])

  const applyHost = async () => {
    setSaved(false)
    const norm = normalizeBaseUrl(host)
    if (!norm.ok) {
      setHostError(s.settings.connection.invalidHost)
      return
    }
    setHostError(null)
    const ok = await setBaseUrl(host)
    if (ok) {
      setSaved(true)
      loadInfo()
    }
  }

  return (
    <Screen edges={['top']}>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.titleRow}>
          <Text style={styles.title}>{s.settings.title}</Text>
        </View>

        <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
          {/* Board identity */}
          <Section title={s.settings.sections.board}>
            <Card style={styles.infoCard}>
              {/*
                `hasDevice === false`, never `!hasDevice`. The third value is `null` — storage has
                not answered yet — and collapsing it into false here would say "No board set up on
                this phone." to every board owner for the frame before AsyncStorage replies. That
                is the one sentence on this screen that must never be said on a guess, so unknown
                keeps today's em-dash shell: the rows a board would fill, empty, which is exactly
                what this card has always looked like while `loadInfo` was still in flight.

                The branch also sits *above* `infoError`, which is ordering rather than accident.
                "Couldn't reach the board" is a claim about a board; said to somebody who owns none
                it accuses hardware that does not exist. And the flag outlives its board — forget
                one that was already unreachable and `infoError` is still true — so the no-board
                line has to win rather than merely be reachable.
              */}
              {hasDevice === false ? (
                <Text style={styles.noBoard}>{s.settings.board.none}</Text>
              ) : infoError ? (
                <Pressable onPress={loadInfo} accessibilityRole="button" style={styles.infoRetry}>
                  <Text style={styles.infoRetryText}>{s.settings.board.unreachable}</Text>
                </Pressable>
              ) : (
                <>
                  <InfoRow label={s.settings.board.model} value={info?.model || '—'} />
                  <InfoRow label={s.settings.board.firmware} value={info?.fw || '—'} />
                  <InfoRow label={s.settings.board.deviceId} value={info?.deviceId || '—'} />
                  <InfoRow
                    label={s.settings.board.ip}
                    value={info?.ip || baseUrl?.replace(/^https?:\/\//, '') || '—'}
                    last
                  />
                </>
              )}
            </Card>
          </Section>

          {/*
            The news snapshot URL — the one setting that decides what the phone and the board
            show. It is the PHONE's setting (`store.ts`, `newsurlsync.ts`), with the board as a
            subscriber that catches up when it is awake, and since the Today tab reads the same
            address directly it is now a setting that does something with no board at all. So the
            section no longer hides itself without one: hiding it used to be right when the URL
            was only ever a thing to POST at hardware, and it is wrong now that the phone is a
            reader too.

            What stays gated is everything that describes a BOARD's polling — Last poll, Last
            success, Polls. Those come from `source`, which is only ever set from a board's
            getState(), so they are absent without one for free rather than by a second branch.

            What the editor shows is whichever copy is the truth right now. The board echoes its
            URL back, and whenever nothing is pending that is the address in force. While a save
            is waiting for the board, the phone's copy is what the user asked for and the board's
            is what they asked to change, so the phone's wins and the note underneath says why.
          */}
          <Section title={s.settings.sections.news}>
            <Text style={styles.help}>{s.settings.news.help}</Text>
            {source ? (
              <Card style={styles.infoCard}>
                <InfoRow label={s.settings.news.lastPoll} value={fetchResultLabel(source.lastResult)} />
                <InfoRow label={s.settings.news.lastSuccess} value={formatAge(source.ageSeconds)} />
                <InfoRow label={s.settings.news.polls} value={formatInterval(source.pollSeconds)} last />
              </Card>
            ) : null}
            {source && source.lastResult !== 'ok' ? (
              <Text style={styles.help}>{fetchResultMessage(source.lastResult)}</Text>
            ) : null}
            {/* NOT MOUNTED UNTIL STORAGE HAS ANSWERED. The editor captures `initial` into a
                `useState` on its first render and the key below deliberately does not move when
                the phone's own copy arrives — so a mount taken before `loadLocal` resolves keeps
                the empty string it was born with. On a phone with no board that is forever:
                `source` stays null, the key stays '', and the field sits empty while a saved
                address is in force, `dirty` reads true against it, and the button offers to
                "Clear and use demo data" — an offer to discard an address the user cannot see.
                `localUrl !== null` is the disk having answered (`''` is a real answer meaning no
                address), so this waits for it rather than showing a lie for a frame or forever. */}
            {localUrl !== null ? (
              <NewsUrlEditor
                // Remount when the board reports a different URL, so the field picks up the new
                // value instead of holding a draft the board has already moved past. The board's
                // URL and only that: a save the board slept through changes the phone's copy and
                // the pending mark but not this key, so the editor keeps the sentence it has just
                // shown for that save instead of being rebuilt underneath it. That is also why the
                // gate above is a mount condition and not another term in this key — a key that
                // moved when the phone's copy did would rebuild the editor on every save.
                key={source?.url ?? ''}
                initial={pendingSync ? localUrl : (source?.url ?? localUrl)}
                pending={pendingSync}
                hasBoard={hasDevice}
                // What Today is reading when this field is empty. Without it the field is blank,
                // the paper arrives anyway, and the two facts have nothing on screen joining them.
                derived={isDerived(localUrl, deskAddress) ? editionUrl(localUrl, deskAddress) : null}
                onSave={async (next) => {
                  setSyncRejected(null)
                  // What the attempt means — persist or not, pending or not, which voice — is
                  // `decideNewsUrlSave`'s, tested as a rule. This site only makes the two attempts
                  // and does what the decision says. The one thing it does before the board's is
                  // wait for any delivery already on the wire: a POST of an older address racing
                  // this one would land in whichever order the board took them.
                  //
                  // TWO ATTEMPTS, IN PARALLEL, AND THEY ASK DIFFERENT THINGS. The board is asked
                  // whether it will take the address; the address is asked whether there is an
                  // edition at it. They are independent — a phone with no board still has the
                  // second question, and it is the one the reader typing an address is waiting
                  // on — so running them in sequence would add a board's eight-second timeout to
                  // a save whose answer had nothing to do with the board.
                  const boardAttempt = (async (): Promise<NewsUrlSaveOutcome> => {
                    if (!client) return { noClient: true }
                    await settleNewsUrlSync()
                    try {
                      await client.setNewsUrl(next)
                      return { ok: true }
                    } catch (e) {
                      return { error: e }
                    }
                  })()
                  const [outcome, desk] = await Promise.all([boardAttempt, probeEdition(next)])
                  const decision = decideNewsUrlSave(next, outcome, hasDevice, desk)
                  if (decision.persist) {
                    await saveNewsUrl(next)
                    if (!decision.pending) await clearNewsUrlPending()
                    loadLocal()
                  }
                  if (client && 'ok' in outcome) {
                    // Re-read so the rows above reflect the change. The board polls the new URL
                    // immediately, but the result lands a moment later — the next poll of this
                    // screen (or a pull-to-refresh on the dashboard) will show it.
                    try {
                      setSource((await client.getState()).source)
                    } catch {
                      // the write succeeded; the value refreshes on the next load
                    }
                  }
                  return decision
                }}
              />
            ) : null}
            {syncRejected ? <Text style={styles.error}>{syncRejected}</Text> : null}
          </Section>

          {/* Manual host / IP override. Deliberately not hidden without a board: typing a host by
              hand — or tapping "Find board" — is a legitimate way for somebody who skipped setup to
              attach a board that was already provisioned elsewhere, instead of being sent through a
              SoftAP wizard for hardware that is already sitting on this Wi-Fi. */}
          <Section title={s.settings.sections.connection}>
            <Text style={styles.help}>{fill(s.settings.connection.help, { host: DEFAULT_HOST })}</Text>
            <View style={styles.hostRow}>
              <TextInput
                value={host}
                onChangeText={(t) => {
                  setHost(t)
                  setHostError(null)
                  setSaved(false)
                }}
                placeholder={fill(s.settings.connection.placeholder, { host: DEFAULT_HOST })}
                placeholderTextColor={colors.textFaint}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                style={styles.hostInput}
                onSubmitEditing={applyHost}
              />
            </View>
            {hostError ? <Text style={styles.error}>{hostError}</Text> : null}
            {saved ? <Text style={styles.saved}>{s.settings.connection.saved}</Text> : null}
            <Button label={s.settings.connection.useThisAddress} variant="secondary" onPress={applyHost} />

            <Text style={styles.help}>{s.settings.connection.findHelp}</Text>
            {reconnectMsg ? <Text style={styles.saved}>{reconnectMsg}</Text> : null}
            <Button
              label={s.settings.connection.findBoard}
              variant="secondary"
              loading={reconnecting}
              onPress={reconnect}
            />
          </Section>

          {/* Re-enter the wizard, or disown the board on file */}
          <Section title={s.settings.sections.setup}>
            {/*
              A `push`, and nothing cleared on the way in. `reonboard()` did the opposite: it
              dropped the saved URL and the onboarding flag *before* the wizard opened, so a user
              who backed out halfway paid for a setup they never finished with the working board
              they walked in with. Abandoning a re-entry is now free — the write still happens where
              it always did, in complete.tsx, once there is a new board to write. `wizardEntryHref`
              is what carries `flow: 'setup'`, and that param is what gives the wizard a Back
              instead of a SET UP LATER, which would be a strange offer to somebody who opened
              setup on purpose.

              Truthiness is right for these two, unlike the card above, and for the opposite
              reason: the only irreversible control on this screen is "Forget this board", so
              gating it on truthiness means it appears once storage has confirmed there is a board
              to forget, and an unknown is offered the harmless half of the pair.
            */}
            <Button
              label={hasDevice ? s.settings.setup.setUpDifferent : s.actions.setUpMyBoard}
              variant={hasDevice ? 'ghost' : 'primary'}
              onPress={() => router.push(wizardEntryHref('setup'))}
            />
            {hasDevice ? (
              <Button label={s.settings.setup.forget} variant="ghost" onPress={forget} />
            ) : null}
            {/*
              Shown only when the removal itself failed. The rest of the screen has already agreed
              the board is gone — that part is honest, this session is done with it — but the key is
              still on disk and the next cold launch will read it back. Saying nothing here would
              make that look like the app undoing a deliberate act on its own.
            */}
            {forgetFailed ? <Text style={styles.help}>{s.settings.setup.forgetFailed}</Text> : null}
          </Section>

          {/*
            The app's own language, and nothing else's. It sits below everything about the board
            because it changes nothing about one — a phone with no hardware still has a language,
            and somebody who came here to fix a connection should not meet a language picker first.
            The help line under it says what this does NOT cover, because "App language" beside an
            edition written in Korean is otherwise a fair thing to misread: the edition's language
            travels with the edition, and the desk sets it.

            The Desk section below is the other half of that sentence, and the two are adjacent on
            purpose: "App language" and "Edition language" are only telling apart if a reader can
            see both at once.
          */}
          <Section title={s.settings.sections.language}>
            <Text style={styles.help}>{s.settings.language.help}</Text>
            <LanguagePicker />
          </Section>

          {/*
            The desk. Last, because it is the only section on this screen that reaches past the LAN
            and the only one most owners never touch: a phone that just reads the paper needs an
            edition URL and no credential at all. What is here is what an OWNER can do that nobody
            else can — say what language their newspaper is written in.
          */}
          <DeskSection
            address={deskAddress}
            token={deskToken}
            loaded={deskLoaded}
            onAddress={setDeskAddress}
            onToken={setDeskToken}
          />

          {/*
            Notifications, last, because everything in it is about a desk that already has an
            address and a token — and because it is the only section on this screen that asks the
            phone itself for anything. The permission prompt is spent here and nowhere else.
          */}
          <NotifySection address={deskAddress} token={deskToken} loaded={deskLoaded} />
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  )
}

/**
 * System / English / 한국어, on the segmented track the panel selector and the options chain
 * already use. Three segments and not a list of rows because the choice is small, closed and
 * mutually exclusive — the shape iOS itself uses for exactly this — and because the track shows
 * all three answers at once, which matters more here than anywhere else on the screen: somebody
 * looking for this control may not read the two words above it.
 *
 * `system` leads, because it is the default and the answer most people want; the other two are
 * offered as **endonyms**, each written in its own language. "Korean" would be the wrong word for
 * the one reader who most needs to find it.
 *
 * The write is fire-and-forget by design. `set` fills the in-memory cache before it awaits the
 * disk, so the app is already redrawing in the new language while the write lands, and there is
 * nothing useful to say if it does not: the cost of a failed write is one re-tap on the next
 * launch, and a spinner or an error line on a control whose effect is visible everywhere at once
 * would be describing a failure the user cannot see and does not have to act on.
 */
function LanguagePicker() {
  const s = useStrings()
  const { choice, set } = useLanguage()
  const labels: Record<AppLanguage, string> = {
    system: s.settings.language.system,
    en: s.settings.language.english,
    ko: s.settings.language.korean,
  }
  return (
    <SegmentedControl
      segments={APP_LANGUAGES.map((l) => labels[l])}
      selectedIndex={APP_LANGUAGES.indexOf(choice)}
      onChange={(i) => void set(APP_LANGUAGES[i])}
    />
  )
}

/** A sentence and the voice it is said in — the three this screen already draws. */
type Toned = { tone: 'ok' | 'info' | 'error'; message: string }

/**
 * The desk: its address, an operator token, and the language the NEWSPAPER is written in.
 *
 * This is the app's first authenticated call to anything (`lib/desk.ts`). Everything else the app
 * does with a desk goes through the open device plane — `/news.json` and its tiles, no credential —
 * so the token here is not "the app's login". It is the operator's own, pasted in by the person who
 * runs the desk, and it buys exactly one thing today: `PUT /api/settings`.
 *
 * THE TOKEN IS NEVER DRAWN BACK. It goes to the keychain (`deskToken.ts`), the field is emptied on
 * save, and the section then says only that one is held. A screen that refilled the field with the
 * secret would put it in every screenshot and every shoulder's view for the sake of confirming
 * something the sentence already confirms. Replacing it means typing a new one; there is a Forget
 * for the phone that is being handed on.
 *
 * The address is not a secret and is prefilled, like every other address on this screen.
 *
 * BOTH SAVED VALUES COME FROM THE SCREEN, not from this component's own read of storage. They were
 * local here until Notifications needed the same two facts, and a second component reading the
 * same two keys on its own mount is two components that can disagree about them for as long as
 * this tab is up — see the note beside the state in `Settings`. This section still owns the
 * WRITES; it hands each one up as it lands.
 */
function DeskSection({
  address,
  token,
  loaded,
  onAddress,
  onToken,
}: {
  /** The saved desk address, or `null`. Meaningless until `loaded`. */
  address: string | null
  /** Whether a token is held. The value is never drawn — see above. */
  token: string | null
  /** Storage has answered about both. */
  loaded: boolean
  onAddress: (address: string | null) => void
  onToken: (token: string | null) => void
}) {
  const s = useStrings()
  // What is being typed, beside what is saved. The drafts are this section's alone.
  const [addressDraft, setAddressDraft] = useState('')
  const [addressMsg, setAddressMsg] = useState<Toned | null>(null)
  const [tokenDraft, setTokenDraft] = useState('')
  const [tokenMsg, setTokenMsg] = useState<Toned | null>(null)
  // What the desk says it is set to — `null` until it has answered, and again if it stops
  // answering. Never a guessed default: see `desk.ts`'s `settingsOf`.
  const [lang, setLang] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [langMsg, setLangMsg] = useState<Toned | null>(null)
  /**
   * WHICH control has already reported that this phone could not be taken off the desk's list.
   *
   * Per control, and cleared whenever the desk changes. It was a bare boolean shared by both, never
   * reset, in a tab that mounts once — so a warning raised by a failed "Forget token" was spent by
   * a later "Save address": no read, no DELETE, no message, address overwritten, and the desk left
   * holding a token nothing could ever delete because the DELETE needs the address that had just
   * been replaced. A warning belongs to the act it was raised about.
   */
  const [warned, setWarned] = useState<ReleaseControl | null>(null)

  // A failure to reach one desk says nothing about the next, in either direction: a new address is
  // a different desk, and a new operator token may authenticate where the old one could not.
  useEffect(() => {
    setWarned(null)
  }, [address, token])

  // Which of the two severing controls is working, so the other can be held and the pressed one can
  // spin. A release is up to three round trips — a desk read, an Expo token and a desk delete — and
  // both of these buttons sat live and silent through all of it.
  const [working, setWorking] = useState<ReleaseControl | null>(null)

  // Whether this section is still on screen, for the one handler that awaits the NETWORK. The
  // effects below have their own `active` flags; a handler has no cleanup to hang one on, and
  // `chooseLanguage` can be waiting out a fifteen-second deadline when the tab is torn down.
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  // The field follows the saved address. It runs twice on a cold open — once for the null before
  // storage answers, once for what it answered — and after that only when a save changes the
  // address, which is exactly when the field should be showing the normalised form rather than
  // what was typed. Typing does not change `address`, so it cannot be clobbered mid-word.
  useEffect(() => {
    setAddressDraft(address ?? '')
  }, [address])

  // Ask the desk what it is set to, whenever there is an address and a token to ask with. Both
  // arms matter: losing either (a forgotten token) has to clear the language too, or the selector
  // would go on showing a live answer next to a control that can no longer change it.
  useEffect(() => {
    if (!address || !token) {
      setLang(null)
      // And nothing is in flight any more. This arm is where "Forget token" lands: its own read
      // was abandoned by the cleanup below, whose `active` flag is false by then, so the `finally`
      // that would have cleared this is skipped and only here can do it.
      setBusy(false)
      return
    }
    let active = true
    setBusy(true)
    setLangMsg(null)
    void (async () => {
      try {
        const settings = await createDeskClient({ baseUrl: address, token }).getSettings()
        if (active) setLang(settings.lang)
      } catch (e) {
        if (!active) return
        setLang(null)
        setLangMsg({ tone: 'error', message: humanDeskError(e) })
      } finally {
        if (active) setBusy(false)
      }
    })()
    return () => {
      active = false
    }
  }, [address, token])

  /**
   * TAKE THIS PHONE OFF THE DESK'S LIST BEFORE CUTTING THE APP OFF FROM THAT DESK.
   *
   * Both controls below sever the phone from the desk it is registered with — forgetting the token
   * removes the credential, changing the address points the app somewhere else — and both do it in
   * the direction that cannot be undone. The desk goes on holding the push token and goes on
   * sending; the app can no longer authenticate to it; the DELETE that would stop it is unreachable
   * from every screen the app has. There is no recovery inside the product, so the fix is to make
   * the orphan impossible rather than survivable, and that means going first rather than warning
   * afterwards.
   *
   * Answers whether the caller may proceed. A `released` or a `nothing` is a yes. An `unsure` is a
   * no THE FIRST TIME: it says what could not be established and what a second tap will do, and the
   * second tap goes ahead — because the owner may be forgetting the token of a desk that no longer
   * exists, and an app that refused outright would trap them with a credential they cannot remove.
   * The choice is theirs; being told is not optional.
   */
  const releaseFirst = async (control: ReleaseControl): Promise<boolean> => {
    // Whether to spend the round trips at all. The second tap of the control that was already
    // warned about does not re-ask — the owner has read the sentence and decided — but a tap of
    // the OTHER control does, because it was never warned about and the network may have come back
    // since. `decideRelease` then says what happened, in one place for both callers.
    const step = shouldAttemptRelease(control, warned)
      ? await releaseThisPhone({
          client: address && token ? createDeskClient({ baseUrl: address, token }) : null,
          token: fetchPushToken,
        })
      : null
    if (!alive.current) return false
    const decision = decideRelease(control, warned, step)
    setWarned(decision.warned)
    setTokenMsg(
      decision.tone && decision.message
        ? { tone: decision.tone, message: decision.message }
        : null,
    )
    return decision.proceed
  }

  const applyAddress = async () => {
    // The buttons are disabled while a release is out, but both fields also submit on return, so
    // the guard is on the handler and not only on the control. This is the answer to "can a second
    // tap reach anything during the busy window": it cannot.
    if (working) return
    setAddressMsg(null)
    setTokenMsg(null)
    // Normalised HERE rather than by letting `saveDeskBaseUrl` do it, because the address must not
    // be written until the old desk has let this phone go — a save that landed and a release that
    // did not would leave storage pointing at the new desk while the app's state still described
    // the old one. `deskScheme` then `normalizeBaseUrl` is exactly what the store does.
    const norm = normalizeBaseUrl(deskScheme(addressDraft))
    if (!norm.ok || !norm.value) {
      setAddressMsg({ tone: 'error', message: s.settings.desk.addressInvalid })
      return
    }
    const next = norm.value
    // Only a CHANGE of desk orphans anything. Re-saving the address already in force is a no-op
    // and must not cost this phone its registration.
    if (next !== address) {
      setWorking('address')
      const proceed = await releaseFirst('address')
      if (!alive.current) return
      setWorking(null)
      if (!proceed) return
    }
    if (!(await saveDeskBaseUrl(next))) {
      setAddressMsg({ tone: 'error', message: s.settings.desk.addressInvalid })
      return
    }
    // Read back rather than trusting the draft: the store normalizes (it drops a trailing slash
    // and any path), and the field should show what will actually be called.
    const saved = await getDeskBaseUrl()
    onAddress(saved)
    setAddressDraft(saved ?? '')
    setAddressMsg({ tone: 'ok', message: s.settings.desk.addressSaved })
  }

  // THE EMPTY FIELD IS ITS OWN ANSWER. The Save button is disabled while the field is blank, but
  // the field also submits on return — so pressing it on an empty box is the easiest way into this
  // handler and it used to end at "this phone's keychain wouldn't store the token", an alarming
  // sentence about a component nothing had asked. It is a no-op and says so, and it deliberately
  // does NOT clear the saved token: forgetting one is a button of its own, and an accidental
  // return should never be the way somebody loses the credential that is working.
  const applyToken = async () => {
    // Saving a token severs nothing, so it needs no release — but it must not land in the middle of
    // one, because the client the release is using was built from the token it would replace.
    if (working) return
    setTokenMsg(null)
    const typed = tokenDraft.trim()
    const outcome = await saveDeskToken(typed)
    if (outcome === 'empty') {
      setTokenMsg({ tone: 'info', message: s.settings.desk.tokenEmpty })
      return
    }
    if (outcome === 'refused') {
      setTokenMsg({ tone: 'error', message: s.settings.desk.tokenNotSaved })
      return
    }
    onToken(typed)
    setTokenDraft('')
    setTokenMsg({ tone: 'ok', message: s.settings.desk.tokenSaved })
  }

  // Forgetting the token is the other way to orphan a registration, and the worse one: it removes
  // the only credential that could ever delete the device, so the desk is left sending to a phone
  // the app can no longer speak for. The release goes first, and an `unsure` stops the first tap.
  const forgetToken = async () => {
    if (working) return
    setTokenMsg(null)
    setWorking('token')
    const proceed = await releaseFirst('token')
    if (!alive.current) return
    setWorking(null)
    if (!proceed) return
    await clearDeskToken()
    onToken(null)
    setTokenDraft('')
    setLangMsg(null)
  }

  // Write the language, then draw WHAT THE DESK PUT IN FORCE rather than what was asked for. A
  // failure leaves the selector where it was, which is the truth: the desk did not change.
  //
  // Every write here is guarded by `alive`, because this is the one thing on the screen that can
  // still be waiting when the section is gone: a desk behind a cold tunnel has fifteen seconds to
  // answer, and the tab can be left in one.
  const chooseLanguage = async (next: string) => {
    if (!address || !token || next === lang) return
    setBusy(true)
    setLangMsg(null)
    try {
      const settings = await createDeskClient({ baseUrl: address, token }).putSettings({
        lang: next,
      })
      if (!alive.current) return
      setLang(settings.lang)
      setLangMsg({ tone: 'ok', message: s.settings.desk.languageSaved })
    } catch (e) {
      if (alive.current) setLangMsg({ tone: 'error', message: humanDeskError(e) })
    } finally {
      if (alive.current) setBusy(false)
    }
  }

  const view = deskLanguageView({ address, token, lang, busy, loaded })
  const note =
    view.note === 'needs_setup'
      ? s.settings.desk.needsSetup
      : view.note === 'unsupported'
        ? fill(s.settings.desk.unsupported, { lang: lang ?? '' })
        : null

  return (
    <Section title={s.settings.sections.desk}>
      <Text style={styles.help}>{s.settings.desk.help}</Text>

      <View style={styles.field}>
        <View style={styles.hostRow}>
          <TextInput
            value={addressDraft}
            onChangeText={(t) => {
              setAddressDraft(t)
              setAddressMsg(null)
            }}
            // The shape of an address, not a sentence: the same characters in every language, so
            // it is a literal here rather than a catalogue entry that can be mistranslated.
            placeholder="https://…"
            placeholderTextColor={colors.textFaint}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            style={styles.hostInput}
            onSubmitEditing={applyAddress}
          />
        </View>
        {addressMsg ? <Text style={TONE[addressMsg.tone]}>{addressMsg.message}</Text> : null}
        {/*
          `loading` on the one that was pressed, `disabled` on both while either is out. A release
          is a desk read, an Expo token and a desk delete — up to forty-five seconds against a dead
          desk — and these two buttons used to sit live and silent through all of it, one of them
          destructive.
        */}
        <Button
          label={s.settings.desk.saveAddress}
          variant="secondary"
          disabled={
            !addressDraft.trim() ||
            addressDraft.trim() === (address ?? '') ||
            working !== null
          }
          loading={working === 'address'}
          onPress={applyAddress}
        />
      </View>

      <View style={styles.field}>
        <View style={styles.hostRow}>
          <TextInput
            value={tokenDraft}
            onChangeText={(t) => {
              setTokenDraft(t)
              setTokenMsg(null)
            }}
            placeholder={s.settings.desk.tokenPlaceholder}
            placeholderTextColor={colors.textFaint}
            // A credential: masked, and deliberately invisible to the platform's password
            // manager. `textContentType="none"` with autofill off is what keeps iOS from
            // treating this as a login field — there is no account here to save a password
            // against, and its offer to do so would file the desk's token under a domain the
            // app never authenticates to.
            secureTextEntry
            textContentType="none"
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect={false}
            style={styles.hostInput}
            onSubmitEditing={applyToken}
          />
        </View>
        {tokenMsg ? <Text style={TONE[tokenMsg.tone]}>{tokenMsg.message}</Text> : null}
        {token && !tokenMsg ? <Text style={styles.help}>{s.settings.desk.tokenHeld}</Text> : null}
        <Button
          label={s.settings.desk.saveToken}
          variant="secondary"
          disabled={!tokenDraft.trim() || working !== null}
          onPress={applyToken}
        />
        {token ? (
          <Button
            label={s.settings.desk.forgetToken}
            variant="ghost"
            disabled={working !== null}
            loading={working === 'token'}
            onPress={forgetToken}
          />
        ) : null}
      </View>

      <Text style={styles.deskLabel}>{s.settings.desk.editionLanguage}</Text>
      <Text style={styles.help}>{s.settings.desk.editionHelp}</Text>
      <SegmentedControl
        segments={[s.settings.language.english, s.settings.language.korean]}
        selectedIndex={view.selectedIndex}
        disabled={view.disabled}
        onChange={(i) => void chooseLanguage(EDITION_LANGUAGES[i])}
      />
      {note ? <Text style={styles.help}>{note}</Text> : null}
      {langMsg ? <Text style={TONE[langMsg.tone]}>{langMsg.message}</Text> : null}
    </Section>
  )
}

/**
 * Notifications: the master switch, the five kinds, their lead times, and quiet hours.
 *
 * THIS COMPONENT DECIDES NOTHING. `notifyView` says what is drawn, `decideNotify` says what a
 * touch came to, and `turnOnNotifications` / `turnOffNotifications` / `applyNotifyPrefs` do the
 * work — all of them in `lib/notify.ts`, all of them tested. What is left here is state and JSX,
 * deliberately, because this app has no way to render a screen under test: a failure path argued
 * inside one branch of a `?:` is a failure path argued only in prose, and this feature has four
 * outcomes on its master switch and a fifth on the way back off.
 *
 * THE PUSH TOKEN LIVES IN THIS COMPONENT'S STATE AND NOWHERE ELSE. Not AsyncStorage, not the
 * keychain, not a log. It is fetched from Expo when it is needed, held for as long as this screen
 * is up, and handed to the desk in one body and one path. A token is a capability to write on the
 * owner's lock screen; the cost of re-fetching one is a round trip, and the cost of persisting one
 * is that it is somewhere it can be read.
 *
 * `prefs === null` IS "NOT REGISTERED", and it is the single source of the switch's position. Every
 * outcome either sets it, clears it, or deliberately leaves it alone — a failed forget leaves it
 * alone, which is what keeps the switch on over a desk that is still sending.
 */
function NotifySection({
  address,
  token,
  loaded,
}: {
  address: string | null
  token: string | null
  /** Storage has answered about both, so `null` means "none saved" rather than "not read". */
  loaded: boolean
}) {
  const s = useStrings()
  const t = s.settings.notify

  // Two constants of the install rather than state. `Platform.OS` cannot change and the zone can
  // only change with the phone's own settings, which restarts this screen.
  const platform = useMemo(() => pushPlatform(Platform.OS), [])
  const tz = useMemo(() => phoneZone(), [])

  const [permission, setPermission] = useState<PermissionState | null>(null)
  // The Expo push token for this install. In memory, for this screen's life. See above.
  const [pushToken, setPushToken] = useState<string | null>(null)
  /**
   * WHAT THE DESK HAS SAID, and the `prefs` beside it are only meaningful when it says `holding`.
   *
   * Two fields rather than `prefs === null`, which is the whole of this round's worst finding: a
   * single nullable document cannot tell "the desk does not hold this phone" from "the desk could
   * not be asked", so the discovery `catch` wrote the first when it meant the second — a switch
   * drawn OFF, with no sentence, over a desk still sending.
   */
  const [desk, setDesk] = useState<DeskAnswer>('unknown')
  const [prefs, setPrefs] = useState<NotifyPrefs | null>(null)
  // Bumped by the retry button, to ask the desk again without leaving the screen. This is a
  // persistent tab: it mounts once, so without this an `unreachable` sticks for the session.
  const [asks, setAsks] = useState(0)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<Toned | null>(null)
  const [offerSettings, setOfferSettings] = useState(false)
  // The two quiet-hour fields, which are the only controls here that are typed rather than tapped
  // and therefore the only ones with a draft of their own.
  const [fromDraft, setFromDraft] = useState(DEFAULT_QUIET.from)
  const [toDraft, setToDraft] = useState(DEFAULT_QUIET.to)
  const [quietMsg, setQuietMsg] = useState<Toned | null>(null)
  // The OS has answered. Separate from `loaded`, which is about storage: both have to be in before
  // the switch can say anything, and they arrive from different places at different times.
  const [asked, setAsked] = useState(false)

  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const client = useMemo(
    () => (address && token ? createDeskClient({ baseUrl: address, token }) : null),
    [address, token],
  )

  // What the OS says, asked WITHOUT prompting. This is the one read that happens on its own, and
  // it is a read: `getPermissionsAsync` shows nothing and cannot spend the one prompt.
  useEffect(() => {
    let active = true
    void (async () => {
      let state: PermissionState = 'undetermined'
      try {
        state = await readPermission()
      } catch {
        // A permissions module that will not answer is a phone that will not deliver, which is the
        // same fact as a denial everywhere above here. Not logged: the message is a library's.
        state = 'denied'
      }
      if (active) {
        setPermission(state)
        setAsked(true)
      }
    })()
    return () => {
      active = false
    }
  }, [])

  /**
   * Whether the DESK is holding this phone — the only thing that decides where the switch stands.
   *
   * IT RUNS WHATEVER THE PERMISSION IS, and that is deliberate rather than thorough. A phone that
   * registered and then revoked notifications in the OS is the state this feature is worst at: iOS
   * throws every push away without telling Expo, so nothing ever prunes the device and the desk
   * sends forever. The only way out is the DELETE, the DELETE needs the push token, and the token
   * is reachable — APNs registration is not gated on the alert permission, and neither is FCM's.
   * Skipping the read for a denied phone was what made that state permanent.
   *
   * A FAILURE HERE IS `unreachable` AND NOT `not_holding`. They were the same value until this
   * round, and the difference is the difference between a switch that says "I could not find out"
   * and one that says "you are not registered" to somebody whose phone is buzzing.
   */
  useEffect(() => {
    if (!client) {
      setDesk('unknown')
      setPrefs(null)
      return
    }
    let active = true
    setDesk('unknown')
    void (async () => {
      try {
        const mine = await fetchPushToken()
        const doc = await client.pushDevices()
        if (!active) return
        const held = findRegistration(doc, mine)
        setPushToken(mine)
        setPrefs(held)
        setDesk(held ? 'holding' : 'not_holding')
      } catch {
        // Not logged: the thrown message can be the desk quoting the token back at us.
        if (!active) return
        setPrefs(null)
        setDesk('unreachable')
      }
    })()
    return () => {
      active = false
    }
  }, [client, asks])

  // The fields follow whatever window is actually IN FORCE, so opening the section on a phone with
  // quiet hours set shows those hours rather than the defaults.
  //
  // The dependencies are the two clock strings and not the object they sit in. `prefs` is replaced
  // wholesale on every change — a kind switched off replaces it too — so depending on the object
  // would reset both fields under somebody halfway through typing a time, for a change that had
  // nothing to do with the window.
  useEffect(() => {
    if (prefs?.quiet) {
      setFromDraft(prefs.quiet.from)
      setToDraft(prefs.quiet.to)
    }
  }, [prefs?.quiet?.from, prefs?.quiet?.to])

  /**
   * One place where an outcome becomes what the screen holds. Every handler ends here, so there is
   * no arm of this feature whose reporting lives in a branch of JSX.
   *
   * `decision.desk` IS THE SWITCH. The screen used to keep its own reckoning of where the switch
   * stood and let `decideNotify` return a `boolean on` that nothing read — so the tests asserted
   * one thing and the product did another, and the two had already drifted. Now there is one
   * answer: the decision says what the step established about the desk, `null` means it
   * established nothing, and the last thing the desk actually said stands.
   */
  const settle = useCallback((step: NotifyStep) => {
    const decision = decideNotify(step)
    if (decision.desk !== null) setDesk(decision.desk)
    // The documents that travel with the answer. `change_failed` carries what the desk turned out
    // to be holding, which may not be either the old document or the new one.
    if (step.step === 'on') {
      setPushToken(step.token)
      setPrefs(step.prefs)
      setPermission('granted')
    } else if (step.step === 'off') {
      setPrefs(null)
    } else if (step.step === 'saved') {
      setPrefs(step.prefs)
    } else if (step.step === 'change_failed') {
      setPrefs(step.held)
    } else if (step.step === 'denied') {
      setPermission('denied')
    }
    setMsg(decision.tone && decision.message ? { tone: decision.tone, message: decision.message } : null)
    setOfferSettings(decision.openSettings)
  }, [])

  const toggleMaster = async (on: boolean) => {
    setBusy(true)
    setMsg(null)
    setOfferSettings(false)
    const step = on
      ? await turnOnNotifications({
          client,
          platform,
          tz,
          permission: readPermission,
          request: askPermission,
          token: fetchPushToken,
          // A phone turning this on again in the same session gets the switches it was last
          // showing rather than the defaults; a fresh one gets the desk's own.
          prefs: prefs ?? DEFAULT_PREFS,
        })
      : await turnOffNotifications({ client, token: pushToken })
    if (!alive.current) return
    setBusy(false)
    settle(step)
  }

  // A changed preference document, put in force. Optimism is deliberate: the switch moves under
  // the finger and `settle` puts it back if the desk refuses, which is the only honest order —
  // a control that waits out a round trip before moving reads as broken on a slow tunnel.
  const change = async (next: NotifyPrefs) => {
    const previous = prefs
    setPrefs(next)
    setBusy(true)
    setMsg(null)
    const step = await applyNotifyPrefs({ client, token: pushToken, platform, tz, prefs: next })
    if (!alive.current) return
    setBusy(false)
    // Back to the old document first, then `settle` — which overwrites it again from `held` on a
    // `change_failed`, because a POST whose answer was lost may well have landed and the desk's
    // own answer beats both guesses.
    if (step.step !== 'saved') setPrefs(previous)
    settle(step)
  }

  const view = notifyView({
    loaded: loaded && asked,
    ready: Boolean(address) && Boolean(token),
    supported: platform !== null,
    permission,
    desk,
    busy,
  })
  const note =
    view.note === 'needs_desk'
      ? t.needsDesk
      : view.note === 'unsupported'
        ? t.unsupported
        : view.note === 'blocked'
          ? t.blocked
          : view.note === 'blocked_registered'
            ? t.blockedRegistered
            : view.note === 'unreachable'
              ? t.unreachable
              : null

  const saveQuiet = async () => {
    setQuietMsg(null)
    const outcome = validateQuiet(fromDraft, toDraft)
    if (!outcome.ok) {
      setQuietMsg({
        tone: 'error',
        message: outcome.reason === 'same' ? t.quiet.same : t.quiet.shape,
      })
      return
    }
    if (!prefs) return
    await change({ ...prefs, quiet: outcome.quiet })
  }

  // Turning the window on sends the DRAFTS when they are a window the desk will take, and the
  // defaults when they are not. The drafts can be anything at that moment — somebody can type a
  // time, switch the window off, and switch it back on — and sending an unparseable pair would
  // spend a round trip to be told what `validateQuiet` already knows, under a switch that had
  // just sprung back for no reason the owner could see.
  const toggleQuiet = async (on: boolean) => {
    if (!prefs) return
    setQuietMsg(null)
    if (!on) {
      await change({ ...prefs, quiet: null })
      return
    }
    const outcome = validateQuiet(fromDraft, toDraft)
    const quiet = outcome.ok ? outcome.quiet : DEFAULT_QUIET
    setFromDraft(quiet.from)
    setToDraft(quiet.to)
    await change({ ...prefs, quiet })
  }

  return (
    <Section title={s.settings.sections.notifications}>
      <Text style={styles.help}>{t.help}</Text>

      <View style={styles.switchRow}>
        <Text style={styles.switchLabel}>{t.master}</Text>
        <Switch
          value={view.on}
          disabled={view.disabled}
          onValueChange={(on) => void toggleMaster(on)}
          trackColor={{ false: colors.surfaceAlt, true: colors.accentBright }}
          thumbColor={colors.white}
          ios_backgroundColor={colors.surfaceAlt}
        />
      </View>
      {note ? <Text style={styles.help}>{note}</Text> : null}
      {msg ? <Text style={TONE[msg.tone]}>{msg.message}</Text> : null}
      {/*
        Drawn for the one outcome nothing in this app can fix. A denied permission is the phone's
        own setting and only the phone's own settings can change it, so the button that goes there
        is the whole of the remedy.
      */}
      {offerSettings ? (
        <Button
          label={t.openSettings}
          variant="ghost"
          onPress={() => void Linking.openSettings()}
        />
      ) : null}
      {/*
        Offered only where asking again IS the remedy — a desk that did not answer. Settings is a
        persistent tab and mounts once, so without a control the owner cannot get the section to
        try again without restarting the app, and an `unreachable` would stand for the session.
      */}
      {view.retry ? (
        <Button label={t.retry} variant="ghost" onPress={() => setAsks((n) => n + 1)} />
      ) : null}

      {view.detail && prefs ? (
        <>
          {/*
            A hairline above each row, which is also a hairline under the master switch — and that
            is the one that matters. Without it the seven switches are a flat list of equals, and
            they are not: the six here answer to the one above, and nothing else on the row tells
            them apart. Same shape, same type, same control, one after another.
          */}
          {PUSH_KINDS.map((kind) => (
            <View key={kind} style={[styles.field, styles.ruled]}>
              <View style={styles.switchRow}>
                <Text style={styles.switchLabel}>{t.kinds[kind]}</Text>
                <Switch
                  value={prefs.prefs[kind]}
                  disabled={busy}
                  onValueChange={(on) =>
                    void change({ ...prefs, prefs: { ...prefs.prefs, [kind]: on } })
                  }
                  trackColor={{ false: colors.surfaceAlt, true: colors.accentBright }}
                  thumbColor={colors.white}
                  ios_backgroundColor={colors.surfaceAlt}
                />
              </View>
              {prefs.prefs[kind] && LEAD_KINDS.includes(kind) ? (
                <>
                  <View style={styles.chipRow} accessibilityLabel={t.leadLabel}>
                    {LEADS.map((lead) => (
                      <Chip
                        key={lead}
                        label={t.leads[lead]}
                        active={prefs.lead[kind].includes(lead)}
                        disabled={busy}
                        onPress={() =>
                          void change({
                            ...prefs,
                            lead: { ...prefs.lead, [kind]: toggleLead(prefs.lead[kind], lead) },
                          })
                        }
                      />
                    ))}
                  </View>
                  {/*
                    A real setting the desk supports on purpose, and one that looks exactly like a
                    broken switch: on, and nothing will ever be sent. It says so rather than
                    leaving the owner to notice over a week of silence.
                  */}
                  {prefs.lead[kind].length === 0 ? (
                    <Text style={styles.help}>{t.noLead}</Text>
                  ) : null}
                </>
              ) : null}
            </View>
          ))}

          <View style={[styles.switchRow, styles.ruled]}>
            <Text style={styles.deskLabel}>{t.quiet.label}</Text>
            <Switch
              value={prefs.quiet !== null}
              disabled={busy}
              onValueChange={(on) => void toggleQuiet(on)}
              trackColor={{ false: colors.surfaceAlt, true: colors.accentBright }}
              thumbColor={colors.white}
              ios_backgroundColor={colors.surfaceAlt}
            />
          </View>
          <Text style={styles.help}>{t.quiet.help}</Text>
          {prefs.quiet ? (
            <View style={styles.field}>
              <View style={styles.timeRow}>
                <View style={styles.timeField}>
                  <Text style={styles.help}>{t.quiet.from}</Text>
                  <TextInput
                    value={fromDraft}
                    onChangeText={(v) => {
                      setFromDraft(v)
                      setQuietMsg(null)
                    }}
                    // A 24-hour clock is the same characters in every language, so the placeholder
                    // is a literal rather than a catalogue entry that can be mistranslated.
                    placeholder="22:00"
                    placeholderTextColor={colors.textFaint}
                    keyboardType="numbers-and-punctuation"
                    autoCorrect={false}
                    maxLength={5}
                    style={styles.hostInput}
                    onSubmitEditing={() => void saveQuiet()}
                  />
                </View>
                <View style={styles.timeField}>
                  <Text style={styles.help}>{t.quiet.to}</Text>
                  <TextInput
                    value={toDraft}
                    onChangeText={(v) => {
                      setToDraft(v)
                      setQuietMsg(null)
                    }}
                    placeholder="07:00"
                    placeholderTextColor={colors.textFaint}
                    keyboardType="numbers-and-punctuation"
                    autoCorrect={false}
                    maxLength={5}
                    style={styles.hostInput}
                    onSubmitEditing={() => void saveQuiet()}
                  />
                </View>
              </View>
              {quietMsg ? <Text style={TONE[quietMsg.tone]}>{quietMsg.message}</Text> : null}
              <Button
                label={t.quiet.save}
                variant="secondary"
                disabled={
                  busy || (fromDraft === prefs.quiet.from && toDraft === prefs.quiet.to)
                }
                onPress={() => void saveQuiet()}
              />
            </View>
          ) : null}
        </>
      ) : null}
    </Section>
  )
}

/** One lead chip tapped: in if it was out, out if it was in, and the order the desk stores. */
function toggleLead(held: readonly Lead[], lead: Lead): Lead[] {
  const next = held.includes(lead) ? held.filter((l) => l !== lead) : [...held, lead]
  return LEADS.filter((l) => next.includes(l))
}

/**
 * The snapshot-URL field. Prefilled with the address in force, validated locally against the
 * firmware's own rule before any request goes out, and explicit about the empty case: clearing the
 * field and saving is a real, supported action (back to the demo snapshot), not a mistake.
 *
 * `onSave` answers with a `NewsUrlSaveDecision` — two lines, the desk's and the board's — and this
 * component only draws them: `ok` is green; `info` is the help voice, because the phone has done
 * what was asked and the sentence is information rather than a verdict; `error` is red. `pending`
 * is the standing version of `info` — an address on this phone the board has not been told about —
 * and is said in the same voice for the same reason.
 *
 * RED NO LONGER MEANS NOTHING WAS SAVED. It did while the board was the only thing a save spoke
 * to, because the board refusing an address was the one red there was. The desk's line can be red
 * over an address that IS saved — the address is kept and the sentence says the desk did not
 * answer — and that pair is the honest report of the state the phone is actually in. Which line
 * is which is why they are separate fields rather than one string with a tone.
 *
 * WHAT THAT STANDING SENTENCE SAYS DEPENDS ON WHETHER THERE IS A BOARD. The mark is set on every
 * save this phone makes without one, and nothing without a client ever clears it, so on a phone
 * that has never had a board "Not yet on the board" is permanent, names hardware that does not
 * exist, and appears under an address the Today tab is already reading perfectly well. With
 * `hasBoard === false` it names that reader instead. `=== false` and never `!hasBoard`: `null` is
 * storage still answering, and it keeps the board owner's wording.
 */
function NewsUrlEditor({
  initial,
  pending,
  hasBoard,
  derived,
  onSave,
}: {
  initial: string
  pending: boolean
  /** Tri-state, from `useDevice`. `null` is "storage has not answered", never "no board". */
  hasBoard: boolean | null
  /** The address Today is reading because this field is empty, or null when this field decides. */
  derived: string | null
  onSave: (value: string) => Promise<NewsUrlSaveDecision>
}) {
  const s = useStrings()
  const [draft, setDraft] = useState(initial)
  const [saving, setSaving] = useState(false)
  const [outcome, setOutcome] = useState<NewsUrlSaveDecision | null>(null)

  const result = validateNewsUrl(draft)
  const localError = !result.ok ? newsUrlErrorMessage(result) : null
  const dirty = draft.trim() !== initial.trim()

  const save = async () => {
    if (!result.ok) return
    setSaving(true)
    setOutcome(null)
    const decision = await onSave(result.value ?? '')
    setSaving(false)
    setOutcome(decision)
  }

  return (
    <View style={styles.field}>
      <View style={styles.hostRow}>
        <TextInput
          value={draft}
          onChangeText={(t) => {
            setDraft(t)
            setOutcome(null)
          }}
          // A URL, not copy: an example address is the same characters in every language, so it
          // stays a literal here rather than becoming a catalogue entry that can only be
          // mistranslated.
          placeholder="http://mymac.local:8123/news.json"
          placeholderTextColor={colors.textFaint}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          style={styles.hostInput}
          onSubmitEditing={save}
        />
      </View>
      {localError ? <Text style={styles.error}>{localError}</Text> : null}
      {/* The desk first, then the board. Two lines and not one, because they are answers to two
          different questions and the reader needs both: whether there is an edition at the
          address they just typed, and whether the hardware — which most saves cannot reach — has
          been told. Collapsing them was what left a save able to say only "the board did not
          answer" about an address that was, or was not, serving today's paper. */}
      {outcome?.desk ? <Text style={TONE[outcome.desk.tone]}>{outcome.desk.message}</Text> : null}
      {outcome ? <Text style={TONE[outcome.board.tone]}>{outcome.board.message}</Text> : null}
      {/* Only while the field is genuinely empty and untouched: once there is a draft in it, the
          sentence would describe an address the next save is about to replace. */}
      {derived !== null && !outcome && !dirty ? (
        <Text style={styles.help}>{fill(s.settings.news.derived, { url: derived })}</Text>
      ) : null}
      {pending && !outcome && !dirty ? (
        <Text style={styles.help}>
          {hasBoard === false ? s.settings.news.pendingNoBoard : s.settings.news.pendingWithBoard}
        </Text>
      ) : null}
      <Button
        label={dirty && !draft.trim() ? s.settings.news.clearAndDemo : s.settings.news.saveAddress}
        variant="secondary"
        disabled={!result.ok || !dirty}
        loading={saving}
        onPress={save}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  titleRow: {
    paddingHorizontal: layout.gutter,
    paddingTop: space.sm,
    paddingBottom: space.xs,
  },
  title: {
    ...type.headingLg,
  },
  body: {
    paddingHorizontal: layout.gutter,
    paddingTop: 12,
    paddingBottom: 32,
    gap: space.xl,
  },
  section: {
    gap: 10,
  },
  sectionTitle: {
    fontFamily: fonts.semibold,
    fontSize: 13,
    color: colors.textDim,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  infoCard: {
    padding: 0,
  },
  infoRetry: {
    padding: 16,
  },
  infoRetryText: {
    fontSize: 14,
    color: colors.accent,
    textAlign: 'center',
  },
  // The no-board line speaks in `help`'s voice — this screen's explanatory type — but sits inside
  // a zero-padded Card, so it borrows `infoRetry`'s padding to land where the rows would have.
  noBoard: {
    padding: 16,
    fontSize: 13,
    color: colors.textFaint,
    lineHeight: 18,
  },
  help: {
    fontSize: 13,
    color: colors.textFaint,
    lineHeight: 18,
  },
  // A label for a control inside a section, one step down from `sectionTitle`. The Desk section is
  // the only one with two subjects under one heading — the desk itself, and what it writes in — so
  // it is the only one that needs one.
  deskLabel: {
    fontFamily: fonts.semibold,
    fontSize: 14,
    color: colors.text,
  },
  field: {
    gap: 8,
  },
  // A label and a control on one line, with the control at the trailing edge — the shape the
  // platform's own settings use for a switch, and the only row on this screen that has one.
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.md,
  },
  switchLabel: {
    flex: 1,
    fontFamily: fonts.medium,
    fontSize: 15,
    color: colors.text,
  },
  // A hairline above a row, to separate the switches that answer to the master one from the master
  // one itself. `space.md` of air above the rule and the row's own gap below it, so the line sits
  // between two rows rather than crowding the one it belongs to.
  ruled: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    paddingTop: space.md,
  },
  // The six lead chips. They wrap because six of them do not fit a phone's width, and a row that
  // scrolled sideways would hide the shortest lead behind an edge with nothing to say it is there.
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.sm,
  },
  timeRow: {
    flexDirection: 'row',
    gap: space.md,
  },
  timeField: {
    flex: 1,
    gap: space.xs,
  },
  hostRow: {
    flexDirection: 'row',
  },
  hostInput: {
    flex: 1,
    height: 48,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    paddingHorizontal: 14,
    color: colors.text,
    fontSize: 16,
  },
  error: {
    fontSize: 13,
    color: colors.down,
  },
  saved: {
    fontSize: 13,
    color: colors.up,
  },
})

// The three tones a settings row can report in, as the style each draws in. One table for the
// file: the desk section and the news-URL editor both report the same three outcomes, and two
// copies would mean adding a fourth tone twice with nothing to make the second edit happen.
// Below `styles` because it reads them, and read at render time either way.
const TONE = { ok: styles.saved, info: styles.help, error: styles.error } as const
