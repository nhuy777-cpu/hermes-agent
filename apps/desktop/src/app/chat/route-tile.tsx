/**
 * ROUTE (PAGE) TILES — a full-page view rendered as a layout-tree pane BESIDE
 * the main thread, the page analog of session tiles. Built-in pages
 * (Capabilities / Messaging / Artifacts) render their view; plugin pages render
 * their `ROUTES_AREA` contribution. Lifecycle mirrors session tiles:
 * `openRouteTile(path)` -> `watchRouteTiles` registers a pane docked beside
 * main -> tree adoption lands it on the chosen edge; closing removes it.
 */

import { useStore } from '@nanostores/react'
import { lazy, type ReactNode, Suspense } from 'react'

import { ContribBoundary, ContribRender } from '@/contrib/react/boundary'
import { useContributions } from '@/contrib/react/use-contributions'
import { $routeTiles, $skillsTileTab, closeRouteTile, type RouteTile } from '@/store/route-tiles'

import { $routesVersion, ARTIFACTS_ROUTE, contributedRoutes, MESSAGING_ROUTE, ROUTES_AREA, SKILLS_ROUTE } from '../routes'

import { paneMirror } from './pane-mirror'

const SkillsView = lazy(async () => ({ default: (await import('../skills')).SkillsView }))
const MessagingView = lazy(async () => ({ default: (await import('../messaging')).MessagingView }))
const ArtifactsView = lazy(async () => ({ default: (await import('../artifacts')).ArtifactsView }))

// Built-in page views + their pane titles, keyed by route. SKILLS_ROUTE's
// `render` here is never called — RouteTilePane special-cases it below — but
// stays in this map for `routeTitle`.
const BUILTIN_PAGES: Record<string, { render: () => ReactNode; title: string }> = {
  [ARTIFACTS_ROUTE]: { render: () => <ArtifactsView />, title: 'Artifacts' },
  [MESSAGING_ROUTE]: { render: () => <MessagingView />, title: 'Messaging' },
  [SKILLS_ROUTE]: { render: () => <SkillsView embedded />, title: 'Capabilities' }
}

/** Humanize a route path into a tab title: `/my-atlas` → `My Atlas`. */
const humanizePath = (path: string): string =>
  path
    .replace(/^\/+/, '')
    .split(/[/-]/)
    .filter(Boolean)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ') || path

/** Title for a route tile: the built-in name, the contribution's own `title`,
 *  else a humanized path — never the internal `${source}:${id}` key. */
function routeTitle(path: string): string {
  if (BUILTIN_PAGES[path]) {
    return BUILTIN_PAGES[path].title
  }

  return contributedRoutes().find(r => r.path === path)?.title ?? humanizePath(path)
}

export function RouteTilePane({ path }: { path: string }) {
  const builtin = BUILTIN_PAGES[path]

  // Subscribe so a plugin page tile appears the moment its route registers.
  // The snapshot feeds the lookup: under React Compiler an independently
  // called contributedRoutes() can stay memoized across that registration.
  const contributions = useContributions(ROUTES_AREA)
  const contrib = builtin ? null : contributedRoutes(contributions).find(r => r.path === path)
  // Read (not discard) the tab so the React Compiler's auto-memoization sees
  // it as a real input to the JSX below and recomputes on change — a bare
  // `useStore($skillsTileTab)` call with the result unused still re-renders
  // this component, but the compiler had no way to know `render`'s output
  // depended on it, so it kept serving the FIRST tab forever.
  const skillsTab = useStore($skillsTileTab)

  if (builtin) {
    // embedded: this tile shares the app's one HashRouter location with the
    // main pane — a non-embedded SkillsView reading `?tab=` off that location
    // would navigate the main pane too. `key`d on the tab: `initialMode` only
    // seeds SkillsView's own useState, so a second "+" click while the tile
    // is already open (Skills, then Connectors, without closing it) needs a
    // fresh instance to pick up the new tab.
    const render =
      path === SKILLS_ROUTE ? () => <SkillsView embedded initialMode={skillsTab} key={skillsTab} /> : builtin.render

    return (
      <ContribBoundary id={path}>
        <Suspense fallback={null}>
          <ContribRender render={render} />
        </Suspense>
      </ContribBoundary>
    )
  }

  if (contrib) {
    return (
      <ContribBoundary id={path}>
        <ContribRender render={contrib.render} />
      </ContribBoundary>
    )
  }

  return (
    <div className="grid h-full place-items-center font-mono text-[11px] text-(--ui-text-quaternary)">
      no page at {path}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Route tile -> pane contribution sync (call once from the app root).
// ---------------------------------------------------------------------------

/** Keep pane contributions mirroring `$routeTiles`. Call once from the root. */
export const watchRouteTiles = paneMirror<RouteTile>({
  source: $routeTiles,
  // A tile restored before its plugin route registers must pick up the
  // contribution's title once it lands, not keep the humanized-path fallback.
  also: [$routesVersion],
  key: t => t.path,
  prefix: 'route-tile',
  dir: t => t.dir,
  minWidth: '22rem',
  title: routeTitle,
  render: path => <RouteTilePane path={path} />,
  close: closeRouteTile
})
