// Which proof sheet is A1 and which is A2.
//
// The app does not get to name these. `getEdition(eid).sheets` lists whatever the typesetting gate
// left on disk, which is `tools/edition/render-check.sh`'s own output — today `01_a1_full.png` and
// `02_a2_full.png`, and a `.bmp` where the render died before conversion (desk.ts's `sheetUrl`
// comment). A client that asked for a literal "A1.png" would get a 404 from a desk that was working
// perfectly, which is exactly the bug this file exists to prevent: the earlier Today screen
// hardcoded that pair and drew an empty box for it.
//
// So: two rules, in order.
//
//   1. NAME. If any sheet names a page — `a1` / `a2` as a whole token — then names govern the whole
//      list, and a page with no named sheet resolves to nothing. A list that says "this one is A1"
//      is also saying "this one is not A2", and honouring the first half while ignoring the second
//      is how a caller ends up printing the front page under an "accounts" heading.
//   2. POSITION. Only when NO sheet names a page at all. The gate writes them in reading order and
//      the desk hands them back in that order, so index 0 is the front page and index 1 the
//      accounts — a weaker claim than a name, which is why it is the fallback and not the rule.

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

  const named = sheets.some((name) => PAGE_TOKEN.some((re) => re.test(name)))
  if (named) {
    return sheets.find((name) => PAGE_TOKEN[page].test(name)) ?? null
  }

  return sheets[page] ?? null
}
