import { describe, it, expect } from '@jest/globals'
import { readFileSync } from 'fs'
import { join } from 'path'
import { demoEdition } from './demo'
import { isEmptyEdition } from './parse'

// The two files that must never drift, and the assertion that holds them together — the app's
// half of what `test_news_mock` does for the firmware. `demo.json` is not "a sample": it is the
// payload an unconfigured board prints, so a phone with no URL and a board with no URL must be
// showing the same edition or the demo is lying about what the hardware does.
const APP_COPY = join(__dirname, 'demo.json')
const REPO_FIXTURE = join(__dirname, '../../../../components/news_core/test/host/fixtures/news.json')

describe('the bundled demo edition', () => {
  it('is byte-identical to the repo fixture', () => {
    const app = readFileSync(APP_COPY)
    const repo = readFileSync(REPO_FIXTURE)
    // Compare the length first: a mismatch report of two 20 KB buffers is unreadable, and the
    // length alone already says "somebody edited one of them".
    expect(app.length).toBe(repo.length)
    expect(app.equals(repo)).toBe(true)
  })

  it('parses to a complete front page', () => {
    const e = demoEdition()
    expect(isEmptyEdition(e)).toBe(false)
    expect(e.subject.symbol).toBe('SNDK')
    expect(e.stories).toHaveLength(4)
    expect(e.figures).toHaveLength(22)
    expect(e.charts).toHaveLength(2)
  })

  it('returns the same object every call — it is parsed once', () => {
    expect(demoEdition()).toBe(demoEdition())
  })
})
