import { useCallback, useEffect, useRef, useState } from 'react'
import { ActivityIndicator, Linking, Pressable, StyleSheet, Text, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { Card } from '../Card'
import { Chip } from '../Chip'
import { StatGrid, StatRow } from '../StatRow'
import { yahoo } from '../../lib/market/yahoo'
import { marketHumanError, type KeyStats, type ProfileInfo } from '../../lib/market/types'
import { formatCompact, formatPct, formatPrice, formatRatio } from '../../lib/market/format'
import { fill, useStrings } from '../../i18n'
import { colors, fonts, radius, space, tabular, type } from '../../theme'

type Status = 'idle' | 'loading' | 'ready' | 'error'

/**
 * The detail screen's Info section (spec §6.4): the StatGrid of key figures and the company
 * profile, both from the crumb-gated quoteSummary endpoint. A failed crumb bootstrap is a
 * normal outcome (EU IPs never get one), so the error state is a friendly degraded card with
 * a retry — never an empty white void — while the chart and news above keep working.
 *
 * Receives the shared DetailSectionProps contract { symbol, active }: fetches lazily on
 * first activation and keeps its state when the user tabs away.
 */
export function InfoSection({ symbol, active }: { symbol: string; active: boolean }) {
  const t = useStrings()
  const [status, setStatus] = useState<Status>('idle')
  const [data, setData] = useState<{ stats: KeyStats; profile: ProfileInfo } | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [expanded, setExpanded] = useState(false)
  const startedRef = useRef(false)

  const load = useCallback(async () => {
    setStatus('loading')
    try {
      // A retry after a crumb failure re-bootstraps under the hood (§4.2) — nothing to do here.
      const d = await yahoo.keyStatsAndProfile(symbol)
      setData(d)
      setStatus('ready')
    } catch (e) {
      setError(e)
      setStatus('error')
    }
  }, [symbol])

  useEffect(() => {
    if (active && !startedRef.current) {
      startedRef.current = true
      load()
    }
  }, [active, load])

  if (status === 'idle' || status === 'loading') {
    return (
      <View style={styles.loadingBox}>
        <ActivityIndicator color={colors.accent} />
      </View>
    )
  }

  if (status === 'error' || data === null) {
    return (
      <Card style={styles.degraded}>
        <View style={styles.degradedIcon}>
          <Ionicons name="lock-closed-outline" size={20} color={colors.accent} />
        </View>
        <Text style={styles.degradedTitle}>{t.marketDetail.info.unavailable}</Text>
        <Text style={styles.degradedBody}>{marketHumanError(error)}</Text>
        <Pressable accessibilityRole="button" onPress={load} hitSlop={8} style={styles.ghost}>
          <Text style={styles.ghostLabel}>{t.common.tryAgain}</Text>
        </Pressable>
      </Card>
    )
  }

  const { stats, profile } = data
  const hasProfile =
    profile.sector !== '' ||
    profile.industry !== '' ||
    profile.employees !== null ||
    profile.summary !== '' ||
    profile.website !== ''

  const openWebsite = () => {
    const url = profile.website.startsWith('http') ? profile.website : `https://${profile.website}`
    Linking.openURL(url).catch(() => {})
  }

  return (
    <View>
      <Text style={styles.sectionLabel}>{t.marketDetail.info.stats}</Text>
      <Card>
        <StatGrid>
          <View>
            <StatRow label={t.marketDetail.info.open} value={formatPrice(stats.open)} />
            <StatRow label={t.marketDetail.info.high} value={formatPrice(stats.dayHigh)} />
            <StatRow label={t.marketDetail.info.low} value={formatPrice(stats.dayLow)} />
            <StatRow label={t.marketDetail.info.volume} value={formatCompact(stats.volume)} />
            <StatRow label={t.marketDetail.info.avgVolume} value={formatCompact(stats.avgVolume)} />
            {/* dividendYield is a true 0–1 fraction; formatPct takes an already-percent-scaled
                number (§4.7), so the ×100 happens here, at the call site. */}
            <StatRow
              label={t.marketDetail.info.divYield}
              value={formatPct(stats.dividendYield === null ? null : stats.dividendYield * 100)}
              last
            />
          </View>
          <View>
            <StatRow label={t.marketDetail.info.wk52High} value={formatPrice(stats.wk52High)} />
            <StatRow label={t.marketDetail.info.wk52Low} value={formatPrice(stats.wk52Low)} />
            <StatRow label={t.marketDetail.info.marketCap} value={formatCompact(stats.marketCap)} />
            <StatRow label={t.marketDetail.info.pe} value={formatRatio(stats.trailingPE)} />
            <StatRow label={t.marketDetail.info.eps} value={formatRatio(stats.trailingEps)} />
            <StatRow label={t.marketDetail.info.beta} value={formatRatio(stats.beta)} last />
          </View>
        </StatGrid>
      </Card>

      {hasProfile ? (
        <>
          <Text style={styles.sectionLabel}>{t.marketDetail.info.about}</Text>
          <Card>
            {profile.sector !== '' || profile.industry !== '' ? (
              <View style={styles.chips}>
                {profile.sector !== '' ? <Chip label={profile.sector} /> : null}
                {profile.industry !== '' ? <Chip label={profile.industry} /> : null}
              </View>
            ) : null}
            {profile.employees !== null ? (
              <Text style={[styles.employees, tabular]}>
                {fill(t.marketDetail.info.employees, {
                  n: profile.employees.toLocaleString('en-US'),
                })}
              </Text>
            ) : null}
            {profile.summary !== '' ? (
              <>
                <Text style={styles.summary} numberOfLines={expanded ? undefined : 4}>
                  {profile.summary}
                </Text>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => setExpanded((v) => !v)}
                  hitSlop={8}
                  style={styles.ghost}
                >
                  <Text style={styles.readMore}>
                    {expanded ? t.marketDetail.info.showLess : t.marketDetail.info.readMore}
                  </Text>
                </Pressable>
              </>
            ) : null}
            {profile.website !== '' ? (
              <Pressable accessibilityRole="link" onPress={openWebsite} hitSlop={8}>
                <Text style={styles.website} numberOfLines={1}>
                  {profile.website}
                </Text>
              </Pressable>
            ) : null}
          </Card>
        </>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  loadingBox: {
    height: 120,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sectionLabel: {
    ...type.label,
    marginTop: space.lg,
    marginBottom: space.sm,
  },
  degraded: {
    marginTop: space.lg,
    alignItems: 'flex-start',
    gap: space.sm,
  },
  degradedIcon: {
    width: 36,
    height: 36,
    borderRadius: radius.md,
    backgroundColor: colors.iconWell,
    alignItems: 'center',
    justifyContent: 'center',
  },
  degradedTitle: {
    fontFamily: fonts.semibold,
    fontSize: 15,
    color: colors.text,
  },
  degradedBody: {
    ...type.caption,
  },
  ghost: {
    paddingVertical: space.xs,
    alignSelf: 'flex-start',
  },
  ghostLabel: {
    fontFamily: fonts.semibold,
    fontSize: 14,
    color: colors.accent,
  },
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.sm,
    marginBottom: space.md,
  },
  employees: {
    ...type.caption,
    marginBottom: space.sm,
  },
  summary: {
    ...type.body,
    color: colors.textDim,
  },
  readMore: {
    fontFamily: fonts.semibold,
    fontSize: 14,
    color: colors.accent,
  },
  website: {
    ...type.caption,
    color: colors.accent,
    marginTop: space.xs,
  },
})
