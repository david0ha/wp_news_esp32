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
. "$(ls -d ~/esp/esp-idf ~/esp/v*/esp-idf 2>/dev/null | head -1)/export.sh"   # once per shell
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

> **Deep sleep does not change any of this, and the first person to flash this firmware needs to know
> that before they go looking for a bug.** The board does not sleep with a USB console attached, and
> it does not sleep with no cell fitted — either one alone is enough. During bring-up you have a cable
> in your hand and quite possibly no battery on the JST connector, so **both** gates are closed and
> the log below is exactly what you will see, in full, every boot. On top of that the feature is off
> at build time unless you turn it on. Nothing is broken; a bench is the one place this board is
> deliberately never allowed to sleep. [§6](#6-deep-sleep-during-bring-up) is how to actually see it
> work.

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
I provisioning: setup portal ready — join Wi-Fi 'Claude Post-XXXX' and open http://192.168.4.1
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
  nothing arrives in time you get `W app: no snapshot within 15000 ms — printing the demo page`, and
  if the desk refuses the connection outright you get `W app: the first fetch of this boot failed —
  printing the demo page` a few seconds sooner: a refused connect fails in milliseconds, so the four
  fast retries are spent at about twelve seconds and `NewsTask` says so rather than letting the
  stopwatch run out. Either way the demo goes up, with the real one following on the next poll.

Between power-on and that refresh the glass keeps whatever it was last left holding. A board being
re-flashed therefore shows yesterday's front page for the twenty or so seconds before the new one
appears, which is correct and not a hang.

### `net_time`, `device_api` — online

```
I net_time: time synced
I device_api: control server up on port 80
I device_api: mDNS advertising http://claudepost.local
```

`sntp sync timeout` costs **only the dateline**, and only on a board whose payload did not spell one
itself — `ui_news_tick()` returns early when the snapshot carries its own, so on a normal edition an
unsynced clock reaches the glass nowhere at all. With no payload dateline and no clock, the slot
prints empty rather than 1970. Snapshot staleness is measured monotonically and is unaffected. From
here the board is reachable:

```bash
curl -s http://claudepost.local/api/info
```

If mDNS does not resolve — some routers and most corporate networks block it — use the IP from the
`got IP` line.

## 3. Run the self-test

```bash
curl -X POST http://claudepost.local/api/display/test
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
curl -s http://claudepost.local/api/state | jq '.panel, .battery, .power'
```

| number | where it comes from | what it decides |
|---|---|---|
| `panel.refreshMs` | `epd6_last_refresh_ms()`, also logged as `I epd6: refresh N ms` after every refresh | everything. The whole refresh policy — one refresh per changed snapshot, no refresh for a clock tick, no partial anything — is built on "twenty to thirty seconds", and that figure is Seeed's, not this board's. Write the real one down here. |
| the SPI push, separately | `idf.py monitor` with `esp_log_level_set("epd6", ESP_LOG_DEBUG)`: `D epd6: pushed 2 x 480000 B in N ms` | how much of the refresh is bus and how much is panel. 960,000 bytes at 10 MHz is about 0.8 s of wire; if the push is materially longer than that, the DMA staging path is worth looking at, and if it is not, the rest is the waveform and no amount of code will move it. |
| `battery.millivolts` against a multimeter on the cell | `BATT_DIVIDER` in `components/board_io/board_io.c` | that constant is 3.0 **from the documentation, never measured**. It fails quietly — a wrong ratio gives a percentage that looks entirely plausible and is wrong every time you glance at the panel. Scale it by the ratio between the two readings, then record here that it has been checked, and the question is closed. |
| `power.meanAwakeMs` | `GET /api/state`, after the board has slept — see [§6](#6-deep-sleep-during-bring-up) | how long a wake actually costs. The design assumes a quiet wake is about three seconds, almost all of it the Wi-Fi connect, and three seconds against fifteen minutes is what makes the whole feature work. If it comes back at eight, the awake term is nearly three times what the table assumed and the interval wants lengthening. This is a **measurement**, taken by the board about itself: `awake_ms_total / wakes`. |
| deep-sleep current, by subtraction | `power.estMahPerDay` and `battery.percent`, a day apart | the other unmeasured term, and the only one here that is arithmetic rather than a reading. Leave the board on a cell for a day, turn the drop in `battery.percent` into mAh against the cell's rated capacity (1% of a 4200 mAh cell is 42 mAh, so this is coarse — give it two days if the numbers are close), subtract `power.estMahPerDay` and 2.3 mAh for each refresh it printed, and what remains is the standing draw. Nobody knows this number: the XIAO is specified at 14 µA, published reports run from 9 µA to several hundred, and the carrier's own load switches add an unpublished amount. The design's §10 works it through — at 300 µA instead of 40, the 15-minute row goes from 16–22 mAh/day to 22–29, which is roughly a quarter off the life of the cell. A meter in series with the cell answers the same question directly and in a minute rather than a day; [§6](#6-deep-sleep-during-bring-up) has that version, and the reason the figure is a few µA higher than the datasheet's: the RTC peripheral domain is kept powered so the buttons hold their pull-ups while the board sleeps. |

**`power.estMahPerDay` is the awake-time term only.** It is `wakes/day × meanAwakeMs × 23 µAh/s`, and
it carries neither the refreshes nor the standing sleep current — the second precisely because
nobody has measured it, which is what the row above is for. Subtracting a number that already
contained a guess at the thing you are trying to find would tell you only what you assumed. The
23 µAh per awake second is itself measured, and it is pinned by a test in `test_api_json` so it
cannot drift quietly.

The rest of the `power` object is counters rather than conclusions: `wakes`, `quietWakes` (the ones
that cost no refresh — on a healthy board this should be nearly all of them), `sleepSeconds` for the
interval this board will actually sleep for, `sleepSource` for which of the desk, the app, NVS or the
build decided it, and `deepSleep` for whether the feature is on at all. The counters are lost on a
power-on reset, because they live in RTC memory; a day's worth means a day without unplugging it.

Record the origin answer from §3 too, even when it is "top-left, correct". It is the only fact in this
document that cannot be re-derived from the code.

## 5. Point it at a real edition

```bash
python3 tools/mock_news_server.py                    # the reference producer, on :8123
curl -X POST http://claudepost.local/api/news -d '{"url":"http://mymac.local:8123/news.json"}'
```

The `DEMO` badge should disappear on the next poll — or immediately, since setting the URL wakes the
poller. If it does not, `GET /api/state` reports `source.lastResult`, and the failure codes each send
you somewhere different: [news-contract.md](news-contract.md) has them,
[app-control.md](app-control.md) has the field.

For the real thing — an agent that researches one listed company and files an edition twice a day —
see `agent/standalone/`.

## 6. Deep sleep during bring-up

**It is on, and it still will not sleep while you are standing there.** `CONFIG_CLAUDEPOST_DEEP_SLEEP`
now defaults to **y** — the feature the board exists for should not need finding in a menu, and a
frame that runs flat in two days until somebody finds it is the worse default. What makes that safe
is that the switch is not what decides:

```bash
idf.py menuconfig     # Claude Post power -> Sleep between polls (battery mode)
```

`sdkconfig` is gitignored and per-developer, and a value recorded in it outranks a Kconfig default
forever: `# CONFIG_CLAUDEPOST_DEEP_SLEEP is not set` is an explicit **n** to kconfiglib, not an
absence, so a tree that built this branch before the default flipped keeps deep sleep off through
every `idf.py build` and every `idf.py reconfigure`. Turn it on in `idf.py menuconfig`, or delete
`sdkconfig` and let the next build write it again from the defaults. A tree that predates the
`CLAUDEPOST_*` rename this branch also carries has no line for the symbol at all, and picks the new
default up on its own.

Three runtime gates disable sleep whatever the build says, and a board at a bench trips at least one
of them permanently:

| gate | why | what it means at a bench |
|---|---|---|
| a USB console is attached | `usb_serial_jtag_is_connected()` is the best available answer to "is a developer watching", and a board that sleeps in the middle of `idf.py monitor` is a board nobody can debug | **the cable in your hand is enough on its own** |
| no cell fitted | there is no battery to save, and sleeping on USB power buys nothing | a board with nothing on the JST connector never sleeps |
| no news URL configured | a board that wakes every fifteen minutes to fetch nothing | a fresh board on the demo snapshot never sleeps |

So the whole of §2 above reads exactly as it always did, and that is the intended asymmetry: this
changes nothing on a bench and everything on a wall.

**The bench procedure, then, is mostly about getting out of the way.** To watch a board sleep you
need a charged cell on the JST connector with its slide switch ON, a URL set, and the USB cable
**out** — `idf.py monitor` is not merely unhelpful here, it is one of the three gates: attaching it
is what keeps the board awake, and detaching it (`Ctrl-]`, then unplug) is a step of the procedure
rather than the end of one. Shorten the interval before you unplug, or a run takes a quarter of an
hour per wake:

```bash
curl -X POST http://claudepost.local/api/sleep -d '{"seconds":60}'   # then unplug
```

That number is the board's own fallback and the desk outranks it, so if the URL is a desk rather than
a file the board will keep sleeping by the desk's `poll_seconds` and `power.sleepSource` will say so.
Point the board at a static payload with no `policy` block for the duration if you want the interval
you asked for.

Then press a button — a button wake keeps the HTTP server and mDNS up for two minutes
(`CONFIG_CLAUDEPOST_AWAKE_WINDOW_SECONDS`), and that window is the only way to `curl` a board that is
otherwise awake for three seconds at a time. Three things are worth reading in it, and writing down:

| what | how | why it matters |
|---|---|---|
| `power.wakes`, `power.quietWakes`, `power.meanAwakeMs` | `curl -s http://claudepost.local/api/state \| jq .power` | that the board is waking, and that nearly all of them are quiet. `meanAwakeMs` is the measurement §4 wants |
| `power.sleepSeconds` and `power.sleepSource` after a policy-driven wake | the same call | the one thing no host test can see: that a targeted wake has not been written into the board's *local* interval. `sleepSource` reading `"nvs"` beside a shortened interval is that bug — on a wake after the desk has gone quiet, since while it is naming a cadence the same field correctly reads `"policy"` — and it would cost a cell rather than a page |
| **the sleep current, in µA, on a bench supply** | a meter in series with the cell, board asleep | the number this whole design rests on and nobody has measured. `power_sleep()` keeps the RTC peripheral domain powered so the four buttons hold their pull-ups through the sleep, which the IDF's tables put at a few µA over the bare ~14 µA figure — an **estimate**, and this row is where it stops being one. Record it here |

Press each of the four buttons on a sleeping board too, and confirm each one wakes it. That is the
only check there is on the pull-ups: without them the pins float, and a floating press-to-GND pin
produces either spurious wakes or none at all, with nothing in any log either way.

The rest is what the counters in §4 are for. The board writes down what it did so that a reader who
was not there can find out.

### What a wake looks like in the log

One line says what this wake decided and one says what it is doing about it. Together they are the
fastest way to tell whether the feature is working at all, because a wake that costs nothing and a
wake that costs a refresh look completely different.

A **quiet wake** — the common case, and the one the whole design is for. The panel is never powered,
LVGL is never built, the 960,000-byte framebuffer is never allocated:

```
I main: quiet fetch: not_modified
I main: wake=timer fetch=unchanged -> sleep (cadence 900s from policy, fails 0)
I power: sleeping 900s (wakes 12, quiet 11, awake 34210ms total, mask 0x2d)
```

Three seconds, start to finish. **`from policy` is the field to read**: it is who decided this
interval, and it is one of `policy` (the desk's `poll_seconds`), `next_change` (a targeted wake for a
schedule transition the desk named) or `local` (the board's own interval — Kconfig, the setup form,
or `POST /api/sleep`). A board pointed at a desk that reads `local` is a board that is not receiving
a `policy` block, which is worth knowing before the cadence is blamed on anything else. `awake` is
cumulative across every wake since the last power-on, so 34,210 ms over 12 wakes is a mean of 2.9 s —
that division is exactly what `power.meanAwakeMs` reports. `quiet 11` of `wakes 12` is a healthy
board: eleven wakes that printed nothing. `mask 0x2d` is bits 0, 2, 3 and 5 — the four buttons armed
as wake sources; a `0x0` there means nothing but the timer can wake this board and is worth
investigating.

A **printing wake** — the server had something new, so the board takes the full path:

```
I main: quiet fetch: ok
I main: wake=timer fetch=changed -> refresh (cadence 900s from policy, fails 0)
I main: content changed — printing without a second connect
...
I app: awake window closed — sleeping 900s from policy (fetched page printed yes, fails 0)
```

and between those the boot proceeds through the whole of §2 — `epd6`, `LvglPort`, the refresh —
before sleeping. `zero-length window — sleeping as soon as this wake is done` is the line that says
this wake has no awake window at all: it got up to resolve one fetch, and it sleeps the moment that
fetch has resolved one way or the other. This is the expensive kind, and on a normal day there
should be about two of them. The last line is where the accounting happens rather than at the
decision: `fetched page printed yes` is what
clears the failure count, because a wake that decided to print and then failed to fetch anything has
printed nothing, and a board that called that healthy would go on doing it every fifteen minutes. It
says *fetched* because a page swap, the self-test pattern and the demo page all reach the glass
through the same call and none of them is evidence that the desk is reachable.

A **button wake** stays up instead of sleeping, which is what makes the companion app usable:

```
I main: wake=button fetch=not_attempted -> awake (cadence 900s from policy, fails 0)
```

`fetch=not_attempted` is correct here rather than a failure — a button wake does not run the quiet
poll, because a person is standing in front of the frame and the point is to be reachable, not to be
quick. **The sheet reprints, and that is not a fault.** RAM did not survive the sleep, so the
snapshot in memory is the demo page and the first fetch never hashes the same as it — so a press
buys a twenty-five second flash that ends with the edition already on the glass. It is why a press
costs about 5.7 mAh rather than the window's 2.8; see §8 of the
[deep-sleep design](specs/2026-08-17-deep-sleep-design.md) for why suppressing it would not be
safe. The interval still appears in the line; it is what the board will use when the window closes,
recomputed at that moment. A button wake that prints nothing counts no failure either: somebody
looked at the frame, which is not the board's network going away.

A **failed wake** counts and sleeps rather than starting the setup portal:

```
W main: quiet path: no network — counting a failure
I main: wake=timer fetch=not_attempted -> sleep (cadence 900s from local, fails 1)
```

Watch `fails` climb across wakes; the interval holds until the fourth, then steps up — at a 900 s
base, `cadence 900s` becomes `cadence 3600s` (five times 900 is 4,500, capped at an hour). Note that
`from local` is expected here on a board whose desk it cannot reach — the cadence carried across the
sleep is only as fresh as the last poll that brought a body, and a board that has never reached its
desk has nothing but its own interval. Note also what does *not* happen: a board whose Wi-Fi has gone
away never puts up the captive portal, because doing that on every wake would flatten the cell in
under three weeks while showing a setup screen nobody is looking at. The backoff and the rest of the
decision are §3 and §7 of the [deep-sleep design](specs/2026-08-17-deep-sleep-design.md).

**The symptom worth knowing by name: the wake said `changed` and nothing printed.** A wake whose
quiet fetch came back `changed` must end in a refresh. If the log shows

```
I main: wake=timer fetch=changed -> refresh (cadence 900s from policy, fails 0)
...
I app: awake window closed — sleeping 900s from policy (fetched page printed no, fails 1)
```

with no refresh between them, then `NewsTask`'s own fetch did not resolve into a page this boot.
Two lines say which:

- `the first fetch of this boot failed — leaving the printed edition on the glass` — the desk
  answered the quiet path and then did not answer `NewsTask`. `fails` climbing across wakes is the
  correct behaviour and the backoff will slow the board down.
- `no snapshot within 192000 ms — …` — `NewsTask` neither succeeded nor gave up inside the backstop,
  which means it is stuck rather than slow. That figure is derived rather than chosen: five attempts
  at the port's 15 s timeout, the four three-second waits between them, and the seven photographs an
  edition can carry against the same timeout — the worst case a boot can honestly reach before it
  either has a page or has said it has none. Past it, this line is a bug report and not a slow
  network.

What must **never** appear is that pair with no reason line at all between them, and the glass
unchanged wake after wake with `fetch=changed` every time. That was the shape of the bug the zero
window used to have — the page arrived a moment after a fifteen-second stopwatch ran out and was
discarded unread — and it self-perpetuated, because a page that never printed never publishes its
hash or its tag, so the next wake fetched the same changed edition and did the same thing. Hourly,
forever, with every log line reading `refresh`.

Two lines you should never see, both from `power.c`, both meaning a button will not wake the board:
`GPIO46 cannot wake the chip (RTC GPIOs are 0..21)` and `no usable wake pins — only the timer can
wake this board`. See [pinout.md](pinout.md#all-four-wake-the-board-from-deep-sleep).

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

On a sleeping board, any of the four also **wakes** it — all four are RTC GPIOs and all four are armed
as `ext1` sources ([pinout.md](pinout.md#all-four-wake-the-board-from-deep-sleep)) — and the board
then stays up and reachable for two minutes rather than going straight back to sleep. Add the boot to
the refresh and a press takes noticeably longer to show anything than the twenty to thirty seconds
above.
