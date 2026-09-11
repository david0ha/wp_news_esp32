# Ask the desk — the desk half — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the desk everything the phone and the worker need for a message
and its answer — an `ask` command kind carrying `reply_to` and `lang`, a
one-command read route, and one push when the answer lands.

**Architecture:** Three layers, each already present in some form. The queue
row gains two nullable columns and a fifth kind, validated in
`Store.add_command` where every other queue rule lives. `GET
/api/commands/<cid>` joins the existing `/api/commands/<cid>` route entry
beside its `DELETE`. The push reuses the alert path's delivery ledger, its
quiet-hours arithmetic and its Expo transport, with `"cmd:"+cid` as the ledger's
event id — so a restart cannot send an answer notification twice, and a quiet
window defers it rather than dropping it.

**Tech Stack:** Python 3.11+ standard library only. `sqlite3`, `unittest`,
`http.server`. No dependencies are added.

**Spec:** [`docs/superpowers/specs/2026-09-10-ask-the-desk-design.md`](../specs/2026-09-10-ask-the-desk-design.md)
— this plan implements **section 2 (Desk)** and the `Server` row of section 5.
Sections 3 (worker) and 4 (app) are planned separately; the wire between them
and this plan — the routes, the JSON shapes, the `result` vocabulary
`answered` / `revised <eid>` / `staged <eid>`, and the push's
`data: {command_id, result}` — is fixed by the spec and must not be
renegotiated here.

## Global Constraints

- `MAX_COMMAND_TEXT` stays **2000**. A phone message is short; do not raise it.
- `reply_to` is a command id validated against `COMMAND_ID_RE`
  (`^[0-9a-f]{8,64}\Z`) **and required to exist**.
- `lang` is `en` or `ko` — `claudepost.settings.LANGS`, imported, never a second
  spelling of the tuple. `NULL` means "the language of the message itself".
- `result` for an `ask` is one of `answered`, `revised <edition_id>`,
  `staged <edition_id>`, or on failure the worker's own message. **The desk
  never parses it** beyond taking the first word for the push payload.
- The answer push is `title: "Claude Post"`, body `"답변이 도착했습니다"` or
  `"Your answer is ready"` by the command's `lang`,
  `data: {"command_id": cid, "result": <first word of result>}`.
- The ledger key for an answer is `(token, "cmd:" + cid, "0")`.
- Only a command whose `source` is `"app"` rings anybody.
- The desk's own tests are the only verification here:
  `sh server/test/run.sh` from the repository root. Single module:
  `sh server/test/run.sh -k <word>` (the `-k` pattern is matched against the
  whole test id, so `-k answers` selects `test_answers.py`).
- Nothing personal goes in a fixture. Push tokens in tests come from
  `server/test/test_push.py`'s obviously-invented `TOKEN_A` / `TOKEN_B`.
- Never commit `sdkconfig`; nothing in this plan touches the firmware.

---

## File Structure

**Modified:**

| file | what changes |
|---|---|
| `server/claudepost/store.py` | `COMMAND_ID_RE` moves here; `ask` in `COMMAND_KINDS`; `reply_to` / `lang` columns, the schema, the `_migrate()` path, `_COMMAND_COLUMNS`, `add_command`'s two new arguments and their validation; `finished_since()` |
| `server/claudepost/app.py` | re-export `COMMAND_ID_RE`; `PHONE_SOURCE`; `ANSWER_WINDOW_SECONDS`; `Desk.enqueue`'s two new arguments; `Desk.command(cid)`; `Desk.finish()`; `_send_answer()`; `_fire_owed_answers()` / `_send_owed_answers()` on the housekeeping pass |
| `server/claudepost/http.py` | `h_enqueue` reads `reply_to` and `lang`; new `h_get_command`; `h_finish` calls `Desk.finish`; one route-table entry gains `GET` |
| `server/claudepost/push.py` | `ANSWER`, `LEAD_KINDS`, `KINDS`, `_OWN_SWITCH`, `pref_for`, `_lead`'s key set; `ANSWER_LEAD`, `answer_event_id()`, `ANSWER_TITLE`, `ANSWER_BODY`, `answer_message()` |
| `server/claudepost/alerts.py` | `_quiet_release` becomes public `quiet_release`; `defer_for_quiet` delegates to it |
| `server/test/test_store.py` | the kind, the columns, the migration, the validation |
| `server/test/test_http.py` | the `POST` round-trip and the `GET` route |
| `server/test/test_push.py` | `SPEC_DEVICE` gains the `answer` switch; the three `KINDS` tests |
| `docs/desk-server.md` | the `ask` kind, the two columns, the one-command read, the answer push |
| `docs/app-control.md` | one row for `GET /api/commands/<id>` |
| `server/README.md` | the queue's route line gains the read |

**Created:**

| file | responsibility |
|---|---|
| `server/test/test_answers.py` | the answer push: who gets one, once, in which language, and what a quiet window does to it |

---

## Task 1: The queue learns about `ask`, `reply_to` and `lang`

**Files:**
- Modify: `server/claudepost/store.py`
- Modify: `server/claudepost/app.py:41` (the `COMMAND_ID_RE` definition)
- Test: `server/test/test_store.py`

**Interfaces:**
- Consumes: nothing from an earlier task.
- Produces:
  - `claudepost.store.COMMAND_ID_RE: re.Pattern` — moved here from `app.py`,
    which re-exports it so `from .app import COMMAND_ID_RE` in `http.py` keeps
    working.
  - `claudepost.store.COMMAND_KINDS` now `("file_edition", "research",
    "custom", "calendar", "ask")`.
  - `Store.add_command(kind: str, text: str, priority: int = 5, deadline_at:
    float | None = None, source: str = "", reply_to: str | None = None, lang:
    str | None = None) -> dict` — the returned row carries `reply_to` and
    `lang`, both `None` when unset.

- [ ] **Step 1: Write the failing tests**

Add to `server/test/test_store.py`, after `SchemaTest`:

```python
class AskTest(StoreTestCase):
    """The kind the phone files, and the two columns that make it a thread."""

    def ask(self, text="왜 그 회사예요?", **kw):
        return self.store.add_command("ask", text, **kw)

    def test_ask_is_a_kind_the_queue_takes(self):
        row = self.ask()
        self.assertEqual(row["kind"], "ask")
        self.assertEqual(row["status"], "pending")
        self.assertIsNone(row["reply_to"])
        self.assertIsNone(row["lang"])

    def test_both_columns_round_trip_through_the_database(self):
        first = self.ask(lang="ko", source="app")
        second = self.ask("그럼 실적은요?", reply_to=first["id"], lang="ko")

        back = self.store.get_command(second["id"])
        self.assertEqual(back["reply_to"], first["id"])
        self.assertEqual(back["lang"], "ko")
        self.assertEqual(self.store.get_command(first["id"])["reply_to"], None)

    def test_a_reply_to_that_names_nothing_is_refused(self):
        # The worker will fetch that row and put the earlier turn in front of
        # the model. An id naming nothing is a thread silently missing a turn.
        with self.assertRaises(BadRequest) as caught:
            self.ask(reply_to="0" * 32)
        self.assertIn("reply to", caught.exception.message)

    def test_a_reply_to_that_is_not_an_id_at_all_is_refused(self):
        for bad in ("../etc/passwd", "NOT-HEX", "abc", 17):
            with self.subTest(reply_to=bad):
                with self.assertRaises(BadRequest):
                    self.ask(reply_to=bad)

    def test_lang_is_a_language_the_board_can_print(self):
        self.assertEqual(self.ask(lang="en")["lang"], "en")
        with self.assertRaises(BadRequest) as caught:
            self.ask(lang="ja")
        self.assertIn("en, ko", caught.exception.message)

    def test_the_four_older_kinds_still_work_and_carry_the_columns(self):
        row = self.file_edition()
        self.assertIsNone(row["reply_to"])
        self.assertIsNone(row["lang"])
        self.assertEqual(self.store.get_command(row["id"])["kind"],
                         "file_edition")


class MigrationTest(unittest.TestCase):
    """A desk that has been running since August opens the new schema.

    The old table is written out by hand rather than made by dropping columns
    from the new one: `ALTER TABLE ... DROP COLUMN` needs SQLite 3.35, and a
    test whose subject is "what happens on an old database" should not itself
    require a new library.
    """

    #: `commands` exactly as it stood before this feature -- the shape a desk
    #: deployed in August still has on disk.
    OLD = """
    CREATE TABLE commands (
        id          TEXT PRIMARY KEY,
        kind        TEXT    NOT NULL,
        text        TEXT    NOT NULL,
        priority    INTEGER NOT NULL,
        status      TEXT    NOT NULL,
        source      TEXT    NOT NULL DEFAULT '',
        created_at  REAL    NOT NULL,
        deadline_at REAL,
        claimed_by  TEXT,
        claimed_at  REAL,
        finished_at REAL,
        attempts    INTEGER NOT NULL DEFAULT 0,
        result      TEXT    NOT NULL DEFAULT ''
    );
    """

    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.path = os.path.join(self.dir.name, "desk.sqlite")

    def test_the_columns_are_added_to_a_database_that_predates_them(self):
        # The failure this prevents is not a startup error, which somebody
        # would notice. It is `no such column: reply_to` on the first message
        # sent from the phone, weeks after the deploy.
        old = sqlite3.connect(self.path)
        old.executescript(self.OLD)
        old.execute("INSERT INTO commands (id, kind, text, priority, status, "
                    "created_at) VALUES ('a' * 32, 'custom', 'old', 5, "
                    "'pending', ?)", (T0,))
        old.commit()
        old.close()

        store = Store(self.path, FixedClock(T0))
        self.addCleanup(store.close)
        # The row that was already there survives, without the new fields set.
        self.assertIsNone(store.get_command("a" * 32)["reply_to"])
        row = store.add_command("ask", "다시 물어봐요", lang="ko")
        self.assertEqual(store.get_command(row["id"])["lang"], "ko")

    def test_opening_twice_adds_nothing_twice(self):
        first = Store(self.path, FixedClock(T0))
        self.addCleanup(first.close)
        second = Store(self.path, FixedClock(T0))
        self.addCleanup(second.close)
        names = [r["name"] for r
                 in second._db.execute("PRAGMA table_info(commands)")]
        self.assertEqual(names.count("reply_to"), 1)
        self.assertEqual(names.count("lang"), 1)
```

Add `import sqlite3` to that file's imports (it has `os`, `tempfile`,
`threading`, `unittest` today).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `sh server/test/run.sh -k Ask` and `sh server/test/run.sh -k Migration`
Expected: FAIL — `BadRequest: kind 'ask' is not one of ('file_edition',
'research', 'custom', 'calendar')`, and `TypeError: add_command() got an
unexpected keyword argument 'reply_to'`.

- [ ] **Step 3: Move `COMMAND_ID_RE` into `store.py`**

In `server/claudepost/store.py`, add `import re` beside the other imports and
put this above `COMMAND_KINDS`:

```python
#: The shape of a command id: the ids this table hands out, the `NoteStore` the
#: desk gives their notes to, and every `/api/commands/<cid>/...` route in
#: `http.py`. It lives here rather than in `app.py` because `add_command` has to
#: check a `reply_to` against it and `store` cannot import `app` -- `app`
#: imports `store`. `app.py` re-exports it, so the one spelling is still the
#: only spelling.
COMMAND_ID_RE = re.compile(r"^[0-9a-f]{8,64}\Z")
```

In `server/claudepost/app.py`, delete the `COMMAND_ID_RE = re.compile(...)` line
at :41 together with the comment block above it, and change the import at :34
from `from .store import Store` to:

```python
# `COMMAND_ID_RE` is imported rather than defined here, and re-exported by being
# imported: `http.py` says `from .app import COMMAND_ID_RE` and `Desk.notes` is
# built from it, so the route's pattern, the note store's and the queue's are one
# regex. It moved to `store` because `add_command` now checks a `reply_to`
# against it, and `store` cannot import `app` -- `app` imports `store`.
from .store import COMMAND_ID_RE, Store
```

Then delete `import re` from `app.py`: `grep -n "re\." server/claudepost/app.py`
shows line 41 was its only use, so leaving it is an unused import.

- [ ] **Step 4: Add the kind, the columns and the migration**

In `server/claudepost/store.py`:

```python
COMMAND_KINDS: tuple[str, ...] = ("file_edition", "research", "custom",
                                  "calendar", "ask")
```

Extend the comment above it with:

```
#: ``ask`` is the phone's own kind -- a message typed by the owner, answered by
#: the worker, and sometimes an instruction to rewrite the edition. It is a
#: kind rather than a `custom` with a convention because two things downstream
#: read it: the worker's prompt, and the finish path that decides whether
#: anybody's phone rings.
```

In `_SCHEMA`, the `commands` table's last two lines become:

```sql
    attempts    INTEGER NOT NULL DEFAULT 0,
    result      TEXT    NOT NULL DEFAULT '',
    -- The thread. `reply_to` is the previous turn's command id and `lang` is
    -- the language the phone was in when the message was typed; NULL there
    -- means "the language of the message itself", which only the model can
    -- read. Both nullable, which is also what makes them addable by ALTER
    -- TABLE below without rewriting a row.
    reply_to    TEXT,
    lang        TEXT
);
```

Below `_COMMAND_COLUMNS`, which becomes:

```python
_COMMAND_COLUMNS = ("id", "kind", "text", "priority", "status", "source",
                    "created_at", "deadline_at", "claimed_by", "claimed_at",
                    "finished_at", "attempts", "result", "reply_to", "lang")
```

add:

```python
#: Columns added to a table after this desk first shipped, as
#: ``(table, column, declaration)``.
#:
#: ``CREATE TABLE IF NOT EXISTS`` does exactly nothing to a table that already
#: exists, so a column added to :data:`_SCHEMA` alone reaches a fresh database
#: and no other. The failure that causes is not a startup error, which somebody
#: would notice -- it is ``no such column: reply_to`` raised on the first
#: message sent from the phone, on a desk that has been serving since August.
#:
#: Every entry must be nullable and carry no default. That is what makes
#: ``ALTER TABLE ... ADD COLUMN`` a metadata-only write on SQLite rather than a
#: rewrite of every row in the table.
_ADDED_COLUMNS: tuple[tuple[str, str, str], ...] = (
    ("commands", "reply_to", "TEXT"),
    ("commands", "lang", "TEXT"),
)
```

In `Store.__init__`, immediately after `self._db.executescript(_SCHEMA)`:

```python
        self._migrate()
```

and add the method beside `close()`:

```python
    def _migrate(self) -> None:
        """Add the columns :data:`_SCHEMA` has gained since a database was made.

        Outside :meth:`_write` for ``executescript``'s reason: this runs in the
        constructor, before anything can be contending for the file, and each
        statement is guarded by its own read. Idempotent, so twenty processes
        opening the file at once is a race with no losing side -- a second
        ``ADD COLUMN`` for a column that now exists is simply not issued.
        """
        for table, column, decl in _ADDED_COLUMNS:
            have = {row["name"] for row in
                    self._db.execute("PRAGMA table_info(%s)" % table)}
            if column not in have:
                self._db.execute("ALTER TABLE %s ADD COLUMN %s %s"
                                 % (table, column, decl))
```

- [ ] **Step 5: Validate and store the two fields**

Still in `server/claudepost/store.py`, add the import:

```python
from .settings import LANGS
```

(`settings.py` imports only `errors` and `fsutil`, so there is no cycle. It is
imported rather than restated for :mod:`claudepost.push`'s reason for importing
`COMPUTED_KINDS`: the set is *the languages there is type on the board for*, and
a second spelling of it here would be a queue that accepts a language the paper
cannot be set in.)

Change `add_command`'s signature and body:

```python
    def add_command(self, kind: str, text: str, priority: int = 5,
                    deadline_at: float | None = None, source: str = "",
                    reply_to: str | None = None,
                    lang: str | None = None) -> dict:
```

and, after the `priority` check and before `now = self._clock.now()`:

```python
        reply_to = self._checked_reply_to(reply_to)
        lang = _checked_lang(lang)
```

and in the row dict, after `"result": ""`:

```python
               "reply_to": reply_to, "lang": lang}
```

Add the checker as a method (it reads the table, so it is not a free function):

```python
    def _checked_reply_to(self, reply_to: object) -> str | None:
        """The command this one answers, or ``None``.

        Checked for *existence* and not merely for shape, because the field's
        whole purpose is that a worker will fetch that row and put the earlier
        question and answer in front of the model. An id that names nothing is
        a thread the prompt would quietly lose a turn from, and the phone that
        sent it would never learn why.
        """
        if reply_to is None:
            return None
        if not isinstance(reply_to, str) or not COMMAND_ID_RE.match(reply_to):
            raise BadRequest(message="reply_to is a command id")
        with self._lock:
            row = self._db.execute("SELECT 1 FROM commands WHERE id = ?",
                                   (reply_to,)).fetchone()
        if row is None:
            raise BadRequest(message=f"no command {reply_to} to reply to")
        return reply_to
```

and the language check as a module-level function beside `_new_id`:

```python
def _checked_lang(lang: object) -> str | None:
    """A language the board can print, or ``None`` for "the message's own".

    ``None`` is a state rather than an omission: a typed message carries its
    own language, and this field only breaks a tie the model cannot -- a ticker
    on its own, say. So there is no default to fall back to here, which is the
    one way this differs from `settings`' own check.
    """
    if lang is None:
        return None
    if not isinstance(lang, str) or lang not in LANGS:
        raise BadRequest(message=f"lang: must be one of: {', '.join(LANGS)}")
    return lang
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `sh server/test/run.sh -k Ask` then `sh server/test/run.sh -k Migration`
Expected: PASS.

- [ ] **Step 7: Run the whole desk suite**

Run: `sh server/test/run.sh`
Expected: PASS — every module. `test_http.py` exercises `COMMAND_ID_RE` through
the route table, which is what proves the move did not break the import.

- [ ] **Step 8: Commit**

```bash
git add server/claudepost/store.py server/claudepost/app.py server/test/test_store.py
git commit -m "$(cat <<'EOF'
feat(desk): a fifth kind, and the two columns that make it a thread

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Pxz7nt2DE47CnaMzY4kvNJ
EOF
)"
```

---

## Task 2: `POST /api/commands` carries the thread

**Files:**
- Modify: `server/claudepost/app.py` (`Desk.enqueue`)
- Modify: `server/claudepost/http.py:605-616` (`h_enqueue`)
- Test: `server/test/test_http.py`

**Interfaces:**
- Consumes: `Store.add_command(..., reply_to=None, lang=None)` from Task 1.
- Produces:
  - `Desk.enqueue(kind, text, priority=5, deadline_at=None, source="api",
    reply_to=None, lang=None) -> dict`.
  - `POST /api/commands` accepts `{"kind": "ask", "text": …, "reply_to": …,
    "lang": …, "source": "app"}` and answers `{"ok": true, "command": {…}}`
    with both fields on the row.

- [ ] **Step 1: Write the failing test**

Add to `server/test/test_http.py`, in the class that already holds the queue
tests (the one defining `command_id_of_kind`):

```python
    def test_a_message_from_the_phone_round_trips_with_its_thread(self):
        status, doc = self.api("POST", "/api/commands",
                               {"kind": "ask", "text": "왜 그 회사예요?",
                                "lang": "ko", "source": "app"}, "producer")
        self.assertEqual(status, 200, doc)
        first = doc["command"]
        self.assertEqual(first["kind"], "ask")
        self.assertEqual(first["lang"], "ko")
        self.assertEqual(first["source"], "app")
        self.assertIsNone(first["reply_to"])

        status, doc = self.api("POST", "/api/commands",
                               {"kind": "ask", "text": "그럼 실적은요?",
                                "reply_to": first["id"], "lang": "ko",
                                "source": "app"}, "producer")
        self.assertEqual(status, 200, doc)
        self.assertEqual(doc["command"]["reply_to"], first["id"])

        # And the queue's own list carries them, because `/api/commands` is
        # `SELECT *` and the app reads a thread's status from it.
        self.assertEqual(self.command(doc["command"]["id"])["reply_to"],
                         first["id"])

    def test_a_reply_to_nothing_and_an_unprintable_language_are_refused(self):
        status, doc = self.api("POST", "/api/commands",
                               {"kind": "ask", "text": "hello",
                                "reply_to": "0" * 32}, "producer")
        self.assertEqual(status, 400, doc)
        self.assertEqual(doc["error"], "bad_request")

        status, doc = self.api("POST", "/api/commands",
                               {"kind": "ask", "text": "hello",
                                "lang": "ja"}, "producer")
        self.assertEqual(status, 400, doc)

    def test_a_command_with_no_thread_still_carries_the_fields_as_null(self):
        status, doc = self.api("POST", "/api/commands",
                               {"text": "look at the tape"}, "producer")
        self.assertEqual(status, 200, doc)
        self.assertIsNone(doc["command"]["reply_to"])
        self.assertIsNone(doc["command"]["lang"])
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `sh server/test/run.sh -k round_trips_with_its_thread`
Expected: FAIL — `KeyError: 'reply_to'`, because `h_enqueue` never passes it and
`Desk.enqueue` has no such argument.

- [ ] **Step 3: Thread the two fields through the desk and the handler**

In `server/claudepost/app.py`:

```python
    def enqueue(self, kind: str, text: str, priority: int = 5,
                deadline_at: float | None = None, source: str = "api",
                reply_to: str | None = None,
                lang: str | None = None) -> dict:
        """Add a command and wake anything parked on a long poll."""
        command = self.store.add_command(kind, text, priority=priority,
                                         deadline_at=deadline_at, source=source,
                                         reply_to=reply_to, lang=lang)
        with self.queue_event:
            self.queue_event.notify_all()
        return command
```

In `server/claudepost/http.py`, `h_enqueue` becomes:

```python
    def h_enqueue(self, _match, _query) -> None:
        doc = self._json_body()
        text = doc.get("text")
        if not isinstance(text, str) or not text.strip():
            raise BadRequest(message="a command needs text")
        # `reply_to` and `lang` are passed through as they arrived, `None` and
        # all: `store.add_command` is where both are checked, so the shape a
        # `curl` can file and the shape the phone can file are one rule.
        command = self.desk.enqueue(
            doc.get("kind", "custom"), text,
            priority=_int_field(doc, "priority", 5, 0, 9),
            deadline_at=_epoch_field(doc, "deadline_at"),
            source=str(doc.get("source", "api"))[:64],
            reply_to=doc.get("reply_to"), lang=doc.get("lang"))
        self._send_json(200, {"ok": True, "command": command})
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `sh server/test/run.sh -k thread` then `sh server/test/run.sh -k refused`
Expected: PASS.

- [ ] **Step 5: Run the whole desk suite**

Run: `sh server/test/run.sh`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/claudepost/app.py server/claudepost/http.py server/test/test_http.py
git commit -m "$(cat <<'EOF'
feat(desk): the queue takes a message, and which turn it answers

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Pxz7nt2DE47CnaMzY4kvNJ
EOF
)"
```

---

## Task 3: `GET /api/commands/<cid>` — one thread, not the queue

**Files:**
- Modify: `server/claudepost/app.py` (`Desk.command`, beside `Desk.commands`)
- Modify: `server/claudepost/http.py` (new `h_get_command`, route table ~1251)
- Test: `server/test/test_http.py`

**Interfaces:**
- Consumes: `Desk.commands()`'s `has_notes` convention from the existing code.
- Produces:
  - `Desk.command(cid: str) -> dict | None` — one row with `has_notes`, or
    `None`.
  - `GET /api/commands/<cid>` — `producer` scope, `{"ok": true, "command":
    {…, "has_notes": bool}}`, `404` for an unknown id.

- [ ] **Step 1: Write the failing test**

Add to the same queue test class in `server/test/test_http.py`:

```python
    def test_one_command_is_readable_without_listing_the_queue(self):
        # The phone polls one thread while it is open. Making it fetch the
        # whole queue to find one row would put every other instruction the
        # desk holds on a phone that asked about its own message.
        status, doc = self.api("POST", "/api/commands",
                               {"kind": "ask", "text": "왜 그 회사예요?",
                                "lang": "ko", "source": "app"}, "producer")
        cid = doc["command"]["id"]

        status, doc = self.api("GET", "/api/commands/" + cid, None, "producer")
        self.assertEqual(status, 200, doc)
        self.assertEqual(doc["command"]["id"], cid)
        self.assertEqual(doc["command"]["lang"], "ko")
        self.assertFalse(doc["command"]["has_notes"])

    def test_the_one_command_read_reports_a_note_the_way_the_list_does(self):
        status, doc = self.api("POST", "/api/commands",
                               {"kind": "ask", "text": "hello",
                                "source": "app"}, "producer")
        cid = doc["command"]["id"]
        self.assertIsNotNone(self.desk.store.claim_command("w"))

        status, _, _ = self.call("PUT", "/api/commands/%s/notes.md" % cid,
                                 b"# the answer\n", self.tokens["producer"],
                                 "text/markdown")
        self.assertEqual(status, 200)

        _, doc = self.api("GET", "/api/commands/" + cid, None, "producer")
        self.assertTrue(doc["command"]["has_notes"])

    def test_an_unknown_command_is_a_404(self):
        status, doc = self.api("GET", "/api/commands/" + "a" * 32,
                               None, "producer")
        self.assertEqual(status, 404, doc)

    def test_the_one_command_read_is_producer_scope(self):
        status, doc = self.api("POST", "/api/commands",
                               {"text": "look at the tape"}, "producer")
        cid = doc["command"]["id"]
        # An operator token is strictly stronger and must also work; the point
        # of the row is that the worker's own token is enough.
        for scope in ("producer", "operator"):
            with self.subTest(scope=scope):
                status, _ = self.api("GET", "/api/commands/" + cid, None, scope)
                self.assertEqual(status, 200)
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `sh server/test/run.sh -k without_listing_the_queue`
Expected: FAIL with `405` (the route exists for `DELETE` only), asserted as
`self.assertEqual(status, 200, doc)` receiving 405.

- [ ] **Step 3: Add `Desk.command`**

In `server/claudepost/app.py`, directly beneath `Desk.commands`:

```python
    def command(self, cid: str) -> dict | None:
        """One command, carrying whether it has a note attached, or ``None``.

        :meth:`commands`' answer for one row, and it exists rather than being
        left to the caller for that method's reason: `has_notes` is decided in
        one place, so the queue's list, `state()`'s `queue.recent` and the
        phone's poll of a single thread cannot answer the question three ways.
        """
        row = self.store.get_command(cid)
        if row is None:
            return None
        row["has_notes"] = self.notes.has(cid)
        return row
```

- [ ] **Step 4: Add the handler and the route**

In `server/claudepost/http.py`, beside `h_list_commands`:

```python
    def h_get_command(self, match, _query) -> None:
        """One command by id -- the phone's poll of an open thread.

        The queue's list would answer this too, and does not: a phone asking
        after its own message would be handed every other instruction the desk
        is holding, which is a list of what the operator has asked for lately.
        """
        command = self.desk.command(match.group("cid"))
        if command is None:
            raise NotFound(message="no command %s" % match.group("cid"))
        self._send_json(200, {"ok": True, "command": command})
```

and in `_ROUTES` change the one-command entry to:

```python
    (re.compile(r"^/api/commands/(?P<cid>%s)\Z" % _CID), {
        "GET": ("producer", DeskHTTPRequestHandler.h_get_command),
        "DELETE": ("operator", DeskHTTPRequestHandler.h_cancel)}),
```

(`NotFound` is already on `http.py`'s `from .errors import` line at :58 — no
import change is needed.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `sh server/test/run.sh -k command`
Expected: PASS.

- [ ] **Step 6: Run the whole desk suite**

Run: `sh server/test/run.sh`
Expected: PASS. `DevicePlaneTest` in particular — it asserts that nothing but
the edition and its tiles is reachable without a token, and a new `GET` route is
exactly the kind of thing that test exists to catch.

- [ ] **Step 7: Commit**

```bash
git add server/claudepost/app.py server/claudepost/http.py server/test/test_http.py
git commit -m "$(cat <<'EOF'
feat(desk): read one thread without reading the queue

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Pxz7nt2DE47CnaMzY4kvNJ
EOF
)"
```

---

## Task 4: The phone rings when its answer lands

**Files:**
- Modify: `server/claudepost/push.py:130-160` (the kinds), `:400-413` (`_lead`),
  and the end of the module (the answer's copy)
- Modify: `server/claudepost/alerts.py:166` (`_quiet_release` → `quiet_release`)
- Modify: `server/claudepost/app.py` (`PHONE_SOURCE`, `ANSWER_WINDOW_SECONDS`,
  `Desk.finish`, `Desk._send_answer`)
- Modify: `server/claudepost/http.py:642-648` (`h_finish`)
- Modify: `server/test/test_push.py:57-70` and `:133-172`
- Create: `server/test/test_answers.py`

**Interfaces:**
- Consumes: `Desk.command`/`Desk.commands` conventions; the `ask` kind, the
  `lang` column and `source` from Tasks 1–2.
- Produces:
  - `push.ANSWER: str` = `"answer"`; `push.LEAD_KINDS: tuple[str, ...]` (the
    alert kinds); `push.KINDS = LEAD_KINDS + (ANSWER,)`;
    `push.pref_for("answer") == "answer"`.
  - `push.ANSWER_LEAD: str` = `"0"`; `push.answer_event_id(cid: str) -> str`
    returning `"cmd:" + cid`.
  - `push.answer_message(token: str, cid: str, status: str, result: str,
    lang: str | None) -> dict`.
  - `alerts.quiet_release(device: Mapping, when: float) -> float | None`
    (public; `defer_for_quiet` unchanged in behaviour).
  - `app.PHONE_SOURCE: str` = `"app"`; `app.ANSWER_WINDOW_SECONDS: int`.
  - `Desk.finish(cid: str, status: str, result: str = "") -> dict`.
  - `Desk._send_answer(command: Mapping, t: float) -> int`.

- [ ] **Step 1: Write the failing tests for the switch**

In `server/test/test_push.py`, change `SPEC_DEVICE`'s `prefs` to add the switch
(the `lead` map is deliberately left alone):

```python
    "prefs": {"earnings": True, "expiry": True, "dividend": True,
              "econ": True, "researched": True, "answer": True},
```

and change the three tests that enumerate the kinds:

```python
    def test_every_kind_the_book_can_carry_answers_to_some_switch(self):
        """The rule, stated the way round it has to be applied: a kind with no
        switch is a kind the owner cannot turn off -- AND a kind that can never
        fire. An earlier draft made the switch set the four computed kinds
        alone, which left the book's other four with neither.

        Six switches now, not five: `answer` is the first push that is not
        about a dated event, and it gets a switch for the same reason. It is
        deliberately *not* in `LEAD_KINDS`, because a lead is "how long before
        the date" and an answer has no date -- it happens when it happens.
        """
        self.assertEqual(set(P.KINDS),
                         set(COMPUTED_KINDS) | {P.RESEARCHED, P.ANSWER})
        self.assertEqual(set(P.LEAD_KINDS), set(COMPUTED_KINDS) | {P.RESEARCHED})
        self.assertEqual(set(P.DEFAULT_LEAD), set(P.LEAD_KINDS))
        out = P.parse_devices(doc(device()))
        self.assertEqual(set(out["devices"][0]["prefs"]), set(P.KINDS))
        self.assertEqual(set(out["devices"][0]["lead"]), set(P.LEAD_KINDS))

        # And every kind the book may carry lands on one of them.
        for kind in CALENDAR_KINDS:
            with self.subTest(kind=kind):
                self.assertIn(P.pref_for(kind), P.KINDS)

    def test_the_answer_keeps_its_own_switch(self):
        self.assertEqual(P.pref_for(P.ANSWER), P.ANSWER)

    def test_an_absent_switch_is_on(self):
        out = P.parse_devices(doc(device(prefs={"econ": False})))
        self.assertEqual(out["devices"][0]["prefs"],
                         {"earnings": True, "expiry": True, "dividend": True,
                          "econ": False, P.RESEARCHED: True, P.ANSWER: True})

    def test_a_lead_for_the_answer_is_not_a_field(self):
        """A lead names how long before a date to say something, and an answer
        has no date. Accepting one would store a number nothing can read."""
        with self.assertRaises(BadRequest) as caught:
            P.parse_devices(doc(device(lead={P.ANSWER: ["P1D"]})))
        self.assertIn("lead", caught.exception.message)
```

- [ ] **Step 2: Run them to verify they fail**

Run: `sh server/test/run.sh -k push`
Expected: FAIL — `AttributeError: module 'claudepost.push' has no attribute
'ANSWER'`.

- [ ] **Step 3: Add the kind to `push.py`**

Replace the `RESEARCHED` / `KINDS` / `pref_for` block:

```python
RESEARCHED = "researched"

#: The one push that is not about the event book. It is in :data:`KINDS`
#: because of the rule this module already states -- a kind with no switch is a
#: kind the owner cannot turn off -- and it is deliberately **not** in
#: :data:`LEAD_KINDS`, because a lead is "how long before the date to say this"
#: and an answer has no date. It happens when the worker finishes.
ANSWER = "answer"

#: The kinds a *lead* is meaningful for: the alerts, every one of them about a
#: dated event. :data:`DEFAULT_LEAD` is keyed by these and so is a stored
#: device's ``lead`` map.
LEAD_KINDS: tuple[str, ...] = tuple(sorted(COMPUTED_KINDS)) + (RESEARCHED,)

#: Every switch the owner has: the alert kinds, plus :data:`ANSWER`.
KINDS: tuple[str, ...] = LEAD_KINDS + (ANSWER,)

#: The kinds that carry a switch of their own. The four computed ones and the
#: answer; everything else in the book shares :data:`RESEARCHED`.
_OWN_SWITCH = frozenset(COMPUTED_KINDS) | {ANSWER}


def pref_for(kind: str) -> str:
    """Which switch a notification of ``kind`` answers to.

    One function so `alerts.py`, `app.py` and any future caller cannot disagree
    about where a `corporate` event's preference lives.
    """
    return kind if kind in _OWN_SWITCH else RESEARCHED
```

Beside `_KIND_KEYS = frozenset(KINDS)` add:

```python
_LEAD_KEYS = frozenset(LEAD_KINDS)
```

and change `_lead` to use them:

```python
def _lead(value: object, path: str) -> dict:
    """How far ahead each *dated* kind is announced.

    An omitted kind takes :data:`DEFAULT_LEAD`; a kind named with an empty list
    takes nothing. The two are different on purpose -- see the module
    docstring -- and this is the one place in the document where absence and
    emptiness do not mean the same thing.

    :data:`LEAD_KINDS` rather than :data:`KINDS`, so ``answer`` is refused here
    as an unknown key: a lead for a notification with no date is a number
    nothing downstream could read.
    """
    doc = {} if value is None else _obj(value, path)
    _no_extra_keys(doc, _LEAD_KEYS, path)
    return {kind: (list(DEFAULT_LEAD[kind]) if doc.get(kind) is None
                   else _leads(doc[kind], path, kind))
            for kind in LEAD_KINDS}
```

- [ ] **Step 4: Run the push tests to verify they pass**

Run: `sh server/test/run.sh -k push`
Expected: PASS.

- [ ] **Step 5: Write the failing tests for the answer push**

Create `server/test/test_answers.py`:

```python
"""The push that is not about the event book: an answer to a typed message.

Everything here steps over an instant rather than waiting for one, the same way
``test_alerts.py`` does and for the same reason -- the interesting moment is
07:00 in Seoul, and a test that waited for it would run once a day.

Nothing here is a real push token. They come from ``test_push``, obviously
invented, because a token is a capability to write on somebody's lock screen
and this repository is public.
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import tempfile
import unittest

from claudepost import push as P
from claudepost.app import (ANSWER_WINDOW_SECONDS, HOUSEKEEPING_SECONDS,
                            PHONE_SOURCE, Config, Desk)
from claudepost.clock import FixedClock
from claudepost.gates import StubGates

from test_alerts import SEOUL_NIGHT, dev, ts
from test_push import FakeExpo, TOKEN_A, TOKEN_B

# The desk warns when a push does not leave, which two cases here provoke on
# purpose. Without a handler that goes to stderr and a passing run reads like a
# failing one.
logging.getLogger("claudepost.app").addHandler(logging.NullHandler())

#: A Wednesday afternoon in Seoul -- 15:00 KST, nowhere near a quiet window and
#: nowhere near one of the default schedule's wakes, so a tick that also
#: enqueued a filing cannot make an assertion here read around it.
START = ts("2026-11-04T06:00:00Z")


class AnswerTestCase(unittest.TestCase):
    """A desk on a temporary root, wired to a fake Expo."""

    def setUp(self):
        self.root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.root, True)
        self.data = os.path.join(self.root, "data")
        os.makedirs(self.data)

        self.clock = FixedClock(START)
        self.desk = self.a_desk()
        self.expo = self.desk.push_fetch

    def a_desk(self) -> Desk:
        cfg = Config(data_dir=self.data,
                     tokens_path=os.path.join(self.root, "tokens.json"),
                     repo_dir=self.root, host="127.0.0.1", port=0)
        desk = Desk(cfg, clock=self.clock, gates=StubGates(sheets=()))
        self.addCleanup(desk.close)
        desk.push_fetch = FakeExpo()
        return desk

    def given(self, *devices):
        self.desk.set_push_devices(P.parse_devices(
            {"devices": list(devices or (dev(),))}))

    def asked(self, text="왜 그 회사예요?", source=PHONE_SOURCE, **kw) -> str:
        """One message on the queue, claimed, ready to be finished."""
        cid = self.desk.enqueue("ask", text, source=source, **kw)["id"]
        self.desk.store.claim_command("w")
        return cid

    def sent(self, expo=None) -> list[dict]:
        out = []
        for call in (expo or self.expo).calls:
            out.extend(json.loads(call["body"]))
        return out


class AnswerPushTest(AnswerTestCase):

    def test_a_finished_message_from_the_phone_rings_the_phone(self):
        self.given()
        cid = self.asked(lang="ko")
        self.desk.finish(cid, "done", "answered")

        [message] = self.sent()
        self.assertEqual(message["to"], TOKEN_A)
        self.assertEqual(message["title"], "Claude Post")
        self.assertEqual(message["body"], "답변이 도착했습니다")
        self.assertEqual(message["data"],
                         {"command_id": cid, "result": "answered"})

    def test_the_language_is_the_one_the_phone_was_in(self):
        self.given()
        cid = self.asked(lang="en", text="why this company?")
        self.desk.finish(cid, "done", "answered")
        self.assertEqual(self.sent()[0]["body"], "Your answer is ready")

    def test_a_message_with_no_language_falls_back_to_the_desk_s_own(self):
        # NULL means "the language of the message itself", which the desk
        # cannot read. Its own setting is the best proxy it has, and it is
        # already the language the paper is written in.
        self.desk.set_settings({"lang": "ko"})
        self.given()
        cid = self.asked()
        self.desk.finish(cid, "done", "answered")
        self.assertEqual(self.sent()[0]["body"], "답변이 도착했습니다")

    def test_a_revision_carries_only_the_first_word(self):
        """The desk does not parse `result`; it forwards enough for the phone
        to know which screen to open and re-reads the row for the rest."""
        self.given()
        cid = self.asked(lang="en")
        self.desk.finish(cid, "done", "revised 3f2a91bb")
        self.assertEqual(self.sent()[0]["data"]["result"], "revised")

    def test_a_failure_says_so_rather_than_promising_an_answer(self):
        self.given()
        cid = self.asked(lang="en")
        self.desk.finish(cid, "failed", "no answer written")
        self.assertEqual(self.sent()[0]["body"],
                         "The desk could not answer that")

    def test_nothing_rings_for_a_command_the_phone_did_not_file(self):
        self.given()
        for source in ("api", "schedule", ""):
            with self.subTest(source=source):
                cid = self.asked(source=source)
                self.desk.finish(cid, "done", "answered")
        self.assertEqual(self.expo.calls, [])

    def test_a_phone_that_turned_the_switch_off_is_not_told(self):
        self.given(dev(prefs={P.ANSWER: False}))
        cid = self.asked()
        self.desk.finish(cid, "done", "answered")
        self.assertEqual(self.expo.calls, [])

    def test_every_registered_phone_is_told_once(self):
        self.given(dev(TOKEN_A), dev(TOKEN_B))
        cid = self.asked()
        self.desk.finish(cid, "done", "answered")
        self.assertEqual(sorted(m["to"] for m in self.sent()),
                         sorted([TOKEN_A, TOKEN_B]))

    def test_the_delivery_is_recorded_against_the_ledger(self):
        self.given()
        cid = self.asked()
        self.desk.finish(cid, "done", "answered")

        rows = self.desk.store.deliveries_since(0)
        self.assertEqual([(r["token"], r["event_id"], r["lead"]) for r in rows],
                         [(TOKEN_A, "cmd:" + cid, P.ANSWER_LEAD)])

    def test_the_ledger_key_cannot_collide_with_an_event(self):
        self.assertTrue(P.answer_event_id("abc123").startswith("cmd:"))

    def test_a_second_send_for_the_same_command_is_suppressed(self):
        self.given()
        cid = self.asked()
        self.desk.finish(cid, "done", "answered")
        self.desk._send_answer(self.desk.command(cid), self.clock.now())
        self.assertEqual(len(self.sent()), 1, self.sent())

    def test_a_push_that_will_not_leave_does_not_fail_the_worker_s_report(self):
        """`POST /done` is the worker's own call and its 200 is what stops the
        worker retrying. A phone that does not ring costs an answer somebody
        opens the app for; a `done` that 500s costs the whole command again."""
        self.desk.push_fetch = FakeExpo(fail=OSError("connection refused"))
        self.given()
        cid = self.asked()

        command = self.desk.finish(cid, "done", "answered")
        self.assertEqual(command["status"], "done")
        self.assertEqual(self.desk.store.deliveries_since(0), [])
```

- [ ] **Step 6: Run them to verify they fail**

Run: `sh server/test/run.sh -k answers`
Expected: FAIL — `ImportError: cannot import name 'ANSWER_WINDOW_SECONDS' from
'claudepost.app'`.

- [ ] **Step 7: Make the quiet-hours arithmetic public**

In `server/claudepost/alerts.py`, rename `_quiet_release` to `quiet_release`
(three call sites inside the module: `defer_for_quiet` at :223, and :366 and
:372 inside `due`) and extend its docstring's first paragraph:

```python
def quiet_release(device: Mapping, when: float) -> float | None:
    """The end of the quiet window containing ``when``, or ``None``.

    Public because it is not only the alert path's question any more: an answer
    to a typed message arrives whenever the worker finishes, which may be at
    three in the morning, and the desk holds it for the same window and by the
    same arithmetic. One function, so a phone cannot be quiet for one kind of
    notification and awake for another.
    """
```

- [ ] **Step 8: Add the answer's copy to `push.py`**

At the end of `server/claudepost/push.py`, after `prune_unregistered`:

```python
# --------------------------------------------------------------------------
# The answer
# --------------------------------------------------------------------------

#: The delivery ledger's ``lead`` for an answer. Every alert value in that
#: column is an ISO-8601 duration, and this deliberately is not one: an answer
#: has no lead, so ``"0"`` cannot collide with a real value and reads in the
#: table as what it is.
ANSWER_LEAD = "0"

#: What an answer's notification is titled. The app's own name rather than the
#: message's subject, because a lock screen already shows the app and the body
#: is the only line with room to say something.
ANSWER_TITLE = "Claude Post"

#: The two sentences an answer can carry, by language and by outcome. A failed
#: command gets its own sentence rather than the same one: a notification that
#: promised an answer and opens onto an error is a worse failure than the one
#: it is reporting. What went wrong is the command's `result`, which the phone
#: reads from the row -- this is only the knock at the door.
ANSWER_BODY: dict[str, dict[str, str]] = {
    "en": {"done": "Your answer is ready",
           "failed": "The desk could not answer that"},
    "ko": {"done": "답변이 도착했습니다",
           "failed": "답변을 만들지 못했어요"},
}


def answer_event_id(cid: str) -> str:
    """The delivery ledger's ``event_id`` for a command's answer.

    Prefixed, because the ledger's rows are keyed ``(token, event_id, lead)``
    and the event ids in the same table come from the owner's book. A command id
    and an event id have different shapes today and a prefix means the promise
    does not rest on that staying true.
    """
    return "cmd:" + cid


def answer_message(token: str, cid: str, status: str, result: str,
                   lang: str | None) -> dict:
    """The Expo message telling one phone its message has an answer.

    ``data`` carries the command id and the **first word** of ``result`` --
    `answered`, `revised`, `staged`, or whatever a failure's message begins
    with. The desk does not parse `result` and this is not it starting to: the
    first word is what tells the phone which screen to open, and it re-reads the
    row for everything else.

    An unknown or absent ``lang`` takes English. The caller resolves the
    fallback it wants before calling -- `Desk` uses the desk's own settings --
    so this is the last line of defence rather than the policy.
    """
    copy = ANSWER_BODY.get(lang or "", ANSWER_BODY["en"])
    words = (result or "").split()
    return {
        "to": token,
        "title": ANSWER_TITLE,
        "body": copy["done" if status == "done" else "failed"],
        "sound": "default",
        "data": {"command_id": cid, "result": words[0] if words else ""},
    }
```

- [ ] **Step 9: Add the finish path to `app.py`**

Beside `HOUSEKEEPING_SECONDS` in `server/claudepost/app.py`:

```python
#: The ``source`` a command carries when the phone filed it, and the only source
#: whose finish rings anybody. ``source`` is free text on every other path --
#: ``api``, ``schedule``, whatever a curl said -- so this is a convention rather
#: than an enum, and it is stated once here because the app writes it and the
#: finish path reads it. A typo in either is a notification that never arrives
#: and nothing anywhere that says why.
PHONE_SOURCE = "app"

#: How far back the answer pass looks, and how far back its ledger read goes.
#: Derived rather than chosen: the longest a quiet window can hold an answer is
#: a minute short of a day (`push._quiet` refuses a window with no width), and
#: the slack is for a desk that was down across one. Past this the notification
#: expires -- never the answer, which the phone polls while its thread is open
#: and reads from the command on its next launch besides.
ANSWER_WINDOW_SECONDS = 36 * 3600
```

and, in the `-- commands --` section beside `Desk.commands` and `Desk.command`:

```python
    def finish(self, cid: str, status: str, result: str = "") -> dict:
        """Report a claimed command ``done`` or ``failed``, and tell the phone.

        The store settles the row; the push is this method's whole reason for
        existing, and it is **wrapped**. The caller is the worker's own
        ``POST /api/commands/<id>/done``, and the 200 it gets back is what stops
        the worker retrying: a phone that does not ring costs an answer somebody
        opens the app for, where a ``done`` that 500s costs the entire command
        run a second time -- which on an `ask` that revised the paper means the
        paper revised twice.
        """
        command = self.store.finish_command(cid, status, result)
        if command.get("source") == PHONE_SOURCE:
            try:
                self._send_answer(command, self.clock.now())
            except Exception as exc:                               # noqa: BLE001
                # `push.send` has already logged the redacted detail. Nothing
                # is recorded, so this stays owed and `_send_owed_answers`
                # picks it up on the next housekeeping pass.
                LOG.warning("answer: the push for %s did not go (%s)",
                            cid, type(exc).__name__)
        return command

    def _send_answer(self, command: Mapping, t: float) -> int:
        """Tell every phone that wants it that this command has an answer.

        Returns how many left. Idempotent through the same delivery ledger the
        alerts use, keyed ``(token, "cmd:"+cid, "0")`` -- so a desk that
        restarted between the finish and the sweep, or a sweep overlapping a
        finish, sends one notification rather than two.

        A device inside its quiet window is skipped and **nothing is recorded
        for it**, which is exactly what leaves it owed: `_send_owed_answers`
        picks it up once the window ends. Deferred, never dropped, the rule
        `alerts.quiet_release`'s callers already hold for an alert.
        """
        cid = command["id"]
        event_id = push.answer_event_id(cid)
        devices = (self.push_devices or {}).get("devices") or []
        if not devices:
            return 0

        already = {row["token"] for row
                   in self.store.deliveries_since(t - ANSWER_WINDOW_SECONDS)
                   if row["event_id"] == event_id}
        ready = [one for one in devices
                 if one["token"] not in already
                 and one["prefs"].get(push.ANSWER, True)
                 and alerts.quiet_release(one, t) is None]
        if not ready:
            return 0

        # `lang` is NULL when the phone did not say, which means "the language
        # of the message itself" -- something only the model that read it can
        # know. The desk's own setting is the nearest thing it has, and it is
        # already the language the paper is written in.
        lang = command.get("lang") or self.settings.get("lang")
        messages = [push.answer_message(one["token"], cid, command["status"],
                                        command.get("result") or "", lang)
                    for one in ready]
        tickets = push.send(messages, fetch=self.push_fetch)

        sent = 0
        for one, ticket in zip(ready, tickets):
            token = one["token"]
            if not (isinstance(ticket, dict) and ticket.get("status") == "ok"):
                self.push_failures[token] = self.push_failures.get(token, 0) + 1
                continue
            self.push_failures.pop(token, None)
            self.store.record_delivery(token, event_id, push.ANSWER_LEAD, t)
            sent += 1

        self._forget_unregistered(tickets)
        return sent
```

`Mapping` is already imported in `app.py` at :23 (`from typing import Mapping`),
and `alerts` and `push` are already imported at :26-27. No import change is
needed.

- [ ] **Step 10: Route the handler through `Desk.finish`**

In `server/claudepost/http.py`:

```python
    def h_finish(self, match, _query) -> None:
        doc = self._json_body(required=False)
        status = "done" if match.group("verb") == "done" else "failed"
        # `Desk.finish` rather than the store directly: a command the phone
        # filed rings the phone, and that decision belongs beside the desk's
        # other push rather than in a route handler.
        command = self.desk.finish(
            match.group("cid"), status, str(doc.get("result", ""))[:4000])
        self._send_json(200, {"ok": True, "command": command})
```

- [ ] **Step 11: Run the answer tests to verify they pass**

Run: `sh server/test/run.sh -k answers`
Expected: PASS.

- [ ] **Step 12: Run the whole desk suite**

Run: `sh server/test/run.sh`
Expected: PASS. `test_push.py` and `test_alerts.py` in particular — the first
holds the switch set, the second holds the quiet-hours arithmetic that just
changed name.

- [ ] **Step 13: Commit**

```bash
git add server/claudepost/push.py server/claudepost/alerts.py \
        server/claudepost/app.py server/claudepost/http.py \
        server/test/test_push.py server/test/test_answers.py
git commit -m "$(cat <<'EOF'
feat(desk): the phone rings when its answer lands

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Pxz7nt2DE47CnaMzY4kvNJ
EOF
)"
```

---

## Task 5: A quiet window defers the answer rather than losing it

**Files:**
- Modify: `server/claudepost/store.py` (`finished_since`)
- Modify: `server/claudepost/app.py` (the housekeeping block in `tick`,
  `_fire_owed_answers`, `_send_owed_answers`)
- Test: `server/test/test_answers.py`

**Interfaces:**
- Consumes: `Desk._send_answer(command, t) -> int` and `ANSWER_WINDOW_SECONDS`
  from Task 4; `PHONE_SOURCE`.
- Produces:
  - `Store.finished_since(t: float, source: str) -> list[dict]` — `done` and
    `failed` commands from that source that ended at or after `t`, oldest first.
  - `Desk.tick()`'s `did` list gains an `"answers:N"` entry on a housekeeping
    pass that sent any.

- [ ] **Step 1: Write the failing tests**

Add to `server/test/test_answers.py`:

```python
class DeferredAnswerTest(AnswerTestCase):
    """An answer that landed at three in the morning is owed, not lost."""

    #: 02:00 KST on a Wednesday: inside `SEOUL_NIGHT`, and the release is 07:00
    #: the same morning.
    NIGHT = ts("2026-11-03T17:00:00Z")
    MORNING = ts("2026-11-03T22:00:00Z")

    def setUp(self):
        super().setUp()
        self.clock.set(self.NIGHT)
        self.given(dev(tz="Asia/Seoul", quiet=SEOUL_NIGHT))

    def test_nothing_leaves_while_the_phone_is_quiet(self):
        cid = self.asked(lang="en")
        self.desk.finish(cid, "done", "answered")

        self.assertEqual(self.expo.calls, [])
        # Nothing recorded, which is precisely what leaves it owed.
        self.assertEqual(self.desk.store.deliveries_since(0), [])

    def test_it_goes_on_the_first_housekeeping_pass_after_the_window(self):
        cid = self.asked(lang="en")
        self.desk.finish(cid, "done", "answered")

        self.desk.tick()                    # the first pass takes housekeeping
        self.clock.set(self.MORNING)
        self.assertIn("answers:1", self.desk.tick())

        [message] = self.sent()
        self.assertEqual(message["data"]["command_id"], cid)
        self.assertEqual(message["body"], "Your answer is ready")

    def test_it_goes_once_however_often_the_desk_ticks(self):
        cid = self.asked(lang="en")
        self.desk.finish(cid, "done", "answered")
        self.desk.tick()

        self.clock.set(self.MORNING)
        self.desk.tick()
        for _ in range(5):
            self.clock.advance(HOUSEKEEPING_SECONDS)
            self.assertNotIn("answers:1", self.desk.tick())
        self.assertEqual(len(self.sent()), 1, self.sent())

    def test_a_restart_inside_the_window_still_owes_the_answer(self):
        """The idempotency and the debt are both the ledger, not memory. A
        restart is exactly when a desk would either forget or repeat."""
        cid = self.asked(lang="en")
        self.desk.finish(cid, "done", "answered")
        self.desk.close()

        self.clock.set(self.MORNING)
        self.desk = self.a_desk()
        self.assertEqual(len(self.desk.push_devices["devices"]), 1)
        self.assertIn("answers:1", self.desk.tick())
        self.assertEqual(len(self.sent(self.desk.push_fetch)), 1)

    def test_an_answer_older_than_the_window_is_not_owed_forever(self):
        cid = self.asked(lang="en")
        self.desk.finish(cid, "done", "answered")
        self.desk.tick()

        self.clock.advance(ANSWER_WINDOW_SECONDS + HOUSEKEEPING_SECONDS)
        self.assertNotIn("answers:1", self.desk.tick())
        self.assertEqual(self.expo.calls, [])

    def test_the_pass_costs_nothing_on_a_desk_with_no_phone(self):
        self.desk.set_push_devices(P.parse_devices({"devices": []}))
        cid = self.asked(lang="en")
        self.desk.finish(cid, "done", "answered")
        self.clock.set(self.MORNING)
        self.assertNotIn("answers:1", self.desk.tick())
```

- [ ] **Step 2: Run them to verify they fail**

Run: `sh server/test/run.sh -k Deferred`
Expected: FAIL — `test_it_goes_on_the_first_housekeeping_pass_after_the_window`
finds no `"answers:1"` in the `did` list, because nothing sweeps.

- [ ] **Step 3: Add the bounded query to the store**

In `server/claudepost/store.py`, after `pending_count`:

```python
    def finished_since(self, t: float, source: str) -> list[dict]:
        """``done`` and ``failed`` commands from ``source`` that ended after ``t``.

        Oldest first, and bounded on purpose for
        :meth:`deliveries_since`' reason: the caller decides how far back an
        answer can still be owed, and an unbounded read would grow with the
        queue forever over rows nothing can act on. It runs on the scheduler's
        housekeeping pass, on the connection the publish path writes.

        ``expired`` and ``cancelled`` are excluded because neither is a worker's
        report: nobody wrote an answer, so there is nothing to announce.
        """
        since = epoch_seconds(t, "t")
        if since is None:
            raise BadRequest(message="a window starts at an instant")
        with self._lock:
            rows = self._db.execute(
                "SELECT * FROM commands "
                " WHERE source = ? AND finished_at IS NOT NULL "
                "   AND finished_at >= ? AND status IN ('done', 'failed') "
                " ORDER BY finished_at ASC", (source, since)).fetchall()
        return [dict(r) for r in rows]
```

- [ ] **Step 4: Sweep on the housekeeping pass**

In `server/claudepost/app.py`, inside `tick`'s housekeeping block, after the
`aged = self.store.reap_deliveries(...)` lines and their `did.append`:

```python
            # On the housekeeping pass rather than every tick: what this waits
            # for is a quiet window ending, which is hour-scale, so ten minutes
            # of grain costs an answer nothing -- where a query every five
            # seconds to find nothing all day would be a read on the connection
            # the publish path writes.
            owed = self._fire_owed_answers(t)
            if owed:
                did.append("answers:%d" % owed)
```

and, beside `_fire_due_alerts`:

```python
    def _fire_owed_answers(self, t: float) -> int:
        """Send the answer pushes a quiet window or a restart held back.

        **Every exception is caught**, `_fire_due_alerts`' rule and for its
        reason: the rest of the housekeeping and the publish run after this
        line, and the failure it would die on is a network, which is to say a
        Tuesday. The log line carries the exception's *type* and not its text,
        because what this path holds in its hands is a list of push tokens.
        """
        try:
            return self._send_owed_answers(t)
        except Exception as exc:                                   # noqa: BLE001
            LOG.warning("answers: the pass failed (%s)", type(exc).__name__)
            return 0

    def _send_owed_answers(self, t: float) -> int:
        """The pass itself. See :meth:`_fire_owed_answers` for why it is wrapped.

        The cheap question first, as the alert pass asks it: a desk with no
        phone registered finds that out without opening a read on the database.
        """
        if not (self.push_devices or {}).get("devices"):
            return 0
        sent = 0
        for command in self.store.finished_since(t - ANSWER_WINDOW_SECONDS,
                                                 PHONE_SOURCE):
            sent += self._send_answer(command, t)
        return sent
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `sh server/test/run.sh -k answers`
Expected: PASS — both classes.

- [ ] **Step 6: Run the whole desk suite**

Run: `sh server/test/run.sh`
Expected: PASS. Watch `test_http.py`'s
`test_the_queue_is_reaped_on_the_housekeeping_pass_not_every_tick` and
`test_alerts.py`'s `test_delivery_rows_are_reaped_by_the_housekeeping_pass`:
both assert on the `did` list and a new entry in it is exactly what could
break them.

- [ ] **Step 7: Commit**

```bash
git add server/claudepost/store.py server/claudepost/app.py server/test/test_answers.py
git commit -m "$(cat <<'EOF'
fix(desk): an answer that lands at three in the morning is owed, not lost

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Pxz7nt2DE47CnaMzY4kvNJ
EOF
)"
```

---

## Task 6: The documents say what the desk now does

**Files:**
- Modify: `docs/desk-server.md:278-296` (commands), `:815-880` (the phones),
  `:883` (the tick)
- Modify: `docs/app-control.md:527-531` (the producer route table)
- Modify: `server/README.md:50` (the queue's route line)

**Interfaces:**
- Consumes: everything Tasks 1–5 produced. No code changes.
- Produces: nothing code reads. This repository documents every route in
  `docs/desk-server.md` and `docs/app-control.md`, and a route that exists in
  `_ROUTES` and in neither document is one nobody outside this branch can find.

- [ ] **Step 1: Document the kind and the thread**

In `docs/desk-server.md`, at the end of the "Commands and directives are
different objects" section (after the paragraph beginning "The queue itself is
ordinary"), add:

````markdown
**A fifth kind, `ask`, is a message somebody typed on a phone.** It carries two
nullable columns the other four never use — `reply_to`, the command id of the
previous turn of the same thread, and `lang`, the language the phone was in when
the message was typed. `MAX_COMMAND_TEXT` is unchanged at 2000: a message is
short.

```json
{ "kind": "ask", "text": "매수 얘기 말고 소송으로 톱 바꿔줘",
  "reply_to": "9c1f…", "lang": "ko", "source": "app" }
```

`reply_to` is checked for **existence**, not merely for shape, and that is the
whole reason the check is in `store.add_command` rather than at the route: the
worker will fetch that row and put the earlier question and its answer in front
of the model, so an id naming nothing is a thread that quietly loses a turn and
a phone that never learns why. `lang` is checked against `settings.LANGS` —
`en` or `ko`, the languages there is type on the board for — and `null` is a
state rather than an omission: a typed message carries its own language, and
this field exists only to break a tie the model cannot, a ticker on its own,
say.

**There is no server-side thread object.** `reply_to` is the thread. The phone
keeps its own list of turns and the desk keeps the rows; nothing here joins
them, because the only reader that needs the whole thread is the phone that
wrote it.

**`GET /api/commands/<id>`** — `producer` scope, `404` for an unknown id —
answers one row with `has_notes` beside it, the same flag the list carries. It
exists so a phone polling an open thread does not have to fetch the queue: a
reader asking after its own message would otherwise be handed every other
instruction the desk is holding.

**`result` on a finished `ask` is a vocabulary**, and the desk does not parse
it: `answered`, `revised <edition_id>`, `staged <edition_id>`, or on failure the
worker's own sentence. The phone branches on the first word. What the desk does
read is the first word, once, to put in a push payload — which is the knock at
the door, not the answer. The answer is the command's `notes.md`.
````

- [ ] **Step 2: Document the switch**

In `docs/desk-server.md`'s "The phones, and the alert that arrives before the
date", change the JSON block's `prefs` line to include the switch:

```json
                 "prefs": { "earnings": true, "expiry": true,
                            "dividend": true, "econ": true,
                            "researched": true, "answer": true },
```

and change the paragraph that opens **Five switches, not eight, and not four.**
to open **Six switches, and one of them is not about the book.**, keeping every
sentence that follows and appending:

```markdown
The sixth is `answer`, and it is the first notification on this desk that is not
about a date. It gets a switch under the rule the other five are argued from — a
kind with no switch is a kind the owner cannot turn off — and it is deliberately
absent from the `lead` map beside it, because a lead says *how long before the
date* to speak and an answer has no date. It happens when the worker finishes.
`push.LEAD_KINDS` is the five that take a lead; `push.KINDS` is all six.
```

- [ ] **Step 3: Document the answer push**

In `docs/desk-server.md`, at the end of the "### The tick" subsection, add:

````markdown
### The answer, and the one push that is not an alert

When a command whose `source` is `app` reaches `done` or `failed`, `Desk.finish`
tells every registered phone once:

```json
{ "title": "Claude Post", "body": "답변이 도착했습니다",
  "data": { "command_id": "9c1f…", "result": "revised" } }
```

The body is English or Korean by the command's own `lang`, falling back to the
desk's `settings.lang` when the phone did not say — `null` there means "the
language of the message itself", which only the model that read it can know, and
the language the paper is written in is the nearest thing the desk has. A failed
command gets its own sentence rather than the same one: a notification promising
an answer that opens onto an error is a worse failure than the one it reports.

**The idempotency is the same delivery ledger the alerts use**, keyed
`(token, "cmd:" + <command id>, "0")`. The prefix is why a command id cannot
collide with an event id from the book, and the `"0"` is deliberately not an
ISO-8601 duration, because there is no lead to spell.

**The push is wrapped and the finish is not.** The caller is the worker's own
`POST /api/commands/<id>/done`, and the 200 it gets back is what stops the
worker retrying: a phone that does not ring costs an answer somebody opens the
app for, where a `done` that 500s costs the whole command a second time — and on
an `ask` that revised the paper, that is the paper revised twice.

**A quiet window defers it rather than dropping it**, the rule alerts already
follow. A device inside its window is skipped and *nothing is recorded for it*,
which is exactly what leaves it owed; the housekeeping pass — ten minutes apart,
because what it waits for is hour-scale — sends it once the window ends. Past
`ANSWER_WINDOW_SECONDS` (36 hours, a day of quiet window plus slack for a desk
that was down across one) the *notification* expires. The answer never does: the
phone polls the command while its thread is open and reads it from the row on the
next launch besides.
````

- [ ] **Step 4: Add the route to the phone's table**

In `docs/app-control.md`, in the `producer` scope table, change the queue rows
to:

```markdown
| `GET /api/commands` · `POST /api/commands` | the queue, and asking it for something — including `{"kind": "ask"}`, a message typed on the phone |
| `GET /api/commands/<id>` | one instruction, with `has_notes` — what the Ask screen polls while a thread is open |
| `GET/PUT /api/commands/<id>/notes.md` | the note on one instruction, which for an `ask` is the answer itself |
```

and in `server/README.md:50` change the Queue row to:

```markdown
| Queue | `POST /api/commands` · `GET /api/commands/next?wait=60` · `POST …/done` · `POST …/fail` · `GET/PUT …/notes.md` · `GET /api/commands` · `GET /api/commands/<id>` · `DELETE …` |
```

- [ ] **Step 5: Check the documents against the code**

Run:

```bash
grep -n "api/commands" docs/desk-server.md docs/app-control.md server/README.md
grep -n "answer" docs/desk-server.md | head
sh server/test/run.sh
```

Expected: every route in `_ROUTES` under `/api/commands` appears in
`server/README.md`; the two phone-facing reads appear in `docs/app-control.md`;
the suite passes.

- [ ] **Step 6: Commit**

```bash
git add docs/desk-server.md docs/app-control.md server/README.md
git commit -m "$(cat <<'EOF'
docs(desk): a message, the thread it belongs to, and the push that answers it

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Pxz7nt2DE47CnaMzY4kvNJ
EOF
)"
```

---

## Self-review

Run against the spec's section 2 and the server row of section 5.

**1. Spec coverage.**

| spec requirement | task |
|---|---|
| `COMMAND_KINDS` gains `ask`; `MAX_COMMAND_TEXT` stays 2000 | Task 1, step 4 |
| `reply_to TEXT` and `lang TEXT`, nullable, on the migration path | Task 1, steps 4–5 |
| `reply_to` validated against `COMMAND_ID_RE` and required to exist | Task 1, step 5 |
| `lang` is `en`/`ko`; `NULL` means the message's own | Task 1, step 5 |
| both round-trip through `POST /api/commands` and every row the API returns | Task 2 (`SELECT *` carries them to `GET /api/commands`, `GET /api/commands/<id>` and `state()`'s `queue.recent`) |
| `GET /api/commands/<cid>`, producer scope, `has_notes`, 404 | Task 3 |
| `result` vocabulary; the desk does not parse it | Global constraint; Task 4's `answer_message` takes only the first word, documented in Task 6 |
| the answer is the command's existing `notes.md`; nothing new stored | no code needed — `PUT/GET /api/commands/<id>/notes.md` already exists; documented in Task 6, step 4 |
| push on `done`/`failed` for `source == "app"`, one per device | Task 4 |
| title, both bodies, `data: {command_id, result}` | Task 4, step 8 |
| ledger key `(token, "cmd:"+cid, 0)` | Task 4, steps 8–9 |
| quiet hours respected as alerts do | Tasks 4–5 |
| `push.KINDS` gains `answer` | Task 4, step 3 |
| section 5's server tests: kind, `reply_to` existence and pattern, `lang`, route 200/404/scope, one push for `app` and none for `schedule`, the ledger key | Tasks 1–5 (`test_store.AskTest`, `test_http`'s four queue tests, `test_answers.AnswerPushTest`) |

Two gaps found and closed while reviewing:

- The spec says the columns are added "by the existing migration path in
  `store.py`". **There is no migration path** — `_SCHEMA` is `CREATE TABLE IF
  NOT EXISTS` only, and `grep -rn "ALTER TABLE" server/` finds nothing. Task 1
  builds one (`_ADDED_COLUMNS` + `Store._migrate`) and tests it against a
  database with the columns dropped, because without it the first `ask` filed
  against the deployed desk raises `no such column: reply_to` weeks after the
  deploy.
- The spec's "respects the device's quiet hours the way alert pushes do" has no
  mechanism behind it in a one-shot `finish`. Alerts defer and stay owed because
  a tick retries them; an answer with no sweep would simply be lost. Task 5 adds
  the sweep on the housekeeping pass.

**2. Placeholder scan.** No `TBD`, no "add validation", no "similar to Task N".
Every code step carries the actual code; every test step carries the actual
test; every run step names the exact command and the expected result. The one
step that says "check before removing" (Task 1, step 3, the possibly-unused
`import re` in `app.py`) names the grep that decides it.

**3. Type consistency.** Checked across tasks:

- `COMMAND_ID_RE` — defined in `store.py` (Task 1), re-exported from `app.py`
  (Task 1), imported by `http.py` as it already is. One spelling.
- `Store.add_command(..., reply_to=None, lang=None)` — Task 1 defines it, Task 2
  calls it through `Desk.enqueue` with exactly those keywords.
- `Desk.command(cid)` (singular) vs `Desk.commands(status, limit)` (plural) —
  Task 3 defines the first, Task 4's `test_a_second_send_for_the_same_command_is_suppressed`
  calls it, Task 5's sweep uses neither (it takes rows straight from
  `finished_since`, which is why `_send_answer` reads `command["status"]` and
  never `has_notes`).
- `push.ANSWER`, `push.ANSWER_LEAD`, `push.answer_event_id`,
  `push.answer_message` — defined in Task 4 step 8, used in Task 4 step 9 and in
  `test_answers.py` with the same names and argument order
  `(token, cid, status, result, lang)`.
- `push.LEAD_KINDS` vs `push.KINDS` — `_lead` and `DEFAULT_LEAD` key off the
  first, `_prefs` and `_KIND_KEYS` off the second. `test_push.py`'s rewritten
  assertions hold both, and `SPEC_DEVICE` gains the switch without gaining a
  lead.
- `alerts.quiet_release` — renamed in Task 4 step 7, called from Task 4 step 9.
  Its three in-module call sites (`defer_for_quiet` and two inside `due`) are
  named so none is missed.
- `PHONE_SOURCE` / `ANSWER_WINDOW_SECONDS` — defined in Task 4 step 9, imported
  by `test_answers.py` in Task 4 step 5 and used by Task 5's sweep.
- `Store.finished_since(t, source)` — Task 5 only; nothing earlier refers to it.
