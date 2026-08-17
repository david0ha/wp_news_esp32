# The desk server

The always-on half. It owns the URL the board polls, takes instructions from
agents anywhere, decides *when* a new page may reach the glass, and typesets
every candidate before it does.

The board polls one URL and nothing in the firmware knows what answers it.
[`tools/edition/`](../tools/edition/README.md) answers it from a Mac on the LAN
and [`publish.sh`](../docs/hosting-cloudflare.md) answers it from a Cloudflare
Worker. Both are *publishing* mechanisms — something files an edition, something
else copies it somewhere — and neither can be **told** anything. This is the
third thing: a service that can be asked, from anywhere, by anything holding a
token.

The design and the arguments behind it are in
[docs/desk-server.md](../docs/desk-server.md). This file is how to run it.

## What it exposes, and the line down the middle

**Two planes, and there is no route from the first to the second.** Not "it is
authenticated" — it is not routed.

| Device plane — anonymous, `GET` only | |
|---|---|
| `GET /news.json` | the current edition, with the `policy` block spliced in |
| `GET /tiles/<id>.bin` | the tiles beside it |
| `GET /healthz` | liveness |

Everything else on that plane is `404`, and every method other than `GET` and
`HEAD` is `405`. That is
[`docs/hosting-cloudflare.md`](../docs/hosting-cloudflare.md)'s "the publish
directory is the allowlist" moved into a routing table, and the reason for
moving it is that a directory allowlist only holds while somebody keeps
assembling the directory. A routing table holds because there is no code that
can serve a fourth path. `server/test/test_http.py` asserts it.

| Control plane — `/api/*`, `Authorization: Bearer` | |
|---|---|
| Drafts | `POST /api/drafts` · `PUT …/news.json` · `PUT …/tiles/<id>.bin` · `POST …/proof` · `POST …/commit` · `GET …` |
| Editions | `GET /api/editions` · `GET /api/editions/<id>` · `POST /api/editions/<id>/promote` |
| Queue | `POST /api/commands` · `GET /api/commands/next?wait=60` · `POST …/done` · `POST …/fail` · `GET /api/commands` · `DELETE …` |
| Directives | `GET/POST /api/directives` · `DELETE /api/directives/<id>` |
| Schedule | `GET/PUT /api/schedule` · `GET /api/schedule/next` |
| Operations | `GET /api/state` · `POST /api/publish` · `POST /api/hold` |

Errors come back as `{"ok":false,"error":"<code>"}` with a 4xx — the same
envelope [`device_api.c`](../components/device_api/device_api.c) uses, so a
client that speaks to the board speaks to the desk.

## Setting it up

**1. Tokens.** Two scopes: `producer` may push editions and claim commands,
`operator` may also change the schedule and force a publish.

```sh
server/tools/mint-token.sh operator me
server/tools/mint-token.sh producer agent
```

Both land in `~/.wpnews/tokens.json`, mode 0600, **outside the repository and
outside the vault**. Outside the repository because the repository is public;
outside the vault because the vault is a git repository and git history is
permanent.

**2. The agent's own credential.** `~/.wpnews/agent.env`, also 0600:

```sh
ANTHROPIC_API_KEY=sk-ant-...        # or CLAUDE_CODE_OAUTH_TOKEN from `claude setup-token`
WPNEWS_TOKEN=<the producer token from step 1>
```

Headless Claude Code in a container will not find a desktop login session.
Discovering that at 06:00 is exactly the silent failure `file-edition.sh`
already guards against by checking `PATH` first, so the worker warns at startup
if neither is set.

**3. Where the private half lives.**

```sh
cp server/.env.example server/.env
# set WPNEWS_VAULT to ONE SUBDIRECTORY of your vault, e.g.
#   /Volumes/ssd/ObsidianBrain/02_areas/investing/wpnews
```

One subdirectory, never the whole vault: this container answers the internet and
a vault is somebody's whole second brain. The desk creates the layout inside it
on first start and never overwrites anything you wrote.

```
<WPNEWS_VAULT>/
  standing.md        your standing editorial instructions   <- you write this
  blocklist.md       what must never print                  <- you write this
  watchlist.json     the rotation                           <- you write this
  schedule.json      the schedule; edit here or over the API
  briefs/<date>.md   what the desk filed and why            <- the worker writes these
  archive/<id>/      filed editions and their proof sheets
```

**4. The tunnel.**

```sh
cloudflared tunnel create wpnews
cloudflared tunnel route dns wpnews wpnews.example.dev
cp server/tunnel/wpnews.yml.example ~/.cloudflared/wpnews.yml
# put the uuid it printed into both fields, and your hostname into the ingress
```

**5. Up.**

```sh
docker compose -f server/compose.yaml up -d
docker compose -f server/compose.yaml logs -f desk
```

**6. Point the board at it, once.**

```sh
curl -X POST http://wpnews.local/api/news \
     -d '{"url":"https://wpnews.example.dev/news.json"}'
```

## Driving it

```sh
DESK=https://wpnews.example.dev
TOKEN=$(…)                                   # the operator token

# ask for something
curl -sS -X POST "$DESK/api/commands" -H "Authorization: Bearer $TOKEN" \
     -d '{"kind":"file_edition","text":"NVDA — earnings last night, lead on the guide","priority":0}'

# a standing instruction, which is NOT the same thing
curl -sS -X POST "$DESK/api/directives" -H "Authorization: Bearer $TOKEN" \
     -d '{"rule":"Never print TSLA."}'

# the schedule, and what it will actually do next
curl -sS "$DESK/api/schedule"      -H "Authorization: Bearer $TOKEN"
curl -sS "$DESK/api/schedule/next" -H "Authorization: Bearer $TOKEN"

# what the desk is doing
curl -sS "$DESK/api/state" -H "Authorization: Bearer $TOKEN"
```

**A command and a directive are different objects and the difference is
silent.** *"Research NVDA now"* is consumed once and forgotten. *"Never print
TSLA"* must hold forever. Put the second in the queue and it applies to exactly
one edition, after which the desk forgets it and you conclude the system ignored
you. That is why they are two stores.

## Verifying

Layer 0, in front of the four this project already has. Faster than all of them
and needs neither Docker nor a network:

```sh
sh server/test/run.sh
```

It covers the schedule arithmetic (including DST and quiet windows that wrap
midnight), the publish gating, the queue's exactly-once claim under twenty
concurrent claimers, the token scopes, the atomic pointer swap, and the one
property the device plane exists to have.

Then, once the containers are up:

```sh
sh server/test/smoke.sh
```

which pushes the committed fixture through the real draft → proof → commit path
and asserts that what the **wire** returns is what went in — byte-for-byte on
every tile. That is
[`docs/hosting-cloudflare.md`](../docs/hosting-cloudflare.md)'s "validate what
the wire returns, not what is on the disk", automated, and it is the check that
catches a publish that copied the wrong file or copied nothing.

## Two things that will bite

**Bot Fight Mode must stay off.** It "may challenge API or mobile app traffic"
and the challenge assumes a JavaScript engine. The board has none, so a
challenge is a hard failure: the device gets HTML where it expected JSON,
`news_parse()` rejects it (leaving the previous edition alone, as designed), and
the sheet badges `STALE` with nothing in the board's log to say why. On the Free
plan you cannot carve out an exception — Bot Fight Mode does not run on the
Ruleset Engine, so WAF *Skip* rules have no effect on it.

**Pulling the SSD does not blank the newspaper, and that is on purpose.**
Serving state is a Docker volume; the vault is the source and the archive. With
the vault gone the worker cannot file and `GET /api/state` reports
`vault: "unavailable"`, but the board keeps receiving the last edition. This is
the infrastructure form of the rule the parser already follows: a rejected
payload leaves the previous snapshot byte-for-byte alone.
