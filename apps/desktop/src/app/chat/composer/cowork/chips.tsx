import { useStore } from '@nanostores/react'
import { useMemo } from 'react'

import { useGatewayRequest } from '@/app/gateway/hooks/use-gateway-request'
import { useApprovalModeStatusbarItem } from '@/app/shell/approval-mode-menu'
import { Codicon } from '@/components/ui/codicon'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'
import { notifyError } from '@/store/notifications'
import { $activeGatewayProfile } from '@/store/profile'
import {
  $projectTree,
  pickProjectFolder,
  projectForCwdIsStrict,
  projectNameForCwd,
  projectRootCwd,
  requestStartWorkSession
} from '@/store/projects'
import { $currentCwd } from '@/store/session'

import { $composerMode } from './store'

const CHIP =
  'flex h-6 items-center gap-1 rounded-md px-1.5 text-[0.72rem] text-(--ui-text-tertiary) transition-colors hover:bg-(--ui-control-hover-background) hover:text-foreground data-[state=open]:bg-(--ui-control-hover-background) data-[state=open]:text-foreground'

// The row under the composer in Cowork mode: "Project or folder ▾ · Auto ▾".
// Picking a project starts a session rooted there (the same request the
// worktree dialog and branch row use); the approval chip is the statusbar's
// approval-mode menu, re-hosted so the mode sits where Claude puts it.
export function CoworkChips() {
  const mode = useStore($composerMode)

  if (mode !== 'cowork') {
    return null
  }

  return (
    <div className="flex flex-wrap items-center gap-1 px-1">
      <ProjectChip />
      <ApprovalChip />
    </div>
  )
}

function ProjectChip() {
  const { t } = useI18n()
  const c = t.composer.cowork
  const tree = useStore($projectTree)
  const cwd = useStore($currentCwd).trim()

  const projects = useMemo(
    () => tree.filter(node => !node.isAuto && !node.isNoProject && projectRootCwd(node)),
    [tree]
  )

  const current = projectNameForCwd(cwd)
  const strict = projectForCwdIsStrict(cwd)

  const browse = async () => {
    try {
      const dir = await pickProjectFolder()

      if (dir) {
        requestStartWorkSession(dir)
      }
    } catch (error) {
      notifyError(error, c.browseFailed)
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button className={cn(CHIP, current && 'text-foreground')} type="button">
          <Codicon name={strict ? 'lock' : 'folder'} size="0.75rem" />
          <span className="max-w-[14rem] truncate">{current ?? c.projectOrFolder}</span>
          <Codicon name="chevron-down" size="0.65rem" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64" side="bottom" sideOffset={4}>
        <DropdownMenuLabel>{c.projectsLabel}</DropdownMenuLabel>
        {projects.length === 0 ? (
          <div className="px-2 py-1 text-xs text-(--ui-text-quaternary)">{c.noProjects}</div>
        ) : (
          projects.map(project => (
            <DropdownMenuItem key={project.id} onSelect={() => requestStartWorkSession(projectRootCwd(project))}>
              <Codicon name={project.strict ? 'lock' : 'folder'} size="0.8rem" />
              <span className="min-w-0 flex-1 truncate">{project.label}</span>
            </DropdownMenuItem>
          ))
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void browse()}>
          <Codicon name="folder-opened" size="0.8rem" />
          <span>{c.browseFolder}</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function ApprovalChip() {
  const { requestGateway } = useGatewayRequest()
  const profile = useStore($activeGatewayProfile)
  const item = useApprovalModeStatusbarItem(profile, requestGateway)

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button className={CHIP} title={item.title} type="button">
          {item.icon}
          <span>{item.label}</span>
          <Codicon name="chevron-down" size="0.65rem" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className={item.menuClassName} side="bottom" sideOffset={4}>
        {typeof item.menuContent === 'function' ? item.menuContent(() => undefined) : item.menuContent}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
