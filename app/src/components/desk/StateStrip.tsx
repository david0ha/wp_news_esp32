import { type ReactNode, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useRouter } from 'expo-router'
import Animated, { useReducedMotion } from 'react-native-reanimated'
import { Card } from '../Card'
import { Stamp } from '../Stamp'
import { useDeskNow, useNews, useScheduleNext } from '../../lib/queries'
import { formatWhen } from '../../lib/format'
import { transitionClock } from '../../lib/scheduleform'
import type { DeskState, ScheduleEvent } from '../../lib/desk'
import { colors, pressTransition, pressedScale, spacing, typography } from '../../theme/index'

/**
 * What the desk is holding, in four rows — plan Design > Wireframes ("Current SNDK · 06:04 /
 * Staged none ⇢ view / Next 06:00 daily").
 *
 * The STAGED row is the one this screen exists for. "Preview before it goes up" is the plan's own
 * phrase for it: an edition that is staged has been through both gates and is waiting for a
 * boundary, and the only way to see it before twenty-five seconds of panel refresh commit it to
 * the wall is its proof sheet. So that row opens `sheet/proof`, not the edition record — the paper
 * is the thing being previewed, and one tap is the whole point.
 *
 * The CURRENT row opens the edition record instead, because "what is up" is a question about the
 * publication (when it went up, what was filed beside it) rather than about the page — the page is
 * already on the wall in the room.
 */
export function StateStrip({ state }: { state: DeskState | undefined }) {
  const router = useRouter()
  const next = useScheduleNext(1)
  // The company the current edition is about. `news.json` IS the current edition, so this names
  // the `current` row and never the staged one — a staged edition is a different company as often
  // as not, and borrowing this symbol for it would be the app stating a fact it does not have.
  const news = useNews()

  const current = state?.current ?? null
  const staged = state?.staged ?? null
  const hold = state?.hold ?? null
  const transition = next.data?.[0]

  const symbol = news.data?.subject.symbol ?? ''
  // `formatWhen` and not `formatSinceTime`: both instants on this strip are compared against the
  // desk's own `now`, and a bare clock reading is only unambiguous on the day it falls. An edition
  // published on Tuesday and a hold running until tomorrow would otherwise both print as a time
  // that reads as today — the second of those actively invites the reader to set another hold.
  // On the ordinary same-day path this is character-identical to the clock alone.
  const now = useDeskNow()
  const publishedAt = state?.lastPublishAt ? formatWhen(state.lastPublishAt, now) : ''

  return (
    <Card style={styles.card}>
      <StripRow
        label="Current"
        value={
          current === null
            ? 'nothing published yet'
            : [symbol, publishedAt].filter((s) => s !== '').join(' · ') || shortId(current)
        }
        dim={current === null}
        onPress={current === null ? undefined : () => router.push(`/editions/${encodeURIComponent(current)}`)}
      />
      <StripRow
        label="Staged"
        value={staged === null ? 'none' : shortId(staged)}
        dim={staged === null}
        stamp={staged === null ? undefined : 'staged'}
        // A1, the front page: `sheet/[source]` defaults `page` to 0, and the front page is what
        // "preview before it goes up" means to somebody standing in front of the wall.
        onPress={staged === null ? undefined : () => router.push(`/sheet/proof?eid=${encodeURIComponent(staged)}`)}
      />
      {/* Two lines, because one would not hold both: the desk's `local` is "2026-08-31 22:00
          KST" and the reason it names is a clause, not a word. The instant on top and what it is
          underneath — the row answers "when" first, which is what a strip is read for. */}
      <StripRow
        label="Next"
        value={
          transition === undefined
            ? next.isLoading
              ? '—'
              : 'nothing scheduled'
            : transitionClock(transition.local)
        }
        sub={transition === undefined ? undefined : transitionLabel(transition.what)}
        dim={transition === undefined}
      />
      <StripRow
        label="Hold"
        value={hold === null ? 'publishing normally' : `held until ${formatWhen(hold, now)}`}
        dim={hold === null}
        stamp={hold === null ? undefined : 'held'}
        last
      />
    </Card>
  )
}

/** Edition ids are hex fingerprints; eight characters is what the desk's own logs print. */
function shortId(eid: string): string {
  return eid.slice(0, 8)
}

/**
 * What a transition is, in the words of somebody who owns the paper rather than the scheduler.
 *
 * `unknown` is a real arm and not a default: `parseTransition()` lands there for an event name this
 * app does not know, and printing the desk's own token would be better than nothing but worse than
 * saying plainly that the time is known and the reason is not.
 */
function transitionLabel(what: ScheduleEvent): string {
  switch (what) {
    case 'quiet_start':
      return 'the quiet window starts'
    case 'quiet_end':
      return 'the quiet window ends'
    case 'wake':
      return 'the worker wakes'
    default:
      return 'something the desk has scheduled'
  }
}

/**
 * One row. Pressable ones carry a chevron; the others carry nothing where it would be, so a row
 * that leads somewhere is distinguishable from one that does not without reading the label.
 */
function StripRow({
  label,
  value,
  sub,
  stamp,
  dim = false,
  last = false,
  onPress,
}: {
  label: string
  value: string
  sub?: string
  stamp?: string
  dim?: boolean
  last?: boolean
  onPress?: () => void
}) {
  const [pressed, setPressed] = useState(false)
  const reducedMotion = useReducedMotion()
  const body: ReactNode = (
    <>
      <Text style={[typography.ui, styles.label]}>{label}</Text>
      <View style={styles.valueColumn}>
        <View style={styles.valueWrap}>
          <Text style={[typography.ui, styles.value, dim && styles.valueDim]} numberOfLines={1}>
            {value}
          </Text>
          {stamp ? <Stamp tone="chrome">{stamp}</Stamp> : null}
        </View>
        {sub ? (
          <Text style={styles.sub} numberOfLines={1}>
            {sub}
          </Text>
        ) : null}
      </View>
      {onPress ? (
        <Ionicons name="chevron-forward" size={16} color={colors.deskFaint} style={styles.chevron} />
      ) : (
        <View style={styles.chevron} />
      )}
    </>
  )

  if (!onPress) {
    return <View style={[styles.row, !last && styles.bordered]}>{body}</View>
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${label}: ${value}`}
      onPress={onPress}
      onPressIn={() => setPressed(true)}
      onPressOut={() => setPressed(false)}
    >
      <Animated.View
        style={[
          styles.row,
          pressTransition,
          !last && styles.bordered,
          pressed && !reducedMotion && pressedScale,
        ]}
      >
        {body}
      </Animated.View>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  // `padding: 0` only — `<Card>` already sets the radius and the continuous curve, and repeating
  // them here would quietly keep the old ones the day that primitive's radius changes.
  card: {
    padding: 0,
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 48,
    paddingVertical: spacing[12],
    paddingLeft: spacing[16],
    paddingRight: spacing[12],
    gap: spacing[12],
  },
  bordered: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.deskFaint,
  },
  label: {
    fontSize: 14,
    color: colors.deskDim,
    width: 72,
  },
  valueColumn: {
    flex: 1,
    alignItems: 'flex-end',
    gap: 2,
  },
  valueWrap: {
    maxWidth: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: spacing[8],
  },
  value: {
    fontSize: 14,
    color: colors.deskText,
    flexShrink: 1,
    textAlign: 'right',
  },
  valueDim: {
    color: colors.deskFaint,
  },
  sub: {
    ...typography.ui,
    fontSize: 12,
    color: colors.deskFaint,
  },
  // Always 16 wide, chevron or not, so the values in a strip line up on their right edge rather
  // than stepping in and out with whichever rows happen to lead somewhere.
  chevron: {
    width: 16,
  },
})
