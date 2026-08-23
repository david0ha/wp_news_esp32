/*
 * Host unit tests tying the built-in demo edition to the wire contract.
 *
 * news_mock.c is what an unconfigured board shows; tools/mock_news_server.py is
 * the reference producer, and fixtures/news.json is its committed output. Those
 * are two hand-written descriptions of the same page, in two languages, and
 * they will drift the first time somebody edits one of them.
 *
 * So the main test here is: parse the fixture, and assert it fingerprints
 * identically to the C snapshot. If someone adds a figure to the demo page and
 * forgets the server (or vice versa), this fails with the field named rather
 * than showing up as a screenshot that no longer matches the docs.
 *
 * The rest of the file checks that the demo edition is internally legal,
 * complete, and — the part that is easy to skip and expensive to get wrong —
 * ARITHMETICALLY TRUE. It is the one snapshot that never goes through the
 * parser's clamping, so nothing else would catch a Korean glyph or an empty
 * band in it; and it is the one page whose numbers nobody checks against a
 * market, so nothing else would catch a P/E that does not divide.
 */
#include "th.h"

#include "news_mock.h"
#include "news_model.h"
#include "news_parse.h"

#include <stdlib.h>

/* ~33 KB apiece; file-static so no frame ever carries two. */
static news_t g_mock, g_wire;

/* --- the two descriptions of one page ------------------------------------- */

static void cmp_quote(const char *what, int i,
                      const news_quote_t *m, const news_quote_t *w)
{
    if (memcmp(m, w, sizeof(*m)) == 0) { g_total++; return; }
    printf("  in %s[%d]:\n", what, i);
    CHECK_STR(m->symbol, w->symbol);
    CHECK_STR(m->name, w->name);
    CHECK_INT(m->last_c, w->last_c);
    CHECK_INT(m->chg_bp, w->chg_bp);
    CHECK_INT(m->spark_n, w->spark_n);
    for (int k = 0; k < m->spark_n && k < w->spark_n; k++) {
        CHECK_INT(m->spark[k], w->spark[k]);
    }
}

static void cmp_photo(const char *what, const news_photo_t *m, const news_photo_t *w)
{
    if (memcmp(m, w, sizeof(*m)) == 0) { g_total++; return; }
    printf("  in %s:\n", what);
    CHECK_STR(m->id, w->id);
    CHECK_INT(m->w, w->w);
    CHECK_INT(m->h, w->h);
    CHECK_STR(m->caption, w->caption);
    CHECK_STR(m->credit, w->credit);
}

static void cmp_story(int i, const news_story_t *m, const news_story_t *w)
{
    if (memcmp(m, w, sizeof(*m)) == 0) { g_total++; return; }
    printf("  in stories[%d]:\n", i);
    CHECK_INT(m->rank, w->rank);
    CHECK_STR(m->kicker, w->kicker);
    CHECK_STR(m->headline, w->headline);
    CHECK_STR(m->deck, w->deck);
    CHECK_STR(m->byline, w->byline);
    CHECK_STR(m->body, w->body);
    CHECK_INT(m->chart, w->chart);
    cmp_photo("its photo", &m->photo, &w->photo);
}

static void cmp_chart(int i, const news_chart_t *m, const news_chart_t *w)
{
    if (memcmp(m, w, sizeof(*m)) == 0) { g_total++; return; }
    printf("  in charts[%d]:\n", i);
    CHECK_INT(m->kind, w->kind);
    CHECK_STR(m->label, w->label);
    CHECK_STR(m->span, w->span);
    CHECK_STR(m->note, w->note);
    CHECK_INT(m->n, w->n);
    for (int k = 0; k < m->n && k < w->n; k++) {
        CHECK_INT(m->o[k], w->o[k]);
        CHECK_INT(m->h[k], w->h[k]);
        CHECK_INT(m->l[k], w->l[k]);
        CHECK_INT(m->c[k], w->c[k]);
    }
}

static void cmp_table(int i, const news_table_t *m, const news_table_t *w)
{
    if (memcmp(m, w, sizeof(*m)) == 0) { g_total++; return; }
    printf("  in tables[%d]:\n", i);
    CHECK_STR(m->title, w->title);
    CHECK_STR(m->note, w->note);
    CHECK_INT(m->render, w->render);
    CHECK_INT(m->has_n, w->has_n);
    CHECK_INT(m->col_count, w->col_count);
    for (int c = 0; c < m->col_count && c < w->col_count; c++) {
        CHECK_STR(m->col[c], w->col[c]);
    }
    CHECK_INT(m->row_count, w->row_count);
    for (int r = 0; r < m->row_count && r < w->row_count; r++) {
        CHECK_STR(m->row[r].label, w->row[r].label);
        for (int c = 0; c < m->col_count && c < w->col_count; c++) {
            CHECK_STR(m->row[r].v[c], w->row[r].v[c]);
            CHECK_INT(m->n[r][c], w->n[r][c]);
        }
    }
}

static void test_mock_matches_the_wire_fixture(void)
{
    size_t len = 0;
    char *json = th_slurp(FIXDIR "/news.json", &len);
    CHECK(news_parse(json, len, &g_wire) == true);
    free(json);

    news_mock(&g_mock);

    /* The one field that legitimately differs: `demo` is how the folio knows to
     * show the DEMO badge, and a page that arrived over the network is by
     * definition not the demo. Normalise it and everything else must match. */
    CHECK(g_mock.demo == true);
    CHECK(g_wire.demo == false);
    g_mock.demo = false;

    if (news_hash(&g_mock) == news_hash(&g_wire)) {
        g_total++;
        return;
    }

    g_total++; g_fail++;
    printf("  FAIL news_mock.c and tools/mock_news_server.py have diverged\n");
    /* Narrow it down for whoever has to fix it, rather than leaving them to
     * diff a C file against a Python one by eye. */
    CHECK_STR(g_mock.edition, g_wire.edition);
    CHECK_STR(g_mock.dateline, g_wire.dateline);
    CHECK_STR(g_mock.session, g_wire.session);
    CHECK_STR(g_mock.as_of, g_wire.as_of);
    CHECK_STR(g_mock.generated_at, g_wire.generated_at);

    CHECK_STR(g_mock.subject.symbol, g_wire.subject.symbol);
    CHECK_STR(g_mock.subject.name, g_wire.subject.name);
    CHECK_STR(g_mock.subject.exchange, g_wire.subject.exchange);
    CHECK_STR(g_mock.subject.sector, g_wire.subject.sector);
    CHECK_INT(g_mock.subject.last_c, g_wire.subject.last_c);
    CHECK_INT(g_mock.subject.chg_bp, g_wire.subject.chg_bp);
    CHECK_INT(g_mock.subject.prev_close_c, g_wire.subject.prev_close_c);
    CHECK_INT(g_mock.subject.open_c, g_wire.subject.open_c);
    CHECK_INT(g_mock.subject.high_c, g_wire.subject.high_c);
    CHECK_INT(g_mock.subject.low_c, g_wire.subject.low_c);
    CHECK_INT(g_mock.subject.wk52_hi_c, g_wire.subject.wk52_hi_c);
    CHECK_INT(g_mock.subject.wk52_lo_c, g_wire.subject.wk52_lo_c);

    CHECK_INT(g_mock.story_count, g_wire.story_count);
    for (int i = 0; i < g_mock.story_count && i < g_wire.story_count; i++) {
        cmp_story(i, &g_mock.stories[i], &g_wire.stories[i]);
    }
    CHECK_INT(g_mock.figure_count, g_wire.figure_count);
    for (int i = 0; i < g_mock.figure_count && i < g_wire.figure_count; i++) {
        const news_figure_t *m = &g_mock.figures[i], *w = &g_wire.figures[i];
        CHECK_STR(m->group, w->group);
        CHECK_STR(m->label, w->label);
        CHECK_STR(m->value, w->value);
        CHECK_INT(m->has_chg, w->has_chg);
        CHECK_INT(m->chg_bp, w->chg_bp);
        CHECK_INT(m->emph, w->emph);
        CHECK_INT(m->bar, w->bar);
    }
    CHECK_INT(g_mock.brief_count, g_wire.brief_count);
    for (int i = 0; i < g_mock.brief_count && i < g_wire.brief_count; i++) {
        CHECK_STR(g_mock.briefs[i].date, g_wire.briefs[i].date);
        CHECK_STR(g_mock.briefs[i].kicker, g_wire.briefs[i].kicker);
        CHECK_STR(g_mock.briefs[i].text, g_wire.briefs[i].text);
    }
    CHECK_INT(g_mock.peer_count, g_wire.peer_count);
    for (int i = 0; i < g_mock.peer_count && i < g_wire.peer_count; i++) {
        const news_peer_t *m = &g_mock.peers[i], *w = &g_wire.peers[i];
        CHECK_STR(m->symbol, w->symbol);
        CHECK_STR(m->name, w->name);
        CHECK_STR(m->per, w->per);
        CHECK_STR(m->cap, w->cap);
        CHECK_INT(m->last_c, w->last_c);
        CHECK_INT(m->chg_bp, w->chg_bp);
        CHECK_INT(m->is_subject, w->is_subject);
    }
    CHECK_INT(g_mock.table_count, g_wire.table_count);
    for (int i = 0; i < g_mock.table_count && i < g_wire.table_count; i++) {
        cmp_table(i, &g_mock.tables[i], &g_wire.tables[i]);
    }
    CHECK_INT(g_mock.chart_count, g_wire.chart_count);
    for (int i = 0; i < g_mock.chart_count && i < g_wire.chart_count; i++) {
        cmp_chart(i, &g_mock.charts[i], &g_wire.charts[i]);
    }
    CHECK_INT(g_mock.index_count, g_wire.index_count);
    for (int i = 0; i < g_mock.index_count && i < g_wire.index_count; i++) {
        cmp_quote("indices", i, &g_mock.indices[i], &g_wire.indices[i]);
    }
    CHECK_INT(g_mock.thumb_count, g_wire.thumb_count);
    for (int i = 0; i < g_mock.thumb_count && i < g_wire.thumb_count; i++) {
        cmp_photo("a thumb", &g_mock.thumbs[i], &g_wire.thumbs[i]);
    }
}

/* --- legality ------------------------------------------------------------- */

static void test_mock_is_internally_legal(void)
{
    news_mock(&g_mock);

    CHECK(g_mock.valid == true);
    CHECK(g_mock.story_count  >= 0 && g_mock.story_count  <= NEWS_STORIES_MAX);
    CHECK(g_mock.figure_count >= 0 && g_mock.figure_count <= NEWS_FIGURES_MAX);
    CHECK(g_mock.brief_count  >= 0 && g_mock.brief_count  <= NEWS_BRIEFS_MAX);
    CHECK(g_mock.peer_count   >= 0 && g_mock.peer_count   <= NEWS_PEERS_MAX);
    CHECK(g_mock.table_count  >= 0 && g_mock.table_count  <= NEWS_TABLES_MAX);
    CHECK(g_mock.chart_count  >= 0 && g_mock.chart_count  <= NEWS_CHARTS_MAX);
    CHECK(g_mock.index_count  >= 0 && g_mock.index_count  <= NEWS_INDEX_MAX);
    CHECK(g_mock.thumb_count  >= 0 && g_mock.thumb_count  <= NEWS_THUMBS_MAX);

    /* The nameplate has to have something to print. */
    CHECK(g_mock.subject.symbol[0] != '\0');
    CHECK(g_mock.subject.name[0] != '\0');
    CHECK(g_mock.subject.exchange[0] != '\0');
    CHECK(g_mock.subject.sector[0] != '\0');

    for (int i = 0; i < g_mock.story_count; i++) {
        const news_story_t *s = &g_mock.stories[i];
        CHECK(s->headline[0] != '\0');      /* a kicker over an empty column */
        CHECK(s->rank == i);                /* the packing order is the index */
        /* An index into the charts that actually arrived, or -1. */
        CHECK(s->chart >= -1 && s->chart < g_mock.chart_count);
        /* An id without dimensions is a GET that cannot be made, and a caption
         * under a slot that stayed empty. */
        CHECK((s->photo.id[0] == '\0') == (s->photo.w == 0 && s->photo.h == 0));
        /* A tile packs two pixels to a byte; an odd width cannot be blitted as
         * a per-row memcpy. */
        CHECK(s->photo.w % 2 == 0);
    }

    for (int i = 0; i < g_mock.chart_count; i++) {
        const news_chart_t *c = &g_mock.charts[i];
        CHECK(c->n >= 0 && c->n <= NEWS_BARS_MAX);
        /* The model's single test for "is there a chart" has to hold in the one
         * snapshot the parser never clamped. */
        CHECK((c->kind == CHART_NONE) == (c->n == 0));
        CHECK(c->label[0] != '\0');
    }

    for (int i = 0; i < g_mock.figure_count; i++) {
        const news_figure_t *f = &g_mock.figures[i];
        CHECK(f->group[0] != '\0');
        CHECK(f->label[0] != '\0');
        CHECK(f->value[0] != '\0');
        /* Two tiers and no third one, and a bar that is either a position
         * inside its track or the -1 that means there is no track. Zero is a
         * real position — the bottom of the range — so a figure that meant "no
         * bar" and sent 0 would draw an empty track and read as a company at
         * the floor of every measure it has. */
        CHECK(f->emph <= 1);
        CHECK(f->bar >= -1 && f->bar <= 1000);
        /* A bar belongs to a hero: one on a small line is a track drawn across a
         * 170 px column with nothing beside it to read. The reverse does NOT
         * hold — `bar` turns a hero into a graphic INSTEAD of a bigger number,
         * so a hero without one is the ordinary hero rather than a broken one,
         * and a price target has no traded band to sit inside. */
        if (f->bar >= 0) CHECK(f->emph != 0);
    }
    for (int i = 0; i < g_mock.brief_count; i++) {
        CHECK(g_mock.briefs[i].text[0] != '\0');
    }
    for (int i = 0; i < g_mock.peer_count; i++) {
        CHECK(g_mock.peers[i].symbol[0] != '\0');
    }
    for (int i = 0; i < g_mock.thumb_count; i++) {
        CHECK(g_mock.thumbs[i].id[0] != '\0');
        CHECK(g_mock.thumbs[i].w > 0 && g_mock.thumbs[i].w % 2 == 0);
        CHECK(g_mock.thumbs[i].h > 0);
    }
    for (int i = 0; i < g_mock.index_count; i++) {
        CHECK(g_mock.indices[i].symbol[0] != '\0');
        CHECK(g_mock.indices[i].spark_n > 0);
        CHECK(g_mock.indices[i].spark_n <= NEWS_SPARK_MAX);
        for (int k = 0; k < g_mock.indices[i].spark_n; k++) {
            CHECK(g_mock.indices[i].spark[k] >= 0);
            CHECK(g_mock.indices[i].spark[k] <= 1000);
        }
    }

    /* Consecutive figures sharing a group print one head between them, so a
     * group that is left and then returned to prints its head twice. The
     * producer orders the list; nothing downstream sorts it. Each figure that
     * STARTS a run is checked against every group already seen. */
    for (int i = 1; i < g_mock.figure_count; i++) {
        if (strcmp(g_mock.figures[i].group, g_mock.figures[i - 1].group) == 0) continue;
        for (int j = 0; j < i; j++) {
            if (strcmp(g_mock.figures[i].group, g_mock.figures[j].group) != 0) continue;
            g_total++; g_fail++;
            printf("  FAIL figures[%d] returns to group \"%s\" after leaving it\n",
                   i, g_mock.figures[i].group);
            break;
        }
    }
}

/* --- English only --------------------------------------------------------- */

/* Decode one UTF-8 sequence. Returns the codepoint and advances *i; a malformed
 * byte returns 0xFFFD, which fails the check below like any other unprintable. */
static unsigned decode(const char *s, size_t *i)
{
    unsigned char c = (unsigned char)s[*i];
    unsigned cp;
    size_t n;
    if (c < 0x80)             { cp = c;        n = 1; }
    else if ((c & 0xE0) == 0xC0) { cp = c & 0x1Fu; n = 2; }
    else if ((c & 0xF0) == 0xE0) { cp = c & 0x0Fu; n = 3; }
    else if ((c & 0xF8) == 0xF0) { cp = c & 0x07u; n = 4; }
    else { (*i)++; return 0xFFFD; }
    for (size_t k = 1; k < n; k++) {
        unsigned char t = (unsigned char)s[*i + k];
        if ((t & 0xC0) != 0x80) { (*i)++; return 0xFFFD; }
        cp = (cp << 6) | (t & 0x3Fu);
    }
    *i += n;
    return cp;
}

/* The bundled faces carry ASCII, Latin-1 and the typography in S_DATA_PUNCT.
 * Nothing else has a glyph, and a codepoint without a glyph is a tofu box on
 * the largest type on the page. This is the model-layer canary for it — the
 * simulator's coverage check is the real one, but it needs a laptop with LVGL
 * and this needs neither. */
static void check_english(const char *where, const char *s)
{
    for (size_t i = 0; s[i] != '\0'; ) {
        size_t at = i;
        unsigned cp = decode(s, &i);
        bool ok = (cp >= 0x20 && cp < 0x0250) ||        /* ASCII + Latin-1 + Latin Ext */
                  (cp >= 0x2010 && cp <= 0x2122);       /* dashes, quotes, ‰ × ° № ™ */
        g_total++;
        if (!ok) {
            g_fail++;
            printf("  FAIL %s: U+%04X at byte %zu has no glyph in the bundled fonts\n",
                   where, cp, at);
            return;                                     /* one report per string */
        }
    }
}

static void test_mock_is_english_only(void)
{
    news_mock(&g_mock);

    check_english("edition", g_mock.edition);
    check_english("dateline", g_mock.dateline);
    check_english("session", g_mock.session);
    check_english("as_of", g_mock.as_of);
    check_english("generated_at", g_mock.generated_at);
    check_english("subject name", g_mock.subject.name);
    check_english("subject sector", g_mock.subject.sector);

    for (int i = 0; i < g_mock.index_count; i++) {
        check_english("index symbol", g_mock.indices[i].symbol);
        check_english("index name", g_mock.indices[i].name);
    }
    for (int i = 0; i < g_mock.story_count; i++) {
        const news_story_t *s = &g_mock.stories[i];
        check_english("kicker", s->kicker);
        check_english("headline", s->headline);
        check_english("deck", s->deck);
        check_english("byline", s->byline);
        check_english("body", s->body);
        check_english("caption", s->photo.caption);
        check_english("credit", s->photo.credit);
    }
    for (int i = 0; i < g_mock.figure_count; i++) {
        check_english("figure group", g_mock.figures[i].group);
        check_english("figure label", g_mock.figures[i].label);
        check_english("figure value", g_mock.figures[i].value);
    }
    for (int i = 0; i < g_mock.brief_count; i++) {
        check_english("brief date", g_mock.briefs[i].date);
        check_english("brief kicker", g_mock.briefs[i].kicker);
        check_english("brief text", g_mock.briefs[i].text);
    }
    for (int i = 0; i < g_mock.peer_count; i++) {
        check_english("peer name", g_mock.peers[i].name);
        check_english("peer multiple", g_mock.peers[i].per);
        check_english("peer cap", g_mock.peers[i].cap);
    }
    for (int i = 0; i < g_mock.table_count; i++) {
        const news_table_t *t = &g_mock.tables[i];
        check_english("table title", t->title);
        check_english("table note", t->note);
        for (int c = 0; c < t->col_count; c++) check_english("column head", t->col[c]);
        for (int r = 0; r < t->row_count; r++) {
            check_english("row label", t->row[r].label);
            for (int c = 0; c < t->col_count; c++) check_english("cell", t->row[r].v[c]);
        }
    }
    for (int i = 0; i < g_mock.chart_count; i++) {
        check_english("chart label", g_mock.charts[i].label);
        check_english("chart span", g_mock.charts[i].span);
        check_english("chart note", g_mock.charts[i].note);
    }
    for (int i = 0; i < g_mock.thumb_count; i++) {
        check_english("thumb caption", g_mock.thumbs[i].caption);
        check_english("thumb credit", g_mock.thumbs[i].credit);
    }
}

/* --- the length budget ---------------------------------------------------- */

/* Headlines and decks are ellipsized at a fixed height, not copyfitted, so a
 * page that overshoots gets a visible "..." mid-sentence. The budget is in
 * docs/specs/2026-08-14-front-page-design.md §10 and in CLAUDE.md; the device
 * cannot enforce it, so the demo page — the one everybody sees first — is held
 * to it here. Bodies are the opposite: they are cut at a word boundary, so they
 * are written LONG and only the floor is checked. */
static void test_mock_respects_the_length_budget(void)
{
    news_mock(&g_mock);

    CHECK(strlen(g_mock.stories[0].headline) <= 72);
    CHECK(strlen(g_mock.stories[0].deck) <= 118);
    /* The floors moved with the compositor. A lead now runs in up to four legs
     * down a package that can be most of the sheet, and the old 600 characters
     * is a third of a column of prose and two thirds of a column of white
     * paper — which is the one thing the owner asked not to see. */
    CHECK(strlen(g_mock.stories[0].body) >= 1400);
    CHECK(strlen(g_mock.stories[0].body) < NEWS_BODY_MAX);
    CHECK(strlen(g_mock.stories[0].photo.caption) <= 72);

    for (int i = 1; i < g_mock.story_count; i++) {
        CHECK(strlen(g_mock.stories[i].headline) <= 54);
        CHECK(strlen(g_mock.stories[i].deck) <= 58);
        CHECK(strlen(g_mock.stories[i].body) >= 400);
        CHECK(strlen(g_mock.stories[i].body) < NEWS_BODY_MAX);
    }
    for (int i = 0; i < g_mock.thumb_count; i++) {
        CHECK(strlen(g_mock.thumbs[i].caption) <= 72);
    }
}

/* --- completeness --------------------------------------------------------- */

static void test_mock_is_a_complete_edition(void)
{
    /* Real data is easy. The demo is what the README shows and what the
     * simulator asserts against, so it has to bring more modules than one sheet
     * holds — which is the condition the make-up desk exists to resolve, and
     * the one a payload sized to fit exactly would never exercise. */
    news_mock(&g_mock);

    CHECK_INT(g_mock.index_count, NEWS_INDEX_MAX);      /* all five ribbon cells */
    CHECK_INT(g_mock.story_count, 4);
    CHECK_INT(g_mock.chart_count, 2);
    CHECK_INT(g_mock.table_count, 2);
    CHECK_INT(g_mock.thumb_count, 2);
    CHECK_INT(g_mock.peer_count, 5);
    CHECK_INT(g_mock.brief_count, 6);
    CHECK(g_mock.figure_count >= 16);

    CHECK(g_mock.stories[0].deck[0] != '\0');
    CHECK(g_mock.stories[0].kicker[0] != '\0');
    CHECK(g_mock.stories[0].byline[0] != '\0');

    /* Photo AND chart on the lead: the case the make-up desk has to resolve
     * rather than the case it can assume away. */
    CHECK(g_mock.stories[0].photo.id[0] != '\0');
    CHECK(g_mock.stories[0].photo.caption[0] != '\0');
    CHECK_INT(g_mock.stories[0].chart, 1);   /* the contract series, not the price */

    /* At least one story brings no chart at all, and the row must not assume
     * otherwise. */
    int chartless = 0;
    for (int i = 1; i < g_mock.story_count; i++) {
        if (g_mock.stories[i].chart < 0) chartless++;
    }
    CHECK(chartless >= 1);

    /* One line and one bar: the two geometries the page can be asked for. */
    int line = 0, bar = 0;
    for (int i = 0; i < g_mock.chart_count; i++) {
        if (g_mock.charts[i].kind == CHART_LINE) line++;
        if (g_mock.charts[i].kind == CHART_BAR)  bar++;
    }
    CHECK_INT(line, 1);
    CHECK_INT(bar, 1);

    /* Both colours have to appear, or the one place colour is allowed goes out
     * of the README untested. Green and red live on percentage changes; a
     * figure with no change carries neither, and most of the rail is that. */
    int up = 0, down = 0, plain = 0;
    for (int i = 0; i < g_mock.index_count; i++) {
        if (g_mock.indices[i].chg_bp > 0) up++;
        if (g_mock.indices[i].chg_bp < 0) down++;
    }
    for (int i = 0; i < g_mock.peer_count; i++) {
        if (g_mock.peers[i].chg_bp > 0) up++;
        if (g_mock.peers[i].chg_bp < 0) down++;
    }
    for (int i = 0; i < g_mock.figure_count; i++) {
        if (!g_mock.figures[i].has_chg) plain++;
    }
    CHECK(up > 0);
    CHECK(down > 0);
    CHECK(plain > 0);

    /* SIX standing heads, which is six cards of the metric grid, and no group
     * bigger than five. Four groups was the rail's number and it was fine for a
     * rail — a section head every seven figures down a single column. The grid
     * makes each group a CARD, so the group count is a layout decision now: six
     * cards fill a row of four and half of a second at the full measure, and a
     * seven-figure VALUATION card beside a three-figure one is the ragged grid
     * the owner rejected. Splitting PER SHARE out of VALUATION and REVENUE MIX
     * out of PROFITABILITY is what made the cards even.
     *
     * The bound matters more than the count: a group of one is a heading with a
     * line under it, and a group of six is a card twice its neighbours' height. */
    int groups = 0, biggest = 0, run = 0;
    for (int i = 0; i < g_mock.figure_count; i++) {
        if (i == 0 || strcmp(g_mock.figures[i].group,
                             g_mock.figures[i - 1].group) != 0) { groups++; run = 0; }
        run++;
        if (run > biggest) biggest = run;
    }
    CHECK_INT(groups, 6);
    CHECK(biggest <= 5);
    for (int i = 0; i < g_mock.table_count; i++) {
        CHECK_INT(g_mock.tables[i].col_count, NEWS_TABLE_COLS);
        CHECK(g_mock.tables[i].row_count >= 3);
        for (int r = 0; r < g_mock.tables[i].row_count; r++) {
            for (int c = 0; c < g_mock.tables[i].col_count; c++) {
                CHECK(g_mock.tables[i].row[r].v[c][0] != '\0');
            }
        }
    }

    /* Both statements are DRAWN, and they are the two geometries the page can
     * be asked for — the same relationship the two charts have. A demo edition
     * where both tables printed would leave the whole drawn path out of the
     * README, out of the simulator's screenshots and out of every test that
     * looks at pixels. */
    CHECK_INT(g_mock.tables[0].render, TABLE_BARS_LINE);
    CHECK_INT(g_mock.tables[1].render, TABLE_STACK);
    CHECK(g_mock.tables[0].has_n == true);
    CHECK(g_mock.tables[1].has_n == true);

    /* Exactly three heroes, one at the head of each of three different groups.
     * Two to four is the editorial rule: none is the rail of identical lines
     * this replaced, and everything emphasised is the same rail one size larger.
     * Spread rather than stacked, because a hero reads as the head of its own
     * section and three in one group would make that group the rail.
     *
     * BOTH hero shapes have to appear. `bar` turns a hero into a graphic instead
     * of a bigger number, so a hero without one is the ordinary hero — and a
     * demo edition where every hero carried a bar would leave the commoner of
     * the two shapes rendered by nobody and looked at by nobody. */
    int heroes = 0, with_bar = 0, without_bar = 0, at_group_head = 0;
    for (int i = 0; i < g_mock.figure_count; i++) {
        if (!g_mock.figures[i].emph) continue;
        heroes++;
        if (g_mock.figures[i].bar >= 0) with_bar++; else without_bar++;
        if (i == 0 || strcmp(g_mock.figures[i].group,
                             g_mock.figures[i - 1].group) != 0) at_group_head++;
    }
    CHECK_INT(heroes, 3);
    CHECK_INT(at_group_head, 3);
    CHECK(with_bar >= 1);
    CHECK(without_bar >= 1);
}

/* --- the arithmetic ------------------------------------------------------- */

/* One printed cell back to the number it was set from, in hundredths so that
 * nothing here holds a float: "1,672" -> 167200, "(370)" -> -37000, "72.6%" ->
 * 7260, "(2.50)" -> -250. Accounting parentheses, thousands commas and a
 * trailing percent are the three house conventions in these tables. Returns
 * false on anything it cannot read, which is itself a failure. */
static bool cell(const char *s, long *out)
{
    bool neg = false;
    if (*s == '(') { neg = true; s++; }

    long whole = 0, frac = 0, scale = 1;
    bool seen = false, dot = false;
    for (; *s; s++) {
        if (*s == ',') continue;
        if (*s == '%' || *s == ')') continue;
        if (*s == '.') { dot = true; continue; }
        if (*s < '0' || *s > '9') return false;
        seen = true;
        if (dot) { if (scale < 100) { frac = frac * 10 + (*s - '0'); scale *= 10; } }
        else     { whole = whole * 10 + (*s - '0'); }
    }
    if (!seen) return false;
    while (scale < 100) { frac *= 10; scale *= 10; }
    *out = (whole * 100 + frac) * (neg ? -1 : 1);
    return true;
}

static int row_of(const news_table_t *t, const char *label)
{
    for (int r = 0; r < t->row_count; r++) {
        if (strcmp(t->row[r].label, label) == 0) return r;
    }
    g_total++; g_fail++;
    printf("  FAIL no row labelled \"%s\"\n", label);
    return -1;
}

static long row_cell(const news_table_t *t, const char *label, int col)
{
    int r = row_of(t, label);
    if (r < 0) return 0;

    long v = 0;
    g_total++;
    if (!cell(t->row[r].v[col], &v)) {
        g_fail++;
        printf("  FAIL %s column %d is \"%s\", which is not a number\n",
               label, col, t->row[r].v[col]);
    }
    return v;
}

/* Where `v` sits between `lo` and `hi`, normalised 0..1000 — the same arithmetic
 * the producer does for a hero's `bar`, in integers so that this test and the
 * device round the same way. */
static long where_in(long v, long lo, long hi)
{
    if (hi == lo) { g_total++; g_fail++; printf("  FAIL an empty range\n"); return 0; }
    long num = 1000 * (v - lo), den = hi - lo;
    return (num + (num >= 0 ? den / 2 : -(den / 2))) / den;
}

static int16_t bar_of(const char *label)
{
    for (int i = 0; i < g_mock.figure_count; i++) {
        if (strcmp(g_mock.figures[i].label, label) == 0) return g_mock.figures[i].bar;
    }
    g_total++; g_fail++;
    printf("  FAIL no figure labelled \"%s\"\n", label);
    return -1;
}

static void near(const char *what, long got, long want, long tol)
{
    g_total++;
    long d = got - want;
    if (d < 0) d = -d;
    if (d > tol) {
        g_fail++;
        printf("  FAIL %s: %ld vs %ld (tolerance %ld)\n", what, got, want, tol);
    }
}

/* The two planes of a DRAWN table have to say the same thing.
 *
 * `v` is what is printed and `n` is what is scaled, and a bar whose height
 * disagrees with the number set under it is the one error nobody forgives. It is
 * also the only error here that survives every other check: both halves are
 * internally consistent, both reconcile against everything around them, and the
 * page is simply a lie about one column.
 *
 * `scale` is where the two units differ. A $ millions row draws 9,340 and prints
 * "9,340", which cell() reads in hundredths, so the plane is multiplied by a
 * hundred and must match exactly. The line row of a bars-and-line table draws
 * basis points and prints one decimal place of a percent — which cell() also
 * reads in hundredths, so they are already the same unit and differ only by the
 * rounding the printed form threw away. */
static void planes_agree(const news_table_t *t, const char *label,
                         long scale, long tol)
{
    int r = row_of(t, label);
    if (r < 0) return;
    for (int c = 0; c < t->col_count; c++) {
        near("the drawn plane against the printed cell",
             (long)t->n[r][c] * scale, row_cell(t, label, c), tol);
    }
}

/* The demo edition is the one page whose numbers nobody checks against a
 * market. Its figures are derived from the price, the share count, EPS and BPS,
 * its statements reconcile down their columns and along their last four, and its
 * two DRAWN tables have to agree with the strings printed under them — see the
 * derivation at the top of news_mock.c. A P/E that does not divide into its own
 * EPS is exactly the thing a reader catches first, and it would otherwise sit
 * here for months with the fixture and the C agreeing perfectly about the wrong
 * number. */
static void test_the_demo_edition_adds_up(void)
{
    news_mock(&g_mock);

    const news_subject_t *s = &g_mock.subject;
    const news_table_t *results = &g_mock.tables[0];
    const news_table_t *segments = &g_mock.tables[1];
    const int cols = results->col_count;

    /* Shares outstanding. Everything below stays in long arithmetic and in the
     * units the cells were read in — $ millions x 100 for a statement line,
     * cents for a price — because this test exists to catch a wrong number and
     * a float would let it catch a rounding mode instead. */
    const long SHARES = 148089758;

    /* The session's own numbers have to bracket each other. */
    CHECK(s->low_c <= s->last_c && s->last_c <= s->high_c);
    CHECK(s->low_c <= s->open_c && s->open_c <= s->high_c);
    CHECK(s->wk52_lo_c < s->last_c && s->last_c < s->wk52_hi_c);
    /* The printed change against the printed previous close, to a basis point:
     * (163147 - 159309) / 159309 = 2.409%, which prints as +2.41%. */
    near("the change against the previous close",
         (long)(s->last_c - s->prev_close_c) * 10000 / s->prev_close_c,
         s->chg_bp, 1);

    /* The price line ends on the price in the nameplate and peaks at the
     * 52-week high; the revenue bars ARE the statement's total row. */
    const news_chart_t *price = &g_mock.charts[0];
    CHECK_INT(price->c[price->n - 1], s->last_c);
    long peak = price->c[0];
    for (int i = 1; i < price->n; i++) if (price->c[i] > peak) peak = price->c[i];
    CHECK_INT(peak, s->wk52_hi_c);

    /* NO CHART MAY PLOT A SERIES A DRAWN TABLE ALREADY CARRIES. Both statements on
     * A2 are drawn, so a chart that repeated one of their rows would put the same
     * bars on the sheet twice, a few hundred pixels apart, and a reader would see it
     * before anything else. This is the check that stops it coming back. */
    for (int i = 0; i < g_mock.chart_count; i++) {
        const news_chart_t *ch = &g_mock.charts[i];
        for (int t = 0; t < g_mock.table_count; t++) {
            const news_table_t *tab = &g_mock.tables[t];
            if (tab->render == TABLE_PRINT || !tab->has_n) continue;
            for (int r = 0; r < tab->row_count; r++) {
                if (ch->n != tab->col_count) continue;
                int same = 1;
                for (int c = 0; c < tab->col_count; c++) {
                    if (ch->c[c] != tab->n[r][c]) { same = 0; break; }
                }
                g_total++;
                if (same) {
                    g_fail++;
                    printf("  FAIL charts[%d] (%s) plots the same series as "
                           "tables[%d] row \"%s\" — the sheet would draw it twice\n",
                           i, ch->label, t, tab->row[r].label);
                }
            }
        }
    }

    /* The contract series against the prose that reports it. The AUG 12 brief says
     * the third quarter settled 18 percent above the second and that it was the
     * fourth consecutive increase; a bar chart contradicting the sentence beside it
     * is the same class of error as a price chart contradicting the price. */
    const news_chart_t *con = &g_mock.charts[1];
    CHECK_INT(con->n, 6);
    int rises = 0;
    for (int i = con->n - 1; i > 0; i--) {
        if (con->c[i] <= con->c[i - 1]) break;
        rises++;
    }
    CHECK_INT(rises, 4);
    near("the last contract settlement against the AUG 12 brief",
         (con->c[con->n - 1] - con->c[con->n - 2]) * 1000 / con->c[con->n - 2],
         180, 3);

    /* Both statements are drawn, so before anything else: the numbers that get
     * scaled into bars are the numbers printed under them. */
    CHECK(results->has_n == true);
    CHECK(segments->has_n == true);
    planes_agree(results,  "Revenue",    100, 0);
    planes_agree(results,  "Net income", 100, 0);
    planes_agree(results,  "Net margin",   1, 5);   /* bp against one printed decimal */
    planes_agree(segments, "Client",     100, 0);
    planes_agree(segments, "Consumer",   100, 0);
    planes_agree(segments, "Cloud",      100, 0);

    /* A stacked bar's total is its height. A Total row would draw the whole
     * quarter a second time at double the scale, which is not a rounding error
     * on the page — it is the wrong picture. */
    for (int r = 0; r < segments->row_count; r++) {
        CHECK(strcmp(segments->row[r].label, "Total") != 0);
    }

    const int margin_row = row_of(results, "Net margin");
    long ttm_net = 0, ttm_rev = 0;
    for (int c = 0; c < cols; c++) {
        long revenue = row_cell(results, "Revenue", c);
        long net     = row_cell(results, "Net income", c);

        /* The line over the bars is a fact ABOUT the bars: net income over
         * revenue, to the basis point, and not a fourth series that happens to
         * sit near them. This is what makes 2Q26 read 58.5% — the number the
         * earnings story prints — and the two 2025 quarters read negative,
         * which is the loss that story compares against. */
        if (margin_row >= 0) {
            near("the margin line divides into its own bars",
                 net * 10000 / revenue, results->n[margin_row][c], 5);
        }

        /* The end markets sum to the revenue row, and the last column is the
         * mix printed on the rail. */
        long parts = row_cell(segments, "Client", c)
                   + row_cell(segments, "Consumer", c)
                   + row_cell(segments, "Cloud", c);
        near("the end markets sum to the revenue row", parts, revenue, 50);

        if (c >= cols - 4) { ttm_net += net; ttm_rev += revenue; }
    }

    /* $10,794M and $72.89, which are the two numbers the whole rail hangs on.
     * The Diluted EPS row is no longer printed — a bars-and-line table reads
     * every row but the last as a bar, so a seven-row version would draw six
     * series and mean nothing — but the EPS it implies still has to be the EPS
     * the rail quotes, so it is derived here from the net income that IS drawn.
     * tools/mock_news_server.py holds the rest of the chain. */
    near("TTM net income", ttm_net, 1079400, 50);
    near("TTM EPS from the statement", ttm_net * 1000000 / SHARES, 7289, 1);
    near("the TTM net margin", ttm_net * 10000 / ttm_rev, 4674, 10);

    /* P/E = price / EPS = 1631.47 / 72.89 = 22.383, printed as 22.38x. */
    near("P/E against the price and EPS", (long)s->last_c * 100 / 7289, 2238, 1);
    /* P/B = price / BPS = 1631.47 / 107.78 = 15.137, printed as 15.14x. */
    near("P/B against the price and BPS", (long)s->last_c * 100 / 10778, 1513, 1);
    /* ROE = EPS / BPS = 67.63%, which is the identity the source page's 39.3%
     * could not satisfy against these two. */
    near("ROE against EPS and BPS", 7289L * 10000 / 10778, 6763, 5);
    /* Market cap = shares x price = $241.60B, printed as $241.6B. In
     * hundredths of a billion, which is where the two divisions land it. */
    near("market cap against shares and price",
         SHARES / 1000 * s->last_c / 1000000, 24160, 20);
    /* The mean target's change is the upside it implies over the last price. */
    for (int i = 0; i < g_mock.figure_count; i++) {
        if (strcmp(g_mock.figures[i].label, "MEAN TARGET") != 0) continue;
        long target = 0;
        CHECK(cell(g_mock.figures[i].value + 1, &target) == true);   /* past the $ */
        CHECK(g_mock.figures[i].has_chg == true);
        near("the mean target's implied upside",
             (target - s->last_c) * 10000 / s->last_c,
             g_mock.figures[i].chg_bp, 2);
    }

    /* THE HERO BARS. Each is a position inside a range that is itself somewhere
     * in this payload — the subject's own 52-week bounds for one, the band the
     * statement on A2 prints for the other — so the picture can be held against
     * the numbers beside it. A bar is the one thing on the rail a reader cannot
     * verify by looking at it, which is exactly why it is verified here.
     *
     * The tolerance is one part in a thousand: the producer rounds where this
     * test's integer division truncates. */
    near("the 52-WEEK RANGE bar inside the 52-week range",
         where_in(s->last_c, s->wk52_lo_c, s->wk52_hi_c), bar_of("52-WEEK RANGE"), 1);

    /* The margin bar sits inside the band the statement itself draws, so the
     * graphic on A1's rail and the line over the bars on A2 are the same fact
     * about the same six quarters rather than two numbers that happen to agree. */
    if (margin_row >= 0) {
        long lo = results->n[margin_row][0], hi = lo;
        for (int c = 1; c < cols; c++) {
            long v = results->n[margin_row][c];
            if (v < lo) lo = v;
            if (v > hi) hi = v;
        }
        near("the NET MARGIN bar inside the band the statement prints",
             where_in(ttm_net * 10000 / ttm_rev, lo, hi), bar_of("NET MARGIN TTM"), 1);
    }

    /* And the third hero carries no bar at all, which is the shape a hero has
     * when there is nothing for it to sit inside. A price target's high and low
     * are opinions, not a traded band. */
    CHECK_INT(bar_of("MEAN TARGET"), -1);

    /* Exactly one peer is us, and it prints the same two numbers the nameplate
     * does. Two rows in bold, or a bold row quoting a different price, is the
     * kind of thing a reader spots across a room. */
    int subject_rows = 0;
    for (int i = 0; i < g_mock.peer_count; i++) {
        if (!g_mock.peers[i].is_subject) continue;
        subject_rows++;
        CHECK_STR(g_mock.peers[i].symbol, s->symbol);
        CHECK_INT(g_mock.peers[i].last_c, s->last_c);
        CHECK_INT(g_mock.peers[i].chg_bp, s->chg_bp);
    }
    CHECK_INT(subject_rows, 1);
}

int main(void)
{
    test_mock_matches_the_wire_fixture();
    test_mock_is_internally_legal();
    test_mock_is_english_only();
    test_mock_respects_the_length_budget();
    test_mock_is_a_complete_edition();
    test_the_demo_edition_adds_up();
    TH_REPORT("news_mock");
}
