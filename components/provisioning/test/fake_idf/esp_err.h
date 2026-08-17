// Just enough of ESP-IDF's error type for prov_store.c to compile on the host.
//
// The numeric values need not match the real ones: nothing carries an esp_err_t
// across this seam, the store only ever compares against ESP_OK.
#pragma once

typedef int esp_err_t;

#define ESP_OK                      0
#define ESP_FAIL                   -1
#define ESP_ERR_NVS_NOT_FOUND       0x1102
#define ESP_ERR_NVS_TYPE_MISMATCH   0x1103
#define ESP_ERR_NVS_INVALID_LENGTH  0x110c

const char *esp_err_to_name(esp_err_t err);
