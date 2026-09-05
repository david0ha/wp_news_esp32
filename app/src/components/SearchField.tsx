import { Pressable, StyleSheet, TextInput, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useStrings } from '../i18n'
import { colors, radius, shadow, type } from '../theme'

/** The pill search bar — a lifted white field with a leading glyph and a clear control. */
export function SearchField({
  value,
  onChangeText,
  // Defaulted inside the body rather than in the parameter list: a default expression there is
  // evaluated per render, but it would still have to call a hook to know the language, and hooks
  // cannot run in a parameter default.
  placeholder,
  autoFocus = false,
  onClear,
}: {
  value: string
  onChangeText: (s: string) => void
  placeholder?: string
  autoFocus?: boolean
  onClear?: () => void
}) {
  const t = useStrings()
  return (
    <View style={styles.bar}>
      <Ionicons name="search" size={18} color={colors.textDim} />
      <TextInput
        style={styles.input}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder ?? t.addTicker.searchPlaceholder}
        placeholderTextColor={colors.textFaint}
        autoFocus={autoFocus}
        autoCapitalize="characters"
        autoCorrect={false}
        returnKeyType="search"
      />
      {value !== '' && onClear ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t.addTicker.clearSearch}
          onPress={onClear}
          hitSlop={8}
        >
          <Ionicons name="close-circle" size={18} color={colors.textDim} />
        </Pressable>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    height: 44,
    paddingHorizontal: 16,
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
    ...shadow.soft,
  },
  input: {
    ...type.body,
    flex: 1,
    color: colors.text,
    paddingVertical: 0,
  },
})
