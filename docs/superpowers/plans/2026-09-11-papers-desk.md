# Papers — the desk half — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the desk a **paper** — the newest edition about each company on
the watchlist — with the index that finds one, the commit target that files one
without touching the board, the rotation that orders the stalest one, the
setting that paces it, and the four routes that read and publish one.

**Architecture:** Nothing new is stored that could be derived. An edition
already carries its company inside its own payload (`subject.symbol`), so
`meta.json` gains two recorded fields at commit — `symbol` and `lang` — and the
paper index is one pass over the editions on disk. A **paper commit** is the
existing commit with the schedule gate removed and neither pointer written; its
fingerprint gate compares against that symbol's newest edition rather than
against `current`. The queue gains a `paper` kind and a nullable `symbol`
column by the same `ALTER TABLE` path `reply_to` and `lang` used, and
`Desk.tick()`'s housekeeping pass orders one when — and only when — the queue is
completely empty.

**Tech Stack:** Python 3.11+ standard library only. `sqlite3`, `unittest`,
`http.server`. No dependencies are added.

**Spec:** [`docs/superpowers/specs/2026-09-11-papers-per-ticker-design.md`](../specs/2026-09-11-papers-per-ticker-design.md)
— this plan implements **section 3 (Desk)** and the `Server` row of section 8.
Section 4 (worker) and section 5 (app) are planned separately and are being
written **in parallel with this one**. Every name, JSON shape and status code in
"Global Constraints" below is the wire between the three plans and **must not be
renegotiated here**: the worker and the app are being coded against exactly
these spellings.

## Global Constraints

- **`store.COMMAND_KINDS` becomes** `("file_edition", "research", "custom",
  "calendar", "ask", "paper")`. `paper` is appended; the order of the others
  does not change, because refusal messages quote the tuple.
- **A command's `symbol`** is uppercase and matches `^[A-Z0-9.\-]{1,8}\Z`. It is
  **required** when `kind == "paper"` and **refused with 400** on every other
  kind unless it is `null`. Every command row and every list row carries it,
  `None` when unset.
- **`POST /api/drafts/<d>/commit`** accepts an optional JSON body
  `{"target": "board"|"paper", "symbol": "S"}`. An absent body, an absent
  `target`, or `"board"` is **exactly today's behaviour**. `target` is one of
  those two strings and nothing else.
- **A paper commit** runs draft-exists, validate, render and fingerprint; it
  **skips the schedule gate**, writes **neither pointer**, and its
  `CommitResult.state` is `"paper"` (or `"unchanged"`). `409
  commit_symbol_mismatch` when the draft's `subject.symbol` is not the symbol
  the commit names; `400 commit_needs_symbol` when `target=paper` carries no
  symbol.
- **The commit response JSON is unchanged**: `{ok, edition_id, state, reason}`,
  through `http.py`'s existing `_send_commit`, which is the one shape all four
  doors answer in.
- **`meta.json` gains `symbol` and `lang` at commit.** `symbol` is the payload's
  `subject.symbol` upper-cased and matched against `^[A-Z0-9.\-]{1,8}\Z`, or
  `None`; `lang` is the payload's top-level `lang` matched against
  `^[a-z]{2,3}\Z`, or `"en"`. An edition filed before this change has neither,
  and **both are filled lazily off the stored payload** — by one helper, used by
  both `edition_meta()` and the list of editions, so the two paths cannot
  disagree.
- **`EditionStore.papers(symbols: Sequence[str]) -> dict[str, dict | None]`** —
  the newest edition's meta per requested symbol, `None` where there is none.
- **`EditionStore.prune(keep: int | None = None, symbols: Sequence[str] = ())`**
  — `symbols` is the printable watchlist, and the newest edition of each is
  protected beside `current`, `staged` and the in-flight builds.
- **The setting is `paper_refresh_hours`**: an integer `1..72`, default `12`,
  validated in `settings.py` beside `lang`. `settings.DEFAULT` becomes
  `{"lang": "en", "paper_refresh_hours": 12}`. An unknown key still refuses the
  whole document.
- **`store.LEASE_SECONDS` becomes 5400** (ninety minutes), up from 1800. No
  heartbeat is added and nothing else about the reap changes.
- **Rotation** runs in `Desk.tick()`'s housekeeping pass, after `publish_due`.
  It does nothing when any command is `pending` or `claimed`, of any kind. It
  picks the printable watchlist symbol with the oldest paper (no paper is oldest
  of all; ties by watchlist order), does nothing if that paper is younger than
  the cadence, and otherwise enqueues `kind="paper"`, `symbol=S`, `priority=9`,
  `source="rotation"`, `deadline_at = now + paper_refresh_hours * 3600`, text
  exactly:
  `"Refresh the paper for S. The company is given; research it and write both pages."`
- **The four routes and their scopes:**

  | Method | Path | Scope |
  |---|---|---|
  | GET | `/api/papers` | producer |
  | GET | `/api/editions/<eid>/news.json` | producer |
  | GET | `/api/editions/<eid>/tiles/<id>.bin` | producer |
  | POST | `/api/papers/<SYMBOL>/publish` | operator |

- **A paper row** is exactly `{symbol, name, edition_id, created_at, lang,
  headline, on_board, stale}` — the middle four `null` when the symbol has no
  paper, `on_board` true when `edition_id` is `current`, `stale` true when the
  paper is older than the cadence or does not exist.
- **`GET /api/papers`** answers `{ok, papers: [row…], board: <current eid or
  null>}`, one row per **printable** watchlist item, in watchlist order.
- **`POST /api/papers/<SYMBOL>/publish`** answers `404 no_paper` when the symbol
  has none, and otherwise `promote()`'s own commit shape.
- **Nothing on the wire the board reads moves.** `/news.json`, `/tiles/<id>.bin`
  and the `policy` block are untouched; the firmware and the simulator are not
  in this plan and must stay green.
- **Nothing personal goes in a fixture.** Symbols in tests are the ones the
  repository already invents — `SNDK`, `ACME`, `NVDA` — never the owner's real
  watchlist.
- **The verification for every task** is `sh server/test/run.sh` from the
  repository root. One module: `sh server/test/run.sh -k <word>` — the `-k`
  pattern is matched against the whole test id, so `-k papers` selects
  `test_papers.py` and `-k Rotation` selects that class. **Every commit must
  leave the whole server suite green**, not only the module it touched.
- **Never commit `sdkconfig`.** Nothing in this plan touches the firmware.
- Every commit message ends with these two lines, exactly:

  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01Pxz7nt2DE47CnaMzY4kvNJ
  ```

---

## File Structure

**Modified:**

| file | what changes |
|---|---|
| `server/claudepost/store.py` | `paper` in `COMMAND_KINDS`; `COMMAND_SYMBOL_RE`; the `symbol` column in `_SCHEMA`, `_ADDED_COLUMNS` and `_COMMAND_COLUMNS`; `_checked_symbol`; `add_command`'s new argument; `LEASE_SECONDS` 1800 → 5400 |
| `server/claudepost/settings.py` | `paper_refresh_hours` — `DEFAULT`, `_KEYS`, `PAPER_REFRESH_HOURS_MIN/MAX`, `_hours`, `parse_settings` |
| `server/claudepost/editions.py` | `TARGET_BOARD` / `TARGET_PAPER` / `COMMIT_TARGETS`; `REASON_PAPER`, `REASON_UNCHANGED_PAPER`; the subject cache and `_subject_of`; `_filled`; `edition_meta`; a new `list_editions`; `headline`; `papers`; `_newest_by_symbol`; `prune`'s `symbols`; `commit`/`_commit`'s `target` and `symbol`; `_file_paper`; the module helpers `_payload_doc`, `_subject_symbol`, `_payload_lang`, `_lead_headline` |
| `server/claudepost/app.py` | `PAPER_ORDER`; `Desk.enqueue`'s `symbol`; `Desk.printable_symbols`; `Desk.paper_cadence_seconds`; `Desk.papers`; `Desk._order_stale_paper`; the housekeeping pass in `tick()` and its `prune` call |
| `server/claudepost/http.py` | `h_commit` reads a body; `h_enqueue` passes `symbol`; `h_list_editions` goes through the edition store; new `h_edition_payload`, `h_edition_tile`, `h_papers`, `h_publish_paper`; four `_ROUTES` entries; the settings audit |
| `server/test/test_store.py` | the kind, the column, its validation, the migration, the lease |
| `server/test/test_settings.py` | the cadence's range, default and refusals |
| `server/test/test_editions.py` | the meta fields and their lazy fill; `papers()`; `prune`'s new protection; the paper commit |
| `server/test/test_http.py` | the commit body, the `symbol` on `POST /api/commands`, the two per-edition read routes |
| `docs/desk-server.md` | the `paper` kind and its column, the lease's new length, the commit targets, the paper index, the rotation, the setting, the four routes |
| `docs/app-control.md` | the routes the phone now calls, in "The desk from the phone" |

**Created:**

| file | responsibility |
|---|---|
| `server/test/test_papers.py` | the paper's own behaviours end to end: the rotation's four rules on a real `Desk` (including the lease that keeps a run in flight from reading as an idle worker), and the four routes on a real socket |

---

## Task 1: The queue learns about `paper` and carries a symbol

**Files:**
- Modify: `server/claudepost/store.py`
- Test: `server/test/test_store.py`

**Interfaces:**
- Consumes: nothing from an earlier task.
- Produces:
  - `claudepost.store.COMMAND_KINDS` is now `("file_edition", "research",
    "custom", "calendar", "ask", "paper")`.
  - `claudepost.store.COMMAND_SYMBOL_RE: re.Pattern` — `^[A-Z0-9.\-]{1,8}\Z`.
  - `Store.add_command(kind: str, text: str, priority: int = 5, deadline_at:
    float | None = None, source: str = "", reply_to: str | None = None, lang:
    str | None = None, symbol: str | None = None) -> dict` — the returned row
    carries `symbol`, `None` when unset, upper-cased when set.

- [ ] **Step 1: Write the failing tests**

Add to `server/test/test_store.py`, after the existing `AskTest` class:

```python
class PaperTest(StoreTestCase):
    """The kind the rotation files, and the column that says which company."""

    def paper(self, text="Refresh the paper for SNDK.", **kw):
        kw.setdefault("symbol", "SNDK")
        return self.store.add_command("paper", text, **kw)

    def test_paper_is_a_kind_the_queue_takes(self):
        row = self.paper()
        self.assertEqual(row["kind"], "paper")
        self.assertEqual(row["status"], "pending")
        self.assertEqual(row["symbol"], "SNDK")

    def test_the_symbol_round_trips_through_the_database(self):
        cid = self.paper()["id"]
        self.assertEqual(self.store.get_command(cid)["symbol"], "SNDK")
        [listed] = [r for r in self.store.list_commands() if r["id"] == cid]
        self.assertEqual(listed["symbol"], "SNDK")

    def test_a_claimed_paper_still_knows_its_company(self):
        # The worker reads the symbol off the claim and off nothing else. A
        # column the claim does not return is a run about no company at all.
        self.paper()
        self.assertEqual(self.store.claim_command("w")["symbol"], "SNDK")

    def test_a_paper_without_a_symbol_is_refused(self):
        # The company is the whole instruction. A `paper` with no symbol is a
        # run that would fall back to picking one, which is the board's job.
        with self.assertRaises(BadRequest) as caught:
            self.store.add_command("paper", "Refresh the paper.")
        self.assertIn("symbol", caught.exception.message)

    def test_a_lower_case_ticker_is_stored_upper_case(self):
        self.assertEqual(self.paper(symbol="sndk")["symbol"], "SNDK")

    def test_a_symbol_that_is_not_a_ticker_is_refused(self):
        for bad in ("", "TOOLONGSYM", "../etc", "A B", "A/B", 17, True):
            with self.subTest(symbol=bad):
                with self.assertRaises(BadRequest):
                    self.store.add_command("paper", "Refresh it.", symbol=bad)

    def test_only_a_paper_may_carry_one(self):
        # The index is derived from the edition's own subject, so a symbol on
        # any other kind would be a field nothing reads and a promise nothing
        # keeps.
        with self.assertRaises(BadRequest) as caught:
            self.store.add_command("ask", "왜 그 회사예요?", symbol="SNDK")
        self.assertIn("paper", caught.exception.message)

    def test_the_five_older_kinds_still_work_and_carry_the_column(self):
        for kind in ("file_edition", "research", "custom", "calendar"):
            with self.subTest(kind=kind):
                row = self.store.add_command(kind, "do the thing")
                self.assertIsNone(row["symbol"])
                self.assertIsNone(self.store.get_command(row["id"])["symbol"])
```

In the same file, extend `MigrationTest` — its `OLD` table is the pre-`ask`
shape and stays exactly as it is, because a desk that predates `reply_to` also
predates `symbol`. Add one method to that class:

```python
    def test_the_symbol_column_is_added_to_an_older_database_too(self):
        # A desk that has never restarted since August gets all three columns
        # in one pass, and the rotation's first order is the first write that
        # would have hit `no such column: symbol`.
        old = sqlite3.connect(self.path)
        old.executescript(self.OLD)
        old.commit()
        old.close()

        store = Store(self.path, FixedClock(T0))
        self.addCleanup(store.close)
        row = store.add_command("paper", "Refresh the paper for ACME.",
                                symbol="ACME")
        self.assertEqual(store.get_command(row["id"])["symbol"], "ACME")

    def test_opening_twice_adds_the_symbol_column_once(self):
        first = Store(self.path, FixedClock(T0))
        self.addCleanup(first.close)
        second = Store(self.path, FixedClock(T0))
        self.addCleanup(second.close)
        names = [r["name"] for r
                 in second._db.execute("PRAGMA table_info(commands)")]
        self.assertEqual(names.count("symbol"), 1)
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `sh server/test/run.sh -k PaperTest`
Expected: FAIL — `BadRequest: kind 'paper' is not one of ('file_edition',
'research', 'custom', 'calendar', 'ask')`.

Run: `sh server/test/run.sh -k MigrationTest`
Expected: FAIL — `TypeError: add_command() got an unexpected keyword argument
'symbol'`.

- [ ] **Step 3: Add the kind, the regex, the column and the validation**

In `server/claudepost/store.py`, extend the comment block above
`COMMAND_KINDS` with:

```
#: ``paper`` is the rotation's own kind -- a complete newspaper about a company
#: the desk names, filed for the index rather than for the glass. It is a kind
#: rather than a `file_edition` with a symbol because two things downstream
#: branch on it: the worker's prompt, which must suspend the contract's "which
#: company" rule, and the commit, which writes neither pointer.
```

and change the tuple itself:

```python
COMMAND_KINDS: tuple[str, ...] = ("file_edition", "research", "custom",
                                  "calendar", "ask", "paper")
```

Below `COMMAND_ID_RE` (line 69), add:

```python
#: A ticker as a command may carry one. Eight characters rather than the
#: watchlist's twelve, deliberately: this symbol is compared against an
#: edition's own ``subject.symbol``, which the validator caps at eight (see
#: ``tools/mock_news_server.py``'s length table), so a nine-character symbol
#: here would name a command no draft could ever satisfy and every paper run
#: for it would end in a 409 nobody could fix.
COMMAND_SYMBOL_RE = re.compile(r"^[A-Z0-9.\-]{1,8}\Z")
```

In `_SCHEMA`, the `commands` table's tail becomes:

```sql
    reply_to    TEXT,
    lang        TEXT,
    -- Which company a `paper` is about. NULL on every other kind, which is
    -- what makes it addable by ALTER TABLE below without rewriting a row.
    -- The desk decides the company for a paper and the model does not, so
    -- this is the instruction rather than a hint about it.
    symbol      TEXT
);
```

Extend `_COMMAND_COLUMNS` and `_ADDED_COLUMNS`:

```python
_COMMAND_COLUMNS = ("id", "kind", "text", "priority", "status", "source",
                    "created_at", "deadline_at", "claimed_by", "claimed_at",
                    "finished_at", "attempts", "result", "reply_to", "lang",
                    "symbol")
```

```python
_ADDED_COLUMNS: tuple[tuple[str, str, str], ...] = (
    ("commands", "reply_to", "TEXT"),
    ("commands", "lang", "TEXT"),
    ("commands", "symbol", "TEXT"),
)
```

Beside `_checked_lang` (around line 782), add the module function:

```python
def _checked_symbol(kind: str, symbol: object) -> str | None:
    """The company a command is about, or ``None`` for the kinds that have none.

    Required on a ``paper`` and refused on everything else, which is two rules
    in one function because they are the same rule: the symbol *is* the paper's
    instruction, and on any other kind it is a field nothing reads. A
    ``file_edition`` carrying one would look to an operator like a board
    edition pinned to a company, which is precisely what it would not be.

    Upper-cased before it is matched, the way
    :func:`~claudepost.watchlist._symbol` does it, so this is the one place
    that decides what canonical means for a queue row.
    """
    if symbol is None:
        if kind == "paper":
            raise BadRequest(message="a paper command needs a symbol: "
                                     "the desk names the company, not the model")
        return None
    if kind != "paper":
        raise BadRequest(message=f"only a paper command carries a symbol, "
                                 f"not a {kind!r}")
    if not isinstance(symbol, str) or isinstance(symbol, bool):
        raise BadRequest(message="symbol is a ticker")
    sym = symbol.upper()
    if not COMMAND_SYMBOL_RE.match(sym):
        raise BadRequest(message=f"{symbol!r:.32} is not a symbol "
                                 f"(letters, digits, '.', '-', 1-8 characters)")
    return sym
```

In `add_command`, add the keyword and the call. The signature becomes:

```python
    def add_command(self, kind: str, text: str, priority: int = 5,
                    deadline_at: float | None = None, source: str = "",
                    reply_to: str | None = None,
                    lang: str | None = None,
                    symbol: str | None = None) -> dict:
```

After `lang = _checked_lang(lang)`, add:

```python
        symbol = _checked_symbol(kind, symbol)
```

and add `"symbol": symbol` to the `row` dict, after `"lang": lang`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `sh server/test/run.sh -k PaperTest` — Expected: PASS
Run: `sh server/test/run.sh` — Expected: PASS, the whole suite.

- [ ] **Step 5: Commit**

```bash
git add server/claudepost/store.py server/test/test_store.py
git commit -m "$(cat <<'EOF'
feat(desk): the queue takes a paper, and a paper names its company

A sixth kind and a nullable `symbol` column, added by the same ALTER TABLE
path `reply_to` and `lang` took. The symbol is required on a `paper` and
refused on every other kind, because on any other kind it is a field nothing
reads.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Pxz7nt2DE47CnaMzY4kvNJ
EOF
)"
```

---

## Task 2: The setting that paces the rotation

**Files:**
- Modify: `server/claudepost/settings.py`
- Test: `server/test/test_settings.py`

**Interfaces:**
- Consumes: nothing from an earlier task.
- Produces:
  - `claudepost.settings.DEFAULT == {"lang": "en", "paper_refresh_hours": 12}`.
  - `claudepost.settings.PAPER_REFRESH_HOURS_MIN == 1`,
    `PAPER_REFRESH_HOURS_MAX == 72`.
  - `parse_settings(doc)` returns both keys, always; an absent key takes its
    default, a present `null` is refused, an unknown key refuses the document.

- [ ] **Step 1: Write the failing tests**

Add to `server/test/test_settings.py`, inside the existing `Parse` class (the
first two go beside `test_the_default_is_english`, which must be **replaced**
because `DEFAULT` is no longer a one-key dict):

Replace:

```python
    def test_the_default_is_english(self):
        self.assertEqual(settings.DEFAULT, {"lang": "en"})
```

with:

```python
    def test_the_defaults_are_english_and_twice_a_day(self):
        self.assertEqual(settings.DEFAULT,
                         {"lang": "en", "paper_refresh_hours": 12})

    def test_a_document_that_says_only_the_language_still_gets_a_cadence(self):
        self.assertEqual(settings.parse_settings({"lang": "ko"}),
                         {"lang": "ko", "paper_refresh_hours": 12})

    def test_a_document_that_says_only_the_cadence_still_gets_a_language(self):
        self.assertEqual(settings.parse_settings({"paper_refresh_hours": 6}),
                         {"lang": "en", "paper_refresh_hours": 6})

    def test_the_cadence_is_an_hour_count_in_range(self):
        for good in (1, 6, 12, 72):
            with self.subTest(hours=good):
                self.assertEqual(
                    settings.parse_settings({"paper_refresh_hours": good})
                    ["paper_refresh_hours"], good)

    def test_a_cadence_outside_the_range_is_refused(self):
        # Zero is a worker that never stops writing papers; 73 is more than
        # three days, by which point "the newest edition about S" is not a
        # current newspaper and the pager is showing history.
        for bad in (0, -1, 73, 100000):
            with self.subTest(hours=bad):
                with self.assertRaises(BadRequest):
                    settings.parse_settings({"paper_refresh_hours": bad})

    def test_a_cadence_that_is_not_a_whole_number_of_hours_is_refused(self):
        # `True` is an int to Python and is not an hour count to anybody else.
        for bad in (12.0, "12", None, True, [12]):
            with self.subTest(hours=bad):
                with self.assertRaises(BadRequest):
                    settings.parse_settings({"paper_refresh_hours": bad})

    def test_the_cadence_refusal_names_the_field_and_the_range(self):
        with self.assertRaises(BadRequest) as caught:
            settings.parse_settings({"paper_refresh_hours": 0})
        self.assertEqual(caught.exception.code, "bad_settings")
        self.assertIn("paper_refresh_hours", caught.exception.message)
        self.assertIn("1", caught.exception.message)
        self.assertIn("72", caught.exception.message)
```

Also add, to the `File` class:

```python
    def test_a_file_with_only_a_language_comes_back_with_both(self):
        # A desk configured before this release. Its settings.json holds one
        # key, and the rotation needs a number whatever that file says.
        doc, source = settings.load(self.write('{"lang": "ko"}\n'))
        self.assertEqual(source, "file")
        self.assertEqual(doc, {"lang": "ko", "paper_refresh_hours": 12})
```

`File.write(raw) -> path` is that class's own helper
(`server/test/test_settings.py:106`); it writes `settings.json` into the
temporary root and hands back the path.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `sh server/test/run.sh -k settings`
Expected: FAIL — `AssertionError: {'lang': 'en'} != {'lang': 'en',
'paper_refresh_hours': 12}`, and `KeyError: 'paper_refresh_hours'`.

- [ ] **Step 3: Add the setting**

In `server/claudepost/settings.py`, below `LANGS`, add:

```python
#: HOW OFTEN A PAPER IS REWRITTEN, in hours, at the ends of the range.
#:
#: The floor is one hour rather than zero because zero is not a cadence, it is
#: a worker that never stops: a paper costs thirty to forty minutes of model
#: time, so anything under an hour is a queue that is never empty and an `ask`
#: that never gets claimed. The ceiling is three days because past it "the
#: newest edition about S" stops being a current newspaper -- the pager would
#: be showing history with no badge to say so, which is the one failure on this
#: document that produces no error anywhere.
PAPER_REFRESH_HOURS_MIN = 1
PAPER_REFRESH_HOURS_MAX = 72
```

Change `DEFAULT` and its comment tail:

```python
#: What a desk nobody has told prints in, and how often it rewrites a paper. A
#: complete setting rather than a placeholder, the same way
#: :data:`~claudepost.schedule.DEFAULT_SCHEDULE` is a complete schedule --
#: there is no state in which the paper has no language and no state in which
#: the rotation has no cadence. Twelve hours rather than the six first asked
#: for: a paper costs the worker thirty to forty minutes, and six hours across
#: five companies does not fit in a day beside the board's own runs. Handed out
#: by copy (see :func:`load`), never by reference.
DEFAULT = {"lang": "en", "paper_refresh_hours": 12}

#: Every key the document may carry. Two, now.
_KEYS = frozenset({"lang", "paper_refresh_hours"})
```

Change `parse_settings`'s return:

```python
    return {
        "lang": _lang(doc["lang"]) if "lang" in doc else DEFAULT["lang"],
        "paper_refresh_hours": (
            _hours(doc["paper_refresh_hours"]) if "paper_refresh_hours" in doc
            else DEFAULT["paper_refresh_hours"]),
    }
```

And add the validator beside `_lang`:

```python
def _hours(value: object) -> int:
    """A whole number of hours inside the range, or a refusal naming both ends.

    ``bool`` is excluded explicitly because Python says ``True`` is an ``int``
    and nobody else does: ``{"paper_refresh_hours": true}`` would otherwise be
    accepted as a one-hour cadence, which is a worker that never stops, filed
    by a client that meant to send a flag.

    A float is refused rather than rounded, including ``12.0``. JSON has one
    number type, so a client that sent ``12.0`` meant hours and would be
    served by rounding -- but the same leniency takes ``12.5``, and this
    number is multiplied by 3600 and compared against a deadline. An integer
    in, an integer out, and the refusal says which.
    """
    if isinstance(value, bool) or not isinstance(value, int):
        raise BadRequest("bad_settings",
                         f"paper_refresh_hours: a whole number of hours, "
                         f"{PAPER_REFRESH_HOURS_MIN}..{PAPER_REFRESH_HOURS_MAX}"
                         f" -- got {value!r}")
    if not PAPER_REFRESH_HOURS_MIN <= value <= PAPER_REFRESH_HOURS_MAX:
        raise BadRequest("bad_settings",
                         f"paper_refresh_hours: must be "
                         f"{PAPER_REFRESH_HOURS_MIN}..{PAPER_REFRESH_HOURS_MAX}"
                         f" -- got {value!r}")
    return value
```

Finally, update the module docstring's opening line — it says "what the paper
is written in, and nothing else yet", which is now false:

```
"""The desk's settings as a file under the data root: what the paper is
written in, and how often each company's paper is rewritten.
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `sh server/test/run.sh -k settings` — Expected: PASS
Run: `sh server/test/run.sh` — Expected: PASS. If `test_http.py` fails on the
settings round-trip, it is asserting the one-key document; update that
assertion to the two-key one rather than weakening it.

- [ ] **Step 5: Commit**

```bash
git add server/claudepost/settings.py server/test/test_settings.py server/test/test_http.py
git commit -m "$(cat <<'EOF'
feat(desk): a settings document that also says how often a paper is rewritten

`paper_refresh_hours`, 1..72, default 12. Twelve rather than the six first
asked for: a paper costs the worker thirty to forty minutes, and six hours
across five companies does not fit in a day beside the board's own runs.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Pxz7nt2DE47CnaMzY4kvNJ
EOF
)"
```

---

## Task 3: An edition records its company and its language

**Files:**
- Modify: `server/claudepost/editions.py`
- Test: `server/test/test_editions.py`

**Interfaces:**
- Consumes: nothing from an earlier task.
- Produces:
  - `meta.json` written by `_commit` carries `symbol: str | None` and
    `lang: str`.
  - `EditionStore.edition_meta(edition_id) -> dict` — always carries both keys,
    filled off the payload for an edition that predates them.
  - `EditionStore.list_editions(limit: int = 50) -> list[dict]` — the store's
    own history, each row through the same fill.
  - `EditionStore.headline(edition_id: str) -> str | None` — the lead story's
    headline, off the stored payload.
  - Module functions `_payload_doc`, `_subject_symbol`, `_payload_lang`,
    `_lead_headline`, and the constants `DEFAULT_LANG`, `SUBJECT_SYMBOL_RE`,
    `LANG_RE`.

- [ ] **Step 1: Write the failing tests**

Add to `server/test/test_editions.py`, after `FingerprintTest`:

```python
class SubjectMetaTest(EditionTestCase):
    """What an edition records about the company it is about.

    The paper index is derived from this and from nothing else, so the two
    things it has to survive are a producer that filed a payload before this
    field existed, and a payload whose subject is not usable as an index key.
    """

    def a_company(self, symbol="SNDK", n=1, **top):
        """A draft whose payload names a company, committed."""
        d = self.es.open_draft()
        doc = {"edition": "2026-08-19", "serial": n,
               "subject": {"symbol": symbol, "name": "Sandisk Corp."},
               "stories": [{"rank": 0, "headline": f"Story {n}"}]}
        doc.update(top)
        self.es.put_payload(d, json.dumps(doc).encode())
        return self.es.commit(d, IMMEDIATE, self.clock.now())

    def test_a_commit_records_the_symbol_and_the_language(self):
        eid = self.a_company("SNDK", lang="ko").edition_id
        meta = self.es.edition_meta(eid)
        self.assertEqual(meta["symbol"], "SNDK")
        self.assertEqual(meta["lang"], "ko")

    def test_a_payload_with_no_language_is_recorded_as_english(self):
        # `docs/news-contract.md`: absent or malformed means `en`, and the
        # device applies the same rule -- so the meta must agree with what is
        # actually printed rather than saying "unknown".
        meta = self.es.edition_meta(self.a_company("ACME").edition_id)
        self.assertEqual(meta["lang"], "en")

    def test_a_lower_case_ticker_is_recorded_upper_case(self):
        meta = self.es.edition_meta(self.a_company("sndk").edition_id)
        self.assertEqual(meta["symbol"], "SNDK")

    def test_a_payload_with_no_usable_symbol_records_none(self):
        # Not an error and not a refusal: gate 1 is what decides whether a
        # payload is an edition, and an edition the index cannot key is simply
        # not a paper for anybody.
        for bad in (None, "", "WAY-TOO-LONG-SYMBOL", "A B", 17):
            with self.subTest(symbol=bad):
                d = self.es.open_draft()
                self.es.put_payload(d, json.dumps(
                    {"serial": repr(bad), "subject": {"symbol": bad}}).encode())
                r = self.es.commit(d, IMMEDIATE, self.clock.now())
                self.assertIsNone(self.es.edition_meta(r.edition_id)["symbol"])

    def test_an_edition_filed_before_these_fields_is_filled_from_its_payload(self):
        # The migration that does not run. An edition's meta.json is its birth
        # certificate and is never rewritten, so the two fields are derived on
        # the way out instead -- which is also why a pre-change edition is
        # still a paper for its company.
        eid = self.a_company("NVDA", lang="ko").edition_id
        path = os.path.join(self.root, "editions", eid, "meta.json")
        with open(path, "r+", encoding="utf-8") as f:
            doc = json.load(f)
            doc.pop("symbol")
            doc.pop("lang")
            f.seek(0)
            json.dump(doc, f)
            f.truncate()

        meta = self.es.edition_meta(eid)
        self.assertEqual(meta["symbol"], "NVDA")
        self.assertEqual(meta["lang"], "ko")

    def test_the_history_carries_the_two_fields_on_both_paths(self):
        # `edition_meta` reads a file and `list_editions` reads a database.
        # Two readers answering "which company is this" differently is the
        # bug this test exists to prevent.
        eid = self.a_company("SNDK", lang="ko").edition_id
        [row] = [r for r in self.es.list_editions() if r["id"] == eid]
        self.assertEqual((row["symbol"], row["lang"]),
                         (self.es.edition_meta(eid)["symbol"],
                          self.es.edition_meta(eid)["lang"]))

    def test_the_lead_headline_is_the_lowest_ranked_story(self):
        d = self.es.open_draft()
        self.es.put_payload(d, json.dumps({
            "subject": {"symbol": "SNDK"},
            "stories": [{"rank": 30, "headline": "A brief"},
                        {"rank": 10, "headline": "The lead"},
                        {"rank": 20, "headline": "A second"}]}).encode())
        r = self.es.commit(d, IMMEDIATE, self.clock.now())
        self.assertEqual(self.es.headline(r.edition_id), "The lead")

    def test_an_edition_with_no_stories_has_no_headline(self):
        d = self.es.open_draft()
        self.es.put_payload(d, json.dumps({"subject": {"symbol": "SNDK"}}).encode())
        r = self.es.commit(d, IMMEDIATE, self.clock.now())
        self.assertIsNone(self.es.headline(r.edition_id))

    def test_an_edition_that_is_not_there_has_no_headline(self):
        self.assertIsNone(self.es.headline("0" * 16))
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `sh server/test/run.sh -k SubjectMeta`
Expected: FAIL — `KeyError: 'symbol'`, and `AttributeError: 'EditionStore'
object has no attribute 'headline'`.

- [ ] **Step 3: Write the payload readers and record the two fields**

In `server/claudepost/editions.py`, below `SHEET_RE` (around line 148), add:

```python
#: What an edition's ``lang`` is when the payload does not say, or says
#: something that is not a language tag. The device's own rule, from
#: ``docs/news-contract.md``: "absent or malformed means ``en``". The meta has
#: to agree with what is actually printed rather than recording "unknown",
#: because the phone draws this field as the paper's language.
DEFAULT_LANG = "en"

#: A ``subject.symbol`` as the index will key on it. Eight characters because
#: that is the device's buffer and the validator's cap; anything else is an
#: edition the index simply cannot key, which is not an error -- gate 1 decides
#: what an edition is, and this decides what a *paper* is.
SUBJECT_SYMBOL_RE = re.compile(r"^[A-Z0-9.\-]{1,8}\Z")

#: A BCP-47 primary subtag, the wire's own shape from ``docs/news-contract.md``.
#: Not :data:`~claudepost.settings.LANGS`: this field describes the text that
#: is actually in the payload, and the desk deliberately does not cross-check
#: an edition's language against the setting.
LANG_RE = re.compile(r"^[a-z]{2,3}\Z")
```

Add the four module functions beside `_stored_payload` (around line 1206):

```python
def _payload_doc(payload: bytes | None) -> dict:
    """A stored payload as a dict, or an empty one however it failed.

    Every way of failing is the same answer here -- no payload, a payload that
    is not JSON, a payload that is JSON but not an object -- because every one
    of them means the same thing to the index: there is nothing to key on.
    ``read_payload``'s rule, one level up.
    """
    if not payload:
        return {}
    try:
        doc = json.loads(payload)
    except ValueError:
        return {}
    return doc if isinstance(doc, dict) else {}


def _subject_symbol(payload: bytes | None) -> str | None:
    """The company an edition is about, as the index keys on it, or ``None``.

    Upper-cased before it is matched, so ``"sndk"`` and ``"SNDK"`` are one
    paper -- the same rule :func:`~claudepost.watchlist._symbol` and
    :func:`~claudepost.store._checked_symbol` follow, and the reason a commit
    can compare the two directly.
    """
    subject = _payload_doc(payload).get("subject")
    symbol = subject.get("symbol") if isinstance(subject, dict) else None
    if not isinstance(symbol, str):
        return None
    symbol = symbol.strip().upper()
    return symbol if SUBJECT_SYMBOL_RE.match(symbol) else None


def _payload_lang(payload: bytes | None) -> str:
    """The language an edition is written in. Never ``None``; see :data:`DEFAULT_LANG`."""
    lang = _payload_doc(payload).get("lang")
    if isinstance(lang, str) and LANG_RE.match(lang):
        return lang
    return DEFAULT_LANG


def _lead_headline(payload: bytes | None) -> str | None:
    """The lead story's headline, for a reader choosing between papers.

    The lead is the LOWEST-ranked story and not ``stories[0]``, because the
    wire carries a rank and nothing about order -- ``docs/news-contract.md``'s
    "``stories[]`` keeps the N lowest ranks" is the device's own rule and this
    is the same one. A story with no usable rank sorts last rather than first,
    so a producer that omitted the field cannot displace one that filed it.
    Ties go to the earlier entry, which is the only tiebreak the payload
    offers.
    """
    stories = _payload_doc(payload).get("stories")
    if not isinstance(stories, list):
        return None
    best: tuple[tuple[float, int], str] | None = None
    for i, story in enumerate(stories):
        if not isinstance(story, dict):
            continue
        headline = story.get("headline")
        if not isinstance(headline, str) or not headline.strip():
            continue
        rank = story.get("rank")
        if isinstance(rank, bool) or not isinstance(rank, (int, float)):
            rank = float("inf")
        key = (float(rank), i)
        if best is None or key < best[0]:
            best = (key, headline)
    return best[1] if best else None
```

In `EditionStore.__init__`, after `self._building` is set up (find it beside
`self._busy` around line 200), add:

```python
        #: ``{edition_id: (symbol, lang, headline)}`` read off a payload once.
        #:
        #: An edition directory is immutable, so this can never be stale -- and
        #: it is what keeps the lazy fill from costing a 300 KB read per row
        #: per request. Only editions that *need* filling land here: one filed
        #: after this change carries both fields in its own meta.json and is
        #: read for its headline alone.
        self._subject: dict[str, tuple[str | None, str, str | None]] = {}
```

Add the three methods beside `edition_meta` (around line 619):

```python
    def _subject_of(self, edition_id: str) -> tuple[str | None, str, str | None]:
        """An edition's company, language and lead headline, read once."""
        hit = self._subject.get(edition_id)
        if hit is None:
            payload = self.read_payload(edition_id)
            hit = (_subject_symbol(payload), _payload_lang(payload),
                   _lead_headline(payload))
            self._subject[edition_id] = hit
        return hit

    def _filled(self, edition_id: str, doc: dict) -> dict:
        """``doc`` with ``symbol`` and ``lang`` on it however old the edition is.

        The migration that does not run. ``meta.json`` is an edition's birth
        certificate and is never rewritten, so an edition filed before those
        two fields existed gets them derived from its own stored payload on the
        way out -- which is also what makes a pre-change edition a paper for
        its company rather than an edition about nobody.

        Membership and not truthiness: an edition filed *after* this change
        about a payload with no usable subject records ``"symbol": null``, and
        that is an answer rather than an omission. Re-deriving it every time
        would read the payload to learn what the meta already says.
        """
        if "symbol" in doc and "lang" in doc:
            return doc
        symbol, lang, _headline = self._subject_of(edition_id)
        doc.setdefault("symbol", symbol)
        doc.setdefault("lang", lang)
        return doc

    def headline(self, edition_id: str) -> str | None:
        """The lead story's headline, for a reader choosing between papers.

        ``None`` for an edition with no stories, and for one that is not there
        at all -- the serving path's rule, because both mean the same thing to
        a pager drawing a row.
        """
        return self._subject_of(edition_id)[2]

    def list_editions(self, limit: int = 50) -> list[dict]:
        """The history, each row carrying its company and its language.

        Here rather than in :meth:`~claudepost.store.Store.list_editions`
        because the fill reads a payload off the disk, which is this module's
        territory and not the database's -- and because a row from the store
        and a row from :meth:`edition_meta` answering "which company is this"
        differently is exactly the bug the shared :meth:`_filled` prevents.
        """
        return [self._filled(row["id"], row)
                for row in self._store.list_editions(limit)]
```

Then, in `edition_meta`, change the final line from `return doc` to:

```python
        return self._filled(edition_id, doc)
```

In `_commit`, the `meta` dict gains two keys. Replace the assignment with:

```python
        # The gate runs before the build so that meta.json is born with the
        # right published_at. It is written once and never rewritten.
        #
        # `symbol` and `lang` are the payload's own, copied here rather than
        # left to be re-derived: they are what the paper index keys on, and an
        # index that re-parsed 300 KB of JSON per row per request would be a
        # phone refresh costing more than the edition it draws. Both are
        # nullable-by-shape rather than by absence -- see `_filled`, which is
        # the reader for every edition filed before they existed.
        meta = {"id": eid,
                "created_at": now,
                "published_at": now if ok else None,
                "source": draft_id,
                "symbol": _subject_symbol(stored),
                "lang": _payload_lang(stored),
                "validate": _clip(verdict.output),
                "render": _clip(render.output),
                "dropped_producer_policy": dropped,
                "tile_count": len(tile_ids),
                "bytes": len(stored)}
```

Finally, in `prune`, drop the cache entry beside the directory. In the
deletion loop, after `shutil.rmtree(...)`, add:

```python
                self._subject.pop(eid, None)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `sh server/test/run.sh -k SubjectMeta` — Expected: PASS
Run: `sh server/test/run.sh` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/claudepost/editions.py server/test/test_editions.py
git commit -m "$(cat <<'EOF'
feat(desk): an edition records the company it is about, and its language

meta.json gains `symbol` and `lang` at commit. An edition filed before them
has both derived from its own stored payload on the way out, by one helper
that both the file reader and the database reader go through -- so no
migration runs and a pre-change edition is still a paper for its company.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Pxz7nt2DE47CnaMzY4kvNJ
EOF
)"
```

---

## Task 4: The paper index, and the retention that protects it

**Files:**
- Modify: `server/claudepost/editions.py`
- Test: `server/test/test_editions.py`

**Interfaces:**
- Consumes: `EditionStore.edition_meta` carrying `symbol` (Task 3).
- Produces:
  - `EditionStore.papers(symbols: Sequence[str]) -> dict[str, dict | None]` —
    the newest edition's meta per requested symbol, in no particular order (the
    caller holds the order); `None` for a symbol with no edition.
  - `EditionStore.prune(keep: int | None = None, symbols: Sequence[str] = ())
    -> int` — `symbols` protects the newest edition of each from retention.
  - `EditionStore._newest_by_symbol() -> dict[str, dict]` — private, shared by
    both of the above and by the paper commit in Task 5.

- [ ] **Step 1: Write the failing tests**

Add to `server/test/test_editions.py`, after `SubjectMetaTest`:

```python
class PapersTest(SubjectMetaTest):
    """Which edition is the paper for a company, and what retention may not take.

    Inherits `SubjectMetaTest`'s `a_company` helper rather than repeating it --
    a second spelling of "a draft that names a company" would be a second thing
    to keep in step with the payload shape.
    """

    def test_the_newest_edition_for_a_symbol_is_its_paper(self):
        old = self.a_company("SNDK", n=1).edition_id
        self.clock.set(T0 + 3600)
        new = self.a_company("SNDK", n=2).edition_id

        self.assertEqual(self.es.papers(["SNDK"])["SNDK"]["id"], new)
        self.assertNotEqual(old, new)

    def test_each_symbol_gets_its_own_newest(self):
        sndk = self.a_company("SNDK", n=1).edition_id
        self.clock.set(T0 + 60)
        acme = self.a_company("ACME", n=2).edition_id
        self.clock.set(T0 + 120)
        sndk2 = self.a_company("SNDK", n=3).edition_id

        found = self.es.papers(["SNDK", "ACME"])
        self.assertEqual(found["SNDK"]["id"], sndk2)
        self.assertEqual(found["ACME"]["id"], acme)
        self.assertNotEqual(sndk, sndk2)

    def test_a_symbol_with_no_edition_answers_none_rather_than_being_dropped(self):
        # The pager draws a "not written yet" row from this, so a key that is
        # missing and a key that is None are different answers to it.
        self.a_company("SNDK")
        found = self.es.papers(["SNDK", "NVDA"])
        self.assertIn("NVDA", found)
        self.assertIsNone(found["NVDA"])

    def test_asking_for_nothing_answers_nothing(self):
        self.a_company("SNDK")
        self.assertEqual(self.es.papers([]), {})

    def test_an_edition_the_index_cannot_key_belongs_to_no_symbol(self):
        d = self.es.open_draft()
        self.es.put_payload(d, json.dumps({"serial": 9, "subject": {}}).encode())
        self.es.commit(d, IMMEDIATE, self.clock.now())
        self.assertIsNone(self.es.papers([""])[""])

    def test_retention_never_takes_a_watched_company_s_paper(self):
        # The pager's whole promise. Without this the newest edition about a
        # company on the watchlist ages out behind the board's own run of
        # editions, and the row goes blank with nothing to explain it.
        sndk = self.a_company("SNDK", n=0).edition_id
        for n in range(1, 6):
            self.clock.set(T0 + n * 60)
            self.a_company("ACME", n=n)

        self.assertEqual(self.es.prune(keep=1, symbols=["SNDK", "ACME"]), 4)
        self.assertIsNotNone(self.es.read_payload(sndk))
        self.assertEqual(self.es.papers(["SNDK"])["SNDK"]["id"], sndk)

    def test_a_company_that_left_the_watchlist_ages_out_normally(self):
        sndk = self.a_company("SNDK", n=0).edition_id
        for n in range(1, 6):
            self.clock.set(T0 + n * 60)
            self.a_company("ACME", n=n)

        # ACME only. SNDK's paper has lost its protection and is old history.
        self.assertEqual(self.es.prune(keep=1, symbols=["ACME"]), 5)
        self.assertIsNone(self.es.read_payload(sndk))

    def test_protecting_nothing_is_what_prune_did_before(self):
        for n in range(5):
            self.clock.set(T0 + n * 60)
            self.a_company("ACME", n=n)
        self.assertEqual(self.es.prune(keep=2), 2)

    def test_a_pruned_edition_leaves_no_answer_behind_it(self):
        # The subject cache is keyed by edition id and an id is a content
        # fingerprint, so a stale entry could only ever be a leak. It is
        # dropped anyway, because "the cache is bounded" is easier to hold
        # than "the cache is bounded in practice".
        gone = self.a_company("SNDK", n=0).edition_id
        self.assertIsNotNone(self.es.headline(gone))
        for n in range(1, 4):
            self.clock.set(T0 + n * 60)
            self.a_company("ACME", n=n)
        self.es.prune(keep=1)
        self.assertNotIn(gone, self.es._subject)
```

`SubjectMetaTest.a_company` commits at `self.clock.now()`, so a test that wants
two editions a symbol apart in time moves the clock between them — the same way
`PruneTest` does with `self.jump`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `sh server/test/run.sh -k PapersTest`
Expected: FAIL — `AttributeError: 'EditionStore' object has no attribute
'papers'`, and `TypeError: prune() got an unexpected keyword argument
'symbols'`.

- [ ] **Step 3: Write the index and the protection**

In `server/claudepost/editions.py`, add `Sequence` to the typing import at the
top of the file (it imports `from __future__ import annotations` already; add
`from typing import Sequence` beside the other imports if there is no typing
import yet).

Add beside `edition_meta` (after `headline` from Task 3):

```python
    def papers(self, symbols: Sequence[str]) -> dict[str, dict | None]:
        """The newest edition about each requested company, or ``None``.

        A **read, not a cache**: the editions on disk are the truth, and a
        second record of "which is the newest paper for S" would be a thing to
        keep in step with retention, with a promotion, and with a commit that
        crashed between the build and the record.

        Every requested symbol gets a key, ``None`` and all. A key that was
        simply missing would make "this company has no paper yet" and "you
        misspelled the symbol" the same answer to a pager, and the first of
        those is a row it has to draw.
        """
        newest = self._newest_by_symbol()
        return {symbol: newest.get(symbol) for symbol in symbols}

    def _newest_by_symbol(self) -> dict[str, dict]:
        """``{symbol: meta}`` for every company with an edition on disk.

        Off the DISK rather than off the editions table, and that is the
        safety argument rather than a preference: a store row outlives the
        directory ``prune`` deleted, so an index built from the table would
        hand a reader an edition id whose payload 404s. Walking the disk also
        bounds the cost at retention depth -- a few dozen small ``meta.json``
        reads -- where the table grows forever.

        Ties on ``created_at`` are broken by the id, so two editions filed in
        the same second resolve the same way on every call. Without it the
        answer would depend on ``os.listdir`` order, and a pager would appear
        to flip between two papers at random.
        """
        newest: dict[str, tuple[float, str, dict]] = {}
        for eid in self._edition_ids():
            try:
                meta = self.edition_meta(eid)
            except NotFound:
                # A directory that lost its meta.json, or one deleted between
                # the listing and the read. Not an edition anybody can serve.
                continue
            symbol = meta.get("symbol")
            if not symbol:
                continue
            try:
                at = float(meta.get("created_at") or 0.0)
            except (TypeError, ValueError):
                at = 0.0
            key = (at, eid)
            if symbol not in newest or key > newest[symbol][:2]:
                newest[symbol] = (at, eid, meta)
        return {symbol: meta for symbol, (_at, _eid, meta) in newest.items()}
```

Change `prune`'s signature and body. The signature becomes:

```python
    def prune(self, keep: int | None = None,
              symbols: Sequence[str] = ()) -> int:
```

Extend its docstring with:

```
        ``symbols`` is the companies whose papers must survive -- the desk's
        printable watchlist. The newest edition of each is protected however
        old it is, for the same reason ``current`` is: a paper pruned out from
        under the pager is a row that goes blank with nothing on the desk to
        explain it. An edition for a company no longer on that list loses the
        protection and ages out normally, which is what makes removing a
        symbol from the watchlist the way to stop keeping its paper.
```

and, immediately after `protected.update(known[:depth])`, add:

```python
            # After the depth, not before: a paper inside the newest `depth`
            # is already protected and this adds nothing, and a paper outside
            # it is exactly the case this exists for.
            if symbols:
                newest = self._newest_by_symbol()
                protected.update(meta["id"] for meta in
                                 (newest.get(s) for s in symbols)
                                 if meta is not None)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `sh server/test/run.sh -k PapersTest` — Expected: PASS
Run: `sh server/test/run.sh` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/claudepost/editions.py server/test/test_editions.py
git commit -m "$(cat <<'EOF'
feat(desk): the paper index, and the retention that will not take one

`papers(symbols)` is the newest edition about each company, read off the disk
rather than the table -- a store row outlives the directory prune deleted, and
an index built from it would hand a reader an id whose payload 404s. prune()
now protects the newest edition of every watched company however old it is.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Pxz7nt2DE47CnaMzY4kvNJ
EOF
)"
```

---

## Task 5: A commit that files a paper and touches no pointer

**Files:**
- Modify: `server/claudepost/editions.py`
- Test: `server/test/test_editions.py`

**Interfaces:**
- Consumes: `_newest_by_symbol` (Task 4), `_subject_symbol` (Task 3).
- Produces:
  - `claudepost.editions.TARGET_BOARD == "board"`,
    `TARGET_PAPER == "paper"`,
    `COMMIT_TARGETS == ("board", "paper")`.
  - `EditionStore.commit(draft_id: str, schedule: Schedule, now: float, target:
    str = TARGET_BOARD, symbol: str | None = None) -> CommitResult` —
    `CommitResult.state` is now one of `"published"`, `"staged"`,
    `"unchanged"`, `"paper"`.
  - `BadRequest("commit_needs_symbol")` and
    `Conflict("commit_symbol_mismatch")` from a paper commit.

- [ ] **Step 1: Write the failing tests**

Add to `server/test/test_editions.py`, after `PapersTest`:

```python
class PaperCommitTest(SubjectMetaTest):
    """Filing a newspaper that is not for the glass.

    Everything the board's own commit does, minus the schedule gate and both
    pointer writes. The one new refusal is the wall: the index is keyed by the
    payload's own subject, so a model that drifted to another company would
    file its paper under the name the desk asked for and nobody would ever see
    the two disagree.
    """

    def paper(self, symbol="SNDK", n=1, commit_as=None, **top):
        """A draft naming ``symbol``, committed as a paper for ``commit_as``."""
        d = self.es.open_draft()
        doc = {"edition": "2026-08-19", "serial": n,
               "subject": {"symbol": symbol, "name": "Sandisk Corp."},
               "stories": [{"rank": 0, "headline": f"Story {n}"}]}
        doc.update(top)
        self.es.put_payload(d, json.dumps(doc).encode())
        return self.es.commit(d, IMMEDIATE, self.clock.now(),
                              target="paper",
                              symbol=commit_as or symbol)

    def test_a_paper_commit_files_an_edition_and_says_so(self):
        r = self.paper()
        self.assertEqual(r.state, "paper")
        self.assertEqual(self.es.papers(["SNDK"])["SNDK"]["id"], r.edition_id)
        self.assertIsNotNone(self.es.read_payload(r.edition_id))

    def test_it_writes_neither_pointer(self):
        board = self.a_company("ACME", n=0).edition_id
        r = self.paper("SNDK", n=1)
        self.assertEqual(self.es.current_id(), board)
        self.assertIsNone(self.es.staged_id())
        self.assertNotEqual(r.edition_id, board)

    def test_it_is_not_a_publish_and_does_not_restart_the_minimum_gap(self):
        # A paper never reaches the glass, so counting it as a publish would
        # make the board's own next edition wait behind a page nobody saw.
        self.paper()
        self.assertIsNone(self.es._store.last_publish_at())

    def test_it_records_no_published_at(self):
        r = self.paper()
        self.assertIsNone(self.es.edition_meta(r.edition_id)["published_at"])

    def test_the_schedule_gate_does_not_apply(self):
        # The one gate a paper skips. A quiet window is about what may appear
        # on the wall, and a paper appears on nobody's wall.
        quiet = sched(quiet=[{"from": "00:00", "to": "23:59"}], wake=[],
                      publish={"policy": "manual", "min_gap_minutes": 600})
        d = self.es.open_draft()
        self.es.put_payload(d, json.dumps(
            {"serial": 7, "subject": {"symbol": "SNDK"}}).encode())
        r = self.es.commit(d, quiet, self.clock.now(),
                           target="paper", symbol="SNDK")
        self.assertEqual(r.state, "paper")

    def test_a_failing_gate_still_refuses_a_paper(self):
        self.gates.validate_ok = False
        d = self.es.open_draft()
        self.es.put_payload(d, json.dumps(
            {"subject": {"symbol": "SNDK"}}).encode())
        with self.assertRaises(BadRequest) as caught:
            self.es.commit(d, IMMEDIATE, self.clock.now(),
                           target="paper", symbol="SNDK")
        self.assertEqual(caught.exception.code, "gate_failed")

    def test_an_unchanged_paper_is_unchanged(self):
        first = self.paper("SNDK", n=1)
        again = self.paper("SNDK", n=1)
        self.assertEqual(again.state, "unchanged")
        self.assertEqual(again.edition_id, first.edition_id)

    def test_the_fingerprint_gate_looks_at_the_symbol_and_not_at_the_board(self):
        # The board is showing SNDK. A paper about SNDK with different copy is
        # a change; the comparison that matters is against SNDK's own newest
        # paper, not against whatever happens to be on the glass.
        board = self.a_company("ACME", n=0).edition_id
        first = self.paper("SNDK", n=1)
        second = self.paper("SNDK", n=2)
        self.assertEqual(second.state, "paper")
        self.assertNotEqual(second.edition_id, first.edition_id)
        self.assertEqual(self.es.current_id(), board)

    def test_a_paper_identical_to_what_is_on_the_board_is_unchanged(self):
        # Same bytes, same id, already on disk: there is nowhere for the draft
        # to go, whichever pointer happens to name it.
        d = self.es.open_draft()
        raw = json.dumps({"serial": 4, "subject": {"symbol": "SNDK"}}).encode()
        self.es.put_payload(d, raw)
        board = self.es.commit(d, IMMEDIATE, self.clock.now())
        self.assertEqual(board.state, "published")

        d2 = self.es.open_draft()
        self.es.put_payload(d2, raw)
        again = self.es.commit(d2, IMMEDIATE, self.clock.now(),
                               target="paper", symbol="SNDK")
        self.assertEqual(again.state, "unchanged")
        self.assertEqual(again.edition_id, board.edition_id)

    def test_a_draft_about_another_company_is_refused(self):
        with self.assertRaises(Conflict) as caught:
            self.paper(symbol="ACME", commit_as="SNDK")
        self.assertEqual(caught.exception.code, "commit_symbol_mismatch")
        self.assertIn("ACME", caught.exception.message)
        self.assertIn("SNDK", caught.exception.message)

    def test_a_refused_paper_files_nothing(self):
        board = self.a_company("SNDK", n=0).edition_id
        with self.assertRaises(Conflict):
            self.paper(symbol="ACME", commit_as="SNDK")
        self.assertIsNone(self.es.papers(["ACME"])["ACME"])
        self.assertEqual(self.es.current_id(), board)

    def test_a_draft_with_no_usable_subject_is_refused_as_a_mismatch(self):
        d = self.es.open_draft()
        self.es.put_payload(d, json.dumps({"serial": 3}).encode())
        with self.assertRaises(Conflict) as caught:
            self.es.commit(d, IMMEDIATE, self.clock.now(),
                           target="paper", symbol="SNDK")
        self.assertEqual(caught.exception.code, "commit_symbol_mismatch")

    def test_a_paper_commit_with_no_symbol_is_refused(self):
        d = self.es.open_draft()
        self.es.put_payload(d, json.dumps(
            {"subject": {"symbol": "SNDK"}}).encode())
        with self.assertRaises(BadRequest) as caught:
            self.es.commit(d, IMMEDIATE, self.clock.now(), target="paper")
        self.assertEqual(caught.exception.code, "commit_needs_symbol")

    def test_an_unknown_target_is_refused(self):
        d = self.es.open_draft()
        self.es.put_payload(d, payload(1))
        with self.assertRaises(BadRequest):
            self.es.commit(d, IMMEDIATE, self.clock.now(), target="glass")

    def test_the_board_target_is_exactly_what_a_commit_did_before(self):
        by_default = self.file(1)
        self.assertEqual(by_default.state, "published")
        d = self.es.open_draft()
        self.es.put_payload(d, payload(2))
        self.es.put_tile(d, "pic", b"\x01\x02\x03\x04")
        named = self.es.commit(d, IMMEDIATE, self.clock.now(), target="board")
        self.assertEqual(named.state, "published")
        self.assertEqual(self.es.current_id(), named.edition_id)

    def test_a_successful_paper_consumes_its_draft(self):
        d = self.es.open_draft()
        self.es.put_payload(d, json.dumps(
            {"serial": 5, "subject": {"symbol": "SNDK"}}).encode())
        self.es.commit(d, IMMEDIATE, self.clock.now(),
                       target="paper", symbol="SNDK")
        with self.assertRaises(NotFound):
            self.es.draft_info(d)
```

`StubGates.validate_ok` and `EditionStore.draft_info` are both existing names
(`server/claudepost/gates.py:198` and `server/claudepost/editions.py:319`);
`test_editions.py`'s `ProofTest` and `DraftTest` already use them.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `sh server/test/run.sh -k PaperCommit`
Expected: FAIL — `TypeError: commit() got an unexpected keyword argument
'target'`.

- [ ] **Step 3: Add the targets and the paper path**

In `server/claudepost/editions.py`, beside the `REASON_*` block (around line
128), add:

```python
#: What a commit is for. ``board`` is the newspaper that goes on the glass and
#: is every bit of today's behaviour; ``paper`` is the one the desk keeps for a
#: company whether or not it is the one being printed.
#:
#: A named pair rather than a boolean because the difference is not "publish or
#: not" -- a board commit that stages has not published either -- it is *which
#: state the edition is being filed into*, and a `publish=False` would read as
#: the first.
TARGET_BOARD = "board"
TARGET_PAPER = "paper"
COMMIT_TARGETS: tuple[str, ...] = (TARGET_BOARD, TARGET_PAPER)
```

and beside `REASON_UNCHANGED`:

```python
REASON_PAPER = "paper: filed for {s}; neither pointer moved"
REASON_UNCHANGED_PAPER = "unchanged: identical to the newest paper for {s}"
```

Change `CommitResult`'s docstring — its `state` list is now four long:

```python
    ``state`` is one of ``"published"``, ``"staged"``, ``"unchanged"`` or
    ``"paper"``. ``"paper"`` is an edition that was filed for the index and
    not for the glass: it passed every gate but the schedule one, which does
    not apply to it, and neither pointer moved.
```

Change `commit`'s signature and add to its docstring:

```python
    def commit(self, draft_id: str, schedule: Schedule, now: float,
               target: str = TARGET_BOARD,
               symbol: str | None = None) -> CommitResult:
```

Insert into its docstring, after the paragraph about the five gates:

```
        ``target`` picks which of the two things is being filed.
        :data:`TARGET_BOARD` is the paragraph above, unchanged.
        :data:`TARGET_PAPER` files the day's newspaper *about a company* --
        four of the five gates, with the schedule one skipped because nothing
        is about to appear on any wall, and with the fingerprint compared
        against that company's own newest paper rather than against
        ``current``. Neither pointer is written.

        ``symbol`` is required by, and only meaningful to, a paper commit. It
        is checked against the draft's own ``subject.symbol`` and a
        disagreement is a ``Conflict``: the index is derived from the payload,
        so a model that drifted to another company would otherwise file its
        paper under the name the desk asked for and nothing downstream would
        ever see the two disagree.
```

and extend the `Raises:` block:

```
            Conflict: that draft is already inside a commit, or
                ``commit_symbol_mismatch`` -- the draft is about a different
                company than the one this commit names.
            BadRequest: no payload, a gate refused it, an unknown ``target``,
                or ``commit_needs_symbol`` -- a paper commit that named no
                company.
```

The body of `commit` gains the target check before the `_busy` claim, and
passes both through:

```python
        if target not in COMMIT_TARGETS:
            raise BadRequest(message="target is one of: "
                                     + ", ".join(COMMIT_TARGETS))
        draft_dir = self._require_draft(draft_id)
        with self._lock:
            if draft_id in self._busy:
                raise Conflict(message=f"draft {draft_id} is already being committed")
            self._busy.add(draft_id)
        try:
            return self._commit(draft_id, draft_dir, schedule, now,
                                target, symbol)
        finally:
            with self._lock:
                self._busy.discard(draft_id)
```

In `_commit`, change the signature and replace the block that runs from
`eid, stored, dropped = _fingerprint_draft(...)` down to (and including) the
`if eid == self.staged_id():` branch with this. Everything above it — the
payload read, gate 1 and gate 2 — is untouched, which is the point: a paper
pays for exactly the same two gates.

```python
    def _commit(self, draft_id: str, draft_dir: str, schedule: Schedule,
                now: float, target: str = TARGET_BOARD,
                symbol: str | None = None) -> CommitResult:
```

```python
        eid, stored, dropped = _fingerprint_draft(draft_dir, raw)
        tile_ids = _tile_ids(os.path.join(draft_dir, TILES_DIR))
        subject = _subject_symbol(stored)
        is_paper = target == TARGET_PAPER

        if is_paper:
            if not symbol:
                raise BadRequest("commit_needs_symbol",
                                 "a paper commit names the company it is for")
            if subject != symbol:
                # THE WALL. The index is keyed by the payload's own subject, so
                # filing this would put a newspaper about one company under
                # another company's name -- and nothing downstream could ever
                # see the two disagree, because downstream only ever reads the
                # index. Refusing here is what makes a drifted run a failed
                # command with a reason in the queue instead.
                raise Conflict("commit_symbol_mismatch",
                               f"this draft is about {subject or 'no company'}, "
                               f"not about {symbol}")
            if eid == self._newest_paper_id(symbol):
                self._store.audit("commit", {"edition": eid,
                                             "state": "unchanged",
                                             "draft": draft_id,
                                             "symbol": symbol})
                self._drop_draft(draft_id)
                return CommitResult(eid, "unchanged",
                                    REASON_UNCHANGED_PAPER.format(s=symbol))
            # No schedule gate: a paper appears on nobody's wall, so a quiet
            # window, a hold and the minimum gap all have nothing to say about
            # it. `ok` is False so the meta below records no published_at, and
            # the tail files rather than stages.
            ok, reason = False, REASON_PAPER.format(s=symbol)
        else:
            if eid == self.current_id():
                # The bytes are already on the glass and already on disk as an
                # immutable edition, so the draft has nowhere left to go. No
                # pointer write and no publish row: an unchanged commit is not
                # a publish and must not restart the minimum gap.
                self._store.audit("commit", {"edition": eid,
                                             "state": "unchanged",
                                             "draft": draft_id})
                self._drop_draft(draft_id)
                return CommitResult(eid, "unchanged", REASON_UNCHANGED)

            ok, reason = self._schedule_gate(schedule, now, now)

            if eid == self.staged_id():
                # Already waiting, and waiting is idempotent. Rewriting the
                # pointer would only move an mtime; publishing is publish_due's
                # decision and it runs every few seconds.
                self._store.audit("commit", {"edition": eid, "state": "staged",
                                             "draft": draft_id})
                self._drop_draft(draft_id)
                return CommitResult(eid, "staged", reason)
```

The `meta` dict below it is unchanged from Task 3 (`published_at` is `now if ok
else None`, and `ok` is already `False` on the paper path). Change only the
tail of `_commit`, the three lines inside `with self._lock:`:

```python
            with self._lock:
                if is_paper:
                    return self._file_paper(eid, symbol, reason, draft_id)
                if ok:
                    return self._publish(eid, now, reason, draft_id=draft_id)
                return self._stage(eid, now, reason, draft_id=draft_id)
```

Add the two new methods beside `_stage`:

```python
    def _file_paper(self, edition_id: str, symbol: str, reason: str,
                    draft_id: str) -> CommitResult:
        """Record a paper. Called with the lock held.

        The shortest of the three tails, and deliberately: there is no pointer
        to write, no publish row to add and no gap to restart. The edition is
        already on disk and already in the store by the time this runs, so all
        that is left is the audit line and the draft.
        """
        self._store.audit("paper", {"edition": edition_id, "symbol": symbol})
        self._drop_draft(draft_id)
        return CommitResult(edition_id, "paper", reason)

    def _newest_paper_id(self, symbol: str) -> str | None:
        """The edition this company's paper currently is, or ``None``."""
        meta = self._newest_by_symbol().get(symbol)
        return meta["id"] if meta else None
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `sh server/test/run.sh -k PaperCommit` — Expected: PASS
Run: `sh server/test/run.sh` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/claudepost/editions.py server/test/test_editions.py
git commit -m "$(cat <<'EOF'
feat(desk): a commit target, so an edition can be filed without a pointer

`commit(..., target="paper", symbol=S)` runs the same two gates, compares the
fingerprint against that company's own newest paper, and writes neither
pointer. A draft whose subject is not S is refused 409 -- the index is derived
from the payload, so a drifted run would otherwise file under the wrong name
and nothing downstream could see the two disagree.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Pxz7nt2DE47CnaMzY4kvNJ
EOF
)"
```

---

## Task 6: The two doors the worker knocks on

**Files:**
- Modify: `server/claudepost/http.py`
- Modify: `server/claudepost/app.py`
- Test: `server/test/test_http.py`

**Interfaces:**
- Consumes: `Store.add_command(..., symbol=)` (Task 1);
  `EditionStore.commit(..., target=, symbol=)` (Task 5);
  `EditionStore.list_editions` (Task 3).
- Produces:
  - `Desk.enqueue(kind, text, priority=5, deadline_at=None, source="api",
    reply_to=None, lang=None, symbol=None) -> dict`.
  - `POST /api/commands` accepts `symbol`.
  - `POST /api/drafts/<d>/commit` accepts `{"target": …, "symbol": …}`.
  - `GET /api/editions` rows carry `symbol` and `lang`.

- [ ] **Step 1: Write the failing tests**

Add to `server/test/test_http.py`. Put the class beside the other control-plane
classes (after the class that covers `/api/commands`; search for
`h_enqueue`-related tests and place it there):

```python
class PaperCommandTest(DeskTestCase):
    """A `paper` command over the wire, and the symbol it must carry."""

    def post(self, **doc):
        doc.setdefault("kind", "paper")
        doc.setdefault("text", "Refresh the paper for SNDK.")
        return self.api("POST", "/api/commands", doc, "producer")

    def test_a_paper_command_carries_its_company(self):
        status, doc = self.post(symbol="SNDK")
        self.assertEqual(status, 200, doc)
        self.assertEqual(doc["command"]["kind"], "paper")
        self.assertEqual(doc["command"]["symbol"], "SNDK")

    def test_the_symbol_comes_back_on_the_read_and_on_the_list(self):
        _s, doc = self.post(symbol="sndk")
        cid = doc["command"]["id"]
        status, one = self.api("GET", "/api/commands/%s" % cid, None, "producer")
        self.assertEqual(status, 200, one)
        self.assertEqual(one["command"]["symbol"], "SNDK")

        status, listed = self.api("GET", "/api/commands", None, "producer")
        self.assertEqual(status, 200, listed)
        [row] = [r for r in listed["commands"] if r["id"] == cid]
        self.assertEqual(row["symbol"], "SNDK")

    def test_a_paper_without_a_symbol_is_a_bad_request(self):
        status, doc = self.post()
        self.assertEqual(status, 400, doc)

    def test_another_kind_with_a_symbol_is_a_bad_request(self):
        status, doc = self.post(kind="custom", symbol="SNDK")
        self.assertEqual(status, 400, doc)

    def test_the_older_kinds_still_post_and_report_a_null_symbol(self):
        status, doc = self.post(kind="custom", text="look at the guide")
        self.assertEqual(status, 200, doc)
        self.assertIsNone(doc["command"]["symbol"])


class CommitTargetTest(DeskTestCase):
    """The commit body, and the fact that no body still means the board."""

    #: A payload about a company, so a paper commit has a subject to match.
    SNDK = json.dumps({
        "edition": "SEMICONDUCTORS",
        "subject": {"symbol": "SNDK", "name": "Sandisk Corp."},
        "stories": [{"rank": 0, "headline": "A headline long enough to be one",
                     "body": "MILPITAS — copy."}],
    }).encode()

    def draft(self, payload=None):
        status, doc = self.api("POST", "/api/drafts", {}, "producer")
        self.assertEqual(status, 200, doc)
        draft = doc["draft_id"]
        status, _, _ = self.call("PUT", "/api/drafts/%s/news.json" % draft,
                                 payload or self.SNDK, self.tokens["producer"])
        self.assertEqual(status, 200)
        return draft

    def commit(self, draft, body=None):
        return self.api("POST", "/api/drafts/%s/commit" % draft, body, "producer")

    def test_no_body_at_all_is_still_a_board_commit(self):
        draft = self.draft()
        status, raw, _ = self.call("POST", "/api/drafts/%s/commit" % draft,
                                   None, self.tokens["producer"])
        self.assertEqual(status, 200, raw)
        self.assertEqual(json.loads(raw)["state"], "published")

    def test_an_empty_object_is_still_a_board_commit(self):
        status, doc = self.commit(self.draft(), {})
        self.assertEqual(status, 200, doc)
        self.assertEqual(doc["state"], "published")

    def test_a_paper_commit_files_without_moving_the_board(self):
        board = self.file_edition()
        status, doc = self.commit(self.draft(),
                                  {"target": "paper", "symbol": "SNDK"})
        self.assertEqual(status, 200, doc)
        self.assertEqual(doc["state"], "paper")

        status, editions = self.api("GET", "/api/editions", None, "producer")
        self.assertEqual(editions["current"], board["edition_id"])
        self.assertIsNone(editions["staged"])

    def test_a_lower_case_symbol_in_the_body_is_accepted(self):
        status, doc = self.commit(self.draft(),
                                  {"target": "paper", "symbol": "sndk"})
        self.assertEqual(status, 200, doc)
        self.assertEqual(doc["state"], "paper")

    def test_a_draft_about_another_company_is_a_conflict(self):
        status, doc = self.commit(self.draft(),
                                  {"target": "paper", "symbol": "ACME"})
        self.assertEqual(status, 409, doc)
        self.assertEqual(doc["error"], "commit_symbol_mismatch")

    def test_a_paper_target_with_no_symbol_is_a_bad_request(self):
        status, doc = self.commit(self.draft(), {"target": "paper"})
        self.assertEqual(status, 400, doc)
        self.assertEqual(doc["error"], "commit_needs_symbol")

    def test_a_target_the_desk_has_never_heard_of_is_a_bad_request(self):
        status, doc = self.commit(self.draft(), {"target": "glass"})
        self.assertEqual(status, 400, doc)

    def test_the_history_reports_the_company_and_the_language(self):
        self.commit(self.draft(), {"target": "paper", "symbol": "SNDK"})
        status, doc = self.api("GET", "/api/editions", None, "producer")
        self.assertEqual(status, 200, doc)
        [row] = [r for r in doc["editions"] if r.get("symbol") == "SNDK"]
        self.assertEqual(row["lang"], "en")
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `sh server/test/run.sh -k PaperCommandTest` and
`sh server/test/run.sh -k CommitTargetTest`
Expected: FAIL — a 200 where a 400 was wanted on the symbol cases, and
`KeyError: 'state'`/`'paper'` on the target cases (the body is ignored today).

- [ ] **Step 3: Pass the two fields through**

In `server/claudepost/app.py`, `Desk.enqueue` gains the keyword:

```python
    def enqueue(self, kind: str, text: str, priority: int = 5,
                deadline_at: float | None = None, source: str = "api",
                reply_to: str | None = None,
                lang: str | None = None,
                symbol: str | None = None) -> dict:
        """Add a command and wake anything parked on a long poll."""
        command = self.store.add_command(kind, text, priority=priority,
                                         deadline_at=deadline_at, source=source,
                                         reply_to=reply_to, lang=lang,
                                         symbol=symbol)
        with self.queue_event:
            self.queue_event.notify_all()
        return command
```

In `server/claudepost/http.py`, change the import at line 57 to:

```python
from .editions import COMMIT_TARGETS, TARGET_BOARD, CommitResult, SHEET_RE
```

`h_enqueue`'s call gains one argument — extend the comment above it too, since
it names the fields:

```python
        # `reply_to`, `lang` and `symbol` are passed through as they arrived,
        # `None` and all: `store.add_command` is where all three are checked,
        # so the shape a `curl` can file and the shape the phone can file are
        # one rule. `symbol` in particular is checked *against the kind* there,
        # which a route cannot do without duplicating the kind table.
        command = self.desk.enqueue(
            doc.get("kind", "custom"), text,
            priority=_int_field(doc, "priority", 5, 0, 9),
            deadline_at=_epoch_field(doc, "deadline_at"),
            source=str(doc.get("source", "api"))[:64],
            reply_to=doc.get("reply_to"), lang=doc.get("lang"),
            symbol=doc.get("symbol"))
```

Replace `h_commit` with:

```python
    def h_commit(self, match, _query) -> None:
        """File a draft, for the board or as a company's paper.

        The body is **optional**, and that is the compatibility promise: no
        body, an empty object, or one with no ``target`` is exactly the board
        commit this route has always been. A worker one release behind the desk
        goes on filing editions.
        """
        desk = self.desk
        doc = self._json_body(required=False)
        target = doc.get("target", TARGET_BOARD)
        if target not in COMMIT_TARGETS:
            raise BadRequest(message="target is one of: "
                                     + ", ".join(COMMIT_TARGETS))
        symbol = doc.get("symbol")
        if symbol is not None:
            # Shape here, meaning in `editions.commit`: a non-string cannot be
            # upper-cased, and everything past that -- whether it matches the
            # draft's own subject -- is the commit's decision and not a route's.
            if not isinstance(symbol, str) or isinstance(symbol, bool):
                raise BadRequest(message="symbol is a ticker")
            symbol = symbol.upper()
        self._send_commit(desk.editions.commit(match.group("draft"), desk.schedule,
                                               desk.clock.now(),
                                               target=target, symbol=symbol))
```

And route the history through the edition store, so its rows carry the two
fields:

```python
    def h_list_editions(self, _match, _query) -> None:
        # `editions.list_editions` and not `store.list_editions`: the company
        # and the language are filled off the payload for an edition that
        # predates them, and that fill is the edition store's.
        self._send_json(200, {"ok": True,
                              "editions": self.desk.editions.list_editions(),
                              "current": self.desk.editions.current_id(),
                              "staged": self.desk.editions.staged_id()})
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `sh server/test/run.sh -k PaperCommandTest` — Expected: PASS
Run: `sh server/test/run.sh -k CommitTargetTest` — Expected: PASS
Run: `sh server/test/run.sh` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/claudepost/http.py server/claudepost/app.py server/test/test_http.py
git commit -m "$(cat <<'EOF'
feat(desk): the queue and the commit take a symbol over the wire

POST /api/commands passes `symbol` through to the store, which is where it is
checked against the kind. POST /api/drafts/<d>/commit reads an optional body:
no body, an empty object, or one without a `target` is exactly the board
commit this route has always been, so a worker a release behind goes on filing.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Pxz7nt2DE47CnaMzY4kvNJ
EOF
)"
```

---

## Task 7: The four routes a phone reads a paper through

**Files:**
- Modify: `server/claudepost/app.py`
- Modify: `server/claudepost/http.py`
- Create: `server/test/test_papers.py`

**Interfaces:**
- Consumes: `EditionStore.papers` (Task 4), `EditionStore.headline` (Task 3),
  `settings.DEFAULT["paper_refresh_hours"]` (Task 2).
- Produces:
  - `Desk.printable_symbols() -> list[str]` — the watchlist's printable
    symbols, in watchlist order; `[]` when there is no watchlist.
  - `Desk.paper_cadence_seconds() -> int`.
  - `Desk.papers(t: float | None = None) -> list[dict]` — the rows of
    `GET /api/papers`.
  - `GET /api/papers`, `GET /api/editions/<eid>/news.json`,
    `GET /api/editions/<eid>/tiles/<id>.bin`,
    `POST /api/papers/<SYMBOL>/publish`.

- [ ] **Step 1: Write the failing tests**

Create `server/test/test_papers.py`:

```python
"""The papers: one newspaper per company, read and published from a phone.

Everything here runs a real :class:`~claudepost.http.DeskServer` on a loopback
port, the way ``test_http.py`` does and for its reason -- what is being
asserted is what an app gets from a socket, including the scope on each route,
and a test that called the handlers in process could not catch a routing table
entry that never reaches them.

The rotation lives in this file too, because it is the same feature from the
other end: what the desk orders when nobody is asking it for anything.
"""

from __future__ import annotations

import json
import unittest

from claudepost import settings as st
from claudepost.app import HOUSEKEEPING_SECONDS

from test_http import DeskTestCase


def edition(symbol="SNDK", name="Sandisk Corp.", serial=1, lang=None,
            headline="A headline long enough to be a headline") -> bytes:
    """A payload about one company, distinguishable by ``serial``."""
    doc = {"edition": "SEMICONDUCTORS", "serial": serial,
           "subject": {"symbol": symbol, "name": name},
           "stories": [{"rank": 20, "headline": "A brief"},
                       {"rank": 0, "headline": headline,
                        "body": "MILPITAS — copy."}]}
    if lang is not None:
        doc["lang"] = lang
    return json.dumps(doc).encode()


def watchlist(*items) -> dict:
    """A watchlist document naming companies, printable unless said otherwise."""
    return {"items": [{"symbol": s, "name": n, "printable": p}
                      for s, n, p in items]}


class PaperTestCase(DeskTestCase):
    """A desk with a watchlist, and a way to file a paper for a company."""

    WATCHLIST = (("SNDK", "Sandisk Corp.", True),
                 ("ACME", "Acme Industries", True),
                 ("NVDA", "Nvidia Corp.", True))

    def setUp(self):
        super().setUp()
        status, doc = self.api("PUT", "/api/watchlist",
                               watchlist(*self.WATCHLIST))
        self.assertEqual(status, 200, doc)

    def paper(self, symbol="SNDK", serial=1, tile=None, **kw):
        """File one paper for ``symbol`` and return its edition id."""
        status, doc = self.api("POST", "/api/drafts", {}, "producer")
        self.assertEqual(status, 200, doc)
        draft = doc["draft_id"]
        status, _, _ = self.call("PUT", "/api/drafts/%s/news.json" % draft,
                                 edition(symbol, serial=serial, **kw),
                                 self.tokens["producer"])
        self.assertEqual(status, 200)
        if tile is not None:
            status, _, _ = self.call(
                "PUT", "/api/drafts/%s/tiles/pic.bin" % draft, tile,
                self.tokens["producer"], "application/octet-stream")
            self.assertEqual(status, 200)
        status, result = self.api("POST", "/api/drafts/%s/commit" % draft,
                                  {"target": "paper", "symbol": symbol},
                                  "producer")
        self.assertEqual(status, 200, result)
        self.assertIn(result["state"], ("paper", "unchanged"), result)
        return result["edition_id"]

    def papers(self, scope="producer"):
        return self.api("GET", "/api/papers", None, scope)


class PapersRouteTest(PaperTestCase):
    """`GET /api/papers`: one row per printable company, in watchlist order."""

    def test_a_row_for_every_printable_company_in_watchlist_order(self):
        status, doc = self.papers()
        self.assertEqual(status, 200, doc)
        self.assertTrue(doc["ok"])
        self.assertEqual([r["symbol"] for r in doc["papers"]],
                         ["SNDK", "ACME", "NVDA"])
        self.assertEqual([r["name"] for r in doc["papers"]],
                         ["Sandisk Corp.", "Acme Industries", "Nvidia Corp."])

    def test_a_company_with_no_paper_is_a_row_of_nulls_and_not_a_gap(self):
        # The pager draws "not written yet" from this. A skipped row would be
        # a company the owner watches and the app never mentions.
        status, doc = self.papers()
        [row] = [r for r in doc["papers"] if r["symbol"] == "NVDA"]
        self.assertIsNone(row["edition_id"])
        self.assertIsNone(row["created_at"])
        self.assertIsNone(row["lang"])
        self.assertIsNone(row["headline"])
        self.assertFalse(row["on_board"])
        self.assertTrue(row["stale"])

    def test_a_filed_paper_fills_its_row(self):
        eid = self.paper("SNDK", lang="ko", headline="메모리 가격이 오른다")
        status, doc = self.papers()
        [row] = [r for r in doc["papers"] if r["symbol"] == "SNDK"]
        self.assertEqual(row["edition_id"], eid)
        self.assertEqual(row["lang"], "ko")
        self.assertEqual(row["headline"], "메모리 가격이 오른다")
        self.assertEqual(row["created_at"], self.clock.now())
        self.assertFalse(row["on_board"])
        self.assertFalse(row["stale"])

    def test_a_row_goes_stale_at_the_cadence(self):
        self.paper("SNDK")
        self.clock.advance(st.DEFAULT["paper_refresh_hours"] * 3600 - 1)
        [row] = [r for r in self.papers()[1]["papers"] if r["symbol"] == "SNDK"]
        self.assertFalse(row["stale"])

        self.clock.advance(2)
        [row] = [r for r in self.papers()[1]["papers"] if r["symbol"] == "SNDK"]
        self.assertTrue(row["stale"])

    def test_the_board_s_own_edition_is_marked(self):
        board = self.file_edition()
        status, doc = self.papers()
        self.assertEqual(doc["board"], board["edition_id"])
        # PAYLOAD in test_http is about SNDK, so the board's edition is also
        # SNDK's newest paper -- which is the ordinary case, not a special one.
        [row] = [r for r in doc["papers"] if r["symbol"] == "SNDK"]
        self.assertEqual(row["edition_id"], board["edition_id"])
        self.assertTrue(row["on_board"])

    def test_a_company_that_is_not_printable_has_no_row(self):
        status, doc = self.api("PUT", "/api/watchlist",
                               watchlist(("SNDK", "Sandisk Corp.", True),
                                         ("ACME", "Acme Industries", False)))
        self.assertEqual(status, 200, doc)
        self.assertEqual([r["symbol"] for r in self.papers()[1]["papers"]],
                         ["SNDK"])

    def test_it_needs_a_producer_token(self):
        status, _, _ = self.call("GET", "/api/papers")
        self.assertEqual(status, 401)


class EditionReadTest(PaperTestCase):
    """Reading one edition's payload and tiles by its id."""

    TILE = bytes(range(256)) * 4

    def test_the_payload_comes_back_with_the_policy_block_spliced_in(self):
        eid = self.paper("SNDK")
        status, raw, headers = self.call(
            "GET", "/api/editions/%s/news.json" % eid, None,
            self.tokens["producer"])
        self.assertEqual(status, 200, raw)
        doc = json.loads(raw)
        self.assertEqual(doc["subject"]["symbol"], "SNDK")
        self.assertIn("poll_seconds", doc["policy"])
        self.assertIn("ETag", headers)

    def test_the_same_tag_comes_back_as_a_304(self):
        eid = self.paper("SNDK")
        _s, _b, headers = self.call("GET", "/api/editions/%s/news.json" % eid,
                                    None, self.tokens["producer"])
        status, body, _h = self.call(
            "GET", "/api/editions/%s/news.json" % eid, None,
            self.tokens["producer"],
            headers={"If-None-Match": headers["ETag"]})
        self.assertEqual(status, 304)
        self.assertEqual(body, b"")

    def test_a_tile_comes_back_verbatim(self):
        eid = self.paper("SNDK", tile=self.TILE)
        status, raw, headers = self.call(
            "GET", "/api/editions/%s/tiles/pic.bin" % eid, None,
            self.tokens["producer"])
        self.assertEqual(status, 200)
        self.assertEqual(raw, self.TILE)
        self.assertEqual(headers["Content-Type"], "application/octet-stream")

    def test_an_edition_that_is_not_there_is_a_404(self):
        status, _, _ = self.call("GET", "/api/editions/%s/news.json" % ("0" * 16),
                                 None, self.tokens["producer"])
        self.assertEqual(status, 404)

    def test_a_tile_that_is_not_there_is_a_404(self):
        eid = self.paper("SNDK")
        status, _, _ = self.call("GET", "/api/editions/%s/tiles/nope.bin" % eid,
                                 None, self.tokens["producer"])
        self.assertEqual(status, 404)

    def test_both_need_a_token(self):
        eid = self.paper("SNDK", tile=self.TILE)
        for path in ("/api/editions/%s/news.json" % eid,
                     "/api/editions/%s/tiles/pic.bin" % eid):
            with self.subTest(path=path):
                status, _, _ = self.call("GET", path)
                self.assertEqual(status, 401)

    def test_neither_is_reachable_without_one_from_the_device_plane(self):
        # The device plane is three paths and this is not one of them. A
        # per-edition read that leaked onto it would put every paper the desk
        # holds -- including companies the board never prints -- on an open URL.
        eid = self.paper("SNDK")
        status, _, _ = self.call("GET", "/api/editions/%s/news.json" % eid)
        self.assertEqual(status, 401)


class PublishPaperTest(PaperTestCase):
    """Putting a company's paper on the glass by hand."""

    def test_it_promotes_that_company_s_newest_edition(self):
        self.file_edition()                       # the board is on something
        eid = self.paper("ACME")
        status, doc = self.api("POST", "/api/papers/ACME/publish", {})
        self.assertEqual(status, 200, doc)
        self.assertEqual(doc["edition_id"], eid)
        self.assertEqual(doc["state"], "published")

        status, listed = self.api("GET", "/api/editions", None, "producer")
        self.assertEqual(listed["current"], eid)

    def test_the_newest_wins_when_a_company_has_two(self):
        self.paper("ACME", serial=1)
        self.clock.advance(3600)
        newest = self.paper("ACME", serial=2)
        status, doc = self.api("POST", "/api/papers/ACME/publish", {})
        self.assertEqual(doc["edition_id"], newest, doc)

    def test_a_lower_case_symbol_in_the_path_works(self):
        eid = self.paper("ACME")
        status, doc = self.api("POST", "/api/papers/acme/publish", {})
        self.assertEqual(status, 200, doc)
        self.assertEqual(doc["edition_id"], eid)

    def test_a_company_with_no_paper_is_a_404_that_says_so(self):
        status, doc = self.api("POST", "/api/papers/NVDA/publish", {})
        self.assertEqual(status, 404, doc)
        self.assertEqual(doc["error"], "no_paper")

    def test_publishing_what_is_already_up_changes_nothing(self):
        eid = self.paper("ACME")
        self.api("POST", "/api/papers/ACME/publish", {})
        status, doc = self.api("POST", "/api/papers/ACME/publish", {})
        self.assertEqual(status, 200, doc)
        self.assertEqual(doc["state"], "unchanged")
        self.assertEqual(doc["edition_id"], eid)

    def test_a_producer_token_may_not_publish(self):
        self.paper("ACME")
        status, doc = self.api("POST", "/api/papers/ACME/publish", {},
                               "producer")
        self.assertEqual(status, 403, doc)
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `sh server/test/run.sh -k papers`
Expected: FAIL — 404 on every one of the four paths, because no route matches
them.

- [ ] **Step 3: Build the rows and add the routes**

In `server/claudepost/app.py`, add three methods to `Desk`, beside
`set_settings` (around line 562):

```python
    def printable_symbols(self) -> list[str]:
        """The companies the desk keeps a paper for, in the watchlist's order.

        ``printable`` and not every item: the watchlist carries companies the
        owner is only watching, and a paper costs the worker thirty to forty
        minutes. The order is the document's own, because it is the order the
        pager draws and the tiebreak the rotation uses -- an order decided
        here rather than there would be two answers to "which is first".

        ``[]`` on a desk with no watchlist, which is a real state: the vault
        pushes that document every morning and a desk brought up before the
        first push has none.
        """
        if not self.watchlist:
            return []
        return [item["symbol"] for item in self.watchlist["items"]
                if item["printable"]]

    def paper_cadence_seconds(self) -> int:
        """How old a paper may get before it is rewritten, in seconds.

        One function, because three callers ask -- the rotation's staleness
        test, the deadline it files with, and the ``stale`` flag the pager
        draws. Three spellings of ``hours * 3600`` is how a phone comes to
        badge a paper stale that the desk has no intention of refreshing.
        """
        return int(self.settings.get("paper_refresh_hours",
                                     st.DEFAULT["paper_refresh_hours"])) * 3600

    def papers(self, t: float | None = None) -> list[dict]:
        """One row per printable company, whether or not it has a paper.

        The row is the phone's whole model of a paper: which company, which
        edition, when it was written, what it is called, whether it is the one
        on the glass and whether it is due. A company with no paper is a row of
        nulls rather than an absence, because "not written yet" is a page the
        pager draws.
        """
        now = self.clock.now() if t is None else t
        cadence = self.paper_cadence_seconds()
        current = self.editions.current_id()
        items = [item for item in (self.watchlist["items"] if self.watchlist
                                   else [])
                 if item["printable"]]
        found = self.editions.papers([item["symbol"] for item in items])

        rows = []
        for item in items:
            meta = found.get(item["symbol"])
            eid = meta["id"] if meta else None
            try:
                created = float(meta["created_at"]) if meta else None
            except (KeyError, TypeError, ValueError):
                created = None
            rows.append({
                "symbol": item["symbol"],
                "name": item["name"],
                "edition_id": eid,
                "created_at": created,
                "lang": meta.get("lang") if meta else None,
                "headline": self.editions.headline(eid) if eid else None,
                "on_board": eid is not None and eid == current,
                # A company with no paper is stale by definition -- there is
                # nothing to be current -- which is also what puts it first in
                # the rotation's ordering.
                "stale": created is None or now - created >= cadence,
            })
        return rows
```

Add the text the rotation files with, beside `PHONE_SOURCE` at the top of the
module (Task 8 uses it; it goes in now so the constant has one home):

```python
#: What the rotation writes on a paper order. The worker's prompt reads the
#: company off the command's ``symbol`` column and not out of this sentence --
#: this is what an operator sees in the queue, and what the model is told the
#: run is for.
PAPER_ORDER = ("Refresh the paper for {s}. The company is given; "
               "research it and write both pages.")
```

In `server/claudepost/http.py`, add the four handlers. Put the two edition
readers beside `h_get_edition` and the two paper routes after them:

```python
    def h_edition_payload(self, match, _query) -> None:
        """One edition's payload, by id, with the policy block spliced in.

        The same bytes ``/news.json`` would serve if this edition were current,
        and deliberately so: the phone's reader is the board's reader, and a
        second shape here would be a second parser on the phone. The splice is
        what makes them identical -- see :mod:`~claudepost.policy` for why the
        block is computed per request and never stored.

        ``producer`` scope and not the device plane. The device plane is three
        paths, and a per-edition read that leaked onto it would put every paper
        the desk holds -- including companies the board never prints -- behind
        no credential at all.
        """
        desk = self.desk
        payload = desk.editions.read_payload(match.group("eid"))
        if payload is None:
            raise NotFound()
        body = policy.splice_policy(payload, desk.schedule, desk.clock.now())
        tag = _etag(body)
        # get_all(), not get(): a repeated field may arrive as several lines
        # (RFC 9110 5.3), the same reason `_serve_edition` reads it this way.
        if _if_none_match(", ".join(self.headers.get_all("If-None-Match") or []),
                          tag):
            self._send_not_modified(tag)
            return
        self._send_bytes(200, body, "application/json", etag=tag)

    def h_edition_tile(self, match, _query) -> None:
        """One tile of one edition, verbatim.

        A 404 rather than an empty body for a tile that is not there, which is
        the device plane's rule for the same reason: the module reflows without
        the picture and the page still prints.
        """
        data = self.desk.editions.read_tile(match.group("eid"),
                                            match.group("tile"))
        if data is None:
            raise NotFound()
        self._send_bytes(200, data, "application/octet-stream")

    # -- handlers: the papers ---------------------------------------------
    def h_papers(self, _match, _query) -> None:
        """Every company's paper, and which edition is on the glass.

        ``board`` is beside the rows rather than folded into them because it is
        one fact about the desk and not a fact about a company: a client
        drawing "on the board" gets it from the flag, and a client that wants
        to know what the board is showing when none of these papers is on it
        gets it from here.
        """
        desk = self.desk
        self._send_json(200, {"ok": True, "papers": desk.papers(),
                              "board": desk.editions.current_id()})

    def h_publish_paper(self, match, _query) -> None:
        """Put a company's newest paper on the glass, now.

        :meth:`~claudepost.editions.EditionStore.promote` behind a symbol
        lookup, which means it ignores every schedule gate exactly as promote
        does -- the operator asked for this by hand, and a rule you cannot
        override is a rule somebody ends up editing at midnight. The next
        scheduled wake's edition publishes over it in the ordinary way.
        """
        desk = self.desk
        symbol = match.group("symbol").upper()
        meta = desk.editions.papers([symbol])[symbol]
        if meta is None:
            raise NotFound("no_paper",
                           f"no edition has been filed about {symbol}")
        self._send_commit(desk.editions.promote(meta["id"]))
```

Add the route entries. The two edition reads go into the `/api/editions` block,
after the `notes.md` entry:

```python
    (re.compile(r"^/api/editions/(?P<eid>[0-9a-f]{8,64})/news\.json\Z"), {
        "GET": ("producer", DeskHTTPRequestHandler.h_edition_payload)}),
    (re.compile(r"^/api/editions/(?P<eid>[0-9a-f]{8,64})/tiles/(?P<tile>%s)\.bin\Z" % _TILE_ID), {
        "GET": ("producer", DeskHTTPRequestHandler.h_edition_tile)}),
```

and the two paper routes go in their own block after the `/api/editions` block:

```python
    # The symbol in the path is matched case-insensitively and upper-cased by
    # the handler, the way `watchlist._symbol` accepts `"acme"`: a phone that
    # kept a lower-case ticker should not get a 404 that looks like "there is
    # no paper" when what it means is "you spelled it in the wrong case".
    (re.compile(r"^/api/papers\Z"), {
        "GET": ("producer", DeskHTTPRequestHandler.h_papers)}),
    (re.compile(r"^/api/papers/(?P<symbol>[A-Za-z0-9.\-]{1,8})/publish\Z"), {
        "POST": ("operator", DeskHTTPRequestHandler.h_publish_paper)}),
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `sh server/test/run.sh -k papers` — Expected: PASS
Run: `sh server/test/run.sh` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/claudepost/app.py server/claudepost/http.py server/test/test_papers.py
git commit -m "$(cat <<'EOF'
feat(desk): four routes that read a paper and put one on the board

GET /api/papers is one row per printable watchlist company, in the watchlist's
order, with a row of nulls for a company nothing has been written about yet --
"not written yet" is a page the pager draws, not a gap. The per-edition reads
splice the policy block exactly as /news.json does, so the phone's reader is
the board's reader. All four are behind a token: the device plane is three
paths, and a per-edition read on it would put every paper the desk holds on an
open URL.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Pxz7nt2DE47CnaMzY4kvNJ
EOF
)"
```

---

## Task 8: The rotation that orders the stalest paper

**Files:**
- Modify: `server/claudepost/app.py`
- Test: `server/test/test_papers.py`

**Interfaces:**
- Consumes: `Desk.printable_symbols`, `Desk.paper_cadence_seconds`,
  `Desk.papers`, `PAPER_ORDER` (Task 7); `Desk.enqueue(..., symbol=)` (Task 6);
  `EditionStore.prune(..., symbols=)` (Task 4).
- Produces:
  - `Desk._order_stale_paper(t: float) -> str | None` — the symbol ordered, or
    `None`.
  - `Desk.tick()`'s `did` list gains `"paper:<SYMBOL>"`.
  - `Desk.tick()`'s housekeeping now calls
    `self.editions.prune(symbols=self.printable_symbols())`.

- [ ] **Step 1: Write the failing tests**

Append to `server/test/test_papers.py`:

```python
class RotationTest(PaperTestCase):
    """What the desk orders when nobody is asking it for anything.

    The four rules in order: not while the queue has anything in it, the
    stalest company first, not before the cadence, and priority 9 so that
    anything a person files goes ahead of it.

    `DeskTestCase` puts the clock at nine on a Wednesday morning, three hours
    past the 06:00 wake and well outside `WAKE_GRACE_SECONDS`. A case that
    advances a whole cadence lands at 21:00, an hour before the 22:00 one. So
    no tick in this class can fire a scheduled `file_edition` -- which matters
    more here than anywhere else, because a wake's own command would stand the
    rotation down by rule 1 and every assertion below would read as a bug in
    the rotation.
    """

    def rotate(self):
        """One housekeeping pass, and what it did."""
        self.clock.advance(HOUSEKEEPING_SECONDS)
        return self.desk.tick()

    def ordered(self):
        """Every paper command on the queue, oldest first."""
        return [c for c in self.desk.commands() if c["kind"] == "paper"]

    def test_an_idle_desk_with_nothing_written_orders_the_first_company(self):
        # Every company is equally stale -- none has a paper -- so the tiebreak
        # is the watchlist's own order and the answer must be SNDK every time.
        self.assertIn("paper:SNDK", self.rotate())
        [one] = self.ordered()
        self.assertEqual(one["kind"], "paper")
        self.assertEqual(one["symbol"], "SNDK")
        self.assertEqual(one["priority"], 9)
        self.assertEqual(one["source"], "rotation")
        self.assertEqual(one["text"],
                         "Refresh the paper for SNDK. The company is given; "
                         "research it and write both pages.")

    def test_the_deadline_is_one_cadence_ahead(self):
        self.rotate()
        [one] = self.ordered()
        self.assertAlmostEqual(one["deadline_at"],
                               one["created_at"]
                               + st.DEFAULT["paper_refresh_hours"] * 3600,
                               places=3)

    def test_it_orders_one_and_then_waits_for_it(self):
        # The whole idempotency argument: there is no meta key and no memory,
        # only the fact that a queue with something in it stops the next order.
        self.assertIn("paper:SNDK", self.rotate())
        for _ in range(3):
            self.assertNotIn("paper:SNDK", self.rotate())
        self.assertEqual(len(self.ordered()), 1)

    def test_a_claimed_paper_still_stops_the_next_one(self):
        self.rotate()
        self.desk.store.claim_command("w")
        self.assertEqual(self.ordered()[0]["status"], "claimed")
        self.assertEqual([d for d in self.rotate() if d.startswith("paper:")],
                         [])

    def test_a_command_of_any_other_kind_stops_it_too(self):
        # An `ask` the owner typed is claimed on the worker's next poll, and a
        # paper queued behind it would make that answer wait for a run that
        # takes thirty to forty minutes.
        self.desk.enqueue("ask", "왜 그 회사예요?", source="app")
        self.assertEqual([d for d in self.rotate() if d.startswith("paper:")],
                         [])

    def test_a_finished_command_does_not_stop_it(self):
        cid = self.desk.enqueue("ask", "왜 그 회사예요?")["id"]
        self.desk.store.claim_command("w")
        self.desk.finish(cid, "done", "answered")
        self.assertIn("paper:SNDK", self.rotate())

    def test_the_company_with_the_oldest_paper_goes_first(self):
        self.paper("SNDK")
        self.clock.advance(60)
        self.paper("NVDA")
        self.clock.advance(60)
        self.paper("ACME")
        # All three now have papers; SNDK's is the oldest.
        self.clock.advance(st.DEFAULT["paper_refresh_hours"] * 3600)
        self.assertIn("paper:SNDK", self.rotate())

    def test_a_company_with_no_paper_is_older_than_any_paper(self):
        # NVDA has never been written about. However fresh the other two are,
        # it is the one the pager has nothing to show for.
        self.paper("SNDK")
        self.paper("ACME")
        self.assertIn("paper:NVDA", self.rotate())

    def test_nothing_is_ordered_while_every_paper_is_fresh(self):
        for symbol in ("SNDK", "ACME", "NVDA"):
            self.paper(symbol)
        self.assertEqual([d for d in self.rotate() if d.startswith("paper:")],
                         [])

    def test_the_cadence_is_the_setting_and_not_a_constant(self):
        for symbol in ("SNDK", "ACME", "NVDA"):
            self.paper(symbol)
        status, doc = self.api("PUT", "/api/settings",
                               {"lang": "en", "paper_refresh_hours": 1})
        self.assertEqual(status, 200, doc)

        self.clock.advance(3600)
        self.assertIn("paper:SNDK", self.rotate())

    def test_a_desk_with_no_watchlist_orders_nothing(self):
        # Real state: the vault pushes that document every morning and a desk
        # brought up before the first push has none. A rotation that guessed a
        # company here would be the board's own job, done wrong.
        self.desk.watchlist = None
        self.assertEqual([d for d in self.rotate() if d.startswith("paper:")],
                         [])

    def test_a_company_that_is_not_printable_is_never_ordered(self):
        status, doc = self.api("PUT", "/api/watchlist",
                               watchlist(("SNDK", "Sandisk Corp.", False),
                                         ("ACME", "Acme Industries", True)))
        self.assertEqual(status, 200, doc)
        self.assertIn("paper:ACME", self.rotate())

    def test_a_failed_run_is_ordered_again(self):
        self.rotate()
        cid = self.ordered()[0]["id"]
        self.desk.store.claim_command("w")
        self.desk.finish(cid, "failed", "the model drifted")
        self.assertIn("paper:SNDK", self.rotate())
        self.assertEqual(len(self.ordered()), 2)

    def test_retention_is_told_which_companies_to_protect(self):
        # The rotation and prune read the same list. A prune that did not know
        # about the watchlist would take the paper the pager is about to draw.
        eid = self.paper("SNDK")
        for n in range(40):
            self.clock.advance(60)
            self.paper("ACME", serial=n)
        self.clock.advance(HOUSEKEEPING_SECONDS)
        self.desk.tick()
        status, raw, _ = self.call("GET", "/api/editions/%s/news.json" % eid,
                                   None, self.tokens["producer"])
        self.assertEqual(status, 200)
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `sh server/test/run.sh -k RotationTest`
Expected: FAIL — `AssertionError: 'paper:SNDK' not found in ['housekeeping:…']`.

- [ ] **Step 3: Order the paper**

In `server/claudepost/app.py`, add the method beside `_fire_due_wake` (around
line 837):

```python
    def _order_stale_paper(self, t: float) -> str | None:
        """Order a refresh of the stalest paper, when there is nothing else to do.

        Four rules, in this order, and the first is the one that makes the
        other three safe:

        1. **Nothing while the queue holds anything**, of any kind. That is
           what makes this idempotent without a meta key, a timestamp or
           anything held in memory -- the order it just filed is what stops the
           next pass filing a second. It is also what keeps a typed `ask` from
           waiting behind a run that takes thirty to forty minutes: an `ask`
           posted while the worker is idle is claimed on its next poll, and
           this pass stands down until it finishes.
        2. **The stalest company first.** A company with no paper at all is
           older than any paper, because there is nothing for the pager to
           draw; ties go to the watchlist's own order, which ``min`` over a
           list gives for free by returning the first minimum.
        3. **Nothing before the cadence.** A paper younger than
           ``paper_refresh_hours`` is current.
        4. **Priority 9**, the lowest the queue has, so the morning order and
           anything typed on a phone -- both 5 -- are claimed ahead of a paper
           that is merely pending. Only a paper already *claimed* makes
           anything wait, and that is the cost accepted in the design.

        Quiet hours deliberately do not apply: a paper never touches the board,
        and the night is the cheapest time to write one.

        Returns the symbol ordered, or ``None``.
        """
        symbols = self.printable_symbols()
        if not symbols:
            return None

        # Two reads rather than one query with an IN clause: this runs every
        # ten minutes, both are index scans that stop at the first row, and a
        # query built here would be a second place that knows the status
        # vocabulary.
        for status in ("pending", "claimed"):
            if self.store.list_commands(status=status, limit=1):
                return None

        found = self.editions.papers(symbols)
        symbol = min(symbols, key=lambda s: _paper_age_key(found.get(s)))
        meta = found.get(symbol)
        cadence = self.paper_cadence_seconds()
        if meta is not None and t - _paper_age_key(meta) < cadence:
            return None

        self.enqueue("paper", PAPER_ORDER.format(s=symbol),
                     priority=9, source="rotation",
                     deadline_at=t + cadence, symbol=symbol)
        LOG.info("rotation: ordered a paper for %s", symbol)
        return symbol
```

and the module function beside `_last_wake_at`:

```python
def _paper_age_key(meta: dict | None) -> float:
    """When a paper was written, for ordering. No paper sorts oldest of all.

    ``-inf`` rather than ``0`` so that a symbol with no paper cannot be tied
    with one written at the epoch by a desk whose clock was wrong -- and so
    that the answer does not depend on the epoch being a time nobody files at.
    """
    if meta is None:
        return float("-inf")
    try:
        return float(meta.get("created_at") or 0.0)
    except (TypeError, ValueError):
        return 0.0
```

In `tick()`'s housekeeping block, change the `prune` call and add the rotation.
The block's two edits:

```python
            swept = self.editions.sweep_drafts()
            # The printable watchlist, so retention never takes the paper the
            # pager is about to draw. `papers()` and this read the same list
            # for the same reason.
            pruned = self.editions.prune(symbols=self.printable_symbols())
```

and, at the very end of the housekeeping block, after the owed answers:

```python
            # Last in the pass, deliberately: it is the only step that adds
            # work rather than clearing it, and the queue it reads must be the
            # one the reap above has already settled -- a lapsed lease still
            # counted as `claimed` would stand the rotation down for the next
            # ten minutes for nothing.
            ordered = self._order_stale_paper(t)
            if ordered:
                did.append("paper:" + ordered)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `sh server/test/run.sh -k RotationTest` — Expected: PASS
Run: `sh server/test/run.sh` — Expected: PASS. If `test_http.py`'s tick tests
now see a `paper:` entry they did not expect, it is because that case has a
watchlist and an empty queue — assert on membership of the entry the case is
about rather than on the whole `did` list.

- [ ] **Step 5: Commit**

```bash
git add server/claudepost/app.py server/test/test_papers.py
git commit -m "$(cat <<'EOF'
feat(desk): a rotation that orders the stalest paper when the worker is idle

Idempotent without a meta key or anything held in memory: a queue holding
anything at all, of any kind, stands the pass down. That is also what keeps a
typed `ask` from waiting behind a run of thirty to forty minutes. Priority 9,
the lowest the queue has, so the morning order and the phone are claimed first.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Pxz7nt2DE47CnaMzY4kvNJ
EOF
)"
```

---

## Task 9: A lease longer than any run

**Files:**
- Modify: `server/claudepost/store.py`
- Test: `server/test/test_store.py`
- Test: `server/test/test_papers.py`

**Interfaces:**
- Consumes: `Desk._order_stale_paper` (Task 8).
- Produces:
  - `claudepost.store.LEASE_SECONDS == 5400`. Nothing else about the reap
    changes — the constant is the whole of it, and every existing test reads
    it as `S.LEASE_SECONDS` rather than as a number, so they follow it.

- [ ] **Step 1: Write the failing tests**

Add to `server/test/test_store.py`, inside the existing `LeaseTest` class:

```python
    def test_the_lease_is_longer_than_any_run_the_worker_makes(self):
        # Ninety minutes, and the number is asserted rather than derived,
        # because the thing it has to be longer than is not in this file: a
        # paper run is 25-40 minutes clean and longer with a revision turn, and
        # on 2026-09-11 a thirty-minute lease put a claimed order back to
        # `pending` at minute 39 while the worker was still writing it.
        from claudepost import store as S
        self.assertEqual(S.LEASE_SECONDS, 5400)

    def test_an_hour_into_a_run_the_claim_still_holds(self):
        # The exact failure that was seen. With one worker it was harmless --
        # `finish_command` takes a report on a pending row -- but the rotation
        # reads `pending` as "the worker is idle" and would have ordered a
        # second paper on top of the one being written.
        cid = self.file_edition()["id"]
        self.store.claim_command("w1")
        self.clock.advance(3600)
        self.assertEqual(self.store.reap(), 0)
        c = self.store.get_command(cid)
        self.assertEqual(c["status"], "claimed")
        self.assertEqual(c["claimed_by"], "w1")

    def test_a_run_that_never_reports_is_still_reaped(self):
        # The other half: a longer lease must not become no lease. A worker
        # that died costs one retry, ninety minutes later.
        cid = self.file_edition()["id"]
        self.store.claim_command("w1")
        self.clock.advance(5401)
        self.assertEqual(self.store.reap(), 1)
        self.assertEqual(self.store.get_command(cid)["status"], "pending")
```

Add to `server/test/test_papers.py`, inside `RotationTest`:

```python
    def test_the_worker_is_busy_whether_the_row_is_pending_or_claimed(self):
        """Both halves of rule 1, and the lease is what keeps them apart.

        A `claimed` row is a worker running; a `pending` row is one waiting to
        be claimed. The rotation stands down for either -- and the lease is
        what stops a run in progress becoming the second of those behind the
        desk's back, which is the whole of §3.8.
        """
        self.assertIn("paper:SNDK", self.rotate())
        self.assertEqual(self.ordered()[0]["status"], "pending")
        self.assertEqual([d for d in self.rotate() if d.startswith("paper:")],
                         [])

        self.desk.store.claim_command("w")
        self.assertEqual(self.ordered()[0]["status"], "claimed")
        self.assertEqual([d for d in self.rotate() if d.startswith("paper:")],
                         [])

    def test_a_run_an_hour_old_is_not_mistaken_for_an_idle_worker(self):
        self.rotate()
        self.desk.store.claim_command("w")
        self.clock.advance(3600)
        # `tick`'s housekeeping reaps before it rotates; an hour is inside the
        # lease, so the reap leaves the claim alone and the rotation sees it.
        self.assertEqual([d for d in self.desk.tick() if d.startswith("paper:")],
                         [])
        self.assertEqual(self.ordered()[0]["status"], "claimed")
        self.assertEqual(len(self.ordered()), 1)
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `sh server/test/run.sh -k LeaseTest`
Expected: FAIL — `AssertionError: 1800 != 5400`, and `AssertionError: 1 != 0`
on the hour-old claim, which is the bug in one line.

Run: `sh server/test/run.sh -k RotationTest`
Expected: FAIL on `test_a_run_an_hour_old_is_not_mistaken_for_an_idle_worker`
— the reap returns the row to `pending`, the rotation reads that as idle and
orders a second paper, so `did` carries `paper:SNDK` and `ordered()` is two
rows long. That failure **is** the incident this task exists for.

- [ ] **Step 3: Lengthen the lease**

In `server/claudepost/store.py`, replace the constant and its comment:

```python
#: How long a claim is good for. A worker that dies mid-edition costs one
#: retry, not a lost day -- so this is a wall against a dead worker, and it has
#: to be longer than any live one takes.
#:
#: NINETY MINUTES, up from thirty. A paper run is 25-40 minutes when its proof
#: clears first time and longer when it needs a revision turn, and on
#: 2026-09-11 the desk put a claimed order back to `pending` at minute 39 while
#: the worker was still writing it. With one worker that was harmless --
#: `finish_command` accepts a report on a pending row -- but two readers do not
#: survive it: a second worker would claim the row and write the same edition
#: twice, and the rotation reads `pending` as "the worker is idle" and would
#: order a second paper on top of the one in flight.
#:
#: No heartbeat. A worker that reported in every minute would be a second
#: protocol to keep alive, with its own failure mode -- a run that is working
#: but not heartbeating -- and a lease longer than any run is the simpler wall.
#: The cost of getting it wrong in this direction is bounded and dull: a dead
#: worker's command waits ninety minutes instead of thirty before a retry.
LEASE_SECONDS: int = 5400
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `sh server/test/run.sh -k LeaseTest` — Expected: PASS
Run: `sh server/test/run.sh -k RotationTest` — Expected: PASS
Run: `sh server/test/run.sh` — Expected: PASS, the whole suite. The three
existing lease tests read `S.LEASE_SECONDS` rather than `1800`, so they follow
the constant; if anything in `test_http.py` or `test_store.py` turns out to
advance a hardcoded `1800`, change it to `S.LEASE_SECONDS` rather than to
`5400` — the number belongs in one place.

- [ ] **Step 5: Commit**

```bash
git add server/claudepost/store.py server/test/test_store.py server/test/test_papers.py
git commit -m "$(cat <<'EOF'
fix(desk): a lease longer than any run the worker actually makes

Thirty minutes put a claimed order back to `pending` at minute 39 on
2026-09-11 while the worker was still writing it. Harmless with one worker --
finish_command takes a report on a pending row -- and not harmless to the two
readers this branch adds: a second worker would write the same edition twice,
and the rotation reads `pending` as an idle worker. A heartbeat would be a
second protocol with its own failure mode; a lease longer than any run is the
simpler wall.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Pxz7nt2DE47CnaMzY4kvNJ
EOF
)"
```

---

## Task 10: Say all of it in the two documents that describe the desk

**Files:**
- Modify: `docs/desk-server.md`
- Modify: `docs/app-control.md`
- Modify: `server/claudepost/http.py` (the settings audit line)

**Interfaces:**
- Consumes: everything from Tasks 1–9.
- Produces: no code interface. This task is the record, and it is a task rather
  than a step because a reader of `docs/desk-server.md` who does not find the
  `paper` kind there will conclude it does not exist.

- [ ] **Step 1: Fix the one line of code the earlier tasks left behind**

`h_put_settings` audits only the language, which is now half the document. In
`server/claudepost/http.py`:

```python
        self.desk.store.audit("settings", dict(doc))
```

The whole normalised document rather than a hand-listed subset: this line was
already one field behind the moment a second was added, and `parse_settings`
guarantees there is nothing in `doc` but the keys `_KEYS` names.

- [ ] **Step 2: Run the tests to verify nothing broke**

Run: `sh server/test/run.sh`
Expected: PASS. If a test asserts the audit detail is exactly `{"lang": …}`,
update it to the two-key document.

- [ ] **Step 3: Write the desk's own document**

In `docs/desk-server.md`, the paragraph beginning "The queue itself is
ordinary" says **"a thirty-minute lease"** and is now wrong. Replace that
clause and add the sentence that says why:

```markdown
The queue itself is ordinary: priority then FIFO, a ninety-minute lease, three
```

and, at the end of that same paragraph, after the sentence about the single
`UPDATE … RETURNING`:

```markdown
**The lease is ninety minutes and not thirty**, which is longer than any run
the worker actually makes: a paper is 25–40 minutes when its proof clears first
time and longer when it needs a revision turn, and on 2026-09-11 the desk put a
claimed order back to `pending` at minute 39 while the worker was still writing
it. With one worker that was harmless — `finish_command` accepts a report on a
pending row — and it is not harmless to the two readers this release adds: a
second worker would claim the row and write the same edition twice, and the
rotation below reads `pending` as "the worker is idle". There is no heartbeat,
deliberately: that would be a second protocol to keep alive, with its own
failure mode, where a lease longer than any run is a wall. The cost of erring
this way is bounded and dull — a dead worker's command waits ninety minutes
instead of thirty before its retry.
```

Then, under the same heading, after the `ask` paragraphs and before "**There is
no server-side thread object.**", add:

```markdown
**A sixth kind, `paper`, is a newspaper about a company the desk names.** It
carries a seventh column the other five never use — `symbol`, the ticker — and
that column is **required** on a `paper` and **refused on every other kind**.
Both halves are one rule: the symbol is the whole instruction on a paper run,
and on any other kind it is a field nothing reads and a promise nothing keeps.

```json
{ "kind": "paper", "symbol": "SNDK", "priority": 9, "source": "rotation",
  "text": "Refresh the paper for SNDK. The company is given; research it and write both pages." }
```

The symbol is upper-cased and matched against `^[A-Z0-9.\-]{1,8}\Z` — **eight
characters and not the watchlist's twelve**, because it is compared against an
edition's own `subject.symbol`, which the validator caps at eight. A
nine-character symbol here would name a command no draft could ever satisfy,
and every run for it would end in a 409 nobody could fix.
```

Add a new section after `## The settings`:

```markdown
## The papers

A **paper** is *the newest edition whose subject is S*. Nothing new is stored
that could be derived: an edition already carries its company inside its own
payload, so `meta.json` records `symbol` and `lang` at commit and the index is
one pass over the editions on disk. An edition filed before those two fields
existed has them derived from its stored payload on the way out — no migration
runs, and a pre-change edition is still a paper for its company.

**The index reads the disk and not the editions table.** A store row outlives
the directory `prune` deleted, so an index built from the table would hand a
reader an edition id whose payload 404s. Walking the disk also bounds the cost
at retention depth, where the table grows forever.

**`prune()` gains a fourth protected set** beside `current`, `staged` and the
in-flight builds: the newest edition of every **printable** watchlist symbol,
however old it is. A paper pruned out from under the pager is a row that goes
blank with nothing on the desk to explain it. A company removed from the
watchlist loses that protection and ages out normally, which is what makes
editing the watchlist the way to stop keeping a paper.

### A commit target

`POST /api/drafts/<d>/commit` takes an optional body:

```json
{ "target": "paper", "symbol": "SNDK" }
```

No body, an empty object, or one without a `target` is `board` — **exactly**
what this route has always done, so a worker a release behind the desk goes on
filing editions. A **paper commit** runs the same gates with one exception and
one change:

- **The schedule gate does not apply.** A quiet window, an operator's hold and
  the minimum gap are all about what may appear on the wall, and a paper
  appears on nobody's wall.
- **The fingerprint is compared against that company's own newest paper**,
  not against `current`. An unchanged paper is `unchanged`, exactly as an
  unchanged board edition is.

Neither pointer is written and no publish row is added — a paper is not a
publish and must not restart the minimum gap. `CommitResult.state` is `paper`.

**A draft about another company is refused `409 commit_symbol_mismatch`.** This
is the wall. The index is derived from the payload's own `subject.symbol`, so a
model that drifted to a second company would file its paper under the name the
desk asked for, and nothing downstream could ever see the two disagree —
downstream only ever reads the index. Refusing at the door makes a drifted run
a failed command with a reason in the queue instead. A `target: "paper"` with
no symbol is `400 commit_needs_symbol`.

### The rotation

On every housekeeping pass, after `publish_due`, in four rules:

1. **Nothing while the queue holds anything**, pending or claimed, of any kind.
   That is what makes the rotation idempotent with no meta key, no timestamp
   and nothing held in memory: the order it just filed is what stops the next
   pass filing a second. It is also what keeps a typed `ask` from waiting
   behind a run of thirty to forty minutes.
2. **The stalest company first.** A company with no paper is older than any
   paper; ties go to the watchlist's own order.
3. **Nothing before the cadence.**
4. **Priority 9**, the lowest the queue has, so the morning order and anything
   typed on a phone — both 5 — are claimed ahead of a paper that is merely
   pending. Only a paper already *claimed* makes anything wait, and that cost
   was accepted with open eyes.

Quiet hours deliberately do not apply: a paper never touches the board, and the
night is the cheapest time to write one. A failed run is finished `failed` like
any command, and the next pass orders the stalest again — the same company,
unless another has aged past it.

### The setting

`settings.json` gains `paper_refresh_hours`, an integer `1..72`, default `12`:

```json
{ "lang": "en", "paper_refresh_hours": 12 }
```

Twelve rather than the six first asked for, because a paper costs the worker
thirty to forty minutes and six hours across five companies does not fit in a
day beside the board's own runs. The floor is one hour because zero is not a
cadence but a worker that never stops; the ceiling is three days because past
it "the newest edition about S" stops being a current newspaper and the pager
is showing history with nothing to say so.

### The routes

| Method | Path | Scope | What it answers |
|---|---|---|---|
| GET | `/api/papers` | producer | `{ok, papers: [row…], board}` — one row per printable watchlist company, in watchlist order |
| GET | `/api/editions/<eid>/news.json` | producer | that edition's payload, policy block spliced in exactly as `/news.json` does, with an ETag and a 304 |
| GET | `/api/editions/<eid>/tiles/<id>.bin` | producer | that edition's tile, verbatim |
| POST | `/api/papers/<SYMBOL>/publish` | operator | `promote()` behind a symbol lookup; `404 no_paper` when the company has none |

A row is `{symbol, name, edition_id, created_at, lang, headline, on_board,
stale}`. A company with no paper is **a row of nulls rather than an absence**,
because "not written yet" is a page the pager draws — skipping it would be a
company the owner watches and the app never mentions. `headline` is the lead
story's, which is the **lowest-ranked** story and not `stories[0]`: the wire
carries a rank and nothing about order.

**All four are behind a token.** The device plane is three paths and none of
these is one of them — a per-edition read that leaked onto it would put every
paper the desk holds, including companies the board never prints, behind no
credential at all. `/api/papers/<SYMBOL>/publish` is `operator` for `promote`'s
own reason, and it ignores every schedule gate for `promote`'s own reason: the
owner asked for it by hand. The next scheduled wake's edition publishes over it
in the ordinary way.

**The board never learns that papers exist.** It polls `/news.json` and prints
whatever is `current`. Nothing on the wire it reads moved.
```

Also update the `## The settings` section's own JSON block and its opening
line, which says "Today there is exactly one" — it is now two, and the second
is `paper_refresh_hours` with a pointer to the section above.

- [ ] **Step 4: Write the phone's document**

In `docs/app-control.md`, in "The desk from the phone", after the four-row
table of queue routes, add:

```markdown
**The phone also pages through the papers, and that is new.** The desk keeps
one newspaper per company on the watchlist beside the single edition on the
glass, and the app reads them through four more routes on the same token it
already has. Three are `producer`; only the publish is `operator`, exactly as
`/api/publish` is.

| Method | Path | Body | What the phone does with it |
|---|---|---|---|
| GET | `/api/papers` | — | the pager's whole model: one row per company, in watchlist order |
| GET | `/api/editions/<eid>/news.json` | — | one paper's payload, ETag-conditional, cached per edition id |
| GET | `/api/editions/<eid>/tiles/<id>.bin` | — | that paper's tiles |
| POST | `/api/papers/<SYMBOL>/publish` | — | put that company's paper on the glass |

Four things a client has to get right:

- **A row of nulls is a page, not an error.** `{symbol, name, edition_id: null,
  created_at: null, lang: null, headline: null, on_board: false, stale: true}`
  is a company the desk watches and has not written about yet. The pager draws
  it as "not written yet" rather than skipping it.
- **`/api/editions/<eid>/news.json` is byte-identical to what `/news.json`
  would serve** if that edition were current — the `policy` block is spliced in
  the same way. So the Today reader parses one shape whichever route fed it,
  and a second parser on the phone is never needed.
- **An edition id is a content fingerprint**, so a payload cached under one can
  never go stale and the cache needs no expiry. What does change is *which* id
  a company's paper is, and that comes from `/api/papers`.
- **`404 no_paper` on the publish is a state, not a failure** — that company has
  no edition yet — and a retry does not fix it. It joins the three 404s above
  that `desk.ts` answers `null` for rather than throwing.

The routes above are read at `producer` scope, which the app's stored token may
or may not have: a `producer` token pages through papers and cannot publish
one, and gets a 403 on the last row with the sentence saying so.
```

- [ ] **Step 5: Check the documents against the code**

Run: `grep -n "paper" server/claudepost/http.py | grep -i "route\|api/papers"`
and read the `_ROUTES` table. Every path, method and scope written into either
document must appear there with the same spelling. Correct the document, never
the table — `_ROUTES` is where the split is actually decided, and
`docs/app-control.md` already says it is what to read when the two disagree.

- [ ] **Step 6: Run the full suite one last time**

Run: `sh server/test/run.sh`
Expected: PASS, every module.

- [ ] **Step 7: Commit**

```bash
git add docs/desk-server.md docs/app-control.md server/claudepost/http.py
git commit -m "$(cat <<'EOF'
docs(desk): the paper kind, the commit target, the rotation and the four routes

Plus the one line the feature left behind: the settings audit named `lang` by
hand and was a field behind the moment a second was added. It records the
normalised document now, which parse_settings already guarantees the shape of.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Pxz7nt2DE47CnaMzY4kvNJ
EOF
)"
```

---

## Self-review

**Spec coverage.** Every subsection of §3 and the server row of §8 has a task:
§3.1 edition meta → Task 3; §3.2 the index and prune → Task 4; §3.3 the kind
and the column → Tasks 1 and 6; §3.4 commit targets → Tasks 5 and 6; §3.5
rotation → Task 8; §3.6 the setting → Task 2; §3.7 the four routes → Task 7;
§3.8 the lease → Task 9.
§8's server list maps line for line: meta gains the two fields and is filled
lazily (Task 3), `papers()` picks the newest per symbol (Task 4), prune
protects the newest per watchlist symbol (Task 4), a paper commit writes
neither pointer and refuses a subject mismatch (Task 5), the fingerprint gate
compares per symbol (Task 5), rotation's four rules (Task 8), the setting's
range (Task 2), the four routes and their scopes (Task 7). The documents §2
names — `docs/desk-server.md` and `docs/app-control.md` — are Task 10.

**Out of scope, deliberately.** §4 (the worker: `agent/loop.py`,
`agent/prompt.py`, `tools/edition/PROMPT.md`) and §5 (the app) are other plans
written in parallel against the Global Constraints above. §6's failure table is
behaviour these tasks produce rather than code of its own, and every row of it
is covered by a test named in Tasks 5, 7 and 8.

**Type consistency.** `target`/`symbol` are spelled the same in
`EditionStore.commit`, `_commit`, `h_commit` and the commit body.
`papers(symbols)` returns `dict[str, dict | None]` in Task 4 and is consumed
that way in Tasks 5, 7 and 8. `prune(keep=None, symbols=())` is defined in Task
4 and called with `symbols=` in Task 8. `Desk.printable_symbols`,
`Desk.paper_cadence_seconds` and `Desk.papers` are defined in Task 7 and used
in Task 8. `PAPER_ORDER` is defined in Task 7 and formatted in Task 8 —
deliberately, so the constant exists before the only thing that reads it.
`EditionStore.headline` is defined in Task 3 and called in Task 7.
`_subject_symbol` is defined in Task 3 and called in Tasks 3, 4 and 5.
`COMMIT_TARGETS`/`TARGET_BOARD` are defined in Task 5 and imported by Task 6.
`LEASE_SECONDS` is read as `S.LEASE_SECONDS` by every existing test, so Task
9's change of its value moves them with it and adds no second spelling of the
number.

**Task 9 sits after Task 8, not before it.** The lease is a one-line change and
could go anywhere, but one of its tests is a rotation test — a claim an hour
old must not read as an idle worker — and that test needs the rotation to
exist. Running it before Task 8 would mean writing a test for code no task has
introduced yet.

**Line numbers drift; names do not.** Every `file:line` in this plan was read
off the branch as it stood when the plan was written. Before editing at one,
`grep` for the name beside it — `_COMMAND_COLUMNS`, `_ADDED_COLUMNS`,
`_schedule_gate`, `h_list_editions`, `_ROUTES` — and edit what the grep finds.

**One judgment the plan makes that the spec did not.** The spec says a paper
row carries the lead story's `headline`, and `meta.json` is specified to gain
only `symbol` and `lang`. So the headline is read off the stored payload rather
than recorded, and `EditionStore` keeps a small per-edition cache of
`(symbol, lang, headline)` to keep that from costing a 300 KB read per row per
request. An edition directory is immutable, so the cache cannot go stale; it is
keyed by edition id and `prune` drops an entry with the directory.
