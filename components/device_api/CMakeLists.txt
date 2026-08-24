idf_component_register(
    SRCS "device_api.c"
    INCLUDE_DIRS "."
    # news_core:  device_api_json + the vendored cJSON include/symbols.
    # user_app:     the user_app_api bridge (snapshot + command posters).
    # port_bsp:     GET /api/screen sends the framebuffer itself. It is a READ of
    #               PSRAM — epd6_framebuffer() is under "no panel traffic" — and it
    #               does not go through user_app because that bridge exists to keep
    #               refreshes single-owner, which a read does not touch. user_app
    #               keeps port_bsp private, so this dependency has to be named here.
    PRIV_REQUIRES
        news_core
        user_app
        port_bsp
        esp_http_server
        esp_netif
        esp_wifi
        esp_hw_support
        esp_event
        mdns)
