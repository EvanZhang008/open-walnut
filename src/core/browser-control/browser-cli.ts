/**
 * `walnut browser`: the person's browser for agents and scripts, shared by the Mac's CLI
 * (commands/browser.ts) and the hosts' CLI (providers/wn-cli.ts), which differ only in how they
 * call an op. Every action is the `browser` op (ops/browser.ts); a screenshot is saved as a file.
 */
import fs from 'node:fs'
import path from 'node:path'
import { noBrowserLine, type GoneBrowser } from './gone-words.js'

export const BROWSER_USAGE = [
  'usage: walnut browser status',
  '       walnut browser tabs [--all]                    (--all: every tab of the browser, title and address)',
  '       walnut browser take <tab>                      (act in one of the person\'s tabs; close gives it back)',
  '       walnut browser open <url> [--record]       (--record: its requests and console from before the page loads)',
  '       walnut browser navigate <url> [--tab N]      (also: go)',
  '       walnut browser back | close [--tab N]',
  '       walnut browser snapshot | text [--all-frames] | form-values [--tab N]   (--all-frames: each frame\'s text on its own)',
  '       walnut browser find <text> [--exact] [--role R] [--limit N] [--tab N]',
  '       walnut browser click <ref> | --at X,Y | --text <words> [--trusted] [--tab N]   (--text: the best match, frames too)',
  '       walnut browser click-label <N> [--trusted] [--tab N]          (a number from screenshot --annotate)',
  '       walnut browser hover <ref> | --at X,Y | --text <words> [--trusted] [--tab N]',
  '       walnut browser type [<ref>] <text> [--at X,Y] [--clear] [--submit] [--slowly] [--trusted] [--tab N]   (--slowly: one key at a time)',
  '       walnut browser drag <ref|X,Y> <ref|X,Y> [--steps N] [--tab N]   (real input)',
  '       walnut browser fill-form <ref-or-label>=<value> ... [--tab N]',
  '       walnut browser select <ref> <value> [--tab N]',
  '       walnut browser press <key> [--trusted] [--tab N]',
  '       walnut browser scroll [up|down|left|right|top|bottom] [<ref> | --at X,Y] [--amount N | --by PX] [--trusted] [--tab N]   (a ref or point with a direction: that box scrolls)',
  '       walnut browser wait <text> | --gone <text> | --url <part or /regex/> | --ms N [--tab N]',
  '       walnut browser screenshot [<file>] [--full] [--annotate] [--tab N]   (default: a .jpg in $WALNUT_TASK_DIR/shots; a .png name saves a PNG; --annotate numbers the elements)',
  '       walnut browser zoom <X> <Y> <W> <H> [<file>] [--tab N]   (that region of the screen at full pixel resolution)',
  '       walnut browser upload <ref> <file>... [--tab N]          (10 MB in all; --trusted --path P: a file on the browser\'s machine)',
  '       walnut browser upload --selector <css> <file>... [--tab N] (a file field the page hides)',
  '       walnut browser downloads [--wait] [--ms N]',
  '       walnut browser fill-login [--item <id|name>] [--fresh-sign-in] [--tab N]   (signs in with the saved login; you never see the password)',
  '       walnut browser request-sign-in [<what to sign in to>] [--site S] [--tab N]   (the person signs in themselves, Take over; waits for them)',
  '       walnut browser dialog [read] | accept|dismiss [--text T] [--tab N]   (real input; read: the open dialog\'s type and message)',
  '       walnut browser evaluate <expression> [--tab N]             (real input; a tab you opened)',
  '       walnut browser network [--url part] [--method M] [--status 404|4xx] [--type XHR] [--limit N] [--include-static] [--stop] [--tab N]',
  '       walnut browser network-body <request id> [--max-chars N] | network-request-body <request id> [--tab N]',
  '       walnut browser console [--level error|warn|info|log|debug] [--limit N] [--tab N]   (recording: real input; a tab you opened)',
  '       walnut browser resize <width> <height> [--viewport] [--tab N]   (Walnut\'s agent window; --viewport: the page\'s size)',
  '  Refs: e12 in the page, f3:e12 inside a frame. --json prints the whole result. A site agents have not used yet waits for the',
  '  person only when they chose "Ask me first" in Settings. Real input (--trusted, dialog, evaluate) needs the person to turn it on in the extension.',
  'Exit: 0 done; 1 refused or a choice to make (the person said no, not your tab, which tab or login: the message lists them); 2 no answer in time; 3 an error.',
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
  | { ok: true; op: 'browser' | 'browser_status'; args: Record<string, unknown>; json: boolean; file?: string; upload?: string[] }
  | { ok: false; error: string; help?: true }

/** What a front end prints for a parse that did not give an action: help to stdout (exit 0), an error with the usage to stderr. */
export function browserParseOutcome(p: Extract<ParsedBrowser, { ok: false }>): { stdout?: string; stderr?: string; code: number } {
  return p.help ? { stdout: `${BROWSER_USAGE}\n`, code: BROWSER_EXIT.ok } : { stderr: `walnut browser: ${p.error}\n${BROWSER_USAGE}\n`, code: BROWSER_EXIT.error }
}

const REFS = /^(f\d+:)?e\d+$/
/** What an upload may carry in all: the server's own cap (act-args.ts), kept apart so the CLI loads no server code. */
export const UPLOAD_MAX_BYTES = 10 * 1024 * 1024

export function parseBrowserArgv(argv: string[]): ParsedBrowser {
  const words: string[] = []
  const args: Record<string, unknown> = {}
  let json = false
  for (let i = 0; i < argv.length; i++) {
    const w = argv[i]
    const val = () => { const v = argv[++i]; if (v === undefined) throw new Error(`${w} needs a value`); return v }
    try {
      if (w === '--help' || w === '-h' || (w === 'help' && !words.length)) return { ok: false, error: 'help', help: true }
      if (w === '--json') json = true
      else if (w === '--tab') { const n = Number(val()); if (!Number.isInteger(n)) return { ok: false, error: '--tab takes a tab id' }; args.tab = n }
      else if (w === '--clear') args.clear = true
      else if (w === '--submit') args.submit = true
      else if (w === '--amount') args.amount = Number(val())
      else if (w === '--ms') args.ms = Number(val())
      else if (w === '--device') args.device = val()
      else if (w === '--all') args.all = true
      else if (w === '--full') args.full = true
      else if (w === '--exact') args.exact = true
      else if (w === '--trusted') args.trusted = true
      else if (w === '--wait') args.wait = true
      else if (w === '--role') args.role = val()
      else if (w === '--limit') args.limit = Number(val())
      else if (w === '--by') args.by = Number(val())
      else if (w === '--gone') args.textGone = val()
      else if (w === '--url') args.url = val()
      else if (w === '--text') args.dialogText = val()
      else if (w === '--item') args.item = val()
      else if (w === '--fresh-sign-in') args.fresh_sign_in = true
      else if (w === '--ref') args.ref = val()
      else if (w === '--selector') args.selector = val()
      else if (w === '--record') args.record = true
      else if (w === '--stop') args.stop = true
      else if (w === '--method') args.method = val()
      else if (w === '--status') { const v = val(); args.status = /^\d+$/.test(v) ? Number(v) : v }
      else if (w === '--type') args.type = val()
      else if (w === '--include-static') args.include_static = true
      else if (w === '--level') args.level = val()
      else if (w === '--max-chars') args.max_chars = Number(val())
      else if (w === '--viewport') args.viewport = true
      else if (w === '--annotate') args.annotate = true
      else if (w === '--all-frames') args.all_frames = true
      else if (w === '--slowly') args.slowly = true
      else if (w === '--steps') args.steps = Number(val())
      else if (w === '--site') args.site = val()
      else if (w === '--file' || w === '--path') {
        const key = w === '--file' ? 'files' : 'paths'
        args[key] = [...((args[key] as string[] | undefined) ?? []), val()]
      }
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
      case 'drag': {
        const end = (w: string | undefined, name: string): Record<string, unknown> => {
          const m = /^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/.exec(w ?? '')
          if (m) return name === 'from' ? { x: Number(m[1]), y: Number(m[2]) } : { to_x: Number(m[1]), to_y: Number(m[2]) }
          if (w && REFS.test(w)) return name === 'from' ? { ref: w } : { to_ref: w }
          throw new Error(`drag takes where it starts and where it ends, each a ref (e12) or X,Y (drag e3 e9, drag 100,200 300,240)`)
        }
        return { ok: true, op: 'browser', args: { action: 'drag', ...end(rest[0], 'from'), ...end(rest[1], 'to'), ...args }, json }
      }
      case 'zoom': {
        const nums = rest.length && /^[\d.,-]+$/.test(rest[0]) && rest[0].includes(',') ? rest[0].split(',') : rest.slice(0, 4)
        const [x, y, w, h] = nums.map(Number)
        if (nums.length !== 4 || ![x, y, w, h].every(Number.isFinite)) return { ok: false, error: 'zoom takes the region: X Y WIDTH HEIGHT in CSS pixels (zoom 0 0 400 300)' }
        const file = rest[0]?.includes(',') ? rest[1] : rest[4]
        const png = !!file && /\.png$/i.test(file)
        return { ok: true, op: 'browser', args: { action: 'zoom', x, y, width: w, height: h, inline: true, ...(png ? { format: 'png' } : {}), ...args }, json, ...(file ? { file } : {}) }
      }
      case 'click-label': case 'click_label': {
        const n = Number(rest[0])
        if (!Number.isInteger(n) || n < 1) return { ok: false, error: 'click-label takes a number from screenshot --annotate' }
        return { ok: true, op: 'browser', args: { action: 'click_label', label: n, ...args }, json }
      }
      case 'tabs': case 'back': case 'close': case 'snapshot': case 'text':
        return { ok: true, op: 'browser', args: { action: verb, ...args }, json }
      case 'form-values': case 'form_values': return { ok: true, op: 'browser', args: { action: 'form_values', ...args }, json }
      case 'downloads': return { ok: true, op: 'browser', args: { action: 'downloads', ...args }, json }
      case 'fill-login': case 'fill_login': return { ok: true, op: 'browser', args: { action: 'fill_login', ...args }, json }
      case 'request-sign-in': case 'request_sign_in':
        return { ok: true, op: 'browser', args: { action: 'request_sign_in', ...args, ...(rest.length ? { text: rest.join(' ') } : {}) }, json }
      case 'take': {
        const n = Number(rest[0] ?? args.tab)
        if (!Number.isInteger(n)) return { ok: false, error: 'take needs a tab id (tabs --all lists them)' }
        return { ok: true, op: 'browser', args: { action: 'take', ...args, tab: n }, json }
      }
      case 'find':
        if (!rest.length) return { ok: false, error: 'find needs the text' }
        return { ok: true, op: 'browser', args: { action: 'find', text: rest.join(' '), ...args }, json }
      case 'hover': case 'click': {
        // --text: the words of what to click (dialog's --text is a prompt's answer).
        const { dialogText, ...a } = args
        if (a.x === undefined && !rest[0] && !a.ref && typeof dialogText !== 'string') return { ok: false, error: `${verb} needs a ref (e12), --at X,Y or --text <words>` }
        return { ok: true, op: 'browser', args: { action: verb, ...(rest[0] ? { ref: rest[0] } : {}), ...(typeof dialogText === 'string' && !rest[0] && a.x === undefined ? { text: dialogText } : {}), ...a }, json }
      }
      case 'fill-form': case 'fill_form': {
        const fields = rest.map((pair) => {
          const i = pair.indexOf('=')
          if (i <= 0) throw new Error(`fill-form takes <ref-or-label>=<value>, not "${pair}"`)
          const k = pair.slice(0, i)
          return { ...(REFS.test(k) ? { ref: k } : { label: k }), value: pair.slice(i + 1) }
        })
        if (!fields.length) return { ok: false, error: 'fill-form needs <ref-or-label>=<value> pairs' }
        return { ok: true, op: 'browser', args: { action: 'fill_form', fields, ...args }, json }
      }
      case 'upload': {
        // A file field the page hides is named by a CSS selector instead of a ref.
        const bySel = typeof args.selector === 'string' && typeof args.ref !== 'string'
        const ref = bySel ? undefined : typeof args.ref === 'string' ? args.ref : rest[0]
        const files = [...(bySel || typeof args.ref === 'string' ? rest : rest.slice(1)), ...((args.files as string[] | undefined) ?? [])]
        const { files: _f, ...a } = args
        if (!bySel && (!ref || !REFS.test(ref))) return { ok: false, error: 'upload needs the ref of the file field (e5), or --selector <css> for one the page hides' }
        if (!files.length && !a.paths) return { ok: false, error: 'upload needs a file' }
        return { ok: true, op: 'browser', args: { action: 'upload', ...a, ...(ref ? { ref } : {}) }, json, ...(files.length ? { upload: files } : {}) }
      }
      case 'network': return { ok: true, op: 'browser', args: { action: 'network', ...args }, json }
      case 'console': return { ok: true, op: 'browser', args: { action: 'console', ...args }, json }
      case 'network-body': case 'network_body': case 'network-request-body': case 'network_request_body':
        return { ok: true, op: 'browser', args: { action: verb.includes('request') ? 'network_request_body' : 'network_body', request_id: one('a request id (network lists them)'), ...args }, json }
      case 'resize': {
        const m = rest.length === 1 ? /^(\d+)x(\d+)$/i.exec(rest[0]) : null
        const [w, h] = m ? [m[1], m[2]] : rest
        if (!/^\d+$/.test(w ?? '') || !/^\d+$/.test(h ?? '')) return { ok: false, error: 'resize takes a width and a height (resize 1280 900)' }
        return { ok: true, op: 'browser', args: { action: 'resize', width: Number(w), height: Number(h), ...args }, json }
      }
      case 'dialog': {
        if (!rest[0] || rest[0] === 'read') { const { dialogText: _d, ...a } = args; return { ok: true, op: 'browser', args: { action: 'dialog', read: true, ...a }, json } }
        if (rest[0] !== 'accept' && rest[0] !== 'dismiss') return { ok: false, error: 'dialog takes read, accept or dismiss' }
        const { dialogText, ...a } = args
        return { ok: true, op: 'browser', args: { action: 'dialog', accept: rest[0] === 'accept', ...(typeof dialogText === 'string' ? { text: dialogText } : {}), ...a }, json }
      }
      case 'evaluate': case 'eval':
        if (!rest.length) return { ok: false, error: 'evaluate needs an expression' }
        return { ok: true, op: 'browser', args: { action: 'evaluate', expression: rest.join(' '), ...args }, json }
      case 'open': return { ok: true, op: 'browser', args: { action: 'open', url: one('a URL'), ...args }, json }
      case 'navigate': case 'go': return { ok: true, op: 'browser', args: { action: 'navigate', url: one('a URL'), ...args }, json }
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
        // In any order: a direction or top/bottom, and a ref (with a direction, that box scrolls).
        for (const w of rest.slice(0, 2)) {
          if (['up', 'down', 'left', 'right'].includes(w)) a.direction = w
          else if (w === 'top' || w === 'bottom') a.to = w
          else if (!a.ref) a.ref = w
        }
        return { ok: true, op: 'browser', args: a, json }
      }
      case 'wait':
        if (!rest.length && args.ms === undefined && args.textGone === undefined && args.url === undefined) return { ok: false, error: 'wait needs text, --gone, --url or --ms N' }
        return { ok: true, op: 'browser', args: { action: 'wait', ...(rest.length ? { text: rest.join(' ') } : {}), ...args }, json }
      case 'screenshot': {
        // A file named .png asks the browser for a PNG; anything else is a JPEG (smaller).
        const png = !!rest[0] && /\.png$/i.test(rest[0])
        return { ok: true, op: 'browser', args: { action: 'screenshot', inline: true, ...(png ? { format: 'png' } : {}), ...args }, json, ...(rest[0] ? { file: rest[0] } : {}) }
      }
    }
  } catch (err) { return { ok: false, error: (err as Error).message } }
  return { ok: false, error: `unknown action ${verb}` }
}

const REFUSED = new Set(['site_denied', 'not_your_tab', 'test_run', 'which_tab', 'person_is_here', 'trusted_off', 'denied', 'agents_off', 'agent_never', 'which_login', 'other_site', 'agents_tab_only', 'site_open_in_person_tab', 'not_agent_opened', 'filled_here', 'request_site_not_allowed', 'recording_cancelled', 'person_window', 'person_driving'])

const MIME: Record<string, string> = {
  '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.txt': 'text/plain', '.csv': 'text/csv', '.json': 'application/json', '.html': 'text/html', '.zip': 'application/zip',
  '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.md': 'text/markdown', '.svg': 'image/svg+xml',
}

/** The files of an upload, read here (the CLI runs where the agent works) and sent as base64. */
function readUpload(paths: string[], cwd: string): { files: Array<{ name: string; type: string; base64: string }> } | { error: string } {
  const files: Array<{ name: string; type: string; base64: string }> = []
  let total = 0
  for (const p of paths) {
    const file = path.resolve(cwd, p)
    let buf: Buffer
    try { buf = fs.readFileSync(file) } catch (err) { return { error: `cannot read ${p}: ${(err as Error).message}` } }
    total += buf.length
    if (total > UPLOAD_MAX_BYTES) return { error: `the files come to more than ${UPLOAD_MAX_BYTES / 1024 / 1024} MB` }
    files.push({ name: path.basename(file), type: MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream', base64: buf.toString('base64') })
  }
  return { files }
}

/** Where a screenshot goes when no file is named. */
function defaultShot(io: BrowserIo): string {
  const dir = io.env?.WALNUT_TASK_DIR ? path.join(io.env.WALNUT_TASK_DIR, 'shots') : io.cwd
  return path.join(dir, `browser-${new Date(io.now?.() ?? Date.now()).toISOString().replace(/[:.]/g, '-')}.jpg`)
}

export async function runBrowser(p: Extract<ParsedBrowser, { ok: true }>, io: BrowserIo): Promise<number> {
  const deadline = (io.now?.() ?? Date.now()) + 10 * 60_000
  let told = false
  let request: string | undefined
  let upload: Record<string, unknown> = {}
  if (p.upload?.length) {
    const u = readUpload(p.upload, io.cwd)
    if ('error' in u) { io.say(`walnut browser: ${u.error}`); return BROWSER_EXIT.error }
    upload = { files: u.files }
  }
  for (;;) {
    const r = await io.call(p.op, { ...p.args, ...upload, ...(told ? { wait_ms: 25_000 } : {}), ...(request ? { request } : {}) })
    if (!r.ok) {
      io.say(`walnut browser: ${r.message ?? 'failed'}`)
      return r.code && REFUSED.has(r.code) ? BROWSER_EXIT.refused : r.code === 'browser_timeout' || r.code === 'outward_expired' ? BROWSER_EXIT.timeout : BROWSER_EXIT.error
    }
    const body = (r.result ?? {}) as Record<string, unknown>
    if (body.status === 'needs_ok') {
      // A sign-in waits on its own ask: the next calls name it.
      if (typeof body.request === 'string') request = body.request
      // What it waits for, in the server's words, and how long this command waits.
      if (!told) {
        const why = typeof body.error === 'string' ? body.error.replace(/[.\s]+$/, '')
          : request ? 'Waiting for the person to approve the sign-in (a notification on their Mac and phone)' : `Waiting for the person to let agents use ${body.site} (a notification on their Mac and phone)`
        io.say(`${why}. This command waits up to 10 minutes for their answer...`)
      }
      told = true
      if ((io.now?.() ?? Date.now()) > deadline) { io.say('walnut browser: no answer in 10 minutes'); return BROWSER_EXIT.timeout }
      continue
    }
    if ((p.args.action === 'screenshot' || p.args.action === 'zoom') && typeof body.image === 'string') {
      const m = /^data:image\/(\w+);base64,(.+)$/.exec(body.image)
      if (!m) { io.say('walnut browser: the browser sent no image'); return BROWSER_EXIT.error }
      // The file's name says what is in it: an older extension sends a JPEG even when a PNG was asked.
      const ext = m[1] === 'png' ? '.png' : '.jpg'
      let file = path.resolve(io.cwd, p.file ?? defaultShot(io).replace(/\.jpg$/, ext))
      const named = path.extname(file).toLowerCase()
      if (named !== ext && !(ext === '.jpg' && named === '.jpeg')) {
        file = file.slice(0, file.length - named.length) + ext
        io.say(`walnut browser: the browser sent a ${ext === '.png' ? 'PNG' : 'JPEG'}, so it is saved as ${path.basename(file)}`)
      }
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, Buffer.from(m[2], 'base64'))
      delete body.image
      if (p.json) io.out(JSON.stringify({ ...body, file }, null, 2) + '\n')
      else io.out(`${file}\n${labelLines(body)}`)
      return BROWSER_EXIT.ok
    }
    if (p.json) { io.out(JSON.stringify(body, null, 2) + '\n'); return BROWSER_EXIT.ok }
    io.out(render(p.args.action as string | undefined, body) + '\n')
    return BROWSER_EXIT.ok
  }
}

/** The numbered elements of an annotated screenshot, one a line (click-label N clicks one). */
function labelLines(b: Record<string, unknown>): string {
  const l = (b.labels as Array<{ label: number; ref: string; role: string; name: string }> | undefined) ?? []
  return l.map((x) => `${x.label}  [${x.ref}] ${x.role} "${x.name}"\n`).join('') + (typeof b.note === 'string' && l.length ? `${b.note}\n` : '')
}

/** What a person (or an agent in a shell) reads. */
function render(action: string | undefined, b: Record<string, unknown>): string {
  if (!action) {
    const browsers = ((b.browsers as Array<{ label: string; browser: string; caps?: string[] }> | undefined) ?? [])
      .map((x) => ({ ...x, label: x.caps?.includes('handed-tabs-only') ? `${x.label} (only the tab the person handed over)` : x.label }))
    const sites = (b.sites as Array<{ site: string }> | undefined) ?? []
    return [
      browsers.length ? `Connected: ${browsers.map((x) => x.label).join(', ')}` : noBrowserLine(b.gone as GoneBrowser | undefined),
      b.mode === 'any' ? 'Sites: any' : `Sites: a new one asks the person first; allowed: ${sites.map((s) => s.site).join(', ') || 'none yet'}`,
    ].join('\n')
  }
  if (action === 'tabs') {
    const tabs = (b.tabs as Array<{ id: number; url?: string; title?: string; active?: boolean; owner?: string }> | undefined) ?? []
    if (b.all) return tabs.map((t) => `${t.id}  [${t.owner ?? 'person'}${t.active ? ', on screen' : ''}]  ${t.title ?? ''}  ${t.url ?? ''}`).join('\n') || 'No tabs.'
    return tabs.length ? tabs.map((t) => `${t.id}  ${t.title ?? ''}  ${t.url ?? ''}`).join('\n') : 'No tab of this task (open one).'
  }
  if (action === 'find') {
    const m = (b.matches as Array<{ ref: string; role: string; name: string; text: string }> | undefined) ?? []
    return m.length ? m.map((x) => `[${x.ref}] ${x.role} "${x.name}"${x.text && x.text !== x.name ? `  ${x.text}` : ''}`).join('\n') : 'Nothing found.'
  }
  if (action === 'form_values') {
    const f = (b.fields as Array<{ ref: string; label: string; type: string; value: string; checked?: boolean; name?: string }> | undefined) ?? []
    return f.length ? f.map((x) => `[${x.ref}] ${x.type} "${x.label}"${x.name ? ` name=${x.name}` : ''}${x.checked !== undefined ? (x.checked ? ' checked' : ' unchecked') : ` = "${x.value}"`}`).join('\n') : 'No fields.'
  }
  if (action === 'downloads') {
    const d = (b.downloads as Array<{ filename: string; state: string; bytes: number; url: string }> | undefined) ?? []
    const f = b.finished as { filename?: string } | undefined
    return `${f ? `Finished: ${f.filename}\n` : ''}${d.map((x) => `${x.state}  ${x.bytes} bytes  ${x.filename || x.url}`).join('\n') || 'No downloads of this task.'}`
  }
  if (action === 'evaluate') return b.json !== undefined ? String(b.json) : JSON.stringify(b.value)
  if (action === 'network') {
    if (b.stopped !== undefined) return b.stopped ? 'Stopped recording.' : 'This tab was not recording.'
    const reqs = (b.requests as Array<{ id: string; status?: number; method: string; type?: string; ms?: number; url: string; failed?: string }> | undefined) ?? []
    const head = `${reqs.length} of ${String(b.matched ?? reqs.length)} matching, ${String(b.total ?? reqs.length)} recorded since ${String(b.since ?? '?')}${typeof b.note === 'string' ? `\n${b.note}` : ''}`
    return [head, ...reqs.map((r) => `${r.id}  ${r.failed ? `failed (${r.failed})` : r.status ?? '...'}  ${r.method}  ${r.type ?? ''}  ${r.ms !== undefined ? `${r.ms} ms` : ''}  ${r.url}`)].join('\n')
  }
  if (action === 'console') {
    const m = (b.messages as Array<{ level: string; text: string; where?: string }> | undefined) ?? []
    const head = `${m.length} of ${String(b.total ?? m.length)} since ${String(b.since ?? '?')}${typeof b.note === 'string' ? `\n${b.note}` : ''}`
    return [head, ...m.map((x) => `[${x.level}] ${x.text}${x.where ? `  (${x.where})` : ''}`)].join('\n')
  }
  // A body as it came (base64 for bytes, said once on stderr would be lost: a note line ends it).
  if (action === 'network_body' || action === 'network_request_body') {
    return `${String(b.body ?? '')}${b.cut ? `\n[cut at ${String((b.body as string | undefined)?.length ?? 0)} of ${String(b.length)} characters: --max-chars reads more]` : ''}${b.base64 ? '\n[the body is base64]' : ''}`
  }
  if (action === 'resize') {
    const v = (b.viewport ?? {}) as { width?: number; height?: number }
    return `ok  window ${String(b.width ?? '?')}x${String(b.height ?? '?')}, page ${String(v.width ?? '?')}x${String(v.height ?? '?')}`
  }
  if (action === 'dialog' && b.open !== undefined) {
    const d = b.dialog as { type?: string; message?: string; default_prompt?: string } | undefined
    return b.open && d ? `${d.type ?? 'dialog'}: ${d.message ?? ''}${d.default_prompt !== undefined ? `\n(prompt box holds: ${d.default_prompt})` : ''}` : String(b.note ?? 'No dialog open.')
  }
  if (b.dialog && typeof b.dialog === 'object') {
    const d = b.dialog as { type?: string; message?: string }
    return `ok, and it opened a ${d.type ?? 'dialog'}: ${d.message ?? ''}\n(dialog accept [--text T] or dialog dismiss answers it)`
  }
  if (action === 'snapshot') return typeof b.snapshot === 'string' ? b.snapshot : JSON.stringify(b)
  if (action === 'text') {
    // --all-frames: each frame's text under its own heading (the text is in `frames` only).
    if (Array.isArray(b.frames) && typeof b.text !== 'string') {
      return (b.frames as Array<{ frame?: string; url?: string; text?: string; left_out?: string }>)
        .map((f) => `== ${f.frame === 'top' ? 'the page' : `frame ${f.frame}`}${f.url ? ` (${f.url})` : ''} ==\n${f.left_out ? `left out: ${f.left_out}` : f.text ?? ''}`).join('\n\n')
    }
    return typeof b.text === 'string' ? b.text : ''
  }
  const where = [typeof b.tab === 'number' ? `tab ${b.tab}` : '', typeof b.url === 'string' ? b.url : '', typeof b.title === 'string' ? `"${b.title}"` : ''].filter(Boolean).join('  ')
  // Which window and tab, and the person's own tabs on the site (where-words.ts), each on a line of its own.
  if (typeof b.where === 'string') {
    const theirs = typeof b.person_tabs_note === 'string' ? `\n${b.person_tabs_note}` : ''
    const rec = b.recording === true ? '\nRecording its requests and console (network, console).' : b.record_refused ? `\nNot recording: ${(b.record_refused as { message?: string }).message ?? ''}` : ''
    return `ok  ${b.where}${theirs}${rec}${typeof b.note === 'string' ? `\n${b.note}` : ''}`
  }
  const opened = b.opened as { tab?: number; url?: string } | undefined
  const also = opened && typeof opened.tab === 'number' ? `\nOpened a new tab: ${opened.tab}  ${opened.url ?? ''} (this task's too: --tab ${opened.tab})` : ''
  return `ok${where ? `  ${where}` : ''}${also}${typeof b.note === 'string' ? `\n${b.note}` : ''}`
}
