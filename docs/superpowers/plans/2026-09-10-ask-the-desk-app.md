# Ask the Desk — App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The owner types a message on the phone, the desk answers it, and when the answer says the paper changed, Today shows the new edition.

**Architecture:** Four layers, each one testable without a screen. `desk.ts` gains four methods over the desk's existing command queue. `lib/ask/threads.ts` is a pure reducer over a list of threads, persisted to AsyncStorage — the desk is the source of truth for status and the answer, the phone stores them so a thread renders offline. `lib/ask/useAskThread.ts` wraps that reducer in React state, a focus-gated 5 s poll and the desk calls. `app/ask.tsx` draws it. There is no component test runner in this app, so every decision worth arguing about lives in a pure function beside its test, and the `.tsx` is layout only — the idiom `editionState.ts`, `notify.ts` and `newsurlsync.ts` already hold.

**Tech Stack:** TypeScript, React Native 0.85 / Expo SDK 56, expo-router, expo-notifications, AsyncStorage, Jest (`jest-expo` preset).

**Spec:** [docs/superpowers/specs/2026-09-10-ask-the-desk-design.md](../specs/2026-09-10-ask-the-desk-design.md) — this plan owns **section 4 (App)** and the App rows of section 5. Sections 1–3 (the container wall, the desk and the worker) are separate plans.

## Global Constraints

These are the spec's project-wide requirements. Every task's requirements implicitly include this section.

- **The wire is fixed and this plan does not change it.** `POST /api/commands` body `{kind:"ask", text, reply_to?, lang, source:"app"}` → `{ok, command:{id, kind, text, status, result, reply_to, lang, source, created_at, ...}}`. `GET /api/commands/<id>` → `{ok, command:{...row, has_notes}}`, 404 for an unknown id. `GET /api/commands/<id>/notes.md` → `text/markdown`. `POST /api/publish` → `{ok, ...}` or 404 `nothing is staged`.
- **Statuses are exactly** `pending | claimed | done | failed | expired | cancelled`.
- **`result`'s first word is** `answered`, `revised <eid>` or `staged <eid>`. The phone branches on the first word; nothing else parses it.
- **Push data is** `{command_id, result}`, and `result` there is the first word alone.
- **Auth is the existing bearer operator token** — `deskToken.ts`'s keychain entry, the one the phone already holds. Every route above is reached through `createDeskClient`, which puts it in exactly one header.
- **`MAX_COMMAND_TEXT` is 2000.** The composer refuses more than 2000 characters rather than letting the desk refuse it.
- **The token never reaches a message, a log or AsyncStorage.** `desk.ts`'s existing rule, and `desk.test.ts` pins it. Nothing in this plan may put it in a thread record.
- **Every user-visible string goes through i18n**, in both `en.ts` and `ko.ts`, with named placeholders (`{detail}`), never string concatenation. `i18n/index.test.ts` fails on a key present in Korean and still carrying the English sentence, and on a dropped placeholder.
- **`entryRouteFor` must be unaffected.** Nothing in this plan touches `src/onboarding/flow.ts`, `src/app/index.tsx`, or the three storage keys that decide the entry route.
- **Two ordering dependencies on the other plans, and one of them can break a shipped phone:**
  1. `GET /api/commands/<cid>` does not exist today (`http.py`'s `_ROUTES` has only `DELETE` on that path). Tasks 1–11 are all testable against fakes without it; only Task 12 needs the desk plan landed.
  2. **`push.KINDS` must gain `answer` on the desk BEFORE Task 10 ships.** `deviceBody` sends a `prefs`/`lead` entry for every kind in `PUSH_KINDS`, and the desk refuses an unknown key with `bad_push` **over the whole document** — so an app that knows `answer` against a desk that does not turns every notification registration into a 400.

---

## File Structure

**Created:**
- `app/src/lib/ask/threads.ts` — the thread record: types, the pure reducer, `readResult`, and the AsyncStorage read/write under `claudepost.threads`. One file because the sanitizer and the reducer share the types and change together.
- `app/src/lib/ask/threads.test.ts`
- `app/src/lib/ask/markdown.ts` — a small markdown block parser. Pure, no dependency.
- `app/src/lib/ask/markdown.test.ts`
- `app/src/lib/ask/useAskThread.ts` — React state, the focus-gated poll, the desk calls. Dull by construction; every decision it makes is in `threads.ts`.
- `app/src/lib/edition/invalidate.ts` — the one-bit flag that makes Today refetch.
- `app/src/lib/edition/invalidate.test.ts`
- `app/src/components/ask/Answer.tsx` — renders `markdown.ts`'s blocks with the app's own type ramp.
- `app/src/components/ask/TurnRow.tsx` — one turn: the question, the answer, the chip, the error and the retry.
- `app/src/app/ask.tsx` — the screen.

**Modified:**
- `app/src/lib/desk.ts` — `Command`, `CommandStatus`, `postCommand`, `command`, `commandNotes`, `publishNow`.
- `app/src/lib/desk.test.ts`
- `app/src/lib/edition/useEdition.ts` — read the invalidation flag in `load()`.
- `app/src/lib/notify.ts` — `PUSH_KINDS` gains `answer`; `LEAD_KINDS` splits off; `askRouteForPush` and `addResponseListener`.
- `app/src/lib/notify.test.ts`
- `app/src/app/_layout.tsx` — register `ask`, mount the response listener.
- `app/src/app/(tabs)/settings.tsx` — draw the `answer` switch without a lead row.
- `app/src/components/edition/Masthead.tsx` and `app/src/app/(tabs)/edition.tsx` — the Ask button.
- `app/src/i18n/en.ts`, `app/src/i18n/ko.ts`
- `docs/app-control.md`

---

### Task 1: The desk client learns the queue

**Files:**
- Modify: `app/src/lib/desk.ts`
- Test: `app/src/lib/desk.test.ts`

**Interfaces:**
- Consumes: `createDeskClient`, `DeskClient`, `DeskError`, the private `send` / `refusal` helpers already in the file.
- Produces:
  - `export type CommandStatus = 'pending' | 'claimed' | 'done' | 'failed' | 'expired' | 'cancelled'`
  - `export const COMMAND_STATUSES: readonly CommandStatus[]`
  - `export const MAX_COMMAND_TEXT = 2000`
  - `export interface Command { id: string; kind: string; text: string; status: CommandStatus; result: string | null; replyTo: string | null; lang: string | null; source: string; createdAt: string; hasNotes: boolean }`
  - `export interface AskBody { text: string; replyTo?: string; lang: string }`
  - `export type PublishOutcome = 'published' | 'nothing_staged'`
  - On `DeskClient`: `postCommand(body: AskBody): Promise<Command>`, `command(id: string): Promise<Command | null>`, `commandNotes(id: string): Promise<string | null>`, `publishNow(): Promise<PublishOutcome>`

**Two decisions worth naming, because later tasks depend on them:**

`command()` answers `null` for a 404 rather than throwing. A command the desk has forgotten is a **state** the thread renders — "there is no answer to fetch" — not a network failure a retry fixes, and `forgetPushDevice` already takes a 404 as an answer for the same reason. `commandNotes()` does the same: a `done` command with no notes uploaded is a real outcome.

An **unrecognised status is `bad_json`**. The phone's whole loop is "poll until this leaves pending/claimed", so a status it cannot classify is one it cannot stop on — and a poll that never stops is worse than a refusal that says so. This is the opposite call from `PushDevice`, which drops an entry it cannot type, and the difference is that a foreign push entry belongs to another phone while this row is the one being waited on.

- [ ] **Step 1: Write the failing tests**

Append to `app/src/lib/desk.test.ts`:

```ts
const commandRow = (over: Record<string, unknown> = {}) => ({
  id: 'c0ffee00',
  kind: 'ask',
  text: 'why did it move?',
  status: 'pending',
  result: null,
  reply_to: null,
  lang: 'ko',
  source: 'app',
  created_at: '2026-09-10T01:02:03Z',
  has_notes: false,
  ...over,
})

const commandBody = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ ok: true, command: commandRow(over) })

describe('deskClient.postCommand', () => {
  it('POSTs exactly the four fields the desk takes, and reads the row back', async () => {
    const { client: c, calls } = client([{ text: commandBody() }])
    const row = await c.postCommand({ text: 'why did it move?', lang: 'ko' })
    expect(calls[0].url).toBe('https://desk.example.dev/api/commands')
    expect(calls[0].init?.method).toBe('POST')
    expect(header(calls[0].init, 'Authorization')).toBe(`Bearer ${TOKEN}`)
    // As bytes, like every other body in this file: the desk refuses an unknown key whole, and
    // `reply_to` is ABSENT rather than null on a first turn — a null reply_to is a claim about a
    // previous command, and there is not one.
    expect(calls[0].init?.body).toBe(
      '{"kind":"ask","text":"why did it move?","lang":"ko","source":"app"}',
    )
    expect(row).toEqual({
      id: 'c0ffee00',
      kind: 'ask',
      text: 'why did it move?',
      status: 'pending',
      result: null,
      replyTo: null,
      lang: 'ko',
      source: 'app',
      createdAt: '2026-09-10T01:02:03Z',
      hasNotes: false,
    })
  })

  it('carries reply_to when this is a follow-up', async () => {
    const { client: c, calls } = client([{ text: commandBody({ reply_to: 'deadbeef' }) }])
    await c.postCommand({ text: 'and the CFO?', lang: 'en', replyTo: 'deadbeef' })
    expect(calls[0].init?.body).toBe(
      '{"kind":"ask","text":"and the CFO?","lang":"en","reply_to":"deadbeef","source":"app"}',
    )
  })

  it('surfaces the desk’s own reason for refusing a message', async () => {
    const { client: c } = client([
      { status: 400, text: '{"ok":false,"error":"bad_command","detail":"text: too long"}' },
    ])
    await expect(c.postCommand({ text: 'x'.repeat(3000), lang: 'en' })).rejects.toMatchObject({
      code: 'http',
      error: 'bad_command',
      detail: 'text: too long',
    })
  })
})

describe('deskClient.command', () => {
  it('GETs one command and maps the wire names to the app’s', async () => {
    const { client: c, calls } = client([
      { text: commandBody({ status: 'done', result: 'revised abc123', has_notes: true }) },
    ])
    const row = await c.command('c0ffee00')
    expect(calls[0].url).toBe('https://desk.example.dev/api/commands/c0ffee00')
    expect(calls[0].init?.method).toBe('GET')
    expect(row).toMatchObject({ status: 'done', result: 'revised abc123', hasNotes: true })
  })

  it('reads a 404 as “the desk no longer has this”, not as a failure', async () => {
    // A command the desk has forgotten is a state the thread renders. Throwing would put a
    // network error card over a turn whose only real problem is that it is gone.
    const { client: c } = client([{ status: 404, text: '{"ok":false,"error":"not_found"}' }])
    expect(await c.command('c0ffee00')).toBeNull()
  })

  it('refuses a status this app cannot classify', async () => {
    // The poll stops on `done` or `failed` and on nothing else, so a status it does not know is
    // one it would wait on forever.
    const { client: c } = client([{ text: commandBody({ status: 'reticulating' }) }])
    await expect(c.command('c0ffee00')).rejects.toMatchObject({ code: 'bad_json' })
  })

  it('percent-encodes the id into the path', async () => {
    const { client: c, calls } = client([{ text: commandBody() }])
    await c.command('a/b')
    expect(calls[0].url).toBe('https://desk.example.dev/api/commands/a%2Fb')
  })
})

describe('deskClient.commandNotes', () => {
  it('GETs the markdown as text, not as JSON', async () => {
    const { client: c, calls } = client([{ text: '# Why it moved\n\nThe guide.\n' }])
    expect(await c.commandNotes('c0ffee00')).toBe('# Why it moved\n\nThe guide.\n')
    expect(calls[0].url).toBe('https://desk.example.dev/api/commands/c0ffee00/notes.md')
  })

  it('reads a 404 as “no answer was written”', async () => {
    const { client: c } = client([{ status: 404, text: '{"ok":false,"error":"not_found"}' }])
    expect(await c.commandNotes('c0ffee00')).toBeNull()
  })

  it('does not swallow a refusal that is not a 404', async () => {
    const { client: c } = client([{ status: 403, text: '{"ok":false,"error":"forbidden"}' }])
    await expect(c.commandNotes('c0ffee00')).rejects.toMatchObject({ code: 'unauthorized' })
  })
})

describe('deskClient.publishNow', () => {
  it('POSTs /api/publish with no body at all', async () => {
    const { client: c, calls } = client([{ text: '{"ok":true,"edition":"abc123"}' }])
    expect(await c.publishNow()).toBe('published')
    expect(calls[0].url).toBe('https://desk.example.dev/api/publish')
    expect(calls[0].init?.method).toBe('POST')
    expect(calls[0].init?.body).toBeUndefined()
  })

  it('reads “nothing is staged” as an outcome rather than an error', async () => {
    // The staged edition went out some other way — the owner's own tooling, or a second phone.
    // The paper still changed, which is the fact the screen is about to act on.
    const { client: c } = client([{ status: 404, text: '{"ok":false,"error":"nothing is staged"}' }])
    expect(await c.publishNow()).toBe('nothing_staged')
  })

  it('turns a 403 into unauthorized, like every other route', async () => {
    const { client: c } = client([{ status: 403, text: '{"ok":false,"error":"forbidden"}' }])
    await expect(c.publishNow()).rejects.toMatchObject({ code: 'unauthorized', status: 403 })
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd app && npm test -- src/lib/desk.test.ts`
Expected: FAIL — `c.postCommand is not a function`.

- [ ] **Step 3: Add the types and the parser to `desk.ts`**

Above `export interface DeskClientOptions`:

```ts
/**
 * The queue's six statuses, exactly as `store.py` spells them.
 *
 * A closed union and not a string, unlike `PushDevice`'s `prefs`, and the asymmetry is
 * deliberate. A foreign push preference belongs to another phone and can be left alone; this row
 * is the one being waited on, and the poll stops on `done` or `failed` and on nothing else — so a
 * status this app cannot classify is one it would sit on forever, with a spinner and no reason.
 */
export const COMMAND_STATUSES = [
  'pending',
  'claimed',
  'done',
  'failed',
  'expired',
  'cancelled',
] as const
export type CommandStatus = (typeof COMMAND_STATUSES)[number]

/** `MAX_COMMAND_TEXT` on the desk. The composer refuses at this length rather than posting a 400. */
export const MAX_COMMAND_TEXT = 2000

/**
 * One row of the desk's command queue, in the app's own spelling.
 *
 * The wire is snake_case and the model is camelCase, which is `edition/parse.ts`'s rule and is
 * worth keeping for the reason that file's header gives: a record stored under wire names and read
 * back through a camelCase reader loses every field whose two spellings differ, silently.
 */
export interface Command {
  id: string
  kind: string
  text: string
  status: CommandStatus
  /** `answered`, `revised <eid>`, `staged <eid>`, or the worker's message on a failure. */
  result: string | null
  /** The previous turn of the same thread, or `null` for the first. */
  replyTo: string | null
  lang: string | null
  source: string
  createdAt: string
  /** Whether `notes.md` is there to be fetched. */
  hasNotes: boolean
}

/** A message from the phone. `kind` and `source` are this client's, not the caller's. */
export interface AskBody {
  text: string
  /** Absent, never null: a null `reply_to` is a claim about a previous command that is not there. */
  replyTo?: string
  lang: string
}

/** What `POST /api/publish` did. A 404 is a state, not a failure — see `publishNow`. */
export type PublishOutcome = 'published' | 'nothing_staged'

function isCommandStatus(v: unknown): v is CommandStatus {
  return typeof v === 'string' && (COMMAND_STATUSES as readonly string[]).includes(v)
}

/**
 * One row, or `null` for a body this client cannot read.
 *
 * The id and the status are required because everything downstream is keyed on one and branches
 * on the other; the rest defaults, because a row missing its `created_at` is still a row worth
 * showing the answer of.
 */
function parseCommand(raw: unknown): Command | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  if (typeof o.id !== 'string' || o.id === '') return null
  if (!isCommandStatus(o.status)) return null
  return {
    id: o.id,
    kind: typeof o.kind === 'string' ? o.kind : '',
    text: typeof o.text === 'string' ? o.text : '',
    status: o.status,
    result: typeof o.result === 'string' ? o.result : null,
    replyTo: typeof o.reply_to === 'string' ? o.reply_to : null,
    lang: typeof o.lang === 'string' ? o.lang : null,
    source: typeof o.source === 'string' ? o.source : '',
    createdAt: typeof o.created_at === 'string' ? o.created_at : '',
    hasNotes: o.has_notes === true,
  }
}
```

Add to the `DeskClient` interface:

```ts
  /** Put a message on the desk's queue. Answers the row the desk created. */
  postCommand(body: AskBody): Promise<Command>
  /** One row, or `null` for an id the desk no longer has. */
  command(id: string): Promise<Command | null>
  /** The worker's answer, as markdown — or `null` for a command that finished without writing one. */
  commandNotes(id: string): Promise<string | null>
  /** Force the staged edition out. `nothing_staged` is an outcome; see the implementation. */
  publishNow(): Promise<PublishOutcome>
```

- [ ] **Step 4: Implement the four methods**

Inside `createDeskClient`'s returned object, after `forgetPushDevice`:

```ts
    async postCommand(body: AskBody): Promise<Command> {
      // Field by field, in the order the desk's own document lists them, for the reason every
      // other body in this file is built by hand: an unknown key is refused whole. `reply_to` is
      // spread in only when there is one — see `AskBody`.
      const wire = {
        kind: 'ask',
        text: body.text,
        lang: body.lang,
        ...(body.replyTo === undefined ? {} : { reply_to: body.replyTo }),
        source: 'app',
      }
      const res = await send('/api/commands', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(wire),
      })
      return commandOf(res, 'commands')
    },

    async command(id: string): Promise<Command | null> {
      const res = await send(`/api/commands/${encodeURIComponent(id)}`, { method: 'GET' })
      // A 404 IS AN ANSWER. The desk reaps its queue, so a thread left open for long enough asks
      // about an id that is genuinely gone — a state the turn renders, not a transport failure
      // that a retry would fix. `forgetPushDevice` takes a 404 the same way and for the same
      // reason: the status describes the world, not the request.
      if (res.status === 404) return null
      return commandOf(res, 'commands')
    },

    async commandNotes(id: string): Promise<string | null> {
      const res = await send(`/api/commands/${encodeURIComponent(id)}/notes.md`, { method: 'GET' })
      // The same 404 rule, over a narrower fact: a command that finished and wrote no answer.
      // The worker treats that as a failure on its own side; the phone still has to draw the turn.
      if (res.status === 404) return null
      if (!res.ok) throw await refusal(res, 'notes')
      // `text/markdown`, not JSON — the only route in this client that is not an envelope.
      return res.text()
    },

    async publishNow(): Promise<PublishOutcome> {
      const res = await send('/api/publish', { method: 'POST' })
      // "Nothing is staged" is not this phone failing to publish; it is the staged edition
      // already being out — published by the owner's own tooling, or by a second phone answering
      // the same push. The caller's next act is identical either way: go and refetch the paper.
      if (res.status === 404) return 'nothing_staged'
      if (!res.ok) throw await refusal(res, 'publish')
      return 'published'
    },
```

And beside `pushOf`, the reader they share:

```ts
  // The command envelope, read once for both routes that answer one — the same reason `settingsOf`
  // serves a GET and a PUT: two readers are two chances to disagree about what the desk said.
  async function commandOf(res: Response, route: string): Promise<Command> {
    if (!res.ok) throw await refusal(res, route)
    let payload: unknown
    try {
      payload = JSON.parse(await res.text())
    } catch {
      throw new DeskError('bad_json', `${route} did not answer JSON`, res.status)
    }
    const row = parseCommand((payload as { command?: unknown } | null)?.command)
    if (row === null) {
      throw new DeskError('bad_json', `${route} answered a row this app cannot read`, res.status)
    }
    return row
  }
```

- [ ] **Step 5: Run the tests and the typechecker**

Run: `cd app && npm test -- src/lib/desk.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add app/src/lib/desk.ts app/src/lib/desk.test.ts
git commit -m "feat(app): the phone can put a message on the desk's queue"
```

---

### Task 2: The thread record, and the reducer over it

**Files:**
- Create: `app/src/lib/ask/threads.ts`
- Test: `app/src/lib/ask/threads.test.ts`

**Interfaces:**
- Consumes: `Command`, `CommandStatus` from Task 1.
- Produces:
  - `export type TurnStatus = CommandStatus | 'sending' | 'unsent'`
  - `export interface Turn { id: string; commandId: string | null; text: string; lang: string; sentAt: number; status: TurnStatus; result: string | null; answer: string | null; error: string | null }`
  - `export interface Thread { id: string; turns: Turn[] }`
  - `export type ThreadEvent` (nine arms, below)
  - `export function nextThreads(prev: Thread[], event: ThreadEvent): Thread[]`
  - `export type Outcome` and `export function readResult(result: string | null): Outcome | null`
  - `export function isWorking(turn: Turn): boolean`, `export function threadIsWorking(thread: Thread): boolean`
  - `export function threadOfCommand(threads: Thread[], commandId: string): Thread | null`
  - `export function lastCommandId(thread: Thread): string | null`
  - `export function newTurnId(now: number, seq: number): string`

**Shape decisions:**

**A turn exists before its command id does.** The spec says a send appends a turn with status `pending` and posts; a failed post keeps the turn with an error and a retry. So the phone needs its own id for a turn — assigned when it is typed, stable across a retry — and `commandId` is `null` until the POST answers. That adds two phone-only statuses beside the desk's six: `sending` while the POST is in flight, `unsent` when it failed.

**The thread id is the first turn's local id**, not a command id. Thread identity then survives a first send that never reached the desk, and `reply_to` — which is the previous turn's *command* id — stays a separate fact. This is what the spec means by "no server-side thread object: `reply_to` is the thread".

**Threads are newest-first; turns within a thread are oldest-first.** A list is read from the top; a conversation is read down.

- [ ] **Step 1: Write the failing tests**

Create `app/src/lib/ask/threads.test.ts`:

```ts
import { describe, it, expect } from '@jest/globals'
import {
  isWorking,
  lastCommandId,
  MAX_THREADS,
  newTurnId,
  nextThreads,
  readResult,
  sanitizeThreads,
  threadIsWorking,
  threadOfCommand,
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

  it('drops a thread left with no turns at all', () => {
    expect(sanitizeThreads([{ id: 'th1', turns: [] }])).toEqual([])
  })

  it('reads anything that is not a list as no threads', () => {
    expect(sanitizeThreads(null)).toEqual([])
    expect(sanitizeThreads({ threads: [] })).toEqual([])
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd app && npm test -- src/lib/ask/threads.test.ts`
Expected: FAIL — `Cannot find module './threads'`.

- [ ] **Step 3: Write `threads.ts`, everything but the disk**

Create `app/src/lib/ask/threads.ts`:

```ts
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

const TURN_STATUSES: readonly TurnStatus[] = [...COMMAND_STATUSES, 'sending', 'unsent']

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
      // FAILED AND NOT LEFT ALONE. A turn the desk has reaped would otherwise stay `pending`
      // forever, with a spinner beside it and a poll asking about it every five seconds for the
      // life of the install.
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
```

- [ ] **Step 4: Run the tests — the disk arms will still fail**

Run: `cd app && npm test -- src/lib/ask/threads.test.ts`
Expected: the reducer and reader describes PASS; the `sanitizeThreads` describe FAILs with `sanitizeThreads is not a function`. That is Task 3.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/ask/threads.ts app/src/lib/ask/threads.test.ts
git commit -m "feat(app): a thread is what the phone adds to a queue"
```

---

### Task 3: Threads on disk

**Files:**
- Modify: `app/src/lib/ask/threads.ts`
- Test: `app/src/lib/ask/threads.test.ts` (the `sanitizeThreads` describe from Task 2, plus the round-trip below)

**Interfaces:**
- Consumes: `Thread`, `Turn`, `TURN_STATUSES`, `MAX_THREADS` from Task 2.
- Produces: `export const THREADS_KEY = 'claudepost.threads'`, `export function sanitizeThreads(raw: unknown): Thread[]`, `export async function readThreads(): Promise<Thread[]>`, `export async function writeThreads(threads: Thread[]): Promise<void>`

**The key literal is load-bearing** in the sense `store.ts`'s header gives: renaming it silently forgets every conversation on a shipped phone.

- [ ] **Step 1: Write the failing round-trip test**

Append to `app/src/lib/ask/threads.test.ts`:

```ts
import AsyncStorage from '@react-native-async-storage/async-storage'
import { beforeEach, jest, afterEach } from '@jest/globals'
import { readThreads, THREADS_KEY, writeThreads } from './threads'

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
    jest.spyOn(AsyncStorage, 'getItem').mockRejectedValue(new Error('disk'))
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
    jest.spyOn(AsyncStorage, 'setItem').mockRejectedValue(new Error('disk full'))
    await expect(writeThreads(pending())).resolves.toBeUndefined()
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd app && npm test -- src/lib/ask/threads.test.ts`
Expected: FAIL — `readThreads is not a function`.

- [ ] **Step 3: Implement the disk half**

Append to `app/src/lib/ask/threads.ts`:

```ts
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
    status: o.status,
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
```

- [ ] **Step 4: Run the tests and the typechecker**

Run: `cd app && npm test -- src/lib/ask/threads.test.ts && npm run typecheck`
Expected: PASS, all describes.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/ask/threads.ts app/src/lib/ask/threads.test.ts
git commit -m "feat(app): a thread renders on a train"
```

---

### Task 4: The answer, as markdown

**Files:**
- Create: `app/src/lib/ask/markdown.ts`, `app/src/lib/ask/markdown.test.ts`, `app/src/components/ask/Answer.tsx`

**Interfaces:**
- Produces:
  - `export interface Span { text: string; bold: boolean; italic: boolean; code: boolean }`
  - `export type Block = { kind: 'para'; spans: Span[] } | { kind: 'bullet'; items: Span[][] } | { kind: 'heading'; level: 1 | 2 | 3; spans: Span[] } | { kind: 'code'; text: string }`
  - `export function parseMarkdown(src: string): Block[]`
  - `export function Answer({ markdown }: { markdown: string })` from `components/ask/Answer.tsx`

**The rendering choice, and why it is not a library.** The spec says to render the answer with the same component the schedule uses for `reason`, or a small renderer if there is none. There is none: `ScheduleRow` draws `affect.reason` as a plain `<Text>`, and `package.json` carries no markdown package. Adding one means an unvetted native-adjacent dependency in an Expo 56 / RN 0.85 app whose release lane is already fragile, to render two or three paragraphs. A parser here is ~70 lines, pure, has a test, and covers what an `answer.md` written to the spec's "keep it to what was asked" actually contains: paragraphs, a bullet list, the odd bold run and a heading. Anything it does not know — a table, an image, a link — falls through as its own literal text, which is legible rather than wrong.

- [ ] **Step 1: Write the failing tests**

Create `app/src/lib/ask/markdown.test.ts`:

```ts
import { describe, it, expect } from '@jest/globals'
import { parseMarkdown } from './markdown'

const plain = (text: string) => ({ text, bold: false, italic: false, code: false })

describe('parseMarkdown', () => {
  it('reads a paragraph as one block of one plain span', () => {
    expect(parseMarkdown('The guide was the story.')).toEqual([
      { kind: 'para', spans: [plain('The guide was the story.')] },
    ])
  })

  it('joins the lines of one paragraph and splits on a blank line', () => {
    // A model writes wrapped prose. Rendering each line as its own paragraph would double every
    // gap on screen and break sentences across them.
    expect(parseMarkdown('one\ntwo\n\nthree')).toEqual([
      { kind: 'para', spans: [plain('one two')] },
      { kind: 'para', spans: [plain('three')] },
    ])
  })

  it('reads the three heading levels and nothing deeper', () => {
    expect(parseMarkdown('# A\n\n## B\n\n### C')).toEqual([
      { kind: 'heading', level: 1, spans: [plain('A')] },
      { kind: 'heading', level: 2, spans: [plain('B')] },
      { kind: 'heading', level: 3, spans: [plain('C')] },
    ])
    // Four hashes is not a heading this renderer has a size for, so it is prose.
    expect(parseMarkdown('#### D')).toEqual([{ kind: 'para', spans: [plain('#### D')] }])
  })

  it('gathers consecutive bullets into one list, either marker', () => {
    expect(parseMarkdown('- one\n* two')).toEqual([
      { kind: 'bullet', items: [[plain('one')], [plain('two')]] },
    ])
  })

  it('reads a fenced block verbatim, markers and all', () => {
    expect(parseMarkdown('```\n**not bold**\n```')).toEqual([
      { kind: 'code', text: '**not bold**' },
    ])
  })

  it('reads bold, italic and code inside a line', () => {
    expect(parseMarkdown('a **b** c *d* e `f`')).toEqual([
      {
        kind: 'para',
        spans: [
          plain('a '),
          { text: 'b', bold: true, italic: false, code: false },
          plain(' c '),
          { text: 'd', bold: false, italic: true, code: false },
          plain(' e '),
          { text: 'f', bold: false, italic: false, code: true },
        ],
      },
    ])
  })

  it('leaves an unclosed marker as the character it is', () => {
    // An answer is prose from a model, not a document that was linted. A stray asterisk must read
    // as a stray asterisk rather than swallowing the rest of the paragraph.
    expect(parseMarkdown('2 ** 3 is 8')).toEqual([{ kind: 'para', spans: [plain('2 ** 3 is 8')] }])
  })

  it('handles Korean prose, which has no spaces to lean on', () => {
    expect(parseMarkdown('가이던스가 **핵심**입니다.')).toEqual([
      {
        kind: 'para',
        spans: [
          plain('가이던스가 '),
          { text: '핵심', bold: true, italic: false, code: false },
          plain('입니다.'),
        ],
      },
    ])
  })

  it('reads an empty answer as no blocks', () => {
    expect(parseMarkdown('')).toEqual([])
    expect(parseMarkdown('   \n\n  ')).toEqual([])
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd app && npm test -- src/lib/ask/markdown.test.ts`
Expected: FAIL — `Cannot find module './markdown'`.

- [ ] **Step 3: Write the parser**

Create `app/src/lib/ask/markdown.ts`:

```ts
// The worker's `answer.md`, turned into something a React Native tree can draw.
//
// A PARSER AND NOT A LIBRARY, deliberately. `package.json` carries no markdown renderer and this
// app's release lane is fragile enough that a new dependency is a real cost; what an answer written
// to the spec's "keep it to what was asked" actually contains is paragraphs, the odd bullet list, a
// bold run and sometimes a heading. Seventy lines with a test cover that. Anything outside it —
// tables, images, links, nested lists — falls through as its own literal text, which is legible
// rather than wrong, and is the failure direction to want from a renderer fed prose from a model.
//
// THE TYPE RAMP IS THE APP'S OWN, NOT THE EDITION'S. `Answer.tsx` draws with `theme.ts`'s tokens
// and Inter, because this is a message between the owner and their desk rather than a page of the
// paper — the edition's face belongs to the edition. See the spec's §4.

export interface Span {
  text: string
  bold: boolean
  italic: boolean
  code: boolean
}

export type Block =
  | { kind: 'para'; spans: Span[] }
  | { kind: 'bullet'; items: Span[][] }
  | { kind: 'heading'; level: 1 | 2 | 3; spans: Span[] }
  | { kind: 'code'; text: string }

const HEADING = /^(#{1,3})\s+(.*)$/
const BULLET = /^\s*[-*]\s+(.*)$/
const FENCE = /^\s*```/

/**
 * Inline markers, and the rule that keeps a stray one harmless.
 *
 * Each marker is taken only when its CLOSER is found on the same line. An unclosed `**` is two
 * asterisks of prose, which is what "2 ** 3" is, and swallowing the rest of a paragraph over one
 * is the failure a greedy reader has.
 */
function spansOf(line: string): Span[] {
  const out: Span[] = []
  let plain = ''
  let i = 0
  const flush = () => {
    if (plain !== '') out.push({ text: plain, bold: false, italic: false, code: false })
    plain = ''
  }
  while (i < line.length) {
    const marker =
      line.startsWith('**', i) ? '**' : line[i] === '*' ? '*' : line[i] === '`' ? '`' : null
    if (marker === null) {
      plain += line[i]
      i += 1
      continue
    }
    const close = line.indexOf(marker, i + marker.length)
    // No closer, or an empty run (`****`): the marker is text.
    if (close === -1 || close === i + marker.length) {
      plain += line.slice(i, i + marker.length)
      i += marker.length
      continue
    }
    flush()
    out.push({
      text: line.slice(i + marker.length, close),
      bold: marker === '**',
      italic: marker === '*',
      code: marker === '`',
    })
    i = close + marker.length
  }
  flush()
  return out
}

export function parseMarkdown(src: string): Block[] {
  const lines = src.split('\n')
  const blocks: Block[] = []
  // The paragraph being gathered. Lines join with a space: a model writes wrapped prose, and one
  // block per line would double every gap and break sentences across them.
  let para: string[] = []
  const closePara = () => {
    const text = para.join(' ').trim()
    para = []
    if (text !== '') blocks.push({ kind: 'para', spans: spansOf(text) })
  }

  let i = 0
  while (i < lines.length) {
    const line = lines[i]

    if (FENCE.test(line)) {
      closePara()
      const body: string[] = []
      i += 1
      while (i < lines.length && !FENCE.test(lines[i])) {
        body.push(lines[i])
        i += 1
      }
      i += 1 // the closing fence, or the end of the string
      blocks.push({ kind: 'code', text: body.join('\n') })
      continue
    }

    const heading = HEADING.exec(line)
    if (heading !== null) {
      closePara()
      blocks.push({
        kind: 'heading',
        level: heading[1].length as 1 | 2 | 3,
        spans: spansOf(heading[2].trim()),
      })
      i += 1
      continue
    }

    if (BULLET.test(line)) {
      closePara()
      const items: Span[][] = []
      while (i < lines.length) {
        const item = BULLET.exec(lines[i])
        if (item === null) break
        items.push(spansOf(item[1].trim()))
        i += 1
      }
      blocks.push({ kind: 'bullet', items })
      continue
    }

    if (line.trim() === '') {
      closePara()
      i += 1
      continue
    }

    para.push(line.trim())
    i += 1
  }
  closePara()
  return blocks
}
```

- [ ] **Step 4: Run the tests**

Run: `cd app && npm test -- src/lib/ask/markdown.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the renderer**

Create `app/src/components/ask/Answer.tsx`:

```tsx
import { StyleSheet, Text, View } from 'react-native'
import { colors, fonts, radius, space, type } from '../../theme'
import { parseMarkdown, type Span } from '../../lib/ask/markdown'

/**
 * The desk's answer, drawn.
 *
 * The type ramp is the APP's — Inter and `theme.ts` — and not the edition's. A Korean answer sets
 * in whatever face the platform falls back to for Hangul, exactly as the rest of this app's chrome
 * does in Korean; `EditionTypeProvider` belongs to the paper and stops at the Today tab.
 */
export function Answer({ markdown }: { markdown: string }) {
  const blocks = parseMarkdown(markdown)
  return (
    <View style={styles.root}>
      {blocks.map((block, i) => {
        switch (block.kind) {
          case 'heading':
            return (
              <Text key={i} style={block.level === 1 ? type.headingSm : styles.subheading}>
                {block.spans.map(renderSpan)}
              </Text>
            )
          case 'bullet':
            return (
              <View key={i} style={styles.list}>
                {block.items.map((item, j) => (
                  <View key={j} style={styles.item}>
                    <Text style={[type.body, styles.dot]}>•</Text>
                    <Text style={[type.body, styles.itemText]}>{item.map(renderSpan)}</Text>
                  </View>
                ))}
              </View>
            )
          case 'code':
            return (
              <View key={i} style={styles.codeBlock}>
                <Text style={styles.codeText}>{block.text}</Text>
              </View>
            )
          case 'para':
            return (
              <Text key={i} style={type.body}>
                {block.spans.map(renderSpan)}
              </Text>
            )
        }
      })}
    </View>
  )
}

// A `Text` inside a `Text` inherits the outer style and overrides the face, which is how RN nests
// runs. The weight is never set beside a `fontFamily` — `theme.ts`'s rule: Inter's weight is baked
// into the face, and a `fontWeight` next to it drops Android to the system font.
function renderSpan(span: Span, i: number) {
  if (span.code) {
    return (
      <Text key={i} style={styles.codeInline}>
        {span.text}
      </Text>
    )
  }
  if (span.bold) {
    return (
      <Text key={i} style={styles.bold}>
        {span.text}
      </Text>
    )
  }
  if (span.italic) {
    return (
      <Text key={i} style={styles.italic}>
        {span.text}
      </Text>
    )
  }
  return <Text key={i}>{span.text}</Text>
}

const styles = StyleSheet.create({
  root: { gap: space.md },
  subheading: { ...type.headingSm, fontSize: 15, lineHeight: 20 },
  bold: { fontFamily: fonts.semibold },
  italic: { fontStyle: 'italic' },
  list: { gap: space.xs },
  item: { flexDirection: 'row', gap: space.sm },
  dot: { color: colors.textDim },
  itemText: { flex: 1 },
  codeBlock: {
    backgroundColor: colors.surfaceAlt,
    borderRadius: radius.sm,
    padding: space.md,
  },
  codeText: { fontFamily: fonts.mono, fontSize: 13, color: colors.text },
  codeInline: { fontFamily: fonts.mono, fontSize: 13 },
})
```

- [ ] **Step 6: Typecheck and commit**

Run: `cd app && npm run typecheck`
Expected: no errors.

```bash
git add app/src/lib/ask/markdown.ts app/src/lib/ask/markdown.test.ts app/src/components/ask/Answer.tsx
git commit -m "feat(app): an answer is prose, and prose has shape"
```

---

### Task 5: Invalidating Today

**Files:**
- Create: `app/src/lib/edition/invalidate.ts`, `app/src/lib/edition/invalidate.test.ts`
- Modify: `app/src/lib/edition/useEdition.ts`

**Interfaces:**
- Produces: `export function markEditionStale(): void`, `export function takeEditionStale(): boolean`, `export function __resetEditionStaleForTests(): void`

**Why a flag and not a cache wipe.** `useEdition`'s focus re-check is throttled to five minutes and sends the cached ETag; a revised edition changes content, so the ETag misses and the desk answers 200 with the new paper. The only thing standing between the reader and it is the throttle. So invalidation is one bit — "the next load must go" — read and cleared by `load()`. Deleting the cache instead would blank the Today tab to a spinner for the length of a fetch, over a paper that is still perfectly good until the new one lands.

- [ ] **Step 1: Write the failing test**

Create `app/src/lib/edition/invalidate.test.ts`:

```ts
import { describe, it, expect, beforeEach } from '@jest/globals'
import {
  __resetEditionStaleForTests,
  markEditionStale,
  takeEditionStale,
} from './invalidate'

beforeEach(() => {
  __resetEditionStaleForTests()
})

describe('the edition invalidation flag', () => {
  it('is clear until something marks it', () => {
    expect(takeEditionStale()).toBe(false)
  })

  it('is taken exactly once', () => {
    // The Today tab consumes it on the load that follows. A flag that stayed set would turn every
    // later focus into an unconditional fetch, which is the throttle it exists to defeat once.
    markEditionStale()
    expect(takeEditionStale()).toBe(true)
    expect(takeEditionStale()).toBe(false)
  })

  it('two marks before one take are still one fetch', () => {
    markEditionStale()
    markEditionStale()
    expect(takeEditionStale()).toBe(true)
    expect(takeEditionStale()).toBe(false)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd app && npm test -- src/lib/edition/invalidate.test.ts`
Expected: FAIL — `Cannot find module './invalidate'`.

- [ ] **Step 3: Write it**

Create `app/src/lib/edition/invalidate.ts`:

```ts
// One bit: "the paper changed underneath us; the next load must actually go".
//
// A FLAG AND NOT A CACHE WIPE. `useEdition`'s focus re-check is throttled to five minutes and
// carries the cached ETag; a revised edition has different content, so the ETag misses and the desk
// answers 200 with the new paper. The only thing between the reader and it is the throttle — so
// defeating the throttle once is the whole of what invalidation has to do. Deleting the cache
// instead would blank Today to a spinner for the length of a fetch, over an edition that is still
// perfectly good until its replacement lands.
//
// MODULE SCOPE, LIKE `edition/store.ts`'s `current` and `useEventBook`'s snapshot. The writer is
// the ask screen, the reader is the Today tab, and the two are never mounted in the same tree at
// the same moment — there is nothing here for React state to subscribe to.

let stale = false

/** Say the edition on screen is out of date. Called after a `revised` or a successful publish. */
export function markEditionStale(): void {
  stale = true
}

/** Read and clear. The caller is `useEdition`'s `load`, and it is the only one. */
export function takeEditionStale(): boolean {
  const was = stale
  stale = false
  return was
}

export function __resetEditionStaleForTests(): void {
  stale = false
}
```

- [ ] **Step 4: Wire it into `useEdition`**

In `app/src/lib/edition/useEdition.ts`, add to the imports:

```ts
import { takeEditionStale } from './invalidate'
```

and change the body of `load` — the existing block is:

```ts
    if (!alive()) return
    const url = editionUrl(stored, desk)
    if (url !== machineRef.current.url) {
      await adopt(url, cold ? cached : undefined)
      return
    }
    await refresh()
```

Replace it with:

```ts
    if (!alive()) return
    // TAKEN BEFORE THE BRANCH, not inside it. `adopt` fetches unconditionally, so consuming the
    // flag on that path costs nothing and leaving it set would spend an unconditional fetch on
    // the next focus as well — a mark is one refetch, whichever way the address went.
    const forced = takeEditionStale()
    const url = editionUrl(stored, desk)
    if (url !== machineRef.current.url) {
      await adopt(url, cold ? cached : undefined)
      return
    }
    // `fresh` when the desk has just rewritten the paper: the five-minute throttle would
    // otherwise hold a revision the owner asked for and was told about, on the one screen it is
    // about, for up to five minutes.
    await refresh(forced ? { fresh: true } : {})
```

- [ ] **Step 5: Run the whole app suite and the typechecker**

Run: `cd app && npm test && npm run typecheck`
Expected: PASS — in particular `src/lib/edition/editionState.test.ts` is untouched, because the reducer did not change.

- [ ] **Step 6: Commit**

```bash
git add app/src/lib/edition/invalidate.ts app/src/lib/edition/invalidate.test.ts app/src/lib/edition/useEdition.ts
git commit -m "feat(app): a paper the desk just rewrote does not wait out the throttle"
```

---

### Task 6: The copy, in both languages

**Files:**
- Modify: `app/src/i18n/en.ts`, `app/src/i18n/ko.ts`

**Interfaces:**
- Produces: `strings().ask.*` and `strings().settings.notify.kinds.answer`, consumed by Tasks 7–10.

Every placeholder must appear in both tables — `i18n/index.test.ts` fails on a dropped `{detail}` and on a Korean value identical to the English one.

- [ ] **Step 1: Run the parity test first, to see it green before the change**

Run: `cd app && npm test -- src/i18n`
Expected: PASS.

- [ ] **Step 2: Add the English block**

In `app/src/i18n/en.ts`, add `answer` to `settings.notify.kinds`:

```ts
      kinds: {
        earnings: 'Earnings',
        expiry: 'Option expiries',
        dividend: 'Dividends',
        econ: 'Economic releases',
        researched: 'Dates found by research',
        // The sixth, and the only one that is not about a future date — so it takes no lead time.
        answer: 'Answers to your messages',
      },
```

and add a top-level `ask` block, after `schedule`:

```ts
  ask: {
    title: 'Ask the desk',
    /** The Today header's button. One word, because it sits beside a masthead. */
    open: 'Ask',
    placeholder: 'Ask about today’s paper — or say what you want changed.',
    send: 'Send',
    newThread: 'New question',
    /** The screen with nothing on it yet. It says what the two kinds of message do. */
    empty:
      'Ask a question about today’s paper and the desk answers it. Ask for a change — “lead with the lawsuit”, “add what the CFO said” — and it rewrites the paper.',
    needsDesk:
      'Asking the desk needs its address and an operator token. Add them in Settings, then come back.',
    /** The composer refuses at the desk's own limit rather than posting something it will refuse. */
    tooLong: 'That’s longer than the desk takes — {max} characters at most.',
    // While it is out. Three sentences and not one spinner, because the three are minutes apart
    // and "still working" with no idea which stage is the state that feels broken.
    status: {
      sending: 'Sending…',
      pending: 'Waiting for the desk to pick this up…',
      claimed: 'The desk is working on it…',
      expired: 'Nobody picked this up, so it expired.',
      cancelled: 'This was cancelled.',
    },
    /** The chip on a turn that rewrote the paper. */
    changed: 'The paper changed',
    /** A revision the desk wrote and did not publish, and the phone could not publish either. */
    staged: 'The new paper is written but hasn’t gone out yet.',
    publish: 'Publish it',
    publishFailed: 'The desk wouldn’t publish it. {detail}',
    sendFailed: 'That didn’t reach the desk. {detail}',
    retry: 'Send again',
    forgotten: 'The desk no longer has this message, so there’s no answer to fetch.',
    failed: 'The desk couldn’t answer this. {detail}',
    /** `done` with no notes: the command finished and the worker wrote nothing. */
    noAnswer: 'The desk finished with this but wrote no answer.',
    a11y: {
      openAsk: 'Ask the desk about this edition',
    },
  },
```

- [ ] **Step 3: Add the Korean block**

In `app/src/i18n/ko.ts`, the matching `kinds.answer`:

```ts
        answer: '보낸 메시지의 답변',
```

and the `ask` block:

```ts
  ask: {
    title: '데스크에 묻기',
    open: '묻기',
    placeholder: '오늘 신문에 대해 묻거나, 바꾸고 싶은 것을 적으세요.',
    send: '보내기',
    newThread: '새 질문',
    empty:
      '오늘 신문에 대해 물으면 데스크가 답합니다. “소송을 톱으로”, “CFO 발언을 넣어줘”처럼 바꿔 달라고 하면 신문을 다시 씁니다.',
    needsDesk: '데스크에 물으려면 주소와 오퍼레이터 토큰이 필요합니다. 설정에서 입력한 뒤 다시 오세요.',
    tooLong: '데스크가 받는 길이를 넘었습니다 — 최대 {max}자입니다.',
    status: {
      sending: '보내는 중…',
      pending: '데스크가 가져가기를 기다리는 중…',
      claimed: '데스크가 작업하는 중…',
      expired: '아무도 가져가지 않아 만료되었습니다.',
      cancelled: '취소되었습니다.',
    },
    changed: '신문을 바꿨습니다',
    staged: '새 신문은 다 썼지만 아직 내보내지 않았습니다.',
    publish: '내보내기',
    publishFailed: '데스크가 내보내지 못했습니다. {detail}',
    sendFailed: '데스크에 닿지 못했습니다. {detail}',
    retry: '다시 보내기',
    forgotten: '데스크에 이 메시지가 남아 있지 않아 답변을 가져올 수 없습니다.',
    failed: '데스크가 답하지 못했습니다. {detail}',
    noAnswer: '데스크가 끝냈지만 답변을 쓰지 않았습니다.',
    a11y: {
      openAsk: '이 신문에 대해 데스크에 묻기',
    },
  },
```

- [ ] **Step 4: Run the parity test and the typechecker**

Run: `cd app && npm test -- src/i18n && npm run typecheck`
Expected: PASS. A failure naming a key path means the two tables disagree about a key or a placeholder — fix the one it names.

- [ ] **Step 5: Commit**

```bash
git add app/src/i18n/en.ts app/src/i18n/ko.ts
git commit -m "feat(app): the words for asking the desk"
```

---

### Task 7: `useAskThread`

**Files:**
- Create: `app/src/lib/ask/useAskThread.ts`

**Interfaces:**
- Consumes: `createDeskClient`, `humanDeskError`, `MAX_COMMAND_TEXT` (Task 1); the whole of `threads.ts` (Tasks 2–3); `markEditionStale` (Task 5); `strings().ask` (Task 6); `getDeskBaseUrl` from `../store`; `getDeskToken` from `../deskToken`; `useLanguage` from `../../i18n` (its `resolved` field, never `choice` — `system` is not a language the desk takes).
- Produces:
  ```ts
  export const ASK_POLL_MS = 5_000
  export interface AskThread {
    ready: boolean | null
    threads: Thread[]
    thread: Thread | null
    open: (threadId: string | null) => void
    send: (text: string) => Promise<void>
    retry: (turnId: string) => Promise<void>
    publish: (commandId: string) => Promise<void>
  }
  export function useAskThread(opts: { commandId?: string | null }): AskThread
  ```

**There is deliberately no test file for this hook.** The app has no component test runner, and every decision it could make has been moved into `threads.ts`, `readResult` and `markEditionStale`, which do have one. What is left is effects: read storage, call the desk, dispatch. `useEdition.ts` carries the same note and the same shape.

- [ ] **Step 1: Write the hook**

Create `app/src/lib/ask/useAskThread.ts`:

```ts
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
```

- [ ] **Step 2: Typecheck**

Run: `cd app && npm run typecheck && npm test`
Expected: PASS. The hook has no test of its own by design — see the note above the task.

- [ ] **Step 3: Commit**

```bash
git add app/src/lib/ask/useAskThread.ts
git commit -m "feat(app): the loop that waits for the desk"
```

---

### Task 8: The `/ask` screen

**Files:**
- Create: `app/src/components/ask/TurnRow.tsx`, `app/src/app/ask.tsx`
- Modify: `app/src/app/_layout.tsx`

**Interfaces:**
- Consumes: `useAskThread` (Task 7), `Answer` (Task 4), `readResult`, `Turn`, `Thread` (Task 2), `strings().ask` (Task 6).
- Produces: the route `/ask`, accepting the optional query param `command` (a desk command id, from a push).

- [ ] **Step 1: Write the turn row**

Create `app/src/components/ask/TurnRow.tsx`:

```tsx
import { StyleSheet, Text, View } from 'react-native'
import { useStrings } from '../../i18n'
import { colors, fonts, radius, space, type } from '../../theme'
import { readResult, type Turn } from '../../lib/ask/threads'
import { Answer } from './Answer'
import { Button } from '../Button'
import { Chip } from '../Chip'

/**
 * One turn: what was asked, what came back, and — when there is one — what to do about it.
 *
 * The question is drawn as a card and the answer as plain prose under it, rather than as two
 * chat bubbles. There are exactly two speakers and minutes between them; a bubble layout spends
 * half the measure on a distinction the reader already has.
 */
export function TurnRow({
  turn,
  onRetry,
  onPublish,
}: {
  turn: Turn
  onRetry: (turnId: string) => void
  onPublish: (commandId: string) => void
}) {
  const t = useStrings()
  const outcome = readResult(turn.result)
  const waiting =
    turn.status === 'sending' || turn.status === 'pending' || turn.status === 'claimed'

  return (
    <View style={styles.root}>
      <View style={styles.question}>
        <Text style={type.body}>{turn.text}</Text>
      </View>

      {waiting ? <Text style={type.caption}>{t.ask.status[turn.status]}</Text> : null}
      {turn.status === 'expired' ? <Text style={type.caption}>{t.ask.status.expired}</Text> : null}
      {turn.status === 'cancelled' ? (
        <Text style={type.caption}>{t.ask.status.cancelled}</Text>
      ) : null}

      {/* The chip that says the paper changed. `revised` only — a `staged` turn says something
          different below, because for that one nothing has reached the wall yet. */}
      {outcome?.kind === 'revised' ? (
        <View style={styles.chipRow}>
          <Chip label={t.ask.changed} icon="newspaper-outline" tone="accent" />
        </View>
      ) : null}

      {turn.answer !== null && turn.answer !== '' ? <Answer markdown={turn.answer} /> : null}

      {/* Done, with nothing written. A real outcome of the worker's, and silence here would look
          exactly like a turn that is still out. */}
      {turn.status === 'done' && (turn.answer === null || turn.answer === '') ? (
        <Text style={type.caption}>{t.ask.noAnswer}</Text>
      ) : null}

      {/* A revision the phone could not publish. The sentence and the button together, because
          the owner asked for the change and this is the one thing left to do about it. */}
      {outcome?.kind === 'staged' ? (
        <View style={styles.staged}>
          <Text style={type.caption}>{t.ask.staged}</Text>
          <Button
            label={t.ask.publish}
            variant="secondary"
            onPress={() => turn.commandId !== null && onPublish(turn.commandId)}
          />
        </View>
      ) : null}

      {/* The desk's own words for a result this app has no vocabulary for — a worker one release
          ahead, or a failure message. Drawn rather than swallowed. */}
      {outcome?.kind === 'other' ? <Text style={type.caption}>{outcome.text}</Text> : null}

      {turn.error !== null ? <Text style={styles.error}>{turn.error}</Text> : null}

      {turn.status === 'unsent' ? (
        <Button label={t.ask.retry} variant="secondary" onPress={() => onRetry(turn.id)} />
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  root: { gap: space.md, paddingVertical: space.lg },
  question: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    padding: space.lg,
  },
  chipRow: { flexDirection: 'row' },
  staged: { gap: space.sm },
  error: { ...type.caption, color: colors.down, fontFamily: fonts.medium },
})
```

- [ ] **Step 2: Write the screen**

Create `app/src/app/ask.tsx`:

```tsx
import { useCallback, useState } from 'react'
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { Screen } from '../components/Screen'
import { ScreenMessage } from '../components/ScreenMessage'
import { BackButton } from '../components/BackButton'
import { Button } from '../components/Button'
import { TurnRow } from '../components/ask/TurnRow'
import { fill, useStrings } from '../i18n'
import { MAX_COMMAND_TEXT } from '../lib/desk'
import { useAskThread } from '../lib/ask/useAskThread'
import { colors, fonts, layout, radius, space, type } from '../theme'

/**
 * Ask the desk — one conversation, and the composer under it.
 *
 * Reached two ways, and the parameter says which: from the Today header with nothing, which opens
 * a new question, or from a notification tap with `command=<id>`, which opens the thread that
 * command belongs to. The route param is the DESK's id because that is what the push carries; the
 * thread it belongs to is a lookup the hook does over what it read off disk.
 *
 * Everything decided about a turn is `threads.ts`'s; everything decided about the loop is
 * `useAskThread`'s. What is left here is layout.
 */
export default function AskScreen() {
  const router = useRouter()
  const t = useStrings()
  const { command } = useLocalSearchParams<{ command?: string }>()
  const { ready, thread, send, retry, publish } = useAskThread({ commandId: command ?? null })
  const [draft, setDraft] = useState('')

  const onSend = useCallback(() => {
    const text = draft.trim()
    if (text === '' || text.length > MAX_COMMAND_TEXT) return
    setDraft('')
    void send(text)
  }, [draft, send])

  // Back is the only exit — a root-stack route with no tab bar under it — and a notification tap
  // into a cold process leaves nothing to go back TO, so the arrow falls back to Today, the tab
  // this screen is about. `schedule.tsx` and `preview.tsx` make the same fallback.
  const header = (
    <View style={styles.titleRow}>
      <BackButton onPress={() => (router.canGoBack() ? router.back() : router.replace('/edition'))} />
      <Text style={styles.title}>{t.ask.title}</Text>
      <View style={styles.backSpacer} />
    </View>
  )

  // Storage has not answered. Half-known is unknown: drawing "add your desk" for one frame of
  // every open would send an owner who has one to go and set one up.
  if (ready === null) {
    return (
      <Screen>
        {header}
        <ScreenMessage loading />
      </Screen>
    )
  }

  // `message` and not `error`: a phone with no desk is a complete state, not a fault. Drawing it
  // in error red would put a failure in front of somebody who has simply never set a desk up —
  // `schedule.tsx` draws its own `empty.needsDesk` the same way.
  if (!ready) {
    return (
      <Screen>
        {header}
        <ScreenMessage message={t.ask.needsDesk} />
      </Screen>
    )
  }

  const tooLong = draft.trim().length > MAX_COMMAND_TEXT

  return (
    <Screen>
      {header}
      <KeyboardAvoidingView
        style={styles.fill}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView contentContainerStyle={styles.scroll}>
          {thread === null ? (
            <Text style={[type.body, styles.empty]}>{t.ask.empty}</Text>
          ) : (
            thread.turns.map((turn) => (
              <TurnRow key={turn.id} turn={turn} onRetry={retry} onPublish={publish} />
            ))
          )}
        </ScrollView>

        <View style={styles.composer}>
          {tooLong ? (
            <Text style={styles.tooLong}>
              {fill(t.ask.tooLong, { max: String(MAX_COMMAND_TEXT) })}
            </Text>
          ) : null}
          <TextInput
            style={styles.input}
            value={draft}
            onChangeText={setDraft}
            placeholder={t.ask.placeholder}
            placeholderTextColor={colors.textFaint}
            multiline
            // The desk's own ceiling, enforced here so a long paste is refused by the composer
            // rather than by a 400 four seconds later.
            maxLength={MAX_COMMAND_TEXT}
          />
          <Button
            label={t.ask.send}
            onPress={onSend}
            disabled={draft.trim() === '' || tooLong}
          />
        </View>
      </KeyboardAvoidingView>
    </Screen>
  )
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: layout.gutter,
    paddingBottom: space.sm,
  },
  title: { ...type.heading, flex: 1, textAlign: 'center' },
  backSpacer: { width: 40 },
  scroll: { paddingHorizontal: layout.gutter, paddingBottom: space.xl },
  empty: { color: colors.textDim, paddingTop: space.xl },
  composer: {
    gap: space.sm,
    paddingHorizontal: layout.gutter,
    paddingTop: space.md,
    paddingBottom: space.lg,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    backgroundColor: colors.surface,
  },
  input: {
    ...type.body,
    maxHeight: 140,
    minHeight: 44,
    backgroundColor: colors.surfaceAlt,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
  },
  tooLong: { ...type.caption, color: colors.down, fontFamily: fonts.medium },
})
```

- [ ] **Step 3: Register the route**

In `app/src/app/_layout.tsx`, beside the other full-screen pushes:

```tsx
              {/* The event book, opened from the Markets tab's next-three block. */}
              <Stack.Screen name="schedule" />
              {/* A message to the desk and its answer. Opened from Today's header, or by a tap on
                  the push that says an answer arrived. */}
              <Stack.Screen name="ask" />
```

- [ ] **Step 4: Typecheck and run the suite**

Run: `cd app && npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/app/ask.tsx app/src/components/ask/TurnRow.tsx app/src/app/_layout.tsx
git commit -m "feat(app): ask the desk, and read what it said"
```

---

### Task 9: The Ask button in Today's header

**Files:**
- Modify: `app/src/components/edition/Masthead.tsx`, `app/src/app/(tabs)/edition.tsx`

**Interfaces:**
- Consumes: `strings().ask.open`, `strings().ask.a11y.openAsk` (Task 6); the `/ask` route (Task 8).
- Produces: an `onAsk?: () => void` prop on `Masthead`.

**Optional, not required.** `Masthead` is drawn for the bundled demo too, and a phone with no desk cannot ask anything. The prop is passed only when there is somewhere for the tap to go, so the button is absent rather than dead — the same reason the symbol row is a `Pressable` only when there is a symbol.

- [ ] **Step 1: Add the prop and the button to `Masthead`**

In the signature:

```tsx
export function Masthead({
  edition,
  demo,
  freshness,
  error,
  onRetry,
  onPressSymbol,
  onAsk,
}: {
  edition: Edition
  demo: boolean
  freshness: string | null
  /** A failed refresh with content still on screen. Null when nothing failed. */
  error: string | null
  onRetry: () => void
  onPressSymbol: () => void
  /**
   * Open the ask screen. ABSENT when there is nowhere for the tap to go — the bundled demo, or a
   * phone with no desk address and no token. A button that is drawn and does nothing is worse
   * than one that is not there, which is the argument the symbol row above already makes.
   */
  onAsk?: () => void
}) {
```

and, at the top of the returned tree, wrap the company name in a row with the button on the right:

```tsx
    <View style={styles.root}>
      <View style={styles.titleRow}>
        <Text style={[ty.headingLg, styles.name]} numberOfLines={2}>
          {s.name !== '' ? s.name : s.symbol}
        </Text>
        {onAsk !== undefined ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t.ask.a11y.openAsk}
            onPress={onAsk}
            hitSlop={8}
            style={({ pressed }) => [styles.ask, pressed && styles.askPressed]}
          >
            <Text style={styles.askLabel}>{t.ask.open}</Text>
          </Pressable>
        ) : null}
      </View>
```

with the styles:

```tsx
  titleRow: { flexDirection: 'row', alignItems: 'flex-start', gap: space.md },
  name: { flex: 1 },
  ask: {
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: radius.pill,
    backgroundColor: colors.accentDim,
  },
  askPressed: { opacity: 0.7 },
  askLabel: { fontFamily: fonts.semibold, fontSize: 13, color: colors.accent },
```

Add `radius` and `space` to the theme import at the top of the file if they are not already there.

- [ ] **Step 2: Pass it from the Today tab, only when there is a desk**

In `app/src/app/(tabs)/edition.tsx`, add the storage reads:

```tsx
import { useEffect, useState } from 'react'
import { getDeskBaseUrl } from '../../lib/store'
import { getDeskToken } from '../../lib/deskToken'
```

inside the component:

```tsx
  // Whether asking is possible at all. Both are needed: the control plane sends a credential on
  // every call, so an address with no token can ask nothing. Read once — a token saved in Settings
  // while this tab is mounted is picked up on the next mount, which is one tab switch away.
  const [canAsk, setCanAsk] = useState(false)
  useEffect(() => {
    let alive = true
    void (async () => {
      const [address, token] = await Promise.all([getDeskBaseUrl(), getDeskToken()])
      if (alive) setCanAsk(Boolean(address) && Boolean(token))
    })()
    return () => {
      alive = false
    }
  }, [])
```

and on the `Masthead`:

```tsx
              onAsk={canAsk ? () => router.push('/ask') : undefined}
```

- [ ] **Step 3: Typecheck and run the suite**

Run: `cd app && npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add app/src/components/edition/Masthead.tsx app/src/app/\(tabs\)/edition.tsx
git commit -m "feat(app): the question is asked where the paper is read"
```

---

### Task 10: The `answer` push, and the tap that opens the thread

**Files:**
- Modify: `app/src/lib/notify.ts`, `app/src/lib/notify.test.ts`, `app/jest.setup.js`, `app/src/app/_layout.tsx`, `app/src/app/(tabs)/settings.tsx:1290-1332` (the `PUSH_KINDS.map` block: the lead chip row is at `:1307`, the `noLead` note at `:1329`)

**Interfaces:**
- Consumes: `PUSH_KINDS`, `DEFAULT_PREFS`, `DEFAULT_LEAD`, `deviceBody` — all already in `notify.ts`.
- Produces:
  - `PUSH_KINDS` gains `'answer'`
  - `export const LEAD_KINDS: readonly PushKind[]` — the five that are about a future date
  - `export function commandIdOfPush(data: unknown): string | null`
  - `export function askRouteForPush(data: unknown): string | null`
  - `export function addNotificationTapListener(go: (route: string) => void): () => void`

**The ordering constraint from Global Constraints applies here.** `deviceBody` sends a `prefs` and a `lead` entry for every kind in `PUSH_KINDS`, and the desk refuses an unknown key over the whole document. So this task must not land before the desk's `push.KINDS` gains `answer`, or every registration from every phone becomes a `bad_push` 400.

**`answer` takes no lead time**, because it is about something that already happened. That is why `LEAD_KINDS` splits off rather than the settings screen special-casing one name.

- [ ] **Step 1: Write the failing tests**

Append to `app/src/lib/notify.test.ts`:

```ts
import { askRouteForPush, commandIdOfPush, LEAD_KINDS, PUSH_KINDS } from './notify'

describe('the answer kind', () => {
  it('is a sixth switch beside the five calendar ones', () => {
    expect([...PUSH_KINDS]).toEqual([
      'earnings',
      'expiry',
      'dividend',
      'econ',
      'researched',
      'answer',
    ])
  })

  it('takes no lead time, because it is about something that already happened', () => {
    // A lead is "how far ahead of a date". An answer has no date ahead of it, and a lead selector
    // under this switch would be asking a question with no answer.
    expect([...LEAD_KINDS]).toEqual(['earnings', 'expiry', 'dividend', 'econ', 'researched'])
    expect(DEFAULT_LEAD.answer).toEqual([])
  })

  it('registers with an empty lead list, which the desk takes', () => {
    const body = deviceBody(PUSH, 'ios', 'Asia/Seoul', DEFAULT_PREFS)
    expect(body.prefs.answer).toBe(true)
    expect(body.lead.answer).toEqual([])
  })
})

describe('routing a notification tap', () => {
  it('finds the command id in the push’s data', () => {
    expect(commandIdOfPush({ command_id: 'c0ffee00', result: 'answered' })).toBe('c0ffee00')
  })

  it('ignores a push carrying no command id — every calendar alert is one', () => {
    expect(commandIdOfPush({ event_id: 'evt1' })).toBeNull()
    expect(commandIdOfPush(null)).toBeNull()
    expect(commandIdOfPush({ command_id: 42 })).toBeNull()
    expect(commandIdOfPush({ command_id: '' })).toBeNull()
  })

  it('routes to the ask screen with the command as the parameter', () => {
    // The push carries a COMMAND id and the screen opens a THREAD; the lookup is the ask hook's,
    // over what it reads off disk. Routing by command id is what makes the link work on a phone
    // whose thread list was written by a different launch.
    expect(askRouteForPush({ command_id: 'c0ffee00' })).toBe('/ask?command=c0ffee00')
  })

  it('percent-encodes an id that would otherwise break the query', () => {
    expect(askRouteForPush({ command_id: 'a&b' })).toBe('/ask?command=a%26b')
  })

  it('routes nothing for a push that is not about a command', () => {
    expect(askRouteForPush({ event_id: 'evt1' })).toBeNull()
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd app && npm test -- src/lib/notify.test.ts`
Expected: FAIL — `askRouteForPush is not a function`, and the `PUSH_KINDS` assertion fails on the missing sixth.

- [ ] **Step 3: Widen the vocabulary in `notify.ts`**

Replace the `PUSH_KINDS` declaration and add `LEAD_KINDS` beside it:

```ts
/**
 * SIX, NOT FIVE. Five are about a DATE — four `calendar.COMPUTED_KINDS` plus `researched`, the
 * one switch over everything a research run found — and the sixth is not about a date at all.
 *
 * `answer` is the desk telling this phone that a message it sent has been answered. It is the
 * first push here that is not a calendar alert, which is why it is a switch of its own: somebody
 * who wants to know about their earnings dates and not about their own messages can say so.
 */
export const PUSH_KINDS = [
  'earnings',
  'expiry',
  'dividend',
  'econ',
  'researched',
  'answer',
] as const
export type PushKind = (typeof PUSH_KINDS)[number]

/**
 * The kinds a lead time means anything for.
 *
 * A lead is "how far ahead of the date to say something", and `answer` has no date ahead of it —
 * it fires when the work finished. So it registers with an empty lead list and the Settings
 * section draws no selector under it. A list here rather than a `kind !== 'answer'` at the two
 * call sites, because the two would then be free to disagree about it.
 */
export const LEAD_KINDS: readonly PushKind[] = ['earnings', 'expiry', 'dividend', 'econ', 'researched']
```

Add the `answer` entries to the two defaults:

```ts
export const DEFAULT_LEAD: Record<PushKind, Lead[]> = {
  // …the five existing entries, unchanged…
  /** Empty, and it is not an omission: see `LEAD_KINDS`. */
  answer: [],
}
```

and in `DEFAULT_PREFS`, `answer: true` beside the others — somebody who turns notifications on has, by definition, asked to be told things, and an answer to their own message is the least surprising one.

Then append the two readers and the listener:

```ts
// ---------------------------------------------------------------------------
// A tap on a notification
// ---------------------------------------------------------------------------
//
// THE FIRST RESPONSE LISTENER THIS APP HAS HAD. Every push before this one was a calendar alert
// whose only job was to put a line on a lock screen; a tap opened the app and that was the whole
// interaction. An answer is different — there is a specific screen it belongs to, and arriving on
// whatever tab was last open is arriving nowhere.
//
// THE PUSH CARRIES A COMMAND ID, NOT A THREAD ID. A thread is the phone's own grouping and the
// desk has never heard of one, so the route names the command and the ask screen looks up which
// conversation it belongs to. That is also what makes the link survive a reinstall gracefully: a
// command this phone has no thread for opens a new question rather than a broken screen.

/** The command a push is about, or `null` for a push that is not about one — every alert. */
export function commandIdOfPush(data: unknown): string | null {
  if (data === null || typeof data !== 'object') return null
  const id = (data as Record<string, unknown>).command_id
  return typeof id === 'string' && id !== '' ? id : null
}

/** Where a tap on that push should land, or `null` for one this app has no screen for. */
export function askRouteForPush(data: unknown): string | null {
  const id = commandIdOfPush(data)
  return id === null ? null : `/ask?command=${encodeURIComponent(id)}`
}

/**
 * Subscribe to taps. Returns the unsubscribe, so a caller can be an effect.
 *
 * The routing decision is `askRouteForPush`'s and is pure and tested; this is the thin wrapper
 * around the library, the same shape as `readPermission` and `fetchPushToken` above and for the
 * same reason — nothing in this app can render a screen under test, so nothing decided inside a
 * listener would be argued anywhere but in prose.
 */
export function addNotificationTapListener(go: (route: string) => void): () => void {
  const sub = Notifications.addNotificationResponseReceivedListener((response) => {
    const route = askRouteForPush(response.notification.request.content.data)
    if (route !== null) go(route)
  })
  return () => sub.remove()
}
```

- [ ] **Step 4: Teach the Jest mock the new library call**

In `app/jest.setup.js`, add to the `expo-notifications` factory:

```js
  // The response listener the ask feature mounts. Nothing in this suite exercises delivery — a tap
  // cannot happen under Jest — so this hands back a subscription that removes cleanly and never
  // fires, which is what `_layout.tsx`'s effect needs to mount and unmount.
  addNotificationResponseReceivedListener: () => ({ remove: () => undefined }),
```

- [ ] **Step 5: Mount the listener at the root**

In `app/src/app/_layout.tsx`, add the imports and the effect inside `RootLayout`:

```tsx
import { useRouter } from 'expo-router'
import { addNotificationTapListener } from '../lib/notify'
```

```tsx
  const router = useRouter()

  // A tap on the desk's "your answer is ready" opens the conversation it is about. Mounted at the
  // ROOT and not on a screen: the tap that matters most is the one on a cold process, where no
  // screen is mounted yet and the notification is the reason the app is starting at all.
  useEffect(() => addNotificationTapListener((route) => router.push(route)), [router])
```

- [ ] **Step 6: Draw the sixth switch without a lead row**

In `app/src/app/(tabs)/settings.tsx`, the block at `:1290` maps `PUSH_KINDS` to a switch with a lead selector under it (`:1307`) and a `noLead` note beside it (`:1329`). Gate both on membership of `LEAD_KINDS` — import it from `../../lib/notify` alongside the existing `PUSH_KINDS` import at `:53`, and wrap the lead row:

```tsx
              {LEAD_KINDS.includes(kind) ? (
                /* …the existing lead selector for this kind, unchanged… */
              ) : null}
```

The `noLead` note ("On, but nothing is chosen above") must be gated the same way: an `answer` switch with an empty lead list is correct, not broken, and saying otherwise about it would be the section reporting a fault that is not there.

- [ ] **Step 7: Run the suite and the typechecker**

Run: `cd app && npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add app/src/lib/notify.ts app/src/lib/notify.test.ts app/jest.setup.js app/src/app/_layout.tsx app/src/app/\(tabs\)/settings.tsx
git commit -m "feat(app): a tap on the answer opens the conversation"
```

---

### Task 11: The contract, written down

**Files:**
- Modify: `docs/app-control.md`

- [ ] **Step 1: Extend "The desk from the phone"**

After the paragraph beginning "**These are the routes a phone client uses, not the desk's whole surface.**", insert:

```markdown
**The phone posts to the queue, and that is new.** The paragraph above used to
say the queue belongs to the worker and not to a reader on a phone. That is
still true of `claim` and of `done`/`fail`, and it is no longer true of the
queue itself: the owner can type a message on the phone, and the desk answers
it. Four routes, all at the operator token the phone already holds, and
`app/src/lib/desk.ts` is again the whole client.

| Method | Path | Body | What the phone does with it |
|---|---|---|---|
| POST | `/api/commands` | `{"kind":"ask","text":…,"lang":"ko","reply_to":…,"source":"app"}` | send a message; the answer is the row it created |
| GET | `/api/commands/<id>` | — | poll one command every 5 s while it is `pending` or `claimed` |
| GET | `/api/commands/<id>/notes.md` | — | the worker's answer, as `text/markdown` |
| POST | `/api/publish` | — | force out an edition the worker staged |

Four things about it that a client has to get right:

- **`result`'s first word is the whole vocabulary.** `answered`,
  `revised <edition_id>` or `staged <edition_id>`. The phone branches on the
  first word and never parses the rest, so a worker one release ahead degrades
  to a sentence on screen rather than to a crash.
- **A 404 is a state on three of the four.** An unknown command id is "the desk
  no longer has this message", a missing `notes.md` is "it finished and wrote
  no answer", and `nothing is staged` on `/api/publish` is "the staged edition
  already went out". None of the three is a failure a retry fixes, so the
  client answers `null` / an outcome rather than throwing — the rule
  `forgetPushDevice` already held.
- **`reply_to` is the thread.** There is no server-side thread object. The
  phone groups turns itself, in AsyncStorage under `claudepost.threads`, and
  each turn names the previous one that actually reached the desk.
- **A revision invalidates the Today tab.** `revised` (or a `staged` the phone
  then published) sets a flag that makes the next Today focus fetch
  `news.json` unconditionally, rather than waiting out its five-minute
  throttle. The board is not involved: a revised edition reaches it exactly as
  a morning one does.

**The `answer` push is the first that is not a calendar alert.** It carries
`data: {"command_id": …, "result": <the first word>}`, and a tap on it opens
`/ask?command=<id>` — the route names the desk's command because that is what
the push carries; which conversation it belongs to is the phone's own lookup.
`push.KINDS` gains `answer` on the desk and `PUSH_KINDS` gains it in the app,
and the two must move together: `deviceBody` sends an entry for every kind, and
the desk refuses an unknown key over the whole document, so an app that knows
`answer` against a desk that does not turns every registration into a
`bad_push` 400. It is the one kind that takes no lead time, because it is about
something that already happened.

The design is
[docs/superpowers/specs/2026-09-10-ask-the-desk-design.md](superpowers/specs/2026-09-10-ask-the-desk-design.md).
```

- [ ] **Step 2: Commit**

```bash
git add docs/app-control.md
git commit -m "docs(app): the phone posts to the queue now"
```

---

### Task 12: Render it on the iPhone simulator

**Files:** none changed unless the render finds a defect — in which case fix it in this task and say what it was in the commit.

**This is not optional.** [AGENTS.md](../../../AGENTS.md) carries the owner's rule: render the app on the iPhone simulator and look at it before opening a PR. The tile heights are estimated rather than measured, and the first render after a review pipeline that had passed every property test found six layout defects. This screen has a `KeyboardAvoidingView`, a multiline `TextInput` and Korean prose in it, none of which any test in this plan can see.

**What this task can and cannot cover.** The spec's §5 end-to-end wants the worker container answering a real message. That needs the desk plan and the worker plan landed. This task covers the app's own half against a real desk with the `ask` kind, driving the command through its states by hand — which is exactly what exercises every branch the phone has.

- [ ] **Step 1: Put a local desk up, without Docker**

```bash
mkdir -p /tmp/deskdata /tmp/desksecrets
server/tools/mint-token.sh operator phone     # prints the token once — copy it
cp ~/.claudepost/tokens.json /tmp/desksecrets/tokens.json
CLAUDEPOST_DATA=/tmp/deskdata \
CLAUDEPOST_SECRETS=/tmp/desksecrets \
CLAUDEPOST_REPO="$PWD" \
CLAUDEPOST_HOST=127.0.0.1 \
CLAUDEPOST_PORT=8080 \
PYTHONPATH=server python3 -m claudepost
```

The log ends with `current edition (none filed yet)`, which is fine — the ask feature does not need one. In a second shell, file the committed fixture so Today has a paper to be about:

```bash
python3 tools/mock_news_server.py --port 8123 &     # serves the reference edition
```

- [ ] **Step 2: Start the app under Expo Go**

```bash
cd app && npx expo start --ios --go
```

`--go` is required: `expo-dev-client` is a dependency and without the flag Expo tries to open a dev build that is not committed.

- [ ] **Step 3: Point the phone at both, through the UI**

In Settings, set the desk address to `http://127.0.0.1:8080` and paste the operator token from step 1; set the news source to `http://127.0.0.1:8123/news.json`. Take a screenshot of Settings so the `answer` switch, with no lead selector under it, is on the record:

```bash
xcrun simctl io booted screenshot /tmp/ask-settings.png
```

- [ ] **Step 4: Send a message and drive it through `answered`**

Open Today, tap **Ask**, type "why did it move?", send. Screenshot the `pending` state. Then, in a shell, claim and finish it as the worker would:

```bash
DESK=http://127.0.0.1:8080
TOKEN=<the operator token>
CID=$(curl -sS "$DESK/api/commands" -H "Authorization: Bearer $TOKEN" | python3 -c 'import json,sys; print(json.load(sys.stdin)["commands"][0]["id"])')
curl -sS "$DESK/api/commands/next" -H "Authorization: Bearer $TOKEN"        # -> claimed
curl -sS -X PUT "$DESK/api/commands/$CID/notes.md" -H "Authorization: Bearer $TOKEN" \
     --data-binary $'## Why it moved\n\nThe **guide**, not the buyback.\n\n- Q3 revenue in line\n- FY guide cut 4%\n'
curl -sS -X POST "$DESK/api/commands/$CID/done" -H "Authorization: Bearer $TOKEN" \
     -d '{"result":"answered"}'
```

Within five seconds the screen must show the heading, the bold run and the two bullets. Screenshot it.

- [ ] **Step 5: Drive a revision, and confirm Today refetches**

Send a second message — "lead with the lawsuit" — and finish it with `{"result":"revised abc123"}`. The turn must carry the **The paper changed** chip. Go back to Today and confirm the tab issues a fetch immediately rather than sitting on its throttle: the desk's log shows a `GET /news.json` at the moment the tab focuses. Screenshot the chip.

- [ ] **Step 6: Drive the three failures**

Each of these is a branch nothing else in this plan renders:

1. **A send that does not reach the desk.** Stop the desk process, send a message, confirm the turn stays with its text and offers **Send again**; restart the desk and tap it.
2. **A failed command.** `POST /api/commands/<cid>/fail` with `{"result":"the ticker could not be resolved"}` — the turn draws the desk's own sentence.
3. **Korean.** Switch the app's language to Korean in Settings, send a message, and finish it with a Korean `notes.md`. Confirm the composer, the status line and the chip are all Korean and that nothing is clipped — `신문을 바꿨습니다` is a wider chip than `The paper changed`.

Screenshot each.

- [ ] **Step 7: Fix anything the render found, then commit**

If the screenshots show a defect, fix it here and say what it was:

```bash
git add -A
git commit -m "fix(app): what the render found on the ask screen"
```

If they show none, there is nothing to commit — attach the screenshots to the PR, which is what the rule is for.

- [ ] **Step 8: The full local suite, one last time**

```bash
cd app && npm test && npm run typecheck
```

Expected: PASS, with no skipped or `.only` tests. `sh server/test/run.sh` and `sh agent/test/run.sh` belong to the other two plans and are unaffected by this one.

---

## Self-Review

**1. Spec coverage** — every clause of §4 and every App row of §5:

| Spec clause | Task |
|---|---|
| §4 Entry: an "Ask" button in Today's header opens `/ask` | 9 |
| §4 Threads: AsyncStorage under `claudepost.threads`, turns of `{command_id, text, lang, sent_at, status, result, answer?}` | 2, 3 |
| §4 Threads: no server-side thread object; `reply_to` is the thread | 2 (`lastCommandId`), 7 (`post`) |
| §4 Sending: `postCommand`, `command`, `commandNotes`, `publishNow` | 1 |
| §4 Sending: a failed post keeps the turn with an error and a retry | 2 (`send_failed`, `retry`), 7, 8 |
| §4 Waiting: focus-gated 5 s poll on `board.tsx`'s interval while pending or claimed | 7 |
| §4 Waiting: on `done`, fetch the notes and store the answer | 7 |
| §4 `answered` — render | 4, 8 |
| §4 `revised <eid>` — render, chip, invalidate the edition cache | 5, 7, 8 |
| §4 `staged <eid>` — publish, then behave as revised; on failure say so and offer the button | 1, 2 (`published`), 7, 8 |
| §4 `failed` — render the worker's message as the turn's error | 2, 7, 8 |
| §4 Push: a response listener at app start, routing `data.command_id` to the thread | 10 |
| §4 Push: the `answer` kind in notification settings | 10 |
| §4 Rendering: markdown, and the app's own type ramp | 4 |
| §5 App: client method request shapes | 1 |
| §5 App: thread reducer transitions — pending → claimed → done with each result; failed; retry | 2 |
| §5 App: `entryRouteFor` unaffected | Global Constraints; nothing in the plan touches `onboarding/flow.ts` or the three keys, and Task 5's full-suite run is what proves it |
| §5 End to end on the simulator, screenshots in the PR | 12 |

Two spec sentences are implemented differently from their literal wording, and both are called out at the point of the change: the route is `/ask?command=<id>` rather than `?thread=<id>` (Task 10 — the push carries a command id and a thread is the phone's own grouping), and the markdown renderer is written rather than borrowed (Task 4 — there is no component to share, and `ScheduleRow` draws `reason` as plain text).

**2. Placeholder scan** — no "TBD", no "add error handling", no "similar to Task N", no test described without its code. Every step that changes code carries the code. The one step that describes an edit rather than quoting the whole of it is Task 10's step 6, inside a 1,300-line `settings.tsx`: it names the three lines to change (`:1290`, `:1307`, `:1329`), quotes the gate to wrap them in, and says what the gate is for. Quoting forty lines of an unrelated section around it would obscure the change rather than specify it.

**3. Type consistency** — checked across tasks: `Command` / `CommandStatus` / `AskBody` / `PublishOutcome` / `MAX_COMMAND_TEXT` are defined in Task 1 and used with those names in 2, 7 and 8. `Turn` / `Thread` / `ThreadEvent` / `nextThreads` / `readResult` / `isWorking` / `threadIsWorking` / `threadOfCommand` / `lastCommandId` / `newTurnId` / `MAX_THREADS` are defined in Task 2 and used with those names in 3, 7 and 8. `sanitizeThreads` / `readThreads` / `writeThreads` / `THREADS_KEY` are Task 3's and used in 7. `markEditionStale` / `takeEditionStale` are Task 5's and used in 7 (writer) and `useEdition` (reader). `parseMarkdown` / `Span` / `Block` / `Answer` are Task 4's and used in 8. `PUSH_KINDS` / `LEAD_KINDS` / `commandIdOfPush` / `askRouteForPush` / `addNotificationTapListener` are Task 10's and used in `_layout.tsx` and `settings.tsx` in the same task. `strings().ask.*` is Task 6's and every key used in 7, 8 and 9 (`sendFailed`, `publishFailed`, `failed`, `forgotten`, `status.*`, `changed`, `staged`, `publish`, `retry`, `noAnswer`, `tooLong`, `empty`, `needsDesk`, `title`, `open`, `send`, `placeholder`, `a11y.openAsk`) is defined there. `newThread` is defined in Task 6 and not yet drawn by any task — it is the thread-list affordance a second iteration would add, and is left in the catalogue deliberately rather than dropped, because `useAskThread` already returns `threads` and `open`.
