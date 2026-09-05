import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals'
import AsyncStorage from '@react-native-async-storage/async-storage'
import {
  __resetStoreCacheForTests,
  clearDeviceBaseUrl,
  clearNewsUrl,
  clearNewsUrlPending,
  clearSetupSkipped,
  deskScheme,
  getDeskBaseUrl,
  getDeviceBaseUrl,
  getLanguage,
  getNewsUrl,
  isNewsUrlPending,
  isOnboardingComplete,
  isSetupSkipped,
  markOnboardingComplete,
  markSetupSkipped,
  peekDeviceBaseUrl,
  peekNewsUrl,
  saveDeskBaseUrl,
  saveLanguage,
  saveNewsUrl,
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

// The phone's copy of the edition address, and the mark that says the board has not got it yet.
// The address is a setting on the phone now precisely so it can be changed while the board is
// asleep, so the pair has to survive a relaunch together: an address without its mark is one the
// app believes delivered and never sends.
describe('news URL on the phone', () => {
  it('is null until something is saved', async () => {
    expect(await getNewsUrl()).toBeNull()
    expect(await isNewsUrlPending()).toBe(false)
  })

  it('saves the address and marks it pending in one act', async () => {
    await saveNewsUrl('https://desk.example/news.json')
    __resetStoreCacheForTests()
    expect(await getNewsUrl()).toBe('https://desk.example/news.json')
    expect(await isNewsUrlPending()).toBe(true)
  })

  it('keeps the empty string as a saved value, distinct from nothing saved', async () => {
    // Clearing the field and saving puts the board on its demo edition. That is a deliberate act
    // and it has to be delivered like any other, so '' must not collapse into "never saved".
    await saveNewsUrl('')
    __resetStoreCacheForTests()
    expect(await getNewsUrl()).toBe('')
    expect(await isNewsUrlPending()).toBe(true)
  })

  it('clearNewsUrlPending leaves the address and drops the mark', async () => {
    await saveNewsUrl('https://desk.example/news.json')
    await clearNewsUrlPending()
    __resetStoreCacheForTests()
    expect(await getNewsUrl()).toBe('https://desk.example/news.json')
    expect(await isNewsUrlPending()).toBe(false)
  })

  it('a later save re-arms the mark', async () => {
    await saveNewsUrl('https://one.example/news.json')
    await clearNewsUrlPending()
    await saveNewsUrl('https://two.example/news.json')
    __resetStoreCacheForTests()
    expect(await getNewsUrl()).toBe('https://two.example/news.json')
    expect(await isNewsUrlPending()).toBe(true)
  })

  it('answers pending from the cache before the write lands', async () => {
    // The caller's next act is to POST and then read the mark back; it must see this save.
    const p = saveNewsUrl('https://desk.example/news.json')
    expect(await isNewsUrlPending()).toBe(true)
    await p
  })

  // Strict mark, same shape as the skip mark. Only the exact '1' means pending; anything else —
  // a hand-edited store, a value from some future format, the empty string a failed write can
  // leave — reads as delivered. The save path is the only writer of the '1', so an address it
  // wrote always has a legible mark beside it, and the strictness only ever bites a value the app
  // did not write itself.
  it.each(['yes', 'true', '', '0', ' 1'])('does not treat %p as the pending mark', async (stored) => {
    await AsyncStorage.setItem('claudepost.newsUrlPending', stored)
    expect(await isNewsUrlPending()).toBe(false)
  })
})

// These literals are the app's contract with every phone that already has it installed.
// Renaming one is not a refactor: the app would come up unable to find the board it configured
// and unable to remember the wizard was ever finished, silently re-onboarding every shipped
// install. If one of these assertions fails, the fix is to put the old string back.
describe('persisted key strings', () => {
  it('writes the news URL under claudepost.newsUrl and its mark under claudepost.newsUrlPending', async () => {
    // JSON-encoded, quotes and all — see `encodeNewsUrl` for why the empty address needs it.
    await saveNewsUrl('https://desk.example/news.json')
    expect(await AsyncStorage.getItem('claudepost.newsUrl')).toBe('"https://desk.example/news.json"')
    expect(await AsyncStorage.getItem('claudepost.newsUrlPending')).toBe('1')
  })

  it('reads a value it did not write as nothing saved', async () => {
    await AsyncStorage.setItem('claudepost.newsUrl', 'https://desk.example/news.json')
    expect(await getNewsUrl()).toBeNull()
    // ...and that is a real answer, not a failed read: the delivery drops an orphaned mark on it.
    expect(await peekNewsUrl()).toBeNull()
  })

  it('peekNewsUrl tells "no address" from "no answer"', async () => {
    await saveNewsUrl('https://desk.example/news.json')
    __resetStoreCacheForTests()
    jest.spyOn(AsyncStorage, 'getItem').mockRejectedValueOnce(new Error('disk is having a moment'))
    expect(await peekNewsUrl()).toBeUndefined()
    expect(await peekNewsUrl()).toBe('https://desk.example/news.json')
  })

  it('clearNewsUrl removes the address and leaves the mark to its own call', async () => {
    await saveNewsUrl('https://desk.example/news.json')
    await clearNewsUrl()
    __resetStoreCacheForTests()
    expect(await getNewsUrl()).toBeNull()
    expect(await AsyncStorage.getItem('claudepost.newsUrl')).toBeNull()
    expect(await isNewsUrlPending()).toBe(true)
  })

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

  it('writes the language choice under claudepost.language', async () => {
    await saveLanguage('ko')
    expect(await AsyncStorage.getItem('claudepost.language')).toBe('ko')
  })

  it('writes the desk address under claudepost.deskBaseUrl, and no token beside it', async () => {
    await saveDeskBaseUrl('https://desk.example.dev')
    expect(await AsyncStorage.getItem('claudepost.deskBaseUrl')).toBe('https://desk.example.dev')
    // The credential that goes with this address lives in the keychain (`deskToken.ts`). Nothing
    // in AsyncStorage may hold it, and this file is where somebody would put it by reflex.
    const keys = await AsyncStorage.getAllKeys()
    expect(keys.filter((k) => /token|secret|password/i.test(k))).toEqual([])
  })
})

describe('the desk address', () => {
  it('is null when nothing is stored', async () => {
    expect(await getDeskBaseUrl()).toBeNull()
  })

  it('normalizes before persisting and reads it back', async () => {
    expect(await saveDeskBaseUrl('https://desk.example.dev/')).toBe(true)
    __resetStoreCacheForTests()
    expect(await getDeskBaseUrl()).toBe('https://desk.example.dev')
  })

  it('keeps the scheme that was typed, because a desk is not always on the LAN', async () => {
    // The board's address defaults to `http://` and belongs to a machine on this Wi-Fi. A desk
    // usually does not: on iOS, ATS refuses plain http to anything off the local network, so an
    // https the operator typed has to survive being saved.
    expect(await saveDeskBaseUrl('https://desk.example.dev')).toBe(true)
    __resetStoreCacheForTests()
    expect(await getDeskBaseUrl()).toBe('https://desk.example.dev')
  })

  // WHAT A BARE HOSTNAME MEANS, and why it is not the board's answer. Every call on this address
  // carries the operator's token in a header. `normalizeBaseUrl` defaults a scheme-less address to
  // `http://` because that is right for the board on the LAN, and Android is built with
  // `usesCleartextTraffic` for exactly that reason — so a desk saved as `http://desk.example.dev`
  // would put the token on the wire in the clear, with the platform allowing it. A public name
  // therefore gets `https://`; the three shapes that can only be local keep `http://`.
  describe('a scheme-less address', () => {
    const saved = async (typed: string) => {
      expect(await saveDeskBaseUrl(typed)).toBe(true)
      __resetStoreCacheForTests()
      return getDeskBaseUrl()
    }

    it('assumes https for a public hostname', async () => {
      expect(await saved('desk.example.dev')).toBe('https://desk.example.dev')
    })

    it('assumes https even with a port on it', async () => {
      expect(await saved('desk.example.dev:8443')).toBe('https://desk.example.dev:8443')
    })

    it('leaves an IPv4 literal on http — a desk on the operator’s own Mac', async () => {
      expect(await saved('192.168.0.42:8791')).toBe('http://192.168.0.42:8791')
    })

    it('leaves localhost on http', async () => {
      expect(await saved('localhost:8791')).toBe('http://localhost:8791')
    })

    it('leaves an mDNS .local name on http', async () => {
      expect(await saved('desk.local')).toBe('http://desk.local')
    })

    it('leaves a single-label LAN host on http', async () => {
      // A name with no dot in it cannot have been registered anywhere, so it can only be resolved
      // by this network — an `/etc/hosts` line, a router's DHCP name, a Docker service. It is also
      // the shape a desk on the operator's own machine is usually typed in, and `https://claudepost`
      // is served by nothing at all: the address simply stops working.
      expect(await saved('claudepost')).toBe('http://claudepost')
      expect(await saved('claudepost:8791')).toBe('http://claudepost:8791')
      // Said absolutely. The root dot is not a label, so this is the same host as above.
      expect(deskScheme('claudepost.')).toBe('claudepost.')
    })

    it('still sends a dotted public name to https', async () => {
      // The other half of the rule above, which is the half that protects the token: one dot is
      // all it takes for a name to be one somebody could have registered.
      expect(await saved('desk.dev')).toBe('https://desk.dev')
      expect(await saved('a.b.example.com:8443')).toBe('https://a.b.example.com:8443')
    })

    it('never overrides a scheme the operator typed', async () => {
      // Including the one that downgrades: somebody running a desk on their LAN by name has said
      // what they meant, and silently upgrading it would make the address unreachable instead.
      expect(await saved('http://desk.example.dev')).toBe('http://desk.example.dev')
    })

    // Asserted on the decision itself rather than through `saveDeskBaseUrl`, because
    // `normalizeBaseUrl` refuses a bracketed literal outright — it wants a hostname or a dotted
    // quad — so an IPv6 desk address cannot be saved by either spelling today. That makes this the
    // contract of `deskScheme` alone: the port's colon is not the host's, and a loopback the
    // operator typed in brackets must not be told to speak https, which nothing on their own Mac
    // is serving.
    it('leaves a bracketed IPv6 literal on http', () => {
      expect(deskScheme('[::1]:8791')).toBe('[::1]:8791')
      expect(deskScheme('[fe80::1]')).toBe('[fe80::1]')
      expect(deskScheme('[2001:db8::1]/api')).toBe('[2001:db8::1]/api')
    })
  })

  it('rejects an address it cannot use and stores nothing', async () => {
    expect(await saveDeskBaseUrl('not a url')).toBe(false)
    expect(await saveDeskBaseUrl('')).toBe(false)
    __resetStoreCacheForTests()
    expect(await getDeskBaseUrl()).toBeNull()
  })

  it('retries after a rejecting read', async () => {
    await saveDeskBaseUrl('https://desk.example.dev')
    __resetStoreCacheForTests()
    jest.spyOn(AsyncStorage, 'getItem').mockRejectedValueOnce(new Error('disk is having a moment'))

    expect(await getDeskBaseUrl()).toBeNull()
    expect(await getDeskBaseUrl()).toBe('https://desk.example.dev')
  })
})

describe('app language', () => {
  it('defaults to system with nothing stored', async () => {
    expect(await getLanguage()).toBe('system')
  })

  it('round-trips a choice', async () => {
    await saveLanguage('ko')
    __resetStoreCacheForTests()
    expect(await getLanguage()).toBe('ko')
  })

  it('reads back through the cache before the disk has been asked again', async () => {
    // The setter fills the cache before its write is awaited, because the caller's next act is to
    // redraw the app in the new language.
    await saveLanguage('en')
    expect(await getLanguage()).toBe('en')
  })

  // A value this build does not recognise is a setting from another version of the app, or
  // something that was never written here at all. Reading it loosely would let an unknown string
  // decide the language — or, worse, become one by being handed straight to the resolver. Falling
  // to `system` asks the phone, which is what a fresh install does and is right for most people.
  it.each(['korean', 'KO', '', 'ko-KR', 'fr'])('treats %p as system', async (stored) => {
    await AsyncStorage.setItem('claudepost.language', stored)
    expect(await getLanguage()).toBe('system')
  })

  it('retries after a rejecting read', async () => {
    await saveLanguage('ko')
    __resetStoreCacheForTests()
    jest.spyOn(AsyncStorage, 'getItem').mockRejectedValueOnce(new Error('disk is having a moment'))

    expect(await getLanguage()).toBe('system')
    expect(await getLanguage()).toBe('ko')
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

  it('getNewsUrl retries after a rejecting read', async () => {
    await saveNewsUrl('https://desk.example/news.json')
    __resetStoreCacheForTests()
    jest.spyOn(AsyncStorage, 'getItem').mockRejectedValueOnce(new Error('disk is having a moment'))

    expect(await getNewsUrl()).toBeNull()
    expect(await getNewsUrl()).toBe('https://desk.example/news.json')
  })

  it('isNewsUrlPending retries after a rejecting read', async () => {
    // The one that matters most: a pending mark misread as "delivered" and then cached would
    // never be delivered, and nothing on any screen would say so.
    await saveNewsUrl('https://desk.example/news.json')
    __resetStoreCacheForTests()
    jest.spyOn(AsyncStorage, 'getItem').mockRejectedValueOnce(new Error('disk is having a moment'))

    expect(await isNewsUrlPending()).toBe(false)
    expect(await isNewsUrlPending()).toBe(true)
  })
})
