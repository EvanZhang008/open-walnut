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
 * A host's user-level skills are cached per host, its folder's project
 * commands per folder (slash-commands-cache.ts: one scan at a time, a cached
 * list answers at once, a request waits PALETTE_HOST_BUDGET_MS at most); with
 * nothing cached and the host not answering in time we degrade to just Walnut +
 * built-in commands (never silently fall back to local skills).
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import path from 'node:path'
import { listAvailableSkills } from '../../core/skill-loader.js'
import { listPluginSkills } from '../../core/plugin-skill-loader.js'
import { listCommands as listWalnutCommands } from '../../core/command-store.js'
import { listRemoteSkills, listRemoteProjectCommands, listRemoteProjectSkills } from '../../core/remote-skill-loader.js'
import { getConfig } from '../../core/config-manager.js'
import type { DaemonConnection } from '../../providers/daemon-connection.js'
import { log } from '../../logging/index.js'
import { CLAUDE_HOME } from '../../constants.js'
import { PALETTE_HOST_BUDGET_MS, PaletteScanCache, sharedFlight, withinBudget } from './slash-commands-cache.js'
import { scanCommandDir, scanProjectSkillsDir } from './slash-commands-scan.js'

export interface SlashCommandItem {
  name: string
  description: string
  source: 'skill' | 'open-walnut' | 'claude-root' | 'project' | 'built-in'
  /** Project paths can contain both skills and commands; source alone cannot distinguish them. */
  kind?: 'skill'
  /** For a skill bundled in a Claude Code plugin: the plugin's short name (no
   *  `@marketplace`). The CLI addresses these as `<plugin>:<skill>`, which is
   *  how the CLI-sourced palette lists them. */
  plugin?: string
}

/**
 * How long a host's scan is fresh. Kept short (60s) so a skill just created on
 * the remote host shows up soon without a manual refresh; an expired entry
 * still answers at once while one background re-scan refreshes it, and the
 * frontend serves its own copy instantly too. `?fresh=1` re-scans at once.
 */
const REMOTE_CACHE_TTL_MS = 60_000
/** A host's user-level skills (plugin + ~/.claude/skills), the same for every folder: keyed by host
 *  (a few hundred items, about 100 KB of text, per host). */
const remoteSkillsCache = new PaletteScanCache<SlashCommandItem[]>('slash-palette.host-skills', REMOTE_CACHE_TTL_MS, 64, 16 * 1024 * 1024)
/** A folder's project commands and skills on a host: keyed by host and folder (usually a handful of items). */
const remoteProjectCache = new PaletteScanCache<SlashCommandItem[]>('slash-palette.project-items', REMOTE_CACHE_TTL_MS, 512, 8 * 1024 * 1024)

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
    kind: 'skill',
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
      all.map((s): SlashCommandItem => ({ name: s.dirName, description: s.description ?? s.name, source: 'skill', kind: 'skill' })),
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

/** The host modules, loaded once on the first remote ask (local-only use never loads them). */
let hostModules: Promise<[typeof import('../../core/hosts/link.js'), typeof import('../../core/hosts/remote-read-bound.js')]> | null = null
function loadHostModules() {
  hostModules ??= Promise.all([import('../../core/hosts/link.js'), import('../../core/hosts/remote-read-bound.js')])
  return hostModules
}

/**
 * Reads of one request on one host: each goes through the host-read deadline
 * (remote-read-bound.ts) over the dial AND the read, and they share one
 * `link(host)` (one dial wait, not one per scan).
 */
function hostReader(host: string): <T>(read: (conn: DaemonConnection) => Promise<T>) => Promise<T> {
  let conn: Promise<DaemonConnection> | null = null
  return async (read) => {
    const config = await getConfig()
    if (!config.hosts?.[host]?.hostname) throw new Error(`Unknown host or missing hostname: ${host}`)
    const [{ link }, { boundHostRead }] = await loadHostModules()
    // No timer of its own: boundHostRead bounds the dial in every pool state, and
    // a connected link that stopped answering is noticed in seconds.
    return boundHostRead(host, async () => read(await (conn ??= link(host))))
  }
}

function logBackgroundScanFailure(host: string): (err: unknown) => void {
  return (err) => {
    void loadHostModules().then(([, { hostReadFailureLevel }]) => {
      log.session[hostReadFailureLevel(err)]('slash-commands: a scan no request waited for failed (what was cached stays)', {
        host, error: err instanceof Error ? err.message : String(err),
      })
    })
  }
}

/**
 * A REMOTE host's skills/commands over the daemon, UNFOLDED and in priority
 * order (see scanLocalItems), through the two caches. Skills run on the remote
 * host, so local skills are intentionally excluded, and so are the Mac's
 * ~/.claude root commands. Null when nothing is cached and the host did not
 * answer within `budgetMs` (the scans go on and fill the caches); throws when a
 * scan with nothing cached failed, so the caller can degrade.
 */
async function remoteItems(host: string, cwd: string | undefined, fresh: boolean, budgetMs = PALETTE_HOST_BUDGET_MS): Promise<SlashCommandItem[] | null> {
  const opts = { fresh, budgetMs, onBackgroundError: logBackgroundScanFailure(host) }
  const viaHost = hostReader(host)
  const [skills, project, openWalnutCmds] = await Promise.all([
    remoteSkillsCache.read(host, () => viaHost(async (conn) =>
      (await listRemoteSkills(conn)).map(pluginSkillItem)), opts),
    cwd
      ? remoteProjectCache.read(`${host}::${cwd}`, () => viaHost(async (conn) => {
          const [cmds, skills] = await Promise.all([
            listRemoteProjectCommands(conn, cwd),
            listRemoteProjectSkills(conn, cwd),
          ])
          return [
            ...cmds.map((c): SlashCommandItem => ({ name: c.name, description: c.description, source: 'project' })),
            ...skills.map((s): SlashCommandItem => ({ name: s.dirName, description: s.description, source: 'project', kind: 'skill' })),
          ]
        }), opts)
      : Promise.resolve({ value: [] as SlashCommandItem[] }),
    localWalnutCommands(),
  ])
  if (!skills || !project) return null
  return [...project.value, ...openWalnutCmds, ...skills.value, ...BUILTIN_COMMANDS]
}

/** Test seam: forget every cached and running remote scan. */
export function resetRemoteSlashCacheForTest(): void {
  remoteSkillsCache.clear()
  remoteProjectCache.clear()
  recoveries.clear()
}

/** Test seam: wait out the host reads a request left running behind its answer. */
export async function settleRemoteSlashReadsForTest(): Promise<void> {
  await Promise.allSettled([remoteSkillsCache.settled(), remoteProjectCache.settled(), ...recoveries.values()])
}

export interface SlashCommandsPayload {
  items: SlashCommandItem[]
  /** The host's own commands are not in this answer (descriptions, or the list itself). */
  degraded?: boolean
  /** With `degraded`: the host is answering, its commands are still being read
   *  (the scan goes on and the next ask has them); absent = the host is not reachable. */
  stillLoading?: boolean
}

/** A remote host's scan, or why there is none: `late` = still being read, not a failure. */
interface RemoteScan { items: SlashCommandItem[] | null; late: boolean }

/**
 * A remote host's scan, or why there is none, logged. A host that is away (the
 * bound said so, or it did not answer in time) is the expected degraded
 * answer, logged at info; anything else warns.
 */
async function remoteItemsOrLogged(host: string, cwd: string | undefined, fresh: boolean, what: string, ctx: Record<string, unknown>): Promise<RemoteScan> {
  try {
    const items = await remoteItems(host, cwd, fresh)
    if (!items) log.session.info(what, { ...ctx, host, error: `still reading after ${PALETTE_HOST_BUDGET_MS}ms (the scan goes on)` })
    return { items, late: items === null }
  } catch (err) {
    const [, { hostReadFailureLevel }] = await loadHostModules()
    log.session[hostReadFailureLevel(err)](what, { ...ctx, host, error: err instanceof Error ? err.message : String(err) })
    return { items: null, late: false }
  }
}

/** The flags of an answer without the host's commands: still being read, or the host is not reachable. */
function degradedFlags(scan: RemoteScan): Pick<SlashCommandsPayload, 'degraded' | 'stillLoading'> {
  return scan.late ? { degraded: true, stillLoading: true } : { degraded: true }
}

/** Never local skills for a remote host (they'd misrepresent it): only Walnut + built-in commands, flagged. */
async function degradedDiscovery(scan: RemoteScan): Promise<SlashCommandsPayload> {
  return { items: mergeAndSort([await localWalnutCommands(), BUILTIN_COMMANDS]), ...degradedFlags(scan) }
}

/**
 * Build the palette payload for a session composer — the ONE implementation
 * shared by the internal route, the /api/v1 mobile route, and the cloud
 * control relay. Encapsulates the per-host caches, the answer budget, and the
 * degraded fallback (never local skills for a remote host).
 */
export async function buildSlashCommandItems(opts: {
  cwd?: string
  host?: string
  /** Force a re-scan, bypassing the per-host cache (manual palette refresh). */
  fresh?: boolean
}): Promise<SlashCommandsPayload> {
  const { cwd, host, fresh } = opts
  if (!host) return { items: await buildLocalItems(cwd) }
  const scan = await remoteItemsOrLogged(host, cwd, fresh === true, 'slash-commands: remote discovery failed, degrading', {})
  return scan.items ? { items: mergeAndSort([scan.items]) } : degradedDiscovery(scan)
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

/** Stream recoveries running now, per session: requests that arrive together share one. */
const recoveries = new Map<string, Promise<string[] | null>>()

/**
 * The CLI's names from the stream tail (bounded, via the daemon), once per
 * session at a time. A recovery that lands after its request was answered
 * still seeds the live instance, so the next ask has the names in memory. A
 * host that cannot answer now is "not recovered".
 */
function recoverCliNames(
  sessionId: string,
  host: string | undefined,
  live: { seedCliSlashCommands(names: string[], at: number): void } | null | undefined,
): Promise<string[] | null> {
  return sharedFlight(recoveries, sessionId, async () => {
    const { recoverCliSlashCommandsFromStream } = await import('../../core/sessions/cli-slash-commands-recover.js')
    const [, { boundHostRead, hostReadFailureLevel }] = await loadHostModules()
    try {
      const recovered = await boundHostRead(host, () => recoverCliSlashCommandsFromStream(sessionId, host))
      if (!recovered) return null
      live?.seedCliSlashCommands(recovered.names, Date.now())
      return recovered.names
    } catch (err) {
      log.session[hostReadFailureLevel(err)]('slash-commands: stream recovery failed, using discovery', {
        sessionId, host, error: err instanceof Error ? err.message : String(err),
      })
      return null
    }
  })
}

/**
 * The palette for ONE live session: the CLI's advertised command set, decorated.
 * The names come from the live capture, or from the last init in the stream
 * tail when this process has not seen one (post-restart reattach). Falls back to
 * plain discovery (flagged `source: 'discovery'`) only when neither exists — a
 * draft, or a session whose stream file is gone. The stream recovery and the
 * description scan start together and share one budget: whatever is not in by
 * then is answered without (the client asks again shortly), and lands in the
 * caches for that next ask.
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
  // An engine that answers its own commands (Codex) lists those, never the Claude Code skills
  // a scan of its folder finds.
  const { engineCaps } = await import('../../core/agents/engine-registry.js')
  const own = engineCaps(record.engine).slashCommands
  if (own) return { items: own.map((c) => ({ ...c, source: 'built-in' as const })), source: 'cli' }
  const { sessionRunner } = await import('../../providers/claude-code-session.js')
  const live = sessionRunner.findByClaudeId(sessionId)
  const captured = live?.cliSlashCommands?.names ?? null

  const [cliNames, scan] = await Promise.all([
    captured
      ? Promise.resolve(captured)
      : withinBudget(recoverCliNames(sessionId, record.host, live), PALETTE_HOST_BUDGET_MS).then((out) => out?.value ?? null),
    record.host
      ? remoteItemsOrLogged(record.host, record.cwd, fresh === true, 'slash-commands: description scan failed, serving what is known', { sessionId })
      : scanLocalItems(record.cwd).then((items): RemoteScan => ({ items, late: false })),
  ])
  const scanned = scan.items

  if (!cliNames) {
    const base = scanned ? { items: mergeAndSort([scanned]) } : await degradedDiscovery(scan)
    return { ...base, source: 'discovery' }
  }
  // The list itself is intact (it came from the CLI); a missing scan only
  // costs descriptions. Say so instead of shrinking the palette to a handful of built-ins.
  const items = composeCliPalette(cliNames, scanned)
  return scanned ? { items, source: 'cli' } : { items, source: 'cli', ...degradedFlags(scan) }
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
