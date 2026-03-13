/**
 * Slash-commands route — aggregates all slash command sources for session autocomplete.
 *
 * Sources:
 *   1. Skills      — ~/.claude/skills/ (via skill-loader)
 *   2. Walnut cmds  — ~/.walnut/commands/ (via command-store)
 *   3. Root cmds   — ~/.claude/commands/*.md
 *   4. Project cmds — {cwd}/.claude/commands/*.md
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { listAvailableSkills } from '../../core/skill-loader.js'
import { listCommands as listWalnutCommands } from '../../core/command-store.js'
import { parseFrontmatter } from '../../utils/frontmatter.js'
import { CLAUDE_HOME } from '../../constants.js'

export interface SlashCommandItem {
  name: string
  description: string
  source: 'skill' | 'walnut' | 'claude-root' | 'project' | 'built-in'
}

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

export function createSlashCommandsRouter(): Router {
  const router = Router()

  // GET /api/slash-commands?cwd=/path/to/project
  router.get('/', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const cwd = typeof req.query.cwd === 'string' ? req.query.cwd : undefined

      // Fetch all sources in parallel
      const [skills, walnutCmds, rootCmds, projectCmds] = await Promise.all([
        // 1. Skills
        listAvailableSkills().then((all) =>
          all.map((s): SlashCommandItem => ({
            name: s.dirName,
            description: s.description ?? s.name,
            source: 'skill',
          })),
        ),
        // 2. Walnut commands
        listWalnutCommands().then((all) =>
          all.map((c): SlashCommandItem => ({
            name: c.name,
            description: c.description,
            source: 'walnut',
          })),
        ),
        // 3. Root Claude commands (~/.claude/commands/)
        scanCommandDir(path.join(CLAUDE_HOME, 'commands'), 'claude-root'),
        // 4. Project commands ({cwd}/.claude/commands/)
        cwd
          ? scanCommandDir(path.join(cwd, '.claude', 'commands'), 'project')
          : Promise.resolve([]),
      ])

      // Merge: project > root > walnut > skill > built-in
      // Higher priority first — user commands shadow built-ins (intentional).
      const seen = new Set<string>()
      const items: SlashCommandItem[] = []
      for (const list of [projectCmds, rootCmds, walnutCmds, skills, BUILTIN_COMMANDS]) {
        for (const item of list) {
          if (seen.has(item.name)) continue
          seen.add(item.name)
          items.push(item)
        }
      }

      // Sort alphabetically
      items.sort((a, b) => a.name.localeCompare(b.name))

      res.json({ items })
    } catch (err) {
      next(err)
    }
  })

  return router
}
