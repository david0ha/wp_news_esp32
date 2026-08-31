// How one row of the desk's queue reads — plan Design > Wireframes ("· research AAPL ✕", "· file
// edition ⟳ ⇢"). Pure, so the glyph a status takes and the question of whether it can be cancelled
// are settled by a test rather than by a chain of ternaries inside a list.

import type { CommandStatus } from './desk'
import type { Tone } from './format'

/**
 * The wire's own kind, opened out for reading — `file_edition` → "file edition".
 *
 * NOT a lookup table of the three kinds this app files. `kind` is free-form on the desk
 * (`postCommand` defaults it to 'custom' and sends whatever it is given), so a worker or a script
 * can put a kind here that the phone has never heard of, and a table would render that row as
 * nothing at all. Opening out the underscores is the whole transformation: the row names what the
 * desk actually holds, which is desk.ts's naming rule applied to a label instead of a field.
 */
export function commandKindLabel(kind: string): string {
  const trimmed = kind.trim()
  if (trimmed === '') return 'command'
  return trimmed.replace(/_/g, ' ')
}

/** A glyph, a word and a tone for one queue row's state. */
export interface CommandStatusMark {
  glyph: string
  word: string
  tone: Tone | 'dim'
}

/**
 * What a status looks like in the queue.
 *
 * Two decisions are load-bearing. **The failed glyph is `!`, not `✗`**, because every cancellable
 * row carries a `✕` button a few points to its right and a mark one stroke away from it would read
 * as "this one was cancelled" — two different facts, and the reader has no way to tell which they
 * are looking at. **`done` is green and `failed` is red** because that is already how this app
 * colours an outcome (`format.ts`'s `fetchResultTone`), and the three that are merely over —
 * expired, cancelled, and a status this app cannot read — are grey rather than red: nothing went
 * wrong in any of them, they simply are not going to happen.
 */
export function commandStatus(status: CommandStatus): CommandStatusMark {
  switch (status) {
    case 'pending':
      return { glyph: '○', word: 'pending', tone: 'neutral' }
    case 'claimed':
      return { glyph: '⟳', word: 'claimed', tone: 'neutral' }
    case 'done':
      return { glyph: '✓', word: 'done', tone: 'up' }
    case 'failed':
      return { glyph: '!', word: 'failed', tone: 'down' }
    case 'expired':
      return { glyph: '⊘', word: 'expired', tone: 'dim' }
    case 'cancelled':
      return { glyph: '–', word: 'cancelled', tone: 'dim' }
    default:
      return { glyph: '?', word: 'unknown', tone: 'dim' }
  }
}

/**
 * Whether the desk will take a cancel for this row.
 *
 * `pending` and nothing else — `store.py`'s `cancel_command()` names it in the UPDATE's WHERE
 * clause. A claimed command belongs to the worker that claimed it: marking it cancelled here would
 * not stop that worker, it would only lose track of what it is doing. So the ✕ is not drawn at all
 * on a claimed row rather than drawn and answered with a 404.
 */
export function canCancelCommand(status: CommandStatus): boolean {
  return status === 'pending'
}
