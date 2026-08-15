/*
 * ui_page_markets.c — A2: the same company's accounts, set as a newspaper page.
 *
 * The page this replaces was a data dump — the whole watchlist, the indices at
 * full width, sparklines down every row — and the owner rejected it in those
 * words. The fault was not the numbers, it was that A2 was written as its own
 * thing: its own bands, its own row renderer, its own idea of what a table looks
 * like. A page assembled out of parts nothing else uses reads as a screen
 * however carefully it is spaced.
 *
 * So there is no geometry in this file either. A2 is a module list handed to the
 * same make-up desk A1 goes through, drawn by the same renderers, ruled by the
 * same rules — a standing rail down one column, ruled tables, a pulled quote, a
 * chart, and a story with a headline and legs of body. Whatever makes the front
 * page look typeset makes this one look typeset, by construction rather than by
 * a second effort.
 *
 * ## What stops it being grey
 *
 * A sheet of tables has nothing on it larger than a deck and a reader's eye has
 * nowhere to land, which is the difference between a business page and a
 * spreadsheet. Three things answer that here and all three are in the list
 * below: the story, which brings a headline and running prose; the quote, which
 * is one sentence set at headline size and is the page's typographic relief; and
 * the rail, which is a column of figures rather than a table of them and
 * therefore reads down instead of across.
 *
 * ## The quote is not invented
 *
 * It is the DECK of the story this page runs — one sentence a copy desk wrote
 * about that story. The story module sets no deck, so pulling it out and setting
 * it large costs the page nothing and duplicates nothing, and the device does
 * not author a word. When the day's last story has no deck the lead's is used
 * instead, and when neither has one the module is left out and the compositor
 * spends the room on the tables.
 */
#include "ui_internal.h"

#include "ui_modules.h"

#include <stdbool.h>
#include <stddef.h>
#include <string.h>

#define NELEM(a) ((int)(sizeof(a) / sizeof((a)[0])))

static const ui_mod_kind_t MK_POOL[] = {
    UI_MOD_DOSSIER,
    UI_MOD_TABLE, UI_MOD_TABLE,
    UI_MOD_QUOTE,
    UI_MOD_CHART,
    UI_MOD_STORY,
    UI_MOD_PEERS,
    UI_MOD_BRIEFS,
};

#define MK_W_DOSSIER      10
#define MK_W_TABLE_ROW    40
#define MK_W_QUOTE        45
#define MK_W_CHART        55
#define MK_W_PEER         25
#define MK_W_BRIEF        30

static lv_obj_t   *s_page;
static ui_module_t s_pool[NELEM(MK_POOL)];
static ui_rules_t  s_rules;
static ui_mod_t    s_mods[UI_MOD_MAX];

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

/* The story A2 runs: the last one the payload carried, which by the producer's
 * own ordering is the piece about the accounts. A1 runs everything above it —
 * see a1_stories() there — so nothing is printed twice.
 *
 * Under three stories there is none to spare: a front page with a lead and
 * nothing else is a column the compositor has to stretch past the copy that
 * fills it, and this page still has its pulled quote, its statements and its
 * briefs. The two files agree on the number, and they have to. */
static int a2_story(const news_t *v)
{
    return v->story_count >= 3 ? v->story_count - 1 : -1;
}

/* Whose deck the page pulls out. The story A2 runs, or the lead when that one
 * came without a deck; -1 when the payload carried no deck at all. */
static int quote_src(const news_t *v)
{
    const int own = a2_story(v);

    if (own >= 0 && v->stories[own].deck[0]) return own;
    if (v->story_count > 0 && v->stories[0].deck[0]) return 0;
    return -1;
}

static int build(const news_t *v)
{
    const int story = a2_story(v);
    const int quote = quote_src(v);
    int n = 0;

    /* The same rail as A1, and deliberately the same: it is the one thing on
     * both sheets, it is the company's dossier, and a reader who turns the page
     * should find it in the same column at the same size. Every figure gets a
     * chance here, where the front page's rail printed as many as it had room
     * for. */
    if (v->figure_count > 0)
        add(&n, UI_MOD_DOSSIER, 0, 0, 1, 1, MK_W_DOSSIER, true);

    /* EVERY STATEMENT THE FRONT PAGE DID NOT TAKE, and that test is one shared
     * function rather than this file's own arithmetic.
     *
     * It used to be `table_count > 1 && story_count > 0` here and a matching rule
     * in ui_page_front.c, with a comment in each admitting the two had to agree.
     * They stopped agreeing the moment A1 began running a drawn statement as an
     * ordinary module: both sheets wanted the same table, and nothing in either
     * file was wrong on its own. ui_a2_takes_table() is the whole of the rule now
     * and both pages call it, so the split is total — every table reaches exactly
     * one sheet — and main_sim.c asserts it across the seam.
     *
     * The first one A2 keeps runs wide at the top: it is what this page is for,
     * and a statement narrower than three columns loses a quarter off the left of
     * it rather than setting smaller. Any second one is a supporting exhibit and
     * goes lower and narrower. */
    int first = -1;
    for (int i = 0; i < v->table_count; i++) {
        if (!ui_a2_takes_table(v, i)) continue;

        if (first < 0) {
            first = i;
            add(&n, UI_MOD_TABLE, i, 0, 3, 5,
                MK_W_TABLE_ROW * v->tables[i].row_count, false);
        } else {
            add(&n, UI_MOD_TABLE, i, 2, 2, 4,
                MK_W_TABLE_ROW * v->tables[i].row_count, false);
        }
    }

    if (quote >= 0)
        add(&n, UI_MOD_QUOTE, quote, 1, 2, 3, MK_W_QUOTE, false);

    /* The second chart, which is whatever the producer had that was not the
     * price — revenue by quarter, usually. A2 gets it because A1 already has the
     * price series and two charts on one sheet is a terminal. */
    if (v->chart_count > 1)
        add(&n, UI_MOD_CHART, 1, 2, 1, 2, MK_W_CHART, false);

    if (story >= 0)
        add(&n, UI_MOD_STORY, story, 3, 2, 3,
            (int)strlen(v->stories[story].body), true);

    /* FOUR columns at the narrowest, and that is a composition decision rather
     * than a typographic one. The briefs column on this page can run to eight
     * items and eight hundred pixels; the industry table is six rows and two
     * hundred. Put them in one band and the table gets the briefs' height, which
     * no amount of leading fills honestly — a ruled table with a hole under it
     * is the exact fault this page is being rebuilt for. A minimum of four
     * columns beside the briefs' two does not fit the five the body has, so the
     * compositor is obliged to give each of them a band, where each takes its
     * own height and the table runs wide enough to keep all six fields. */
    if (v->peer_count > 0)
        add(&n, UI_MOD_PEERS, 0, 3, 4, 5, MK_W_PEER * v->peer_count, false);

    /* Not elastic — see the note in ui_page_front.c. It matters more here than
     * there: on a day with no statements this is the last band of the page, and
     * a briefs column that absorbed the whole of a thin sheet's slack put two
     * one-line items eight hundred pixels apart. */
    if (v->brief_count > 0)
        add(&n, UI_MOD_BRIEFS, 0, 4, 2, 3, MK_W_BRIEF * v->brief_count, false);

    return n;
}

lv_obj_t *ui_page_markets_create(lv_obj_t *par)
{
    s_page = ui_pane(par, 0, 0, UI_W, UI_H);

    for (int i = 0; i < NELEM(MK_POOL); i++) {
        ui_mod_create(&s_pool[i], s_page, MK_POOL[i]);
    }
    ui_rules_create(&s_rules, s_page);
    return s_page;
}

void ui_page_markets_update(const news_t *v)
{
    if (!v) {
        ui_mod_blank(UI_PAGE_MARKETS, s_pool, NELEM(s_pool), &s_rules);
        return;
    }
    ui_mod_run(UI_PAGE_MARKETS, v, s_pool, NELEM(s_pool), &s_rules,
               s_mods, build(v));
}
