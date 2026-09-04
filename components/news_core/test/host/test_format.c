/*
 * test_format.c — how a figure is spelled, held to the character.
 *
 * ui_format.c turns the two integer units the wire sends — cents and basis
 * points — into the strings the tape, the dossier rail and the industry table
 * set. Every one of those slots has a pixel budget, so the number of characters
 * a figure comes out as is a layout decision and not a formatting nicety: a
 * price two characters over its column ellipsizes into "96,800.…", which is a
 * quotation the reader cannot use, and the only place that failure is visible
 * is a 1200x1600 screenshot of a page in another language.
 *
 * So the rules are asserted here, in the one test in this tree that can run
 * them without an LVGL display: grouping, the fraction rule, the sign a
 * percentage always carries, and the case transform that must leave Hangul
 * alone.
 */
#include "ui_format.h"

#include <limits.h>
#include <string.h>

#include "th.h"

/* --- grouping -------------------------------------------------------------- */

static void check_group_int(void)
{
    char s[32];

    ui_group_int(s, sizeof s, 0);            CHECK_STR(s, "0");
    ui_group_int(s, sizeof s, 7);            CHECK_STR(s, "7");
    ui_group_int(s, sizeof s, 999);          CHECK_STR(s, "999");
    ui_group_int(s, sizeof s, 1000);         CHECK_STR(s, "1,000");
    ui_group_int(s, sizeof s, 641283);       CHECK_STR(s, "641,283");
    ui_group_int(s, sizeof s, -1234567);     CHECK_STR(s, "-1,234,567");

    /* The figure a broken producer sends. Negating it in signed arithmetic is
     * undefined; this is the check that says the unsigned dance still works. */
    ui_group_int(s, sizeof s, INT_MIN);      CHECK_STR(s, "-2,147,483,648");

    /* A buffer too small truncates and stays a C string. */
    char tiny[4];
    ui_group_int(tiny, sizeof tiny, 641283);
    CHECK(strlen(tiny) < sizeof tiny);
}

/* --- money ---------------------------------------------------------------- */

static void check_money_prints_cents(void)
{
    char s[32];

    ui_money(s, sizeof s, 0);                CHECK_STR(s, "0.00");
    ui_money(s, sizeof s, 5);                CHECK_STR(s, "0.05");
    ui_money(s, sizeof s, 641283);           CHECK_STR(s, "6,412.83");
    ui_money(s, sizeof s, -12345);           CHECK_STR(s, "-123.45");

    /* The last figure that keeps its fraction: four integer digits. */
    ui_money(s, sizeof s, 999999);           CHECK_STR(s, "9,999.99");
}

/* THE RULE THIS TEST EXISTS FOR: at five integer digits the fraction goes.
 *
 * 96,800 is a Seoul close, and the industry table's LAST column is 84 px — room
 * for eight characters at label_14, where "96,800.00" is nine. The cents at
 * that magnitude are a millionth of the number and no quotation table has ever
 * printed them, in any currency, which is why the rule is stated in digits
 * rather than in a currency the payload does not carry. */
static void check_money_drops_cents_above_five_digits(void)
{
    char s[32];

    /* The first figure that loses its fraction, and the four the Korean
     * fixture's industry table actually prints. */
    ui_money(s, sizeof s, 1000000);          CHECK_STR(s, "10,000");
    ui_money(s, sizeof s, 9680000);          CHECK_STR(s, "96,800");
    ui_money(s, sizeof s, 36850000);         CHECK_STR(s, "368,500");
    ui_money(s, sizeof s, 11870000);         CHECK_STR(s, "118,700");
    ui_money(s, sizeof s, 4685000);          CHECK_STR(s, "46,850");

    /* ROUNDED, not truncated. A table that prints 96,799 for 96,799.99 has told
     * the reader something false to save a character. */
    ui_money(s, sizeof s, 9679999);          CHECK_STR(s, "96,800");
    ui_money(s, sizeof s, 1234567);          CHECK_STR(s, "12,346");
    ui_money(s, sizeof s, 1234549);          CHECK_STR(s, "12,345");

    /* The carry crosses a group separator and gains a digit. */
    ui_money(s, sizeof s, 9999999);          CHECK_STR(s, "100,000");

    /* The threshold is read off the figure's own magnitude, before any
     * rounding, so 9,999.50 keeps its fraction rather than becoming 10,000. */
    ui_money(s, sizeof s, 999950);           CHECK_STR(s, "9,999.50");

    /* The sign survives the drop. */
    ui_money(s, sizeof s, -9680000);         CHECK_STR(s, "-96,800");
}

/* --- percentage ------------------------------------------------------------ */

static void check_pct(void)
{
    char s[16];

    /* The plus is carried at zero too: a signed column that drops its sign on
     * the one flat row goes ragged there. */
    ui_pct(s, sizeof s, 0);                  CHECK_STR(s, "+0.00%");
    ui_pct(s, sizeof s, 62);                 CHECK_STR(s, "+0.62%");
    ui_pct(s, sizeof s, 353);                CHECK_STR(s, "+3.53%");
    ui_pct(s, sizeof s, -85);                CHECK_STR(s, "-0.85%");
    ui_pct(s, sizeof s, -1200);              CHECK_STR(s, "-12.00%");
}

/* --- case ------------------------------------------------------------------ */

static void check_upper(void)
{
    char s[64];

    ui_upper(s, sizeof s, "nasdaq");         CHECK_STR(s, "NASDAQ");
    ui_upper(s, sizeof s, "S&P 500");        CHECK_STR(s, "S&P 500");
    ui_upper(s, sizeof s, NULL);             CHECK_STR(s, "");

    /* Latin-1's own lower case, in UTF-8: Bogotá -> BOGOTÁ. */
    ui_upper(s, sizeof s, "Bogot\xC3\xA1");  CHECK_STR(s, "BOGOT\xC3\x81");
    /* U+00F7 DIVISION SIGN sits inside that byte range and is not a letter. */
    ui_upper(s, sizeof s, "\xC3\xB7");       CHECK_STR(s, "\xC3\xB7");

    /* Hangul has no case, so a Korean edition's dateline and exchange pass
     * through byte for byte — three-byte sequences the transform must not
     * touch. 삼성전자 is the Korean fixture's subject. */
    ui_upper(s, sizeof s, "\xEC\x82\xBC\xEC\x84\xB1\xEC\xA0\x84\xEC\x9E\x90");
    CHECK_STR(s, "\xEC\x82\xBC\xEC\x84\xB1\xEC\xA0\x84\xEC\x9E\x90");
}

int main(void)
{
    check_group_int();
    check_money_prints_cents();
    check_money_drops_cents_above_five_digits();
    check_pct();
    check_upper();
    TH_REPORT("format");
}
