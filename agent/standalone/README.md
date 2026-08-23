# The desk, standalone

There is no server-side application *here*. The "backend" is an agent with a market-data connection
and a directory, and the contract between it and the firmware is one JSON file plus some tiles. The
board polls a URL; anything that can serve that URL works, so the least machinery that can produce
it wins.

> **This is the standalone path, and it still works.** It needs no Docker, no domain and no
> container: a `launchd` job, a directory, and `python3 -m http.server`. If the board and this
> machine are on the same network and this machine is awake when the board polls, stop here.
>
> [`server/`](../../server/README.md) is the other path — an always-on service that can be *told*
> things: a command queue agents push into from anywhere, a schedule, and a typesetting gate on
> every candidate page. [`agent/README.md`](../README.md) is the containerized worker that talks to
> it. Both **reuse this directory rather than replacing it**: `PROMPT.md` is still the standing
> instructions handed to the agent, `render-check.sh` is still the gate, and
> `mock_news_server.py --validate` is still the schema check. What the desk adds is somewhere to put
> an instruction at three in the morning. See [docs/desk-server.md](../../docs/desk-server.md).

Twice a day, `file-edition.sh` wakes Claude Code headless, hands it
[`PROMPT.md`](../../tools/edition/PROMPT.md) — the desk's standing instructions — and lets it research **one company**
and write a two-page edition into `$EDITION_DIR` (default `~/.wpnews/edition`):

```
~/.wpnews/edition/
  watchlist.json        the candidates and the rotation   (you write this)
  news.json             the edition                       (the desk writes this)
  tiles/<id>.bin        one 4 bpp tile per picture        (the desk writes these)
  log/                  a week of transcripts, filed editions and proof sheets
```

**One company an edition.** A1 is why the price moved, whether the tape moved with it, what else
happened to the company this week, and its numbers in a rail down the side; A2 is the same
company's accounts. This is not a portfolio digest — the sixteen-quote watchlist the earlier
version printed is gone, and a reader who wants a table of quotes is holding the wrong object.

`news.json` is [the contract](../../docs/news-contract.md). The desk writes it **last** and writes
it atomically — to `news.json.tmp`, then rename — because the board may poll mid-write and a
half-written page is a rejected payload. A rejected payload is survivable, the board keeps the
previous edition and badges it `STALE`, but a whole wasted cycle is not.

## The watchlist

`$EDITION_DIR/watchlist.json` is the only thing you have to write. The desk reads it first, and
writes a default if it is missing.

```json
{ "symbols": ["NVDA", "AAPL", "MSFT", "AMD", "TSM", "AVGO"],
  "last":    "AAPL" }
```

The desk takes the next symbol after `last`, wrapping, and updates `last` when it files — so the
board works through the list a company at a time. It is allowed to break the rotation when one of
the others did something that genuinely outranks it: an earnings print, a guide, a downgrade that
moved the stock several percent. A newspaper covers what happened.

**The board never chooses.** It prints the company the payload names, which is the same rule the
rest of this system runs on: the server decides what is important, the device decides what fits.
Moving the selection into the firmware would put an editorial decision on the one machine with no
way to research it.

## Filing one edition by hand

```bash
./agent/standalone/file-edition.sh              # file now, into $EDITION_DIR
./agent/standalone/file-edition.sh --serve      # file now, then serve until interrupted
./agent/standalone/file-edition.sh --serve-only # serve what is already there
EDITION_DIR=/tmp/try ./agent/standalone/file-edition.sh
```

Do this once before installing anything. It runs `claude --print`, so it exits when it is done and
the whole transcript lands in `$EDITION_DIR/log/`, which is where a filing that produced nothing
explains itself.

The tool allowlist is narrow rather than `--dangerously-skip-permissions`: reads and writes, search,
the Alpaca MCP tools, and exactly three scripts — `tools/make_tile.py`, `tools/mock_news_server.py`
and `tools/edition/render-check.sh`. The desk needs nothing else.

## The desk sets the type before it files

This is the part that is easy to skip and the part that matters most. **The desk cannot see the
paper.** It writes JSON; twenty minutes later a panel on a wall spends twenty-five seconds turning
that JSON into type, and if the lead headline was four characters too long the reader gets an
ellipsis in the middle of a sentence and nobody finds out. Validating the schema does not catch
that. Only setting the type catches it.

So `PROMPT.md` requires, and `file-edition.sh` re-runs as a gate:

```bash
tools/edition/render-check.sh "$EDITION_DIR/news.json"
```

That runs the **real typesetter** — the same `news_core`, the same seven faces, the same
compositor, the same six-ink quantizer the firmware runs — over the candidate payload at the
panel's real 1200 × 1600, and leaves both sheets as PNGs. It fails what the build fails: a missing
glyph, a rule off its row, ink outside the margin, a module that rendered nothing, a label wider
than its slot, a masthead over 1140 px, blue or yellow reaching the glass, a composition that does
not tile the well. Anything it lets through will print.

Then the desk is told to **look at the sheets** — it can see images — because the mechanical checks
cannot tell it that a column ran short, that a headline broke on the wrong word, that the page is
grey because nothing on it is set larger than a deck, or that the photograph halftoned to mush.

Before that it still runs

```bash
python3 tools/mock_news_server.py --validate "$EDITION_DIR/news.json"
```

which is the cheap check: the schema, the length budget, and the tiles. Both run, because they fail
different things and the fast one gives a better error message.

It **fails** on anything that will be wrong on the glass: a headline or deck past the measure it is
set in, a string past the C array that carries it, a chart index naming a chart that was not sent, a
tile that is missing or the wrong size, a character the fonts cannot draw, a payload the device would
reject outright.

Two limits sit behind each field. The **character** budget is what a copy desk can act on, and it is
counted in characters because an em dash is one character of measure — failing a headline for being
three bytes over when it sets perfectly well would be worse than not checking. The **byte** capacity
is the fixed array in `news_model.h`, and it is the failure with nothing to show for it:
`news_str_copy()` trims and the value simply stops, where an over-long headline at least prints a
visible `…`. It should essentially never fire for ASCII; when it does, the payload carried
typography, which is exactly the case where the character count looks fine and the field runs out.

Six of `PROMPT.md`'s numbers **warn** rather than fail — kicker, brief text, figure label, figure
value, column header, table cell. Those are margins held inside their arrays, not limits, so a field
a character or two past one of them still typesets on most days.

**Which make-up is the tight one is not the same for every field**, so where it matters `PROMPT.md`
says so on the row itself rather than this file asserting it once for all six. The dossier is no
longer a fixed 170 px column: it is one column when it stands as the rail beside a body and wider
when the day gives it more, and the figures change *face* as well as measure when it does — so a
wider rail is not automatically a more forgiving one. A budget reasoned from any single width would
be true of one make-up and quietly false of the other. `sim --measure` is the authority on what a
face sets at a width, and neither this file nor `PROMPT.md` keeps its own copy.

Failing there would leave yesterday's page on the glass over a house-style preference, which is this
project's own policy — clamp, do not reject — inverted.

They still fail if they overrun the array behind them, and that is the division worth remembering:
**the array is the contract and fails; the margin is the house style and warns.**

It looks for each picture at `<the payload's directory>/tiles/<id>.bin` and holds it to exactly
`w * h / 2` bytes, which is the layout `file-edition.sh` files an edition in. The one payload that
does not live that way is the committed fixture — its pictures are in `sim/tiles/`, because that is
where the simulator reads them from — so it is checked with the base overridden:

```bash
python3 tools/mock_news_server.py \
    --validate components/news_core/test/host/fixtures/news.json --tiles sim/tiles
```

`--tiles` exists only for that. A real edition gets the strict default, because a desk that wrote
`news.json` and never made the pictures is exactly what this catches, and a missing `tiles/`
directory is that failure rather than a reason to skip the check.

The same validation guards `--write-fixture`, tiles included: the fixture is what `test_news_mock`
holds `news_mock.c` against, so one describing pictures nobody packed would make the demo edition
quietly wrong until somebody looked at a screenshot.

The script then copies the edition **and its proof sheets** into `log/` and deletes anything there
older than seven days. The board only ever reads the current one, but when a page comes out wrong
the question is always "what changed since yesterday" — and that answer is usually visible rather
than in the JSON.

## Installing the two agents

```bash
cp agent/standalone/com.wpnews.edition.plist ~/Library/LaunchAgents/
cp agent/standalone/com.wpnews.serve.plist   ~/Library/LaunchAgents/
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
differ, or run this once instead of hand-editing both:

```bash
sed -i '' "s|/Users/YOUR-USERNAME|$HOME|g" agent/standalone/*.plist
```

`PATH` is spelled out rather than inherited for the same reason: launchd does not run a login
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
