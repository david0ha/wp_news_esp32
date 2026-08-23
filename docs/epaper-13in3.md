# The 13.3" Spectra 6 panel (two UC8179s, 1200 × 1600, six inks)

Everything about how this board draws, and why the code is shaped the way it is.

## The panel

| | |
|---|---|
| Part | Seeed 13.3" Spectra 6 (T133A01), six inks |
| Controllers | **two UC8179**, one SPI bus, **two chip selects** |
| Geometry | native portrait **1200 × 1600** — the page is not rotated anywhere |
| Pitch | 150.4 dpi (2000 px diagonal over 13.3"), so the sheet is 202 × 270 mm — a little under A4 |
| Interface | 4-wire SPI + BUSY + RST, 24-pin FPC |
| Framebuffer | 600 B × 1600 = **960,000 B**, 4 bpp, two pixels per byte |
| Refresh | one kind, **20–30 s**, flashes the whole sheet. **No partial waveform.** |
| Carrier | Seeed XIAO ePaper Display Board + XIAO ESP32-S3 Plus |

1200 is even, so a framebuffer row is exactly 600 bytes with no padding, and the boundary between
the two controllers falls between bytes rather than inside one. That is the same simplification the
648-wide monochrome panel gave the driver this replaces, and it does more work here: it is what lets
the repack be a `memcpy` and a photo tile be blitted a row at a time (see
[docs/pages.md](pages.md) for the grid rule that keeps every span and origin even).

Six inks, four bits per pixel. `epd6_color_t` values **are** the wire codes, so the framebuffer
needs no translation on the way out and `epd6_pack_block()` can hand DMA a finished buffer.

## Two controllers, one bus, and why esp_lcd is not used

Each UC8179 drives half the sheet. TRES is set to 1200 × 800 on both
(`TRES_V = {0x04,0xB0,0x03,0x20}`), so a controller's own raster is 1200 px wide by 800 rows, and
two of them stacked make the panel's 1200 × 1600.

```
+---------------------+---------------------+
| MASTER   CS  GPIO44 | SLAVE   CS1  GPIO41 |
| fb x =      0..599  | fb x =   600..1199  |   1600 px tall
|                     |                     |
+---------------------+---------------------+
                1200 px wide
```

`components/port_bsp/epd6_panel.c` talks to `spi_master` directly, with `spics_io_num = -1`, and
drives CS/DC as plain GPIOs. That is not a shortcut around esp_lcd; esp_lcd cannot express what this
panel needs. Its panel-IO layer owns exactly one chip select and queues transactions
asynchronously, and the init sequence contains commands that **both** controllers must receive —
which means both CS lines low at the same instant. Every transfer in the driver is blocking, so CS
timing is exactly what the code says it is rather than whatever a queue drained to.

The whole of the dual-controller protocol is one convention, taken from Seeed's
`writecommanddata()`:

```c
static void wr(uint8_t cmd, const uint8_t *data, size_t len);      /* toggles CS (master) */
static void wr_both(uint8_t cmd, const uint8_t *data, size_t len); /* CS1 low across it   */
```

`wr()` toggles the master's select around one command and its parameters. The slave's select is the
caller's business: hold it low and both controllers hear the command, leave it high and only the
master does. Which registers go to which is the part of the sequence that cannot be guessed, so the
vendor's toggles are transcribed rather than tidied.

**GPIO41 is the second chip select, and it appears in no Seeed document this project could find.**
It comes from [`acegallagher/esphome-bigink`](https://github.com/acegallagher/esphome-bigink)
(`bigink.yaml:278`), the only published source that drives this panel without Seeed's cloud tooling.
If the right-hand half of the sheet stays blank while the left half is correct, that pin is the
first thing to check.

## Where the register values come from

The command sequences are transcribed from Seeed's own driver for this exact panel,
[`Seeed-Studio/Seeed_GFX`](https://github.com/Seeed-Studio/Seeed_GFX) —
`TFT_Drivers/T133A01_Defines.h`, `EPD_INIT()` / `EPD_PUSH_NEW_COLORS()` / `EPD_UPDATE()`, with the
reset timing from `T133A01_Init.h`. Deviations are marked `NOTE:` in the source, and there are four.

Not from the datasheet, deliberately, for the same reason as on the 5.83": the UC8179 datasheet
documents the registers but not the power-up ordering or the settle delays, and those are the parts
that fail intermittently rather than obviously.

`bigink`'s register values differ from Seeed's in three places, and it omits the DC-DC setting
entirely — a difference its author does not claim to have reasoned about ("I won't pretend to really
know what I'm doing", `HARDWARE.md`). Seeed's are the default because they are the panel vendor's own
table. The alternative is `WP_EPD6_BIGINK_TUNING`, a bare `#ifndef` in `epd6_panel.c` defaulting to
0, which swaps `R74_V`, `BTST_P_V` and `BTST_N_V` for bigink's and changes nothing else. There is no
Kconfig entry behind it; turning it on is one line in `components/port_bsp/CMakeLists.txt`:

```cmake
target_compile_definitions(${COMPONENT_LIB} PRIVATE WP_EPD6_BIGINK_TUNING=1)
```

Reach for it if the panel comes up faint, ghosted, or with visible banding at the far end of the
source lines. Those are booster-drive symptoms, and BTST is the register that would cause them.

The command set in use — the values are in the sequence below:

| Cmd | Name | Use |
|---|---|---|
| `0x00` | Panel setting | two bytes here, not the 5.83"'s one |
| `0x01` | Power setting | the rail voltages |
| `0x02` | Power off | ends every refresh |
| `0x04` | Power on | before the refresh trigger |
| `0x05` / `0x06` | Booster soft start, negative / positive | **bigink differs** |
| `0x07` | Deep sleep | payload `A5` |
| `0x10` | Data transmission | where the framebuffer goes, one plane at a time |
| `0x12` | Display refresh | the actual update trigger |
| `0x50` | VCOM / data interval | |
| `0x61` | Resolution | `1200 × 800` — per controller, not per panel |
| `0xA5` | DC-DC | **bigink omits it** |
| `0xE0` | Cascade set | the two-controller mode, sent immediately before the planes |
| `0xE3` | Power saving | |
| `0x60` `0x74` `0x86` `0xB0` `0xB1` `0xB6` `0xB7` `0xF0` | unnamed in the UC8179 datasheet | vendor table; `0x74` is the third value **bigink differs** on |

## A refresh, command by command

`epd6_refresh()` is the only way anything reaches the glass. It runs the whole sequence every time —
power up, re-initialise, push both planes, refresh, sleep, power down. `epd6_init()` ends by calling
it once, so bring-up costs a refresh and lands on a known-clean white sheet rather than on whatever
the last power cycle left.

```
power_on()         GPIO43 HIGH, 100 ms for the rail to settle

panel_init()       RST low 20 ms, high 20 ms, wait BUSY (cap 2 s)
  0x74             master     00 0C 0C D9 DD DD 15 15 55
  0xF0             both       49 55 13 5D 05 10
  0x00  PSR        both       DF 69
  0xA5  DC-DC      master     44 54 00
  0x50  CDI        both       37
  0x60             both       03 03
  0x86             both       10
  0xE3  PWS        both       22
  0x61  TRES       both       04 B0 03 20      = 1200 x 800
  0x01  PWR        master     0F 00 28 2C 28 38
  0xB6             master     07
  0x06  BTST+      master     E0 20
  0xB7             master     01
  0x05  BTST-      master     E0 20
  0xB0             master     01
  0xB1             master     02
                              (10 ms after each, and before 0xF0 as well;
                               0x74 alone has neither)

push_frame()
  0xE0  CCSET      both       01, then wait BUSY (cap 5 s), 10 ms
  0x10  DTM        master     480,000 B, in 25 blocks of 64 output rows
  0x10  DTM        slave      480,000 B, the same way

update_panel()
  0x04  PON        both       wait BUSY (cap 5 s), release CS1, 30 ms
  0x12  DRF        both       01, wait BUSY (cap 60 s)  <- the twenty to thirty seconds
  0x02  POF        both       00, wait BUSY (cap 5 s), release CS1, 30 ms

  0x07  sleep      both       A5, no wait
power_off()        GPIO43 LOW
```

Every step of `update_panel()` holds the slave select low across the command **and** its BUSY wait,
then releases it with a 30 ms settle. That pairing is load-bearing rather than decoration: the wait
has to observe both controllers, and a wait that samples with only the master selected will return
while the slave is still driving.

Re-initialising on every refresh is this port's, not Seeed's. bigink gets away without it because it
deep-sleeps the ESP32 between updates and so re-runs `setup()`; this board stays awake serving a
control API, so the rail it switched off at the end of the last refresh has to be brought back here.

The deviations from the vendor sequence, and what each one prevents:

- **`wait_busy()` gives up.** Seeed spins forever. A stuck BUSY means the panel is not wired or not
  powered, and hanging the UI task on that is worse than carrying on with a warning. The caps are
  2 s after reset, 5 s around power, 60 s around the refresh — 60 because the controller holds BUSY
  low for the entire twenty to thirty seconds, so a timeout there means "the panel is not there",
  not "the panel is slow".
- **No `0x71` GET STATUS before each BUSY sample.** The 5.83" driver pokes it, because Waveshare's
  UC8179 code does. Seeed's driver for *this* panel reads the pin alone, and a `0x71` issued while
  the slave select is low would reach both controllers at once. Follow Seeed here.
- **No `COLOR_GET()` on the way out.** Seeed converts every nibble as it streams. This port stores
  the hardware codes in the framebuffer to begin with, which is also why the pack can be a straight
  copy into a DMA buffer.
- **Deep sleep goes to both controllers, and is not waited on.** Seeed sends it to the master only
  and then waits BUSY. One controller left awake keeps driving; and a controller that has accepted
  deep sleep may never raise BUSY again, with nothing after it to protect.

The reset timing is not a deviation but a choice between the two upstreams: **20 ms each way**, from
`T133A01_Init.h`, where bigink uses 10. The vendor's is longer and costs 20 ms once per refresh,
against a refresh of thirty seconds.

At 10 MHz, 960,000 bytes take 0.77 s to clock out. That is under a second against a refresh of
thirty, which is why `BLOCK_ROWS` is 64 and not something larger: 64 × 300 = 19,200 bytes of
internal DMA-capable RAM and 25 transfers per controller, and a bigger staging block buys nothing
measurable while taking internal RAM the Wi-Fi stack wants.

## The framebuffer, and the repack that is a memcpy

`components/port_bsp/epd6_transpose.h` owns the geometry; `epd6_transpose.c` is a bounds clamp and a
loop of `memcpy`. The header is deliberately free of ESP-IDF, because this is the one piece of the
port that cannot be checked by looking at it, and it has to compile on the host so a test can prove
it byte for byte.

```
byte  = fb[y * 600 + x/2]
pixel = (x & 1) ? (byte & 0x0F) : (byte >> 4)

EPD6_FB_STRIDE   600      EPD6_OUT_ROWS    1600
EPD6_FB_SIZE  960000      EPD6_OUT_STRIDE   300      EPD6_PLANE_BYTES 480000
```

The pack works in units of one **output row** — half a framebuffer row, 300 bytes, 1600 of them per
plane — because that is the unit the copy is contiguous in. A controller's own wire row is 1200 px,
so it is two output rows from two adjacent framebuffer rows, and 800 wire rows consume all 1600.
The stream is the same either way, and 1600 × 300 is still the 480,000 bytes per controller that
TRES asks for.

### The derivation, in full

An earlier revision presented this panel as landscape 1600 × 1200 and rotated while packing. Going
portrait **removed** that rotation rather than replacing it. The reversal is only visible in the
landscape form, so the move was done by substituting into it rather than by re-deriving anything.
This working is the entire proof that the physical image does not come out upside down, and a future
reader has to be able to re-check it:

```
landscape:  out[plane][r][b]  =  fb_L(x = 1599 - r,  y = 600*plane + 2b)   << 4
                              |  fb_L(x = 1599 - r,  y = 600*plane + 2b+1)

portrait:   fb_P(px, py)      := fb_L(1599 - py, px)
            equivalently         fb_L(x, y) = fb_P(px = y, py = 1599 - x)

substitute: out[plane][r][b]  =  fb_P(px = 600*plane + 2b,   py = r) << 4
                              |  fb_P(px = 600*plane + 2b+1, py = r)

and since fb_P puts even px in the high nibble of byte px/2, those two pixels are
the two nibbles of one byte, already in the order the wire wants:

            out[plane][r][*]  =  memcpy(fb_P + r*600 + plane*300, 300)
```

Every byte that reaches the glass is the byte that reached it before, so the physical image cannot
have flipped. The reversal did not go away — it was absorbed into which pixel we agree to call
`(px, py)`. What is left is the arrangement Seeed's own push uses: a portrait buffer split
left/right with no transpose at all, which is a second source arriving at the same bytes.

Two consequences worth stating plainly. `EPD6_OUT_ROWS` and `EPD6_OUT_STRIDE` did not change, so
the SPI side and the register tables were untouched by the turn to portrait. And **the plane split
moved from rows to columns**: master is x 0..599, slave is x 600..1199, so a dead slave is now the
**right half of the sheet** blank, where on the landscape port it was the bottom half.

The old loop walked the framebuffer in row pairs rather than in output order, because output-order
reads sat 800 bytes apart and would have taken a PSRAM cache miss 960,000 times per refresh.
Portrait makes each output row a contiguous 300-byte half of one framebuffer row, which is the
access pattern `memcpy` is already the best available implementation of.

`epd6_pack_block()` clamps its row range rather than trusting the caller, even though `push_plane()`
already bounds every call. The landscape version failed an out-of-range block by computing a
negative x and reading somewhere harmless; the collapse to `memcpy` turns the same mistake into a
straight linear overrun past the end of a 960,000-byte buffer. Two comparisons is a cheap trade
against that.

### The test carries two independent references, and neither copies anything

A wrong pack still compiles, still boots, still spends thirty seconds refreshing, and produces a
panel full of confetti with nothing in the log. There is no way to eyeball it and no way to test it
on the device. And a collapse to `memcpy` is precisely the shape of change a test written against
production would wave through. So `components/news_core/test/host/test_epd6_transpose.c` holds:

- **`ref_substituted()`** — the portrait mapping as the derivation states it, one pixel at a time,
  with the sizes spelled out as literals rather than read from the header. A reference that takes
  its geometry from the thing it is checking cannot catch a mistake in that geometry, which is
  exactly the mistake turning the panel makes available.
- **`ref_legacy()`** — bigink's original transposing loop
  (`seeed_epaper_spectra6.cpp:562-577` master, `:594-609` slave), verbatim, fed a **reconstructed
  landscape framebuffer** built through `fb_L(x, y) = fb_P(px = y, py = 1599 - x)`.

The second is the load-bearing one. This panel's byte order was established against a landscape
buffer and a transpose; running the old loop over the old buffer is what *checks* the substitution
instead of trusting it. If the two references disagree, the derivation above is wrong and the page
reaches the glass flipped — with, again, nothing in the log.

On top of that: block-size invariance (1, 7, 64 and 1600 rows must give identical output, into a
buffer poisoned with `0xAA` so an unwritten byte shows up), the four corners worked out by hand so a
shared sign error between derivation and transcription would still be caught, the plane boundary at
columns 599/600, and the geometry constants themselves.

```bash
cmake -S components/news_core/test/host -B /tmp/vt && cmake --build /tmp/vt
/tmp/vt/test_epd6_transpose        # epd6_transpose: 60 checks, 0 failures
```

**It was mutation-tested.** Reversing the output row order, swapping the two planes, and breaking
the substitution by one row were each applied to `epd6_pack_block()` in turn; each makes the suite
fail and exit non-zero. A test whose failure mode has never been observed is a test that has not
been run.

## The colour codes

```c
EPD6_BLACK = 0x00   EPD6_WHITE = 0x01   EPD6_YELLOW = 0x02
EPD6_RED   = 0x03   EPD6_BLUE  = 0x05   EPD6_GREEN  = 0x06
```

`0x04` and `0x07..0x0F` are not colours this panel makes, and nothing may reach the framebuffer that
is not one of the six. They live in `epd6_transpose.h` rather than `epd6_panel.h` because they are
part of the framebuffer *format*: the quantizer, the simulator and the host tests all need them, and
none of those can include an ESP-IDF header.

**Do not take these from esphome-bigink.** Within that one repository the `Spectra6Color` enum, the
`HARDWARE.md` table, the explanatory comment and the executing code all disagree with each other —
four sources, four answers. These come from Seeed instead: `TFT_eSPI.h:317-323` defines the palette
their driver is fed (`TFT_BLACK 0x0F`, `TFT_WHITE 0x00`, `TFT_BLUE 0x0D`, `TFT_YELLOW 0x0B`,
`TFT_GREEN 0x02`, `TFT_RED 0x06`), and `T133A01_Defines.h:231-239`'s `COLOR_GET()` maps each of those
to the codes above. This agrees with bigink's `color_to_spectra6_()`, which is the one part of that
file that was right, and with its `memset(buffer, 0x11)` meaning white.

Getting them backwards costs nothing at build time and produces a panel in photographic negative
after a thirty-second refresh.

What the UI is allowed to put in the framebuffer is a separate question with a much narrower answer:
colour appears in exactly two places on the page, and blue and yellow never reach the glass from the
UI at all. That rule and its reasoning are in [docs/pages.md](pages.md).

## Three traps

### BUSY is active LOW

The panel is idle when the pin reads **HIGH**. This is the inverse of the SSD1680 this driver's
ancestry started from, and getting it backwards does not produce an error — it makes every wait
return instantly, so the driver writes the next command into a controller that is still mid-refresh
and the sheet comes out torn or blank. There is nothing in a log to suggest why. `wait_busy()`
delays first and then samples, following Seeed's `CHECK_BUSY()`.

### GPIO43 gates the panel's power

It is a load switch feeding the panel's 3.3 V, pulled down, so the panel is unpowered until it is
driven HIGH. `epd6_init()` does it, and `epd6_refresh()` does it again on every refresh because the
previous refresh switched it off.

### GPIO43/44 are the default UART0 pins

GPIO44 is the master chip select and GPIO43 is that power enable, so the console must stay on USB
Serial/JTAG (`sdkconfig.defaults`, `ESP_CONSOLE_USB_SERIAL_JTAG`). A UART0 console would clock log
bytes straight into the panel's power-enable and CS lines.

`busy_line_probe()` runs once at init and tells apart the three failures that all look like a dead
screen — FPC not seated (BUSY follows the weak pulls, so nothing is driving it), panel present and
idle (driven HIGH), panel present but not idling the way a UC8179 does (driven LOW after init, which
usually means CS1 is not wired). See [docs/pinout.md](pinout.md) and [docs/bring-up.md](bring-up.md).

## A refresh is not free

This is the constraint the whole application is arranged around, and Spectra 6 charges far more for
it than the 5.83" did. That panel had two prices — a full refresh in seconds, and a windowed partial
that was under a second and silent — so its refresh policy was mostly a question of which to spend.

**This panel has no partial waveform at any size.** One refresh, twenty to thirty seconds, and it
flashes the whole sheet. Every partial-update entry point from the 5.83" driver is **gone rather
than stubbed**, so a caller that wanted one fails to compile instead of quietly spending half a
minute. There is no `epd6_refresh_partial_area()` to find.

So drawing and presenting are separate everywhere:

```c
...update widgets...      /* ui_news_set_*(), cheap, no panel traffic */
Lvgl_RenderNow();         /* synchronous render -> flush_cb -> framebuffer */
epd6_refresh();           /* twenty to thirty seconds. Not free. */
```

`Lvgl_FlushCallback()` in `main/main.cpp` quantizes RGB565 into the panel's six inks through
`wp_quantize565()` and **never** refreshes the panel. Exactly one task — `UiTask` in
`components/user_app/user_app.cpp` — touches LVGL or starts a refresh; buttons, the HTTP API and the
news poller all post a command and return, so a stalled HTTP request cannot hold up a refresh and a
refresh cannot be interleaved with another.

In `user_app.cpp` the only place `epd6_refresh()` is called from is `present_full()`, and nothing in
that file calls it on a timer. The reasons a refresh happens are: new data whose fingerprint differs,
a page change, the self-test, boot, and — from `main.cpp`'s `SetStatus()`, before `UiTask` exists —
each provisioning state the portal reports.

**The clock does not get its own refresh.** The 5.83" board pushed the header out every five minutes
with a windowed partial, which was silent and cost a fraction of a second. Here the same policy would
be a hundred and twenty full-sheet flashes a day at nobody. `UiTask` still wakes every
`TICK_SECONDS` (60) to move the clock and the battery reading on **in the framebuffer**, and they
ride out with the next refresh that has a reason of its own. A front page carries a date, not a
ticking clock.

The snapshot copies that cross between those tasks are static buffers rather than stack frames:
`sizeof(news_t)` is **19,780 bytes**, against `UiTask`'s 8 KB stack and `NewsTask`'s 16 KB. An
automatic would not overflow those stacks, it would never fit on them. A static is safe here
precisely because of the rule above — each of the two buffers has exactly one task that touches it.

### Reading the refresh time off the board

Twenty to thirty seconds is the vendor's figure and this project's expectation, not a measurement of
this board. `epd6_last_refresh_ms()` reports what the last refresh actually took. It is logged at
every refresh and served over the network, so the number can be read off a phone rather than by
holding a serial cable to a board on a shelf:

```bash
curl -s http://claudepost.local/api/state | jq .panel
# {"refreshMs": 26314}
```

There is no policy left to tune with it. The 5.83" had two refresh modes and a table in its
documentation for deciding between them; here there is one mode, and the poll interval is set by how
often the data changes rather than by the panel. What the number is for is comparison: record it at
bring-up ([docs/bring-up.md](bring-up.md)), and a later firmware whose refresh has moved by seconds
has changed something in the sequence above, which is otherwise invisible.

### A poll that changes nothing must not touch the panel

`news_hash()` fingerprints everything that reaches the glass — the edition line, every index cell,
every story's headline, deck, body and byline, the chart span and every individual bar, and the
photo ids and their dimensions — and `NewsTask` compares before it notifies `UiTask`:

```c
uint32_t h = news_hash(&s_fetched);
bool changed = (h != s_data_hash);
...
if (changed) { notify_ui(APP_CMD_DATA); }
else         { /* the most common outcome, and it must cost nothing */ }
```

On a device that polls every five minutes forever, this is the difference between a front page
hanging quietly in its frame and one that flashes at nobody all day. A fingerprint that is too
narrow does not fail loudly; it shows yesterday's page forever, and nobody notices until they read a
stale number off it. That is why the photo id is in there — two snapshots that differ only in which
photograph the lead carries must not agree.

### The panel is powered down between refreshes

On the 5.83" that was forbidden: cutting the rail would drop the previous-image plane that partial
updates diff against. With no partial updates there is nothing to preserve, so `epd6_refresh()` ends
with deep sleep to both controllers and `power_off()`. That stops the audible buzz from the charge
pump, which on a board meant to hang on a wall in a quiet room is not a small thing.

## Memory, and why LVGL renders in strips

| | |
|---|---|
| Panel framebuffer | 960,000 B, PSRAM (`MALLOC_CAP_SPIRAM`) |
| DMA staging block | 19,200 B, internal (`MALLOC_CAP_DMA \| MALLOC_CAP_INTERNAL`) |
| LVGL draw buffer | 288,000 B (1200 × 120 × RGB565), PSRAM, single |

The 5.83" board rendered the whole screen into two RGB565 buffers and handed the flush callback one
finished frame. That does not survive the move to 1200 × 1600: a full-screen RGB565 buffer is
3,840,000 B, two of them 7,680,000 B, and the panel's own 4 bpp framebuffer already wants 960,000 B
of the 8 MB fitted. It does not fit, and no amount of care makes it fit.

So `LVGL_STRIP_H` is 120 and LVGL renders in horizontal strips: 1200 × 120 × 2 = 288,000 B, and the
screen arrives as fourteen of them, the last 40 rows deep. The strip height is a memory budget, not
a tiling. A second buffer would buy nothing — the flush callback is a synchronous CPU quantize into
the panel framebuffer and returns having already finished, so there is never a transfer in flight
for it to overlap with.

Two things follow from partial rendering that are easy to get wrong:

- **The dither is positional.** `wp_quantize565()` takes screen coordinates, not offsets within the
  strip. Pass the wrong ones and the Bayer pattern seams at every strip boundary.
- **LVGL only redraws what it believes changed**, and that belief is wrong the moment anything writes
  to the panel framebuffer behind its back — which the self-test patterns do. `Lvgl_InvalidateAll()`
  exists for exactly that; without it the screen keeps fragments of a test pattern until every widget
  happens to change on its own.

Keeping LVGL on RGB565 rather than an indexed format is what buys every widget, font and shape
working exactly as it does in the desktop simulator, which runs the same `wp_quantize565()` into a
real `epd6` framebuffer — which is what makes the simulator's screenshots a test rather than an
approximation. See [docs/simulator.md](simulator.md) and [docs/graphics.md](graphics.md).

The panel framebuffer is 960,000 B in PSRAM and not in internal RAM, which is not an optimisation:
the S3's internal RAM is about half that size. The staging block is the part that has to be internal
and DMA-capable, and it is 19,200 B.

Both PSRAM allocations say how many bytes they wanted and how many were free before they give up —
the framebuffer returns `ESP_ERR_NO_MEM`, the draw buffer asserts after logging. "No PSRAM fitted"
and "PSRAM not configured" are the two ways a board that looks identical to a working one refuses to
boot, both need a XIAO ESP32-S3 **Plus** with `CONFIG_SPIRAM` on, and the difference between naming
that and a bare `assert(buffer)` is an afternoon.

## Self-test

`epd6_selftest()` — also `POST /api/display/test` — cycles four patterns, each with its own refresh.
That is four full refreshes, roughly a hundred seconds, so it blocks: it runs on the UI task and the
HTTP handler only enqueues it.

Each pattern answers a question the others cannot.

- **Six colour bars**, 200 px each, black · white · red · yellow · green · blue, left to right.
  Proves the colour codes are right. And because the plane split runs down the middle of the sheet,
  it proves both controllers received their own half with no ambiguity about which: black, white and
  red are the master's, yellow, green and blue the slave's. **A dead slave is the right half of the
  sheet blank.** That reading is immune to row-order handedness — a reversal trades top for bottom
  and leaves left and right where they are — which is exactly why the origin question is settled by a
  different pattern. A white notch near the top of the black bar is the one thing here that a
  vertical flip would move.
- **1 px checkerboard.** Catches a stuck source line or a nibble-order mistake, neither of which a
  flat fill can show.
- **Border, both diagonals, and a solid green block in the TOP-LEFT.** Proves the last row and column
  are reachable, and settles the only question the whole stack has no other answer to: whether the
  page came out upside down. Nothing between the framebuffer and the glass has a handedness except
  the order the output rows go out in, and a reversal there is a vertical flip. The bars survive one;
  the checkerboard survives one; a border survives one. **This block does not.** Green in the
  top-left is right; green in the bottom-left means reverse the output row order in
  `epd6_pack_block()`, which is a one-line change. The diagonals carry the same answer redundantly —
  red runs top-left to bottom-right, blue the other way — because the answer decides whether to
  change code, and one indicator that could be misread is not enough to change code on. Each element
  is a different colour so a mis-wired chip select shows up as a colour and not just as a gap.
- **White**, to finish on and to leave the panel clean.

Afterwards the application calls `Lvgl_InvalidateAll()` and one `present_full()`, because the
patterns wrote straight into the framebuffer behind LVGL's back.
