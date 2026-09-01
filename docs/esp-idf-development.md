# ESP-IDF Development Guide

The workflow from environment activation through build/flash/debug to the peripheral drivers.

## 1. Environment activation

ESP-IDF is installed under `~/esp/`. Run this **every time you open a new terminal** so `idf.py`
lands on PATH:

```bash
. ~/esp/esp-idf/export.sh      # or ~/esp/v5.4.3/esp-idf — wherever this machine keeps it
```

Verify:

```bash
idf.py --version      # ESP-IDF v5.4.3
```

> **Ask the tool, not the path.** The IDF lives under `~/esp` — as `~/esp/esp-idf` on one machine
> and `~/esp/v5.4.3/esp-idf` on another — and neither directory name is authoritative about the
> version. This repository has now described its own environment wrongly three times: the
> `~/.espressif/tools/activate_idf_v6.0.1.sh` script named by the oldest notes was inherited
> verbatim from the project this one forked and never described any machine here; a later revision
> documented a two-install layout the other machine never had; and a draft of *this* section
> announced v6.0.2 after the v6 attempt had already been rolled back. `idf.py --version` has been
> right every time.
>
> **v6.0 was attempted and rolled back.** Little of the migration is the firmware's problem —
> everything here is already the modern API (`esp_adc/adc_oneshot.h`, `esp_netif_sntp.h`, no legacy
> timer/I2S/RMT drivers), and cJSON, which v6 drops from core, has been vendored at
> `third_party/cJSON` since the port began. What the attempt left behind is a `~/.espressif` holding
> two cross-compilers and two python environments, which is a real trap: see the quick start in
> [CLAUDE.md](../CLAUDE.md) before debugging a `Tool doesn't match supported version` error.
>
> One repository change did survive the rollback, because it was never a v6 change. `port_bsp` asked
> for the catch-all `driver` component, which **IDF 5.3** had already emptied down to i2c, twai and
> the touch sensor when it split the peripheral drivers into `esp_driver_gpio`, `esp_driver_spi` and
> the rest. It now names `esp_driver_gpio`, as `board_io` and `buttons` already did.

## 2. Creating a project

```bash
# Copy-an-example approach
cp -r $IDF_PATH/examples/get-started/hello_world my_app
cd my_app

# Or an empty project
idf.py create-project my_app && cd my_app
```

## 3. Setting the target (once per project)

```bash
idf.py set-target esp32s3
```

## 4. Board configuration (menuconfig)

```bash
idf.py menuconfig
```

Items you must verify for this board:

- **Serial flasher config → Flash size** → `16 MB`
- **Component config → ESP PSRAM**
  - Enable `Support for external, SPI-connected RAM`
  - `SPI RAM config → Mode` → **Octal Mode PSRAM**
  - Speed 80MHz (if needed)
- **Component config → ESP System Settings → Channel for console output**
  - When using the direct USB-C connection, you can select `USB Serial/JTAG Controller`
- Partition Table: to make use of the 16MB flash, a custom `partitions.csv` is recommended
  (app + SPIFFS/FAT + OTA, etc.).

> Writing the settings above into `sdkconfig.defaults` makes them reproducible across the team/CI. Example:
> ```
> CONFIG_ESPTOOLPY_FLASHSIZE_16MB=y
> CONFIG_SPIRAM=y
> CONFIG_SPIRAM_MODE_OCT=y
> CONFIG_SPIRAM_SPEED_80M=y
> ```

## 5. Build / flash / monitor

```bash
idf.py build
./tools/flash.sh                 # or, by hand:
idf.py -p <PORT> flash monitor
```

`tools/flash.sh` does the second line with the port worked out and a two-second settle before it
connects, which is the difference between "this board will not flash" and "the CDC endpoint was
not ready yet".

- Exit the serial monitor: `Ctrl + ]`
- Finding `<PORT>` (macOS):
  ```bash
  ls /dev/cu.*
  ```
  - Native USB Serial/JTAG: `/dev/cu.usbmodem*`
  - UART bridge (CH34x/CP210x, etc.): `/dev/cu.usbserial-*` / `/dev/cu.wchusbserial*`
- If entering flash mode fails: **hold the BOOT button while clicking RESET → release BOOT**, then retry.
- Individual steps: `idf.py build`, `idf.py flash`, `idf.py monitor`, `idf.py app-flash`, etc.

## 6. Debugging (JTAG / USB Serial/JTAG)

The ESP32-S3 has a built-in native USB Serial/JTAG, so OpenOCD/GDB debugging is possible without an extra adapter:

```bash
idf.py openocd            # Start the OpenOCD server (in a separate terminal)
idf.py gdb                # Connect with GDB
# Or all at once
idf.py openocd gdbgui
```

- It uses the Espressif-patched OpenOCD build included with ESP-IDF (no separate installation needed).
- In VS Code, you can configure debugging with the "Espressif IDF" extension + `idf.py`.

## 7. Peripheral drivers (ESP-IDF components)

See [pinout.md](pinout.md) for the pin map. Components are fetched from the ESP Component Registry
(`idf.py add-dependency "<name>"`).

### Display (two UC8179 controllers, SPI, 1200 × 1600 portrait, six inks)

Written in-house at `components/port_bsp/epd6_panel.c`. There is no official `esp_lcd` component for
the UC8179 — do not go looking for one, and note that this driver does not use `esp_lcd`'s panel IO
either: it drives `spi_master` directly with `spics_io_num = -1`, because the init sequence has
commands that both controllers must receive, which means both chip selects low at once, and
`esp_lcd`'s panel IO owns exactly one CS and queues asynchronously. It owns its own 960,000-byte
framebuffer (in PSRAM) and its refresh policy.

Full rationale, the command sequence's provenance, and the refresh rules are in
[epaper-13in3.md](epaper-13in3.md). Read that before touching the driver, and note the one thing
most likely to waste your afternoon: **BUSY is active LOW on this controller**, the inverse of the
SSD1680 this code started as, and getting it backwards fails silently rather than loudly.

### Not present on this build

No touch controller, audio codec, SD card or RTC. There is also **no I2C bus**: the two pins an
earlier carrier in this family routed to an I2C header are KEY2 and the battery divider's enable
here. Adding an I2C device means finding two free pins first — see [pinout.md](pinout.md).

## 8. Summary of frequently used commands

```bash
. ~/esp/esp-idf/export.sh          # environment (or ~/esp/v5.4.3/esp-idf)
idf.py set-target esp32s3        # target
idf.py menuconfig                # configuration
idf.py build                     # build
idf.py -p <PORT> flash monitor   # flash + monitor
idf.py fullclean                 # clean the build cache
idf.py size                      # memory usage
idf.py add-dependency "<comp>"   # add a component
```

Before claiming a change works, also run the host tests and the simulator — see
[the verification section of CLAUDE.md](../CLAUDE.md#verify-before-claiming-anything-works).

## References

- [references.md](references.md) — the e-Paper driver's upstream source, the carrier's pin routing as
  published by Seeed, where the second chip select came from, and the font licences.
