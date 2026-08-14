# The front-page contract

The device polls one URL and typesets whatever comes back as a newspaper front page. This is what
that URL has to serve, what the parser does to every field on the way in, and what happens when the
payload is wrong.

The design this implements is [docs/specs/2026-08-14-front-page-design.md](specs/2026-08-14-front-page-design.md);
the code is `components/news_core/news_parse.c` and `include/news_model.h`, and every number below
was read out of one of them.

## The rule everything else is arranged around

**A rejected payload leaves the previous snapshot byte-for-byte alone.**

`news_parse()` builds into a scratch `news_t` on the heap and copies into the caller's struct only
on success. Nothing partial ever lands. A board that fetched a good page at 06:00 and has been
getting truncated JSON since 06:05 is still showing the 06:00 page, badged `STALE` — which is a
dashboard that is out of date and says so, against a blank sheet, which is the one failure a reader
actually notices from across a room.

That is also why the badge order in `ui_news.c` is `OFFLINE`, then `STALE`, then `DEMO` rather than
the obvious one: a configured board whose server is unreachable would otherwise badge itself `DEMO`
— true, and useless.

The scratch is on the heap and not on the stack because `sizeof(news_t)` is **19,780 bytes**
(measured: 6 stories at 2,944 + 21 quotes at 92 + the furniture) against `NewsTask`'s 16 KB. An
allocation failure is a rejection like any other, which keeps the rule true on that path too.

## The request

```
GET <news_url>          every CONFIG_WP_NEWS_POLL_SECONDS, default 300, range 30..86400
```

No headers are required and none are checked. The response must carry a **2xx status** — checked
before the body is parsed, not after, because a 404 page and a captive-portal redirect are both
perfectly good documents that happen not to be a front page, and "your URL is wrong" and "your JSON
is wrong" are different messages in the log (`news_service.c`). The device port caps a response at
**320 KB** and times out at **15 s**; the reference payload is 13 KB.

The poll is also woken early by KEY1, by `POST /api/refresh`, and by a URL change.

A snapshot older than **twice** the poll interval is badged `STALE` (`STALE_AFTER_POLLS` in
`user_app.cpp`). Polling itself costs nothing visible: `news_hash()` fingerprints everything that
reaches the glass and `NewsTask` compares before it notifies `UiTask`, so an unchanged poll does not
touch the panel. On this panel a refresh is twenty-five to thirty seconds of flashing, so that is
not an optimisation, it is the difference between a paper on a wall and a nuisance.

**An empty URL is a complete configuration.** With no URL set — and no `CONFIG_WP_NEWS_FEED_URL`
fallback — the board renders `news_mock()`, the built-in demo snapshot, badged `DEMO`. That snapshot
is a complete, plausible front page: five indices, sixteen quotes, four stories, a candle chart, a
line chart, a photograph and a macro story that quotes nothing. Clearing the URL over the API puts
it back. The board works with no PC running at all.

Tiles are fetched from beside the snapshot; see [Photographs](#photographs).

## The payload

```json
{
  "schema": 2,
  "edition":  "PERSONAL PORTFOLIO EDITION",
  "dateline": "FRIDAY, AUGUST 14, 2026",
  "session":  "U.S. MARKETS CLOSED — AUG 13",
  "as_of":    "AS OF 05:12 KST",
  "generated_at": "2026-08-14T05:12:00Z",

  "indices": [
    { "symbol": "SPX", "name": "S&P 500", "last": 6412.83, "change_pct": 0.62,
      "spark": [402, 418, 396, 430, 455, 441, 468, 502, 488, 521, 546, 574] }
  ],

  "stories": [
    { "rank": 0,
      "kicker": "SEMICONDUCTORS",
      "headline": "Nvidia's blowout quarter resets the whole AI trade",
      "deck": "Guidance beat the entire sell-side range, and for the first time the supply story arrives with numbers attached.",
      "byline": "By CLAUDE · MARKET DESK",
      "body": "SANTA CLARA — Nvidia closed the book on a quarter …",
      "symbol": "NVDA", "last": 183.22, "change_pct": -1.84,
      "chart": { "kind": "candle", "span": "1M",
                 "bars": [[181.00, 184.20, 180.10, 183.22]] },
      "photo": { "id": "nvda_hq", "w": 558, "h": 300,
                 "caption": "The company's Santa Clara campus.", "credit": "REUTERS" } }
  ],

  "tickers": [
    { "symbol": "AAPL", "name": "Apple", "last": 231.40, "change_pct": 0.31,
      "spark": [430, 442, 421, 455, 468, 451, 476, 490, 472, 501, 488, 512] }
  ]
}
```

The complete reference payload is `components/news_core/test/host/fixtures/news.json` (13,074 bytes),
committed and parsed by the host tests. `schema` is not read by anything on the device — unknown
keys are ignored — and is there for a producer that wants to branch on it.

### Every field is optional and every string is a byte budget

Absent, `null`, and the-wrong-type all go to the same place: the default. That is the entire error
policy for individual fields, which is why the field code in `news_parse.c` has no branches in it.

Strings are copied by `news_str_copy()`, which truncates on a **UTF-8 character boundary** — the
copy desk emits em dashes and accented names as a matter of course, and half of a three-byte em
dash is not "the headline was long", it is a tofu box or a decoder walking past the NUL. The
capacities below are C buffer sizes, so a `char[120]` holds 119 bytes plus the terminator.

| key | type | buffer | on the page |
|---|---|---|---|
| `edition` | string | 32 | band 1 left, caps. Falls back to `WP NEWS` when empty |
| `dateline` | string | 40 | band 1 right, caps. Empty here and the board sets it from its own clock |
| `session` | string | 48 | band 3 left, caps |
| `as_of` | string | 24 | band 3 right, caps |
| `generated_at` | string | 24 | **not drawn.** Reaches the companion app as `generatedAt`; the folio prints the minute the *glass* changed, which is the one time only the board knows |
| `indices[]` | array of quote | 5 | the ribbon, band 4 |
| `stories[]` | array of story | 6 | bands 5, 6 and 7 |
| `tickers[]` | array of quote | 16 | the portfolio rail and the quotation table |

Arrays past their capacity are **clamped, not rejected** — a payload with forty stories still prints
a front page.

### A quote — `indices[]` and `tickers[]`

| key | type | clamp | notes |
|---|---|---|---|
| `symbol` | string | 8 | **required**; an entry without one is skipped entirely |
| `name` | string | 24 | |
| `last` | number | → int32 cents | |
| `change_pct` | number | → int32 basis points | |
| `spark[]` | array of number | 24 entries, each 0..1000 | over-long series loses its **oldest** samples |

The sparkline arrives **already normalised to 0..1000**. This is the one piece of arithmetic the
contract asks the server to do, and the reason is that the device has the pixels but not the units:
it cannot know whether a series it was handed is a price, a yield or a ratio, and rescaling one it
cannot see the units of is how a flat day comes out looking like a crash. Values outside 0..1000 are
clamped, because anything else draws outside its 150 × 16 box.

**The order of `tickers[]` is editorial and the device reads it as such.** `tickers[0..7]` become the
portfolio rail in band 6; `tickers[8..15]` become the quotation table in band 7. Put the owner's
holdings first and the watchlist after. Under nine quotes the table falls back to the top of the
list and the two elements agree — eight symbols named as the portfolio and then quoted in full is a
paper saying the same thing twice on purpose; eight blank ruled rows is a fault.

`indices[0..4]` fill the ribbon's five cells in order. Fewer than five are centred on the cell grid
by a whole number of cells rather than packed left, so every cell origin stays even; four cannot be
centred on a grid of five without a half-cell and are left where they are.

### A story — `stories[]`

| key | type | clamp | notes |
|---|---|---|---|
| `headline` | string | 120 | **required**; a story without one is skipped |
| `rank` | number | 0..99, default 6 | ordering only, see below |
| `kicker` | string | 24 | |
| `deck` | string | 180 | |
| `byline` | string | 40 | |
| `body` | string | 1600 | the only field that is cut rather than ellipsized |
| `symbol` | string | 8 | optional — a macro story quotes nothing and the layout must not assume otherwise |
| `last` | number | → int32 cents | |
| `change_pct` | number | → int32 basis points | |
| `chart` | object | see below | |
| `photo` | object | see below | lead only |

More than six stories does **not** truncate at the first six: the array's order is the producer's,
not a ranking, so a payload that appends its lead would lose it. The parser keeps the **six lowest
ranks**, evicting the current worst.

## Money and percentages are integers by the time they land

Prices and percentage changes arrive as ordinary JSON numbers. `183.22` becomes `18322` cents;
`-1.84` becomes `-184` basis points. **Nothing in the model, the parser or the UI ever holds a
float.**

That is not tidiness. Chart scaling has to agree bit for bit between x86 and Xtensa, or a screenshot
test fails for a reason that has nothing to do with the chart — the same reason the old link-graph
layout carried its own sine table. And the conversion is round-**half-away-from-zero**, not
truncation: truncating would let a price tick down by a cent when nothing moved, which changes
`news_hash()`, which costs a twenty-five-second refresh at nobody.

`sround()` also saturates at ±2,147,483,000 and rejects NaN — casting a NaN to `int32_t` is
undefined rather than merely wrong.

On the glass, `ui_money()` prints thousands separators and two decimals (`6,412.83`) and `ui_pct()`
always prints a sign (`+0.62%`, `-1.84%`). Percentages and their ▲▼ marks are the **only** UI
element on the page allowed to be green or red.

## The server ranks; the device typesets

The split is not stylistic. Editorial ranking needs the research and only the agent has it;
copyfitting needs the font metrics and only the device has them. So the payload says `rank` and
nothing whatsoever about geometry.

The device sorts stably by `rank` and then assigns **by position, not by the number**:

| position | slot | count |
|---|---|---|
| 0 | the lead well, band 5 | 1 |
| 1–2 | the secondary row, band 6 | `UI_SECOND_COLS` = 2 |
| 3–5 | `IN BRIEF`, band 7 | `UI_BRIEF_ROWS` = 3 |

**A payload that numbers its stories 10, 20, 30 lays out exactly as one numbered 0, 1, 2.** A payload
where every rank is the same is laid out in the order it arrived, which is the only ordering left
and the one the producer most likely meant.

Under-supply promotes rather than leaving a hole:

- **two stories** — the second spans both secondary columns;
- **one story** — band 6 carries its chart in the two columns the missing stories left, and the
  portfolio rail widens to four;
- **no stories at all** — the lead well shows the index ribbon at headline size and the rail takes
  all six columns. That is a markets page, and on a quiet day it is a legitimate front page rather
  than an error state.

## The length budget

This is the part a producer most needs, because **headlines and decks are ellipsized, not
reflowed**. Overshoot and you do not get a shorter story, you get a visible `…` in the middle of a
sentence. Only body copy is cut, and it is cut at a word boundary with no ellipsis, because a
newspaper column simply stops.

Capacity is what the slot measures at, computed from the metrics read out of the committed font
files. The budget is about 90% of it, so that a run of wide characters does not tip a line over.

| field | slot | capacity | write to |
|---|---|---:|---:|
| lead kicker | `label_14`, 1 line | — | ≤ 24 |
| lead headline | `display_56`, 1140 px, 2 lines | 82 | ≤ 72 |
| lead deck | `deck_24`, 752 px, 2 lines | 132 | ≤ 118 |
| lead byline | `label_14`, 752 px, 1 line | 108 | ≤ 40 |
| lead caption | `label_14`, 558 px, 1 line | 80 | ≤ 72 |
| lead body | `body_20`, 558 px, 14 lines | 742 | 600–740 |
| secondary headline | `display_36`, 364 px, 3 lines | 60 | ≤ 54 |
| secondary deck | `deck_24`, 364 px, 2 lines | 64 | ≤ 58 |
| secondary body | `body_16`, 364 px, 8 lines | 336 | 260–330 |

The secondary slots are genuinely tight. 54 characters is a real newspaper's second-lead headline
and 58 is a real deck; a column 364 px wide does not negotiate.

Bodies are the one field where overshooting is free — `ui_fit_text()` cuts them on a word boundary
using `lv_text_get_size()`, the same measurement LVGL will use to draw, so a string it accepted
cannot then wrap onto a line that does not exist. **Write bodies long rather than short.** A short
body leaves white paper in the column, which is the one thing that reads as broken. The 742 above is
the lead's *normal* capacity, the one column of 558 px left beside a picture; a lead that carries
neither a photograph nor a chart sets in two of them and will take everything up to the model's
1,600-byte field.

Everything must be **English and Latin-1**. The bundled faces carry ASCII, Latin-1 and the
typography in `ui_strings.h`'s `S_DATA_PUNCT` — nothing else, because headlines arrive over the
network and cannot be subset. A CJK character or an emoji is a tofu box on the largest type on the
page. `test_news_mock.c` is the model-layer canary for this and the simulator's coverage check is
the real one; `--validate` (below) catches it before either.

## Charts

```json
"chart": { "kind": "candle", "span": "1M", "bars": [[181.00, 184.20, 180.10, 183.22]] }
"chart": { "kind": "line",   "span": "5D", "bars": [119.85, 120.12, 119.64] }
```

| key | type | clamp |
|---|---|---|
| `kind` | `"none"` \| `"line"` \| `"candle"` \| `"bar"` | case-insensitive; anything unknown is `none` |
| `span` | string | 8 bytes |
| `bars` | array | 48 entries, **oldest dropped** |

A bar is either a quadruple `[open, high, low, close]` or — for a line chart — a bare number.
`CHART_LINE` reads closes alone, but the flat form fills all four arrays with the same value anyway,
so a consumer that reaches for the high gets a zero-height bar rather than one spanning the whole
scale. A quadruple containing a non-number, or shorter than four entries, is skipped; a bar with a
hole in it is not a bar.

A `kind` with **no usable bars is zeroed to `none`**, so "is there a chart" stays one test and not
two. The story then reflows without it, which is normal.

`span` is carried in the model and fed to `news_hash()`, but nothing currently prints it. Send it —
it is free, it is fingerprinted, and it is what a chart label will read from.

Charts are drawn in black. Sparklines in the quotation table are 150 × 16, and that width is
load-bearing: it is the fifth field in `90 + 230 + 130 + 120 + 150 + 4·8 = 752`.

## Photographs

```json
"photo": { "id": "nvda_hq", "w": 558, "h": 300, "caption": "…", "credit": "REUTERS" }
```

| key | type | clamp |
|---|---|---|
| `id` | string | 16 bytes; `[A-Za-z0-9_-]` only |
| `w` | number | 0..1200 |
| `h` | number | 0..1600 |
| `caption` | string | 120 |
| `credit` | string | 32 |

An `id` without both dimensions is not a photograph, it is a GET that cannot be made, so **the whole
photo object is dropped** — `id[0] == '\0'` is the model's single test for "no photo" and it is made
true in one place rather than at four call sites. The id becomes a path component and `"../../etc/passwd"`
is a perfectly good JSON string, so `ui_tile.c` restricts it to letters, digits, underscore and
hyphen: no dot, no slash, no percent.

Only the **lead** carries a photograph, and `w` × `h` must be exactly **558 × 300** — the lead
visual slot. A descriptor of any other size is refused rather than scaled, because the bytes have
already been through a dither and resampling a screened image dithers it a second time, which is
coloured confetti rather than a slightly soft photograph.

### The tile

```
GET <the news URL's directory>/tiles/<id>.bin   ->  raw 4 bpp, exactly w*h/2 bytes, no header
```

The base is the snapshot's own URL with any query or fragment cut off and everything after the last
`/` removed. `http://mac.local:8123/news.json` gives `http://mac.local:8123/tiles/nvda_hq.bin`.

The device does not resize, tone-map or dither anything. A tile is pixel data in **the framebuffer's
own nibble order** — row-major, two pixels per byte, even x in the high nibble — so the blit is a
per-row copy. That is why the width must be even, and why every column span and origin in the grid
is even: an odd slot would need a nibble-shifting blit for nothing.

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

A missing tile is an ordinary front-page condition — a slow wire, an id that went stale between the
JSON and the GET — not an error. The lead falls back to its chart; with neither, the body takes the
full measure in two columns.

### Make tiles with `tools/make_tile.py`

```bash
python3 tools/make_tile.py photo.jpg -o tiles/nvda_hq.bin -W 1140 -H 360 --preview /tmp/check.png
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

The lead's slot is **1140 × 360**, full measure. Both numbers are even and so is its origin, which is
what lets the device blit the tile as a per-row `memcpy` instead of shifting nibbles.

## What is a rejection and what is a clamp

A rejection discards the whole payload and leaves the page alone. Everything else clamps silently.

**Rejected:**

- not JSON, not a JSON object, or truncated (`cJSON_ParseWithLength` fails);
- the scratch allocation fails;
- a well-formed object carrying **no stories, no tickers and no indices whatsoever** — which is what
  a login page, a health endpoint or an error envelope parses down to, and replacing a good page
  with blankness is the failure the user actually notices.

Before the parser is even reached: transport failure, and any status outside 200–299.

**Clamped:** everything else. A negative width, a 900-entry array, a string where a number belongs,
a chart with no bars, a rank of 4,000, a spark value of 12,000, a photo id with no dimensions. Each
goes to a default or a bound, and the page prints.

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
page: all five ribbon cells, both blocks of eight quotes, four stories, a lead whose body overflows
one column, a lead carrying both a photo and a chart, exactly one line chart in the secondary row, at
least one story with no symbol, both colours present in the quotes, and a chart whose last close is
the price printed beside it.

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
validate: /Users/you/.wpnews/edition/news.json — ok (4 stories, 16 quotes, 0 warning(s))
```

A failure names the slot and what it will do:

```console
$ python3 tools/mock_news_server.py --validate components/news_core/test/host/fixtures/news.json
  FAIL  stories[0].photo: …/fixtures/tiles/nvda_hq.bin is missing — the slot renders empty
validate: components/news_core/test/host/fixtures/news.json — 1 problem(s)
```

`FAIL` lines go to stderr and set the exit status; `warn` lines (a body under 600 characters for the
lead, under 200 for a secondary) go to stdout and do not. The scheduled desk in
[`tools/edition/`](../tools/edition/README.md) runs this before it files, because a page the firmware
would reject is a wasted cycle whose failure shows up hours later as a `STALE` badge with nothing to
explain it.

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
