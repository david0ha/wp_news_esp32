# Reading the edition in the app: what to borrow from Pinterest, YouTube and TikTok

Scope: an in-app reader for one company-a-day editions (5–12 items) plus an archive of past days.
Constraints assumed: Expo 56 / React 19, RN core `Animated`, gesture-handler, react-native-svg, no
reanimated, no FlashList, iOS first. Existing tokens in `app/src/theme.ts` are the baseline.

## 1. Pinterest

**Philosophy**
- The grid is a *browsing* surface, not a reading one. Items are homogeneous in kind and
  heterogeneous in height; the eye picks, it does not parse.
- Calm comes from subtraction: no borders, no shadows, no card chrome. A tile is an image with
  rounded corners on a plain ground, and at most one line of text under it.
- Height is the only differentiator, so height must be *known before render*. Gestalt caches
  measured item heights in a `measurementStore` so returning from a detail page does not reflow.
- Motion is short and physical: press feedback is 150 ms linear scale, entrances 300 ms on a
  bounce curve, swipes 400 ms.

**Measurable specs** (from Gestalt's published tokens and the Masonry component docs)

| Thing | Value |
|---|---|
| Base spacing/rounding unit | 4px ("boint") |
| Rounding scale | 0, 4, 8, 12, 16, 20, 24, 28, 32, pill 999, circle 50% |
| Type sizes | 12, 14, 16, 20, 28, 36; weights 400/500/700; line-height 1.1–1.8 |
| Motion durations | 50, 100, 150, 200, 300, 400, 500, 600, 700, 900 ms |
| Semantic motion | fade-in 300 ms "lateral"; fade-out 200 ms; enter 300 ms "bounce"; press-scale 150 ms linear; swipe 400 ms |
| Masonry defaults | `columnWidth` 236px, `minCols` 3, explicit `gutterWidth`, `virtualBufferFactor` 0.7 |

Sources: the `pinterest/gestalt` token JSON files (`vr-theme/sema/rounding.json`,
`vr-theme/base/motion.json`, `base/text/font.json`, `base/space.json`);
https://gestalt.pinterest.systems/web/masonry

**Interaction patterns worth taking**
- **Closeup**: tap a pin, the image expands into a detail page with the media at top, a small
  action row, the text below, and — critically — *the grid resumes underneath* as "More like this".
  The detail page is a continuation of the feed, not a dead end.
- **Infinite scroll with restored position.** NN/g: infinite scroll suits "homogeneous items with
  no particular task", fails for finding a specific item or comparing distant ones, and its worst
  concrete bug is losing scroll position on back-navigation. Cache heights and offsets.
  https://www.nngroup.com/articles/infinite-scrolling-tips/
- Skeleton placeholders sized by the *known* item height, so nothing jumps when content lands.

## 2. YouTube mobile

**Philosophy**
- One card shape repeated: media rectangle, title (max 2 lines), one quiet meta line. Everything
  else is progressive disclosure.
- Filter chips under the header let a user narrow a heterogeneous feed without leaving it.
- Shelves: a horizontal carousel inside the vertical feed marks a different *kind* of content
  (Shorts) without a separate tab.
- Text is collapsed by default and expands in place. The description truncates with "...more";
  comments show a one-line teaser under the video that opens a full panel on tap.
  https://www.androidpolice.com/2020/04/24/youtube-collapse-comment-section-video-pages/
- The 2025 tests that enlarged home-feed thumbnails drew loud complaints — bigger media at the
  cost of items-per-screen is not free.
  https://www.itechguides.com/youtube-is-testing-giant-homepage-thumbnails-and-many-desktop-users-hate-losing-the-video-grid/

**Specs**: media 16:9; title ~2 lines then ellipsis; meta a single dim line; chips pill-shaped,
horizontally scrolling, sticky under the header; the mini-player persists as a bottom-anchored
sheet so playback survives navigation.

## 3. TikTok

**Philosophy**
- One item fills the viewport; the only navigation is a vertical swipe. Near zero decisions per item.
- Chrome overlays the media rather than sitting beside it — caption bottom-left, a vertical action
  rail bottom-right in the thumb arc, because the hand is already there for the swipe.
- Discovery is a separate, denser surface: a uniform 3-column grid of 9:16 covers cropped to ~3:4.
  Immersion and browsing are different screens, never the same one.

Sources: https://www.iteratorshq.com/blog/5-tiktok-ui-choices-that-made-the-app-successful/ ,
https://careerfoundry.com/en/blog/ui-design/tiktok-ui/ , https://moda.app/resources/sizes/tiktok

**Specs**: full-bleed 9:16 pages, `pagingEnabled` snap, one action rail ~56–64px wide, icons stacked
with counts beneath, autoplay on focus, a thin progress hairline at the foot.

## 4. Cross-cutting

**Offline and stale.** The consensus pattern is cache-then-refresh with a *tiered* staleness signal:
nothing under ~5 minutes, a quiet "Updated 15m ago" to 30 minutes, a visible timestamp to 24 hours,
an explicit "Last updated yesterday" beyond. A global banner only when the fetch actually failed,
never a spinner over content that already exists.
https://androidengineers.substack.com/p/the-complete-guide-to-offline-first ,
https://leancode.co/blog/offline-mobile-app-design

**New vs archive.** All three apps mark recency by *position and one word*, never by a badge on every
card: today's material is the top surface; the archive is a separate, denser, uniform grid.

**Making text feel visual.** The working move in editorial apps is to let type *be* the image: set
the headline large in a tinted block at the tile's own aspect ratio, so a story tile carries the
same visual weight as a photograph. Numbers become images the same way — one figure at display size
with its change beneath. Evidence on masonry is mixed: dynamic layouts read as engaging, uniform
ones as organised, so heterogeneity has to be *earned* by genuinely different content rather than
manufactured. https://www.nngroup.com/videos/grid-layouts/

**Motion reference** (Material 3, useful because RN `Easing.bezier` takes the same curve): emphasized
`cubic-bezier(0.2, 0, 0, 1)`; durations 50/100/250/300/450/500 ms; container-transform for
grid→detail. https://m3.material.io/styles/motion/easing-and-duration

**Touch and type floors** (Apple HIG): 44×44pt minimum target, 17pt body, SF Pro Text ≤19pt vs
Display ≥20pt. https://developer.apple.com/design/human-interface-guidelines/typography

## 5. Recommendations for the edition viewer

### (a) Screen map
1. **Today** — sticky masthead (company, ticker, price, change, date, staleness line), a chip row,
   then a two-column masonry of the edition's items.
2. **Item detail** — the tapped tile at top, full text below, then "More from this edition" as the
   masonry resuming underneath. Swipe-down to dismiss.
3. **Archive** — a *uniform* two-column grid, one tile per day, newest first, month headers.
4. **Sheets** (second priority) — the real A1/A2 proofs as a two-page full-screen pager.

### (b) What each screen borrows

| Screen | Pattern | From |
|---|---|---|
| Today feed | two-column masonry, borderless tiles, height-first layout | Pinterest |
| Chip row | pill filters: All / Story / Numbers / Accounts / Photo | YouTube |
| Item detail | closeup with the feed resuming below; body collapsed to ~8 lines then "More" | Pinterest + YouTube |
| Accounts table | teaser rows in the tile, full statement in a bottom sheet | YouTube comments panel |
| Archive | uniform grid, one shape, no masonry | TikTok discover |
| Sheets viewer | snap paging, overlaid minimal chrome | TikTok |
| Staleness | tiered timestamp, banner only on failure | cross-cutting |

### (c) How an item becomes a pin
Seven tile types, each with a fixed aspect so height is computable before layout:
- **Lead story** 3:4 — headline at 22/26, deck one line, a hairline rule. Type is the image.
- **Brief** 1:1 — headline 17/22, two-line body clamp.
- **Hero number** 1:1 — price at display size, change beneath in the direction colour only.
- **Chart** 4:3 — react-native-svg, no axis labels in the tile, full scale in detail.
- **Dossier** variable — 3 label/value rows, then "+4 more".
- **Photo** native aspect, clamped 2:3…3:2 — the halftone unmodified.
- **Accounts** 4:5 — three rows of the statement, right-aligned tabular figures.

Implement `estimateTileHeight(item, colWidth) → number` as a pure function, split items into two
column arrays by running total (shortest column first), and render both columns inside one
`ScrollView`. RN's `FlatList numColumns` lays out equal-height rows and zig-zags with variable
heights, so it cannot do this directly. At 5–12 items per edition there is nothing to virtualise.
**Do not add a masonry library.** `react-native-masonry-list` is pure JS and small, but it buys
virtualization you do not need and costs the deterministic heights the detail transition wants.
Use `FlatList numColumns={2}` for the archive, where every tile is the same shape.
https://reactnative.dev/docs/flatlist , https://github.com/hyochan/react-native-masonry-list

### (d) Token proposal (extends the existing theme, does not replace it)

| Token | Value | Note |
|---|---|---|
| Columns | 2 | 3 is unreadable for type-as-image at phone width |
| Outer margin | 16 (`layout.gutter`) | unchanged |
| Column gutter | 12 | tighter than the margin so the grid reads as one block |
| Tile radius | 18 (`radius.lg`) | already the card radius; Pinterest's own primary is 16 |
| Tile chrome | none | no border, no shadow on tiles; `shadow.float` stays for sheets and CTAs |
| Tile padding | 14 | 16 leaves too little measure at a ~168px column width |
| New `type.pinHeadline` | Inter 800, 22/26, -0.4 | lead tile |
| New `type.pinDeck` | Inter 400, 14/19, `textDim` | one line, ellipsized |
| Reuse | display 42, headingSm 18, body 15, caption 13 | unchanged |
| Press feedback | scale 0.97, 150 ms linear | Gestalt `scale.on` |
| Open detail | 300 ms, `Easing.bezier(0.2, 0, 0, 1)` | Material emphasized |
| Dismiss | 200 ms fade plus translate | Gestalt fade-out |
| Skeletons | tile-shaped, from the same height estimator | no layout shift |

### (e) Five anti-patterns to avoid
1. **Uniform tiles in a masonry.** If every tile ends up the same height, masonry costs complexity
   for nothing — ship a list. Heterogeneity must come from the content.
2. **An all-caps eyebrow on every tile.** `type.label` is a section marker, used once per section.
   Repeated per card it reads as a generated template.
3. **Dot-separated meta lines** ("AAPL · 2h ago · Chart"). One quiet line, one fact, or nothing.
4. **Gradient washes and drop shadows on tiles.** The calm in all three references comes from flat
   tiles on a plain ground. Keep `gradients.aurora` behind the page, never inside a tile.
5. **Colour as decoration.** Carry the firmware rule into the app: colour means *direction* or
   *series identity*, nothing else. No green tile backgrounds, no accent-tinted headers, no
   icon-in-a-circle badge on every card.

Bonus sixth: do not copy TikTok's action rail. Its five icons are earned by social mechanics this
content does not have. One action per detail screen (share, or send to the board) is the ceiling.

## Sources
- Pinterest Gestalt design tokens (raw JSON in `pinterest/gestalt`, path `packages/gestalt-design-tokens/tokens/vr-theme/`): `sema/rounding.json`, `base/motion.json`, `base/text/font.json`, `base/space.json`
- Gestalt Masonry: https://gestalt.pinterest.systems/web/masonry
- NN/g, Infinite Scrolling: https://www.nngroup.com/articles/infinite-scrolling-tips/
- NN/g, grid layouts: https://www.nngroup.com/videos/grid-layouts/
- TikTok UI analyses: https://www.iteratorshq.com/blog/5-tiktok-ui-choices-that-made-the-app-successful/ , https://careerfoundry.com/en/blog/ui-design/tiktok-ui/
- TikTok grid and cover sizes: https://moda.app/resources/sizes/tiktok
- YouTube progressive disclosure: https://www.androidpolice.com/2020/04/24/youtube-collapse-comment-section-video-pages/ , https://www.xda-developers.com/youtube-android-tests-comments-below-video-description/
- YouTube thumbnail-size backlash: https://www.itechguides.com/youtube-is-testing-giant-homepage-thumbnails-and-many-desktop-users-hate-losing-the-video-grid/
- Material 3 easing and duration: https://m3.material.io/styles/motion/easing-and-duration
- Apple HIG typography: https://developer.apple.com/design/human-interface-guidelines/typography
- Offline-first staleness tiers: https://androidengineers.substack.com/p/the-complete-guide-to-offline-first , https://leancode.co/blog/offline-mobile-app-design
- RN list constraints: https://reactnative.dev/docs/flatlist , https://github.com/hyochan/react-native-masonry-list
