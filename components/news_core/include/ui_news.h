/*
 * ui_news.h — the whole on-glass UI, for the 1200x1600 portrait Spectra 6 panel.
 *
 * Two pages, and KEY0 toggles them:
 *
 *   A1  the front page   masthead, index ribbon, the lead package and its
 *                        portfolio rail, three secondary stories, the watchlist
 *   A2  the markets page  the full watchlist with sparklines, the indices at
 *                        full width, and the stories A1 had no room for
 *
 * There is no shared header and footer any more. A newspaper's chrome is its
 * own furniture — the kicker strip, the folio — and it is part of the page it
 * is printed on, so each page draws the whole sheet from the margin in. See
 * docs/specs/2026-08-14-front-page-design.md §3 for the bands.
 *
 * Every setter only mutates widgets. Nothing here talks to the panel: on
 * e-Paper the caller decides when a refresh is worth several seconds of
 * flashing, so the sequence is always
 *
 *     ui_news_set_*(...);  Lvgl_RenderNow();  epd_refresh_*();
 *
 * Portable: LVGL only, no ESP-IDF. The desktop simulator builds these files
 * verbatim, which is how the layout gets checked against a real 1200x1600
 * six-colour bitmap before it ever reaches hardware.
 */
#pragma once

#include <stdbool.h>

#include "lvgl.h"
#include "news_model.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef enum {
    UI_PAGE_FRONT = 0,
    UI_PAGE_MARKETS,
    UI_PAGE_COUNT,
} ui_page_t;

/* Everything the page reports that is about the board rather than the news.
 * Passed as a struct so adding an indicator does not change three signatures. */
typedef struct {
    bool online;          /* Wi-Fi associated and the last poll succeeded */
    bool stale;           /* showing a snapshot older than one poll interval */
    bool battery_present; /* a cell is fitted (false = USB power)          */
    int  battery_pct;     /* 0..100, meaningless unless battery_present    */
} ui_status_t;

/* Build the UI under `parent` (a full-screen 1200x1600 container). */
void ui_news_create(lv_obj_t *parent);

void      ui_news_show_page(ui_page_t page);
ui_page_t ui_news_page(void);

/* The page's own name, for the companion-app JSON and the key legend. */
const char *ui_news_page_title(ui_page_t page);

/* Push a snapshot into both pages. Everything the sheet prints is copied into
 * the labels that print it. Pass NULL to blank the content and show the "no
 * data" state.
 *
 * ONE lifetime rule: `v` must stay valid until the next call to this function.
 * ui_news_set_status() rebuilds both pages when the link state crosses the
 * live/stale line, because that state reaches the COLOUR of every figure on the
 * sheet, and it rebuilds them from this pointer. A stack-local that has gone
 * out of scope by then is the one way to misuse this call. */
void ui_news_set_data(const news_t *v);

/* The board's own indicators — the badge in the kicker strip, the battery and
 * link state in the folio. */
void ui_news_set_status(const ui_status_t *st);

/* Recompose everything derived from the clock rather than from the payload:
 * the folio's updated/next pair, and the dateline on a board whose snapshot
 * carried none.
 *
 * On the 5.83" this was the cheap call — the clock was the one rectangle worth
 * a windowed partial refresh, throttled to one every five minutes. Spectra 6
 * has no partial waveform at all, so a tick that changes a pixel costs the same
 * twenty-five seconds of flashing as new data does, and UiTask must treat it as
 * such: tick when something else has already earned the refresh.
 *
 * (This is also why ui_news_header_area() is gone. It existed to hand the
 * driver the one rectangle allowed to refresh on its own, and on this panel
 * there is no such rectangle for it to describe.) */
void ui_news_tick(void);

/* The setup sheet: a full page of this paper with the provisioning story where
 * the lead goes. Pass NULL for all three to dismiss it and return to the pages.
 *
 * `ssid` is its own argument rather than a line inside `body` because it is the
 * one string on the sheet the owner has to carry to another device, and it is
 * therefore the one string set at the size of a lead headline. A state that has
 * no network to name — connecting, saved, restarting — passes NULL and the slot
 * and its caps label are taken away together. */
void ui_news_set_overlay(const char *title, const char *ssid, const char *body);

#ifdef __cplusplus
}
#endif
