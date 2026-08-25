import { useStore } from '@nanostores/react'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState } from 'react'

import { LogTail } from '@/components/chat/log-tail'
import { PageLoader } from '@/components/page-loader'
import { AvatarChip } from '@/components/ui/avatar-chip'
import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { ErrorBanner } from '@/components/ui/error-state'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Switch } from '@/components/ui/switch'
import { TextTab } from '@/components/ui/text-tab'
import { Textarea } from '@/components/ui/textarea'
import { Tip } from '@/components/ui/tooltip'
import {
  getActionStatus,
  getLogs,
  getMcpCatalog,
  getUsageAnalytics,
  type HermesGateway,
  installMcpCatalogEntry,
  type McpCatalogEntry,
  type McpTestResult,
  type ProfileScope,
  profileScopeKey,
  saveMcpServers,
  testMcpServer
} from '@/hermes'
import { type Translations, useI18n } from '@/i18n'
import { startCompletionPoll } from '@/lib/completion-poll'
import { compactNumber } from '@/lib/format'
import { brandFor } from '@/lib/mcp-brands'
import { estimateServerTokens, serverUsageCount } from '@/lib/mcp-cost'
import { completeMcpDesktopOAuth } from '@/lib/mcp-dashboard-oauth'
import { type McpImportEntry, parseMcpImport } from '@/lib/mcp-import'
import { NEEDS_AUTH_RE, PROBE_TTL_MS, probeCache, probeKey } from '@/lib/mcp-probe-cache'
import { getServers, type McpServers } from '@/lib/mcp-servers'
import { countEnabledTools, isToolEnabled, toggleToolInServer } from '@/lib/mcp-tool-filter'
import { cn } from '@/lib/utils'
import { notify, notifyError } from '@/store/notifications'
import { $activeGatewayProfile, normalizeProfileKey } from '@/store/profile'
import { $activeSessionId } from '@/store/session'

import { hermesConfigCacheWriter, useHermesConfigRecord } from '../hooks/use-config-record'
import { useOnProfileSwitch } from '../hooks/use-on-profile-switch'
import { ICON_BUTTON, MASTER_DETAIL_WIDE_COLS } from '../master-detail'
import { PanelAddButton, PanelEmpty } from '../overlays/panel'
import { prettyName } from '../settings/helpers'
import { useDeepLinkHighlight } from '../settings/use-deep-link-highlight'

import { McpAddDialog } from './mcp-add-dialog'

// Names are the config keys, transport is inferred from `command` vs `url` —
// the same shape every MCP host's mcp.json uses, so a server documented
// elsewhere maps field-for-field onto the Add form and the paste importer.
// Storage stays the config.yaml `mcp_servers` map (CLI/TUI untouched).

// The runtime gate is `enabled: false` — the same flag `hermes mcp` and the
// agent's MCP loader read.
const serverEnabled = (server: Record<string, unknown>) => server.enabled !== false

// Shared cache for the Nous-approved catalog — feeds both description enrichment
// and the Catalog install view; invalidated after an install.
const MCP_CATALOG_KEY = ['mcp-catalog'] as const

type Probe = McpTestResult | 'probing'

// Per-server cost/usage overlay inputs: `tokens` is the approximate per-call
// schema cost from the probe (null = no estimate — older backend or no probe
// yet), `uses` is the 30-day analytics call count (null = analytics
// unavailable, so usage is simply omitted).
interface ServerCost {
  tokens: null | number
  uses: null | number
}

// 30-day per-tool call counts for the MCP fleet — same shape and TTL rules as
// the Toolsets tab's toolCallsCache (skills/index.tsx), but a 30-day window
// keyed by the Capabilities scope profile. Purely cosmetic: a failed analytics
// fetch caches nothing and the overlay omits usage.
const MCP_USAGE_TTL_MS = 10 * 60_000
const mcpUsageCache = new Map<string, { at: number; value: Record<string, number> }>()

async function loadMcpUsage(scopeKey: string, scopeProfile: ProfileScope): Promise<null | Record<string, number>> {
  const cached = mcpUsageCache.get(scopeKey)

  if (cached && Date.now() - cached.at < MCP_USAGE_TTL_MS) {
    return cached.value
  }

  try {
    const analytics = await getUsageAnalytics(30, scopeProfile)
    const value = Object.fromEntries((analytics.tools ?? []).map(entry => [entry.tool, entry.count]))
    mcpUsageCache.set(scopeKey, { at: Date.now(), value })

    return value
  } catch {
    // Analytics unavailable — degrade to "no usage shown", never an error UI.
    return null
  }
}

type ServerStatus = 'off' | 'probing' | 'ok' | 'needs-auth' | 'error' | 'unknown'

function statusOf(server: Record<string, unknown>, probe: Probe | undefined): ServerStatus {
  if (!serverEnabled(server)) {
    return 'off'
  }

  if (probe === 'probing') {
    return 'probing'
  }

  if (!probe) {
    return 'unknown'
  }

  if (probe.ok) {
    return 'ok'
  }

  return NEEDS_AUTH_RE.test(probe.error ?? '') ? 'needs-auth' : 'error'
}

const STATUS_DOT: Record<ServerStatus, string> = {
  ok: 'bg-emerald-500',
  error: 'bg-red-500',
  'needs-auth': 'bg-amber-500',
  probing: 'animate-pulse bg-foreground/40',
  off: 'bg-foreground/20',
  unknown: 'bg-foreground/20'
}

// "12 tools enabled" / "25 tools, 1 prompts, 103 resources enabled" — only
// the capabilities the server actually has. When a `server` config is passed,
// the tool count reflects the per-tool include/exclude filter (what's actually
// registered), not the raw discovered count. The optional `cost` appends the
// overlay — "…, ~4.2k tok, 3 uses/30d" — with each half omitted when unknown.
function capabilitySummary(
  m: Translations['settings']['mcp'],
  probe: McpTestResult,
  server?: Record<string, unknown>,
  cost?: ServerCost
): string {
  const toolCount = server
    ? countEnabledTools(
        server,
        probe.tools.map(tool => tool.name)
      )
    : probe.tools.length

  const parts = [m.capabilitySummary(toolCount, probe.prompts ?? 0, probe.resources ?? 0)]

  if (cost && cost.tokens !== null && cost.tokens > 0) {
    parts.push(m.costTokens(compactNumber(cost.tokens)))
  }

  if (cost && cost.uses !== null) {
    parts.push(m.usage30d(compactNumber(cost.uses)))
  }

  return parts.join(', ')
}

function statusLine(
  m: Translations['settings']['mcp'],
  status: ServerStatus,
  probe: Probe | undefined,
  server?: Record<string, unknown>,
  cost?: ServerCost
): string {
  switch (status) {
    case 'ok':
      return capabilitySummary(m, probe as McpTestResult, server, cost)

    case 'probing':
      return m.statusConnecting

    case 'needs-auth':
      return m.statusNeedsAuth

    case 'error':
      return m.statusError

    case 'off':
      return m.statusOff

    default:
      return ''
  }
}

export function McpTab({ gateway, profile }: { gateway: HermesGateway | null; profile?: ProfileScope }) {
  const { t } = useI18n()
  const m = t.settings.mcp
  const activeSessionId = useStore($activeSessionId)

  // The profile this tab configures: the Capabilities profile-scope selector's
  // choice (`profile`) when set, otherwise the app-wide active profile. Every
  // fetch/save below is scoped to it, and it keys the config/catalog/probe
  // caches so switching the selector refetches and never shows another
  // profile's servers (AGENTS.md scope-in-key). When no override is passed this
  // resolves to $activeGatewayProfile, so behavior is identical to before.
  const appProfile = useStore($activeGatewayProfile)
  const scopeProfileKey = profile != null ? profileScopeKey(profile) : normalizeProfileKey(appProfile)

  // Shared config cache (see use-config-record): revisiting the tab paints the
  // cached record instantly; mutations write through `setConfig` and stay
  // visible to the other settings surfaces.
  const {
    data: config,
    isLoading: configLoading,
    isError: configFailed,
    error: configError,
    refetch: refetchConfig,
    dataUpdatedAt: configUpdatedAt,
    errorUpdatedAt: configErroredAt
  } = useHermesConfigRecord(profile)

  const setConfig = hermesConfigCacheWriter(profile)

  // True from a profile switch until the config query resettles for the new
  // profile. Until then `config` (and thus `servers`) still holds profile A's
  // data, so any persist would write A's server list into B — block mutations.
  const [profilePending, setProfilePending] = useState(false)
  const staleConfigStamp = useRef<null | number>(null)
  const staleErrorStamp = useRef<null | number>(null)

  const [saving, setSaving] = useState(false)
  const [probes, setProbes] = useState<Record<string, Probe>>({})
  const probesRef = useRef(probes)
  probesRef.current = probes

  // 30-day per-tool call counts (registry names). null = analytics unavailable
  // or not loaded yet — the cost overlay then omits usage entirely.
  const [toolCalls30d, setToolCalls30d] = useState<null | Record<string, number>>(null)

  // Blocks the browser until an OAuth flow lands a token; also reset on profile
  // switch, so declared up here alongside the other per-profile view state.
  const [authing, setAuthing] = useState<null | string>(null)

  const [logSource, setLogSource] = useState<'stdio' | 'agent'>('stdio')

  // Which server the left pane is configuring; null shows the fleet+catalog
  // list. Config is edited through the per-server pane and the Add dialog, so
  // selection is plain state.
  const [selected, setSelected] = useState<null | string>(null)
  const [adding, setAdding] = useState(false)

  const focusServer = (name: string) => setSelected(name)

  const servers = useMemo(() => getServers(config ?? null), [config])

  // Config/document order, not alphabetical — the list mirrors mcp.json.
  const names = useMemo(() => Object.keys(servers), [servers])

  // Key by the SCOPED profile — installed/enabled badges are per-profile, so
  // sharing one cache across profiles would flash the previous profile's state
  // on switch. When no selector override is set this is the active profile,
  // identical to before.
  const catalogQuery = useQuery({
    queryKey: [...MCP_CATALOG_KEY, scopeProfileKey],
    queryFn: () => getMcpCatalog(profile ?? undefined),
    staleTime: 5 * 60_000
  })

  const catalog = useMemo(() => catalogQuery.data?.entries ?? [], [catalogQuery.data])

  // The catalog SECTION of the unified list only offers entries that aren't
  // already configured — installed servers appear once, in the fleet list
  // above, with live status. Match by catalog `installed` flag or a config
  // entry under the same name (covers a just-saved doc the catalog refetch
  // hasn't caught up with yet).
  const availableCatalog = useMemo(
    () => catalog.filter((entry: McpCatalogEntry) => !entry.installed && !(entry.name in servers)),
    [catalog, servers]
  )

  const descriptionFor = (serverName: string, server: Record<string, unknown>): null | string => {
    const lower = serverName.toLowerCase()

    const match = catalog.find(
      entry =>
        entry.name.toLowerCase() === lower ||
        (entry.url && entry.url === server.url) ||
        (entry.command && entry.command === server.command)
    )

    return match?.description ?? null
  }

  // Bumped on every profile switch. Async probe/auth completions capture the
  // epoch at call time and bail if it changed, so a slow profile-A request can't
  // write its result into profile B's state after the user switched.
  const profileEpoch = useRef(0)

  // Scoped Skills tabs remount when their owner changes; stop the old native
  // OAuth waiter even when no app-wide profile-switch event is emitted.
  useEffect(
    () => () => {
      profileEpoch.current += 1
    },
    [scopeProfileKey]
  )

  // A profile switch invalidates the config query (see store/profile.ts), which
  // refetches the new backend's server map. Reset ALL per-profile view state —
  // selection, probes, auth — so everything reseeds for the new profile. The
  // probe cache is already profile-keyed, so this just forces a re-probe.
  useOnProfileSwitch(() => {
    profileEpoch.current += 1
    setProbes({})
    setToolCalls30d(null)
    setSelected(null)
    setAdding(false)
    setAuthing(null)
    // Mark stale until the config query replaces profile A's data — guards
    // sidebar mutations from persisting A's server list into B mid-refetch.
    staleConfigStamp.current = configUpdatedAt
    staleErrorStamp.current = configErroredAt
    setProfilePending(true)
  })

  // Clear once the config query settles for the new profile: dataUpdatedAt bumps
  // on a fresh success, errorUpdatedAt on a fresh failure. Releasing on error too
  // means a failed refetch surfaces the retry UI instead of leaving mutations
  // silently no-op forever.
  // eslint-disable-next-line no-restricted-syntax -- legitimate non-atom ref write (see eslint rule comment)
  useEffect(() => {
    if (
      profilePending &&
      staleConfigStamp.current !== null &&
      (configUpdatedAt !== staleConfigStamp.current || configErroredAt !== staleErrorStamp.current)
    ) {
      setProfilePending(false)
      staleConfigStamp.current = null
      staleErrorStamp.current = null
    }
  }, [profilePending, configUpdatedAt, configErroredAt])

  useDeepLinkHighlight({
    block: 'nearest',
    elementId: serverName => `mcp-server-${serverName}`,
    onResolve: focusServer,
    param: 'server',
    ready: serverName => serverName in servers
  })

  const runProbe = async (serverName: string) => {
    const epoch = profileEpoch.current
    const key = probeKey(serverName, servers[serverName], scopeProfileKey)
    setProbes(current => ({ ...current, [serverName]: 'probing' }))

    try {
      const result = await testMcpServer(serverName, profile ?? undefined)

      // Drop the result if the profile changed mid-probe — it belongs to A.
      if (profileEpoch.current !== epoch) {
        return
      }

      probeCache.set(key, { at: Date.now(), result })
      setProbes(current => ({ ...current, [serverName]: result }))
    } catch (err) {
      if (profileEpoch.current !== epoch) {
        return
      }

      const result = { ok: false, error: err instanceof Error ? err.message : String(err), tools: [] }
      probeCache.set(key, { at: Date.now(), result })
      setProbes(current => ({ ...current, [serverName]: result }))
    }
  }

  // First-class OAuth: opens the system browser, blocks until the flow lands a
  // token (verified on disk — a friendly tools/list is not proof), then the
  // auth result doubles as the probe (it carries the tool list).
  const authenticate = async (serverName: string) => {
    const epoch = profileEpoch.current
    setAuthing(serverName)
    setProbes(current => ({ ...current, [serverName]: 'probing' }))

    try {
      const flow = await completeMcpDesktopOAuth({
        serverName,
        profile,
        cancelled: () => profileEpoch.current !== epoch
      })

      const result: McpTestResult = { ok: true, tools: flow.tools ?? [] }

      // Bail if the user switched profiles mid-flow — this result is profile A's.
      if (profileEpoch.current !== epoch) {
        return
      }

      setProbes(current => ({ ...current, [serverName]: result }))
      // Cache under the POST-auth fingerprint (auth: oauth) on success — that's
      // the config the mount effect will read back, so it hits this entry.
      const probedConfig = result.ok ? { ...servers[serverName], auth: 'oauth' } : servers[serverName]
      probeCache.set(probeKey(serverName, probedConfig, scopeProfileKey), { at: Date.now(), result })

      if (result.ok) {
        // The endpoint persisted `auth: oauth` — mirror it locally.
        const nextServers = { ...servers, [serverName]: { ...servers[serverName], auth: 'oauth' } }
        setConfig(current => (current ? { ...current, mcp_servers: nextServers } : current))

        notify({
          kind: 'success',
          title: m.authenticatedTitle,
          message: m.authenticatedMessage(serverName, result.tools.length)
        })
        void silentReload()
      } else if (result.error) {
        notifyError(new Error(result.error), serverName)
      }
    } catch (err) {
      if (profileEpoch.current !== epoch) {
        return
      }

      setProbes(current => ({
        ...current,
        [serverName]: { ok: false, error: err instanceof Error ? err.message : String(err), tools: [] }
      }))
      notifyError(err, serverName)
    } finally {
      if (profileEpoch.current === epoch) {
        setAuthing(null)
      }
    }
  }

  // It should just know: probe enabled servers as config arrives — but through
  // the cache, so revisiting the page doesn't respawn/reconnect the fleet.
  useEffect(() => {
    for (const [serverName, server] of Object.entries(servers)) {
      if (!serverEnabled(server) || probesRef.current[serverName] !== undefined) {
        continue
      }

      const cached = probeCache.get(probeKey(serverName, server, scopeProfileKey))

      if (cached && Date.now() - cached.at < PROBE_TTL_MS) {
        setProbes(current => ({ ...current, [serverName]: cached.result }))
      } else {
        void runProbe(serverName)
      }
    }
    // Re-run only when the server set changes; runProbe is recreated every
    // render and adding it would re-probe the fleet on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [servers])

  // Cosmetic 30-day usage counts for the cost overlay — cached module-wide per
  // scope profile, epoch-guarded like the probes so a slow profile-A fetch
  // can't paint into profile B.
  useEffect(() => {
    const epoch = profileEpoch.current

    void loadMcpUsage(scopeProfileKey, profile ?? appProfile ?? null).then(value => {
      if (profileEpoch.current === epoch) {
        setToolCalls30d(value)
      }
    })
  }, [scopeProfileKey, profile, appProfile])

  // Overlay inputs for one server: token estimate from its (successful) probe,
  // 30-day uses from analytics. Both halves degrade to null independently.
  const costFor = (serverName: string, server: Record<string, unknown>): ServerCost => {
    const probe = probes[serverName]

    return {
      tokens: probe && probe !== 'probing' && probe.ok ? estimateServerTokens(server, probe.tools) : null,
      uses: toolCalls30d ? serverUsageCount(serverName, toolCalls30d) : null
    }
  }

  // Config writes reach live sessions immediately — no manual "Reload MCP".
  const silentReload = async () => {
    if (!gateway) {
      return
    }

    try {
      await gateway.request('reload.mcp', { confirm: true, session_id: activeSessionId ?? undefined })
    } catch (err) {
      notifyError(err, m.reloadFailed)
    }
  }

  // Whole-map replace (NOT saveHermesConfig, which deep-merges and so can never
  // delete a server, drop `enabled: false`, or remove a nested field). Only
  // after the replace lands do we write the cache through + reload live sessions.
  // Returns false when the profile switched mid-save: the write hit profile A's
  // backend (correct), but the client-side cache/editor now belong to B, so the
  // caller must skip its post-await writes.
  const persist = async (nextServers: McpServers): Promise<boolean> => {
    const epoch = profileEpoch.current
    await saveMcpServers(nextServers, profile ?? undefined)

    if (profileEpoch.current !== epoch) {
      return false
    }

    setConfig(current => ({ ...current, mcp_servers: nextServers }))
    void silentReload()

    return true
  }

  // A catalog install wrote a new server into config.yaml on the backend —
  // refresh the catalog (installed state) and the config so the fleet list
  // picks the new entry up, then reload live sessions.
  const onCatalogInstalled = async () => {
    void catalogQuery.refetch()
    await refetchConfig()
    void silentReload()
  }

  const withEnabled = (server: Record<string, unknown>, enabled: boolean) => {
    const next = { ...server }

    if (enabled) {
      delete next.enabled
    } else {
      next.enabled = false
    }

    return next
  }

  const setServerEnabled = async (serverName: string, enabled: boolean) => {
    if (profilePending) {
      return
    }

    const next = withEnabled(servers[serverName], enabled)

    try {
      if (!(await persist({ ...servers, [serverName]: next }))) {
        return
      }

      if (enabled) {
        void runProbe(serverName)
      }
    } catch (err) {
      notifyError(err, m.saveFailed)
    }
  }

  // Per-tool gating writes the server's `tools.include`/`tools.exclude` and
  // persists like any other config change (immediate reload of live sessions).
  // The probe still lists every discovered tool; the filter decides which ones
  // the agent actually registers.
  const toggleTool = async (serverName: string, toolName: string) => {
    const base = servers[serverName]

    if (!base || profilePending) {
      return
    }

    const next = toggleToolInServer(base, toolName)

    try {
      await persist({ ...servers, [serverName]: next })
    } catch (err) {
      notifyError(err, m.saveFailed)
    }
  }

  const removeServer = async (serverName: string) => {
    if (profilePending) {
      return
    }

    setSaving(true)

    try {
      const next = { ...servers }
      delete next[serverName]

      if (!(await persist(next))) {
        return
      }

      setSelected(null)
    } catch (err) {
      notifyError(err, m.removeFailed)
    } finally {
      setSaving(false)
    }
  }

  // Write new entries straight through: the whole-map persist is the single
  // save path, so both the Add dialog and the paste importer land servers the
  // same way the catalog install does — no intermediate unsaved state.
  // Names already taken get a `-2`, `-3`, … suffix rather than overwriting.
  const mergeServers = async (entries: { config: Record<string, unknown>; name: string }[]) => {
    if (profilePending || entries.length === 0) {
      return
    }

    let next: McpServers = { ...servers }
    let firstKey: null | string = null

    for (const entry of entries) {
      let key = entry.name

      for (let i = 2; key in next; i++) {
        key = `${entry.name}-${i}`
      }

      next = { ...next, [key]: entry.config }
      firstKey ??= key
    }

    setSaving(true)

    try {
      if (!(await persist(next))) {
        return
      }

      notify({
        kind: 'success',
        title: m.savedTitle,
        message: m.savedMessage(entries.length === 1 ? (firstKey ?? '') : String(entries.length))
      })

      if (firstKey) {
        setSelected(firstKey)
        void runProbe(firstKey)
      }
    } catch (err) {
      notifyError(err, m.saveFailed)
    } finally {
      setSaving(false)
    }
  }

  const addServer = () => {
    if (!profilePending) {
      setAdding(true)
    }
  }

  const handleAdd = async (name: string, config: Record<string, unknown>) => {
    await mergeServers([{ config, name }])
    setAdding(false)
  }

  const importServers = (entries: McpImportEntry[]) => {
    void mergeServers(entries.map(entry => ({ config: entry.config, name: entry.name })))
  }

  // Cached data paints instantly; a spinner only ever shows on the first-ever
  // load, and a failed load gets a real retry — never a silent blank pane.
  if (configFailed && !config) {
    return (
      <div className="flex h-full min-h-0 flex-1 items-center justify-center p-6">
        <ErrorBanner className="max-w-sm">
          <span className="flex flex-col gap-2">
            {configError instanceof Error ? configError.message : m.failedLoad}
            <Button className="self-start" onClick={() => void refetchConfig()} size="xs" variant="text">
              {m.reload}
            </Button>
          </span>
        </ErrorBanner>
      </div>
    )
  }

  if (!config) {
    return <PageLoader className="min-h-24" label={configLoading ? m.loading : t.skills.loading} />
  }

  // Every entry the pane can show is already persisted — adds and imports save
  // before they select, so there is no unsaved-draft case to fall back to.
  const activeEntry = selected ? servers[selected] : undefined

  return (
    <div className={cn('grid h-full min-h-0 grid-cols-1', selected && activeEntry && MASTER_DETAIL_WIDE_COLS)}>
      {/* LEFT: the focused server's config, or the unified fleet+catalog list. */}
      <aside
        className={cn(
          'flex min-h-0 flex-col overflow-hidden',
          selected && activeEntry && 'border-r border-(--ui-stroke-quaternary)'
        )}
      >
        {selected && activeEntry ? (
          <ServerConfig
            authing={authing === selected}
            cost={costFor(selected, activeEntry)}
            description={descriptionFor(selected, activeEntry)}
            entry={activeEntry}
            name={selected}
            onAuthenticate={() => void authenticate(selected)}
            onBack={() => setSelected(null)}
            onProbe={() => void runProbe(selected)}
            onRemove={() => void removeServer(selected)}
            onToggle={checked => void setServerEnabled(selected, checked)}
            onToggleTool={toolName => void toggleTool(selected, toolName)}
            probe={probes[selected]}
            saved
            saving={saving}
          />
        ) : (
          <div className="flex min-h-0 flex-1 flex-col p-2">
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain [scrollbar-gutter:stable]">
              {/* ONE coherent column: the configured fleet on top, the
                  Nous-approved catalog below it. Installed entries live in the
                  fleet list (with live status), so the catalog section only
                  offers what's NOT installed yet — no duplicate rows, no tab
                  flipping to find the install button. */}
              {/* Geometry mirrors ListStrip (mb-1 h-6 pl-2) so this header
                  lands on the exact line the sort link occupies in the
                  Skills/Tools views. */}
              <div className="mb-1 flex h-6 shrink-0 items-center pl-2 pr-1">
                <span className="flex-1 text-[0.72rem] font-medium text-(--ui-text-tertiary)">{m.tabServers}</span>
                <McpImportButton disabled={profilePending} onImport={importServers} />
              </div>
              {names.length === 0 ? (
                <PanelEmpty
                  action={
                    <Button onClick={addServer} size="sm">
                      {m.newServer}
                    </Button>
                  }
                  description={m.emptyDesc}
                  icon="plug"
                  title={m.emptyTitle}
                />
              ) : (
                <>
                  {names.map(serverName => {
                    const server = servers[serverName]
                    const status = statusOf(server, probes[serverName])
                    const cost = costFor(serverName, server)

                    return (
                      <McpRow
                        active={false}
                        busy={saving}
                        enabled={serverEnabled(server)}
                        key={serverName}
                        name={serverName}
                        onProbe={() => void runProbe(serverName)}
                        onRemove={() => void removeServer(serverName)}
                        onSelect={() => focusServer(serverName)}
                        onToggle={checked => void setServerEnabled(serverName, checked)}
                        status={status}
                        statusText={statusLine(m, status, probes[serverName], server, cost)}
                        unused={
                          serverEnabled(server) &&
                          status === 'ok' &&
                          cost.tokens !== null &&
                          cost.tokens > 0 &&
                          cost.uses === 0
                        }
                      />
                    )
                  })}
                  <PanelAddButton label={m.newServer} onClick={addServer} />
                </>
              )}
              {(catalogQuery.isLoading || availableCatalog.length > 0) && (
                <>
                  <div className="mb-1 mt-3 flex h-6 shrink-0 items-center border-t border-(--ui-stroke-quaternary) pl-2 pr-1 pt-2">
                    <span className="text-[0.72rem] font-medium text-(--ui-text-tertiary)">{m.tabCatalog}</span>
                  </div>
                  <McpCatalog
                    entries={availableCatalog}
                    loading={catalogQuery.isLoading}
                    onInstalled={onCatalogInstalled}
                    profile={profile}
                  />
                </>
              )}
            </div>
          </div>
        )}
      </aside>

      {/* RIGHT: the SELECTED server's output only. The all-servers firehose
          that used to sit here was noise on the landing view — browsing the
          fleet now gets the full width, and logs appear when you open a
          server, scoped to it. */}
      {selected && activeEntry && (
        <main className="flex min-h-0 flex-col overflow-hidden">
          <header className="flex h-9 shrink-0 items-center gap-2 px-3">
            <span className="min-w-0 truncate text-xs font-medium text-foreground">{selected}</span>
            <span className="ml-auto flex shrink-0 items-center gap-1.5">
              {(['stdio', 'agent'] as const).map(kind => (
                <TextTab
                  active={logSource === kind}
                  className="h-5 px-0.5 text-[0.65rem]"
                  key={kind}
                  onClick={() => setLogSource(kind)}
                >
                  {kind}
                </TextTab>
              ))}
            </span>
          </header>
          <div className="min-h-0 flex-1 overflow-hidden">
            <McpLogs emptyLabel={m.noOutput} server={selected} source={logSource} />
          </div>
        </main>
      )}

      <McpAddDialog
        existingNames={names}
        onAdd={handleAdd}
        onClose={() => setAdding(false)}
        open={adding}
        saving={saving}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Left column: one server's config (mirrors the block under the cursor).
// ---------------------------------------------------------------------------

function ServerConfig({
  authing,
  cost,
  description,
  entry,
  name,
  onAuthenticate,
  onBack,
  onProbe,
  onRemove,
  onToggle,
  onToggleTool,
  probe,
  saved,
  saving
}: {
  authing: boolean
  cost?: ServerCost
  description: null | string
  entry: Record<string, unknown>
  name: string
  onAuthenticate: () => void
  onBack: () => void
  onProbe: () => void
  onRemove: () => void
  onToggle: (checked: boolean) => void
  onToggleTool: (toolName: string) => void
  probe: Probe | undefined
  saved: boolean
  saving: boolean
}) {
  const { t } = useI18n()
  const m = t.settings.mcp
  const status = statusOf(entry, probe)

  // OAuth is only offered to servers that are actually OAuth-shaped. A server
  // with `headers` uses API-key/bearer auth — a 401 there means a bad key, NOT
  // "log in with OAuth"; routing it through the browser flow would wrongly
  // rewrite its config to `auth: oauth`. So: explicit `auth: oauth` can re-auth
  // on failure; an auth-less HTTP server may try OAuth on a 401; header servers
  // never do.
  const hasHeaderAuth = !!entry.headers && typeof entry.headers === 'object'

  const canAuth =
    typeof entry.url === 'string' &&
    !hasHeaderAuth &&
    (entry.auth === 'oauth' ? status === 'needs-auth' || status === 'error' : !entry.auth && status === 'needs-auth')

  const summary = probe && probe !== 'probing' && probe.ok ? capabilitySummary(m, probe, entry, cost) : null

  return (
    // p-2 matches the list view's container so flipping list ⇄ config keeps
    // content anchored at the same origin.
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2 [scrollbar-gutter:stable]">
      {/* Geometry cloned from McpRow so nothing jumps when flipping list ⇄
          config: items-start with per-element top margins that reproduce the
          row's h-11 centering exactly (h-5 controls → mt-3, size-6 avatar →
          mt-2.5, h-4 switch → mt-3.5) no matter how tall the text column gets. */}
      <div className="flex items-start gap-2 pr-1.5">
        <Tip label={m.allServers}>
          <Button
            aria-label={m.allServers}
            className={cn('mt-3', ICON_BUTTON)}
            onClick={onBack}
            size="icon"
            variant="ghost"
          >
            <Codicon name="chevron-left" size="0.8125rem" />
          </Button>
        </Tip>
        <McpAvatar className="mt-2.5" name={name} status={status} />
        <div className="min-w-0 flex-1 pt-1">
          <h3 className="min-w-0 truncate text-[0.9375rem] font-semibold tracking-tight">{prettyName(name)}</h3>
          <p className="mt-0.5 truncate text-[0.68rem] text-(--ui-text-tertiary)">
            {typeof entry.url === 'string' ? entry.url : [entry.command, ...((entry.args as string[]) ?? [])].join(' ')}
          </p>
          {summary && <p className="mt-0.5 text-[0.68rem] text-(--ui-text-tertiary)">{summary}</p>}
        </div>
        {saved && (
          // Direct row children (no wrapper): the icons↔switch gap must be the
          // row's own gap-2, byte-identical to McpRow.
          <>
            <ServerIconActions
              className="mt-3"
              onProbe={onProbe}
              onRemove={onRemove}
              probing={probe === 'probing'}
              saving={saving}
            />
            <ServerSwitch
              className="mt-3.5"
              disabled={saving}
              enabled={serverEnabled(entry)}
              name={name}
              onToggle={onToggle}
            />
          </>
        )}
      </div>

      {description && (
        <p className="mt-2 text-[length:var(--conversation-caption-font-size)] leading-(--conversation-caption-line-height) text-(--ui-text-tertiary)">
          {description}
        </p>
      )}

      {canAuth && saved && (
        <div className="mt-3 flex justify-end">
          <Button disabled={authing} onClick={onAuthenticate} size="xs">
            {authing ? m.waitingForBrowser : m.authenticate}
          </Button>
        </div>
      )}
      {!saved && <p className="mt-3 text-[0.68rem] text-muted-foreground/60">{m.unsavedConnect}</p>}

      {status === 'probing' && <PageLoader className="min-h-24" label={t.skills.loading} />}

      {/* No inline error dump — the status dot/line says "Error"/"Needs
          authentication", and the actual failure lands in the logs pane below
          (and the console). A big red block here just shouts the same thing. */}

      {probe && probe !== 'probing' && probe.ok && probe.tools.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1">
          {/* Chip = a discovered tool; click to include/exclude it (struck
              through when excluded, so it won't register). The probe always
              lists every tool regardless of the filter. */}
          {probe.tools.map(tool => {
            const on = isToolEnabled(entry, tool.name)

            return (
              <button
                aria-pressed={on}
                className={cn(
                  'rounded-md px-1.5 py-0.5 font-mono text-[0.65rem] text-(--ui-text-tertiary) hover:text-foreground',
                  saved ? 'cursor-pointer' : 'cursor-default',
                  on ? 'bg-(--ui-bg-quinary)' : 'line-through opacity-70'
                )}
                disabled={!saved}
                key={tool.name}
                onClick={() => onToggleTool(tool.name)}
                title={on ? m.disableTool(tool.name) : m.enableTool(tool.name)}
                type="button"
              >
                {tool.name}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

// The enable toggle, shared by the row and the config header. It reflects the
// configured `enabled` flag ONLY — full-strength when on, dimmed when off — so
// "is this on?" reads instantly from config, never gated on a probe that can
// take seconds (stdio servers spawn `npx`). Whether it's actually *connected*
// is the status dot's job, not the switch's.
function ServerSwitch({
  className,
  disabled,
  enabled,
  name,
  onToggle
}: {
  className?: string
  disabled: boolean
  enabled: boolean
  name: string
  onToggle: (checked: boolean) => void
}) {
  return (
    <Switch
      aria-label={name}
      checked={enabled}
      className={cn('shrink-0 cursor-pointer', !enabled && 'opacity-60', className)}
      disabled={disabled}
      onCheckedChange={onToggle}
      size="xs"
      title={name}
    />
  )
}

// Refresh + delete, identical beside every toggle (rows and config header).
function ServerIconActions({
  className,
  onProbe,
  onRemove,
  probing,
  saving
}: {
  className?: string
  onProbe: () => void
  onRemove: () => void
  probing: boolean
  saving: boolean
}) {
  const { t } = useI18n()
  const m = t.settings.mcp

  return (
    <span className={cn('flex items-center gap-0.5', className)}>
      <Tip label={m.reload}>
        <Button
          aria-label={m.reload}
          className={ICON_BUTTON}
          disabled={probing}
          onClick={onProbe}
          size="icon"
          variant="ghost"
        >
          <Codicon name="refresh" size="0.8125rem" spinning={probing} />
        </Button>
      </Tip>
      <Tip label={m.remove}>
        <Button
          aria-label={m.remove}
          className={cn(ICON_BUTTON, 'hover:text-destructive')}
          disabled={saving}
          onClick={onRemove}
          size="icon"
          variant="ghost"
        >
          <Codicon name="trash" size="0.8125rem" />
        </Button>
      </Tip>
    </span>
  )
}

// Paste-anything import: a compact popover on the Servers header. Paste any
// README shape — mcp.json snippet, npx/docker command line, `claude mcp add`,
// a bare URL, or a Cursor deeplink — see the inferred name + config, then
// merge it into the editor draft (unsaved, like the "+" starter entry).
function McpImportButton({ disabled, onImport }: { disabled: boolean; onImport: (entries: McpImportEntry[]) => void }) {
  const { t } = useI18n()
  const m = t.settings.mcp
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')

  const entries = useMemo(() => parseMcpImport(text), [text])

  const reset = () => {
    setText('')
  }

  const confirm = () => {
    if (!entries) {
      return
    }

    onImport(entries)
    setOpen(false)
    reset()
  }

  return (
    <Popover
      onOpenChange={next => {
        setOpen(next)

        if (!next) {
          reset()
        }
      }}
      open={open}
    >
      <PopoverTrigger asChild>
        <Button className="h-5 px-1 text-[0.68rem]" disabled={disabled} size="xs" variant="text">
          <Codicon name="clippy" size="0.75rem" />
          {m.importButton}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80">
        <div className="flex flex-col gap-2">
          <Textarea
            aria-label={m.importButton}
            autoFocus
            className="max-h-40 min-h-20 font-mono text-[0.68rem]"
            onChange={event => setText(event.currentTarget.value)}
            placeholder={m.importPlaceholder}
            value={text}
          />
          {entries ? (
            <div className="flex max-h-40 flex-col gap-1 overflow-y-auto">
              {entries.map((entry, index) => (
                <div className="rounded-md bg-(--ui-bg-tertiary) px-2 py-1.5" key={`${entry.name}-${index}`}>
                  <span className="block truncate text-[0.72rem] font-medium text-foreground/85">{entry.name}</span>
                  <span className="block truncate font-mono text-[0.62rem] text-muted-foreground/60">
                    {typeof entry.config.url === 'string'
                      ? entry.config.url
                      : [entry.config.command, ...((entry.config.args as string[]) ?? [])].join(' ')}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            text.trim() && <p className="px-0.5 text-[0.62rem] text-muted-foreground/60">{m.importNoMatch}</p>
          )}
          <div className="flex justify-end">
            <Button disabled={!entries} onClick={confirm} size="xs">
              {entries && entries.length > 1 ? m.importConfirmMany(entries.length) : m.importConfirm}
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}

// Small gray attribute chip (transport / auth / needs-build), matching the
// catalog's flat row treatment.
function CatalogTag({ children }: { children: string }) {
  return (
    <span className="rounded bg-(--ui-bg-tertiary) px-1.5 py-0.5 text-[0.6rem] text-(--ui-text-secondary)">
      {children}
    </span>
  )
}

// The Nous-approved MCP catalog: one-click installs of curated servers, with an
// inline prompt for any required credentials (never shows stored values). On
// install the parent refetches config + catalog and reloads live sessions.
function McpCatalog({
  entries,
  loading,
  onInstalled,
  profile
}: {
  entries: McpCatalogEntry[]
  loading: boolean
  onInstalled: () => void
  profile?: ProfileScope
}) {
  const { t } = useI18n()
  const m = t.settings.mcp
  const [installing, setInstalling] = useState<null | string>(null)
  const [envDrafts, setEnvDrafts] = useState<Record<string, Record<string, string>>>({})
  const [envOpenFor, setEnvOpenFor] = useState<null | string>(null)

  const install = async (entry: McpCatalogEntry) => {
    const required = entry.required_env.filter(env => env.required)
    const draft = envDrafts[entry.name] ?? {}

    // Reveal the credential prompt first; only error once it's shown and unfilled.
    if (required.some(env => !draft[env.name]?.trim())) {
      if (envOpenFor !== entry.name) {
        setEnvOpenFor(entry.name)

        return
      }

      notify({ kind: 'error', title: m.catalogEnvPrompt(entry.name), message: m.catalogEnvRequired })

      return
    }

    setInstalling(entry.name)

    try {
      const res = await installMcpCatalogEntry(entry.name, draft, profile ?? undefined)

      // Git-backed entries clone in the background — keep the row busy and poll
      // the action to completion before refetching / re-enabling, so a re-click
      // can't spawn a second install over the first's tracked process. A non-zero
      // exit is a real failure — surface it instead of a false success.
      if (res.background && res.action) {
        for (;;) {
          const status = await getActionStatus(res.action, 1, profile ?? undefined)

          if (!status.running) {
            if (status.exit_code !== 0) {
              throw new Error(m.catalogInstallFailed(entry.name))
            }

            break
          }

          await new Promise(resolve => setTimeout(resolve, CATALOG_INSTALL_POLL_MS))
        }
      }

      notify({ kind: 'success', title: m.catalogInstallStarted(entry.name), message: '' })
      setEnvOpenFor(null)
      onInstalled()
    } catch (err) {
      notifyError(err, m.catalogInstallFailed(entry.name))
    } finally {
      setInstalling(null)
    }
  }

  if (loading) {
    return <PageLoader className="min-h-24" label={m.catalogLoading} />
  }

  if (entries.length === 0) {
    return <PanelEmpty description={m.catalogEmpty} icon="plug" title={m.tabCatalog} />
  }

  return (
    <div className="flex flex-col">
      {entries.map(entry => {
        const draft = envDrafts[entry.name] ?? {}

        return (
          <div className="rounded-md px-2 py-2" key={entry.name}>
            <div className="flex items-start gap-2">
              {/* 2px nudge so the start-aligned avatar sits where McpRow's
                  center-aligned one does — no jump when flipping Servers⇄Catalog. */}
              <McpAvatar
                className="mt-0.5"
                name={entry.name}
                status={entry.installed ? (entry.enabled ? 'ok' : 'off') : 'unknown'}
              />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="truncate text-[0.78rem] font-medium text-foreground/85">
                    {prettyName(entry.name)}
                  </span>
                  <CatalogTag>{entry.transport}</CatalogTag>
                  {entry.auth_type === 'oauth' && <CatalogTag>OAuth</CatalogTag>}
                  {entry.auth_type === 'api_key' && <CatalogTag>API key</CatalogTag>}
                  {entry.needs_install && !entry.installed && <CatalogTag>{m.catalogNeedsInstall}</CatalogTag>}
                  {entry.installed && (
                    <span className="text-[0.6rem] text-emerald-400">
                      {entry.enabled ? m.catalogEnabled : m.catalogInstalled}
                    </span>
                  )}
                </div>
                <p className="mt-0.5 line-clamp-2 text-[0.68rem] text-muted-foreground/70">{entry.description}</p>
                {envOpenFor === entry.name && entry.required_env.length > 0 && (
                  <div className="mt-2 grid gap-2">
                    {entry.required_env.map(env => (
                      <label className="grid gap-1" key={env.name}>
                        <span className="text-[0.62rem] text-muted-foreground">
                          {env.prompt || env.name}
                          {env.required ? ' *' : ''}
                        </span>
                        <Input
                          className="h-7 text-xs"
                          onChange={event =>
                            setEnvDrafts(prev => ({
                              ...prev,
                              [entry.name]: { ...prev[entry.name], [env.name]: event.currentTarget.value }
                            }))
                          }
                          type="password"
                          value={draft[env.name] ?? ''}
                        />
                      </label>
                    ))}
                  </div>
                )}
              </div>
              <Button
                className="mt-0.5 shrink-0"
                disabled={entry.installed || installing !== null}
                onClick={() => void install(entry)}
                size="xs"
                variant="text"
              >
                {installing === entry.name
                  ? m.catalogInstalling
                  : entry.installed
                    ? m.catalogInstalled
                    : m.catalogInstall}
              </Button>
            </div>
          </div>
        )
      })}
    </div>
  )
}

const LOG_POLL_MS = 2000

// Cadence for polling a background (git-bootstrap) catalog install to completion.
const CATALOG_INSTALL_POLL_MS = 1500

const STDIO_MARKER_RE = /^===== \[.*\] starting MCP server '(.+)' =====$/

// Keep only the stdio-log sections belonging to one server. The shared file
// has no per-line tags — sections start at that server's session marker and
// run until the next marker (any server's).
function filterStdioSections(lines: string[], server: string): string[] {
  const out: string[] = []
  let inSection = false

  for (const line of lines) {
    const marker = STDIO_MARKER_RE.exec(line.trim())

    if (marker) {
      inSection = marker[1] === server
    }

    if (inSection) {
      out.push(line)
    }
  }

  return out
}

// The MCP output channel — Cursor's "MCP Logs" equivalent, pinned under the
// editor. Scope follows the cursor-selected server (all servers otherwise);
// source controls live in the pane header. Body is the app's tool-output
// surface: CodeCardBody typography + the floating hover-reveal copy button.
function McpLogs({
  emptyLabel,
  server,
  source
}: {
  emptyLabel: string
  server: null | string
  source: 'stdio' | 'agent'
}) {
  const [lines, setLines] = useState<null | string[]>(null)
  // A profile switch reroutes getLogs to the new backend; keying the effect on
  // the active profile tears down the old poll (stop suppresses a late
  // publish) so profile A's logs never flash in B.
  const activeProfile = useStore($activeGatewayProfile)

  useEffect(() => {
    setLines(null)

    return startCompletionPoll({
      delayMs: LOG_POLL_MS,
      poll: async () => {
        const response =
          source === 'stdio'
            ? await getLogs({ file: 'mcp', lines: 500 })
            : await getLogs({ file: 'agent', lines: 300, search: server ?? 'mcp' })

        return source === 'stdio' && server ? filterStdioSections(response.lines, server) : response.lines
      },
      publish: setLines
    })
  }, [server, source, activeProfile])

  return <LogTail emptyLabel={emptyLabel} lines={lines} />
}

// ---------------------------------------------------------------------------
// Avatars + list rows
// ---------------------------------------------------------------------------

// The shared identity chip (`ui/avatar-chip`) plus a status dot. Identity
// ladder: curated brand glyph (lib/mcp-brands, shared with the composer
// suggestion pills and the inline setup card) → letter monogram. Nothing here
// reaches the network for a mark: a configured MCP URL can be a private host,
// and the connector card's favicon rung only ever reads a public site's own
// markup, never a third-party icon service.
function McpAvatar({ className, name, status }: { className?: string; name: string; status: ServerStatus }) {
  return (
    <AvatarChip
      brand={brandFor(name)}
      className={className}
      name={name}
      overlay={
        <span
          aria-hidden
          className={cn(
            'absolute -bottom-0.5 -right-0.5 size-2 rounded-full ring-2 ring-(--ui-chat-surface-background)',
            STATUS_DOT[status]
          )}
        />
      }
    />
  )
}

function McpRow({
  active,
  busy,
  enabled,
  name,
  onProbe,
  onRemove,
  onSelect,
  onToggle,
  status,
  statusText,
  unused
}: {
  active: boolean
  busy: boolean
  enabled: boolean
  name: string
  onProbe: () => void
  onRemove: () => void
  onSelect: () => void
  onToggle: (checked: boolean) => void
  status: ServerStatus
  statusText: string
  unused?: boolean
}) {
  const { t } = useI18n()
  const m = t.settings.mcp

  return (
    <div
      className={cn(
        'group/row row-hover flex h-11 w-full shrink-0 items-center gap-2 rounded-md pl-2 pr-1.5 hover:text-foreground',
        active ? 'bg-(--ui-row-active-background) text-foreground' : 'text-(--ui-text-secondary)'
      )}
      id={`mcp-server-${name}`}
    >
      <button
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left"
        onClick={onSelect}
        type="button"
      >
        <McpAvatar name={name} status={status} />
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-1.5">
            <span
              className={cn(
                'min-w-0 truncate text-[0.78rem]',
                enabled ? 'font-medium text-foreground/85' : 'font-normal text-muted-foreground/60'
              )}
            >
              {prettyName(name)}
            </span>
            {/* Subtle "paying for schemas, not using them" hint — a muted pill,
                never a dialog. Shown only when the overlay KNOWS both halves:
                nonzero schema cost and zero 30-day uses. */}
            {unused && (
              <span className="shrink-0 rounded bg-(--ui-bg-tertiary) px-1 py-px text-[0.58rem] font-normal text-muted-foreground/60">
                {m.unusedPill}
              </span>
            )}
          </span>
          <span className="block truncate text-[0.62rem] text-muted-foreground/50">{statusText}</span>
        </span>
      </button>
      <ServerIconActions
        className="opacity-0 transition-opacity focus-within:opacity-100 group-hover/row:opacity-100"
        onProbe={onProbe}
        onRemove={onRemove}
        probing={status === 'probing'}
        saving={busy}
      />
      <ServerSwitch disabled={busy} enabled={enabled} name={name} onToggle={onToggle} />
    </div>
  )
}
