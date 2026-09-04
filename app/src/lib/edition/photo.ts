// A photo tile, decoded on the phone.
//
// `GET <news URL's directory>/tiles/<id>.bin` answers with exactly what the board blits: `w*h/2`
// bytes, no header, no codec, the same 4bpp nibble layout and the same six wire codes as the
// framebuffer. So this is not a second decoder — it is `lib/screen.ts`'s, called with the tile's
// geometry instead of the panel's.
//
// The photographs are halftoned to black and white before they ever reach the wire
// (`tools/make_tile.py`); the phone does no tone mapping, no resizing and no dithering, exactly
// as the device does none. What it shows is what the paper shows.
//
// CACHING IS IN MEMORY ONLY, on purpose. The text is the material. A decoded 364x204 tile is
// about a hundred kilobytes of base64, and an edition can carry several — putting those in
// AsyncStorage would spend hundreds of kilobytes of a phone's storage per day on pictures that
// re-fetch in a second over the same connection that just delivered the JSON.

import { encodeIndexedPng, unpackNibbles } from '../screen'

export interface DecodedTile {
  /** Ready for `<Image source={{ uri: 'data:image/png;base64,' + this }} />`. */
  pngBase64: string
  width: number
  height: number
}

/** What the body of `tiles/<id>.bin` must weigh: two pixels to a byte. */
export function tileByteLength(w: number, h: number): number {
  return (w * h) / 2
}

/**
 * One tile body -> one indexed PNG in the measured inks.
 *
 * Throws on a body that is not exactly `w*h/2` bytes and on a geometry that cannot be a tile.
 * The caller (`PhotoTile`) catches and keeps the tile's height with the caption on a plain
 * ground, which is the spec's failure row: the layout must not move because a picture did not
 * arrive.
 */
export function decodeTile(bytes: Uint8Array, w: number, h: number): DecodedTile {
  const want = tileByteLength(w, h)
  // Only for a geometry that could be a tile. A zero, negative or odd width falls straight
  // through to `unpackNibbles`, whose message names the geometry — the useful half — where this
  // one would report a byte count derived from the nonsense it was handed.
  if (w > 0 && h > 0 && w % 2 === 0 && bytes.length !== want) {
    throw new Error(`photo: expected ${want} bytes for ${w}x${h}, got ${bytes.length}`)
  }
  return { pngBase64: encodeIndexedPng(unpackNibbles(bytes, w, h), w, h), width: w, height: h }
}

// --- the session cache ------------------------------------------------------

const pngByUrl = new Map<string, string>()

export function getCachedTilePng(url: string): string | null {
  return pngByUrl.get(url) ?? null
}

export function putCachedTilePng(url: string, pngBase64: string): void {
  pngByUrl.set(url, pngBase64)
}

/**
 * Called when the edition changes. Tile ids are the producer's and are not guaranteed unique
 * across days, so a cache that outlived its edition could hand tomorrow's page yesterday's
 * picture under the same name.
 */
export function clearTilePngCache(): void {
  pngByUrl.clear()
}
