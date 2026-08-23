# The single-company broadsheet

**2026-08-15.** Supersedes the data model and page layout of
[2026-08-14-front-page-design.md](2026-08-14-front-page-design.md). That document's geometry
(§1–§2), colour policy (§6), chart rules (§7) and photo rules (§8) still hold and are not restated
here.

## What changed

The paper was a portfolio digest: sixteen quotes, five indices, four unrelated stories, and a
sector-wide view assembled from a watchlist. It is now a **broadsheet about one listed company**.

The owner's brief, verbatim: *"each screen should cover one stock — not a general overview table"*,
*"the current price move and why it moved; if it is market-linked, explain it together with the
market; related news; the company's indicators"*, and, on the layout, *"this is a newspaper before
it is a stock display."*

Two pages, one company:

- **A1** — why the price moved, whether the whole tape moved with it, what else happened to the
  company this week, and its numbers in a standing rail down the side.
- **A2** — the same company's accounts: quarterly results, growth, the balance sheet, the
  consensus, and the industry comparison.

The device does not choose the company. The payload names it, and whoever produces the payload
picks it — the same rule the rest of the system runs on.

## §1 What the reference pages actually do

The target is the Wall Street Journal's printed front page, not the Washington Post's. Taking one
apart (1 July 2024) gives nine modules whose widths are all different:

| module | width | legs | character |
|---|---|---|---|
| What's News | 1 col, **full height** | 1 | digest bullets, no art, page refs in bold |
| photo + lead | 3 col | 3 | the dominant picture, wide headline over 2 lines |
| Biden's Top Allies | 1–2 col | 1 | headline broken over **five** lines — a vertical column |
| DOJ Seeks Boeing | 1 col | 1 | headline over six lines, very narrow |
| AI Spurs Gap | 1 col | 0 | **the page's only chart**, inside a story |
| Behind Glitter of Davos | 3 col | 2 | wide headline over 2 lines |
| Tractor Supply | 4 col | 3 | horizontal |
| A-hed | 2 col | 2 | italic headline, small line drawing |
| INSIDE | 2 col | 0 | **two small pictures** with captions |

Three findings decided this design.

**The tape is one thin line of furniture.** `Last week: DJIA 39138.86 ▲31.47 0.08% | NASDAQ … | YEN
160.88`, set smaller than the body text, directly under the nameplate. Our page gave it an 82 px
band of 36 px numerals — and that single element was most of why the sheet read as a quote screen
rather than as a newspaper.

**Headline size is constant; width changes the shape.** The same face over one column breaks into
five lines and reads as a vertical pillar; over four columns it breaks into two and reads as a
horizontal beam. The variety on a front page comes from this, not from varying the type size.

**One dominant picture, several small ones.** The literature is consistent: a page wants
[one dominant element about 2.5× any other](https://www.slideshare.net/slideshow/layout-25128670/25128670),
and at least a third of a well-designed page is art. Two similarly sized pictures are worse than
one big one and two small ones.

Supporting rules taken from the same sources and enforced below: modular layout means every story
is a rectangle and unrelated elements never wrap around each other, because
[an L-shaped wrap (a "dogleg") makes an irregular container the eye cannot follow](https://www.tameri.com/dtp/designlex.html);
two equal headlines must not abut across a gutter (**tombstoning**); art never sits mid-leg or at
the foot of a leg, and text under a picture is at least one inch deep — 150 px at this panel's
150.4 dpi.

## §2 The measure decides everything

The grid is unchanged: six columns of 170 with a 24 px gutter inside a 30 px margin
(6·170 + 5·24 = 1140), both numbers even so every span and origin is even and a photo tile blits as
a per-row `memcpy`. Six is also what
[most of the world's best-designed newspapers use](https://journalredesign.wordpress.com/2011/08/20/five-column-vs-six-column-grid/).

What is new is treating the measured average advance as a constraint rather than a fact.
`ui_font_body_16` is 8.51 px and `ui_font_body_20` is 10.53:

| span | px | body_16 | body_20 | verdict |
|---|---:|---:|---:|---|
| 1 col | 170 | 20 ch | 16 ch | **never prose** |
| 2 col | 364 | 42 ch | 34 ch | the standard leg |
| 3 col | 558 | **65 ch** | 53 ch | body_16's optimum |
| 4 col | 752 | 88 ch | 71 ch | body_20 only |

Typography's working range is 45–75 characters with an optimum near 66, and newspapers legitimately
set at the narrow end. What the table settles is the floor: **a one-column leg is three words wide
and no copyfitting rescues it.** So a module that sets prose needs two columns, and multi-leg
"continued in the next column" texture needs four or more.

That constraint turned out to be the design. The Journal's standing rail is one column of prose;
ours cannot be, so it is **one column of numbers** instead — and the company's valuation,
profitability, balance sheet and consensus go exactly where What's News goes. The vertical spine the
page needs and the dossier the edition owes its reader are the same object.

## §3 The compositor is a guillotine

The eight fixed vertical bands are gone. `ui_compose.h` / `ui_compose.c` now cut the well.

A free compositor can produce an ugly page. This one cannot, because every cut runs **edge to edge
across the rectangle it divides**. Take the reference front page apart and that is already what is
there: a vertical cut separating the rail from the body, horizontal cuts dividing the body into
bands, vertical cuts dividing each band into stories. The photo-and-lead package and the column
beside it end on exactly the same line because they are two halves of one cut.

That restriction buys three properties structurally rather than as tests that might not have been
written:

- every module is a rectangle — no doglegs, no L-wraps around a photograph;
- the modules tile the well exactly — no overlap, no gap, **no white hole at the foot**;
- a module's neighbours are known, so the rules that are about neighbours have somewhere to live.

The tree is deliberately shallow — an optional horizontal cut at the rail's foot, a vertical cut
separating the rail from the body, horizontal cuts into bands, vertical cuts into at most three
modules each. That covers every arrangement the reference pages use.

**Packing** is by rank, greedily, into bands whose spans sum exactly to the pane. Spare columns go
by `weight` — how much copy the module brought — which is how a story with 700 bytes of body ends
up four columns wide and one with 200 ends up two.

**Height** is the part that guarantees a full page. Each module reports `h_min` (its furniture plus
one line) and `h_pref` (finished) at its final width, through a callback the page supplies — so
`ui_compose.c` is pure geometry and is host-tested with no LVGL at all. Then:

- too much room → the surplus goes to the **elastic** bands, and `ui_fit_text()` fills it with more
  body copy;
- too little → drop the last band (highest rank) and re-pack, repeatedly; a single band that is
  still too tall is clamped and its modules copyfit into it.

`ui_compose()` is **total**: it always returns a valid tiling. There is no failure path for a caller
to get wrong, because the failure a reader would actually notice — a hole in the page — is the one
thing it must never produce.

It is also **pure**. `news_hash()` promises that two snapshots with the same fingerprint produce the
same pixels and the device skips a twenty-five-second refresh on that promise, so no clock, no
random, no float, and the same rectangles on x86 and Xtensa.

**Anti-tombstoning** lives in `ui_head_weight(rank, cols, left)`: the headline weight comes from the
rank, widens a step for a narrow module, and is demoted if it would equal the module to its left.

## §4 The data model

`news_model.h` is rewritten around `subject` — one company — plus arrays the compositor edits down
to what fits. Capacities are deliberately **larger than one page can hold**: the producer is asked
for a generous file and the device does the editing. A payload sized to exactly fill one layout
would make the compositor pointless.

Two kinds of number cross the wire and they are handled differently:

- a number the device must **reason** about — sort it, colour it, scale a chart against it — is an
  integer and stays one: money in `int32_t` cents, change in basis points. Nothing holds a float,
  because the chart scaling has to agree bit for bit between x86 and Xtensa.
- a number the device only has to **print** — a market capitalisation, a P/E, a line of a cash-flow
  statement — arrives as a **preformatted string**. How many significant figures, which suffix,
  which currency is a house-style decision the producer owns, and asking a microcontroller to make
  it twenty-eight times buys nothing and costs a class of bug.

Charts moved to the top level and a story names one by index: a `news_chart_t` is 784 bytes and
would otherwise be carried, empty, by every story.

## §5 The furniture

| strip | y | h |
|---|---:|---:|
| masthead | 30 | 112 |
| dateline | 155 | 20 |
| tape (one line) | 188 | 20 |
| **the well** | **222** | **1318** |
| folio | 1551 | 18 |

Three deletions, all requested:

1. **The strip above the masthead is gone.** No broadsheet has one; both reference papers start at
   the nameplate and put the date in a ruled line beneath it. It cost 34 px.
2. **The tape lost 62 px**, from an 82 px band of display numerals to one line of small caps.
3. **The folio carries no clock.** `as_of` on the tape says when the numbers are from, which is the
   honest statement. A second timestamp at the foot saying when the sheet last repainted is a
   machine's concern printed on a reader's page, and on a panel this slow it reads as a demand to
   keep it fed. A newspaper carries a date.

Together those gave the well 96 px.

## §6 The producer sets the type before it files

New requirement, and the one that closes the loop. The desk cannot see the paper: it writes JSON,
and twenty minutes later a panel spends twenty-five seconds turning that JSON into type. A lead
headline four characters over budget is not a validation error — it is an ellipsis in the middle of
a sentence that nobody finds out about.

So `tools/edition/render-check.sh` runs the **actual typesetter** — the same `news_core`, the same
seven faces, the same compositor, the same six-ink quantizer the firmware runs — over the candidate
payload at 1200 × 1600 and leaves both sheets as PNGs. The desk is required to run it, fix what it
names, **look at the sheets**, and only then rename `news.json.tmp` into place.
`agent/standalone/file-edition.sh` re-runs it as a gate afterwards, because a standing instruction
is a request and this is a check.

`PROMPT.md` also now carries the **minimum research checklist** — valuation, per-share,
profitability, balance sheet, dividend, six quarters of results, consensus and surprises, the
street's targets, the industry comparison, and revenue by segment. A field the data source does not
have is not permission to omit it; it is the thing to go and find out.

## §7 Verification

The simulator's assertions changed kind. They used to be *"the lead rule lands on row 1108"*, which
cannot survive a page that changes shape. They are now **property checks**, which is a stronger
claim and holds for every payload rather than for the three the test happens to build:
`ui_compose_check()` passes, every placed module contains ink, nothing crosses the margin, no labels
overlap, every glyph exists, blue and yellow never reach the glass, green and red appear only where
a change figure legitimately is, every module x and w is even, and the page is not grey.

`test_compose` drives the same invariants over thousands of generated module sets with a
deterministic LCG.

## §8 Second pass — the rail becomes graphics, and the page can run tall

Everything above shipped and was looked at. Four things came back from that review, and all four are
about the same failure: **the sheet was structurally correct and editorially flat.**

### The rail was a spreadsheet with a rule down one side

Twenty-eight figures, each two lines, each exactly as loud as the last, running the full 1338 px.
Nothing on it was more important than anything else, so the eye had nowhere to land and read none of
it. The one-column constraint of §2 is still right — a one-column leg is three words wide — but "one
column of numbers" was never a licence to make it *twenty-eight equal numbers*.

`news_figure_t` gains `emph` and `bar`, and the rail gains two tiers:

| tier | what it is | how it is set |
|---|---|---|
| hero (`emph` 1) | the two to four figures carrying the day's argument | caps label, value in display type, its change with ▲▼, and where `bar` ≥ 0 a hard-pixel range bar under it |
| small (`emph` 0) | everything else | label and value on **one** line, label ellipsized left, value right |

The second tier is where the space comes from — one line instead of two, across twenty-odd figures.
`bar` is what makes a hero a *graphic* rather than a bigger number: a price against its 52-week
range is a picture, and $1,631.47 set in 36 px is still just a number. It is normalised 0–1000 by
the producer for the same reason `news_quote_t::spark` is — the device cannot see the units, and a
rail that guessed them would draw a confident wrong bar.

This is the same editorial judgement `rank` already makes about stories, applied to numbers. The
device still does not sort and still does not decide what matters.

### Two tables stop being tables

Six quarters of revenue, profit and margin printed as eighteen cells is a thing the reader must
assemble in their head; the same eighteen numbers as bars with a line over them is a thing they see.
So `news_table_t` gains `render` — `TABLE_PRINT`, `TABLE_STACK`, `TABLE_BARS_LINE` — and the
producer says which of its tables is an argument and which is a record.

A drawn table needs numbers, and every cell in this model is deliberately text: `"10,584"` and
`"(1,203)"` and `"—"` are three house decisions about the same int64 and the device must not try to
undo any of them. So the producer sends **both**: `v` is what is printed and `n` is what is drawn.
Without a complete `n`, `has_n` is false and the table prints — the same degradation `news_parse()`
makes everywhere else, fall back to the thing that still works. An unknown `render` word is
`TABLE_PRINT` for the reason an unknown chart word is `CHART_NONE`: a table drawn with the wrong
geometry is worse than one that was only printed, and printing is never wrong.

There is **no new module kind**. `UI_MOD_TABLE` renders three ways off the table's own `render`, and
nothing about *where* the module goes changes with the answer. The compositor never learns there was
a choice.

### Colour, extended exactly one step

The house rule is *colour is data, not decoration* — green and red only on percentage changes and
their ▲▼ marks. The graphics do not get an exemption from it, they get a reading of it:

- **`TABLE_BARS_LINE`**: the line row is a percentage series, so it may carry colour — green when
  its last value is at or above its first, red when below, and its end value printed in the same
  colour with the matching mark. One coloured element, encoding one fact.
- **`TABLE_STACK`**: a segment's *share* is not a change, so the segments are separated by **screen
  tone** — solid, 50 % checker, 25 % dot, outline — which is how a newspaper has always printed a
  stacked bar. What may carry colour there is each segment's percentage-point change against the
  first period, beside its legend entry. That is a change, so it is data.

The line row's `n` is therefore **basis points**, because every percentage that crosses this wire is
basis points and a chart that quietly used a different unit from the figure printed beside it is the
one error nobody forgives.

### The page could only ever come out in horizontal slices

With the rail pinned to the left for the full height of the well, every package on the sheet was
five columns wide, and a five-column package holding 700 characters is 150 px deep. The page was
structurally incapable of the shape a broadsheet actually uses for a big day — the reference front
page of 1 July 2024 is a photograph across the whole measure, a two-line headline under it, and the
story running down the page in five narrow legs.

Three changes, and none of them relaxes a cut:

1. **`ui_mod_t.banner`** — a request to run across the whole measure on a band of its own at the top
   of the well, with the rail beginning underneath. Still a guillotine cut, still edge to edge, so
   it costs none of §3's safety. At most one module gets it; it is squeezed toward its `h_min` as
   far as it takes for everything else to clear *its* minimum, and abandoned entirely rather than
   dropping a module — a page that lost its rail and its briefs to make room for one photograph is
   worse than one that did not get its banner.
2. **`legs_for()` becomes measure-driven**, like everything else here. It was `floor(cols/2)` capped
   at three, so the full measure got three legs of 366 px. It is now the largest count up to four
   whose leg is at least 230 px — about 28 characters at `ui_font_body_16`'s measured prose advance,
   which is real newspaper measure; the Journal sets about 32. At 1140 px that is **four legs of
   270 px**, which is the reference page exactly.
3. **`NEWS_BODY_MAX` 1600 → 2400.** Four legs of 33 characters down most of a sheet is about two
   thousand characters, and 1600 was sized for a story that sat in a band. The compositor stretches
   an elastic module to fill the room it was given, so a body that runs out is visible as white paper
   rather than as a shorter story.

**This is not a forme repertoire.** That was considered and rejected in favour of assembling from
rules every time, and the decision stands: the page chooses one boolean about whether the lead runs
across the top, and every rectangle on the sheet is still cut fresh from what actually arrived.
Whether the day's lead deserves the whole measure is an editorial judgement about the copy and the
photograph — exactly like `rank`, which the compositor has never made either.

### The folio came off

The one strip whose removal needs an argument, because every newspaper has one. A folio answers
*which page of what am I holding, and where do I turn next* — and this paper is a single sheet in a
frame on a wall. There is no next page, nothing to collate it with, and no second copy to tell it
apart from. `A1` under a sheet that is the only sheet is furniture answering a question nobody
asked, and the masthead, the sector and the symbol are all already on the dateline row. The well
runs to the bottom margin now, and `UI_WELL_B == UI_CONTENT_B` is asserted rather than merely true —
any slack there is paper the compositor was never offered.

## §9 Third pass — the panel has six inks and can print about three

The second pass put drawn statements on the sheet and left them black. The owner's reply was the
obvious one: *"색이 너무 지금 안쓰이고있어. color잖아. 6색인가 가능하다며. 글에는 검은색만 쓰는게
맞지만, 나머지 그래프, 막대그래프에 대해서 쓸 수 있는거아니야?"* — the type is right in black, but
why is a bar chart black on a six-colour panel?

It was a fair question with an answer nobody had actually looked up. The ban on blue and yellow
(§6 of the front-page spec, and `docs/pages.md`) rested on two claims: that the panel renders those
two inks least faithfully, and that a page spending colour on ornament stops the two colours that
carry meaning being seen. The second claim is about *ornament* and does not touch a bar chart, where
colour would be carrying which quantity a bar is. The first claim had never been checked.

### What the measurement says

`tools/contrast.py` computes WCAG contrast from the measured ink table. The result is not "yellow is
a bit weak":

| | rel. luminance | vs paper | vs black |
|---|---|---|---|
| black `#1F2226` | 0.0158 | 9.18 : 1 | — |
| red `#62201E` | 0.0372 | 6.92 : 1 | 1.33 : 1 |
| blue `#233F8E` | 0.0587 | 5.56 : 1 | 1.65 : 1 |
| green `#35563A` | 0.0772 | 4.75 : 1 | 1.93 : 1 |
| 1-in-3 screen | 0.3744 | 1.42 : 1 | 6.46 : 1 |
| yellow `#C1BB1E` | 0.4697 | 1.16 : 1 | 7.90 : 1 |
| paper `#B9C7C9` | 0.5538 | — | 9.18 : 1 |

**The inks are two bands with nothing between them.** Four inks sit between 0.016 and 0.077; the
screen, yellow and paper between 0.374 and 0.554. Every within-band pair is under 2 : 1 and every
cross-band pair is over 3.3 : 1. There is no middle of the range to put a third series in.

That is the whole finding, and it is more useful than the individual numbers. A panel advertised as
six colours gives a chart **one clean cut of value** — dark or light — and a third distinguishable
series has to be bought somewhere else: in hue (blue against black is 1.65 : 1 in value and
unmistakably blue) or in texture (a 1-in-3 screen against flat paper is 1.42 : 1 and obviously
striped). `ui_series_at()` picks treatments by maximising the minimum separation across all three
axes, which is why it is not `(ui_series_t)i` and why it has a host test that proves the choice
rather than restating it.

Yellow is the extreme case. At 1.16 : 1 against the paper it is not a weak colour, it is very nearly
no colour: a yellow bar reads as the *outline* of a bar. Against black it is 7.90 : 1, the best pair
the panel has after black on paper. So yellow is legal **only enclosed by a black keyline**,
`ui_series_fill()` is the one call that can draw one, and the simulator fails the build on a yellow
pixel that can reach paper without crossing black — structural in two independent places, because
the alternative is a graphic that renders correctly in the primaries the UI draws with and vanishes
on the glass.

### Colour now means exactly two things

The old rule was a test — *"if a mark is not a percentage change, it is ink"* — and it stays a test.
It gains a second kind of data:

- **Direction**, through `ui_chg_colour()`: green and red on a percentage change and its ▲▼ mark,
  ink at zero and ink on the STALE and OFFLINE sheets.
- **Identity**, through `ui_series_t`: which series a bar or a segment belongs to. The same series
  takes the same treatment in the plot and in its legend swatch, or the reader is counting positions.

Type is black. Rules are black. A chart's axis is black. A headline is black. What changed is that a
graphic carrying three quantities may now say so in three treatments, instead of making the reader
map legend order onto bar order — which is what the second pass shipped and what the owner was
looking at when they asked the question.

### An arithmetic mistake worth recording

The first version of this section carried a contrast table computed from linear luma rather than
gamma-corrected relative luminance. Every figure was wrong — black read 4.50 : 1 instead of 9.18,
yellow-on-black 4.09 instead of 7.90 — and the table had already been written into `CLAUDE.md`,
two headers and five agent briefs before it was checked.

The conclusions survived, which is luck and not a method: the *ordering* of a linear-luma table
happens to match, so "yellow is unusable on paper" held. What did not survive was the design built
on it. The wrong numbers suggested five roughly even steps and a rule of "spread the series along
the ladder"; the right numbers show two clusters and a cliff, under which that rule certifies pairs
like screen-beside-yellow at 1.22 : 1 that a reader sees as one series.

The fix is why `tools/contrast.py` exists. The numbers live in a script that prints the full pair
matrix and names the pairs under 2 : 1, and the policy points at the script rather than quoting it —
the same discipline `sim --measure` already enforces for type advances, and for the same reason:
three different values for `body_16` were in circulation at once in the previous pass because every
site typed its own.

## §10 Deliberately not done

- **The page is not Korean.** No face carries Hangul, and adding it means ~2,780 syllables across
  six sizes — over a megabyte of flash — plus new line-breaking and a new length budget, and the
  blackletter masthead has no Hangul at all. The Korean brokerage page that motivated the dossier
  was used as an information architecture, and the paper stays in English.
- **The lead does not jump to A2.** A jump line is the most newspaper-like thing this page could
  have, and it was rejected for a good reason: the panel hangs on a wall and nobody can turn it.
  A1 has to be complete on its own.
- **Where the producer runs is still open.** The board is agnostic — `news_model.h` is the seam and
  nothing else reads the payload — so the on-device / cloud / host question can be decided without
  touching any of this. Running a Claude agent on the ESP32-S3 is feasible and has precedent
  ([MimiClaw](https://github.com/memovai/mimiclaw),
  [PycoClaw](https://www.cnx-software.com/2026/03/18/pycoclaw-a-micropython-based-openclaw-implementation-for-esp32-and-other-microcontrollers/)),
  and the Messages API's server-side web search means the board would never crawl anything itself.
  What argues against it for this project: the halftoning in `make_tile.py` cannot run on-device, so
  photographs would be lost; the fundamentals need a cache with a long TTL and a diff, which wants a
  filesystem; and a wall-mounted panel is a poor place to debug a bad filing. Moving today's
  headless `claude --print` onto a cloud schedule costs no new code.
