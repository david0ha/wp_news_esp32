# tools/edition/

The typesetting gate and the desk's standing instructions, shared by every producer:

- [`PROMPT.md`](PROMPT.md) — the desk's standing instructions, handed to whatever agent does the
  research and the writing.
- [`render-check.sh`](render-check.sh) — runs the real typesetter over a candidate edition before it
  files. Every producer runs this as a gate; see [docs/news-contract.md](../../docs/news-contract.md).

Nothing here files an edition by itself. The producers that use these two are elsewhere:

- [`agent/standalone/`](../../agent/standalone/README.md) — the no-server LAN path: a `launchd` job,
  a directory, `python3 -m http.server`.
- [`server/`](../../server/README.md) — the always-on desk: a container behind a Cloudflare tunnel, a
  command queue, a schedule, and this same gate run before every candidate page is accepted.
