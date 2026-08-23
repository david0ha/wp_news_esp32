#!/usr/bin/env python3
"""
The front-page contract, as a runnable server.

This is the reference implementation of what the device fetches — the thing the
research agent that actually reads the markets has to imitate. It exists for
four jobs:

  1. Point a board (or the simulator) at a URL and watch real polling work,
     without writing anything that touches a market data feed.
  2. Produce the committed fixture the host tests parse
     (components/news_core/test/host/fixtures/news.json).
  3. Pin the contract. The payload here and news_mock.c’s built-in demo
     snapshot are asserted to be identical by test_news_mock.c, so the wire
     format and the page the board shows when nothing is configured cannot
     drift apart.
  4. Answer "did anyone edit the fixture by hand" — that is --check.

ONE COMPANY A DAY
-----------------
An edition is about a single listed company. `subject` is that company;
everything else on the sheet is about it — why the price moved, whether the
tape moved with it, what it is worth by the usual measures, what it earned, who
else trades in its industry, and what the street thinks it will do next.

Every price here is a JSON number and the device converts: prices become int32
cents, percentage changes become int32 basis points. Nothing on either side of
the wire holds a float once it has been read. A figure the device only PRINTS —
a market capitalisation, a P/E multiple, a line of a statement — is sent as a
preformatted string, because how many significant figures and which suffix is a
house decision and the producer is the only party that knows the answer.

Usage
-----
    python3 tools/mock_news_server.py                 # serve on :8123
    python3 tools/mock_news_server.py --port 9000
    python3 tools/mock_news_server.py --live          # prices drift each poll
    python3 tools/mock_news_server.py --dump          # print the payload
    python3 tools/mock_news_server.py --write-fixture # refresh the test fixture
    python3 tools/mock_news_server.py --check         # fixture still matches?

    # check an edition against the contract, the length budget and its tiles
    python3 tools/mock_news_server.py --validate path/to/news.json
    python3 tools/mock_news_server.py --validate <fixture> --tiles sim/tiles

`--validate` looks for `<id>.bin` in a `tiles/` directory beside the payload, which is how
agent/standalone/file-edition.sh files an edition. `--tiles` overrides that base, and the committed
fixture is the one payload that needs it: its pictures live in `sim/tiles/` because that is where
the simulator reads them from.

Then set the board’s URL to http://<this machine>.local:8123/news.json, either
in the captive portal or with

    curl -X POST http://claudepost.local/api/news \\
         -d '{"url":"http://mymac.local:8123/news.json"}'
"""

import argparse
import hashlib
import json
import os
import random
import re
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FIXTURE = os.path.join(ROOT, "components", "news_core", "test", "host",
                       "fixtures", "news.json")

# The demo edition's pictures. They live with the simulator rather than beside the fixture because
# that is where sim/ reads them from, so the fixture is the one payload whose tiles are NOT in a
# tiles/ directory of its own — hence --tiles, and hence this constant for --write-fixture.
SIM_TILES = os.path.join(ROOT, "sim", "tiles")

# The tile id's charset, which is ui_tile.c's id_ok() and nothing else: the id IS the last path
# segment of the URL the board fetches, so a character outside this set is a path that can climb
# out of the tile directory. One constant because there are two callers — the handler that serves
# a tile and the validator that looks for one — and two spellings of a path rule is one spelling
# that gets forgotten.
TILE_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,15}\Z")

# The masthead’s own date. Fixed rather than taken from the clock: the fixture
# is committed, and a payload whose dateline moved overnight would fail
# test_news_mock every morning for no reason.
DATELINE = "FRIDAY, AUGUST 14, 2026"

# ---------------------------------------------------------------------------
# THE DEMO EDITION: SANDISK CORP., 14 AUGUST 2026
#
# This is the page an unconfigured board prints, so it is written as a competent
# markets desk would write it rather than as filler. Every number below is
# derived from four inputs and nothing else, and the derivations are spelled out
# so that a later edit cannot quietly break one:
#
#   price   $1,631.47      shares  148,089,758
#   EPS     $72.89 (TTM)   BPS     $107.78
#
#   market cap = 148,089,758 x 1,631.47   = $241,603,997,484  -> "$241.6B"
#   P/E        = 1,631.47 / 72.89         = 22.383            -> "22.38x"
#   P/B        = 1,631.47 / 107.78        = 15.137            -> "15.14x"
#   equity     = 148,089,758 x 107.78     = $15,961M          -> "$15.96B"
#   TTM income = 148,089,758 x 72.89      = $10,794M          -> "$10.79B"
#   ROE        = 72.89 / 107.78           = 67.63%            -> "67.6%"
#   upside     = 1,993.25 / 1,631.47 - 1  = +22.18%
#   change     = 1,631.47 / 1,593.09 - 1  = +2.41%
#
# The one figure that could not be carried over from the owner’s source page is
# ROE. That page reported 39.3%, which belongs to an earlier period: against the
# EPS and BPS printed here the identity ROE = EPS / BPS gives 67.6%, and a
# dossier rail whose three numbers do not reconcile with each other is exactly
# the thing a reader checks first.
#
# The quarterly statement reconciles the same way, in $ millions:
#
#   operating income = gross profit - operating expenses
#   net income       = operating income x 0.92   (NOLs from the loss years hold
#                                                 the effective tax rate near 8%)
#   net margin       = net income / revenue, in basis points
#   diluted EPS      = net income / 148.089758
#   the last four net income columns sum to 10,794, which IS the TTM EPS above
#   the four quarterly EPS figures sum to 72.89, likewise
#
# REVENUE BY END MARKET sums to the same revenue row, and its last column is the
# 56.1 / 30.8 / 13.1 mix printed on the rail. The revenue bar chart is that
# total, and the price line’s last close is the price in the nameplate.
#
# BOTH TABLES ARE DRAWN RATHER THAN PRINTED, so each carries a numeric plane `n`
# beside its printed cells, and the two have to say the same thing. `v` is the
# house decision — "(370)" is a loss, "(22.1%)" is a negative margin — and `n` is
# what a bar can be scaled against. check_derivations() reads every string back
# and holds it against its integer, because a chart that contradicts the prose
# beside it is the one error nobody forgives.
#
# TWO of the three HERO figures carry a `bar`, a position 0..1000 inside a range
# that is itself somewhere else in this payload, so the picture can be checked
# against the numbers rather than taken on trust:
#
#   52-WEEK RANGE   1,631.47 in subject.wk52_low..wk52_high       -> 938
#   NET MARGIN TTM  46.74%   in the Net margin row's own min..max -> 855
#
# The third, MEAN TARGET, carries none. That is not an omission: a hero without a
# bar is the ordinary hero — a bigger number with its change beside it — and a
# target has no traded band to sit in. Both shapes are in the demo because both
# have to be drawn.
# ---------------------------------------------------------------------------

SHARES_OUT = 148_089_758

SUBJECT = {
    "symbol": "SNDK",
    "name": "Sandisk Corp.",
    "exchange": "NASDAQ",
    "sector": "Semiconductors",
    "last": 1631.47,
    "change_pct": 2.41,
    "prev_close": 1593.09,
    "open": 1598.20,
    "high": 1642.00,
    "low": 1590.55,
    "wk52_high": 1712.40,
    "wk52_low": 402.18,
}

# Twenty-six weekly closes, six months. The last is the price in the nameplate —
# a chart that disagrees with the number printed beside it is the first thing a
# reader catches — and the peak, 1,712.40, is the 52-week high in `subject`.
PRICE_6M = [
     978.40, 1002.15,  964.80, 1018.60, 1055.30, 1031.75, 1088.40, 1142.90,
    1118.25, 1176.50, 1234.80, 1205.60, 1268.35, 1322.70, 1291.45, 1358.90,
    1416.20, 1389.75, 1452.30, 1508.65, 1476.20, 1544.85, 1612.40, 1712.40,
    1658.90, 1631.47,
]

# Contract NAND, dollars a gigabyte, 2Q25 through 3Q26 — one quarter AHEAD of the
# statements, because a contract settles before the revenue it produces is reported.
#
# This is deliberately the one series the tables do NOT carry. A2 already draws
# revenue: tables[0] is a BARS_LINE whose first row IS the revenue series, so a
# revenue chart beside it would print the same six bars twice, about 400 px apart, and
# a reader would see it before anything else on the page. Contract price is what sits
# upstream of all of it — it is what the lead story is about, and nothing else plots it.
#
# The last step is +17.9%, which is the "18 percent" briefs[1] reports, and the last
# four are consecutive increases, which is its "fourth consecutive quarterly increase".
# check_derivations() holds the series to both, so the chart and the copy cannot drift.
CONTRACT_6Q = [2.10, 1.98, 2.24, 2.61, 3.02, 3.56]

# (symbol, name, last, change_pct, spark). `spark` is pre-normalised to 0..1000
# by the producer: the device has the 48x14 box but not the units, so this is
# the one piece of arithmetic the contract asks the server to do.
INDICES = [
    ("SPX",    "S&P 500",      6412.83,  0.62, [402, 418, 396, 430, 455, 441, 468, 502, 488, 521, 546, 574]),
    ("NDX",    "NASDAQ 100",  23841.55,  0.94, [388, 402, 380, 425, 448, 434, 470, 508, 492, 530, 561, 596]),
    ("SOX",    "PHLX SEMIS",   8214.60,  1.87, [244, 272, 258, 306, 348, 330, 392, 448, 430, 502, 566, 640]),
    ("UST10Y", "10-YR YIELD",     4.13, -0.72, [612, 640, 628, 597, 574, 588, 561, 540, 552, 519, 534, 508]),
    ("VIX",    "VIX",            13.84, -4.20, [744, 712, 758, 690, 651, 668, 612, 574, 590, 533, 501, 462]),
]

# Ordered by market value, largest first, with the subject in its own place in
# that order rather than pinned to the top: the point of the table is where the
# company sits among the others, and moving it to line one would answer the
# question the table is asking.
PEERS = [
    ("MU",    "Micron",         "11.62x", "$318.9B",  284.15,  2.87, False),
    ("SNDK",  "Sandisk",        "22.38x", "$241.6B", 1631.47,  2.41, True),
    ("HXSCL", "SK hynix ADR",    "9.24x", "$227.4B",  312.60,  3.18, False),
    ("INTC",  "Intel",          "62.50x", "$180.2B",   41.28, -0.74, False),
    ("ADI",   "Analog Devices", "38.41x", "$132.8B",  268.40,  0.62, False),
]

# (group, label, value, change_pct or None, emph, bar or None). The producer
# orders the list and the device does not sort: consecutive figures sharing a
# group are one unit on the sheet, so a dossier whose groups interleave prints a
# head twice, which is visible and therefore fixable.
#
# SIX GROUPS OF THREE TO FIVE, and that is a new obligation rather than a tidy
# accident. The dossier is laid out as grouped units beside each other, not as one
# tall rail down the side, and there a group of seven beside a group of one is a
# hole in the layout rather than a long section beside a short one. This file used
# to run 7 / 6 / 4 / 5 — legal under the old rail and badly formed under the new
# make-up — so VALUATION gave up its per-share lines, PROFITABILITY gave up the
# revenue mix, and both of those became groups a reader can name.
#
# THREE of the twenty-two are heroes, one each in three different groups, and each
# is the FIRST line of its group so the eye lands on it before the file behind it.
# Three is the whole editorial point of `emph`: twenty-two equal lines is a
# spreadsheet, and twenty-two emphasised lines is the same spreadsheet one size
# larger. Where the price sits in its own year, what the company keeps of what it
# sells, and what the street thinks it is worth are the three a reader across the
# room can use.
#
# Spread across groups on purpose rather than stacked at the top: a hero has to
# read as the head of its own group, and three in one group would make that group
# the dossier and the other five an afterthought.
#
# MEAN TARGET is the hero WITHOUT a bar, which is the default hero shape — a
# bigger number with its change beside it. A target is a forecast, and the high
# and low are opinions rather than a band the price has traded through, so there
# is no range to place it in honestly. `bar` is the exception, not the rule.
FIGURES = [
    ("VALUATION",     "52-WEEK RANGE",    "$402–$1,712",  None,  1,  938),
    ("VALUATION",     "MARKET CAP",       "$241.6B",      None,  0, None),
    ("VALUATION",     "P/E (TTM)",        "22.38x",       None,  0, None),
    ("VALUATION",     "PRICE/BOOK",       "15.14x",       None,  0, None),
    ("PER SHARE",     "EPS (TTM)",        "$72.89",       None,  0, None),
    ("PER SHARE",     "BOOK/SHARE",       "$107.78",      None,  0, None),
    ("PER SHARE",     "SHARES OUT",       "148.09M",      None,  0, None),
    ("PROFITABILITY", "NET MARGIN TTM",   "46.7%",        None,  1,  855),
    ("PROFITABILITY", "ROE",              "67.6%",        None,  0, None),
    ("PROFITABILITY", "NET INCOME TTM",   "$10.79B",      None,  0, None),
    ("REVENUE MIX",   "CLIENT",           "56.1%",        None,  0, None),
    ("REVENUE MIX",   "CONSUMER",         "30.8%",        None,  0, None),
    ("REVENUE MIX",   "CLOUD",            "13.1%",        None,  0, None),
    ("BALANCE SHEET", "DEBT/EQUITY",      "0.00%",        None,  0, None),
    ("BALANCE SHEET", "CURRENT RATIO",    "229.0%",       None,  0, None),
    ("BALANCE SHEET", "INTEREST COVER",   "68,516x",      None,  0, None),
    ("BALANCE SHEET", "DIVIDEND",         "NONE",         None,  0, None),
    ("THE STREET",    "MEAN TARGET",      "$1,993.25",    22.18, 1, None),
    ("THE STREET",    "CONSENSUS",        "BUY 22 OF 25", None,  0, None),
    ("THE STREET",    "TARGET RANGE",     "$750–$3,000",  None,  0, None),
    ("THE STREET",    "3Q26 EPS EST",     "$46.22",       None,  0, None),
    ("THE STREET",    "3Q26 REV EST",     "$10.60B",      None,  0, None),
]

# (date, kicker, text)
BRIEFS = [
    ("AUG 13", "GUIDANCE",
     "Management guided September-quarter revenue to $10.9 billion at the "
     "midpoint, above the $10.6 billion consensus going in."),
    ("AUG 12", "SUPPLY",
     "Contract NAND prices for the third quarter settled 18 percent above the "
     "second, the fourth consecutive quarterly increase."),
    ("AUG 11", "CAPACITY",
     "No new capacity has been announced by any of the six NAND makers since "
     "2024. Sandisk’s 2026 capital budget is maintenance only."),
    ("AUG 07", "THE STREET",
     "Sandisk is now sixth by market value among integrated semiconductor "
     "makers, one place behind Micron, at $241.6 billion."),
    ("JUL 30", "MANAGEMENT",
     "David V. Goeckeler told analysts the company would not commit to new "
     "wafer starts until contract pricing had held four quarters."),
    ("FEB 2025", "HISTORY",
     "Sandisk was spun out of Western Digital and listed on Nasdaq on "
     "February 24, 2025. Its 52-week low, $402.18, came that autumn."),
]

QUARTERS = ["1Q25", "2Q25", "3Q25", "4Q25", "1Q26", "2Q26"]

# (label, printed values, numeric plane). `v` is what is printed and `n` is what
# is drawn, and they are the same figures in the two forms each job needs. Both
# are written out as literals — rather than `n` being derived from `v` or the
# reverse — because they are the two things that have to agree, and a pair
# generated from one source cannot disagree and therefore cannot be checked.
# check_derivations() reads each string back and holds it against its integer.
#
# Two rows of bars and one line over them, which is the figure every annual report
# opens with. The LAST row is the line, and its `n` is BASIS POINTS while its `v`
# prints as a percentage: `note` names the unit of the bars, and a percentage has
# to be told apart from $ millions by something other than the note it does not
# share. The margin row is not independent data — it is net income over revenue,
# column by column — which is why 2Q26 is 58.5%, the number the earnings story
# prints, and why the two 2025 quarters are negative, which is the loss it
# compares against.
RESULTS_ROWS = [
    ("Revenue",    ["1,672",   "1,952",   "2,845", "4,190", "6,720", "9,340"],
                   [ 1672,      1952,      2845,    4190,    6720,    9340  ]),
    ("Net income", ["(370)",   "(226)",     "641", "1,535", "3,158", "5,460"],
                   [ -370,      -226,        641,    1535,    3158,    5460  ]),
    ("Net margin", ["(22.1%)", "(11.6%)", "22.5%", "36.6%", "47.0%", "58.5%"],
                   [-2213,     -1158,      2253,    3663,    4699,    5846  ]),
]

# Drawn as a composition: three end markets stacked into one column a quarter,
# where what matters is the mix and not the total. There is no Total row — a
# stacked bar's total is its height, and printing it as a fourth segment would
# draw the whole quarter twice at double the scale. The total is still checked,
# against the Revenue row above and against the revenue bar chart.
SEGMENT_ROWS = [
    ("Client",   ["1,037", "1,191", "1,707", "2,451", "3,830", "5,240"],
                 [ 1037,    1191,    1707,    2451,    3830,    5240  ]),
    ("Consumer", [  "560",   "644",   "925", "1,341", "2,117", "2,877"],
                 [  560,     644,     925,    1341,    2117,    2877  ]),
    ("Cloud",    [   "75",   "117",   "213",   "398",   "773", "1,223"],
                 [   75,     117,     213,     398,     773,    1223  ]),
]

# The rest of the income statement. It is no longer PRINTED — a bars-and-line
# table reads every row but the last as a bar, so a seven-row version would draw
# six series and mean nothing — but the earnings story quotes all of it, and a
# story that quotes a gross margin nothing checks is a story that will one day
# quote the wrong one. So the chain stays here and check_derivations() still holds
# it: gross profit less operating expenses is operating income, operating income
# after an eight percent effective rate is the net income printed above, and net
# income over the share count is the EPS the whole rail hangs on.
GROSS_PROFIT = [318, 468, 1403, 2399, 4211, 6777]
GROSS_MARGIN = [19.0, 24.0, 49.3, 57.3, 62.7, 72.6]     # percent
OPEX         = [688, 694, 706, 731, 778, 842]
OPERATING    = [-370, -226, 697, 1668, 3433, 5935]
DILUTED_EPS  = [-2.50, -1.53, 4.33, 10.37, 21.32, 36.87]

# The lead runs in up to four legs down most of a broadsheet and spends SIX
# CHARACTERS FOR EVERY PIXEL of that package's depth — four legs of 270 px, 33
# characters a line at body_16's measured prose advance, 22 px a line. The well
# is 1,338 px and the lead's own furniture takes about 600 of it, so filling the
# sheet on a day when nothing else arrives is about 4,400 characters of copy.
# This is 3,600: BODY_FLOOR's lead figure with the room a desk needs above it.
#
# It says one thing per sentence and does not restate the briefs beside it — a
# page whose lead and whose related-news column carry the same sentence twice is
# a page the reader stops trusting. That is why the September guide is in
# briefs[0] and NOT in the lead: it was in both, and one of them had to go.
LEAD_BODY = (
    "MILPITAS — Sandisk closed at $1,631.47, up 2.41 percent, after the last of "
    "the third-quarter NAND contract negotiations settled above where the spot "
    "market had been trading all summer. That is the wrong way round, and it is "
    "the whole point: contract buyers pay a premium for supply they can "
    "schedule, and this quarter they are paying it. Spot has lagged every "
    "settlement since the autumn, which is what a market looks like when the "
    "marginal buyer is no longer a distributor filling a warehouse but a "
    "hyperscaler filling a data centre eighteen months out. The distributors "
    "are still there. They are simply no longer the ones setting the price. "
    "The inversion is not a quirk of one negotiation. A distributor buys to "
    "resell inside a quarter and will wait a fortnight to save two cents a "
    "gigabyte, which is what has made spot the softer of the two prices in "
    "every ordinary year of this industry. A hyperscaler buys against a build "
    "schedule fixed long before the parts were quoted, and the cost of missing "
    "it is a hall of accelerators standing idle. With that buyer at the table "
    "the premium moves to whichever side of the market can promise delivery, "
    "and the spot tape stops being the leading indicator the trade has always "
    "read it as. "
    "No NAND maker has added a wafer of new capacity this year. The Yokkaichi "
    "joint venture, which Sandisk runs with Kioxia and which supplies most of "
    "its bits, is spending on layer count instead: the 232-layer node yields "
    "more gigabytes per wafer than the one it replaced, and stacking is the "
    "only supply growth the industry has left. Bit supply is therefore growing "
    "at the pace the existing fabs can be tuned to grow it, in single digits, "
    "against demand that is not. "
    "Layer count is also why the capacity question cannot be answered quickly. "
    "A new fab is three years and the better part of ten billion dollars, and "
    "it is qualified at a node two generations behind the one it was drawn "
    "for; a stacking upgrade to a line that is already running arrives in four "
    "quarters and carries none of that risk. Every maker in the industry has "
    "done the same arithmetic and reached the same answer, which is why the "
    "supply curve for 2027 is largely known already and why it does not bend. "
    "Demand has also changed shape. Cloud customers spent the year moving from "
    "quarterly purchase orders to multi-quarter agreements, and the company "
    "said in July that more than half of its cloud volume for fiscal 2027 is "
    "committed at a fixed price. Committed volume turns a cyclical business "
    "into a scheduled one for as long as the agreements run, and it removes "
    "the two quarters of price collapse that usually end a memory upcycle. It "
    "does not remove the cycle. It moves the turn out to whenever those "
    "agreements come up for renewal, and it makes the terms of that renewal "
    "the only date on the calendar worth marking. "
    "The mix underneath says the same thing from the other end. Cloud was 4.5 "
    "percent of revenue in the March quarter of 2025 and is 13.1 percent now, "
    "on a revenue base that has multiplied more than five times over the same "
    "span — a segment sixteen times the size it was six quarters ago, against "
    "a client business that is still 56.1 percent of the total and grew "
    "fivefold. A supplier whose fastest-growing customer signs eighteen-month "
    "contracts is a different business from one selling into a channel, and "
    "the multiple a market will pay for it is a different multiple. "
    "Eleven houses raised their targets on Thursday. The mean now stands at "
    "$1,993.25 against a high of $3,000 and a low of $750, and that spread is "
    "the whole argument: not what the company earns this quarter, but how many "
    "more quarters like it there are."
)

# The three secondaries are written to the same rule at their own measure: a
# story on three columns cuts into two legs of 269 px, three characters a pixel,
# and a package of about 500 px wants around 1,100. These run to 1,600, which is
# what "write it long" means when the compositor stretches the module to fit.
TAPE_BODY = (
    "The PHLX Semiconductor Index closed up 1.87 percent, its fourth "
    "consecutive weekly gain, and the move was almost entirely memory: Micron "
    "added 2.87 percent and SK hynix’s ADR 3.18. The logic names went nowhere, "
    "and Intel gave back 0.74 percent on no news of its own. Analog Devices, "
    "the other large analogue name in the group, managed 0.62 percent, which "
    "is what the broad market did — the S&P 500 closed up 0.62 percent and the "
    "Nasdaq 100 up 0.94. A tape that separates memory from the rest of the "
    "sector is a tape trading the price of a bit rather than the price of a "
    "design win. It has done that twice before in the past decade, in 2017 and "
    "again in 2021, and on both occasions the separation held until new "
    "capacity arrived to close it. "
    "What the multiples say is that the market does not believe it will hold "
    "this time either. Micron trades at 11.62 times earnings and SK hynix at "
    "9.24, both of them near the bottom of their own ten-year ranges, while "
    "the logic names they are outrunning carry 62.50 times and 38.41. A market "
    "convinced that memory earnings were durable would not price them at a "
    "third of the sector; it prices them there because it has watched four "
    "cycles end the same way. Sandisk’s own 22.38 times sits between the two "
    "camps, which is as close to an argument as a multiple ever gets. "
    "Nothing else in the session pointed the other way. The ten-year yield "
    "eased to 4.13 percent and the VIX closed at 13.84, down 4.20 percent and "
    "the lowest of the month. Volatility that low under a tape this narrow is "
    "not calm. It is a market that has stopped hedging the thing it is long."
)

EARNINGS_BODY = (
    "Sandisk earned $5.46 billion in the June quarter on revenue of $9.34 "
    "billion, a net margin of 58.5 percent against a loss in the same quarter "
    "of 2025. Gross margin reached 72.6 percent from 24.0, and operating "
    "expenses grew twenty-two percent over the same span. That is the whole "
    "arithmetic of the year: five and a half times the revenue on a cost base "
    "that grew by less than a quarter. None of it is a cost programme. It is "
    "price, and it will run the other way with the same leverage when the "
    "cycle turns. "
    "The turn itself is worth reading off the row. The company lost $370 "
    "million on $1.67 billion of revenue in the March quarter of 2025 and $226 "
    "million on $1.95 billion in the June quarter that followed; the first "
    "profit came in September, $641 million at a 22.5 percent margin, and "
    "every quarter since has been better than the one before it. Operating "
    "income for the June quarter was $5.94 billion against operating expenses "
    "of $842 million, and net income is that figure after an effective tax "
    "rate near eight percent, which is what is left of the loss years. Diluted "
    "earnings were $36.87 a share in the quarter and $72.89 over the trailing "
    "four, on 148.1 million shares. "
    "All three end markets grew, but not at one rate: client revenue was $5.24 "
    "billion, consumer $2.88 billion and cloud $1.22 billion, and only the "
    "last of those is growing faster than the price of the parts. That is why "
    "a balance sheet carrying no debt at all, at a current ratio of 229 "
    "percent, is the line worth reading next. A company with no interest to "
    "cover does not have to sell into a falling market to make a payment."
)

STREET_BODY = (
    "Twenty-two of the twenty-five analysts covering Sandisk rate it a buy, "
    "and the mean twelve-month target of $1,993.25 sits 22.2 percent above "
    "Thursday’s close. The dispersion is the story: the high target is $3,000 "
    "and the low $750, a spread of four to one, which is what an argument "
    "about the length of a cycle looks like written down. The bulls are "
    "pricing the multi-quarter agreements as a floor under 2027 earnings. The "
    "bears are pricing the four previous NAND cycles, each of which ended with "
    "a year of falling prices against a cost base built for the peak. Neither "
    "side disputes the June quarter. They dispute what follows it. "
    "The two targets are not two views of the same multiple. The mean is 27.3 "
    "times the $72.89 the company earned over the trailing four quarters, "
    "which sounds expensive until it is set against the $46.22 the same "
    "analysts expect for the September quarter alone: annualise that and the "
    "mean is 10.8 times, and the high target is 16.2. The low target of $750 "
    "is not a forecast of this year at all. It is 6.96 times book value, which "
    "is roughly where the shares traded in the loss quarters, and it prices a "
    "return to them. "
    "The estimates themselves are the aggressive part of the file. Consensus "
    "has September revenue at $10.60 billion and earnings at $46.22 a share, "
    "which on 148.1 million shares is a net margin of 64.6 percent — six "
    "points above the June quarter and the highest any NAND maker has "
    "reported. Every analyst on that list is therefore forecasting that "
    "contract prices rise again before they fall, and none of them is "
    "forecasting the fourth quarter."
)


def charts():
    """The two series the modules name by index.

    A chart sends `close` alone, or `close` with `open`/`high`/`low` beside it.
    Both of these are the flat form; the device fills the other three arrays
    from the close so that a consumer reaching for `high` out of a line series
    gets a zero-height bar rather than one spanning the whole scale.
    """
    return [
        {"kind": "line", "label": "PRICE", "span": "6M",
         "note": "Weekly close, in dollars", "close": list(PRICE_6M)},
        {"kind": "bar", "label": "NAND CONTRACT", "span": "6Q",
         "note": "Contract price per gigabyte, dollars", "close": list(CONTRACT_6Q)},
    ]


def stories():
    """Four stories, the lead first.

    `rank` is the only thing the server says about geometry — 0 is the lead —
    and `chart` is an index into charts() or absent. The device decides what
    fits; only the device has the font metrics, and only the agent has the
    research.
    """
    return [
        {
            "rank": 0,
            "kicker": "NAND PRICING",
            "headline": "Sandisk clears $1,600 as NAND contract prices reset again",
            "deck": "Third-quarter contract talks settled above spot, and the "
                    "sell-side spent the session moving its targets up.",
            "byline": "By CLAUDE · SEMICONDUCTOR DESK",
            "body": LEAD_BODY,
            # The contract series, not the share price: this story's headline is about
            # what NAND settled at, and that is the picture it should carry.
            "chart": 1,
            # 1140 x 320: the full six-column measure, which is what
            # tools/demo_photos.py packs into sim/tiles/sndk_fab.bin. The
            # dimensions here ARE the byte count of that file — the device
            # fetches w*h/2 raw bytes — so the two cannot be chosen separately.
            "photo": {"id": "sndk_fab", "w": 1140, "h": 320,
                      "caption": "The Yokkaichi joint-venture fab, where the bit supply is not growing.",
                      "credit": "DEMO IMAGE"},
        },
        {
            "rank": 1,
            "kicker": "THE TAPE",
            "headline": "Memory leads the semis higher for a fourth week",
            "deck": "The PHLX index is up 1.87 percent; Micron rose with it.",
            "byline": "By CLAUDE · MARKETS DESK",
            "body": TAPE_BODY,
        },
        {
            "rank": 2,
            "kicker": "EARNINGS",
            "headline": "Revenue nearly doubles again in the June quarter",
            "deck": "Net income was $5.46 billion on revenue of $9.34 billion.",
            "byline": "By CLAUDE · EARNINGS DESK",
            "body": EARNINGS_BODY,
            # No chart, and deliberately: this story is about revenue and margin, and
            # REVENUE, PROFIT AND MARGIN on A2 draws exactly that. Charting it here
            # would put the same bars on the sheet twice. The table is its picture.
        },
        {
            "rank": 3,
            "kicker": "THE STREET",
            "headline": "Targets move up; three houses still say hold",
            "deck": "The mean target implies 22 percent more upside.",
            "byline": "By CLAUDE · THE STREET",
            "body": STREET_BODY,
            # The six-month price line belongs here rather than on the lead: this is
            # the story that argues about where the price goes next, and the target it
            # quotes only means something against where the price has been.
            "chart": 0,
        },
    ]


def figure(row):
    group, label, value, change_pct, emph, bar = row
    f = {"group": group, "label": label, "value": value}
    # Present only when there IS one. Absent is not zero: zero is a real change
    # and prints as a flat mark, where most of these figures carry no mark at
    # all, and colour on this sheet is data rather than decoration.
    if change_pct is not None:
        f["change_pct"] = change_pct
    # The same rule for the two new keys, and it matters more here. Absent `emph`
    # is the small tier and absent `bar` is no bar — not a bar of length zero,
    # which is a real position, the bottom of the range. Nineteen `"emph": 0`
    # keys would also claim the producer had decided which figures matter when it
    # had only filled a struct.
    if emph:
        f["emph"] = emph
    if bar is not None:
        f["bar"] = bar
    return f


def table(title, note, render, rows):
    # Columns run OLDEST FIRST, which is how a financial statement is set and
    # the opposite of how a news feed arrives. The device does not reorder — a
    # table whose quarters run backwards prints backwards.
    #
    # `n` travels beside `values`, per row, rather than as one 2-D array on the
    # table. That is not cosmetic: news_parse() drops a row object that carries
    # neither a label nor any numbers, so a table-level plane would silently
    # misalign with the rows that survived — every bar filed under the wrong
    # quarter. A row cannot come apart from its own numbers.
    return {
        "title": title,
        "note": note,
        "render": render,
        "columns": list(QUARTERS),
        "rows": [{"label": label, "values": list(values), "n": list(nums)}
                 for label, values, nums in rows],
    }


def quote(row):
    symbol, name, last, change_pct, spark = row
    return {"symbol": symbol, "name": name, "last": last,
            "change_pct": change_pct, "spark": list(spark)}


def peer(row):
    symbol, name, per, cap, last, change_pct, is_subject = row
    return {"symbol": symbol, "name": name, "per": per, "cap": cap,
            "last": last, "change_pct": change_pct, "is_subject": is_subject}


def brief(row):
    date, kicker, text = row
    return {"date": date, "kicker": kicker, "text": text}


def snapshot(generated_at="2026-08-14T05:12:00Z", as_of="AS OF 05:12 KST"):
    """The canonical payload. Must stay identical to news_mock.c."""
    return {
        "schema": 3,
        "edition": "SEMICONDUCTORS",
        "dateline": DATELINE,
        "session": "U.S. MARKETS CLOSED — AUG 13",
        "as_of": as_of,
        "generated_at": generated_at,
        "subject": dict(SUBJECT),
        "stories": stories(),
        "figures": [figure(r) for r in FIGURES],
        "briefs": [brief(r) for r in BRIEFS],
        "peers": [peer(r) for r in PEERS],
        "tables": [
            table("REVENUE, PROFIT AND MARGIN", "$ millions", "bars_line",
                  RESULTS_ROWS),
            table("REVENUE BY END MARKET", "$ millions", "stack", SEGMENT_ROWS),
        ],
        "charts": charts(),
        "indices": [quote(r) for r in INDICES],
        "thumbs": [
            {"id": "sndk_wafer", "w": 364, "h": 204,
             "caption": "A 232-layer wafer at Yokkaichi. Output per wafer is the constraint.",
             "credit": "DEMO IMAGE"},
            {"id": "sndk_line", "w": 364, "h": 204,
             "caption": "The Milpitas test floor, running three shifts since February.",
             "credit": "DEMO IMAGE"},
        ],
    }


def live_snapshot(state, now):
    """The canonical payload with the prices nudged, for --live.

    Exists to exercise the one behaviour a static payload cannot: the device
    only refreshes the panel when the content actually changed, and a refresh
    here is twenty-five seconds of flashing. Watching this drift is how you
    confirm the board is polling AND that an unchanged poll stays silent.

    The subject’s price and the last close of the price chart move together,
    because they are the same number printed twice and a reader catches that
    disagreement before any other.
    """
    s = snapshot(generated_at=now.strftime("%Y-%m-%dT%H:%M:%SZ"),
                 as_of=now.strftime("AS OF %H:%M LOCAL"))
    state["tick"] += 1

    drift = random.randint(-40, 40) / 100.0
    subj = s["subject"]
    subj["change_pct"] = round(subj["change_pct"] + drift, 2)
    subj["last"] = round(subj["last"] * (1.0 + drift / 100.0), 2)
    s["charts"][0]["close"][-1] = subj["last"]
    for p in s["peers"]:
        if p["is_subject"]:
            p["last"] = subj["last"]
            p["change_pct"] = subj["change_pct"]

    for q in s["indices"]:
        d = random.randint(-40, 40) / 100.0
        q["change_pct"] = round(q["change_pct"] + d, 2)
        q["last"] = round(q["last"] * (1.0 + d / 100.0), 2)
    return s


def _cell(s):
    """One printed cell back to the number it was set from: "1,672" -> 1672,
    "(370)" -> -370, "72.6%" -> 72.6, "(22.1%)" -> -22.1. Accounting parentheses,
    thousands commas and a trailing percent are the three house conventions in the
    tables, and a negative percentage carries all three at once."""
    s = s.strip().replace(",", "")
    neg = s.startswith("(") and s.endswith(")")
    if neg:
        s = s[1:-1]
    v = float(s.rstrip("%"))
    return -v if neg else v


def _row(rows, label):
    """The PRINTED values of one row, as numbers."""
    return [_cell(v) for name, values, _ in rows if name == label
            for v in values][:len(QUARTERS)]


def _plane(rows, label):
    """The DRAWN values of one row — the integers a bar is scaled against."""
    return [n for name, _, nums in rows if name == label
            for n in nums][:len(QUARTERS)]


def check_derivations():
    """Hold the demo edition against its own arithmetic.

    Every printed figure in this file is derived from four inputs — the price,
    the share count, EPS and BPS — and from the two statements. A demo front
    page with a P/E that does not match its own EPS and price is exactly the
    kind of thing a reader checks first, and it would go unnoticed here for
    months: the fixture and news_mock.c would agree with each other perfectly
    while both being wrong.

    So this runs on every --dump, --check and --write-fixture. It does NOT run
    in the request handler; a served page that raised would take the server down
    over a rounding difference. Raises AssertionError naming the figure.
    """
    def near(got, want, tol, what):
        assert abs(got - want) <= tol, f"{what}: {got:.4f} vs {want:.4f}"

    last, eps, bps = SUBJECT["last"], 72.89, 107.78

    near(SHARES_OUT * last / 1e9, 241.6, 0.05, "market cap $241.6B")
    near(last / eps, 22.38, 0.005, "P/E 22.38x")
    near(last / bps, 15.14, 0.005, "P/B 15.14x")
    near(100.0 * eps / bps, 67.6, 0.05, "return on equity 67.6%")
    near(100.0 * (last / SUBJECT["prev_close"] - 1.0), SUBJECT["change_pct"], 0.005,
         "change against the previous close")
    near(100.0 * (1993.25 / last - 1.0), 22.18, 0.005, "mean target upside")

    revenue = _row(RESULTS_ROWS, "Revenue")
    net     = _row(RESULTS_ROWS, "Net income")
    margin  = _row(RESULTS_ROWS, "Net margin")

    # THE TWO PLANES SAY THE SAME THING. `v` is printed and `n` is drawn, and a
    # bar whose height disagrees with the number set under it is the one error
    # nobody forgives — it is also the only error in this file that survives
    # every other check, because both halves are internally consistent.
    #
    # The tolerance is where the two units differ. A $ millions cell prints the
    # whole number, so it must be exact. The margin row prints one decimal place
    # and draws basis points, so "58.5%" against 5846 is a rounding of the same
    # figure and is held to half a printed digit.
    for label in ("Revenue", "Net income"):
        for i, (printed, drawn) in enumerate(zip(_row(RESULTS_ROWS, label),
                                                 _plane(RESULTS_ROWS, label))):
            near(drawn, printed, 0, f"{QUARTERS[i]} {label}: n against v")
    for i, (printed, drawn) in enumerate(zip(margin, _plane(RESULTS_ROWS, "Net margin"))):
        near(drawn / 100.0, printed, 0.05,
             f"{QUARTERS[i]} net margin: {drawn} bp against the printed {printed}%")
    for label in ("Client", "Consumer", "Cloud"):
        for i, (printed, drawn) in enumerate(zip(_row(SEGMENT_ROWS, label),
                                                 _plane(SEGMENT_ROWS, label))):
            near(drawn, printed, 0, f"{QUARTERS[i]} {label}: n against v")

    # The margin row is net income over revenue and nothing else, to the basis
    # point. This is what makes the line over the bars a fact about the bars
    # rather than a fourth series that happens to sit near them.
    for i, q in enumerate(QUARTERS):
        near(_plane(RESULTS_ROWS, "Net margin")[i],
             round(10000.0 * net[i] / revenue[i]), 0.5, f"{q} net margin in bp")

    # The chain the drawn table no longer prints, but the earnings story quotes.
    for i, q in enumerate(QUARTERS):
        near(GROSS_PROFIT[i] - OPEX[i], OPERATING[i], 0.5, f"{q} operating income")
        near(100.0 * GROSS_PROFIT[i] / revenue[i], GROSS_MARGIN[i], 0.05,
             f"{q} gross margin")
        near(net[i] / (SHARES_OUT / 1e6), DILUTED_EPS[i], 0.005, f"{q} diluted EPS")
        if OPERATING[i] > 0:                   # the loss quarters carry no tax
            near(OPERATING[i] * 0.92, net[i], 0.5, f"{q} net income after tax")
    near(100.0 * (OPEX[-1] / OPEX[0] - 1.0), 22.0, 0.5,
         "the operating-expense growth the earnings story prints")

    ttm_net, ttm_rev = sum(net[2:]), sum(revenue[2:])
    near(ttm_net / (SHARES_OUT / 1e6), eps, 0.005, "TTM EPS from the statement")
    near(sum(DILUTED_EPS[2:]), eps, 0.005, "TTM EPS as the four quarters")
    near(ttm_net / 1e3, 10.79, 0.005, "TTM net income $10.79B")
    near(100.0 * ttm_net / ttm_rev, 46.7, 0.05, "TTM net margin 46.7%")
    near(SHARES_OUT * bps / 1e9, 15.96, 0.005, "book equity $15.96B")

    # No Total row to check against any more: a stacked bar's total IS its height.
    # The three segments are held against the revenue row and the revenue chart
    # directly, which is what the Total row was standing in for.
    for i, q in enumerate(QUARTERS):
        parts = sum(_row(SEGMENT_ROWS, name)[i] for name in ("Client", "Consumer", "Cloud"))
        near(parts, revenue[i], 0.5, f"{q} end markets sum to the revenue row")
    assert not any(name == "Total" for name, _, _ in SEGMENT_ROWS), \
        "a stacked bar's total is its height; a Total row would draw the quarter twice"

    for name, want in (("Client", 56.1), ("Consumer", 30.8), ("Cloud", 13.1)):
        near(100.0 * _row(SEGMENT_ROWS, name)[-1] / revenue[-1], want, 0.05,
             f"REVENUE MIX / {name.upper()}")

    # THE DOSSIER'S GROUPS ARE UNITS OF LAYOUT and therefore have to be about the
    # same size: a group of seven beside a group of one is a hole in the make-up,
    # where on the old rail it was only a long section beside a short one. Three
    # to five each, and the largest no more than twice the smallest. --validate
    # warns on both; the demo edition is asserted, because it is the payload
    # every other producer is told to imitate.
    sizes, order = {}, []
    for row in FIGURES:
        if row[0] not in sizes:
            order.append(row[0])
            sizes[row[0]] = 0
        sizes[row[0]] += 1
    for g in order:
        assert 3 <= sizes[g] <= 5, \
            f"group {g!r} carries {sizes[g]} figures; a group is three to five"
    assert max(sizes.values()) <= 2 * min(sizes.values()), \
        (f"the groups run {min(sizes.values())} to {max(sizes.values())} — more "
         f"than a factor of two apart, and they will not line up")

    # THE CONTRACT SERIES against the prose that reports it. briefs[1] says the third
    # quarter settled "18 percent above the second", the "fourth consecutive quarterly
    # increase" — so the chart has to show four rises and the last of them has to be
    # that number. A bar chart contradicting the sentence beside it is the same class of
    # error as a price chart contradicting the price, and just as easy to make.
    steps = [CONTRACT_6Q[i] / CONTRACT_6Q[i - 1] - 1.0 for i in range(1, len(CONTRACT_6Q))]
    rises = 0
    for step in reversed(steps):
        if step <= 0:
            break
        rises += 1
    assert rises == 4, f"{rises} consecutive quarterly increases; briefs[1] claims four"
    near(100.0 * steps[-1], 18.0, 0.15, "the last contract settlement against briefs[1]")

    # And the rule the duplication came from: no chart may plot a series a DRAWN table
    # already carries. The device would draw both, about 400 px apart on the same sheet,
    # and a reader would see it before anything else. Read off the payload rather than
    # off these constants, so it still holds when somebody adds a third table.
    payload = snapshot()
    drawn = {tuple(r["n"]) for t in payload["tables"] if t["render"] != "print"
             for r in t["rows"] if r.get("n")}
    for i, c in enumerate(payload["charts"]):
        assert tuple(int(round(v)) for v in c["close"]) not in drawn, \
            f"charts[{i}] ({c['label']}) plots a series a drawn table already carries"

    near(PRICE_6M[-1], last, 0.005, "the price chart's last close")
    near(max(PRICE_6M), SUBJECT["wk52_high"], 0.005, "the price chart's peak against wk52_high")
    assert min(PRICE_6M) > SUBJECT["wk52_low"], "the price chart dips under the 52-week low"
    assert SUBJECT["low"] <= last <= SUBJECT["high"], "the last is outside the session's range"

    # THE HERO BARS. Each is a position inside a range that is itself in this
    # payload, so the picture can be checked against the numbers beside it. A bar
    # is the one thing on the rail a reader cannot verify by looking at it, which
    # is exactly why it gets checked here.
    def bar_of(label):
        return next(row[5] for row in FIGURES if row[1] == label)

    def where(v, lo, hi):
        return round(1000.0 * (v - lo) / (hi - lo))

    near(bar_of("52-WEEK RANGE"),
         where(last, SUBJECT["wk52_low"], SUBJECT["wk52_high"]), 0.5,
         "the 52-WEEK RANGE bar inside the 52-week range")

    # The margin bar sits inside the band the statement itself prints, so the
    # graphic on the rail and the line over the bars on A2 are the same fact.
    margin_bp = next(nums for label, _, nums in RESULTS_ROWS if label == "Net margin")
    near(bar_of("NET MARGIN TTM"),
         where(10000.0 * ttm_net / ttm_rev, min(margin_bp), max(margin_bp)), 0.5,
         "the NET MARGIN bar inside the band the statement prints")

    # A bar belongs to a hero and ONLY to a hero: one on a small line is a track
    # drawn across a rail column with nothing beside it to read.
    #
    # The reverse does NOT hold, and that is the correction. `bar` turns a hero
    # into a graphic INSTEAD of a bigger number, so a hero without one is the
    # ordinary hero rather than an incomplete one. Requiring every hero to carry a
    # bar would leave that shape — the one most heroes will actually use — drawn
    # by nobody and tested by nothing.
    heroes = [row for row in FIGURES if row[4]]
    assert 2 <= len(heroes) <= 4, f"{len(heroes)} heroes; the rail wants two to four"
    for group, label, _, _, emph, bar in FIGURES:
        assert bar is None or emph, \
            f"{label}: a bar on a quiet line — a bar belongs to a hero"
        if bar is not None:
            assert 0 <= bar <= 1000, f"{label}: bar {bar} is outside 0..1000"

    # Both hero shapes and more than one group, because the renderer has to draw
    # all of it and only the demo edition ever exercises it.
    assert any(row[5] is None for row in heroes), \
        "every hero carries a bar — the plain hero shape would go undrawn"
    assert any(row[5] is not None for row in heroes), \
        "no hero carries a bar — the graphic hero shape would go undrawn"
    assert len({row[0] for row in heroes}) >= 3, \
        "the heroes share a group — spread them, or the treatment is only ever seen in one"


def dumps(payload):
    """The fixture’s exact bytes. One function so --write-fixture and --check
    cannot disagree about indentation and report a diff that is not one."""
    check_derivations()
    return json.dumps(payload, ensure_ascii=False, indent=2) + "\n"


def check_fixture():
    """Recompute the payload and hold the committed fixture against it.

    Not a formality: the fixture is what test_news_mock.c parses, so a hand
    edit to it would silently redefine the contract the C demo snapshot is
    pinned to. Returns a process exit code.
    """
    want = dumps(snapshot())
    try:
        with open(FIXTURE, encoding="utf-8") as f:
            got = f.read()
    except OSError as e:
        print(f"cannot read {FIXTURE}: {e}", file=sys.stderr)
        return 1

    if got == want:
        print(f"fixture matches ({len(want)} bytes): {FIXTURE}")
        return 0

    print(f"fixture DIVERGES from tools/mock_news_server.py: {FIXTURE}",
          file=sys.stderr)
    try:
        got_obj = json.loads(got)
    except ValueError as e:
        print(f"  and it is not even valid JSON: {e}", file=sys.stderr)
        print("  run: python3 tools/mock_news_server.py --write-fixture",
              file=sys.stderr)
        return 1

    want_obj = json.loads(want)
    if got_obj == want_obj:
        print("  same content, different formatting", file=sys.stderr)
    else:
        for key in sorted(set(got_obj) | set(want_obj)):
            if got_obj.get(key) != want_obj.get(key):
                print(f"  key differs: {key}", file=sys.stderr)
    print("  run: python3 tools/mock_news_server.py --write-fixture",
          file=sys.stderr)
    return 1


class Handler(BaseHTTPRequestHandler):
    live = False
    state = {"tick": 0}

    # Announcing keep-alive over HTTP/1.0 is not merely untidy, it is a
    # contradiction the client resolves the other way: RFC 1945 says a 1.0
    # connection closes after one response, so the board is entitled to hang up
    # while this server sits waiting for a second request. Say 1.1, which is
    # what the header means, and which every response here can honour because
    # every one of them sets Content-Length.
    protocol_version = "HTTP/1.1"

    # And reap the socket when the board goes quiet. A device that polls every
    # five minutes is idle for four minutes fifty-nine, and a board that resets
    # mid-poll — flashing, a brownout, a pulled cable — leaves a socket that is
    # open, silent and never coming back. Without this the handler blocks in
    # readline() on it forever.
    timeout = 30

    # --no-etag turns the conditional GET off. A board pointed at a server with
    # no support for one is a SUPPORTED configuration and not a degraded one:
    # it fetches and parses the whole payload every poll, and news_hash() still
    # keeps the panel still. What it costs is a parse, not a refresh. Being able
    # to switch it off here is how that path gets exercised on purpose, rather
    # than the first time somebody points a board at a static file host.
    etag_enabled = True

    # The tag is computed from the payload OBJECT and never from the bytes about
    # to be written. ensure_ascii, key order and separators are FORMATTING: they
    # move the bytes on the wire without moving one pixel of the sheet. A tag
    # derived from them would change the day somebody reformats this file, every
    # deployed board would be told its edition had changed, and each one would
    # answer that with a twenty-five second refresh of the whole panel. Spending
    # a panel refresh on a json.dumps() flag is the exact failure the ETag is
    # here to prevent, so sort_keys canonicalises the order and the hash is
    # taken over the result.
    #
    # sha256 truncated to sixteen hex digits: the device treats the tag as an
    # opaque string, so this is a change detector and not a security boundary,
    # and sixty-four bits is a collision every few billion editions. The digest
    # is sha256 because `server/claudepost/http.py`'s `_etag()` is, and there is
    # one recipe rather than two — a board must not be able to tell the desk and
    # the reference producer apart by the shape of a tag.
    #
    # The two share the RECIPE and not the INPUT, which is the part worth
    # saying: the desk hashes the exact bytes it is about to write, policy block
    # spliced in, so its tag moves at a schedule transition. This server hashes
    # the canonical dump of the snapshot it made up, which carries no policy at
    # all. Same shape, same digest, different question — and neither tag is ever
    # compared against the other's.
    #
    # NOTE this is deliberately NOT news_hash(). That one fingerprints the
    # parsed model — what reaches the glass — and remains the sole authority on
    # whether the panel moves. This one fingerprints the document. They disagree
    # exactly when a producer changes a field the sheet does not render, and on
    # that poll the right answer is 200, a parse, and a panel that stays still.
    @staticmethod
    def etag_for(payload):
        canonical = json.dumps(payload, sort_keys=True,
                               ensure_ascii=False).encode("utf-8")
        return '"' + hashlib.sha256(canonical).hexdigest()[:16] + '"'

    def do_GET(self):
        path = self.path.split("?")[0]

        # The tiles, from beside the snapshot — which is the contract:
        #   GET <the news URL's directory>/tiles/<id>.bin
        # This used to 404, so a board pointed at this server drew the whole
        # edition except its photographs, and did it silently, because a missing
        # tile is an ordinary front-page condition rather than an error. The
        # reference PRODUCER has to be able to serve what its own payload names.
        if path.startswith("/tiles/") and path.endswith(".bin"):
            tile_id = path[len("/tiles/"):-len(".bin")]
            # The tile layer's own id rule, enforced before the join so a path
            # can never climb out of the tile directory. Through TILE_ID_RE
            # rather than str.isalnum(), which answers True for a letter in any
            # alphabet and so allowed ids the firmware's id_ok() refuses.
            if not TILE_ID_RE.match(tile_id):
                self.send_error(404)
                return
            blob = os.path.join(SIM_TILES, tile_id + ".bin")
            try:
                with open(blob, "rb") as f:
                    data = f.read()
            except OSError:
                self.send_error(404)
                return
            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Connection", "keep-alive")
            self.end_headers()
            self.wfile.write(data)
            return

        if path not in ("/news.json", "/"):
            self.send_error(404)
            return
        import datetime
        # Without --live this serves the canonical payload verbatim, so a board
        # or simulator pointed here shows exactly the page news_mock.c draws.
        # That equivalence is the point of the file; --live is the exception.
        payload = (live_snapshot(self.state, datetime.datetime.now()) if self.live
                   else snapshot())

        etag = self.etag_for(payload) if self.etag_enabled else None
        if etag is not None and etag in self._requested_tags():
            # A 304 carries no body — RFC 7232 forbids one — and this says so
            # with Content-Length: 0. That is a deliberate reading of RFC 7230,
            # which asks for either no Content-Length at all or the length the
            # 200 would have carried. The second of those is a trap on a
            # keep-alive connection: a client that frames the response from the
            # header, which esp_http_client does, would sit waiting for twenty
            # kilobytes it is not allowed to be sent, once per poll, until its
            # own timeout fires. Zero is the only framing nothing can wait on.
            self.send_response(304)
            self.send_header("ETag", etag)
            self.send_header("Content-Length", "0")
            self.send_header("Connection", "keep-alive")
            self.end_headers()
            return

        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        if etag is not None:
            self.send_header("ETag", etag)
        # The device polls one host repeatedly; letting it keep the socket saves
        # a connect per poll and, on an https:// URL, a whole TLS handshake.
        self.send_header("Connection", "keep-alive")
        self.end_headers()
        self.wfile.write(body)

    def _requested_tags(self):
        """The tags in If-None-Match, as a list.

        The board sends exactly one, because it stores exactly one. Splitting on
        the comma anyway costs a line and covers the case where something else
        is in the path — a browser, a proxy, curl with a saved tag — since the
        header is a list by definition and a server that string-compares the
        whole field answers 200 to a perfectly good conditional request. `*` is
        not handled, and falls through to a full 200, which is always a correct
        answer and merely a wasteful one.

        Capped before the split, for the reason server/claudepost/http.py's
        `_if_none_match()` caps: splitting a header the transport will happily
        make megabytes long builds a list of millions of strings, and this
        server is the one people point at a board on their own LAN. `.get()`
        returns one line rather than all of them, so the ceiling here is 64 KB
        rather than 6 MB — two orders of magnitude smaller and still no reason
        to do it. Past the cap the answer is a full 200, which is what an
        unrecognised tag gets anyway.
        """
        header = self.headers.get("If-None-Match", "")
        if len(header) > 4096:
            return []
        return [t.strip() for t in header.split(",") if t.strip()]

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))


# --- validating somebody else’s edition ------------------------------------
#
# This file is the reference PRODUCER, so it is also the only place that knows the contract well
# enough to say whether an arbitrary payload satisfies it. The scheduled agent in agent/standalone/
# calls this before it files: a page that the firmware would reject is a wasted cycle, and the
# failure would show up hours later as a STALE badge with nothing to explain it.
#
# The checks are the ones the device actually makes, plus the length budget from
# tools/edition/PROMPT.md, which the device cannot check because it ellipsizes rather than failing.
#
# TWO LIMITS SIT BEHIND EVERY FIELD AND THEY FAIL DIFFERENTLY
# -----------------------------------------------------------
# The CHARACTER budget is PROMPT.md's, and it is what --validate fails on. It is counted in
# characters because an em dash is one character of measure — failing a headline for being three
# bytes over when it sets perfectly well would be worse than not checking at all.
#
# The BYTE capacity is the fixed C array in components/news_core/include/news_model.h. Every budget
# sits inside its array, so this should essentially never fire for ASCII; when it does fire it is
# because the payload carries typography, which is exactly the case where the character count looks
# fine and the field runs out.
#
# WHAT a field does when it overruns is what decides how far inside its array the budget sits. A
# field the panel ELLIPSIZES tells the reader something went wrong: there is a `…` where the
# sentence should be. A field it CUTS does not — news_str_copy() trims on a character boundary and
# the value simply stops, and a market capitalisation reading "$226.3" because the "B" did not fit
# is worse than one that is obviously truncated. The cut ones are held further in for that reason,
# and they say so when they fail.
#
# Both limits are checked, and each string gets the one message it deserves.

# The ellipsized fields, per tier. The cut ones are the constants below, which have no tiers.
BUDGET = {
    # field                 lead   secondary
    "headline":            (  72,   54),
    "deck":                ( 118,   58),
    "caption":             (  72,   72),
}

# The six PROMPT.md holds INSIDE their arrays, because these fields are CUT rather than ellipsized
# when they overrun and there is nothing on the sheet to notice — a market capitalisation reading
# "$226.3" because the "B" did not fit is worse than one that is obviously truncated.
#
# All six WARN. A failure here would mean the board keeps yesterday's page, and this project leans
# the other way at every other decision point: news_parse() clamps rather than rejects, a rejected
# payload keeps the previous snapshot, a stale page badged STALE beats an empty one. Refusing an
# edition that typesets correctly, because one figure label is a character outside a house-style
# margin, is that principle inverted for a cosmetic reason.
#
# They are also margins in fact and not only in name: a figure a character or two over one still
# typesets. What they are held inside is stated below; how much air that leaves in pixels is NOT
# stated here, deliberately. The dossier renders at more than one measure — one column as the
# standing rail, several as the page's lead on a day with no stories, and the value face changes
# with it — so any single characters-per-column figure would be true of one of those and quietly
# false of the other. `sim --measure` is the authority; this file does not get to keep its own copy.
KICKER_BUDGET  =  20
BRIEF_BUDGET   = 132
GROUP_BUDGET   =  16
LABEL_BUDGET   =  16
VALUE_BUDGET   =  14
COLUMN_BUDGET  =  10
CELL_BUDGET    =  12

# Why the five are held inside their arrays: room for the em dash or the curly quote that turns a
# legal string into a three-bytes-a-character one, in fields where running out is invisible.
TYPOGRAPHY = ("this field is cut silently rather than ellipsized when it overruns, so its budget is "
              "held inside the array to leave room for typography")

# Why the sixth is: a cell is tighter than twelve characters when the day's make-up gives the table
# three columns instead of six, and the compositor decides that at layout time — so twelve is what
# SURVIVES a narrow table rather than a number anybody can state in advance.
MAKEUP = ("the make-up desk can give this table three columns instead of six, and that is what "
          "this budget survives")

# PROMPT.md asks for 1,400–2,200 and 400–650. Only the floor is enforced: a body that runs SHORT
# leaves white paper in the column, which is the one thing the owner asked not to see, while a long
# one is cut at a word boundary by ui_fit_text() and costs nothing but copy nobody reads.
#
# The floors went up with the compositor. A lead now runs in up to four legs down a package that can
# be most of the sheet, and four legs of thirty-three characters over 600 px of depth is about two
# thousand characters of copy. The old 600 was sized for a story that sat in a fixed band; against an
# elastic module it is a third of a column of prose and two thirds of a column of white paper.
BODY_FLOOR = {"lead": 1400, "secondary": 400}

# Everything the bundled faces can draw: ASCII, Latin-1, and the typography in ui_strings.h’s
# S_DATA_PUNCT. A character outside this is a tofu box on the glass.
DATA_PUNCT = "—–‐…“”‘’‚„•·′″‹›«»⁄×÷±≈≠≤≥°‰№€£¥¢§¶©®™†‡"


def _drawable(s):
    return [c for c in s
            if not (0x20 <= ord(c) <= 0x7E or 0xA0 <= ord(c) <= 0xFF or c in DATA_PUNCT)]


def _walk_strings(node, path, out):
    """Every string in the payload, with the path that reaches it.

    Recursive rather than a list of the keys that happen to hold text today: a
    producer that adds a field the fonts cannot draw should be told about it
    even though this file has never heard of the field.
    """
    if isinstance(node, str):
        out.append((path, node))
    elif isinstance(node, dict):
        for k, v in node.items():
            _walk_strings(v, f"{path}.{k}" if path else k, out)
    elif isinstance(node, list):
        for i, v in enumerate(node):
            _walk_strings(v, f"{path}[{i}]", out)


def _measured_fields(d):
    """Every string that lands somewhere with a size, as (where, text, cap, budget, soft).

    `cap`     the C array in BYTES, transcribed from news_model.h. Always FAILS
    `budget`  PROMPT.md's budget in CHARACTERS, or None where the field has none
    `soft`    why this budget is a margin rather than a limit, or None when it is
              a limit. A margin WARNS: the page still prints, and rejecting an
              edition over one would leave yesterday's page on the glass over a
              house-style preference

    Written out by hand rather than derived, because it IS the transcription of
    news_model.h — if the two disagree, this file is the one that is wrong, and a
    reader has to be able to see both numbers side by side.

    check_caps_against_header() is what stops "this file is the one that is
    wrong" from being a comment nobody acts on. Five of these caps went stale at
    once when the model grew — body 2400 against a header that said 4000, and
    four more — and the only symptom was --validate rejecting a payload the
    device would have accepted perfectly well. A transcription with no check is
    a second source of truth wearing a disclaimer.
    """
    out = []

    def add(where, value, cap, budget=None, soft=None):
        if isinstance(value, str) and value:
            out.append((where, value, cap, budget, soft))

    for k, cap in (("edition", 32), ("dateline", 40), ("session", 48),
                   ("as_of", 24), ("generated_at", 24)):
        add(k, d.get(k), cap)

    subject = d.get("subject") or {}
    for k, cap in (("symbol", 8), ("name", 40), ("exchange", 12), ("sector", 32)):
        add(f"subject.{k}", subject.get(k), cap)

    for i, s in enumerate(d.get("stories") or []):
        tier = 0 if i == 0 else 1
        add(f"stories[{i}].kicker",   s.get("kicker"),    28, KICKER_BUDGET, TYPOGRAPHY)
        add(f"stories[{i}].headline", s.get("headline"), 120, BUDGET["headline"][tier])
        add(f"stories[{i}].deck",     s.get("deck"),     180, BUDGET["deck"][tier])
        add(f"stories[{i}].byline",   s.get("byline"),    40)
        add(f"stories[{i}].body",     s.get("body"),   4000)
        photo = s.get("photo") or {}
        add(f"stories[{i}].photo.id",      photo.get("id"),       16)
        add(f"stories[{i}].photo.caption", photo.get("caption"), 120, BUDGET["caption"][tier])
        add(f"stories[{i}].photo.credit",  photo.get("credit"),   32)

    for i, f in enumerate(d.get("figures") or []):
        add(f"figures[{i}].group", f.get("group"), 24)
        add(f"figures[{i}].label", f.get("label"), 24, LABEL_BUDGET, TYPOGRAPHY)
        add(f"figures[{i}].value", f.get("value"), 24, VALUE_BUDGET, TYPOGRAPHY)

    for i, b in enumerate(d.get("briefs") or []):
        add(f"briefs[{i}].date",   b.get("date"),    12)
        add(f"briefs[{i}].kicker", b.get("kicker"),  28, KICKER_BUDGET, TYPOGRAPHY)
        add(f"briefs[{i}].text",   b.get("text"),   140, BRIEF_BUDGET, TYPOGRAPHY)

    for i, p in enumerate(d.get("peers") or []):
        for k, cap in (("symbol", 8), ("name", 24), ("per", 16), ("cap", 16)):
            add(f"peers[{i}].{k}", p.get(k), cap)

    for i, t in enumerate(d.get("tables") or []):
        add(f"tables[{i}].title", t.get("title"), 32)
        add(f"tables[{i}].note",  t.get("note"),  48)
        for c, head in enumerate(t.get("columns") or []):
            add(f"tables[{i}].columns[{c}]", head, 12, COLUMN_BUDGET, TYPOGRAPHY)
        for r, row in enumerate(t.get("rows") or []):
            if not isinstance(row, dict):
                continue
            add(f"tables[{i}].rows[{r}].label", row.get("label"), 24)
            for c, value in enumerate(row.get("values") or []):
                # The one soft budget on the sheet. A cell is tighter than twelve characters when
                # the day's make-up gives the table three columns instead of six, and the
                # compositor is what decides that — so twelve is what SURVIVES a narrow table
                # rather than a limit anybody can state, and a payload over it still prints on a
                # wide day. Warning, not rejection.
                add(f"tables[{i}].rows[{r}].values[{c}]", value, 14, CELL_BUDGET, MAKEUP)

    for i, c in enumerate(d.get("charts") or []):
        for k, cap in (("label", 24), ("span", 8), ("note", 48)):
            add(f"charts[{i}].{k}", c.get(k), cap)

    for i, q in enumerate(d.get("indices") or []):
        for k, cap in (("symbol", 8), ("name", 24)):
            add(f"indices[{i}].{k}", q.get(k), cap)

    for i, t in enumerate(d.get("thumbs") or []):
        add(f"thumbs[{i}].id",      (t or {}).get("id"),       16)
        add(f"thumbs[{i}].caption", (t or {}).get("caption"), 120, BUDGET["caption"][0])
        add(f"thumbs[{i}].credit",  (t or {}).get("credit"),   32)

    return out


def _length_check(where, text, cap, budget, soft):
    """(problem, warning) for one string — at most one of the two is ever set.

    Three things can be wrong with a string's length and they are not the same
    kind of wrong.

    A BUDGET that is a limit fails. Those are the ellipsized fields — a headline,
    a deck, a caption — where overshooting sets more type than the slot holds and
    the panel prints a `…` in the middle of the sentence. Counted in characters,
    because an em dash is one character of measure and failing a headline for
    being three bytes over when it sets perfectly well would be worse than not
    checking at all.

    A BUDGET that is a margin warns. PROMPT.md holds six fields well inside their
    arrays, and going past one is not a defect: the page still typesets. Failing
    would leave yesterday's page on the glass over a house-style preference,
    which is this project's own policy — clamp, do not reject — inverted.

    The BYTE capacity always fails. It is the fixed C array in news_model.h, and
    it is the failure with nothing to show for it — news_str_copy() trims on a
    character boundary and the value simply stops. With every budget held inside
    its array it should essentially never fire for ASCII; when it does fire it is
    because the payload carries typography, which is exactly the case where the
    character count looks fine and the field runs out.
    """
    n_chars, n_bytes = len(text), len(text.encode("utf-8"))
    warning = None

    if budget is not None and n_chars > budget:
        if soft:
            # Noted, but NOT returned yet: a margin must not swallow the hard limit under it. A
            # fourteen-character cell is outside the margin AND outside the fourteen-byte array
            # that carries it, and the second of those is the one that actually truncates.
            warning = (f"{where}: {n_chars} characters against PROMPT.md's {budget} — it fits the "
                       f"{cap}-byte field, but {soft}")
        else:
            return (f"{where}: {n_chars} characters against a budget of {budget}, "
                    f"{n_chars - budget} over — the panel ellipsizes it mid-sentence"), None

    if n_bytes > cap - 1:
        # Only claim the budget was met when it actually was. A margin does not stop the payload,
        # so a string can be over the budget AND over the array, and telling a desk that its
        # twenty-character label "is inside the sixteen-character budget" would be a lie in the
        # one message it gets.
        inside = (f"{n_chars} characters is inside the {budget}-character budget, but "
                  if budget is not None and n_chars <= budget else "")
        return (f"{where}: {inside}{n_bytes} bytes does not fit the {cap}-byte field — "
                f"news_str_copy() cuts it at {cap - 1} and nothing on the sheet says so"), None

    return None, warning


def _tile_problems(d, tiles_dir):
    """Every tile the page can ask for: the stories' photographs and the thumbs.

    The id is the URL and w*h/2 is the byte count, so a missing or mis-sized file is a slot that
    renders empty on a panel that takes half a minute to say so. This is the check the device
    cannot make — by the time it knows, it has already spent the refresh.
    """
    problems = []
    tiles = [(f"stories[{i}].photo", s.get("photo") or {})
             for i, s in enumerate(d.get("stories") or [])]
    tiles += [(f"thumbs[{i}]", t or {}) for i, t in enumerate(d.get("thumbs") or [])]

    for who, p in tiles:
        if not p.get("id"):
            continue
        w, h = int(p.get("w", 0)), int(p.get("h", 0))
        if w % 2:
            problems.append(f"{who}: width {w} is odd; a tile packs two pixels per byte and "
                            f"cannot be blitted as a memcpy, so news_parse drops the photo whole")
        if w <= 0 or h <= 0:
            problems.append(f"{who}: {w}x{h} — a photo needs both dimensions or it cannot be "
                            f"fetched, and news_parse drops it whole")
            continue

        # Before the join, not after: this validator now runs on the desk over payloads that
        # arrived from the internet, and its report goes back to whoever filed them. An id that
        # is a path would otherwise make the two lines below an existence-and-size oracle for
        # any *.bin on that machine.
        if not isinstance(p["id"], str) or not TILE_ID_RE.match(p["id"]):
            problems.append(f"{who}: id {p['id']!r} is not [A-Za-z0-9_-]{{1,15}} — "
                            f"the device drops it")
            continue

        tile = os.path.join(tiles_dir, p["id"] + ".bin")
        want = w * h // 2
        # The basename rather than the path: the reader knows which directory they filed, and a
        # container path in a report that leaves the machine is a disclosure for no benefit.
        name = os.path.basename(tile)
        if not os.path.exists(tile):
            problems.append(f"{who}: {name} is missing — the slot renders empty")
        elif os.path.getsize(tile) != want:
            problems.append(f"{who}: {name} is {os.path.getsize(tile)} bytes, "
                            f"{w}x{h} needs {want} — it will not be fetched")
    return problems


# The clamp news_parse.c applies to `policy.poll_seconds`, and the firmware's own polling range.
# Transcribed from NEWS_POLL_MIN and NEWS_POLL_MAX, and held against them by
# check_caps_against_header() — which used to look at the byte caps only, so these two were the
# transcription with nothing behind it.
POLL_SECONDS_MIN, POLL_SECONDS_MAX = 30, 86400

# What the device reads out of `policy`. Everything else under it is ignored, exactly as an unknown
# key anywhere else on this wire is — but here it is worth SAYING, because a producer that wrote
# `quiet_until` or `poll_interval` has a schedule it believes is in force and is not.
POLICY_KEYS = ("poll_seconds", "next_change")


def _policy_issues(d):
    """Check the `policy` block. Returns (problems, warnings).

    This is the one object on the wire that is not about the paper: how often the board should come
    back, and when the server's answer will next change. See docs/news-contract.md.

    The device CLAMPS everything here rather than rejecting — the block is not allowed to cost a
    page — so nothing below changes whether the edition prints. That is exactly why it is checked:
    a clamp is silent, and the symptom of a `poll_seconds` of 5 is a board that polls twelve times
    a minute for as long as it stays powered, with nothing anywhere to say it was asked to.

    `next_change` is EPOCH SECONDS as a JSON number and never an ISO-8601 string. That is this
    wire's standing rule — a number the device reasons about is an integer — and it keeps a date
    parser out of the firmware. A string here is the mistake worth catching loudest, because it
    looks more correct than the thing that works.
    """
    problems, warnings = [], []

    if "policy" not in d:
        return problems, warnings          # absent is the normal case, not a thin one

    p = d["policy"]
    if not isinstance(p, dict):
        problems.append(f"policy is {type(p).__name__}, not an object — the device reads it as "
                        f"absent and polls at its compiled-in interval")
        return problems, warnings

    def _int(key):
        """The value under `key` when it is a JSON integer, else None with the reason recorded."""
        if key not in p:
            return None
        v = p[key]
        if isinstance(v, bool) or not isinstance(v, (int, float)):
            problems.append(f"policy.{key} is {v!r} — it must be a JSON number; the device reads "
                            f"anything else as absent and this block silently does nothing")
            return None
        if v != int(v):
            warnings.append(f"policy.{key} is {v} — the device rounds it to an integer, because "
                            f"nothing on this wire that it reasons about is fractional")
        return int(v)

    poll = _int("poll_seconds")
    if poll is not None and not POLL_SECONDS_MIN <= poll <= POLL_SECONDS_MAX:
        problems.append(f"policy.poll_seconds is {poll} — the range is "
                        f"{POLL_SECONDS_MIN}..{POLL_SECONDS_MAX} and the device clamps into it, "
                        f"so the board will poll at a cadence you did not choose")

    when = _int("next_change")
    if when is not None and when < 0:
        problems.append(f"policy.next_change is {when} — it is epoch seconds, so a negative one is "
                        f"not an instant; the device reads it as absent")

    for key in p:
        if key not in POLICY_KEYS:
            warnings.append(f"policy.{key} is not a field the device reads — it knows "
                            f"{' and '.join(POLICY_KEYS)} and ignores everything else")

    return problems, warnings


def check_caps_against_header():
    """Hold the numbers above against the #defines they are a transcription of.

    Every cap in fields_with_caps() is a byte count copied out of news_model.h,
    and the docstring there says that where they disagree this file is the one
    that is wrong. This is what turns that from a statement into a test: it
    parses the header's `#define NEWS_*_MAX` and `NEWS_*_MIN` lines and
    compares. POLL_SECONDS_MIN and POLL_SECONDS_MAX are transcribed from the
    same header and go through the same comparison -- they are a range in
    seconds rather than a byte count, which is the only reason they need their
    own two lines below rather than a row in the table.

    NOT a replacement for the transcription. The table stays written out, because
    a reader auditing a budget needs the number in front of them rather than a
    lookup — the point is only that the number cannot go stale in silence, which
    it did for all five of body, kicker, group, label and value at once.

    Returns 0 when they agree, 1 when they do not, and 0 when the header cannot
    be found at all: this script has to keep working outside a checkout, and
    refusing to serve a page because a source file is missing would be a worse
    failure than the one being guarded against.
    """
    header = os.path.join(ROOT, "components", "news_core", "include", "news_model.h")
    try:
        with open(header, encoding="utf-8") as f:
            text = f.read()
    except OSError:
        return 0

    defines = {m.group(1): int(m.group(2)) for m in
               re.finditer(r"^#define\s+(NEWS_[A-Z0-9_]*(?:MAX|MIN))\s+(\d+)",
                           text, re.M)}

    # cap in the table above -> the #define it was copied from
    expect = {
        "stories[].kicker":        "NEWS_KICKER_MAX",
        "stories[].headline":      "NEWS_HEADLINE_MAX",
        "stories[].deck":          "NEWS_DECK_MAX",
        "stories[].byline":        "NEWS_BYLINE_MAX",
        "stories[].body":          "NEWS_BODY_MAX",
        "stories[].photo.caption": "NEWS_CAPTION_MAX",
        "figures[].group":         "NEWS_GROUP_MAX",
        "figures[].label":         "NEWS_FIG_LABEL_MAX",
        "figures[].value":         "NEWS_FIG_VALUE_MAX",
        "briefs[].kicker":         "NEWS_KICKER_MAX",
        "briefs[].text":           "NEWS_BRIEF_MAX",
        "charts[].label":          "NEWS_FIG_LABEL_MAX",
        "thumbs[].caption":        "NEWS_CAPTION_MAX",
        "peers[].symbol":          "NEWS_SYMBOL_MAX",
        "indices[].symbol":        "NEWS_SYMBOL_MAX",
        "as_of":                   "NEWS_TIME_MAX",
        "generated_at":            "NEWS_TIME_MAX",
    }

    sample = _measured_fields(snapshot())
    bad = []
    for where, _value, cap, _budget, _soft in sample:
        # Normalised path, not the leaf: a table row's `label` is a bare
        # char[24] with no #define behind it, and keying on "label" alone would
        # hold it to NEWS_FIG_LABEL_MAX — right by luck today, and a false
        # failure the day either number moves.
        path = re.sub(r"\[\d+\]", "[]", where)
        name = expect.get(path)
        if name is None or name not in defines:
            continue
        if defines[name] != cap:
            bad.append((path, cap, name, defines[name]))

    seen, uniq = set(), []
    for row in bad:
        if row not in seen:
            seen.add(row)
            uniq.append(row)

    # The poll bounds are not in `sample`, because nothing measures them: they
    # are a clamp on a number the producer sends, not a length. They are the
    # same transcription and drift the same way -- which is what this function
    # exists to catch -- so they are compared here rather than not at all.
    bounds = (("POLL_SECONDS_MIN", POLL_SECONDS_MIN, "NEWS_POLL_MIN"),
              ("POLL_SECONDS_MAX", POLL_SECONDS_MAX, "NEWS_POLL_MAX"))
    drifted = [(name, value, define, defines[define])
               for name, value, define in bounds
               if define in defines and defines[define] != value]

    for path, cap, name, want in uniq:
        print(f"  FAIL  cap table says {path} is {cap} bytes; news_model.h says "
              f"{name} is {want}. Fix this file, not the header.", file=sys.stderr)
    for name, value, define, want in drifted:
        print(f"  FAIL  {name} is {value}; news_model.h says {define} is {want}. "
              f"Fix this file, not the header.", file=sys.stderr)
    if uniq or drifted:
        print(f"this file has drifted from news_model.h in "
              f"{len(uniq) + len(drifted)} place(s)", file=sys.stderr)
        return 1
    return 0


def validate_payload(d, tiles_dir):
    """Check a decoded payload. Returns (problems, warnings), both lists of strings.

    Split from validate() so --write-fixture can hold the payload it is about to
    write to the same standard without going through a file. The fixture is what
    test_news_mock.c pins news_mock.c against, so a fixture describing pictures
    nobody packed is a way to make the demo edition quietly wrong for a week.
    """
    problems, warnings = [], []

    if not isinstance(d, dict):
        return ["the payload must be a JSON object"], []

    # The device rejects a payload that names no company AND carries no story, because that is what
    # an error envelope parses down to. A rejection leaves yesterday's page on the glass badged
    # STALE, which is a failure nobody can diagnose hours later.
    subject = d.get("subject") or {}
    stories = d.get("stories") or []
    if not subject.get("symbol") and not stories:
        problems.append("no subject symbol and no stories — the device would reject this "
                        "payload outright and keep yesterday's page")
    elif not subject.get("symbol"):
        problems.append("subject.symbol is empty — the nameplate has nothing to print")

    for i, s in enumerate(stories):
        tier = "lead" if i == 0 else "secondary"
        who = f"stories[{i}] ({s.get('kicker') or tier})"

        body = s.get("body") or ""
        if body and len(body) < BODY_FLOOR[tier]:
            warnings.append(f"{who}: body is {len(body)} characters, under {BODY_FLOOR[tier]} "
                            f"— the column will not fill")

        # A story names a chart by index into the top-level array. Out of range is silently
        # dropped by the device, so it has to be caught here.
        chart = s.get("chart")
        if chart is not None and not (0 <= int(chart) < len(d.get("charts") or [])):
            problems.append(f"{who}: chart {chart} is not an index into the "
                            f"{len(d.get('charts') or [])} chart(s) sent — it will be dropped")

    for where, text, cap, budget, soft in _measured_fields(d):
        problem, warning = _length_check(where, text, cap, budget, soft)
        if problem:
            problems.append(problem)
        elif warning:
            warnings.append(warning)

    # Consecutive figures sharing a group print ONE standing head between them, and nothing
    # downstream sorts the list. A group that is left and returned to therefore prints its head
    # twice, which is visible but reads as a rendering fault rather than as a producer's ordering.
    seen, previous = set(), None
    for i, f in enumerate(d.get("figures") or []):
        group = f.get("group") or ""
        if group == previous:
            continue
        if group in seen:
            problems.append(f"figures[{i}]: group {group!r} was left and returned to — the rail "
                            f"prints that standing head twice; keep each group contiguous")
        seen.add(group)
        previous = group

    # `emph` is the rail's editorial judgement about its own numbers, and it only works if it is
    # spent. Nothing emphasised is the twenty-eight-identical-lines rail the owner rejected;
    # everything emphasised is the same rail one size larger. Both WARN rather than fail — the page
    # typesets either way, and this project does not reject an edition over a house-style preference.
    figures = d.get("figures") or []
    heroes = [f for f in figures if f.get("emph")]
    if figures and not heroes:
        warnings.append("no figure is marked emph — the rail sets every line the same size and "
                        "reads as a spreadsheet with a rule down one side; mark two to four")
    elif len(heroes) > 4:
        warnings.append(f"{len(heroes)} figures are marked emph — past about four nothing is "
                        f"emphasised any more; mark two to four")

    for i, f in enumerate(figures):
        bar = f.get("bar")
        if bar is None:
            continue
        if not isinstance(bar, (int, float)) or isinstance(bar, bool):
            problems.append(f"figures[{i}].bar is {bar!r} — it must be a number 0..1000, where the "
                            f"value sits in a range you chose; the device reads it as no bar at all")
        elif not 0 <= bar <= 1000:
            problems.append(f"figures[{i}].bar is {bar} — the scale is 0..1000 and the device "
                            f"clamps, so the bar draws pinned to one end and says nothing")
        elif not f.get("emph"):
            warnings.append(f"figures[{i}] ({f.get('label')!r}) carries a bar but is not emph — a "
                            f"bar on a small line is a track drawn across a rail column with "
                            f"nothing beside it to read")

    for i, t in enumerate(d.get("tables") or []):
        cols = t.get("columns") or []
        rows = t.get("rows") or []
        render = (t.get("render") or "print").lower()
        if render not in ("print", "stack", "bars_line", "bars+line"):
            warnings.append(f"tables[{i}].render is {t.get('render')!r} — the device knows print, "
                            f"stack and bars_line, and prints anything else")

        # A drawn table needs a complete numeric plane, and news_parse() is all-or-nothing about it:
        # one row short of one number and `has_n` goes false and the whole table prints. That is not
        # an error — it is the same degrade-to-what-works this parser does everywhere — but it is
        # invisible from the payload, so it is said out loud here.
        planes = [r.get("n") for r in rows if isinstance(r, dict)]
        complete = bool(cols) and bool(rows) and all(
            isinstance(p, list) and len(p) >= len(cols)
            and all(isinstance(x, (int, float)) and not isinstance(x, bool) for x in p[:len(cols)])
            for p in planes)
        if render != "print" and not complete:
            warnings.append(f"tables[{i}]: render {render!r} without a full `n` on every row — the "
                            f"device falls back to printing it, which still works but is not what "
                            f"was asked for")
        if render == "print" and any(p is not None for p in planes):
            warnings.append(f"tables[{i}]: every row carries `n` but render is 'print' — the "
                            f"numbers are sent and nothing draws them")

        for j, r in enumerate(rows):
            if not isinstance(r, dict):
                continue
            n = len(r.get("values") or [])
            if n > len(cols):
                problems.append(f"tables[{i}].rows[{j}]: {n} values under {len(cols)} "
                                f"columns — the tail is truncated")
            elif n < len(cols):
                warnings.append(f"tables[{i}].rows[{j}]: {n} values under {len(cols)} "
                                f"columns — the tail prints as em dashes")
            plane = r.get("n")
            if isinstance(plane, list) and 0 < len(plane) < len(cols):
                warnings.append(f"tables[{i}].rows[{j}]: {len(plane)} numbers under {len(cols)} "
                                f"columns — one short plane un-draws the WHOLE table")

    for i, c in enumerate(d.get("charts") or []):
        if c.get("kind", "none") != "none" and not (c.get("close") or []):
            warnings.append(f"charts[{i}]: kind {c.get('kind')!r} with no close series "
                            f"— the device drops it and any story naming it loses its chart")

    policy_problems, policy_warnings = _policy_issues(d)
    problems += policy_problems
    warnings += policy_warnings

    found = []
    _walk_strings(d, "", found)
    for where, s in found:
        if bad := _drawable(s):
            problems.append(f"{where}: undrawable character(s) {''.join(bad)!r} (U+"
                            + ", U+".join(f"{ord(c):04X}" for c in bad)
                            + ") — the fonts carry ASCII, Latin-1 and S_DATA_PUNCT only")

    problems += _tile_problems(d, tiles_dir)
    return problems, warnings


def default_tiles_dir(path):
    """Where a real edition keeps its pictures: beside the payload it filed.

    agent/standalone/file-edition.sh writes news.json and tiles/ into one directory
    and serves that directory, so this is the layout the device actually sees.
    The committed fixture is the exception and passes --tiles explicitly.
    """
    return os.path.join(os.path.dirname(os.path.abspath(path)), "tiles")


def validate(path, tiles_dir=None):
    """Check an edition against the contract and the length budget. Returns a process exit code."""
    try:
        with open(path, encoding="utf-8") as f:
            d = json.load(f)
    except FileNotFoundError:
        print(f"validate: {path} does not exist", file=sys.stderr)
        return 1
    except json.JSONDecodeError as e:
        print(f"validate: {path} is not valid JSON — {e}", file=sys.stderr)
        return 1

    tiles_dir = tiles_dir or default_tiles_dir(path)
    problems, warnings = validate_payload(d, tiles_dir)

    for w in warnings:
        print(f"  warn  {w}")
    for p_ in problems:
        print(f"  FAIL  {p_}", file=sys.stderr)

    if problems:
        print(f"validate: {path} — {len(problems)} problem(s)", file=sys.stderr)
        return 1
    print(f"validate: {path} — ok "
          f"({len(d.get('stories') or [])} stories, {len(d.get('figures') or [])} figures, "
          f"{len(d.get('briefs') or [])} briefs, tiles from {tiles_dir}, "
          f"{len(warnings)} warning(s))")
    return 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8123)
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--live", action="store_true",
                    help="nudge the prices on every request")
    ap.add_argument("--no-etag", action="store_true",
                    help="serve no ETag and ignore If-None-Match, the way a "
                         "plain file server does")
    ap.add_argument("--dump", action="store_true", help="print the payload and exit")
    ap.add_argument("--write-fixture", action="store_true",
                    help="rewrite the host tests' fixture from this payload")
    ap.add_argument("--check", action="store_true",
                    help="fail if the committed fixture is not this payload")
    ap.add_argument("--validate", metavar="news.json",
                    help="check somebody else’s edition against the contract and the length budget")
    ap.add_argument("--tiles", metavar="DIR",
                    help="where --validate looks for <id>.bin "
                         "(default: a tiles/ beside the payload, which is how an edition is filed)")
    args = ap.parse_args()

    # Before anything reads the cap table, prove it still describes news_model.h.
    if check_caps_against_header() != 0:
        return 1

    if args.validate:
        return validate(args.validate, args.tiles)

    if args.dump:
        sys.stdout.write(dumps(snapshot()))
        return 0
    if args.check:
        return check_fixture()
    if args.write_fixture:
        # Held to the same standard as anybody else's edition before it is written, tiles
        # included. The fixture is what test_news_mock.c pins news_mock.c against, so one that
        # describes pictures nobody packed would make the demo edition quietly wrong for a week
        # — and it would be wrong in the one place nothing else is checking.
        payload = snapshot()
        problems, warnings = validate_payload(payload, SIM_TILES)
        for w in warnings:
            print(f"  warn  {w}")
        for p_ in problems:
            print(f"  FAIL  {p_}", file=sys.stderr)
        if problems:
            print(f"--write-fixture refused: the payload has {len(problems)} problem(s). "
                  f"Fix tools/mock_news_server.py, not {FIXTURE}.", file=sys.stderr)
            return 1

        os.makedirs(os.path.dirname(FIXTURE), exist_ok=True)
        with open(FIXTURE, "w", encoding="utf-8") as f:
            f.write(dumps(payload))
        print(f"wrote {FIXTURE}")
        return 0

    Handler.live = args.live
    Handler.etag_enabled = not args.no_etag
    # Threaded, and this is not a nicety. A board fetches the snapshot and the
    # photograph on two separate connections — `http_get()` and `http_get_bin()`
    # are different client handles — so a single-threaded server cannot serve
    # one edition. With keep-alive on, the snapshot's socket stays open and the
    # tile's connection waits in the accept backlog until the board's HTTP
    # timeout fires, and `ui_tile.c` drops a missed tile *silently* by design:
    # the sheet prints with every word in place and a hole where the picture
    # was. Threads are what make the second connection reachable.
    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    srv.daemon_threads = True
    print(f"serving the front page on http://{args.host}:{args.port}/news.json"
          + ("  (live)" if args.live else ""))
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
