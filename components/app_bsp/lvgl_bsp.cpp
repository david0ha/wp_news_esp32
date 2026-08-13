#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <freertos/FreeRTOS.h>
#include <esp_heap_caps.h>
#include <esp_log.h>
#include <esp_timer.h>
#include "lvgl_bsp.h"

static SemaphoreHandle_t lvgl_mux = NULL;
#define BYTES_PER_PIXEL (LV_COLOR_FORMAT_GET_SIZE(LV_COLOR_FORMAT_RGB565))

/*
 * Strip height for partial rendering.
 *
 * The 5.83" board this forked from rendered the whole screen into two RGB565
 * buffers and handed the flush callback one finished frame. That does not
 * survive the move to 1600x1200: a full-screen RGB565 buffer is 3.84 MB, two of
 * them 7.68 MB, and the panel's own 4bpp framebuffer already wants 960 KB of
 * the 8 MB fitted. It does not fit, and no amount of care makes it fit.
 *
 * So LVGL renders in horizontal strips instead. One 1600x120 buffer is 384 KB
 * and the screen arrives as ten of them. A second buffer would buy nothing: the
 * flush callback here is a synchronous CPU quantize into the panel framebuffer
 * and returns having already finished, so there is never a transfer in flight
 * for the second buffer to overlap with.
 *
 * Partial rendering also means LVGL only redraws what changed. That is exactly
 * right for e-Paper — the panel framebuffer persists between refreshes, so an
 * unchanged region simply keeps the pixels it already had.
 */
#define LVGL_STRIP_H 120

static const char *TAG = "LvglPort";

static void Increase_lvgl_tick(void *arg)
{
  	lv_tick_inc(LVGL_TICK_PERIOD_MS);
}

bool Lvgl_lock(int timeout_ms)
{
  	const TickType_t timeout_ticks = (timeout_ms == -1) ? portMAX_DELAY : pdMS_TO_TICKS(timeout_ms);
  	return xSemaphoreTake(lvgl_mux, timeout_ticks) == pdTRUE;
}

void Lvgl_unlock(void)
{
  	assert(lvgl_mux && "bsp_display_start must be called first");
  	xSemaphoreGive(lvgl_mux);
}

static void Lvgl_port_task(void *arg)
{
  	uint32_t task_delay_ms = LVGL_TASK_MAX_DELAY_MS;
  	for(;;)
  	{
  	  	if (Lvgl_lock(-1))
  	  	{
  	  	  	task_delay_ms = lv_timer_handler();
  	  	  	//Release the mutex
  	  	  	Lvgl_unlock();
  	  	}
  	  	if (task_delay_ms > LVGL_TASK_MAX_DELAY_MS)
  	  	{
  	  	  	task_delay_ms = LVGL_TASK_MAX_DELAY_MS;
  	  	} else if (task_delay_ms < LVGL_TASK_MIN_DELAY_MS)
  	  	{
  	  	  	task_delay_ms = LVGL_TASK_MIN_DELAY_MS;
  	  	}
  	  	vTaskDelay(pdMS_TO_TICKS(task_delay_ms));
  	}
}


void Lvgl_PortInit(int width, int height, DispFlushCb flush_cb) {
    lvgl_mux = xSemaphoreCreateMutex();
    lv_init();
    lv_display_t * disp = lv_display_create(width, height);
    lv_display_set_flush_cb(disp, flush_cb);

	// The failure is spelled out rather than left to a bare assert: "no PSRAM
	// fitted" and "PSRAM not configured" are the two ways a board that looks
	// identical to a working one refuses to boot, and the difference between a
	// named error and `assert(buffer)` is an afternoon.
	size_t buffer_size = (size_t)width * LVGL_STRIP_H * BYTES_PER_PIXEL;
	uint8_t *buffer = (uint8_t *)heap_caps_malloc(buffer_size, MALLOC_CAP_SPIRAM);
	if (!buffer) {
		ESP_LOGE(TAG, "need %u B of PSRAM for the draw buffer; %u B is free",
		         (unsigned)buffer_size,
		         (unsigned)heap_caps_get_free_size(MALLOC_CAP_SPIRAM));
		ESP_LOGE(TAG, "this firmware needs a XIAO ESP32-S3 *Plus* (8MB octal PSRAM) "
		              "with CONFIG_SPIRAM enabled");
	}
	assert(buffer);

    lv_display_set_buffers(disp, buffer, NULL, buffer_size,
                           LV_DISPLAY_RENDER_MODE_PARTIAL);
	ESP_LOGI(TAG, "LVGL %dx%d, partial in %d-row strips (%u B draw buffer)",
	         width, height, LVGL_STRIP_H, (unsigned)buffer_size);

    ESP_LOGI(TAG, "Install LVGL tick timer");
  	esp_timer_create_args_t lvgl_tick_timer_args = {};
  	lvgl_tick_timer_args.callback = &Increase_lvgl_tick;
  	lvgl_tick_timer_args.name = "lvgl_tick";
    esp_timer_handle_t lvgl_tick_timer = NULL;
  	ESP_ERROR_CHECK(esp_timer_create(&lvgl_tick_timer_args, &lvgl_tick_timer));
  	ESP_ERROR_CHECK(esp_timer_start_periodic(lvgl_tick_timer,LVGL_TICK_PERIOD_MS * 1000));

    xTaskCreatePinnedToCore(Lvgl_port_task, "LVGL", 8 * 1024, NULL, 5, NULL, 0);
}

void Lvgl_RenderNow(void)
{
	// On an LCD you let the LVGL task get to the redraw whenever it does. On
	// e-Paper the caller has to know the framebuffer is complete before it
	// triggers a refresh that takes half a minute, so force the redraw
	// synchronously here.
	if (Lvgl_lock(-1)) {
		lv_refr_now(NULL);
		Lvgl_unlock();
	}
}

void Lvgl_InvalidateAll(void)
{
	// Partial rendering means LVGL redraws only what it believes changed. That
	// belief is wrong the moment anything writes to the panel framebuffer
	// behind its back — the self-test patterns do exactly that — and the
	// symptom is a screen that keeps fragments of a test pattern until every
	// widget happens to change on its own.
	if (Lvgl_lock(-1)) {
		lv_obj_invalidate(lv_screen_active());
		Lvgl_unlock();
	}
}
