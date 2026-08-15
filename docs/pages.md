# The two pages

1200 × 1600, portrait, six inks, no greys, and no partial refresh. The sheet is a newspaper front
page — white paper, black type, edge to edge — and all of it is repainted at once, because Spectra 6
has no partial waveform: a refresh is twenty-five seconds of flashing whether one figure moved or
the whole page did. That is why `news_hash()` fingerprints everything that reaches the glass and the
poller compares before it wakes the UI.

**Every edition is about one listed company.** `KEY0` toggles the two sheets: **A1**, the front page,
and **A2**, which carries the statements and the comparison A1 has no room for. There is no carousel
and no third page.

## What is fixed and what is composed

The eight fixed vertical bands are gone. They were a table of y values in `ui_internal.h` and every
page was a transcription of it, which is why every edition came out the same shape no matter what
arrived. A broadsheet answers a different day with a different make-up.

So the sheet is now two things:

- **The furniture** — the masthead, the dateline and the tape. Fixed y values, in `ui_internal.h`,
  drawn once by `ui_news.c` for both sheets. On a real front page these never move, and neither do
  they here.
- **The well** — everything from the tape's rule to the bottom margin. Handed to `ui_compose()`
  (`components/news_core/include/ui_compose.h`), which decides the day's make-up from what arrived.

Both pages are full-bleed panes created *before* the furniture, so the furniture prints over them. A
page that drew its own masthead would not replace the real one; it would set a second nameplate at a
slightly different width across the first, and a smear like that reads as a fault in the panel rather
than as a layout mistake.

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

Six is not arbitrary. It is what nearly every well-designed broadsheet uses, and it is the number
that makes the composition work: six divides into a one-column standing rail and a five-column body,
and five divides into 2+3, 3+2, 2+1+2 and 5 — which are exactly the band shapes a front page wants.

**Every span and every origin is even, and that is a requirement rather than an aesthetic.** A photo
tile arrives packed two pixels to a byte in the framebuffer's own nibble order, so a slot of odd
width — or one starting at an odd x — cannot be blitted as a per-row `memcpy` and would need a
nibble-shifting slow path on the device for no reason at all. An even column and an even gutter make
every number in both tables above even, and the blit stays a copy. `ui_internal.h` holds it with a
`_Static_assert` on `UI_COL_W`, `UI_GUTTER`, `UI_MARGIN` and the well, and `ui_compose_check()`
carries the same rule forward to every rectangle the compositor produces — so an edit fails the build
or the check rather than three pixels into the right margin on the glass.

24 px is 0.16 in at this panel's 150.4 dpi: a normal newspaper gutter, and wide enough to carry a
hairline down its centre without crowding either column. That hairline sits 11 px in and 12 px out —
a 24 px gutter has no single centre pixel, and `UI_GUTTER_RULE_DX` truncates rather than pretending
it does. Inside a module the leg gutter is narrower, 20 px: two legs of one story are more closely
related to each other than two stories are, and setting them at the page gutter makes one story read
as two.

Rules come in exactly three weights — hairline 1 px, rule 2 px, heavy 3 px — all black, all square,
no radii anywhere. A fourth weight is how a page starts having a hierarchy that the eye reads as a
mistake.

### Measured metrics

**Do not transcribe this table. Print it.**

```console
$ sim/build/sim --measure
face          ascii   prose   line_height   1col   2col   3col   4col  (characters, prose)
masthead_112  61.84   42.76          113       3      8     13     17
display_56    30.93   25.14           65       6     14     22     29
display_36    19.58   16.11           41      10     22     34     46
deck_24       12.81   10.48           27      16     34     53     71
body_20       11.28    9.80           22      17     37     56     76
body_16        9.17    8.02           18      21     45     69     93
label_14       7.85    6.50           18      26     56     85    115
```

Every number comes out of the committed font files: the line height is each face's own
`.line_height`, and the two advances are its `adv_w` table averaged two different ways. The
characters-per-column figures are computed against `UI_COL(n)`, the same macro the pages lay out
with, so they cannot drift from the grid.

**There are two averages because they answer two questions**, and not saying which is meant is how
three different figures for `body_20` ended up in circulation at once:

- **ascii** — the mean over printable ASCII 32..126. A property of the *face*, weighted by nothing,
  where every `W` and every `@` counts as much as an `e`.
- **prose** — the mean over a fixed paragraph of English. About 11% narrower, because English is
  mostly lower case. **The character counts are prose**, because a characters-per-column table is
  only ever about prose. A Title Case headline sets a little wider.

The prose sample is fixed in `sim/main_sim.c` rather than taken from the payload. Measured over the
demo snapshot's own body it would move the moment somebody rewrote the mock, and this table would go
stale with nobody able to see why — so the sample is four sentences of ordinary newspaper English at
ordinary letter frequencies, and it carries a comment saying not to improve it. Changing it changes
every figure derived from it, and the only thing worse than one undocumented basis is two.

An ordinary `./sim.sh` run prints a one-line `measure:` tripwire for the two body faces, so a
regenerated font that moves this table shows up in the normal test output rather than only when
somebody thinks to ask. `--measure` is the query; the one-liner is the regression.

**What the table settles is the bottom of the range.** Typography's working range is 45 to 75
characters and its optimum is 66; newspapers legitimately set at the narrow end. A single 170 px
column is 21 characters of `body_16` — about three words a line — and no amount of copyfitting
rescues that. Two columns is 45, which is the working range's bottom exactly. So a module that sets
prose needs **two** columns, which is what `ui_mod_t::min_cols` carries, and one column is for
figures.

That conclusion does not depend on which average you take, which is worth stating because so many
have been in circulation. One column is 21 characters at the prose advance and 18 at the ASCII one;
under every figure anyone has measured it is about three words, and `min_cols` is not resting on a
number somebody got wrong. Only the second decimal place of the table was ever in question.

That constraint turns out to be the design. The Wall Street Journal's standing rail is one column of
prose; ours cannot be, so it is one column of **numbers** instead, and the company's valuation,
profitability, balance sheet and consensus go exactly where What's News goes. The vertical spine a
front page needs and the dossier this edition owes its reader are the same object.

Because the line heights are exact and `ui_lab_box()` removes the theme's line spacing, a box of
*n* line heights buys exactly *n* lines. That arithmetic is a multiplication, not a multiplication
plus a term nobody remembers to include.

## The furniture

| strip / rule | y | h | ends | contents |
|---|--:|--:|--:|---|
| masthead | 40 | 112 | 152 | `S_MASTHEAD` on A1; a two-line running head on A2 |
| heavy rule | 158 | 3 | 161 | |
| dateline | 165 | 20 | 185 | the date, the desk, and the subject **or** the state chip |
| hairline | 191 | 1 | 192 | |
| tape | 198 | 20 | 218 | the session, the indices, the as-of line |
| heavy rule | 224 | 3 | 227 | |
| **the well** | **232** | **1338** | **1570** | **composed** |

The well runs to the bottom margin exactly, and that is asserted rather than merely true:
`_Static_assert(UI_WELL_B == UI_CONTENT_B)`. There is nothing under it to leave room for.

The nameplate starts at 40 rather than on the 30 px margin. A broadsheet nameplate has air over it,
and one sitting exactly on the margin reads as cropped by the frame rather than printed on the sheet.
The ten pixels come off the well.

Three strips came off in the edits that made room for the well, and all three removals are worth
recording because the obvious instinct is to put them back.

**There used to be a strip above the masthead** carrying an edition slug, a state badge and the date.
No broadsheet has one — the New York Times and the Wall Street Journal both start at the nameplate
and put the date in a ruled line directly beneath it — and it cost 34 px of a page whose owner wanted
the space spent on the company.

**The tape lost 62 px.** It used to be an 82 px band setting five index levels at 36 px, which is the
single loudest thing a page can do and the reason the sheet read as a quote screen rather than as a
newspaper. The Wall Street Journal prints the same information as one line of small caps under its
nameplate, set *smaller* than its body text, because on a front page the tape is furniture and not
the story. This is that line: cells laid left to right with a fixed 18 px separator and whatever room
each string needs, rather than on an equal division — an index called `PHLX SEMIS` and one called
`VIX` do not want the same slot, and a ragged right edge on one line of furniture is what a real tape
looks like.

**The folio is gone**, and it is the one strip whose removal needs an argument, because every
newspaper has one and taking it off looks like an omission.

A folio answers two questions: which page of what am I holding, and where do I turn next. This paper
is a single sheet in a frame on a wall. There is no next page, nothing to collate it with, and no
second copy to tell it apart from — so both answers are to questions nobody standing in front of it
can ask. What a reader would actually want from it is on the dateline row already: the masthead names
the paper, and the sector and the symbol say what this sheet is about.

It carried no clock even before it went, and that reasoning survives it: `as_of` is on the tape and
says when the numbers are from, which is the honest statement. A second timestamp at the foot saying
when the sheet last *repainted* is a machine's concern printed on a reader's page, and on a panel that
takes twenty-five seconds to repaint it reads as a demand to keep it fed. A newspaper carries a date,
not a clock.

Together the three gave the well 96 px and then the last 30, and the well is where the edition is.

The dateline row prints three things: the date on the left, the desk in the middle, and on the right
either the company the edition is about or — when something is wrong — the **state chip**. Those two
are alternatives rather than neighbours, because the row has three slots and four things want the
third. The symbol is the one that gives way: the whole sheet is about that company and says so in a
dozen places, where the chip has nowhere else on the page to be.

There is **one chip slot** and it is ranked: `OFFLINE` beats `STALE` beats `DEMO`. That order is not
the obvious one — a board that has been given a URL keeps showing the demo snapshot until its first
successful fetch, so ranking `DEMO` first would badge a configured board whose server is unreachable
as `DEMO`: true, and useless, instead of `OFFLINE`, which is the thing the reader can act on. Three
indicators competing for one slot would otherwise overlap or need a layout pass, and a glance from
across a room only carries the most important thing that is wrong anyway.

It is a **filled black rectangle with the word reversed out of it** in tracked `label_14`, sized to
the word — the only inverted region on either sheet. That is deliberate, and it is a consequence of
the strip above the masthead being deleted: an un-chipped word would now sit in a ruled line of other
14 px tracked caps, and nobody picks one of those out from three metres.

**The chip is not the whole state signal.** `ui_chg_colour()` prints every change figure on both
sheets in ink when the snapshot is stale or the board is offline, so what a reader actually notices
is twenty-odd coloured figures going black at once. The chip says which of the three it is; the page
going monochrome is what makes them look.

## The make-up desk

`ui_compose()` is pure geometry. Nothing in it knows what a headline is: a module reports how tall it
wants to be at a given width through a `measure` callback that the *page* supplies, so the compositor
compiles and is host-tested with no LVGL at all. Every decision about **where** ink goes is in
`ui_compose.c`; every decision about **what** ink is drawn is in the page.

It does not know about the furniture either. The well arrives as data — `x`, `y`, `w`, `h` on
`ui_compose_env_t`, filled in by the caller — so the numbers in the table above are the caller's
business and the compositor has no opinion about what sits over or under its rectangle.

### Guillotine cuts, which is the whole safety argument

A free compositor can produce an ugly page. This one cannot, because it can only make **guillotine**
cuts: every cut runs edge to edge across the rectangle it divides. Take the Wall Street Journal's
front page apart and that is what is already there — a vertical cut separating the standing rail from
the body, horizontal cuts dividing the body into bands, vertical cuts dividing each band into
stories. The photo-and-lead package and the column beside it end on exactly the same line, because
they are the two halves of one cut.

Restricting the compositor to those cuts buys three properties for free, rather than as tests that
might not have been written:

- every module is a rectangle, so there are no doglegs and no L-shaped wraps around a photograph;
- the modules tile the well exactly — no overlap, no gap, no white hole at the foot of the page;
- a module's neighbours are known, so the rules that are *about* neighbours have somewhere to be
  enforced.

The variety comes from the cut **tree**, which is chosen from what arrived. It does not come from
relaxing the cuts. The tree is deliberately shallow — three levels cover every arrangement the
reference pages actually use, and a deeper tree buys arrangements no one wants:

```
well
 |
 +-- H-cut under the BANNER, when one module asked for it
 |
 +-- H-cut at the rail's foot, ONLY when the rail is shorter than the well
 |
 +-- upper region
 |     +-- V-cut: [ rail, 1 column ] [ body, the rest ]
 |           +-- body: H-cuts into bands
 |                 +-- band: V-cuts into 1..3 modules
 |
 +-- lower region (full width)
       +-- H-cuts into bands, each V-cut into modules
```

**The banner** is a module alone on a full-measure band across the top of the well, with the rail
beginning below it rather than beside it. It buys the one shape the rail otherwise made impossible: a
photograph and a headline across the whole measure with the story running down under them in four
narrow legs — what the front page of a broadsheet looks like when the day has one story worth the
whole page. With the rail pinned left for the full height, every package on the sheet was five
columns wide and none could be deep, so the page could only ever come out in horizontal slices.

It costs none of the safety above, because it is still a guillotine cut and still edge to edge. A
module only *asks*; it is sized between its `h_min` and its `h_pref` like any other band, and a
banner that cannot be given its minimum is simply not one, so asking can never be what drops a
module.

A band boundary reserves `UI_BAND_GAP` — 14 px, with the 2 px rule 6 px into it — and never after the
last band, so a page's modules and its boundaries add up to the well exactly.

### What a module tells the compositor

| field | meaning |
|---|---|
| `kind` | which of the nine module kinds it is |
| `src` | its index into the payload array for that kind |
| `rank` | lower is more important; also the order modules are packed, and the end the compositor drops from |
| `min_cols` | 1 only for the dossier and a chart — everything that sets prose needs 2 |
| `max_cols` | 0 for no ceiling |
| `weight` | relative appetite for the spare columns |
| `elastic` | true if its body absorbs slack, false if it sits at a fixed height |

`measure` answers two different questions and both matter. `h_min` is the height below which the
module should not be drawn at all — its furniture plus one line of whatever it is made of — and the
compositor drops the module rather than go under it. `h_pref` is the height at which it is finished:
the whole body set, the whole table printed. Between the two the module stretches or squeezes, and
for an elastic module that stretching is where the slack in the page goes. `weight` is how a story
with 700 bytes of body ends up four columns wide and one with 200 ends up two.

**`kind` is a tag the compositor never branches on — with exactly one exception.** Every kind is
geometry-identical to it; the differences are entirely in what the page draws inside the rectangle it
was given. The exception is `UI_MOD_DOSSIER`: the lowest-ranked one in the list becomes the standing
rail, full height on the left at its `min_cols`. A second dossier in the same list is packed as an
ordinary module.

That matters for reading any description of these pages. "Does the dossier rail appear on this
sheet" is not a layout setting anywhere — it is decided entirely by whether that sheet's module list
contains a `UI_MOD_DOSSIER`.

### Two rules that are about neighbours

**Tombstoning.** Two equal headlines abutting across a gutter read as one line: the eye runs straight
across. Every style book forbids it and the fix is not white space, it is contrast — so
`ui_head_weight()` demotes the second of two neighbours a step. Weight 0 is the lead's face and
larger numbers are smaller faces; the page maps them onto `UI_MOD_HEAD_LH_0..3`.

**A vertical rule between neighbours**, down the gutter centre, for the same reason the guillotine
exists: the compositor is the only thing that knows who is next to whom.

### `ui_compose()` is total

It always returns a valid tiling. Given more copy than the sheet can hold it drops modules from the
back until the rest fit; given less it stretches the elastic ones until the sheet is full; given a
single module it gives it the whole well. It returns 0 only when handed nothing. **There is no
failure path for a caller to get wrong**, because the failure a reader would actually see — a page
with a white hole in it — is the one thing this must never produce.

A module that did not fit comes back with `placed` false and must not be drawn. That is not an error;
it is the day's page being one item shorter than the day's file.

### Determinism is not optional

`news_hash()` promises that two snapshots with the same fingerprint produce the same pixels, and the
device skips a twenty-five-second refresh on the strength of it. So `ui_compose()` is a pure function
of its inputs: no clock, no random, no iteration over a hash table. Same modules in, same rectangles
out, on both x86 and Xtensa.

That is also why `news_hash()` has to cover everything the **compositor** reads, which is a strictly
wider set than what any one page draws — the counts, the ranks, the presence of a photo. Two payloads
that differ only in a field the day's layout happened not to use still lay out differently tomorrow,
and a hash that missed it would pin the wrong page.

## The nine modules

| kind | what it draws | from |
|---|---|---|
| `UI_MOD_LEAD` | kicker, headline, deck, byline, art, legs | `stories[0]` |
| `UI_MOD_STORY` | kicker, headline, byline, one or two legs | `stories[n]` |
| `UI_MOD_DOSSIER` | the figure rail: heroes, small figures, standing heads | `figures[]` |
| `UI_MOD_CHART` | a chart with its caps head and one line of note | `charts[n]` |
| `UI_MOD_BRIEFS` | the dated one-liners | `briefs[]` |
| `UI_MOD_PEERS` | the industry comparison | `peers[]` |
| `UI_MOD_TABLE` | a statement, printed or drawn | `tables[n]` |
| `UI_MOD_THUMBS` | the small pictures with their captions | `thumbs[]` |
| `UI_MOD_QUOTE` | one sentence pulled out and set large | a story's body |

A module lays itself out from wherever it landed, on offsets rather than absolute rows:
`UI_MOD_KICKER_H`, `UI_MOD_HEAD_LH_0..3`, `UI_MOD_DECK_LH`, `UI_MOD_BYLINE_H`, `UI_MOD_BODY_LH`. Every
one of those is a **measured** line height plus its leading, not a round number — a slot sized to a
round number either clips a descender or leaves a gap that reads as a mistake in a stack of five.

A story ends with a solid 8 px square, set **inline** on the last line of the last leg. The room comes
off the measure of that final line, not off the depth of the column, because a mark on a line of its
own is a line of white the reader reads as the column having stopped early.

**The dossier and a chart are the only two modules that may take a single column**, and the
arithmetic above is why: they are the two that set no prose. Of the two, only the dossier becomes the
standing rail.

A figure is a label and a value. Consecutive figures sharing a `group` print one standing head
between them; the producer orders the list and the device does not sort it.

**The rail has two tiers, and that is what stops it being a list.** Twenty-eight equal lines is a
spreadsheet with a rule down one side: nothing on it is louder than anything else, so the eye has
nowhere to land and reads none of it. The producer marks the two or three figures that carry the
day's argument with `emph`, and the device gives those the prominence — a **hero** — while the rest
stay small. It is the same editorial judgement `rank` already makes about stories, applied to
numbers, and it falls on the same side of the same line: the producer says what matters, the device
decides what that looks like.

**`bar` turns a hero into a graphic instead of a bigger number** — where the value sits inside a
range the producer chose, normalised 0..1000, or -1 for none. A price against its 52-week range and a
margin against its five-year band are the two it was built for. The producer normalises it for
exactly the reason it normalises `spark`: the device has the box but not the units, and a rail that
guessed them would draw a confident wrong bar. A hero without a bar is an ordinary hero, not a broken
one.

**A chart lives inside a module, never as a band of its own.** The reference page for this design
carries exactly one chart on its front, one column wide, inside a story about the index it plots. A
page of charts is a terminal; a page of prose with one chart in it is a newspaper. The plot is what
remains of the module after its caps head and its note, and it is never given less than
`UI_CHART_MIN_PLOT`.

**A table is printed or drawn, and the producer decides which.** A quarterly statement is a grid of
figures and reads as one; six quarters of revenue, profit and margin printed as eighteen cells is
something the reader has to assemble in their head, where the same eighteen numbers as bars with a
line over them is something they see. So `render` is the producer saying which of its tables is an
**argument** and which is a **record**.

| `render` | what it is |
|---|---|
| `TABLE_PRINT` | the record, and the default |
| `TABLE_STACK` | each row a component of a whole, the columns drawn as stacked bars — a revenue mix, where the point is the proportions and not the total |
| `TABLE_BARS_LINE` | every row but the last as bars, the last as a percentage line over them — the revenue-profit-margin figure every annual report opens with |

**A printed table is ruled horizontally and not boxed.** A grid of boxes on this panel is a lot of
black, and a broadsheet's tables are ruled with hairlines under the rows. A drawn table is a
different object and obeys the chart rules instead — hard pixels, no `lv_draw_line()`, and the colour
policy exactly as everywhere else.

**A drawn table needs numbers, and the cells are text on purpose.** `"(1,203)"`, `"10,584"` and
`"—"` are house decisions the device must not try to undo, so the producer sends both forms: the text
is what is printed and `n` is what is drawn. When `has_n` is false there is nothing to scale, and the
table **falls back to printing** rather than drawing an empty box — the same choice the parser makes
everywhere else, degrade to the thing that still works. Printing is never wrong; drawing with the
wrong geometry is.

## A1 and A2

Both sheets are composed and both wear the same furniture. What a page turn changes is exactly one
thing: the type in the masthead band. The band does not shrink to fit — the rules under it are the
skeleton both pages are printed on, and a masthead that took 40 px off itself would move every one of
them on one page and not the other.

What each sheet is *for* is settled, and it is the design spec's §1 rather than anything in the code:

- **A1** — why the price moved, whether the whole tape moved with it, what else happened to the
  company this week, and its numbers in a standing rail down the side. Up to nine modules: the
  dossier, the lead, three stories, a chart, the briefs, the peers, the thumbnails — and, on a day
  with no stories at all, a statement as well.
- **A2** — the same company's accounts: quarterly results, growth, the balance sheet, the consensus,
  and the industry comparison. Up to eight: the dossier, two tables, a pull quote, a chart, a story,
  the peers, the briefs.

A2 exists because a `news_table_t` is 1,240 bytes of printed cells, and a front page that spent a
third of its well on a six-column statement would be a report rather than a paper.

**Which of those survive, and where they land, is not a table anyone can write down in advance.** A
page file is a module list and nothing else — neither holds a coordinate. It builds the list from the
day's snapshot and hands it over; `ui_compose()` answers. Whether a sheet carries a standing rail is
the same kind of question: it follows entirely from whether that sheet's list contains a
`UI_MOD_DOSSIER`, not from a setting. That is the point of the edit that removed the bands, and it is
why this section names purposes rather than slots.

### A2's running head

Two lines and two sizes, which is what makes it a running head rather than a second nameplate: the
paper's name in `display_56` tracked caps, and the section — `MARKETS` — under it in tracked
`label_14`.

Three sizes were rendered before it settled, and the two that lost are instructive. At `display_36`
the flag leaves 80% of the strip bare and A2 reads as a weaker, unrelated publication. At
`display_56` across the full measure, `THE WASHINGTON POST · MARKETS` sets 1071 px of 1140 — edge to
edge in a heavy Didone — which reads as a second paper rather than as page two of this one. The name
alone sets 731 px in a 752 box, at half the nameplate's cap height, and those are the two ratios a
section flag actually has. The pair is on two lines because as one composed string it does not fit the
measure.

## Under-supply, and the quiet day

The compositor's totality means under-supply is not a special case with its own code path — the
elastic modules stretch and the page fills. What is worth stating is the two ends of it.

**A thin file** — one story, a short dossier, no picture — gives the surviving modules more columns
and more depth, and the rail's foot becomes a horizontal cut so the lower region can run full width.
The page is emptier of *items* and just as full of *ink*.

**No stories at all** is a legitimate front page and not an error state — but it is a *different*
page, not this one with the copy taken out. That distinction is `ui_compose.h`'s own conclusion about
what it cannot fix: three short modules handed the whole well have already made the mistake
upstream, and no distribution of the surplus rescues it.

So on a day with nothing written, A1 prints what it does have. The dossier is what the edition is
about as much as the stories are, and A1 also gains a module it never otherwise carries: **a
statement**. Accounts exist every day. It takes the *last* table so that A2 keeps the first and
gives up its second, and nothing is set twice — the same "the last one is the other page's" rule the
stories already follow, with the two page files agreeing on the number because they have to.

Handed one module, the compositor gives it the whole well — and **a lone dossier does not stay a
one-column rail**: a rail needs a body to stand beside, so with nothing beside it, it takes all six
columns. A page that ends up complete does so because `ui_compose()` is total, not because somebody
wrote a fallback for it, which is the difference between a quiet day and a special case that has to
be maintained.

A payload with no stories, no figures and no subject is a different thing, and the parser rejects it
before the compositor ever sees it — see [news-contract.md](news-contract.md).

A `NULL` snapshot is different again, and it is the only state that leaves paper: the furniture stays
and the well is empty. There is no "no data" line. An unconfigured board shows the demo snapshot and
never reaches this — it is the gap between power-on and the first payload, and a sheet that announces
itself as empty is worse than one that simply has not been printed on yet.

The demo snapshot itself is a **complete edition** about one company, not a placeholder. An
unconfigured board is a complete configuration, and that is why the demo payload is the one the
simulator judges as paper.

## Copyfit

Bodies are cut; headlines and decks are not.

`ui_fit_text()` (`ui_fit.c`, pure and host-tested) copies as much of a story as fits in *w* × *h* at
a given face and returns the number of source bytes consumed, so the next leg starts where the last
one stopped. It measures with `lv_text_get_size()`, which is the same measurement LVGL will use to
lay the label out — and that equality is the entire point: a string this function accepted cannot
then wrap onto a line that does not exist. The alternative is what LVGL does on its own, which is to
set one line too many at the bottom of a box and let it hang across the rule below.

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
them long rather than short, so the column always fills and the compositor has slack to spend.

The copy buffers are sized in bytes against slots measured in characters, at the model's own field
width, because a copy desk emits em dashes and accented names and a UTF-8 character is up to four
bytes. They are file statics rather than locals: a `news_t` is **24,328 bytes** — measured — which is
already too big for a task stack, and six kilobytes of copy on the same frame would be worse. That is
the same reason both snapshots on the device are static buffers.

## Fonts

Seven faces, all SIL Open Font License 1.1, chosen against the paper being imitated rather than by
taste: **UnifrakturMaguntia** for the blackletter masthead, **Playfair Display** for headlines (WP
sets its own in Postoni, a Didone), **Source Serif 4** for the deck and body, and **Libre
Franklin** — a revival of Franklin Gothic — for bylines, kickers, captions, tables and the tape.

| face | family | size | role |
|------|--------|-----:|------|
| `ui_font_masthead_112` | UnifrakturMaguntia | 112 | the paper's name |
| `ui_font_display_56`   | Playfair Display, wght 800 | 56 | the lead headline; A2's running head |
| `ui_font_display_36`   | Playfair Display, wght 700 | 36 | secondary headlines |
| `ui_font_deck_24`      | Source Serif 4 Italic, opsz 11 | 24 | the standfirst, and a third headline weight |
| `ui_font_body_20`      | Source Serif 4, opsz 10 | 20 | the wide leg, and the dossier's figures |
| `ui_font_body_16`      | Source Serif 4, opsz 8 | 16 | column body text |
| `ui_font_label_14`     | Libre Franklin, wght 600 | 14 | bylines, kickers, captions, tables, the tape |

118 KiB of flash for all seven, against an 8 MB app partition. There is no separate numeral face: the
tape's levels are set in Franklin and the dossier's figures in Source Serif, which is not a
compromise — lining figures are the point of both families, and a table set in the same face as the
headlines above it is what makes a front page look typeset rather than assembled.

Pages ask for a **role**, not a face: `UI_F_LEAD`, `UI_F_DECK`, `UI_F_BODY`. Every caps label on both
pages takes `letter_space 2`. Franklin's caps were cut to be spaced, and a kicker set solid reads as
one long word from the distance this panel is looked at — which is also why `ui_upper()` exists: the
tracking is cut for caps, and applied to lower case it takes a word apart, so a slot the network
wrote into is uppercased before it is tracked.

### Every face is 1 bpp, and that is a measurement

The panel has no grey. LVGL renders anti-aliased text as intermediate RGB565 and the flush callback
puts that through `wp_quantize565()`, which ordered-dithers to the six inks. For a photograph that is
correct and necessary. For text it is destructive: a 16 px serif stem is about 1.5 px wide, so half
of it is anti-aliasing, and dithering that half turns a solid stem into a dotted one. Rendered side
by side at 3×, 4 bpp body text has holes punched through `m`, `w` and every descender, and the
112 px masthead grows a ragged stipple along contours that 1 bpp keeps smooth.

At 1 bpp every text pixel is exactly `WP_RGB_BLACK` or `WP_RGB_WHITE`, and `wp_quantize()` maps both
to themselves under every dither offset — so text takes the quantizer's identity path and cannot pick
up a colour fringe.

### Optical sizes are calculated, not chosen

Source Serif 4 carries an `opsz` axis calibrated in points, and this panel's pixel pitch is known —
1600 × 1200 across a 13.3" diagonal is 150.4 dpi — so `opsz_for(px) = round(px · 72 / 150.4)`,
clamped to the axis's own 8…60 range, is arithmetic rather than a taste call. `ui_font_body_16` is
7.7 pt and instanced at opsz 8: sturdier stems and more open counters than the same family at
opsz 20, which is what survives a 1-bit render.

### Coverage, and the never-hand-edit rule

Headlines, decks, bylines and body text arrive over the network and cannot be subset, so every *text*
face carries ASCII, all of Latin-1 (Bogotá, Zürich, Müller are routine in a dateline) and the
typography in `S_DATA_PUNCT` — 216 or 217 glyphs each. The masthead face is the exception: it is
subset, but to the whole Latin alphabet plus `" .,'-&"` rather than to the letters `S_MASTHEAD`
happens to use, so pointing the board at a different paper is one line and not one line plus a font
regeneration.

All fixed user-visible strings belong in `ui_strings.h`. That is where `tools/gen_fonts.py` reads the
glyph lists from, and where the simulator's coverage check reads them from; a label added straight
into a page file is a tofu box on the glass.

**Never hand-edit `components/news_core/fonts/*.c`.**

```bash
python3 -m venv /tmp/fontenv && /tmp/fontenv/bin/pip install fonttools
/tmp/fontenv/bin/python tools/gen_fonts.py --download
tools/gen_fonts.py --dry-run      # report the glyph sets and stop
```

fontTools is needed because Google publishes three of the four families only as variable fonts, and
lv_font_conv's parser reads a variable font's *default* instance and nothing else — asking it for
Playfair Display Bold would silently produce Playfair Display Regular. Each face is instanced to a
fixed point on its axes first, and lv_font_conv only ever sees a static TTF. The generated `.c` files
are committed, so a normal build needs neither node nor Python.

## Colour

**White paper, black type, edge to edge.** Colour on this sheet is not decoration, it is data, and it
reaches the glass in exactly two places:

1. **Green and red on percentage changes and their up/down marks** — on the tape, in the dossier
   rail, in the peer table. Nowhere else: not on headlines, not on rules, not on a chart's axis.
2. **Photo tiles**, which arrive already screened by the server.

A change is green at zero, because a flat session is not a loss and a column where nought is a third
colour has three states where the eye wants two. The mark is always drawn as well as the colour: on a
panel whose red is a brick and whose green is a moss, a row that carries its direction in colour
*alone* differs from its neighbour by nothing a reader across the room, or a reader with any
red/green deficiency, can resolve.

**A figure the board cannot vouch for is not data.** When the snapshot is stale or the board is
offline, every change figure and every mark on both sheets prints in ink instead. The alternative is a
page of prices in the colour reserved for live movement, asserting in the loudest way the sheet has
that it is current, with one word at the top saying otherwise. Every call site that decides a change's
colour goes through `ui_chg_colour()` rather than through `bp < 0 ? UI_DOWN : UI_UP`, so that rule is
enforced in one place and grepping for the two constants is the whole of the audit.

Blue and yellow reach the glass only inside a graphic, and only as **series identity** — which of
several quantities a bar or a segment is. They were banned outright until the third pass, on two
grounds: that the panel renders those two inks least faithfully of the six, and that a page spending
colour on ornament is a page where the colours that carry meaning stop being seen. The second ground
still holds and is why they are confined to graphics — a blue rule or a yellow kicker is exactly the
ornament it warns about. The first turned out to be half right and had never been measured.

It was measured for the third pass (`python3 tools/contrast.py`). Blue is 5.56:1 against the paper —
better than green, which has been on the sheet since the beginning. **Yellow is 1.16:1**, the same
value as the paper, so a yellow bar reads as the outline of a bar; against black it is 7.90:1, the
best pair the panel has after black on paper. Hence the rule that yellow is legal only enclosed by a
black keyline, drawn by `ui_series_fill()` so no caller can forget it.

The deeper finding is that **the six inks are two bands with nothing between them** — black, red,
blue and green all between 0.016 and 0.077 relative luminance, the 1-in-3 screen, yellow and paper
between 0.374 and 0.554, every within-band pair under 2:1 and every cross-band pair over 3.3:1. A
panel advertised as six colours gives a chart one clean cut of value; a third series has to be bought
in hue or in texture. That is what `ui_series_at()` is for, and why it is not an index cast.

The rule is enforceable rather than aspirational. Every colour the UI can draw is an exact palette
entry, so it takes `wp_quantize()`'s identity path and comes out flat; a colour anywhere between two
inks dithers, and a dithered hairline is a dashed one. And the simulator checks the framebuffer
directly: no red or green outside the boxes the composition says are allowed it, no blue or yellow
outside a graphic, and — the one that cannot be checked by reading the drawing code — **no yellow
pixel that can reach paper without crossing black**. That last assertion is why the keyline is safe
rather than merely intended: a keyline one pixel thin on one side is a drawing that looks right in
source and fails on the glass, and the only place that shows up is in the pixels.

The same argument is why the charts are drawn with an integer Bresenham run and not with
`lv_draw_line()`. LVGL antialiases a diagonal, this panel has nothing between ink and paper for the
blend to land on, and `wp_quantize565()` resolves the mid-greys a black stroke on white paper
produces to **green** — so a chart drawn the easy way is a black chart fringed with green speckle, in
a module the colour policy does not allow colour in, and the reader sees it as dirt on the paper.

### Photographs are dithered across all six inks — and the first answer was wrong

`tools/make_tile.py` diffuses a photograph across the full palette by default. `--halftone` opts back
into black ink on white paper.

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

## Where the layout is asserted

The simulator used to check that the lead rule landed on row 1108. It cannot any more, and the thing
that replaced it is stronger: **not "the page is the shape we drew last time" but "the page is a legal
page"**, which holds for every payload rather than for the three the test happens to build.

`ui_compose_check()` takes the rectangles the compositor produced and proves the invariants it claims:
inside the well, positive, even x and even width, no two overlapping, covering the well with no gap.
`test_compose` calls it over **6,000** generated module sets on the sheet's own grid and 3,000 more on
grids that are not the sheet's; the simulator calls it on every pass, reading the day's make-up back
through `ui_page_layout()`.

Everything that did not move is still asserted the old way. `sim/sim.sh` renders both pages at the
real 1200 × 1600 through the real quantizer into a real 4 bpp framebuffer and checks the furniture on
its exact rows, the margin, every widget inside its slot, no two labels sharing paper, the masthead
inside 1140, glyph coverage for every string, and the colour policy above. It exits non-zero on any
failure. See [simulator.md](simulator.md), and look at `sim/shots/*.png` after any UI change.
