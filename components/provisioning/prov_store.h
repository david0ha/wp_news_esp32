// NVS-backed persistence for the provisioning config (Wi-Fi credentials + news URL).
#pragma once

#include <stdbool.h>

#include "prov_config.h"

#ifdef __cplusplus
extern "C" {
#endif

// Load the saved config into `cfg` (zeroed first). Returns true if a network SSID is stored.
//
// Every field but the SSID is optional, including in the sense that its key may be absent
// from flash entirely — which is what a config written by an older firmware looks like. A
// missing key leaves the zeroed value in place and does not change the verdict.
bool prov_store_load(prov_config_t *cfg);

// Persist `cfg` (SSID, password, news URL, sleep interval). Also erases the keys the
// stock-ticker firmware used to write — one of which held an API secret.
// Returns true if the write committed; false if opening or committing NVS failed.
bool prov_store_save(const prov_config_t *cfg);

// Erase all saved provisioning data.
void prov_store_clear(void);

// Set a one-shot flag that makes the NEXT boot skip the Wi-Fi connect and go straight to the
// setup portal (AP mode), while keeping the saved config so the portal pre-fills. Backs the
// KEY2-held-5s escape hatch for when the device is stuck on an unreachable network.
void prov_store_set_force_portal(void);

// Read and clear (consume) the force-portal flag. Returns true if it was set.
bool prov_store_take_force_portal(void);

#ifdef __cplusplus
}
#endif
