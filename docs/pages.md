# The four pages

648 × 480, one bit deep. Every page shares a 44 px header and a 34 px footer, leaving a
648 × 398 content area at y = 46. `KEY0` cycles forward, `BOOT` back.

The grid is fixed and absolute, and nothing on any page reflows. That is a display constraint, not
a style: a row that moves when a number gains a digit is unreadable at a glance, and on e-Paper a
reflow means the whole panel changed and has to be fully refreshed.

## Chrome

```
 14        122          244        336            478      578  606
┌──────────────────────────────────────────────────────────────────┐
│ WP NEWS  second-brain  [DEMO]  2026-08-10 (월)  11:23   ((•   ▉ │ 44
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│                        content, 648 × 398                        │
│                                                                  │
├──────────────────────────────────────────────────────────────────┤
│ 1/4 볼트 통계   ● ○ ○ ○   KEY0 페이지 · KEY1 새로고침 · KEY2 길게 Wi-Fi │ 34
└──────────────────────────────────────────────────────────────────┘
```

Fixed slots, not a flex row, for two reasons. The clock is the only thing that gets a targeted
partial refresh, and a targeted refresh needs a rectangle that does not move when the news name
gets longer. And every slot here has a neighbour it must not touch — which a layout engine would
let it do silently.

The news name gets its own slot rather than being concatenated onto the brand: a combined
`WP NEWS · <name>` label ellipsizes the brand away first, which reads as a device that has
forgotten what it is.

**One badge slot, ranked.** `DEMO` (no URL configured) beats `오프라인` (Wi-Fi down or the last
fetch failed at the transport) beats `오래됨` (the snapshot is older than two poll intervals). Three
indicators competing for 88 px would either overlap or need a layout pass; ranking them means the
header always shows the most important thing wrong, which is all a glance from across a room can
carry anyway.

## 0 · 볼트 통계

```
┌──────────────┬──────────────┬──────────────┬──────────────┐
│    1,428     │    3,910     │      37      │     212      │
│     노트     │     링크     │     고아     │     태그     │
├──────────────┴──────────────┴──────────────┴──────────────┤
│ 최근 7일 활동                        오늘 +6 · 이번 주 +41 │
│      ▁      ▅      █      ▂      ·      ▄      ▃          │
├───────────────────────────┬───────────────────────────────┤
│ 상위 태그                 │ 볼트 상태                     │
│ 프로젝트 ███████████  186 │ 링크 밀도      2.74 개 / 노트 │
│ 데일리   ████████     141 │ 고아 비율             2.6 %   │
│ 영역     █████         88 │ 에이전트       2 / 5 실행 중  │
│ ...                       │ 마지막 동기화         21:04   │
└───────────────────────────┴───────────────────────────────┘
```

Counters are grouped (`1,428`) — the four headline numbers are the first thing read from across a
room, and an ungrouped five-digit number is measurably slower to parse.

The activity bars scale against **the week's own peak**, not a fixed maximum, so a quiet week still
shows its shape rather than seven stubs. A zero day keeps a 2 px stub: a chart that divides by the
value rather than the peak renders it as nothing at all, and "no bar" and "no data" then look
identical. The demo snapshot contains a zero day precisely so the simulator asserts on this.

## 1 · 링크 그래프

The news's highest-degree notes and the links between them. Deliberately **not** a force-directed
layout — see `ui_graph.h` for the argument, but briefly: physics is iterative (this runs on the task
that owns a panel), seeded (the simulator and the device would draw different pictures from
identical data, which makes the simulator useless as a test), and unbounded (a node ends up
off-canvas and nobody notices until it is on the glass).

Instead: concentric rings, biggest hub at the centre, everything else spread evenly outwards in
degree order. Integer arithmetic throughout, including a 91-entry sine table rather than libm —
`sin()` is only guaranteed to agree between an x86 host and an Xtensa target to within an ulp, which
is exactly enough to move a node one pixel and fail a screenshot test for a reason that has nothing
to do with the layout.

Node radius scales with link degree, against the local range rather than an absolute one, so a news
of uniformly-linked notes still shows some variation instead of fourteen identical dots.

Draw order is the only subtle thing: **edges, then a white disc per node, then the node's outline.**
The white disc is what stops six edges converging on a hub from turning it into an unreadable black
star. Node titles get an opaque white background for the same reason — a line running through the
middle of a word is unreadable on a panel with no greys to soften it.

`test_graph_layout.c` asserts that every node's circle *and its label box* lie inside the canvas,
for every node count from 1 to 14, on four differently-shaped canvases.

## 2 · 에이전트

```
● indexer      [실행 중]  20:55   처리 1,428   대기 3   [███████░░░]
  새 노트 6건 임베딩 중
───────────────────────────────────────────────────────────────────
○ summarizer   [대기]     18:30   처리 412     대기 0
```

Two lines per agent: the machine-readable row, and what it is actually doing. The second line is the
one a human reads, so it gets the full width.

`progress: -1` (or absent) means the agent has no meaningful completion figure and **no bar is
drawn**. An empty bar there would read as "stuck at 0%", which is a different and much more alarming
thing than "not applicable".

The state word is Korean on the panel and English on the wire, which is why
`news_agent_state_name()` (for `/api/state`) and the page's own `state_label()` are separate
functions. One is an identifier; the other is prose.

## 3 · 최근 노트

Recent notes on the left, the inbox queue on the right, with a full-height divider — two
ragged-bottomed lists with no rule between them read as one list.

The inbox header shows `inbox_total`, not the number of visible rows. A count that silently equalled
what fits would turn a backlog of forty into a comfortable eight.

This is the page where a subset font would have failed: every title on it arrives over the network.
See [fonts](#fonts) below.

The inbox is also the one list that can be *added to* rather than only watched, from the companion
app's memo box or a `curl`. That write never touches the board — it goes to the machine serving the
snapshot, which creates the note, and the board sees it on its next poll like any other change. See
[news-contract.md](news-contract.md#capture).

## Fonts

Seven faces, all SIL Open Font License 1.1, chosen against the paper being imitated rather than by
taste: **UnifrakturMaguntia** for the blackletter masthead, **Playfair Display** for headlines
(WP sets its own in Postoni, a Didone), **Source Serif 4** for the deck and body, and **Libre
Franklin** — a revival of Franklin Gothic — for bylines, kickers, captions and the folio line.

| face | family | size | role |
|------|--------|------|------|
| `ui_font_masthead_112` | UnifrakturMaguntia | 112 | the paper's name |
| `ui_font_display_56`   | Playfair Display 800 | 56 | the lead headline |
| `ui_font_display_36`   | Playfair Display 700 | 36 | secondary headlines |
| `ui_font_deck_24`      | Source Serif 4 Italic, opsz 11 | 24 | the standfirst |
| `ui_font_body_20`      | Source Serif 4, opsz 10 | 20 | the lead story's body |
| `ui_font_body_16`      | Source Serif 4, opsz 8 | 16 | column body text |
| `ui_font_label_14`     | Libre Franklin 600 | 14 | bylines, captions, folio, ticker |

118 KB of flash for all seven, against an 8 MB app partition.

### Every face is 1 bpp, and that is a measurement

The panel has no grey. LVGL renders anti-aliased text as intermediate RGB565 and the flush callback
puts that through `wp_quantize565()`, which ordered-dithers to the six inks. For a photograph that
is correct and necessary. For text it is destructive: a 16 px serif stem is about 1.5 px wide, so
half of it is anti-aliasing, and dithering that half turns a solid stem into a dotted one. Rendered
side by side, 4 bpp body text has holes punched through `m`, `w` and every descender, and the 112 px
masthead grows a ragged stipple along contours that 1 bpp keeps smooth.

At 1 bpp every text pixel is exactly `WP_RGB_BLACK` or `WP_RGB_WHITE`, and `wp_quantize()` maps both
to themselves under every dither offset — so text takes the quantizer's identity path and cannot
pick up a colour fringe.

### Optical sizes are calculated

Source Serif 4 carries an `opsz` axis calibrated in points, and this panel's pixel pitch is known
(1600×1200 over 13.3" is 150.4 dpi), so each face is instanced at the optical size its pixel size
actually *is*. `ui_font_body_16` is 7.7 pt and instanced at opsz 8 — sturdier stems and more open
counters than the same family at opsz 20, which is what survives a 1-bit render.

### Coverage

Headlines, decks and body text arrive over the network and cannot be subset, so every *text* face
carries ASCII, all of Latin-1 (Bogotá, Zürich, Müller are routine in a dateline) and the typography
in `S_DATA_PUNCT`. The board this forked from subset its fonts to seventy glyphs because every
string it drew was a literal in its own source; here, half the strings arrive at runtime, and the
failure mode of guessing is a tofu box on somebody's headline.

The masthead face is the one exception. It is subset — but to the whole Latin alphabet plus
`" .,'-&"`, not to the letters `S_MASTHEAD` happens to use, so changing the paper's name is one line
and not one line plus a font regeneration. The simulator checks `S_MASTHEAD` against that face by
name, and every data string against all six text faces.

## Where the layout is asserted

`sim/main_sim.c` renders all four pages at 648 × 480 and checks the pixels: every list row inked,
every graph node and label inside the canvas, exactly one filled page dot, the header and footer
rules intact, the overlay opaque, and every string covered by its font. It exits non-zero on any
failure, so `./sim.sh` is a test that happens to leave screenshots behind.

It earns its keep. On its first run it caught two real bugs: a missing em dash in a note title, and
labels wrapping instead of ellipsizing because only their width was set, which put a second line on
top of the row below.
