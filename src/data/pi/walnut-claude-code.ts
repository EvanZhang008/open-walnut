/**
 * walnut-claude-code: a pi extension that gives pi the setup the user already has in
 * Claude Code, read live from Claude Code's own files every time pi starts.
 *
 * Installed by Walnut's "Import from Claude Code" (src/core/agents/claude-code-import.ts)
 * as ~/.pi/agent/extensions/walnut-claude-code.ts on the host where pi runs. It changes
 * nothing in Claude Code's files. What it does:
 *
 *   - credentials: the provider variables in ~/.claude/settings.json `env` (AWS region,
 *     profile, keys, bearer token, the Bedrock endpoint, an Anthropic key or auth token),
 *     only where the process does not already set them (Walnut's gateway provider in pi's
 *     models.json names its key as one of these variables);
 *   - MCP servers: the user's servers in ~/.claude.json, the project's own and approved
 *     .mcp.json servers, and the servers of every enabled Claude Code plugin;
 *   - skills and slash commands: ~/.claude/skills, ~/.claude/commands, the project's
 *     .claude/skills and .claude/commands, and every enabled plugin's;
 *   - instructions: ~/.claude/CLAUDE.md, CLAUDE.local.md and .claude/CLAUDE.md files, a
 *     CLAUDE.md that pi skipped because an AGENTS.md sat beside it, and the files their
 *     `@path` lines import;
 *   - models: through Claude Code's Bedrock gateway, pi makes Claude Code's own call (invoke
 *     with an Anthropic Messages body) instead of Converse, which a gateway may not serve
 *     (WALNUT_PI_BEDROCK_INVOKE=0 keeps Converse).
 *
 * Set WALNUT_PI_CLAUDE_CODE=0 to turn it off for one run. Node builtins only: pi loads
 * this file as it is, on any machine. The exported functions are pure (they take a
 * reader), so Walnut runs the same code to show what an import will bring. The Bedrock call uses
 * the AWS SDK pi itself ships and pi's own Anthropic stream, both loaded only inside pi.
 */

import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export const WALNUT_CLAUDE_CODE_EXTENSION_VERSION = 3

// ── Reading files ────────────────────────────────────────────────────────────

/** The few file questions the collectors ask; the extension answers from disk, Walnut from a host. */
export interface ClaudeCodeReader {
  readText(p: string): string | undefined
  isDir(p: string): boolean
  isFile(p: string): boolean
  /** The folder's entry names, [] when it is not a folder. */
  listDir(p: string): string[]
  /** The path with symlinks resolved, or the path itself when that is unknown. */
  realpath(p: string): string
}

export const diskReader: ClaudeCodeReader = {
  readText(p) {
    try { return fs.readFileSync(p, 'utf8') } catch { return undefined }
  },
  isDir(p) {
    try { return fs.statSync(p).isDirectory() } catch { return false }
  },
  isFile(p) {
    try { return fs.statSync(p).isFile() } catch { return false }
  },
  listDir(p) {
    try { return fs.readdirSync(p) } catch { return [] }
  },
  realpath(p) {
    try { return fs.realpathSync(p) } catch { return p }
  },
}

type Json = Record<string, unknown>

function asObject(value: unknown): Json | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Json : undefined
}

export function readJson(reader: ClaudeCodeReader, p: string): Json | undefined {
  const text = reader.readText(p)
  if (text === undefined) return undefined
  try { return asObject(JSON.parse(text.replace(/^﻿/, ''))) } catch { return undefined }
}

/** Where Claude Code keeps its files (CLAUDE_CONFIG_DIR moves both). */
export function claudePaths(home: string, env: Record<string, string | undefined>): { dir: string; globalConfig: string } {
  const configured = env.CLAUDE_CONFIG_DIR?.trim()
  if (configured) return { dir: configured, globalConfig: path.join(configured, '.claude.json') }
  return { dir: path.join(home, '.claude'), globalConfig: path.join(home, '.claude.json') }
}

export interface ClaudeCodeFiles {
  home: string
  claudeDir: string
  /** ~/.claude/settings.json */
  settings: Json | undefined
  /** ~/.claude.json */
  globalConfig: Json | undefined
  /** ~/.claude/plugins/installed_plugins.json */
  installedPlugins: Json | undefined
}

export function loadClaudeCodeFiles(reader: ClaudeCodeReader, home: string, env: Record<string, string | undefined>): ClaudeCodeFiles {
  const { dir, globalConfig } = claudePaths(home, env)
  return {
    home,
    claudeDir: dir,
    settings: readJson(reader, path.join(dir, 'settings.json')),
    globalConfig: readJson(reader, globalConfig),
    installedPlugins: readJson(reader, path.join(dir, 'plugins', 'installed_plugins.json')),
  }
}

function settingsEnv(files: ClaudeCodeFiles): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(asObject(files.settings?.env) ?? {})) {
    if (typeof value === 'string') out[key] = value
  }
  return out
}

function truthy(value: string | undefined): boolean {
  return value !== undefined && /^(1|true|yes|on)$/i.test(value.trim())
}

function isWithin(child: string, parent: string): boolean {
  const rel = path.relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

// ── Credentials ──────────────────────────────────────────────────────────────

/** Provider variables copied from Claude Code's settings `env` as they are. */
const COPIED_ENV_KEYS = [
  'AWS_REGION', 'AWS_DEFAULT_REGION', 'AWS_PROFILE', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN', 'AWS_BEARER_TOKEN_BEDROCK', 'AWS_CONFIG_FILE', 'AWS_SHARED_CREDENTIALS_FILE',
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy',
  'NODE_EXTRA_CA_CERTS',
] as const

/** Values that are secrets: shown by name only, never by value. */
const SECRET_ENV_KEYS = new Set(['AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_BEARER_TOKEN_BEDROCK', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'AWS_ACCESS_KEY_ID'])

export function isSecretEnvKey(key: string): boolean {
  return SECRET_ENV_KEYS.has(key)
}

export interface ClaudeCodeEnvPlan {
  /** Whether Claude Code talks to Amazon Bedrock (CLAUDE_CODE_USE_BEDROCK). */
  bedrock: boolean
  /** Variables to set, each only where the process has no value of its own. */
  set: Record<string, string>
  /** Variables to remove: an empty AWS_BEARER_TOKEN_BEDROCK makes the AWS SDK refuse to sign. */
  unset: string[]
  /**
   * Claude Code's Bedrock gateway (ANTHROPIC_BEDROCK_BASE_URL) when pi's Bedrock endpoint is it:
   * pi then calls it the way Claude Code does (bedrockInvokeFetch below).
   */
  gateway?: string
}

/**
 * The environment pi needs to reach the model Claude Code reaches. `processEnv` is pi's
 * own environment: a value set there always wins, so a variable Walnut or the user's
 * shell sets is never replaced. Claude Code's Bedrock names map onto the AWS SDK's:
 * ANTHROPIC_BEDROCK_BASE_URL is the runtime endpoint (a plain-http proxy also needs
 * HTTP/1.1), CLAUDE_CODE_SKIP_BEDROCK_AUTH is AWS_BEDROCK_SKIP_AUTH.
 */
export function claudeCodeEnv(files: ClaudeCodeFiles, processEnv: Record<string, string | undefined>): ClaudeCodeEnvPlan {
  const cc = settingsEnv(files)
  const has = (key: string): boolean => (processEnv[key] ?? '') !== ''
  const set: Record<string, string> = {}
  const fill = (key: string, value: string | undefined): void => {
    if (value === undefined || value === '' || has(key)) return
    set[key] = value
  }
  const bedrock = truthy(cc.CLAUDE_CODE_USE_BEDROCK ?? processEnv.CLAUDE_CODE_USE_BEDROCK)
  for (const key of COPIED_ENV_KEYS) {
    if (!bedrock && key.startsWith('AWS_')) continue
    fill(key, cc[key])
  }
  if (bedrock) {
    const endpoint = cc.ANTHROPIC_BEDROCK_BASE_URL ?? processEnv.ANTHROPIC_BEDROCK_BASE_URL
    fill('AWS_ENDPOINT_URL_BEDROCK_RUNTIME', endpoint)
    if (endpoint && /^http:\/\//i.test(endpoint.trim())) fill('AWS_BEDROCK_FORCE_HTTP1', '1')
    if (truthy(cc.CLAUDE_CODE_SKIP_BEDROCK_AUTH ?? processEnv.CLAUDE_CODE_SKIP_BEDROCK_AUTH)) fill('AWS_BEDROCK_SKIP_AUTH', '1')
  }
  const unset: string[] = []
  if (processEnv.AWS_BEARER_TOKEN_BEDROCK === '' && set.AWS_BEARER_TOKEN_BEDROCK === undefined) unset.push('AWS_BEARER_TOKEN_BEDROCK')
  const plan: ClaudeCodeEnvPlan = { bedrock, set, unset }
  const ccEndpoint = trimUrl(cc.ANTHROPIC_BEDROCK_BASE_URL ?? processEnv.ANTHROPIC_BEDROCK_BASE_URL)
  if (bedrock && ccEndpoint && trimUrl(processEnv.AWS_ENDPOINT_URL_BEDROCK_RUNTIME || set.AWS_ENDPOINT_URL_BEDROCK_RUNTIME) === ccEndpoint) {
    plan.gateway = ccEndpoint
  }
  return plan
}

function trimUrl(url: string | undefined): string | undefined {
  return url?.trim().replace(/\/+$/, '') || undefined
}

/**
 * The headers Claude Code sends its gateway: ANTHROPIC_CUSTOM_HEADERS lines ("Name: value"),
 * Claude Code's settings first, then pi's own environment (where Walnut puts its request tag).
 */
export function gatewayHeaders(files: ClaudeCodeFiles, processEnv: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const text of [settingsEnv(files).ANTHROPIC_CUSTOM_HEADERS, processEnv.ANTHROPIC_CUSTOM_HEADERS]) {
    for (const line of (text ?? '').split(/\r?\n/)) {
      const at = line.indexOf(':')
      const name = at > 0 ? line.slice(0, at).trim().toLowerCase() : ''
      if (name) out[name] = line.slice(at + 1).trim()
    }
  }
  return out
}

// ── Plugins ──────────────────────────────────────────────────────────────────

export interface ClaudeCodePlugin {
  /** `<plugin>@<marketplace>` */
  key: string
  name: string
  installPath: string
}

/**
 * The plugins Claude Code would load in `cwd`: installed, switched on in enabledPlugins,
 * and installed for the user or for a project that contains `cwd`. A plugin installed
 * both ways uses the user's copy, the one Claude Code updates everywhere.
 */
export function enabledPlugins(reader: ClaudeCodeReader, files: ClaudeCodeFiles, cwd?: string): ClaudeCodePlugin[] {
  const enabled = asObject(files.settings?.enabledPlugins) ?? {}
  const installed = asObject(files.installedPlugins?.plugins) ?? {}
  const realCwd = cwd ? reader.realpath(cwd) : undefined
  const out: ClaudeCodePlugin[] = []
  for (const [key, entries] of Object.entries(installed)) {
    if (enabled[key] !== true || !Array.isArray(entries)) continue
    let user: string | undefined
    let project: string | undefined
    for (const raw of entries) {
      const entry = asObject(raw)
      const installPath = typeof entry?.installPath === 'string' ? entry.installPath : undefined
      if (!entry || !installPath) continue
      if (entry.scope === 'project' || entry.scope === 'local') {
        const projectPath = typeof entry.projectPath === 'string' ? entry.projectPath : undefined
        if (realCwd && projectPath && isWithin(realCwd, reader.realpath(projectPath))) project = installPath
      } else {
        user = installPath
      }
    }
    const installPath = user ?? project
    if (installPath) out.push({ key, name: key.split('@')[0] || key, installPath })
  }
  return out
}

// ── MCP servers ──────────────────────────────────────────────────────────────

/** pi's mcp.json entry shape (stdio or streamable HTTP). */
export interface PiMcpServerConfig {
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  url?: string
  headers?: Record<string, string>
  exposure?: 'codemode' | 'deferred' | 'direct' | 'hidden'
  timeout?: number
}

export type McpSource = 'user' | 'local' | 'project' | `plugin:${string}`

export interface ImportedMcpServer {
  name: string
  config: PiMcpServerConfig
  source: McpSource
}

export interface SkippedMcpServer {
  name: string
  source: McpSource
  why: string
}

const PI_SERVER_NAME = /^[A-Za-z0-9_-]+$/

function stringRecord(value: unknown): Record<string, string> | undefined {
  const obj = asObject(value)
  if (!obj) return undefined
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(obj)) if (typeof v === 'string') out[k] = v
  return Object.keys(out).length ? out : undefined
}

/** One Claude Code server entry as pi's, or the reason pi cannot run it. */
export function toPiMcpServer(raw: unknown, pluginRoot?: string): PiMcpServerConfig | { skip: string } {
  const entry = asObject(raw)
  if (!entry) return { skip: 'not a server entry' }
  const sub = (value: string): string => pluginRoot ? value.split('${CLAUDE_PLUGIN_ROOT}').join(pluginRoot) : value
  const type = typeof entry.type === 'string' ? entry.type : undefined
  if (type === 'sse') return { skip: 'uses the SSE transport, which pi does not support (only stdio and streamable HTTP)' }
  if (type && type !== 'stdio' && type !== 'http' && type !== 'streamable-http') return { skip: `uses the "${type}" transport, which pi does not support` }
  if (entry.headersHelper !== undefined) return { skip: 'gets its headers from a headersHelper command, which pi does not run' }
  const config: PiMcpServerConfig = { exposure: 'deferred' }
  if (typeof entry.url === 'string' && entry.url) {
    config.url = sub(entry.url)
    const headers = stringRecord(entry.headers)
    if (headers) config.headers = headers
  } else if (typeof entry.command === 'string' && entry.command) {
    config.command = sub(entry.command)
    if (Array.isArray(entry.args)) config.args = entry.args.filter((a): a is string => typeof a === 'string').map(sub)
    const env = stringRecord(entry.env)
    if (env) config.env = Object.fromEntries(Object.entries(env).map(([k, v]) => [k, sub(v)]))
    if (typeof entry.cwd === 'string' && entry.cwd) config.cwd = sub(entry.cwd)
  } else {
    return { skip: 'has neither a command nor a url' }
  }
  return config
}

function sameServer(a: PiMcpServerConfig, b: PiMcpServerConfig): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** The nearest directory at or above `cwd` that holds `.git`, or undefined. */
function gitRoot(reader: ClaudeCodeReader, cwd: string): string | undefined {
  for (let dir = cwd; ; dir = path.dirname(dir)) {
    if (reader.isDir(path.join(dir, '.git')) || reader.isFile(path.join(dir, '.git'))) return dir
    if (path.dirname(dir) === dir) return undefined
  }
}

/** `cwd` and its ancestors up to the repository root (or `cwd` alone outside a repository). */
function projectDirs(reader: ClaudeCodeReader, cwd: string): string[] {
  const root = gitRoot(reader, cwd) ?? cwd
  const dirs: string[] = []
  for (let dir = cwd; ; dir = path.dirname(dir)) {
    dirs.push(dir)
    if (dir === root || path.dirname(dir) === dir) break
  }
  return dirs
}

/** ~/.claude.json keeps per-project state under the project's path; the nearest one at or above cwd. */
function projectState(files: ClaudeCodeFiles, cwd: string | undefined): Json | undefined {
  const projects = asObject(files.globalConfig?.projects)
  if (!projects || !cwd) return undefined
  for (let dir = cwd; ; dir = path.dirname(dir)) {
    const state = asObject(projects[dir])
    if (state) return state
    if (path.dirname(dir) === dir) return undefined
  }
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

/**
 * The MCP servers Claude Code would start in `cwd`, as pi entries. Claude Code's order of
 * precedence for one name: local (this project, ~/.claude.json), project (.mcp.json, when
 * approved), user (~/.claude.json), then plugins. A plugin server whose name is taken by
 * a different server keeps both, the plugin's as `<name>_<plugin>`; an identical one is
 * started once. Servers pi cannot run are listed with the reason.
 */
export function claudeCodeMcpServers(
  reader: ClaudeCodeReader,
  files: ClaudeCodeFiles,
  cwd?: string,
): { servers: ImportedMcpServer[]; skipped: SkippedMcpServer[] } {
  const servers: ImportedMcpServer[] = []
  const skipped: SkippedMcpServer[] = []
  const project = projectState(files, cwd)
  const denied = new Set<string>([
    ...stringList(project?.disabledMcpServers),
    ...((Array.isArray(files.settings?.deniedMcpServers) ? files.settings!.deniedMcpServers as unknown[] : [])
      .map((d) => (typeof d === 'string' ? d : typeof asObject(d)?.serverName === 'string' ? asObject(d)!.serverName as string : undefined))
      .filter((d): d is string => !!d)),
  ])
  const add = (name: string, raw: unknown, source: McpSource, pluginRoot?: string, pluginName?: string): void => {
    if (denied.has(name)) { skipped.push({ name, source, why: 'is turned off in Claude Code' }); return }
    const config = toPiMcpServer(raw, pluginRoot)
    if ('skip' in config) { skipped.push({ name, source, why: config.skip }); return }
    let finalName = name
    const taken = servers.find((s) => s.name === name)
    if (taken) {
      if (sameServer(taken.config, config)) return
      if (!pluginName) return // a higher-precedence entry of the same name wins, as in Claude Code
      finalName = `${name}_${pluginName}`.replace(/[^A-Za-z0-9_-]/g, '_')
      if (servers.some((s) => s.name === finalName)) return
    }
    if (!PI_SERVER_NAME.test(finalName)) { skipped.push({ name, source, why: 'has a name pi does not accept (letters, digits, - and _ only)' }); return }
    servers.push({ name: finalName, config, source })
  }
  for (const [name, raw] of Object.entries(asObject(project?.mcpServers) ?? {})) add(name, raw, 'local')
  if (cwd) {
    const approveAll = files.settings?.enableAllProjectMcpServers === true || project?.enableAllProjectMcpServers === true
    const approved = new Set([...stringList(files.settings?.enabledMcpjsonServers), ...stringList(project?.enabledMcpjsonServers)])
    const refused = new Set([...stringList(files.settings?.disabledMcpjsonServers), ...stringList(project?.disabledMcpjsonServers)])
    for (const dir of projectDirs(reader, cwd)) {
      const mcp = asObject(readJson(reader, path.join(dir, '.mcp.json'))?.mcpServers)
      for (const [name, raw] of Object.entries(mcp ?? {})) {
        if (refused.has(name) || (!approveAll && !approved.has(name))) {
          skipped.push({ name, source: 'project', why: 'is in the project .mcp.json but not approved in Claude Code' })
          continue
        }
        add(name, raw, 'project')
      }
    }
  }
  for (const [name, raw] of Object.entries(asObject(files.globalConfig?.mcpServers) ?? {})) add(name, raw, 'user')
  for (const [name, raw] of Object.entries(asObject(files.settings?.mcpServers) ?? {})) add(name, raw, 'user')
  for (const plugin of enabledPlugins(reader, files, cwd)) {
    const source: McpSource = `plugin:${plugin.name}`
    const fromFile = asObject(readJson(reader, path.join(plugin.installPath, '.mcp.json'))?.mcpServers)
    const manifest = readJson(reader, path.join(plugin.installPath, '.claude-plugin', 'plugin.json'))
    const inline = asObject(manifest?.mcpServers)
    const referenced = typeof manifest?.mcpServers === 'string'
      ? asObject(readJson(reader, path.resolve(plugin.installPath, manifest.mcpServers as string))?.mcpServers)
      : undefined
    for (const group of [fromFile, inline, referenced]) {
      for (const [name, raw] of Object.entries(group ?? {})) add(name, raw, source, plugin.installPath, plugin.name)
    }
  }
  return { servers, skipped }
}

// ── Skills and commands ──────────────────────────────────────────────────────

export interface ResourceDir {
  path: string
  source: 'user' | 'project' | `plugin:${string}`
}

/**
 * Skill and slash-command folders Claude Code reads that pi does not. ~/.claude/skills is
 * left out when pi already reads it as ~/.agents/skills (the same folder through a link),
 * since every skill would then load twice.
 */
export function claudeCodeResourceDirs(
  reader: ClaudeCodeReader,
  files: ClaudeCodeFiles,
  cwd?: string,
): { skills: ResourceDir[]; prompts: ResourceDir[] } {
  const skills: ResourceDir[] = []
  const prompts: ResourceDir[] = []
  const piReads = new Set([reader.realpath(path.join(files.home, '.agents', 'skills'))])
  const addSkill = (p: string, source: ResourceDir['source']): void => {
    if (!reader.isDir(p) || piReads.has(reader.realpath(p)) || skills.some((s) => s.path === p)) return
    skills.push({ path: p, source })
  }
  const addPrompt = (p: string, source: ResourceDir['source']): void => {
    if (!reader.isDir(p) || prompts.some((s) => s.path === p)) return
    prompts.push({ path: p, source })
  }
  addSkill(path.join(files.claudeDir, 'skills'), 'user')
  addPrompt(path.join(files.claudeDir, 'commands'), 'user')
  if (cwd) {
    for (const dir of projectDirs(reader, cwd)) {
      if (dir === files.home) continue
      addSkill(path.join(dir, '.claude', 'skills'), 'project')
      addPrompt(path.join(dir, '.claude', 'commands'), 'project')
    }
  }
  for (const plugin of enabledPlugins(reader, files, cwd)) {
    addSkill(path.join(plugin.installPath, 'skills'), `plugin:${plugin.name}`)
    addPrompt(path.join(plugin.installPath, 'commands'), `plugin:${plugin.name}`)
  }
  return { skills, prompts }
}

// ── Instructions ─────────────────────────────────────────────────────────────

export interface ContextFile {
  path: string
  content: string
}

/** Claude Code follows `@path` imports this deep. */
const MAX_IMPORT_DEPTH = 5
/** Total bytes this extension adds to the prompt, so a runaway import cannot swamp it. */
const MAX_CONTEXT_BYTES = 512 * 1024

/**
 * The files a memory file imports with `@path` (Claude Code's syntax): a path starting
 * `~/`, `/`, `./`, `../` or a name with a slash or a dot, outside code spans and fences,
 * that names an existing file. Relative paths resolve against the importing file.
 */
export function importedPaths(content: string, fromFile: string, home: string, reader: ClaudeCodeReader): string[] {
  const out: string[] = []
  let fenced = false
  for (const line of content.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; continue }
    if (fenced) continue
    const plain = line.replace(/`[^`]*`/g, '')
    for (const match of plain.matchAll(/(?:^|\s)@((?:~\/|\/|\.{1,2}\/)?[^\s@]+)/g)) {
      const raw = match[1].replace(/[),.;:]+$/, '')
      if (!raw.includes('/') && !raw.includes('.')) continue
      const resolved = raw.startsWith('~/')
        ? path.join(home, raw.slice(2))
        : path.isAbsolute(raw) ? raw : path.resolve(path.dirname(fromFile), raw)
      if (reader.isFile(resolved) && !out.includes(resolved)) out.push(resolved)
    }
  }
  return out
}

/**
 * The rule files of a `.claude/rules` folder, nested folders included, in name order.
 * A rule with `paths:` in its front matter applies only to matching files, which Claude
 * Code loads when it reads one; pi has no such moment, so those are left out.
 */
export function ruleFiles(reader: ClaudeCodeReader, dir: string, depth = 0): string[] {
  if (depth > 4 || !reader.isDir(dir)) return []
  const out: string[] = []
  for (const name of [...reader.listDir(dir)].sort()) {
    if (name.startsWith('.')) continue
    const p = path.join(dir, name)
    if (name.endsWith('.md') && reader.isFile(p)) {
      const text = reader.readText(p) ?? ''
      const front = /^---\n([\s\S]*?)\n---/.exec(text)
      if (!front || !/^paths\s*:/m.test(front[1])) out.push(p)
    } else if (reader.isDir(p)) {
      out.push(...ruleFiles(reader, p, depth + 1))
    }
  }
  return out
}

/**
 * The instruction files Claude Code reads in `cwd` that pi does not, given the files pi
 * already loaded (`loaded`, by path). pi reads one AGENTS.md or CLAUDE.md per folder and
 * no imports; Claude Code also reads ~/.claude/CLAUDE.md, ~/.claude/rules, CLAUDE.local.md,
 * .claude/CLAUDE.md, a project's .claude/rules, and every `@path` import. A file whose
 * real path pi already loaded is never added twice.
 */
export function claudeCodeContextFiles(
  reader: ClaudeCodeReader,
  files: ClaudeCodeFiles,
  cwd: string,
  loaded: readonly ContextFile[],
): ContextFile[] {
  const seen = new Set(loaded.map((f) => reader.realpath(f.path)))
  // A copy is a duplicate too (an AGENTS.md kept as a copy of the CLAUDE.md beside it).
  const seenContent = new Set(loaded.map((f) => f.content.trim()))
  const out: ContextFile[] = []
  let bytes = 0
  const addFile = (p: string, depth: number): void => {
    const real = reader.realpath(p)
    if (seen.has(real)) return
    const content = reader.readText(p)
    if (content === undefined || !content.trim() || seenContent.has(content.trim())) return
    if (bytes + content.length > MAX_CONTEXT_BYTES) return
    seen.add(real)
    seenContent.add(content.trim())
    bytes += content.length
    out.push({ path: p, content })
    if (depth < MAX_IMPORT_DEPTH) for (const imported of importedPaths(content, p, files.home, reader)) addFile(imported, depth + 1)
  }
  addFile(path.join(files.claudeDir, 'CLAUDE.md'), 0)
  for (const rule of ruleFiles(reader, path.join(files.claudeDir, 'rules'))) addFile(rule, 0)
  // Outermost folder first, as Claude Code orders them.
  const dirs: string[] = []
  for (let dir = cwd; ; dir = path.dirname(dir)) {
    dirs.unshift(dir)
    if (path.dirname(dir) === dir) break
  }
  for (const dir of dirs) {
    for (const name of ['CLAUDE.md', path.join('.claude', 'CLAUDE.md'), 'CLAUDE.local.md']) {
      const p = path.join(dir, name)
      if (reader.isFile(p)) addFile(p, 0)
    }
    if (path.join(dir, '.claude') !== files.claudeDir) {
      for (const rule of ruleFiles(reader, path.join(dir, '.claude', 'rules'))) addFile(rule, 0)
    }
  }
  // pi loaded these as they are: add what they import.
  for (const file of loaded) {
    for (const imported of importedPaths(file.content, file.path, files.home, reader)) addFile(imported, 1)
  }
  return out
}

// ── Bedrock the way Claude Code calls it ────────────────────────────────────
//
// pi's Bedrock client calls ConverseStream. Claude Code calls InvokeModelWithResponseStream with
// an Anthropic Messages body, so a gateway set up for Claude Code may serve only that call
// (2026-11-21: a local relay answered every pi turn with "serves invoke,
// invoke-with-response-stream and count-tokens, not converse-stream"; a GPT model Claude Code
// offers through it rides the same call). Through that gateway pi sends Claude Code's call:
// pi's own Anthropic Messages stream (message conversion, tools, usage, cancellation), with a
// fetch that carries each request to Bedrock and turns Bedrock's event stream back into SSE.

/** One Bedrock invoke: the response JSON, or the Anthropic stream events. */
export type BedrockInvoke = (
  modelId: string, body: Json, stream: boolean, signal?: AbortSignal,
) => Promise<{ json: Json } | { events: AsyncIterable<Json> }>

/** The Bedrock invoke request for an Anthropic Messages request body and its anthropic-beta header. */
export function bedrockInvokeRequest(request: Json, beta: string | null): { modelId: string; stream: boolean; body: Json } {
  const { model, stream, ...rest } = request
  const betas = (beta ?? '').split(',').map((b) => b.trim()).filter(Boolean)
  return {
    modelId: String(model ?? ''),
    stream: stream === true,
    body: { anthropic_version: 'bedrock-2023-05-31', ...rest, ...(betas.length ? { anthropic_beta: betas } : {}) },
  }
}

function errorBody(error: unknown): { status: number; body: Json } {
  const record = asObject(error) ?? {}
  // No $metadata: it failed before any answer (credentials, a dropped connection): not a 5xx pi retries.
  const status = Number(asObject(record.$metadata)?.httpStatusCode) || 400
  const type = typeof record.name === 'string' && record.name !== 'Error' ? record.name : 'api_error'
  const message = error instanceof Error ? error.message : String(error)
  return { status, body: { type: 'error', error: { type, message } } }
}

/** A fetch for pi's Anthropic client that sends every request through `invoke`. */
export function bedrockInvokeFetch(invoke: BedrockInvoke): typeof fetch {
  return async (_input, init) => {
    const text = typeof init?.body === 'string' ? init.body : init?.body ? await new Response(init.body).text() : '{}'
    const { modelId, stream, body } = bedrockInvokeRequest(asObject(JSON.parse(text)) ?? {}, new Headers(init?.headers).get('anthropic-beta'))
    let result: Awaited<ReturnType<BedrockInvoke>>
    try {
      result = await invoke(modelId, body, stream, init?.signal ?? undefined)
    } catch (error) {
      if ((init?.signal as AbortSignal | undefined)?.aborted) throw error
      const failed = errorBody(error)
      return new Response(JSON.stringify(failed.body), { status: failed.status, headers: { 'content-type': 'application/json' } })
    }
    if ('json' in result) return new Response(JSON.stringify(result.json), { status: 200, headers: { 'content-type': 'application/json' } })
    const events = result.events
    const encoder = new TextEncoder()
    const sse = (event: Json): Uint8Array => encoder.encode(`event: ${String(event.type ?? 'message')}\ndata: ${JSON.stringify(event)}\n\n`)
    return new Response(new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          for await (const event of events) controller.enqueue(sse(event))
        } catch (error) {
          // A failure inside the stream reaches pi as Anthropic's own error event.
          if (!(init?.signal as AbortSignal | undefined)?.aborted) controller.enqueue(sse(errorBody(error).body))
        }
        controller.close()
      },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }
}

type ModuleRequire = ((id: string) => any) & { resolve(id: string): string }

/** Loads pi's own copies of packages (the AWS SDK pi's Bedrock client uses), or null when pi carries none. */
function piRequire(): ModuleRequire | null {
  try {
    const entry = process.argv[1] ? fs.realpathSync(process.argv[1]) : ''
    if (!entry) return null
    const require = createRequire(entry) as ModuleRequire
    require.resolve('@aws-sdk/client-bedrock-runtime')
    return require
  } catch {
    return null
  }
}

/** pi's request auth for one turn (pi's stored Bedrock key or profile), as its own Bedrock client reads it. */
export interface InvokeAuth { apiKey?: string; bearerToken?: string; profile?: string }

/**
 * The Bedrock client settings pi's own Bedrock client (pi-ai bedrock-converse-stream.js) takes from
 * the same variables: region (an inference-profile ARN's, else configured, else the profile's,
 * else us-east-1), signing off (AWS_BEDROCK_SKIP_AUTH), pi's key or AWS_BEARER_TOKEN_BEDROCK as a
 * bearer token, keys from the environment unless pi names a profile, HTTP/1.1. Pure: the request
 * handler (proxy, HTTP/1.1) is added by the caller.
 */
export function invokeClientConfig(endpoint: string, modelId: string, auth: InvokeAuth, env: Record<string, string | undefined>): Json {
  const value = (k: string): string | undefined => env[k] || undefined
  const profile = auth.profile || value('AWS_PROFILE')
  const config: Json = { endpoint, ...(profile ? { profile } : {}) }
  const arnRegion = /^arn:aws(?:-[a-z0-9-]+)?:bedrock:([a-z0-9-]+):/.exec(modelId)?.[1]
  const region = arnRegion || value('AWS_REGION') || value('AWS_DEFAULT_REGION')
  if (region) config.region = region
  else if (!value('AWS_PROFILE')) config.region = 'us-east-1'
  const skipAuth = value('AWS_BEDROCK_SKIP_AUTH') === '1'
  if (skipAuth) config.credentials = { accessKeyId: 'dummy-access-key', secretAccessKey: 'dummy-secret-key' }
  else if (value('AWS_ACCESS_KEY_ID') && value('AWS_SECRET_ACCESS_KEY') && !auth.profile) {
    config.credentials = { accessKeyId: value('AWS_ACCESS_KEY_ID'), secretAccessKey: value('AWS_SECRET_ACCESS_KEY'), ...(value('AWS_SESSION_TOKEN') ? { sessionToken: value('AWS_SESSION_TOKEN') } : {}) }
  }
  const bearer = auth.bearerToken || auth.apiKey || value('AWS_BEARER_TOKEN_BEDROCK')
  if (bearer && !skipAuth) {
    config.token = { token: bearer }
    config.authSchemePreference = ['httpBearerAuth']
  }
  return config
}

/** Whether a refusal says the gateway does not serve Converse at all (not that this request was bad). */
export function refusesConverse(error: unknown): boolean {
  const record = asObject(error) ?? {}
  const status = Number(asObject(record.$metadata)?.httpStatusCode)
  return record.name === 'UnknownOperationException' || status === 404 || status === 405
    || /not (?:serve|support)\w*.*converse|converse[\w-]* (?:is )?not (?:served|supported)/i.test(String(record.message ?? ''))
}

/**
 * Bedrock on the AWS SDK pi ships: invoke for a turn, and the one question of whether the gateway
 * serves Converse. Null when pi carries no SDK (pi's own client then keeps every turn).
 */
export function sdkBedrock(endpoint: string, headers: Record<string, string>, env: NodeJS.ProcessEnv = process.env): {
  invoke(auth: InvokeAuth): BedrockInvoke
  servesConverse(modelId: string, auth: InvokeAuth): Promise<boolean | undefined>
} | null {
  const req = piRequire()
  if (!req) return null
  const sdk = req('@aws-sdk/client-bedrock-runtime')
  const clients = new Map<string, any>()
  const clientFor = async (modelId: string, auth: InvokeAuth): Promise<any> => {
    const config = invokeClientConfig(endpoint, modelId, auth, env)
    const key = JSON.stringify(config)
    let client = clients.get(key)
    if (client) return client
    const handler = await requestHandler(req, endpoint, env)
    client = new sdk.BedrockRuntimeClient(handler ? { ...config, requestHandler: handler } : config)
    if (Object.keys(headers).length > 0) {
      client.middlewareStack.add((next: any) => async (args: any) => {
        if (args?.request?.headers) Object.assign(args.request.headers, headers)
        return next(args)
      }, { step: 'build', name: 'walnutClaudeCodeGatewayHeaders' })
    }
    clients.set(key, client)
    return client
  }
  const decoder = new TextDecoder()
  return {
    invoke: (auth) => async (modelId, body, stream, signal) => {
      const client = await clientFor(modelId, auth)
      const input = { modelId, body: new TextEncoder().encode(JSON.stringify(body)), contentType: 'application/json', accept: 'application/json' }
      if (!stream) {
        const out = await client.send(new sdk.InvokeModelCommand(input), { abortSignal: signal })
        return { json: JSON.parse(decoder.decode(out.body)) as Json }
      }
      const out = await client.send(new sdk.InvokeModelWithResponseStreamCommand(input), { abortSignal: signal })
      return {
        events: (async function* () {
          for await (const part of out.body as AsyncIterable<Json>) {
            const bytes = asObject(part.chunk)?.bytes
            if (bytes instanceof Uint8Array) { yield JSON.parse(decoder.decode(bytes)) as Json; continue }
            // Any other member is one of Bedrock's stream exceptions.
            const [name, value] = Object.entries(part)[0] ?? ['UnknownStreamError', {}]
            throw Object.assign(new Error(String(asObject(value)?.message ?? name)), { name })
          }
        })(),
      }
    },
    // An empty conversation: Bedrock refuses it as invalid (no model runs, nothing is billed);
    // a gateway that serves no Converse refuses the operation itself. Undefined when it cannot tell.
    servesConverse: async (modelId, auth) => {
      try {
        await (await clientFor(modelId, auth)).send(new sdk.ConverseStreamCommand({ modelId, messages: [] }))
        return true
      } catch (error) {
        if (refusesConverse(error)) return false
        return asObject(error)?.$metadata ? true : undefined
      }
    },
  }
}

/** The proxy agent pi's own Bedrock client would use for the endpoint (HTTPS_PROXY, NO_PROXY), or HTTP/1.1 when asked. */
async function requestHandler(req: ModuleRequire, endpoint: string, env: NodeJS.ProcessEnv): Promise<unknown> {
  try {
    const { NodeHttpHandler } = req('@smithy/node-http-handler')
    let proxyUrl: string | undefined
    try {
      // pi's own proxy rule, from pi's own package (an ES module: imported by its file URL).
      const sdkDir = path.dirname(req.resolve('@aws-sdk/client-bedrock-runtime/package.json'))
      const file = path.join(sdkDir, '..', '..', '@earendil-works', 'pi-ai', 'dist', 'utils', 'node-http-proxy.js')
      if (fs.existsSync(file)) proxyUrl = (await import(pathToFileURL(file).href)).resolveHttpProxyUrlForTarget(endpoint, env)
    } catch { /* no proxy rule: as pi without one */ }
    if (proxyUrl) {
      const { HttpProxyAgent } = req('http-proxy-agent')
      const { HttpsProxyAgent } = req('https-proxy-agent')
      return new NodeHttpHandler({ httpAgent: new HttpProxyAgent(proxyUrl), httpsAgent: new HttpsProxyAgent(proxyUrl) })
    }
    return env.AWS_BEDROCK_FORCE_HTTP1 === '1' ? new NodeHttpHandler() : undefined
  } catch {
    return undefined
  }
}

/** Claude models that take only adaptive thinking (pi-gateway.ts ADAPTIVE; this file imports nothing of Walnut's). */
const ADAPTIVE_THINKING = /(opus-4-[678]|opus-5|sonnet-4-6|sonnet-5|haiku-5|fable-5)/

/** A Bedrock model as pi's Anthropic Messages stream takes it. */
export function asInvokeModel<M extends { id: string; compat?: unknown }>(model: M): M & { api: 'anthropic-messages'; baseUrl: string } {
  const adaptive = ADAPTIVE_THINKING.test(model.id.toLowerCase().replace(/[\s_.:]+/g, '-'))
  return {
    ...model,
    api: 'anthropic-messages',
    // Never fetched: bedrockInvokeFetch takes every request.
    baseUrl: 'https://bedrock-invoke.invalid',
    compat: adaptive ? { ...(asObject(model.compat) ?? {}), forceAdaptiveThinking: true } : undefined,
  }
}

const PI_AI = '@earendil-works/pi-ai'
/** The provider entry "Import from Claude Code" writes in pi's models.json (pi-gateway.ts PI_GATEWAY_PROVIDER). */
const GATEWAY_PROVIDER = 'claude-code-gateway'

/**
 * pi's Bedrock providers whose requests go to Claude Code's gateway: the built-in one (its
 * endpoint is the gateway, claudeCodeEnv), and Walnut's entry in models.json when it names the
 * same address. A provider pi does not have is never registered: pi applies a registration
 * after the extensions load, where a refusal would stop pi.
 */
export function gatewayProviders(modelsJson: Json | undefined, gateway: string): string[] {
  const entry = asObject(asObject(modelsJson?.providers)?.[GATEWAY_PROVIDER])
  const own = entry?.api === 'bedrock-converse-stream' && trimUrl(typeof entry.baseUrl === 'string' ? entry.baseUrl : undefined) === gateway
  return ['amazon-bedrock', ...(own ? [GATEWAY_PROVIDER] : [])]
}

type Streams = { streamSimple: (...args: any[]) => any }

/**
 * How pi reaches the gateway: Converse as before while the gateway serves it (asked once per pi
 * process, at the first turn), else Claude Code's invoke for every model. A gateway that serves
 * Converse keeps every model pi had (Nova, Llama and the rest take no Anthropic body).
 */
export function gatewayRoute(servesConverse: () => Promise<boolean | undefined>): () => Promise<'converse' | 'invoke'> {
  let known: Promise<boolean> | undefined
  return async () => {
    known ??= servesConverse().then((served) => {
      if (served === undefined) known = undefined
      return served !== false
    })
    return (await known) ? 'converse' : 'invoke'
  }
}

async function registerBedrockInvoke(pi: PiLike, gateway: string, headers: Record<string, string>, providers: string[]): Promise<void> {
  if (typeof pi.registerProvider !== 'function') return
  const bedrock = sdkBedrock(gateway, headers)
  if (!bedrock) return
  // pi's own package, as pi hands it to extensions (a variable so Walnut's build never resolves it).
  const piAi = await import(PI_AI).catch(() => null) as {
    anthropicMessagesApi?: () => Streams; bedrockConverseStreamApi?: () => Streams
    lazyStream?: (model: unknown, setup: () => Promise<unknown>) => unknown
  } | null
  const anthropic = piAi?.anthropicMessagesApi?.()
  const converse = piAi?.bedrockConverseStreamApi?.()
  const lazyStream = piAi?.lazyStream
  if (!anthropic || !converse || !lazyStream) return
  let probeAuth: InvokeAuth = {}
  let probeModel = ''
  const route = gatewayRoute(() => bedrock.servesConverse(probeModel, probeAuth))
  for (const provider of providers) {
    try {
      pi.registerProvider(provider, {
        api: 'bedrock-converse-stream',
        streamSimple: (model: { id: string; compat?: unknown }, context: unknown, options?: Json) => lazyStream(model, async () => {
          const auth: InvokeAuth = { apiKey: options?.apiKey as string | undefined, bearerToken: options?.bearerToken as string | undefined, profile: options?.profile as string | undefined }
          probeAuth = auth
          probeModel = model.id
          if (await route() === 'converse') return converse.streamSimple(model, context, options)
          return anthropic.streamSimple(asInvokeModel(model), context, { ...options, apiKey: options?.apiKey || 'bedrock', fetch: bedrockInvokeFetch(bedrock.invoke(auth)) })
        }),
      })
    } catch { /* this pi has no such provider; the other still goes through */ }
  }
}

// ── The extension ────────────────────────────────────────────────────────────

interface PiLike {
  on(event: string, handler: (event: any, ctx: any) => unknown): unknown
  registerMcpServer?(name: string, config: PiMcpServerConfig): void
  registerProvider?(name: string, config: Json): void
}

export default async function walnutClaudeCode(pi: PiLike): Promise<void> {
  if (process.env.WALNUT_PI_CLAUDE_CODE === '0') return
  const home = os.homedir()
  // Read once per pi process (~/.claude.json can be many MB): a change in Claude Code reaches
  // the next pi session, never a turn of this one.
  let files: ClaudeCodeFiles | undefined
  const load = (): ClaudeCodeFiles => (files ??= loadClaudeCodeFiles(diskReader, home, process.env))
  try {
    const plan = claudeCodeEnv(load(), process.env)
    for (const [key, value] of Object.entries(plan.set)) process.env[key] = value
    for (const key of plan.unset) delete process.env[key]
    if (plan.gateway && process.env.WALNUT_PI_BEDROCK_INVOKE !== '0') {
      const agentDir = process.env.PI_CODING_AGENT_DIR?.trim() || path.join(home, '.pi', 'agent')
      const providers = gatewayProviders(readJson(diskReader, path.join(agentDir, 'models.json')), plan.gateway)
      await registerBedrockInvoke(pi, plan.gateway, gatewayHeaders(load(), process.env), providers)
    }
  } catch { /* a broken Claude Code file never stops pi */ }
  try {
    if (typeof pi.registerMcpServer === 'function') {
      for (const server of claudeCodeMcpServers(diskReader, load(), process.cwd()).servers) {
        try { pi.registerMcpServer(server.name, server.config) } catch { /* pi refused this one; the rest still load */ }
      }
    }
  } catch { /* ignore */ }
  pi.on('resources_discover', (event: { cwd?: string }) => {
    try {
      const dirs = claudeCodeResourceDirs(diskReader, load(), event?.cwd || process.cwd())
      return { skillPaths: dirs.skills.map((d) => d.path), promptPaths: dirs.prompts.map((d) => d.path) }
    } catch { return undefined }
  })
  pi.on('before_agent_start', (event: { systemPromptOptions?: { cwd?: string; contextFiles?: ContextFile[] } }) => {
    try {
      const options = event?.systemPromptOptions
      if (!options || !Array.isArray(options.contextFiles)) return undefined
      const added = claudeCodeContextFiles(diskReader, load(), options.cwd || process.cwd(), options.contextFiles)
      options.contextFiles.push(...added)
    } catch { /* ignore */ }
    return undefined
  })
}
