# Rendering onto a six-ink panel

The display is **1200 × 1600 portrait, six inks, no greys**: black, white, red, yellow, blue, green,
and nothing between any two of them. Every rendering decision in this project follows from that plus
a refresh that costs twenty to thirty seconds and flashes the whole sheet. This is what was chosen
and why.

## The pipeline

```
LVGL widgets (RGB565)
   ↓  lv_refr_now()  — synchronous, on demand, 120-row strips
flush callback (main.cpp): wp_quantize565(px, x, y)
   ↓  epd6_set_pixel()
4 bpp framebuffer, 1200 × 1600, stride 600 → 960,000 B in PSRAM
   ↓  epd6_pack_block()  — per-row 300-byte memcpy, split by COLUMN
two UC8179 controllers, 480,000 B each
   ↓  epd6_refresh()   — explicit, never automatic, ~25 s
panel
```

Three arrows matter. **The flush callback does not refresh the panel** — it quantizes and returns.
**The render is triggered on demand** rather than whenever LVGL feels like it. And **the pack is a
copy**, not a transpose: the framebuffer is portrait because the panel and the page both are, so the
rotation an earlier revision carried was removed rather than inverted. The derivation that proves the
image did not flip is in `epd6_transpose.h`; `test_epd6_transpose` holds it to an independent
reference implementation.

The dither is positional, so the flush callback must pass **screen** coordinates, not offsets within
the strip. Pass the wrong ones and the Bayer pattern seams visibly at every 120-row boundary.

## Two palettes, and why there are two

`components/news_core/wp_palette.c` carries two six-entry tables, and confusing them is the kind of
mistake that looks like a design decision.

| | `wp_palette_rgb` | `wp_palette_ink` |
|---|---|---|
| values | `#000000 #FFFFFF #FF0000 #FFFF00 #0000FF #00FF00` | `#262628 #E2DED3 #9E342C #D0B03A #32447E #3E6E4A` |
| what it is | what the UI draws with, and what the quantizer matches against | roughly what the panel looks like |
| used by | `wp_nearest()`, `wp_quantize()`, every `UI_*` colour | the simulator's preview writer, and nothing else |

The saturated table is not a simplification. LVGL renders in **RGB565**, and every channel of every
entry is 0 or 255, which is exactly the condition for `RGB888 → RGB565 → RGB888` to be the identity:
5-bit 31 expands back to 255, 6-bit 63 expands back to 255, 0 stays 0. A palette colour that did not
survive that round trip would arrive at the quantizer slightly off, fail to match itself, and dither
— fringing every black hairline with speckle. **Never quantize against `wp_palette_ink`.**

`wp_palette_ink` exists so `sim/shots/*.png` can be judged as paper. A screenshot in saturated
primaries flatters the design into a decision nobody could make from the real thing: the panel's white
is warm paper, its red is a brick, its green an olive. It is used only when the simulator writes a
preview image.

> **The two ink tables in this repository do not agree**, and both are honest about their
> provenance. `wp_palette_ink` says it is eyeballed from Spectra 6 product photography;
> `tools/make_tile.py`'s `INK` says it is measured off a panel (`#1F2226` black on `#B9C7C9` white,
> a contrast ratio near 5:1). The producer's is the one photographs are dithered against and is the
> one that has to be right; the preview's only has to be recognisable. If somebody ever puts a
> colorimeter on a panel, correct both, and delete this paragraph.

## The dither is ordered, not Floyd–Steinberg

Bayer 8 × 8, values 0..63, the classic recursive matrix. Three reasons, in order of weight:

1. **It is stateless**, so it survives LVGL's partial rendering. Error diffusion across a strip
   boundary would need the previous strip's residue, and LVGL does not hand it back.
2. **It is deterministic**, so a screenshot test can assert on pixels.
3. **It leaves exact palette colours exactly alone.**

The offset spans one whole quantization step and is applied equally to R, G and B:

```
offset(b) = (2b - 63) × 255 / 128,   b = 0..63   →   -125 … +125
```

There is no zero in the middle — `b ≤ 31` is negative and `b ≥ 32` positive — which is what makes a
flat mid-grey come out exactly 32 black and 32 white over an 8 × 8 tile rather than 33:31.

Property 3 is the load-bearing one. Because the offset moves all three channels together, a colour
whose channels are already at the rails can only move *inward*, and the nearest match does not
change. So black type, black hairlines and the green and red change figures take an identity path
through the quantizer and come out flat, at every position in the matrix. Only colours strictly
between the rails break up. `test_palette` asserts it for all six entries over all 64 positions.

That property is also the whole of the colour policy: everything the UI draws is one of
`WP_RGB_BLACK`, `WP_RGB_WHITE`, `WP_RGB_GREEN`, `WP_RGB_RED`, and a fifth value anywhere on the sheet
would be the only dithered thing on it.

## Text is 1 bpp, and stays 1 bpp

Every one of the thirteen faces is generated with `--bpp 1`, including the 112 px masthead and all
six Korean ones.

The argument is the panel's, not the font's. LVGL renders anti-aliased text as intermediate RGB565
values, and the flush callback ordered-dithers them. For a photograph that is correct and necessary.
For text it is destructive: a 16 px serif stem is about **1.5 px** wide, so half of it is
anti-aliasing, and dithering that half turns a solid stem into a dotted one. Rendered side by side at
3×, 4 bpp body text has visible holes punched through `m`, `w` and every descender, and the masthead
grows a ragged stipple along contours that 1 bpp keeps smooth.

1 bpp also means every text pixel is exactly `WP_RGB_BLACK` or `WP_RGB_WHITE`, so text takes the
identity path above and cannot pick up a colour fringe at all.

The saving is incidental but large, and the Korean faces are what makes it load-bearing rather than
incidental. The seven Latin faces cost 119 KiB between them; the six Korean ones behind them cost
1.50 MiB, because 2,350 완성형 syllables is ten times the glyph count of Latin-1 and each one is a
denser drawing. At 4 bpp that bill would be four times over, and the 56 px Korean face would cross
the 2^20 bytes the 20-bit `bitmap_index` field can address — a limit `gen_fonts.py` now asserts on
rather than documents. 1 bpp is what keeps a thirteen-face board inside an 8 MB partition with room
to spare.

## Chart geometry is drawn with hard pixels

`ui_draw_line_c_abs()` is an integer Bresenham run emitted as run-length spans. `ui_draw_tri_abs()`
fills the ▲▼ marks one scanline at a time. Neither uses `lv_draw_line()` or `lv_draw_triangle()`, and
that is not a preference.

LVGL antialiases a diagonal: every pixel down the slope leaves the draw buffer as a blend of the ink
and the paper, and this panel has nothing between the two for a blend to land on. Two things then
happen, and the second is the one that gets quoted:

- **The stroke breaks into a checkerboard.** This is the large effect. At the two or three pixels a
  chart strokes at, and at the ten or twelve a market mark is set at, the slope *is* the shape.
- **A small fraction of it comes out coloured.** Measured over the whole grey ramp as LVGL actually
  delivers it — RGB565, where R and B carry five bits and G carries six, so a "grey" is never quite
  neutral — **0.59% of pixels land on a colour: 64 green and 32 red out of 16,384**. That is not much
  ink. It is also in a band where the colour policy allows no colour at all, and against white paper
  a scatter of green reads as dirt rather than as a chart.

So every pixel of every chart, every rule and every mark is laid down as exactly the colour that was
asked for. No libm and no float either, for the reason the price scaling has none: a double rounded
differently on x86 and on Xtensa moves a pixel and fails a screenshot test for a reason that has
nothing to do with the drawing.

Line width is spent across the **minor** axis — a shallow line thickened vertically, a steep one
horizontally — which is a pen held upright rather than perpendicular to the stroke. At 45° that
measures narrower than the width asked for, which is what every plotter that draws a line as spans
does. What it buys is that consecutive steps share an edge, so no diagonal can open a one-pixel hole
the way a square brush stamped per pixel does.

## Photographs are dithered across all six inks — and the first answer was wrong

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
carries nothing — which is what `--halftone` is for. It is also what the front page uses for
photographs, because black ink on white paper is what a broadsheet does.

## The demo edition's pictures, and the rule they look like they break

`tools/demo_photos.py` synthesises the three pictures the built-in demo edition names, and
`sim/tiles/*.bin` is its committed output. Something has to be able to produce them or the one page
an unconfigured board prints is the one page whose photographs cannot be regenerated — and a real
wire photograph cannot go in a repository, because it is somebody's copyright.

That looks like it violates the rule above, and it is worth being precise about why it does not.
**"Never judge a dither on synthetic input" is about judging the PANEL, not about what may be
drawn.** The finding was that flat synthetic colour makes six-ink error diffusion look like
confetti, so a decision about the palette taken on that evidence is a decision about the input's
flatness. The demo pictures are not being used to make that decision — it has been made, from
photographs — and they are screened with `--halftone`, which is the treatment that finding chose.

What they still have to be is not flat, and that is the whole design of the file. A halftone trades
spatial resolution for tonal resolution and has nothing to trade with in a surface that is
featureless: fill a wall with 50% grey and the screen returns a regular dot pattern that reads as a
moiré artefact. So each plate is real 3D geometry through a real pinhole camera — world to camera,
perspective divide, raster, depth buffer — shaded by surface normal rather than by depth, with
fractal noise at five octaves on every material, atmospheric haze toward the far plane, and grain
last at a size just above the screen's own cell.

Two earlier versions placed geometry with curves fitted by eye and came back as a drift of grey
rectangles. The failure was not that the curves were wrong; it was that no two edges agreed on where
the camera was, and a frame in which nothing agrees about the camera does not read as a place no
matter how good its noise is.

The generator is **deterministic** — seeded generators only, no system entropy — because the tiles
are committed and `test_news_mock` pins the fixture that names them. A rebuild that re-randomised
them would make every build a diff.

```bash
python3 -m venv /tmp/tileenv && /tmp/tileenv/bin/pip install Pillow numpy
/tmp/tileenv/bin/python tools/demo_photos.py --preview   # and what the panel prints
```

It reports the mean and the fraction of each frame between 0.25 and 0.75. A photograph that
halftones well is one that is mostly mid-grey; under about half is a frame that will come back as
two flat inks and a gradient.

## Why LVGL with an RGB565 buffer

LVGL v9 has native indexed colour formats, which would cut the 288,000 B draw buffer
(`1200 × 120 × 2`) by a factor of four or more. They are not used, and the reason is the simulator.

`sim/` compiles the real UI and the real fonts against desktop LVGL and quantizes with the *same*
`wp_quantize565()`. Every layout constant in this project was measured off those bitmaps, and the
simulator asserts on them on every run. Keeping one colour format across device and host means a
screenshot is evidence about the device, not an approximation of it. A quarter of a megabyte of an
8 MB PSRAM is a cheap price for that; a silent rendering difference between the two is not.

## Why hand-positioned pixels, not flex/grid

Every page positions everything with absolute constants against the grid in `ui_internal.h`, in
**panel coordinates** — a band's `y` is the `y` passed to LVGL, so the number in the table is the
number on the glass and the simulator can assert on it with no translation step. That is unusual for
LVGL and deliberate:

- **A newspaper page that reflows is not a newspaper page.** The bands are fixed; the tier engine
  chooses what fills a band, and the band never moves.
- **A reflow means a full refresh.** On this panel "the layout shifted slightly" and "every pixel
  changed" are the same event, and it costs twenty to thirty seconds and a flash.

The constants are not guesses. They are asserted twice — once by `_Static_assert` in `ui_internal.h`,
where a column width edited without its gutter fails the build rather than three pixels into the
right margin, and once by the simulator, which checks that every rule lands on its exact row, full
width and unbroken.

Two LVGL traps worth naming:

- **Children are positioned relative to the parent's *content* area**, which a `border_width` insets.
  A border style on a page object silently shifts every absolute Y in that page's grid, so frames are
  drawn as child boxes, never as a style on a container that has children.
- **A label with only a width set will wrap, not ellipsize.** `LV_LABEL_LONG_MODE_DOTS` needs the
  height pinned too, or LVGL auto-sizes the height downwards and the extra line lands on whatever is
  below it. `ui_lab_w()` sets both, and `ui_lab_box()` pins a height of exactly *n* line heights —
  LVGL rounds the cut down to the last whole line, which is how the lead headline gets two lines and
  cannot take a third from the deck.

## Rules of thumb

- Rules and dividers are **solid black**, in exactly three weights: hairline 1 px, rule 2 px, heavy
  3 px. No radii anywhere. A "subtle" grey is a dashed line on this panel, and a fourth weight is how
  a page starts having a hierarchy the eye reads as a mistake.
- **No background fills, no tinted panels.** White paper, black type, edge to edge. The one exception
  is white punched deliberately under something already drawn — `ui_lab_opaque()` puts a label's box
  in paper so a chart's value label does not have its own polyline running through it.
- **Colour is data**, and it means exactly two things. *Direction* — green and red on percentage
  changes and their marks, through `ui_chg_colour()`. *Identity* — which series a bar or a segment
  belongs to inside a graphic carrying more than one, through `ui_series_t`. Type, rules and axes
  are black. Blue and yellow are legal only inside a graphic, and **yellow only enclosed by a black
  keyline**: at 1.16:1 against the paper it is the same value as the paper, so an unkeylined yellow
  bar reads as the outline of a bar. The simulator fails the build on a yellow pixel that can reach
  paper without crossing black, and on blue or yellow anywhere outside a graphic.
  The governing fact is not any single ink's contrast — it is that **the inks are two bands with
  nothing between them**: black, red, blue and green all between 0.016 and 0.077 relative luminance,
  the 1-in-3 screen, yellow and paper between 0.374 and 0.554. Every within-band pair is under 2:1
  and every cross-band pair over 3.3:1. A chart therefore gets one clean cut of value and no more,
  and a third distinguishable series must be bought in hue or in texture. Run
  `python3 tools/contrast.py` for the table; do not transcribe it.
- Ellipsize, never wrap, outside the provisioning overlay and body copy. An ellipsis is an honest
  "there was more"; a wrap is a collision. Body copy is copyfitted before it is set, so it wraps and
  cannot overflow.
- Prefer filled silhouettes to outlines below about 20 px.
- Measure in the simulator before committing a constant, and add an assertion if the constant is
  load-bearing.
