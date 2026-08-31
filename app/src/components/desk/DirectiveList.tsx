import { useState } from 'react'
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import * as Haptics from 'expo-haptics'
import { Button } from '../Button'
import { Card } from '../Card'
import { ScreenMessage } from '../ScreenMessage'
import { Stamp } from '../Stamp'
import { useAddDirective, useDeleteDirective, useDeskNow, useDirectives } from '../../lib/queries'
import { DeskError, deskHumanError, type Directive } from '../../lib/desk'
import { formatPrintedDate } from '../../lib/format'
import { canRestoreDirective } from '../../lib/directives'
import { colors, radius, spacing, typography } from '../../theme/index'

/**
 * The standing rules — "Never lead with executive compensation."
 *
 * The distinction from the queue is the one most easily got wrong and it is silent when it goes
 * wrong (desk.ts's `Command` docstring): a standing rule filed as a command applies to exactly one
 * edition, after which the desk forgets it and its owner concludes the system ignored them. So the
 * two live in separate sections with separate controls, and nothing here can reach the queue.
 *
 * REMOVING ONE IS UNDOABLE, and that is not decoration. The tab's "nothing here asks are you sure"
 * argument (desk.tsx) rests on every action being reversible on the desk's own terms — a hold lifts,
 * a command re-queues, an edition promotes. A directive is the exception: its text exists only in
 * the desk's row, so a mis-tapped ✕ means retyping a rule from memory. Rather than make this the one
 * screen with a confirm dialog, the removed rule is held here and offered back — scope and expiry
 * included, which `addDirective` can restore for both scopes. The id changes; the rule does not.
 * The offer is withheld where re-filing would not actually put anything back: see
 * `canRestoreDirective()`, whose whole subject is that every such case fails silently.
 *
 * WHAT THIS EDITOR CANNOT DO: file an `until` directive. The desk takes a scope of 'always' or
 * 'until', and 'until' needs an `expires_at` instant — a date the phone would have to collect
 * through a picker whose whole job is to produce one number. Rules with an expiry still LIST here
 * and can still be removed here; they are written from the vault, which is where the ones that
 * exist came from. Adding the picker is a bigger change than it looks and belongs to whoever needs
 * one, not to the tab that was built without knowing.
 */
export function DirectiveList() {
  const directives = useDirectives()
  const add = useAddDirective()
  const remove = useDeleteDirective()
  const [rule, setRule] = useState('')
  /** The last rule removed from this screen, kept only so it can be put back. */
  const [removed, setRemoved] = useState<Directive | null>(null)

  const now = useDeskNow()
  const trimmed = rule.trim()
  // Held rules whose undo would be a 200 that shows nothing are simply not offered — the guard is
  // on the OFFER rather than on the press, so there is never a button that reports success and
  // leaves the list unchanged.
  const restorable = removed !== null && canRestoreDirective(removed, now)

  const onAdd = () => {
    if (trimmed === '') return
    add.mutate(
      { rule: trimmed, scope: 'always' },
      {
        onSuccess: () => {
          setRule('')
          setRemoved(null)
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)
        },
      },
    )
  }

  const onRemove = (directive: Directive) => {
    remove.mutate(directive.id, {
      onSuccess: () => {
        setRemoved(directive)
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)
      },
    })
  }

  const onUndo = () => {
    if (removed === null || !restorable) return
    add.mutate(
      // `expiresAt` only on an `until` scope: the desk refuses an `always` rule that carries one
      // and an `until` rule that does not, so the restored rule is spelled exactly as the removed
      // one was rather than flattened to the default. `canRestoreDirective` has already ruled out
      // the `until`-without-an-instant case, so this pair is exhaustive rather than a fallback.
      removed.scope === 'until' && removed.expires_at !== null
        ? { rule: removed.rule, scope: 'until', expiresAt: removed.expires_at }
        : { rule: removed.rule, scope: 'always' },
      {
        onSuccess: () => {
          setRemoved(null)
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)
        },
      },
    )
  }

  return (
    <Card style={styles.card}>
      {directives.isLoading ? (
        <View style={styles.message}>
          <ScreenMessage loading />
        </View>
      ) : directives.isError ? (
        <View style={styles.message}>
          <ScreenMessage
            error={
              directives.error instanceof DeskError
                ? deskHumanError(directives.error)
                : 'Couldn’t read the directives.'
            }
            onRetry={() => directives.refetch()}
          />
        </View>
      ) : (directives.data ?? []).length === 0 ? (
        <View style={styles.empty}>
          <Text style={[typography.uiStrong, styles.emptyTitle]}>Nothing standing</Text>
          <Text style={[typography.ui, styles.emptyBody]}>
            A directive holds for every edition from here until it is removed.
          </Text>
        </View>
      ) : (
        (directives.data ?? []).map((d) => (
          <DirectiveRow
            key={d.id}
            directive={d}
            removing={remove.isPending && remove.variables === d.id}
            onRemove={() => onRemove(d)}
          />
        ))
      )}

      {removed !== null ? (
        <View style={styles.undo}>
          <Text style={[typography.ui, styles.undoText]} numberOfLines={2}>
            Removed “{removed.rule}”
          </Text>
          {/* An expired rule is gone for good, and saying so is better than offering a button that
              cannot work: the desk would take the rule back and never list it again. */}
          {!restorable ? (
            <Text style={styles.undoNote}>
              That one had already run out, so there is nothing to put back.
            </Text>
          ) : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Put back: ${removed.rule}`}
            accessibilityState={{ disabled: add.isPending, busy: add.isPending }}
            disabled={add.isPending}
            hitSlop={8}
            onPress={onUndo}
            style={({ pressed }) => [styles.undoAction, pressed && styles.undoActionDown]}
          >
            <Text style={[typography.uiStrong, styles.undoActionText]}>Put it back</Text>
          </Pressable>
          )}
        </View>
      ) : null}

      <View style={styles.composer}>
        <TextInput
          value={rule}
          onChangeText={setRule}
          editable={!add.isPending}
          placeholder="A rule that holds for every edition"
          placeholderTextColor={colors.deskFaint}
          multiline
          style={[typography.ui, styles.input]}
          accessibilityLabel="A new directive"
        />
        {/* `primary`, not `secondary`, because this one is INSIDE a card: the secondary fill is
            `deskRaised`, which is exactly what a `<Card>` is drawn in, and a button the same colour
            as its own ground is a label. The filled tint is the only variant that survives being
            put on a raised surface. */}
        <Button
          label="Add a directive"
          onPress={onAdd}
          loading={add.isPending && add.variables?.rule === trimmed}
          disabled={trimmed === '' || add.isPending}
        />
      </View>

      {add.isError ? <ErrorLine error={add.error} fallback="The desk didn’t take that rule." /> : null}
      {remove.isError ? (
        <ErrorLine error={remove.error} fallback="The desk didn’t remove that rule." />
      ) : null}
    </Card>
  )
}

function DirectiveRow({
  directive,
  removing,
  onRemove,
}: {
  directive: Directive
  removing: boolean
  onRemove: () => void
}) {
  return (
    <View style={styles.row}>
      <View style={styles.ruleWrap}>
        <Text style={[typography.ui, styles.rule]}>{directive.rule}</Text>
        <Stamp tone="chrome">{scopeStamp(directive)}</Stamp>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Remove: ${directive.rule}`}
        accessibilityState={{ disabled: removing, busy: removing }}
        disabled={removing}
        hitSlop={8}
        onPress={onRemove}
        style={({ pressed }) => [styles.remove, (pressed || removing) && styles.removeDown]}
      >
        <Text style={[typography.ui, styles.removeGlyph]}>✕</Text>
      </Pressable>
    </View>
  )
}

/**
 * "always", or the date the rule runs out.
 *
 * `expires_at` is UTC, printed through the same month table the paper's own stamps use — this is a
 * date on a stamp, not a clock reading, so it is the one `formatPrintedDate()` already spells.
 */
function scopeStamp(d: Directive): string {
  if (d.scope !== 'until' || d.expires_at === null) return 'always'
  const t = new Date(d.expires_at * 1000)
  const ymd = `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(
    t.getUTCDate(),
  ).padStart(2, '0')}`
  return `until ${formatPrintedDate(ymd)}`
}

function ErrorLine({ error, fallback }: { error: unknown; fallback: string }) {
  return (
    <Text style={styles.error}>
      {error instanceof DeskError ? deskHumanError(error) : fallback}
    </Text>
  )
}

const styles = StyleSheet.create({
  // `padding: 0` only — `<Card>` already sets the radius and the continuous curve.
  card: {
    padding: 0,
    overflow: 'hidden',
  },
  message: {
    minHeight: 100,
    justifyContent: 'center',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing[8],
    paddingVertical: spacing[12],
    paddingLeft: spacing[16],
    paddingRight: spacing[12],
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.deskFaint,
  },
  ruleWrap: {
    flex: 1,
    gap: spacing[4],
  },
  rule: {
    fontSize: 14,
    color: colors.deskText,
    lineHeight: 19,
  },
  remove: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: -6,
  },
  removeDown: {
    opacity: 0.45,
  },
  removeGlyph: {
    fontSize: 17,
    color: colors.deskDim,
  },
  undo: {
    padding: spacing[16],
    gap: spacing[8],
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.deskFaint,
  },
  undoText: {
    fontSize: 13,
    color: colors.deskDim,
    lineHeight: 18,
  },
  undoNote: {
    ...typography.ui,
    fontSize: 12,
    color: colors.deskFaint,
    lineHeight: 17,
  },
  undoAction: {
    minHeight: 32,
    justifyContent: 'center',
  },
  undoActionDown: {
    opacity: 0.55,
  },
  undoActionText: {
    fontSize: 14,
    color: colors.signal.chrome.tint,
  },
  composer: {
    padding: spacing[16],
    gap: spacing[12],
  },
  input: {
    minHeight: 64,
    color: colors.deskText,
    backgroundColor: colors.desk,
    borderRadius: radius.md,
    borderCurve: 'continuous',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.deskFaint,
    padding: spacing[12],
    textAlignVertical: 'top',
  },
  empty: {
    padding: spacing[16],
    gap: spacing[4],
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.deskFaint,
  },
  emptyTitle: {
    color: colors.deskText,
  },
  emptyBody: {
    color: colors.deskDim,
    lineHeight: 21,
  },
  error: {
    ...typography.ui,
    fontSize: 13,
    color: colors.signal.chrome.down,
    paddingHorizontal: spacing[16],
    paddingBottom: spacing[16],
    lineHeight: 18,
  },
})
