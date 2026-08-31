// Which proof sheet is A1 and which is A2.
//
// The app does not get to name these. `getEdition(eid).sheets` lists whatever the typesetting gate
// left on disk, which is `tools/edition/render-check.sh`'s own output — today `01_a1_full.png` and
// `02_a2_full.png`, and a `.bmp` where the render died before conversion (desk.ts's `sheetUrl`
// comment). A client that asked for a literal "A1.png" would get a 404 from a desk that was working
// perfectly, which is exactly the bug this file exists to prevent: the earlier Today screen
// hardcoded that pair and drew an empty box for it.
//
// So: three rules, in order, and the middle one is the subtle one.
//
//   1. NAME. A sheet that names the page asked for IS the page asked for. Nothing outranks it.
//   2. ELIMINATION. A sheet that names the OTHER page is not this one — that is a claim about that
//      one sheet, and it holds whatever the rest of the list looks like. But a sheet that names no
//      page has made no claim at all, so it stays a candidate. When exactly one candidate survives,
//      it is the answer by elimination; when several do, there is nothing to choose between them
//      and the answer is nothing. (The earlier version treated a name ANYWHERE in the list as a
//      reason to discard every unnamed sheet, which orphaned `accounts.png` in
//      `['01_a1_full.png', 'accounts.png']` — a claim about one sheet applied to another.)
//   3. POSITION. Only when NO sheet names any page. The gate writes them in reading order and the
//      desk hands them back in that order, so index 0 is the front page and index 1 the accounts —
//      a weaker claim than a name, which is why it is last and not first.

/** The two pages this paper has. Anything outside it resolves to nothing rather than to a guess. */
const PAGES = 2

// `a1` bounded by non-alphanumerics (or the ends of the string), so `01_a1_full.png` matches on its
// middle token and `data1_full.png` does not match at all — the `1` there is the tail of a word.
const PAGE_TOKEN: readonly RegExp[] = [
  /(?:^|[^a-z0-9])a1(?:[^a-z0-9]|$)/i,
  /(?:^|[^a-z0-9])a2(?:[^a-z0-9]|$)/i,
]

/**
 * The sheet that holds `page` (0 = A1, the front page; 1 = A2, the accounts), or `null`.
 *
 * `null` is a real answer and not an error: an edition pruned down to one sheet, or a gate that
 * died after the first render, genuinely has no A2 to show. A caller draws the empty state for it.
 */
export function sheetForPage(sheets: readonly string[], page: number): string | null {
  if (!Number.isInteger(page) || page < 0 || page >= PAGES) return null

  // 1. Named for this page.
  const named = sheets.find((name) => PAGE_TOKEN[page].test(name))
  if (named) return named

  // 3. Nothing in the list names any page: fall back to reading order.
  const anyNamed = sheets.some((name) => PAGE_TOKEN.some((re) => re.test(name)))
  if (!anyNamed) return sheets[page] ?? null

  // 2. Some sheets are named, none of them for this page. Whatever names no page is still a
  //    candidate; one survivor is an answer, more than one is a guess.
  const unclaimed = sheets.filter((name) => !PAGE_TOKEN.some((re) => re.test(name)))
  return unclaimed.length === 1 ? unclaimed[0] : null
}
