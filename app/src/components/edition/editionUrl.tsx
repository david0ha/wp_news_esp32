import { createContext, useContext, type ReactNode } from 'react'

/**
 * WHERE THIS EDITION CAME FROM, for the one component that needs it.
 *
 * Only `PhotoTile` reads it, and only to build `tileUrl(newsUrl, photo.id)` — the picture lives
 * beside the payload at `<the news URL's directory>/tiles/<id>.bin`, so a photograph cannot be
 * fetched without knowing the address the JSON came from. Everything between the screen and that
 * one call was passing the string through untouched: `Masonry` -> `EditionTile` -> `PhotoTile`,
 * and `TileDetail` -> `DetailPhoto` -> `PhotoTile`. Five components declared a prop that four of
 * them had no use for, and a sixth tile kind would have had to declare it too.
 *
 * A context and not a field on the tile, because the URL belongs to the CACHE ENTRY and not to
 * the edition: `editionToTiles` is pure and knows nothing about where the JSON was served from,
 * and giving every photo a resolved URL would mean re-cutting the feed whenever the address
 * changed. Both screens already hold the entry, so both can name it once at the top.
 *
 * The default is the empty string, which is exactly what an unconfigured phone has — `tileUrl`
 * answers `''` for it and `PhotoTile` draws its caption on a plain ground, the same as the demo
 * edition does. So a mount outside a provider degrades to the demo's behaviour rather than
 * throwing.
 */
const EditionUrlContext = createContext('')

export function EditionUrlProvider({ url, children }: { url: string; children: ReactNode }) {
  return <EditionUrlContext.Provider value={url}>{children}</EditionUrlContext.Provider>
}

/** The news URL the edition on screen was fetched from, or `''` when there is none. */
export function useEditionUrl(): string {
  return useContext(EditionUrlContext)
}
