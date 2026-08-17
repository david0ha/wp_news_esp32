idf_component_register(
    SRCS "user_app.cpp"
    # Public deps: user_app.h exposes prov_config_t (provisioning); user_app_api.h exposes
    # device_state_t (news_core) to the companion-app HTTP server (components/device_api).
    REQUIRES provisioning news_core
    # power: UiTask publishes what it printed into the RTC state and closes the
    # awake window with power_sleep(). esp_driver_gpio: the boot-time KEY2 check
    # samples the pin before buttons_init() has run.
    PRIV_REQUIRES app_bsp buttons port_bsp esp_timer board_io power esp_driver_gpio
    INCLUDE_DIRS "./")
