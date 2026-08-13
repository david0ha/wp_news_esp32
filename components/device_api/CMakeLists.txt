idf_component_register(
    SRCS "device_api.c"
    INCLUDE_DIRS "."
    # news_core:  device_api_json + the vendored cJSON include/symbols.
    # user_app:     the user_app_api bridge (snapshot + command posters).
    PRIV_REQUIRES
        news_core
        user_app
        esp_http_server
        esp_netif
        esp_wifi
        esp_hw_support
        esp_event
        mdns)
