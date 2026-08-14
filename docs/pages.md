# The two pages

1200 × 1600, portrait, six inks, no greys, and no partial refresh. The sheet is a newspaper front
page — white paper, black type, edge to edge — and all of it is repainted at once, because Spectra 6
has no partial waveform: a refresh is twenty-five seconds of flashing whether one figure moved or
the whole page did. That is why `news_hash()` fingerprints everything that reaches the glass and the
poller compares before it wakes the UI.

`KEY0` toggles the two pages: **A1**, the front page, and **A2**, the markets page. There is no
carousel and no third page.

Nothing reflows. Every band's y and every column's x is a `#define` in
`components/news_core/ui_internal.h`; the pages are full-bleed panes, so a child positioned at
`UI_LEAD_Y` lands at `UI_LEAD_Y` with no origin to remember; and the simulator asserts on those same
macros. A page that transcribed one of them into a literal would be asserting against its own
transcription.

## The grid

A 30 px margin on all four sides leaves 1140 × 1540 of content at (30, 30). Across it, six columns
of 170 with a 24 px gutter — 6·170 + 5·24 = 1140 exactly, so a column measured from the left edge
and the same column measured from the right land on one pixel.

| span | 1 col | 2 col | 3 col | 4 col | 5 col | 6 col |
|------|------:|------:|------:|------:|------:|------:|
| width | 170 | 364 | 558 | 752 | 946 | 1140 |

| column | 0 | 1 | 2 | 3 | 4 | 5 |
|--------|--:|--:|--:|--:|--:|--:|
| origin x | 30 | 224 | 418 | 612 | 806 | 1000 |

**Every span and every origin is even, and that is a requirement rather than an aesthetic.** A photo
tile arrives packed two pixels to a byte in the framebuffer's own nibble order, so a slot of odd
width — or one starting at an odd x — cannot be blitted as a per-row `memcpy` and would need a
nibble-shifting slow path on the device for no reason at all. An even column and an even gutter make
every number in both tables above even, and the blit stays a copy. `ui_internal.h` holds it with a
`_Static_assert` on `UI_COL_W`, `UI_GUTTER`, `UI_MARGIN` and the lead's picture slot, so an edit
fails the build rather than three pixels into the right margin on the glass.

24 px is 0.16 in at this panel's 150.4 dpi: a normal newspaper gutter, and wide enough to carry a
hairline down its centre without crowding either column. That hairline sits 11 px in and 12 px out —
a 24 px gutter has no single centre pixel, and `UI_GUTTER_RULE_DX` truncates rather than pretending
it does.

Rules come in exactly three weights — hairline 1 px, rule 2 px, heavy 3 px — all black, all square,
no radii anywhere. A fourth weight is how a page starts having a hierarchy that the eye reads as a
mistake.

One grid column, 170 px, is never body text. It is the folio and table cells.

### Measured metrics

These are read out of the committed font files rather than estimated. The line height is each face's
own `.line_height` in `components/news_core/fonts/ui_font_*.c`; the average advance is that file's
`adv_w` table run over English copy. Every measure on both pages is chosen against them, and the
characters-per-column figures are the division:

| face | line height | avg advance | 2 col (364) | 3 col (558) | 4 col (752) | 6 col (1140) |
|------|------------:|------------:|------------:|------------:|------------:|-------------:|
| `label_14`   | 18 | 6.94 | 52 | 80 | 108 | 164 |
| `body_16`    | 18 | 8.51 | 42 | 65 |  88 | 133 |
| `body_20`    | 22 | 10.44| 34 | 53 |  72 | 109 |
| `deck_24`    | 27 | 11.29| 32 | 49 |  66 | 100 |
| `display_36` | 41 | 17.43| 20 | 32 |  43 |  65 |
| `display_56` | 65 | 27.31| 13 | 20 |  27 |  41 |

So the two reading measures are **`body_16` at two columns — 364 px, 42 characters** — and
**`body_20` at three — 558 px, 53**. Not the same width for both, which was the first guess and is
wrong: `body_20` at 364 sets 34 characters, which is a caption measure and not a reading measure.

Because the line heights are exact and `ui_lab_box()` removes the theme's line spacing, a box of
*n* line heights buys exactly *n* lines: 130 px of `display_56` is two, 123 px of `display_36` is
three, 328 px of `body_20` is fourteen, 151 px of `body_16` is eight. That arithmetic is a
multiplication, not a multiplication plus a term nobody remembers to include.

`S_MASTHEAD` sets 1012 px solid in `masthead_112` against a measure of 1140, so it is tracked out to
1102 at `letter_space 5` and spans essentially the full width — which is the whole difference
between a newspaper and a poster with a title on it. The face's line height is 113 against a band of
112; the extra pixel is the descender the `g` of *Washington* needs, and it is borrowed from the ten
px of clearance above the heavy rule.

## The bands

Fixed y-bands, transcribed nowhere: the numbers below are the `#define`s themselves, and both the
`UI_RULE_TABLE` and `UI_BAND_TABLE` X-macros exist so the simulator iterates the same constants the
pages draw from.

| # | band / rule | y | h | contents |
|---|-------------|--:|--:|----------|
| 1 | kicker strip | 30 | 18 | edition · badge · dateline, `label_14` caps, +2 tracking |
| — | hairline | 56 | 1 | |
| 2 | masthead | 64 | 112 | `S_MASTHEAD` in `masthead_112` on A1; a running head in `display_36` caps on A2 |
| — | heavy rule | 186 | 3 | |
| 3 | dateline row | 193 | 20 | session · `MARKET WRAP` · as-of |
| — | hairline | 219 | 1 | |
| 4 | index ribbon | 226 | 78 | five cells of 228 |
| — | heavy rule | 310 | 3 | |
| 5 | lead well | 318 | 588 | headline full measure, then picture left / story right |
| — | rule | 912 | 2 | |
| 6 | secondary row | 920 | 372 | two stories and the portfolio rail |
| — | rule | 1298 | 2 | |
| 7 | quotation table | 1306 | 232 | watchlist in cols 1–4, `IN BRIEF` in cols 5–6 |
| — | hairline | 1544 | 1 | |
| 8 | folio | 1551 | 18 | key legend · A1/A2 · updated · battery |

1451 px of band and rule plus 88 px of gaps, laid from y=30 to y=1569 — one pixel of slack against
the 1570 bottom edge.

Bands 1 to 4 and band 8 are the **furniture**: the top of the sheet and the foot of it, printed on
every page of the section, and `ui_news.c` draws them once for both. Bands 5, 6 and 7 belong to
whichever page is on top. The split is structural, not tidiness. The two pages are transparent
full-sheet panes created *before* the furniture, so the furniture prints over them — a page that
drew its own masthead would not replace the real one, it would set a second edition line at a
slightly different width across the first, and a smear like that reads as a fault in the panel
rather than as a layout mistake. So `ui_page_front.c` and `ui_page_markets.c` draw nothing above
y=313 and nothing below y=1544.

The one exception runs the other way: the two rules *inside* the news hole, at y=912 and y=1298, are
drawn by `ui_page_front.c` rather than by the furniture, because one of them is conditional — a lead
promoted over the secondary row must not have a rule through the middle of it.

## A1, band by band

### Bands 1–4 — the furniture

The kicker strip, the dateline row and the folio each print three things and print them on the same
three columns — 30, 418, 806, each 364 wide — so the eye reads one edge down the sheet instead of
three that nearly agree.

The **badge** is the sheet's only inverted element: a filled black chip with its word reversed out,
centred on the strip. Its width is measured once against the longest of the three words and never
changes, because a chip that resized when the state did would be the only thing on the page that
moves while the news does not. One badge slot, ranked: `OFFLINE` beats `STALE` beats `DEMO`. That
order is not the obvious one — a board that has been given a URL keeps showing the demo snapshot
until its first successful fetch, so ranking `DEMO` first would badge a configured board whose
server is unreachable as `DEMO`: true, and useless, instead of `OFFLINE`, which is the thing the
reader can act on.

The **index ribbon** is five cells of 228 that abut exactly (5·228 = 1140), with the 1 px vrule
drawn *on* each internal boundary rather than in a gap of its own. That is what keeps every cell
origin even — 30, 258, 486, 714, 942 — where the alternative of 224 px cells separated by 5 px gaps
puts three of the five on odd pixels. Content is inset 12 px. Three rows stack on measured line
heights with no padding between them: the name in `label_14` at 226, the level in `display_36` at
245, the change in `label_14` at 286, ending at 304 with six pixels of clearance under it. Adding
air here pushes the change figure into the heavy rule, and a `_Static_assert` says so.

A ribbon with nothing in it is still a ribbon: five empty cells behind four vrules read as a fault,
so a payload with no indices gets one italic line across the measure instead. A short ribbon is
centred on the cell grid by a whole number of cells, which keeps every origin on
`UI_RIBBON_CELL_X()` and therefore even.

### Band 5 — the lead well, y 318 … 906

The headline runs the full measure; underneath, the picture takes the left three columns and the
story the right three. Setting a headline across all six and then breaking the body into a narrower
measure is what a broadsheet does, and it is why the page reads as a front page rather than as a
column of boxes.

| y | x | w | h | what |
|--:|--:|--:|--:|------|
| 318 | 30 | 1140 | 18 | kicker, `label_14` caps, tracked |
| 340 | 30 | 1140 | 130 | headline, `display_56`, ≤ 2 lines |
| 478 | 30 | 752 | 54 | deck, `deck_24` italic, ≤ 2 lines |
| 540 | 30 | 752 | 18 | byline, `label_14` caps |
| 568 | 30 | 1140 | 1 | hairline |
| 578 | 30 | 558 | 300 | the visual — photo tile or chart |
| 884 | 30 | 558 | 18 | caption · credit, `label_14`, one line |
| 578 | 612 | 558 | 328 | body, `body_20`, 53 characters, 14 lines |

The deck is held to 752 rather than to the full 1140 deliberately: a deck at 100 characters a line
is not a deck, it is a paragraph pretending to be one.

The visual is **either** a photograph **or** a chart, never both, and the photo wins when the
payload supplies both — which the demo snapshot deliberately does, so the layout has to resolve that
case rather than assume it away. With neither, the body takes both 558 px columns and the story runs
down the left one and continues at the top of the right.

The picture slot is a fixed 558 × 300 because that is the size the server dithered the tile to. A
descriptor whose dimensions are not exactly the slot's is refused rather than scaled: the bytes have
already been through a dither, and resampling a screened image dithers it a second time, which comes
out as confetti and not as a slightly soft photograph. A tile that fails to fetch is an ordinary
front-page condition — a slow wire, an id that went stale between the JSON and the GET — and the
story simply reflows without it.

The tile goes through the LVGL renderer as an image rather than being copied into the framebuffer,
even though it is already in the framebuffer's layout. Nothing on this page writes the framebuffer:
LVGL renders RGB565 into a draw buffer and the flush callback quantizes that into the panel's inks
one strip at a time, so a page that reached around it would be racing the strip it is drawing into.
The picture survives the trip because `ui_tile.c` hands over every pixel as an *exact* palette
colour, and the ordered dither leaves those alone at every position in its matrix — the loader
proves that per tile, over all 64 dither positions, and refuses a tile that fails.

A caption is drawn only under a picture. Under an empty slot, or under a chart that carries its own
value labels, it is a line of text about something that is not there.

### Band 6 — two stories and the portfolio, y 920 … 1292

```
cols 1–2 (x 30, w 364)   cols 3–4 (x 418, w 364)   cols 5–6 (x 806, w 364)
┌────────────────────┐   ┌────────────────────┐    ┌────────────────────┐
│ ENERGY             │   │ RETAIL             │    │ THE PORTFOLIO      │
│ Headline over up   │   │ …                  │    ├────────────────────┤
│ to three lines     │   │                    │    │ NVDA  183.22 −1.84%│
│ Deck, italic, two  │   │                    │    │ …  8 rows at 25 px │
│ lines at most.     │   │                    │    ├────────────────────┤
│ ────────────────── │   │                    │    │ chart 364 × 110    │
│ body_16, 42 chars, │   │                    │    │                    │
│ 8 lines            │   │                    │    │                    │
└────────────────────┘   └────────────────────┘    └────────────────────┘
```

Story rows: kicker 920 (18) · headline `display_36` 942, ≤ 3 lines (123) · deck `deck_24` 1071,
≤ 2 lines (54) · hairline 1133 · body `body_16` 1141 (151, 8 lines).

Rail rows: heading 920 (18) · hairline 942 · eight holdings from 950 at 25 px · rule 1160 · chart
1170 … 1280.

1 px vrules run the band's full height down the gutter centres at x 405 and x 793.

Three stories would fit the width but not the page. The rail is where the owner's own holdings live,
and a front page about your money that does not say what your money did is missing its point.

The rail's fields are the quotation table's own, at the quotation table's own widths, so a figure in
the rail and the same figure in the table half a page below sit on one grid rather than on two that
nearly agree. The symbol goes at the left edge and the change at the right; the last price sits a
gap in from the change, which pins the two numeric columns to each other whatever the rail's width
is. The name is what the leftover buys — at the rail's own 364 there is none of it and the field
measures zero, which is the arithmetic saying "there is no room for a name here" rather than a rule
written down twice; at the promoted widths it is 388 or 776, and a rail that would otherwise be a
symbol and a lot of paper becomes a quotation block.

The chart under the holdings plots the first of them. The model carries no aggregate series — the
server sends what each symbol did, not what the portfolio did — and the top holding's shape at 364
px is the honest reading of "and here is the position this page is about".

### Band 7 — the watchlist and the briefs, y 1306 … 1538

```
 SYMBOL    NAME                       LAST       CHG   ▁▂▃▅▇▆
 ───────────────────────────────────────────────────────────────
 NVDA      Nvidia                   183.22    −1.84%   ▁▂▃▅▇▆
   90        230                       130       120      150
```

The table takes columns 1–4 so its five fields have room; the briefs take 5–6, with a 1 px vrule at
x 793. The five field widths sum to 752 with four 8 px gaps: 90 + 230 + 130 + 120 + 150, landing at
x 30, 128, 366, 504 and 632. Eight rows of 25 px from y 1334, each with a hairline under it —
including the last, because a block of eight that stops without one reads as a ninth row that failed
to print. Sparklines are 150 × 16, black, no labels and no baseline. Only `CHG` is coloured.

The fifth column has no heading. The design sketch heads it with block-element characters, no face
on this board carries one, and a head that renders as five tofu boxes is worse than a head that is
not there.

The table quotes the block of eight the portfolio rail did **not** name whenever the payload carries
more than eight — the model holds sixteen, the rail has already printed the first block, and
starting the table at the ninth is what puts all of them on the sheet instead of printing the same
eight symbols twice, once compactly and once in full, half a page apart. Under nine quotes it falls
back to the top of the list and the two elements agree, which is what a paper does with a short
list. Eight blank ruled rows would not be.

The briefs are three rows of 68 px from y 1334: a kicker in `label_14`, then the headline in
`body_16` over at most two lines. The heading, its hairline and the vrule beside the table are all
hidden together when there are no briefs — a heading over nothing is the one thing on a sheet that
announces missing data.

### Band 8 — the folio

Source on the left, the page's letter in the centre, and when the sheet was set on the right, with a
22 px battery outline at the margin. The left slot carries the key legend rather than an imprint:
this sheet's source is a device with three buttons on the back of it, and the folio is the one band
where the board is allowed to say so. What a reader would want from an imprint is already on the
page — the edition heads the sheet and the desk that wrote it is in the byline.

`UPDATED hh:mm` is the minute the *glass* changed, not the minute the agent wrote the payload. The
payload's own `generated_at` is the server's clock in the server's zone and the dateline row already
prints the server's `AS OF`; a second time from the same source, at the foot of the page and
unlabelled as to whose it is, tells the reader nothing the top of the page did not. The drafted
companion `NEXT` is not printed at all, because the poll cadence is a Kconfig value the UI cannot
see, and a wrong time on the one line whose whole claim is that its times are right is worse than a
missing one.

## A2 — the markets page

A1 prints eight quotations and the model holds sixteen. A2 is where the other eight live. It is the
answer to "what is everything doing" rather than to "what happened today", so it gives up the news
hole almost entirely and spends the sheet on figures.

It draws no furniture: the same kicker strip, the same band-2 slot, the same dateline row, the same
index ribbon and the same folio, all `ui_news.c`'s, all from the same snapshot. What a page turn
changes is exactly two things — the type in the masthead band and the letter in the folio. A2 wears
a running head, `THE WASHINGTON POST · MARKETS` in `display_36` caps, centred in what the
blackletter leaves behind. The band does not shrink to fit it: the rules under it are the skeleton
both pages are printed on, and a masthead that took 40 px off itself would move every one of them on
one page and not the other.

Between the furniture A2 is a different paper, with its own bands inside the window y 318 … 1543.
Reusing A1's would set a quotation table in a slot whose height was chosen around a photograph. What
is unchanged is the grid — six columns, 24 px gutter, three rule weights, even spans — and the way
the geometry is stated: every coordinate a `#define`, every span a sum of the two grid integers, and
the sums that must agree made to agree by `_Static_assert`.

At capacity:

| band / rule | y | h | contents |
|-------------|--:|--:|----------|
| index board | 318 | 500 | five rows of 100 |
| heavy rule | 824 | 3 | |
| watchlist heads | 834 | 18 | |
| hairline | 858 | 1 | |
| watchlist rows | 866 | 496 | eight rows of 62, two blocks |
| rule | 1369 | 2 | |
| `IN BRIEF` | 1378 | 18 | |
| hairline | 1402 | 1 | |
| briefs | 1412 | 132 | three rows of 44 |

An **index row** gives one index the whole measure: the name over its level, right-aligned in a 340
px field, the mark and the change beside it, and the session's shape in a 544 px chart that ends on
the right margin exactly. The level and the change are dropped so they *end* level — 24 + 65 and
48 + 41 both finish at 89 — which is what makes a level and its percentage read as one figure rather
than as two stacked things. The level is set in `display_56`, the face `ui_fonts.h` reserves for the
lead story's headline: A2 has no lead story, and the index board *is* this page's lead. Setting it
in the secondary headline face would leave A2 with no first rank at all. Right-aligning it is
decimal alignment on a column `ui_money()` always prints to two places; set flush left, five levels
share a left edge and nothing else, with their decimal points as much as 100 px apart.

The **watchlist** is sixteen quotations in two blocks of eight, columns 1–3 and 4–6, with a hairline
down the gutter between them. Two blocks rather than one column of sixteen because a 558 px table
has room for all five fields and a 1140 px one would have to invent two more, and because eight rows
is the length a reader scans without losing the column head. The block fills down the left first and
then down the right rather than across the pair: a watchlist is read in rank order, and a reader
following one column to its foot must not have been skipping every other name to get there. The
fields sum to 558 with five 8 px gaps: 92 + 88 + 120 + 20 + 104 + 94. The symbol and the two figures
are `body_20` — a 62 px row needs them, and `label_14` in a row that deep reads as a caption that
lost its picture — while the name stays `label_14` because it is the one field that ellipsizes
routinely and a longer fragment of it is worth more than a larger one.

The up/down mark is a field of its own here, exactly as it is in A1's tables, and it is not
decoration. On a panel whose red is a brick and whose green is a moss, a row that carries its
direction in colour *alone* differs from its neighbour by nothing a reader across the room, or a
reader with any red/green deficiency, can resolve. A2 also draws a third mark A1 does not: a flat
bar in ink for a session that did not move, because +0.00% beside a solid green triangle asserts a
rise that did not happen, and on a column the eye scans for direction the reader counts that name as
a gainer.

The **briefs** are the stories that did not reach A1, at the full measure, in `deck_24` rather than
in a headline face. That choice is by measure and not by rank: `display_36` sets 53 characters
across 924 px and the length budget lets a headline run to 72, so a brief set in the headline face
would end in an ellipsis on a routine payload. `deck_24` sets 82, which holds every headline the
wire can send. A brief the reader has to finish somewhere else is not a brief.

A2's bands **flow**, which A1's do not. A row pitch that is a constant times its index is what
leaves a third of a metre of bare sheet under two index rows, outlined by band rules that still run
the full measure — a page whose middle failed to print rather than a quiet day. So the index board
does not stretch, it *ends*, and its heavy rule comes up to meet it; the briefs never stretch either
and are laid from the foot of the sheet upward; and the quotation table takes whatever is left,
because a quotation row is the one row on this page that can spend height — it carries a chart, and
a chart at 240 px says the same thing as a chart at 36 px only louder. With one block of quotations
the table takes the whole measure and the width goes to the chart. With every count at capacity the
flow reproduces the table above exactly, and a `_Static_assert` says so — otherwise the numbers in
that table would be a comment about a layout that no longer happens, which is the one kind of stale
geometry a reader of the file cannot catch.

## The tier engine, and what under-supply actually renders

**The server decides what is important. The device decides what fits.** The split is not stylistic:
copyfitting needs the font metrics and only the device has them, editorial ranking needs the
research and only the agent has it.

Stories arrive with a `rank` and nothing about geometry. `tier_assign()` sorts them on that rank,
stably, and then assigns **by position**: the first story is the lead whatever number it carries, so
a payload ranked 10, 20, 30 lays out exactly as one ranked 0, 1, 2, and a payload where every rank
is the same is laid out in the order it arrived. The sort is an insertion sort on *pointers* — a
`news_story_t` is about 2.9 KB and there are at most six of them, so swapping by value would put a
task's whole stack on the frame to save nothing.

Under-supply **promotes** rather than leaving paper. This is the part that cannot be inferred from
the band table, so it is spelled out:

| stories | band 5 | band 6 | band 7 |
|--------:|--------|--------|--------|
| 4+ | lead | two stories (364 each) + rail at 806, w 364 | table + up to three briefs |
| 3 | lead | two stories + rail at 806 | table, no briefs |
| 2 | lead | one story spanning both slots + rail at 806 | table, no briefs |
| 1 | lead, and its chart is **not** drawn here | the lead's chart at x 30, w 364 + rail at x 418, w 752 | table, no briefs |
| 0 | the index ribbon again, five rows of 117 at headline size | rail across the whole 1140 | table, no briefs |

A **promoted secondary** gets its kicker, headline, deck and hairline widened to 752 — but not its
body. 752 px of `body_16` is 88 characters to a line, which is not a column, it is a page out of a
book. So the type stays in the 42-character measure the band was built on and takes the second
slot's own body label as its second column; that label is already at the right x and the right
width, and all it needs is the byte the first column stopped on. The vrule between the two slots is
hidden, because it would cut the headline in half.

On a **one-story page** the lead's chart moves out of the well and into band 6. With nothing else to
put in those columns, a chart at the foot of the page is worth more than a second copy of it in the
well — and the well has the picture, or two columns of type, to fill itself with, whereas those
364 px have nothing else on the sheet that wants them. A front page with a hole in it is the failure
everyone sees.

On a **no-story page** the lead well becomes the index ribbon set at the size a headline is set in,
five rows of 117 (the three pixels the division drops are left at the foot rather than distributed,
which keeps every row pitch identical), and the rail takes the whole measure. A quiet day is not a
broken feed, and a markets page is what a paper prints on one — a legitimate front page, not an
error state.

A `NULL` snapshot is different again, and it is the only state that leaves paper: the rules and the
column heads stay, everything that would carry a reading goes away, and there is no "no data" line.
An unconfigured board shows the demo snapshot and never reaches this — it is the gap between
power-on and the first payload, and a sheet that announces itself as empty is worse than one that
simply has not been printed on yet.

The demo snapshot itself is a **complete front page**: four stories, five indices, sixteen
quotations, a lead that carries both a photograph and a chart. An unconfigured board is a complete
configuration, not a placeholder, and that is why the demo payload is the one the simulator judges
as paper.

## Copyfit

Bodies are cut; headlines and decks are not.

`ui_fit_text()` (`ui_fit.c`, pure and host-tested) copies as much of a story as fits in *w* × *h* at
a given face and returns the number of source bytes consumed, so the next column starts where the
last one stopped. It measures with `lv_text_get_size()`, which is the same measurement LVGL will use
to lay the label out — and that equality is the entire point: a string this function accepted cannot
then wrap onto a line that does not exist. The alternative is what LVGL does on its own, which is to
set a fifteenth line at y=330 inside a 328 px box and let it hang across the rule below.

The cut lands on a word boundary, and on a sentence boundary when the nearest one costs no line: a
column that stops on a full stop reads as a decision rather than as a bug, and it is worth having
whenever it is free. It is never worth a line. **There is no ellipsis** — a newspaper column simply
stops. The one case that cuts mid-word is a first word too long for the measure, where the
alternative is emitting nothing, and an empty column is worse than an awkward one.

Headlines and decks go the other way: they are **ellipsized at a fixed height** by `ui_lab_box()`,
because a headline that loses its last word is worse than one that shows an ellipsis, and a headline
is short enough that the ellipsis is the rare case. Body copy is the opposite — it is always too
long, and a column ending in `…` reads as a truncated message rather than as a column that continues
below the fold.

Which is also why the wire contract publishes a length budget: a producer that overshoots a headline
does not get a shorter story, it gets a visible `…` in the middle of a sentence. See
[news-contract.md](news-contract.md). Bodies are the one field where overshooting is free — write
them long rather than short, so the column always fills.

The copy buffers are sized in bytes against slots measured in characters, at the model's own field
width, because a copy desk emits em dashes and accented names and a UTF-8 character is up to four
bytes. They are file statics rather than locals: a `news_t` is 19,780 bytes — measured, with
`NEWS_BODY_MAX` at 1600 — which is already too big for a task stack, and six kilobytes of copy on
the same frame would be worse. That is the same reason both snapshots on the device are static
buffers.

## Fonts

Seven faces, all SIL Open Font License 1.1, chosen against the paper being imitated rather than by
taste: **UnifrakturMaguntia** for the blackletter masthead, **Playfair Display** for headlines (WP
sets its own in Postoni, a Didone), **Source Serif 4** for the deck and body, and **Libre
Franklin** — a revival of Franklin Gothic — for bylines, kickers, captions, tables and the folio.

| face | family | size | role |
|------|--------|-----:|------|
| `ui_font_masthead_112` | UnifrakturMaguntia | 112 | the paper's name |
| `ui_font_display_56`   | Playfair Display, wght 800 | 56 | the lead headline; A2's index levels |
| `ui_font_display_36`   | Playfair Display, wght 700 | 36 | secondary headlines, the running head, index levels |
| `ui_font_deck_24`      | Source Serif 4 Italic, opsz 11 | 24 | the standfirst, and A2's briefs |
| `ui_font_body_20`      | Source Serif 4, opsz 10 | 20 | the lead's body, A2's quotation figures |
| `ui_font_body_16`      | Source Serif 4, opsz 8 | 16 | column body text |
| `ui_font_label_14`     | Libre Franklin, wght 600 | 14 | bylines, kickers, captions, tables, folio |

118 KiB of flash for all seven, against an 8 MB app partition. There is no separate numeral face:
the ribbon's `6,412.83` is set in the headline Didone and the tables in Franklin, which is not a
compromise — lining figures are the point of both families, and a table set in the same face as the
headlines above it is what makes a front page look typeset rather than assembled.

Every caps label on both pages takes `letter_space 2`. Franklin's caps were cut to be spaced, and a
kicker set solid reads as one long word from the distance this panel is looked at.

### Every face is 1 bpp, and that is a measurement

The panel has no grey. LVGL renders anti-aliased text as intermediate RGB565 and the flush callback
puts that through `wp_quantize565()`, which ordered-dithers to the six inks. For a photograph that is
correct and necessary. For text it is destructive: a 16 px serif stem is about 1.5 px wide, so half
of it is anti-aliasing, and dithering that half turns a solid stem into a dotted one. Rendered side
by side at 3×, 4 bpp body text has holes punched through `m`, `w` and every descender, and the
112 px masthead grows a ragged stipple along contours that 1 bpp keeps smooth.

At 1 bpp every text pixel is exactly `WP_RGB_BLACK` or `WP_RGB_WHITE`, and `wp_quantize()` maps both
to themselves under every dither offset — so text takes the quantizer's identity path and cannot
pick up a colour fringe. The saving is incidental but large: all seven faces together cost less than
one of the two 완성형 Korean faces this board replaced.

### Optical sizes are calculated, not chosen

Source Serif 4 carries an `opsz` axis calibrated in points, and this panel's pixel pitch is known —
1600 × 1200 across a 13.3" diagonal is 150.4 dpi — so `opsz_for(px) = round(px · 72 / 150.4)`,
clamped to the axis's own 8…60 range, is arithmetic rather than a taste call. `ui_font_body_16` is
7.7 pt and instanced at opsz 8: sturdier stems and more open counters than the same family at
opsz 20, which is what survives a 1-bit render.

### Coverage, and the never-hand-edit rule

Headlines, decks, bylines and body text arrive over the network and cannot be subset, so every
*text* face carries ASCII, all of Latin-1 (Bogotá, Zürich, Müller are routine in a dateline) and the
typography in `S_DATA_PUNCT` — 216 or 217 glyphs each. The masthead face is the exception: it is
subset, but to the whole Latin alphabet plus `" .,'-&"` rather than to the letters `S_MASTHEAD`
happens to use, so pointing the board at a different paper is one line and not one line plus a font
regeneration. That cost about 50 KB and bought the avoidance of tofu boxes across the largest text
on the screen.

All fixed user-visible strings belong in `ui_strings.h`. That is where `tools/gen_fonts.py` reads
the glyph lists from, and where the simulator's coverage check reads them from; a label added
straight into a page file is a tofu box on the glass.

**Never hand-edit `components/news_core/fonts/*.c`.**

```bash
python3 -m venv /tmp/fontenv && /tmp/fontenv/bin/pip install fonttools
/tmp/fontenv/bin/python tools/gen_fonts.py --download
tools/gen_fonts.py --dry-run      # report the glyph sets and stop
```

fontTools is needed because Google publishes three of the four families only as variable fonts, and
lv_font_conv's parser reads a variable font's *default* instance and nothing else — asking it for
Playfair Display Bold would silently produce Playfair Display Regular. Each face is instanced to a
fixed point on its axes first, and lv_font_conv only ever sees a static TTF. The generated `.c`
files are committed, so a normal build needs neither node nor Python.

## Colour

**White paper, black type, edge to edge.** Colour on this sheet is not decoration, it is data, and
it reaches the glass in exactly two places:

1. **Green and red on percentage changes and their up/down marks** — in the index ribbon, the
   portfolio rail, the quotation tables and A2's index board. Nowhere else: not on headlines, not on
   rules, not on a chart's axis. A change is green at zero, because a flat session is not a loss and
   a column where nought is a third colour has three states where the eye wants two.
2. **Photo tiles**, which arrive already screened by the server.

Blue and yellow never reach the glass from the UI at all. Partly because the panel renders those two
inks least faithfully of the six — but mostly because a page that spends colour on ornament is a
page where the two colours that carry meaning stop being seen.

The rule is enforceable rather than aspirational. All four of `UI_INK`, `UI_PAPER`, `UI_UP` and
`UI_DOWN` are exact palette entries, so they take `wp_quantize()`'s identity path and come out flat;
a colour anywhere between two inks dithers, and a dithered hairline is a dashed one. Green and red
enter through exactly two calls — `lv_obj_set_style_text_color()` on a change label, and
`ui_draw_tri_abs()` for its mark — so grepping a page file for `UI_UP` and `UI_DOWN` is the whole of
the audit. And the simulator checks the framebuffer directly: no blue or yellow anywhere on either
page, and no red or green outside the handful of named boxes. See
[the simulator](simulator.md).

The same argument is why the charts are drawn with an integer Bresenham run and not with
`lv_draw_line()`. LVGL antialiases a diagonal, this panel has nothing between ink and paper for the
blend to land on, and `wp_quantize565()` resolves the mid-greys a black stroke on white paper
produces to **green** — so a chart drawn the easy way is a black chart fringed with green speckle,
in a band the colour policy does not allow colour in, and the reader sees it as dirt on the paper.

### Photographs are dithered across all six inks — and the first answer was wrong

`tools/make_tile.py` diffuses a photograph across the full palette by default. `--halftone` opts
back into black ink on white paper.

That default was the other way round for most of a day, and the reversal is worth recording because
the mistake is easy to repeat. The first test of colour was run against a SYNTHETIC image — flat
rectangles of saturated colour — and produced exactly the confetti the muddy primaries predict, so
the halftone was made the default on that evidence.

The evidence was bad. Flat colour is the worst case for error diffusion: there is no local detail to
absorb the residual, so the whole area breaks into visible speckle. Re-run against an actual
photograph the result is different — a real image has texture at every scale, the diffusion has
somewhere to put its error, and the six inks resolve into something that reads as a colour
photograph: warm window light, a pale sky, green in the trees. Noisy in the shadows, clearly colour
everywhere else.

Two things follow. **Never judge a dither on synthetic input** — it is a measurement of the input's
flatness, not of the panel. And **the tone curve matters more than the palette does**: the first
attempt used a black point of 24 and a gamma of 0.92 and crushed every building in the frame into
one flat ink. The defaults are 60 and 0.72, and a tile that comes out looking like a silhouette
wants that knob, not a different palette.

The halftone remains the right treatment for a document scan, a chart, or a portrait whose colour
carries nothing — which is what `--halftone` is for.

## Where the layout is asserted

`sim/sim.sh` renders both pages at the real 1200 × 1600 through the real quantizer into a real 4 bpp
framebuffer and asserts on it: the rules on their exact rows, the margin, every band inked, every
widget inside its slot, no two labels sharing paper, the masthead inside 1140, glyph coverage for
every string, and the colour policy above. It exits non-zero on any failure. See
[simulator.md](simulator.md), and look at `sim/shots/*.png` after any UI change.
