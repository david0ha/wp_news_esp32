import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals'
import AsyncStorage from '@react-native-async-storage/async-storage'
import {
  __resetStoreCacheForTests,
  clearDeviceBaseUrl,
  clearSetupSkipped,
  getDeviceBaseUrl,
  isOnboardingComplete,
  isSetupSkipped,
  markOnboardingComplete,
  markSetupSkipped,
  peekDeviceBaseUrl,
  setDeviceBaseUrl,
} from './store'

beforeEach(async () => {
  await AsyncStorage.clear()
  __resetStoreCacheForTests()
})

afterEach(() => {
  // The rejecting-read cases replace AsyncStorage.getItem on the shared mock object; leaving one
  // installed would fail the next file's first read for a reason nothing in that file explains.
  jest.restoreAllMocks()
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
    expect(await clearDeviceBaseUrl()).toBe(true)
    __resetStoreCacheForTests()
    expect(await getDeviceBaseUrl()).toBeNull()
  })

  // The removal is the one write here that is not allowed to fail silently. Everything on screen
  // clears from the in-memory cache, so the whole session agrees the board is gone; if the key
  // survived on disk it comes back on the next cold launch and the user is left believing the app
  // undid a deliberate act. These two pin the reporting, not the retrying.
  //
  // They swap `removeItem` by hand rather than reaching for `jest.spyOn`, which the rejecting-*read*
  // cases below can afford and these cannot. AsyncStorage's mock is itself made of `jest.fn`s with
  // real implementations; spying on one enrols it in the mock registry, and the `afterEach`'s
  // `restoreAllMocks()` then strips that implementation — so `removeItem` silently became a no-op
  // for every later test in the file and `clearSetupSkipped` failed a hundred lines away, for a
  // reason nothing at the failing line could explain. `getItem` escapes it only by luck of ordering.
  const withRemoveItem = async (stub: typeof AsyncStorage.removeItem, body: () => Promise<void>) => {
    const original = AsyncStorage.removeItem
    AsyncStorage.removeItem = stub
    try {
      await body()
    } finally {
      AsyncStorage.removeItem = original
    }
  }

  it('reports success when a removal attempt throws but a later one lands', async () => {
    await setDeviceBaseUrl('http://1.2.3.4')
    const original = AsyncStorage.removeItem
    let calls = 0
    await withRemoveItem(
      async (key) => {
        if (++calls === 1) throw new Error('disk is having a moment')
        return original.call(AsyncStorage, key)
      },
      async () => {
        expect(await clearDeviceBaseUrl()).toBe(true)
      },
    )
    __resetStoreCacheForTests()
    expect(await getDeviceBaseUrl()).toBeNull()
  })

  it('reports failure when the removal never succeeds', async () => {
    await setDeviceBaseUrl('http://1.2.3.4')
    await withRemoveItem(
      async () => {
        throw new Error('storage is unreadable')
      },
      async () => {
        expect(await clearDeviceBaseUrl()).toBe(false)
        // The cache is cleared regardless — this session is done with that board whatever the disk
        // thinks — which is exactly why the boolean has to carry the bad news instead.
        expect(await getDeviceBaseUrl()).toBeNull()
      },
    )
  })

  it('serves the in-memory cache without re-reading disk', async () => {
    await setDeviceBaseUrl('http://5.6.7.8')
    // No cache reset: the cached value should come straight back.
    expect(await getDeviceBaseUrl()).toBe('http://5.6.7.8')
  })
})

// The three-valued read. `null` and `undefined` are two different facts here — "storage says there
// is no board" and "storage said nothing" — and everything that draws a screen from the answer
// depends on being able to tell them apart. `getDeviceBaseUrl` folds them together for the two
// callers that only want a probe candidate; these assertions are what stop somebody deciding the
// fold is harmless and deleting the distinction.
describe('peekDeviceBaseUrl tells "no board" from "no answer"', () => {
  it('answers null — a real answer — when the store is empty', async () => {
    expect(await peekDeviceBaseUrl()).toBeNull()
  })

  it('answers the saved URL when one is stored', async () => {
    await setDeviceBaseUrl('192.168.0.42')
    __resetStoreCacheForTests()
    expect(await peekDeviceBaseUrl()).toBe('http://192.168.0.42')
  })

  it('answers undefined when the read throws, then the truth on the next call', async () => {
    // This is the whole point of the function, and the regression test for DeviceProvider freezing
    // a failed read as "you have no board" for the rest of the session. The provider reads this on
    // mount and commits `hasDevice` from it exactly once, so the first value has to be honest about
    // being no value at all, and the retry it then makes has to reach the disk.
    await setDeviceBaseUrl('http://1.2.3.4')
    __resetStoreCacheForTests()
    jest.spyOn(AsyncStorage, 'getItem').mockRejectedValueOnce(new Error('disk is having a moment'))

    expect(await peekDeviceBaseUrl()).toBeUndefined()
    expect(await peekDeviceBaseUrl()).toBe('http://1.2.3.4')
  })

  it('answers undefined for a failed read even when the store really is empty', async () => {
    // The failure case that looks identical through `getDeviceBaseUrl`: nothing is saved, so the
    // honest answer and the wrong one are both "no board". They must still differ here, because a
    // caller that stops retrying at the first null gets the right answer by luck this time and the
    // wrong one on the phone that owns a board.
    jest.spyOn(AsyncStorage, 'getItem').mockRejectedValueOnce(new Error('disk is having a moment'))

    expect(await peekDeviceBaseUrl()).toBeUndefined()
    expect(await peekDeviceBaseUrl()).toBeNull()
  })

  it('serves a cached null without re-reading disk', async () => {
    // A cached "nothing is saved" is a definite answer and must come straight back rather than
    // reading as unread — otherwise every boardless launch would retry a disk that already spoke.
    expect(await peekDeviceBaseUrl()).toBeNull()
    // The library's mock is one shared jest.fn for the whole file, so its call log already carries
    // every read the earlier cases made; clear it and count only what this assertion is about.
    const spy = jest.spyOn(AsyncStorage, 'getItem')
    spy.mockClear()
    expect(await peekDeviceBaseUrl()).toBeNull()
    expect(spy).not.toHaveBeenCalled()
  })

  it('getDeviceBaseUrl folds both no-answers to null', async () => {
    // The two callers left on the lossy read — board.retry() and settings.reconnect() — hand the
    // result to discoverDevice as one candidate among several, so this fold has to keep working
    // exactly as it did.
    jest.spyOn(AsyncStorage, 'getItem').mockRejectedValueOnce(new Error('disk is having a moment'))
    expect(await getDeviceBaseUrl()).toBeNull()
    expect(await getDeviceBaseUrl()).toBeNull()
  })
})

describe('onboarding flag', () => {
  it('is false until marked complete', async () => {
    expect(await isOnboardingComplete()).toBe(false)
  })

  it('persists complete and reads it back across a cache reset', async () => {
    await markOnboardingComplete()
    __resetStoreCacheForTests()
    expect(await isOnboardingComplete()).toBe(true)
  })

  it('reads the skip mark as not-onboarded', async () => {
    // The two flags are different facts stored under different keys; a '1' is the skip mark and
    // must never be mistaken for "the wizard finished".
    await AsyncStorage.setItem('claudepost.onboardingComplete', '1')
    expect(await isOnboardingComplete()).toBe(false)
  })
})

describe('setup-skipped flag', () => {
  it('is false until the skip is marked', async () => {
    expect(await isSetupSkipped()).toBe(false)
  })

  it('persists the skip and reads it back across a cache reset', async () => {
    await markSetupSkipped()
    __resetStoreCacheForTests()
    expect(await isSetupSkipped()).toBe(true)
  })

  it('clearSetupSkipped restores false', async () => {
    await markSetupSkipped()
    await clearSetupSkipped()
    __resetStoreCacheForTests()
    expect(await isSetupSkipped()).toBe(false)
  })

  // Strict mark: only the exact '1'. Anything else — a hand-edited store, a value written by some
  // future format, the empty string a failed write can leave behind — reads as not skipped, which
  // asks the question again. That is the cheap direction to be wrong in: one extra tap, versus
  // silently walling somebody past a wizard they never chose to leave.
  it.each(['yes', 'true', '', '0', ' 1'])('does not treat %p as the skip mark', async (stored) => {
    await AsyncStorage.setItem('claudepost.setupSkipped', stored)
    expect(await isSetupSkipped()).toBe(false)
  })

  it('serves the in-memory cache without re-reading disk', async () => {
    await markSetupSkipped()
    // markSetupSkipped sets the cache before it awaits the write, so a caller that navigates
    // straight to the next screen cannot be handed the pre-skip answer.
    expect(await isSetupSkipped()).toBe(true)
  })
})

// These three literals are the app's contract with every phone that already has it installed.
// Renaming one is not a refactor: the app would come up unable to find the board it configured
// and unable to remember the wizard was ever finished, silently re-onboarding every shipped
// install. If one of these assertions fails, the fix is to put the old string back.
describe('persisted key strings', () => {
  it('writes the base URL under claudepost.deviceBaseUrl', async () => {
    await setDeviceBaseUrl('http://1.2.3.4')
    expect(await AsyncStorage.getItem('claudepost.deviceBaseUrl')).toBe('http://1.2.3.4')
  })

  it('writes the onboarding flag under claudepost.onboardingComplete', async () => {
    await markOnboardingComplete()
    expect(await AsyncStorage.getItem('claudepost.onboardingComplete')).toBe('true')
  })

  it('writes the skip mark under claudepost.setupSkipped', async () => {
    await markSetupSkipped()
    expect(await AsyncStorage.getItem('claudepost.setupSkipped')).toBe('1')
  })
})

// A read that throws is not an answer. Caching one as a definite "no" would turn a single storage
// hiccup during the splash into a whole session of "you have no board and never onboarded" — the
// app would route a real owner to the wizard and there would be nothing on screen to explain it.
// Each of these asserts the second call goes back to disk and gets the truth.
describe('a failed read is never cached', () => {
  it('getDeviceBaseUrl retries after a rejecting read', async () => {
    await setDeviceBaseUrl('http://1.2.3.4')
    __resetStoreCacheForTests()
    jest.spyOn(AsyncStorage, 'getItem').mockRejectedValueOnce(new Error('disk is having a moment'))

    expect(await getDeviceBaseUrl()).toBeNull()
    expect(await getDeviceBaseUrl()).toBe('http://1.2.3.4')
  })

  it('isOnboardingComplete retries after a rejecting read', async () => {
    await markOnboardingComplete()
    __resetStoreCacheForTests()
    jest.spyOn(AsyncStorage, 'getItem').mockRejectedValueOnce(new Error('disk is having a moment'))

    expect(await isOnboardingComplete()).toBe(false)
    expect(await isOnboardingComplete()).toBe(true)
  })

  it('isSetupSkipped retries after a rejecting read', async () => {
    await markSetupSkipped()
    __resetStoreCacheForTests()
    jest.spyOn(AsyncStorage, 'getItem').mockRejectedValueOnce(new Error('disk is having a moment'))

    expect(await isSetupSkipped()).toBe(false)
    expect(await isSetupSkipped()).toBe(true)
  })
})
