import { describe, it, expect } from '@jest/globals'
import { inflate } from 'pako'
import {
  clearTilePngCache,
  decodeTile,
  getCachedTilePng,
  putCachedTilePng,
  tileByteLength,
} from './photo'
import { INK_RGB, MISSING_RGB } from '../screen'

// An independent PNG reader, the same one `screen.test.ts` uses and for the same reason: a CRC
// checked with the table that wrote it proves only that the table agrees with itself.
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

interface Chunk { type: string; data: Uint8Array; crcOk: boolean }

function readPng(b64: string): Chunk[] {
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
  expect(p).toBe(bytes.length)
  return chunks
}

function chunk(chunks: Chunk[], type: string): Uint8Array {
  const hit = chunks.find((c) => c.type === type)
  if (!hit) throw new Error(`no ${type} chunk`)
  return hit.data
}

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

const CODE = { black: 0x00, white: 0x01, yellow: 0x02, red: 0x03, blue: 0x05, green: 0x06 } as const

describe('tileByteLength', () => {
  it('is w * h / 2 — two pixels to a byte', () => {
    expect(tileByteLength(2, 2)).toBe(2)
    expect(tileByteLength(364, 204)).toBe(37128)
    expect(tileByteLength(1140, 320)).toBe(182400)
  })
})

describe('decodeTile', () => {
  it('turns a 2x2 tile into a 2x2 indexed PNG with the ink palette', () => {
    // Row 0: RED at x=0 (high nibble), BLUE at x=1. Row 1: BLACK, WHITE.
    const bytes = new Uint8Array([(CODE.red << 4) | CODE.blue, (CODE.black << 4) | CODE.white])
    const { pngBase64, width, height } = decodeTile(bytes, 2, 2)
    expect([width, height]).toEqual([2, 2])

    const chunks = readPng(pngBase64)
    for (const c of chunks) expect(c.crcOk).toBe(true)
    expect(chunks[0].type).toBe('IHDR')
    expect(chunks[chunks.length - 1].type).toBe('IEND')

    const ihdr = chunk(chunks, 'IHDR')
    expect(u32(ihdr, 0)).toBe(2)
    expect(u32(ihdr, 4)).toBe(2)
    expect(ihdr[8]).toBe(8) // one whole byte per pixel, so a nibble indexes the palette directly
    expect(ihdr[9]).toBe(3) // colour type 3 — indexed
    expect(ihdr[10]).toBe(0)
    expect(ihdr[11]).toBe(0)
    expect(ihdr[12]).toBe(0)

    // The palette is the measured "as paper" ink table, sixteen entries so the wire code indexes
    // it directly, with the impossible values in a colour the panel cannot make.
    const plte = chunk(chunks, 'PLTE')
    expect(plte.length).toBe(16 * 3)
    const at = (code: number) => Array.from(plte.subarray(code * 3, code * 3 + 3))
    expect(at(CODE.black)).toEqual(INK_RGB[CODE.black])
    expect(at(CODE.red)).toEqual(INK_RGB[CODE.red])
    expect(at(0x04)).toEqual(MISSING_RGB)

    // One unfiltered scanline per row, one byte per pixel, even x first.
    const raw = scanlines(chunks)
    expect(Array.from(raw)).toEqual([0, CODE.red, CODE.blue, 0, CODE.black, CODE.white])
  })

  it('handles a wide, short strip — the lead photo’s shape', () => {
    const { pngBase64, width, height } = decodeTile(new Uint8Array(tileByteLength(1140, 320)), 1140, 320)
    expect([width, height]).toEqual([1140, 320])
    const ihdr = chunk(readPng(pngBase64), 'IHDR')
    expect([u32(ihdr, 0), u32(ihdr, 4)]).toEqual([1140, 320])
  })

  it('throws rather than guessing on a body of the wrong length', () => {
    // A short body is what a socket closed mid-download looks like. Half a picture drawn as a
    // whole one is an image the reader cannot tell from the real thing.
    expect(() => decodeTile(new Uint8Array(1), 2, 2)).toThrow(/2 bytes/)
    expect(() => decodeTile(new Uint8Array(3), 2, 2)).toThrow(/2 bytes/)
    expect(() => decodeTile(new Uint8Array(0), 2, 2)).toThrow(/2 bytes/)
  })

  it('refuses a geometry that cannot be a tile', () => {
    expect(() => decodeTile(new Uint8Array(2), 3, 1)).toThrow(/even/)
    expect(() => decodeTile(new Uint8Array(0), 0, 2)).toThrow()
    expect(() => decodeTile(new Uint8Array(0), 2, 0)).toThrow()
  })
})

describe('the in-memory tile cache', () => {
  it('round-trips by URL and forgets on clear', () => {
    clearTilePngCache()
    expect(getCachedTilePng('http://d/tiles/a.bin')).toBeNull()
    putCachedTilePng('http://d/tiles/a.bin', 'AAAA')
    expect(getCachedTilePng('http://d/tiles/a.bin')).toBe('AAAA')
    expect(getCachedTilePng('http://d/tiles/b.bin')).toBeNull()
    clearTilePngCache()
    expect(getCachedTilePng('http://d/tiles/a.bin')).toBeNull()
  })
})
