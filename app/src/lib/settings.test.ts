import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals'
import AsyncStorage from '@react-native-async-storage/async-storage'
import * as SecureStore from 'expo-secure-store'
import {
  __resetSettingsCacheForTests,
  clearDeskToken,
  deskTestResultLine,
  getDeskSettings,
  getDeskToken,
  getDeskUrl,
  hasDeskToken,
  setDeskToken,
  setDeskUrl,
  validateDeskUrl,
} from './settings'

// Mirrors settings.ts's own private keys — not exported, since a test that hardcodes them the
// same way the source does is the point (it proves the persisted key name, not just the round trip).
const KEY_DESK_URL = 'claudepost.deskUrl'
const KEY_DESK_TOKEN = 'claudepost.deskToken'

beforeEach(async () => {
  await AsyncStorage.clear()
  await SecureStore.deleteItemAsync(KEY_DESK_TOKEN)
  __resetSettingsCacheForTests()
  delete process.env.EXPO_PUBLIC_DESK_BASE_URL
  delete process.env.EXPO_PUBLIC_DESK_TOKEN
})

afterEach(() => {
  delete process.env.EXPO_PUBLIC_DESK_BASE_URL
  delete process.env.EXPO_PUBLIC_DESK_TOKEN
})

describe('desk URL', () => {
  it('returns null when nothing is stored', async () => {
    expect(await getDeskUrl()).toBeNull()
  })

  it('normalizes an https address and persists it', async () => {
    const result = await setDeskUrl('https://Desk.Example.com/')
    expect(result).toEqual({ ok: true })
    __resetSettingsCacheForTests()
    expect(await getDeskUrl()).toBe('https://desk.example.com')
  })

  it('stores the normalized value under the documented AsyncStorage key', async () => {
    await setDeskUrl('https://desk.example.com')
    expect(await AsyncStorage.getItem(KEY_DESK_URL)).toBe('https://desk.example.com')
  })

  describe('the ATS rule', () => {
    it.each([
      ['a .local host', 'claudepost.local'],
      ['localhost', 'localhost'],
      ['127.0.0.1', '127.0.0.1'],
      ['a 10.x address', '10.1.2.3'],
      ['a 192.168.x address', '192.168.1.50'],
      ['the low end of 172.16/12', '172.16.0.1'],
      ['the high end of 172.16/12', '172.31.255.255'],
    ])('accepts plain http:// for %s', async (_label, host) => {
      const result = await setDeskUrl(`http://${host}:8080`)
      expect(result).toEqual({ ok: true })
      __resetSettingsCacheForTests()
      expect(await getDeskUrl()).toBe(`http://${host}:8080`)
    })

    it.each([
      ['a public domain', 'desk.example.com'],
      ['just outside 172.16/12 (below)', '172.15.0.1'],
      ['just outside 172.16/12 (above)', '172.32.0.1'],
      ['a 192.169 address (not 192.168)', '192.169.1.50'],
      ['an 11.x address (not 10.x)', '11.0.0.1'],
    ])('refuses plain http:// for %s with the ATS sentence', async (_label, host) => {
      const result = await setDeskUrl(`http://${host}`)
      expect(result.ok).toBe(false)
      expect(result.error).toMatch(/https:\/\//)
      // A refused address must not get persisted, or the app would silently start pointing at it.
      __resetSettingsCacheForTests()
      expect(await getDeskUrl()).toBeNull()
    })

    it('accepts https:// for a public domain', async () => {
      const result = await setDeskUrl('https://desk.example.com')
      expect(result).toEqual({ ok: true })
    })
  })

  it('rejects a URL with embedded credentials', async () => {
    const result = await setDeskUrl('https://user:pw@desk.example.com')
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/username and password/)
    __resetSettingsCacheForTests()
    expect(await getDeskUrl()).toBeNull()
  })

  it('rejects malformed input and leaves any previous value alone', async () => {
    await setDeskUrl('https://desk.example.com')
    const result = await setDeskUrl('not a url')
    expect(result.ok).toBe(false)
    __resetSettingsCacheForTests()
    expect(await getDeskUrl()).toBe('https://desk.example.com')
  })

  it('rejects an empty address', async () => {
    const result = await setDeskUrl('')
    expect(result.ok).toBe(false)
  })
})

describe('validateDeskUrl', () => {
  it('normalizes and returns the value WITHOUT persisting it', async () => {
    const result = validateDeskUrl('https://Desk.Example.com/')
    expect(result).toEqual({ ok: true, value: 'https://desk.example.com' })
    expect(await getDeskUrl()).toBeNull()
  })

  it('applies the ATS rule, same as setDeskUrl', () => {
    const result = validateDeskUrl('http://desk.example.com')
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/https:\/\//)
  })

  it('accepts plain http:// on the LAN, same as setDeskUrl', () => {
    expect(validateDeskUrl('http://192.168.1.10')).toEqual({
      ok: true,
      value: 'http://192.168.1.10',
    })
  })
})

describe('desk token', () => {
  it('returns null when nothing is stored', async () => {
    expect(await getDeskToken()).toBeNull()
  })

  it('persists a token and reads it back', async () => {
    await setDeskToken('secret-token')
    __resetSettingsCacheForTests()
    expect(await getDeskToken()).toBe('secret-token')
  })

  it('stores the token under the documented SecureStore key', async () => {
    await setDeskToken('secret-token')
    expect(await SecureStore.getItemAsync(KEY_DESK_TOKEN)).toBe('secret-token')
  })

  it('setting an empty token clears it', async () => {
    await setDeskToken('secret-token')
    await setDeskToken('')
    __resetSettingsCacheForTests()
    expect(await getDeskToken()).toBeNull()
    expect(await SecureStore.getItemAsync(KEY_DESK_TOKEN)).toBeNull()
  })

  it('clearDeskToken removes a stored token', async () => {
    await setDeskToken('secret-token')
    await clearDeskToken()
    __resetSettingsCacheForTests()
    expect(await getDeskToken()).toBeNull()
  })

  it('a SecureStore read failure (locked device) returns null and never throws', async () => {
    ;(SecureStore.getItemAsync as jest.MockedFunction<typeof SecureStore.getItemAsync>).mockRejectedValueOnce(
      new Error('locked'),
    )
    await expect(getDeskToken()).resolves.toBeNull()
  })
})

describe('hasDeskToken', () => {
  it('is false when nothing is stored', async () => {
    expect(await hasDeskToken()).toBe(false)
  })

  it('is true once a token is saved, without exposing it', async () => {
    await setDeskToken('secret-token')
    __resetSettingsCacheForTests()
    expect(await hasDeskToken()).toBe(true)
  })

  it('is false again once the token is cleared', async () => {
    await setDeskToken('secret-token')
    await clearDeskToken()
    __resetSettingsCacheForTests()
    expect(await hasDeskToken()).toBe(false)
  })
})

describe('deskTestResultLine', () => {
  it('names the current edition, shortened to eight characters', () => {
    expect(deskTestResultLine({ current: 'a1b2c3d4e5f6' })).toBe(
      'Connected — current edition a1b2c3d4.',
    )
  })

  it('says nothing published yet when there is none', () => {
    expect(deskTestResultLine({ current: null })).toBe('Connected — nothing published yet.')
  })
})

describe('env overrides', () => {
  it('EXPO_PUBLIC_DESK_BASE_URL wins over a stored desk URL', async () => {
    await setDeskUrl('https://stored.example.com')
    __resetSettingsCacheForTests()
    process.env.EXPO_PUBLIC_DESK_BASE_URL = 'https://dev.example.com'
    expect(await getDeskUrl()).toBe('https://dev.example.com')
  })

  it('EXPO_PUBLIC_DESK_TOKEN wins over a stored token', async () => {
    await setDeskToken('stored-token')
    __resetSettingsCacheForTests()
    process.env.EXPO_PUBLIC_DESK_TOKEN = 'dev-token'
    expect(await getDeskToken()).toBe('dev-token')
  })
})

describe('getDeskSettings', () => {
  it('combines the stored URL and token', async () => {
    await setDeskUrl('https://desk.example.com')
    await setDeskToken('secret-token')
    __resetSettingsCacheForTests()
    expect(await getDeskSettings()).toEqual({
      baseUrl: 'https://desk.example.com',
      token: 'secret-token',
    })
  })

  it('reports both as null when nothing is configured', async () => {
    expect(await getDeskSettings()).toEqual({ baseUrl: null, token: null })
  })
})
