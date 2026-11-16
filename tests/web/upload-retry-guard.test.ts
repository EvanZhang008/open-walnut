/**
 * Guard: every upload path goes through the shared retry (web/src/api/upload-retry.ts).
 *
 * 2026-11-15: a picture pasted while Walnut restarted showed "1 upload failed:
 * retry or remove it to send ... The connection to Walnut dropped", and a manual
 * Retry worked. The picture route tried once and gave up; the file route gave up
 * after three tries in four seconds; the note and paste routes never retried.
 *
 * Two checks, so a NEW member of the class fails here:
 *   1. every server route that takes uploaded bytes is listed below with the
 *      client path the web calls it by (a new route fails until it is added);
 *   2. every web/src file that sends to one of those paths (apiPost/apiPut, a
 *      fetch with a write method, or an XMLHttpRequest) calls withUploadRetry.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(__dirname, '../..')

/** Server upload routes (file: route literal) and the client path that reaches each. */
const UPLOAD_ROUTES: Record<string, string> = {
  "src/web/routes/images.ts: .post('/upload'": '/api/images/upload',
  "src/web/routes/notes-v2.ts: .post('/attachment'": '/api/notes-v2/attachment',
  // The phone's notes route (ios-native NotePhotoUpload); the web uses notes-v2's.
  "src/web/routes/search-memory-v1.ts: .post('/notes/attachment'": '/api/v1/notes/attachment',
  "src/web/routes/session-stream-v1.ts: .put('/sessions/:id/uploads/:uploadId'": '/uploads/',
  "src/web/routes/session-stream-v1.ts: .put('/uploads/:uploadId'": '/api/v1/uploads/',
  "src/web/server.ts: app.use('/api/pastes'": '/api/pastes',
}

/** Route literals that look like uploads but are not attachment uploads. */
const NOT_UPLOADS = new Set([
  "src/web/routes/git-http.ts: .post('/git-upload-pack'", // git's own protocol
  "src/web/server.ts: app.use('/api/images'", // mounts the images router (its /upload is listed)
  "src/web/server.ts: app.use('/api/local-image'", // reads only
])

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p, out) } else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(p)
  }
  return out
}

/**
 * Code without its comments (a route named in a doc comment is not a caller).
 * Only comments that start a line or follow a space: a '/*' inside a string
 * (a wildcard route) is code.
 */
function code(src: string): string {
  return src.replace(/(^|\s)\/\*[\s\S]*?\*\//g, '$1').replace(/(^|\s)\/\/.*$/gm, '$1')
}

const QUOTED = `['"\`]([^'"\`]*(?:upload|attachment|paste|image)[^'"\`]*)['"\`]`

describe('every upload path goes through the shared retry', () => {
  it('every server route taking uploaded bytes is known', () => {
    const found: string[] = []
    const re = new RegExp(`\\.(?:post|put|patch)\\(\\s*${QUOTED}|app\\.use\\(\\s*${QUOTED}`, 'g')
    for (const file of walk(path.join(ROOT, 'src/web'))) {
      const rel = path.relative(ROOT, file)
      const src = code(fs.readFileSync(file, 'utf8'))
      for (const m of src.matchAll(re)) {
        found.push(m[1] !== undefined ? `${rel}: .${m[0].slice(1, m[0].indexOf('('))}('${m[1]}'` : `${rel}: app.use('${m[2]}'`)
      }
    }
    const unknown = found.filter((f) => !(f in UPLOAD_ROUTES) && !NOT_UPLOADS.has(f))
    expect(unknown, 'A new upload route: send its web caller through withUploadRetry (web/src/api/upload-retry.ts) and list it in UPLOAD_ROUTES').toEqual([])
    // A listed route that is gone is taken off the list.
    expect(Object.keys(UPLOAD_ROUTES).filter((k) => !found.includes(k))).toEqual([])
  })

  it('the shared retry imports no socket client at load time', () => {
    // 2026-11-16: a static import of ./ws pulled the WS client and its imports into every
    // module that uploads (the notes API), and the notes round-trip suite could not load them.
    const src = code(fs.readFileSync(path.join(ROOT, 'web/src/api/upload-retry.ts'), 'utf8'))
    expect(src).not.toMatch(/^\s*import\b[^;]*from\s+['"]\.\/(?:ws|client)['"]/m)
    expect(src).toMatch(/import\(['"]\.\/ws['"]\)/)
  })

  it('every web file that sends to an upload route goes through withUploadRetry', () => {
    const paths = [...new Set(Object.values(UPLOAD_ROUTES))]
    const offenders: string[] = []
    let callers = 0
    for (const file of walk(path.join(ROOT, 'web/src'))) {
      const rel = path.relative(ROOT, file)
      if (rel === 'web/src/api/upload-retry.ts') continue
      const src = code(fs.readFileSync(file, 'utf8'))
      // Naming the route is not enough (an <img src> reads a vault attachment): a write to it is.
      const names = paths.some((p) => src.includes(p))
      const writes = /\bapi(?:Post|Put|Patch)\b|method:\s*['"](?:POST|PUT|PATCH)['"]|\.open\(\s*['"](?:POST|PUT|PATCH)['"]/.test(src)
      if (!(names && writes) && !/new XMLHttpRequest\b/.test(src)) continue
      callers++
      if (!/\bwithUploadRetry\(/.test(src)) offenders.push(rel)
    }
    expect(offenders, 'These upload without the shared retry: wrap the request in withUploadRetry (web/src/api/upload-retry.ts)').toEqual([])
    // The scan still sees the callers it is meant to see.
    expect(callers).toBeGreaterThanOrEqual(5)
  })
})
