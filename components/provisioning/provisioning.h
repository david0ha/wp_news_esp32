// Public API: Wi-Fi provisioning with a captive-portal fallback.
//
// Flow on boot:
//   1. Load saved config from NVS.
//   2. If a network is saved, try to join it (bounded by sta_connect_timeout_ms).
//   3. On success: return true with the active config (caller runs its app).
//   4. On failure, or if nothing is saved: bring up a SoftAP + captive portal where the
//      user enters Wi-Fi credentials and a weather location. The submission is saved to
//      NVS and the device reboots, so on the next boot step 2 connects automatically.
//
// This header is intentionally free of ESP-IDF types so callers stay decoupled.
#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "prov_config.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef enum {
    PROV_EVENT_STA_CONNECTING,  // trying the saved network; info = SSID
    PROV_EVENT_STA_CONNECTED,   // joined the saved network; info = SSID
    PROV_EVENT_PORTAL_STARTED,  // captive portal is up; info = AP SSID to join
    PROV_EVENT_CONFIG_SAVED,    // user submitted new config; device will reboot; info = SSID
} prov_event_t;

typedef void (*prov_event_cb_t)(prov_event_t event, const char *info, void *user);

typedef struct {
    char            ap_ssid_prefix[24];     // AP shows as "<prefix>-XXXX" (XXXX = MAC suffix)
    uint32_t        sta_connect_timeout_ms; // give up on the saved network after this long
    prov_event_cb_t event_cb;               // optional status callback (may be NULL)
    void           *user;                   // passed back to event_cb
} prov_options_t;

// Populate `opts` with sensible defaults (prefix "Claude Post", 15 s timeout, no callback).
void provisioning_default_options(prov_options_t *opts);

// Run the flow described above. Returns true when connected to Wi-Fi, with *out holding the
// active SSID and saved location. In the captive-portal path the call blocks until the user
// submits a config, after which the device reboots (so it does not return in that path).
bool provisioning_run(const prov_options_t *opts, prov_config_t *out);

// Step 1 only: mount NVS and read the saved config into *out (zeroed first). Returns true if a
// network is stored. Touches no radio and blocks for no timeout.
//
// The wake decision needs to know whether a news URL is configured BEFORE it decides whether to
// connect at all — a board with nothing to poll has no reason ever to wake, so it stays awake
// instead — and that question has to be answerable on a cold boot too, where there is no
// connect attempt to piggyback on.
bool provisioning_load_config(prov_config_t *out);

// Steps 1 and 2 only: load the saved config and try to join it. Returns true when the radio
// is up with an IP.
//
// The quiet deep-sleep wake path uses this, and what it does NOT do is the whole point of it:
// no SoftAP, no captive portal, no event callback, and no infinite loop. Those three cost a
// panel refresh apiece on this board, and a board whose network has gone away would otherwise
// spend one on every wake — about 220 mAh a day showing a setup screen nobody is looking at,
// which flattens the cell in under three weeks. A wake that cannot connect must be able to
// give up silently and go back to sleep, and that is what this is for.
//
// *out is zeroed first and filled whenever a config was stored, whether or not the join
// succeeded, so a caller that needs to know "is a news URL configured" gets an answer either
// way. The one-shot force-portal flag is left alone — only provisioning_run() consumes it.
//
// Safe to call before provisioning_run() in the same boot: the Wi-Fi bring-up underneath is
// guarded, so the full path can still run its own flow after this one has failed.
bool provisioning_connect_only(prov_config_t *out, uint32_t timeout_ms);

#ifdef __cplusplus
}
#endif
