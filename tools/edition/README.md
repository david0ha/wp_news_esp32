# tools/edition/

The typesetting gate and the desk's standing instructions — the one contract every producer in this
repository shares:

- [`PROMPT.md`](PROMPT.md) — the standing instructions handed to whatever agent does the research
  and the writing: the shape of the payload, the colour policy, and the length budget for every
  field.
- [`render-check.sh`](render-check.sh) — runs the real typesetter over a candidate edition before it
  files, and `PROMPT.md` requires it as a gate. See
  [docs/news-contract.md](../../docs/news-contract.md) for what it enforces and why.

Nothing here files an edition or serves one. Two producers call these two files:

- [`agent/`](../../agent/README.md) — the desk's worker — and
  [`agent/standalone/`](../../agent/standalone/README.md), the no-server LAN path it was split from.
- [`server/`](../../server/README.md) — the always-on desk: a container behind a Cloudflare tunnel,
  a command queue, a schedule, and this same gate run before every candidate page is accepted.

## The desk cannot see the paper

This is the part that is easy to skip and the part that matters most. A producer writes JSON;
twenty minutes later a panel on a wall spends twenty-five seconds turning that JSON into type, and
if the lead headline was four characters too long the reader gets an ellipsis in the middle of a
sentence and nobody finds out. Validating the schema does not catch that. Only setting the type
catches it.

```bash
tools/edition/render-check.sh <path/to/news.json>
```

That runs the **real typesetter** — the same `news_core`, the same seven faces, the same
compositor, the same six-ink quantizer the firmware runs — over the candidate payload at the
panel's real 1200 × 1600, and leaves both sheets as PNGs. It fails what the build fails: a missing
glyph, a rule off its row, ink outside the margin, a module that rendered nothing, a label wider
than its slot, a masthead over 1140 px, blue or yellow reaching the glass, a composition that does
not tile the well. Anything it lets through will print.

Before that, every producer still runs the cheaper check — the schema, the length budget, and the
tiles:

```bash
python3 tools/mock_news_server.py --validate <path/to/news.json>
```

Both run, because they fail different things and the fast one gives a better error message. What
each one rejects, what it only warns on, and why, is in
[docs/news-contract.md](../../docs/news-contract.md).
