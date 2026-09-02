import { Pressable, StyleSheet, TextInput, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { colors, radius, shadow, type } from '../theme'

/** The pill search bar — a lifted white field with a leading glyph and a clear control. */
export function SearchField({
  value,
  onChangeText,
  placeholder = 'Search',
  autoFocus = false,
  onClear,
}: {
  value: string
  onChangeText: (s: string) => void
  placeholder?: string
  autoFocus?: boolean
  onClear?: () => void
}) {
  return (
    <View style={styles.bar}>
      <Ionicons name="search" size={18} color={colors.textDim} />
      <TextInput
        style={styles.input}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.textFaint}
        autoFocus={autoFocus}
        autoCapitalize="characters"
        autoCorrect={false}
        returnKeyType="search"
      />
      {value !== '' && onClear ? (
        <Pressable accessibilityRole="button" accessibilityLabel="Clear search" onPress={onClear} hitSlop={8}>
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
