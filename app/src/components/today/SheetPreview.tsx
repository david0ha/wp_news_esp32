import { StyleSheet, View, type ViewStyle } from 'react-native'
import { Image } from 'expo-image'
import { Sheet } from '../Sheet'
import { SegmentedControl } from '../SegmentedControl'
import { Stamp } from '../Stamp'
import { spacing } from '../../theme/index'
import type { SheetSource } from '../../lib/queries'

// 1200x1600, the panel's own portrait resolution (CLAUDE.md's framebuffer geometry).
const SHEET_ASPECT = 1200 / 1600

/**
 * A dumb stand-in for Task 26's real `<OnTheGlass>` — the aspect-correct paper box and the
 * [A1]/[A2] switcher it will inherit, with none of the zoom, live-refresh awareness or board/
 * desk fallback logic that component owns.
 *
 * `sheetSource` is `undefined` whenever there is nothing to show — no desk configured, or a desk
 * with no current edition yet — and the box then renders as bare paper with no image. The caller
 * resolves that through `useSheet()`; this component only draws what it is handed, never fetches.
 */
export function SheetPreview({
  sheetSource,
  since,
  pageIndex,
  onChangePage,
  style,
}: {
  sheetSource?: SheetSource
  /** "06:04" — omitted (no `<Stamp>`) when the edition's publish time isn't known. */
  since?: string
  pageIndex: number
  onChangePage: (index: number) => void
  style?: ViewStyle
}) {
  return (
    <View style={[styles.wrap, style]}>
      <Sheet style={styles.frame}>
        {sheetSource ? (
          <Image
            source={{ uri: sheetSource.uri, headers: sheetSource.headers }}
            style={styles.image}
            contentFit="contain"
            accessibilityIgnoresInvertColors
          />
        ) : null}
      </Sheet>
      {since ? (
        <Stamp tone="chrome" style={styles.stamp}>{`hangs there since ${since}`}</Stamp>
      ) : null}
      <SegmentedControl segments={['A1', 'A2']} selectedIndex={pageIndex} onChange={onChangePage} />
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: {
    gap: spacing[12],
  },
  frame: {
    aspectRatio: SHEET_ASPECT,
    padding: 0,
    overflow: 'hidden',
  },
  image: {
    width: '100%',
    height: '100%',
  },
  stamp: {
    alignSelf: 'center',
  },
})
