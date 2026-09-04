/*
 * ui_format.c — the pure text formatters: grouping, money, percentage, caps.
 *
 * Split out of ui_common.c, whose every other function builds an LVGL widget.
 * These four touch no widget and no face: they turn the integers the wire sends
 * into the strings the page sets. That makes them decisions a host test can
 * hold, which is the whole reason they are their own translation unit — and the
 * fraction rule in ui_money() is exactly the kind of decision that has to be
 * held somewhere other than in a screenshot.
 */
#include "ui_format.h"

#include <stdbool.h>
#include <stdio.h>

void ui_group_int(char *out, size_t n, int v)
{
    if (!out || n == 0) return;

    char digits[16];
    bool neg = v < 0;
    /* Negate in unsigned, where the wrap is defined: -INT_MIN is not, and
     * widening to long does not rescue it on a device where long is also 32
     * bits. A figure that arrives as INT_MIN is exactly what a broken producer
     * sends, and it must print rather than invoke the optimiser's imagination. */
    unsigned long a = neg ? 0UL - (unsigned long)v : (unsigned long)v;
    int  nd = snprintf(digits, sizeof(digits), "%lu", a);
    if (nd < 0) { out[0] = '\0'; return; }
    if (nd > (int)sizeof(digits) - 1) nd = (int)sizeof(digits) - 1;

    size_t o = 0;
    if (neg && o + 1 < n) out[o++] = '-';
    for (int i = 0; i < nd; i++) {
        if (i > 0 && (nd - i) % 3 == 0) {
            if (o + 1 >= n) break;
            out[o++] = ',';
        }
        if (o + 1 >= n) break;
        out[o++] = digits[i];
    }
    out[o] = '\0';
}

/* The dollars are grouped and the cents are not, which is what a quotation
 * table does: the separator is there to be counted off in threes from the
 * decimal point, and putting one inside the fraction would give the eye a third
 * kind of comma to sort out at a glance.
 *
 * AND ABOVE FIVE INTEGER DIGITS THERE IS NO FRACTION AT ALL. No quotation table
 * has ever printed a hundredth of a unit beside a five-figure price, in any
 * currency: at that magnitude the fraction is a millionth of the number and it
 * is two characters that push the figure out of its column. The Korean sheet is
 * where this stopped being a nicety — a Seoul close is 96,800 won, which
 * ui_money() set as "96,800.00" and the industry table's 84 px LAST column
 * ellipsized to "96,800.…" — but the rule is about magnitude and not about the
 * currency, so a $12,345.67 Berkshire quotation gets the same treatment. The
 * cents are ROUNDED away rather than truncated, because a table that prints
 * 96,799 for 96,799.99 has told the reader something false to save a character.
 *
 * The threshold is read off the integer part before rounding, so it is the
 * figure's own magnitude that decides and not the carry: 9,999.99 keeps its
 * fraction and prints in full. */
void ui_money(char *out, size_t n, int32_t cents)
{
    if (!out || n == 0) return;

    unsigned long a = cents < 0 ? 0UL - (unsigned long)cents : (unsigned long)cents;
    const char *sign = cents < 0 ? "-" : "";
    char whole[24];

    if (a / 100 >= 10000) {
        ui_group_int(whole, sizeof(whole), (int)((a + 50) / 100));
        snprintf(out, n, "%s%s", sign, whole);
        return;
    }

    ui_group_int(whole, sizeof(whole), (int)(a / 100));
    snprintf(out, n, "%s%s.%02lu", sign, whole, a % 100);
}

/* A percentage carries its sign, the plus included, AND IT CARRIES IT AT ZERO:
 * a signed column that drops its sign on the one flat row goes ragged there and
 * the gap reads as a figure that failed to print. What an unchanged session
 * gets instead is the ink — ui_chg_colour() takes the market colour away at
 * zero, and the mark beside it is a bar rather than a triangle — so the row
 * says "flat" twice without the column losing its left edge. */
/* A second comment stood here arguing the opposite — that zero should carry no
 * sign at all — and it is deleted rather than left as an alternative view. The
 * decision above has been made, reverted and made again more than once, and a
 * file that documents both answers is how it gets reverted a third time. */
void ui_pct(char *out, size_t n, int32_t bp)
{
    if (!out || n == 0) return;

    unsigned long a = bp < 0 ? 0UL - (unsigned long)bp : (unsigned long)bp;
    snprintf(out, n, "%s%lu.%02lu%%", bp < 0 ? "-" : "+", a / 100, a % 100);
}

/* Upper case for the two tracked slots that take a string off the wire. ASCII
 * a-z, and Latin-1's own lower case in its UTF-8 spelling (0xC3 0xA0..0xBE, the
 * accented letters a dateline and a byline routinely carry) — everything else,
 * including 0xC3 0xB7 DIVISION SIGN and every three-byte sequence, is copied
 * through untouched. Hangul is in that "everything else": it has no case, so a
 * Korean edition's dateline passes through byte for byte and sets as it was
 * filed. */
void ui_upper(char *out, size_t n, const char *src)
{
    if (!out || n == 0) return;
    out[0] = '\0';
    if (!src) return;

    size_t o = 0;
    for (size_t i = 0; src[i] && o + 1 < n; i++) {
        unsigned char c = (unsigned char)src[i];

        if (c >= 'a' && c <= 'z') {
            out[o++] = (char)(c - 32);
            continue;
        }
        if (c == 0xC3 && o + 2 < n) {
            unsigned char d = (unsigned char)src[i + 1];
            out[o++] = (char)c;
            if (d >= 0xA0 && d <= 0xBE && d != 0xB7) d = (unsigned char)(d - 32);
            out[o++] = (char)d;
            if (src[i + 1]) i++;
            continue;
        }
        out[o++] = (char)c;
    }
    out[o] = '\0';
}
