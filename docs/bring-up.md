# First power-on

What to do the first time this firmware meets this board, and how to read the boot log. Everything
here is written against hardware that has **not yet been powered on** — the firmware builds clean and
every layer that can be tested without a panel passes, but no line below has been observed on a real
board. Confirm each one as you go and correct this file where reality differs.

The point of the procedure is that the four things most likely to be wrong on a first boot — the
cable, the panel's power gate, the BUSY polarity, and the second chip select — produce *different*
symptoms, and three of them produce a different line in the log. None of them produces a crash. A
blank screen looks identical in all four cases, and on a panel that takes half a minute to say
anything at all, guessing costs a great deal of waiting.

## 1. Flash

```bash
. ~/esp/v5.4.3/esp-idf/export.sh    # once per shell
idf.py build
./tools/flash.sh                    # finds the port, flashes, opens the monitor
```

If `flash.sh` says no port appeared, find out **which** of the two failures it is before touching
anything, because they have nothing in common:

```bash
ls /dev/cu.*                 # is there a serial port?
ioreg -p IOUSB               # is there a USB device at all?
```

A healthy board shows a `/dev/cu.usbmodem*` (native USB Serial/JTAG) and a device hanging off one of
the `AppleT8132USBXHCI` controllers.

| `ioreg` shows | meaning |
|---|---|
| controllers only, no child devices | the host is not seeing a device. **A charge-only USB-C cable** is by far the most common cause — the data pairs are absent, so the Mac cannot tell it from an empty port, and the board powers up and the panel keeps whatever image was last refreshed onto it, so everything *looks* alive. Then: not plugged in, a dead hub port, or a dead board. |
| a device, but no `/dev/cu.*` for it | it enumerates but exposes no serial interface — usually stuck in download mode from a previous attempt, or a bridge chip whose driver is missing |

Swap the cable for one you have moved data over before doing anything else. If a device appears and
flashing still fails, force download mode: hold **BOOT**, tap **RESET**, release BOOT, retry.

## 2. Read the boot log in this order

Each line below is the checkpoint for one subsystem. They appear in this sequence; the first one
missing is where to stop and look.

### `board_io` — battery

```
I board_io: battery ADC on GPIO1 (unit 0 ch 0): 4.05V
I board_io: battery ADC on GPIO1 (unit 0 ch 0): 0.02V — no cell fitted, USB power
```

On USB with no cell, the second form is correct and expected. `adc calibration unavailable
(uncalibrated voltage only)` is a warning, not a fault — it means an uncalibrated voltage, which is
still enough to bring up a panel.

### `epd6` — the panel, and the three traps

This is the part that matters, and it is the part that takes a minute. `busy_line_probe()` runs once
after the init sequence and prints exactly one of three lines:

| line | meaning | what to do |
|---|---|---|
| `BUSY driven HIGH — both controllers idle, as expected` | both controllers are there and idle | continue |
| `BUSY follows the weak pulls — nothing is driving it. Panel not connected: check the FPC orientation and latch.` | nothing is on the other end of the FPC | reseat the cable — check orientation (contacts down) and that the latch is closed |
| `BUSY driven LOW after init — a controller still thinks it is busy. Wrong panel on the FPC, or CS1 (GPIO41) not wired?` | *something* is there, but it does not idle like a UC8179 | wrong panel on the connector, or the slave select is not reaching controller #2 |

The BUSY line is wired to **both** controllers, so it reads busy while *either* is busy. That is why
the third line names GPIO41: a slave that never got its initialisation is a slave that never releases
the line.

Then:

```
I epd6: Spectra 6 1200x1600 up (fb 960000 B in PSRAM, 19200 B DMA staging)
```

**`epd6_init()` does not refresh**, so nothing appears on the glass here and the boot moves straight
on — the panel keeps whatever image it was last left holding until the first page is ready to print.
That is deliberate: a refresh is twenty-five seconds, a boot is worth exactly one of them, and
clearing to white first spends two to show one page. It also means the first `I epd6: refresh` you
see belongs to a real page, further down.

The BUSY probe above still runs during bring-up, and so does the reset wait — a panel that never
releases the line reports `BUSY stuck low for 2000 ms` here. But the **60-second** one now belongs to
the first real page rather than to init. Wherever it appears, `BUSY stuck low for N ms — panel wired
and powered?` means the driver waited its full timeout and gave up rather than hanging. Two
candidates:

- **GPIO43 is not actually reaching the panel.** The rail is behind a load switch with a pulldown, so
  an unpowered panel is the default state and `epd6_init()` driving the pin HIGH is the only thing
  that changes it. If the pin is high at the header and the panel is still dark, the fault is in the
  carrier or the FPC, not in this code.
- **BUSY polarity is inverted for this panel revision.** Note carefully that this argues *against* it:
  inverted polarity makes every wait return **instantly**, not late. The symptom of a polarity mistake
  is a fast boot and a torn sheet — the driver writing its next command into a controller that is
  still mid-refresh — with nothing in the log at all. If the log is quiet and the glass is wrong,
  suspect polarity; if the log says `stuck low`, suspect power.

If PSRAM is missing or unconfigured, the panel layer says so before it says anything else:

```
E epd6: need 960000 B of PSRAM for the framebuffer; NNN B is free
E epd6: this firmware needs a XIAO ESP32-S3 *Plus* (8 MB octal PSRAM) with CONFIG_SPIRAM enabled
```

There is no configuration that makes this firmware fit without PSRAM. The framebuffer alone is
960,000 bytes and the S3's internal RAM is half that.

### `LvglPort` — memory

```
I LvglPort: LVGL 1200x1600, partial in 120-row strips (288000 B draw buffer)
I LvglPort: Install LVGL tick timer
```

288,000 B is `1200 × 120 × 2`: LVGL renders RGB565 into a 120-row strip and the flush callback
quantizes it into the framebuffer's six inks. The same `need … B of PSRAM` / `needs a XIAO
ESP32-S3 *Plus*` pair appears here if that allocation fails.

### `provisioning` — Wi-Fi

First boot has nothing stored:

```
I provisioning: no stored network — starting setup portal
I provisioning: setup portal ready — join Wi-Fi 'WP News-XXXX' and open http://192.168.4.1
```

The sheet should now show the setup overlay with that same SSID on it. **That is the first end-to-end
confirmation that the display works** — text you chose, rendered by LVGL, quantized, packed to two
controllers, and pushed through a full refresh. It arrives twenty-odd seconds after the log line, not
with it. If the log says the portal is ready and the glass is still white a minute later, the fault
is in the panel path, not in Wi-Fi.

Join that network from a phone or laptop, fill in the form, and expect:

```
I prov_wifi: got IP 192.168.x.x
I provisioning: restarting to apply confirmed configuration
```

It reboots. On the second boot: `stored network 'X' — attempting to connect`, then

```
I main: online — news URL '(none: demo snapshot)'
I buttons: ready: KEY0=GPIO2 KEY1=GPIO3 KEY2=GPIO5 BOOT=GPIO0
I app: controls: KEY0 = page, KEY1 = refresh, KEY2 = page 1 (5s hold = Wi-Fi setup)
```

and then **one** refresh — the whole boot spends exactly one, and which page gets it depends on
whether a URL is configured:

- **No URL.** The demo front page, immediately. A board with no URL configured is finished at this
  point: the demo snapshot is a complete front page, not a placeholder.
- **A URL.** `UiTask` holds the refresh open for up to fifteen seconds waiting for the first
  snapshot, so the real front page is what lands on the glass — the demo is never printed at all. If
  nothing arrives in time you get `W app: no snapshot within 15000 ms — printing the demo page` and
  the demo goes up instead, with the real one following on the next poll.

Between power-on and that refresh the glass keeps whatever it was last left holding. A board being
re-flashed therefore shows yesterday's front page for the twenty or so seconds before the new one
appears, which is correct and not a hang.

### `net_time`, `device_api` — online

```
I net_time: time synced
I device_api: control server up on port 80
I device_api: mDNS advertising http://wpnews.local
```

`sntp sync timeout` costs **only the dateline**, and only on a board whose payload did not spell one
itself — `ui_news_tick()` returns early when the snapshot carries its own, so on a normal edition an
unsynced clock reaches the glass nowhere at all. With no payload dateline and no clock, the slot
prints empty rather than 1970. Snapshot staleness is measured monotonically and is unaffected. From
here the board is reachable:

```bash
curl -s http://wpnews.local/api/info
```

If mDNS does not resolve — some routers and most corporate networks block it — use the IP from the
`got IP` line.

## 3. Run the self-test

```bash
curl -X POST http://wpnews.local/api/display/test
```

**Four refreshes at twenty to thirty seconds each: this blocks the UI task for about a minute and a
half.** It replies as soon as it is queued, not when it finishes. Watch the glass rather than the log.

| pattern | what it proves | how it fails |
|---|---|---|
| six colour bars — black, white, red, yellow, green, blue, left to right, 200 px each | the colour codes, and both chip selects | **the last three bars missing** — blank, or whatever the slave last held — means controller #2 (GPIO41) is not being written. That is the single most likely wiring fault on this board, and it is why the split falls exactly between red and yellow: master owns x 0…599, slave 600…1199, and a dead slave is 600 px of the right-hand side that never updates. Colours in the wrong order means the wire codes are wrong; a negative image means they are inverted. |
| 1 px checkerboard | the nibble order and every source line | a flat grey-looking field is right; solid bands mean a stuck line or a packing mistake a flat fill cannot show |
| border, both diagonals, and a solid **green block in the top-left** | that the last row and column are reachable, and **which corner the origin is** | green in the *bottom*-left means the output row order is reversed — reverse it in `epd6_pack_block()`, one line. The red diagonal runs top-left to bottom-right and carries the same answer redundantly, because this is the one observation that changes code. |
| white | leaves the panel clean | — |

The bars, the checkerboard and the border all survive a vertical flip unchanged. The green block and
the notch in the black bar are the only two things in the sweep that do not, and that is their entire
job.

## 4. Record the numbers

These are the measurements the firmware was deliberately built not to guess at.

```bash
curl -s http://wpnews.local/api/state | jq '.panel, .battery'
```

| number | where it comes from | what it decides |
|---|---|---|
| `panel.refreshMs` | `epd6_last_refresh_ms()`, also logged as `I epd6: refresh N ms` after every refresh | everything. The whole refresh policy — one refresh per changed snapshot, no refresh for a clock tick, no partial anything — is built on "twenty to thirty seconds", and that figure is Seeed's, not this board's. Write the real one down here. |
| the SPI push, separately | `idf.py monitor` with `esp_log_level_set("epd6", ESP_LOG_DEBUG)`: `D epd6: pushed 2 x 480000 B in N ms` | how much of the refresh is bus and how much is panel. 960,000 bytes at 10 MHz is about 0.8 s of wire; if the push is materially longer than that, the DMA staging path is worth looking at, and if it is not, the rest is the waveform and no amount of code will move it. |
| `battery.millivolts` against a multimeter on the cell | `BATT_DIVIDER` in `components/board_io/board_io.c` | that constant is 3.0 **from the documentation, never measured**. It fails quietly — a wrong ratio gives a percentage that looks entirely plausible and is wrong every time you glance at the panel. Scale it by the ratio between the two readings, then record here that it has been checked, and the question is closed. |

Record the origin answer from §3 too, even when it is "top-left, correct". It is the only fact in this
document that cannot be re-derived from the code.

## 5. Point it at a real edition

```bash
python3 tools/mock_news_server.py                    # the reference producer, on :8123
curl -X POST http://wpnews.local/api/news -d '{"url":"http://mymac.local:8123/news.json"}'
```

The `DEMO` badge should disappear on the next poll — or immediately, since setting the URL wakes the
poller. If it does not, `GET /api/state` reports `source.lastResult`, and the failure codes each send
you somewhere different: [news-contract.md](news-contract.md) has them,
[app-control.md](app-control.md) has the field.

For the real thing — an agent that researches one listed company and files an edition twice a day —
see `tools/edition/`.

## Buttons

| | |
|---|---|
| KEY0 | toggle A1 / A2 |
| KEY1 | poll now |
| KEY2 | tap → A1 · **hold 5 s → reboot into Wi-Fi setup** |
| BOOT | previous page |

Every one of these except KEY1 costs a full refresh, so expect to wait twenty to thirty seconds
before the sheet agrees that you pressed anything. KEY1 costs nothing at all unless the fetched
content actually differs from what is already on the glass.

The KEY2 hold is the escape hatch for a board stuck on a network that no longer exists. It keeps the
saved config so the portal pre-fills, and only the Wi-Fi needs re-entering.
