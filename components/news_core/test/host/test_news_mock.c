/*
 * Host unit tests tying the built-in demo front page to the wire contract.
 *
 * news_mock.c is what an unconfigured board shows; tools/mock_news_server.py is
 * the reference producer, and fixtures/news.json is its committed output. Those
 * are two hand-written descriptions of the same page, in two languages, and
 * they will drift the first time somebody edits one of them.
 *
 * So the main test here is: parse the fixture, and assert it fingerprints
 * identically to the C snapshot. If someone adds a ticker to the demo page and
 * forgets the server (or vice versa), this fails with the field named rather
 * than showing up as a screenshot that no longer matches the docs.
 *
 * The rest of the file checks that the demo page is internally legal and
 * complete — it is, after all, the one snapshot that never goes through the
 * parser's clamping, so nothing else would catch a Korean glyph or an empty
 * band in it.
 */
#include "th.h"

#include "news_mock.h"
#include "news_model.h"
#include "news_parse.h"

/* ~18 KB apiece; file-static so no frame ever carries two. */
static news_t g_mock, g_wire;

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
    CHECK_STR(m->symbol, w->symbol);
    CHECK_INT(m->last_c, w->last_c);
    CHECK_INT(m->chg_bp, w->chg_bp);

    CHECK_INT(m->chart.kind, w->chart.kind);
    CHECK_STR(m->chart.span, w->chart.span);
    CHECK_INT(m->chart.n, w->chart.n);
    for (int k = 0; k < m->chart.n && k < w->chart.n; k++) {
        CHECK_INT(m->chart.o[k], w->chart.o[k]);
        CHECK_INT(m->chart.h[k], w->chart.h[k]);
        CHECK_INT(m->chart.l[k], w->chart.l[k]);
        CHECK_INT(m->chart.c[k], w->chart.c[k]);
    }

    CHECK_STR(m->photo.id, w->photo.id);
    CHECK_INT(m->photo.w, w->photo.w);
    CHECK_INT(m->photo.h, w->photo.h);
    CHECK_STR(m->photo.caption, w->photo.caption);
    CHECK_STR(m->photo.credit, w->photo.credit);
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

    CHECK_INT(g_mock.index_count, g_wire.index_count);
    for (int i = 0; i < g_mock.index_count && i < g_wire.index_count; i++) {
        cmp_quote("indices", i, &g_mock.indices[i], &g_wire.indices[i]);
    }
    CHECK_INT(g_mock.ticker_count, g_wire.ticker_count);
    for (int i = 0; i < g_mock.ticker_count && i < g_wire.ticker_count; i++) {
        cmp_quote("tickers", i, &g_mock.tickers[i], &g_wire.tickers[i]);
    }
    CHECK_INT(g_mock.story_count, g_wire.story_count);
    for (int i = 0; i < g_mock.story_count && i < g_wire.story_count; i++) {
        cmp_story(i, &g_mock.stories[i], &g_wire.stories[i]);
    }
}

static void test_mock_is_internally_legal(void)
{
    news_mock(&g_mock);

    CHECK(g_mock.valid == true);
    CHECK(g_mock.index_count  >= 0 && g_mock.index_count  <= NEWS_INDEX_MAX);
    CHECK(g_mock.story_count  >= 0 && g_mock.story_count  <= NEWS_STORIES_MAX);
    CHECK(g_mock.ticker_count >= 0 && g_mock.ticker_count <= NEWS_TICKERS_MAX);

    for (int i = 0; i < g_mock.story_count; i++) {
        const news_story_t *s = &g_mock.stories[i];
        CHECK(s->headline[0] != '\0');      /* a kicker over an empty column */
        CHECK(s->rank == i);                /* the tier is the index */
        CHECK(s->chart.n >= 0 && s->chart.n <= NEWS_BARS_MAX);
        /* The model's single test for "is there a chart" has to hold in the one
         * snapshot the parser never clamped. */
        CHECK((s->chart.kind == CHART_NONE) == (s->chart.n == 0));
        /* Same for the photo: an id without dimensions is a GET that cannot be
         * made, and a caption under a slot that stayed empty. */
        CHECK((s->photo.id[0] == '\0') == (s->photo.w == 0 && s->photo.h == 0));
    }

    for (int i = 0; i < g_mock.ticker_count; i++) {
        CHECK(g_mock.tickers[i].symbol[0] != '\0');
        CHECK(g_mock.tickers[i].spark_n >= 0);
        CHECK(g_mock.tickers[i].spark_n <= NEWS_SPARK_MAX);
        for (int k = 0; k < g_mock.tickers[i].spark_n; k++) {
            CHECK(g_mock.tickers[i].spark[k] >= 0);
            CHECK(g_mock.tickers[i].spark[k] <= 1000);
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

    for (int i = 0; i < g_mock.index_count; i++) {
        check_english("index symbol", g_mock.indices[i].symbol);
        check_english("index name", g_mock.indices[i].name);
    }
    for (int i = 0; i < g_mock.ticker_count; i++) {
        check_english("ticker symbol", g_mock.tickers[i].symbol);
        check_english("ticker name", g_mock.tickers[i].name);
    }
    for (int i = 0; i < g_mock.story_count; i++) {
        const news_story_t *s = &g_mock.stories[i];
        check_english("kicker", s->kicker);
        check_english("headline", s->headline);
        check_english("deck", s->deck);
        check_english("byline", s->byline);
        check_english("body", s->body);
        check_english("chart span", s->chart.span);
        check_english("caption", s->photo.caption);
        check_english("credit", s->photo.credit);
    }
}

static void test_mock_is_a_complete_front_page(void)
{
    /* Real data is easy. The demo is what the README shows and what the
     * simulator asserts against, so it has to fill every band the layout can
     * draw and exercise every branch the layout can take. */
    news_mock(&g_mock);

    CHECK_INT(g_mock.index_count, NEWS_INDEX_MAX);      /* all five ribbon cells */
    CHECK_INT(g_mock.ticker_count, NEWS_TICKERS_MAX);   /* both blocks of eight  */
    CHECK_INT(g_mock.story_count, 4);                   /* a lead and band 6     */

    /* The lead's body has to overflow one column, or the two-column copyfit is
     * never exercised by the page everybody looks at first. */
    CHECK(strlen(g_mock.stories[0].body) >= 700);
    CHECK(strlen(g_mock.stories[0].body) < NEWS_BODY_MAX);
    CHECK(g_mock.stories[0].deck[0] != '\0');
    CHECK(g_mock.stories[0].kicker[0] != '\0');
    CHECK(g_mock.stories[0].byline[0] != '\0');

    /* Photo AND chart on the lead: the case the layout has to resolve rather
     * than the case it can assume away. */
    CHECK_INT(g_mock.stories[0].chart.kind, CHART_CANDLE);
    CHECK(g_mock.stories[0].photo.id[0] != '\0');
    CHECK(g_mock.stories[0].photo.caption[0] != '\0');

    /* Exactly one secondary carries a chart, and it is a line — band 6 is
     * specified as "0-1 of the three carry one". */
    int line_charts = 0, symbol_less = 0;
    for (int i = 1; i < g_mock.story_count; i++) {
        if (g_mock.stories[i].chart.kind == CHART_LINE) line_charts++;
        if (g_mock.stories[i].symbol[0] == '\0') symbol_less++;
    }
    CHECK_INT(line_charts, 1);
    /* A macro story quotes nothing, and the row must not assume otherwise. */
    CHECK(symbol_less >= 1);

    /* Both colours have to appear, or the one place colour is allowed goes out
     * of the README untested. */
    int up = 0, down = 0;
    for (int i = 0; i < g_mock.ticker_count; i++) {
        if (g_mock.tickers[i].chg_bp > 0) up++;
        if (g_mock.tickers[i].chg_bp < 0) down++;
    }
    CHECK(up > 0);
    CHECK(down > 0);
    for (int i = 0; i < g_mock.index_count; i++) {
        CHECK(g_mock.indices[i].spark_n > 0);
    }

    /* The chart's last close is the price printed beside it. A reader catches
     * that disagreement before any other. */
    CHECK_INT(g_mock.stories[0].chart.c[g_mock.stories[0].chart.n - 1],
              g_mock.stories[0].last_c);
    CHECK_INT(g_mock.stories[0].last_c, g_mock.tickers[0].last_c);
}

int main(void)
{
    test_mock_matches_the_wire_fixture();
    test_mock_is_internally_legal();
    test_mock_is_english_only();
    test_mock_is_a_complete_front_page();
    TH_REPORT("news_mock");
}
