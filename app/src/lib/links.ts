// Opening a markdown link's href — `<Markdown>`'s `link` span carries one wherever the desk's own
// markdown (a dossier, a thesis note, a `notes.md`) points somewhere else, and Task 30 is where
// that stops being inert: the dossier is where the worker's source URLs live, which was the whole
// point of filing them.

/** Whatever actually opens a URL — RN's own `Linking.openURL` in production. */
export type UrlOpener = (url: string) => Promise<unknown>

/**
 * Open a markdown link's href through the system, swallowing whatever the opener rejects with.
 *
 * A bad or unsupported URL — a bare `example.com` with no scheme, a `mailto:` with nothing to
 * handle it — must not crash the tap that opened it; `Linking.openURL` rejects for exactly that
 * case, and the tap is not a place a reader expects an error screen over.
 *
 * `open` is injectable the way `desk.ts`'s `fetchImpl` is, defaulting to nothing here on purpose:
 * the caller (`<Markdown>`) binds RN's `Linking.openURL` at the call site, which keeps this module
 * free of a React Native import and testable without ever touching the native module.
 */
export async function openMdLink(url: string, open: UrlOpener): Promise<boolean> {
  const trimmed = url.trim()
  if (trimmed === '') return false
  try {
    await open(trimmed)
    return true
  } catch {
    return false
  }
}
