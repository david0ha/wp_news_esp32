cmake_minimum_required(VERSION 3.16)
project(news_core_tests C)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)

# Paths relative to this file.
set(CORE   ${CMAKE_CURRENT_SOURCE_DIR}/../..)         # components/news_core
set(CJSON  ${CORE}/../../third_party/cJSON)           # <root>/third_party/cJSON
set(PORT   ${CORE}/../port_bsp)                       # components/port_bsp

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

# The wire format. Everything the network can do wrong lands here.
add_host_test(test_news_parse test_news_parse.c
              ${CORE}/news_parse.c ${CORE}/news_model.c ${CJSON}/cJSON.c)

# Where the link-graph nodes go. Pure integer geometry, no LVGL.
add_host_test(test_graph_layout test_graph_layout.c
              ${CORE}/ui_graph.c ${CORE}/news_model.c)

# The built-in demo snapshot, tied to the reference producer's committed output.
add_host_test(test_news_mock test_news_mock.c
              ${CORE}/news_mock.c ${CORE}/news_parse.c ${CORE}/news_model.c
              ${CJSON}/cJSON.c)

# The fetch layer, with the test itself standing in for the HTTP port. Covers
# which failures are distinguished from each other and — the product
# requirement — that none of them disturbs the caller's snapshot.
add_host_test(test_news_service test_news_service.c
              ${CORE}/news_service.c ${CORE}/news_parse.c ${CORE}/news_model.c
              ${CJSON}/cJSON.c)

# The companion-app JSON. cJSON is linked only to validate the output — the
# serializer itself writes bytes directly.
add_host_test(test_api_json test_api_json.c ${CORE}/device_api_json.c ${CJSON}/cJSON.c)

# The framebuffer -> dual-controller repack. Held against a transcription of the
# reference loop, because a wrong transpose produces confetti on the glass and
# nothing at all in the log. Deliberately outside news_core: it is panel
# geometry, and it is the only part of port_bsp that can be tested on a host.
add_host_test(test_epd6_transpose test_epd6_transpose.c ${PORT}/epd6_transpose.c)

enable_testing()
add_test(NAME news_parse  COMMAND test_news_parse)
add_test(NAME graph_layout COMMAND test_graph_layout)
add_test(NAME news_mock   COMMAND test_news_mock)
add_test(NAME news_service COMMAND test_news_service)
add_test(NAME api_json      COMMAND test_api_json)
add_test(NAME epd6_transpose COMMAND test_epd6_transpose)
