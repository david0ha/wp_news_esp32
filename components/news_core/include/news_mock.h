/*
 * news_mock.h — the built-in demo front page.
 *
 * Used when no news_url has been provisioned, so the board is a complete object
 * with no agent running, and by the simulator as its default content. Sets
 * `demo` so the folio can say so.
 */
#pragma once

#include "news_model.h"

#ifdef __cplusplus
extern "C" {
#endif

/* Overwrite *v with the demo snapshot. Never fails. */
void news_mock(news_t *v);

#ifdef __cplusplus
}
#endif
