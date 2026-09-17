import { atom } from 'nanostores'

import { readJson, writeJson } from '@/lib/storage'

import type { SplitDir } from './session-states'

/**
 * Route (page) tiles — a full-page view (Capabilities / Messaging / Artifacts,
 * or any plugin route) rendered as a layout-tree pane BESIDE the main thread,
 * the page analog of session tiles. Persisted by path so they re-open on boot.
 */
export interface RouteTile {
  /** The route path this tile renders, e.g. `/skills`. */
  path: string
  /** Edge to dock against main on adoption (default right). */
  dir?: SplitDir
}

const TILES_KEY = 'hermes.desktop.routeTiles.v1'

function loadTiles(): RouteTile[] {
  const parsed = readJson<unknown>(TILES_KEY)

  return Array.isArray(parsed)
    ? parsed
        .filter((t): t is RouteTile => Boolean(t && typeof (t as RouteTile).path === 'string'))
        .map(t => ({ dir: t.dir, path: t.path }))
    : []
}

export const $routeTiles = atom<RouteTile[]>(loadTiles())

function saveTiles(tiles: RouteTile[]) {
  $routeTiles.set(tiles)
  writeJson(TILES_KEY, tiles.length === 0 ? null : tiles)
}

/** Open (or front) a page tile for a route, docked on `dir` (default right).
 *  Idempotent — an already-open tile keeps its original edge. */
export function openRouteTile(path: string, dir: SplitDir = 'right') {
  const tiles = $routeTiles.get()

  if (!tiles.some(t => t.path === path)) {
    saveTiles([...tiles, { dir, path }])
  }
}

export function closeRouteTile(path: string) {
  saveTiles($routeTiles.get().filter(t => t.path !== path))
}

/** Tab to show inside the Capabilities route tile. Deliberately NOT a `?tab=`
 *  URL param: the tile and the main thread share one app-wide HashRouter
 *  location (one <HashRouter> for the whole window), so writing the tab into
 *  the hash navigates the main pane too and replaces whatever session was
 *  open there. This store lets `openSkillsTab` (composer "+" menu) pick a
 *  tab for the DOCKED tile only — SkillsView reads it via its `embedded`
 *  mode, the same mechanism plugin dialogs already use to keep tab state out
 *  of the URL (see SkillsViewProps.embedded in app/skills/index.tsx). */
export type SkillsTileTab = 'skills' | 'toolsets' | 'mcp' | 'plugins'
export const $skillsTileTab = atom<SkillsTileTab>('skills')
