import { useCallback, useEffect, useState } from 'react'
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import { useIsFocused, useRouter } from 'expo-router'
import Constants from 'expo-constants'
import { Screen } from '../../components/Screen'
import { BackButton } from '../../components/BackButton'
import { Button } from '../../components/Button'
import { Card } from '../../components/Card'
import { InfoRow } from '../../components/InfoRow'
import { Standing } from '../../components/Standing'
import { useDevice } from '../../lib/device'
import { invalidateDeskSettings, useDeviceState } from '../../lib/queries'
import { Esp32Error, humanError } from '../../lib/esp32'
import { createDeskClient, deskHumanError } from '../../lib/desk'
import {
  clearDeskToken,
  deskTestResultLine,
  getDeskToken,
  getDeskUrl,
  hasDeskToken,
  setDeskToken,
  setDeskUrl,
  validateDeskUrl,
} from '../../lib/settings'
import { DEFAULT_HOST, discoverDevice } from '../../lib/discovery'
import { clearDeviceBaseUrl, getDeviceBaseUrl } from '../../lib/store'
import { ONBOARDING_ROUTES } from '../../onboarding/flow'
import { validateNewsUrl, newsUrlErrorMessage } from '../../lib/newsurl'
import { PAGE_LABELS, fetchResultLabel, fetchResultMessage } from '../../lib/format'
import { colors, radius, spacing, typography } from '../../theme/index'

/**
 * Settings — the desk, the board and the app, in that order (plan Design > Wireframes: what an
 * OWNER configures once and rarely returns to). All chrome, same as Desk: nothing here is a sheet
 * of paper, it is the app admitting what it is connected to.
 */
export default function Settings() {
  const router = useRouter()
  return (
    <Screen>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.titleRow}>
          <BackButton onPress={() => router.back()} />
          <Text style={[typography.uiStrong, styles.title]}>Settings</Text>
          <View style={styles.backSpacer} />
        </View>

        <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
          <DeskSection />
          <BoardSection />
          <AboutSection />
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  )
}

// ---------------------------------------------------------------------------
// DESK — the desk's address and operator token, plus a live test of both.
// ---------------------------------------------------------------------------

type TestState =
  | { kind: 'idle' }
  | { kind: 'testing' }
  | { kind: 'ok'; message: string }
  | { kind: 'error'; message: string }

function DeskSection() {
  const [urlLoaded, setUrlLoaded] = useState(false)
  const [urlDraft, setUrlDraft] = useState('')
  const [urlError, setUrlError] = useState<string | null>(null)
  const [urlSaved, setUrlSaved] = useState(false)
  const [urlSaving, setUrlSaving] = useState(false)

  const [tokenDraft, setTokenDraft] = useState('')
  const [hasToken, setHasToken] = useState(false)
  const [tokenSaving, setTokenSaving] = useState(false)
  const [tokenResult, setTokenResult] = useState<'saved' | 'cleared' | null>(null)

  const [test, setTest] = useState<TestState>({ kind: 'idle' })

  // Prefill the address (plain text, echoed back by the desk client itself) — never the token,
  // which is SecureStore's alone. `hasDeskToken()` only reports whether one exists.
  useEffect(() => {
    ;(async () => {
      const [url, has] = await Promise.all([getDeskUrl(), hasDeskToken()])
      setUrlDraft(url ?? '')
      setHasToken(has)
      setUrlLoaded(true)
    })()
  }, [])

  const saveUrl = async () => {
    setUrlSaving(true)
    setUrlSaved(false)
    setUrlError(null)
    const result = await setDeskUrl(urlDraft)
    setUrlSaving(false)
    if (!result.ok) {
      setUrlError(result.error ?? 'That address didn’t work.')
      return
    }
    setUrlSaved(true)
    await invalidateDeskSettings()
  }

  // An empty field clears the token — settings.ts's own rule (`setDeskToken('')` calls
  // `clearDeskToken()`), and the button's label says so before it happens rather than after.
  const tokenWillClear = tokenDraft.trim() === '' && hasToken
  const tokenActionable = tokenDraft.trim() !== '' || hasToken

  const saveToken = async () => {
    setTokenSaving(true)
    setTokenResult(null)
    const willClear = tokenDraft.trim() === ''
    await setDeskToken(tokenDraft)
    setHasToken(!willClear)
    setTokenDraft('')
    setTokenSaving(false)
    setTokenResult(willClear ? 'cleared' : 'saved')
    await invalidateDeskSettings()
  }

  // Against whatever is TYPED right now, not what's saved — an untyped token field falls back to
  // the saved one (fetched fresh, never held in render state) so a first "is this still working"
  // tap tests the real configuration rather than nothing at all.
  const testConnection = async () => {
    setTest({ kind: 'testing' })
    const url = validateDeskUrl(urlDraft)
    if (!url.ok || !url.value) {
      setTest({ kind: 'error', message: url.error ?? 'That doesn’t look like a valid address.' })
      return
    }
    const token = tokenDraft.trim() !== '' ? tokenDraft.trim() : ((await getDeskToken()) ?? '')
    try {
      const client = createDeskClient({ baseUrl: url.value, token })
      const state = await client.getState()
      setTest({ kind: 'ok', message: deskTestResultLine(state) })
    } catch (e) {
      setTest({
        kind: 'error',
        message: deskHumanError(e, 'Couldn’t reach the desk. Check the address.'),
      })
    }
  }

  return (
    <View style={styles.section}>
      <Standing label="DESK" tone="chrome" />

      <View style={styles.field}>
        <Text style={styles.label}>Address</Text>
        <TextInput
          value={urlDraft}
          onChangeText={(t) => {
            setUrlDraft(t)
            setUrlSaved(false)
            setUrlError(null)
            setTest({ kind: 'idle' })
          }}
          placeholder="https://claudepost.example"
          placeholderTextColor={colors.deskFaint}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          style={styles.input}
          onSubmitEditing={saveUrl}
        />
        {urlError ? <Text style={styles.error}>{urlError}</Text> : null}
        {urlSaved ? <Text style={styles.saved}>Saved.</Text> : null}
        <Button
          label="Save the address"
          variant="secondary"
          disabled={!urlLoaded || urlDraft.trim() === ''}
          loading={urlSaving}
          onPress={saveUrl}
        />
      </View>

      <View style={styles.field}>
        <Text style={styles.label}>Operator token</Text>
        <Text style={styles.help}>
          Reads and changes everything on the desk. Stored on this device only — this field never
          shows a token that’s already saved.
        </Text>
        <TextInput
          value={tokenDraft}
          onChangeText={(t) => {
            setTokenDraft(t)
            setTokenResult(null)
          }}
          placeholder={hasToken ? '•••••••• saved — type to replace it' : 'paste the operator token'}
          placeholderTextColor={colors.deskFaint}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          style={styles.input}
          onSubmitEditing={saveToken}
        />
        {tokenResult === 'saved' ? <Text style={styles.saved}>Saved.</Text> : null}
        {tokenResult === 'cleared' ? <Text style={styles.saved}>Cleared.</Text> : null}
        <Button
          label={tokenWillClear ? 'Clear token' : 'Save token'}
          variant="secondary"
          disabled={!tokenActionable}
          loading={tokenSaving}
          onPress={saveToken}
        />
      </View>

      <Button
        label="Test the connection"
        variant="secondary"
        loading={test.kind === 'testing'}
        onPress={testConnection}
      />
      {test.kind === 'ok' ? <Text style={styles.saved}>{test.message}</Text> : null}
      {test.kind === 'error' ? <Text style={styles.error}>{test.message}</Text> : null}
    </View>
  )
}

// ---------------------------------------------------------------------------
// BOARD — identity, pairing, discovery, and the snapshot source it fetches.
// ---------------------------------------------------------------------------

function BoardSection() {
  const router = useRouter()
  const { client, baseUrl, hasDevice, setBaseUrl } = useDevice()
  // Gated on focus for the same reason the Board tab is: this poll runs every five seconds and
  // every request restarts the board's awake window. Settings stays mounted underneath the pairing
  // wizard pushed over it, and the wizard is precisely when the board is being asked other things.
  const isFocused = useIsFocused()
  const deviceState = useDeviceState(hasDevice && isFocused)
  const state = deviceState.data

  const [reconnecting, setReconnecting] = useState(false)
  const [reconnectMsg, setReconnectMsg] = useState<string | null>(null)

  const findBoard = useCallback(async () => {
    setReconnecting(true)
    setReconnectMsg(null)
    try {
      const saved = await getDeviceBaseUrl()
      const found = await discoverDevice([state?.ip, saved, baseUrl, `http://${DEFAULT_HOST}`])
      if (found) {
        await setBaseUrl(found)
        setReconnectMsg(`Found your board at ${found.replace(/^https?:\/\//, '')}.`)
        deviceState.refetch()
      } else {
        setReconnectMsg('Couldn’t find the board. Make sure it’s powered on and on this Wi-Fi.')
      }
    } finally {
      setReconnecting(false)
    }
  }, [state?.ip, baseUrl, setBaseUrl, deviceState])

  const pairBoard = async () => {
    // Drop the saved board first: pairing a NEW one that then fails to join must not leave this
    // screen pointed at whichever board used to answer here.
    await clearDeviceBaseUrl()
    router.push(ONBOARDING_ROUTES['turn-on'])
  }

  return (
    <View style={styles.section}>
      <Standing label="BOARD" tone="chrome" />

      {!hasDevice ? (
        <Text style={styles.help}>No board paired yet.</Text>
      ) : state ? (
        <Card style={styles.rows}>
          <InfoRow label="Model" value={state.model || '—'} />
          <InfoRow label="On the panel" value={state.pageTitle || PAGE_LABELS[state.page] || '—'} />
          <InfoRow label="Firmware" value={state.fw || '—'} />
          <InfoRow label="Device ID" value={state.deviceId || '—'} />
          <InfoRow label="IP" value={state.ip || baseUrl?.replace(/^https?:\/\//, '') || '—'} last />
        </Card>
      ) : deviceState.isError ? (
        <Text style={styles.error}>
          {humanError(deviceState.error, 'Couldn’t reach the board.')}
        </Text>
      ) : (
        <Text style={styles.help}>Reading the board…</Text>
      )}

      <Button label="Pair a board" variant="secondary" onPress={pairBoard} />

      {reconnectMsg ? <Text style={styles.saved}>{reconnectMsg}</Text> : null}
      <Button label="Find board" variant="secondary" loading={reconnecting} onPress={findBoard} />

      <Text style={styles.help}>
        The address the board fetches its news from. Clear it and save to put the board back on
        its built-in demo data.
      </Text>
      {state && state.source.lastResult !== 'ok' ? (
        <Text style={styles.help}>{fetchResultMessage(state.source.lastResult)}</Text>
      ) : null}
      {state ? (
        <Text style={styles.help}>Last poll: {fetchResultLabel(state.source.lastResult)}.</Text>
      ) : null}
      <NewsUrlEditor
        // Remount when the board reports a different URL, so the field picks up the new value
        // instead of holding a draft the board has already moved past.
        key={state?.source.url ?? ''}
        initial={state?.source.url ?? ''}
        onSave={async (next) => {
          if (!client) return 'Not connected to the board.'
          try {
            await client.setNewsUrl(next)
          } catch (e) {
            if (e instanceof Esp32Error && e.code === 'news_url_invalid') {
              return 'The board wouldn’t accept that address.'
            }
            return 'Couldn’t update. Please try again.'
          }
          deviceState.refetch()
          return null
        }}
      />
    </View>
  )
}

/**
 * The snapshot-URL field. Prefilled with what the board reports, validated locally against the
 * firmware's own rule before any request goes out, and explicit about the empty case: clearing the
 * field and saving is a real, supported action (back to the demo snapshot), not a mistake.
 *
 * Moved verbatim from the pre-redesign screen — only the container styling below is new.
 *
 * `onSave` returns null on success or a sentence to show on failure.
 */
function NewsUrlEditor({
  initial,
  onSave,
}: {
  initial: string
  onSave: (value: string) => Promise<string | null>
}) {
  const [draft, setDraft] = useState(initial)
  const [saving, setSaving] = useState(false)
  const [done, setDone] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  const result = validateNewsUrl(draft)
  const localError = !result.ok ? newsUrlErrorMessage(result) : null
  const dirty = draft.trim() !== initial.trim()

  const save = async () => {
    if (!result.ok) return
    setSaving(true)
    setDone(false)
    setFailure(null)
    const err = await onSave(result.value ?? '')
    setSaving(false)
    if (err) setFailure(err)
    else setDone(true)
  }

  return (
    <View style={styles.field}>
      <TextInput
        value={draft}
        onChangeText={(t) => {
          setDraft(t)
          setDone(false)
          setFailure(null)
        }}
        placeholder="http://mymac.local:8123/news.json"
        placeholderTextColor={colors.deskFaint}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        style={styles.input}
        onSubmitEditing={save}
      />
      {localError ? <Text style={styles.error}>{localError}</Text> : null}
      {failure ? <Text style={styles.error}>{failure}</Text> : null}
      {done ? (
        <Text style={styles.saved}>
          {draft.trim() ? 'Saved. The board is fetching it now.' : 'Cleared — the board is back on demo data.'}
        </Text>
      ) : null}
      <Button
        label={dirty && !draft.trim() ? 'Clear and use demo data' : 'Save the address'}
        variant="secondary"
        disabled={!result.ok || !dirty}
        loading={saving}
        onPress={save}
      />
    </View>
  )
}

// ---------------------------------------------------------------------------
// ABOUT — the app itself.
// ---------------------------------------------------------------------------

function AboutSection() {
  const version = Constants.expoConfig?.version ?? '—'
  return (
    <View style={styles.section}>
      <Standing label="ABOUT" tone="chrome" />
      <Card style={styles.rows}>
        <InfoRow label="App version" value={version} last />
      </Card>
    </View>
  )
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing[16],
    height: 56,
  },
  title: {
    fontSize: 18,
    color: colors.deskText,
  },
  backSpacer: {
    width: 42,
  },
  body: {
    paddingHorizontal: spacing[16],
    paddingTop: spacing[12],
    paddingBottom: spacing[32],
    gap: spacing[32],
  },
  section: {
    gap: spacing[12],
  },
  rows: {
    padding: 0,
    overflow: 'hidden',
  },
  label: {
    ...typography.uiStrong,
    fontSize: 14,
    color: colors.deskText,
  },
  help: {
    ...typography.ui,
    fontSize: 13,
    color: colors.deskFaint,
    lineHeight: 18,
  },
  field: {
    gap: spacing[8],
  },
  input: {
    height: 48,
    borderRadius: radius.md,
    borderCurve: 'continuous',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.deskFaint,
    backgroundColor: colors.deskRaised,
    paddingHorizontal: 14,
    color: colors.deskText,
    fontSize: 16,
  },
  error: {
    ...typography.ui,
    fontSize: 13,
    color: colors.signal.chrome.down,
  },
  saved: {
    ...typography.ui,
    fontSize: 13,
    color: colors.signal.chrome.up,
  },
})
