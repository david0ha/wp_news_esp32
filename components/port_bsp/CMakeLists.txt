idf_component_register(
    SRCS
    "epd6_panel.c"
    "epd6_transpose.c"
    # Public: epd6_panel.h names spi_host_device_t in epd6_pins_t, so anyone who
    # includes it needs the SPI driver's headers too.
    REQUIRES
    esp_driver_spi
    # Private, because only epd6_panel.c includes driver/gpio.h — and
    # esp_driver_gpio rather than the catch-all `driver`, which IDF 5.3 emptied
    # when it split the peripheral drivers into their own components. What is
    # left in `driver` is i2c, twai and the touch sensor, none of which this
    # board has (CLAUDE.md: there is no I2C bus), so depending on it named a
    # component this code does not use. board_io and buttons already got this
    # right; port_bsp was the last one still asking for the bundle.
    PRIV_REQUIRES
    esp_driver_gpio
    esp_timer
    INCLUDE_DIRS
    "./")
