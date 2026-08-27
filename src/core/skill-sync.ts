/**
 * Skill distribution payload — the walnut skill, packaged for every exec host.
 *
 * Sessions the daemon did NOT spawn (a `claude` or `codex` the user starts in
 * a plain terminal, a teammate agent on a dev box) get the `walnut` COMMAND
 * from the user-PATH shim, but nothing tells the MODEL it exists. The daemon
 * keeps ONE real copy per host in Walnut's own namespace and points every
 * engine's native skill folder at it with a symlink:
 *
 *   canonical: ~/.open-walnut/distributed-skills/walnut/SKILL.md
 *   claude:    ~/.claude/skills/walnut  -> symlink to the canonical dir
 *   codex:     ~/.agents/skills/walnut  -> symlink to the canonical dir
 *              (codex's documented user-level skill dir; both engines follow
 *               symlinked skill folders. Only linked when ~/.codex exists —
 *               no codex user, no link.)
 *
 * The canonical dir is deliberately NOT ~/.open-walnut/skills/: that is the
 * user's own skill store, where a flat walnut/SKILL.md would shadow legacy
 * category sub-skills under walnut/ and collide with first-wins discovery
 * (both bit us on 2026-08-26). distributed-skills/ is the daemon's namespace.
 *
 * v1 wrote a real file into ~/.claude/skills and a fenced pointer section
 * into ~/.codex/AGENTS.md; the daemon migrates both on the next sync
 * (replaces the owned dir with the symlink, removes the owned fence), and
 * also removes the short-lived v2.0 canonical from ~/.open-walnut/skills/.
 *
 * Freshness is the daemon-shim mechanism, not a hand copy: the hub pushes
 * this payload on every daemon connect (`skills.sync`, hash-skipped), so the
 * distributed copy tracks the repo's src/data/skills/walnut/SKILL.md — the
 * single source of truth. It carries the DISTRIBUTED_MARKER and says so: the
 * copy is READ-ONLY — updating Walnut is the only way to change it.
 */

import crypto from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { BUILTIN_SKILLS_DIR } from '../constants.js'

/**
 * Marker the daemon uses to recognize its own files (never clobber foreign
 * ones). The "v1" is part of the ownership string, NOT a protocol version —
 * renaming it would orphan every already-distributed copy.
 */
export const DISTRIBUTED_MARKER = 'walnut-managed v1'

const READ_ONLY_BANNER = [
  `<!-- ${DISTRIBUTED_MARKER} — distributed by the Walnut session daemon. DO NOT EDIT.`,
  '     This copy is READ-ONLY and overwritten on every daemon connect. To change',
  '     it, update Walnut itself (src/data/skills/walnut/SKILL.md in the Walnut',
  '     repo, or ask Walnut) — the update reaches every host automatically. -->',
].join('\n')

/** v1 fence markers — the daemon still needs them to REMOVE old AGENTS.md sections. */
export const CODEX_BEGIN = `<!-- BEGIN ${DISTRIBUTED_MARKER} -->`
export const CODEX_END = `<!-- END ${DISTRIBUTED_MARKER} -->`

export interface SkillSyncPayload {
  hash: string
  /** Full SKILL.md content (banner injected) for the canonical copy. */
  skill: string
}

/**
 * Insert the read-only banner after YAML frontmatter (or prepend when absent).
 * Idempotent: already-bannered content passes through untouched, so a payload
 * accidentally built FROM a distributed copy can never stack banners.
 */
export function withReadOnlyBanner(skillMd: string): string {
  if (skillMd.includes(DISTRIBUTED_MARKER)) return skillMd
  const m = /^---\n[\s\S]*?\n---\n/.exec(skillMd)
  if (m) return skillMd.slice(0, m[0].length) + '\n' + READ_ONLY_BANNER + '\n' + skillMd.slice(m[0].length)
  return READ_ONLY_BANNER + '\n\n' + skillMd
}

/**
 * Build the payload from the shipped walnut skill. Reads the builtin file
 * directly — NOT via first-wins skill discovery, which could resolve to a
 * distributed copy on the hub host itself (a feedback loop). Falls back to
 * discovery only if the direct read fails, where the idempotent banner keeps
 * the loop harmless. Returns null when the skill cannot be read (never block
 * a daemon connect over distribution).
 */
export async function buildSkillSyncPayload(): Promise<SkillSyncPayload | null> {
  let content: string | undefined
  try {
    content = await fsp.readFile(path.join(BUILTIN_SKILLS_DIR, 'walnut', 'SKILL.md'), 'utf-8')
  } catch {
    try {
      const { getSkill } = await import('./skill-store.js')
      const skill = await getSkill('walnut')
      content = (skill as { content?: string } | null)?.content
    } catch {
      return null
    }
  }
  if (!content) return null
  const skill = withReadOnlyBanner(content)
  const hash = crypto.createHash('sha256').update(skill).digest('hex').slice(0, 16)
  return { hash, skill }
}
