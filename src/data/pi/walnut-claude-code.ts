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
 *     `@path` lines import.
 *
 * Set WALNUT_PI_CLAUDE_CODE=0 to turn it off for one run. Node builtins only: pi loads
 * this file as it is, on any machine. The exported functions are pure (they take a
 * reader), so Walnut runs the same code to show what an import will bring.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const WALNUT_CLAUDE_CODE_EXTENSION_VERSION = 2

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
  return { bedrock, set, unset }
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

// ── The extension ────────────────────────────────────────────────────────────

interface PiLike {
  on(event: string, handler: (event: any, ctx: any) => unknown): unknown
  registerMcpServer?(name: string, config: PiMcpServerConfig): void
}

export default function walnutClaudeCode(pi: PiLike): void {
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
