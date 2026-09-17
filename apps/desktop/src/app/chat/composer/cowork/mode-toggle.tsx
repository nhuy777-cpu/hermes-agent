import { useStore } from '@nanostores/react'

import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'

import { $composerMode, type ComposerMode, setComposerMode } from './store'

// Segmented "Chat | Cowork" control next to the "+" menu — the same affordance
// Claude's composer uses to switch a conversation into folder-scoped work.
export function ComposerModeToggle() {
  const { t } = useI18n()
  const c = t.composer.cowork
  const mode = useStore($composerMode)

  const option = (value: ComposerMode, label: string, tip: string) => (
    <Tip label={tip} side="top">
      <button
        aria-pressed={mode === value}
        className={cn(
          'h-6 rounded-md px-2 text-[0.72rem] font-medium transition-colors',
          mode === value
            ? 'bg-(--ui-control-background) text-foreground shadow-[inset_0_0_0_1px_var(--ui-stroke-tertiary)]'
            : 'text-(--ui-text-tertiary) hover:text-foreground'
        )}
        onClick={() => setComposerMode(value)}
        type="button"
      >
        {label}
      </button>
    </Tip>
  )

  return (
    <div
      aria-label={c.modeLabel}
      className="flex items-center gap-0.5 rounded-lg bg-(--ui-bg-tertiary) p-0.5"
      role="group"
    >
      {option('chat', c.chat, c.chatTip)}
      {option('cowork', c.cowork, c.coworkTip)}
    </div>
  )
}
