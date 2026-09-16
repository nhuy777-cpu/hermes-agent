import { useStore } from '@nanostores/react'
import { useEffect, useState } from 'react'

import { requestComposerInsert } from '@/app/chat/composer/focus'
import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { useI18n } from '@/i18n'
import { ensureActiveGatewayOpen } from '@/store/gateway'
import { notify, notifyError } from '@/store/notifications'

import { $skillRecording, $skillRecordStopOpen, type SkillRecording } from './store'

interface RecordStatus {
  recording: boolean
  id?: string
  directory?: string
  elapsed?: number
  clicks?: number
  shots?: number
  truncated?: boolean
  duration?: number
}

// The attach-menu row runs outside React, so it reaches the gateway the same
// way the projects store does: whichever socket is active, reconnecting once.
async function gatewayCall<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  const gateway = await ensureActiveGatewayOpen()

  if (!gateway) {
    throw new Error('Hermes gateway is not connected')
  }

  return gateway.request<T>(method, params)
}

function toRecording(status: RecordStatus, previous: SkillRecording | null): SkillRecording | null {
  if (!status.recording || !status.id || !status.directory) {
    return null
  }

  return {
    clicks: status.clicks ?? 0,
    directory: status.directory,
    id: status.id,
    shots: status.shots ?? 0,
    startedAt: previous?.startedAt ?? Date.now() - (status.elapsed ?? 0) * 1000,
    truncated: Boolean(status.truncated)
  }
}

export async function startSkillRecording(): Promise<void> {
  try {
    const status = await gatewayCall<RecordStatus>('skill_record.start')
    $skillRecording.set(toRecording(status, null))
  } catch (error) {
    notifyError(error, 'Could not start recording')
  }
}

// Vietnamese on purpose: the user's Hermes profile answers in Vietnamese and
// the skill text should read like the rest of their skills.
function skillPrompt(name: string, directory: string): string {
  const title = name.trim() || 'skill-moi'

  return [
    `Tạo skill từ bản ghi thao tác của tôi tại thư mục: ${directory}`,
    `1. Đọc ${directory}\\README.md và ${directory}\\events.jsonl (mỗi dòng: thời điểm, click hoặc đổi cửa sổ, app, tên ảnh chụp).`,
    '2. Xem các ảnh chụp trong thư mục đó bằng vision_analyze để hiểu tôi đã bấm vào đâu và làm gì ở từng bước.',
    `3. Dùng skill_manage tạo skill tên "${title}" gồm: mục đích, điều kiện bắt đầu, các bước (app, cửa sổ, thao tác, kết quả mong đợi), cách kiểm tra đã xong. Viết để sau này tự thực hiện lại bằng computer_use/browser, hoặc hướng dẫn tôi từng bước.`,
    '4. Phím gõ KHÔNG được ghi lại — không suy đoán nội dung đã gõ; hỏi lại tôi nếu bước nào chưa rõ.'
  ].join('\n')
}

// Recording strip under the composer while a capture runs: elapsed, clicks,
// Stop (→ name dialog → prompt in the composer) and Discard.
export function RecordSkillBar() {
  const { t } = useI18n()
  const c = t.composer.cowork
  const recording = useStore($skillRecording)
  const [now, setNow] = useState(Date.now())

  // Keyed on the recording id, not the object: status polls replace the
  // object every 2s and re-arming both timers on each poll would drift the clock.
  const recordingId = recording?.id

  useEffect(() => {
    if (!recordingId) {
      return
    }

    const tick = window.setInterval(() => setNow(Date.now()), 1000)

    const poll = window.setInterval(() => {
      void gatewayCall<RecordStatus>('skill_record.status')
        .then(status => $skillRecording.set(toRecording(status, $skillRecording.get())))
        .catch(() => undefined)
    }, 2000)

    return () => {
      window.clearInterval(tick)
      window.clearInterval(poll)
    }
  }, [recordingId])

  if (!recording) {
    return null
  }

  const seconds = Math.max(0, Math.floor((now - recording.startedAt) / 1000))
  const clock = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`

  const discard = async () => {
    try {
      await gatewayCall('skill_record.stop', { discard: true })
    } catch {
      // The bar clears either way; a stale backend recording is harmless.
    }

    $skillRecording.set(null)
  }

  return (
    <div className="flex items-center gap-2 rounded-md border border-(--ui-stroke-tertiary) bg-(--ui-bg-tertiary) px-2 py-1 text-xs">
      <span className="size-2 animate-pulse rounded-full bg-red-500" />
      <span className="font-medium text-foreground">{c.recording}</span>
      <span className="tabular-nums text-(--ui-text-tertiary)">{clock}</span>
      <span className="text-(--ui-text-tertiary)">{c.clicks(recording.clicks)}</span>
      {recording.truncated && <span className="text-(--ui-text-warning,orange)">{c.truncated}</span>}
      <span className="flex-1" />
      <Button onClick={() => $skillRecordStopOpen.set(true)} size="sm" type="button">
        <Codicon name="debug-stop" size="0.75rem" />
        {c.stopAndCreate}
      </Button>
      <Button onClick={() => void discard()} size="sm" type="button" variant="ghost">
        {c.discard}
      </Button>
      <StopDialog recording={recording} />
    </div>
  )
}

function StopDialog({ recording }: { recording: SkillRecording }) {
  const { t } = useI18n()
  const c = t.composer.cowork
  const open = useStore($skillRecordStopOpen)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)

  const finish = async () => {
    setBusy(true)

    try {
      const result = await gatewayCall<RecordStatus>('skill_record.stop', { name })
      $skillRecording.set(null)
      $skillRecordStopOpen.set(false)
      requestComposerInsert(skillPrompt(name, result.directory ?? recording.directory), { target: 'main' })
      notify({
        kind: 'success',
        message: c.saved(result.clicks ?? recording.clicks, result.shots ?? recording.shots)
      })
    } catch (error) {
      notifyError(error, c.stopFailed)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog onOpenChange={value => $skillRecordStopOpen.set(value)} open={open}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{c.stopTitle}</DialogTitle>
          <DialogDescription>{c.stopDescription}</DialogDescription>
        </DialogHeader>
        <Input
          autoFocus
          onChange={event => setName(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter' && !busy) {
              void finish()
            }
          }}
          placeholder={c.namePlaceholder}
          value={name}
        />
        <DialogFooter>
          <Button disabled={busy} onClick={() => $skillRecordStopOpen.set(false)} type="button" variant="ghost">
            {t.common.cancel}
          </Button>
          <Button disabled={busy} onClick={() => void finish()} type="button">
            {c.createSkill}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
