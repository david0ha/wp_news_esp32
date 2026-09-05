import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { StepScaffold } from '../../components/StepScaffold'
import { IconBadge } from '../../components/IconBadge'
import { useOnboarding } from '../../onboarding/OnboardingContext'
import { canProceed, parseOnboardingFlow, progressFor, wizardStepHref } from '../../onboarding/flow'
import { validateNewsUrl, newsUrlErrorMessage } from '../../lib/newsurl'
import { useStrings } from '../../i18n'
import { colors, fonts, radius } from '../../theme'

// Where the board fetches its news snapshot from. Collected BEFORE the Wi-Fi handover so it is
// written to NVS at provisioning time and the board's very first poll after joining already has
// somewhere to go.
//
// Optional on purpose: a board with no URL runs its built-in demo snapshot, which is a complete
// product on a desk with no PC on. So this step can be skipped, and the URL added later from
// Settings — but a URL that IS typed is validated here, because the board's own rejection would
// otherwise arrive on the far side of a ~45s join.
export default function News() {
  const router = useRouter()
  const s = useStrings()
  // Read only to be handed onward. This step's chrome does not depend on why the wizard opened —
  // its SKIP clears the field and advances, and Back always has wifi-list behind it — but the flow
  // param is route-local, so a step that drops it silently ends the chain for every step after it.
  // Every forward move between steps carries it; see wizardStepHref in src/onboarding/flow.ts.
  const flow = parseOnboardingFlow(useLocalSearchParams<{ flow?: string }>().flow)
  const { newsUrl, setNewsUrl } = useOnboarding()

  const result = validateNewsUrl(newsUrl)
  const showError = !result.ok && newsUrl.trim().length > 0

  const next = () => router.push(wizardStepHref('password', flow))
  const skip = () => {
    setNewsUrl('')
    next()
  }

  return (
    <StepScaffold
      progress={progressFor('news')}
      onBack={() => router.back()}
      onSkip={skip}
      ctaLabel={s.onboarding.nav.next}
      canProceed={canProceed('news', { selectedNetwork: null, password: '', newsUrl })}
      onNext={next}
    >
      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        <View style={styles.header}>
          <IconBadge name="link" size={44} />
          <Text style={styles.caption}>{s.onboarding.news.caption}</Text>
        </View>

        <View style={styles.field}>
          <Text style={styles.label}>{s.onboarding.news.label}</Text>
          <View style={styles.inputRow}>
            <TextInput
              value={newsUrl}
              onChangeText={setNewsUrl}
              // An example URL is the same characters in every language; it stays a literal.
              placeholder="http://mymac.local:8123/news.json"
              placeholderTextColor={colors.textFaint}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              style={styles.input}
              onSubmitEditing={() => {
                if (result.ok) next()
              }}
            />
          </View>
          {showError ? (
            <Text style={styles.error}>{newsUrlErrorMessage(result)}</Text>
          ) : (
            <Text style={styles.hint}>{s.onboarding.news.hint}</Text>
          )}
        </View>
      </ScrollView>
    </StepScaffold>
  )
}

const styles = StyleSheet.create({
  body: {
    paddingTop: 16,
    paddingBottom: 24,
    gap: 24,
  },
  header: {
    alignItems: 'center',
    gap: 14,
  },
  caption: {
    fontSize: 14,
    color: colors.textDim,
    textAlign: 'center',
    lineHeight: 20,
  },
  field: {
    gap: 8,
  },
  label: {
    fontFamily: fonts.semibold,
    fontSize: 14,
    color: colors.text,
  },
  inputRow: {
    minHeight: 48,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    paddingHorizontal: 14,
    flexDirection: 'row',
    alignItems: 'center',
  },
  input: {
    flex: 1,
    color: colors.text,
    fontSize: 16,
    paddingVertical: 12,
  },
  hint: {
    fontSize: 12,
    color: colors.textFaint,
    lineHeight: 16,
  },
  error: {
    fontSize: 12,
    color: colors.down,
    lineHeight: 16,
  },
})
