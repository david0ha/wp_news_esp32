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
    /* One line, on purpose: an unconditional GET is a conditional one with no
     * tag, and every existing caller keeps working without knowing this
     * happened. */
    return news_service_fetch_cond(url, NULL, out, NULL, 0);
}

news_fetch_result_t news_service_fetch_cond(const char *url,
                                            const char *if_none_match,
                                            news_t *out,
                                            char *out_etag, size_t etag_size)
{
    if (!url || !url[0] || !out) {
        return NEWS_FETCH_NO_URL;
    }

    http_req_t  req = { .if_none_match = if_none_match };
    http_resp_t resp;
    if (!http_get_cond(url, &req, &resp)) {
        return NEWS_FETCH_TRANSPORT;
    }

    /* The order of the next three tests is the whole of this function.
     *
     * 304 first, because it is not in the 2xx range and it is not an error: it
     * is the server confirming the page on the glass is current, and on a board
     * that polls all day it is the most common outcome there is. Answering it
     * after the range test would file it as a status error and drive the
     * failure backoff on every healthy poll. */
    if (resp.status == 304) {
        free(resp.body);   /* a compliant server sends none; be indifferent */
        return NEWS_FETCH_NOT_MODIFIED;
    }

    /* Then the status, before the body is parsed. A 404 page and a
     * captive-portal redirect are both perfectly good documents that happen not
     * to be a news snapshot, and distinguishing "your URL is wrong" from "your
     * JSON is wrong" is the difference between a fixable and an unfixable
     * message in the log. A 302 sits one integer away from 304 and means the
     * opposite, so it must land here and nowhere else. */
    if (resp.status < 200 || resp.status >= 300) {
        free(resp.body);
        return NEWS_FETCH_HTTP_STATUS;
    }

    /* A 2xx that carried nothing at all. The connection answered and then gave
     * us no document, which is exactly what http_get()'s NULL return has always
     * meant here; calling it TRANSPORT keeps that behaviour unchanged. */
    if (!resp.body) {
        return NEWS_FETCH_TRANSPORT;
    }

    bool ok = news_parse(resp.body, resp.len, out);
    free(resp.body);
    if (!ok) {
        return NEWS_FETCH_BAD_PAYLOAD;
    }

    /* The tag is recorded here and only here, beside *out and for the same
     * reason: it names the document that is about to reach the glass. See
     * news_service.h for what recording it any earlier would cost. */
    if (out_etag && etag_size) {
        http_etag_copy(out_etag, etag_size, resp.etag);
    }
    return NEWS_FETCH_OK;
}

const char *news_fetch_result_name(news_fetch_result_t r)
{
    switch (r) {
    case NEWS_FETCH_OK:          return "ok";
    case NEWS_FETCH_NO_URL:      return "no_url";
    case NEWS_FETCH_TRANSPORT:   return "transport";
    case NEWS_FETCH_HTTP_STATUS: return "http_status";
    case NEWS_FETCH_BAD_PAYLOAD: return "bad_payload";
    case NEWS_FETCH_NOT_MODIFIED: return "not_modified";
    default:                      return "unknown";
    }
}
