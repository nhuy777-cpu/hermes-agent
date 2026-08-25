import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Field, FieldHint } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { useI18n } from '@/i18n'
import { AlertTriangle } from '@/lib/icons'
import { MCP_DEEPLINK_NAME_RE } from '@/lib/mcp-deeplink'

export type AddTransport = 'http' | 'sse' | 'stdio'

/** Non-empty, trimmed lines. Blank lines and padding are user formatting, not data. */
export function parseLines(text: string): string[] {
  return text
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '')
}

/** `KEY=value` per line. Splits on the FIRST `=` so values may contain `=`. */
export function parsePairs(text: string, separator: string): Record<string, string> {
  const out: Record<string, string> = {}

  for (const line of parseLines(text)) {
    const at = line.indexOf(separator)

    if (at <= 0) {
      continue
    }

    out[line.slice(0, at).trim()] = line.slice(at + separator.length).trim()
  }

  return out
}

/** The mcp.json entry for one filled-in form. Empty optional fields are omitted
 *  entirely rather than written as `[]`/`{}` — a hand-written config wouldn't
 *  carry them, and the loader treats absent and empty identically. */
export function buildServerConfig(form: {
  args: string
  command: string
  env: string
  headers: string
  transport: AddTransport
  url: string
}): Record<string, unknown> {
  if (form.transport === 'stdio') {
    const args = parseLines(form.args)
    const env = parsePairs(form.env, '=')

    return {
      command: form.command.trim(),
      ...(args.length > 0 ? { args } : {}),
      ...(Object.keys(env).length > 0 ? { env } : {})
    }
  }

  const headers = parsePairs(form.headers, ':')

  return {
    url: form.url.trim(),
    // Streamable HTTP is the loader's default for a bare `url`; only SSE needs
    // to say so explicitly (tools/mcp_tool.py).
    ...(form.transport === 'sse' ? { transport: 'sse' } : {}),
    ...(Object.keys(headers).length > 0 ? { headers } : {})
  }
}

const isHttpUrl = (value: string) => /^https?:\/\/\S+$/i.test(value.trim())

/**
 * Declare an MCP server by hand — the "Add" path next to the catalog installs.
 * Mirrors the fields every MCP host exposes (name, transport, command/args/env
 * or url/headers) so a server documented for Claude/Cursor can be entered here
 * without translating it into JSON first.
 *
 * Save is the caller's job (`onAdd`): this dialog only validates and shapes the
 * entry, so the tab keeps its single whole-map persist path.
 */
export function McpAddDialog({
  existingNames,
  onAdd,
  onClose,
  open,
  saving
}: {
  existingNames: string[]
  onAdd: (name: string, config: Record<string, unknown>) => Promise<void> | void
  onClose: () => void
  open: boolean
  saving: boolean
}) {
  const { t } = useI18n()
  const m = t.settings.mcp

  const [name, setName] = useState('')
  const [transport, setTransport] = useState<AddTransport>('stdio')
  const [command, setCommand] = useState('')
  const [args, setArgs] = useState('')
  const [env, setEnv] = useState('')
  const [url, setUrl] = useState('')
  const [headers, setHeaders] = useState('')

  useEffect(() => {
    if (!open) {
      return
    }

    setName('')
    setTransport('stdio')
    setCommand('')
    setArgs('')
    setEnv('')
    setUrl('')
    setHeaders('')
  }, [open])

  const trimmedName = name.trim()
  const nameValid = MCP_DEEPLINK_NAME_RE.test(trimmedName)
  const nameConflict = trimmedName !== '' && existingNames.includes(trimmedName)
  const stdio = transport === 'stdio'
  const targetFilled = stdio ? command.trim() !== '' : isHttpUrl(url)
  const canSubmit = nameValid && !nameConflict && targetFilled && !saving

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()

    if (!canSubmit) {
      return
    }

    await onAdd(trimmedName, buildServerConfig({ args, command, env, headers, transport, url }))
  }

  return (
    <Dialog onOpenChange={value => !value && !saving && onClose()} open={open}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{m.addTitle}</DialogTitle>
          <DialogDescription>{m.addDesc}</DialogDescription>
        </DialogHeader>

        <form className="grid gap-4" onSubmit={event => void submit(event)}>
          <Field htmlFor="mcp-add-name" label={m.name}>
            <Input
              aria-invalid={trimmedName !== '' && !nameValid}
              autoFocus
              id="mcp-add-name"
              onChange={event => setName(event.target.value)}
              placeholder="my-server"
              value={name}
            />
            {trimmedName !== '' && !nameValid && <FieldHint error>{m.deepLinkNameInvalid}</FieldHint>}
            {nameValid && nameConflict && <FieldHint error>{m.deepLinkNameConflict(trimmedName)}</FieldHint>}
          </Field>

          <Field htmlFor="mcp-add-transport" label={m.addTransport}>
            <Select onValueChange={value => setTransport(value as AddTransport)} value={transport}>
              <SelectTrigger className="h-9 rounded-md" id="mcp-add-transport">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="stdio">{m.addTransportStdio}</SelectItem>
                <SelectItem value="http">{m.addTransportHttp}</SelectItem>
                <SelectItem value="sse">{m.addTransportSse}</SelectItem>
              </SelectContent>
            </Select>
          </Field>

          {stdio ? (
            <>
              <Field htmlFor="mcp-add-command" label={m.addCommand}>
                <Input
                  id="mcp-add-command"
                  onChange={event => setCommand(event.target.value)}
                  placeholder="npx"
                  value={command}
                />
              </Field>

              <Field htmlFor="mcp-add-args" label={m.addArgs} optional optionalLabel={m.addOptional}>
                <Textarea
                  className="min-h-16 font-mono text-xs leading-5"
                  id="mcp-add-args"
                  onChange={event => setArgs(event.target.value)}
                  placeholder={'-y\n@modelcontextprotocol/server-filesystem\n/path/to/dir'}
                  value={args}
                />
                <FieldHint>{m.addArgsHint}</FieldHint>
              </Field>

              <Field htmlFor="mcp-add-env" label={m.addEnv} optional optionalLabel={m.addOptional}>
                <Textarea
                  className="min-h-14 font-mono text-xs leading-5"
                  id="mcp-add-env"
                  onChange={event => setEnv(event.target.value)}
                  placeholder="API_KEY=sk-..."
                  value={env}
                />
                <FieldHint>{m.addEnvHint}</FieldHint>
              </Field>

              <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                <span>{m.deepLinkStdioWarning}</span>
              </div>
            </>
          ) : (
            <>
              <Field htmlFor="mcp-add-url" label={m.addUrl}>
                <Input
                  aria-invalid={url.trim() !== '' && !isHttpUrl(url)}
                  id="mcp-add-url"
                  onChange={event => setUrl(event.target.value)}
                  placeholder="https://example.com/mcp"
                  value={url}
                />
                {url.trim() !== '' && !isHttpUrl(url) && <FieldHint error>{m.deepLinkErrorUrl}</FieldHint>}
              </Field>

              <Field htmlFor="mcp-add-headers" label={m.addHeaders} optional optionalLabel={m.addOptional}>
                <Textarea
                  className="min-h-14 font-mono text-xs leading-5"
                  id="mcp-add-headers"
                  onChange={event => setHeaders(event.target.value)}
                  placeholder="Authorization: Bearer ..."
                  value={headers}
                />
                <FieldHint>{m.addHeadersHint}</FieldHint>
              </Field>
            </>
          )}

          <DialogFooter>
            <Button disabled={saving} onClick={onClose} type="button" variant="ghost">
              {t.common.cancel}
            </Button>
            <Button disabled={!canSubmit} type="submit">
              {saving ? t.common.saving : m.addConfirm}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
