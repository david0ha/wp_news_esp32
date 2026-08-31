// Motion — plan Design > "Space, radius, motion". `press`/`reveal`/`stagger` are milliseconds for
// `withTiming`; `spring` is a Reanimated spring config. The refresh ring's own duration is
// deliberately NOT a token here — it is `state.panel.refreshMs`, the measured duration of the
// board's real refresh, not a design decision (see <OnTheGlass> in plan Design > Signature).
export const motion = {
  press: 120,
  reveal: 260,
  stagger: 70,
  spring: {
    damping: 20,
    stiffness: 180,
    mass: 0.6,
  },
} as const
