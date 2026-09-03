import { useEffect, useState } from 'react'
import { Image, StyleSheet, Text, View } from 'react-native'
import { colors, radius, type } from '../../../theme'
import { TILE_PADDING, type Tile } from '../../../lib/edition/tiles'
import { editionClient, tileUrl } from '../../../lib/edition/client'
import { decodeTile, getCachedTilePng, putCachedTilePng } from '../../../lib/edition/photo'

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
 * the column beside it does not shift. That is also what the demo edition looks like, whose tiles
 * live in `sim/tiles/` and are on no server the phone can reach.
 */
export function PhotoTile({
  tile,
  width,
  height,
  newsUrl,
}: {
  tile: Extract<Tile, { kind: 'photo' }>
  width: number
  height: number
  newsUrl: string
}) {
  const { photo } = tile
  const url = tileUrl(newsUrl, photo.id)
  // Seeded from the session cache so a tile scrolled back into view paints on its first frame
  // rather than flashing the placeholder while a decode it already did runs again.
  const [png, setPng] = useState<string | null>(() => (url === '' ? null : getCachedTilePng(url)))

  // The URL and NOT the decoded picture is what this effect keys on. Tile ids repeat across
  // editions (`photo:0` is `photo:0` every day), so React reuses this instance for tomorrow's
  // photograph — and an effect that skipped whenever it already held a picture would keep
  // showing yesterday's forever. Re-reading the cache first is what makes that cheap: the
  // edition change already emptied it (`clearTilePngCache`), so a miss here is a real refetch
  // and a hit is a tile scrolled back into view, which paints without a placeholder flash.
  useEffect(() => {
    const cached = url === '' ? null : getCachedTilePng(url)
    setPng(cached)
    if (url === '' || cached !== null) return
    let alive = true
    void (async () => {
      try {
        const bytes = await editionClient.fetchTile(url, photo.w, photo.h)
        const decoded = decodeTile(bytes, photo.w, photo.h)
        putCachedTilePng(url, decoded.pngBase64)
        if (alive) setPng(decoded.pngBase64)
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
    // Task 9 mounts this outside the masonry — the full-width band above the grid, and the
    // detail page — where there is no sized parent to fill and a flex child would collapse to
    // nothing. `EditionTile` drops its padding for this kind so the picture bleeds to the
    // rounded edge either way: a photograph inset by 14 px inside a white card is a stamp, not
    // a picture, and cancelling the padding with a negative margin would push the standalone
    // mount 14 px outside whatever contains it.
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
