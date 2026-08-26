import { StyleSheet, Text, View } from 'react-native'
import { useLocalSearchParams } from 'expo-router'
import { colors } from '../../theme/colors'
import { typography } from '../../theme/typography'

/**
 * A sheet, full size and pinch-zoomable — raised by tapping the paper anywhere it appears
 * (plan Design > Signature). `source` names which one: the board's own glass, or an edition's
 * proof from the desk. Task 26 builds it; this reserves the route and its presentation.
 */
export default function SheetViewer() {
  const { source } = useLocalSearchParams<{ source: string }>()
  return (
    <View style={styles.root}>
      <Text style={styles.note}>Sheet — source “{source}”. Not yet built.</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.desk,
    padding: 24,
  },
  note: {
    ...typography.ui,
    color: colors.deskDim,
    textAlign: 'center',
  },
})
