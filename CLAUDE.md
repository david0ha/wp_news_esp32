# CLAUDE.md

This repository is a **one-copy newspaper**: an ESP32-S3 driving a 13.3" Spectra 6 six-colour
e-Paper panel, portrait 1200 × 1600, that prints a broadsheet about **one listed company a day**.
An agent researches it off-board and serves one JSON URL on the local network; the device typesets
it. Two pages — A1, why the price moved and what else happened to the company, and A2, the same
company's accounts. It is set up over Wi-Fi from a captive portal.

The authoritative design is
[docs/specs/2026-08-15-single-company-broadsheet-design.md](docs/specs/2026-08-15-single-company-broadsheet-design.md),
which supersedes the data model and layout of
[2026-08-14-front-page-design.md](docs/specs/2026-08-14-front-page-design.md) (whose geometry,
colour policy, chart rules and photo rules still hold). Read them before changing layout, the data
model or the wire contract; everything below is what the code does about it.

## Quick start (do this first)

Activate the ESP-IDF environment — **once per new shell session**:

```bash
. ~/esp/esp-idf/export.sh      # the only IDF here; idf.py --version says v5.4.3
```

The path deliberately does **not** name a version: there is one install, and a versioned directory
only earns its keep when there are two to tell apart. Ask `idf.py --version` — not a path, and not
this paragraph. What stood here pointed at a `~/esp/v5.4.3/` that has since been deleted and called
this directory a second install carrying v5.4.1; the draft written to replace it announced v6.0.2,
which had already been rolled back by the time it was written. Three descriptions, none of them
true now, and one that was never true.

What is left of the second install is the trap. A v6.0 migration was attempted and rolled back, so
`~/.espressif` still carries **both** cross-compilers — `esp-14.2.0`, which 5.4.3 wants, and
`esp-15.2.0`, which it does not — and a python environment for each. Let the wrong one onto `PATH`
and the build compiles most of the tree before dying in the *bootloader* subproject with `Tool
doesn't match supported version from list [...]`, a message that reads like a broken toolchain
install and actually means the environment handed 5.4.3 the other IDF's compiler. It ends by
advising `idf.py fullclean`, which does not work — fullclean has to configure first and fails the
same check. Remove `build/` by hand and use the 5.4 environment.

If `export.sh` is unavailable (some sandboxes refuse to source it), `idf.py` runs directly — but
setting `IDF_PATH` is not enough on its own, because nothing has put the cross-compiler on `PATH`
yet. `idf_tools.py export` is what does that, and skipping it is why the obvious four-line version
of this block fails at `The CMAKE_C_COMPILER: ... is not a full path and was not found in the PATH`,
a message about `PATH` that is really about the missing step:

```bash
export IDF_PATH="$HOME/esp/esp-idf"
export IDF_PYTHON_ENV_PATH="$HOME/.espressif/python_env/idf5.4_py3.14_env"   # the 5.4 one
PY="$IDF_PYTHON_ENV_PATH/bin/python"
TOOLS="$("$PY" "$IDF_PATH/tools/idf_tools.py" export)"   # never 2>/dev/null this
eval "$TOOLS"
"$PY" "$IDF_PATH/tools/idf.py" build
```

Do not silence that export. Discarding its stderr hides the one line that says which tool is
missing, and leaves you with the same misleading `CMAKE_C_COMPILER` failure a hundred lines later.

Standard workflow after activation, run from the **repository root** (the root *is* the IDF project):

```bash
idf.py set-target esp32s3      # once per checkout
idf.py build
./tools/flash.sh               # finds the port, flashes, monitors (Ctrl+] to exit)
```

`tools/flash.sh` is `idf.py -p <PORT> flash monitor` with the two things that actually go wrong
handled: which of `/dev/cu.usbmodem*` / `cu.usbserial-*` / `cu.wchusbserial*` this board
enumerates as, and the second between the device node appearing and the CDC endpoint accepting a
connection. It activates the IDF environment if you have not.

- If it won't enter flash mode, **hold BOOT while pressing RESET**, release, and retry.
- If it finds no port at all, check the USB-C cable carries data. A charge-only cable powers the
  board and enumerates nothing.

## Verify before claiming anything works

Five layers, four of them runnable without hardware. Run them in this order — each is faster than
the next and catches a different class of mistake.

```bash
# 0) the desk, the worker and the phone app, pure logic — no Docker, no network, no API key
sh server/test/run.sh
sh agent/test/run.sh
(cd app && npm test && npm run typecheck)   # the client, the PNG decoder, the formatters

# 1) pure logic — ten host tests: the wire format, the demo snapshot, the fetch
#    layer, the companion-app JSON, the quantizer, the framebuffer repack,
#    copyfitting, chart scaling, the compositor's tiling invariants, and the
#    wake decision
cmake -S components/news_core/test/host -B /tmp/vt && cmake --build /tmp/vt
/tmp/vt/test_news_parse && /tmp/vt/test_news_mock && /tmp/vt/test_news_service \
  && /tmp/vt/test_api_json && /tmp/vt/test_palette && /tmp/vt/test_epd6_transpose \
  && /tmp/vt/test_fit && /tmp/vt/test_chart_scale && /tmp/vt/test_compose \
  && /tmp/vt/test_power_policy

# 2) provisioning pure logic, and the reference producer against its committed fixture
sh components/provisioning/test/run.sh
python3 tools/mock_news_server.py --check
python3 tools/test_mock_etag.py

# 3) the real UI at the real resolution in six inks -> BMP/PNG, plus the layout,
#    glyph and colour assertions
cd sim && ./sim.sh          # NEWS_URL=http://localhost:8123/news.json ./sim.sh

# 4) firmware
idf.py build
```

The simulator is not a preview, it is a **test**: it fails the build on a missing glyph, on a
composition that does not tile the well, on ink outside the 30 px margin, on a module that rendered
nothing, on a label wider than its slot, on a masthead over 1140 px, and on blue or yellow reaching
the glass. Its assertions are **properties**, not transcriptions — "the modules tile the well" holds
for every payload, where the old "the lead rule lands on row 1108" could not survive a page that
changes shape. Look at `sim/shots/*.png` after any UI change — they are drawn in the *measured*
Spectra 6 inks rather than the saturated ones the UI draws with, so they can be judged as paper.

The producing agent runs the same typesetter over its own candidate payload before it files, via
`tools/edition/render-check.sh <news.json>`, and is required to look at the sheets it produces. A
desk that cannot see the paper cannot know that a headline four characters over budget became an
ellipsis in the middle of a sentence.

## Target hardware

| Item | Specification |
|------|------|
| Board | **Seeed XIAO ePaper Display Board** (the 13.3" carrier is the EE02; the display half is routed identically on the EE04 and EE05) + **XIAO ESP32-S3 Plus** |
| SoC | ESP32-S3 (Xtensa LX7 dual-core), 16 MB Flash / 8 MB Octal PSRAM |
| Display | 13.3" **Spectra 6** e-Paper, **portrait 1200 × 1600**, six inks, **two UC8179 controllers**, 4-wire SPI + two chip selects + one BUSY |
| Refresh | one kind, ~20–30 s, whole sheet flashes. **No partial waveform at all.** |
| RTC | **no external chip** — the clock is SNTP only. The S3's *internal* RTC still times a deep-sleep wake, so this costs the date, not the waking |
| Wireless | Wi-Fi 802.11 b/g/n |
| Buttons | KEY0 (GPIO2), KEY1 (GPIO3), KEY2 (GPIO5), BOOT (GPIO0 on the XIAO) |
| Power | 5 V USB-C, optional battery (JST 2.0 + slide switch) |

Wiring is the carrier's fixed routing, kept in `main/user_config.h`: `SCLK=7, MOSI=9, CS=44,
CS1=41, DC=10, RST=38, BUSY=4, POWER=43`; battery ADC=1 with its load switch on 6. Nothing else
hardcodes a GPIO — even the buttons are passed to `user_app` as data. Four traps:

- **BUSY is active LOW.** The panel is idle when the pin is HIGH. Getting it backwards fails
  *silently*: every wait returns instantly and every refresh comes out torn, with nothing in the log
  to say why. One BUSY line is wired to both controllers.
- **GPIO43 gates the panel's power** (load switch with a pulldown, must be driven HIGH — `epd6_init()`
  does it).
- **GPIO43/44 are the default UART0 pins**, so the console must stay on USB Serial/JTAG
  (`sdkconfig.defaults`). A UART0 console clocks log bytes into PWR_EN and CS.
- **The second chip select is GPIO41**, and it appears in no Seeed document. It comes from
  `acegallagher/esphome-bigink`. A blank *right half* of the sheet is this pin.

There is **no I2C bus**: GPIO5 and GPIO6 are KEY2 and the battery divider's enable.
See [docs/pinout.md](docs/pinout.md).

> The framebuffer is portrait 1200 × 1600 at 4 bpp — stride 600 bytes, **960,000 bytes**, in PSRAM.
> The panel's two controllers own its **columns**, not its rows: master `x 0..599`, slave
> `x 600..1199`, 480,000 bytes each. The landscape rotation an earlier revision carried is *gone*,
> not inverted — substituting `fb_P(px,py) := fb_L(1599-py, px)` collapses `epd6_pack_block()` to a
> per-row 300-byte `memcpy`. The derivation is preserved in `epd6_transpose.h` and is the whole proof
> that the image on the glass did not flip; `test_epd6_transpose` holds it against an independent
> reference.

## The four things that make this board different

**1. A refresh costs twenty to thirty seconds and there is no partial one.** Spectra 6 has no partial
waveform, so every partial-refresh entry point from the 5.83" driver is *gone* rather than stubbed —
a caller that wants one fails to compile instead of quietly spending half a minute. Drawing and
presenting are separate everywhere:

```c
...update widgets...      /* ui_news_set_*(), cheap, no panel traffic */
Lvgl_RenderNow();         /* synchronous render -> flush_cb -> framebuffer */
epd6_refresh();           /* twenty to thirty seconds. Not free. */
```

The LVGL flush callback **never** refreshes the panel; it quantizes RGB565 into the six inks and
returns. Exactly one task (`UiTask` in `components/user_app/user_app.cpp`) touches LVGL or starts a
refresh; everything else posts a command. The clock does not earn a refresh of its own — `ui_news_tick()`
moves it on in the framebuffer and rides out with the next refresh that had a reason. A front page
carries a date, not a ticking clock.

**2. A poll that changes nothing must not touch the panel.** `news_hash()` fingerprints everything
that reaches the glass — down to the photo ids, the chart span and every individual bar — and
`NewsTask` compares before it notifies `UiTask`. On a device that polls every five minutes forever,
this is the difference between a front page hanging quietly in its frame and one that flashes at
nobody all day. A fingerprint that is too narrow does not fail loudly; it shows yesterday's page
forever.

**3. The server decides what is important; the device decides what fits — and now also where it
goes.** Everything arrives with a `rank` and nothing about geometry, so a payload numbered 10, 20,
30 works exactly as one numbered 0, 1, 2. The eight fixed bands are gone: `ui_compose.c` cuts the
well fresh every edition, so a day with a photograph and eight briefs lays out differently from one
without. Capacities in `news_model.h` are deliberately **larger than one page can hold** — the
producer files a generous dossier and the device edits it down.

The compositor is a **guillotine**: every cut runs edge to edge across the rectangle it divides.
That is not a simplification, it is the safety argument. It makes every module a rectangle, makes
the modules tile the well exactly, and makes a white hole at the foot of the page structurally
impossible rather than something a test has to catch. `ui_compose()` is total — it never fails, it
drops the lowest-ranked module instead — and pure, because `news_hash()` promises that the same
fingerprint means the same pixels and the device skips a 25-second refresh on that promise.

**4. A wake is a boot, and the page on the glass is the only thing that survives it.** Deep sleep
does not resume: RAM is gone, PSRAM is gone, the 960,000-byte framebuffer is gone. `sizeof(news_t)`
is 32,952 bytes against the 8 KB of RTC retention RAM that crosses a sleep, so the snapshot cannot
survive and no clever packing will make it. What survives is **the glass**, because Spectra 6 is
bistable — cut the power entirely and the last edition hangs there indefinitely, drawing nothing.
That one property is the whole reason this is possible, and it makes the feature narrower than its
name. It is not "sleep between polls"; it is a **quiet path that never powers the panel, never
initialises LVGL and never allocates the framebuffer**. Bolting `esp_deep_sleep_start()` onto the old
boot path would run `epd6_init()`, build 390 LVGL objects and spend a refresh on every wake — about
2.5 mAh apiece, 240 mAh a day, a flat cell in under three weeks, and nothing new shown to anybody.
The sleep is not the feature; the quiet path is.

The consequence follows from the same fact and is the part that catches people: **whatever must
survive a wake has to fit in 8 KB, and whatever does not survive cannot be redrawn.** So a sleeping
board has no `OFFLINE` badge, and a wake never prints the demo page. Both would need a snapshot, and
the only snapshot on offer is the one the fetch that just failed did not bring — so yesterday's real
front page stays up, because it beats a page about a company the board invented. A failed wake
therefore resolves itself by sleeping again rather than by falling through to the panel; changed
content is the one thing that earns the full path.
[docs/specs/2026-08-17-deep-sleep-design.md](docs/specs/2026-08-17-deep-sleep-design.md) has the
failure table; `main.cpp` carries the one row it settles differently — the `OFFLINE` badge — and says
why at the point of the decision.

**How long to wait is one rule in both power modes.** The desk's `policy.poll_seconds` arms the RTC
timer on a board on a cell exactly as it paces the poll loop on a board on USB, with `next_change` as
a targeted wake and the board's own interval as the fallback when a payload carries no policy at all.
A board that slept by one rule and polled by another would still work, which is why the rule lives in
one function rather than in three.

## Project structure

```
main/                     app_main: the two-path boot — quiet wake, or panel + LVGL + task launch
components/
  port_bsp/               the Spectra 6 port — the only code that talks to the panel
    epd6_panel.c          two UC8179s, two chip selects, one refresh, no partials
    epd6_transpose.h/.c   geometry + the framebuffer -> controller repack (host-testable)
  app_bsp/                LVGL port (RGB565 draw buffer, quantized in the flush callback)
  news_core/              the portable core — compiles identically on device, sim and host tests
    news_model.c          the snapshot struct + UTF-8-safe copy + content fingerprint
    news_parse.c          wire JSON -> model, clamping every field
    news_mock.c           the built-in demo edition (shown when no URL is set)
    news_service.c        one fetch: http_get + parse
    ui_compose.c          the make-up desk: guillotine cuts, packing, height, tombstoning
    ui_modules.c          the module renderers both pages are built from
    ui_news.c             page routing, the furniture, the badge, the overlay
    ui_page_front.c       A1 — the day's modules, composed
    ui_page_markets.c     A2 — the same company's accounts, composed the same way
    ui_fit.c              copyfitting: how much body text fits a box, cut at a word
    ui_chart.c            line / candle / bar / sparkline, integer scaling, hard pixels
    ui_tile.c             the one-entry photo cache
    ui_common.c           the shared shapes; ui_internal.h holds the grid and the furniture
    wp_palette.c          the six inks and the ordered dither — the only quantizer
    device_api_json.c     the JSON the companion app receives
    fonts/                seven newspaper faces (OFL) — generated, do not hand-edit
    test/host/            the ten host tests
  provisioning/           SoftAP + captive portal + NVS + SNTP + /api/* onboarding
  device_api/             STA-mode HTTP/JSON control server + mDNS (claudepost.local)
  board_io/               battery ADC
  buttons/                KEY0/1/2 + BOOT edge events
  power/                  the wake decision (pure, host-tested), RTC-retained state, the shutdown
app/                      React Native companion app — setup, control, and the page on the glass; ships via EAS/TestFlight
sim/                      desktop simulator — renders the real UI to 1200x1600 and asserts on it
third_party/cJSON/        vendored (ESP-IDF v6 dropped cJSON from core)
tools/
  mock_news_server.py     the contract from a fixed payload — the reference producer
  edition/                the shared producer contract: PROMPT.md and the typesetting gate
  make_tile.py            a photograph -> a 4bpp tile the board blits verbatim
  gen_fonts.py            regenerates components/news_core/fonts/
  flash.sh                find the board and flash it
server/                   the desk: command queue, directives, gates, editions, and the URL the board polls
agent/                    an example worker that files into the desk, plus the standalone no-server producer
```

## Working rules

- **Every column span and every origin is EVEN.** A photo tile packs two pixels per byte, so a slot
  of odd width — or one starting at an odd x — cannot be blitted as a per-row `memcpy` and needs a
  nibble-shifting slow path on the device for no reason at all. The grid is six columns of 170 with a
  24 px gutter inside a 30 px margin (`6·170 + 5·24 = 1140`), and both of those numbers are even so
  that every span and every origin is. `ui_internal.h` has a `_Static_assert` on it; keep it true.
- **Colour is data, not decoration**, and there are exactly **two** things it may mean. Type is
  black, rules are black, a chart's axis is black, a headline is black. Everything coloured on the
  sheet answers to one of these:
  - **Direction** — green and red on a percentage change and its ▲▼ mark: the tape, a figure's
    change, the industry table's `CHG` column, and a rate line inside a drawn statement. Always
    through `ui_chg_colour()`, never a hardcoded green, so it is ink at zero and ink on the STALE and
    OFFLINE sheets, where the colour reserved for live movement has no business.
  - **Identity** — which series a bar or a segment belongs to, inside a graphic carrying more than
    one. That is `ui_series_t`, and the same series takes the same treatment in the plot and in the
    legend or the reader has to guess. A `TABLE_STACK`'s segments are shares, so they take series
    treatments; what carries *direction* in that graphic is each segment's percentage-point change
    beside its legend entry. A hero figure's range bar is ink, because a position inside a range is
    neither a direction nor a series.

  The rule is still a *test* and not a list — **if a mark is not data, it is ink** — it has simply
  gained a second kind of data, because a graphic drawn in one ink cannot say which of three
  quantities a bar is, and was making the reader count legend positions instead of seeing a colour.

  **What the panel can do decides the rest, and it can do less than six inks suggests.** WCAG
  contrast against the paper, from the ink table in `make_tile.py`: black 9.18:1, red 6.92, blue
  5.56, green 4.75, **yellow 1.16**. But the number that governs the design is not any single one of
  those — it is that **the inks are two bands with nothing between them.** Black, red, blue and green
  all sit between 0.016 and 0.077 relative luminance; the 1-in-3 screen, yellow and paper between
  0.374 and 0.554. Inside a band, brightness does nothing: blue vs green is **1.17:1**, screen vs
  keylined yellow **1.22:1** — the same brightness. So a graphic gets *two* clean steps of value and
  no more, and every series past the second must separate by **hue** (blue against black is 1.65:1 in
  value and unmistakably blue) or by **texture** (a screen against flat paper is 1.42:1 and obviously
  striped). Two series sharing a band, a hue and a texture are one series to a reader, whatever the
  legend says. `ui_series_at()` maximises the minimum separation across all three axes; do not
  hand-pick a treatment around it.
  Yellow does not work on paper — it is the same value as the paper, so a yellow bar reads as the
  *outline* of a bar. Against black it is 7.90:1, the best pair the panel has after black on paper,
  so **yellow is legal only enclosed by a black keyline** and `ui_series_fill()` is the only call
  that can draw one. The simulator fails the build on a yellow pixel that can reach paper without
  crossing black, and on blue or yellow outside a graphic. The only other colour on the sheet is a
  photo tile. Every colour used is an exact palette entry, so it takes `wp_quantize()`'s identity
  path and comes out flat — a colour between two inks dithers, and a dithered hairline is a dashed
  one. Recompute the table rather than trusting it — `python3 tools/contrast.py` prints it, along
  with every pair and the ones a reader cannot separate. The first version of this paragraph carried
  figures derived from linear luma and every one of them was wrong, which is why the numbers now
  live in a script instead of in prose.
- **A1 is a text-and-photograph newspaper.** Story bodies, headlines, decks and photographs hold the
  majority of the well, and `ui_compose()` enforces it by dropping the lowest-ranked *figure* module
  rather than by refusing to compose. A2 is the accounts page and may be figure-led. This is the
  constraint that outranks the others: a front page filled with graphics is the failure this design
  is furthest from wanting, and it is the one that arrives by accident, one well-argued chart at a
  time.
- **Charts and marks are drawn with hard pixels**, through `ui_draw_line_c_abs()` / `ui_draw_tri_abs()`,
  never `lv_draw_line()` or `lv_draw_triangle()`. LVGL antialiases a diagonal, this panel has nothing
  between ink and paper for a blend to land on, and `wp_quantize565()` resolves the mid-greys a black
  stroke on white paper makes to **GREEN**. A chart drawn with `lv_draw_line()` is a black chart
  fringed with green speckle — and now that a chart *may* carry colour, that is worse rather than
  better: the speckle is the exact ink that means "up", scattered along an axis that means nothing.
- **Never hand-edit `components/news_core/fonts/*.c`.** Run
  `python3 -m venv /tmp/fontenv && /tmp/fontenv/bin/pip install fonttools`, then
  `/tmp/fontenv/bin/python tools/gen_fonts.py --download`. fontTools is needed because Google
  publishes three of the four families only as variable fonts, and lv_font_conv would silently take
  the default instance — Playfair Regular where the table asks for Playfair Bold. The six text faces
  carry ASCII + Latin-1 + `S_DATA_PUNCT`, because headlines arrive over the network and cannot be
  subset; only the masthead face is subset, and only to the Latin alphabet.
  **All fixed user-visible strings belong in `ui_strings.h`** — that is where the generator reads the
  glyph set from, and where the simulator's coverage check reads it from.
- **Every face is 1 bpp**, including the 112 px masthead. Anti-aliased text goes through the same
  ordered dither as a photograph: a 16 px serif stem is about 1.5 px wide, so half of it is
  anti-aliasing, and dithering that half turns a solid stem into a dotted one. Measured side by side
  at 3× before it was decided. See [docs/graphics.md](docs/graphics.md).
- **Photographs are halftoned to black and white, not dithered to six inks.** `tools/make_tile.py`
  screens them; the device never resizes, tone-maps or dithers anything, it copies `w*h/2` bytes.
  Six-ink error diffusion was rendered and looked at: it produces coloured speckle that reads as
  damage. A halftone reads as print, which is what a broadsheet actually does. `--color` remains for
  an image that is *about* its colour, and applies gamut compression first.
- **Respect the length budget.** Headlines and decks are ellipsized at a fixed height, not
  copyfitted, so a producer that overshoots gets a visible `…` mid-sentence rather than a shorter
  story: lead headline ≤ 72 characters, lead deck ≤ 118, secondary headline ≤ 54, secondary deck ≤ 58.
  A dossier label is ≤ 20 and its value ≤ 16, because both sit in a 170 px column. Bodies are the
  opposite — `ui_fit_text()` cuts them at a word boundary, so write them long (lead 600–740,
  secondary 260–330) and the column always fills. That matters more now than it did: the compositor
  stretches an elastic module to fill the room it was given, so a short body is visible as white
  paper rather than as a shorter story. The full table is in
  [tools/edition/PROMPT.md](tools/edition/PROMPT.md), which is where the producer reads it.
- **Labels get a fixed height, not just a width.** `ui_lab_w()` and `ui_lab_box()` do this; bypassing
  it makes LVGL auto-size the height and *wrap* instead of ellipsizing, and the second line lands on
  the row below.
- **The chart scaling stays integer and libm-free.** Prices arrive as `int32_t` cents and leave as
  `int16_t` rows; nothing between holds a float. `sin()` and friends agree between x86 and Xtensa only
  to within an ulp, which is enough to move a pixel and fail a screenshot test for a reason unrelated
  to the chart. `ui_chart.h`'s six pure functions own every decision about *where* ink goes, and
  `test_chart_scale` holds them to it.
- **`news_mock.c` and `tools/mock_news_server.py` must stay identical.** `test_news_mock.c` asserts it
  by parsing the server's committed fixture and comparing fingerprints. Change one and the test tells
  you which field diverged; then run `python3 tools/mock_news_server.py --write-fixture`.
- **A rejected payload must leave the previous snapshot alone.** `news_parse()` writes `*out` only on
  success. Blanking the sheet is the one failure a user actually notices, and a stale front page
  badged `STALE` beats an empty one.
- **The demo snapshot is a complete front page**, and an unconfigured board is a complete
  configuration, not a placeholder — so a board with no URL prints it at once and is finished.
- **A boot spends exactly one refresh, a wake that changes nothing spends none, and both paths are
  built around choosing which page gets one.** That is the budget: twenty-five seconds each, and the
  old boot path spent *five* of them —
  `epd6_init()` clearing to white, "Connecting to X", "Connected 192.168…", the demo snapshot, then
  the real page. A hundred and thirty-five seconds, of which about a hundred and ten said nothing a
  reader wanted. So `epd6_init()` no longer refreshes (the glass keeps the last edition until there
  is a better one), the two station events are log lines, and `UiTask` holds its refresh open for
  `FIRST_PAINT_WAIT_MS` so the *real* front page is the one that gets printed. The demo goes up only
  when nothing better arrives — or immediately, when no URL means nothing better is coming.
  The instinct this reverses is worth naming, because it is right on every other display: showing
  *something* finished, fast, normally beats showing nothing. Here the something costs the same
  twenty-five seconds as the real thing and delays it by that much again, so "fill the screen early"
  is precisely backwards. Deep sleep takes that argument one step further and arrives at zero: a
  timer wake that finds nothing new spends **no** refresh, and the only way to reach that number is
  to find out *before* powering the panel, building the UI or allocating the framebuffer — which is
  what the quiet path is for, and why the decision to take it is a pure function with a host test
  rather than a condition buried in `app_main`. Anything added to either path should be measured in
  refreshes first.
- **The cadence is one function — `power_cadence()`**: the desk's `policy` when present, the local
  interval otherwise, `next_change` as a targeted wake, the failure backoff on top. The quiet path,
  `enter_sleep()` and NewsTask's awake wait all call it; never add a fourth place that decides how
  long to wait. Two rules travel with it: the curve is applied **there and nowhere else**, so
  `power_decide()` takes `base_sleep_seconds` as final and cannot compound it, and the answer is a
  per-wake figure that belongs in `plan.sleep_seconds` — writing it into `wp_rtc_state.sleep_seconds`
  would turn one 120-second targeted wake into this board's local interval permanently, at 720 wakes
  a day, with every log line agreeing.
- **`sizeof(news_t)` is 32,952 bytes** — measured, not estimated. That is four times `UiTask`'s whole
  8 KB stack, so all three snapshots in `user_app.cpp` — the state, the UI copy and the fetch buffer —
  are file-scope statics, safe only because the single-owner rule holds: `UiTask` is the only caller
  of two and `NewsTask` of the third. Never put a snapshot on a frame. It has grown three times:
  19,720 to 24,328 when both statements gained a numeric plane beside their printed cells, 24,328 to
  32,932 when `NEWS_BODY_MAX` went to 4,000, and 32,932 to 32,952 for the `policy` block. The second
  is the banner forme's bill — a lead across the whole measure runs four legs down most of a 1,600 px
  sheet, which is about four thousand characters of body, and at 2,400 the field truncated the copy
  mid-word and the legs came up short. The third is sixteen bytes of policy and four of tail padding:
  `next_change` is an `int64_t`, the first member of this struct wider than four bytes, so the whole
  thing is now 8-aligned. That ended the argument that used to guarantee the host and the device
  agreed about the layout — every member being four bytes or narrower — which is why `news_model.c`'s
  `_Static_assert` is now a measurement on each target rather than a note. Three statics plus
  `news_parse()`'s heap scratch is about 130 KB at the peak of a poll, which is not what constrains
  this board — the 960 KB framebuffer is — but a snapshot on a stack is still an instant overflow.
  Measure it rather than trusting this line: the number has been wrong twice.
  There is now a **second ceiling beside the stack one, and it is the same size by coincidence**: the
  8 KB of RTC retention RAM, which is the only memory that survives a deep sleep. Four times too
  small again — which is why what crosses a wake is a 32-bit `news_hash()` and an ETag rather than
  the snapshot they describe, and why a wake that needs the snapshot back has to fetch it.
- **`sdkconfig` holds per-developer values and is gitignored — never commit it.** Wi-Fi passwords live
  in NVS via the portal, never in Kconfig.
- **Nothing personal belongs in this repository.** No home paths, no real hostnames, no vault paths,
  no watchlist, no standing editorial instruction. Whatever makes a paper sound like somebody's own —
  a rotation, a house style, a list of things that must never print — is read at runtime from an
  `AGENT_CONTEXT_DIR` the operator points at their own directory (see `agent/README.md`'s "Bring your
  own continuity"), never checked in. The repository ships templates only — `*.example` files and
  `agent/context.example/` — and a repository about to be public is the wrong place to discover that
  a path or a hostname was somebody's own.
- The mDNS hostname is `claudepost` and the AP prefix `"Claude Post"` — deliberately **not** the
  `tickerboard` / `"Ticker Board"` of the project this forked from, whose shipped app resolves those
  names.
- If anything about the hardware is uncertain, don't guess — check
  [docs/references.md](docs/references.md).

## Documentation

- [docs/specs/2026-08-15-single-company-broadsheet-design.md](docs/specs/2026-08-15-single-company-broadsheet-design.md) — **the current design**: one company an edition, the guillotine compositor, and why the measure decides the layout
- [docs/specs/2026-08-14-front-page-design.md](docs/specs/2026-08-14-front-page-design.md) — what this was built from. Its geometry, colour policy, chart and photo rules still hold; its data model and band table are superseded
- [docs/specs/2026-08-17-deep-sleep-design.md](docs/specs/2026-08-17-deep-sleep-design.md) — the wake path that never powers the panel: what crosses a sleep, the failure table, and how a board stays reachable. Its dated note at the top says what the desk's cadence superseded; the task-by-task plan it was built from is [docs/superpowers/plans/2026-08-17-deep-sleep.md](docs/superpowers/plans/2026-08-17-deep-sleep.md)
- [docs/bring-up.md](docs/bring-up.md) — first power-on: the boot log line by line, and the numbers to record
- [docs/news-contract.md](docs/news-contract.md) — the JSON the device polls, and how it fails
- [docs/hosting-cloudflare.md](docs/hosting-cloudflare.md) — serving the edition from a domain instead of a Mac on the LAN: what must be published, what must not, and what changes on the device once the URL is `https://`
- [docs/desk-server.md](docs/desk-server.md) — the desk server behind the URL the board polls: `server/` serves it and owns every gate, `agent/` files the editions and holds the credentials
- [docs/pages.md](docs/pages.md) — A1 and A2, the grid, the bands, the font decision
- [docs/epaper-13in3.md](docs/epaper-13in3.md) — the dual-UC8179 driver, the refresh policy, the self-test
- [docs/graphics.md](docs/graphics.md) — six-ink rendering: the two palettes, the dither, the halftone
- [docs/pinout.md](docs/pinout.md) — GPIO assignments and the four traps
- [docs/board-hardware.md](docs/board-hardware.md) — hardware notes
- [docs/app-control.md](docs/app-control.md) — the companion-app HTTP/JSON contract
- [docs/simulator.md](docs/simulator.md) — the desktop simulator and what it asserts
- [docs/esp-idf-development.md](docs/esp-idf-development.md) — install / build / flash / menuconfig
- [docs/references.md](docs/references.md) — datasheets and upstream sources
