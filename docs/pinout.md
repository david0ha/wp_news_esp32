# Pinout

The board is a **Seeed XIAO ePaper Display Board** carrying a **XIAO ESP32-S3 Plus**; the 13.3"
Spectra 6 panel plugs into the carrier's FPC connector. These are the carrier's fixed routing, not
defaults — but they still live in one place, `main/user_config.h`, and nothing else in the firmware
hardcodes a GPIO. Even the buttons are passed to `user_app` as data, for the same reason
`epd6_init()` takes the panel's pins.

## e-Paper (two UC8179 controllers, 1200 × 1600 portrait, six inks)

| Net | XIAO pad | GPIO | `user_config.h` | Notes |
|---|---|---|---|---|
| SPI0_SCL | D8 | 7 | `EPD_SCK_PIN` | SPI SCLK, 10 MHz |
| SPI0_MOSI | D10 | 9 | `EPD_MOSI_PIN` | SPI MOSI |
| SPI0_CS | D7 | 44 | `EPD_CS_PIN` | **controller #1 — framebuffer columns 0…599** |
| SPI0_CS1 | — | 41 | `EPD_CS_SLAVE_PIN` | **controller #2 — framebuffer columns 600…1199** |
| EDP_DC | D16 | 10 | `EPD_DC_PIN` | command / data |
| EDP_RES | D11 | 38 | `EPD_RST_PIN` | output, wired to **both** controllers |
| EDP_BUSY | D3 | 4 | `EPD_BUSY_PIN` | input, wired to **both**, **active LOW while refreshing** |
| PWR_EN | D6 | 43 | `EPD_POWER_PIN` | **panel power gate, active HIGH** |

SPI host is `SPI3_HOST`. MISO is unused (`-1`), and so is the peripheral's own chip select
(`spics_io_num = -1`): this driver drives both CS lines and DC as plain GPIOs, because some commands
have to reach both controllers with both selects asserted at once, and `esp_lcd`'s panel-IO owns
exactly one CS. See `components/port_bsp/epd6_panel.c`.

The display half of the routing is transcribed from Seeed's own library —
[`Seeed_GFX/User_Setups/EPaper_Board_Pins_Setups.h`](https://github.com/Seeed-Studio/Seeed_GFX/blob/master/User_Setups/EPaper_Board_Pins_Setups.h),
which carries one branch for the EE02 (the 13.3" carrier), the EE04 and the EE05 because all three
route it identically. That is why this fork inherited the SPI/DC/RST/BUSY/PWR_EN block unchanged
from the 5.83" board it came from.

### GPIO41, and where it comes from

**The second chip select appears in no Seeed document this project could find.** It comes from
[`acegallagher/esphome-bigink`](https://github.com/acegallagher/esphome-bigink) (`bigink.yaml:278`),
which is the only published source that drives this panel without Seeed's cloud tooling. That
repository carries no LICENSE file, so what is taken from it is hardware fact, not code — the pin
number and the two-controller framebuffer split. The register tables come from Seeed instead.

**If the right half of the sheet stays blank while the left half is correct, this pin is the first
thing to check.** The panel is two controllers; a dead slave select is not a corrupted image, it is
600 px of paper down the right-hand side, and nothing in the log says so. `busy_line_probe()` names
GPIO41 in its warning for exactly this reason.

## Four traps, all fatal to the display if ignored

- **BUSY is active LOW** — the panel is idle when the pin reads HIGH. Getting the polarity backwards
  does not fail loudly: every wait returns immediately, the driver writes the next command into a
  controller that is still mid-refresh, and the sheet comes out torn. There is nothing in the log to
  suggest why. One BUSY line serves both controllers, so it reads busy while *either* is busy.
- **PWR_EN gates the panel's 3.3 V** through a load switch with a pulldown on its enable. The panel is
  unpowered until GPIO43 is driven HIGH. `epd6_init()` does it before the first reset — and, unlike
  the 5.83" port, `epd6_refresh()` powers the rail **down** again at the end of every refresh and back
  up at the start of the next. On the monochrome panel that was forbidden, because cutting power drops
  the previous-image plane a partial refresh diffs against; Spectra 6 has no partial refresh, so there
  is nothing to preserve, and cutting the rail stops the charge pump's audible buzz between updates.
  `power_sleep()` calls `epd6_sleep()` on the way into deep sleep to cover the boot that refreshed
  nothing and therefore never reached that path — and on a wake that never touched the panel at all,
  the pulldown has already answered the question: a pin nobody drove is a panel that is off.
- **GPIO43/44 are the ESP32-S3's default UART0 pins.** The console therefore runs on USB Serial/JTAG
  (`CONFIG_ESP_CONSOLE_USB_SERIAL_JTAG=y` in `sdkconfig.defaults`); a UART0 console would clock every
  log byte into PWR_EN and the master chip select.
- **GPIO41 is undocumented by the vendor** — see above.

## Buttons

| Button | GPIO | `user_config.h` | Action |
|---|---|---|---|
| KEY0 | 2 | `BTN_KEY0_PIN` | toggle A1 / A2 |
| KEY1 | 3 | `BTN_KEY1_PIN` | poll the news source now |
| KEY2 | 5 | `BTN_KEY2_PIN` | tap → A1; **held 5 s → reboot into Wi-Fi setup** |
| BOOT | 0 | `BTN_BOOT_PIN` | previous page |

KEY0–2 are the carrier's three side buttons; all are press-to-GND with the internal pull-up enabled.
BOOT is the button on the XIAO module itself — also the bootloader strap pin, so holding it while
pressing RESET enters download mode, which is unrelated to the firmware's use of it.

**GPIO3 is the hardware wake pin on the EE02.** Treat a press there as "wake" rather than binding it
to anything destructive; KEY1's "poll now" is chosen with that in mind.

The long press is detected by *sampling the pin*, not by timing two edges: the driver interrupts on
the press only, so a release generates no event to time against.

### All four wake the board from deep sleep

GPIO3 is the carrier's *hardware* wake pin, but it is not the only one that wakes the firmware. The
ESP32-S3's RTC GPIOs are **0–21**, and every button here — 0, 2, 3, 5 — is inside that range, so all
four are `ext1` wake sources. `power_sleep()` builds the mask from the same four pins the buttons
driver was given (`0x2d`, which is bits 0, 2, 3 and 5) and arms `ESP_EXT1_WAKEUP_ANY_LOW`, which
works precisely because they are all press-to-GND. No extra hardware, no dedicated wake button: the
board wakes because somebody pressed something, and a press is a person standing in front of the
frame.

> **Trap: a wake pin above GPIO21 cannot wake the chip, and nothing anywhere says so.**
>
> This is not like the other traps on this page, which at least produce a symptom. Arm `ext1` on a
> pin outside the RTC range and nothing is rejected, nothing is logged by the IDF, and no call
> fails — the board sleeps normally, the timer still wakes it, and the button is simply dead for as
> long as it is asleep. It works perfectly on a bench, where the board never sleeps at all.
>
> `power_sleep()` therefore checks each pin itself and drops the ones it cannot use, naming them:
> `E power: GPIO46 cannot wake the chip (RTC GPIOs are 0..21) — that button is dead while asleep`.
> If every pin is dropped it says `W power: no usable wake pins — only the timer can wake this
> board`. Both are errors you can act on, which is the whole reason they exist; moving a button to a
> pin above 21 is otherwise a change with no visible consequence until a board is on a wall.

Deep sleep is off by default, so none of this is in play until `CONFIG_WP_NEWS_DEEP_SLEEP` is
enabled — see [bring-up.md](bring-up.md#6-deep-sleep-during-bring-up). The KEY2 escape hatch and the
rest of getting back into a sleeping board are §7 of the
[deep-sleep design](specs/2026-08-17-deep-sleep-design.md).

## Battery

| Signal | XIAO pad | GPIO | `user_config.h` |
|---|---|---|---|
| BAT_ADC | A0 | 1 | `BATT_ADC_PIN` |
| ADC_EN | D5 | 6 | `BATT_ENABLE_PIN` |

A 1:3 divider on GPIO1 (ADC1_CH0) behind a load switch. **The divider is disconnected — and the
reading meaningless — until GPIO6 is driven HIGH**, which `board_io_init()` does and leaves on for as
long as the board is awake. A reading below 2.5 V is reported as "no cell fitted" rather than as a
flat battery: a Li-ion whose protection circuit has cut off never presents that voltage, so it means
USB-only operation, and showing an empty battery there is a false alarm somebody will chase.

**GPIO6 goes back down before deep sleep.** `board_io_sleep()` drives it LOW and then latches it with
`gpio_hold_en()`, and `board_io_init()` releases that hold on the way back up. Until deep sleep
existed, `board_io_init()` drove this pin high and *nothing ever lowered it* — which cost nothing on a
board that was always awake and is a standing drain on one that is asleep 99.7% of its life, drawn
continuously from the cell to measure a voltage nobody is awake to read. The hold is not belt and
braces either: deep sleep disconnects the digital pad from the GPIO matrix, so a pin that was merely
driven low floats, and a floating load-switch enable is whatever that switch's input leakage decides.
The matching `gpio_hold_dis()` in `board_io_init()` is what stops the latch outliving the sleep — a
held-low enable that nobody released would read 0 V forever after, be reported as "no cell fitted",
and in turn disable deep sleep permanently.

The JST 2.0 battery input also passes a hardware slide switch; it must be ON for battery operation.

`BATT_DIVIDER` in `components/board_io/board_io.c` is 3.0 **from the documentation, never measured** —
see [bring-up.md](bring-up.md#4-record-the-numbers).

## No I2C, no RTC

The EE05 the ancestry of this code came from routed GPIO5/GPIO6 to an I2C side header. Here **those
same two pins are KEY2 and the battery divider's enable**, and the board has no RTC of its own. The
I2C bus and the PCF85063A driver are therefore gone entirely, and the clock comes from SNTP alone —
which is also why `CONFIG_WP_NEWS_TIMEZONE` is the only thing standing between UTC and the dateline
the sheet prints.

**This costs nothing at all for deep sleep, and it is worth being clear about, because "no RTC" is
easy to read as "cannot wake itself".** The missing part is an external RTC *chip* — a PCF85063A on
an I2C bus that would keep wall-clock time while the SoC is unpowered. The timer that performs a
scheduled wake is the ESP32-S3's own internal RTC, in the always-on power domain, and it needs no
external part: `esp_sleep_enable_timer_wakeup()` arms it and the chip wakes on its own. What the
absent chip actually costs is the thing it always cost — the date. A board that has been unplugged
comes back not knowing what day it is until SNTP answers, and that is a dateline problem, not a wake
problem.

## Unused

No audio codec, SD card, touch controller or backlight — e-Paper has no backlight, and none of the
rest is wired on this build.
