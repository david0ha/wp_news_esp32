// The Board tab's rows, rendered — and one question asked of them: which rows say "Due a refresh".
//
// It is a RENDERED test rather than another pure one because the rule it pins is not a new rule.
// `paperHeaderChips` already decides it and `order.test.ts` already holds it to that (including the
// case that matters most: a symbol with no paper at all gets no marker, because "due a refresh" is
// a claim about a paper that exists). What was untestable until now is whether this row actually
// ASKS that helper — the defect the marker was added to close was a screen that never drew the fact
// the desk had already computed, and no assertion about a pure function can see that.
//
// The harness is `useAskThread.test.ts`'s: `react-test-renderer`, which is what is in
// `node_modules`; this app has no `@testing-library/react-native`. `usePapers` is mocked to hand
// the section a fixed list, and `expo-router`'s `useFocusEffect` is stubbed to a real `useEffect`
// so the focus load runs and tears down under ordinary React semantics.

import { describe, it, expect, jest } from '@jest/globals'
import React from 'react'
import { act, create as renderTestTree } from 'react-test-renderer'
import { PaperSection } from './PaperSection'
import { en } from '../../i18n/en'
import { type Paper, type PapersDoc } from '../../lib/desk'

jest.mock('expo-router', () => {
  const ReactActual = require('react')
  return {
    useFocusEffect: (cb: () => void | (() => void)) => {
      ReactActual.useEffect(() => cb(), [cb])
    },
  }
})

jest.mock('../../lib/papers/list', () => ({
  usePapers: jest.fn(),
  loadPapers: jest.fn(async () => undefined),
}))

const { usePapers } = jest.requireMock('../../lib/papers/list') as {
  usePapers: jest.Mock<() => { ready: boolean | null; doc: PapersDoc | null }>
}

function paper(over: Partial<Paper> = {}): Paper {
  return {
    symbol: 'SNDK',
    name: 'SanDisk',
    editionId: 'ed00000000000001',
    createdAt: 1_700_000_000_000,
    lang: 'en',
    headline: null,
    onBoard: false,
    stale: false,
    ...over,
  }
}

/** Every string the section rendered, flattened out of the tree. */
function textsOf(papers: Paper[]): string[] {
  usePapers.mockReturnValue({ ready: true, doc: { papers, board: null } })
  let tree: ReturnType<typeof renderTestTree> | null = null
  act(() => {
    tree = renderTestTree(React.createElement(PaperSection, { pollBoard: null }))
  })
  const found: string[] = []
  const walk = (node: unknown): void => {
    if (typeof node === 'string') {
      found.push(node)
      return
    }
    if (Array.isArray(node)) {
      node.forEach(walk)
      return
    }
    if (node !== null && typeof node === 'object' && 'children' in node) {
      walk((node as { children: unknown }).children)
    }
  }
  walk(tree!.toJSON())
  act(() => {
    tree!.unmount()
  })
  return found
}

const STALE = en.papers.page.stale

describe('the Board tab’s staleness marker', () => {
  it('marks a paper the desk called stale, and only that one', () => {
    const rows = textsOf([
      paper({ symbol: 'SNDK', stale: true }),
      paper({ symbol: 'AAPL', stale: false }),
    ])
    // The desk's own wording, reused rather than re-invented: the same catalogue entry the pager's
    // header chip draws from.
    expect(rows.filter((s) => s === STALE)).toHaveLength(1)
    expect(rows).toContain('SNDK')
    expect(rows).toContain('AAPL')
  })

  it('marks the paper that is ON the board when it is stale too', () => {
    // `on_board` and `stale` are independent facts, and the paper on the glass is exactly the one
    // whose staleness the owner most needs to see on the screen where they choose what to print.
    expect(textsOf([paper({ onBoard: true, stale: true })])).toContain(STALE)
  })

  it('leaves a symbol with no paper unmarked, whatever the desk said about it', () => {
    // D1c. A row with no edition is drawn and dead; "due a refresh" would claim a paper exists.
    const rows = textsOf([paper({ editionId: null, createdAt: null, stale: true })])
    expect(rows).not.toContain(STALE)
    expect(rows).toContain(en.papers.board.noPaper)
  })
})
