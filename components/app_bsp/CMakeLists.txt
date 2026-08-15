idf_component_register(
    SRCS
    "lvgl_bsp.cpp"
    "lvgl_mem_psram.c"
    PRIV_REQUIRES 
    port_bsp
    esp_timer
    REQUIRES
    lvgl__lvgl
    INCLUDE_DIRS
    "./"
    # lvgl_mem_psram.c is the one file here that nothing in this project calls:
    # LVGL calls it, and LVGL is a dependency rather than a dependent. The link
    # order follows the dependency, so liblvgl__lvgl.a is scanned before
    # libapp_bsp.a and never again after it — the member holding lv_malloc_core
    # is passed over while the symbol is still resolved, and the build ends in
    # "undefined reference to `lv_malloc_core'" with the definition sitting in
    # an archive the linker already read. WHOLE_ARCHIVE links every member
    # regardless, which is the supported way to satisfy a dependency that points
    # back up.
    WHOLE_ARCHIVE)
