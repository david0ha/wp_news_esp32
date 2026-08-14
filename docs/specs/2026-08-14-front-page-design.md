# The front page — design spec

**Status:** approved, in implementation
**Supersedes:** the four-page dashboard (`ui_page_{stats,graph,agents,notes}.c`) and the vault
data model it read.

The board stops being a dashboard and becomes **one newspaper front page**, set in portrait at the
panel's native 1200 × 1600, reporting on stocks the owner names. An agent researches them off-board
and serves a page; the device typesets it.

The visual target is a Washington Post front page hanging in a frame: **white paper, black type,
edge-to-edge**. No tinted panels, no background fills, no grey — the panel has no grey. Colour is
not decoration here; it is data, and it appears in exactly two places (§6).

---

## 1. Geometry — the panel turns portrait

The panel is natively 1200 × 1600. The current port presents it as landscape 1600 × 1200 and
rotates while packing. Going portrait **removes** that rotation.

Framebuffer becomes 1200 wide × 1600 tall, 4 bpp, stride 600, 960,000 bytes — the same size, the
same 480,000 bytes per controller.

The packing collapses to a copy. Derivation, which must be preserved byte-for-byte so the physical
image does not flip:

```
today (landscape fb):  out[plane][r][b]  =  fb_L(x = 1599 - r,  y = 600*plane + 2b)   << 4
                                         |  fb_L(x = 1599 - r,  y = 600*plane + 2b+1)

define portrait:       fb_P(px, py)      := fb_L(1599 - py, px)
                       equivalently      fb_L(x, y) = fb_P(px = y, py = 1599 - x)

substitute:            out[plane][r][b]  =  fb_P(px = 600*plane + 2b,   py = r) << 4
                                         |  fb_P(px = 600*plane + 2b+1, py = r)

and since fb_P packs even px in the high nibble at byte px/2:

                       out[plane][r][*]  =  memcpy(fb_P + r*600 + plane*300, 300)
```

So `epd6_pack_block()` becomes a per-row `memcpy` of 300 bytes, and the plane split moves from
"rows 0–599 / 600–1199" to "**columns 0–599 / 600–1199**". `EPD6_OUT_ROWS` (1600) and
`EPD6_OUT_STRIDE` (300) are unchanged, so the SPI side and the register tables are untouched.

`test_epd6_transpose.c` keeps its independent reference implementation and is rewritten to the new
mapping; the block-size invariance check (1, 7, 64, 1600 rows give identical output) stays.

`main/user_config.h`: `EPD_WIDTH 1200`, `EPD_HEIGHT 1600`.

**If the image comes out upside down on real hardware**, the fix is one line — reverse the output
row order in `epd6_pack_block` — and `epd6_selftest()`'s origin block is what tells you. Nothing
else in the stack has a handedness.

---

## 2. The grid

```
outer margin        30 px on all four sides
content             1140 × 1540
columns             6, width 170, gutter 24      (6·170 + 5·24 = 1140)

spans   1 col  170    2 col  364    3 col  558
        4 col  752    5 col  946    6 col 1140

origins x = 30 + 194·i  ->  30  224  418  612  806  1000
```

**Every span is even, and that is a requirement, not an aesthetic.** A photo tile packs two pixels
per byte, so a tile whose width is odd — or which starts at an odd x — cannot be blitted as a
per-row `memcpy` and needs a nibble-shifting slow path on the device for no reason at all. An even
column and an even gutter make every span and every origin even, and the blit stays a copy.

The gutter is 24 px (0.16 in at this panel's 150.4 dpi), which is a normal newspaper gutter and
wide enough to carry a hairline rule down its centre without crowding either column.

### Measured metrics

These are read out of the committed font files, not estimated. Every measure below is chosen
against them, and the numbers are here so nobody re-derives them wrongly:

| face | line height | avg advance | 2 col (364) | 3 col (558) | 4 col (752) | 6 col (1140) |
|------|------------:|------------:|-------:|-------:|-------:|--------:|
| `label_14`   | 18 | 6.94 |  52 |  80 | 108 | 164 |
| `body_16`    | 18 | 8.51 |  42 |  65 |  88 | 133 |
| `body_20`    | 22 | 10.44|  34 |  53 |  72 | 109 |
| `deck_24`    | 27 | 11.29|  32 |  49 |  66 | 100 |
| `display_36` | 41 | 17.43|  20 |  32 |  43 |  65 |
| `display_56` | 65 | 27.31|  13 |  20 |  27 |  41 |

So the measures are **`body_16` at 2 columns (42 characters)** and **`body_20` at 3 columns (53)** —
not the same width for both, which was the first guess and is wrong: `body_20` at 2 columns sets 34
characters, which is a caption measure, not a reading measure.

`S_MASTHEAD` at 112 px measures **1012.4 px**. It fits 1140 with room to spare, so it is set with
`letter_space 5` to **1102 px** and spans essentially the full measure — which is what makes the
page read as a newspaper rather than as a poster with a title on it.

One grid column (170 px) is never body text. It is for the folio and for table cells.

Rules are black, square, and come in exactly three weights: **hairline 1 px**, **rule 2 px**,
**heavy 3 px**. Nothing else. No radii anywhere.

---

## 3. Vertical bands

Fixed y-bands. The tier engine chooses *what* fills a band; the band never moves. A band that would
overflow is copyfitted (§5); a page with too little content promotes stories up a tier so the band
still fills.

| # | Band | y | h | Contents |
|---|------|---|---|----------|
| 1 | Kicker strip | 30 | 18 | edition (left) · dateline (right), `label_14`, caps, +2 tracking |
| — | hairline | 56 | 1 | |
| 2 | Masthead | 64 | 112 | `S_MASTHEAD` in `masthead_112`, centred |
| — | heavy rule | 186 | 3 | |
| 3 | Dateline row | 193 | 20 | session (left) · "MARKET WRAP" (centre) · as-of (right), `label_14` caps |
| — | hairline | 219 | 1 | |
| 4 | Index ribbon | 226 | 78 | up to 5 indices, evenly divided, separated by 1 px vrules |
| — | heavy rule | 310 | 3 | |
| 5 | Lead well | 318 | 588 | full-measure headline, then photo left / text right |
| — | rule | 912 | 2 | |
| 6 | Secondary row | 920 | 372 | two stories (2 cols each) + the portfolio rail |
| — | rule | 1298 | 2 | |
| 7 | Ticker + briefs | 1306 | 232 | watchlist in cols 1–4, IN BRIEF in cols 5–6 |
| — | hairline | 1544 | 1 | |
| 8 | Folio | 1551 | 18 | source (left) · "A1" (centre) · updated/next (right) |

1569 + 1 px of slack against the 1570 bottom margin edge (1600 − 30). Every band is defined as a
`#define` in `ui_internal.h` and the simulator asserts the rules land on those exact rows.

### Band 4 — the index ribbon

Five equal cells of 228 px that abut exactly (5·228 = 1140), with the 1 px vrule drawn ON each
internal boundary rather than in a gap of its own — which keeps every cell origin even (30, 258,
486, 714, 942), where the alternative of 224-px cells separated by 5-px gaps puts three of the five
on odd pixels. Content is inset 12 px. Each cell:

```
   S&P 500                      label_14, caps, tracking
   6,412.83                     display_36, lining figures
   ▲ 0.62%                      body_20, GREEN if ≥ 0, RED if < 0
```

This and the ticker table are the only coloured things on the page.

### Band 5 — the lead well (y 318 … 906)

The headline runs the full measure; underneath, the picture takes the left three columns and the
story the right three. Exact rows, stacked on the measured line heights above:

```
y     x     w     what
318   30    1140  kicker            label_14 caps, tracked          h 18
340   30    1140  HEADLINE          display_56, ≤ 2 lines           h 130
478   30     752  deck              deck_24 italic, ≤ 2 lines       h  54
540   30     752  byline            label_14 caps                   h  18
568   30    1140  hairline
578   30     558  visual            photo tile or chart             h 300
884   30     558  caption · credit  label_14, one line              h  18
578   612    558  body              body_20, 53 chars, 14 lines     h 328
```

The deck is held to 752 rather than the full 1140 deliberately: a deck at 100 characters a line is
not a deck, it is a paragraph pretending to be one.

The lead's visual is **either** a photo tile **or** a chart, never both — photo wins if the payload
supplies both. With neither, the body takes the whole 1140 and sets in two columns of 558.

### Band 6 — two stories and the portfolio (y 920 … 1292)

```
cols 1–2 (x 30, w 364)  cols 3–4 (x 418, w 364)  cols 5–6 (x 806, w 364)
┌───────────────────┐   ┌───────────────────┐    ┌────────────────────┐
│ ENERGY            │   │ RETAIL            │    │ THE PORTFOLIO      │
│ Headline over up  │   │ …                 │    ├────────────────────┤
│ to three lines    │   │                   │    │ NVDA  183.22 −1.84%│
│ Deck, italic, two │   │                   │    │ …  8 rows at 25 px │
│ lines at most.    │   │                   │    ├────────────────────┤
│ ───────────────── │   │                   │    │ chart 364 × 110    │
│ body_16, 42 chars │   │                   │    │                    │
│ 8 lines           │   │                   │    │                    │
└───────────────────┘   └───────────────────┘    └────────────────────┘
```

Story rows: kicker 920 (18) · headline `display_36` 942, ≤ 3 lines (123) · deck `deck_24` 1071,
≤ 2 lines (54) · hairline 1133 · body `body_16` 1141 (151, 8 lines).

Rail rows: heading 920 (18) · hairline 942 · eight holdings 950…1150 at 25 px · rule 1160 ·
chart 1170…1280.

1 px vrules down the gutter centres at x 405 and x 793, running the band's full height. (A 24 px
gutter has no single centre pixel; `UI_GUTTER_RULE_DX` truncates, so the rule sits 11 px in and
12 px out. The header's arithmetic is the authority — these numbers are derived from it.)

### Band 7 — the watchlist and the briefs (y 1306 … 1538)

The table takes cols 1–4 so its five fields have room; the briefs take cols 5–6. 1 px vrule at 793.

```
 SYMBOL    NAME                       LAST       CHG   ▁▂▃▅▇▆     ← headings, label_14 caps
 ───────────────────────────────────────────────────────────────  ← hairline
 NVDA      Nvidia                   183.22    −1.84%   ▁▂▃▅▇▆
   90        230                       130       120      150     ← field widths, summing to 752
```

Eight rows at 25 px, hairline under each. Sparklines are 150 × 16, black. Only `CHG` is coloured.

The remaining tickers — the model holds sixteen — are not dropped; they are what page A2 is for.

---

## 4. Who decides what

**The server decides what is important. The device decides what fits.** The split is not stylistic:
copyfitting needs the font metrics, and only the device has them; editorial ranking needs the
research, and only the agent has it.

- The server sends stories with a `rank` (0 = lead) and nothing about geometry.
- The device sorts by rank, stably, and assigns tiers by position, not by the rank value: first →
  lead, next two → the secondary row, next three → the briefs in band 7, rest dropped. Ranking by
  position means a payload that numbers its stories 10, 20, 30 works exactly as one numbered 0, 1, 2.
- Then it copyfits each into its band (§5).
- Under-supply promotes rather than leaving a hole: with two stories the second spans both secondary
  slots; with one, band 6 carries only the portfolio rail, widened to cols 3–6. With none, the lead
  well shows the index ribbon at full size and the page is a markets page — which is a legitimate
  front page on a quiet day, not an error state.

---

## 5. Copyfit

`ui_fit.c` — pure, testable on the host, no LVGL layout:

```c
/* Copy as much of `src` as fits in `w` × `h` at `font`, cut at the last word
 * boundary, into `dst` (n bytes). Returns the number of source bytes consumed
 * so a caller can continue into the next column. UTF-8 safe. */
size_t ui_fit_text(const lv_font_t *font, int w, int h, int line_h,
                   const char *src, char *dst, size_t n);
```

It measures with `lv_text_get_size()`, which is the same measurement LVGL will use to draw, so a
label that `ui_fit_text` accepted cannot then wrap onto a line that does not exist.

Headlines and decks are *not* copyfitted — they are **ellipsized at a fixed height** by the existing
`ui_lab_w()` rule, because a headline that loses its last word is worse than one that shows an
ellipsis. Only body text is cut, and it is cut at a word boundary with no ellipsis: a newspaper
column simply stops.

---

## 6. Colour policy

Everything is `WP_RGB_BLACK` on `WP_RGB_WHITE`, with two exceptions:

1. **`WP_RGB_GREEN` / `WP_RGB_RED`** on percentage changes and their ▲▼ marks, in the index ribbon,
   the portfolio rail and the ticker table. Nowhere else — not on headlines, not on rules.
2. **Photo tiles**, which are already dithered across all six inks by the server.

`WP_RGB_BLUE` and `WP_RGB_YELLOW` never reach the glass from the UI. Charts are drawn in black
(with red/green only for a candle body's direction).

The reason this is a rule and not a preference: every exact palette colour takes `wp_quantize()`'s
identity path, so black type and black hairlines come out crisp. Anything in between dithers.

---

## 7. Charts

`ui_chart.c`, drawn immediate-mode in a `LV_EVENT_DRAW_MAIN` handler with `ui_draw_*_abs()`, in
exact palette colours so nothing dithers.

- `CHART_LINE` — a 2 px black polyline, a 1 px baseline, first/last values labelled in `label_14`.
- `CHART_CANDLE` — body filled black for up, white with a 1 px black border for down (this is the
  Japanese convention and it reads at 150 dpi far better than red/green, which the panel muddies);
  wicks 1 px.
- `CHART_BAR` — black bars from a baseline.
- Sparklines in the ticker table are `CHART_LINE` at 150 × 16 with no labels, no baseline and no
  headroom margin. That width is load-bearing: it is the fifth field in the quotation table's
  90 + 230 + 130 + 120 + 150 + 4·8 = 752 sum.

Prices arrive as integers (× 100) and the scaling is integer arithmetic throughout — **no libm**,
for the same reason the graph layout had none: an ulp of difference between x86 and Xtensa moves a
pixel and fails a screenshot test for a reason that has nothing to do with the chart.

---

## 8. Photos

The device does not resize, tone-map or dither anything. The server sends a **tile**: 4 bpp packed
in the framebuffer's own nibble order, `w × h / 2` bytes, already screened. `tools/make_tile.py`
produces it.

### Photographs are halftoned to black and white, not dithered to six inks

This was rendered both ways and looked at. Error-diffusing a photograph across the six measured
inks produces coloured speckle — the test image's windows came out as red/blue/yellow noise that
reads as damage rather than as a photograph. The same image halftoned to black on white reads
cleanly at arm's length: the subject is legible, the tonal structure survives, and it looks like
something that came off a press.

That is not a compromise, it is what a newspaper does. A broadsheet screens its photographs into
one ink on paper, and the panel's black (#1F2226) on its white (#B9C7C9) is exactly that pairing.
`--color` remains available for an image that is *about* its colour, and applies gamut compression
first, but nothing on the front page uses it by default.

The tone curve runs before the screen and compresses the source into the panel's real range
(#1F2226 to #B9C7C9 is about 5:1, where a screen gives 1000:1). Mapping 0–255 onto that directly
crushes the shadows flat and blows the highlights to paper; compressing first and applying gamma
second is the order a press operator works in, and it is why the midtones survive.

```
GET <base>/tiles/<id>.bin     ->  raw 4bpp, w*h/2 bytes, no header
```

`w` and `h` come from the JSON, are clamped to the slot, and the fetch is skipped entirely if they
disagree with the byte count. Tiles land in PSRAM behind a one-entry cache keyed on `id`; a tile
that fails to fetch leaves the slot empty and the story reflows without it, which is a normal
front-page condition, not an error.

The producer does the tone and gamut compression before dithering — raw Floyd–Steinberg onto
Spectra 6 is visibly noisy at this size, and the compression presets are what make a news photo
read as a photograph rather than as confetti.

---

## 9. The data model

`news_t` keeps its name and its properties — fixed capacities, plain copyable value, no pointers,
portable to the host — and changes its contents entirely.

```c
#define NEWS_STORIES_MAX     6      /* 1 lead + 3 secondary + 2 spare        */
#define NEWS_TICKERS_MAX    16      /* two blocks of eight in band 7         */
#define NEWS_INDEX_MAX       5      /* the ribbon's five cells               */
#define NEWS_BARS_MAX       48      /* a month of daily candles              */
#define NEWS_SPARK_MAX      24

#define NEWS_HEADLINE_MAX  120
#define NEWS_DECK_MAX      180
#define NEWS_BODY_MAX     1600
#define NEWS_KICKER_MAX     24
#define NEWS_BYLINE_MAX     40
#define NEWS_CAPTION_MAX   120
#define NEWS_SYMBOL_MAX      8
#define NEWS_TIME_MAX       24
```

Money is `int32_t` cents; percentage change is `int32_t` **basis points** (`chg_bp = pct * 100`).
Neither the parser nor the UI ever holds a float.

```c
typedef enum { CHART_NONE = 0, CHART_LINE, CHART_CANDLE, CHART_BAR } chart_kind_t;

typedef struct {
    chart_kind_t kind;
    char    span[8];                       /* "1D" "5D" "1M" "6M" "1Y"      */
    int     n;
    int32_t o[NEWS_BARS_MAX], h[NEWS_BARS_MAX],
            l[NEWS_BARS_MAX], c[NEWS_BARS_MAX];   /* cents; LINE uses c[]   */
} news_chart_t;

typedef struct {
    char id[16];                           /* empty = no photo              */
    int  w, h;
    char caption[NEWS_CAPTION_MAX];
    char credit[32];
} news_photo_t;

typedef struct {
    int     rank;
    char    kicker[NEWS_KICKER_MAX];
    char    headline[NEWS_HEADLINE_MAX];
    char    deck[NEWS_DECK_MAX];
    char    byline[NEWS_BYLINE_MAX];
    char    body[NEWS_BODY_MAX];
    char    symbol[NEWS_SYMBOL_MAX];
    int32_t last_c;
    int32_t chg_bp;
    news_chart_t chart;
    news_photo_t photo;
} news_story_t;

typedef struct {
    char    symbol[NEWS_SYMBOL_MAX];
    char    name[24];
    int32_t last_c;
    int32_t chg_bp;
    int     spark_n;
    int16_t spark[NEWS_SPARK_MAX];         /* normalised 0..1000            */
} news_quote_t;

typedef struct {
    bool valid, demo;
    char edition[32];        /* "PERSONAL PORTFOLIO EDITION"                */
    char dateline[40];       /* "SATURDAY, AUGUST 14, 2026"                 */
    char session[48];        /* "U.S. MARKETS CLOSED — AUG 13"              */
    char as_of[24];          /* "AS OF 05:12 KST"                           */
    char generated_at[NEWS_TIME_MAX];
    news_quote_t indices[NEWS_INDEX_MAX];    int index_count;
    news_story_t stories[NEWS_STORIES_MAX];  int story_count;
    news_quote_t tickers[NEWS_TICKERS_MAX];  int ticker_count;
} news_t;
```

`news_hash()` keeps fingerprinting everything that reaches the glass — including the photo ids and
every bar — so a poll that changes nothing still costs no refresh. That matters more here than it
did on the 5.83": a refresh on this panel is twenty-five seconds of flashing.

---

## 10. The wire contract

Prices and percentages are JSON numbers; the parser converts. Every field is optional and every
array is clamped. **A rejected payload leaves the previous snapshot alone** — unchanged rule.

```json
{
  "edition":  "PERSONAL PORTFOLIO EDITION",
  "dateline": "FRIDAY, AUGUST 14, 2026",
  "session":  "U.S. MARKETS CLOSED — AUG 13",
  "as_of":    "AS OF 05:12 KST",
  "generated_at": "2026-08-14T05:12:00Z",

  "indices": [
    { "symbol": "SPX", "name": "S&P 500", "last": 6412.83, "change_pct": 0.62,
      "spark": [412, 480, 455, 501, 620] }
  ],

  "stories": [
    { "rank": 0,
      "kicker": "SEMICONDUCTORS",
      "headline": "Nvidia's blowout quarter resets the AI trade",
      "deck": "Guidance beat the whole sell-side range, and the supply story finally has numbers.",
      "byline": "By CLAUDE · MARKET DESK",
      "body": "SANTA CLARA — …",
      "symbol": "NVDA", "last": 183.22, "change_pct": -1.84,
      "chart": { "kind": "candle", "span": "1M",
                 "bars": [[181.0, 184.2, 180.1, 183.2]] },
      "photo": { "id": "nvda_hq", "w": 558, "h": 300,
                 "caption": "The company's Santa Clara campus.", "credit": "REUTERS" } }
  ],

  "tickers": [
    { "symbol": "AAPL", "name": "Apple", "last": 231.40, "change_pct": 0.31,
      "spark": [500, 512, 498, 530] }
  ]
}
```

`"kind"` is one of `"none" | "line" | "candle" | "bar"`. For `"line"`, `bars` may be a flat array of
numbers instead of quadruples.

### The length budget

Headlines and decks are **ellipsized**, not copyfitted (§5), so a producer that overshoots does not
get a shorter story — it gets a visible `…` in the middle of a sentence. These are the capacities
each slot actually has, computed from the measured metrics in §2, and the budget a producer should
write to, which is about 90% of capacity so that a run of wide characters does not tip a line over:

| field | slot | capacity | write to |
|-------|------|---------:|---------:|
| lead kicker | `label_14`, 1 line | — | ≤ 24 |
| lead headline | `display_56`, 1140, 2 lines | 82 | ≤ 72 |
| lead deck | `deck_24`, 752, 2 lines | 132 | ≤ 118 |
| lead byline | `label_14`, 752, 1 line | 108 | ≤ 40 |
| lead caption | `label_14`, 558, 1 line | 80 | ≤ 72 |
| lead body | `body_20`, 558, 14 lines | 742 | 600–740 |
| secondary headline | `display_36`, 364, 3 lines | 60 | ≤ 54 |
| secondary deck | `deck_24`, 364, 2 lines | 64 | ≤ 58 |
| secondary body | `body_16`, 364, 8 lines | 336 | 260–330 |

The secondary slots are genuinely tight — 54 characters is a real newspaper's second-lead headline,
and 58 is a real deck. A column 364 px wide does not negotiate. Bodies are the one field where
overshooting is free, because `ui_fit_text()` cuts them at a word or sentence boundary; write them
long rather than short, so the column always fills.

Three implementations stay pinned against each other by `test_news_mock.c`, exactly as before:
`tools/mock_news_server.py` (reference producer) · `news_parse.c` (consumer) · `news_mock.c` (the
demo snapshot, which is what an unconfigured board shows and must stay a *complete, plausible front
page* — that is the board's out-of-box experience).

---

## 11. Pages

Two, not four. `KEY0` toggles.

- **A1 — the front page.** Everything above.
- **A2 — the markets page.** The full watchlist as a table with sparklines, the indices at full
  width, and the stories that did not make A1 as one-line briefs. Same masthead treatment at
  reduced height (no blackletter — a running head in `display_36` caps).

---

## 12. What is deleted

`ui_page_stats.c` · `ui_page_graph.c` · `ui_page_agents.c` · `ui_page_notes.c` · `ui_graph.c` ·
`include/ui_graph.h` · `ui_icons.c` · `include/ui_icons.h` · `test/host/test_graph_layout.c` ·
`tools/news_server.py` (the vault scanner) · `tools/test_news_server.py` · `tools/agent_status.py`,
and every vault string in `ui_strings.h`.

The `▲▼` marks and the end-of-story square move into `ui_common.c` as `ui_draw_tri_abs()` —
they are the only two glyphs the icon file was still earning its place for.

---

## 13. Verification

Unchanged in shape, four layers, three without hardware:

1. **host** — `test_news_parse`, `test_news_mock`, `test_news_service`, `test_api_json`,
   `test_palette`, `test_epd6_transpose`, and new: `test_fit` (copyfit is pure and must be),
   `test_chart_scale` (integer chart scaling, including the flat-series and single-bar cases).
2. **producer** — `python3 tools/mock_news_server.py --check`.
3. **simulator** — `sim/sim.sh` renders the real UI at **1200 × 1600 in six colours** through the
   real `wp_quantize565()`, writes 24-bit BMP/PNG previews in `wp_palette_ink`, and asserts:
   - every rule in §3 lands on its exact row, full width, unbroken;
   - no ink outside the 30 px margin;
   - every band contains ink (a band that rendered nothing is a failure, not an empty state);
   - no label's rendered box exceeds its slot;
   - the masthead fits inside 1140 px — this is the one measurement that can only fail at 112 px;
   - glyph coverage for every fixed string and every string in the snapshot;
   - the sparse-payload and empty-payload passes still produce a full page.
4. **firmware** — `idf.py build`.

The simulator is a test, not a preview. `sim/shots/*.png` is looked at after every UI change.

---

## 14. Known follow-ups

Recorded rather than fixed, with the diagnosis already done so nobody re-derives it.

### Tabular figures for the faces that set columns

`tools/gen_fonts.py` freezes the `lnum` (lining figures) substitution into the cmap, because
`lv_font_conv` has no OpenType feature support — it reads the cmap and nothing else. That fixed the
figure *style*: every face now sets cap-height digits, `'0'` matches `'O'` and no digit hangs more
than a pixel below the baseline.

It does not freeze `tnum`, and the digit **advances** are still proportional in exactly the two
faces that set columns of figures:

| face | digit advances | sets |
|------|----------------|------|
| `body_16`    | tabular, 143 | running prose |
| `body_20`    | tabular, 175 | running prose |
| `label_14`   | **proportional**, spread 46  | the quotation table's LAST and CHG |
| `display_36` | **proportional**, spread 151 | the index ribbon's levels |
| `display_56` | **proportional**, spread 240 | A2's stacked index board |

That is backwards: the faces setting prose are tabular, where it does not matter, and the faces
setting columns are proportional, where it does. A right-aligned column of prices still aligns at
its right edge, but "183.22" and "984.30" put their decimal points at different x, so a stacked
column has no decimal edge — most visible on A2, where five levels stack vertically in `display_56`.

The fix is small and the machinery already exists: extend `lining_figures()` to freeze `tnum` the
same way it freezes `lnum`, for `label_14`, `display_36` and `display_56` only, then regenerate. It
needs a network run (`npx lv_font_conv`, and the families come from Google Fonts), which is why it
is recorded here rather than done inline.

### Headline breaking is greedy, not balanced

The lead headline wraps greedily, so line one runs to 93% of the measure and line two carries the
remainder — "AI trade" at 18% of 1140, and on a one-story day the single word "print" alone under a
full-measure first line. It reads as a line that overflowed rather than as a two-line headline.
`ui_fit_balance()` already scores candidate breaks and carries a stop-word penalty; it is applied to
the brief heads but not to headlines. Applying it to `display_56` and `display_36` is the fix, and
"Nvidia's blowout quarter resets / the whole AI trade" is what it should produce.

### `body_16` reads heavier than `body_20`

At 1 bpp the 16 px face quantises closer to a semibold while the 20 px face stays a book roman, so
the secondary columns are the darkest text on the sheet and the eye reaches them before the lead.
This is a rasterization consequence rather than a layout bug, and the honest fixes are to instance
`body_16` at a lighter weight or to accept it; it should be looked at on the glass before either,
because a 1-bit render on a monitor exaggerates the difference.
