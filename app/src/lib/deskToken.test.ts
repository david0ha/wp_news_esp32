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
    expect(await saveDeskToken('  operator-token  ')).toBe(true)
    __resetDeskTokenCacheForTests()
    expect(await getDeskToken()).toBe('operator-token')
    // The key it is filed under, pinned: an install that renames it silently forgets the token
    // and the operator gets an unauthorized they cannot explain.
    expect(await SecureStore.getItemAsync(DESK_TOKEN_KEY)).toBe('operator-token')
  })

  it('refuses to save an empty token instead of storing a blank secret', async () => {
    expect(await saveDeskToken('   ')).toBe(false)
    expect(await getDeskToken()).toBeNull()
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
    expect(await saveDeskToken('operator-token')).toBe(false)
  })
})
