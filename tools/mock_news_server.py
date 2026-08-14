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

Every number here is a JSON number and the device converts: prices become
int32 cents, percentage changes become int32 basis points. Nothing on either
side of the wire holds a float once it has been read.

Usage
-----
    python3 tools/mock_news_server.py                 # serve on :8123
    python3 tools/mock_news_server.py --port 9000
    python3 tools/mock_news_server.py --live          # prices drift each poll
    python3 tools/mock_news_server.py --dump          # print the payload
    python3 tools/mock_news_server.py --write-fixture # refresh the test fixture
    python3 tools/mock_news_server.py --check         # fixture still matches?

Then set the board’s URL to http://<this machine>.local:8123/news.json, either
in the captive portal or with

    curl -X POST http://wpnews.local/api/news \\
         -d '{"url":"http://mymac.local:8123/news.json"}'
"""

import argparse
import json
import os
import random
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FIXTURE = os.path.join(ROOT, "components", "news_core", "test", "host",
                       "fixtures", "news.json")

# The masthead’s own date. Fixed rather than taken from the clock: the fixture
# is committed, and a payload whose dateline moved overnight would fail
# test_news_mock every morning for no reason.
DATELINE = "FRIDAY, AUGUST 14, 2026"

# (symbol, name, last, change_pct, spark)
#
# `spark` is pre-normalised to 0..1000 by the producer. The device cannot
# normalise it itself — it has the pixels but not the units — so this is the one
# piece of arithmetic the contract asks the server to do.
INDICES = [
    ("SPX", "S&P 500",      6412.83,  0.62, [402, 418, 396, 430, 455, 441, 468, 502, 488, 521, 546, 574]),
    ("NDX", "NASDAQ 100",  23841.55, -0.18, [612, 640, 628, 597, 574, 588, 561, 540, 552, 519, 534, 508]),
    ("DJI", "DOW 30",      47215.60,  0.34, [318, 305, 331, 349, 336, 362, 380, 371, 398, 415, 402, 428]),
    ("RUT", "RUSSELL 2000", 2544.19,  0.91, [206, 232, 221, 258, 284, 271, 310, 342, 329, 368, 401, 436]),
    ("VIX", "VIX",            14.62, -3.10, [744, 712, 758, 690, 651, 668, 612, 574, 590, 533, 501, 462]),
]

# The watchlist: sixteen names, which is both blocks of eight in band 7 full.
# Large-caps on purpose — the demo screenshot is what people see first, and a
# board full of tickers nobody recognises reads as test data.
TICKERS = [
    ("NVDA",  "Nvidia",         183.22, -1.84, [688, 712, 700, 741, 726, 690, 664, 638, 651, 610, 592, 566]),
    ("AAPL",  "Apple",          231.40,  0.31, [430, 442, 421, 455, 468, 451, 476, 490, 472, 501, 488, 512]),
    ("MSFT",  "Microsoft",      512.66,  0.44, [512, 528, 505, 540, 556, 533, 561, 578, 560, 592, 605, 624]),
    ("GOOGL", "Alphabet",       214.08, -0.27, [560, 574, 552, 588, 566, 541, 528, 549, 520, 505, 517, 494]),
    ("AMZN",  "Amazon",         238.91,  1.12, [340, 366, 352, 391, 418, 402, 440, 468, 455, 492, 520, 548]),
    ("META",  "Meta Platforms", 742.35, -0.63, [620, 648, 632, 660, 641, 612, 590, 605, 574, 552, 566, 530]),
    ("TSLA",  "Tesla",          341.77,  2.18, [280, 312, 296, 348, 380, 362, 410, 452, 436, 488, 526, 570]),
    ("AVGO",  "Broadcom",       297.44, -2.05, [700, 728, 715, 744, 720, 688, 660, 672, 640, 612, 624, 580]),
    ("AMD",   "Advanced Micro", 174.62, -1.31, [648, 662, 640, 675, 652, 628, 606, 620, 588, 570, 582, 548]),
    ("MU",    "Micron",         128.05,  3.42, [240, 268, 255, 300, 336, 320, 372, 412, 398, 452, 496, 540]),
    ("TSM",   "Taiwan Semi",    241.19, -0.88, [590, 612, 600, 628, 610, 585, 562, 576, 548, 530, 542, 512]),
    ("JPM",   "JPMorgan",       302.55,  0.19, [452, 466, 448, 478, 490, 472, 496, 508, 492, 516, 504, 528]),
    ("XOM",   "Exxon Mobil",    118.73, -0.42, [540, 556, 538, 566, 548, 524, 508, 520, 496, 480, 492, 468]),
    ("LLY",   "Eli Lilly",      902.14,  0.76, [388, 404, 386, 420, 438, 421, 448, 466, 450, 480, 496, 518]),
    ("COST",  "Costco",         984.30, -0.11, [500, 514, 498, 524, 510, 492, 480, 492, 472, 462, 474, 456]),
    ("V",     "Visa",           358.62,  0.24, [468, 480, 462, 492, 505, 488, 512, 524, 508, 532, 520, 544]),
]

# Twenty-two sessions of NVDA as [open, high, low, close]. The last close is the
# ticker’s `last`, because a chart that disagrees with the number printed beside
# it is the first thing a reader notices.
NVDA_CANDLES = [
    [168.40, 170.95, 167.80, 170.12],
    [170.30, 172.60, 169.55, 172.05],
    [171.90, 173.10, 169.20, 169.88],
    [170.05, 174.40, 169.90, 174.02],
    [174.20, 176.85, 173.60, 176.31],
    [176.10, 177.20, 173.95, 174.47],
    [174.80, 179.30, 174.10, 179.05],
    [179.40, 181.75, 178.60, 181.22],
    [181.00, 182.40, 178.05, 178.63],
    [178.90, 180.55, 177.30, 180.14],
    [180.40, 184.90, 180.10, 184.55],
    [184.70, 187.20, 183.90, 186.78],
    [186.50, 188.40, 184.75, 185.10],
    [185.30, 189.95, 185.00, 189.40],
    [189.60, 192.30, 188.85, 191.86],
    [191.50, 192.85, 187.40, 188.02],
    [188.20, 190.10, 186.55, 186.94],
    [187.10, 188.60, 184.20, 184.75],
    [184.90, 187.75, 184.30, 187.31],
    [187.00, 188.90, 185.60, 186.65],
    [186.40, 187.20, 182.05, 182.90],
    [183.10, 185.40, 181.55, 183.22],
]

# A line chart may send bare closes instead of quadruples, and the energy story
# does — so the demo exercises both forms of `bars` rather than describing the
# flat one in a comment nobody runs.
XOM_LINE = [
    119.85, 120.12, 119.64, 119.20, 118.95, 119.40, 119.72, 120.05, 119.88, 119.31,
    118.90, 118.55, 118.20, 118.64, 119.02, 119.35, 119.10, 118.72, 118.40, 118.15,
    117.92, 118.30, 118.66, 118.95, 119.18, 118.84, 118.50, 118.22, 118.45, 118.73,
]

LEAD_BODY = (
    "SANTA CLARA — Nvidia closed the book on a quarter Wall Street had spent "
    "three months arguing about, reporting data-center revenue above every "
    "published estimate and guiding the October quarter higher still. The stock "
    "fell 1.8 percent anyway. That is the trade in miniature: the numbers are no "
    "longer the question, and the argument has moved on to who pays for the next "
    "build-out and over how many years it is written down. Hyperscaler capital "
    "budgets, revised upward twice already this year, now imply a level of "
    "accelerator demand the company itself has stopped calling a backlog and "
    "started calling a schedule. Supply is the constraint that remains. "
    "Advanced packaging is booked into next spring, memory partners are quoting "
    "lead times in quarters rather than weeks, and the analysts who spent the "
    "spring modelling a glut are quietly rebuilding their spreadsheets."
)

ENERGY_BODY = (
    "VIENNA — Eight OPEC+ members will restore a further 137,000 barrels a day "
    "from October, a decision the futures curve had already written in. Brent "
    "settled below $60 for the third straight session and the front-month spread "
    "flipped into contango, which is the market saying it expects the barrels to "
    "arrive. U.S. producers have answered by doing nothing: rig counts in the "
    "Permian are flat for the eighth week, and the majors are still guiding to "
    "buybacks rather than to volume."
)

RATES_BODY = (
    "WASHINGTON — Initial claims came in at 241,000 against an expected 225,000, "
    "and the two-year yield gave up eleven basis points inside an hour. Fed funds "
    "futures now price two cuts before Christmas where yesterday they priced one "
    "and a half. The long end declined to agree: the ten-year fell four basis "
    "points, steepening the curve to its widest since March and leaving the "
    "inflation breakevens almost exactly where they started the week."
)

RETAIL_BODY = (
    "ISSAQUAH — Costco reported August comparable sales up 6.1 percent excluding "
    "fuel, with traffic rather than ticket doing the work, and the executive "
    "membership renewal rate unchanged at 92.9 percent. That last number is the "
    "one the company is really reporting: the merchandise margin is thin by "
    "design and the fees are the profit, so a renewal rate that does not move "
    "through a soft quarter is the whole thesis holding."
)


def stories():
    """The four stories: one lead and the three that fill band 6.

    `rank` is the only thing the server says about geometry — 0 is the lead,
    1..3 the secondary row. The device decides what fits; only the device has
    the font metrics, and only the agent has the research.
    """
    return [
        {
            "rank": 0,
            "kicker": "SEMICONDUCTORS",
            "headline": "Nvidia’s blowout quarter resets the whole AI trade",
            "deck": "Guidance beat the entire sell-side range, and for the first "
                    "time the supply story arrives with numbers attached.",
            "byline": "By CLAUDE · MARKET DESK",
            "body": LEAD_BODY,
            "symbol": "NVDA", "last": 183.22, "change_pct": -1.84,
            "chart": {"kind": "candle", "span": "1M", "bars": NVDA_CANDLES},
            "photo": {"id": "nvda_hq", "w": 1140, "h": 360,
                      "caption": "The financial district at the close, where the argument over who pays is now had.",
                      "credit": "DEMO IMAGE"},
        },
        {
            "rank": 1,
            "kicker": "ENERGY",
            "headline": "Crude slips under $60 as OPEC+ opens the taps",
            "deck": "Eight members restore 137,000 barrels a day in October.",
            "byline": "By CLAUDE · ENERGY DESK",
            "body": ENERGY_BODY,
            "symbol": "XOM", "last": 118.73, "change_pct": -0.42,
            "chart": {"kind": "line", "span": "5D", "bars": XOM_LINE},
        },
        {
            # No symbol, no price, no chart: a macro story is a normal front-page
            # item and the layout must not assume every story carries a quote.
            "rank": 2,
            "kicker": "RATES",
            "headline": "Two-year yield sinks after a soft claims print",
            "deck": "The front end prices two cuts. The long end disagrees.",
            "byline": "By CLAUDE · RATES DESK",
            "body": RATES_BODY,
        },
        {
            "rank": 3,
            "kicker": "RETAIL",
            "headline": "Costco holds the line where the mall does not",
            "deck": "Comparables rose 6.1 percent; renewals did not move.",
            "byline": "By CLAUDE · RETAIL DESK",
            "body": RETAIL_BODY,
            "symbol": "COST", "last": 984.30, "change_pct": -0.11,
        },
    ]


def quote(row):
    symbol, name, last, change_pct, spark = row
    return {"symbol": symbol, "name": name, "last": last,
            "change_pct": change_pct, "spark": list(spark)}


def snapshot(generated_at="2026-08-14T05:12:00Z", as_of="AS OF 05:12 KST"):
    """The canonical payload. Must stay identical to news_mock.c."""
    return {
        "schema": 2,
        "edition": "PERSONAL PORTFOLIO EDITION",
        "dateline": DATELINE,
        "session": "U.S. MARKETS CLOSED — AUG 13",
        "as_of": as_of,
        "generated_at": generated_at,
        "indices": [quote(r) for r in INDICES],
        "stories": stories(),
        "tickers": [quote(r) for r in TICKERS],
    }


def live_snapshot(state, now):
    """The canonical payload with the prices nudged, for --live.

    Exists to exercise the one behaviour a static payload cannot: the device
    only refreshes the panel when the content actually changed, and a refresh
    here is twenty-five seconds of flashing. Watching this drift is how you
    confirm the board is polling AND that an unchanged poll stays silent.
    """
    s = snapshot(generated_at=now.strftime("%Y-%m-%dT%H:%M:%SZ"),
                 as_of=now.strftime("AS OF %H:%M LOCAL"))
    state["tick"] += 1
    for q in s["indices"] + s["tickers"]:
        drift = random.randint(-40, 40) / 100.0
        q["change_pct"] = round(q["change_pct"] + drift, 2)
        q["last"] = round(q["last"] * (1.0 + drift / 100.0), 2)
    s["stories"][0]["last"] = s["tickers"][0]["last"]
    s["stories"][0]["change_pct"] = s["tickers"][0]["change_pct"]
    return s


def dumps(payload):
    """The fixture’s exact bytes. One function so --write-fixture and --check
    cannot disagree about indentation and report a diff that is not one."""
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

    def do_GET(self):
        if self.path.split("?")[0] not in ("/news.json", "/"):
            self.send_error(404)
            return
        import datetime
        # Without --live this serves the canonical payload verbatim, so a board
        # or simulator pointed here shows exactly the page news_mock.c draws.
        # That equivalence is the point of the file; --live is the exception.
        payload = (live_snapshot(self.state, datetime.datetime.now()) if self.live
                   else snapshot())
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        # The device polls one host repeatedly; letting it keep the socket saves
        # a connect per poll and, on an https:// URL, a whole TLS handshake.
        self.send_header("Connection", "keep-alive")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))


# --- validating somebody else’s edition ------------------------------------
#
# This file is the reference PRODUCER, so it is also the only place that knows the contract well
# enough to say whether an arbitrary payload satisfies it. The scheduled agent in tools/edition/
# calls this before it files: a page that the firmware would reject is a wasted cycle, and the
# failure would show up hours later as a STALE badge with nothing to explain it.
#
# The checks are the ones the device actually makes, plus the length budget from
# docs/specs/2026-08-14-front-page-design.md, which the device cannot check because it ellipsizes
# rather than failing.

BUDGET = {
    # field                 lead   secondary
    "headline":            (  72,   54),
    "deck":                ( 118,   58),
    "kicker":              (  24,   24),
    "caption":             (  72,   72),
}
BODY_RANGE = {"lead": (600, 740), "secondary": (200, 400)}

# Everything the bundled faces can draw: ASCII, Latin-1, and the typography in ui_strings.h’s
# S_DATA_PUNCT. A character outside this is a tofu box on the glass.
DATA_PUNCT = "—–‐…“”‘’‚„•·′″‹›«»⁄×÷±≈≠≤≥°‰№€£¥¢§¶©®™†‡"


def _drawable(s):
    return [c for c in s
            if not (0x20 <= ord(c) <= 0x7E or 0xA0 <= ord(c) <= 0xFF or c in DATA_PUNCT)]


def validate(path):
    """Check an edition against the contract and the length budget. Returns a process exit code."""
    problems, warnings = [], []

    try:
        with open(path, encoding="utf-8") as f:
            d = json.load(f)
    except FileNotFoundError:
        print(f"validate: {path} does not exist", file=sys.stderr)
        return 1
    except json.JSONDecodeError as e:
        print(f"validate: {path} is not valid JSON — {e}", file=sys.stderr)
        return 1

    if not isinstance(d, dict):
        print("validate: the payload must be a JSON object", file=sys.stderr)
        return 1

    stories = d.get("stories") or []
    if not stories:
        problems.append("no stories — the front page would render with an empty lead well")

    for i, s in enumerate(stories):
        tier = "lead" if i == 0 else "secondary"
        who = f"stories[{i}] ({s.get('kicker') or s.get('symbol') or tier})"
        for field, (lead_max, sec_max) in BUDGET.items():
            v = s.get(field) or (s.get("photo", {}) or {}).get(field) or ""
            cap = lead_max if tier == "lead" else sec_max
            if len(v) > cap:
                problems.append(f"{who}: {field} is {len(v)} characters, budget is {cap} "
                                f"— the panel will ellipsize it mid-sentence")
        body = s.get("body") or ""
        lo, hi = BODY_RANGE[tier]
        if body and len(body) < lo:
            warnings.append(f"{who}: body is {len(body)} characters, under {lo} "
                            f"— the column will not fill")

    for where, items in (("stories", stories),
                         ("tickers", d.get("tickers") or []),
                         ("indices", d.get("indices") or [])):
        for i, item in enumerate(items):
            for k, v in item.items():
                if isinstance(v, str) and (bad := _drawable(v)):
                    problems.append(f"{where}[{i}].{k}: undrawable character(s) "
                                    f"{''.join(bad)!r} (U+"
                                    + ", U+".join(f"{ord(c):04X}" for c in bad)
                                    + ") — the fonts carry ASCII, Latin-1 and S_DATA_PUNCT only")

    base = os.path.dirname(os.path.abspath(path))
    for i, s in enumerate(stories):
        p = s.get("photo") or {}
        if not p.get("id"):
            continue
        tile = os.path.join(base, "tiles", p["id"] + ".bin")
        want = int(p.get("w", 0)) * int(p.get("h", 0)) // 2
        if not os.path.exists(tile):
            problems.append(f"stories[{i}].photo: {tile} is missing — the slot renders empty")
        elif os.path.getsize(tile) != want:
            problems.append(f"stories[{i}].photo: {tile} is {os.path.getsize(tile)} bytes, "
                            f"{p.get('w')}x{p.get('h')} needs {want} — it will not be fetched")
        if int(p.get("w", 0)) % 2:
            problems.append(f"stories[{i}].photo: width {p.get('w')} is odd; a tile packs two "
                            f"pixels per byte and cannot be blitted as a memcpy")

    for w in warnings:
        print(f"  warn  {w}")
    for p_ in problems:
        print(f"  FAIL  {p_}", file=sys.stderr)

    if problems:
        print(f"validate: {path} — {len(problems)} problem(s)", file=sys.stderr)
        return 1
    print(f"validate: {path} — ok "
          f"({len(stories)} stories, {len(d.get('tickers') or [])} quotes, "
          f"{len(warnings)} warning(s))")
    return 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8123)
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--live", action="store_true",
                    help="nudge the prices on every request")
    ap.add_argument("--dump", action="store_true", help="print the payload and exit")
    ap.add_argument("--write-fixture", action="store_true",
                    help="rewrite the host tests' fixture from this payload")
    ap.add_argument("--check", action="store_true",
                    help="fail if the committed fixture is not this payload")
    ap.add_argument("--validate", metavar="news.json",
                    help="check somebody else’s edition against the contract and the length budget")
    args = ap.parse_args()

    if args.validate:
        return validate(args.validate)

    if args.dump:
        sys.stdout.write(dumps(snapshot()))
        return 0
    if args.check:
        return check_fixture()
    if args.write_fixture:
        os.makedirs(os.path.dirname(FIXTURE), exist_ok=True)
        with open(FIXTURE, "w", encoding="utf-8") as f:
            f.write(dumps(snapshot()))
        print(f"wrote {FIXTURE}")
        return 0

    Handler.live = args.live
    srv = HTTPServer((args.host, args.port), Handler)
    print(f"serving the front page on http://{args.host}:{args.port}/news.json"
          + ("  (live)" if args.live else ""))
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
