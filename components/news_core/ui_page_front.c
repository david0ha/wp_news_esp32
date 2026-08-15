/*
 * ui_page_front.c — A1: which of the day's material goes on the front page.
 *
 * This file used to be two thousand lines of geometry. It is a list now, and
 * that is the whole of the change: the eight fixed bands are gone, every
 * renderer is in ui_modules.c, and what is left here is the ONE editorial
 * judgement a front page makes — what is on it, in what order of importance,
 * and how much room each thing may claim. Where those things land is
 * ui_compose.c's, and what they look like is ui_modules.c's.
 *
 * ## Rank is the only thing this file says about geometry
 *
 * Every module carries a rank, a range of column spans it can live in, and a
 * weight — how much copy it brought. The compositor packs by rank, gives the
 * spare columns out by weight, and drops from the back when the day brought more
 * than the sheet holds. So a payload with four stories and no pictures composes
 * differently from one with two stories and a photograph, without a branch here
 * for either case, and a payload that brought almost nothing still fills the
 * well because the elastic modules stretch into it.
 *
 * ## What is deliberately absent
 *
 * There is no promotion table and no "if there is no photograph then" anywhere
 * in this file. Under-supply is handled by leaving the module out: a day with no
 * briefs contributes no briefs module and the compositor spends the columns on
 * whatever else arrived. That is the same mechanism as a day with no stories at
 * all, which composes to the dossier rail, the chart, the industry table and the
 * briefs — a quiet-day front page, and a legitimate one.
 *
 * ## The last story is A2's
 *
 * A1 runs the lead and up to three more; the last story the payload carried goes
 * to the markets page, where it is the piece that explains the accounts. A story
 * printed on both sheets would be the one thing a reader could not forgive, and a
 * markets page with no prose on it at all is what the owner rejected about the
 * version this replaces. The single exception is a payload with exactly one
 * story: that one is the lead, and A2 goes without.
 */
#include "ui_internal.h"

#include "ui_modules.h"

#include <stdbool.h>
#include <stddef.h>
#include <string.h>

#define NELEM(a) ((int)(sizeof(a) / sizeof((a)[0])))

/* Everything the page can ever show, once each. A renderer is built here and
 * hidden; it is never created, destroyed or re-parented in an update. Three
 * stories because the lead plus three is what the four ranks of the inventory
 * below can produce, and a fourth would be a module with no rank to give it. */
static const ui_mod_kind_t FP_POOL[] = {
    UI_MOD_DOSSIER,
    UI_MOD_LEAD,
    UI_MOD_STORY, UI_MOD_STORY, UI_MOD_STORY,
    UI_MOD_CHART,
    UI_MOD_BRIEFS,
    UI_MOD_PEERS,
    UI_MOD_THUMBS,
    /* TWO statements, and they are never both on. One is the quiet-day record
     * (ui_a1_table), the other the drawn argument an ordinary front page runs as
     * a graphic (ui_a1_graphic) — and the first is offered only on a day with no
     * stories while the second is offered only on a day that has them. The pool
     * carries both because a renderer is built once at create() and the page does
     * not know at that point which kind of day it will be asked to set. */
    UI_MOD_TABLE, UI_MOD_TABLE,
};

/* The appetites, as ratios and nothing else — see ui_mod_t::weight. A story's
 * is the length of the copy it brought, because a story with seven hundred bytes
 * of body genuinely wants more columns than one with two hundred and there is no
 * better measure of that available. The fixed ones are per ITEM rather than per
 * module: eight briefs want a wider column than three, and the module that
 * brought more material is the one that should get it. */
#define FP_W_DOSSIER      10
#define FP_W_CHART        55
#define FP_W_BRIEF        30
#define FP_W_PEER         25
#define FP_W_THUMBS       60
#define FP_W_TABLE_ROW    40

static lv_obj_t   *s_page;
static ui_module_t s_pool[NELEM(FP_POOL)];
static ui_rules_t  s_rules;
static ui_mod_t    s_mods[UI_MOD_MAX];

static int body_weight(const news_story_t *s)
{
    return (int)strlen(s->body);
}

/* Is this story ELASTIC — can it actually use room beyond what its copy needs?
 *
 * `elastic` decides where a loose page's surplus goes, and the compositor shares
 * it in proportion to `h_pref - h_min`. A story that claims it can absorb and
 * then cannot is the worst of both: it takes the room off the modules that could
 * have used it, and then prints paper.
 *
 * That is not hypothetical — it is what A1's thin-day sheet was doing. The legs
 * were opening their leading to 1.6x to swallow what they had claimed, which is
 * what made the markets page's one column read as a rendering fault beside its
 * neighbours. Capping the leading at an eighth fixed the fault and exposed the
 * cause: on a thin day the lead was claiming eight hundred pixels for three
 * hundred pixels of copy.
 *
 * So the claim is MEASURED, by the same function the banner is decided with and
 * at the narrowest measure the module can be given — the width at which a body
 * goes furthest, so a story that cannot fill its legs there cannot fill them
 * anywhere. Twice a lead's floor is the bar: a story with that much copy grows a
 * leg when it is given one, and a story without it should say so and let the
 * room go to a module that will spend it. */
static bool body_is_elastic(const news_story_t *s, int min_cols)
{
    return ui_body_fills_legs(s->body, UI_COL(min_cols),
                              UI_LEAD_FLOOR_LINES * 2);
}


static void add(int *n, ui_mod_kind_t kind, int src, int rank,
                int min_cols, int max_cols, int weight, bool elastic)
{
    if (*n >= UI_MOD_MAX) return;

    s_mods[*n] = (ui_mod_t){
        .kind = kind, .src = src, .rank = rank,
        .min_cols = min_cols, .max_cols = max_cols,
        .weight = weight, .elastic = elastic,
    };
    (*n)++;
}

/* Does the lead deserve the whole measure?
 *
 * ui_mod_t::banner is a request and the page is the right place to make it: the
 * compositor owns every rectangle on the sheet, but whether a day's lead is
 * worth the top of the page is an editorial judgement about the copy and the
 * picture, exactly like `rank`. What it buys is the shape a standing rail makes
 * impossible — a photograph and a headline edge to edge with the story running
 * down under them in four narrow legs — and with the rail pinned down the left
 * for the full height, every package on the sheet is five columns wide and none
 * of them can be deep, so the page can only ever come out in horizontal slices.
 *
 * TWO conditions, and both are about whether the shape can be FILLED rather than
 * about how good the story is. A banner without a photograph is a headline
 * across 1,140 px of paper, which is a poster. A banner without the copy to run
 * its legs under it is short columns and a hole, which is the fault this page
 * has spent all day removing.
 *
 * The copy test is a MEASUREMENT and not a byte count. It was
 * `strlen(body) >= 1200`, hand-picked, and wrong in the strict direction — a
 * story of long words sets shorter than a story of short ones at the same
 * length, so the threshold refused the banner on days that could carry it. What
 * it asks instead is the question the renderer will answer: run the real string
 * through the same line breaker at the width the legs will actually be set at,
 * and see whether every leg reaches the floor story_run() already holds a lead
 * to. Reusing UI_LEAD_FLOOR_LINES rather than inventing a number is the point —
 * one constant, asked twice.
 *
 * It is also deliberately GENEROUS, because it is a request rather than a
 * decision. Asking and being refused costs nothing: the compositor is documented
 * to squeeze the banner toward h_min and then abandon it entirely rather than
 * drop a module, and it makes that call with the actual geometry in hand, which
 * this function never has. */
static bool lead_is_banner(const news_t *v, int stories)
{
    return stories >= 1
        && v->stories[0].photo.id[0]
        && ui_body_fills_legs(v->stories[0].body, UI_WELL_W, UI_LEAD_FLOOR_LINES);
}

/* How many stories A1 keeps for itself: everything but the last, once there are
 * three, and all of them under that. Never more than the four the ranks below
 * have room for.
 *
 * THREE rather than two, and the reason is the thin day rather than the full
 * one. A payload with two stories that gave one away left the front page a lead
 * and nothing else — and a lead's body is six hundred bytes, which sets nine
 * lines, in a column the compositor had stretched to eight hundred pixels
 * because there was nothing else on the page to give the room to. Copy cannot be
 * stretched; the only fix for a column deeper than its story is a second story.
 * A2 keeps its own piece from three stories up, which is every day that has
 * anything to say. */
static int a1_stories(const news_t *v)
{
    int n = v->story_count >= 3 ? v->story_count - 1 : v->story_count;
    if (n > 4) n = 4;
    return n;
}

/* WHICH STATEMENTS THIS PAGE TAKES IS NOT DECIDED HERE ANY MORE.
 *
 * A1 and A2 must never print the same table, and they used to keep that promise
 * by carrying the same arithmetic in two files with a comment admitting it —
 * "the two files agree on the number, and they have to". That survived while A1
 * ran a statement only on a day with no stories. It does not survive the
 * producer filing two tables and A1 taking one as an ordinary module: the same
 * table reaches both sheets, and the failure is silent, because neither file is
 * wrong on its own.
 *
 * So the split lives in ui_modules.h — ui_a1_graphic(), ui_a1_table() and
 * ui_a2_takes_table() — and both pages call it. One function cannot drift from
 * itself. See main_sim.c, which asserts the invariant those three exist to
 * protect: no table src is drawn on both sheets. */

static int build(const news_t *v)
{
    const int stories = a1_stories(v);
    const int table   = ui_a1_table(v);
    const int graphic = ui_a1_graphic(v);
    int n = 0;

    /* THE COMPANY IS THE LEAD ON A DAY WITH NO STORIES, at three or four
     * columns, and the metric grid sets its heroes in the headline face when it
     * is given that width. This paper has always held that a quiet day is a
     * legitimate front page rather than an error state; what changed with the
     * redesign is only the subject. A day when nothing happened is a day when
     * the COMPANY is the story, so the sheet prints the company — set as large
     * as it prints a headline — rather than printing a news page with the news
     * taken out. That last shape is a page of holes whatever the compositor does
     * with the surplus, which is ui_compose.h's own conclusion about what it
     * cannot fix: a page that hands a handful of short modules to the whole well
     * has already made the mistake upstream.
     *
     * Elastic only here, and only because on this day the grid is the page and
     * has the figures to fill it. See the news-day entry below for the other
     * half of that sentence. */
    if (v->figure_count > 0 && stories == 0)
        add(&n, UI_MOD_DOSSIER, 0, 0, 3, 4, FP_W_DOSSIER, true);

    /* The lead wants four columns when it has a photograph and three when it
     * does not: the picture is what makes the package wide, and a 752 px
     * photograph over two legs is a front page while a 558 px one is an
     * illustration. The id is enough to ask with — whether the tile actually
     * arrives is the renderer's problem, and it reflows without it. */
    if (stories >= 1) {
        const int lead_min = v->stories[0].photo.id[0] ? 4 : 3;
        add(&n, UI_MOD_LEAD, 0, 0, lead_min, 6,
            body_weight(&v->stories[0]),
            body_is_elastic(&v->stories[0], lead_min));
        s_mods[n - 1].banner = lead_is_banner(v, stories);
    }

    /* The story that carries the market link — why the price did what it did —
     * beside the lead or under it. */
    if (stories >= 2)
        add(&n, UI_MOD_STORY, 1, 1, 2, 3, body_weight(&v->stories[1]),
            body_is_elastic(&v->stories[1], 2));

    /* One chart, one or two columns, inside a band rather than across it. A
     * page of charts is a terminal; a page of prose with one chart in it is a
     * newspaper.
     *
     * NOT elastic. It was, on the theory that a chart is indifferent to its own
     * height and is therefore the honest place to put a thin day's spare room. It
     * is not indifferent: a chart's height is a function of its width or it stops
     * being a chart, and one column run to the full depth of an empty well came
     * out as a 170 x 1300 seismograph. The bound is in chart_run().
     *
     * A REAL BOX when the day brought no stories: two or three columns rather
     * than one, because on that day it is the only picture on the sheet and the
     * aspect bound would otherwise hold it to a 204 px stub. It also moves up a
     * rank there — with no headline anywhere on the page, the chart is the
     * second thing the eye lands on after the figures. */
    if (v->chart_count > 0)
        add(&n, UI_MOD_CHART, 0, stories > 0 ? 2 : 1,
            stories > 0 ? 1 : 2, stories > 0 ? 2 : 3, FP_W_CHART, false);

    if (stories >= 3)
        add(&n, UI_MOD_STORY, 2, 2, 2, 3, body_weight(&v->stories[2]),
            body_is_elastic(&v->stories[2], 2));

    /* NOT elastic, and the compositor's own words are the reason: a story grows
     * a leg, a photograph does not grow a border. A briefs column is a list of
     * fixed items and it is the second kind — given three hundred pixels it has
     * nothing to do with them but open the gaps between two one-line items until
     * they are at opposite ends of a broadsheet column. Marking it honestly is
     * what sends a thin day's slack to the modules that can use it. */
    if (v->brief_count > 0)
        add(&n, UI_MOD_BRIEFS, 0, 3, 2, 3, FP_W_BRIEF * v->brief_count, false);

    /* Beside the briefs, and only on a day that has news. A quiet page has the
     * dossier across half of it and three columns for everything else, and a
     * five-row comparison of other companies is the first thing to give up that
     * room: the page is about THIS one, the industry table is the least of what
     * it says, and A2 prints the same six rows in full. Dropping a module is a
     * legitimate answer and it is cheaper than finding it a home. */
    if (v->peer_count > 0 && stories > 0)
        add(&n, UI_MOD_PEERS, 0, 3, 2, 3, FP_W_PEER * v->peer_count, false);


    /* The statement the producer marked as an ARGUMENT, drawn rather than
     * printed: the front page's answer to "colour and charts in the middle of a
     * paper of words and pictures". Rank 3, beside the briefs and the industry
     * table, because it is a graphic and not the news.
     *
     * ui_a1_graphic() decides which — and, with ui_a2_takes_table(), that A2 gets
     * whatever this leaves. Neither page owns that arithmetic any more. */
    if (graphic >= 0)
        add(&n, UI_MOD_TABLE, graphic, 3, 2, 3,
            FP_W_TABLE_ROW * v->tables[graphic].row_count, false);

    /* The two small pictures at the foot: real front-page furniture, and what
     * stops the bottom band being a rule and a paragraph.
     *
     * They used to be dropped on a banner day, on the reasoning that one page
     * wants one dominant picture. That was the right instinct applied at the
     * wrong moment: the banner is a REQUEST, and the compositor refuses nearly
     * half of them — so the rule took the thumbs off a page that then turned out
     * not to have a banner at all. Rank 4 already says what was meant. If the
     * banner is granted and eats the depth, these are the last thing packed and
     * the first thing dropped, by the mechanism that exists for it. */
    if (v->thumb_count > 0)
        add(&n, UI_MOD_THUMBS, 0, 4, 2, 6, FP_W_THUMBS, false);

    if (stories >= 4)
        add(&n, UI_MOD_STORY, 3, 4, 2, 3, body_weight(&v->stories[3]),
            body_is_elastic(&v->stories[3], 2));

    /* Last, and only on a quiet day. Three columns at the narrowest, because a
     * statement narrower than that loses a quarter off the left of it rather
     * than setting smaller. */
    if (table >= 0)
        add(&n, UI_MOD_TABLE, table, 4, 3, 5,
            FP_W_TABLE_ROW * v->tables[table].row_count, false);

    /* THE METRIC GRID, ACROSS THE MEASURE, AT THE FOOT OF A DAY THAT HAS NEWS.
     *
     * This was a one-column standing rail down the left of the sheet, the
     * vertical spine every band was cut against, and the owner rejected it
     * twice. They are right, and the reason is arithmetic rather than taste: a
     * 170 px column is 21 characters, so a label and its value cannot share a
     * line in it, every figure costs two lines, and a twenty-figure dossier is
     * 1,100 px of column. That is why it ran the height of the page — and why a
     * day with twelve figures left it stretched over room it had nothing to put
     * in. Across the measure the same figures are four cards in one row of about
     * 250 px, the labels and values sit on one line because there is room for
     * one, and the groups the producer already files become the cards.
     *
     * SIX COLUMNS, AND LAST. Both are load-bearing, and both were arrived at by
     * rendering the alternatives:
     *
     *   min 3 got the grid into a three-column REGION, so the compositor stood
     *   it down the left against everything else — and a region holding one
     *   inelastic module hands it the region's whole height, so it drew its
     *   cards at the top and left 700 px of bare paper under them. That is the
     *   stretched-rail fault wearing a different shape, and the full payload
     *   lost its photograph, its thumbs, its industry table and its chart to it.
     *
     *   min 6 at rank 3, added here in the middle of the list, put the grid at
     *   the TOP of the thin-day sheet with the lead beside it one column wide
     *   and an ellipsis through its headline. The rank was not the problem: this
     *   file adds in rank order because the compositor packs in ARRAY order, and
     *   a rank-4 module written between two rank-3 ones is packed as though it
     *   outranked them. It has to be added after every rank-3 entry, which is
     *   what "last" means here.
     *
     * Six columns is what keeps it a BAND rather than a REGION — nothing can
     * stand beside it, so it always spans a row of the page instead of a column
     * of it, which is the shape the reference asks for and the shape its own
     * natural height actually describes.
     *
     * NOT ELASTIC, and the flag finally means something: a grid's height is the
     * sum of its card rows, so it can state honestly that it cannot absorb
     * slack, exactly as body_is_elastic() lets a short story state it. The rail
     * claimed elasticity unconditionally, so a thin day handed it the surplus
     * and it printed eighty pixels of paper between one-line entries down the
     * whole sheet. */
    if (v->figure_count > 0 && stories > 0)
        add(&n, UI_MOD_DOSSIER, 0, 4, 6, 6, FP_W_DOSSIER, false);

    return n;
}

lv_obj_t *ui_page_front_create(lv_obj_t *par)
{
    /* Full-bleed rather than inset, because the furniture above the well is in
     * panel coordinates: a module placed at UI_WELL_Y lands there with no origin
     * to remember and no second frame of reference for the simulator to undo. */
    s_page = ui_pane(par, 0, 0, UI_W, UI_H);

    for (int i = 0; i < NELEM(FP_POOL); i++) {
        ui_mod_create(&s_pool[i], s_page, FP_POOL[i]);
    }

    /* After the modules, so a rule prints over an edge rather than under it. */
    ui_rules_create(&s_rules, s_page);
    return s_page;
}

void ui_page_front_update(const news_t *v)
{
    if (!v) {
        ui_mod_blank(UI_PAGE_FRONT, s_pool, NELEM(s_pool), &s_rules);
        return;
    }
    ui_mod_run(UI_PAGE_FRONT, v, s_pool, NELEM(s_pool), &s_rules,
               s_mods, build(v));
}
