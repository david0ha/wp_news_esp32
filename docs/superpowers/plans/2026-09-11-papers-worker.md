# Papers — the worker: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Teach the worker a sixth command kind, `paper`, which is the filing
run it already has with the company given rather than chosen: the prompt names
the symbol and stands the rotation down, the rotation file is neither seeded nor
moved, and the commit tells the desk this edition is a paper for that company
rather than the board's next front page.

**Architecture:** `paper` is not a new path. It is `file_edition`'s path with
three differences and no fourth: one branch before the turn (the rotation file
is not seeded, and the prompt carries a symbol), one branch at the commit (a
body that names the target and the company), and a result string that falls out
of the line already there. Everything between — the context directory, the
directives, the draft, the proof, the two revisions, the look at the sheets —
is the same code, reached the same way, which is the point: a paper is a
complete newspaper through the same gates, so it must not be a second producer.

**Tech Stack:** Python 3.11 standard library only (no third-party imports
anywhere in `agent/`), `unittest` under `python3 -m unittest discover`, the
repository's own runner `sh agent/test/run.sh` — no Docker, no network, no API
key on this layer.

**Spec:** [docs/superpowers/specs/2026-09-11-papers-per-ticker-design.md](../specs/2026-09-11-papers-per-ticker-design.md)
— this plan owns **section 4 (Worker)** and the **Agent row of section 8**.
Sections 3 (desk) and 5 (app) are planned separately and are being built in
parallel; the wire between this plan and the desk's is fixed and restated under
Global Constraints. Every test here fakes the desk, so no task in this plan
blocks on the desk's.

## Global Constraints

- **The wire this plan codes against, and does not define.** The desk's plan
  implements all three of these; code against them exactly and do not widen them:
  1. The command row for the new kind is
     `{"kind": "paper", "symbol": "SNDK", "text": "Refresh the paper for SNDK. The company is given; research it and write both pages.", "lang": null, …}`.
     `symbol` is uppercase, 1–8 characters, `[A-Z0-9.\-]`.
  2. `POST /api/drafts/<d>/commit` accepts a JSON body
     `{"target": "paper", "symbol": "SNDK"}` and answers
     `{ok, edition_id, state, reason}` where `state` is `"paper"` or
     `"unchanged"`. It answers `409` with `commit_symbol_mismatch` when the
     draft's `subject.symbol` is not the symbol the body names. **Today's
     no-body call is unchanged for every other kind** and must stay byte-for-byte
     what it is.
  3. The worker's result string for the queue is `"paper <edition id>"` or
     `"unchanged <edition id>"`.
- **A paper commit writes neither pointer.** That is the desk's job, not this
  one. Nothing in this plan may promote, publish or stage anything.
- **The sandbox wall does not move.** `seed_positions`, `seed_calendar` and
  `seed_econ` run for the `calendar` kind and no other, and a `paper` run is one
  of the "no other". `DEFAULT_TOOLS` and `DENY_TOOLS` (`Task,Agent`) do not
  change. No task here widens either.
- **`agent/prompt.py --language-section` is untouched.** The standalone
  producer splices its output into a shell-assembled prompt and names no kind;
  its bytes must not move.
- **No third-party Python in `agent/`.** `os`, `re`, `json`, `shutil`,
  `urllib` and the rest of the standard library only, on the python3 that ships
  in `node:22-slim` (3.11).
- **Every task ends green on `sh agent/test/run.sh`**, which stays layer 0: no
  Docker, no network, no API key. One module at a time is
  `sh agent/test/run.sh -k paper` (the runner forwards its arguments to
  `unittest discover`).
- **The worker must not be deployed behind the desk.** Today's `handle()` reads
  `command.get("kind", "file_edition")` and treats a kind it has never heard of
  as a filing run — so a pre-feature worker handed a `paper` command does not
  refuse it, it writes a page about a company it chose itself and commits it to
  the **board**. The spec's failure table (§6) says otherwise and is wrong on
  that row. Ship this plan's worker before the desk's rotation starts enqueuing,
  and say so in the pull request.
- Commit subjects follow the repository's own: `feat(agent): …`,
  `docs(agent): …` — lowercase, evocative, `--` rather than an em dash in code
  comments. Every commit message ends with the two trailer lines given in each
  task's commit step.

---

## File Structure

**Modified — there are no new files in this plan.**

- `agent/prompt.py` — `paper_tail(symbol)`, a pure function beside
  `ask_section()`, and a `symbol` argument on `build_prompt`. This module stays
  pure: no environment, no clock, no sockets.
- `agent/deskclient.py` — `PAPER_TARGET`, and `commit()` gains keyword-only
  `target` and `symbol`. The one place the commit body is spelled.
- `agent/loop.py` — `PAPER_KIND`, `PAPER_SYMBOL_RE`, and the three differences
  inside `handle()`: the guard and the un-seeded rotation before the turn, the
  symbol into the prompt, the target into the commit.
- `agent/test/test_prompt.py` — the tail, the argument, and the shipped
  contract's new paragraph.
- `agent/test/test_deskclient.py` — the commit body, both ways.
- `agent/test/test_loop.py` — the paper path end to end, and the existing
  per-kind sweeps extended to cover it.
- `tools/edition/PROMPT.md` — one paragraph under "Which company".
- `agent/README.md` — the sixth kind, and one sentence in "The watch list".

Why `paper_tail` is a function in `prompt.py` rather than an entry in `_TAILS`:
every other tail is a constant because every other tail is the same for every
command of its kind. This one names a company, so it is a function of one
argument, exactly as `ask_section(ask_lang)` is. It ends with `_TAIL` itself
rather than restating it, so the filing instruction cannot drift into two
versions.

---

### Task 1: The prompt names the company, and stands the rotation down

The model is about to read a contract whose "Which company" section tells it to
pick one. This is the sentence that says not today, at the one place a model
reads last.

**Files:**
- Modify: `agent/prompt.py` (`_TAILS` is at :160, `build_prompt` at :347, the
  tail is appended at :412 — verify the lines, they drift)
- Test: `agent/test/test_prompt.py`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces:
  - `prompt.paper_tail(symbol: str) -> str` — the paper paragraph followed by
    the ordinary filing tail, `prompt._TAIL`.
  - `prompt.build_prompt(contract, context, directives, command_text, kind="file_edition", lang="en", ask_lang=None, symbol=None) -> str`
    — one new keyword-only-in-practice argument at the end. Task 3 calls it with
    `symbol=`; every existing caller is unaffected.

- [ ] **Step 1: Write the failing test**

Add to `agent/test/test_prompt.py`, after `BuildPromptTest` (which ends with
`test_the_shipped_contract_assembles_on_its_own`, around :214):

```python
class PaperTailTest(unittest.TestCase):
    """The tail for a command whose company the desk already chose.

    Every other tail is a constant because every other tail is the same for
    every command of its kind. This one names a company, so it is a function --
    `ask_section` is the same shape for the same reason.

    What it has to do is contradict the contract above it, which is why it
    exists at all: `PROMPT.md`'s "Which company" section is written as "read
    watchlist.json, take the next symbol", and on this run there is no
    watchlist.json in the directory at all. Saying so plainly, last, is
    cheaper than hoping the model notices the absence.
    """

    CONTRACT = "# The contract\n\nHow anybody writes a producer.\n"

    def _prompt(self, symbol="SNDK", **kw):
        # A neutral instruction on purpose: the real order text names the
        # company itself ("Refresh the paper for SNDK"), so a test written
        # against that text would pass with no tail at all.
        return prompt.build_prompt(self.CONTRACT, [], [], "go",
                                   kind="paper", symbol=symbol, **kw)

    def test_the_company_is_named_in_the_tail(self):
        out = self._prompt()
        self.assertIn("SNDK", out)
        self.assertTrue(out.endswith(prompt.paper_tail("SNDK")))

    def test_the_rotation_is_stood_down_by_name(self):
        # Not "ignore the watchlist" -- the contract's own section title, so
        # the model can tell which paragraph it is being told not to follow.
        out = self._prompt()
        self.assertIn("Which company", out)
        self.assertIn("does not apply", out)
        self.assertIn("watchlist.json", out)

    def test_the_desks_refusal_is_said_out_loud(self):
        # The 409 is the wall, but a turn that hears about it only after 40
        # minutes of research has already spent the money. This is the cheap
        # half of the same rule.
        out = self._prompt()
        self.assertIn("subject.symbol", out)
        self.assertIn("refuses", out)

    def test_it_is_still_a_filing_run(self):
        # The paper paragraph goes in FRONT of the ordinary tail rather than in
        # place of it: a paper is a complete newspaper through the same gates,
        # so the instruction about what to write and not to publish is the same
        # instruction, character for character.
        out = self._prompt()
        self.assertTrue(out.endswith(prompt._TAIL))
        self.assertIn("news.json LAST", out)
        self.assertIn("Do not try to publish", out)

    def test_the_contract_still_comes_first_and_whole(self):
        out = self._prompt()
        self.assertTrue(out.startswith(self.CONTRACT))

    def test_a_korean_paper_still_gets_the_editions_language_section(self):
        # `lang` is the desk's setting and has nothing to do with which company
        # was chosen. A paper in Korean is a Korean edition, by the same
        # section the morning order gets.
        out = self._prompt(lang="ko")
        self.assertIn("# The edition's language", out)
        self.assertIn("Write every reader-facing string in Korean", out)

    def test_a_paper_with_no_symbol_falls_back_to_the_ordinary_tail(self):
        # Defensive, and it must fall back to the SAFE side: `loop.handle`
        # refuses such a command before it ever builds a prompt, so the only
        # way here is a caller that forgot the argument -- and the ordinary
        # filing tail is a prompt that works, where a tail naming "None" is a
        # newspaper about a company called None.
        out = prompt.build_prompt(self.CONTRACT, [], [], "go", kind="paper")
        self.assertTrue(out.endswith(prompt._TAIL))
        self.assertNotIn("does not apply", out)
        self.assertNotIn("given rather than chosen", out)

    def test_no_other_kind_is_told_a_company(self):
        for kind in ("file_edition", "research", "custom", "calendar", "ask"):
            out = prompt.build_prompt(self.CONTRACT, [], [], "t", kind=kind,
                                      symbol="SNDK")
            self.assertNotIn("SNDK", out, kind)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `sh agent/test/run.sh -k PaperTailTest`
Expected: FAIL — `AttributeError: module 'prompt' has no attribute 'paper_tail'`
is not reached yet; the first failures are `TypeError: build_prompt() got an
unexpected keyword argument 'symbol'`.

- [ ] **Step 3: Write minimal implementation**

In `agent/prompt.py`, add after `_TAILS` (the dict at :160), keeping the
module's comment style:

```python
def paper_tail(symbol: str) -> str:
    """The tail for a ``"paper"`` command: the company, then the filing tail.

    Args:
        symbol: the company the desk named, uppercase. ``loop.handle`` has
            already refused a command that did not carry one, so this is never
            empty -- :func:`build_prompt` still falls back to :data:`_TAIL`
            rather than formatting ``None`` into a sentence, because a prompt
            that works beats a prompt about a company called None.

    Returns:
        A paragraph naming the company, followed by :data:`_TAIL` itself.

    In front of the ordinary tail rather than in place of it, and that is the
    whole design of this kind: a paper is a complete newspaper through the same
    gates as the board's edition, so the instruction about what to write and
    what not to publish must be the *same* instruction rather than a second
    copy that drifts.

    What the paragraph has to do is contradict the contract above it. The
    contract's "Which company" section is written as "read watchlist.json, take
    the next symbol after ``last``, unless something outranks the rotation" --
    and on this run there is no watchlist.json in the edition directory at all,
    because :func:`loop.seed_watchlist` does not run for a paper. Saying that
    plainly, at the place a model reads last, is cheaper than hoping it notices
    an absence.

    The desk's refusal is said out loud for the same reason. The 409 on a
    mismatched subject is the wall and it holds whatever this paragraph says,
    but a turn that hears about it only after forty minutes of research has
    already spent the money.
    """
    return (
        f"\nThis is the paper for {symbol}, and the company is given rather than chosen.\n"
        "The contract's \"Which company\" section does not apply to this run: there is no\n"
        "rotation to advance and no watchlist.json in the edition directory to read.\n"
        f"Write the edition for {symbol} and for no other company, whatever else moved\n"
        f"today. `subject.symbol` must be {symbol}: the desk refuses a commit whose subject\n"
        "is another company, and that refusal ends the run with the research already spent.\n"
    ) + _TAIL
```

Then change the signature and the tail line of `build_prompt`. The signature at
:347 becomes:

```python
def build_prompt(contract: str, context: list[tuple[str, str]],
                 directives: list[dict], command_text: str,
                 kind: str = "file_edition", lang: str = "en",
                 ask_lang: str | None = None,
                 symbol: str | None = None) -> str:
```

and the tail line at :412 becomes:

```python
    parts.append(paper_tail(symbol) if kind == "paper" and symbol
                 else _TAILS.get(kind, _TAIL))
```

Add to the `Args:` block of `build_prompt`'s docstring, after `ask_lang`:

```
        symbol: for ``"paper"`` only -- the company the desk named, which
            :func:`paper_tail` writes into the tail. Ignored by every other
            kind, and a ``"paper"`` without one falls back to the ordinary
            filing tail rather than naming nothing: the refusal for a paper
            command that carries no company lives in ``loop.handle``, before a
            prompt is built at all, and a second refusal here would be a second
            place to look.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `sh agent/test/run.sh -k PaperTailTest`
Expected: PASS, 8 tests.

Then the whole module, because `test_the_english_edition_prompt_is_spelled_out_in_full`
compares the ordinary prompt byte for byte and is the guard that this change did
not move it:

Run: `sh agent/test/run.sh -k prompt`
Expected: PASS, no failures.

- [ ] **Step 5: Commit**

```bash
git add agent/prompt.py agent/test/test_prompt.py
git commit -m "$(cat <<'EOF'
feat(agent): the prompt names the company when the desk already chose it

A `paper` command carries its symbol, so the tail says so -- and says that the
contract's "Which company" section, the rotation and the watchlist.json that is
not in the directory do not apply to this run. In front of the ordinary filing
tail rather than in place of it: a paper is a complete newspaper through the
same gates, so the instruction about what to write is the same instruction.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Pxz7nt2DE47CnaMzY4kvNJ
EOF
)"
```

---

### Task 2: A commit that files a paper rather than the board's front page

One method, one body, one refusal. The desk decides what a target means; this is
the only place the worker spells one.

**Files:**
- Modify: `agent/deskclient.py` (`commit()` at :386)
- Test: `agent/test/test_deskclient.py`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces:
  - `deskclient.PAPER_TARGET = "paper"` — the word, in one place, imported by
    `loop.py` in Task 3.
  - `DeskClient.commit(draft: str, *, target: str | None = None, symbol: str | None = None) -> dict`
    — `target=None` sends `{}` to `POST /api/drafts/<d>/commit`, exactly as
    today. `target=PAPER_TARGET` sends `{"target": "paper", "symbol": "<S>"}`.
    Raises `ValueError` for a paper commit with no symbol and for a symbol with
    no target; raises `RuntimeError` on any non-200, message redacted.

- [ ] **Step 1: Write the failing test**

Add to `agent/test/test_deskclient.py`, after `ErrorTest` (which ends around
:350) and before `PutNotesTest`:

```python
class CommitTest(unittest.TestCase):
    """What a commit says it is for.

    The board's commit is the one this client has always sent and it must stay
    byte-identical: a desk that has never heard of a target sees exactly what
    it saw before. A paper commit adds the two fields the desk's index is built
    from, and the second of them -- the symbol -- is the wall: the desk refuses
    (409) when the draft's subject is another company, which is what keeps a
    turn that drifted from filing its page under this name.
    """

    DRAFT = "d" * 32

    def test_a_board_commit_sends_the_empty_body_it_always_sent(self):
        desk, opener = client((200, b'{"ok":true,"state":"published",'
                                    b'"edition_id":"' + b"e" * 32 + b'"}'))
        out = desk.commit(self.DRAFT)
        req = opener.requests[0]
        self.assertEqual(req.full_url,
                         "http://desk:8080/api/drafts/%s/commit" % self.DRAFT)
        self.assertEqual(req.data, b"{}")
        self.assertEqual(out["state"], "published")

    def test_a_paper_commit_names_the_target_and_the_company(self):
        desk, opener = client((200, b'{"ok":true,"state":"paper",'
                                    b'"edition_id":"' + b"e" * 32 + b'"}'))
        out = desk.commit(self.DRAFT, target=deskclient.PAPER_TARGET,
                          symbol="SNDK")
        self.assertEqual(json.loads(opener.requests[0].data),
                         {"target": "paper", "symbol": "SNDK"})
        self.assertEqual(out["state"], "paper")

    def test_a_paper_commit_with_no_company_never_reaches_the_wire(self):
        # A caller's mistake, not a desk answer -- put_notes refuses naming
        # both or neither owners the same way and for the same reason.
        desk, opener = client()
        with self.assertRaises(ValueError):
            desk.commit(self.DRAFT, target=deskclient.PAPER_TARGET)
        self.assertEqual(opener.requests, [])

    def test_a_company_with_no_target_never_reaches_the_wire_either(self):
        # The dangerous half: this would otherwise be a board commit that
        # publishes to the glass while the caller believed it was filing a
        # paper for one company.
        desk, opener = client()
        with self.assertRaises(ValueError):
            desk.commit(self.DRAFT, symbol="SNDK")
        self.assertEqual(opener.requests, [])

    def test_a_refused_subject_comes_back_as_a_failure_that_says_why(self):
        # Spec section 6's first row: the run fails with the reason in the
        # queue, where an operator reads it, and rotation orders it again.
        desk, _ = client((409, b'{"ok":false,"error":"commit_symbol_mismatch",'
                               b'"detail":"draft subject is AAPL, not SNDK"}'))
        with self.assertRaises(RuntimeError) as caught:
            desk.commit(self.DRAFT, target=deskclient.PAPER_TARGET,
                        symbol="SNDK")
        self.assertIn("409", str(caught.exception))
        self.assertIn("commit_symbol_mismatch", str(caught.exception))
```

- [ ] **Step 2: Run test to verify it fails**

Run: `sh agent/test/run.sh -k CommitTest`
Expected: FAIL — `AttributeError: module 'deskclient' has no attribute
'PAPER_TARGET'`, and `TypeError: commit() got an unexpected keyword argument
'target'`.

- [ ] **Step 3: Write minimal implementation**

In `agent/deskclient.py`, add a module constant beside the other wire constants
(near `DESK_ID_RE` / `MAX_NOTES_BYTES` at the top):

```python
#: The commit target that records an edition without touching the board's
#: pointers. One word, in one place, because `loop` passes it and this module
#: sends it -- a literal in both files is a typo that reaches the desk as a
#: board commit, which publishes to the glass.
PAPER_TARGET = "paper"
```

and replace `commit()` (:386) with:

```python
    def commit(self, draft: str, *, target: str | None = None,
               symbol: str | None = None):
        """Turn a proofed draft into an edition. Returns what the desk did with it.

        Args:
            target: :data:`PAPER_TARGET` to file this edition as the newest
                paper for ``symbol`` -- recorded, readable, and **neither
                published nor staged**. ``None`` is the board commit this
                method has always been, and it sends the same empty body it
                always sent, so a desk that has never heard of a target sees no
                change at all.
            symbol: the company a paper commit claims. The desk compares it
                against the draft's ``subject.symbol`` and answers 409
                ``commit_symbol_mismatch`` when they differ -- the wall that
                keeps a turn which drifted to another company from filing its
                page under this name, because the index is derived from the
                subject rather than from the order.

        Raises:
            ValueError: a paper commit with no symbol, or a symbol with no
                target. Both are the caller's mistake rather than a desk
                answer, so neither reaches the wire -- :meth:`put_notes`
                refuses an owner it cannot name the same way. The second is the
                dangerous one: without it, a caller that forgot the target
                sends a *board* commit and publishes one company's paper to the
                glass.
            RuntimeError: the desk answered anything but 200, redacted and
                short.
        """
        if target == PAPER_TARGET and not symbol:
            raise ValueError("commit: a paper commit must name its company")
        if symbol and target != PAPER_TARGET:
            raise ValueError("commit: a symbol means nothing without "
                             "target=%r" % PAPER_TARGET)
        body = {"target": target, "symbol": symbol} if target else {}
        status, doc = self._json("POST", "/api/drafts/%s/commit" % draft, body,
                                 timeout=900)
        if status != 200:
            raise self._fail("commit", status, doc)
        return doc
```

- [ ] **Step 4: Run test to verify it passes**

Run: `sh agent/test/run.sh -k CommitTest`
Expected: PASS, 5 tests.

Run: `sh agent/test/run.sh`
Expected: PASS — the whole worker suite, including `ErrorTest`'s
`lambda d: d.commit("d")`, which still calls the board form positionally.

- [ ] **Step 5: Commit**

```bash
git add agent/deskclient.py agent/test/test_deskclient.py
git commit -m "$(cat <<'EOF'
feat(agent): a commit that files a paper rather than the board's front page

`commit(draft, target="paper", symbol=S)` sends the body the desk's paper
commit reads; a commit with no target sends the same empty body it always did,
so nothing about the board's path moves. A symbol without a target and a paper
without a symbol are refused before the wire -- the first would publish one
company's page to the glass while the caller believed it was filing a paper.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Pxz7nt2DE47CnaMzY4kvNJ
EOF
)"
```

---

### Task 3: The paper path — a filing run whose company is given

The three differences, landing together. They land together on purpose: a
worker that knew the kind but committed it to the board would put one company's
paper on the glass, so there is no half of this worth shipping on its own.

**Files:**
- Modify: `agent/loop.py` — constants beside `ASK_KIND` (:118), and `handle()`
  (:1269): the guard at the top, `seed_watchlist` (:1319), the `build_prompt`
  call (:1383), the commit (:1485), `persist_watchlist` (:1495)
- Test: `agent/test/test_loop.py` — a new `HandlePaperTest`, plus the per-kind
  sweeps in `SeedingSplitTest` (:569) and the `CalendarDesk` fake (:500)

**Interfaces:**
- Consumes:
  - `prompt.build_prompt(..., symbol=None)` and `prompt.paper_tail(symbol)` from
    Task 1.
  - `deskclient.PAPER_TARGET` and
    `DeskClient.commit(draft, *, target=None, symbol=None)` from Task 2. **Task 2
    must land first** — this task calls that signature.
- Produces:
  - `loop.PAPER_KIND = "paper"` and `loop.PAPER_SYMBOL_RE`.
  - `handle()` accepting a command dict carrying `"symbol"`, and finishing a
    paper run with `"paper <edition id>"` or `"unchanged <edition id>"`.

Note what is *not* here: the result string needs no code. The last line of
`handle()` already finishes with `"%s %s" % (result.get("state"), result.get("edition_id"))`,
and the desk's paper commit answers `state: "paper"` or `"unchanged"`. The test
below is what turns that coincidence into a fact somebody can rely on.

- [ ] **Step 1: Write the failing test**

First extend the shared fake so every kind can reach a commit. In
`agent/test/test_loop.py`, `CalendarDesk` (:500): add `self.commit_calls = []`
to `__init__` beside `self.commits = []`, and replace its `commit`:

```python
    def commit(self, draft, *, target=None, symbol=None):
        self.commits.append(draft)
        self.commit_calls.append({"draft": draft, "target": target,
                                  "symbol": symbol})
        return {"state": "staged", "edition_id": "e" * 32}
```

(`self.commits` keeps its old shape so the existing assertions on it stand.)

Then, in `SeedingSplitTest`, teach `run_seeding` to post a symbol for the new
kind — replace the three lines at the end of that helper (:628-631):

```python
        cid = ("%s" % kind).ljust(32, "0")[:32]
        desk = CalendarDesk(positions=self.POSITIONS, calendar=None, econ=[])
        command = {"id": cid, "kind": kind, "text": "go"}
        if kind == "paper":
            # The desk never posts one without it, and `handle` refuses a
            # command that arrives without one -- so a sweep that left it out
            # would be measuring the refusal rather than the seeding.
            command["symbol"] = "AAAA"
        loop.handle(self.cfg, desk, command, {})
        return os.path.join(self.tmp, cid)
```

Extend the three sweeps in that class to cover `paper`, and add the rotation's
own case. Replace the kind tuples at :636, :651 and :661 so each reads
`("file_edition", "research", "custom", "ask", "paper")` — except the third,
whose positive case is `ask`, so it becomes
`("file_edition", "research", "custom", "calendar", "paper")` — and rename that
third test, whose old name now collides with the name of a kind:

```python
    def test_the_served_edition_is_seeded_for_an_ask_and_for_no_other_kind(self):
```

Then replace `test_the_watch_list_is_seeded_for_every_kind_including_the_book`
(:668), whose claim is no longer true:

```python
    def test_the_watch_list_is_seeded_for_every_kind_but_a_paper(self):
        # It is the universe the paper rotates through and, for the book, one
        # more place to look for a date -- so both jobs get it, and it is
        # seeded from the operator's own directory rather than from the desk,
        # which is why it is not part of the positions split.
        #
        # A `paper` is the exception and the reason is the rotation itself: the
        # company is already chosen, so the file has nothing to offer the turn
        # and one thing to cost it -- a model handed a cursor it was told to
        # update will update it, and tomorrow's board edition would skip a
        # company because a paper run advanced past it overnight.
        path = os.path.join(self.tmp, "watchlist.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump({"symbols": ["AAAA"], "last": "AAAA"}, f)
        self.cfg = loop.Settings.from_env({"CLAUDEPOST_SCRATCH": self.tmp,
                                           "CLAUDEPOST_WATCHLIST": path})
        for kind in ("file_edition", "calendar"):
            with self.subTest(kind=kind):
                workdir = self.run_seeding(kind)
                self.assertTrue(
                    os.path.exists(os.path.join(workdir, "watchlist.json")))
        workdir = self.run_seeding("paper")
        self.assertFalse(os.path.exists(os.path.join(workdir, "watchlist.json")))
```

Now the new class. Add it after `HandleAskTest` (which ends at
`test_an_ordinary_filing_run_still_moves_the_rotation`, around :1597) and before
`AuthRouteTest`:

```python
class HandlePaperTest(unittest.TestCase):
    """`handle()`'s sixth kind: the filing run with the company given.

    Three differences from `file_edition` and deliberately no fourth -- the
    context directory, the directives, the draft, the proof, the two revisions
    and the look at the sheets are the same code reached the same way, because
    a paper is a complete newspaper through the same gates rather than a
    lighter dossier.
    """

    class Desk(CalendarDesk):
        """CalendarDesk with a commit state this test chooses."""

        def __init__(self, state="paper"):
            super().__init__()
            self.state = state

        def commit(self, draft, *, target=None, symbol=None):
            self.commits.append(draft)
            self.commit_calls.append({"draft": draft, "target": target,
                                      "symbol": symbol})
            return {"state": self.state, "edition_id": "e" * 32}

    class RefusingDesk(Desk):
        """A desk that will not file this page under this name."""

        def commit(self, draft, *, target=None, symbol=None):
            raise RuntimeError("commit: 409 {'error': 'commit_symbol_mismatch'}")

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.cfg = loop.Settings.from_env({"CLAUDEPOST_SCRATCH": self.tmp})
        real = loop.read_contract
        loop.read_contract = lambda repo, kind="file_edition": "the contract"
        self.addCleanup(setattr, loop, "read_contract", real)
        self.seen = {}

    def _patch_run_claude(self, fn):
        real = loop.run_claude
        loop.run_claude = fn
        self.addCleanup(setattr, loop, "run_claude", real)

    def _files_a_page(self, also_moves_the_cursor=False):
        def fake_run_claude(cfg, text, workdir, extra_env, *_):
            self.seen["prompt"] = text
            self.seen["watchlist"] = os.path.exists(
                os.path.join(workdir, "watchlist.json"))
            with open(os.path.join(workdir, "news.json"), "w",
                      encoding="utf-8") as f:
                f.write('{"subject": {"symbol": "SNDK"}}')
            if also_moves_the_cursor:
                # As if the model had written one anyway. It has no reason to
                # -- nothing seeded one and the prompt does not mention it --
                # but the operator's cursor must not depend on that.
                with open(os.path.join(workdir, "watchlist.json"), "w",
                          encoding="utf-8") as f:
                    json.dump({"symbols": ["AAAA", "BBBB"], "last": "BBBB"}, f)
            return 0
        return fake_run_claude

    def _command(self, cid="1" * 32, symbol="SNDK"):
        return {"id": cid, "kind": "paper", "symbol": symbol,
                "text": "Refresh the paper for %s. The company is given; "
                        "research it and write both pages." % symbol}

    def test_the_turn_is_told_which_company_it_is_writing_about(self):
        # Against phrases only the tail carries: the order's own text names
        # the company too, so "SNDK is in the prompt" would pass with no tail.
        self._patch_run_claude(self._files_a_page())
        loop.handle(self.cfg, self.Desk(), self._command(), {})
        self.assertIn("does not apply to this run", self.seen["prompt"])
        self.assertIn("for no other company", self.seen["prompt"])

    def test_the_rotation_file_is_not_in_the_directory_at_all(self):
        path = os.path.join(self.tmp, "watchlist.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump({"symbols": ["AAAA", "BBBB"], "last": "AAAA"}, f)
        cfg = loop.Settings.from_env({"CLAUDEPOST_SCRATCH": self.tmp,
                                      "CLAUDEPOST_WATCHLIST": path})
        self._patch_run_claude(self._files_a_page())
        loop.handle(cfg, self.Desk(), self._command(), {})
        self.assertFalse(self.seen["watchlist"])

    def test_the_cursor_is_where_the_operator_left_it(self):
        # The rotation is the BOARD's, and tomorrow's morning order reads it.
        # A paper run that advanced it would make the board skip a company
        # because something unrelated was refreshed overnight -- and at the
        # default cadence there are more paper runs in a day than editions.
        path = os.path.join(self.tmp, "watchlist.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump({"symbols": ["AAAA", "BBBB"], "last": "AAAA"}, f)
        cfg = loop.Settings.from_env({"CLAUDEPOST_SCRATCH": self.tmp,
                                      "CLAUDEPOST_WATCHLIST": path})
        self._patch_run_claude(self._files_a_page(also_moves_the_cursor=True))
        desk = self.Desk()
        loop.handle(cfg, desk, self._command(), {})
        self.assertEqual(desk.commits, ["d" * 32])
        with open(path, encoding="utf-8") as f:
            self.assertEqual(json.load(f)["last"], "AAAA")

    def test_the_commit_carries_the_target_and_the_company(self):
        self._patch_run_claude(self._files_a_page())
        desk = self.Desk()
        loop.handle(self.cfg, desk, self._command(), {})
        self.assertEqual(desk.commit_calls,
                         [{"draft": "d" * 32, "target": "paper",
                           "symbol": "SNDK"}])

    def test_the_result_says_paper_and_the_edition(self):
        self._patch_run_claude(self._files_a_page())
        desk = self.Desk(state="paper")
        cid = "2" * 32
        loop.handle(self.cfg, desk, self._command(cid=cid), {})
        self.assertEqual(desk.finished, [(cid, True, "paper " + "e" * 32)])

    def test_a_paper_the_desk_had_already_says_unchanged(self):
        self._patch_run_claude(self._files_a_page())
        desk = self.Desk(state="unchanged")
        cid = "3" * 32
        loop.handle(self.cfg, desk, self._command(cid=cid), {})
        self.assertEqual(desk.finished, [(cid, True, "unchanged " + "e" * 32)])

    def test_a_command_with_no_company_fails_before_the_turn(self):
        # The whole of a paper run is "write about this company", so a command
        # that does not say which is forty minutes of research against nothing
        # -- and, worse, a page about whichever company the model picked,
        # filed under a name the desk would then refuse.
        ran = []
        self._patch_run_claude(lambda *a, **k: ran.append(1) or 0)
        desk = self.Desk()
        cid = "4" * 32
        loop.handle(self.cfg, desk, {"id": cid, "kind": "paper", "text": "go"}, {})
        self.assertEqual(ran, [])
        self.assertEqual(desk.commits, [])
        self.assertEqual(len(desk.finished), 1)
        self.assertEqual(desk.finished[0][:2], (cid, False))
        self.assertIn("company", desk.finished[0][2])

    def test_a_symbol_that_is_not_one_is_refused_the_same_way(self):
        # It reaches a prompt and a commit body, and on the desk's side a
        # lookup: the shapes worth refusing are the ones that are not a ticker
        # at all.
        for bad in ("", "   ", "TOOLONGSYMBOL", "NVDA;rm -rf /", "../../etc",
                    "NV DA", 7, None):
            with self.subTest(symbol=bad):
                ran = []
                self._patch_run_claude(lambda *a, **k: ran.append(1) or 0)
                desk = self.Desk()
                loop.handle(self.cfg, desk,
                            {"id": "5" * 32, "kind": "paper", "symbol": bad,
                             "text": "go"}, {})
                self.assertEqual(ran, [])
                self.assertEqual(desk.finished[0][1], False)

    def test_a_lowercase_symbol_is_uppercased_once_for_both_uses(self):
        # The desk sends uppercase. This is for a command posted by hand, and
        # it normalises in ONE place so the prompt and the commit body cannot
        # disagree -- a page written about "sndk" and committed as "SNDK" would
        # pass every check here and be refused at the desk.
        self._patch_run_claude(self._files_a_page())
        desk = self.Desk()
        loop.handle(self.cfg, desk, self._command(symbol="sndk"), {})
        self.assertEqual(desk.commit_calls[0]["symbol"], "SNDK")
        self.assertIn("SNDK", self.seen["prompt"])

    def test_a_desk_that_refuses_the_subject_fails_the_command(self):
        # Spec section 6, first row. `handle` does not catch it: `main` does,
        # and finishes the command with the reason, which is where an operator
        # reads it and where rotation's next pass starts from.
        self._patch_run_claude(self._files_a_page())
        with self.assertRaises(RuntimeError) as caught:
            loop.handle(self.cfg, self.RefusingDesk(), self._command(), {})
        self.assertIn("commit_symbol_mismatch", str(caught.exception))

    def test_a_turn_that_wrote_no_page_fails_as_an_ordered_page_does(self):
        # Not a note on the command: a paper was ordered, so a run that filed
        # nothing is a failure, exactly as a `file_edition` that produced no
        # news.json is. `custom` is the kind that decides from the disk, and
        # this is not that kind.
        self._patch_run_claude(lambda *a, **k: 0)
        desk = self.Desk()
        with self.assertRaises(RuntimeError):
            loop.handle(self.cfg, desk, self._command(), {})
        self.assertEqual(desk.commits, [])
```

- [ ] **Step 2: Run test to verify it fails**

Run: `sh agent/test/run.sh -k HandlePaperTest`
Expected: FAIL — a paper command falls through to the ordinary filing path, so
the prompt carries no symbol (`"SNDK" not found`), `commit_calls` records
`{"target": None, "symbol": None}`, the cursor moves to `BBBB`, and the
no-symbol command runs a turn instead of failing.

- [ ] **Step 3: Write minimal implementation**

In `agent/loop.py`, add beside `ASK_KIND` (:118):

```python
#: The command kind whose company the desk names instead of the rotation
#: choosing it: a paper for one company on the watch list, refreshed on a
#: cadence, filed as an edition that never touches the board's pointers. It is
#: `file_edition`'s path with three differences -- see :func:`handle`.
PAPER_KIND = "paper"

#: What a ``paper`` command's ``symbol`` may be: the desk's own rule
#: (uppercase, one to eight of letter, digit, dot or hyphen), restated here
#: for :data:`TILE_ID_RE`'s reason. This value is written into a prompt and
#: into a commit body, and the two ends of a bearer token are two programs: a
#: worker that trusted whatever arrived under that key would put it in front
#: of a model and then on the wire.
PAPER_SYMBOL_RE = re.compile(r"^[A-Z0-9.\-]{1,8}\Z")
```

and add `PAPER_TARGET` to the import at :61:

```python
from deskclient import (DeskClient, MAX_NOTES_BYTES, PAPER_TARGET,
                        load_agent_env, read_token)
```

In `handle()`, add a bullet to the docstring after the `"ask"` one:

```
    - ``"paper"`` is ``"file_edition"`` with the company already chosen, and
      it is that path rather than a fourth branch: the same contract, the same
      draft, the same proof, the same two revisions, the same look at the
      sheets. Three things differ and nothing else does. The prompt names the
      symbol and says the contract's rotation does not apply; the rotation file
      is neither seeded nor persisted, because the cursor belongs to the
      board's morning edition and there are more paper runs in a day than
      editions; and the commit says which company it is filing under, which is
      the wall -- the desk refuses a draft whose subject is somebody else.
```

Then the guard, at the top of the body, immediately after `kind` is read (:1310):

```python
    cid = command["id"]
    kind = command.get("kind", "file_edition")
    calendar = kind == CALENDAR_KIND
    ask = kind == ASK_KIND
    paper = kind == PAPER_KIND
    symbol = command.get("symbol") if paper else None
    # `isinstance` rather than `str()`: a JSON number under that key is a
    # malformed command, and `str(7)` is "7", which matches the pattern below
    # and would file a paper for a company called 7.
    symbol = symbol.strip().upper() if isinstance(symbol, str) else None
    if paper and not (symbol and PAPER_SYMBOL_RE.match(symbol)):
        # Before the workdir and before the turn, because the whole of a paper
        # run is "write about this company". A command that does not say which
        # would otherwise spend forty minutes researching a company the model
        # picked for itself, and then be refused at the commit for filing it
        # under a name that does not match -- a failure that costs the same as
        # the work.
        #
        # Upper-cased once, here, so the prompt and the commit body cannot
        # disagree: the desk sends uppercase and this is for a command posted
        # by hand.
        desk.finish(cid, False, "a paper command must name the company it is "
                                "for; symbol was %r" % (command.get("symbol"),))
        return
    workdir = os.path.join(cfg.scratch, cid)
```

The seeding call (:1319) becomes:

```python
    if not paper:
        # Not on the paper path: the company is already chosen, so the file has
        # nothing to offer this turn and one thing to cost it. The cursor in it
        # is the *board's* rotation, read by tomorrow's morning order, and a
        # model handed a file the contract tells it to update will update it.
        # At the default cadence there are more paper runs in a day than
        # editions, so the board would skip a company every night.
        seed_watchlist(cfg, workdir)
```

The prompt call (:1383) gains one argument:

```python
    text = prompt.build_prompt(
        read_contract(cfg.repo, kind),
        prompt.read_context_dir(cfg.context_dir),
        desk.directives(),
        command.get("text", ""),
        kind=kind,
        lang=desk.settings().get("lang", "en"),
        ask_lang=command.get("lang"),
        symbol=symbol)
```

The commit (:1485) becomes:

```python
    # Keyword arguments through a dict rather than a branch with two calls in
    # it: every other kind must keep sending the body it has always sent, and
    # two call sites is two places for that to stop being true.
    result = desk.commit(draft, **({"target": PAPER_TARGET, "symbol": symbol}
                                   if paper else {}))
```

and the persist (:1493) grows the second exemption:

```python
    if not ask and not paper:
```

with its comment extended by one sentence:

```
        # Nor on the paper path, for the other half of the same reason: that
        # run was never given the file, so what would come back is whatever a
        # model wrote into a name that happened to be free.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `sh agent/test/run.sh -k HandlePaperTest`
Expected: PASS, 11 tests.

Run: `sh agent/test/run.sh`
Expected: PASS — the whole worker suite, including `SeedingSplitTest`'s
extended sweeps and `HandleAskTest`'s two rotation tests, which pin the
exemption to `ask` and `paper` and to nothing else.

- [ ] **Step 5: Commit**

```bash
git add agent/loop.py agent/test/test_loop.py
git commit -m "$(cat <<'EOF'
feat(agent): a paper is a filing run whose company is given

`paper` takes `file_edition`'s path with three differences and no fourth. The
prompt names the symbol; the rotation file is neither seeded nor persisted,
because that cursor is the board's and there are more paper runs in a day than
editions; and the commit names the target and the company, which is what lets
the desk refuse a page that drifted to somebody else. The result string --
"paper <eid>" or "unchanged <eid>" -- needed no code and now has a test.

A command that names no company is refused before the workdir: the whole of
this run is "write about this company", so the alternative is forty minutes
spent on one the model picked and a commit the desk then refuses.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Pxz7nt2DE47CnaMzY4kvNJ
EOF
)"
```

---

### Task 4: The two documents that describe this to somebody else

The contract the model reads and the README an operator reads. The contract's
paragraph is load-bearing: `tools/edition/PROMPT.md` is read by the standalone
producer and by any worker anybody writes, and the tail from Task 1 contradicts
a section of it — so that section has to know.

**Files:**
- Modify: `tools/edition/PROMPT.md` (the "Which company" section, :58-73)
- Modify: `agent/README.md` ("What it does with one instruction", the `ask`
  paragraph ends around :198; "The watch list", :311)
- Test: `agent/test/test_prompt.py`

**Interfaces:**
- Consumes: `prompt.paper_tail` from Task 1 (the test asserts the contract and
  the tail agree about the section's name).
- Produces: nothing other tasks consume.

- [ ] **Step 1: Write the failing test**

Add to `agent/test/test_prompt.py`, inside `PaperTailTest` from Task 1:

```python
    def test_the_shipped_contract_knows_the_rotation_can_be_stood_down(self):
        # The tail contradicts a section of PROMPT.md, and PROMPT.md is read by
        # the standalone producer and by any worker anybody else writes -- so
        # the contradiction has to be in the contract too, not only in the
        # prompt this worker happens to assemble. Asserted against the section
        # rather than the file, because "paper" appears all over a document
        # about newspapers.
        here = os.path.dirname(os.path.abspath(__file__))
        path = os.path.join(here, "..", "..", "tools", "edition", "PROMPT.md")
        with open(path, encoding="utf-8") as f:
            contract = f.read()
        section = contract.split("## Which company")[1].split("\n## ")[0]
        self.assertIn("`paper`", section)
        self.assertIn("does not apply", section)
        self.assertIn("subject.symbol", section)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `sh agent/test/run.sh -k PaperTailTest`
Expected: FAIL — `AssertionError: '`paper`' not found in ...` (the "Which
company" section still says only that the rotation chooses).

- [ ] **Step 3: Write minimal implementation**

In `tools/edition/PROMPT.md`, insert after the paragraph ending "…the device
decides what fits." (:73), before `## The minimum research checklist`:

```markdown
**Unless the order names the company.** A `paper` order — "Refresh the paper for
SNDK" — is the desk asking for that company and no other, and everything above is
suspended for that run: there is no `watchlist.json` in the edition directory, there
is no cursor to advance, and a company that did something more interesting today is
still not the subject. `subject.symbol` must be the symbol the order named; the desk
refuses the commit when it is not, and the refusal arrives after the research rather
than before it.
```

In `agent/README.md`, add after the `ask` paragraphs (the one ending "…a stale
paper beats an empty one.", around :203) and before `## The second job`:

```markdown
A sixth kind, `paper`, is the same filing run with the company already chosen.
The desk keeps a current newspaper for every company on the watch list and
orders the stalest one whenever the queue is empty, so the command carries a
`symbol` beside its text and the run writes that company's edition: same
contract, same draft, same proof, same two revisions, same look at the sheets.
Three things differ. The prompt names the symbol and says the contract's "Which
company" section does not apply; the watch list is not seeded into the edition
directory and not copied back out, because that cursor belongs to the board's
morning edition; and the commit says which company it is filing under
(`{"target": "paper", "symbol": "SNDK"}`), which the desk checks against the
payload's own `subject.symbol` and refuses on a mismatch. The result is `paper
<edition id>` or `unchanged <edition id>`. A paper is recorded and readable and
**does not reach the glass**: putting one on the board is an operator's tap in
the app, not something this worker can do.
```

and in "The watch list", after the paragraph ending "…the worker adds what it
found." (:331):

```markdown
A `paper` run is the one kind that gets none of this. Its company came with the
order, so the file has nothing to offer it and one thing to cost it: a model
handed a cursor the contract tells it to update will update it, and at the
default cadence there are more paper runs in a day than editions — the board's
rotation would skip a company every night for a reason nobody could see.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `sh agent/test/run.sh -k PaperTailTest`
Expected: PASS, 9 tests.

Run: `sh agent/test/run.sh`
Expected: PASS — the whole worker suite, which is this plan's deliverable
complete.

- [ ] **Step 5: Commit**

```bash
git add tools/edition/PROMPT.md agent/README.md agent/test/test_prompt.py
git commit -m "$(cat <<'EOF'
docs(agent): a paper order names the company, and the rotation stands aside

The tail this worker appends contradicts PROMPT.md's "Which company" section,
and PROMPT.md is read by the standalone producer and by any worker anybody else
writes -- so the contract carries the exception too, with a test that the two
agree. The README gains the sixth kind and the one sentence about why a paper
run is handed no watch list.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Pxz7nt2DE47CnaMzY4kvNJ
EOF
)"
```

---

## What this plan deliberately does not do

- **It does not teach the worker which papers are stale.** The rotation lives in
  `Desk.tick()` and is the desk plan's. This worker claims whatever it is given,
  as it always has — there is no per-kind allowlist in `agent/loop.py` and this
  plan does not add one.
- **It does not publish.** `promote`, `/api/publish` and `/api/papers/<S>/publish`
  are the desk's and the app's. A paper run finishes with an edition recorded and
  the glass untouched.
- **It does not add a second worker container.** The `ask`-behind-a-paper latency
  in the spec's §1 is accepted until it is measured.
- **It does not touch `agent/prompt.py`'s `--language-section` printer**, the
  standalone producer, the image, or `agent/compose.yaml`. A paper run needs no
  new mount, no new variable and no new credential.
