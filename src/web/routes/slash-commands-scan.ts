/**
 * The slash palette's readers of LOCAL folders: a commands dir (`*.md`, one
 * level of `<dir>/<sub>.md` as `dir:sub`) and a project skills dir
 * (`<name>/SKILL.md`). The remote twins read over the daemon
 * (core/remote-skill-loader.ts).
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import { parseSkillMeta } from '../../core/plugin-skill-loader.js'
import { commandDescription } from '../../utils/frontmatter.js'
import type { SlashCommandItem } from './slash-commands.js'

/** Scan a directory for *.md command files and return items. */
export async function scanCommandDir(
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
    // A hidden file (macOS's `._<name>.md` metadata beside a copied file) is never a command.
    if (!file.endsWith('.md') || file.startsWith('.')) continue
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
        if (!subFile.endsWith('.md') || subFile.startsWith('.')) continue
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
export async function scanProjectSkillsDir(dir: string): Promise<SlashCommandItem[]> {
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
      items.push({ name: entry, description: meta.description ?? meta.name ?? '', source: 'project', kind: 'skill' })
    } catch {
      // Not a skill dir (no SKILL.md) — skip
    }
  }
  return items
}
