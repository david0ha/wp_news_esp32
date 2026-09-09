import { describe, it, expect, beforeEach, jest } from '@jest/globals'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { readFileSync } from 'fs'
import { join } from 'path'

import { en } from '../i18n/en'
import { setActiveLanguage } from '../i18n'
import { Esp32Error, humanError } from './esp32'
import { type DeskProbe } from './edition/probe'
import {
  decideNewsUrlSave,
  settleNewsUrlSync,
  syncPendingNewsUrl,
  type NewsUrlSyncClient,
} from './newsurlsync'
import {
  __resetStoreCacheForTests,
  clearNewsUrlPending,
  getNewsUrl,
  isNewsUrlPending,
  saveNewsUrl,
} from './store'

beforeEach(async () => {
  await AsyncStorage.clear()
  __resetStoreCacheForTests()
})

/**
 * A stand-in board that records what it was told and answers as instructed. Only `setNewsUrl`,
 * because that is all the sync is allowed to touch — a fake that offered more would let a
 * regression reach for state the sync was never handed.
 *
 * An accepting board holds every POST open until the test lets go, so overlap can be observed.
 * The gate exists from construction so `release()` works whether it is called before or after the
 * sync has got as far as the POST — it reads storage first, and that is asynchronous too.
 */
function fakeBoard(behaviour: 'accepts' | 'asleep' | 'rejects' | 'explodes' = 'accepts') {
  const posted: string[] = []
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const client: NewsUrlSyncClient = {
    setNewsUrl: async (url) => {
      posted.push(url)
      if (behaviour === 'asleep') throw new Esp32Error('timeout')
      if (behaviour === 'rejects') throw new Esp32Error('news_url_invalid', undefined, 400)
      if (behaviour === 'explodes') throw new TypeError('not even a board error')
      await gate
    },
  }
  return { client, posted, release: () => release() }
}

/** Run a delivery against an accepting board and let it through. */
async function deliverTo(board: ReturnType<typeof fakeBoard>) {
  const result = syncPendingNewsUrl(board.client)
  board.release()
  return result
}

/**
 * Wait until a delivery has actually reached the wire. It reads the mark and the address off
 * storage first, both asynchronously, so "started" and "POSTed" are separated by a few turns of
 * the event loop — and a save made between them is read *by* the delivery rather than racing it,
 * which is a different (and unremarkable) case from the one the ownership tests are about.
 */
async function untilOnTheWire(posted: { length: number }) {
  while (posted.length === 0) await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

describe('syncPendingNewsUrl', () => {
  it('sends nothing and touches nothing when no address is pending', async () => {
    const board = fakeBoard()
    expect(await syncPendingNewsUrl(board.client)).toEqual({ status: 'nothing' })
    expect(board.posted).toEqual([])
  })

  it('sends nothing when the address was already delivered', async () => {
    await saveNewsUrl('https://desk.example/news.json')
    await clearNewsUrlPending()
    const board = fakeBoard()
    expect(await syncPendingNewsUrl(board.client)).toEqual({ status: 'nothing' })
    expect(board.posted).toEqual([])
  })

  it('delivers a pending address and clears the mark', async () => {
    await saveNewsUrl('https://desk.example/news.json')
    const board = fakeBoard()
    expect(await deliverTo(board)).toEqual({ status: 'sent' })
    expect(board.posted).toEqual(['https://desk.example/news.json'])
    __resetStoreCacheForTests()
    expect(await isNewsUrlPending()).toBe(false)
    expect(await getNewsUrl()).toBe('https://desk.example/news.json')
  })

  it('delivers the empty string, because "demo data" is an address too', async () => {
    await saveNewsUrl('')
    const board = fakeBoard()
    expect(await deliverTo(board)).toEqual({ status: 'sent' })
    expect(board.posted).toEqual([''])
  })

  it('leaves the mark set when the board is asleep, so the next read tries again', async () => {
    await saveNewsUrl('https://desk.example/news.json')
    const asleep = fakeBoard('asleep')
    expect(await syncPendingNewsUrl(asleep.client)).toEqual({ status: 'failed' })
    __resetStoreCacheForTests()
    expect(await isNewsUrlPending()).toBe(true)

    // ...and the next read, on a board that answers, is what delivers it.
    const awake = fakeBoard()
    expect(await deliverTo(awake)).toEqual({ status: 'sent' })
    expect(awake.posted).toEqual(['https://desk.example/news.json'])
  })

  it('leaves the mark set when the disk did not answer for the address', async () => {
    // The mark read succeeded and the address read threw. That is not "no address" — it is "no
    // answer yet" — and clearing the mark on it would lose an address the user did save.
    await saveNewsUrl('https://desk.example/news.json')
    __resetStoreCacheForTests()
    await isNewsUrlPending() // cache the mark, so the one rejected read below is the address
    jest.spyOn(AsyncStorage, 'getItem').mockRejectedValueOnce(new Error('disk is having a moment'))
    const board = fakeBoard()
    expect(await syncPendingNewsUrl(board.client)).toEqual({ status: 'failed' })
    expect(board.posted).toEqual([])
    expect(await isNewsUrlPending()).toBe(true)
    expect(await AsyncStorage.getItem('claudepost.newsUrl')).toBe('"https://desk.example/news.json"')
  })

  it('contains an error that is not a board error, and keeps the mark', async () => {
    await saveNewsUrl('https://desk.example/news.json')
    const board = fakeBoard('explodes')
    // It says so on the console, which is right in the app and noise in this run.
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await expect(syncPendingNewsUrl(board.client)).resolves.toEqual({ status: 'failed' })
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
    }
    expect(await isNewsUrlPending()).toBe(true)
  })

  it('makes overlapping calls share one POST', async () => {
    // The Board tab's five-second poll can lap a POST to a board that has only just woken.
    await saveNewsUrl('https://desk.example/news.json')
    const board = fakeBoard()
    const first = syncPendingNewsUrl(board.client)
    const second = syncPendingNewsUrl(board.client)
    board.release()
    expect(await Promise.all([first, second])).toEqual([{ status: 'sent' }, { status: 'sent' }])
    expect(board.posted).toEqual(['https://desk.example/news.json'])
  })
})

// The mark belongs to whichever address was saved last. A delivery that started for an older
// address must not clear it on landing, or the phone ends up on one address, the board on
// another, and nothing pending to ever reconcile them.
describe('a delivery clears only the mark it started for', () => {
  it('leaves the mark for a newer address saved while it was on the wire', async () => {
    await saveNewsUrl('https://a.example/news.json')
    const board = fakeBoard()
    const inFlight = syncPendingNewsUrl(board.client)
    await untilOnTheWire(board.posted) // A is on the wire, held open

    // The user saves B while A's POST is still out. (In the app this save's own POST would have
    // timed out first — the board is asleep — which is why there is a mark to re-arm.)
    await saveNewsUrl('https://b.example/news.json')

    board.release() // A lands
    expect(await inFlight).toEqual({ status: 'sent' })
    expect(board.posted).toEqual(['https://a.example/news.json'])

    // B is still owed to the board...
    __resetStoreCacheForTests()
    expect(await isNewsUrlPending()).toBe(true)
    expect(await getNewsUrl()).toBe('https://b.example/news.json')

    // ...and the next delivery is what sends it.
    const later = fakeBoard()
    expect(await deliverTo(later)).toEqual({ status: 'sent' })
    expect(later.posted).toEqual(['https://b.example/news.json'])
    __resetStoreCacheForTests()
    expect(await isNewsUrlPending()).toBe(false)
  })

  it('clears the mark when the same address was re-saved meanwhile', async () => {
    await saveNewsUrl('https://a.example/news.json')
    const board = fakeBoard()
    const inFlight = syncPendingNewsUrl(board.client)
    await untilOnTheWire(board.posted)
    await saveNewsUrl('https://a.example/news.json') // re-armed, but for the address on the wire
    board.release()
    expect(await inFlight).toEqual({ status: 'sent' })
    __resetStoreCacheForTests()
    expect(await isNewsUrlPending()).toBe(false)
  })
})

describe('settleNewsUrlSync', () => {
  it('resolves at once when nothing is on the wire', async () => {
    await expect(settleNewsUrlSync()).resolves.toBeUndefined()
  })

  it('waits for a delivery already on the wire, without starting one', async () => {
    await saveNewsUrl('https://a.example/news.json')
    const board = fakeBoard()
    const inFlight = syncPendingNewsUrl(board.client)
    let settled = false
    const settle = settleNewsUrlSync().then(() => {
      settled = true
    })
    // Let any microtasks run: it must still be waiting, because the POST is.
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(settled).toBe(false)
    board.release()
    await inFlight
    await settle
    expect(settled).toBe(true)
    expect(board.posted).toEqual(['https://a.example/news.json'])
  })
})

// A refusal is a verdict on the address, and a verdict does not change on being asked again — a
// poll that retried it would POST the same doomed address every five seconds forever. So it clears
// the mark, says which error, and leaves the address on the phone for the screen to explain.
describe('a refusal ends the delivery', () => {
  it('reports rejected with the board’s error and clears the mark', async () => {
    await saveNewsUrl('https://desk.example/news.json')
    const board = fakeBoard('rejects')
    const result = await syncPendingNewsUrl(board.client)
    expect(result.status).toBe('rejected')
    if (result.status === 'rejected') expect(result.error.code).toBe('news_url_invalid')
    __resetStoreCacheForTests()
    expect(await isNewsUrlPending()).toBe(false)
    expect(await getNewsUrl()).toBe('https://desk.example/news.json')
  })

  it('does not POST again on the next read', async () => {
    await saveNewsUrl('https://desk.example/news.json')
    await syncPendingNewsUrl(fakeBoard('rejects').client)
    const again = fakeBoard('rejects')
    expect(await syncPendingNewsUrl(again.client)).toEqual({ status: 'nothing' })
    expect(again.posted).toEqual([])
  })

  it('still leaves the mark for a newer address saved while the refused one was on the wire', async () => {
    // Same ownership rule as a success: the refusal was of A, and B has not been tried.
    await saveNewsUrl('https://a.example/news.json')
    let releaseA: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      releaseA = resolve
    })
    const posted: string[] = []
    const board: NewsUrlSyncClient = {
      setNewsUrl: async (url) => {
        posted.push(url)
        await gate
        throw new Esp32Error('news_url_invalid', undefined, 400)
      },
    }
    const inFlight = syncPendingNewsUrl(board)
    await untilOnTheWire(posted)
    await saveNewsUrl('https://b.example/news.json')
    releaseA()
    expect(posted).toEqual(['https://a.example/news.json'])
    expect((await inFlight).status).toBe('rejected')
    __resetStoreCacheForTests()
    expect(await isNewsUrlPending()).toBe(true)
    expect(await getNewsUrl()).toBe('https://b.example/news.json')
  })
})

// A mark over nothing deliverable would otherwise be found set, and skipped, on every read for the
// life of the install — never sent, never cleared, and "Not yet on the board" said forever about
// an address that does not exist.
describe('a mark with nothing under it is dropped', () => {
  it('clears the mark when no address is stored', async () => {
    await AsyncStorage.setItem('claudepost.newsUrlPending', '1')
    const board = fakeBoard()
    expect(await syncPendingNewsUrl(board.client)).toEqual({ status: 'nothing' })
    expect(board.posted).toEqual([])
    __resetStoreCacheForTests()
    expect(await isNewsUrlPending()).toBe(false)
  })

  it('clears the mark and the value when the stored address is not one this app wrote', async () => {
    await AsyncStorage.setItem('claudepost.newsUrl', 'https://desk.example/news.json') // not encoded
    await AsyncStorage.setItem('claudepost.newsUrlPending', '1')
    const board = fakeBoard()
    expect(await syncPendingNewsUrl(board.client)).toEqual({ status: 'nothing' })
    expect(board.posted).toEqual([])
    __resetStoreCacheForTests()
    expect(await isNewsUrlPending()).toBe(false)
    expect(await AsyncStorage.getItem('claudepost.newsUrl')).toBeNull()
  })
})

// The Save button's own attempt, as a rule. These pin what the screen may not: that a refusal is
// the one outcome that saves nothing, that a timeout is the normal case and not an error, that
// each end of a save is said in the right voice — and that the DESK's answer is reported at all,
// which is the whole reason the decision now returns two lines instead of one.
describe('decideNewsUrlSave', () => {
  const URL = 'https://desk.example/news.json'
  const ANSWERED: DeskProbe = { status: 'ok', subject: 'Acme Corp', dateline: 'WEDNESDAY, 9 SEP' }
  const SILENT: DeskProbe = { status: 'failed', message: 'Couldn’t reach the edition server.' }
  const NOTHING_ASKED: DeskProbe = { status: 'skipped' }

  it('board took it: persist, delivered, green on both lines', () => {
    expect(decideNewsUrlSave(URL, { ok: true }, null, ANSWERED)).toEqual({
      persist: true,
      pending: false,
      desk: { tone: 'ok', message: 'Saved. The desk answered — Acme Corp, WEDNESDAY, 9 SEP.' },
      board: { tone: 'ok', message: 'The board took the new address and is fetching it now.' },
    })
  })

  it('board took the empty address: says demo, not "fetching", and asks the desk nothing', () => {
    const d = decideNewsUrlSave('', { ok: true }, null, NOTHING_ASKED)
    expect(d).toMatchObject({ persist: true, pending: false })
    // An empty address is not an address to ask. A desk line here would be a sentence about a
    // server nobody named.
    expect(d.desk).toBeNull()
    expect(d.board.message).toBe('Cleared — the board is back on demo data.')
  })

  it.each(['news_url_invalid', 'too_large', 'bad_json'] as const)(
    'board refused with %s: nothing saved, red, in humanError’s words',
    (code) => {
      const e = new Esp32Error(code, undefined, 400)
      const d = decideNewsUrlSave(URL, { error: e }, null, ANSWERED)
      expect(d).toMatchObject({ persist: false, pending: false })
      expect(d.board).toEqual({ tone: 'error', message: humanError(e) })
    },
  )

  it('board asleep (timeout): persist, pending, the help voice, and says asleep', () => {
    const d = decideNewsUrlSave(URL, { error: new Esp32Error('timeout') }, null, ANSWERED)
    expect(d).toMatchObject({ persist: true, pending: true })
    expect(d.board.tone).toBe('info')
    expect(d.board.message).toMatch(/asleep/)
  })

  it.each(['network_error', 'busy', 'http_error', 'read_error'] as const)(
    'board did not take it (%s): persist, pending, the help voice, and does not claim asleep',
    (code) => {
      const d = decideNewsUrlSave(URL, { error: new Esp32Error(code) }, null, ANSWERED)
      expect(d).toMatchObject({ persist: true, pending: true })
      expect(d.board.tone).toBe('info')
      expect(d.board.message).not.toMatch(/asleep/)
    },
  )

  it('an error that is not the client’s is treated as the board not taking it', () => {
    const e = new TypeError('cannot read properties of undefined')
    const d = decideNewsUrlSave(URL, { error: e }, null, ANSWERED)
    expect(d).toMatchObject({ persist: true, pending: true })
    expect(d.board.tone).toBe('info')
    expect(d.board.message).not.toMatch(/asleep/)
  })

  it('no client: persist, pending, and its own sentence — not "asleep"', () => {
    const d = decideNewsUrlSave(URL, { noClient: true }, null, ANSWERED)
    expect(d).toMatchObject({ persist: true, pending: true })
    expect(d.board).toEqual({
      tone: 'info',
      message: 'Not connected to a board right now — it will be sent when this app reaches one.',
    })
    expect(d.board.message).not.toBe(
      decideNewsUrlSave(URL, { error: new Esp32Error('timeout') }, null, ANSWERED).board.message,
    )
  })

  it('no board on this phone: names the reader that is using the address, not the hardware', () => {
    // The News source editor is no longer gated on owning a board — the Today tab reads this same
    // address — so the board-only sentence is now said to people who have never had one. It named
    // hardware that does not exist and promised a delivery nobody was waiting for.
    const d = decideNewsUrlSave(URL, { noClient: true }, false, ANSWERED)
    expect(d).toMatchObject({ persist: true, pending: true })
    expect(d.board.message).toBe(
      'No board on this phone yet. One you set up later will get the same address.',
    )
    // And the line that says the address WORKS is the desk's, which a phone with no board is the
    // only reader of.
    expect(d.desk).toEqual({
      tone: 'ok',
      message: 'Saved. The desk answered — Acme Corp, WEDNESDAY, 9 SEP.',
    })
  })

  it('no board and a cleared address: says the Today tab is on the demo', () => {
    // The help text and the button both promise the demo; the confirmation said only that an
    // absent board would be told, which is the one thing the reader cannot see.
    const d = decideNewsUrlSave('', { noClient: true }, false, NOTHING_ASKED)
    expect(d).toMatchObject({ persist: true, pending: true })
    expect(d.desk).toBeNull()
    expect(d.board.message).toBe('Cleared — Today is on the demo edition.')
  })

  it('keeps the board owner’s sentences, and says nothing new while storage is silent', () => {
    // `hasDevice === false`, never `!hasDevice`: `null` is "storage has not answered yet", and a
    // sentence about a board this phone may well own must not be said on a guess.
    const unknown = decideNewsUrlSave(URL, { noClient: true }, null, ANSWERED)
    const owner = decideNewsUrlSave(URL, { noClient: true }, true, ANSWERED)
    expect(owner.board.message).toBe(unknown.board.message)
    expect(owner.board.message).toMatch(/board/)
    expect(decideNewsUrlSave(URL, { ok: true }, false, ANSWERED).board.message).toBe(
      'The board took the new address and is fetching it now.',
    )
  })

  // The desk's line is the one this decision grew for: the address the reader typed, answered by
  // the address itself rather than by the hardware that may never see it.
  describe('the desk’s line', () => {
    it('names the edition it found, because "the desk answered" is not evidence on its own', () => {
      const d = decideNewsUrlSave(URL, { noClient: true }, false, ANSWERED)
      expect(d.desk?.message).toContain('Acme Corp')
      expect(d.desk?.message).toContain('WEDNESDAY, 9 SEP')
    })

    it('falls back to a plain sentence when the payload named neither', () => {
      // `isEmptyEdition` lets an edition through on its stories alone, so both slots can be empty
      // in a payload this app accepts. A line with an empty slot in it reads as a bug.
      const d = decideNewsUrlSave(URL, { noClient: true }, false, {
        status: 'ok',
        subject: '',
        dateline: '',
      })
      expect(d.desk).toEqual({
        tone: 'ok',
        message: 'Saved. The desk answered, and Today reads from this address.',
      })
    })

    it('uses whichever half the payload did name', () => {
      const named = decideNewsUrlSave(URL, { noClient: true }, false, {
        status: 'ok',
        subject: 'Acme Corp',
        dateline: '',
      })
      expect(named.desk?.message).toBe('Saved. The desk answered — Acme Corp.')
    })

    it('is red when the address answered nothing — and the address is still saved', () => {
      // The one pair that used to be unsayable. An address that did not answer may be a typo or a
      // desk mid-publish or a phone off the network, and only the first is worth losing the
      // typing over — so the sentence carries the doubt and the storage keeps the address.
      const d = decideNewsUrlSave(URL, { noClient: true }, false, SILENT)
      expect(d.persist).toBe(true)
      expect(d.desk).toEqual({
        tone: 'error',
        message:
          'Saved, but nothing could be read from that address. Couldn’t reach the edition server.',
      })
    })

    it('does not overrule the board’s refusal, which is the one thing that saves nothing', () => {
      // A desk that answers perfectly does not make an address the board rejected storable: the
      // board's refusal is a verdict on the address, and the two lines report two different
      // things about the same string.
      const e = new Esp32Error('news_url_invalid', undefined, 400)
      const d = decideNewsUrlSave(URL, { error: e }, true, ANSWERED)
      expect(d.persist).toBe(false)
      expect(d.desk?.tone).toBe('ok')
      expect(d.board.tone).toBe('error')
    })
  })

  it('says all of them in the app’s language', () => {
    // One sentence per branch, and the branching itself is language-free: the decision above
    // chose which sentence, and only the words change here.
    setActiveLanguage('ko')
    try {
      const HANGUL = /[가-힣]/
      expect(decideNewsUrlSave(URL, { ok: true }, null, ANSWERED).board.message).toMatch(HANGUL)
      expect(decideNewsUrlSave('', { ok: true }, null, NOTHING_ASKED).board.message).toMatch(HANGUL)
      expect(decideNewsUrlSave(URL, { noClient: true }, null, ANSWERED).board.message).toMatch(
        HANGUL,
      )
      expect(decideNewsUrlSave(URL, { noClient: true }, false, ANSWERED).board.message).toMatch(
        HANGUL,
      )
      expect(decideNewsUrlSave('', { noClient: true }, false, NOTHING_ASKED).board.message).toMatch(
        HANGUL,
      )
      expect(
        decideNewsUrlSave(URL, { error: new Esp32Error('timeout') }, null, ANSWERED).board.message,
      ).toMatch(HANGUL)
      expect(
        decideNewsUrlSave(URL, { error: new Esp32Error('busy') }, null, ANSWERED).board.message,
      ).toMatch(HANGUL)
      // Both desk lines too. The failure keeps the reader's own sentence inside it — which is
      // already in the app's language, because `humanEditionError` read the same catalogue.
      expect(decideNewsUrlSave(URL, { ok: true }, null, ANSWERED).desk?.message).toMatch(HANGUL)
      const failed = decideNewsUrlSave(URL, { ok: true }, null, SILENT).desk
      expect(failed?.message).toMatch(HANGUL)
      expect(failed?.message).toContain('Couldn’t reach the edition server.')
      // The board's own refusal still comes through `humanError`, so it is Korean for the same
      // reason and not for a second one.
      expect(
        decideNewsUrlSave(
          URL,
          { error: new Esp32Error('news_url_invalid', undefined, 400) },
          null,
          ANSWERED,
        ).board.message,
      ).toBe(humanError(new Esp32Error('news_url_invalid', undefined, 400)))
    } finally {
      setActiveLanguage('en')
    }
  })
})

// This app has no component-testing library, so the wiring is pinned the way the humanError rule
// is: by reading the source. A screen that stops calling these is a phone whose saved address
// never arrives, or a wizard that leaves the phone and the board disagreeing from the first minute.
describe('the screens are wired to the rules', () => {
  const read = (rel: string) =>
    readFileSync(join(__dirname, '../..', rel), 'utf8')
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('//'))
      .join('\n')

  it.each(['src/app/(tabs)/board.tsx', 'src/app/(tabs)/settings.tsx'])(
    '%s delivers a pending address after reading the board',
    (rel) => {
      expect(read(rel)).toMatch(/\bsyncPendingNewsUrl\(/)
    },
  )

  it('settings tells the save rule whether this phone has a board', () => {
    // The third argument is the whole of rows B1/B3: without it the editor says "Not yet on the
    // board" to somebody who has never had one, and says it for ever, because nothing without a
    // client ever calls syncPendingNewsUrl to clear the mark.
    expect(read('src/app/(tabs)/settings.tsx')).toMatch(
      /decideNewsUrlSave\(next, outcome, hasDevice, desk\)/,
    )
  })

  it('settings asks the address itself, and asks it beside the board rather than after it', () => {
    // The fourth argument is the whole of the desk line, and a screen that passed a hardcoded
    // `{ status: 'skipped' }` would type-check, render, and say nothing about the server — which
    // is the exact state this change exists to end. The `Promise.all` is the second half: run in
    // sequence, a save to a phone with a sleeping board would sit through the board's timeout
    // before asking the question the reader is actually waiting on.
    const src = read('src/app/(tabs)/settings.tsx')
    expect(src).toMatch(/probeEdition\(next\)/)
    expect(src).toMatch(/Promise\.all\(\[boardAttempt, probeEdition\(next\)\]\)/)
  })

  it('the editor draws both lines, the desk’s above the board’s', () => {
    // Two `<Text>`s and not one. The failure this pins is a screen that keeps rendering only
    // `outcome.board` after the decision grew a second line: it would compile, pass every rule
    // test above, and show the reader nothing about the address they just typed.
    const src = read('src/app/(tabs)/settings.tsx')
    const desk = src.indexOf('outcome?.desk ?')
    const board = src.indexOf('outcome.board.tone')
    expect(desk).toBeGreaterThan(-1)
    expect(board).toBeGreaterThan(desk)
  })

  it('settings offers the board-less phone the reader’s sentence, on `=== false` and not on falsiness', () => {
    // Both sentences moved into the string catalogue when the app learned a second language, so
    // this now pins the two halves separately: the *wording* against `en.ts`, and the *branch* —
    // including which key each arm reaches for — against the screen. Either half alone would pass
    // a screen that reads perfectly and says the wrong thing to the wrong phone.
    expect(en.settings.news.pendingNoBoard).toMatch(
      /Today reads from this address\. A board you set up later will get it too\./,
    )
    expect(en.settings.news.pendingWithBoard).toMatch(
      /Not yet on the board — it will be sent the next time this app reaches it\./,
    )
    expect(read('src/app/(tabs)/settings.tsx')).toMatch(
      /hasBoard === false \? s\.settings\.news\.pendingNoBoard : s\.settings\.news\.pendingWithBoard/,
    )
  })

  it('settings.tsx decides a save by the rule, and waits for the wire first', () => {
    const src = read('src/app/(tabs)/settings.tsx')
    expect(src).toMatch(/\bdecideNewsUrlSave\(/)
    expect(src).toMatch(/\bsettleNewsUrlSync\(/)
  })

  it('password.tsx brings the phone level with the board once provisioning is accepted', () => {
    const src = read('src/app/onboarding/password.tsx')
    const provision = src.indexOf('.provision(')
    const save = src.indexOf('saveNewsUrl(')
    const clear = src.indexOf('clearNewsUrlPending(')
    expect(provision).toBeGreaterThan(-1)
    expect(save).toBeGreaterThan(provision)
    expect(clear).toBeGreaterThan(save)
  })
})
