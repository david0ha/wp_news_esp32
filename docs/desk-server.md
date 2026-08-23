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
can be made to leak matters: `~/.wpnews`, mounted read-only, holds bearer
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
at the filesystem — tokens in `~/.wpnews`, editorial opinions in whatever
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
| **Secrets** | `~/.wpnews/` → `/run/secrets`, ro | `tokens.json`, `agent.env` |

**Secrets are not in the repository, the image, or any synced directory.**
`~/.wpnews/` sits outside all three — the repository is public and git history
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
this block cannot cost a page; it **does not survive a reboot**, so a bad policy
cannot leave a board polling once a day forever; and it is **ignored when the
clock is not synced**, because `next_change` is absolute and the board has no
RTC.

### Why there is no deep sleep

The panel holds its image without power, so sleeping is about the board's own
current and not about the paper. Deep sleep drops the 960 KB framebuffer in
PSRAM, so every wake pays a full fetch and a full re-render — and a wake that
finds nothing changed has spent that for nothing. The saving actually on the
table is the polling itself, and `poll_seconds` collects all of it. Deep sleep
gets its own spec if measured battery numbers justify the re-render.

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

The tunnel means the board and the Mac no longer have to be on the same network.
`wpnews.local`, the device API and the LAN path are untouched and remain the way
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
