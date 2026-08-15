/*
 * ui_compose.h — the make-up desk: where the day's modules land on the sheet.
 *
 * The page is not a fixed set of bands any more. Every edition brings a
 * different amount of copy, a photograph or none, one chart or two, four
 * related items or eight — and a broadsheet answers that by changing its
 * shape, not by leaving a hole. This file is the part that changes the shape.
 *
 * GUILLOTINE, AND WHY IT IS THE WHOLE SAFETY ARGUMENT
 * ---------------------------------------------------
 * A free compositor can produce an ugly page. This one cannot, because it can
 * only make GUILLOTINE cuts: every cut runs edge to edge across the rectangle
 * it divides. Take the Wall Street Journal's front page apart and that is what
 * is already there — a vertical cut separating the standing rail from the body,
 * horizontal cuts dividing the body into bands, vertical cuts dividing each
 * band into stories. The photo-and-lead package and the column beside it end on
 * exactly the same line, because they are the two halves of one cut.
 *
 * Restricting the compositor to those cuts buys three properties for free,
 * rather than as tests that might not have been written:
 *
 *   - every module is a rectangle, so there are no doglegs and no L-shaped
 *     wraps around a photograph;
 *   - the modules tile the well exactly — no overlap, and no white hole at the
 *     foot of the page. Where a region holds nothing elastic, the surplus
 *     becomes LEADING BETWEEN THE BANDS rather than height inside them, so a
 *     band gap may exceed `band_gap`; nothing else may. A quiet page with air
 *     between its bands reads as a quiet page, where the same air distributed
 *     inside a table reads as a defect;
 *   - a module's neighbours are known, so the rules that are about neighbours
 *     (a vertical rule between them, no two abutting headlines in the same
 *     face) have somewhere to be enforced.
 *
 * That leading rule is deliberately narrow, and the narrowness is the point. A
 * gap wider than `band_gap` is legal ONLY between two inelastic modules, which
 * is exactly the condition the fit creates it under. Accepting any wide gap
 * would turn the coverage assertion into "a hole is fine" and throw away most of
 * what it is for; a hole between two stories still fails immediately.
 *
 * WHAT THIS DOES NOT SOLVE
 * ------------------------
 * The pane cut took the common case away. A tall module beside a short one used
 * to leave the short one's surplus sitting inside a ruled box; now something
 * else from the day's file stacks underneath it instead.
 *
 * What is left is the file with nothing tall in it. Stacking needs an ANCHOR —
 * a module deep enough that another can be set whole in the room it leaves — so
 * a day on which everything is short has nothing to stack against, and the
 * surplus still goes either into leading between the bands or, when there is
 * only one band, into that band. Relocating white is not removing it.
 *
 * That residue is not a compositor problem and no further cut fixes it: a well
 * taller than everything the day filed is a well taller than everything the day
 * filed, and the guillotine has nothing left to divide. The answer is upstream,
 * in what the PAGE puts in the list — on a day with no stories it should compose
 * a different, deliberately smaller set of larger modules, the way this paper's
 * quiet-day front page has always been a legitimate page rather than a normal
 * one with the copy removed.
 *
 * The variety comes from the cut TREE, which is chosen from what arrived. It
 * does not come from relaxing the cuts.
 *
 * THE CLASS BALANCE — WHAT THE PAGE IS MADE OF, NOT JUST HOW IT IS CUT
 * -------------------------------------------------------------------
 * Everything above is about SHAPE. None of it stops a day whose file happens to
 * carry three charts, two statements and one short story from tiling the well
 * perfectly with graphics. That page passes every assertion in this file and is
 * not a front page: this paper is a newspaper of words and photographs with
 * figures in it, and the owner's constraint is that the front page reads that
 * way whatever arrives.
 *
 * So the modules divide into two CLASSES, and on a page that asks for it the
 * prose class must hold a stated share of the ink:
 *
 *   PROSE   UI_MOD_LEAD, UI_MOD_STORY, UI_MOD_BRIEFS, UI_MOD_QUOTE and
 *           photographs (UI_MOD_THUMBS; a lead's art is inside its own module)
 *   FIGURE  UI_MOD_CHART, UI_MOD_TABLE, UI_MOD_PEERS, UI_MOD_DOSSIER
 *
 * `ui_compose_env_t::prose_pct` is the share, and it is the CALLER'S, not this
 * file's: A1 is a text-and-photograph sheet and A2 is the accounts and is
 * allowed to be figure-led, and the compositor has no business knowing which
 * page it is making up. Zero turns the whole mechanism off, which is what a page
 * that has no opinion gets.
 *
 * Measured over the PLACED modules, as area, against the ink rather than
 * against the well: `prose / (prose + figure)`. Bare paper between two inelastic
 * bands is neither class, and counting it against prose would make the rule fire
 * on exactly the page the leading rule above created on purpose — and firing
 * there would DROP A FIGURE to fix a hole, which makes the hole bigger. The
 * balance is a claim about the two classes and nothing else.
 *
 * SEE UI_PROSE_MAJORITY for the number and where it comes from.
 *
 * The enforcement is a drop, because ui_compose() is total and a breach may not
 * become a failure: the lowest-ranked FIGURE leaves the page and the sheet is
 * made up again, until the share is met or there is nothing left that may go.
 * LOWEST-RANKED ACROSS THE WHOLE PAGE — the modules are in rank order and the
 * last droppable one in that order is the victim, which is the same rule
 * over-supply already drops by. Taking it per pane instead would throw away a
 * lower rank than something still standing in the pane beside it.
 *
 * TWO THINGS ARE PROTECTED, and both are the same protection said twice.
 *
 * The rule applies only to a page that filed PROSE AT ITS BEST RANK. A day that
 * ranked a figure ahead of everything it wrote is a day with no news about the
 * company — this paper's quiet-day front page, which is a legitimate sheet
 * rather than a normal one with the copy removed, and which is deliberately the
 * dossier set as large as a headline with the chart beside it. Overruling that
 * would mean dropping the modules that ARE the page to satisfy a rule about a
 * page that does not exist. It cannot be met there and it does not apply there.
 *
 * And within a page it does apply to, only a figure ranked STRICTLY WORSE than
 * that best rank may be dropped. On a day with stories the best rank is the
 * lead's, and the standing rail shares it, so the rail is never what leaves:
 * the rail is the page's spine by design, and a compositor that removed it to
 * improve an area ratio would be overruling the editorial judgement that put it
 * there. What leaves is the third chart and the fourth table, which is what the
 * rule is for.
 *
 * THE HONEST EDGE. On a page the rule does apply to, dropping everything
 * droppable may still not reach the share — a day with one short story, a rail
 * and nothing else. Then every droppable figure is gone and the page is composed
 * from what is left, short of the threshold. That is deliberate and it is the
 * end of the line: the compositor cannot write copy, and a sheet that is prose
 * and a rail is the shape the owner asked for even when it is a thin one. The
 * white paper such a page then carries is a real defect, and it is the PAGE's —
 * see WHAT THIS DOES NOT SOLVE, which says the same thing about the same day.
 *
 * ui_compose_check() holds the postcondition rather than the threshold, because
 * the postcondition is the whole claim and it is exact: on a page that enforces
 * the balance and filed prose at its best rank, either the share is met or no
 * droppable figure is still standing.
 *
 * THE SHAPE OF THE TREE
 * ---------------------
 * Deliberately shallow. Three levels cover every arrangement the reference
 * pages actually use, and a deeper tree buys arrangements no one wants:
 *
 *      well
 *       |
 *       +-- H-cut under the BANNER, when one module asked for it. The banner is
 *       |   alone on a full-measure band across the top and the rail begins
 *       |   below it. See `banner`.
 *       |
 *       +-- H-cut at the rail's foot, ONLY when the rail is shorter than the
 *       |   well (a thin file on a quiet day). Otherwise there is one region.
 *       |
 *       +-- upper region
 *       |     +-- V-cut: [ rail, 1 column ] [ body, the rest ]
 *       |           +-- body: H-cuts into bands
 *       |                 +-- band: V-cuts into 1..3 PANES
 *       |                       +-- pane: one module, or an H-cut stack of them
 *       |
 *       +-- lower region (full width)
 *             +-- H-cuts into bands, each V-cut into panes
 *
 * THE PANE IS THE LEVEL THAT MAKES THE PAGE STOP BEING STRIPES
 * ------------------------------------------------------------
 * Without it every module in a band shares the band's height, and a page built
 * only from those can come out one way: a stack of horizontal strips, with
 * nothing on it tall and narrow. Put a story that wants 900 px beside one that
 * wants 300 and both answers are wrong — level them to 900 and the short one is
 * 600 px of paper inside a ruled box, level them to 300 and the long one is cut
 * off in its prime.
 *
 * So a pane may be cut horizontally and hold a short stack:
 *
 *     [ tall story  | short module ]
 *     [ 2 cols      |--------------]
 *     [ 900 px      | short module ]
 *
 * It is still a guillotine cut and still edge to edge inside the rectangle it
 * divides, so it costs nothing from the safety argument above.
 *
 * The compositor decides this itself, out of the heights it already asked for,
 * and the page gets no say — there is no field to set. The rule is not a ratio:
 * a module is pulled forward into a pane only when it can be set WHOLE in the
 * room the anchor leaves. The ratio falls out of that (something has to be
 * about twice its neighbour before a second item fits under it) rather than
 * being asserted, so it stays right when the fonts or the furniture move.
 *
 * The banner is still a guillotine cut and still edge to edge, so it costs none
 * of the safety above. What it buys is the one shape the rail made impossible:
 * a photograph and a headline across the whole measure with the story running
 * down under them in four narrow legs, which is what the front page of a
 * broadsheet looks like when the day has one story on it worth the whole page.
 * With a rail pinned to the left for the full height, every package on the
 * sheet was 5 columns wide and none of them could be deep — the page could only
 * ever come out in horizontal slices.
 *
 * PURE GEOMETRY
 * -------------
 * Nothing here knows what a headline is. A module reports how tall it wants to
 * be at a given width through `measure`, and that callback is the page's — so
 * this file compiles and is tested on the host with no LVGL at all, against a
 * measure function the test writes itself. Every decision about WHERE ink goes
 * is here; every decision about WHAT ink is drawn is in the page.
 *
 * DETERMINISM IS NOT OPTIONAL
 * ---------------------------
 * news_hash() promises that two snapshots with the same fingerprint produce the
 * same pixels, and the device skips a twenty-five-second refresh on the
 * strength of it. So ui_compose() must be a pure function of its inputs: no
 * clock, no random, no iteration over a hash table. Same modules in, same
 * rectangles out, on both x86 and Xtensa.
 *
 * Portable: no LVGL, no ESP-IDF.
 */
#pragma once

#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

/* More than a page can hold, which is the point — the compositor edits. */
#define UI_MOD_MAX 16

/* THE NUMBER, AND IT IS WRITTEN DOWN ONCE.
 *
 * Three quarters of a front page's ink is prose and photographs. It is not a
 * round number picked because it sounds like a majority; it is what is left of
 * the reference page after this design's own two substitutions, and it was
 * checked against the sheets the typesetter actually produces before it was
 * fixed.
 *
 * DERIVED. Take the front page of 1 July 2024 apart the way §1 of the design
 * note does and there are nine modules, of which eight are stories, digests or
 * pictures. The single figure-class element on the whole sheet is one chart, set
 * inside a one-column story — under a twentieth of the page. Call the reference
 * 95 % prose class; the exact figure does not matter, because what follows
 * subtracts from it and the subtractions are exact.
 *
 * This design converts one of those eight modules from prose to figures on
 * purpose. §2: a one-column leg is twenty characters, so the Journal's standing
 * rail of prose cannot be ours, and it is one column of NUMBERS instead. That
 * column is a sixth of the measure and runs the well, so the substitution alone
 * moves 16.7 % of the sheet across the line.
 *
 * And A1 owes the reader the day's price action, which the reference page does
 * not have to carry. A chart that is not the page — "a page of charts is a
 * terminal; a page of prose with one chart in it is a newspaper" — is at most a
 * pane of a band: two columns of six, a quarter of the well's height, 8.3 %.
 *
 *     95 % − 16.7 % − 8.3 % = 70 %, and the rail is 16.7 % only when it runs the
 *     whole well, which a banner day cuts short.
 *
 * MEASURED, on the demo edition, with the two classes taken as area over the
 * placed rectangles:
 *
 *     A1, full payload      80.2 %   the sheet nobody objected to
 *     A1, sparse payload    54.6 %   the sheet the owner called garbage
 *     A1, quiet day         30.0 %   no prose filed at all; the rule cannot apply
 *     A2, full payload      48.2 %   the accounts, figure-led on purpose
 *
 * So the line has to sit above 54.6 and below 80.2, and the derivation puts it
 * at 70–75. SEVENTY-FIVE, because the top of that range is the one that leaves
 * the good page room to move: at 75 the full sheet may grow its figure class by
 * another 99,000 px — two more modules the size of the industry table — before
 * the rule touches it, where a threshold at 80 would fire on the page as it
 * stands today. A rule that fires on the sheet it was calibrated against is a
 * rule that has been fitted to noise.
 *
 * FIFTY-FIVE WAS PROPOSED AND IS WRONG, and the arithmetic is the reason rather
 * than taste: the sparse sheet measures 54.6 %, so a threshold of 55 would pass
 * or fail the exact page this rule exists to prevent on a coin toss, and any
 * payload a fraction wordier would sail through it. A majority is not the test.
 * The page has to READ as words and pictures from across a room, and a sheet
 * that is 45 % graphics reads as a graphics sheet with captions. */
#define UI_PROSE_MAJORITY 75

typedef enum {
    UI_MOD_NONE = 0,
    UI_MOD_LEAD,      /* the dominant story: kicker, head, deck, byline, art, legs */
    UI_MOD_STORY,     /* a story: kicker, head, byline, one or two legs            */
    UI_MOD_DOSSIER,   /* the figure rail — the one module allowed a single column  */
    UI_MOD_CHART,     /* a chart with its caps head and its one line of note       */
    UI_MOD_BRIEFS,    /* the dated one-liners                                      */
    UI_MOD_PEERS,     /* the industry comparison                                   */
    /* A statement — PRINTED as a grid of figures or DRAWN as bars, according to
     * the table's own `render`. One kind and not two on purpose: which of the
     * two a set of numbers deserves is the producer's judgement and travels
     * with the numbers, and nothing about WHERE the module goes changes with
     * the answer. The compositor never learns there was a choice. */
    UI_MOD_TABLE,
    UI_MOD_THUMBS,    /* the small pictures at the foot, with their captions       */
    UI_MOD_QUOTE,     /* one sentence pulled out and set large                     */
    UI_MOD_KIND_COUNT,
} ui_mod_kind_t;

/* One thing that wants to be on the page.
 *
 * The caller fills everything above the line and reads everything below it. A
 * module that did not fit comes back with `placed` false and must not be drawn;
 * it is not an error, it is the day's page being one item shorter than the
 * day's file.
 *
 * `min_cols` carries the one typographic fact the geometry has to know: a
 * module that sets prose needs TWO columns, and it is a THRESHOLD rather than a
 * preference.
 *
 * Two columns is 364 px, which at ui_font_body_16's prose advance is 45
 * characters — the bottom of typography's 45-to-75 working range, exactly. So
 * the narrowest leg this paper sets is the narrowest leg typography allows, and
 * there is nothing below it to fall back to. One 170 px column is 21
 * characters, about three words a line, and no amount of copyfitting rescues a
 * leg that narrow: one column is for figures, and that is exactly what the
 * dossier rail is.
 *
 * The decision does not depend on which advance you measure, which is worth
 * saying out loud because it makes the constraint robust rather than lucky. One
 * column comes out 21 characters on the prose mean, 20 on the 8.51 this comment
 * used to quote, and 18 on the ASCII mean — every one of them far under 45, so
 * `min_cols == 2` is not a number that could tip.
 *
 * Run `sim --measure` for the advances; it reads them out of the committed font
 * tables. Do not transcribe them here or anywhere else. Three different figures
 * for body_16 were in circulation at once precisely because each site typed its
 * own, and this comment was one of the three.
 *
 * `weight` is how much copy the module brought, in whatever unit the caller
 * likes; only the ratios matter. It decides who gets the spare columns when a
 * band's minimums do not add up to the pane, which is how a story with 700
 * bytes of body ends up four columns wide and the one with 200 ends up two. */
typedef struct {
    ui_mod_kind_t kind;
    int  src;          /* index into the payload array for this kind          */
    int  rank;         /* lower is more important; the compositor drops from  */
                       /* the back, so rank is also the order they are packed */
    int  min_cols;     /* 1 only for UI_MOD_DOSSIER and UI_MOD_CHART          */
    int  max_cols;     /* 0 = no ceiling                                      */
    int  weight;       /* relative appetite for the spare columns             */
    bool elastic;      /* true if its body absorbs slack (a story) rather     */
                       /* than sitting at a fixed height (a picture, a table) */

    /* Asks to run across the WHOLE measure on a band of its own at the top of
     * the well, with the rail starting underneath rather than beside it.
     *
     * At most one module gets it: if several ask, the lowest `rank` wins and
     * the others are composed normally, because two full-measure bands stacked
     * at the top of a page is not a banner, it is a page with no rail. The
     * banner is sized like any other band — between its h_min and its h_pref —
     * and squeezed toward h_min as far as it takes for everything left to clear
     * ITS minimum, so asking for a banner can never be what drops a module.
     *
     * This is a request and not a command, and the page is the right place for
     * it: whether the day's lead deserves the whole measure is an editorial
     * judgement about the copy and the photograph, exactly like `rank`, and the
     * compositor has never made those. What the compositor still owns is every
     * rectangle on the sheet — the banner asks for one cut, not for a layout.
     *
     * A REQUEST, and ui_compose() never writes it. To find out whether the
     * request was granted, read `bannered` below — never this field, and never
     * the geometry. */
    bool banner;

    /* ---- filled in by ui_compose() ---- */
    bool placed;

    /* True on the ONE module that actually got the banner band, and false
     * everywhere else — on the modules that asked and lost the tie, and on the
     * module that asked, won, and could not be honoured.
     *
     * A separate field rather than clearing `banner`, for two reasons. The
     * request is the caller's data and this file has no business editing it;
     * and ui_compose() has to be idempotent — the page composes an array it has
     * already composed whenever it re-measures, and a compositor that consumed
     * the requests as it read them would lay the same snapshot out differently
     * the second time, which is exactly the promise news_hash() makes to the
     * device when it skips a twenty-five-second refresh.
     *
     * READ THIS AND NOT THE GEOMETRY, and the reason is the whole point of the
     * field. A refused banner can land alone on a full-measure band at the top
     * of the well by the ordinary packing — that is simply what an important
     * story with no rail beside it looks like — so "alone, six columns, top of
     * the well" does not distinguish "I asked and won" from "I asked, was
     * refused, and the packing happened to produce the same rectangle". The two
     * pages want different ink in that rectangle and nothing in the numbers
     * tells them apart. It is a one-payload-in-fifty bug that no screenshot
     * would catch.
     *
     * The general rule, for the next output field added here: an ANSWER never
     * shares a field with its QUESTION, and it is never left to be inferred
     * from the rectangles. ui_compose() has to be re-runnable on an array it
     * has already composed — the page re-composes whenever it re-measures — so
     * a compositor that consumed a request as it read it would produce a
     * different page the second time, and news_hash() has promised the device
     * that cannot happen. Answer beside the question, never on top of it. */
    bool bannered;

    /* True on a FIGURE that was taken off the page to keep its prose share,
     * false on everything else — including on a module the sheet simply had no
     * room for. Both come back `placed` false and the page draws neither, so
     * this is not for the drawing; it is so that "the page lost its chart" can
     * be told from "the page ran out of paper" by anything that looks, which is
     * the test, the simulator's dump, and whoever is reading a sheet asking why
     * a module they filed is not on it.
     *
     * An ANSWER, like `bannered`, and it obeys the same rule: it is written only
     * by ui_compose(), it never shares a field with a request, and it survives
     * re-composition of an already-composed array unchanged. */
    bool crowded_out;

    int  band;         /* which band it landed in, for the neighbour rules    */

    /* Which PANE of that band, left to right — not which module. Two modules
     * with the same `band` AND the same `slot` are stacked in one column, in
     * `y` order, and that pair of equalities is the only thing that identifies
     * a stack; there is no field for it because none is needed.
     *
     * It is the distinction the rules turn on. The space between two bands is a
     * BOUNDARY and takes a rule across the measure. The space inside a pane,
     * between two modules that share a slot, is paper and takes nothing: a rule
     * there would say "a new row of the page starts here, read across", which
     * is false, and would walk the reader's eye straight into the tall module
     * in the pane beside it — the same tombstoning failure ui_head_weight()
     * exists to prevent, drawn on purpose.
     *
     * A band's panes are contiguous in columns and the last one reaches the
     * grid's right-hand edge, so the span of a band's boundary rule is the x of
     * its slot 0 to the right edge of its highest slot. */
    int  slot;
    int  col, cols;    /* column origin and span on the six-column grid       */
    int  x, y, w, h;   /* absolute pixels on the sheet                        */
} ui_mod_t;

/* How tall `m` wants to be if it is given `w` pixels.
 *
 * Both answers matter and they are different questions.
 *
 * `h_min` IS AN EDITORIAL JUDGEMENT, NOT A RENDERING FLOOR. It is the smallest
 * height at which the module STILL DOES ITS JOB — below which the compositor
 * should drop it rather than print a version of it that lies about what it is.
 * The question to answer is "what is the shortest version of this that is still
 * worth printing", never "what is the shortest version that still renders".
 *
 * The difference is the whole point. Furniture plus one line is a rendering
 * floor, and under it a peers table claims it can live on ONE competitor — but
 * a comparison with one row is not a comparison, it is a mislabelled fact, and
 * a briefs column with two items does not read as a column. Those modules are
 * being perfectly honest to a dishonest question. So: a comparison needs enough
 * rows to compare. A column of briefs needs enough items to read as one. A
 * chart needs enough of its span to show a shape. Answer for the job.
 *
 * AND UNDERSTATING IT DOES NOT FAIL LOUDLY. That is what makes this the hardest
 * mistake in the file to catch: the page comes back a perfectly valid tiling —
 * no overlap, no hole, ui_compose_check() green, every assertion in the host
 * test passing — and editorially worthless. Nothing is red. Somebody has to
 * look at the sheet.
 *
 * Two mechanisms make it worse than it sounds, and both are why the number has
 * to be right rather than safe. On a tight page every module lands AT its
 * h_min, so h_min is not a floor the page rarely touches — it is the height
 * everything actually gets, and a page whose modules all understate it is a
 * page set entirely at a lie. And the compositor drops a module only when even
 * the minimums will not fit, so an understated h_min PREVENTS THE DROP THAT
 * SHOULD HAVE HAPPENED: the sheet keeps six modules that all say nothing
 * instead of the three that would have said something. The space they gave up
 * does not vanish either — it goes to whoever is elastic, so an honest lead
 * silently swells to absorb what four dishonest modules surrendered.
 *
 * One exception, and it is the compositor's, not the page's: a module that is
 * the last thing standing in its region is CLAMPED to what there is rather than
 * dropped, because bare paper at the foot of the well is the one thing this
 * file may not produce. So a sufficiently small well can still print the lie.
 * There is nowhere else for the page to go at that point, and the answer is
 * upstream — see WHAT THIS DOES NOT SOLVE.
 *
 * SO A PLACED MODULE CAN COME BACK SHORTER THAN ITS OWN h_min, AND A DRAWING
 * ROUTINE MUST NOT ASSUME OTHERWISE. Print `h` rows, never the h_min-many rows
 * you asked for, or the surplus draws straight through the module below — the
 * compositor guarantees the rectangle, and what is inside it is the page's.
 *
 * REGION here means the rectangle the fit was handed, and a sheet has several:
 * the body beside the rail, the full-width region under the rail's foot, one
 * pane's column within a band, and — when a banner took the top — everything
 * below it. Each is fitted on its own, so "the last band in its region" is a
 * much smaller claim than "the only thing on the page", and the two must not be
 * read as the same sentence.
 *
 * The rule is exact rather than approximate, and it was measured from inside
 * the fit rather than argued: over the host test's six thousand generated
 * pages the clamp fires 876 times and EVERY ONE of them has exactly one band in
 * the region — never two, so the compositor never starves a module while a
 * neighbour in the same region had height to give. It never fires inside a
 * stack of two or more, and it never fires on a page whose banner was honoured,
 * because the banner is squeezed against a height at which everything left
 * clears its own minimum. test_compose's sweep asserts both of those zeroes and
 * prints the count and the worst shortfall, so the exception cannot quietly
 * widen into the rule.
 *
 * `h_pref` is the height at which the module is finished: the whole body set,
 * the whole table printed. Between the two it stretches or squeezes, and for an
 * elastic module that stretching is where the slack in the page goes.
 *
 * It must be a pure function of (m, w), and it is asked at most THREE times per
 * module PER MAKE-UP — six on a make-up that is asked for a banner and refuses
 * one, because that make-up is then done a second time from the top.
 *
 * A page is made up once, plus once more for every figure the class balance
 * takes off it, because there is no way to learn what a page's prose share is
 * without laying the page out and no way to learn what it becomes without
 * laying it out again. So the whole-page bound is 6·(1 + D), where D is how many
 * FIGURE modules were ranked worse than the page's best prose — at most three on
 * A1's own inventory, and the sweep prints the observed worst rather than
 * leaving it to be trusted. The cost is real and it is affordable for exactly
 * one reason: this runs on a poll whose fingerprint CHANGED, and the refresh it
 * is deciding the shape of costs twenty-five seconds.
 *
 * The bound is worth reading rather than trusting, because it is the only thing
 * standing between this and a compositor that runs LVGL's line breaker over a
 * 1400-byte story inside a retry loop. One call is the module at its final
 * width. The second is the band that straddles the rail's foot, which has to be
 * measured to be found too tall to stay beside it and is then re-cut full width
 * underneath. The third is the nested cut: a candidate for a stack has to be
 * measured to find out whether it fits under the module beside it, and one that
 * does not fit starts the next band, where its width is different. Each is once
 * per band and none is a loop — and purity is what makes them safe, since a
 * call at a width the module does not keep must leave no mark on it.
 *
 * The six is a banner that is asked for and refused: the page is then made up a
 * second time without it, so whatever the per-make-up worst case is, it
 * doubles. Still bounded, still no loop, and the last call is still at the
 * width the module keeps — the second make-up is the one whose rectangles
 * survive. It is the price of the question the banner has to ask ("how little
 * could the rest of the page live on?"), which cannot be answered without
 * laying the rest of the page out.
 *
 * The bound is asserted and its observed worst case printed by test_compose's
 * sweep, so it cannot drift up a change at a time without somebody seeing it. */
typedef void (*ui_measure_fn)(const ui_mod_t *m, int w,
                              int *h_min, int *h_pref, void *ctx);

typedef struct {
    int x, y, w, h;      /* the well: everything between the furniture         */
    int cols;            /* 6                                                  */
    int col_w;           /* 170                                                */
    int gutter;          /* 24                                                 */
    int band_gap;        /* the vertical room a band boundary rule needs       */

    /* The share of the placed ink the PROSE class must hold, as a percentage.
     * ZERO — which is what a zeroed env gets — turns the balance off entirely
     * and is the right answer for a page that has no opinion about it.
     *
     * A1 passes UI_PROSE_MAJORITY. A2 passes nothing: it is the accounts, and a
     * page of the company's numbers is allowed to be a page of numbers.
     *
     * A parameter rather than a page identity on purpose. The compositor has
     * never known which sheet it is making up, and the moment it did, every
     * other rule in this file would be one `if (page == ...)` away from being
     * two rules. See THE CLASS BALANCE above. */
    int prose_pct;

    ui_measure_fn measure;
    void *ctx;
} ui_compose_env_t;

/* Lay `n` modules out in `env`'s well. Returns how many were placed.
 *
 * The caller's array is reordered — the compositor sorts by rank and packs in
 * that order — so `src` rather than the array index is what identifies a
 * module afterwards.
 *
 * TOTAL, in the mathematical sense: it always returns a valid tiling. Given
 * more copy than the sheet can hold it drops modules from the back until the
 * rest fit; given less it stretches the elastic ones until the sheet is full;
 * given a single module it gives it the whole well. It returns 0 only when
 * handed nothing, and the page's own no-data state covers that. There is no
 * failure path for a caller to get wrong, because the failure a reader would
 * actually see — a page with a white hole in it — is the one thing this must
 * never produce.
 *
 * TOTAL under the class balance too, which is why a breach of it is a drop
 * rather than a return value. A page that could not be balanced comes back a
 * page, with `crowded_out` saying what it cost. */
int ui_compose(const ui_compose_env_t *env, ui_mod_t *mods, int n);

/* Every rectangle the compositor produced, checked against the invariants it
 * claims: inside the well, positive, even x and even width, no two overlapping,
 * covering the well with no gap — and, when `env->prose_pct` asks for it, the
 * class balance. Returns true when they hold, and writes the first failure into
 * `why` when it does not.
 *
 * This exists because the simulator's old assertions — "the lead rule lands on
 * row 1108" — cannot survive a page whose bands move. What replaces them is
 * this: not "the page is the shape we drew last time" but "the page is a legal
 * page", which is a stronger claim and holds for every payload rather than for
 * the three the test happens to build. The host test calls it over thousands of
 * generated module sets; the simulator calls it on every pass. */
bool ui_compose_check(const ui_compose_env_t *env, const ui_mod_t *mods, int n,
                      char *why, int why_n);

/* --- the neighbour rules --------------------------------------------------
 * Not geometry, but about geometry, and the compositor is the only thing that
 * knows who is next to whom. */

/* The headline weight a module in `slot` of a band should use, given the weight
 * the module to its left used. Newspapers call two equal headlines abutting
 * across a gutter TOMBSTONING and every style book forbids it: the reader's eye
 * runs across the gutter and reads the two as one line. The fix is not white
 * space, it is contrast — so the second of two neighbours is demoted a step.
 *
 * 0 is the largest (the lead's face) and larger numbers are smaller faces; the
 * page maps them onto its own fonts. `left` is -1 for the first module in a
 * band. */
int ui_head_weight(int rank, int cols, int left);

#ifdef __cplusplus
}
#endif
