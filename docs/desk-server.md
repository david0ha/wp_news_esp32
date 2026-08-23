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

**2. The desk holds nothing personal.** It answers the internet, so what it
can be made to leak matters: `~/.claudepost`, mounted read-only, holds bearer
tokens and nothing else of the owner's, and `/data` holds only the editions it
has typeset and the schedule it was told to keep. A house style, a rotation, a
list of things that must never print — what makes a paper sound like
somebody's own — lives wherever the *worker's* `AGENT_CONTEXT_DIR` points, a
directory this container never sees; see
[`agent/README.md`](../agent/README.md). So a compromised desk loses bearer
tokens and a schedule, never anybody's opinions.

**3. This repository is public and the owner's editorial voice is not.** The
contract belongs in the open — [`tools/edition/PROMPT.md`](../tools/edition/PROMPT.md)
is how anybody builds a producer. The watchlist, the standing instructions, the
blocklist, the daily briefs and every token do not. The boundary is drawn once,
at the filesystem — tokens in `~/.claudepost`, editorial opinions in whatever
directory the worker's `AGENT_CONTEXT_DIR` names — rather than as a
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

## Two storage roots

| Root | Where | Holds |
|---|---|---|
| **Serving** | Docker volume → `/data` | `current`, `staged`, `editions/<id>/…`, `desk.sqlite`, `schedule.json` |
| **Secrets** | `~/.claudepost/` → `/run/secrets`, ro | `tokens.json`, `agent.env` |

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
