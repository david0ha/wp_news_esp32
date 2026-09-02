// Options analytics (spec §4.8) — pure functions over one expiry's chain, deterministic and
// clock-free. Null OI/volume/IV means "Yahoo didn't say", which these treat as 0 (for sums) or
// as disqualifying (for means); lastPrice, bid and ask play no part in any of them.

import { type OptionChain, type OptionContract } from './types'

/**
 * Yahoo marks a contract with no live quote by setting impliedVolatility to
 * ~1.0000000000000003e-05 instead of omitting it. Those sentinels pass a bare `> 0` filter and
 * drag the unweighted means toward zero (observed halving AAPL's near-money call IV). No real
 * IV sits below 0.1%, so the qualifying floor excludes only the placeholder.
 */
export const IV_FLOOR = 0.001

export interface OptionsAnalysis {
  putCallRatioOi: number | null
  putCallRatioVolume: number | null
  maxPain: number | null
  callIv: number | null
  putIv: number | null
  overallIv: number | null
}

function sum(list: OptionContract[], field: (c: OptionContract) => number | null): number {
  let total = 0
  for (const c of list) total += field(c) ?? 0
  return total
}

/**
 * Σ put OI / Σ call OI (and identically over volume), null OI treated as 0. A zero call total
 * makes the ratio meaningless, not infinite → null.
 */
export function putCallRatio(chain: OptionChain): { oi: number | null; volume: number | null } {
  const callOi = sum(chain.calls, (c) => c.openInterest)
  const putOi = sum(chain.puts, (c) => c.openInterest)
  const callVolume = sum(chain.calls, (c) => c.volume)
  const putVolume = sum(chain.puts, (c) => c.volume)
  return {
    oi: callOi === 0 ? null : putOi / callOi,
    volume: callVolume === 0 ? null : putVolume / callVolume,
  }
}

/**
 * The settlement price that minimizes the writers' total payout. Let K be the sorted set of
 * distinct strikes in calls ∪ puts; for each candidate S ∈ K,
 *
 *   pain(S) = Σ_calls OIc·max(0, S − Kc) + Σ_puts OIp·max(0, Kp − S)
 *
 * (null OI = 0). Max pain is the S minimizing pain(S); on a tie, the lowest such strike. Null
 * when K is empty or every OI is 0 — a pain function that is identically zero names no strike.
 */
export function maxPain(chain: OptionChain): number | null {
  const strikes = new Set<number>()
  for (const c of chain.calls) strikes.add(c.strike)
  for (const p of chain.puts) strikes.add(p.strike)
  const K = [...strikes].sort((a, b) => a - b)
  if (K.length === 0) return null

  const totalOi = sum(chain.calls, (c) => c.openInterest) + sum(chain.puts, (c) => c.openInterest)
  if (totalOi === 0) return null

  let best: number | null = null
  let bestPain = Number.POSITIVE_INFINITY
  for (const S of K) {
    let pain = 0
    for (const c of chain.calls) pain += (c.openInterest ?? 0) * Math.max(0, S - c.strike)
    for (const p of chain.puts) pain += (p.openInterest ?? 0) * Math.max(0, p.strike - S)
    if (pain < bestPain) {
      // strict < walking K ascending keeps the LOWEST strike on a tie
      bestPain = pain
      best = S
    }
  }
  return best
}

/**
 * Unweighted arithmetic means of near-the-money IV: contracts with finite impliedVolatility >
 * IV_FLOOR (which excludes Yahoo's ~1e-05 no-quote placeholder — see IV_FLOOR) and, when
 * chain.spot is a finite positive number, |strike − spot| / spot ≤ 0.10; when spot is
 * null every contract with valid IV qualifies. overallIv averages the UNION (not the two means).
 * Unweighted deliberately — deterministic and testable.
 */
export function ivSummary(chain: OptionChain): {
  callIv: number | null
  putIv: number | null
  overallIv: number | null
} {
  const spot = chain.spot
  const nearMoney =
    spot !== null && Number.isFinite(spot) && spot > 0
      ? (c: OptionContract) => Math.abs(c.strike - spot) / spot <= 0.1
      : () => true

  const ivsOf = (list: OptionContract[]): number[] => {
    const out: number[] = []
    for (const c of list) {
      const iv = c.impliedVolatility
      if (iv !== null && Number.isFinite(iv) && iv > IV_FLOOR && nearMoney(c)) out.push(iv)
    }
    return out
  }
  const mean = (xs: number[]): number | null =>
    xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length

  const callIvs = ivsOf(chain.calls)
  const putIvs = ivsOf(chain.puts)
  return {
    callIv: mean(callIvs),
    putIv: mean(putIvs),
    overallIv: mean([...callIvs, ...putIvs]),
  }
}

/** The three analytics in one object, as OptionsSummary consumes them. */
export function analyzeChain(chain: OptionChain): OptionsAnalysis {
  const ratio = putCallRatio(chain)
  const iv = ivSummary(chain)
  return {
    putCallRatioOi: ratio.oi,
    putCallRatioVolume: ratio.volume,
    maxPain: maxPain(chain),
    callIv: iv.callIv,
    putIv: iv.putIv,
    overallIv: iv.overallIv,
  }
}
