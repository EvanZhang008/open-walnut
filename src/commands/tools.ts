/**
 * `walnut tools` — the CLI face of the shared operation registry (src/ops/).
 *
 *   walnut tools list [--readonly]        catalog: name + one-line summary
 *   walnut tools help <op>                description, parameters, call syntax
 *   walnut tools call <op> ['{json}']     execute with inline JSON
 *   walnut tools call <op> @<file> | -    execute with the JSON from a file / stdin
 *
 * Same tools-list/help/call contract as other MCP-as-CLI binaries, so agents
 * that know that pattern can drive Walnut with zero new conventions. Output on
 * success is the op result as pretty JSON; errors go to stderr with exit 1.
 */

import { z } from 'zod'
import type { GlobalOptions } from '../core/types.js'

/** Render one zod field's type for help output (best-effort, not exhaustive). */
function fieldType(schema: z.ZodTypeAny): { type: string; required: boolean; description?: string } {
  let cur: z.ZodTypeAny = schema
  let required = true
  // Unwrap optional/default wrappers to reach the base type.
  for (let i = 0; i < 5; i++) {
    const def = (cur as { def?: { type?: string } }).def
    if (def?.type === 'optional' || def?.type === 'default') {
      required = false
      cur = (cur as unknown as { unwrap: () => z.ZodTypeAny }).unwrap()
    } else break
  }
  const def = (cur as { def?: { type?: string; entries?: Record<string, unknown> } }).def
  let type = def?.type ?? 'unknown'
  if (type === 'enum' && def?.entries) type = Object.keys(def.entries).join(' | ')
  return { type, required, description: schema.description }
}

/**
 * Parse `--flag value` pairs into args, coercing types from the op's zod
 * shape (number/boolean flags arrive typed; a bare boolean flag means true).
 * Mutates `out`; returns an error string on bad input, null on success.
 */
function parseFlagArgs(
  rest: string[],
  input: Record<string, z.ZodTypeAny>,
  out: Record<string, unknown>,
): string | null {
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i]
    if (!flag.startsWith('--')) return `unexpected argument: ${flag} (flags look like --status todo)`
    const key = flag.slice(2).replace(/-/g, '_')
    const schema = input[key]
    if (!schema) return `unknown flag --${flag.slice(2)} for this op (see \`walnut tools help\`)`
    const t = fieldType(schema).type
    if (t === 'boolean') {
      // --force or --force true/false
      const next = rest[i + 1]
      if (next === 'true' || next === 'false') { out[key] = next === 'true'; i++ }
      else out[key] = true
      continue
    }
    const value = rest[++i]
    if (value === undefined) return `flag --${flag.slice(2)} needs a value`
    if (t === 'number' || t === 'int') {
      const n = Number(value)
      if (!Number.isFinite(n)) return `flag --${flag.slice(2)} expects a number`
      out[key] = n
    } else if (t === 'array') {
      out[key] = value.split(',')
    } else {
      out[key] = value
    }
  }
  return null
}

export async function runTools(args: string[], globals: GlobalOptions): Promise<void> {
  const { listOps, getOp, executeOp } = await import('../ops/index.js')
  const sub = args[0]

  if (sub === 'list' || sub === undefined) {
    const readonly = args.includes('--readonly')
    const ops = listOps().filter((o) => !readonly || o.tags.readonly)
    if (globals.json) {
      const { outputJson } = await import('../utils/json-output.js')
      outputJson(ops.map((o) => ({ name: o.name, title: o.title, readonly: o.tags.readonly, remote: o.tags.remote })))
      return
    }
    console.log('Available operations:\n')
    const width = Math.max(...ops.map((o) => o.name.length))
    for (const op of ops) {
      const flags = [op.tags.readonly ? 'read' : 'write', op.tags.remote === 'deny' ? 'local-only' : null]
        .filter(Boolean).join(', ')
      console.log(`  ${op.name.padEnd(width)}  ${op.title} (${flags})`)
    }
    console.log('\nRun `walnut tools help <op>` for parameters, `walnut tools call <op> \'{json}\'` to execute.')
    return
  }

  if (sub === 'help') {
    const name = args[1]
    if (!name) {
      console.error('usage: walnut tools help <op>')
      process.exitCode = 1
      return
    }
    const op = getOp(name)
    if (!op) {
      console.error(`Unknown op: ${name}. Run \`walnut tools list\`.`)
      process.exitCode = 1
      return
    }
    console.log(`${op.name}\n`)
    console.log(`  ${op.description}\n`)
    const fields = Object.entries(op.input)
    if (fields.length === 0) {
      console.log('Parameters: none')
    } else {
      console.log('Parameters:')
      for (const [key, schema] of fields) {
        const f = fieldType(schema)
        console.log(`  ${key} (${f.type}, ${f.required ? 'required' : 'optional'})`)
        if (f.description) console.log(`    ${f.description}`)
      }
    }
    console.log('\nUsage:')
    const example = fields.length > 0
      ? `'{"${fields[0][0]}":"value"}'`
      : `'{}'`
    console.log(`  walnut tools call ${op.name} ${example}`)
    console.log(`  echo ${example} | walnut tools call ${op.name}`)
    console.log(`  walnut tools call ${op.name} @/tmp/args.json   # payloads over ~128KB must not go in argv`)
    return
  }

  if (sub === 'call') {
    const name = args[1]
    if (!name) {
      console.error('usage: walnut tools call <op> [\'{json}\' | --flag value ...]')
      process.exitCode = 1
      return
    }
    const op = getOp(name)
    const rest = args.slice(2)
    let parsed: Record<string, unknown> = {}

    if (rest[0]?.startsWith('--')) {
      // Human-friendly flag form: --status todo --q "login bug". Types are
      // coerced from the op's own zod shape, so numbers and booleans arrive
      // typed exactly as the JSON form would deliver them.
      if (!op) {
        console.error(`Unknown op: ${name}. Run \`walnut tools list\`.`)
        process.exitCode = 1
        return
      }
      const flagErr = parseFlagArgs(rest, op.input, parsed)
      if (flagErr) {
        console.error(flagErr)
        process.exitCode = 1
        return
      }
    } else {
      // Inline JSON, @file, - (stdin), or a piped stdin — one rule set shared
      // with the in-session `walnut` CLI (providers/tool-args-source.ts). A
      // payload over ~128KB must use @file or stdin: the kernel rejects an argv
      // entry that big before this process starts.
      const { classifyArgsSource, parseToolArgs } = await import('../providers/tool-args-source.js')
      const source = classifyArgsSource(rest[0], process.stdin.isTTY === true)
      if (source.kind === 'usage-error') {
        console.error(source.message)
        process.exitCode = 1
        return
      }
      let rawJson = ''
      if (source.kind === 'inline') rawJson = source.json
      else if (source.kind === 'stdin') {
        rawJson = await new Promise<string>((resolve) => {
          let buf = ''
          process.stdin.setEncoding('utf-8')
          process.stdin.on('data', (c) => { buf += c })
          process.stdin.on('end', () => resolve(buf))
        })
      } else if (source.kind === 'file') {
        const fsp = await import('node:fs/promises')
        try {
          rawJson = await fsp.readFile(source.path, 'utf-8')
        } catch (err) {
          console.error(`cannot read arguments from ${source.path}: ${err instanceof Error ? err.message : String(err)}`)
          process.exitCode = 1
          return
        }
      }
      const args = parseToolArgs(rawJson)
      if (!args.ok) {
        console.error(args.message)
        process.exitCode = 1
        return
      }
      parsed = args.args
    }
    const r = await executeOp(name, parsed)
    if (!r.ok) {
      console.error(r.message)
      process.exitCode = 1
      return
    }
    // A 200 with an EMPTY body leaves result undefined, and JSON.stringify would
    // print the literal string "undefined" with exit 0 — indistinguishable from a
    // real answer to a caller that only checks the status. Say it and fail.
    if (r.result === undefined) {
      console.error(`${name} returned an empty response body (no JSON) — the server answered 200 with nothing`)
      process.exitCode = 1
      return
    }
    console.log(JSON.stringify(r.result, null, 2))
    return
  }

  console.error(`unknown tools subcommand: ${sub} (expected list | help | call)`)
  process.exitCode = 1
}
