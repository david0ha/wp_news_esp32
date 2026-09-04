// The operator token for the desk, and the one thing in this app that is a secret.
//
// It lives in `expo-secure-store` — the iOS keychain and Android's EncryptedSharedPreferences —
// and deliberately NOT in `store.ts` beside everything else the app persists. AsyncStorage is a
// plain file in the app's container: fine for an address, a flag or a language, wrong for a
// credential that can rewrite what the desk publishes. The split is the whole reason this is its
// own module rather than five more lines in `store.ts`, which imports AsyncStorage at the top and
// would make "which store did that go to" a question about a function name.
//
// The rules that travel with it:
//
//   - it is never logged, never put in an error message, and never drawn back into the field it
//     was typed into (`settings.tsx` says a token is saved, and offers to replace or forget it);
//   - a keychain that will not answer reads as NO TOKEN, not as an error — the Desk section then
//     draws exactly as it does for somebody who has not pasted one yet, which is a state it
//     already knows how to show;
//   - a keychain that will not WRITE is reported, because the caller has just promised somebody
//     their token was saved and only the caller can take that back.
//
// The read is cached in memory for the session, like `store.ts`'s reads and with the same
// exception: a failed read caches nothing, so the next caller asks the keychain again instead of
// inheriting "no token" for the life of the app.

import * as SecureStore from 'expo-secure-store'

/**
 * The keychain entry's name. Exported so a test can pin the literal: renaming it is not a
 * refactor, it is every operator's token silently disappearing on the update that ships it.
 *
 * `expo-secure-store` allows only word characters, `.` and `-` in a key, so this is the one
 * `claudepost.*` name on the phone that cannot follow the AsyncStorage spelling exactly — there is
 * nothing to collide with, since it is a different store.
 */
export const DESK_TOKEN_KEY = 'claudepost.deskToken'

let cache: string | null | undefined // undefined = not read yet

/** The saved operator token, or `null` for "none saved" and for a keychain that would not answer. */
export async function getDeskToken(): Promise<string | null> {
  if (cache !== undefined) return cache
  try {
    cache = (await SecureStore.getItemAsync(DESK_TOKEN_KEY)) ?? null
  } catch {
    // Not cached: a keychain that threw has not told us anything.
    return null
  }
  return cache
}

/**
 * What became of a token somebody submitted.
 *
 * THREE ANSWERS AND NOT A BOOLEAN, because two of these are not the same kind of no and the
 * screen has to say something different about each. `refused` is the keychain declining to
 * write — the phone is locked, the store is unavailable — and it is worth telling somebody to
 * unlock and try again. `empty` is a person pressing return on a blank field, which is not a
 * failure of anything: it is the commonest way to reach this function by accident, and the
 * keychain was never asked. Collapsing them into `false`, as this once did, put "this phone's
 * keychain wouldn't store the token" under an empty box — an alarming message about a component
 * that had not been touched, for somebody who had typed nothing.
 */
export type DeskTokenSave = 'saved' | 'empty' | 'refused'

/**
 * Save a token, trimmed. Answers which of the three happened.
 *
 * A blank one is `empty` rather than stored: an empty credential is not a credential, and storing
 * it would leave the Desk section claiming a token is set while every call comes back 401. It is
 * also a no-op on whatever is already there — an accidental return must not be a way to lose the
 * token that is working, which is what `clearDeskToken` and a deliberate button are for.
 */
export async function saveDeskToken(token: string): Promise<DeskTokenSave> {
  const trimmed = token.trim()
  if (!trimmed) return 'empty'
  try {
    await SecureStore.setItemAsync(DESK_TOKEN_KEY, trimmed)
  } catch {
    return 'refused'
  }
  cache = trimmed
  return 'saved'
}

/** Forget the token. The cache goes first, so the screen agrees immediately either way. */
export async function clearDeskToken(): Promise<void> {
  cache = null
  try {
    await SecureStore.deleteItemAsync(DESK_TOKEN_KEY)
  } catch {
    // Best-effort, and the one failure here that matters is loud enough by itself: the token comes
    // back on the next launch and the section says a token is saved again.
  }
}

/** Test hook: drop the in-memory copy so a fresh read hits the (mocked) keychain. */
export function __resetDeskTokenCacheForTests(): void {
  cache = undefined
}
