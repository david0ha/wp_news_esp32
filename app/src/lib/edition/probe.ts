// Ask the address itself, at the moment it is saved.
//
// WHY THIS EXISTS. Saving an edition address used to be a conversation with the BOARD and only
// the board: the screen POSTed the address to the hardware and every sentence it could say was
// about hardware — took it, asleep, busy, not connected. None of them said the one thing the
// person typing an address actually wants to know, which is whether there is an edition at the
// other end of it. So a typo, a desk that was down, a host that does not resolve and a perfectly
// good address all ended in the same confirmation, and the only way to find out which had
// happened was to switch to Today and read the date on the page.
//
// The phone is the desk's reader now — the Today tab fetches this same URL, unauthenticated, and
// a phone that has never seen a board still uses it. So the save asks it, once, with the reader's
// own client and the reader's own deadline: whatever this probe says is exactly what Today will
// find a second later, which is the only reason the sentence is worth printing.
//
// It never throws. A probe is a question, and "it did not answer" is one of the answers.

import { editionClient, humanEditionError, type EditionClient } from './client'

export type DeskProbe =
  /** The address answered with an edition. `subject` and `dateline` may be empty strings. */
  | { status: 'ok'; subject: string; dateline: string }
  /** It did not, and this is the reader's own sentence for why (`humanEditionError`). */
  | { status: 'failed'; message: string }
  /**
   * Nothing was asked. The one address that cannot be probed is the empty one, which is not an
   * address at all but the instruction to show the bundled demo — and it is a valid, supported
   * setting, so its answer is "not applicable" rather than a failure.
   */
  | { status: 'skipped' }

/**
 * Fetch the address unconditionally — no `If-None-Match`, because a 304 confirms a cache this
 * function does not have and would answer a question nobody asked here.
 *
 * The client is a parameter so a test can hand it a fake; every caller in the app takes the
 * default, which is the same singleton the Today tab reads through.
 */
export async function probeEdition(
  url: string,
  client: Pick<EditionClient, 'fetch'> = editionClient,
): Promise<DeskProbe> {
  if (url.trim() === '') return { status: 'skipped' }
  try {
    const result = await client.fetch(url, null)
    if (result.status !== 'ok') {
      // Unreachable in practice — an unconditional GET is never answered with a 304 this client
      // will honour (`client.ts`) — but a `not_modified` here would carry no edition to describe,
      // and inventing one is worse than saying the address answered and nothing more.
      return { status: 'ok', subject: '', dateline: '' }
    }
    const s = result.edition.subject
    return {
      status: 'ok',
      subject: s.name !== '' ? s.name : s.symbol,
      dateline: result.edition.dateline,
    }
  } catch (e) {
    return { status: 'failed', message: humanEditionError(e) }
  }
}
