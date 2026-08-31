// The react-query binding: every screen reads the desk and the board through the hooks in this
// file, never through `desk.ts` / `esp32.ts` directly. That is what makes "no fetching inside
// components" (docs for Task 25 onward) true rather than a convention to remember — a component
// has nothing to fetch WITH.
//
// Two clients, two settings sources, one QueryClient:
//   - the desk (src/lib/desk.ts) is configured once, in Settings — `useDeskClient()` resolves
//     `getDeskSettings()` through react-query itself, so every other hook in this file can depend
//     on it the same way it depends on any other query, `enabled` included.
//   - the board (src/lib/esp32.ts) is resolved by `DeviceProvider` (src/lib/device.tsx), which
//     this file does not duplicate — `useDevice()` already hands out a client bound to the
//     current base URL.
//
// `queryClient` is a module-level singleton rather than something built inside `RootLayout`,
// because `invalidateDeskSettings()` has to be callable from wherever Settings saves a new
// address or token — a plain function, not a hook, since a save handler is not always inside a
// component that could call `useQueryClient()`.

import { useMemo } from 'react'
import {
  focusManager,
  QueryClient,
  useMutation,
  useQuery,
  type QueryKey,
} from '@tanstack/react-query'
import {
  createDeskClient,
  DeskError,
  type AddDirectiveInput,
  type DeskClient,
  type NotesKind,
  type PostCommandInput,
  type Schedule,
} from './desk'
import { getDeskSettings } from './settings'
import { useDevice } from './device'
import { Esp32Error, type Esp32Client } from './esp32'
import { decode } from './screen'
import {
  screenCacheGet,
  screenCachePut,
  screenFingerprint,
  type ScreenIdentity,
} from './screencache'

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // A LAN board and a tunnelled desk both fail in ordinary ways (asleep, cold tunnel) that a
      // second try clears; react-query's default of 3 would triple every one of this app's own
      // documented timeouts before a screen shows the human sentence for it.
      retry: 1,
    },
  },
})

// ---------------------------------------------------------------------------
// Query keys. One factory per client, so a key can never be spelled two ways in two files.
// ---------------------------------------------------------------------------

export const deskKeys = {
  all: ['desk'] as const,
  settings: () => ['deskSettings'] as const,
  state: () => [...deskKeys.all, 'state'] as const,
  news: () => [...deskKeys.all, 'news'] as const,
  editions: () => [...deskKeys.all, 'editions'] as const,
  edition: (eid: string) => [...deskKeys.all, 'edition', eid] as const,
  sheet: (eid: string, name: string) => [...deskKeys.all, 'sheet', eid, name] as const,
  notes: (kind: NotesKind, id: string) => [...deskKeys.all, 'notes', kind, id] as const,
  watchlist: () => [...deskKeys.all, 'watchlist'] as const,
  quotes: (symbols: readonly string[]) => [...deskKeys.all, 'quotes', ...symbols] as const,
  commands: (status?: string) => [...deskKeys.all, 'commands', status ?? 'all'] as const,
  directives: () => [...deskKeys.all, 'directives'] as const,
  schedule: () => [...deskKeys.all, 'schedule'] as const,
  scheduleNext: (count?: number) => [...deskKeys.all, 'scheduleNext', count ?? 10] as const,
  audit: (limit?: number) => [...deskKeys.all, 'audit', limit ?? 50] as const,
}

export const deviceKeys = {
  all: ['device'] as const,
  state: () => [...deviceKeys.all, 'state'] as const,
  screen: () => [...deviceKeys.all, 'screen'] as const,
  /**
   * One decoded framebuffer, under the fingerprint of what the board says is printed.
   *
   * The fingerprint IS the freshness signal here, which is why it is in the key rather than in a
   * `staleTime`: nothing but a change to those fields can change those pixels, and a clock cannot
   * tell you that a 25-second refresh happened. A new key is a new sheet; the old one is not stale,
   * it is gone.
   */
  screenAt: (fingerprint: string) => [...deviceKeys.screen(), fingerprint] as const,
}

// ---------------------------------------------------------------------------
// The desk client, and the settings it is built from.
//
// Settings live in a react-query cache of their own rather than component state, for the one
// property that matters here: `invalidateDeskSettings()` can force every hook below to re-read
// storage and rebuild its client without either of them knowing the other exists.
// ---------------------------------------------------------------------------

function useDeskSettingsQuery() {
  return useQuery({
    queryKey: deskKeys.settings(),
    queryFn: getDeskSettings,
    // Storage, not a server — nothing here goes stale on its own. The only reason to read it
    // again is `invalidateDeskSettings()`, called after Settings writes a new value.
    staleTime: Infinity,
  })
}

/** Call after Settings saves a new desk address or token, so every open screen picks it up. */
export function invalidateDeskSettings(): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: deskKeys.settings() })
}

/** The desk client, or `null` while settings are still loading or no desk is configured. */
export function useDeskClient(): DeskClient | null {
  const { data } = useDeskSettingsQuery()
  return useMemo(() => {
    if (!data?.baseUrl) return null
    return createDeskClient({ baseUrl: data.baseUrl, token: data.token ?? '' })
  }, [data?.baseUrl, data?.token])
}

// ---------------------------------------------------------------------------
// Desk reads.
// ---------------------------------------------------------------------------

export function useDeskState() {
  const client = useDeskClient()
  return useQuery({
    queryKey: deskKeys.state(),
    queryFn: () => client!.getState(),
    enabled: client !== null,
    staleTime: 10_000,
    // Fires only while the app is foregrounded — react-query's own rule once `focusManager` is
    // wired to AppState (see RootLayout), which is why this is not a setInterval of its own.
    refetchInterval: 15_000,
  })
}

/** `news.json`, the same bytes the board polls. Anonymous — needs no token, so no desk gate. */
export function useNews() {
  const client = useDeskClient()
  return useQuery({
    queryKey: deskKeys.news(),
    queryFn: () => client!.getNews(),
    enabled: client !== null,
  })
}

export function useEditions() {
  const client = useDeskClient()
  return useQuery({
    queryKey: deskKeys.editions(),
    queryFn: () => client!.listEditions(),
    enabled: client !== null,
  })
}

export function useEdition(eid: string) {
  const client = useDeskClient()
  return useQuery({
    queryKey: deskKeys.edition(eid),
    queryFn: () => client!.getEdition(eid),
    enabled: client !== null && eid !== '',
  })
}

/** A proof sheet's address, for an `<Image source={{uri, headers}}>` — never the bytes. */
export interface SheetSource {
  uri: string
  headers: Record<string, string>
}

export function useSheet(eid: string, name: string) {
  const client = useDeskClient()
  return useQuery<SheetSource>({
    queryKey: deskKeys.sheet(eid, name),
    queryFn: () => Promise.resolve({ uri: client!.sheetUrl(eid, name), headers: client!.sheetHeaders() }),
    enabled: client !== null && eid !== '' && name !== '',
    // The URL and the header are derived from the base URL and the token, neither of which
    // changes without `invalidateDeskSettings()` — which already tears this client down.
    staleTime: Infinity,
  })
}

export function useNotes(kind: NotesKind, id: string) {
  const client = useDeskClient()
  return useQuery({
    queryKey: deskKeys.notes(kind, id),
    queryFn: () => client!.getNotes(kind, id),
    enabled: client !== null && id !== '',
  })
}

export function useWatchlist() {
  const client = useDeskClient()
  return useQuery({
    queryKey: deskKeys.watchlist(),
    queryFn: () => client!.getWatchlist(),
    enabled: client !== null,
  })
}

/** `null` symbols never reach the desk (a 400) — the same "hide the tab" rule the desk itself uses. */
export function useQuotes(symbols: readonly string[]) {
  const client = useDeskClient()
  return useQuery({
    queryKey: deskKeys.quotes(symbols),
    queryFn: () => client!.getQuotes([...symbols]),
    enabled: client !== null && symbols.length > 0,
    // Alpaca snapshots are cached a minute upstream; asking the desk again inside that window
    // would only spend a round trip to receive the same numbers back.
    staleTime: 60_000,
  })
}

export function useCommands(status?: string) {
  const client = useDeskClient()
  return useQuery({
    queryKey: deskKeys.commands(status),
    queryFn: () => client!.listCommands(status),
    enabled: client !== null,
  })
}

export function useDirectives() {
  const client = useDeskClient()
  return useQuery({
    queryKey: deskKeys.directives(),
    queryFn: () => client!.listDirectives(),
    enabled: client !== null,
  })
}

export function useSchedule() {
  const client = useDeskClient()
  return useQuery({
    queryKey: deskKeys.schedule(),
    queryFn: () => client!.getSchedule(),
    enabled: client !== null,
  })
}

export function useScheduleNext(count?: number) {
  const client = useDeskClient()
  return useQuery({
    queryKey: deskKeys.scheduleNext(count),
    queryFn: () => client!.getScheduleNext(count),
    enabled: client !== null,
  })
}

export function useAudit(limit?: number) {
  const client = useDeskClient()
  return useQuery({
    queryKey: deskKeys.audit(limit),
    queryFn: () => client!.getAudit(limit),
    enabled: client !== null,
  })
}

// ---------------------------------------------------------------------------
// The board (src/lib/esp32.ts, via DeviceProvider).
// ---------------------------------------------------------------------------

/**
 * The live board snapshot. `enabled` is the caller's call, not this hook's — Board and Today are
 * the only screens that poll it, and every other screen must not wake a sleeping board just by
 * being open.
 */
export function useDeviceState(enabled: boolean) {
  const { client } = useDevice()
  return useQuery({
    queryKey: deviceKeys.state(),
    queryFn: () => client!.getState(),
    enabled: enabled && client !== null,
    staleTime: 5_000,
    refetchInterval: 5_000,
  })
}

/**
 * The framebuffer, decoded, as a base64 PNG — the page actually on the glass.
 *
 * Three things are load-bearing here and none of them is the fetch.
 *
 * THE KEY IS THE FINGERPRINT (src/lib/screencache.ts). `staleTime: Infinity` is only honest
 * because of it: the pixels cannot change without one of those fields changing, so time tells you
 * nothing and the key tells you everything. A board that redraws gets a new key and a new read; a
 * board that has quietly done nothing all afternoon is never asked for a megabyte again.
 *
 * THE MODULE CACHE IS THE STORE, react-query is the plumbing. `screenCacheGet` is consulted inside
 * the query function, so a remount after react-query has garbage-collected its entry still costs
 * nothing — and, more to the point, exactly ONE 2.6 MB decode is resident however many times this
 * mounts. Leaving it to `gcTime` would keep a second reference alive for five minutes for free.
 *
 * THE YIELD BEFORE THE DECODE is not a stylistic `await`. Everything after it is synchronous and
 * takes a beat: 1.92 million pixels expanded out of 960,000 bytes, deflated, and base64'd, all on
 * the one JS thread there is. Without it the spinner is mounted but never painted.
 *
 * `enabled` is the caller's call. A megabyte off a board that may be asleep is not something a
 * screen should spend just by existing — only the two that are ABOUT the glass ask for it.
 */
export function useBoardScreen(state: ScreenIdentity | undefined, enabled: boolean) {
  const { client } = useDevice()
  const fingerprint = screenFingerprint(state)
  return useQuery<string>({
    queryKey: deviceKeys.screenAt(fingerprint),
    queryFn: async () => {
      const cached = screenCacheGet(fingerprint)
      if (cached) return cached
      const fb = await client!.fetchScreen()
      await new Promise((resolve) => setTimeout(resolve, 0))
      const png = decode(fb).pngBase64
      screenCachePut(fingerprint, png)
      return png
    },
    // No fingerprint means the board has not answered `/api/state`, so there would be no way to
    // know when to throw the result away. Not asking is the correct behaviour, not a limitation.
    enabled: enabled && client !== null && fingerprint !== '',
    staleTime: Infinity,
    gcTime: 60_000,
  })
}

// ---------------------------------------------------------------------------
// Mutations. Each invalidates only the keys its own write can have changed.
// ---------------------------------------------------------------------------

function useDeskMutation<TVariables, TData>(
  mutationFn: (client: DeskClient, vars: TVariables) => Promise<TData>,
  invalidates: (data: TData, vars: TVariables) => readonly QueryKey[],
) {
  const client = useDeskClient()
  return useMutation<TData, DeskError, TVariables>({
    mutationFn: (vars: TVariables) => {
      if (!client) return Promise.reject(new DeskError('network', 'no desk configured'))
      return mutationFn(client, vars)
    },
    onSuccess: (data, vars) => {
      for (const key of invalidates(data, vars)) {
        queryClient.invalidateQueries({ queryKey: key })
      }
    },
  })
}

function useDeviceMutation<TVariables, TData>(
  mutationFn: (client: Esp32Client, vars: TVariables) => Promise<TData>,
) {
  const { client } = useDevice()
  return useMutation<TData, Esp32Error, TVariables>({
    mutationFn: (vars: TVariables) => {
      if (!client) return Promise.reject(new Esp32Error('network_error', 'no board configured'))
      return mutationFn(client, vars)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: deviceKeys.state() })
    },
  })
}

type OrderInput = Omit<PostCommandInput, 'kind'>

/** "Order an edition" — a command the queue treats like any other, `kind: 'file_edition'`. */
export function useOrderEdition() {
  return useDeskMutation<OrderInput, Awaited<ReturnType<DeskClient['postCommand']>>>(
    (client, vars) => client.postCommand({ ...vars, kind: 'file_edition' }),
    () => [deskKeys.commands(), deskKeys.state()],
  )
}

/** "Research this one" — `kind: 'research'`, which the worker never turns into a draft. */
export function useResearch() {
  return useDeskMutation<OrderInput, Awaited<ReturnType<DeskClient['postCommand']>>>(
    (client, vars) => client.postCommand({ ...vars, kind: 'research' }),
    () => [deskKeys.commands(), deskKeys.state()],
  )
}

/** The composer's free-text instruction — `kind: 'custom'`. */
export function useCustomCommand() {
  return useDeskMutation<OrderInput, Awaited<ReturnType<DeskClient['postCommand']>>>(
    (client, vars) => client.postCommand({ ...vars, kind: 'custom' }),
    () => [deskKeys.commands(), deskKeys.state()],
  )
}

export function useCancelCommand() {
  return useDeskMutation<string, void>(
    (client, id) => client.cancelCommand(id),
    () => [deskKeys.commands(), deskKeys.state()],
  )
}

export function useHold() {
  return useDeskMutation<number | null, number | null>(
    (client, until) => client.hold(until),
    () => [deskKeys.state(), deskKeys.audit()],
  )
}

export function usePublish() {
  return useDeskMutation<void, Awaited<ReturnType<DeskClient['publish']>>>(
    (client) => client.publish(),
    // Publishing changes what /news.json serves — a Today screen left open must not keep
    // showing the old edition until its next unrelated refetch.
    () => [deskKeys.state(), deskKeys.editions(), deskKeys.audit(), deskKeys.news()],
  )
}

export function usePromote() {
  return useDeskMutation<string, Awaited<ReturnType<DeskClient['promote']>>>(
    (client, eid) => client.promote(eid),
    () => [deskKeys.state(), deskKeys.editions(), deskKeys.audit(), deskKeys.news()],
  )
}

export function useAddDirective() {
  return useDeskMutation<AddDirectiveInput, Awaited<ReturnType<DeskClient['addDirective']>>>(
    (client, input) => client.addDirective(input),
    () => [deskKeys.directives()],
  )
}

export function useDeleteDirective() {
  return useDeskMutation<string, void>(
    (client, id) => client.deleteDirective(id),
    () => [deskKeys.directives()],
  )
}

export function usePutSchedule() {
  return useDeskMutation<Schedule, Awaited<ReturnType<DeskClient['putSchedule']>>>(
    (client, doc) => client.putSchedule(doc),
    () => [deskKeys.schedule(), deskKeys.scheduleNext(), deskKeys.state()],
  )
}

export function useSetPage() {
  return useDeviceMutation<number, void>((client, page) => client.setPage(page))
}

export function useRefreshBoard() {
  return useDeviceMutation<void, void>((client) => client.refresh())
}

export function useSetSleep() {
  return useDeviceMutation<number, void>((client, seconds) => client.setSleep(seconds))
}

export function useDisplayTest() {
  return useDeviceMutation<void, void>((client) => client.displayTest())
}

// ---------------------------------------------------------------------------
// AppState wiring. Called once from RootLayout — react-query's `refetchInterval` already skips a
// backgrounded app once `focusManager` knows it, so this is the only line that has to exist for
// "while focused" to be true above rather than merely documented.
// ---------------------------------------------------------------------------

export function onAppStateChange(status: string): void {
  focusManager.setFocused(status === 'active')
}
