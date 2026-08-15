/*
 * test_compose.c — the make-up desk, held to the claim its header makes.
 *
 * ui_compose.h argues that a guillotine compositor cannot produce a broken
 * page. That is a claim about EVERY payload, not about the three a screenshot
 * test happens to build, and it is exactly the kind of claim that a fixed
 * expectation cannot check: the old front page could be asserted with "the lead
 * rule lands on row 1108", and this one cannot, because the whole point of it is
 * that the rows move.
 *
 * So the shape of this file is: a handful of named cases that pin down what the
 * arrangement should BE — the rail is one column on the left, over-supply drops
 * from the foot, a lone module gets the whole well — and then a generated sweep
 * of several thousand module sets, every one of which has to come out a legal
 * page. The invariants live in ui_compose_check() rather than here, so the
 * simulator asserts the same thing on every pass that this file asserts on
 * every payload it can invent.
 *
 * The generator is an LCG rather than rand(), for the same reason the
 * compositor holds no float: a test that composes a different four thousand
 * pages on each machine reports a failure nobody else can reproduce.
 */
#include "ui_compose.h"
#include "th.h"

#include <stdint.h>

/* --- the page's measurement, standing in for LVGL's ----------------------- */

typedef enum {
    TM_COPY = 0,    /* a story: the wider the leg, the shorter it sets      */
    TM_FIXED,       /* weight IS the preferred height, so a case can say so */
    TM_HOSTILE,     /* a page that answers nonsense                         */
} tm_mode_t;

typedef struct {
    tm_mode_t mode;
    int calls[UI_MOD_MAX];
    int last_w[UI_MOD_MAX];
} tm_ctx_t;

/* Pure in (m, w) and in nothing else, which is what ui_compose.h asks of the
 * real one: the compositor is entitled to ask twice and must get the same
 * answer both times. `mode` is fixed for the whole of one compose, so it is a
 * property of the callback rather than state inside it. */
static void tm_measure(const ui_mod_t *m, int w, int *h_min, int *h_pref, void *ctx)
{
    tm_ctx_t *c = (tm_ctx_t *)ctx;
    if (c != NULL && m->src >= 0 && m->src < UI_MOD_MAX) {
        c->calls[m->src]++;
        c->last_w[m->src] = w;
    }

    if (w < 1) w = 1;

    switch (c != NULL ? c->mode : TM_COPY) {
    case TM_FIXED:
        *h_min  = m->weight / 2 > 0 ? m->weight / 2 : 1;
        *h_pref = m->weight > 0 ? m->weight : 1;
        return;

    case TM_HOSTILE:
        /* Negative, inverted, zero: everything a page under construction can
         * report before its own arithmetic is finished. None of it may reach
         * the rectangles. */
        *h_min  = (m->rank & 1) ? -40 : 0;
        *h_pref = (m->rank & 2) ? -900 : (m->weight & 7);
        return;

    case TM_COPY:
    default:
        break;
    }

    switch (m->kind) {
    case UI_MOD_DOSSIER:
        *h_min  = 90;
        *h_pref = 90 + m->weight;
        break;
    case UI_MOD_THUMBS:
        *h_min  = w / 3 + 20;       /* a picture is its width, near enough */
        *h_pref = w / 2 + 20;
        break;
    case UI_MOD_TABLE:
        *h_min  = 70;
        *h_pref = 70 + m->weight;
        break;
    default: {
        const int ink = m->weight * 24 + 400;    /* the copy, as pixel area */
        *h_min  = 70;
        *h_pref = 48 + ((ink + w - 1) / w) * 22;
        break;
    }
    }
}

static tm_ctx_t tm(tm_mode_t mode)
{
    tm_ctx_t c;
    memset(&c, 0, sizeof c);
    c.mode = mode;
    return c;
}

/* --- the sheet ------------------------------------------------------------ */

/* The sheet's own well, for the cases that are about the REAL page rather than
 * about the arithmetic — kept as one named number because it has already moved
 * once (1308 to 1338, when the folio came off the foot) and every case that
 * retyped it would have gone quietly stale. ui_internal.h owns the real
 * definition; this file cannot include it without dragging in LVGL. */
#define UI_TEST_WELL_H 1338

/* The real grid: six columns of 170 with a 24 px gutter inside a 30 px margin,
 * 6*170 + 5*24 = 1140. The well is what is left between the furniture.
 *
 * MEMSET FIRST, and it is not tidiness. This struct grew a `prose_pct` and the
 * field-by-field version left it reading whatever was on the stack — so the
 * class balance fired on a random third of the cases below and every failure it
 * produced was real arithmetic on a page nobody had asked to be balanced. A test
 * fixture that names every field is a fixture that goes wrong the day the struct
 * gains one. ui_modules.c's well_env() has always zeroed; this now matches it. */
static ui_compose_env_t sheet(tm_ctx_t *ctx, int h, int band_gap)
{
    ui_compose_env_t e;
    memset(&e, 0, sizeof e);
    e.x = 30; e.y = 200; e.w = 1140; e.h = h;
    e.cols = 6; e.col_w = 170; e.gutter = 24;
    e.band_gap = band_gap;
    e.measure = tm_measure;
    e.ctx = ctx;
    return e;
}

static ui_mod_t mk(ui_mod_kind_t kind, int src, int rank, int min_cols,
                   int max_cols, int weight, bool elastic)
{
    ui_mod_t m;
    memset(&m, 0, sizeof m);
    m.kind = kind;
    m.src = src;
    m.rank = rank;
    m.min_cols = min_cols;
    m.max_cols = max_cols;
    m.weight = weight;
    m.elastic = elastic;
    return m;
}

/* --- the structural claims the check cannot make -------------------------
 *
 * ui_compose_check() knows about rectangles. These are about the cut tree that
 * produced them, and they are asserted here because the page reads `band` and
 * `slot` to decide where a rule goes and which face a headline takes: a band
 * whose slots are not 0,1,2 left to right silently mis-sets every neighbour
 * rule without moving a single rectangle. */
static char g_msg[256];

static const char *verify(const ui_compose_env_t *env, const ui_mod_t *mods, int n)
{
    /* The banner, if one was honoured. At most one may be, and it must have
     * asked: `bannered` is the compositor's answer and not a second request. */
    int ban = -1;
    for (int i = 0; i < n; i++) {
        if (!mods[i].bannered) continue;
        if (ban >= 0) {
            snprintf(g_msg, sizeof g_msg,
                     "modules %d and %d were both given the banner", ban, i);
            return g_msg;
        }
        ban = i;
    }
    if (ban >= 0 && (!mods[ban].banner || !mods[ban].placed)) {
        snprintf(g_msg, sizeof g_msg,
                 "module %d carries the banner without having asked for it (or without being placed)",
                 ban);
        return g_msg;
    }
    if (ban >= 0) {
        /* Alone on a full-measure band across the top of the well: the three
         * claims the whole cut is for. */
        if (mods[ban].band != 0 || mods[ban].slot != 0 || mods[ban].col != 0 ||
            mods[ban].cols != env->cols) {
            snprintf(g_msg, sizeof g_msg,
                     "the banner is at column %d..%d of %d in band %d slot %d, not alone across the measure",
                     mods[ban].col, mods[ban].col + mods[ban].cols - 1, env->cols,
                     mods[ban].band, mods[ban].slot);
            return g_msg;
        }
        if (mods[ban].y != env->y) {
            snprintf(g_msg, sizeof g_msg,
                     "the banner starts at y %d, not at the top of the well (%d)",
                     mods[ban].y, env->y);
            return g_msg;
        }
        /* And the rest of the page begins underneath it, never beside it. */
        for (int i = 0; i < n; i++) {
            if (i == ban || !mods[i].placed) continue;
            if (mods[i].y < mods[ban].y + mods[ban].h) {
                snprintf(g_msg, sizeof g_msg,
                         "module %d (src %d) at y %d reaches up beside the banner, which ends at y %d",
                         i, mods[i].src, mods[i].y, mods[ban].y + mods[ban].h);
                return g_msg;
            }
        }
    }

    /* The rail, by the same rule the compositor uses: the lowest-ranked
     * dossier that is not the banner, unless the grid is too narrow to hold a
     * body beside it. The banner takes band 0 when there is one, so the rail's
     * band moves down by one rather than being pinned to zero. */
    const int first_band = ban >= 0 ? 1 : 0;

    /* The first PLACED dossier, and "placed" is load-bearing rather than
     * defensive. This used to take the first dossier by index and then null the
     * rail if that one had not been placed — which is the same thing whenever
     * modules leave the page from the back, because the survivors are a prefix
     * and a dropped dossier is therefore always after a placed one.
     *
     * The class balance broke that. It takes the lowest-ranked FIGURE wherever
     * it sits in the array, so a page can now lose its second dossier and keep
     * its fifth. The old loop then found the dropped one, concluded the page had
     * no rail, and applied the every-band-spans-the-measure rule to the band the
     * REAL rail was standing in — reporting a two-column band 0 as a page with a
     * hole in it. Six of four thousand generated pages, and the page was correct
     * every time: ui_compose_check() had already proved every column covered top
     * to bottom. */
    int rail = -1;
    for (int i = 0; i < n; i++)
        if (i != ban && mods[i].kind == UI_MOD_DOSSIER && mods[i].placed &&
            mods[i].min_cols < env->cols) { rail = i; break; }
    if (rail >= 0 && n - (ban >= 0 ? 1 : 0) > 1 && env->cols < 2) rail = -1;

    if (rail >= 0) {
        if (mods[rail].col != 0 || mods[rail].band != first_band || mods[rail].slot != 0) {
            snprintf(g_msg, sizeof g_msg,
                     "the rail is at column %d in band %d slot %d, not at 0/%d/0",
                     mods[rail].col, mods[rail].band, mods[rail].slot, first_band);
            return g_msg;
        }
        if (mods[rail].y != (ban >= 0 ? mods[ban].y + mods[ban].h + env->band_gap : env->y)) {
            snprintf(g_msg, sizeof g_msg, "the rail starts at y %d, not at the top of its region",
                     mods[rail].y);
            return g_msg;
        }
    }
    const int rail_cols = rail >= 0 ? mods[rail].cols : 0;

    for (int band = 0; band <= 2 * UI_MOD_MAX; band++) {
        int idx[UI_MOD_MAX], k = 0;
        for (int i = 0; i < n; i++)
            if (mods[i].placed && mods[i].band == band) idx[k++] = i;
        if (k == 0) continue;
        if (ban >= 0 && band == 0) {
            if (k != 1) {
                snprintf(g_msg, sizeof g_msg, "the banner shares band 0 with %d other module(s)", k - 1);
                return g_msg;
            }
            continue;
        }
        if (rail >= 0 && band == first_band) {
            if (k != 1) {
                snprintf(g_msg, sizeof g_msg, "the rail shares band %d with %d other module(s)",
                         band, k - 1);
                return g_msg;
            }
            continue;
        }

        /* Three across and three deep, so nine is the most a band can hold. */
        if (k > 9) {
            snprintf(g_msg, sizeof g_msg, "band %d holds %d modules; nine is the most it can",
                     band, k);
            return g_msg;
        }

        /* Sort by pane, and by height within a pane. */
        for (int a = 1; a < k; a++) {
            const int key = idx[a];
            int b = a - 1;
            while (b >= 0 && (mods[idx[b]].slot > mods[key].slot ||
                              (mods[idx[b]].slot == mods[key].slot &&
                               mods[idx[b]].y > mods[key].y))) {
                idx[b + 1] = idx[b];
                b--;
            }
            idx[b + 1] = key;
        }

        /* The band's own extent, which every one of its panes has to span. */
        int top = mods[idx[0]].y, bot = mods[idx[0]].y + mods[idx[0]].h;
        for (int a = 1; a < k; a++) {
            if (mods[idx[a]].y < top) top = mods[idx[a]].y;
            if (mods[idx[a]].y + mods[idx[a]].h > bot) bot = mods[idx[a]].y + mods[idx[a]].h;
        }

        /* Walk the panes. `slot` is the pane index now, so it repeats down a
         * stack rather than counting modules, and the claims that used to be
         * about a row of modules are about a row of PANES. */
        int np = 0, a = 0;
        while (a < k) {
            const int p = mods[idx[a]].slot;
            if (p != np) {
                snprintf(g_msg, sizeof g_msg,
                         "band %d jumps from pane %d to pane %d; the panes are not contiguous",
                         band, np - 1, p);
                return g_msg;
            }

            int e = a;
            while (e < k && mods[idx[e]].slot == p) e++;
            const int deep = e - a;

            if (deep > 3) {
                snprintf(g_msg, sizeof g_msg, "band %d pane %d is %d modules deep; three is the most",
                         band, p, deep);
                return g_msg;
            }

            /* One pane is one column span, whatever is stacked in it. */
            for (int t = a + 1; t < e; t++) {
                if (mods[idx[t]].col != mods[idx[a]].col ||
                    mods[idx[t]].cols != mods[idx[a]].cols) {
                    snprintf(g_msg, sizeof g_msg,
                             "band %d pane %d is not one column span: %d..%d then %d..%d",
                             band, p, mods[idx[a]].col, mods[idx[a]].col + mods[idx[a]].cols - 1,
                             mods[idx[t]].col, mods[idx[t]].col + mods[idx[t]].cols - 1);
                    return g_msg;
                }
            }

            /* And the stack tiles the pane exactly: flush at the band's top and
             * at its foot, with nothing but paper in between. This is the whole
             * nested cut, asserted — if a stack did not fill its pane, the band
             * beside it would be taller than the column under it. */
            if (mods[idx[a]].y != top) {
                snprintf(g_msg, sizeof g_msg,
                         "band %d pane %d starts at y %d, not at the band's top (%d)",
                         band, p, mods[idx[a]].y, top);
                return g_msg;
            }
            if (mods[idx[e - 1]].y + mods[idx[e - 1]].h != bot) {
                snprintf(g_msg, sizeof g_msg,
                         "band %d pane %d stops at y %d, not at the band's foot (%d)",
                         band, p, mods[idx[e - 1]].y + mods[idx[e - 1]].h, bot);
                return g_msg;
            }
            for (int t = a + 1; t < e; t++) {
                const int hole = mods[idx[t]].y -
                                 (mods[idx[t - 1]].y + mods[idx[t - 1]].h);
                if (hole < env->band_gap) {
                    snprintf(g_msg, sizeof g_msg,
                             "band %d pane %d leaves %d px between its members, under the %d px band gap",
                             band, p, hole, env->band_gap);
                    return g_msg;
                }
            }

            np++;
            a = e;
        }

        if (np > 3) {
            snprintf(g_msg, sizeof g_msg, "band %d is %d panes across; three is the most", band, np);
            return g_msg;
        }

        /* The panes are contiguous in columns and the band reaches the grid's
         * right-hand edge. Taken over the front of each pane, since a stack
         * shares its pane's span. */
        int seen = 0, c0 = -1, c1 = -1;
        for (int t = 0; t < k; t++) {
            if (mods[idx[t]].slot != seen) continue;
            if (c1 >= 0 && mods[idx[t]].col != c1) {
                snprintf(g_msg, sizeof g_msg,
                         "band %d leaves a column between pane %d and pane %d (col %d, expected %d)",
                         band, seen - 1, seen, mods[idx[t]].col, c1);
                return g_msg;
            }
            if (c0 < 0) c0 = mods[idx[t]].col;
            c1 = mods[idx[t]].col + mods[idx[t]].cols;
            seen++;
        }
        if (c1 != env->cols || (c0 != 0 && c0 != rail_cols)) {
            snprintf(g_msg, sizeof g_msg,
                     "band %d spans columns %d..%d, which is not a whole pane (rail %d, grid %d)",
                     band, c0, c1 - 1, rail_cols, env->cols);
            return g_msg;
        }

        /* Nobody goes under their minimum — except a module that asked for
         * more columns than the pane it landed in has, which gets the pane
         * rather than being dropped. Beside a five-column rail that is a real
         * case rather than a hypothetical one. */
        for (int t = 0; t < k; t++) {
            const int have = mods[idx[t]].cols;
            const int want = mods[idx[t]].min_cols < c1 - c0 ? mods[idx[t]].min_cols : c1 - c0;
            if (have < want) {
                snprintf(g_msg, sizeof g_msg,
                         "band %d pane %d got %d columns, under its minimum of %d",
                         band, mods[idx[t]].slot, have, mods[idx[t]].min_cols);
                return g_msg;
            }
        }

        /* The anti-tombstoning rule has somewhere to be enforced only because
         * the compositor knows who is next to whom; check it lands. Across the
         * TOP of each pane, which is where two headlines actually abut over a
         * gutter — a module further down a stack has paper to its left. */
        int left = -1, at = 0;
        for (int t = 0; t < k; t++) {
            if (mods[idx[t]].slot != at) continue;
            const int wt = ui_head_weight(mods[idx[t]].rank, mods[idx[t]].cols, left);
            if (wt == left) {
                snprintf(g_msg, sizeof g_msg,
                         "band %d pane %d tombstones against its neighbour at weight %d",
                         band, at, wt);
                return g_msg;
            }
            left = wt;
            at++;
        }
    }

    /* Over-supply drops from the back. The rail is not part of the run, so it
     * is skipped rather than being allowed to break the sequence.
     *
     * SO IS A MODULE CROWDED OUT FOR THE CLASS BALANCE, and that exemption is
     * the whole difference between the page's two drop rules rather than a
     * loophole. Over-supply is "the sheet ran out of paper", so it takes the
     * least important thing left and the survivors are a prefix of the rank
     * order. The balance is "the sheet stopped being a newspaper", so it takes
     * the least important FIGURE — which is routinely ranked ahead of prose
     * that stays, because keeping that prose is the entire object. A rank-4
     * story standing where a rank-3 chart left is the rule working.
     *
     * Asserted, not assumed: `crowded_out` is checked against the class and
     * against the page's best rank in check_prose_balance(), so what is skipped
     * here is still pinned somewhere. This exemption was found by running the
     * balance through this function for the first time — 612 of 4,000 generated
     * pages tripped it — which is what the mechanism having no test had been
     * hiding. */
    bool gone = false;
    for (int i = 0; i < n; i++) {
        if (i == rail || mods[i].crowded_out) continue;
        if (!mods[i].placed) { gone = true; continue; }
        if (gone) {
            snprintf(g_msg, sizeof g_msg,
                     "module %d (rank %d) was placed after a module of lower rank was dropped",
                     i, mods[i].rank);
            return g_msg;
        }
    }

    /* A dropped module carries no geometry at all, so a page that forgot to
     * read `placed` draws nothing rather than drawing it twice. */
    for (int i = 0; i < n; i++) {
        if (mods[i].placed) continue;
        if (mods[i].w || mods[i].h || mods[i].x || mods[i].y ||
            mods[i].cols || mods[i].band != -1 || mods[i].slot != -1) {
            snprintf(g_msg, sizeof g_msg, "dropped module %d still carries geometry", i);
            return g_msg;
        }
    }

    return NULL;
}

/* --- 1. the degenerate calls ---------------------------------------------- */

static void check_nothing(void)
{
    tm_ctx_t ctx = tm(TM_COPY);
    ui_compose_env_t e = sheet(&ctx, 900, 16);
    ui_mod_t m = mk(UI_MOD_LEAD, 0, 0, 2, 0, 300, true);

    /* Handed nothing, it returns nothing. That is the only zero the header
     * allows, and every other input has to come back a page. */
    CHECK_INT(ui_compose(&e, &m, 0), 0);
    CHECK_INT(ui_compose(&e, NULL, 4), 0);
    CHECK_INT(ui_compose(NULL, &m, 1), 0);

    /* A well with no height and a grid with no column are the same thing said
     * two ways: there is no page to make up. */
    ui_compose_env_t flat = sheet(&ctx, 0, 16);
    m = mk(UI_MOD_LEAD, 0, 0, 2, 0, 300, true);
    CHECK_INT(ui_compose(&flat, &m, 1), 0);
    CHECK(!m.placed);

    ui_compose_env_t thin = sheet(&ctx, 900, 16);
    thin.w = 10;
    m = mk(UI_MOD_LEAD, 0, 0, 2, 0, 300, true);
    CHECK_INT(ui_compose(&thin, &m, 1), 0);
    CHECK(!m.placed);

    /* No measurement at all is not a failure path either: the page still fills
     * the well, it just fills it with bands that asked for nothing. */
    ui_compose_env_t mute = sheet(&ctx, 900, 16);
    mute.measure = NULL;
    ui_mod_t two[2] = { mk(UI_MOD_LEAD, 0, 0, 3, 0, 1, true),
                        mk(UI_MOD_STORY, 1, 1, 3, 0, 1, true) };
    CHECK_INT(ui_compose(&mute, two, 2), 2);
    char why[256];
    CHECK(ui_compose_check(&mute, two, 2, why, sizeof why));
}

/* --- 2. one module gets the whole well ------------------------------------ */

static void check_single(void)
{
    tm_ctx_t ctx = tm(TM_COPY);
    ui_compose_env_t e = sheet(&ctx, 900, 16);
    ui_mod_t m = mk(UI_MOD_LEAD, 0, 0, 2, 0, 300, true);
    char why[256];

    CHECK_INT(ui_compose(&e, &m, 1), 1);
    CHECK(ui_compose_check(&e, &m, 1, why, sizeof why));
    CHECK(m.placed);
    CHECK_INT(m.col, 0);
    CHECK_INT(m.cols, 6);
    CHECK_INT(m.x, 30);
    CHECK_INT(m.w, 1140);
    CHECK_INT(m.y, 200);
    CHECK_INT(m.h, 900);
    CHECK_INT(m.band, 0);
    CHECK_INT(m.slot, 0);

    /* A max_cols of two does not get to leave four columns of the sheet bare;
     * the exact tiling is the promise and the ceiling is a preference. */
    ui_mod_t capped = mk(UI_MOD_CHART, 0, 0, 1, 2, 300, false);
    CHECK_INT(ui_compose(&e, &capped, 1), 1);
    CHECK_INT(capped.cols, 6);
    CHECK(ui_compose_check(&e, &capped, 1, why, sizeof why));

    /* A dossier on its own is a page too, and it takes the sheet rather than
     * standing as a rail beside nothing. */
    ui_mod_t alone = mk(UI_MOD_DOSSIER, 0, 0, 1, 0, 300, false);
    CHECK_INT(ui_compose(&e, &alone, 1), 1);
    CHECK_INT(alone.cols, 6);
    CHECK_INT(alone.h, 900);
    CHECK(ui_compose_check(&e, &alone, 1, why, sizeof why));
}

/* --- 3. the rail ---------------------------------------------------------- */

static void check_rail_full_height(void)
{
    tm_ctx_t ctx = tm(TM_FIXED);
    ui_compose_env_t e = sheet(&ctx, 900, 16);
    char why[256];

    /* The rail wants the whole well, so there is one region and no horizontal
     * cut: [rail | body], both running top to foot. */
    ui_mod_t mods[2] = { mk(UI_MOD_DOSSIER, 0, 0, 1, 0, 900, false),
                         mk(UI_MOD_STORY,   1, 1, 2, 0, 900, true) };
    CHECK_INT(ui_compose(&e, mods, 2), 2);
    CHECK(ui_compose_check(&e, mods, 2, why, sizeof why));

    CHECK_INT(mods[0].kind, UI_MOD_DOSSIER);
    CHECK_INT(mods[0].col, 0);
    CHECK_INT(mods[0].cols, 1);
    CHECK_INT(mods[0].x, 30);
    CHECK_INT(mods[0].w, 170);
    CHECK_INT(mods[0].y, 200);
    CHECK_INT(mods[0].h, 900);

    CHECK_INT(mods[1].col, 1);
    CHECK_INT(mods[1].cols, 5);
    CHECK_INT(mods[1].x, 30 + 170 + 24);
    CHECK_INT(mods[1].w, 5 * 170 + 4 * 24);
    CHECK_INT(mods[1].y, 200);
    CHECK_INT(mods[1].h, 900);
    CHECK_INT(mods[1].x + mods[1].w, 30 + 1140);

    /* A rail never takes the last column: a body with no columns is a page with
     * one module on it. Five is the most it can ask for and still be a rail —
     * see below — so this is the clamp at its limit rather than beyond it. */
    ui_mod_t wide[2] = { mk(UI_MOD_DOSSIER, 0, 0, 5, 0, 900, false),
                         mk(UI_MOD_STORY,   1, 1, 2, 0, 900, true) };
    CHECK_INT(ui_compose(&e, wide, 2), 2);
    CHECK_INT(wide[0].cols, 5);
    CHECK_INT(wide[1].cols, 1);
    CHECK(ui_compose_check(&e, wide, 2, why, sizeof why));

    /* AND A DOSSIER THAT ASKS FOR THE WHOLE MEASURE IS NOT A RAIL AT ALL.
     *
     * That is how a page says "band, not spine", and it needs no field of its
     * own: a rail is defined by what stands beside it, so a module that wants
     * every column has said it is not one. A1 asks for this to put its figures
     * across the foot; A2 asks for fewer columns and still gets its spine.
     *
     * The story is dropped here and that is the correct answer rather than a
     * regression — the page asked for a full-measure band on a well with room
     * for one band, and ui_compose() is total, so it composes what was asked
     * instead of refusing. On the real front page the class balance is what
     * stops this being reachable: a figure that crowds prose off the sheet is
     * exactly what it drops. This case has no prose_pct and so has no opinion. */
    ui_mod_t band[2] = { mk(UI_MOD_DOSSIER, 0, 0, 6, 0, 900, false),
                         mk(UI_MOD_STORY,   1, 1, 2, 0, 900, true) };
    CHECK_INT(ui_compose(&e, band, 2), 1);
    CHECK_INT(band[0].cols, 6);
    CHECK_INT(band[0].col, 0);
    CHECK(!band[1].placed);
    CHECK(ui_compose_check(&e, band, 2, why, sizeof why));

    /* It is the rail whatever its rank, and it is on the left. */
    ui_mod_t late[3] = { mk(UI_MOD_LEAD,    0, 0, 2, 0, 900, true),
                         mk(UI_MOD_STORY,   1, 1, 2, 0, 900, true),
                         mk(UI_MOD_DOSSIER, 2, 9, 1, 0, 900, false) };
    CHECK_INT(ui_compose(&e, late, 3), 3);
    CHECK(ui_compose_check(&e, late, 3, why, sizeof why));
    for (int i = 0; i < 3; i++)
        if (late[i].kind == UI_MOD_DOSSIER) { CHECK_INT(late[i].col, 0); CHECK_INT(late[i].h, 900); }
}

static void check_rail_short(void)
{
    tm_ctx_t ctx = tm(TM_FIXED);
    ui_compose_env_t e = sheet(&ctx, 1000, 16);
    char why[256];

    /* A thin file on a quiet day: the rail is 300 px in a 1000 px well, so the
     * well is cut at its foot and everything that did not fit beside it runs
     * the full six columns underneath. */
    ui_mod_t mods[4] = { mk(UI_MOD_DOSSIER, 0, 0, 1, 0, 300, false),
                         mk(UI_MOD_LEAD,    1, 1, 2, 0, 300, true),
                         mk(UI_MOD_STORY,   2, 2, 2, 0, 300, true),
                         mk(UI_MOD_STORY,   3, 3, 2, 0, 300, true) };
    CHECK_INT(ui_compose(&e, mods, 4), 4);
    CHECK(ui_compose_check(&e, mods, 4, why, sizeof why));

    CHECK_INT(mods[0].h, 300);                  /* the rail's own foot        */
    CHECK_INT(mods[1].y, 200);                  /* the upper region           */
    CHECK_INT(mods[1].h, 300);
    CHECK_INT(mods[2].y, 200);
    CHECK_INT(mods[2].h, 300);
    CHECK_INT(mods[1].col, 1);                  /* beside the rail, not over it */
    CHECK_INT(mods[2].col + mods[2].cols, 6);

    CHECK_INT(mods[3].col, 0);                  /* the lower region is full width */
    CHECK_INT(mods[3].cols, 6);
    CHECK_INT(mods[3].x, 30);
    CHECK_INT(mods[3].w, 1140);
    CHECK_INT(mods[3].y, 200 + 300 + 16);
    CHECK_INT(mods[3].h, 1000 - 300 - 16);
    CHECK_INT(mods[3].y + mods[3].h, 200 + 1000);

    /* Nothing left over means no lower region: a region with nothing in it is
     * the white hole under another name, so the rail runs the whole well. */
    ui_mod_t two[2] = { mk(UI_MOD_DOSSIER, 0, 0, 1, 0, 300, false),
                        mk(UI_MOD_STORY,   1, 1, 2, 0, 300, true) };
    CHECK_INT(ui_compose(&e, two, 2), 2);
    CHECK(ui_compose_check(&e, two, 2, why, sizeof why));
    CHECK_INT(two[0].h, 1000);
    CHECK_INT(two[1].h, 1000);

    /* A rail that leaves only a strip under it does not get a lower region
     * either. An eighth of the well is the line: under it, a full-width band
     * across the foot is a strapline rather than a region, and the page reads
     * better with the rail simply run to the bottom. */
    ui_mod_t tight[4] = { mk(UI_MOD_DOSSIER, 0, 0, 1, 0, 980, false),
                          mk(UI_MOD_LEAD,    1, 1, 2, 0, 400, true),
                          mk(UI_MOD_STORY,   2, 2, 2, 0, 400, true),
                          mk(UI_MOD_STORY,   3, 3, 2, 0, 400, true) };
    CHECK_INT(ui_compose(&e, tight, 4), 4);
    CHECK(ui_compose_check(&e, tight, 4, why, sizeof why));
    CHECK_INT(tight[0].h, 1000);
    CHECK_INT(tight[3].col, 1);                 /* still in the body, not below */
}

/* --- 4. the bands --------------------------------------------------------- */

static void check_band_packing(void)
{
    tm_ctx_t ctx = tm(TM_FIXED);
    ui_compose_env_t e = sheet(&ctx, 1400, 16);
    char why[256];

    /* Three two-column modules reach the pane exactly, so the fourth starts a
     * band of its own and takes the whole six columns. */
    ui_mod_t four[4] = { mk(UI_MOD_LEAD,  0, 0, 2, 0, 300, true),
                         mk(UI_MOD_STORY, 1, 1, 2, 0, 300, true),
                         mk(UI_MOD_STORY, 2, 2, 2, 0, 300, true),
                         mk(UI_MOD_STORY, 3, 3, 2, 0, 300, true) };
    CHECK_INT(ui_compose(&e, four, 4), 4);
    CHECK(ui_compose_check(&e, four, 4, why, sizeof why));
    CHECK_INT(four[0].band, 0); CHECK_INT(four[0].slot, 0); CHECK_INT(four[0].cols, 2);
    CHECK_INT(four[1].band, 0); CHECK_INT(four[1].slot, 1); CHECK_INT(four[1].cols, 2);
    CHECK_INT(four[2].band, 0); CHECK_INT(four[2].slot, 2); CHECK_INT(four[2].cols, 2);
    CHECK_INT(four[3].band, 1); CHECK_INT(four[3].slot, 0); CHECK_INT(four[3].cols, 6);

    /* Never four across, even when four minimums would fit. */
    ui_mod_t narrow[4] = { mk(UI_MOD_CHART, 0, 0, 1, 0, 300, false),
                           mk(UI_MOD_CHART, 1, 1, 1, 0, 300, false),
                           mk(UI_MOD_CHART, 2, 2, 1, 0, 300, false),
                           mk(UI_MOD_CHART, 3, 3, 1, 0, 300, false) };
    CHECK_INT(ui_compose(&e, narrow, 4), 4);
    CHECK(ui_compose_check(&e, narrow, 4, why, sizeof why));
    CHECK_INT(narrow[2].band, 0);
    CHECK_INT(narrow[3].band, 1);

    /* The spare columns go where the copy is. Two two-column stories in a
     * six-column pane have two spare between them, and a story carrying three
     * times the body takes both of them. */
    ui_mod_t pair[2] = { mk(UI_MOD_LEAD,  0, 0, 2, 0, 300, true),
                         mk(UI_MOD_STORY, 1, 0, 2, 0, 100, true) };
    CHECK_INT(ui_compose(&e, pair, 2), 2);
    CHECK(ui_compose_check(&e, pair, 2, why, sizeof why));
    CHECK_INT(pair[0].cols, 4);
    CHECK_INT(pair[1].cols, 2);
    CHECK_INT(pair[0].col, 0);
    CHECK_INT(pair[1].col, 4);

    /* Equal appetites split the spare, and the tie goes to the earlier — the
     * lower rank, the module the reader is meant to look at first. */
    ui_mod_t even[2] = { mk(UI_MOD_LEAD,  0, 0, 2, 0, 300, true),
                         mk(UI_MOD_STORY, 1, 1, 2, 0, 300, true) };
    CHECK_INT(ui_compose(&e, even, 2), 2);
    CHECK_INT(even[0].cols, 3);
    CHECK_INT(even[1].cols, 3);

    /* Ceilings are honoured while there is anywhere else for the columns to
     * go, and give way when there is not — the band must still fill its pane. */
    ui_mod_t cap[2] = { mk(UI_MOD_CHART, 0, 0, 2, 2, 900, false),
                        mk(UI_MOD_STORY, 1, 1, 2, 0, 100, true) };
    CHECK_INT(ui_compose(&e, cap, 2), 2);
    CHECK_INT(cap[0].cols, 2);
    CHECK_INT(cap[1].cols, 4);
    CHECK(ui_compose_check(&e, cap, 2, why, sizeof why));

    ui_mod_t both[2] = { mk(UI_MOD_CHART, 0, 0, 2, 2, 900, false),
                         mk(UI_MOD_CHART, 1, 1, 2, 2, 100, false) };
    CHECK_INT(ui_compose(&e, both, 2), 2);
    CHECK_INT(both[0].cols + both[1].cols, 6);
    CHECK(ui_compose_check(&e, both, 2, why, sizeof why));
}

/* --- 5. too much and too little ------------------------------------------- */

static void check_oversupply(void)
{
    tm_ctx_t ctx = tm(TM_FIXED);
    ui_compose_env_t e = sheet(&ctx, 600, 16);
    char why[256];

    /* Eight two-column modules pack into three bands of 3, 3, 2, each of them
     * 500 px tall at best and 250 at worst. Two bands and their gap need 516
     * of the 600 there are; three need 782. So the last band goes, and it is
     * the last band and not the widest or the one measured last. */
    ui_mod_t mods[8];
    for (int i = 0; i < 8; i++)
        mods[i] = mk(UI_MOD_STORY, i, i, 2, 0, 500, true);

    CHECK_INT(ui_compose(&e, mods, 8), 6);
    CHECK(ui_compose_check(&e, mods, 8, why, sizeof why));
    for (int i = 0; i < 6; i++) CHECK(mods[i].placed);
    CHECK(!mods[6].placed);
    CHECK(!mods[7].placed);
    CHECK_INT(mods[6].w, 0);
    CHECK_INT(mods[6].band, -1);

    /* The two surviving bands still fill the well to the pixel. */
    CHECK_INT(mods[0].y, 200);
    CHECK_INT(mods[3].y, 200 + mods[0].h + 16);
    CHECK_INT(mods[3].y + mods[3].h, 200 + 600);

    /* One module far too tall for the well is clamped, not dropped: a page
     * with one crowded story beats a page with nothing on it. */
    ui_mod_t huge = mk(UI_MOD_LEAD, 0, 0, 2, 0, 4000, true);
    CHECK_INT(ui_compose(&e, &huge, 1), 1);
    CHECK_INT(huge.h, 600);
    CHECK(ui_compose_check(&e, &huge, 1, why, sizeof why));

    /* A well of one pixel is still a well. */
    ui_compose_env_t slot = sheet(&ctx, 1, 16);
    ui_mod_t one = mk(UI_MOD_LEAD, 0, 0, 2, 0, 4000, true);
    CHECK_INT(ui_compose(&slot, &one, 1), 1);
    CHECK_INT(one.h, 1);
    CHECK(ui_compose_check(&slot, &one, 1, why, sizeof why));
}

static void check_undersupply(void)
{
    tm_ctx_t ctx = tm(TM_FIXED);
    ui_compose_env_t e = sheet(&ctx, 1400, 16);
    char why[256];

    /* Two bands wanting 200 px each in a 1400 px well. The 984 px of slack goes
     * to the elastic band, because a story grows a leg and a table does not
     * grow a border — and the well ends up exactly full either way. */
    ui_mod_t mods[2] = { mk(UI_MOD_TABLE, 0, 0, 6, 0, 200, false),
                         mk(UI_MOD_STORY, 1, 1, 6, 0, 200, true) };
    CHECK_INT(ui_compose(&e, mods, 2), 2);
    CHECK(ui_compose_check(&e, mods, 2, why, sizeof why));
    CHECK_INT(mods[0].h, 200);
    CHECK_INT(mods[1].h, 1400 - 200 - 16);
    CHECK_INT(mods[1].y + mods[1].h, 200 + 1400);

    /* With nothing elastic in the region, none of the slack may go inside a
     * module: a five-row table handed 1300 px cannot fill 1300 px however it
     * lays itself out, so inflating it only moves the white hole from the foot
     * of the page into the bottom of a ruled box. It becomes leading between
     * the bands instead — both tables come back at exactly the height they
     * asked for and the boundary rule moves down the page. */
    ui_mod_t rigid[2] = { mk(UI_MOD_TABLE, 0, 0, 6, 0, 200, false),
                          mk(UI_MOD_TABLE, 1, 1, 6, 0, 200, false) };
    CHECK_INT(ui_compose(&e, rigid, 2), 2);
    CHECK(ui_compose_check(&e, rigid, 2, why, sizeof why));
    CHECK_INT(rigid[0].h, 200);
    CHECK_INT(rigid[1].h, 200);
    CHECK_INT(rigid[0].y, 200);
    CHECK_INT(rigid[1].y - (rigid[0].y + rigid[0].h), 1400 - 400);   /* the leading */
    CHECK_INT(rigid[1].y + rigid[1].h, 200 + 1400);                  /* still flush */
}

static void check_inelastic_leading(void)
{
    tm_ctx_t ctx = tm(TM_FIXED);
    ui_compose_env_t e = sheet(&ctx, 1400, 16);
    char why[256];

    /* Three inelastic bands wanting 200 px each in a 1400 px well. The 768 px
     * of surplus is split evenly between the two boundaries — evenly rather
     * than proportionally, because uneven space between the same kind of
     * boundary reads as a river down the page. */
    ui_mod_t three[3] = { mk(UI_MOD_TABLE,  0, 0, 6, 0, 200, false),
                          mk(UI_MOD_PEERS,  1, 1, 6, 0, 200, false),
                          mk(UI_MOD_THUMBS, 2, 2, 6, 0, 200, false) };
    CHECK_INT(ui_compose(&e, three, 3), 3);
    CHECK(ui_compose_check(&e, three, 3, why, sizeof why));
    for (int i = 0; i < 3; i++) CHECK_INT(three[i].h, 200);
    CHECK_INT(three[0].y, 200);
    CHECK_INT(three[1].y - (three[0].y + three[0].h), 400);
    CHECK_INT(three[2].y - (three[1].y + three[1].h), 400);
    CHECK_INT(three[2].y + three[2].h, 200 + 1400);

    /* One elastic module anywhere in the region and the rule reverses: the
     * slack belongs inside the thing that can set more copy, and the gaps go
     * back to the bare band gap. */
    ui_mod_t mixed[3] = { mk(UI_MOD_TABLE, 0, 0, 6, 0, 200, false),
                          mk(UI_MOD_STORY, 1, 1, 6, 0, 200, true),
                          mk(UI_MOD_PEERS, 2, 2, 6, 0, 200, false) };
    CHECK_INT(ui_compose(&e, mixed, 3), 3);
    CHECK(ui_compose_check(&e, mixed, 3, why, sizeof why));
    CHECK_INT(mixed[0].h, 200);
    CHECK_INT(mixed[2].h, 200);
    CHECK_INT(mixed[1].h, 1400 - 200 - 200 - 32);
    CHECK_INT(mixed[1].y - (mixed[0].y + mixed[0].h), 16);
    CHECK_INT(mixed[2].y - (mixed[1].y + mixed[1].h), 16);

    /* Elasticity is a property of the BAND, not of the module: one elastic
     * story beside a table holds the whole band open, so the band above it
     * does not get leading it did not need. */
    ui_mod_t beside[3] = { mk(UI_MOD_TABLE, 0, 0, 6, 0, 200, false),
                           mk(UI_MOD_STORY, 1, 1, 3, 0, 200, true),
                           mk(UI_MOD_TABLE, 2, 1, 3, 0, 200, false) };
    CHECK_INT(ui_compose(&e, beside, 3), 3);
    CHECK(ui_compose_check(&e, beside, 3, why, sizeof why));
    CHECK_INT(beside[1].band, beside[2].band);
    CHECK_INT(beside[1].y - (beside[0].y + beside[0].h), 16);

    /* A lone inelastic band has no gap to put anything in, and bare paper at
     * the foot of the well is the one thing that may not happen. So the height
     * goes to the module, and a page that reaches this state has handed the
     * compositor a well it has nothing to fill. */
    ui_mod_t lone = mk(UI_MOD_TABLE, 0, 0, 6, 0, 200, false);
    CHECK_INT(ui_compose(&e, &lone, 1), 1);
    CHECK(ui_compose_check(&e, &lone, 1, why, sizeof why));
    CHECK_INT(lone.h, 1400);

    /* Leading is per REGION, so a rail with a short file above it and an
     * inelastic region below gets the leading only under the cut. */
    ui_compose_env_t tall = sheet(&ctx, 1600, 16);
    ui_mod_t rail[4] = { mk(UI_MOD_DOSSIER, 0, 0, 1, 0, 400, false),
                         mk(UI_MOD_STORY,   1, 1, 2, 0, 300, true),
                         mk(UI_MOD_TABLE,   2, 2, 6, 0, 200, false),
                         mk(UI_MOD_PEERS,   3, 3, 6, 0, 200, false) };
    CHECK_INT(ui_compose(&tall, rail, 4), 4);
    CHECK(ui_compose_check(&tall, rail, 4, why, sizeof why));
    CHECK_INT(rail[0].h, 400);                              /* the rail's foot   */
    CHECK_INT(rail[1].h, 400);                              /* stretched to it   */
    CHECK_INT(rail[2].y, 200 + 400 + 16);                   /* the lower region  */
    CHECK_INT(rail[2].h, 200);
    CHECK_INT(rail[3].h, 200);
    CHECK_INT(rail[2].y - (rail[0].y + rail[0].h), 16);     /* the cut itself    */
    CHECK_INT(rail[3].y + rail[3].h, 200 + 1600);
}

/* --- 6. determinism ------------------------------------------------------- */

static bool same(const ui_mod_t *a, const ui_mod_t *b)
{
    return a->kind == b->kind && a->src == b->src && a->rank == b->rank &&
           a->placed == b->placed && a->bannered == b->bannered &&
           a->crowded_out == b->crowded_out &&
           a->band == b->band && a->slot == b->slot &&
           a->col == b->col && a->cols == b->cols &&
           a->x == b->x && a->y == b->y && a->w == b->w && a->h == b->h;
}

/* Every field of the page except the banner request itself — which is what
 * "composed as though it were never made" has to be measured against. */
static bool same_page(const ui_mod_t *a, const ui_mod_t *b)
{
    return a->kind == b->kind && a->src == b->src && a->rank == b->rank &&
           a->placed == b->placed && a->crowded_out == b->crowded_out &&
           a->band == b->band && a->slot == b->slot &&
           a->col == b->col && a->cols == b->cols &&
           a->x == b->x && a->y == b->y && a->w == b->w && a->h == b->h;
}

/* --- the class balance, measured the way the compositor measures it --------
 *
 * The test computes the share itself rather than asking ui_compose.c for it, so
 * the assertions below are about the PAGE and not about one function agreeing
 * with itself. Kept in step with cp_class() by the same list written out once. */
static bool is_prose(ui_mod_kind_t k)
{
    return k == UI_MOD_LEAD || k == UI_MOD_STORY || k == UI_MOD_BRIEFS ||
           k == UI_MOD_QUOTE || k == UI_MOD_THUMBS;
}

static bool is_figure(ui_mod_kind_t k)
{
    return k == UI_MOD_CHART || k == UI_MOD_TABLE || k == UI_MOD_PEERS ||
           k == UI_MOD_DOSSIER;
}

/* The prose share of the placed ink, as a percentage; -1 when the page has
 * neither class on it and there is nothing to be out of balance. */
static int prose_share(const ui_mod_t *mods, int n)
{
    long long prose = 0, figure = 0;
    for (int i = 0; i < n; i++) {
        if (!mods[i].placed) continue;
        const long long a = (long long)mods[i].w * mods[i].h;
        if (is_prose(mods[i].kind))       prose  += a;
        else if (is_figure(mods[i].kind)) figure += a;
    }
    if (prose + figure <= 0) return -1;
    return (int)(prose * 100 / (prose + figure));
}

/* The rank of the page's most important module, and whether prose holds it —
 * the two facts that decide whether the balance applies at all. */
static int best_rank(const ui_mod_t *mods, int n, bool *prose_leads)
{
    int b = mods[0].rank;
    for (int i = 1; i < n; i++) if (mods[i].rank < b) b = mods[i].rank;

    *prose_leads = false;
    for (int i = 0; i < n; i++)
        if (mods[i].rank == b && is_prose(mods[i].kind)) *prose_leads = true;
    return b;
}

/* --- the nested cut ------------------------------------------------------
 *
 * The one arrangement the tree could not express before: a module that is tall
 * and narrow, with the short ones stacked in the column beside it instead of
 * being levelled to its height. Every height here is exact — TM_FIXED makes
 * `weight` the preferred height — so the whole shape can be written down and
 * checked rather than described. */
static void check_nested_panes(void)
{
    tm_ctx_t ctx = tm(TM_FIXED);
    ui_compose_env_t e = sheet(&ctx, 1400, 16);
    char why[256];

    /* A 900 px module beside a 300 px one. Two more 300 px modules are waiting;
     * one of them fits under the short one (300 + 16 + 300 = 616 of the 900)
     * and the third does not (616 + 16 + 300 overruns), so it starts a band of
     * its own across the full measure. */
    ui_mod_t mods[4] = { mk(UI_MOD_LEAD,  0, 0, 3, 0, 900, false),
                         mk(UI_MOD_STORY, 1, 1, 3, 0, 300, false),
                         mk(UI_MOD_TABLE, 2, 2, 3, 0, 300, false),
                         mk(UI_MOD_PEERS, 3, 3, 3, 0, 300, false) };
    CHECK_INT(ui_compose(&e, mods, 4), 4);
    CHECK(ui_compose_check(&e, mods, 4, why, sizeof why));

    /* The anchor keeps its whole height and its own pane. */
    CHECK_INT(mods[0].band, 0); CHECK_INT(mods[0].slot, 0);
    CHECK_INT(mods[0].col, 0);  CHECK_INT(mods[0].cols, 3);
    CHECK_INT(mods[0].y, 200);  CHECK_INT(mods[0].h, 900);

    /* Two modules stacked in ONE pane: same band, same slot, same columns, and
     * different heights on the page — which is the entire point. */
    CHECK_INT(mods[1].band, 0); CHECK_INT(mods[1].slot, 1);
    CHECK_INT(mods[2].band, 0); CHECK_INT(mods[2].slot, 1);
    CHECK_INT(mods[1].col, 3);  CHECK_INT(mods[1].cols, 3);
    CHECK_INT(mods[2].col, 3);  CHECK_INT(mods[2].cols, 3);
    CHECK_INT(mods[1].y, 200);  CHECK_INT(mods[1].h, 300);
    CHECK_INT(mods[2].h, 300);
    CHECK(mods[2].y > mods[1].y + mods[1].h);

    /* And the stack fills its pane exactly: flush with the anchor at the top
     * and at the foot, so the band is one rectangle however it is cut inside. */
    CHECK_INT(mods[2].y + mods[2].h, mods[0].y + mods[0].h);

    /* The one that did not fit is a band of its own, full measure. */
    CHECK_INT(mods[3].band, 1);
    CHECK_INT(mods[3].col, 0);
    CHECK_INT(mods[3].cols, 6);
    CHECK_INT(mods[3].y + mods[3].h, 200 + 1400);

    /* Two modules of similar height are NOT stacked. This is the rule deriving
     * itself: nothing is pulled forward unless it can be set whole in the room
     * the anchor leaves, so 900 beside 850 leaves 34 px and the third module
     * stays where it was. A ratio would have had to be told this. */
    ui_mod_t level[3] = { mk(UI_MOD_LEAD,  0, 0, 3, 0, 900, false),
                          mk(UI_MOD_STORY, 1, 1, 3, 0, 850, false),
                          mk(UI_MOD_TABLE, 2, 2, 3, 0, 300, false) };
    CHECK_INT(ui_compose(&e, level, 3), 3);
    CHECK(ui_compose_check(&e, level, 3, why, sizeof why));
    CHECK_INT(level[0].band, 0);
    CHECK_INT(level[1].band, 0);
    CHECK_INT(level[2].band, 1);        /* not stacked under the short one */

    /* Nor is a module pulled into a pane too narrow for it. Squeezing it under
     * its own minimum to fill a stack would trade the hole the cut exists to
     * remove for a worse one. */
    ui_mod_t wide[3] = { mk(UI_MOD_LEAD,  0, 0, 3, 0, 900, false),
                         mk(UI_MOD_STORY, 1, 1, 3, 0, 200, false),
                         mk(UI_MOD_TABLE, 2, 2, 4, 0, 200, false) };
    CHECK_INT(ui_compose(&e, wide, 3), 3);
    CHECK(ui_compose_check(&e, wide, 3, why, sizeof why));
    CHECK_INT(wide[2].band, 1);
    CHECK(wide[2].cols >= 4);

    /* Three deep is the limit, and the fourth candidate starts a new band even
     * with room left under it: a column of four stubs is a list of links. */
    ui_mod_t deep[6] = { mk(UI_MOD_LEAD,  0, 0, 3, 0, 1200, false),
                         mk(UI_MOD_STORY, 1, 1, 3, 0,  100, false),
                         mk(UI_MOD_TABLE, 2, 2, 3, 0,  100, false),
                         mk(UI_MOD_PEERS, 3, 3, 3, 0,  100, false),
                         mk(UI_MOD_QUOTE, 4, 4, 3, 0,  100, false),
                         mk(UI_MOD_BRIEFS, 5, 5, 3, 0, 100, false) };
    ui_compose_env_t tall = sheet(&ctx, 1600, 16);
    CHECK_INT(ui_compose(&tall, deep, 6), 6);
    CHECK(ui_compose_check(&tall, deep, 6, why, sizeof why));
    int in_pane = 0;
    for (int i = 0; i < 6; i++)
        if (deep[i].placed && deep[i].band == deep[1].band && deep[i].slot == deep[1].slot)
            in_pane++;
    CHECK_INT(in_pane, 3);
    CHECK(deep[4].band != deep[1].band || deep[4].slot != deep[1].slot);
}

/* The same modules with nobody asking for a banner. */
static void unask(ui_mod_t *dst, const ui_mod_t *src, int n)
{
    for (int i = 0; i < n; i++) {
        dst[i] = src[i];
        dst[i].banner = false;
    }
}

static void check_determinism(void)
{
    tm_ctx_t ctx = tm(TM_COPY);
    ui_compose_env_t e = sheet(&ctx, 1310, 16);

    /* Equal ranks throughout, which is where a sort that is not stable shows
     * up: the fingerprint says nothing changed, the compositor rearranges the
     * page anyway, and the device spends twenty-five seconds redrawing the same
     * news. */
    ui_mod_t a[9], b[9];
    for (int i = 0; i < 9; i++) {
        a[i] = mk((ui_mod_kind_t)(1 + i % 6), i, i / 3, (i % 3) + 1, i == 4 ? 3 : 0,
                  40 * i + 7, (i & 1) != 0);
        b[i] = a[i];
    }

    const int pa = ui_compose(&e, a, 9);
    const int pb = ui_compose(&e, b, 9);
    CHECK_INT(pa, pb);
    for (int i = 0; i < 9; i++) CHECK(same(&a[i], &b[i]));

    /* And composing the already-composed array again is the same page: the
     * sort is stable, so a second pass cannot reshuffle equal ranks. */
    ui_mod_t c[9];
    for (int i = 0; i < 9; i++) c[i] = a[i];
    CHECK_INT(ui_compose(&e, c, 9), pa);
    for (int i = 0; i < 9; i++) CHECK(same(&a[i], &c[i]));
}

/* --- 7. the banner --------------------------------------------------------
 *
 * The complaint the cut was made for is that the page was too horizontal: with
 * the rail pinned to the left for the full height of the well, every package on
 * the sheet was five columns wide and short, and the body could only ever be
 * sliced into bands. These check the shape that fixes it — a full-measure band
 * across the top with the whole rest of the page beginning underneath it — and,
 * more importantly, the three ways of NOT getting it. */

static void check_banner_shape(void)
{
    tm_ctx_t ctx = tm(TM_FIXED);
    ui_compose_env_t e = sheet(&ctx, 1000, 16);
    char why[256];

    ui_mod_t mods[3] = { mk(UI_MOD_LEAD,  0, 0, 2, 0, 400, true),
                         mk(UI_MOD_STORY, 1, 1, 2, 0, 300, true),
                         mk(UI_MOD_STORY, 2, 2, 2, 0, 300, true) };
    mods[0].banner = true;

    CHECK_INT(ui_compose(&e, mods, 3), 3);
    CHECK(ui_compose_check(&e, mods, 3, why, sizeof why));

    CHECK(mods[0].bannered);
    CHECK(!mods[1].bannered);
    CHECK(!mods[2].bannered);

    /* Alone in its band, across every column, at the top of the well. */
    CHECK_INT(mods[0].band, 0);
    CHECK_INT(mods[0].slot, 0);
    CHECK_INT(mods[0].col, 0);
    CHECK_INT(mods[0].cols, 6);
    CHECK_INT(mods[0].x, 30);
    CHECK_INT(mods[0].w, 1140);
    CHECK_INT(mods[0].y, 200);
    CHECK_INT(mods[0].h, 400);                  /* what it asked for: nothing squeezed it */

    /* And the story runs down UNDER it rather than in a band beside it. */
    CHECK_INT(mods[1].y, 200 + 400 + 16);
    CHECK_INT(mods[2].y, 200 + 400 + 16);
    CHECK_INT(mods[1].h, 1000 - 400 - 16);
    CHECK_INT(mods[1].band, 1);
    CHECK_INT(mods[2].band, 1);
    CHECK_INT(mods[1].cols, 3);
    CHECK_INT(mods[2].cols, 3);
    CHECK_INT(mods[1].y + mods[1].h, 200 + 1000);

    /* With a rail, the banner is band 0 and the rail is band 1, running from
     * the banner's foot to the well's rather than the whole height of the
     * sheet. That single fact is the point of the cut: the rail no longer pins
     * the page into horizontal slices. */
    ui_mod_t rail[4] = { mk(UI_MOD_LEAD,    0, 0, 2, 0, 400, true),
                         mk(UI_MOD_DOSSIER, 1, 1, 1, 0, 900, false),
                         mk(UI_MOD_STORY,   2, 2, 2, 0, 300, true),
                         mk(UI_MOD_STORY,   3, 3, 2, 0, 300, true) };
    rail[0].banner = true;

    CHECK_INT(ui_compose(&e, rail, 4), 4);
    CHECK(ui_compose_check(&e, rail, 4, why, sizeof why));
    CHECK(rail[0].bannered);
    CHECK_INT(rail[0].band, 0);
    CHECK_INT(rail[0].cols, 6);
    CHECK_INT(rail[0].h, 400);
    CHECK_INT(rail[1].band, 1);
    CHECK_INT(rail[1].col, 0);
    CHECK_INT(rail[1].cols, 1);
    CHECK_INT(rail[1].y, 200 + 400 + 16);
    CHECK_INT(rail[1].y + rail[1].h, 200 + 1000);
    CHECK_INT(rail[2].y, rail[1].y);
    CHECK_INT(rail[2].col, 1);

    /* A banner with nothing under it is not a banner, it is the page — and a
     * lone module already takes the whole well without having to ask. */
    ui_mod_t solo = mk(UI_MOD_LEAD, 0, 0, 2, 0, 400, true);
    solo.banner = true;
    CHECK_INT(ui_compose(&e, &solo, 1), 1);
    CHECK(ui_compose_check(&e, &solo, 1, why, sizeof why));
    CHECK(!solo.bannered);
    CHECK_INT(solo.cols, 6);
    CHECK_INT(solo.h, 1000);
}

static void check_banner_squeeze(void)
{
    tm_ctx_t ctx = tm(TM_FIXED);
    ui_compose_env_t e = sheet(&ctx, 1000, 16);
    char why[256];

    /* A banner whose preferred height would starve the rest comes back
     * shortened, with everything else still placed. 1000 px of well, 16 of it
     * the cut's own leading; the two stories insist on 150 between them and get
     * exactly that, so the banner keeps 834 of the 1200 it wanted — and stays
     * well over the 600 it would not go under. */
    ui_mod_t mods[3] = { mk(UI_MOD_LEAD,  0, 0, 2, 0, 1200, true),
                         mk(UI_MOD_STORY, 1, 1, 2, 0, 300, true),
                         mk(UI_MOD_STORY, 2, 2, 2, 0, 300, true) };
    mods[0].banner = true;

    CHECK_INT(ui_compose(&e, mods, 3), 3);
    CHECK(ui_compose_check(&e, mods, 3, why, sizeof why));
    CHECK(mods[0].bannered);
    CHECK(mods[1].placed);
    CHECK(mods[2].placed);
    CHECK_INT(mods[0].h, 834);
    CHECK(mods[0].h >= 600);                    /* never under its own minimum */
    CHECK_INT(mods[1].h, 150);
    CHECK_INT(mods[1].y, 200 + 834 + 16);
    CHECK_INT(mods[1].y + mods[1].h, 200 + 1000);

    /* And the squeeze stops the moment the rest of the page clears its
     * minimum: it is not a demotion to h_min, it is exactly the difference.
     * Two stories wanting 400 apiece leave 584 for a banner that asked for
     * 700, which is neither of the two heights it named. */
    ui_mod_t part[3] = { mk(UI_MOD_LEAD,  0, 0, 2, 0, 700, true),
                         mk(UI_MOD_STORY, 1, 1, 2, 0, 800, true),
                         mk(UI_MOD_STORY, 2, 2, 2, 0, 800, true) };
    part[0].banner = true;

    CHECK_INT(ui_compose(&e, part, 3), 3);
    CHECK(ui_compose_check(&e, part, 3, why, sizeof why));
    CHECK(part[0].bannered);
    CHECK_INT(part[0].h, 584);
    CHECK(part[0].h > 350 && part[0].h < 700);  /* between the two, not at either */
    CHECK_INT(part[1].h, 400);
    CHECK_INT(part[1].y + part[1].h, 200 + 1000);
}

static void check_banner_give_up(void)
{
    tm_ctx_t ctx = tm(TM_FIXED);
    ui_compose_env_t e = sheet(&ctx, 1000, 16);
    char why[256];

    /* A banner that cannot be honoured even at its own minimum without taking
     * the rest of the page down with it is not honoured at all. What comes back
     * is asserted against the sheet that would have been made up had the
     * request never been filed, field for field, rather than described — "as
     * though it were never made" is the whole of the promise, and a description
     * would only check the parts somebody thought of. */
    ui_mod_t mods[3] = { mk(UI_MOD_LEAD,  0, 0, 2, 0, 1800, true),
                         mk(UI_MOD_STORY, 1, 1, 2, 0, 300, true),
                         mk(UI_MOD_STORY, 2, 2, 2, 0, 300, true) };
    mods[0].banner = true;

    ui_mod_t plain[3];
    unask(plain, mods, 3);

    tm_ctx_t bare_ctx = tm(TM_FIXED);
    ui_compose_env_t bare = sheet(&bare_ctx, 1000, 16);

    CHECK_INT(ui_compose(&e, mods, 3), 3);
    CHECK_INT(ui_compose(&bare, plain, 3), 3);
    CHECK(ui_compose_check(&e, mods, 3, why, sizeof why));
    for (int i = 0; i < 3; i++) CHECK(same_page(&mods[i], &plain[i]));

    CHECK(!mods[0].bannered);
    CHECK(mods[0].banner);              /* the request itself is the caller's, and untouched */

    /* On an over-supplied page the sheet drops copy either way, and the refusal
     * must not cost it a module the page without the request would have
     * printed. Eight stories in a 1000 px well is exactly that page. */
    ui_mod_t many[8], none[8];
    for (int i = 0; i < 8; i++) many[i] = mk(UI_MOD_STORY, i, i, 2, 0, 500, true);
    many[0].kind   = UI_MOD_LEAD;
    many[0].weight = 1900;
    many[0].banner = true;
    unask(none, many, 8);

    const int pa = ui_compose(&e, many, 8);
    const int pb = ui_compose(&bare, none, 8);
    CHECK_INT(pa, pb);
    CHECK(pa < 8);                      /* it really is an over-supplied page */
    CHECK(ui_compose_check(&e, many, 8, why, sizeof why));
    for (int i = 0; i < 8; i++) CHECK(same_page(&many[i], &none[i]));
    for (int i = 0; i < 8; i++) CHECK(!many[i].bannered);

    /* THE CASE `bannered` EXISTS FOR, built on purpose because it has to be
     * shown rather than asserted.
     *
     * A module asks for the banner, is refused — and the ordinary packing then
     * puts it alone on a full-measure band at the top of the well anyway. Every
     * number a page could read off the geometry is identical to an honoured
     * banner: band 0, column 0, all six columns, flush with the top, nothing
     * beside it. Only `bannered` separates them, and the two want different ink
     * in that rectangle.
     *
     * The generated sweep does not reach this on its own — it counts the case
     * and reports zero, because a rail takes band 0 on five pages in six. That
     * is exactly why it is written out by hand here: a field justified by a
     * case nobody can produce is a field that should not exist, and this is the
     * case. */
    tm_ctx_t fixed = tm(TM_FIXED);
    ui_compose_env_t deep = sheet(&fixed, 2245, 27);

    ui_mod_t look[4] = { mk(UI_MOD_TABLE,  0, 2, 6, 6, 1423, true),
                         mk(UI_MOD_BRIEFS, 1, 2, 0, 5, 1486, false),
                         mk(UI_MOD_THUMBS, 2, 3, 3, 3, 1490, false),
                         mk(UI_MOD_QUOTE,  3, 4, 6, 4, 1478, false) };
    look[0].banner = true;

    /* Refused by four pixels: the asker will not go under 711, and the three
     * modules behind it will not fit into less than 1511 of the 2218 that are
     * left once the cut's own leading is paid for. Then the ordinary packing
     * gives it all six columns at the top of the well regardless, because a
     * six-column minimum is alone in its band wherever it lands. */
    CHECK(ui_compose(&deep, look, 4) < 4);
    CHECK(ui_compose_check(&deep, look, 4, why, sizeof why));

    CHECK(!look[0].bannered);           /* refused ... */
    CHECK(look[0].banner);              /* ... though it did ask ... */
    CHECK_INT(look[0].band, 0);         /* ... and is indistinguishable from one */
    CHECK_INT(look[0].slot, 0);
    CHECK_INT(look[0].col, 0);
    CHECK_INT(look[0].cols, 6);
    CHECK_INT(look[0].y, 200);
    for (int i = 1; i < 4; i++) CHECK(!look[i].placed || look[i].band != 0);
}

static void check_banner_tie(void)
{
    tm_ctx_t ctx = tm(TM_FIXED);
    ui_compose_env_t e = sheet(&ctx, 1200, 16);
    char why[256];

    /* Two askers: the lower rank takes the band and the other is composed
     * normally, because two full-measure bands stacked at the top of a page is
     * not a banner, it is a page with no rail. */
    ui_mod_t mods[3] = { mk(UI_MOD_STORY, 0, 3, 2, 0, 300, true),
                         mk(UI_MOD_LEAD,  1, 1, 2, 0, 400, true),
                         mk(UI_MOD_STORY, 2, 5, 2, 0, 300, true) };
    mods[0].banner = true;
    mods[1].banner = true;

    CHECK_INT(ui_compose(&e, mods, 3), 3);
    CHECK(ui_compose_check(&e, mods, 3, why, sizeof why));

    /* The array comes back in rank order, so they are found by src. */
    int win = -1, lost = -1;
    for (int i = 0; i < 3; i++) {
        if (mods[i].src == 1) win  = i;
        if (mods[i].src == 0) lost = i;
    }
    CHECK(win >= 0 && lost >= 0);
    CHECK(mods[win].bannered);
    CHECK(!mods[lost].bannered);
    CHECK_INT(mods[win].band, 0);
    CHECK_INT(mods[win].cols, 6);
    CHECK_INT(mods[lost].band, 1);
    CHECK(mods[lost].cols < 6);
    CHECK(mods[lost].y >= mods[win].y + mods[win].h);

    /* Equal ranks are settled by arrival, because the sort is stable — a page
     * that reshuffles two identical requests between polls is twenty-five
     * seconds of panel spent on news that did not change. */
    ui_mod_t twins[3] = { mk(UI_MOD_LEAD,  7, 2, 2, 0, 400, true),
                          mk(UI_MOD_LEAD,  8, 2, 2, 0, 400, true),
                          mk(UI_MOD_STORY, 9, 4, 2, 0, 300, true) };
    twins[0].banner = true;
    twins[1].banner = true;

    CHECK_INT(ui_compose(&e, twins, 3), 3);
    CHECK(ui_compose_check(&e, twins, 3, why, sizeof why));
    for (int i = 0; i < 3; i++) {
        if (twins[i].src == 7) CHECK(twins[i].bannered);
        else                   CHECK(!twins[i].bannered);
    }

    /* And the answer is an answer, not a second request: composing the composed
     * array again is the same page. A compositor that cleared the losers'
     * requests as it read them would banner a different module on the second
     * pass, which is the one thing news_hash() has promised cannot happen. */
    ui_mod_t again[3];
    for (int i = 0; i < 3; i++) again[i] = twins[i];
    CHECK_INT(ui_compose(&e, again, 3), 3);
    for (int i = 0; i < 3; i++) CHECK(same(&twins[i], &again[i]));
}

/* --- 8. honest minimums, and whether they change the page ------------------
 *
 * Raising a module's h_min to an honest value is only worth doing if it changes
 * what reaches the glass. If an honest minimum were simply CLAMPED back down,
 * the sheet would print the same misleading one-row comparison and the whole
 * exercise would buy nothing — so this is the test that says the effort pays.
 *
 * It answers three separate questions, because they have three different
 * answers and the third one is a trap. */

/* h_min at the width the module actually ended up with. */
static int hmin_of(const ui_mod_t *m, tm_mode_t mode)
{
    tm_ctx_t probe = tm(mode);
    int lo = 0, hi = 0;
    tm_measure(m, m->w > 0 ? m->w : 1, &lo, &hi, &probe);
    return lo < 1 ? 1 : lo;
}

static void check_honest_minimums(void)
{
    tm_ctx_t ctx = tm(TM_FIXED);
    ui_compose_env_t e = sheet(&ctx, UI_TEST_WELL_H, 14);   /* the real well */
    char why[256];

    /* 1. DOES IT CHANGE THE PAGE? The same seven modules twice, once claiming
     * they can live on almost nothing and once telling the truth.
     *
     * Dishonest, every inelastic module claims it needs 60 px: the banner is
     * honoured and the five of them are handed SEVENTY-FOUR PIXELS EACH, one to
     * a band. That is the disease — five modules that are technically placed,
     * technically legal, and each one a label with a single row under it.
     *
     * Honest, the same five insist on 300: the banner is refused, the cut tree
     * comes out differently, and every one of them gets 355 px or better. Same
     * modules, same well, nothing dropped — a completely different sheet. */
    ui_mod_t liar[7] = { mk(UI_MOD_LEAD,    0, 0, 2, 0, 900, true),
                         mk(UI_MOD_DOSSIER, 1, 1, 1, 0, 600, false),
                         mk(UI_MOD_TABLE,   2, 2, 3, 0, 120, false),
                         mk(UI_MOD_PEERS,   3, 3, 3, 0, 120, false),
                         mk(UI_MOD_BRIEFS,  4, 4, 3, 0, 120, false),
                         mk(UI_MOD_THUMBS,  5, 5, 3, 0, 120, false),
                         mk(UI_MOD_QUOTE,   6, 6, 3, 0, 120, false) };
    liar[0].banner = true;

    ui_mod_t honest[7] = { mk(UI_MOD_LEAD,    0, 0, 2, 0, 900, true),
                           mk(UI_MOD_DOSSIER, 1, 1, 1, 0, 600, false),
                           mk(UI_MOD_TABLE,   2, 2, 3, 0, 600, false),
                           mk(UI_MOD_PEERS,   3, 3, 3, 0, 600, false),
                           mk(UI_MOD_BRIEFS,  4, 4, 3, 0, 600, false),
                           mk(UI_MOD_THUMBS,  5, 5, 3, 0, 600, false),
                           mk(UI_MOD_QUOTE,   6, 6, 3, 0, 600, false) };
    honest[0].banner = true;

    CHECK_INT(ui_compose(&e, liar, 7), 7);
    CHECK(ui_compose_check(&e, liar, 7, why, sizeof why));
    CHECK_INT(ui_compose(&e, honest, 7), 7);
    CHECK(ui_compose_check(&e, honest, 7, why, sizeof why));

    /* The liar's inelastic modules are each given a strip. The honest ones are
     * given something a reader could use. Nothing was dropped either way — the
     * gain is entirely in how the well was divided. */
    for (int i = 0; i < 7; i++) {
        if (liar[i].kind == UI_MOD_LEAD || liar[i].kind == UI_MOD_DOSSIER) continue;
        CHECK(liar[i].h < 100);
    }
    for (int i = 0; i < 7; i++) {
        if (honest[i].kind == UI_MOD_LEAD || honest[i].kind == UI_MOD_DOSSIER) continue;
        CHECK(honest[i].h >= 300);
        CHECK(honest[i].h >= hmin_of(&honest[i], TM_FIXED));
    }

    /* 2. ON A PAGE THAT GENUINELY CANNOT HOLD THEM, DO THEY LEAVE? They do, and
     * from the back by rank — the reader loses the least important thing on the
     * sheet rather than whatever was measured last. */
    ui_mod_t over[7] = { mk(UI_MOD_LEAD,   0, 0, 2, 0, 900, true),
                         mk(UI_MOD_TABLE,  1, 1, 3, 0, 900, false),
                         mk(UI_MOD_PEERS,  2, 2, 3, 0, 900, false),
                         mk(UI_MOD_BRIEFS, 3, 3, 3, 0, 900, false),
                         mk(UI_MOD_THUMBS, 4, 4, 3, 0, 900, false),
                         mk(UI_MOD_QUOTE,  5, 5, 3, 0, 900, false) };
    over[0].banner = true;

    const int placed = ui_compose(&e, over, 6);
    CHECK(ui_compose_check(&e, over, 6, why, sizeof why));
    CHECK(placed < 6);                       /* something had to go */

    bool gone = false;
    for (int i = 0; i < 6; i++) {
        if (!over[i].placed) { gone = true; continue; }
        CHECK(!gone);                        /* the tail left, not the middle */
        /* With one region and something left to drop, every survivor clears
         * its own minimum. This is the case the honest minimums are FOR. */
        CHECK(over[i].h >= hmin_of(&over[i], TM_FIXED));
    }

    /* 3. THE TRAP, AND IT IS WHY "raise h_min and survivors will be honest" IS
     * NOT TRUE AS STATED. Put a rail on the same page. The rail's foot cuts the
     * well in two, and the LOWER REGION can come out holding exactly one band —
     * at which point the drop loop has nothing left to drop and the band is
     * CLAMPED instead. Both modules in it are then set under their own minimum,
     * with two more dropped below them.
     *
     * So an honest h_min buys the drop everywhere EXCEPT the last band of a
     * region, and there it buys nothing at all: the page still prints the lie,
     * it just prints a differently-shaped one. That is not a bug in the fit —
     * dropping the band would leave the lower region bare, which is the one
     * thing this file may not produce — but it is a real limit on what raising
     * the minimums can achieve, and it is invisible unless somebody counts. */
    ui_mod_t split[7] = { mk(UI_MOD_LEAD,    0, 0, 2, 0, 900, true),
                          mk(UI_MOD_DOSSIER, 1, 1, 1, 0, 900, false),
                          mk(UI_MOD_TABLE,   2, 2, 3, 0, 900, false),
                          mk(UI_MOD_PEERS,   3, 3, 3, 0, 900, false),
                          mk(UI_MOD_BRIEFS,  4, 4, 3, 0, 900, false),
                          mk(UI_MOD_THUMBS,  5, 5, 3, 0, 900, false),
                          mk(UI_MOD_QUOTE,   6, 6, 3, 0, 900, false) };
    split[0].banner = true;

    CHECK(ui_compose(&e, split, 7) < 7);
    CHECK(ui_compose_check(&e, split, 7, why, sizeof why));

    int starved = 0, starved_band = -1;
    for (int i = 0; i < 7; i++) {
        if (!split[i].placed) continue;
        if (split[i].h >= hmin_of(&split[i], TM_FIXED)) continue;
        starved++;
        /* Every starved survivor is in ONE band — the last one in its region.
         * If this ever spreads across two, the clamp has stopped being the
         * bounded exception the header describes. */
        if (starved_band < 0) starved_band = split[i].band;
        CHECK_INT(split[i].band, starved_band);
    }
    CHECK(starved > 0);      /* if this stops firing, say so — it is the limit */
}

/* --- 9. the headline weights ---------------------------------------------- */

static void check_head_weight(void)
{
    /* Rank picks the face: the lead, the secondary row, everything else. */
    CHECK_INT(ui_head_weight(0, 6, -1), 0);
    CHECK_INT(ui_head_weight(1, 6, -1), 1);
    CHECK_INT(ui_head_weight(2, 6, -1), 1);
    CHECK_INT(ui_head_weight(3, 6, -1), 2);
    CHECK_INT(ui_head_weight(99, 6, -1), 2);

    /* A payload numbered 10, 20, 30 must not set differently from one numbered
     * 0, 1, 2 — but that is the page's job, so here the only claim is that rank
     * is monotone: a later story never gets a bigger face. */
    for (int r = 1; r < 40; r++)
        CHECK(ui_head_weight(r, 6, -1) >= ui_head_weight(r - 1, 6, -1));

    /* Two columns is a smaller face at the same rank. */
    CHECK_INT(ui_head_weight(0, 2, -1), 1);
    CHECK_INT(ui_head_weight(0, 5, -1), 0);
    CHECK(ui_head_weight(3, 2, -1) > ui_head_weight(3, 5, -1));

    /* And it never comes out equal to the module on its left, at any rank, at
     * any width, against any neighbour — including the bottom of the range,
     * where there is no smaller face to demote into and the answer has to go
     * the other way. */
    for (int rank = -2; rank < 24; rank++) {
        for (int cols = 1; cols <= 8; cols++) {
            for (int left = -1; left <= 4; left++) {
                const int wt = ui_head_weight(rank, cols, left);
                CHECK(wt >= 0 && wt <= 3);
                if (left >= 0 && left <= 3) CHECK(wt != left);
            }
        }
    }
    CHECK_INT(ui_head_weight(9, 1, 3), 2);
}

/* --- 10. the sweep -------------------------------------------------------- */

static uint32_t g_seed;

static uint32_t lcg(void)
{
    g_seed = g_seed * 1664525u + 1013904223u;
    return g_seed >> 8;                 /* the high bits; the low ones cycle */
}

static int pick(int lo, int hi)
{
    return lo + (int)(lcg() % (uint32_t)(hi - lo + 1));
}

static void check_sweep(void)
{
    char why[256];
    int cases = 0, illegal = 0, structural = 0, odd = 0;
    int over_measured = 0, stale_width = 0, worst_calls = 0;
    int split_seen = 0, dropped_seen = 0, rail_seen = 0, three_across = 0;
    int leading_seen = 0, stacked_seen = 0, deepest_pane = 0;
    int ban_asked = 0, ban_won = 0, ban_squeezed = 0, ban_refused = 0, ban_tie = 0;
    int ban_cost_a_module = 0, ban_refusal_moved_the_page = 0;
    int ban_refused_looks_bannered = 0;
    int under_min = 0, under_min_worst = 0, under_min_stacked = 0, under_min_banner = 0;

    g_seed = 20260814u;

    for (int t = 0; t < 6000; t++) {
        tm_ctx_t ctx = tm((t % 17 == 0) ? TM_HOSTILE : ((t % 3 == 0) ? TM_FIXED : TM_COPY));

        const int n = pick(1, UI_MOD_MAX);
        ui_compose_env_t e = sheet(&ctx, pick(60, 2200), pick(0, 30));

        ui_mod_t mods[UI_MOD_MAX];
        int askers = 0;
        for (int i = 0; i < n; i++) {
            ui_mod_kind_t kind = (ui_mod_kind_t)pick(1, UI_MOD_KIND_COUNT - 1);
            if (pick(0, 5) == 0) kind = UI_MOD_DOSSIER;      /* rails, on purpose */

            /* Mostly narrow, because that is what fills bands and builds
             * stacks — but one module in eight may demand most of the measure,
             * which is the only way the sweep ever reaches a module alone on a
             * full-measure band. Without that tail the census below reports a
             * flat zero for the refused-banner-looks-bannered case and reads as
             * proof it cannot happen, when it is only proof of the generator. */
            const int min_cols = pick(0, 7) == 0 ? pick(5, 6) : pick(0, 4);
            const int max_cols = pick(0, 3) == 0 ? pick(1, 7) : 0;
            mods[i] = mk(kind, i, pick(0, 6), min_cols, max_cols,
                         pick(0, 3) == 0 ? 0 : pick(1, 900), pick(0, 1) != 0);

            /* Banners on a good fraction of the pages, and often more than one
             * asker, so the tie and the refusal are exercised rather than
             * assumed. Any kind may ask: the compositor has no business
             * deciding that a chart is not allowed to want the measure. */
            if (pick(0, 7) == 0) { mods[i].banner = true; askers++; }
        }

        /* The same page with nobody asking, kept to hold the two promises the
         * geometry alone cannot show: that a refusal produces exactly the sheet
         * that would have existed anyway, and that a banner never costs the
         * page a module. Its own context, so the measurement counters below
         * still describe the composition they are asserted about. */
        ui_mod_t plain[UI_MOD_MAX];
        tm_ctx_t plain_ctx = tm(ctx.mode);
        ui_compose_env_t plain_e = e;
        plain_e.ctx = &plain_ctx;
        int plain_placed = 0;
        if (askers > 0) {
            unask(plain, mods, n);
            plain_placed = ui_compose(&plain_e, plain, n);
        }

        const int placed = ui_compose(&e, mods, n);
        cases++;

        /* What the measurement budget is on this page.
         *
         * Three: one measurement at the module's final width, plus the one
         * speculative ask the nested cut costs — a candidate has to be measured
         * to find out whether it fits under the module beside it, and one that
         * does not fit starts the next band, where its width is different. And
         * six when a banner was asked for and refused, because the page was
         * then made up a second time without it. */
        int budget = 3;

        if (askers > 0) {
            ban_asked++;
            if (askers > 1) ban_tie++;

            int ban = -1;
            for (int i = 0; i < n; i++) if (mods[i].bannered) { ban = i; break; }

            if (ban >= 0) {
                ban_won++;

                /* THE promise. A banner is squeezed as far as it takes for
                 * everything else to clear its own minimum, so a page that got
                 * one has nothing left off it — if this ever fires, the squeeze
                 * is arithmetic and not a guarantee. */
                if (placed != n) ban_cost_a_module++;

                /* Was it actually squeezed? The test knows the page's own
                 * measurement, so it can ask what the banner wanted; a separate
                 * context, so asking does not disturb the call counts. */
                tm_ctx_t probe = tm(ctx.mode);
                int b_min = 0, b_pref = 0;
                tm_measure(&mods[ban], mods[ban].w, &b_min, &b_pref, &probe);
                if (mods[ban].h < b_pref) ban_squeezed++;
            } else {
                ban_refused++;
                budget = 6;

                /* The path that stops being hypothetical the moment honest
                 * minimums start forcing refusals: the asker is refused, and
                 * the ORDINARY packing then lands it alone on a full-measure
                 * band at the top of the well anyway — a rectangle
                 * indistinguishable from the banner it did not get. This is
                 * exactly why the page must branch on `bannered` and never on
                 * the geometry, and counting it is how we know the case is real
                 * rather than a thing somebody imagined. */
                for (int i = 0; i < n; i++) {
                    if (!mods[i].banner) continue;      /* the would-be winner */
                    if (mods[i].placed && mods[i].band == 0 && mods[i].col == 0 &&
                        mods[i].cols == e.cols && mods[i].y == e.y) {
                        bool alone = true;
                        for (int j = 0; j < n; j++)
                            if (j != i && mods[j].placed && mods[j].band == 0) alone = false;
                        if (alone) ban_refused_looks_bannered++;
                    }
                    break;
                }

                /* Refused means refused: the sheet is the one that would have
                 * been made up had the request never been filed. */
                if (placed != plain_placed) ban_refusal_moved_the_page++;
                else for (int i = 0; i < n; i++)
                    if (!same_page(&mods[i], &plain[i])) { ban_refusal_moved_the_page++; break; }
            }
        }

        if (placed < 1) {
            if (illegal++ == 0) printf("  case %d: nothing was placed at all\n", t);
            continue;
        }

        if (!ui_compose_check(&e, mods, n, why, sizeof why)) {
            if (illegal++ < 3) printf("  case %d (n=%d h=%d gap=%d): %s\n",
                                      t, n, e.h, e.band_gap, why);
            continue;
        }

        const char *msg = verify(&e, mods, n);
        if (msg != NULL && structural++ < 3)
            printf("  case %d (n=%d h=%d gap=%d): %s\n", t, n, e.h, e.band_gap, msg);

        for (int i = 0; i < n; i++)
            if (mods[i].placed && ((mods[i].x & 1) || (mods[i].w & 1))) odd++;

        /* The measurement budget. On the device the callback runs LVGL's line
         * breaker over a 1400-byte story, so a compositor that re-measures
         * inside a retry loop costs a second of wall clock on every poll — and
         * one that measures at a width the module does not end up with has
         * copyfitted the page to the wrong column. The worst case is printed
         * as well as asserted, because a bound nobody looks at is a bound that
         * drifts up one change at a time. */
        for (int i = 0; i < n; i++) {
            const int c = ctx.calls[mods[i].src];
            if (c > budget) over_measured++;
            if (c > worst_calls) worst_calls = c;
            if (mods[i].placed && ctx.last_w[mods[i].src] != mods[i].w) stale_width++;
        }

        /* A placed module SHORTER THAN ITS OWN h_min.
         *
         * ui_compose.h used to say this could not happen, and `ui` found that it
         * could — by printing every row of a table into a box that had not been
         * given room for them, straight through the module below. It can: the
         * last band in a region is CLAMPED rather than dropped, because bare
         * paper at the foot of the well is the one thing this file may not
         * produce. A drawing routine must read `h`, never its own h_min.
         *
         * Counted rather than forbidden, so the exception cannot widen into the
         * rule unnoticed. The two that must stay at ZERO are the ones that would
         * mean a feature had broken it. Inside a stack of two or more: a pane's
         * members are fitted together, so a starved one would mean the nested
         * cut is dividing a pane it never fitted. And on a page whose banner was
         * honoured: the banner is squeezed against a height at which everything
         * left clears its own minimum, so one appearing there would mean `need`
         * had stopped being a guarantee and had become an estimate. */
        for (int i = 0; i < n; i++) {
            if (!mods[i].placed) continue;

            tm_ctx_t probe = tm(ctx.mode);
            int lo = 0, hi = 0;
            tm_measure(&mods[i], mods[i].w, &lo, &hi, &probe);
            if (lo < 1) lo = 1;                 /* the floor cp_ask() applies */
            if (mods[i].h >= lo) continue;

            under_min++;
            if (lo - mods[i].h > under_min_worst) under_min_worst = lo - mods[i].h;

            for (int j = 0; j < n; j++)
                if (j != i && mods[j].placed &&
                    mods[j].band == mods[i].band && mods[j].slot == mods[i].slot) {
                    under_min_stacked++;
                    break;
                }

            for (int j = 0; j < n; j++)
                if (mods[j].bannered) { under_min_banner++; break; }
        }

        /* Did the generator actually reach the interesting arrangements? A
         * sweep that never produced a split or a drop would pass while testing
         * a third of the file. */
        int rail = -1;
        for (int i = 0; i < n; i++)
            if (mods[i].kind == UI_MOD_DOSSIER) { rail = i; break; }
        if (rail >= 0 && n > 1 && mods[rail].placed && mods[rail].col == 0) {
            rail_seen++;
            if (mods[rail].h < e.h) split_seen++;
        }
        for (int i = 0; i < n; i++) if (!mods[i].placed) { dropped_seen++; break; }
        for (int i = 0; i < n; i++) if (mods[i].placed && mods[i].slot == 2) { three_across++; break; }

        /* The nested cut: two placed modules sharing a band AND a pane are a
         * stack, which is the arrangement the tree could not express at all
         * before. Counted per page, and the deepest stack anywhere recorded, so
         * a change that quietly stops the path running shows up as a census
         * that went to zero rather than as a suite that still passes. */
        bool stacked_here = false;
        for (int i = 0; i < n; i++) {
            if (!mods[i].placed) continue;
            int deep = 0;
            for (int j = 0; j < n; j++)
                if (mods[j].placed && mods[j].band == mods[i].band &&
                    mods[j].slot == mods[i].slot) deep++;
            if (deep > 1) stacked_here = true;
            if (deep > deepest_pane) deepest_pane = deep;
        }
        if (stacked_here) stacked_seen++;

        /* Did any page put its surplus into the leading rather than into a
         * module? Two placed modules in the same column, further apart than the
         * band gap, is what that looks like from outside. */
        bool leading_seen_here = false;
        for (int i = 0; i < n && !leading_seen_here; i++) {
            if (!mods[i].placed) continue;
            for (int j = 0; j < n; j++) {
                if (i == j || !mods[j].placed) continue;
                if (mods[j].col >= mods[i].col + mods[i].cols ||
                    mods[i].col >= mods[j].col + mods[j].cols) continue;
                if (mods[j].y >= mods[i].y + mods[i].h + e.band_gap + 1) {
                    leading_seen_here = true;
                    break;
                }
            }
        }
        if (leading_seen_here) leading_seen++;
    }

    printf("  %d generated pages: %d with a rail, %d cut at the rail's foot, "
           "%d that dropped copy, %d with three across a band, "
           "%d that spent their surplus as leading\n",
           cases, rail_seen, split_seen, dropped_seen, three_across, leading_seen);
    printf("  %d of them cut a band's pane horizontally (deepest stack %d), "
           "and no module was measured more than %d times\n",
           stacked_seen, deepest_pane, worst_calls);
    printf("  %d of them asked for a banner (%d of those with more than one asker): "
           "%d got it, %d of those squeezed to make the room; "
           "%d refused and made up again as though nobody had asked\n",
           ban_asked, ban_tie, ban_won, ban_squeezed, ban_refused);
    printf("  %d of the refusals landed on a full-measure top band ANYWAY through "
           "ordinary packing — geometry a page cannot tell from a real banner, "
           "which is what `bannered` is for\n", ban_refused_looks_bannered);
    printf("  %d placed modules came back under their own h_min (worst %d px short) — "
           "the last band in a region, clamped rather than dropped; "
           "%d of them inside a stack, %d under an honoured banner\n",
           under_min, under_min_worst, under_min_stacked, under_min_banner);

    CHECK_INT(cases, 6000);
    CHECK_INT(illegal, 0);
    CHECK_INT(structural, 0);
    CHECK_INT(odd, 0);
    CHECK_INT(over_measured, 0);
    CHECK_INT(stale_width, 0);
    CHECK(rail_seen > 200);
    CHECK(split_seen > 100);
    CHECK(dropped_seen > 100);
    CHECK(three_across > 200);
    CHECK(leading_seen > 100);
    CHECK(stacked_seen > 200);
    CHECK_INT(deepest_pane, 3);

    /* The two banner promises, over every page that asked. */
    CHECK_INT(ban_cost_a_module, 0);
    CHECK_INT(ban_refusal_moved_the_page, 0);

    /* The h_min exception, pinned. It HAPPENS — that is the contract, and the
     * page must draw to `h` — but never inside a stack and never under an
     * honoured banner. */
    CHECK_INT(under_min_stacked, 0);
    CHECK_INT(under_min_banner, 0);
    CHECK(under_min > 0);       /* if this stops firing, the contract changed */

    /* And the paths were actually walked. A sweep that never refused a banner
     * would pass while testing half of the cut. */
    CHECK(ban_asked > 1000);
    CHECK(ban_tie > 400);
    CHECK(ban_won > 500);
    CHECK(ban_squeezed > 100);
    CHECK(ban_refused > 50);
}

/* --- 12. the class balance, over generated pages --------------------------
 *
 * The balance was implemented, `ui_compose_check()` was taught its
 * postcondition, and NOTHING SET `prose_pct`. Every case in this file went
 * through `sheet()`, which memsets, so the whole mechanism sat behind a branch
 * no test ever took: the suite reported nine green tests while the rule the
 * owner actually asked for was unexercised. That is the failure this sweep
 * exists to make impossible, and it is why the census below asserts that each
 * path was WALKED rather than merely that nothing broke — a balance sweep that
 * never fired would pass exactly as loudly as this one does.
 *
 * A SWEEP OF ITS OWN rather than `prose_pct` switched on inside check_sweep(),
 * and the reason is that the two would conflate. That sweep holds "a banner
 * never costs the page a module" by composing the same page twice, with and
 * without the request, and comparing how many were placed. A granted banner
 * changes every rectangle on the sheet, so it changes the class areas, so it
 * can legitimately change whether the balance fires — and the comparison would
 * then report a banner costing a module when what happened was a figure being
 * dropped for a reason the banner only triggered. Two true invariants, one
 * counter, and no way to tell which one moved it.
 *
 * The generator is deliberately FIGURE-HEAVY. An unbiased pick over the kinds
 * reaches a page graphic enough to breach three quarters only rarely, and a
 * sweep that reaches the interesting case four times in four thousand is a
 * sweep that will not notice when it stops reaching it at all. */
static void check_prose_balance(void)
{
    char why[256];
    int cases = 0, illegal = 0, structural = 0;
    int in_force = 0, fired = 0, met_after_drop = 0, unmet = 0;
    int wrong_class = 0, took_the_spine = 0, off_when_mute = 0, not_idempotent = 0;
    int worst_unmet = 100;

    g_seed = 20260815u;

    for (int t = 0; t < 4000; t++) {
        tm_ctx_t ctx = tm((t % 3 == 0) ? TM_FIXED : TM_COPY);

        const int n = pick(1, UI_MOD_MAX);
        ui_compose_env_t e = sheet(&ctx, pick(400, 1600), pick(0, 30));

        /* Half A1 and half A2, because "zero turns the mechanism off" is a
         * claim about this code and not a description of it. */
        const bool a1 = (t & 1) == 0;
        e.prose_pct = a1 ? UI_PROSE_MAJORITY : 0;

        ui_mod_t mods[UI_MOD_MAX];
        for (int i = 0; i < n; i++) {
            ui_mod_kind_t kind = (ui_mod_kind_t)pick(1, UI_MOD_KIND_COUNT - 1);
            if (pick(0, 2) == 0) {
                static const ui_mod_kind_t FIG[] = {
                    UI_MOD_CHART, UI_MOD_TABLE, UI_MOD_PEERS, UI_MOD_DOSSIER,
                };
                kind = FIG[pick(0, 3)];
            }
            mods[i] = mk(kind, i, pick(0, 6), pick(0, 4),
                         pick(0, 3) == 0 ? pick(1, 7) : 0,
                         pick(0, 3) == 0 ? 0 : pick(1, 900), pick(0, 1) != 0);
        }

        const int placed = ui_compose(&e, mods, n);
        cases++;

        if (placed < 1) {
            if (illegal++ == 0) printf("  case %d: nothing was placed at all\n", t);
            continue;
        }

        /* The postcondition itself. ui_compose_check() carries it — "either the
         * share is met or no droppable figure is still standing" — so a breach
         * arrives here as an ordinary illegal page with its reason printed. */
        if (!ui_compose_check(&e, mods, n, why, sizeof why)) {
            if (illegal++ < 3) printf("  case %d (n=%d h=%d prose_pct=%d): %s\n",
                                      t, n, e.h, e.prose_pct, why);
            continue;
        }

        const char *msg = verify(&e, mods, n);
        if (msg != NULL && structural++ < 3)
            printf("  case %d (n=%d h=%d): %s\n", t, n, e.h, msg);

        /* IDEMPOTENCE, and it is not a nicety here. ui_compose() is re-run on an
         * array it has already composed every time the page re-measures, and
         * news_hash() has promised the device it may skip a twenty-five-second
         * refresh because the same fingerprint means the same pixels. A drop
         * rule is the most dangerous thing that promise has met: `crowded_out`
         * is written by the composer, so a second pass reads a page that has
         * already lost a module and could drop a second one. */
        ui_mod_t again[UI_MOD_MAX];
        memcpy(again, mods, sizeof again);
        tm_ctx_t ctx2 = tm(ctx.mode);
        ui_compose_env_t e2 = e;
        e2.ctx = &ctx2;
        const int placed2 = ui_compose(&e2, again, n);
        if (placed2 != placed) not_idempotent++;
        else for (int i = 0; i < n; i++)
            if (!same_page(&again[i], &mods[i]) ||
                again[i].crowded_out != mods[i].crowded_out) { not_idempotent++; break; }

        bool leads = false;
        const int best = best_rank(mods, n, &leads);

        int crowded = 0;
        for (int i = 0; i < n; i++) {
            if (!mods[i].crowded_out) continue;
            crowded++;

            /* Only a FIGURE may be crowded out, and only one ranked strictly
             * worse than the page's best. The second is the protection for the
             * standing rail, which shares the lead's rank by design: a
             * compositor that removed the page's spine to improve an area ratio
             * would be overruling the editorial judgement that put it there. */
            if (!is_figure(mods[i].kind)) wrong_class++;
            if (mods[i].rank <= best)     took_the_spine++;

            /* And it is an answer, not a request: a module that was simply not
             * reached must not carry it. Both come back unplaced. */
            if (mods[i].placed) wrong_class++;
        }

        if (!a1) {
            if (crowded > 0) off_when_mute++;
            continue;
        }
        if (!leads) continue;       /* the quiet day; the rule cannot apply */

        in_force++;
        if (crowded > 0) {
            fired++;
            const int share = prose_share(mods, n);
            if (share >= UI_PROSE_MAJORITY) met_after_drop++;
            else {
                /* THE HONEST EDGE, and it is a real outcome rather than a
                 * failure: everything droppable is gone and the share is still
                 * short. Recorded so that its frequency is visible — if this
                 * became the common case the threshold would be wrong, not the
                 * compositor. */
                unmet++;
                if (share >= 0 && share < worst_unmet) worst_unmet = share;
            }
        }
    }

    printf("  %d generated pages, %d with the balance in force: "
           "it dropped a figure on %d of them — %d then met the share, "
           "%d ran out of droppable figures first (worst %d%%)\n",
           cases, in_force, fired, met_after_drop, unmet,
           worst_unmet == 100 ? -1 : worst_unmet);

    CHECK_INT(illegal, 0);
    CHECK_INT(structural, 0);
    CHECK_INT(not_idempotent, 0);

    /* What may never be taken off the page to fix a ratio. */
    CHECK_INT(wrong_class, 0);
    CHECK_INT(took_the_spine, 0);

    /* prose_pct == 0 turns the whole mechanism off. A2 is the accounts. */
    CHECK_INT(off_when_mute, 0);

    /* The paths were walked. Without these the suite would go green on a
     * compositor whose balance code had been deleted — which is exactly the
     * state this file was in before this function existed. */
    CHECK(in_force > 400);
    CHECK(fired > 100);
    CHECK(met_after_drop > 50);
}

/* --- 11. the sweep, on grids no sheet of paper has ------------------------ */

static void check_sweep_odd_grids(void)
{
    char why[256];
    int cases = 0, illegal = 0, odd = 0;
    int under_min = 0, under_min_stacked = 0;

    g_seed = 991u;

    /* The grid comes from env rather than from a constant so that this can
     * happen: odd columns, odd gutters, an odd left margin, a well too narrow
     * for the columns it claims. Every one of them still has to come out even
     * on the glass, because the evenness is about how a photo tile is blitted
     * and not about the number 170. */
    for (int t = 0; t < 3000; t++) {
        tm_ctx_t ctx = tm((t % 5 == 0) ? TM_FIXED : TM_COPY);

        ui_compose_env_t e;
        memset(&e, 0, sizeof e);
        e.x = pick(0, 41);
        e.y = pick(-40, 400);
        e.cols = pick(1, 9);
        e.col_w = pick(1, 200);
        e.gutter = pick(0, 41);
        e.w = pick(20, 1400);
        e.h = pick(1, 1800);
        e.band_gap = pick(0, 40);
        e.measure = tm_measure;
        e.ctx = &ctx;

        const int n = pick(1, UI_MOD_MAX);
        ui_mod_t mods[UI_MOD_MAX];
        for (int i = 0; i < n; i++) {
            mods[i] = mk((ui_mod_kind_t)pick(1, UI_MOD_KIND_COUNT - 1), i, pick(0, 4),
                         pick(0, 5), pick(0, 2) == 0 ? pick(1, 6) : 0,
                         pick(0, 600), pick(0, 1) != 0);
            /* A banner on a one-column grid, or in a well a pixel deep, is
             * where the cut has to refuse rather than produce a page with a
             * strip of paper under it. */
            if (pick(0, 5) == 0) mods[i].banner = true;
        }

        const int placed = ui_compose(&e, mods, n);
        cases++;

        if (!ui_compose_check(&e, mods, n, why, sizeof why)) {
            if (illegal++ < 3)
                printf("  odd grid case %d (n=%d cols=%d col_w=%d gutter=%d w=%d h=%d): %s\n",
                       t, n, e.cols, e.col_w, e.gutter, e.w, e.h, why);
            continue;
        }

        for (int i = 0; i < n; i++)
            if (mods[i].placed && ((mods[i].x & 1) || (mods[i].w & 1))) odd++;

        /* The h_min exception, counted here too. These grids are where a region
         * is most likely to come out holding one band — a well a pixel deep, a
         * single column — so if the clamp were ever going to spread beyond the
         * last band of a region, it would show up here first and at a higher
         * rate than on the sheet's own geometry. */
        for (int i = 0; i < n; i++) {
            if (!mods[i].placed) continue;
            tm_ctx_t probe = tm(ctx.mode);
            int lo = 0, hi = 0;
            tm_measure(&mods[i], mods[i].w, &lo, &hi, &probe);
            if (lo < 1) lo = 1;
            if (mods[i].h >= lo) continue;

            under_min++;
            for (int j = 0; j < n; j++)
                if (j != i && mods[j].placed &&
                    mods[j].band == mods[i].band && mods[j].slot == mods[i].slot) {
                    under_min_stacked++;
                    break;
                }
        }

        /* A grid with no room for one whole column is the only one allowed to
         * come back empty, and then nothing may be marked placed. */
        if (placed == 0)
            for (int i = 0; i < n; i++) if (mods[i].placed) illegal++;
    }

    printf("  %d generated pages on grids that are not the sheet's; "
           "%d placed modules under their own h_min there, %d of them in a stack\n",
           cases, under_min, under_min_stacked);
    CHECK_INT(cases, 3000);
    CHECK_INT(illegal, 0);
    CHECK_INT(odd, 0);
    CHECK_INT(under_min_stacked, 0);
}

int main(void)
{
    check_nothing();
    check_single();
    check_rail_full_height();
    check_rail_short();
    check_band_packing();
    check_oversupply();
    check_undersupply();
    check_inelastic_leading();
    check_nested_panes();
    check_determinism();
    check_banner_shape();
    check_banner_squeeze();
    check_banner_give_up();
    check_banner_tie();
    check_honest_minimums();
    check_head_weight();
    check_sweep();
    check_sweep_odd_grids();
    check_prose_balance();

    TH_REPORT("compose");
}
