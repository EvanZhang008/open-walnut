/**
 * The arguments of an agent's browser act (routes/browser-v1.ts) as they go to the extension:
 * only the keys an action reads, text cut to size, form fields and files checked. An upload
 * carries its files as base64 in the request, so it is held to UPLOAD_MAX_BYTES in all (the
 * server takes request bodies up to 15 MB).
 */
import { BrowserError } from './hub.js'

export const UPLOAD_MAX_BYTES = 10 * 1024 * 1024

const str = (v: unknown, n: number) => (typeof v === 'string' ? v.slice(0, n) : undefined)

/**
 * An address the way a person types it into the address bar: `shop.example.com/cart` goes to
 * https://, `localhost:3000` to http://. A word with no dot (no host) is not an address: refused
 * with how to give one, never searched for.
 */
export function webAddress(raw: string): string {
  const u = raw.trim()
  if (/^[a-z][a-z0-9+.-]*:/i.test(u) && !/^(localhost|[\w.-]+):\d+(\/|$)/i.test(u)) return u
  const host = u.split(/[/?#]/)[0]
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host)) return `http://${u}`
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?$/.test(host)) return `https://${u}`
  throw new BrowserError(`"${u.slice(0, 80)}" is not a web address: give one such as https://example.com (a bare name with a dot, example.com, opens over https).`, 400, 'not_a_web_page')
}

/** What an act may carry to the browser: known keys only, each cut to size. */
export function cleanArgs(b: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const k of ['url', 'ref', 'x', 'y', 'text', 'clear', 'submit', 'value', 'key', 'direction', 'amount', 'ms', 'full', 'max',
    'exact', 'role', 'limit', 'to', 'by', 'textGone', 'all', 'trusted', 'accept', 'expression', 'wait', 'format',
    'selector', 'record', 'stop', 'method', 'status', 'type', 'include_static', 'request_id', 'max_chars', 'level', 'width', 'height', 'viewport',
    'to_ref', 'to_x', 'to_y', 'steps', 'label', 'annotate', 'all_frames', 'slowly', 'read']) {
    if (b[k] !== undefined) out[k] = b[k]
  }
  for (const k of ['selector', 'method', 'type', 'level']) if (out[k] !== undefined) { if (typeof out[k] === 'string') out[k] = (out[k] as string).slice(0, k === 'selector' ? 500 : 40); else delete out[k] }
  if (out.request_id !== undefined) { if (typeof out.request_id === 'string') out.request_id = out.request_id.slice(0, 100); else delete out.request_id }
  if (out.status !== undefined && typeof out.status !== 'number' && typeof out.status !== 'string') delete out.status
  if (typeof out.status === 'string') out.status = out.status.slice(0, 10)
  for (const k of ['record', 'stop', 'include_static', 'viewport', 'annotate', 'all_frames', 'slowly', 'read']) if (out[k] !== undefined && typeof out[k] !== 'boolean') delete out[k]
  if (out.to_ref !== undefined) { if (typeof out.to_ref === 'string') out.to_ref = out.to_ref.slice(0, 40); else delete out.to_ref }
  if (out.label !== undefined && !(typeof out.label === 'number' && Number.isInteger(out.label) && out.label >= 1 && out.label <= 1000)) delete out.label
  if (typeof out.steps === 'number' && Number.isFinite(out.steps)) out.steps = Math.max(2, Math.min(50, Math.round(out.steps))); else delete out.steps
  for (const k of ['max_chars', 'width', 'height', 'to_x', 'to_y']) if (out[k] !== undefined && (typeof out[k] !== 'number' || !Number.isFinite(out[k]))) delete out[k]
  if (out.format !== undefined && out.format !== 'png' && out.format !== 'jpeg') delete out.format
  if (typeof out.text === 'string') out.text = (out.text as string).slice(0, 20_000)
  if (typeof out.textGone === 'string') out.textGone = (out.textGone as string).slice(0, 2000)
  // An address to open (wait's `url` is a part of one, or a /regex/: left as given).
  if (typeof out.url === 'string') out.url = b.action === 'open' || b.action === 'navigate' ? webAddress((out.url as string).slice(0, 4000)) : (out.url as string).slice(0, 4000)
  if (typeof out.expression === 'string') out.expression = (out.expression as string).slice(0, 100_000)
  if (Array.isArray(b.fields)) {
    out.fields = (b.fields as Array<Record<string, unknown>>).slice(0, 100).map((f) => ({
      ...(str(f?.ref, 40) ? { ref: str(f.ref, 40) } : {}), ...(str(f?.label, 200) ? { label: str(f.label, 200) } : {}),
      value: typeof f?.value === 'boolean' ? f.value : String(f?.value ?? '').slice(0, 20_000),
    }))
  }
  if (Array.isArray(b.paths)) out.paths = (b.paths as unknown[]).filter((p): p is string => typeof p === 'string' && p.length > 0).slice(0, 20).map((p) => p.slice(0, 4000))
  if (Array.isArray(b.files)) {
    const files = (b.files as Array<Record<string, unknown>>).slice(0, 20)
    let total = 0
    out.files = files.map((f) => {
      const base64 = typeof f?.base64 === 'string' ? f.base64 : ''
      if (!str(f?.name, 255) || !base64 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) throw new BrowserError('Each file needs a name and its bytes as base64.', 400, 'bad_file')
      total += Math.floor(base64.length * 3 / 4)
      return { name: str(f.name, 255), type: str(f.type, 200) ?? '', base64 }
    })
    if (total > UPLOAD_MAX_BYTES) throw new BrowserError(`The files come to ${Math.round(total / 1024 / 1024)} MB; an upload takes at most ${UPLOAD_MAX_BYTES / 1024 / 1024} MB in all.`, 413, 'too_big')
  }
  return out
}

