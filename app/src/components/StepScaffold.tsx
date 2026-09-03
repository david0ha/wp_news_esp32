import { type ReactNode } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { Screen } from './Screen'
import { Button } from './Button'
import { BackButton } from './BackButton'
import { colors, fonts, layout } from '../theme'

/**
 * Shared chrome for every onboarding step: an optional back-circle + skip bar, the progress bar,
 * a content slot, and the bottom CTA. The skip control's word is the caller's — see `skipLabel`.
 */
export function StepScaffold({
  progress,
  onBack,
  onSkip,
  skipLabel = 'SKIP',
  ctaLabel,
  onNext,
  canProceed = true,
  ctaVariant = 'primary',
  loading = false,
  aurora = false,
  children,
}: {
  progress: number
  onBack?: () => void
  onSkip?: () => void
  /**
   * What the top-right control is called. It exists because one wizard now spells two different
   * actions in the same slot, and giving them the same word would be the trap: news.tsx's SKIP
   * clears the field and advances one step — the user stays in setup — while turn-on and wifi-list
   * hand back a control that leaves setup entirely. "SET UP LATER" says the second thing; SKIP
   * stays the default so the step that already meant it reads unchanged.
   */
  skipLabel?: string
  ctaLabel: string
  onNext: () => void
  canProceed?: boolean
  ctaVariant?: 'primary' | 'secondary'
  loading?: boolean
  /** Forwarded to Screen — the hero steps (turn-on) get the aurora wash per §6.8. */
  aurora?: boolean
  children: ReactNode
}) {
  return (
    <Screen aurora={aurora}>
      <View style={styles.topBar}>
        {onBack ? <BackButton onPress={onBack} /> : <View style={styles.backSpacer} />}
        {onSkip ? (
          <Pressable accessibilityRole="button" accessibilityLabel={skipLabel} onPress={onSkip} style={styles.skipHit}>
            <Text style={styles.skip}>{skipLabel}</Text>
          </Pressable>
        ) : null}
      </View>

      <View style={styles.progressTrack}>
        <View style={[styles.progressFill, { width: `${Math.max(0, Math.min(1, progress)) * 100}%` }]} />
      </View>

      <View style={styles.content}>{children}</View>

      <View style={styles.ctaWrap}>
        <Button label={ctaLabel} onPress={onNext} disabled={!canProceed} loading={loading} variant={ctaVariant} />
      </View>
    </Screen>
  )
}

const styles = StyleSheet.create({
  topBar: {
    height: 64,
    paddingHorizontal: layout.gutter,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  backSpacer: {
    width: 42,
    height: 42,
  },
  skipHit: {
    minHeight: 44,
    minWidth: 44,
    alignItems: 'flex-end',
    justifyContent: 'center',
  },
  skip: {
    fontFamily: fonts.semibold,
    fontSize: 14,
    color: colors.textDim,
    letterSpacing: 0.5,
  },
  progressTrack: {
    height: 4,
    marginHorizontal: layout.gutter,
    borderRadius: 2,
    backgroundColor: colors.surfaceAlt,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    borderRadius: 2,
    backgroundColor: colors.accent,
  },
  content: {
    flex: 1,
    paddingHorizontal: layout.gutter,
  },
  ctaWrap: {
    paddingHorizontal: layout.gutter,
    paddingBottom: 8,
  },
})
