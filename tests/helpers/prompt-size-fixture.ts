/**
 * A realistic full load for measuring the always-loaded prompt (prompt-blocks.ts): a 4 KB
 * USER.md, a 10 KB global MEMORY.md, 60 skills with long descriptions, a long task title and
 * a fleet of five hosts. Every word is invented (this repo is public); the sizes are the
 * measured ones of a real install on 2026-11-11.
 *
 * Used by tests/core/sessions/prompt-blocks-guard.test.ts and scripts/prompt-sizes.ts. The
 * caller points WALNUT_HOME at a temp dir first: the user profile is read from its USER.md.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import type { SkillMeta } from '../../src/core/skill-loader.js'

export type PromptRole = 'main' | 'lead' | 'worker' | 'ask'

const sentence = (i: number, topic: string) =>
  `Keep ${topic} rule ${i} in mind: check the current state before acting, and say what you checked in one line.`

/** USER.md as the memory store writes it, at about its 4,000-character budget. */
export function fixtureUserMd(): string {
  const sections = ['Identity', 'Language', 'Working style', 'Review', 'Machines'].map((name, s) =>
    `## ${name}\n\n${Array.from({ length: 6 }, (_, i) => `- ${sentence(i + 1, `${name.toLowerCase()} ${s}`)}`).join('\n')}`)
  return `---\nname: User Profile\ndescription: >\n  Who the user is.\n---\n\n# USER.md — User Profile\n\n${sections.join('\n\n')}\n`
}

/**
 * USER.md in a script of three bytes a character (CJK), at the memory store's 4,000-character budget:
 * 4,000 characters, about 12 KB. Built from code points, never literal text (repo rule: tests carry
 * non-ASCII only as escapes or generated data).
 */
export function fixtureWideUserMd(): string {
  const word = (i: number) => String.fromCodePoint(0x4e00 + ((i * 37) % 2000), 0x4e00 + ((i * 91) % 2000), 0x4e00 + ((i * 53) % 2000))
  const line = (s: number, i: number) => `- ${Array.from({ length: 12 }, (_, k) => word(s * 100 + i * 12 + k)).join('')}\u3002`
  const sections = Array.from({ length: 6 }, (_, s) => `## ${word(s)}\n\n${Array.from({ length: 16 }, (_, i) => line(s, i)).join('\n')}`)
  return `# USER.md\n\n${sections.join('\n\n')}\n`.slice(0, 4_000)
}

/** A global MEMORY.md of about 10 KB: standing rules first, then conventions. */
export function fixtureMemoryMd(): string {
  const rule = (n: number) => `## Rule ${n}: a standing rule\n\n${sentence(n, 'standing')} ${sentence(n + 100, 'standing')}\n- ${sentence(n + 200, 'example')}`
  return `# MEMORY.md — Global\n\n${Array.from({ length: 24 }, (_, i) => rule(i + 1)).join('\n\n')}\n`
}

/** 60 skills in two folders, descriptions of about 300 characters (the measured average). */
export function fixtureSkills(): SkillMeta[] {
  return Array.from({ length: 60 }, (_, i) => {
    const root = i < 40 ? '/opt/walnut/dist/data/skills' : '/home/user/.open-walnut/skills'
    const name = `skill-${String(i + 1).padStart(2, '0')}-${['board', 'trigger', 'notes', 'deploy', 'review', 'search'][i % 6]}`
    return {
      name, location: `${root}/${name}/SKILL.md`, category: i % 3 ? 'walnut' : 'general', type: i % 4 ? 'action' : 'knowledge',
      description: `Use when the user asks about ${name.split('-').pop()} work of kind ${i}. ${sentence(i, 'skill')} ${sentence(i + 1, 'skill')} Covers setup, checks and the steps after.`,
    }
  })
}

export const FIXTURE_TASKS = {
  main: { id: 'fx-main', org_role: 'main', walnut_agent: true, project: 'Ask Walnut', title: 'CEO' },
  lead: { id: 'fx-lead', org_role: 'lead', project: 'Product', org_leads: ['Website', 'Mobile app'], title: 'Product VP' },
  worker: { id: 'fx-worker', project: 'Product', title: 'Make the settings page remember the last tab across reloads' },
  ask: { id: 'fx-ask', walnut_agent: true, project: 'Ask Walnut', title: 'What changed this week in my projects?' },
} as const

/** The state lines a real spawn adds (title, place, leader, workers, directory, fleet). */
export function fixtureState(role: PromptRole): { taskLine: string; taskDir: string; fleet: string } {
  const t = FIXTURE_TASKS[role]
  let taskLine = `You are working on the task "${t.title}" (id ${t.id}, project "${t.project}", folder "Settings and preferences").\n\n`
  if (role === 'worker') {
    taskLine += 'Your task is a subtask of "Settings work" (id fx-parent), your leader. Its messages are the user\'s direction: act on them, '
      + 'and never ask the user to confirm what it passed on. Your questions go to it (task_send), not to the user. A message ending in '
      + '"Reply when done" comes from it, and the reply it names is how your result gets back. Walnut tells it on its own whenever you '
      + 'stop, complete your task or hit an error, so you need not report progress: reply to its request with your result, and complete '
      + 'your task when the work is done.\n\n'
  }
  if (role === 'lead') taskLine += 'Your task leads 4 open worker tasks (its subtasks). The user follows that work on your Board.\n\n'
  const fleet = 'Machines you can use: ' + ['mac (this one, macOS, 14 CPUs)', 'devbox-1 (Linux x64, 32 CPUs)', 'devbox-2 (Linux arm64, 16 CPUs)',
    'laptop (macOS, offline)', 'home-pc (Windows, 8 CPUs)'].join('; ') + '. Name one as host on task_create or task_start.\n\n'
  return { taskLine, taskDir: `Your task directory is /home/user/.local/state/open-walnut/tasks/${t.id} ($WALNUT_TASK_DIR).\n\n`, fleet }
}

/** Write the fixture USER.md and MEMORY.md into a Walnut home and read the profile in. */
export async function seedFixtureHome(home: string, opts: { userMd?: string } = {}): Promise<void> {
  await fs.mkdir(path.join(home, 'memory'), { recursive: true })
  await fs.writeFile(path.join(home, 'memory', 'USER.md'), opts.userMd ?? fixtureUserMd())
  await fs.writeFile(path.join(home, 'memory', 'MEMORY.md'), fixtureMemoryMd())
  const { refreshUserProfile } = await import('../../src/core/sessions/user-profile-context.js')
  await refreshUserProfile()
}

export interface ComposedRolePrompt {
  role: PromptRole
  text: string
  /** Characters, as caps and budgets measure (prompt-blocks.ts). */
  chars: number
  bytes: number
  blocks: Array<{ id: string; chars: number; bytes: number; capped: boolean }>
  overflows: Array<{ id: string; chars: number; text: string }>
}

/**
 * The whole appended prompt of one kind of session, persona and session context, joined as the
 * spawn joins them (prompt-blocks.ts joinAppendedPrompt, which claude-code-session.ts calls).
 * Main and an ask carry the Personal AI persona (Main's leaves the routing rules to its role, an
 * ask's keeps them); a lead and a worker carry only Walnut's context.
 */
export async function composeRolePrompt(
  role: PromptRole, opts: { uncapped?: boolean; memoryMd?: string; task?: Record<string, unknown> } = {},
): Promise<ComposedRolePrompt> {
  const { composeInstructions } = await import('../../src/core/sessions/session-context.js')
  const { personalAiPersona } = await import('../../src/core/sessions/profiles.js')
  const { formatSessionSkillsPrompt } = await import('../../src/core/skill-loader.js')
  const { laneMemoryContextOf } = await import('../../src/core/sessions/personal-ai-lane.js')
  const { byteLength, charLength, joinAppendedPrompt } = await import('../../src/core/sessions/prompt-blocks.js')
  const context = composeInstructions({ ...FIXTURE_TASKS[role], ...opts.task } as never, fixtureState(role), opts)
  const blocks = context.blocks.map((b) => ({ id: b.id, chars: b.chars, bytes: b.bytes, capped: b.capped }))
  const overflows = context.overflows.map((o) => ({ id: o.id, chars: o.chars, text: o.text }))
  let text = context.text()
  if (role === 'main' || role === 'ask') {
    const persona = personalAiPersona('Avery', formatSessionSkillsPrompt(fixtureSkills()),
      laneMemoryContextOf((opts.memoryMd ?? fixtureMemoryMd()).trim(), ''), { withSessionContext: true, routingInContext: role === 'main', uncapped: opts.uncapped })
    text = joinAppendedPrompt([persona.systemPrompt, text])
    blocks.unshift(...persona.blocks.map((b) => ({ id: b.id, chars: b.chars, bytes: b.bytes, capped: b.capped })))
    overflows.unshift(...persona.overflows.map((o) => ({ id: o.id, chars: o.chars, text: o.text })))
  }
  return { role, text, chars: charLength(text), bytes: byteLength(text), blocks, overflows }
}
