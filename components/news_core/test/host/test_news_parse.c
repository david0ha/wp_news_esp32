/*
 * Host unit tests for news_parse.c.
 *
 * The producer of this JSON is an agent running on somebody's machine. It is
 * going to send a string where a number belongs, a null where a headline
 * belongs, an array of nine hundred entries, a chart with a hole in it, a photo
 * id with no dimensions, a table row shorter than its own header, and — the day
 * the machine sleeps mid-response — half a document. None of that may crash the
 * board, and none of it may replace a good front page with a blank one.
 *
 * So these tests are mostly not about the happy path. The happy path is one
 * test at the top; everything after it is a way of being wrong.
 */
#include "th.h"

#include "news_model.h"
#include "news_parse.h"

#define PARSE(json, out) news_parse((json), strlen(json), (out))

/* news_t is ~33 KB. One of these is fine on a host stack, but a test that
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
    CHECK_STR(v->edition, "SEMICONDUCTORS");
    CHECK_STR(v->dateline, "FRIDAY, AUGUST 14, 2026");
    CHECK_STR(v->session, "U.S. MARKETS CLOSED — AUG 13");
    CHECK_STR(v->as_of, "AS OF 05:12 KST");
    CHECK_STR(v->generated_at, "2026-08-14T05:12:00Z");

    /* The company the edition is about. Money is cents and a change is basis
     * points, both int32: 1631.47 is 163147 and 2.41% is 241 on every platform,
     * or the fingerprint moves between the simulator and the device for no
     * reason at all. */
    CHECK_STR(v->subject.symbol, "SNDK");
    CHECK_STR(v->subject.name, "Sandisk Corp.");
    CHECK_STR(v->subject.exchange, "NASDAQ");
    CHECK_STR(v->subject.sector, "Semiconductors");
    CHECK_INT(v->subject.last_c, 163147);
    CHECK_INT(v->subject.chg_bp, 241);
    CHECK_INT(v->subject.prev_close_c, 159309);
    CHECK_INT(v->subject.open_c, 159820);
    CHECK_INT(v->subject.high_c, 164200);
    CHECK_INT(v->subject.low_c, 159055);
    CHECK_INT(v->subject.wk52_hi_c, 171240);
    CHECK_INT(v->subject.wk52_lo_c, 40218);

    CHECK_INT(v->index_count, 5);
    CHECK_STR(v->indices[0].symbol, "SPX");
    CHECK_STR(v->indices[0].name, "S&P 500");
    CHECK_INT(v->indices[0].last_c, 641283);
    CHECK_INT(v->indices[0].chg_bp, 62);
    CHECK_INT(v->indices[0].spark_n, 12);
    CHECK_INT(v->indices[0].spark[0], 402);
    CHECK_INT(v->indices[4].chg_bp, -420);   /* VIX, and the sign survives */

    CHECK_INT(v->story_count, 4);
    CHECK_INT(v->stories[0].rank, 0);
    CHECK_STR(v->stories[0].kicker, "NAND PRICING");
    CHECK_STR(v->stories[0].headline,
              "Sandisk clears $1,600 as NAND contract prices reset again");
    CHECK_STR(v->stories[0].byline, "By CLAUDE · SEMICONDUCTOR DESK");
    CHECK(strlen(v->stories[0].body) > 600);   /* the lead fills its legs */

    /* A story names a chart by index into the top-level array. The lead names the
     * CONTRACT series, because that is what its headline is about; the price line
     * goes to the story arguing about where the price goes next. Both indices are
     * used, and by different stories, so neither the zero nor the non-zero path is
     * the only one the fixture exercises.
     *
     * The earnings story names NOTHING, and that is the interesting one: A2 draws
     * revenue and margin as a BARS_LINE table, so a chart of it here would put the
     * same bars on the sheet twice. */
    CHECK_INT(v->stories[0].chart, 1);
    CHECK_INT(v->stories[1].chart, -1);        /* the tape story brings none */
    CHECK_INT(v->stories[2].chart, -1);        /* the table on A2 is its picture */
    CHECK_INT(v->stories[3].chart, 0);

    CHECK_STR(v->stories[0].photo.id, "sndk_fab");
    CHECK_INT(v->stories[0].photo.w, 1140);
    CHECK_INT(v->stories[0].photo.h, 320);
    CHECK_STR(v->stories[0].photo.credit, "DEMO IMAGE");
    CHECK_STR(v->stories[1].photo.id, "");

    CHECK_INT(v->chart_count, 2);
    CHECK_INT(v->charts[0].kind, CHART_LINE);
    CHECK_STR(v->charts[0].label, "PRICE");
    CHECK_STR(v->charts[0].span, "6M");
    CHECK_STR(v->charts[0].note, "Weekly close, in dollars");
    CHECK_INT(v->charts[0].n, 26);
    /* The flat form: one close per point, and the other three series set to
     * match so nothing reads a bar spanning the whole scale out of a line. */
    CHECK_INT(v->charts[0].c[0], 97840);
    CHECK_INT(v->charts[0].o[0], 97840);
    CHECK_INT(v->charts[0].h[0], 97840);
    /* The last close is the price in the nameplate. A reader catches that
     * disagreement before any other. */
    CHECK_INT(v->charts[0].c[25], v->subject.last_c);
    CHECK_INT(v->charts[1].kind, CHART_BAR);
    CHECK_STR(v->charts[1].label, "NAND CONTRACT");
    CHECK_INT(v->charts[1].n, 6);
    CHECK_INT(v->charts[1].c[5], 356);         /* $3.56 a gigabyte, in cents */

    CHECK_INT(v->figure_count, 22);
    CHECK_STR(v->figures[0].group, "VALUATION");
    CHECK_STR(v->figures[1].label, "MARKET CAP");
    CHECK_STR(v->figures[1].value, "$241.6B");
    CHECK(v->figures[1].has_chg == false);
    CHECK_STR(v->figures[17].label, "MEAN TARGET");
    CHECK(v->figures[17].has_chg == true);
    CHECK_INT(v->figures[17].chg_bp, 2218);

    /* Three heroes, one at the head of each of three groups, and the nineteen
     * behind them small and barless. `bar` 0 would be a real position — the
     * bottom of the range — so "no bar" has to arrive as -1 and not as the zero
     * a memset leaves.
     *
     * TWO of the three carry a bar and the third does not, because those are two
     * different things to draw: `bar` turns a hero into a graphic INSTEAD of a
     * bigger number, so a hero without one is the ordinary hero. A fixture where
     * every hero had a bar would leave the commoner shape rendered by nobody. */
    CHECK_STR(v->figures[0].label, "52-WEEK RANGE");
    CHECK_INT(v->figures[0].emph, 1);
    CHECK_INT(v->figures[0].bar, 938);
    CHECK_STR(v->figures[7].label, "NET MARGIN TTM");
    CHECK_INT(v->figures[7].emph, 1);
    CHECK_INT(v->figures[7].bar, 855);
    CHECK_INT(v->figures[17].emph, 1);
    CHECK_INT(v->figures[17].bar, -1);      /* a target has no traded band */

    int heroes = 0, hero_bars = 0, hero_groups = 0;
    for (int i = 0; i < v->figure_count; i++) {
        if (!v->figures[i].emph) {
            CHECK_INT(v->figures[i].bar, -1);   /* a bar belongs to a hero */
            continue;
        }
        heroes++;
        if (v->figures[i].bar >= 0) hero_bars++;
        /* Each hero opens its group, which is what makes it read as the head of
         * a section rather than as a line that happens to be large. */
        if (i == 0 || strcmp(v->figures[i].group, v->figures[i - 1].group) != 0) {
            hero_groups++;
        }
    }
    CHECK_INT(heroes, 3);
    CHECK_INT(hero_bars, 2);
    CHECK_INT(hero_groups, 3);

    CHECK_INT(v->brief_count, 6);
    CHECK_STR(v->briefs[0].date, "AUG 13");
    CHECK_STR(v->briefs[0].kicker, "GUIDANCE");
    CHECK(strlen(v->briefs[0].text) > 40);
    CHECK_STR(v->briefs[5].date, "FEB 2025");

    CHECK_INT(v->peer_count, 5);
    CHECK_STR(v->peers[0].symbol, "MU");
    CHECK(v->peers[0].is_subject == false);
    CHECK_STR(v->peers[1].symbol, "SNDK");
    CHECK(v->peers[1].is_subject == true);
    CHECK_STR(v->peers[1].per, "22.38x");
    CHECK_STR(v->peers[1].cap, "$241.6B");
    CHECK_INT(v->peers[1].last_c, v->subject.last_c);
    CHECK_INT(v->peers[1].chg_bp, v->subject.chg_bp);

    CHECK_INT(v->table_count, 2);
    CHECK_STR(v->tables[0].title, "REVENUE, PROFIT AND MARGIN");
    CHECK_STR(v->tables[0].note, "$ millions");
    CHECK_INT(v->tables[0].col_count, 6);
    CHECK_STR(v->tables[0].col[0], "1Q25");     /* oldest first, as set */
    CHECK_STR(v->tables[0].col[5], "2Q26");
    CHECK_INT(v->tables[0].row_count, 3);
    CHECK_STR(v->tables[0].row[0].label, "Revenue");
    CHECK_STR(v->tables[0].row[0].v[0], "1,672");
    CHECK_STR(v->tables[0].row[0].v[5], "9,340");
    CHECK_STR(v->tables[1].title, "REVENUE BY END MARKET");
    CHECK_INT(v->tables[1].row_count, 3);

    /* Both statements are DRAWN rather than printed, and both therefore have to
     * have arrived with a full numeric plane: `v` is what is printed and `n` is
     * what is scaled. The bars are in the unit `note` names — $ millions — and
     * the LAST row of the bars-and-line table is the line, in basis points,
     * because it is a percentage and every percentage on this wire is. */
    CHECK_INT(v->tables[0].render, TABLE_BARS_LINE);
    CHECK(v->tables[0].has_n == true);
    CHECK_INT(v->tables[0].n[0][0], 1672);
    CHECK_INT(v->tables[0].n[0][5], 9340);
    CHECK_STR(v->tables[0].row[1].label, "Net income");
    CHECK_INT(v->tables[0].n[1][0], -370);      /* "(370)" is a loss, not 370 */
    CHECK_STR(v->tables[0].row[2].label, "Net margin");
    CHECK_INT(v->tables[0].n[2][0], -2213);     /* basis points: "(22.1%)"     */
    CHECK_INT(v->tables[0].n[2][5], 5846);      /* and 58.5% in the June quarter */

    CHECK_INT(v->tables[1].render, TABLE_STACK);
    CHECK(v->tables[1].has_n == true);
    CHECK_STR(v->tables[1].row[0].label, "Client");
    CHECK_INT(v->tables[1].n[0][5], 5240);
    /* No Total row: a stacked bar's total is its height, and a fourth segment
     * carrying it would draw the whole quarter twice. */
    for (int r = 0; r < v->tables[1].row_count; r++) {
        CHECK(strcmp(v->tables[1].row[r].label, "Total") != 0);
    }
    /* The composition sums to the bars-and-line table's revenue row, column by
     * column. Two pictures on one sheet that disagree about the same quarter is
     * the error a reader catches and nobody forgives. */
    for (int c = 0; c < v->tables[1].col_count; c++) {
        int32_t parts = 0;
        for (int r = 0; r < v->tables[1].row_count; r++) parts += v->tables[1].n[r][c];
        CHECK_INT(parts, v->tables[0].n[0][c]);
    }

    CHECK_INT(v->thumb_count, 2);
    CHECK_STR(v->thumbs[0].id, "sndk_wafer");
    CHECK_INT(v->thumbs[0].w, 364);
    CHECK_INT(v->thumbs[0].h, 204);
    CHECK_STR(v->thumbs[1].id, "sndk_line");

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

    /* Everything BUT the two things that make a page: a dossier, a ribbon and a
     * set of statements with no company named and nothing written about it. */
    REJECTS("furniture with no subject",
            "{\"figures\":[{\"group\":\"G\",\"label\":\"L\",\"value\":\"V\"}],"
            " \"indices\":[{\"symbol\":\"SPX\",\"last\":1}],"
            " \"tables\":[{\"title\":\"T\",\"columns\":[\"a\"]}]}");
    REJECTS("a subject with no symbol",
            "{\"subject\":{\"name\":\"Sandisk Corp.\",\"last\":1631.47}}");
}

#undef REJECTS

/* A named company on its own IS a page. An edition whose research came back
 * thin still has a nameplate, a session line and a price, and printing that at
 * full size is a legitimate quiet-day front page rather than an error state.
 * The same goes for a story with no subject behind it. */
static void test_a_thin_day_is_still_a_page(void)
{
    CHECK(PARSE("{\"subject\":{\"symbol\":\"SNDK\",\"last\":1631.47}}", &g_a) == true);
    CHECK_STR(g_a.subject.symbol, "SNDK");
    CHECK_INT(g_a.story_count, 0);
    CHECK(g_a.valid == true);

    CHECK(PARSE("{\"stories\":[{\"rank\":0,\"headline\":\"h\"}]}", &g_a) == true);
    CHECK_INT(g_a.story_count, 1);
    CHECK_STR(g_a.subject.symbol, "");
}

/* --- individual bad fields are NOT rejections ----------------------------- */

static void test_type_confusion_clamps(void)
{
    /* Every field here is the wrong type. The document still names a company,
     * so it is a usable page with defaults everywhere else — the alternative,
     * rejecting the lot, would blank the board because one producer wrote a
     * string for `last`. */
    const char *json =
        "{\"edition\":123,"
        " \"dateline\":null,"
        " \"session\":[],"
        " \"subject\":{\"symbol\":\"SNDK\",\"name\":null,\"last\":\"expensive\","
        "              \"change_pct\":{},\"wk52_high\":\"n/a\"},"
        " \"indices\":{\"not\":\"an array\"},"
        " \"stories\":\"nope\","
        " \"figures\":42,"
        " \"briefs\":null,"
        " \"peers\":\"nope\","
        " \"tables\":{},"
        " \"charts\":\"nope\","
        " \"thumbs\":7}";
    CHECK(PARSE(json, &g_a) == true);
    CHECK_STR(g_a.edition, "");
    CHECK_STR(g_a.dateline, "");
    CHECK_STR(g_a.session, "");
    CHECK_STR(g_a.subject.symbol, "SNDK");
    CHECK_STR(g_a.subject.name, "");
    CHECK_INT(g_a.subject.last_c, 0);
    CHECK_INT(g_a.subject.chg_bp, 0);
    CHECK_INT(g_a.subject.wk52_hi_c, 0);      /* 0 = unknown, drawn as absent */
    CHECK_INT(g_a.index_count, 0);
    CHECK_INT(g_a.story_count, 0);
    CHECK_INT(g_a.figure_count, 0);
    CHECK_INT(g_a.brief_count, 0);
    CHECK_INT(g_a.peer_count, 0);
    CHECK_INT(g_a.table_count, 0);
    CHECK_INT(g_a.chart_count, 0);
    CHECK_INT(g_a.thumb_count, 0);
}

static void test_money_and_percent_round(void)
{
    /* Truncating instead of rounding would make 1631.47 arrive as 163146 on a
     * machine whose double lands a hair low, and a price that ticks by a cent
     * when nothing moved costs a twenty-five-second refresh. */
    const char *json =
        "{\"subject\":{\"symbol\":\"A\",\"last\":1631.47,\"change_pct\":-1.84,"
        "              \"open\":0.015,\"high\":-0.015,\"low\":6412,"
        "              \"wk52_high\":1e308,\"wk52_low\":-1e308}}";
    CHECK(PARSE(json, &g_a) == true);
    CHECK_INT(g_a.subject.last_c, 163147);
    CHECK_INT(g_a.subject.chg_bp, -184);
    CHECK_INT(g_a.subject.open_c, 2);        /* half away from zero */
    CHECK_INT(g_a.subject.high_c, -2);
    CHECK_INT(g_a.subject.low_c, 641200);    /* an integer price is still cents */
    /* An overflow clamps rather than wrapping: an int32 that wrapped negative
     * would print a price with a minus sign in front of it. */
    CHECK(g_a.subject.wk52_hi_c > 0);
    CHECK(g_a.subject.wk52_lo_c < 0);

    /* A figure's change is the same conversion, and "absent" is not "zero":
     * zero prints as a flat mark and absent prints as no mark at all. */
    const char *figs =
        "{\"subject\":{\"symbol\":\"A\"},\"figures\":["
        "{\"group\":\"G\",\"label\":\"a\",\"value\":\"v\",\"change_pct\":0},"
        "{\"group\":\"G\",\"label\":\"b\",\"value\":\"v\"},"
        "{\"group\":\"G\",\"label\":\"c\",\"value\":\"v\",\"change_pct\":\"1.5\"},"
        "{\"group\":\"G\",\"label\":\"d\",\"value\":\"v\",\"change_pct\":-0.005}]}";
    CHECK(PARSE(figs, &g_a) == true);
    CHECK_INT(g_a.figure_count, 4);
    CHECK(g_a.figures[0].has_chg == true);
    CHECK_INT(g_a.figures[0].chg_bp, 0);
    CHECK(g_a.figures[1].has_chg == false);
    CHECK(g_a.figures[2].has_chg == false);   /* a string is not a number */
    CHECK(g_a.figures[3].has_chg == true);
    CHECK_INT(g_a.figures[3].chg_bp, -1);
}

static void test_sparks_are_clamped_and_right_aligned(void)
{
    /* A sparkline is a history: the end being read is the right-hand one, so an
     * over-long series loses its oldest samples. Out-of-range values would draw
     * outside the 48x14 box. */
    static char json[4096];
    int n = snprintf(json, sizeof(json),
                     "{\"indices\":[{\"symbol\":\"A\",\"spark\":[-5,1500,500]},"
                     "{\"symbol\":\"B\",\"spark\":[");
    for (int i = 0; i < 40; i++) {
        n += snprintf(json + n, sizeof(json) - n, "%s%d", i ? "," : "", i * 25);
    }
    snprintf(json + n, sizeof(json) - n, "]}],\"stories\":[{\"headline\":\"h\"}]}");

    CHECK(PARSE(json, &g_a) == true);
    CHECK_INT(g_a.indices[0].spark_n, 3);
    CHECK_INT(g_a.indices[0].spark[0], 0);
    CHECK_INT(g_a.indices[0].spark[1], 1000);
    CHECK_INT(g_a.indices[0].spark[2], 500);

    CHECK_INT(g_a.indices[1].spark_n, NEWS_SPARK_MAX);
    CHECK_INT(g_a.indices[1].spark[0], (40 - NEWS_SPARK_MAX) * 25);
    CHECK_INT(g_a.indices[1].spark[NEWS_SPARK_MAX - 1], 975);
}

/* --- capacity ------------------------------------------------------------- */

/* Forty of everything. These are DISPLAY capacities, not protocol limits, so
 * the overflow is dropped and the page still prints; the alternative — failing
 * the payload — would blank the board because a producer got generous. */
static void test_oversized_arrays_are_capped(void)
{
    static char json[131072];
    int n = snprintf(json, sizeof(json), "{\"subject\":{\"symbol\":\"S\"},\"indices\":[");
    for (int i = 0; i < 40; i++) {
        n += snprintf(json + n, sizeof(json) - n, "%s{\"symbol\":\"I%d\"}", i ? "," : "", i);
    }
    n += snprintf(json + n, sizeof(json) - n, "],\"figures\":[");
    for (int i = 0; i < 40; i++) {
        n += snprintf(json + n, sizeof(json) - n,
                      "%s{\"group\":\"G\",\"label\":\"L%d\",\"value\":\"V%d\"}",
                      i ? "," : "", i, i);
    }
    n += snprintf(json + n, sizeof(json) - n, "],\"briefs\":[");
    for (int i = 0; i < 40; i++) {
        n += snprintf(json + n, sizeof(json) - n, "%s{\"text\":\"t%d\"}", i ? "," : "", i);
    }
    n += snprintf(json + n, sizeof(json) - n, "],\"peers\":[");
    for (int i = 0; i < 40; i++) {
        n += snprintf(json + n, sizeof(json) - n, "%s{\"symbol\":\"P%d\"}", i ? "," : "", i);
    }
    n += snprintf(json + n, sizeof(json) - n, "],\"thumbs\":[");
    for (int i = 0; i < 40; i++) {
        n += snprintf(json + n, sizeof(json) - n,
                      "%s{\"id\":\"t%d\",\"w\":100,\"h\":50}", i ? "," : "", i);
    }
    n += snprintf(json + n, sizeof(json) - n, "],\"tables\":[");
    for (int i = 0; i < 40; i++) {
        n += snprintf(json + n, sizeof(json) - n, "%s{\"title\":\"T%d\"}", i ? "," : "", i);
    }
    n += snprintf(json + n, sizeof(json) - n, "],\"charts\":[");
    for (int i = 0; i < 40; i++) {
        n += snprintf(json + n, sizeof(json) - n,
                      "%s{\"kind\":\"line\",\"close\":[%d]}", i ? "," : "", i);
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
    CHECK_INT(g_a.figure_count, NEWS_FIGURES_MAX);
    CHECK_INT(g_a.brief_count, NEWS_BRIEFS_MAX);
    CHECK_INT(g_a.peer_count, NEWS_PEERS_MAX);
    CHECK_INT(g_a.thumb_count, NEWS_THUMBS_MAX);
    CHECK_INT(g_a.table_count, NEWS_TABLES_MAX);
    CHECK_INT(g_a.chart_count, NEWS_CHARTS_MAX);
    CHECK_INT(g_a.story_count, NEWS_STORIES_MAX);

    /* The overflow is dropped from the END of every array except the stories,
     * which are dropped by rank. */
    CHECK_STR(g_a.figures[NEWS_FIGURES_MAX - 1].label, "L27");
    CHECK_STR(g_a.peers[NEWS_PEERS_MAX - 1].symbol, "P5");

    /* The ranks descend through the array, so keeping the first five would keep
     * the five least important stories and drop the lead. The five lowest ranks
     * are the ones that survive, and they come out sorted. */
    for (int i = 0; i < g_a.story_count; i++) {
        CHECK_INT(g_a.stories[i].rank, i);
    }
    CHECK_STR(g_a.stories[0].headline, "h39");
}

static void test_a_forty_row_table_is_capped_in_both_directions(void)
{
    static char json[16384];
    int n = snprintf(json, sizeof(json),
                     "{\"subject\":{\"symbol\":\"S\"},\"tables\":[{\"title\":\"T\",\"columns\":[");
    for (int i = 0; i < 40; i++) {
        n += snprintf(json + n, sizeof(json) - n, "%s\"c%d\"", i ? "," : "", i);
    }
    n += snprintf(json + n, sizeof(json) - n, "],\"rows\":[");
    for (int i = 0; i < 40; i++) {
        n += snprintf(json + n, sizeof(json) - n,
                      "%s{\"label\":\"r%d\",\"values\":[\"a\",\"b\"]}", i ? "," : "", i);
    }
    snprintf(json + n, sizeof(json) - n, "]}]}");

    CHECK(PARSE(json, &g_a) == true);
    CHECK_INT(g_a.tables[0].col_count, NEWS_TABLE_COLS);
    CHECK_INT(g_a.tables[0].row_count, NEWS_TABLE_ROWS);
    CHECK_STR(g_a.tables[0].col[NEWS_TABLE_COLS - 1], "c5");
    CHECK_STR(g_a.tables[0].row[NEWS_TABLE_ROWS - 1].label, "r9");
}

static void test_bars_are_capped_at_the_recent_end(void)
{
    static char json[8192];
    int n = snprintf(json, sizeof(json),
                     "{\"subject\":{\"symbol\":\"S\"},\"charts\":["
                     "{\"kind\":\"line\",\"span\":\"1Y\",\"close\":[");
    for (int i = 0; i < 200; i++) {
        n += snprintf(json + n, sizeof(json) - n, "%s%d", i ? "," : "", i);
    }
    snprintf(json + n, sizeof(json) - n, "]}]}");

    CHECK(PARSE(json, &g_a) == true);
    CHECK_INT(g_a.charts[0].n, NEWS_BARS_MAX);
    /* The right-hand end of a price series is the end being read. */
    CHECK_INT(g_a.charts[0].c[0], (200 - NEWS_BARS_MAX) * 100);
    CHECK_INT(g_a.charts[0].c[NEWS_BARS_MAX - 1], 19900);
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
    /* A kind with no usable closes would reserve its slot and draw an empty
     * box. `kind == CHART_NONE` is the model's single test for "is there a
     * chart", so the parser has to make it true rather than leaving four call
     * sites to check `n` as well. */
    const char *json =
        "{\"subject\":{\"symbol\":\"S\"},\"charts\":["
        "{\"kind\":\"candle\",\"span\":\"1M\",\"label\":\"PRICE\"},"
        "{\"kind\":\"bar\",\"close\":[1,2,3]}]}";
    CHECK(PARSE(json, &g_a) == true);
    CHECK_INT(g_a.chart_count, 2);
    CHECK_INT(g_a.charts[0].kind, CHART_NONE);
    CHECK_STR(g_a.charts[0].span, "");        /* and the furniture goes with it */
    CHECK_STR(g_a.charts[0].label, "");
    CHECK_INT(g_a.charts[0].n, 0);
    CHECK_INT(g_a.charts[1].kind, CHART_BAR);
}

static void test_an_undrawable_chart_keeps_its_index(void)
{
    /* The producer numbered its stories against the array it SENT. Dropping
     * charts[0] would renumber charts[1], and the story that asked for the
     * revenue bars would draw the price series under a caps head that says
     * REVENUE — a page that is wrong about a number rather than one item
     * shorter. So the empty slot stays. */
    const char *json =
        "{\"subject\":{\"symbol\":\"S\"},\"charts\":["
        "{\"kind\":\"wat\",\"close\":[1,2,3]},"
        "{\"kind\":\"bar\",\"label\":\"REVENUE\",\"close\":[7,8]}],"
        " \"stories\":[{\"rank\":0,\"headline\":\"h\",\"chart\":1}]}";
    CHECK(PARSE(json, &g_a) == true);
    CHECK_INT(g_a.chart_count, 2);
    CHECK_INT(g_a.charts[0].kind, CHART_NONE);
    CHECK_INT(g_a.stories[0].chart, 1);
    CHECK_STR(g_a.charts[1].label, "REVENUE");

    /* A trailing empty is the exception: nothing that survived can still point
     * past it, so dropping it keeps chart_count honest for a compositor that
     * reads the count before it reads the charts. */
    const char *trailing =
        "{\"subject\":{\"symbol\":\"S\"},\"charts\":["
        "{\"kind\":\"line\",\"close\":[1,2]},{\"kind\":\"none\"},{\"kind\":\"bar\"}]}";
    CHECK(PARSE(trailing, &g_a) == true);
    CHECK_INT(g_a.chart_count, 1);
}

static void test_flat_close_fills_all_four_series(void)
{
    /* The flat form is one close per point. Open, high and low are set to match
     * so that a consumer reaching for h[] gets a zero-height bar rather than
     * one spanning the whole scale out of a series that never had one. */
    const char *json =
        "{\"subject\":{\"symbol\":\"S\"},\"charts\":["
        "{\"kind\":\"line\",\"span\":\"5D\",\"close\":[10.5,11,\"x\",12.25]}]}";
    CHECK(PARSE(json, &g_a) == true);
    const news_chart_t *c = &g_a.charts[0];
    CHECK_INT(c->kind, CHART_LINE);
    CHECK_INT(c->n, 3);                       /* the string is not a point */
    CHECK_INT(c->c[0], 1050);
    CHECK_INT(c->o[0], 1050);
    CHECK_INT(c->h[0], 1050);
    CHECK_INT(c->l[0], 1050);
    CHECK_INT(c->c[2], 1225);
}

static void test_ohlc_arrays_are_read_in_parallel(void)
{
    /* The four arrays are parallel and are indexed by the same absolute
     * position, never by the same offset from the end. An open[] that arrived
     * one element short would otherwise shift every open by a session, which
     * draws as a chart of plausible candles that are all subtly wrong.
     *
     * Here `open` is one short and `low` has a string in the middle: the missing
     * slots fall back to that point's own close, and everything else stays on
     * its own bar. */
    const char *json =
        "{\"subject\":{\"symbol\":\"S\"},\"charts\":[{\"kind\":\"candle\","
        "\"close\":[10,20,30],"
        "\"open\":[11,21],"
        "\"high\":[12,22,32],"
        "\"low\":[13,\"x\",33]}]}";
    CHECK(PARSE(json, &g_a) == true);
    const news_chart_t *c = &g_a.charts[0];
    CHECK_INT(c->kind, CHART_CANDLE);
    CHECK_INT(c->n, 3);
    CHECK_INT(c->o[0], 1100);
    CHECK_INT(c->o[1], 2100);
    CHECK_INT(c->o[2], 3000);      /* absent -> this point's close, not 2100 */
    CHECK_INT(c->h[2], 3200);
    CHECK_INT(c->l[1], 2000);      /* not a number -> this point's close */
    CHECK_INT(c->l[2], 3300);
}

static void test_a_story_chart_index_is_clamped_to_what_arrived(void)
{
    /* A story that reflows without its chart is an ordinary front page; one
     * that draws whatever landed in the slot instead is a lie about a price. */
    const char *json =
        "{\"subject\":{\"symbol\":\"S\"},\"charts\":[{\"kind\":\"line\",\"close\":[1,2]}],"
        " \"stories\":["
        "{\"rank\":0,\"headline\":\"in range\",\"chart\":0},"
        "{\"rank\":1,\"headline\":\"past the end\",\"chart\":1},"
        "{\"rank\":2,\"headline\":\"negative\",\"chart\":-7},"
        "{\"rank\":3,\"headline\":\"absurd\",\"chart\":999999},"
        "{\"rank\":4,\"headline\":\"not a number\",\"chart\":\"0\"}]}";
    CHECK(PARSE(json, &g_a) == true);
    CHECK_INT(g_a.story_count, 5);
    CHECK_INT(g_a.stories[0].chart, 0);
    CHECK_INT(g_a.stories[1].chart, -1);
    CHECK_INT(g_a.stories[2].chart, -1);
    CHECK_INT(g_a.stories[3].chart, -1);
    CHECK_INT(g_a.stories[4].chart, -1);
}

/* --- photos --------------------------------------------------------------- */

static void test_photos_that_cannot_be_fetched_are_dropped(void)
{
    /* The id is the URL and the dimensions are the byte count of the tile —
     * w*h/2 raw bytes — so one without the other cannot be fetched, and a
     * caption under a slot that stayed empty is worse than no caption. */
    const char *json =
        "{\"subject\":{\"symbol\":\"S\"},\"stories\":["
        "{\"rank\":0,\"headline\":\"a\",\"photo\":{\"id\":\"x\",\"caption\":\"c\"}},"
        "{\"rank\":1,\"headline\":\"b\",\"photo\":{\"w\":100,\"h\":50,\"credit\":\"AP\"}},"
        "{\"rank\":2,\"headline\":\"c\",\"photo\":{\"id\":\"y\",\"w\":-8,\"h\":50}},"
        "{\"rank\":3,\"headline\":\"d\",\"photo\":{\"id\":\"z\",\"w\":100000,\"h\":99999}},"
        "{\"rank\":4,\"headline\":\"e\",\"photo\":{\"id\":\"w\",\"w\":947,\"h\":420}}]}";
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
    /* An ODD width is dropped rather than clamped, and it is judged on the
     * width the producer declared rather than on the clamped one: a tile packs
     * two pixels to a byte, so a row of odd width does not end on a byte
     * boundary and cannot be blitted as a per-row memcpy at any size. */
    CHECK_STR(g_a.stories[4].photo.id, "");
    CHECK_INT(g_a.stories[4].photo.w, 0);
}

static void test_thumbs_are_dropped_rather_than_left_as_holes(void)
{
    /* Unlike a chart, nothing names a thumb by index, so an unfetchable one is
     * removed from the array instead of occupying a slot the page has to skip. */
    const char *json =
        "{\"subject\":{\"symbol\":\"S\"},\"thumbs\":["
        "{\"id\":\"bad\",\"w\":365,\"h\":204},"
        "{\"id\":\"good\",\"w\":364,\"h\":204,\"caption\":\"cap\"},"
        "\"not an object\","
        "{\"w\":364,\"h\":204}]}";
    CHECK(PARSE(json, &g_a) == true);
    CHECK_INT(g_a.thumb_count, 1);
    CHECK_STR(g_a.thumbs[0].id, "good");
    CHECK_STR(g_a.thumbs[0].caption, "cap");
}

/* --- stories -------------------------------------------------------------- */

static void test_stories_sort_by_rank_and_keep_order_within_it(void)
{
    /* The compositor packs in rank order and gives the sheet to stories[0]
     * first, so the sort is load-bearing, and a producer that emits them in the
     * order it found them must not change the page. */
    const char *json =
        "{\"subject\":{\"symbol\":\"S\"},\"stories\":["
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
    /* The default sits ABOVE the array bound on purpose: a producer numbering
     * its file 0..4 must not tie with a story that carried no rank at all. */
    CHECK(g_a.stories[4].rank > NEWS_STORIES_MAX);
}

static void test_entries_without_their_required_field_are_skipped(void)
{
    /* Each of these is furniture with nothing under it: a kicker over an empty
     * column, a standing head over half a rail line, a date over no news, a
     * price beside a blank symbol. */
    const char *json =
        "{\"subject\":{\"symbol\":\"S\"},"
        " \"stories\":[{\"rank\":0,\"kicker\":\"K\",\"body\":\"words\"},"
        "              {\"rank\":1,\"headline\":\"\"},"
        "              {\"rank\":2,\"headline\":\"real\"}],"
        " \"figures\":[{\"group\":\"G\",\"label\":\"L\"},"
        "              {\"group\":\"G\",\"value\":\"V\"},"
        "              {\"group\":\"G\",\"label\":\"L\",\"value\":\"V\"}],"
        " \"briefs\":[{\"date\":\"AUG 1\",\"kicker\":\"K\"},{\"text\":\"real\"}],"
        " \"peers\":[{\"name\":\"no symbol\"},{\"symbol\":\"OK\"}],"
        " \"indices\":[{\"symbol\":\"\"},{\"symbol\":\"SPX\"}]}";
    CHECK(PARSE(json, &g_a) == true);
    CHECK_INT(g_a.story_count, 1);
    CHECK_STR(g_a.stories[0].headline, "real");
    CHECK_INT(g_a.figure_count, 1);
    CHECK_STR(g_a.figures[0].label, "L");
    CHECK_INT(g_a.brief_count, 1);
    CHECK_STR(g_a.briefs[0].text, "real");
    CHECK_INT(g_a.peer_count, 1);
    CHECK_STR(g_a.peers[0].symbol, "OK");
    CHECK_INT(g_a.index_count, 1);
    CHECK_STR(g_a.indices[0].symbol, "SPX");
}

static void test_a_dropped_candidate_does_not_clobber_a_kept_story(void)
{
    /* When the array overflows, the parser writes the new story into the slot
     * held by the worst-ranked one it already has. A candidate that then turns
     * out to have no headline must not have destroyed that story on its way
     * out. Five good stories, then a sixth that is better-ranked but headless. */
    const char *json =
        "{\"subject\":{\"symbol\":\"S\"},\"stories\":["
        "{\"rank\":0,\"headline\":\"a\"},{\"rank\":1,\"headline\":\"b\"},"
        "{\"rank\":2,\"headline\":\"c\"},{\"rank\":3,\"headline\":\"d\"},"
        "{\"rank\":4,\"headline\":\"e\"},"
        "{\"rank\":0,\"kicker\":\"NO HEADLINE\"}]}";
    CHECK(PARSE(json, &g_a) == true);
    CHECK_INT(g_a.story_count, NEWS_STORIES_MAX);
    CHECK_STR(g_a.stories[4].headline, "e");
    CHECK_INT(g_a.stories[4].rank, 4);
}

/* --- peers ---------------------------------------------------------------- */

static void test_peers(void)
{
    /* `is_subject` is rendered in bold and is the reader's answer to "which of
     * these is us". Anything but a JSON true is false — a producer sending the
     * string "true" gets a table with nobody in bold, which is a missing
     * emphasis rather than the wrong company emphasised. */
    const char *json =
        "{\"subject\":{\"symbol\":\"SNDK\"},\"peers\":["
        "{\"symbol\":\"MU\",\"name\":\"Micron\",\"per\":\"11.62x\",\"cap\":\"$318.9B\","
        " \"last\":284.15,\"change_pct\":2.87},"
        "{\"symbol\":\"SNDK\",\"is_subject\":true,\"last\":1631.47},"
        "{\"symbol\":\"INTC\",\"is_subject\":\"true\"},"
        "{\"symbol\":\"ADI\",\"is_subject\":1}]}";
    CHECK(PARSE(json, &g_a) == true);
    CHECK_INT(g_a.peer_count, 4);
    CHECK_STR(g_a.peers[0].name, "Micron");
    CHECK_STR(g_a.peers[0].per, "11.62x");
    CHECK_STR(g_a.peers[0].cap, "$318.9B");
    CHECK_INT(g_a.peers[0].last_c, 28415);
    CHECK_INT(g_a.peers[0].chg_bp, 287);
    CHECK(g_a.peers[0].is_subject == false);
    CHECK(g_a.peers[1].is_subject == true);
    CHECK(g_a.peers[2].is_subject == false);
    CHECK(g_a.peers[3].is_subject == false);
    CHECK_STR(g_a.peers[1].per, "");          /* absent, and the page prints — */
}

/* --- tables --------------------------------------------------------------- */

static void test_table_rows_stay_aligned_with_their_header(void)
{
    /* The values are positional: column three of a row is the quarter in column
     * three of the header. A row shorter than the header leaves its tail empty
     * and the page sets an em dash there; a longer one is truncated, because
     * there is no seventh column to print a seventh value in; and a cell that
     * is not a string still SPENDS its column, because sliding the rest of the
     * row one quarter to the left prints plausible numbers filed under the
     * wrong dates. */
    const char *json =
        "{\"subject\":{\"symbol\":\"S\"},\"tables\":[{"
        "\"title\":\"QUARTERLY RESULTS\",\"note\":\"$ millions\","
        "\"columns\":[\"1Q26\",\"2Q26\",\"3Q26\",99,\"4Q26\"],"
        "\"rows\":["
        "{\"label\":\"Short\",\"values\":[\"a\",\"b\"]},"
        "{\"label\":\"Long\",\"values\":[\"a\",\"b\",\"c\",\"d\",\"e\",\"f\",\"g\",\"h\"]},"
        "{\"label\":\"Holed\",\"values\":[\"a\",null,\"c\"]},"
        "{\"label\":\"No values\"},"
        "{\"values\":[\"orphan\"]},"
        "{},"
        "\"not an object\"]}]}";
    CHECK(PARSE(json, &g_a) == true);
    CHECK_INT(g_a.table_count, 1);
    const news_table_t *t = &g_a.tables[0];
    CHECK_STR(t->title, "QUARTERLY RESULTS");
    CHECK_STR(t->note, "$ millions");

    /* A head that is not a string still spends its column, for the same reason
     * a cell that is not a string does: the values are positional against this
     * header, so dropping the fourth head would slide 4Q26's numbers under
     * 3Q26's date. It prints with a blank head instead. */
    CHECK_INT(t->col_count, 5);
    CHECK_STR(t->col[2], "3Q26");
    CHECK_STR(t->col[3], "");
    CHECK_STR(t->col[4], "4Q26");

    /* Six rows in, five kept: the empty object is the one dropped. */
    CHECK_INT(t->row_count, 5);
    CHECK_STR(t->row[0].label, "Short");
    CHECK_STR(t->row[0].v[1], "b");
    CHECK_STR(t->row[0].v[2], "");            /* the tail, printed as an em dash */
    CHECK_STR(t->row[1].label, "Long");
    CHECK_STR(t->row[1].v[NEWS_TABLE_COLS - 1], "f");
    CHECK_STR(t->row[2].v[0], "a");
    CHECK_STR(t->row[2].v[1], "");            /* the hole keeps its column ... */
    CHECK_STR(t->row[2].v[2], "c");           /* ... so c stays in column three */
    CHECK_STR(t->row[3].label, "No values");
    CHECK_STR(t->row[4].label, "");
    CHECK_STR(t->row[4].v[0], "orphan");
}

static void test_table_render_words(void)
{
    CHECK_INT(news_table_render_from("print"), TABLE_PRINT);
    CHECK_INT(news_table_render_from("stack"), TABLE_STACK);
    CHECK_INT(news_table_render_from("STACK"), TABLE_STACK);       /* case-insensitive */
    CHECK_INT(news_table_render_from("bars_line"), TABLE_BARS_LINE);
    CHECK_INT(news_table_render_from("Bars+Line"), TABLE_BARS_LINE);
    /* Unknown degrades to PRINTING, never to drawing. A table drawn with the
     * wrong geometry is worse than one that was only printed, and printing is
     * never wrong: every cell the producer sent is on the sheet under the
     * heading it belongs to. */
    CHECK_INT(news_table_render_from("pie"), TABLE_PRINT);
    CHECK_INT(news_table_render_from("bars line"), TABLE_PRINT);
    CHECK_INT(news_table_render_from(""), TABLE_PRINT);
    CHECK_INT(news_table_render_from(NULL), TABLE_PRINT);
}

static void test_a_partial_numeric_plane_un_draws_the_whole_table(void)
{
    /* `has_n` is all-or-nothing on purpose. A stack is only a stack when every
     * segment of every column arrived and a line is only a line when it has a
     * point over every bar, so one row short of one number and the table falls
     * back to printing — which still shows every figure the producer sent.
     *
     * Four ways to be short, one table each: a row with no `n` at all, a row
     * whose `n` stops before the last column, a row with a string in the middle
     * of its `n`, and a table with no columns to scale against. */
    const char *complete =
        "{\"subject\":{\"symbol\":\"S\"},\"tables\":[{"
        "\"title\":\"T\",\"render\":\"stack\",\"columns\":[\"a\",\"b\"],\"rows\":["
        "{\"label\":\"r1\",\"values\":[\"1\",\"2\"],\"n\":[1,2]},"
        "{\"label\":\"r2\",\"values\":[\"3\",\"4\"],\"n\":[3,4,99]}]}]}";
    CHECK(PARSE(complete, &g_a) == true);
    CHECK(g_a.tables[0].has_n == true);          /* a LONG row is fine: truncated */
    CHECK_INT(g_a.tables[0].n[1][1], 4);
    CHECK_INT(g_a.tables[0].render, TABLE_STACK);

    const char *missing =
        "{\"subject\":{\"symbol\":\"S\"},\"tables\":[{"
        "\"title\":\"T\",\"render\":\"stack\",\"columns\":[\"a\",\"b\"],\"rows\":["
        "{\"label\":\"r1\",\"values\":[\"1\",\"2\"],\"n\":[1,2]},"
        "{\"label\":\"r2\",\"values\":[\"3\",\"4\"]}]}]}";
    CHECK(PARSE(missing, &g_a) == true);
    CHECK(g_a.tables[0].has_n == false);
    /* `render` is left EXACTLY as the producer sent it. It is a statement about
     * what this table is; `has_n` is a fact about what turned up. Overwriting
     * the first with the second would erase the only evidence that a table
     * meant to be drawn went undrawn. */
    CHECK_INT(g_a.tables[0].render, TABLE_STACK);
    /* And the plane it half-received is erased. news_hash() feeds every cell of
     * `n`, so leaving numeric junk nothing draws would cost a twenty-five-second
     * refresh for a page that is identical. */
    CHECK_INT(g_a.tables[0].n[0][0], 0);
    CHECK_INT(g_a.tables[0].n[0][1], 0);

    const char *shortrow =
        "{\"subject\":{\"symbol\":\"S\"},\"tables\":[{"
        "\"title\":\"T\",\"render\":\"bars_line\",\"columns\":[\"a\",\"b\",\"c\"],\"rows\":["
        "{\"label\":\"r1\",\"n\":[1,2,3]},{\"label\":\"r2\",\"n\":[4,5]}]}]}";
    CHECK(PARSE(shortrow, &g_a) == true);
    CHECK(g_a.tables[0].has_n == false);
    CHECK_INT(g_a.tables[0].render, TABLE_BARS_LINE);
    /* A row carrying only the drawable plane is a series with no legend, which
     * is a visible producer bug rather than a blank line ruled across the
     * statement — so it is kept, exactly as a row of values under no label is. */
    CHECK_INT(g_a.tables[0].row_count, 2);

    const char *holed =
        "{\"subject\":{\"symbol\":\"S\"},\"tables\":[{"
        "\"title\":\"T\",\"render\":\"stack\",\"columns\":[\"a\",\"b\"],\"rows\":["
        "{\"label\":\"r1\",\"n\":[1,\"x\"]}]}]}";
    CHECK(PARSE(holed, &g_a) == true);
    CHECK(g_a.tables[0].has_n == false);
    CHECK_INT(g_a.tables[0].n[0][0], 0);         /* the whole plane, not just the hole */

    const char *headless =
        "{\"subject\":{\"symbol\":\"S\"},\"tables\":[{"
        "\"title\":\"T\",\"render\":\"stack\",\"rows\":[{\"label\":\"r1\",\"n\":[1,2]}]}]}";
    CHECK(PARSE(headless, &g_a) == true);
    CHECK(g_a.tables[0].has_n == false);         /* no columns, nothing to scale */

    /* A printed table with numbers on it keeps them: the producer may have sent
     * both and asked for the record this time, and `render` is what decides. */
    const char *printed =
        "{\"subject\":{\"symbol\":\"S\"},\"tables\":[{"
        "\"title\":\"T\",\"columns\":[\"a\"],\"rows\":[{\"label\":\"r\",\"n\":[7]}]}]}";
    CHECK(PARSE(printed, &g_a) == true);
    CHECK_INT(g_a.tables[0].render, TABLE_PRINT);
    CHECK(g_a.tables[0].has_n == true);
    CHECK_INT(g_a.tables[0].n[0][0], 7);
}

static void test_a_numeric_plane_stays_parallel_to_its_own_row(void)
{
    /* `n` travels per row rather than as one array on the table, and this is
     * why: news_parse() DROPS a row object carrying neither a label nor any
     * numbers, so a table-level plane would slide under the rows that survived
     * and file every bar against the wrong quarter. Here the second of three
     * row objects is a blank line and disappears; the numbers that reach the
     * model are the ones that were written beside their own labels. */
    const char *json =
        "{\"subject\":{\"symbol\":\"S\"},\"tables\":[{"
        "\"title\":\"T\",\"render\":\"stack\",\"columns\":[\"a\",\"b\"],\"rows\":["
        "{\"label\":\"first\",\"n\":[10,11]},"
        "{},"
        "{\"label\":\"third\",\"n\":[30,31]}]}]}";
    CHECK(PARSE(json, &g_a) == true);
    CHECK_INT(g_a.tables[0].row_count, 2);
    CHECK(g_a.tables[0].has_n == true);
    CHECK_STR(g_a.tables[0].row[1].label, "third");
    CHECK_INT(g_a.tables[0].n[1][0], 30);
    CHECK_INT(g_a.tables[0].n[1][1], 31);

    /* Rounding is the same round-half-away-from-zero every other number on this
     * wire gets, and the unit is whatever `note` names — the device never
     * divides, so a producer sending 9.34 for "$ billions" gets 9 and a chart
     * of nine bars all the same height. Integers, and the note says which. */
    const char *rounded =
        "{\"subject\":{\"symbol\":\"S\"},\"tables\":[{"
        "\"title\":\"T\",\"render\":\"bars_line\",\"columns\":[\"a\",\"b\",\"c\"],\"rows\":["
        "{\"label\":\"r\",\"n\":[1.5,-1.5,2.4]}]}]}";
    CHECK(PARSE(rounded, &g_a) == true);
    CHECK(g_a.tables[0].has_n == true);
    CHECK_INT(g_a.tables[0].n[0][0], 2);
    CHECK_INT(g_a.tables[0].n[0][1], -2);
    CHECK_INT(g_a.tables[0].n[0][2], 2);
}

static void test_emphasis_and_bars(void)
{
    /* Two tiers, and the quiet one is the default. Emphasis is LOUD — a hero is
     * set several times larger than the rail around it — so it is promoted only
     * by a JSON true or a non-zero number. Inventing a hero out of a producer's
     * type error is the worse of the two failures: a rail that is quieter than
     * intended reads as a rail, and one with a spurious hero on it reads as a
     * page that got the day wrong.
     *
     * `bar` is the opposite kind of field: absent is -1 and NOT 0, because 0 is
     * a real position — the bottom of the range — and a rail of figures all
     * drawing an empty track would read as a company at its 52-week low on
     * every measure it has. */
    const char *json =
        "{\"subject\":{\"symbol\":\"S\"},\"figures\":["
        "{\"group\":\"G\",\"label\":\"a\",\"value\":\"v\",\"emph\":true,\"bar\":500},"
        "{\"group\":\"G\",\"label\":\"b\",\"value\":\"v\",\"emph\":1},"
        "{\"group\":\"G\",\"label\":\"c\",\"value\":\"v\"},"
        "{\"group\":\"G\",\"label\":\"d\",\"value\":\"v\",\"emph\":false,\"bar\":0},"
        "{\"group\":\"G\",\"label\":\"e\",\"value\":\"v\",\"emph\":0},"
        "{\"group\":\"G\",\"label\":\"f\",\"value\":\"v\",\"emph\":\"yes\"},"
        "{\"group\":\"G\",\"label\":\"g\",\"value\":\"v\",\"emph\":2,\"bar\":1000},"
        "{\"group\":\"G\",\"label\":\"h\",\"value\":\"v\",\"bar\":-40},"
        "{\"group\":\"G\",\"label\":\"i\",\"value\":\"v\",\"bar\":1400},"
        "{\"group\":\"G\",\"label\":\"j\",\"value\":\"v\",\"bar\":\"500\"},"
        "{\"group\":\"G\",\"label\":\"k\",\"value\":\"v\",\"bar\":499.6}]}";
    CHECK(PARSE(json, &g_a) == true);
    CHECK_INT(g_a.figure_count, 11);

    CHECK_INT(g_a.figures[0].emph, 1);       /* a JSON true       */
    CHECK_INT(g_a.figures[0].bar, 500);
    CHECK_INT(g_a.figures[1].emph, 1);       /* the tier as a number */
    CHECK_INT(g_a.figures[1].bar, -1);       /* a hero with no bar is a big number */
    CHECK_INT(g_a.figures[2].emph, 0);       /* absent            */
    CHECK_INT(g_a.figures[2].bar, -1);
    CHECK_INT(g_a.figures[3].emph, 0);       /* an explicit false */
    CHECK_INT(g_a.figures[3].bar, 0);        /* and 0 is a real position */
    CHECK_INT(g_a.figures[4].emph, 0);       /* an explicit zero  */
    CHECK_INT(g_a.figures[5].emph, 0);       /* a string is not a tier */
    /* Two tiers, so anything above the top one saturates at it rather than
     * reaching a renderer as a third size that does not exist. */
    CHECK_INT(g_a.figures[6].emph, 1);
    CHECK_INT(g_a.figures[6].bar, 1000);

    /* Out of range clamps rather than dropping: a producer that computed 1004
     * has the right figure and the wrong rounding, and a bar pinned to the end
     * of its track says that better than no bar at all. */
    CHECK_INT(g_a.figures[7].bar, 0);
    CHECK_INT(g_a.figures[8].bar, 1000);
    CHECK_INT(g_a.figures[9].bar, -1);       /* a string is not a number */
    CHECK_INT(g_a.figures[10].bar, 500);     /* half away from zero */
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

static void test_a_multibyte_glyph_straddling_a_field_boundary(void)
{
    /* The narrow buffers are where this bites: a brief is 140 bytes and an em
     * dash is three, so a producer writing to the edge of the budget lands a
     * sequence across the cut. The whole glyph is dropped rather than its first
     * two bytes kept — and every one of these fields is a different width, so
     * the boundary is tested where it actually is rather than once. */
    static char json[2048];
    char text[512] = {0};
    for (int i = 0; i < 50; i++) strcat(text, "—");        /* 150 bytes */
    snprintf(json, sizeof(json),
             "{\"subject\":{\"symbol\":\"S\"},"
             " \"briefs\":[{\"text\":\"%s\"}],"
             " \"figures\":[{\"group\":\"%s\",\"label\":\"%s\",\"value\":\"%s\"}]}",
             text, text, text, text);
    CHECK(PARSE(json, &g_a) == true);

    const char *fields[] = {
        g_a.briefs[0].text, g_a.figures[0].group,
        g_a.figures[0].label, g_a.figures[0].value,
    };
    const size_t caps[] = {
        NEWS_BRIEF_MAX, NEWS_GROUP_MAX, NEWS_FIG_LABEL_MAX, NEWS_FIG_VALUE_MAX,
    };
    for (size_t f = 0; f < sizeof(fields) / sizeof(fields[0]); f++) {
        size_t len = strlen(fields[f]);
        CHECK(len < caps[f]);
        CHECK_INT(len % 3, 0);
        CHECK(len + 3 >= caps[f]);          /* it filled the field, then stopped */
        for (size_t i = 0; i < len; i += 3) {
            CHECK(memcmp(fields[f] + i, "—", 3) == 0);
        }
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

    CHECK_INT(news_str_copy_prose(buf, sizeof(buf), "Sandisk's quarter"), 19);
    CHECK_STR(buf, "Sandisk’s quarter");

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

    /* And it reaches the wire: a symbol is copied verbatim, a headline is not. */
    CHECK(PARSE("{\"subject\":{\"symbol\":\"A'B\"},"
                " \"stories\":[{\"headline\":\"Sandisk's day\"}]}", &g_a) == true);
    CHECK_STR(g_a.subject.symbol, "A'B");
    CHECK_STR(g_a.stories[0].headline, "Sandisk’s day");
}

/* --- the policy block ------------------------------------------------------
 *
 * The one object on this wire that is not about the paper. It says how often to
 * come back and when the server's answer will next change, and it reaches no
 * pixel. Everything below follows from that: it clamps rather than rejecting,
 * because a cadence a producer got wrong must never cost an edition, and the
 * fingerprint cannot see it, because `next_change` moves every day and a
 * refresh on this panel is twenty-five seconds of flashing.
 */

/* A payload with no policy leaves the struct zeroed, which is what every
 * payload filed before this field existed does — and a zeroed policy is exactly
 * what makes the compiled-in interval stand. Absent is the normal case: the
 * demo edition and the committed fixture both carry none. */
static void test_policy_absent(void)
{
    CHECK(PARSE("{\"subject\":{\"symbol\":\"S\"}}", &g_a) == true);
    CHECK_INT(g_a.policy.poll_seconds, 0);
    CHECK_INT(g_a.policy.next_change, 0);

    /* And an empty object is the same as no object at all. */
    CHECK(PARSE("{\"subject\":{\"symbol\":\"S\"},\"policy\":{}}", &g_a) == true);
    CHECK_INT(g_a.policy.poll_seconds, 0);
    CHECK_INT(g_a.policy.next_change, 0);
}

/* Out of range goes to the bound rather than to a rejection. This block cannot
 * be allowed to cost a page: a server that computes a cadence of two seconds
 * has a scheduling bug, and the right answer to it is a board that polls at the
 * floor, not a board showing yesterday's front page. */
static void test_policy_clamps(void)
{
    CHECK(PARSE("{\"subject\":{\"symbol\":\"S\"},\"policy\":{\"poll_seconds\":29}}",
                &g_a) == true);
    CHECK_INT(g_a.policy.poll_seconds, NEWS_POLL_MIN);

    CHECK(PARSE("{\"subject\":{\"symbol\":\"S\"},\"policy\":{\"poll_seconds\":86401}}",
                &g_a) == true);
    CHECK_INT(g_a.policy.poll_seconds, NEWS_POLL_MAX);

    CHECK(PARSE("{\"subject\":{\"symbol\":\"S\"},\"policy\":{\"poll_seconds\":-5}}",
                &g_a) == true);
    CHECK_INT(g_a.policy.poll_seconds, NEWS_POLL_MIN);

    /* Inside the range it is carried through, rounded the way every other
     * number on this wire is: half away from zero. */
    CHECK(PARSE("{\"subject\":{\"symbol\":\"S\"},\"policy\":{\"poll_seconds\":900.5}}",
                &g_a) == true);
    CHECK_INT(g_a.policy.poll_seconds, 901);

    /* An instant before the epoch is not an instant. It goes to zero — absent —
     * rather than to a bound, because there is no nearest legal instant a
     * negative one was trying to name. */
    CHECK(PARSE("{\"subject\":{\"symbol\":\"S\"},"
                "\"policy\":{\"next_change\":-1755561000}}", &g_a) == true);
    CHECK_INT(g_a.policy.next_change, 0);

    /* An ordinary one survives as the integer it arrived as. It is past 2038,
     * so this also asserts the field is not an int32 pretending to be a date. */
    CHECK(PARSE("{\"subject\":{\"symbol\":\"S\"},"
                "\"policy\":{\"next_change\":4102444800}}", &g_a) == true);
    CHECK_INT(g_a.policy.next_change, 4102444800LL);
}

/* A string where a number belongs is the same as absent, like every other field
 * on this wire — and `next_change` is where a producer will reach for one, since
 * an instant is naturally written as an ISO-8601 string. It is a JSON NUMBER
 * here on purpose: it is a number the device reasons about, and this wire's rule
 * is that those are integers. Accepting the string form would put a date parser
 * in the firmware, which is a class of bug bought for nothing. */
static void test_policy_wrong_type(void)
{
    CHECK(PARSE("{\"subject\":{\"symbol\":\"S\"},"
                "\"policy\":{\"poll_seconds\":\"900\","
                "            \"next_change\":\"2026-08-19T00:30:00Z\"}}", &g_a) == true);
    CHECK_INT(g_a.policy.poll_seconds, 0);
    CHECK_INT(g_a.policy.next_change, 0);

    /* And a policy that is not an object at all is a policy that is not there.
     * The page still prints — this is a clamp, not a rejection. */
    CHECK(PARSE("{\"subject\":{\"symbol\":\"S\"},\"policy\":\"hourly\"}", &g_a) == true);
    CHECK_INT(g_a.policy.poll_seconds, 0);
    CHECK(PARSE("{\"subject\":{\"symbol\":\"S\"},\"policy\":[900]}", &g_a) == true);
    CHECK_INT(g_a.policy.poll_seconds, 0);
    CHECK_STR(g_a.subject.symbol, "S");
}

/* THE test. news_hash() fingerprints what reaches the glass and the policy
 * reaches nothing, so a payload that differs only here must not spend
 * twenty-five seconds of flashing to report that a timestamp advanced.
 *
 * This is not a micro-optimisation. `next_change` moves at every transition of
 * the server's schedule, several times a day, forever; fingerprinted, it would
 * turn a quiet board into one that flashes at nobody on a timer — which is the
 * exact failure news_hash() exists to prevent, arriving through the one field
 * that was added to prevent it. */
static void test_policy_is_not_fingerprinted(void)
{
    const char *a =
        "{\"subject\":{\"symbol\":\"SNDK\",\"last\":1631.47},"
        " \"stories\":[{\"rank\":0,\"headline\":\"h\",\"body\":\"words\"}],"
        " \"policy\":{\"poll_seconds\":900,\"next_change\":1755561000}}";
    const char *b =
        "{\"subject\":{\"symbol\":\"SNDK\",\"last\":1631.47},"
        " \"stories\":[{\"rank\":0,\"headline\":\"h\",\"body\":\"words\"}],"
        " \"policy\":{\"poll_seconds\":3600,\"next_change\":1755582000}}";

    CHECK(PARSE(a, &g_a) == true);
    CHECK(PARSE(b, &g_b) == true);
    CHECK(g_a.policy.poll_seconds != g_b.policy.poll_seconds);
    CHECK(g_a.policy.next_change != g_b.policy.next_change);
    CHECK_INT(news_hash(&g_a), news_hash(&g_b));

    /* And the block being there at all must not move it either, or the first
     * payload a server splices a policy into costs a refresh that says nothing.
     * The same page without the block hashes the same as the two with it. */
    const char *none =
        "{\"subject\":{\"symbol\":\"SNDK\",\"last\":1631.47},"
        " \"stories\":[{\"rank\":0,\"headline\":\"h\",\"body\":\"words\"}]}";
    CHECK(PARSE(none, &g_b) == true);
    CHECK_INT(g_b.policy.poll_seconds, 0);
    CHECK_INT(news_hash(&g_a), news_hash(&g_b));
}

/* --- the edition's language ------------------------------------------------
 *
 * `lang` is the opposite of `policy` in the one way that matters here: it
 * reaches the glass. It chooses the fixed strings printed beside the copy and
 * the rule the copyfitter breaks a line with, so it IS fingerprinted, and these
 * tests are as much about that as about the normalisation.
 *
 * The normalisation is a clamp and not a rejection for the reason every clamp
 * in this file is one: a payload that names its language badly still carries a
 * front page, and blanking the sheet over a two-letter field is the one failure
 * a reader actually notices. */

static void test_lang_absent_is_en(void)
{
    CHECK(PARSE("{\"subject\":{\"symbol\":\"S\"}}", &g_a) == true);
    CHECK_STR(g_a.lang, "en");
}

static void test_lang_is_normalised_not_rejected(void)
{
    CHECK(PARSE("{\"subject\":{\"symbol\":\"S\"},\"lang\":\"KO\"}", &g_a) == true);
    CHECK_STR(g_a.lang, "ko");
    CHECK(PARSE("{\"subject\":{\"symbol\":\"S\"},\"lang\":\"ko-KR\"}", &g_a) == true);
    CHECK_STR(g_a.lang, "en");           /* a region subtag is not a language tag */
    CHECK(PARSE("{\"subject\":{\"symbol\":\"S\"},\"lang\":7}", &g_a) == true);
    CHECK_STR(g_a.lang, "en");
    CHECK(PARSE("{\"subject\":{\"symbol\":\"S\"},\"lang\":\"\"}", &g_a) == true);
    CHECK_STR(g_a.lang, "en");
}

static void test_lang_is_fingerprinted(void)
{
    const char *a = "{\"subject\":{\"symbol\":\"S\"},\"stories\":[{\"rank\":0,\"headline\":\"h\",\"body\":\"w\"}],\"lang\":\"en\"}";
    const char *b = "{\"subject\":{\"symbol\":\"S\"},\"stories\":[{\"rank\":0,\"headline\":\"h\",\"body\":\"w\"}],\"lang\":\"ko\"}";
    const char *c = "{\"subject\":{\"symbol\":\"S\"},\"stories\":[{\"rank\":0,\"headline\":\"h\",\"body\":\"w\"}]}";
    CHECK(PARSE(a, &g_a) == true);
    CHECK(PARSE(b, &g_b) == true);
    CHECK(news_hash(&g_a) != news_hash(&g_b));      /* the fixed strings differ */
    CHECK(PARSE(c, &g_b) == true);
    CHECK_INT(news_hash(&g_a), news_hash(&g_b));    /* absent IS "en" */
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

    /* Everything that reaches the glass has to move it, and so does everything
     * the COMPOSITOR reads — the counts, the ranks, whether a story brought a
     * photograph. A fingerprint that is too narrow does not fail loudly; it
     * shows yesterday's page forever. */
    #define MOVES(what, mutation) do {              \
        g_b = g_a;                                  \
        mutation;                                   \
        g_total++;                                  \
        if (news_hash(&g_b) == base) {              \
            g_fail++;                               \
            printf("  FAIL news_hash ignores %s\n", what); \
        }                                           \
    } while (0)

    MOVES("edition",           g_b.edition[0] = 'X');
    MOVES("dateline",          g_b.dateline[0] = 'X');
    MOVES("session",           g_b.session[0] = 'X');
    MOVES("as_of",             g_b.as_of[0] = 'X');
    MOVES("generated_at",      g_b.generated_at[0] = 'X');
    MOVES("demo",              g_b.demo = true);

    MOVES("the subject symbol",   g_b.subject.symbol[0] = 'X');
    MOVES("the subject name",     g_b.subject.name[0] = 'X');
    MOVES("the subject exchange", g_b.subject.exchange[0] = 'X');
    MOVES("the subject sector",   g_b.subject.sector[0] = 'X');
    MOVES("the last price",       g_b.subject.last_c++);
    MOVES("the change",           g_b.subject.chg_bp++);
    MOVES("the previous close",   g_b.subject.prev_close_c++);
    MOVES("the session open",     g_b.subject.open_c++);
    MOVES("the session high",     g_b.subject.high_c++);
    MOVES("the session low",      g_b.subject.low_c++);
    MOVES("the 52-week high",     g_b.subject.wk52_hi_c++);
    MOVES("the 52-week low",      g_b.subject.wk52_lo_c++);

    MOVES("a headline",        g_b.stories[0].headline[0] = 'X');
    MOVES("a kicker",          g_b.stories[1].kicker[0] = 'X');
    MOVES("a deck",            g_b.stories[1].deck[0] = 'X');
    MOVES("a byline",          g_b.stories[2].byline[0] = 'X');
    MOVES("a body",            g_b.stories[3].body[0] = 'X');
    MOVES("a story rank",      g_b.stories[2].rank++);
    MOVES("which chart a story names", g_b.stories[0].chart = 0);
    MOVES("a photo id",        g_b.stories[0].photo.id[0] = 'X');
    MOVES("a photo width",     g_b.stories[0].photo.w++);
    MOVES("a photo height",    g_b.stories[0].photo.h++);
    MOVES("a caption",         g_b.stories[0].photo.caption[0] = 'X');
    MOVES("a credit",          g_b.stories[0].photo.credit[0] = 'X');
    /* The compositor asks whether the lead brought a picture before it decides
     * the shape of the whole upper region. */
    MOVES("a photo disappearing", memset(&g_b.stories[0].photo, 0,
                                         sizeof(g_b.stories[0].photo)));

    MOVES("a figure group",    g_b.figures[0].group[0] = 'X');
    MOVES("a figure label",    g_b.figures[3].label[0] = 'X');
    MOVES("a figure value",    g_b.figures[7].value[0] = 'X');
    MOVES("a figure's change", g_b.figures[17].chg_bp++);
    MOVES("a figure losing its change", g_b.figures[17].has_chg = false);
    /* Neither of these changes a character of the rail's text and both change
     * most of its ink: a figure promoted to a hero is set several times larger
     * and takes a line to itself, which moves everything under it. */
    MOVES("a figure being promoted", g_b.figures[8].emph = 1);
    MOVES("a hero being demoted",    g_b.figures[0].emph = 0);
    MOVES("the length of a bar",     g_b.figures[0].bar = 400);
    MOVES("a bar disappearing",      g_b.figures[7].bar = -1);

    MOVES("a brief date",      g_b.briefs[0].date[0] = 'X');
    MOVES("a brief kicker",    g_b.briefs[1].kicker[0] = 'X');
    MOVES("a brief text",      g_b.briefs[5].text[0] = 'X');

    MOVES("a peer symbol",     g_b.peers[0].symbol[0] = 'X');
    MOVES("a peer name",       g_b.peers[0].name[0] = 'X');
    MOVES("a peer multiple",   g_b.peers[0].per[0] = 'X');
    MOVES("a peer cap",        g_b.peers[0].cap[0] = 'X');
    MOVES("a peer price",      g_b.peers[2].last_c++);
    MOVES("a peer change",     g_b.peers[3].chg_bp++);
    MOVES("which peer is us",  g_b.peers[1].is_subject = false);

    MOVES("a table title",     g_b.tables[0].title[0] = 'X');
    MOVES("a table note",      g_b.tables[0].note[0] = 'X');
    MOVES("a column head",     g_b.tables[0].col[2][0] = 'X');
    MOVES("a row label",       g_b.tables[0].row[1].label[0] = 'X');
    MOVES("a table cell",      g_b.tables[0].row[2].v[4][0] = 'X');
    MOVES("a cell going empty", g_b.tables[1].row[0].v[5][0] = '\0');
    /* Whether a statement reaches the glass as a grid of numbers or as a
     * picture is the largest single difference two payloads can make to A2
     * without changing a character of their text. */
    MOVES("how a table is rendered", g_b.tables[0].render = TABLE_PRINT);
    MOVES("a table becoming undrawable", g_b.tables[1].has_n = false);
    /* And every bar of it. Two payloads whose bars move but whose rounded
     * strings do not are two different pictures. */
    MOVES("a bar of a drawn table", g_b.tables[0].n[0][3]++);
    MOVES("a point of the line",    g_b.tables[0].n[2][5]++);
    MOVES("a segment of the stack", g_b.tables[1].n[1][2]++);

    MOVES("a chart label",     g_b.charts[0].label[0] = 'X');
    MOVES("a chart span",      g_b.charts[0].span[0] = 'X');
    MOVES("a chart note",      g_b.charts[0].note[0] = 'X');
    MOVES("a chart kind",      g_b.charts[1].kind = CHART_LINE);
    MOVES("a low",             g_b.charts[0].l[7]++);
    MOVES("the last close",    g_b.charts[0].c[25]++);
    MOVES("a bar",             g_b.charts[1].c[3]++);

    MOVES("an index price",    g_b.indices[0].last_c++);
    MOVES("an index spark",    g_b.indices[0].spark[3]++);
    MOVES("an index change",   g_b.indices[4].chg_bp++);

    MOVES("a thumb id",        g_b.thumbs[0].id[0] = 'X');
    MOVES("a thumb caption",   g_b.thumbs[1].caption[0] = 'X');

    MOVES("the story count",   g_b.story_count--);
    MOVES("the figure count",  g_b.figure_count--);
    MOVES("the brief count",   g_b.brief_count--);
    MOVES("the peer count",    g_b.peer_count--);
    MOVES("the table count",   g_b.table_count--);
    MOVES("the chart count",   g_b.chart_count--);
    MOVES("the index count",   g_b.index_count--);
    MOVES("the thumb count",   g_b.thumb_count--);
    MOVES("a table's row count", g_b.tables[0].row_count--);
    MOVES("a table's column count", g_b.tables[0].col_count--);
    MOVES("a chart's length",  g_b.charts[0].n--);
    MOVES("a spark's length",  g_b.indices[0].spark_n--);

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

    /* The same across a table's cells, which is where it is easiest to get
     * wrong: a row is a run of short strings with nothing between them. */
    memset(&g_a, 0, sizeof(g_a));
    memset(&g_b, 0, sizeof(g_b));
    g_a.table_count = g_b.table_count = 1;
    g_a.tables[0].col_count = g_b.tables[0].col_count = 2;
    g_a.tables[0].row_count = g_b.tables[0].row_count = 1;
    news_str_copy(g_a.tables[0].row[0].v[0], 14, "12");
    news_str_copy(g_a.tables[0].row[0].v[1], 14, "3");
    news_str_copy(g_b.tables[0].row[0].v[0], 14, "1");
    news_str_copy(g_b.tables[0].row[0].v[1], 14, "23");
    CHECK(news_hash(&g_a) != news_hash(&g_b));
}

int main(void)
{
    test_fixture();
    test_rejections();
    test_a_thin_day_is_still_a_page();
    test_type_confusion_clamps();
    test_money_and_percent_round();
    test_sparks_are_clamped_and_right_aligned();
    test_oversized_arrays_are_capped();
    test_a_forty_row_table_is_capped_in_both_directions();
    test_bars_are_capped_at_the_recent_end();
    test_chart_kinds();
    test_charts_that_cannot_be_drawn_become_none();
    test_an_undrawable_chart_keeps_its_index();
    test_flat_close_fills_all_four_series();
    test_ohlc_arrays_are_read_in_parallel();
    test_a_story_chart_index_is_clamped_to_what_arrived();
    test_photos_that_cannot_be_fetched_are_dropped();
    test_thumbs_are_dropped_rather_than_left_as_holes();
    test_stories_sort_by_rank_and_keep_order_within_it();
    test_entries_without_their_required_field_are_skipped();
    test_a_dropped_candidate_does_not_clobber_a_kept_story();
    test_peers();
    test_table_rows_stay_aligned_with_their_header();
    test_table_render_words();
    test_a_partial_numeric_plane_un_draws_the_whole_table();
    test_a_numeric_plane_stays_parallel_to_its_own_row();
    test_emphasis_and_bars();
    test_long_headline_truncates_on_a_boundary();
    test_a_multibyte_glyph_straddling_a_field_boundary();
    test_str_copy();
    test_prose_copy_curls_the_apostrophe();
    test_policy_absent();
    test_policy_clamps();
    test_policy_wrong_type();
    test_policy_is_not_fingerprinted();
    test_lang_absent_is_en();
    test_lang_is_normalised_not_rejected();
    test_lang_is_fingerprinted();
    test_hash_is_content_addressed();
    test_hash_separates_adjacent_strings();
    TH_REPORT("news_parse");
}
