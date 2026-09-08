# The schedule and what you hold — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to
> implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The owner declares the positions they actually hold; an agent researches ten ranked
upcoming events against them, each saying why it matters; the phone shows that as a calendar and
is pushed before the date arrives.

**Architecture:** Four new stores and two new outbound callers on the desk, a second command kind
for the agent, and three new surfaces in the app. The board is not touched.

**Tech Stack:** Python 3.12 stdlib (desk, agent), React Native 0.85 / Expo SDK 56 / TypeScript
(app), `expo-notifications` (new native module).

**Spec:** [docs/specs/2026-09-08-schedule-and-positions-design.md](../../specs/2026-09-08-schedule-and-positions-design.md)

---

## Global Constraints

Every task's requirements implicitly include this section.

1. **The desk and the agent are stdlib-only.** No new required dependency. `cloudscraper` and
   `requests` may be *optionally* imported by `econ.py` and fallen through on any exception; the
   stdlib `urllib` path must work with none of them installed.
2. **Money is integer cents. Times are UTC on the wire.** `strike_cents`, `entry_price_cents`,
   `at: "...Z"`. No floats cross a wire or a file. (Precedent: `quotes.py`'s `lastCents`.)
3. **Unknown keys are refused whole with a 400.** Every new document validator mirrors
   `watchlist.py`: `_bad()`, `_no_extra_keys()`, `_bounded_str()`, `_serialised()` via
   `fsutil.json_bytes`, and the aggregate cap weighed against *the bytes `save()` writes*.
4. **A rejected document leaves the one in force untouched.** Parse fully, then commit.
5. **Nothing personal is committed.** `positions.json`, `calendar.json`, `push.json` live in the
   data directory at 0600. The repository ships `positions.example.json` and nothing else. No
   real ticker, strike, or push token in any committed file, fixture or test.
6. **Positions must never reach `news.json`.** `/news.json` is served with no authorization. This
   is enforced structurally in Task D7 and by the command split in Task A9 — never by a sentence
   in a prompt alone.
7. **The operator token stays in SecureStore.** Never AsyncStorage, never a log line, never a
   `console.log`, never an error message body.
8. **App styling comes from `theme.ts`.** No literal hex in a component. Green is up, red is down
   (settled in the spec §1). A style that sets one of the Inter `fontFamily` tokens must NOT also
   set `fontWeight` — the weight is baked into the face and Android drops to the system font.
9. **`app/src/i18n/en.ts` is the type; `ko.ts` must match it exactly.** Every new user-visible
   string is a catalogue entry in both. No literal copy in a component.
10. **Gates, all green before a task is complete:** `sh server/test/run.sh`,
    `sh agent/test/run.sh`, `cd app && npm test && npm run typecheck`. A task that touches only
    one tree still may not break another.
11. **Never commit `sdkconfig`, `build/`, `managed_components/`, or `app/node_modules`.**

---

## File Structure

```
server/claudepost/
  positions.py      NEW  the owner's holdings: schema, validation, derive_strategy, load/save
  calendar.py       NEW  the event book: schema, the source rule as a validator
  econ.py           NEW  investing.com -> cached UTC events (ported from the sibling project)
  push.py           NEW  the phones we notify: device document + Expo Push delivery
  alerts.py         NEW  pure: which (device, event, lead) are due at instant t, and quiet hours
  app.py            MOD  Config paths, load on init, setters, _fire_due_alerts in tick
  http.py           MOD  seven routes
  store.py          MOD  the delivery ledger table
  watchlist.py      MOD  one docstring: point at positions.py so the boundary is not misread
server/test/
  test_positions.py test_calendar.py test_econ.py test_push.py test_alerts.py   NEW
  fixtures/investing_rows.html  fixtures/expo_push_receipt.json                 NEW
agent/
  loop.py           MOD  the `calendar` command kind, seed_positions, seed_calendar, upload
  prompt.py         MOD  which contract file a kind reads
tools/edition/
  CALENDAR.md       NEW  the event-book brief
app/src/
  lib/positions.ts  NEW  types + desk client + strategyLabel (pure)
  lib/schedule.ts   NEW  types + desk client + day grouping (pure)
  lib/notify.ts     NEW  permission, token registration, the Settings surface's state
  components/PositionSheet.tsx  ScheduleRow.tsx  ScheduleDayGroup.tsx  UpcomingBlock.tsx  NEW
  app/schedule.tsx  NEW  the full book
  app/add-ticker.tsx            MOD  the position sheet
  app/(tabs)/markets.tsx        MOD  the upcoming block
  components/detail/CalendarSection.tsx  MOD  this symbol's slice
  app/(tabs)/settings.tsx       MOD  notification preferences
  i18n/en.ts ko.ts              MOD
docs/
  desk-server.md app-control.md CLAUDE.md   MOD
```

---

## Task ordering and why

D1–D2 first: every other task consumes those schemas. D3–D4 are independent outbound callers.
D5 wires them; D6 makes them fire; D7 is the safety property and must land before the agent can
ever see a position (A9). A8–A9 give the book a producer. P10–P15 are the phone. F16 is the
paper trail.

---

### Task D1: `positions.py` — the owner's holdings

**Files:**
- Create: `server/claudepost/positions.py`
- Create: `server/test/test_positions.py`
- Create: `server/positions.example.json`
- Modify: `server/claudepost/watchlist.py` (one docstring only)

**Interfaces:**
- Consumes: `claudepost.errors.BadRequest`, `claudepost.fsutil.json_bytes` and its atomic
  write helper (read `fsutil.py` and use what `watchlist.py` uses — do not invent a second one).
- Produces:
  - `parse_positions(body: object) -> dict` — validates and returns the canonical document.
  - `derive_strategy(legs: list[dict]) -> str` — pure, the enum below.
  - `load(path: str) -> dict | None`, `save(path: str, doc: dict) -> None`
  - `STRATEGIES: tuple[str, ...]`, `MAX_POSITIONS = 64`, `MAX_LEGS = 4`

**Document shape** (spec §3). Top-level keys exactly `{"updated_at", "positions"}`. Each position:

| key | rule |
|---|---|
| `id` | assigned by the desk, `^p_[0-9a-f]{6}$`; a body may carry one (round-trip) but it is re-derived, never trusted |
| `symbol` | `^[A-Z0-9.\-]{1,12}$` (same as `watchlist.py` — digits allowed for KR tickers) |
| `kind` | `"stock"` or `"option"` |
| `strategy` | **output only.** A body carrying one is refused as an unknown key — the desk derives it |
| `legs` | option only, 1..4, each `{right, side, strike_cents, expiry, contracts, entry_price_cents}` |
| `quantity` | stock only, signed int, `-1_000_000 <= q <= 1_000_000`, never 0 |
| `entry_price_cents` | stock only, int `>= 0` |
| `opened_at` | `YYYY-MM-DD` or absent |
| `note` | ≤ 500 chars, default `""` |

Leg fields: `right` ∈ `{"call","put"}`; `side` ∈ `{"long","short"}`; `strike_cents` int > 0;
`expiry` `YYYY-MM-DD`, a real date, within 3 years of today; `contracts` int 1..10_000;
`entry_price_cents` int >= 0.

Aggregate cap 128 KiB, weighed against `_serialised(doc)` exactly as `watchlist.py` does — read
that module's `_serialised` docstring first, it explains the trap (a PUT accepted then refused by
the next boot's `load`).

- [ ] **Step 1: Write the failing tests for `derive_strategy`**

`server/test/test_positions.py`. Use a helper so the cases read as data:

```python
def leg(right, side, strike, expiry="2026-11-21", contracts=1, price=100):
    return {"right": right, "side": side, "strike_cents": strike,
            "expiry": expiry, "contracts": contracts, "entry_price_cents": price}


def test_single_leg_strategies():
    assert P.derive_strategy([leg("call", "long", 42000)]) == "long_call"
    assert P.derive_strategy([leg("put", "long", 38000)]) == "long_put"
    assert P.derive_strategy([leg("call", "short", 45000)]) == "short_call"
    assert P.derive_strategy([leg("put", "short", 35000)]) == "short_put"


def test_vertical_is_same_right_same_expiry_different_strike():
    legs = [leg("call", "long", 40000), leg("call", "short", 42000)]
    assert P.derive_strategy(legs) == "vertical"


def test_calendar_is_same_right_same_strike_different_expiry():
    legs = [leg("call", "long", 42000, expiry="2026-11-21"),
            leg("call", "short", 42000, expiry="2026-12-19")]
    assert P.derive_strategy(legs) == "calendar"


def test_straddle_and_strangle():
    same = [leg("call", "long", 42000), leg("put", "long", 42000)]
    assert P.derive_strategy(same) == "straddle"
    apart = [leg("call", "long", 44000), leg("put", "long", 40000)]
    assert P.derive_strategy(apart) == "strangle"


def test_anything_else_is_custom_not_a_guess():
    legs = [leg("call", "long", 40000), leg("put", "short", 38000),
            leg("call", "short", 44000)]
    assert P.derive_strategy(legs) == "custom"
```

**`STRATEGIES` names only what legs can prove.** Two names that a first draft of this plan
carried are deliberately *not* in the enum:

- **`cash_secured_put`** — "cash-secured" is a claim about collateral sitting in the account, and
  the desk cannot see an account. A lone short put is `short_put`; whether it is secured is not
  something legs know.
- **`covered_call`** — needs the stock position beside the option one, which
  `derive_strategy(legs)` does not receive. Naming that pairing is a *display* decision with the
  whole book in hand, and Task P10 makes it.

Assert both: `derive_strategy([leg("call","short",…)])` is `short_call` and never
`covered_call`; `derive_strategy([leg("put","short",…)])` is `short_put` and never
`cash_secured_put`. A validator that stores a name the data cannot support is a validator
teaching the reader to trust the wrong field.

- [ ] **Step 2: Run them and watch them fail** — `sh server/test/run.sh` → ImportError.

- [ ] **Step 3: Write `derive_strategy`**

```python
def derive_strategy(legs: list[dict]) -> str:
    """Name what these legs are, or refuse to guess.

    The owner picks a shape in the app and types legs; this turns the legs back
    into the name so the phone can say "콜 버티컬 400/420" without the owner
    having to classify their own trade. It is here rather than in the app
    because the agent needs the same name, and a second implementation in
    TypeScript is a second implementation that can disagree.

    ``custom`` is a real answer, not a failure. A shape this cannot name is one
    the reasoning should describe in words rather than one the desk should
    mislabel -- a mislabelled spread is worse than an unlabelled one, because
    the owner stops reading the legs.
    """
    if len(legs) == 1:
        one = legs[0]
        if one["side"] == "long":
            return "long_call" if one["right"] == "call" else "long_put"
        return "short_call" if one["right"] == "call" else "cash_secured_put"

    if len(legs) == 2:
        a, b = legs
        rights = {a["right"], b["right"]}
        sides = {a["side"], b["side"]}
        same_expiry = a["expiry"] == b["expiry"]
        same_strike = a["strike_cents"] == b["strike_cents"]

        if len(rights) == 1 and sides == {"long", "short"}:
            if same_expiry and not same_strike:
                return "vertical"
            if same_strike and not same_expiry:
                return "calendar"
        if rights == {"call", "put"} and len(sides) == 1 and same_expiry:
            return "straddle" if same_strike else "strangle"

    return "custom"
```

- [ ] **Step 4: Run the tests** — expect PASS.

- [ ] **Step 5: Write the validator tests**, then the validator

Cases that must be refused, each asserting the *message names the field*:
`{"positions": [{"symbol": "ETN", "kind": "option", "strategy": "long_call", "legs": [...]}]}`
(strategy is output-only → unknown key); a stock position carrying `legs`; an option position
carrying `quantity`; `contracts: 0`; `strike_cents: 0`; `expiry: "2026-02-30"`; an expiry five
years out; `quantity: 0`; 65 positions; 5 legs; a `note` of 501 chars; a symbol with a lowercase
letter; a document whose serialised form exceeds 128 KiB.

Cases that must be accepted: the two positions from spec §3 verbatim; a document that has been
GET-then-PUT round-tripped (carries `updated_at` and `id`, both re-derived rather than trusted);
an empty `positions` list (the owner deleted their last one — a real state, not an error).

Assert `id` stability explicitly: PUT a document, read back the ids, PUT the same document again,
and assert the ids are unchanged. Derive the id from `(symbol, kind, sorted legs / quantity,
opened_at)` with a truncated `hashlib.blake2s` so it is stable without the desk keeping a
counter; a genuinely new position gets a genuinely new id, and editing a position's price is an
edit of that position, not a new one — so `entry_price_cents` and `note` are NOT in the id.

- [ ] **Step 6: `load` / `save` / `positions.example.json`**

Mirror `watchlist.py` exactly. `save()` writes through the same atomic write-then-rename and the
same `json_bytes`, and chmods 0600. `load()` returns `None` for a missing or unparseable file —
and, like `watchlist.load`, must not raise on a file it will not take.

`server/positions.example.json` holds one stock and one option position with obviously invented
symbols (`AAAA`, `BBBB`) — **never a real ticker**, per Global Constraint 5.

- [ ] **Step 7: Correct `watchlist.py`'s boundary docstring**

`_no_extra_keys` says "a stop level, an entry price, a P&L figure has no key here to hide
behind." That stays true of the watchlist and is now *misleading about the desk*. Extend it —
do not delete it — to say the boundary is unchanged for this document and that holdings live in
`positions.py` under an explicit decision recorded in the spec.

- [ ] **Step 8: Run the gates and commit**

```bash
sh server/test/run.sh
git add server/claudepost/positions.py server/test/test_positions.py \
        server/positions.example.json server/claudepost/watchlist.py
git commit -m "feat(desk): the positions the owner actually holds"
```

---

### Task D2: `calendar.py` — the event book, and the source rule as a wall

**Files:**
- Create: `server/claudepost/calendar.py`, `server/test/test_calendar.py`

**Interfaces:**
- Consumes: D1's `MAX_POSITIONS`; `errors.BadRequest`; `fsutil.json_bytes`.
- Produces: `parse_calendar(body, *, known_position_ids: set[str]) -> dict`,
  `load`, `save`, `KINDS`, `PRECISIONS`, `DIRECTIONS`, `MAX_EVENTS = 40`.

Document shape is spec §4 verbatim. `MAX_EVENTS` is 40 rather than 10 because `target` is a
setting and the book may legitimately carry more than it shows.

**This task is the spec's §2 rule made executable.** Three refusals carry the whole feature:

- [ ] **Step 1: Write the failing tests for the three refusals**

```python
def test_an_event_without_a_source_is_refused():
    doc = book(event(source=None))
    with pytest.raises(BadRequest) as e:
        C.parse_calendar(doc, known_position_ids={"p_7f3a"})
    assert "source" in str(e.value)


def test_a_researched_event_must_carry_a_url_not_a_word():
    doc = book(event(kind="corporate", source="the company said so"))
    with pytest.raises(BadRequest):
        C.parse_calendar(doc, known_position_ids={"p_7f3a"})


def test_computed_is_only_legal_for_the_kinds_a_machine_knows():
    # An analyst day is not something the desk computes.
    doc = book(event(kind="corporate", source="computed"))
    with pytest.raises(BadRequest):
        C.parse_calendar(doc, known_position_ids={"p_7f3a"})
    # An option expiry is.
    ok = book(event(kind="expiry", source="computed"))
    assert C.parse_calendar(ok, known_position_ids={"p_7f3a"})["events"]


def test_affects_may_not_name_a_position_that_does_not_exist():
    doc = book(event(affects=[{"position_id": "p_ffffff", "direction": "for",
                               "reason": "…", "reason_short": "…"}]))
    with pytest.raises(BadRequest):
        C.parse_calendar(doc, known_position_ids={"p_7f3a"})
```

`COMPUTED_KINDS = {"earnings", "dividend", "expiry", "econ"}`. Everything else must carry an
`https://` URL, and `source` is required on every event with no default — an absent source is a
refusal, never an empty string.

- [ ] **Step 2: The reasoning may not introduce a date**

The hardest half of the rule, and the one a validator can only approximate. Approximate it
honestly rather than pretending:

```python
def test_reasoning_carrying_a_bare_date_is_refused():
    """A reason that names its own date is a date with no source.

    This is a heuristic and is documented as one: it catches an ISO date or a
    Korean `M월 D일` in `reason`/`reason_short` and refuses it. A reason may
    still refer to a date in words ("발표 다음 날"), which is fine -- what it
    may not do is assert a specific calendar date the book cannot show a
    source for, because the reader has no way to check it.
    """
    doc = book(event(affects=[aff(reason="2026-11-12에 신제품이 나와요")]))
    with pytest.raises(BadRequest):
        C.parse_calendar(doc, known_position_ids={"p_7f3a"})
```

Implement as a single compiled regex, `_DATE_IN_PROSE`, matching `\d{4}-\d{2}-\d{2}` and
`\d{1,2}\s*월\s*\d{1,2}\s*일`. Document in the module docstring that it is a heuristic, what it
is approximating, and why an approximation is still worth having (a wrong date in a sentence
about the owner's money is the worst output this system can produce, and a sentence is where a
model puts one).

- [ ] **Step 3: The rest of the schema**

`at` must be an RFC3339 instant ending `Z`, parseable, and within `[now - 7d, now + 400d]` —
the past window exists because an event just fired and the book is still showing it.
`precision` ∈ `{"exact","session","day"}`, and it governs two other fields so the wire cannot
carry a precision it contradicts:

- `precision: "day"` → the instant's time-of-day must be `00:00:00Z`, and `session` must be
  absent. The app renders `종일` and, by test, **never** a `HH:MM`.
- `precision: "session"` → `session` is **required** and is one of `{"bmo","amc"}` (before market
  open / after market close). The instant still has to be a real instant — use the session's
  conventional time in US/Eastern — because the day grouping needs one; but the app renders the
  session word, never the instant.
- `precision: "exact"` → `session` must be absent.

`direction` ∈ `{"for","against","both"}`. `rank` int 1..40,
unique across events. `title` ≤ 80 chars, `reason_short` ≤ 90, `reason` ≤ 600.
`push` optional: `{title ≤ 60, body ≤ 180}`. `shortfall` is `None` or a string ≤ 160.
`symbols` 1..8 entries, each the symbol pattern.

- [ ] **Step 4: `load`/`save`, aggregate cap 256 KiB, run the gates, commit**

```bash
git commit -m "feat(desk): the event book, and the rule that a date needs a source"
```

---

### Task D3: `econ.py` — investing.com

**Files:**
- Create: `server/claudepost/econ.py`, `server/test/test_econ.py`,
  `server/test/fixtures/investing_rows.html`

**Interfaces:**
- Produces: `EconSource(fetch=..., clock=...)` with `.events(from_date, to_date) -> list[dict]`
  and `.health() -> dict`; `parse_rows(html: str) -> list[dict]` (pure).

Port `tools/econ_proxy/econ_proxy.py` from the sibling project — the design brief carries the
exact request shape (spec §5). Differences from the original, and each is deliberate:

1. **Inside the desk, not a second service.** Follows `quotes.py`: `urllib`, an **injected
   `fetch`** so no test touches the network, a cache, and every string built from an upstream
   failure passed through redaction before it exists. Read `quotes.py` first and copy its shape;
   do not invent a second one.
2. **Cache one hour**, per symbol-free date window. An economic calendar does not move within
   the hour, and the phone pulls to refresh.
3. **`impact` stays a string** (`"Low"|"Medium"|"High"`) on the wire — it is what investing.com
   means, and this desk's ranking (spec §4) is a different quantity that must not be conflated
   with it.
4. **Failure keeps the last good window** and records the cause in `health()`, surfaced in
   `/api/state`. The sibling project's device does exactly this and its comment says why:
   "record the cause, so the home rows report the failure instead of presenting a week-old
   schedule as current."

- [ ] **Step 1: Commit the fixture first.** `investing_rows.html` — a hand-trimmed capture of
  three `<tr>` rows (one High, one Medium, one with an empty `actual`), with **no** real
  cookie, token or session id in it. This is the artefact that turns a scraper break into a
  failing test instead of a blank screen.

- [ ] **Step 2: Write the parser tests against the fixture**

Assert: three events; `date` is `"YYYY-MM-DD HH:MM:SS"`; `impact` maps from the count of
`grayFullBullishIcon` in the third cell (3→High, 2→Medium, 1→Low); an empty `actual` stays `""`
and does not become `None` or `"--"`; the events come back sorted ascending by `date`. Add one
test that a row whose markup has changed shape (a missing `data-event-datetime`) is **skipped
with a counted warning**, not crashed on and not silently dropped — `health()` reports
`parsed`/`skipped` so a partial break is visible.

- [ ] **Step 3: Write `parse_rows`, then `EconSource`**

The transport tries `cloudscraper` → `requests` → `urllib.request` in that order, falling through
on **any** exception, so an installed library hitting a Cloudflare challenge cannot abort the
chain. Both optional imports are inside the function, guarded. 25 s timeout each.

- [ ] **Step 4: A test that no credential can appear in an error**

Give the fake fetch a raiser whose message contains `SECRET-TOKEN-VALUE`, and assert that string
appears in neither the raised message, the `health()` dict, nor anything the module logs. Same
property `quotes.py` asserts, same reason.

- [ ] **Step 5: Gates and commit** — `git commit -m "feat(desk): the economic calendar, scraped and cached"`

---

### Task D4: `push.py` — the phones we notify

**Files:**
- Create: `server/claudepost/push.py`, `server/test/test_push.py`,
  `server/test/fixtures/expo_push_receipt.json`

**Interfaces:**
- Produces: `parse_devices(body) -> dict`, `load`, `save`,
  `send(messages: list[dict], *, fetch) -> list[dict]` (returns tickets),
  `prune_unregistered(doc, tickets) -> tuple[dict, list[str]]`.

Device document is spec §5 verbatim. Token pattern `^Expo(nent)?PushToken\[[A-Za-z0-9_\-]+\]$`.
`lead` values are ISO-8601 durations from a **closed set** — `{"PT1H","PT3H","PT12H","P1D","P2D","P7D"}`
— parsed to seconds by a small table, not by a general duration parser. A general parser is
surface area for a feature that needs six values.

- [ ] **Step 1: Tests for the device document**, mirroring D1's shape. Refuse: an unknown key; a
  malformed token; a `quiet` window that is not `HH:MM`; an unknown lead; more than 8 devices.
  Accept: a device with `prefs` all false (the owner turned everything off — a real state).

- [ ] **Step 2: Tests for `send` against a fake fetch**

Expo accepts up to 100 messages per request; assert a 250-message list is sent as three calls.
Assert the request body is a JSON *array* and the headers include `accept-encoding: gzip, deflate`
and `content-type: application/json`. Assert a `DeviceNotRegistered` ticket removes exactly that
token via `prune_unregistered` and leaves the others. Assert an HTTP failure raises a redacted
error and removes nothing — a network blip must never delete the owner's phone.

- [ ] **Step 3: Implement.** POST `https://exp.host/--/api/v2/push/send`, stdlib `urllib`,
  injected `fetch`, redaction. **No access token** — Expo push works unauthenticated for this
  project shape; if EAS later requires one it goes in `tokens.json` beside the others, never in
  the repository.

- [ ] **Step 4: Gates and commit** — `git commit -m "feat(desk): pushing to the owner's phone"`

---

### Task D5: wiring — `app.py`, `http.py`, the seven routes

**Files:**
- Modify: `server/claudepost/app.py`, `server/claudepost/http.py`
- Modify: `server/test/test_http.py`

**Interfaces:**
- Consumes: D1–D4.
- Produces: `Desk.positions`, `Desk.calendar`, `Desk.push_devices`, `Desk.econ`, and
  `set_positions`, `set_calendar`, `set_push_devices` — each following `set_watchlist`'s shape
  exactly (validate, stamp with the desk's own clock, put in force, write, audit).

Routes (spec §5). Scopes are not negotiable — read `auth.py`'s ranking note before writing them:

```python
    (re.compile(r"^/api/positions\Z"), {
        "GET": ("producer", DeskHTTPRequestHandler.h_get_positions),
        "PUT": ("operator", DeskHTTPRequestHandler.h_put_positions)}),
    (re.compile(r"^/api/calendar\Z"), {
        "GET": ("producer", DeskHTTPRequestHandler.h_get_calendar),
        "PUT": ("producer", DeskHTTPRequestHandler.h_put_calendar)}),
    (re.compile(r"^/api/econ\Z"), {
        "GET": ("producer", DeskHTTPRequestHandler.h_get_econ)}),
    (re.compile(r"^/api/push/devices\Z"), {
        "GET": ("operator", DeskHTTPRequestHandler.h_get_push_devices),
        "POST": ("operator", DeskHTTPRequestHandler.h_post_push_device)}),
    (re.compile(r"^/api/push/devices/(?P<token>[^/]{1,120})\Z"), {
        "DELETE": ("operator", DeskHTTPRequestHandler.h_delete_push_device)}),
```

`PUT /api/calendar` is **producer** because the agent files it. `PUT /api/positions` is
**operator** because only the owner says what they hold — an agent that could rewrite the
positions could arrange for the reasoning to be about a position the owner does not have.
`/api/push/devices` is operator throughout: a push token is a capability to interrupt the owner.

`h_put_calendar` passes `known_position_ids` from `self.desk.positions`, which is what makes D2's
fourth refusal reachable.

- [ ] **Step 1: Extend `test_http.py`** — for each route: the 401 with no token, the 403 with a
  producer token on an operator route, the happy path, and a 400 whose body names the bad field.
  Follow the file's existing helpers rather than building new ones.
- [ ] **Step 2: Config and load-on-init in `app.py`**, beside `watchlist_path` / `settings_path`.
- [ ] **Step 3: The handlers.** Each is four lines; the docstrings carry the scope reasoning.
- [ ] **Step 4: Add counts to `state()`** — `positions`, `calendar` (count + `generated_at` +
  `shortfall`), `push` (device count + failure streak), `econ` (`health()`). This is the surface
  a failure is visible on, per spec §9.
- [ ] **Step 5: Gates and commit** — `git commit -m "feat(desk): routes for positions, the book, the calendar and the phones"`

---

### Task D6: `alerts.py` and the tick

**Files:**
- Create: `server/claudepost/alerts.py`, `server/test/test_alerts.py`
- Modify: `server/claudepost/app.py`, `server/claudepost/store.py`

**Interfaces:**
- Produces: `due(book, devices, delivered, now) -> list[Alert]` — **pure**;
  `Alert = namedtuple("Alert", "token event_id lead at_utc title body")`;
  `defer_for_quiet(alert, device, now) -> float | None`.
- `Store.record_delivery(token, event_id, lead, at)` / `Store.deliveries_since(t)`.

The point of a pure `due()` is the same point `Desk.tick`'s docstring already makes: the
interesting instants — the moment a lead time passes, the moment a quiet window ends — are
exactly the ones a test must step over rather than wait for.

- [ ] **Step 1: Write the tests first, as a table of instants**

```python
def test_a_lead_fires_once_and_only_once():
    book = one_event(at="2026-11-04T21:00:00Z")
    dev = device(prefs={"earnings": True}, lead={"earnings": ["P1D"]})
    first = A.due(book, [dev], delivered=[], now=ts("2026-11-03T21:00:01Z"))
    assert len(first) == 1
    again = A.due(book, [dev], delivered=[rec(first[0])], now=ts("2026-11-03T21:05:00Z"))
    assert again == []


def test_a_lead_that_passed_while_the_desk_was_down_still_fires():
    """A restart is not a reason to miss the owner's expiry."""
    book = one_event(at="2026-11-04T21:00:00Z")
    dev = device(lead={"earnings": ["P1D"]})
    late = A.due(book, [dev], delivered=[], now=ts("2026-11-04T09:00:00Z"))
    assert len(late) == 1


def test_a_lead_whose_event_has_already_happened_does_not_fire():
    book = one_event(at="2026-11-04T21:00:00Z")
    dev = device(lead={"earnings": ["P1D"]})
    assert A.due(book, [dev], delivered=[], now=ts("2026-11-05T09:00:00Z")) == []


def test_quiet_hours_defer_rather_than_drop():
    dev = device(tz="Asia/Seoul", quiet={"from": "23:00", "to": "07:00"})
    alert = the_alert(at=ts("2026-11-04T15:30:00Z"))   # 00:30 KST
    when = A.defer_for_quiet(alert, dev, now=ts("2026-11-04T15:30:00Z"))
    assert when == ts("2026-11-04T22:00:00Z")           # 07:00 KST


def test_a_pref_turned_off_silences_its_kind_and_nothing_else():
    ...
```

The second and third tests are the pair that matters: a desk that was off for six hours must
deliver the lead it missed, but must not deliver one whose event is already in the past — and
those two rules pull in opposite directions, which is why they are written together.

`defer_for_quiet` needs a timezone. **Use `zoneinfo`** (stdlib) with the device's `tz`; a device
whose `tz` is unknown to this machine's database falls back to no quiet window rather than to
UTC, because a wrong quiet window is worse than none.

- [ ] **Step 2: The delivery ledger.** One table in `store.py`, following the existing migration
  pattern in that file. Primary key `(token, event_id, lead)`. `deliveries_since` bounds the
  read; deliveries older than 60 days are reaped by the existing housekeeping pass.

- [ ] **Step 3: `_fire_due_alerts(t)` in `Desk.tick`**

Beside `_fire_due_wake(t)`, returning a `did` entry. **Idempotent** — the ledger is written
*before* the send is attempted for the tickets that succeeded, and a send failure is retried on
the next tick from the un-recorded rows. Cap the batch so one tick cannot spend minutes in
`urlopen`. Any exception is caught and logged and must never take the tick down: a scheduler that
dies on a push failure stops publishing the newspaper.

- [ ] **Step 4: Gates and commit** — `git commit -m "feat(desk): fire an alert before the date, once"`

---

### Task D7: positions can never reach the public plane

**Files:**
- Modify: `server/claudepost/editions.py` (or wherever a draft payload is validated — find it)
- Create: `server/test/test_public_plane.py`

This is Global Constraint 6, made structural.

- [ ] **Step 1: Write the tests first — they are the deliverable**

```python
FORBIDDEN = ("strike_cents", "entry_price_cents", "contracts", "positions",
             "position_id", "legs")


def test_a_payload_carrying_a_position_field_at_any_depth_is_refused():
    for key in FORBIDDEN:
        payload = valid_edition()
        payload["stories"][0][key] = "anything"
        with pytest.raises(BadRequest):
            put_draft_payload(payload)


def test_the_device_plane_serves_only_the_three_documented_routes():
    """Not 'does not today' -- cannot. A new route added to the control plane
    must not become reachable without a token by being spelled at the wrong
    end of http.py."""
    from claudepost.http import _DEVICE_ROUTES
    served = {r.pattern for r, _ in _DEVICE_ROUTES}
    assert served == {EXPECTED_NEWS, EXPECTED_HEALTHZ, EXPECTED_TILE}


def test_no_control_plane_path_answers_without_a_token():
    """Every control-plane route, by a curated sample path per route.

    Deliberately NOT a path generated from the regex -- generating one is
    fiddly enough to be wrong quietly, which is the opposite of what this test
    is for. SAMPLES is a literal dict from pattern to a path that matches it,
    and the first assertion is that it covers every route: adding a route
    without adding a sample fails here rather than shipping unguarded.
    """
    assert {p.pattern for p, _ in _ROUTES} == set(SAMPLES), "a route has no sample path"
    for pattern, methods in _ROUTES:
        for method in methods:
            assert unauthenticated(method, SAMPLES[pattern.pattern]).status == 401
```

- [ ] **Step 2: Implement the payload refusal** where a draft's `news.json` is validated. Recurse
  the whole document — a position field nested three deep is the case a shallow check misses.
- [ ] **Step 3: Gates and commit** — `git commit -m "test(desk): a position cannot reach the public plane"`

---

### Task A8: `tools/edition/CALENDAR.md` — the brief

**Files:**
- Create: `tools/edition/CALENDAR.md`

Prose only; no code. Structure it as `PROMPT.md` is structured, and read that file first to match
its voice — it is a contract addressed to a working model, not documentation about one.

Sections, in this order:

1. **What you produce** — `calendar.json`, written last and atomically, the shape from spec §4.
2. **The three tiers, and the refusal.** Computed / researched / reasoning. State the rule as
   the desk states it: an event without a source is refused by the validator, so filing one
   fails the run rather than producing a wrong book. Name the four computed kinds.
3. **Ranking is by effect on the positions in front of you**, not by newsworthiness. Give the
   worked example: an FOMC meeting outranks this company's product launch when the owner is
   long a call whose vega dominates its delta.
4. **Ten, and the floor.** Keep looking until ten clear the floor. Do not pad. When fewer clear
   it, write `shortfall` in the owner's language and say what you looked for.
5. **The reasoning.** `reason_short` is one sentence and is what the calendar shows;
   `reason` is a paragraph and is what a tap opens. State the mechanism explicitly enough that
   the owner can disagree with it — "IV가 빠져서" is not a mechanism, "발표 뒤 IV가 30%대에서
   20%대로 내려오면 만기 74일 남은 콜은 주가가 그대로여도 프리미엄이 줄어요" is.
6. **The voice.** 해요체. No jargon the owner did not use first. Never frighten someone about
   their own money — say what could happen and why, not what they should do. Emoji inside the
   sentence in `push`, not decorating it. Give the two worked examples from spec §8.
7. **What you must never do.** Introduce a date that is not an event in the book. Write about a
   position that is not in `positions.json`. Put any of this in `news.json` — that file is
   served publicly and this one is not.
8. **Before you finish** — the self-check list, ending with: read your own ten back and ask
   whether the tenth earned its place, because that is the one the floor exists for.

- [ ] **Step 1: Write it.** **Step 2:** `git commit -m "docs(agent): the brief for the event book"`

---

### Task A9: the `calendar` command kind

**Files:**
- Modify: `agent/loop.py`, `agent/prompt.py`
- Modify: `agent/test/` (follow the directory's existing test style)

**Interfaces:**
- Consumes: D5's routes, A8's brief.
- Produces: `seed_positions(cfg, workdir) -> bool`, `seed_calendar(cfg, workdir) -> bool`,
  `upload_calendar(client, workdir) -> None`.

- [ ] **Step 1: Tests first — the split is the safety property**

```python
def test_seed_positions_runs_only_for_the_calendar_kind():
    """The newspaper's producer never has the file. This is the structural
    half of the rule that positions do not reach news.json; the validator in
    D7 is the other half, and neither is sufficient alone."""
    for kind in ("file_edition", "research", "custom"):
        workdir = run_seeding(kind)
        assert not os.path.exists(os.path.join(workdir, "positions.json"))
    workdir = run_seeding("calendar")
    assert os.path.exists(os.path.join(workdir, "positions.json"))


def test_a_calendar_run_files_no_edition():
    """A calendar command that produced a news.json is a bug, and the loop
    refuses it rather than uploading it."""
    ...
```

- [ ] **Step 2: `seed_positions` / `seed_calendar`**, mirroring `seed_watchlist` — same size cap
  posture, same "a missing file is a documented first run, not an error".
- [ ] **Step 3: `handle()` gains the kind.** Read the existing docstring at `loop.py:574` — it
  explains that `kind` does not decide alone, and says why. `calendar` **does** decide alone: it
  takes the calendar path, reads `CALENDAR.md`, uploads `calendar.json` and never opens a draft.
- [ ] **Step 4: `prompt.py`** — which contract file a kind reads. Keep the existing property that
  for `en` the edition prompt is byte-identical to before; assert it.
- [ ] **Step 5: `write_brief`** logs the book's event count and `shortfall`.
- [ ] **Step 6: Gates and commit** — `git commit -m "feat(agent): a second job — the event book"`

---

### Task P10: the app's positions client

**Files:**
- Create: `app/src/lib/positions.ts`, `app/src/lib/positions.test.ts`
- Modify: `app/src/lib/desk.ts`, `app/src/i18n/en.ts`, `app/src/i18n/ko.ts`

**Interfaces:**
- Produces: `Position`, `OptionLeg`, `Strategy` types; `strategyLabel(p, t) -> string`;
  `deskClient.positions()` / `.putPositions(doc)`.

`strategyLabel` is the display half of D1's `derive_strategy` — the desk owns the enum, the app
owns the words. That split is why there is no second derivation in TypeScript.

- [ ] **Step 1: Tests for `strategyLabel`**

```ts
it('names a single leg with its strike and expiry', () => {
  expect(strategyLabel(longCall, ko)).toBe('11월 21일 만기 420 콜')
})
it('names a vertical by both strikes', () => {
  expect(strategyLabel(vertical, ko)).toBe('콜 버티컬 400/420')
})
it('pairs a short call against stock as a covered call', () => {
  // The one strategy derive_strategy cannot see, because it needs the stock
  // position beside the option one.
  expect(strategyLabel(shortCall, ko, { stockShares: 200 })).toBe('커버드 콜 420')
})
it('falls back to the leg list rather than inventing a name', () => {
  expect(strategyLabel(custom, ko)).toBe('콜 400 롱 · 풋 380 숏 · 콜 440 숏')
})
```

- [ ] **Step 2: Implement**, catalogue entries in both `en.ts` and `ko.ts`.
- [ ] **Step 3: Extend `desk.ts`** following its existing client shape — the token goes into one
  header and is never read from storage here (`deskToken.ts` owns the keychain).
- [ ] **Step 4: Gates and commit** — `git commit -m "feat(app): what you hold, and what to call it"`

---

### Task P11: entering a position

**Files:**
- Create: `app/src/components/PositionSheet.tsx`
- Modify: `app/src/app/add-ticker.tsx`, `app/src/i18n/{en,ko}.ts`

The flow from spec §8: choose a shape, fill the legs that shape implies, and the app says the
name back.

- [ ] **Step 1:** The shape chips — `주식 / 롱 콜 / 롱 풋 / 숏 콜 / 숏 풋 / 스프레드`. Chips use
  the existing `Chip` component and `radius.pill`; nothing new in `theme.ts`.
- [ ] **Step 2:** The leg form. `expiry` uses a date input, not free text. `strike` and price are
  entered in dollars and converted to cents **at the boundary** — one function, tested, because
  a float that reaches the wire is the bug Global Constraint 2 exists to prevent.
- [ ] **Step 3:** The confirmation line, from P10's `strategyLabel`. This is the step that catches
  a mistyped strike, so it is not optional and not a toast.
- [ ] **Step 4:** Save writes through `deskClient.putPositions`. A 400 from the desk is rendered
  with the field name the desk named — the validator's messages were written to be read here.
- [ ] **Step 5:** Tests: the sheet renders each shape's leg count; dollars→cents at the boundary;
  a desk 400 surfaces its detail; the token never appears in any rendered string.
- [ ] **Step 6:** Gates and commit — `git commit -m "feat(app): say exactly what you hold"`

---

### Task P12: the schedule screen

**Files:**
- Create: `app/src/lib/schedule.ts` (+ test), `app/src/app/schedule.tsx`,
  `app/src/components/{ScheduleRow,ScheduleDayGroup}.tsx`
- Modify: `app/src/i18n/{en,ko}.ts`

**Interfaces:**
- Produces: `groupByDay(events, now, tz) -> DayGroup[]` (pure); `timeLabel(event, t) -> string`
  (pure); the two components.

- [ ] **Step 1: Tests for the two pure functions**

```ts
it('labels the day relatively near, absolutely far', () => {
  expect(dayLabel(today, now, ko)).toBe('오늘 · 9월 8일 (화)')
  expect(dayLabel(tomorrow, now, ko)).toBe('내일 · 9월 9일 (수)')
  expect(dayLabel(nextWeek, now, ko)).toBe('9월 15일 (월)')
})

it('renders exactly the precision the event has, in the device timezone', () => {
  // 12:30Z is 08:30 ET -- when a US CPI print actually lands -- and 21:30 in
  // Seoul. The rail is ALWAYS local time; the wire is always UTC.
  expect(timeLabel({ precision: 'exact', at: '2026-09-08T12:30:00Z' }, ko, 'Asia/Seoul'))
    .toBe('21:30')
  expect(timeLabel({ precision: 'session', session: 'amc' }, ko, 'Asia/Seoul'))
    .toBe('장 마감 후')
  expect(timeLabel({ precision: 'day' }, ko, 'Asia/Seoul')).toBe('종일')
})

it('groups by the local day, not the UTC one', () => {
  // The bug this prevents: an event at 23:00Z is tomorrow in Seoul, and
  // filing it under today puts it above a heading that says 오늘.
  const g = groupByDay([at('2026-09-08T23:00:00Z')], now, 'Asia/Seoul')
  expect(g[0].date).toBe('2026-09-09')
})

it('never invents a time for a day-precision event', () => {
  // The regression this test exists for: a reader who checked the morning
  // and found the thing had happened in the evening.
  expect(timeLabel({ precision: 'day', at: '2026-09-15T00:00:00Z' }, ko))
    .not.toMatch(/\d\d:\d\d/)
})
```

- [ ] **Step 2: `ScheduleRow`** — spec §8's anatomy. Left rail time, title, the affected
  position's `strategyLabel`, `reason_short` at two lines, right rail direction
  (`↑ 유리 / ↓ 불리 / 양방향`) in the up/down pair, and the source badge **only** for a
  researched event. Tapping the row expands `reason`; tapping the badge opens the URL.
- [ ] **Step 3: `schedule.tsx`** — day groups, pull to refresh, the `shortfall` line at the foot
  when the book carries one, and an empty state that reads as a state rather than an error.
- [ ] **Step 4:** Tests: the badge appears for a researched event and not for a computed one;
  the direction colour comes from `theme.ts`; `shortfall` renders when present and nothing
  renders when absent.
- [ ] **Step 5:** Gates and commit — `git commit -m "feat(app): the schedule, and why each date matters"`

---

### Task P13: the two places the book surfaces

**Files:**
- Create: `app/src/components/UpcomingBlock.tsx`
- Modify: `app/src/app/(tabs)/markets.tsx`,
  `app/src/components/detail/CalendarSection.tsx`, `app/src/i18n/{en,ko}.ts`

- [ ] **Step 1:** `UpcomingBlock` — the next three, at the top of Markets, tapping through to
  `/schedule`.
- [ ] **Step 2:** `CalendarSection` shows this symbol's slice of the book **above** the existing
  Yahoo section. Keep the past-earnings beat/miss table exactly as it is — it is good and this
  feature does not replace it. Keep the degraded card and its retry.
- [ ] **Step 3:** When the desk is unreachable or holds no book, the section falls back to what
  it renders today rather than to an error. A phone with no desk token is a normal phone.
- [ ] **Step 4:** Gates and commit — `git commit -m "feat(app): the book, where you already look"`

---

### Task P14: notifications

**Files:**
- Create: `app/src/lib/notify.ts` (+ test)
- Modify: `app/src/app/(tabs)/settings.tsx`, `app/app.json`, `app/package.json`,
  `app/src/i18n/{en,ko}.ts`

**Before this task starts, the APNs push key must exist on EAS** (spec §10, verified absent on
2026-09-08). If it does not, stop and report — a build shipped without it looks correct and
rings for nobody.

- [ ] **Step 1:** `npx expo install expo-notifications`, add the plugin to `app.json`.
- [ ] **Step 2:** `notify.ts` — permission request **at the moment the owner turns an alert on**,
  never at launch. `getExpoPushTokenAsync`, registration through `deskClient`, and the
  preferences document from D4.
- [ ] **Step 3:** A Settings section: a master switch, the four kinds, lead times, quiet hours.
  Follow the existing `NewsUrlEditor` pattern for save/outcome copy.
- [ ] **Step 4:** Tests: permission denied is a state with a sentence, not a crash; the token is
  registered exactly once per change; the token never reaches AsyncStorage or a log; turning the
  master switch off deletes the device from the desk rather than only setting a local flag.
- [ ] **Step 5:** Gates and commit — `git commit -m "feat(app): tell me before it happens"`

---

### Task P15: ship

**Files:** `app/app.json`, `app/src/i18n/{en,ko}.ts`

- [ ] **Step 1:** Walk `en.ts` and `ko.ts` key by key; the catalogues must match exactly.
- [ ] **Step 2:** Bump `expo.version` to **1.7.0**. Confirm against
  `eas build:list --platform ios --limit 1 --non-interactive --json` first — the version trap has
  fired four times.
- [ ] **Step 3:** `npm test && npm run typecheck`.
- [ ] **Step 4:** Commit — `git commit -m "chore(app): 1.7.0 — the schedule and what you hold"`

---

### Task F16: the paper trail

**Files:** `CLAUDE.md`, `docs/desk-server.md`, `docs/app-control.md`

- [ ] **Step 1:** `CLAUDE.md` — a working rule for spec §2 (an event carries its source) in the
  same register as the `lang` rule, and a line in the verification ladder for the new tests.
- [ ] **Step 2:** `docs/desk-server.md` — the seven routes, the four documents, the tick.
- [ ] **Step 3:** `docs/app-control.md` — unchanged if the board's contract is unchanged; confirm
  it is, and say so rather than editing nothing silently.
- [ ] **Step 4:** Commit — `git commit -m "docs: the schedule, the positions, and the source rule"`

---

## Verification before the branch is finished

```bash
sh server/test/run.sh
sh agent/test/run.sh
sh components/provisioning/test/run.sh
(cd app && npm test && npm run typecheck)
python3 tools/mock_news_server.py --check
cmake -S components/news_core/test/host -B /tmp/vt && cmake --build /tmp/vt   # unchanged, must stay green
(cd sim && ./sim.sh)                                                          # unchanged, must stay green
idf.py build                                                                  # unchanged, must stay green
```

The last three are listed **because nothing in this plan should move them.** A diff that changes
a simulator sheet or the firmware size is a diff that touched something it had no business
touching, and that is worth finding out from the gate rather than from the board.

Then: a personal-data scan over the whole branch diff — no real ticker, strike, push token,
hostname or home path — and `superpowers:finishing-a-development-branch`.
