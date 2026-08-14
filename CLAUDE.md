# CLAUDE.md

This repository is a **one-copy newspaper**: an ESP32-S3 driving a 13.3" Spectra 6 six-colour
e-Paper panel, portrait 1200 × 1600, that prints a front page about the stocks its owner named. An
agent researches them off-board and serves one JSON URL on the local network; the device typesets
it. Two pages — A1, the front page, and A2, the markets page. It is set up over Wi-Fi from a
captive portal.

The authoritative design is [docs/specs/2026-08-14-front-page-design.md](docs/specs/2026-08-14-front-page-design.md).
Read it before changing layout, the data model or the wire contract; everything below is what the
code does about it.

## Quick start (do this first)

Activate the ESP-IDF environment — **once per new shell session**:

```bash
. ~/esp/v5.4.3/esp-idf/export.sh      # v5.4.3 is what is installed here
```

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

Four layers, three of them runnable without hardware. Run them in this order — each is faster than
the next and catches a different class of mistake.

```bash
# 1) pure logic — eight host tests: the wire format, the demo snapshot, the fetch
#    layer, the companion-app JSON, the quantizer, the framebuffer repack,
#    copyfitting, chart scaling
cmake -S components/news_core/test/host -B /tmp/vt && cmake --build /tmp/vt
/tmp/vt/test_news_parse && /tmp/vt/test_news_mock && /tmp/vt/test_news_service \
  && /tmp/vt/test_api_json && /tmp/vt/test_palette && /tmp/vt/test_epd6_transpose \
  && /tmp/vt/test_fit && /tmp/vt/test_chart_scale

# 2) provisioning pure logic, and the reference producer against its committed fixture
sh components/provisioning/test/run.sh
python3 tools/mock_news_server.py --check

# 3) the real UI at the real resolution in six inks -> BMP/PNG, plus the layout,
#    glyph and colour assertions
cd sim && ./sim.sh          # NEWS_URL=http://localhost:8123/news.json ./sim.sh

# 4) firmware
idf.py build
```

The simulator is not a preview, it is a **test**: it fails the build on a missing glyph, on a rule
that does not land on its exact row, on ink outside the 30 px margin, on a band that rendered
nothing, on a label wider than its slot, on a masthead over 1140 px, and on blue or yellow reaching
the glass. Look at `sim/shots/*.png` after any UI change — they are drawn in the *measured* Spectra 6
inks rather than the saturated ones the UI draws with, so they can be judged as paper.

## Target hardware

| Item | Specification |
|------|------|
| Board | **Seeed XIAO ePaper Display Board** (the 13.3" carrier is the EE02; the display half is routed identically on the EE04 and EE05) + **XIAO ESP32-S3 Plus** |
| SoC | ESP32-S3 (Xtensa LX7 dual-core), 16 MB Flash / 8 MB Octal PSRAM |
| Display | 13.3" **Spectra 6** e-Paper, **portrait 1200 × 1600**, six inks, **two UC8179 controllers**, 4-wire SPI + two chip selects + one BUSY |
| Refresh | one kind, ~20–30 s, whole sheet flashes. **No partial waveform at all.** |
| RTC | **none** — the clock is SNTP only |
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

## The three things that make this board different

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

**3. The server decides what is important; the device decides what fits.** Stories arrive with a
`rank` and nothing about geometry. The device sorts stably and assigns tiers *by position* — first
is the lead, next two the secondary row, next three the briefs — so a payload numbered 10, 20, 30
works exactly as one numbered 0, 1, 2. Then it copyfits into the fixed bands. Under-supply promotes
rather than leaving a hole; a day with no stories at all prints the index ribbon at full size, which
is a legitimate quiet-day front page and not an error state.

## Project structure

```
main/                     app_main: panel + LVGL bring-up, provisioning, task launch
components/
  port_bsp/               the Spectra 6 port — the only code that talks to the panel
    epd6_panel.c          two UC8179s, two chip selects, one refresh, no partials
    epd6_transpose.h/.c   geometry + the framebuffer -> controller repack (host-testable)
  app_bsp/                LVGL port (RGB565 draw buffer, quantized in the flush callback)
  news_core/              the portable core — compiles identically on device, sim and host tests
    news_model.c          the snapshot struct + UTF-8-safe copy + content fingerprint
    news_parse.c          wire JSON -> model, clamping every field
    news_mock.c           the built-in demo front page (shown when no URL is set)
    news_service.c        one fetch: http_get + parse
    ui_news.c             page routing, the badge, the folio, the overlay
    ui_page_front.c       A1 — the eight bands
    ui_page_markets.c     A2 — the full watchlist, the indices, the leftover stories
    ui_fit.c              copyfitting: how much body text fits a box, cut at a word
    ui_chart.c            line / candle / bar / sparkline, integer scaling, hard pixels
    ui_tile.c             the one-entry photo cache
    ui_common.c           the shared shapes; ui_internal.h holds the grid and the bands
    wp_palette.c          the six inks and the ordered dither — the only quantizer
    device_api_json.c     the JSON the companion app receives
    fonts/                seven newspaper faces (OFL) — generated, do not hand-edit
    test/host/            the eight host tests
  provisioning/           SoftAP + captive portal + NVS + SNTP + /api/* onboarding
  device_api/             STA-mode HTTP/JSON control server + mDNS (wpnews.local)
  board_io/               battery ADC
  buttons/                KEY0/1/2 + BOOT edge events
app/                      React Native companion app — setup + control over the LAN
sim/                      desktop simulator — renders the real UI to 1200x1600 and asserts on it
third_party/cJSON/        vendored (ESP-IDF v6 dropped cJSON from core)
tools/
  mock_news_server.py     the contract from a fixed payload — the reference producer
  edition/                the real producer: an agent prompt, a shell driver, two launchd plists
  make_tile.py            a photograph -> a 4bpp tile the board blits verbatim
  gen_fonts.py            regenerates components/news_core/fonts/
  flash.sh                find the board and flash it
```

## Working rules

- **Every column span and every origin is EVEN.** A photo tile packs two pixels per byte, so a slot
  of odd width — or one starting at an odd x — cannot be blitted as a per-row `memcpy` and needs a
  nibble-shifting slow path on the device for no reason at all. The grid is six columns of 170 with a
  24 px gutter inside a 30 px margin (`6·170 + 5·24 = 1140`), and both of those numbers are even so
  that every span and every origin is. `ui_internal.h` has a `_Static_assert` on it; keep it true.
- **Colour is data, not decoration.** Green and red appear on percentage changes and their ▲▼ marks —
  the index ribbon, the portfolio rail, the quotation table — and nowhere else. Not on headlines, not
  on rules, not on a chart's axis. Blue and yellow never reach the glass from the UI at all; the
  simulator fails the build if they do. The only other colour on the sheet is a photo tile. Every one
  of the four colours used is an exact palette entry, so it takes `wp_quantize()`'s identity path and
  comes out flat — a colour between two inks dithers, and a dithered hairline is a dashed one.
- **Charts and marks are drawn with hard pixels**, through `ui_draw_line_c_abs()` / `ui_draw_tri_abs()`,
  never `lv_draw_line()` or `lv_draw_triangle()`. LVGL antialiases a diagonal, this panel has nothing
  between ink and paper for a blend to land on, and `wp_quantize565()` resolves the mid-greys a black
  stroke on white paper makes to **GREEN**. A chart drawn with `lv_draw_line()` is a black chart
  fringed with green speckle, in a band the colour policy does not allow colour in.
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
  Bodies are the opposite — `ui_fit_text()` cuts them at a word boundary, so write them long (lead
  600–740, secondary 260–330) and the column always fills. The full table is in the design spec §10.
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
  configuration, not a placeholder. `UiTask` puts it on the glass *before* the first poll rather than
  after it: on a panel this slow, a board that spends its first refresh on "Loading..." has spent
  twenty-five seconds saying nothing.
- **`sizeof(news_t)` is 19,780 bytes** — measured, not estimated. That is more than `UiTask`'s whole
  8 KB stack, so both the UI copy and the fetch buffer are file-scope statics, safe only because the
  single-owner rule holds: `UiTask` is the only caller of one and `NewsTask` of the other. Never put a
  snapshot on a frame.
- **`sdkconfig` holds per-developer values and is gitignored — never commit it.** Wi-Fi passwords live
  in NVS via the portal, never in Kconfig.
- The mDNS hostname is `wpnews` and the AP prefix `"WP News"` — deliberately **not** the
  `tickerboard` / `"Ticker Board"` of the project this forked from, whose shipped app resolves those
  names.
- If anything about the hardware is uncertain, don't guess — check
  [docs/references.md](docs/references.md).

## Documentation

- [docs/specs/2026-08-14-front-page-design.md](docs/specs/2026-08-14-front-page-design.md) — the design this was built from, and what was deliberately deferred
- [docs/bring-up.md](docs/bring-up.md) — first power-on: the boot log line by line, and the numbers to record
- [docs/news-contract.md](docs/news-contract.md) — the JSON the device polls, and how it fails
- [docs/pages.md](docs/pages.md) — A1 and A2, the grid, the bands, the font decision
- [docs/epaper-13in3.md](docs/epaper-13in3.md) — the dual-UC8179 driver, the refresh policy, the self-test
- [docs/graphics.md](docs/graphics.md) — six-ink rendering: the two palettes, the dither, the halftone
- [docs/pinout.md](docs/pinout.md) — GPIO assignments and the four traps
- [docs/board-hardware.md](docs/board-hardware.md) — hardware notes
- [docs/app-control.md](docs/app-control.md) — the companion-app HTTP/JSON contract
- [docs/simulator.md](docs/simulator.md) — the desktop simulator and what it asserts
- [docs/esp-idf-development.md](docs/esp-idf-development.md) — install / build / flash / menuconfig
- [docs/references.md](docs/references.md) — datasheets and upstream sources
