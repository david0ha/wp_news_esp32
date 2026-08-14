# The desk

There is no server-side application. The "backend" is an agent with a market-data connection and a
directory, and the contract between it and the firmware is one JSON file plus some tiles. The board
polls a URL; anything that can serve that URL works, so the least machinery that can produce it wins.

Twice a day, `file-edition.sh` wakes Claude Code headless, hands it
[`PROMPT.md`](PROMPT.md) — the desk's standing instructions — and lets it research the symbols the
owner named and write a front page into `$EDITION_DIR` (default `~/.wpnews/edition`):

```
~/.wpnews/edition/
  watchlist.json        what to report on          (you write this)
  news.json             the front page             (the desk writes this)
  tiles/<id>.bin        one 4 bpp tile per photo   (the desk writes these)
  log/                  a week of transcripts and filed editions
```

`news.json` is [the contract](../../docs/news-contract.md). The desk writes it **last** and writes
it atomically — to `news.json.tmp`, then rename — because the board may poll mid-write and a
half-written page is a rejected payload. A rejected payload is survivable, the board keeps the
previous edition and badges it `STALE`, but a whole wasted cycle is not.

## The watchlist

`$EDITION_DIR/watchlist.json` is the only thing you have to write. The desk reads it first, and
writes a default if it is missing.

```json
{ "holdings": ["NVDA", "AAPL", "MSFT"],
  "watch":    ["AMD", "TSM", "AVGO", "COST", "XOM"],
  "indices":  ["SPY", "QQQ", "DIA", "IWM", "VIX"] }
```

The three keys map onto three places on the sheet. `holdings` are the owner's own positions and get
the portfolio rail in band 6; `watch` fills the quotation table in band 7; `indices` fill the five
cells of the ribbon across the top. The board reads that split off the **order** of `tickers[]` in
the payload — the first eight go to the rail, the next eight to the table — so `holdings` first and
`watch` after is not a convention, it is the wire format.

Sixteen quotes and five indices is the page full. More than that is dropped by the parser.

## Filing one edition by hand

```bash
./tools/edition/file-edition.sh              # file now, into $EDITION_DIR
./tools/edition/file-edition.sh --serve      # file now, then serve until interrupted
./tools/edition/file-edition.sh --serve-only # serve what is already there
EDITION_DIR=/tmp/try ./tools/edition/file-edition.sh
```

Do this once before installing anything. It runs `claude --print`, so it exits when it is done and
the whole transcript lands in `$EDITION_DIR/log/`, which is where a filing that produced nothing
explains itself.

The tool allowlist is narrow rather than `--dangerously-skip-permissions`: reads and writes, search,
the Alpaca MCP tools, and exactly two scripts — `tools/make_tile.py` and `tools/mock_news_server.py`.
The desk needs nothing else.

Before it reports success the script runs

```bash
python3 tools/mock_news_server.py --validate "$EDITION_DIR/news.json"
```

which checks what the device checks plus the length budget the device *cannot* check, because the
device ellipsizes rather than failing. A headline four characters over budget is not a validation
error on the board, it is a `…` in the middle of a sentence six hours later.

It then copies the edition into `log/` and deletes anything there older than seven days. The board
only ever reads the current one, but when a page comes out wrong the question is always "what
changed since yesterday", and that needs yesterday.

## Installing the two agents

```bash
cp tools/edition/com.wpnews.edition.plist ~/Library/LaunchAgents/
cp tools/edition/com.wpnews.serve.plist   ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.wpnews.edition.plist
launchctl load ~/Library/LaunchAgents/com.wpnews.serve.plist
launchctl start com.wpnews.edition        # file one now, to check the scheduled path works
```

Then point the board at the serving machine, once:

```bash
curl -X POST http://wpnews.local/api/news \
     -d '{"url":"http://mymac.local:8123/news.json"}'
```

Both plists carry **absolute paths**, including to this checkout and to `$HOME` — edit them if yours
differ. `PATH` is spelled out rather than inherited for the same reason: launchd does not run a login
shell, so it has no PATH worth the name, no nvm, no pyenv and no idea where `claude` lives. Every one
of those is a way this fails silently at 6 a.m., and `file-edition.sh` checks for `claude` on PATH
first and says so rather than producing an empty page.

`RunAtLoad` is off for the filing job: loading the agent should not spend an API call. It is on, with
`KeepAlive`, for the serving job.

## Why filing and serving are two jobs

Filing is an **event** that happens twice a day and can fail. Serving is a **condition** that must
hold continuously, because the board polls every five minutes and does not care that nothing new has
been filed since dawn.

Putting both in one job means a failed filing takes the served page down with it — which converts a
stale paper, the failure the firmware is designed to survive and badge, into no paper at all. So
`com.wpnews.serve` runs `--serve-only` forever under `KeepAlive`, and `com.wpnews.edition` comes and
goes on its schedule beside it.

## Why twice, and why those two times

The schedule is pinned to the New York session, not to the clock:

| KST | why |
|---|---|
| **06:00** | the morning paper. The US close is 05:00 KST (06:00 in winter), so this is the first moment a complete day exists to report on. |
| **22:00** | the evening paper, half an hour before the US open, so the board shows what is about to happen rather than what already did. |

Twice, not more. A refresh on this panel takes twenty-five to thirty seconds and flashes the whole
sheet; a board that does that six times a day is a board people stop looking at. The device also
fingerprints every snapshot and skips the refresh entirely when nothing it draws has changed, so
filing more often costs nothing but rarely buys anything either.

launchd fires a missed `StartCalendarInterval` as soon as the machine wakes, which is what saves a
board that would otherwise show yesterday's paper because a lid was shut overnight.

A weekend or a holiday is not a reason to file nothing — the board is on a wall and shows whatever it
last received. `PROMPT.md` tells the desk to file the week's story instead and set `session` honestly.

## What this exposes

`--serve-only` is `python3 -m http.server` bound to `0.0.0.0`, serving `$EDITION_DIR` **read-only
over plain HTTP with no authentication**. Everything in that directory is reachable, not just
`news.json` — the watchlist naming the owner's positions, the tiles, and `log/`, which holds a week
of filed editions and the agent's own transcripts.

That is the same posture as the rest of this project's LAN services and the same one the firmware
expects. It suits a home network and nothing else. Do not put it on a network you do not control, and
do not port-forward it.
