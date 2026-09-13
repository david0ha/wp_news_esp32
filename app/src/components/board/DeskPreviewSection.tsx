import { useCallback, useRef, useState } from 'react'
import {
  ActivityIndicator,
  Image,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native'
import { useFocusEffect } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Button } from '../Button'
import { Screen } from '../Screen'
import { SegmentedControl } from '../SegmentedControl'
import { createDeskClient, type BoardPreview } from '../../lib/desk'
import { getDeskToken } from '../../lib/deskToken'
import { getDeskBaseUrl } from '../../lib/store'
import { usePapers } from '../../lib/papers/list'
import { useStrings } from '../../i18n'
import { colors, fonts, layout, space } from '../../theme'

/** The desk's published sheets, independent of the board's last confirmed framebuffer. */
export function DeskPreviewSection() {
  const t = useStrings()
  const s = t.board.deskPreview
  const { width } = useWindowDimensions()
  const insets = useSafeAreaInsets()
  const { doc } = usePapers()
  const [preview, setPreview] = useState<BoardPreview | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'setup' | 'error'>('loading')
  const [page, setPage] = useState(0)
  const [expanded, setExpanded] = useState(false)
  const [imageFailed, setImageFailed] = useState(false)
  const request = useRef(0)
  const imageRequest = useRef(0)
  const load = useCallback(async () => {
    const id = ++request.current
    ++imageRequest.current
    // Clear immediately: a new focus may follow a server or credential change in Settings.
    setPreview(null)
    setExpanded(false)
    setImageFailed(false)
    setStatus('loading')
    try {
      const [baseUrl, token] = await Promise.all([getDeskBaseUrl(), getDeskToken()])
      if (id !== request.current) return
      if (!baseUrl || !token) {
        setStatus('setup')
        return
      }
      const result = await createDeskClient({ baseUrl, token }).boardPreview()
      if (id !== request.current) return
      setPreview(result)
      setPage((current) =>
        result?.sheets.some((sheet) => sheet.page === current)
          ? current
          : (result?.sheets[0]?.page ?? 0),
      )
      setStatus('ready')
    } catch {
      if (id === request.current) setStatus('error')
    }
  }, [])

  useFocusEffect(
    useCallback(() => {
      void load()
      return () => {
        ++request.current
        ++imageRequest.current
        setPreview(null)
        setExpanded(false)
      }
    }, [load, doc?.board]),
  )

  const sheet = preview?.sheets.find((item) => item.page === page)
  const sheetWidth = width - layout.gutter * 2
  const choosePage = (index: number) => {
    const selected = preview?.sheets[index]
    if (!selected || selected.page === page) return
    ++imageRequest.current
    setPage(selected.page)
    setImageFailed(false)
  }
  const imageGeneration = imageRequest.current
  const image =
    sheet && !imageFailed ? (
      <Image
        key={`${sheet.uri}:${page}`}
        accessibilityLabel={`${s.title} · A${page + 1}`}
        source={{ uri: sheet.uri, headers: sheet.headers }}
        style={[styles.sheet, { width: sheetWidth, height: (sheetWidth * 4) / 3 }]}
        resizeMode="contain"
        onError={() => {
          if (imageGeneration === imageRequest.current) setImageFailed(true)
        }}
      />
    ) : null
  const selector =
    preview && preview.sheets.length > 1 ? (
      <SegmentedControl
        segments={preview.sheets.map((item) => `A${item.page + 1}`)}
        selectedIndex={preview.sheets.findIndex((item) => item.page === page)}
        onChange={choosePage}
      />
    ) : null

  return (
    <View style={styles.section}>
      <Text style={styles.title}>{s.title}</Text>
      <Text style={styles.note}>{s.note}</Text>
      {status === 'loading' ? (
        <ActivityIndicator accessibilityLabel={s.loading} color={colors.accent} />
      ) : null}
      {status === 'setup' ? <Text style={styles.note}>{s.setup}</Text> : null}
      {status === 'error' ? <Text style={styles.error}>{s.failed}</Text> : null}
      {status === 'ready' && !sheet ? <Text style={styles.note}>{s.empty}</Text> : null}
      {selector}
      {image}
      {imageFailed ? <Text style={styles.error}>{s.imageFailed}</Text> : null}
      {sheet && !imageFailed ? (
        <Button label={s.enlarge} variant="secondary" onPress={() => setExpanded(true)} />
      ) : null}
      {status !== 'setup' ? (
        <Button
          label={status === 'error' || imageFailed ? t.common.tryAgain : s.refresh}
          variant="ghost"
          loading={status === 'loading'}
          onPress={() => void load()}
        />
      ) : null}
      <Modal
        visible={expanded && !!sheet}
        animationType="slide"
        onRequestClose={() => setExpanded(false)}
      >
        {/* A native Modal is a separate window; use the presenting screen’s known insets. */}
        <Screen edges={[]} style={{ paddingTop: insets.top, paddingBottom: insets.bottom }}>
          <View style={styles.modalHeader}>
            <Text style={styles.title}>{s.title}</Text>
            <Button label={s.close} variant="ghost" onPress={() => setExpanded(false)} />
          </View>
          <View style={styles.modalControls}>
            {selector}
            {Platform.OS === 'ios' ? <Text style={styles.note}>{s.zoom}</Text> : null}
          </View>
          <ScrollView
            key={sheet?.uri}
            style={styles.viewport}
            automaticallyAdjustContentInsets={false}
            contentInsetAdjustmentBehavior="never"
            maximumZoomScale={4}
            minimumZoomScale={1}
            contentContainerStyle={styles.zoom}
          >
            <View collapsable={false}>
              {image}
              {imageFailed ? (
                <>
                  <Text style={styles.error}>{s.imageFailed}</Text>
                  <Button
                    label={t.common.tryAgain}
                    variant="secondary"
                    onPress={() => void load()}
                  />
                </>
              ) : null}
            </View>
          </ScrollView>
        </Screen>
      </Modal>
    </View>
  )
}

const styles = StyleSheet.create({
  section: { gap: space.sm, paddingTop: space.lg },
  title: { fontFamily: fonts.bold, fontSize: 13, letterSpacing: 0.8, color: colors.textDim },
  note: { fontSize: 13, lineHeight: 19, color: colors.textFaint },
  error: { fontSize: 13, lineHeight: 19, color: colors.down },
  sheet: {
    alignSelf: 'center',
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  modalHeader: {
    paddingHorizontal: layout.gutter,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  modalControls: { paddingHorizontal: layout.gutter, gap: space.sm, paddingBottom: space.md },
  viewport: { flex: 1 },
  zoom: { paddingHorizontal: layout.gutter, paddingBottom: space.lg },
})
