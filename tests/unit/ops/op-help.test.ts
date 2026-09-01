/**
 * Unit test: how an op's PARAMETERS are rendered (src/ops/op-help.ts).
 *
 * This module is the shared answer to the two 2026-09-01 CLI complaints:
 * `tools list` printed names with no arguments (so agents guessed `query` vs
 * `q`), and the gateway's `tools help <op>` had no schema to print at all. Both
 * CLI faces render from here, so pin the rendering itself: pure, no socket, no
 * server.
 */
import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import {
  fieldType,
  formatOpHelp,
  formatParamSignature,
  formatToolsTable,
  opParams,
  wrapSignature,
  type ZodLike,
} from '../../../src/ops/op-help.js'
import { listOps } from '../../../src/ops/index.js'

const SHAPE: Record<string, ZodLike> = {
  q: z.string().min(1).describe('Search query') as unknown as ZodLike,
  mode: z.enum(['hybrid', 'string', 'semantic']).optional().describe('Search mode') as unknown as ZodLike,
  limit: z.number().int().optional() as unknown as ZodLike,
  all: z.boolean().default(false).describe('Everything') as unknown as ZodLike,
}

describe('fieldType / opParams', () => {
  it('unwraps optional + default, keeps the description, and spells enums out', () => {
    const params = opParams(SHAPE)
    expect(params).toEqual([
      { name: 'q', type: 'string', required: true, description: 'Search query' },
      { name: 'mode', type: 'hybrid | string | semantic', required: false, description: 'Search mode' },
      { name: 'limit', type: 'number', required: false, description: undefined },
      { name: 'all', type: 'boolean', required: false, description: 'Everything' },
    ])
  })

  it('survives a schema it cannot introspect instead of throwing', () => {
    expect(fieldType({} as ZodLike)).toEqual({ type: 'unknown', required: true, description: undefined })
  })
})

describe('formatParamSignature', () => {
  it('marks optional params with ? and says (none) for an argument-less op', () => {
    expect(formatParamSignature(opParams(SHAPE))).toBe('q, mode?, limit?, all?')
    expect(formatParamSignature([])).toBe('(none)')
    expect(formatParamSignature(undefined)).toBe('(none)')
  })
})

describe('wrapSignature', () => {
  it('wraps at the width and never drops a name (truncation would hide arguments)', () => {
    const names = Array.from({ length: 20 }, (_, i) => `param_number_${i}?`).join(', ')
    const lines = wrapSignature(`args: ${names}`, 60, '    ')
    expect(lines.length).toBeGreaterThan(1)
    for (const line of lines) expect(line.startsWith('    ')).toBe(true)
    // Every original token survives somewhere in the wrapped output.
    const joined = lines.join(' ')
    for (let i = 0; i < 20; i++) expect(joined).toContain(`param_number_${i}?`)
  })
})

describe('formatToolsTable', () => {
  it('marks read/write and local-only ops, and handles an empty catalog', () => {
    const out = formatToolsTable([
      { name: 'task_list', title: 'List tasks', readonly: true, remote: 'allow' },
      { name: 'session_send', title: 'Send a message to a session', readonly: false, remote: 'allow' },
      { name: 'task_delete', title: 'Delete a task', readonly: false, remote: 'deny' },
    ])
    expect(out).toContain('(read)')
    expect(out).toContain('write, local-only')
    expect(formatToolsTable([])).toBe('(no operations)')
  })

  it('prints each op\'s argument signature under its row', () => {
    const out = formatToolsTable([
      { name: 'note_read', title: 'Read a note', readonly: true, signature: 'path?, id?' },
    ])
    expect(out).toContain('args: path?, id?')
  })

  it('omits the args line for a row from an old hub that sent no signature', () => {
    const out = formatToolsTable([{ name: 'note_read', title: 'Read a note', readonly: true }])
    expect(out).not.toContain('args:')
  })
})

describe('formatOpHelp', () => {
  it('renders description, every parameter, and the three call forms', () => {
    const out = formatOpHelp({
      name: 'note_read',
      description: 'Read one note.',
      params: opParams(SHAPE),
    })
    expect(out).toContain('note_read')
    expect(out).toContain('Read one note.')
    expect(out).toContain('q (string, required)')
    expect(out).toContain('mode (hybrid | string | semantic, optional)')
    expect(out).toContain('Search query')
    expect(out).toContain('walnut tools call note_read \'{"q":"value"}\'')
    expect(out).toContain('walnut tools call note_read @/tmp/args.json')
  })

  it('distinguishes "takes no parameters" from "this server did not tell me"', () => {
    expect(formatOpHelp({ name: 'walnut_status', params: [] })).toContain('Parameters: none')
    const old = formatOpHelp({ name: 'walnut_status' })
    expect(old).toContain('not reported by this Walnut server')
  })
})

describe('every registry op renders a signature', () => {
  it('no op is left with an unrenderable schema (the guess-the-argument bug)', () => {
    for (const op of listOps()) {
      const params = opParams(op.input)
      const signature = formatParamSignature(params)
      expect(signature.length, op.name).toBeGreaterThan(0)
      // 'unknown' means fieldType could not read the schema: the catalog would
      // then advertise a type nobody can act on.
      for (const p of params) expect(p.type, `${op.name}.${p.name}`).not.toBe('unknown')
    }
  })
})
