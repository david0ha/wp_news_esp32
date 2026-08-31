// Which of the three things the viewer can show is on screen right now.
//
// The rule this file exists for is an ORDERING one, and it was got wrong the first time: the desk's
// proof resolves through `Promise.resolve(...)` and is therefore available on the first render,
// while reading a framebuffer off the board takes seconds. Deciding "the board did not answer" by
// checking whether a board image exists yet announces the fallback before the board has been given
// its go — and then retracts it. So a board still in flight outranks a proof that is merely ready.
//
// The one exception, and the reason the first two rules are in the order they are: a REFETCH sets
// the board in flight while a sheet is already up. Blanking that sheet to a spinner would throw
// away the last page that came back, which is still what is on the glass.
import { describe, it, expect } from '@jest/globals'
import { resolveGlassSource } from './glass'

const base = {
  wantsBoard: false,
  boardInFlight: false,
  hasBoardImage: false,
  hasProof: false,
  proofLoading: false,
}

describe('resolveGlassSource — the proof route', () => {
  it('shows the proof once it is there', () => {
    expect(resolveGlassSource({ ...base, hasProof: true })).toBe('proof')
  })

  it('waits while the proof is loading', () => {
    expect(resolveGlassSource({ ...base, proofLoading: true })).toBe('busy')
  })

  it('has nothing to show when the edition has no sheet for this page', () => {
    expect(resolveGlassSource(base)).toBe('none')
  })

  it('is never affected by the board, which it does not ask', () => {
    expect(resolveGlassSource({ ...base, hasProof: true, boardInFlight: true })).toBe('proof')
    expect(resolveGlassSource({ ...base, hasProof: true, hasBoardImage: true })).toBe('proof')
  })
})

describe('resolveGlassSource — the board route', () => {
  it('shows the glass once it has been read', () => {
    expect(resolveGlassSource({ ...base, wantsBoard: true, hasBoardImage: true })).toBe('board')
  })

  it('waits for the board rather than claiming a fallback the proof happens to have ready', () => {
    // The whole point. `useSheet` is synchronous and `fetchScreen` is not, so without this the
    // screen would show the desk's proof — announcing a fallback out loud — while the board was
    // still answering, then swap to the live glass and retract the announcement.
    expect(
      resolveGlassSource({ ...base, wantsBoard: true, boardInFlight: true, hasProof: true }),
    ).toBe('busy')
  })

  it('keeps the sheet up while a REFETCH is in flight over it', () => {
    // A failed refetch must leave the last page that came back on screen — it is still what is on
    // the glass. Blanking it to a spinner would be the one thing worse than saying nothing.
    expect(
      resolveGlassSource({
        ...base,
        wantsBoard: true,
        hasBoardImage: true,
        boardInFlight: true,
      }),
    ).toBe('board')
  })

  it('falls back to the proof once the board has had its go and come back with nothing', () => {
    expect(resolveGlassSource({ ...base, wantsBoard: true, hasProof: true })).toBe('proof')
  })

  it('has nothing to show when neither the board nor the desk can supply a sheet', () => {
    expect(resolveGlassSource({ ...base, wantsBoard: true })).toBe('none')
  })

  it('shows the spinner rather than nothing while the first read is running', () => {
    expect(resolveGlassSource({ ...base, wantsBoard: true, boardInFlight: true })).toBe('busy')
  })
})
