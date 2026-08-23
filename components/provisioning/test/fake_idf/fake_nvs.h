// Test-only controls over the in-memory NVS (fake_nvs.c). Not part of the
// ESP-IDF surface — these exist so a test can put flash into the state a
// *previous* firmware would have left it in, which is the one state that cannot
// be reached by calling prov_store_save().
#pragma once

#include <stdbool.h>
#include <stdint.h>

// Forget everything, including the namespace itself — the state of a board that
// has never been provisioned, where nvs_open(NVS_READONLY) fails outright.
void fake_nvs_reset(void);

// Write a key directly, as an older firmware's prov_store_save() would have.
// Creates the namespace, so a subsequent read-only open succeeds.
void fake_nvs_seed_str(const char *key, const char *value);
void fake_nvs_seed_u32(const char *key, uint32_t value);

bool fake_nvs_has_key(const char *key);
