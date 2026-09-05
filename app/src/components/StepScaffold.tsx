import { type ReactNode } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { Screen } from './Screen'
import { Button } from './Button'
import { BackButton } from './BackButton'
import { useStrings } from '../i18n'
import { colors, fonts, layout } from '../theme'

/**
 * Shared chrome for every onboarding step: an optional back-circle + skip bar, the progress bar,
 * a content slot, and the bottom CTA. The skip control's word is the caller's — see `skipLabel`.
 */
export function StepScaffold({
  progress,
  onBack,
  onSkip,
  skipLabel,
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
   *
   * The default is read from the catalogue below rather than written here as a literal, which is
   * the whole reason it is `?: string` and not `= 'SKIP'`: a default argument cannot read the
   * language, and an English word baked into this signature would be the one control on the wizard
   * that never translates.
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
  // The hook runs on every render, not behind the `??`: `useStrings()` is a `useContext` and a
  // short-circuited one would change the hook order between a caller that passes a label and one
  // that does not.
  const s = useStrings()
  const skipWord = skipLabel ?? s.onboarding.nav.skip
  return (
    <Screen aurora={aurora}>
      <View style={styles.topBar}>
        {onBack ? <BackButton onPress={onBack} /> : <View style={styles.backSpacer} />}
        {onSkip ? (
          <Pressable accessibilityRole="button" accessibilityLabel={skipWord} onPress={onSkip} style={styles.skipHit}>
            <Text style={styles.skip}>{skipWord}</Text>
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
