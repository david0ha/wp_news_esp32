#include "device_api.h"

#include <stdio.h>
#include <string.h>

#include "esp_http_server.h"
#include "esp_log.h"
#include "esp_mac.h"
#include "esp_netif.h"
#include "mdns.h"

#include "cJSON.h"
#include "device_api_json.h"
#include "epd6_panel.h"       /* epd6_framebuffer() — the bytes on the glass */
#include "epd6_transpose.h"   /* the format those bytes are in               */
#include "user_app_api.h"

static const char *TAG = "device_api";

/* Sized in device_api_json.h, where the host tests can assert the worst case
 * actually fits. */
#define STATE_BUF_SZ DEVICE_API_STATE_BUF_SZ
/* Control bodies are tiny ({"page":1}); the news URL is the largest. */
#define POST_BUF_SZ  320

// ---------------------------------------------------------------------------
// Small response helpers
// ---------------------------------------------------------------------------

static esp_err_t send_json(httpd_req_t *req, const char *status, const char *body)
{
    if (status != NULL) {
        httpd_resp_set_status(req, status);
    }
    httpd_resp_set_type(req, "application/json");
    httpd_resp_set_hdr(req, "Connection", "close");
    // Friendly to a browser-based dev build (react-native-web); native RN does not need it.
    httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
    return httpd_resp_sendstr(req, body);
}

static esp_err_t send_ok(httpd_req_t *req)
{
    return send_json(req, NULL, "{\"ok\":true}");
}

// {"ok":false,"error":"<code>"} under `status` — the app maps `error` to a typed Esp32Error.
static esp_err_t send_err_status(httpd_req_t *req, const char *status, const char *code)
{
    char buf[96];
    snprintf(buf, sizeof(buf), "{\"ok\":false,\"error\":\"%s\"}", code);
    return send_json(req, status, buf);
}

// 400 — a request the device understood and refused, which is every way a write fails.
static esp_err_t send_err(httpd_req_t *req, const char *code)
{
    return send_err_status(req, "400 Bad Request", code);
}

// Read the full request body into `buf` (NUL-terminated). Returns the byte count, or <0 on an
// oversize body / socket error (caller replies too_large/read_error).
static int read_body(httpd_req_t *req, char *buf, size_t bufsz)
{
    if (req->content_len > (int)bufsz - 1) {
        return -1;
    }
    int total = 0;
    int remaining = req->content_len;
    while (remaining > 0) {
        int r = httpd_req_recv(req, buf + total, remaining);
        if (r == HTTPD_SOCK_ERR_TIMEOUT) {
            continue;   // transient recv timeout — retry rather than abort the body
        }
        if (r <= 0) {
            return -2;
        }
        total += r;
        remaining -= r;
    }
    buf[total] = '\0';
    return total;
}

// Read + parse the JSON body. On success returns the cJSON root (caller must cJSON_Delete);
// on failure returns NULL having already sent the error response.
static cJSON *parse_body(httpd_req_t *req, esp_err_t *sent)
{
    char body[POST_BUF_SZ];
    int blen = read_body(req, body, sizeof(body));
    if (blen == -1) { *sent = send_err(req, "too_large"); return NULL; }
    if (blen < 0)   { *sent = send_err(req, "read_error"); return NULL; }
    cJSON *root = cJSON_Parse(body);
    if (root == NULL) { *sent = send_err(req, "bad_json"); return NULL; }
    return root;
}

// ---------------------------------------------------------------------------
// Device identity
// ---------------------------------------------------------------------------

static void device_id(char *out /* >= 5 bytes */)
{
    uint8_t mac[6] = {0};
    esp_read_mac(mac, ESP_MAC_WIFI_STA);
    snprintf(out, 5, "%02X%02X", mac[4], mac[5]);
}

static void sta_ip(char *out, size_t n)
{
    out[0] = '\0';
    esp_netif_t *nif = esp_netif_get_handle_from_ifkey("WIFI_STA_DEF");
    if (nif == NULL) {
        return;
    }
    esp_netif_ip_info_t ip;
    if (esp_netif_get_ip_info(nif, &ip) == ESP_OK) {
        snprintf(out, n, IPSTR, IP2STR(&ip.ip));
    }
}

// ---------------------------------------------------------------------------
// GET handlers
// ---------------------------------------------------------------------------

static esp_err_t api_info_get(httpd_req_t *req)
{
    char id[DEV_DEVID_MAXLEN], ip[DEV_IP_MAXLEN];
    device_id(id);
    sta_ip(ip, sizeof(ip));
    char body[DEVICE_API_INFO_BUF_SZ];
    if (device_api_json_info(body, sizeof(body), id, DEVICE_MODEL, DEVICE_FW, ip) < 0) {
        return httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "info");
    }
    return send_json(req, NULL, body);
}

static esp_err_t api_state_get(httpd_req_t *req)
{
    static device_state_t st;      // 956B — too big for the httpd task's stack
    user_app_snapshot(&st);
    device_id(st.device_id);       // network identity is owned here, not by user_app
    sta_ip(st.ip, sizeof(st.ip));

    static char buf[STATE_BUF_SZ]; // the single httpd task serializes one response at a time
    if (device_api_json_state(&st, buf, sizeof(buf)) < 0) {
        return httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "state");
    }
    return send_json(req, NULL, buf);
}

// ---------------------------------------------------------------------------
// GET /api/screen — the page on the glass, as the bytes that put it there
// ---------------------------------------------------------------------------

/* The framebuffer leaves in 8 KB pieces. Nothing is allocated at any size — the
 * number is a stride over PSRAM, not a buffer — so the only things it decides are
 * how many chunk headers cross the wire (960,000 is 117 whole pieces and a 1,536-byte
 * remainder, so 118 of them plus the zero-length one that ends the body — about 950
 * bytes, under 0.1%) and how often the loop hands back to the TCP stack. 8 KB is
 * already more than lwIP's default 5,760-byte send buffer, so the window is never
 * what this loop is waiting on, and a larger piece has nothing left to buy. */
#define SCREEN_CHUNK_SZ 8192

/* The five X-Screen-* values below are literals, and these asserts are what makes
 * that safe. They describe a WIRE format whose version handle is X-Screen-Format: a
 * client decoding 4bpp, 600-stride bytes because the header said so has to be told
 * when that stops being true. Geometry moving underneath an unchanged token is the
 * one failure here with no symptom on this side of the wire, so it stops the build
 * instead — here, at the lines that have to be reconsidered. */
_Static_assert(EPD6_W == 1200, "X-Screen-Width no longer describes the framebuffer");
_Static_assert(EPD6_H == 1600, "X-Screen-Height no longer describes the framebuffer");
_Static_assert(EPD6_FB_STRIDE == 600, "X-Screen-Stride no longer describes the framebuffer");
_Static_assert(EPD6_FB_STRIDE * 8 == EPD6_W * 4, "X-Screen-Bpp is no longer 4");

/* Eight response headers leave with a screen: Connection, the two CORS ones, and the
 * five X-Screen-* below. Content-Type is not among them — it goes in the status line
 * and costs no slot. Expose-Headers earns its slot because a browser shows JS only
 * the safelisted response headers: without it a web build reads all five X-Screen-*
 * as null, and the claudepost-6ink-v1 version guard — the whole reason the token
 * exists — silently stops guarding there. This is the widest any handler in this
 * file gets, so start_http() sizes httpd's header table from it, for the same reason
 * max_uri_handlers is counted rather than chosen: httpd_resp_set_hdr() returns
 * ESP_ERR_HTTPD_RESP_HDR once that table is full, nothing here checks it, and a
 * budget one short is therefore not a build failure but a header that silently never
 * arrives — on the one route whose correctness depends on its headers arriving,
 * since they are the only thing that says what shape the 960,000 bytes are.
 * Adding an X-Screen-* means changing this. */
#define SCREEN_RESP_HEADERS 8

// GET /api/screen — the framebuffer verbatim: EPD6_FB_SIZE bytes, portrait 1200x1600
// at 4bpp, nibble order and palette codes exactly as epd6_transpose.h defines them.
// The phone renders the page from these, which is why the firmware carries no image
// codec and the desk is not asked for a proof: this is the literal glass, and it
// answers on a board with no desk at all.
//
// This is the only route that reads the panel layer, and it stays inside the rule it
// looks like it breaks. epd6_framebuffer() lives under "framebuffer (no panel
// traffic)" in epd6_panel.h — no SPI, no refresh, no LVGL. What exactly one task is
// allowed to do is START a refresh, and twenty-five seconds of panel time is the
// thing this route exists in order not to spend.
//
// Streamed in place out of PSRAM. 960,000 bytes is larger than the whole of the S3's
// internal RAM, so there is no version of this that copies the body first.
//
// A request that lands mid-render sees a torn frame — part of the edition going up,
// part of the one coming down. That is a preview artifact rather than a defect: the
// alternative is locking the UI task out of its own framebuffer for as long as a
// phone takes to download it, to spare a reader one imperfect frame of a page that
// flashes for twenty-five seconds whenever it really does change. docs/app-control.md
// tells the reader the same thing.
static esp_err_t api_screen_get(httpd_req_t *req)
{
    const uint8_t *fb = epd6_framebuffer();
    if (fb == NULL) {
        // Defensive, and expected never to fire: this server is started only from the
        // full boot path, well after epd6_init() has allocated the framebuffer, and
        // the quiet wake path never starts it at all. 503 rather than 500 because if
        // it ever does fire it is a board that has not finished coming up — a state
        // that ends by itself, and one an app answers by asking again.
        return send_err_status(req, "503 Service Unavailable", "no_framebuffer");
    }

    httpd_resp_set_type(req, "application/octet-stream");
    httpd_resp_set_hdr(req, "Connection", "close");
    httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
    httpd_resp_set_hdr(req, "X-Screen-Width",  "1200");
    httpd_resp_set_hdr(req, "X-Screen-Height", "1600");
    httpd_resp_set_hdr(req, "X-Screen-Stride", "600");
    httpd_resp_set_hdr(req, "X-Screen-Bpp",    "4");
    httpd_resp_set_hdr(req, "X-Screen-Format", "claudepost-6ink-v1");
    httpd_resp_set_hdr(req, "Access-Control-Expose-Headers",
                       "X-Screen-Width, X-Screen-Height, X-Screen-Stride, X-Screen-Bpp, X-Screen-Format");

    for (size_t off = 0; off < EPD6_FB_SIZE; off += SCREEN_CHUNK_SZ) {
        size_t n = EPD6_FB_SIZE - off;
        if (n > SCREEN_CHUNK_SZ) {
            n = SCREEN_CHUNK_SZ;
        }
        if (httpd_resp_send_chunk(req, (const char *)fb + off, n) != ESP_OK) {
            // The phone hung up mid-page. httpd has already dropped the socket, so a
            // terminating chunk would go nowhere; ESP_FAIL is how a handler says the
            // response is over without sending one.
            ESP_LOGW(TAG, "screen: client left after %u of %u B",
                     (unsigned)off, (unsigned)EPD6_FB_SIZE);
            return ESP_FAIL;
        }
    }
    return httpd_resp_send_chunk(req, NULL, 0);   // the zero-length chunk ends the body
}

// ---------------------------------------------------------------------------
// POST handlers — drive the app via the user_app_api bridge
// ---------------------------------------------------------------------------

// POST /api/refresh — no body. Poll the news source now instead of waiting out
// the interval. The panel is only refreshed if what comes back differs from what
// is already on the glass, so this is safe to call repeatedly.
static esp_err_t api_refresh_post(httpd_req_t *req)
{
    return user_app_refresh_now() ? send_ok(req) : send_err(req, "busy");
}

// POST /api/page { page: 0..1 }   A1 = the front page, A2 = markets
static esp_err_t api_page_post(httpd_req_t *req)
{
    esp_err_t sent;
    cJSON *root = parse_body(req, &sent);
    if (root == NULL) return sent;

    esp_err_t rc;
    cJSON *pg = cJSON_GetObjectItem(root, "page");
    if (!cJSON_IsNumber(pg)) {
        rc = send_err(req, "bad_json");
    } else {
        rc = user_app_set_page((int)pg->valuedouble) ? send_ok(req) : send_err(req, "page_range");
    }
    cJSON_Delete(root);
    return rc;
}

// POST /api/news { url } — point the device at a different snapshot URL. Persisted to NVS and
// applied live; an empty string switches to the built-in demo snapshot.
static esp_err_t api_news_post(httpd_req_t *req)
{
    esp_err_t sent;
    cJSON *root = parse_body(req, &sent);
    if (root == NULL) return sent;

    cJSON *url = cJSON_GetObjectItem(root, "url");
    esp_err_t rc;
    if (!cJSON_IsString(url) || url->valuestring == NULL) {
        rc = send_err(req, "bad_json");
    } else if (!user_app_set_news_url(url->valuestring)) {
        // One code for both "not a usable URL" and "queue full": the first is by
        // far the likelier, and the app cannot do anything different about the
        // second anyway.
        rc = send_err(req, "news_url_invalid");
    } else {
        rc = send_ok(req);
    }
    cJSON_Delete(root);
    return rc;
}

// POST /api/display/test — no body. Runs the panel self-test sweep (tens of seconds
// of full refreshes) on the UI task; replies as soon as it is queued, not when it finishes.
static esp_err_t api_display_test_post(httpd_req_t *req)
{
    return user_app_display_test() ? send_ok(req) : send_err(req, "busy");
}

// POST /api/sleep { seconds } — how long the board sleeps between polls. Persisted to NVS and
// copied into RTC memory, so it applies from the next wake without a reboot. `0` means "use the
// build-time default"; anything else is clamped into [60, 86400] rather than rejected.
//
// Only reachable on a board that is awake — which, once deep sleep is on, means during the window
// a button press opens. That is expected rather than a fault; see docs/app-control.md.
static esp_err_t api_sleep_post(httpd_req_t *req)
{
    esp_err_t sent;
    cJSON *root = parse_body(req, &sent);
    if (root == NULL) return sent;

    cJSON *sec = cJSON_GetObjectItem(root, "seconds");
    esp_err_t rc;
    if (!cJSON_IsNumber(sec)) {
        rc = send_err(req, "bad_json");
    } else if (sec->valuedouble < 0 || sec->valuedouble > 4294967295.0) {
        // The clamp downstream takes any uint32_t, so the only genuinely wrong answers are the
        // ones that are not one. A negative is named rather than folded to zero: zero already
        // means "use the default", and silently granting that to somebody who asked for -1 is a
        // board doing something nobody requested.
        rc = send_err(req, "sleep_seconds_invalid");
    } else {
        rc = user_app_set_sleep_seconds((uint32_t)sec->valuedouble) ? send_ok(req)
                                                                    : send_err(req, "busy");
    }
    cJSON_Delete(root);
    return rc;
}

// ---------------------------------------------------------------------------
// Server + mDNS bring-up
// ---------------------------------------------------------------------------

static void start_http(void)
{
    const httpd_uri_t routes[] = {
        {.uri = "/api/info",         .method = HTTP_GET,  .handler = api_info_get},
        {.uri = "/api/state",        .method = HTTP_GET,  .handler = api_state_get},
        {.uri = "/api/screen",       .method = HTTP_GET,  .handler = api_screen_get},
        {.uri = "/api/refresh",      .method = HTTP_POST, .handler = api_refresh_post},
        {.uri = "/api/page",         .method = HTTP_POST, .handler = api_page_post},
        {.uri = "/api/news",         .method = HTTP_POST, .handler = api_news_post},
        {.uri = "/api/sleep",        .method = HTTP_POST, .handler = api_sleep_post},
        {.uri = "/api/display/test", .method = HTTP_POST, .handler = api_display_test_post},
    };

    httpd_config_t config = HTTPD_DEFAULT_CONFIG();
    config.server_port = 80;
    /* Counted from the table rather than chosen. httpd_register_uri_handler() fails
     * once the table it was given is full, and the loop below does not check — so a
     * hand-picked number one short does not fail to build, it serves a route that
     * silently never answers. The 8 this replaces was exactly the count it happened
     * to have, which is the version of this that runs out on the next route. */
    config.max_uri_handlers = sizeof(routes) / sizeof(routes[0]);
    /* Same argument, the other table: sized by the handler that sets the most headers,
     * which is /api/screen. HTTPD_DEFAULT_CONFIG's 8 happens to cover today's 7, and a
     * coincidence is not what should stand between a client and the header that tells
     * it how to read a megabyte. */
    config.max_resp_headers = SCREEN_RESP_HEADERS;
    config.lru_purge_enable = true;
    config.stack_size = 8192;

    httpd_handle_t server = NULL;
    if (httpd_start(&server, &config) != ESP_OK) {
        ESP_LOGE(TAG, "httpd_start failed");
        return;
    }

    for (size_t i = 0; i < sizeof(routes) / sizeof(routes[0]); i++) {
        httpd_register_uri_handler(server, &routes[i]);
    }
    ESP_LOGI(TAG, "control server up on port 80");
}

static void start_mdns(void)
{
    esp_err_t err = mdns_init();
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "mdns_init failed: %s", esp_err_to_name(err));
        return;
    }
    // NOT "tickerboard": that name belongs to the fortune board this project
    // forked from, whose shipped app resolves tickerboard.local. Two devices
    // answering the same discovery probe on one LAN is a support ticket nobody
    // can debug from the outside.
    mdns_hostname_set("claudepost");
    mdns_instance_name_set(DEVICE_MODEL);
    mdns_service_add(NULL, "_http", "_tcp", 80, NULL, 0);
    ESP_LOGI(TAG, "mDNS advertising http://claudepost.local");
}

void device_api_start(void)
{
    start_http();
    start_mdns();
}
