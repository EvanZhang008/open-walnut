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
import {
  fieldType,
  formatOpHelp,
  formatParamSignature,
  formatToolsTable,
  opParams,
  type ZodLike,
} from '../ops/op-help.js'

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
    const t = fieldType(schema as ZodLike).type
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
    const rows = ops.map((o) => ({
      name: o.name,
      title: o.title,
      readonly: o.tags.readonly,
      remote: o.tags.remote,
      // The signature is the whole point of the catalog for an agent: without
      // it the next step is guessing `q` vs `query`.
      signature: formatParamSignature(opParams(o.input as Record<string, ZodLike>)),
    }))
    if (globals.json) {
      const { outputJson } = await import('../utils/json-output.js')
      outputJson(rows)
      return
    }
    console.log(formatToolsTable(rows))
    return
  }

  // `tools help <op>` and `tools call <op> --help` render the SAME detail.
  const printOpHelp = (name: string): boolean => {
    const op = getOp(name)
    if (!op) {
      console.error(`Unknown op: ${name}. Run \`walnut tools list\`.`)
      process.exitCode = 1
      return false
    }
    console.log(formatOpHelp({
      name: op.name,
      description: op.description,
      params: opParams(op.input as Record<string, ZodLike>),
    }))
    return true
  }

  if (sub === 'help') {
    const name = args[1]
    if (!name) {
      console.error('usage: walnut tools help <op>')
      process.exitCode = 1
      return
    }
    printOpHelp(name)
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

    // `--help` anywhere in a call means "show me the schema", never "parse me
    // as JSON". It used to reach the JSON parser and die with "JSON Parse
    // error", which reads as a broken CLI (2026-09-01 session).
    if (rest.includes('--help') || rest.includes('-h')) {
      printOpHelp(name)
      return
    }

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
