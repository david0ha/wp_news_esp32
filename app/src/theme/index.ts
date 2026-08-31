// The redesign's token entry point — plan Design. Two materials, paper and desk, that never
// blend: `colors` carries both plus the two-tier signal colours and the keylined yellow grade;
// `typography` carries the newspaper faces for paper and the bare system font for chrome;
// `spacing`, `radius` and `motion` are shared by both. Import from here, not from an individual
// module, so a screen gets the whole system rather than one file of it.
export { colors } from './colors'
export { typography, type TypographyRole } from './typography'
export { spacing } from './spacing'
export { radius } from './radius'
export { motion } from './motion'
export { pressTransition, pressedScale } from './press'
