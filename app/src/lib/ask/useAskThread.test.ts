// A test of `useAskThread`'s OWN WIRING — the sequencing inside `send`/`poll`/`publish`, not the
// pure functions underneath them, which `threads.test.ts` and `desk.test.ts` already cover. This
// app has no `@testing-library/react-native` (not installed) and no prior hook-rendering test to
// extend, so the harness below is hand-rolled from what IS already in `node_modules`:
// `react-test-renderer` (present, previously unused elsewhere) plus `act` and Jest's fake timers.
//
// THE HARNESS: a throwaway component renders the hook and stashes its return value on a plain
// object (`out.current`), read back after each `act()`. `expo-router`'s `useFocusEffect` is
// stubbed to a real `useEffect` so its callback and cleanup run under normal React semantics
// instead of a real navigation focus event. `createDeskClient` is mocked wholesale — this hook
// never exposes a `fetchFn` seam the way `desk.ts`'s own tests use, so there is no way to reach
// `desk.test.ts`'s `fakeFetch` idiom through the hook's public surface.
//
// The four behaviours named in the fix-round-1 review are covered here: (a) the optimistic send
// lifecycle through to a done answer with notes, and the poll going quiet once a turn is terminal;
// (b) the `poll()` re-entrancy guard — `publishNow()` called once, even when a slow tick overlaps
// the next timer fire; (c) a `revised` result marking the edition stale; (d) an `expired` turn
// dropping out of the poll with no error rendered.
//
// The final review added two more, both about a seam only this file can reach: (e) a send with no
// desk left to send to must FAIL the turn rather than return in silence, and (f) opening the
// screen with no `commandId` must open the most recent conversation, so a follow-up carries that
// thread's `reply_to`. `lastCommandId` is pure and tested next door; what was untested — and what
// produced the defect — is the hook's WIRING of it.
//
// EVERY TEST STARTS WITH AN EMPTY THREAD STORE. The AsyncStorage mock is one Map for the whole
// file, and (f) makes the hook read it on mount and act on what it finds: without the reset in
// `beforeEach`, one test's conversation would be the next test's opened thread.

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals'
import React from 'react'
import { act, create as renderTestTree, type ReactTestRenderer } from 'react-test-renderer'
import { useAskThread, ASK_POLL_MS, type AskThread } from './useAskThread'
import { createDeskClient, type Command, type DeskClient } from '../desk'
import { LanguageProvider } from '../../i18n'
import { saveDeskBaseUrl } from '../store'
import { clearDeskToken, saveDeskToken } from '../deskToken'
import { takeEditionStale, __resetEditionStaleForTests } from '../edition/invalidate'
import { writeThreads, type Thread } from './threads'

jest.mock('expo-router', () => {
  // `require`d inside the factory, not imported at the top of the file — Jest hoists `jest.mock`
  // calls above the module's own imports and refuses to close over anything from outside.
  const ReactActual = require('react')
  return {
    // The real hook subscribes to navigation focus; there is no navigator under Jest. Running the
    // callback inside a genuine `useEffect` reproduces "the screen is focused" closely enough for
    // this file's purposes — it commits after render and its cleanup runs on unmount, which is
    // exactly what the poll's own teardown (`clearInterval`) needs to be exercised at all.
    useFocusEffect: (cb: () => void | (() => void)) => {
      ReactActual.useEffect(() => cb(), [cb])
    },
  }
})

jest.mock('../desk', () => {
  const actual = jest.requireActual('../desk')
  // Everything real except the one call this hook makes to reach the network at all. `desk.ts`'s
  // own tests exercise the wire shape `postCommand`/`command`/`commandNotes`/`publishNow` build and
  // parse; this file only has to prove `useAskThread` calls them at the right moments.
  return { ...(actual as object), createDeskClient: jest.fn() }
})

const mockCreateDeskClient = jest.mocked(createDeskClient)

const BASE = 'https://desk.example.dev'
const TOKEN = 'operator-token-for-tests'

function row(over: Partial<Command> = {}): Command {
  return {
    id: 'cmd1',
    kind: 'ask',
    text: 'why did it move?',
    status: 'pending',
    result: null,
    replyTo: null,
    lang: 'en',
    source: 'app',
    createdAt: '2026-09-11T00:00:00Z',
    hasNotes: false,
    ...over,
  }
}

function notImplemented(name: string): () => never {
  return () => {
    throw new Error(`${name} is not used by useAskThread and must not be called in this test`)
  }
}

/** A `DeskClient` with the four methods `useAskThread` actually calls, as controllable mocks. */
function makeFakeClient() {
  const postCommand: jest.MockedFunction<DeskClient['postCommand']> = jest.fn()
  const command: jest.MockedFunction<DeskClient['command']> = jest.fn()
  const commandNotes: jest.MockedFunction<DeskClient['commandNotes']> = jest.fn()
  const publishNow: jest.MockedFunction<DeskClient['publishNow']> = jest.fn()
  const client: DeskClient = {
    getSettings: notImplemented('getSettings'),
    putSettings: notImplemented('putSettings'),
    positions: notImplemented('positions'),
    putPositions: notImplemented('putPositions'),
    calendar: notImplemented('calendar'),
    pushDevices: notImplemented('pushDevices'),
    registerPushDevice: notImplemented('registerPushDevice'),
    forgetPushDevice: notImplemented('forgetPushDevice'),
    postCommand,
    command,
    commandNotes,
    publishNow,
  }
  return { client, postCommand, command, commandNotes, publishNow }
}

/** A promise this test controls the settling of, to freeze the hook mid-flight. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

/** Drain the microtask queue a fixed, generous number of times. Cheap, and deep enough for every
 *  `await` chain in this file (a handful of hops at most, per dispatch). */
async function settle(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve()
  }
}

/** Advance the fake `setInterval` by one poll period and let its async work finish committing. */
async function tick(ms: number): Promise<void> {
  await act(async () => {
    jest.advanceTimersByTime(ms)
    await settle()
  })
}

async function flush(): Promise<void> {
  await act(async () => {
    await settle()
  })
}

function Harness({
  opts,
  out,
}: {
  opts: { commandId?: string | null }
  out: { current: AskThread | null }
}) {
  out.current = useAskThread(opts)
  return null
}

let renderer: ReactTestRenderer | null = null

async function mount(opts: { commandId?: string | null } = {}): Promise<{ current: AskThread | null }> {
  const out: { current: AskThread | null } = { current: null }
  await act(async () => {
    renderer = renderTestTree(
      React.createElement(LanguageProvider, null, React.createElement(Harness, { opts, out })),
    )
    await settle()
  })
  return out
}

describe('useAskThread', () => {
  beforeEach(async () => {
    jest.useFakeTimers()
    // The threads store is one shared Map across this file; test (f) mounts a hook that READS it
    // and opens what it finds, so a leftover conversation would silently join the next test's.
    await writeThreads([])
    // Both saved, so `clientFor()` finds a desk and every call below can actually run.
    await saveDeskBaseUrl(BASE)
    await saveDeskToken(TOKEN)
    __resetEditionStaleForTests()
  })

  afterEach(() => {
    if (renderer) {
      act(() => {
        renderer!.unmount()
      })
      renderer = null
    }
    jest.useRealTimers()
    // THE ONE MOCK THIS FILE OWNS, AND NOT `jest.resetAllMocks()`. The blanket reset also strips
    // the implementations off the shared AsyncStorage mock, whose every method is a `jest.fn`
    // carrying one — after which `setItem` stores nothing and `getItem` answers `undefined` for
    // the rest of the file. That went unnoticed while nothing here read the disk back: `store.ts`
    // caches the desk address in memory, so `clientFor()` kept working from the cache. Test (f)
    // does read it back, and the reset is what made it pass alone and fail in the suite.
    mockCreateDeskClient.mockReset()
  })

  it('a. send walks a turn from sending to a done answer with notes, then the poll goes quiet', async () => {
    const { client, postCommand, command, commandNotes } = makeFakeClient()
    mockCreateDeskClient.mockReturnValue(client)

    const { promise: postReply, resolve: resolvePost } = deferred<Command>()
    postCommand.mockReturnValueOnce(postReply)

    const out = await mount()

    let sendPromise!: Promise<void>
    await act(async () => {
      sendPromise = out.current!.send('what moved the stock today')
      await settle()
    })

    // Optimistic: appended and marked `sending` before the desk has answered at all.
    let turn = out.current!.threads[0].turns[0]
    expect(turn.status).toBe('sending')
    expect(turn.commandId).toBe(null)

    await act(async () => {
      resolvePost(row({ id: 'c1', status: 'pending' }))
      await sendPromise
      await settle()
    })

    // The desk's own status, not an assumed one.
    turn = out.current!.threads[0].turns[0]
    expect(turn.status).toBe('pending')
    expect(turn.commandId).toBe('c1')

    command.mockResolvedValueOnce(row({ id: 'c1', status: 'claimed' }))
    await tick(ASK_POLL_MS)
    turn = out.current!.threads[0].turns[0]
    expect(turn.status).toBe('claimed')

    command.mockResolvedValueOnce(row({ id: 'c1', status: 'done', result: 'answered', hasNotes: true }))
    commandNotes.mockResolvedValueOnce('Here is what moved it.')
    await tick(ASK_POLL_MS)
    turn = out.current!.threads[0].turns[0]
    expect(turn.status).toBe('done')
    expect(turn.result).toBe('answered')
    expect(turn.answer).toBe('Here is what moved it.')
    expect(command).toHaveBeenCalledTimes(2)
    expect(commandNotes).toHaveBeenCalledTimes(1)

    // Terminal: `isWorking` drops it from the next tick's working set — no fourth status branch
    // anywhere in the hook makes this true, `threads.ts`'s `isWorking` alone does.
    await tick(ASK_POLL_MS)
    expect(command).toHaveBeenCalledTimes(2)
  })

  it('b. an overlapping tick calls publishNow only once for a staged result', async () => {
    const { client, postCommand, command, publishNow } = makeFakeClient()
    mockCreateDeskClient.mockReturnValue(client)
    postCommand.mockResolvedValue(row({ id: 'c2', status: 'pending' }))
    publishNow.mockResolvedValue('published')

    const out = await mount()
    await act(async () => {
      await out.current!.send('please add the earnings date')
    })
    await flush()

    const { promise: firstReply, resolve: resolveFirstReply } = deferred<Command | null>()
    command.mockImplementationOnce(() => firstReply)

    // Tick 1 fires and stalls waiting on the desk.
    await tick(ASK_POLL_MS)
    expect(command).toHaveBeenCalledTimes(1)

    // Tick 2 fires while tick 1 is still in flight. This is the regression `pollInFlight` closes:
    // without it, this would be a second `client.command` call over the same still-working turn.
    await tick(ASK_POLL_MS)
    expect(command).toHaveBeenCalledTimes(1)

    // Now let tick 1's desk response land: a staged revision.
    await act(async () => {
      resolveFirstReply(row({ id: 'c2', status: 'done', result: 'staged e42', hasNotes: false }))
      await settle()
    })

    expect(publishNow).toHaveBeenCalledTimes(1)
    // `publish()` rewrites `staged` to `revised` once it goes through — `nextThreads`'s `'published'`
    // case, exercised here through the hook rather than by constructing the event directly.
    expect(out.current!.thread!.turns[0].result).toBe('revised e42')
  })

  it('c. a revised result marks the edition stale', async () => {
    const { client, postCommand, command } = makeFakeClient()
    mockCreateDeskClient.mockReturnValue(client)
    postCommand.mockResolvedValue(row({ id: 'c3', status: 'pending' }))
    command.mockResolvedValue(row({ id: 'c3', status: 'done', result: 'revised e99', hasNotes: false }))

    const out = await mount()
    await act(async () => {
      await out.current!.send('lead with the lawsuit instead')
    })
    await flush()

    expect(takeEditionStale()).toBe(false)

    await tick(ASK_POLL_MS)

    expect(takeEditionStale()).toBe(true)
    const turn = out.current!.thread!.turns[0]
    expect(turn.status).toBe('done')
    expect(turn.result).toBe('revised e99')
  })

  it('d. a turn that expires drops out of the poll, with no error rendered', async () => {
    const { client, postCommand, command } = makeFakeClient()
    mockCreateDeskClient.mockReturnValue(client)
    postCommand.mockResolvedValue(row({ id: 'c4', status: 'pending' }))
    command.mockResolvedValue(row({ id: 'c4', status: 'expired', result: null, hasNotes: false }))

    const out = await mount()
    await act(async () => {
      await out.current!.send('what moved the stock today')
    })
    await flush()

    await tick(ASK_POLL_MS)

    const turn = out.current!.thread!.turns[0]
    expect(turn.status).toBe('expired')
    expect(turn.error).toBe(null)
    expect(command).toHaveBeenCalledTimes(1)

    // Terminal, the same way `done` is in test (a): the next tick has nothing left to ask about.
    await tick(ASK_POLL_MS)
    expect(command).toHaveBeenCalledTimes(1)
  })

  it('e. a send with no desk left to send to fails the turn instead of stranding it', async () => {
    const { client, postCommand } = makeFakeClient()
    mockCreateDeskClient.mockReturnValue(client)

    // Mounted with a desk, so `ready` is true and the composer is on screen...
    const out = await mount()
    // ...and then the token is cleared in Settings while this screen stays mounted.
    await clearDeskToken()

    await act(async () => {
      await out.current!.send('what moved the stock today')
    })
    await flush()

    // Never posted, because there was nothing to post with.
    expect(postCommand).not.toHaveBeenCalled()
    // And NOT left at `sending`, which is the strand: nothing polls a `sending` turn and `TurnRow`
    // offers its retry on `unsent` alone, so the silent return this replaces left a row reading
    // "Sending…" with no way out of it.
    const turn = out.current!.threads[0].turns[0]
    expect(turn.status).toBe('unsent')
    expect(turn.error).not.toBe(null)
  })

  it('f. opened with no command id, the newest thread opens and a send replies to its last command', async () => {
    // Two conversations already on disk, newest first — the order `nextThreads` keeps.
    const stored: Thread[] = [
      {
        id: 'newest',
        turns: [
          {
            id: 'newest',
            commandId: 'c-new-1',
            text: 'why did it move?',
            lang: 'en',
            sentAt: 2000,
            status: 'done',
            result: 'answered',
            answer: 'Because of the guidance cut.',
            error: null,
          },
        ],
      },
      {
        id: 'older',
        turns: [
          {
            id: 'older',
            commandId: 'c-old-1',
            text: 'what is EPS?',
            lang: 'en',
            sentAt: 1000,
            status: 'done',
            result: 'answered',
            answer: 'Earnings per share.',
            error: null,
          },
        ],
      },
    ]
    await writeThreads(stored)

    const { client, postCommand } = makeFakeClient()
    mockCreateDeskClient.mockReturnValue(client)
    postCommand.mockResolvedValue(row({ id: 'c-new-2', status: 'pending' }))

    // No `commandId`: this is the Today pill, not a push tap.
    const out = await mount()

    // The exchange so far, not a blank composer.
    expect(out.current!.thread!.id).toBe('newest')

    await act(async () => {
      await out.current!.send('and what did the CFO say about it')
    })
    await flush()

    // THE SEAM THIS TEST EXISTS FOR: the follow-up joined the opened thread and carried that
    // thread's last command id. A blank composer would have started a third thread with no
    // `replyTo` at all, which is exactly the defect the whole-branch review found.
    expect(postCommand).toHaveBeenCalledWith({
      text: 'and what did the CFO say about it',
      lang: 'en',
      replyTo: 'c-new-1',
    })
    expect(out.current!.thread!.id).toBe('newest')
    expect(out.current!.thread!.turns).toHaveLength(2)
    // The older conversation is still kept, and still closed.
    expect(out.current!.threads).toHaveLength(2)
  })
})
