# The simulator

```bash
cd sim && ./sim.sh
```

Typesets both pages at the real 1200 × 1600, in the panel's six inks, and **asserts on the
framebuffer that would reach the controller**. It exits non-zero when any rule, band, slot, glyph or
colour check fails, so this is a test that happens to leave screenshots behind — and on a panel
where a refresh is twenty-five seconds of flashing, it is the only place most of these failures are
cheap to find.

```bash
NEWS_URL=http://localhost:8123/news.json ./sim.sh   # against the reference server
```

With `NEWS_URL` set it runs the device's own fetch-and-parse path — the same `news_service_fetch()`,
the same `news_parse()`, the same bytes — and fetches tiles from `<that URL's directory>/tiles/`
exactly as the device does. A change to the wire contract is caught here rather than on the glass.

## It is not a preview

The two things that make it evidence rather than an approximation:

**It renders through the real quantizer into a real framebuffer.** LVGL draws RGB565 into a draw
buffer, exactly as it does on the device. `flush_cb` pushes every flushed pixel through the same
`wp_quantize565()` the firmware's flush callback calls, and lands the result in a real 960,000-byte
`epd6` framebuffer via `epd6_fb_put()`. Every check reads *that* — never LVGL's buffer — so a colour
decision comes out the same way here as on the glass because it was not made twice. A simulator that
thresholded pixels itself would agree with itself and with nothing else.

That distinction did not exist on the monochrome board this forked from, where the simulator's
threshold and the panel's were both "is this pixel dark", and any two implementations of that agree.
Six inks do not work that way: which ink a mid grey lands on depends on the ordered-dither offset at
that exact (x, y). Which is also why `flush_cb` passes **sheet** coordinates and not offsets inside
the flushed area — the same trap `main.cpp` names, with the same symptom if it is got wrong, the
Bayer pattern seaming at every strip boundary.

**It compiles the real page files.** `sim/CMakeLists.txt` builds `components/news_core/` verbatim:
the same `ui_news.c`, `ui_page_front.c`, `ui_page_markets.c`, `ui_common.c`, `ui_fit.c`,
`ui_chart.c`, `ui_tile.c`, `wp_palette.c`, the same parser and the same seven generated fonts. The
only file that differs between the simulator and the firmware is the HTTP port —
`http_port_curl.c` instead of `http_port_esp.c`.

It also puts `components/news_core/` itself on the include path, not just `include/`, so it can
include `ui_internal.h`. That header is private to the UI files by design; the simulator is the
deliberate exception, because it asserts on the grid that header defines and a second copy of the
grid is exactly how such an assertion starts agreeing with itself instead of with the panel. The
first thing `main_sim.c` does is hold the two headers against each other:

```c
_Static_assert(UI_W == EPD6_W && UI_H == EPD6_H,
               "the page's sheet and the panel's framebuffer must be the same size");
```

`ui_internal.h` and `epd6_transpose.h` are not derived from each other — one is the page's geometry,
the other the controller's — so that line is where they are made to be describing one piece of
glass, before a single assertion is written against either.

Each pass clears the framebuffer to white before it renders, which is what the panel is after a
refresh, and also what stops a pass that rendered nothing from being asserted against the *previous*
pass's pixels and quietly passing. Then the whole screen is invalidated, because "dirty" after
`ui_news_set_data()` is only whatever the setters happened to touch.

## The passes

Six page renders from three payloads, then four states no ordinary payload reaches. Each is a shape
the tier engine resolves differently, and none of them may leave a hole.

| shot | payload | what it is for |
|------|---------|----------------|
| `01_a1_full`, `02_a2_full` | the demo snapshot, or a live fetch | four stories, five indices, sixteen quotations — the widest the pages get, and the board's out-of-box experience, so it is the one that has to look like a newspaper. Its lead carries **both** a photograph and a chart, which is the case the layout must resolve rather than assume away. |
| `03_a1_sparse`, `04_a2_sparse` | one story, two indices, three quotations, a line chart, no photo | the one-story promotion: the lead's chart moves out of the well into band 6 and the portfolio rail widens into the other four columns. A1 also has to place a flat quotation (`KO`, 0.00%) and a two-cell ribbon. |
| `05_a1_quiet`, `06_a2_quiet` | the demo snapshot with its stories removed | a quiet day is not a broken feed. The lead well becomes the index ribbon at full size, the rail takes the whole measure, and every band still has to fill. |
| `07_a1_stale`, `08_a1_offline` | the full payload, with the status flipped | the two badges. Checked against a page that otherwise rendered, so a badge that failed to draw shows up against something known good. |
| `09_setup` | the provisioning overlay | on e-Paper a hidden page is still physically on the glass until something covers it, so what is asserted is that the sheet underneath is **gone**. |
| `10_a1_nodata` | `ui_news_set_data(NULL)` | the gap between power-on and the first payload. A blank sheet is the right answer, so the band table is deliberately not applied — what has to be true is only that the paper is still the paper and that nothing escaped the margin while the setters were writing empty strings. |

The demo snapshot names a picture — `photo.id "nvda_hq"` — that no server is going to be asked for,
so `UI_TILE_LOCAL_DIR` points the tile cache at `sim/tiles/`. A tile sitting on the disk is the
honest stand-in for a fetch that has already happened: it goes through the same byte-count check,
the same palette proof and the same blit as one off the wire. Without it, the demo page would be the
one page that could never show a photograph, and the blit would be the one part of the front page
the simulator does not test.

## What it checks

### The rules land on their exact rows

Every rule in `UI_RULE_TABLE` — the kicker's hairline, the masthead's heavy rule, the dateline
hairline, the ribbon's heavy rule, the lead rule, the secondary rule and the one the folio hangs
from — must be black on **every** one of its rows across the whole 1140 px measure, with no
tolerance at all. A rule is a filled rectangle in an exact palette colour, so it cannot dither and
cannot be partly covered by anything: one pixel of paper in the middle of a 1140 px hairline means a
widget was drawn over it in white, and that is a layout fault however small it looks. The failure
prints the coordinate and the ink that was there instead, then the count of the rest of that row.

A2 gets two of the seven, the kicker's and the folio's, because those two frame the *sheet* rather
than either page. The five between them are A1's alone.

### The margin, with one pixel of slack

Nothing may cross the 30 px margin on any of the four sides. The margin is what makes the sheet read
as a page in a frame rather than as a screen with content pushed to its edges, and it is the one
measurement a reader notices being wrong without being able to say why.

Left and right get **one pixel** of slack, and the reason is specific: a glyph's ink is allowed to
start left of its origin, and several of ours do. In `ui_font_display_56`, `A J V W j v y` all carry
`ofs_x = -1` — a Didone's pointed foot and its flat apex serif overhang, which is how the family is
drawn and why a headline set flush left *optically* aligns with the body text beneath it. Pulling
the label in by a pixel to satisfy a bounding box would make the largest text on the sheet visibly
inset against everything below it. One column of ink is therefore permitted, and a real overrun — a
mispositioned widget, a rule drawn from the wrong origin, a label wider than its slot — is always
two pixels or more.

Top and bottom get no slack. There is no vertical equivalent of a side bearing at a margin.

### Every band contains ink

Each entry of `UI_BAND_TABLE` is scanned for any ink at all. A band that rendered nothing is a
failure and not an empty state: the tier engine's whole job is to promote content up a tier rather
than leave paper, so 372 px of blank in the middle of the sheet means the promotion did not happen.

A2's bands are private to `ui_page_markets.c`, so the table cannot be pointed at them, and copying
them into the simulator is precisely the second grid `ui_internal.h` warns against. What is
checkable without knowing them is the coarse version of the same property: a full payload must leave
no 100 px strip of the content area empty, anywhere down the sheet.

### Widgets inside their slots

The pixel checks catch ink in the wrong place; this catches a **widget** in the wrong place, which
is the same bug one step earlier and with a name attached. LVGL's tree is walked and every visible
object's box held against the sheet: inside the margins, and strictly between two consecutive rules.

"Between two rules" is the whole containment test, and it is exact rather than approximate — the
seven rules divide the sheet into eight gaps, each gap holds one band plus its slack, and a widget
that ends up in the wrong band has to cross a rule to get there. Stating it that way also lets the
masthead be what it is, 113 px of face in a 112 px band, without needing an exception: 176 is still
short of 186. The rule objects themselves are recognised by occupying exactly their own rows, and
the three full-bleed panes — the screen, the two page panes, the overlay — are skipped, because they
cover the margin on purpose so that a page's coordinates can be the panel's.

Only A1's widgets are held against it. A2's bands are its own and cross A1's rule rows by design, so
pointing this at them would be asserting one page's grid on another.

### No two labels on one piece of paper

The check that catches type printed over type, which no pixel predicate can: both copies are black,
both are inside their band, and the result is a smear that reads as a rendering fault rather than as
a layout one. It is worth its own assertion because the way it happens is structural — two files
each believing they own a band, which on a sheet where the furniture is drawn by one file and the
news by another is the standing risk. It runs on both pages.

Labels only, and only labels with text in them. Panes overlap by design — a container holds its
children, the ribbon's marks pane spans the change row, a badge chip sits under its own inverted
word — and an empty label is a slot the payload did not fill, which is the normal case and not a
collision. The failure prints both strings and both boxes.

### The masthead's measured width

The masthead band is scanned column by column for its leftmost and rightmost inked pixel. It fails
if that width exceeds the 1140 px measure, or if the two side gaps differ by more than 4 px — which
is centring stated as "the two margins agree", the same thing said in a way that also says which way
it drifted.

This is the one measurement in the whole design that can only fail at full size. `S_MASTHEAD` sets
1012 px solid and is tracked out to about 1102 of the 1140 available; a face regenerated a fraction
wider, or a longer paper name, and the largest text on the sheet either ellipsizes or stops being
centred. Both are visible from across a room and neither is visible in any host test.

### Glyph coverage

Not by looking in the bitmap for the hollow rectangle LVGL draws in place of a missing glyph — that
is unreliable, and unnecessary, because the font will simply say. Each codepoint of each string is
put to `lv_font_get_glyph_dsc()`.

It runs over the **data** and not only over the source literals, because half the strings arrive
over the network: the edition, dateline, session, `as_of` and `generated_at`; every index and ticker
symbol and name; and every story's kicker, headline, deck, byline, body, symbol, chart span, caption
and credit. Alongside them, every fixed string in `ui_strings.h`, the weekday abbreviations, and —
the check that catches a whole class of bug — `S_COMPOSED_CHARS` and `S_DATA_PUNCT`, the characters
that only ever appear inside a runtime-composed string. The board this forked from shipped a label
that rendered fine except that the space in `"%s %s"` came out as a tofu box, because a space is
drawn from the label's own font and no source literal happened to contain one.

Every string is checked against **all six text faces**, not only the one that draws it today. The
six are deliberately identical in coverage — ASCII, Latin-1, `S_DATA_PUNCT` — and the tier engine
moves strings between them freely: a headline demoted from the lead well to a 364 px column changes
face without changing a byte, and the same story appears again on A2 in `deck_24`. Checking only
today's face would let a regression through until the day a payload arrived one story shorter.

`ui_font_masthead_112` is deliberately absent from that list. It is subset to the Latin alphabet, it
draws exactly one string, and it is checked against `S_MASTHEAD` by name — which is what catches
editing the paper's name without regenerating the fonts, on the largest text on the sheet.

### Colour discipline

The assertion this file exists for, and the one that keeps the design's colour policy true as the
page evolves.

**Blue and yellow are checked everywhere, on both pages and on the overlay.** Neither may reach the
glass from the UI at all, so that half of the policy needs no geometry and holds even where A2's is
private to its own file.

**Red and green may only appear inside a named box.** On A1 those are the index ribbon's band, the
portfolio rail's eight rows, the quotation table's `CHG` column, the lead's photo slot, and — only
on a payload with no stories, where the lead well *is* the index ribbon at headline size — band 5.
The rail's box spans the full measure rather than a fixed x, because the rail widens into the
columns a thin paper's missing stories left: what is fixed about it is the eight rows, not the
measure they are set across. The `CHG` box is arithmetic on `ui_internal.h`'s own field widths
rather than a copy of `ui_page_front.c`'s `FP_T_CHG_X`, so a field widened there without its
neighbour narrowed moves the box with it.

Every coloured pixel outside every slot is a failure, and the first one prints the list of slots
that were allowed — "outside every slot" is only actionable if the reader can see which slots those
were.

The report also carries what LVGL *asked for* at that pixel, kept alongside what the quantizer
decided. That is the difference between the two reports a stray colour can produce: "the page drew
green here", which is a colour-policy bug in a page file, and "the page drew something between two
inks and the dither landed on green", which is the anti-aliasing the policy exists to keep off the
sheet. Without it, every such failure costs a bisect.

### The badge, and the overlay

The badge is the sheet's one inverted element — a filled chip with its word reversed out — so what
the check looks for is a **chip and not a word**: every row of the kicker strip must ink somewhere
within 16 px of the sheet's centre column, which a solid rectangle does and a caps label that had
drifted into the middle of the strip does not.

The overlay is checked to have said something in the middle of the sheet, and to have **covered**
the masthead band and the folio band. Its band and rule checks are deliberately not run: it is not a
page, it has no bands, and its own box is a private constant in `ui_news.c` that the simulator is
not going to acquire a second copy of.

## Output

Previews go to `sim/shots/` as 24-bit BMP, drawn in `wp_palette_ink` — the **measured** Spectra 6
inks (a warm off-white, a brick red, an olive green, a dull navy) rather than the saturated
primaries the UI draws with. A screenshot in primaries flatters the page into a decision nobody
could make from the real panel, and the whole reason `sim/shots/` is looked at after a UI change is
to judge the page as paper.

`sim.sh` converts each to PNG with `sips` on macOS: a 1200 × 1600 24-bit BMP is 5.8 MB and a PNG of
the same six flat inks is a fraction of it. The exit status is carried past that conversion rather
than allowed to end the script, because a failing run is exactly the run whose previews someone
wants to look at.

Each line of output carries an ink percentage. A page that rendered nothing comes out near 0%, one
that has gone solid black near 100%, and both are bugs a human skimming filenames would miss:

```
  01_a1_full         10.19% ink   shots/01_a1_full.bmp
  02_a2_full          5.57% ink   shots/02_a2_full.bmp
  03_a1_sparse        6.33% ink   shots/03_a1_sparse.bmp
  04_a2_sparse        2.93% ink   shots/04_a2_sparse.bmp
  05_a1_quiet         5.47% ink   shots/05_a1_quiet.bmp
  06_a2_quiet         4.99% ink   shots/06_a2_quiet.bmp
  07_a1_stale        10.19% ink   shots/07_a1_stale.bmp
  08_a1_offline      10.18% ink   shots/08_a1_offline.bmp
  09_setup            0.57% ink   shots/09_setup.bmp
  10_a1_nodata        2.68% ink   shots/10_a1_nodata.bmp
ok — 0 layout/glyph/colour problem(s)
```

A1 on a full payload sits at about 10% and A2 at about 5.5% — a markets page is figures and rules
where a front page is a headline, a photograph and four columns of type. The setup overlay's 0.57%
is the whole of its evidence that it covered the sheet.

Every failure prints coordinates. A count alone tells you the page is wrong and not where, and each
check caps its own output at six reports and then says how many more it found, which is enough to
see the shape of a failure without burying the next check.

## What it does not do

It does not talk to a panel, and it cannot tell you what a refresh looks like — the waveform, the
ghosting, and the twenty-five seconds are all
[the driver's](epaper-13in3.md) business. It does not check the repack either: that is
`test_epd6_transpose`, which holds `epd6_pack_block()` against an independent reference
implementation on the host. And it does not check the wire contract; `test_news_parse` and
`test_news_mock` do, and they run first because they are faster.

What it owns is everything between a parsed snapshot and the bytes that would go to the controller.
