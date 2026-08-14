/*
 * news_parse.h — the wire payload -> news_t.
 *
 * The one place that understands the JSON contract in
 * docs/specs/2026-08-14-front-page-design.md §10. Everything downstream sees
 * only the clamped, validated struct.
 */
#pragma once

#include <stdbool.h>
#include <stddef.h>

#include "news_model.h"

#ifdef __cplusplus
extern "C" {
#endif

/* Parse `len` bytes of JSON into *out.
 *
 * Returns true and overwrites *out only on success. On failure *out is left
 * byte-for-byte untouched, so the caller keeps whatever page is already on the
 * glass — a front page badged STALE beats a blank one.
 *
 * Failure means: not JSON, not an object, truncated, out of memory, or an
 * object carrying no stories, tickers or indices whatsoever (which is what an
 * error envelope or a captive-portal login page parses down to). Individual bad
 * fields are NOT failures — they clamp to a default. */
bool news_parse(const char *json, size_t len, news_t *out);

#ifdef __cplusplus
}
#endif
