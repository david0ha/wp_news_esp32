// Radius names the material — plan Design > Direction: paper is square-cut (`0`), desk/chrome is
// rounded (`8/12/20/pill`). A component reaching for `radius.paper` on a card and `radius.md` on
// a button is not a style choice, it is which material the thing is drawn on.
export const radius = {
  paper: 0,
  sm: 8,
  md: 12,
  lg: 20,
  pill: 999,
} as const
