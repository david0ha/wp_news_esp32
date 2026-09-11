import { describe, it, expect, beforeEach } from '@jest/globals'
import { runPaperPublish, type PaperPublishDeps } from './publish'
import { setActiveLanguage } from '../../i18n'
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
