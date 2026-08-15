/*
 * device_api_json.h — pure serializers for the companion-app HTTP API.
 *
 * Separated from device_api.c (which owns httpd/mDNS/esp_netif) so the exact
 * bytes the phone receives are covered by host tests. Both write a NUL-
 * terminated document into `out` and return its length, or -1 if it would not
 * fit — in which case out[0] is set to '\0' rather than left half-written.
 */
#pragma once

#include <stddef.h>

#include "device_api_model.h"

#ifdef __cplusplus
extern "C" {
#endif

/* Buffer sizes the server must allocate. They live here rather than in
 * device_api.c so the host tests can assert that a WORST-CASE state document —
 * every string at its maximum length, every array at capacity — actually fits.
 * The overflow path returns -1 and an empty body, so the symptom of being one
 * byte over is "the app shows nothing" with no error anywhere. A 128-character
 * news URL beside a full company name is not a hypothetical; it is one paste
 * away.
 *
 * Measured worst case is **4,111 bytes** (test_api_json.c prints it on every
 * run), and the multiplier that gets it there is the escape: a C0 control with
 * no short form becomes `\u00XX`, six bytes out of one, and cJSON hands the
 * parser a raw 0x01 for any producer that wrote one. Sizing for the two-byte
 * escape instead would hold every payload anyone files by accident and blank
 * the app on the one nobody expected, which is the failure this whole file is
 * arranged against.
 *
 * device_api.c allocates both as file statics — one httpd task serializes one
 * response at a time — so this is .bss for the lifetime of the board, not per
 * request, which is why the document is control state and not a copy of the
 * page. Carrying the dossier put the same number at 15,092 and the buffer at
 * 16 KB; see device_api_model.h for why it does not. */
#define DEVICE_API_STATE_BUF_SZ   5120
#define DEVICE_API_INFO_BUF_SZ     256

/* GET /api/info -> {"deviceId","model","fw","ip"}
 *
 * The shape is fixed by the companion app's discovery probe (it fetches this
 * on every candidate host and reads `ip` to pick the best one), so do not
 * rename or drop these four fields without updating app/src/lib/discovery.ts.
 */
int device_api_json_info(char *out, size_t out_size,
                         const char *device_id, const char *model,
                         const char *fw, const char *ip);

/* GET /api/state -> the whole device_state_t. */
int device_api_json_state(const device_state_t *st, char *out, size_t out_size);

#ifdef __cplusplus
}
#endif
