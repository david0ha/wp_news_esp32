/*
 * Host unit tests for the companion-app JSON serializers.
 *
 * These bytes go straight onto the wire to a phone, so the tests check two
 * different things: that the document parses (via the vendored cJSON the
 * firmware itself uses) and that the *field names* are what the app reads. A
 * serializer that emits valid JSON with a renamed key is still a broken API,
 * and nothing else in the build would notice.
 */
#include "th.h"

#include "cJSON.h"
#include "device_api_json.h"

static void fill(device_state_t *st)
{
    memset(st, 0, sizeof(*st));
    snprintf(st->model, sizeof(st->model), "WP News");
    snprintf(st->fw, sizeof(st->fw), "0.1.0");
    snprintf(st->device_id, sizeof(st->device_id), "1A2B");
    snprintf(st->ip, sizeof(st->ip), "192.168.0.42");
    st->page = 1;
    snprintf(st->page_title, sizeof(st->page_title), "MARKETS");

    st->news_valid = true;
    st->demo = false;
    snprintf(st->edition, sizeof(st->edition), "PERSONAL PORTFOLIO");
    snprintf(st->generated_at, sizeof(st->generated_at), "2026-08-14T05:12:00Z");
    st->story_count = 4;
    st->ticker_count = 16;
    snprintf(st->lead_symbol, sizeof(st->lead_symbol), "NVDA");
    snprintf(st->lead_headline, sizeof(st->lead_headline),
             "Nvidia's blowout quarter resets the whole AI trade");

    st->index_count = 2;
    snprintf(st->indices[0].symbol, sizeof(st->indices[0].symbol), "SPX");
    st->indices[0].last_c = 641283;
    st->indices[0].chg_bp = 62;
    snprintf(st->indices[1].symbol, sizeof(st->indices[1].symbol), "VIX");
    st->indices[1].last_c = 1462;
    st->indices[1].chg_bp = -310;

    snprintf(st->news_url, sizeof(st->news_url), "http://mac.local:8123/news.json");
    snprintf(st->last_result, sizeof(st->last_result), "ok");
    st->poll_seconds = 300;
    st->age_seconds = 42;
    st->stale = false;

    st->battery_present = true;
    st->battery_pct = 84;
    st->battery_mv = 4012;

    st->refresh_ms = 24800;
}

static cJSON *obj(cJSON *root, const char *key)
{
    cJSON *o = cJSON_GetObjectItem(root, key);
    if (!cJSON_IsObject(o)) {
        g_total++; g_fail++;
        printf("  FAIL missing object \"%s\"\n", key);
        return NULL;
    }
    g_total++;
    return o;
}

static void check_int(cJSON *o, const char *key, int want)
{
    cJSON *v = o ? cJSON_GetObjectItem(o, key) : NULL;
    g_total++;
    if (!cJSON_IsNumber(v)) {
        g_fail++;
        printf("  FAIL \"%s\" missing or not a number\n", key);
    } else if ((int)cJSON_GetNumberValue(v) != want) {
        g_fail++;
        printf("  FAIL \"%s\" == %d  got %d\n", key, want, (int)cJSON_GetNumberValue(v));
    }
}

static void check_str(cJSON *o, const char *key, const char *want)
{
    cJSON *v = o ? cJSON_GetObjectItem(o, key) : NULL;
    g_total++;
    if (!cJSON_IsString(v)) {
        g_fail++;
        printf("  FAIL \"%s\" missing or not a string\n", key);
    } else if (strcmp(cJSON_GetStringValue(v), want) != 0) {
        g_fail++;
        printf("  FAIL \"%s\" == \"%s\"  got \"%s\"\n", key, want, cJSON_GetStringValue(v));
    }
}

static void check_bool(cJSON *o, const char *key, bool want)
{
    cJSON *v = o ? cJSON_GetObjectItem(o, key) : NULL;
    g_total++;
    if (!cJSON_IsBool(v)) {
        g_fail++;
        printf("  FAIL \"%s\" missing or not a bool\n", key);
    } else if (cJSON_IsTrue(v) != want) {
        g_fail++;
        printf("  FAIL \"%s\" == %s\n", key, want ? "true" : "false");
    }
}

static void test_info(void)
{
    char buf[256];
    int n = device_api_json_info(buf, sizeof(buf), "1A2B", "WP News",
                                 "0.1.0", "192.168.0.42");
    CHECK(n > 0);
    CHECK_INT((int)strlen(buf), n);

    /* The discovery probe reads these four names off every candidate host on
     * the LAN. Renaming one is an app release, not a firmware change. */
    CHECK_STR(buf, "{\"deviceId\":\"1A2B\",\"model\":\"WP News\","
                   "\"fw\":\"0.1.0\",\"ip\":\"192.168.0.42\"}");
}

static void test_state_shape(void)
{
    device_state_t st;
    fill(&st);

    char buf[2048];
    int n = device_api_json_state(&st, buf, sizeof(buf));
    CHECK(n > 0);
    CHECK_INT((int)strlen(buf), n);

    cJSON *r = cJSON_Parse(buf);
    CHECK(r != NULL);
    if (!r) return;

    check_str(r, "deviceId", "1A2B");
    check_str(r, "model", "WP News");
    check_str(r, "fw", "0.1.0");
    check_str(r, "ip", "192.168.0.42");
    check_int(r, "page", 1);
    check_str(r, "pageTitle", "MARKETS");

    cJSON *v = obj(r, "news");
    check_bool(v, "valid", true);
    check_bool(v, "demo", false);
    check_str(v, "edition", "PERSONAL PORTFOLIO");
    check_str(v, "generatedAt", "2026-08-14T05:12:00Z");
    check_int(v, "stories", 4);
    check_int(v, "tickers", 16);

    /* The lead is what the phone shows as "the board is currently reporting".
     * It is the only piece of the page that travels. */
    cJSON *lead = obj(v, "lead");
    check_str(lead, "symbol", "NVDA");
    check_str(lead, "headline", "Nvidia's blowout quarter resets the whole AI trade");

    /* Cents and basis points, not formatted strings: the app owns the decimal
     * separator and the sign colour, and the two would drift if the firmware
     * decided them here as well. */
    cJSON *idx = v ? cJSON_GetObjectItem(v, "indices") : NULL;
    g_total++;
    if (!cJSON_IsArray(idx) || cJSON_GetArraySize(idx) != 2) {
        g_fail++;
        printf("  FAIL \"indices\" is not an array of 2\n");
    } else {
        check_str(cJSON_GetArrayItem(idx, 0), "symbol", "SPX");
        check_int(cJSON_GetArrayItem(idx, 0), "lastCents", 641283);
        check_int(cJSON_GetArrayItem(idx, 0), "changeBp", 62);
        check_str(cJSON_GetArrayItem(idx, 1), "symbol", "VIX");
        check_int(cJSON_GetArrayItem(idx, 1), "changeBp", -310);
    }

    cJSON *s = obj(r, "source");
    check_str(s, "url", "http://mac.local:8123/news.json");
    check_str(s, "lastResult", "ok");
    check_int(s, "pollSeconds", 300);
    check_int(s, "ageSeconds", 42);
    check_bool(s, "stale", false);

    cJSON *b = obj(r, "battery");
    check_bool(b, "present", true);
    check_int(b, "percent", 84);
    check_int(b, "millivolts", 4012);

    /* The refresh timing is the whole reason the polling policy can be decided
     * from measurement rather than guessed, so it is part of the contract. */
    cJSON *p = obj(r, "panel");
    check_int(p, "refreshMs", 24800);

    cJSON_Delete(r);
}

static void test_index_count_is_clamped_to_the_array(void)
{
    /* user_app copies this out of news_t under a lock. A count that outran the
     * array — or a negative one from an uninitialised read — would serialise
     * whatever follows the struct straight onto the network. */
    device_state_t st;
    fill(&st);
    st.index_count = 99;

    char buf[2048];
    CHECK(device_api_json_state(&st, buf, sizeof(buf)) > 0);
    cJSON *r = cJSON_Parse(buf);
    CHECK(r != NULL);
    if (r) {
        cJSON *idx = cJSON_GetObjectItem(obj(r, "news"), "indices");
        CHECK(cJSON_IsArray(idx));
        CHECK_INT(cJSON_GetArraySize(idx), DEV_INDEX_MAX);
        cJSON_Delete(r);
    }

    fill(&st);
    st.index_count = -3;
    CHECK(device_api_json_state(&st, buf, sizeof(buf)) > 0);
    r = cJSON_Parse(buf);
    CHECK(r != NULL);
    if (r) {
        cJSON *idx = cJSON_GetObjectItem(obj(r, "news"), "indices");
        CHECK(cJSON_IsArray(idx));
        CHECK_INT(cJSON_GetArraySize(idx), 0);
        cJSON_Delete(r);
    }
}

static void test_utf8_passes_through(void)
{
    /* Headlines come off a wire copy desk: em dashes, curly quotes and accented
     * names are the normal case, not the exotic one. JSON strings are defined
     * over Unicode, so escaping them to \u would be legal and pointless — but
     * the escaper must not mangle them either. */
    device_state_t st;
    fill(&st);
    snprintf(st.lead_headline, sizeof(st.lead_headline),
             "Société Générale — Zürich desk’s call");
    snprintf(st.edition, sizeof(st.edition), "MIDDAY EDITION №2");

    char buf[2048];
    CHECK(device_api_json_state(&st, buf, sizeof(buf)) > 0);
    CHECK(strstr(buf, "Société Générale") != NULL);

    cJSON *r = cJSON_Parse(buf);
    CHECK(r != NULL);
    if (r) {
        cJSON *v = obj(r, "news");
        check_str(v, "edition", "MIDDAY EDITION №2");
        check_str(obj(v, "lead"), "headline", "Société Générale — Zürich desk’s call");
        cJSON_Delete(r);
    }
}

static void test_control_characters_are_escaped(void)
{
    /* A headline with a newline in it is not exotic — a producer's own JSON
     * will carry one sooner or later, and an unescaped 0x0A is invalid JSON
     * that would break the app's parser rather than just looking odd. */
    device_state_t st;
    fill(&st);
    snprintf(st.edition, sizeof(st.edition), "a\"b\\c\nd\te");

    char buf[2048];
    CHECK(device_api_json_state(&st, buf, sizeof(buf)) > 0);
    cJSON *r = cJSON_Parse(buf);
    CHECK(r != NULL);
    if (r) {
        check_str(obj(r, "news"), "edition", "a\"b\\c\nd\te");
        cJSON_Delete(r);
    }
}

static void test_overflow_yields_an_empty_string_not_half_a_document(void)
{
    /* Half a JSON document is worse than none: the app would try to parse it,
     * fail somewhere in the middle, and report a confusing error. The contract
     * is -1 and out[0] == '\0'. */
    device_state_t st;
    fill(&st);

    char buf[64];
    CHECK_INT(device_api_json_state(&st, buf, sizeof(buf)), -1);
    CHECK_STR(buf, "");

    char tiny[4];
    CHECK_INT(device_api_json_info(tiny, sizeof(tiny), "1A2B", "WP News",
                                   "0.1.0", "1.2.3.4"), -1);
    CHECK_STR(tiny, "");

    /* Zero capacity must not write at all. */
    CHECK_INT(device_api_json_state(&st, buf, 0), -1);
    CHECK_INT(device_api_json_info(buf, 0, "a", "b", "c", "d"), -1);
}

static void test_worst_case_fits_the_servers_buffer(void)
{
    /* device_api.c serialises into a DEVICE_API_STATE_BUF_SZ buffer. If the
     * worst case does not fit, the serializer returns -1 and an EMPTY body —
     * so the symptom is "the app shows nothing", with no error anywhere to
     * suggest a length problem. Every string is therefore filled to its
     * declared maximum here, in the widest bytes it can hold, which is also
     * what fixes the field capacities in device_api_model.h. */
    device_state_t st;
    memset(&st, 0, sizeof(st));

    #define FILL_ASCII(field) do { \
        size_t n = sizeof(st.field) - 1; \
        memset(st.field, 'W', n); \
        st.field[n] = '\0'; \
    } while (0)

    FILL_ASCII(model);
    FILL_ASCII(fw);
    FILL_ASCII(device_id);
    FILL_ASCII(ip);
    FILL_ASCII(news_url);
    FILL_ASCII(last_result);

    /* A multi-byte codepoint passes through the escaper untouched, so a Latin-1
     * field is the same length on the wire as an ASCII one. A field full of
     * quotes is NOT: each becomes two bytes. */
    #define FILL_WIDEST(field, ch) do { \
        for (size_t i = 0; i + 1 < sizeof(st.field); i++) st.field[i] = (ch); \
        st.field[sizeof(st.field) - 1] = '\0'; \
    } while (0)

    FILL_WIDEST(edition, '"');
    FILL_WIDEST(page_title, '\\');
    FILL_WIDEST(generated_at, '\n');
    FILL_WIDEST(lead_symbol, '"');
    FILL_WIDEST(lead_headline, '"');
    st.index_count = DEV_INDEX_MAX;
    for (int i = 0; i < DEV_INDEX_MAX; i++) {
        for (size_t k = 0; k + 1 < sizeof(st.indices[i].symbol); k++) {
            st.indices[i].symbol[k] = '"';
        }
        st.indices[i].last_c = 999999999;
        st.indices[i].chg_bp = -999999999;
    }

    #undef FILL_ASCII
    #undef FILL_WIDEST

    st.page = 3;
    st.news_valid = true;
    st.story_count = st.ticker_count = 999999999;
    st.poll_seconds = st.age_seconds = 999999999;
    st.battery_pct = st.battery_mv = 999999999;
    st.refresh_ms = 999999999;

    char buf[DEVICE_API_STATE_BUF_SZ];
    int n = device_api_json_state(&st, buf, sizeof(buf));
    if (n < 0) {
        g_total++; g_fail++;
        printf("  FAIL worst-case state does not fit DEVICE_API_STATE_BUF_SZ (%d) — "
               "shorten a field in device_api_model.h\n", DEVICE_API_STATE_BUF_SZ);
    } else {
        g_total++;
        printf("  worst-case state document: %d of %d bytes\n", n, DEVICE_API_STATE_BUF_SZ);
        cJSON *r = cJSON_Parse(buf);
        CHECK(r != NULL);
        cJSON_Delete(r);
    }

    char ibuf[DEVICE_API_INFO_BUF_SZ];
    char wide[DEV_MODEL_MAXLEN];
    memset(wide, '"', sizeof(wide) - 1);
    wide[sizeof(wide) - 1] = '\0';
    CHECK(device_api_json_info(ibuf, sizeof(ibuf), wide, wide, wide, wide) > 0);
}

static void test_null_state_is_rejected(void)
{
    char buf[256];
    CHECK_INT(device_api_json_state(NULL, buf, sizeof(buf)), -1);
    CHECK_STR(buf, "");
}

static void test_zeroed_state_still_parses(void)
{
    /* This is what /api/state returns before the first poll — every string
     * empty, every number zero. It must still be a valid document, with an
     * empty indices array rather than a missing key. */
    device_state_t st;
    memset(&st, 0, sizeof(st));

    char buf[2048];
    CHECK(device_api_json_state(&st, buf, sizeof(buf)) > 0);
    cJSON *r = cJSON_Parse(buf);
    CHECK(r != NULL);
    if (r) {
        cJSON *v = obj(r, "news");
        check_bool(v, "valid", false);
        CHECK(cJSON_IsArray(cJSON_GetObjectItem(v, "indices")));
        check_str(r, "deviceId", "");
        cJSON_Delete(r);
    }
}

int main(void)
{
    test_info();
    test_state_shape();
    test_index_count_is_clamped_to_the_array();
    test_utf8_passes_through();
    test_control_characters_are_escaped();
    test_worst_case_fits_the_servers_buffer();
    test_overflow_yields_an_empty_string_not_half_a_document();
    test_null_state_is_rejected();
    test_zeroed_state_still_parses();
    TH_REPORT("api_json");
}
