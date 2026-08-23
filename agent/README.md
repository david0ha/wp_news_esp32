# The worker

An example producer. It claims an instruction from the desk, runs headless
Claude Code over the shipped contract, pushes the result as a draft, **looks at
the proof sheets the desk sends back**, and commits.

It is a worked example, not a framework: three files of standard library, no
dependencies, and nothing in it that a producer in another language could not do
instead. The desk's contract is HTTP and a bearer token; this directory is one
way of speaking it.

## The two halves

| | [`server/`](../server/README.md) | `agent/` (here) |
|---|---|---|
| what it is | the desk: the URL the board polls, the queue, the schedule, the typesetter | the worker: research and prose |
| how long it runs | forever. It is a condition | minutes, a few times a day. It is an event |
| what it holds | bearer tokens, and nothing else of anybody's | your API key, and whatever notes you point it at |
| who can reach it | the internet, through a tunnel | nobody. It dials out |

**Filing is allowed to fail; serving is not.** A worker that dies mid-research
leaves yesterday's paper on the wall, which the firmware is designed to survive
and badge `STALE`. One container that did both would turn that into a blank
wall, which is the failure a reader actually notices. That is the same argument
[`agent/standalone/README.md`](standalone/README.md) makes for splitting
`com.claudepost.edition` from `com.claudepost.serve`, and it does not stop being true
inside Docker.

The desk validates, typesets and decides when a page may be published. The
worker owns the half a language model is actually for.

## Running it

**1. The network, once.** Both compose files join it and neither creates it, so
that neither owns the other:

```sh
docker network create claudepost
```

**2. Credentials**, in `~/.claudepost/agent.env`, mode 0600, **outside the
repository** — because the repository is public and git history is permanent:

```sh
ANTHROPIC_API_KEY=sk-ant-...          # or CLAUDE_CODE_OAUTH_TOKEN from `claude setup-token`
CLAUDEPOST_TOKEN=<a producer token>   # server/tools/mint-token.sh producer agent
```

Headless Claude Code in a container will not find a desktop login session, so
the worker warns at startup if neither of the first two is set rather than
letting you discover it at 06:00.

**3. Up.**

```sh
cp agent/.env.example agent/.env      # then fill it in
docker compose -f agent/compose.yaml up -d
docker compose -f agent/compose.yaml logs -f
```

Order does not matter. There is no `depends_on` across compose files, and none
is needed: the claim loop backs off from one second to five minutes and stays
there, so a worker started before the desk waits rather than exits.

Then queue something for it, from anywhere holding a token:

```sh
curl -sS -X POST "$DESK/api/commands" -H "Authorization: Bearer $TOKEN" \
     -d '{"kind":"file_edition","text":"NVDA — earnings last night, lead on the guide"}'
```

## What it does with one instruction

1. **Claim.** `GET /api/commands/next?wait=60` parks on the desk until there is
   something or the wait expires.
2. **Assemble.** [`tools/edition/PROMPT.md`](../tools/edition/PROMPT.md) — the
   contract, which ships — then your context files, then the desk's standing
   directives, then the instruction. In that order, because the contract must
   not be pushable below somebody's opinions and the instruction is the thing
   being answered.
3. **Write.** One `claude --print` turn against a scratch directory, with the
   allowlist from `AGENT_TOOLS`.
4. **Push.** `POST /api/drafts`, then the payload and every tile beside it.
5. **Look.** `POST …/proof` runs the desk's real typesetter, and the worker
   **fetches the sheets back and reads them**. This is the step the rest exists
   for: a column that ran short, a headline that broke on the wrong word, a
   photograph that halftoned to mush are all things no schema check can find and
   a reader notices from across a room. Up to two revisions, then a verdict pass.
6. **Commit.** `POST …/commit`, and report the command done.

## Bring your own continuity

There is nothing personal in this repository and there is not going to be. What
makes a paper sound like yours — a house style, a rotation, a list of things
that must never print, what you covered on Tuesday — lives in a directory you
own, and `AGENT_CONTEXT_DIR` points at it.

The convention is deliberately thin: **every flat `.md` and `.json` file
directly in that directory is appended to the prompt under its own name, in
sorted order.** No schema, no required file, no name the code knows. Point it at
a folder of an Obsidian vault, a git checkout of notes, or a directory you made
this morning. Subdirectories are not read, anything over 64 KiB is cut with a
visible marker, and a directory that is not there is simply no context — the
worker files a perfectly good page from the contract alone.

[`context.example/`](context.example/) is a set of empty templates to copy
somewhere and start from. Copy it out of the repository first; do not point
`AGENT_CONTEXT_DIR` at it in place.

To turn it on, set `AGENT_CONTEXT_DIR` in `agent/.env` and uncomment the volume
line in [`compose.yaml`](compose.yaml) that mounts it. It is commented rather
than defaulted because a default there would be somebody's disk.

**Writing back** is a second decision. With `AGENT_WRITE_BRIEFS=1` and the mount
changed to `:rw`, the worker appends what it filed and why to
`<context>/briefs/<date>.md` — which it never reads back, because subdirectories
are not context. It is off by default: pointing this worker at your notes is a
decision to have it read them, and deciding on your behalf that it may also
write into them is not this repository's to make.

## Market data

There is none in the default allowlist. The worker gets reads, writes, search,
web fetch, and the two repository scripts the contract names — and no broker, no
exchange, no market-data MCP, because which one to trust is your decision and
your credential.

Add yours through `AGENT_TOOLS`, which replaces the whole allowlist:

```sh
AGENT_TOOLS=Read,Write,Edit,Glob,Grep,WebSearch,WebFetch,mcp__your_broker__*,Bash(python3 {repo}/tools/make_tile.py:*),Bash(python3 {repo}/tools/mock_news_server.py:*)
```

`{repo}` is substituted with the repository root inside the container. The list
is narrow on purpose, and one absence is load-bearing: **`render-check.sh` is
not on it.** The desk owns the typesetter and hands the sheets back; a worker
that could typeset locally would be a second copy of the gate that decides, and
two gates that can disagree are worse than one.

## Configuration

Everything is read once, in `Settings.from_env` — [`loop.py`](loop.py) is the
only file in this directory that touches the environment.

| Variable | Default | What it is |
|---|---|---|
| `CLAUDEPOST_DESK` | `http://desk:8080` | the desk. `http://host.docker.internal:8790` on Docker Desktop against a local desk; `https://your-hostname/` through the tunnel from another machine |
| `CLAUDEPOST_SECRETS` | `/run/secrets` | where `~/.claudepost` is mounted: `agent.env`, or `tokens.json` as a fallback |
| `CLAUDEPOST_REPO` | `/repo` | the repository in the image — `PROMPT.md` and `tools/` |
| `CLAUDEPOST_SCRATCH` | `/scratch` | one workdir per command: the payload, the tiles, the sheets fetched back |
| `AGENT_CONTEXT_DIR` | unset | your context directory. Unset, missing or empty are all "no context". That is a **host** path in `agent/.env` or a bare run; under `docker compose` the container always sees `/context`, so there the commented volume line is the switch and this variable is what it mounts |
| `AGENT_WRITE_BRIEFS` | `0` | whether the worker may append to `<context>/briefs/`. Needs a context directory too |
| `AGENT_TOOLS` | see above | the `claude --print` allowlist. Empty means the default |
| `CLAUDEPOST_LOG_LEVEL` | `INFO` | `DEBUG` adds the whole transcript |
| `TZ` | `UTC` | log timestamps and the date a brief is filed under |

## Verifying

Standard library, no Docker, no network, no API key:

```sh
sh agent/test/run.sh
```

It covers the two halves worth being sure about without a desk in front of them:
the prompt — the order of its sections, and that reading a stranger's directory
is total — and the HTTP client, including the one property that is not about
correctness at all, that **a bearer token never reaches an exception message**.
Those strings are handed to `POST /api/commands/<id>/fail`, where the desk
stores them and an operator reads them later.

## The other paths

- [`agent/standalone/`](standalone/README.md) — no desk, no Docker, no domain: a
  `launchd` job, a directory and `python3 -m http.server`. If the board and one
  Mac are on the same network and that Mac is awake when the board polls, that
  is the whole system.
- [`server/`](../server/README.md) — the desk itself: what it exposes, how to
  set up the tunnel, and how to drive it.
- [`tools/edition/PROMPT.md`](../tools/edition/PROMPT.md) — the contract both
  paths hand to whatever does the writing. Shared, and not this directory's.
