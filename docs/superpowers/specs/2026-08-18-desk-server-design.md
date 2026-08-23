# The desk server

> **2026-08-23 — superseded in part.** Shipped without the vault bridge (`vault.py`, the notes
> bridge) — the schedule now lives at `/data/schedule.json` instead, and the worker moved to
> `agent/`. See [docs/desk-server.md](../../desk-server.md) for what actually shipped. The
> reasoning below is kept as filed.

**Status:** design, approved 2026-08-18. Supersedes nothing; `tools/edition/` keeps working and
stays the way back.

An always-on service that owns the URL the board polls. It holds the current edition, takes
commands from agents anywhere on the internet, decides *when* a new edition is allowed to reach the
glass, and typesets every candidate before it does. A second half of this design gives the device a
`policy` block so the server can also say how often to poll.

The board polls one URL and nothing in the firmware knows what answers it. Today that is either a
Python `http.server` on a Mac on the LAN or a Cloudflare Worker serving two static files. Both are
*publishing* mechanisms: something files an edition, something else copies it somewhere. Neither can
be told anything. This adds the third thing — a service that can be *asked*, from anywhere, at any
time, by anything holding a token.

## What this is for

One sentence: **an agent that runs for its owner every day, that can reach the paper on the wall
from wherever it happens to be running.**

Concretely, the owner wants to be able to say — at 3 a.m., from a phone, from a cloud routine, from
a Claude session on another machine — *look into this*, *put this company on tomorrow's front page*,
*never print that one again*, *don't wake the wall before six*. Each of those is a different kind of
statement and this design keeps them different (§6).

## Three facts the shape is arranged around

**1. A refresh costs twenty-five seconds of the whole sheet flashing, and there is no partial one.**
Everything about *when* the served bytes are allowed to change follows from this. `news_hash()`
fingerprints what reaches the glass and `NewsTask` compares before it notifies `UiTask`, so the
server controls the panel completely by controlling when the payload changes. A quiet window is not
a firmware feature; it is the server declining to change its answer. Confirmed against the code: the
`STALE` badge is derived in `push_data_to_ui()` and written into the framebuffer, and the idle tick
in `user_app.cpp:589-597` deliberately does **not** refresh — so a page going stale at 3 a.m. does
not light the wall either.

**2. The private half lives on an external SSD, and the SSD can be unplugged.** The owner's vault is
`<a private notes directory>`, a private git repository they read and edit in Obsidian. Putting the
serving path on it would mean that pulling a disk blanks a newspaper. So the vault is the *source*
and the *archive*, and never the serving path. This is the infrastructure form of the rule the
parser already follows: a rejected payload leaves the previous snapshot byte-for-byte alone.

**3. This repository is public and the owner's editorial voice is not.** The contract belongs in the
open — `tools/edition/PROMPT.md` is how anyone builds a producer. The watchlist, the standing
instructions, the blocklist, the daily briefs and every token do not. The boundary is drawn once, at
the filesystem, and it is a mount rather than a `.gitignore` rule: nothing private is ever inside the
repository to be accidentally added.

## What the device already allows, and why the wire is not the constraint

`news_parse.c` rejects a payload only when it is not JSON, not an object, unallocatable, or has
**neither** a `subject.symbol` **nor** any story. A payload with one story and no symbol is legal
and prints. So the current wire already carries an arbitrary two-page broadsheet about anything at
all — a research note, a briefing, a week in review — and `ui_compose()` lays out whatever modules
arrive.

The freedom the owner asked for is therefore an *editorial* and *scheduling* problem, not a protocol
one. This design spends its budget on the queue, the gate and the schedule, and changes the wire in
exactly one place (§8), for the one thing the server genuinely cannot express today: how often the
device should ask.

---

## 1. Where it lives

A new top-level `server/`. `tools/edition/` is not replaced and not moved — the new service *calls*
it, so there is one copy of the contract knowledge and it is the one that already has tests around
it.

```
server/
  README.md                 what it is, how to run it, what it exposes
  Dockerfile                the desk: python3-slim + cmake + libcurl + the simulator, built in
  Dockerfile.agent          the worker: node + claude-code + python3
  compose.yaml              desk + agent + cloudflared
  .env.example              every knob, no values
  wpdesk/
    __main__.py             entry point, signal handling, the scheduler thread
    http.py                 ThreadingHTTPServer; the two planes and the routing table
    auth.py                 bearer tokens and the two scopes
    store.py                the SQLite schema and every query
    editions.py             draft -> proof -> commit -> stage -> publish
    tiles.py                tile intake, byte-count and palette checks
    commands.py             the queue
    directives.py           the standing-instruction store
    schedule.py             windows, wake times, next-transition arithmetic
    policy.py               the block spliced into the served payload
    vault.py                the notes bridge
    proofpng.py             BMP24 -> PNG, zlib only
  agent/
    loop.py                 claim -> run claude -> proof -> look -> commit -> brief
  test/
    run.sh                  stdlib unittest, no network, no docker
    test_*.py
  tunnel/
    wpnews.yml.example      cloudflared ingress
```

**Python standard library only.** `ThreadingHTTPServer`, `sqlite3`, `zoneinfo`, `hmac`, `zlib`. The
load is one board and two or three agents. A framework would put a lock file and a wheel build into
a public repository for an API of about twenty endpoints, and this project's stated preference is
that the least machinery that can produce the URL wins. Two consequences are load-bearing rather
than incidental:

- **Tiles arrive one per `PUT` as a raw body**, not as `multipart/form-data`. Writing a multipart
  parser by hand is the one thing on this list that would be genuinely unwise, and a raw `PUT` per
  tile avoids it while also avoiding base64's 33% inflation on a 342 KB picture.
- **Proof sheets are converted to PNG in Python.** `render-check.sh` shells out to `sips` for that,
  which is macOS-only, so in a Linux container the simulator's 5.8 MB 24-bit BMPs would stay BMPs.
  `proofpng.py` reads an uncompressed 24-bit BMP and writes a PNG with `zlib`. It is about sixty
  lines and it is tested against a BMP the simulator produced.

The desk image is `python:3.12-slim` plus what the simulator needs to build — `cmake`, a C
toolchain, `libcurl4-openssl-dev`, and `git` for the LVGL `FetchContent` (§11) — plus `tzdata`,
because `zoneinfo` reads the system database and the slim image carries none. The simulator is built
during the image build, so a container start does not wait on CMake and a broken build fails at
`docker build` rather than at the first commit of the day.

## 2. The two planes

The point of this split is that **there is no path from the device plane to the control plane**. Not
"it is authenticated" — it is not routed.

### Device plane — anonymous, read-only, `GET` only

| | |
|---|---|
| `GET /news.json` | the current edition, with the `policy` block spliced in |
| `GET /tiles/<id>.bin` | the tiles beside it |
| `GET /healthz` | liveness, for compose and for the tunnel |

Everything else on this plane is `404`, including every method other than `GET` and `HEAD`.

This is `docs/hosting-cloudflare.md`'s "the publish directory is the allowlist" moved into a routing
table. The reason for moving it is that a directory allowlist only holds while somebody keeps
assembling the directory; a routing table holds because there is no code that can serve a fourth
path. A test asserts it directly (§11), which is the `find tools/edition/public -type f` check made
executable.

`<id>` is held to `[A-Za-z0-9_-]{1,15}` before it becomes a path component — the same rule
`ui_tile.c`'s `id_ok()` applies on the device, applied here for the same reason.

No caching headers. The board does not read them and a cache between the desk and the board is a
stale front page nobody can explain.

### Control plane — `/api/*`, `Authorization: Bearer <token>`

| Group | Endpoints |
|---|---|
| Drafts | `POST /api/drafts` → `{draft_id}` · `PUT /api/drafts/<draft>/news.json` · `PUT /api/drafts/<draft>/tiles/<id>.bin` · `POST /api/drafts/<draft>/proof` · `POST /api/drafts/<draft>/commit` · `GET /api/drafts/<draft>` |
| Editions | `GET /api/editions` · `GET /api/editions/<id>` · `POST /api/editions/<id>/promote` |
| Queue | `POST /api/commands` · `GET /api/commands/next?wait=60` · `POST /api/commands/<id>/done` · `POST /api/commands/<id>/fail` · `GET /api/commands` · `DELETE /api/commands/<id>` |
| Directives | `GET /api/directives` · `POST /api/directives` · `DELETE /api/directives/<id>` |
| Schedule | `GET /api/schedule` · `PUT /api/schedule` · `GET /api/schedule/next` |
| Operations | `GET /api/state` · `POST /api/publish` · `POST /api/hold` |

Errors are `{"ok":false,"error":"<code>"}` with a 4xx, in the same shape `device_api.c` already uses
on the board, so a client that speaks to one speaks to the other.

**Two scopes.** `producer` may push editions and claim commands. `operator` may do everything,
including changing the schedule and forcing a publish. An agent gets a `producer` token; the owner's
own tooling gets an `operator` one. Tokens live in `~/.wpnews/tokens.json` (mode 0600), are compared
with `hmac.compare_digest`, and are never in the repository, the image, or the vault.

### Why a draft protocol rather than one POST

Tiles are binary, the payload names them by id, and the validator has to see both together or it
cannot tell a missing picture from a wrong byte count. A draft directory makes "the payload and its
pictures arrived as one thing" true rather than hoped for, and it makes rollback free because every
accepted edition is already a directory that can be promoted again.

Drafts are swept after one hour. Limits, and every one of them is a number from somewhere real:

| | limit | why |
|---|---|---|
| `news.json` | 300 KB | the device caps a response at 320 KB (`http_port_esp.c:32`). Serving something it cannot fetch is a page nobody sees |
| one tile | 960,000 bytes | a full-sheet 1200 × 1600 tile at 4 bpp. Nothing larger can exist |
| tiles per draft | 16 | the contract allows five story photos and two thumbs; sixteen is generous and finite |
| drafts open at once | 8 | |

## 3. The publish pipeline

`commit` runs five gates, cheapest first, which is this project's own ordering rule:

1. **Schema and budget** — `python3 tools/mock_news_server.py --validate <draft>/news.json`. The
   reference producer is the only thing that knows the contract well enough to judge an arbitrary
   payload, so it is invoked rather than reimplemented.
2. **Typeset** — `tools/edition/render-check.sh <draft>/news.json <draft>/proof`. The real
   `news_core`, the real faces, the real compositor, the real quantizer, at 1200 × 1600. Proof
   sheets are kept and converted to PNG.
3. **Fingerprint** — sha256 over the canonicalised JSON (sorted keys, no whitespace) plus every tile
   byte, truncated to 16 hex characters. This is the edition id. An identical fingerprint makes the
   whole publish a no-op, logged and reported, not an error. This is deliberately a *superset* of
   `news_hash()`: identical bytes imply an identical device fingerprint, so the server can never
   cause a refresh it did not intend. The reverse — a server hash differing while the device hash
   matches — costs nothing, because the device compares its own.
4. **Schedule** — is publishing allowed at this instant (§7)? If not, the edition becomes `staged`
   and a timer publishes it at the next allowed instant.
5. **Publish** — write `data/editions/<id>/` complete, then `os.replace` the `current` pointer file.
   Serving reads the pointer under a lock and holds the resolved directory for the life of the
   request, so a swap mid-request cannot serve half of two editions.

`POST /api/drafts/<draft>/proof` runs gates 1 and 2 and stops, returning the validator's output and
URLs for the proof sheets. That is the separation `render-check.sh` already has from filing, and it
is what lets an agent *look at the paper* before it commits — see §9.

**Drafts and editions are separate path namespaces on purpose.** A draft id is a uuid that exists
for an hour; an edition id is a content fingerprint that exists forever. Hanging both off
`/api/editions/<something>/` would put two different kinds of identifier in one path position, told
apart only by the verb after them, which is a thing to get wrong at three in the morning.

**The failure semantics mirror the firmware's exactly.** A draft that fails any gate never becomes
current and the current edition is untouched. The validator output and the proof sheets go back to
whoever pushed it. That is what makes maximum freedom safe: a remote agent may file anything, and
the thing that decides whether it reaches a wall is the same typesetter that will print it.

**A producer's own `policy` key, if it sends one, is discarded.** The schedule is the desk's
business. Recorded in `meta.json` when it happens, because it means an agent has a wrong idea about
who owns the cadence.

Retention: the last 30 editions plus whatever is current or staged.

## 4. Storage — three roots

| Root | Where | Holds |
|---|---|---|
| **Serving** | Docker volume `wpnews-data` → `/data` | `current`, `staged`, `editions/<id>/{news.json,tiles/,proof/,meta.json}`, `desk.sqlite`, `schedule.cache.json` |
| **Vault** | `<a private notes directory>/` → `/vault`, rw | `standing.md`, `watchlist.json`, `blocklist.md`, `schedule.json`, `briefs/<date>.md`, `archive/<id>/` |
| **Secrets** | `~/.wpnews/` → `/run/secrets`, ro | `tokens.json`, `agent.env` |

**Only one subdirectory of the vault is mounted.** The vault holds the owner's whole second brain,
including notes that are nobody's business, and this container is reachable from the internet. The
blast radius is chosen rather than inherited.

**Serving never depends on the vault.** Unplug the SSD and the agent cannot file, but the board keeps
receiving the last edition; `/api/state` reports `vault: "unavailable"` and the desk runs on
`schedule.cache.json`, the last schedule it successfully read. The condition is logged loudly once
per transition, not once per poll.

**Each file has exactly one writer.** `standing.md`, `watchlist.json`, `blocklist.md` and
`schedule.json` are authored in the vault — by the owner in Obsidian, or by `PUT /api/schedule`
writing that same file. The database is a parsed cache, never a second source of truth. The desk
polls the vault's mtimes every 15 seconds and re-reads what changed. A `schedule.json` that does not
validate is rejected into `schedule.errors.md` beside it and the previous schedule stays in force,
because silently ignoring a bad edit is how somebody spends a week wondering why 06:00 does nothing.

**Secrets are not in the vault.** The vault is a private git repository, and a private repository is
one setting away from a public one while git history is permanent.

## 5. The command queue

A command is an **intent for an agent to act on**, not an RPC the desk executes. The desk never
researches anything; it holds the intent until a worker claims it.

```json
{ "kind": "file_edition", "text": "NVDA — earnings were last night, lead on the guide",
  "priority": 0, "deadline_at": 1755610000 }
```

| Field | |
|---|---|
| `kind` | `file_edition` \| `research` \| `custom`. Advisory: it tells a worker whether the expected outcome is an edition |
| `text` | ≤ 2,000 characters, the instruction in the owner's own words |
| `priority` | 0..9, 0 first |
| `deadline_at` | epoch seconds; past its deadline a pending command expires rather than surfacing three days late |

Lifecycle: `pending` → `claimed` → `done` \| `failed` \| `expired`. `GET /api/commands/next?wait=N`
long-polls up to N seconds (capped at 90) and claims atomically with a single
`UPDATE … WHERE status='pending' ORDER BY priority, created_at LIMIT 1 RETURNING`. A claim carries a
30-minute lease; an expired lease returns the command to `pending` and increments `attempts`. Three
attempts fails it. A worker that dies mid-edition therefore costs one retry, not a lost day.

## 6. Directives — the store that is not the queue

This is the distinction most easily got wrong, and getting it wrong is silent.

> *"Research NVDA now"* is consumed once and forgotten. **A command.**
> *"Never print TSLA"* must hold forever. **A directive.**

Put the second in the queue and it applies to exactly one edition, after which the desk forgets it
and the owner concludes the system ignored them. So directives are their own store, additive and
removable, rendered into every agent run's prompt and mirrored into `/vault/standing.md` so they can
be read and edited as prose in Obsidian.

| Field | |
|---|---|
| `rule` | ≤ 500 characters |
| `scope` | `always`, or `until` with `expires_at` |
| `source` | who added it — an audit trail for "why did it stop covering that" |

`/vault/blocklist.md` is the same store's negative half, kept as a separate file because "what must
never print" is the one list an owner wants to be able to read at a glance without scrolling past
everything else.

## 7. The schedule

```json
{ "timezone": "Asia/Seoul",
  "quiet":   [{"from": "00:30", "to": "06:00"}],
  "wake":    ["06:00", "12:40", "22:00"],
  "publish": {"policy": "on_wake", "min_gap_minutes": 60},
  "poll":    {"active_seconds": 900, "quiet_seconds": 3600} }
```

| Key | Meaning |
|---|---|
| `quiet` | windows in which **nothing new becomes current**. A commit inside one is staged and goes up at the boundary. `from > to` wraps midnight. Up to 4 windows |
| `wake` | when the **agent** runs. The desk enqueues a `file_edition` command at each. `HH:MM` in `timezone`, up to 12, optionally `{"at":"07:00","days":"sat,sun"}` |
| `publish.policy` | `immediate` \| `on_wake` \| `manual` — see below |
| `publish.min_gap_minutes` | the floor between two publishes, 0..1440 |
| `poll` | what the **device** is told to do — §8 |

The three publish policies are genuinely different behaviours, not three names for one:

| | |
|---|---|
| `immediate` | publish as soon as the gates pass, unless inside a quiet window or under the min gap |
| `on_wake` | publish only at a `wake` instant. A commit that lands at 06:14 waits for 12:40. The paper arrives at times the reader can learn |
| `manual` | never publish on its own. The edition stages and waits for `POST /api/publish` — for a reader who wants to see the proof sheets before it goes on the wall |

Two overrides sit beside them, and both are `operator` scope. `POST /api/publish` promotes the
staged edition **now**, quiet window and min gap included — it is the "I am standing here, put it
up" button, and a rule you cannot override is a rule you end up editing at midnight.
`POST /api/hold {"until": <epoch>}` does the reverse: nothing is published until that instant,
whatever the schedule says. A hold in force is reported by `GET /api/state`, because a desk that is
quietly refusing to publish and a desk that is broken look identical from the wall.

**`min_gap_minutes` is the most valuable knob here.** A refresh is twenty-five seconds of the whole
sheet flashing. Without a floor, an enthusiastic agent — or two agents that do not know about each
other — turns a newspaper on a wall into something that blinks at nobody all afternoon. It is the
same argument `news_hash()` makes at the level of content, made at the level of cadence.

`wake` is when the **agent** wakes, not the board. The board's cadence is `poll`. Both are on this
one document because they are one decision from the owner's side — "what happens at six" — and
splitting them across two files would make it possible for them to disagree.

`GET /api/schedule/next` prints the next ten transitions with both local and UTC times and what each
one does. Time-zone arithmetic is what everybody gets wrong, and this makes it inspectable instead
of a thing to be trusted. DST is `zoneinfo`'s problem; ambiguous and nonexistent local times resolve
with `fold=0` and are reported as such in that listing rather than resolved silently.

Validation on `PUT`: `timezone` must be a real IANA key, times must be `HH:MM` 24-hour,
`active_seconds` and `quiet_seconds` must be within the device's own 30..86400 range. An invalid
document is rejected whole; there is no partial schedule.

## 8. The `policy` block — the firmware half

One optional top-level object on the wire. It goes in the payload rather than at a second URL for
the same reason the tile base is derived rather than configured: **a second thing to configure is a
second thing to get wrong**, and the board is meant to hold exactly one URL.

```json
"policy": { "poll_seconds": 3600, "next_change": 1755561000 }
```

Two fields, and no calendar arithmetic on the device at all:

- **`poll_seconds`** — the cadence to use *now*. The server has already decided whether "now" is
  inside a quiet window; the device does not need to know that it is.
- **`next_change`** — **epoch seconds**, the instant at which the server's answer will change. The
  device waits `min(poll_seconds, next_change − now)`, floored at 30 s. Absent or `0` means "no
  scheduled change known", and the device just uses `poll_seconds`.

`next_change` is a JSON **number**, not an ISO-8601 string, because it is a number the device
*reasons about* and this wire's rule is that those are integers. It also removes a date parser from
the firmware, which is a class of bug bought for nothing.

Four properties this block must have, each of which is a test:

- **`news_hash()` excludes it.** `next_change` moves every day. Fingerprinted, it would spend
  twenty-five seconds of flashing to report that a timestamp advanced. The fingerprint covers what
  reaches the glass and the policy reaches nothing. A host test asserts that two snapshots differing
  only in `policy` hash identically, and `news_model.c` says why in a comment.
- **It clamps, never rejects.** Absent behaves exactly as today: the compiled-in interval stands.
  Out of range goes to the bound. This block cannot cost a page.
- **It does not survive a reboot.** A bad policy must not be able to leave a board polling once a
  day forever. On boot the device uses its configured interval until a payload says otherwise.
- **It is ignored when the clock is not synced.** `next_change` is absolute and the board has no RTC
  — SNTP or nothing. If `time(NULL)` is before 2024-01-01, `next_change` is ignored and
  `poll_seconds` alone governs.

### What this costs in the firmware

| File | Change |
|---|---|
| `news_model.h` | `news_policy_t { int32_t poll_seconds; int64_t next_change; }`, `news_t.policy`. **`sizeof(news_t)` re-measured** — CLAUDE.md records that this number has been wrong twice |
| `news_parse.c` | parse and clamp `policy`; absent leaves it zeroed |
| `news_model.c` | `news_hash()` skips `policy`, with the reason in a comment |
| `news_mock.c` | the demo snapshot carries no policy — absent is the normal case and must be the tested one |
| `tools/mock_news_server.py` | emit it, `--validate` it, `--write-fixture` |
| `test/host/fixtures/news.json` | regenerated |
| `test_news_parse.c`, `test_news_mock.c` | clamps, absence, garbage, fixture parity |
| a new host assertion | policy-only difference hashes identically |
| `user_app.cpp` | **`POLL_SECONDS` and `STALE_SECONDS` stop being compile-time macros** (`:77`, `:102-104`, `:727`, `:823`) and become runtime values under `s_mtx`. `STALE_SECONDS` becomes `max(2 × effective_poll, 900)`. This is the real cost of this section |
| `device_api.c` | `source.pollSeconds` reports the effective value; new `source.pollSource` is `"config"` or `"policy"` |
| `docs/news-contract.md` | the block, the clamps, the hash exclusion, the unsynced-clock rule |
| `sim/` | an assertion that a policy difference changes no pixels |

### Deep sleep is deliberately not in this design

The panel holds its image without power, so sleeping is about the board's own current, not the
paper. But deep sleep drops the 960 KB framebuffer in PSRAM, so every wake pays a full fetch and a
full re-render, and a wake that finds nothing changed has spent that for nothing. The saving that is
actually on the table is the polling itself — 1,440 TLS handshakes a day against Cloudflare at the
current 60 s default — and `poll_seconds` collects all of it. Deep sleep gets its own spec if
measured battery numbers justify the re-render, and it needs RTC-memory state and a Wi-Fi reconnect
budget that this design does not.

## 9. The agent worker

A second container, from `Dockerfile.agent`. Its loop:

1. `GET /api/commands/next?wait=60` with a `producer` token.
2. Assemble the prompt: `tools/edition/PROMPT.md` (the **contract**, public, from the read-only repo
   mount) + `/vault/standing.md` + `/vault/blocklist.md` + `/vault/watchlist.json` + the command
   text + the last few `briefs/`.
3. `claude --print` with the same narrow allowlist `file-edition.sh` uses, plus the market-data MCPs.
   Those already answer at the owner's own market-data MCP endpoints, so the container reaches them
   over the network rather than needing anything from the host.
4. Write into a scratch directory, open a draft, `PUT` the payload and every tile,
   `POST …/proof`.
5. **Fetch the proof PNGs and look at them.** This is the step the whole design exists to make
   possible from a container: the desk owns the one typesetter, and the agent — anywhere — gets the
   sheets back. A failed proof feeds the validator output and the images into a second turn, bounded
   at two retries.
6. `POST …/commit`, then write `/vault/briefs/<date>.md` — what it filed and why — and
   `POST /api/commands/<id>/done`.

Credentials come from `/run/secrets/agent.env`: either `ANTHROPIC_API_KEY`, or
`CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`. Headless Claude Code in a container will not
use a desktop login session, and finding that out at 06:00 is the kind of silent failure
`file-edition.sh` already guards against by checking for `claude` on `PATH` first.

**Nothing in `server/` carries the owner's editorial voice.** The repository gets the loop, the
Dockerfile and `.env.example`. The vault gets the watchlist, the standing instructions, the
blocklist and the briefs. `PROMPT.md` stays in the repository because it is the contract, not the
voice.

## 10. Cloudflare

A third compose service, `cloudflare/cloudflared`, following the pattern already in use on this
machine for six named tunnels.

```yaml
# uuid from `cloudflared tunnel create wpnews`, which also writes the credentials JSON
tunnel: <uuid>
credentials-file: /etc/cloudflared/<uuid>.json
ingress:
  - hostname: wpnews.example.dev
    service: http://desk:8080
  - service: http_status:404
```

Installation is `cloudflared tunnel create wpnews`, then
`cloudflared tunnel route dns wpnews wpnews.example.dev`, then filling those two values into
`server/tunnel/wpnews.yml` — which is gitignored, because it names a hostname and a credentials
path that belong to one person.

`~/.cloudflared` is mounted read-only. The desk publishes to `127.0.0.1:8790` on the host as well,
for local debugging; 8787–8789 are taken by the existing MCP tunnels.

**One hostname, with the control plane at `/api/*` behind a bearer token.** Two hostnames would let
Cloudflare Access sit in front of the API and nothing else, which is cleaner — but Access in front
of non-browser agents means service tokens, a second credential system to hold and rotate. The
ingress can grow a second hostname later without the application changing, so this is a starting
point rather than a ceiling.

**Bot Fight Mode must stay off.** `docs/hosting-cloudflare.md` already gives the argument in full and
it applies unchanged: the board has no JavaScript engine, a challenge is a hard failure, the device
gets HTML where it expected JSON, and the sheet badges `STALE` with nothing in its log to say why.

The tunnel means the board and the Mac no longer have to be on the same network. `wpnews.local`, the
device API and the LAN path are untouched and remain the way back.

## 11. Verification

A **layer 0** goes in front of the four the project already has, because it is faster than all of
them and needs neither Docker nor a network:

```bash
sh server/test/run.sh
```

- schedule arithmetic: DST transitions, quiet windows that wrap midnight, `wake` on day filters,
  `schedule/next` against hand-computed instants
- publish gating: a commit inside a quiet window stages and publishes at the boundary; `min_gap`
  defers; `immediate` does not
- draft lifecycle: byte-count enforcement per tile, the 300 KB payload cap, sweep after an hour
- the atomic swap: a `GET` concurrent with a publish returns one edition, never a mixture
- queue: a command is claimed exactly once under concurrent claimers; leases expire; three attempts
  fail; deadlines expire
- auth: no token is 401 on every `/api/*`; a `producer` token is 403 on `PUT /api/schedule`
- **the disclosure test**: on the device plane, every path other than `news.json`,
  `tiles/<valid-id>.bin` and `healthz` is 404, and every method other than `GET`/`HEAD` is 405
- `proofpng.py` against a BMP the simulator produced
- policy splicing: the served body carries the block, the stored edition does not, and a producer's
  own `policy` key is dropped

Then the existing layers, which the firmware half extends:

```bash
cmake -S components/news_core/test/host -B /tmp/vt && cmake --build /tmp/vt   # + the policy tests
sh components/provisioning/test/run.sh
python3 tools/mock_news_server.py --check
cd sim && ./sim.sh
idf.py build
```

And a **layer 4**, `server/test/smoke.sh`: bring compose up, push
`components/news_core/test/host/fixtures/news.json` as an edition with its tiles from `sim/tiles/`,
and assert `GET /news.json` returns that payload and each `GET /tiles/<id>.bin` matches
byte-for-byte. This is `docs/hosting-cloudflare.md`'s "validate what the wire returns, not what is
on the disk", automated.

`sim/CMakeLists.txt` gains a `FetchContent` fallback pinned to **LVGL v9.4.0** — the tag matching
`main/idf_component.yml`'s `^9.4.0` — used when `managed_components/lvgl__lvgl` is absent. That is
what lets the simulator build in a container with no ESP-IDF, and it also fixes a fresh checkout on
a developer machine, where `managed_components/` is empty until the first `idf.py build`.

## 12. Documentation

| File | |
|---|---|
| `server/README.md` | run it, what it exposes, the two planes, the tokens |
| `docs/desk-server.md` | new: the architecture and the arguments, in the house voice |
| `docs/news-contract.md` | the `policy` block, its clamps, and the hash exclusion |
| `docs/hosting-cloudflare.md` | a third row in its opening table: the tunnel path beside local and Workers |
| `docs/app-control.md` | `source.pollSource` and the effective `pollSeconds` |
| `tools/edition/README.md` | a pointer saying this is now the standalone/LAN path |
| `CLAUDE.md` | `server/` in the project structure; layer 0 in the verify list |

## 13. What this does not do

- **It does not make the board's Wi-Fi work.** Unchanged from `docs/hosting-cloudflare.md`.
- **It does not add deep sleep.** §8.
- **It does not authenticate the device plane.** The edition is public market journalism about one
  company; the board holds no credential and could not present one. What is protected is everything
  that is *not* the edition, and that is protected by not being routable.
- **It does not replace `tools/edition/`.** `file-edition.sh --serve` still files and serves on a
  LAN with no Docker and no domain, and stays the way back.
- **It does not let the device choose anything.** The server decides what is important, the device
  decides what fits, and now the server also decides when. Selection never moves to the one machine
  with no way to research it.
