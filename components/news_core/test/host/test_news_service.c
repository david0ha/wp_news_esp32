/*
 * Host unit tests for news_service.c.
 *
 * The layer is thin — http_get() plus news_parse() — but it owns two things
 * nothing else does, and both are the kind that only misbehave on a bad day:
 * which failures are distinguished from each other, and whether *out survives
 * a failure.
 *
 * The HTTP port is the project's one platform seam, so a test can simply BE the
 * port: this file defines http_get() itself, and the linker takes it instead of
 * either the esp_http_client or the libcurl implementation. That is the same
 * property the simulator relies on, exercised here without a server.
 */
#include "th.h"

#include "http_port.h"
#include "news_model.h"
#include "news_service.h"

/* --- the fake port -------------------------------------------------------- */

static const char *g_body;      /* NULL = transport failure */
static int         g_status;
static int         g_calls;

void http_port_init(void) { }

char *http_get(const char *url, int *out_status)
{
    (void)url;
    g_calls++;
    if (out_status) *out_status = g_status;
    if (!g_body) return NULL;

    /* Returned on the heap, exactly as the real ports do. Whether
     * news_service actually frees it is NOT asserted here — free() cannot be
     * intercepted portably, and macOS's ASan has no leak detector — so that one
     * stays a matter of reading the code. What this does buy is that every path
     * runs against a real allocation, so a double free or a use-after-free does
     * trap. */
    size_t n = strlen(g_body);
    char *p = (char *)malloc(n + 1);
    memcpy(p, g_body, n + 1);
    return p;
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
    free(json);
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
    test_result_names_are_stable();
    TH_REPORT("news_service");
}
