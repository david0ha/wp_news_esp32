import { Tabs } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { useStrings } from '../../i18n'
import { colors, fonts } from '../../theme'

/**
 * The app's four standing surfaces: today's edition, the board on the wall, the markets
 * watchlist, and settings. Onboarding stays a stack outside this group; preview, the symbol
 * detail and the tile detail push over the tab bar from the root stack.
 *
 * Today is registered FIRST because it is the only tab that has something to show on every
 * phone, board or no board — a phone with no URL still gets the demo edition. The entry gate
 * (`entryRouteFor`) is unchanged and still lands on Board or Markets; Today is one tap away
 * from both, which is the right cost for a surface nobody has been told about yet.
 *
 * Registering first also moves where Android's hardware back key goes from inside this group,
 * because React Navigation's default `backBehavior` is `firstRoute`: it lands on Today now,
 * where it used to land on Board. That is the right landing for the same reason Today leads —
 * it is the tab that has content on every phone — so the default is left alone.
 */
export default function TabsLayout() {
  const s = useStrings()
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.accent,
        tabBarInactiveTintColor: colors.textDim,
        tabBarStyle: { backgroundColor: colors.surface, borderTopColor: colors.border },
        tabBarLabelStyle: { fontFamily: fonts.semibold, fontSize: 11 },
      }}
    >
      <Tabs.Screen
        name="edition"
        options={{
          title: s.tabs.today,
          tabBarIcon: ({ focused, color, size }) => (
            <Ionicons name={focused ? 'today' : 'today-outline'} size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="board"
        options={{
          title: s.tabs.board,
          tabBarIcon: ({ focused, color, size }) => (
            <Ionicons name={focused ? 'newspaper' : 'newspaper-outline'} size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="markets"
        options={{
          title: s.tabs.markets,
          tabBarIcon: ({ color, size }) => (
            // trending-up has no separate filled variant; the tint alone marks focus.
            <Ionicons name="trending-up" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: s.tabs.settings,
          tabBarIcon: ({ focused, color, size }) => (
            <Ionicons name={focused ? 'settings' : 'settings-outline'} size={size} color={color} />
          ),
        }}
      />
    </Tabs>
  )
}
