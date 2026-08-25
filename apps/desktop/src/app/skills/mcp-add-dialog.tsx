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
import { DisclosureCaret } from '@/components/ui/disclosure-caret'
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

/** `KEY=value` per line. Splits on the FIRST separator so values may contain it. */
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

export interface AddForm {
  args: string
  clientId: string
  clientSecret: string
  command: string
  env: string
  headers: string
  transport: AddTransport
  url: string
}

/** The `mcp_servers` entry for one filled-in form. Empty optional fields are
 *  omitted entirely rather than written as `[]`/`{}` — a hand-written config
 *  wouldn't carry them, and the loader treats absent and empty identically. */
export function buildServerConfig(form: AddForm): Record<string, unknown> {
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
  const clientId = form.clientId.trim()
  const clientSecret = form.clientSecret.trim()

  // Pre-registered credentials are what `auth: oauth` + the nested `oauth`
  // block mean to the loader (tools/mcp_oauth.py): supplying either one skips
  // dynamic client registration. Leaving both blank stays on the default path,
  // where the server's own 401 drives the Authenticate button instead.
  const oauth = {
    ...(clientId ? { client_id: clientId } : {}),
    ...(clientSecret ? { client_secret: clientSecret } : {})
  }

  return {
    url: form.url.trim(),
    // Streamable HTTP is the loader's default for a bare `url`; only SSE needs
    // to say so explicitly (tools/mcp_tool.py).
    ...(form.transport === 'sse' ? { transport: 'sse' } : {}),
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
    ...(Object.keys(oauth).length > 0 ? { auth: 'oauth', oauth } : {})
  }
}

const isHttpUrl = (value: string) => /^https?:\/\/\S+$/i.test(value.trim())

const EMPTY_FORM: AddForm = {
  args: '',
  clientId: '',
  clientSecret: '',
  command: '',
  env: '',
  headers: '',
  transport: 'http',
  url: ''
}

/**
 * Declare an MCP server by hand — the "+" path next to the catalog installs.
 *
 * Shaped like the connector dialogs users already know: name and remote URL up
 * front, everything else folded into Advanced settings. Hermes differs from
 * cloud-only hosts in one way that has to stay reachable — it can spawn a LOCAL
 * server — so transport lives in Advanced and swaps the URL field for
 * command/args/env rather than being dropped.
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
  const [form, setForm] = useState<AddForm>(EMPTY_FORM)
  const [advanced, setAdvanced] = useState(false)

  useEffect(() => {
    if (!open) {
      return
    }

    setName('')
    setForm(EMPTY_FORM)
    setAdvanced(false)
  }, [open])

  const set = <K extends keyof AddForm>(key: K, value: AddForm[K]) =>
    setForm(current => ({ ...current, [key]: value }))

  const trimmedName = name.trim()
  const nameValid = MCP_DEEPLINK_NAME_RE.test(trimmedName)
  const nameConflict = trimmedName !== '' && existingNames.includes(trimmedName)
  const stdio = form.transport === 'stdio'
  const urlValid = isHttpUrl(form.url)
  const targetFilled = stdio ? form.command.trim() !== '' : urlValid
  const canSubmit = nameValid && !nameConflict && targetFilled && !saving

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()

    if (!canSubmit) {
      return
    }

    await onAdd(trimmedName, buildServerConfig(form))
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
            {trimmedName !== '' && !nameValid ? (
              <FieldHint error>{m.deepLinkNameInvalid}</FieldHint>
            ) : nameValid && nameConflict ? (
              <FieldHint error>{m.deepLinkNameConflict(trimmedName)}</FieldHint>
            ) : (
              <FieldHint>{m.addNameHint}</FieldHint>
            )}
          </Field>

          {stdio ? (
            <Field htmlFor="mcp-add-command" label={m.addCommand}>
              <Input
                id="mcp-add-command"
                onChange={event => set('command', event.target.value)}
                placeholder="npx"
                value={form.command}
              />
              <FieldHint>{m.addCommandHint}</FieldHint>
            </Field>
          ) : (
            <Field htmlFor="mcp-add-url" label={m.addUrl}>
              <Input
                aria-invalid={form.url.trim() !== '' && !urlValid}
                id="mcp-add-url"
                onChange={event => set('url', event.target.value)}
                placeholder="https://mcp.example.com/mcp"
                value={form.url}
              />
              {form.url.trim() !== '' && !urlValid ? (
                <FieldHint error>{m.deepLinkErrorUrl}</FieldHint>
              ) : (
                <FieldHint>{m.addUrlHint}</FieldHint>
              )}
            </Field>
          )}

          <div className="grid gap-3">
            <button
              aria-expanded={advanced}
              className="flex w-fit items-center gap-1.5 text-xs font-medium text-foreground"
              onClick={() => setAdvanced(value => !value)}
              type="button"
            >
              <DisclosureCaret open={advanced} />
              {m.addAdvanced}
            </button>

            {advanced && (
              <div className="grid gap-4">
                <Field htmlFor="mcp-add-transport" label={m.addTransport}>
                  <Select onValueChange={value => set('transport', value as AddTransport)} value={form.transport}>
                    <SelectTrigger className="h-9 rounded-md" id="mcp-add-transport">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="http">{m.addTransportHttp}</SelectItem>
                      <SelectItem value="sse">{m.addTransportSse}</SelectItem>
                      <SelectItem value="stdio">{m.addTransportStdio}</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>

                {stdio ? (
                  <>
                    <Field htmlFor="mcp-add-args" label={m.addArgs} optional optionalLabel={m.addOptional}>
                      <Textarea
                        className="min-h-16 font-mono text-xs leading-5"
                        id="mcp-add-args"
                        onChange={event => set('args', event.target.value)}
                        placeholder={'-y\n@modelcontextprotocol/server-filesystem\n/path/to/dir'}
                        value={form.args}
                      />
                      <FieldHint>{m.addArgsHint}</FieldHint>
                    </Field>

                    <Field htmlFor="mcp-add-env" label={m.addEnv} optional optionalLabel={m.addOptional}>
                      <Textarea
                        className="min-h-14 font-mono text-xs leading-5"
                        id="mcp-add-env"
                        onChange={event => set('env', event.target.value)}
                        placeholder="API_KEY=sk-..."
                        value={form.env}
                      />
                      <FieldHint>{m.addEnvHint}</FieldHint>
                    </Field>
                  </>
                ) : (
                  <>
                    <Field htmlFor="mcp-add-client-id" label={m.addClientId} optional optionalLabel={m.addOptional}>
                      <Input
                        id="mcp-add-client-id"
                        onChange={event => set('clientId', event.target.value)}
                        value={form.clientId}
                      />
                    </Field>

                    <Field
                      htmlFor="mcp-add-client-secret"
                      label={m.addClientSecret}
                      optional
                      optionalLabel={m.addOptional}
                    >
                      <Input
                        id="mcp-add-client-secret"
                        onChange={event => set('clientSecret', event.target.value)}
                        type="password"
                        value={form.clientSecret}
                      />
                      <FieldHint>{m.addOauthHint}</FieldHint>
                    </Field>

                    <Field htmlFor="mcp-add-headers" label={m.addHeaders} optional optionalLabel={m.addOptional}>
                      <Textarea
                        className="min-h-14 font-mono text-xs leading-5"
                        id="mcp-add-headers"
                        onChange={event => set('headers', event.target.value)}
                        placeholder="Authorization: Bearer ..."
                        value={form.headers}
                      />
                      <FieldHint>{m.addHeadersHint}</FieldHint>
                    </Field>
                  </>
                )}
              </div>
            )}
          </div>

          {stdio ? (
            <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              <span>{m.deepLinkStdioWarning}</span>
            </div>
          ) : (
            <p className="text-[0.66rem] leading-4 text-muted-foreground">{m.addTrustNotice}</p>
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
