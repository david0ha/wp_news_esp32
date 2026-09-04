# IDF component: the portable news core + the device-only HTTP port.
# (The desktop simulator does NOT use this file — it compiles the portable
#  sources directly and supplies http_port_curl.c instead of http_port_esp.c.)
#
# cJSON is vendored (third_party/cJSON) rather than depended on: ESP-IDF v6 moved
# cJSON out of core components, and vendoring keeps the firmware, simulator and
# host tests on byte-identical parser code.
set(CJSON_DIR ${CMAKE_CURRENT_SOURCE_DIR}/../../third_party/cJSON)

idf_component_register(
    SRCS
        "wp_palette.c"
        "news_model.c"
        "news_parse.c"
        "news_mock.c"
        "news_service.c"
        "device_api_json.c"
        "ui_common.c"
        "ui_format.c"
        "ui_lang.c"
        "ui_compose.c"
        "ui_fit.c"
        "ui_chart.c"
        "ui_tile.c"
        "ui_modules.c"
        "ui_news.c"
        "ui_page_front.c"
        "ui_page_markets.c"
        "fonts/ui_font_masthead_112.c"
        "fonts/ui_font_display_56.c"
        "fonts/ui_font_display_36.c"
        "fonts/ui_font_deck_24.c"
        "fonts/ui_font_body_20.c"
        "fonts/ui_font_body_16.c"
        "fonts/ui_font_label_14.c"
        # The Korean faces. No call site names one; each is reached through the
        # matching Latin face's `.fallback`, which is why they must be listed
        # here even though nothing in the tree references them by name.
        "fonts/ui_font_ko_display_56.c"
        "fonts/ui_font_ko_display_36.c"
        "fonts/ui_font_ko_deck_24.c"
        "fonts/ui_font_ko_body_20.c"
        "fonts/ui_font_ko_body_16.c"
        "fonts/ui_font_ko_label_14.c"
        "http_port_esp.c"
        "${CJSON_DIR}/cJSON.c"
    INCLUDE_DIRS "include" "${CJSON_DIR}"
    REQUIRES
        # wp_palette.h includes epd6_transpose.h for the colour codes and the
        # framebuffer layout — both are panel *format*, not panel traffic, and
        # the simulator compiles the same pair.
        port_bsp
        lvgl__lvgl
        esp_http_client
        esp-tls
        mbedtls)

# lv_font_conv emits `#include "lvgl/lvgl.h"` unless LV_LVGL_H_INCLUDE_SIMPLE is
# defined, and the IDF component exposes the header as plain "lvgl.h". Without
# this the thirteen generated faces in fonts/ are the only files in the project
# that fail to compile.
target_compile_definitions(${COMPONENT_LIB} PRIVATE LV_LVGL_H_INCLUDE_SIMPLE)
