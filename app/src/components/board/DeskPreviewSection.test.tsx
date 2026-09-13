import { afterEach, beforeEach, expect, it, jest } from '@jest/globals'
import React from 'react'
import { act, create } from 'react-test-renderer'
import { Image, Platform } from 'react-native'
import { Screen } from '../Screen'
import { DeskPreviewSection } from './DeskPreviewSection'
import { Button } from '../Button'
import { SegmentedControl } from '../SegmentedControl'
import { en } from '../../i18n/en'

jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual<typeof import('react-native-safe-area-context')>(
    'react-native-safe-area-context',
  ),
  useSafeAreaInsets: () => ({ top: 59, bottom: 34, left: 0, right: 0 }),
}))

jest.mock('expo-router', () => ({
  useFocusEffect: (cb: () => void) => require('react').useEffect(cb, [cb]),
}))
jest.mock('../../lib/desk', () => ({ createDeskClient: jest.fn() }))
jest.mock('../../lib/deskToken', () => ({ getDeskToken: jest.fn() }))
jest.mock('../../lib/store', () => ({ getDeskBaseUrl: jest.fn() }))
jest.mock('../../lib/papers/list', () => ({ usePapers: jest.fn() }))
const { createDeskClient } = jest.requireMock('../../lib/desk') as {
  createDeskClient: jest.Mock<() => { boardPreview: typeof fetchPreview }>
}
const { getDeskToken } = jest.requireMock('../../lib/deskToken') as {
  getDeskToken: jest.Mock<() => Promise<string | null>>
}
const { getDeskBaseUrl } = jest.requireMock('../../lib/store') as {
  getDeskBaseUrl: jest.Mock<() => Promise<string | null>>
}
const { usePapers } = jest.requireMock('../../lib/papers/list') as {
  usePapers: jest.Mock<() => { doc: { board: string } }>
}
const fetchPreview = jest.fn<() => Promise<typeof preview | null>>()
const preview = {
  editionId: 'edition1',
  sheets: [0, 1].map((page) => ({
    page,
    name: `a${page + 1}.png`,
    uri: `https://desk/sheet${page}`,
    headers: { Authorization: 'Bearer test' },
  })),
}
let tree: ReturnType<typeof create>
async function mount() {
  await act(async () => {
    tree = create(<DeskPreviewSection />)
  })
}
function text() {
  return JSON.stringify(tree.toJSON())
}
async function press(label: string) {
  await act(async () => {
    tree.root
      .findAllByType(Button)
      .find((b) => b.props.label === label)!
      .props.onPress()
  })
}
beforeEach(() => {
  jest.clearAllMocks()
  getDeskBaseUrl.mockResolvedValue('https://desk')
  getDeskToken.mockResolvedValue('test')
  usePapers.mockReturnValue({ doc: { board: 'edition1' } })
  createDeskClient.mockReturnValue({ boardPreview: fetchPreview })
  fetchPreview.mockResolvedValue(preview)
})
afterEach(() => {
  if (tree) act(() => tree.unmount())
})
it('loads independently of a board, switches sheets and opens enlargement', async () => {
  await mount()
  expect(fetchPreview).toHaveBeenCalledTimes(1)
  expect(tree.root.findByType(Image).props.source).toEqual({
    uri: preview.sheets[0].uri,
    headers: preview.sheets[0].headers,
  })
  await act(async () => tree.root.findByType(SegmentedControl).props.onChange(1))
  expect(tree.root.findByType(Image).props.source.uri).toBe(preview.sheets[1].uri)
  await press(en.board.deskPreview.enlarge)
  expect(text()).toContain(en.board.deskPreview.close)
})
it('does not request a preview without credentials', async () => {
  getDeskToken.mockResolvedValue(null)
  await mount()
  expect(fetchPreview).not.toHaveBeenCalled()
  expect(text()).toContain(en.board.deskPreview.setup)
})
it('shows an empty published edition honestly', async () => {
  fetchPreview.mockResolvedValue(null)
  await mount()
  expect(text()).toContain(en.board.deskPreview.empty)
  expect(tree.root.findAllByType(Image)).toHaveLength(0)
})
it('retries failed requests and image downloads', async () => {
  fetchPreview.mockRejectedValueOnce(new Error('offline'))
  await mount()
  expect(text()).toContain(en.board.deskPreview.failed)
  await press(en.common.tryAgain)
  await act(async () => tree.root.findByType(Image).props.onError())
  expect(text()).toContain(en.board.deskPreview.imageFailed)
  await press(en.common.tryAgain)
  expect(tree.root.findAllByType(Image)).toHaveLength(1)
  expect(fetchPreview).toHaveBeenCalledTimes(3)
})
it('reloads when the desk publishes another edition', async () => {
  await mount()
  usePapers.mockReturnValue({ doc: { board: 'edition2' } })
  await act(async () => tree.update(<DeskPreviewSection />))
  expect(fetchPreview).toHaveBeenCalledTimes(2)
})

it('ignores an obsolete response after credentials change and another load starts', async () => {
  let finish!: (value: typeof preview) => void
  fetchPreview.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  await mount()
  getDeskToken.mockResolvedValue(null)
  // A new publication reruns the same focus load used after returning from Settings.
  usePapers.mockReturnValue({ doc: { board: 'edition2' } })
  await act(async () => tree.update(<DeskPreviewSection />))
  await act(async () => finish(preview))
  expect(text()).toContain(en.board.deskPreview.setup)
  expect(tree.root.findAllByType(Image)).toHaveLength(0)
})

it('ignores an old sheet download failure after switching pages', async () => {
  await mount()
  const oldError = tree.root.findByType(Image).props.onError
  await act(async () => tree.root.findByType(SegmentedControl).props.onChange(1))
  await act(async () => oldError())
  expect(tree.root.findByType(Image).props.source.uri).toBe(preview.sheets[1].uri)
})
it('positions the enlarged screen within the outer safe area', async () => {
  await mount()
  await press(en.board.deskPreview.enlarge)
  expect(tree.root.findByType(Screen).props.edges).toEqual([])
  expect(tree.root.findByType(Screen).props.style).toEqual({ paddingTop: 59, paddingBottom: 34 })
})
it('does not promise pinch zoom on Android', async () => {
  const original = Platform.OS
  Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' })
  try {
    await mount()
    await press(en.board.deskPreview.enlarge)
    expect(text()).not.toContain(en.board.deskPreview.zoom)
  } finally {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: original })
  }
})

it('still reports a current image failure after tapping the already selected page', async () => {
  await mount()
  const currentError = tree.root.findByType(Image).props.onError
  await act(async () => tree.root.findByType(SegmentedControl).props.onChange(0))
  await act(async () => currentError())
  expect(text()).toContain(en.board.deskPreview.imageFailed)
  expect(tree.root.findAllByType(Image)).toHaveLength(0)
})
