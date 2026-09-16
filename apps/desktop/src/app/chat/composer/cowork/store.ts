import { atom } from 'nanostores'

// Chat = a plain session; Cowork = the Claude-style folder-scoped session
// (project chip + approval chip under the composer). A workstation choice,
// remembered per machine — a reopened app should land in the same mode.
export type ComposerMode = 'chat' | 'cowork'

const MODE_KEY = 'hermes:composer-mode'

function readMode(): ComposerMode {
  try {
    return window.localStorage.getItem(MODE_KEY) === 'cowork' ? 'cowork' : 'chat'
  } catch {
    return 'chat'
  }
}

export const $composerMode = atom<ComposerMode>(readMode())

export function setComposerMode(mode: ComposerMode): void {
  $composerMode.set(mode)

  try {
    window.localStorage.setItem(MODE_KEY, mode)
  } catch {
    // Non-fatal: the choice still holds for this window.
  }
}

// The running "Record a skill" capture, mirrored from skill_record.status so
// the composer bar can show elapsed time and click count without owning it.
export interface SkillRecording {
  id: string
  directory: string
  startedAt: number
  clicks: number
  shots: number
  truncated: boolean
}

export const $skillRecording = atom<SkillRecording | null>(null)
export const $skillRecordStopOpen = atom(false)
