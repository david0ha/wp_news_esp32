import { useState } from 'react'
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import * as Haptics from 'expo-haptics'
import { Button } from '../Button'
import { Card } from '../Card'
import { ScreenMessage } from '../ScreenMessage'
import { Stamp } from '../Stamp'
import { useAddDirective, useDeleteDirective, useDirectives } from '../../lib/queries'
import { DeskError, deskHumanError, type Directive } from '../../lib/desk'
import { formatPrintedDate } from '../../lib/format'
import { colors, radius, spacing, typography } from '../../theme/index'

/**
 * The standing rules — "Never lead with executive compensation."
 *
 * The distinction from the queue is the one most easily got wrong and it is silent when it goes
 * wrong (desk.ts's `Command` docstring): a standing rule filed as a command applies to exactly one
 * edition, after which the desk forgets it and its owner concludes the system ignored them. So the
 * two live in separate sections with separate controls, and nothing here can reach the queue.
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

  const trimmed = rule.trim()

  const onAdd = () => {
    if (trimmed === '') return
    add.mutate(
      { rule: trimmed, scope: 'always' },
      {
        onSuccess: () => {
          setRule('')
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
            onRemove={() => remove.mutate(d.id)}
          />
        ))
      )}

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
          loading={add.isPending}
          disabled={trimmed === ''}
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
        accessibilityLabel="Remove"
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
  card: {
    padding: 0,
    overflow: 'hidden',
    borderRadius: radius.lg,
    borderCurve: 'continuous',
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
