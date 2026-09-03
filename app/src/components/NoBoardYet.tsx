// The one implementation of "this phone has no board", shown by the Board tab and by Preview.
//
// It exists as a component rather than as two blocks of JSX because the two screens that need it
// reach it from opposite directions — Board draws it as its ordinary resting state for a skipper,
// Preview only ever from a deep link — and a copy written for one of those reads wrong on the
// other within a release or two. There is a second reason to keep it in one place: the copy is the
// feature. Everything else the app can say about a missing board is a diagnosis of hardware
// ("press a button on it", "make sure it's powered on"), and saying any of that to somebody who
// owns none is how the old single-bit gate made the app feel broken. This block says the true
// thing instead — there is no board, the rest of the app works anyway, here are the two ways to
// get one — and it is deliberately structured as the same empty state Markets already uses for an
// empty watchlist, so a boardless phone reads as a normal app in a normal state rather than as an
// error screen.

import { useEffect, useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { useRouter } from 'expo-router'
import { Button } from './Button'
import { IconBadge } from './IconBadge'
import { useDevice } from '../lib/device'
import { DEFAULT_HOST, discoverDevice } from '../lib/discovery'
import { isSetupSkipped } from '../lib/store'
import { wizardEntryHref } from '../onboarding/flow'
import { colors, layout, space, type } from '../theme'

export function NoBoardYet() {
  const router = useRouter()
  const { setBaseUrl } = useDevice()

  // Null until storage answers, and the reason this is not simply `false` to start is the same one
  // that makes `hasDevice` tri-state: rendering the "you set this aside" sentence and then taking
  // it away a tick later is worse than rendering it a tick late. Everything above it — icon,
  // title, body, both buttons — draws on the first frame; only this one sentence waits.
  const [skipped, setSkipped] = useState<boolean | null>(null)
  const [probing, setProbing] = useState(false)
  const [probeMessage, setProbeMessage] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    void (async () => {
      const s = await isSetupSkipped()
      if (active) setSkipped(s)
    })()
    return () => {
      active = false
    }
  }, [])

  // "I already have one on this network." A board provisioned from the desk, or one this phone has
  // simply never been told about, is already on the LAN answering to its mDNS name — putting that
  // user through the SoftAP wizard would have them join an access point to configure Wi-Fi the
  // board is demonstrably already on. One probe of `claudepost.local` is the whole shortcut.
  //
  // The saved address is deliberately not a candidate here the way it is in Board's `retry()`:
  // this component only renders when there is no saved address, so there is nothing else to try.
  const findBoard = async () => {
    setProbing(true)
    setProbeMessage(null)
    try {
      const found = await discoverDevice([`http://${DEFAULT_HOST}`])
      // A board that answers the probe but whose address `setBaseUrl` then refuses is not a board
      // the user can be told about, so both misses collapse to the same line. Success needs no
      // message at all: the provider flips `hasDevice`, the screen above swaps to the real board,
      // and a toast about it would be announcing something the user is already looking at.
      if (found !== null && (await setBaseUrl(found))) return
      setProbeMessage('Couldn’t find a board on this Wi-Fi.')
    } finally {
      setProbing(false)
    }
  }

  return (
    <View style={styles.empty}>
      <IconBadge name="hardware-chip" />
      <Text style={styles.emptyTitle}>No board yet</Text>
      <Text style={styles.emptyBody}>
        Claude Post prints one company a day on a 13.3-inch e-paper sheet. Your watchlist, charts
        and ticker search all work without one.
      </Text>
      {/* Its own Text rather than another sentence inside the paragraph above: appended, it would
          re-wrap the whole paragraph the moment storage answers, and the visible effect of that is
          the body silently jumping a line under the reader's eyes. */}
      {skipped === true ? (
        <Text style={styles.emptyBody}>You set this aside earlier — it’s still here when you want it.</Text>
      ) : null}
      <Button label="Set up my board" onPress={() => router.push(wizardEntryHref('setup'))} />
      <Button
        label="I already have one on this network"
        variant="ghost"
        loading={probing}
        onPress={() => void findBoard()}
      />
      {probeMessage !== null ? <Text style={styles.probeMessage}>{probeMessage}</Text> : null}
    </View>
  )
}

const styles = StyleSheet.create({
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.lg,
    paddingHorizontal: layout.gutter,
    paddingBottom: space.xxl,
  },
  emptyTitle: {
    ...type.heading,
    textAlign: 'center',
  },
  emptyBody: {
    ...type.body,
    color: colors.textDim,
    textAlign: 'center',
    maxWidth: 280,
  },
  // Dim, not red: nothing failed. The board was asked for and did not answer, which for a user who
  // has not set one up yet is the expected outcome and not an error to be alarmed by.
  probeMessage: {
    ...type.caption,
    textAlign: 'center',
    maxWidth: 280,
  },
})
