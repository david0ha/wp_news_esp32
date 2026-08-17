/*
 * news_service.h — one fetch of the news snapshot.
 *
 * Deliberately not a task and not a scheduler: this is http_get() plus
 * news_parse(), and nothing else. The polling loop, the retry policy and the
 * decision to refresh the panel live in user_app, where the rest of the timing
 * lives. That split is what lets the simulator call the identical fetch path
 * against the identical URL and render the identical pixels — which is how a
 * change to the contract gets caught on a laptop instead of on the glass.
 */
#pragma once

#include <stdbool.h>
#include <stddef.h>

#include "news_model.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef enum {
    NEWS_FETCH_OK = 0,
    NEWS_FETCH_NO_URL,      /* nothing configured — the caller shows the demo */
    NEWS_FETCH_TRANSPORT,   /* DNS, connect, TLS or timeout                   */
    NEWS_FETCH_HTTP_STATUS, /* the server answered, but not with a 2xx        */
    NEWS_FETCH_BAD_PAYLOAD, /* 2xx, but not a news snapshot                  */
    /* 304: the server says the document is byte-identical to the one whose tag
     * we sent. A SUCCESS — the poll worked, there is simply nothing to parse.
     * Appended rather than inserted so the values already in logs keep their
     * meaning; a caller that treats this as an outage is the bug this enum
     * value exists to make impossible to write by accident. */
    NEWS_FETCH_NOT_MODIFIED,
} news_fetch_result_t;

/* Fetch and parse `url` into *out.
 *
 * *out is written only on NEWS_FETCH_OK. Every other result leaves it
 * untouched, so the caller can keep displaying the previous snapshot and badge
 * it stale rather than blanking the panel on one dropped packet. */
news_fetch_result_t news_service_fetch(const char *url, news_t *out);

/* The same fetch, conditional on an ETag.
 *
 * `if_none_match` is the tag the last successful fetch reported, or NULL/"" for
 * an unconditional GET. On NEWS_FETCH_NOT_MODIFIED the server has confirmed the
 * previous snapshot is still current: nothing is parsed, nothing is written,
 * and the caller has saved the transfer, the cJSON tree and the 32 KB struct
 * fill. It has NOT saved a panel refresh — news_hash() remains the sole
 * authority on that, and this is an optimisation layered under it.
 *
 * `out_etag` (may be NULL, `etag_size` may be 0) receives the server's tag, and
 * like *out it is written ONLY on NEWS_FETCH_OK. That is not symmetry for its
 * own sake: storing the tag of a payload that failed to parse would make the
 * next poll a 304, and the device would never look at that document again —
 * stuck on yesterday's page with a log full of successful fetches. On a 200
 * from a server that sent no tag it is set to "", because a tag outliving the
 * document it named is a question the device would keep asking wrongly. */
news_fetch_result_t news_service_fetch_cond(const char *url,
                                            const char *if_none_match,
                                            news_t *out,
                                            char *out_etag, size_t etag_size);

/* A short, stable string for logs and the companion-app JSON. Never NULL. */
const char *news_fetch_result_name(news_fetch_result_t r);

#ifdef __cplusplus
}
#endif
