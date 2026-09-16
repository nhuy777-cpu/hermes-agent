import { registry } from '@/contrib/registry'
import { openRouteTile } from '@/store/route-tiles'

import { SKILLS_ROUTE } from '../../../routes'
import { COMPOSER_AREAS, type ComposerAttachmentProvider } from '../contrib'

import { CoworkChips } from './chips'
import { ComposerModeToggle } from './mode-toggle'
import { RecordSkillBar, startSkillRecording } from './record-skill'

// Claude-style composer additions, all through the composer's own seams:
//   leading   → Chat | Cowork toggle beside the "+" menu
//   underside → "Project or folder ▾ · Auto ▾" chips (Cowork mode only)
//   bottom    → the recording strip while "Record a skill" runs
//   "+" menu  → Record a skill, then Skills / Connectors / Plugins rows
// RouteTile matches BUILTIN_PAGES by exact path (route-tile.tsx) — a query
// string makes the lookup miss ("no page at /skills?tab=mcp"). The tab itself
// reads from the single app-wide HashRouter location (one <HashRouter> for
// the whole window, per main.tsx), so the tile's own `path` cannot carry it;
// setting the hash directly is the established way to do this elsewhere
// (store/mcp-health.ts does the same for a live MCP link). The route tile
// keeps Capabilities docked beside the session instead of navigating away
// from it — only the hash write picks the tab.
function openSkillsTab(tab: 'skills' | 'mcp' | 'plugins'): void {
  openRouteTile(SKILLS_ROUTE)
  window.location.hash = `#${SKILLS_ROUTE}?tab=${tab}`
}

export function registerCoworkComposer(): () => void {
  const attachment = (id: string, label: string, icon: string, run: () => void, order: number) => ({
    id,
    area: COMPOSER_AREAS.attachments,
    order,
    data: { label, icon, run } satisfies ComposerAttachmentProvider
  })

  return registry.registerMany([
    { id: 'cowork-mode', area: COMPOSER_AREAS.leading, order: 10, render: () => <ComposerModeToggle /> },
    { id: 'cowork-chips', area: COMPOSER_AREAS.underside, order: 10, render: () => <CoworkChips /> },
    { id: 'skill-recording', area: COMPOSER_AREAS.bottom, order: 10, render: () => <RecordSkillBar /> },
    attachment('record-skill', 'Record a skill', 'record', () => void startSkillRecording(), 10),
    attachment('open-skills', 'Skills', 'library', () => openSkillsTab('skills'), 20),
    attachment('open-connectors', 'Connectors', 'plug', () => openSkillsTab('mcp'), 21),
    attachment('open-plugins', 'Plugins', 'extensions', () => openSkillsTab('plugins'), 22)
  ])
}
