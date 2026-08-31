// Opening a markdown link's href — `<Markdown>`'s `link` span carries one wherever the desk's own
// markdown (a dossier, a thesis note, a `notes.md`) points somewhere else, and Task 30 is where
// that stops being inert: the dossier is where the worker's source URLs live, which was the whole
// point of filing them.

/** Whatever actually opens a URL — RN's own `Linking.openURL` in production. */
export type UrlOpener = (url: string) => Promise<unknown>

/**
 * The three schemes a filed source URL can legitimately be, and no others.
 *
 * The href is not ours. `notes.md` and a watchlist thesis are written by the worker agent, which is
 * an LLM doing off-board web research — so a URL copied out of a hostile page, or a page that talks
 * the worker into filing one, reaches this function unmodified. `Linking.openURL` is a system-level
 * sink: the two mobile OSes refuse `javascript:`/`data:`/`file:` themselves, but they will happily
 * hand `tel:`, `sms:`, `itms-apps://` or any installed app's custom scheme to whatever registered
 * it. None of those is a thing a dossier's source link has any business being, so the allowlist is
 * what the href is *for* rather than what it merely might be.
 *
 * It cannot fix the other half — `https://` is exactly what a phishing link uses, and the reader
 * never sees the host behind the link text. That is a display problem for `<Markdown>`, not one an
 * allowlist can close here.
 */
const ALLOWED_SCHEMES = new Set(['http', 'https', 'mailto'])

/**
 * RFC 3986 §3.1: `scheme = ALPHA *( ALPHA / DIGIT / "+" / "-" / "." )`, anchored, up to the colon.
 *
 * Deliberately NOT `new URL()`. React Native ships its own partial `URL`, which does not parse the
 * way the WHATWG one does — `protocol` is not something this module can rely on across the runtime
 * it actually runs in and the Node one it is tested in. A regex over the grammar is the same answer
 * on both, and keeps this module free of a runtime it does not import.
 */
const SCHEME = /^([A-Za-z][A-Za-z0-9+.-]*):/

/**
 * Open a markdown link's href through the system, swallowing whatever the opener rejects with.
 *
 * A bad or unsupported URL — a bare `example.com` with no scheme, a `mailto:` with nothing to
 * handle it — must not crash the tap that opened it; `Linking.openURL` rejects for exactly that
 * case, and the tap is not a place a reader expects an error screen over.
 *
 * A dropped scheme is silent for the same reason: there is nothing for the reader to do about a
 * link the desk filed wrong, and a tap on a word in a paragraph is not a place to explain URI
 * schemes. `false` comes back either way, which is what the caller already handles.
 *
 * `open` is injectable the way `desk.ts`'s `fetchImpl` is, defaulting to nothing here on purpose:
 * the caller (`<Markdown>`) binds RN's `Linking.openURL` at the call site, which keeps this module
 * free of a React Native import and testable without ever touching the native module.
 */
export async function openMdLink(url: string, open: UrlOpener): Promise<boolean> {
  const trimmed = url.trim()
  if (trimmed === '') return false

  // Fails closed on a schemeless href too: `example.com/wiki` has no scheme to allow, and handing
  // it to the opener only earns a rejection a beat later.
  const scheme = SCHEME.exec(trimmed)?.[1]
  if (scheme === undefined || !ALLOWED_SCHEMES.has(scheme.toLowerCase())) return false

  try {
    await open(trimmed)
    return true
  } catch {
    return false
  }
}
