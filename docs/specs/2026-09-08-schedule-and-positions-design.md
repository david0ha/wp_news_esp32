# The schedule and what you hold — design

> **Status:** design, approved 2026-09-08. Supersedes nothing; extends the desk, the agent and
> the companion app. The board is **not** touched — a sheet of paper is not an alarm clock, and
> nothing here reaches the firmware.

The paper answers *what happened*. This answers *what is about to happen, and what it does to
your money.* It is one feature with four parts that only make sense together: the positions the
owner actually holds, an event book researched against them, a calendar that says why each date
matters, and a push that arrives before the date rather than after it.

The parts are not separable. An event book with no positions is a generic calendar — the phone
already has one of those, and it shows two Yahoo dates. Positions with no research are a
spreadsheet. The value is the join: *this* date, against *your* short call, for *this* reason.

---

## 1. The ask, and where it lands

| Asked for | Lands as |
|---|---|
| 앱 알람 | Desk push (Expo), fired from `Desk.tick()` |
| investing.com 일정을 앱에도 | `econ.py` in the desk, ported from the sibling project's proxy |
| 종목마다 어떤 날짜가 영향을 주는지 | The event book — ten ranked events, each annotated against a position |
| 티커 추가칸에서 정확한 포지션 입력 | `positions.json` on the desk, a bottom sheet in the app |
| 에이전트가 조사해서 가독성 있게 전달 | A second command kind, `calendar`, with its own brief |

Two decisions were taken by the owner and are settled:

- **Green stays up, red stays down.** Korea reads red as a gain and Toss Invest does too, but
  `theme.ts`'s pair is measured (`up #0A6B4B`, 4.5:1 on both grounds) and the board's
  `ui_chg_colour()` is the same rule. A phone that disagreed with the paper about the same
  company would be worse than a phone that disagrees with the country. Toss is borrowed for
  **structure and voice**, not for colour.
- **Ten is a target with a floor, not a quota.** See §4.

---

## 2. The rule this feature is built on

An event book that mixes a computed earnings date with a date the model inferred from a
paragraph is a book with no way to tell the reader which is which. Both render as a line with a
date on it. The reader trusts both, and is wrong about one.

> **Every event carries its source. A computed event is `source: "computed"`. A researched event
> carries a URL. A date with neither does not go on the wall. The reasoning may only point at an
> event that already exists — it can never introduce a date of its own.**

This is the `lang` rule of this feature: narrow, absolute, and the thing everything else follows
from. It gives three tiers that must stay distinguishable all the way to the glass:

**Tier 1 — computed.** Dates a machine knows exactly, and cannot get wrong:

| Event | Where from | Precision |
|---|---|---|
| Earnings | Yahoo `calendarEvents` (already fetched by `CalendarSection`) | `day`, or `session` when the feed says BMO/AMC |
| Ex-dividend, payable | Yahoo `calendarEvents` | `day` |
| Option expiry | The position itself — the owner typed it | `exact` (16:00 ET, trading stop) |
| Economic release | investing.com, via `econ.py` | `exact` (UTC, to the minute) |

**Tier 2 — researched.** Dates that need someone to read for them: analyst and investor days,
conference presentations, product and regulatory decision dates, lock-up expiries, index
rebalancing, a competitor's print that historically moves this name. The agent finds these. Each
one carries the URL it was found at, and the app shows that URL.

**Tier 3 — the reasoning.** One sentence, expandable to a paragraph, saying how this date reaches
this position. Only the agent can write it, because it is the only thing in the system that knows
both that the owner is long a 420 call expiring in November and that a print twelve days before
expiry takes the extrinsic value out of it whether or not the stock moves.

**Every event must carry at least one.** An event with no reasoning is a generic calendar entry,
and the phone already has one of those — it shows two Yahoo dates. That is also what makes the
floor in §4 enforceable rather than advisory: "a source *and* a stated mechanism reaching a
position" is exactly `source` plus a non-empty `affects`, and `calendar.py` refuses a book
without both. The watchlist in §3 widens **where the agent looks**, not what qualifies: an event
about a watched company the owner holds nothing in still has to reach a position they *do* hold —
through the underlying, a supplier, a customer, a competitor — or it does not go in the book.

**The no-invented-dates clause binds the reasoning, not all prose.** `calendar.py` applies it to
`reason` and `reason_short` and to nothing else, on purpose. A `title` and a `push.body` describe
*this* event, whose date is right there in `at`, so "11월 21일 만기가 일주일 남았어요" is
legitimate copy about a date the book can show a source for. A *reason* is where a model
introduces a date nothing sourced.

### Precision is a field, not a formatting choice

`precision: "exact" | "session" | "day"`. An event known only to the day renders as `9월 15일`,
never as `09:30`. Inventing a time for a date-only event is how a reader misses the one that
mattered — they looked at the morning and it happened in the evening. The left rail of every row
shows exactly the precision the event has and no more.

---

## 3. What the owner holds

A new store, `server/claudepost/positions.py`. **Not an extension of `watchlist.py`.** That
module's docstring argues a privacy boundary — no stop level, no entry price, no P&L — and the
argument is about *printable material*: the watchlist is the pool the newspaper votes from. A
position is the opposite kind of object; it must never be printed. Putting it in the same
document would make one file mean two things and would quietly delete a reasoned boundary
instead of replacing it.

```jsonc
{
  "updated_at": "2026-09-08T05:00:00Z",
  "positions": [
    {
      "id": "p_1f05f8",                 // desk-assigned, stable across edits
      "symbol": "ETN",
      "kind": "option",               // "stock" | "option"
      "strategy": "long_call",        // derived from legs; see below
      "legs": [
        { "right": "call", "side": "long", "strike_cents": 42000,
          "expiry": "2026-11-21", "contracts": 2, "entry_price_cents": 1180 }
      ],
      "opened_at": "2026-08-19",
      "note": ""                      // ≤ 500 chars, the owner's own words
    },
    {
      "id": "p_3e3267", "symbol": "SNDK", "kind": "stock",
      "quantity": 40,                 // signed; negative is short
      "entry_price_cents": 158300,
      "opened_at": "2026-07-02", "note": ""
    }
  ]
}
```

**A spread is one position with several legs, never two positions.** The whole point is that the
agent reasons about it as one object — "your 400/420 call vertical" has a max loss, a break-even
and a decay profile that neither leg has alone. Two rows in a table cannot be reasoned about that
way without the reader doing the joining.

`derive_strategy(legs)` is a pure function and is host-tested: it names `long_call`, `long_put`,
`short_call`, `short_put`, `vertical`, `calendar`, `straddle`, `strangle`, and falls back to
`custom` rather than guessing. The app offers the common shapes as chips so the owner picks in
their own words, and then the app **says the name back** — "ETN 11월 21일 만기 420 콜 2계약".
Naming a thing back is how you find out you typed the wrong strike.

**Two names are deliberately absent, and the desk cannot supply either.** `covered_call` needs the
stock position beside the option one, which a function handed only legs never sees.
`cash_secured_put` is a claim about collateral sitting in an account the desk cannot see — a lone
short put is `short_put`. Both are *display* decisions made with the whole book in hand, so the
app makes them in `strategyLabel`, not the desk. A stored name the data cannot support is worse
than no name: the reader stops reading the legs.

Validation follows `watchlist.py`'s posture exactly: unknown keys refused whole with a 400, hard
caps on every list and string, and the aggregate checked against the serialized form `save()`
writes so a PUT that was accepted can never be refused by the next boot's `load()`. Caps:
64 positions, 4 legs each, expiry within 3 years, `note` ≤ 500 chars.

Money is integer cents, like everything else on this system's wires (`quotes.py` already writes
`lastCents` / `changeBp` for the same reason: 241.60 is not representable and a phone rendering
`241.60000000000002` is a bug nobody can fix where it is seen).

### The app's watchlist and the desk's

They are still two objects and this feature does not merge them — that is a separate change with
its own argument. The event book covers **the symbols in `positions.json` ∪ the desk's
watchlist**, which is the union that actually matters: things the owner has money in, plus things
the desk is already following.

---

## 4. The event book

`<data>/calendar.json`, written by the agent, read by the phone.

```jsonc
{
  "generated_at": "2026-09-08T05:00:00Z",
  "lang": "ko",                        // follows settings.lang, like the edition does
  "target": 10,
  "events": [
    {
      "id": "e_91c2",
      "at": "2026-09-08T12:30:00Z",     // always UTC. 08:30 in New York,
                                       // 21:30 in Seoul -- see the rail note in §8
      "precision": "exact",
      "title": "미국 8월 소비자물가지수",
      "kind": "econ",                   // econ|earnings|dividend|expiry|corporate|legal|index|other
      "source": "https://www.investing.com/economic-calendar/",
      "symbols": ["ETN"],
      "affects": [
        {
          "position_id": "p_1f05f8",
          "direction": "against",        // "for" | "against" | "both"
          "reason": "금리 기대가 흔들리면 전력기기 설비투자 사이클 기대도 같이 움직여요. 만기가 74일 남은 롱 콜은 델타보다 베가가 큰 구간이라, 지수가 빠지면 방향이 맞아도 프리미엄이 먼저 줄어요.",
          "reason_short": "금리 기대가 흔들리면 전력기기 설비투자 기대도 같이 움직여요"
        }
      ],
      "rank": 1,
      "push": {
        "title": "오늘 밤 미국 CPI가 나와요",
        "body": "21:30에 발표예요. ETN 420 콜은 지수가 빠지면 방향이 맞아도 프리미엄이 먼저 줄 수 있어요."
      }
    }
  ],
  "shortfall": null                     // or a sentence when fewer than `target` cleared the floor
}
```

### Ten, with a floor

The instruction was "always fill ten". Taken literally it produces padding — a day with six real
dates gets "4분기는 12월 31일에 끝나요" in the tenth slot, and padding is the exact failure the
instruction was trying to prevent. So:

- **Ranking is by effect on the owner's positions**, not by general newsworthiness. An FOMC
  meeting outranks this company's own product launch if the owner is short vega and long nothing
  else.
- **The floor:** an event enters only if it has a source *and* a stated mechanism reaching a
  position or the underlying. Below that, it does not enter.
- **The brief tells the agent to keep working until ten clear the floor.** That is where the
  effort the instruction was asking for goes.
- **When fewer clear it, the screen says so** and does not draw empty slots. `shortfall` carries
  the sentence.

`target` is a setting, so this is a number and not a belief.

---

## 5. The desk

Four new modules, all in the shape of things that already exist.

**`positions.py`** — the store above. Mirrors `watchlist.py`'s validate/load/save posture.

**`calendar.py`** — the event book's schema and validation. Enforces §2 at the door: an event
without `source` is a 400, and an `affects[].reason` that names a date not in `events` is a 400.
The rule is a *validator*, not a note in a prompt, because a prompt is advice and a validator is
a wall.

**`econ.py`** — investing.com. Ported from the sibling project's `tools/econ_proxy/econ_proxy.py`
(184 lines, stdlib only): POST `https://www.investing.com/economic-calendar/Service/getCalendarFilteredData`
with `importance[]=1..3&timeZone=55&timeFilter=timeRemain&currentTab=custom&dateFrom&dateTo`, a
browser UA, `X-Requested-With: XMLHttpRequest` and the calendar's own `Referer`; the response is
HTML `<tr>` rows, and importance is the count of `grayFullBullishIcon` in the third cell.
`timeZone=55` is investing.com's id for GMT, so what comes back is UTC and no timezone travels on
the wire.

It goes **inside the desk**, not beside it as a second service. The sibling project separated it
because an ESP32 cannot scrape HTML; here the desk is already the thing that goes outside on the
phone's behalf, already caches, already holds the tokens. A second container is a second thing to
keep alive for no gain. It follows `quotes.py` exactly — `urllib`, an injected `fetch` so tests
never touch the network, a cache (one hour; an economic calendar does not move within the hour),
and every string built from an upstream failure passing through redaction before it exists.
`cloudscraper` and `requests` stay **optional**: tried in order and fallen through on any
exception, so the stdlib path works with zero new dependencies and a Cloudflare challenge in one
library cannot abort the chain.

**`push.py`** — Expo Push. POSTs to `https://exp.host/--/api/v2/push/send`. Same outbound shape
as `quotes.py`, same redaction rule. Tokens live in `<data>/push.json`:

```jsonc
{ "devices": [ { "token": "ExponentPushToken[...]", "platform": "ios",
                 "tz": "Asia/Seoul",
                 "prefs": { "earnings": true, "expiry": true, "dividend": true, "econ": true },
                 "lead": { "earnings": ["P1D"], "expiry": ["P7D","P1D"],
                           "dividend": ["P1D"], "econ": ["PT3H"] },
                 "quiet": { "from": "23:00", "to": "07:00" },
                 "last_seen": "2026-09-08T05:00:00Z" } ] }
```

### The tick

`Desk.tick()` is already a function of an injected clock rather than something that sleeps, and
its docstring says why: the interesting moments are exactly the ones a test must be able to step
over. Alerts get `self._fire_due_alerts(t)` beside `_fire_due_wake(t)`, in the same shape and
under the same rule — **idempotent**, because this runs every few seconds forever and a scheduler
that fired once per tick would send the same notification twelve times a minute.

Delivery is recorded per `(device, event, lead)` so a redelivery is impossible even across a
restart. **Quiet hours defer, they do not drop** — a 21:30 UTC CPI print is 06:30 KST, but a
07:00 UTC one is 16:00 and the deferral must not silently swallow it. The deferred alert fires at
the end of the quiet window, and its copy says the event already happened if it has.

### Routes

| Route | Scope | What |
|---|---|---|
| `GET /api/positions` | producer | the book of positions (the agent reads this) |
| `PUT /api/positions` | operator | the phone writes it |
| `GET /api/calendar` | producer | the event book |
| `PUT /api/calendar` | producer | the agent files it |
| `GET /api/econ?from=&to=` | producer | investing.com, cached |
| `POST /api/push/devices` | operator | register / update this phone |
| `DELETE /api/push/devices/<token>` | operator | forget this phone |

All on the **control plane**, all behind a Bearer token. Nothing here is added to `_DEVICE_ROUTES`.

---

## 6. What must never happen

`GET /news.json` is served with **no authorization** — it has to be, the board polls it. So the
one catastrophic outcome of this feature is an agent that reads the owner's option positions and
files them into an edition, publishing them at a public URL.

The defence is structural, not a sentence in a prompt:

1. **Two command kinds, two briefs.** `edition` produces the newspaper; `calendar` produces the
   event book. `loop.py`'s `seed_watchlist()` gains a sibling `seed_positions()` that runs **only
   for `calendar`**. The process that writes the newspaper never has the file.
2. **The edition validator refuses a payload carrying position fields** — `strike_cents`,
   `entry_price_cents`, `contracts`, a `positions` key at any depth. The same way the simulator
   fails the build on a yellow pixel that can reach paper.
3. **A host test asserts the device plane cannot reach the new stores.** Not "does not today" —
   cannot.
4. `positions.json` and `calendar.json` are 0600 in the data directory. The repository ships
   `positions.example.json` and nothing else. This is the standing rule (*nothing personal
   belongs in this repository*) applied to the most personal file the system has yet held.

---

## 7. The agent

A second job beside the newspaper, on the same queue and the same launchd worker — nothing new
to install.

A `calendar` command seeds the workdir with `positions.json`, the watchlist, the current
`calendar.json` (so yesterday's reasoning can be revised rather than rewritten), and a fresh
`GET /api/econ` window. Its brief — `tools/edition/CALENDAR.md`, beside `PROMPT.md` — says:

- the three tiers and the source rule, stated as a refusal condition rather than a preference;
- that ranking is by effect on the positions in front of it;
- that it must keep looking until ten clear the floor, and must write `shortfall` rather than pad;
- the voice: 해요체, one sentence for `reason_short`, a paragraph for `reason`, no jargon the
  owner did not use first;
- that `push.title` / `push.body` are written **with the event**, by the thing that understands
  it — a notification that says "일정이 있어요" is a notification that made the owner open the app
  to find out what it was.

Cadence: once in the morning beside the edition, and again after the US close. Both are enqueued
by the desk's existing schedule.

---

## 8. The app

### Where it lives

No fifth tab. The **Markets** tab gains a "다가오는 일정" block at the top showing the next three;
tapping opens `/schedule`, the full book grouped by day. The symbol detail screen's **Calendar**
tab is replaced by that symbol's slice of the book, keeping the past-earnings beat/miss table
that is already there and good.

### The row

```
오늘 · 9월 8일 (화)
 21:30 │ 미국 8월 소비자물가지수                    ↓ 불리
       │ ETN 롱 콜 420 · 만기 D-74
       │ 금리 기대가 흔들리면 전력기기 설비투자…
─────────────────────────────────────────────────────
내일 · 9월 9일 (수)
 장마감후│ ETN 3분기 실적                          양방향
       │ ETN 롱 콜 420 · 만기 D-73
       │ 발표 뒤 IV가 빠지면 주가가 그대로여도…
       │                          🔗 investor.eaton.com
```

Three decisions in that picture:

- **The left rail is the time, at the precision the event actually has.** `21:30`, `장 마감 후`,
  `종일`. §2's precision field, rendered.

  **The rail is local time and the wire is UTC**, always, both directions. The `21:30` above is
  a US CPI print — 08:30 in New York, 12:30Z, 21:30 in Seoul — and the day grouping uses the
  local day too, or an event at 23:00Z lands under a heading that says 오늘 when it is tomorrow.
- **The right rail is what it means to you, not what investing.com thinks.** `↑ 유리` /
  `↓ 불리` / `양방향`, in the up/down pair. Hanging investing.com's High/Medium/Low there would
  throw away the whole point: this book is ranked by effect on *these* positions, and a High that
  cannot reach them is not high.
- **The source badge is §2 made visible.** A computed event carries none — it is not in question.
  A researched event carries a link and its domain, and tapping it opens the page it came from.
  A reader can always see which kind of date they are looking at without being told.

The reasoning shows two lines and expands on tap (Toss's *한 화면, 한 기능*). Rows are dense —
Toss's watchlist deliberately rejects cards to keep a scannable screen scannable — inside a day
group that uses this app's own card.

### What we took from Toss, and what we did not

Taken: list over card for scanning; one decision per screen; the eight writing principles,
especially *Predictable Hint* (say what comes next) and *Suggest over Force* (do not frighten
someone about their own money); and above all the **notification register**, which their real
pushes demonstrate better than any style guide —

> 애플 📈 주식 가격이 5% 올랐어요 (304,668원)
> 엔비디아 모으기가 일시정지 중이에요 벌써 한 달이 지났네요

해요체, emoji inside the sentence rather than decorating it, and the notification is about
**your** holding, by name, not about the market. Ours read the same way:

> ETN 실적이 내일 장 마감 후예요 📊 11월 만기 420 콜은 발표 뒤 IV가 빠지면서, 주가가 그대로여도 손해가 날 수 있어요.
> 420 콜 만기가 일주일 남았어요 ⏳ 지금부터는 시간가치가 하루치씩 눈에 띄게 줄어요.

Not taken: their palette. Only the CI blue `#0064FF` is officially sourced; the in-product tokens
are third-party reports. This app's palette is measured and documented in `theme.ts`, and the
up/down decision is settled above.

### Entering a position

From the search result in `add-ticker.tsx`, a bottom sheet, one decision at a time:

1. `[주식] [롱 콜] [롱 풋] [숏 콜] [숏 풋] [스프레드]`
2. the leg form(s) that choice implies — 만기 · 행사가 · 계약수 · 평균단가
3. the app says the name back: "ETN 11월 21일 만기 420 콜 2계약" / "ETN 콜 버티컬 400/420"

The owner never picks a strategy from a taxonomy. They say what they bought and the app names it.

### Notifications

`expo-notifications` is a native module and the app has none today, so this needs a rebuild —
and an APNs push key on EAS, which is the one step of the deploy lane that may not be
non-interactive (§10). Permission is asked **at the moment the owner turns an alert on**, never
at launch: a permission prompt before the feature has been explained is a permission denied.

---

## 9. Failure, and what a failure must not do

The governing precedent is the board's: *a rejected payload leaves the previous snapshot alone,
because a stale front page badged STALE beats an empty one.* The same rule, three times over:

- **investing.com fails** (Cloudflare, a markup change, a timeout): the last good econ window is
  kept and the book is marked stale for those events. A calendar that goes blank is worse than
  one that is three hours old, and a scraper of an undocumented AJAX endpoint **will** break —
  the regex parse is the fragile part, and its failure must be visible in `/api/state` rather
  than silent.
- **The agent files a book that fails validation**: `calendar.json` is untouched. `news_parse()`
  writes `*out` only on success and this is the same argument.
- **Expo push fails**: retried on the next tick, with a per-device failure streak surfaced in
  `/api/state`. An `DeviceNotRegistered` receipt removes the token — a phone that uninstalled the
  app must not accumulate failures forever.
- **A position references a symbol Yahoo will not answer for**: the position stays, its events
  come from what is available, and the screen says which source is missing. Losing the owner's
  typed position because a data source had a bad day is not acceptable.

---

## 10. Risks, stated before they bite

1. **The APNs push key — checked, and it does not exist.** Asked of EAS directly on 2026-09-08
   (`app.byId(...).iosAppCredentials[0].pushKey` → `null` for `com.claudepost.app`), so this is a
   measurement and not a worry.

   It is narrower than it first looked. A **build does not need it** — the key is what Expo's push
   service presents to APNs when it *sends*, so its absence does not stop the app shipping. It
   stops notifications arriving, silently, which is the worse failure of the two: everything looks
   built and nothing rings.

   `eas credentials` has no `--non-interactive` flag (verified: "Nonexistent flag"), so the key is
   created by one interactive run — but almost certainly **without an Apple sign-in**, because the
   ASC API key `V53PX6C289` is already stored on EAS servers and is what the portal call
   authenticates with. Expected cost: the owner runs `! cd app && eas credentials` once and picks
   "Push Notifications: Manage your Apple Push Notifications Key" → "Set up a new key". Everything
   after that is non-interactive again.

   Do it **before writing the app half**, so the first build that carries `expo-notifications` can
   be tested end to end instead of shipping into a silence nobody can distinguish from a bug.
2. **investing.com is scraped, not consumed.** No contract, no notice of change, and a regex over
   HTML. The parse is isolated in one function with a committed fixture so a break is a failing
   test and not a blank screen, and the failure is surfaced rather than swallowed.
3. **The reasoning is the product and it is generated.** A wrong sentence about the owner's own
   money is the worst output this system can produce. Mitigations: the source rule (§2), the
   validator that enforces it, the visible source badge, and the reasoning never introducing a
   date. What is *not* mitigated is a plausible, sourced, wrongly-reasoned sentence — the brief
   must require the mechanism to be stated explicitly enough that the owner can disagree with it.
4. **Position data on the desk.** The owner chose this deliberately, so that the agent can reason
   about entry and size. §6 is what makes it survivable.

---

## 11. Not in this design

- The board. No new sheet, no alarm on the panel, no firmware change.
- Trading. Nothing here places an order or connects to a broker.
- Live P&L. The app computes and displays it from the position and the quote; the desk stores
  cost basis but does not mark to market on a timer.
- Greeks. The reasoning talks about vega and theta in words; nothing computes them.
- Merging the app's local watchlist with the desk's. Separate change, separate argument.
