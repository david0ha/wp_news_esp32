/*
 * ui_lang.c — the two spellings of the board's own twelve words.
 *
 * The whole of the board's localisation is here, and it is this small on
 * purpose. Everything a reader of a Korean sheet actually reads — the
 * headlines, the decks, the bodies, the dateline, the statement titles, the row
 * labels — arrives in the payload already written in Korean, because the desk
 * told the producing agent which language to file in. What the BOARD supplies
 * is the furniture around that copy: two live badges, three standing heads and
 * six column heads. Eleven words and one abbreviation, in a table.
 *
 * The strings themselves are S_* macros in ui_strings.h and not literals here,
 * so that tools/gen_fonts.py can derive the faces' glyph set from one file and
 * the simulator can check one file's worth of strings against every face. This
 * translation unit is therefore pure: no LVGL, no state, one function.
 */
#include "ui_strings.h"

const ui_lang_t UI_LANG_EN = {
    S_BADGE_DEMO, S_BADGE_STALE, S_BADGE_OFFLINE,
    S_PEERS, S_INSIDE, S_IN_BRIEF,
    S_COL_SYMBOL, S_COL_NAME, S_COL_PE, S_COL_CAP, S_COL_LAST, S_COL_CHG,
};

const ui_lang_t UI_LANG_KO = {
    S_KO_BADGE_DEMO, S_KO_BADGE_STALE, S_KO_BADGE_OFFLINE,
    S_KO_PEERS, S_KO_INSIDE, S_KO_IN_BRIEF,
    S_KO_COL_SYMBOL, S_KO_COL_NAME, S_KO_COL_PE, S_KO_COL_CAP,
    S_KO_COL_LAST, S_KO_COL_CHG,
};

/* An exact match on "ko" and nothing looser.
 *
 * news_parse() has already normalised the tag to ^[a-z]{2,3}$ or to "en", so
 * this is not a validator and must not try to be one: a prefix match would make
 * "kor" Korean, and there is no language whose primary subtag is "kor" — but
 * there are three-letter tags that begin with the two letters of another
 * language's, and a table chosen by prefix is a table that is wrong on one of
 * them one day. Comparing the three bytes by hand rather than calling strcmp()
 * keeps this file free of <string.h> and of everything else except the header
 * holding the words themselves, which is what makes it linkable into a host
 * test that has no LVGL. */
const ui_lang_t *ui_lang(const char *tag)
{
    return (tag && tag[0] == 'k' && tag[1] == 'o' && tag[2] == '\0')
           ? &UI_LANG_KO : &UI_LANG_EN;
}
