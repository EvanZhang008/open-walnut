/**
 * `walnut pass`: the vault for scripts and agents, shared by the Mac's CLI (commands/pass.ts)
 * and the hosts' CLI (providers/wn-cli.ts), which differ only in how they call an op.
 *
 *   walnut pass list [words] [--site <url>] [--json]
 *   walnut pass get <item> --purpose "<why>" [--field password|username|totp|<name>]... [--task] [--json]
 *   walnut pass run --purpose "<why>" --env NAME=<item>[:field] [--env <item>]... [--task] -- <command> [args...]
 *
 * `run` gives the command its secrets as environment variables and replaces every one of them
 * in what the command prints with ********, so a secret reaches the command and never the
 * terminal or an agent's context. An item asks the person unless it allows agents; the wait
 * shows on stderr, and Ctrl-C withdraws the ask.
 */
import { spawn } from 'node:child_process'
import os from 'node:os'

export const PASS_EXIT = { ok: 0, denied: 1, timeout: 2, error: 3, interrupted: 130 } as const

export const PASS_USAGE = [
  'usage: walnut pass list [words] [--site <url>] [--json]',
  '       walnut pass get <item> --purpose "<why>" [--field <name>]... [--task] [--json]',
  '       walnut pass run --purpose "<why>" --env NAME=<item>[:field] [--env <item>]... [--task] -- <command> [args...]',
  '',
  'Exit: 0 ok; before the command runs, 1 refused or denied, 2 no answer in time, 3 an error,',
  '130 interrupted. Once it runs, run exits with the command\'s own code (128+n for signal n).',
].join('\n')

/** A refusal the person (or their setting) made, as opposed to an error. */
const REFUSED = new Set(['denied', 'agent_never', 'agents_off', 'agent_paused'])
const exitFor = (code: string | undefined) => (code && REFUSED.has(code) ? PASS_EXIT.denied : PASS_EXIT.error)

export interface OpResult { ok: boolean; result?: unknown; message?: string; status?: number; code?: string }
export type PassCall = (name: string, args: Record<string, unknown>) => Promise<OpResult>

export interface PassIo {
  call: PassCall
  /** Lines for the person (stderr). */
  say: (line: string) => void
  /** The command's result (stdout). */
  out: (text: string) => void
  onInterrupt?: (fn: () => void) => () => void
  sleep?: (ms: number) => Promise<void>
  cwd?: string
  /** Runs the command (tests swap it); returns its exit code. */
  runChild?: (cmd: string, args: string[], env: Record<string, string>, secrets: string[]) => Promise<number>
}

export interface EnvSpec { name?: string; item: string; field?: string }

export type ParsedPass =
  | { ok: true; kind: 'list'; query?: string; site?: string; json: boolean }
  | { ok: true; kind: 'get'; item: string; fields: string[]; purpose: string; task: boolean; json: boolean }
  | { ok: true; kind: 'run'; env: EnvSpec[]; purpose: string; task: boolean; cmd: string; args: string[] }
  | { ok: false; error: string }

/** `NAME=item:field`, `NAME=item`, `item` (an API key's own env var). A colon inside an item name needs the NAME= form and :field. */
export function parseEnvSpec(raw: string): EnvSpec | null {
  const s = raw.trim()
  if (!s) return null
  const eq = /^([A-Za-z_][A-Za-z0-9_]*)=(.+)$/.exec(s)
  const rest = eq ? eq[2] : s
  const colon = rest.lastIndexOf(':')
  const field = colon > 0 && /^[a-z_][a-z0-9_ -]*$/i.test(rest.slice(colon + 1)) && !/^\/\//.test(rest.slice(colon + 1)) ? rest.slice(colon + 1) : undefined
  const item = field ? rest.slice(0, colon) : rest
  return { ...(eq ? { name: eq[1] } : {}), item, ...(field ? { field } : {}) }
}

export function parsePassArgv(argv: readonly string[]): ParsedPass {
  const [sub, ...rest] = argv
  if (sub !== 'list' && sub !== 'get' && sub !== 'run') return { ok: false, error: sub ? `unknown command: pass ${sub}` : 'missing command' }
  const words: string[] = []
  const fields: string[] = []
  const env: EnvSpec[] = []
  let purpose = ''
  let site: string | undefined
  let task = false
  let json = false
  let i = 0
  for (; i < rest.length; i++) {
    const a = rest[i]
    const val = () => { const v = rest[++i]; if (v === undefined) throw new Error(`${a} needs a value`); return v }
    try {
      if (a === '--') { i++; break }
      else if (a === '--purpose' || a === '-p') purpose = val()
      else if (a.startsWith('--purpose=')) purpose = a.slice(10)
      else if (a === '--field' || a === '-f') fields.push(val())
      else if (a === '--site') site = val()
      else if (a === '--env' || a === '-e') { const e = parseEnvSpec(val()); if (!e) return { ok: false, error: 'empty --env' }; env.push(e) }
      else if (a === '--task') task = true
      else if (a === '--json') json = true
      else if (a.startsWith('-')) return { ok: false, error: `unknown option ${a}` }
      else if (sub === 'run') return { ok: false, error: 'put the command after --' }
      else words.push(a)
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  }
  if (sub === 'list') return { ok: true, kind: 'list', ...(words.length ? { query: words.join(' ') } : {}), ...(site ? { site } : {}), json }
  if (purpose.trim().length < 4) return { ok: false, error: '--purpose "<why>" is required: the person reads it before approving' }
  if (sub === 'get') {
    if (words.length !== 1) return { ok: false, error: 'name one item (quote a name with spaces)' }
    return { ok: true, kind: 'get', item: words[0], fields: fields.length ? fields : ['password'], purpose, task, json }
  }
  const cmd = rest[i]
  if (!cmd) return { ok: false, error: 'missing the command after --' }
  if (!env.length) return { ok: false, error: 'give at least one --env NAME=<item>' }
  return { ok: true, kind: 'run', env, purpose, task, cmd, args: rest.slice(i + 1) }
}

interface Released { item: { id: string; title: string; envName?: string }; values: Record<string, string> }

function errLine(r: OpResult): string {
  return (r.message ?? 'no answer from Walnut').replace(/^Walnut API error \([a-z0-9_]+\):\s*/, '')
}

/** One password_use, waiting for the person when it asks; null when it was not released. */
async function useItem(io: PassIo, args: { item: string; fields: string[]; purpose: string; task: boolean; command?: string }, stop: { interrupted: boolean; wake: Promise<null> }): Promise<{ released?: Released; exit?: number }> {
  const sleep = io.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const first = await io.call('password_use', {
    item: args.item, fields: args.fields, purpose: args.purpose, scope: args.task ? 'task' : 'once',
    ...(io.cwd ? { cwd: io.cwd } : {}), ...(args.command ? { command: args.command } : {}),
  })
  if (!first.ok) {
    io.say(`walnut pass: ${errLine(first)}`)
    return { exit: exitFor(first.code) }
  }
  const b = (first.result ?? {}) as { status?: string; requestId?: string; waitToken?: string; mode?: string; downgraded?: string; item?: { title?: string } }
  if (b.status === 'released') return { released: first.result as Released }
  if (b.status !== 'pending' || !b.requestId || !b.waitToken) {
    io.say('walnut pass: unexpected answer from Walnut')
    return { exit: PASS_EXIT.error }
  }
  io.say(`Waiting for approval to use ${b.item?.title ?? args.item}${b.mode === 'biometric' ? ' (Face ID or Touch ID)' : ''}: answer it on your Mac or phone.`)
  if (b.downgraded) io.say(`  ${b.downgraded}`)
  let failures = 0
  while (!stop.interrupted) {
    const r = await Promise.race([io.call('password_wait', { id: b.requestId, token: b.waitToken, wait_ms: 12_000 }), stop.wake])
    if (r === null || stop.interrupted) break
    if (r.ok) {
      failures = 0
      const w = (r.result ?? {}) as { status?: string; answeredBy?: string }
      if (w.status === 'released') {
        io.say(`Approved${w.answeredBy ? ` on ${w.answeredBy}` : ''}.`)
        return { released: r.result as Released }
      }
      if (w.status === 'expired' || w.status === 'canceled') {
        io.say(w.status === 'expired' ? 'No answer in time: not released.' : 'The ask was withdrawn: not released.')
        return { exit: PASS_EXIT.timeout }
      }
      continue
    }
    if (r.status !== undefined && r.status >= 400 && r.status < 500) {
      io.say(`walnut pass: ${errLine(r)}`)
      return { exit: exitFor(r.code) }
    }
    failures++
    if (failures === 1) io.say(`walnut pass: lost Walnut for a moment (${errLine(r)}); still waiting.`)
    await Promise.race([sleep(Math.min(10_000, 1_000 * failures)), stop.wake])
  }
  await io.call('password_cancel', { id: b.requestId, token: b.waitToken }).catch(() => undefined)
  io.say('Stopped: the ask was withdrawn.')
  return { exit: PASS_EXIT.interrupted }
}

export async function runPass(p: Exclude<ParsedPass, { ok: false }>, io: PassIo): Promise<number> {
  if (p.kind === 'list') {
    const r = await io.call('password_list', { ...(p.query ? { q: p.query } : {}), ...(p.site ? { site: p.site } : {}) })
    if (!r.ok) { io.say(`walnut pass: ${errLine(r)}`); return exitFor(r.code) }
    const items = ((r.result ?? {}) as { items?: Array<{ id: string; title: string; sites?: string[]; envName?: string; fields: string[]; access: string; sensitive?: boolean }> }).items ?? []
    if (p.json) { io.out(JSON.stringify(items) + '\n'); return PASS_EXIT.ok }
    if (!items.length) { io.say('No item an agent may ask for matches.'); return PASS_EXIT.ok }
    for (const i of items) {
      const where = [i.sites?.join(', '), i.envName ? `$${i.envName}` : ''].filter(Boolean).join('  ')
      io.out(`${i.title}${where ? `  ${where}` : ''}  [${i.fields.join(', ')}]  ${i.access === 'allow' && !i.sensitive ? 'no ask' : 'asks'}  ${i.id}\n`)
    }
    return PASS_EXIT.ok
  }

  let interrupted = false
  let wakeFn: () => void = () => undefined
  const wake = new Promise<null>((resolve) => { wakeFn = () => resolve(null) })
  const stop = { get interrupted() { return interrupted }, wake }
  const off = io.onInterrupt?.(() => { interrupted = true; wakeFn() })
  try {
    if (p.kind === 'get') {
      const r = await useItem(io, { item: p.item, fields: p.fields, purpose: p.purpose, task: p.task }, stop)
      if (!r.released) return r.exit ?? PASS_EXIT.error
      if (p.json) io.out(JSON.stringify(r.released.values) + '\n')
      else io.out(p.fields.map((f) => r.released!.values[f]).join('\n') + '\n')
      return PASS_EXIT.ok
    }

    // run: one ask per item, every field it needs at once.
    const byItem = new Map<string, { specs: EnvSpec[]; fields: Set<string> }>()
    for (const e of p.env) {
      const g = byItem.get(e.item) ?? { specs: [], fields: new Set<string>() }
      g.specs.push(e)
      g.fields.add(e.field ?? 'password')
      byItem.set(e.item, g)
    }
    const env: Record<string, string> = {}
    const secrets: string[] = []
    const command = [p.cmd, ...p.args].join(' ').slice(0, 200)
    for (const [item, g] of byItem) {
      const r = await useItem(io, { item, fields: [...g.fields], purpose: p.purpose, task: p.task, command }, stop)
      if (!r.released) return r.exit ?? PASS_EXIT.error
      for (const s of g.specs) {
        const name = s.name ?? r.released.item.envName
        if (!name) { io.say(`walnut pass: ${r.released.item.title} has no env var name: write --env NAME=${item}`); return PASS_EXIT.error }
        const v = r.released.values[s.field ?? 'password']
        env[name] = v
        if (v) secrets.push(v)
      }
    }
    if (interrupted) return PASS_EXIT.interrupted
    const runChild = io.runChild ?? spawnMasked
    return await runChild(p.cmd, p.args, env, secrets)
  } finally {
    off?.()
  }
}

// ── masking ──

export const MASK = '********'

const MIN_SECRET = 3

/** The middle of base64(prefix k bytes + s) that only s decides, for k = 0, 1, 2. */
function base64Cores(s: string): string[] {
  const b = Buffer.from(s, 'utf8')
  const out: string[] = []
  for (let k = 0; k < 3; k++) {
    const enc = Buffer.concat([Buffer.alloc(k), b]).toString('base64').replace(/=+$/, '')
    const core = enc.slice(Math.ceil((8 * k) / 6), Math.floor((8 * (k + b.length)) / 6))
    if (core.length >= 6) out.push(core, core.replace(/\+/g, '-').replace(/\//g, '_'))
  }
  return out
}

/**
 * The forms a secret takes in output: as is, URL-encoded, JSON-escaped, inside base64 (an
 * Authorization: Basic header, say), and line by line when it spans lines. A guard against a
 * secret printed by accident, not against a command set on showing it in some other shape.
 */
export function secretForms(secrets: readonly string[]): string[] {
  const out = new Set<string>()
  for (const s of secrets) {
    if (s.length < MIN_SECRET) continue
    out.add(s)
    try { out.add(encodeURIComponent(s)) } catch { /* a lone surrogate: no URL form */ }
    out.add(JSON.stringify(s).slice(1, -1))
    for (const c of base64Cores(s)) out.add(c)
    if (/[\r\n]/.test(s)) {
      out.add(s.replace(/\r?\n/g, '\r\n'))
      for (const line of s.split(/\r?\n/)) if (line.trim().length >= MIN_SECRET) out.add(line)
    }
  }
  return [...out]
}

/**
 * Replace every secret (in each of its forms, secretForms) in a byte stream with MASK, across
 * chunk boundaries: it holds back the last (longest form - 1) bytes until it knows they do not
 * start one. Values shorter than 3 characters are not masked (they would turn ordinary output
 * into stars).
 */
export function createMasker(secrets: readonly string[]): { push: (chunk: Buffer) => Buffer; end: () => Buffer } {
  const needles = secretForms(secrets).map((s) => Buffer.from(s, 'utf8')).sort((a, b) => b.length - a.length)
  const keep = needles.length ? needles[0].length - 1 : 0
  const mask = Buffer.from(MASK)
  let pending = Buffer.alloc(0)
  const scrub = (buf: Buffer, final: boolean): Buffer => {
    const out: Buffer[] = []
    let i = 0
    let start = 0
    const limit = final ? buf.length : Math.max(0, buf.length - keep)
    while (i < limit) {
      const hit = needles.find((n) => buf.length - i >= n.length && buf.compare(n, 0, n.length, i, i + n.length) === 0)
      if (hit) {
        out.push(buf.subarray(start, i), mask)
        i += hit.length
        start = i
      } else i++
    }
    out.push(buf.subarray(start, i))
    pending = Buffer.from(buf.subarray(i))
    return Buffer.concat(out)
  }
  return {
    push: (chunk) => (needles.length ? scrub(Buffer.concat([pending, chunk]), false) : chunk),
    end: () => (needles.length ? scrub(pending, true) : Buffer.alloc(0)),
  }
}

/** Run the command with `env` added, its output masked on the way to `out` and `err`. */
export function spawnMasked(cmd: string, args: string[], env: Record<string, string>, secrets: string[],
  out: NodeJS.WritableStream = process.stdout, errOut: NodeJS.WritableStream = process.stderr): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['inherit', 'pipe', 'pipe'], env: { ...process.env, ...env } })
    let open = 2
    const done = () => { if (--open === 0) finish() }
    const pipe = (from: NodeJS.ReadableStream | null, to: NodeJS.WritableStream) => {
      if (!from) { done(); return }
      const m = createMasker(secrets)
      from.on('data', (c: Buffer) => { const b = m.push(c); if (b.length) to.write(b) })
      from.on('end', () => { const b = m.end(); if (b.length) to.write(b); done() })
    }
    let exit: number | null = null
    const finish = () => { if (exit !== null && open === 0) resolve(exit) }
    pipe(child.stdout, out)
    pipe(child.stderr, errOut)
    const forward = (sig: NodeJS.Signals) => () => { child.kill(sig) }
    const onInt = forward('SIGINT'); const onTerm = forward('SIGTERM')
    process.on('SIGINT', onInt); process.on('SIGTERM', onTerm)
    child.on('error', (err) => {
      process.off('SIGINT', onInt); process.off('SIGTERM', onTerm)
      errOut.write(`walnut pass: cannot run ${cmd}: ${err.message}\n`)
      resolve(127)
    })
    child.on('close', (code, signal) => {
      process.off('SIGINT', onInt); process.off('SIGTERM', onTerm)
      // 'close' comes after both pipes ended, so their masked tails are already written.
      exit = code ?? (signal ? 128 + (os.constants.signals[signal] ?? 1) : 1)
      finish()
    })
  })
}
