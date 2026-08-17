# References

Primary sources. When something about the hardware is uncertain, check here rather than guessing —
on this board a wrong guess about the panel produces a blank screen with nothing in the log, which
is the most expensive kind of wrong.

## The panel and the carrier

The panel is a 13.3" **Spectra 6**, portrait **1200 × 1600**, six inks, driven by **two UC8179
controllers** that own its columns — master `x 0…599`, slave `x 600…1199`.

- **The second chip select, and the two-controller split** —
  [`acegallagher/esphome-bigink`](https://github.com/acegallagher/esphome-bigink) (`bigink.yaml:278`).
  **GPIO41 appears in no Seeed document this project could find**, and this is the only published
  source that drives this panel without Seeed's cloud tooling. The repository carries no LICENSE
  file, so what is taken from it is hardware fact — the pin number and the column split — and not
  code. A blank right-hand half of the sheet is this pin; see [pinout.md](pinout.md).
- **Waveshare 5.83" e-Paper V2 reference driver** —
  [`EPD_5in83_V2.c`](https://github.com/waveshareteam/e-Paper/blob/master/RaspberryPi_JetsonNano/c/lib/e-Paper/EPD_5in83_V2.c)
  The same controller at a different size and in monochrome — 648 × 480 against this panel's
  1200 × 1600 in six inks — so the geometry does **not** carry over, but the command sequence in
  `epd6_panel.c` is transcribed from it and it is still the first place to look at a register.
  **BUSY is active LOW.**
- **Seeed_GFX UC8179 tables** —
  [`UC8179_Init.h`](https://github.com/Seeed-Studio/Seeed_GFX/blob/master/TFT_Drivers/UC8179_Init.h) ·
  [`UC8179_Defines.h`](https://github.com/Seeed-Studio/Seeed_GFX/blob/master/TFT_Drivers/UC8179_Defines.h)
  Independent cross-check of the same sequence. It also carries the partial-refresh window commands,
  which have no counterpart here: Spectra 6 has no partial waveform at all, and every partial-refresh
  entry point is gone from this driver rather than stubbed.
- **Panel pin routing** —
  [`EPaper_Board_Pins_Setups.h`](https://github.com/Seeed-Studio/Seeed_GFX/blob/master/User_Setups/EPaper_Board_Pins_Setups.h).
  One branch covers the EE02 (the 13.3" carrier), the EE04 and the EE05, because all three route the
  display half identically — which is why the SPI/DC/RST/BUSY/PWR_EN block in `main/user_config.h`
  came across from the 5.83" board unchanged. Not from measurement, and not by assumption.
- [Seeed wiki: XIAO ePaper Display Board EE04](https://wiki.seeedstudio.com/epaper_ee04/) —
  buttons, battery ADC, supported panel list. The display half matches; the panel does not.
- [Seeed wiki: ePaper driver board overview](https://wiki.seeedstudio.com/xiao_epaper_display_board_overview/)
- [ESP-IDF LCD peripheral docs](https://docs.espressif.com/projects/esp-idf/en/stable/esp32s3/api-reference/peripherals/lcd/index.html)
  — background only. This driver uses `spi_master` directly, for the reason given in `epd6_panel.c`.

## Fonts

Four families from Google Fonts, all SIL Open Font License 1.1, generated into the seven faces in
`components/news_core/fonts/` by `tools/gen_fonts.py`. Licence text is bundled per family directory
as `OFL-<family>.txt` — four files for five downloads, because Source Serif's upright and italic
share one.

- **UnifrakturMaguntia** (masthead blackletter) — https://github.com/google/fonts/tree/main/ofl/unifrakturmaguntia
- **Playfair Display** (headlines; a Didone, standing in for the Postoni a broadsheet would set) —
  https://github.com/google/fonts/tree/main/ofl/playfairdisplay
- **Source Serif 4**, upright and italic (body and decks) —
  https://github.com/google/fonts/tree/main/ofl/sourceserif4
- **Libre Franklin** (labels; a revival of the Franklin Gothic these slots want) —
  https://github.com/google/fonts/tree/main/ofl/librefranklin
- [`lv_font_conv`](https://github.com/lvgl/lv_font_conv) — invoked by `tools/gen_fonts.py`.
- [`fontTools`](https://github.com/fonttools/fonttools) — also invoked by it, and not optional:
  Google publishes three of these four only as variable fonts, and `lv_font_conv` would silently
  take the default instance — Playfair Regular where the table asks for Playfair Bold.

The two 완성형 Korean faces this board used to carry are gone, and with them the `euc-kr`-derived
2350-syllable table. Headlines now arrive over the network in Latin, so the six text faces carry
ASCII + Latin-1 + `S_DATA_PUNCT` and cannot be subset further; only the masthead is, and only to the
Latin alphabet. `ui_strings.h` is where the generator reads the fixed strings from.

## Framework

- [ESP-IDF programming guide](https://docs.espressif.com/projects/esp-idf/en/stable/esp32s3/)
- [LVGL v9 docs](https://docs.lvgl.io/master/)

## The project this forked from

- `saju_omi_esp32` — a 2.13" fortune-slip board on an EE05. This repo inherited its structure: the
  draw-and-present split, the captive-portal provisioning, the device HTTP API, the desktop
  simulator, and the habit of writing a host test before believing anything. It shares no content
  code, and deliberately not its mDNS name or AP prefix.
