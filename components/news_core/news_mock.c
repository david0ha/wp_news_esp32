/*
 * news_mock.c — the built-in demo front page.
 *
 * The board is a finished object with no agent running: when no news_url has
 * been provisioned, this is what is on the glass, with a DEMO badge in the
 * folio so nobody mistakes it for their own portfolio. It is also the picture
 * in the README and the simulator’s default content, so it is written as a
 * competent markets desk would write it — a complete page, not filler.
 *
 * Three constraints shaped it:
 *
 *   - English only. The bundled faces carry ASCII, Latin-1 and the typography
 *     in S_DATA_PUNCT and nothing else; anything outside that renders as a tofu
 *     box across the largest type on the page. test_news_mock.c walks every
 *     string here and fails on the codepoint rather than leaving it to be
 *     noticed on the panel.
 *   - It is the layout’s worst case on purpose. Both blocks of the ticker table
 *     are full, all five ribbon cells are used, the lead’s body is long enough
 *     to fill two 368 px columns, one story carries no symbol at all and one
 *     chart arrives as bare closes rather than quadruples — so the simulator’s
 *     assertions run against the widest thing the page will be asked to set.
 *   - It must stay byte-equivalent to tools/mock_news_server.py’s payload:
 *     test_news_mock.c parses that server’s committed output and asserts the
 *     two fingerprint identically. That is what keeps the demo page and the
 *     wire contract from drifting apart, and it is why the tables below are the
 *     same numbers in the same order as the Python.
 */
#include "news_mock.h"

#include <string.h>

/* Local shorthand: every string in this file is a literal that fits, but going
 * through the same UTF-8-safe copy as the parser means the mock cannot become
 * the one path that produces a half-truncated em dash. */
#define CP(dst, src) news_str_copy((dst), sizeof(dst), (src))
#define NELEM(a)     ((int)(sizeof(a) / sizeof((a)[0])))

/* A row of the ribbon or the watchlist. The seed table is separate from the
 * model struct so that the prices, the names and the sparklines read as one
 * block against the Python they mirror. */
typedef struct {
    const char    *symbol;
    const char    *name;
    int32_t        last_c;                  /* cents        */
    int32_t        chg_bp;                  /* basis points */
    const int16_t *spark;
    int            spark_n;
} quote_seed_t;

/* Sparklines, already normalised 0..1000: the producer does this, because the
 * device has the 48x14 box but not the units. */
static const int16_t SPK_SPX[]   = { 402, 418, 396, 430, 455, 441, 468, 502, 488, 521, 546, 574 };
static const int16_t SPK_NDX[]   = { 612, 640, 628, 597, 574, 588, 561, 540, 552, 519, 534, 508 };
static const int16_t SPK_DJI[]   = { 318, 305, 331, 349, 336, 362, 380, 371, 398, 415, 402, 428 };
static const int16_t SPK_RUT[]   = { 206, 232, 221, 258, 284, 271, 310, 342, 329, 368, 401, 436 };
static const int16_t SPK_VIX[]   = { 744, 712, 758, 690, 651, 668, 612, 574, 590, 533, 501, 462 };
static const int16_t SPK_NVDA[]  = { 688, 712, 700, 741, 726, 690, 664, 638, 651, 610, 592, 566 };
static const int16_t SPK_AAPL[]  = { 430, 442, 421, 455, 468, 451, 476, 490, 472, 501, 488, 512 };
static const int16_t SPK_MSFT[]  = { 512, 528, 505, 540, 556, 533, 561, 578, 560, 592, 605, 624 };
static const int16_t SPK_GOOGL[] = { 560, 574, 552, 588, 566, 541, 528, 549, 520, 505, 517, 494 };
static const int16_t SPK_AMZN[]  = { 340, 366, 352, 391, 418, 402, 440, 468, 455, 492, 520, 548 };
static const int16_t SPK_META[]  = { 620, 648, 632, 660, 641, 612, 590, 605, 574, 552, 566, 530 };
static const int16_t SPK_TSLA[]  = { 280, 312, 296, 348, 380, 362, 410, 452, 436, 488, 526, 570 };
static const int16_t SPK_AVGO[]  = { 700, 728, 715, 744, 720, 688, 660, 672, 640, 612, 624, 580 };
static const int16_t SPK_AMD[]   = { 648, 662, 640, 675, 652, 628, 606, 620, 588, 570, 582, 548 };
static const int16_t SPK_MU[]    = { 240, 268, 255, 300, 336, 320, 372, 412, 398, 452, 496, 540 };
static const int16_t SPK_TSM[]   = { 590, 612, 600, 628, 610, 585, 562, 576, 548, 530, 542, 512 };
static const int16_t SPK_JPM[]   = { 452, 466, 448, 478, 490, 472, 496, 508, 492, 516, 504, 528 };
static const int16_t SPK_XOM[]   = { 540, 556, 538, 566, 548, 524, 508, 520, 496, 480, 492, 468 };
static const int16_t SPK_LLY[]   = { 388, 404, 386, 420, 438, 421, 448, 466, 450, 480, 496, 518 };
static const int16_t SPK_COST[]  = { 500, 514, 498, 524, 510, 492, 480, 492, 472, 462, 474, 456 };
static const int16_t SPK_V[]     = { 468, 480, 462, 492, 505, 488, 512, 524, 508, 532, 520, 544 };

static const quote_seed_t INDICES[] = {
    { "SPX", "S&P 500",       641283,   62, SPK_SPX, NELEM(SPK_SPX) },
    { "NDX", "NASDAQ 100",   2384155,  -18, SPK_NDX, NELEM(SPK_NDX) },
    { "DJI", "DOW 30",       4721560,   34, SPK_DJI, NELEM(SPK_DJI) },
    { "RUT", "RUSSELL 2000",  254419,   91, SPK_RUT, NELEM(SPK_RUT) },
    { "VIX", "VIX",             1462, -310, SPK_VIX, NELEM(SPK_VIX) },
};

/* Sixteen large-caps: both blocks of eight, and names a reader recognises. A
 * watchlist of unfamiliar symbols reads as test data, and this is the first
 * page anybody sees. */
static const quote_seed_t TICKERS[] = {
    { "NVDA",  "Nvidia",         18322, -184, SPK_NVDA,  NELEM(SPK_NVDA) },
    { "AAPL",  "Apple",          23140,   31, SPK_AAPL,  NELEM(SPK_AAPL) },
    { "MSFT",  "Microsoft",      51266,   44, SPK_MSFT,  NELEM(SPK_MSFT) },
    { "GOOGL", "Alphabet",       21408,  -27, SPK_GOOGL, NELEM(SPK_GOOGL) },
    { "AMZN",  "Amazon",         23891,  112, SPK_AMZN,  NELEM(SPK_AMZN) },
    { "META",  "Meta Platforms", 74235,  -63, SPK_META,  NELEM(SPK_META) },
    { "TSLA",  "Tesla",          34177,  218, SPK_TSLA,  NELEM(SPK_TSLA) },
    { "AVGO",  "Broadcom",       29744, -205, SPK_AVGO,  NELEM(SPK_AVGO) },
    { "AMD",   "Advanced Micro", 17462, -131, SPK_AMD,   NELEM(SPK_AMD) },
    { "MU",    "Micron",         12805,  342, SPK_MU,    NELEM(SPK_MU) },
    { "TSM",   "Taiwan Semi",    24119,  -88, SPK_TSM,   NELEM(SPK_TSM) },
    { "JPM",   "JPMorgan",       30255,   19, SPK_JPM,   NELEM(SPK_JPM) },
    { "XOM",   "Exxon Mobil",    11873,  -42, SPK_XOM,   NELEM(SPK_XOM) },
    { "LLY",   "Eli Lilly",      90214,   76, SPK_LLY,   NELEM(SPK_LLY) },
    { "COST",  "Costco",         98430,  -11, SPK_COST,  NELEM(SPK_COST) },
    { "V",     "Visa",           35862,   24, SPK_V,     NELEM(SPK_V) },
};

/* Twenty-two sessions of NVDA in cents, open/high/low/close. The last close is
 * the ticker’s `last`: a chart that disagrees with the number printed beside it
 * is the first thing a reader catches. */
static const int32_t NVDA_OHLC[][4] = {
    { 16840, 17095, 16780, 17012 },
    { 17030, 17260, 16955, 17205 },
    { 17190, 17310, 16920, 16988 },
    { 17005, 17440, 16990, 17402 },
    { 17420, 17685, 17360, 17631 },
    { 17610, 17720, 17395, 17447 },
    { 17480, 17930, 17410, 17905 },
    { 17940, 18175, 17860, 18122 },
    { 18100, 18240, 17805, 17863 },
    { 17890, 18055, 17730, 18014 },
    { 18040, 18490, 18010, 18455 },
    { 18470, 18720, 18390, 18678 },
    { 18650, 18840, 18475, 18510 },
    { 18530, 18995, 18500, 18940 },
    { 18960, 19230, 18885, 19186 },
    { 19150, 19285, 18740, 18802 },
    { 18820, 19010, 18655, 18694 },
    { 18710, 18860, 18420, 18475 },
    { 18490, 18775, 18430, 18731 },
    { 18700, 18890, 18560, 18665 },
    { 18640, 18720, 18205, 18290 },
    { 18310, 18540, 18155, 18322 },
};

/* Thirty closes, which is what the wire’s flat form carries for a line chart.
 * Open, high and low are set to the close so that a reader of h[] gets a
 * zero-height bar rather than one spanning the scale — the same thing the
 * parser does with a bare number, asserted against each other by the fixture. */
static const int32_t XOM_CLOSE[] = {
    11985, 12012, 11964, 11920, 11895, 11940, 11972, 12005, 11988, 11931, 11890, 11855,
    11820, 11864, 11902, 11935, 11910, 11872, 11840, 11815, 11792, 11830, 11866, 11895,
    11918, 11884, 11850, 11822, 11845, 11873,
};

static const char LEAD_BODY[] =
    "SANTA CLARA — Nvidia closed the book on a quarter Wall Street had spent "
    "three months arguing about, reporting data-center revenue above every "
    "published estimate and guiding the October quarter higher still. The "
    "stock fell 1.8 percent anyway. That is the trade in miniature: the "
    "numbers are no longer the question, and the argument has moved on to who "
    "pays for the next build-out and over how many years it is written down. "
    "Hyperscaler capital budgets, revised upward twice already this year, now "
    "imply a level of accelerator demand the company itself has stopped "
    "calling a backlog and started calling a schedule. Supply is the "
    "constraint that remains. Advanced packaging is booked into next spring, "
    "memory partners are quoting lead times in quarters rather than weeks, "
    "and the analysts who spent the spring modelling a glut are quietly "
    "rebuilding their spreadsheets.";

static const char ENERGY_BODY[] =
    "VIENNA — Eight OPEC+ members will restore a further 137,000 barrels a "
    "day from October, a decision the futures curve had already written in. "
    "Brent settled below $60 for the third straight session and the "
    "front-month spread flipped into contango, which is the market saying it "
    "expects the barrels to arrive. U.S. producers have answered by doing "
    "nothing: rig counts in the Permian are flat for the eighth week, and the "
    "majors are still guiding to buybacks rather than to volume.";

static const char RATES_BODY[] =
    "WASHINGTON — Initial claims came in at 241,000 against an expected "
    "225,000, and the two-year yield gave up eleven basis points inside an "
    "hour. Fed funds futures now price two cuts before Christmas where "
    "yesterday they priced one and a half. The long end declined to agree: "
    "the ten-year fell four basis points, steepening the curve to its widest "
    "since March and leaving the inflation breakevens almost exactly where "
    "they started the week.";

static const char RETAIL_BODY[] =
    "ISSAQUAH — Costco reported August comparable sales up 6.1 percent "
    "excluding fuel, with traffic rather than ticket doing the work, and the "
    "executive membership renewal rate unchanged at 92.9 percent. That last "
    "number is the one the company is really reporting: the merchandise "
    "margin is thin by design and the fees are the profit, so a renewal rate "
    "that does not move through a soft quarter is the whole thesis holding.";

/* --- assembly ------------------------------------------------------------- */

static void add_quotes(news_quote_t *dst, int *count, int cap,
                       const quote_seed_t *seed, int n)
{
    for (int i = 0; i < n && *count < cap; i++) {
        news_quote_t *q = &dst[(*count)++];
        CP(q->symbol, seed[i].symbol);
        CP(q->name,   seed[i].name);
        q->last_c = seed[i].last_c;
        q->chg_bp = seed[i].chg_bp;
        q->spark_n = seed[i].spark_n > NEWS_SPARK_MAX ? NEWS_SPARK_MAX : seed[i].spark_n;
        for (int k = 0; k < q->spark_n; k++) q->spark[k] = seed[i].spark[k];
    }
}

/* Returns the slot so the caller can hang a chart or a photo on it; a story
 * without either is complete on its own, which is why they are not parameters.
 *
 * The bound is a bound, not a policy: this snapshot is a literal four stories
 * long and is the one that never goes through the parser’s clamping, so an
 * eighth call added in a hurry would otherwise write past the array. It returns
 * the last slot rather than NULL because every caller dereferences. */
static news_story_t *add_story(news_t *v, int rank, const char *kicker,
                               const char *headline, const char *deck,
                               const char *byline, const char *body,
                               const char *symbol, int32_t last_c, int32_t chg_bp)
{
    if (v->story_count >= NEWS_STORIES_MAX) return &v->stories[NEWS_STORIES_MAX - 1];
    news_story_t *s = &v->stories[v->story_count++];
    s->rank = rank;
    CP(s->kicker,   kicker);
    CP(s->headline, headline);
    CP(s->deck,     deck);
    CP(s->byline,   byline);
    CP(s->body,     body);
    CP(s->symbol,   symbol);
    s->last_c = last_c;
    s->chg_bp = chg_bp;
    return s;
}

static void set_candles(news_chart_t *ch, const char *span,
                        const int32_t (*bars)[4], int n)
{
    ch->kind = CHART_CANDLE;
    CP(ch->span, span);
    ch->n = n > NEWS_BARS_MAX ? NEWS_BARS_MAX : n;
    for (int i = 0; i < ch->n; i++) {
        ch->o[i] = bars[i][0];
        ch->h[i] = bars[i][1];
        ch->l[i] = bars[i][2];
        ch->c[i] = bars[i][3];
    }
}

static void set_line(news_chart_t *ch, const char *span,
                     const int32_t *close, int n)
{
    ch->kind = CHART_LINE;
    CP(ch->span, span);
    ch->n = n > NEWS_BARS_MAX ? NEWS_BARS_MAX : n;
    for (int i = 0; i < ch->n; i++) {
        ch->o[i] = ch->h[i] = ch->l[i] = ch->c[i] = close[i];
    }
}

static void set_photo(news_photo_t *p, const char *id, int w, int h,
                      const char *caption, const char *credit)
{
    CP(p->id, id);
    p->w = w;
    p->h = h;
    CP(p->caption, caption);
    CP(p->credit,  credit);
}

void news_mock(news_t *v)
{
    if (!v) return;
    memset(v, 0, sizeof(*v));
    v->valid = true;
    v->demo  = true;

    CP(v->edition,      "PERSONAL PORTFOLIO EDITION");
    CP(v->dateline,     "FRIDAY, AUGUST 14, 2026");
    CP(v->session,      "U.S. MARKETS CLOSED — AUG 13");
    CP(v->as_of,        "AS OF 05:12 KST");
    CP(v->generated_at, "2026-08-14T05:12:00Z");

    add_quotes(v->indices, &v->index_count,  NEWS_INDEX_MAX,
               INDICES, NELEM(INDICES));
    add_quotes(v->tickers, &v->ticker_count, NEWS_TICKERS_MAX,
               TICKERS, NELEM(TICKERS));

    news_story_t *lead = add_story(v, 0, "SEMICONDUCTORS",
        "Nvidia’s blowout quarter resets the whole AI trade",
        "Guidance beat the entire sell-side range, and for the first time the "
        "supply story arrives with numbers attached.",
        "By CLAUDE · MARKET DESK", LEAD_BODY,
        "NVDA", 18322, -184);
    set_candles(&lead->chart, "1M", NVDA_OHLC, NELEM(NVDA_OHLC));
    /* The lead carries both a photo and a chart, which is the case the layout
     * has to resolve rather than the case it can assume away: the photo wins
     * the slot and the chart is dropped. */
    set_photo(&lead->photo, "nvda_hq", 1140, 360,
              "The financial district at the close, where the argument over who pays is now had.",
              "DEMO IMAGE");

    news_story_t *energy = add_story(v, 1, "ENERGY",
        "Crude slips under $60 as OPEC+ opens the taps",
        "Eight members restore 137,000 barrels a day in October.",
        "By CLAUDE · ENERGY DESK", ENERGY_BODY,
        "XOM", 11873, -42);
    set_line(&energy->chart, "5D", XOM_CLOSE, NELEM(XOM_CLOSE));

    /* No symbol, no price, no chart. A macro story is an ordinary front-page
     * item, and the secondary row must not assume every story quotes one. */
    add_story(v, 2, "RATES",
        "Two-year yield sinks after a soft claims print",
        "The front end prices two cuts. The long end disagrees.",
        "By CLAUDE · RATES DESK", RATES_BODY,
        "", 0, 0);

    add_story(v, 3, "RETAIL",
        "Costco holds the line where the mall does not",
        "Comparables rose 6.1 percent; renewals did not move.",
        "By CLAUDE · RETAIL DESK", RETAIL_BODY,
        "COST", 98430, -11);
}
