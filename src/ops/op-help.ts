/**
 * op-help.ts — how an operation's PARAMETERS are rendered, for every CLI face.
 *
 * Two faces print the catalog and one op's detail: the hub CLI
 * (src/commands/tools.ts, reads the registry directly) and the in-session
 * `walnut` CLI (src/providers/wn-cli.ts, gets rows over the daemon gateway).
 * They used to render independently, and the gateway face had no schema at all
 * — so `walnut tools list` printed names with no arguments and agents guessed
 * (`query` vs `q`, `id` vs `path`, `note` vs `description`), which is the bug
 * this module exists to end. Both faces now render from HERE.
 *
 * PURE and dependency-free on purpose: this file is bundled into the daemon
 * binary through wn-cli.ts, so it must not pull zod (or anything else) into
 * that bundle. The zod shape is read structurally through `ZodLike`.
 *
 * ⚠️ Bundled into the daemon → this path is listed in BOTH daemon hash lists
 * (scripts/build-daemon.sh + src/providers/daemon-version-check.ts). An edit
 * here must move the daemon version or no host self-upgrades.
 */

/** One parameter of an op, flattened for display. */
export interface OpParam {
  name: string
  /** Rendered type: 'string' | 'boolean' | 'a | b | c' | 'array' | … */
  type: string
  required: boolean
  description?: string
}

/** The structural slice of a zod schema this module reads (no zod import). */
export interface ZodLike {
  def?: { type?: string; entries?: Record<string, unknown> }
  description?: string
  unwrap?: () => ZodLike
}

/**
 * Render one zod field's type + requiredness (best-effort, not exhaustive).
 * Optional/default wrappers are unwrapped to reach the base type.
 */
export function fieldType(schema: ZodLike): { type: string; required: boolean; description?: string } {
  let cur: ZodLike = schema
  let required = true
  for (let i = 0; i < 5; i++) {
    const def = cur.def
    if ((def?.type === 'optional' || def?.type === 'default') && typeof cur.unwrap === 'function') {
      required = false
      cur = cur.unwrap()
    } else break
  }
  const def = cur.def
  let type = def?.type ?? 'unknown'
  if (type === 'enum' && def?.entries) type = Object.keys(def.entries).join(' | ')
  // The description lives on the OUTER schema (`.optional().describe(...)`
  // keeps it on the wrapper), so read it from the original, not from `cur`.
  return { type, required, description: schema.description ?? cur.description }
}

/** Flatten an op's zod input shape into display rows. */
export function opParams(input: Record<string, ZodLike>): OpParam[] {
  return Object.entries(input).map(([name, schema]) => {
    const f = fieldType(schema)
    return { name, type: f.type, required: f.required, description: f.description }
  })
}

/**
 * One-line parameter signature for the catalog: required names as-is, optional
 * names with a trailing `?`. Names only (no types) so the line stays scannable
 * even for a 30-parameter op — `tools help <op>` carries the types.
 */
export function formatParamSignature(params: OpParam[] | undefined): string {
  if (!params || params.length === 0) return '(none)'
  return params.map((p) => (p.required ? p.name : `${p.name}?`)).join(', ')
}

/** Soft-wrap a signature onto continuation lines instead of truncating it. */
export function wrapSignature(signature: string, width: number, indent: string): string[] {
  const words = signature.split(' ').filter(Boolean)
  const lines: string[] = []
  let cur = ''
  for (const w of words) {
    if (cur === '') cur = w
    else if (indent.length + cur.length + 1 + w.length <= width) cur += ` ${w}`
    else { lines.push(indent + cur); cur = w }
  }
  if (cur !== '') lines.push(indent + cur)
  return lines
}

/** A catalog row as both CLI faces know it (gateway JSON = this shape). */
export interface ToolRow {
  name: string
  title?: string
  description?: string
  readonly?: boolean
  remote?: string
  /** One-line `formatParamSignature` output (hub fills it; old hubs omit it). */
  signature?: string
  /** Full parameter rows — only sent for a single-op `tools help` request. */
  params?: OpParam[]
}

/** `read`/`write` + `local-only`, the access labels the catalog shows. */
function accessLabel(row: ToolRow): string {
  return [row.readonly ? 'read' : 'write', row.remote === 'deny' ? 'local-only' : null]
    .filter(Boolean).join(', ')
}

const CATALOG_WIDTH = 100

/**
 * The pointer back to the skill, printed under every catalog and every op help.
 *
 * A half-answer suppresses skill loading: an agent that gets a usable op name
 * from `tools list` never bounces out to the skill, so it keeps a wrong picture
 * of task-vs-session (real incident, 2026-08-31). The CLI therefore has to name
 * the skill at the exact moment it half-answers.
 */
export const SKILL_POINTER =
  'Model (task vs session) + recipes: walnut tools call skill_read \'{"dirName":"walnut"}\''

/**
 * The operations catalog: one line per op, plus an indented `args:` line
 * carrying its parameter signature. The signature is what stops an agent from
 * guessing argument names, so it is never truncated — long ones wrap.
 */
export function formatToolsTable(ops: ToolRow[]): string {
  if (ops.length === 0) return '(no operations)'
  const width = Math.max(...ops.map((o) => o.name.length))
  const lines: string[] = []
  for (const o of ops) {
    lines.push(`  ${o.name.padEnd(width)}  ${o.title ?? ''} (${accessLabel(o)})`)
    if (o.signature) {
      const indent = ' '.repeat(width + 4)
      const wrapped = wrapSignature(`args: ${o.signature}`, CATALOG_WIDTH, indent)
      lines.push(...wrapped)
    }
  }
  return [
    'Available operations:',
    '',
    ...lines,
    '',
    'Run `walnut tools help <op>`, then `walnut tools call <op> \'{json}\'`.',
    SKILL_POINTER,
  ].join('\n')
}

/**
 * One op's detail: description, every parameter with type/requiredness/help
 * text, and the three call forms. Printed by `tools help <op>` AND by
 * `tools call <op> --help` (an agent reaching for `--help` wants the schema,
 * not a JSON parse error).
 */
export function formatOpHelp(row: ToolRow): string {
  const lines: string[] = [row.name, '']
  if (row.description) lines.push(`  ${row.description}`, '')
  const params = row.params
  if (params === undefined) {
    // Old hub: the catalog row carried no schema. Say so instead of implying
    // the op takes no arguments.
    lines.push('Parameters: not reported by this Walnut server (upgrade it to see them)')
  } else if (params.length === 0) {
    lines.push('Parameters: none')
  } else {
    lines.push('Parameters:')
    for (const p of params) {
      lines.push(`  ${p.name} (${p.type}, ${p.required ? 'required' : 'optional'})`)
      if (p.description) lines.push(`    ${p.description}`)
    }
  }
  const example = params && params.length > 0 ? `'{"${params[0].name}":"value"}'` : `'{}'`
  lines.push(
    '',
    'Usage:',
    `  walnut tools call ${row.name} ${example}`,
    `  echo ${example} | walnut tools call ${row.name}`,
    `  walnut tools call ${row.name} @/tmp/args.json   # payloads over ~128KB must not go in argv`,
    '',
    SKILL_POINTER,
  )
  return lines.join('\n')
}
