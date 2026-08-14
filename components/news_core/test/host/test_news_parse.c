/*
 * Host unit tests for news_parse.c.
 *
 * The producer of this JSON is an agent running on somebody's machine. It is
 * going to send a string where a number belongs, a null where a headline
 * belongs, an array of nine hundred entries, a chart with a hole in it, a photo
 * id with no dimensions, and — the day the machine sleeps mid-response — half a
 * document. None of that may crash the board, and none of it may replace a good
 * front page with a blank one.
 *
 * So these tests are mostly not about the happy path. The happy path is one
 * test at the top; everything after it is a way of being wrong.
 */
#include "th.h"

#include "news_model.h"
#include "news_parse.h"

#define PARSE(json, out) news_parse((json), strlen(json), (out))

/* news_t is ~18 KB. One of these is fine on a host stack, but a test that
 * declares four in a frame is a test that will one day be run somewhere
 * smaller, so they are file-static. */
static news_t g_a, g_b;

/* --- the happy path, from the committed contract fixture ------------------ */

static void test_fixture(void)
{
    size_t len = 0;
    char *json = th_slurp(FIXDIR "/news.json", &len);

    news_t *v = &g_a;
    memset(v, 0xAA, sizeof(*v));            /* poison: every field must be written */
    CHECK(news_parse(json, len, v) == true);

    CHECK(v->valid == true);
    CHECK(v->demo == false);                 /* a fetched page is not the demo */
    CHECK_STR(v->edition, "PERSONAL PORTFOLIO EDITION");
    CHECK_STR(v->dateline, "FRIDAY, AUGUST 14, 2026");
    CHECK_STR(v->session, "U.S. MARKETS CLOSED — AUG 13");
    CHECK_STR(v->as_of, "AS OF 05:12 KST");
    CHECK_STR(v->generated_at, "2026-08-14T05:12:00Z");

    /* Money is cents and a change is basis points, both int32: 6412.83 is
     * 641283 and 0.62% is 62 on every platform, or the fingerprint moves
     * between the simulator and the device for no reason. */
    CHECK_INT(v->index_count, 5);
    CHECK_STR(v->indices[0].symbol, "SPX");
    CHECK_STR(v->indices[0].name, "S&P 500");
    CHECK_INT(v->indices[0].last_c, 641283);
    CHECK_INT(v->indices[0].chg_bp, 62);
    CHECK_INT(v->indices[0].spark_n, 12);
    CHECK_INT(v->indices[0].spark[0], 402);
    CHECK_INT(v->indices[4].chg_bp, -310);   /* VIX, and the sign survives */

    CHECK_INT(v->ticker_count, 16);
    CHECK_STR(v->tickers[0].symbol, "NVDA");
    CHECK_INT(v->tickers[0].last_c, 18322);
    CHECK_INT(v->tickers[0].chg_bp, -184);
    CHECK_STR(v->tickers[15].symbol, "V");

    CHECK_INT(v->story_count, 4);
    CHECK_INT(v->stories[0].rank, 0);
    CHECK_STR(v->stories[0].kicker, "SEMICONDUCTORS");
    /* U+2019, not the ASCII U+0027 the producer may have sent: news_parse.c
     * promotes the typewriter apostrophe to the typographic one between two
     * letters, because a straight tick at 56 px in a lead headline is the one
     * detail that makes a typeset page read as a mock-up. */
    CHECK_STR(v->stories[0].headline,
              "Nvidia’s blowout quarter resets the whole AI trade");
    CHECK_STR(v->stories[0].byline, "By CLAUDE · MARKET DESK");
    CHECK_STR(v->stories[0].symbol, "NVDA");
    CHECK_INT(v->stories[0].last_c, 18322);
    CHECK(strlen(v->stories[0].body) > 700);   /* two 368 px columns of body_20 */

    CHECK_INT(v->stories[0].chart.kind, CHART_CANDLE);
    CHECK_STR(v->stories[0].chart.span, "1M");
    CHECK_INT(v->stories[0].chart.n, 22);
    CHECK_INT(v->stories[0].chart.o[0], 16840);
    CHECK_INT(v->stories[0].chart.c[21], 18322); /* agrees with the printed last */

    CHECK_STR(v->stories[0].photo.id, "nvda_hq");
    CHECK_INT(v->stories[0].photo.w, 1140);
    CHECK_INT(v->stories[0].photo.h, 360);
    CHECK_STR(v->stories[0].photo.credit, "DEMO IMAGE");

    /* The energy story's chart arrives as bare closes, not quadruples. */
    CHECK_INT(v->stories[1].chart.kind, CHART_LINE);
    CHECK_INT(v->stories[1].chart.n, 30);
    CHECK_INT(v->stories[1].chart.c[0], 11985);
    CHECK_INT(v->stories[1].chart.o[0], 11985);

    /* The macro story has no quote and no chart at all. */
    CHECK_STR(v->stories[2].symbol, "");
    CHECK_INT(v->stories[2].chart.kind, CHART_NONE);
    CHECK_STR(v->stories[2].photo.id, "");

    free(json);
}

/* --- rejection: *out must survive ----------------------------------------- */

/* Every rejection path is checked the same way: fill `out` with a known good
 * page first, and assert it is byte-identical afterwards. That is the actual
 * product requirement — a bad poll leaves the previous front page on the glass
 * — and it is not something "returns false" alone guarantees. memcmp rather
 * than the fingerprint, because the fingerprint is derived from the same struct
 * and a parser that scribbled on an unused array slot would pass it. */
static void check_rejects_and_preserves(const char *label, const char *json, size_t len)
{
    size_t flen = 0;
    char *good = th_slurp(FIXDIR "/news.json", &flen);

    CHECK(news_parse(good, flen, &g_a) == true);
    g_b = g_a;

    bool ok = news_parse(json, len, &g_a);
    g_total++;
    if (ok) {
        g_fail++;
        printf("  FAIL %s: accepted\n", label);
    } else if (memcmp(&g_a, &g_b, sizeof(g_a)) != 0) {
        g_fail++;
        printf("  FAIL %s: rejected but *out was modified\n", label);
    }
    free(good);
}

/* The length is taken from the literal rather than counted by hand: an
 * off-by-one here would hand cJSON a byte past the end of a string constant and
 * the test would be measuring the sanitizer's patience instead of the parser. */
#define REJECTS(label, json) check_rejects_and_preserves((label), (json), strlen(json))

static void test_rejections(void)
{
    check_rejects_and_preserves("empty", "", 0);
    REJECTS("not json", "<html>hi</html>");
    REJECTS("array root", "[1,2,3]");
    REJECTS("string root", "\"hello\"");

    /* The machine closed its lid mid-response. cJSON must not read past the
     * length it was handed, and half a page must not reach the glass. */
    size_t flen = 0;
    char *full = th_slurp(FIXDIR "/news.json", &flen);
    check_rejects_and_preserves("truncated at half", full, flen / 2);
    check_rejects_and_preserves("truncated to 1 byte", full, 1);
    free(full);

    /* Well-formed and empty. This is what a captive-portal login page, a "{}"
     * health endpoint, or an error envelope parses down to, and replacing a
     * good page with blankness is the one failure a user actually notices. */
    REJECTS("empty object", "{}");
    REJECTS("only a masthead", "{\"edition\":\"X\",\"dateline\":\"Y\"}");
    REJECTS("error envelope", "{\"error\":\"unauthorized\",\"code\":401}");
    REJECTS("stories present but all headless",
            "{\"stories\":[{\"rank\":0,\"kicker\":\"X\"}]}");
}

#undef REJECTS

/* --- individual bad fields are NOT rejections ----------------------------- */

static void test_type_confusion_clamps(void)
{
    /* Every field here is the wrong type. The document still carries one
     * ticker, so it is a usable page with defaults everywhere else — the
     * alternative, rejecting the lot, would blank the board because one
     * producer wrote a string for `last`. */
    const char *json =
        "{\"edition\":123,"
        " \"dateline\":null,"
        " \"session\":[],"
        " \"indices\":{\"not\":\"an array\"},"
        " \"stories\":\"nope\","
        " \"tickers\":[{\"symbol\":\"AAPL\",\"name\":null,\"last\":\"expensive\","
        "               \"change_pct\":{},\"spark\":\"nope\"}]}";
    CHECK(PARSE(json, &g_a) == true);
    CHECK_STR(g_a.edition, "");
    CHECK_STR(g_a.dateline, "");
    CHECK_STR(g_a.session, "");
    CHECK_INT(g_a.index_count, 0);
    CHECK_INT(g_a.story_count, 0);
    CHECK_INT(g_a.ticker_count, 1);
    CHECK_STR(g_a.tickers[0].name, "");
    CHECK_INT(g_a.tickers[0].last_c, 0);
    CHECK_INT(g_a.tickers[0].chg_bp, 0);
    CHECK_INT(g_a.tickers[0].spark_n, 0);
}

static void test_money_and_percent_round(void)
{
    /* Truncating instead of rounding would make 183.22 arrive as 18321 on a
     * machine whose double lands a hair low, and a price that ticks by a cent
     * when nothing moved costs a twenty-five-second refresh. */
    const char *json =
        "{\"tickers\":["
        "{\"symbol\":\"A\",\"last\":183.22,\"change_pct\":-1.84},"
        "{\"symbol\":\"B\",\"last\":0.015,\"change_pct\":0.005},"
        "{\"symbol\":\"C\",\"last\":-0.015,\"change_pct\":-0.005},"
        "{\"symbol\":\"D\",\"last\":6412,\"change_pct\":0},"
        "{\"symbol\":\"E\",\"last\":1e308,\"change_pct\":-1e308}]}";
    CHECK(PARSE(json, &g_a) == true);
    CHECK_INT(g_a.tickers[0].last_c, 18322);
    CHECK_INT(g_a.tickers[0].chg_bp, -184);
    CHECK_INT(g_a.tickers[1].last_c, 2);       /* half away from zero */
    CHECK_INT(g_a.tickers[1].chg_bp, 1);
    CHECK_INT(g_a.tickers[2].last_c, -2);
    CHECK_INT(g_a.tickers[2].chg_bp, -1);
    CHECK_INT(g_a.tickers[3].last_c, 641200);  /* an integer price is still cents */
    /* An overflow clamps rather than wrapping: an int32 that wrapped negative
     * would print a price with a minus sign in front of it. */
    CHECK(g_a.tickers[4].last_c > 0);
    CHECK(g_a.tickers[4].chg_bp < 0);
}

static void test_sparks_are_clamped_and_right_aligned(void)
{
    /* A sparkline is a history: the end being read is the right-hand one, so an
     * over-long series loses its oldest samples. Out-of-range values would draw
     * outside the 48x14 box. */
    static char json[4096];
    int n = snprintf(json, sizeof(json),
                     "{\"tickers\":[{\"symbol\":\"A\",\"spark\":[-5,1500,500]},"
                     "{\"symbol\":\"B\",\"spark\":[");
    for (int i = 0; i < 40; i++) {
        n += snprintf(json + n, sizeof(json) - n, "%s%d", i ? "," : "", i * 25);
    }
    snprintf(json + n, sizeof(json) - n, "]}]}");

    CHECK(PARSE(json, &g_a) == true);
    CHECK_INT(g_a.tickers[0].spark_n, 3);
    CHECK_INT(g_a.tickers[0].spark[0], 0);
    CHECK_INT(g_a.tickers[0].spark[1], 1000);
    CHECK_INT(g_a.tickers[0].spark[2], 500);

    CHECK_INT(g_a.tickers[1].spark_n, NEWS_SPARK_MAX);
    CHECK_INT(g_a.tickers[1].spark[0], (40 - NEWS_SPARK_MAX) * 25);
    CHECK_INT(g_a.tickers[1].spark[NEWS_SPARK_MAX - 1], 975);
}

/* --- capacity ------------------------------------------------------------- */

static void test_oversized_arrays_are_capped(void)
{
    static char json[65536];
    int n = snprintf(json, sizeof(json), "{\"indices\":[");
    for (int i = 0; i < 40; i++) {
        n += snprintf(json + n, sizeof(json) - n, "%s{\"symbol\":\"I%d\"}", i ? "," : "", i);
    }
    n += snprintf(json + n, sizeof(json) - n, "],\"tickers\":[");
    for (int i = 0; i < 40; i++) {
        n += snprintf(json + n, sizeof(json) - n, "%s{\"symbol\":\"T%d\"}", i ? "," : "", i);
    }
    n += snprintf(json + n, sizeof(json) - n, "],\"stories\":[");
    for (int i = 0; i < 40; i++) {
        n += snprintf(json + n, sizeof(json) - n,
                      "%s{\"rank\":%d,\"headline\":\"h%d\"}", i ? "," : "", 39 - i, i);
    }
    n += snprintf(json + n, sizeof(json) - n, "]}");
    CHECK(n < (int)sizeof(json));

    CHECK(PARSE(json, &g_a) == true);
    CHECK_INT(g_a.index_count, NEWS_INDEX_MAX);
    CHECK_INT(g_a.ticker_count, NEWS_TICKERS_MAX);
    CHECK_INT(g_a.story_count, NEWS_STORIES_MAX);

    /* The ranks descend through the array, so keeping the first six would keep
     * the six least important stories and drop the lead. The six lowest ranks
     * are the ones that survive, and they come out sorted. */
    for (int i = 0; i < g_a.story_count; i++) {
        CHECK_INT(g_a.stories[i].rank, i);
    }
    CHECK_STR(g_a.stories[0].headline, "h39");
}

static void test_bars_are_capped_at_the_recent_end(void)
{
    static char json[8192];
    int n = snprintf(json, sizeof(json),
                     "{\"stories\":[{\"rank\":0,\"headline\":\"h\","
                     "\"chart\":{\"kind\":\"line\",\"span\":\"1Y\",\"bars\":[");
    for (int i = 0; i < 200; i++) {
        n += snprintf(json + n, sizeof(json) - n, "%s%d", i ? "," : "", i);
    }
    snprintf(json + n, sizeof(json) - n, "]}}]}");

    CHECK(PARSE(json, &g_a) == true);
    CHECK_INT(g_a.stories[0].chart.n, NEWS_BARS_MAX);
    /* The right-hand end of a price series is the end being read. */
    CHECK_INT(g_a.stories[0].chart.c[0], (200 - NEWS_BARS_MAX) * 100);
    CHECK_INT(g_a.stories[0].chart.c[NEWS_BARS_MAX - 1], 19900);
}

/* --- charts --------------------------------------------------------------- */

static void test_chart_kinds(void)
{
    CHECK_INT(news_chart_kind_from("line"), CHART_LINE);
    CHECK_INT(news_chart_kind_from("CANDLE"), CHART_CANDLE);   /* case-insensitive */
    CHECK_INT(news_chart_kind_from("Bar"), CHART_BAR);
    CHECK_INT(news_chart_kind_from("none"), CHART_NONE);
    CHECK_INT(news_chart_kind_from("sparkline"), CHART_NONE);  /* unknown, not garbage */
    CHECK_INT(news_chart_kind_from(NULL), CHART_NONE);
}

static void test_charts_that_cannot_be_drawn_become_none(void)
{
    /* A kind with no usable bars would reserve its slot and draw an empty box.
     * `kind == CHART_NONE` is the model's single test for "is there a chart",
     * so the parser has to make it true rather than leaving four call sites to
     * check `n` as well. */
    const char *json =
        "{\"stories\":["
        "{\"rank\":0,\"headline\":\"a\",\"chart\":{\"kind\":\"candle\",\"span\":\"1M\"}},"
        "{\"rank\":1,\"headline\":\"b\",\"chart\":{\"kind\":\"candle\",\"bars\":[]}},"
        "{\"rank\":2,\"headline\":\"c\",\"chart\":{\"kind\":\"wat\",\"bars\":[1,2,3]}},"
        "{\"rank\":3,\"headline\":\"d\",\"chart\":{\"kind\":\"bar\","
        "  \"bars\":[[1,2,3],[4,5,6,\"x\"],[1,2,3,4]]}}]}";
    CHECK(PARSE(json, &g_a) == true);
    CHECK_INT(g_a.stories[0].chart.kind, CHART_NONE);
    CHECK_STR(g_a.stories[0].chart.span, "");     /* and the span goes with it */
    CHECK_INT(g_a.stories[1].chart.kind, CHART_NONE);
    CHECK_INT(g_a.stories[2].chart.kind, CHART_NONE);
    CHECK_INT(g_a.stories[2].chart.n, 0);

    /* The short quadruple and the one with a string in it are dropped; the
     * whole chart is not. A bar with a hole in it has no low to draw from. */
    CHECK_INT(g_a.stories[3].chart.kind, CHART_BAR);
    CHECK_INT(g_a.stories[3].chart.n, 1);
    CHECK_INT(g_a.stories[3].chart.o[0], 100);
    CHECK_INT(g_a.stories[3].chart.c[0], 400);
}

static void test_flat_line_bars_fill_all_four_series(void)
{
    /* The flat form is one close per point. Open, high and low are set to match
     * so that a consumer reaching for h[] gets a zero-height bar rather than
     * one spanning the whole scale out of a series that never had one. */
    const char *json =
        "{\"stories\":[{\"rank\":0,\"headline\":\"h\",\"chart\":"
        "{\"kind\":\"line\",\"span\":\"5D\",\"bars\":[10.5,11,\"x\",12.25]}}]}";
    CHECK(PARSE(json, &g_a) == true);
    const news_chart_t *c = &g_a.stories[0].chart;
    CHECK_INT(c->kind, CHART_LINE);
    CHECK_INT(c->n, 3);
    CHECK_INT(c->c[0], 1050);
    CHECK_INT(c->o[0], 1050);
    CHECK_INT(c->h[0], 1050);
    CHECK_INT(c->l[0], 1050);
    CHECK_INT(c->c[2], 1225);
}

/* --- photos --------------------------------------------------------------- */

static void test_photos_without_dimensions_are_dropped(void)
{
    /* The id is the URL and the dimensions are the byte count of the tile —
     * w*h/2 raw bytes — so one without the other cannot be fetched, and a
     * caption under a slot that stayed empty is worse than no caption. */
    const char *json =
        "{\"stories\":["
        "{\"rank\":0,\"headline\":\"a\",\"photo\":{\"id\":\"x\",\"caption\":\"c\"}},"
        "{\"rank\":1,\"headline\":\"b\",\"photo\":{\"w\":100,\"h\":50,\"credit\":\"AP\"}},"
        "{\"rank\":2,\"headline\":\"c\",\"photo\":{\"id\":\"y\",\"w\":-8,\"h\":50}},"
        "{\"rank\":3,\"headline\":\"d\",\"photo\":{\"id\":\"z\",\"w\":99999,\"h\":99999}}]}";
    CHECK(PARSE(json, &g_a) == true);
    CHECK_STR(g_a.stories[0].photo.id, "");
    CHECK_STR(g_a.stories[0].photo.caption, "");
    CHECK_STR(g_a.stories[1].photo.id, "");
    CHECK_STR(g_a.stories[1].photo.credit, "");
    CHECK_STR(g_a.stories[2].photo.id, "");
    /* Clamped to the panel, not dropped: an oversized tile is a producer that
     * has not read the slot table, and the layout can still crop it. */
    CHECK_STR(g_a.stories[3].photo.id, "z");
    CHECK_INT(g_a.stories[3].photo.w, 1200);
    CHECK_INT(g_a.stories[3].photo.h, 1600);
}

/* --- stories -------------------------------------------------------------- */

static void test_stories_sort_by_rank_and_keep_order_within_it(void)
{
    /* The device assigns tiers by index — stories[0] is the lead, 1..3 the
     * secondary row — so the sort is load-bearing, and a producer that emits
     * them in the order it found them must not change the page. */
    const char *json =
        "{\"stories\":["
        "{\"rank\":2,\"headline\":\"c\"},"
        "{\"rank\":0,\"headline\":\"a\"},"
        "{\"headline\":\"unranked\"},"
        "{\"rank\":1,\"headline\":\"b1\"},"
        "{\"rank\":1,\"headline\":\"b2\"}]}";
    CHECK(PARSE(json, &g_a) == true);
    CHECK_INT(g_a.story_count, 5);
    CHECK_STR(g_a.stories[0].headline, "a");
    CHECK_STR(g_a.stories[1].headline, "b1");   /* stable within equal ranks */
    CHECK_STR(g_a.stories[2].headline, "b2");
    CHECK_STR(g_a.stories[3].headline, "c");
    CHECK_STR(g_a.stories[4].headline, "unranked");  /* no rank sinks to the end */
    CHECK_INT(g_a.stories[4].rank, NEWS_STORIES_MAX);
}

static void test_stories_without_a_headline_are_skipped(void)
{
    /* A story with no headline is a kicker over an empty column. */
    const char *json =
        "{\"stories\":["
        "{\"rank\":0,\"kicker\":\"K\",\"body\":\"words\"},"
        "{\"rank\":1,\"headline\":\"\"},"
        "{\"rank\":2,\"headline\":\"real\"}],"
        " \"tickers\":[{\"name\":\"no symbol\"},{\"symbol\":\"OK\"}],"
        " \"indices\":[{\"symbol\":\"\"},{\"symbol\":\"SPX\"}]}";
    CHECK(PARSE(json, &g_a) == true);
    CHECK_INT(g_a.story_count, 1);
    CHECK_STR(g_a.stories[0].headline, "real");
    CHECK_INT(g_a.ticker_count, 1);
    CHECK_STR(g_a.tickers[0].symbol, "OK");
    CHECK_INT(g_a.index_count, 1);
    CHECK_STR(g_a.indices[0].symbol, "SPX");
}

static void test_a_dropped_candidate_does_not_clobber_a_kept_story(void)
{
    /* When the array overflows, the parser writes the new story into the slot
     * held by the worst-ranked one it already has. A candidate that then turns
     * out to have no headline must not have destroyed that story on its way
     * out. Six good stories, then a seventh that is better-ranked but headless. */
    const char *json =
        "{\"stories\":["
        "{\"rank\":0,\"headline\":\"a\"},{\"rank\":1,\"headline\":\"b\"},"
        "{\"rank\":2,\"headline\":\"c\"},{\"rank\":3,\"headline\":\"d\"},"
        "{\"rank\":4,\"headline\":\"e\"},{\"rank\":5,\"headline\":\"f\"},"
        "{\"rank\":0,\"kicker\":\"NO HEADLINE\"}]}";
    CHECK(PARSE(json, &g_a) == true);
    CHECK_INT(g_a.story_count, NEWS_STORIES_MAX);
    CHECK_STR(g_a.stories[5].headline, "f");
    CHECK_INT(g_a.stories[5].rank, 5);
}

/* --- strings -------------------------------------------------------------- */

static void test_long_headline_truncates_on_a_boundary(void)
{
    /* NEWS_HEADLINE_MAX is a byte count and the typography a copy desk emits is
     * multi-byte, so the cut lands mid-sequence unless the copy is UTF-8 aware.
     * Half an em dash does not render as "the headline was long" — it renders
     * as a tofu box, and can walk LVGL's decoder past the NUL. */
    static char json[1024];
    char headline[512] = {0};
    for (int i = 0; i < 60; i++) strcat(headline, "€");   /* 180 bytes */
    snprintf(json, sizeof(json),
             "{\"stories\":[{\"rank\":0,\"headline\":\"%s\"}]}", headline);

    CHECK(PARSE(json, &g_a) == true);
    CHECK_INT(g_a.story_count, 1);

    const char *t = g_a.stories[0].headline;
    size_t len = strlen(t);
    CHECK(len < NEWS_HEADLINE_MAX);
    CHECK_INT(len % 3, 0);                 /* whole codepoints only */
    for (size_t i = 0; i < len; i += 3) {
        CHECK(memcmp(t + i, "€", 3) == 0);
    }
}

static void test_str_copy(void)
{
    char buf[8];

    CHECK_INT(news_str_copy(buf, sizeof(buf), "abc"), 3);
    CHECK_STR(buf, "abc");

    /* 7 bytes of room: two 3-byte codepoints fit, the third does not. */
    CHECK_INT(news_str_copy(buf, sizeof(buf), "€€€"), 6);
    CHECK_STR(buf, "€€");

    /* A source that is itself truncated mid-sequence: drop the partial glyph
     * rather than copy a lone lead byte out. */
    CHECK_INT(news_str_copy(buf, sizeof(buf), "€\xE2\x82"), 3);
    CHECK_STR(buf, "€");

    CHECK_INT(news_str_copy(buf, sizeof(buf), NULL), 0);
    CHECK_STR(buf, "");

    /* Never writes past the end, and always terminates. */
    char tiny[2];
    CHECK_INT(news_str_copy(tiny, sizeof(tiny), "€"), 0);
    CHECK_STR(tiny, "");
    CHECK_INT(news_str_copy(tiny, sizeof(tiny), "xy"), 1);
    CHECK_STR(tiny, "x");
}

/* The typewriter apostrophe, promoted. Headlines arrive over the network from
 * an agent that will send ASCII, and U+0027 set at 56 px is a vertical tick
 * between the a and the s — the one detail that makes an otherwise typeset page
 * read as a mock-up. Only between two LETTERS: an opening quotation mark is
 * ambiguous without more context than a byte-wise copy has, and is left alone.
 * Identifiers — a symbol, a tile id, a timestamp — go through news_str_copy()
 * and are never touched at all. */
static void test_prose_copy_curls_the_apostrophe(void)
{
    char buf[64];

    CHECK_INT(news_str_copy_prose(buf, sizeof(buf), "Nvidia's quarter"), 18);
    CHECK_STR(buf, "Nvidia’s quarter");

    /* Not an apostrophe: nothing on either side that makes it one. */
    CHECK_INT(news_str_copy_prose(buf, sizeof(buf), "'tis 'a' x'"), 11);
    CHECK_STR(buf, "'tis 'a' x'");

    /* The three bytes are counted against the field, on the same boundary
     * news_str_copy() already clamps the em dashes and the accented names the
     * wire is full of: 7 bytes of room holds "ab’c" and not "ab’cd". */
    char small[7];
    CHECK_INT(news_str_copy_prose(small, sizeof(small), "ab'cd"), 6);
    CHECK_STR(small, "ab’c");

    CHECK_INT(news_str_copy_prose(buf, sizeof(buf), NULL), 0);
    CHECK_STR(buf, "");
}

/* --- the fingerprint ------------------------------------------------------ */

static void test_hash_is_content_addressed(void)
{
    /* This is what stops the panel spending twenty-five seconds flashing every
     * five minutes forever, so it gets its own tests: identical content must
     * hash identically even when the two structs were built by different code
     * paths and had different garbage in their unused array slots. */
    size_t len = 0;
    char *json = th_slurp(FIXDIR "/news.json", &len);

    memset(&g_a, 0x00, sizeof(g_a));
    memset(&g_b, 0xFF, sizeof(g_b));
    CHECK(news_parse(json, len, &g_a) == true);
    CHECK(news_parse(json, len, &g_b) == true);
    CHECK_INT(news_hash(&g_a), news_hash(&g_b));
    free(json);

    uint32_t base = news_hash(&g_a);

    /* Everything that reaches the glass has to move it. A fingerprint that is
     * too narrow does not fail loudly — it shows yesterday's page forever. */
    #define MOVES(what, mutation) do {              \
        g_b = g_a;                                  \
        mutation;                                   \
        g_total++;                                  \
        if (news_hash(&g_b) == base) {              \
            g_fail++;                               \
            printf("  FAIL news_hash ignores %s\n", what); \
        }                                           \
    } while (0)

    MOVES("edition",        g_b.edition[0] = 'X');
    MOVES("dateline",       g_b.dateline[0] = 'X');
    MOVES("session",        g_b.session[0] = 'X');
    MOVES("as_of",          g_b.as_of[0] = 'X');
    MOVES("generated_at",   g_b.generated_at[0] = 'X');
    MOVES("demo",           g_b.demo = true);
    MOVES("an index price", g_b.indices[0].last_c++);
    MOVES("an index spark", g_b.indices[0].spark[3]++);
    MOVES("a ticker change", g_b.tickers[9].chg_bp++);
    MOVES("a ticker spark",  g_b.tickers[15].spark[11]++);
    MOVES("a headline",      g_b.stories[0].headline[0] = 'X');
    MOVES("a body",          g_b.stories[3].body[0] = 'X');
    MOVES("a story rank",    g_b.stories[2].rank++);
    MOVES("a chart span",    g_b.stories[0].chart.span[0] = 'X');
    MOVES("a candle low",    g_b.stories[0].chart.l[7]++);
    MOVES("the last close",  g_b.stories[1].chart.c[29]++);
    MOVES("a photo id",      g_b.stories[0].photo.id[0] = 'X');
    MOVES("a photo width",   g_b.stories[0].photo.w++);
    MOVES("a caption",       g_b.stories[0].photo.caption[0] = 'X');
    MOVES("a credit",        g_b.stories[0].photo.credit[0] = 'X');
    MOVES("the ticker count", g_b.ticker_count--);
    MOVES("the story count",  g_b.story_count--);

    #undef MOVES
}

static void test_hash_separates_adjacent_strings(void)
{
    /* "ab" + "c" must not hash the same as "a" + "bc": without a separator
     * between fields, a headline losing its last word to the deck below it
     * would leave the panel showing the old page forever. */
    memset(&g_a, 0, sizeof(g_a));
    memset(&g_b, 0, sizeof(g_b));
    g_a.valid = g_b.valid = true;
    g_a.story_count = g_b.story_count = 1;
    news_str_copy(g_a.stories[0].headline, NEWS_HEADLINE_MAX, "ab");
    news_str_copy(g_a.stories[0].deck, NEWS_DECK_MAX, "c");
    news_str_copy(g_b.stories[0].headline, NEWS_HEADLINE_MAX, "a");
    news_str_copy(g_b.stories[0].deck, NEWS_DECK_MAX, "bc");
    CHECK(news_hash(&g_a) != news_hash(&g_b));
}

int main(void)
{
    test_fixture();
    test_rejections();
    test_type_confusion_clamps();
    test_money_and_percent_round();
    test_sparks_are_clamped_and_right_aligned();
    test_oversized_arrays_are_capped();
    test_bars_are_capped_at_the_recent_end();
    test_chart_kinds();
    test_charts_that_cannot_be_drawn_become_none();
    test_flat_line_bars_fill_all_four_series();
    test_photos_without_dimensions_are_dropped();
    test_stories_sort_by_rank_and_keep_order_within_it();
    test_stories_without_a_headline_are_skipped();
    test_a_dropped_candidate_does_not_clobber_a_kept_story();
    test_long_headline_truncates_on_a_boundary();
    test_str_copy();
    test_prose_copy_curls_the_apostrophe();
    test_hash_is_content_addressed();
    test_hash_separates_adjacent_strings();
    TH_REPORT("news_parse");
}
