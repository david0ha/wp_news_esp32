import { useCallback, useEffect, useRef, useState } from 'react'
import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useRouter } from 'expo-router'
import { Screen } from '../components/Screen'
import { BackButton } from '../components/BackButton'
import { Card } from '../components/Card'
import { ScreenMessage } from '../components/ScreenMessage'
import { ScheduleDayGroup } from '../components/ScheduleDayGroup'
import { createDeskClient, humanDeskError } from '../lib/desk'
import { getDeskBaseUrl } from '../lib/store'
import { getDeskToken } from '../lib/deskToken'
import { scheduleView, type CalendarDoc } from '../lib/schedule'
import { type PositionsDoc } from '../lib/positions'
import { useStrings } from '../i18n'
import { colors, fonts, layout, space, type } from '../theme'

/**
 * The event book, grouped by day: what is about to happen, and what it does to what the owner
 * holds.
 *
 * TWO DOCUMENTS, ONE PASS, AND ONLY ONE OF THEM CAN FAIL THIS SCREEN. `/api/calendar` is the
 * page; `/api/positions` only turns `p_1f05f8` into "AAAA 11월 21일 만기 420 콜". So the positions
 * are fetched beside the book and a failure of theirs is swallowed — every row still renders,
 * with the date, the reason and the direction intact, and only the name of the position missing.
 * Failing the whole screen over the decoration would be losing nine dates to protect a label.
 *
 * `now` is captured once per load rather than read per row, so every heading on the screen agrees
 * about which day is 오늘 — a list that read the clock per group could straddle midnight and print
 * two of them.
 *
 * The token is read for the call and gone with the frame, `PositionSheet`'s rule: it lives in the
 * keychain, reaches exactly one header inside `createDeskClient`, and is in no state this
 * component holds. Nothing rendered can carry what nothing rendered holds.
 */
export default function Schedule() {
  const router = useRouter()
  const t = useStrings()

  // Three-valued on purpose, like the Board tab's `hasDevice`: `null` is "storage has not
  // answered", which is not the same as "no desk saved" and must not draw the same sentence.
  const [ready, setReady] = useState<boolean | null>(null)
  // `undefined` is "not fetched"; `null` is a desk that answered and has no book.
  const [doc, setDoc] = useState<CalendarDoc | null | undefined>(undefined)
  const [book, setBook] = useState<PositionsDoc | null>(null)
  const [now, setNow] = useState(() => new Date())
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())

  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const load = useCallback(async () => {
    const [address, token] = await Promise.all([getDeskBaseUrl(), getDeskToken()])
    if (!alive.current) return
    if (!address || !token) {
      setReady(false)
      return
    }
    setReady(true)
    const client = createDeskClient({ baseUrl: address, token })
    try {
      const [calendar, positions] = await Promise.all([
        client.calendar(),
        client.positions().catch(() => null),
      ])
      if (!alive.current) return
      setDoc(calendar)
      setBook(positions)
      setNow(new Date())
      setError(null)
    } catch (e) {
      if (!alive.current) return
      setError(humanDeskError(e))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const onRefresh = useCallback(async () => {
    setRefreshing(true)
    try {
      await load()
    } finally {
      if (alive.current) setRefreshing(false)
    }
  }, [load])

  const toggle = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  // Back is the only exit — this is a root-stack route with no tab bar under it — and a deep link
  // into a cold process leaves nothing to go back TO, so the arrow falls back to the tab this
  // screen is opened from rather than to silence. `preview.tsx` says the whole argument.
  const header = (
    <View style={styles.titleRow}>
      <BackButton
        onPress={() => (router.canGoBack() ? router.back() : router.replace('/markets'))}
      />
      <Text style={styles.title}>{t.schedule.title}</Text>
      <View style={styles.backSpacer} />
    </View>
  )

  // Storage has not answered yet. Half-known is unknown: drawing the "add your desk" sentence for
  // one frame of every cold launch would send an owner who HAS a desk to go and set one up.
  if (ready === null) {
    return (
      <Screen>
        {header}
        <ScreenMessage loading />
      </Screen>
    )
  }

  // A first fetch that failed is an ERROR with a retry, not an empty state. "Nothing coming up"
  // over a desk nobody managed to ask would be the app answering a question on its behalf.
  if (ready && doc === undefined) {
    return (
      <Screen>
        {header}
        {error !== null ? (
          <ScreenMessage error={error} onRetry={() => void load()} />
        ) : (
          <ScreenMessage loading />
        )}
      </Screen>
    )
  }

  const view = scheduleView({ ready, doc: doc ?? null, now })

  return (
    <Screen>
      {header}
      <ScrollView
        contentContainerStyle={[styles.scroll, view.kind !== 'book' && styles.scrollEmpty]}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent} />
        }
      >
        {view.kind === 'book' ? (
          <>
            {view.groups.map((group) => (
              <ScheduleDayGroup
                key={group.date}
                group={group}
                now={now}
                book={book}
                expanded={expanded}
                onToggle={toggle}
              />
            ))}

            {/* The book fell short of its target and said why. Drawn at the FOOT and as prose,
                because it is a note about the list above it rather than an entry in it — the
                design's §4: when fewer clear the floor the screen says so and does not draw
                empty slots. */}
            {view.shortfall !== null ? (
              <Card style={styles.shortfall}>
                <Text style={styles.shortfallLabel}>{t.schedule.shortfallLabel}</Text>
                <Text style={type.caption}>{view.shortfall}</Text>
              </Card>
            ) : null}

            {/* A refresh that failed over a book already on screen, said out loud under it. The
                book stays: it is still the last thing the desk actually said. */}
            {error !== null ? <Text style={styles.error}>{error}</Text> : null}
          </>
        ) : (
          <ScreenMessage message={t.schedule.empty[EMPTY_KEY[view.kind]]} />
        )}
      </ScrollView>
    </Screen>
  )
}

/** The three empties, each to its own sentence — `scheduleView` says why they are three facts. */
const EMPTY_KEY = {
  needs_desk: 'needsDesk',
  no_book: 'noBook',
  nothing_upcoming: 'nothingUpcoming',
} as const

const styles = StyleSheet.create({
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: layout.gutter,
    height: 56,
  },
  title: {
    fontFamily: fonts.bold,
    fontSize: 18,
    color: colors.text,
  },
  backSpacer: {
    width: 42,
  },
  scroll: {
    paddingHorizontal: layout.gutter,
    paddingBottom: space.xxl,
    gap: space.lg,
  },
  scrollEmpty: {
    flexGrow: 1,
  },
  shortfall: {
    gap: space.xs,
  },
  shortfallLabel: {
    ...type.label,
  },
  error: {
    fontSize: 14,
    color: colors.down,
    textAlign: 'center',
    lineHeight: 20,
  },
})
