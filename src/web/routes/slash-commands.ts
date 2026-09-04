/**
 * Slash-commands route — the composer's "/" palette.
 *
 * LIVE SESSION (`buildSessionSlashCommandItems`): the list is whatever the CLI
 * itself advertised in its latest `system/init` line (`slash_commands`, which
 * the CLI already filters to what works in `-p` mode). Walnut never re-derives
 * that set: it only decorates the names with descriptions from the directory
 * scan below, and if that scan is unavailable the names are served bare with
 * `degraded: true` rather than the list shrinking. Before the first init (or
 * after a server restart with no replay) it falls back to discovery.
 *
 * DISCOVERY (`buildSlashCommandItems`) — drafts (no CLI yet) and the fallback:
 *
 * LOCAL session (no host):
 *   1.  Skills       — ~/.claude/skills/ etc. (via skill-loader)
 *   1b. Plugin skills — skills bundled in enabled Claude Code plugins (via plugin-skill-loader)
 *   2.  Walnut cmds  — ~/.open-walnut/commands/ (via command-store)
 *   3.  Root cmds    — ~/.claude/commands/*.md
 *   4.  Project cmds — {cwd}/.claude/commands/*.md
 *
 * REMOTE session (host set): the skills/commands run on the REMOTE host, so we
 * discover them THERE over the daemon (mirrors /api/files/list?host=). We do NOT
 * mix in the Mac's local skills — that would list capabilities the remote host
 * doesn't have. Walnut commands (Mac-side injected) + built-ins are still included.
 * Per-host results are cached briefly; on remote failure we degrade to just
 * Walnut + built-in commands (never silently fall back to local skills).
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { listAvailableSkills } from '../../core/skill-loader.js'
import { listPluginSkills, parseSkillMeta } from '../../core/plugin-skill-loader.js'
import { listCommands as listWalnutCommands } from '../../core/command-store.js'
import { listRemoteSkills, listRemoteProjectCommands, listRemoteProjectSkills } from '../../core/remote-skill-loader.js'
import { getConfig } from '../../core/config-manager.js'
import { commandDescription } from '../../utils/frontmatter.js'
import { log } from '../../logging/index.js'
import { CLAUDE_HOME } from '../../constants.js'

export interface SlashCommandItem {
  name: string
  description: string
  source: 'skill' | 'open-walnut' | 'claude-root' | 'project' | 'built-in'
  /** For a skill bundled in a Claude Code plugin: the plugin's short name (no
   *  `@marketplace`). The CLI addresses these as `<plugin>:<skill>`, which is
   *  how the CLI-sourced palette lists them. */
  plugin?: string
}

const REMOTE_TIMEOUT_MS = 15_000
/**
 * Per-host cache TTL — avoids an ssh round-trip on every "/". Kept short (60s) so a
 * skill just created on the remote host shows up soon without a manual refresh; the
 * frontend serves its own copy instantly (stale-while-revalidate), so this TTL only
 * bounds how stale a background revalidation can be. `?fresh=1` bypasses it entirely.
 */
const REMOTE_CACHE_TTL_MS = 60_000
const remoteCache = new Map<string, { time: number; items: SlashCommandItem[] }>()
/** Cache keys with an in-flight background revalidation (dedupes concurrent expiries). */
const revalidating = new Set<string>()

/**
 * Claude Code built-in commands that support non-interactive (-p) mode.
 * Verified against Claude Code v2.1.x (supportsNonInteractive: true).
 * Update this list when Claude Code adds/removes built-in commands.
 */
const BUILTIN_COMMANDS: SlashCommandItem[] = [
  { name: 'compact', description: 'Compact conversation context with optional focus instructions', source: 'built-in' },
  { name: 'context', description: 'Show current context window usage', source: 'built-in' },
  { name: 'cost', description: 'Show token usage and cost for this session', source: 'built-in' },
  { name: 'files', description: 'List files in current context', source: 'built-in' },
]

/**
 * Descriptions for the CLI built-ins that `init.slash_commands` can name (init
 * carries names only). Wording follows the CLI's own command registry. A
 * built-in missing here still lists — with an empty description — because the
 * CLI, not this table, decides what exists.
 */
const BUILTIN_DESCRIPTIONS: Record<string, string> = {
  agents: 'Manage agent configurations',
  autocompact: 'Toggle automatic context compaction',
  clear: 'Clear conversation history and free up context',
  compact: 'Clear conversation history but keep a summary in context. Optional: /compact [instructions for summarization]',
  config: 'Open config panel',
  context: 'Visualize current context usage as a colored grid',
  cost: 'Show the total cost and duration of the current session',
  effort: 'Set effort level for model usage',
  fast: 'Toggle fast mode',
  files: 'List all files currently in context',
  heapdump: 'Dump the JS heap to ~/Desktop',
  init: 'Initialize a new CLAUDE.md file with codebase documentation',
  insights: 'Generate a report on your Claude Code usage patterns',
  mcp: 'Manage MCP servers',
  model: 'Set the AI model for Claude Code',
  'reload-skills': 'Reload skills from disk',
  rename: 'Rename the current conversation',
  'security-review': 'Complete a security review of the pending changes on the current branch',
  usage: 'Show plan usage limits',
}

/** Scan a directory for *.md command files and return items. */
async function scanCommandDir(
  dir: string,
  source: SlashCommandItem['source'],
): Promise<SlashCommandItem[]> {
  let entries: string[]
  try {
    entries = await fsp.readdir(dir)
  } catch {
    return []
  }

  const items: SlashCommandItem[] = []
  for (const file of entries) {
    if (!file.endsWith('.md')) continue
    const name = file.slice(0, -3)
    // Handle subdirectory commands (e.g. address-comments/)
    if (!name) continue
    try {
      const raw = await fsp.readFile(path.join(dir, file), 'utf-8')
      items.push({ name, description: commandDescription(raw), source })
    } catch {
      // Skip unreadable files
      items.push({ name, description: '', source })
    }
  }

  // Also scan subdirectories (Claude Code supports nested commands like address-comments:subcommand)
  for (const entry of entries) {
    const fullPath = path.join(dir, entry)
    try {
      const stat = await fsp.stat(fullPath)
      if (!stat.isDirectory()) continue
      const subFiles = await fsp.readdir(fullPath)
      for (const subFile of subFiles) {
        if (!subFile.endsWith('.md')) continue
        const subName = subFile.slice(0, -3)
        if (!subName) continue
        const cmdName = `${entry}:${subName}`
        try {
          const raw = await fsp.readFile(path.join(fullPath, subFile), 'utf-8')
          items.push({ name: cmdName, description: commandDescription(raw), source })
        } catch {
          items.push({ name: cmdName, description: '', source })
        }
      }
    } catch {
      // Not a directory or not accessible
    }
  }

  return items
}

/**
 * Scan a PROJECT skills dir ({cwd}/.claude/skills/<name>/SKILL.md). The CLI lists
 * these next to the user-level ones; without this scan they had no description.
 * Reads name/description by line (the cheap lenient parser the plugin loader
 * uses), never strict YAML.
 */
async function scanProjectSkillsDir(dir: string): Promise<SlashCommandItem[]> {
  let entries: string[]
  try {
    entries = await fsp.readdir(dir)
  } catch {
    return []
  }
  const items: SlashCommandItem[] = []
  for (const entry of entries) {
    try {
      const raw = await fsp.readFile(path.join(dir, entry, 'SKILL.md'), 'utf-8')
      const meta = parseSkillMeta(raw)
      items.push({ name: entry, description: meta.description ?? meta.name ?? '', source: 'project' })
    } catch {
      // Not a skill dir (no SKILL.md) — skip
    }
  }
  return items
}

/** Merge command lists by priority (earlier list wins on name collision), then sort. */
function mergeAndSort(lists: SlashCommandItem[][]): SlashCommandItem[] {
  const seen = new Set<string>()
  const items: SlashCommandItem[] = []
  for (const list of lists) {
    for (const item of list) {
      if (seen.has(item.name)) continue
      seen.add(item.name)
      items.push(item)
    }
  }
  items.sort((a, b) => a.name.localeCompare(b.name))
  return items
}

/**
 * Format a plugin skill's description with a "[plugin-name] " prefix so the palette
 * shows which plugin a skill comes from. The plugin field is "<plugin>@<marketplace>";
 * we strip the "@marketplace" suffix for a clean label. Flat skills ("__flat__") and
 * skills with no plugin attribution get no prefix.
 */
function withPluginLabel(plugin: string | undefined, description: string): string {
  const name = pluginShortName(plugin)
  if (!name) return description
  return description ? `[${name}] ${description}` : `[${name}]`
}

/** "<plugin>@<marketplace>" → "<plugin>"; flat/unattributed skills → undefined. */
function pluginShortName(plugin: string | undefined): string | undefined {
  if (!plugin || plugin === '__flat__') return undefined
  return plugin.includes('@') ? plugin.slice(0, plugin.lastIndexOf('@')) : plugin
}

/** A plugin skill as a palette item: bare dirName (the discovery convention) plus
 *  the plugin short name so the CLI-sourced palette can find it as `<plugin>:<skill>`. */
function pluginSkillItem(s: { dirName: string; description?: string; name?: string; plugin?: string }): SlashCommandItem {
  const plugin = pluginShortName(s.plugin)
  return {
    name: s.dirName,
    description: withPluginLabel(s.plugin, s.description || s.name || ''),
    source: 'skill',
    ...(plugin ? { plugin } : {}),
  }
}

/** Walnut commands (Mac-side injected) — shared by local + remote responses. */
async function localWalnutCommands(): Promise<SlashCommandItem[]> {
  return listWalnutCommands().then((all) =>
    all.map((c): SlashCommandItem => ({ name: c.name, description: c.description, source: 'open-walnut' })),
  )
}

/**
 * Scan everything a LOCAL session could run, UNFOLDED: two plugins shipping a
 * same-named skill both stay, because the CLI knows them as two commands
 * (`<plugin>:<skill>`) and the CLI-sourced palette matches on that name. The
 * discovery palette folds by bare name on top (buildLocalItems).
 */
async function scanLocalItems(cwd?: string): Promise<SlashCommandItem[]> {
  const [skills, pluginSkills, openWalnutCmds, rootCmds, projectCmds, projectSkills] = await Promise.all([
    listAvailableSkills().then((all) =>
      all.map((s): SlashCommandItem => ({ name: s.dirName, description: s.description ?? s.name, source: 'skill' })),
    ),
    listPluginSkills().then((all) => all.map(pluginSkillItem)),
    localWalnutCommands(),
    scanCommandDir(path.join(CLAUDE_HOME, 'commands'), 'claude-root'),
    cwd ? scanCommandDir(path.join(cwd, '.claude', 'commands'), 'project') : Promise.resolve([]),
    cwd ? scanProjectSkillsDir(path.join(cwd, '.claude', 'skills')) : Promise.resolve([]),
  ])
  // Priority order (a later fold by name keeps the first): project > root > open-walnut > skill > built-in
  return [...projectCmds, ...projectSkills, ...rootCmds, ...openWalnutCmds, ...skills, ...pluginSkills, ...BUILTIN_COMMANDS]
}

/** The discovery palette for a LOCAL session: the scan folded by name. */
async function buildLocalItems(cwd?: string): Promise<SlashCommandItem[]> {
  return mergeAndSort([await scanLocalItems(cwd)])
}

/**
 * Scan a REMOTE host's skills/commands over the daemon, UNFOLDED and in priority
 * order (see scanLocalItems). Throws on connection/timeout so the caller can
 * degrade. Skills run on the remote host, so local skills are intentionally
 * excluded — and so are the Mac's ~/.claude root commands.
 */
async function scanRemoteItems(host: string, cwd?: string): Promise<SlashCommandItem[]> {
  const config = await getConfig()
  const hostDef = config.hosts?.[host]
  if (!hostDef?.hostname) throw new Error(`Unknown host or missing hostname: ${host}`)

  const { getDaemonConnection } = await import('../../providers/daemon-connection.js')
  const sshTarget = { hostname: hostDef.hostname, user: hostDef.user, port: hostDef.port }

  let timeoutId: ReturnType<typeof setTimeout>
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`Remote connection to ${host} timed out`)), REMOTE_TIMEOUT_MS)
  })
  const conn = await Promise.race([
    getDaemonConnection(host, sshTarget),
    timeoutPromise,
  ]).finally(() => clearTimeout(timeoutId!))

  const [remoteSkills, remoteProjectCmds, remoteProjectSkills, openWalnutCmds] = await Promise.all([
    listRemoteSkills(conn).then((all) => all.map(pluginSkillItem)),
    cwd
      ? listRemoteProjectCommands(conn, cwd).then((all) =>
          all.map((c): SlashCommandItem => ({ name: c.name, description: c.description, source: 'project' })),
        )
      : Promise.resolve([]),
    cwd
      ? listRemoteProjectSkills(conn, cwd).then((all) =>
          all.map((s): SlashCommandItem => ({ name: s.dirName, description: s.description, source: 'project' })),
        )
      : Promise.resolve([]),
    localWalnutCommands(),
  ])
  return [...remoteProjectCmds, ...remoteProjectSkills, ...openWalnutCmds, ...remoteSkills, ...BUILTIN_COMMANDS]
}

export interface SlashCommandsPayload {
  items: SlashCommandItem[]
  degraded?: boolean
}

/**
 * Remote scan (UNFOLDED, see scanRemoteItems) through the per-host cache. A fresh entry answers directly;
 * an EXPIRED entry still answers instantly while ONE background re-scan
 * refreshes it (the awaited path held a browser connection for the full 7-9s
 * SSH scan on every TTL expiry; a few of those saturate the browser's
 * 6-per-origin pool and cascade into client timeouts, 2026-07-31). Only an
 * empty cache (or `fresh`) blocks on the scan, and only that path can throw.
 */
async function remoteItemsViaCache(host: string, cwd: string | undefined, fresh: boolean): Promise<SlashCommandItem[]> {
  const cacheKey = `${host}::${cwd ?? ''}`
  if (!fresh) {
    const cached = remoteCache.get(cacheKey)
    if (cached) {
      if (Date.now() - cached.time >= REMOTE_CACHE_TTL_MS && !revalidating.has(cacheKey)) {
        revalidating.add(cacheKey)
        void scanRemoteItems(host, cwd)
          .then((items) => { remoteCache.set(cacheKey, { time: Date.now(), items }) })
          .catch((err) => {
            log.session.warn('slash-commands: background revalidation failed (stale cache kept)', {
              host, error: err instanceof Error ? err.message : String(err),
            })
          })
          .finally(() => { revalidating.delete(cacheKey) })
      }
      return cached.items
    }
  }
  const items = await scanRemoteItems(host, cwd)
  remoteCache.set(cacheKey, { time: Date.now(), items })
  return items
}

/**
 * Build the palette payload for a session composer — the ONE implementation
 * shared by the internal route, the /api/v1 mobile route, and the cloud
 * control relay. Encapsulates the per-host cache, the stale-while-revalidate
 * behavior, and the degraded fallback (never local skills for a remote host).
 */
export async function buildSlashCommandItems(opts: {
  cwd?: string
  host?: string
  /** Force a re-scan, bypassing the per-host cache (manual palette refresh). */
  fresh?: boolean
}): Promise<SlashCommandsPayload> {
  const { cwd, host, fresh } = opts

  // ── Local session ──
  if (!host) {
    return { items: await buildLocalItems(cwd) }
  }

  // ── Remote session ──
  try {
    return { items: mergeAndSort([await remoteItemsViaCache(host, cwd, fresh === true)]) }
  } catch (err) {
    // Degrade: never silently fall back to LOCAL skills (they'd misrepresent the
    // remote host). Return only Walnut + built-in commands, flagged degraded.
    log.session.warn('slash-commands: remote discovery failed, degrading', {
      host,
      error: err instanceof Error ? err.message : String(err),
    })
    const openWalnutCmds = await localWalnutCommands()
    return { items: mergeAndSort([openWalnutCmds, BUILTIN_COMMANDS]), degraded: true }
  }
}

export interface SessionSlashCommandsPayload extends SlashCommandsPayload {
  /** 'cli' = the names are the CLI's own init list (descriptions decorated from
   *  discovery; `degraded` then means only the descriptions are missing).
   *  'discovery' = no init seen for this session yet, plain directory scan. */
  source: 'cli' | 'discovery'
}

/**
 * Turn the CLI's init names into palette items, decorated with whatever the
 * directory scan knows about each name. Pure: the CLI list decides WHICH names
 * appear (a scanned entry the CLI did not list is not offered — the session
 * could not run it), the scan only supplies description + source. Names the
 * CLI marks internal by convention (`__…`) are hidden. A plugin skill is
 * matched under the CLI's `<plugin>:<skill>` name (the scan lists it bare and
 * carries `plugin`); the palette then offers the namespaced form, which is the
 * one the CLI accepts unambiguously.
 */
export function composeCliPalette(
  cliNames: readonly string[],
  scanned: readonly SlashCommandItem[] | null,
): SlashCommandItem[] {
  const described = new Map<string, SlashCommandItem>()
  for (const item of scanned ?? []) {
    if (item.plugin) {
      const key = `${item.plugin}:${item.name}`
      // The namespaced name already says which plugin; drop the "[plugin] " label
      // the bare discovery form carries for the same purpose.
      const label = `[${item.plugin}]`
      const description = item.description === label
        ? ''
        : item.description.startsWith(`${label} `) ? item.description.slice(label.length + 1) : item.description
      if (!described.has(key)) described.set(key, { ...item, name: key, description })
    }
    if (!described.has(item.name)) described.set(item.name, item)
  }
  const items: SlashCommandItem[] = []
  for (const name of cliNames) {
    if (name.startsWith('__')) continue
    const known = described.get(name)
    if (known) { items.push(known); continue }
    const builtin = BUILTIN_DESCRIPTIONS[name]
    items.push({ name, description: builtin ?? '', source: builtin !== undefined ? 'built-in' : 'skill' })
  }
  return mergeAndSort([items])
}

/**
 * The palette for ONE live session: the CLI's advertised command set, decorated.
 * The names come from the live capture, or from the last init in the stream
 * tail when this process has not seen one (post-restart reattach). Falls back to
 * plain discovery (flagged `source: 'discovery'`) only when neither exists — a
 * draft, or a session whose stream file is gone.
 */
export async function buildSessionSlashCommandItems(opts: {
  sessionId: string
  /** Force a description re-scan, bypassing the per-host cache. */
  fresh?: boolean
}): Promise<SessionSlashCommandsPayload> {
  const { sessionId, fresh } = opts
  const { getSessionByClaudeId } = await import('../../core/session-tracker.js')
  const record = await getSessionByClaudeId(sessionId)
  if (!record) {
    const { SessionControlError } = await import('../../core/sessions/session-controls.js')
    throw new SessionControlError('session not found', 404)
  }
  const { sessionRunner } = await import('../../providers/claude-code-session.js')
  const live = sessionRunner.findByClaudeId(sessionId)
  let cliNames = live?.cliSlashCommands?.names ?? null
  if (!cliNames) {
    // Post-restart window: the reattach tails from the end, so the init this
    // process never saw is recovered from the stream tail (bounded, via the
    // daemon). A session with no stream yet (draft) stays on discovery.
    const { recoverCliSlashCommandsFromStream } = await import('../../core/sessions/cli-slash-commands-recover.js')
    const recovered = await recoverCliSlashCommandsFromStream(sessionId, record.host)
    if (recovered) {
      cliNames = recovered.names
      live?.seedCliSlashCommands(recovered.names, Date.now())
    }
  }
  if (!cliNames) {
    const base = await buildSlashCommandItems({ cwd: record.cwd, host: record.host, fresh })
    return { ...base, source: 'discovery' }
  }

  let scanned: SlashCommandItem[] | null = null
  try {
    scanned = record.host
      ? await remoteItemsViaCache(record.host, record.cwd, fresh === true)
      : await scanLocalItems(record.cwd)
  } catch (err) {
    // The list itself is intact (it came from the CLI); only descriptions are
    // missing. Say so instead of shrinking the palette to a handful of built-ins.
    log.session.warn('slash-commands: description scan failed, serving CLI names bare', {
      sessionId, host: record.host, error: err instanceof Error ? err.message : String(err),
    })
  }
  const items = composeCliPalette(cliNames, scanned)
  return scanned ? { items, source: 'cli' } : { items, source: 'cli', degraded: true }
}

export function createSlashCommandsRouter(): Router {
  const router = Router()

  // GET /api/slash-commands?cwd=/path/to/project&host=optional-ssh-host
  router.get('/', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const payload = await buildSlashCommandItems({
        cwd: typeof req.query.cwd === 'string' ? req.query.cwd : undefined,
        host: typeof req.query.host === 'string' && req.query.host ? req.query.host : undefined,
        fresh: req.query.fresh === '1' || req.query.fresh === 'true',
      })
      res.json(payload)
    } catch (err) {
      next(err)
    }
  })

  return router
}
