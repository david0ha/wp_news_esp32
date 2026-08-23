/*
 * board_io.h — the board's power sensing.
 *
 * On the EE04 this is only the battery: there is no RTC on the board, and the
 * two pins the previous carrier routed to an I2C header (GPIO5/GPIO6) are a
 * user button and the battery divider's load-switch enable here. The clock
 * therefore comes from SNTP alone — see net_time.c.
 *
 * The battery divider is 1:3 and sits BEHIND a load switch, so it reads noise
 * until its enable is driven HIGH. board_io_init() drives it and leaves it on
 * for as long as the board is awake.
 *
 * That used to be the end of the sentence, followed by the claim that the
 * divider's standing draw "is a few microamps, which is nothing against a board
 * whose panel is the interesting load". That was true of a board that never
 * slept and it is false now. On a board that spends 99.7% of its life in deep
 * sleep drawing tens of microamps, a divider left conducting from the cell is
 * not a rounding error against the panel — it is comparable to everything else
 * put together, and it is drawn continuously to measure nothing, because
 * nothing is awake to read it. Hence board_io_sleep(), which must be called
 * before every deep sleep.
 *
 * Every getter is defensive: if the ADC is unavailable it returns 0 instead of
 * blocking, so a depopulated part never wedges the render loop.
 */
#pragma once

#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Bring up the battery ADC on `adc_gpio` and drive `enable_gpio` HIGH.
 * Pass enable_gpio < 0 if the divider is hardwired. Safe to call once at boot;
 * logs and continues if the ADC cannot be configured. */
void board_io_init(int adc_gpio, int enable_gpio);

/* Battery terminal voltage in volts (after undoing the 1:3 divider).
 * <= 0 on error or when no battery is fitted. */
float board_io_battery_voltage(void);

/* Battery charge estimate, 0..100, mapped from ~3.0V (empty) to ~4.12V (full).
 * 0 when the reading is not trustworthy — callers should treat 0 as "hide the
 * battery chip", not as "flat". */
int board_io_battery_percent(void);

/* Whether the last reading looked like a real cell rather than an open input.
 * USB-only operation with no battery fitted lands here. */
bool board_io_battery_present(void);

/* Drop the battery divider's load switch, and latch it down so it stays dropped
 * through a deep sleep. Call immediately before esp_deep_sleep_start().
 *
 * Every getter reads 0 afterwards, which is why this is a shutdown call and not
 * a power-saving one: board_io_init() puts the divider back. Harmless if the
 * enable pin was never supplied. */
void board_io_sleep(void);

#ifdef __cplusplus
}
#endif
