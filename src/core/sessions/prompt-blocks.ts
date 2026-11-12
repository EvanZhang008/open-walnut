/**
 * Every block of Walnut's own text that a session carries on EVERY request (its appended
 * system prompt), each with a byte cap enforced where the prompt is composed.
 *
 * 2026-11-12, the user: "programmatically restrict the length of the always loading thing,
 * u can create some kind memory folder u can add it there, all walnut CEO / VP need to do the
 * similar". Measured the day before: Main carried 90.7 KB on every request (a 49 KB skills
 * index in XML, the task routing, the charter and where work lives twice, the whole global
 * MEMORY.md), a lead about 31 KB. A rule in a prompt does not keep a prompt short; a cap does.
 *
 * How a cap works (capBlock): a block within its cap is left as it is. A block over it keeps
 * its head, cut at the last paragraph, line or sentence that fits, and one pointer line in
 * place of the rest, saying how much moved, what it holds (its headings) and the op that reads
 * it; the rest becomes a file in the node's memory folder (memory-folder.ts), written by the
 * async builders (buildSessionContext, buildLaneProfile). Nothing is cut silently: the pointer
 * is in the prompt, and the writer logs every block it moved. The cut is a pure function of
 * the text, so the default instructions instruction-notice.ts compares stay deterministic.
 *
 * A versioned block (the user's profile, a role's core instructions) is never cut here: its
 * lines carry a version the instruction notice diffs line by line, so a cut would read to a
 * running session as rules removed. Its own builder caps it (USER_CHAR_BUDGET,
 * ORG_INSTRUCTIONS_MAX) and the cap here is the ceiling those allow.
 *
 * The guard (tests/core/sessions/prompt-blocks-guard.test.ts) fails when a block outgrows its
 * cap, a composed prompt outgrows its role's budget, or a new block reaches the prompt without
 * an entry here.
 */

/** Which half of the appended prompt a block rides: the persona (profiles.ts) or Walnut's session context (session-context.ts). */
export type PromptPart = 'persona' | 'context' | 'mcp'

export interface PromptBlockDef {
  id: string
  /** As the pointer and the folder file name it. */
  title: string
  part: PromptPart
  /** Bytes, UTF-8, the block's own trailing blank line included. */
  cap: number
  /** What the moved rest holds, in a few words, for the pointer line. */
  holds: string
  /** Lines carry a version the instruction notice diffs: never cut here (see above). */
  versioned?: boolean
  /** Describes this task right now (title, place, directory, fleet): left out of the default instructions. */
  state?: boolean
  /** Why this cap, against what it measured (2026-11-12). */
  why: string
}

import { createHash } from 'node:crypto'

const KB = 1024

/**
 * The registry, in the order the blocks reach the prompt. Caps are the measured size of
 * today's text plus a small margin (so growth fails the guard first), except where a block
 * is meant to keep only its head: the skills index, the standing memory and the org manuals
 * (Brief, Threads, the user away), whose detail is read when the op is used.
 */
export const PROMPT_BLOCKS: readonly PromptBlockDef[] = [
  // ── persona half (profiles.ts) ──
  { id: 'persona', title: 'Persona and operating contract', part: 'persona', cap: Math.round(3.2 * KB),
    holds: 'the rest of the operating contract and the task board model',
    why: 'Header, identity line, operating contract and board model measured 2.9 KB once the parts the session context carries left it.' },
  { id: 'standing-user', title: 'Standing memory: the user profile', part: 'persona', cap: 6 * KB,
    holds: 'the rest of USER.md',
    why: 'Only where no session context carries the user\'s profile (an ACP lane, a taskless lane): USER.md as written, measured 4.2 to 4.6 KB, with the standing memory\'s head lines.' },
  { id: 'standing-memory', title: 'Standing memory: the global MEMORY.md', part: 'persona', cap: Math.round(4.5 * KB),
    holds: 'the later sections of the global MEMORY.md',
    why: 'The global MEMORY.md measured 10 KB (its own budget is 8,000 characters); its first sections are the standing rules, the rest is read on demand.' },
  { id: 'skills-index', title: 'Walnut skills index', part: 'persona', cap: 7 * KB,
    holds: 'the rest of the skills index',
    why: 'One line of at most 90 characters per skill: 56 real skills measured 6.0 KB (the XML form with whole descriptions and paths was 30 to 49 KB).' },
  { id: 'agent-persona', title: 'Agent persona', part: 'persona', cap: 6 * KB,
    holds: 'the rest of this agent\'s own persona',
    why: 'A console agent\'s own system prompt, written in its definition: room for a long one, the rest on demand.' },
  { id: 'agent-context', title: 'Agent context', part: 'persona', cap: Math.round(4.5 * KB),
    holds: 'the rest of this agent\'s context sources',
    why: 'A console agent\'s own memory and context sources: the same room as the standing memory.' },
  // ── session context half (session-context.ts), in order ──
  { id: 'identity', title: 'Who opened this session', part: 'context', cap: 400,
    holds: 'the rest of who opened this session',
    why: 'The opening paragraph measured 237 B.' },
  { id: 'task-state', title: 'Your task', part: 'context', cap: 3 * KB, state: true,
    holds: 'the rest of what describes your task (its leader, its workers)',
    why: 'Title, place, leader and workers: under 1.5 KB with a long title and a reviewer line.' },
  { id: 'own-notes', title: 'Your own notes', part: 'context', cap: 900, state: true,
    holds: 'the rest of the list of your own notes',
    why: 'The names and sizes of a node\'s own note files, at most 12 listed.' },
  { id: 'org-role', title: 'Your role', part: 'context', cap: Math.round(6.2 * KB),
    holds: 'the later rules of your role',
    why: 'Main\'s role lines without the manuals measured 5.8 KB, a lead\'s 4.0 KB.' },
  { id: 'org-away', title: 'When the user is away', part: 'context', cap: 700,
    holds: 'what goes to the inbox while the user is away, threads first, and the scheduled report',
    why: 'A manual for one situation (a user-away note on the message): its first sentences stay, the 1.6 KB whole is read then.' },
  { id: 'org-brief', title: 'Your Brief', part: 'context', cap: 800,
    holds: 'the Brief\'s sections, line format and what Walnut checks',
    why: 'brief_read returns the rules again on the first read; 1.8 KB whole.' },
  { id: 'org-threads', title: 'Your Threads', part: 'context', cap: 1600,
    holds: 'how the summary reads, and the pending, known, open and move rules of Threads',
    why: 'The head keeps what a thread is, thread_update, merging and "every thread you answer gets its summary in that same turn"; thread_update carries the rules too, and the Stop hook holds a turn whose summary is behind. 4.7 KB whole.' },
  { id: 'org-about', title: 'Naming the tasks a reply is about', part: 'context', cap: 650,
    holds: 'the rest of the walnut-about line',
    why: 'Measured 575 B.' },
  { id: 'task-routing', title: 'Task routing', part: 'context', cap: Math.round(2.4 * KB),
    holds: 'the later task routing rules',
    why: 'Measured 2.1 KB; once per prompt (the persona no longer carries a second copy).' },
  { id: 'core-instructions', title: 'Your core instructions', part: 'context', cap: Math.round(7.5 * KB), versioned: true,
    holds: 'the rest of your core instructions',
    why: 'Versioned. The user\'s words up to ORG_INSTRUCTIONS_MAX (4,000 characters) with their tags and Walnut\'s default after an agent\'s; today 1.9 to 2.1 KB.' },
  { id: 'tools', title: 'How Walnut and its tools reach you', part: 'context', cap: Math.round(1.4 * KB),
    holds: 'the rest of how Walnut and its tools reach you',
    why: 'The ops paragraph (737 B) and the one-line tool map (about 420 B).' },
  { id: 'work-rules', title: 'How this session works', part: 'context', cap: Math.round(4.6 * KB),
    holds: 'the later rules of how this session works',
    why: 'The work, waiting, inbox, private-task, acknowledgement and one-team rules measured 2.6 to 4.2 KB by role.' },
  { id: 'task-dir', title: 'Your task directory', part: 'context', cap: 600, state: true,
    holds: 'the rest of the task directory line',
    why: 'One path and a sentence.' },
  { id: 'where-work-lives', title: 'Where work lives', part: 'context', cap: Math.round(1.1 * KB),
    holds: 'the later rules of where work lives',
    why: 'Measured 951 B.' },
  { id: 'fleet', title: 'Your machines', part: 'context', cap: 2 * KB, state: true,
    holds: 'the rest of the machines you can use',
    why: 'One line per host; a big fleet keeps the first hosts and reads the rest on demand.' },
  { id: 'how-we-work', title: 'How we work', part: 'context', cap: Math.round(5.6 * KB),
    holds: 'the later charter rules',
    why: 'The team charter measured 5.3 KB; every bullet is a rule the same for every role, so it stays whole.' },
  { id: 'user-profile', title: 'Your user', part: 'context', cap: 6 * KB, versioned: true,
    holds: 'the rest of the user\'s profile',
    why: 'Versioned. USER.md capped at USER_CHAR_BUDGET (4,000 characters) with a version tag per line; measured 4.6 KB.' },
  // ── MCP server instructions (src/mcp/instructions.ts): Claude Code puts them in the system prompt too ──
  { id: 'mcp-instructions', title: 'Walnut MCP instructions', part: 'mcp', cap: 2 * KB,
    holds: '',
    why: 'Read by every MCP client of Walnut, a session without Walnut\'s prompt included; trimmed from 2.5 KB to the lifecycle rules and the tool map (1.9 KB).' },
] as const

export type PromptBlockId = string

const BY_ID = new Map(PROMPT_BLOCKS.map((b) => [b.id, b]))

export function promptBlock(id: PromptBlockId): PromptBlockDef {
  const def = BY_ID.get(id)
  if (!def) throw new Error(`Prompt block "${id}" has no entry in PROMPT_BLOCKS (src/core/sessions/prompt-blocks.ts)`)
  return def
}

/**
 * The folder file a block's moved rest is written to: `<block>.<hash of the rest>.md`. The hash
 * keeps two texts of one block apart in one folder (the persona's blocks go to the shared folder,
 * where the Personal AI and Mentor, or a lane with USER.md and one without, would otherwise
 * overwrite each other), and the name in the pointer is the exact text that pointer cut.
 */
export function overflowFileOf(id: PromptBlockId, rest: string): string {
  return `${id}.${createHash('sha1').update(rest).digest('hex').slice(0, 8)}.md`
}

/** A file Walnut owns in a memory folder, and which block (a node's own note may not take such a name). */
export function walnutFolderBlock(name: string): PromptBlockId | null {
  const m = /^([a-z-]+)(?:\.[0-9a-f]{8})?\.md$/.exec(name)
  return m && BY_ID.has(m[1]!) ? m[1]! : null
}

/**
 * The whole appended prompt (persona and session context) of each kind of session, with a
 * realistic full load (a 4 KB USER.md, a 10 KB MEMORY.md, 60 skills, a long title; the fixture
 * in tests/helpers/prompt-size-fixture.ts). Measured on that load (scripts/prompt-sizes.ts):
 * before the registry Main 83.6 KB (90.7 KB in the real session, whose skills index alone was 49 KB),
 * a lead 31.2 KB, a worker 15.6 KB, an ask 66.0 KB; with it Main 39.4 KB, a lead 26.3 KB, a worker
 * 16.0 KB (the one-line tool map), an ask 29.2 KB. Each
 * budget is that plus about 1.5 KB, so text added anywhere fails the guard until something else
 * moves out. What stays whole on purpose: the team charter (5.3 KB, the same rules for every
 * role), the routing rules (2.1 KB), the role lines, and the user's own words (USER.md, a role's
 * core instructions), none of which a head cut could shorten without dropping a rule.
 */
export const PROMPT_BUDGETS = {
  main: 40 * KB,
  lead: 27 * KB,
  worker: 17 * KB,
  ask: 30 * KB,
} as const

export interface PromptOverflow {
  id: PromptBlockId
  file: string
  title: string
  part: PromptPart
  /** The moved text, as the folder file holds it after its heading. */
  text: string
  bytes: number
}

export interface CapResult {
  text: string
  overflow: PromptOverflow | null
}

export const byteLength = (s: string): number => Buffer.byteLength(s, 'utf8')

/** The pointer line's opening words: instruction-diff and tests know a pointer by them. */
export const POINTER_OPENING = '(Walnut moved the rest of this section to your memory folder'

/** Headings found in the moved text, for the pointer: a short index of what moved. */
function headingsOf(rest: string): string {
  const heads = [...rest.matchAll(/^#{1,4}\s+(.+?)\s*$/gm)].map((m) => m[1]!.replace(/[*_`]/g, '').trim()).filter(Boolean)
  if (!heads.length) return ''
  let out = ''
  for (const h of heads) {
    const next = out ? `${out}; ${h}` : h
    if (byteLength(next) > 320) return ` (${out}; and more)`
    out = next
  }
  return ` (${out})`
}

export function pointerLine(def: PromptBlockDef, rest: string, opts: { short?: boolean } = {}): string {
  const file = overflowFileOf(def.id, rest)
  const holds = def.holds && !opts.short ? `: ${def.holds}` : ''
  return `${POINTER_OPENING} as ${file}, ${byteLength(rest).toLocaleString('en-US')} bytes${holds}${opts.short ? '' : headingsOf(rest)}. `
    + `Read it with agent_memory_read {"file":"${file}"} before you act on that part.)`
}

/** Offsets where a cut may fall, after a paragraph, a line or a sentence, ascending. */
function cutPoints(body: string): number[] {
  const points = new Set<number>()
  for (const m of body.matchAll(/\n/g)) points.add(m.index! + 1)
  for (const m of body.matchAll(/[.!?:;](?:["')\]`]*)\s+(?=["'(<\[`*A-Z-])/g)) points.add(m.index! + m[0].length)
  return [...points].filter((p) => p > 0 && p < body.length).sort((a, b) => a - b)
}

/**
 * The block as the prompt carries it: whole within its cap, else its head and a pointer to the
 * moved rest (see the header). Pure.
 */
export function capBlock(id: PromptBlockId, text: string): CapResult {
  const def = promptBlock(id)
  if (!text || byteLength(text) <= def.cap || def.versioned || def.part === 'mcp') return { text, overflow: null }
  const trail = /\s*$/.exec(text)![0]
  const body = text.slice(0, text.length - trail.length)
  const points = cutPoints(body)
  let head = ''
  let rest = body.trim()
  for (let i = points.length - 1; i >= 0; i--) {
    const h = body.slice(0, points[i]).trimEnd()
    const r = body.slice(points[i]).trim()
    if (byteLength(h) + 1 + byteLength(pointerLine(def, r)) + byteLength(trail) <= def.cap) { head = h; rest = r; break }
  }
  // No cut leaves room: the whole block moves, under the shortest pointer.
  const pointer = head ? pointerLine(def, rest) : pointerLine(def, rest, { short: true })
  return {
    text: `${head ? `${head}\n` : ''}${pointer}${trail}`,
    overflow: { id: def.id, file: overflowFileOf(def.id, rest), title: def.title, part: def.part, text: rest, bytes: byteLength(rest) },
  }
}

export interface ComposedBlock { id: PromptBlockId; text: string; bytes: number; capped: boolean }

/**
 * Builds a prompt only out of registered blocks: every byte of `text()` is some block's. Adding
 * an empty block is a no-op, so a block that applies to one role only adds nothing elsewhere.
 */
export class PromptComposer {
  readonly blocks: ComposedBlock[] = []
  readonly overflows: PromptOverflow[] = []

  /**
   * `uncapped`: every block whole, as a prompt from before the caps read (a prompt read where no
   * memory folder can be, tests of what a running session is told). WALNUT_PROMPT_CAPS=0 turns the
   * caps off everywhere.
   */
  constructor(private readonly opts: { uncapped?: boolean } = {}) {
    if (process.env.WALNUT_PROMPT_CAPS === '0') this.opts = { ...opts, uncapped: true }
  }

  add(id: PromptBlockId, text: string | undefined | null): this {
    if (!text) { promptBlock(id); return this }
    const r = this.opts.uncapped ? (promptBlock(id), { text, overflow: null }) : capBlock(id, text)
    this.blocks.push({ id, text: r.text, bytes: byteLength(r.text), capped: !!r.overflow })
    if (r.overflow) this.overflows.push(r.overflow)
    return this
  }

  text(): string {
    return this.blocks.map((b) => b.text).join('')
  }
}
