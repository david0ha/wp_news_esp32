import { useCallback, useEffect, useState } from 'react'
import {
  ActivityIndicator,
  Image,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native'
import { useRouter } from 'expo-router'
import { Screen } from '../components/Screen'
import { BackButton } from '../components/BackButton'
import { Button } from '../components/Button'
import { useDevice } from '../lib/device'
import { Esp32Error, humanError } from '../lib/esp32'
import { SCREEN_H, SCREEN_W, decode } from '../lib/screen'
import { colors, layout, radius, space } from '../theme'

/**
 * The page on the glass, on the phone.
 *
 * `GET /api/screen` hands over the framebuffer verbatim — 960,000 bytes, no codec — and
 * src/lib/screen.ts turns it into an indexed PNG in the MEASURED Spectra 6 inks rather than the
 * saturated ones the UI draws with. The point is to judge it as paper: a preview in primaries
 * would flatter the design into a decision nobody could make from the real sheet.
 *
 * Fetched once on arrival and then only when asked. This is a megabyte off an ESP32 and about two
 * million pixels of deflate on the phone — a poll loop here would be a poll loop nobody wanted.
 */
export default function Preview() {
  const router = useRouter()
  const { client } = useDevice()
  const { width } = useWindowDimensions()

  const [png, setPng] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!client) return
    setLoading(true)
    setError(null)
    try {
      const fb = await client.fetchScreen()
      // Hand the frame back to React before the decode, so the spinner is actually on screen while
      // it runs. Everything after this yield is synchronous and takes a beat: 1.92 million pixels
      // expanded out of 960,000 bytes, deflated, and base64'd, all on the one JS thread there is.
      await new Promise((resolve) => setTimeout(resolve, 0))
      setPng(decode(fb).pngBase64)
    } catch (e) {
      setError(
        e instanceof Esp32Error ? humanError(e) : 'Couldn’t read the page off the board.',
      )
    } finally {
      setLoading(false)
    }
  }, [client])

  useEffect(() => {
    load()
  }, [load])

  // The sheet is portrait 1200 x 1600 and keeps that shape at every size; letting it stretch would
  // make a preview that cannot be compared with the thing on the wall.
  const sheetWidth = width - layout.gutter * 2
  const sheetHeight = (sheetWidth * SCREEN_H) / SCREEN_W

  return (
    <Screen>
      <View style={styles.titleRow}>
        <BackButton onPress={() => router.back()} />
        <Text style={styles.title}>On the glass</Text>
        <View style={styles.backSpacer} />
      </View>

      {png ? (
        <ScrollView
          contentContainerStyle={styles.sheetScroll}
          // Pinch to zoom. iOS gets this from UIScrollView for free; on Android the sheet is
          // simply shown at width, which is legible for the furniture and the headlines and is
          // what this preview is for.
          maximumZoomScale={4}
          minimumZoomScale={1}
          centerContent
        >
          <Image
            accessibilityLabel="The page currently printed on the board"
            source={{ uri: `data:image/png;base64,${png}` }}
            style={[styles.sheet, { width: sheetWidth, height: sheetHeight }]}
            resizeMode="contain"
          />
          <Text style={styles.note}>
            This is the framebuffer itself, in the measured inks. A frame caught mid-render can show
            part of one edition and part of the next — that is the download, not the panel. Fetch it
            again.
          </Text>
          {/* A failed REFRESH, said out loud over the sheet it failed to replace.
              This is not the same case as a failed first load, and it is the more common one: a
              board on a cell answers while it is awake, and the visit after that finds it asleep.
              Keeping the last sheet is right — it is still what is on the glass — but leaving the
              failure silent would make "Fetch it again" a button that spins and does nothing, at
              exactly the moment the awake-window sentence needs to be read. humanError() carries
              that sentence; this is the dashboard's own idiom, an error line at the foot of the
              scroll under the content it could not update. */}
          {error ? (
            <View style={styles.staleNote}>
              <Text style={styles.error}>{error}</Text>
              <Text style={styles.note}>
                The sheet above is the last one that came back, not a fresh read.
              </Text>
            </View>
          ) : null}
          <Button label="Fetch it again" variant="secondary" loading={loading} onPress={load} />
        </ScrollView>
      ) : (
        <View style={styles.center}>
          {loading ? (
            <>
              <ActivityIndicator color={colors.accent} />
              <Text style={styles.centerNote}>
                Reading 960,000 bytes off the board, then drawing them.
              </Text>
            </>
          ) : (
            <>
              <Text style={styles.error}>{error ?? 'Nothing fetched yet.'}</Text>
              {/* The awake window, said in full. A board with deep sleep on is unreachable most of
                  the time BY DESIGN — it wakes for about three seconds, asks its desk one
                  question, and goes back down without running a server. There is no fault here to
                  find, and sending someone to look for one is the failure this screen avoids. */}
              <Text style={styles.centerNote}>
                A board on a battery only answers while it is awake. Press a button on it — that
                holds it awake for a couple of minutes, and every request restarts the clock.
              </Text>
              <Button label="Try again" onPress={load} loading={loading} style={styles.retryBtn} />
            </>
          )}
        </View>
      )}
    </Screen>
  )
}

const styles = StyleSheet.create({
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: layout.gutter,
    height: 56,
  },
  title: {
    fontSize: 18,
    fontWeight: '700',
    color: colors.text,
  },
  backSpacer: {
    width: 42,
  },
  sheetScroll: {
    paddingHorizontal: layout.gutter,
    paddingBottom: 32,
    gap: space.lg,
  },
  sheet: {
    borderRadius: radius.sm,
    // The paper is a warm off-white and the app is near-black behind it. Without an edge the
    // sheet bleeds into the background and stops reading as a sheet.
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderStrong,
    backgroundColor: colors.surface,
  },
  note: {
    fontSize: 12,
    color: colors.textFaint,
    lineHeight: 17,
  },
  staleNote: {
    gap: 6,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    paddingHorizontal: 24,
  },
  centerNote: {
    fontSize: 13,
    color: colors.textDim,
    textAlign: 'center',
    lineHeight: 19,
  },
  error: {
    fontSize: 14,
    color: colors.down,
    textAlign: 'center',
    lineHeight: 20,
  },
  retryBtn: {
    marginTop: 4,
    alignSelf: 'stretch',
  },
})
