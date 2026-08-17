# Hardware

A **Seeed XIAO ePaper Display Board** carrying a **XIAO ESP32-S3 Plus**, with a 13.3" Spectra 6
six-colour e-Paper panel on the carrier's FPC connector. Unlike the hand-wired board this project
forked from, this is an off-the-shelf combination — the wiring is the carrier's, not yours, and
[pinout.md](pinout.md) records it rather than proposing it.

| Item | Specification |
|------|------|
| Carrier | XIAO ePaper Display Board — the 13.3" panel's carrier is the **EE02**; the display half is routed identically on the [EE04](https://wiki.seeedstudio.com/epaper_ee04/) and EE05 |
| SoC | ESP32-S3 (Xtensa LX7 dual-core, up to 240 MHz) |
| Flash / PSRAM | 16 MB Flash / 8 MB Octal PSRAM |
| Display | 13.3" **Spectra 6** e-Paper, portrait **1200 × 1600**, six inks, **two UC8179 controllers**, 4-wire SPI + two chip selects + one BUSY |
| Refresh | one kind, ~20–30 s, the whole sheet flashes. **No partial waveform at all** |
| RTC | **none** — the clock is SNTP only |
| Wireless | Wi-Fi 802.11 b/g/n, BLE 5.0 (unused) |
| USB | Type-C — power, programming, native USB Serial/JTAG |
| Buttons | KEY0/1/2 (GPIO2/3/5) on the carrier, BOOT (GPIO0) on the XIAO |
| Power | 5 V USB-C, optional Li-ion on JST 2.0 + slide switch, voltage via ADC divider |

The two controllers sit behind one FPC and divide the panel's **columns**, not its rows: the master
owns framebuffer columns 0…599 and the slave 600…1199, over one SPI bus with two chip selects and a
single shared BUSY. The second chip select is GPIO41 and it appears in no Seeed document — a blank
right-hand half of the sheet is that pin. See [pinout.md](pinout.md) for where it came from.

## Notes that matter in practice

**No backlight.** e-Paper is reflective; it is unreadable in the dark and excellent in daylight.
This is the opposite trade from an LCD and it drives the whole visual design — heavy strokes, high
contrast, no greys, nothing that depends on a hairline surviving a threshold.

**No RTC, and the two pins that used to carry I2C are taken.** An earlier carrier in this family
routed GPIO5/GPIO6 to an I2C side header; here they are KEY2 and the battery divider's load-switch
enable. So the PCF85063A driver and the whole I2C bus are gone, and the header clock comes from SNTP
alone. It is blank (`--:--`) until the first sync, which is a few seconds after Wi-Fi comes up.

**PSRAM is required here.** The panel framebuffer is portrait 1200 × 1600 at 4 bpp — 600 bytes to a
row, **960,000 bytes** — and LVGL renders into a 1200 × 120 RGB565 strip buffer of a further
288,000. Both live in PSRAM, and there is no internal-RAM fallback that could hold either: a
full-screen RGB565 buffer alone would be 3.84 MB. The XIAO ESP32-S3 **Plus** has 8 MB, so this is
comfortable — but a plain XIAO ESP32-S3 without PSRAM will not run this firmware. What is internal
and DMA-capable is only the 19,200-byte block the driver packs each row-group into on its way out to
the two controllers.

**The battery divider needs its switch driven.** GPIO6 gates it; until that is HIGH the ADC reads
noise. `board_io_init()` drives it and leaves it on. A reading below 2.5 V is reported as "no cell
fitted" rather than as a flat battery — a Li-ion whose protection has cut off never presents that
voltage, so it means USB-only operation, and an empty battery icon there is a false alarm.

**`BATT_DIVIDER` is 3.0 on the strength of the documentation, not a measurement.** It has never been
checked against this board, and it is the kind of constant that fails quietly: a wrong ratio gives a
percentage that looks entirely plausible and is wrong every single time you glance at the panel —
the same failure shape as a wrong calendar anchor in the project this forked from.

Check it once, the first time a cell is fitted: read `battery.millivolts` from `GET /api/state`,
compare against the cell measured with a multimeter, and scale `BATT_DIVIDER` in
`components/board_io/board_io.c` by the ratio. If the two agree, write that down here and the
question is closed.

**Battery reading is defensive.** Every `board_io` getter returns 0 rather than blocking if the ADC
is unavailable, so a depopulated part never wedges the render loop.

## Power

Seeed quotes about three months on a charge for a board that sleeps between refreshes. This firmware
does not sleep — it holds Wi-Fi up so `wpnews.local` stays reachable and the poll interval
stays honest. On USB that is the right trade; on battery it is not, and a future revision that wants
battery life should look at light sleep between polls before anything else.

The panel itself is not the problem: `epd6_sleep()` gets the controllers to about 1 µA, and the
refresh policy already keeps refreshes rare (see [epaper-13in3.md](epaper-13in3.md)).

## Firmware footprint

At the time of writing: **1,602,976 bytes** of an 8 MB app partition (81% free), built at `-O2`.
**121,112 bytes** of that is the seven generated newspaper faces — measured over
`components/news_core/fonts/*.obj` in the build tree, and the point of having 8 MB. Discussed in
[pages.md](pages.md).
