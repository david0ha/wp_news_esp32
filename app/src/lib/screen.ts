// The page on the glass, decoded on the phone.
//
// `GET /api/screen` answers with the device's framebuffer verbatim — 960,000 bytes, no header, no
// codec (docs/app-control.md). This file is the other half of that decision: the firmware ships raw
// PSRAM to the socket and costs itself nothing, and the picture is assembled here instead.
//
// THE FORMAT, from components/port_bsp/epd6_transpose.h
// ----------------------------------------------------
// Row-major, 4 bits per pixel, two pixels per byte, portrait 1200 x 1600, stride 600:
//
//     byte  = fb[y * 600 + x / 2]
//     pixel = (x & 1) ? (byte & 0x0F) : (byte >> 4)      // EVEN x in the HIGH nibble
//
// A nibble is not an index into a palette of our choosing — it is the Spectra 6 wire code the
// controller itself takes: BLACK 0x00, WHITE 0x01, YELLOW 0x02, RED 0x03, BLUE 0x05, GREEN 0x06.
// 0x04 and 0x07..0x0F are not colours this panel makes.
//
// WHY AN INDEXED PNG
// ------------------
// Colour type 3 with a 16-entry PLTE means the pixel byte we write IS the nibble we read, and the
// palette is the only place a colour is decided. There is no mapping step to get backwards, the
// image is a quarter the size of RGB, and the file is 1.92 million bytes of mostly one value, which
// deflate is very good at. The alternative — RGB triples — would put the ink table in 5.7 MB of
// pixels instead of 48 bytes of palette.
//
// The palette is the MEASURED ink table, not the saturated one the UI draws with. wp_palette.h is
// explicit that these are two different tables for two different jobs: `wp_palette_rgb` is what the
// quantizer matches against, and `wp_palette_ink` is "roughly what Spectra 6 actually looks like",
// used only where a human is going to look at a picture and judge it as paper. A preview in
// primaries would flatter the design into a decision nobody could make from the real thing.

import { deflate } from 'pako'

// --- geometry (epd6_transpose.h) -------------------------------------------

export const SCREEN_W = 1200
export const SCREEN_H = 1600
/** EPD6_FB_STRIDE — 1200 is even, so a row is exactly 600 bytes with no padding. */
export const SCREEN_STRIDE = SCREEN_W / 2
/** EPD6_FB_SIZE. The response body is exactly this, or it is not a framebuffer. */
export const FB_SIZE = SCREEN_STRIDE * SCREEN_H
/** Bits per pixel — two pixels to a byte, which is what makes the stride half the width. */
export const SCREEN_BPP = 4

/**
 * The `X-Screen-Format` token this decoder understands.
 *
 * It is the contract's version handle. The geometry is the panel's and does not move, but if it
 * ever does, decoding the new shape against this palette would produce a plausible, wrong picture —
 * which is the one failure mode a preview cannot report on its own.
 */
export const SCREEN_FORMAT = 'claudepost-6ink-v1'

// --- the inks ---------------------------------------------------------------

/**
 * What a value the panel cannot make is drawn as.
 *
 * Magenta is not one of the six inks and cannot be one, so a magenta pixel can only mean that the
 * framebuffer carried a nibble outside the panel's palette — a contract drift, or a truncated
 * download. Filling those with paper white would hide exactly the case worth seeing.
 */
export const MISSING_RGB: readonly [number, number, number] = [255, 0, 255]

/**
 * Nibble value -> RGB, sixteen entries so the wire code indexes it directly.
 *
 * The six real ones are `wp_palette_ink[]` from components/news_core/wp_palette.c, at the wire
 * codes `wp_palette_code[]` gives them — the measured "as paper" table, which the simulator uses
 * for exactly this purpose (sim/main_sim.c:248). Those values are eyeballed from Spectra 6 product
 * photography rather than colorimetered; wp_palette.c carries the note about the second, measured
 * table in tools/make_tile.py that disagrees with it. If a panel is ever measured properly, that
 * comment names both places to correct, and this is the third.
 */
export const INK_RGB: ReadonlyArray<readonly [number, number, number]> = [
  [38, 38, 40], // 0x00 EPD6_BLACK  — never fully black
  [226, 222, 211], // 0x01 EPD6_WHITE  — warm paper
  [208, 176, 58], // 0x02 EPD6_YELLOW — ochre
  [158, 52, 44], // 0x03 EPD6_RED    — brick
  MISSING_RGB, // 0x04 — not a colour this panel makes
  [50, 68, 126], // 0x05 EPD6_BLUE   — dull navy
  [62, 110, 74], // 0x06 EPD6_GREEN  — olive
  MISSING_RGB, // 0x07
  MISSING_RGB, // 0x08
  MISSING_RGB, // 0x09
  MISSING_RGB, // 0x0A
  MISSING_RGB, // 0x0B
  MISSING_RGB, // 0x0C
  MISSING_RGB, // 0x0D
  MISSING_RGB, // 0x0E
  MISSING_RGB, // 0x0F
]

// --- PNG plumbing -----------------------------------------------------------

const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])

// The standard CRC-32 table (PNG spec, RFC 2083 §15), built once on first use rather than written
// out as 256 literals nobody could proofread.
let CRC_TABLE: Uint32Array | null = null
function crcTable(): Uint32Array {
  if (CRC_TABLE) return CRC_TABLE
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  CRC_TABLE = t
  return t
}

function crc32(bytes: Uint8Array): number {
  const t = crcTable()
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) c = t[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function writeU32(into: Uint8Array, at: number, v: number): void {
  into[at] = (v >>> 24) & 0xff
  into[at + 1] = (v >>> 16) & 0xff
  into[at + 2] = (v >>> 8) & 0xff
  into[at + 3] = v & 0xff
}

/** One PNG chunk: length, type, data, CRC over type+data. */
function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length)
  writeU32(out, 0, data.length)
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
  out.set(data, 8)
  writeU32(out, 8 + data.length, crc32(out.subarray(4, 8 + data.length)))
  return out
}

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/**
 * Base64, by hand.
 *
 * Hermes has no `btoa` and no `Buffer`, and pulling a dependency in for twenty lines of table
 * lookup would be a package to keep updated for the life of the app. Accumulated in bounded pieces
 * because the result is about 2.6 MB of text and repeated `+=` on one string of that size is what
 * makes a naive encoder quadratic.
 */
function toBase64(bytes: Uint8Array): string {
  const parts: string[] = []
  let piece = ''
  const n = bytes.length
  let i = 0
  for (; i + 2 < n; i += 3) {
    const v = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2]
    piece +=
      B64_ALPHABET[(v >>> 18) & 63] +
      B64_ALPHABET[(v >>> 12) & 63] +
      B64_ALPHABET[(v >>> 6) & 63] +
      B64_ALPHABET[v & 63]
    if (piece.length >= 8192) {
      parts.push(piece)
      piece = ''
    }
  }
  if (n - i === 1) {
    const v = bytes[i] << 16
    piece += B64_ALPHABET[(v >>> 18) & 63] + B64_ALPHABET[(v >>> 12) & 63] + '=='
  } else if (n - i === 2) {
    const v = (bytes[i] << 16) | (bytes[i + 1] << 8)
    piece +=
      B64_ALPHABET[(v >>> 18) & 63] +
      B64_ALPHABET[(v >>> 12) & 63] +
      B64_ALPHABET[(v >>> 6) & 63] +
      '='
  }
  parts.push(piece)
  return parts.join('')
}

// --- the decode -------------------------------------------------------------

export interface DecodedScreen {
  /** The whole image, ready for an <Image source={{ uri: 'data:image/png;base64,' + this }} />. */
  pngBase64: string
  width: number
  height: number
}

/**
 * `w*h/2` packed bytes -> one byte per pixel, row-major.
 *
 * The walk is `sim/main_sim.c`'s: y outer, x inner, and within a byte the EVEN x first, because
 * `epd6_fb_get()` (`epd6_transpose.h:142-146`) puts it in the HIGH nibble. Swapping the two
 * mirrors every pair of pixels — invisible in a headline, and it destroys every hairline.
 *
 * Parameterised by geometry because a photo tile is the same format at a different size: the
 * board's framebuffer is one 1200x1600 tile, and `edition/photo.ts` hands this 364x204 ones.
 */
export function unpackNibbles(bytes: Uint8Array, w: number, h: number): Uint8Array {
  // Odd widths cannot exist in this format at all: the last byte of a row would carry one pixel
  // of that row and one of the next, and there is no partial byte to end on.
  if (w <= 0 || h <= 0 || w % 2 !== 0) {
    throw new Error(`screen: ${w}x${h} is not a 4bpp image (width must be even and positive)`)
  }
  const stride = w / 2
  if (bytes.length !== stride * h) {
    throw new Error(`screen: expected ${stride * h} bytes for ${w}x${h}, got ${bytes.length}`)
  }
  const out = new Uint8Array(w * h)
  let o = 0
  for (let y = 0; y < h; y++) {
    const rowStart = y * stride
    for (let b = 0; b < stride; b++) {
      const byte = bytes[rowStart + b]
      out[o++] = byte >>> 4
      out[o++] = byte & 0x0f
    }
  }
  return out
}

/**
 * One byte per pixel -> a base64 indexed PNG in the measured Spectra 6 inks.
 *
 * Colour type 3 with a 16-entry PLTE means the pixel byte written IS the nibble read, and the
 * palette is the only place a colour is decided: no mapping step to get backwards, a quarter the
 * size of RGB, and a page of mostly one value that deflate is very good at.
 *
 * Filter 0 (None) on every row. Any other filter costs a per-pixel reconstruction pass on the
 * phone, and this content is flat colour — the run-length matching in deflate already has
 * everything it needs from an unfiltered row.
 */
export function encodeIndexedPng(indices: Uint8Array, w: number, h: number): string {
  if (indices.length !== w * h) {
    throw new Error(`screen: expected ${w * h} indices for ${w}x${h}, got ${indices.length}`)
  }

  const rowBytes = 1 + w
  const raw = new Uint8Array(h * rowBytes)
  for (let y = 0; y < h; y++) {
    raw[y * rowBytes] = 0
    raw.set(indices.subarray(y * w, (y + 1) * w), y * rowBytes + 1)
  }

  const ihdr = new Uint8Array(13)
  writeU32(ihdr, 0, w)
  writeU32(ihdr, 4, h)
  ihdr[8] = 8 // bit depth: one whole byte per pixel, so a nibble indexes the palette directly
  ihdr[9] = 3 // colour type 3 — indexed
  ihdr[10] = 0 // compression: deflate, the only one PNG defines
  ihdr[11] = 0 // filter method 0
  ihdr[12] = 0 // no interlacing

  const plte = new Uint8Array(INK_RGB.length * 3)
  for (let i = 0; i < INK_RGB.length; i++) {
    plte[i * 3] = INK_RGB[i][0]
    plte[i * 3 + 1] = INK_RGB[i][1]
    plte[i * 3 + 2] = INK_RGB[i][2]
  }

  const parts = [
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('PLTE', plte),
    chunk('IDAT', deflate(raw)),
    chunk('IEND', new Uint8Array(0)),
  ]

  const total = parts.reduce((n, p) => n + p.length, 0)
  const png = new Uint8Array(total)
  let at = 0
  for (const p of parts) {
    png.set(p, at)
    at += p.length
  }
  return toBase64(png)
}

/**
 * One framebuffer -> one indexed PNG, in the measured inks.
 *
 * Throws rather than guessing on anything that is not exactly `FB_SIZE` bytes. A short body is
 * what a socket closed mid-download looks like, and half a page rendered as a whole one is a
 * picture the user has no way to tell from the real thing. The size check stays HERE, ahead of
 * `unpackNibbles`, so the message still names 960,000 — that number is the contract, and the
 * generic one below it would say "expected 960000 bytes for 1200x1600", which is true and less
 * useful.
 */
export function decode(fbBytes: Uint8Array): DecodedScreen {
  if (fbBytes.length !== FB_SIZE) {
    throw new Error(`screen: expected ${FB_SIZE} bytes of framebuffer, got ${fbBytes.length}`)
  }
  return {
    pngBase64: encodeIndexedPng(unpackNibbles(fbBytes, SCREEN_W, SCREEN_H), SCREEN_W, SCREEN_H),
    width: SCREEN_W,
    height: SCREEN_H,
  }
}
