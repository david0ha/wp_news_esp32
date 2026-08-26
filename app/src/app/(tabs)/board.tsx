import Dashboard from '../dashboard'

// Board — the hardware: what hangs on the glass, where it fetches from, how it sleeps
// (plan Design > Wireframes).
//
// Temporarily the pre-redesign dashboard, verbatim, so the app still reaches a real board
// end to end while the other three tabs are placeholders. Task 31 replaces this with the
// designed Board tab and deletes src/app/dashboard.tsx along with it.
export default function Board() {
  return <Dashboard />
}
