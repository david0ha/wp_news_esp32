/*
 * news_mock.h — the built-in demo snapshot.
 *
 * Used when no news_url has been provisioned, so the board is complete with no
 * PC involved, and by the simulator as its default content. Sets `demo` so the
 * header can say so.
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
