import { describe, it, expect, beforeEach } from '@jest/globals'
import AsyncStorage from '@react-native-async-storage/async-storage'
import {
  __resetStoreCacheForTests,
  clearDeviceBaseUrl,
  getDeviceBaseUrl,
  setDeviceBaseUrl,
} from './store'

beforeEach(async () => {
  await AsyncStorage.clear()
  __resetStoreCacheForTests()
})

describe('device base URL', () => {
  it('returns null when nothing is stored', async () => {
    expect(await getDeviceBaseUrl()).toBeNull()
  })

  it('normalizes before persisting and reads it back', async () => {
    expect(await setDeviceBaseUrl('192.168.0.42')).toBe(true)
    __resetStoreCacheForTests()
    expect(await getDeviceBaseUrl()).toBe('http://192.168.0.42')
  })

  it('rejects an invalid URL and stores nothing', async () => {
    expect(await setDeviceBaseUrl('not a url')).toBe(false)
    __resetStoreCacheForTests()
    expect(await getDeviceBaseUrl()).toBeNull()
  })

  it('clears a stored URL', async () => {
    await setDeviceBaseUrl('http://1.2.3.4')
    await clearDeviceBaseUrl()
    __resetStoreCacheForTests()
    expect(await getDeviceBaseUrl()).toBeNull()
  })

  it('serves the in-memory cache without re-reading disk', async () => {
    await setDeviceBaseUrl('http://5.6.7.8')
    // No cache reset: the cached value should come straight back.
    expect(await getDeviceBaseUrl()).toBe('http://5.6.7.8')
  })
})

describe('the pre-redesign onboarding key', () => {
  // There is no launch gate any more: the app opens on Today and pairing lives under Settings.
  // An upgraded phone still carries `claudepost.onboardingComplete` from the old build; this
  // module must neither read it nor write it, and must go on honouring the base URL beside it.
  it('is never written, and never blocks the stored base URL', async () => {
    await AsyncStorage.setItem('claudepost.onboardingComplete', 'true')
    await setDeviceBaseUrl('http://192.168.0.42')
    __resetStoreCacheForTests()

    expect(await getDeviceBaseUrl()).toBe('http://192.168.0.42')
    // Left exactly as the old build wrote it — untouched, not cleaned up.
    expect(await AsyncStorage.getItem('claudepost.onboardingComplete')).toBe('true')
    await clearDeviceBaseUrl()
    expect(await AsyncStorage.getItem('claudepost.onboardingComplete')).toBe('true')
  })
})
