# IDF component: the sleep decision and the shutdown that performs it.
#
# power_policy.c is listed here AND compiled independently by the host test
# suite (components/news_core/test/host/CMakeLists.txt), which is the point of
# it: the decision is pure, integer-only and includes no ESP-IDF header, so the
# same source that runs on the board is the source `test_power_policy` holds to
# every case in test_power_policy.c, on a laptop. power.c is the opposite — nothing but silicon —
# and has no test anywhere. Keep the boundary where it is.
idf_component_register(
    SRCS
        "power_policy.c"
        "power.c"
    INCLUDE_DIRS "include"
    # Public: power.h includes http_port.h for HTTP_ETAG_MAX, so the ETag field
    # in the RTC struct is the same size as the one the fetch layer fills.
    REQUIRES
        news_core
    PRIV_REQUIRES
        board_io
        esp_app_format
        esp_driver_gpio
        esp_driver_usb_serial_jtag
        esp_wifi
        port_bsp)
