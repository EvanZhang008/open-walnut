/**
 * A pinned copy of how `walnut browser` read and printed an answer before page framing (commit
 * 0d3cceb613, src/core/browser-control/browser-cli.ts): the CLI bundled in a session daemon that a
 * host still runs after the server moved on. page-frame.test.ts holds the server's answer to it.
 * Copied as it was; never edit to follow the current CLI.
 */
import { noBrowserLine, type GoneBrowser } from '../../../../src/core/browser-control/gone-words.js'

const BROWSER_EXIT = { ok: 0, refused: 1, timeout: 2, error: 3 } as const

const REFUSED = new Set(['window_hidden', 'input_dropped', 'site_denied', 'not_your_tab', 'test_run', 'which_tab', 'person_is_here', 'trusted_off', 'denied', 'agents_off', 'agent_never', 'which_login', 'other_site', 'agents_tab_only', 'site_open_in_person_tab', 'not_agent_opened', 'filled_here', 'request_site_not_allowed', 'recording_cancelled', 'person_window', 'person_driving', 'path_not_allowed', 'file_access_off', 'file_not_found'])

/** The old runBrowser's last steps for a page answer: the --read check, then --json or the rendered text. */
export function printBeforeFrame(action: string | undefined, body: Record<string, unknown>, json: boolean): { code: number; out: string } {
  const read = body.page_text as { error?: unknown; code?: string } | undefined
  const code = read && typeof read.error === 'string' ? exitOf(read.code) : BROWSER_EXIT.ok
  if (json) return { code, out: JSON.stringify(body, null, 2) + '\n' }
  return { code, out: render(action, body) + '\n' }
}

/** The old screenshot output's lines after the file name. */
export function labelsBeforeFrame(body: Record<string, unknown>): string {
  return labelLines(body)
}

/** The exit code of a failure's code (BROWSER_USAGE says what each means). */
function exitOf(code: string | undefined): number {
  return code && REFUSED.has(code) ? BROWSER_EXIT.refused : code === 'browser_timeout' || code === 'outward_expired' ? BROWSER_EXIT.timeout : BROWSER_EXIT.error
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
    const more = Number(b.count ?? m.length) - m.length
    const lead = typeof b.by_words === 'string' ? `Nothing has those words together; controls named with "${b.by_words}":\n` : ''
    return m.length ? lead + m.map((x) => `[${x.ref}] ${x.role} "${x.name}"${x.text && x.text !== x.name ? `  ${x.text.slice(0, 100)}` : ''}`).join('\n') + (more > 0 ? `\n… ${more} more match(es): --limit N, or --role button / --exact to narrow` : '') : 'Nothing found.'
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
    // A leave the page's "Leave site?" holds up (agent-leave.ts): still on the page.
    if (d.type === 'beforeunload') return `not yet: the page asks "${d.message ?? 'Leave site?'}" and you are still on it\n(dialog dismiss stays; dialog accept leaves and loses those changes)`
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
  if (action && ACT_WORDS[action] && typeof b.where !== 'string') return actLine(action, b) + readLines(b)
  const where = [typeof b.tab === 'number' ? `tab ${b.tab}` : '', typeof b.url === 'string' ? b.url : '', typeof b.title === 'string' ? `"${b.title}"` : ''].filter(Boolean).join('  ')
  // Which window and tab, and the person's own tabs on the site (where-words.ts), each on a line of its own.
  if (typeof b.where === 'string') {
    const theirs = typeof b.person_tabs_note === 'string' ? `\n${b.person_tabs_note}` : ''
    const rec = b.recording === true ? '\nRecording its requests and console (network, console).' : b.record_refused ? `\nNot recording: ${(b.record_refused as { message?: string }).message ?? ''}` : ''
    return `ok  ${b.where}${theirs}${rec}${typeof b.note === 'string' ? `\n${b.note}` : ''}${readLines(b)}`
  }
  const opened = b.opened as { tab?: number; url?: string } | undefined
  const also = opened && typeof opened.tab === 'number' ? `\nOpened a new tab: ${opened.tab}  ${opened.url ?? ''} (this task's too: --tab ${opened.tab})` : ''
  return `ok${where ? `  ${where}` : ''}${also}${typeof b.note === 'string' ? `\n${b.note}` : ''}`
}

/** What each acting step did, from its answer. */
const ACT_WORDS: Record<string, (b: Record<string, unknown>) => string> = {
  click: (b) => `clicked ${String(b.clicked ?? '')}`,
  hover: (b) => `hovered ${String(b.hovered ?? '')}`,
  type: (b) => `typed ${String(b.typed ?? '')}`,
  press: (b) => `pressed ${String(b.pressed ?? '')}`,
  select: (b) => `selected "${String(b.selected ?? '')}"`,
  scroll: (b) => `scrolled ${String(b.scrolled ?? '')}`,
  fill_form: (b) => `filled ${(b.filled as unknown[] | undefined)?.length ?? 0} field(s)`,
  drag: (b) => `dragged ${String(b.dragged ?? '')}`,
  upload: (b) => `uploaded ${(b.uploaded as unknown[] | undefined)?.length ?? 0} file(s) into ${String(b.into ?? 'the field')}`,
}

/**
 * One line for an acting step: what it did and what changed (agent-change.ts in the extension),
 * then why real input did not do it when it did not, and a new tab or a match it chose.
 */
function actLine(action: string, b: Record<string, unknown>): string {
  const did = ACT_WORDS[action](b).replace(/\s+$/, '')
  // A typed text that submits says what its Enter did after what was typed; a pressed Enter says it once.
  const said = typeof b.changed === 'string' ? (action === 'press' ? b.changed.replace(/^Enter:? /, '') : b.changed) : undefined
  const changed = said === undefined ? '' : action === 'type' && /^Enter\b/.test(said) ? `; ${said}` : `: ${said}`
  // An older extension says nothing of what changed: the address it is at, as before.
  const tab = typeof b.tab === 'number' ? `  [tab ${b.tab}${!changed && typeof b.url === 'string' ? ` at ${b.url}` : ''}]` : ''
  const lines = [`ok  ${did}${changed}${tab}`]
  const m = b.matched as { ref?: string; of?: number } | undefined
  if (m?.ref && (m.of ?? 1) > 1) lines.push(`(the best of ${m.of} matches, ${m.ref})`)
  if (b.trusted === false && typeof b.why === 'string') lines.push(`(trusted false: ${b.why})`)
  const opened = b.opened as { tab?: number; url?: string } | undefined
  if (opened && typeof opened.tab === 'number' && !String(b.changed ?? '').startsWith('opened')) lines.push(`Opened a new tab: ${opened.tab}  ${opened.url ?? ''} (this task's too: --tab ${opened.tab})`)
  if (b.changed === 'nothing changed on the page') lines.push('(no change in its text, fields, scroll or address: nothing to wait for; snapshot to check before acting again)')
  if (typeof b.note === 'string') lines.push(b.note)
  return lines.join('\n')
}

/** The page's text read in the same call (`--read`). */
function readLines(b: Record<string, unknown>): string {
  const t = b.page_text as { text?: string; scope?: string; error?: string; tab?: number } | undefined
  if (!t) return ''
  if (typeof t.error === 'string') return `\nThe step was done, but its page was not read: ${t.error}`
  return `\n\n${t.scope ? `== ${t.scope} ==\n` : ''}${t.text ?? ''}`
}
