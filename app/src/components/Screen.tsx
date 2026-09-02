import { type ReactNode } from 'react'
import { StyleSheet, View, type ViewStyle } from 'react-native'
import { SafeAreaView, type Edge } from 'react-native-safe-area-context'
import { StatusBar } from 'expo-status-bar'
import { colors } from '../theme'
import { AuroraBackground } from './AuroraBackground'

/**
 * Full-bleed light screen base used by every route. Set `aurora` for the header
 * atmosphere — four soft gradient blobs rendered behind the content, never over it.
 */
export function Screen({
  children,
  edges = ['top', 'bottom'],
  style,
  aurora = false,
}: {
  children: ReactNode
  edges?: Edge[]
  style?: ViewStyle
  aurora?: boolean
}) {
  return (
    <View style={styles.root}>
      <StatusBar style="dark" />
      {aurora ? <AuroraBackground /> : null}
      <SafeAreaView style={[styles.safe, style]} edges={edges}>
        {children}
      </SafeAreaView>
    </View>
  )
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  safe: {
    flex: 1,
  },
})
