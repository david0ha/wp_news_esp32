# Desk Server Implementation Plan

> **2026-08-23 — superseded in part.** Shipped without the vault bridge (`vault.py`, the notes
> bridge) — the schedule now lives at `/data/schedule.json` instead, and the worker moved to
> `agent/`. See [docs/desk-server.md](../../desk-server.md) for what actually shipped. The
> reasoning below is kept as filed.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An always-on containerised service that owns the URL the board polls — holding the current edition, taking commands from agents anywhere, deciding when a new page may reach the glass, and typesetting every candidate before it does — plus a `policy` block on the wire so the server can also set the device's poll cadence.

**Architecture:** A Python-standard-library HTTP service (`server/wpdesk/`) with two non-overlapping routing planes: an anonymous read-only device plane (`/news.json`, `/tiles/<id>.bin`, `/healthz`) and a bearer-token control plane (`/api/*`). Editions arrive as drafts, pass five gates (schema → typeset → fingerprint → schedule → atomic publish), and become current only by an `os.replace` of a pointer file. Three storage roots keep serving independent of the external SSD. A sibling agent container claims commands over a long poll and files editions back through the same gates.

**Tech Stack:** Python 3.12 standard library only (`http.server`, `sqlite3`, `zoneinfo`, `hmac`, `zlib`, `subprocess`); Docker Compose; `cloudflared`; C11 for the firmware half (ESP-IDF v5.4.3, LVGL 9.4.0); existing repo tools `tools/mock_news_server.py` and `tools/edition/render-check.sh` invoked as subprocesses.

**Spec:** [`docs/superpowers/specs/2026-08-18-desk-server-design.md`](../specs/2026-08-18-desk-server-design.md)

## Global Constraints

- **Python: standard library only.** No `pip install` in `server/`. No `requirements.txt`, no lock file. `zoneinfo` + OS `tzdata`.
- **Payload cap 300 KB** (`MAX_PAYLOAD_BYTES = 300 * 1024`). The device caps a response at 320 KB (`components/news_core/http_port_esp.c:32`).
- **Tile cap 960,000 bytes** (`MAX_TILE_BYTES`), **16 tiles per draft** (`MAX_TILES`), **8 open drafts** (`MAX_DRAFTS`).
- **Tile ids** match `^[A-Za-z0-9_-]{1,15}$` — the same rule `ui_tile.c`'s `id_ok()` applies.
- **Poll seconds range 30..86400** — the firmware's existing range.
- **Every number the device reasons about is an integer.** `next_change` is epoch seconds as a JSON number, never a string.
- **`news_hash()` must not include `policy`.** A host test asserts it.
- **Error envelope** is `{"ok":false,"error":"<code>"}` with a 4xx, matching `components/device_api/device_api.c`.
- **No caching headers on the device plane.**
- **Nothing private in the repo.** No tokens, no vault path defaults pointing at a real directory, no watchlist, no standing instructions. `.env.example` carries names, never values.
- **All prose in `server/` and `docs/` is English**, matching the rest of the repository.
- **Comments explain why, not what** — match the density and voice of `components/news_core/*.c` and `tools/edition/*.sh`.
- **Docstrings on every public function, class and module.**
- Timezone for all defaults: `Asia/Seoul`.

---

## File Structure

```
server/
  README.md                      how to run it, what it exposes, the tokens
  Dockerfile                     desk: python:3.12-slim + cmake/gcc/libcurl/git/tzdata + built sim
  Dockerfile.agent               worker: node:22-slim + @anthropic-ai/claude-code + python3
  compose.yaml                   desk + agent + cloudflared
  .env.example                   every knob, no values
  .gitignore                     tunnel/*.yml (not .example), .env
  wpdesk/
    __init__.py
    errors.py     DeskError and the code table            (no deps)
    clock.py      Clock / FixedClock                      (no deps)
    tiles.py      id + size limits                        (errors)
    proofpng.py   BMP24 -> PNG via zlib                   (errors)
    schedule.py   Schedule, parsing, all time arithmetic  (errors, clock)
    policy.py     the served policy block                 (schedule)
    auth.py       token file, two scopes                  (errors)
    store.py      SQLite: commands, directives, audit      (errors, clock)
    gates.py      Gates protocol + Subprocess/Stub         (errors)
    editions.py   drafts, gates, pointers, publish        (errors, clock, tiles, gates, store, proofpng)
    vault.py      the notes bridge                        (errors, clock, schedule)
    app.py        Desk — wiring, scheduler tick           (everything above)
    http.py       routing, the two planes                 (app)
    __main__.py   env config, threads, signals            (app, http)
  agent/
    loop.py       claim -> claude -> proof -> look -> commit -> brief
  test/
    run.sh
    test_schedule.py test_policy.py test_store.py test_editions.py
    test_auth.py test_tiles.py test_proofpng.py test_http.py test_vault.py
    fixtures/tiny.bmp
  tunnel/
    wpnews.yml.example
```

Firmware half (existing files):

```
components/news_core/include/news_model.h   news_policy_t, news_t.policy
components/news_core/news_parse.c           parse + clamp
components/news_core/news_model.c           news_hash() comment (no policy)
components/news_core/test/host/test_news_parse.c   clamps, absence, hash exclusion
components/news_core/test/host/CMakeLists.txt      (unchanged if tests fold in)
components/user_app/user_app.cpp            runtime poll interval + stale floor
components/device_api/device_api.c          source.pollSource
tools/mock_news_server.py                   emit + validate + fixture
sim/CMakeLists.txt                          LVGL FetchContent fallback
```

---

## Task 1: `errors.py`, `clock.py`, `tiles.py` — the leaf modules

**Files:**
- Create: `server/wpdesk/__init__.py`, `server/wpdesk/errors.py`, `server/wpdesk/clock.py`, `server/wpdesk/tiles.py`
- Test: `server/test/test_tiles.py`, `server/test/run.sh`

**Interfaces:**
- Produces:
  ```python
  # errors.py
  class DeskError(Exception):
      def __init__(self, code: str, message: str = "", status: int = 400) -> None
      code: str; message: str; status: int
  class BadRequest(DeskError)      # status 400, default code "bad_request"
  class Unauthorized(DeskError)    # status 401, code "unauthorized"
  class Forbidden(DeskError)       # status 403, code "forbidden"
  class NotFound(DeskError)        # status 404, code "not_found"
  class Conflict(DeskError)        # status 409, code "conflict"
  class TooLarge(DeskError)        # status 413, code "too_large"

  # clock.py
  class Clock:
      def now(self) -> float
      def sleep(self, seconds: float) -> None
      def monotonic(self) -> float
  class FixedClock(Clock):
      def __init__(self, t: float) -> None
      def advance(self, seconds: float) -> None
      def set(self, t: float) -> None

  # tiles.py
  MAX_PAYLOAD_BYTES: int = 300 * 1024
  MAX_TILE_BYTES: int = 960_000
  MAX_TILES: int = 16
  MAX_DRAFTS: int = 8
  TILE_ID_RE: re.Pattern
  def valid_tile_id(s: str) -> bool
  def check_payload_size(data: bytes) -> None   # raises TooLarge
  def check_tile(tile_id: str, data: bytes) -> None  # raises BadRequest / TooLarge
  ```

- [ ] **Step 1: Write `server/test/run.sh`**

```sh
#!/bin/sh
# run.sh — layer 0. Faster than every other layer and needs neither Docker nor
# a network, which is the whole reason it goes first.
set -eu
here=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
cd "$here/.."
exec python3 -m unittest discover -s test -p 'test_*.py' -v
```

- [ ] **Step 2: Write the failing test `server/test/test_tiles.py`**

```python
import unittest
from wpdesk import tiles
from wpdesk.errors import BadRequest, TooLarge


class TileIdTest(unittest.TestCase):
    def test_accepts_the_ids_the_device_accepts(self):
        for good in ("sndk_fab", "a", "A-1_z", "0123456789abcde"):
            self.assertTrue(tiles.valid_tile_id(good), good)

    def test_rejects_what_would_become_a_path(self):
        for bad in ("", "../etc", "a/b", "a.bin", "a%2e", "x" * 16, "a b"):
            self.assertFalse(tiles.valid_tile_id(bad), bad)


class TileSizeTest(unittest.TestCase):
    def test_a_full_sheet_tile_is_the_largest_that_can_exist(self):
        tiles.check_tile("ok", b"\x00" * tiles.MAX_TILE_BYTES)

    def test_one_byte_over_a_full_sheet_is_refused(self):
        with self.assertRaises(TooLarge):
            tiles.check_tile("ok", b"\x00" * (tiles.MAX_TILE_BYTES + 1))

    def test_an_empty_tile_is_refused(self):
        with self.assertRaises(BadRequest):
            tiles.check_tile("ok", b"")

    def test_a_bad_id_is_refused_before_the_bytes_are_looked_at(self):
        with self.assertRaises(BadRequest):
            tiles.check_tile("../x", b"\x00" * 8)


class PayloadSizeTest(unittest.TestCase):
    def test_the_cap_is_below_what_the_device_will_fetch(self):
        self.assertLess(tiles.MAX_PAYLOAD_BYTES, 320 * 1024)

    def test_over_the_cap_is_refused(self):
        with self.assertRaises(TooLarge):
            tiles.check_payload_size(b"x" * (tiles.MAX_PAYLOAD_BYTES + 1))
```

- [ ] **Step 3: Run it and watch it fail**

Run: `sh server/test/run.sh`
Expected: FAIL — `ModuleNotFoundError: No module named 'wpdesk'`

- [ ] **Step 4: Implement `errors.py`, `clock.py`, `tiles.py`**

```python
# errors.py
"""The one exception type the HTTP layer knows how to turn into a response.

Every failure inside the desk carries the wire code it will be reported as, so
the code that raises the error is the code that names it. The alternative — a
translation table at the boundary — drifts the moment somebody adds a raise
without touching the table, and the symptom is a 500 where a 400 was meant.

The envelope matches components/device_api/device_api.c, so a client that
speaks to the board speaks to the desk.
"""
```

Each subclass sets its default `code` and `status`. `DeskError.to_json()` returns
`{"ok": False, "error": self.code}` and includes `"detail"` only when `message` is non-empty.

```python
# clock.py
"""Time, injected, so that tests of a scheduler do not have to wait for one.

Every module that asks what time it is takes a Clock. FixedClock is the whole
reason: a quiet window that ends at 06:00 is tested by setting the clock to
05:59:59 and stepping over it, not by sleeping.
"""
```

```python
# tiles.py
"""What may be PUT into a draft, and how much of it.

The id rule is ui_tile.c's id_ok() — letters, digits, underscore and hyphen,
fifteen bytes — restated here because the id becomes a path component on this
side too, and "the device would have rejected it anyway" is not a defence
against a traversal on the desk.

The byte counts are transport limits and nothing more. Whether a tile's length
agrees with the w*h/2 its payload declared is gate 1's question, and
mock_news_server.py --validate already answers it; duplicating that here would
give two answers to maintain.
"""
```

- [ ] **Step 5: Run it and watch it pass**

Run: `sh server/test/run.sh`
Expected: PASS, 8 tests

- [ ] **Step 6: Commit**

```bash
git add server/wpdesk/__init__.py server/wpdesk/errors.py server/wpdesk/clock.py server/wpdesk/tiles.py server/test/test_tiles.py server/test/run.sh
git commit -m "feat(server): the leaf modules — errors, an injectable clock, tile limits"
```

---

## Task 2: `schedule.py` — every piece of time arithmetic

**Files:**
- Create: `server/wpdesk/schedule.py`
- Test: `server/test/test_schedule.py`

**Interfaces:**
- Consumes: `errors.BadRequest`, `clock.Clock`
- Produces:
  ```python
  PUBLISH_POLICIES: tuple[str, ...] = ("immediate", "on_wake", "manual")

  @dataclass(frozen=True)
  class QuietWindow:
      start: str      # "HH:MM"
      end: str        # "HH:MM"; end <= start means it wraps midnight

  @dataclass(frozen=True)
  class WakeTime:
      at: str                  # "HH:MM"
      days: frozenset[int]     # 0=Monday .. 6=Sunday; all seven by default

  @dataclass(frozen=True)
  class Schedule:
      timezone: str
      quiet: tuple[QuietWindow, ...]
      wake: tuple[WakeTime, ...]
      publish_policy: str
      min_gap_minutes: int
      poll_active_seconds: int
      poll_quiet_seconds: int

  DEFAULT_SCHEDULE: Schedule    # Asia/Seoul, quiet 00:30-06:00, wake 06:00/12:40/22:00,
                                # on_wake, gap 60, poll 900/3600

  def parse_schedule(doc: dict) -> Schedule          # raises BadRequest("bad_schedule", "<field path>: ...")
  def schedule_to_dict(s: Schedule) -> dict          # round-trips through parse_schedule
  def is_quiet(s: Schedule, t: float) -> bool
  def quiet_ends_at(s: Schedule, t: float) -> float | None
  def next_wake(s: Schedule, t: float) -> float | None
  def next_transition(s: Schedule, t: float) -> tuple[float, str] | None   # label in
                                                    # {"quiet_start","quiet_end","wake"}
  def transitions(s: Schedule, t: float, count: int) -> list[tuple[float, str]]
  def effective_poll_seconds(s: Schedule, t: float) -> int
  def describe(s: Schedule, t: float, count: int = 10) -> list[dict]
      # [{"at": epoch, "local": "2026-08-19 00:30 KST", "utc": "...Z", "what": "quiet_start",
      #   "ambiguous": bool}]
  ```

- [ ] **Step 1: Write the failing test `server/test/test_schedule.py`**

Cover, each as its own test method:

```python
import unittest
from datetime import datetime
from zoneinfo import ZoneInfo
from wpdesk import schedule as S
from wpdesk.errors import DeskError

KST = ZoneInfo("Asia/Seoul")


def at(y, mo, d, h, mi, tz=KST):
    return datetime(y, mo, d, h, mi, tzinfo=tz).timestamp()


class ParseTest(unittest.TestCase):
    def test_the_default_round_trips(self):
        self.assertEqual(
            S.parse_schedule(S.schedule_to_dict(S.DEFAULT_SCHEDULE)), S.DEFAULT_SCHEDULE)

    def test_an_unknown_timezone_is_rejected_by_name(self):
        doc = S.schedule_to_dict(S.DEFAULT_SCHEDULE) | {"timezone": "Mars/Olympus"}
        with self.assertRaises(DeskError) as e:
            S.parse_schedule(doc)
        self.assertIn("timezone", str(e.exception))

    def test_poll_seconds_outside_the_devices_range_are_rejected(self):
        for bad in (29, 86401):
            doc = S.schedule_to_dict(S.DEFAULT_SCHEDULE)
            doc["poll"]["active_seconds"] = bad
            with self.assertRaises(DeskError):
                S.parse_schedule(doc)

    def test_a_bad_clock_string_is_rejected(self):
        for bad in ("24:00", "6:00", "0600", "06:60", ""):
            doc = S.schedule_to_dict(S.DEFAULT_SCHEDULE)
            doc["wake"] = [bad]
            with self.assertRaises(DeskError):
                S.parse_schedule(doc)

    def test_an_unknown_publish_policy_is_rejected_rather_than_defaulted(self):
        doc = S.schedule_to_dict(S.DEFAULT_SCHEDULE)
        doc["publish"]["policy"] = "whenever"
        with self.assertRaises(DeskError):
            S.parse_schedule(doc)

    def test_a_wake_entry_may_name_days(self):
        doc = S.schedule_to_dict(S.DEFAULT_SCHEDULE)
        doc["wake"] = [{"at": "07:00", "days": "sat,sun"}]
        s = S.parse_schedule(doc)
        self.assertEqual(s.wake[0].days, frozenset({5, 6}))


class QuietTest(unittest.TestCase):
    def test_a_window_that_wraps_midnight_covers_both_sides(self):
        s = S.DEFAULT_SCHEDULE                     # 00:30 -> 06:00
        self.assertTrue(S.is_quiet(s, at(2026, 8, 19, 1, 0)))
        self.assertTrue(S.is_quiet(s, at(2026, 8, 19, 5, 59)))
        self.assertFalse(S.is_quiet(s, at(2026, 8, 19, 6, 0)))
        self.assertFalse(S.is_quiet(s, at(2026, 8, 19, 0, 29)))

    def test_the_end_of_a_window_is_the_instant_it_stops_being_quiet(self):
        s = S.DEFAULT_SCHEDULE
        self.assertEqual(S.quiet_ends_at(s, at(2026, 8, 19, 1, 0)),
                         at(2026, 8, 19, 6, 0))

    def test_outside_a_window_there_is_no_end(self):
        self.assertIsNone(S.quiet_ends_at(S.DEFAULT_SCHEDULE, at(2026, 8, 19, 9, 0)))

    def test_a_window_written_backwards_across_midnight_is_still_one_window(self):
        s = S.parse_schedule(S.schedule_to_dict(S.DEFAULT_SCHEDULE)
                             | {"quiet": [{"from": "23:00", "to": "01:00"}]})
        self.assertTrue(S.is_quiet(s, at(2026, 8, 19, 23, 30)))
        self.assertTrue(S.is_quiet(s, at(2026, 8, 19, 0, 30)))
        self.assertFalse(S.is_quiet(s, at(2026, 8, 19, 12, 0)))


class WakeTest(unittest.TestCase):
    def test_the_next_wake_is_the_next_one_today_or_the_first_tomorrow(self):
        s = S.DEFAULT_SCHEDULE                     # 06:00, 12:40, 22:00
        self.assertEqual(S.next_wake(s, at(2026, 8, 19, 7, 0)),
                         at(2026, 8, 19, 12, 40))
        self.assertEqual(S.next_wake(s, at(2026, 8, 19, 23, 0)),
                         at(2026, 8, 20, 6, 0))

    def test_a_wake_exactly_now_is_not_the_next_one(self):
        s = S.DEFAULT_SCHEDULE
        self.assertEqual(S.next_wake(s, at(2026, 8, 19, 6, 0)),
                         at(2026, 8, 19, 12, 40))

    def test_day_filtered_wakes_skip_the_days_they_exclude(self):
        s = S.parse_schedule(S.schedule_to_dict(S.DEFAULT_SCHEDULE)
                             | {"wake": [{"at": "07:00", "days": "sat"}]})
        # 2026-08-19 is a Wednesday; the next Saturday is the 22nd.
        self.assertEqual(S.next_wake(s, at(2026, 8, 19, 9, 0)),
                         at(2026, 8, 22, 7, 0))


class PollTest(unittest.TestCase):
    def test_the_quiet_cadence_applies_inside_the_window_and_not_outside(self):
        s = S.DEFAULT_SCHEDULE
        self.assertEqual(S.effective_poll_seconds(s, at(2026, 8, 19, 1, 0)), 3600)
        self.assertEqual(S.effective_poll_seconds(s, at(2026, 8, 19, 9, 0)), 900)


class DstTest(unittest.TestCase):
    """A schedule in a zone that observes DST still fires once a day.

    Asia/Seoul does not, which is exactly why this test names a zone that does:
    the arithmetic must be right for a reader who moves, and 'it works here'
    is not evidence.
    """
    def _ny(self, doc_wake):
        return S.parse_schedule(S.schedule_to_dict(S.DEFAULT_SCHEDULE)
                                | {"timezone": "America/New_York", "wake": doc_wake,
                                   "quiet": []})

    def test_a_wake_in_the_spring_forward_gap_still_resolves(self):
        s = self._ny(["02:30"])                    # 2026-03-08 02:30 does not exist in NY
        t = datetime(2026, 3, 8, 0, 0, tzinfo=ZoneInfo("America/New_York")).timestamp()
        nxt = S.next_wake(s, t)
        self.assertIsNotNone(nxt)
        self.assertGreater(nxt, t)
        self.assertLess(nxt - t, 26 * 3600)

    def test_a_wake_in_the_fall_back_repeat_fires_once(self):
        s = self._ny(["01:30"])                    # 2026-11-01 01:30 happens twice
        t = datetime(2026, 11, 1, 0, 0, tzinfo=ZoneInfo("America/New_York")).timestamp()
        first = S.next_wake(s, t)
        second = S.next_wake(s, first + 1)
        self.assertGreater(second - first, 20 * 3600)


class DescribeTest(unittest.TestCase):
    def test_it_lists_transitions_in_order_and_names_each_one(self):
        rows = S.describe(S.DEFAULT_SCHEDULE, at(2026, 8, 19, 9, 0), 5)
        self.assertEqual(len(rows), 5)
        self.assertEqual([r["at"] for r in rows], sorted(r["at"] for r in rows))
        self.assertIn(rows[0]["what"], ("wake", "quiet_start", "quiet_end"))
        self.assertTrue(rows[0]["utc"].endswith("Z"))
```

- [ ] **Step 2: Run and watch it fail** — `sh server/test/run.sh`, `ModuleNotFoundError: wpdesk.schedule`

- [ ] **Step 3: Implement `schedule.py`**

Implementation notes the engineer needs:

- Local-time resolution goes through `datetime.combine(day, time, tzinfo=ZoneInfo(tz))`. For the
  spring-forward gap, `.timestamp()` on a nonexistent local time yields a real instant; accept it
  and move on — the requirement is "fires once a day", not "fires at exactly 02:30".
- For fall-back repeats use `fold=0` so the earlier of the two instants is chosen, and report
  `ambiguous: True` from `describe()` when `dt.replace(fold=1).timestamp() != dt.timestamp()`.
- `next_wake` scans the next 8 local days, collecting candidate instants strictly greater than `t`,
  and returns the minimum. Eight days covers a `days`-filtered weekly wake plus a DST shift.
- `is_quiet` compares local `HH:MM` as minutes-since-midnight. `start == end` is an **empty** window,
  not a whole day — a window of zero length is what somebody types when they mean "none".
- `next_transition` = the minimum of `next_wake`, every window's next start, and the current
  window's end.
- Validation raises `BadRequest("bad_schedule", f"{path}: {why}")` with the JSON path, because the
  message is what lands in `schedule.errors.md` in the vault and a message without a field name is
  a message nobody can act on.

- [ ] **Step 4: Run and watch it pass** — all 18 tests

- [ ] **Step 5: Commit**

```bash
git add server/wpdesk/schedule.py server/test/test_schedule.py
git commit -m "feat(server): the schedule, and every piece of time arithmetic in it"
```

---

## Task 3: `policy.py` — the block that reaches the wire

**Files:**
- Create: `server/wpdesk/policy.py`
- Test: `server/test/test_policy.py`

**Interfaces:**
- Consumes: `schedule.Schedule`, `schedule.effective_poll_seconds`, `schedule.next_transition`
- Produces:
  ```python
  def policy_block(s: Schedule, t: float) -> dict
      # {"poll_seconds": int}  plus  {"next_change": int}  when a transition is known
  def splice_policy(payload: bytes, s: Schedule, t: float) -> bytes
      # parses the payload, DROPS any producer "policy" key, inserts ours, re-serialises
  def dropped_producer_policy(payload: bytes) -> bool
  ```

- [ ] **Step 1: Write the failing test**

```python
import json, unittest
from wpdesk import policy, schedule as S
from test_schedule import at            # reuse the helper


class PolicyBlockTest(unittest.TestCase):
    def test_the_cadence_is_the_one_for_right_now(self):
        self.assertEqual(policy.policy_block(S.DEFAULT_SCHEDULE, at(2026, 8, 19, 1, 0))
                         ["poll_seconds"], 3600)
        self.assertEqual(policy.policy_block(S.DEFAULT_SCHEDULE, at(2026, 8, 19, 9, 0))
                         ["poll_seconds"], 900)

    def test_next_change_is_an_integer_epoch_not_a_string(self):
        b = policy.policy_block(S.DEFAULT_SCHEDULE, at(2026, 8, 19, 9, 0))
        self.assertIsInstance(b["next_change"], int)
        self.assertGreater(b["next_change"], at(2026, 8, 19, 9, 0))

    def test_a_schedule_with_no_transitions_has_no_next_change(self):
        s = S.parse_schedule(S.schedule_to_dict(S.DEFAULT_SCHEDULE)
                             | {"quiet": [], "wake": []})
        self.assertNotIn("next_change", policy.policy_block(s, at(2026, 8, 19, 9, 0)))


class SpliceTest(unittest.TestCase):
    def test_the_block_is_added_and_the_rest_is_untouched(self):
        src = json.dumps({"edition": "X", "stories": [{"headline": "H"}]}).encode()
        out = json.loads(policy.splice_policy(src, S.DEFAULT_SCHEDULE, at(2026, 8, 19, 9, 0)))
        self.assertEqual(out["edition"], "X")
        self.assertEqual(out["stories"], [{"headline": "H"}])
        self.assertIn("policy", out)

    def test_a_producers_own_policy_is_discarded(self):
        src = json.dumps({"policy": {"poll_seconds": 31}, "stories": []}).encode()
        out = json.loads(policy.splice_policy(src, S.DEFAULT_SCHEDULE, at(2026, 8, 19, 9, 0)))
        self.assertEqual(out["policy"]["poll_seconds"], 900)
        self.assertTrue(policy.dropped_producer_policy(src))

    def test_a_payload_without_one_reports_nothing_dropped(self):
        self.assertFalse(policy.dropped_producer_policy(b'{"stories":[]}'))

    def test_the_spliced_payload_is_still_under_the_device_cap(self):
        from wpdesk import tiles
        src = b'{"stories":[]}'
        out = policy.splice_policy(src, S.DEFAULT_SCHEDULE, at(2026, 8, 19, 9, 0))
        self.assertLess(len(out), tiles.MAX_PAYLOAD_BYTES)
```

- [ ] **Step 2: Run, watch it fail**
- [ ] **Step 3: Implement.** `splice_policy` uses `json.loads` / `json.dumps(..., separators=(",",":"), ensure_ascii=False)`. Document why the block is computed per request rather than stored: `next_change` is an instant, and an instant baked into a file is wrong the moment the schedule changes.
- [ ] **Step 4: Run, watch it pass**
- [ ] **Step 5: Commit** — `feat(server): the policy block, computed per request and never stored`

---

## Task 4: `auth.py` — two scopes, one file

**Files:**
- Create: `server/wpdesk/auth.py`
- Test: `server/test/test_auth.py`

**Interfaces:**
- Produces:
  ```python
  SCOPES: tuple[str, ...] = ("producer", "operator")
  RANK: dict[str, int] = {"producer": 1, "operator": 2}

  class Tokens:
      def __init__(self, path: str) -> None
      def reload_if_changed(self) -> None
      def scope_for(self, presented: str) -> str | None      # constant-time
      def name_for(self, presented: str) -> str | None
      def count(self) -> int
  def scope_from_header(tokens: Tokens, header: str | None) -> tuple[str, str]
      # returns (name, scope); raises Unauthorized
  def require(needed: str, have: str) -> None                # raises Forbidden
  ```

File format `~/.wpnews/tokens.json`:
```json
{"tokens": [{"name": "agent", "scope": "producer", "token": "..."},
            {"name": "me",    "scope": "operator", "token": "..."}]}
```

- [ ] **Step 1: Failing tests** — a missing file is zero tokens and every request 401 (not a crash);
  an unknown token is 401; `producer` is 403 for `operator`; `operator` satisfies `producer`;
  comparison uses `hmac.compare_digest` (assert by inspecting the source? no — assert behaviour:
  a token that is a **prefix** of a real one is rejected, and one that is a superstring is rejected);
  a malformed JSON file raises at load with a clear message rather than authorising anybody;
  a token entry with an unknown scope is refused at load.
- [ ] **Step 2: Run, fail**
- [ ] **Step 3: Implement.** Comment: why the file is plain rather than hashed — the posture is a
  0600 file on a machine whose owner is the only user, and a hash would add a rotation story
  without adding a threat model.
- [ ] **Step 4: Run, pass**
- [ ] **Step 5: Commit** — `feat(server): bearer tokens and the two scopes`

---

## Task 5: `store.py` — SQLite for commands, directives and audit

**Files:**
- Create: `server/wpdesk/store.py`
- Test: `server/test/test_store.py`

**Interfaces:**
- Consumes: `clock.Clock`, `errors`
- Produces:
  ```python
  LEASE_SECONDS: int = 1800
  MAX_ATTEMPTS: int = 3
  COMMAND_KINDS: tuple[str, ...] = ("file_edition", "research", "custom")
  MAX_COMMAND_TEXT: int = 2000
  MAX_DIRECTIVE_RULE: int = 500

  class Store:
      def __init__(self, path: str, clock: Clock) -> None
      def close(self) -> None

      def add_command(self, kind: str, text: str, priority: int = 5,
                      deadline_at: float | None = None, source: str = "") -> dict
      def claim_command(self, worker: str) -> dict | None
      def finish_command(self, cid: str, status: str, result: str = "") -> dict
      def cancel_command(self, cid: str) -> bool
      def get_command(self, cid: str) -> dict | None
      def list_commands(self, status: str | None = None, limit: int = 100) -> list[dict]
      def reap(self) -> int
      def pending_count(self) -> int

      def add_directive(self, rule: str, scope: str = "always",
                        expires_at: float | None = None, source: str = "") -> dict
      def list_directives(self) -> list[dict]      # expired ones excluded
      def delete_directive(self, did: str) -> bool

      def record_edition(self, eid: str, meta: dict) -> None
      def get_edition(self, eid: str) -> dict | None
      def list_editions(self, limit: int = 50) -> list[dict]
      def note_publish(self, eid: str, at: float) -> None
      def last_publish_at(self) -> float | None

      def set_hold(self, until: float | None) -> None
      def get_hold(self) -> float | None

      def audit(self, event: str, detail: dict) -> None
      def recent_audit(self, limit: int = 50) -> list[dict]
  ```

Command dict keys: `id, kind, text, priority, status, source, created_at, deadline_at,
claimed_by, claimed_at, finished_at, attempts, result`.
Directive dict keys: `id, rule, scope, expires_at, source, created_at`.

- [ ] **Step 1: Failing tests.** Each of these is a method:
  - a command comes back in priority then FIFO order
  - **a command is claimed exactly once by twenty concurrent claimers** (threads, one `Store` each,
    same file, `check_same_thread=False`, WAL) — the count of non-`None` claims is exactly 1
  - a claim past its lease returns to `pending` and increments `attempts`
  - the third attempt fails it rather than returning it to `pending`
  - a command past `deadline_at` is `expired` by `reap()` and never claimed
  - `cancel_command` on a claimed command is refused; on a pending one it works
  - text over `MAX_COMMAND_TEXT` is `BadRequest`; an unknown `kind` is `BadRequest`
  - a directive with `scope="until"` and a past `expires_at` is not listed
  - `last_publish_at` is `None` on an empty store and the latest `note_publish` after two
  - `set_hold(None)` clears a hold
  - the schema is created on first open and re-opening an existing file does not lose rows
- [ ] **Step 2: Run, fail**
- [ ] **Step 3: Implement.** `PRAGMA journal_mode=WAL`, `PRAGMA busy_timeout=5000`. Claim is one
  statement:
  ```sql
  UPDATE commands SET status='claimed', claimed_by=?, claimed_at=?, attempts=attempts+1
   WHERE id = (SELECT id FROM commands
                WHERE status='pending' AND (deadline_at IS NULL OR deadline_at > ?)
                ORDER BY priority ASC, created_at ASC LIMIT 1)
  RETURNING *
  ```
  Comment why it is one statement: two statements is a race that shows up as one command run twice,
  which on this system means two editions filed for one instruction and a wall that flashes twice.
- [ ] **Step 4: Run, pass**
- [ ] **Step 5: Commit** — `feat(server): the queue, the directive store and the audit log`

---

## Task 6: `proofpng.py` — BMP24 to PNG with zlib

**Files:**
- Create: `server/wpdesk/proofpng.py`, `server/test/fixtures/tiny.bmp`
- Test: `server/test/test_proofpng.py`

**Interfaces:**
- Produces:
  ```python
  def bmp24_to_png(data: bytes) -> bytes
  def convert_dir(path: str, remove_bmp: bool = True) -> list[str]   # returns PNG paths
  ```

`render-check.sh` shells out to `sips`, which is macOS-only, so in the container the sheets stay
5.8 MB BMPs. This is the conversion, in the standard library.

- [ ] **Step 1: Write the fixture generator and the failing test**

The fixture is generated by the test module itself at import time if absent (a 4×3 24-bit BMP with
known pixels), so the repository does not carry a binary blob that nobody can review:

```python
import os, struct, unittest, zlib
from wpdesk import proofpng

HERE = os.path.dirname(__file__)
FIXTURE = os.path.join(HERE, "fixtures", "tiny.bmp")
PIXELS = [(255, 0, 0), (0, 255, 0), (0, 0, 255), (255, 255, 255),
          (0, 0, 0), (255, 255, 0), (0, 255, 255), (255, 0, 255),
          (10, 20, 30), (40, 50, 60), (70, 80, 90), (100, 110, 120)]
W, H = 4, 3


def write_fixture():
    os.makedirs(os.path.dirname(FIXTURE), exist_ok=True)
    row_pad = (-W * 3) % 4
    rows = []
    for y in range(H - 1, -1, -1):                      # BMP rows run bottom-up
        row = b"".join(bytes((b, g, r)) for (r, g, b) in PIXELS[y * W:(y + 1) * W])
        rows.append(row + b"\x00" * row_pad)
    pixel_data = b"".join(rows)
    header = struct.pack("<2sIHHI", b"BM", 14 + 40 + len(pixel_data), 0, 0, 14 + 40)
    info = struct.pack("<IiiHHIIiiII", 40, W, H, 1, 24, 0, len(pixel_data), 2835, 2835, 0, 0)
    with open(FIXTURE, "wb") as f:
        f.write(header + info + pixel_data)


class ProofPngTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        write_fixture()

    def test_it_produces_a_png_signature_and_an_iend(self):
        png = proofpng.bmp24_to_png(open(FIXTURE, "rb").read())
        self.assertEqual(png[:8], b"\x89PNG\r\n\x1a\n")
        self.assertTrue(png.rstrip().endswith(b"IEND\xaeB`\x82"))

    def test_the_pixels_survive_in_the_right_order(self):
        png = proofpng.bmp24_to_png(open(FIXTURE, "rb").read())
        idat = self._chunk(png, b"IDAT")
        raw = zlib.decompress(idat)
        stride = 1 + W * 3
        got = []
        for y in range(H):
            row = raw[y * stride:(y + 1) * stride]
            self.assertEqual(row[0], 0, "filter type 0 on every row")
            for x in range(W):
                got.append(tuple(row[1 + x * 3:4 + x * 3]))
        self.assertEqual(got, PIXELS)      # top-down, RGB

    def test_the_header_reports_the_right_size(self):
        png = proofpng.bmp24_to_png(open(FIXTURE, "rb").read())
        w, h, depth, colour = struct.unpack(">IIBB", self._chunk(png, b"IHDR")[:10])
        self.assertEqual((w, h, depth, colour), (W, H, 8, 2))

    def test_a_file_that_is_not_a_bmp_is_refused(self):
        from wpdesk.errors import BadRequest
        with self.assertRaises(BadRequest):
            proofpng.bmp24_to_png(b"not a bitmap at all")

    def test_a_paletted_bmp_is_refused_rather_than_misread(self):
        from wpdesk.errors import BadRequest
        data = bytearray(open(FIXTURE, "rb").read())
        data[28] = 8                                    # bit depth field
        with self.assertRaises(BadRequest):
            proofpng.bmp24_to_png(bytes(data))

    @staticmethod
    def _chunk(png, kind):
        i, out = 8, b""
        while i < len(png):
            n = struct.unpack(">I", png[i:i + 4])[0]
            k = png[i + 4:i + 8]
            if k == kind:
                out += png[i + 8:i + 8 + n]
            i += 12 + n
        return out
```

- [ ] **Step 2: Run, fail**
- [ ] **Step 3: Implement.** Handle the BMP's bottom-up row order and 4-byte row padding, BGR→RGB,
  filter byte 0 per row, one `IDAT`, `zlib.compress(level=6)`, CRC32 per chunk.
- [ ] **Step 4: Run, pass**
- [ ] **Step 5: Commit** — `feat(server): BMP to PNG in the standard library, because sips is macOS`

---

## Task 7: `gates.py` — the two subprocess gates, and a stub

**Files:**
- Create: `server/wpdesk/gates.py`
- Test: covered by `test_editions.py` via `StubGates`; `SubprocessGates` is exercised by the smoke test (Task 15)

**Interfaces:**
- Produces:
  ```python
  @dataclass(frozen=True)
  class GateResult:
      ok: bool
      output: str
      sheets: tuple[str, ...] = ()

  class Gates(Protocol):
      def validate(self, draft_dir: str) -> GateResult
      def render(self, draft_dir: str, out_dir: str) -> GateResult

  class SubprocessGates:
      def __init__(self, repo: str, timeout: int = 600) -> None
      # validate: python3 <repo>/tools/mock_news_server.py --validate <draft>/news.json
      # render:   <repo>/tools/edition/render-check.sh <draft>/news.json <out_dir>
      #           then proofpng.convert_dir(out_dir)

  class StubGates:
      def __init__(self, validate_ok: bool = True, render_ok: bool = True,
                   output: str = "", sheets: tuple[str, ...] = ()) -> None
      calls: list[str]
  ```

- [ ] **Step 1** Implement `gates.py` with docstrings. Both gates capture combined stdout+stderr,
  cap the captured output at 64 KB (a failing render prints a lot and the desk must not hold a
  megabyte of it per draft), and enforce `timeout`. A timeout is `GateResult(ok=False, ...)` with
  the reason, never an exception that loses the draft.
- [ ] **Step 2** Commit — `feat(server): the two gates, as subprocesses and as a stub`

---

## Task 8: `editions.py` — drafts, gates, pointers, publish

**Files:**
- Create: `server/wpdesk/editions.py`
- Test: `server/test/test_editions.py`

**Interfaces:**
- Consumes: `clock.Clock`, `tiles`, `gates.Gates`, `store.Store`, `schedule.Schedule`, `errors`
- Produces:
  ```python
  @dataclass(frozen=True)
  class CommitResult:
      edition_id: str
      state: str            # "published" | "staged" | "unchanged"
      reason: str           # why it staged, when it did

  class EditionStore:
      def __init__(self, root: str, gates: Gates, store: Store, clock: Clock,
                   keep: int = 30) -> None

      def open_draft(self) -> str
      def put_payload(self, draft: str, data: bytes) -> None
      def put_tile(self, draft: str, tile_id: str, data: bytes) -> None
      def draft_info(self, draft: str) -> dict
      def sweep_drafts(self, older_than: float = 3600) -> int

      def proof(self, draft: str) -> dict
          # {"ok": bool, "validate": str, "render": str, "sheets": [<basename>...]}
      def commit(self, draft: str, sched: Schedule, now: float) -> CommitResult
      def publish_due(self, sched: Schedule, now: float) -> CommitResult | None
      def publish_now(self, reason: str) -> CommitResult | None
      def promote(self, eid: str) -> CommitResult

      def current_id(self) -> str | None
      def staged_id(self) -> str | None
      def read_payload(self, eid: str) -> bytes | None
      def read_tile(self, eid: str, tile_id: str) -> bytes | None
      def read_sheet(self, eid_or_draft: str, name: str) -> bytes | None
      def prune(self) -> int
      def fingerprint(self, draft: str) -> str
  ```

Layout under `root`: `drafts/<uuid>/{news.json,tiles/}`, `editions/<id>/{news.json,tiles/,proof/,meta.json}`,
`current`, `staged`. `meta.json` keys: `id, created_at, published_at, source, validate, render,
dropped_producer_policy, tile_count, bytes`.

- [ ] **Step 1: Write the failing test `server/test/test_editions.py`.** Methods:
  - `open_draft` past `MAX_DRAFTS` raises `Conflict`
  - `put_payload` over the cap raises `TooLarge`; a payload that is not JSON raises `BadRequest`
  - `put_tile` with a bad id raises `BadRequest`; the seventeenth tile raises `Conflict`
  - `proof` with `StubGates(validate_ok=False)` returns `ok=False` and does **not** call render
  - `commit` with a failing gate raises and **leaves `current_id()` unchanged** — the central test
  - the fingerprint is stable across two identical drafts and differs when one tile byte differs
  - committing an identical payload twice returns `state="unchanged"` and does not rewrite `current`
  - a commit inside a quiet window returns `state="staged"`, `current_id()` unchanged,
    `staged_id()` set; `publish_due()` at the boundary publishes it
  - `min_gap_minutes` defers a second commit and `publish_due` releases it once the gap has passed
  - `publish_policy="on_wake"` stages a commit at 06:14 and `publish_due` publishes it at 12:40
  - `publish_policy="manual"` never publishes from `publish_due`; `publish_now` does
  - a hold in force defers even `immediate`
  - **`promote` of an older id makes it current again and the tiles served are that edition's**
  - `prune(keep=2)` keeps the current and the staged edition even when they are old
  - **the atomic swap**: a thread publishing in a loop while another reads `read_payload(current_id())`
    never observes a payload whose tiles are missing
- [ ] **Step 2: Run, fail**
- [ ] **Step 3: Implement.** Publishing is: build `editions/<id>/` complete under a temporary name,
  `os.replace` it into place, `fsync` the directory, write `current.tmp` and `os.replace` it onto
  `current`. Reading resolves the pointer once per request and holds the id.
- [ ] **Step 4: Run, pass**
- [ ] **Step 5: Commit** — `feat(server): drafts, the five gates, and a publish that is one rename`

---

## Task 9: `vault.py` — the notes bridge

**Files:**
- Create: `server/wpdesk/vault.py`
- Test: `server/test/test_vault.py`

**Interfaces:**
- Produces:
  ```python
  SCHEDULE_FILE = "schedule.json"
  STANDING_FILE = "standing.md"
  BLOCKLIST_FILE = "blocklist.md"
  WATCHLIST_FILE = "watchlist.json"
  ERRORS_FILE = "schedule.errors.md"

  class Vault:
      def __init__(self, root: str, cache_path: str, clock: Clock) -> None
      def available(self) -> bool
      def ensure_layout(self) -> None            # writes README.md and defaults, never overwrites
      def load_schedule(self) -> tuple[Schedule, str]    # (schedule, "vault"|"cache"|"default")
      def save_schedule(self, s: Schedule) -> None
      def poll(self) -> bool                     # True when any watched mtime changed
      def read_text(self, name: str) -> str
      def write_brief(self, day: str, text: str) -> str
      def archive(self, eid: str, src_dir: str) -> None
      def prune_archive(self, days: int = 30) -> int
      def context(self) -> dict                  # {"standing":..., "blocklist":..., "watchlist":...}
  ```

- [ ] **Step 1: Failing tests.** Methods:
  - a missing root reports `available() == False` and `load_schedule()` returns the **cache**
  - with no cache either, it returns `DEFAULT_SCHEDULE` and source `"default"`
  - `save_schedule` writes `schedule.json` **and** the cache, and `load_schedule` reads it back equal
  - a `schedule.json` that does not validate leaves the previous schedule in force and writes
    `schedule.errors.md` naming the field
  - `poll()` is False twice in a row with no change, and True after touching `standing.md`
  - `ensure_layout` on an empty directory creates the files, and on a populated one **changes nothing**
  - `archive` copies an edition and `prune_archive` removes one older than the window and keeps a
    newer one
  - `context()` returns empty strings rather than raising when the vault is gone
- [ ] **Step 2–4:** implement, run, pass. Docstring the rule: exactly one writer per file, and the
  vault is authoritative for the human-authored ones.
- [ ] **Step 5: Commit** — `feat(server): the vault bridge, and serving that does not need it`

---

## Task 10: `app.py` — wiring and the scheduler tick

**Files:**
- Create: `server/wpdesk/app.py`
- Test: folded into `server/test/test_http.py`

**Interfaces:**
- Produces:
  ```python
  @dataclass
  class Config:
      data_dir: str
      vault_dir: str
      tokens_path: str
      repo_dir: str
      host: str = "0.0.0.0"
      port: int = 8080
      keep_editions: int = 30

      @staticmethod
      def from_env(env: Mapping[str, str]) -> "Config"

  class Desk:
      def __init__(self, cfg: Config, clock: Clock | None = None,
                   gates: Gates | None = None) -> None
      schedule: Schedule                # current, reloaded by tick()
      def tick(self, now: float | None = None) -> list[str]
          # one scheduler pass: reap commands, reload vault, enqueue due wakes,
          # publish anything due, sweep drafts, prune. Returns what it did.
      def state(self) -> dict           # the GET /api/state document
      def close(self) -> None
  ```

`tick()` is deliberately a pure-ish function of the clock so the tests drive it instead of waiting.
Wake enqueueing must be **idempotent per wake instant** — a tick every 5 s must not enqueue 12
commands a minute. Record the last enqueued wake instant in the store.

- [ ] **Step 1: Failing tests** (in `test_http.py`): a tick crossing a wake instant enqueues exactly
  one `file_edition` command; ticking ten more times enqueues none; a tick crossing the end of a
  quiet window publishes the staged edition; a tick with the vault removed still returns and reports
  `vault: "unavailable"` in `state()`.
- [ ] **Step 2–4:** implement, run, pass
- [ ] **Step 5: Commit** — `feat(server): the desk object and the one scheduler tick`

---

## Task 11: `http.py` and `__main__.py` — the two planes

**Files:**
- Create: `server/wpdesk/http.py`, `server/wpdesk/__main__.py`
- Test: `server/test/test_http.py`

**Interfaces:**
- Produces:
  ```python
  class DeskHTTPRequestHandler(BaseHTTPRequestHandler): ...
  def make_server(desk: Desk, host: str, port: int) -> ThreadingHTTPServer
  def serve_forever(desk: Desk) -> None      # starts the tick thread and the server
  ```

Route table exactly as the spec §2. Long poll: `GET /api/commands/next?wait=N`, N capped at 90,
implemented with a `threading.Condition` the store notifies on `add_command`.

- [ ] **Step 1: Write the failing tests.** Use a real `ThreadingHTTPServer` on port 0 and
  `urllib.request`. Methods:
  - **the disclosure test**: `/`, `/watchlist.json`, `/log/x`, `/api/state` (no token),
    `/tiles/../news.json`, `/tiles/a.bin` for an unknown id — every one is 404 on the device plane
  - every method other than `GET`/`HEAD` on `/news.json` is 405
  - `GET /news.json` before anything is filed is 404, and after a publish returns the payload
    **with** a `policy` block
  - `GET /tiles/<id>.bin` returns the exact bytes and `Content-Type: application/octet-stream`
  - no `Cache-Control`/`ETag` on the device plane
  - `/api/*` with no header is 401; with a bad token 401; with a `producer` token on
    `PUT /api/schedule` 403; with an `operator` token 200
  - the full draft round trip over HTTP: `POST /api/drafts` → `PUT news.json` → `PUT tiles/x.bin`
    → `POST proof` → `POST commit` → `GET /news.json` returns it
  - `POST /api/commands` then `GET /api/commands/next?wait=1` returns it; a second call within the
    same second returns 204 rather than the same command
  - a body over the cap returns 413 with `{"ok":false,"error":"too_large"}`
  - malformed JSON on a control endpoint returns 400 `bad_json`
  - `GET /api/schedule/next` lists transitions
  - `GET /healthz` is 200 with no token
- [ ] **Step 2: Run, fail**
- [ ] **Step 3: Implement.** `__main__.py` reads `Config.from_env(os.environ)`, installs SIGTERM →
  clean shutdown, starts the tick thread at a 5 s period, and logs one line per publish and one per
  vault-availability transition — not one per poll.
- [ ] **Step 4: Run, pass**
- [ ] **Step 5: Commit** — `feat(server): the two planes, and no route from one to the other`

---

## Task 12: the firmware `policy` block

**Files:**
- Modify: `components/news_core/include/news_model.h`, `components/news_core/news_parse.c`,
  `components/news_core/news_model.c`, `components/user_app/user_app.cpp`,
  `components/device_api/device_api.c`, `tools/mock_news_server.py`
- Test: `components/news_core/test/host/test_news_parse.c`

**Interfaces:**
- Produces:
  ```c
  /* news_model.h */
  typedef struct {
      int32_t poll_seconds;   /* 0 = absent. Otherwise 30..86400 */
      int64_t next_change;    /* epoch seconds, 0 = absent */
  } news_policy_t;
  /* inside news_t: */  news_policy_t policy;

  #define NEWS_POLL_MIN 30
  #define NEWS_POLL_MAX 86400
  ```

- [ ] **Step 1: Write the failing host tests** in `test_news_parse.c`:

```c
/* A payload with no policy leaves the struct zeroed, which is what every
 * payload filed before this field existed does. */
static void test_policy_absent(void) { ... expect n.policy.poll_seconds == 0 ... }

/* Out of range clamps rather than rejecting: this block must never be able to
 * cost a page. */
static void test_policy_clamps(void) { 29 -> 30, 86401 -> 86400, -5 -> 30 }

/* A string where a number belongs is the same as absent, like every other
 * field on this wire. */
static void test_policy_wrong_type(void) { ... }

/* THE test. news_hash() fingerprints what reaches the glass and the policy
 * reaches nothing, so a payload that differs only here must not spend
 * twenty-five seconds of flashing to report that a timestamp advanced. */
static void test_policy_is_not_fingerprinted(void)
{
    news_t a, b;
    assert(news_parse(PAYLOAD_WITH_POLICY_A, strlen(...), &a));
    assert(news_parse(PAYLOAD_WITH_POLICY_B, strlen(...), &b));
    assert(a.policy.poll_seconds != b.policy.poll_seconds);
    assert(news_hash(&a) == news_hash(&b));
}
```

- [ ] **Step 2: Build and run the host tests, watch the new ones fail**

```bash
cmake -S components/news_core/test/host -B /tmp/vt && cmake --build /tmp/vt && /tmp/vt/test_news_parse
```

- [ ] **Step 3: Implement the model and the parser.** In `news_model.c`, add the comment above
  `news_hash()` explaining the omission — the omission is invisible otherwise, and somebody will
  "fix" it. Re-measure `sizeof(news_t)` and update **both** `CLAUDE.md` and
  `docs/news-contract.md`; the number has been wrong twice and a third is not free.
- [ ] **Step 4: Run the host tests, watch them pass**
- [ ] **Step 5: Teach `tools/mock_news_server.py` the block** — emit it in `--live`/demo mode? **No.**
  The demo edition carries **no** policy, because absent is the normal case and must be the tested
  one. `--validate` learns the block: `poll_seconds` must be an int in range, `next_change` an int
  ≥ 0, and any other key under `policy` is a warning. Then:
  ```bash
  python3 tools/mock_news_server.py --check      # the fixture is unchanged, since the demo has none
  ```
- [ ] **Step 6: Make the poll interval and the stale floor runtime values** in `user_app.cpp`
  (`:77`, `:102-104`, `:727`, `:823`). Rules, each with a comment:
  - `s_poll_seconds` starts at `CONFIG_WP_NEWS_POLL_SECONDS` and is **not persisted** — a bad policy
    must not survive a reboot
  - after a successful parse, adopt `policy.poll_seconds` when non-zero
  - `next_change` is honoured only when the clock is synced: `time(NULL) >= 1704067200`
  - the wait is `min(poll, next_change - now)` floored at `NEWS_POLL_MIN`
  - `stale_seconds() = max(2 * s_poll_seconds, STALE_FLOOR_SECONDS)`
- [ ] **Step 7: `device_api.c`** — `source.pollSeconds` is the effective value; add
  `source.pollSource` as `"config"` or `"policy"`. Re-run `test_api_json` and check the printed
  margin still fits `DEVICE_API_STATE_BUF_SZ`.
- [ ] **Step 8: Run every host test, then the simulator, then the firmware build**

```bash
cmake -S components/news_core/test/host -B /tmp/vt && cmake --build /tmp/vt
for t in test_news_parse test_news_mock test_news_service test_api_json test_palette \
         test_epd6_transpose test_fit test_chart_scale test_compose; do /tmp/vt/$t || exit 1; done
sh components/provisioning/test/run.sh
python3 tools/mock_news_server.py --check
. ~/esp/v5.4.3/esp-idf/export.sh && idf.py build
```

- [ ] **Step 9: Commit** — `feat(wire): a policy block the fingerprint does not see`

---

## Task 13: `sim/CMakeLists.txt` — build without ESP-IDF

**Files:**
- Modify: `sim/CMakeLists.txt`

- [ ] **Step 1:** Add, before `add_subdirectory(${EX}/managed_components/lvgl__lvgl ...)`:

```cmake
# LVGL comes from the IDF component manager on a machine that has run
# `idf.py build`. In a container there is no IDF and no managed_components/,
# and on a fresh checkout there is not one yet either — so fall back to
# fetching the same version the firmware pins. The tag matches
# main/idf_component.yml's `lvgl/lvgl: ^9.4.0`; pinning it here rather than
# tracking the range is deliberate, because a simulator that is a test must
# not change what it asserts when an upstream release lands.
set(LVGL_DIR ${EX}/managed_components/lvgl__lvgl)
if(EXISTS ${LVGL_DIR}/CMakeLists.txt)
    add_subdirectory(${LVGL_DIR} ${CMAKE_BINARY_DIR}/lvgl)
else()
    include(FetchContent)
    FetchContent_Declare(lvgl
        GIT_REPOSITORY https://github.com/lvgl/lvgl.git
        GIT_TAG        v9.4.0
        GIT_SHALLOW    TRUE)
    FetchContent_MakeAvailable(lvgl)
endif()
```

- [ ] **Step 2: Verify both paths**

```bash
rm -rf sim/build && cd sim && ./sim.sh          # fetches LVGL; must pass
```

- [ ] **Step 3: Commit** — `build(sim): fetch LVGL when there is no ESP-IDF to supply it`

---

## Task 14: the containers

**Files:**
- Create: `server/Dockerfile`, `server/Dockerfile.agent`, `server/compose.yaml`,
  `server/.env.example`, `server/.gitignore`, `server/tunnel/wpnews.yml.example`,
  `server/agent/loop.py`

- [ ] **Step 1: `server/Dockerfile`.** `python:3.12-slim`; `apt-get install --no-install-recommends
  build-essential cmake git libcurl4-openssl-dev tzdata ca-certificates`; copy the repo; build the
  simulator during the image build (`cmake -S sim -B sim/build -DCMAKE_BUILD_TYPE=Release &&
  cmake --build sim/build -j`); `USER` a non-root uid; `HEALTHCHECK` on `/healthz`;
  `CMD ["python3","-m","wpdesk"]`.
- [ ] **Step 2: `server/Dockerfile.agent`.** `node:22-slim`; `npm i -g @anthropic-ai/claude-code`;
  `apt-get install python3 curl`; non-root; `CMD ["python3","/app/agent/loop.py"]`.
- [ ] **Step 3: `server/compose.yaml`.** Three services. `desk` publishes `127.0.0.1:8790:8080`
  (8787–8789 are taken by the existing MCP tunnels), mounts `wpnews-data:/data`,
  `${WPNEWS_VAULT}:/vault`, `${HOME}/.wpnews:/run/secrets:ro`. `agent` mounts the same vault and
  secrets plus `wpnews-scratch:/scratch`, and depends on `desk` being healthy. `cloudflared` runs
  `tunnel --config /etc/cloudflared/wpnews.yml run`, mounting `${HOME}/.cloudflared:/etc/cloudflared:ro`.
  All three `restart: unless-stopped`.
- [ ] **Step 4: `server/.env.example`** — every variable with a comment and **no value**:
  `WPNEWS_VAULT=`, `WPNEWS_TUNNEL_UUID=`, `WPNEWS_HOSTNAME=`, `WPDESK_KEEP_EDITIONS=30`,
  `WPDESK_LOG_LEVEL=INFO`.
- [ ] **Step 5: `server/agent/loop.py`** — the loop from spec §9, standard library only. It must:
  claim with a long poll; assemble the prompt from `PROMPT.md` + `vault.context()` files read
  through the mounted `/vault` + the command text; run `claude --print` with the `file-edition.sh`
  allowlist; open a draft; PUT payload and tiles; POST proof; **download the sheets and feed their
  paths into a follow-up `claude --print` turn**; commit; write the brief; report `done` or `fail`.
  Two retries, then `fail` with the validator output as the result.
- [ ] **Step 6: `server/tunnel/wpnews.yml.example`** as spec §10, and `server/.gitignore` holding
  `tunnel/*.yml`, `!tunnel/*.example`, `.env`.
- [ ] **Step 7: Verify the image builds and the disclosure property holds through Docker**

```bash
docker compose -f server/compose.yaml build desk
docker compose -f server/compose.yaml up -d desk
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8790/healthz      # 200
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8790/api/state    # 401
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8790/watchlist.json  # 404
```

- [ ] **Step 8: Commit** — `feat(server): the containers, and a tunnel config that is an example`

---

## Task 15: `server/test/smoke.sh` — what the wire returns

**Files:**
- Create: `server/test/smoke.sh`

- [ ] **Step 1:** Bring `desk` up, mint a throwaway token into a temporary `tokens.json`, push
  `components/news_core/test/host/fixtures/news.json` with its tiles from `sim/tiles/` through the
  real draft → proof → commit path, then assert `GET /news.json` parses and every
  `GET /tiles/<id>.bin` matches the local file byte-for-byte. This is
  `docs/hosting-cloudflare.md`'s "validate what the wire returns, not what is on the disk",
  automated.
- [ ] **Step 2: Run it, watch it pass**
- [ ] **Step 3: Commit** — `test(server): the smoke test validates what the wire returns`

---

## Task 16: documentation

**Files:**
- Create: `server/README.md`, `docs/desk-server.md`
- Modify: `docs/news-contract.md`, `docs/hosting-cloudflare.md`, `docs/app-control.md`,
  `tools/edition/README.md`, `CLAUDE.md`

- [ ] **Step 1: `docs/desk-server.md`** — the architecture and its arguments in the house voice:
  the two planes and why there is no route between them; the five gates; the three storage roots
  and the SSD argument; commands versus directives; the schedule; the policy block and the hash
  exclusion.
- [ ] **Step 2: `server/README.md`** — install, the tokens, the tunnel, the endpoints, the tests.
- [ ] **Step 3: `docs/news-contract.md`** — a `policy` section: the two fields, the clamps, the
  integer-epoch decision, the hash exclusion, the unsynced-clock rule, and that it does not survive
  a reboot.
- [ ] **Step 4: `docs/hosting-cloudflare.md`** — a third row in the opening table, and a section on
  the tunnel path.
- [ ] **Step 5: `docs/app-control.md`** — `source.pollSource`.
- [ ] **Step 6: `tools/edition/README.md`** — a pointer that this is now the standalone/LAN path.
- [ ] **Step 7: `CLAUDE.md`** — `server/` in the project structure; layer 0 in the verify list; the
  re-measured `sizeof(news_t)`.
- [ ] **Step 8: Commit** — `docs: the desk server, and the policy block on the wire`

---

## Self-review notes

- Spec §2's disclosure requirement is Task 11 step 1; §3's five gates are Task 8; §4's three roots
  are Tasks 8 and 9; §5 and §6 are Task 5; §7 is Task 2; §8 is Task 12; §9 is Task 14 step 5;
  §10 is Task 14 steps 3 and 6; §11 is Tasks 1–13 plus Task 15; §12 is Task 16.
- Types used across tasks: `GateResult` (Task 7 → 8), `Schedule` (2 → 3, 8, 9, 10), `Store` (5 → 8, 10),
  `EditionStore` (8 → 10, 11), `Vault` (9 → 10), `Config`/`Desk` (10 → 11), `Clock` (1 → everywhere).
- `MAX_PAYLOAD_BYTES` / `MAX_TILE_BYTES` / `MAX_TILES` / `MAX_DRAFTS` all live in `tiles.py` (Task 1)
  and are imported by `editions.py` (Task 8) and `http.py` (Task 11). One definition each.
