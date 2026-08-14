/*
 * ui_internal.h — the newspaper grid and the drawing shorthand every page shares.
 *
 * Private to news_core: it is not in include/, and nothing outside the UI
 * files may include it. The public surface is ui_news.h. The desktop simulator
 * is the one exception, and it is deliberate: the simulator asserts on this
 * grid, and a second copy of the grid is exactly how such an assertion starts
 * agreeing with itself instead of with the panel.
 *
 * Why a shorthand at all: on a six-ink panel with no greys every widget wants
 * the same six style calls (no theme, no radius, black on white, no padding, no
 * scrolling), and repeating them four hundred times is how a page ends up with a
 * rounded corner or a grey border that dithers into a dashed line. One helper
 * per shape, used everywhere, means the panel's constraints are enforced once.
 */
#pragma once

#include <stdarg.h>
#include <stddef.h>

#include "lvgl.h"
#include "ui_fonts.h"
#include "ui_strings.h"
#include "news_model.h"
#include "wp_palette.h"

#ifdef __cplusplus
extern "C" {
#endif

/* --- the sheet ------------------------------------------------------------
 * Portrait, at the panel's native resolution. Everything below is in panel
 * coordinates, not in some content-area coordinate space: a band's y is the y
 * you pass to LVGL, so the number in the table is the number on the glass and
 * the simulator can assert on it without a translation step. */
#define UI_W            1200
#define UI_H            1600

#define UI_MARGIN         30    /* all four sides, and nothing crosses it */

#define UI_CONTENT_X    UI_MARGIN                       /*   30 */
#define UI_CONTENT_Y    UI_MARGIN                       /*   30 */
#define UI_CONTENT_W    (UI_W - 2 * UI_MARGIN)          /* 1140 */
#define UI_CONTENT_H    (UI_H - 2 * UI_MARGIN)          /* 1540 */
#define UI_CONTENT_R    (UI_CONTENT_X + UI_CONTENT_W)   /* 1170, exclusive */
#define UI_CONTENT_B    (UI_CONTENT_Y + UI_CONTENT_H)   /* 1570, exclusive */

/* --- the columns ----------------------------------------------------------
 * Six columns of 170 with a 24 px gutter: 6*170 + 5*24 = 1140. Every span below
 * is a sum of those two integers — never a fraction of the width — so there is
 * no rounding for the grid to accumulate: a column measured from the left edge
 * and the same column measured from the right land on one pixel.
 *
 * BOTH NUMBERS ARE EVEN, AND THAT IS A REQUIREMENT RATHER THAN A PREFERENCE. A
 * photo tile packs two pixels per byte, so a slot of odd width — or one starting
 * at an odd x — cannot be blitted as a per-row memcpy and needs a nibble-
 * shifting slow path on the device for no reason at all. An even column and an
 * even gutter make every span and every origin even, and the blit stays a copy.
 *
 * 24 px is 0.16" at this panel's 150.4 dpi: a normal newspaper gutter, and wide
 * enough to carry a hairline down its centre without crowding either column.
 *
 * UI_COL(n)  the width of an n-column span   (1..6)
 * UI_COLX(i) the x of column i               (0..5), absolute
 *
 *   n     1     2     3     4     5     6          i     0    1    2    3    4    5
 *   w   170   364   558   752   946  1140          x    30  224  418  612  806 1000
 */
#define UI_COLS            6
#define UI_COL_W         170
#define UI_GUTTER         24

#define UI_COL(n)       ((n) * (UI_COL_W + UI_GUTTER) - UI_GUTTER)
#define UI_COLX(i)      (UI_CONTENT_X + (i) * (UI_COL_W + UI_GUTTER))

/* The measure. A text column is TWO grid columns: 364 px, which at
 * ui_font_body_16's measured 8.51 px average advance is 42 characters. The lead
 * sets in body_20, whose 10.44 px wants THREE columns — 558 px, 53 characters —
 * because the same width for both faces is the wrong answer: body_20 at 364 sets
 * 34 characters, which is a caption measure, not a reading measure.
 *
 * One grid column, 170 px, is never body text; it is the folio and table cells. */
#define UI_MEASURE_W    UI_COL(2)                       /* 364, body_16 */
#define UI_MEASURE_LG_W UI_COL(3)                       /* 558, body_20 */

/* --- rules ----------------------------------------------------------------
 * Three weights, black, square, no radius anywhere. A fourth weight is how a
 * page starts having a visual hierarchy that the eye reads as a mistake. */
#define UI_RULE_HAIR       1
#define UI_RULE_MID        2
#define UI_RULE_HEAVY      3

/* A vrule sits in the middle of a gutter, biased left by the truncation: 11 px
 * of paper, the rule, then 12. The offset is a #define because two bands draw
 * one and each would otherwise open-code the same halving. */
#define UI_GUTTER_RULE_DX ((UI_GUTTER - UI_RULE_HAIR) / 2)      /* 11 */

/* --- the vertical bands ---------------------------------------------------
 * Fixed y-bands, transcribed from the table in
 * docs/specs/2026-08-14-front-page-design.md §3. The tier engine chooses WHAT
 * fills a band; the band never moves. A band that would overflow is copyfitted;
 * a page with too little content promotes stories up a tier so the band still
 * fills.
 *
 *   band / rule            y      h    ends   gap to next
 *   1 kicker strip        30     18      48     8
 *     hairline            56      1      57     7
 *   2 masthead            64    112     176    10
 *     heavy rule         186      3     189     4
 *   3 dateline row       193     20     213     6
 *     hairline           219      1     220     6
 *   4 index ribbon       226     82     308     2
 *     heavy rule         310      3     313     5
 *   5 lead package       318    782    1100     8
 *     rule              1108      2    1110     6
 *   6 secondary row     1116    176    1292     6
 *     rule              1298      2    1300     6
 *   7 ticker table      1306    232    1538     6
 *     hairline          1544      1    1545     6
 *   8 folio             1551     18    1569     -
 *
 * Running total: 1438 px of band + 13 px of rule = 1451 px of ink, plus 88 px
 * of gaps = 1539, laid from y=30 to y=1569. One pixel of slack against the
 * 1570 bottom margin, and 1451 against the 1540 of content height.
 *
 * Bands 5 and 6 last moved when the lead photograph went to the full measure:
 * a picture 1140 wide can only sit ABOVE its story, not beside it, so the well
 * took 194 px off the secondary row to pay for it. What band 6 lost is a whole
 * story — it holds one now, and no body under it — which is the trade the owner
 * made knowingly and is why the numbers here are not the ones in the spec's
 * §3 table. */
#define UI_KICKER_Y            30
#define UI_KICKER_H            18
#define UI_KICKER_RULE_Y       56
#define UI_KICKER_RULE_W       UI_RULE_HAIR

#define UI_MAST_Y              64
#define UI_MAST_H             112
#define UI_MAST_RULE_Y        186
#define UI_MAST_RULE_W         UI_RULE_HEAVY

#define UI_DATELINE_Y         193
#define UI_DATELINE_H          20
#define UI_DATELINE_RULE_Y    219
#define UI_DATELINE_RULE_W     UI_RULE_HAIR

#define UI_RIBBON_Y           226
/* 82, not 78. The band's three rows are the faces' measured line heights laid
 * end to end, and the change row grew from label_14's 18 to body_16's 22 — the
 * one figure the ribbon exists to print was set two sizes below the level it
 * modifies, so from across the room the band read as five big numbers and five
 * specks. The band is what has to grow with it: the rows now end at 308 and the
 * heavy rule is still at 310. Two pixels of clearance rather than six, which is
 * the whole of what this costs. */
#define UI_RIBBON_H            82
#define UI_RIBBON_RULE_Y      310
#define UI_RIBBON_RULE_W       UI_RULE_HEAVY

#define UI_LEAD_Y             318
#define UI_LEAD_H             782
#define UI_LEAD_RULE_Y       1108
#define UI_LEAD_RULE_W         UI_RULE_MID

#define UI_SECOND_Y          1116
#define UI_SECOND_H           176
#define UI_SECOND_RULE_Y     1298
#define UI_SECOND_RULE_W       UI_RULE_MID

#define UI_TICKER_Y          1306
#define UI_TICKER_H           232
#define UI_TICKER_RULE_Y     1544
#define UI_TICKER_RULE_W       UI_RULE_HAIR

#define UI_FOLIO_Y           1551
#define UI_FOLIO_H             18

/* One story is not a thin front page, it is a broken one, so the lead swallows
 * the secondary row rather than leaving 176 px of paper blank: 782 + 8 gap + 2
 * rule + 6 gap + 176 = 974, ending where band 6 ended. The rule at
 * UI_LEAD_RULE_Y is inside that span and is not drawn in this case. */
#define UI_LEAD_H_SOLO        974

/* Every rule on the page, in one list, so the simulator's "the rules land on
 * exactly these rows, full width, unbroken" check iterates the same constants
 * the page draws from instead of a transcription of them. X(name, y, weight). */
#define UI_RULE_TABLE(X)                                        \
    X("kicker",   UI_KICKER_RULE_Y,   UI_KICKER_RULE_W)         \
    X("masthead", UI_MAST_RULE_Y,     UI_MAST_RULE_W)           \
    X("dateline", UI_DATELINE_RULE_Y, UI_DATELINE_RULE_W)       \
    X("ribbon",   UI_RIBBON_RULE_Y,   UI_RIBBON_RULE_W)         \
    X("lead",     UI_LEAD_RULE_Y,     UI_LEAD_RULE_W)           \
    X("secondary", UI_SECOND_RULE_Y,  UI_SECOND_RULE_W)         \
    X("ticker",   UI_TICKER_RULE_Y,   UI_TICKER_RULE_W)

/* The same for the bands, for the "every band contains ink" check — a band that
 * rendered nothing is a failure, not an empty state. X(name, y, h), with band 5
 * at its normal height; the solo promotion is a separate case the test states
 * for itself. */
#define UI_BAND_TABLE(X)                            \
    X("kicker",    UI_KICKER_Y,   UI_KICKER_H)      \
    X("masthead",  UI_MAST_Y,     UI_MAST_H)        \
    X("dateline",  UI_DATELINE_Y, UI_DATELINE_H)    \
    X("ribbon",    UI_RIBBON_Y,   UI_RIBBON_H)      \
    X("lead",      UI_LEAD_Y,     UI_LEAD_H)        \
    X("secondary", UI_SECOND_Y,   UI_SECOND_H)      \
    X("ticker",    UI_TICKER_Y,   UI_TICKER_H)      \
    X("folio",     UI_FOLIO_Y,    UI_FOLIO_H)

/* --- band 4: the index ribbon --------------------------------------------
 * Equal cells that abut exactly across the measure, with the 1 px vrule drawn ON
 * each internal boundary rather than in a gap of its own. Content is inset by
 * UI_RIBBON_PAD, so the rule never touches a figure.
 *
 * The divisor is the number of indices that ARRIVED, not the five the band can
 * hold. A ribbon of five fixed cells fills only as many as the payload sent, and
 * two indices then sit in two cells of 228 with 684 px of paper around them —
 * under a masthead centred on the sheet, which is what makes it read as a ribbon
 * that lost three quotations rather than as a morning with two. Dividing instead
 * means the band fills at every count, and 1140 is the width that lets it:
 * 1140, 570, 380, 285 and 228 are all exact, so the cells always abut and the
 * last one always ends on the right margin with no remainder to place.
 *
 * Cell origins are not required to be even here, and at four cells three of them
 * are not. The evenness rule below is about photo tiles, which are blitted two
 * pixels to a byte; the ribbon sets type and rules, and neither cares.
 *
 * The three rows stack on the faces' MEASURED line heights with no padding
 * between them — 18 for the name, 41 for the value, 18 for the change, ending at
 * 304 against the heavy rule at 310. Six pixels of clearance is deliberate and
 * is all there is: adding air here pushes the change figure into the rule. */
#define UI_RIBBON_CELLS          5
#define UI_RIBBON_PAD           12
#define UI_RIBBON_CELL_W(n)     (UI_CONTENT_W / (n))
#define UI_RIBBON_CELL_X(n, i)  (UI_CONTENT_X + (i) * UI_RIBBON_CELL_W(n))
#define UI_RIBBON_VRULE_X(n, i) (UI_RIBBON_CELL_X((n), (i) + 1) - UI_RULE_HAIR)

#define UI_RIBBON_NAME_Y      (UI_RIBBON_Y)             /*  226, label_14   */
#define UI_RIBBON_VALUE_Y     (UI_RIBBON_Y + 19)        /*  245, display_36 */
#define UI_RIBBON_CHG_Y       (UI_RIBBON_Y + 60)        /*  286, body_16    */

/* The change row's line height, and it is here rather than in ui_news.c because
 * the assertion below is the thing that stops it being raised into the heavy
 * rule. It was label_14's 18 and is body_20's 22: the one figure a market
 * ribbon exists to print — which way, and how far — was set two sizes below the
 * level it modifies, at 11 px of digit under a 36 px figure, so from the
 * distance this panel is read the band said five big numbers and five specks.
 * 286 + 22 = 308, six short of the rule, which is what the assertion holds. */
#define UI_RIBBON_CHG_LH        22

/* --- band 5: the lead well -------------------------------------------------
 * The headline runs the full measure and so does the photograph: 1140 x 360
 * across the top of the well, with the story set in two columns of 558
 * underneath it. A picture in three columns with its story beside it is a
 * feature well; a picture across the whole measure with the type under it is
 * a front page, and it is the treatment the owner chose knowing the price —
 * six lines to a leg instead of fourteen, and one secondary story off the
 * sheet. Setting the headline across all six and then breaking the body into a
 * narrower measure is what a broadsheet does, and it is why the page reads as a
 * front page rather than as a column of boxes.
 *
 * The deck is held to four columns rather than six deliberately: a deck at 100
 * characters a line is not a deck, it is a paragraph pretending to be one.
 *
 * The photo tile is a fixed 1140 x 360 because that is the size the server
 * dithered it to. The device never resizes, tone-maps or dithers a photo, and a
 * tile whose byte count disagrees with this slot is not fetched at all — which
 * is the case the second shape below exists for. */
#define UI_LEAD_X             UI_CONTENT_X              /*   30 */
#define UI_LEAD_W             UI_CONTENT_W              /* 1140 */

#define UI_LEAD_KICKER_Y      (UI_LEAD_Y)               /*  318, h  18 */
#define UI_LEAD_HEAD_Y        (UI_LEAD_Y + 22)          /*  340, h 130 = 2 x 65 */
#define UI_LEAD_HEAD_H        130
#define UI_LEAD_DECK_Y        (UI_LEAD_Y + 160)         /*  478, h  54 = 2 x 27 */
#define UI_LEAD_DECK_H        54
#define UI_LEAD_DECK_W        UI_COL(4)                 /*  752 */
#define UI_LEAD_BYLINE_Y      (UI_LEAD_Y + 222)         /*  540, h  18 */
#define UI_LEAD_HAIR_Y        (UI_LEAD_Y + 248)         /*  566 */
#define UI_LEAD_SPLIT_Y       (UI_LEAD_Y + 258)         /*  576 */

#define UI_LEAD_VIS_X         UI_CONTENT_X              /*   30 */
#define UI_LEAD_VIS_W         UI_CONTENT_W              /* 1140 */
#define UI_LEAD_VIS_H         360                       /*  576..936 */
#define UI_LEAD_CAP_Y         (UI_LEAD_Y + 624)         /*  942, h 18 */

/* The caption line carries two things and they are not the same thing. A photo
 * credit is not decoration — a broadsheet always prints one — and the version
 * this replaces concatenated caption and credit into ONE 558 px label and
 * ellipsized the pair, so the credit was the first thing destroyed and the
 * caption broke mid-word to destroy it. Two slots: the credit right-aligned at
 * the measure's right edge, the caption in what is left, and neither spends the
 * other's budget.
 *
 * NEITHER WIDTH IS A NUMBER HERE ANY MORE, and that is the point. The credit
 * had a reserved 130 — a figure inherited from the days when this line ran
 * under a 558 px photograph — and "DEMO IMAGE" sets 110 in tracked label_14,
 * so the caption was paying twenty pixels a sheet for paper nobody would ever
 * print on. The photo is the full 1140 now, so the split is re-derived against
 * THAT measure at the one moment both strings are known: set_lead() measures
 * the credit with lv_text_get_size and hands the caption every pixel the credit
 * did not ask for. The two constants below are the ceiling that keeps a
 * pathological credit from eating the sentence, and the paper between them. */
#define UI_LEAD_CRED_MAX_W    UI_COL(2)                 /*  364 */
#define UI_LEAD_CAP_GAP       UI_TICKER_FIELD_GAP       /*    8 */

/* --- the end-of-story mark -------------------------------------------------
 * A small filled square on the last line of a story, flush right of its
 * measure. Every broadsheet closes a story with one, and this sheet needs it
 * more than most: a leg copyfitted to its box stops on whatever word the pixel
 * ran out on, so without a mark the reader cannot tell a story that ended from
 * one that was cut — and on a two-page paper whose second page is a quotation
 * table there is nowhere for a cut story to be continued TO. The bytes past the
 * cut are dropped, and the square is the page saying so.
 *
 * Nine pixels: about half the line it sits on, which is the proportion a
 * printed end mark has against the type it closes.
 *
 * THE ROOM IS TAKEN OFF THE MEASURE AND NOT OFF THE DEPTH, and the difference
 * is a line of copy per story. Reserving a LINE at the foot of the box — set
 * the text into a box one line shorter, put the square in the line kept back —
 * is the obvious shape and it was rendered before this was written: on the demo
 * front page it cost the lead exactly the line that ended "...started calling a
 * schedule.", so the paragraph then stopped on an indefinite article with a
 * square after it announcing that it had finished. A mark that says "this story
 * ended" bought by deleting the sentence that ended it is the wrong trade at
 * any price.
 *
 * Off the MEASURE it costs about a character and a half a line, and it buys the
 * one property that makes the placement safe: no line of the box can ever enter
 * the column the square stands in, so the square goes on the LAST line — where
 * a printed end mark goes — with no possibility of it landing on type, and
 * without anything having to measure where that line's words actually stopped.
 * The copy is still copyfitted by ui_fit_text against the narrower measure, so
 * that function's contract is untouched: it is still being asked to fit this
 * text in this box, and the box is simply the one the mark is not in. */
#define UI_END_SIDE            9
#define UI_END_MEASURE(w)     ((w) - UI_END_SIDE - UI_TICKER_FIELD_GAP)

/* The story's own legs, and they are the same two columns in both of the well's
 * shapes — only their depth changes, because only the top of the well does.
 *
 * UNDER a photograph: 132 px of them, y 968, six lines each. Two legs of 53
 * characters at six lines is about 636 characters of lead, which is what a
 * picture across the whole measure costs and what was bought with it.
 *
 * With no tile: the same two columns run the full 524 from the split down, and
 * the left one holds the story's chart instead of type. That is the shape this
 * band had before the photograph was widened, and it is still the right one
 * when there is nothing to put across the top — a well with a 360 px hole in it
 * is worse than a well laid out as if it never expected a picture.
 *
 * UI_LEAD_BODY_H is the deep one because it is the depth anything OTHER than
 * the lead borrows: the setup sheet sets its standing type down this same well
 * and has no photograph to make room for. */
#define UI_LEAD_COLS          2
#define UI_LEAD_COL_W         UI_MEASURE_LG_W           /*  558, 53 chars */
#define UI_LEAD_COL_X(i)      UI_COLX(3 * (i))          /*   30, 612 */

/* The LAST leg sets to a measure 17 px shorter, which is where the story's end
 * mark stands. Only the last one: the first leg has no end to mark — the story
 * runs out of it and into the second — so a column taken off it would buy
 * nothing and cost the same character and a half a line. Two ragged-right legs
 * differing by 17 px of measure is not a difference anybody can see; a first
 * leg with a square at the foot of it, in the middle of a sentence that
 * continues at the top of the next column, is. */
#define UI_LEAD_LEG_W         UI_END_MEASURE(UI_LEAD_COL_W)     /*  541 */

#define UI_LEAD_BODY_H        (UI_LEAD_Y + UI_LEAD_H - UI_LEAD_SPLIT_Y)   /* 524 */
#define UI_LEAD_UNDER_Y       (UI_LEAD_Y + 650)                           /* 968 */
#define UI_LEAD_UNDER_H       (UI_LEAD_Y + UI_LEAD_H - UI_LEAD_UNDER_Y)   /* 132 = 6 x 22 */

/* The rule down the lead well's gutter. Column rules run down bands 6 and 7 and
 * stopped dead in the one band that dominates the sheet, so the lead read as
 * two floating tiles above a ruled grid. A broadsheet's column rules are the
 * page's spine and they are consistent — and now that band 6 divides on this
 * same x, the spine runs unbroken from the foot of the picture to the ticker. */
#define UI_LEAD_VRULE_X       (UI_LEAD_COL_X(0) + UI_LEAD_COL_W + UI_GUTTER_RULE_DX)

/* --- band 6: one story and the portfolio ----------------------------------
 * 176 px, which is what the lead well left when its photograph went to the full
 * measure, and it buys one story and the rail. The story is a kicker, a
 * headline and a deck, and then it stops — a below-the-fold story with no body
 * under it is ordinary in print, and the alternative at this height is four
 * lines of type that end mid-sentence, which is not.
 *
 * The measure divides in half, at the same x the lead's two legs divide on, so
 * the vrule at 599 runs from the foot of the picture to the ticker rule as one
 * line. The half is also what makes both sides fill: display_36 sets this
 * page's secondary headlines over two lines at 558 and deck_24 sets their decks
 * over two, so both boxes are full rather than padded — at 752 the same
 * headline takes one line and a half and the band would be air. And 558 is the
 * first width at which the rail can afford a NAME beside its symbol: the four
 * figure fields are fixed, and at the 364 it used to have, what was left over
 * for a name measured zero. */
#define UI_SECOND_X           UI_CONTENT_X              /*   30 */
#define UI_SECOND_W           UI_MEASURE_LG_W           /*  558 */
#define UI_SECOND_VRULE_X     (UI_SECOND_X + UI_SECOND_W + UI_GUTTER_RULE_DX)  /* 599 */

/* The three rows stack to the band's foot exactly: 18 + 82 + 54 = 154 of type
 * and 22 of air, and the air is spent between the headline and the deck because
 * that is where a broadsheet spends it. */
#define UI_SECOND_KICKER_Y    (UI_SECOND_Y)             /* 1116, h  18 */
#define UI_SECOND_HEAD_Y      (UI_SECOND_Y + 26)        /* 1142, h  82 = 2 x 41 */
#define UI_SECOND_HEAD_H      82
#define UI_SECOND_DECK_Y      (UI_SECOND_Y + 122)       /* 1238, h  54 = 2 x 27 */
#define UI_SECOND_DECK_H      54

/* The deck is the secondary's LAST element — there is no body under it — so it
 * is the deck that carries the story's end mark, on the same reserved column
 * the lead's last leg uses. There was in any case nothing in this band's depth
 * to take a line from: 18 + 82 + 54 is 154 of the 176, and the 22 that are left
 * are the air between the headline and the deck, which is where a broadsheet
 * spends it and not somewhere a square can be put instead. */
#define UI_SECOND_DECK_W      UI_END_MEASURE(UI_SECOND_W)       /*  541 */

/* The rail: its heading, a hairline, and six holdings at the 25 px pitch the
 * quotation table below it uses. Six rather than eight because six is what
 * 1142..1292 holds at that pitch, and the pitch is not negotiable — a rail set
 * tighter than the table it sits above reads as a different kind of thing. The
 * two holdings that no longer fit are not lost: the table quotes from where the
 * rail stopped. */
#define UI_RAIL_X             UI_COLX(3)                /*  612 */
#define UI_RAIL_W             UI_MEASURE_LG_W           /*  558 */
#define UI_RAIL_HEAD_Y        (UI_SECOND_Y)             /* 1116, h 18 */
#define UI_RAIL_HAIR_Y        (UI_SECOND_Y + 22)        /* 1138 */
#define UI_RAIL_ROW_Y         (UI_SECOND_Y + 26)        /* 1142 */
#define UI_RAIL_ROW_H         25
#define UI_RAIL_ROWS          6                         /* 1142..1292 */

/* And the field that exists only when the rail is wide.
 *
 * The rail takes the whole measure on a day with no second story, and the
 * version this replaces spent all 1140 of it on the same five fields — which
 * meant the NAME field, the only elastic one, went from 194 px to 776. "Nvidia"
 * sets 46 of that, so every row on a thin sheet carried an 800 px river between
 * a company and its own price, six times over: the exact fault that was just
 * fixed on A2's quotation rows, in the exact same shape. A field does not
 * become a better field for being given width it has no text to put in it.
 *
 * So the name is capped at the quotation table's own NAME width and the
 * leftover goes to a shape instead — the same session sparkline the table below
 * prints, at the same 16 px, on the row's own centre line. Below
 * UI_RAIL_SPARK_MIN there is nothing a series can say, and the width goes back
 * to the name; at the rail's own 558 that is always the case, so a narrow rail
 * is untouched. The two constants are the table's, deliberately: a shape in the
 * rail drawn at a different size from the shape in the table twelve pixels
 * below it reads as two different measurements of the same thing. */
#define UI_RAIL_SPARK_W       UI_TICKER_SPARK_W         /*  150 */
#define UI_RAIL_SPARK_H       UI_TICKER_SPARK_H         /*   16 */
#define UI_RAIL_SPARK_MIN     UI_RAIL_SPARK_W

/* --- band 7: the watchlist and the briefs ---------------------------------
 * The table takes columns 1-4 so its five fields have room to breathe, and the
 * briefs take 5-6. One block of eight rather than two blocks of four: the model
 * holds sixteen quotes, and the eight that do not fit here are exactly what page
 * A2 exists for, rather than being crammed in at half the row pitch.
 *
 * The five fields sum to 752 with four 8 px gaps: 90 + 230 + 130 + 120 + 150. */
#define UI_TICKER_X           UI_CONTENT_X              /*  30 */
#define UI_TICKER_W           UI_COL(4)                 /* 752 */
#define UI_TICKER_VRULE_X     (UI_TICKER_X + UI_TICKER_W + UI_GUTTER_RULE_DX)   /* 793 */
#define UI_TICKER_HEAD_Y      (UI_TICKER_Y)             /* 1306, h 18 */
#define UI_TICKER_HAIR_Y      (UI_TICKER_Y + 22)        /* 1328 */
#define UI_TICKER_ROW_Y       (UI_TICKER_Y + 28)        /* 1334 */
#define UI_TICKER_ROW_H       25
#define UI_TICKER_ROWS        8                         /* 1334..1534 */

#define UI_TICKER_SYM_W        90
#define UI_TICKER_NAME_W      230
#define UI_TICKER_LAST_W      130
#define UI_TICKER_CHG_W       120
#define UI_TICKER_SPARK_W     150
#define UI_TICKER_SPARK_H      16
#define UI_TICKER_FIELD_GAP     8

#define UI_BRIEF_X            UI_COLX(4)                /*  806 */
#define UI_BRIEF_W            UI_COL(2)                 /*  364 */
#define UI_BRIEF_ROWS         3
#define UI_BRIEF_H            68                        /* 1334..1538 */
/* A sparkline is the one chart with no axis, no labels and no room to have
 * them, sized to sit inside a row without touching its rules. */
#define UI_SPARK_W            UI_TICKER_SPARK_W
#define UI_SPARK_H            UI_TICKER_SPARK_H

/* The grid is stated twice on purpose — once as a span and once as a sum — and
 * these are where the two are made to agree. A column width edited without its
 * gutter, or a ribbon cell rounded to a friendlier number, fails the build here
 * rather than three pixels into the right margin on the glass. */
#ifndef __cplusplus
_Static_assert(UI_COL(UI_COLS) == UI_CONTENT_W,
               "6 columns + 5 gutters must be exactly the content width");
_Static_assert(1 * UI_RIBBON_CELL_W(1) == UI_CONTENT_W
               && 2 * UI_RIBBON_CELL_W(2) == UI_CONTENT_W
               && 3 * UI_RIBBON_CELL_W(3) == UI_CONTENT_W
               && 4 * UI_RIBBON_CELL_W(4) == UI_CONTENT_W
               && 5 * UI_RIBBON_CELL_W(5) == UI_CONTENT_W
               && UI_RIBBON_CELLS == NEWS_INDEX_MAX,
               "the index ribbon must divide the measure exactly at every count "
               "of indices the model can hold");
_Static_assert(UI_TICKER_SYM_W + UI_TICKER_NAME_W + UI_TICKER_LAST_W
               + UI_TICKER_CHG_W + UI_TICKER_SPARK_W
               + 4 * UI_TICKER_FIELD_GAP == UI_TICKER_W,
               "the quotation table's five fields must fill its four columns exactly");
_Static_assert(UI_TICKER_X + UI_TICKER_W + UI_GUTTER == UI_BRIEF_X
               && UI_BRIEF_X + UI_BRIEF_W == UI_CONTENT_R,
               "the quotation table and the briefs must fill the measure with one gutter");
_Static_assert(UI_SECOND_X + UI_SECOND_W + UI_GUTTER == UI_RAIL_X
               && UI_RAIL_X + UI_RAIL_W == UI_CONTENT_R,
               "the secondary story and the rail must fill the measure with one gutter");
_Static_assert(UI_LEAD_X + UI_LEAD_W == UI_CONTENT_R,
               "the lead's headline runs the full measure");
_Static_assert(UI_LEAD_VIS_X + UI_LEAD_VIS_W == UI_CONTENT_R,
               "the lead's photograph runs the full measure too");
_Static_assert(UI_LEAD_COL_X(0) + UI_LEAD_COL_W + UI_GUTTER == UI_LEAD_COL_X(1)
               && UI_LEAD_COL_X(UI_LEAD_COLS - 1) + UI_LEAD_COL_W == UI_CONTENT_R,
               "the lead's two legs must fill the measure with one gutter");

/* The well's rows are stated as offsets from its top and have to add up to its
 * height, or the last leg either overruns the rule or stops short of it. The
 * caption is the row between the two that is easiest to lose in an edit. */
_Static_assert(UI_LEAD_SPLIT_Y + UI_LEAD_VIS_H < UI_LEAD_CAP_Y
               && UI_LEAD_CAP_Y + 18 <= UI_LEAD_UNDER_Y,
               "the caption's line must sit clear between the photograph and the legs");
_Static_assert(UI_LEAD_UNDER_Y + UI_LEAD_UNDER_H == UI_LEAD_Y + UI_LEAD_H
               && UI_LEAD_SPLIT_Y + UI_LEAD_BODY_H == UI_LEAD_Y + UI_LEAD_H,
               "a lead leg must end on the foot of the well in both of its shapes");

/* Band 6 has two halves and neither may stop short of the band's foot: the
 * story's deck and the rail's last holding both land on 1292. */
_Static_assert(UI_SECOND_DECK_Y + UI_SECOND_DECK_H == UI_SECOND_Y + UI_SECOND_H,
               "the secondary story must set to the foot of its band");
_Static_assert(UI_RAIL_ROW_Y + UI_RAIL_ROWS * UI_RAIL_ROW_H
               == UI_SECOND_Y + UI_SECOND_H,
               "the portfolio rail's rows must fill its band exactly");

/* Every tile the server sends is packed two pixels to a byte, so a slot of odd
 * width or at an odd x would need a nibble-shifting blit for no reason. This is
 * what keeps the grid honest about that. */
_Static_assert((UI_COL_W % 2) == 0 && (UI_GUTTER % 2) == 0
               && (UI_MARGIN % 2) == 0 && (UI_LEAD_VIS_W % 2) == 0
               && (UI_LEAD_VIS_X % 2) == 0 && (UI_LEAD_VIS_H % 2) == 0,
               "every column span and origin must be even so a photo tile blits as a memcpy");

/* The ribbon's three rows stack on measured line heights with no padding, and
 * the change figure is the one most likely to be pushed into the rule by an
 * edit above it. 18 + 41 + 18 from y=226 ends at 304, six clear of the rule. */
/* TWO PIXELS. This is the tightest thing on the sheet, and it is deliberate: the
 * change row was raised from label_14's 18 to 22 because the one figure a market
 * ribbon exists to print was set two sizes below the level it modifies, and the
 * band was grown from 78 to 82 to pay for it rather than reflowing every band
 * below. If you are reading this because the build stopped here, the ribbon's
 * change row now ends ON OR BELOW the heavy rule at y=310: either the row got
 * taller (a regenerated face, a bigger UI_F_* on the chg label) or the rule
 * moved up. Nothing else on this sheet is within four pixels of anything. */
_Static_assert(UI_RIBBON_CHG_Y + UI_RIBBON_CHG_LH < UI_RIBBON_RULE_Y,
               "the index ribbon's change row is colliding with the heavy rule "
               "beneath it: UI_RIBBON_CHG_Y + UI_RIBBON_CHG_LH must stay under "
               "UI_RIBBON_RULE_Y, and there are only two pixels of slack");
_Static_assert(UI_LEAD_Y + UI_LEAD_H_SOLO == UI_SECOND_Y + UI_SECOND_H,
               "a promoted lead must end where the secondary row ended");
_Static_assert(UI_FOLIO_Y + UI_FOLIO_H <= UI_CONTENT_B,
               "the folio must sit above the bottom margin");
#endif

/* --- colour ---------------------------------------------------------------
 * White paper, black type, edge to edge. Colour on this page is not decoration,
 * it is data: green and red appear on percentage changes and their marks — in
 * the index ribbon, the portfolio rail and the ticker table — and nowhere else.
 * Not on headlines, not on rules, not on a chart's axis.
 *
 * Blue and yellow never reach the glass from the UI at all. Partly because the
 * panel renders those two inks least faithfully of the six — but mostly because
 * a page that spends colour on ornament is a page where the two colours that
 * carry meaning stop being seen. The only other colour on the sheet is a photo
 * tile, which arrives already dithered across all six inks.
 *
 * All four are exact palette entries, so they take wp_quantize()'s identity
 * path and come out flat — a colour anywhere between two inks would dither, and
 * a dithered hairline is a dashed one.
 *
 * They expand to a call, not to a constant: lv_color_hex() builds the colour at
 * runtime, so these go in a statement and not in a file-scope initializer. */
#define UI_INK          lv_color_hex(WP_RGB_BLACK)
#define UI_PAPER        lv_color_hex(WP_RGB_WHITE)
#define UI_UP           lv_color_hex(WP_RGB_GREEN)
#define UI_DOWN         lv_color_hex(WP_RGB_RED)

/* Colour is data, and a figure the board cannot vouch for is not data. When the
 * snapshot is stale or the board is offline, every change figure and every mark
 * on both pages prints in ink instead: the alternative is a page of prices in
 * the colour reserved for live movement, asserting in the loudest way the sheet
 * has that it is current, with one 52 px word at the top saying otherwise.
 *
 * The three call sites that decide a change's colour go through this rather
 * than through `bp < 0 ? UI_DOWN : UI_UP`, and zero is INK at every state: a
 * flat session is not a rise, and a solid green triangle beside +0.00% makes a
 * reader scanning a column for direction count it as a gainer.
 *
 * Defined in ui_news.c, which is where the link state arrives. */
bool       ui_data_live(void);
lv_color_t ui_chg_colour(int32_t bp);

/* --- fonts ----------------------------------------------------------------
 * The roles, not the faces: a page asks for "a deck" and gets whatever
 * ui_fonts.h currently sets a deck in. Every text face covers ASCII, Latin-1
 * and S_DATA_PUNCT, so any of them can draw any string the network sends.
 *
 * There is no separate numeral face, so the ribbon's 6,412.83 is set in
 * UI_F_HEADLINE and the ticker's figures in UI_F_LABEL. That is not a
 * compromise: the text faces here are a Didone and a text serif, whose lining
 * figures are the whole point of the family, and a table set in the same face
 * as the headlines above it is what makes a front page look typeset rather than
 * assembled. LVGL's built-in Montserrat 14 is still compiled in — it is
 * LV_FONT_DEFAULT and nothing else — but nothing on this board is drawn with
 * it, because every helper in this header takes its font explicitly. */
#define UI_F_MASTHEAD   (&ui_font_masthead_112)
#define UI_F_LEAD       (&ui_font_display_56)
#define UI_F_HEADLINE   (&ui_font_display_36)
#define UI_F_DECK       (&ui_font_deck_24)
#define UI_F_BODY_LG    (&ui_font_body_20)
#define UI_F_BODY       (&ui_font_body_16)
#define UI_F_LABEL      (&ui_font_label_14)

/* --- shapes ---------------------------------------------------------------
 * All coordinates are relative to `par`. Every one of these returns an object
 * that is non-scrollable, non-clickable, square-cornered and un-themed. */

/* An invisible container. Use it to group a section so the whole thing can be
 * shown or hidden in one call. */
lv_obj_t *ui_pane(lv_obj_t *par, int x, int y, int w, int h);

/* A solid black rectangle — filled chips, the end-of-story square. */
lv_obj_t *ui_fill(lv_obj_t *par, int x, int y, int w, int h);

/* A white rectangle with a black border of `bw` px. */
lv_obj_t *ui_frame(lv_obj_t *par, int x, int y, int w, int h, int bw);

/* A horizontal rule of `weight` px, and a vertical one of `weight` px. Every
 * band draws at least one, and they exist as their own call rather than as
 * ui_fill() so that the three legal weights are the only thing a caller can
 * pass and the simulator has one shape to look for. */
lv_obj_t *ui_rule(lv_obj_t *par, int x, int y, int w, int weight);
lv_obj_t *ui_vrule(lv_obj_t *par, int x, int y, int h, int weight);

/* A left-aligned label that sizes itself to its text. */
lv_obj_t *ui_lab(lv_obj_t *par, int x, int y, const lv_font_t *f, const char *txt);

/* The same, in a colour. For the change figures, and only for them: this and
 * ui_draw_tri_abs() are the two calls that can put UI_UP or UI_DOWN on the
 * glass, so grepping for them is how the colour policy above is audited. */
lv_obj_t *ui_lab_c(lv_obj_t *par, int x, int y, const lv_font_t *f,
                   lv_color_t colour, const char *txt);

/* A label with a fixed width and an alignment. Text longer than `w` is
 * ellipsized rather than wrapped or clipped — a headline that silently grows a
 * second line pushes its deck into the body below it. */
lv_obj_t *ui_lab_w(lv_obj_t *par, int x, int y, int w,
                   const lv_font_t *f, lv_text_align_t align, const char *txt);

/* The same with a fixed HEIGHT as well, and the call most of this page is set
 * with: the text wraps inside `w` and is ellipsized where it would pass `h`.
 * LVGL rounds that cut down to the last whole line, so a height of n line
 * heights means exactly "at most n lines" — which is how the lead headline is
 * given two and its deck two without either being able to take a third from the
 * band beneath it. */
lv_obj_t *ui_lab_box(lv_obj_t *par, int x, int y, int w, int h,
                     const lv_font_t *f, lv_text_align_t align, const char *txt);

/* White-on-black text, for state chips. */
lv_obj_t *ui_lab_inv(lv_obj_t *par, int x, int y, int w,
                     const lv_font_t *f, lv_text_align_t align, const char *txt);

/* Let a label wrap inside `height` px instead of ellipsizing. Headlines, decks
 * and labels never want this; body text is copyfitted before it is set, so it
 * wants it and cannot overflow. */
void ui_lab_wrap(lv_obj_t *label, int height);

/* Paint white behind a label's box, for text that sits on top of something
 * already drawn — a chart's first and last value over its own polyline — where
 * transparency would leave a line running through the middle of a figure. */
void ui_lab_opaque(lv_obj_t *label);

/* Letter-spacing, in px. Every caps label on the page takes +2: Franklin's caps
 * were cut to be spaced, and a kicker set solid reads as one long word from the
 * distance this panel is looked at. */
void ui_track(lv_obj_t *label, int px);

/* ASCII and Latin-1 upper case, into `out`. ui_track() is letterspacing cut for
 * Franklin's CAPS, and applied to lower case it takes a word apart —
 * "N a s d a q" beside a correctly tracked "S&P 500" in the same row. Two of
 * the tracked slots on this sheet take a string the network wrote, so those two
 * uppercase it here first. Bytes outside the two ranges pass through unchanged,
 * which keeps a UTF-8 sequence a UTF-8 sequence. */
void ui_upper(char *out, size_t n, const char *src);

void ui_set(lv_obj_t *label, const char *txt);
void ui_setf(lv_obj_t *label, const char *fmt, ...) LV_FORMAT_ATTRIBUTE(2, 3);
void ui_show(lv_obj_t *obj, bool visible);

/* --- immediate-mode drawing ----------------------------------------------
 * For what LVGL widgets cannot express on this panel: the charts, and the two
 * marks that used to be an icon font. Called only from a LV_EVENT_DRAW_MAIN
 * handler, in ABSOLUTE screen coordinates (add lv_obj_get_coords()'s origin).
 *
 * `white` draws in white — used to punch a hole in something already drawn.
 *
 * The line is a hard-pixel Bresenham run, NOT lv_draw_line(): an antialiased
 * diagonal leaves greys in the draw buffer, and wp_quantize565() resolves the
 * greys a black stroke on white paper makes to GREEN. Nothing here may reach
 * the glass in a colour that is not one of the four exact palette entries. */
void ui_draw_line_abs(lv_layer_t *L, int x1, int y1, int x2, int y2, int w, bool white);
void ui_draw_disc_abs(lv_layer_t *L, int cx, int cy, int r, bool white);
void ui_draw_ring_abs(lv_layer_t *L, int cx, int cy, int r, int w, int a0, int a1);
void ui_draw_rect_abs(lv_layer_t *L, int x1, int y1, int x2, int y2,
                      bool fill, int border, bool white);

/* The line and the rectangle again, in an explicit colour. A chart needs black
 * for its polyline and its baseline AND one of the two market colours for a
 * candle body, and a bool cannot say that. The two above are these with the
 * bool spelled out, so the callers that only ever wanted ink read as before. */
void ui_draw_line_c_abs(lv_layer_t *L, int x1, int y1, int x2, int y2, int w,
                        lv_color_t colour);
void ui_draw_rect_c_abs(lv_layer_t *L, int x1, int y1, int x2, int y2,
                        bool fill, int border, lv_color_t colour);

/* The up/down mark: a solid triangle filling `w` x `h` at (x, y), pointing up
 * or down, in `colour`. Drawn rather than set, because a text arrow would have
 * to be added to every text face — three of which are variable fonts fetched
 * from the network at generation time — to buy a glyph that is six lines of
 * geometry here and always the same two shapes. */
void ui_draw_tri_abs(lv_layer_t *L, int x, int y, int w, int h,
                     bool up, lv_color_t colour);

/* --- text ----------------------------------------------------------------- */

/* 641283 -> "641,283". Grouping matters here: the ribbon's index levels are the
 * first thing read from across a room, and an ungrouped five-digit number is
 * genuinely slower to parse. */
void ui_group_int(char *out, size_t n, int v);

/* The two figures this page prints, from the two integer units the wire sends:
 * 641283 cents -> "6,412.83" and 62 basis points -> "+0.62%". They live here
 * rather than in a snprintf at each call site because the ribbon, the portfolio
 * rail and the quotation table print the same two quantities and must not
 * disagree about a decimal or a separator — and because nothing on this board
 * is allowed to reach for a float to do it.
 *
 * A percentage always carries its sign, the plus included: a column where only
 * the losses are signed reads as a column of typos. The sign is the ASCII '-',
 * not U+2212 — see S_COMPOSED_CHARS in ui_strings.h for why no face here has
 * the typographically correct one. */
void ui_money(char *out, size_t n, int32_t cents);
void ui_pct(char *out, size_t n, int32_t bp);

/* --- the pages ------------------------------------------------------------
 * Two pages, and KEY0 toggles them. Each is one file and obeys the same
 * two-call contract: create() builds a pane covering the WHOLE sheet and
 * returns it (the router shows and hides it), update() rewrites its widgets
 * from a snapshot and touches nothing else. A NULL snapshot means "blank
 * yourself" — which on a front page means an empty page, not a placeholder,
 * because the demo snapshot is what an unconfigured board shows.
 *
 * The pane is full-bleed rather than inset because the bands above are panel
 * coordinates: a page positions a child at UI_MAST_Y and that is where it
 * lands, with no origin to remember and no second frame of reference for the
 * simulator to have to undo.
 *
 * Nothing in a page file talks to the panel, keeps state beyond its widgets, or
 * knows which page is on screen. */
lv_obj_t *ui_page_front_create(lv_obj_t *par);
void      ui_page_front_update(const news_t *v);

lv_obj_t *ui_page_markets_create(lv_obj_t *par);
void      ui_page_markets_update(const news_t *v);

#ifdef __cplusplus
}
#endif
