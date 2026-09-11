// Putting one company's paper on the glass: four steps, three of which can fail on their own.
//
// A function and not four lines in an `onPress`, for this app's standing reason — there is no
// component test runner, so a sequence argued inside a `.tsx` is argued only in prose — and for one
// specific to this sequence: THE BOARD IS NOT THE SUBJECT. The desk is. A publish that reported
// failure because an ESP32 asleep on a shelf did not answer would be blaming the wrong machine for
// a thing that already happened, and the owner's next act would be to tap it again.

import { humanDeskError, type DeskClient } from '../desk'
import { fill, type Strings } from '../../i18n'

export type PaperPublishResult =
  | { kind: 'published'; editionId: string }
  /** The list said there was a paper and the desk says there is not — pruned since the fetch. */
  | { kind: 'no_paper' }
  /**
   * `error` is already `humanDeskError`'s sentence — the same helper `positionDraft.ts`'s
   * `deskRefusal` and `schedule.ts`'s `scheduleView` hand a screen directly, with no per-feature
   * wrapping. It resolves through the app's EXISTING `errors.desk.*` catalogue, so it needs no new
   * i18n keys from this task and is not a raw/hardcoded string.
   */
  | { kind: 'failed'; error: string }

export interface PaperPublishDeps {
  client: Pick<DeskClient, 'publishPaper'>
  /** `markEditionStale` — Today's edition AND its paper list are both out of date now. */
  invalidate: () => void
  /** `loadPapers` — the tick moves to the new row. */
  reloadPapers: () => Promise<void>
  /**
   * `client.refresh()` on the BOARD, so the glass picks the new edition up now rather than at its
   * next interval. `null` on a phone that owns no board, which is a supported configuration and
   * not a degraded one.
   */
  pollBoard: (() => Promise<void>) | null
}

export async function runPaperPublish(
  symbol: string,
  deps: PaperPublishDeps,
): Promise<PaperPublishResult> {
  let outcome
  try {
    outcome = await deps.client.publishPaper(symbol)
  } catch (e) {
    // Nothing moved, so nothing is invalidated and nothing is refetched: the list on screen is
    // still exactly right, and the sentence is the desk's own.
    return { kind: 'failed', error: humanDeskError(e) }
  }

  if (outcome.kind === 'no_paper') {
    // The DESK is right and the row is wrong. Refetch, so the row redraws as "not written yet"
    // rather than going on offering a paper that is gone. Nothing went on the glass, so there is
    // nothing for Today or the board to go and look at.
    await deps.reloadPapers().catch(() => undefined)
    return { kind: 'no_paper' }
  }

  // ORDER, AND WHY THE FIRST TWO ARE UNCONDITIONAL. The desk's `current` pointer has moved, which
  // is a fact about the desk and not about anything downstream — so Today is stale and the list is
  // stale whatever happens next.
  deps.invalidate()
  await deps.reloadPapers().catch(() => undefined)
  // And last, the board, whose failure is swallowed whole: it polls on its own interval anyway,
  // and this only buys the next few minutes. See the header.
  if (deps.pollBoard !== null) await deps.pollBoard().catch(() => undefined)

  return { kind: 'published', editionId: outcome.editionId }
}

/**
 * What `PaperSection` shows after a publish attempt, held as the fact plus its params rather than
 * as an already-rendered sentence.
 *
 * THE BUG THIS REPLACES: the section used to call `fill(t.papers.board.published, {symbol})` at
 * the moment the publish settled and keep the RESULT in `useState`. A component's state survives a
 * language switch; a plain string inside it does not follow one. Reading in Korean minutes after a
 * publish in English kept showing the English sentence beside otherwise-Korean copy. Holding the
 * outcome instead — `symbol`/`detail`, not a sentence — and resolving through `publishNoteText` at
 * every render fixes it the same way `desk.ts`'s `note` / `cadenceNote` fields already do: those
 * are a bare discriminant too, resolved to words only where the current `Strings` is in scope.
 */
export type PublishNote =
  | { kind: 'published'; symbol: string }
  | { kind: 'no_paper'; symbol: string }
  | { kind: 'failed'; detail: string }

/** `'ok'` only for a completed publish — `no_paper` and `failed` are both something to fix. */
export function publishNoteTone(note: PublishNote): 'ok' | 'error' {
  return note.kind === 'published' ? 'ok' : 'error'
}

/** The sentence for a `PublishNote`, in whatever language `t` currently is. */
export function publishNoteText(note: PublishNote, t: Strings): string {
  switch (note.kind) {
    case 'published':
      return fill(t.papers.board.published, { symbol: note.symbol })
    case 'no_paper':
      return fill(t.papers.board.gone, { symbol: note.symbol })
    case 'failed':
      return fill(t.papers.board.failed, { detail: note.detail })
  }
}
