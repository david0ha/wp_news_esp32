import { useEffect, useState } from 'react'
import { Image, InteractionManager, StyleSheet, Text, View } from 'react-native'
import { colors, radius, type } from '../../../theme'
import { TILE_PADDING, type Tile } from '../../../lib/edition/tiles'
import { editionClient, tileUrl } from '../../../lib/edition/client'
import { decodeTile, getCachedTilePng, putCachedTilePng } from '../../../lib/edition/photo'
import { useEditionUrl } from '../editionUrl'

/**
 * A photograph, fetched beside the payload and decoded on the phone.
 *
 * `tiles/<id>.bin` is `w*h/2` raw bytes with no header and no codec — the same thing the board
 * blits — so this goes through `lib/screen.ts`'s encoder with the tile's geometry. The picture is
 * already halftoned to black and white by `tools/make_tile.py`; nothing here resizes or tones it,
 * exactly as nothing on the device does.
 *
 * WHEN IT DOES NOT ARRIVE THE TILE KEEPS ITS HEIGHT. The layout was computed before the fetch
 * started, so a missing picture must not move the page — the caption goes on a plain ground and
 * the column beside it does not shift. That is the failure of a picture that SHOULD have arrived:
 * a slow desk, a deleted tile. An edition with nowhere to fetch from at all — the demo — never
 * reaches this component, because `editionToTiles` cuts it without photo tiles.
 *
 * THE ADDRESS COMES FROM CONTEXT, not from a prop. This is the only component that needs to know
 * where the edition was served from, and it sits three levels below the screen that holds it —
 * see `../editionUrl.tsx` for why the string stopped being passed hand to hand.
 *
 * THIS COMPONENT DOES NOT NOTICE A NEW EDITION BY ITSELF, and it is not supposed to. Its effect
 * keys on the tile URL and the geometry, and both of those repeat across days: the ids are the
 * producer's and the lead band is 1140x320 every edition. Every mount site therefore keys it on
 * the edition too (`feedLayout.ts`'s `editionKey`), so a new edition remounts it rather than
 * handing the old instance a new caption over the old picture.
 */
export function PhotoTile({
  tile,
  width,
  height,
}: {
  tile: Extract<Tile, { kind: 'photo' }>
  width: number
  height: number
}) {
  const { photo } = tile
  const url = tileUrl(useEditionUrl(), photo.id)
  // Seeded from the session cache so a tile scrolled back into view paints on its first frame
  // rather than flashing the placeholder while a decode it already did runs again.
  const [png, setPng] = useState<string | null>(() => (url === '' ? null : getCachedTilePng(url)))

  // The URL and NOT the decoded picture is what this effect keys on. Re-reading the session cache
  // first is what makes a remount cheap: an edition change empties it (`clearTilePngCache`), so a
  // miss here is a real refetch and a hit is a tile scrolled back into view, which paints without
  // a placeholder flash.
  useEffect(() => {
    const cached = url === '' ? null : getCachedTilePng(url)
    setPng(cached)
    if (url === '' || cached !== null) return
    let alive = true
    void (async () => {
      try {
        const bytes = await editionClient.fetchTile(url, photo.w, photo.h)
        if (!alive) return
        // THE DECODE WAITS FOR THE HANDS TO STOP. Unpacking the nibbles, deflating and base64ing
        // a tile is a few milliseconds of pure JS with no yield in it, and the tiles of one
        // edition resolve within a moment of each other — so run at the instant each fetch lands,
        // they stack into one long block on the thread that is drawing the masonry or following
        // the reader's finger. Deferred, the picture arrives a beat later and the scroll does not
        // stutter, which is the right trade for something the layout has already reserved a box
        // for.
        await new Promise<void>((resolve) => {
          InteractionManager.runAfterInteractions(() => resolve())
        })
        if (!alive) return
        const decoded = decodeTile(bytes, photo.w, photo.h)
        // `alive` BEFORE the cache write, not after. The cache is cleared when the edition
        // changes; a fetch still in flight across that moment would otherwise refill it under the
        // new edition, with the old edition's picture, under an id the new one also uses.
        if (!alive) return
        putCachedTilePng(url, decoded.pngBase64)
        setPng(decoded.pngBase64)
      } catch {
        // No banner and no retry. A picture is the one thing on this page whose absence explains
        // itself, and an error card where a photograph should be is louder than the photograph.
      }
    })()
    return () => {
      alive = false
    }
  }, [url, photo.w, photo.h])

  return (
    <View style={[styles.root, { width, height }]}>
      {png !== null ? (
        <Image
          accessibilityLabel={photo.caption !== '' ? photo.caption : 'Photograph'}
          source={{ uri: `data:image/png;base64,${png}` }}
          style={styles.image}
          resizeMode="cover"
        />
      ) : (
        <View style={styles.placeholder} />
      )}
      {photo.caption !== '' ? (
        <Text style={styles.caption} numberOfLines={2}>
          {photo.caption}
        </Text>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  root: {
    // The size comes in as props and is set explicitly, NOT taken from a parent with `flex: 1`.
    // Two callers mount this outside the masonry — the Today tab's full-width band above the
    // grid, and the detail page's picture — where there is no sized parent to fill and a flex
    // child would collapse to nothing. `EditionTile` drops its padding for this kind so the
    // picture bleeds to the rounded edge either way: a photograph inset by 14 px inside a white
    // card is a stamp, not a picture, and cancelling the padding with a negative margin would
    // push the standalone mount 14 px outside whatever contains it.
    justifyContent: 'flex-end',
    overflow: 'hidden',
  },
  // The picture fills the tile and the caption floats over its foot, so the caption costs no
  // height — which is what lets `estimateTileHeight` size a photo tile from its aspect alone.
  image: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
  },
  placeholder: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: colors.surfaceAlt,
  },
  caption: {
    ...type.caption,
    color: colors.text,
    backgroundColor: colors.surface,
    paddingHorizontal: TILE_PADDING,
    paddingVertical: 8,
    borderBottomLeftRadius: radius.lg,
    borderBottomRightRadius: radius.lg,
  },
})
