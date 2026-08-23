/*
 * http_port.h — the one platform seam.
 *
 * http_get() performs a blocking HTTPS GET and returns the response body as a
 * freshly malloc'd, NUL-terminated string (caller frees), or NULL on transport
 * failure. *out_status receives the HTTP status code (0 if unknown).
 *
 * http_get_cond() is the same transport with the conditional-GET headers
 * exposed; the other two are written in terms of it, so there is one transport
 * path per platform rather than two that can drift.
 *
 * Two implementations exist and are linked per build:
 *   - http_port_curl.c   (desktop simulator + nothing else)   -> libcurl
 *   - http_port_esp.c     (device firmware)                    -> esp_http_client
 *
 * Everything above this seam (weather_service, weather_parse, the UI) is shared
 * verbatim, so the simulator exercises the real fetch+parse+render pipeline.
 */
#pragma once

#include <stdbool.h>
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

/* --- the conditional GET -------------------------------------------------- */

/* An ETag is opaque to this project — it is compared, never interpreted — so
 * the only thing that matters about the field is that it is bounded. 64 bytes
 * holds the sixteen hex digits the reference producer sends, its quotes, a
 * `W/` weak marker and a proxy's embellishments, and it is small enough to sit
 * in the 8 KB of RTC memory that survives a deep sleep. */
#define HTTP_ETAG_MAX 64

typedef struct {
    const char *if_none_match;   /* NULL or "" = an unconditional GET */
} http_req_t;

typedef struct {
    int    status;               /* 0 means the transport failed */
    /* The response body, freshly malloc'd and NUL-terminated; the caller frees.
     *
     * NULL on a 304 and NULL on a failure, and those two are NOT the same
     * thing: the status tells them apart and nothing else does. That collision
     * is the entire reason this call exists — see http_get_cond() below. */
    char  *body;
    size_t len;
    char   etag[HTTP_ETAG_MAX];  /* "" when the server sent none */
} http_resp_t;

/*
 * A GET that may carry If-None-Match, reporting the status and the server's
 * ETag alongside the body.
 *
 * Returns false only on transport failure, and sets out->status to 0 when it
 * does. A 304 is a SUCCESS with a NULL body.
 *
 * This is a separate call rather than another flag on http_get() because
 * http_get() answers with a pointer, and a NULL pointer already means "the
 * network is down". A 304 has no body, so it would arrive as that same NULL —
 * and a 304 is the most common *successful* outcome a board that polls all day
 * has. Reading it as an outage would count a failure every time the server
 * correctly said nothing had changed — lengthening the retry backoff on a
 * sleeping board, badging the sheet OFFLINE on an awake one: a board that works
 * worse the better the server behaves, and nothing in the log to say so.
 * http_get() and
 * http_get_bin() keep their exact previous behaviour and are reimplemented on
 * top of this, so the photograph path in ui_tile.c is untouched.
 */
bool http_get_cond(const char *url, const http_req_t *req, http_resp_t *out);

/* Copy an ETag into a fixed field, NUL-terminating and truncating rather than
 * overrunning. It belongs to the seam because the bound does: the value is
 * arbitrary bytes chosen by whatever is on the other end of the wire, and every
 * place it lands — the port's field, the caller's store, RTC memory — is fixed.
 * A truncated tag simply never matches again, so a server that sends four
 * kilobytes of it costs one wasted conditional GET rather than the stack. */
static inline void http_etag_copy(char *dst, size_t n, const char *src)
{
    if (!dst || n == 0) return;
    size_t i = 0;
    if (src) { while (src[i] && i + 1 < n) { dst[i] = src[i]; i++; } }
    dst[i] = '\0';
}

#ifdef __cplusplus
}
#endif
