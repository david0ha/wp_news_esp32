/*
 * news_mock.c — the built-in demo front page.
 *
 * The board is a finished object with no agent running: when no news_url has
 * been provisioned, this is what is on the glass, with a DEMO badge in the
 * folio so nobody mistakes it for their own research. It is also the picture in
 * the README and the simulator's default content, so it is written as a
 * competent markets desk would write it — a complete edition, not filler.
 *
 * Three constraints shaped it:
 *
 *   - English only. The bundled faces carry ASCII, Latin-1 and the typography
 *     in S_DATA_PUNCT and nothing else; anything outside that renders as a tofu
 *     box across the largest type on the page. test_news_mock.c walks every
 *     string here and fails on the codepoint rather than leaving it to be
 *     noticed on the panel. The typography that IS allowed — the em dash, the
 *     en dash, the typographic apostrophe — is written into the literals as
 *     final copy rather than left for news_str_copy_prose() to promote, so that
 *     these strings and the server's are the same bytes before either of them
 *     is copied anywhere.
 *   - It is the compositor's busy case on purpose. Four stories, twenty-two
 *     figures in six groups — three of them heroes with bars — six briefs, five
 *     peers, two DRAWN statements, two charts, five ribbon cells and two thumbs
 *     — more modules than one sheet holds, which is the condition the make-up
 *     desk exists to resolve and the one a payload sized to fit exactly would
 *     never exercise.
 *   - It must stay byte-equivalent to tools/mock_news_server.py's payload:
 *     test_news_mock.c parses that server's committed output and asserts the
 *     two fingerprint identically. That is what keeps the demo page and the
 *     wire contract from drifting apart, and it is why the tables below are the
 *     same numbers in the same order as the Python.
 *
 * EVERY NUMBER IS DERIVED, AND HERE IS THE DERIVATION
 * ---------------------------------------------------
 * The edition is about Sandisk Corp. and everything printed in it comes from
 * four inputs: the price $1,631.47, the share count 148,089,758, trailing EPS
 * $72.89 and book value per share $107.78.
 *
 *   market cap = 148,089,758 x 1,631.47   = $241,603,997,484  -> "$241.6B"
 *   P/E        = 1,631.47 / 72.89         = 22.383            -> "22.38x"
 *   P/B        = 1,631.47 / 107.78        = 15.137            -> "15.14x"
 *   equity     = 148,089,758 x 107.78     = $15,961M
 *   TTM income = 148,089,758 x 72.89      = $10,794M          -> "$10.79B"
 *   ROE        = 72.89 / 107.78           = 67.63%            -> "67.6%"
 *   upside     = 1,993.25 / 1,631.47 - 1  = +22.18%
 *   change     = 1,631.47 / 1,593.09 - 1  = +2.41%
 *
 * TWO of the three HERO figures carry a bar as well as a value, and each bar is
 * a position inside a range that is itself in the payload, so a reader can check
 * the picture against the numbers beside it:
 *
 *   52-WEEK RANGE   1,631.47 in wk52_low..wk52_high            -> 938 / 1000
 *   NET MARGIN TTM  46.74%   in the Net margin row's min..max  -> 855 / 1000
 *
 * The third, MEAN TARGET, carries none, and that is the point rather than an
 * omission: `bar` turns a hero into a graphic INSTEAD of a bigger number, so a
 * hero without one is the ordinary hero — the value set large with its change
 * beside it. A price target has no traded band to sit inside; the high and the
 * low are opinions. Both shapes are here because both have to be drawn.
 *
 * REVENUE, PROFIT AND MARGIN is DRAWN rather than printed — two rows of bars
 * with the margin as a line over them — so its numeric plane has to agree with
 * the strings printed under it: revenue and net income in $ millions, and the
 * margin row in basis points because it is a percentage and every percentage
 * that crosses this wire is. Net margin is net income over revenue, column by
 * column, which is how the 58.5% in the June quarter and the loss in the same
 * quarter of 2025 both come out of the same two rows. Its last four net income
 * columns sum to the $10,794M and the $72.89 above. REVENUE BY END MARKET is
 * drawn as a composition of the same six columns, sums to the revenue row, and
 * ends on the 56.1 / 30.8 / 13.1 mix printed on the rail; the revenue bar chart
 * IS that total. It carries no Total row of its own — a stacked bar's total is
 * its height, and printing it as a segment would draw it twice.
 *
 * One figure could not be carried over from the source page the owner supplied:
 * it reported ROE 39.3%, which belongs to an earlier period. Against the EPS and
 * BPS printed here the identity ROE = EPS / BPS gives 67.6%, and three numbers
 * on one rail that do not reconcile with each other is the first thing a reader
 * checks. tools/mock_news_server.py's check_derivations() asserts all of the
 * above — including the gross-margin and operating-expense chain the stories
 * quote but the drawn tables no longer print — on every --dump, --check and
 * --write-fixture.
 */
#include "news_mock.h"

#include <string.h>

/* Local shorthand: every string in this file is final copy that fits, but going
 * through the same UTF-8-safe copy as the parser means the mock cannot become
 * the one path that produces a half-truncated em dash. */
#define CP(dst, src) news_str_copy((dst), sizeof(dst), (src))
#define NELEM(a)     ((int)(sizeof(a) / sizeof((a)[0])))

/* --- the tape ------------------------------------------------------------- */

/* Sparklines, already normalised 0..1000: the producer does this, because the
 * device has the 48x14 box but not the units. */
static const int16_t SPK_SPX[]  = { 402, 418, 396, 430, 455, 441, 468, 502, 488, 521, 546, 574 };
static const int16_t SPK_NDX[]  = { 388, 402, 380, 425, 448, 434, 470, 508, 492, 530, 561, 596 };
static const int16_t SPK_SOX[]  = { 244, 272, 258, 306, 348, 330, 392, 448, 430, 502, 566, 640 };
static const int16_t SPK_UST[]  = { 612, 640, 628, 597, 574, 588, 561, 540, 552, 519, 534, 508 };
static const int16_t SPK_VIX[]  = { 744, 712, 758, 690, 651, 668, 612, 574, 590, 533, 501, 462 };

typedef struct {
    const char    *symbol;
    const char    *name;
    int32_t        last_c;                  /* cents        */
    int32_t        chg_bp;                  /* basis points */
    const int16_t *spark;
    int            spark_n;
} quote_seed_t;

static const quote_seed_t INDICES[] = {
    { "SPX",    "S&P 500",      641283,   62, SPK_SPX, NELEM(SPK_SPX) },
    { "NDX",    "NASDAQ 100",  2384155,   94, SPK_NDX, NELEM(SPK_NDX) },
    { "SOX",    "PHLX SEMIS",   821460,  187, SPK_SOX, NELEM(SPK_SOX) },
    { "UST10Y", "10-YR YIELD",     413,  -72, SPK_UST, NELEM(SPK_UST) },
    { "VIX",    "VIX",            1384, -420, SPK_VIX, NELEM(SPK_VIX) },
};

/* --- the industry --------------------------------------------------------- */

typedef struct {
    const char *symbol, *name, *per, *cap;
    int32_t     last_c, chg_bp;
    bool        is_subject;
} peer_seed_t;

/* Ordered by market value, largest first, with the subject in its own place in
 * that order rather than pinned to the top: the point of the table is where the
 * company sits among the others, and moving it to line one would answer the
 * question the table is asking. */
static const peer_seed_t PEERS[] = {
    { "MU",    "Micron",         "11.62x", "$318.9B",   28415,  287, false },
    { "SNDK",  "Sandisk",        "22.38x", "$241.6B",  163147,  241, true  },
    { "HXSCL", "SK hynix ADR",    "9.24x", "$227.4B",   31260,  318, false },
    { "INTC",  "Intel",          "62.50x", "$180.2B",    4128,  -74, false },
    { "ADI",   "Analog Devices", "38.41x", "$132.8B",   26840,   62, false },
};

/* --- the dossier rail ----------------------------------------------------- */

typedef struct {
    const char *group, *label, *value;
    bool        has_chg;
    int32_t     chg_bp;
    uint8_t     emph;                       /* 0 = the small tier, 1 = a hero  */
    int16_t     bar;                        /* 0..1000 within range, -1 none   */
} figure_seed_t;

/* Consecutive figures sharing a group print one head between them, so this list
 * is ordered and the device does not sort: a rail whose groups interleave
 * prints repeated heads, which is visible and therefore fixable.
 *
 * THREE of the twenty-two are heroes, one each in three different groups, and
 * each is the FIRST line of its group so the eye lands on it before the file
 * behind it. Three is the whole editorial point of `emph`: a rail of twenty-two
 * equal lines is a spreadsheet with a rule down one side, and a rail where
 * everything is emphasised is the same rail. Where the price sits in its own
 * year, what the company keeps of what it sells, and what the street thinks it
 * is worth — those are the three a reader standing across the room can use, and
 * the other nineteen are the file behind them.
 *
 * Spread rather than stacked at the top on purpose: a hero reads as the head of
 * its own section, and three in one group would make that group the rail and the
 * other three an afterthought. */
static const figure_seed_t FIGURES[] = {
    { "VALUATION",     "52-WEEK RANGE",    "$402–$1,712",  false,    0, 1,  938 },
    { "VALUATION",     "MARKET CAP",       "$241.6B",      false,    0, 0,   -1 },
    { "VALUATION",     "P/E (TTM)",        "22.38x",       false,    0, 0,   -1 },
    { "VALUATION",     "PRICE/BOOK",       "15.14x",       false,    0, 0,   -1 },
    { "PER SHARE",     "EPS (TTM)",        "$72.89",       false,    0, 0,   -1 },
    { "PER SHARE",     "BOOK/SHARE",       "$107.78",      false,    0, 0,   -1 },
    { "PER SHARE",     "SHARES OUT",       "148.09M",      false,    0, 0,   -1 },
    { "PROFITABILITY", "NET MARGIN TTM",   "46.7%",        false,    0, 1,  855 },
    { "PROFITABILITY", "ROE",              "67.6%",        false,    0, 0,   -1 },
    { "PROFITABILITY", "NET INCOME TTM",   "$10.79B",      false,    0, 0,   -1 },
    { "REVENUE MIX",   "CLIENT",           "56.1%",        false,    0, 0,   -1 },
    { "REVENUE MIX",   "CONSUMER",         "30.8%",        false,    0, 0,   -1 },
    { "REVENUE MIX",   "CLOUD",            "13.1%",        false,    0, 0,   -1 },
    { "BALANCE SHEET", "DEBT/EQUITY",      "0.00%",        false,    0, 0,   -1 },
    { "BALANCE SHEET", "CURRENT RATIO",    "229.0%",       false,    0, 0,   -1 },
    { "BALANCE SHEET", "INTEREST COVER",   "68,516x",      false,    0, 0,   -1 },
    { "BALANCE SHEET", "DIVIDEND",         "NONE",         false,    0, 0,   -1 },
    { "THE STREET",    "MEAN TARGET",      "$1,993.25",    true,  2218, 1,   -1 },
    { "THE STREET",    "CONSENSUS",        "BUY 22 OF 25", false,    0, 0,   -1 },
    { "THE STREET",    "TARGET RANGE",     "$750–$3,000",  false,    0, 0,   -1 },
    { "THE STREET",    "3Q26 EPS EST",     "$46.22",       false,    0, 0,   -1 },
    { "THE STREET",    "3Q26 REV EST",     "$10.60B",      false,    0, 0,   -1 },
};

/* --- the related-news column ---------------------------------------------- */

typedef struct { const char *date, *kicker, *text; } brief_seed_t;

static const brief_seed_t BRIEFS[] = {
    { "AUG 13", "GUIDANCE",
      "Management guided September-quarter revenue to $10.9 billion at the "
      "midpoint, above the $10.6 billion consensus going in." },
    { "AUG 12", "SUPPLY",
      "Contract NAND prices for the third quarter settled 18 percent above the "
      "second, the fourth consecutive quarterly increase." },
    { "AUG 11", "CAPACITY",
      "No new capacity has been announced by any of the six NAND makers since "
      "2024. Sandisk’s 2026 capital budget is maintenance only." },
    { "AUG 07", "THE STREET",
      "Sandisk is now sixth by market value among integrated semiconductor "
      "makers, one place behind Micron, at $241.6 billion." },
    { "JUL 30", "MANAGEMENT",
      "David V. Goeckeler told analysts the company would not commit to new "
      "wafer starts until contract pricing had held four quarters." },
    { "FEB 2025", "HISTORY",
      "Sandisk was spun out of Western Digital and listed on Nasdaq on "
      "February 24, 2025. Its 52-week low, $402.18, came that autumn." },
};

/* --- the statements ------------------------------------------------------- */

static const char *const QUARTERS[] = { "1Q25", "2Q25", "3Q25", "4Q25", "1Q26", "2Q26" };

/* `v` is what is printed and `n` is what is drawn, and they are the same figures
 * in the two forms each job needs. The strings are house decisions the device
 * must not try to undo — "(370)" is a loss and "(22.1%)" is a negative margin —
 * and the integers beside them are what a bar can be scaled against. A table
 * that sent one and not the other prints; a table whose two planes disagree is
 * the one error nobody forgives, so test_news_mock.c reads every string back and
 * holds it against its integer. */
typedef struct {
    const char *label;
    const char *v[NELEM(QUARTERS)];
    int32_t     n[NELEM(QUARTERS)];
} row_seed_t;

/* Two rows of bars and one line over them, which is the figure every annual
 * report opens with. The LAST row is the line, and its `n` is BASIS POINTS while
 * its `v` prints as a percentage: `note` names the unit of the bars, and a
 * percentage has to be told apart from $ millions by something other than the
 * note it does not share.
 *
 * The margin row is not independent data. It is net income over revenue, column
 * by column, to the basis point — which is why 2Q26 comes out at 58.5%, the
 * number the earnings story prints, and why the two 2025 quarters come out
 * negative, which is the loss that story compares it to. */
static const row_seed_t RESULTS_ROWS[] = {
    { "Revenue",    { "1,672",   "1,952",   "2,845", "4,190", "6,720", "9,340" },
                    {  1672,      1952,      2845,    4190,    6720,    9340   } },
    { "Net income", { "(370)",   "(226)",     "641", "1,535", "3,158", "5,460" },
                    {  -370,      -226,        641,    1535,    3158,    5460   } },
    { "Net margin", { "(22.1%)", "(11.6%)", "22.5%", "36.6%", "47.0%", "58.5%" },
                    { -2213,     -1158,      2253,    3663,    4699,    5846   } },
};

/* Drawn as a composition: three end markets stacked into one column a quarter,
 * where what matters is the mix and not the total. There is no Total row —
 * a stacked bar's total is its height, and printing it as a fourth segment would
 * draw the whole quarter twice at double the scale. The total is still checked,
 * against the Revenue row above and against the revenue bar chart. */
static const row_seed_t SEGMENT_ROWS[] = {
    { "Client",   { "1,037", "1,191", "1,707", "2,451", "3,830", "5,240" },
                  {  1037,    1191,    1707,    2451,    3830,    5240   } },
    { "Consumer", {   "560",   "644",   "925", "1,341", "2,117", "2,877" },
                  {   560,     644,     925,    1341,    2117,    2877   } },
    { "Cloud",    {    "75",   "117",   "213",   "398",   "773", "1,223" },
                  {    75,     117,     213,     398,     773,    1223   } },
};

/* --- the charts ----------------------------------------------------------- */

/* Twenty-six weekly closes in cents, six months. The last is the price in the
 * nameplate — a chart that disagrees with the number printed beside it is the
 * first thing a reader catches — and the peak is the 52-week high. */
static const int32_t PRICE_6M[] = {
     97840, 100215,  96480, 101860, 105530, 103175, 108840, 114290,
    111825, 117650, 123480, 120560, 126835, 132270, 129145, 135890,
    141620, 138975, 145230, 150865, 147620, 154485, 161240, 171240,
    165890, 163147,
};

/* Contract NAND, dollars a gigabyte, 2Q25 through 3Q26 — one quarter AHEAD of the
 * statements, because a contract settles before the revenue it produces is
 * reported. Scaled by the same hundred every price is; the note says the unit.
 *
 * This is deliberately the one series the tables do NOT carry. A2 already draws
 * revenue — REVENUE, PROFIT AND MARGIN is a BARS_LINE whose first row IS the
 * revenue series — so a revenue chart beside it would print the same six bars
 * twice, about 400 px apart, and that is the first thing a reader would see.
 * Contract price sits upstream of all of it: it is what the lead is about, and
 * nothing else on either sheet plots it.
 *
 * The last step is +17.9%, which is the "18 percent" the AUG 12 brief reports,
 * and the last four are consecutive increases, which is its "fourth consecutive
 * quarterly increase". mock_news_server.py's check_derivations() holds the
 * series to both, so the bars and the sentence beside them cannot drift. */
static const int32_t CONTRACT_6Q[] = {
    210, 198, 224, 261, 302, 356,
};

/* --- the copy ------------------------------------------------------------- */

/* The lead runs in up to four legs down most of a broadsheet, so it is written
 * to fill them: about two thousand characters, and every leg gets read. It says
 * one thing per sentence and does not restate the briefs beside it — a page whose
 * lead and whose related-news column carry the same sentence twice is a page the
 * reader stops trusting. */
static const char LEAD_BODY[] =
    "MILPITAS — Sandisk closed at $1,631.47, up 2.41 percent, after the last of "
    "the third-quarter NAND contract negotiations settled above where the spot "
    "market had been trading all summer. That is the wrong way round, and it is "
    "the whole point: contract buyers pay a premium for supply they can "
    "schedule, and this quarter they are paying it. Spot has lagged every "
    "settlement since the autumn, which is what a market looks like when the "
    "marginal buyer is no longer a distributor filling a warehouse but a "
    "hyperscaler filling a data centre eighteen months out. The distributors "
    "are still there. They are simply no longer the ones setting the price. The "
    "inversion is not a quirk of one negotiation. A distributor buys to resell "
    "inside a quarter and will wait a fortnight to save two cents a gigabyte, "
    "which is what has made spot the softer of the two prices in every ordinary "
    "year of this industry. A hyperscaler buys against a build schedule fixed "
    "long before the parts were quoted, and the cost of missing it is a hall of "
    "accelerators standing idle. With that buyer at the table the premium moves "
    "to whichever side of the market can promise delivery, and the spot tape "
    "stops being the leading indicator the trade has always read it as. No NAND "
    "maker has added a wafer of new capacity this year. The Yokkaichi joint "
    "venture, which Sandisk runs with Kioxia and which supplies most of its "
    "bits, is spending on layer count instead: the 232-layer node yields more "
    "gigabytes per wafer than the one it replaced, and stacking is the only "
    "supply growth the industry has left. Bit supply is therefore growing at "
    "the pace the existing fabs can be tuned to grow it, in single digits, "
    "against demand that is not. Layer count is also why the capacity question "
    "cannot be answered quickly. A new fab is three years and the better part "
    "of ten billion dollars, and it is qualified at a node two generations "
    "behind the one it was drawn for; a stacking upgrade to a line that is "
    "already running arrives in four quarters and carries none of that risk. "
    "Every maker in the industry has done the same arithmetic and reached the "
    "same answer, which is why the supply curve for 2027 is largely known "
    "already and why it does not bend. Demand has also changed shape. Cloud "
    "customers spent the year moving from quarterly purchase orders to "
    "multi-quarter agreements, and the company said in July that more than half "
    "of its cloud volume for fiscal 2027 is committed at a fixed price. "
    "Committed volume turns a cyclical business into a scheduled one for as "
    "long as the agreements run, and it removes the two quarters of price "
    "collapse that usually end a memory upcycle. It does not remove the cycle. "
    "It moves the turn out to whenever those agreements come up for renewal, "
    "and it makes the terms of that renewal the only date on the calendar worth "
    "marking. The mix underneath says the same thing from the other end. Cloud "
    "was 4.5 percent of revenue in the March quarter of 2025 and is 13.1 "
    "percent now, on a revenue base that has multiplied more than five times "
    "over the same span — a segment sixteen times the size it was six quarters "
    "ago, against a client business that is still 56.1 percent of the total and "
    "grew fivefold. A supplier whose fastest-growing customer signs "
    "eighteen-month contracts is a different business from one selling into a "
    "channel, and the multiple a market will pay for it is a different "
    "multiple. Eleven houses raised their targets on Thursday. The mean now "
    "stands at $1,993.25 against a high of $3,000 and a low of $750, and that "
    "spread is the whole argument: not what the company earns this quarter, but "
    "how many more quarters like it there are.";

static const char TAPE_BODY[] =
    "The PHLX Semiconductor Index closed up 1.87 percent, its fourth "
    "consecutive weekly gain, and the move was almost entirely memory: Micron "
    "added 2.87 percent and SK hynix’s ADR 3.18. The logic names went nowhere, "
    "and Intel gave back 0.74 percent on no news of its own. Analog Devices, "
    "the other large analogue name in the group, managed 0.62 percent, which is "
    "what the broad market did — the S&P 500 closed up 0.62 percent and the "
    "Nasdaq 100 up 0.94. A tape that separates memory from the rest of the "
    "sector is a tape trading the price of a bit rather than the price of a "
    "design win. It has done that twice before in the past decade, in 2017 and "
    "again in 2021, and on both occasions the separation held until new "
    "capacity arrived to close it. What the multiples say is that the market "
    "does not believe it will hold this time either. Micron trades at 11.62 "
    "times earnings and SK hynix at 9.24, both of them near the bottom of their "
    "own ten-year ranges, while the logic names they are outrunning carry 62.50 "
    "times and 38.41. A market convinced that memory earnings were durable "
    "would not price them at a third of the sector; it prices them there "
    "because it has watched four cycles end the same way. Sandisk’s own 22.38 "
    "times sits between the two camps, which is as close to an argument as a "
    "multiple ever gets. Nothing else in the session pointed the other way. The "
    "ten-year yield eased to 4.13 percent and the VIX closed at 13.84, down "
    "4.20 percent and the lowest of the month. Volatility that low under a tape "
    "this narrow is not calm. It is a market that has stopped hedging the thing "
    "it is long.";

static const char EARNINGS_BODY[] =
    "Sandisk earned $5.46 billion in the June quarter on revenue of $9.34 "
    "billion, a net margin of 58.5 percent against a loss in the same quarter "
    "of 2025. Gross margin reached 72.6 percent from 24.0, and operating "
    "expenses grew twenty-two percent over the same span. That is the whole "
    "arithmetic of the year: five and a half times the revenue on a cost base "
    "that grew by less than a quarter. None of it is a cost programme. It is "
    "price, and it will run the other way with the same leverage when the cycle "
    "turns. The turn itself is worth reading off the row. The company lost $370 "
    "million on $1.67 billion of revenue in the March quarter of 2025 and $226 "
    "million on $1.95 billion in the June quarter that followed; the first "
    "profit came in September, $641 million at a 22.5 percent margin, and every "
    "quarter since has been better than the one before it. Operating income for "
    "the June quarter was $5.94 billion against operating expenses of $842 "
    "million, and net income is that figure after an effective tax rate near "
    "eight percent, which is what is left of the loss years. Diluted earnings "
    "were $36.87 a share in the quarter and $72.89 over the trailing four, on "
    "148.1 million shares. All three end markets grew, but not at one rate: "
    "client revenue was $5.24 billion, consumer $2.88 billion and cloud $1.22 "
    "billion, and only the last of those is growing faster than the price of "
    "the parts. That is why a balance sheet carrying no debt at all, at a "
    "current ratio of 229 percent, is the line worth reading next. A company "
    "with no interest to cover does not have to sell into a falling market to "
    "make a payment.";

static const char STREET_BODY[] =
    "Twenty-two of the twenty-five analysts covering Sandisk rate it a buy, and "
    "the mean twelve-month target of $1,993.25 sits 22.2 percent above "
    "Thursday’s close. The dispersion is the story: the high target is $3,000 "
    "and the low $750, a spread of four to one, which is what an argument about "
    "the length of a cycle looks like written down. The bulls are pricing the "
    "multi-quarter agreements as a floor under 2027 earnings. The bears are "
    "pricing the four previous NAND cycles, each of which ended with a year of "
    "falling prices against a cost base built for the peak. Neither side "
    "disputes the June quarter. They dispute what follows it. The two targets "
    "are not two views of the same multiple. The mean is 27.3 times the $72.89 "
    "the company earned over the trailing four quarters, which sounds expensive "
    "until it is set against the $46.22 the same analysts expect for the "
    "September quarter alone: annualise that and the mean is 10.8 times, and "
    "the high target is 16.2. The low target of $750 is not a forecast of this "
    "year at all. It is 6.96 times book value, which is roughly where the "
    "shares traded in the loss quarters, and it prices a return to them. The "
    "estimates themselves are the aggressive part of the file. Consensus has "
    "September revenue at $10.60 billion and earnings at $46.22 a share, which "
    "on 148.1 million shares is a net margin of 64.6 percent — six points above "
    "the June quarter and the highest any NAND maker has reported. Every "
    "analyst on that list is therefore forecasting that contract prices rise "
    "again before they fall, and none of them is forecasting the fourth "
    "quarter.";

/* --- assembly ------------------------------------------------------------- */

/* Every one of these bounds its own array. This snapshot is a literal and is
 * the one that never goes through the parser's clamping, so a line added in a
 * hurry would otherwise write past the end of a fixed-size array in a struct
 * that is copied wholesale into the UI's. */

static void add_indices(news_t *v)
{
    for (int i = 0; i < NELEM(INDICES) && v->index_count < NEWS_INDEX_MAX; i++) {
        news_quote_t *q = &v->indices[v->index_count++];
        CP(q->symbol, INDICES[i].symbol);
        CP(q->name,   INDICES[i].name);
        q->last_c  = INDICES[i].last_c;
        q->chg_bp  = INDICES[i].chg_bp;
        q->spark_n = INDICES[i].spark_n > NEWS_SPARK_MAX ? NEWS_SPARK_MAX
                                                         : INDICES[i].spark_n;
        for (int k = 0; k < q->spark_n; k++) q->spark[k] = INDICES[i].spark[k];
    }
}

static void add_peers(news_t *v)
{
    for (int i = 0; i < NELEM(PEERS) && v->peer_count < NEWS_PEERS_MAX; i++) {
        news_peer_t *p = &v->peers[v->peer_count++];
        CP(p->symbol, PEERS[i].symbol);
        CP(p->name,   PEERS[i].name);
        CP(p->per,    PEERS[i].per);
        CP(p->cap,    PEERS[i].cap);
        p->last_c     = PEERS[i].last_c;
        p->chg_bp     = PEERS[i].chg_bp;
        p->is_subject = PEERS[i].is_subject;
    }
}

static void add_figures(news_t *v)
{
    for (int i = 0; i < NELEM(FIGURES) && v->figure_count < NEWS_FIGURES_MAX; i++) {
        news_figure_t *f = &v->figures[v->figure_count++];
        CP(f->group, FIGURES[i].group);
        CP(f->label, FIGURES[i].label);
        CP(f->value, FIGURES[i].value);
        f->has_chg = FIGURES[i].has_chg;
        f->chg_bp  = FIGURES[i].chg_bp;
        f->emph    = FIGURES[i].emph;
        /* Written explicitly rather than left to the memset above, because "no
         * bar" is -1 here and not 0: zero is a real position — the bottom of the
         * range — and a rail where nineteen figures drew an empty bar at the
         * left-hand end would look like nineteen figures at their 52-week low. */
        f->bar     = FIGURES[i].bar;
    }
}

static void add_briefs(news_t *v)
{
    for (int i = 0; i < NELEM(BRIEFS) && v->brief_count < NEWS_BRIEFS_MAX; i++) {
        news_brief_t *b = &v->briefs[v->brief_count++];
        CP(b->date,   BRIEFS[i].date);
        CP(b->kicker, BRIEFS[i].kicker);
        CP(b->text,   BRIEFS[i].text);
    }
}

static void add_table(news_t *v, const char *title, const char *note,
                      table_render_t render, const row_seed_t *rows, int n)
{
    if (v->table_count >= NEWS_TABLES_MAX) return;
    news_table_t *t = &v->tables[v->table_count++];

    CP(t->title, title);
    CP(t->note,  note);
    t->render = render;
    for (int c = 0; c < NELEM(QUARTERS) && t->col_count < NEWS_TABLE_COLS; c++) {
        CP(t->col[t->col_count], QUARTERS[c]);
        t->col_count++;
    }
    for (int r = 0; r < n && t->row_count < NEWS_TABLE_ROWS; r++) {
        int row = t->row_count++;
        CP(t->row[row].label, rows[r].label);
        for (int c = 0; c < t->col_count; c++) {
            CP(t->row[row].v[c], rows[r].v[c]);
            t->n[row][c] = rows[r].n[c];
        }
    }
    /* Every seed above carries a full plane over all six quarters, so this is
     * unconditionally true here — which is exactly the point of stating it: a
     * row_seed_t added later with a short `n` would leave `has_n` claiming a
     * plane that news_parse() would have refused, and the fixture comparison
     * would then fail on a field nobody had thought about. */
    t->has_n = t->row_count > 0 && t->col_count > 0;
}

/* Both charts arrive as bare closes, which is the wire's flat form: open, high
 * and low are set to the close so that a consumer reaching for h[] gets a
 * zero-height bar rather than one spanning the whole scale. That is exactly
 * what news_parse.c does with a `close` array that has no `open` beside it, and
 * the fixture holds the two against each other. */
static void add_chart(news_t *v, chart_kind_t kind, const char *label,
                      const char *span, const char *note,
                      const int32_t *close, int n)
{
    if (v->chart_count >= NEWS_CHARTS_MAX) return;
    news_chart_t *ch = &v->charts[v->chart_count++];

    ch->kind = kind;
    CP(ch->label, label);
    CP(ch->span,  span);
    CP(ch->note,  note);
    ch->n = n > NEWS_BARS_MAX ? NEWS_BARS_MAX : n;
    for (int i = 0; i < ch->n; i++) {
        ch->o[i] = ch->h[i] = ch->l[i] = ch->c[i] = close[i];
    }
}

/* Returns the slot so the caller can hang a photo on it; a story without one is
 * complete on its own, which is why it is not a parameter. Returns the last
 * slot rather than NULL when the array is full, because every caller
 * dereferences. */
static news_story_t *add_story(news_t *v, int rank, const char *kicker,
                               const char *headline, const char *deck,
                               const char *byline, const char *body, int chart)
{
    if (v->story_count >= NEWS_STORIES_MAX) return &v->stories[NEWS_STORIES_MAX - 1];
    news_story_t *s = &v->stories[v->story_count++];
    s->rank = rank;
    CP(s->kicker,   kicker);
    CP(s->headline, headline);
    CP(s->deck,     deck);
    CP(s->byline,   byline);
    CP(s->body,     body);
    s->chart = chart;
    return s;
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

static void add_thumb(news_t *v, const char *id, int w, int h,
                      const char *caption, const char *credit)
{
    if (v->thumb_count >= NEWS_THUMBS_MAX) return;
    set_photo(&v->thumbs[v->thumb_count++], id, w, h, caption, credit);
}

void news_mock(news_t *v)
{
    if (!v) return;
    memset(v, 0, sizeof(*v));
    v->valid = true;
    v->demo  = true;

    CP(v->edition,      "SEMICONDUCTORS");
    CP(v->dateline,     "FRIDAY, AUGUST 14, 2026");
    CP(v->session,      "U.S. MARKETS CLOSED — AUG 13");
    CP(v->as_of,        "AS OF 05:12 KST");
    CP(v->generated_at, "2026-08-14T05:12:00Z");

    CP(v->subject.symbol,   "SNDK");
    CP(v->subject.name,     "Sandisk Corp.");
    CP(v->subject.exchange, "NASDAQ");
    CP(v->subject.sector,   "Semiconductors");
    v->subject.last_c       = 163147;
    v->subject.chg_bp       =    241;
    v->subject.prev_close_c = 159309;
    v->subject.open_c       = 159820;
    v->subject.high_c       = 164200;
    v->subject.low_c        = 159055;
    v->subject.wk52_hi_c    = 171240;
    v->subject.wk52_lo_c    =  40218;

    /* The charts go in first because a story names one by index, and the
     * indices below are written against this order. */
    add_chart(v, CHART_LINE, "PRICE", "6M", "Weekly close, in dollars",
              PRICE_6M, NELEM(PRICE_6M));
    add_chart(v, CHART_BAR, "NAND CONTRACT", "6Q",
              "Contract price per gigabyte, dollars",
              CONTRACT_6Q, NELEM(CONTRACT_6Q));

    news_story_t *lead = add_story(v, 0, "NAND PRICING",
        "Sandisk clears $1,600 as NAND contract prices reset again",
        "Third-quarter contract talks settled above spot, and the sell-side "
        "spent the session moving its targets up.",
        "By CLAUDE · SEMICONDUCTOR DESK", LEAD_BODY, 1);
    /* The lead carries both a photograph and a chart, which is the case the
     * make-up desk has to resolve rather than the case it can assume away.
     *
     * 1140 x 320 is the full six-column measure and is exactly what
     * tools/demo_photos.py packs into tiles/sndk_fab.bin. These two numbers are
     * the byte count of that file — the device fetches w*h/2 raw bytes and
     * copies them verbatim — so they are not a layout preference and cannot be
     * chosen independently of the tile. */
    set_photo(&lead->photo, "sndk_fab", 1140, 320,
              "The Yokkaichi joint-venture fab, where the bit supply is not growing.",
              "DEMO IMAGE");

    /* No chart: a story about the tape quotes an index that is already in the
     * ribbon, and the row must not assume every story brings a series. */
    add_story(v, 1, "THE TAPE",
        "Memory leads the semis higher for a fourth week",
        "The PHLX index is up 1.87 percent; Micron rose with it.",
        "By CLAUDE · MARKETS DESK", TAPE_BODY, -1);

    /* No chart, and deliberately: this story is about revenue and margin, and
     * REVENUE, PROFIT AND MARGIN on A2 draws exactly that. Charting it here would
     * put the same bars on the sheet twice. The table is its picture. */
    add_story(v, 2, "EARNINGS",
        "Revenue nearly doubles again in the June quarter",
        "Net income was $5.46 billion on revenue of $9.34 billion.",
        "By CLAUDE · EARNINGS DESK", EARNINGS_BODY, -1);

    /* The six-month price line belongs here rather than on the lead: this is the
     * story that argues about where the price goes next, and the target it quotes
     * only means anything against where the price has been. */
    add_story(v, 3, "THE STREET",
        "Targets move up; three houses still say hold",
        "The mean target implies 22 percent more upside.",
        "By CLAUDE · THE STREET", STREET_BODY, 0);

    add_figures(v);
    add_briefs(v);
    add_peers(v);

    add_table(v, "REVENUE, PROFIT AND MARGIN", "$ millions", TABLE_BARS_LINE,
              RESULTS_ROWS, NELEM(RESULTS_ROWS));
    add_table(v, "REVENUE BY END MARKET", "$ millions", TABLE_STACK,
              SEGMENT_ROWS, NELEM(SEGMENT_ROWS));

    add_indices(v);

    add_thumb(v, "sndk_wafer", 364, 204,
              "A 232-layer wafer at Yokkaichi. Output per wafer is the constraint.",
              "DEMO IMAGE");
    add_thumb(v, "sndk_line", 364, 204,
              "The Milpitas test floor, running three shifts since February.",
              "DEMO IMAGE");
}
