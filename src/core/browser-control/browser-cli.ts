/**
 * `walnut browser`: the person's browser for agents and scripts, shared by the Mac's CLI
 * (commands/browser.ts) and the hosts' CLI (providers/wn-cli.ts), which differ only in how they
 * call an op. Every action is the `browser` op (ops/browser.ts); a screenshot is saved as a file.
 */
import fs from 'node:fs'
import path from 'node:path'

export const BROWSER_USAGE = [
  'usage: walnut browser status',
  '       walnut browser tabs',
  '       walnut browser open <url>',
  '       walnut browser navigate <url> [--tab N]      (also: go)',
  '       walnut browser back | close [--tab N]',
  '       walnut browser snapshot | text [--tab N]',
  '       walnut browser click <ref> | --at X,Y [--tab N]',
  '       walnut browser type [<ref>] <text> [--clear] [--submit] [--tab N]',
  '       walnut browser select <ref> <value> [--tab N]',
  '       walnut browser press <key> [--tab N]',
  '       walnut browser scroll [up|down|<ref>] [--amount N] [--tab N]',
  '       walnut browser wait <text> | --ms N [--tab N]',
  '       walnut browser screenshot [<file>] [--tab N]   (default: a file in $WALNUT_TASK_DIR/shots)',
  '  --json prints the whole result. A site agents have not used yet waits for the person to approve it only when they chose "Ask me first" in Settings.',
  'Exit: 0 done; 1 refused (the person said no, not your tab); 2 no answer in time; 3 an error.',
].join('\n')

export const BROWSER_EXIT = { ok: 0, refused: 1, timeout: 2, error: 3 } as const

export interface OpResult { ok: boolean; result?: unknown; message?: string; status?: number; code?: string }
export interface BrowserIo {
  call: (name: string, args: Record<string, unknown>) => Promise<OpResult>
  say: (line: string) => void
  out: (text: string) => void
  cwd: string
  env?: Record<string, string | undefined>
  now?: () => number
}

export type ParsedBrowser =
  | { ok: true; op: 'browser' | 'browser_status'; args: Record<string, unknown>; json: boolean; file?: string }
  | { ok: false; error: string }

const REFS = /^e\d+$/

export function parseBrowserArgv(argv: string[]): ParsedBrowser {
  const words: string[] = []
  const args: Record<string, unknown> = {}
  let json = false
  for (let i = 0; i < argv.length; i++) {
    const w = argv[i]
    const val = () => { const v = argv[++i]; if (v === undefined) throw new Error(`${w} needs a value`); return v }
    try {
      if (w === '--json') json = true
      else if (w === '--tab') { const n = Number(val()); if (!Number.isInteger(n)) return { ok: false, error: '--tab takes a tab id' }; args.tab = n }
      else if (w === '--clear') args.clear = true
      else if (w === '--submit') args.submit = true
      else if (w === '--amount') args.amount = Number(val())
      else if (w === '--ms') args.ms = Number(val())
      else if (w === '--device') args.device = val()
      else if (w === '--at') {
        const m = /^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/.exec(val())
        if (!m) return { ok: false, error: '--at takes X,Y' }
        args.x = Number(m[1]); args.y = Number(m[2])
      } else if (w.startsWith('--')) return { ok: false, error: `unknown option ${w}` }
      else words.push(w)
    } catch (err) { return { ok: false, error: (err as Error).message } }
  }
  const [verb, ...rest] = words
  if (!verb) return { ok: false, error: 'say what to do' }
  const one = (name: string) => { if (!rest[0]) throw new Error(`${verb} needs ${name}`); return rest[0] }
  try {
    switch (verb) {
      case 'status': return { ok: true, op: 'browser_status', args: {}, json }
      case 'tabs': case 'back': case 'close': case 'snapshot': case 'text':
        return { ok: true, op: 'browser', args: { action: verb, ...args }, json }
      case 'open': return { ok: true, op: 'browser', args: { action: 'open', url: one('a URL'), ...args }, json }
      case 'navigate': case 'go': return { ok: true, op: 'browser', args: { action: 'navigate', url: one('a URL'), ...args }, json }
      case 'click':
        if (args.x === undefined && !rest[0]) return { ok: false, error: 'click needs a ref (e12) or --at X,Y' }
        return { ok: true, op: 'browser', args: { action: 'click', ...(rest[0] ? { ref: rest[0] } : {}), ...args }, json }
      case 'type': {
        if (!rest.length) return { ok: false, error: 'type needs the text' }
        const ref = rest.length > 1 && REFS.test(rest[0]) ? rest[0] : undefined
        const text = (ref ? rest.slice(1) : rest).join(' ')
        return { ok: true, op: 'browser', args: { action: 'type', ...(ref ? { ref } : {}), text, ...args }, json }
      }
      case 'select':
        if (rest.length < 2) return { ok: false, error: 'select needs a ref and a value' }
        return { ok: true, op: 'browser', args: { action: 'select', ref: rest[0], value: rest.slice(1).join(' '), ...args }, json }
      case 'press': return { ok: true, op: 'browser', args: { action: 'press', key: one('a key'), ...args }, json }
      case 'scroll': {
        const a: Record<string, unknown> = { action: 'scroll', ...args }
        if (rest[0] === 'up' || rest[0] === 'down') a.direction = rest[0]
        else if (rest[0]) a.ref = rest[0]
        return { ok: true, op: 'browser', args: a, json }
      }
      case 'wait':
        if (!rest.length && args.ms === undefined) return { ok: false, error: 'wait needs text or --ms N' }
        return { ok: true, op: 'browser', args: { action: 'wait', ...(rest.length ? { text: rest.join(' ') } : {}), ...args }, json }
      case 'screenshot': return { ok: true, op: 'browser', args: { action: 'screenshot', inline: true, ...args }, json, ...(rest[0] ? { file: rest[0] } : {}) }
    }
  } catch (err) { return { ok: false, error: (err as Error).message } }
  return { ok: false, error: `unknown action ${verb}` }
}

const REFUSED = new Set(['site_denied', 'not_your_tab', 'test_run', 'which_tab'])

/** Where a screenshot goes when no file is named. */
function defaultShot(io: BrowserIo): string {
  const dir = io.env?.WALNUT_TASK_DIR ? path.join(io.env.WALNUT_TASK_DIR, 'shots') : io.cwd
  return path.join(dir, `browser-${new Date(io.now?.() ?? Date.now()).toISOString().replace(/[:.]/g, '-')}.jpg`)
}

export async function runBrowser(p: Extract<ParsedBrowser, { ok: true }>, io: BrowserIo): Promise<number> {
  const deadline = (io.now?.() ?? Date.now()) + 10 * 60_000
  let told = false
  for (;;) {
    const r = await io.call(p.op, { ...p.args, ...(told ? { wait_ms: 25_000 } : {}) })
    if (!r.ok) {
      io.say(`walnut browser: ${r.message ?? 'failed'}`)
      return r.code && REFUSED.has(r.code) ? BROWSER_EXIT.refused : r.code === 'browser_timeout' ? BROWSER_EXIT.timeout : BROWSER_EXIT.error
    }
    const body = (r.result ?? {}) as Record<string, unknown>
    if (body.status === 'needs_ok') {
      if (!told) io.say(`Waiting for the person to let agents use ${body.site} (a notification on their Mac and phone)...`)
      told = true
      if ((io.now?.() ?? Date.now()) > deadline) { io.say('walnut browser: no answer in 10 minutes'); return BROWSER_EXIT.timeout }
      continue
    }
    if (p.args.action === 'screenshot' && typeof body.image === 'string') {
      const m = /^data:image\/(\w+);base64,(.+)$/.exec(body.image)
      if (!m) { io.say('walnut browser: the browser sent no image'); return BROWSER_EXIT.error }
      const file = path.resolve(io.cwd, p.file ?? defaultShot(io))
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, Buffer.from(m[2], 'base64'))
      delete body.image
      if (p.json) io.out(JSON.stringify({ ...body, file }, null, 2) + '\n')
      else io.out(`${file}\n`)
      return BROWSER_EXIT.ok
    }
    if (p.json) { io.out(JSON.stringify(body, null, 2) + '\n'); return BROWSER_EXIT.ok }
    io.out(render(p.args.action as string | undefined, body) + '\n')
    return BROWSER_EXIT.ok
  }
}

/** What a person (or an agent in a shell) reads. */
function render(action: string | undefined, b: Record<string, unknown>): string {
  if (!action) {
    const browsers = (b.browsers as Array<{ label: string; browser: string }> | undefined) ?? []
    const sites = (b.sites as Array<{ site: string }> | undefined) ?? []
    return [
      browsers.length ? `Connected: ${browsers.map((x) => x.label).join(', ')}` : 'No browser lets agents in now (the Walnut extension popup, Settings, turns it on).',
      b.mode === 'any' ? 'Sites: any' : `Sites: a new one asks the person first; allowed: ${sites.map((s) => s.site).join(', ') || 'none yet'}`,
    ].join('\n')
  }
  if (action === 'tabs') {
    const tabs = (b.tabs as Array<{ id: number; url?: string; title?: string; active?: boolean }> | undefined) ?? []
    return tabs.length ? tabs.map((t) => `${t.id}  ${t.title ?? ''}  ${t.url ?? ''}`).join('\n') : 'No tab of this task (open one).'
  }
  if (action === 'snapshot') return typeof b.snapshot === 'string' ? b.snapshot : JSON.stringify(b)
  if (action === 'text') return typeof b.text === 'string' ? b.text : ''
  const where = [typeof b.tab === 'number' ? `tab ${b.tab}` : '', typeof b.url === 'string' ? b.url : '', typeof b.title === 'string' ? `"${b.title}"` : ''].filter(Boolean).join('  ')
  return `ok${where ? `  ${where}` : ''}${typeof b.note === 'string' ? `\n${b.note}` : ''}`
}
