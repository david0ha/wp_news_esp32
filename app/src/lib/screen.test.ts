import { describe, it, expect } from '@jest/globals'
import { inflate } from 'pako'
import {
  decode,
  FB_SIZE,
  INK_RGB,
  MISSING_RGB,
  SCREEN_BPP,
  SCREEN_H,
  SCREEN_STRIDE,
  SCREEN_W,
} from './screen'

// ---------------------------------------------------------------------------
// An independent PNG reader. Deliberately not sharing a line with screen.ts: a
// CRC checked with the same table that wrote it proves only that the table is
// self-consistent, so this one is the slow bitwise definition straight out of
// the PNG spec (RFC 2083 §15).
// ---------------------------------------------------------------------------

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (const b of bytes) {
    c ^= b
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  }
  return (c ^ 0xffffffff) >>> 0
}

function u32(b: Uint8Array, at: number): number {
  return ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0
}

interface Chunk {
  type: string
  data: Uint8Array
  crcOk: boolean
}

function readPng(b64: string): { bytes: Uint8Array; chunks: Chunk[] } {
  const bytes = new Uint8Array(Buffer.from(b64, 'base64'))
  expect(Array.from(bytes.subarray(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
  const chunks: Chunk[] = []
  let p = 8
  while (p + 12 <= bytes.length) {
    const len = u32(bytes, p)
    const type = String.fromCharCode(...bytes.subarray(p + 4, p + 8))
    const data = bytes.subarray(p + 8, p + 8 + len)
    const crc = u32(bytes, p + 8 + len)
    chunks.push({ type, data, crcOk: crc32(bytes.subarray(p + 4, p + 8 + len)) === crc })
    p += 12 + len
  }
  expect(p).toBe(bytes.length) // no trailing garbage
  return { bytes, chunks }
}

function chunk(chunks: Chunk[], type: string): Chunk {
  const hit = chunks.find((c) => c.type === type)
  if (!hit) throw new Error(`no ${type} chunk`)
  return hit
}

/** Every IDAT concatenated, then inflated — the raw filtered scanlines. */
function scanlines(chunks: Chunk[]): Uint8Array {
  const parts = chunks.filter((c) => c.type === 'IDAT')
  const total = parts.reduce((n, c) => n + c.data.length, 0)
  const joined = new Uint8Array(total)
  let at = 0
  for (const c of parts) {
    joined.set(c.data, at)
    at += c.data.length
  }
  return inflate(joined)
}

// ---------------------------------------------------------------------------
// A framebuffer, built the way the device builds one.
// ---------------------------------------------------------------------------

const CODE = {
  black: 0x00,
  white: 0x01,
  yellow: 0x02,
  red: 0x03,
  blue: 0x05,
  green: 0x06,
} as const

/** epd6_fb_put(), transcribed from components/port_bsp/epd6_transpose.h:148-153. */
function put(fb: Uint8Array, x: number, y: number, code: number): void {
  const i = y * SCREEN_STRIDE + (x >> 1)
  fb[i] = x & 1 ? (fb[i] & 0xf0) | (code & 0x0f) : (fb[i] & 0x0f) | ((code & 0x0f) << 4)
}

function blankPage(): Uint8Array {
  // memset(fb, (EPD6_WHITE << 4) | EPD6_WHITE) — sim/main_sim.c:125.
  return new Uint8Array(FB_SIZE).fill((CODE.white << 4) | CODE.white)
}

describe('screen — the geometry is the panel’s', () => {
  it('matches epd6_transpose.h', () => {
    expect(SCREEN_W).toBe(1200)
    expect(SCREEN_H).toBe(1600)
    expect(SCREEN_STRIDE).toBe(600) // EPD6_FB_STRIDE = EPD6_W / 2
    expect(FB_SIZE).toBe(960000) // EPD6_FB_SIZE
    expect(SCREEN_BPP).toBe(4)
    expect(SCREEN_STRIDE * SCREEN_H).toBe(FB_SIZE)
    // The four constants have to agree with each other, not just with the header: two pixels to a
    // byte is the whole reason the stride is half the width.
    expect((SCREEN_W * SCREEN_BPP) / 8).toBe(SCREEN_STRIDE)
  })
})

describe('screen — decode rejects anything that is not a framebuffer', () => {
  it('throws on a short buffer', () => {
    expect(() => decode(new Uint8Array(FB_SIZE - 1))).toThrow(/960000/)
  })

  it('throws on a long buffer', () => {
    expect(() => decode(new Uint8Array(FB_SIZE + 1))).toThrow(/960000/)
  })

  it('throws on an empty buffer', () => {
    // The interesting case: an ESP32 that closed the socket early answers with fewer bytes and a
    // 200. Half a page decoded as a whole one would be a plausible, wrong picture.
    expect(() => decode(new Uint8Array(0))).toThrow(/960000/)
  })
})

describe('screen — the PNG it writes', () => {
  it('is an indexed-colour 1200x1600 image with valid chunk CRCs', () => {
    const { pngBase64, width, height } = decode(blankPage())
    expect(width).toBe(SCREEN_W)
    expect(height).toBe(SCREEN_H)

    const { chunks } = readPng(pngBase64)
    expect(chunks.map((c) => c.type)[0]).toBe('IHDR')
    expect(chunks[chunks.length - 1].type).toBe('IEND')
    for (const c of chunks) expect(c.crcOk).toBe(true)

    const ihdr = chunk(chunks, 'IHDR').data
    expect(u32(ihdr, 0)).toBe(SCREEN_W)
    expect(u32(ihdr, 4)).toBe(SCREEN_H)
    expect(ihdr[8]).toBe(8) // bit depth: one byte per pixel
    expect(ihdr[9]).toBe(3) // colour type 3 — indexed, so the PLTE is the ink table
    expect(ihdr[10]).toBe(0) // compression: deflate
    expect(ihdr[11]).toBe(0) // filter method 0
    expect(ihdr[12]).toBe(0) // not interlaced
  })

  it('carries a 16-entry palette so a pixel index IS the panel’s wire code', () => {
    // Four bits address sixteen values and the panel makes six of them. Indexing the palette by
    // the raw nibble keeps the decode a table lookup with no mapping step to get backwards.
    const { chunks } = readPng(decode(blankPage()).pngBase64)
    const plte = chunk(chunks, 'PLTE').data
    expect(plte.length).toBe(16 * 3)

    // The measured "as paper" inks, from components/news_core/wp_palette.c's wp_palette_ink[].
    const at = (code: number) => Array.from(plte.subarray(code * 3, code * 3 + 3))
    expect(at(CODE.black)).toEqual([38, 38, 40])
    expect(at(CODE.white)).toEqual([226, 222, 211])
    expect(at(CODE.yellow)).toEqual([208, 176, 58])
    expect(at(CODE.red)).toEqual([158, 52, 44])
    expect(at(CODE.blue)).toEqual([50, 68, 126])
    expect(at(CODE.green)).toEqual([62, 110, 74])
  })

  it('paints every value the panel cannot make in a colour it cannot make either', () => {
    // 0x04 and 0x07..0x0F are not colours this panel makes (epd6_transpose.h). If one reaches a
    // preview, the contract has drifted, and a drift that renders as plausible paper is a drift
    // nobody reports. Magenta is not in the six inks, so it can only mean this.
    const { chunks } = readPng(decode(blankPage()).pngBase64)
    const plte = chunk(chunks, 'PLTE').data
    for (const code of [0x04, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f]) {
      expect(Array.from(plte.subarray(code * 3, code * 3 + 3))).toEqual(MISSING_RGB)
    }
    expect(MISSING_RGB).not.toEqual([226, 222, 211])
  })

  it('exposes the same table it wrote, one entry per nibble value', () => {
    expect(INK_RGB).toHaveLength(16)
    expect(INK_RGB[CODE.green]).toEqual([62, 110, 74])
    expect(INK_RGB[0x0f]).toEqual(MISSING_RGB)
  })
})

describe('screen — the pixels', () => {
  it('writes one unfiltered scanline per row, each one pixel per byte', () => {
    const raw = scanlines(readPng(decode(blankPage()).pngBase64).chunks)
    expect(raw.length).toBe(SCREEN_H * (1 + SCREEN_W))
    for (let y = 0; y < SCREEN_H; y++) {
      // Filter type 0 (None) on every row. A filtered row would compress better and cost the
      // phone a per-pixel reconstruction pass on 1.92 million pixels for a page that is mostly
      // one flat colour anyway.
      expect(raw[y * (1 + SCREEN_W)]).toBe(0)
    }
  })

  it('puts the EVEN x in the high nibble — the order sim/main_sim.c walks', () => {
    // sim/main_sim.c:246-252 walks y then x and reads ink_at(x, y) -> epd6_fb_get(), which is
    // (x & 1) ? (byte & 0x0F) : (byte >> 4) — epd6_transpose.h:142-146. Getting this backwards
    // mirrors every pair of pixels: legible at arm's length, wrong at every hairline.
    const fb = blankPage()
    fb[0] = (CODE.red << 4) | CODE.blue // one byte, written by hand rather than through put()

    const raw = scanlines(readPng(decode(fb).pngBase64).chunks)
    const row0 = raw.subarray(1, 1 + SCREEN_W)
    expect(row0[0]).toBe(CODE.red) // x = 0, the HIGH nibble
    expect(row0[1]).toBe(CODE.blue) // x = 1, the low one
  })

  it('lands each pixel at the row and column it was written to', () => {
    const fb = blankPage()
    const marks: Array<[number, number, number]> = [
      [0, 0, CODE.black],
      [1, 0, CODE.red],
      [SCREEN_W - 1, 0, CODE.green], // last pixel of the first row (odd x)
      [SCREEN_W - 2, 0, CODE.yellow], // and its even neighbour
      [7, 3, CODE.blue],
      [600, 800, CODE.red], // the seam between the two controllers
      [SCREEN_W - 1, SCREEN_H - 1, CODE.black], // the very last pixel
    ]
    for (const [x, y, code] of marks) put(fb, x, y, code)

    const raw = scanlines(readPng(decode(fb).pngBase64).chunks)
    const px = (x: number, y: number) => raw[y * (1 + SCREEN_W) + 1 + x]
    for (const [x, y, code] of marks) expect([x, y, px(x, y)]).toEqual([x, y, code])
    expect(px(2, 0)).toBe(CODE.white) // untouched paper stays paper
    expect(px(0, 1)).toBe(CODE.white)
  })

  it('round-trips a full page of every ink', () => {
    // Each row gets one ink, cycling through all six plus the two impossible values, so the
    // assertion covers every nibble the wire can carry rather than the six it should.
    const codes = [0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x0f]
    const fb = new Uint8Array(FB_SIZE)
    for (let y = 0; y < SCREEN_H; y++) {
      const c = codes[y % codes.length]
      fb.fill((c << 4) | c, y * SCREEN_STRIDE, (y + 1) * SCREEN_STRIDE)
    }

    const raw = scanlines(readPng(decode(fb).pngBase64).chunks)
    for (let y = 0; y < SCREEN_H; y += 97) {
      const want = codes[y % codes.length]
      const row = raw.subarray(y * (1 + SCREEN_W) + 1, (y + 1) * (1 + SCREEN_W))
      expect([y, row[0], row[599], row[600], row[SCREEN_W - 1]]).toEqual([y, want, want, want, want])
    }
  })
})
