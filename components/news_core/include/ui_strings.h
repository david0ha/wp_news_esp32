/*
 * ui_strings.h — every fixed string that reaches the glass, in one file.
 *
 * Two reasons this exists rather than string literals scattered through the
 * page files:
 *
 *   1. tools/gen_fonts.py derives each face's glyph list from this file. A
 *      label added here and forgotten in the font is impossible; a label added
 *      straight into a page file would be a tofu box on the glass.
 *   2. It is the whole of the board's copy, so changing the voice of the UI is
 *      one diff.
 *
 * Dynamic strings — headlines, decks, bylines, body text — arrive over the
 * network and cannot be subset. The text faces therefore carry all of Latin-1
 * plus the typography in S_DATA_PUNCT; see ui_fonts.h for what that covers and
 * what it does not.
 *
 * Everything a front page prints in small caps is written in caps here rather
 * than upper-cased at runtime: LVGL has no case transform, an ASCII one would
 * mangle the accented names that arrive in a byline, and a label that reads
 * SYMBOL in the source is a label whose width can be measured by looking at it.
 */
#pragma once

/* --- the masthead ---------------------------------------------------------
 *
 * "The Washington Post" is a registered trademark of WP Company LLC. This is a
 * personal e-Paper front page, not a publication, and nothing here is served to
 * anyone else — but the name is deliberately a single #define so that pointing
 * the board at a different paper, or at your own, is one line.
 *
 * Changing it does NOT require regenerating the fonts: ui_font_masthead_112
 * carries all of A-Z, a-z and the punctuation below, not just the letters this
 * particular string happens to use. That was worth ~50 KB of an 8 MB partition,
 * because the alternative failure is tofu boxes across the largest text on the
 * screen. gen_fonts.py folds in any character this string adds beyond that set,
 * so an accented masthead works too — it just needs the generator re-run.
 */
#define S_MASTHEAD         "The Washington Post"

/* A2 carries a running head instead of the masthead: the same name, no
 * blackletter, set in display_56 caps. It is a second literal rather than an
 * upper-cased S_MASTHEAD because there is no case transform on this board (see
 * the file header) — so the two must be edited together, and that is the whole
 * cost of the second page having a name at the top of it.
 */
#define S_RUNNING_HEAD     "THE WASHINGTON POST"

/* --- chrome ---------------------------------------------------------------
 *
 * The device's own name, for the two states where there is no paper yet to be
 * the brand: provisioning, and the first boot before a snapshot has arrived.
 * On a page that has data, the masthead is the brand.
 */
#define S_BRAND            "WP NEWS"

/* One badge, and only ever one: a board that is offline, showing a snapshot
 * past its poll interval, or running the built-in demo, says so in the kicker
 * strip. Everything else about the board's health is in the folio.            */
#define S_BADGE_DEMO       "DEMO"
#define S_BADGE_STALE      "STALE"
#define S_BADGE_OFFLINE    "OFFLINE"
#define S_NO_DATA          "No data"
#define S_WAITING          "Loading..."

/* Key legend. KEY0 now toggles between two pages rather than cycling four, so
 * it names both — "Page" was accurate about a four-page carousel and would read
 * as a dead end on a board where the other page is one press away. KEY2's long
 * press is the Wi-Fi escape hatch. */
/* The folio's imprint. A framed newspaper carries a publisher and where the
 * sheet came from on this line; it has never carried a hardware key legend,
 * which is the most explicit statement a page can make that it is a screen.
 * The key legend below survives for the setup sheet, which IS about the
 * device and is the one place it belongs. */
#define S_IMPRINT          "WP NEWS · WPNEWS.LOCAL"

#define S_KEY_PAGE         "KEY0 A1/A2"
#define S_KEY_REFRESH      "KEY1 Refresh"
#define S_KEY_WIFI         "KEY2 hold Wi-Fi"

/* --- the two pages --------------------------------------------------------
 *
 * The names the companion app and the key legend use. A newspaper's own name
 * for a page is its folio — A1, A2 — and that is what is printed at the foot of
 * the sheet; these are the words for a list in an app, where "A1" alone means
 * nothing to anyone who is not holding the paper.
 */
#define S_PAGE_FRONT       "FRONT PAGE"
#define S_PAGE_MARKETS     "MARKETS"

/* --- band 3: the dateline row --------------------------------------------- */

#define S_MARKET_WRAP      "MARKET WRAP"

/* --- band 5: the lead's rail ---------------------------------------------- */

#define S_PORTFOLIO        "THE PORTFOLIO"
#define S_DAYS_RANGE       "DAY'S RANGE"

/* --- band 5 with no lead in it: the market summary -------------------------
 *
 * A day that brings figures and no stories is a real day, and the sheet used to
 * print it as five big numbers under a masthead: no kicker, no headline, no
 * deck, no prose anywhere on the page. That is a dashboard wearing a
 * newspaper's hat, and it is the one composition on this board that gives the
 * whole conceit away — a paper with nothing to report still writes a lead about
 * the market, because the market is what happened.
 *
 * So the board writes one. These are the only sentences on the sheet the DEVICE
 * is the author of, which is why they are so tightly constrained: every one of
 * them is a statement about the figures printed directly underneath it, and
 * none of them is an opinion, a forecast or a reason. The %s are index names
 * and formatted percentages, and the arithmetic that chooses between the four
 * headlines is a count of which way the indices went — see set_summary() in
 * ui_page_front.c. There is no byline, because there is no writer.
 *
 * The apostrophe is U+2019 rather than the ASCII one: this is prose set at
 * 56 px, the faces all carry it, and headlines that arrive over the wire are
 * converted to it by news_str_copy_prose() — a fixed headline set with the
 * typewriter apostrophe beside them would be the one that looks wrong. */
#define S_SUMMARY_KICKER   "THE SESSION"
#define S_SUMMARY_UP       "A broad advance, with %s in front"
#define S_SUMMARY_DOWN     "A broad decline, with %s worst hit"
#define S_SUMMARY_MIXED    "A mixed close, with %s the day\xE2\x80\x99s widest move"
#define S_SUMMARY_FLAT     "A session that went nowhere"
#define S_SUMMARY_DECK     "The day ran from %s at %s to %s at %s."
#define S_SUMMARY_DECK_ONE "%s is the only index in this edition, at %s."

/* --- band 7: the ticker table --------------------------------------------
 *
 * Four column heads over a 561 px block, and they are this short on purpose:
 * "CHANGE" and "SYMBOL" set at label_14 are nearly the same width, which makes
 * the two right-hand columns read as one. CHG is the abbreviation every printed
 * quotation table uses, for the same reason.
 */
#define S_COL_SYMBOL       "SYMBOL"
#define S_COL_NAME         "NAME"
#define S_COL_LAST         "LAST"
#define S_COL_CHG          "CHG"

/* --- A2 ------------------------------------------------------------------- */

/* The stories that did not make the front page, one line each. */
#define S_IN_BRIEF         "IN BRIEF"

/* --- band 8: the folio ----------------------------------------------------
 *
 * Source on the left, the page's folio in the centre, and when the page was
 * made against when it will be made again on the right. The last pair is the
 * only place the board admits to being a device: a printed paper does not tell
 * you when the next edition lands, and a dashboard that polls has to, because
 * "this is five minutes old and that is fine" is otherwise indistinguishable
 * from "this is five hours old and nobody noticed".
 */
#define S_FOLIO_A1         "A1"
#define S_FOLIO_A2         "A2"
#define S_UPDATED          "UPDATED"
#define S_NEXT             "NEXT"

/* --- dates ----------------------------------------------------------------
 *
 * The dateline in band 1 normally arrives in the payload, already spelled the
 * way the paper wants it. These are for the board that has no payload yet — a
 * first boot, or a demo snapshot older than the clock — where a dateline still
 * has to be printed and the only source left is the system time.
 *
 * Spelled out here rather than taken from strftime("%a"), which returns
 * whatever the C locale is — "Thu" on the device, something else on a
 * simulator run by a developer with LANG set, and a different string width
 * either way. A layout that depends on the host's locale is a layout that
 * cannot be asserted on. */
#define S_WEEKDAYS_ABBR { "Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat" }

/* The dateline a paper actually prints, for the same board with no payload.
 * The fallback used to be "2026-08-15 (Sat)" — a machine date, in the one slot
 * every other sheet fills with FRIDAY, AUGUST 14, 2026, so the one page a new
 * owner is most likely to be looking at was also the one page that admitted to
 * being a computer. Set in caps here because the slot is tracked caps and
 * nothing on this board transforms case for display. */
#define S_WEEKDAYS_CAPS { "SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", \
                          "THURSDAY", "FRIDAY", "SATURDAY" }
#define S_MONTHS_CAPS   { "JANUARY", "FEBRUARY", "MARCH", "APRIL", "MAY", \
                          "JUNE", "JULY", "AUGUST", "SEPTEMBER", "OCTOBER", \
                          "NOVEMBER", "DECEMBER" }

/* --- provisioning overlay ------------------------------------------------- */

#define S_WIFI_TITLE       "Wi-Fi Setup"
/* The setup sheet's kicker and the heading over its standing box. It is the
 * one page that is about the device, so it is the one page where the board's
 * three buttons belong. */
#define S_SETUP_KICKER     "SETUP"
#define S_SETUP_KEYS       "THE KEYS"
#define S_RESTARTING       "Restarting..."

/* The rest of the setup sheet, which is STANDING TYPE: the copy a paper keeps
 * set for a page it prints often. It is here and not in main.cpp because it is
 * copy, and because the simulator checks every fixed string in this file
 * against the face that will draw it.
 *
 * The sheet was half a page of paper before this: a headline, two instruction
 * lines, and 826 px of nothing under them — and it is the first thing a new
 * owner ever sees. The network's name is now the second-largest type on the
 * sheet rather than a 13 px line buried mid-paragraph, and the paper it is
 * printed on carries a page's worth of type the way every other sheet does. */
#define S_SETUP_DECK       "The board is serving a network of its own. Join it " \
                           "from a phone, and the page it offers will ask for " \
                           "the Wi-Fi you want it to use."
#define S_SETUP_NETWORK    "THE NETWORK"

#define S_SETUP_ABOUT_H    "WHAT THIS SHEET IS"
#define S_SETUP_ABOUT      "A 13.3-inch electronic-paper front page. Once it is " \
                           "on your network it polls one address every few " \
                           "minutes and prints what it finds there: the index " \
                           "levels, the holdings you gave it, and the stories " \
                           "the desk ranked highest that morning. It draws no " \
                           "power holding a page, which is why it can hang in a " \
                           "frame."
#define S_SETUP_AFTER_H    "AFTER IT RESTARTS"
#define S_SETUP_AFTER      "The board joins the network you gave it, sets its " \
                           "clock from the internet, and prints the front page. " \
                           "It answers to wpnews.local on that same network — " \
                           "which is where the companion app finds it, and where " \
                           "the address it polls can be changed. If that address " \
                           "ever stops answering, the board keeps the last sheet " \
                           "it printed and says so in the strip above the " \
                           "masthead rather than blanking the glass."
#define S_SETUP_TROUBLE_H  "IF IT DOES NOT APPEAR"
#define S_SETUP_TROUBLE    "Some phones hide a network that offers no internet " \
                           "of its own. If this one does not show up, wait ten " \
                           "seconds and look again, or open the Wi-Fi list from " \
                           "the phone's own settings rather than from a " \
                           "notification. The board keeps the network up until " \
                           "it has been given something else to join, and " \
                           "holding KEY2 for three seconds brings it back at " \
                           "any time afterwards."
#define S_SETUP_SOURCE_H   "WHERE THE NEWS COMES FROM"
#define S_SETUP_SOURCE     "One address on your own network, asked the same " \
                           "question on a fixed cadence. There is no account to " \
                           "make, no service in the middle and nothing reported " \
                           "back: the only thing the board ever sends is the " \
                           "request for that one page. What it prints is " \
                           "whatever the machine at that address chose to " \
                           "publish, which on most days is a script of your own."

/* Every character that only ever appears in a runtime-composed string —
 * snprintf'd digits, separators, units. gen_fonts.py folds this into every
 * text face verbatim.
 *
 * This constant exists because of a real bug class in the project this board
 * forked from: a label rendered fine but the space in "%s %s" came out as a
 * tofu box, because a space is drawn from the label's own font and no source
 * literal happened to contain one.
 *
 * The sign in front of a change figure is the ASCII '-' below, not U+2212 MINUS
 * SIGN — the typographically correct character, and one no face here has. It is
 * not added because at label_14 on a 1 bpp face the two are a pixel apart, and
 * the cost of the difference is regenerating six fonts.
 */
#define S_COMPOSED_CHARS   "0123456789 .,:;/%()[]-+#$&*'\"!?<>|_@=~^`{}\\"

/* Typography that arrives in DATA rather than in this file — headlines, decks,
 * bylines, body paragraphs.
 *
 * A wire copy desk emits curly quotes and en/em dashes as a matter of course,
 * and an em dash in a headline is not exotic: it is what every CMS inserts.
 * Latin-1 (accented names: Bogota, Zurich, Muller) is added wholesale by the
 * generator; this line is the typography above and beyond it.
 *
 * The list is curated, not derived, because there is nothing to derive it from.
 * It is the accepted limit of the font: a symbol outside ASCII, Latin-1 and
 * this line renders as a tofu box. The simulator checks every string in the
 * snapshot against the face that will draw it, so if that ever happens it fails
 * on a laptop with the offending codepoint printed, not silently on the glass.
 *
 * The up and down marks are NOT here. They are drawn by ui_draw_tri_abs(), not
 * set as text: a triangle is six lines of geometry, whereas U+25B2/U+25BC in
 * every text face means re-running a generator that downloads three variable
 * fonts — and the drawn mark is the one that can be given UI_UP or UI_DOWN,
 * which is the only reason the page wants it at all.
 */
#define S_DATA_PUNCT       "—–‐…“”‘’‚„" \
                           "•·′″‹›«»⁄" \
                           "×÷±≈≠≤≥°‰" \
                           "№€£¥¢§¶©®™†‡"
