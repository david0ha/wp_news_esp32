import { StyleSheet, Text, View } from 'react-native'
import { colors, fonts, space, tabular, type } from '../theme'
import { formatCompact, formatIv, formatPrice } from '../lib/market/format'
import { type OptionContract } from '../lib/market/types'

/**
 * One options-chain row: Strike | Bid / Ask | Vol · OI | IV. Deliberately no Last
 * column — at 390pt it starves Bid/Ask below what a real ITM quote needs. ITM rows
 * take the Cloud Veil wash (`colors.itm`): ITM is a state, so it gets neither the
 * direction pair nor the accent. Every cell is one line so an overlong value
 * ellipsizes instead of shearing the row.
 */
export function OptionChainRow({
  contract,
  last = false,
}: {
  contract: OptionContract
  last?: boolean
}) {
  return (
    <View style={[styles.row, contract.inTheMoney && styles.itm, !last && styles.bordered]}>
      <Text style={[styles.strike, tabular]} numberOfLines={1}>
        {formatPrice(contract.strike)}
      </Text>
      <Text style={[styles.bidAsk, tabular]} numberOfLines={1}>
        {formatPrice(contract.bid)} / {formatPrice(contract.ask)}
      </Text>
      <View style={styles.volOi}>
        <Text style={[styles.volOiLine, tabular]} numberOfLines={1}>
          {formatCompact(contract.volume)}
        </Text>
        <Text style={[styles.volOiLine, tabular]} numberOfLines={1}>
          {formatCompact(contract.openInterest)}
        </Text>
      </View>
      <Text style={[styles.iv, tabular]} numberOfLines={1}>
        {formatIv(contract.impliedVolatility)}
      </Text>
    </View>
  )
}

/** The column captions — the first row of the chain card (nothing is sticky). */
export function OptionChainHeader() {
  return (
    <View style={styles.headerRow}>
      <Text style={[styles.caption, styles.flexStrike]} numberOfLines={1}>
        Strike
      </Text>
      <Text style={[styles.caption, styles.captionRight, styles.flexBidAsk]} numberOfLines={1}>
        Bid / Ask
      </Text>
      <Text style={[styles.caption, styles.captionRight, styles.flexVolOi]} numberOfLines={1}>
        Vol · OI
      </Text>
      <Text style={[styles.caption, styles.captionRight, styles.flexIv]} numberOfLines={1}>
        IV
      </Text>
    </View>
  )
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingVertical: 10,
    paddingHorizontal: 16,
  },
  itm: {
    backgroundColor: colors.itm,
  },
  bordered: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderStrong,
  },
  strike: {
    flex: 1,
    fontFamily: fonts.semibold,
    fontSize: 14,
    color: colors.text,
  },
  bidAsk: {
    flex: 1.7,
    fontFamily: fonts.medium,
    fontSize: 13,
    color: colors.text,
    textAlign: 'right',
  },
  volOi: {
    flex: 1.2,
    alignItems: 'flex-end',
  },
  volOiLine: {
    ...type.caption,
    textAlign: 'right',
  },
  iv: {
    flex: 0.8,
    fontFamily: fonts.medium,
    fontSize: 13,
    color: colors.text,
    textAlign: 'right',
  },
  caption: {
    ...type.label,
  },
  captionRight: {
    textAlign: 'right',
  },
  flexStrike: {
    flex: 1,
  },
  flexBidAsk: {
    flex: 1.7,
  },
  flexVolOi: {
    flex: 1.2,
  },
  flexIv: {
    flex: 0.8,
  },
})
