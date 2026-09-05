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
 *
 * WHAT IS NO LONGER HERE
 * ----------------------
 * The eight fixed vertical bands are gone. They were a table of y values —
 * "band 5 lead package, y 318, h 782" — and every page was a transcription of
 * it, which is why every edition came out the same shape no matter what
 * arrived. A broadsheet answers a different day with a different make-up, so
 * the well below the furniture is now handed to ui_compose.h, and the only
 * fixed geometry left in this file is the furniture itself: the masthead, the
 * dateline and the tape. Those do not move, because on a real front page they
 * never do. The folio that used to close the list is gone — a sheet that is the
 * only sheet does not need to say which page it is — and the well runs to the
 * bottom margin in its place.
 *
 * The simulator's assertions moved with them. It used to check that the lead
 * rule landed on row 1108; it now checks that the day's modules tile the well
 * exactly, which is a stronger claim and one that holds for every payload
 * rather than for the three the test happens to build.
 */
#pragma once

#include <stdarg.h>
#include <stddef.h>

#include "lvgl.h"
#include "ui_chart.h"       /* ui_series_t — the pure half; see the colour note */
#include "ui_compose.h"
#include "ui_fonts.h"
#include "ui_format.h"      /* the four pure formatters; no LVGL, host-tested */
#include "ui_news.h"
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
 * Six is not arbitrary. It is what nearly every well-designed broadsheet uses,
 * and it is the number that makes the composition rules below work out: a page
 * of six divides into a one-column standing rail and a five-column body, and
 * five divides into 2+3, 3+2, 2+1+2 and 5 — which are exactly the band shapes a
 * front page wants.
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

/* The measure, and the arithmetic that makes it a rule rather than a taste.
 *
 * Over English prose ui_font_body_16 averages 8.02 px per character and
 * ui_font_body_20 averages 9.80. Divide the column spans by them and the whole
 * composition system falls out:
 *
 *          px    body_16    body_20
 *   1 col 170    21 ch      17 ch     never prose
 *   2 col 364    45 ch      37 ch     the standard leg
 *   3 col 558    69 ch      56 ch     the wide leg, and body_16's optimum
 *   4 col 752    93 ch      76 ch     body_20 only
 *
 * DO NOT TRANSCRIBE THOSE FIGURES ANYWHERE ELSE. `sim --measure` prints this
 * table for all seven faces from the committed font tables, and that command is
 * the authority; this copy exists so the reasoning below can be read without
 * running anything. Three different numbers for body_16 were in circulation at
 * once — 8.51 here, something else in docs/pages.md, a third in
 * docs/news-contract.md — because each was typed rather than generated. A face
 * regenerated at a different optical size moves every one of them.
 *
 * Typography's working range is 45 to 75 characters and its optimum is 66, and
 * newspapers legitimately set at the narrow end of it. What the table settles is
 * the bottom: a single 170 px column is twenty-one characters, about three words
 * a line, and no amount of copyfitting rescues that. So a module that sets prose
 * needs TWO columns — which is what ui_mod_t::min_cols carries — and one column
 * is for figures.
 *
 * Two columns lands on 45 exactly, which is the bottom of the working range. So
 * min_cols is a THRESHOLD and not a preference: the narrowest leg this paper
 * sets is the narrowest leg typography allows, and there is nothing below it to
 * fall back to.
 *
 * That constraint turns out to be the design. The Wall Street Journal's standing
 * rail is one column of prose; ours cannot be, so it is one column of NUMBERS
 * instead, and the company's valuation, profitability, balance sheet and
 * consensus go exactly where What's News goes. The vertical spine a front page
 * needs and the dossier this edition owes its reader are the same object. */
#define UI_MEASURE_W    UI_COL(2)                       /* 364, body_16 */
#define UI_MEASURE_LG_W UI_COL(3)                       /* 558, body_20 */

/* --- rules ----------------------------------------------------------------
 * Three weights, black, square, no radius anywhere. A fourth weight is how a
 * page starts having a visual hierarchy that the eye reads as a mistake. */
#define UI_RULE_HAIR       1
#define UI_RULE_MID        2
#define UI_RULE_HEAVY      3

/* A vrule sits in the middle of a gutter, biased left by the truncation: 11 px
 * of paper, the rule, then 12. The offset is a #define because every band
 * boundary draws one and each would otherwise open-code the same halving. */
#define UI_GUTTER_RULE_DX ((UI_GUTTER - UI_RULE_HAIR) / 2)      /* 11 */

/* --- the furniture --------------------------------------------------------
 * The three fixed strips: the masthead, the dateline under it, and the tape
 * under that. Everything below the tape is the WELL, and the well is composed.
 *
 *   strip / rule            y      h    ends   gap
 *   (air over the flag)    30      10      40     -
 *   masthead               40    112     152     6
 *     heavy rule          158      3     161     4
 *   dateline              165     20     185     6
 *     hairline            191      1     192     6
 *   tape                  198     20     218     6
 *     heavy rule          224      3     227     5
 *   THE WELL              232   1338    1570     -
 *
 * THE TEN PIXELS ABOVE THE NAMEPLATE ARE DELIBERATE. Every other strip on this
 * sheet begins where the one above it ended, and the masthead used to begin on
 * the margin itself — the blackletter's cap line sitting exactly on the 30 px
 * rule, with nothing over it. No broadsheet does that: a nameplate has air above
 * it, and without any the flag reads as having been cropped by the frame rather
 * than printed on the sheet. Ten pixels is what it costs the well, which still
 * clears the 1,250 the assertion below insists on by a wide margin.
 *
 * WHAT CAME OFF, AND WHY
 * ----------------------
 * There used to be a strip ABOVE the masthead carrying an edition slug, a state
 * badge and the date. No broadsheet has one — the New York Times and the Wall
 * Street Journal both start at the nameplate and put the date in a ruled line
 * directly beneath it — and it cost 34 px of a page whose owner wanted the space
 * spent on the company. The date moved down into the dateline row where it
 * belongs and the strip is gone.
 *
 * The tape lost 62 px in the same edit. It used to be an 82 px band setting five
 * index levels at 36 px, which is the single loudest thing a page can do and the
 * reason the sheet read as a quote screen rather than as a newspaper. The Wall
 * Street Journal prints the same information as ONE LINE of small caps under
 * its nameplate — `Last week: DJIA 39138.86 up 31.47 0.08% | NASDAQ ...` — set
 * smaller than its body text, because on a front page the tape is furniture and
 * not the story. This is that line.
 *
 * Together they gave the well 96 px, and the well is where the edition is.
 *
 * THE FOLIO CAME OFF TOO, and it is the one strip whose removal needs an
 * argument, because every newspaper has one. A folio answers "which page of
 * what am I holding, and where do I turn next" — and this paper is a single
 * sheet in a frame on a wall. There is no next page to turn to, nothing to
 * collate it with, and no second copy to tell it apart from. `A1` under a sheet
 * that is the only sheet is furniture answering a question nobody asked, and
 * the masthead, the sector and the symbol are all already on the dateline row.
 * So the thirty pixels went to the well, where the edition is.
 *
 * Nor did the folio carry a clock, and neither does anything else. The `as_of`
 * line is on the tape and says when the numbers are from, which is the honest
 * statement; a second timestamp saying when the sheet last repainted is a
 * machine's concern printed on a reader's page, and on a panel that takes
 * twenty-five seconds to repaint it reads as a demand to keep it fed. A
 * newspaper carries a date, not a clock. */
#define UI_MAST_Y             40
#define UI_MAST_H            112
#define UI_MAST_RULE_Y       158
#define UI_MAST_RULE_W       UI_RULE_HEAVY

/* The nameplate is set to fit, not to a size, and the simulator fails the build
 * if it passes 1140. */
#define UI_MAST_MAX_W        UI_CONTENT_W

/* --- the flag -------------------------------------------------------------
 * The nameplate is a MARK, a gap and a NAME, and the three are set as one
 * object and centred as one. That is why the tracking below is here, in the
 * grid, rather than next to the label in ui_news.c: the three numbers only mean
 * anything together, and `sim --measure` prints what they add up to.
 *
 * A mark beside the name rather than over it or under it, because this sheet
 * has 112 px of nameplate and no more — the strip is the skeleton both pages
 * are printed on and a crest above the name would move every rule below it. It
 * is where The Times of London puts its royal arms and the Chicago Tribune its
 * flag, which is the whole of the argument: a nameplate mark sits ON the name's
 * own line or it is a second piece of furniture.
 *
 * THE TRACKING IS MEASURED, NOT CHOSEN. UnifrakturMaguntia at 112 sets
 * S_MASTHEAD's fifteen characters at 777 px solid; at 13 they set 959, and the
 * flag comes to 61 + 28 + 959 = 1048 of the 1140 measure, leaving 46 px of paper
 * down each side. Solid it would leave 151 px a side, which reads as a poster
 * with a title on it rather than as a newspaper — letterspacing the name is what
 * a printed masthead has always done with that slack. Change S_MASTHEAD and this
 * number is wrong: run `cd sim && ./sim.sh --measure`, which prints the flag's
 * set width and what it leaves, and put the answer here.
 *
 * The mark is 61 px across against a 112 px strip, which is a shade under the
 * blackletter's cap height — a mark that matched the caps would be a second
 * nameplate, and one at label size would read as a stray tick on the paper. */
#define UI_MAST_TRACK         13
#define UI_LOGO_R             30
#define UI_LOGO_W            (2 * UI_LOGO_R + 1)         /*   61 */
#define UI_LOGO_GAP           28

/* Where the mark's CENTRE sits inside the masthead strip. Not the strip's own
 * middle: the blackletter's ascenders and its one descender are not balanced
 * about it, and a mark centred on the box sits visibly low against the name. */
#define UI_LOGO_CY            52

#define UI_DATELINE_Y        165
#define UI_DATELINE_H         20
#define UI_DATELINE_RULE_Y   191
#define UI_DATELINE_RULE_W   UI_RULE_HAIR

#define UI_TAPE_Y            198
#define UI_TAPE_H             20
#define UI_TAPE_RULE_Y       224
#define UI_TAPE_RULE_W       UI_RULE_HEAVY

/* The tape's cells are laid left to right with a fixed separator between them
 * and whatever room the strings need, rather than on an equal division: an index
 * whose name is "PHLX SEMIS" and one called "VIX" do not want the same slot, and
 * a ragged right edge on one line of furniture is what a real tape looks like.
 * The session and the as-of line bracket it. */
#define UI_TAPE_SEP_W         18
#define UI_TAPE_TRACK          2

#define UI_WELL_X       UI_CONTENT_X                    /*   30 */
#define UI_WELL_Y            232
#define UI_WELL_W       UI_CONTENT_W                    /* 1140 */
#define UI_WELL_H           1338
#define UI_WELL_B       (UI_WELL_Y + UI_WELL_H)         /* 1570, exclusive */

/* The room a band boundary needs: the rule itself plus the paper either side.
 * ui_compose() reserves this between bands and never after the last one, so a
 * page's modules and its boundaries add up to the well exactly. */
#define UI_BAND_GAP           14
#define UI_BAND_RULE_DY        6    /* the rule's y within the gap             */
#define UI_BAND_RULE_W  UI_RULE_MID

/* --- inside a module ------------------------------------------------------
 * The rows a module stacks its own furniture on. These are offsets and heights,
 * never absolute y values: a module is placed by the compositor and lays itself
 * out from wherever it landed.
 *
 * Every one of them is a MEASURED line height plus its leading, not a round
 * number. A slot sized to a round number either clips a descender or leaves a
 * gap that reads as a mistake in a stack of five. */
#define UI_MOD_KICKER_H       18    /* label_14, tracked caps                  */
#define UI_MOD_KICKER_GAP      6
#define UI_MOD_HEAD_LH_0      62    /* display_56                              */
#define UI_MOD_HEAD_LH_1      42    /* display_36                              */
#define UI_MOD_HEAD_LH_2      28    /* deck_24                                 */
#define UI_MOD_HEAD_LH_3      22    /* body_20                                 */
#define UI_MOD_HEAD_GAP       10
#define UI_MOD_DECK_LH        28    /* deck_24 italic                          */
#define UI_MOD_DECK_GAP        8
#define UI_MOD_BYLINE_H       18
#define UI_MOD_BYLINE_GAP     10
#define UI_MOD_HAIR_GAP       10    /* the hairline over a module's legs        */
#define UI_MOD_BODY_LH        22    /* body_16 at its line space               */
#define UI_MOD_BODY_LH_LG     26    /* body_20 at its line space               */
#define UI_MOD_CAP_H          18
#define UI_MOD_CAP_GAP         8
#define UI_MOD_ART_GAP        10

/* The leg gutter inside a module, and the rule down its centre. Narrower than
 * the page gutter: legs of one story are more closely related to each other
 * than two stories are, and setting them at the page gutter makes one story
 * read as two. */
#define UI_LEG_GUTTER         20
#define UI_LEG_RULE_DX  ((UI_LEG_GUTTER - UI_RULE_HAIR) / 2)

/* The end-of-story mark: a solid square set on the last line of the last leg.
 * It is set INLINE — the room comes off the measure of the final line, not off
 * the depth of the column — because a mark on a line of its own is a line of
 * white the reader reads as the column having stopped early. */
#define UI_END_SIDE            8
#define UI_END_GAP             8
#define UI_END_MEASURE(w)  ((w) - UI_END_SIDE - UI_END_GAP)

/* --- the dossier rail -----------------------------------------------------
 * One column, 170 px, and the only module on the sheet allowed to be that
 * narrow, because it is the only one that sets no prose. A figure is a caps
 * label over a value, and a group of them sits under a standing head.
 *
 * The value is set in body_20 rather than in something larger. A rail of
 * display figures competes with the lead headline for the eye, and the rail is
 * reference — it is read deliberately, by someone who has already read the
 * story, from closer than the headline was read from. */
#define UI_FIG_LABEL_H        18
#define UI_FIG_VALUE_H        26
#define UI_FIG_GAP            14
#define UI_FIG_GROUP_H        20
#define UI_FIG_GROUP_GAP       8
#define UI_FIG_GROUP_RULE_DY   6

/* --- a table --------------------------------------------------------------
 * Quarterly statements on A2, and the peer comparison on both pages. Rows are
 * ruled with a hairline rather than boxed: a grid of boxes on this panel is a
 * lot of black, and a broadsheet's tables are ruled horizontally and not
 * vertically. */
#define UI_TAB_HEAD_H         18
#define UI_TAB_ROW_H          26
#define UI_TAB_LABEL_W       160
#define UI_TAB_RULE_GAP        4

/* --- charts ---------------------------------------------------------------
 * A chart on this sheet is small and it lives inside a module, never as a band
 * of its own. The reference page for this design carries exactly one chart on
 * its front, one column wide, inside a story about the index it plots. A page
 * of charts is a terminal; a page of prose with one chart in it is a newspaper.
 *
 * The plot is what remains of the module after its caps head and its note. */
#define UI_CHART_HEAD_H       18
#define UI_CHART_HEAD_GAP      6
#define UI_CHART_NOTE_H       18
#define UI_CHART_NOTE_GAP      6
#define UI_CHART_MIN_PLOT     90
#define UI_CHART_PLOT_PREF   150

/* --- the invariants -------------------------------------------------------
 * Everything above that can be checked at compile time, is. A geometry error on
 * this panel costs twenty-five seconds to see and the build is free. */
#ifndef UI_INTERNAL_NO_ASSERTS

/* Every tile the server sends is packed two pixels to a byte, so a slot of odd
 * width or at an odd x would need a nibble-shifting blit for no reason. The
 * grid guarantees it for column spans; the well has to be checked on its own,
 * because a photograph is blitted into a module and a module is measured off
 * the well. ui_compose() carries the same rule forward to every rectangle it
 * produces, and ui_compose_check() proves it there. */
_Static_assert((UI_COL_W % 2) == 0 && (UI_GUTTER % 2) == 0
               && (UI_MARGIN % 2) == 0
               && (UI_WELL_X % 2) == 0 && (UI_WELL_Y % 2) == 0
               && (UI_WELL_W % 2) == 0 && (UI_WELL_H % 2) == 0,
               "every column span and origin must be even so a photo tile blits as a memcpy");

_Static_assert(UI_COLS * UI_COL_W + (UI_COLS - 1) * UI_GUTTER == UI_CONTENT_W,
               "the six columns and their five gutters must be the content width");

/* The furniture and the well have to tile the sheet between the margins with
 * nothing overlapping and nothing hanging past the bottom. Written as the chain
 * of gaps rather than as one sum, so a failure names the strip that moved. */
_Static_assert(UI_MAST_Y >= UI_CONTENT_Y
               && UI_MAST_Y + UI_MAST_H < UI_MAST_RULE_Y
               && UI_MAST_RULE_Y + UI_MAST_RULE_W < UI_DATELINE_Y
               && UI_DATELINE_Y + UI_DATELINE_H < UI_DATELINE_RULE_Y
               && UI_DATELINE_RULE_Y + UI_DATELINE_RULE_W < UI_TAPE_Y
               && UI_TAPE_Y + UI_TAPE_H < UI_TAPE_RULE_Y
               && UI_TAPE_RULE_Y + UI_TAPE_RULE_W < UI_WELL_Y,
               "the furniture above the well must stack without overlapping");

/* The mark sits INSIDE the masthead strip, both ends. It is drawn from a table
 * rather than measured off a font, so nothing else would notice it growing: a
 * radius one step too large puts ink through the heavy rule under the nameplate
 * and into the dateline, which the simulator would report as a broken rule
 * rather than as an oversized mark. */
_Static_assert(UI_LOGO_CY - UI_LOGO_R >= 0
               && UI_LOGO_CY + UI_LOGO_R < UI_MAST_H,
               "the nameplate's mark must sit inside the masthead strip");

/* And it has to leave a name room to set beside it. This is the assertion that
 * fires on a mark scaled up without a thought for the paper's name; the
 * simulator catches the other half — a name too long for what the mark leaves —
 * at full size, on the glass. */
_Static_assert(UI_LOGO_W + UI_LOGO_GAP < UI_CONTENT_W / 2,
               "the mark and its gap must leave the measure to the name");

/* The well now runs to the bottom margin itself, because nothing is under it.
 * Equality is the point rather than a coincidence: any slack here is paper the
 * compositor was never offered, and the whole edit was about giving it away. */
_Static_assert(UI_WELL_B == UI_CONTENT_B,
               "the well must run to the bottom margin — there is no folio under it");

/* The well is the whole point of the edit that removed the bands: if it is not
 * materially bigger than what the eight bands left, the edit bought nothing.
 * The old lead package, secondary row and ticker table came to 1190 px of
 * content between them. */
_Static_assert(UI_WELL_H > 1250,
               "the well has lost the room the furniture edit was for");

/* A band boundary's rule has to sit inside the gap the compositor reserved for
 * it, with paper on both sides. */
_Static_assert(UI_BAND_RULE_DY > 0
               && UI_BAND_RULE_DY + UI_BAND_RULE_W < UI_BAND_GAP,
               "a band rule must sit clear inside UI_BAND_GAP");

/* One dossier entry — a label over a value plus its gap — has to divide the
 * well often enough to be a rail rather than a list of four things. */
_Static_assert((UI_FIG_LABEL_H + UI_FIG_VALUE_H + UI_FIG_GAP) * 12 < UI_WELL_H,
               "the dossier rail cannot hold twelve figures in the well");

/* A one-column module is the only one that may set no prose, and the reason is
 * arithmetic rather than taste — see the measure table above. Guard the number
 * the arithmetic rests on. */
_Static_assert(UI_MEASURE_W == UI_COL(2) && UI_COL(1) == UI_COL_W,
               "the two-column measure is the narrowest that sets prose");
#endif

/* --- colour ---------------------------------------------------------------
 * White paper, black type, edge to edge. Colour on this page is not decoration,
 * it is data. There are exactly two things it is allowed to mean, and every
 * coloured pixel on the sheet answers to one of them:
 *
 *   DIRECTION — green and red on a percentage change and its ▲▼ mark, through
 *     ui_chg_colour() and nowhere else. On the tape, in the metric grid, in the
 *     peer table, and on a rate line inside a drawn statement.
 *   IDENTITY — which series a bar or a line belongs to, inside a graphic that
 *     has more than one. That is what ui_series_t below is, and the same series
 *     takes the same treatment in the plot and in the legend or the reader has
 *     to guess.
 *
 * Type is black. Rules are black. A chart's axis is black. A headline is black.
 * The test has not changed shape — "if a mark is not data, it is ink" — it has
 * gained a second kind of data, because a graphic drawn in one ink cannot say
 * which of three quantities a bar is and was making the reader read a legend
 * position instead of a colour.
 *
 * WHAT THE PANEL CAN ACTUALLY DO, which is what decides everything below.
 * WCAG contrast on gamma-corrected relative luminance, from the ink table
 * transcribed in make_tile.py. Reproduce it rather than trusting it — an
 * earlier draft of this note carried a set of figures computed from linear luma
 * and every one of them was wrong:
 *
 *     ink      hex      vs PAPER  vs BLACK   rel. luminance
 *     black    #1F2226   9.18:1    1.00:1     0.0158
 *     red      #62201E   6.92:1    1.33:1     0.0372
 *     blue     #233F8E   5.56:1    1.65:1     0.0587
 *     green    #35563A   4.75:1    1.93:1     0.0772
 *     ------------------------------------------------ the cliff
 *     screen   1-in-3    1.42:1    6.46:1     0.3744
 *     yellow   #C1BB1E   1.16:1    7.90:1     0.4697
 *     paper    #B9C7C9   1.00:1    9.18:1     0.5538
 *
 * THE INKS ARE TWO BANDS, NOT A LADDER, and that is the fact the whole series
 * design turns on. Four inks cluster at the dark end and three options at the
 * light end, with a factor of five between the clusters and NOTHING in between.
 * Inside a band, value is very nearly useless:
 *
 *     blue vs green 1.17:1     screen vs yellow 1.22:1
 *     blue vs black 1.65:1     screen vs paper  1.42:1
 *
 * So a graphic gets two clean steps of value and no more. Every series past the
 * second separates by HUE (blue against black is 1.65:1 in value and
 * unmistakably blue) or by TEXTURE (a 1-in-3 screen against flat paper is
 * 1.42:1 and obviously striped). Two series sharing a band, a hue and a texture
 * are one series to a reader, whatever the legend claims.
 *
 * Yellow does not work on paper. It is not a weak colour there, it is very
 * nearly no colour at all: a yellow bar reads as the outline of a bar. Against
 * black, though, yellow is 7.90:1 — the best pair the panel has after black on
 * paper. So yellow is legal only enclosed by a black keyline, which is what
 * UI_SERIES_KEYED draws and why it draws it as one call rather than leaving a
 * caller to remember. The simulator fails the build on a yellow pixel that can
 * reach paper without crossing black, so the rule is structural in two
 * independent places.
 *
 * Blue is excellent against paper and near-invisible against black, so blue
 * earns its place by HUE and not by value: it is the line over black bars, or a
 * bar with a gutter beside it, never the neighbouring segment of a stacked bar.
 * ui_series_at() encodes that; do not hand-pick a treatment around it.
 *
 * All of these are exact palette entries, so they take wp_quantize()'s identity
 * path and come out flat — a colour anywhere between two inks would dither, and
 * a dithered hairline is a dashed one.
 *
 * They expand to a call, not to a constant: lv_color_hex() builds the colour at
 * runtime, so these go in a statement and not in a file-scope initializer. */
#define UI_INK          lv_color_hex(WP_RGB_BLACK)
#define UI_PAPER        lv_color_hex(WP_RGB_WHITE)
#define UI_UP           lv_color_hex(WP_RGB_GREEN)
#define UI_DOWN         lv_color_hex(WP_RGB_RED)
#define UI_SERIES_BLUE_C lv_color_hex(WP_RGB_BLUE)
#define UI_SERIES_KEYED_C lv_color_hex(WP_RGB_YELLOW)

/* The keyline that makes yellow legal, in pixels. Two, not one: a one-pixel
 * black edge around a 1.10:1 fill is a hairline holding back an area, and the
 * first time the panel's registration is half a pixel out on one side the fill
 * touches paper. Two survives that. */
#define UI_SERIES_KEY_W 2

/* The smallest box ui_series_fill() will draw a KEYED or OPEN treatment in.
 * Below it the two keylines meet and the fill disappears, so a caller that
 * cannot afford this must ask for fewer series rather than a thinner bar. */
#define UI_SERIES_MIN_PX (2 * UI_SERIES_KEY_W + 2)

/* Colour is data, and a figure the board cannot vouch for is not data. When the
 * snapshot is stale or the board is offline, every change figure and every mark
 * on both pages prints in ink instead: the alternative is a page of prices in
 * the colour reserved for live movement, asserting in the loudest way the sheet
 * has that it is current, with one word at the top saying otherwise.
 *
 * Every call site that decides a change's colour goes through this rather than
 * through `bp < 0 ? UI_DOWN : UI_UP`, and zero is INK at every state: a flat
 * session is not a rise, and a solid green triangle beside +0.00% makes a reader
 * scanning a column for direction count it as a gainer.
 *
 * Defined in ui_news.c, which is where the link state arrives. */
bool       ui_data_live(void);
lv_color_t ui_chg_colour(int32_t bp);

/* --- fonts ----------------------------------------------------------------
 * The roles, not the faces: a page asks for "a deck" and gets whatever
 * ui_fonts.h currently sets a deck in. Every text face covers ASCII, Latin-1
 * and S_DATA_PUNCT, so any of them can draw any string the network sends.
 *
 * There is no separate numeral face, so the tape's index levels are set in
 * UI_F_LABEL and the dossier's figures in UI_F_BODY_LG. That is not a
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

/* The headline face for one of ui_head_weight()'s four steps, and the line
 * height that goes with it. Two calls rather than one table because the caller
 * needs them in different places — the face when it sets the label, the line
 * height when it measures the module before the label exists. */
const lv_font_t *ui_head_font(int weight);
int              ui_head_lh(int weight);

/* --- shapes ---------------------------------------------------------------
 * All coordinates are relative to `par`. Every one of these returns an object
 * that is non-scrollable, non-clickable, square-cornered and un-themed. */

/* An invisible container. Use it to group a section so the whole thing can be
 * shown or hidden in one call. */
lv_obj_t *ui_pane(lv_obj_t *par, int x, int y, int w, int h);

/* A solid black rectangle — filled chips, the end-of-story square. */
lv_obj_t *ui_fill(lv_obj_t *par, int x, int y, int w, int h);

/* Paint `s`'s treatment into a rectangle: the one call that puts a series
 * identity on the glass in WIDGET form. Its immediate-mode twin is
 * ui_series_draw_abs() below, and between them they are the whole surface —
 * see there for why there are two and why the invariant names ui_common.c
 * rather than either function.
 *
 * It is a call and not a colour because two of the five treatments are not one
 * colour. A KEYED fill is a black rectangle with a yellow one inset by
 * UI_SERIES_KEY_W, and a SCREEN fill is a run of hairlines — returning
 * lv_color_t and letting callers fill with it would put an unkeylined yellow on
 * paper the first time somebody reached past this function, which is exactly
 * the failure the colour note above says is structurally prevented.
 *
 * Boxes narrower or shorter than UI_SERIES_MIN_PX fall back to SOLID rather
 * than drawing a keyline with nothing inside it. That is a silent substitution
 * on purpose: it happens per bar, deep inside a plot, and the alternatives are
 * a chart with a hole in it or an assert on a device that must not stop. The
 * caller that cares picks a series count its bars can carry — ui_series_at()
 * is the function that knows how. */
void ui_series_fill(lv_obj_t *par, int x, int y, int w, int h, ui_series_t s);

/* The legend swatch for `s`, UI_SERIES_SWATCH px square. Separate from
 * ui_series_fill() only so that every legend on both sheets is the same size
 * without each caller carrying the number. */
#define UI_SERIES_SWATCH 14
lv_obj_t *ui_series_swatch(lv_obj_t *par, int x, int y, ui_series_t s);

/* The same five treatments drawn IMMEDIATELY into a layer, in absolute
 * coordinates with x2/y2 inclusive — the house convention, shared with
 * ui_draw_rect_c_abs() below.
 *
 * Two forms of one thing, and the split is not redundancy. A drawn statement's
 * plot is a display list transcribed in a LV_EVENT_DRAW_MAIN handler, not a
 * widget tree, and ui_modules.c's standing rule is that nothing there is
 * created in an update. The widget form cannot serve it at any acceptable
 * price: a SCREEN treatment built as objects is one object PER HAIRLINE, so a
 * 200 px bar is about sixty-six of them and a six-period stack with one
 * screened series is some four hundred created and destroyed on every poll, on
 * a board where a poll is supposed to be free when nothing changed.
 *
 * The invariant the colour note claims is therefore NOT "ui_series_fill() is
 * the only place blue or yellow comes from" — it is that **ui_common.c** is,
 * and these two calls are its whole surface. Both honour the keyline, both
 * honour the UI_SERIES_MIN_PX floor, and the simulator's yellow-on-paper check
 * has one implementation to audit rather than two.
 *
 * Legend swatches inside a plot use THIS call at UI_SERIES_SWATCH px square
 * rather than ui_series_swatch(), which is also what makes a legend entry and
 * its bars provably the same drawing rather than two drawings that agree. */
void ui_series_draw_abs(lv_layer_t *L, int x1, int y1, int x2, int y2,
                        ui_series_t s);

/* SEALING A KEYED FILL AGAINST A MARK DRAWN ACROSS IT, which is the other half
 * of "yellow is legal only inside a black keyline" and the half that is easy to
 * lose. The keyline above is a fact about the pixels when they were laid down;
 * a graphic that draws a rate line over its bars afterwards — in colour, under
 * a paper halo, because paper is the only thing that separates that line from a
 * black bar — erases the keyline where it crosses and leaves paper against the
 * yellow. That is a real sheet and not a hypothetical: see ui_common.c.
 *
 * Lay the sleeve down BEFORE the mark and its halo, once per keyed fill the
 * mark can reach: the same shape, UI_SERIES_KEY_W wider on every side, in ink,
 * clipped to `fill` so nothing changes anywhere the mark is not over yellow.
 * `w` is the width of the WIDEST pass the caller will draw — the halo, not the
 * line inside it — and `fill` is the keyed rectangle in the same absolute
 * coordinates, x2/y2 inclusive, as ui_series_draw_abs() was given.
 *
 * The line form clips its SPANS rather than its endpoints, so a sleeve cannot
 * poke half its width out of the bar it belongs to. The rect form is for the
 * marks a plot puts on its line: the nodes, and the direction arrow. */
void ui_series_sleeve_line_abs(lv_layer_t *L, const lv_area_t *fill,
                               int x1, int y1, int x2, int y2, int w);
void ui_series_sleeve_rect_abs(lv_layer_t *L, const lv_area_t *fill,
                               int x1, int y1, int x2, int y2);

/* A polyline's ink for series `s`, for the immediate-mode chart draw, which
 * strokes rather than fills and so cannot use ui_series_fill(). KEYED and OPEN
 * have no stroke form — yellow cannot be a line on paper and paper cannot be a
 * line at all — and both return black; a caller wanting more than two stroked
 * series has run out of panel and needs to say so with shape instead. */
lv_color_t ui_series_stroke(ui_series_t s);

/* A white rectangle with a black border of `bw` px. */
lv_obj_t *ui_frame(lv_obj_t *par, int x, int y, int w, int h, int bw);

/* A horizontal rule of `weight` px, and a vertical one of `weight` px. Every
 * band boundary draws at least one, and they exist as their own call rather
 * than as ui_fill() so that the three legal weights are the only thing a caller
 * can pass and the simulator has one shape to look for. */
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
 * heights means exactly "at most n lines" — which is how a headline is given
 * three and its deck two without either being able to take a third from the
 * module beneath it. */
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

/* ui_upper() — ASCII and Latin-1 upper case, into `out` — is declared in
 * ui_format.h with the other three pure formatters. ui_track() is letterspacing
 * cut for Franklin's CAPS, and applied to lower case it takes a word apart —
 * "N a s d a q" beside a correctly tracked "S&P 500" in the same row. Several
 * tracked slots on this sheet take a string the network wrote, so those
 * uppercase it first. */

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

/* --- text -----------------------------------------------------------------
 *
 * ui_group_int(), ui_money(), ui_pct() and ui_upper() are in ui_format.h,
 * included at the top of this file so every call site here is unchanged. They
 * are the four things this header declares that need no LVGL, which is why they
 * are their own file and their own host test.
 */

/* --- the language the edition is written in -------------------------------
 *
 * There is no accessor here, deliberately, and this note stands where one used
 * to. The fixed strings the board prints beside the copy follow the payload's
 * `lang`, and nothing else on the sheet does: everything a reader looks at
 * arrived already written in that language. So every draw site takes the table
 * from the snapshot it was handed — ui_lang(v->lang) for the words,
 * ui_fit_script(v->lang) for the break rule — and the renderers stay a function
 * of their argument alone, which is what ui_compose.h's purity and
 * news_hash()'s "same fingerprint, same pixels" both rest on.
 *
 * A board with no snapshot has no language, and ui_lang(NULL) is English: the
 * setup sheet, the no-data page and everything drawn before the first fetch are
 * the board talking about itself. That is the same reason the masthead and the
 * no-payload dateline stay English in every edition.
 *
 * ui_lang() itself is declared in ui_strings.h, beside the tables. */

/* --- the pages ------------------------------------------------------------
 * Two pages, and KEY0 toggles them. Each is one file and obeys the same
 * two-call contract: create() builds a pane covering the WHOLE sheet and
 * returns it (the router shows and hides it), update() rewrites its widgets
 * from a snapshot and touches nothing else. A NULL snapshot means "blank
 * yourself" — which on a front page means an empty page, not a placeholder,
 * because the demo snapshot is what an unconfigured board shows.
 *
 * BOTH PAGES ARE COMPOSED, and that changes what create() can do. It used to
 * build every widget at its final coordinates, because the coordinates were in
 * this header; now they are not known until a snapshot arrives, so create()
 * builds the pool and update() places it. A widget that is not used by the
 * day's make-up is hidden rather than freed — LVGL object churn on every poll
 * is how a long-running board fragments its heap.
 *
 * The pane is full-bleed rather than inset because the furniture above is in
 * panel coordinates: a page positions a child at UI_MAST_Y and that is where it
 * lands, with no origin to remember and no second frame of reference for the
 * simulator to have to undo.
 *
 * Nothing in a page file talks to the panel, keeps state beyond its widgets, or
 * knows which page is on screen. */
lv_obj_t *ui_page_front_create(lv_obj_t *par);
void      ui_page_front_update(const news_t *v);

lv_obj_t *ui_page_markets_create(lv_obj_t *par);
void      ui_page_markets_update(const news_t *v);

/* What the day's make-up came out as, for the simulator to assert on. Both
 * pages record their last composition here; the simulator reads it back and
 * checks the tiling rather than checking that a rule landed on a row it can no
 * longer predict. Returns the module count and points `mods` at the array.
 *
 * It is a debugging seam and the firmware never calls it, but it is not behind
 * an #ifdef: a seam that is only compiled in the simulator is a seam that is
 * only correct in the simulator. */
int ui_page_layout(ui_page_t page, const ui_mod_t **mods, ui_compose_env_t *env);

#ifdef __cplusplus
}
#endif
