/*
 * ui_compose.c — the make-up desk declared in ui_compose.h.
 *
 * The header argues that a guillotine compositor cannot produce a broken page.
 * This file is what makes that true rather than merely intended, and there are
 * three places where it would stop being true if the arithmetic were written
 * the obvious way.
 *
 * PROPORTIONAL DIVISION GOES THROUGH ONE FUNCTION. Every place something is
 * shared out here — the spare columns among a band's modules, the slack height
 * among a pane's bands — goes through cp_apportion(), which hands out the floors
 * and then walks the remainders largest-first. Rounding each share on its own
 * loses up to one unit per claimant, and a band one column short of its pane is
 * a white stripe running down the page: exactly the hole the guillotine was
 * supposed to make impossible. Every division in this file is integer and every
 * product that could pass 2^31 is taken in int64_t, because the device and the
 * simulator have to agree on the rectangles bit for bit.
 *
 * EVENNESS IS FORCED ONCE, AT THE GRID. A photo tile packs two pixels per byte,
 * so a module at an odd x or of odd width cannot be blitted with a per-row
 * memcpy and needs a nibble-shifting slow path on the device for no reason at
 * all. Rather than rounding each rectangle and hoping the roundings cancel, the
 * grid itself is snapped in cp_grid(): an even column, an even gutter and an
 * even left margin make every origin and every span even by construction. The
 * pixel that snapping gives up lands in the gutter, never inside a module —
 * which is the difference between a module that is two pixels narrower than its
 * column span and one that overhangs the module beside it.
 *
 * THE MEASURE CALLBACK IS ASKED ONCE PER MODULE, PLUS TWO BOUNDED EXCEPTIONS.
 * That is not politeness: on the device it runs LVGL's line breaker over a
 * 1400-byte story, and this file is the one thing standing between a re-pack
 * and a hundred of those. The ordinary call is at the module's final width,
 * because packing is greedy from the front — dropping the back of the page
 * cannot disturb a width already decided — and because the bands are packed and
 * measured one at a time, so bands destined to be re-cut full width under the
 * rail are never measured against the body's measure at all.
 *
 * The two extras are each once per BAND rather than per module, and each buys
 * something that cannot be had by guessing. The band straddling the rail's foot
 * has to be measured to be found too tall to stay beside it. And a candidate
 * for a stack has to be measured to find out whether it fits under the module
 * next to it — that is the whole trigger for the nested cut, and the
 * alternative is a ratio picked out of the air. A candidate that does not fit
 * starts the next band at a different width, which is the third call.
 *
 * Nothing inside a make-up is a loop. cp_plan() measures, cp_run() subtracts,
 * cp_place() lays the SAME plan down at whatever height is left — which is how a
 * banner gets sized against what the rest of the page needs without the page
 * being laid out twice. A banner that has to be REFUSED is the one case that
 * costs a second make-up, because there is no way to learn that the rest of the
 * page cannot live on what a banner would leave it without laying the rest of
 * the page out, and once the answer is no, the page it was laid out for is gone.
 *
 * THE CLASS BALANCE IS THE ONE LOOP, and it is outside all of that, in
 * ui_compose() itself. A page's prose share is a fact about rectangles, so it
 * cannot be known before the rectangles exist and cannot be known for the page
 * that results from a drop without making that page up too. The loop is bounded
 * by the number of figures that may be dropped, it shrinks that set on every
 * pass, and it is why the callback's whole-page budget is 6·(1 + D) rather than
 * the 6 the banner alone would cost. ui_compose.h has the argument; here it is
 * enough to say that a make-up is not free and this file spends one only to
 * answer a question that has no cheaper answer.
 *
 * No LVGL, no ESP-IDF, no libm, no float.
 */
#include "ui_compose.h"

#include <stdarg.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>

/* Three across is the widest band a broadsheet sets. A fourth module in one
 * band puts four headlines on one line of the page, which reads as a contents
 * list rather than as news, and leaves each of them under two columns wide. */
#define CP_SLOTS 3

/* And three deep is the most a pane stacks. The same argument stood on its
 * side: a fourth item in one column makes each of them a couple of lines tall,
 * and a column of four stubs reads as a list of links rather than as a page. */
#define CP_STACK 3

/* Which modules are on this page at all, one bit each. The banner's own
 * make-up and every drop the class balance makes are the same operation — "lay
 * the sheet out as though this had not been filed" — and one mask says it once
 * instead of two special cases that have to agree. */
_Static_assert(UI_MOD_MAX <= 32, "the page mask is a uint32_t");

#define CP_BIT(i) ((uint32_t)1 << (i))
#define CP_OUT(excl, i) (((excl) & CP_BIT(i)) != 0)

/* --- the grid -------------------------------------------------------------
 *
 * env carries the six columns of 170 with their 24 px gutters rather than
 * hardcoding them, so the host test can drive geometries no sheet of paper has.
 * Everything downstream reads the snapped copy and never env, which is what
 * keeps the evenness argument to one place. */
typedef struct {
    int x0;          /* the first column's left edge, even                   */
    int y0, h;       /* the well's top and height                            */
    int cols;        /* how many whole columns actually fit                  */
    int col_w;       /* even                                                 */
    int gutter;      /* even                                                 */
    int band_gap;
} cp_grid_t;

/* The pixel width of a run of `k` columns: the columns plus the gutters between
 * them, and not the gutter after the last one. */
static int cp_span(const cp_grid_t *g, int k)
{
    return k * g->col_w + (k - 1) * g->gutter;
}

static bool cp_grid(const ui_compose_env_t *env, cp_grid_t *g)
{
    g->col_w    = env->col_w & ~1;
    g->gutter   = env->gutter > 0 ? (env->gutter & ~1) : 0;
    g->x0       = (env->x + 1) & ~1;    /* rightwards, so it stays in the well */
    g->y0       = env->y;
    g->h        = env->h;
    g->band_gap = env->band_gap > 0 ? env->band_gap : 0;

    /* A column narrower than two pixels cannot hold an even span, and a well
     * with no height has nothing to cut. Both are the caller handing over no
     * page at all, which is the one case ui_compose() is allowed to refuse. */
    if (g->col_w < 2 || g->h < 1) return false;

    /* How many columns fit between the snapped left edge and the well's right
     * edge, solved rather than searched: k*col_w + (k-1)*gutter <= avail. */
    const int avail = env->x + env->w - g->x0;
    int fit = (avail + g->gutter) / (g->col_w + g->gutter);
    if (fit < 0) fit = 0;

    g->cols = env->cols > 0 ? env->cols : 1;
    if (g->cols > fit) g->cols = fit;
    return g->cols >= 1;
}

/* Column origin and pixel width for one module. The only place either is
 * computed, so "every x and every w is even" is a property of three lines. */
static void cp_geom(const cp_grid_t *g, ui_mod_t *m, int col, int cols)
{
    m->col  = col;
    m->cols = cols;
    m->x    = g->x0 + col * (g->col_w + g->gutter);
    m->w    = cp_span(g, cols);
}

/* --- apportionment --------------------------------------------------------
 *
 * Hand `units` out among `n` claimants in proportion to `share`, landing on
 * `units` exactly. Largest remainder, and equal remainders go to the earlier
 * claimant — which is the lower rank, which is the module the reader is meant
 * to look at first, so the tie-break is a typographic decision and not an
 * accident of the loop. */
static void cp_apportion(const int64_t *share, int n, int64_t units, int *out)
{
    for (int i = 0; i < n; i++) out[i] = 0;
    if (n <= 0 || units <= 0) return;

    int64_t total = 0;
    for (int i = 0; i < n; i++) total += share[i] > 0 ? share[i] : 0;

    /* Nothing to go on — every claimant asked for nothing. Round-robin from the
     * front is the same answer as equal shares would give, without the division
     * by zero, and it still fills the pane. */
    if (total <= 0) {
        for (int64_t u = 0; u < units; u++) out[u % n]++;
        return;
    }

    int64_t rem[UI_MOD_MAX];
    int64_t given = 0;
    for (int i = 0; i < n; i++) {
        const int64_t s = share[i] > 0 ? share[i] : 0;
        const int64_t p = units * s;        /* int64: units is a height, s is */
        out[i] = (int)(p / total);          /* the caller's own unit          */
        rem[i] = p - (int64_t)out[i] * total;
        given += out[i];
    }

    /* Each floor loses less than one unit, so fewer than n are left over and a
     * single pass places them all. */
    for (int64_t left = units - given; left > 0; left--) {
        int best = 0;
        for (int i = 1; i < n; i++) if (rem[i] > rem[best]) best = i;
        out[best]++;
        rem[best] = -1;
    }
}

/* --- the working order ---------------------------------------------------- */

static void cp_reset(ui_mod_t *m)
{
    m->placed = false;
    m->bannered = false;
    m->crowded_out = false;
    m->band = -1;
    m->slot = -1;
    m->col = m->cols = 0;
    m->x = m->y = m->w = m->h = 0;
}

/* Insertion sort, and stable on purpose: a payload whose stories all carry the
 * same rank must still come out in the order it arrived, or the page changes
 * shape between two polls that fingerprinted identically and the device spends
 * twenty-five seconds redrawing the same news. */
static void cp_sort(ui_mod_t *mods, int n)
{
    for (int i = 1; i < n; i++) {
        ui_mod_t key = mods[i];
        int j = i - 1;
        while (j >= 0 && mods[j].rank > key.rank) {
            mods[j + 1] = mods[j];
            j--;
        }
        mods[j + 1] = key;
    }
}

/* What a module needs, clamped to what the pane has. A module asking for more
 * columns than the pane holds gets the pane rather than being dropped: the
 * header's guarantee is that ui_compose() is total, and a story set two columns
 * narrower than it wanted is a page, where a hole where it should have been is
 * not. */
static int cp_min_cols(const ui_mod_t *m, int pane_cols)
{
    const int c = m->min_cols > 0 ? m->min_cols : 1;
    return c > pane_cols ? pane_cols : c;
}

/* The ceiling this module will actually be held to. A max under the min is not
 * a ceiling, it is a contradiction, and the min is the one of the two that the
 * typography depends on — a prose module under two columns sets three words to
 * the line. */
static int cp_cap(const ui_mod_t *m, int pane_cols)
{
    int cap = m->max_cols;
    if (cap <= 0) return 0;                          /* no ceiling */
    const int base = cp_min_cols(m, pane_cols);
    if (cap < base)      cap = base;
    if (cap > pane_cols) cap = pane_cols;
    return cap;
}

/* --- the class balance ----------------------------------------------------
 *
 * Four small pure functions, and between them they are the whole of the rule
 * ui_compose.h describes under THE CLASS BALANCE. Everything here reads input
 * fields and placed rectangles and nothing else, so composing an already-
 * composed array reaches the same verdict — which is what lets the same
 * functions serve the compositor and ui_compose_check(), instead of the check
 * carrying a second copy of the rule for the two to drift apart on. */

typedef enum {
    CP_NEITHER = 0,
    CP_PROSE,
    CP_FIGURE,
} cp_class_t;

/* Words and pictures on one side, figures on the other. A lead's photograph is
 * not here because it is not a module — it is inside UI_MOD_LEAD, which is
 * prose, and that is the right answer: a package of a picture and a story is one
 * thing on the page and the reader reads it as one thing.
 *
 * Written out rather than defaulted, so that adding a kind to ui_mod_kind_t
 * without saying which side it is on leaves it in NEITHER — invisible to the
 * balance instead of silently counted as prose. */
static cp_class_t cp_class(ui_mod_kind_t k)
{
    switch (k) {
    case UI_MOD_LEAD:
    case UI_MOD_STORY:
    case UI_MOD_BRIEFS:
    case UI_MOD_QUOTE:
    case UI_MOD_THUMBS:
        return CP_PROSE;

    case UI_MOD_CHART:
    case UI_MOD_TABLE:
    case UI_MOD_PEERS:
    case UI_MOD_DOSSIER:
        return CP_FIGURE;

    case UI_MOD_NONE:
    case UI_MOD_KIND_COUNT:
    default:
        return CP_NEITHER;
    }
}

/* Does the day's file put PROSE at the top of the page, and at what rank?
 *
 * Read off everything FILED rather than everything placed, which matters: the
 * answer decides whether the rule applies at all, so deriving it from a
 * composition would let the rule turn itself off by dropping the module that
 * switched it on. Filed is an input, and an input is the same on every attempt.
 *
 * False is the quiet day — a sheet whose most important module is a figure
 * because the day filed nothing better. See THE HONEST EDGE in ui_compose.h. */
static bool cp_prose_leads(const ui_mod_t *mods, int n, int *best)
{
    int b = mods[0].rank;
    for (int i = 1; i < n; i++) if (mods[i].rank < b) b = mods[i].rank;

    *best = b;
    for (int i = 0; i < n; i++)
        if (mods[i].rank == b && cp_class(mods[i].kind) == CP_PROSE) return true;
    return false;
}

/* The share the placed page actually came out at.
 *
 * Area, over the two classes only — bare paper is neither, and the reason is in
 * the header. int64 throughout: a module on the sheet is 1.5 Mpx, sixteen of
 * them times a hundred is 2.4e9, and that has already passed 2^31 before the
 * odd-grid sweep is anywhere near its widest. */
static bool cp_balanced(const ui_compose_env_t *env, const ui_mod_t *mods, int n,
                        int64_t *prose_out, int64_t *figure_out)
{
    int64_t prose = 0, figure = 0;

    for (int i = 0; i < n; i++) {
        if (!mods[i].placed) continue;
        const int64_t a = (int64_t)mods[i].w * mods[i].h;
        switch (cp_class(mods[i].kind)) {
        case CP_PROSE:  prose  += a; break;
        case CP_FIGURE: figure += a; break;
        default: break;
        }
    }

    if (prose_out  != NULL) *prose_out  = prose;
    if (figure_out != NULL) *figure_out = figure;

    /* A page with neither class on it has no balance to be out of. */
    if (prose + figure <= 0) return true;
    return prose * 100 >= (int64_t)env->prose_pct * (prose + figure);
}

/* May this module be taken off the page to keep the share?
 *
 * A figure, still on the page, and ranked STRICTLY worse than the page's best
 * prose. The last clause is what protects the standing rail: on a day with
 * stories it shares rank 0 with the lead, so it is never the victim, and the
 * compositor never finds itself removing the spine of the page to improve a
 * ratio. */
static bool cp_droppable(const ui_mod_t *m, int best)
{
    return cp_class(m->kind) == CP_FIGURE && m->rank > best;
}

/* The next one to go: the LAST droppable figure in the working order, which —
 * because the array is sorted by rank and the sort is stable — is the worst rank
 * on the page, ties settled by arrival.
 *
 * Over the whole page and not over a pane. The panes are filled a module at a
 * time across a band, so the back of one pane is not the back of the page, and
 * choosing there would drop a lower rank than something standing beside it. That
 * is the same trap cp_fit() passes `may_drop` false to avoid.
 *
 * PLACED, and that is not a formality. A figure the sheet had no room for is
 * already gone and contributes no area, so excluding it would buy the balance
 * nothing and would spend a whole make-up learning that — and it would come back
 * marked `crowded_out` when what actually happened to it was that the page ran
 * out of paper. Two different things, and the reader of a sheet is entitled to
 * know which. */
static int cp_crowd_out(const ui_mod_t *mods, int n, uint32_t excl, int best)
{
    for (int i = n - 1; i >= 0; i--) {
        if (CP_OUT(excl, i) || !mods[i].placed) continue;
        if (cp_droppable(&mods[i], best)) return i;
    }
    return -1;
}

/* --- packing a band ------------------------------------------------------- */

/* A band is a horizontal strip cut into PANES, and a pane holds one module or a
 * short vertical stack of them. Its modules are a contiguous run of the working
 * order — the front row first, then whatever was pulled forward into the panes
 * that had room — which is what lets the region below the rail re-pack a plain
 * suffix without unpicking anything. `pane[j]` says which pane module j sits
 * in; the first `np` entries of the run are the front row, one per pane, so
 * `cols[first + p]` is pane p's span. */
typedef struct {
    int  first;                 /* index of its first module in the slice     */
    int  n;                     /* front row plus everything stacked          */
    int  np;                    /* how many panes across                      */
    int  h_min, h_pref;
    bool elastic;
    int  y, h;                  /* filled in by cp_fit()                      */
    int  gap;                   /* the leading after it; 0 for the last       */
} cp_band_t;

/* Share the pane's spare columns among one band's modules.
 *
 * The minimums are already assigned; this decides who grows, and it is the
 * whole reason a story with 700 bytes of body comes out four columns wide and
 * the one beside it with 200 comes out two. */
static void cp_spread(const ui_mod_t *mods, const int *ord, int *cols,
                      int first, int n, int pane_cols)
{
    int sum = 0;
    for (int i = 0; i < n; i++) sum += cols[first + i];
    if (sum >= pane_cols) return;

    int64_t share[CP_SLOTS];
    int     add[CP_SLOTS];
    for (int i = 0; i < n; i++) {
        const int w = mods[ord[first + i]].weight;
        share[i] = w > 0 ? w : 0;
    }
    cp_apportion(share, n, pane_cols - sum, add);
    for (int i = 0; i < n; i++) cols[first + i] += add[i];

    /* Now the ceilings, and what they refuse goes back into the band. Each pass
     * pins at least one module at its cap, so CP_SLOTS passes settle it.
     *
     * The last line is the one worth reading twice: when every module in the
     * band is at its ceiling and columns are still unspent, the ceiling loses.
     * max_cols is the caller saying a module would rather not be wide; the
     * exact tiling is this file's only hard promise, and a band that ends
     * short of its pane is the white stripe the guillotine exists to prevent. */
    for (int pass = 0; pass <= CP_SLOTS; pass++) {
        int over = 0;
        for (int i = 0; i < n; i++) {
            const int cap = cp_cap(&mods[ord[first + i]], pane_cols);
            if (cap > 0 && cols[first + i] > cap) {
                over += cols[first + i] - cap;
                cols[first + i] = cap;
            }
        }
        if (over == 0) return;

        bool moved = true;
        while (over > 0 && moved) {
            moved = false;
            for (int i = 0; i < n && over > 0; i++) {
                const int cap = cp_cap(&mods[ord[first + i]], pane_cols);
                if (cap == 0 || cols[first + i] < cap) {
                    cols[first + i]++;
                    over--;
                    moved = true;
                }
            }
        }
        if (over > 0) { cols[first] += over; return; }
    }
}

/* The column origin of each pane of a band, relative to the pane's own left. */
static void cp_pane_col(const cp_band_t *b, const int *cols, int pane_col0,
                        int *out)
{
    int c = pane_col0;
    for (int p = 0; p < b->np; p++) {
        out[p] = c;
        c += cols[b->first + p];
    }
}

/* Ask the page how tall one module wants to be at the width it has been given.
 *
 * A page that answers nothing still gets a page. One pixel rather than zero
 * because a module with no height is not a module, it is a rule, and
 * ui_compose_check() is entitled to insist every rectangle has area. A
 * preference under the minimum is the page contradicting itself; the minimum is
 * the half of the pair that is about legibility, so it wins. */
static void cp_ask(const ui_compose_env_t *env, const ui_mod_t *m, int w,
                   int *h_min, int *h_pref)
{
    int lo = 0, hi = 0;

    if (env->measure != NULL) env->measure(m, w, &lo, &hi, env->ctx);
    if (lo < 1)  lo = 1;
    if (hi < lo) hi = lo;

    *h_min  = lo;
    *h_pref = hi;
}

/* --- one band, packed, measured and stacked ------------------------------
 *
 * THE MISSING CUT, AND WHY IT IS THE ONE THAT MATTERS
 * ---------------------------------------------------
 * A band used to be a row of modules that all shared its height, and a page
 * made only of those can only ever come out as a stack of horizontal strips.
 * Nothing on it can be tall and narrow. Put a story that wants 900 px beside
 * one that wants 300 and there are two outcomes and both are wrong: level them
 * to 900 and the short one is 600 px of paper inside a ruled box, or level them
 * to 300 and the long one is cut off in its prime.
 *
 * So a band's pane may itself be cut horizontally, and hold a short STACK
 * instead of one module:
 *
 *     [ tall story  | short module ]
 *     [ 2 cols      |--------------]
 *     [ 900 px      | short module ]
 *     [             |--------------]
 *     [             | short module ]
 *
 * Still a guillotine — every cut still runs edge to edge across the rectangle
 * it divides — so it costs nothing from the safety argument in the header. What
 * it buys is the arrangement the tree could not previously express at all.
 *
 * WHEN TO DO IT, DERIVED RATHER THAN TUNED
 * ----------------------------------------
 * The obvious rule is a ratio: stack when the tallest module is some multiple
 * of its neighbour. That number would be a guess, and it would be wrong at the
 * edges in both directions. The arithmetic offers a better test for free.
 *
 * Stack when another module ACTUALLY FITS in the room the anchor leaves — that
 * is, when the pane's leftover, after its current occupant is set at the height
 * it asked for, is enough for the next module in the file at the height IT asks
 * for. Nothing is guessed and nothing is squeezed: a module is pulled forward
 * only when it can be set whole.
 *
 * The ratio falls out of that instead of being asserted. A module has to be
 * substantially taller than its neighbour before a second one fits underneath —
 * roughly twice, once the band gap is paid for — so a band whose modules want
 * 900 and 850 px is left alone, and one that wants 900 and 300 gets two more
 * items on the page. That is the same threshold a ratio would have picked, but
 * it is measured against the copy that actually arrived rather than against a
 * constant, so it stays right when the fonts or the furniture move.
 *
 * COST: the candidate has to be measured to find out whether it fits, and a
 * candidate that does not fit starts the next band, where it is measured again
 * at its new width. That is one speculative measurement per band — bounded, not
 * a loop — and it is what raises the callback's worst case from two calls per
 * module to three. See the note in ui_compose.h.
 *
 * Returns the index just past the last module the band took. */
static int cp_band(const ui_compose_env_t *env, const cp_grid_t *g,
                   ui_mod_t *mods, const int *ord, int m, int j,
                   int pane_col0, int pane_cols,
                   int *cols, int *pane, int *h_min, int *h_pref, cp_band_t *b)
{
    b->first = j;
    b->n = b->np = 0;
    b->h_min = b->h_pref = 0;
    b->elastic = false;
    b->y = b->h = b->gap = 0;

    /* --- the front row: one module per pane, left to right --------------- */
    int sum = 0;
    while (j < m && b->np < CP_SLOTS) {
        const int mc = cp_min_cols(&mods[ord[j]], pane_cols);
        if (b->np > 0 && sum + mc > pane_cols) break;      /* it starts the next */
        cols[j] = mc;
        pane[j] = b->np;
        sum += mc;
        b->np++;
        b->n++;
        j++;
        if (sum >= pane_cols) break;                       /* the band is full  */
    }
    cp_spread(mods, ord, cols, b->first, b->np, pane_cols);

    int origin[CP_SLOTS];
    cp_pane_col(b, cols, pane_col0, origin);

    /* Measure the front row at the width its own cut just gave it. */
    int used[CP_SLOTS], deep[CP_SLOTS];
    int anchor = 1;
    for (int p = 0; p < b->np; p++) {
        const int k = b->first + p;
        cp_geom(g, &mods[ord[k]], origin[p], cols[k]);
        cp_ask(env, &mods[ord[k]], mods[ord[k]].w, &h_min[k], &h_pref[k]);
        used[p] = h_pref[k];
        deep[p] = 1;
        if (h_pref[k] > anchor) anchor = h_pref[k];
    }

    /* --- stacking: pull the next modules into the panes that have room --- */
    while (j < m) {
        /* The emptiest pane first, ties to the left. Filling the shallowest
         * column keeps the stacks even, which is what stops the arrangement
         * turning into one deep column and two bare ones. */
        int best = -1, best_room = 0;
        for (int p = 0; p < b->np; p++) {
            if (deep[p] >= CP_STACK) continue;
            const int room = anchor - used[p] - g->band_gap;
            if (room < 1) continue;
            if (best < 0 || room > best_room) { best = p; best_room = room; }
        }
        if (best < 0) break;

        /* A module is pulled forward only if the pane is wide enough for it as
         * it stands. Squeezing it under its own minimum to make it fit a stack
         * would trade the hole this cut exists to remove for a worse one. */
        const int k = b->first + best;
        if (mods[ord[j]].min_cols > cols[k]) break;

        cp_geom(g, &mods[ord[j]], origin[best], cols[k]);
        cp_ask(env, &mods[ord[j]], mods[ord[j]].w, &h_min[j], &h_pref[j]);
        if (h_pref[j] > best_room) break;       /* it cannot be set whole here */

        cols[j] = cols[k];
        pane[j] = best;
        used[best] += g->band_gap + h_pref[j];
        deep[best]++;
        b->n++;
        j++;
    }

    /* --- what the band as a whole wants ---------------------------------- */
    int lo[CP_SLOTS];
    for (int p = 0; p < b->np; p++) { lo[p] = 0; used[p] = 0; deep[p] = 0; }

    for (int s = 0; s < b->n; s++) {
        const int k = b->first + s;
        const int p = pane[k];
        if (deep[p] > 0) { lo[p] += g->band_gap; used[p] += g->band_gap; }
        lo[p]   += h_min[k];
        used[p] += h_pref[k];
        deep[p]++;
        if (mods[ord[k]].elastic) b->elastic = true;
    }

    /* A pane is as tall as its stack, and the band is as tall as its deepest
     * pane: anything less would cut somebody's minimum. */
    b->h_min = b->h_pref = 1;
    for (int p = 0; p < b->np; p++) {
        if (lo[p]   > b->h_min)  b->h_min  = lo[p];
        if (used[p] > b->h_pref) b->h_pref = used[p];
    }
    if (b->h_pref < b->h_min) b->h_pref = b->h_min;

    return j;
}

/* Fit the bands into `avail` pixels at `top`, and fill the pane exactly.
 *
 * Returns how many bands survived; the rest are the day's page being shorter
 * than the day's file. */
static int cp_fit(cp_band_t *b, int nb, int top, int avail, int gap,
                  bool may_drop)
{
    if (nb <= 0 || avail < 1) return 0;

    /* Over-supply. The foot of the page goes first, which is the whole reason
     * rank is also the packing order: the reader loses the least important
     * thing on the sheet rather than whatever happened to be measured last.
     *
     * A pane's stack passes may_drop false, and that is not a shortcut. Dropping
     * from the back of ONE pane loses whatever that pane happened to be holding,
     * and the panes are filled a module at a time across the band — so the
     * casualty would be a lower rank than something still standing in the pane
     * beside it. Who leaves the band is decided once, over the whole band, by
     * cp_lay(); by the time a stack gets here the answer is already in it. */
    while (may_drop && nb > 1) {
        int need = (nb - 1) * gap;
        for (int i = 0; i < nb; i++) need += b[i].h_min;
        if (need <= avail) break;
        nb--;
    }

    const int room = avail - (nb - 1) * gap;
    int sum_min = 0, sum_pref = 0;
    for (int i = 0; i < nb; i++) {
        sum_min  += b[i].h_min;
        sum_pref += b[i].h_pref;
        b[i].gap  = i < nb - 1 ? gap : 0;
    }

    int64_t share[UI_MOD_MAX];
    int     add[UI_MOD_MAX];

    if (sum_pref <= room) {
        /* Under-supply: everything is set as it wanted to be and there is paper
         * left over.
         *
         * It goes to the bands whose bodies can absorb it, in proportion to how
         * much body they have — a story grows a leg, a photograph does not grow
         * a border.
         *
         * When nothing in the region is elastic, none of it may go into a
         * module. This is the quiet page, and it is the case that made the old
         * rule wrong: a five-row table handed 1300 px cannot fill 1300 px
         * however it lays itself out, so inflating it just moves the white hole
         * from the foot of the page into the bottom of the table, where it is
         * inside a ruled box and reads as a mistake rather than as space. The
         * surplus becomes LEADING between the bands instead. Every band comes
         * back at exactly the height it asked for, the boundary rules move
         * apart, and the paper is visible as paper.
         *
         * Uniform leading rather than proportional, because uneven space
         * between the same kind of boundary reads as a river down the page.
         *
         * A lone inelastic band has no gap to put anything in, and there the
         * height still goes to the module: the alternative is bare paper at the
         * foot of the well, which is the one thing this file may not produce.
         * A page that reaches that state has handed the compositor a well it
         * has nothing to fill with, and that is the page's problem rather than
         * one the make-up desk can solve. */
        bool any = false;
        for (int i = 0; i < nb; i++) if (b[i].elastic) any = true;

        const int surplus = room - sum_pref;
        for (int i = 0; i < nb; i++) b[i].h = b[i].h_pref;

        if (any) {
            for (int i = 0; i < nb; i++) share[i] = b[i].elastic ? b[i].h_pref : 0;
            cp_apportion(share, nb, surplus, add);
            for (int i = 0; i < nb; i++) b[i].h += add[i];
        } else if (nb > 1) {
            for (int i = 0; i < nb - 1; i++) share[i] = 1;
            cp_apportion(share, nb - 1, surplus, add);
            for (int i = 0; i < nb - 1; i++) b[i].gap += add[i];
        } else {
            b[0].h += surplus;
        }

    } else if (sum_min >= room) {
        /* One band that is still too tall for the well it is alone in — the
         * drop loop above leaves nothing else here. It is clamped rather than
         * dropped, and its modules copyfit into what there is, because a page
         * with one crowded story on it beats a page with nothing on it. */
        int over = sum_min - room;
        for (int i = 0; i < nb; i++) b[i].h = b[i].h_min;
        for (int i = nb - 1; i >= 0 && over > 0; i--) {
            const int give = b[i].h - 1 < over ? b[i].h - 1 : over;
            b[i].h -= give;
            over   -= give;
        }

    } else {
        /* Between the two: every band gives up the same fraction of the slack
         * it was hoping for, so the squeeze is shared instead of falling
         * entirely on the last band that happened not to fit. */
        for (int i = 0; i < nb; i++) share[i] = b[i].h_pref - b[i].h_min;
        cp_apportion(share, nb, room - sum_min, add);
        for (int i = 0; i < nb; i++) b[i].h = b[i].h_min + add[i];
    }

    int y = top;
    for (int i = 0; i < nb; i++) {
        b[i].y = y;
        y += b[i].h + b[i].gap;
    }
    return nb;
}

/* --- laying it down ------------------------------------------------------- */

/* Column origins and pixel widths. cp_band() has already set these on the
 * modules it measured — it had to, because the measure callback is handed the
 * module itself and has to see the geometry it is being asked about — but a
 * plan can be laid down after a later plan overwrote them, so laying restates
 * them rather than trusting them. */
static void cp_widths(const cp_grid_t *g, ui_mod_t *mods, const int *ord,
                      const int *cols, const int *pane,
                      const cp_band_t *b, int nb, int pane_col0)
{
    for (int i = 0; i < nb; i++) {
        int origin[CP_SLOTS];
        cp_pane_col(&b[i], cols, pane_col0, origin);

        for (int s = 0; s < b[i].n; s++) {
            const int j = b[i].first + s;
            cp_geom(g, &mods[ord[j]], origin[pane[j]], cols[j]);
        }
    }
}

/* The bands have their heights; now the panes divide them.
 *
 * A pane holding one module is that module's whole rectangle. A pane holding a
 * stack shares its height by exactly the rule a region shares itself among its
 * bands — the same cp_fit(), because the question is the same question one
 * level down, and answering it twice in two ways is how the two answers start
 * disagreeing about which pixel a boundary lands on. */
static int cp_lay(const cp_grid_t *g, ui_mod_t *mods, const int *ord,
                  const int *cols, const int *pane,
                  const int *h_min, const int *h_pref,
                  const cp_band_t *b, int nb, int pane_col0, int band_no)
{
    cp_widths(g, mods, ord, cols, pane, b, nb, pane_col0);

    int placed = 0;
    for (int i = 0; i < nb; i++) {
        /* How much of the band still stands.
         *
         * A band squeezed under its own minimum — the lone-band clamp, and the
         * only way to get here — has to give something up, and the decision is
         * taken across the WHOLE band rather than inside each pane, because the
         * band's modules are in rank order along its run and its panes are not.
         * Dropping the tail of the run is therefore dropping the highest ranks,
         * which is the same promise the page makes everywhere else.
         *
         * It never cuts into the front row: those are one module per pane, and
         * a pane with nothing in it is a column of the well left bare. */
        int keep = b[i].n;
        while (keep > b[i].np) {
            bool ok = true;

            for (int p = 0; p < b[i].np && ok; p++) {
                int need = 0, deep = 0;
                for (int s = 0; s < keep; s++) {
                    const int j = b[i].first + s;
                    if (pane[j] != p) continue;
                    if (deep > 0) need += g->band_gap;
                    need += h_min[j];
                    deep++;
                }
                /* Room for the stack as it wants to be, and — for the clamp
                 * that follows when there is not — a pixel each and the gaps
                 * between them. */
                if (need > b[i].h || deep + (deep - 1) * g->band_gap > b[i].h) ok = false;
            }
            if (ok) break;
            keep--;
        }

        for (int p = 0; p < b[i].np; p++) {
            cp_band_t st[CP_STACK];
            int       idx[CP_STACK], d = 0;

            for (int s = 0; s < keep && d < CP_STACK; s++) {
                const int j = b[i].first + s;
                if (pane[j] != p) continue;

                idx[d] = j;
                st[d].first   = j;
                st[d].n       = 1;
                st[d].np      = 1;
                st[d].h_min   = h_min[j];
                st[d].h_pref  = h_pref[j];
                st[d].elastic = mods[ord[j]].elastic;
                st[d].y = st[d].h = st[d].gap = 0;
                d++;
            }
            if (d == 0) continue;

            const int kept = cp_fit(st, d, b[i].y, b[i].h, g->band_gap, false);
            for (int t = 0; t < kept; t++) {
                ui_mod_t *m = &mods[ord[idx[t]]];

                /* `slot` is the PANE, left to right, so a stack shares one. The
                 * page reads it that way too: two modules with the same band
                 * and the same slot are stacked in one column, and the space
                 * between them is inside a band rather than a boundary between
                 * two of them. */
                m->band   = band_no + i;
                m->slot   = p;
                m->y      = st[t].y;
                m->h      = st[t].h;
                m->placed = true;
                placed++;
            }
        }
    }
    return placed;
}

/* --- the cut tree ---------------------------------------------------------
 *
 * Made up in two passes, and the seam between them is where the banner lives.
 *
 * cp_plan() decides everything that is not a height: who the rail is, how the
 * body packs into bands, how wide each module is, whether the cut at the rail's
 * foot is worth making — and it is the only one of the two that measures.
 * cp_place() takes that plan and a height and turns it into rectangles, with no
 * arithmetic in it that could ask the page anything.
 *
 * The split exists because a banner cannot know how much of the well it may
 * keep until something has answered "how little could the rest of the page live
 * on?", and the only honest answer is the one the make-up desk itself would
 * give. Planning first and placing second lets the banner read `need` off a
 * plan that is then used verbatim, rather than laying the page out twice. */

typedef struct {
    int  rail;                  /* index into mods, or -1                      */
    int  U;                     /* the rail's preferred height                 */
    int  r_min;                 /* and the height below which it is not a rail */

    int  ord[UI_MOD_MAX];       /* everything but the rail and the banner      */
    int  m;
    int  body_col0, body_cols;

    int       colsA[UI_MOD_MAX], paneA[UI_MOD_MAX];
    int       loA[UI_MOD_MAX],   prefA[UI_MOD_MAX];
    cp_band_t A[UI_MOD_MAX];
    int       nA;

    bool split;                 /* the horizontal cut at the rail's foot       */
    int  k, start;
    int       colsB[UI_MOD_MAX], paneB[UI_MOD_MAX];
    int       loB[UI_MOD_MAX],   prefB[UI_MOD_MAX];
    cp_band_t B[UI_MOD_MAX];
    int       nB;

    /* The smallest height this plan can be placed into with nothing dropped and
     * nobody under their own minimum. The banner is squeezed against it, and
     * the guarantee that a banner never costs the page a module is the single
     * line `H >= need` rather than a test that has to catch it afterwards. */
    int  need;
} cp_plan_t;

/* `excl` is everything that is not part of this well at all: the banner, which
 * has its own band above it, and every figure the class balance has taken off
 * the page. `probe` is the height the cut at the rail's foot is judged
 * against, which is g->h in the ordinary case and, when a banner is being
 * sized, the SMALLEST height the rest can end up with — because the plan is
 * committed to before the final height is known, and a cut judged against a
 * height the region then turns out to exceed is safe where the reverse is not. */
static void cp_plan(const ui_compose_env_t *env, const cp_grid_t *g,
                    ui_mod_t *mods, int n, uint32_t excl, int probe, cp_plan_t *p)
{
    /* The rail is the lowest-ranked dossier that ASKED to be one, and there is
     * at most one: a second figure rail is packed like any other module. A rail
     * needs a body to stand beside, so on a grid one column wide there is no
     * rail at all and the page is a stack of full-width modules, which is what a
     * one-column page is.
     *
     * ASKING IS `min_cols < cols`, and it is a derivation rather than a new
     * field. This used to select on KIND alone — any dossier was the rail — and
     * that made the shape a property of the module's type instead of of the
     * page's intent. A1 now wants its figures as a BAND across the foot rather
     * than as a spine down the left, and with the old test it could not say so:
     * a dossier asking for all six columns was still made the rail, and the code
     * below clamped it to `cols - 1` so that something could stand beside it —
     * which is precisely the shape the page was asking not to have. The lead
     * came out one column wide with an ellipsis through its headline.
     *
     * A module that wants the whole measure is not a rail, because a rail is
     * defined by what stands beside it. So the request is already in `min_cols`
     * and needs no second channel: at fewer columns than the grid the module is
     * a spine, at all of them it is a band, and both go through the ordinary
     * packing from there. A2 still asks for a spine and still gets one. */
    p->rail = -1;
    for (int i = 0; i < n; i++)
        if (!CP_OUT(excl, i) && mods[i].kind == UI_MOD_DOSSIER &&
            mods[i].min_cols < g->cols) { p->rail = i; break; }

    int pool = 0;
    for (int i = 0; i < n; i++) if (!CP_OUT(excl, i)) pool++;
    if (p->rail >= 0 && pool > 1 && g->cols < 2) p->rail = -1;

    p->m = 0;
    for (int i = 0; i < n; i++)
        if (!CP_OUT(excl, i) && i != p->rail) p->ord[p->m++] = i;

    p->U = p->r_min = 0;
    p->split = false;
    p->k = p->start = p->nA = p->nB = 0;

    if (p->rail >= 0) {
        int rail_cols = mods[p->rail].min_cols > 0 ? mods[p->rail].min_cols : 1;
        if (p->m == 0)                    rail_cols = g->cols;  /* nothing beside it */
        else if (rail_cols > g->cols - 1) rail_cols = g->cols - 1;
        cp_geom(g, &mods[p->rail], 0, rail_cols);

        int lo = 1, hi = 1;
        if (env->measure != NULL) {
            int a = 0, b = 0;
            env->measure(&mods[p->rail], mods[p->rail].w, &a, &b, env->ctx);
            lo = a;
            hi = b;
        }
        if (lo < 1)  lo = 1;
        if (hi < lo) hi = lo;
        p->r_min = lo;
        p->U     = hi;
    }

    p->body_col0 = p->rail >= 0 ? mods[p->rail].cols : 0;
    p->body_cols = g->cols - p->body_col0;

    if (p->m == 0) {
        p->need = p->r_min > 1 ? p->r_min : 1;
        return;
    }

    /* Whether the cut at the rail's foot is even on the table. Deciding it
     * before the body is packed is what lets the packing loop stop the moment
     * the cut is located, so the bands that are going to be re-cut full width
     * underneath are never packed against the body's measure at all. */
    bool want_cut = false;
    if (p->rail >= 0) {
        int strip = probe / 8;
        if (strip < 1) strip = 1;
        want_cut = (p->U + g->band_gap + strip <= probe);
    }

    int j = 0, cut = -1, cum = 0;
    p->nA = 0;

    /* Pack, measure and stack the body one band at a time.
     *
     * The cut at the rail's foot is located as the bands arrive: the first one
     * whose preferred height will not squeeze in beside the rail is the one
     * that starts the region below. Which is what makes that region a decision
     * about the day's file rather than a fixed half of the sheet.
     *
     * Nothing in this loop reads the well's height — only `probe`, which was
     * fixed before it started — so the cut lands on the same band whatever a
     * banner above it turns out to cost. */
    while (j < p->m) {
        j = cp_band(env, g, mods, p->ord, p->m, j, p->body_col0, p->body_cols,
                    p->colsA, p->paneA, p->loA, p->prefA, &p->A[p->nA]);
        p->nA++;

        if (!want_cut || cut >= 0) continue;

        const int i   = p->nA - 1;
        const int add = p->A[i].h_pref + (i > 0 ? g->band_gap : 0);
        if (cum + add > p->U) { cut = i; break; }
        cum += add;
    }

    /* The top band is the lead package and belongs beside the rail even when it
     * would rather be taller. It goes below only if it cannot be squeezed to
     * the rail's height at all. */
    if (cut == 0 && p->A[0].h_min <= p->U) cut = 1;

    /* Where the region below would begin. A band that was packed is the first
     * of the leftovers; a cut forced up to 1 leaves the packing loop's own
     * cursor pointing at them. */
    const int start = cut < 0 ? p->m : (cut < p->nA ? p->A[cut].first : j);

    if (cut > 0 && start < p->m) {
        p->split = true;
        p->k     = cut;
        p->start = start;
        p->nA    = cut;                 /* the rest are re-cut full width */

        int jb = 0;
        p->nB = 0;
        while (jb < p->m - start) {
            jb = cp_band(env, g, mods, p->ord + start, p->m - start, jb, 0,
                         g->cols, p->colsB, p->paneB, p->loB, p->prefB,
                         &p->B[p->nB]);
            p->nB++;
        }

        int lower = (p->nB - 1) * g->band_gap;
        for (int i = 0; i < p->nB; i++) lower += p->B[i].h_min;
        if (lower < 1) lower = 1;

        /* The upper region is the rail's own preferred height whatever the well
         * does, so the only part of a split page that needs more room than it
         * has is the region below it. */
        p->need = p->U + g->band_gap + lower;
        return;
    }

    /* No cut after all: whatever the loop stopped short of still has to be
     * packed, and it is packed against the same measure as the rest. */
    while (j < p->m) {
        j = cp_band(env, g, mods, p->ord, p->m, j, p->body_col0, p->body_cols,
                    p->colsA, p->paneA, p->loA, p->prefA, &p->A[p->nA]);
        p->nA++;
    }

    int need = (p->nA - 1) * g->band_gap;
    for (int i = 0; i < p->nA; i++) need += p->A[i].h_min;
    if (need < p->r_min) need = p->r_min;   /* the rail runs the whole region  */
    if (need < 1)        need = 1;
    p->need = need;
}

/* Turn the plan into rectangles inside `g`, numbering its bands from `band_no`.
 * Nothing here measures anything, and nothing here decides anything either —
 * every choice was made in cp_plan(), which is what makes it safe to ask that
 * function what the page needs and then hand it less of the well than it asked
 * for. */
static int cp_place(const cp_grid_t *g, ui_mod_t *mods, cp_plan_t *p, int band_no)
{
    int placed = 0;

    if (p->rail >= 0) {
        /* The rail stands alone in its band. It is not one of the body's bands
         * — the tree cuts it off with a vertical cut before the body is cut
         * horizontally at all — and giving it a band of its own is the honest
         * way to say that to the neighbour rules. */
        mods[p->rail].band   = band_no;
        mods[p->rail].slot   = 0;
        mods[p->rail].y      = g->y0;
        mods[p->rail].h      = g->h;
        mods[p->rail].placed = true;
        placed = 1;
        band_no++;

        if (p->m == 0) return placed;
    }

    if (p->split) {
        const int U = p->U;
        const int L = g->h - U - g->band_gap;

        const int nU = cp_fit(p->A, p->k,  g->y0,                   U, g->band_gap, true);
        const int nL = cp_fit(p->B, p->nB, g->y0 + U + g->band_gap, L, g->band_gap, true);

        mods[p->rail].h = U;
        placed += cp_lay(g, mods, p->ord, p->colsA, p->paneA, p->loA, p->prefA,
                         p->A, nU, p->body_col0, band_no);
        placed += cp_lay(g, mods, p->ord + p->start, p->colsB, p->paneB, p->loB,
                         p->prefB, p->B, nL, 0, band_no + nU);
        return placed;
    }

    const int nb = cp_fit(p->A, p->nA, g->y0, g->h, g->band_gap, true);
    placed += cp_lay(g, mods, p->ord, p->colsA, p->paneA, p->loA, p->prefA,
                     p->A, nb, p->body_col0, band_no);
    return placed;
}

static int cp_run(const ui_compose_env_t *env, const cp_grid_t *g,
                  ui_mod_t *mods, int n, uint32_t excl)
{
    cp_plan_t p;

    /* The banner request. `mods` is already in rank order and the sort is
     * stable, so the first asker in the array IS the lowest-ranked one, and two
     * askers at the same rank are settled by which of them arrived first —
     * the same tie-break every other share-out in this file uses.
     *
     * A banner with nothing under it is not a banner, it is the page: one
     * module already takes the whole well without being asked, so a lone module
     * that asks is simply composed. `pool` and not `n`, because a page the class
     * balance has cut down to one module is exactly as much of a page as one
     * that arrived that way. */
    int banner = -1, pool = 0;
    for (int i = 0; i < n; i++) {
        if (CP_OUT(excl, i)) continue;
        pool++;
        if (banner < 0 && mods[i].banner) banner = i;
    }

    if (banner >= 0 && pool > 1) {
        /* The well less the leading the cut itself needs. Two pixels is the
         * least that can be divided into a banner and a page under it. */
        const int avail = g->h - g->band_gap;

        if (avail >= 2) {
            cp_geom(g, &mods[banner], 0, g->cols);

            int b_min = 1, b_pref = 1;
            if (env->measure != NULL) {
                int a = 0, b = 0;
                env->measure(&mods[banner], mods[banner].w, &a, &b, env->ctx);
                b_min  = a;
                b_pref = b;
            }
            if (b_min < 1)          b_min  = 1;
            if (b_pref < b_min)     b_pref = b_min;
            if (b_pref > avail - 1) b_pref = avail - 1;

            /* Everything that is left, laid out as though the banner were not
             * there — because that is what it is going to be. `need` comes back
             * with the least of the well it can be given. */
            cp_plan(env, g, mods, n, excl | CP_BIT(banner), avail - b_pref, &p);

            if (b_min <= avail - p.need) {
                /* Squeezed toward its minimum by exactly what the rest of the
                 * page turned out to need, and no further. */
                const int bh = b_pref < avail - p.need ? b_pref : avail - p.need;

                mods[banner].band     = 0;
                mods[banner].slot     = 0;
                mods[banner].y        = g->y0;
                mods[banner].h        = bh;
                mods[banner].placed   = true;
                mods[banner].bannered = true;

                cp_grid_t g2 = *g;
                g2.y0 = g->y0 + bh + g->band_gap;
                g2.h  = g->h  - bh - g->band_gap;

                return 1 + cp_place(&g2, mods, &p, 1);
            }

            /* Even at its minimum the banner would have taken the page's rail
             * or its briefs away with it. A page that lost both to make room
             * for one photograph is worse than a page that did not get its
             * banner, so the request is dropped and the sheet is made up again
             * as though it had never been asked for. The measurement that plan
             * cost is the price of the question. */
        }
    }

    cp_plan(env, g, mods, n, excl, g->h, &p);
    return cp_place(g, mods, &p, 0);
}

int ui_compose(const ui_compose_env_t *env, ui_mod_t *mods, int n)
{
    if (env == NULL || mods == NULL || n <= 0) return 0;
    if (n > UI_MOD_MAX) n = UI_MOD_MAX;

    for (int i = 0; i < n; i++) cp_reset(&mods[i]);

    cp_grid_t g;
    if (!cp_grid(env, &g)) return 0;

    cp_sort(mods, n);

    /* Whether the class balance is in force at all, decided ONCE and off the
     * filed modules, before a single rectangle exists. See cp_prose_leads(). */
    int  best    = 0;
    const bool balance = env->prose_pct > 0 && cp_prose_leads(mods, n, &best);

    uint32_t excl  = 0;
    int      placed = 0;

    /* Make the page up; if it came out a graphics sheet, take the least of its
     * figures off and make it up again.
     *
     * Bounded rather than iterative-until-happy: every pass either stops or
     * moves one module out of a set that only shrinks, so the loop runs at most
     * once per droppable figure and cannot fail to terminate. It is also why
     * the drop is a re-make-up rather than an adjustment — a page with one
     * fewer module is a different page, with different bands and different
     * widths, and patching the old rectangles would be inventing a layout the
     * compositor never cut. */
    for (;;) {
        for (int i = 0; i < n; i++) cp_reset(&mods[i]);

        placed = cp_run(env, &g, mods, n, excl);

        /* A module that did not fit carries no geometry at all. It has usually
         * been through a pack that gave it a width before the fit dropped it,
         * and a page that read x and w without reading `placed` would draw it on
         * top of whatever took its place. Clearing here also keeps ui_compose() a
         * pure function of its inputs down to the last field, which is what lets
         * the host test assert determinism by comparing whole structs.
         *
         * Before the balance is measured, because a dropped module's stale
         * rectangle would otherwise be counted as ink on the sheet. */
        for (int i = 0; i < n; i++) if (!mods[i].placed) cp_reset(&mods[i]);

        if (!balance || cp_balanced(env, mods, n, NULL, NULL)) break;

        const int out = cp_crowd_out(mods, n, excl, best);
        if (out < 0) break;         /* nothing left that may go: THE HONEST EDGE */
        excl |= CP_BIT(out);
    }

    /* Why the modules that are missing are missing. Written last because the
     * loop's own cp_reset() would have cleared it, and it is the one output
     * field that belongs to a module which is NOT on the page. */
    for (int i = 0; i < n; i++) if (CP_OUT(excl, i)) mods[i].crowded_out = true;

    return placed;
}

/* --- the invariants ------------------------------------------------------- */

static bool cp_fail(char *why, int why_n, const char *fmt, ...)
{
    if (why != NULL && why_n > 0) {
        va_list ap;
        va_start(ap, fmt);
        vsnprintf(why, (size_t)why_n, fmt, ap);
        va_end(ap);
    }
    return false;
}

bool ui_compose_check(const ui_compose_env_t *env, const ui_mod_t *mods, int n,
                      char *why, int why_n)
{
    if (why != NULL && why_n > 0) why[0] = '\0';
    if (env == NULL || mods == NULL) return cp_fail(why, why_n, "no page to check");
    if (n <= 0) return true;
    if (n > UI_MOD_MAX) n = UI_MOD_MAX;

    cp_grid_t g;
    if (!cp_grid(env, &g)) {
        for (int i = 0; i < n; i++)
            if (mods[i].placed)
                return cp_fail(why, why_n,
                               "module %d (src %d) was placed in a well that has no room in it",
                               i, mods[i].src);
        return true;
    }

    int placed = 0;
    for (int i = 0; i < n; i++) {
        const ui_mod_t *a = &mods[i];
        if (!a->placed) continue;
        placed++;

        if (a->w <= 0 || a->h <= 0)
            return cp_fail(why, why_n, "module %d (src %d) has no area: %d x %d",
                           i, a->src, a->w, a->h);

        /* A photo tile packs two pixels per byte. An odd origin or span costs a
         * nibble-shifting blit on the device for nothing at all. */
        if (a->x & 1)
            return cp_fail(why, why_n, "module %d (src %d) starts at odd x %d", i, a->src, a->x);
        if (a->w & 1)
            return cp_fail(why, why_n, "module %d (src %d) is an odd %d px wide", i, a->src, a->w);

        if (a->cols < 1 || a->col < 0 || a->col + a->cols > g.cols)
            return cp_fail(why, why_n, "module %d (src %d) spans columns %d..%d of %d",
                           i, a->src, a->col, a->col + a->cols - 1, g.cols);
        if (a->x != g.x0 + a->col * (g.col_w + g.gutter))
            return cp_fail(why, why_n, "module %d (src %d) sits at x %d, not on column %d (x %d)",
                           i, a->src, a->x, a->col, g.x0 + a->col * (g.col_w + g.gutter));
        if (a->w != cp_span(&g, a->cols))
            return cp_fail(why, why_n, "module %d (src %d) is %d px wide, not the %d px of its %d columns",
                           i, a->src, a->w, cp_span(&g, a->cols), a->cols);

        if (a->x < env->x || a->x + a->w > env->x + env->w ||
            a->y < env->y || a->y + a->h > env->y + env->h)
            return cp_fail(why, why_n,
                           "module %d (src %d) at %d,%d %dx%d falls outside the well %d,%d %dx%d",
                           i, a->src, a->x, a->y, a->w, a->h, env->x, env->y, env->w, env->h);

        if (a->band < 0 || a->slot < 0)
            return cp_fail(why, why_n, "module %d (src %d) was placed without a band (%d) or slot (%d)",
                           i, a->src, a->band, a->slot);
    }

    if (placed == 0) {
        if (env->w > 0 && env->h > 0)
            return cp_fail(why, why_n, "nothing was placed, so the whole well is bare");
        return true;
    }

    for (int i = 0; i < n; i++) {
        if (!mods[i].placed) continue;
        for (int j = i + 1; j < n; j++) {
            const ui_mod_t *a = &mods[i], *b = &mods[j];
            if (!b->placed) continue;
            if (a->x < b->x + b->w && b->x < a->x + a->w &&
                a->y < b->y + b->h && b->y < a->y + a->h)
                return cp_fail(why, why_n,
                               "module %d (src %d) at %d,%d %dx%d overlaps module %d (src %d) at %d,%d %dx%d",
                               i, a->src, a->x, a->y, a->w, a->h,
                               j, b->src, b->x, b->y, b->w, b->h);
        }
    }

    /* Coverage, one column of the grid at a time.
     *
     * Doing it in column space rather than in pixels is what makes this exact
     * rather than approximate: every rectangle has already been held to
     * x == the column's origin and w == the column span, so a column that is
     * covered top to bottom is covered pixel for pixel, and the gutters are
     * accounted for by construction instead of being tolerated as slack. Six
     * columns that each run from the top of the well to its foot, broken only
     * by band gaps, is the guillotine's whole claim. */
    for (int c = 0; c < g.cols; c++) {
        int idx[UI_MOD_MAX], k = 0;
        for (int i = 0; i < n; i++)
            if (mods[i].placed && mods[i].col <= c && c < mods[i].col + mods[i].cols)
                idx[k++] = i;

        if (k == 0)
            return cp_fail(why, why_n, "column %d of the well has nothing in it at all", c);

        for (int a = 1; a < k; a++) {
            const int key = idx[a];
            int b = a - 1;
            while (b >= 0 && mods[idx[b]].y > mods[key].y) { idx[b + 1] = idx[b]; b--; }
            idx[b + 1] = key;
        }

        if (mods[idx[0]].y != env->y)
            return cp_fail(why, why_n,
                           "column %d starts at y %d, %d px below the top of the well",
                           c, mods[idx[0]].y, mods[idx[0]].y - env->y);

        for (int a = 1; a < k; a++) {
            const ui_mod_t *up = &mods[idx[a - 1]], *dn = &mods[idx[a]];
            const int hole = dn->y - (up->y + up->h);

            if (hole < g.band_gap)
                return cp_fail(why, why_n,
                               "column %d leaves %d px between module %d (src %d) and module %d (src %d), less than the %d px the boundary rule needs",
                               c, hole, idx[a - 1], up->src, idx[a], dn->src, g.band_gap);

            /* Anything past the band gap is deliberate leading, and there is
             * exactly one reason for it: a region with nothing elastic in it,
             * where the surplus may not go inside a module. So a wide gap is
             * legal only between two modules that could not have absorbed it.
             * Without this the check would accept any hole at all — the
             * coverage assertion is only worth what its gap rule is worth. */
            if (hole > g.band_gap && (up->elastic || dn->elastic))
                return cp_fail(why, why_n,
                               "column %d has %d px of leading between module %d (src %d) and module %d (src %d), which one of them was elastic enough to absorb",
                               c, hole, idx[a - 1], up->src, idx[a], dn->src);
        }

        const ui_mod_t *last = &mods[idx[k - 1]];
        if (last->y + last->h != env->y + env->h)
            return cp_fail(why, why_n,
                           "column %d stops at y %d, %d px short of the foot of the well",
                           c, last->y + last->h, env->y + env->h - (last->y + last->h));
    }

    /* The class balance, as its POSTCONDITION rather than as its threshold.
     *
     * "The prose share is met" is not the claim, because it is not always
     * achievable and a check that asserted it would fail on a page the
     * compositor is right about. The claim is that the compositor did everything
     * it was allowed to do: either the share is met, or every figure it was
     * permitted to remove is off the sheet. Stated that way it is exact, it
     * holds on every payload, and a compositor that quietly stopped enforcing
     * the rule fails it immediately.
     *
     * Held here rather than in the host test alone so that the simulator asserts
     * it on the real page on every pass, which is where a threshold that is
     * merely arithmetically satisfied but editorially wrong would show up. */
    if (env->prose_pct > 0) {
        int best = 0;
        int64_t prose = 0, figure = 0;

        if (cp_prose_leads(mods, n, &best) &&
            !cp_balanced(env, mods, n, &prose, &figure)) {
            for (int i = 0; i < n; i++) {
                if (!mods[i].placed || !cp_droppable(&mods[i], best)) continue;
                return cp_fail(why, why_n,
                               "prose holds %d%% of the page's ink against the %d%% asked for, "
                               "and module %d (src %d) is a rank-%d figure that could have gone "
                               "(the page leads with prose at rank %d)",
                               (int)(prose * 100 / (prose + figure)), env->prose_pct,
                               i, mods[i].src, mods[i].rank, best);
            }
        }
    }

    return true;
}

/* --- the neighbour rules -------------------------------------------------- */

int ui_head_weight(int rank, int cols, int left)
{
    /* The lead's face, the secondary row's, everything else's. Rank rather than
     * position, so a payload numbered 10, 20, 30 sets exactly as one numbered
     * 0, 1, 2. */
    int wt = rank <= 0 ? 0 : (rank <= 2 ? 1 : 2);

    /* A narrow module carries a smaller face at the same rank. Not decoration:
     * the lead's face across two columns sets four words to the line and the
     * head breaks into a ladder, which reads as a mistake rather than as
     * emphasis. */
    if (cols <= 2) wt++;

    if (wt > 3) wt = 3;
    if (wt < 0) wt = 0;

    /* Tombstoning: two equal headlines abutting across a gutter read as one
     * line, because the reader's eye runs straight across the white. Every
     * style book forbids it and the fix is contrast rather than space, so the
     * second of the pair moves a step. Down to a smaller face by preference;
     * up, when there is no smaller face left to move to, because the rule is
     * that the two must differ and clamping back onto the neighbour's weight
     * would be no rule at all. */
    if (left >= 0 && wt == left) wt = wt < 3 ? wt + 1 : wt - 1;

    return wt;
}
