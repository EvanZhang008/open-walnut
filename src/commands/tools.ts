/**
 * `walnut tools` — the CLI face of the shared operation registry (src/ops/).
 *
 *   walnut tools list [--readonly] [--group <group>]   catalog by group: name + one-line summary
 *   walnut tools help <op>                description, parameters, call syntax
 *   walnut tools call <op> ['{json}']     execute with inline JSON
 *   walnut tools call <op> @<file> | -    execute with the JSON from a file / stdin
 *
 * Same tools-list/help/call contract as other MCP-as-CLI binaries, so agents
 * that know that pattern can drive Walnut with zero new conventions. Output on
 * success is the op result as pretty JSON. A failed call prints ONE JSON object
 * ({"ok":false,"error":{code,message,detail?}}) on stderr, or on stdout with
 * --json (src/providers/tool-call-output.ts); the exit codes are unchanged.
 */

import { z } from 'zod'
import type { GlobalOptions } from '../core/types.js'
import { noteSessionAnswered, noteSessionFailure } from '../providers/session-no-answer.js'
import {
  fieldType,
  formatOpHelp,
  formatParamSignature,
  formatToolsTable,
  inGroup,
  opParams,
  type ToolRow,
  type ZodLike,
} from '../ops/op-help.js'

/** One `tools list` row; core and plugin ops render the same way. */
type ToolsListRow = Required<Pick<ToolRow, 'name' | 'title' | 'readonly' | 'remote' | 'signature' | 'group'>>

/**
 * Parse `--flag value` pairs into args, coercing types from the op's zod
 * shape (number/boolean flags arrive typed; a bare boolean flag means true).
 * Mutates `out`; returns an error string on bad input, null on success.
 */
function parseFlagArgs(
  rest: string[],
  input: Record<string, z.ZodTypeAny>,
  out: Record<string, unknown>,
  output: { json: boolean } = { json: false },
): string | null {
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i]
    if (!flag.startsWith('--')) return `unexpected argument: ${flag} (flags look like --status todo)`
    // A --json where a flag stands (never a flag's value) asks for the JSON failure output.
    if (flag === '--json' && !input.json) { output.json = true; continue }
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

/** A session Walnut runs, whose host daemon is the way to its server's plugin ops (fetchHubOps). */
function inManagedSession(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!env.WALNUT_AGENT_SOCKET?.trim() && !!env.WALNUT_SESSION_ID?.trim()
}

export async function runTools(argv: string[], globals: GlobalOptions): Promise<void> {
  const { listOps, getOp, getOpOwner, executeOp } = await import('../ops/index.js')
  // --json before the subcommand, between call and the op, or after the JSON argument.
  const { splitToolsJsonFlag } = await import('../providers/tool-call-output.js')
  const split = splitToolsJsonFlag(argv)
  const args = split.args
  if (split.json && !globals.json) globals = { ...globals, json: true }
  const sub = args[0]

  // `walnut tools --help` / `-h`: commander no longer handles this (its help
  // option ate `--help` in `tools call <op> --help`), so print the same manual
  // page the in-session CLI prints.
  if (sub === '--help' || sub === '-h') {
    const { helpText } = await import('../providers/wn-cli.js')
    console.log(helpText('tools'))
    return
  }

  if (sub === 'list' || sub === undefined) {
    const readonly = args.includes('--readonly')
    // --group <group> (or --group=<group>): one group of the catalog (src/ops/op-groups.ts).
    const groupAt = args.indexOf('--group')
    const wantedGroup = groupAt >= 0 ? args[groupAt + 1] : args.find((a) => a.startsWith('--group='))?.slice('--group='.length)
    if ((groupAt >= 0 || wantedGroup !== undefined) && (!wantedGroup || wantedGroup.startsWith('--'))) {
      console.error('usage: walnut tools list --group <group> (`walnut tools list` names the groups)')
      process.exitCode = 1
      return
    }
    const { compareGroups, groupOfOp, summarizeGroups } = await import('../ops/op-groups.js')
    const ops = listOps().filter((o) => !readonly || o.tags.readonly)
    let rows: ToolsListRow[] = ops.map((o) => ({
      name: o.name,
      title: o.title,
      readonly: o.tags.readonly,
      remote: o.tags.remote,
      // The signature is the whole point of the catalog for an agent: without
      // it the next step is guessing `q` vs `query`.
      signature: formatParamSignature(opParams(o.input as Record<string, ZodLike>)),
      group: groupOfOp(o.name, getOpOwner(o.name)),
    }))
    // Plugin ops live in the server process only; a session sees them through
    // its host daemon. No daemon or no answer: core ops alone, as before.
    const known = new Set(listOps({ includeDeprecated: true }).map((o) => o.name))
    const { fetchHubOps } = await import('../providers/wn-cli.js')
    const hubOps = await fetchHubOps()
    // A session whose daemon got no catalog: say the plugin ops are unknown, not absent (issue #23).
    if (hubOps === null && inManagedSession()) {
      const { catalogAwayLines } = await import('../providers/host-exec-run-id.js')
      console.error(catalogAwayLines().join('\n'))
    }
    for (const hub of hubOps ?? []) {
      if (known.has(hub.name) || (readonly && !hub.readonly)) continue
      rows.push({
        name: hub.name,
        title: hub.title ?? hub.name,
        readonly: hub.readonly === true,
        remote: hub.remote ?? 'deny',
        signature: hub.signature ?? '(none)',
        // An older server names no group: the op is a plugin's (this process knows every core op).
        group: hub.group ?? 'plugin',
      })
    }
    rows = rows.map((row, i) => ({ row, i })).sort((a, b) => compareGroups(a.row.group, b.row.group) || a.i - b.i).map((x) => x.row)
    if (wantedGroup !== undefined) {
      const all = summarizeGroups(rows)
      rows = rows.filter((row) => inGroup(row.group, wantedGroup))
      if (rows.length === 0) {
        console.error(`No group named ${wantedGroup}. The groups: ${all.map((g) => g.id).join(', ')}`)
        process.exitCode = 1
        return
      }
    }
    if (globals.json) {
      const { outputJson } = await import('../utils/json-output.js')
      outputJson(rows)
      return
    }
    console.log(formatToolsTable(rows, summarizeGroups(rows)))
    return
  }

  // `tools help <op>` and `tools call <op> --help` render the SAME detail.
  const printOpHelp = async (name: string): Promise<boolean> => {
    const op = getOp(name)
    if (!op) {
      // A plugin op: the server holds its schema, this session's daemon asks it.
      const { fetchHubOps } = await import('../providers/wn-cli.js')
      const hubOps = await fetchHubOps(process.env, name)
      const hub = hubOps?.find((row) => row.name === name)
      if (hub) {
        console.log(formatOpHelp(hub))
        return true
      }
      console.error(`Unknown op: ${name}. Run \`walnut tools list\`.`)
      if (hubOps === null && inManagedSession()) {
        const { catalogAwayLines } = await import('../providers/host-exec-run-id.js')
        console.error(catalogAwayLines().join('\n'))
      }
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
    // A bare `tools help` is a request for the manual, not a usage error.
    const name = args[1]
    if (!name || name === '--help' || name === '-h') {
      const { helpText } = await import('../providers/wn-cli.js')
      console.log(helpText('tools'))
      return
    }
    await printOpHelp(name)
    return
  }

  if (sub === 'call') {
    const name = args[1]
    // Every failure of a call is ONE JSON object (tool-call-output.ts): on stderr, or on stdout with --json.
    const { failureOnStdout, renderToolCallFailure, toolCallFailure, opFailureCode, gatewayFailureCode } = await import('../providers/tool-call-output.js')
    const output = { json: globals.json === true }
    const fail = (
      code: string, message: string, exitCode: number,
      more: { notes?: readonly string[]; detail?: unknown; partial?: unknown } = {},
    ): void => {
      const streams = renderToolCallFailure(toolCallFailure(code, message, more.notes, more.detail), { json: failureOnStdout(output.json), partial: more.partial })
      // Raw stream writes, never console.*: bun's console.error paints its text red under
      // FORCE_COLOR even into a pipe, and the ANSI prefix breaks JSON.parse (wn-cli.ts does the same).
      if (streams.stdout) process.stdout.write(streams.stdout)
      if (streams.stderr) process.stderr.write(streams.stderr)
      process.exitCode = exitCode
    }
    if (name === '--help' || name === '-h') {
      const { helpText } = await import('../providers/wn-cli.js')
      console.log(helpText('tools'))
      return
    }
    if (!name || name.startsWith('-')) {
      fail('usage_error', 'usage: walnut tools call <op> [\'{json}\' | --flag value ...]', 1)
      return
    }
    const op = getOp(name)
    const rest = args.slice(2)
    let parsed: Record<string, unknown> = {}

    // `--help` anywhere in a call means "show me the schema", never "parse me
    // as JSON". It used to reach the JSON parser and die with "JSON Parse
    // error", which reads as a broken CLI (2026-09-01 session).
    if (rest.includes('--help') || rest.includes('-h')) {
      await printOpHelp(name)
      return
    }

    // The JSON form reads ONE argument: a word after it is refused, not dropped (tool-args-source.ts).
    if (!rest[0]?.startsWith('--')) {
      const { trailingArgsMessage } = await import('../providers/tool-args-source.js')
      const trailing = trailingArgsMessage(rest.slice(1))
      if (trailing) {
        fail('usage_error', trailing, 1)
        return
      }
    }

    // An op this process does not know may be a plugin's, which only the server
    // holds: inside a session the host daemon runs it there, with the raw
    // arguments (JSON, @file or stdin). Outside one, the usual unknown-op error.
    if (!op && !rest[0]?.startsWith('--')) {
      const { callServerOpThroughHostDaemon } = await import('./tools-daemon-fallback.js')
      const code = await callServerOpThroughHostDaemon([name, ...rest, ...(output.json ? ['--json'] : [])])
      if (code !== null) { process.exitCode = code; return }
    }

    // Typed on the command line (flags or inline JSON), where the shell may have cut a "$" amount.
    let typedArgs = true
    // How the arguments arrived, for the session's chat card (recordSessionOpCall).
    let argForm: 'inline' | 'file' | 'stdin' | 'flags' | 'none' = 'flags'
    let argPath: string | undefined
    if (rest[0]?.startsWith('--')) {
      // Human-friendly flag form: --status todo --q "login bug". Types are
      // coerced from the op's own zod shape, so numbers and booleans arrive
      // typed exactly as the JSON form would deliver them.
      if (!op) {
        fail('unknown_op', `Unknown op: ${name}. Run \`walnut tools list\`. A plugin's op takes its arguments as JSON: walnut tools call ${name} '{...}'`, 1)
        return
      }
      const flagErr = parseFlagArgs(rest, op.input, parsed, output)
      if (flagErr) {
        fail('usage_error', flagErr, 1)
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
        fail('usage_error', source.message, 1)
        return
      }
      let rawJson = ''
      typedArgs = source.kind === 'inline'
      argForm = source.kind
      if (source.kind === 'file') argPath = source.path
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
          fail('args_file', `cannot read arguments from ${source.path}: ${err instanceof Error ? err.message : String(err)}`, 1)
          return
        }
      }
      const args = parseToolArgs(rawJson)
      if (!args.ok) {
        fail('invalid_json', args.message, 1)
        return
      }
      parsed = args.args
    }
    // A "$14.99" the shell already turned into ".99" on the command line (flags or inline JSON): refused, nothing sent.
    if (typedArgs) {
      const { strippedShellText, strippedShellTextMessage } = await import('../providers/tool-args-source.js')
      const cut = process.env.WALNUT_TEXT_CHECK === '0' ? null : strippedShellText(parsed)
      if (cut) {
        fail('shell_cut_text', strippedShellTextMessage(cut), 2)
        return
      }
    }
    // The call's id (src/lib/op-call-id.ts): a resend runs it at most once, and op_result reads
    // what it did when its answer is lost. A caller re-running a lost call passes "_call_id".
    const { callIdFor, lostCallDetail, lostCallLines, newCallId } = await import('../lib/op-call-id.js')
    const given = callIdFor(parsed)
    if (given.bad) {
      fail('invalid_call_id', given.bad, 2)
      return
    }
    let callId = given.callId
    // A host_exec run's id chosen here, so an answer that never comes back still leaves one to read.
    const { awayLines, callerRunId, dropRunId, lostRunLines, namedOnSignal, refusedRunId } = await import('../providers/host-exec-run-id.js')
    let runId = callerRunId(name, parsed)
    const lostLines = () => [...(runId ? lostRunLines(name, parsed, runId) : []), ...lostCallLines(name, parsed, callId)].join('\n')
    // Stopped before its answer (a caller's timeout, ^C): the run's id is printed all the same.
    let answered = namedOnSignal(name, parsed, runId)
    // A message from a session goes through its host daemon first, on the Mac as
    // on any host: a message between two sessions on one host is that host's to
    // deliver, and the daemon hands everything else to the server itself. Only
    // a daemon that could not route it at all (no daemon, no server it could
    // reach) leaves the call to the HTTP path below; nothing was delivered then.
    // What this call said, recorded for the session's own chat card (core/sessions/op-call-log.ts).
    const { recordSessionOpCall } = await import('../ops/executor.js')
    const record = (ok: boolean, result?: unknown, error?: string): Promise<void> =>
      recordSessionOpCall({ op: name, args: parsed, result, ok, ...(error ? { error } : {}), form: argForm, ...(argPath ? { path: argPath } : {}) })
    if (name === 'task_send' || name === 'session_send') {
      const { callHostDaemonTool, formatErrorLines, errorToExitCode, recordCardedCallViaDaemon } = await import('../providers/wn-cli.js')
      const resp = await callHostDaemonTool(name, parsed, process.env, callId)
      if (resp && daemonSendAnswerStands(resp)) {
        // The record takes the daemon's way too: a session's call never goes over HTTP.
        await recordCardedCallViaDaemon(name, parsed, argForm, argPath, resp)
        if (resp.ok) {
          console.log(JSON.stringify(resp.result, null, 2))
          await noteSessionAnswered()
          return
        }
        const lost = resp.error.code === 'hub_timeout'
        // The code printed below: kept when no Walnut answered (providers/session-no-answer.ts).
        noteSessionFailure(name, gatewayFailureCode(resp.error.code, resp.error.message))
        // A lost answer: the call's id and how to read it ride the one error (its notes and its detail); stdout stays empty.
        const lostDetail = lost && resp.error.detail === undefined ? lostCallDetail(name, callId) : undefined
        fail(gatewayFailureCode(resp.error.code, resp.error.message), resp.error.message, errorToExitCode(resp.error.code), {
          notes: [...formatErrorLines(resp.error).slice(1), ...(lost ? lostLines().split('\n') : [])],
          detail: lostDetail ?? resp.error.detail,
        })
        return
      }
    }
    // A trigger check's call to an op that runs only for a task goes through the check's daemon,
    // which says which trigger it ran (core/hosts/trigger-caller.ts); over HTTP it would be nobody's.
    const { isTaskHostOpPath } = await import('../lib/task-host-ops.js')
    if (isTaskHostOpPath(op?.bind?.path)) {
      const { callThroughCheckDaemon } = await import('./tools-daemon-fallback.js')
      const code = await callThroughCheckDaemon(name, { ...parsed, ...(callId ? { _call_id: callId } : {}) }, process.env, { json: output.json })
      if (code !== null) { answered(); process.exitCode = code; return }
    }
    // A session its Walnut named no address for reaches that Walnut through its host daemon, never
    // over HTTP to the default port, where another Walnut may answer (tools-daemon-fallback.ts).
    // So the daemon's answer is final here, hub_unreachable included: unlike task_send above, which
    // has an address to try over HTTP next, this call has none.
    const { callThroughHostDaemon, sessionWithoutAddress } = await import('./tools-daemon-fallback.js')
    if (sessionWithoutAddress(process.env)) {
      const code = await callThroughHostDaemon(name, { ...parsed, ...(callId ? { _call_id: callId } : {}) }, process.env, { json: output.json, first: true })
      if (code !== null) { answered(); process.exitCode = code; return }
    }
    // A separate process: the server re-judges its socket, and can only lower this.
    const { LOCAL_ORIGIN } = await import('../lib/caller-origin.js')
    // Outside every session and with no terminal, the call is a script's, never the user's.
    const { cliOpCaller } = await import('../lib/cli-sender.js')
    const caller = cliOpCaller()
    // A session's call reads a receipt or capped content (ops/answer.ts), held to what its shell
    // keeps of the pretty JSON printed below; a person's or a check script's reads the result as it is.
    const forAgent = process.env.WALNUT_SESSION_ID?.trim() && !process.env.WALNUT_CHECK_TOKEN ? 'cli' as const : undefined
    let r = await executeOp(name, parsed, { origin: LOCAL_ORIGIN, callId, forAgent, ...caller })
    // A server older than the run id refused it before anything ran: the same call without it.
    if (!r.ok && runId && refusedRunId(name, r.message)) {
      dropRunId(name, parsed)
      runId = null
      // Other arguments, so another call: nothing of the first ran.
      callId = newCallId()
      // The id is gone from the call: a stop now must not name it (2026-11-05 review).
      answered()
      answered = () => {}
      r = await executeOp(name, parsed, { origin: LOCAL_ORIGIN, callId, forAgent, ...caller })
    }
    if (!r.ok && r.unreachable) {
      // The same call id: a write the server took before its connection reset runs once.
      const code = await callThroughHostDaemon(name, { ...parsed, _call_id: callId }, process.env, { json: output.json })
      if (code !== null) { process.exitCode = code; return }
    }
    answered()
    // Inside a trigger check, its daemon hears what the machine did to this call (tools-daemon-fallback.ts reportCheckOutcome).
    if (process.env.WALNUT_CHECK_TOKEN) {
      const { reportCheckOutcome } = await import('./tools-daemon-fallback.js')
      await reportCheckOutcome(r)
    }
    if (!r.ok) {
      if (!r.unreachable) await record(false, r.result, r.message)
      // No answer at all (a timeout, a dropped connection): the call may have run all the same.
      // A server that refused the connection never saw the call: nothing ran.
      const lost = r.result === undefined && (r.lost || /^Walnut request (timed out|failed)/.test(r.message))
      // A lost answer: the call's id and how to read it ride the one error (its notes and its detail); stdout stays empty.
      const lostDetail = lost ? lostCallDetail(name, callId) : undefined
      const notes = lost ? lostLines().split('\n') : r.unreachable ? awayLines(name, parsed) : []
      // No Walnut answered (the server and the daemon inside it restarting): the code printed below is
      // kept for the real-use monitor, told with the session's next answered call (providers/session-no-answer.ts).
      noteSessionFailure(name, opFailureCode(r.message))
      // An op's partial result keeps its place on stdout (with --json, it is the error's detail).
      fail(opFailureCode(r.message), r.message, 1, { notes, detail: lostDetail, partial: r.result })
      return
    }
    // A 200 with an EMPTY body leaves result undefined, and JSON.stringify would
    // print the literal string "undefined" with exit 0 — indistinguishable from a
    // real answer to a caller that only checks the status. Say it and fail.
    if (r.result === undefined) {
      fail('empty_response', `${name} returned an empty response body (no JSON) — the server answered 200 with nothing`, 1)
      return
    }
    console.log(JSON.stringify(r.result, null, 2))
    await record(true, r.result)
    // A call a server answered tells what the session kept of calls no Walnut answered.
    await noteSessionAnswered()
    return
  }

  console.error(`unknown tools subcommand: ${sub} (expected list | help | call)`)
  process.exitCode = 1
}

/**
 * Whether the host daemon's answer to a session's task_send or session_send is the call's answer.
 * Not when the daemon could not route it at all (`hub_unreachable`, `unknown_caller`): the HTTP path
 * sends it then. A plugin job's call the Walnut server could not yet tell from its job (it has just
 * started: `detail.jobsNotKnownYet`) stands, since over HTTP it would go as an unidentified outside
 * caller's.
 */
export function daemonSendAnswerStands(resp: { ok: boolean; error?: { code?: string; detail?: unknown } }): boolean {
  if (resp.ok !== false) return true
  if ((resp.error?.detail as { jobsNotKnownYet?: unknown } | undefined)?.jobsNotKnownYet === true) return true
  return !(resp.error?.code === 'hub_unreachable' || resp.error?.code === 'unknown_caller')
}
