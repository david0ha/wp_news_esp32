import { useCallback, useEffect, useRef, useState } from 'react'
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router'
import { Screen } from '../../components/Screen'
import { BackButton } from '../../components/BackButton'
import { DeltaText } from '../../components/DeltaText'
import { PriceChart } from '../../components/PriceChart'
import { SectionTabs } from '../../components/SectionTabs'
import { TimeframePills } from '../../components/TimeframePills'
import { InfoSection } from '../../components/detail/InfoSection'
import { NewsSection } from '../../components/detail/NewsSection'
import { CalendarSection } from '../../components/detail/CalendarSection'
import { OptionsSection } from '../../components/detail/OptionsSection'
import { yahoo } from '../../lib/market/yahoo'
import { baselineFor, type Timeframe } from '../../lib/market/timeframes'
import { marketHumanError, type ChartData, type ChartPoint, type Quote } from '../../lib/market/types'
import { currencySymbol, formatDateShort, formatPrice, formatTime } from '../../lib/market/format'
import { useStrings } from '../../i18n'
import { colors, fonts, layout, radius, space, tabular, type } from '../../theme'

// Robinhood cadence: the header quote and the 1D line stay roughly live while the screen is
// focused; longer timeframes are history and refetch only when the user asks for them.
const POLL_MS = 60_000

/**
 * The symbol detail screen (spec §6.3): one ScrollView from back chrome through price hero,
 * full-bleed axis-free chart, timeframe pills, and the four sections behind SectionTabs.
 * Sections mount once, fetch lazily on first activation, and merely hide when the user tabs
 * away — their state (and their fetched data) survives the tab switch.
 */
export default function MarketDetail() {
  const router = useRouter()
  const t = useStrings()
  const params = useLocalSearchParams<{ symbol: string }>()
  // Uppercase once at the top — deep links arrive as claudepost://market/aapl too.
  const symbol = String(params.symbol ?? '').toUpperCase()

  const [tf, setTf] = useState<Timeframe>('1D')
  const [quote, setQuote] = useState<Quote | null>(null)
  const [quoteSettled, setQuoteSettled] = useState(false)
  const [quoteError, setQuoteError] = useState<string | null>(null)
  // The chart travels with the timeframe it was fetched for, so the baseline and the header
  // delta always describe the line actually on screen — even mid-switch.
  const [chart, setChart] = useState<{ tf: Timeframe; data: ChartData } | null>(null)
  const [chartLoading, setChartLoading] = useState(false)
  const [chartError, setChartError] = useState<string | null>(null)
  const [scrub, setScrub] = useState<ChartPoint | null>(null)
  const [tab, setTab] = useState(0)
  const [refreshing, setRefreshing] = useState(false)

  // Refs the async callbacks read so a settled response for a timeframe the user has already
  // left never overwrites the current one.
  const tfRef = useRef(tf)
  tfRef.current = tf

  const loadQuote = useCallback(
    async (fresh = false) => {
      try {
        const q = await yahoo.quote(symbol, { fresh })
        setQuote(q)
        setQuoteError(null)
      } catch (e) {
        // Keep the last good quote on a transient failure; the banner only shows when there is
        // nothing cached to render (computed below).
        setQuoteError(marketHumanError(e))
      } finally {
        setQuoteSettled(true)
      }
    },
    [symbol],
  )

  const loadChart = useCallback(
    async (t: Timeframe, opts: { fresh?: boolean; silent?: boolean } = {}) => {
      // The background poll is silent: dimming the line to 0.3 under a spinner every sixty
      // seconds would read as flicker. The dim treatment is for refetches the user asked for.
      if (!opts.silent) {
        setChartLoading(true)
        // A fresh attempt clears the previous attempt's error, so the banner never narrates a
        // failure the spinner is already retrying.
        setChartError(null)
      }
      try {
        const data = await yahoo.chart(symbol, t, { fresh: opts.fresh })
        if (tfRef.current === t) {
          setChart({ tf: t, data })
          setChartError(null)
        }
      } catch (e) {
        if (tfRef.current === t && !opts.silent) setChartError(marketHumanError(e))
      } finally {
        if (tfRef.current === t && !opts.silent) setChartLoading(false)
      }
    },
    [symbol],
  )

  // Initial load: header quote + the 1D line.
  useEffect(() => {
    loadQuote()
    loadChart('1D')
  }, [loadQuote, loadChart])

  // While focused and on 1D, re-poll both every 60 s (a longer timeframe is history — no poll).
  useFocusEffect(
    useCallback(() => {
      if (tf !== '1D') return
      const id = setInterval(() => {
        loadQuote()
        loadChart('1D', { silent: true })
      }, POLL_MS)
      return () => clearInterval(id)
    }, [tf, loadQuote, loadChart]),
  )

  const onChangeTf = useCallback(
    (t: Timeframe) => {
      setTf(t)
      tfRef.current = t
      loadChart(t)
    },
    [loadChart],
  )

  const retry = useCallback(() => {
    loadQuote()
    loadChart(tfRef.current)
  }, [loadQuote, loadChart])

  const onPullRefresh = useCallback(async () => {
    setRefreshing(true)
    await Promise.allSettled([loadQuote(true), loadChart(tfRef.current, { fresh: true })])
    setRefreshing(false)
  }, [loadQuote, loadChart])

  // ----- derived header values -----
  const points = chart?.data.points ?? []
  const baseline = chart ? baselineFor(chart.tf, chart.data) : null
  const effectiveBaseline = baseline ?? (points.length > 0 ? points[0].close : null)
  const cs = currencySymbol(quote?.currency ?? chart?.data.currency ?? '')

  // The banner speaks only when a failure left nothing to show — stale data beats a warning —
  // OR when a timeframe switch failed and the drawn line belongs to a different timeframe than
  // the selected pill (§0.4: a silent failure with the pill and the chart disagreeing is the
  // one network failure this screen would otherwise never surface). Retry re-fires the failed
  // timeframe via tfRef.
  const banner =
    quoteError !== null && quote === null
      ? quoteError
      : chartError !== null && (points.length < 2 || chart?.tf !== tf)
        ? chartError
        : null

  const quoteInFlight = !quoteSettled && quote === null

  // While a scrub is active the header narrates the scrubbed point instead of the live quote:
  // its close, its delta vs the chart's baseline, and its clock/date as the suffix. This is
  // why PriceChart never draws its own price text.
  let priceText: string
  let delta: number | undefined
  let pct: number | undefined
  let suffix: string | undefined
  if (scrub !== null && effectiveBaseline !== null) {
    priceText = `${cs}${formatPrice(scrub.close)}`
    delta = scrub.close - effectiveBaseline
    pct = effectiveBaseline !== 0 ? (delta / effectiveBaseline) * 100 : undefined
    suffix = chart?.tf === '1D' ? formatTime(scrub.t) : formatDateShort(scrub.t)
  } else {
    priceText = quote !== null && Number.isFinite(quote.price) ? `${cs}${formatPrice(quote.price)}` : '—'
    // The delta describes the drawn line's timeframe: the live quote's day change on 1D, the
    // move since the timeframe's first close otherwise. Until a new timeframe's chart lands,
    // the last known values stay up (§6.3.4).
    const shownTf = chart?.tf ?? '1D'
    if (shownTf === '1D') {
      delta = quote?.delta
      pct = quote?.pct
      suffix = t.marketDetail.todaySuffix
    } else {
      const last = points.length > 0 ? points[points.length - 1].close : null
      if (last !== null && effectiveBaseline !== null) {
        delta = last - effectiveBaseline
        pct = effectiveBaseline !== 0 ? (delta / effectiveBaseline) * 100 : undefined
      }
      suffix = shownTf
    }
  }

  return (
    <Screen aurora>
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onPullRefresh} tintColor={colors.accent} />
        }
      >
        <View style={styles.topBar}>
          {/* A cold-start deep link (claudepost://market/AAPL) mounts this screen with nothing
              beneath it; GO_BACK is then a silent no-op, so fall through to the markets tab. */}
          <BackButton onPress={() => (router.canGoBack() ? router.back() : router.replace('/markets'))} />
        </View>

        {banner !== null ? (
          <View style={styles.gutter}>
            <View style={styles.banner}>
              <Text style={styles.bannerText}>{banner}</Text>
              <Pressable accessibilityRole="button" onPress={retry} hitSlop={8}>
                <Text style={styles.bannerRetry}>{t.common.retry}</Text>
              </Pressable>
            </View>
          </View>
        ) : null}

        <View style={styles.header}>
          <Text style={styles.symbolLine}>
            {quote !== null && quote.exchange !== '' ? `${symbol} · ${quote.exchange}` : symbol}
          </Text>
          {quote !== null && quote.name !== '' ? (
            <Text style={styles.name} numberOfLines={1}>
              {quote.name}
            </Text>
          ) : null}
          {quoteInFlight && scrub === null ? (
            <>
              <View style={styles.priceSkeleton} />
              <View style={styles.deltaSkeleton} />
            </>
          ) : (
            <>
              <Text style={[styles.price, tabular, priceText === '—' && styles.priceMissing]}>
                {priceText}
              </Text>
              <DeltaText size="lg" delta={delta} pct={pct} suffix={suffix} currency={cs} />
            </>
          )}
        </View>

        <PriceChart
          points={points}
          baselineValue={baseline}
          height={220}
          onScrub={setScrub}
          loading={chartLoading}
        />

        <View style={styles.pills}>
          <TimeframePills selected={tf} onChange={onChangeTf} />
        </View>

        <View style={styles.gutter}>
          <SectionTabs
            tabs={[
              t.marketDetail.tabs.info,
              t.marketDetail.tabs.news,
              t.marketDetail.tabs.calendar,
              t.marketDetail.tabs.options,
            ]}
            selected={tab}
            onChange={setTab}
          />
          {/* All four stay mounted so a section's fetched data survives tabbing away; only the
              active one is displayed. Keyed by symbol: a deep link arriving while this screen
              is mounted swaps the param in place (NAVIGATE, same route key), and the sections'
              fetched-once guards would otherwise keep the OLD symbol's data under the new
              header — the key remounts them back to idle so they refetch. */}
          <View style={tab === 0 ? undefined : styles.hidden}>
            <InfoSection key={symbol} symbol={symbol} active={tab === 0} />
          </View>
          <View style={tab === 1 ? undefined : styles.hidden}>
            <NewsSection key={symbol} symbol={symbol} active={tab === 1} />
          </View>
          <View style={tab === 2 ? undefined : styles.hidden}>
            <CalendarSection key={symbol} symbol={symbol} active={tab === 2} />
          </View>
          <View style={tab === 3 ? undefined : styles.hidden}>
            <OptionsSection key={symbol} symbol={symbol} active={tab === 3} />
          </View>
        </View>
      </ScrollView>
    </Screen>
  )
}

const styles = StyleSheet.create({
  content: {
    paddingBottom: space.xxl,
  },
  topBar: {
    height: 56,
    paddingHorizontal: layout.gutter,
    justifyContent: 'center',
  },
  gutter: {
    paddingHorizontal: layout.gutter,
  },
  header: {
    paddingHorizontal: layout.gutter,
    paddingBottom: space.md,
    gap: space.xs,
  },
  symbolLine: {
    ...type.label,
  },
  name: {
    ...type.headingSm,
    color: colors.textDim,
  },
  price: {
    ...type.display,
  },
  priceMissing: {
    color: colors.textDim,
  },
  priceSkeleton: {
    width: 140,
    height: 40,
    borderRadius: radius.sm,
    backgroundColor: colors.surfaceAlt,
    marginVertical: space.xs,
  },
  deltaSkeleton: {
    width: 96,
    height: 16,
    borderRadius: radius.sm,
    backgroundColor: colors.surfaceAlt,
  },
  pills: {
    marginVertical: space.md,
  },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    backgroundColor: colors.warnBg,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    marginBottom: space.md,
  },
  bannerText: {
    flex: 1,
    fontSize: 13,
    lineHeight: 18,
    color: colors.warn,
  },
  bannerRetry: {
    fontFamily: fonts.semibold,
    fontSize: 13,
    color: colors.accent,
  },
  hidden: {
    display: 'none',
  },
})
