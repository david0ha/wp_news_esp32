// Standing rules — what the phone may say about one it has just removed.

import type { Directive } from './desk'

/**
 * Whether putting this removed rule back would actually put anything back.
 *
 * The undo in `<DirectiveList>` re-files a removed rule through `addDirective`, which is a real
 * create rather than a resurrection — so it is only an undo where the desk will both accept the
 * rule AND show it again afterwards. Three cases fail that, and every one of them fails SILENTLY,
 * which is why they are refused here rather than discovered by pressing the button:
 *
 *   1. An `until` rule whose instant has passed. `store.py`'s `list_directives` selects
 *      `expires_at IS NULL OR expires_at > now`, while `add_directive` validates only the SHAPE of
 *      `expires_at` and never that it is in the future. Re-filing it is a 200 that writes a row the
 *      list will never return — a button that reports success and changes nothing on screen.
 *   2. An `until` rule carrying no instant at all. `add_directive` refuses it outright, and
 *      re-filing it as `always` instead would quietly turn a rule that was meant to end into one
 *      that never does. Neither of those is an undo.
 *   3. `now` not yet known — `useDeskNow()` answers 0 until `/api/state` lands, and comparing an
 *      expiry against the epoch would call every past rule restorable, which is case 1 again.
 *
 * `now` is the DESK's clock: the expiry it is compared against is the desk's own field, and the
 * desk is the thing that will do the filtering.
 */
export function canRestoreDirective(directive: Directive, nowSec: number): boolean {
  if (!Number.isFinite(nowSec) || nowSec <= 0) return false
  if (directive.scope !== 'until') return true
  if (directive.expires_at === null) return false
  // `>` and not `>=`, matching the desk's own `expires_at > ?` exactly: a rule expiring at this
  // very second is one the next `list_directives` will already have dropped.
  return directive.expires_at > nowSec
}
