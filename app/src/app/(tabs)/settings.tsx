import { useCallback, useEffect, useState } from 'react'
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import { useFocusEffect, useRouter } from 'expo-router'
import { Screen } from '../../components/Screen'
import { Button } from '../../components/Button'
import { Card } from '../../components/Card'
import { InfoRow } from '../../components/InfoRow'
import { useDevice } from '../../lib/device'
import { humanError, type DeviceInfo, type DeviceState } from '../../lib/esp32'
import { DEFAULT_HOST, discoverDevice, normalizeBaseUrl } from '../../lib/discovery'
import { clearNewsUrlPending, getDeviceBaseUrl, getNewsUrl, isNewsUrlPending, saveNewsUrl } from '../../lib/store'
import {
  decideNewsUrlSave,
  settleNewsUrlSync,
  syncPendingNewsUrl,
  type NewsUrlSaveDecision,
  type NewsUrlSaveOutcome,
} from '../../lib/newsurlsync'
import { wizardEntryHref } from '../../onboarding/flow'
import { validateNewsUrl, newsUrlErrorMessage } from '../../lib/newsurl'
import { fetchResultLabel, fetchResultMessage, formatAge, formatInterval } from '../../lib/format'
import { colors, fonts, layout, radius, space, type } from '../../theme'

export default function Settings() {
  const router = useRouter()
  const { client, baseUrl, hasDevice, setBaseUrl, forgetBoard } = useDevice()

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
        setReconnectMsg(`Found your board at ${found.replace(/^https?:\/\//, '')}.`)
        loadInfo()
      } else {
        setReconnectMsg('Couldn’t find the board. Make sure it’s powered on and on this Wi-Fi.')
      }
    } finally {
      setReconnecting(false)
    }
  }, [info?.ip, setBaseUrl, loadInfo])

  const applyHost = async () => {
    setSaved(false)
    const norm = normalizeBaseUrl(host)
    if (!norm.ok) {
      setHostError('That doesn’t look like a valid IP address or hostname.')
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
          <Text style={styles.title}>Settings</Text>
        </View>

        <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
          {/* Board identity */}
          <Section title="Board">
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
                <Text style={styles.noBoard}>No board set up on this phone.</Text>
              ) : infoError ? (
                <Pressable onPress={loadInfo} accessibilityRole="button" style={styles.infoRetry}>
                  <Text style={styles.infoRetryText}>Couldn’t reach the board. Tap to retry.</Text>
                </Pressable>
              ) : (
                <>
                  <InfoRow label="Model" value={info?.model || '—'} />
                  <InfoRow label="Firmware" value={info?.fw || '—'} />
                  <InfoRow label="Device ID" value={info?.deviceId || '—'} />
                  <InfoRow label="IP" value={info?.ip || baseUrl?.replace(/^https?:\/\//, '') || '—'} last />
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
          <Section title="News source">
            <Text style={styles.help}>
              The address today’s edition is fetched from — by this phone on the Today tab, and
              by the board when it has one. Clear it and save to fall back to the built-in demo
              edition.
            </Text>
            {source ? (
              <Card style={styles.infoCard}>
                <InfoRow label="Last poll" value={fetchResultLabel(source.lastResult)} />
                <InfoRow label="Last success" value={formatAge(source.ageSeconds)} />
                <InfoRow label="Polls" value={formatInterval(source.pollSeconds)} last />
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
                onSave={async (next) => {
                  setSyncRejected(null)
                  // What the attempt means — persist or not, pending or not, which voice — is
                  // `decideNewsUrlSave`'s, tested as a rule. This site only makes the attempt and
                  // does what the decision says. The one thing it does before the attempt is wait
                  // for any delivery already on the wire: a POST of an older address racing this
                  // one would land in whichever order the board took them.
                  let outcome: NewsUrlSaveOutcome
                  if (!client) {
                    outcome = { noClient: true }
                  } else {
                    await settleNewsUrlSync()
                    try {
                      await client.setNewsUrl(next)
                      outcome = { ok: true }
                    } catch (e) {
                      outcome = { error: e }
                    }
                  }
                  const decision = decideNewsUrlSave(next, outcome, hasDevice)
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
          <Section title="Connection">
            <Text style={styles.help}>
              The app finds your board at {DEFAULT_HOST}. If that doesn’t work on your network,
              enter its IP address or hostname here.
            </Text>
            <View style={styles.hostRow}>
              <TextInput
                value={host}
                onChangeText={(t) => {
                  setHost(t)
                  setHostError(null)
                  setSaved(false)
                }}
                placeholder={`192.168.0.42 or ${DEFAULT_HOST}`}
                placeholderTextColor={colors.textFaint}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                style={styles.hostInput}
                onSubmitEditing={applyHost}
              />
            </View>
            {hostError ? <Text style={styles.error}>{hostError}</Text> : null}
            {saved ? <Text style={styles.saved}>Saved.</Text> : null}
            <Button label="Use this address" variant="secondary" onPress={applyHost} />

            <Text style={styles.help}>
              Rejoined your home Wi-Fi? Find the board automatically on this network.
            </Text>
            {reconnectMsg ? <Text style={styles.saved}>{reconnectMsg}</Text> : null}
            <Button label="Find board" variant="secondary" loading={reconnecting} onPress={reconnect} />
          </Section>

          {/* Re-enter the wizard, or disown the board on file */}
          <Section title="Setup">
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
              label={hasDevice ? 'Set up a different board' : 'Set up my board'}
              variant={hasDevice ? 'ghost' : 'primary'}
              onPress={() => router.push(wizardEntryHref('setup'))}
            />
            {hasDevice ? (
              <Button label="Forget this board" variant="ghost" onPress={forget} />
            ) : null}
            {/*
              Shown only when the removal itself failed. The rest of the screen has already agreed
              the board is gone — that part is honest, this session is done with it — but the key is
              still on disk and the next cold launch will read it back. Saying nothing here would
              make that look like the app undoing a deliberate act on its own.
            */}
            {forgetFailed ? (
              <Text style={styles.help}>
                Forgotten for now, but it couldn’t be removed from this phone’s storage — it may
                come back the next time you open the app.
              </Text>
            ) : null}
          </Section>
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
 * The snapshot-URL field. Prefilled with the address in force, validated locally against the
 * firmware's own rule before any request goes out, and explicit about the empty case: clearing the
 * field and saving is a real, supported action (back to the demo snapshot), not a mistake.
 *
 * `onSave` answers with a `NewsUrlSaveDecision`, and this component only draws it: `ok` is green;
 * `info` is the help voice, because the phone has done what was asked and the sentence is
 * information rather than a verdict; `error` is red, and is the only one that leaves the field
 * dirty, because the address in it is not saved anywhere. `pending` is the standing version of
 * `info` — an address on this phone the board has not been told about — and is said in the same
 * voice for the same reason.
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
  onSave,
}: {
  initial: string
  pending: boolean
  /** Tri-state, from `useDevice`. `null` is "storage has not answered", never "no board". */
  hasBoard: boolean | null
  onSave: (value: string) => Promise<NewsUrlSaveDecision>
}) {
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

  const toneStyle = { ok: styles.saved, info: styles.help, error: styles.error } as const

  return (
    <View style={styles.field}>
      <View style={styles.hostRow}>
        <TextInput
          value={draft}
          onChangeText={(t) => {
            setDraft(t)
            setOutcome(null)
          }}
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
      {outcome ? <Text style={toneStyle[outcome.tone]}>{outcome.message}</Text> : null}
      {pending && !outcome && !dirty ? (
        <Text style={styles.help}>
          {hasBoard === false
            ? 'Today reads from this address. A board you set up later will get it too.'
            : 'Not yet on the board — it will be sent the next time this app reaches it.'}
        </Text>
      ) : null}
      <Button
        label={dirty && !draft.trim() ? 'Clear and use demo data' : 'Save address'}
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
  field: {
    gap: 8,
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
