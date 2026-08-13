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

/* --- chrome --------------------------------------------------------------- */

#define S_BRAND            "WP NEWS"
#define S_BADGE_DEMO       "DEMO"
#define S_BADGE_STALE      "STALE"
#define S_BADGE_OFFLINE    "OFFLINE"
#define S_NO_DATA          "No data"
#define S_WAITING          "Loading..."

/* Footer key legend. KEY2's long press is the Wi-Fi escape hatch. */
#define S_KEY_PAGE         "KEY0 Page"
#define S_KEY_REFRESH      "KEY1 Refresh"
#define S_KEY_WIFI         "KEY2 hold Wi-Fi"

/* --- page 0: statistics ---------------------------------------------------
 *
 * The four pages below are inherited from the dashboard this board forked from
 * and are replaced by the single front page in a later step. They are kept
 * compiling, and translated, so that the font work can be verified on its own.
 */

#define S_PAGE_STATS       "Vault Stats"
#define S_STAT_NOTES       "Notes"
#define S_STAT_LINKS       "Links"
#define S_STAT_ORPHANS     "Orphans"
#define S_STAT_TAGS        "Tags"
#define S_ACTIVITY         "Last 7 days"
#define S_ADDED_TODAY      "Today"
#define S_ADDED_WEEK       "This week"
#define S_TOP_TAGS         "Top tags"
#define S_HEALTH           "Vault health"
#define S_LINK_DENSITY     "Link density"
#define S_ORPHAN_RATE      "Orphan rate"
#define S_LAST_SYNC        "Last sync"
#define S_PER_NOTE         "per note"

/* --- page 1: graph -------------------------------------------------------- */

#define S_PAGE_GRAPH       "Link Graph"
#define S_GRAPH_HUBS       "Hubs"
#define S_GRAPH_LINKS      "Links"
#define S_GRAPH_LEGEND     "Circle size = connections"

/* --- page 2: agents ------------------------------------------------------- */

#define S_PAGE_AGENTS      "Agents"
#define S_AGENTS_RUNNING   "Running"
#define S_AGENT_QUEUED     "Queued"
#define S_AGENT_DONE_N     "Done"
#define S_STATE_RUNNING    "Running"
#define S_STATE_IDLE       "Idle"
#define S_STATE_ERROR      "Error"
#define S_STATE_DONE       "Done"

/* --- page 3: notes -------------------------------------------------------- */

#define S_PAGE_NOTES       "Recent Notes"
#define S_RECENT           "Recently edited"
#define S_INBOX            "Inbox"
#define S_DAYS_SUFFIX      "d"
#define S_EMPTY_RECENT     "Nothing edited"
#define S_EMPTY_INBOX      "Empty"

/* --- dates ----------------------------------------------------------------
 *
 * Spelled out here rather than taken from strftime("%a"), which returns
 * whatever the C locale is — "Thu" on the device, something else on a
 * simulator run by a developer with LANG set, and a different string width
 * either way. A layout that depends on the host's locale is a layout that
 * cannot be asserted on. */
#define S_WEEKDAYS_ABBR { "Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat" }

/* --- provisioning overlay ------------------------------------------------- */

#define S_WIFI_TITLE       "Wi-Fi Setup"
#define S_RESTARTING       "Restarting..."

/* Every character that only ever appears in a runtime-composed string —
 * snprintf'd digits, separators, units. gen_fonts.py folds this into every
 * text face verbatim.
 *
 * This constant exists because of a real bug class in the project this board
 * forked from: a label rendered fine but the space in "%s %s" came out as a
 * tofu box, because a space is drawn from the label's own font and no source
 * literal happened to contain one. */
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
 */
#define S_DATA_PUNCT       "—–‐…“”‘’‚„" \
                           "•·′″‹›«»⁄" \
                           "×÷±≈≠≤≥°‰" \
                           "№€£¥¢§¶©®™†‡"
