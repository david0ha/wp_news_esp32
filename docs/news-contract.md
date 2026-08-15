# The front-page contract

The device polls one URL and typesets whatever comes back as a newspaper front page. This is what
that URL has to serve, what the parser does to every field on the way in, and what happens when the
payload is wrong.

**Every edition is about one listed company.** Not a watchlist, not a market summary — one company,
and everything on both sheets is about it: why the price moved, whether the whole tape moved with
it, what the company is worth by the usual measures, what it earned, who else trades in its industry
and what the street thinks it is going to do. A payload that describes sixteen unrelated tickers is
not a thin edition, it is the wrong object.

The design this implements is
[docs/specs/2026-08-15-single-company-broadsheet-design.md](specs/2026-08-15-single-company-broadsheet-design.md),
which supersedes the data model of
[2026-08-14-front-page-design.md](specs/2026-08-14-front-page-design.md) while leaving its geometry,
colour policy, chart rules and photo rules standing. The code is
`components/news_core/news_parse.c` and `include/news_model.h`, and every number below was read out
of one of them.

## The rule everything else is arranged around

**A rejected payload leaves the previous snapshot byte-for-byte alone.**

`news_parse()` builds into a scratch snapshot and copies into the caller's struct only on success.
Nothing partial ever lands. A board that fetched a good page at 06:00 and has been getting truncated
JSON since 06:05 is still showing the 06:00 page, badged `STALE` — which is a dashboard that is out
of date and says so, against a blank sheet, which is the one failure a reader actually notices from
across a room.

That is also why the badge order in `ui_news.c` is `OFFLINE`, then `STALE`, then `DEMO` rather than
the obvious one: a configured board whose server is unreachable would otherwise badge itself `DEMO`
— true, and useless.

The scratch is not on the stack, because `sizeof(news_t)` is **24,328 bytes** — measured, against
`NewsTask`'s 16 KB and `UiTask`'s 8 KB. That is a hard constraint rather than a preference: an
automatic `news_t` overflows either stack before it is even filled in. An allocation failure is a
rejection like any other, which keeps the rule true on that path too.

## The request

```
GET <news_url>          every CONFIG_WP_NEWS_POLL_SECONDS, default 300, range 30..86400
```

No headers are required and none are checked. The response must carry a **2xx status** — checked
before the body is parsed, not after, because a 404 page and a captive-portal redirect are both
perfectly good documents that happen not to be a front page, and "your URL is wrong" and "your JSON
is wrong" are different messages in the log (`news_service.c`). The device port caps a response at
**320 KB** and times out at **15 s**.

The poll is also woken early by KEY1, by `POST /api/refresh`, and by a URL change.

A snapshot older than **twice** the poll interval is badged `STALE` (`STALE_AFTER_POLLS` in
`user_app.cpp`). Polling itself costs nothing visible: `news_hash()` fingerprints everything that
reaches the glass and `NewsTask` compares before it notifies `UiTask`, so an unchanged poll does not
touch the panel. On this panel a refresh is twenty-five to thirty seconds of flashing, so that is
not an optimisation, it is the difference between a paper on a wall and a nuisance.

**An empty URL is a complete configuration.** With no URL set — and no `CONFIG_WP_NEWS_FEED_URL`
fallback — the board renders `news_mock()`, the built-in demo snapshot, badged `DEMO`. That snapshot
is a complete, plausible front page about one company. Clearing the URL over the API puts it back.
The board works with no PC running at all.

Tiles are fetched from beside the snapshot; see [Photographs](#photographs).

## The payload

```json
{
  "edition":  "SEMICONDUCTORS",
  "dateline": "FRIDAY, AUGUST 14, 2026",
  "session":  "U.S. MARKETS CLOSED — AUG 13",
  "as_of":    "AS OF 05:12 KST",
  "generated_at": "2026-08-14T05:12:00Z",

  "subject": {
    "symbol": "SNDK", "name": "Sandisk Corp.",
    "exchange": "NASDAQ", "sector": "Semiconductors",
    "last": 241.60, "change_pct": 4.21, "prev_close": 231.84,
    "open": 233.00, "high": 245.05, "low": 231.10,
    "wk52_high": 269.00, "wk52_low": 88.00
  },

  "stories": [
    { "rank": 0,
      "kicker": "MEMORY",
      "headline": "Sandisk's memory squeeze finally shows up in the price",
      "deck": "Contract NAND rose for a fourth month, and the company is no longer discounting to fill a fab.",
      "byline": "By CLAUDE · MARKET DESK",
      "body": "MILPITAS — Sandisk closed the book on a quarter …",
      "chart": 0,
      "photo": { "id": "sndk_fab", "w": 558, "h": 300,
                 "caption": "The Yokkaichi joint-venture fab.", "credit": "REUTERS" } }
  ],

  "figures": [
    { "group": "VALUATION",     "label": "52-week range", "value": "$88–$269",
      "emph": 1, "bar": 812 },
    { "group": "VALUATION",     "label": "Market cap", "value": "$241.6B" },
    { "group": "VALUATION",     "label": "P/E",        "value": "22.4x" },
    { "group": "THE STREET",    "label": "Target",     "value": "$268.00",
      "emph": 1, "change_pct": -12.50 }
  ],

  "briefs": [
    { "date": "AUG 13", "kicker": "SUPPLY",
      "text": "Kioxia lifts its capital plan by a fifth, the second raise this year." }
  ],

  "peers": [
    { "symbol": "MU", "name": "Micron", "per": "18.1x", "cap": "$142.0B",
      "last": 128.44, "change_pct": 2.10, "is_subject": false }
  ],

  "tables": [
    { "title": "REVENUE, PROFIT AND MARGIN", "note": "$ millions", "render": "bars_line",
      "columns": ["3Q25", "4Q25", "1Q26", "2Q26"],
      "rows": [ { "label": "Revenue",    "values": ["1,940", "2,110", "2,404", "2,731"],
                  "n": [1940, 2110, 2404, 2731] },
                { "label": "Net income", "values": ["(112)", "44", "310", "588"],
                  "n": [-112, 44, 310, 588] },
                { "label": "Net margin", "values": ["(5.8%)", "2.1%", "12.9%", "21.5%"],
                  "n": [-577, 209, 1290, 2153] } ] }
  ],

  "charts": [
    { "kind": "candle", "label": "PRICE", "span": "1M", "note": "Daily, NASDAQ close",
      "open":  [231.00], "high": [245.05], "low": [231.10], "close": [241.60] },
    { "kind": "bar", "label": "REVENUE", "span": "8Q", "note": "$ millions",
      "close": [1940, 2110, 2404, 2731] }
  ],

  "indices": [
    { "symbol": "SPX", "name": "S&P 500", "last": 6412.83, "change_pct": 0.62,
      "spark": [402, 418, 396, 430, 455, 441, 468, 502] }
  ],

  "thumbs": [
    { "id": "sndk_chip", "w": 170, "h": 120,
      "caption": "A 218-layer die.", "credit": "COMPANY" }
  ]
}
```

The complete reference payload is `components/news_core/test/host/fixtures/news.json`, committed and
parsed by the host tests. Unknown keys are ignored, so a producer is free to carry its own.

### Every field is optional and every string is a byte budget

Absent, `null`, and the-wrong-type all go to the same place: the default. That is the entire error
policy for individual fields, which is why the field code in `news_parse.c` has no branches in it.

Strings are copied by `news_str_copy()`, which truncates on a **UTF-8 character boundary** — the
copy desk emits em dashes and accented names as a matter of course, and half of a three-byte em
dash is not "the headline was long", it is a tofu box or a decoder walking past the NUL. Prose
fields go through `news_str_copy_prose()`, which additionally turns the ASCII apostrophe between two
letters into U+2019, because that is the character a headline set at 56 px needs and the one every
face on the board carries. The capacities below are C buffer sizes, so a `char[120]` holds 119 bytes
plus the terminator.

| key | type | buffer / capacity | on the page |
|---|---|---|---|
| `edition` | string | 32 | the furniture, in tracked caps. Falls back to `WP NEWS` when empty |
| `dateline` | string | 40 | the dateline row under the masthead, caps. Empty here and the board sets it from its own clock |
| `session` | string | 48 | the tape's left end, caps |
| `as_of` | string | 24 | the tape's right end, caps |
| `generated_at` | string | 24 | **not drawn.** Reaches the companion app as `generatedAt`. `as_of` is the line a reader gets, and nothing on the sheet prints a clock |
| `subject` | object | one | the whole edition. See below |
| `stories[]` | array of story | 5 | the lead and up to four more |
| `figures[]` | array of figure | 28 | the dossier rail |
| `briefs[]` | array of brief | 8 | the dated related-news column |
| `peers[]` | array of peer | 6 | the industry comparison |
| `tables[]` | array of table | 2 | the quarterly statements |
| `charts[]` | array of chart | 2 | named by index from a story |
| `indices[]` | array of quote | 5 | the tape, one line of small caps |
| `thumbs[]` | array of photo | 2 | the small pictures at the foot |

## Two kinds of number, and only two

This is the rule a producer gets wrong first, so it comes before the field tables.

**A number the DEVICE has to reason about arrives as a JSON number and becomes an integer.** Money
becomes `int32_t` cents; a percentage change becomes `int32_t` basis points. `241.60` becomes
`24160`; `4.21` becomes `421`. **Nothing in the model, the parser or the UI ever holds a float.**

That is not tidiness. Chart scaling has to agree bit for bit between x86 and Xtensa, or a screenshot
test fails for a reason that has nothing to do with the chart. And the conversion is
round-**half-away-from-zero**, not truncation: truncating would let a price tick down by a cent when
nothing moved, which changes `news_hash()`, which costs a twenty-five-second refresh at nobody. The
conversion saturates at ±2,147,483,000 and rejects NaN — casting a NaN to `int32_t` is undefined
rather than merely wrong.

**A number the device only has to PRINT arrives as a preformatted string.** A market capitalisation,
a P/E multiple, a line of an income statement: `"$241.6B"`, `"22.4x"`, `"39.3%"`, `"(1,203)"`,
`"—"`. Every `figures[].value` is text and so is every table cell.

The reason is that formatting one of those is a house-style decision and the producer is the only
party that knows the answer. How many significant figures? Which suffix — `B`, `bn`, `조`? Which
currency, and does it get a symbol or a code? Is a negative in parentheses or behind a minus? Is an
unavailable figure a blank, a dash or an em dash? Asking a microcontroller to divide an int64 by a
billion and round it to one decimal place, in a house style, for twenty-eight different figures buys
nothing and costs a whole class of bug — and every one of those bugs surfaces as a wrong number on a
sheet that is refreshed twice an hour, which is exactly where nobody checks arithmetic.

So the split is: **integers are reserved for numbers the device sorts, colours, or scales a chart
against.** Everything else is already text by the time it crosses the wire.

On the glass, `ui_money()` prints thousands separators and two decimals (`6,412.83`) and `ui_pct()`
always prints a sign (`+0.62%`, `-1.84%`). Percentages and their ▲▼ marks are the **only** UI
element on the page allowed to be green or red.

## `subject` — the company the edition is about

Every field is an integer because every field is compared, coloured or scaled by the device: the
price against the 52-week range, the change against zero, the day's range against the previous
close.

| key | type | clamp | notes |
|---|---|---|---|
| `symbol` | string | 8 | `"SNDK"` |
| `name` | string | 40 | `"Sandisk Corp."` |
| `exchange` | string | 12 | `"NASDAQ"` |
| `sector` | string | 32 | `"Semiconductors"` |
| `last` | number | → int32 cents | |
| `change_pct` | number | → int32 basis points | |
| `prev_close` | number | → int32 cents | |
| `open`, `high`, `low` | number | → int32 cents | the session's range |
| `wk52_high`, `wk52_low` | number | → int32 cents | **0 means unknown**, and is drawn as absent |

Zero is the "unknown" value for the 52-week bounds rather than a sentinel like -1, because a range
the producer could not find prints as nothing at all — a 52-week bar whose low is a price of nothing
puts the current price hard against one end of the scale, which is a chart asserting something
false. There is no market capitalisation or enterprise value here: those are *printed* summary
figures, so they are `figures[]` entries where the producer can format them.

## `stories[]` — up to five

| key | type | clamp | notes |
|---|---|---|---|
| `headline` | string | 120 | **required**; a story without one is skipped |
| `rank` | number | 0..99, default 9 | ordering only, see below |
| `kicker` | string | 24 | `"MEMORY"`, `"REGULATION"` |
| `deck` | string | 180 | |
| `byline` | string | 40 | |
| `body` | string | 2400 | the only field that is cut rather than ellipsized |
| `chart` | number | index into `charts[]`, or **-1** | |
| `photo` | object | see [Photographs](#photographs) | |

No `symbol` on a story: every story in the edition is about `subject`, and repeating it five times
would say nothing.

`rank` is the server's editorial judgement and the only thing the payload says about geometry: 0 is
the lead. The parser sorts stably on it and the compositor then assigns **by position, not by the
number**, so a payload numbered 10, 20, 30 lays out exactly as one numbered 0, 1, 2, and a payload
where every rank is the same lays out in the order it arrived — the only ordering left, and the one
the producer most likely meant. After parsing, `stories[0]` is the lead.

The default rank is **9**, deliberately larger than the array holds: an unranked story has to sort
below every ranked one, and a producer that numbers its file 0..4 would otherwise tie with it.

**More than five stories does not truncate at the first five.** The array's order is the producer's,
not a ranking, so a payload that appends its lead would lose it. The parser keeps the **five lowest
ranks**, evicting the current worst — which is the one overflow rule on this wire that is not "drop
the tail", and it is that way because the tail is where a producer puts the thing it thought of last.

**The split is not stylistic.** Editorial ranking needs the research and only the agent has it;
copyfitting needs the font metrics and only the device has them. The server decides what is
important; the device decides what fits.

`chart` is an **index into the top-level `charts` array**, or -1 for none. The lead usually names the
price series; a story about an earnings line names the revenue bars. Charts live at the top level
rather than inside the story that draws them because a `news_chart_t` is **852 bytes** — four arrays
of 48 int32 closes — and a page has at most two charts on it. Five stories each carrying their own
would spend 4 KB of a struct that already has to fit in PSRAM beside a 960 KB framebuffer, to hold
arrays that are empty on every story but the lead.

An index outside `0 .. chart_count-1` is the same as -1: a story reflows without a chart, which is
normal, where a story that drew *chart 0 by accident* would print the price series under an earnings
headline and look completely deliberate.

## `figures[]` — the dossier rail, up to 28

| key | type | clamp | notes |
|---|---|---|---|
| `group` | string | 20 | the caps standing head this figure sorts under |
| `label` | string | 20 | **required.** `"Market cap"`, `"Debt/equity"` |
| `value` | string | 16 | **required, and preformatted.** `"$241.6B"`, `"22.4x"`, `"39.3%"`, `"—"` |
| `change_pct` | number | → int32 basis points | **omit it entirely** when the figure has no change |
| `emph` | bool or 0/1 | → `uint8_t`, absent = 0 | 1 makes this figure a **hero**. Mark **two to four** |
| `bar` | number | → `int16_t` 0..1000, absent = −1 | where the value sits in a range **you** chose |

A rail line is a label *and* a value, so a figure missing either is skipped: half a row under a
standing head reads as a rendering fault rather than as a figure the producer did not have. What that
does **not** license is a short dossier — see
[the minimum research checklist](#the-minimum-research-checklist). A field the source does not carry
is a field to go and find, and a fact that does not exist (a company that pays no dividend) is a line
worth printing rather than one to drop.

Consecutive figures sharing a `group` print one standing head between them, so **the producer orders
the list and the device does not sort it**. A rail whose groups interleave prints repeated heads,
which is visible on the sheet and therefore fixable; a device that sorted them would hide the
producer's bug and make the order on the paper disagree with the order in the file.

The grouping is a byte comparison, so `group` is the one prose-looking field copied **verbatim** —
it does not go through the apostrophe transform the labels and values do. A transform that could
alter one of two strings and not the other belongs nowhere near an equality test. Spell a group the
same way every time; `THE STREET` and `The Street` are two groups.

`change_pct` is genuinely optional and the distinction matters. Absent means *this figure has no
change* and it prints with no mark and no colour. Present and zero means *it did not move*, and
prints as a flat mark. A P/E ratio tinted green would be decoration, and colour on this sheet is
data.

Use the groups the design spec names — `VALUATION`, `PROFITABILITY`, `BALANCE SHEET`, `GROWTH`,
`EARNINGS`, `THE STREET` — and see [the minimum research checklist](#the-minimum-research-checklist)
for what belongs in each.

### `emph` and `bar` — which of your numbers is the day's argument

A rail of twenty-eight identical lines is a spreadsheet with a rule down one side. Nothing on it is
louder than anything else, so the eye has nowhere to land and the reader ends up reading none of it.
`emph` is the fix, and it is the same editorial judgement `rank` already makes about stories, applied
to numbers: **mark two to four figures**, the ones carrying the day's argument, and the device sets
those large with their change beside them and everything else small and two to a line.

Two to four is a real range and not a stylistic note. **None** is the rail this replaced. **All of
them** is that rail one size larger — emphasis is a comparison, and a page where everything is
emphasised has emphasised nothing. `--validate` warns at either end.

Spread them across your groups rather than stacking them at the top, and make each one the **first**
line of its group. A hero reads as the head of its own section; three heroes inside one group make
that group the rail and the others an afterthought.

`bar` turns a hero into a **graphic** instead of a bigger number: 0..1000, where the value sits inside
a range you chose. A price against its 52-week range and a margin against its five-year band are the
two this was built for. Like `indices[].spark` it is normalised **by the producer**, and for the same
reason — the device has the box but not the units, and a rail that guessed them would draw a
confident wrong bar. Send the position, not the endpoints.

Absent is **−1, which is "no bar" and is not the same as 0**. Zero is a real position — the bottom of
the range — so a producer that meant "no bar" and sent `0` gets an empty track, and a rail of those
reads as a company sitting at the floor of every measure it has.

**A hero without a bar is the ordinary hero, not a broken one.** `bar` is an *instead of*, not an
*as well as*: a mean price target has no traded band to sit inside, because its high and its low are
opinions rather than prices, so it is emphasised and printed large with no graphic. Both shapes are
in the demo edition because both have to be drawn. The reverse does not hold — a `bar` on an
unemphasised figure is a track drawn across a rail column with nothing beside it to read, and
`--validate` warns about it.

Out of range **clamps** rather than dropping: a producer that computed 1004 has the right figure and
the wrong rounding, and a bar pinned to the end of its track says that better than no bar at all.

## `briefs[]` — dated related news, up to 8

| key | type | clamp | notes |
|---|---|---|---|
| `date` | string | 12 | `"AUG 13"` |
| `kicker` | string | 24 | `"SUPPLY"`, `"REGULATION"` |
| `text` | string | 140 | **required**; one line |

A brief is not a story: no body, no byline, never given a leg. It exists so a front page can say what
else happened to this company this week in the space a headline would take. The text is the item — a
date and a kicker over nothing is furniture with no news under it — so an entry without one is
skipped.

## `peers[]` — the industry comparison, up to 6

| key | type | clamp | notes |
|---|---|---|---|
| `symbol` | string | 8 | **required**; an entry without one is skipped |
| `name` | string | 24 | |
| `per` | string | 16 | **preformatted.** `"50.2x"`, or `"—"` when the company has none |
| `cap` | string | 16 | **preformatted.** `"$226.3B"` |
| `last` | number | → int32 cents | |
| `change_pct` | number | → int32 basis points | |
| `is_subject` | bool | | the subject's own row, set in bold |

Two of the six fields are text and two are integers, in the same table, and that is the rule above
working exactly as intended: the device colours `change_pct` and it prints `per`.

**Include the subject as one of the peers, with `is_subject` true.** A comparison table that omits
the company being compared makes the reader do the comparison from memory.

## `tables[]` — a quarterly statement, up to 2

| key | type | clamp | notes |
|---|---|---|---|
| `title` | string | 32 | `"QUARTERLY RESULTS"` |
| `note` | string | 48 | `"$ millions"` — the units line |
| `render` | string | `print` \| `stack` \| `bars_line` | how this table reaches the glass. Default `print` |
| `columns[]` | array of string | 6 columns, 12 bytes each | `"1Q26"` |
| `rows[]` | array of row | 10 rows | |
| `rows[].label` | string | 24 | `"Revenue"` |
| `rows[].values[]` | array of string | 6, 14 bytes each | **every cell is text** — this is what is PRINTED |
| `rows[].n[]` | array of number | 6, → int32 | the same figures as integers — this is what is DRAWN |

Every cell is a string for the same reason `figures[].value` is: `"10,584"`, `"(1,203)"` and `"—"`
are three different house decisions about the same int64, and the producer owns all three.

**Columns run OLDEST FIRST**, which is how a financial statement is set and the opposite of how a
news feed arrives. **The parser does not reorder them.** A table whose quarters run backwards prints
backwards — which is visible, and which is the whole reason the rule is stated here rather than
enforced somewhere the producer cannot see. Six columns is deliberate: eight quarters is a scroll and
six is a page.

**Cells are positional, and so are column heads.** Column three of a row is the quarter in column
three of the header, so anything that is not a string — in `values` *or* in `columns` — still spends
its column rather than being skipped. Skipping it would slide everything after it one quarter to the
left, which prints as a table of plausible numbers filed under the wrong dates:

```json
"columns": ["1Q26", "2Q26", "3Q26", 99, "4Q26"]
```

gives five columns, the fourth with a blank head and the fifth reading `4Q26`. A blank head is a
visible producer bug; a silently mislabelled column is not.

A row shorter than the header leaves its tail empty and the page sets an em dash there; a longer one
is truncated, because there is no seventh column to print a seventh value in.

A row object with neither a label nor any values **nor any `n`** is skipped — that is a blank line
ruled across a statement, which is the one thing a printed statement never has. A row of figures
under *no* label is kept, because that is a producer bug that shows on the sheet, and a visible bug is
a fixable one.

### `render` and `n` — a statement that is an argument rather than a record

A quarterly statement is a grid of figures and it reads as one. Six quarters of revenue, profit and
margin printed as eighteen cells is a thing the reader has to assemble in their head; the same
eighteen numbers as bars with a line over them is a thing they *see*. So the producer says which of
its tables is an argument and which is a record, and the device draws or prints accordingly.

| `render` | what it draws | what the rows mean |
|---|---|---|
| `print` | the grid. **The default** | rows are rows |
| `stack` | one stacked column per period | each row is a **component of a whole** — revenue by end market, where what matters is the mix and not the total |
| `bars_line` | bars with a line over them | **every row but the last** is a bar series; the **last row is a percentage line** over them |

`bars+line` is accepted as a spelling of `bars_line`. **Anything else is `print`** — the same rule
`kind` follows for a chart, and for the same reason: a table drawn with the wrong geometry is worse
than one that was only printed, and printing is never wrong, because every cell you sent is on the
sheet under the heading it belongs to.

**A drawn table needs numbers, and `values` is text on purpose.** `"(1,203)"` and `"10,584"` and
`"—"` are house decisions the device must not try to undo, and none of the three is something a bar
can be scaled against. So you send both: `values` is what is **printed** and `n` is what is **drawn**,
the same figures in the two forms each job needs. `n` travels beside `values` **on the row**, not as
one array on the table, because a row object the parser drops must not be able to slide the numeric
plane under the rows that survived and file every bar against the wrong quarter.

`n` is an **integer in whatever unit `note` names** — `$ millions`, units shipped, whatever you said
— **except the line row of a `bars_line` table, which is BASIS POINTS**, because it is a percentage
and every percentage that crosses this wire is basis points. The device never divides, so a producer
that sends `9.34` for a note reading `$ billions` gets `9` and a chart of nine identical bars. Send
whole numbers in the unit you named.

**The plane is all-or-nothing.** `has_n` in the model is true only when every row that survived the
parse supplied a full `col_count` of numbers, and one row short of one number un-draws the *whole*
table. A stack is only a stack when every segment of every column arrived; a line is only a line when
it has a point over every bar. Half a plane is not a picture with a gap in it, it is a wrong picture.

**A partial plane is not an error.** The table falls back to `print` and every figure you sent is
still on the sheet — the same degrade-to-what-works this parser does everywhere. `render` is left
**exactly as you sent it**: it is your statement about what the table *is*, where `has_n` is a fact
about what turned up, and overwriting the first with the second would erase the only evidence that a
table meant to be drawn went undrawn. `--validate` reports the pair, which is where you find out.

Two more things the sheet will tell you about before a reader does:

- **A stacked table must not carry a `Total` row.** A stacked bar's total *is* its height, so a Total
  segment draws the whole period a second time at double the scale. Send the components and let the
  column be the total.
- **`n` and `values` must be the same figures.** They are checked against each other for the demo
  edition and nowhere else, because only you have both. A bar whose height disagrees with the number
  printed under it is the one error nobody forgives, and it is the only one that survives every other
  check: both halves are internally consistent and the page is simply a lie about one column.

## `charts[]` — up to 2

```json
{ "kind": "candle", "label": "PRICE", "span": "1M", "note": "Daily, NASDAQ close",
  "open": [...], "high": [...], "low": [...], "close": [...] }
```

| key | type | clamp |
|---|---|---|
| `kind` | `"none"` \| `"line"` \| `"candle"` \| `"bar"` | case-insensitive; anything unknown is `none` |
| `label` | string | 20 — the caps head over it |
| `span` | string | 8 — `"1D"`, `"5D"`, `"1M"`, `"6M"`, `"1Y"`, `"8Q"` |
| `note` | string | 48 — the one line under it |
| `open`, `high`, `low`, `close` | array of number | 48 entries, **oldest dropped**, → int32 cents |

`close` is the series. `CHART_LINE` reads it alone; send only `close` and the parser fills all four
arrays with the same value, so a consumer that reaches for the high gets a zero-height bar rather
than one spanning the whole scale. A point whose `close` is not a number is skipped — a bar with a
hole in it is not a bar — and `open`, `high` and `low` fall back to the close where they are missing.
The four arrays are read at the same **absolute** index, never at the same offset from the end, so an
`open[]` that arrived one element short leaves one bar without an open instead of shifting every open
by a session — which would draw as a chart of plausible candles that are all subtly wrong.

A `kind` with **no usable bars is zeroed to `none`**, so "is there a chart" stays one test and not
two. Whatever names it then reflows without it, which is normal.

**An undrawable chart keeps its index.** The producer numbered its stories against the array it sent,
so removing element 0 would silently renumber element 1, and a story that asked for the revenue bars
would draw the price series under a caps head that says `REVENUE`. Losing a chart is a page one item
shorter; drawing the wrong one is a lie about a number.

This is the one place the wire's general rule is suspended. Everywhere else an array element that is
not a JSON object is skipped; in `charts` it still consumes its slot. Trailing empties are the other
exception, in the opposite direction — nothing surviving can point past them, so trimming those
cannot renumber anything, and it keeps `chart_count` honest for a compositor that reads the count
before it reads the charts.

**A chart cannot label its points, and no field will make it.** `news_chart_t` carries `label`,
`span` and `note` — one head, one span, one line underneath — and nothing per-point. There is no
`col[]`. So a bar chart can print the value at each end of its series and the caps head over it, and
it can never print `1Q25 … 2Q26` under its bars. That is the model, not a gap in the renderer.

If the periods have to be readable, **file it as a table, not a chart**: only `news_table_t` has
`col[]`, and a `TABLE_STACK` or `TABLE_BARS_LINE` draws bars *with* its column heads under them. The
choice between the two shapes is exactly this question — a chart is a shape you read, a drawn table
is a shape you read with its dates attached. A six-quarter series whose quarters matter is a table.

Charts are drawn in black, with hard pixels rather than LVGL's antialiased line — see
[graphics.md](graphics.md) for why that is not a style choice.

## `indices[]` — the tape, up to 5

| key | type | clamp | notes |
|---|---|---|---|
| `symbol` | string | 8 | **required**; an entry without one is skipped entirely |
| `name` | string | 24 | |
| `last` | number | → int32 cents | |
| `change_pct` | number | → int32 basis points | |
| `spark[]` | array of number | 24 entries, each 0..1000 | over-long series loses its **oldest** samples |

The tape is a single line of small caps under the dateline — the furniture a broadsheet actually
gives the market, set smaller than its body text, because on a front page the tape is furniture and
not the story. `spark` therefore does not reach the glass there at all. Send it anyway: it is
fingerprinted, it is free, and a producer that has the series has no cheaper place to put it.

The sparkline arrives **already normalised to 0..1000**. This is the one piece of arithmetic the
contract asks the server to do, and the reason is that the device has the pixels but not the units:
it cannot know whether a series it was handed is a price, a yield or a ratio, and rescaling one it
cannot see the units of is how a flat day comes out looking like a crash. Values outside 0..1000 are
clamped, because anything else draws outside its box.

The indices are the one place the edition looks away from the subject, and they earn it: the reader's
first question about a 4% move is whether the whole tape moved.

## Photographs

```json
"photo": { "id": "sndk_fab", "w": 558, "h": 300, "caption": "…", "credit": "REUTERS" }
```

| key | type | clamp |
|---|---|---|
| `id` | string | 15 bytes — **truncated, not rejected**. See below |
| `w` | number | positive and **even**, clamped to 1200 |
| `h` | number | positive, clamped to 1600 |
| `caption` | string | 120 |
| `credit` | string | 32 |

`thumbs[]` entries are the same object without a story attached. The one difference is what happens
when one is rejected: a thumb is not named by index from anywhere, so it is dropped outright rather
than left as a hole in the array for the page to skip.

**Three ways to lose the whole photo object at the parser, and all three drop it silently rather than
degrading it.** `id[0] == '\0'` is the model's single test for "no photo", and it is made true in one
place rather than at four call sites.

- **No `id`.**
- **`w` or `h` missing or not positive.** An id without both dimensions is not a photograph, it is a
  GET that cannot be made — the fetch is `w*h/2` raw bytes and there is no header to read the size
  out of.
- **`w` odd.** A tile packs two pixels to a byte, so an odd width cannot be blitted as a per-row
  `memcpy`. It is rejected rather than making the device carry a nibble-shifting slow path for a
  producer's rounding error. This is the same arithmetic that makes every column span and every
  origin on the grid even; see [pages.md](pages.md). Evenness is tested on the **declared** width,
  before the clamp: clamping first would let 99999 through as 1200 while rejecting 947, which tests
  the clamp rather than the packing. (`ui_tile.c` checks it a second time when the tile is fetched.
  Belt and braces, and correct — the two layers are answering different questions.)

Oversized-but-even dimensions are clamped to 1200 × 1600 rather than dropped.

**Two things about `id` that will not announce themselves.**

`id` is **truncated at 15 bytes, not rejected.** A 20-character id parses fine and then fetches a
different tile — most likely a 404, and a silent one, because a missing tile is an ordinary
front-page condition and not an error. Keep ids short.

The `[A-Za-z0-9_-]` rule is real but it is a **tile-layer** rule, in `ui_tile.c`'s `id_ok()`, not a
parse-time one. The parser clamps the length and says nothing about the content; `"../../etc/passwd"`
is a perfectly good JSON string and the id becomes a path component, so the fetch layer allows
letters, digits, underscore and hyphen and nothing else — no dot, no slash, no percent. The
difference matters when you are debugging: an id with a dot in it does not fail to parse, it parses
and then never resolves to a picture.

A missing tile is an ordinary front-page condition — a slow wire, an id that went stale between the
JSON and the GET — not an error. The module falls back to its chart; with neither, the body takes the
full measure.

### The tile

```
GET <the news URL's directory>/tiles/<id>.bin   ->  raw 4 bpp, exactly w*h/2 bytes, no header
```

The base is the snapshot's own URL with any query or fragment cut off and everything after the last
`/` removed. `http://mac.local:8123/news.json` gives `http://mac.local:8123/tiles/sndk_fab.bin`.

The device does not resize, tone-map or dither anything. A tile is pixel data in **the framebuffer's
own nibble order** — row-major, two pixels per byte, even x in the high nibble — so the blit is a
per-row copy.

Three checks, and each of them rejects rather than degrades:

- **the byte count.** `w * h / 2` exactly. A tile whose length disagrees is not drawn, and the JSON
  dimensions are what the length is checked against — so getting them wrong means the picture never
  appears, not that it appears wrong.
- **the palette.** Every nibble must be one of the panel's six ink codes. `ui_tile.c` proves the
  RGB565 round trip for every ink the tile uses, over all 64 positions of the ordered dither, and
  refuses a tile that fails — which is also how a seventh colour gets caught before it reaches a
  framebuffer that has no ink to print it with.
- **one attempt per poll.** A failed id is remembered until the next `ui_tile_set_base()`, so a page
  that repaints does not re-GET a picture that is not there.

**There is no table of allowed sizes any more.** The old contract fixed the lead's picture at exactly
558 × 300 and refused anything else; the compositor sizes a module from what the day brought, so the
model now guarantees only that `w` is even and positive, `h` is positive, and neither exceeds the
panel.

What replaces it is the hard part of the contract: **the declared `w` and `h` ARE the byte count.**
The device fetches `w*h/2` raw bytes and copies them verbatim — it will not scale a tile to fit,
because the bytes have already been through a dither and resampling a screened image dithers it a
second time, which is coloured confetti rather than a slightly soft photograph. A descriptor that
disagrees with the file on disk is a slot that renders empty, and `--validate` checks exactly that
pairing before you file.

Since the dimensions are what lands on the paper, choose `w` as a column span — **170, 364, 558, 752,
946 or 1140**. Every one of those is even and every one lands on the grid, so the tile sits square in
whatever module the compositor gives it.

### Make tiles with `tools/make_tile.py`

```bash
python3 tools/make_tile.py photo.jpg -o tiles/sndk_fab.bin -W 558 -H 300 --preview /tmp/check.png
```

**The default diffuses the photograph across all six inks.** `--halftone` opts back into black ink
on white paper, which is the right treatment for a document scan, a chart, or a portrait whose
colour carries nothing.

That default was the other way round at first, and the reversal is recorded here because the mistake
is cheap to repeat. Colour was first tested against a synthetic image of flat saturated rectangles
and produced confetti — but flat colour is the worst case for error diffusion, since there is no
local detail to absorb the residual and the whole area breaks into speckle. Against a real
photograph the six inks resolve into something that reads as colour: warm window light, a pale sky,
green in the trees. **Never judge a dither on synthetic input.**

The tone curve runs **before** the screen and compresses the source into the panel's real range,
about 5:1 where a monitor gives 1000:1. Mapping 0–255 onto that directly crushes the shadows flat
and blows the highlights to paper; compressing first and applying gamma second is the order a press
operator works in, and it is why the midtones survive. The defaults are a black point of 60 and a
gamma of 0.72 — a tile that comes out as a silhouette wants those, not a different palette.

Look at `--preview` before filing. An unreadable picture is worse than no picture, and a story with
no picture is normal.

## The capacities are display capacities, and they are bigger than the page

| array | capacity | | array | capacity |
|---|--:|---|---|--:|
| `stories` | 5 | | `tables` | 2 |
| `figures` | 28 | | `charts` | 2 |
| `briefs` | 8 | | `indices` | 5 |
| `peers` | 6 | | `thumbs` | 2 |

**Overflow is dropped, never an error.** A payload carrying forty figures still prints a front page.

Which end goes depends on what the array *is*, and there are three answers.

- **Producer-ordered arrays keep the FIRST N.** `figures`, `briefs`, `peers`, `indices`, `tables`,
  `charts`, `thumbs`, and a table's `columns` and `rows`. Forty figures gives you the first
  twenty-eight, not the last — the order is the producer's editorial order, so the front of it is
  what was meant to lead.
- **`stories[]` keeps the N LOWEST RANKS.** It is the one array where the tail is not the least
  important thing: a producer that appends its lead would otherwise lose it. A candidate arriving at
  a full array is compared against the worst-ranked story held so far and takes its slot if it beats
  it, and the rank is read before the story is parsed, so a rejected candidate costs nothing.
- **Series drop the OLDEST.** A `spark`, and a chart's `close` / `open` / `high` / `low`. The
  right-hand end of a price history is the end being read.

A table row's `values` is **not** a series. It is positional against the header, so it truncates at
the far end and keeps the first `NEWS_TABLE_COLS`.

They are also, deliberately, **more than one page can hold**. The device no longer typesets into a
fixed set of bands: `ui_compose()` decides the day's layout from what arrived, and it can only choose
from what arrived. So the producer is asked for a generous file and the device does the editing —
send eight briefs and six peers even on a day when four and three would fill the sheet, because a
payload sized to exactly fill one layout would make the compositor pointless and would print the same
page every day.

Which module lands where is not a producer decision and is not expressible in the payload. See
[pages.md](pages.md) for what the compositor does with a file.

## The length budget

This is the part a producer most needs, because **headlines and decks are ellipsized, not
reflowed**. Overshoot and you do not get a shorter story, you get a visible `…` in the middle of a
sentence. Only body copy is cut, and it is cut at a word boundary with no ellipsis, because a
newspaper column simply stops.

**There are two different limits on this wire and they are counted in different units.** Confusing
them is the mistake that reaches the glass.

### The hard limit is a byte count

Every string lands in a fixed C array, and `news_str_copy()` truncates on a UTF-8 character boundary
with **no ellipsis to show for it**. These are the array sizes, so the usable payload is one less:

| field | array | usable bytes |
|---|--:|--:|
| headline | 120 | 119 |
| deck | 180 | 179 |
| body | 2400 | 2399 |
| byline | 40 | 39 |
| caption | 120 | 119 |
| kicker | 24 | 23 |
| brief text | 140 | 139 |
| figure label | 20 | 19 |
| figure value | 16 | 15 |
| table column header | 12 | 11 |
| table cell | 14 | 13 |
| symbol | 8 | 7 |

**They are bytes, not characters, and an em dash costs three of them.** A sixteen-character figure
value made of em dashes does not fit a sixteen-byte field; it stops partway through, with nothing on
the sheet to say it was cut. This is the opposite of a headline, where an overshoot at least prints a
visible `…`. `--validate` reports these in bytes for that reason.

A client implementing this wire has to respect the table above; it is what `news_parse.c` enforces.

### The editorial budget is a character count, and it is tighter

What actually *fits the page* is a separate, narrower set of numbers, and they live in the producer
prompt — [`tools/edition/PROMPT.md`](../tools/edition/PROMPT.md) — because they are a judgement about
surviving a narrow day's make-up rather than a property of the wire. Six of the fields above are
deliberately held inside their arrays as a margin: a kicker written to 20 characters, a figure value
to 14, a table cell to 12. `--validate` **fails** at the array and **warns** at the margin.

The typographic budgets run the other way and are genuinely about measure, not storage:

| field | write to |
|---|--:|
| lead headline | ≤ 72 characters |
| lead deck | ≤ 118 |
| lead body | 1,400–2,200 |
| secondary headline | ≤ 54 |
| secondary deck | ≤ 58 |
| secondary body | 400–650 |
| caption | ≤ 72 |

Each is the number that survives the **narrowest** measure the compositor will give that rank, not
the widest. `display_56` sets 45 characters to the line across all six columns and 29 across four, so
a lead the compositor gives four columns holds barely two thirds of what a six-column one does
(`sim/build/sim --measure` prints the table). Writing to the wide figure means a headline that is
perfect on a busy day and ellipsized on a quiet one, which is the worst of the two because it is
intermittent.

Bodies are the one field where overshooting is free — `ui_fit_text()` cuts them on a word boundary
using the same measurement LVGL will use to draw, so a string it accepted cannot then wrap onto a
line that does not exist. **Write bodies long rather than short.** A short body leaves white paper in
the column, which is the one thing that reads as broken, and the compositor stretches an elastic
module to fill its band — it can only stretch copy that exists.

Everything must be **English and Latin-1**. The bundled faces carry ASCII, Latin-1 and the
typography in `ui_strings.h`'s `S_DATA_PUNCT` — nothing else, because headlines arrive over the
network and cannot be subset. A CJK character or an emoji is a tofu box on the largest type on the
page. `--validate` (below) catches it before the panel does.

## What is a rejection and what is a clamp

A rejection discards the whole payload and leaves the page alone. Everything else clamps silently.

**Rejected:**

- not JSON, not a JSON object, or truncated (`cJSON_ParseWithLength` fails);
- the scratch allocation fails;
- a well-formed object with **no `subject.symbol` and no stories at all** — which is what a login
  page, a health endpoint or an error envelope parses down to, and replacing a good page with
  blankness is the failure the user actually notices.

A symbol on its own **is** enough. An edition whose research came back thin still has a nameplate, a
session line and a price, and printing that at full size is a legitimate quiet-day front page rather
than an error state. What is not enough is neither of the two.

Before the parser is even reached: transport failure, and any status outside 200–299.

**Clamped:** everything else. A negative width, a 900-entry array, a string where a number belongs, a
chart with no bars, a rank of 4,000, a spark value of 12,000, a photo id with no dimensions, a story
naming chart 7, a `bar` of 1,400, an `emph` of 9, a `render` word nobody has heard of, a `bars_line`
table one number short of a full plane. Each goes to a default or a bound, and the page prints.

The last two are worth saying plainly, because they are the ones a producer will hit while the
payload still looks perfectly reasonable: **an unknown `render` prints, and a `render` the plane
cannot support prints.** Neither is a rejection, neither costs you a story, and neither says anything
on the sheet — the table simply arrives as a grid instead of a picture. `--validate` is where you
find out, before the board spends a refresh on it.

## The minimum research checklist

The dossier rail down the side of A1, and the whole of A2, come from this list. It is the same table
the producer prompt carries ([`tools/edition/PROMPT.md`](../tools/edition/PROMPT.md)), repeated here
because this is the file a future producer will read first, and because it is a contract term rather
than advice.

**If your data source does not have a field, that is not permission to omit it — it is the thing to
go and find out.** A brokerage page that carries no P/B is a reason to look somewhere else. The rail
prints one standing head per group, and a group with two figures under it reads as a page that could
not be bothered.

| group | what you must have |
|---|---|
| Valuation | market capitalisation, enterprise value, P/E, P/S, P/B |
| Per share | EPS, BPS, shares outstanding |
| Profitability | ROE, net margin, revenue growth, operating-income growth, net-income growth |
| Balance sheet | debt-to-equity, current ratio, interest coverage, total equity, total debt |
| Dividend | payments a year, dividend per share, yield — or say plainly that there is none |
| Results | the last six quarters of revenue and net income, **oldest column first** |
| Consensus | next-quarter EPS and revenue estimates, and the last four quarters' surprises |
| The street | how many analysts, how many at buy, mean/high/low target price and the implied move |
| Industry | four or five comparable companies with their P/E, market value and the day's move |
| The business | revenue by segment, and where the company ranks in its industry by market value |

Each of these is a `figures[]` entry — a `group`, a `label` and a **preformatted** `value` — or a
`tables[]` row, with three exceptions that have arrays of their own: **Results** and **The business**
are `tables[]` (or, where the mix is a trend rather than a breakdown, a `charts[]` bar series),
**Industry** is `peers[]` with the subject itself carrying `is_subject`, and the week's other events
are `briefs[]`.

Two rules that are not about which fields to send.

**You do the formatting.** The device prints what you send; it has no floating point and no house
style. `"$241.6B"`, `"22.4x"`, `"39.3%"` — see [Two kinds of number](#two-kinds-of-number-and-only-two).

**Make the numbers agree with each other.** Market cap is shares times price. P/E is price over EPS.
The implied move to the target is the target over the price. A brokerage page will happily show a P/E
from one period beside a price from another; publish that pair and the owner will find it. If two
sources disagree, say which you used in the story.

A figure that genuinely does not exist — a company that pays no dividend — is stated as not existing,
which is a line of the rail worth having. A figure the research merely failed to find is not the same
thing and is not a payload shape: go back and find it. Never fill a gap with a guess or a zero. An
absent figure costs one line; a wrong one is printed at 20 px on a sheet that hangs on a wall for a
day, and nobody re-checks a number they have already read.

## Three implementations, pinned against each other

The same front page is written out three times, in two languages, and they will drift the first time
somebody edits one of them:

| | |
|---|---|
| `tools/mock_news_server.py` | the reference **producer** |
| `components/news_core/news_parse.c` | the **consumer** |
| `components/news_core/news_mock.c` | the built-in **demo snapshot** — what an unconfigured board shows |

`test_news_mock.c` holds them together. It parses the committed fixture and asserts it fingerprints
identically to the C snapshot, and when they disagree it names the field rather than leaving somebody
to diff a C file against a Python one by eye. It also asserts the demo page is a *complete* front
page rather than a placeholder.

Change one of the three and run:

```bash
python3 tools/mock_news_server.py --write-fixture     # then rebuild the host tests
python3 tools/mock_news_server.py --check             # "did anyone hand-edit the fixture"
```

## Checking somebody else's edition

`mock_news_server.py` is the reference producer, so it is also the only thing that knows the contract
well enough to judge an arbitrary payload. It checks what the device checks, plus the length budget
— which the device *cannot* check, because it ellipsizes rather than failing — plus glyph coverage
and the tiles on disk.

```console
$ python3 tools/mock_news_server.py --validate ~/.wpnews/edition/news.json
validate: /Users/you/.wpnews/edition/news.json — ok (4 stories, 22 figures, 6 briefs,
          tiles from /Users/you/.wpnews/edition/tiles, 0 warning(s))
```

The summary names the tile directory it used, because "which pictures did it check" is the question
this line is most often asked, and a producer whose tiles are somewhere else finds out here rather
than from an empty slot half an hour later.

A failure names the slot and what it will do:

```console
$ python3 tools/mock_news_server.py --validate ~/.wpnews/edition/news.json
  FAIL  stories[0].photo: …/edition/tiles/sndk_fab.bin is missing — the slot renders empty
validate: /Users/you/.wpnews/edition/news.json — 1 problem(s)
```

`FAIL` lines go to stderr and set the exit status; `warn` lines go to stdout and do not.

**Tiles are looked for in `tiles/` beside the payload**, which is where a real edition keeps them,
and a missing directory is a failure rather than a reason to skip the check — a picture that never
arrives is exactly the fault this is here to catch. The committed fixture is the exception: its
pictures live in `sim/tiles/`, so it needs the directory named.

```console
$ python3 tools/mock_news_server.py --validate components/news_core/test/host/fixtures/news.json \
      --tiles sim/tiles
validate: …/fixtures/news.json — ok (4 stories, 22 figures, 6 briefs, tiles from sim/tiles, 0 warning(s))
```

The scheduled desk in [`tools/edition/`](../tools/edition/README.md) runs this before it files,
because a page the firmware would reject is a wasted cycle whose failure shows up hours later as a
`STALE` badge with nothing to explain it.

## Writing your own producer

Anything that serves that JSON works — an agent, a cron job, a shell script, a plugin. The device
cannot tell the difference. To try the plumbing without one:

```bash
python3 tools/mock_news_server.py            # http://<you>:8123/news.json
python3 tools/mock_news_server.py --live     # prices drift each poll
```

`--live` exists to exercise the one behaviour a static payload cannot: watching the numbers move
confirms the board is polling, and watching it stay still between changes confirms that an unchanged
poll costs no refresh.

Then point the board at it, from the captive portal or over the network:

```bash
curl -X POST http://wpnews.local/api/news -d '{"url":"http://mymac.local:8123/news.json"}'
```

Serving the edition directory read-only over plain HTTP with no authentication is the posture the
firmware expects and the rest of this project's LAN services share. It suits a home network and
nothing else.
