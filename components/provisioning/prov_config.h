// Pure (host-testable) configuration model for Wi-Fi + news-source provisioning.
// This header MUST NOT depend on ESP-IDF so it can be unit-tested on the host.
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define PROV_SSID_MAX_LEN     32   // 802.11 SSID limit
#define PROV_PASS_MAX_LEN     64   // WPA2 passphrase limit
#define PROV_URL_MAX_LEN     128   // where the news snapshot is fetched from

// How long the board waits between polls, in seconds — the middle of the three
// layers that set it (Kconfig default, this, then the runtime API), and the only
// one a user can change without a USB cable.
//
// The bounds are the range the device can actually run on, not a matter of
// taste: under a minute the wake's own cost is most of the duty cycle, and over
// a day a board is not polling, it is asleep.
#define PROV_SLEEP_SECONDS_MIN     60u
#define PROV_SLEEP_SECONDS_MAX  86400u

// "Nobody said" — distinct from any interval, and the value every board that
// predates the field carries. It means "use the build-time default", so it must
// survive every gate unchanged rather than being rounded up to the minimum.
#define PROV_SLEEP_SECONDS_UNSET    0u

typedef struct {
    char ssid[PROV_SSID_MAX_LEN + 1];
    char password[PROV_PASS_MAX_LEN + 1];
    // The URL the device polls for its news snapshot, e.g.
    // "http://macbook.local:8123/news.json". Plain HTTP is the normal case:
    // this is a link between two machines on the user's own LAN, and requiring
    // a certificate for it would mean requiring a certificate authority.
    //
    // Empty is a supported, complete configuration — the board then renders the
    // built-in demo snapshot with a DEMO badge, which is what makes it a
    // finished object with no PC running.
    char news_url[PROV_URL_MAX_LEN + 1];
    // Seconds between polls, or PROV_SLEEP_SECONDS_UNSET (0) for "use the
    // build-time default". Zero is an answer, not a missing one: it is what an
    // untouched board carries and what a blank box on the setup form means.
    //
    // APPENDED, never inserted. The config is persisted, and while prov_store.c
    // writes it key by key rather than as a blob — so the field order is not
    // itself what an old record depends on — the rule that keeps an already
    // provisioned board out of the captive portal is the same one: a field
    // added here is a key that older flash does not have, so it must be
    // optional at every reader. prov_store_load() treats a missing key as UNSET
    // and keeps reporting the board as provisioned; anything stricter would
    // send every device in the field back to asking for a Wi-Fi password after
    // a firmware update.
    uint32_t sleep_seconds;
} prov_config_t;

#ifdef __cplusplus
extern "C" {
#endif

// Result of prov_validate_credentials — mirrors the error codes the JSON API reports to the
// companion app (POST /api/provision). Kept here (pure) so the identical validation runs in
// the host tests and the firmware handler.
typedef enum {
    PROV_CRED_OK = 0,
    PROV_CRED_SSID_EMPTY,
    PROV_CRED_SSID_TOO_LONG,   // strlen(ssid) > PROV_SSID_MAX_LEN
    PROV_CRED_PASS_TOO_LONG,   // strlen(password) > PROV_PASS_MAX_LEN
} prov_cred_result_t;

// Validate submitted Wi-Fi credentials without storing them. NULL ssid/password is treated as
// empty. An empty password is allowed (open networks); only an empty SSID is rejected.
prov_cred_result_t prov_validate_credentials(const char *ssid, const char *password);

// True if `url` is something the device can actually fetch: empty (meaning "use the demo
// snapshot"), or an http:// or https:// URL with a host, within PROV_URL_MAX_LEN.
//
// Deliberately permissive about the rest — a hostname, an IP, a port, a path, a query string
// are all fine. The point is to catch the two mistakes people actually make, which are pasting
// a bare hostname with no scheme and pasting a whole file:// path.
bool prov_validate_news_url(const char *url);

// Bring a polling interval into the range the board can run on. Every writer
// goes through this one gate — the setup form, NVS, and the runtime API — so
// there is one answer to "what does 5 seconds mean" rather than three.
//
// PROV_SLEEP_SECONDS_UNSET (0) passes through unchanged. It is not a request
// for a short sleep; folding it into the minimum here would quietly convert
// every board that has never been told an interval into one polling at the
// busiest rate the device allows.
uint32_t prov_clamp_sleep_seconds(uint32_t seconds);

// Read the setup form's optional interval box: digits only, clamped as above.
// Anything that is not a run of digits — an empty box, "abc", "30 minutes", a
// stray minus sign — is PROV_SLEEP_SECONDS_UNSET.
//
// A run of digits too large to hold saturates and then clamps, so it comes out
// as PROV_SLEEP_SECONDS_MAX rather than as UNSET. That is the deliberate answer
// and not a near-miss of one: somebody who typed twenty nines was asking for the
// longest interval there is, and handing them the build-time default instead
// would be the one reading of that input nobody could have meant.
//
// Deliberately not a validation failure. The field is optional, so the whole
// form must not be thrown back at a user who mistyped a box they were entitled
// to leave blank; the cost of being wrong here is one default interval, and the
// cost of rejecting is a board that never gets onto the network at all.
uint32_t prov_parse_sleep_seconds(const char *text);

#ifdef __cplusplus
}
#endif
