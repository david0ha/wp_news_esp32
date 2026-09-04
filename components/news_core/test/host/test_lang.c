/*
 * test_lang.c — which spelling of the board's twelve words an edition gets.
 *
 * The rest of the localisation is a screenshot question and the simulator asks
 * it: whether 동종 업계 fits the head it stands over, whether a Korean badge
 * fits its chip. What can be settled here is the selection itself — that "ko"
 * and only "ko" reaches the Korean table, and that the Korean table is actually
 * Korean in all twelve fields rather than in the four somebody remembered.
 *
 * The second is not a hypothetical: UI_LANG_KO is twelve macros in a row, and a
 * table with S_COL_LAST where S_KO_COL_LAST belongs compiles, links, renders and
 * prints one English word in the middle of a Korean quotation table.
 */
#include "ui_strings.h"

#include <string.h>

#include "th.h"

/* --- selection ------------------------------------------------------------- */

static void check_selection(void)
{
    CHECK(ui_lang("ko") == &UI_LANG_KO);

    /* Everything else is English, and none of it is a failure: the parser has
     * already normalised the tag, so what arrives here is a language this board
     * has no table for and draws with the Latin faces it has. */
    CHECK(ui_lang("en") == &UI_LANG_EN);
    CHECK(ui_lang("fr") == &UI_LANG_EN);
    CHECK(ui_lang("ja") == &UI_LANG_EN);

    /* No prefix match and no case folding. "kor" is not a primary subtag any
     * more than "KO" is a normalised one, and a table chosen by prefix is a
     * table that is wrong the day a three-letter tag starts with two familiar
     * letters. */
    CHECK(ui_lang("kor") == &UI_LANG_EN);
    CHECK(ui_lang("k")   == &UI_LANG_EN);
    CHECK(ui_lang("KO")  == &UI_LANG_EN);
    CHECK(ui_lang("")    == &UI_LANG_EN);

    /* A board with no snapshot at all still has to print. */
    CHECK(ui_lang(NULL) == &UI_LANG_EN);
}

/* --- the tables ------------------------------------------------------------ */

#define LANG_FIELDS(T) { \
    (T).badge_demo, (T).badge_stale, (T).badge_offline, \
    (T).peers, (T).inside, (T).in_brief, \
    (T).col_symbol, (T).col_name, (T).col_pe, (T).col_cap, \
    (T).col_last, (T).col_chg }

static const char *const FIELD_NAME[12] = {
    "badge_demo", "badge_stale", "badge_offline",
    "peers", "inside", "in_brief",
    "col_symbol", "col_name", "col_pe", "col_cap", "col_last", "col_chg",
};

static void check_tables_are_complete(void)
{
    const char *const en[12] = LANG_FIELDS(UI_LANG_EN);
    const char *const ko[12] = LANG_FIELDS(UI_LANG_KO);

    for (int i = 0; i < 12; i++) {
        if (!en[i] || !en[i][0]) {
            g_total++; g_fail++;
            printf("  FAIL UI_LANG_EN.%s is empty\n", FIELD_NAME[i]);
            continue;
        }
        if (!ko[i] || !ko[i][0]) {
            g_total++; g_fail++;
            printf("  FAIL UI_LANG_KO.%s is empty\n", FIELD_NAME[i]);
            continue;
        }

        /* EVERY field differs, including col_pe: the Korean market's own name
         * for the ratio is PER and the English column head is P/E, so there is
         * no field where the two tables legitimately agree. A field that does
         * is a macro copied from the wrong block. */
        g_total++;
        if (strcmp(en[i], ko[i]) == 0) {
            g_fail++;
            printf("  FAIL UI_LANG_KO.%s is still the English \"%s\"\n",
                   FIELD_NAME[i], en[i]);
        }
    }
}

/* The English table is the macros the pages used before there was a table at
 * all, so a board that never sees a `lang` prints exactly what it printed
 * before. Spot-checked at both ends of the struct. */
static void check_english_is_unchanged(void)
{
    CHECK_STR(UI_LANG_EN.badge_offline, "OFFLINE");
    CHECK_STR(UI_LANG_EN.peers,         "THE INDUSTRY");
    CHECK_STR(UI_LANG_EN.in_brief,      "IN BRIEF");
    CHECK_STR(UI_LANG_EN.col_symbol,    "SYMBOL");
    CHECK_STR(UI_LANG_EN.col_chg,       "CHG");
}

/* Every Korean field is Hangul or Latin capitals and nothing else — no stray
 * byte, no half-decoded sequence. PER is the one Latin entry and it is
 * deliberate; everything else must be three-byte UTF-8 above U+3000. */
static void check_korean_is_korean(void)
{
    const char *const ko[12] = LANG_FIELDS(UI_LANG_KO);

    for (int i = 0; i < 12; i++) {
        if (strcmp(ko[i], "PER") == 0) continue;

        int hangul = 0;
        for (const unsigned char *p = (const unsigned char *)ko[i]; *p; ) {
            if (*p == ' ') { p++; continue; }
            g_total++;
            if (*p < 0xE0 || *p > 0xEF || (p[1] & 0xC0) != 0x80
                          || (p[2] & 0xC0) != 0x80) {
                g_fail++;
                printf("  FAIL UI_LANG_KO.%s: \"%s\" is not Hangul at byte %d\n",
                       FIELD_NAME[i], ko[i],
                       (int)(p - (const unsigned char *)ko[i]));
                break;
            }
            hangul++;
            p += 3;
        }
        CHECK(hangul > 0);
    }
}

int main(void)
{
    check_selection();
    check_tables_are_complete();
    check_english_is_unchanged();
    check_korean_is_korean();
    TH_REPORT("lang");
}
