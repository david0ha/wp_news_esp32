# Alpaca option strategies implementation plan

> **For agentic workers:** Use the assigned executor lanes and an independent code-reviewer before completion.

**Goal:** Browse six option strategies by expiration and strike, with visible premiums, Greeks and expiry payoff details.

**Architecture:** An authenticated desk endpoint proxies Alpaca snapshots without exposing credentials. The phone normalizes that response, composes standard option legs with a pure payoff module, and renders the existing Options tab.

**Tech Stack:** Python standard library HTTP server, React Native/Expo, TypeScript, Jest, react-native-svg.

**Spec:** User-approved design in this session: strategy → expiry → strike(s) → detailed quotes, Greeks, premium and expiry payoff.

## Constraints

- Six strategies: long call, long put, long/short call vertical, long/short put vertical.
- Missing data is unavailable, never a fabricated zero. Label indicative versus OPRA data.
- Ask for purchased legs, bid for sold legs; premium signed positive for debit and negative for credit.
- Per-share prices and standard 100-share contract totals must be distinguished.
- Break-even, maximum profit/loss and graph are expiry estimates before fees, computed from entry premium.
- Credentials remain on the desk. No personal paths, hostnames or keys in committed content.
- Preserve the position ledger, other market tabs and device wire contract.
- Verify app and server tests, typecheck, and visually inspect iPhone simulator before a PR.

## Task 1: Desk options endpoint

Files: `server/claudepost/alpaca_options.py`, `http.py`, desk service wiring and server tests.

- [x] Add failing tests for authenticated `GET /api/market/options/alpaca`, symbol/date validation, pagination, missing Greeks and OPRA permission fallback.
- [x] Implement `{ok,asOf,result}` envelope with `OptionChain` result, sorted expiries/contracts and explicit feed.
- [x] Run focused tests and server suite. Never silently return truncated pagination as a complete chain.

## Task 2: Client transport and contract

Files: `app/src/lib/market/alpaca.ts`, `alpaca.test.ts`, `types.ts`.

- [x] Test result parsing, authorization, no paired desk, missing numbers, malformed response and deadline handling.
- [x] Add `createAlpacaClient({fetchFn?,desk?}).options(symbol,expiration?,{fresh?})` and `alpacaOptions` singleton.
- [x] Extend optional contract fields: symbol, multiplier, Greeks and quote/trade timestamps; chain source/feed.
- [x] Run focused tests and typecheck.

## Task 3: Strategy arithmetic

Files: `app/src/lib/market/optionStrategy.ts`, `optionStrategy.test.ts`.

- [x] Test all six strategies against hand-computed expiry payoffs, zero spot, strike boundaries, unlimited call upside and absent/crossed quotes.
- [x] Implement `buildStrategy(strategy,first,second?)`: signed legs, bid/ask premium, per-share Greeks, dollar totals and `payoff(spot)`.
- [x] Keep nonstandard multipliers and impossible economics unavailable.
- [x] Run focused tests.

## Task 4: Options UI

Files: `OptionsSection.tsx`, `OptionChainRow.tsx`, `OptionStrategyDetail.tsx`, localized strings and interaction tests.

- [x] Test strategy/expiry selection, spread strike selection, detail opening and stale request exclusion before implementation.
- [x] Render strategy and expiry tabs, contract rows with prices/Greeks, detail sheet and SVG payoff chart.
- [x] Clear selection on changed symbol, expiry or strategy; preserve honest loading/error states.
- [x] Run component tests and inspect rendered single-leg/spread details in the iPhone simulator.

## Final verification

- [x] App test suite and typecheck, final server and agent suites, and `git diff --check` pass.
- [x] Independent review and focused fixes, then inspect final diff.
- [x] Record concrete evidence and limitations; deliver this implementation on a reviewable branch with decision trailers.

## Verification evidence

- App: 56 suites / 1,250 tests pass; TypeScript check passes.
- Worker: 249 tests pass. Server: final full suite 944 tests pass, including contract-metadata checks.
- Independent code review: both findings fixed, final zero outstanding issues.
- iPhone 17e / Expo Go: Korean fixture list, strategy and expiry tabs, strike-pair comparison, detail modal, payoff graph, leg quotes and Greeks rendered and inspected. Temporary fixture route and transport override removed and original transport restored before final tests.
- Live read-only Alpaca AAPL probe: 23 expirations, 47 calls and 47 puts for selected expiry, indicative feed, delta/gamma available, metadata verifies size 100 for all 94 returned contracts. No deployed desk state or orders changed.
- Snapshots do not include volume/open interest; these remain unavailable. Contract metadata failure leaves totals/payoff unavailable while preserving quotes and Greeks.
- Production desk deployment and TestFlight release are outside this implementation; both app and desk changes must be shipped together.
