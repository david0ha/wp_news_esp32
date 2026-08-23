# Serving the edition from Cloudflare

The board polls **one URL**. Nothing in the firmware knows or cares what answers it, and there is no
setting anywhere that says "local" or "cloud" — there is a URL, and it is either reachable or it is
not. So this is a choice about your own circumstances, not about the device:

| | What answers the URL | Good when |
|---|---|---|
| **Local** — [agent/standalone/README.md](../agent/standalone/README.md) | `python3 -m http.server` on the machine that files the edition, under `com.wpnews.serve.plist` | the board and that machine are on the same network, and the machine is awake whenever the board polls |
| **Cloudflare Worker** — this document | a Worker serving two static files | they are not, or the machine sleeps, or you would rather not run a server on your LAN at all |
| **The desk server** — [desk-server.md](desk-server.md) | a container behind a Cloudflare **tunnel**, answering live | you want to *tell* it things: a queue agents push instructions into from anywhere, a schedule, and a typesetting gate on every candidate page |

All three are supported and none is a migration you have to finish. `publish.sh` does not care
whether something is also serving locally, and you can switch back by pointing the board at the
other URL. Keep whichever fits.

The third differs in kind rather than in degree, and it is worth being clear about which problem it
solves. The first two are *publishing*: something files an edition, something else copies it
somewhere, and neither can be asked a question. The desk server can be asked — which is what buys a
queue, a schedule, and a page that is typeset before it reaches a wall. It costs a container that
has to keep running. If all you want is the edition on a public URL, the Worker below is less
machinery and it is the right answer.

The rest of this describes the Cloudflare path, in a way that should work for anyone with a
Cloudflare account. **You do not need to own a domain.**

## What actually has to be served

Two paths, and **only the first one is configured**:

| Path | What |
|---|---|
| `<the news URL>` | the edition, as [docs/news-contract.md](news-contract.md) defines it |
| `<the news URL's directory>/tiles/<id>.bin` | one 4 bpp tile per picture |

The second is derived, not entered. `derive_base()` in `components/news_core/ui_tile.c:97` takes the
news URL, cuts the query and fragment, walks back to the last `/`, and appends `tiles/`:

```
https://host/news.json            ->  https://host/tiles/<id>.bin
https://host/wpnews/news.json     ->  https://host/wpnews/tiles/<id>.bin
```

There is no setting for the tile base and there should not be: a payload names its pictures by id,
and a picture that lived somewhere other than beside its payload would be a second thing to
configure and a second thing to get wrong. **Whatever you host, `news.json` and `tiles/` are
siblings.**

A tile is held to exactly `w * h / 2` bytes by `ui_tile.c` — the dimensions the payload declares are
the contract, and a short file is a truncated tile rather than a small one. The device never looks
at `Content-Type`; there is no such check anywhere in `news_core`. Serve the bytes and the byte
count and it is satisfied.

A missing tile is **not** an error. The module reflows without the picture and the page still
prints. Worth knowing before you spend an evening on why one `.bin` 404s.

## The thing that changes character the moment you leave the LAN

`agent/standalone/README.md` ends with a warning that is easy to read as boilerplate and is not:

> `--serve-only` is `python3 -m http.server` bound to `0.0.0.0`, serving `$EDITION_DIR` **read-only
> over plain HTTP with no authentication**. Everything in that directory is reachable, not just
> `news.json` — the watchlist naming the owner's positions, the tiles, and `log/`, which holds a week
> of filed editions and the agent's own transcripts.

On a home network that is a considered posture. On a public URL it is a disclosure:

```
~/.wpnews/edition/
  watchlist.json     the symbols you follow, and which one is next   <- yours
  news.json          the edition                                     <- publish
  tiles/<id>.bin     the pictures                                    <- publish
  log/               a week of transcripts, filed editions, proofs   <- yours
```

So the rule everything here is built on: **the publish directory is the allowlist.** `publish.sh`
assembles `agent/standalone/public/` from those two things and `wrangler.jsonc` deploys *that*, never
`$EDITION_DIR`. An allowlist that is a directory listing cannot drift out of sync with itself the
way a list of exclusions can, which is the whole reason to do it this way round.

`public/` is rebuilt from empty on every publish, so a tile dropped from the payload leaves the site
in the same motion. It is gitignored.

## The shape: a Worker serving static assets

`agent/standalone/wrangler.jsonc` — committed, and meant to work **unmodified**. There is no `main`;
the assets are the whole application, no code runs per request, and
[requests to static assets are free and unlimited](https://developers.cloudflare.com/workers/platform/pricing/)
at any poll interval the board supports.

R2 and KV both exist and both are wrong here. The edition changes **twice a day**. A deploy of two
files twice a day is less machinery than a bucket, a binding and a fetch handler, and this project's
stated preference is that the least machinery that can produce the URL wins.

## Steps

**1. A Cloudflare account.** The free plan is enough. Nothing below needs a paid feature.

**2. Deploy.**

```sh
npx wrangler login                  # once, interactively
./agent/standalone/publish.sh
```

`publish.sh` validates the payload, sets the type, assembles `public/`, and deploys. It prints the
URL. With no domain configured that URL is

```
https://wpnews-edition.<your-account-subdomain>.workers.dev/news.json
```

because [every Cloudflare account gets a `workers.dev` subdomain](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/)
and `wrangler.jsonc` opts into it. That is the whole domain story if you do not want to buy a name.
Cloudflare notes it is "treated as a Free website" and meant for personal projects rather than
business-critical ones, which is exactly what this is.

First deploy to a new workers.dev name can return **523** for a minute while DNS propagates. Wait
and retry before debugging anything.

**3. A domain, only if you want one.** Uncomment the `routes` block in `wrangler.jsonc` and put your
own hostname in it. Requires an active zone on your Cloudflare account, and the hostname must not
already have a CNAME record; wrangler creates the DNS record and provisions the certificate. A
subdomain of a zone you already own costs nothing.

**4. Point the board.**

```sh
curl -X POST http://wpnews.local/api/news \
     -d '{"url":"https://wpnews-edition.YOURS.workers.dev/news.json"}'
```

or the same URL through the captive portal. `prov_validate_news_url()` already accepts `https://`
(`components/provisioning/prov_config.c:37`) and `PROV_URL_MAX_LEN` is 128 characters, which a
workers.dev URL is nowhere near.

**5. Publish on a schedule.** Publishing is an **event**, like filing, and unlike serving. Call
`publish.sh` at the end of `file-edition.sh`, or add it to `com.wpnews.edition.plist` after the
filing job.

Under launchd there is no browser for `wrangler login`, so give it a token instead: Cloudflare
dashboard → My Profile → API Tokens → the *Edit Cloudflare Workers* template, scoped to the one
account. `publish.sh` reads `~/.wpnews/cloudflare.env` (`chmod 600`) if it exists:

```
CLOUDFLARE_API_TOKEN=...
CLOUDFLARE_ACCOUNT_ID=...
```

That file is outside the repo on purpose. Nothing personal belongs in `wrangler.jsonc`.

**6. The serving job becomes optional.** `com.wpnews.serve.plist` exists because the board polls
continuously and something must always be listening. Cloudflare is that something now:

```sh
launchctl unload ~/Library/LaunchAgents/com.wpnews.serve.plist
```

Keep the plist file. It is the way back if the domain is ever the thing that is broken.

## What changes on the device

**Nothing has to be recompiled.** HTTPS is already built and already configured:

| | |
|---|---|
| `CONFIG_ESP_HTTP_CLIENT_ENABLE_HTTPS` | on |
| `CONFIG_MBEDTLS_CERTIFICATE_BUNDLE_DEFAULT_FULL` | on — the full Mozilla root set |
| `NewsTask` stack | 16 KB, and `user_app.cpp` says in as many words that the size is for a synchronous TLS handshake on this task's stack |
| `save_client_session` | on for `https://` URLs (`http_port_esp.c`) |

Two things are worth deciding rather than inheriting.

**Every poll now pays a full TLS handshake.** `http_port_release()` drops the connection at the end
of each poll cycle, which is right — no server holds an idle socket for a minute, and the mock
server closes at thirty seconds — but the handle it destroys is also where the saved TLS session
lives, so the session ticket goes with it. Over plain HTTP on a LAN that cost nothing. Against
Cloudflare it is an ECDSA verify per poll: seconds, on a core, and at the default minute's cadence
1,440 times a day. The task watchdog is at 60 s and this is nowhere near it, so nothing breaks —
but it is real work being done to no purpose.

Which leads to the second:

**`CONFIG_WP_NEWS_POLL_SECONDS` is 60, and 60 is a LAN number.** It was lowered from 300 to make the
first sheet of a boot land quickly, which is a LAN concern; the edition itself is filed twice a day.
A minute's polling against a local Python server costs nothing and buys a fast response to a
hand-filed edition; against a public endpoint it is 1,440 handshakes a day for two changes — and, on
battery, roughly 58 mAh a day against a quarter-hour's 3.8. 900 or 1800 is the honest number for
this deployment, and the range allows up to 86400. Little is lost by widening it: the
device fingerprints every snapshot and skips the panel refresh when nothing it draws has changed, so
a poll that finds the same edition already costs nothing visible — and `KEY1` and
`POST /api/refresh` both still force one immediately.

Note the one thing widening it *does* touch: a snapshot gets the `STALE` badge once it is older than
two poll intervals **or** `STALE_FLOOR_SECONDS` (900), whichever is longer. At the 60 s default the
floor is what governs, so the badge means a quarter of an hour; at 1800 s the interval takes over
again and it becomes an hour, which is the right meaning for a paper filed twice a day and the wrong
one for a minute-by-minute tape. The floor is there so that lowering the cadence cannot make the
badge twitchy — it answers a question about the news, not about the poll loop.

## Cloudflare settings that will actually bite

**Bot Fight Mode must stay off.** It is off by default; leaving it that way is the requirement. It
"may challenge API or mobile app traffic", and the challenge it issues assumes a JavaScript engine.
The board has none, so a challenge is a hard failure — the device gets HTML where it expected JSON,
`news_parse()` rejects it (leaving the previous edition alone, as designed), and the sheet badges
`STALE` with nothing in the board's log to say why.

And you cannot carve out an exception on the Free plan.
[Bot Fight Mode does not run on the Ruleset Engine](https://developers.cloudflare.com/bots/get-started/bot-fight-mode/),
so WAF custom rules with *Skip*, *Bypass* or *Allow* have no effect on it. The documented remedies
are to turn it off, or to move to Super Bot Fight Mode on a Pro/Business plan, which does support
Skip rules. For a page of public market data there is nothing here worth defending.

The same caution applies to any managed rule or IP reputation action you switch on later. A device
that cannot solve a challenge and cannot report one is the worst possible client to put behind a
challenge.

**Enter the `https://` URL on the board** rather than relying on an http→https redirect.
`esp_http_client` follows redirects, so `http://` would work — but it spends a round trip
discovering that every poll, and the first request of each poll would travel in clear.

**Content types.** Wrangler infers them from the extension: `.json` → `application/json`, `.bin` →
`application/octet-stream`. The device checks neither, so this is hygiene rather than function — but
it is the difference between a browser downloading a tile and rendering it as mojibake when you are
debugging by hand.

## Verifying, before believing any of it

The project's rule is four layers, cheapest first. This adds one that has to come between the
producer and the board.

```sh
# 1) the payload is a legal edition and sets as type.
#    publish.sh runs both of these before it copies anything, so this is only
#    for checking by hand.
python3 tools/mock_news_server.py --validate ~/.wpnews/edition/news.json
tools/edition/render-check.sh   ~/.wpnews/edition/news.json

# 2) what is about to go public, without publishing it
./agent/standalone/publish.sh --dry-run
find agent/standalone/public -type f          # news.json and tiles/*.bin. Nothing else.

# 3) the SITE serves the contract — both paths
BASE=https://wpnews-edition.YOURS.workers.dev
curl -sS -o /dev/null -w '%{http_code} %{size_download}\n' "$BASE/news.json"
curl -sS -o /dev/null -w '%{http_code} %{size_download}\n' "$BASE/tiles/<id>.bin"

# 4) the payload the SITE serves is the one that validated
curl -sS "$BASE/news.json" > /tmp/served.json
python3 tools/mock_news_server.py --validate /tmp/served.json --tiles ~/.wpnews/edition/tiles

# 5) the board agrees
curl -X POST http://wpnews.local/api/refresh
curl -sS http://wpnews.local/api/state    # last_result, age_seconds, stale
```

Step 2 is the one that proves the disclosure problem is handled, and it is a `find`, so do it once
and believe it.

Step 4 is the one people skip and the one that catches a publish that copied the wrong file, copied
nothing, or copied a `news.json` that was mid-write. Validate what the wire returns, not what is on
the disk.

## What this does not solve

It does not make the board's Wi-Fi work. A device that cannot reach its gateway cannot reach
Cloudflare either, and the failure looks identical: `ESP_ERR_HTTP_CONNECT`, then the previous
edition badged `STALE`. `net_time`'s SNTP sync against `pool.ntp.org` is the cheap discriminator in
the boot log — if the clock synced, the board's route to the internet is fine and the problem is
further up.

What it does solve is that the desk, the server and the board stop having to be on the same network,
awake at the same time, and agreeing about ARP.

## Going back to the LAN

```sh
launchctl load ~/Library/LaunchAgents/com.wpnews.serve.plist
curl -X POST http://wpnews.local/api/news -d '{"url":"http://mymac.local:8123/news.json"}'
```

Both paths can stay installed indefinitely. The board reads exactly one URL; which one is the only
thing that decides.
