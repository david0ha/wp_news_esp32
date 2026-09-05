# The edition's language

*2026-09-04. Status: approved for implementation.*

The paper prints in one language, and it is not the one the operator writes in. The
operator's context (`~/.claudepost/context`) is Korean; the contract at
`tools/edition/PROMPT.md` says "Everything is English and Latin-1 only", so the agent reads
Korean notes and files English sheets. This design lets the operator choose the language the
edition is written in, and makes the board and the phone able to print it. Korean is the
first non-Latin language; the mechanism is not Korean-specific, but the glyphs are, and every
place a script is assumed is named below.

## What "language" means here

Three different things are called a language and they are deliberately separate:

| what | who sets it | who reads it | where it lives |
|---|---|---|---|
| **the edition's language** | the operator, once | the agent (writes in it), the validator, the board, the phone's edition reader | the desk: `<data>/settings.json`, `{"lang": "ko"}`; and then in every edition as top-level `lang` |
| **the phone's UI language** | the phone's owner | the companion app's own chrome | the phone: AsyncStorage, `system | en | ko`, default `system` |
| **the board's chrome** (setup sheet, key legend, "Loading...") | nobody | a board that has no edition yet | English, unchanged: there is no edition to take a language from |

The edition's language travels *with the edition*. A payload says `"lang": "ko"` and that
one field decides which fixed strings the board prints beside the copy, which break rule the
copyfitter applies, and which type ramp the phone draws with. The board never consults the
desk's setting; it is what the desk's setting caused the agent to write. A cached edition on
a phone therefore renders correctly with no network, and an edition produced by the
standalone (no-desk) producer carries the same field.

## The wire

`lang` is a new optional top-level string in `news.json`: a BCP-47 primary language subtag,
two or three lowercase ASCII letters. Absent, wrong-typed or malformed all mean `"en"` —
the parser normalises rather than rejects, the same law `policy` follows. It is
**fingerprinted**: `news_hash()` feeds it, because it changes pixels (the fixed strings). A
payload that adds `"lang": "en"` to an edition that had none produces the same fingerprint,
because absent *is* `"en"` after normalisation.

On the device it is `char lang[8]` in `news_t`, placed before `policy` so the alignment
argument in `news_model.h` holds; `sizeof(news_t)` becomes 32,960 and every place that
quotes 32,952 is corrected. `device_api_json.c` passes it to the companion app inside the
`news` object as `lang`.

The validator (`tools/mock_news_server.py --validate`) accepts `lang` matching `^[a-z]{2,3}$`
and treats anything else as a failure with the value named. Everything the desk gates
follows from that field:

- **What is drawable.** Today: ASCII, Latin-1, `S_DATA_PUNCT`. For `lang == "ko"` the set
  also admits the 2,350 KS X 1001 syllables, the Hangul compatibility jamo
  (U+3131–U+318E) and the CJK punctuation the faces carry (U+3001, U+3002, U+3008–U+300F).
  A Hangul syllable *outside* KS X 1001 fails the validator with its codepoint named,
  because the faces do not carry it and the simulator would fail the same string later with
  a worse message. Any other tag keeps today's Latin-1 rule — a French edition is `"fr"`
  and draws with the faces the board already has.
- **How much fits.** The character budgets in `PROMPT.md` are widths in disguise: a Hangul
  syllable is a full em where a Latin glyph averages half of one. So in the validator **a
  Hangul syllable weighs 2** against every character budget and every body floor, and the
  byte capacities are checked exactly as before (a syllable is three bytes; that limit binds
  first on the short cut fields). `PROMPT.md` gains a Korean column stating the numbers that
  fall out, so the producer never has to do the arithmetic.

The single source of the 2,350-syllable set is `tools/hangul.py`, derived from the EUC-KR
codec (lead 0xB0–0xC8 × trail 0xA1–0xFE) exactly as the generator this repository replaced
did; it asserts the count. The font generator and the validator both import it.

A second committed fixture, `components/news_core/test/host/fixtures/news.ko.json`, is a
complete Korean edition — every module kind, the same tiles as the demo — that the validator
passes, the simulator typesets, and the app's tests parse. It is the Korean sheet's proof,
the way `news.json` is the English one's. It is not tied to `news_mock.c`; the demo edition
stays English because an unconfigured board has no language.

## The board

### Glyphs: a Korean face behind every text face

Six Korean faces are generated beside the six Latin text faces, one per size, from Noto
Serif KR (body, deck, display) and Noto Sans KR (labels), SIL OFL, at the same pixel size
and 1 bpp, carrying the KS X 1001 set plus the jamo and punctuation above plus every Hangul
character `ui_strings.h` uses. Each Latin face's `lv_font_t.fallback` points at its Korean
face — `gen_fonts.py` emits that pointer into the generated `.c`, since the struct lives in
flash and cannot be patched at runtime.

Why a fallback chain and not a face swap: LVGL resolves `fallback` recursively in
`lv_font_get_glyph_dsc()`, so every label, every copyfit measurement and the simulator's
coverage check pick up Hangul with **no change at any call site**, and mixed text — a
Korean headline naming "Nvidia", a "$" or a ticker — keeps its Latin letters and figures in
Playfair and Source Serif rather than in the CJK face's Latin. The layout arithmetic is
unchanged because LVGL takes line height and baseline from the *primary* face; the Korean
faces are generated at the same px so their ink sits on that baseline.

The masthead face is untouched and the masthead stays "The Claude Post" in every language:
a blackletter nameplate is the paper's brand, not copy, and no Korean blackletter exists.
The A2 running head likewise.

Cost, measured from the linker map's per-glyph figures: about 1.9 MB of flash across the six
faces, against 6.46 MiB free in the 8 MB factory partition. The generated C is roughly
10 MB; `.gitattributes` marks `fonts/*.c` as generated so reviews collapse it. Two
constraints the generator now enforces rather than documents: every face's bitmap array
stays under 2^20 bytes (the 20-bit `bitmap_index` field with `LV_FONT_FMT_TXT_LARGE = 0`;
the 56 px face is the one that could cross it, and the lever is that flag in both `lv_conf.h`
and `sdkconfig.defaults`), and every Korean face has the identical glyph set (the simulator's
"six faces identical in coverage" argument now spans twelve).

### The fixed strings

`ui_strings.h` keeps every `S_*` macro as it is and adds one table:

```c
typedef struct {
    const char *badge_demo, *badge_stale, *badge_offline;
    const char *peers, *inside, *in_brief;
    const char *col_symbol, *col_name, *col_pe, *col_cap, *col_last, *col_chg;
} ui_lang_t;
extern const ui_lang_t UI_LANG_EN, UI_LANG_KO;
const ui_lang_t *ui_lang(const char *tag);   /* "ko" -> KO; anything else -> EN */
```

Eleven strings are all a Korean sheet needs localised: the two live badges, three module
heads and six column heads. Korean: `STALE`→지연, `OFFLINE`→오프라인, `DEMO`→데모,
`THE INDUSTRY`→동종 업계, `INSIDE`→사진, `IN BRIEF`→단신, `SYMBOL`→종목, `NAME`→회사명,
`P/E`→PER, `MKT CAP`→시가총액, `LAST`→현재가, `CHG`→등락. `ui_news_set_data()` selects the
table from `v->lang` and the draw sites read it instead of the macros. Everything else on
the sheet arrives in the payload already in the edition's language — dateline, session,
as-of, kickers, statement titles and row labels — which is why the list is short. The
no-payload dateline (weekday and month tables) stays English: a board with no payload has no
language. The simulator's fixed-string coverage loop runs over both tables, and its
"label wider than its slot" check is what holds the Korean spellings to their columns.

### Breaking lines

LVGL 9.5 breaks after every CJK ideograph and every kana but **not** after a Hangul
syllable (`lv_text_is_a_word()`), and `LV_TXT_BREAK_CHARS` cannot name a codepoint above
0x7F. So a Korean leg wraps only at spaces. That is *correct* — the copyfitter measures
with the same `lv_text_get_size()` LVGL draws with, so nothing overflows — but a 170 px leg
holds ten syllables and an eojeol runs two to five, so the rag is a fifth of every line.
Korean newspapers break between any two syllables.

The rule lives where the cut already lives: `ui_fit_text()` and `ui_fit_balance()` take the
edition's language as an explicit parameter, and for `ko` they emit the line breaks
themselves — a `\n` at the last syllable boundary that fits, never before closing
punctuation (`.,!?%)]」』`) and never after opening (`([「『`) — so LVGL is handed lines that
each fit and has nothing left to wrap. Heads gain syllable boundaries as balance candidates
on the same terms. Host-tested against the stub measurement like every other fit rule. This
is the last device task and it is separable: a Korean sheet renders correctly without it,
just ragged.

## The desk

A fourth operator document beside the schedule and the watchlist: `<data>/settings.json`,
module `settings.py` on the `schedulefile.py` pattern — `load()` never raises and falls back
to `{"lang": "en"}` naming the bad field, `save()` does raise, unknown keys are refused
whole with `400 bad_settings`, and `lang` must match `^[a-z]{2,3}$`. Routes:
`GET /api/settings` (producer) and `PUT /api/settings` (operator). Not a directive: three
consumers need it as data, and the phone cannot parse a sentence to learn what is set.

The gates need no new code of their own. Gate 1 already invokes the validator, and the
validator now knows `lang`. The desk does not cross-check the edition's `lang` against its
own setting: the field describes the text that is actually in the payload, and refusing a
Korean edition because the operator flipped the setting an hour ago would keep the wrong
sheet on the glass for nothing.

## The agent

`deskclient.settings()` reads the setting; `loop.py` passes `lang` into
`prompt.build_prompt()`, which for anything but `en` inserts a section immediately after
the contract and before the operator's context — so nothing the operator wrote can push it
off the top, and the length budgets still come first. The section says: write every
reader-facing string in that language (headlines, decks, bodies, kickers, bylines, captions,
briefs, dossier labels, statement titles and row labels, dateline, session, as-of); keep
tickers, exchange codes, tile ids and `generated_at` as they are; set `"lang"` in
`news.json`; and, for Korean, use only KS X 1001 syllables and read the Korean column of the
budget table. For `en` the prompt is byte-identical to today's, and a test says so.

The standalone producer reads `EDITION_LANG` and inserts the same section; `prompt.py` grows
a `__main__` that prints it so the shell script does not carry a second copy.

`PROMPT.md` replaces "Everything is English and Latin-1 only" with the language rule and
the Korean budget column. `docs/news-contract.md`, `docs/desk-server.md`,
`docs/app-control.md` and `CLAUDE.md` gain the field, the route, and the corrected
`sizeof(news_t)`.

## The phone

**Its own language.** A string catalogue at `app/src/i18n/` — `en.ts` is the type, `ko.ts`
is `typeof en`, and a jest test holds the two key sets equal at runtime as well. A provider
holds the choice (`system | en | ko`, AsyncStorage, default `system` resolved through
`expo-localization`); components read `useStrings()`, and the pure catalogues that already
return sentences (`format.ts`, `esp32.ts`'s `humanError`, `newsurl.ts`, `edition/client.ts`,
`edition/freshness.ts`) read the current table through a module-level getter the provider
keeps current, so their tests can set a language and assert a sentence. Settings gains an
"App language" row. `app.json` gains a `locales` entry so the iOS permission strings
follow.

**The edition's language.** `Edition` gains `lang` (parse default `'en'`). Inter has no
Hangul; on both platforms a missing glyph falls back to the system CJK face at *regular*
weight, so a bold Korean headline would come out light. For `ko` the type ramp therefore
drops `fontFamily` and carries the weight as `fontWeight` — the system face on iOS and
Android both honour it, and no CJK font ships in the binary. A context supplies the
language-adjusted ramp to the edition components (tiles, detail, masthead); nothing else in
the app changes ramp. The one width estimate that reads character counts,
`detailLabelWidth`, takes its em factor from the language (0.62 Latin, 1.0 Hangul). Line
budgets stay as they are: Korean copy written to the Korean column is about half the
character count at twice the width, so it lands on the same line counts. The freshness
dates the app composes itself take their month names from the catalogue.

**Setting the edition's language.** Settings gains a "Desk" section: the desk's control
URL, an operator token (kept in `expo-secure-store`, never in AsyncStorage), and an "Edition
language" control that reads and writes `/api/settings`. The client is small and lives in
`app/src/lib/desk.ts`; it is the app's first authenticated call to the desk, and the token
is the operator's to paste.

Before the PR, the Korean fixture is rendered on the iPhone simulator through the recipe in
memory and the sheet is looked at, because the estimator was tuned on Latin and the only way
to know a Korean deck is not ellipsising is to see one.

## What is deliberately not in this design

- **No font packs at runtime.** Downloading faces from the desk into a flash partition would
  make the board language-agnostic, at the price of a second thing that can be missing on a
  wake, a loader in the boot path the deep-sleep design keeps empty, and a simulator that no
  longer holds the fonts it tests. The glyphs are compiled data like every other face.
- **No Japanese or Chinese.** The same recipe adds them — a face set, a drawable range, a
  fixed-string table — and the flash bill for a CJK ideograph set at six sizes is what would
  decide it. Nothing here forecloses it.
- **No caps register in Korean.** Hangul has no case; `ui_upper()` is a no-op on it and the
  tracked caps slots simply print Korean. That reads as a Korean paper's small sans labels
  do, and no layout changes for it.
- **Not touched, but noted:** the simulator's `LV_TXT_BREAK_CHARS` breaks after `]` and the
  device's does not — a pre-existing divergence, unrelated to this work.
- **No TestFlight build.** The deliverable is the PR; the deploy lane is a separate step
  with its own skill.
