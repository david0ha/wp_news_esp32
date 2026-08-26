// Compatibility shim. The redesign's tokens live in src/theme/ (colors, typography, spacing,
// radius, motion — plan Design), which every new or migrated screen should import from directly.
// This file re-exports the pre-redesign dark-terminal palette, unchanged, under its old names so
// a screen this task did not touch keeps compiling and keeps rendering exactly as it did before.
// Deleted in Task 31, once nothing imports it — see src/theme/legacy.ts for the values themselves.
export { colors, radius, space, layout, fonts } from './theme/legacy'
