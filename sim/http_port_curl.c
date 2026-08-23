/*
 * http_port_curl.c — simulator HTTP port (libcurl).
 *
 * Host-only implementation of http_get_cond(), with http_get() and
 * http_get_bin() written on top of it. Mirrors the device's esp_http_client
 * port so the simulator exercises the real fetch+parse+render path on macOS
 * (which, unlike the board, has internet). A browser-ish User-Agent is set
 * because some APIs reject default UAs.
 */
#include "http_port.h"

#include <curl/curl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>   /* strncasecmp: header field names are case-insensitive */

#define HTTP_MAX_RESP (320 * 1024)   /* mirror the device cap so the sim surfaces oversize responses */

/* No TLS-connect gate on the host: libcurl opens a fresh easy handle per call and
 * the desktop isn't crypto-starved. Defined so both ports satisfy the seam. */
void http_port_init(void) { }

/* Nothing to release: each http_get_cond() below opens and cleans up its own
 * easy handle — and http_get()/http_get_bin() are reimplemented on it — so this
 * port never holds a connection between calls in the first place. Defined so
 * both ports satisfy the seam. */
void http_port_release(void) { }

typedef struct {
    char  *buf; size_t len;
    char   etag[HTTP_ETAG_MAX];   /* "" unless the server sent one */
} membuf_t;

static size_t on_data(void *ptr, size_t size, size_t nmemb, void *userp) {
    size_t add = size * nmemb;
    membuf_t *m = (membuf_t *)userp;
    if (m->len + add + 1 > HTTP_MAX_RESP) return 0;   /* abort: response too large */
    char *p = realloc(m->buf, m->len + add + 1);
    if (!p) return 0;                 /* abort transfer on OOM */
    m->buf = p;
    memcpy(m->buf + m->len, ptr, add);
    m->len += add;
    m->buf[m->len] = '\0';
    return add;
}

/* One header line, CRLF-terminated and NOT NUL-terminated — libcurl hands over a
 * length, never a string. Only ETag is wanted, and its name is case-insensitive
 * per RFC 9110 §5.1; matching only the canonical spelling would leave the device
 * silently sending no If-None-Match forever. */
static size_t on_header(char *buf, size_t size, size_t nitems, void *userp) {
    const size_t n = size * nitems;
    membuf_t *m = (membuf_t *)userp;

    const char *colon = (const char *)memchr(buf, ':', n);
    if (!colon) return n;                      /* the status line, or the blank one */
    const size_t klen = (size_t)(colon - buf);
    if (klen != 4 || strncasecmp(buf, "ETag", 4) != 0) return n;

    const char *v = colon + 1;
    const char *end = buf + n;
    while (v < end && (*v == ' ' || *v == '\t')) v++;
    while (end > v && (end[-1] == '\r' || end[-1] == '\n' ||
                       end[-1] == ' '  || end[-1] == '\t')) end--;

    char val[HTTP_ETAG_MAX];
    size_t vlen = (size_t)(end - v);
    if (vlen > sizeof(val) - 1) vlen = sizeof(val) - 1;
    memcpy(val, v, vlen);
    val[vlen] = '\0';
    http_etag_copy(m->etag, sizeof(m->etag), val);
    return n;
}

char *http_get(const char *url, int *out_status) {
    return (char *)http_get_bin(url, NULL, out_status);
}

/* Both of the old entry points are this one call with pieces thrown away, so
 * there is a single transport per platform. */
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

    CURL *c = curl_easy_init();
    if (!c) return false;

    membuf_t m = {0};
    curl_easy_setopt(c, CURLOPT_URL, url);
    curl_easy_setopt(c, CURLOPT_WRITEFUNCTION, on_data);
    curl_easy_setopt(c, CURLOPT_WRITEDATA, &m);
    curl_easy_setopt(c, CURLOPT_HEADERFUNCTION, on_header);
    curl_easy_setopt(c, CURLOPT_HEADERDATA, &m);
    curl_easy_setopt(c, CURLOPT_FOLLOWLOCATION, 1L);
    curl_easy_setopt(c, CURLOPT_TIMEOUT, 20L);
    curl_easy_setopt(c, CURLOPT_USERAGENT,
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36");

    /* A fresh easy handle per call, so unlike the device port there is no stale
     * header to delete — but the rule is stated the same way on both sides: a
     * request with no tag carries no If-None-Match, and "" is no tag. */
    struct curl_slist *hdrs = NULL;
    if (req && req->if_none_match && req->if_none_match[0]) {
        char line[HTTP_ETAG_MAX + 32];
        snprintf(line, sizeof(line), "If-None-Match: %s", req->if_none_match);
        hdrs = curl_slist_append(NULL, line);
        curl_easy_setopt(c, CURLOPT_HTTPHEADER, hdrs);
    }

    CURLcode rc = curl_easy_perform(c);
    long code = 0;
    curl_easy_getinfo(c, CURLINFO_RESPONSE_CODE, &code);
    curl_easy_cleanup(c);
    if (hdrs) curl_slist_free_all(hdrs);

    /* libcurl reports a 304 as CURLE_OK with a response code and no body, which
     * is exactly this seam's contract; nothing special is needed for it here. A
     * transport failure keeps status 0 so it cannot be read as one. */
    if (rc != CURLE_OK) { free(m.buf); return false; }

    out->status = (int)code;
    out->body   = m.buf;   /* may be NULL for an empty 200; the caller decides */
    out->len    = m.len;
    http_etag_copy(out->etag, sizeof(out->etag), m.etag);
    return true;
}
