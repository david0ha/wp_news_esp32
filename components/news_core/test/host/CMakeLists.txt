cmake_minimum_required(VERSION 3.16)
project(news_core_tests C)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)

# Paths relative to this file.
set(CORE   ${CMAKE_CURRENT_SOURCE_DIR}/../..)         # components/news_core
set(CJSON  ${CORE}/../../third_party/cJSON)           # <root>/third_party/cJSON
set(PORT   ${CORE}/../port_bsp)                       # components/port_bsp
set(POWER  ${CORE}/../power)                          # components/power

# Opt-in sanitizer build:  cmake -S . -B build -DSANITIZE=ON
# (Catches memory-safety regressions like UTF-8 over-reads; some sandboxed
#  macOS setups hang under ASan, so it's off by default.)
option(SANITIZE "Build with Address/UB sanitizers" OFF)

function(add_host_test name)
    add_executable(${name} ${ARGN})
    target_include_directories(${name} PRIVATE ${CORE}/include ${CJSON} ${PORT})
    target_compile_definitions(${name} PRIVATE FIXDIR="${CMAKE_CURRENT_SOURCE_DIR}/fixtures")
    target_compile_options(${name} PRIVATE -Wall -Wextra -O0 -g)
    target_link_libraries(${name} m)
    if(SANITIZE)
        target_compile_options(${name} PRIVATE -fsanitize=address,undefined)
        target_link_options(${name} PRIVATE -fsanitize=address,undefined)
    endif()
endfunction()

enable_testing()

# The wire format. Everything the network can do wrong lands here.
add_host_test(test_news_parse test_news_parse.c
              ${CORE}/news_parse.c ${CORE}/news_model.c ${CJSON}/cJSON.c)
add_test(NAME news_parse COMMAND test_news_parse)

# The built-in demo front page, tied to the reference producer's committed
# output. Three hand-written descriptions of one page — the C, the Python and
# the fixture — and this is what keeps them from drifting.
add_host_test(test_news_mock test_news_mock.c
              ${CORE}/news_mock.c ${CORE}/news_parse.c ${CORE}/news_model.c
              ${CJSON}/cJSON.c)
add_test(NAME news_mock COMMAND test_news_mock)

# The fetch layer, with the test itself standing in for the HTTP port. Covers
# which failures are distinguished from each other and — the product
# requirement — that none of them disturbs the caller's snapshot.
add_host_test(test_news_service test_news_service.c
              ${CORE}/news_service.c ${CORE}/news_parse.c ${CORE}/news_model.c
              ${CJSON}/cJSON.c)
add_test(NAME news_service COMMAND test_news_service)

# The companion-app JSON. cJSON is linked only to validate the output — the
# serializer itself writes bytes directly.
add_host_test(test_api_json test_api_json.c ${CORE}/device_api_json.c ${CJSON}/cJSON.c)
add_test(NAME api_json COMMAND test_api_json)

# The framebuffer -> dual-controller repack. Held against a transcription of the
# reference loop, because a wrong transpose produces confetti on the glass and
# nothing at all in the log. Deliberately outside news_core: it is panel
# geometry, and it is the only part of port_bsp that can be tested on a host.
add_host_test(test_epd6_transpose test_epd6_transpose.c ${PORT}/epd6_transpose.c)
add_test(NAME epd6_transpose COMMAND test_epd6_transpose)

# The six-colour quantizer. Compiled from the same source the firmware and the
# simulator use, so "black text does not dither" is asserted about the actual
# decision, not a description of it.
add_host_test(test_palette test_palette.c ${CORE}/wp_palette.c)
add_test(NAME palette COMMAND test_palette)

# Copyfitting (spec §5) and integer chart scaling (spec §7) are pure and belong
# here, but they land with the layout work rather than with the data model.
# Guarded on existence so this build is green before those files are written and
# picks them up the moment they are, without a second edit to this file.
if(EXISTS ${CMAKE_CURRENT_SOURCE_DIR}/test_fit.c AND EXISTS ${CORE}/ui_fit.c)
    add_host_test(test_fit test_fit.c ${CORE}/ui_fit.c)
    add_test(NAME fit COMMAND test_fit)
endif()

if(EXISTS ${CMAKE_CURRENT_SOURCE_DIR}/test_chart_scale.c AND EXISTS ${CORE}/ui_chart.c)
    add_host_test(test_chart_scale test_chart_scale.c ${CORE}/ui_chart.c)
    add_test(NAME chart_scale COMMAND test_chart_scale)
endif()

# The make-up desk. Pure geometry with the page's measurement passed in, so the
# guillotine invariants — tiles the well, no overlap, no gap, every span even —
# are asserted over thousands of generated module sets rather than over the
# three payloads the simulator happens to build.
if(EXISTS ${CMAKE_CURRENT_SOURCE_DIR}/test_compose.c AND EXISTS ${CORE}/ui_compose.c)
    add_host_test(test_compose test_compose.c ${CORE}/ui_compose.c)
    add_test(NAME compose COMMAND test_compose)
endif()

# The wake decision. It lives outside news_core — it is power policy, not
# newspaper — but it is pure, integer-only and free of every ESP-IDF header, so
# it belongs in the one place this project can settle a question without
# hardware. The alternative is a state machine whose failures show up three days
# later on a wall, in a room, with no serial cable attached.
if(EXISTS ${CMAKE_CURRENT_SOURCE_DIR}/test_power_policy.c AND EXISTS ${POWER}/power_policy.c)
    add_host_test(test_power_policy test_power_policy.c ${POWER}/power_policy.c)
    target_include_directories(test_power_policy PRIVATE ${POWER}/include)
    add_test(NAME power_policy COMMAND test_power_policy)
endif()
