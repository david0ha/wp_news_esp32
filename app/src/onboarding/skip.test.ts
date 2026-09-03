import { describe, it, expect, beforeEach, jest } from '@jest/globals'
import AsyncStorage from '@react-native-async-storage/async-storage'
import type { ImperativeRouter } from 'expo-router'

import { __resetStoreCacheForTests, isSetupSkipped } from '../lib/store'
import { skipSetup } from './skip'

/** Read off the real router rather than restated as `string`, so a widened href still typechecks. */
type Href = Parameters<ImperativeRouter['dismissTo']>[0]

beforeEach(async () => {
  await AsyncStorage.clear()
  __resetStoreCacheForTests()
})

/**
 * A stand-in for expo-router's imperative API that records every navigation verb, not just the one
 * the handler is supposed to call. `skipSetup` accepts only `dismissTo`, so `replace` and the rest
 * are here purely so a regression can be *seen*: an edit that reaches for the wrong verb shows up
 * as a call logged against the wrong name rather than as a type error nobody reads in a diff.
 */
function fakeRouter() {
  const calls: { verb: string; href?: Href }[] = []
  return {
    calls,
    dismissTo: (href: Href) => void calls.push({ verb: 'dismissTo', href }),
    dismissAll: () => void calls.push({ verb: 'dismissAll' }),
    replace: (href: Href) => void calls.push({ verb: 'replace', href }),
    push: (href: Href) => void calls.push({ verb: 'push', href }),
  }
}

describe('skipSetup', () => {
  it('leaves the wizard by dismissing to the markets tab', async () => {
    const router = fakeRouter()

    await skipSetup(router)

    expect(router.calls).toEqual([{ verb: 'dismissTo', href: '/markets' }])
  })

  it('never replaces, pushes or pops to the top of the closest stack', async () => {
    // Three wrong verbs, each wrong for its own reason and each a plausible edit.
    //
    // `push` leaves the wizard under the markets tab, one back gesture from the screen the user
    // just declined. `replace` swaps the route at the *root* stack's index, which is right only
    // while the wizard is that stack's only route — on a pushed wizard it turns
    // `[(tabs), onboarding]` into two Tabs navigators, the second a stale copy of the whole app
    // that never updates again. `dismissAll` pops the *closest* stack, and from wifi-list the
    // closest stack is the onboarding stack itself, so it walks the user back to `turn-on` from
    // inside the control whose entire job is leaving the wizard.
    const router = fakeRouter()

    await skipSetup(router)

    const verbs = router.calls.map((c) => c.verb)
    expect(verbs).not.toContain('replace')
    expect(verbs).not.toContain('push')
    expect(verbs).not.toContain('dismissAll')
  })

  it('has the mark on disk by the time it navigates, not after', async () => {
    // The ordering is the whole reason this lives in its own module, and this asserts it the way
    // the user would experience a violation rather than by watching call order: at the instant the
    // navigation fires, drop the in-memory cache and ask the disk the same question the entry gate
    // asks on a cold launch. A process killed in that window — or a user swiping the app away
    // because they got what they came for — must not come back to `/onboarding/turn-on`.
    let markOnDiskAtNavigation: Promise<boolean> | null = null
    const router = {
      dismissTo: () => {
        __resetStoreCacheForTests()
        markOnDiskAtNavigation = isSetupSkipped()
      },
    }

    await skipSetup(router)

    expect(markOnDiskAtNavigation).not.toBeNull()
    expect(await markOnDiskAtNavigation!).toBe(true)
  })

  it('still lets the user out when the write is refused', async () => {
    // `markSetupSkipped` absorbs its own storage failure, and this asserts that `skipSetup` spends
    // that guarantee rather than re-deciding it. Refusing to leave the wizard because AsyncStorage
    // hiccuped would trade the cheap failure — being asked again on the next launch — for the
    // expensive one, which is being stranded again with no explanation.
    //
    // `mockRejectedValueOnce`, never `mockRejectedValue` plus a restore: the async-storage mock's
    // methods are already `jest.fn`s, so `jest.spyOn` hands back the library's own function
    // unwrapped and `mockRestore()` on it *resets* rather than restores — it strips the
    // implementation the mock shipped with, and every later write in the file silently stores
    // nothing. The one-shot form queues a single rejection and leaves that implementation intact.
    jest.spyOn(AsyncStorage, 'setItem').mockRejectedValueOnce(new Error('disk is having a moment'))
    const router = fakeRouter()

    await skipSetup(router)

    expect(router.calls).toEqual([{ verb: 'dismissTo', href: '/markets' }])
    // The in-memory mark is set regardless, so the tab the user lands on reads "skipped" even
    // though nothing reached disk.
    expect(await isSetupSkipped()).toBe(true)
  })

  it('records the mark where a cold launch will find it', async () => {
    const router = fakeRouter()

    await skipSetup(router)
    __resetStoreCacheForTests()

    expect(await isSetupSkipped()).toBe(true)
  })
})
