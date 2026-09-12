#!/usr/bin/env python3
"""Every desk behaviour the phone depends on, asked of a desk that is running.

    python3 server/test/contract.py                       # the local desk
    python3 server/test/contract.py --desk https://…      # through the tunnel
    python3 server/test/contract.py --write               # include round trips
    python3 server/test/contract.py --expect-red market   # for the deploy loop

WHAT THIS IS, AND WHAT ``server/test/run.sh`` IS NOT. ``run.sh`` proves the
desk's logic with stubs: no socket, no Docker, no image. It is the right gate
before a build and it cannot tell you that the *thing now serving* is the thing
you built. This file is the other half. It speaks HTTP to a live desk, over the
same routes and with the same token the app uses, and every check is named for
the screen that breaks when it fails -- because the failure this exists to catch
does not look like an error. It looks like an empty tab on somebody's phone.

WHY IT IS ORGANISED BY TAB. A contract suite sorted by URL tells you that
``/api/market/summary`` answered 404. Sorted by screen it tells you that the
Info tab is dead, which is the sentence somebody actually needs. The phone has
four tabs and every check below belongs to one of them.

THE ``--expect-red`` FLAG is what makes this usable for test-first deployment.
Given a group name it INVERTS the outcome for that group: the run passes only if
those checks FAIL. That is the red half of red-green, and it is not ceremony --
running it against the desk currently in service is the only way to know that a
check tests the change you are about to deploy rather than something that was
already true. A check that is green before the deploy proves nothing about the
deploy. See ``.claude/skills/deploy-desk/SKILL.md``.

Nothing here writes unless ``--write`` is given, and what it writes it puts
back. The desk it is pointed at is somebody's live newspaper.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

DEFAULT_DESK = "http://127.0.0.1:8790"
TIMEOUT = 45

#: Which tab each group belongs to, for the summary and for --expect-red.
GROUPS = ("device", "edition", "board", "markets", "settings", "ask")


class Failure(Exception):
    """A check that did not hold. The message is read by a person."""


# ---------------------------------------------------------------- transport --

class Desk:
    def __init__(self, base: str, token: str | None) -> None:
        self.base = base.rstrip("/")
        self.token = token

    def request(self, path: str, method: str = "GET", body: object = None,
                token: bool = True, raw: bool = False):
        """Return (status, parsed-or-bytes). A 4xx is data here, not an error:
        several checks below are ABOUT the refusal."""
        url = self.base + path
        data = None
        headers = {}
        if body is not None:
            data = json.dumps(body).encode()
            headers["Content-Type"] = "application/json"
        if token and self.token:
            headers["Authorization"] = "Bearer " + self.token
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
                payload = r.read()
                return r.status, (payload if raw else _json_or_none(payload))
        except urllib.error.HTTPError as e:
            payload = e.read()
            return e.code, (payload if raw else _json_or_none(payload))
        except Exception as e:                                     # noqa: BLE001
            raise Failure(f"{method} {path}: {type(e).__name__}") from None


def _json_or_none(payload: bytes):
    try:
        return json.loads(payload.decode("utf-8", "replace"))
    except ValueError:
        return None


def want(status: int, expected, path: str):
    allowed = expected if isinstance(expected, tuple) else (expected,)
    if status not in allowed:
        raise Failure(f"{path} answered {status}, wanted {' or '.join(map(str, allowed))}")


# ------------------------------------------------------------------ checks --
#
# Each returns a short sentence for the log when it holds, and raises Failure
# with a sentence somebody can act on when it does not.

CHECKS: list[tuple[str, str, str, object]] = []


def check(group: str, screen: str, name: str):
    def wrap(fn):
        CHECKS.append((group, screen, name, fn))
        return fn
    return wrap


# -- the device plane: what the board reads, and what the Today tab reads ----

@check("device", "Today tab and the board", "the edition is served without a token")
def _edition_is_public(d: Desk, _w):
    status, doc = d.request("/news.json", token=False)
    if status == 404:
        return "no edition filed yet (404) — a complete state, not a failure"
    want(status, 200, "/news.json")
    if not isinstance(doc, dict):
        raise Failure("/news.json did not answer a JSON object")
    return f"edition for {doc.get('ticker') or doc.get('company') or 'a company'}"


@check("device", "Today tab and the board", "health needs no credential")
def _health(d: Desk, _w):
    status, _ = d.request("/healthz", token=False)
    want(status, 200, "/healthz")
    return "healthz 200"


@check("device", "every screen", "the control plane refuses an anonymous caller")
def _control_plane_is_closed(d: Desk, _w):
    # The one property the two-plane split exists to have. If this ever passes
    # without a token, everything else in this file is beside the point.
    for path in ("/api/settings", "/api/positions", "/api/market/summary?symbol=AAPL&modules=price"):
        status, _ = d.request(path, token=False)
        if status != 401:
            raise Failure(f"{path} answered {status} WITHOUT A TOKEN, wanted 401")
    return "settings, positions and market all 401 unauthenticated"


# -- Settings tab -----------------------------------------------------------

@check("settings", "Settings tab", "the edition language can be read")
def _settings_read(d: Desk, _w):
    status, doc = d.request("/api/settings")
    want(status, 200, "/api/settings")
    lang = (doc or {}).get("settings", {}).get("lang")
    if not isinstance(lang, str) or lang == "":
        raise Failure("settings answered without a language; the selector would show nothing")
    return f"lang={lang}"


@check("settings", "Settings tab", "the language survives a round trip")
def _settings_round_trip(d: Desk, write):
    if not write:
        return "skipped (needs --write)"
    status, doc = d.request("/api/settings")
    want(status, 200, "/api/settings")
    before = doc["settings"]["lang"]
    status, _ = d.request("/api/settings", "PUT", {"lang": before})
    want(status, 200, "PUT /api/settings")
    status, doc = d.request("/api/settings")
    if doc["settings"]["lang"] != before:
        raise Failure(f"language changed under a no-op write: {before} -> {doc['settings']['lang']}")
    return f"wrote {before} back and it stuck"


@check("settings", "Settings tab", "the phones the desk would push to are listed")
def _push_devices(d: Desk, _w):
    status, doc = d.request("/api/push/devices")
    want(status, 200, "/api/push/devices")
    push = (doc or {}).get("push")
    # Exactly what `pushOf` in app/src/lib/desk.ts accepts, and no more. A null
    # `push` is a desk that has never been told about a phone, which the app
    # reads as no devices rather than as a malformed answer -- writing a
    # stricter check here than the app enforces would fail a deploy over a
    # state the app handles perfectly well.
    if push is None:
        return "no phone registered yet (push: null) — a complete state"
    if not isinstance(push, dict) or not isinstance(push.get("devices"), list):
        raise Failure("push answered a document this app cannot read")
    return f"{len(push['devices'])} phone(s) registered"


@check("settings", "Settings tab", "what the owner holds is readable")
def _positions(d: Desk, _w):
    status, doc = d.request("/api/positions")
    want(status, (200, 404), "/api/positions")
    if status == 404:
        return "no positions filed (404) — a complete state"
    if "positions" not in (doc or {}):
        raise Failure("positions answered without a `positions` key")
    return "positions readable"


# -- Board tab --------------------------------------------------------------

@check("board", "Board tab", "the papers list is readable")
def _papers(d: Desk, _w):
    status, doc = d.request("/api/papers")
    want(status, 200, "/api/papers")
    papers = (doc or {}).get("papers")
    if not isinstance(papers, list):
        raise Failure("papers answered a list this app cannot read")
    return f"{len(papers)} paper(s)"


@check("board", "Board tab", "the event book is readable")
def _calendar(d: Desk, _w):
    status, doc = d.request("/api/calendar")
    want(status, (200, 404), "/api/calendar")
    if status == 404:
        return "no event book filed (404) — a complete state"
    if "calendar" not in (doc or {}):
        raise Failure("calendar answered without a `calendar` key")
    return "event book readable"


# -- Markets tab: the prices, and the plane that had to move to the desk ----

@check("markets", "Markets tab", "watchlist prices are proxied")
def _quotes(d: Desk, _w):
    status, doc = d.request("/api/quotes?symbols=AAPL")
    want(status, (200, 404), "/api/quotes")
    if status == 404 and (doc or {}).get("error") == "no_quotes":
        return "no Alpaca key on this desk (404 no_quotes) — a complete configuration"
    if not isinstance((doc or {}).get("quotes"), dict):
        raise Failure("quotes answered a document this app cannot read")
    return "quotes readable"


@check("market", "Info tab", "the profile and key figures arrive")
def _market_summary(d: Desk, _w):
    path = ("/api/market/summary?symbol=AAPL"
            "&modules=assetProfile,summaryDetail,defaultKeyStatistics")
    status, doc = d.request(path)
    if status == 404:
        raise Failure("the market plane is NOT MOUNTED — this desk predates it, "
                      "and the Info, Calendar and Options tabs are all dead")
    want(status, 200, path)
    r = (doc or {}).get("result") or {}
    ap, sd = r.get("assetProfile") or {}, r.get("summaryDetail") or {}
    if not ap.get("sector"):
        raise Failure("no sector — the Info tab's profile card would be blank")
    if not (sd.get("marketCap") or {}).get("raw"):
        raise Failure("no market cap — the Info tab's stat grid would be blank")
    return f"{ap['sector']} / {ap.get('industry')}, cap {sd['marketCap'].get('fmt')}"


@check("market", "Calendar tab", "the dates and past quarters arrive")
def _market_calendar(d: Desk, _w):
    path = "/api/market/summary?symbol=AAPL&modules=calendarEvents,earningsHistory"
    status, doc = d.request(path)
    if status == 404:
        raise Failure("the market plane is NOT MOUNTED — the Calendar tab is dead")
    want(status, 200, path)
    r = (doc or {}).get("result") or {}
    if "calendarEvents" not in r:
        raise Failure("no calendarEvents — the Calendar tab would show nothing upcoming")
    return "calendar modules present"


@check("market", "Options tab", "the chain arrives WITH open interest")
def _market_options(d: Desk, _w):
    status, doc = d.request("/api/market/options?symbol=AAPL")
    if status == 404:
        raise Failure("the market plane is NOT MOUNTED — the Options tab is dead")
    want(status, 200, "/api/market/options")
    r = (doc or {}).get("result") or {}
    front = (r.get("options") or [{}])[0]
    calls = front.get("calls") or []
    if not calls:
        raise Failure("the front expiry carried no calls")
    # Open interest is the field a reshaping would most plausibly drop, and
    # dropping it does not blank the tab: max pain reports nothing and the
    # put/call ratio reports zero, which is the kind of wrong that gets believed.
    if not any(c.get("openInterest") for c in calls):
        raise Failure("no contract carried openInterest — max pain and the "
                      "put/call ratio would be silently wrong, not blank")
    return f"{len(r.get('expirationDates') or [])} expiries, open interest present"


@check("market", "Markets tab", "a Korean listing is answered too")
def _market_korean(d: Desk, _w):
    path = "/api/market/summary?symbol=005930.KS&modules=assetProfile,summaryDetail"
    status, doc = d.request(path)
    if status == 404:
        raise Failure("the market plane is NOT MOUNTED")
    want(status, 200, path)
    ap = ((doc or {}).get("result") or {}).get("assetProfile") or {}
    if not ap.get("sector"):
        raise Failure("005930.KS answered without a sector — the symbol pattern "
                      "may have been narrowed to US tickers")
    return "005930.KS answered"


@check("market", "Markets tab", "a symbol that is not one is refused, not proxied")
def _market_rejects_junk(d: Desk, _w):
    status, _ = d.request("/api/market/summary?symbol=A%26crumb%3Dx&modules=price")
    if status == 404:
        raise Failure("the market plane is NOT MOUNTED")
    want(status, 400, "a malformed symbol")
    return "400 on a symbol that could reach a query string"


@check("market", "Markets tab", "an unlisted module is refused")
def _market_module_whitelist(d: Desk, _w):
    status, _ = d.request("/api/market/summary?symbol=AAPL&modules=incomeStatementHistory")
    if status == 404:
        raise Failure("the market plane is NOT MOUNTED")
    want(status, 400, "an unlisted module")
    return "400 on a module outside the whitelist"


# -- the Ask screen ---------------------------------------------------------

@check("ask", "Ask screen", "the command queue is readable")
def _commands(d: Desk, _w):
    status, doc = d.request("/api/commands")
    want(status, 200, "/api/commands")
    if not isinstance((doc or {}).get("commands"), list):
        raise Failure("commands answered a queue this app cannot read")
    return f"{len((doc or {}).get('commands'))} command(s)"


# -------------------------------------------------------------------- main --

def token_from_disk() -> str | None:
    path = os.path.expanduser("~/.claudepost/tokens.json")
    try:
        with open(path, encoding="utf-8") as f:
            doc = json.load(f)
    except OSError:
        return None
    for entry in doc.get("tokens", []):
        if entry.get("scope") == "operator":
            return entry.get("token")
    for entry in doc.get("tokens", []):
        if entry.get("scope") == "producer":
            return entry.get("token")
    return None


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--desk", default=os.environ.get("DESK", DEFAULT_DESK))
    ap.add_argument("--token", default=os.environ.get("CLAUDEPOST_TOKEN"))
    ap.add_argument("--write", action="store_true",
                    help="include the round trips that write and put back")
    ap.add_argument("--only", help="run one group only")
    ap.add_argument("--expect-red", metavar="GROUP",
                    help="invert GROUP: pass only if those checks FAIL")
    args = ap.parse_args()

    token = args.token or token_from_disk()
    if token is None:
        print("contract: no token — pass --token or put one in ~/.claudepost/tokens.json",
              file=sys.stderr)
        return 2

    desk = Desk(args.desk, token)
    print(f"== {args.desk}  ({'with' if args.write else 'without'} writes)")

    passed = failed = 0
    red_seen = red_expected = 0
    screen_now = None

    for group, screen, name, fn in CHECKS:
        if args.only and group != args.only:
            continue
        if screen != screen_now:
            print(f"\n-- {screen}")
            screen_now = screen
        inverted = args.expect_red is not None and group == args.expect_red
        if inverted:
            red_expected += 1
        try:
            note = fn(desk, args.write)
            if inverted:
                print(f"   NOT RED  {name}: {note}")
                failed += 1
            else:
                print(f"   ok       {name}: {note}")
                passed += 1
        except Failure as e:
            if inverted:
                print(f"   red      {name}: {e}")
                red_seen += 1
                passed += 1
            else:
                print(f"   FAILED   {name}: {e}")
                failed += 1

    print()
    if args.expect_red is not None:
        if red_expected == 0:
            print(f"contract: --expect-red {args.expect_red} matched no checks", file=sys.stderr)
            return 2
        if red_seen != red_expected:
            print(f"NOT RED: {red_expected - red_seen} of {red_expected} "
                  f"'{args.expect_red}' checks already pass. They are not testing "
                  f"the change you are about to deploy.", file=sys.stderr)
            return 1
        print(f"RED as expected: all {red_seen} '{args.expect_red}' checks fail. Deploy.")
        return 0

    print(f"{passed} passed, {failed} failed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
