#!/usr/bin/env python3
"""A mock desk, for looking at the app's papers on a simulator.

Serves the four control-plane routes the papers feature reads, plus the device
plane, over ONE payload: the reference producer's committed fixture, with the
subject's symbol and name swapped per company so the five pages are visibly
different newspapers rather than five copies of one.

It wraps tools/mock_news_server.py rather than copying it. That module owns the
fixture, the tile directory and the ETag recipe the real desk uses; a second
snapshot here would be a second thing to keep in step with news_mock.c, which
is the one equivalence this repository tests for in both directions.

    python3 tools/mock_desk_server.py --port 8199 --token dev-operator-token
    python3 tools/mock_desk_server.py --fail-symbol TSLA   # one page fails

Not a test and not a server anybody should point a board at: there is no
authorization worth the name, the papers are made up, and every edition id is
derived from the symbol.
"""

import argparse
import copy
import hashlib
import json
import os
import re
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import mock_news_server as producer  # noqa: E402

# Five companies, the fixture's own first among them so page 0 is the paper the
# board is showing. `hours` is how long ago the desk "wrote" it, which is what
# the page header and the Board row are drawn from.
PAPERS = [
    ("SNDK", "SanDisk", 2),
    ("TSLA", "Tesla", 9),
    ("MU", "Micron", 27),
    ("AAPL", "Apple", 51),
    ("BRK.B", "Berkshire Hathaway", None),   # no paper: the placeholder page
]

SYMBOL_RE = re.compile(r"^[A-Z0-9.\-]{1,8}$")
EID_RE = re.compile(r"^[0-9a-f]{16}$")


def edition_id(symbol):
    """Deterministic, so a reload keeps the app's cache warm."""
    return hashlib.sha256(symbol.encode()).hexdigest()[:16]


def payload_for(symbol, name):
    """The fixture, with this company's name on it."""
    doc = copy.deepcopy(producer.snapshot())
    doc["subject"]["symbol"] = symbol
    doc["subject"]["name"] = name
    return doc


def papers_doc(board_symbol):
    now = int(time.time())
    rows = []
    for symbol, name, hours in PAPERS:
        if hours is None:
            rows.append({
                "symbol": symbol, "name": name, "edition_id": None,
                "created_at": None, "lang": None, "headline": None,
                "on_board": False, "stale": True,
            })
            continue
        doc = payload_for(symbol, name)
        lead = (doc.get("stories") or [{}])[0]
        rows.append({
            "symbol": symbol,
            "name": name,
            "edition_id": edition_id(symbol),
            "created_at": now - hours * 3600,
            "lang": doc.get("lang", "en"),
            "headline": lead.get("headline"),
            "on_board": symbol == board_symbol,
            "stale": hours >= 12,
        })
    return {"ok": True, "papers": rows, "board": edition_id(board_symbol)}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    timeout = 30
    token = "dev-operator-token"
    board = "SNDK"
    settings = {"lang": "en", "paper_refresh_hours": 12}
    # --fail-symbol puts one company in the list and refuses its edition, which
    # is the only way to see a single FAILED page inside a working pager: a
    # desk that is simply down takes the list with it and the phone falls back
    # to its one stored edition instead.
    fail_symbol = None

    def _authed(self):
        return self.headers.get("Authorization", "") == "Bearer " + self.token

    def _json(self, status, doc, etag=None):
        body = json.dumps(doc, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        if etag is not None:
            self.send_header("ETag", etag)
        self.send_header("Connection", "keep-alive")
        self.end_headers()
        self.wfile.write(body)

    def _bytes(self, data):
        self.send_response(200)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Connection", "keep-alive")
        self.end_headers()
        self.wfile.write(data)

    def _symbol_of(self, eid):
        for symbol, _name, hours in PAPERS:
            if hours is not None and edition_id(symbol) == eid:
                return symbol
        return None

    def do_GET(self):
        path = self.path.split("?")[0]

        # The device plane, unauthenticated, exactly as the real desk serves it.
        # This is what Today reads WITHOUT a token, and the floor the pager is
        # laid over.
        if path in ("/news.json", "/"):
            name = next(n for s, n, _ in PAPERS if s == Handler.board)
            doc = payload_for(Handler.board, name)
            return self._json(200, doc, producer.Handler.etag_for(doc))
        if path.startswith("/tiles/") and path.endswith(".bin"):
            return self._tile(path[len("/tiles/"):-len(".bin")])

        if not self._authed():
            return self._json(401, {"ok": False, "error": "unauthorized"})

        if path == "/api/papers":
            return self._json(200, papers_doc(Handler.board))

        if path == "/api/settings":
            return self._json(200, {"ok": True, "source": "file",
                                    "settings": Handler.settings})

        m = re.match(r"^/api/editions/([0-9a-f]{16})/news\.json$", path)
        if m:
            symbol = self._symbol_of(m.group(1))
            if symbol is None:
                return self._json(404, {"ok": False, "error": "not_found"})
            if symbol == Handler.fail_symbol:
                return self._json(500, {"ok": False, "error": "server_error"})
            name = [n for s, n, _ in PAPERS if s == symbol][0]
            doc = payload_for(symbol, name)
            etag = producer.Handler.etag_for(doc)
            if etag in [t.strip() for t in
                        self.headers.get("If-None-Match", "").split(",") if t.strip()]:
                self.send_response(304)
                self.send_header("ETag", etag)
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            return self._json(200, doc, etag)

        m = re.match(r"^/api/editions/[0-9a-f]{16}/tiles/(.+)\.bin$", path)
        if m:
            return self._tile(m.group(1))

        return self._json(404, {"ok": False, "error": "not_found"})

    def _tile(self, tile_id):
        if not producer.TILE_ID_RE.match(tile_id):
            return self._json(404, {"ok": False, "error": "not_found"})
        try:
            with open(os.path.join(producer.SIM_TILES, tile_id + ".bin"), "rb") as f:
                return self._bytes(f.read())
        except OSError:
            return self._json(404, {"ok": False, "error": "not_found"})

    def do_POST(self):
        path = self.path.split("?")[0]
        if not self._authed():
            return self._json(401, {"ok": False, "error": "unauthorized"})
        m = re.match(r"^/api/papers/([A-Z0-9.\-]{1,8})/publish$", path)
        if not m:
            return self._json(404, {"ok": False, "error": "not_found"})
        symbol = m.group(1)
        row = [(s, h) for s, _n, h in PAPERS if s == symbol]
        if not row or row[0][1] is None:
            return self._json(404, {"ok": False, "error": "no_paper"})
        state = "unchanged" if symbol == Handler.board else "published"
        Handler.board = symbol
        return self._json(200, {"ok": True, "edition_id": edition_id(symbol),
                                "state": state})

    def do_PUT(self):
        if self.path.split("?")[0] != "/api/settings":
            return self._json(404, {"ok": False, "error": "not_found"})
        if not self._authed():
            return self._json(401, {"ok": False, "error": "unauthorized"})
        n = int(self.headers.get("Content-Length", "0"))
        try:
            doc = json.loads(self.rfile.read(n) or b"{}")
        except ValueError:
            return self._json(400, {"ok": False, "error": "bad_settings"})
        # The real desk refuses an unknown key over the WHOLE document, and this
        # mock does too. That refusal is why putSettings omits
        # paper_refresh_hours when it holds no number rather than sending a
        # literal null: one key the desk will not take loses the language write
        # sent beside it.
        # Which keys the phone actually sent is the thing worth seeing here:
        # whether paper_refresh_hours rode along beside lang is invisible in
        # the result, because a partial merge lands on the same document.
        sys.stderr.write("  PUT body keys: %s\n" % ", ".join(sorted(doc)))
        for key in doc:
            if key not in ("lang", "paper_refresh_hours"):
                return self._json(400, {"ok": False, "error": "bad_settings",
                                        "detail": "unknown key: " + key})
        Handler.settings = {**Handler.settings, **doc}
        return self._json(200, {"ok": True, "source": "file",
                                "settings": Handler.settings})

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))


def main():
    ap = argparse.ArgumentParser()
    # 8199, not 8080: this machine's live desk already holds 127.0.0.1:8080, and binding
    # 0.0.0.0:8080 here would succeed silently while every request still reached that other
    # server first — see task-14-report.md's tooling notes.
    ap.add_argument("--port", type=int, default=8199)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--token", default="dev-operator-token")
    ap.add_argument("--fail-symbol", default=None,
                    help="answer 500 for this company's edition, so one page "
                         "of the pager fails while the rest load")
    args = ap.parse_args()
    Handler.token = args.token
    Handler.fail_symbol = args.fail_symbol
    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    sys.stderr.write("mock desk on http://%s:%d, token %s\n"
                     % (args.host, args.port, args.token))
    srv.serve_forever()


if __name__ == "__main__":
    main()
