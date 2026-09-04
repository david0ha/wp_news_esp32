# Edition Language Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the operator choose the language the edition is written in, and make the board and the phone print it — Korean first.

**Architecture:** One new top-level wire field, `lang`, travels with every edition and decides everything downstream: which fixed strings the board prints, which break rule the copyfitter uses, which type ramp the phone draws with. Hangul reaches the glass through six generated Korean faces chained as LVGL `fallback` fonts behind the six Latin text faces, so no call site changes. The desk holds the setting in `<data>/settings.json`; the agent reads it and writes the edition in that language; the validator gates Korean text against the exact glyph set the faces carry.

**Tech Stack:** ESP-IDF v5.4.3, LVGL 9.5 (device) / 9.4 (sim FetchContent), C host tests (plain C, `th.h`), Python 3 stdlib (desk, agent, tools; `unittest`), lv_font_conv via `npx`, fontTools, React Native 0.85 / Expo SDK 56 / jest-expo.

**Spec:** [`docs/superpowers/specs/2026-09-04-edition-language-design.md`](../specs/2026-09-04-edition-language-design.md)

## Global Constraints

Copied from `CLAUDE.md` and the spec. Every task's requirements include these.

- **Do not commit.** Several tasks run concurrently in one worktree; the orchestrator commits at wave boundaries with explicit paths. Never run `git add -A`, `git stash`, `git checkout`, or `git commit`.
- **Use your own build directory** for host tests and the simulator: `cmake -S <src> -B "$SCRATCH/<task-name>-<what>"`, where `$SCRATCH` is the session scratchpad the orchestrator names in the task prompt. Only the final verification task runs `idf.py build`.
- **Never hand-edit `components/news_core/fonts/*.c`.** Only `tools/gen_fonts.py` writes them.
- **`sdkconfig` is gitignored — never commit it.** Shared settings go in `sdkconfig.defaults`.
- **`news_mock.c` and `tools/mock_news_server.py` must stay identical**, asserted by `test_news_mock`. A payload change means `python3 tools/mock_news_server.py --write-fixture`.
- **A rejected payload must leave the previous snapshot alone.** `news_parse()` writes `*out` only on success. `lang` normalises, never rejects.
- **`news_hash()` is the sole authority on whether the panel moves.** `lang` reaches pixels, so it IS fingerprinted.
- **All fixed user-visible strings belong in `ui_strings.h`.**
- **Every column span and origin is EVEN**; no `float` in anything that decides where ink goes.
- **Nothing personal in the repository**: no home paths, no real hostnames, no tokens.
- **`lang`** is `^[a-z]{2,3}$`; absent/invalid/wrong-type means `"en"`. Korean is `"ko"`.
- **Drawable set for `ko`**: ASCII + Latin-1 + `S_DATA_PUNCT` + the 2,350 KS X 1001 syllables + U+3131–U+318E + U+3001, U+3002, U+3008–U+300F. A syllable outside KS X 1001 is a validator failure.
- **A Hangul syllable weighs 2** against every character budget and body floor in the validator; byte capacities are checked as before.
- Task prompts to implementers must name `$SCRATCH` and the task number.

**Verification ladder (run what your task touches; the final task runs it all):**

```bash
sh server/test/run.sh
sh agent/test/run.sh
(cd app && npm test && npm run typecheck)
cmake -S components/news_core/test/host -B "$SCRATCH/host" && cmake --build "$SCRATCH/host"
for t in test_news_parse test_news_mock test_news_service test_api_json test_palette \
         test_epd6_transpose test_fit test_chart_scale test_compose test_power_policy; do
  "$SCRATCH/host/$t" || exit 1; done
sh components/provisioning/test/run.sh
python3 tools/mock_news_server.py --check
python3 tools/test_mock_etag.py
cd sim && ./sim.sh && cd ..
idf.py build            # final task only
```

---

## File Structure

| file | responsibility |
|---|---|
| `components/news_core/include/news_model.h` | `char lang[8]` + `NEWS_LANG_MAX`, before `policy` |
| `components/news_core/news_model.c` | `sizeof` assert, `news_lang_normalise()`, `lang` in `news_hash()` |
| `components/news_core/news_parse.c` | one copy + normalise |
| `components/news_core/news_mock.c` | `CP(v->lang, "en")` |
| `components/news_core/device_api_json.c` | `lang` in the `news` object |
| `components/news_core/test/host/fixtures/news.ko.json` | **new**: the complete Korean edition |
| `tools/hangul.py` | **new**: the KS X 1001 set, shared by generator and validator |
| `tools/mock_news_server.py` | `lang` in payload and budget table; per-script drawable set; weighted budgets |
| `tools/test_validate_lang.py` | **new**: validator tests for `lang` |
| `tools/gen_fonts.py` | `KO_FACES`, `korean_set()`, `link_fallback()`, bitmap-size assertion |
| `components/news_core/fonts/ui_font_ko_*.c` | **new, generated**: six Korean faces |
| `components/news_core/fonts/OFL-noto-cjk.txt` | licence |
| `.gitattributes` | `components/news_core/fonts/*.c linguist-generated=true -diff` |
| `components/news_core/CMakeLists.txt`, `sim/CMakeLists.txt` | list the six new sources |
| `components/news_core/include/ui_strings.h` | `ui_lang_t`, `UI_LANG_EN/KO`, `ui_lang()` declaration |
| `components/news_core/ui_lang.c` | **new**: the two tables and `ui_lang()` |
| `components/news_core/ui_news.c`, `ui_modules.c`, `ui_internal.h` | read the table instead of the macros; `ui_lang_now()` |
| `sim/main_sim.c`, `sim/sim.sh` | cover both tables; render `news.ko.json` into `shots/ko/` |
| `components/news_core/include/ui_fit.h`, `ui_fit.c` | `ui_fit_script_t`; Hangul line filling |
| `components/news_core/test/host/test_fit.c` | the Hangul cases |
| `server/claudepost/settings.py` | **new**: `parse_settings`, `load`, `save` |
| `server/claudepost/app.py`, `http.py` | wiring, `GET/PUT /api/settings` |
| `server/test/test_settings.py` | **new** |
| `agent/prompt.py`, `deskclient.py`, `loop.py`, `standalone/file-edition.sh` | the language section |
| `tools/edition/PROMPT.md` | the language rule and the Korean column |
| `docs/news-contract.md`, `docs/desk-server.md`, `docs/app-control.md`, `CLAUDE.md` | contract, route, `sizeof`, fonts |
| `app/src/i18n/{index.ts,en.ts,ko.ts}` | **new**: catalogue, provider, `useStrings`, `strings()` |
| `app/src/lib/store.ts` | `claudepost.language` key |
| `app/src/lib/edition/types.ts`, `parse.ts` | `lang` |
| `app/src/components/edition/typeRamp.tsx` | **new**: language-adjusted ramp context |
| `app/src/lib/desk.ts` | **new**: authenticated desk client |
| `app/src/lib/deskToken.ts` | **new**: SecureStore token |
| `app/src/app/(tabs)/settings.tsx` | App language row; Desk section |

## Waves (the orchestrator dispatches these)

| wave | tasks in parallel | notes |
|---|---|---|
| 1 | **T1→T2→T3** (one agent, sequential), **D4**, **S7**, **A9** | disjoint files |
| 2 | **D5**, **S8**, **A10→A11** (one agent) | D5 needs T2 + D4; S8 needs S7; A11 needs T2's fixture |
| 3 | **D6**, **A12** | A12 needs S7's API |
| 4 | **F13** | full ladder + firmware build |

---

### Task T1: `lang` on the wire

**Files:**
- Modify: `components/news_core/include/news_model.h` (the `news_t` struct, ~line 454; the capacities ~line 93)
- Modify: `components/news_core/news_model.c` (the `_Static_assert` at :32; `news_hash()` at :308; add `news_lang_normalise()`)
- Modify: `components/news_core/news_parse.c:771`
- Modify: `components/news_core/news_mock.c:594`
- Modify: `components/news_core/device_api_json.c:242`
- Modify: `tools/mock_news_server.py:637` (payload) and `:1540` (budget-table row `"lang": "NEWS_LANG_MAX"` — read how `check_caps_against_header()` maps names before adding)
- Modify: `components/user_app/user_app.cpp`, `CLAUDE.md`, `docs/specs/2026-08-15-single-company-broadsheet-design.md` — every `32,952`/`32952` becomes the measured figure
- Modify: `docs/news-contract.md:396` (top-level table), `docs/app-control.md` (the `news` object)
- Test: `components/news_core/test/host/test_news_parse.c`, `test_news_mock.c`, `test_api_json.c`

**Interfaces:**
- Produces: `#define NEWS_LANG_MAX 8`; `char lang[NEWS_LANG_MAX]` in `news_t`; `void news_lang_normalise(char *lang)` (in place: lowercases, keeps `^[a-z]{2,3}$`, else writes `"en"`); `lang` always non-empty after `news_parse()` and after `news_mock()`; `"lang"` in the companion-app `news` object.

- [ ] **Step 1: Write the failing tests** in `test_news_parse.c` (register them in `main()`):

```c
static void test_lang_absent_is_en(void)
{
    CHECK(PARSE("{\"subject\":{\"symbol\":\"S\"}}", &g_a) == true);
    CHECK_STR(g_a.lang, "en");
}

static void test_lang_is_normalised_not_rejected(void)
{
    CHECK(PARSE("{\"subject\":{\"symbol\":\"S\"},\"lang\":\"KO\"}", &g_a) == true);
    CHECK_STR(g_a.lang, "ko");
    CHECK(PARSE("{\"subject\":{\"symbol\":\"S\"},\"lang\":\"ko-KR\"}", &g_a) == true);
    CHECK_STR(g_a.lang, "en");           /* a region subtag is not a language tag */
    CHECK(PARSE("{\"subject\":{\"symbol\":\"S\"},\"lang\":7}", &g_a) == true);
    CHECK_STR(g_a.lang, "en");
    CHECK(PARSE("{\"subject\":{\"symbol\":\"S\"},\"lang\":\"\"}", &g_a) == true);
    CHECK_STR(g_a.lang, "en");
}

static void test_lang_is_fingerprinted(void)
{
    const char *a = "{\"subject\":{\"symbol\":\"S\"},\"stories\":[{\"rank\":0,\"headline\":\"h\",\"body\":\"w\"}],\"lang\":\"en\"}";
    const char *b = "{\"subject\":{\"symbol\":\"S\"},\"stories\":[{\"rank\":0,\"headline\":\"h\",\"body\":\"w\"}],\"lang\":\"ko\"}";
    const char *c = "{\"subject\":{\"symbol\":\"S\"},\"stories\":[{\"rank\":0,\"headline\":\"h\",\"body\":\"w\"}]}";
    CHECK(PARSE(a, &g_a) == true);
    CHECK(PARSE(b, &g_b) == true);
    CHECK(news_hash(&g_a) != news_hash(&g_b));      /* the fixed strings differ */
    CHECK(PARSE(c, &g_b) == true);
    CHECK_INT(news_hash(&g_a), news_hash(&g_b));    /* absent IS "en" */
}
```

In `test_news_mock.c` add `CHECK_STR(g_mock.lang, g_wire.lang);` beside the five top-level `CHECK_STR`s (~:142). In `test_api_json.c`, in the test that inspects the `news` object, assert the serialised JSON contains `"lang":"en"` (read the file for the existing string-contains helper).

- [ ] **Step 2: Run to verify they fail**

```bash
cmake -S components/news_core/test/host -B "$SCRATCH/t1" && cmake --build "$SCRATCH/t1"
```
Expected: compile error, `news_t` has no member `lang`.

- [ ] **Step 3: Implement**

`news_model.h`, with the capacities:
```c
#define NEWS_LANG_MAX        8      /* "en", "ko": a BCP-47 primary subtag */
```
and in `news_t`, immediately before `news_policy_t policy;`, keeping that member last:
```c
    /* The language the edition is written in, normalised: always a two- or
     * three-letter lowercase tag, "en" when the wire said nothing usable. It
     * decides the fixed strings beside the copy and the copyfitter's break
     * rule, so news_hash() feeds it. */
    char lang[NEWS_LANG_MAX];
```
Declare in `news_model.h` next to `news_str_copy`:
```c
/* Normalise a language tag in place: ASCII-lowercase, and anything that is not
 * two or three letters becomes "en". A clamp, not a rejection. */
void news_lang_normalise(char *lang);
```
`news_model.c`:
```c
void news_lang_normalise(char *lang)
{
    if (!lang) return;
    size_t n = 0;
    for (; lang[n]; n++) {
        char c = lang[n];
        if (c >= 'A' && c <= 'Z') c = (char)(c - 'A' + 'a');
        if (c < 'a' || c > 'z') { n = 0; break; }
        lang[n] = c;
    }
    if (n < 2 || n > 3) { lang[0] = 'e'; lang[1] = 'n'; lang[2] = '\0'; }
}
```
In `news_hash()`, after `h_str(&h, v->generated_at);`: `h_str(&h, v->lang);`. Fix the `_Static_assert` to the measured size (build once, read the compiler's message). `news_parse.c`, after `generated_at`:
```c
    news_str_copy(v->lang, sizeof(v->lang), jstr(root, "lang"));
    news_lang_normalise(v->lang);
```
`news_mock.c`: `CP(v->lang, "en");` after `generated_at`. `device_api_json.c`: `put_str_field(&s, "lang", st->lang, false);` after `generatedAt` — thread `lang` through whatever struct `st` is (find where `generated_at` is copied into it in `user_app.cpp` and copy `lang` beside it). `mock_news_server.py`: `"lang": "en",` after `"generated_at"`, plus the budget-table row and a `("lang", 8)` entry in the top-level cap list next to `("as_of", 24)`. Then `python3 tools/mock_news_server.py --write-fixture`.

- [ ] **Step 4: Run the host tests and the fixture check**

```bash
cmake --build "$SCRATCH/t1" && "$SCRATCH/t1/test_news_parse" && "$SCRATCH/t1/test_news_mock" && "$SCRATCH/t1/test_api_json"
python3 tools/mock_news_server.py --check && python3 tools/test_mock_etag.py
```
Expected: all PASS; fixture matches.

- [ ] **Step 5: Docs.** `docs/news-contract.md` top-level table gains: `| \`lang\` | string | 8 | the language the copy is written in, a BCP-47 primary subtag (\`en\`, \`ko\`). Absent or malformed means \`en\`. **Fingerprinted**: it chooses the fixed strings beside the copy. Reaches the companion app as \`lang\` |`. `docs/app-control.md`: `lang` in the `news` object. Replace every `32,952` with the measured figure in `CLAUDE.md`, `user_app.cpp` and the 2026-08-15 spec (grep `32952\|32,952`).

---

### Task T2: The validator learns `lang`, and the Korean fixture

**Files:**
- Create: `tools/hangul.py`
- Modify: `tools/mock_news_server.py` (`_drawable` at ~:1204, `_walk_strings` ~:1211, `validate_payload` ~:1587, `BODY_FLOOR` use ~:1616, the budget check that consumes the `(where, text, cap, budget, soft)` tuples)
- Create: `tools/test_validate_lang.py`
- Create: `components/news_core/test/host/fixtures/news.ko.json`

**Interfaces:**
- Consumes: `lang` from T1.
- Produces: `tools/hangul.py` — `WANSUNG: frozenset[str]` (2,350 syllables), `COMPAT_JAMO: frozenset[str]` (U+3131–U+318E), `CJK_PUNCT: frozenset[str]` (U+3001, U+3002, U+3008–U+300F), `DRAWABLE_KO = WANSUNG | COMPAT_JAMO | CJK_PUNCT`, `def is_syllable(c) -> bool` (U+AC00–U+D7A3), `def weight(s) -> int` (Latin char 1, Hangul syllable 2). `mock_news_server.validate_payload(d, tiles_dir)` accepts `lang`. The fixture `news.ko.json` passes `--validate --tiles sim/tiles`.

- [ ] **Step 1: `tools/hangul.py`**

```python
"""The Hangul the faces carry, in one place for the generator and the validator.

KS X 1001's 2,350 완성형 syllables, derived from the EUC-KR codec rather than
tabulated: its Hangul block is lead 0xB0..0xC8 x trail 0xA1..0xFE and every one
of those pairs decodes to exactly one syllable. Derivation asserts the count.
"""
from __future__ import annotations


def _wansung() -> frozenset[str]:
    out = []
    for lead in range(0xB0, 0xC9):
        for trail in range(0xA1, 0xFF):
            try:
                out.append(bytes([lead, trail]).decode("euc-kr"))
            except UnicodeDecodeError:
                pass
    assert len(out) == 2350, f"expected 2350 KS X 1001 syllables, derived {len(out)}"
    return frozenset(out)


WANSUNG = _wansung()
COMPAT_JAMO = frozenset(chr(c) for c in range(0x3131, 0x318F))
CJK_PUNCT = frozenset("、。" + "".join(chr(c) for c in range(0x3008, 0x3010)))
DRAWABLE_KO = WANSUNG | COMPAT_JAMO | CJK_PUNCT


def is_syllable(c: str) -> bool:
    return 0xAC00 <= ord(c) <= 0xD7A3


def weight(s: str) -> int:
    """Characters of measure: a Hangul syllable is a full em, a Latin glyph half of one."""
    return sum(2 if is_syllable(c) else 1 for c in s)
```

- [ ] **Step 2: Write the failing tests** `tools/test_validate_lang.py` (stdlib `unittest`, import `mock_news_server` from `tools/` via `sys.path.insert(0, os.path.dirname(__file__))`):

```python
class Lang(unittest.TestCase):
    def payload(self, **over):
        d = json.loads(open(FIXTURE, encoding="utf-8").read())   # the English fixture
        d.update(over); return d

    def test_the_english_fixture_still_validates_with_no_lang(self):
        d = self.payload(); d.pop("lang", None)
        self.assertEqual(M.validate_payload(d, TILES)[0], [])   # (problems, warnings)

    def test_a_malformed_tag_is_named(self):
        problems, _ = M.validate_payload(self.payload(lang="Korean"), TILES)
        self.assertTrue(any("lang" in p and "Korean" in p for p in problems))

    def test_hangul_in_an_english_edition_is_undrawable(self):
        d = self.payload(); d["stories"][0]["headline"] = "삼성전자 급등"
        problems, _ = M.validate_payload(d, TILES)
        self.assertTrue(any("undrawable" in p for p in problems))

    def test_hangul_in_a_korean_edition_is_drawable(self):
        d = self.payload(lang="ko"); d["stories"][0]["headline"] = "삼성전자 급등"
        self.assertEqual(M.validate_payload(d, TILES)[0], [])

    def test_a_syllable_outside_ks_x_1001_is_named(self):
        d = self.payload(lang="ko"); d["stories"][0]["headline"] = "뷁"   # not in the 2350
        problems, _ = M.validate_payload(d, TILES)
        self.assertTrue(any("KS X 1001" in p and "U+BFC1" in p for p in problems))

    def test_a_syllable_weighs_two_against_the_budget(self):
        d = self.payload(lang="ko"); d["stories"][0]["headline"] = "가" * 37   # 74 > 72
        problems, _ = M.validate_payload(d, TILES)
        self.assertTrue(any("headline" in p and "72" in p for p in problems))
        d["stories"][0]["headline"] = "가" * 36
        self.assertEqual([p for p in M.validate_payload(d, TILES)[0] if "headline" in p], [])

    def test_the_body_floor_is_weighted_too(self):
        d = self.payload(lang="ko"); d["stories"][0]["body"] = "가나 " * 350   # 700 syllables weigh 1,400
        _, warnings = M.validate_payload(d, TILES)
        self.assertEqual([w for w in warnings if "body is" in w], [])

    def test_the_korean_fixture_validates(self):
        d = json.loads(open(FIXTURE_KO, encoding="utf-8").read())
        problems, warnings = M.validate_payload(d, TILES)
        self.assertEqual(problems, []); self.assertEqual(warnings, [])
```
Read `validate_payload()`'s actual return shape first and adjust the unpacking; the assertions are the contract.

- [ ] **Step 3: Run** `python3 tools/test_validate_lang.py -v` — expected: failures (no `hangul`, Hangul undrawable in `ko`, fixture missing).

- [ ] **Step 4: Implement in `mock_news_server.py`**
  - `import hangul` (beside the other imports; `tools/` is on `sys.path` when run as a script — add `sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))` if `--validate` is invoked with a different cwd; the desk invokes it by absolute path).
  - `_drawable(s, lang)`: the existing predicate, plus `c in hangul.DRAWABLE_KO` when `lang == "ko"`. Where a `ko` string contains a syllable (`hangul.is_syllable`) not in `WANSUNG`, append a *separate* problem: `f"{where}: {c!r} (U+{ord(c):04X}) is a Hangul syllable outside KS X 1001 — the faces carry the 2,350 완성형 syllables only; respell it"`.
  - `lang` validation near the top of `validate_payload`: `lang = d.get("lang", "en")`; if not a `str` matching `^[a-z]{2,3}\Z` → problem `f"lang: {lang!r} is not a language tag (two or three lowercase letters, e.g. \"en\", \"ko\")"` and continue with `"en"`.
  - Budgets: wherever `len(text)` is compared to `budget` (the character budget) or `BODY_FLOOR`, use `hangul.weight(text)` instead, and say so in the message when the two differ: `f"{where}: {w} characters of measure ({n} Hangul syllables count double), over the {budget} budget"`. Byte caps unchanged.

- [ ] **Step 5: Write `news.ko.json`.** A complete Korean edition, structurally the twin of `fixtures/news.json` (same keys, same module kinds, same tile ids and `w`/`h`, same chart shapes, `"lang": "ko"`, `"schema": 3`), about **삼성전자** (`005930.KS`, KRX, 반도체): headline/deck/body/kicker/byline/captions/briefs/figure labels and values/peer names/table titles and row labels/dateline (`2026년 9월 4일 목요일`)/session (`한국 증시 마감 — 9월 3일`)/as_of (`05:12 KST 기준`) all in Korean; tickers, exchange codes and `generated_at` as they are. Every printed number self-consistent (`last`, `change_pct`, `prev_close`; table cells and their numeric plane agreeing, as `check_derivations` demands of the English one). Lengths within the Korean column of Task T3 (lead headline ≤ 36 syllables, lead body 700–1,300 syllables, etc.). Only KS X 1001 syllables. Values in won use `₩` only if it is in `S_DATA_PUNCT` — it is not, so write `원`/`억원`/`조원`. Validate:

```bash
python3 tools/mock_news_server.py --validate components/news_core/test/host/fixtures/news.ko.json --tiles sim/tiles
```
Expected: no problems, no warnings.

- [ ] **Step 6: Run** `python3 tools/test_validate_lang.py -v && python3 tools/mock_news_server.py --check` — all PASS.

---

### Task T3: The contract says which language, and how much fits in Korean

**Files:**
- Modify: `tools/edition/PROMPT.md:184-232` (the budget table and the "English and Latin-1 only" paragraph)
- Modify: `docs/news-contract.md` (a short "The language" section after the top-level table)

- [ ] **Step 1: Replace the paragraph at `PROMPT.md:230`** with:

> ## The language
>
> The edition is written in the language named by `lang` in `news.json` — `"en"` unless the desk's instruction says otherwise. Every reader-facing string is in that language: headlines, decks, bodies, kickers, bylines, captions, briefs, dossier labels and values, statement titles and row labels, the dateline, the session line and the as-of line. Tickers, exchange codes, tile ids and `generated_at` are not prose and stay as they are.
>
> **What the faces can draw is fixed.** Every language draws ASCII, Latin-1 and the typography in `ui_strings.h`. Korean (`"ko"`) additionally draws the 2,350 KS X 1001 syllables, the compatibility jamo and `、。〈〉《》「」『』` — and nothing else: a syllable outside KS X 1001 fails `--validate` with the codepoint named, so respell it. Won is `원`, `억원`, `조원`, never `₩`. Other scripts are not drawable yet.
>
> **Korean is twice as wide.** A Hangul syllable is a full em; a Latin glyph is half of one. `--validate` therefore counts every syllable as two characters against the budgets above, and a syllable costs three bytes against the array. The column that falls out:
>
> | field | Korean, in syllables | what binds |
> |---|---:|---|
> | lead headline | ≤ 36 | width |
> | lead deck | ≤ 59 | width |
> | lead body | 700–1,300 | floor is width; ceiling is the 4,000-byte array |
> | secondary headline | ≤ 27 | width |
> | secondary deck | ≤ 29 | width |
> | secondary body | 200–330 | floor |
> | kicker | ≤ 9 | bytes |
> | caption | ≤ 36 | width |
> | brief text | ≤ 46 | bytes |
> | figure label / group | ≤ 7 | bytes |
> | figure value | ≤ 7 | bytes |
> | table column header | ≤ 5 | width |
> | table cell | ≤ 6 | width |
>
> Mixed strings count each script at its own weight; `--validate` reports the measure it used.

- [ ] **Step 2: `docs/news-contract.md`**: after the top-level table, a "The language" subsection restating the drawable rule, the weighting, and that the board's fixed strings (`STALE`, `THE INDUSTRY`, the column heads) follow `lang` while the masthead does not.

- [ ] **Step 3: Verify** the Korean fixture from T2 honours every row of the column (`python3 tools/mock_news_server.py --validate ... --tiles sim/tiles` still clean).

---

### Task D4: Six Korean faces behind the six Latin faces

**Files:**
- Modify: `tools/gen_fonts.py` (FAMILIES, FACES, `symbol_sets()`, `run_conv()`, `main()`)
- Create (generated): `components/news_core/fonts/ui_font_ko_display_56.c`, `ui_font_ko_display_36.c`, `ui_font_ko_deck_24.c`, `ui_font_ko_body_20.c`, `ui_font_ko_body_16.c`, `ui_font_ko_label_14.c`; `components/news_core/fonts/OFL-noto-cjk.txt`
- Modify (generated, in place): the six Latin `ui_font_*.c` — only the `.fallback` line
- Modify: `components/news_core/CMakeLists.txt:27-33`, `sim/CMakeLists.txt:67-73`, `components/news_core/include/ui_fonts.h` (declare the six), `.gitattributes` (create)
- Test: the simulator's coverage check against `news.ko.json` (from T2; if it is not there yet, a one-line `--json` payload with a Korean headline is enough to prove the chain)

**Interfaces:**
- Produces: `extern const lv_font_t ui_font_ko_display_56, ui_font_ko_display_36, ui_font_ko_deck_24, ui_font_ko_body_20, ui_font_ko_body_16, ui_font_ko_label_14;` each Latin text face's `.fallback` pointing at its Korean twin; `gen_fonts.py --link-fallbacks` (idempotent, rewrites only the `.fallback` line of the six committed Latin faces); `gen_fonts.py --only ui_font_ko_body_16` works for a Korean face.

- [ ] **Step 1: Sources.** Add to `FAMILIES` the static OTFs (no instancing needed; `location` is `None`):
```python
NOTO_CJK = "https://github.com/notofonts/noto-cjk/raw/main/"
FAMILIES.update({
    "notoserifkr_r": (NOTO_CJK + "Serif/SubsetOTF/KR/NotoSerifKR-Regular.otf", NOTO_CJK + "Serif/LICENSE"),
    "notoserifkr_b": (NOTO_CJK + "Serif/SubsetOTF/KR/NotoSerifKR-Bold.otf",    NOTO_CJK + "Serif/LICENSE"),
    "notosanskr_m":  (NOTO_CJK + "Sans/SubsetOTF/KR/NotoSansKR-Medium.otf",     NOTO_CJK + "Sans/LICENSE"),
})
```
The OFL filename logic keys on the URL's parent directory; make the CJK licence land as `OFL-noto-cjk.txt` once (special-case the key, do not download it three times).

- [ ] **Step 2: Faces.** Add, keeping the Latin table as it is:
```python
# (name, family, px, location, kind, the Latin face it stands behind)
KO_FACES = [
    ("ui_font_ko_display_56", "notoserifkr_b", 56, None, "hangul", "ui_font_display_56"),
    ("ui_font_ko_display_36", "notoserifkr_b", 36, None, "hangul", "ui_font_display_36"),
    ("ui_font_ko_deck_24",    "notoserifkr_r", 24, None, "hangul", "ui_font_deck_24"),
    ("ui_font_ko_body_20",    "notoserifkr_r", 20, None, "hangul", "ui_font_body_20"),
    ("ui_font_ko_body_16",    "notoserifkr_r", 16, None, "hangul", "ui_font_body_16"),
    ("ui_font_ko_label_14",   "notosanskr_m",  14, None, "hangul", "ui_font_label_14"),
]
```
`symbol_sets()` gains `"hangul"`: `hangul.DRAWABLE_KO` (import `tools/hangul.py` — `sys.path.insert(0, os.path.dirname(__file__))`) plus every character of `literal_chars(strings_h())` with `ord(c) >= 0x3000` (so a Korean fixed string added to `ui_strings.h` is always covered), minus nothing else. No ASCII, no Latin-1: the primary face owns those.

- [ ] **Step 3: The fallback pointer and the size guard.** After `run_conv()` writes a Latin face, and as a standalone `--link-fallbacks` pass over the committed files:
```python
def link_fallback(path, ko_name):
    """Point a Latin face's `.fallback` at its Korean twin. Idempotent."""
    with open(path, encoding="utf-8") as f:
        src = f.read()
    decl = f"extern const lv_font_t {ko_name};\n"
    if decl not in src:
        src = src.replace("\nconst lv_font_t ", "\n" + decl + "\nconst lv_font_t ", 1)
    src = re.sub(r"\.fallback = (NULL|&\w+),", f".fallback = &{ko_name},", src)
    with open(path, "w", encoding="utf-8") as f:
        f.write(src)


def assert_bitmap_fits(path):
    """LV_FONT_FMT_TXT_LARGE is 0: bitmap_index is a 20-bit field."""
    with open(path, encoding="utf-8") as f:
        top = max(int(m) for m in re.findall(r"\.bitmap_index = (\d+)", f.read()))
    if top >= (1 << 20):
        sys.exit(f"{path}: bitmap_index {top} needs LV_FONT_FMT_TXT_LARGE=1 "
                 f"in sim/lv_conf.h and CONFIG_LV_FONT_FMT_TXT_LARGE=y in sdkconfig.defaults")
```
Read the generated file's actual spelling of the struct and the `.fallback` line before trusting the regexes; the comment format lv_font_conv emits is the authority. Also confirm the generated `.c` declares the Korean face `const lv_font_t ui_font_ko_body_16` (not `static`).

- [ ] **Step 4: Generate.**
```bash
python3 -m venv "$SCRATCH/fontenv" && "$SCRATCH/fontenv/bin/pip" install fonttools
"$SCRATCH/fontenv/bin/python" tools/gen_fonts.py --download --only ui_font_ko_display_56,ui_font_ko_display_36,ui_font_ko_deck_24,ui_font_ko_body_20,ui_font_ko_body_16,ui_font_ko_label_14
"$SCRATCH/fontenv/bin/python" tools/gen_fonts.py --link-fallbacks
```
Expected: six files, each reporting `2350 + N glyphs`; the "not in the font, dropped" line, if any, names only punctuation; `--link-fallbacks` changes exactly one line plus one `extern` in each Latin face (`git diff --stat components/news_core/fonts/` shows 6 files × 2-3 lines). Record each generated file's size and the sum in the task report.

- [ ] **Step 5: Wire the build.** `components/news_core/CMakeLists.txt` and `sim/CMakeLists.txt` list the six new `.c` files beside the seven. `ui_fonts.h` declares them, with a comment: *the Korean faces are never named by a call site; they are reached through the Latin face's `fallback`.* `.gitattributes` at the repo root:
```
components/news_core/fonts/*.c linguist-generated=true -diff
```

- [ ] **Step 6: Prove the chain in the simulator.**
```bash
cmake -S sim -B "$SCRATCH/d4-sim" -DCMAKE_BUILD_TYPE=Release && cmake --build "$SCRATCH/d4-sim" -j8
"$SCRATCH/d4-sim/sim" "$SCRATCH/d4-shots" --json components/news_core/test/host/fixtures/news.ko.json --tiles sim/tiles --only-pages
```
Expected: `checking glyph coverage` passes (no `missing from the font -> tofu`); look at `$SCRATCH/d4-shots/*.bmp` (convert with `sips -s format png`) and confirm Hangul is drawn in a serif at every size and the Latin letters and digits in the same lines are still Playfair/Source Serif. Layout assertions about labels may still fail until Task D5 localises the strings — report which, do not fix here.

---

### Task S7: The desk's settings document

**Files:**
- Create: `server/claudepost/settings.py`
- Modify: `server/claudepost/app.py` (beside `schedule_path`/`_load_schedule`/`set_schedule`), `server/claudepost/http.py` (handlers beside `h_get_schedule`; `_ROUTES` beside `/api/schedule`)
- Create: `server/test/test_settings.py`; Modify: `server/test/test_http.py`
- Modify: `docs/desk-server.md` (route table; a "The settings" section after "The watchlist")

**Interfaces:**
- Produces: `settings.DEFAULT = {"lang": "en"}`; `settings.parse_settings(doc) -> dict` (raises `BadRequest` code `bad_settings`); `settings.load(path) -> tuple[dict, str]` (never raises; source `"file"|"default"`); `settings.save(path, doc) -> None` (raises `OSError`); `Desk.settings: dict`, `Desk.settings_source`, `Desk.set_settings(doc)`; `GET /api/settings` (producer) → `{"ok": true, "source": ..., "settings": {"lang": "ko"}}`; `PUT /api/settings` (operator) with body `{"lang": "ko"}` → same shape; unknown key or bad tag → `400 {"ok": false, "error": "bad_settings", ...}`.

- [ ] **Step 1: Failing tests.** `server/test/test_settings.py`:
```python
class Parse(unittest.TestCase):
    def test_the_default_is_english(self):
        self.assertEqual(settings.DEFAULT, {"lang": "en"})
    def test_a_language_tag_is_two_or_three_lowercase_letters(self):
        self.assertEqual(settings.parse_settings({"lang": "ko"}), {"lang": "ko"})
        for bad in ("KO", "ko-KR", "", 7, None):
            with self.assertRaises(BadRequest):
                settings.parse_settings({"lang": bad})
    def test_an_unknown_key_is_refused_whole(self):
        with self.assertRaises(BadRequest):
            settings.parse_settings({"lang": "ko", "voice": "terse"})
    def test_a_document_that_is_not_an_object_is_refused(self):
        with self.assertRaises(BadRequest):
            settings.parse_settings(["ko"])

class File(unittest.TestCase):
    def test_missing_is_the_default_and_not_an_error(self):
        self.assertEqual(settings.load(os.path.join(self.tmp, "settings.json")), ({"lang": "en"}, "default"))
    def test_a_bad_file_is_ignored_with_the_default_and_left_in_place(self):
        p = self.write('{"lang": "Korean"}'); self.assertEqual(settings.load(p), ({"lang": "en"}, "default"))
        self.assertTrue(os.path.exists(p))
    def test_save_then_load_round_trips(self):
        p = os.path.join(self.tmp, "settings.json"); settings.save(p, {"lang": "ko"})
        self.assertEqual(settings.load(p), ({"lang": "ko"}, "file"))
```
In `test_http.py`, using its `self.api(method, path, doc, scope)` helper:
```python
    def test_settings_default_to_english_and_an_operator_can_change_them(self):
        status, doc = self.api("GET", "/api/settings", scope="producer")
        self.assertEqual((status, doc["settings"]), (200, {"lang": "en"}))
        status, doc = self.api("PUT", "/api/settings", {"lang": "ko"})
        self.assertEqual((status, doc["settings"], doc["source"]), (200, {"lang": "ko"}, "file"))
        status, _ = self.api("PUT", "/api/settings", {"lang": "ko"}, scope="producer")
        self.assertEqual(status, 403)
        status, doc = self.api("PUT", "/api/settings", {"lang": "ko", "x": 1})
        self.assertEqual((status, doc["error"]), (400, "bad_settings"))
        status, doc = self.api("GET", "/api/settings", scope="producer")
        self.assertEqual(doc["settings"], {"lang": "ko"})       # the bad PUT changed nothing
```
Mirror how the existing schedule test proves the file survives a restart (a second `Desk` on the same data dir) and add the same for settings.

- [ ] **Step 2: Run** `sh server/test/run.sh -k settings` — expected: `ImportError`/404s.

- [ ] **Step 3: Implement** `settings.py` on `schedulefile.py`'s shape (copy its docstring argument, `atomic_write`, `ensure_ascii=False`, newline-terminated), `parse_settings` refusing unknown keys the way `watchlist.py` does, `LANG_RE = re.compile(r"^[a-z]{2,3}\Z")`. `app.py`: `settings_path`, `settings`, `settings_source`, `_load_settings()` from the constructor, `set_settings(doc)` writing the file first then assigning (the schedule's argument). `http.py`: `h_get_settings`, `h_put_settings` (parse → `set_settings` → `store.audit("settings", {...})` → respond), routes `GET: producer`, `PUT: operator`.

- [ ] **Step 4: Run** `sh server/test/run.sh` — all PASS.

- [ ] **Step 5: Docs.** `docs/desk-server.md`: the two route rows in the control-plane table; a "The settings" section (what it holds — `lang` only — why a document and not a directive, the same refuse-whole rule as the watchlist, where the file lives). `server/README.md` if it lists routes.

---

### Task S8: The agent writes in the desk's language

**Files:**
- Modify: `agent/prompt.py` (`build_prompt` signature; new `language_section()`, `LANGUAGE_NAMES`; a `__main__`)
- Modify: `agent/deskclient.py` (`settings()` beside `directives()`), `agent/loop.py:639` (the call site), `agent/standalone/file-edition.sh:63`, `agent/README.md` (configuration table: `EDITION_LANG` for the standalone; the desk setting for the worker)
- Test: `agent/test/test_prompt.py`, `agent/test/test_deskclient.py`

**Interfaces:**
- Consumes: `GET /api/settings` from S7.
- Produces: `prompt.language_section(lang: str) -> str` (`""` for `"en"`); `prompt.build_prompt(contract, context, directives, command_text, kind="file_edition", lang="en")`; `deskclient.DeskClient.settings() -> dict` (`{"lang": "en"}` when the desk will not say); `python3 agent/prompt.py --language-section ko` prints the section.

- [ ] **Step 1: Failing tests** in `test_prompt.py`:
```python
    def test_english_leaves_the_prompt_byte_identical(self):
        before = prompt.build_prompt("CONTRACT", [], [], "go")
        self.assertEqual(prompt.build_prompt("CONTRACT", [], [], "go", lang="en"), before)
        self.assertEqual(prompt.language_section("en"), "")

    def test_korean_is_named_after_the_contract_and_before_the_operator(self):
        text = prompt.build_prompt("CONTRACT", [("standing.md", "house style")], [], "go", lang="ko")
        sec = prompt.language_section("ko")
        self.assertIn("Korean", sec); self.assertIn('"lang": "ko"', sec); self.assertIn("KS X 1001", sec)
        self.assertLess(text.index("CONTRACT"), text.index(sec))
        self.assertLess(text.index(sec), text.index("house style"))

    def test_an_unknown_tag_is_still_asked_for_by_name(self):
        self.assertIn('"lang": "fr"', prompt.language_section("fr"))
```
In `test_deskclient.py`, following the `directives()` test: `settings()` returns the desk's `settings` object on 200 and `{"lang": "en"}` on any failure.

- [ ] **Step 2: Run** `sh agent/test/run.sh -k prompt` — expected: `TypeError: unexpected keyword 'lang'`.

- [ ] **Step 3: Implement.**
```python
LANGUAGE_NAMES = {"en": "English", "ko": "Korean (한국어)", "ja": "Japanese", "fr": "French",
                  "de": "German", "es": "Spanish"}

def language_section(lang: str) -> str:
    """What goes between the contract and the operator's context when the desk
    is not set to English. Empty for "en": today's prompt, byte for byte."""
    if not lang or lang == "en":
        return ""
    name = LANGUAGE_NAMES.get(lang, lang)
    lines = [
        "\n\n---\n\n# The edition's language\n\n",
        f"Write every reader-facing string in {name}: headlines, decks, bodies, kickers, "
        "bylines, captions, briefs, dossier labels and values, statement titles and row "
        "labels, the dateline, the session line and the as-of line. Tickers, exchange codes, "
        f"tile ids and `generated_at` stay as they are. Set `\"lang\": \"{lang}\"` at the top "
        "level of news.json. The contract's section \"The language\" says what the faces can "
        "draw and how the length budget is counted in this language; read it before writing.\n",
    ]
    if lang == "ko":
        lines.append("\nUse only KS X 1001 완성형 syllables; write won as 원/억원/조원, never ₩; "
                     "a syllable counts as two characters against every budget — use the "
                     "Korean column of the table.\n")
    return "".join(lines)
```
`build_prompt`: `parts = [contract, language_section(lang)]`, then the rest unchanged. `__main__`: `argparse` with `--language-section TAG` printing `language_section(TAG)`. `deskclient.settings()`: `GET /api/settings`, `(doc or {}).get("settings") or {"lang": "en"}` on 200 else `{"lang": "en"}`. `loop.py`: `lang=desk.settings().get("lang", "en")` at the `build_prompt` call. `file-edition.sh`: build the prompt as `PROMPT.md` + `$(python3 "$REPO/agent/prompt.py" --language-section "${EDITION_LANG:-en}")` in the same `printf`.

- [ ] **Step 4: Run** `sh agent/test/run.sh` — all PASS. Run `EDITION_LANG=ko sh -n agent/standalone/file-edition.sh` for syntax, and `python3 agent/prompt.py --language-section ko | head -3`.

- [ ] **Step 5: `agent/README.md`**: one row for `EDITION_LANG` in the standalone's table; one sentence in the worker's section that the language comes from the desk's `PUT /api/settings`.

---

### Task A9: The app speaks two languages of its own

**Files:**
- Create: `app/src/i18n/en.ts`, `app/src/i18n/ko.ts`, `app/src/i18n/index.tsx`, `app/src/i18n/index.test.ts`
- Modify: `app/src/lib/store.ts` (a `claudepost.language` key with `getLanguage()`/`saveLanguage()` on the existing cached pattern), `app/src/app/_layout.tsx` (wrap in the provider), `app/src/app/(tabs)/_layout.tsx` (tab titles), `app/src/app/(tabs)/settings.tsx` (an "App language" row: System / English / 한국어), `app/src/app/onboarding/*.tsx`, `app/src/components/NoBoardYet.tsx`, `app/app.json` (`"locales": {"ko": "./locales/ko.json"}` + `app/locales/ko.json` with the iOS permission strings), `app/package.json` (`npx expo install expo-localization`)
- Test: `app/src/i18n/index.test.ts`; existing tests still pass

**Interfaces:**
- Produces: `type Strings = typeof en`; `type AppLanguage = 'system' | 'en' | 'ko'`; `LanguageProvider`; `useStrings(): Strings`; `useLanguage(): { choice: AppLanguage; resolved: 'en' | 'ko'; set(choice): Promise<void> }`; `strings(): Strings` (module-level current table for non-component code); `resolveLanguage(choice, deviceTag: string | null): 'en' | 'ko'`; `en.ts` is nested by screen: `en.settings.title`, `en.tabs.today`, `en.errors.timeout`, …

- [ ] **Step 1: Failing test** `index.test.ts`:
```ts
import { en } from './en'; import { ko } from './ko'; import { resolveLanguage } from './index'
function keys(o: object, p = ''): string[] {
  return Object.entries(o).flatMap(([k, v]) => typeof v === 'string' ? [p + k] : keys(v as object, p + k + '.'))
}
test('ko carries every key en does, and nothing else', () => { expect(keys(ko).sort()).toEqual(keys(en).sort()) })
test('no ko value is left in English', () => {
  const flatEn = new Map(keys(en).map(k => [k, k.split('.').reduce((o: any, s) => o[s], en)]))
  for (const k of keys(ko)) expect(k.split('.').reduce((o: any, s) => o[s], ko)).not.toEqual(flatEn.get(k))
})
test('system resolves from the device, and falls back to English', () => {
  expect(resolveLanguage('system', 'ko-KR')).toBe('ko'); expect(resolveLanguage('system', 'fr')).toBe('en')
  expect(resolveLanguage('system', null)).toBe('en'); expect(resolveLanguage('ko', 'en')).toBe('ko')
})
```
(Brand names — "Claude Post", "Wi-Fi", tickers — may legitimately be equal in both; keep them out of the catalogue or exempt them by an explicit `SAME_IN_BOTH` list in the test.)

- [ ] **Step 2: Run** `cd app && npx jest src/i18n` — fails, modules missing.

- [ ] **Step 3: Implement.** `index.tsx`: a React context holding `choice`; `resolved = resolveLanguage(choice, Localization.getLocales()[0]?.languageTag ?? null)`; a module-level `let current: Strings = en` updated whenever `resolved` changes, exported as `strings()`; `useStrings()` returns `resolved === 'ko' ? ko : en`. Persist `choice` through `store.ts`. Port the strings of `settings.tsx`, the tab titles, onboarding and `NoBoardYet` into `en.ts` (English exactly as today) and `ko.ts` (natural Korean, 존댓말, concise UI register; "board" → 보드, "desk" → 데스크, "edition" → 판/에디션 — pick one and use it everywhere). Add the "App language" row in Settings' Setup section (or a new "Language" section) as a three-way selector using the app's existing button/segment components.

- [ ] **Step 4: Run** `cd app && npm test && npm run typecheck` — all PASS.

---

### Task A10: The rest of the app's copy moves into the catalogue

**Files:**
- Modify: `app/src/app/(tabs)/board.tsx`, `markets.tsx`, `edition.tsx`, `app/src/app/preview.tsx`, `add-ticker.tsx`, `market/[symbol].tsx`, `tile/[id].tsx`, `app/src/components/**` (every user-visible literal), and the pure catalogues `app/src/lib/format.ts`, `app/src/lib/esp32.ts` (`humanError`), `app/src/lib/newsurl.ts`, `app/src/lib/edition/client.ts`, `app/src/lib/edition/freshness.ts`, `app/src/lib/market/types.ts`, `app/src/lib/months.ts`
- Test: the existing tests of each pure catalogue gain a `ko` case (set the language, assert a Korean sentence); parity test from A9 keeps passing

**Interfaces:**
- Consumes: `strings()` and `useStrings()` from A9.
- Produces: no English literal left in `app/src/**/*.tsx` outside `en.ts` (a grep for `>[A-Z][a-z].* </Text>` and `label="[A-Z]` should come back with brand names only); `MONTHS` becomes `strings().months.short` (12 entries, `ko`: `1월`…`12월`).

- [ ] **Step 1: Failing tests.** For each pure catalogue, add one case, e.g. in `format.test.ts`: `setLanguageForTests('ko'); expect(fetchResultMessage({...timeout})).toMatch(/시간 초과|응답이 없/)` — the exact Korean is the implementer's, the assertion is that it changed and is Hangul (`/[가-힣]/`). `index.test.ts` exports a `setLanguageForTests(tag)` helper that sets `current`.

- [ ] **Step 2: Run** — fail (functions still return English).

- [ ] **Step 3: Port.** File by file; the pure functions read `strings()` at call time (never at module load, so a language change is seen). `months.ts`'s comment says a localisation change is one edit — make it that edit.

- [ ] **Step 4: Run** `cd app && npm test && npm run typecheck`; then the grep above. All PASS, no literals.

---

### Task A11: The edition reader prints a Korean edition

**Files:**
- Modify: `app/src/lib/edition/types.ts` (`lang: string` on `Edition`), `parse.ts` (`lang` default `'en'`, same normalisation as the device: `^[a-z]{2,3}$` lowercase else `'en'`)
- Create: `app/src/components/edition/typeRamp.tsx` (`EditionTypeProvider`, `useEditionType()`), `app/src/components/edition/typeRamp.test.ts`
- Modify: `app/src/components/edition/tiles/StoryTile.tsx`, `detail/TileDetail.tsx`, `Masthead.tsx`, and every edition component that spreads `type.*` — read the ramp from `useEditionType()`; `detail/tableGrid.ts` (`detailLabelWidth(labels, cardWidth, lang)` with `labelEm(lang)`: `0.62` Latin, `1.0` for `'ko'`), `app/src/app/(tabs)/edition.tsx` and `tile/[id].tsx` (provide the ramp from `edition.lang`)
- Test: `parse.test.ts` (parses `news.ko.json` — copy it to `app/src/lib/edition/fixtures/news.ko.json` in the same task, with a comment naming the source path; a jest test asserts the copy is byte-identical to the repo fixture by reading both), `tableGrid.test.ts` (`ko` widens), `typeRamp.test.ts`

**Interfaces:**
- Consumes: `Edition.lang` (this task), the fixture from T2.
- Produces: `rampFor(lang: string): typeof type` — for `'ko'` every token drops `fontFamily` and gains `fontWeight` from `{Inter_400Regular:'400', Inter_500Medium:'500', Inter_600SemiBold:'600', Inter_700Bold:'700', Inter_800ExtraBold:'800'}`; everything else identical; `labelEm(lang)`.

- [ ] **Step 1: Failing tests.**
```ts
test('a Korean ramp carries weight without a family', () => {
  const ko = rampFor('ko'); expect(ko.pinHeadline.fontFamily).toBeUndefined(); expect(ko.pinHeadline.fontWeight).toBe('800')
  expect(ko.caption.fontSize).toBe(type.caption.fontSize); expect(rampFor('en')).toBe(type)
})
test('Hangul labels are estimated at a full em', () => {
  expect(labelEm('ko')).toBe(1.0); expect(detailLabelWidth(['매출액'], 400, 'ko')).toBeGreaterThan(detailLabelWidth(['매출액'], 400, 'en'))
})
test('the Korean fixture parses with its language', () => { expect(parseEdition(fixtureKo).lang).toBe('ko') })
```

- [ ] **Step 2: Run** — fail.

- [ ] **Step 3: Implement.** `rampFor` maps over `type`'s entries once and caches per language. The provider takes `lang` and exposes the ramp; components replace `type.x` with `const t = useEditionType(); t.x` (StyleSheet objects that spread `type.*` at module load must become functions of `t`, or the spread must move into render — keep the `metrics.test.ts` invariants true: line heights are read from the ramp, and `rampFor` never changes `lineHeight` or `fontSize`).

- [ ] **Step 4: Run** `cd app && npm test && npm run typecheck` — PASS.

- [ ] **Step 5: Look at it on the iPhone simulator.** Follow the recipe in memory (`project-ios-simulator-testing`): Expo Go `--go`, mock desk on `:8123` serving `news.ko.json` (`python3 tools/mock_news_server.py` has a serve mode — or `python3 -m http.server` from a directory holding `news.json` copied from the Korean fixture and `tiles/`), point the app at it, open Today, open the lead, open a statement. Screenshot each. Check: bold Korean headlines are bold; no deck ellipsises mid-sentence at the phone's default width; statement row labels are not cut. Fix what is wrong in the ramp or the estimators; record the screenshots' paths in the task report.

---

### Task D5: The board's fixed strings follow the edition

**Files:**
- Modify: `components/news_core/include/ui_strings.h` (the `ui_lang_t` block, after `S_COL_CHG`)
- Create: `components/news_core/ui_lang.c`
- Modify: `components/news_core/include/ui_internal.h` (`ui_lang_now()`), `ui_news.c` (`ui_news_set_data()` ~:788; the badge sites :463, :485-487), `ui_modules.c` (:1734, :1801 `S_IN_BRIEF`; :1939, :2039 `S_PEERS`; :1943 the column-head array; :2923, :2948 `S_INSIDE`), `components/news_core/CMakeLists.txt`, `sim/CMakeLists.txt` (add `ui_lang.c`), `sim/main_sim.c` (:451 `FIXED[]` — cover both tables), `sim/sim.sh` (second run on the Korean fixture into `shots/ko/`), `docs/pages.md` (a paragraph on the Korean faces and the localised heads), `CLAUDE.md` (the fonts bullet: the Korean faces, `--link-fallbacks`, and that a Korean fixed string goes in `UI_LANG_KO`)
- Test: the simulator on both fixtures

**Interfaces:**
- Consumes: `news_t.lang` (T1); the Korean faces (D4); `news.ko.json` (T2).
- Produces: in `ui_strings.h`:
```c
typedef struct {
    const char *badge_demo, *badge_stale, *badge_offline;
    const char *peers, *inside, *in_brief;
    const char *col_symbol, *col_name, *col_pe, *col_cap, *col_last, *col_chg;
} ui_lang_t;
extern const ui_lang_t UI_LANG_EN, UI_LANG_KO;
const ui_lang_t *ui_lang(const char *tag);      /* "ko" -> &UI_LANG_KO; anything else -> &UI_LANG_EN */
```
and in `ui_internal.h`: `const ui_lang_t *ui_lang_now(void);` — the table `ui_news_set_data()` selected, `&UI_LANG_EN` before any data — and `const char *ui_lang_tag_now(void);` — the normalised tag it was selected from, `"en"` before any data (Task D6 reads it).

- [ ] **Step 1: The tables.** `ui_lang.c`:
```c
const ui_lang_t UI_LANG_EN = {
    S_BADGE_DEMO, S_BADGE_STALE, S_BADGE_OFFLINE,
    S_PEERS, S_INSIDE, S_IN_BRIEF,
    S_COL_SYMBOL, S_COL_NAME, S_COL_PE, S_COL_CAP, S_COL_LAST, S_COL_CHG,
};
const ui_lang_t UI_LANG_KO = {
    "데모", "지연", "오프라인",
    "동종 업계", "사진", "단신",
    "종목", "회사명", "PER", "시가총액", "현재가", "등락",
};
const ui_lang_t *ui_lang(const char *tag)
{
    return (tag && tag[0] == 'k' && tag[1] == 'o' && tag[2] == '\0') ? &UI_LANG_KO : &UI_LANG_EN;
}
```
The Korean literals live in `ui_strings.h` as `S_KO_*` macros (so the generator's glyph scan and the simulator's coverage list see them) and `ui_lang.c` uses the macros — the file header rule stands: every fixed string in that one header.

- [ ] **Step 2: Select and read.** `ui_news_set_data()`: `s_lang = ui_lang(v ? v->lang : NULL);`; `ui_lang_now()` returns it. Replace each `S_BADGE_*`, `S_PEERS`, `S_INSIDE`, `S_IN_BRIEF`, `S_COL_*` draw site with `ui_lang_now()->…`. The column-head array at `ui_modules.c:1943` is static-initialised from macros; make it a small function filling a local `const char *heads[6]` from the table at draw time.

- [ ] **Step 3: The simulator.** `FIXED[]` gains the twelve `S_KO_*` macros. `sim.sh`, after the demo run:
```sh
./build/sim shots/ko --json ../components/news_core/test/host/fixtures/news.ko.json --tiles tiles --only-pages || status=$?
```
(`shots/ko/` created first; the PNG conversion loop covers it.) Run it:
```bash
cd sim && ./sim.sh; cd ..
```
Expected: both runs pass every layout/glyph/colour check. If a Korean head is wider than its slot, shorten the *Korean spelling* (e.g. `등락` → `등락`, `동종 업계` → `업계`), never the slot.

- [ ] **Step 4: Look at `sim/shots/ko/*.png`** at 100 %: badges, heads and column heads in Korean; masthead still blackletter; Hangul body legs set in serif, Latin figures in Source Serif; rag at line ends is expected until Task D6. Note anything else in the task report.

- [ ] **Step 5: Host tests still pass** (`cmake --build "$SCRATCH/d5-host"` + the ten binaries) — `ui_lang.c` must compile in the host test tree if `ui_news.c` is linked there; check the host `CMakeLists.txt` and add it where `ui_common.c` is listed.

---

### Task D6: Korean legs break between syllables

**Files:**
- Modify: `components/news_core/include/ui_fit.h`, `ui_fit.c`, the five call sites (`grep -n "ui_fit_text(\|ui_fit_balance(" components/news_core/ui_modules.c components/news_core/ui_news.c`), `sim/main_sim.c` if it calls either
- Test: `components/news_core/test/host/test_fit.c`

**Interfaces:**
- Produces:
```c
typedef enum { UI_FIT_LATIN = 0, UI_FIT_HANGUL = 1 } ui_fit_script_t;
ui_fit_script_t ui_fit_script(const char *lang);      /* "ko" -> HANGUL, else LATIN */
size_t ui_fit_text(const lv_font_t *font, int w, int h, int line_space, ui_fit_script_t script,
                   const char *src, char *dst, size_t n);
int ui_fit_balance(const lv_font_t *font, int w, int max_lines, ui_fit_script_t script,
                   const char *src, char *dst, size_t n);
```
Call sites pass `ui_fit_script(ui_lang_tag_now())`, the accessor Task D5 added to `ui_internal.h`.

- [ ] **Step 1: Failing tests** in `test_fit.c`, using its stub (`ADV = 10` per glyph, a Hangul syllable is one glyph — confirm `glyph_len` handles 3-byte sequences; if not, fix the stub first):
```c
static void test_hangul_fills_the_measure(void)
{
    /* 6 columns. Latin rule wraps at spaces: 가나다 / 라마바사 / 아자차카 / 타파하 = 4 lines.
     * Hangul rule breaks between syllables: 가나다 라마 / 바사 아자차 / 카 타파하 = 3. */
    const char *src = "가나다 라마바사 아자차카 타파하";
    char dst[128];
    size_t used = ui_fit_text(&FACE, 60, LH * 3, 0, UI_FIT_HANGUL, src, dst, sizeof dst);
    CHECK_INT(used, strlen(src));                      /* everything fit in 3 lines */
    CHECK_STR(dst, "가나다 라마\n바사 아자차\n카 타파하");
    used = ui_fit_text(&FACE, 60, LH * 3, 0, UI_FIT_LATIN, src, dst, sizeof dst);
    CHECK(used < strlen(src));                          /* Latin rule needs 4 lines, so it cut */
}

static void test_no_break_before_closing_or_after_opening_punctuation(void)
{
    char dst[128];
    ui_fit_text(&FACE, 40, LH * 4, 0, UI_FIT_HANGUL, "가나다라.마바(사아)", dst, sizeof dst);
    CHECK(strstr(dst, "\n.") == NULL);
    CHECK(strstr(dst, "\n)") == NULL);
    CHECK(strstr(dst, "(\n") == NULL);
}

static void test_hangul_cut_lands_on_a_boundary_and_continues_from_it(void)
{
    /* 6 columns, 2 lines: twelve glyphs of room. Line one ends on the full
     * stop (a break before "." is illegal, so "가나다라마." is one line of six);
     * stopping there would leave line two empty, so the cut fills line two
     * instead. The bytes consumed are exactly the source bytes of what was
     * set, so the next leg starts on the syllable after the cut. */
    const char *src = "가나다라마. 바사아자차카타파하";
    char dst[64];
    size_t used = ui_fit_text(&FACE, 60, LH * 2, 0, UI_FIT_HANGUL, src, dst, sizeof dst);
    CHECK_STR(dst, "가나다라마.\n바사아자차카");
    CHECK_INT(used, strlen("가나다라마. 바사아자차카"));
    CHECK(src[used] != ' ');                            /* the next leg begins on ink, not a space */
}

static void test_hangul_heads_balance_on_syllables(void)
{
    char dst[64];
    int lines = ui_fit_balance(&FACE, 60, 2, UI_FIT_HANGUL, "삼성전자급등마감", dst, sizeof dst);   /* 8 syllables, no spaces */
    CHECK_INT(lines, 2);
    CHECK_STR(dst, "삼성전자\n급등마감");
    CHECK_INT(ui_fit_balance(&FACE, 60, 2, UI_FIT_LATIN, "삼성전자급등마감", dst, sizeof dst), 0);
}
```
Write the third test's expectation precisely once you have read `ui_fit_text()`'s sentence-end rule (`FIT_STOP`); the two properties in the comments are the contract.

- [ ] **Step 2: Run** `cmake --build "$SCRATCH/d6-host" && "$SCRATCH/d6-host/test_fit"` — compile error (no `ui_fit_script_t`).

- [ ] **Step 3: Implement.** For `UI_FIT_LATIN` nothing changes. For `UI_FIT_HANGUL`, `ui_fit_text()` lays the lines itself:
  1. Tokenise `src` into units: a Hangul syllable is a unit; a maximal run of non-space, non-Hangul bytes (a Latin word, a number, punctuation glued to it) is a unit; a space is a separator.
  2. Greedy line filling: extend the current line unit by unit, measuring each candidate line with `lv_text_get_size(..., FIT_WIDE)` (no wrapping) until adding a unit would exceed `w`; a break is legal after a unit unless the next unit begins with `.,!?%)]」』` or the current unit ends with `([「『`; when the break would be illegal, back up to the last legal boundary on the line (never below one unit).
  3. Emit lines joined by `\n` into `dst` — at a space the space is replaced; between syllables the `\n` is inserted (so `dst` grows by one byte per inserted break; stop when `n` would overflow, exactly as the byte cap is handled today).
  4. Stop when the next line would exceed `h` (lines × (line height + `line_space`)); apply the existing sentence-end preference over the last boundary when it costs no line; return the *source* bytes consumed (inserted `\n`s are not source bytes).
  `ui_fit_balance()` for `UI_FIT_HANGUL`: the break-candidate list `brk[]` additionally includes every legal syllable boundary (positions where a `\n` would be *inserted*); the scoring is unchanged; on emit, build `dst` with insertions rather than in-place replacement.

- [ ] **Step 4: Run** `"$SCRATCH/d6-host/test_fit"` and the other nine — PASS. Then `cd sim && ./sim.sh` — both fixtures pass; look at `shots/ko/A1.png`: body legs now run to the measure.

---

### Task A12: Setting the edition's language from the phone

**Files:**
- Create: `app/src/lib/desk.ts` (`createDeskClient({ baseUrl, token })` with `getSettings()` and `putSettings({ lang })`, the same `request`/`getJson` shape as `esp32.ts`, `Authorization: Bearer`), `app/src/lib/desk.test.ts`, `app/src/lib/deskToken.ts` (`expo-secure-store`: `getDeskToken()`, `saveDeskToken()`, `clearDeskToken()`; the desk base URL in AsyncStorage via `store.ts` as `claudepost.deskBaseUrl`)
- Modify: `app/src/app/(tabs)/settings.tsx` (a "Desk" section: desk address, operator token (secure entry), "Edition language" selector reading `GET /api/settings` and writing `PUT`), `app/src/i18n/en.ts` + `ko.ts` (its strings), `app/package.json` (`npx expo install expo-secure-store`), `app/jest.setup.js` (mock `expo-secure-store` in memory), `docs/app-control.md` (the app's first desk call, and that the token is the operator's)

**Interfaces:**
- Consumes: `GET/PUT /api/settings` (S7).
- Produces: `DeskClient.getSettings(): Promise<{ lang: string }>`; `DeskClient.putSettings(s: { lang: string }): Promise<{ lang: string }>`; errors as `DeskError` with `code: 'unauthorized' | 'transport' | 'http' | 'bad_json'`.

- [ ] **Step 1: Failing tests** `desk.test.ts` with `global.fetch` mocked: the bearer header is sent; a 401 becomes `unauthorized`; `putSettings` PUTs the exact body `{"lang":"ko"}` and returns the desk's `settings`.

- [ ] **Step 2: Run** — fail. **Step 3: Implement.** The selector in Settings shows the desk's current value once loaded, disables until a token exists, and shows the desk's error sentence on failure through the catalogue.

- [ ] **Step 4: Run** `cd app && npm test && npm run typecheck` — PASS. Manually against a local desk if one is easy to start (`server/README.md`), otherwise against the mocked fetch only; say which in the report.

---

### Task F13: Everything, together

**Files:** none new; `CLAUDE.md` (the fonts bullet, the `sizeof` line, the language rule under "Working rules" — one bullet: *the edition's language is one wire field, `lang`; fixed strings follow it through `ui_lang()`, the copyfitter through `ui_fit_script()`, nothing else may branch on it*), `docs/simulator.md` (the second run).

- [ ] **Step 1: The whole ladder** from the top of this plan, in order, in a fresh shell; paste the last line of each into the report.
- [ ] **Step 2: Firmware.** `. "$(ls -d ~/esp/esp-idf ~/esp/v*/esp-idf 2>/dev/null | head -1)/export.sh"` (see `CLAUDE.md` for the `PATH` trap), `idf.py set-target esp32s3` if needed, `idf.py build`. Record `build/claudepost.bin`'s size before (from `git stash`-free means: the main checkout's `build/claudepost.bin` is 1,617,936 bytes) and after; it must stay under 6 MB. If the linker reports a `bitmap_index` truncation warning in any font, the size guard in D4 was wrong — stop and report.
- [ ] **Step 3: `git status`** — nothing untracked that should be tracked, nothing tracked that should not be (`sdkconfig`, `build/`, `managed_components/`, `sim/build`, `sim/shots` per the existing `.gitignore`).
