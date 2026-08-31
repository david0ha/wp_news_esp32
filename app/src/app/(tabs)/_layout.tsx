import { NativeTabs } from 'expo-router/unstable-native-tabs'
import { colors } from '../../theme/colors'

/**
 * The four tabs — plan Decisions D7. Today, Watch, Desk, Board: the paper, the companies it is
 * about, the desk that files it, and the hardware it hangs on. Settings is not a fifth tab; it is
 * pushed from the gear each tab carries (`<HeaderGear>`), because it is somewhere you go to change
 * something and come back, not somewhere you read.
 *
 * `NativeTabs` is UIKit's own `UITabBarController`, so the tab bar is the platform's: its blur,
 * its selection behaviour, its accessibility, and — the reason it matters here — its *lack* of a
 * cross-fade between tabs. Plan D9's animation gate says tabs never animate, and the way to spend
 * nothing on that is to let the system own the switch rather than to turn a JS animation off.
 * `minimizeBehavior="never"` is the one piece of that the system would otherwise animate on its
 * own: on iOS 26 the tab bar shrinks away as you scroll down, which is motion nobody asked for on
 * a page whose whole subject is a sheet of paper that does not move.
 *
 * The icons are SF Symbols, resolved natively rather than shipped as glyph fonts. Android would
 * need a `drawable`/`md` beside each `sf`; this app is iOS-only for now (app.json has no Android
 * build lane in EAS), and a missing Android icon is a blank tab rather than a crash — worth
 * knowing before anyone adds that lane.
 */
export default function TabsLayout() {
  return (
    <NativeTabs
      backgroundColor={colors.desk}
      iconColor={{ default: colors.deskFaint, selected: colors.deskText }}
      labelStyle={{
        default: { color: colors.deskFaint },
        selected: { color: colors.deskText },
      }}
      minimizeBehavior="never"
    >
      <NativeTabs.Trigger name="index">
        <NativeTabs.Trigger.Icon sf="newspaper" />
        <NativeTabs.Trigger.Label>Today</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name="watch">
        <NativeTabs.Trigger.Icon sf="eye" />
        <NativeTabs.Trigger.Label>Watch</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name="desk">
        <NativeTabs.Trigger.Icon sf="tray.full" />
        <NativeTabs.Trigger.Label>Desk</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name="board">
        <NativeTabs.Trigger.Icon sf="rectangle.on.rectangle" />
        <NativeTabs.Trigger.Label>Board</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  )
}
