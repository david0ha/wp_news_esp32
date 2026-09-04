# The desk server

The board polls one URL and nothing in the firmware knows what answers it.
[`agent/standalone/`](../agent/standalone/README.md) answers it from a Mac on the LAN;
[`publish.sh`](hosting-cloudflare.md) answers it from a Cloudflare Worker. Both
are *publishing* mechanisms — something files an edition, something else copies
it somewhere — and **neither can be told anything.**

This is the third thing: a service that can be *asked*, from anywhere, at any
time, by anything holding a token. It runs in a container, it is reachable
through a Cloudflare tunnel, and it decides when a new page is allowed to reach
the glass.

[`server/README.md`](../server/README.md) is how to run it. This is why it looks
the way it does.

## What it is for

One sentence: **an agent that runs for its owner every day, that can reach the
paper on the wall from wherever it happens to be running.**

Concretely — at three in the morning, from a phone, from a cloud routine, from a
session on another machine — *look into this*, *put this company on tomorrow's
front page*, *never print that one again*, *don't wake the wall before six*.
Four sentences, four different kinds of statement, and most of the design is
about keeping them different.

## The three facts everything else follows from

**1. A refresh costs twenty-five seconds of the whole sheet flashing, and there
is no partial one.** Everything about *when* the served bytes may change follows
from this. `news_hash()` fingerprints what reaches the glass and `NewsTask`
compares before it notifies `UiTask`, so the desk controls the panel completely
by controlling when the payload changes. **A quiet window is not a firmware
feature; it is the server declining to change its answer.**

That holds all the way down, and it is worth checking rather than assuming:
staleness is derived in `push_data_to_ui()` and written into the framebuffer,
and the idle tick in `user_app.cpp` deliberately does *not* refresh. So a page
going stale at 3 a.m. does not light the wall either. The badge rides out with
the next refresh that had a reason.

**2. The desk holds tokens, and now a few opinions too — but never the
standing voice.** It answers the internet, so what it can be made to leak
matters: `~/.claudepost`, mounted read-only, holds bearer tokens and an
Alpaca key and nothing else of the owner's. `/data` used to hold only the
editions it had typeset and the schedule it was told to keep; it now also
holds the worker's own research notes on each one and, once an operator has
PUT one, the watchlist — grades, reasons and a thesis note on a handful of
tickers. That is real content to lose, and the watchlist section below is
explicit about why its schema caps what can be put in it rather than
pretending the document holds nothing. What still never reaches the desk is
the *standing* voice: a house style, a rotation, a list of things that must
never print — what makes every page sound like the same person's — lives
wherever the *worker's* `AGENT_CONTEXT_DIR` points, a directory this
container never sees; see [`agent/README.md`](../agent/README.md). So a
compromised desk loses bearer tokens, a schedule, a handful of tickers'
grades and the research behind recent editions — never the opinions that
shape every page it prints.

**3. This repository is public and the owner's editorial voice is not.** The
contract belongs in the open — [`tools/edition/PROMPT.md`](../tools/edition/PROMPT.md)
is how anybody builds a producer. The watchlist, the standing instructions, the
blocklist, the daily briefs and every token do not. The boundary is drawn once,
at the filesystem — tokens in `~/.claudepost`, the watchlist in the desk's own
`/data` (private because a Docker volume is not source control, not because
of a special case written for it), and the standing editorial opinions in
whatever directory the worker's `AGENT_CONTEXT_DIR` names — rather than as a
`.gitignore` rule: nothing private is ever inside the repository to be
accidentally added.

## What the device already allows, and why the wire was barely touched

`news_parse.c` rejects a payload only when it is not JSON, not an object,
unallocatable, or has **neither** a `subject.symbol` **nor** any story. A
payload with one story and no symbol is legal and prints. So the current wire
already carries an arbitrary two-page broadsheet about anything at all — a
research note, a briefing, a week in review — and `ui_compose()` lays out
whatever modules arrive.

The freedom this system exists to give is therefore an *editorial* and
*scheduling* problem, not a protocol one. The wire changed in exactly one place:
the `policy` block, for the one thing the desk genuinely could not express —
how often the device should ask.

## The two planes

**There is no path from the device plane to the control plane.** Not "it is
authenticated" — it is not routed.

| Device plane — anonymous, `GET` only | |
|---|---|
| `GET /news.json` | the current edition, with the `policy` block spliced in |
| `GET /tiles/<id>.bin` | the tiles beside it |
| `GET /healthz` | liveness |

Everything else is `404`; every method but `GET` and `HEAD` is `405`.

This is [hosting-cloudflare.md](hosting-cloudflare.md)'s *"the publish directory
is the allowlist"* moved into a routing table. The reason for moving it is that
a directory allowlist only holds while somebody keeps assembling the directory —
`publish.sh` rebuilds `public/` from empty on every run precisely because a list
of exclusions drifts. A routing table holds because **there is no code that can
serve a fourth path.** A test asserts it directly, which is the
`find agent/standalone/public -type f` check made executable.

The control plane is `/api/*` behind `Authorization: Bearer`, with two scopes:
`producer` may push editions and claim commands, `operator` may also change the
schedule and force a publish. Errors use `{"ok":false,"error":"<code>"}` with a
4xx — the same envelope [`device_api.c`](../components/device_api/device_api.c)
uses, so a client that speaks to the board speaks to the desk.

## The five gates

A draft commits through five gates, cheapest first, which is this project's own
ordering rule:

| | | |
|---|---|---|
| 1 | **Schema and budget** | `tools/mock_news_server.py --validate` — the reference producer is the only thing that knows the contract well enough to judge an arbitrary payload, so it is *invoked* rather than reimplemented |
| 2 | **Typeset** | `tools/edition/render-check.sh` — the real `news_core`, the real seven faces, the real compositor, the real six-ink quantizer, at 1200 × 1600. Proof sheets kept |
| 3 | **Fingerprint** | sha256 over the canonicalised JSON plus every tile byte. An identical fingerprint makes the publish a no-op |
| 4 | **Schedule** | may anything be published at this instant? If not, the edition stages |
| 5 | **Publish** | build the directory complete, `os.replace` it into place, `os.replace` the pointer |

**The failure semantics mirror the firmware's exactly.** A draft that fails any
gate never becomes current and the current edition is untouched. The validator
output and the proof sheets go back to whoever pushed it.

That last clause is the whole point. It is what makes maximum freedom safe: a
remote agent may file anything, and the thing that decides whether it reaches a
wall is **the same typesetter that will print it**. Gate 2 is why `POST
/api/drafts/<id>/proof` exists separately from `commit` — the same separation
`render-check.sh` already has from filing, and what lets an agent *look at the
paper* before it commits.

The fingerprint is deliberately a **superset** of `news_hash()`. Identical bytes
imply an identical device fingerprint, so the desk can never cause a refresh it
did not intend. The reverse — a desk hash differing while the device hash
matches — costs nothing, because the device compares its own.

### Why a draft protocol rather than one POST

Tiles are binary, the payload names them by id, and the validator has to see
both together or it cannot tell a missing picture from a wrong byte count. A
draft directory makes *"the payload and its pictures arrived as one thing"* true
rather than hoped for, and it makes rollback free, because every accepted
edition is already a directory that can be promoted again.

Drafts and editions are separate path namespaces on purpose. A draft id is a
uuid that exists for an hour; an edition id is a content fingerprint that exists
forever. Hanging both off `/api/editions/<something>/` would put two different
kinds of identifier in one path position, told apart only by the verb after
them, which is a thing to get wrong at three in the morning.

### The proof sheets

Gate 2 keeps what it rendered, and two routes serve it — `GET
/api/drafts/<id>/proof/<name>` and `GET /api/editions/<id>/proof/<name>`, both
`producer` scope. `POST /api/drafts/<id>/proof` answers with the names, so a
client asks for what is there rather than guessing: the gate leaves two PNGs on
a pass and a BMP where the render died before conversion, and both are pictures
somebody should be able to look at.

`<name>` must match `[A-Za-z0-9_-]{1,40}\.(png|bmp)` — anything else is
`400 bad_request` before a path is joined (a name longer than sixty characters
never reaches the handler at all — the route does not match, so that is a
plain `404`), and a name that is well-formed but names no sheet is `404`. The `Content-Type` comes from the suffix that pattern
already allowed: `image/png` or `image/bmp`.

**The two routes exist because the edition's sheets outlive the draft's.** A
draft is deleted the moment it commits, so the draft route can only ever answer
for paper nobody has published — which is exactly what the worker wants while
there is still time to change it. Anything showing the edition that actually
went to the wall — the reader site, an operator checking what went out — asks by
the id the edition kept.

### The dossier

`PUT /api/drafts/<id>/notes.md` files the research behind a page beside the
page: why this company, what moved, what was looked at and discarded. `GET`
gives it back as `text/markdown; charset=utf-8`, and the phone reads it next
to the edition it explains.

**A note is evidence, not copy.** It is never typeset, never served to the
board and **never fingerprinted**, so filing one cannot change what is on the
glass or cost a wall twenty-five seconds of the whole sheet flashing. That is
what makes it safe for a worker to file one with every draft rather than only
when it seems worth it.

Two limits, and a reader sees both when they are broken:

- **256 KB**, refused `413` from the `Content-Length` alone, because a phone
  fetches the whole of it through a tunnel in one go.
- **UTF-8**, refused `400 bad_request`, because the `Content-Type` says so and
  a phone handed anything else renders mojibake rather than an error anybody
  can act on.

A refusal leaves the note that was already there alone, the same rule a
rejected payload follows. A draft with no note answers `404` — an ordinary
condition, the one a missing tile is, and the reader shows the page without a
dossier. `GET /api/drafts/<id>` carries `has_notes`, so a client can tell
whether there is one without fetching a quarter of a megabyte to find out
there is not.

**The note rides the commit into the edition.** It is copied in beside the
proof sheets and just as leniently, and served afterwards by `GET
/api/editions/<eid>/notes.md`, with `has_notes` beside `sheets` on `GET
/api/editions/<eid>`. That copy is the one a phone actually reads: a draft is
deleted the moment it commits, so the draft route can only ever answer for
paper nobody has published.

**The paper decides its own identity and the note follows it.** That is what
"never fingerprinted" above buys, and the copy step is where it would be
easiest to lose: hash the note along with the edition it rides into, and a
worker who corrected a typo in their research has
filed a second edition — twenty-five seconds of the whole sheet flashing to
report that nothing on it changed.

The consequence looks like a bug the first time it is met, so it is worth
stating plainly: **a commit that answers `unchanged` or `staged` throws its
note away with the draft.** Both answers mean the edition is already built,
and an edition directory never changes after it appears — so there is nowhere
to put a second note, and the edition keeps the one filed with the bytes it
actually is. Correcting a dossier therefore means filing another draft, the
same as correcting a headline.

**A command carries a note too**, on `PUT`/`GET /api/commands/<id>/notes.md` —
`producer` scope, the same one enqueueing and claiming already need. Unlike a
draft or an edition, each already a directory of its own, a command is a row
in the queue with nowhere for a file to live, so its notes sit in their own
tree, one directory per command id. And unlike a draft's note, filed while
there is still time to change what it describes, a command's note is *about*
what a worker did with the instruction — so `PUT` is refused `409 conflict`
while the command is still `pending`: nobody has claimed it, so there is
nothing done yet to write down. Claimed, done, failed, expired or cancelled
all take one. The same 256 KB / UTF-8 cap applies, and `GET /api/commands` and
`GET /api/state`'s `queue.recent` both carry `has_notes` on every row, the way
a draft and an edition do.

A command's note is kept for as long as the command row is, and nothing sweeps
either: the housekeeping pass reaps *statuses* — a deadline passed, a lease
lapsed — and never deletes a row, so a note filed on a command stays readable
at its own URL indefinitely. That is the opposite of a draft's, which goes with
the draft within the hour, and it is the reason a research turn can file its
whole deliverable there.

## Two storage roots

| Root | Where | Holds |
|---|---|---|
| **Serving** | Docker volume → `/data` | `current`, `staged`, `drafts/<id>/…`, `editions/<id>/…` (each with its own `notes.md` once one is filed), `notes/commands/<id>/…`, `desk.sqlite`, `schedule.json`, `watchlist.json`, `settings.json` |
| **Secrets** | `~/.claudepost/` → `/run/secrets`, ro | `tokens.json`, `agent.env`, `alpaca.json` |

**Secrets are not in the repository, the image, or any synced directory.**
`~/.claudepost/` sits outside all three — the repository is public and git history
is permanent, and a private repository or a synced folder is one setting away
from being public too.

## Commands and directives are different objects

This is the distinction most easily got wrong, and getting it wrong is silent.

> *"Research NVDA now"* is consumed once and forgotten. **A command.**
> *"Never print TSLA"* must hold forever. **A directive.**

Put the second in the queue and it applies to exactly one edition, after which
the desk forgets it and the owner concludes the system ignored them. So
directives are their own store — additive, removable, and rendered into every
worker run's prompt until deleted.

The queue itself is ordinary: priority then FIFO, a thirty-minute lease, three
attempts, and a deadline past which a pending command expires rather than
surfacing three days late. The claim is a single `UPDATE … RETURNING`, because
two statements is a race that surfaces as one instruction filing two editions
and a wall that flashes twice.

## The audit log

`GET /api/audit` is the desk's own record of what it has done — a publish, a
hold, a schedule edit, a commit or a stage — not the editorial history
`GET /api/editions` already gives. Each row is
`{"seq", "at", "event", "detail"}`, newest first; `seq` is the audit table's
own `AUTOINCREMENT`, carried through because `at` alone cannot order two
events that land in the same clock tick.

`?limit=N` clamps to `1..200` (default 50) rather than refusing an
out-of-range value, the same choice `/api/schedule/next`'s `count` makes: an
operator asking "what just happened" should get an answer, not a 400 to work
around.

`producer` scope, like `/api/state` — a worker checking what the desk has
done needs no more than the scope it already files editions with.

## The schedule

```json
{ "timezone": "Asia/Seoul",
  "quiet":   [{"from": "00:30", "to": "06:00"}],
  "wake":    ["06:00", "12:40", "22:00"],
  "publish": {"policy": "on_wake", "min_gap_minutes": 60},
  "poll":    {"active_seconds": 900, "quiet_seconds": 3600} }
```

`quiet` is when nothing new becomes current — a commit inside one stages and
goes up at the boundary. `wake` is when the **worker** runs. `poll` is what the
**device** is told to do. Both are on one document because they are one decision
from the owner's side — *what happens at six* — and splitting them across two
files would make it possible for them to disagree.

**`/data/schedule.json` is the desk's own file, not a mirror of anything.**
`PUT /api/schedule` is its only writer; the desk reads it once at start-up and
again in the same call that handles a PUT, and nowhere else — `tick()`
deliberately does not re-read it, because polling a file the desk just wrote
would be the desk watching its own output. Hand-editing it inside the running
volume therefore does nothing until the container restarts. (A deployment
upgraded from before this file existed may still carry an inert
`<data>/schedule.cache.json` beside it — nothing reads it, and it is safe to
delete.)

The three publish policies are genuinely different behaviours:

| | |
|---|---|
| `immediate` | publish as soon as the gates pass, unless quiet or under the min gap |
| `on_wake` | publish only at a `wake` instant. A commit at 06:14 waits for 12:40, so the paper arrives at times a reader can learn |
| `manual` | never publish on its own; stage and wait for `POST /api/publish` |

**`min_gap_minutes` is the most valuable knob on this document.** A refresh is
twenty-five seconds of the whole sheet flashing. Without a floor, an
enthusiastic agent — or two agents that do not know about each other — turns a
newspaper on a wall into something that blinks at nobody all afternoon. It is
the argument `news_hash()` makes about content, made about cadence.

`GET /api/schedule/next` prints the next ten transitions in both local and UTC
time. Time-zone arithmetic is what everybody gets wrong, and this makes it
inspectable instead of a thing to be trusted.

## The watchlist

`GET /api/watchlist` and `PUT /api/watchlist` carry one document: which
companies a private morning script — the vault, or whoever it is run by — is
watching, a red/yellow/green grade on each, why, a markdown thesis note, and
the dates something happened. `GET` is `producer` scope, so the phone app and
a worker read it with the token they already have (the worker's own rotation
file — `agent/README.md`, "The watch list" — is a different, narrower document:
a universe and a cursor on the worker's disk, not this one); `PUT` is `operator` scope,
because unlike an edition this is not something a remote worker files, it is
the operator's own call.

```json
{ "updated_at": 1755702000,
  "source": "vault",
  "items": [
    { "symbol": "SNDK", "name": "Sandisk Corp.", "market": "NASDAQ",
      "grade": "yellow", "reasons": ["guidance cut", "inventory glut"],
      "thesis_status": "watching", "note": "markdown, up to 16 KiB",
      "printable": true, "last_printed": "2026-08-19",
      "events": ["2026-09-03"], "held": false } ],
  "universe": ["SNDK", "MU", "WDC"] }
```

`GET` on a desk nobody has told returns `{"ok": true, "watchlist": null}` —
there is no default watchlist the way there is a default schedule, so `null`
means exactly "nobody has said" rather than standing in for an empty one.
`PUT` validates the whole document through
[`watchlist.py`](../server/claudepost/watchlist.py)'s `parse_watchlist`,
stamps `updated_at` from the desk's own clock (a value in the body is
accepted so a client may echo its own `GET` back, but never read — the desk
is the only writer of the instant), writes `<data>/watchlist.json`, and
echoes the stored document. A document that fails validation is refused
`400 bad_watchlist` whole, the same rule `PUT /api/schedule` follows: the
previous watchlist stays in force and an operator never has to work out which
half of an edit landed.

**The schema is a privacy boundary, not a typo guard.** Every field carries
its own cap — sixty-four items, eight reasons, a 16 KiB note, a 128-symbol
universe — and an unknown key is refused rather than silently dropped, for a
reason distinct from why `PUT /api/schedule` refuses one: a stop level, an
entry price, a P&L figure has no key here to hide behind, because this
document is read by the phone app and the desk's audit log, and a field that
was never invited cannot leak through either. Two more ceilings back the
per-field caps up — the file is capped at `MAX_DOC_BYTES` (a quarter of a
megabyte) both on the way in, as a serialised-size backstop the per-field
caps alone cannot provide, and on the way back out of `<data>/watchlist.json`,
so a hand-edited file that grew past it is refused exactly as a bad `PUT`
would be.

`PUT` is audited as `watchlist`, carrying `items` (the count) and `source` —
never the items themselves, which is the same reasoning `store.audit`'s own
docstring gives for keeping a credential out of it: the audit log is served to
any `operator` token, so it is the least private place in the desk that still
looks like a private one. `GET /api/state` carries only a summary —
`"watchlist": {"updatedAt": int|null, "count": int}` — for the same reason:
a client checking whether the desk has one yet should not have to fetch the
whole document, thesis notes included, to find out.

## The settings

`GET /api/settings` and `PUT /api/settings` carry the desk's own preferences.
Today there is exactly one:

```json
{ "lang": "en" }
```

`lang` is the language **the edition is written in** — headlines, decks,
bodies, the labels down the side of a drawn statement — and it is a BCP-47
primary language subtag, `^[a-z]{2,3}$`. It is not the phone app's own
chrome, which its owner sets on the phone, and not the board's setup sheet,
which stays English because a board with no edition has no language to take
one from. Three separate things are called a language on this system and this
is only the first of them.

**It is a document, not a directive.** A standing directive is a sentence in
a prompt, and three consumers need this as data: the agent, which builds the
prompt from it; the phone, which draws a control for it and cannot parse a
sentence to know what is set; and whoever reads the desk's own state.

`GET` is `producer` scope — the agent must know what to write in — and `PUT`
is `operator`, because which language the paper prints in is the owner's own
call rather than a remote worker's. `PUT` validates through
[`settings.py`](../server/claudepost/settings.py)'s `parse_settings`, writes
`<data>/settings.json`, and echoes the stored document with the `source` it
is now in force from. It is audited as `settings`, carrying the tag.

A document that fails validation is refused `400 bad_settings` whole and the
language in force is untouched, the same rule `PUT /api/schedule` follows.
An unknown key is part of that refusal, and here the argument is the
watchlist's rather than the schedule's typo guard turned to a different
purpose: this is the document a later release adds a second setting to, so a
phone app one version ahead of the desk has to be told no at the door instead
of being left believing it changed something.

`<data>/settings.json` is read once at start-up and again in the same call
that handles a `PUT`, exactly as the schedule is, and for the same reason —
the desk is its only writer, so polling it would be the desk watching its own
output. A file that will not parse is a warning naming the field, the default
in force, and the bad file left where it is: the desk comes up in English
rather than not coming up at all, which is `schedulefile.py`'s argument that a
newspaper should not come off the wall over a typo.

**The desk does not cross-check an edition's own `lang` against this
setting.** The field on a payload describes the text that is actually in that
payload; refusing a Korean edition because the operator flipped the setting an
hour ago would keep the wrong sheet on the glass for nothing. Gate 1 needs no
new code either — it already runs the validator, and the validator now knows
`lang`.

## Quotes

`GET /api/quotes?symbols=ACME,SNDK` answers the phone's own question about the
companies on its watchlist: a last price, the day's change and up to thirty
daily closes, fetched from Alpaca with a key the phone never sees (see
[`quotes.py`](../server/claudepost/quotes.py)'s module docstring for why the
key never leaves this machine). `producer` scope — it is read-only, and the
phone and a worker already hold that token.

`symbols` is a comma-separated list: split, stripped, upper-cased and
deduplicated preserving order. Empty — the parameter missing, or nothing
survives that normalisation — is `400 bad_request`, and so is more than
thirty-two, the same cap `watchlist.py` puts on the list this reads from and
more companies than one watchlist carries. Each survivor is checked against
the *watchlist's own*, wider shape (`^[A-Z0-9.\-]{1,12}\Z` — digits admitted,
because a KR listing is numeric) rather than the narrower one Alpaca itself
accepts, and only a string that cannot be a symbol at all is refused this way.
A symbol that passes this check but the provider cannot quote — a KR listing
against a feed of US equities — is not a `400` either: the phone sends its
whole watchlist in one call, and a single holding this provider does not carry
must not cost every other company its price. It is silently absent from the
response instead, indistinguishable from a symbol the upstream itself skipped.

```json
{ "ok": true, "asOf": 1755702000, "feed": "iex",
  "quotes": {
    "ACME": { "lastCents": 24160, "prevCloseCents": 23184, "changeBp": 421,
              "bars": [ { "t": "2026-08-01", "c": 24000 } ] } } }
```

Every number is an integer — cents and basis points, the units
`docs/app-control.md` already uses for the board's own wire — and `bars` is at
most thirty daily closes, oldest first. `asOf` is the desk's own clock at the
moment it answered, not the instant the prices were fetched: an answer served
wholly from the cache carries an `asOf` of now and prices up to sixty seconds
old. A desk with no Alpaca key answers `404 no_quotes`: a tab the app can hide
behind rather than an error it has to explain, and a complete configuration for
an owner with no Alpaca account.

**The two upstream calls fail differently, and it is worth knowing which.** A
**snapshot** outage — a refusal, a timeout, a body that parses as neither
envelope — is `502 upstream`: the price is the answer and there is nothing to
serve without it. A **bars** outage is not: the prices are already in hand, so
the sparkline goes missing rather than the page, and every affected symbol comes
back with `"bars": []` — indistinguishable from a symbol with no daily history,
which is a case the phone already draws. The failure is cached for a minute
rather than the bars' hour, so an outage costs one upstream call a minute and
the sparklines return on their own. Neither message carries the credential;
`quotes.py`'s module docstring is where that redaction rule is argued and held.

The key lives at `<secrets>/alpaca.json`, beside `tokens.json` and mounted the
same read-only way, carrying exactly two fields:

```json
{ "key_id": "<your Alpaca key id>", "secret_key": "<your Alpaca secret key>" }
```

A missing or malformed file is not an error — the desk answers `no_quotes` for
either, and reloads the file if it changes underneath the process, so a key
dropped into the mount or rotated in place takes effect on the next request.
Snapshots are cached for a minute and daily bars for an hour, per symbol
rather than per request, so a phone pulling to refresh does not spend the
upstream's rate limit — see `quotes.py`'s module docstring for the full
argument.

## The `policy` block

One optional top-level object on the wire, documented in full in
[news-contract.md](news-contract.md). It goes in the payload rather than at a
second URL for the same reason the tile base is derived rather than configured:
**a second thing to configure is a second thing to get wrong**, and the board is
meant to hold exactly one URL.

```json
"policy": { "poll_seconds": 3600, "next_change": 1755561000 }
```

Two fields, and no calendar arithmetic on the device at all. `poll_seconds` is
the cadence to use *now* — the desk has already decided whether now is inside a
quiet window, and the device does not need to know that it is. `next_change` is
epoch seconds, the instant the desk's answer will change; the device waits
`min(poll_seconds, next_change − now)`, floored at thirty seconds.

`next_change` is a JSON **number** because it is a number the device reasons
about, and this wire's rule is that those are integers. It also removes a date
parser from the firmware, which is a class of bug bought for nothing.

**`news_hash()` excludes the block, and that is the property to protect.**
`next_change` moves every day; fingerprinted, it would spend twenty-five seconds
of flashing to report that a timestamp advanced. The fingerprint covers what
reaches the glass and the policy reaches nothing. A host test asserts that two
snapshots differing only in `policy` hash identically.

Three more rules, each of which is also a test: it **clamps, never rejects**, so
this block cannot cost a page; it **does not survive a power cycle**, so a bad
policy cannot leave a board polling once a day forever; and it is **ignored when
the clock is not synced**, because `next_change` is absolute and the board has no
RTC. A deep sleep is the one thing it does cross — RTC memory carries the last
adopted cadence, so a wake answered 304 sleeps by what this desk last said
rather than by the board's own interval.

## What a sleeping board asks of the desk

A board with a cell on it does not sit in a poll loop. It wakes, brings up
Wi-Fi, asks this server one conditional question, and — when the answer is that
nothing has changed — goes back to sleep without ever powering the panel, the
LVGL tree or the 960,000-byte framebuffer. Spectra 6 is bistable, so the edition
hangs on the glass through all of it, drawing nothing. The device half is
[the deep-sleep design](specs/2026-08-17-deep-sleep-design.md); this is the part
the desk owes it, and the desk already does all of it.

**On a board on battery, `poll_seconds` is not advice about polling. It is the
sleep.** One function resolves the cadence — `power_cadence()` in
`components/power/power_policy.c` — and the awake poll loop and the RTC timer
that wakes a sleeping board both call it, so what this desk says is what the
board does in either power mode. A quiet window is therefore not merely fewer
requests; for the hours it covers it is a board waking at a rate of twenty-four
a day rather than ninety-six. On the shipped schedule's own two numbers, against
a 4200 mAh cell — each row read as though that cadence ran all day, which is how
the design states them; the shipped schedule spends 00:30 to 06:00 in the second
and the rest in the first, so a real day lands between them:

| what the desk says | wakes/day | mAh/day | the cell lasts |
|---|---|---|---|
| `poll_seconds: 900` (active) | 96 | 16–22 | 190–260 days |
| `poll_seconds: 3600` (quiet) | 24 | 8–14 | 300–520 days |

Those are **estimates and they are stated as ranges for a reason**: two of the
terms in them — the standing deep-sleep current and how long a Wi-Fi connect
actually takes — have never been measured on this board. §9 and §10 of the
deep-sleep design work them through, and the board counts its own wakes so that
a day on a wall replaces them with a measurement; `GET /api/state` reports it.
What the table is for is the shape, and the shape is that the knee is between a
quarter of an hour and half an hour. Below five minutes the cell drains steeply
for freshness nobody reads on a newspaper; past the knee a longer interval buys
progressively less, because the refreshes and the standing current dominate.

**`next_change` is a targeted wake, and it is what stops a quiet cadence from
being a late paper.** A board on an hourly overnight cadence wakes an hour after
whenever it last woke, so it would otherwise collect the 06:00 edition at 06:47.
Told the instant as well, it sleeps until 06:00 —
`min(poll_seconds, next_change − now)`, floored at thirty seconds, computed on
the device with no calendar and no timezone database. It is honoured only when
the board's clock is synced, because the instant is absolute and this carrier
has no RTC.

### The conditional GET

`/news.json` carries a strong `ETag`, and answers a matching `If-None-Match`
with `304 Not Modified` — no body, `Content-Length: 0`, the same tag back.

- **The tag is the SHA-256 of the exact bytes served**, first sixteen hex digits,
  quoted, no `W/` prefix (`_etag()` in `server/claudepost/http.py`). Taken
  *after* the policy block is spliced in, so it names the whole answer rather
  than the stored payload — which is what makes the next point true.
- **`Cache-Control: no-cache` travels with it**, on the 200 and on the 304.
  That is not "do not store", it is "do not serve this without asking me first":
  the board's own rule, written down for anything in between.
- **Tiles are unconditional.** `/tiles/<id>.bin` is immutable by id — a
  different picture is a different id — so it carries no tag and an
  `If-None-Match` on it is answered with the bytes.

**The tag moves exactly when the answer moves, which means it moves at a
schedule transition.** Both numbers in the policy block are step functions of
the clock, constant across a whole window, and `next_change` is truncated to a
whole second — so every poll inside a window hashes to the same tag and gets a
304, and at a transition both integers change at once, the tag changes with
them, and the board receives a full edition carrying the new cadence. That is
not a side effect; it is the mechanism the one-cadence rule rests on. A tag that
did not move there would leave a sleeping board polling at the night's rate
through the morning, and nothing anywhere would say so. The shipped schedule has
four transition instants in a day — 00:30, 06:00 (which is both the end of the
quiet window and a wake), 12:40 and 22:00 — so it costs at most four full
transfers per board per day, plus one for each edition actually filed. Every
other poll is a couple of hundred bytes of headers.

Nothing here is required of a server. A producer that has never heard of any of
it is fully supported and pays one transfer per poll;
[news-contract.md](news-contract.md) has that argument in full, along with the
rule that keeps a bad tag from ever costing a page: `news_hash()` remains the
sole authority on whether the panel moves.

**Through a tunnel, `no-cache` is a behaviour change and it is the intended
one.** A proxy that honours it revalidates to origin on every poll instead of
answering out of a copy, so the desk sees the request it was already getting and
the board can no longer be served yesterday's front page by something in the
middle. The revalidation that finds nothing new is a 304 — about 160 bytes of
headers, counted from what the desk sends — rather than a whole edition. See
[hosting-cloudflare.md](hosting-cloudflare.md).

## The worker

**A container or a process on your own machine, and the difference is a bill.**
`claude --print` inside an image has no login session to inherit, so a container
needs an `ANTHROPIC_API_KEY` or a `CLAUDE_CODE_OAUTH_TOKEN`. On the machine you
are already signed in on there is a third route and it needs no credential
handling at all — `agent/run-host.sh` runs the same `loop.py` against the same
desk and spends the subscription. The trade is availability: a container
restarts itself, a laptop sleeps.

A separate container from the desk, and separate for the reason
[`agent/README.md`](../agent/README.md) gives for splitting filing from
serving: **filing is an event that can fail, serving is a condition that must
hold.** One container means a failed filing takes the served page down with
it, which converts a stale paper — the failure the firmware is designed to
survive and badge — into no paper at all.

It claims an instruction over a long poll, assembles a prompt from `PROMPT.md`
(the contract, from the repository), the operator's own context files if
`AGENT_CONTEXT_DIR` points anywhere (the voice — see `agent/README.md`'s
"Bring your own continuity"), and the desk's own standing directives, then
runs `claude --print` with its own narrow allowlist — reads, writes, search,
and the two contract scripts, deliberately without `render-check.sh` or any
market-data MCP — opens a draft, uploads, and asks the desk to proof it.

Then it does the thing this whole arrangement exists to make possible: **it
fetches the proof sheets back and looks at them.** The desk owns the only
typesetter, so the worker cannot render its own paper — but it can be handed the
sheets. That is the first time in this project that *"the desk cannot see the
paper"* is false, and it is what no schema check can do: a column that ran
short, a headline broken on the wrong word, a page that is grey because nothing
on it is set larger than a deck, a photograph that halftoned to mush.

Two revisions, then it reports the failure with the validator's own words.

**`kind` decides where the turn's `notes.md` goes, and one of the three kinds
decides it from the disk rather than from itself.** `"file_edition"` always
takes the draft path above, and if the run left a `notes.md` in its workdir it
rides beside the draft (`PUT .../notes.md`) — the dossier behind the page,
filed the same way whether or not one seemed worth writing. `"research"`
never opens a draft at all: "look into this" has no page to typeset, so its
prompt tail asks for `notes.md` alone and the note goes straight onto the
command (`PUT /api/commands/<id>/notes.md`). `"custom"` is the operator's own
text and can be either kind of instruction, so the worker trusts what actually
landed over the label: a `news.json` in the workdir means it was an order and
the note follows the draft; no `news.json` means it was a look and the note
follows the command. A turn that left no `notes.md` files nothing — that is
the ordinary case, not a gap, the same way an edition with no photograph is
still a complete one.

## Cloudflare

One named tunnel, one hostname, one container port. The control plane is at
`/api/*` behind a bearer token rather than on a hostname of its own — two
hostnames would let Cloudflare Access sit in front of the API and nothing else,
which is cleaner, but Access in front of non-browser agents means service
tokens, a second credential system to hold and rotate. The ingress can grow that
second hostname later without the application changing.

**Bot Fight Mode must stay off**, for the reason
[hosting-cloudflare.md](hosting-cloudflare.md) already gives at length: the
board has no JavaScript engine, so a challenge is a hard failure that arrives as
`STALE` with nothing in the log to explain it.

**The desk closes a silent socket after two minutes** (`SOCKET_TIMEOUT_SECONDS`
in `server/claudepost/http.py`), and that number must stay *above* the tunnel's idle
keep-alive — cloudflared's `--proxy-keepalive-timeout`, 90 s by default — so that
the tunnel is always the side that lets go first. Raise the tunnel's figure past
the desk's and the desk starts closing origin connections cloudflared still means
to reuse, which costs a retry per closed socket and, for anything the tunnel will
not retry, a failed request with nothing in either log that says why.

The tunnel means the board and the Mac no longer have to be on the same network.
`claudepost.local`, the device API and the LAN path are untouched and remain the way
back.

## What this does not do

- **It does not make the board's Wi-Fi work.** Unchanged from
  [hosting-cloudflare.md](hosting-cloudflare.md).
- **It does not authenticate the device plane.** The edition is public market
  journalism about one company; the board holds no credential and could not
  present one. What is protected is everything that is *not* the edition, and it
  is protected by not being routable.
- **It does not replace `agent/standalone/`.** `file-edition.sh --serve` still
  files and serves on a LAN with no Docker and no domain, and stays the way back.
- **It does not let the device choose anything.** The server decides what is
  important, the device decides what fits, and now the server also decides when.
  Selection never moves to the one machine with no way to research it.
