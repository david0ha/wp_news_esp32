import { useCallback, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useFocusEffect, useRouter } from 'expo-router'
import { ScheduleDayGroup } from './ScheduleDayGroup'
import { useEventBook } from '../lib/useEventBook'
import { upcomingView } from '../lib/schedule'
import { fill, useStrings } from '../i18n'
import { colors, fonts, space, type } from '../theme'

/** The spec's "next three". A display count and nothing else: `target` is the agent's filing goal
 *  and `rank` decided what it filed, and neither of them is allowed to reach a reader (ruling 21). */
const NEXT = 3

/**
 * The next three dates, at the top of the Markets tab, opening the whole book.
 *
 * THIS COMPONENT IS ALLOWED TO ADD AND NOTHING ELSE. Markets works today for somebody who has
 * never configured a desk, and after this change it must look exactly as it did: no new empty
 * state, no new spinner, no new error banner. Every one of those outcomes is `hidden` and this
 * renders `null` — the decision is `upcomingView`'s, made once and tested, rather than four
 * conditions spread through the JSX below.
 *
 * The block is the literal HEAD of `/schedule`'s own list, because both go through the same
 * `groupByDay`: the same events, in the same order, cut at the same midnight. Tapping through
 * must not look like a different book, and the way to guarantee that is to have one rule rather
 * than two that agree today.
 *
 * DAY HEADINGS AND NOT A FLAT LIST, which is why this reuses `ScheduleDayGroup` rather than
 * drawing three rows. The left rail is a CLOCK, so three rows reading `09:30 / 종일 / 21:30` with
 * nothing above them would leave the reader unable to tell tomorrow from next Friday — the one
 * thing a schedule has to say.
 *
 * `now` is read in the render body, once per pass, and passed down (ruling 23). No timer: a block
 * whose heading says 오늘 is re-rendered by the focus that brought the reader back to it, and a
 * `setTimeout` to midnight would be a wake-up on a tab nobody is looking at.
 */
export function UpcomingBlock() {
  const t = useStrings()
  const router = useRouter()
  const { ready, doc, book, failed, load } = useEventBook()
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())

  // The whole loop, and `useEdition`'s reason for having only this one: `useFocusEffect` fires on
  // mount as well as on every later return to the tab, so a separate mount effect would be a
  // second driver for the same event. The book changes about twice a day and the desk is on the
  // owner's own network, so a focus is the entire cadence — there is no interval here.
  useFocusEffect(
    useCallback(() => {
      void load()
    }, [load]),
  )

  const toggle = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const now = new Date()
  const view = upcomingView({ ready, doc, failed, now, limit: NEXT })
  if (view.kind !== 'events') return null

  return (
    <View style={styles.block}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t.schedule.a11y.openSchedule}
        onPress={() => router.push('/schedule')}
        hitSlop={8}
        style={({ pressed }) => [styles.head, pressed && styles.pressed]}
      >
        <Text style={styles.title}>{t.schedule.upcoming.title}</Text>
        <View style={styles.seeAll}>
          {/* The count is the whole book, not the three below it — that difference is the reason
              to tap, and a bare "See all" over a book of exactly three would be a lie by omission
              in the other direction. */}
          <Text style={styles.seeAllText} numberOfLines={1}>
            {fill(t.schedule.upcoming.seeAll, { n: String(view.count + view.more) })}
          </Text>
          <Ionicons name="chevron-forward" size={14} color={colors.accent} />
        </View>
      </Pressable>

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
    </View>
  )
}

const styles = StyleSheet.create({
  block: {
    gap: space.md,
    marginBottom: space.lg,
  },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.sm,
  },
  title: {
    ...type.headingSm,
  },
  pressed: {
    opacity: 0.7,
  },
  seeAll: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
  },
  seeAllText: {
    fontFamily: fonts.semibold,
    fontSize: 14,
    color: colors.accent,
  },
})
