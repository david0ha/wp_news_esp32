/*
 * ui_format.h — the four pure text formatters the page composes figures with.
 *
 * They were the "--- text ---" tail of ui_common.c, and they are here for the
 * reason ui_fit.h and ui_chart.h are here: they decide what a reader sees and
 * they need no LVGL to do it, so they can be held to a host test rather than
 * to a screenshot. Everything else in ui_common.c builds widgets and cannot.
 *
 * ui_internal.h includes this header, so every existing call site is unchanged;
 * nothing outside the UI files should include it directly.
 */
#pragma once

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* 641283 -> "641,283". Grouping matters here: an index level is read from
 * across a room, and an ungrouped five-digit number is genuinely slower to
 * parse. */
void ui_group_int(char *out, size_t n, int v);

/* The two figures this page prints, from the two integer units the wire sends:
 * 641283 cents -> "6,412.83" and 62 basis points -> "+0.62%". They live here
 * rather than in a snprintf at each call site because the tape, the dossier
 * rail and the peer table print the same two quantities and must not disagree
 * about a decimal or a separator — and because nothing on this board is allowed
 * to reach for a float to do it.
 *
 * A percentage always carries its sign, the plus included: a column where only
 * the losses are signed reads as a column of typos. The sign is the ASCII '-',
 * not U+2212 — see S_COMPOSED_CHARS in ui_strings.h for why no face here has
 * the typographically correct one.
 *
 * ui_money() DROPS THE FRACTION at five integer digits and up; see the comment
 * on the function for the currency that forced it. */
void ui_money(char *out, size_t n, int32_t cents);
void ui_pct(char *out, size_t n, int32_t bp);

/* ui_money() with the fraction kept whatever the magnitude — 9680000 cents ->
 * "96,800.00" where ui_money() gives "96,800". It is the shared body of the
 * two, so there is still exactly one piece of code that groups a figure and
 * prints its cents.
 *
 * ONE CALLER, and it is ui_chart.c's ui_chart_end_labels(): two ends of a chart
 * that round to the same string, on a series whose cents differ, have to be
 * told apart. Every other figure on the sheet sits in a column that the dropped
 * fraction is what keeps it inside, so reach for ui_money() unless the page has
 * already printed the short form twice and been wrong. */
void ui_money_frac(char *out, size_t n, int32_t cents);

/* Upper case for the two tracked slots that take a string off the wire: ASCII
 * a-z and Latin-1's own lower case. Everything else — Hangul included, which
 * has no case at all — is copied through untouched. */
void ui_upper(char *out, size_t n, const char *src);

#ifdef __cplusplus
}
#endif
