import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import { Button } from './Button'
import { Card } from './Card'
import { Chip } from './Chip'
import { InfoRow } from './InfoRow'
import { fill, useStrings, type Strings } from '../i18n'
import { createDeskClient } from '../lib/desk'
import { getDeskToken } from '../lib/deskToken'
import { getDeskBaseUrl } from '../lib/store'
import {
  commitPosition,
  confirmationLine,
  fieldKey,
  legCountFor,
  maskDate,
  newDraft,
  validateDraft,
  SHAPES,
  type DraftErrors,
  type LegDraft,
  type PositionDraft,
  type Shape,
} from '../lib/positionDraft'
import { type OptionSide, type PositionsDoc } from '../lib/positions'
import { colors, fonts, layout, radius, space, tabular, type } from '../theme'

/**
 * The sheet where somebody says what they hold — spec §8's three steps, one decision at a time.
 *
 * 1. the shape: `[Stock] [Long call] [Long put] [Short call] [Short put] [Spread]`
 * 2. the leg form(s) that shape implies — expiry · strike · contracts · average price
 * 3. **the app says the name back**, and only then is there a Save button
 *
 * Step 3 is the reason this is a sheet with phases rather than a form with a submit. A strike typed
 * as 42 instead of 420 passes every check in `validateDraft` — it is a perfectly legal strike — and
 * the only thing that catches it is a person reading "AAAA Nov 21 42 Call 2 contracts" and knowing
 * that is not what they bought. So the name is a step somebody has to pass through, never a toast
 * that appears after the write it was supposed to prevent.
 *
 * The owner never picks a strategy from a taxonomy. They say what they bought; `strategyLabel`
 * names it, and for a spread the desk names it after the write (see `strategyFor`).
 *
 * ALL OF THE THINKING IS IN `lib/positionDraft.ts`. This file is chips, fields and three buttons.
 */
export function PositionSheet({
  symbol,
  onClose,
  onSaved,
}: {
  /** The ticker this sheet is about, or `null` for closed. */
  symbol: string | null
  onClose: () => void
  /** The book that is now in force, as the desk answered it. */
  onSaved?: (doc: PositionsDoc) => void
}) {
  const t = useStrings()
  const [draft, setDraft] = useState<PositionDraft | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [errors, setErrors] = useState<DraftErrors>({})
  const [banner, setBanner] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // `null` until storage has answered. Nothing is drawn about a missing desk before then: the two
  // states are indistinguishable in the data and completely different to a reader, which is the
  // same distinction `deskLanguageView` takes a `loaded` flag for.
  const [ready, setReady] = useState<boolean | null>(null)

  // The one handler here that awaits the network, and the sheet can be dismissed inside a
  // fifteen-second desk timeout.
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  // A fresh sheet every time one opens: an old draft behind a closed sheet is a position about a
  // company somebody is no longer looking at.
  useEffect(() => {
    if (symbol === null) return
    setDraft(null)
    setConfirming(false)
    setErrors({})
    setBanner(null)
    setBusy(false)
    let active = true
    void (async () => {
      const [address, token] = await Promise.all([getDeskBaseUrl(), getDeskToken()])
      // The token is weighed and dropped. It is never held in state, never rendered and never
      // logged; `save` reads it again for the one call that needs it.
      if (active) setReady(Boolean(address) && Boolean(token))
    })()
    return () => {
      active = false
    }
  }, [symbol])

  const pickShape = useCallback(
    (shape: Shape) => {
      if (symbol === null) return
      // Re-pressing the chip already lit would otherwise wipe a filled-in form.
      if (draft?.shape === shape) return
      setDraft(newDraft(symbol, shape))
      setConfirming(false)
      setErrors({})
      setBanner(null)
    },
    [draft, symbol],
  )

  const editLeg = useCallback((index: number, patch: Partial<LegDraft>) => {
    setDraft((prev) =>
      prev === null
        ? prev
        : { ...prev, legs: prev.legs.map((leg, i) => (i === index ? { ...leg, ...patch } : leg)) },
    )
  }, [])

  // Validated on the way to the confirmation, never on every keystroke: a message that appears
  // under a field somebody is still typing into is telling them they are wrong about a number they
  // have not finished saying.
  const checked = useMemo(
    () => (draft === null ? null : validateDraft(draft, t, Date.now())),
    [draft, t],
  )

  const goConfirm = () => {
    if (checked === null) return
    if (!checked.ok) {
      setErrors(checked.errors)
      return
    }
    setErrors({})
    setBanner(null)
    setConfirming(true)
  }

  const save = async () => {
    if (checked === null || !checked.ok) return
    setBusy(true)
    setBanner(null)
    // Read for this call and gone with the frame. The token lives in the keychain
    // (`deskToken.ts`), reaches exactly one header inside `createDeskClient`, and is deliberately
    // not in this component's state — nothing rendered can carry what nothing rendered holds.
    const [address, token] = await Promise.all([getDeskBaseUrl(), getDeskToken()])
    if (!address || !token) {
      if (alive.current) {
        setReady(false)
        setBusy(false)
      }
      return
    }
    const result = await commitPosition(
      createDeskClient({ baseUrl: address, token }),
      checked.position,
    )
    if (!alive.current) return
    setBusy(false)
    if (result.ok) {
      onSaved?.(result.doc)
      onClose()
      return
    }
    // The desk named a field: its own sentence goes under that field, and the catalogue's goes at
    // the top. `positions.py`'s `_bad` was written for exactly this reading.
    const { refusal } = result
    setBanner(refusal.message)
    if (refusal.fieldKey !== null && refusal.reason !== null) {
      setErrors({ [refusal.fieldKey]: refusal.reason })
      setConfirming(false)
    }
  }

  const line = checked?.ok === true ? confirmationLine(checked.position, t) : ''

  return (
    <Modal
      visible={symbol !== null}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <View style={styles.root}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t.common.cancel}
          style={styles.scrim}
          onPress={onClose}
        />
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={styles.lift}
        >
          <View style={styles.sheet}>
            <View style={styles.header}>
              <Text style={type.heading} numberOfLines={1}>
                {confirming ? t.positionSheet.confirmTitle : t.positionSheet.title}
              </Text>
              <Pressable
                accessibilityRole="button"
                onPress={onClose}
                hitSlop={8}
                style={({ pressed }) => (pressed ? styles.pressed : undefined)}
              >
                <Text style={styles.cancel}>{t.common.cancel}</Text>
              </Pressable>
            </View>

            <ScrollView
              style={styles.body}
              contentContainerStyle={styles.bodyContent}
              keyboardShouldPersistTaps="handled"
            >
              {banner !== null ? <Text style={styles.banner}>{banner}</Text> : null}

              {ready === false ? (
                <Text style={styles.help}>{t.positionSheet.needsDesk}</Text>
              ) : (
                <>
                  {/* The chips stay up while the form is being filled, so a wrong shape is one
                      tap to fix — and go away at the confirmation, which has one decision on it. */}
                  {confirming ? null : (
                    <View style={styles.chips}>
                      {SHAPES.map((shape) => (
                        <Chip
                          key={shape}
                          label={shapeLabel(shape, t)}
                          active={draft?.shape === shape}
                          onPress={() => pickShape(shape)}
                        />
                      ))}
                    </View>
                  )}

                  {draft === null ? (
                    <Text style={styles.help}>{t.positionSheet.help}</Text>
                  ) : confirming ? (
                    <Confirmation draft={draft} line={line} />
                  ) : (
                    <Form
                      draft={draft}
                      errors={errors}
                      onSide={(side) => setDraft({ ...draft, side })}
                      onQuantity={(quantity) => setDraft({ ...draft, quantity })}
                      onPrice={(price) => setDraft({ ...draft, price })}
                      onLeg={editLeg}
                    />
                  )}
                </>
              )}
            </ScrollView>

            {draft !== null && ready !== false ? (
              <View style={styles.footer}>
                {confirming ? (
                  <>
                    <Button label={t.positionSheet.save} onPress={() => void save()} loading={busy} />
                    <Button
                      label={t.positionSheet.edit}
                      variant="ghost"
                      onPress={() => setConfirming(false)}
                      disabled={busy}
                    />
                  </>
                ) : (
                  <Button label={t.positionSheet.continue} onPress={goConfirm} />
                )}
              </View>
            ) : null}
          </View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  )
}

function shapeLabel(shape: Shape, t: Strings): string {
  const s = t.positionSheet.shape
  switch (shape) {
    case 'stock':
      return s.stock
    case 'long_call':
      return s.longCall
    case 'long_put':
      return s.longPut
    case 'short_call':
      return s.shortCall
    case 'short_put':
      return s.shortPut
    default:
      return s.spread
  }
}

// ---------------------------------------------------------------------------
// The form
// ---------------------------------------------------------------------------

function Form({
  draft,
  errors,
  onSide,
  onQuantity,
  onPrice,
  onLeg,
}: {
  draft: PositionDraft
  errors: DraftErrors
  onSide: (side: OptionSide) => void
  onQuantity: (text: string) => void
  onPrice: (text: string) => void
  onLeg: (index: number, patch: Partial<LegDraft>) => void
}) {
  const t = useStrings()
  const f = t.positionSheet.fields

  if (draft.shape === 'stock') {
    return (
      <View style={styles.form}>
        {errors.symbol !== undefined ? <Text style={styles.error}>{errors.symbol}</Text> : null}
        <SidePicker side={draft.side} onPick={onSide} />
        <Field
          label={f.quantity}
          value={draft.quantity}
          onChangeText={onQuantity}
          error={errors[fieldKey(null, 'quantity')]}
          keyboardType="number-pad"
          maxLength={9}
        />
        <Field
          label={f.price}
          value={draft.price}
          onChangeText={onPrice}
          error={errors[fieldKey(null, 'price')]}
          hint={t.positionSheet.hints.sharePrice}
          keyboardType="decimal-pad"
          maxLength={16}
        />
      </View>
    )
  }

  return (
    <View style={styles.form}>
      {errors.symbol !== undefined ? <Text style={styles.error}>{errors.symbol}</Text> : null}
      {draft.legs.map((leg, i) => (
        <LegForm
          key={i}
          index={i}
          leg={leg}
          errors={errors}
          // A single-leg shape said its right and its side on the chip. Drawing them again would be
          // a second place to change one fact, and a form where the chip and the leg can disagree.
          pickable={legCountFor(draft.shape) > 1}
          numbered={draft.legs.length > 1}
          onChange={(patch) => onLeg(i, patch)}
        />
      ))}
    </View>
  )
}

function SidePicker({ side, onPick }: { side: OptionSide; onPick: (side: OptionSide) => void }) {
  const t = useStrings()
  return (
    <View style={styles.chips}>
      {(['long', 'short'] as const).map((one) => (
        <Chip
          key={one}
          label={t.positions.side[one]}
          active={side === one}
          onPress={() => onPick(one)}
        />
      ))}
    </View>
  )
}

function LegForm({
  index,
  leg,
  errors,
  pickable,
  numbered,
  onChange,
}: {
  index: number
  leg: LegDraft
  errors: DraftErrors
  pickable: boolean
  numbered: boolean
  onChange: (patch: Partial<LegDraft>) => void
}) {
  const t = useStrings()
  const f = t.positionSheet.fields
  return (
    <View style={styles.leg}>
      {numbered ? (
        <Text style={type.label}>{fill(t.positionSheet.leg, { n: String(index + 1) })}</Text>
      ) : null}
      {pickable ? (
        <View style={styles.chips}>
          {(['call', 'put'] as const).map((right) => (
            <Chip
              key={right}
              label={t.positions.right[right]}
              active={leg.right === right}
              onPress={() => onChange({ right })}
            />
          ))}
          {(['long', 'short'] as const).map((side) => (
            <Chip
              key={side}
              label={t.positions.side[side]}
              active={leg.side === side}
              onPress={() => onChange({ side })}
            />
          ))}
        </View>
      ) : null}
      <Field
        label={f.expiry}
        value={leg.expiry}
        // The mask is the date input: every non-digit is dropped and the dashes are laid back in,
        // so this field cannot hold "next friday". The placeholder is the SHAPE of a date rather
        // than a sentence about one — the same characters in every language, which is why it is a
        // literal here and not a catalogue entry, exactly as settings.tsx's "https://…" is.
        placeholder="YYYY-MM-DD"
        onChangeText={(text) => onChange({ expiry: maskDate(text) })}
        error={errors[fieldKey(index, 'expiry')]}
        keyboardType="number-pad"
        maxLength={10}
      />
      <Field
        label={f.strike}
        value={leg.strike}
        onChangeText={(strike) => onChange({ strike })}
        error={errors[fieldKey(index, 'strike')]}
        keyboardType="decimal-pad"
        maxLength={16}
      />
      <Field
        label={f.contracts}
        value={leg.contracts}
        onChangeText={(contracts) => onChange({ contracts })}
        error={errors[fieldKey(index, 'contracts')]}
        keyboardType="number-pad"
        maxLength={5}
      />
      <Field
        label={f.price}
        value={leg.price}
        onChangeText={(price) => onChange({ price })}
        error={errors[fieldKey(index, 'price')]}
        hint={t.positionSheet.hints.legPrice}
        keyboardType="decimal-pad"
        maxLength={16}
      />
    </View>
  )
}

function Field({
  label,
  value,
  onChangeText,
  error,
  hint,
  placeholder,
  keyboardType,
  maxLength,
}: {
  label: string
  value: string
  onChangeText: (text: string) => void
  error?: string
  hint?: string
  placeholder?: string
  keyboardType: 'number-pad' | 'decimal-pad'
  maxLength: number
}) {
  return (
    <View style={styles.field}>
      <Text style={type.label}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        style={[styles.input, tabular, error !== undefined && styles.inputBad]}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.textFaint}
        keyboardType={keyboardType}
        maxLength={maxLength}
        autoCorrect={false}
      />
      {error !== undefined ? (
        <Text style={styles.error}>{error}</Text>
      ) : hint !== undefined ? (
        <Text style={type.caption}>{hint}</Text>
      ) : null}
    </View>
  )
}

// ---------------------------------------------------------------------------
// Saying it back
// ---------------------------------------------------------------------------

/**
 * The name, then every number under it.
 *
 * The line alone would be enough for a single leg, but a ratio spread's counts and a leg's price
 * are not in any label — and the point of this step is that nothing about to be written is
 * somewhere the owner has to remember rather than read.
 */
function Confirmation({ draft, line }: { draft: PositionDraft; line: string }) {
  const t = useStrings()
  const f = t.positionSheet.fields
  return (
    <View style={styles.form}>
      <Text style={styles.line}>{line}</Text>
      <Text style={type.caption}>{t.positionSheet.confirmHelp}</Text>
      {draft.shape === 'stock' ? (
        <Card style={styles.rows}>
          <InfoRow label={f.quantity} value={draft.quantity} />
          <InfoRow label={f.price} value={draft.price} last />
        </Card>
      ) : (
        draft.legs.map((leg, i) => (
          <View key={i} style={styles.legRows}>
            {draft.legs.length > 1 ? (
              <Text style={type.label}>
                {fill(t.positionSheet.leg, { n: String(i + 1) })}
              </Text>
            ) : null}
            <Card style={styles.rows}>
              <InfoRow
                label={`${t.positions.right[leg.right]} · ${t.positions.side[leg.side]}`}
                value={leg.strike}
              />
              <InfoRow label={f.expiry} value={leg.expiry} />
              <InfoRow label={f.contracts} value={leg.contracts} />
              <InfoRow label={f.price} value={leg.price} last />
            </Card>
          </View>
        ))
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  // The scrim is a token at an opacity, never a literal hex: `theme.ts` is the only place a colour
  // is decided, and this sheet adds nothing to it.
  scrim: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: colors.text,
    opacity: 0.35,
  },
  lift: {
    // Never the whole screen: the sheet is pinned to the bottom and the search results stay
    // visible above it, which is what says the sheet is about the row that was tapped.
    maxHeight: '92%',
  },
  sheet: {
    backgroundColor: colors.bg,
    borderTopLeftRadius: radius.float,
    borderTopRightRadius: radius.float,
    paddingBottom: space.xxl,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.md,
    paddingHorizontal: layout.gutter,
    paddingTop: space.xl,
    paddingBottom: space.md,
  },
  cancel: {
    fontFamily: fonts.semibold,
    fontSize: 15,
    color: colors.accent,
  },
  pressed: {
    opacity: 0.7,
  },
  body: {
    // Grow no further than the content, shrink as far as the sheet's own cap makes it — the
    // footer's buttons stay on screen and the fields scroll under them.
    flexGrow: 0,
    flexShrink: 1,
  },
  bodyContent: {
    paddingHorizontal: layout.gutter,
    paddingBottom: space.lg,
    gap: space.lg,
  },
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.sm,
  },
  help: {
    ...type.caption,
  },
  form: {
    gap: space.lg,
  },
  leg: {
    gap: space.md,
  },
  legRows: {
    gap: space.sm,
  },
  field: {
    gap: 6,
  },
  input: {
    height: 48,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    paddingHorizontal: 14,
    color: colors.text,
    fontSize: 16,
  },
  inputBad: {
    borderColor: colors.down,
  },
  error: {
    ...type.caption,
    color: colors.down,
  },
  banner: {
    ...type.caption,
    color: colors.down,
  },
  line: {
    ...type.pinHeadline,
  },
  rows: {
    padding: 0,
    overflow: 'hidden',
  },
  footer: {
    gap: space.sm,
    paddingHorizontal: layout.gutter,
    paddingTop: space.md,
  },
})
