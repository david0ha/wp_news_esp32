#ifndef USER_CONFIG_H
#define USER_CONFIG_H

#include <driver/gpio.h>   /* GPIO_NUM_* used below */

/* ---------------------------------------------------------------------------
 * Board wiring — Seeed XIAO ePaper Display Board carrying a XIAO ESP32-S3 Plus,
 * driving the 13.3" Spectra 6 six-colour e-Paper over the 24-pin FPC.
 *
 * The display half is routed the same on the EE02 (the 13.3" carrier), the EE04
 * and the EE05 — Seeed's own library has one branch for all three
 * (Seeed_GFX/User_Setups/EPaper_Board_Pins_Setups.h). What the 13.3" adds is a
 * SECOND CHIP SELECT: the panel is two UC8179 controllers, and the one for the
 * bottom half hangs off GPIO41.
 *
 *   Net         XIAO pad  GPIO
 *   SPI0_SCL    D8        7
 *   SPI0_MOSI   D10       9
 *   SPI0_CS     D7        44   (UART0 RX by default — console must NOT be UART0)
 *   SPI0_CS1    D-        41   (second controller; see below)
 *   EDP_DC      D16       10
 *   EDP_RES     D11       38   (wired to both controllers)
 *   EDP_BUSY    D3        4    (wired to both; active LOW while refreshing)
 *   PWR_EN      D6        43   (UART0 TX by default; load switch feeding the
 *                               panel's 3.3V — pulled down, so the panel is
 *                               UNPOWERED until this is driven HIGH)
 *
 * GPIO41 appears in no Seeed document this project could find. It comes from
 * acegallagher/esphome-bigink (bigink.yaml:278), which is the only published
 * source that drives this panel without Seeed's cloud tooling. If the bottom
 * half of the screen stays blank while the top half is correct, this pin is the
 * first thing to check.
 *
 * Because GPIO43/44 are the default UART0 pins, the console runs on
 * USB Serial/JTAG (sdkconfig: ESP_CONSOLE_USB_SERIAL_JTAG) — a UART0 console
 * would clock log bytes straight into the panel's power-enable and CS lines.
 *
 * The carrier also gives us:
 *   - user buttons on GPIO2 / GPIO3 / GPIO5, all active low. GPIO3 is the
 *     hardware wake pin on the EE02, so treat a press there as "wake" rather
 *     than binding it to something destructive;
 *   - the battery divider's load switch on GPIO6, which must be HIGH before the
 *     ADC reads anything but noise;
 *   - therefore no free I2C, and no RTC on the board at all. The clock is SNTP.
 * ------------------------------------------------------------------------- */

/* Panel geometry. The panel is natively portrait 1200x1600; this firmware works
 * in landscape and rotates while packing — see epd6_transpose.h, which is where
 * EPD6_W/EPD6_H actually live. These two names exist for the LVGL bring-up call
 * in main.cpp and must agree with them. */
#define EPD_WIDTH      1600
#define EPD_HEIGHT     1200

#define EPD_SCK_PIN        GPIO_NUM_7
#define EPD_MOSI_PIN       GPIO_NUM_9
#define EPD_CS_PIN         GPIO_NUM_44   /* UC8179 #1 — top 600 rows    */
#define EPD_CS_SLAVE_PIN   GPIO_NUM_41   /* UC8179 #2 — bottom 600 rows */
#define EPD_DC_PIN         GPIO_NUM_10
#define EPD_RST_PIN        GPIO_NUM_38
#define EPD_BUSY_PIN       GPIO_NUM_4
#define EPD_POWER_PIN      GPIO_NUM_43   /* active HIGH, must be on before init */

/* Buttons, all press-to-GND. */
#define BTN_KEY0_PIN   GPIO_NUM_2
#define BTN_KEY1_PIN   GPIO_NUM_3
#define BTN_KEY2_PIN   GPIO_NUM_5
#define BTN_BOOT_PIN   GPIO_NUM_0

/* Battery sensing: a 1:3 divider on GPIO1 (ADC1 channel 0), behind a load
 * switch whose enable is GPIO6. The divider is disconnected — and the reading
 * is meaningless — until that is HIGH. */
#define BATT_ADC_PIN     GPIO_NUM_1
#define BATT_ENABLE_PIN  GPIO_NUM_6

#endif
