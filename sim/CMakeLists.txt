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
set(CJSON ${CMAKE_CURRENT_SOURCE_DIR}/../third_party/cJSON)

# Reuse the IDF project's LVGL source (fetched into managed_components/).
add_subdirectory(${EX}/managed_components/lvgl__lvgl ${CMAKE_BINARY_DIR}/lvgl)

# The news core is compiled verbatim — same UI, same fonts, same logic as the
# firmware. Only the HTTP port is host-specific.
add_executable(sim
    main_sim.c
    http_port_curl.c
    ${CORE}/news_model.c
    ${CORE}/news_parse.c
    ${CORE}/news_mock.c
    ${CORE}/news_service.c
    ${CORE}/ui_common.c
    ${CORE}/ui_news.c
    ${CORE}/ui_page_stats.c
    ${CORE}/ui_page_graph.c
    ${CORE}/ui_page_agents.c
    ${CORE}/ui_page_notes.c
    ${CORE}/ui_graph.c
    ${CORE}/ui_icons.c
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
target_include_directories(sim PRIVATE ${CORE}/include ${CORE} ${CJSON})
target_link_libraries(sim lvgl curl m)
