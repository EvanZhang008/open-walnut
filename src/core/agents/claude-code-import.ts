/**
 * "Import from Claude Code" for the pi engine (2026-11-01, the user: "I have skills etc,
 * how does it know it? also the mcp etc? import setting from claude code").
 *
 * One click, per host: Walnut installs the walnut-claude-code pi extension
 * (src/data/pi/walnut-claude-code.ts) into that host's pi folder and points pi's own
 * settings at the model Claude Code uses (through Claude Code's own gateway when it names one:
 * pi-gateway.ts). The extension then reads Claude Code's files
 * live every time pi starts (credentials, MCP servers, skills, commands, CLAUDE.md), so
 * nothing is copied that could go stale and no secret leaves Claude Code's own file.
 *
 * `previewClaudeCodeImport` says exactly what the import will bring and what cannot
 * carry over, by running the extension's own collectors over the host's files;
 * `applyClaudeCodeImport` writes the extension, Walnut's gateway entry in pi's models.json
 * (when Claude Code names a gateway) and pi's settings.json (by key) with the daemon's guarded
 * atomic replace. Claude Code's files are only read.
 */

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  claudeCodeEnv,
  claudeCodeMcpServers,
  claudeCodeResourceDirs,
  claudePaths,
  enabledPlugins,
  isSecretEnvKey,
  loadClaudeCodeFiles,
  ruleFiles,
  type ClaudeCodeFiles,
  type ClaudeCodeReader,
  WALNUT_CLAUDE_CODE_EXTENSION_VERSION,
} from '../../data/pi/walnut-claude-code.js'
import { parseJsonObject, serializeJsonObject, type JsonObject } from './config-file-edit.js'
import { gatewayChange, piGatewayFromClaudeCode, PI_GATEWAY_PROVIDER, withGatewayEntry, type PiGateway } from './pi-gateway.js'

/** pi releases from this one carry MCP (pi.registerMcpServer); older ones still get the rest. */
export const PI_MCP_MIN_VERSION = '0.99.0'
export const PI_UPDATE_COMMAND = 'npm install -g @earendil-works/pi-coding-agent@latest'
export const EXTENSION_FILE_NAME = 'walnut-claude-code.ts'

/** ~/.claude.json keeps every project's history and can run to tens of MB; Claude Code reads it whole too. */
const MAX_FILE_BYTES = 32 * 1024 * 1024
/**
 * Rounds of "read what the last pass asked for": settings, then plugins, then their manifests,
 * one more per level of a nested rules folder (ruleFiles goes 4 deep) and of @path imports (5).
 */
const MAX_READ_ROUNDS = 16

/** The host's files, as the daemon there reads and writes them. */
export interface ImportTransport {
  /**
   * The file's exact bytes, or null when absent; throws when it is a folder, unreadable, or
   * larger than `maxBytes` (the message names EFBIG). Bytes, not text: the write guard hashes
   * what was read, and a decoded string would never match a file with one stray non-UTF-8 byte.
   */
  readBytes(p: string, maxBytes: number): Promise<Uint8Array | null>
  /** The folder's entry names; throws when it is not a folder. */
  listDir(p: string): Promise<string[]>
  /** Atomic replace guarded by the sha256 of the bytes read ('absent' = must not exist). */
  writeAtomic(p: string, text: string, expectSha256: string): Promise<void>
  /** Environment of the engine's processes on this host, when known (the local host). */
  env?: Readonly<Record<string, string | undefined>>
}

export interface PiInstall {
  installed: boolean
  version: string | null
  /** Older than PI_MCP_MIN_VERSION: everything but the MCP servers still comes over. */
  needsUpdateForMcp: boolean
}

export interface ImportItem {
  name: string
  detail: string
  source: string
}

export interface CannotCarry {
  what: string
  why: string
  nearest: string
}

export interface SettingChange {
  key: string
  from: unknown
  to: unknown
}

export interface ImportPreview {
  host: string
  pi: PiInstall
  claudeCode: { found: boolean; settingsPath: string }
  agentDir: string
  extension: { path: string; state: 'absent' | 'current' | 'outdated' | 'foreign'; version: number }
  settings: { path: string; changes: SettingChange[]; unreadable?: string }
  /**
   * Claude Code's gateway as a pi provider in models.json, or null when Claude Code names none.
   * Only the entry named `provider` is Walnut's; the file's other providers are never touched.
   */
  gateway: null | {
    path: string
    provider: string
    from: PiGateway['from']
    api: PiGateway['api']
    baseUrl: string
    modelIds: string[]
    change: 'add' | 'update' | 'none'
    unreadable?: string
  }
  credentials: { kind: 'bedrock' | 'anthropic-key' | 'sign-in' | 'none'; vars: Array<{ name: string; value?: string }>; note: string }
  mcpServers: ImportItem[]
  skippedMcpServers: ImportItem[]
  skills: ImportItem[]
  commands: ImportItem[]
  instructions: ImportItem[]
  cannotCarry: CannotCarry[]
  /** Files the preview could not read (too large) or a read it stopped early: its counts may be short. */
  warnings: string[]
  /** Nothing to write: the extension is current and pi's settings already match. */
  upToDate: boolean
}

export interface ImportResult {
  written: string[]
  preview: ImportPreview
}

// ── The extension's source, as shipped ──

let extensionSource: string | null = null

/** The extension file shipped in dist/data/pi (src/data/pi in a checkout). */
export function readExtensionSource(): string {
  if (extensionSource !== null) return extensionSource
  let dir = path.dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, 'data', 'pi', EXTENSION_FILE_NAME)
    try {
      extensionSource = fs.readFileSync(candidate, 'utf8')
      return extensionSource
    } catch { /* keep walking up */ }
    dir = path.dirname(dir)
  }
  throw new Error(`the pi extension ${EXTENSION_FILE_NAME} is missing from this Walnut install`)
}

const sha256 = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex')
const utf8 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('utf8')

/** The version the extension file declares, or null when it is not Walnut's. */
export function extensionVersionOf(text: string): number | null {
  const m = /WALNUT_CLAUDE_CODE_EXTENSION_VERSION\s*=\s*(\d+)/.exec(text)
  return m ? Number(m[1]) : null
}

// ── Reading a host's files through the collectors ──

type Entry = { kind: 'file'; text: string } | { kind: 'dir'; names: string[] } | { kind: 'none' }

/**
 * Runs `compute` over a reader backed by what has been fetched so far; every path it
 * asked about and did not have is fetched (all in parallel) and the pass runs again,
 * until a pass asks for nothing new. The collectors are pure, so the last pass is the
 * same answer the extension computes on the host itself.
 */
export async function withHostReader<T>(
  transport: ImportTransport,
  compute: (reader: ClaudeCodeReader) => T,
): Promise<{ value: T; entries: Map<string, Entry>; unreadable: string[] }> {
  const entries = new Map<string, Entry>()
  const unreadable: string[] = []
  // Absent is none; a read that fails on a folder lists it; any other failure (too large,
  // the host's daemon not answering) is never read as absent: a too-large file is named in
  // the preview, a transport failure fails the preview.
  const fetchOne = async (p: string): Promise<Entry> => {
    let readError: unknown
    try {
      const bytes = await transport.readBytes(p, MAX_FILE_BYTES)
      if (bytes !== null) return { kind: 'file', text: utf8(bytes) }
    } catch (err) { readError = err }
    try {
      return { kind: 'dir', names: await transport.listDir(p) }
    } catch {
      if (readError === undefined) return { kind: 'none' }
      const message = readError instanceof Error ? readError.message : String(readError)
      if (/EFBIG/.test(message)) {
        unreadable.push(`${p} is larger than ${MAX_FILE_BYTES / (1024 * 1024)} MB, so the preview could not read it (pi itself still reads it)`)
        return { kind: 'none' }
      }
      throw readError
    }
  }
  for (let round = 0; ; round++) {
    const missing = new Set<string>()
    const look = (p: string): Entry | undefined => {
      const hit = entries.get(p)
      if (!hit) missing.add(p)
      return hit
    }
    const reader: ClaudeCodeReader = {
      readText: (p) => { const e = look(p); return e?.kind === 'file' ? e.text : undefined },
      isDir: (p) => look(p)?.kind === 'dir',
      isFile: (p) => look(p)?.kind === 'file',
      listDir: (p) => { const e = look(p); return e?.kind === 'dir' ? e.names : [] },
      realpath: (p) => p,
    }
    const value = compute(reader)
    if (missing.size === 0) return { value, entries, unreadable }
    if (round >= MAX_READ_ROUNDS) {
      unreadable.push(`the preview stopped after ${MAX_READ_ROUNDS} rounds of reads; some nested files may be missing from it`)
      return { value, entries, unreadable }
    }
    const fetched = await Promise.all([...missing].map(async (p) => [p, await fetchOne(p)] as const))
    for (const [p, e] of fetched) entries.set(p, e)
  }
}

// ── What pi should start with ──

const EFFORTS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
const MODEL_ALIASES: Record<string, string> = {
  opus: 'ANTHROPIC_DEFAULT_OPUS_MODEL', opusplan: 'ANTHROPIC_DEFAULT_OPUS_MODEL', best: 'ANTHROPIC_DEFAULT_OPUS_MODEL',
  sonnet: 'ANTHROPIC_DEFAULT_SONNET_MODEL', haiku: 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
}

/** Claude Code's `[1m]` marks its 1M-context variant; pi's catalog id is the plain one. */
function piModelId(raw: string): string {
  return raw.trim().replace(/\[1m\]$/i, '')
}

export interface PiStartChoice {
  provider?: string
  model?: string
  thinking?: string
  /** Claude Code's gateway, which `provider` then names (PI_GATEWAY_PROVIDER). */
  gateway?: PiGateway
  notes: string[]
}

/** The provider, model and thinking level pi should start with, from Claude Code's own choice. */
export function piStartFromClaudeCode(files: ClaudeCodeFiles, processEnv: Record<string, string | undefined>): PiStartChoice {
  const ccEnv: Record<string, string> = {}
  for (const [k, v] of Object.entries((files.settings?.env as Record<string, unknown> | undefined) ?? {})) if (typeof v === 'string') ccEnv[k] = v
  const env = (key: string): string | undefined => ccEnv[key] || processEnv[key] || undefined
  const notes: string[] = []
  const bedrock = claudeCodeEnv(files, {}).bedrock || /^(1|true)$/i.test(processEnv.CLAUDE_CODE_USE_BEDROCK ?? '')
  const rawModel = (typeof files.settings?.model === 'string' ? files.settings.model : undefined) || env('ANTHROPIC_MODEL')
  let resolved: string | undefined
  if (rawModel) {
    const alias = MODEL_ALIASES[piModelId(rawModel).toLowerCase()]
    resolved = alias ? env(alias) : rawModel
  }
  let model = resolved ? piModelId(resolved) : undefined
  // A gateway Claude Code names is where pi goes too, never the cloud provider behind it.
  const { gateway, note } = piGatewayFromClaudeCode(env, bedrock, resolved)
  if (note) notes.push(note)
  const gatewayUnusable = note !== undefined
  const provider = gateway ? PI_GATEWAY_PROVIDER : gatewayUnusable ? undefined : bedrock ? 'amazon-bedrock' : 'anthropic'
  if (gateway && !model) model = gateway.defaultModel
  if (rawModel && !resolved && !model) notes.push(`Claude Code uses the "${rawModel}" alias with no model id behind it here, so pi keeps its own default model.`)
  let thinking: string | undefined
  const effort = typeof files.settings?.effortLevel === 'string' ? files.settings.effortLevel : undefined
  if (files.settings?.alwaysThinkingEnabled === false) thinking = 'off'
  else if (effort && EFFORTS.has(effort)) thinking = effort
  return { ...(provider ? { provider } : {}), ...(model ? { model } : {}), ...(thinking ? { thinking } : {}), ...(gateway ? { gateway } : {}), notes }
}

// ── Preview ──

function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((n) => Number.parseInt(n, 10) || 0)
  const pb = b.split(/[.-]/).map((n) => Number.parseInt(n, 10) || 0)
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0)
  return 0
}

export function piInstallFrom(availability: { installed: boolean; version: string | null } | null): PiInstall {
  const version = availability?.version?.match(/\d+\.\d+\.\d+/)?.[0] ?? null
  return {
    installed: availability?.installed === true,
    version,
    needsUpdateForMcp: version !== null && compareVersions(version, PI_MCP_MIN_VERSION) < 0,
  }
}

/** pi's agent folder on the host: PI_CODING_AGENT_DIR when this machine's env names one. */
export function piAgentDir(env: Readonly<Record<string, string | undefined>> | undefined): string {
  return env?.PI_CODING_AGENT_DIR?.trim() || '~/.pi/agent'
}

function settingChanges(current: JsonObject, start: PiStartChoice): SettingChange[] {
  const want: Array<[string, unknown]> = []
  // A provider goes with its model: switching the provider under a model pi keeps from
  // another provider would start every session on a pair that does not exist.
  const providerFits = start.model !== undefined || current.defaultModel === undefined || current.defaultProvider === start.provider
  if (start.provider && providerFits) want.push(['defaultProvider', start.provider])
  if (start.model) want.push(['defaultModel', start.model])
  if (start.thinking) want.push(['defaultThinkingLevel', start.thinking])
  // pi-acp prints pi's startup banner into the chat unless this is set.
  if (current.quietStartup === undefined) want.push(['quietStartup', true])
  return want.filter(([key, to]) => current[key] !== to).map(([key, to]) => ({ key, from: current[key], to }))
}

function pluginCount(entries: Map<string, Entry>, dir: string): number | undefined {
  const e = entries.get(dir)
  return e?.kind === 'dir' ? e.names.filter((n) => !n.startsWith('.')).length : undefined
}

/**
 * What an import on this host will bring and what it cannot. `home` is the host's home
 * as its daemon expands it ('~' for another host).
 */
export async function previewClaudeCodeImport(
  host: string,
  transport: ImportTransport,
  pi: PiInstall,
  home = '~',
): Promise<ImportPreview> {
  return (await buildPreview(host, transport, pi, home)).preview
}

async function buildPreview(
  host: string,
  transport: ImportTransport,
  pi: PiInstall,
  home: string,
): Promise<{ preview: ImportPreview; start: PiStartChoice }> {
  const env = transport.env ?? {}
  const agentDir = piAgentDir(transport.env)
  const extensionPath = path.posix.join(agentDir, 'extensions', EXTENSION_FILE_NAME)
  const settingsPath = path.posix.join(agentDir, 'settings.json')
  const modelsPath = path.posix.join(agentDir, 'models.json')
  const ccPaths = claudePaths(home, env)
  const { value, entries, unreadable: unread } = await withHostReader(transport, (reader) => {
    const files = loadClaudeCodeFiles(reader, home, env)
    const mcp = claudeCodeMcpServers(reader, files)
    const dirs = claudeCodeResourceDirs(reader, files)
    const plugins = enabledPlugins(reader, files)
    // Asked here so the same pass fetches them: counts and what cannot carry over.
    for (const plugin of plugins) {
      reader.isDir(path.posix.join(plugin.installPath, 'agents'))
      reader.isFile(path.posix.join(plugin.installPath, 'hooks', 'hooks.json'))
    }
    for (const d of [...dirs.skills, ...dirs.prompts]) reader.isDir(d.path)
    const claudeMd = path.posix.join(files.claudeDir, 'CLAUDE.md')
    const agentsDir = path.posix.join(files.claudeDir, 'agents')
    const rulesDir = path.posix.join(files.claudeDir, 'rules')
    return {
      files, mcp, dirs, plugins,
      claudeMd: reader.isFile(claudeMd) ? claudeMd : undefined,
      rules: { dir: rulesDir, files: ruleFiles(reader, rulesDir) },
      userAgents: reader.isDir(agentsDir) ? agentsDir : undefined,
      piSettings: reader.readText(settingsPath),
      piModels: reader.readText(modelsPath),
      extension: reader.readText(extensionPath),
    }
  })
  const { files, mcp, dirs, plugins } = value

  let current: JsonObject = {}
  let unreadable: string | undefined
  try { current = value.piSettings ? parseJsonObject(value.piSettings, settingsPath) : {} } catch (err) {
    unreadable = err instanceof Error ? err.message : String(err)
  }
  const start = piStartFromClaudeCode(files, env)
  const changes = unreadable ? [] : settingChanges(current, start)
  let gateway: ImportPreview['gateway'] = null
  if (start.gateway) {
    let change: 'add' | 'update' | 'none' = 'none'
    let modelsUnreadable: string | undefined
    try { change = gatewayChange(value.piModels, start.gateway, modelsPath) } catch (err) {
      modelsUnreadable = err instanceof Error ? err.message : String(err)
    }
    gateway = {
      path: modelsPath, provider: PI_GATEWAY_PROVIDER, from: start.gateway.from, api: start.gateway.api,
      baseUrl: start.gateway.baseUrl, modelIds: start.gateway.models.map((m) => m.id), change,
      ...(modelsUnreadable ? { unreadable: modelsUnreadable } : {}),
    }
  }

  const shipped = readExtensionSource()
  const extensionState: ImportPreview['extension']['state'] = value.extension === undefined
    ? 'absent'
    : value.extension === shipped ? 'current' : extensionVersionOf(value.extension) === null ? 'foreign' : 'outdated'

  const envPlan = claudeCodeEnv(files, {})
  const vars = Object.keys(envPlan.set).map((name) => (isSecretEnvKey(name) ? { name } : { name, value: envPlan.set[name] }))
  const gw = start.gateway
  const viaGateway = gw ? ` through your gateway at ${gw.baseUrl}, the address Claude Code uses (${gw.from})` : ''
  const gatewayKey = !gw ? ''
    : gw.keyFrom === 'variable' ? ` The gateway gets the ${gw.apiKey.slice(1)} that Claude Code sends it.`
      : gw.keyFrom === 'skip-auth' ? ' Claude Code signs nothing for the gateway (CLAUDE_CODE_SKIP_BEDROCK_AUTH), and neither does pi.'
        : ' Claude Code sends the gateway no key, so pi sends it a placeholder.'
  // The same answer the start choice gave (it also reads the host's own environment).
  const credentials: ImportPreview['credentials'] = envPlan.bedrock || start.provider === 'amazon-bedrock' || gw?.api === 'bedrock-converse-stream'
    ? { kind: 'bedrock', vars, note: (vars.length > 0
      ? `pi reaches Amazon Bedrock${viaGateway} with the region, endpoint and credentials in Claude Code's settings, read each time pi starts. Values marked secret are never copied or shown.`
      : `pi reaches Amazon Bedrock${viaGateway} with the AWS credentials already in its environment on this host, as Claude Code does.`) + gatewayKey }
    : vars.some((v) => v.name === 'ANTHROPIC_API_KEY' || v.name === 'ANTHROPIC_AUTH_TOKEN')
      ? { kind: 'anthropic-key', vars, note: `pi uses the Anthropic key in Claude Code's settings${viaGateway}, read each time pi starts.${gatewayKey}` }
      : gw
        ? { kind: 'none', vars, note: `pi reaches Claude${viaGateway}.${gatewayKey}` }
        : files.settings
          ? { kind: 'sign-in', vars, note: 'Claude Code signs in with your Claude account, which pi cannot borrow. Run pi once on this host and type /login, then pick Anthropic (Claude Pro/Max).' }
          : { kind: 'none', vars, note: 'No Claude Code settings were found on this host.' }

  const mcpServers = mcp.servers.map((s) => ({ name: s.name, detail: s.config.url ?? [s.config.command, ...(s.config.args ?? [])].join(' '), source: s.source }))
  const skippedMcpServers = mcp.skipped.map((s) => ({ name: s.name, detail: s.why, source: s.source }))
  const describeDir = (d: { path: string; source: string }, unit: string): ImportItem => {
    const n = pluginCount(entries, d.path)
    return { name: d.path, detail: n === undefined ? '' : `${n} ${unit}${n === 1 ? '' : 's'}`, source: d.source }
  }
  const instructions: ImportItem[] = []
  if (value.claudeMd) instructions.push({ name: value.claudeMd, detail: 'your instructions for every project, with the files its @path lines import', source: 'user' })
  if (value.rules.files.length) {
    const n = value.rules.files.length
    instructions.push({ name: value.rules.dir, detail: `${n} rule file${n === 1 ? '' : 's'} (a rule limited to certain paths is left out)`, source: 'user' })
  }
  instructions.push({ name: 'CLAUDE.local.md, .claude/CLAUDE.md, .claude/rules', detail: 'in the working folder and the folders above it, read when a session starts there', source: 'project' })

  const cannotCarry: CannotCarry[] = []
  const hookCount = Object.keys((files.settings?.hooks as Record<string, unknown> | undefined) ?? {}).length
    + plugins.filter((p) => entries.get(path.posix.join(p.installPath, 'hooks', 'hooks.json'))?.kind === 'file').length
  if (hookCount > 0) {
    cannotCarry.push({ what: 'Hooks', why: 'pi does not run Claude Code hook commands.', nearest: 'A pi extension can act on the same moments (before a tool runs, when a turn ends).' })
  }
  const agentSources = [value.userAgents, ...plugins.map((p) => path.posix.join(p.installPath, 'agents')).filter((p) => entries.get(p)?.kind === 'dir')].filter(Boolean)
  if (agentSources.length > 0) {
    cannotCarry.push({ what: 'Subagents', why: 'pi has no subagent (Task) tool, so Claude Code agent definitions are not loaded.', nearest: 'Hand a side job to its own Walnut task.' })
  }
  const permissions = files.settings?.permissions as Record<string, unknown> | undefined
  if (permissions && (permissions.defaultMode || (Array.isArray(permissions.deny) && permissions.deny.length) || (Array.isArray(permissions.ask) && permissions.ask.length))) {
    cannotCarry.push({ what: 'Permission mode and rules', why: 'pi runs every tool without asking, as Claude Code does in bypass permissions mode; allow, ask and deny rules do not apply.', nearest: 'Walnut still shows any question a pi extension asks as a permission prompt.' })
  }
  for (const [key, label] of [['apiKeyHelper', 'API key helper'], ['awsAuthRefresh', 'AWS sign-in refresh command'], ['awsCredentialExport', 'AWS credential export command']] as const) {
    if (files.settings?.[key]) cannotCarry.push({ what: label, why: `pi does not run Claude Code's ${key} command.`, nearest: 'Use an AWS profile with credential_process, or set the variables in your shell.' })
  }
  if (files.settings?.statusLine || files.settings?.outputStyle) {
    cannotCarry.push({ what: 'Status line and output style', why: 'These shape Claude Code\'s own terminal screen.', nearest: 'pi has themes and its own footer.' })
  }
  if (gw?.api === 'bedrock-converse-stream' && gw.keyFrom === 'none') {
    cannotCarry.push({ what: 'AWS request signing to the gateway', why: 'pi signs requests with AWS keys only for its built-in Amazon Bedrock provider, so it sends your gateway a placeholder bearer token instead.', nearest: 'Give Claude Code an AWS_BEARER_TOKEN_BEDROCK for the gateway, or CLAUDE_CODE_SKIP_BEDROCK_AUTH=1 when the gateway signs requests itself.' })
  }
  if (pi.needsUpdateForMcp) {
    cannotCarry.push({ what: 'MCP servers (this pi version)', why: `pi ${pi.version} is older than ${PI_MCP_MIN_VERSION}, the first release with MCP.`, nearest: `Update pi on this host: ${PI_UPDATE_COMMAND}` })
  }
  for (const note of start.notes) cannotCarry.push({ what: 'Model', why: note, nearest: 'Pick a model in a pi session or in pi\'s settings.' })

  const preview: ImportPreview = {
    host,
    pi,
    claudeCode: { found: files.settings !== undefined || files.globalConfig !== undefined, settingsPath: path.posix.join(ccPaths.dir, 'settings.json') },
    agentDir,
    extension: { path: extensionPath, state: extensionState, version: WALNUT_CLAUDE_CODE_EXTENSION_VERSION },
    settings: { path: settingsPath, changes, ...(unreadable ? { unreadable } : {}) },
    gateway,
    credentials,
    mcpServers,
    skippedMcpServers,
    skills: dirs.skills.map((d) => describeDir(d, 'skill')),
    commands: dirs.prompts.map((d) => describeDir(d, 'command')),
    instructions,
    cannotCarry,
    warnings: unread,
    upToDate: extensionState === 'current' && changes.length === 0 && !unreadable && (gateway === null || (gateway.change === 'none' && !gateway.unreadable)),
  }
  return { preview, start }
}

// ── Apply ──

export class ClaudeCodeImportError extends Error {
  constructor(message: string, readonly status: number) { super(message) }
}

async function guardedWrite(transport: ImportTransport, p: string, edit: (current: string | null) => string | null): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const bytes = await transport.readBytes(p, MAX_FILE_BYTES)
    const current = bytes === null ? null : utf8(bytes)
    const next = edit(current)
    if (next === null || next === current) return false
    try {
      await transport.writeAtomic(p, next, bytes === null ? 'absent' : sha256(bytes))
      return true
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (!/EMODIFIED/.test(message) || attempt === 1) throw err
    }
  }
  return false
}

/**
 * Write the extension and pi's start settings on the host. A foreign file at the
 * extension's path (not Walnut's) and an unreadable settings.json are refused: Walnut
 * never writes over bytes it did not make or could not read.
 */
export async function applyClaudeCodeImport(
  host: string,
  transport: ImportTransport,
  pi: PiInstall,
  home = '~',
): Promise<ImportResult> {
  const { preview: before, start } = await buildPreview(host, transport, pi, home)
  if (before.extension.state === 'foreign') {
    throw new ClaudeCodeImportError(`${before.extension.path} exists and was not written by Walnut; move it away and import again.`, 409)
  }
  if (before.settings.unreadable) {
    throw new ClaudeCodeImportError(`${before.settings.path} could not be read (${before.settings.unreadable}); fix it and import again.`, 409)
  }
  if (before.gateway?.unreadable) {
    throw new ClaudeCodeImportError(`${before.gateway.path} could not be read (${before.gateway.unreadable}); fix it and import again.`, 409)
  }
  const written: string[] = []
  const source = readExtensionSource()
  if (await guardedWrite(transport, before.extension.path, (current) => {
    if (current !== null && extensionVersionOf(current) === null) throw new ClaudeCodeImportError(`${before.extension.path} was replaced by another file meanwhile.`, 409)
    return source
  })) written.push(before.extension.path)
  // The gateway entry goes in before settings.json names it as pi's default provider.
  const planned = before.gateway
  const gateway = start.gateway
  if (planned && gateway && planned.change !== 'none' && await guardedWrite(transport, planned.path, (current) => withGatewayEntry(current, gateway, planned.path))) {
    written.push(planned.path)
  }
  const changes = before.settings.changes
  if (changes.length > 0 && await guardedWrite(transport, before.settings.path, (current) => {
    // Only the keys the preview named change; everything else in the file stays as it is.
    const next: JsonObject = { ...(current ? parseJsonObject(current, before.settings.path) : {}) }
    for (const change of changes) next[change.key] = change.to
    return serializeJsonObject(next, current ?? undefined) + (current === null ? '\n' : '')
  })) written.push(before.settings.path)
  return { written, preview: await previewClaudeCodeImport(host, transport, pi, home) }
}
