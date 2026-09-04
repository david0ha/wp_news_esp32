import { describe, it, expect } from '@jest/globals'
import { en } from './en'
import { ko } from './ko'
import { fill, resolveLanguage, setActiveLanguage, strings } from './index'

// The catalogue is a tree of plain strings, so its shape is checkable at runtime and not only by
// the compiler. `typeof ko === typeof en` already fails a build on a missing key, but it says
// nothing about a key that is present and still carries the English sentence — which is how a
// translation actually rots: somebody adds a row to `en.ts`, copies the block into `ko.ts` to keep
// the types happy, and ships English to Korean readers with every test green.
function keys(o: object, p = ''): string[] {
  return Object.entries(o).flatMap(([k, v]) =>
    typeof v === 'string' ? [p + k] : keys(v as object, p + k + '.'),
  )
}

function at(table: object, key: string): unknown {
  return key.split('.').reduce<any>((o, s) => o[s], table)
}

// Values that are deliberately the same in both catalogues, each with the reason it is here. A
// language picker names every language in its own language — that is what a reader scanning an
// unfamiliar UI looks for — so "English" and "한국어" are the right words in the Korean table too.
// Nothing else belongs on this list: URLs, tickers and the "Claude Post" brand are not catalogue
// entries at all, they are literals at their call sites or fragments inside a sentence that does
// differ. The list is asserted in both directions below, so an entry that stops being identical
// fails here rather than quietly excusing a real translation.
const SAME_IN_BOTH = new Set(['settings.language.english', 'settings.language.korean'])

describe('the catalogue', () => {
  it('ko carries every key en does, and nothing else', () => {
    expect(keys(ko).sort()).toEqual(keys(en).sort())
  })

  it('no ko value is left in English', () => {
    const flatEn = new Map(keys(en).map((k) => [k, at(en, k)]))
    for (const k of keys(ko)) {
      if (SAME_IN_BOTH.has(k)) {
        expect(at(ko, k)).toEqual(flatEn.get(k))
        continue
      }
      expect(at(ko, k)).not.toEqual(flatEn.get(k))
    }
  })

  it('every exemption names a key that exists', () => {
    const all = new Set(keys(en))
    for (const k of SAME_IN_BOTH) expect(all.has(k)).toBe(true)
  })

  it('carries the same placeholders in both languages', () => {
    // Word order moves a placeholder around the sentence; dropping one loses the value entirely,
    // which is the one interpolation bug no reader can report usefully ("it says 'connected to .'").
    const marks = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort()
    for (const k of keys(en)) expect(marks(at(ko, k) as string)).toEqual(marks(at(en, k) as string))
  })
})

describe('resolveLanguage', () => {
  it('system resolves from the device, and falls back to English', () => {
    expect(resolveLanguage('system', 'ko-KR')).toBe('ko')
    expect(resolveLanguage('system', 'fr')).toBe('en')
    expect(resolveLanguage('system', null)).toBe('en')
    expect(resolveLanguage('ko', 'en')).toBe('ko')
  })

  it('an explicit choice ignores the device entirely', () => {
    expect(resolveLanguage('en', 'ko-KR')).toBe('en')
    expect(resolveLanguage('ko', null)).toBe('ko')
  })

  it('reads the primary subtag, however the tag is spelled', () => {
    expect(resolveLanguage('system', 'ko')).toBe('ko')
    expect(resolveLanguage('system', 'ko_KR')).toBe('ko')
    expect(resolveLanguage('system', 'KO-Kore-KR')).toBe('ko')
    // Not Korean: the primary subtag is what decides, not a substring of the tag. `kok` is Konkani.
    expect(resolveLanguage('system', 'kok-IN')).toBe('en')
    expect(resolveLanguage('system', '')).toBe('en')
  })
})

describe('strings()', () => {
  it('is English until a language is applied, and follows it after', () => {
    setActiveLanguage('en')
    expect(strings()).toBe(en)
    setActiveLanguage('ko')
    expect(strings()).toBe(ko)
    setActiveLanguage('en')
  })
})

describe('fill', () => {
  it('substitutes every occurrence of a named placeholder', () => {
    expect(fill('{a} and {a} and {b}', { a: 'x', b: 'y' })).toBe('x and x and y')
  })

  it('leaves a placeholder it was given no value for', () => {
    // Better a visible `{host}` in a bug report than a sentence that silently lost its subject.
    expect(fill('at {host}.', {})).toBe('at {host}.')
  })
})
