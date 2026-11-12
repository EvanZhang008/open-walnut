/**
 * Every block of Walnut's own text that a session carries on EVERY request (its appended
 * system prompt), each with a cap, measured in characters (as the builders' own budgets are:
 * USER_CHAR_BUDGET, ORG_INSTRUCTIONS_MAX), so text in any script is held the same way.
 *
 * 2026-11-12, the user: "programmatically restrict the length of the always loading thing,
 * u can create some kind memory folder u can add it there, all walnut CEO / VP need to do the
 * similar". Measured the day before: Main carried 90.7 KB on every request (a 49 KB skills
 * index in XML, the task routing, the charter and where work lives twice, the whole global
 * MEMORY.md), a lead about 31 KB. A rule in a prompt does not keep a prompt short; a cap does.
 *
 * Three kinds of block, and only one is ever cut:
 * - `rules`: Walnut's own rules. Never cut, because a rule moved out of the prompt is a rule
 *   the session does not follow in the turn it applies (2026-11-12 review: a head cut of the
 *   org manuals moved "one place per update" and the proof-in-place rule into a file). Its cap
 *   is a ceiling the guard holds: text added to a rule block fails the guard until something
 *   else gets shorter. Over its cap at runtime it is kept whole and logged.
 * - `user`: the user's own words (USER.md, a role's core instructions, a console agent's own
 *   persona). Never cut either: their builders cap them, and the cap here is the ceiling those
 *   allow. A versioned one is diffed line by line by the instruction notice besides.
 * - `list`: what grows with the install (the skills index, the global MEMORY.md, an agent's
 *   context sources, the fleet). Over its cap it keeps its head, cut at the last paragraph,
 *   line or sentence that fits, and one pointer line in place of the rest, saying how much
 *   moved, what it holds (its headings) and the op that reads it; the rest becomes a file in
 *   the node's memory folder (memory-folder.ts), written by the async builders
 *   (buildSessionContext, buildLaneProfile), which log every block they moved. The cut is a
 *   pure function of the text, so the default instructions instruction-notice.ts compares stay
 *   deterministic.
 *
 * WALNUT_PROMPT_CAPS=0 is the rollback switch (promptRollback): every session prompt as it was
 * before this registry (no cut, the persona's own copy of the charter and routing rules, the
 * XML skills index, the MCP instructions without the on-demand line).
 *
 * The guard (tests/core/sessions/prompt-blocks-guard.test.ts) fails when a block outgrows its
 * cap, a composed prompt outgrows its role's budget, a named rule ends up in a memory folder
 * file, or text reaches the prompt outside a registered block.
 */

/** Which half of the appended prompt a block rides: the persona (profiles.ts) or Walnut's session context (session-context.ts). */
export type PromptPart = 'persona' | 'context' | 'mcp'

/** See the header: only a `list` block is ever cut. */
export type PromptBlockKind = 'rules' | 'user' | 'list'

export interface PromptBlockDef {
  id: string
  /** As the pointer and the folder file name it. */
  title: string
  part: PromptPart
  kind: PromptBlockKind
  /** Characters (UTF-16 code units, String.length), the block's own trailing blank line included. */
  cap: number
  /** What the moved rest holds, in a few words, for the pointer line (a `list` block). */
  holds: string
  /** Describes this task right now (title, place, directory, fleet): left out of the default instructions. */
  state?: boolean
  /** Why this cap, against what it measured (2026-11-12). */
  why: string
}

import { createHash } from 'node:crypto'
import { log } from '../../logging/index.js'

/** WALNUT_PROMPT_CAPS=0: every session prompt as it was before the registry (see the header). Read on each call. */
export const promptRollback = (): boolean => process.env.WALNUT_PROMPT_CAPS === '0'

/**
 * The registry, in the order the blocks reach the prompt. A cap is the measured size of
 * today's text at its builder's limit plus a small margin, so growth fails the guard first;
 * a `list` cap is the room its head keeps.
 */
export const PROMPT_BLOCKS: readonly PromptBlockDef[] = [
  // ── persona half (profiles.ts) ──
  { id: 'persona', title: 'Persona and operating contract', part: 'persona', kind: 'rules', cap: 3_200,
    holds: '',
    why: 'Header, identity line, operating contract and board model: 2.9 K once the parts the session context carries left it.' },
  { id: 'standing-user', title: 'Standing memory: the user profile', part: 'persona', kind: 'user', cap: 4_600,
    holds: '',
    why: 'Only where no session context carries the user\'s profile (an ACP lane, a taskless lane): the standing memory\'s head lines and USER.md, held to USER_CHAR_BUDGET (4,000 characters) by the memory store.' },
  { id: 'standing-memory', title: 'Standing memory: the global MEMORY.md', part: 'persona', kind: 'list', cap: 4_500,
    holds: 'the later sections of the global MEMORY.md',
    why: 'The global MEMORY.md measured 10 K (its own budget is 8,000 characters); its first sections are the standing rules, the rest is read on demand.' },
  { id: 'skills-index', title: 'Walnut skills index', part: 'persona', kind: 'list', cap: 7_000,
    holds: 'the rest of the skills index',
    why: 'One line of at most 90 characters per skill: 56 real skills measured 6.0 K (the XML form with whole descriptions and paths was 30 to 49 K).' },
  { id: 'agent-persona', title: 'Agent persona', part: 'persona', kind: 'user', cap: 6_000,
    holds: '',
    why: 'A console agent\'s own system prompt, written in its definition by the user.' },
  { id: 'agent-context', title: 'Agent context', part: 'persona', kind: 'list', cap: 4_500,
    holds: 'the rest of this agent\'s context sources',
    why: 'A console agent\'s own memory and context sources: the same room as the standing memory.' },
  // ── session context half (session-context.ts), in order ──
  { id: 'identity', title: 'Who opened this session', part: 'context', kind: 'rules', cap: 400,
    holds: '',
    why: 'The opening paragraph measured 237.' },
  { id: 'task-state', title: 'Your task', part: 'context', kind: 'rules', cap: 3_000, state: true,
    holds: '',
    why: 'Title, place, leader and workers: under 1.5 K with a long title and a reviewer line.' },
  { id: 'own-notes', title: 'Your own notes', part: 'context', kind: 'rules', cap: 1_300, state: true,
    holds: '',
    why: 'The names and sizes of a node\'s own note files, at most 12 listed: 1.2 K at 12 of the longest names.' },
  { id: 'org-role', title: 'Your role', part: 'context', kind: 'rules', cap: 15_200,
    holds: '',
    why: 'Main\'s role lines with the away, Brief, Threads and walnut-about rules measured 14.6 K, a lead\'s 12.8 K: every line applies in every turn.' },
  { id: 'task-routing', title: 'Task routing', part: 'context', kind: 'rules', cap: 2_400,
    holds: '',
    why: 'Measured 2.1 K; once per prompt (the persona no longer carries a second copy).' },
  { id: 'core-instructions', title: 'Your core instructions', part: 'context', kind: 'user', cap: 7_500,
    holds: '',
    why: 'Versioned. The user\'s words up to ORG_INSTRUCTIONS_MAX (4,000 characters) with their tags and Walnut\'s default after an agent\'s; today 1.9 to 2.1 K.' },
  { id: 'tools', title: 'How Walnut and its tools reach you', part: 'context', kind: 'rules', cap: 900,
    holds: '',
    why: 'The ops paragraph measured 737.' },
  { id: 'work-rules', title: 'How this session works', part: 'context', kind: 'rules', cap: 4_600,
    holds: '',
    why: 'The work, waiting, inbox, private-task, acknowledgement and one-team rules measured 2.6 to 4.2 K by role.' },
  { id: 'task-dir', title: 'Your task directory', part: 'context', kind: 'rules', cap: 600, state: true,
    holds: '',
    why: 'One path and a sentence.' },
  { id: 'where-work-lives', title: 'Where work lives', part: 'context', kind: 'rules', cap: 1_100,
    holds: '',
    why: 'Measured 951.' },
  { id: 'fleet', title: 'Your machines', part: 'context', kind: 'list', cap: 2_000, state: true,
    holds: 'the rest of the machines you can use',
    why: 'One line per host; a big fleet keeps the first hosts and reads the rest on demand.' },
  { id: 'how-we-work', title: 'How we work', part: 'context', kind: 'rules', cap: 5_600,
    holds: '',
    why: 'The team charter measured 5.3 K; every bullet is a rule the same for every role.' },
  { id: 'user-profile', title: 'Your user', part: 'context', kind: 'user', cap: 6_000,
    holds: '',
    why: 'Versioned. USER.md capped at USER_CHAR_BUDGET (4,000 characters) with a version tag per line; measured 4.6 K.' },
  // ── MCP server instructions (src/mcp/instructions.ts): Claude Code puts them in the system prompt too ──
  { id: 'mcp-instructions', title: 'Walnut MCP instructions', part: 'mcp', kind: 'rules', cap: 3_000,
    holds: '',
    why: 'Read by every MCP client of Walnut, a session without Walnut\'s prompt included: the lifecycle rules, how the tools load on demand and which is for what (2.9 K).' },
] as const

export type PromptBlockId = string

const BY_ID = new Map(PROMPT_BLOCKS.map((b) => [b.id, b]))

export function promptBlock(id: PromptBlockId): PromptBlockDef {
  const def = BY_ID.get(id)
  if (!def) throw new Error(`Prompt block "${id}" has no entry in PROMPT_BLOCKS (src/core/sessions/prompt-blocks.ts)`)
  return def
}

/**
 * The folder file a block's moved rest is written to: `<block>[--<scope>].<hash of the rest>.md`.
 * The hash keeps two texts of one block apart in one folder, and the name in the pointer is the
 * exact text that pointer cut. The scope is the console agent a persona belongs to: the persona's
 * blocks go to the shared folder, where the Personal AI's and Mentor's would otherwise be taken for
 * versions of one another (memory-folder.ts answers a pointer to a gone version with the current
 * file of the same block and scope).
 */
export function overflowFileOf(id: PromptBlockId, rest: string, scope?: string): string {
  const s = scopeKey(scope)
  return `${id}${s ? `--${s}` : ''}.${createHash('sha1').update(rest).digest('hex').slice(0, 8)}.md`
}

/** A scope as a file name may carry it: lowercase letters, digits and single dashes. */
function scopeKey(scope: string | undefined): string {
  return (scope ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 24).replace(/^-+|-+$/g, '')
}

const WALNUT_FILE_RE = /^([a-z]+(?:-[a-z]+)*)(?:--([a-z0-9]+(?:-[a-z0-9]+)*))?(?:\.[0-9a-f]{8})?\.md$/

/** A file Walnut owns in a memory folder, and which block (a node's own note may not take such a name). */
export function walnutFolderBlock(name: string): PromptBlockId | null {
  const m = WALNUT_FILE_RE.exec(name)
  return m && BY_ID.has(m[1]!) ? m[1]! : null
}

/** The block and scope of a Walnut file name ('' scope for a task's own), or null. */
export function walnutFileKey(name: string): { block: PromptBlockId; scope: string } | null {
  const m = WALNUT_FILE_RE.exec(name)
  return m && BY_ID.has(m[1]!) ? { block: m[1]!, scope: m[2] ?? '' } : null
}

/**
 * The whole appended prompt (persona and session context) of each kind of session, in
 * characters. Measured by scripts/prompt-sizes.ts on a realistic full load (a 4,000-character
 * USER.md, a 10 K MEMORY.md, 60 skills, a long title; tests/helpers/prompt-size-fixture.ts):
 *
 *            before the registry   now
 *   Main          83.6 K           44.2 K   (the real session was 90.7 K, its skills index alone 49 K)
 *   a lead        31.2 K           31.2 K   (every line of a lead's prompt is a rule: nothing cut)
 *   a worker      15.6 K           15.6 K
 *   an ask        66.0 K           28.7 K
 *
 * Main and an ask lost the persona's second copy of the charter, where work lives and the
 * routing rules (8.3 K), the XML skills index (31.6 K here, 4.6 K as one line per skill) and the
 * later sections of the global MEMORY.md. Each budget is that, plus the room the user's own
 * words may still grow into at their builders' limits (the user profile to its 6,000 cap, a
 * role's core instructions to 7,500 for Main and a lead), plus 1,000: Walnut text added
 * anywhere fails its block's cap first, and this whole-prompt ceiling after.
 */
export const PROMPT_BUDGETS = {
  main: 52_500,
  lead: 39_800,
  worker: 18_500,
  ask: 31_600,
} as const

export interface PromptOverflow {
  id: PromptBlockId
  file: string
  title: string
  part: PromptPart
  /** The moved text, as the folder file holds it after its heading. */
  text: string
  chars: number
}

export interface CapResult {
  text: string
  overflow: PromptOverflow | null
}

export const byteLength = (s: string): number => Buffer.byteLength(s, 'utf8')
/** How caps and budgets measure (see the header). */
export const charLength = (s: string): number => s.length

/** The pointer line's opening words: how a pointer is known in a prompt (the tests read it). */
export const POINTER_OPENING = '(Walnut moved the rest of this section to your memory folder'

/** Headings found in the moved text, for the pointer: a short index of what moved. */
function headingsOf(rest: string): string {
  const heads = [...rest.matchAll(/^#{1,4}\s+(.+?)\s*$/gm)].map((m) => m[1]!.replace(/[*_`]/g, '').trim()).filter(Boolean)
  if (!heads.length) return ''
  let out = ''
  for (const h of heads) {
    const next = out ? `${out}; ${h}` : h
    if (charLength(next) > 320) return ` (${out}; and more)`
    out = next
  }
  return ` (${out})`
}

export function pointerLine(def: PromptBlockDef, rest: string, opts: { short?: boolean; scope?: string } = {}): string {
  const file = overflowFileOf(def.id, rest, opts.scope)
  const holds = def.holds && !opts.short ? `: ${def.holds}` : ''
  return `${POINTER_OPENING} as ${file}, ${charLength(rest).toLocaleString('en-US')} characters${holds}${opts.short ? '' : headingsOf(rest)}. `
    + `Read it with agent_memory_read {"file":"${file}"} before you act on that part.)`
}

/** Offsets where a cut may fall, after a paragraph, a line or a sentence, ascending. */
function cutPoints(body: string): number[] {
  const points = new Set<number>()
  for (const m of body.matchAll(/\n/g)) points.add(m.index! + 1)
  for (const m of body.matchAll(/[.!?:;](?:["')\]`]*)\s+(?=["'(<\[`*A-Z-])/g)) points.add(m.index! + m[0].length)
  return [...points].filter((p) => p > 0 && p < body.length).sort((a, b) => a - b)
}

/** A rule or user block over its cap, said once per block and process: the guard is where it is fixed. */
const warnedOver = new Set<string>()

/**
 * The block as the prompt carries it: whole within its cap, and whole always unless it is a
 * `list` block; a `list` block over its cap is its head and a pointer to the moved rest (see
 * the header). Pure, apart from the one log line for a rule block over its cap.
 */
export function capBlock(id: PromptBlockId, text: string, scope?: string): CapResult {
  const def = promptBlock(id)
  if (!text || charLength(text) <= def.cap) return { text, overflow: null }
  if (def.kind !== 'list') {
    if (!warnedOver.has(id)) {
      warnedOver.add(id)
      log.session.warn('prompt block over its cap, kept whole (never cut: see prompt-blocks.ts)', { block: id, kind: def.kind, chars: charLength(text), cap: def.cap })
    }
    return { text, overflow: null }
  }
  const trail = /\s*$/.exec(text)![0]
  const body = text.slice(0, text.length - trail.length)
  const points = cutPoints(body)
  let head = ''
  let rest = body.trim()
  for (let i = points.length - 1; i >= 0; i--) {
    const h = body.slice(0, points[i]).trimEnd()
    const r = body.slice(points[i]).trim()
    if (charLength(h) + 1 + charLength(pointerLine(def, r, { scope })) + charLength(trail) <= def.cap) { head = h; rest = r; break }
  }
  // No cut leaves room: the whole block moves, under the shortest pointer.
  const pointer = pointerLine(def, rest, { scope, short: !head })
  return {
    text: `${head ? `${head}\n` : ''}${pointer}${trail}`,
    overflow: { id: def.id, file: overflowFileOf(def.id, rest, scope), title: def.title, part: def.part, text: rest, chars: charLength(rest) },
  }
}

export interface ComposedBlock { id: PromptBlockId; text: string; chars: number; bytes: number; capped: boolean }

/**
 * Builds a prompt only out of registered blocks: every character of `text()` is some block's.
 * Adding an empty block is a no-op, so a block that applies to one role only adds nothing elsewhere.
 */
export class PromptComposer {
  readonly blocks: ComposedBlock[] = []
  readonly overflows: PromptOverflow[] = []

  /**
   * `uncapped`: every block whole (a prompt read where no memory folder can be: the companion,
   * the personas copy a host replica reads). The rollback switch (promptRollback) is uncapped too.
   */
  constructor(private readonly opts: { uncapped?: boolean; scope?: string } = {}) {
    if (promptRollback()) this.opts = { ...opts, uncapped: true }
  }

  add(id: PromptBlockId, text: string | undefined | null): this {
    if (!text) { promptBlock(id); return this }
    const r = this.opts.uncapped ? (promptBlock(id), { text, overflow: null }) : capBlock(id, text, this.opts.scope)
    this.blocks.push({ id, text: r.text, chars: charLength(r.text), bytes: byteLength(r.text), capped: !!r.overflow })
    if (r.overflow) this.overflows.push(r.overflow)
    return this
  }

  text(): string {
    return this.blocks.map((b) => b.text).join('')
  }
}

/**
 * How the spawn joins the parts of the appended prompt (src/providers/claude-code-session.ts): a
 * caller's own prompt (a SESSION_START with appendSystemPrompt) and Walnut's session context, then
 * the persona first. The only text Walnut adds outside a block is these separators; the guard holds
 * the spawn to these two functions.
 */
export const TASK_CONTEXT_SEPARATOR = '\n\n---\n\n## Task Context\n\n'


/** A caller's own prompt, then Walnut's session context under its heading; either alone as it is. */
export function joinCallerAndContext(callerPrompt: string | undefined, context: string): string {
  if (!context) return callerPrompt ?? ''
  return callerPrompt ? `${callerPrompt}${TASK_CONTEXT_SEPARATOR}${context}` : context
}

/** The whole `--append-system-prompt`: the persona, then the rest, each part once. */
export function joinAppendedPrompt(parts: ReadonlyArray<string | undefined | null>): string {
  return parts.filter((p): p is string => !!p).join('\n\n')
}
