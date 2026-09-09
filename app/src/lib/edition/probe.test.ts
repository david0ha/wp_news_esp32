import { describe, it, expect, jest } from '@jest/globals'

import { setActiveLanguage } from '../../i18n'
import { EditionError, type EditionClient, type EditionFetch } from './client'
import { probeEdition } from './probe'
import { parseEdition } from './parse'

const URL = 'https://desk.example/news.json'

/** A client whose one method answers however this test says, so nothing here touches the network. */
function client(answer: () => Promise<EditionFetch>): Pick<EditionClient, 'fetch'> {
  return { fetch: jest.fn(answer) as unknown as EditionClient['fetch'] }
}

function ok(wire: unknown): EditionFetch {
  return { status: 'ok', edition: parseEdition(wire), wire, etag: null }
}

describe('probeEdition', () => {
  it('asks unconditionally — a 304 confirms a cache this function does not have', async () => {
    const fetch = jest.fn(async () => ok({ subject: { name: 'Acme Corp' } })) as never
    await probeEdition(URL, { fetch } as unknown as Pick<EditionClient, 'fetch'>)
    expect(fetch).toHaveBeenCalledWith(URL, null)
  })

  it('reports the company and the dateline it found', async () => {
    const c = client(async () =>
      ok({ subject: { name: 'Acme Corp', symbol: 'ACME' }, dateline: 'WEDNESDAY, 9 SEPTEMBER' }),
    )
    expect(await probeEdition(URL, c)).toEqual({
      status: 'ok',
      subject: 'Acme Corp',
      dateline: 'WEDNESDAY, 9 SEPTEMBER',
    })
  })

  it('falls back to the symbol when the payload named no company', async () => {
    // The masthead makes the same substitution, and for the same reason: a symbol is a name a
    // reader recognises, and an empty slot is not.
    const c = client(async () => ok({ subject: { symbol: 'ACME' }, dateline: '' }))
    expect(await probeEdition(URL, c)).toEqual({ status: 'ok', subject: 'ACME', dateline: '' })
  })

  it('never throws — a probe is a question, and silence is one of the answers', async () => {
    const c = client(async () => {
      throw new EditionError('transport', 'getaddrinfo ENOTFOUND desk.example')
    })
    const r = await probeEdition(URL, c)
    expect(r.status).toBe('failed')
    // The reader's own sentence, not the exception's text: `humanEditionError` is what the Today
    // tab would print for this failure, and the save must not invent a second vocabulary for it.
    expect(r).toEqual({
      status: 'failed',
      message: 'Couldn’t reach the edition server. Check the connection, then pull to refresh.',
    })
  })

  it('says nothing at all about the empty address, which is the demo and not a server', async () => {
    const fetch = jest.fn() as never
    expect(await probeEdition('', { fetch } as unknown as Pick<EditionClient, 'fetch'>)).toEqual({
      status: 'skipped',
    })
    expect(await probeEdition('   ', { fetch } as unknown as Pick<EditionClient, 'fetch'>)).toEqual({
      status: 'skipped',
    })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('carries the failure in the app’s language', async () => {
    setActiveLanguage('ko')
    try {
      const c = client(async () => {
        throw new EditionError('http', 'answered 404', 404)
      })
      const r = await probeEdition(URL, c)
      expect(r.status).toBe('failed')
      expect(r.status === 'failed' && r.message).toMatch(/[가-힣]/)
      expect(r.status === 'failed' && r.message).toContain('404')
    } finally {
      setActiveLanguage('en')
    }
  })
})
