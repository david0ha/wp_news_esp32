// The conversation, as the phone keeps it.
//
// THE DESK IS THE SOURCE OF TRUTH FOR STATUS AND FOR THE ANSWER; this file is what makes a thread
// render on a train. Every fact here was either typed by the owner or read off a command row, and
// the reducer's job is to fold the second onto the first without losing the first.
//
// THERE IS NO SERVER-SIDE THREAD. `reply_to` is the thread: each turn names the previous one, and
// the desk keeps the rows. What the phone adds is the grouping and the order, which is exactly the
// part a queue has no opinion about.
//
// A TURN EXISTS BEFORE ITS COMMAND ID DOES, and that is the whole reason for the two statuses the
// desk does not have. A message is typed, appended, and only then posted; a post that fails must
// leave the text on screen with a retry beside it, because the alternative is asking somebody to
// type it again. So `commandId` is null until the POST answers, `sending` is the POST in flight and
// `unsent` is the POST that failed. The other six are the desk's own, spelled its way.
//
// THE THREAD ID IS THE FIRST TURN'S LOCAL ID and not a command id, which follows from the same
// fact: a thread whose first send never reached the desk still has to be a thread. `reply_to` is a
// separate lookup (`lastCommandId`) over the turns that did reach it.
//
// THE REDUCER IS PURE — no clock, no storage, no React. Every event carries its own timestamp and
// its own ids. That is `editionState.ts`'s rule and it exists for the same reason: this app has no
// component test runner, so anything decided inside a hook body is argued only in prose.

import AsyncStorage from '@react-native-async-storage/async-storage'

import { COMMAND_STATUSES, type Command, type CommandStatus } from '../desk'

/**
 * The desk's six, plus the two that belong to a message that has not reached it.
 *
 * `sending` and `unsent` are phone-only by construction: neither can arrive off a command row,
 * because a row the desk answered with already has an id.
 */
export type TurnStatus = CommandStatus | 'sending' | 'unsent'

export const TURN_STATUSES: readonly TurnStatus[] = [...COMMAND_STATUSES, 'sending', 'unsent']

export interface Turn {
  /** This phone's own id, assigned when the message was typed. Stable across a retry. */
  id: string
  /** The desk's command id. `null` until the POST answers — see the header. */
  commandId: string | null
  text: string
  /** The app's language when the message was typed. The desk falls back to it; see the spec. */
  lang: string
  /** When it was last sent, so a retry re-stamps rather than backdates. */
  sentAt: number
  status: TurnStatus
  /** The desk's `result`, verbatim. Only `readResult` parses it. */
  result: string | null
  /** The worker's `answer.md`, as markdown. */
  answer: string | null
  /** A sentence for the screen: a failed send, a refused publish, a failed command. */
  error: string | null
}

export interface Thread {
  /** The first turn's `id`. */
  id: string
  /** Oldest first: a conversation is read down. */
  turns: Turn[]
}

/**
 * How many conversations this phone keeps.
 *
 * A cap rather than a sweep by age, because the record is small and the question a reader asks of
 * it is "what did I ask recently" rather than "what did I ask in August". Twenty threads of a few
 * turns each is a few tens of kilobytes.
 */
export const MAX_THREADS = 20

export type ThreadEvent =
  /** The disk answered. Replaces everything — this is the only event that is not a fold. */
  | { type: 'loaded'; threads: Thread[] }
  | { type: 'typed'; threadId: string; turnId: string; text: string; lang: string; at: number }
  | { type: 'accepted'; turnId: string; command: Command }
  | { type: 'send_failed'; turnId: string; error: string }
  | { type: 'retry'; turnId: string; at: number }
  | { type: 'polled'; commandId: string; status: CommandStatus; result: string | null }
  | { type: 'answered'; commandId: string; answer: string }
  /** A sentence about a command that finished badly, or one the desk no longer has. */
  | { type: 'error'; commandId: string; error: string }
  | { type: 'forgotten'; commandId: string; error: string }
  | { type: 'published'; commandId: string }
  | { type: 'publish_failed'; commandId: string; error: string }

/** Rewrite the one turn a predicate picks, leaving every other thread and turn identical. */
function mapTurn(threads: Thread[], pick: (t: Turn) => boolean, fn: (t: Turn) => Turn): Thread[] {
  let touched = false
  const next = threads.map((th) => {
    if (!th.turns.some(pick)) return th
    touched = true
    return { ...th, turns: th.turns.map((t) => (pick(t) ? fn(t) : t)) }
  })
  // Identity back when nothing matched, so a poll about a command this phone has forgotten is a
  // no-op the screen does not re-render for.
  return touched ? next : threads
}

const byCommand = (commandId: string) => (t: Turn) => t.commandId === commandId
const byTurn = (turnId: string) => (t: Turn) => t.id === turnId

export function nextThreads(prev: Thread[], event: ThreadEvent): Thread[] {
  switch (event.type) {
    case 'loaded':
      return event.threads

    case 'typed': {
      const turn: Turn = {
        id: event.turnId,
        commandId: null,
        text: event.text,
        lang: event.lang,
        sentAt: event.at,
        status: 'sending',
        result: null,
        answer: null,
        error: null,
      }
      const existing = prev.find((th) => th.id === event.threadId)
      if (existing !== undefined) {
        // A follow-up does NOT move its thread to the front. The list is ordered by when a
        // conversation started, and re-sorting it under the reader's thumb while they are typing
        // in it is motion nobody asked for.
        return prev.map((th) =>
          th.id === event.threadId ? { ...th, turns: [...th.turns, turn] } : th,
        )
      }
      return [{ id: event.threadId, turns: [turn] }, ...prev].slice(0, MAX_THREADS)
    }

    case 'accepted':
      return mapTurn(prev, byTurn(event.turnId), (t) => ({
        ...t,
        commandId: event.command.id,
        // The desk's own status, not an assumed `pending`: a desk that claimed it before
        // answering is telling the truth about a row this phone would otherwise mislabel.
        status: event.command.status,
        result: event.command.result,
        error: null,
      }))

    case 'send_failed':
      return mapTurn(prev, byTurn(event.turnId), (t) => ({
        ...t,
        status: 'unsent',
        error: event.error,
      }))

    case 'retry':
      return mapTurn(prev, byTurn(event.turnId), (t) => ({
        ...t,
        status: 'sending',
        sentAt: event.at,
        error: null,
      }))

    case 'polled':
      return mapTurn(prev, byCommand(event.commandId), (t) => ({
        ...t,
        status: event.status,
        result: event.result,
      }))

    case 'answered':
      return mapTurn(prev, byCommand(event.commandId), (t) => ({ ...t, answer: event.answer }))

    case 'error':
      return mapTurn(prev, byCommand(event.commandId), (t) => ({ ...t, error: event.error }))

    case 'forgotten':
      // FAILED AND NOT LEFT ALONE. `command()` answering `null` means the desk has no record of
      // this id — its data was replaced, or the phone is pointed at a different desk — not that a
      // row was deleted out from under a turn that was accepted. Without this case that turn would
      // sit `pending` forever, with a spinner beside it and a poll asking about an id that will
      // never answer, every five seconds for the life of the install.
      return mapTurn(prev, byCommand(event.commandId), (t) => ({
        ...t,
        status: 'failed',
        error: event.error,
      }))

    case 'published':
      // The result is rewritten because it is no longer true. `staged <eid>` described the world
      // for as long as the edition sat there; it is out now, and every screen that branches on
      // the first word must see the same fact the Today tab is about to.
      return mapTurn(prev, byCommand(event.commandId), (t) => ({
        ...t,
        result: t.result === null ? t.result : t.result.replace(/^staged\b/, 'revised'),
        error: null,
      }))

    case 'publish_failed':
      return mapTurn(prev, byCommand(event.commandId), (t) => ({ ...t, error: event.error }))
  }
}

// ---------------------------------------------------------------------------
// Reading a turn
// ---------------------------------------------------------------------------

/**
 * What the desk's `result` says happened. THE FIRST WORD, AND NOTHING ELSE PARSED.
 *
 * The vocabulary is the worker's and the desk does not police it, so this is a reader and not a
 * validator: anything outside the three words is kept whole as `other` and drawn as the desk's own
 * sentence. That is what makes a worker one release ahead a sentence on screen rather than a
 * crash.
 */
export type Outcome =
  | { kind: 'answered' }
  | { kind: 'revised'; editionId: string }
  | { kind: 'staged'; editionId: string }
  | { kind: 'other'; text: string }

export function readResult(result: string | null): Outcome | null {
  if (result === null || result === '') return null
  const [word, ...rest] = result.split(/\s+/)
  const editionId = rest.join(' ')
  if (word === 'answered') return { kind: 'answered' }
  if (word === 'revised') return { kind: 'revised', editionId }
  if (word === 'staged') return { kind: 'staged', editionId }
  return { kind: 'other', text: result }
}

/** Whether the poll has any reason to keep asking about this turn. */
export function isWorking(turn: Turn): boolean {
  return turn.status === 'sending' || turn.status === 'pending' || turn.status === 'claimed'
}

export function threadIsWorking(thread: Thread): boolean {
  return thread.turns.some(isWorking)
}

/** Which conversation a push's `command_id` belongs to. `null` for one this phone never sent. */
export function threadOfCommand(threads: Thread[], commandId: string): Thread | null {
  return threads.find((th) => th.turns.some((t) => t.commandId === commandId)) ?? null
}

/**
 * The `reply_to` for the next turn: the last turn that actually reached the desk.
 *
 * An unsent turn is not a previous turn — the desk has no row for it, and `reply_to` is validated
 * against one that exists — so this walks backwards past them rather than taking the last turn.
 */
export function lastCommandId(thread: Thread): string | null {
  for (let i = thread.turns.length - 1; i >= 0; i--) {
    const id = thread.turns[i].commandId
    if (id !== null) return id
  }
  return null
}

/**
 * A local id for a turn. Time plus a counter, because two messages can be typed inside one
 * millisecond and an id that collided would make a retry rewrite somebody else's turn.
 */
export function newTurnId(now: number, seq: number): string {
  return `t${now.toString(36)}-${seq.toString(36)}`
}

// ---------------------------------------------------------------------------
// On disk
// ---------------------------------------------------------------------------
//
// One AsyncStorage key holding the list. No schema version and no migration: the read sanitizes,
// so a record written by a newer build degrades to the turns this build can read rather than
// crashing a launch. That is `edition/store.ts`'s argument, and it holds here for a smaller record.
//
// NOTHING IN A THREAD IS A CREDENTIAL. The token is in the keychain and reaches one header; a
// thread holds the owner's own words, the desk's answer and six identifiers. AsyncStorage is a
// plain file in the app's container, which is the right place for exactly that and no more.

/** Namespaced like every other key this app owns. The literal is load-bearing — see `store.ts`. */
export const THREADS_KEY = 'claudepost.threads'

function isTurnStatus(v: unknown): v is TurnStatus {
  return typeof v === 'string' && (TURN_STATUSES as readonly string[]).includes(v)
}

function sanitizeTurn(raw: unknown): Turn | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  if (typeof o.id !== 'string' || o.id === '') return null
  if (typeof o.text !== 'string') return null
  if (!isTurnStatus(o.status)) return null
  return {
    id: o.id,
    commandId: typeof o.commandId === 'string' ? o.commandId : null,
    text: o.text,
    lang: typeof o.lang === 'string' ? o.lang : '',
    sentAt: typeof o.sentAt === 'number' && Number.isFinite(o.sentAt) ? o.sentAt : 0,
    // A RESTORED `sending` IS A LIE, AND IT IS THE ONE STATUS THIS FUNCTION REWRITES. `sending`
    // means a POST is in flight, and a POST cannot outlive the process that issued it: a turn read
    // back off disk in that state belongs to a process that was killed mid-request, and nothing
    // will ever answer for it. Left as it was, it is unrecoverable by construction — the poll's
    // working set excludes `sending`, so nothing asks about it, and `TurnRow` draws the retry
    // button on `unsent` alone, so there is nothing to press. `unsent` is the truth about it and
    // is also the state that offers the way out.
    status: o.status === 'sending' ? 'unsent' : o.status,
    result: typeof o.result === 'string' ? o.result : null,
    answer: typeof o.answer === 'string' ? o.answer : null,
    error: typeof o.error === 'string' ? o.error : null,
  }
}

/**
 * Every conversation worth returning, and the granularity is the point.
 *
 * A bad TURN loses a turn; a bad THREAD loses a thread; neither loses the file. This is the
 * owner's own history, and refusing all of it over one unreadable entry is the failure mode a
 * whole-document check has — `pushOf` drops a device it cannot type for the same reason.
 */
export function sanitizeThreads(raw: unknown): Thread[] {
  if (!Array.isArray(raw)) return []
  const out: Thread[] = []
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
    const o = entry as Record<string, unknown>
    if (typeof o.id !== 'string' || o.id === '') continue
    if (!Array.isArray(o.turns)) continue
    const turns = o.turns.map(sanitizeTurn).filter((t): t is Turn => t !== null)
    // A thread with nothing left in it is not a thread. Keeping it would draw an empty row that
    // opens an empty screen.
    if (turns.length === 0) continue
    out.push({ id: o.id, turns })
  }
  return out.slice(0, MAX_THREADS)
}

export async function readThreads(): Promise<Thread[]> {
  let raw: string | null
  try {
    raw = await AsyncStorage.getItem(THREADS_KEY)
  } catch {
    // A read that threw is not an answer, and nothing is cached from it: the next call asks the
    // disk again rather than inheriting a wrong "no conversations" for the session.
    return []
  }
  if (raw === null || raw === undefined) return []
  try {
    return sanitizeThreads(JSON.parse(raw))
  } catch {
    return []
  }
}

export async function writeThreads(threads: Thread[]): Promise<void> {
  try {
    await AsyncStorage.setItem(THREADS_KEY, JSON.stringify(threads.slice(0, MAX_THREADS)))
  } catch {
    // Best-effort: what this costs is one conversation not surviving a relaunch. Throwing would
    // cost the screen that was drawing it.
  }
}
