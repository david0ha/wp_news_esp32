/*
 * Host unit tests for news_service.c.
 *
 * The layer is thin — http_get() plus news_parse() — but it owns two things
 * nothing else does, and both are the kind that only misbehave on a bad day:
 * which failures are distinguished from each other, and whether *out survives
 * a failure.
 *
 * The HTTP port is the project's one platform seam, so a test can simply BE the
 * port: this file defines http_get_cond() itself, and the linker takes it
 * instead of either the esp_http_client or the libcurl implementation. That is
 * the same property the simulator relies on, exercised here without a server.
 *
 * The conditional GET adds a third thing worth owning, and it is the one that
 * only misbehaves on a good day: a 304 has no body, so the old seam reported it
 * exactly as it reported a dead network. Under deep sleep a 304 is the most
 * common SUCCESSFUL outcome there is, and reading it as an outage would drive
 * the failure backoff on every healthy poll — a board that gets slower the
 * better the server behaves. Half of what follows exists to pin that down.
 */
#include "th.h"

#include <stdbool.h>

#include "http_port.h"
#include "news_model.h"
#include "news_service.h"

/* --- the fake port -------------------------------------------------------- */

static const char *g_body;      /* NULL = a response with no body — see g_status */
static int         g_status;    /* 0 = the transport failed before any status    */
static int         g_calls;
static const char *g_etag_out;  /* the ETag the fake server sends; NULL = none   */
static char        g_etag_in[256];  /* the If-None-Match it received             */
static bool        g_cond_in;   /* whether the request carried that header at all */

void http_port_init(void) { }

/* Every test starts from the same server: offering no tag, having seen none. */
static void port_reset(void)
{
    g_body       = NULL;
    g_status     = 0;
    g_calls      = 0;
    g_etag_out   = NULL;
    g_etag_in[0] = '\0';
    g_cond_in    = false;
}

bool http_get_cond(const char *url, const http_req_t *req, http_resp_t *out)
{
    (void)url;
    g_calls++;

    /* Record what a real port would have put on the wire, not what it was
     * handed: NULL and "" are both "send no header at all", and collapsing them
     * here is what lets a test tell "the stored tag went out" from "the caller
     * passed an empty one and we sent it anyway". */
    g_etag_in[0] = '\0';
    g_cond_in    = false;
    if (req && req->if_none_match && req->if_none_match[0]) {
        g_cond_in = true;
        http_etag_copy(g_etag_in, sizeof(g_etag_in), req->if_none_match);
    }

    memset(out, 0, sizeof(*out));
    out->status = g_status;
    if (g_status == 0) return false;   /* the transport failed: no status at all */

    /* Bounded exactly as the real ports must bound it — the field is fixed and
     * the value is arbitrary bytes off the network. */
    http_etag_copy(out->etag, sizeof(out->etag), g_etag_out);

    if (g_body) {
        /* Returned on the heap, exactly as the real ports do. Whether
         * news_service actually frees it is NOT asserted here — free() cannot be
         * intercepted portably, and macOS's ASan has no leak detector — so that one
         * stays a matter of reading the code. What this does buy is that every path
         * runs against a real allocation, so a double free or a use-after-free does
         * trap. */
        size_t n = strlen(g_body);
        char *p = (char *)malloc(n + 1);
        memcpy(p, g_body, n + 1);
        out->body = p;
        out->len  = n;
    }
    return true;
}

/* Defined so this file remains a complete port, and expressed through the
 * conditional one for the same reason both real ports are: two transports that
 * can drift is one transport too many. */
char *http_get(const char *url, int *out_status)
{
    http_resp_t r;
    (void)http_get_cond(url, NULL, &r);
    if (out_status) *out_status = r.status;
    return r.body;
}

/* news_t is ~18 KB, so the destination is file-static rather than a local in
 * every helper: a test that puts four of them on one frame is a test that will
 * one day be run somewhere smaller than a host. */
static news_t g_v;

static void expect(const char *label, const char *body, int status,
                   news_fetch_result_t want)
{
    g_body = body;
    g_status = status;

    memset(&g_v, 0, sizeof(g_v));
    news_fetch_result_t got = news_service_fetch("http://host/news.json", &g_v);
    g_total++;
    if (got != want) {
        g_fail++;
        printf("  FAIL %s: got %s, want %s\n", label,
               news_fetch_result_name(got), news_fetch_result_name(want));
    }
}

/* The same, through the conditional entry point. Kept separate rather than
 * folded together so both doors are actually opened: news_service_fetch() is
 * the wrapper every existing caller still uses, and a wrapper that stopped
 * forwarding correctly would otherwise be invisible. */
static news_fetch_result_t fetch_cond(const char *body, int status,
                                      const char *if_none_match,
                                      char *out_etag, size_t etag_size)
{
    g_body = body;
    g_status = status;
    return news_service_fetch_cond("http://host/news.json", if_none_match,
                                   &g_v, out_etag, etag_size);
}

/* --- tests ---------------------------------------------------------------- */

static void test_success(void)
{
    size_t len = 0;
    char *json = th_slurp(FIXDIR "/news.json", &len);
    expect("good payload", json, 200, NEWS_FETCH_OK);

    /* And it must actually be parsed, not merely accepted. */
    g_body = json;
    g_status = 200;
    memset(&g_v, 0, sizeof(g_v));
    CHECK(news_service_fetch("http://host/news.json", &g_v) == NEWS_FETCH_OK);
    CHECK_INT(g_v.story_count, 4);
    CHECK_INT(g_v.figure_count, 22);
    CHECK_STR(g_v.subject.symbol, "SNDK");
    CHECK(g_v.valid == true);
    CHECK(g_v.demo == false);

    free(json);
}

static void test_no_url_is_not_a_failure(void)
{
    /* An unconfigured board is a supported, complete state — it shows the demo
     * front page. The transport must not even be reached. */
    memset(&g_v, 0, sizeof(g_v));
    g_calls = 0;
    g_body = "{}";
    g_status = 200;

    CHECK(news_service_fetch("", &g_v) == NEWS_FETCH_NO_URL);
    CHECK(news_service_fetch(NULL, &g_v) == NEWS_FETCH_NO_URL);
    CHECK_INT(g_calls, 0);

    /* A NULL destination is a programming error, not a fetch. */
    CHECK(news_service_fetch("http://host/x", NULL) == NEWS_FETCH_NO_URL);
    CHECK_INT(g_calls, 0);
}

static void test_the_three_failures_are_distinguished(void)
{
    /* These are three different mistakes and they need three different names:
     * the log line is all a user has to go on, and "your URL is wrong" and
     * "your JSON is wrong" send them to different places. */
    expect("transport", NULL, 0, NEWS_FETCH_TRANSPORT);
    expect("404", "<html>Not Found</html>", 404, NEWS_FETCH_HTTP_STATUS);
    expect("500", "{\"subject\":{\"symbol\":\"SNDK\"}}", 500, NEWS_FETCH_HTTP_STATUS);
    expect("302", "", 302, NEWS_FETCH_HTTP_STATUS);
    expect("captive portal", "<html>Sign in</html>", 200, NEWS_FETCH_BAD_PAYLOAD);
    expect("empty object", "{}", 200, NEWS_FETCH_BAD_PAYLOAD);
    expect("truncated", "{\"subject\":{\"symbol\":\"SN", 200, NEWS_FETCH_BAD_PAYLOAD);
}

static void test_status_is_checked_before_the_body(void)
{
    /* A 500 whose body happens to be a perfectly good snapshot must still be a
     * status error. Servers do return stale caches with error codes, and
     * silently rendering one would hide an outage the user could otherwise see
     * in the header. */
    size_t len = 0;
    char *json = th_slurp(FIXDIR "/news.json", &len);
    expect("valid body behind a 503", json, 503, NEWS_FETCH_HTTP_STATUS);
    free(json);
}

static void test_the_whole_2xx_range_is_accepted(void)
{
    size_t len = 0;
    char *json = th_slurp(FIXDIR "/news.json", &len);
    expect("200", json, 200, NEWS_FETCH_OK);
    expect("201", json, 201, NEWS_FETCH_OK);
    expect("299", json, 299, NEWS_FETCH_OK);
    expect("199", json, 199, NEWS_FETCH_HTTP_STATUS);
    expect("300", json, 300, NEWS_FETCH_HTTP_STATUS);

    /* 304 is a success that is not in the 2xx range, and it is the only one, so
     * it is tested here beside the range rather than left to imply itself. The
     * ordering this pins down is the whole point: 304 is answered before the
     * 2xx test, and a redirect is answered after it. */
    expect("304 with no body", NULL, 304, NEWS_FETCH_NOT_MODIFIED);
    expect("304 with a body anyway", json, 304, NEWS_FETCH_NOT_MODIFIED);

    /* A captive portal's redirect sits one integer away from "unchanged" and
     * means the opposite. Mistaking it would leave a board on a hotel network
     * asleep for months, convinced its front page was current. */
    expect("301", json, 301, NEWS_FETCH_HTTP_STATUS);
    expect("302", json, 302, NEWS_FETCH_HTTP_STATUS);
    expect("303", json, 303, NEWS_FETCH_HTTP_STATUS);
    expect("305", json, 305, NEWS_FETCH_HTTP_STATUS);

    /* A status now outranks an empty body. The old seam could not tell a
     * bodyless 404 from a dead network because both arrived as NULL; the
     * conditional one reports the status it was given. */
    expect("bodyless 404", NULL, 404, NEWS_FETCH_HTTP_STATUS);
    free(json);
}

static void test_304_is_a_success_not_a_failure(void)
{
    /* The trap this whole seam exists to close. A 304 carries no body, so the
     * only thing distinguishing it from a transport failure is the status — and
     * a fetch layer that calls it TRANSPORT would count a failure, lengthen the
     * backoff and eventually badge OFFLINE, every time the server correctly
     * said "nothing has changed". */
    port_reset();
    memset(&g_v, 0, sizeof(g_v));
    news_fetch_result_t r = fetch_cond(NULL, 304, "\"abc\"", NULL, 0);
    CHECK(r == NEWS_FETCH_NOT_MODIFIED);
    CHECK(r != NEWS_FETCH_TRANSPORT);
    CHECK_INT(g_calls, 1);

    /* And the real thing still is one: no status at all, no body. */
    CHECK(fetch_cond(NULL, 0, "\"abc\"", NULL, 0) == NEWS_FETCH_TRANSPORT);
}

static void test_304_leaves_the_snapshot_untouched(void)
{
    /* Same product requirement as every failure path, for the opposite reason:
     * a 304 is the server promising the previous snapshot is still right, so
     * the one place it must not appear is in *out. */
    port_reset();
    size_t len = 0;
    char *json = th_slurp(FIXDIR "/news.json", &len);

    memset(&g_v, 0, sizeof(g_v));
    char etag[HTTP_ETAG_MAX] = "";
    g_etag_out = "\"v1\"";
    CHECK(fetch_cond(json, 200, NULL, etag, sizeof(etag)) == NEWS_FETCH_OK);
    uint32_t before = news_hash(&g_v);
    free(json);
    CHECK_STR(etag, "\"v1\"");

    CHECK(fetch_cond(NULL, 304, etag, etag, sizeof(etag)) == NEWS_FETCH_NOT_MODIFIED);
    CHECK_INT(news_hash(&g_v), before);
    /* And the tag survives it. A 304 means the tag the device sent is still the
     * name of the document on the glass, so there is nothing to update — and
     * blanking it here would turn every second poll into a full transfer. */
    CHECK_STR(etag, "\"v1\"");
    g_etag_out = NULL;
}

static void test_the_stored_etag_is_sent(void)
{
    /* A stored tag that never leaves the device saves nothing and fails
     * silently: every poll would be a full 200 and the only symptom would be a
     * battery that runs down faster than the arithmetic said it would. */
    port_reset();
    size_t len = 0;
    char *json = th_slurp(FIXDIR "/news.json", &len);

    CHECK(fetch_cond(json, 200, "\"abc\"", NULL, 0) == NEWS_FETCH_OK);
    CHECK(g_cond_in == true);
    CHECK_STR(g_etag_in, "\"abc\"");

    /* No tag yet — a first poll, or a server that offers none — must send no
     * header rather than an empty one, which some servers answer with a 304. */
    CHECK(fetch_cond(json, 200, NULL, NULL, 0) == NEWS_FETCH_OK);
    CHECK(g_cond_in == false);
    CHECK_STR(g_etag_in, "");

    CHECK(fetch_cond(json, 200, "", NULL, 0) == NEWS_FETCH_OK);
    CHECK(g_cond_in == false);
    CHECK_STR(g_etag_in, "");

    /* The unconditional wrapper every existing caller still uses is exactly the
     * conditional one with no tag, and nothing else. */
    g_body = json; g_status = 200;
    memset(&g_v, 0, sizeof(g_v));
    CHECK(news_service_fetch("http://host/news.json", &g_v) == NEWS_FETCH_OK);
    CHECK(g_cond_in == false);

    free(json);
}

static void test_a_200_reports_the_new_etag(void)
{
    port_reset();
    size_t len = 0;
    char *json = th_slurp(FIXDIR "/news.json", &len);

    char etag[HTTP_ETAG_MAX];
    memcpy(etag, "stale", sizeof("stale"));
    g_etag_out = "\"deadbeef00000001\"";
    CHECK(fetch_cond(json, 200, "stale", etag, sizeof(etag)) == NEWS_FETCH_OK);
    CHECK_STR(etag, "\"deadbeef00000001\"");

    /* A server that stops sending tags must clear the one we hold, not leave it
     * standing. A tag kept past the document it named is a lie the device would
     * keep asking about, and a server that later reuses tags could answer 304
     * for a page this board has never seen. */
    g_etag_out = NULL;
    CHECK(fetch_cond(json, 200, etag, etag, sizeof(etag)) == NEWS_FETCH_OK);
    CHECK_STR(etag, "");

    /* A caller that does not care is allowed not to care. */
    CHECK(fetch_cond(json, 200, NULL, NULL, 0) == NEWS_FETCH_OK);
    CHECK(fetch_cond(json, 200, NULL, etag, 0) == NEWS_FETCH_OK);

    free(json);
}

static void test_the_etag_is_truncated_safely(void)
{
    /* An ETag is opaque bytes chosen by whatever is on the other end of the
     * wire, and the device stores it in a fixed field in RTC memory. A server
     * that sends 200 characters — buggy, or hostile, or just a proxy adding its
     * own — must cost a wasted conditional GET, never a byte past the end of
     * somebody else's state. Build with -DSANITIZE=ON: the heap buffer below is
     * what turns an off-by-one from a pass into a crash. */
    port_reset();
    size_t len = 0;
    char *json = th_slurp(FIXDIR "/news.json", &len);

    char big[201];
    memset(big, 'x', sizeof(big) - 1);
    big[sizeof(big) - 1] = '\0';
    g_etag_out = big;

    char etag[HTTP_ETAG_MAX];
    memset(etag, 0x7f, sizeof(etag));
    CHECK(fetch_cond(json, 200, NULL, etag, sizeof(etag)) == NEWS_FETCH_OK);
    CHECK_INT(strlen(etag), HTTP_ETAG_MAX - 1);
    CHECK(memcmp(etag, big, HTTP_ETAG_MAX - 1) == 0);

    /* And a caller buffer smaller than the seam's field is respected too — the
     * bound that matters is the one the caller passed, not the one in the port. */
    char *small = (char *)malloc(8);
    memset(small, 0x7f, 8);
    CHECK(fetch_cond(json, 200, NULL, small, 8) == NEWS_FETCH_OK);
    CHECK_INT(strlen(small), 7);
    free(small);

    /* A one-byte buffer is a NUL and nothing else, not a write of the first
     * character followed by a terminator past the end. */
    char *one = (char *)malloc(1);
    *one = 0x7f;
    CHECK(fetch_cond(json, 200, NULL, one, 1) == NEWS_FETCH_OK);
    CHECK_INT(*one, 0);
    free(one);

    g_etag_out = NULL;
    free(json);
}

static void test_a_failed_fetch_does_not_clobber_the_etag(void)
{
    /* The standing rule extended to the second output. It is not symmetry for
     * its own sake: recording the tag of a payload that failed to parse is the
     * worst outcome available here, because the next poll would send it, get a
     * 304, and the device would never look at that document again. A board
     * stuck on yesterday's page with a healthy-looking log. */
    port_reset();
    size_t len = 0;
    char *json = th_slurp(FIXDIR "/news.json", &len);

    char etag[HTTP_ETAG_MAX];
    g_etag_out = "\"good\"";
    CHECK(fetch_cond(json, 200, NULL, etag, sizeof(etag)) == NEWS_FETCH_OK);
    CHECK_STR(etag, "\"good\"");
    uint32_t before = news_hash(&g_v);
    free(json);

    g_etag_out = "\"poison\"";
    const struct { const char *body; int status; news_fetch_result_t want; } bad[] = {
        { NULL,                       0,   NEWS_FETCH_TRANSPORT   },
        { "<html>404</html>",         404, NEWS_FETCH_HTTP_STATUS },
        { "{}",                       200, NEWS_FETCH_BAD_PAYLOAD },
        { "not json at all",          200, NEWS_FETCH_BAD_PAYLOAD },
        { "{\"subject\":{\"symbol\"", 200, NEWS_FETCH_BAD_PAYLOAD },
    };
    for (size_t i = 0; i < sizeof(bad) / sizeof(bad[0]); i++) {
        CHECK(fetch_cond(bad[i].body, bad[i].status, etag, etag, sizeof(etag))
              == bad[i].want);
        CHECK_STR(etag, "\"good\"");
        CHECK_INT(news_hash(&g_v), before);
    }
    g_etag_out = NULL;
}

static void test_a_failure_leaves_the_destination_untouched(void)
{
    /* The product requirement behind every failure path: a bad poll keeps the
     * previous front page on the glass. "Returns non-OK" does not guarantee it;
     * writing *out before validating would. */
    size_t len = 0;
    char *json = th_slurp(FIXDIR "/news.json", &len);

    memset(&g_v, 0, sizeof(g_v));
    g_body = json;
    g_status = 200;
    CHECK(news_service_fetch("http://host/x", &g_v) == NEWS_FETCH_OK);
    uint32_t before = news_hash(&g_v);
    free(json);

    const struct { const char *body; int status; } bad[] = {
        { NULL,                        0   },
        { "<html>404</html>",          404 },
        { "{}",                        200 },
        { "not json at all",           200 },
        { "{\"subject\":{\"symbol\"",  200 },
    };
    for (size_t i = 0; i < sizeof(bad) / sizeof(bad[0]); i++) {
        g_body = bad[i].body;
        g_status = bad[i].status;
        CHECK(news_service_fetch("http://host/x", &g_v) != NEWS_FETCH_OK);
        CHECK_INT(news_hash(&g_v), before);
    }
}

static void test_result_names_are_stable(void)
{
    /* These strings go into the log AND into /api/state's `lastResult`, where a
     * client may branch on them. */
    CHECK_STR(news_fetch_result_name(NEWS_FETCH_OK), "ok");
    CHECK_STR(news_fetch_result_name(NEWS_FETCH_NO_URL), "no_url");
    CHECK_STR(news_fetch_result_name(NEWS_FETCH_TRANSPORT), "transport");
    CHECK_STR(news_fetch_result_name(NEWS_FETCH_HTTP_STATUS), "http_status");
    CHECK_STR(news_fetch_result_name(NEWS_FETCH_BAD_PAYLOAD), "bad_payload");
    CHECK_STR(news_fetch_result_name(NEWS_FETCH_NOT_MODIFIED), "not_modified");
    CHECK_STR(news_fetch_result_name((news_fetch_result_t)99), "unknown");
}

int main(void)
{
    test_success();
    test_no_url_is_not_a_failure();
    test_the_three_failures_are_distinguished();
    test_status_is_checked_before_the_body();
    test_the_whole_2xx_range_is_accepted();
    test_a_failure_leaves_the_destination_untouched();
    test_304_is_a_success_not_a_failure();
    test_304_leaves_the_snapshot_untouched();
    test_the_stored_etag_is_sent();
    test_a_200_reports_the_new_etag();
    test_the_etag_is_truncated_safely();
    test_a_failed_fetch_does_not_clobber_the_etag();
    test_result_names_are_stable();
    TH_REPORT("news_service");
}
