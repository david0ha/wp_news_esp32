// Colour, in two materials that never blend — plan Design > Colour and Direction.
//
// Paper: a white square-cut sheet, black hairline rules, unchanged in dark mode (a sheet is a
// physical object photographed against a surround; the reader site already decided this — see
// docs/hosting-cloudflare.md's reader). Desk: near-black chrome for anything that issues a
// command. Every value here is either the reader site's own token or a measured contrast ratio,
// not a guess — see the self-critique in plan Design ("every value is from a file in the repo or
// a contrast measurement").

export const colors = {
  // Paper — the sheet, in all three faces.
  paper: '#FBFAF7', // reader site --paper
  ink: '#14130F', // reader site --ink; rules
  inkMuted: '#56534A', // reader site --muted

  // Desk — near-black chrome, for anything that issues a command.
  desk: '#16151A', // reader site dark surround
  deskRaised: '#1E1D22', // cards on chrome
  deskText: '#E9E6DF', // reader site dark text
  deskDim: '#A5A096',
  deskFaint: '#6E6A62',

  // Signal colours in two tiers, forced by measurement: the measured Spectra red (#62201E,
  // tools/make_tile.py) is 1.56:1 on `desk` — a raw panel ink as a UI accent on dark chrome is a
  // legibility bug, not a style choice. The sheet images carry the true inks; the app's own marks
  // carry the same hues lifted for a backlit display. See ui_chg_colour() and format.ts's
  // changeTone() for the same "direction is ink at exactly zero" rule on the device and in code.
  signal: {
    paper: {
      up: '#1F7A3D', // 5.15:1 on paper
      down: '#B3261E', // 6.26:1 on paper
      tint: '#233F8E', // 9.26:1 on paper
    },
    chrome: {
      up: '#4CAF6A', // 6.61:1 on desk
      down: '#E4574C', // 4.99:1 on desk
      tint: '#6E93DE', // 5.96:1 on desk
    },
  },

  // Grades. Yellow is the measured Spectra ink from tools/make_tile.py (#C1BB1E) — 1.94:1 on
  // paper, the same value band as paper itself (CLAUDE.md's "two bands with nothing between
  // them"), so it is exported only as {fill, keyline} and must be drawn on a paper-white pill with
  // a black keyline: grade discs are small pieces of paper on the desk, never bare yellow on
  // chrome. The type below makes the keyline unskippable — there is no bare-fill escape hatch.
  grade: {
    red: '#B3261E',
    green: '#1F7A3D',
    yellow: {
      fill: '#C1BB1E',
      keyline: '#14130F', // = ink; the only pairing that clears panel contrast (9.20:1)
    } as { readonly fill: string; readonly keyline: string },
  },
} as const
