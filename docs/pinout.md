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

## Battery

| Signal | XIAO pad | GPIO | `user_config.h` |
|---|---|---|---|
| BAT_ADC | A0 | 1 | `BATT_ADC_PIN` |
| ADC_EN | D5 | 6 | `BATT_ENABLE_PIN` |

A 1:3 divider on GPIO1 (ADC1_CH0) behind a load switch. **The divider is disconnected — and the
reading meaningless — until GPIO6 is driven HIGH**, which `board_io_init()` does and leaves on. A
reading below 2.5 V is reported as "no cell fitted" rather than as a flat battery: a Li-ion whose
protection circuit has cut off never presents that voltage, so it means USB-only operation, and
showing an empty battery there is a false alarm somebody will chase.

The JST 2.0 battery input also passes a hardware slide switch; it must be ON for battery operation.

`BATT_DIVIDER` in `components/board_io/board_io.c` is 3.0 **from the documentation, never measured** —
see [bring-up.md](bring-up.md#4-record-the-numbers).

## No I2C, no RTC

The EE05 the ancestry of this code came from routed GPIO5/GPIO6 to an I2C side header. Here **those
same two pins are KEY2 and the battery divider's enable**, and the board has no RTC of its own. The
I2C bus and the PCF85063A driver are therefore gone entirely, and the clock comes from SNTP alone —
which is also why `CONFIG_WP_NEWS_TIMEZONE` is the only thing standing between UTC and the dateline
the sheet prints.

## Unused

No audio codec, SD card, touch controller or backlight — e-Paper has no backlight, and none of the
rest is wired on this build.
