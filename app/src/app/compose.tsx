import { StyleSheet, Text, View } from 'react-native'
import { colors } from '../theme/colors'
import { typography } from '../theme/typography'

/**
 * The composer — a form sheet for ordering an edition or filing a research request, raised from
 * Desk (plan Design > Wireframes, "ORDER"). Task 29 builds it; this reserves the route and its
 * presentation so the sheet's own chrome is settled before anything is written into it.
 */
export default function Compose() {
  return (
    <View style={styles.root}>
      <Text style={styles.note}>Compose — an order for the desk. Not yet built.</Text>
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
