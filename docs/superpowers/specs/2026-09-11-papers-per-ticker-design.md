# Papers: the latest edition for every company on the watchlist

**Date:** 2026-09-11
**Status:** approved design, not yet built
**Supersedes nothing.** The single-company broadsheet, the desk's schedule, the wire the board
polls and the "ask the desk" feature (`2026-09-10-ask-the-desk-design.md`) all stand. This adds
a second thing the desk keeps beside the one newspaper it prints: a **paper** for each company
the owner watches, refreshed on a fixed cadence and readable from the phone whether or not it
is the one on the glass.

## 1. What the owner asked for, and what was settled

The owner wants the desk to always hold a current newspaper for **each** company on the
watchlist — not only the one company a day the board prints — so the app can page through
them at any moment, and so the board can be told to print any of them.

Four things were settled in conversation and are binding:

1. **A paper is a complete newspaper**, A1 and A2, through the same validate-and-render gates
   as the board's edition. Not a lighter dossier.
2. **The cadence is 12 hours by default**, not the six first asked for, because a paper costs
   the worker 30–40 minutes and the six-hour figure does not fit in a day beside the board's
   own runs. It is a setting, and the owner may lower it.
3. **The set of companies is the desk watchlist** (`/api/watchlist`, the document the vault
   pushes every morning) — items with `printable: true` — not the worker's rotation file.
   Five symbols today.
4. **The board keeps its daily pick.** The morning order and the scheduled wakes choose one
   company and print it, exactly as now. What changes is that the Board tab can put any
   company's paper on the glass at a tap, and tomorrow's automatic pick overrides it again.

Two costs were accepted with open eyes: about six more hours of model time a day at the
default cadence, and the fact that an `ask` may now wait behind a paper in flight for up to
the length of one run. A second worker container that takes only `ask` is the remedy if that
wait turns out to matter; it is out of scope here.

## 2. The shape of it

Nothing new is stored that could be derived. A **paper** is *the newest edition whose subject
is S*. Editions already carry their company inside `news.json` (`subject.symbol`); the desk
now copies that symbol into the edition's `meta.json` at commit so the question "which is
the newest edition about S" is one pass over the editions table, and answers it through a
route the phone can read.

Three kinds of change follow, one per subsystem:

- **Desk** — the index and the routes that read it; a commit *target* that lets an edition be
  recorded without touching the board's pointers; a rotation that orders the stalest paper
  when the worker is idle; the setting that paces it; one route that puts a paper on the
  board.
- **Worker** — a new command kind, `paper`, handled like `file_edition` except that the company
  is given, not chosen, and the commit is a paper commit.
- **App** — Today pages through the papers; the Board tab lists them and publishes one.

The board's firmware, the wire contract in `docs/news-contract.md`, and the typesetting gates
are untouched. The board never learns that papers exist: it polls `/news.json` and prints
whatever is `current`.

## 3. Desk

### 3.1 Edition meta

`_commit` writes two more fields into `meta.json`: `symbol` (the payload's `subject.symbol`,
already clamped to 8 characters by the validator) and `lang` (the payload's top-level `lang`,
`"en"` when absent). Editions built before this change have neither; `edition_meta()` fills
both lazily from the stored payload when they are missing, so no migration runs and a
pre-change edition is still a paper for its company.

### 3.2 The paper index

`EditionStore.papers(symbols)` returns, for each requested symbol in the order given, the
newest edition (by `created_at`) whose meta `symbol` matches, or `None`. It is a read, not a
cache: the editions table is the truth.

`prune()` gains one more protected set beside `current`, `staged` and in-flight builds: **the
newest edition of every symbol on the watchlist**. A paper is never pruned out from under
the pager. Editions for symbols no longer on the watchlist lose that protection and age out
normally.

### 3.3 Commands carry a symbol, and a new kind

`store.COMMAND_KINDS` gains `paper`. The commands table gains a nullable `symbol` column
(the same migration path `reply_to` and `lang` used). `POST /api/commands` accepts `symbol`
(uppercase, 1–8 characters, `[A-Z0-9.\-]`) and requires it when `kind == "paper"`. Every
command row and every list row reports it.

### 3.4 Commit targets

`POST /api/drafts/<d>/commit` accepts an optional JSON body `{"target": "board" | "paper"}`;
absent means `board`, which is today's behaviour exactly. A **paper commit** runs the same
five gates (draft exists, validate, render, fingerprint, schedule) except the schedule gate,
builds and records the edition, and **writes neither pointer**. Its `CommitResult.state` is
`"paper"`.

The fingerprint gate for a paper commit compares against *that symbol's* newest edition, not
against `current`: an unchanged paper is `unchanged`, exactly as an unchanged board edition
is today.

A paper commit **refuses** (`409`, `commit_symbol_mismatch`) when the draft's `subject.symbol`
differs from the symbol the commit names. The commit body carries `symbol` for that purpose;
the worker copies it from the command. This is the wall that keeps a model that drifted to
another company from poisoning the index — the index is derived from `subject.symbol`, so a
wrong subject would file the paper under the wrong name.

### 3.5 Rotation

Runs inside `Desk.tick()` on every housekeeping pass, after `publish_due`:

1. If any command is `pending` or `claimed` — of any kind — do nothing. One paper at a time,
   and never a backlog: an `ask` posted while the worker is idle is claimed on the next poll.
2. Otherwise take the watchlist's printable symbols, look up each one's newest edition, and
   pick the symbol with the **oldest** paper (a symbol with no paper is oldest of all; ties by
   watchlist order).
3. If that paper is younger than `paper_refresh_hours`, do nothing.
4. Otherwise enqueue `kind=paper, symbol=S, priority=9, source="rotation"` with text
   `"Refresh the paper for S. The company is given; research it and write both pages."` and
   `deadline_at` one cadence ahead.

Idempotency is structural — step 1 prevents a second paper while the first is queued — so
no meta key is needed. Quiet hours do not apply: a paper never touches the board, and the
night is the cheapest time to write one. Priority 9 is the lowest the queue has, so an `ask`
(5) or the morning order (5) posted while a paper is *pending* is claimed first; only a paper
already *claimed* makes anything wait.

A failed paper run is finished `failed` like any command; the next pass orders the stalest
paper again, which is the same symbol unless another has aged past it.

### 3.6 Setting

`settings.json` gains `paper_refresh_hours`, an integer in `1..72`, default `12`, validated
in `settings.py` beside `lang` (unknown keys still refuse the whole document). `GET/PUT
/api/settings` carry it; the app's Settings screen gets a row for it.

### 3.7 Routes

| Route | Scope | Returns |
|---|---|---|
| `GET /api/papers` | producer | `{ok, papers: [row…], board: <current eid or null>}` — one row per printable watchlist symbol, watchlist order |
| `GET /api/editions/<eid>/news.json` | producer | the stored payload, with the policy block spliced in exactly as `/news.json` does, ETag |
| `GET /api/editions/<eid>/tiles/<id>.bin` | producer | that edition's tile |
| `POST /api/papers/<SYMBOL>/publish` | operator | promotes the symbol's newest edition to `current`; `404 no_paper` when it has none; `{ok, edition_id, state}` |

A paper row: `{symbol, name, edition_id|null, created_at|null, lang|null, headline|null,
on_board: bool, stale: bool}` — `name` from the watchlist item, `headline` the lead story's,
`on_board` when `edition_id == current`, `stale` when older than the cadence. A symbol with no
paper yet is a row with nulls, so the pager can show "not written yet" rather than skip it.

`/api/papers/<SYMBOL>/publish` is `promote()` behind a symbol lookup. It ignores every
schedule gate, as `promote` does today, because the operator asked for it by hand. The next
scheduled wake's edition, or tomorrow's order, publishes over it in the normal way.

### 3.8 The lease matches a run

`store.LEASE_SECONDS` is 1800. A run that clears its proof first time takes 25–40 minutes;
one that needs a revision turn takes longer, and on 2026-09-11 the desk put a claimed order
back to `pending` at minute 39 while the worker was still writing it. With one worker that
is harmless — `finish_command` accepts a report on a pending row — but a second worker, or
the rotation's "queue is empty" test, would read that row wrongly. The lease becomes
**5400 seconds** (ninety minutes), and the rotation counts a `pending` *or* `claimed` row as
the worker being busy, as §3.5 already says. Heartbeats are not added; a lease longer than
any run is the simpler wall.

## 4. Worker

`agent/loop.py` handles `paper` as `file_edition` with three differences:

1. **The company is given.** The prompt's per-kind tail says so: the paper is about `S`, the
   contract's "which company" rule is suspended for this run, and filing a payload whose
   subject is not `S` is an error the desk will refuse. The rotation file is **neither seeded
   nor persisted** — the rotation cursor is the board's, and a paper run must not move it.
2. **The commit is a paper commit.** `DeskClient.commit(draft, target="paper", symbol=S)`.
3. **The result string is `paper <eid>`** (or `unchanged <eid>`), so the queue shows what
   was filed.

Everything else — the language section from the desk's `lang` setting, the context
directory, directives, proof, revision turns, the look at the sheets — is the same code path.
The sandbox wall is unchanged: a paper run never sees the positions or the calendar.

`agent/prompt.py` gains the `paper` tail. `tools/edition/PROMPT.md` gains one paragraph under
"Which company" saying that a `paper` order names the company and the rotation does not
apply.

## 5. App

### 5.1 Today

When the app has a desk token, Today is a **horizontal pager** over `GET /api/papers`: the
board's paper first (`on_board`), then the rest in watchlist order. Each page is the existing
edition reader (`useEdition` and the tile screens) fed by that edition's payload through
`/api/editions/<eid>/news.json` and its tiles through the matching tile route, with the
Authorization header the desk client already carries. Payloads are cached per edition id;
the paper list is refetched on focus with the same throttle Today uses now, and a `revised`
or `published` outcome from the ask thread invalidates it the way it invalidates the edition
today.

A page header carries the symbol, the company name, and the paper's age ("6시간 전" /
"6h ago"); a symbol with no paper shows a placeholder page saying it has not been written
yet. Page position is remembered for the session, not persisted.

**Without a desk token** — demo mode, or a plain news URL with no desk — Today is exactly what
it is today: one page, `/news.json`. The pager is gated the way the Ask pill is gated.

### 5.2 Board tab

A new section, **Paper on the board**, above the device rows: the papers in pager order, each
with symbol, name, age, and a check on the one whose `on_board` is true. Tapping another row
asks for confirmation, calls `publishPaper(symbol)`, marks the row on success, invalidates
Today's paper list, and then calls the existing `client.refresh()` so the board polls now
rather than at its next interval. The row is disabled for a symbol with no paper. The section
is hidden without a desk token.

### 5.3 Settings

One row: refresh cadence in hours, 1–72, written through `putSettings` beside the language.

### 5.4 Desk client

`DeskClient` gains `papers()`, `editionPayload(eid, etag?)`, `editionTile(eid, id)`,
`publishPaper(symbol)`. Types mirror the rows in §3.7.

## 6. Failure cases

| Case | What happens |
|---|---|
| Model files a payload about a different company | desk refuses the commit (`409`); the run fails with that reason in the queue; rotation retries later |
| Symbol removed from the watchlist | its paper stays readable until pruned, is no longer refreshed, and leaves the pager on the next list fetch |
| Symbol added to the watchlist | has no paper, is the oldest of all, and is ordered on the next idle pass |
| Paper run fails or times out | command `failed`; the next idle pass orders the stalest again |
| Worker still on pre-feature code | refuses the unknown kind; the desk marks it failed; visible in the queue |
| Board publish while a board edition is staged | `promote` writes `current` only; the staged edition still publishes at its slot and overrides |
| Desk restarted mid-run | as today: the claim expires, the command is reaped, and rotation re-orders |

## 7. What this does not do

- It does not change what the board prints on its own. The morning order and the wakes are
  as they were.
- It does not keep history per company beyond what `prune` keeps; a paper is the newest
  edition, not a stack of them.
- It does not add a second worker. The ask-latency cost in §1 stands until it is measured.
- It does not translate source articles or resize A2 labels — those are parked separately.

## 8. Testing

- **Server** (`server/test`): meta gains `symbol`/`lang` and is filled lazily for old
  editions; `papers()` picks the newest per symbol; prune protects the newest per watchlist
  symbol; a paper commit writes neither pointer and refuses a subject mismatch; the
  fingerprint gate compares per symbol; rotation enqueues exactly one, at priority 9, only
  when the queue is empty, only when stale, oldest first; the setting validates its range;
  the four routes and their scopes.
- **Agent** (`agent/test`): the `paper` tail names the symbol; no rotation seed or persist
  on the paper path; the commit call carries target and symbol; the result string.
- **App** (`app` jest): pager order with the board's paper first; placeholder page for a
  symbol with no paper; no pager without a token; the board list publishes and refreshes;
  the client methods' paths, headers and result shapes.
- **Simulator and firmware**: unchanged and must stay green, because nothing on the wire
  moved.
