/*
 * http_port.h — the one platform seam.
 *
 * http_get() performs a blocking HTTPS GET and returns the response body as a
 * freshly malloc'd, NUL-terminated string (caller frees), or NULL on transport
 * failure. *out_status receives the HTTP status code (0 if unknown).
 *
 * Two implementations exist and are linked per build:
 *   - http_port_curl.c   (desktop simulator + nothing else)   -> libcurl
 *   - http_port_esp.c     (device firmware)                    -> esp_http_client
 *
 * Everything above this seam (weather_service, weather_parse, the UI) is shared
 * verbatim, so the simulator exercises the real fetch+parse+render pipeline.
 */
#pragma once

#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Call once before any http_get(), from a single thread, before the fetch tasks
 * start. Creates the global TLS-connect gate (device port) so concurrent first
 * handshakes serialize; a no-op where the port needs no gate (simulator). */
void http_port_init(void);

char *http_get(const char *url, int *out_status);

/*
 * The same GET, for a body that is not text.
 *
 * A photo tile is 4 bpp pixel data and 0x00 is two black pixels, so the body
 * contains NUL bytes by construction and http_get()'s NUL-terminated string
 * would stop the picture at the first pair of them. This reports the LENGTH
 * instead; nothing else differs — same transport, same size cap, same status,
 * caller frees. The buffer is still NUL-terminated one byte past *out_len, so
 * http_get() is this function with the length thrown away.
 *
 * *out_len may be NULL. It is 0 whenever the return is NULL.
 */
void *http_get_bin(const char *url, size_t *out_len, int *out_status);

#ifdef __cplusplus
}
#endif
