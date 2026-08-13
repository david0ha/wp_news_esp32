/*
 * epd6_panel.h — Seeed 13.3" Spectra 6 e-Paper port (1600x1200, six colours).
 *
 * The panel is two UC8179 controllers behind one SPI bus and two chip selects,
 * on a Seeed XIAO ePaper carrier. Its native orientation is portrait
 * 1200 x 1600; this port presents it as landscape 1600 x 1200 and does the
 * rotation while packing (see epd6_transpose.h).
 *
 * WHAT IS DIFFERENT FROM THE 5.83" MONOCHROME PORT THIS REPLACES
 * --------------------------------------------------------------
 *  1. SIX COLOURS, four bits per pixel. epd6_color_t values ARE the wire codes,
 *     so the framebuffer needs no translation on the way out.
 *
 *  2. NO PARTIAL REFRESH. Spectra 6 has no partial waveform at all — there is
 *     one refresh, it takes twenty to thirty seconds, and it flashes. Every
 *     partial-update entry point from the 5.83" driver is gone rather than
 *     stubbed, so a caller that wanted one fails to compile instead of quietly
 *     spending thirty seconds.
 *
 *  3. TWO CHIP SELECTS, and commands that need BOTH asserted at once. That is
 *     why this driver talks to spi_master directly with `spics_io_num = -1` and
 *     drives CS/DC as plain GPIOs: esp_lcd's panel-IO owns exactly one CS and
 *     queues transactions asynchronously, which cannot express "both
 *     controllers listen to this one".
 *
 *  4. THE PANEL IS POWERED DOWN BETWEEN REFRESHES. On the 5.83" that was
 *     forbidden — it would drop the previous-image plane that partial updates
 *     diff against. With no partial updates there is nothing to preserve, and
 *     cutting the rail stops the audible buzz from the charge pump.
 *
 * UNCHANGED: drawing and presenting are still separate. The LVGL flush callback
 * only fills the framebuffer; the application decides when to spend a refresh.
 *
 *     ... update widgets ...
 *     Lvgl_RenderNow();     // renders -> flush_cb -> epd6_set_pixel()
 *     epd6_refresh();       // twenty to thirty seconds. Not free.
 *
 * SOURCES
 * -------
 * Register tables and the command sequences are transcribed from Seeed's own
 * driver for this panel, Seeed-Studio/Seeed_GFX:
 *   TFT_Drivers/T133A01_Defines.h   EPD_INIT / EPD_UPDATE / EPD_PUSH_NEW_COLORS
 *   TFT_Drivers/T133A01_Init.h      reset timing
 *   TFT_eSPI.h:317-323              the six-colour palette
 * Deviations are marked "NOTE:".
 *
 * The pin map — in particular that the second chip select is GPIO41, which no
 * Seeed document states — and the top/bottom framebuffer split come from
 * acegallagher/esphome-bigink (bigink.yaml:275-288, docs/HARDWARE.md). That
 * repository carries no LICENSE file, so what is taken from it is hardware
 * fact, not code. Its register values differ from Seeed's in four places; see
 * WP_EPD6_BIGINK_TUNING in epd6_panel.c.
 */
#pragma once

#include <stdbool.h>
#include <stdint.h>
#include <esp_err.h>
#include <driver/spi_master.h>

#include "epd6_transpose.h"     /* EPD6_W / EPD6_H / framebuffer layout */

#ifdef __cplusplus
extern "C" {
#endif

/* epd6_color_t and EPD6_COLOR_COUNT come from epd6_transpose.h — they describe
 * the framebuffer format, which the simulator and the host tests share. */

typedef struct {
    int sck;
    int mosi;
    int cs_master;          /* UC8179 #1 — framebuffer rows    0..599  */
    int cs_slave;           /* UC8179 #2 — framebuffer rows  600..1199 */
    int dc;
    int rst;                /* wired to both controllers */
    int busy;               /* wired to both; active LOW, idle HIGH    */
    int power;              /* panel rail enable, active HIGH; -1 if hardwired */
    spi_host_device_t host;
} epd6_pins_t;

/* Bring up SPI and GPIO, reset and initialise both controllers, and leave the
 * panel showing white with its rail off. Safe to call once; returns
 * ESP_ERR_INVALID_STATE after that. Blocks for a full refresh. */
esp_err_t epd6_init(const epd6_pins_t *pins);

/* --- framebuffer (no panel traffic) -------------------------------------- */

void epd6_clear(epd6_color_t color);
void epd6_set_pixel(uint16_t x, uint16_t y, epd6_color_t color);

/* Raw framebuffer, 4bpp packed — EPD6_FB_SIZE bytes. For the image blitter and
 * the self-test patterns; use epd6_fb_get/put from epd6_transpose.h to address
 * it rather than open-coding the nibble arithmetic. */
uint8_t *epd6_framebuffer(void);

/* --- presenting ----------------------------------------------------------- */

/* Push the framebuffer and refresh. Powers the panel up, re-initialises both
 * controllers, streams 480,000 bytes to each, refreshes, and powers back down.
 *
 * Expect twenty to thirty seconds. epd6_last_refresh_ms() reports what it
 * actually took on this board, which is how the polling policy gets its numbers
 * instead of inheriting them from a panel a fifth the area. */
void epd6_refresh(void);

/* Duration of the last epd6_refresh(), in milliseconds; 0 before the first. */
int epd6_last_refresh_ms(void);

/* Put both controllers in deep sleep. epd6_refresh() already does this at the
 * end of every refresh, so this is only for an explicit shutdown path. */
void epd6_sleep(void);

/* Cycle a set of test patterns, each with its own refresh: six colour bars,
 * white, black, a 1px checkerboard, and a border-plus-diagonals frame with an
 * unambiguous origin block. Verifies wiring, both chip selects, the colour
 * codes and the rotation.
 *
 * Six refreshes at ~25 s each — this blocks for two to three MINUTES. Call it
 * from a task, never from an HTTP handler. */
void epd6_selftest(void);

#ifdef __cplusplus
}
#endif
