import { useStore } from '@nanostores/react'
import { useCallback, useEffect, useState } from 'react'

import { hermesApi } from '@/api/client'
import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'
import { $busy, $sessionStartedAt } from '@/store/session'

import { SidebarPanelLabel } from '../../shell/sidebar-label'
import { RightSidebarSectionHeader } from '../index'

interface SessionResultFile {
  name: string
  rel_path: string
  size: number
  modified_at: number
}

interface SessionResultsPayload {
  root: string
  since: number
  truncated: boolean
  files: SessionResultFile[]
}

// Files under the session's cwd written since the session started — Cowork's
// "deliverables" for any folder. mtime-based on purpose: the Review pane reads
// `git status`, which leaves a documents folder (no repo) showing nothing at
// all, and the agent's output is almost always the most recently written file.
// Refetches when a turn ends, so the list catches up as the agent works.
export function SessionResults({
  cwd,
  onActivateFile
}: {
  cwd: string
  onActivateFile: (path: string) => void
}) {
  const { t } = useI18n()
  const r = t.rightSidebar
  const startedAt = useStore($sessionStartedAt)
  const busy = useStore($busy)
  const [open, setOpen] = useState(true)
  const [payload, setPayload] = useState<SessionResultsPayload | null>(null)
  const [loading, setLoading] = useState(false)

  const since = startedAt ? Math.floor(startedAt / 1000) : 0

  const refresh = useCallback(async () => {
    if (!cwd) {
      setPayload(null)
      return
    }

    setLoading(true)

    try {
      const query = `path=${encodeURIComponent(cwd)}&since=${since}&limit=50`
      setPayload(await hermesApi<SessionResultsPayload>({ path: `/api/workspaces/deliverables?${query}` }))
    } catch {
      // A vanished folder or an old backend without the route: show nothing
      // rather than an error banner in a secondary section.
      setPayload(null)
    } finally {
      setLoading(false)
    }
  }, [cwd, since])

  // Mount / cwd / session change, and every time the agent goes idle.
  useEffect(() => {
    if (!busy) {
      void refresh()
    }
  }, [busy, refresh])

  if (!cwd || !startedAt) {
    return null
  }

  const files = payload?.files ?? []
  const joiner = cwd.includes('\\') && !cwd.includes('/') ? '\\' : '/'
  const absolute = (rel: string) => `${cwd.replace(/[\\/]+$/, '')}${joiner}${rel}`

  return (
    <div className="flex max-h-[40%] shrink-0 flex-col border-b border-(--ui-stroke-secondary)">
      <RightSidebarSectionHeader>
        <button
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-1 text-left"
          onClick={() => setOpen(v => !v)}
          type="button"
        >
          <Codicon name={open ? 'chevron-down' : 'chevron-right'} size="0.75rem" />
          <SidebarPanelLabel>
            {r.sessionResults}
            {files.length > 0 ? ` (${files.length}${payload?.truncated ? '+' : ''})` : ''}
          </SidebarPanelLabel>
        </button>
        <Tip label={r.refreshSessionResults}>
          <Button
            aria-label={r.refreshSessionResults}
            disabled={loading}
            onClick={() => void refresh()}
            size="icon-xs"
            variant="ghost"
          >
            <Codicon name="refresh" size="0.8125rem" spinning={loading} />
          </Button>
        </Tip>
      </RightSidebarSectionHeader>
      {open && (
        <div className="min-h-0 overflow-y-auto px-1 pb-1">
          {files.length === 0 ? (
            <div className="px-2 py-1.5 text-xs text-(--ui-text-quaternary)">{r.sessionResultsEmpty}</div>
          ) : (
            files.map(file => (
              <button
                className={cn(
                  'flex w-full items-center gap-1.5 rounded-sm px-2 py-0.5 text-left text-xs',
                  'hover:bg-(--ui-control-hover-background) hover:text-foreground'
                )}
                key={file.rel_path}
                onClick={() => onActivateFile(absolute(file.rel_path))}
                title={file.rel_path}
                type="button"
              >
                <Codicon name="file" size="0.75rem" />
                <span className="min-w-0 flex-1 truncate">{file.rel_path}</span>
                <span className="shrink-0 text-(--ui-text-quaternary)">{formatWhen(file.modified_at)}</span>
              </button>
            ))
          )}
          {payload?.truncated && (
            <div className="px-2 py-1 text-xs text-(--ui-text-quaternary)">{r.sessionResultsTruncated}</div>
          )}
        </div>
      )}
    </div>
  )
}

function formatWhen(epochSeconds: number): string {
  const minutes = Math.floor((Date.now() - epochSeconds * 1000) / 60000)

  if (minutes < 1) {
    return 'now'
  }

  if (minutes < 60) {
    return `${minutes}m`
  }

  const hours = Math.floor(minutes / 60)

  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`
}
