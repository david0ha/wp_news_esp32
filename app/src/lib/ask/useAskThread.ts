// The ask screen's data loop: React state and effects around `nextThreads`, which is where every
// decision actually lives.
//
// THE EFFECTS ARE DULL BY CONSTRUCTION. This app has no component test runner, so anything argued
// inside a hook body is argued only in prose — the rule `useEdition.ts` states and `editionState.ts`
// exists for. Everything here is: read storage, call the desk, dispatch an event, write storage.
//
// THE POLL IS FOCUS-GATED AND STOPS ON ITS OWN. `board.tsx`'s idiom: an interval installed inside
// `useFocusEffect` with a `focused` ref, so nothing polls a screen that is not on top. It also has
// nothing to do once no turn is working, which is the common state of an open thread — the desk
// takes minutes to answer and then the conversation sits there.
//
// THE TOKEN IS READ FOR THE CALL AND GONE WITH THE FRAME — `schedule.tsx`'s and `useEventBook`'s
// rule. It lives in the keychain, reaches exactly one header inside `createDeskClient`, and is in
// nothing this module keeps and nothing it persists.

import { useCallback, useEffect, useRef, useState } from 'react'
import { useFocusEffect } from 'expo-router'
import { fill, useLanguage, useStrings } from '../../i18n'
import { createDeskClient, humanDeskError, MAX_COMMAND_TEXT, type DeskClient } from '../desk'
import { getDeskToken } from '../deskToken'
import { getDeskBaseUrl } from '../store'
import { markEditionStale } from '../edition/invalidate'
import {
  isWorking,
  lastCommandId,
  newTurnId,
  nextThreads,
  readResult,
  readThreads,
  writeThreads,
  threadOfCommand,
  type Thread,
  type ThreadEvent,
} from './threads'

/** Five seconds, the figure `board.tsx` polls the board at, for a desk that answers in minutes. */
export const ASK_POLL_MS = 5_000

export interface AskThread {
  /** A desk address and an operator token are both saved. `null` while storage has not answered. */
  ready: boolean | null
  threads: Thread[]
  /** The conversation on screen, or `null` for a screen composing a new one. */
  thread: Thread | null
  open: (threadId: string | null) => void
  send: (text: string) => Promise<void>
  retry: (turnId: string) => Promise<void>
  publish: (commandId: string) => Promise<void>
}

export function useAskThread(opts: { commandId?: string | null } = {}): AskThread {
  const t = useStrings()
  // THE RESOLVED LANGUAGE, NEVER THE CHOICE. `useLanguage().choice` can be `system`, which is not
  // a language and is not something the desk takes — `resolved` is what `system` came out as.
  const { resolved: lang } = useLanguage()
  const [ready, setReady] = useState<boolean | null>(null)
  const [threads, setThreads] = useState<Thread[]>([])
  const [openId, setOpenId] = useState<string | null>(null)

  // A synchronous mirror: every async pass below reads the current list, and a closed-over
  // `threads` would be the one from the render that started it.
  const threadsRef = useRef<Thread[]>(threads)
  threadsRef.current = threads

  // Two ids that would collide inside one millisecond, kept apart.
  const seq = useRef(0)

  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  /**
   * The one place state moves. Dispatch, mirror, persist — and persist without awaiting, because
   * the caller's next act is to render and a disk round trip has nothing to do with what is drawn.
   */
  const dispatch = useCallback((event: ThreadEvent) => {
    const next = nextThreads(threadsRef.current, event)
    if (next === threadsRef.current) return
    threadsRef.current = next
    if (alive.current) setThreads(next)
    void writeThreads(next)
  }, [])

  /** A client for this call, built from storage each time. Nothing here holds a token. */
  const clientFor = useCallback(async (): Promise<DeskClient | null> => {
    const [address, token] = await Promise.all([getDeskBaseUrl(), getDeskToken()])
    if (!address || !token) {
      if (alive.current) setReady(false)
      return null
    }
    if (alive.current) setReady(true)
    return createDeskClient({ baseUrl: address, token })
  }, [])

  // The conversations off disk, once, plus whether there is a desk to talk to at all.
  useEffect(() => {
    void (async () => {
      const stored = await readThreads()
      if (!alive.current) return
      threadsRef.current = stored
      setThreads(stored)
      // A push routes by COMMAND id; the thread it belongs to is a lookup over what was just read.
      if (opts.commandId) {
        const found = threadOfCommand(stored, opts.commandId)
        if (found !== null) setOpenId(found.id)
      }
      await clientFor()
    })()
    // `opts.commandId` is a route param and changes only when the screen is re-opened by a push.
  }, [clientFor, opts.commandId])

  const thread = threads.find((th) => th.id === openId) ?? null

  // ---------------------------------------------------------------------------
  // Sending
  // ---------------------------------------------------------------------------

  /** Post one turn that is already in the list. Shared by a first send and by a retry. */
  const post = useCallback(
    async (threadId: string, turnId: string, text: string, turnLang: string) => {
      const client = await clientFor()
      if (client === null) return
      // `reply_to` is the last turn that ACTUALLY REACHED the desk — an unsent one has no row
      // there, and the desk validates that the id exists.
      const current = threadsRef.current.find((th) => th.id === threadId) ?? null
      const replyTo = current === null ? null : lastCommandId(current)
      try {
        const command = await client.postCommand({
          text,
          lang: turnLang,
          ...(replyTo === null ? {} : { replyTo }),
        })
        dispatch({ type: 'accepted', turnId, command })
      } catch (e) {
        dispatch({
          type: 'send_failed',
          turnId,
          error: fill(t.ask.sendFailed, { detail: humanDeskError(e) }),
        })
      }
    },
    [clientFor, dispatch, t],
  )

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim()
      if (trimmed === '' || trimmed.length > MAX_COMMAND_TEXT) return
      const now = Date.now()
      const turnId = newTurnId(now, seq.current++)
      // A new conversation takes the turn's own id — see `threads.ts`'s header on why the thread
      // id is not a command id.
      const threadId = openId ?? turnId
      dispatch({ type: 'typed', threadId, turnId, text: trimmed, lang, at: now })
      if (openId === null) setOpenId(threadId)
      await post(threadId, turnId, trimmed, lang)
    },
    [dispatch, lang, openId, post],
  )

  const retry = useCallback(
    async (turnId: string) => {
      const owner = threadsRef.current.find((th) => th.turns.some((x) => x.id === turnId))
      const turn = owner?.turns.find((x) => x.id === turnId)
      if (owner === undefined || turn === undefined) return
      dispatch({ type: 'retry', turnId, at: Date.now() })
      await post(owner.id, turnId, turn.text, turn.lang)
    },
    [dispatch, post],
  )

  // ---------------------------------------------------------------------------
  // Publishing a staged revision
  // ---------------------------------------------------------------------------

  const publish = useCallback(
    async (commandId: string) => {
      const client = await clientFor()
      if (client === null) return
      try {
        // `nothing_staged` is treated exactly as a publish, and that is not a shortcut: the desk
        // having nothing staged means the edition it staged already went out — by the owner's own
        // tooling, or by a second phone answering the same push. The paper changed either way,
        // and the refetch below is what confirms it.
        await client.publishNow()
        dispatch({ type: 'published', commandId })
        markEditionStale()
      } catch (e) {
        dispatch({
          type: 'publish_failed',
          commandId,
          error: fill(t.ask.publishFailed, { detail: humanDeskError(e) }),
        })
      }
    },
    [clientFor, dispatch, t],
  )

  // ---------------------------------------------------------------------------
  // Waiting
  // ---------------------------------------------------------------------------

  const poll = useCallback(async () => {
    const working = threadsRef.current
      .flatMap((th) => th.turns)
      .filter((x) => x.commandId !== null && isWorking(x) && x.status !== 'sending')
    if (working.length === 0) return
    const client = await clientFor()
    if (client === null) return
    for (const turn of working) {
      const cid = turn.commandId as string
      let row
      try {
        row = await client.command(cid)
      } catch {
        // A poll that failed says nothing about the command. The turn stays where it is and the
        // next tick asks again; raising an error card over a conversation that is simply still
        // out would be the app reporting its own network as the desk's answer.
        continue
      }
      if (row === null) {
        dispatch({ type: 'forgotten', commandId: cid, error: t.ask.forgotten })
        continue
      }
      dispatch({ type: 'polled', commandId: cid, status: row.status, result: row.result })
      if (row.status !== 'done' && row.status !== 'failed') continue

      if (row.hasNotes) {
        try {
          const notes = await client.commandNotes(cid)
          if (notes !== null && notes !== '') {
            dispatch({ type: 'answered', commandId: cid, answer: notes })
          }
        } catch {
          // The answer is on the desk and this turn is terminal, so the next open fetches it
          // again. Losing the text is recoverable; a failed fetch is not worth a sentence.
        }
      }

      const outcome = readResult(row.result)
      if (row.status === 'failed') {
        dispatch({
          type: 'error',
          commandId: cid,
          error: fill(t.ask.failed, { detail: row.result ?? '' }),
        })
        continue
      }
      if (outcome === null || outcome.kind === 'answered') continue
      if (outcome.kind === 'staged') {
        // The owner asked for the change, so the phone finishes the act rather than leaving a
        // button to press. `publish` marks the edition stale on its way through.
        await publish(cid)
        continue
      }
      if (outcome.kind === 'revised') markEditionStale()
    }
  }, [clientFor, dispatch, publish, t])

  const focused = useRef(false)
  useFocusEffect(
    useCallback(() => {
      focused.current = true
      void poll()
      const id = setInterval(() => {
        if (focused.current) void poll()
      }, ASK_POLL_MS)
      return () => {
        focused.current = false
        clearInterval(id)
      }
    }, [poll]),
  )

  return { ready, threads, thread, open: setOpenId, send, retry, publish }
}
