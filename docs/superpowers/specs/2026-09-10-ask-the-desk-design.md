# Ask the desk: a message from the phone, answered in a sandbox

**Date:** 2026-09-10. **Status:** approved design, not yet built.

The owner types a message on the phone. The agent answers it. If the message
asks for the newspaper to change — "lead with the lawsuit, not the buyback",
"add what the CFO said on the call" — the agent re-researches, rewrites the
edition, and Today and the board show the new one. All of the agent's work,
research included, happens inside a Docker container that cannot reach the
desk's control plane. This document is what that means in each of the three
programs it touches: the desk (`server/`), the worker (`agent/`) and the phone
(`app/`). The board is not touched: a revised edition reaches it exactly as a
morning one does.

## What exists today, and what this reuses

Every piece of plumbing this needs is already there in some form. The design
is mostly a matter of adding one command kind and threading it through.

| piece | today | pointer |
|---|---|---|
| queue | `commands(id, kind, text, priority, status, source, …, result)`, kinds `file_edition / research / custom / calendar`, claim by long poll, `done` / `fail`, a `notes.md` per command | `server/claudepost/store.py:82-109`, `http.py:1246-1258` |
| worker | one Python loop claims, seeds a workdir, runs `claude --print` with the prompt on stdin, reads `news.json` + `tiles/` + `notes.md` back **from the workdir**, then drafts → proofs → commits through the desk's five gates | `agent/loop.py:882-1058`, `:316-349`, `:489-514` |
| runtime | the loop runs **on the Mac** under launchd (`agent/run-host.sh`); a worker image and compose file exist and are unused | `~/Library/LaunchAgents/com.claudepost.worker.plist`, `agent/Dockerfile`, `agent/compose.yaml` |
| credentials | the desk producer token is read by the loop and **stripped from the `claude` child's environment**; the Claude login token is passed through | `agent/deskclient.py:509`, `agent/loop.py:374-395` |
| push | Expo push exists, sent only for calendar alerts, with a `(token, event_id, lead)` delivery ledger | `server/claudepost/push.py`, `app.py:791-835` |
| app | an operator token in the keychain, a desk client with settings / positions / calendar / push methods and **no command methods**; no notification-tap handler at all | `app/src/lib/desk.ts:250-272`, `app/src/lib/notify.ts` |
| context | the operator's own directory, read by the prompt; on this Mac it is `~/.claudepost/context`, not under `~/Documents` | `agent/run-host.sh:70-74` |

Nothing seeds the *current* edition into a worker run today, and nothing in the
app can post a command. Those are the two real additions; the rest is wiring.

## 1. The wall

The requirement is that research and agent work happen in a sandbox, and that
what the phone can ask for is limited to that. The wall is built from three
layers, strongest first, and this section says exactly what each one holds.

**The whole worker moves into the container.** `agent/compose.yaml`'s
`claudepost-agent` service replaces the launchd worker on the same machine,
joining the external `claudepost` network beside the desk. This is the
operator's choice over the alternative of keeping the host loop and spawning a
container per message: one runtime, and the morning edition gets the same
sandbox as a phone message. What it costs is that the desk token, the context
directory and the Claude login are all inside the one container, which is why
the next layer exists.

**Two users inside the container.** The loop runs as **root** inside the
container. Every `claude` invocation is spawned as an unprivileged user,
`model` (uid 10001), through `gosu`. Root is not a shortcut: it is the only
identity that can hand a turn to another user at all. `gosu` is not setuid,
and `compose.yaml`'s `no-new-privileges:true` would defeat a setuid or
file-capability version of it — measured, not reasoned: from uid 10001 in the
image, `gosu root id -u` answers `operation not permitted`. The loop has no
business being root outside the container, so `main()` refuses `AGENT_RUN_AS`
when it is not root, and refuses to run as root when `AGENT_RUN_AS` is unset.
Concretely:

- **The secrets are not a file inside the container.** Compose reads
  `~/.claudepost/agent.env` on the Mac through `env_file` and hands it to the
  loop as environment; the `/run/secrets` bind mount is gone. This is also
  measured: a file bind-mounted from this Mac, reported inside the container
  as `-rw------- 1 0 0`, was read straight out by an unprivileged container
  user, because Docker Desktop's VirtioFS does not enforce bind-mount modes.
  A file mode is not a wall here. The environment is the one boundary the
  kernel enforces between two uids.
- `model` cannot read `/proc/<loop pid>/environ`, because the loop is a
  different uid (`gosu model cat /proc/1/environ` → `Permission denied`,
  measured). The desk token therefore does not exist anywhere `model` can
  reach, which is a stronger statement than today's "stripped from the child
  env", where a Bash tool could in principle read the parent's environment.
- The workdir `/scratch/<cid>` is created and seeded by the loop, then
  `chown`ed to `model` before the run. It is the only writable path the model
  has.
- `/context` (the operator's directory) mounts read-only and world-readable,
  because the prompt is *meant* to read it.
- The Claude login token is the one secret that must reach `model`, because
  `claude` needs it. It is passed in that child's environment and nowhere
  else.
- The watchlist rotation cursor, which today lives beside the secrets, moves
  to its own writable `/state` volume. The read-only secrets mount meant a
  container could seed the watchlist and never advance it.

**The tool allowlist is unchanged.** `DEFAULT_TOOLS` in `agent/loop.py`
stays `Read, Write, Edit, Glob, Grep, WebSearch, WebFetch, Bash(make_tile.py),
Bash(mock_news_server.py)`; `Task` and `Agent` stay disallowed. That list is
what "limited to research and such" means in practice: the model can search
the web, fetch pages, read and write inside its workdir, and run the two repo
scripts. It cannot run arbitrary shell, cannot open a socket of its own, and
cannot post to the desk because it holds no token. A message that asks for
anything else gets an answer saying so, not an attempt.

**What the wall does not do.** The container has ordinary outbound internet,
because WebSearch and WebFetch are the point. It is not an egress allowlist.
Docker Desktop's `host.docker.internal` is reachable from any container; the
desk's `/api/*` behind it still needs a bearer token, and the public plane
(`/news.json`, tiles) is public by design. Say this plainly rather than
implying a network wall that is not there.

**Image changes.** `agent/Dockerfile` gains `gosu` and Pillow (`make_tile.py`
exits without it — the trap that bit the host install) and the `model` user.
No entrypoint script: with a root loop there is nothing for one to do, and
each workdir is chowned per command. `agent/install-docker.sh` (new; there is
no `install-host.sh` in this repository, only `run-host.sh`) builds the image
from the repo mirror, `launchctl bootout`s the launchd worker, and runs
`docker compose up -d`. The morning order job (`com.claudepost.order`) is not
a worker and stays on the host.

## 2. Desk

**Kind.** `COMMAND_KINDS` gains `ask`. `MAX_COMMAND_TEXT` stays 2000; a phone
message is short.

**Columns.** Two nullable columns on `commands`. `store.py` has no migration
path today — its schema is `CREATE TABLE IF NOT EXISTS` only — so this adds
one (`ALTER TABLE … ADD COLUMN` when `PRAGMA table_info` lacks the column),
tested against a hand-written pre-feature table, because the deployed desk
would otherwise raise `no such column` on the first message. `reply_to TEXT` (a command id, the previous turn
of the same thread, validated against `COMMAND_ID_RE` and required to exist)
and `lang TEXT` (`en` / `ko`, the language the phone was in when the message
was typed; `NULL` means "the language of the message itself"). Both round-trip
through `POST /api/commands` and every row the API returns.

**One-command read.** `GET /api/commands/<cid>` (producer scope) returns the
row with `has_notes`, so the phone can poll one thread rather than listing the
queue. 404 for an unknown id.

**Result vocabulary.** For `ask`, `result` is one of `answered`,
`revised <edition_id>`, `staged <edition_id>`, or on failure the worker's
message. The phone branches on the first word. The desk does not parse it.

**The answer.** The worker's `answer.md` is uploaded as the command's existing
`notes.md`; nothing new is stored. `GET /api/commands/<cid>/notes.md` is the
phone's read.

**Push.** When a command whose `source` is `app` transitions to `done` or
`failed`, `Desk.finish` sends one push to every registered device:
title "Claude Post", body "답변이 도착했습니다" or "Your answer is ready"
by the command's `lang`, `data: {"command_id": cid, "result": <first word>}`.
It goes through `push.send` with a new ledger key `(token, "cmd:"+cid, 0)`
so a restart cannot send it twice. A failed command gets its own body rather
than a promise of an answer. `lang` null falls back to the desk's
`settings.lang`, the nearest thing the desk has to the message's language.
Quiet hours are respected, and because `finish` is one-shot where an alert is
retried by a tick, a housekeeping sweep (`Store.finished_since`, bounded at
36 hours) sends a deferred answer once the window ends rather than dropping
it. This is the first push that is not a calendar alert; `push.KINDS` gains
`answer` so a phone can turn it off separately, and `LEAD_KINDS` (the kinds
that carry a lead time) is split from `KINDS`, since an answer has no date.
The app's `PUSH_KINDS` must not learn `answer` before the desk does: the desk
refuses an unknown key over the whole device document, which would turn every
notification registration into a 400. Both ship in one PR, desk first.

## 3. Worker

**Runtime.** `run-host.sh` is kept for a machine without Docker; the shipped
path is compose. `Settings.from_env` gains `AGENT_RUN_AS` (a username, empty
means "do not switch user"), and `claude_argv` prefixes `gosu <user>` when it
is set. `child_env` is unchanged in what it strips; the uid split is what
makes the strip unnecessary rather than what replaces it. `read_token`
accepts `CLAUDEPOST_TOKEN` from the environment as well as from `agent.env`,
which is how the compose path delivers it.

**Two languages, not one.** `build_prompt` takes `ask_lang` (the command's
`lang`) beside `lang` (the desk's edition language). The paper's language and
the conversation's are different settings: a message typed in English must
not turn a Korean edition into an English one.

**Seeding an `ask`.** Beside the usual `watchlist.json`, the loop writes:

- `current/news.json` — the edition the desk serves now, fetched from the
  public plane (`GET /news.json`, with the tiles it names into
  `current/tiles/`). This is the paper the message is about.
- `previous.md` — when `reply_to` is set, that command's `notes.md` (the
  earlier answer) and its `text` (the earlier question), so a follow-up
  reads as a conversation. One turn back, not the whole thread: the desk keeps
  every turn, and the phone shows them, but the prompt gets the one that
  matters.

**Prompt.** `prompt.build_prompt` gains an `ask` section, placed after the
contract and directives and before the message, saying:

1. Answer the message in the language it was written in (fall back to `lang`
   when the message is ambiguous, e.g. a ticker alone). Write the answer to
   `answer.md`. It is the whole reply; keep it to what was asked.
2. Decide whether the message asks for the paper to change. Questions,
   opinions, "why did it move", "what is EPS" do not. "Change", "add", "lead
   with", "drop", "replace the photo", and the Korean equivalents do.
3. Only if it does: copy `current/news.json` to `news.json`, re-research what
   the change needs, rewrite the affected parts under the same contract and
   budgets, produce any new tiles, and say in `answer.md` what changed and
   why in two or three sentences. Do not touch parts the message did not ask
   about. Do not write `news.json` for an answer-only message.

The decision is the model's, per the owner's choice, and the loop does not
second-guess it: a `news.json` in the workdir after the run means "revise".

**After the run.** `handle()` for `ask`:

- no `news.json` → upload `answer.md` as notes, `finish(cid, ok=True,
  "answered")`.
- `news.json` present → the existing path: open draft, put payload and tiles,
  put `answer.md` as the draft's notes too, proof, up to two revision turns,
  the look turn, commit. Then `finish(cid, ok=True, "<state> <edition_id>")`
  where state is `revised` for `published` and `unchanged` (an edit that
  changed nothing is still an answer), `staged` for `staged`.
- `answer.md` missing → `finish(cid, ok=False, "no answer written")`.

The five gates apply unchanged. A revised edition that fails validation fails
the command, and the previous edition stays current — the same failure
semantics as the firmware's.

**Deskclient.** Gains `command(cid)` and `command_notes(cid)` (for
`reply_to` seeding: the earlier question and its answer) and
`fetch_public(path)` for the public plane. Still no `publish`: the worker's
token is producer scope and forcing a publish is the operator's act.

## 4. App

**Entry.** An "Ask" button in the Today tab's header opens `/ask`. The Today
screen is the paper; the question is about the paper.

**Threads.** Kept on the phone in AsyncStorage under `claudepost.threads`: a
list of threads, each a list of turns `{command_id, text, lang, sent_at,
status, result, answer?}`. The desk is the source of truth for status and the
answer; the phone stores them so a thread renders offline. No server-side
thread object: `reply_to` is the thread.

**Sending.** `desk.ts` gains `postCommand({kind:"ask", text, reply_to?,
lang, source:"app"})`, `command(id)`, `commandNotes(id)`, and `publishNow()`
(`POST /api/publish`, operator, which the phone's token already is). A send
appends a turn with status `pending` and posts; failure to post keeps the
turn with an error and a retry.

**Waiting.** While any turn in the open thread is `pending` or `claimed`, the
screen polls `GET /api/commands/<id>` every 5 s on the focus-gated interval
`board.tsx` uses. On `done` it fetches the notes, stores the answer, and
branches on `result`:

- `answered` — render.
- `revised <eid>` — render, show a "신문을 바꿨습니다 / The paper changed"
  chip on the turn, and invalidate the edition cache so Today refetches
  `news.json` on its next focus.
- `staged <eid>` — the owner asked for the change, so the phone calls
  `publishNow()` and then behaves as `revised`. If that call fails the chip
  says the edition is staged and offers the publish button.
- `failed` — render the worker's message as the turn's error.

**Push.** `notify.ts` registers a notification response listener at app start
(`expo-notifications`, the app's first). A tap on a push carrying
`data.command_id` routes to `/ask` with that thread open. The `answer` push
kind appears in the notification settings beside the alert kinds.

**Rendering.** The answer is markdown; render it with the same component the
schedule uses for `reason`, or a small markdown renderer if there is none.
The type ramp follows the app's UI language, not the edition's.

## 5. Tests and verification

- **Server** (`server/test/`): `ask` in `COMMAND_KINDS`; `reply_to` must
  exist and match the id pattern; `lang` validated like settings; `GET
  /api/commands/<cid>` 200/404 and scope; a push is sent on `done` for
  `source=app` and not for `source=schedule`, once, with the ledger key.
- **Agent** (`agent/test/`): `claude_argv` with `AGENT_RUN_AS` set and unset;
  the `ask` seeding writes `current/news.json` and `previous.md` when
  `reply_to` is set; `handle()` outcomes for the three end states from a fake
  `claude` that writes `answer.md` alone, `answer.md` + `news.json`, or
  nothing; `prompt.build_prompt` for `ask` contains the three-rule section and
  the contract's `## The language` heading.
- **Image**: `docker build` succeeds; `docker run --rm claudepost-agent
  id -u` prints 0 and `gosu model id -u` prints 10001; no `agent.env` exists
  anywhere in the image (the credential arrives as environment, §1); Pillow
  imports; and `gosu model cat /proc/1/environ` is denied — the one check the
  kernel enforces. These are `agent/test/image.sh`, which exits 0 without
  building when `docker` is not on `PATH` or not running.
- **App** (`app/`): client method request shapes; thread reducer transitions
  (pending → claimed → done with each result; failed; retry); `entryRouteFor`
  unaffected.
- **End to end**, before the PR: `docker compose up` beside the local desk,
  post an `ask` from the thread screen on the iPhone simulator against that
  desk, watch the container answer it, then a second message that asks for a
  change and confirm Today shows the revised edition. Screenshots kept in the
  PR.

## Out of scope, deliberately

- Streaming. One message, one answer, minutes apart; the queue's shape.
- A server-side thread model. `reply_to` is enough for a phone that keeps
  its own list.
- An egress allowlist for the container.
- Translating source articles into the edition's language with a summary,
  and the A2 group-label size — both raised in the same conversation and
  parked until a Korean edition has been looked at.
