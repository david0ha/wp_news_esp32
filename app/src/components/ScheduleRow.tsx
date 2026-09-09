import { Linking, Pressable, StyleSheet, Text, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import {
  directionColour,
  directionLabel,
  eventDirection,
  positionLine,
  sourceBadge,
  timeLabel,
  type CalendarEvent,
} from '../lib/schedule'
import { type PositionsDoc } from '../lib/positions'
import { fill, useStrings } from '../i18n'
import { colors, fonts, space, tabular, type } from '../theme'

/**
 * One line of the event book: when, what, what it does to a position the owner holds, and where
 * the date came from.
 *
 * `EventRow`'s construction — a left element, a title block, a right value, and `last` for the
 * hairline — with the icon well replaced by the TIME RAIL, because on this screen the left column
 * is the one piece of information every row must carry and a kind icon is not. The rail renders
 * exactly the precision the event has (`timeLabel`), so a date known only to the day says 종일 and
 * never a clock nobody published.
 *
 * The right rail is what the date means to THIS owner rather than what a calendar site ranks it,
 * in the theme's measured up/down pair — see `directionColour` for why green stays up.
 *
 * The badge is the design's §2 made visible. A computed date carries none, because it is not in
 * question; a researched one carries the domain it was read at and opens it. A reader can always
 * tell the two kinds apart without being told which is which — unconditionally, which is what the
 * third arm is for: a researched date whose host could not be named still draws the mark, and
 * draws it as a mark rather than as a link.
 *
 * Closed, the row shows the FIRST position the event reaches and one sentence about it. Opened,
 * it shows every one of them and the whole paragraph — Toss's *한 화면, 한 기능*, and the reason
 * the closed row names how many more there are rather than silently holding them.
 */
export function ScheduleRow({
  event,
  book,
  now,
  expanded,
  onToggle,
  last = false,
}: {
  event: CalendarEvent
  /** The positions the desk holds, for naming the ones this event reaches. `null` before the book
   *  has arrived — the event still renders, without the name. */
  book: PositionsDoc | null
  /** The reader's own instant, passed down rather than read here: the countdown on this row and
   *  the day heading above it must agree about what today is. */
  now: Date
  expanded: boolean
  onToggle: () => void
  last?: boolean
}) {
  const t = useStrings()
  const direction = eventDirection(event)
  const badge = sourceBadge(event)
  const shown = expanded ? event.affects : event.affects.slice(0, 1)
  const hidden = event.affects.length - shown.length

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={event.title}
      accessibilityHint={expanded ? t.schedule.a11y.collapse : t.schedule.a11y.expand}
      accessibilityState={{ expanded }}
      onPress={onToggle}
      style={({ pressed }) => [styles.row, !last && styles.bordered, pressed && styles.pressed]}
    >
      <View style={styles.rail}>
        <Text style={[styles.time, tabular]} numberOfLines={2}>
          {timeLabel(event, t)}
        </Text>
      </View>

      <View style={styles.body}>
        <View style={styles.titleRow}>
          <Text style={styles.title} numberOfLines={expanded ? undefined : 2}>
            {event.title}
          </Text>
          <Text style={[styles.direction, { color: directionColour(direction) }]} numberOfLines={1}>
            {directionLabel(direction, t)}
          </Text>
        </View>

        {shown.map((affect, i) => {
          const name = positionLine(book, affect.positionId, t, now)
          return (
            // Keyed on the position in the list and not on `position_id`: `calendar.py` bounds
            // `affects` by length and checks that each id exists, never that they are distinct, so
            // one event may legitimately reach the SAME position twice — `for` by one mechanism
            // and `against` by another. Two blocks under one key is a duplicate-key warning and a
            // reconciliation React is entitled to get wrong.
            <View key={`${event.id}:${i}`} style={styles.affect}>
              {name !== '' ? (
                <Text style={styles.position} numberOfLines={1}>
                  {name}
                </Text>
              ) : null}
              <Text style={type.caption} numberOfLines={expanded ? undefined : 2}>
                {expanded && affect.reason !== '' ? affect.reason : affect.reasonShort}
              </Text>
            </View>
          )
        })}

        {hidden > 0 ? (
          <Text style={styles.more}>{fill(t.schedule.alsoAffects, { n: String(hidden) })}</Text>
        ) : null}

        {badge === null ? null : badge.host === '' ? (
          // A researched date whose host `sourceBadge` could not name — a malformed source, or one
          // carrying credentials, which is why `evil.test` is not printed as the authority of
          // `https://user:pass@evil.test/`. The MARK still draws, because it is the only thing on
          // the row that says a human read for this date and §8 promises a reader can always tell
          // the two kinds apart. What it must not do is offer a link: `fill(openSource, {host:''})`
          // announces a bare "Open" to a screen reader, and an unnamed link is also one this app
          // has decided it cannot vouch for — if we cannot say where it goes, we do not offer to
          // go there. So: not pressable — and NOT silent either. `accessible` collapses the icon
          // into one element carrying the label, so a screen reader hears what the mark means
          // instead of the icon font's private-use glyph, and §8's promise holds for a reader who
          // cannot see the mark: silence here is indistinguishable from a computed date, which
          // carries no badge at all. A label on a fact, with no role, because this is not a link.
          <View style={styles.badge} accessible accessibilityLabel={t.schedule.a11y.researched}>
            <Ionicons name="link-outline" size={13} color={colors.accent} />
          </View>
        ) : (
          <Pressable
            accessibilityRole="link"
            accessibilityLabel={fill(t.schedule.a11y.openSource, { host: badge.host })}
            hitSlop={8}
            // A refused open is silent on purpose: the row is still complete without it, and a
            // toast about a browser is not something the reader of a schedule can act on.
            onPress={() => {
              Linking.openURL(badge.url).catch(() => {})
            }}
            style={styles.badge}
          >
            <Ionicons name="link-outline" size={13} color={colors.accent} />
            <Text style={styles.badgeText} numberOfLines={1}>
              {badge.host}
            </Text>
          </Pressable>
        )}
      </View>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.md,
    paddingVertical: 12,
    paddingHorizontal: space.lg,
  },
  bordered: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  pressed: {
    backgroundColor: colors.surfaceAlt,
  },
  // Wide enough for 장 마감 후 on two lines and for a clock on one. Fixed, so every rail on the
  // screen aligns and the eye reads the column rather than each row's left edge.
  rail: {
    width: 58,
    paddingTop: 1,
  },
  time: {
    fontFamily: fonts.semibold,
    fontSize: 13,
    lineHeight: 18,
    color: colors.textDim,
  },
  // The spec's `│`: one hairline down the whole row, which is what makes the rail read as a rail
  // rather than as a first word.
  body: {
    flex: 1,
    gap: 4,
    paddingLeft: space.md,
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderLeftColor: colors.border,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.sm,
  },
  title: {
    flex: 1,
    fontFamily: fonts.semibold,
    fontSize: 15,
    lineHeight: 20,
    color: colors.text,
  },
  direction: {
    fontFamily: fonts.semibold,
    fontSize: 13,
    lineHeight: 20,
  },
  affect: {
    gap: 2,
  },
  position: {
    fontFamily: fonts.medium,
    fontSize: 13,
    lineHeight: 18,
    color: colors.text,
  },
  more: {
    ...type.caption,
    color: colors.textFaint,
  },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingTop: 2,
  },
  badgeText: {
    fontFamily: fonts.medium,
    fontSize: 12,
    color: colors.accent,
  },
})
