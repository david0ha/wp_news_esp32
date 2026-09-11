import { createContext, useContext, type ReactNode } from 'react'
import { NO_SOURCE, type EditionSource } from '../../lib/edition/source'

/**
 * WHERE THIS EDITION CAME FROM, for the one component that needs it.
 *
 * Only `PhotoTile` reads it, and only to build `source.tileUrl(photo.id)` with `source.headers`.
 * Everything between the screen and that one call was passing a string through untouched:
 * `Masonry` -> `EditionTile` -> `PhotoTile`, and `TileDetail` -> `DetailPhoto` -> `PhotoTile`.
 * Five components declared a prop that four of them had no use for.
 *
 * IT CARRIES A SOURCE AND NO LONGER A URL, because there are now two planes an edition can arrive
 * on and a string can only express one of them. See `lib/edition/source.ts`.
 *
 * A context and not a field on the tile, because the address belongs to the CACHE ENTRY and not to
 * the edition: `editionToTiles` is pure and knows nothing about where the JSON was served from.
 *
 * The default is `NO_SOURCE`, which resolves every id to `''` — so a mount outside a provider
 * draws its caption on a plain ground rather than throwing.
 */
const EditionSourceContext = createContext<EditionSource>(NO_SOURCE)

export function EditionSourceProvider({
  source,
  children,
}: {
  source: EditionSource
  children: ReactNode
}) {
  return <EditionSourceContext.Provider value={source}>{children}</EditionSourceContext.Provider>
}

/** How to fetch the pictures of the edition on screen. `NO_SOURCE` when there is nowhere. */
export function useEditionSource(): EditionSource {
  return useContext(EditionSourceContext)
}
