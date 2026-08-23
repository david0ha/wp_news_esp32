// An in-memory NVS, faithful in the one dimension the store depends on: what
// happens when a key is not there. See nvs.h in this directory for why.
#include "nvs.h"
#include "fake_nvs.h"

#include <stdarg.h>
#include <string.h>

#define FAKE_NVS_MAX_ENTRIES 16
#define FAKE_NVS_MAX_VALUE   256
#define FAKE_NVS_MAX_KEY     16   // the real NVS key limit is 15 characters + NUL

typedef enum { ENTRY_FREE = 0, ENTRY_STR, ENTRY_U8, ENTRY_U32 } entry_type_t;

typedef struct {
    char         key[FAKE_NVS_MAX_KEY];
    entry_type_t type;
    char         str[FAKE_NVS_MAX_VALUE];
    uint32_t     num;
} entry_t;

static entry_t s_entries[FAKE_NVS_MAX_ENTRIES];
// A namespace comes into existence the first time something opens it for
// writing, exactly as the real one does; until then a read-only open fails and
// prov_store_load() reports "nothing saved".
static bool    s_namespace_exists;

static entry_t *find(const char *key)
{
    for (size_t i = 0; i < FAKE_NVS_MAX_ENTRIES; i++) {
        if (s_entries[i].type != ENTRY_FREE && strcmp(s_entries[i].key, key) == 0) {
            return &s_entries[i];
        }
    }
    return NULL;
}

static entry_t *find_or_add(const char *key)
{
    entry_t *e = find(key);
    if (e != NULL) {
        return e;
    }
    for (size_t i = 0; i < FAKE_NVS_MAX_ENTRIES; i++) {
        if (s_entries[i].type == ENTRY_FREE) {
            memset(&s_entries[i], 0, sizeof(s_entries[i]));
            strncpy(s_entries[i].key, key, sizeof(s_entries[i].key) - 1);
            return &s_entries[i];
        }
    }
    return NULL;   // out of room: the suite would rather fail than silently drop a key
}

// ---------------------------------------------------------------------------
// The ESP-IDF surface
// ---------------------------------------------------------------------------

esp_err_t nvs_open(const char *namespace_name, nvs_open_mode_t open_mode, nvs_handle_t *out_handle)
{
    (void)namespace_name;
    if (open_mode == NVS_READONLY && !s_namespace_exists) {
        return ESP_ERR_NVS_NOT_FOUND;
    }
    s_namespace_exists = true;
    *out_handle = 1;
    return ESP_OK;
}

void nvs_close(nvs_handle_t handle)
{
    (void)handle;
}

esp_err_t nvs_commit(nvs_handle_t handle)
{
    (void)handle;
    return ESP_OK;
}

esp_err_t nvs_get_str(nvs_handle_t handle, const char *key, char *out_value, size_t *length)
{
    (void)handle;
    entry_t *e = find(key);
    if (e == NULL) {
        return ESP_ERR_NVS_NOT_FOUND;   // out_value and *length are left alone
    }
    if (e->type != ENTRY_STR) {
        return ESP_ERR_NVS_TYPE_MISMATCH;
    }
    size_t need = strlen(e->str) + 1;
    if (out_value == NULL || *length < need) {
        *length = need;                 // the real API's "ask again with this much room"
        return ESP_ERR_NVS_INVALID_LENGTH;
    }
    memcpy(out_value, e->str, need);
    *length = need;
    return ESP_OK;
}

esp_err_t nvs_set_str(nvs_handle_t handle, const char *key, const char *value)
{
    (void)handle;
    entry_t *e = find_or_add(key);
    if (e == NULL || strlen(value) >= FAKE_NVS_MAX_VALUE) {
        return ESP_FAIL;
    }
    e->type = ENTRY_STR;
    strncpy(e->str, value, sizeof(e->str) - 1);
    e->str[sizeof(e->str) - 1] = '\0';
    return ESP_OK;
}

esp_err_t nvs_get_u8(nvs_handle_t handle, const char *key, uint8_t *out_value)
{
    (void)handle;
    entry_t *e = find(key);
    if (e == NULL) {
        return ESP_ERR_NVS_NOT_FOUND;
    }
    if (e->type != ENTRY_U8) {
        return ESP_ERR_NVS_TYPE_MISMATCH;
    }
    *out_value = (uint8_t)e->num;
    return ESP_OK;
}

esp_err_t nvs_set_u8(nvs_handle_t handle, const char *key, uint8_t value)
{
    (void)handle;
    entry_t *e = find_or_add(key);
    if (e == NULL) {
        return ESP_FAIL;
    }
    e->type = ENTRY_U8;
    e->num = value;
    return ESP_OK;
}

esp_err_t nvs_get_u32(nvs_handle_t handle, const char *key, uint32_t *out_value)
{
    (void)handle;
    entry_t *e = find(key);
    if (e == NULL) {
        return ESP_ERR_NVS_NOT_FOUND;   // *out_value is left alone — the case this fake exists for
    }
    if (e->type != ENTRY_U32) {
        return ESP_ERR_NVS_TYPE_MISMATCH;
    }
    *out_value = e->num;
    return ESP_OK;
}

esp_err_t nvs_set_u32(nvs_handle_t handle, const char *key, uint32_t value)
{
    (void)handle;
    entry_t *e = find_or_add(key);
    if (e == NULL) {
        return ESP_FAIL;
    }
    e->type = ENTRY_U32;
    e->num = value;
    return ESP_OK;
}

esp_err_t nvs_erase_key(nvs_handle_t handle, const char *key)
{
    (void)handle;
    entry_t *e = find(key);
    if (e == NULL) {
        return ESP_ERR_NVS_NOT_FOUND;
    }
    memset(e, 0, sizeof(*e));
    return ESP_OK;
}

esp_err_t nvs_erase_all(nvs_handle_t handle)
{
    (void)handle;
    memset(s_entries, 0, sizeof(s_entries));
    return ESP_OK;
}

const char *esp_err_to_name(esp_err_t err)
{
    switch (err) {
        case ESP_OK:                     return "ESP_OK";
        case ESP_ERR_NVS_NOT_FOUND:      return "ESP_ERR_NVS_NOT_FOUND";
        case ESP_ERR_NVS_TYPE_MISMATCH:  return "ESP_ERR_NVS_TYPE_MISMATCH";
        case ESP_ERR_NVS_INVALID_LENGTH: return "ESP_ERR_NVS_INVALID_LENGTH";
        default:                         return "ESP_FAIL";
    }
}

void fake_idf_log(const char *tag, const char *fmt, ...)
{
    (void)tag;
    (void)fmt;
}

// ---------------------------------------------------------------------------
// Test controls
// ---------------------------------------------------------------------------

void fake_nvs_reset(void)
{
    memset(s_entries, 0, sizeof(s_entries));
    s_namespace_exists = false;
}

void fake_nvs_seed_str(const char *key, const char *value)
{
    s_namespace_exists = true;
    nvs_set_str(1, key, value);
}

void fake_nvs_seed_u32(const char *key, uint32_t value)
{
    s_namespace_exists = true;
    nvs_set_u32(1, key, value);
}

bool fake_nvs_has_key(const char *key)
{
    return find(key) != NULL;
}
