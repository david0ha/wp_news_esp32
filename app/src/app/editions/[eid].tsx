import { useState } from 'react'
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { Image } from 'expo-image'
import { Ionicons } from '@expo/vector-icons'
import * as Haptics from 'expo-haptics'
import { Stack, useLocalSearchParams, useRouter } from 'expo-router'
import Animated, { useReducedMotion } from 'react-native-reanimated'
import { Button } from '../../components/Button'
import { Card } from '../../components/Card'
import { EmptyState } from '../../components/EmptyState'
import { InfoRow } from '../../components/InfoRow'
import { ScreenMessage } from '../../components/ScreenMessage'
import { Screen } from '../../components/Screen'
import { Sheet } from '../../components/Sheet'
import { Standing } from '../../components/Standing'
import { Stamp } from '../../components/Stamp'
import {
  useDeskClient,
  useDeskNow,
  useEdition,
  usePromote,
  useSheet,
} from '../../lib/queries'
import { DeskError, deskHumanError } from '../../lib/desk'
import { editionWhen, promoteResultLine } from '../../lib/editions'
import { sheetForPage } from '../../lib/sheets'
import { pageLabel } from '../../lib/format'
import { SCREEN_W, SCREEN_H } from '../../lib/screen'
import { colors, pressTransition, pressedScale, radius, spacing, typography } from '../../theme/index'

const SHEET_ASPECT = SCREEN_W / SCREEN_H
const PAGES = [0, 1] as const

/**
 * One edition's record (Task 30) — meta, its proof sheets as small thumbnails onto the full
 * viewer, **Promote this edition**, and a link to its dossier when it filed one.
 *
 * Reached from the editions list, from `StateStrip`'s Current row, or a deep link — never a tab of
 * its own, so the native header carries the id the way `watch/[symbol]` carries a symbol.
 */
export default function EditionDetail() {
  const router = useRouter()
  const params = useLocalSearchParams<{ eid: string }>()
  const eid = params.eid ?? ''

  const client = useDeskClient()
  const edition = useEdition(eid)
  const now = useDeskNow()
  const promote = usePromote()
  const [promoteMessage, setPromoteMessage] = useState<string | null>(null)

  const title = eid.slice(0, 8)

  const onPromote = () => {
    promote.mutate(eid, {
      onSuccess: (result) => {
        setPromoteMessage(promoteResultLine(result))
        // One haptic, paired with the line above it (`Composer`'s own rule): the desk answered,
        // whether or not anything on the wall actually changed — "unchanged" is still an answer.
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)
      },
    })
  }

  if (client === null) {
    return (
      <Screen edges={['top']}>
        <Stack.Screen options={{ title }} />
        <EmptyState
          title="No desk yet"
          body="Add its address and operator token in Settings, and its editions appear here."
          actionLabel="Open settings"
          onAction={() => router.push('/settings')}
        />
      </Screen>
    )
  }

  return (
    <Screen edges={['top']}>
      <Stack.Screen options={{ title }} />

      {edition.isLoading ? (
        <ScreenMessage loading />
      ) : edition.isError ? (
        <ScreenMessage
          error={
            edition.error instanceof DeskError
              ? deskHumanError(edition.error)
              : 'Couldn’t load this edition.'
          }
          onRetry={() => edition.refetch()}
        />
      ) : !edition.data ? (
        <ScreenMessage message="The desk has no record of this edition." />
      ) : (
        <ScrollView contentContainerStyle={styles.scroll}>
          <Card style={styles.metaCard}>
            <InfoRow label="ID" value={edition.data.id.slice(0, 8)} />
            {/* Neutral, not `up` — green on this design means DIRECTION (a price moved, a change
                is positive), never "this happened successfully". `editionWhen()`'s own text
                already carries published-vs-filed; a colour on top of it would be decoration
                wearing the one colour that means something else on every other screen. */}
            <InfoRow label="When" value={editionWhen(edition.data, now) || '—'} />
            <InfoRow label="Tiles" value={String(edition.data.tile_count)} last />
          </Card>

          <View style={styles.section}>
            <Standing label="SHEETS" tone="chrome" />
            <View style={styles.thumbRow}>
              {PAGES.map((page) => {
                const name = sheetForPage(edition.data!.sheets, page)
                return name ? (
                  <SheetThumb key={page} eid={eid} page={page} name={name} />
                ) : (
                  <View key={page} style={styles.thumbMissing}>
                    <Text style={styles.thumbMissingText}>{pageLabel(page)} not on file</Text>
                  </View>
                )
              })}
            </View>
          </View>

          <View style={styles.section}>
            <Standing label="ACTIONS" tone="chrome" />
            <Button
              label="Promote this edition"
              onPress={onPromote}
              loading={promote.isPending}
              disabled={promote.isPending}
            />
            {promoteMessage ? <Stamp tone="chrome">{promoteMessage}</Stamp> : null}
            {promote.isError ? (
              <Text style={styles.error}>
                {promote.error instanceof DeskError
                  ? deskHumanError(promote.error)
                  : 'The desk didn’t take that promote.'}
              </Text>
            ) : null}

            {edition.data.has_notes ? <DossierLink eid={eid} /> : null}
          </View>
        </ScrollView>
      )}
    </Screen>
  )
}

/** One proof sheet, small — tap opens the full-size viewer at the same page. */
function SheetThumb({ eid, page, name }: { eid: string; page: 0 | 1; name: string }) {
  const router = useRouter()
  const sheet = useSheet(eid, name)
  const [pressed, setPressed] = useState(false)
  const reducedMotion = useReducedMotion()
  return (
    <Pressable
      accessibilityRole="imagebutton"
      accessibilityLabel={`${pageLabel(page)} proof. Opens it full size.`}
      onPress={() => router.push(`/sheet/proof?eid=${encodeURIComponent(eid)}&page=${page}`)}
      onPressIn={() => setPressed(true)}
      onPressOut={() => setPressed(false)}
    >
      <Animated.View
        style={[styles.thumbWrap, pressTransition, pressed && !reducedMotion && pressedScale]}
      >
        <Sheet style={styles.thumbFrame}>
          {sheet.data ? (
            <Image
              source={{ uri: sheet.data.uri, headers: sheet.data.headers }}
              style={styles.thumbImage}
              contentFit="contain"
              accessibilityIgnoresInvertColors
            />
          ) : (
            <View style={styles.thumbBlank}>
              {sheet.isLoading ? <ActivityIndicator color={colors.signal.chrome.tint} /> : null}
            </View>
          )}
        </Sheet>
        <Text style={styles.thumbLabel}>{pageLabel(page)}</Text>
      </Animated.View>
    </Pressable>
  )
}

/** "The dossier" — the link to this edition's own filed notes, when it has any. */
function DossierLink({ eid }: { eid: string }) {
  const router = useRouter()
  const [pressed, setPressed] = useState(false)
  const reducedMotion = useReducedMotion()
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel="The dossier filed with this edition"
      hitSlop={8}
      onPress={() => router.push(`/notes/editions/${encodeURIComponent(eid)}`)}
      onPressIn={() => setPressed(true)}
      onPressOut={() => setPressed(false)}
    >
      <Animated.View
        style={[styles.dossier, pressTransition, pressed && !reducedMotion && pressedScale]}
      >
        <Text style={[typography.ui, styles.dossierText]}>The dossier</Text>
        <Ionicons name="arrow-forward" size={13} color={colors.signal.chrome.tint} />
      </Animated.View>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  scroll: {
    padding: spacing[16],
    gap: spacing[24],
  },
  metaCard: {
    padding: 0,
    overflow: 'hidden',
  },
  section: {
    gap: spacing[12],
  },
  thumbRow: {
    flexDirection: 'row',
    gap: spacing[16],
  },
  thumbWrap: {
    flex: 1,
    gap: spacing[8],
  },
  thumbFrame: {
    aspectRatio: SHEET_ASPECT,
    padding: 0,
    overflow: 'hidden',
  },
  thumbImage: {
    width: '100%',
    height: '100%',
  },
  thumbBlank: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  thumbLabel: {
    ...typography.label,
    color: colors.deskDim,
    textAlign: 'center',
  },
  thumbMissing: {
    flex: 1,
    aspectRatio: SHEET_ASPECT,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.deskFaint,
    borderRadius: radius.paper,
  },
  thumbMissingText: {
    ...typography.ui,
    fontSize: 12,
    color: colors.deskFaint,
    textAlign: 'center',
    paddingHorizontal: spacing[8],
  },
  error: {
    ...typography.ui,
    fontSize: 13,
    color: colors.signal.chrome.down,
    lineHeight: 18,
  },
  dossier: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[4],
    minHeight: 32,
  },
  dossierText: {
    fontSize: 13,
    color: colors.signal.chrome.tint,
  },
})
