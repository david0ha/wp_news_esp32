/*
 * ui_page_markets.c — A2, the markets page.
 *
 * A1 prints eight quotations and the model holds sixteen. This page is where
 * the other eight live, and it is the answer to "what is everything doing"
 * rather than to "what happened today": it gives up the news hole almost
 * entirely and spends the sheet on figures instead.
 *
 * ## It draws no furniture at all
 *
 * The blackletter belongs to A1 alone. A masthead reprinted on every page is a
 * logo, and a paper that puts its logo at the top of page two is a brochure. A2
 * gets a running head — the same name, no blackletter, set in display_36 caps
 * with the section after it — under the same heavy rule the masthead sits on.
 * But that head is not drawn HERE. ui_news.c owns the masthead band and swaps
 * the type in it per page, exactly as it owns the kicker strip, the dateline
 * row, the index ribbon and the folio, and it draws all five over both pages.
 * A2 drawing its own would not replace them: the furniture is created after the
 * pages and prints on top, so a second running head lands across the first at a
 * different size and reads as a fault in the panel.
 *
 * So the first pixel this file is allowed is y=318, under band 4's heavy rule,
 * and the last is y=1543, over the hairline the folio hangs from.
 *
 * ## Its bands are its own inside that window
 *
 * Between the furniture A2 is a different paper. The front page spends 588 px
 * on a lead well that A2 has no lead for, and reusing bands 5 through 7 here
 * would set a quotation table in a slot whose height was chosen around a
 * photograph.
 *
 * What is unchanged is the grid — the six columns, the 24 px gutter, the three
 * rule weights, the even spans — and the way the geometry is stated: every
 * coordinate below is a #define, every span a sum of the two grid integers, and
 * the sums that have to agree are made to agree by a _Static_assert rather than
 * by arithmetic done once in somebody's head. That is the same contract
 * ui_internal.h holds A1 to, and it is why an edit here fails the build instead
 * of landing three pixels into the right margin on the glass.
 *
 * ## Colour
 *
 * Green and red reach the glass from exactly one function in this file,
 * set_chg(), and from the five up/down marks it draws beside the index levels.
 * Nothing else on the page is anything but black on white.
 */
#include "ui_internal.h"
#include "ui_chart.h"

#include <stdint.h>

/* Every caps label on this board takes +2 — Franklin's caps were cut to be
 * spaced, and a kicker set solid reads as one long word from the distance the
 * panel is looked at. It is a #define here because A2 sets nine different caps
 * labels and a tracking value that drifted between them would show up as two
 * column heads of different widths over the same field. */
#define MK_TRACK             2

/* --- the sheet, top to bottom ---------------------------------------------
 *
 * Everything above the first line and below the last is ui_news.c's, printed
 * identically on both pages, and is listed here only so that the window this
 * file may draw in can be read off the same table.
 *
 *   band / rule                y      h    ends   gap to next
 *   - kicker strip            30     18      48     8       (furniture)
 *     hairline                56      1      57     7       (furniture)
 *   - masthead / running head 64    112     176    10       (furniture)
 *     heavy rule             186      3     189     4       (furniture)
 *   - dateline row           193     20     213     6       (furniture)
 *     hairline               219      1     220     6       (furniture)
 *   - index ribbon           226     78     304     6       (furniture)
 *     heavy rule             310      3     313     5       (furniture)
 *   1 index board            318    500     818     6
 *     heavy rule             824      3     827     7
 *   2 watchlist heads        834     18     852     6
 *     hairline               858      1     859     7
 *     watchlist rows         866    496    1362     7
 *     rule                  1369      2    1371     7
 *   3 IN BRIEF heading      1378     18    1396     6
 *     hairline              1402      1    1403     9
 *     briefs                1412    132    1544     0
 *     hairline              1544      1    1545     6       (furniture)
 *   - folio                 1551     18    1569     -       (furniture)
 *
 * A2's three blocks have exactly 1226 px between band 4's heavy rule and the
 * one the folio hangs from, and AT CAPACITY they take all of it: the last brief
 * ends on the row the folio's hairline is printed on, with nothing left to leave
 * at the foot. Below capacity they take what the flow below gives them and the
 * page may end short of that line, closed by a rule of its own — which is a
 * short paper, and honest. What it is not allowed to do is reach the foot by
 * inflating its rows until they get there.
 *
 * The three blocks are sized against each other rather than each against its
 * own contents: five index rows, eight quotation rows and three briefs is
 * sixteen lines of figures for 1226 px, so the rows are deep and each carries a
 * chart. A markets page set at the front page's row pitch would be a third of a
 * sheet of type with two thirds of a sheet of paper under it. */
#define MK_TOP              (UI_RIBBON_RULE_Y + UI_RIBBON_RULE_W + 5)   /* 318 */
#define MK_BOT              UI_TICKER_RULE_Y                    /* 1544 */

#define MK_IDX_Y            MK_TOP                              /*  318 */
#define MK_IDX_ROWS           5
#define MK_IDX_ROW_H        100
#define MK_IDX_H            (MK_IDX_ROWS * MK_IDX_ROW_H)        /* 500 */
#define MK_IDX_RULE_Y       824

#define MK_WL_HEAD_Y        834
#define MK_WL_HEAD_H         18
#define MK_WL_HAIR_Y        858
#define MK_WL_ROW_Y         866
#define MK_WL_ROWS            8
#define MK_WL_ROW_H          62
#define MK_WL_RULE_Y       1369

#define MK_BRIEF_HEAD_Y    1378
#define MK_BRIEF_HEAD_H      18
#define MK_BRIEF_HAIR_Y    1402
#define MK_BRIEF_ROW_Y     1412
#define MK_BRIEF_ROWS         3
#define MK_BRIEF_ROW_H       44

/* --- the same table read as a FLOW ----------------------------------------
 *
 * Everything above is the full payload: five indices, sixteen quotations and
 * three briefs, which is the shape the page was designed around and the shape
 * the assertions at the foot of this section hold. It is not the shape that
 * arrives every morning.
 *
 * A row pitch that is a constant times its index is what leaves a third of a
 * metre of bare sheet under two index rows, outlined by band rules that still
 * run the full measure — a page whose middle failed to print rather than a
 * quiet day. So the y of every block is computed in the update from the counts
 * actually present, out of the gaps below, and the numbers above are what that
 * arithmetic produces when every count is at capacity.
 *
 * What is left over is then SPENT, in a fixed order and against a ceiling per
 * row, and whatever is still left is paper. The order is the one the rows earn:
 * the index board first, because its rows carry a chart and a chart is the only
 * element on this page that is genuinely better for being taller; then the
 * briefs; and the quotation table last, because a quotation is one line of type
 * beside a shape and a taller row is the same line of type with more paper under
 * it. The ceilings are at MK_*_ROW_H_MAX below, and they are what stops the page
 * filling the sheet by inflation.
 *
 * The gaps are the ones in the band table at the head of this file, named so
 * the flow reads as that table rather than as seven magic numbers. */
#define MK_GAP_IDX_RULE       6     /* index board -> heavy rule            */
#define MK_GAP_RULE_HEAD      7     /* a rule -> the heading under it       */
#define MK_GAP_HEAD_HAIR      6     /* a heading -> its hairline            */
#define MK_GAP_WL_HAIR_ROW    7     /* the watchlist hairline -> its rows   */
#define MK_GAP_WL_ROW_RULE    7     /* the last row -> the rule under it    */
#define MK_GAP_BR_HAIR_ROW    9     /* the briefs hairline -> its rows      */

/* What a row keeps for itself when its pitch grows: an index row's hairline
 * sits 4 px off the foot of the row and a quotation row's 9, and the chart in
 * each stops short of that hairline. Written as the difference rather than as
 * the position so that one pitch drives both. */
#define MK_IDX_HAIR_GAP     (MK_IDX_ROW_H - MK_IDX_HAIR_DY)         /*  4 */
#define MK_IDX_CHART_GAP    (MK_IDX_HAIR_DY - MK_IDX_CHART_DY - MK_IDX_CHART_H)
#define MK_WL_HAIR_GAP      (MK_WL_ROW_H  - MK_WL_HAIR_DY)          /*  9 */
#define MK_WL_SPARK_GAP     (MK_WL_HAIR_DY - MK_WL_SPARK_DY - MK_WL_SPARK_H)

/* --- how far a row may grow ------------------------------------------------
 *
 * The ceilings, and the reason this page composes rather than stretches.
 *
 * Slack is the paper a thin payload leaves between the last row and the foot of
 * the sheet, and there are exactly two things to do with it: give it to the
 * rows, or leave it. Giving ALL of it to the rows is what turned three
 * quotations into three posters — one 24 px line of type alone in a 290 px ruled
 * box, with a sparkline blown up to 680 x 130 of bare diagonal beside it. That
 * fills the sheet the way a stretched photograph fills a frame, and it passed
 * every assertion the simulator had.
 *
 * The ceilings are not one number because the rows are not one thing:
 *
 *   an index row  sets a name, a level, a change AND a chart across 544 px, and
 *                 the chart is the one element on this page that is genuinely
 *                 better taller: 544 x 80 is a strip, 544 x 180 is a chart. Twice
 *                 the pitch is where that stops being true and the aspect stops
 *                 improving, so twice is the ceiling and the board is first in
 *                 the queue;
 *   a brief       is one line of deck. Its extra height is leading, and past half
 *                 again three briefs stop reading as one list;
 *   a quotation   is one line of type beside a shape, so the same ceiling for the
 *                 same reason — and last in the queue, because it has the least
 *                 to do with the height it is given. */
#define MK_IDX_ROW_H_MAX    (2 * MK_IDX_ROW_H)                      /* 200 */
#define MK_BRIEF_ROW_H_MAX  (MK_BRIEF_ROW_H * 8 / 5)                /*  70 */
#define MK_WL_ROW_H_MAX     (MK_WL_ROW_H * 8 / 5)                   /*  99 */

/* A SECOND round of these ceilings was tried and taken out again, and it is
 * worth saying why so that the next reader does not reach for it a third time.
 *
 * Four design reviewers called the sparse page's 359 px of trailing paper — 22%
 * of the sheet, below a closing rule — a blocker, and the obvious answer was a
 * second tier: index rows to three times their pitch, quotations and briefs to
 * twice, spend the slack until the page reaches the foot. It worked, and it was
 * the exact failure the first tier exists to stop: a page satisfying a bound by
 * inflating its rows instead of by composing them. The tell was that it
 * immediately needed a SECOND cap — a ceiling on the sparkline's height — to
 * contain what the first one let through. A cap that exists to contain another
 * cap's consequences means the first cap is doing the wrong job.
 *
 * The argument that a full payload still lands on the band table is true and
 * beside the point: the thin payload is the entire reason the ceilings exist.
 *
 * So the ceilings stay at 1.6x, the page still ends where its content ends, and
 * what moved instead was the simulator's trailing-paper bound — see
 * SIM_TRAIL_MAX in sim/main_sim.c, which was a first estimate that landed 26 px
 * from a page that is correct. A short paper is honest; a stretched one is not.
 *
 * WHICH LEAVES THE REMAINING LEVER OUTSIDE THIS FILE, IN THE PAYLOAD CONTRACT.
 * Two indices and three quotations is a producer describing a thin day, and the
 * fix for a thin day is more content rather than more leading: a server with
 * only two indices to send should send more quotations, and the sixteen this
 * page is drawn around are what fill it. See docs/news-contract.md. No layout
 * can compose a page out of eight hundred pixels of figures and twelve hundred
 * pixels of paper except by inflating one into the other.
 */

/* And when the ceilings are all reached and there is paper left, the page ENDS:
 * a rule under the last row and the rest of the sheet left as paper, which is
 * what a short column of type does in print. It is the mid weight rather than a
 * hairline because it is a boundary with nothing on the other side of it, and
 * that is the weight this page rules a boundary with.
 *
 * Below one brief row of shortfall — the shallowest row on the sheet — nothing
 * is drawn: that much is the arithmetic not dividing rather than a short page,
 * and the hairline the folio hangs from is close enough to be the line the page
 * ended on. */
#define MK_CLOSE_W          UI_RULE_MID
#define MK_CLOSE_MIN        MK_BRIEF_ROW_H                          /*  44 */

/* --- band 1: the index board ----------------------------------------------
 *
 * The furniture's ribbon sets the five indices as five 228 px cells because
 * band 4 has 78 px to do it in, and it does that on this page too. Here each
 * index gets the whole measure and 100 px of it, and the shape of the session is
 * drawn beside the number instead of being left to the reader's memory of
 * yesterday. That is what A2 is for: the ribbon says where the market closed
 * and this says how it got there.
 *
 * The level is set in UI_F_LEAD, which ui_fonts.h describes as the lead story's
 * headline and nothing else. That is true of A1 and it is the point: A2 has no
 * lead story, so the face is unused on this page, and the index board IS this
 * page's lead — the first thing the eye lands on under the running head, and
 * the reason anyone turns to it. Setting it in the secondary headline face
 * instead would make A2 a page with no first rank at all.
 *
 * Four fields with three 16 px gaps: 340 + 28 + 180 + 544 = 1092, and the chart
 * ends on the right margin exactly. The mark is a field rather than a character
 * in front of the percentage because it is drawn, not set — see the comment on
 * mark_draw_cb below — and a drawn shape needs a box of its own. */
#define MK_IDX_GAP           16
#define MK_IDX_ROW_YY(i)    (MK_IDX_Y + (i) * MK_IDX_ROW_H)

#define MK_IDX_NAME_X       UI_CONTENT_X                                    /*   30 */
#define MK_IDX_NAME_W       340
#define MK_IDX_MARK_X       (MK_IDX_NAME_X + MK_IDX_NAME_W + MK_IDX_GAP)    /*  386 */
#define MK_IDX_MARK_W        28
#define MK_IDX_CHG_X        (MK_IDX_MARK_X + MK_IDX_MARK_W + MK_IDX_GAP)    /*  430 */
#define MK_IDX_CHG_W        180
#define MK_IDX_CHART_X      (MK_IDX_CHG_X + MK_IDX_CHG_W + MK_IDX_GAP)      /*  626 */
#define MK_IDX_CHART_W      544

/* An index row reserves that fourth field whether or not the payload filled it,
 * and a board where NO index sent a spark is 544 px of paper beside every level
 * — the same hole a lead story would leave if its body did not reflow into a
 * photograph that never arrived. So it reflows.
 *
 * IT REFLOWS TO THE MARGINS, NOT TO THE CENTRE. The version this replaces
 * centred the three remaining fields on the measure, and on a two-index morning
 * that put the largest figures on the sheet in the middle of the paper with 281
 * px blank at the left and 341 at the right, and the label not even centred over
 * its own number — a slide, on a page where every other element is flush left.
 * Nothing in print floats. So the name and the level keep the left margin they
 * always had and the change goes to the RIGHT one, which is the row spanning the
 * measure the way a full-data row does and is what the two figures of a
 * quotation line do everywhere else on this sheet.
 *
 * A board with SOME charts keeps them where they are: the column is there
 * because the board has one, and the rows that did not fill it are the payload
 * being uneven, which is not the page's to hide. */
#define MK_IDX_GROUP_W      (MK_IDX_CHG_X + MK_IDX_CHG_W - MK_IDX_NAME_X)   /*  580 */
#define MK_IDX_NOCHART_CHG_X   (UI_CONTENT_R - MK_IDX_CHG_W)                /*  990 */
#define MK_IDX_NOCHART_MARK_X  (MK_IDX_NOCHART_CHG_X - MK_IDX_GAP - MK_IDX_MARK_W)

/* Rows inside a row. The name sits over its own level as it does in the
 * furniture's ribbon, and the change is dropped so that the two figures END
 * level — 24 + 65 and 48 + 41 both finish on 89 — which is what makes a level
 * and its percentage read as one figure rather than as two stacked things. The
 * mark is centred on the change: 56 + 12 against 48 + 20.
 *
 * The two heights are the faces' measured line heights, written out because the
 * assertions below have to be able to see them; ui_internal.h states A1's bands
 * the same way and for the same reason. */
#define MK_IDX_VAL_H         65                         /* display_56 */
#define MK_IDX_CHG_H         41                         /* display_36 */

#define MK_IDX_NAME_DY        4                         /* label_14, h 18 */
#define MK_IDX_VAL_DY        24
#define MK_IDX_CHG_DY        48
#define MK_IDX_MARK_DY       56
#define MK_IDX_MARK_H        24
#define MK_IDX_CHART_DY       6
#define MK_IDX_CHART_H       80
#define MK_IDX_HAIR_DY       96

/* --- band 2: the watchlist ------------------------------------------------
 *
 * Sixteen quotations in two blocks of eight, cols 1-3 and cols 4-6, with a
 * hairline down the gutter between them. Two blocks rather than one column of
 * sixteen because a table 558 px wide has room for all five fields and one
 * 1140 px wide would have to invent two more; and because eight rows is the
 * length a reader scans without losing the column head.
 *
 * The five fields sum to 526 with four 8 px gaps, which is the three-column
 * span exactly. A1 sets its quotation table in label_14 throughout; a 62 px row
 * has the room to put the symbol and the two figures in body_20, and at this
 * row pitch it needs to — label_14 in a row this deep reads as a caption that
 * lost its picture. The widths follow from that: at body_20's measured 10.44 px
 * average advance LAST holds "641,283.99" and CHG holds "-999.99%", which are
 * the widest strings ui_money() and ui_pct() can produce, and the name stays in
 * label_14 because it is the one field that ellipsizes routinely and a longer
 * fragment of it is worth more than a larger one. */
#define MK_WL_BLOCKS          2
#define MK_WL_W             UI_COL(3)                   /* 558 */
#define MK_WL_X(b)          UI_COLX(3 * (b))            /*  30, 612 */
#define MK_WL_ROW_YY(i)     (MK_WL_ROW_Y + (i) * MK_WL_ROW_H)
#define MK_WL_VRULE_X       (MK_WL_X(0) + MK_WL_W + UI_GUTTER_RULE_DX)      /* 599 */
#define MK_WL_VRULE_H       (MK_WL_ROW_YY(MK_WL_ROWS - 1) + MK_WL_HAIR_DY \
                             + UI_RULE_HAIR - MK_WL_HEAD_Y)                 /* 640 */

/* The mark is a field of its own, exactly as it is in the index rows above and
 * in A1's quotation table, and it is not decoration. On a panel whose red is a
 * brick and whose green is a moss, a row that carries its direction in colour
 * ALONE — which is what this table did — differs from its neighbour by nothing
 * a reader across the room, or a reader with any red/green deficiency, can
 * resolve. The 28 px it costs come out of NAME, the one field here that
 * ellipsizes routinely and loses the least by it. */
/* 128 and 54, and the forty pixels moved between them are the whole finding: a
 * 1200 px-wide page was ellipsising "Advanced …" and "Meta Platfo…" while the
 * 1200 px-wide FRONT page set both whole at half the column width — because the
 * name had 88 px and the squiggle immediately to its right had 94. A 94 x 36
 * shape was outranking the company's name. Measured rather than estimated:
 * "Advanced Micro" sets 110 px in label_14 and "Meta Platforms" 105, so 128
 * holds both whole with room for the longest name the model's 24-byte field can
 * carry; and 54 px still reads as a shape, which is the whole of what a
 * sparkline is for. */
#define MK_WL_GAP             8
#define MK_WL_SYM_W          92
#define MK_WL_NAME_W        128
#define MK_WL_LAST_W        120
#define MK_WL_MARK_W         20
#define MK_WL_CHG_W         104
#define MK_WL_SPARK_W        54
#define MK_WL_SPARK_H        36

/* A GUARD, not a containment, and it is set deliberately above what the row can
 * actually reach: at the 1.6x ceiling the pitch is 99, the hairline sits at 90
 * and the sparkline computes to 73. 80 changes nothing today and still catches
 * the day somebody raises a ceiling without looking at what grows underneath
 * it. A cap that trims one pixel off the current maximum is the worst of both —
 * it alters the output now and guards almost nothing later. */
#define MK_WL_SPARK_H_MAX    80

#define MK_WL_SYM_DX          0
#define MK_WL_NAME_DX       (MK_WL_SYM_DX  + MK_WL_SYM_W  + MK_WL_GAP)      /* 100 */
#define MK_WL_LAST_DX       (MK_WL_NAME_DX + MK_WL_NAME_W + MK_WL_GAP)      /* 196 */
#define MK_WL_MARK_DX       (MK_WL_LAST_DX + MK_WL_LAST_W + MK_WL_GAP)      /* 324 */
#define MK_WL_CHG_DX        (MK_WL_MARK_DX + MK_WL_MARK_W + MK_WL_GAP)      /* 352 */
#define MK_WL_SPARK_DX      (MK_WL_CHG_DX  + MK_WL_CHG_W  + MK_WL_GAP)      /* 464 */

/* All four text fields are body_20 — the name included, which it was not.
 *
 * A row that set its symbol in a tracked display serif, the company's name in
 * the sans label face eight pixels to its right, and the two figures in the
 * serif again read as two tables spliced together, with the name column looking
 * like a caption dropped into a stock table. A symbol and a name are the same
 * class of information and belong in one family; A1's identical table sets all
 * four fields in one face and reads correctly. The width the larger face needs
 * came out of the sparkline, which is the field with the least to say.
 *
 * With one face there is nothing left to correct for, so the name hangs from
 * the same top edge as its neighbours. The sparkline is still centred on the
 * row: 12 + 18 against 19 + 11, both on the row's centre line at 30. */
#define MK_WL_TEXT_DY        19
/* The symbol and the figures are body_20 and the name is label_14, so the name
 * is dropped two pixels to centre on the same line rather than hung from the
 * same top edge — an 18 px face and a 22 px face set flush at the top read as a
 * row where one column slipped. */
#define MK_WL_NAME_DY       (MK_WL_TEXT_DY + 2)
#define MK_WL_MARK_DY       (MK_WL_TEXT_DY + 1)
#define MK_WL_SPARK_DY       12
#define MK_WL_HAIR_DY        53

/* --- band 3: the briefs ---------------------------------------------------
 *
 * The stories that did not reach A1. A1's tier engine gives its lead well and
 * its secondary row to the first three by rank and prints the rest at one line
 * in a 364 px column; here the same three get the full measure, which is the
 * difference between a headline that ellipsizes after five words and one that
 * arrives whole.
 *
 * The face is the deck's rather than a headline's, and it is chosen by measure
 * and not by rank: display_36 sets 53 characters across 924 px and the length
 * budget lets a headline run to 72, so a brief set in the headline face would
 * end in an ellipsis on a routine payload. deck_24 sets 82, which holds every
 * headline the wire can send. A brief the reader has to finish somewhere else
 * is not a brief.
 *
 * The kicker keeps a fixed slot instead of running into the headline, so three
 * briefs stacked have their headlines starting on one x — a ragged left edge
 * down three lines of the same size reads as a mistake, and the kicker is the
 * one part of a brief nobody reads in sequence anyway.
 *
 * MK_BRIEF_TIER is where A1's headline tiers stop, and on a full paper it is
 * where this column starts. It is a #define so the assertion below can hold it
 * against the model's capacity; the story the first row actually reads is
 * computed in the update, because a thin paper promotes rather than leaving a
 * hole. */
#define MK_BRIEF_TIER         3
#define MK_BRIEF_GAP         16
#define MK_BRIEF_ROW_YY(i)  (MK_BRIEF_ROW_Y + (i) * MK_BRIEF_ROW_H)
#define MK_BRIEF_KICK_X     UI_CONTENT_X                                    /*  30 */
#define MK_BRIEF_KICK_W     200
#define MK_BRIEF_TEXT_X     (MK_BRIEF_KICK_X + MK_BRIEF_KICK_W + MK_BRIEF_GAP) /* 246 */
#define MK_BRIEF_TEXT_W     (UI_CONTENT_R - MK_BRIEF_TEXT_X)                /* 924 */
#define MK_BRIEF_KICK_DY     11                         /* label_14, h 18 */
#define MK_BRIEF_TEXT_DY      6                         /* deck_24,  h 27 */

/* Where the arithmetic above is made to agree with itself. A field widened
 * without its neighbour narrowed, or a row pitch raised until the block runs
 * into the rule below it, fails here rather than on the glass.
 *
 * The first is the band table read as one chain: every band clears the rule
 * above it and stops short of the rule below it, all the way down the sheet. It
 * is stated as one assertion rather than eleven because the failure it catches
 * is always the same one — a band given more height without the bands under it
 * being moved — and eleven messages for one mistake is eleven places to look. */
_Static_assert(UI_RIBBON_RULE_Y + UI_RIBBON_RULE_W <= MK_IDX_Y
               && MK_IDX_RULE_Y + UI_RULE_HEAVY < MK_WL_HEAD_Y
               && MK_WL_HEAD_Y  + MK_WL_HEAD_H  < MK_WL_HAIR_Y
               && MK_WL_HAIR_Y  + UI_RULE_HAIR  < MK_WL_ROW_Y
               && MK_WL_RULE_Y  + UI_RULE_MID   < MK_BRIEF_HEAD_Y
               && MK_BRIEF_HEAD_Y + MK_BRIEF_HEAD_H < MK_BRIEF_HAIR_Y
               && MK_BRIEF_HAIR_Y + UI_RULE_HAIR < MK_BRIEF_ROW_Y,
               "A2's bands must descend without a band touching a rule");

/* The window. Everything this file draws is between band 4's heavy rule and the
 * hairline the folio hangs from, because everything outside it is furniture
 * that ui_news.c prints over both pages — and a page that drew into it would
 * not replace the furniture, it would smear it. */
_Static_assert(MK_IDX_Y > UI_RIBBON_RULE_Y + UI_RIBBON_RULE_W - 1,
               "A2's first band must start below band 4's heavy rule");
_Static_assert(MK_IDX_CHART_X + MK_IDX_CHART_W == UI_CONTENT_R,
               "an index row's four fields must fill the measure with three gaps");
_Static_assert(MK_IDX_ROWS == NEWS_INDEX_MAX,
               "the index board must have a row for every index the model holds");
_Static_assert(MK_IDX_HAIR_DY + UI_RULE_HAIR < MK_IDX_ROW_H
               && MK_IDX_VAL_DY + MK_IDX_VAL_H <= MK_IDX_HAIR_DY
               && MK_IDX_CHART_DY + MK_IDX_CHART_H <= MK_IDX_HAIR_DY
               && MK_IDX_CHART_GAP > 0,
               "an index row's level and chart must clear the hairline under it");
_Static_assert(MK_IDX_NAME_X + MK_IDX_GROUP_W + MK_IDX_GAP == MK_IDX_CHART_X
               && MK_IDX_NOCHART_MARK_X > MK_IDX_NAME_X + MK_IDX_NAME_W
               && MK_IDX_NOCHART_CHG_X + MK_IDX_CHG_W == UI_CONTENT_R,
               "a chartless index row must span the measure, not float in it");
_Static_assert(MK_IDX_VAL_DY + MK_IDX_VAL_H == MK_IDX_CHG_DY + MK_IDX_CHG_H,
               "an index level and its change must end on the same row");
_Static_assert(MK_IDX_Y + MK_IDX_H < MK_IDX_RULE_Y,
               "the index board must clear the heavy rule beneath it");
_Static_assert(MK_WL_SPARK_DX + MK_WL_SPARK_W == MK_WL_W,
               "a quotation row's six fields must fill three columns with five gaps");

/* The band table above, read as the flow the update actually runs. Every y in
 * it is here derived from the counts at capacity and the gaps, and the two have
 * to land on the same rows — otherwise the numbers in the table are a comment
 * about a layout that no longer happens, which is the one kind of stale
 * geometry a reader of this file cannot catch. */
_Static_assert(MK_IDX_Y + MK_IDX_H + MK_GAP_IDX_RULE == MK_IDX_RULE_Y
               && MK_IDX_RULE_Y + UI_RULE_HEAVY + MK_GAP_RULE_HEAD == MK_WL_HEAD_Y
               && MK_WL_HEAD_Y + MK_WL_HEAD_H + MK_GAP_HEAD_HAIR == MK_WL_HAIR_Y
               && MK_WL_HAIR_Y + UI_RULE_HAIR + MK_GAP_WL_HAIR_ROW == MK_WL_ROW_Y
               && MK_WL_ROW_Y + MK_WL_ROWS * MK_WL_ROW_H
                  + MK_GAP_WL_ROW_RULE == MK_WL_RULE_Y
               && MK_WL_RULE_Y + UI_RULE_MID + MK_GAP_RULE_HEAD == MK_BRIEF_HEAD_Y
               && MK_BRIEF_HEAD_Y + MK_BRIEF_HEAD_H + MK_GAP_HEAD_HAIR == MK_BRIEF_HAIR_Y
               && MK_BRIEF_HAIR_Y + UI_RULE_HAIR + MK_GAP_BR_HAIR_ROW == MK_BRIEF_ROW_Y
               && MK_BRIEF_ROW_Y + MK_BRIEF_ROWS * MK_BRIEF_ROW_H == MK_BOT,
               "the flow at capacity must land on the rows the band table states");

/* A ceiling below its own designed pitch would make mk_grow() return a pitch
 * SHORTER than the band table's, which is the one direction this page must
 * never move: the table is what a full payload sets, and a full payload has no
 * slack to be given in the first place. */
_Static_assert(MK_IDX_ROW_H_MAX >= MK_IDX_ROW_H
               && MK_BRIEF_ROW_H_MAX >= MK_BRIEF_ROW_H
               && MK_WL_ROW_H_MAX >= MK_WL_ROW_H,
               "a row's ceiling must be at least the pitch it was designed at");
_Static_assert(MK_WL_X(0) + MK_WL_W + UI_GUTTER == MK_WL_X(1)
               && MK_WL_X(1) + MK_WL_W == UI_CONTENT_R,
               "the two quotation blocks must fill the measure with one gutter");
_Static_assert(MK_WL_ROWS * MK_WL_BLOCKS == NEWS_TICKERS_MAX,
               "the two blocks of eight must hold every quote the model carries");
_Static_assert(MK_WL_SPARK_DY + MK_WL_SPARK_H <= MK_WL_HAIR_DY
               && MK_WL_HAIR_DY + UI_RULE_HAIR < MK_WL_ROW_H,
               "a quotation row's sparkline must clear the hairline under it");
_Static_assert(MK_WL_ROW_Y + MK_WL_ROWS * MK_WL_ROW_H < MK_WL_RULE_Y,
               "the watchlist must clear the rule beneath it");
_Static_assert(MK_BRIEF_TIER + MK_BRIEF_ROWS == NEWS_STORIES_MAX,
               "the briefs must carry every story A1 did not give a headline to");
_Static_assert(MK_BRIEF_ROW_YY(MK_BRIEF_ROWS - 1) + MK_BRIEF_ROW_H
               <= UI_TICKER_RULE_Y,
               "the last brief must clear the hairline the folio hangs from");

/* --- the widgets ----------------------------------------------------------
 *
 * Flat arrays of handles rather than a container per row. A sub-pane would be
 * one call to hide a row, but it would also give that row its own coordinate
 * origin — and the whole point of the numbers above is that the y in the table
 * is the y on the glass, with nothing for the simulator to undo. Hiding four
 * objects in a loop is the cheaper half of that trade. */
typedef struct {
    lv_obj_t *name, *value, *mark, *chg, *chart, *hair;
} idx_row_t;

typedef struct {
    lv_obj_t *sym, *name, *last, *mark, *chg, *spark, *hair;
} wl_row_t;

/* A block's four column heads and the hairline under them, kept because a block
 * with no quotes behind it has to take them away: SYMBOL NAME LAST CHG ruled
 * over 600 px of paper is a table that lost its contents, where nothing at all
 * is a watchlist that fitted in one column. */
typedef struct {
    lv_obj_t *sym, *name, *last, *chg, *hair;
} wl_head_t;

typedef struct {
    lv_obj_t *kicker, *head;
} brief_row_t;

static lv_obj_t *s_page;

static idx_row_t   s_idx[MK_IDX_ROWS];
static wl_head_t   s_wl_head[MK_WL_BLOCKS];
static wl_row_t    s_wl[MK_WL_BLOCKS][MK_WL_ROWS];
static lv_obj_t   *s_wl_vrule, *s_wl_rule, *s_idx_rule;
static lv_obj_t   *s_brief_head, *s_brief_hair;
static brief_row_t s_brief[MK_BRIEF_ROWS];

/* The rule that closes a page which ended before the sheet did. There is one
 * of it rather than one per block because only the last block on the page can
 * ever end short — everything above it is followed by the rule it was always
 * followed by. */
static lv_obj_t   *s_close;

/* --- the up/down mark ------------------------------------------------------
 *
 * ui_draw_tri_abs() paints one scanline at a time in a DRAW_MAIN handler, so a
 * mark needs an object to own that handler. Which of the five it is arrives as
 * the object's user data — an integer cast into the pointer rather than a
 * pointer to anything, because five marks on one page is not worth an
 * allocation and the LV_EVENT_DELETE callback that would have to free it.
 *
 * MK_MARK_NONE is "there is no change to mark", which is what an index the
 * payload did not send looks like, and it draws nothing at all.
 *
 * MK_MARK_FLAT is the session that did not move. A change of +0.00% printed
 * with a solid green triangle beside it asserts a rise that did not happen, and
 * on a column the eye scans for direction that is worse than spending the mark
 * on nothing — the reader counts a flat name as a gainer. The figure keeps the
 * colour rule (§6: a flat session is not a loss); the MARK says flat, in ink,
 * because there is no third market colour and there should not be one. */
#define MK_MARK_NONE    ((void *)0)
#define MK_MARK_UP      ((void *)1)
#define MK_MARK_DOWN    ((void *)2)
#define MK_MARK_FLAT    ((void *)3)

/* The bar the flat mark draws: a third of the box, on its centre line. */
#define MK_FLAT_H         3

static void mark_paint(lv_layer_t *L, lv_obj_t *o)
{
    void *d = lv_obj_get_user_data(o);
    if (!L || d == MK_MARK_NONE) return;

    lv_area_t a;
    lv_obj_get_coords(o, &a);
    const int w = lv_area_get_width(&a), h = lv_area_get_height(&a);
    if (w <= 0 || h <= 0) return;

    if (d == MK_MARK_FLAT) {
        const int y = a.y1 + (h - MK_FLAT_H) / 2;
        ui_draw_rect_c_abs(L, a.x1, y, a.x2, y + MK_FLAT_H - 1, true, 0, UI_INK);
        return;
    }

    ui_draw_tri_abs(L, a.x1, a.y1, w, h, d == MK_MARK_UP,
                    ui_chg_colour(d == MK_MARK_UP ? 1 : -1));
}

static void mark_draw_cb(lv_event_t *e)
{
    mark_paint(lv_event_get_layer(e), lv_event_get_target_obj(e));
}

static lv_obj_t *mark_create(lv_obj_t *par, int x, int y, int w, int h)
{
    lv_obj_t *o = ui_pane(par, x, y, w, h);
    lv_obj_set_user_data(o, MK_MARK_NONE);
    lv_obj_add_event_cb(o, mark_draw_cb, LV_EVENT_DRAW_MAIN, NULL);
    return o;
}

static void mark_set(lv_obj_t *o, bool present, int32_t bp)
{
    if (!o) return;
    lv_obj_set_user_data(o, !present  ? MK_MARK_NONE
                          : bp  < 0   ? MK_MARK_DOWN
                          : bp  > 0   ? MK_MARK_UP
                                      : MK_MARK_FLAT);
    lv_obj_invalidate(o);
}

/* --- the two figures ------------------------------------------------------
 *
 * A price is black and a change is not, and this is the only function in the
 * file that decides the second half of that. ui_internal.h's colour policy is
 * audited by grep, and a page that tinted its figures at twenty-one call sites
 * — five indices and sixteen quotations — would be a page where the audit found
 * twenty-one things to read instead of one.
 *
 * The colour is set here rather than at construction because the label outlives
 * the sign: a holding that closed up yesterday and down today is the same
 * object with a different colour, and ui_lab_c() can only say what a figure was
 * when it was built. The box comes from ui_lab_w() for the reason every box on
 * this page does — a right-aligned column of figures whose labels size
 * themselves to their own text is not a column. */
static void set_money(lv_obj_t *l, int32_t cents)
{
    char t[24];
    ui_money(t, sizeof t, cents);
    ui_set(l, t);
}

static void set_chg(lv_obj_t *l, int32_t bp)
{
    char t[16];
    ui_pct(t, sizeof t, bp);
    ui_set(l, t);
    /* ui_chg_colour(), not `bp < 0 ? UI_DOWN : UI_UP`: a flat session is not a
     * rise, and a page the board cannot vouch for prints no market colour at
     * all. Both rules live in one function so the grep audit still finds one
     * thing to read rather than twenty-one. */
    lv_obj_set_style_text_color(l, ui_chg_colour(bp), 0);
}

/* --- construction ---------------------------------------------------------- */

/* A caps label, which is most of them: the tracking is what separates a column
 * head from a word. */
static lv_obj_t *caps(lv_obj_t *par, int x, int y, int w,
                      lv_text_align_t align, const char *txt)
{
    lv_obj_t *l = ui_lab_w(par, x, y, w, UI_F_LABEL, align, txt);
    ui_track(l, MK_TRACK);
    return l;
}

static void build_indices(lv_obj_t *par)
{
    for (int i = 0; i < MK_IDX_ROWS; i++) {
        const int y = MK_IDX_ROW_YY(i);
        idx_row_t *r = &s_idx[i];

        r->name  = caps(par, MK_IDX_NAME_X, y + MK_IDX_NAME_DY, MK_IDX_NAME_W,
                        LV_TEXT_ALIGN_LEFT, "");
        /* Flush LEFT, under the name that titles it.
         *
         * It was right-aligned inside the 340 px name field, on the argument
         * that two decimal places make right alignment decimal alignment. The
         * argument is sound and the layout was not: the label above each figure
         * is flush left at x=31 and the figure hung from a right edge 340 px
         * away, so every row carried a 100-210 px hole between a label and its
         * own number, and the five left edges made a 108 px staircase down the
         * sheet — 6,412.83 starting at 158, 14.62 at 237. Five figures a hundred
         * pixels and a chart apart are not a column to be run down in one eye
         * movement; they are five headlines, and a headline sits under its own
         * kicker. A1's index panel already sets the identical component this
         * way and reads correctly. */
        r->value = ui_lab_w(par, MK_IDX_NAME_X, y + MK_IDX_VAL_DY, MK_IDX_NAME_W,
                            UI_F_LEAD, LV_TEXT_ALIGN_LEFT, "");
        r->mark  = mark_create(par, MK_IDX_MARK_X, y + MK_IDX_MARK_DY,
                               MK_IDX_MARK_W, MK_IDX_MARK_H);
        r->chg   = ui_lab_w(par, MK_IDX_CHG_X, y + MK_IDX_CHG_DY, MK_IDX_CHG_W,
                            UI_F_HEADLINE, LV_TEXT_ALIGN_LEFT, "");
        r->chart = ui_chart_create(par, MK_IDX_CHART_X, y + MK_IDX_CHART_DY,
                                   MK_IDX_CHART_W, MK_IDX_CHART_H);
        r->hair  = ui_rule(par, UI_CONTENT_X, y + MK_IDX_HAIR_DY,
                           UI_CONTENT_W, UI_RULE_HAIR);
    }
    s_idx_rule = ui_rule(par, UI_CONTENT_X, MK_IDX_RULE_Y, UI_CONTENT_W,
                         UI_RULE_HEAVY);
}

static void build_watchlist(lv_obj_t *par)
{
    for (int b = 0; b < MK_WL_BLOCKS; b++) {
        const int x = MK_WL_X(b);

        /* Four heads over five fields: the sparkline column has no name, and
         * inventing one would put a word over a picture that is already the
         * only picture in the row. */
        wl_head_t *hd = &s_wl_head[b];
        hd->sym  = caps(par, x + MK_WL_SYM_DX,  MK_WL_HEAD_Y, MK_WL_SYM_W,
                        LV_TEXT_ALIGN_LEFT,  S_COL_SYMBOL);
        hd->name = caps(par, x + MK_WL_NAME_DX, MK_WL_HEAD_Y, MK_WL_NAME_W,
                        LV_TEXT_ALIGN_LEFT,  S_COL_NAME);
        hd->last = caps(par, x + MK_WL_LAST_DX, MK_WL_HEAD_Y, MK_WL_LAST_W,
                        LV_TEXT_ALIGN_RIGHT, S_COL_LAST);
        hd->chg  = caps(par, x + MK_WL_CHG_DX,  MK_WL_HEAD_Y, MK_WL_CHG_W,
                        LV_TEXT_ALIGN_RIGHT, S_COL_CHG);
        hd->hair = ui_rule(par, x, MK_WL_HAIR_Y, MK_WL_W, UI_RULE_HAIR);

        for (int i = 0; i < MK_WL_ROWS; i++) {
            const int y = MK_WL_ROW_YY(i);
            wl_row_t *r = &s_wl[b][i];

            r->sym   = ui_lab_w(par, x + MK_WL_SYM_DX, y + MK_WL_TEXT_DY,
                                MK_WL_SYM_W, UI_F_BODY_LG, LV_TEXT_ALIGN_LEFT, "");
            /* label_14, and this is the one field on the row that is not
             * body_20 — knowingly. A reviewer asked for one family in one row
             * and the measurement says what that costs: "Advanced Micro" sets
             * 110 px in label_14 and 164 in body_20, against a 128 px field, so
             * the family that reads as one table is bought by ellipsising the
             * names the field was just widened to hold. There is nowhere to
             * take the 36 px from either — LAST holds "641,283.99" at 100 px in
             * a 120 field and CHG "-999.99%" at 87 in a 104, and 54 px is
             * already the least a sparkline can be and still be a shape. The
             * name is the field that ellipsises; it keeps the face that
             * ellipsises least. */
            r->name  = ui_lab_w(par, x + MK_WL_NAME_DX, y + MK_WL_NAME_DY,
                                MK_WL_NAME_W, UI_F_LABEL, LV_TEXT_ALIGN_LEFT, "");
            r->last  = ui_lab_w(par, x + MK_WL_LAST_DX, y + MK_WL_TEXT_DY,
                                MK_WL_LAST_W, UI_F_BODY_LG, LV_TEXT_ALIGN_RIGHT, "");
            r->mark  = mark_create(par, x + MK_WL_MARK_DX, y + MK_WL_MARK_DY,
                                   MK_WL_MARK_W, MK_WL_MARK_W);
            r->chg   = ui_lab_w(par, x + MK_WL_CHG_DX, y + MK_WL_TEXT_DY,
                                MK_WL_CHG_W, UI_F_BODY_LG, LV_TEXT_ALIGN_RIGHT, "");
            r->spark = ui_chart_create(par, x + MK_WL_SPARK_DX, y + MK_WL_SPARK_DY,
                                       MK_WL_SPARK_W, MK_WL_SPARK_H);
            r->hair  = ui_rule(par, x, y + MK_WL_HAIR_DY, MK_WL_W, UI_RULE_HAIR);
        }
    }

    /* One hairline down the gutter, from the column heads to the last row's
     * rule. Two tables side by side without it read as one table of ten
     * fields, which is exactly the misreading a quotation table cannot afford —
     * and with only one table it is a rule that divides nothing, which is why
     * the update takes it away rather than leaving it standing. */
    s_wl_vrule = ui_vrule(par, MK_WL_VRULE_X, MK_WL_HEAD_Y, MK_WL_VRULE_H,
                          UI_RULE_HAIR);
    s_wl_rule = ui_rule(par, UI_CONTENT_X, MK_WL_RULE_Y, UI_CONTENT_W, UI_RULE_MID);
}

static void build_briefs(lv_obj_t *par)
{
    s_brief_head = caps(par, UI_CONTENT_X, MK_BRIEF_HEAD_Y, UI_CONTENT_W,
                        LV_TEXT_ALIGN_LEFT, S_IN_BRIEF);
    s_brief_hair = ui_rule(par, UI_CONTENT_X, MK_BRIEF_HAIR_Y, UI_CONTENT_W,
                           UI_RULE_HAIR);

    for (int i = 0; i < MK_BRIEF_ROWS; i++) {
        const int y = MK_BRIEF_ROW_YY(i);
        s_brief[i].kicker = caps(par, MK_BRIEF_KICK_X, y + MK_BRIEF_KICK_DY,
                                 MK_BRIEF_KICK_W, LV_TEXT_ALIGN_LEFT, "");
        /* One line, ellipsized: a brief that wrapped would take the next
         * brief's row, and three briefs where the second has vanished is a
         * worse failure than one headline that ends in a dot leader. */
        s_brief[i].head = ui_lab_w(par, MK_BRIEF_TEXT_X, y + MK_BRIEF_TEXT_DY,
                                   MK_BRIEF_TEXT_W, UI_F_DECK,
                                   LV_TEXT_ALIGN_LEFT, "");
    }
}

lv_obj_t *ui_page_markets_create(lv_obj_t *par)
{
    s_page = ui_pane(par, 0, 0, UI_W, UI_H);

    /* No kicker strip, no running head, no session row and no folio: all four
     * are ui_news.c's, printed over this pane on both pages. The edition, the
     * dateline, the session, the AS OF and the UPDATED minute all reach the
     * glass from there, from the same snapshot this page is handed. */
    build_indices(s_page);
    build_watchlist(s_page);
    build_briefs(s_page);

    /* Created last so it prints over nothing, and positioned by the update:
     * where a page ends is the one row on this sheet that no table can state. */
    s_close = ui_rule(s_page, UI_CONTENT_X, MK_BOT, UI_CONTENT_W, MK_CLOSE_W);
    ui_show(s_close, false);

    ui_page_markets_update(NULL);
    return s_page;
}

/* --- update ---------------------------------------------------------------- */

static void idx_row_show(const idx_row_t *r, bool on)
{
    ui_show(r->name, on);
    ui_show(r->value, on);
    ui_show(r->mark, on);
    ui_show(r->chg, on);
    ui_show(r->chart, on);
    ui_show(r->hair, on);
}

static void wl_row_show(const wl_row_t *r, bool on)
{
    ui_show(r->sym, on);
    ui_show(r->name, on);
    ui_show(r->last, on);
    ui_show(r->mark, on);
    ui_show(r->chg, on);
    ui_show(r->spark, on);
    ui_show(r->hair, on);
}

/* --- the flow -------------------------------------------------------------
 *
 * Where every block on the page starts, computed from the counts that arrived.
 *
 * The sheet is laid top-down from MK_TOP, once, in the order the reader takes
 * it. What that costs at the designed pitches is measured first; what the window
 * has left over is then handed to the rows in the order of what a row can do
 * with it — the index board, then the briefs, then the quotation table — and
 * each stops at its ceiling. Whatever survives all three is not spent at all:
 * the page ends, s_close rules under the last row, and the rest of the sheet is
 * paper. A short paper is honest; one stretched until it reaches the foot is
 * not, and it is what a "fill the sheet" rule produces every time.
 *
 * The blocks that are absent cost nothing, lead-in included: a block with no
 * rows prints neither the heading nor the hairline nor the rule that would have
 * separated it from the one above, because a heading over nothing is the one
 * thing on a sheet that announces missing data.
 *
 * With every count at capacity the slack is zero, nothing grows, and this
 * reproduces the band table at the head of the file exactly — the
 * _Static_assert above says so. */
typedef struct {
    bool idx_on;
    int  idx_pitch, idx_rule_y;
    bool wl_on;
    int  wl_rows, wl_head_y, wl_hair_y, wl_row_y, wl_pitch, wl_w;
    bool wl_rule_on;
    int  wl_rule_y;
    bool br_on;
    int  br_head_y, br_hair_y, br_row_y, br_pitch;
    bool close_on;
    int  close_y;
} mk_flow_t;

/* Spend as much of `slack` as `n` rows can absorb before they reach `cap`, and
 * answer with the pitch that leaves. The division floors, so the remainder stays
 * in the pot for the block behind this one rather than being distributed as a
 * pixel to some rows and not others — a table whose rows differ by one pixel is
 * a table with a typo in it. */
static int mk_grow(int n, int base, int cap, int *slack)
{
    if (n <= 0) return base;

    int add = *slack / n;
    if (add > cap - base) add = cap - base;
    *slack -= add * n;
    return base + add;
}

static void mk_flow(int n_idx, int n_wl, int n_br, mk_flow_t *f)
{
    /* The left block always fills first, so its row count is the pitch for both:
     * two columns of quotations at two different pitches is not a table. */
    const int rows = n_wl > MK_WL_ROWS ? MK_WL_ROWS : n_wl;

    f->idx_on  = n_idx > 0;
    f->wl_on   = rows  > 0;
    f->br_on   = n_br  > 0;
    f->wl_rows = rows;

    /* Every rule, heading and gap the blocks that are here will print, with no
     * rows in them at all. The rows are then what divides the rest of the window
     * between MK_TOP and the hairline the folio hangs from. */
    int fixed = 0;
    if (f->idx_on) {
        fixed += MK_GAP_IDX_RULE + UI_RULE_HEAVY;
    }
    if (f->wl_on) {
        if (f->idx_on) fixed += MK_GAP_RULE_HEAD;
        fixed += MK_WL_HEAD_H + MK_GAP_HEAD_HAIR + UI_RULE_HAIR
               + MK_GAP_WL_HAIR_ROW;
    }
    f->wl_rule_on = f->br_on && (f->idx_on || f->wl_on);
    if (f->br_on) {
        if (f->wl_rule_on) {
            fixed += MK_GAP_WL_ROW_RULE + UI_RULE_MID + MK_GAP_RULE_HEAD;
        }
        fixed += MK_BRIEF_HEAD_H + MK_GAP_HEAD_HAIR + UI_RULE_HAIR
               + MK_GAP_BR_HAIR_ROW;
    }

    /* Never negative in practice — the counts are the model's capacities and the
     * capacities are what the band table was drawn around — but the arithmetic
     * below divides by a row count, and a page is not the place to find out that
     * something upstream stopped clamping. */
    int slack = MK_BOT - MK_TOP - fixed
              - n_idx * MK_IDX_ROW_H - rows * MK_WL_ROW_H
              - n_br * MK_BRIEF_ROW_H;
    if (slack < 0) slack = 0;

    f->idx_pitch = mk_grow(n_idx, MK_IDX_ROW_H,   MK_IDX_ROW_H_MAX,   &slack);
    f->br_pitch  = mk_grow(n_br,  MK_BRIEF_ROW_H, MK_BRIEF_ROW_H_MAX, &slack);
    f->wl_pitch  = mk_grow(rows,  MK_WL_ROW_H,    MK_WL_ROW_H_MAX,    &slack);

    /* And that is the whole of the growth. Whatever `slack` still holds is left
     * as paper and the page is ruled where it ends — see the note above the
     * ceilings for the second pass that used to be here and why it is not. */

    /* The same table, walked. Every y below is the running total and nothing
     * else, which is what makes the band table at the head of the file a
     * transcription of this rather than a second opinion about it. */
    int y = MK_TOP;

    f->idx_rule_y = MK_IDX_RULE_Y;
    if (f->idx_on) {
        y += n_idx * f->idx_pitch + MK_GAP_IDX_RULE;
        f->idx_rule_y = y;
        y += UI_RULE_HEAVY;
    }

    f->wl_head_y = f->wl_hair_y = f->wl_row_y = y;
    if (f->wl_on) {
        if (f->idx_on) y += MK_GAP_RULE_HEAD;
        f->wl_head_y = y;
        y += MK_WL_HEAD_H + MK_GAP_HEAD_HAIR;
        f->wl_hair_y = y;
        y += UI_RULE_HAIR + MK_GAP_WL_HAIR_ROW;
        f->wl_row_y  = y;
        y += rows * f->wl_pitch;
    }

    f->wl_rule_y = MK_WL_RULE_Y;
    f->br_head_y = f->br_hair_y = f->br_row_y = y;
    if (f->br_on) {
        if (f->wl_rule_on) {
            y += MK_GAP_WL_ROW_RULE;
            f->wl_rule_y = y;
            y += UI_RULE_MID + MK_GAP_RULE_HEAD;
        }
        f->br_head_y = y;
        y += MK_BRIEF_HEAD_H + MK_GAP_HEAD_HAIR;
        f->br_hair_y = y;
        y += UI_RULE_HAIR + MK_GAP_BR_HAIR_ROW;
        f->br_row_y  = y;
        y += n_br * f->br_pitch;
    }

    f->close_y  = y;
    f->close_on = y + MK_CLOSE_MIN <= MK_BOT;

    /* One block or two. Eight quotations fit one, and a table that stops at
     * x=588 with 582 px of paper beside it looks cropped rather than short — so
     * the single block takes the measure and the width it gains goes to the
     * chart, which is the field that has something to do with it. */
    f->wl_w = n_wl > MK_WL_ROWS ? MK_WL_W : UI_CONTENT_W;
}

/* --- placing a row at the pitch it was given -------------------------------
 *
 * Three functions, one rule between them: the two heights that move with the
 * pitch are the picture's and the hairline's, both stated as the gap they keep
 * rather than as a position so that one number drives them — and the TYPE rides
 * down by half of whatever the row grew by, so a row that was given height does
 * not leave its own line of type hanging from the top edge of it.
 *
 * (pitch - base) / 2 is nought at the designed pitch, which is what keeps a full
 * payload landing on the band table to the pixel. In a quotation row it is also
 * exact rather than approximate: the sparkline hangs from a fixed 12 and grows
 * downward, so its centre line is pitch/2 - 1 at every pitch, and the type's
 * centre — 19 + (pitch - 62)/2 + half of a 22 px face — is the same number. */
/* What a single block does with the width it was promoted to: ALL OF IT GOES TO
 * THE SPARKLINE, and the five text fields keep the widths they were measured
 * for at every table width.
 *
 * Eight quotations fit one block, so a payload with eight or fewer is laid
 * across the whole measure — 582 px more than the row was drawn for. That extra
 * was split with NAME first, and the render says the split is worse than the
 * fault it was fixing: NAME becomes 602 px wide, so "Apple" is followed by six
 * hundred pixels of paper before its own price. That river down the middle of
 * every row is precisely the defect four reviewers named in A1's widened
 * portfolio rail — the strongest dashboard tell on the sheet — and widening a
 * left-aligned field can only ever produce it.
 *
 * The shape is the one field with nothing to ellipsise and no left edge to
 * hold, so it is the one field that can take width without opening a hole in
 * the row. A1's quotation table does the same thing with the 150 px its four
 * text columns leave over. What the height does is capped separately, at
 * MK_WL_SPARK_H_MAX: a wide sparkline is a trend strip, and a TALL one is the
 * stretched diagonal that made a two-point series look like a rally.
 *
 * It is a function rather than two lines inside wl_row_place() because the
 * COLUMN HEADS have to make the same division. They did not, and the result was
 * a table whose heads said LAST at x=340 over figures at x=800: the fields
 * moved with the promotion and the four words over them stayed on the narrow
 * grid, which is the one thing a quotation table may not do. */
static void wl_share(int w, int *name_dw, int *spark_dw)
{
    int extra = w - MK_WL_W;
    if (extra < 0) extra = 0;

    *name_dw  = 0;
    *spark_dw = extra;
}

static void wl_row_place(wl_row_t *r, int x, int y, int w, int pitch)
{
    const int hair_dy = pitch - MK_WL_HAIR_GAP;
    const int text_dy = (pitch - MK_WL_ROW_H) / 2;

    int spark_dw, name_dw;
    wl_share(w, &name_dw, &spark_dw);

    int spark_h = hair_dy - MK_WL_SPARK_GAP - MK_WL_SPARK_DY;
    int spark_w = MK_WL_SPARK_W + spark_dw;
    if (spark_h < 1) spark_h = MK_WL_SPARK_H;
    if (spark_h > MK_WL_SPARK_H_MAX) spark_h = MK_WL_SPARK_H_MAX;
    if (spark_w < 1) spark_w = MK_WL_SPARK_W;

    lv_obj_set_pos(r->sym,  x + MK_WL_SYM_DX,  y + text_dy + MK_WL_TEXT_DY);
    lv_obj_set_pos(r->name, x + MK_WL_NAME_DX, y + text_dy + MK_WL_NAME_DY);
    lv_obj_set_width(r->name, MK_WL_NAME_W + name_dw);
    lv_obj_set_pos(r->last, x + MK_WL_LAST_DX + name_dw, y + text_dy + MK_WL_TEXT_DY);
    lv_obj_set_pos(r->mark, x + MK_WL_MARK_DX + name_dw, y + text_dy + MK_WL_MARK_DY);
    lv_obj_set_pos(r->chg,  x + MK_WL_CHG_DX  + name_dw, y + text_dy + MK_WL_TEXT_DY);

    lv_obj_set_pos(r->spark, x + MK_WL_SPARK_DX + name_dw, y + MK_WL_SPARK_DY);
    lv_obj_set_size(r->spark, spark_w, spark_h);

    lv_obj_set_pos(r->hair, x, y + hair_dy);
    lv_obj_set_width(r->hair, w);
}

/* An index row. `charted` is a property of the BOARD, not of this row: with a
 * chart column open the change sits beside the level in its designed slot, and
 * without one it goes to the right margin so the row spans the measure. */
static void idx_row_place(const idx_row_t *r, int y, int pitch, bool charted)
{
    const int hair_dy = pitch - MK_IDX_HAIR_GAP;
    const int text_dy = (pitch - MK_IDX_ROW_H) / 2;

    const int mark_x = charted ? MK_IDX_MARK_X : MK_IDX_NOCHART_MARK_X;
    const int chg_x  = charted ? MK_IDX_CHG_X  : MK_IDX_NOCHART_CHG_X;

    int chart_h = hair_dy - MK_IDX_CHART_DY - MK_IDX_CHART_GAP;
    if (chart_h < 1) chart_h = MK_IDX_CHART_H;

    lv_obj_set_pos(r->name,  MK_IDX_NAME_X, y + text_dy + MK_IDX_NAME_DY);
    lv_obj_set_pos(r->value, MK_IDX_NAME_X, y + text_dy + MK_IDX_VAL_DY);
    lv_obj_set_pos(r->mark,  mark_x,        y + text_dy + MK_IDX_MARK_DY);
    lv_obj_set_pos(r->chg,   chg_x,         y + text_dy + MK_IDX_CHG_DY);
    /* The change hangs from the margin it was sent to: left of its slot beside
     * the level, right of it against the trim. */
    lv_obj_set_style_text_align(r->chg,
                                charted ? LV_TEXT_ALIGN_LEFT : LV_TEXT_ALIGN_RIGHT,
                                0);

    lv_obj_set_pos(r->chart, MK_IDX_CHART_X, y + MK_IDX_CHART_DY);
    lv_obj_set_height(r->chart, chart_h);

    lv_obj_set_y(r->hair, y + hair_dy);
}

/* A brief. Nothing in it grows, so all the pitch does is lead it. */
static void brief_row_place(const brief_row_t *b, int y, int pitch)
{
    const int text_dy = (pitch - MK_BRIEF_ROW_H) / 2;

    lv_obj_set_y(b->kicker, y + text_dy + MK_BRIEF_KICK_DY);
    lv_obj_set_y(b->head,   y + text_dy + MK_BRIEF_TEXT_DY);
}

/* The rule this whole function follows: a row with nothing behind it is taken
 * away entirely, hairline included, and everything that frames the page stays
 * whatever the payload holds. The alternative — leaving the ruled grid and
 * emptying its cells — is what a printed table does, and it is wrong on a board
 * that is redrawn: a watchlist of three names under five empty ruled rows reads
 * as a page that lost thirteen quotations, not as one that was given three. */
void ui_page_markets_update(const news_t *v)
{
    if (!s_page) return;

    const int indices = v ? v->index_count : 0;
    const int quotes  = v ? v->ticker_count : 0;
    const int stories = v ? v->story_count : 0;
    const int briefs  = stories > MK_BRIEF_ROWS ? MK_BRIEF_ROWS : stories;

    mk_flow_t f;
    mk_flow(indices, quotes, briefs, &f);

    /* Whether the board has a chart column at all, which is a property of the
     * BOARD and not of a row: five rows that each decided for themselves would
     * put two of them on one x and three on another, and a stacked column of
     * levels exists to be read down with one eye movement. */
    bool charted = false;
    for (int i = 0; i < indices; i++) {
        if (v->indices[i].spark_n > 0) charted = true;
    }

    for (int i = 0; i < MK_IDX_ROWS; i++) {
        const bool on = i < indices;
        idx_row_place(&s_idx[i], MK_IDX_Y + i * f.idx_pitch, f.idx_pitch, charted);
        idx_row_show(&s_idx[i], on);
        mark_set(s_idx[i].mark, on, on ? v->indices[i].chg_bp : 0);
        if (!on) {
            ui_chart_set_spark(s_idx[i].chart, NULL, 0);
            continue;
        }
        const news_quote_t *q = &v->indices[i];
        /* Upper-cased before it is set: the slot is TRACKED, +2 px a character
         * is Franklin's caps spacing, and applied to "Nasdaq" it prints
         * N a s d a q. The name comes off the wire, so the transform is here
         * rather than in ui_strings.h with the rest of the caps. */
        char up[32];
        ui_upper(up, sizeof up, q->name[0] ? q->name : q->symbol);
        ui_set(s_idx[i].name, up);
        set_money(s_idx[i].value, q->last_c);
        set_chg(s_idx[i].chg, q->chg_bp);
        ui_chart_set_spark(s_idx[i].chart, q->spark, q->spark_n);
    }
    ui_show(s_idx_rule, f.idx_on);
    lv_obj_set_y(s_idx_rule, f.idx_rule_y);

    for (int b = 0; b < MK_WL_BLOCKS; b++) {
        /* A block with nothing in it loses its column heads too. Eight names
         * fit one block, and a watchlist of eight is a complete watchlist, not
         * half of one — printing the second block's rules over paper would say
         * the opposite. */
        const wl_head_t *hd = &s_wl_head[b];
        const bool used = quotes > b * MK_WL_ROWS;
        const int  x    = MK_WL_X(b);
        ui_show(hd->sym, used);
        ui_show(hd->name, used);
        ui_show(hd->last, used);
        ui_show(hd->chg, used);
        ui_show(hd->hair, used);

        /* The heads take the same division of the promoted width their own
         * fields do — see wl_share(). Without it the single-block table set its
         * figures at x=800 under a head that said LAST at x=340, which is a
         * quotation table with its column names on a different grid from its
         * columns. */
        int head_name_dw = 0, head_spark_dw = 0;
        if (b == 0) wl_share(f.wl_w, &head_name_dw, &head_spark_dw);

        lv_obj_set_pos(hd->sym,  x + MK_WL_SYM_DX,  f.wl_head_y);
        lv_obj_set_pos(hd->name, x + MK_WL_NAME_DX, f.wl_head_y);
        lv_obj_set_width(hd->name, MK_WL_NAME_W + head_name_dw);
        lv_obj_set_pos(hd->last, x + MK_WL_LAST_DX + head_name_dw, f.wl_head_y);
        lv_obj_set_pos(hd->chg,  x + MK_WL_CHG_DX  + head_name_dw, f.wl_head_y);
        lv_obj_set_pos(hd->hair, x, f.wl_hair_y);
        if (b == 0) lv_obj_set_width(hd->hair, f.wl_w);

        for (int i = 0; i < MK_WL_ROWS; i++) {
            /* Down the left block first and then down the right, rather than
             * across the pair: a watchlist is read in rank order, and a reader
             * following one column to its foot must not have been skipping
             * every other name to get there. */
            const int   k  = b * MK_WL_ROWS + i;
            const bool  on = k < quotes;
            wl_row_t   *r  = &s_wl[b][i];

            wl_row_place(r, x, f.wl_row_y + i * f.wl_pitch,
                         b == 0 ? f.wl_w : MK_WL_W, f.wl_pitch);
            wl_row_show(r, on);
            mark_set(r->mark, on, on ? v->tickers[k].chg_bp : 0);
            if (!on) {
                ui_chart_set_spark(r->spark, NULL, 0);
                continue;
            }
            const news_quote_t *q = &v->tickers[k];
            ui_set(r->sym, q->symbol);
            ui_set(r->name, q->name);
            set_money(r->last, q->last_c);
            set_chg(r->chg, q->chg_bp);
            ui_chart_set_spark(r->spark, q->spark, q->spark_n);
        }
    }

    /* The gutter rule divides two blocks and has nothing to divide with one. */
    if (quotes > MK_WL_ROWS) {
        ui_show(s_wl_vrule, true);
        lv_obj_set_pos(s_wl_vrule, MK_WL_VRULE_X, f.wl_head_y);
        lv_obj_set_height(s_wl_vrule,
                          f.wl_row_y + (f.wl_rows - 1) * f.wl_pitch
                          + (f.wl_pitch - MK_WL_HAIR_GAP) + UI_RULE_HAIR
                          - f.wl_head_y);
    } else {
        ui_show(s_wl_vrule, false);
    }
    ui_show(s_wl_rule, f.wl_rule_on);
    lv_obj_set_y(s_wl_rule, f.wl_rule_y);

    /* Where the briefs start reading from. Normally MK_BRIEF_TIER — the stories
     * A1 printed at one line rather than under a headline — but on a thin day
     * the column reaches further up the list rather than leaving two of its
     * three rows as paper. That is the same rule §4 of the design spec gives
     * A1: under-supply promotes, because a band that rendered nothing is a
     * failure and not an empty state. The cost is that a reader who has just
     * come from A1 sees a headline twice, which on a quiet day is what an index
     * column is for anyway. */
    const int first = stories > MK_BRIEF_ROWS ? stories - MK_BRIEF_ROWS : 0;

    ui_show(s_brief_head, f.br_on);
    ui_show(s_brief_hair, f.br_on);
    lv_obj_set_y(s_brief_head, f.br_head_y);
    lv_obj_set_y(s_brief_hair, f.br_hair_y);

    for (int i = 0; i < MK_BRIEF_ROWS; i++) {
        const int  k  = first + i;
        const bool on = i < briefs && k < stories;
        brief_row_place(&s_brief[i], f.br_row_y + i * f.br_pitch, f.br_pitch);
        ui_show(s_brief[i].kicker, on);
        ui_show(s_brief[i].head, on);
        if (!on) continue;
        ui_set(s_brief[i].kicker, v->stories[k].kicker);
        ui_set(s_brief[i].head, v->stories[k].headline);
    }

    /* And the line the page ends on, when it ends before the sheet does. */
    ui_show(s_close, f.close_on);
    lv_obj_set_y(s_close, f.close_y);
}
