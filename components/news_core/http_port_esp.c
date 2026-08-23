/*
 * http_port_esp.c — device HTTP port (esp_http_client + TLS cert bundle).
 *
 * Implements http_get_cond() for the firmware, with http_get() and
 * http_get_bin() written on top of it. Mirrors the simulator's libcurl port.
 * The response body is accumulated into PSRAM because a forecast metric=all
 * payload is ~240KB — far too large for internal RAM.
 *
 * Connection reuse: instead of init/perform/cleanup per request (a fresh TLS
 * handshake + cert-bundle validation every time), each worker task keeps ONE
 * persistent esp_http_client handle in thread-local storage and reuses it.
 * Per the ESP-IDF docs, repeated esp_http_client_perform() calls on the same
 * handle ride the open connection when the host is unchanged, so the handshake
 * happens once per host instead of once per GET. On a host change we close the
 * connection (keeping the handle) and let the next perform reconnect. The
 * handle is never shared between tasks (esp_http_client is not thread-safe), so
 * the two fetch workers each own their own connection.
 *
 * That reuse extends to the REQUEST HEADERS, which is the one trap in here: a
 * header set on the handle for one GET is still set for the next. Every request
 * therefore states its If-None-Match — by setting it or by deleting it — rather
 * than only when it has one.
 */
#include "http_port.h"

#include "esp_http_client.h"
#include "esp_crt_bundle.h"
#include "esp_heap_caps.h"
#include "esp_log.h"

#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"

#include <stdlib.h>
#include <string.h>
#include <strings.h>   /* strcasecmp: header field names are case-insensitive */
#include <stdbool.h>

#define HTTP_MAX_RESP (320 * 1024)   /* hard cap; metric=all is ~240KB */

static const char *TAG = "http";

/* Global TLS-connect gate (NOT __thread): held only across a perform() that will
 * (re)connect, so at most one heavy ECDSA cert-chain verify runs at a time even
 * if the boot stagger drifts. Same-host keep-alive performs skip it, so the hot
 * path stays lock-free. Created once by http_port_init() before any fetch task
 * starts (so http_get never has to lazily create it under a race). */
static SemaphoreHandle_t s_tls_connect_lock;

void http_port_init(void) {
    if (!s_tls_connect_lock) s_tls_connect_lock = xSemaphoreCreateMutex();
}

typedef struct {
    char  *buf; size_t len; size_t cap; bool oom;
    char   etag[HTTP_ETAG_MAX];   /* "" unless the server sent one */
} acc_t;

static esp_err_t on_evt(esp_http_client_event_t *e) {
    acc_t *a = (acc_t *)e->user_data;
    if (!a) return ESP_OK;

    if (e->event_id == HTTP_EVENT_ON_HEADER) {
        /* RFC 9110 §5.1: field names are case-insensitive, and servers really do
         * vary — "ETag", "Etag", "etag" are all in the wild. Matching only the
         * canonical spelling would fail silently in the worst direction: the
         * device would store no tag, send no If-None-Match, and get a full 200
         * every poll forever. The page would still be right and the battery
         * would quietly not last. */
        if (e->header_key && e->header_value &&
            strcasecmp(e->header_key, "ETag") == 0) {
            http_etag_copy(a->etag, sizeof(a->etag), e->header_value);
        }
        return ESP_OK;
    }

    if (e->event_id != HTTP_EVENT_ON_DATA) return ESP_OK;
    if (a->oom) return ESP_OK;

    if (a->len + e->data_len + 1 > a->cap) {
        size_t ncap = a->cap ? a->cap : 8192;
        while (ncap < a->len + e->data_len + 1) ncap *= 2;
        if (ncap > HTTP_MAX_RESP) { a->oom = true; ESP_LOGW(TAG, "response > cap"); return ESP_OK; }
        char *p = heap_caps_realloc(a->buf, ncap, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
        if (!p) { a->oom = true; ESP_LOGE(TAG, "PSRAM OOM"); return ESP_OK; }
        a->buf = p; a->cap = ncap;
    }
    memcpy(a->buf + a->len, e->data, e->data_len);
    a->len += e->data_len;
    a->buf[a->len] = '\0';
    return ESP_OK;
}

/* One persistent client + the host its connection is currently bound to, per
 * worker task (thread-local: each task gets its own copy, zero-initialized). */
static __thread esp_http_client_handle_t t_client;
static __thread char t_host[128];

/* Copy the "host[:port]" of a URL (between "://" and the next '/') into out. */
static void host_of(const char *url, char *out, size_t n) {
    out[0] = '\0';
    const char *p = strstr(url, "://");
    if (!p) return;
    p += 3;
    size_t i = 0;
    while (p[i] && p[i] != '/' && i + 1 < n) { out[i] = p[i]; i++; }
    out[i] = '\0';
}

/* A fresh handle, configured for `url`.
 *
 * This is factored out because the retry below cannot reuse a handle, and that
 * is not obvious. esp_http_client keeps the state of the request it is
 * SERIALIZING separately from the state of its connection:
 *
 *     esp_http_client_request_send()          (esp_http_client.c:1556)
 *         if (!client->first_line_prepared) {
 *             http_client_prepare_first_line(...);
 *             client->first_line_prepared = true;
 *             client->header_index        = 0;
 *             client->data_written_index  = 0;
 *             client->data_write_left     = 0;
 *         }
 *
 * When a write dies mid-request those four are left as the dead attempt found
 * them. esp_http_client_close() winds the CONNECTION back to HTTP_STATE_INIT
 * and touches nothing else, and the one function that does reset them —
 * esp_http_client_prepare() — is static and runs only when `process_again` is
 * set, which is the redirect/auth path and not this one. So a second perform()
 * on the same handle reconnects and then writes NOTHING: first_line_prepared is
 * still true, header_index is still past the end, and the server sees a TCP
 * connection that never speaks. Measured on the board — the request never
 * reached the server and never appeared in its log.
 *
 * A calloc'd handle is the only public route back to a clean request. */
static esp_http_client_handle_t client_new(const char *url) {
    esp_http_client_config_t cfg = {
        .url               = url,
        .event_handler     = on_evt,
        .crt_bundle_attach = esp_crt_bundle_attach,
        .timeout_ms        = 15000,
        .buffer_size       = 4096,
        .keep_alive_enable = true,   /* TCP keepalive: detect dead idle sockets */
#if CONFIG_ESP_TLS_CLIENT_SESSION_TICKETS
        /* Save the negotiated TLS session so a later reconnect to the SAME host
         * resumes (abbreviated handshake, skips the ECDSA cert verify). Helps a
         * slow single-host poller whose keep-alive the server drops while idle;
         * the cert bundle still gates a full handshake.
         *
         * Only for https://, because there is no session to save otherwise and
         * asking for one is not free of consequence: esp_http_client hangs the
         * request off the transport list's ssl entry regardless of scheme, and
         * on a plain-HTTP connection that entry's tls context is NULL, so the
         * save lands in esp_mbedtls_get_client_session(NULL) and the board
         * logs `esp_tls session context cannot be NULL` once per connection —
         * an error line, in red, for a board doing exactly what it should.
         *
         * The handle outlives one URL, so this is decided by the scheme of the
         * URL that created it. A later switch from http:// to https:// on the
         * same task loses session resumption, not correctness. */
        .save_client_session = (strncmp(url, "https://", 8) == 0),
#endif
        .user_agent        = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                             "AppleWebKit/537.36 (KHTML, like Gecko) "
                             "Chrome/120 Safari/537.36",
    };
    return esp_http_client_init(&cfg);
}

/* State this request's If-None-Match — by setting it, or by deleting it.
 *
 * The handle is reused across calls (see the file header), and so are the
 * headers set on it. Setting If-None-Match when there is a tag and DELETING it
 * when there is not is the whole of the correctness here: a tag left standing
 * would make every later unconditional GET conditional, and the next photograph
 * fetch would come back 304 with no body — a front page with holes where its
 * pictures are, from a request that never asked a question about them.
 *
 * It is a function rather than two lines at the call site because the retry
 * below performs on a SECOND handle, which carries none of the first one's
 * headers. Skipping it there downgrades the retried request to an unconditional
 * GET — the ETag defeated on exactly the polls where the socket went stale, and
 * a full edition fetched to discover nothing had changed. */
static void apply_cond(esp_http_client_handle_t c, const char *inm) {
    if (inm) esp_http_client_set_header(c, "If-None-Match", inm);
    else     esp_http_client_delete_header(c, "If-None-Match");
}

/* Thread-local, like the handle it frees: this releases the CALLING task's
 * connection and cannot touch another's. See http_port.h for when to call it. */
void http_port_release(void) {
    if (t_client) {
        esp_http_client_cleanup(t_client);
        t_client = NULL;
    }
    t_host[0] = '\0';
}

char *http_get(const char *url, int *out_status) {
    return (char *)http_get_bin(url, NULL, out_status);
}

/* Both of the old entry points are this one call with pieces thrown away, so
 * there is a single transport per platform. A photograph fetched through
 * http_get_bin() sends no If-None-Match and is byte-for-byte the request it
 * always was. */
void *http_get_bin(const char *url, size_t *out_len, int *out_status) {
    http_resp_t r;
    (void)http_get_cond(url, NULL, &r);
    if (out_status) *out_status = r.status;
    if (out_len)    *out_len    = r.len;
    return r.body;
}

bool http_get_cond(const char *url, const http_req_t *req, http_resp_t *out) {
    if (!out) return false;
    memset(out, 0, sizeof(*out));

    acc_t a = {0};
    char host[sizeof(t_host)];
    host_of(url, host, sizeof(host));

    /* Will this request open a new TLS connection (no handle, no live connection,
     * or a host change)? If so we serialize the perform below so two tasks don't
     * run their ECDSA cert verify at once. Same-host keep-alive -> false -> no lock. */
    bool will_handshake = (!t_client) || (t_host[0] == '\0') || (strcmp(host, t_host) != 0);

    /* Different host than the connection we're holding open -> drop the
     * connection but keep the handle so we can reconnect cheaply. */
    if (t_client && strcmp(host, t_host) != 0) {
        esp_http_client_close(t_client);
        t_host[0] = '\0';
    }

    if (!t_client) {
        t_client = client_new(url);
        if (!t_client) { free(a.buf); return false; }
    }

    /* Point the (reused) handle at this request. user_data carries our
     * accumulator and must be (re)set every call since it lives on our stack. */
    esp_http_client_set_url(t_client, url);
    esp_http_client_set_user_data(t_client, &a);

    /* Every request states its If-None-Match, including the ones that have none
     * to state — see apply_cond(). */
    const char *inm = (req && req->if_none_match && req->if_none_match[0])
                    ? req->if_none_match : NULL;
    apply_cond(t_client, inm);

    /* Serialize only the (re)connect+handshake; same-host reuse runs lock-free. */
    if (will_handshake && s_tls_connect_lock) xSemaphoreTake(s_tls_connect_lock, portMAX_DELAY);
    esp_err_t err = esp_http_client_perform(t_client);
    if (will_handshake && s_tls_connect_lock) xSemaphoreGive(s_tls_connect_lock);

    /*
     * A reused connection that fails is the price of keep-alive, not a fault.
     * The peer is entitled to close an idle socket and does not ask first:
     * tools/mock_news_server.py is a Python ThreadingHTTPServer with
     * `timeout = 30`, and this board polls every 60 seconds, so the server's
     * FIN lands 30 seconds before the GET that discovers it. The socket sits
     * in CLOSE_WAIT until we write, which is why the failure arrives at the
     * WRITE and not at the connect — ECONNRESET, ESP_ERR_HTTP_WRITE_DATA.
     *
     * Untreated this does not look like a stale socket, it looks like a flaky
     * network, because it self-heals into an alternating pattern: the failure
     * closes the connection, the next poll reconnects and succeeds, and the
     * one after that is stale again. Every second edition, silently missed.
     *
     * So retry once on a connection that is new all the way down — a new
     * handle, not just a new socket, for the reason set out over client_new().
     * The retry is gated on the connection having been REUSED: a request that
     * opened its own connection and still failed has a server-side or network
     * reason, and repeating it would only double every fifteen-second timeout
     * in front of a board that has five minutes to wait anyway.
     *
     * The gate is `err`, and `err` is about the TRANSPORT: a 304 arrives as
     * ESP_OK, because the response was received in full and answered the
     * question that was asked. So the most common successful outcome a polling
     * board has cannot fall through here and be re-fetched — this path runs
     * when nothing came back at all, never when "nothing changed" came back.
     *
     * The new handle costs the https:// case its saved TLS session, so the
     * retry pays a full handshake. That is the right way round: this path runs
     * once per stale socket, and a recovery that is merely cheap is worth
     * nothing next to one that works.
     */
    if (err != ESP_OK && !will_handshake) {
        ESP_LOGD(TAG, "reused connection failed (%s) — retrying on a fresh one",
                 esp_err_to_name(err));
        esp_http_client_cleanup(t_client);   /* closes the socket AND frees the handle */
        t_client = NULL;
        t_host[0] = '\0';
        /* The dead attempt may have accumulated a partial body before it died,
         * and the retry appends. Start it empty. */
        free(a.buf);
        memset(&a, 0, sizeof(a));

        t_client = client_new(url);
        if (!t_client) return false;
        esp_http_client_set_url(t_client, url);
        esp_http_client_set_user_data(t_client, &a);
        apply_cond(t_client, inm);   /* a fresh handle carries no headers */

        if (s_tls_connect_lock) xSemaphoreTake(s_tls_connect_lock, portMAX_DELAY);
        err = esp_http_client_perform(t_client);
        if (s_tls_connect_lock) xSemaphoreGive(s_tls_connect_lock);
    }

    /* Once, and here: the retry replaces the handle, so a status read before it
     * would belong to a request that no longer exists. */
    int code = esp_http_client_get_status_code(t_client);

    if (err != ESP_OK || a.oom) {
        if (err != ESP_OK) ESP_LOGW(TAG, "GET failed: %s", esp_err_to_name(err));
        /* The connection may be poisoned; close it so the next call reconnects
         * cleanly (the handle itself stays valid and reusable). */
        esp_http_client_close(t_client);
        t_host[0] = '\0';
        free(a.buf);
        /* Status stays 0. A perform that failed leaves the reused handle
         * reporting whatever the PREVIOUS request got, and handing that back
         * would let a stale 200 outlive the request that earned it — with the
         * conditional GET that is the difference between "the network is down"
         * and "the content is unchanged". Nothing regresses: http_get_bin()'s
         * one caller reads the status only when the body is non-NULL. */
        return false;
    }

    /* Success: remember the host so same-host follow-ups skip the handshake. */
    strncpy(t_host, host, sizeof(t_host) - 1);
    t_host[sizeof(t_host) - 1] = '\0';

    out->status = code;
    out->body   = a.buf;   /* caller frees; NULL on a 304, which carries none */
    out->len    = a.len;
    http_etag_copy(out->etag, sizeof(out->etag), a.etag);
    return true;
}
