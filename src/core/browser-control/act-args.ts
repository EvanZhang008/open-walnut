/**
 * The arguments of an agent's browser act (routes/browser-v1.ts) as they go to the extension:
 * only the keys an action reads, text cut to size, form fields and files checked. An upload
 * carries its files as base64 in the request, so it is held to UPLOAD_MAX_BYTES in all (the
 * server takes request bodies up to 15 MB).
 */
import { BrowserError } from './hub.js'

export const UPLOAD_MAX_BYTES = 10 * 1024 * 1024

const str = (v: unknown, n: number) => (typeof v === 'string' ? v.slice(0, n) : undefined)

/** What an act may carry to the browser: known keys only, each cut to size. */
export function cleanArgs(b: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const k of ['url', 'ref', 'x', 'y', 'text', 'clear', 'submit', 'value', 'key', 'direction', 'amount', 'ms', 'full', 'max',
    'exact', 'role', 'limit', 'to', 'by', 'textGone', 'all', 'trusted', 'accept', 'expression', 'wait']) {
    if (b[k] !== undefined) out[k] = b[k]
  }
  if (typeof out.text === 'string') out.text = (out.text as string).slice(0, 20_000)
  if (typeof out.textGone === 'string') out.textGone = (out.textGone as string).slice(0, 2000)
  if (typeof out.url === 'string') out.url = (out.url as string).slice(0, 4000)
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

