cmake_minimum_required(VERSION 3.16)
project(news_sim C)

set(CMAKE_C_STANDARD 11)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

# Our lv_conf.h (via #include "lv_conf.h").
add_compile_definitions(LV_CONF_INCLUDE_SIMPLE)
include_directories(${CMAKE_CURRENT_SOURCE_DIR})

# Trim the LVGL build.
set(LV_CONF_BUILD_DISABLE_EXAMPLES 1 CACHE INTERNAL "")
set(LV_CONF_BUILD_DISABLE_DEMOS 1 CACHE INTERNAL "")
set(LV_CONF_BUILD_DISABLE_THORVG_INTERNAL 1 CACHE INTERNAL "")

set(EX    ${CMAKE_CURRENT_SOURCE_DIR}/..)               # repo root = the IDF project
set(CORE  ${EX}/components/news_core)
set(BSP   ${EX}/components/port_bsp)
set(CJSON ${CMAKE_CURRENT_SOURCE_DIR}/../third_party/cJSON)

# LVGL comes from the IDF component manager on a machine that has run
# `idf.py build`. In a container there is no IDF and no managed_components/,
# and on a fresh checkout there is not one yet either — so fall back to
# fetching the same version the firmware pins. The tag matches
# main/idf_component.yml's `lvgl/lvgl: ^9.4.0`; pinning it here rather than
# tracking the range is deliberate, because a simulator that is a test must
# not change what it asserts when an upstream release lands.
set(LVGL_DIR ${EX}/managed_components/lvgl__lvgl)
if(EXISTS ${LVGL_DIR}/CMakeLists.txt)
    add_subdirectory(${LVGL_DIR} ${CMAKE_BINARY_DIR}/lvgl)
else()
    include(FetchContent)
    FetchContent_Declare(lvgl
        GIT_REPOSITORY https://github.com/lvgl/lvgl.git
        GIT_TAG        v9.4.0
        GIT_SHALLOW    TRUE)
    FetchContent_MakeAvailable(lvgl)
endif()

# The news core is compiled verbatim — same UI, same fonts, same logic as the
# firmware. Only the HTTP port is host-specific.
#
# wp_palette.c is in that list now, which it never was on the monochrome board:
# there the simulator's own threshold and the panel's were both "is this pixel
# dark", and any two implementations of that agree. Six inks do not work that
# way — which ink a mid grey lands on depends on the ordered-dither offset at
# that exact (x, y) — so the simulator quantizes through the same
# wp_quantize565() the flush callback calls, and a colour that dithers on the
# glass dithers in sim/shots/ too.
add_executable(sim
    main_sim.c
    http_port_curl.c
    ${CORE}/wp_palette.c
    ${CORE}/news_model.c
    ${CORE}/news_parse.c
    ${CORE}/news_mock.c
    ${CORE}/news_service.c
    ${CORE}/ui_common.c
    ${CORE}/ui_compose.c
    ${CORE}/ui_fit.c
    ${CORE}/ui_chart.c
    ${CORE}/ui_tile.c
    ${CORE}/ui_modules.c
    ${CORE}/ui_news.c
    ${CORE}/ui_page_front.c
    ${CORE}/ui_page_markets.c
    ${CORE}/fonts/ui_font_masthead_112.c
    ${CORE}/fonts/ui_font_display_56.c
    ${CORE}/fonts/ui_font_display_36.c
    ${CORE}/fonts/ui_font_deck_24.c
    ${CORE}/fonts/ui_font_body_20.c
    ${CORE}/fonts/ui_font_body_16.c
    ${CORE}/fonts/ui_font_label_14.c
    ${CJSON}/cJSON.c)

# ${CORE} (not just ${CORE}/include) is on the path so the simulator can include
# ui_internal.h. That header is private to the UI files by design — but the
# simulator asserts on the grid it defines, and duplicating the grid here is the
# one way to make the assertions lie.
#
# ${BSP} is here for epd6_transpose.h alone, which wp_palette.h includes for the
# six hardware colour codes and the 4bpp framebuffer layout. Both are panel
# FORMAT rather than panel traffic, and the header is free of ESP-IDF for
# exactly this reason: the simulator and the host tests need the colour codes,
# and neither can link a driver.
target_include_directories(sim PRIVATE ${CORE}/include ${CORE} ${BSP} ${CJSON})
target_link_libraries(sim lvgl curl m)

# Where the demo snapshot's photographs are.
#
# The built-in snapshot names a picture — `photo.id "nvda_hq"` — that no server
# is going to be asked for, so without this the demo page is the one page that
# could never show a photograph, and the blit would be the one part of the front
# page the simulator does not test. A tile sitting on the disk is the honest
# stand-in for a fetch that has already happened: it goes through the same byte
# count check, the same palette proof and the same blit as one off the wire.
#
# With NEWS_URL set the simulator fetches its tiles the way the device does,
# from <the news URL's directory>/tiles/, and this is not consulted.
target_compile_definitions(sim PRIVATE
    UI_TILE_LOCAL_DIR="${CMAKE_CURRENT_SOURCE_DIR}/tiles")
