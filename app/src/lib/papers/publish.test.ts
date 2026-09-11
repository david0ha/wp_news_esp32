import { describe, it, expect, beforeEach } from '@jest/globals'
import {
  publishNoteText,
  publishNoteTone,
  runPaperPublish,
  type PaperPublishDeps,
  type PublishNote,
} from './publish'
import { setActiveLanguage } from '../../i18n'
import { en } from '../../i18n/en'
import { ko } from '../../i18n/ko'
import { DeskError, humanDeskError } from '../desk'

const deps = (
  publishPaper: PaperPublishDeps['client']['publishPaper'],
  over: Partial<PaperPublishDeps> = {},
) => {
  const calls = { invalidate: 0, reload: 0, poll: 0 }
  const d: PaperPublishDeps = {
    client: { publishPaper },
    invalidate: () => {
      calls.invalidate++
    },
    reloadPapers: async () => {
      calls.reload++
    },
    pollBoard: async () => {
      calls.poll++
    },
    ...over,
  }
  return { d, calls }
}

beforeEach(() => setActiveLanguage('en'))

describe('runPaperPublish', () => {
  it('publishes, marks Today stale, refetches the list, then pokes the board', async () => {
    const { d, calls } = deps(async () => ({
      kind: 'published' as const,
      editionId: 'e1',
      state: 'published',
    }))
    expect(await runPaperPublish('SNDK', d)).toEqual({ kind: 'published', editionId: 'e1' })
    expect(calls).toEqual({ invalidate: 1, reload: 1, poll: 1 })
  })

  it('treats "already on the board" as a publish', async () => {
    // `promote()` answers `unchanged` when the symbol's newest edition is already `current`. The
    // row was drawn without a tick, the owner tapped it, and the world now matches what they
    // asked for. Reporting a failure over that would be reporting the request as the problem.
    const { d, calls } = deps(async () => ({
      kind: 'published' as const,
      editionId: 'e1',
      state: 'unchanged',
    }))
    expect(await runPaperPublish('SNDK', d)).toEqual({ kind: 'published', editionId: 'e1' })
    expect(calls.reload).toBe(1)
  })

  it('refetches the list after a no_paper too, because the list was wrong', async () => {
    // The row said there was a paper and the desk says there is not — pruned since the fetch. The
    // list on screen is out of date about exactly this row, so it is the one thing worth doing.
    const { d, calls } = deps(async () => ({ kind: 'no_paper' as const }))
    expect(await runPaperPublish('MU', d)).toEqual({ kind: 'no_paper' })
    expect(calls.reload).toBe(1)
    // Nothing went on the glass, so there is nothing for Today or the board to go and look at.
    expect(calls.invalidate).toBe(0)
    expect(calls.poll).toBe(0)
  })

  it("reports the desk's own reason when the publish is refused", async () => {
    // R-19: assert against `humanDeskError` itself, not a substring of its English copy — that
    // pins the real contract (the sequence surfaces the desk client's own sentence) without
    // pinning the wording.
    const error = new DeskError('unauthorized', 'papers responded 403', 403)
    const { d, calls } = deps(async () => {
      throw error
    })
    const result = await runPaperPublish('SNDK', d)
    expect(result.kind).toBe('failed')
    if (result.kind !== 'failed') throw new Error('unreachable')
    expect(result.error).toEqual(humanDeskError(error))
    expect(calls).toEqual({ invalidate: 0, reload: 0, poll: 0 })
  })

  it('still counts as published when the board cannot be reached', async () => {
    // THE BOARD IS NOT THE SUBJECT. A sleeping board, an unreachable one, or no board at all is
    // the ordinary case; the desk did what it was asked and the glass catches up on its own
    // interval. Failing here would blame the desk for the ESP32.
    const { d, calls } = deps(
      async () => ({ kind: 'published' as const, editionId: 'e1', state: 'published' }),
      {
        pollBoard: async () => {
          throw new Error('board asleep')
        },
      },
    )
    expect(await runPaperPublish('SNDK', d)).toEqual({ kind: 'published', editionId: 'e1' })
    expect(calls.invalidate).toBe(1)
    expect(calls.reload).toBe(1)
  })

  it('publishes perfectly well on a phone that owns no board', async () => {
    const { d, calls } = deps(
      async () => ({ kind: 'published' as const, editionId: 'e1', state: 'published' }),
      { pollBoard: null },
    )
    expect(await runPaperPublish('SNDK', d)).toEqual({ kind: 'published', editionId: 'e1' })
    expect(calls.poll).toBe(0)
    expect(calls.reload).toBe(1)
  })

  it('marks and refetches even when the refetch itself throws', async () => {
    // `loadPapers` never throws by construction, but this is the one caller that would be left
    // half-done if it ever did, and the mark it would drop is the one Today reads.
    const seen: string[] = []
    const { d } = deps(
      async () => ({ kind: 'published' as const, editionId: 'e1', state: 'published' }),
      {
        invalidate: () => seen.push('invalidate'),
        reloadPapers: async () => {
          seen.push('reload')
          throw new Error('nope')
        },
      },
    )
    expect(await runPaperPublish('SNDK', d)).toEqual({ kind: 'published', editionId: 'e1' })
    expect(seen).toEqual(['invalidate', 'reload'])
  })

  it('sends the symbol through untouched', async () => {
    const seen: string[] = []
    const { d } = deps(async (s: string) => {
      seen.push(s)
      return { kind: 'published' as const, editionId: 'e1', state: 'published' }
    })
    await runPaperPublish('BRK.B', d)
    expect(seen).toEqual(['BRK.B'])
  })
})

// D2 — the Board tab's publish note used to be resolved to a sentence at the moment the publish
// settled and kept in `useState` as that string. A component's state survives a language switch;
// a plain string inside it does not follow one, so reading the tab in Korean minutes after an
// English publish kept showing the English sentence. `PublishNote` holds the fact (`symbol` /
// `detail`), never the words, so re-resolving it through a different catalogue — exactly what a
// language switch does to the `t` a render sees — has to produce that catalogue's own sentence.
describe('publishNoteText', () => {
  const note: PublishNote = { kind: 'published', symbol: 'MU' }

  it('renders the fact in whichever language it is asked to, from the SAME held note', () => {
    expect(publishNoteText(note, en)).toBe('MU is on the board. The panel takes about half a minute to redraw.')
    expect(publishNoteText(note, ko)).toBe('MU을(를) 보드에 걸었어요. 화면이 다시 그려지는 데 30초쯤 걸려요.')
  })

  it('follows a language switch after the note was already set — the exact D2 defect', () => {
    // The bug was a STRING resolved once and left in state. Proving the fix means resolving the
    // very same `note` value twice, under two different catalogues, and getting two different
    // sentences — a resolved-string bug would fail this by construction, since there would be
    // only one string to check regardless of which catalogue is passed second.
    const setInEnglish = publishNoteText(note, en)
    const readAfterSwitchingToKorean = publishNoteText(note, ko)
    expect(readAfterSwitchingToKorean).not.toBe(setInEnglish)
    expect(readAfterSwitchingToKorean).toBe(ko.papers.board.published.replace('{symbol}', 'MU'))
  })

  it('renders the no_paper and failed facts the same way, in either language', () => {
    const gone: PublishNote = { kind: 'no_paper', symbol: 'AAPL' }
    expect(publishNoteText(gone, en)).toBe('The desk has no paper for AAPL any more.')
    expect(publishNoteText(gone, ko)).toBe('데스크에 AAPL 지면이 더 이상 없어요.')

    const failed: PublishNote = { kind: 'failed', detail: 'the desk did not answer' }
    expect(publishNoteText(failed, en)).toBe('That didn’t go on the board. the desk did not answer')
  })
})

describe('publishNoteTone', () => {
  it('is ok only for a completed publish', () => {
    expect(publishNoteTone({ kind: 'published', symbol: 'MU' })).toBe('ok')
    expect(publishNoteTone({ kind: 'no_paper', symbol: 'MU' })).toBe('error')
    expect(publishNoteTone({ kind: 'failed', detail: 'x' })).toBe('error')
  })
})
