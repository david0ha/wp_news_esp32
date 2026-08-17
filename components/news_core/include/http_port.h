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

/*
 * Drop whatever connection THIS thread is holding open. Call it when the caller
 * knows it has no more requests coming for a while; the next http_get() then
 * starts from a fresh connection instead of a stale one.
 *
 * Connection reuse pays inside a burst — a snapshot and the photographs beside
 * it are four GETs to one host — and pays nothing across a five-minute poll
 * interval, because no server holds an idle connection that long. The mock
 * server closes at thirty seconds. Reusing across the gap therefore does not
 * save a handshake, it guarantees the next request is written into a socket the
 * peer has already closed: ECONNRESET, an error the layers below log at ERROR
 * level whatever we do about it, and a wasted round trip to discover it.
 *
 * The device port recovers from that on its own (http_port_esp.c retries), so
 * this is not what makes the fetch correct — it is what stops the board
 * reporting a fault every five minutes for the rest of its life.
 *
 * Safe to call with nothing open, and safe never to call at all.
 */
void http_port_release(void);

#ifdef __cplusplus
}
#endif
