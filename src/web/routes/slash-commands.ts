/**
 * Slash-commands route — aggregates all slash command sources for session autocomplete.
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
import { listPluginSkills } from '../../core/plugin-skill-loader.js'
import { listCommands as listWalnutCommands } from '../../core/command-store.js'
import { listRemoteSkills, listRemoteProjectCommands } from '../../core/remote-skill-loader.js'
import { getConfig } from '../../core/config-manager.js'
import { parseFrontmatter } from '../../utils/frontmatter.js'
import { log } from '../../logging/index.js'
import { CLAUDE_HOME } from '../../constants.js'

export interface SlashCommandItem {
  name: string
  description: string
  source: 'skill' | 'open-walnut' | 'claude-root' | 'project' | 'built-in'
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
      const { frontmatter } = parseFrontmatter(raw)
      items.push({
        name,
        description: (frontmatter.description as string) ?? '',
        source,
      })
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
          const { frontmatter } = parseFrontmatter(raw)
          items.push({
            name: cmdName,
            description: (frontmatter.description as string) ?? '',
            source,
          })
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
  if (!plugin || plugin === '__flat__') return description
  const name = plugin.includes('@') ? plugin.slice(0, plugin.lastIndexOf('@')) : plugin
  return description ? `[${name}] ${description}` : `[${name}]`
}

/** Walnut commands (Mac-side injected) — shared by local + remote responses. */
async function localWalnutCommands(): Promise<SlashCommandItem[]> {
  return listWalnutCommands().then((all) =>
    all.map((c): SlashCommandItem => ({ name: c.name, description: c.description, source: 'open-walnut' })),
  )
}

/** Build the slash-command list for a LOCAL session (current behavior). */
async function buildLocalItems(cwd?: string): Promise<SlashCommandItem[]> {
  const [skills, pluginSkills, openWalnutCmds, rootCmds, projectCmds] = await Promise.all([
    listAvailableSkills().then((all) =>
      all.map((s): SlashCommandItem => ({ name: s.dirName, description: s.description ?? s.name, source: 'skill' })),
    ),
    listPluginSkills().then((all) =>
      all.map((s): SlashCommandItem => ({
        name: s.dirName,
        description: withPluginLabel(s.plugin, s.description || s.name),
        source: 'skill',
      })),
    ),
    localWalnutCommands(),
    scanCommandDir(path.join(CLAUDE_HOME, 'commands'), 'claude-root'),
    cwd ? scanCommandDir(path.join(cwd, '.claude', 'commands'), 'project') : Promise.resolve([]),
  ])
  // Merge: project > root > open-walnut > skill > built-in
  return mergeAndSort([projectCmds, rootCmds, openWalnutCmds, skills, pluginSkills, BUILTIN_COMMANDS])
}

/**
 * Build the slash-command list for a REMOTE session — discovers skills/commands on
 * the remote host over the daemon. Throws on connection/timeout so the caller can
 * degrade. Skills run on the remote host, so local skills are intentionally excluded.
 */
async function buildRemoteItems(host: string, cwd?: string): Promise<SlashCommandItem[]> {
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

  const [remoteSkills, remoteProjectCmds, openWalnutCmds] = await Promise.all([
    listRemoteSkills(conn).then((all) =>
      all.map((s): SlashCommandItem => ({
        name: s.dirName,
        description: withPluginLabel(s.plugin, s.description),
        source: 'skill',
      })),
    ),
    cwd
      ? listRemoteProjectCommands(conn, cwd).then((all) =>
          all.map((c): SlashCommandItem => ({ name: c.name, description: c.description, source: 'project' })),
        )
      : Promise.resolve([]),
    localWalnutCommands(),
  ])
  // Merge: project > open-walnut > skill > built-in (no local ~/.claude root cmds — that's the Mac)
  return mergeAndSort([remoteProjectCmds, openWalnutCmds, remoteSkills, BUILTIN_COMMANDS])
}

export function createSlashCommandsRouter(): Router {
  const router = Router()

  // GET /api/slash-commands?cwd=/path/to/project&host=optional-ssh-host
  router.get('/', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const cwd = typeof req.query.cwd === 'string' ? req.query.cwd : undefined
      const host = typeof req.query.host === 'string' && req.query.host ? req.query.host : undefined
      // `fresh=1` forces a re-scan, bypassing the per-host cache (manual palette refresh).
      const fresh = req.query.fresh === '1' || req.query.fresh === 'true'

      // ── Local session ──
      if (!host) {
        res.json({ items: await buildLocalItems(cwd) })
        return
      }

      // ── Remote session ──
      const cacheKey = `${host}::${cwd ?? ''}`
      if (!fresh) {
        const cached = remoteCache.get(cacheKey)
        if (cached && Date.now() - cached.time < REMOTE_CACHE_TTL_MS) {
          res.json({ items: cached.items })
          return
        }
        // Stale-while-revalidate: an EXPIRED entry still answers instantly while a
        // background re-scan refreshes it. The awaited path held a browser
        // connection for the full 7-9s SSH scan on every TTL expiry; a few of
        // those saturate the browser's 6-per-origin pool and cascade into client
        // timeouts (2026-07-31). Staleness is bounded by scan time, and `?fresh=1`
        // still forces a blocking re-scan.
        if (cached && !revalidating.has(cacheKey)) {
          revalidating.add(cacheKey)
          void buildRemoteItems(host, cwd)
            .then((items) => { remoteCache.set(cacheKey, { time: Date.now(), items }) })
            .catch((err) => {
              log.session.warn('slash-commands: background revalidation failed (stale cache kept)', {
                host, error: err instanceof Error ? err.message : String(err),
              })
            })
            .finally(() => { revalidating.delete(cacheKey) })
          res.json({ items: cached.items })
          return
        }
      }

      try {
        const items = await buildRemoteItems(host, cwd)
        remoteCache.set(cacheKey, { time: Date.now(), items })
        res.json({ items })
      } catch (err) {
        // Degrade: never silently fall back to LOCAL skills (they'd misrepresent the
        // remote host). Return only Walnut + built-in commands, flagged degraded.
        log.session.warn('slash-commands: remote discovery failed, degrading', {
          host,
          error: err instanceof Error ? err.message : String(err),
        })
        const openWalnutCmds = await localWalnutCommands()
        res.json({ items: mergeAndSort([openWalnutCmds, BUILTIN_COMMANDS]), degraded: true })
      }
    } catch (err) {
      next(err)
    }
  })

  return router
}
