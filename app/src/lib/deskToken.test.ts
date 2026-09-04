import { describe, it, expect, beforeEach, jest } from '@jest/globals'
import * as SecureStore from 'expo-secure-store'
import {
  __resetDeskTokenCacheForTests,
  clearDeskToken,
  DESK_TOKEN_KEY,
  getDeskToken,
  saveDeskToken,
} from './deskToken'

beforeEach(async () => {
  jest.restoreAllMocks()
  await SecureStore.deleteItemAsync(DESK_TOKEN_KEY)
  __resetDeskTokenCacheForTests()
})

describe('the operator token', () => {
  it('is null when none has been saved', async () => {
    expect(await getDeskToken()).toBeNull()
  })

  it('round-trips through the keychain and nowhere else', async () => {
    expect(await saveDeskToken('  operator-token  ')).toBe('saved')
    __resetDeskTokenCacheForTests()
    expect(await getDeskToken()).toBe('operator-token')
    // The key it is filed under, pinned: an install that renames it silently forgets the token
    // and the operator gets an unauthorized they cannot explain.
    expect(await SecureStore.getItemAsync(DESK_TOKEN_KEY)).toBe('operator-token')
  })

  it('refuses to save an empty token instead of storing a blank secret', async () => {
    expect(await saveDeskToken('   ')).toBe('empty')
    expect(await getDeskToken()).toBeNull()
  })

  it('tells an empty field apart from a keychain that said no', async () => {
    // They are one word to a boolean and two different things to the person looking at the
    // screen. The field submits on return, so a blank submit is the commonest way into this
    // function — and it used to answer "this phone's keychain wouldn't store the token", which
    // is an alarming sentence about a component that was never asked.
    const setItem = jest.spyOn(SecureStore, 'setItemAsync')
    expect(await saveDeskToken('')).toBe('empty')
    expect(setItem).not.toHaveBeenCalled()
  })

  it('leaves a saved token alone when the field comes in empty', async () => {
    // Forgetting a token is a button of its own. An accidental return on an empty box must not
    // be a second, silent way to lose the credential that is working.
    await saveDeskToken('operator-token')
    expect(await saveDeskToken('   ')).toBe('empty')
    __resetDeskTokenCacheForTests()
    expect(await getDeskToken()).toBe('operator-token')
  })

  it('forgets a saved token', async () => {
    await saveDeskToken('operator-token')
    await clearDeskToken()
    expect(await getDeskToken()).toBeNull()
  })

  it('reads a keychain that throws as no token rather than crashing the screen', async () => {
    // A locked or unavailable keychain is not "the token is wrong" — the Desk section simply
    // draws as though nothing were saved, which is a state it already knows how to show.
    jest.spyOn(SecureStore, 'getItemAsync').mockRejectedValueOnce(new Error('keychain unavailable'))
    expect(await getDeskToken()).toBeNull()
  })

  it('does not remember a failed read, so the next caller asks again', async () => {
    await saveDeskToken('operator-token')
    __resetDeskTokenCacheForTests()
    jest.spyOn(SecureStore, 'getItemAsync').mockRejectedValueOnce(new Error('keychain unavailable'))
    expect(await getDeskToken()).toBeNull()
    expect(await getDeskToken()).toBe('operator-token')
  })

  it('reports a write the keychain refused, because only the caller can say so', async () => {
    jest.spyOn(SecureStore, 'setItemAsync').mockRejectedValueOnce(new Error('keychain unavailable'))
    expect(await saveDeskToken('operator-token')).toBe('refused')
  })
})
