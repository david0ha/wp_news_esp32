import AsyncStorage from '@react-native-async-storage/async-storage'
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals'
import {
  isWorking,
  lastCommandId,
  MAX_THREADS,
  newTurnId,
  nextThreads,
  readResult,
  readThreads,
  sanitizeThreads,
  THREADS_KEY,
  threadIsWorking,
  threadOfCommand,
  writeThreads,
  type Thread,
  type Turn,
} from './threads'
import { type Command } from '../desk'

const row = (over: Partial<Command> = {}): Command => ({
  id: 'cmd1',
  kind: 'ask',
  text: 'why did it move?',
  status: 'pending',
  result: null,
  replyTo: null,
  lang: 'ko',
  source: 'app',
  createdAt: '2026-09-10T01:02:03Z',
  hasNotes: false,
  ...over,
})

/** A thread with one turn that has reached the desk and is waiting. */
function pending(): Thread[] {
  let t = nextThreads([], {
    type: 'typed',
    threadId: 'th1',
    turnId: 'th1',
    text: 'why did it move?',
    lang: 'ko',
    at: 1000,
  })
  return nextThreads(t, { type: 'accepted', turnId: 'th1', command: row() })
}

const only = (threads: Thread[]): Turn => threads[0].turns[0]

describe('typing a message', () => {
  it('opens a thread whose id is the first turn’s, with the turn sending', () => {
    const threads = nextThreads([], {
      type: 'typed',
      threadId: 'th1',
      turnId: 'th1',
      text: 'why did it move?',
      lang: 'ko',
      at: 1000,
    })
    expect(threads).toHaveLength(1)
    expect(threads[0].id).toBe('th1')
    expect(only(threads)).toEqual({
      id: 'th1',
      commandId: null,
      text: 'why did it move?',
      lang: 'ko',
      sentAt: 1000,
      status: 'sending',
      result: null,
      answer: null,
      error: null,
    })
  })

  it('appends a follow-up to the thread it names, and does not reorder it', () => {
    const threads = nextThreads(pending(), {
      type: 'typed',
      threadId: 'th1',
      turnId: 'turn2',
      text: 'and the CFO?',
      lang: 'ko',
      at: 2000,
    })
    expect(threads).toHaveLength(1)
    expect(threads[0].turns.map((t) => t.id)).toEqual(['th1', 'turn2'])
  })

  it('puts a new thread at the front — a list is read from the top', () => {
    const threads = nextThreads(pending(), {
      type: 'typed',
      threadId: 'th2',
      turnId: 'th2',
      text: 'lead with the lawsuit',
      lang: 'en',
      at: 3000,
    })
    expect(threads.map((t) => t.id)).toEqual(['th2', 'th1'])
  })

  it('drops the oldest thread past the cap rather than growing forever', () => {
    let threads: Thread[] = []
    for (let i = 0; i <= MAX_THREADS; i++) {
      threads = nextThreads(threads, {
        type: 'typed',
        threadId: `th${i}`,
        turnId: `th${i}`,
        text: 'x',
        lang: 'en',
        at: i,
      })
    }
    expect(threads).toHaveLength(MAX_THREADS)
    expect(threads[threads.length - 1].id).toBe('th1')
  })
})

describe('the desk answering', () => {
  it('takes the command id and the status the desk created the row with', () => {
    const t = only(pending())
    expect(t.commandId).toBe('cmd1')
    expect(t.status).toBe('pending')
  })

  it('moves pending to claimed', () => {
    const threads = nextThreads(pending(), {
      type: 'polled',
      commandId: 'cmd1',
      status: 'claimed',
      result: null,
    })
    expect(only(threads).status).toBe('claimed')
  })

  it('moves claimed to done, carrying the result', () => {
    const threads = nextThreads(pending(), {
      type: 'polled',
      commandId: 'cmd1',
      status: 'done',
      result: 'answered',
    })
    expect(only(threads)).toMatchObject({ status: 'done', result: 'answered' })
  })

  it('stores the answer against the turn', () => {
    const threads = nextThreads(pending(), {
      type: 'answered',
      commandId: 'cmd1',
      answer: '## Why\n\nThe guide.',
    })
    expect(only(threads).answer).toBe('## Why\n\nThe guide.')
  })

  it('records a failure with the worker’s message', () => {
    const threads = nextThreads(
      nextThreads(pending(), {
        type: 'polled',
        commandId: 'cmd1',
        status: 'failed',
        result: 'no answer written',
      }),
      { type: 'error', commandId: 'cmd1', error: 'The desk couldn’t answer this.' },
    )
    expect(only(threads)).toMatchObject({
      status: 'failed',
      result: 'no answer written',
      error: 'The desk couldn’t answer this.',
    })
  })

  it('marks a forgotten command failed rather than leaving it pending forever', () => {
    const threads = nextThreads(pending(), {
      type: 'forgotten',
      commandId: 'cmd1',
      error: 'The desk no longer has this message.',
    })
    expect(only(threads)).toMatchObject({ status: 'failed', error: 'The desk no longer has this message.' })
  })

  it('ignores an event about a command it does not hold', () => {
    const before = pending()
    expect(nextThreads(before, { type: 'polled', commandId: 'nope', status: 'done', result: 'answered' }))
      .toEqual(before)
  })
})

describe('a send that did not reach the desk', () => {
  it('keeps the turn, marks it unsent, and holds the reason', () => {
    let threads = nextThreads([], {
      type: 'typed',
      threadId: 'th1',
      turnId: 'th1',
      text: 'why did it move?',
      lang: 'ko',
      at: 1000,
    })
    threads = nextThreads(threads, {
      type: 'send_failed',
      turnId: 'th1',
      error: 'Couldn’t reach the desk.',
    })
    // The TEXT is what a retry needs, so it must survive — a failure that cleared the composer
    // would make the owner type the message again.
    expect(only(threads)).toMatchObject({
      status: 'unsent',
      text: 'why did it move?',
      error: 'Couldn’t reach the desk.',
    })
  })

  it('a retry sends the same turn again, clearing the error and re-stamping the clock', () => {
    let threads = nextThreads([], {
      type: 'typed',
      threadId: 'th1',
      turnId: 'th1',
      text: 'why did it move?',
      lang: 'ko',
      at: 1000,
    })
    threads = nextThreads(threads, { type: 'send_failed', turnId: 'th1', error: 'nope' })
    threads = nextThreads(threads, { type: 'retry', turnId: 'th1', at: 5000 })
    expect(only(threads)).toMatchObject({ status: 'sending', error: null, sentAt: 5000 })
    // And it is still ONE turn: a retry that appended would post the message twice.
    expect(threads[0].turns).toHaveLength(1)
  })
})

describe('publishing a staged revision', () => {
  const staged = () =>
    nextThreads(pending(), {
      type: 'polled',
      commandId: 'cmd1',
      status: 'done',
      result: 'staged abc123',
    })

  it('rewrites staged to revised, because that is now what happened', () => {
    const threads = nextThreads(staged(), { type: 'published', commandId: 'cmd1' })
    expect(only(threads).result).toBe('revised abc123')
    expect(only(threads).error).toBeNull()
  })

  it('leaves it staged and says why when the publish was refused', () => {
    const threads = nextThreads(staged(), {
      type: 'publish_failed',
      commandId: 'cmd1',
      error: 'The desk wouldn’t publish it.',
    })
    expect(only(threads)).toMatchObject({
      result: 'staged abc123',
      error: 'The desk wouldn’t publish it.',
    })
  })
})

describe('readResult — the first word, and nothing else parsed', () => {
  it('reads the three words the worker writes', () => {
    expect(readResult('answered')).toEqual({ kind: 'answered' })
    expect(readResult('revised abc123')).toEqual({ kind: 'revised', editionId: 'abc123' })
    expect(readResult('staged abc123')).toEqual({ kind: 'staged', editionId: 'abc123' })
  })

  it('reads a revision with no edition id as a revision anyway', () => {
    // The chip is about the paper changing. An id the desk did not send costs the phone nothing:
    // it refetches `news.json`, which is the only thing the id would have been used for.
    expect(readResult('revised')).toEqual({ kind: 'revised', editionId: '' })
  })

  it('keeps anything else whole rather than guessing at it', () => {
    expect(readResult('the ticker could not be resolved')).toEqual({
      kind: 'other',
      text: 'the ticker could not be resolved',
    })
  })

  it('answers null for a row with no result yet', () => {
    expect(readResult(null)).toBeNull()
    expect(readResult('')).toBeNull()
  })
})

describe('the questions the poll and the router ask', () => {
  it('counts sending, pending and claimed as working, and nothing else', () => {
    const t = (status: Turn['status']): Turn => ({ ...only(pending()), status })
    expect(['sending', 'pending', 'claimed'].map((s) => isWorking(t(s as Turn['status']))))
      .toEqual([true, true, true])
    expect(['done', 'failed', 'expired', 'cancelled', 'unsent'].map((s) => isWorking(t(s as Turn['status']))))
      .toEqual([false, false, false, false, false])
  })

  it('a thread is working while any turn in it is', () => {
    expect(threadIsWorking(pending()[0])).toBe(true)
    const done = nextThreads(pending(), {
      type: 'polled',
      commandId: 'cmd1',
      status: 'done',
      result: 'answered',
    })
    expect(threadIsWorking(done[0])).toBe(false)
  })

  it('finds the thread a push’s command id belongs to', () => {
    expect(threadOfCommand(pending(), 'cmd1')?.id).toBe('th1')
    expect(threadOfCommand(pending(), 'nope')).toBeNull()
  })

  it('names the last turn that actually reached the desk, for reply_to', () => {
    // An unsent turn is not a previous turn: the desk has no row for it, and `reply_to` is
    // validated against one that exists.
    let threads = nextThreads(pending(), {
      type: 'typed',
      threadId: 'th1',
      turnId: 'turn2',
      text: 'and the CFO?',
      lang: 'ko',
      at: 2000,
    })
    expect(lastCommandId(threads[0])).toBe('cmd1')
    threads = nextThreads(threads, { type: 'accepted', turnId: 'turn2', command: row({ id: 'cmd2' }) })
    expect(lastCommandId(threads[0])).toBe('cmd2')
  })

  it('mints an id that is unique within a millisecond', () => {
    expect(newTurnId(1000, 0)).not.toBe(newTurnId(1000, 1))
  })
})

describe('sanitizeThreads — what survives a read off disk', () => {
  it('reads back what the reducer wrote', () => {
    expect(sanitizeThreads(JSON.parse(JSON.stringify(pending())))).toEqual(pending())
  })

  it('drops a thread it cannot read without taking the others with it', () => {
    // A thread is the owner's own history. Refusing the whole file over one bad entry would throw
    // away every conversation because of one.
    const good = pending()
    expect(sanitizeThreads([{ id: 42 }, ...good, { turns: 'no' }])).toEqual(good)
  })

  it('drops a turn with an unknown status rather than a whole thread', () => {
    const raw = JSON.parse(JSON.stringify(pending())) as Array<{ turns: unknown[] }>
    raw[0].turns.push({ id: 'x', commandId: null, text: 'x', lang: 'en', sentAt: 1, status: 'zzz', result: null, answer: null, error: null })
    expect(sanitizeThreads(raw)[0].turns).toHaveLength(1)
  })

  it('reads a stored `sending` back as `unsent`, because the POST it named is gone', () => {
    // The one status this function rewrites. `sending` means a request is in flight, and a
    // request cannot outlive the process that issued it — so a `sending` turn on disk belongs to
    // a process that died mid-POST. Left alone it is unrecoverable: the poll's working set skips
    // `sending` and `TurnRow` draws its retry button on `unsent` alone, which is a row reading
    // "Sending…" forever with nothing to press. This test would catch anyone restoring it
    // verbatim again.
    const typed = nextThreads([], {
      type: 'typed',
      threadId: 'th9',
      turnId: 'th9',
      text: 'lead with the lawsuit',
      lang: 'en',
      at: 2000,
    })
    expect(only(typed).status).toBe('sending')
    const back = sanitizeThreads(JSON.parse(JSON.stringify(typed)))
    expect(only(back).status).toBe('unsent')
    // Nothing else about the turn moves: the text is still there to retry, and the retry button
    // is the only thing this rewrite is for.
    expect(only(back).text).toBe('lead with the lawsuit')
    expect(only(back).commandId).toBe(null)
  })

  it('drops a thread left with no turns at all', () => {
    expect(sanitizeThreads([{ id: 'th1', turns: [] }])).toEqual([])
  })

  it('reads anything that is not a list as no threads', () => {
    expect(sanitizeThreads(null)).toEqual([])
    expect(sanitizeThreads({ threads: [] })).toEqual([])
  })
})

describe('threads on disk', () => {
  beforeEach(async () => {
    await AsyncStorage.clear()
  })
  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('is namespaced under this board’s own name, and the literal is pinned', () => {
    // Renaming this key is not a refactor: every install already carrying threads would wake up
    // with none, the same way `store.ts` pins its three.
    expect(THREADS_KEY).toBe('claudepost.threads')
  })

  it('writes and reads back the same conversations', async () => {
    await writeThreads(pending())
    expect(await readThreads()).toEqual(pending())
  })

  it('reads an empty store as no conversations', async () => {
    expect(await readThreads()).toEqual([])
  })

  it('reads something that is not JSON as no conversations', async () => {
    await AsyncStorage.setItem(THREADS_KEY, 'not json')
    expect(await readThreads()).toEqual([])
  })

  it('reads a store that threw as no conversations rather than crashing a screen', async () => {
    // `...Once`, not the persistent form: the official AsyncStorage mock's methods are already
    // `jest.fn()`s, so spying on one and overriding it permanently leaves nothing real for
    // `restoreAllMocks()` to restore — the next test's calls would keep rejecting. A one-shot
    // rejection is exactly what this test needs and does not carry that trap; `deskToken.test.ts`
    // uses the same idiom for the same reason.
    jest.spyOn(AsyncStorage, 'getItem').mockRejectedValueOnce(new Error('disk'))
    expect(await readThreads()).toEqual([])
  })

  it('never writes more than the cap', async () => {
    const many = Array.from({ length: MAX_THREADS + 5 }, (_, i) => ({
      id: `th${i}`,
      turns: pending()[0].turns,
    }))
    await writeThreads(many)
    expect(await readThreads()).toHaveLength(MAX_THREADS)
  })

  it('swallows a failed write — a lost thread costs a refetch, a crash costs the screen', async () => {
    // Same reasoning as the read above: `...Once` so this test's rejection does not outlive it.
    jest.spyOn(AsyncStorage, 'setItem').mockRejectedValueOnce(new Error('disk full'))
    await expect(writeThreads(pending())).resolves.toBeUndefined()
  })
})
