/*
 * epd6_panel.c — Seeed 13.3" Spectra 6, two UC8179 controllers, 1200x1600x4bpp.
 *
 * Command sequences transcribed from Seeed's own driver for this exact panel,
 * Seeed-Studio/Seeed_GFX TFT_Drivers/T133A01_Defines.h — EPD_INIT() (L174-220),
 * EPD_PUSH_NEW_COLORS() (L241-285) and EPD_UPDATE() (L149-164) — with the reset
 * timing from T133A01_Init.h. Deviations are marked "NOTE:".
 *
 * WHY THE GEOMETRY IS WHAT IT IS
 * ------------------------------
 * Seeed sets TRES to 1200 x 800 (T133A01_Defines.h:76-78), so each controller
 * is 1200 pixels wide by 800 rows — 600 bytes per row at 4bpp, 480,000 bytes.
 * Two of them stacked make the panel's native portrait 1200 x 1600.
 *
 * The framebuffer is that native portrait, and each controller takes half of
 * every framebuffer row — the master the left 600 px, the slave the right. One
 * controller row of 1200 px is two of those halves from two adjacent rows, and
 * 800 controller rows consume all 1600. That identity is what makes the pack in
 * epd6_transpose.c a plain copy; the derivation showing it sends the same bytes
 * the earlier landscape port did is in epd6_transpose.h, and test_epd6_transpose
 * checks it byte-for-byte against a reference written from that derivation.
 *
 * Nothing below changed when the orientation did. TRES, the register tables and
 * the command sequences describe the wire, and the wire never saw the rotation.
 *
 * TRANSPORT
 * ---------
 * spi_master directly, with `spics_io_num = -1`: both chip selects are plain
 * GPIOs here because the init sequence needs commands that BOTH controllers
 * receive, which means both CS low at once. esp_lcd's panel-IO owns one CS and
 * queues transactions asynchronously; neither fits. Every transfer below is
 * blocking, so CS timing is exactly what the code says it is.
 */
#include <string.h>

#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <driver/gpio.h>
#include <esp_check.h>
#include <esp_heap_caps.h>
#include <esp_log.h>
#include <esp_timer.h>

#include "epd6_panel.h"

static const char *TAG = "epd6";

/* --- UC8179 command set (only what this panel's sequence uses) ------------ */
#define CMD_PSR                0x00   /* panel setting          */
#define CMD_PWR                0x01   /* power setting          */
#define CMD_POF                0x02   /* power off              */
#define CMD_PON                0x04   /* power on               */
#define CMD_BTST_N             0x05   /* booster soft start, negative */
#define CMD_BTST_P             0x06   /* booster soft start, positive */
#define CMD_DEEP_SLEEP         0x07
#define CMD_DTM                0x10   /* data transmission      */
#define CMD_DRF                0x12   /* display refresh        */
#define CMD_CDI                0x50   /* VCOM and data interval */
#define CMD_TRES               0x61   /* resolution             */
#define CMD_DCDC               0xA5
#define CMD_CCSET              0xE0
#define CMD_PWS                0xE3   /* power saving           */

#define DEEP_SLEEP_MAGIC       0xA5

/*
 * Register values, from T133A01_Defines.h unless noted.
 *
 * WP_EPD6_BIGINK_TUNING swaps in the three values where acegallagher/esphome-
 * bigink differs from Seeed (seeed_epaper_spectra6.cpp:66-73). Seeed's are the
 * default: they are the panel vendor's own table, and bigink additionally omits
 * DCDC entirely, which its author does not claim to have reasoned about
 * ("I won't pretend to really know what I'm doing", HARDWARE.md).
 *
 * If the panel comes up faint, ghosted, or with visible banding at the far end
 * of the source lines, build with -DWP_EPD6_BIGINK_TUNING=1 and compare. Those
 * are booster-drive symptoms and BTST is the register that would cause them.
 */
#ifndef WP_EPD6_BIGINK_TUNING
#define WP_EPD6_BIGINK_TUNING 0
#endif

#if WP_EPD6_BIGINK_TUNING
static const uint8_t R74_V[9]    = { 0xC0, 0x1C, 0x1C, 0xCC, 0xCC, 0xCC, 0x15, 0x15, 0x55 };
static const uint8_t BTST_P_V[2] = { 0xD8, 0x18 };
static const uint8_t BTST_N_V[2] = { 0xD8, 0x18 };
#else
static const uint8_t R74_V[9]    = { 0x00, 0x0C, 0x0C, 0xD9, 0xDD, 0xDD, 0x15, 0x15, 0x55 };
static const uint8_t BTST_P_V[2] = { 0xE0, 0x20 };
static const uint8_t BTST_N_V[2] = { 0xE0, 0x20 };
#endif

static const uint8_t RF0_V[6]    = { 0x49, 0x55, 0x13, 0x5D, 0x05, 0x10 };
static const uint8_t PSR_V[2]    = { 0xDF, 0x69 };
static const uint8_t DCDC_V[3]   = { 0x44, 0x54, 0x00 };
static const uint8_t CDI_V[1]    = { 0x37 };
static const uint8_t R60_V[2]    = { 0x03, 0x03 };
static const uint8_t R86_V[1]    = { 0x10 };
static const uint8_t PWS_V[1]    = { 0x22 };
static const uint8_t TRES_V[4]   = { 0x04, 0xB0, 0x03, 0x20 };   /* 1200 x 800 */
static const uint8_t PWR_V[6]    = { 0x0F, 0x00, 0x28, 0x2C, 0x28, 0x38 };
static const uint8_t RB6_V[1]    = { 0x07 };
static const uint8_t RB7_V[1]    = { 0x01 };
static const uint8_t RB0_V[1]    = { 0x01 };
static const uint8_t RB1_V[1]    = { 0x02 };
static const uint8_t CCSET_V[1]  = { 0x01 };
static const uint8_t DRF_V[1]    = { 0x01 };
static const uint8_t POF_V[1]    = { 0x00 };

/* BUSY timeouts. A Spectra 6 refresh is twenty to thirty seconds and the
 * controller holds BUSY low for all of it, so 60 s means "the panel is not
 * there", not "the panel is slow". */
#define BUSY_MS_RESET          2000
#define BUSY_MS_POWER          5000
#define BUSY_MS_REFRESH        60000

/* Output rows packed per SPI transfer. 64 x 300 = 19,200 bytes of internal
 * DMA-capable RAM, and 25 transfers per controller. Larger buys nothing: the
 * whole push is under a second either way against a refresh of thirty. */
#define BLOCK_ROWS             64
#define BLOCK_BYTES            (BLOCK_ROWS * EPD6_OUT_STRIDE)

static spi_device_handle_t s_spi;
static uint8_t            *s_fb;          /* PSRAM, EPD6_FB_SIZE            */
static uint8_t            *s_block;       /* internal DMA RAM, BLOCK_BYTES  */
static epd6_pins_t         s_pins;
static bool                s_ready;
static int                 s_last_refresh_ms;

/* --- low level ------------------------------------------------------------ */

static inline void pin(int gpio, int level)
{
    gpio_set_level((gpio_num_t)gpio, level);
}

static void spi_tx(const uint8_t *data, size_t len)
{
    if (len == 0) {
        return;
    }
    spi_transaction_t t = {
        .length    = len * 8,
        .tx_buffer = data,
    };
    ESP_ERROR_CHECK(spi_device_transmit(s_spi, &t));
}

/*
 * Seeed's writecommanddata(): toggles the MASTER chip select around one command
 * and its parameters. The SLAVE select is the caller's business — when it is
 * already low, both controllers receive this; when it is high, only the master
 * does. That single convention is the whole of the dual-controller protocol.
 */
static void wr(uint8_t cmd, const uint8_t *data, size_t len)
{
    pin(s_pins.dc, 0);                      /* command */
    pin(s_pins.cs_master, 0);
    spi_tx(&cmd, 1);
    if (len) {
        pin(s_pins.dc, 1);                  /* data */
        spi_tx(data, len);
    }
    pin(s_pins.cs_master, 1);
}

static inline void slave_sel(bool on)   { pin(s_pins.cs_slave, on ? 0 : 1); }
static inline void ms(int n)            { vTaskDelay(pdMS_TO_TICKS(n)); }

/* Send to both controllers: assert the slave select around a master write. */
static void wr_both(uint8_t cmd, const uint8_t *data, size_t len)
{
    slave_sel(true);
    wr(cmd, data, len);
    slave_sel(false);
}

/*
 * Seeed's CHECK_BUSY(): delay first, then sample — BUSY is active LOW, so the
 * panel is idle when the pin reads HIGH.
 *
 * NOTE: Seeed spins forever. A stuck BUSY means the panel is not wired or not
 * powered, and hanging the UI task on that is worse than carrying on with a
 * warning; the self-test exists to surface it loudly.
 *
 * NOTE: the 5.83" driver in this project's ancestry pokes GET_STATUS (0x71)
 * before each sample, because Waveshare's UC8179 code does. Seeed's driver for
 * *this* panel reads the pin alone, and a 0x71 issued while the slave select is
 * low would reach both controllers at once. Follow Seeed here.
 */
static bool wait_busy(int timeout_ms)
{
    int64_t deadline = esp_timer_get_time() + (int64_t)timeout_ms * 1000;
    for (;;) {
        ms(10);
        if (gpio_get_level((gpio_num_t)s_pins.busy) == 1) {
            return true;
        }
        if (esp_timer_get_time() > deadline) {
            ESP_LOGE(TAG, "BUSY stuck low for %d ms — panel wired and powered?",
                     timeout_ms);
            return false;
        }
    }
}

static void hw_reset(void)
{
    /* T133A01_Init.h: 20 ms each way. bigink uses 10; the vendor's is longer
     * and costs 20 ms once per refresh. */
    pin(s_pins.rst, 0);
    ms(20);
    pin(s_pins.rst, 1);
    ms(20);
    wait_busy(BUSY_MS_RESET);
}

static void power_on(void)
{
    if (s_pins.power >= 0) {
        pin(s_pins.power, 1);
        ms(100);                    /* let the panel rail settle */
    }
}

static void power_off(void)
{
    if (s_pins.power >= 0) {
        pin(s_pins.power, 0);
    }
}

/* --- initialisation ------------------------------------------------------- */

/*
 * EPD_INIT(), T133A01_Defines.h:174-220, in order. The slave-select toggles are
 * the vendor's, not tidied: which registers reach both controllers and which
 * reach only the master is the part of this sequence that cannot be guessed.
 */
static void panel_init(void)
{
    hw_reset();

    wr(0x74, R74_V, sizeof R74_V);                  /* master only */

    slave_sel(true);
    ms(10);
    wr(0xF0, RF0_V, sizeof RF0_V);
    slave_sel(false);
    ms(10);

    wr_both(CMD_PSR, PSR_V, sizeof PSR_V);
    ms(10);

    wr(CMD_DCDC, DCDC_V, sizeof DCDC_V);            /* master only */
    ms(10);

    wr_both(CMD_CDI, CDI_V, sizeof CDI_V);
    ms(10);
    wr_both(0x60, R60_V, sizeof R60_V);
    ms(10);
    wr_both(0x86, R86_V, sizeof R86_V);
    ms(10);
    wr_both(CMD_PWS, PWS_V, sizeof PWS_V);
    ms(10);
    wr_both(CMD_TRES, TRES_V, sizeof TRES_V);
    ms(10);

    wr(CMD_PWR, PWR_V, sizeof PWR_V);               /* master only, from here */
    ms(10);
    wr(0xB6, RB6_V, sizeof RB6_V);
    ms(10);
    wr(CMD_BTST_P, BTST_P_V, sizeof BTST_P_V);
    ms(10);
    wr(0xB7, RB7_V, sizeof RB7_V);
    ms(10);
    wr(CMD_BTST_N, BTST_N_V, sizeof BTST_N_V);
    ms(10);
    wr(0xB0, RB0_V, sizeof RB0_V);
    ms(10);
    wr(0xB1, RB1_V, sizeof RB1_V);
    ms(10);
}

/* One-shot connectivity probe, kept from the 5.83" port because it tells the
 * three failures apart that all look like a dead screen: FPC not seated, panel
 * present and idle, panel present but not idling the way a UC8179 does. */
static void busy_line_probe(void)
{
    const gpio_num_t b = (gpio_num_t)s_pins.busy;

    gpio_set_pull_mode(b, GPIO_PULLUP_ONLY);
    ms(2);
    int up = gpio_get_level(b);

    gpio_set_pull_mode(b, GPIO_PULLDOWN_ONLY);
    ms(2);
    int dn = gpio_get_level(b);

    gpio_set_pull_mode(b, GPIO_FLOATING);

    if (up == 1 && dn == 0) {
        ESP_LOGE(TAG, "BUSY follows the weak pulls — nothing is driving it. "
                      "Panel not connected: check the FPC orientation and latch.");
    } else if (up == 1 && dn == 1) {
        ESP_LOGI(TAG, "BUSY driven HIGH — both controllers idle, as expected");
    } else {
        ESP_LOGW(TAG, "BUSY driven LOW after init — a controller still thinks it "
                      "is busy. Wrong panel on the FPC, or CS1 (GPIO%d) not wired?",
                 s_pins.cs_slave);
    }
}

/* --- pushing pixels ------------------------------------------------------- */

/* Stream one controller's plane. The chip selects are set by the caller; this
 * sends DTM and then 480,000 bytes, packed a block at a time. */
static void push_plane(int plane)
{
    pin(s_pins.dc, 0);
    const uint8_t dtm = CMD_DTM;
    spi_tx(&dtm, 1);
    pin(s_pins.dc, 1);

    for (int r0 = 0; r0 < EPD6_OUT_ROWS; r0 += BLOCK_ROWS) {
        int n = BLOCK_ROWS;
        if (r0 + n > EPD6_OUT_ROWS) {
            n = EPD6_OUT_ROWS - r0;
        }
        epd6_pack_block(s_fb, plane, r0, n, s_block);
        spi_tx(s_block, (size_t)n * EPD6_OUT_STRIDE);
    }
}

/*
 * EPD_PUSH_NEW_COLORS(), T133A01_Defines.h:241-285: colour mode to both, then
 * the master's half, then the slave's, each behind its own DTM.
 *
 * NOTE: Seeed converts every nibble through COLOR_GET() as it streams. This
 * port stores the hardware codes in the framebuffer to begin with (see
 * epd6_color_t), so there is nothing to convert here — which is also why the
 * pack loop can be a straight copy and hand DMA a finished buffer.
 */
static void push_frame(void)
{
    slave_sel(true);
    wr(CMD_CCSET, CCSET_V, sizeof CCSET_V);
    slave_sel(false);
    wait_busy(BUSY_MS_POWER);
    ms(10);

    int64_t t0 = esp_timer_get_time();

    slave_sel(false);                       /* master alone */
    pin(s_pins.cs_master, 0);
    push_plane(EPD6_PLANE_MASTER);
    pin(s_pins.cs_master, 1);

    pin(s_pins.cs_master, 1);               /* slave alone */
    slave_sel(true);
    push_plane(EPD6_PLANE_SLAVE);
    slave_sel(false);

    ESP_LOGD(TAG, "pushed 2 x %u B in %d ms", (unsigned)EPD6_PLANE_BYTES,
             (int)((esp_timer_get_time() - t0) / 1000));
}

/*
 * EPD_UPDATE(), T133A01_Defines.h:149-164. The slave select stays LOW across
 * each command AND its BUSY wait, then goes high with a 30 ms settle — that
 * pairing is load-bearing, not decoration: the wait has to observe both
 * controllers.
 */
static void update_panel(void)
{
    slave_sel(true);
    wr(CMD_PON, NULL, 0);
    wait_busy(BUSY_MS_POWER);
    slave_sel(false);
    ms(30);

    slave_sel(true);
    wr(CMD_DRF, DRF_V, sizeof DRF_V);
    wait_busy(BUSY_MS_REFRESH);             /* twenty to thirty seconds */
    slave_sel(false);
    ms(30);

    slave_sel(true);
    wr(CMD_POF, POF_V, sizeof POF_V);
    wait_busy(BUSY_MS_POWER);
    slave_sel(false);
    ms(30);
}

/* --- public --------------------------------------------------------------- */

esp_err_t epd6_init(const epd6_pins_t *pins)
{
    if (s_ready) {
        return ESP_ERR_INVALID_STATE;
    }
    s_pins = *pins;

    /* Outputs first, and idle before the rail comes up: a floating chip select
     * while the panel powers on is a command the controller half-hears. */
    gpio_config_t out = {
        .pin_bit_mask = (1ULL << s_pins.rst) | (1ULL << s_pins.dc) |
                        (1ULL << s_pins.cs_master) | (1ULL << s_pins.cs_slave),
        .mode         = GPIO_MODE_OUTPUT,
        .intr_type    = GPIO_INTR_DISABLE,
    };
    ESP_RETURN_ON_ERROR(gpio_config(&out), TAG, "control gpio");
    pin(s_pins.cs_master, 1);
    pin(s_pins.cs_slave, 1);
    pin(s_pins.dc, 0);
    pin(s_pins.rst, 1);

    if (s_pins.power >= 0) {
        gpio_config_t pwr = {
            .pin_bit_mask = 1ULL << s_pins.power,
            .mode         = GPIO_MODE_OUTPUT,
            .intr_type    = GPIO_INTR_DISABLE,
        };
        ESP_RETURN_ON_ERROR(gpio_config(&pwr), TAG, "power gpio");
        pin(s_pins.power, 0);
    }

    gpio_config_t in = {
        .pin_bit_mask = 1ULL << s_pins.busy,
        .mode         = GPIO_MODE_INPUT,
        .pull_up_en   = GPIO_PULLUP_DISABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type    = GPIO_INTR_DISABLE,
    };
    ESP_RETURN_ON_ERROR(gpio_config(&in), TAG, "busy gpio");

    spi_bus_config_t buscfg = {
        .mosi_io_num     = s_pins.mosi,
        .miso_io_num     = -1,
        .sclk_io_num     = s_pins.sck,
        .quadwp_io_num   = -1,
        .quadhd_io_num   = -1,
        .max_transfer_sz = BLOCK_BYTES + 64,
    };
    ESP_RETURN_ON_ERROR(spi_bus_initialize(s_pins.host, &buscfg, SPI_DMA_CH_AUTO),
                        TAG, "spi bus");

    /* spics_io_num = -1: this driver owns both chip selects. See the file
     * header for why that is not a shortcut. */
    spi_device_interface_config_t devcfg = {
        .clock_speed_hz = 10 * 1000 * 1000,
        .mode           = 0,
        .spics_io_num   = -1,
        .queue_size     = 1,
    };
    ESP_RETURN_ON_ERROR(spi_bus_add_device(s_pins.host, &devcfg, &s_spi),
                        TAG, "spi device");

    /* 960,000 bytes — PSRAM is not an optimisation here, the S3's internal RAM
     * is half this size. The DMA staging block is what has to be internal. */
    s_fb = heap_caps_malloc(EPD6_FB_SIZE, MALLOC_CAP_SPIRAM);
    if (!s_fb) {
        ESP_LOGE(TAG, "need %u B of PSRAM for the framebuffer; %u B is free",
                 (unsigned)EPD6_FB_SIZE,
                 (unsigned)heap_caps_get_free_size(MALLOC_CAP_SPIRAM));
        ESP_LOGE(TAG, "this firmware needs a XIAO ESP32-S3 *Plus* (8 MB octal "
                      "PSRAM) with CONFIG_SPIRAM enabled");
        return ESP_ERR_NO_MEM;
    }
    epd6_clear(EPD6_WHITE);

    s_block = heap_caps_malloc(BLOCK_BYTES, MALLOC_CAP_DMA | MALLOC_CAP_INTERNAL);
    ESP_RETURN_ON_FALSE(s_block, ESP_ERR_NO_MEM, TAG, "dma staging block");

    power_on();
    panel_init();
    busy_line_probe();

    ESP_LOGI(TAG, "Spectra 6 %dx%d up (fb %u B in PSRAM, %u B DMA staging)",
             EPD6_W, EPD6_H, (unsigned)EPD6_FB_SIZE, (unsigned)BLOCK_BYTES);

    epd6_refresh();          /* land on a known-clean white panel */
    s_ready = true;
    return ESP_OK;
}

void epd6_clear(epd6_color_t color)
{
    if (s_fb) {
        uint8_t c = (uint8_t)(color & 0x0F);
        memset(s_fb, (uint8_t)((c << 4) | c), EPD6_FB_SIZE);
    }
}

void epd6_set_pixel(uint16_t x, uint16_t y, epd6_color_t color)
{
    if (x >= EPD6_W || y >= EPD6_H || !s_fb) {
        return;
    }
    epd6_fb_put(s_fb, x, y, (uint8_t)color);
}

uint8_t *epd6_framebuffer(void)
{
    return s_fb;
}

void epd6_refresh(void)
{
    if (!s_fb) {
        return;
    }
    int64_t t0 = esp_timer_get_time();

    /*
     * Power up and re-initialise every time. bigink gets away without this
     * because it deep-sleeps the ESP32 between updates and so re-runs setup();
     * this board stays awake serving a control API, so the rail it switched off
     * at the end of the last refresh has to come back on here.
     */
    power_on();
    panel_init();

    push_frame();
    update_panel();

    /* NOTE: Seeed's EPD_SLEEP() sends this to the master only and then waits on
     * BUSY. Send it to both — one controller left awake keeps drawing — and do
     * not wait: a controller that has accepted deep sleep may never raise BUSY
     * again, and there is nothing after this to protect. */
    wr_both(CMD_DEEP_SLEEP, (const uint8_t[]){ DEEP_SLEEP_MAGIC }, 1);
    ms(10);

    power_off();

    s_last_refresh_ms = (int)((esp_timer_get_time() - t0) / 1000);
    ESP_LOGI(TAG, "refresh %d ms", s_last_refresh_ms);
}

int epd6_last_refresh_ms(void)
{
    return s_last_refresh_ms;
}

void epd6_sleep(void)
{
    if (!s_ready) {
        return;
    }
    wr_both(CMD_DEEP_SLEEP, (const uint8_t[]){ DEEP_SLEEP_MAGIC }, 1);
    ms(10);
    power_off();
}

/* --- self-test ------------------------------------------------------------
 * Four refreshes, roughly a hundred seconds. Each one answers a question the
 * others cannot. */

static const epd6_color_t BARS[EPD6_COLOR_COUNT] = {
    EPD6_BLACK, EPD6_WHITE, EPD6_RED, EPD6_YELLOW, EPD6_GREEN, EPD6_BLUE,
};

/* Six vertical bars, 200 px each. Proves the colour codes, and — because the
 * plane split is down the middle of the page — proves both controllers received
 * their half without any ambiguity about which: black, white and red are the
 * master's, yellow, green and blue the slave's. A dead slave is the right half
 * of the page blank — and that reading holds even if the row order turns out to
 * be reversed, since a reversal trades top for bottom and leaves left and right
 * where they are. The frame pattern below is what settles that separately. */
static void pattern_bars(void)
{
    for (int x = 0; x < EPD6_W; x++) {
        epd6_color_t c = BARS[(x * EPD6_COLOR_COUNT) / EPD6_W];
        for (int y = 0; y < EPD6_H; y++) {
            epd6_set_pixel((uint16_t)x, (uint16_t)y, c);
        }
    }
    /* A notch near the top of the leftmost bar, white because that bar is black.
     * The bars themselves are unchanged by a vertical flip; the notch is the one
     * thing in this pattern that moves. */
    for (int y = 40; y < 120; y++) {
        for (int x = 40; x < 160; x++) {
            epd6_set_pixel((uint16_t)x, (uint16_t)y, EPD6_WHITE);
        }
    }
}

/* 1px checkerboard. Catches a stuck source line or a nibble-order mistake,
 * neither of which a flat fill can show. */
static void pattern_checker(void)
{
    for (int y = 0; y < EPD6_H; y++) {
        for (int x = 0; x < EPD6_W; x++) {
            epd6_set_pixel((uint16_t)x, (uint16_t)y,
                           ((x ^ y) & 1) ? EPD6_WHITE : EPD6_BLACK);
        }
    }
}

/*
 * Border, both diagonals, and a solid green block in the TOP-LEFT corner. Proves
 * the last row and column are reachable, and settles the one question the whole
 * stack has no other answer to: whether the page came out upside down.
 *
 * Nothing between the framebuffer and the glass has a handedness except the
 * order the output rows go out in, and a reversal there is a vertical flip. The
 * bars survive one, the checkerboard survives one, and a border survives one.
 * This block does not: green in the top-left is right, green in the bottom-left
 * means reverse the row order in epd6_pack_block. The diagonals carry the same
 * answer redundantly — red runs top-left to bottom-right — because the answer
 * decides whether to change a line of code, and one indicator that could be
 * misread is not enough to change code on.
 *
 * Each element gets its own colour so a mis-wired chip select shows up as a
 * colour, not just a gap.
 */
static void pattern_frame(void)
{
    epd6_clear(EPD6_WHITE);
    for (int x = 0; x < EPD6_W; x++) {
        epd6_set_pixel((uint16_t)x, 0, EPD6_BLACK);
        epd6_set_pixel((uint16_t)x, EPD6_H - 1, EPD6_BLACK);
    }
    for (int y = 0; y < EPD6_H; y++) {
        epd6_set_pixel(0, (uint16_t)y, EPD6_BLACK);
        epd6_set_pixel(EPD6_W - 1, (uint16_t)y, EPD6_BLACK);

        /* Step the long axis. The panel is taller than it is wide, so walking x
         * and deriving y would advance y by more than one per pixel and draw
         * both diagonals dashed. */
        int x = (y * (EPD6_W - 1)) / (EPD6_H - 1);
        epd6_set_pixel((uint16_t)x, (uint16_t)y, EPD6_RED);
        epd6_set_pixel((uint16_t)(EPD6_W - 1 - x), (uint16_t)y, EPD6_BLUE);
    }
    for (int y = 40; y < 140; y++) {
        for (int x = 40; x < 240; x++) {
            epd6_set_pixel((uint16_t)x, (uint16_t)y, EPD6_GREEN);
        }
    }
}

void epd6_selftest(void)
{
    if (!s_ready) {
        ESP_LOGE(TAG, "selftest: panel not initialised");
        return;
    }

    ESP_LOGI(TAG, "selftest: six colour bars (black white red yellow green blue,"
                  " left to right; the last three are the slave's half, and the"
                  " notch is white near the top of the black bar)");
    pattern_bars();
    epd6_refresh();

    ESP_LOGI(TAG, "selftest: 1px checkerboard");
    pattern_checker();
    epd6_refresh();

    ESP_LOGI(TAG, "selftest: frame, diagonals (red top-left to bottom-right, blue"
                  " the other way), green block in the TOP-LEFT — if it comes out"
                  " bottom-left the output row order is reversed");
    pattern_frame();
    epd6_refresh();

    ESP_LOGI(TAG, "selftest: done — last refresh %d ms; restoring white",
             s_last_refresh_ms);
    epd6_clear(EPD6_WHITE);
    epd6_refresh();
}
