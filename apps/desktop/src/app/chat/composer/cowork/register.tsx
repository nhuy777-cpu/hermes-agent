import { registry } from '@/contrib/registry'
import { $skillsTileTab, openRouteTile, type SkillsTileTab } from '@/store/route-tiles'

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
// Setting $skillsTileTab (not the URL) keeps this from also navigating the
// main pane: the route tile and the main pane share one app-wide HashRouter
// location, so a `?tab=` write on the hash used to swap the main session out
// for the Capabilities page too. See store/route-tiles.ts.
function openSkillsTab(tab: SkillsTileTab): void {
  $skillsTileTab.set(tab)
  openRouteTile(SKILLS_ROUTE)
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
