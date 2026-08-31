// What the sheet viewer is showing right now.
//
// Four ternaries in a render function got this wrong once, in a way that only appears when the two
// sources have very different latencies — which they always do. `useSheet` resolves the desk's
// proof through `Promise.resolve(...)`, so it is ready on the first render; reading a framebuffer
// off the board is a megabyte over the network plus 1.92 million pixels of inflate. Deciding "the
// board did not answer" by asking whether a board image exists YET therefore announced the
// fallback — in a sentence, out loud, under the sheet — while the board was still answering, and
// then retracted it a few seconds later.
//
// So the decision is a function with a name and a test, and the ordering is the whole content of
// it. Read the rules in order; each one is a claim about which evidence outranks which.

export type GlassSource =
  /** The board's own framebuffer, decoded. */
  | 'board'
  /** The desk's proof of the edition — the point of the proof route, a fallback on the board one. */
  | 'proof'
  /** Still being asked. */
  | 'busy'
  /** Nothing to show, and nothing still coming. */
  | 'none'

export interface GlassInput {
  /** The board route. On the proof route the board is never asked, so its fields cannot matter. */
  wantsBoard: boolean
  /** A read of the board is running — either half: `/api/state` for the key, then `/api/screen`. */
  boardInFlight: boolean
  hasBoardImage: boolean
  hasProof: boolean
  proofLoading: boolean
}

export function resolveGlassSource(input: GlassInput): GlassSource {
  const { wantsBoard, boardInFlight, hasBoardImage, hasProof, proofLoading } = input

  // 1. A sheet already read off the board stays up, INCLUDING while a refetch runs over it. This
  //    rule is above the in-flight one on purpose: blanking a live sheet to a spinner because the
  //    user asked for a fresher copy throws away the last page that came back, which is still the
  //    page physically on the glass. A refetch that then fails says so in the footer instead.
  if (wantsBoard && hasBoardImage) return 'board'

  // 2. A board still answering outranks a proof that merely happens to be ready. Falling back is a
  //    claim about the board — "it did not answer" — and that claim cannot be true yet.
  if (wantsBoard && boardInFlight) return 'busy'

  // 3. The desk's proof: the whole point on the proof route, and on the board route the fallback,
  //    now that the board has had its go. The caller says so out loud when it lands here.
  if (hasProof) return 'proof'

  if (proofLoading) return 'busy'

  return 'none'
}
