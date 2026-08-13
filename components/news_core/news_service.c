/*
 * news_service.c — see news_service.h.
 */
#include "news_service.h"

#include <stdlib.h>
#include <string.h>

#include "http_port.h"
#include "news_parse.h"

news_fetch_result_t news_service_fetch(const char *url, news_t *out)
{
    if (!url || !url[0] || !out) {
        return NEWS_FETCH_NO_URL;
    }

    int status = 0;
    char *body = http_get(url, &status);
    if (!body) {
        return NEWS_FETCH_TRANSPORT;
    }

    /* Status is checked before the body is parsed, not after. A 404 page and a
     * captive-portal redirect are both perfectly good documents that happen not
     * to be a news snapshot, and distinguishing "your URL is wrong" from "your
     * JSON is wrong" is the difference between a fixable and an unfixable
     * message in the log. */
    if (status < 200 || status >= 300) {
        free(body);
        return NEWS_FETCH_HTTP_STATUS;
    }

    bool ok = news_parse(body, strlen(body), out);
    free(body);
    return ok ? NEWS_FETCH_OK : NEWS_FETCH_BAD_PAYLOAD;
}

const char *news_fetch_result_name(news_fetch_result_t r)
{
    switch (r) {
    case NEWS_FETCH_OK:          return "ok";
    case NEWS_FETCH_NO_URL:      return "no_url";
    case NEWS_FETCH_TRANSPORT:   return "transport";
    case NEWS_FETCH_HTTP_STATUS: return "http_status";
    case NEWS_FETCH_BAD_PAYLOAD: return "bad_payload";
    default:                      return "unknown";
    }
}
